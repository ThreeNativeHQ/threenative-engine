// The forest starter world, as the game that copied it draws and collides with it.
//
// `bake.mjs` wrote a world package (heightmap, splat masks, placements, CC0 models) into `world/`;
// the engine's `WorldCells` streams it, `loadTerrainSplat` textures its ground, and everything
// that decides how the world looks or what stops the player is in this folder for the game to edit.
import type { IComputeDriven, ICtx } from "@threenative/core";
import {
  Heightfield,
  type IWorldPackage,
  WorldCells,
  heightSamplerFromHeightmap,
  loadTerrainSplat,
  loadWorldHeightmap,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  type Box3,
  type BufferGeometry,
  Color,
  EquirectangularReflectionMapping,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  Object3D,
  type Texture,
  Vector3,
} from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { type IForestWater, type IForestWaterFile, addForestWater } from "./water.js";

/** Where the game's asset source holds the baked `world/` folder. */
export const FOREST_URL = "terrain/forest/world.json";

/**
 * What stops the player, per placed asset, in metres at the placement's scale 1. `null` walks
 * through. A capsule stands on the placement's origin. Change a row to change every copy.
 */
export const COLLIDERS: Readonly<
  Record<
    string,
    { capsule: readonly [halfHeight: number, radius: number] } | { sphere: number } | null
  >
> = {
  fir: { capsule: [3, 0.35] },
  "fir-c": { capsule: [3, 0.35] },
  boulder: { sphere: 0.9 },
};

/** How strongly the sky lights the props; the sun stays the dominant light on a crown. */
export const PROP_SKY_LIGHT = 0.65;
/** Multiplies every boulder's albedo: the CC0 scan photographed pink-orange, the forest's stone is cool grey. */
export const BOULDER_TINT = new Color(0.6, 0.74, 0.86);

export interface IForestWorld {
  readonly world: WorldCells;
  /** One heightfield for the whole world, in place before `addForest` resolves. */
  readonly ground: RigidBody3D;
  /** The prop colliders near `follow`; they stream with it (see `PROP_COLLIDER_REACH`). */
  readonly colliders: PropColliders;
  /** The lake and river the bake wrote, drawn beside the ground (see `water.ts`). */
  readonly water: IForestWater;
}

/** Metres around `follow` within which props collide; beyond it they only draw. */
export const PROP_COLLIDER_REACH = 60;

/**
 * Stream the forest around `follow` (usually the player or the camera) and give it collision.
 * `whileCurrent` prevents a departed scene's async load from attaching anything; its resources
 * are released on cancellation, failure and when the game's entity registry ends this scene.
 */
export async function addForest(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  url = FOREST_URL,
  whileCurrent: () => boolean = () => true,
): Promise<IForestWorld> {
  const assertCurrent = () => {
    if (whileCurrent()) return;
    const error = new Error("Forest world: its scene is no longer current.");
    error.name = "AbortError";
    throw error;
  };
  let surface: Material | undefined;
  let releaseLighting: (() => void) | undefined;
  let world: WorldCells | undefined;
  let ground: RigidBody3D | undefined;
  let colliders: PropColliders | undefined;
  let water: IForestWater | undefined;
  let released = false;
  const dispose = () => {
    if (released) return;
    released = true;
    colliders?.detach();
    colliders?.removeFromParent();
    water?.dispose();
    ground?.dispose();
    ground?.object?.removeFromParent();
    world?.dispose();
    surface?.dispose();
    releaseLighting?.();
  };
  try {
    assertCurrent();
    const manifest = (await (await fetchAsset(ctx, url, assertCurrent)).json()) as IWorldPackage;
    assertCurrent();
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    const records = await (
      await fetchAsset(ctx, base + manifest.placements, assertCurrent)
    ).arrayBuffer();
    assertCurrent();
    const [heightmapUrl] = await ctx.assets.resolve(base + manifest.terrain.heightmap);
    assertCurrent();
    if (heightmapUrl === undefined) throw new Error("Forest world: its heightmap is not served.");
    const heightmap = await loadWorldHeightmap(heightmapUrl);
    assertCurrent();
    surface = await loadTerrainSplat({ assets: ctx.assets, url });
    assertCurrent();
    releaseLighting = await lightProps(ctx, url, manifest, assertCurrent);
    assertCurrent();
    world = await WorldCells.load({
      url,
      assets: ctx.assets,
      data: { manifest, placements: records, heightmap },
      surface,
      follow,
      ring: 5,
      // Far firs draw as engine-baked impostors; the authored model stays the shadow caster.
      impostors: true,
      // The GPU-culled path drops the near firs from the main pass while their shadows still draw
      // (measured in a fresh game, 2026-10-05); the CPU path draws them. Engine finding, PRD-466.
      gpuScene: false,
      // Trees and rocks shade the ground and each other; impostors keep the authored model as the caster.
      shadows: { cast: true, receive: true },
      budgets: { residentCells: 64, instances: 40_000, bytes: 64_000_000 },
      terrain: { streamRadius: 6 },
    });
    assertCurrent();
    const field = forestField(manifest, heightmap);
    ground = groundCollider(ctx, manifest, field);
    const waterFile = (await (
      await fetchAsset(ctx, `${base}water.json`, assertCurrent)
    ).json()) as IForestWaterFile;
    assertCurrent();
    const forestWater = addForestWater(ctx, waterFile, field);
    water = forestWater;
    colliders = new PropColliders(ctx, follow, manifest, new Float32Array(records));
    ctx.add(world);
    if (ground.object !== undefined) ctx.add(ground.object);
    ctx.add(colliders);
    ctx.entities.add(`forest-world.${world.uuid}`, { dispose });
    return { world, ground, colliders, water: forestWater };
  } catch (error) {
    dispose();
    throw error;
  }
}

