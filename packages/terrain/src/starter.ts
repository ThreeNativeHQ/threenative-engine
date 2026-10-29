import type { IComputeDriven, ICtx } from "@threenative/core";
import {
  Heightfield,
  type IWorldCellsLoadOptions,
  type IWorldPackage,
  TerrainTiles,
  WorldCells,
  heightSamplerFromHeightmap,
  loadWorldHeightmap,
} from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import {
  type Color,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  Object3D,
  type Texture,
  Vector3,
} from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";

import {
  type IRemovedPlacement,
  type IWorldPlacementEdits,
  editWorldPlacements,
  validatePlacementIds,
} from "./core/placement-edits.js";

export { editWorldPlacements } from "./core/placement-edits.js";
export type { IRemovedPlacement, IWorldPlacementEdits } from "./core/placement-edits.js";

export type StarterContext = ICtx<Record<string, unknown>, IPhysicsContext>;
export type StarterColliders = Readonly<
  Record<string, { sphere: number } | { capsule: readonly [number, number] } | null>
>;
export interface IStarterWorld {
  readonly world: WorldCells;
  readonly ground: RigidBody3D;
  readonly colliders: PropColliders;
  readonly field: Heightfield;
  readonly placements: Float32Array;
  readonly manifest: IWorldPackage;
  readonly placementIds?: readonly string[];
  readonly editReport: {
    readonly unmatched: readonly string[];
    readonly removed: readonly IRemovedPlacement[];
  };
  readonly extent: IWorldPackage["extent"];
}
export interface IStarterWorldSpec<Extra extends { dispose(): void }> {
  readonly name: string;
  readonly url: string;
  readonly colliders: StarterColliders;
  readonly colliderReach: number;
  /**
   * Apply startup placement edits before streaming, lighting and collision consume the data.
   * @situation move, remove or add generated props from game source without rebaking
   * @example edits: { remove: ["scree:candidate:7:41"] }
   * @override grounding defaults on; `grounding: false` keeps the authored Y coordinate
   */
  readonly edits?: IWorldPlacementEdits;
  /** Terrain query layer; omitted keeps the physics body's default layer. */
  readonly groundCollisionLayer?: number;
  readonly loadSurface: (ctx: StarterContext, url: string) => Promise<Material>;
  readonly lighting: {
    readonly sky: string;
    readonly lods: boolean;
    readonly dress: (
      mesh: Mesh,
      sky: Texture,
      id: string,
      originals: ReadonlyMap<MeshStandardMaterial, { color: Color }>,
    ) => void;
  };
  readonly streaming: Pick<
    IWorldCellsLoadOptions,
    "ring" | "impostors" | "gpuScene" | "shadows" | "budgets" | "terrain"
  >;
  readonly water?: (
    ctx: StarterContext,
    file: unknown,
    field: Heightfield,
    manifest: IWorldPackage,
    heightmap: Uint16Array,
  ) => Extra;
}

/** Load caller-authored starter data with one scene lifetime; all appearance comes from spec.
 * @situation attach a baked starter world with game-owned surfaces, prop dressing and water
 * @constraint Runtime subpath; the game supplies every appearance and collision choice
 * @requires npm i -D @threenative/terrain
 * @example await addStarterWorld(ctx, follow, spec);
 */
