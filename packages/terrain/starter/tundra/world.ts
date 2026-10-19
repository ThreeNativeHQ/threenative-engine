// The tundra starter world, as the game that copied it draws and collides with it.
//
// `bake.mjs` wrote a world package into `world/`: heightmap, splat masks, placements and the CC0 boulder.
// The engine's `WorldCells` streams it. `loadTerrainSplat` textures its ground.
// Everything that decides how the world looks, or what stops the player, is in this folder for the game to edit.
import type { IComputeDriven, ICtx } from "@threenative/core";
import {
  Heightfield,
  type IWorldCellsLoadOptions,
  type IWorldPackage,
  WorldCells,
  heightSamplerFromHeightmap,
  loadTerrainSplat,
  loadWorldHeightmap,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  EquirectangularReflectionMapping,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  Object3D,
  type Texture,
  Vector3,
} from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import { type ITundraWater, type ITundraWaterFile, addTundraWater } from "./water.js";

/** Where the game's asset source holds the baked `world/` folder. */
export const TUNDRA_URL = "terrain/tundra/world.json";

/**
 * What stops the player, per placed asset, in metres at the placement's scale 1. `null` walks
 * through. A sphere sits on the placement's origin. Change a row to change every copy.
 */
export const COLLIDERS: Readonly<Record<string, { sphere: number } | null>> = {
  boulder: { sphere: 0.9 },
};

/** How strongly the sky lights the props. The sun stays the dominant light on a boulder. */
export const PROP_SKY_LIGHT = 0.5;

/** Metres around `follow` within which props collide. Beyond that, props only draw. */
export const PROP_COLLIDER_REACH = 60;

export interface ITundraWorld {
  readonly world: WorldCells;
  /** One heightfield for the whole world, in place before `addTundra` resolves. */
  readonly ground: RigidBody3D;
  /** The prop colliders near `follow`. They stream with it (see `PROP_COLLIDER_REACH`). */
  readonly colliders: PropColliders;
  /** The heightfield the ground stands on: `heightAt(x, z)` reads the terrain under any point. */
  readonly field: Heightfield;
  /** Every placed prop's record, eight floats each, as the bake wrote it. */
  readonly placements: Float32Array;
  /** The world's extent in metres, as the bake wrote it. */
  readonly extent: IWorldPackage["extent"];
  /** The kettle lakes the bake wrote, as circles on the ground: the scene keeps its spawn off their shores. */
  readonly lakes: readonly ITundraLake[];
  /** How many meltwater rivers the bake wrote. They are drawn, and counted into the playtest. */
  readonly rivers: number;
  /** The lakes and rivers as they were drawn. `dispose` removes their meshes. */
  readonly water: ITundraWater;
}

/** One kettle lake as the scene reads it: where its centre is and how far its shore reaches. */
export interface ITundraLake {
  readonly at: readonly [number, number];
  readonly radius: number;
}

/**
 * Stream the tundra world around `follow` (usually the player or the camera) and give it collision.
 * `whileCurrent` stops a departed scene's async load from attaching anything. Its resources are
 * released on cancellation, failure and when the game's entity registry ends this scene.
 */