// Cutout foliage with no environment draws flat and dark (the engine says TN_UNLIT_FOLIAGE): give
// every prop the sky as its own envMap before WorldCells adopts the shared cached models. Foliage
// cards also get normals bent out from the crown's axis, so a crown shades as one soft volume
// instead of a stack of flat cards, and lose the glossy specular glTF exporters give them.
async function lightProps(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  url: string,
  manifest: IWorldPackage,
  assertCurrent: () => void,
): Promise<() => void> {
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const [skyUrl] = await ctx.assets.resolve(`${base}sky.hdr`);
  assertCurrent();
  if (skyUrl === undefined) throw new Error("Forest world: 'sky.hdr' is not served.");
  const sky = await new HDRLoader().loadAsync(skyUrl);
  const originals = new Map<
    MeshStandardMaterial,
    { color: Color; envMap: Texture | null; intensity: number }
  >();
  const dispose = () => {
    for (const [material, original] of originals) {
      if (material.envMap !== sky) continue;
      material.envMap = original.envMap;
      material.envMapIntensity = original.intensity;
      material.color.copy(original.color);
    }
    sky.dispose();
  };
  try {
    assertCurrent();
    sky.mapping = EquirectangularReflectionMapping;
    // Every LOD of an asset, not only its nearest: a far boulder left undressed shows its raw scan.
    const models = Object.entries(manifest.assets).flatMap(([id, asset]) =>
      [asset.glb, ...(asset.lods ?? []).map((lod) => lod.glb)].map((glb) => ({ id, glb })),
    );
    for (const { id, glb } of models) {
      const model = await ctx.assets.model<{ scene: Object3D }>(base + glb);
      assertCurrent();
      model.scene.traverse((object) => {
        const mesh = object as Mesh;
        for (const material of [mesh.material ?? []].flat() as MeshStandardMaterial[])
          if (!originals.has(material))
            originals.set(material, {
              color: material.color.clone(),
              envMap: material.envMap,
              intensity: material.envMapIntensity,
            });
        dressProp(mesh, sky, id.startsWith("boulder") ? BOULDER_TINT : undefined, originals);
      });
    }
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

/** One prop mesh: the sky as its envMap, and matte, crown-shaded foliage. */
function dressProp(
  mesh: Mesh,
  sky: Texture,
  tint: Color | undefined,
  originals: ReadonlyMap<MeshStandardMaterial, { color: Color }>,
): void {
  const surfaces = [mesh.material ?? []].flat() as MeshStandardMaterial[];
  const foliage = surfaces.some((material) => material.alphaTest > 0);
  for (const material of surfaces) {
    material.envMap = sky;
    material.envMapIntensity = foliage ? FOLIAGE_SKY_LIGHT : PROP_SKY_LIGHT;
    const original = originals.get(material);
    if (tint !== undefined && original !== undefined)
      material.color.copy(original.color).multiply(tint);
    if (material.alphaTest <= 0) continue;
    material.roughness = 0.85;
    (material as MeshStandardMaterial & { specularIntensity?: number }).specularIntensity = 0.15;
  }
  if (foliage && mesh.isMesh) bendCrownNormals(mesh.geometry, CROWN_NORMAL_BEND);
}

/** How strongly the sky lights foliage, which the sun alone leaves near-black from most sides. */
export const FOLIAGE_SKY_LIGHT = 2.2;
/** 0 keeps each card's own normal, 1 points every normal straight out from the crown's axis. */
export const CROWN_NORMAL_BEND = 0.7;

function bendCrownNormals(geometry: BufferGeometry, bend: number): void {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (position === undefined || normal === undefined) return;
  geometry.computeBoundingBox();
  const box = geometry.boundingBox as Box3;
  const midY = (box.min.y + box.max.y) / 2;
  const out = new Vector3();
  const own = new Vector3();
  for (let i = 0; i < position.count; i++) {
    out.set(position.getX(i), (position.getY(i) - midY) * 0.5, position.getZ(i)).normalize();
    own.fromBufferAttribute(normal, i).lerp(out, bend).normalize();
    normal.setXYZ(i, own.x, own.y, own.z);
  }
  normal.needsUpdate = true;
}

// The streamed terrain tiles arrive over several frames; a player spawned before its tile would fall
// through. One heightfield for the whole package (a few hundred kilobytes of samples) avoids that.
/** The kit's one heightfield: the collider stands on it and the water's shore reads it. */
function forestField(manifest: IWorldPackage, heightmap: Uint16Array): Heightfield {
  const { extent, terrain } = manifest;
  return Heightfield.fromSampler({
    columns: terrain.columns,
    rows: terrain.rows,
    width: extent.sizeX,
    depth: extent.sizeZ,
    origin: { x: extent.minX + extent.sizeX / 2, z: extent.minZ + extent.sizeZ / 2 },
    sampleHeight: heightSamplerFromHeightmap(terrain, extent, heightmap),
  });
}

function groundCollider(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  manifest: IWorldPackage,
  field: Heightfield,
): RigidBody3D {
  const { extent } = manifest;
  const anchor = new Object3D();
  anchor.position.set(extent.minX + extent.sizeX / 2, 0, extent.minZ + extent.sizeZ / 2);
  return new RigidBody3D({
    object: anchor,
    physics: ctx.physics,
    type: "fixed",
    entity: "terrain",
    shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
      x: extent.sizeX,
      y: 1,
      z: extent.sizeZ,
    }),
  });
}