export async function addStarterWorld<Extra extends { dispose(): void } = { dispose(): void }>(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  spec: IStarterWorldSpec<Extra>,
  url = spec.url,
  whileCurrent: () => boolean = () => true,
): Promise<IStarterWorld & { extra: Extra | undefined }> {
  const assertCurrent = () => {
    if (whileCurrent()) return;
    const error = new Error(`${spec.name} world: its scene is no longer current.`);
    error.name = "AbortError";
    throw error;
  };
  let surface: Material | undefined;
  let releaseLighting: (() => void) | undefined;
  let world: WorldCells | undefined;
  let ground: RigidBody3D | undefined;
  let colliders: PropColliders | undefined;
  let extra: Extra | undefined;
  let released = false;
  const dispose = () => {
    if (released) return;
    released = true;
    colliders?.detach();
    colliders?.removeFromParent();
    ground?.dispose();
    ground?.object?.removeFromParent();
    extra?.dispose();
    world?.dispose();
    surface?.dispose();
    releaseLighting?.();
  };
  try {
    assertCurrent();
    let manifest = (await (
      await fetchAsset(ctx, url, assertCurrent, spec.name)
    ).json()) as IWorldPackage;
    assertCurrent();
    const base = url.slice(0, url.lastIndexOf("/") + 1);
    let records = await (
      await fetchAsset(ctx, base + manifest.placements, assertCurrent, spec.name)
    ).arrayBuffer();
    assertCurrent();
    let placementIds: readonly string[] | undefined;
    if (manifest.placementIds !== undefined) {
      const ids: unknown = await (
        await fetchAsset(ctx, base + manifest.placementIds, assertCurrent, spec.name)
      ).json();
      assertCurrent();
      placementIds = validatePlacementIds(ids, records.byteLength / 32);
    }
    const [heightmapUrl] = await ctx.assets.resolve(base + manifest.terrain.heightmap);
    assertCurrent();
    if (heightmapUrl === undefined)
      throw new Error(`${spec.name} world: its heightmap is not served.`);
    const heightmap = await loadWorldHeightmap(heightmapUrl);
    assertCurrent();
    const field = starterField(manifest, heightmap);
    let editReport: IStarterWorld["editReport"] = { unmatched: [], removed: [] };
    if (spec.edits !== undefined) {
      const edited = editWorldPlacements(
        { manifest, placements: records, ids: placementIds },
        spec.edits,
        (x, z) => field.heightAt(x, z),
      );
      manifest = edited.manifest;
      records = edited.placements;
      placementIds = edited.ids;
      editReport = { unmatched: edited.unmatched, removed: edited.removed };
    }
    surface = await spec.loadSurface(ctx, url);
    assertCurrent();
    releaseLighting = await lightProps(ctx, url, manifest, assertCurrent, spec);
    assertCurrent();
    const options: IWorldCellsLoadOptions = {
      url,
      assets: ctx.assets,
      data: { manifest, placements: records, heightmap },
      surface,
      follow,
      ...spec.streaming,
    };
    world = await WorldCells.load(options);
    assertCurrent();
    const tiles = world.children.find((child) => child instanceof TerrainTiles);
    ground = groundCollider(
      ctx,
      manifest,
      field,
      heightSamplerFromHeightmap(manifest.terrain, manifest.extent, heightmap),
      tiles,
      follow,
      spec.streaming.terrain === false
        ? spec.streaming.ring
        : (spec.streaming.terrain?.colliderRadius ?? spec.streaming.ring),
      spec.groundCollisionLayer,
    );
    if (spec.water) {
      const file = await (
        await fetchAsset(ctx, `${base}water.json`, assertCurrent, spec.name)
      ).json();
      assertCurrent();
      extra = spec.water(ctx, file, field, manifest, heightmap);
      assertCurrent();
    }
    const props = new Float32Array(records);
    colliders = new PropColliders(
      ctx,
      follow,
      manifest,
      props,
      spec.colliders,
      spec.colliderReach,
      spec.name,
    );
    ctx.add(world);
    if (ground.object !== undefined) ctx.add(ground.object);
    ctx.add(colliders);
    ctx.entities.add(`${spec.name.toLowerCase()}-world.${world.uuid}`, { dispose });
    return {
      world,
      ground,
      colliders,
      field,
      placements: props,
      placementIds,
      manifest,
      editReport,
      extent: manifest.extent,
      extra,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

async function lightProps(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  url: string,
  manifest: IWorldPackage,
  assertCurrent: () => void,
  spec: IStarterWorldSpec<{ dispose(): void }>,
): Promise<() => void> {
  const base = url.slice(0, url.lastIndexOf("/") + 1);
  const [skyUrl] = await ctx.assets.resolve(`${base}${spec.lighting.sky}`);
  assertCurrent();
  if (skyUrl === undefined)
    throw new Error(`${spec.name} world: '${spec.lighting.sky}' is not served.`);
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
    // Every LOD of an asset, not only its nearest: a far boulder left undressed shows its raw scan.
    const models = Object.entries(manifest.assets).flatMap(([id, asset]) =>
      [asset.glb, ...(spec.lighting.lods ? (asset.lods ?? []).map((lod) => lod.glb) : [])].map(
        (glb) => ({ id, glb }),
      ),
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
        spec.lighting.dress(mesh, sky, id, originals);
      });
    }
    return dispose;
  } catch (error) {
    dispose();
    throw error;
  }
}