export async function addTundra(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  url = TUNDRA_URL,
  whileCurrent: () => boolean = () => true,
): Promise<ITundraWorld> {
  const assertCurrent = () => {
    if (whileCurrent()) return;
    const error = new Error("Tundra world: its scene is no longer current.");
    error.name = "AbortError";
    throw error;
  };
  let surface: Material | undefined;
  let releaseLighting: (() => void) | undefined;
  let world: WorldCells | undefined;
  let ground: RigidBody3D | undefined;
  let colliders: PropColliders | undefined;
  let water: ITundraWater | undefined;
  let released = false;
  const dispose = () => {
    if (released) return;
    released = true;
    colliders?.detach();
    colliders?.removeFromParent();
    ground?.dispose();
    ground?.object?.removeFromParent();
    water?.dispose();
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
    if (heightmapUrl === undefined) throw new Error("Tundra world: its heightmap is not served.");
    const heightmap = await loadWorldHeightmap(heightmapUrl);
    assertCurrent();
    surface = await loadTerrainSplat({ assets: ctx.assets, url });
    assertCurrent();
    releaseLighting = await lightProps(ctx, url, manifest, assertCurrent);
    assertCurrent();
    const options: IWorldCellsLoadOptions = {
      url,
      assets: ctx.assets,
      data: { manifest, placements: records, heightmap },
      surface,
      follow,
      ring: 5,
      impostors: false,
      gpuScene: false,
      shadows: { cast: true, receive: true },
      budgets: { residentCells: 64, instances: 40_000, bytes: 64_000_000 },
      terrain: { streamRadius: 6 },
    };
    world = await WorldCells.load(options);
    assertCurrent();
    const field = tundraField(manifest, heightmap);
    ground = groundCollider(ctx, manifest, field);
    const waterFile = (await (
      await fetchAsset(ctx, `${base}water.json`, assertCurrent)
    ).json()) as ITundraWaterFile;
    assertCurrent();
    const lakeWater = addTundraWater(ctx, waterFile, field);
    water = lakeWater;
    const props = new Float32Array(records);
    colliders = new PropColliders(ctx, follow, manifest, props);
    ctx.add(world);
    if (ground.object !== undefined) ctx.add(ground.object);
    ctx.add(colliders);
    ctx.entities.add(`tundra-world.${world.uuid}`, { dispose });
    return {
      world,
      ground,
      colliders,
      field,
      placements: props,
      extent: manifest.extent,
      lakes: waterFile.lakes.map((lake) => ({ at: lake.at, radius: lake.radius })),
      rivers: waterFile.rivers.length,
      water: lakeWater,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

// Every prop gets the sky as its own envMap before WorldCells adopts the shared cached models.
// Without it, a boulder lit by the sun alone draws flat.
async function lightProps(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  url: string,
  manifest: IWorldPackage,
  assertCurrent: () => void,
): Promise<() => void> {
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const [skyUrl] = await ctx.assets.resolve(`${base}sky.hdr`);
  assertCurrent();
  if (skyUrl === undefined) throw new Error("Tundra world: 'sky.hdr' is not served.");
  const sky = await new HDRLoader().loadAsync(skyUrl);
  const originals = new Map<MeshStandardMaterial, { envMap: Texture | null; intensity: number }>();
  const dispose = () => {
    for (const [material, original] of originals) {
      if (material.envMap !== sky) continue;
      material.envMap = original.envMap;
      material.envMapIntensity = original.intensity;
    }
    sky.dispose();
  };
  try {
    assertCurrent();
    sky.mapping = EquirectangularReflectionMapping;
    for (const asset of Object.values(manifest.assets)) {
      const model = await ctx.assets.model<{ scene: Object3D }>(base + asset.glb);
      assertCurrent();
      model.scene.traverse((object) => {
        const mesh = object as Mesh;
        for (const material of [mesh.material ?? []].flat() as MeshStandardMaterial[])
          if (!originals.has(material))
            originals.set(material, {
              envMap: material.envMap,
              intensity: material.envMapIntensity,
            });
        dressProp(mesh, sky);
      });
    }
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

/** One prop mesh: the sky as its envMap. */
function dressProp(mesh: Mesh, sky: Texture): void {
  for (const material of [mesh.material ?? []].flat() as MeshStandardMaterial[]) {
    material.envMap = sky;
    material.envMapIntensity = PROP_SKY_LIGHT;
  }
}

// The streamed terrain tiles arrive over several frames. A player spawned before its tile would
// fall through. One heightfield for the whole package avoids that, at a few hundred kilobytes.
/** The kit's one heightfield: the collider stands on it. */
function tundraField(manifest: IWorldPackage, heightmap: Uint16Array): Heightfield {
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
 * Fixed bodies for the props within `PROP_COLLIDER_REACH` of `follow`, rebuilt when it has moved a few
 * metres. Thousands of resident bodies cost Rapier about 0.5 s per 8 s (measured). A hundred do not.
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
    this.name = "tundra-prop-colliders";
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
        const collider = CollisionShape3D.sphere(
          shape.sphere * (this.records[i * 8 + 7] as number),
        );
        this.#live.set(
          i,
          new RigidBody3D({
            physics: this.ctx.physics,
            type: "fixed",
            entity: `${run.asset}.${String(i)}`,
            position: { x, y: this.records[i * 8 + 1] as number, z },
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

async function fetchAsset(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  url: string,
  assertCurrent: () => void,
): Promise<Response> {
  const [resolved] = await ctx.assets.resolve(url);
  assertCurrent();
  if (resolved === undefined) throw new Error(`Tundra world: '${url}' is not served.`);
  const response = await fetch(resolved);
  assertCurrent();
  if (!response.ok) throw new Error(`Tundra world: '${url}' answered ${String(response.status)}.`);
  return response;
}