/**
 * Fixed bodies for the props within `PROP_COLLIDER_REACH` of `follow`, rebuilt when it has moved a
 * few metres. Thousands of resident bodies cost Rapier ~0.5 s per 8 s (measured); a hundred do not.
 */
export class PropColliders extends Object3D implements IComputeDriven {
  readonly warmupNodes: readonly unknown[] = [];
  readonly processCadence = "render" as const;
  readonly #live = new Map<number, RigidBody3D>();
  readonly #runs: { asset: string; offset: number; count: number }[] = [];
  readonly #at = { x: Number.NaN, z: Number.NaN };
  readonly #followPosition = new Vector3();
  #released = false;

  constructor(
    private readonly ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
    private readonly follow: Object3D,
    manifest: IWorldPackage,
    private readonly records: Float32Array,
  ) {
    super();
    this.name = "forest-prop-colliders";
    for (const cell of manifest.cells)
      for (const run of cell.runs) if (COLLIDERS[run.asset]) this.#runs.push(run);
    try {
      this.#rebuild();
    } catch (error) {
      this.detach();
      throw error;
    }
  }

  /** How many prop bodies exist right now. */
  get active(): number {
    return this.#live.size;
  }

  get released(): boolean {
    return this.#released;
  }

  attachRenderer(): void {}

  process(): void {
    if (this.#released) return;
    const p = this.follow.getWorldPosition(this.#followPosition);
    if (Math.hypot(p.x - this.#at.x, p.z - this.#at.z) > 4 || Number.isNaN(this.#at.x))
      this.#rebuild();
  }

  detach(): void {
    for (const body of this.#live.values()) body.dispose();
    this.#live.clear();
    this.#released = true;
  }

  #rebuild(): void {
    const { x: fx, z: fz } = this.follow.getWorldPosition(this.#followPosition);
    this.#at.x = fx;
    this.#at.z = fz;
    const keep = new Set<number>();
    for (const run of this.#runs) {
      const shape = COLLIDERS[run.asset];
      if (!shape) continue;
      for (let i = run.offset; i < run.offset + run.count; i++) {
        const x = this.records[i * 8] as number;
        const z = this.records[i * 8 + 2] as number;
        if (Math.hypot(x - fx, z - fz) > PROP_COLLIDER_REACH) continue;
        keep.add(i);
        if (this.#live.has(i)) continue;
        const { lift, collider } = colliderAt(shape, this.records[i * 8 + 7] as number);
        this.#live.set(
          i,
          new RigidBody3D({
            physics: this.ctx.physics,
            type: "fixed",
            entity: `${run.asset}.${String(i)}`,
            position: { x, y: (this.records[i * 8 + 1] as number) + lift, z },
            shape: collider,
          }),
        );
      }
    }
    for (const [i, body] of this.#live)
      if (!keep.has(i)) {
        body.dispose();
        this.#live.delete(i);
      }
  }
}

/** One table row at one placement's scale; a capsule stands on the origin, a sphere sits on it. */
function colliderAt(
  shape: NonNullable<(typeof COLLIDERS)[string]>,
  scale: number,
): { lift: number; collider: CollisionShape3D } {
  if ("sphere" in shape)
    return { lift: 0, collider: CollisionShape3D.sphere(shape.sphere * scale) };
  const [halfHeight, radius] = shape.capsule;
  return {
    lift: (halfHeight + radius) * scale,
    collider: CollisionShape3D.capsule(halfHeight * scale, radius * scale),
  };
}

async function fetchAsset(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  path: string,
  assertCurrent: () => void,
): Promise<Response> {
  const candidates = await ctx.assets.resolve(path);
  assertCurrent();
  for (const candidate of candidates) {
    const response = await fetch(candidate);
    assertCurrent();
    if (response.ok) return response;
  }
  throw new Error(`Forest world: '${path}' is not served.`);
}