function starterField(manifest: IWorldPackage, heightmap: Uint16Array): Heightfield {
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
  ctx: StarterContext,
  manifest: IWorldPackage,
  field: Heightfield,
  sampleHeight: (x: number, z: number) => number,
  tiles: TerrainTiles | undefined,
  follow: Object3D,
  radius: number,
  collisionLayer?: number,
): RigidBody3D {
  const { extent } = manifest;
  const anchor = new Object3D();
  const position = new Vector3();
  let tileX = Number.NaN;
  let tileZ = Number.NaN;
  const window = () => {
    if (!tiles) return field;
    follow.getWorldPosition(position);
    tileX = Math.floor((position.x + tiles.tileSize / 2) / tiles.tileSize);
    tileZ = Math.floor((position.z + tiles.tileSize / 2) / tiles.tileSize);
    const spacing = tiles.tileSize / (tiles.tileResolution - 1);
    // Tile vertices start half a tile before its centre, independent of world origin.
    const axis = (center: number, min: number, size: number) => {
      const cells = tiles.tileResolution - 1;
      const first = Math.floor((min + tiles.tileSize / 2) / spacing);
      // Cover boundary strips on the render lattice, including sub-cell worlds.
      const last = Math.max(first + 1, Math.ceil((min + size + tiles.tileSize / 2) / spacing));
      // Out-of-world teleports retain the nearest edge window.
      const tile = Math.max(
        Math.floor(first / cells),
        Math.min(center, Math.ceil(last / cells) - 1),
      );
      return [
        Math.max(first, (tile - radius) * cells),
        Math.min(last, (tile + radius + 1) * cells),
      ] as const;
    };
    const [x0, x1] = axis(tileX, extent.minX, extent.sizeX);
    const [z0, z1] = axis(tileZ, extent.minZ, extent.sizeZ);
    return Heightfield.fromSampler({
      columns: x1 - x0 + 1,
      rows: z1 - z0 + 1,
      width: (x1 - x0) * spacing,
      depth: (z1 - z0) * spacing,
      origin: {
        x: ((x0 + x1) * spacing) / 2 - tiles.tileSize / 2,
        z: ((z0 + z1) * spacing) / 2 - tiles.tileSize / 2,
      },
      sampleHeight,
    });
  };
  const shape = (part: Heightfield) => {
    anchor.position.set(part.origin.x, 0, part.origin.z);
    return CollisionShape3D.heightfield(part.rows, part.columns, part.toColliderHeights(), {
      x: part.width,
      y: 1,
      z: part.depth,
    });
  };
  const simulation = ctx.physics.simulation;
  const replaceShape = simulation.setColliderShape?.bind(simulation);
  if (tiles && !replaceShape)
    throw new Error("Starter terrain requires in-place heightfield replacement.");
  const body = new RigidBody3D({
    object: anchor,
    physics: ctx.physics,
    type: "fixed",
    entity: "terrain",
    ...(collisionLayer === undefined ? {} : { collisionLayer }),
    shape: shape(window()),
  });
  if (tiles) {
    const dispose = body.dispose.bind(body);
    let released = false;
    let cancel: (() => void) | undefined;
    body.dispose = () => {
      if (released) return;
      released = true;
      cancel?.();
      dispose();
    };
    try {
      // Scheduler work runs before scene movement and the physics plugin's fixed step.
      cancel = ctx.every(() => {
        if (released) return;
        follow.getWorldPosition(position);
        if (
          tileX === Math.floor((position.x + tiles.tileSize / 2) / tiles.tileSize) &&
          tileZ === Math.floor((position.z + tiles.tileSize / 2) / tiles.tileSize)
        )
          return;
        const next = shape(window());
        Object.assign(body.shape.descriptor, next.descriptor, {
          collisionLayer: body.shape.descriptor.collisionLayer,
          collisionMask: body.shape.descriptor.collisionMask,
        });
        replaceShape?.(body.collider, body.shape.descriptor);
        body.shape.bindRaw(next.raw);
        simulation.setBodyTransform(body.body.id, anchor.position);
      });
    } catch (error) {
      body.dispose();
      throw error;
    }
  }
  return body;
}

/** Stream caller-specified fixed collision shapes around a moving follow object.
 * @situation attach nearby prop collision bodies from baked placement records
 * @constraint Shapes and reach are supplied by the game; detach releases every body
 * @requires npm i -D @threenative/terrain
 * @example new PropColliders(ctx, follow, manifest, records, shapes, reach, name);
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
    private readonly shapes: StarterColliders,
    private readonly reach: number,
    name: string,
  ) {
    super();
    this.name = `${name.toLowerCase()}-prop-colliders`;
    for (const cell of manifest.cells)
      for (const run of cell.runs) if (this.shapes[run.asset]) this.#runs.push(run);
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
      const shape = this.shapes[run.asset];
      if (!shape) continue;
      for (let i = run.offset; i < run.offset + run.count; i++) {
        const x = this.records[i * 8] as number;
        const z = this.records[i * 8 + 2] as number;
        if (Math.hypot(x - fx, z - fz) > this.reach) continue;
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
  shape: NonNullable<StarterColliders[string]>,
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
  name: string,
): Promise<Response> {
  const candidates = await ctx.assets.resolve(path);
  assertCurrent();
  for (const candidate of candidates) {
    const response = await fetch(candidate);
    assertCurrent();
    if (response.ok) return response;
  }
  throw new Error(`${name} world: '${path}' is not served.`);
}
