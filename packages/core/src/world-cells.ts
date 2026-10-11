import { displacesVertices } from "./projection-plan.js";
import type {
  IAssetPart,
  IBatchShape,
  IBuildJob,
  ICamera,
  ICellBatch,
  IKeyDescriptor,
  IResidentCell,
  IShadowRegion,
  ISpawnWaiter,
  IWorldCellsBudget,
  IWorldCellsFollow,
  IWorldCellsGpuTally,
  IWorldCellsLoadOptions,
  IWorldCellsStats,
  IWorldRegionReadiness,
} from "./world-cell-data.js";
import {
  CellImpostors,
  DEFAULT_CUTOUT_ALPHA,
  type IImpostorState,
  PLACEMENT_RECORD_BYTES,
  PLACEMENT_RECORD_FLOATS,
  cullDistance,
  isAlphaFoliage,
} from "./world-cell-impostors.js";
import { cellProxySourceSafe } from "./world-cell-proxy.js";

import {
  admissionBudgetMs,
  cellKey,
  clusterOf,
  crossesGate,
  nonNegativeInteger,
  positiveInteger,
  positiveMetres,
} from "./world-cell-data.js";

export type {
  IWorldCellsFollow,
  IWorldCellsBudget,
  IWorldCellsTerrainOptions,
  IWorldCellsLoadOptions,
  IWorldCellsGpuTally,
  IWorldRegionReadiness,
  IShadowRegion,
  IWorldCellsStats,
} from "./world-cell-data.js";

import {
  Box3,
  BufferGeometry,
  type Camera,
  Frustum,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from "three";
import { BundleGroup } from "three/webgpu";
import { type IAssetLoader, createAssetLoader } from "./assets.js";
import type { IComputeDriven } from "./compute-driven.js";
import { INSTANCED_LOD_MAX_PIXEL_ERROR } from "./instanced-batch-lod.js";
import { InstancedBatch } from "./instanced-batch.js";
import {
  type ILodChain,
  biasedLodDistance,
  conservativeViewDepth,
  lodChainOf,
  setLodBias,
  worldSphere,
} from "./model-lod.js";
import { type OcclusionMode, occlusionMode } from "./render/depth-pyramid.js";
import { cutoutSurface } from "./render/foliage-alpha.js";
import { materialKey } from "./render/material-key.js";
import { advanceWriteEpoch, drainMeshPool, dropPooledFor, parkMesh } from "./render/mesh-pool.js";
import type { IRendererLike } from "./renderer.js";
import { isStatic, markStatic } from "./static-transform.js";
import { addInSlices, loadAll } from "./streaming.js";
import { DEFAULT_TARGET_FPS } from "./target-fps.js";
import { within, yieldToHost } from "./warmup.js";
import { BundleSurfaceSafety, bundleSafe, ownHook } from "./world-bundle-safety.js";
import { type ICasterScaleMesh, SharedBatch, sameSquares } from "./world-cell-batches.js";
import {
  CHUNK_MERGE_MAX_TRIANGLES,
  CellChunks,
  cellLoaded,
  levelTriangles,
  release,
  resolveRelative,
  warmClock,
} from "./world-cell-chunks.js";
import { CellPrewarm, WIDE_CLUSTER } from "./world-cell-prewarm.js";
import {
  CHUNK_NAME,
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  worldOwned,
} from "./world-chunk-shadow.js";
import {
  DRAW_ARGS_BYTES,
  type IAssetSlot,
  type ILiveAsset,
  type IMeshDraw,
  type IShadowLevel,
  type IWorldGpuSceneReport,
  WorldGpuScene,
  bundlesAsked,
  gpuSceneRequested,
  gpuSceneValidationRequested,
  levelAtGates,
  liveKeyInstances,
  shadowGpuKeysRequested,
} from "./world-gpu-scene.js";
import { heightSamplerFromHeightmap, loadWorldHeightmap } from "./world-heightmap.js";
import { AdmissionBudget, ModelLoadLimiter } from "./world-load-limiter.js";
import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldPackage,
  type IWorldRun,
  cellPlacements,
  validateWorldPackage,
} from "./world-package.js";
import {
  type IAdmissionBudget,
  type IWorldTilesOptions,
  TerrainTileBudgetError,
  TerrainTiles,
} from "./world-tiles.js";

export { bundleSafeMaterial } from "./world-bundle-safety.js";

const DEFAULT_TILE_RESOLUTION = 129;
/** Milliseconds one `update` may spend admitting streamed content, unless the game says otherwise. */
const DEFAULT_ADMISSION_BUDGET_MS = 2;
/**
 * How much more one `update` may admit while the startup cover hides the world: 8x takes the 2 ms
 * default to one 60 Hz frame. Nobody sees frame pacing behind an opaque loading screen, and at 2 ms
 * a 10-17 fps test lane spent 16 s (web) and about 47 s (native) admitting a spawn backlog of about
 * 1,200 builds. The loader still presents every frame. Scaling keeps a game's own split between
 * several worlds; `coveredAdmissionBudgetMs` and `coveredFreshMeshesPerUpdate` name the covered
 * values outright.
 */
const COVERED_BUDGET_SCALE = 8;
/**
 * How far the follow point has to move before a residency pass is worth repeating. Below it the
 * ring, the refilter brackets and every tile's LOD level are the same numbers, so the pass would
 * re-derive the set it already holds. Half a metre is under one 2 m heightmap cell and far under a
 * 128 m cell, so nothing that could change an answer is skipped.
 */
const SETTLED_FOLLOW_METRES = 0.5;
/**
 * How far the follow point has to move before the `maxDistance`/`lods` refilter pass runs again.
 * That pass walks every resident cell's batches, derives both distance brackets and sorts what it
 * found, and on a 2 km walk at 0.3 m a frame it ran every second frame for the same brackets — a
 * third of the world's `update`. Two metres is the same order as the per-asset hysteresis the pass
 * already applies (`threshold / 8`, 3.75 m for a 30 m gate), so a level switch or a cull lands
 * within about two metres of the distance that asked for it, on a level the player is still walking
 * toward. Raise it when a game's gates are far apart, lower it when placements sit inside one.
 */
const LEVEL_REFILTER_STEP_METRES = 2;
/**
 * Instance-matrix bytes a world keeps in released shared batches, oldest dropped first. A batch is
 * sized to its asset's largest cell times the resident cells, so on a 2 km package one runs 80 kB
 * median and 0.9 MB worst, and every key in the world at once is 26 MB. The budget holds the walk's
 * own back-traffic — a batch leaves when the last cell holding its asset leaves, and is wanted
 * again a few hundred metres back — and lets the rest go, so a session that crosses the whole map
 * does not carry the whole map.
 */
const RETIRED_SHARED_BYTES = 8_000_000;
/**
 * The projection a baked chain's levels are switched at when the world names none: 60° of vertical
 * field of view over 1080 raster rows, which is the desktop view a switch distance is a function of.
 * See `autoLod`.
 */
const DEFAULT_AUTO_LOD_FOV_Y = 60;
const DEFAULT_AUTO_LOD_VIEWPORT_HEIGHT = 1080;
/**
 * The screen-space error budget a baked chain's levels are switched at, in pixels, when the world
 * names none. See `IWorldCellsLoadOptions.autoLod`.
 */
const DEFAULT_AUTO_LOD_MAX_PIXEL_ERROR = INSTANCED_LOD_MAX_PIXEL_ERROR;
/**
 * How far past the frustum a world-grid square is kept inside the main pass's draw window, in metres.
 *
 * The window is decided once per draw, from the camera that draw uses, and a square that has just
 * left the frustum is dropped from it — so a square at the frustum's edge would be drawn in one
 * frame and not the next, and a tree on that edge pops in at the edge of the screen. Growing each
 * square's box by this margin keeps a band of it in the window while it is still off screen, so a
 * tree crosses into view already there.
 *
 * An eighth of the default 64 m square is deliberately small. It has to exceed what a camera
 * travels between two draws — 8 m a frame is 480 m/s at 60 fps, so no playable camera reaches it —
 * and nothing more, because every metre of it is a metre of geometry the vertex stage still shades.
 */
const MAIN_CULL_PAD_METRES = 8;
/**
 * Side of the main cull's own visibility cell, in metres, when it divides the package's `cellSize`.
 *
 * This is the finest grid the main pass can cull on, and it is not a free parameter: a shared
 * batch's block is one *world* cell's records and placements never move, so a world cell cannot be
 * spread across two cells of a finer grid without giving every world cell its own block — one more
 * main mesh per key, which is the cost this whole cull exists to avoid. So a package whose
 * `cellSize` is not a whole multiple of 32 m falls back to its own `cellSize`, which is the square
 * its placements are already cut on, and the rule below is the whole of it.
 *
 * A visibility cell is a sub-square of the shadow caster's world-grid square, and it is deliberately
 * finer than that square: `clusterSize` is sized for how many meshes a shadow level submits, while
 * this is sized for how little geometry the vertex stage is handed. It is also the one volume the
 * cull tests, so everything in it — a 64 m cell's XZ and the Y its own placements and asset bounds
 * reach — is what a draw of that cell costs. See {@link WorldCells.#cullMainPass}.
 */
const MAIN_CULL_SQUARE_METRES = 32;
/**
 * How often `TN_WORLD_MAIN_CULL` is printed. Five seconds is a line a playtest capture can hold and
 * a walk long enough to see the window move; every frame is a wall of text over the marker it would
 * report on.
 */
const MAIN_CULL_MARKER_MS = 5e3;
/**
 * Assets reported one by one before the `TN_WORLD_LOD_CHAIN` marker collapses into a single line.
 * A 2 km package carries hundreds of chained assets, and a console line each is a wall of text that
 * buries the one that matters.
 */
const CHAIN_LOD_MARKER_LIMIT = 20;
/**
 * The wide casters only the finest level renders: a fern's or a grass tuft's, whose shadow is
 * sub-texel noise past a few metres and whose per-key draw a 192 m or 640 m window was paying
 * hundreds of times for nothing. Duplicated from `virtual-shadow.ts` like the two layers above, and
 * chosen from the asset's own authored bounds rather than from what a game says, so a package
 * nobody has annotated still gets the cull. `shadows.smallCasterMetres` is the override.
 */
const VIRTUAL_SHADOW_SMALL_CASTER_LAYER = 26;
/**
 * The layer a GPU-driven shadow map draws: one mesh per `asset:level:part`, over the shadow twin of
 * the dispatch's own output, so a level submits a handful of indirect draws rather than one per
 * world-grid square. Every level camera carries this bit, so it replaces both halves above rather
 * than joining the choice between them. Duplicated from `virtual-shadow.ts` like the three above.
 */
const VIRTUAL_SHADOW_KEY_LAYER = 25;
/**
 * The name half a shadow key is minted under: `asset:level:part@gpu`, beside the main key it twins
 * rather than in place of it, so both meshes exist — one for the main pass's compaction buffer and
 * one for the shadow twin's, which is the whole difference between them.
 */
const GPU_KEY_SUFFIX = "@gpu";
/** An asset shorter than this casts into the finest level only; see the layer above. */
const SMALL_CASTER_METRES = 1.5;
/**
 * Placements filtered per unit of admission work.
 *
 * One unit is what a frame can overshoot its budget by, so it is sized to stay small rather than to
 * divide the work evenly: a slice is a few hundred placements' worth of matrix maths, tens of
 * microseconds, whatever the cell holds. ponytail: a count, not a time — the budget is the clock,
 * and this only decides how often it is read.
 */
const ADMISSION_SLICE_PLACEMENTS = 256;

/** The two scratch objects a cull builds its frustum in, and whether two square sets are the same. */
const _cullFrustum = new Frustum();
const _cullProjScreen = new Matrix4();
/** The eye the live-state reference measures every placement's XZ distance from. */
const _gpuEye = new Vector3();

/** A surface every part with the same material content draws with, and who still uses it. */
interface ISharedSurface {
  readonly material: Material;
  /** The canonical source and any cutout made from it, torn down with the last user. */
  readonly owned: readonly Material[];
  users: number;
}

/** Parts already handed back, so a level that fell back to the one above releases it once. */
const releasedParts = new WeakSet<IAssetPart>();

export interface IAssetState {
  readonly id: string;
  readonly definition: IWorldAsset;
  /**
   * The distance at which each level takes over, index-aligned with `glbs`; level 0 never does.
   *
   * Mutable because a chain is only known once the asset's own model has loaded: an asset with no
   * authored `lods` is widened with the levels that model's baked chain carries, and every consumer
   * of this reads it at build time — after `#adoptAsset` — so nothing has to be rebuilt.
   */
  distances: readonly number[];
  /** The package-relative GLB per level, index-aligned with `distances`. */
  readonly glbs: readonly string[];
  /** Every distance the level or cull answer changes at, `threshold` being the nearest. */
  gates: readonly number[];
  /** The nearest distance this asset's batching can be crossed at, or `undefined` when it cannot. */
  threshold: number | undefined;
  refcount: number;
  hlodSafe: boolean;
  pending: boolean;
  failed: boolean;
  disposed: boolean;
  /**
   * The exact `assets.model` cache paths this state asked the loader for, held in `#modelPaths`
   * until the last state naming each one is released. Empty when `loadModel` bypasses the cache;
   * filled once per state, so a load retried after an empty answer does not count twice.
   */
  retainedPaths: string[];
  /**
   * One part list per entry in `glbs`, so a level that failed to load reuses the level below it and
   * the batch builder never has to know a level is missing.
   */
  levels: readonly (readonly IAssetPart[])[];
  /**
   * Parts taken out of DRAW but still owned here until teardown. Authored levels now keep their own
   * geometry, so this stays empty; it is drained once with the asset on release.
   */
  spilled: readonly IAssetPart[];
  /**
   * The loader's resolved cooked url for LOD0, recorded at load. It is the atlas cache key's model
   * half, so two package entries that fetch the same cooked bytes share one bake even when their
   * `lods`/`maxDistance` metadata stopped them aliasing. See `#impostorKey`.
   */
  resolvedGlb: string;
  /** The whole-asset impostor level this asset appended, once its bake landed. See `#finishImpostor`. */
  impostor?: IImpostorState;
}

interface IWorldCellsInit extends IWorldCellsLoadOptions {
  readonly reachRanges: Map<
    IWorldCell,
    Map<string, { min: number; max: number; minY: number; maxY: number }>
  >;
  readonly manifest: IWorldPackage;
  readonly placements: ArrayBuffer;
  readonly heightmap: Uint16Array;
  readonly baseUrl: string;
  /** `baseUrl` as the loader keys it: no leading slash, which is what a manifest lists. */
  readonly logicalBase: string;
  /**
   * Asset ids the package named twice for one model, each pointing at the id that is kept. Built
   * once in `load`, where the loader can be asked what each path really fetches; empty when nothing
   * is a duplicate. See {@link assetAliases}.
   */
  readonly aliases: ReadonlyMap<string, string>;
  /**
   * Whether `load` fabricated the loader it hands in as `assets` instead of the game supplying one.
   * `load` always passes a loader to the constructor, so `assets === undefined` cannot tell an owned
   * loader from a caller's; this is the bit that can. Left out, ownership is `assets === undefined`.
   */
  readonly ownsAssets?: boolean;
}

async function loadModelWith(assets: IAssetLoader, path: string): Promise<Object3D> {
  const gltf = await assets.model<{ scene?: Object3D }>(path);
  const scene = gltf?.scene;
  if (!(scene instanceof Object3D))
    throw new Error(`World asset '${path}' loaded without an Object3D scene.`);
  return scene;
}

/**
 * Load a package file from the first candidate the loader says might serve it, the way the
 * loader's own `loadFirst` walks them: the authored name, then the project's `assets/` source. One
 * candidate is what a manifest gives, and a delete-test project has no manifest, so taking only
 * the first is a 404 for a package that is present on disk. When none answer, one error names every
 * url tried and its status — the failure is two places looked at, not one missing file.
 */
async function loadLogical<T>(
  assets: IAssetLoader,
  path: string,
  load: (url: string) => Promise<T>,
): Promise<T> {
  const candidates = await assets.resolve(path);
  const failures: string[] = [];
  for (const url of candidates) {
    try {
      return await load(url);
    } catch (error) {
      failures.push(`${url} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  throw new Error(
    `World file '${path}' could not be loaded from ${String(candidates.length)} candidate url(s): ${failures.join("; ")}`,
  );
}

/** A `fetch` that refuses anything but an ok response, so candidates are walked on status. */
async function fetchOk(url: string): Promise<Response> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`status ${String(response.status)}`);
  return response;
}

/**
 * Mip compensation for scattered foliage. Golus's 0.25 suits dense cards; a needle atlas at ~9 %
 * coverage averages to ~0.09 alpha by mip 8, where a tree 150 m out samples, so 0.25 still drops
 * every needle. 0.75 keeps the cutoff under that average through mip 8.
 * ponytail: one tuned constant; coverage-preserving mips at cook time are the upgrade path.
 */
const SCATTER_MIP_ALPHA_SCALE = 0.75;

/**
 * The surface a scattered part draws with, and the cutout this class owns when it made one.
 *
 * An `InstancedMesh` cannot sort its instances, so a `transparent` material on scattered foliage
 * draws in submission order — wrong against itself, and overdraw on top of it. A cutout keeps the
 * part's own alpha shape, keeps the depth buffer, and lets the draw reject what is behind it. The
 * GLB's material is never mutated: the cutout is per asset part, so every cell batch of the asset
 * shares one and a game that still wants blending asks for it.
 *
 * The cutout itself is `cutoutSurface`, because a cutout that ignores the mip chain deletes itself
 * at distance: the needle card's mips average to a tenth, and every needle is discarded.
 */
function scatterMaterial(
  material: Material,
  transparentScatter: "cutout" | "blend",
): { readonly material: Material; readonly owned: readonly Material[] } {
  if (transparentScatter === "blend" || !material.transparent)
    return { material, owned: [material] };
  const cutout = cutoutSurface(
    material,
    material.alphaTest > 0 ? material.alphaTest : DEFAULT_CUTOUT_ALPHA,
    SCATTER_MIP_ALPHA_SCALE,
  );
  // The authored material is owned too: the batch draws the cutout, and the GLB's own surface is
  // still this asset's to hand back.
  worldOwned.add(cutout);
  return { material: cutout, owned: [material, cutout] };
}

/**
 * Every drawable part of a loaded model: one per `Mesh`, each with its shape, its surface, and
 * where it sits relative to the model root.
 *
 * A GLB authored as a tree — bark `OPAQUE`, needles `BLEND` — is one node carrying one mesh with
 * two primitives, which three loads as a `Group` of one child `Mesh` per primitive. Taking only the
 * first of those drew 62k bare trunks, so every one of them is a part and each keeps its own
 * material.
 *
 * `SkinnedMesh` is skipped deliberately: its vertices are posed per frame from a skeleton, and one
 * `InstancedMesh` of the geometry would draw the rest pose once per placement. `Points` and
 * `LineSegments` are not `Mesh`es and are skipped with them.
 */
function renderableParts(
  model: Object3D,
  surfaceFor: (material: Material) => { readonly key: string; readonly material: Material },
): readonly IAssetPart[] {
  model.updateMatrixWorld(true);
  const rootInverse = new Matrix4().copy(model.matrixWorld).invert();
  const local = new Matrix4();
  const parts: IAssetPart[] = [];
  model.traverse((object: Object3D) => {
    if (object instanceof SkinnedMesh || !(object instanceof Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (object.geometry === undefined || material === undefined) return;
    const surface = surfaceFor(material);
    parts.push({
      geometry: object.geometry,
      local: local.multiplyMatrices(rootInverse, object.matrixWorld).clone(),
      material: surface.material,
      surface: surface.key,
    });
  });
  return parts;
}

function disposeModel(model: Object3D): number {
  let failed = 0;
  model.traverse((object: Object3D) => {
    if (!(object instanceof Mesh)) return;
    if (release(object.geometry)) failed += 1;
    const materials: Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    // A world-owned surface is one chunk's proxy material, and the next chunk's teardown would
    // otherwise release a material this world's remaining proxies are still drawing with. It is
    // released with the world that owns it; see `WorldCells#dispose`.
    for (const material of materials)
      if (!worldOwned.has(material) && release(material)) failed += 1;
  });
  return failed;
}

/**
 * How many groups the main record is split into. A record walks every draw in its group, so a mint
 * on a streaming walk costs the draws of every shard it touches: Machinefall's ~200 recorded main
 * draws re-recorded as one group put ~290 traversed draws in a frame. Eight shards still read 145,
 * because one asset mints several keys (levels, parts) at once and they land in two or three shards;
 * thirty-two keep a frame that touches several to a few dozen draws. A replay is one
 * `executeBundles` per group, so a shard costs far less than the draws it stops re-walking.
 */
const MAIN_BUNDLE_SHARDS = 32;

/** The shard a key lands in, from its name (FNV-1a), so a key keeps its group for its whole life. */
function mainShard(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MAIN_BUNDLE_SHARDS;
}

/** Every mesh a prepared chunk draws through the main pass, in traversal order. */
function chunkDraws(chunk: Object3D): Mesh[] {
  const draws: Mesh[] = [];
  chunk.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh === true && node.layers.isEnabled(0)) draws.push(mesh);
  });
  return draws;
}

/**
 * One empty batch per (level, part), so a placement is filtered and drawn together and an emptied
 * level or a part nobody placed costs one missing mesh rather than the whole cell's run.
 */
function newBatches(asset: IAssetState): InstancedBatch[][] {
  const batches: InstancedBatch[][] = [];
  for (const parts of asset.levels) {
    const levelBatches: InstancedBatch[] = [];
    for (const part of parts)
      levelBatches.push(new InstancedBatch({ geometry: part.geometry, material: part.material }));
    batches.push(levelBatches);
  }
  return batches;
}

/** How many meshes a build will publish: one per (level, part). */
function publishCount(batches: readonly InstancedBatch[][]): number {
  let total = 0;
  for (const levelBatches of batches) total += levelBatches.length;
  return total;
}

/**
 * One empty bounds box per `(level, part)`, beside the batches `#addPlacements` measures. Written
 * as a loop because this file is held to a rule that the array method's name is a material's
 * texture property.
 */
function newBoxes(batches: readonly InstancedBatch[][]): Box3[][] {
  const boxes: Box3[][] = [];
  for (const levelBatches of batches) {
    const level: Box3[] = [];
    for (const _batch of levelBatches) level.push(new Box3());
    boxes.push(level);
  }
  return boxes;
}

/**
 * The levels one asset is drawn at, and the distances its batching can be crossed at.
 *
 * Level 0 is the asset's own `glb` and never switches; `lods[i - 1].distance` is where an instance
 * that far out draws `lods[i]` instead. A `lods` entry at or beyond the cull distance is dropped:
 * an instance that far out is culled, so its shape can never be drawn. `gates` is every distance
 * the level or cull answer changes at — `threshold` is the nearest of them, so a follow point that
 * has moved an eighth of it may have moved an instance either way.
 */
function assetLevels(definition: IWorldAsset): {
  readonly distances: readonly number[];
  readonly gates: readonly number[];
  readonly glbs: readonly string[];
  readonly threshold: number | undefined;
} {
  const maxDistance = definition.maxDistance;
  const distances: number[] = [0];
  const glbs: string[] = [definition.glb];
  const gates: number[] = [];
  for (const lod of definition.lods ?? []) {
    // A level at or beyond the cull distance is never drawn: an instance that far out is gone by
    // the time the level would take over, so its GLB is never asked for.
    if (maxDistance !== undefined && lod.distance >= maxDistance) continue;
    distances.push(lod.distance);
    glbs.push(lod.glb);
    gates.push(lod.distance);
  }
  const cull = cullDistance(maxDistance);
  if (cull !== undefined) gates.push(cull);
  return {
    distances,
    gates,
    glbs,
    threshold: gates.length === 0 ? undefined : Math.min(...gates),
  };
}

/**
 * The batched shape of one definition, as the loader will actually fetch it: the url the manifest
 * gives its `glb`, the url and switch distance of every `lods` entry in order, its `maxDistance` and
 * its bounds. Two definitions that agree on all of it are the same draw — same geometry, same
 * materials, same levels, same gates — so one model serves both and their placements batch together.
 *
 * `undefined` when the loader cannot resolve a path at all: a path the manifest does not list makes
 * `resolve` throw, and the load that asks for it will say so. Such a definition never aliases,
 * which is the same behaviour it has today.
 */
async function assetSignature(
  assets: IAssetLoader,
  definition: IWorldAsset,
  logicalBase: string,
): Promise<string | undefined> {
  const url = async (glb: string): Promise<string> => {
    const candidates = await assets.resolve(resolveRelative(logicalBase, glb));
    return candidates[0] ?? glb;
  };
  try {
    const parts = [await url(definition.glb)];
    for (const lod of definition.lods ?? [])
      parts.push(`${await url(lod.glb)}@${String(lod.distance)}`);
    parts.push(
      definition.maxDistance === undefined ? "" : String(definition.maxDistance),
      definition.bounds.min.join(","),
      definition.bounds.max.join(","),
    );
    return parts.join("|");
  } catch {
    return undefined;
  }
}

/**
 * `alias id -> canonical id` for every definition that is another name for the same cooked model,
 * which is what a 374-asset package with 273 duplicates is: one model exported under many object
 * names, cooked once and fetched once.
 *
 * The canonical is the lexicographically smallest id of the group, so it does not depend on the
 * order the exporter happened to write them in. An empty map — every definition its own model, or a
 * package whose paths resolve to nothing — leaves the whole runtime exactly as it is.
 */
async function assetAliases(
  assets: IAssetLoader,
  manifest: IWorldPackage,
  logicalBase: string,
): Promise<ReadonlyMap<string, string>> {
  const canonicalBySignature = new Map<string, string>();
  const aliases = new Map<string, string>();
  // Sorted, so the first id to claim a signature is the smallest one in its group.
  for (const id of Object.keys(manifest.assets).sort()) {
    const definition = manifest.assets[id];
    if (definition === undefined) continue;
    const signature = await assetSignature(assets, definition, logicalBase);
    if (signature === undefined) continue;
    const canonical = canonicalBySignature.get(signature);
    if (canonical === undefined) canonicalBySignature.set(signature, id);
    else aliases.set(id, canonical);
  }
  return aliases;
}

/**
 * A geometry that draws `source`'s shape through an indirect record: its own object, so the record is
 * this mesh's, over the same attributes and index, so no vertex buffer is copied.
 */
function indirectView(
  source: BufferGeometry,
  args: Parameters<BufferGeometry["setIndirect"]>[0],
  offset: number,
): BufferGeometry {
  const view = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes))
    view.setAttribute(name, attribute);
  view.setIndex(source.index);
  view.morphAttributes = source.morphAttributes;
  view.morphTargetsRelative = source.morphTargetsRelative;
  for (const group of source.groups) view.addGroup(group.start, group.count, group.materialIndex);
  view.boundingBox = source.boundingBox;
  view.boundingSphere = source.boundingSphere;
  view.setIndirect(args, offset);
  return view;
}

/** The materials `redressMaterial` gave a mesh, disposed when the mesh is or when it is re-dressed. */
const redressed = new WeakMap<InstancedMesh, readonly Material[]>();

/**
 * A new object drawing `geometry`, carrying everything `old` carried.
 *
 * Three builds an `InstancedMesh`'s instancing node when the object is first compiled, from the
 * `instanceMatrix` it holds then, and keeps that node for the object's whole life — so a mesh the
 * prewarm already compiled is not pointed at the GPU scene's storage buffer by writing a field onto
 * it. Measured on machinefall: 3,724 indirect draws submitted in 2 s, over indirect records and
 * drawn matrices that were correct at draw time, and a dressed forest that drew nothing at all,
 * until every dressed mesh was a fresh object. A fresh object costs a uuid and a node build, which
 * is what the prewarm paid for a mesh that was about to be replaced anyway; see `#dressGpu`.
 */
function freshMeshFor(old: InstancedMesh, geometry: BufferGeometry, count: number): InstancedMesh {
  const next = new InstancedMesh(geometry, old.material, count);
  next.name = old.name;
  next.layers.mask = old.layers.mask;
  next.castShadow = old.castShadow;
  next.receiveShadow = old.receiveShadow;
  next.renderOrder = old.renderOrder;
  next.userData = old.userData;
  next.matrix.copy(old.matrix);
  next.matrixAutoUpdate = old.matrixAutoUpdate;
  next.matrixWorld.copy(old.matrixWorld);
  next.matrixWorldAutoUpdate = old.matrixWorldAutoUpdate;
  // A dressed batch is frozen, and the freeze is keyed by the object: a replacement that did not
  // re-arm it would compose its own world matrix every walk forever.
  if (isStatic(old)) markStatic(next);
  return next;
}

/**
 * Give a mesh a material of its own, so the node three builds for it is its own rather than a shared
 * one's, and dispose those materials with the mesh. The clones share every texture; only the
 * material objects are new. See `#dressGpu`.
 */
function redressMaterial(mesh: InstancedMesh): void {
  for (const material of redressed.get(mesh) ?? []) material.dispose();
  const clones: Material[] = [];
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    clones.push(material.clone());
  mesh.material = Array.isArray(mesh.material) ? clones : (clones[0] as Material);
  if (!redressed.has(mesh))
    mesh.addEventListener("dispose", () => {
      for (const material of redressed.get(mesh) ?? []) material.dispose();
      redressed.delete(mesh);
    });
  redressed.set(mesh, clones);
}

/**
 * Pixels one world unit covers at unit depth, from the vertical field of view and the raster height.
 * The scale `ModelLod` divides an error by; see `IWorldCellsLoadOptions.autoLod`.
 */
function autoLodScale(autoLod: IWorldCellsLoadOptions["autoLod"]): number {
  const fovY = autoLod?.fovY ?? DEFAULT_AUTO_LOD_FOV_Y;
  const viewportHeight = autoLod?.viewportHeight ?? DEFAULT_AUTO_LOD_VIEWPORT_HEIGHT;
  if (!Number.isFinite(fovY) || fovY <= 0 || fovY >= 180)
    throw new Error("WorldCells autoLod.fovY must be a finite angle in (0, 180) degrees.");
  if (!Number.isFinite(viewportHeight) || !(viewportHeight > 0))
    throw new Error(
      "WorldCells autoLod.viewportHeight must be a positive number of raster pixels.",
    );
  return viewportHeight / (2 * Math.tan((fovY * Math.PI) / 360));
}

/** The screen-space error budget a synthesized level is switched at, in pixels. */
function autoLodPixelError(autoLod: IWorldCellsLoadOptions["autoLod"]): number {
  const maxPixelError = autoLod?.maxPixelError ?? DEFAULT_AUTO_LOD_MAX_PIXEL_ERROR;
  if (!Number.isFinite(maxPixelError) || maxPixelError <= 0)
    throw new Error("WorldCells autoLod.maxPixelError must be a positive number of pixels.");
  return maxPixelError;
}

/** The adaptive LOD bias floor. A bias is only ever allowed to coarsen selection, never refine it. */
const LOD_BIAS_MIN = 1;
/** The adaptive LOD bias ceiling, so a runaway maps to a coarser but still bounded world. */
const LOD_BIAS_MAX = 2.5;
/** How much the bias rises per over-budget step. */
const LOD_BIAS_RISE = 1.08;
/** How much the bias decays per comfortably-under-budget step. */
const LOD_BIAS_DECAY = 0.95;
/** Seconds between rise or decay steps; a change is never larger than one step. */
const LOD_BIAS_STEP_SECONDS = 0.5;
/** Below this share of the affordable budget the bias decays; between it and the budget it holds. */
const LOD_BIAS_DECAY_SHARE = 0.6;
/** Default fraction of a 60 fps frame the main pass may take before the bias rises. */
const DEFAULT_MAIN_GPU_SHARE = 0.5;
/** Seconds between two `TN_LOD_BIAS` lines. */
const LOD_BIAS_MARKER_SECONDS = 1;
/** The line the adaptive loop prints when it moves the bias. */
export const LOD_BIAS_MARKER = "TN_LOD_BIAS";

/**
 * One launch override, read once: the environment, then the query string, then the global a test
 * sets. The same three ways a debug flag is asked, but the answer is kept as text so a number can
 * be parsed by the caller rather than rounded here.
 */
function launchValue(parameter: string, flag: string, globalName: string): string | undefined {
  const host = globalThis as { process?: { env?: Record<string, unknown> } } & Record<
    string,
    unknown
  >;
  const env = host.process?.env?.[flag];
  if (typeof env === "string" && env !== "") return env;
  const query = globalThis.location?.search;
  if (typeof query === "string") {
    const value = new URLSearchParams(query).get(parameter);
    if (value !== null) return value;
  }
  const global = host[globalName];
  if (typeof global === "number") return String(global);
  return typeof global === "string" ? global : undefined;
}

/** Whether the adaptive LOD bias runs: on unless a launch pins it off. */
function adaptiveLodRequested(): boolean {
  const raw = launchValue("tnAdaptiveLod", "TN_ADAPTIVE_LOD", "__tnAdaptiveLod");
  return raw === undefined ? true : raw !== "0" && raw !== "false";
}

/** The main-pass GPU share: the option, then the launch override, then 0.5. */
function mainGpuShare(option: number | undefined): number {
  const raw = launchValue("tnMainGpuShare", "TN_MAIN_GPU_SHARE", "__tnMainGpuShare");
  const launched = raw === undefined ? undefined : Number(raw);
  const share = option ?? launched ?? DEFAULT_MAIN_GPU_SHARE;
  if (!Number.isFinite(share) || share <= 0 || share > 1)
    throw new Error("WorldCells mainGpuShare must be a number in (0, 1].");
  return share;
}

/** What a baked chain gives a batched draw: the extra levels, where they take over, what they cost. */
interface IChainLevels {
  /** Index-aligned with `distances`; index 0 is the parts the asset already had. */
  readonly levels: (readonly IAssetPart[])[];
  /** `distances[0]` is 0 and never switches; the rest are the synthesized switch distances. */
  readonly distances: number[];
  /** Triangles every level submits, all its parts together, index-aligned with `levels`. */
  readonly triangles: number[];
}

/**
 * The extra levels an asset's baked AutoLOD chain gives a batched draw, or `undefined` when none of
 * its parts carries a chain.
 *
 * A `ModelLod` swaps one mesh's geometry, so a world that batches thousands of placements of one
 * model into a handful of instanced draws never reaches that selection: every placement drew
 * LOD0, which on a 2 km map is the whole triangle bill at every distance. The chain already holds
 * the reduced shapes, so this derives the levels a batch can hold and the distance each one takes
 * over at — the same screen-space test `ModelLod` runs, solved for depth:
 * `error * pixelsPerUnit / maxPixelError`, with each part's own registered budget.
 *
 * Level `i` is `chain.levels[min(i, length - 1)]` per part, so a part without a chain — and one
 * whose chain ran out below `i` — keeps the shape above it. The switch distances come from the
 * parts that descend the furthest, the **max** across those at each level, so the deepest chain's
 * whole ladder survives. A part with a shallower chain clamps to its last level and does not set a
 * switch: it cannot be drawn finer there anyway, so its error must not push the switch past the
 * deepest chain's own last error and collapse the ladder to one far step.
 */
function chainDistances(
  chains: readonly (ILodChain | undefined)[],
  pixelsPerUnit: number,
  maxPixelError: number,
  maxDistance: number | undefined,
): number[] {
  let deepest = 1;
  for (const chain of chains)
    if (chain !== undefined) deepest = Math.max(deepest, chain.levels.length);
  const distances = [0];
  for (let level = 1; level < deepest; level += 1) {
    let error = 0;
    for (const chain of chains) {
      // Only the parts that descend the furthest set the schedule. A part whose chain ran out has
      // no finer shape to offer past its last level, so letting its — often terminal, and so huge —
      // error gate this switch cannot buy that part any detail back. It would only deny every
      // sibling the coarser level and collapse the chain to a single far switch, which is how a
      // bark primitive's 2-level chain truncated a pine's 4-level needles chain to two levels.
      if (chain === undefined || chain.levels.length !== deepest) continue;
      error = Math.max(error, chain.errors[level] ?? 0);
    }
    const at = (error * pixelsPerUnit) / maxPixelError;
    // A chain's errors only ascend, so a switch that does not move outward — or that lands at or
    // past the cull — ends the list: every level above it is further out still, and none of them
    // can be selected or drawn. That keeps the thresholds strictly increasing and inside
    // `maxDistance`, exactly as `assetLevels` keeps authored ones.
    if (at <= (distances[level - 1] as number)) break;
    if (maxDistance !== undefined && at >= maxDistance) break;
    distances.push(at);
  }
  return distances;
}

/** One level's parts, and what they submit: the chain's shape where it has one, the one above where not. */
function chainLevelParts(
  parts: readonly IAssetPart[],
  chains: readonly (ILodChain | undefined)[],
  level: number,
): { readonly parts: IAssetPart[]; readonly triangles: number } {
  const at: IAssetPart[] = [];
  let triangles = 0;
  for (const [index, part] of parts.entries()) {
    const chain = chains[index];
    // A part with no chain keeps its own shape, in its own slot: the batch builder and
    // `#addPlacements` index every level's parts by the same number.
    const geometry =
      chain === undefined
        ? part.geometry
        : (chain.levels[Math.min(level, chain.levels.length - 1)] as BufferGeometry);
    at.push(geometry === part.geometry ? part : { ...part, geometry });
    triangles += levelTriangles(geometry);
  }
  return { parts: at, triangles };
}

/**
 * The extra levels an asset's baked AutoLOD chain gives a batched draw, or `undefined` when none of
 * its parts carries a chain.
 *
 * A `ModelLod` swaps one mesh's geometry, so a world that batches thousands of placements of one
 * model into a handful of instanced draws never reaches that selection: every placement drew
 * LOD0, which on a 2 km map is the whole triangle bill at every distance. The chain already holds
 * the reduced shapes, so this derives the levels a batch can hold and the distance each one takes
 * over at — the same screen-space test `ModelLod` runs, solved for depth:
 * `error * pixelsPerUnit / maxPixelError`, over the world's own `autoLod.maxPixelError` rather than
 * the budget the loader registered the chain with. See
 * {@link IWorldCellsLoadOptions.autoLod} for why a batch cannot use the registered one.
 *
 * Level `i` is `chain.levels[min(i, length - 1)]` per part, so a part without a chain — and one
 * whose chain ran out below `i` — keeps the shape above it. The switch distances come from the
 * parts that descend the furthest, the **max** across those at each level, so the deepest chain's
 * whole ladder survives. A part with a shallower chain clamps to its last level and does not set a
 * switch: it cannot be drawn finer there anyway, so its error must not push the switch past the
 * deepest chain's own last error and collapse the ladder to one far step.
 */
/** Prepared sources may have replaced attributes or cut a material section after cloning. */
function preparedChainSafe(part: IAssetPart): boolean {
  const base = part.geometry;
  const chain = lodChainOf(base);
  if (chain === undefined) return true;
  if (
    base.drawRange.start !== 0 ||
    base.drawRange.count !== Number.POSITIVE_INFINITY ||
    base.groups.length > 0 ||
    part.material.transparent ||
    part.material.alphaTest > 0 ||
    displacesVertices(part.material) ||
    Reflect.get(part.material, "vertexNode") != null
  )
    return false;
  const names = Object.keys(base.attributes);
  return chain.levels.every(
    (level) =>
      Object.keys(level.attributes).length === names.length &&
      names.every((name) => level.getAttribute(name) === base.getAttribute(name)),
  );
}

function chainLevels(
  parts: readonly IAssetPart[],
  pixelsPerUnit: number,
  maxPixelError: number,
  maxDistance: number | undefined,
): IChainLevels | undefined {
  const chains: (ILodChain | undefined)[] = [];
  for (const part of parts) chains.push(lodChainOf(part.geometry));
  const distances = chainDistances(chains, pixelsPerUnit, maxPixelError, maxDistance);
  if (distances.length === 1) return undefined;
  const levels: (readonly IAssetPart[])[] = [parts];
  // Level 0 leads, so the marker opens with what the asset submits today.
  const triangles: number[] = [parts.reduce((sum, part) => sum + levelTriangles(part.geometry), 0)];
  for (let level = 1; level < distances.length; level += 1) {
    const at = chainLevelParts(parts, chains, level);
    levels.push(at.parts);
    triangles.push(at.triangles);
  }
  return { distances, levels, triangles };
}

/**
 * The DRAW levels an authored asset gets: every level keeps the geometry, transform and surface it
 * authored, and the root LOD0's alpha-cutout parts are appended to a level that authored fewer alpha
 * slots than the root carries, so no middle level loses leaves its reduced card cannot honestly
 * represent.
 *
 * An authored reduced foliage card has no honest twin — the automatic reducer's error metric cannot
 * see the holes a cutout silhouette is made of — but a level that authored such a card keeps it:
 * only the slots a level carries none of fall back to the root, in the root's own per-role order, so
 * a middle with one reduced card and a root with two gets its own card plus the root's second. The
 * fallback parts are appended after the level's authored parts, never reordered, so each level keeps
 * its own part indices and counts. Nothing is spilled: a fallback shares the root part by reference,
 * so one resource is still one teardown.
 */
function coverAuthoredLevels(
  levels: readonly (readonly IAssetPart[])[],
): readonly (readonly IAssetPart[])[] {
  const rootAlpha = (levels[0] ?? []).filter((part) => isAlphaFoliage(part.material));
  if (rootAlpha.length === 0 || levels.length < 2) return levels;
  const covered: (readonly IAssetPart[])[] = [levels[0] as readonly IAssetPart[]];
  for (const parts of levels.slice(1)) {
    let authoredAlpha = 0;
    for (const part of parts) if (isAlphaFoliage(part.material)) authoredAlpha += 1;
    if (authoredAlpha >= rootAlpha.length) {
      covered.push(parts);
      continue;
    }
    const mapped: IAssetPart[] = [...parts];
    for (let slot = authoredAlpha; slot < rootAlpha.length; slot += 1)
      mapped.push(rootAlpha[slot] as IAssetPart);
    covered.push(mapped);
  }
  return covered;
}

/**
 * Model loads in flight for a streamed world. `loadAll`'s six suits a scene's one-off load; a
 * world crossing new asset types as it moves spends most of each load waiting on the network and
 * the transcoder workers, so more in flight keeps the ring ahead of a fast camera.
 */
const WORLD_LOAD_CONCURRENCY = 12;

/**
 * Stream a Blender-authored world package by cell and keep it resident around a followed point.
 *
 * The class composes `TerrainTiles` for the package's heightmap, builds one `InstancedBatch` per
 * resident cell asset run, distance level and mesh part, and loads hand-placed chunk GLBs through
 * `loadAll` + `addInSlices`. Ring residency, per-asset `maxDistance` filtering, the per-asset `lods`
 * levels, hard budgets and generation-tokened cancellation all live here; every geometry, material
 * and surface still comes from the package's GLBs and the game.
 *
 * An asset is drawn per part, not per model: a GLB with several primitives is one `InstancedBatch`
 * each, and a scattered part whose own material is transparent draws as an alpha cutout unless the
 * game asks for blending, because an `InstancedMesh` cannot sort its instances.
 *
 * An asset with no nonempty authored `lods` can draw its own model's baked AutoLOD chain at distances
 * measured over the `autoLod` viewport. An explicit empty list enrolls only unchanged static parts;
 * section ranges, custom attributes, alpha foliage and vertex deformation retain source geometry.
 *
 * @situation stream a large Blender-authored world by cell instead of one huge GLB
 * @situation keep scattered props and hand-placed chunks resident around a moving player
 * @situation honour per-asset draw distances and hard streaming budgets without a mid-frame throw
 * @constraint surface is the game's; this class creates no material, colour or geometry
 * @constraint budgets are hard caps that report pressure instead of over-committing
 * @constraint `whenSpawnReady(position, radius, timeoutMs)` snapshots a fixed region and settles from existing updates or disposal; it does not drive streaming, and `prewarmed` remains the separate draw gate
 * @constraint model loads are bounded by `concurrency` (default 12) across every resident cell, not per cell
 * @constraint refilters are bounded by `rebuildsPerUpdate` (default 16) per update, nearest cell first
 * @constraint admission is bounded by `admissionBudgetMs` (default 2) per update across every path, plus at most one unit each for terrain and props; while props are queued terrain takes at most half, so neither starves the other, and a deferred cell keeps drawing what it has
 * @constraint SkinnedMesh parts are skipped; an instanced copy would draw one rest pose
 * @constraint a baked chain's switch distances are measured against `autoLod` (default 4 px of error over 60° and 1080 raster rows), because an instanced draw cannot select a level per instance; an asset with nonempty authored `lods` never consults it; explicit empty lists enroll only unchanged static geometry/material parts
 * @constraint eligible static CPU cells can use their cooked HLOD after compilation and an observed main-context backend submission; projected-error hysteresis requires actual source triangle reduction and no extra material draws, unsupported or shared source stays resident, and collision/shadow paths retain source representations; stats().hlod counts lifecycle and charged resources, not GPU timing or physical allocation
 * @override `hlod: false` keeps source rendering; ring, budgets, terrain tile size/resolution, terrain stream and collider radius, `transparentScatter`, `clusterSize` and `shadows.invalidate`, load `concurrency`, `rebuildsPerUpdate`, `admissionBudgetMs` and the package's per-asset maxDistance
 * @constraint `prewarmed` resolves once every prewarmed shared batch has been drawn; a game with a loading screen waits on it, and `stats().pendingPrewarm` is the same gate as a number
 * @constraint every `asset:level:part` is one InstancedMesh for the main pass, plus one caster InstancedMesh per world-grid square of `clusterSize` on the shadow caster layer, so the main pass draws one mesh per key and a shadow level submits only the squares it covers
 * @constraint two definitions the asset loader resolves to one model — the same cooked `glb`, the same `lods` at the same distances, the same `maxDistance` and bounds — are one asset under the lexicographically smallest id: one model load, one set of `asset:level:part` keys, one prewarm and one refcount, released when the last cell holding any member of the group leaves the ring; `TN_WORLD_ASSET_ALIAS` reports how many of the package's assets are really distinct
 * @constraint the main pass mesh draws only the squares the render camera's frustum covers — on by default, narrowed once per frame for every main batch by the engine's render-cadence dispatch, never for an orthographic camera — a batch with nothing to draw is hidden rather than submitted at `count 0`, and `TN_WORLD_MAIN_CULL` reports both every five seconds
 * @constraint a loaded chunk is merged by material before it is added, so it submits one draw per material rather than one per node; a skinned, multi-material or morph-target mesh, one carrying a baked AutoLOD chain, and an instanced mesh past `chunkMergeMaxTriangles` (default 43,690 triangles) or with a shape over 2,048 triangles, all keep their own geometry; a material group crossing 131,072 vertices (4 MiB of position + normal + uv) is split into several meshes in traversal order instead of one giant upload, indexed parts keep their index, and `TN_WORLD_CHUNK_MERGE` reports what the merge did and the bytes it left
 * @constraint `shadows.castDistance` is accepted and ignored (clusters replaced it); `shadows.invalidate` is called at most once a second after streamed records changed
 * @example
 * const world = await WorldCells.load({ url: "/world/world.json", surface, follow, ring: 1, budgets: { residentCells: 25, instances: 20000, bytes: 8000000 } });
 * scene.add(world);
 * world.update();
 */
export class WorldCells extends Group implements IComputeDriven {
  readonly processCadence = "render" as const;
  readonly processDuringStartup = true;
  readonly #budgets: IWorldCellsBudget;
  readonly #cells: readonly IWorldCell[];
  readonly #cellSize: number;
  readonly #follow: IWorldCellsFollow;
  readonly #loader: IAssetLoader;
  /**
   * Whether {@link #loader} was created here rather than supplied by the game. Only an internally
   * owned loader may have its `model` cache released when this world's last cell stops naming a
   * path: an explicitly supplied loader is the caller's, another world may hold the same cached
   * model, and its own `release` is the caller's to call. See `#releaseModelPaths`.
   */
  readonly #ownsLoader: boolean;
  readonly #loadModel: ((url: string) => Promise<Object3D>) | undefined;
  readonly #limiter: ModelLoadLimiter;
  readonly #manifest: IWorldPackage;
  readonly #minX: number;
  readonly #minZ: number;
  readonly #placements: ArrayBuffer;
  readonly #rebuildsPerUpdate: number;
  readonly #prefetchSeconds: number;
  readonly #freshMeshesPerUpdate: number;
  readonly #coveredFreshMeshesPerUpdate: number;
  /**
   * Pixels per world unit at unit depth, the scale a baked chain's level errors are divided by to
   * reach a switch distance. See `IWorldCellsLoadOptions.autoLod` and {@link chainLevels}.
   */
  readonly #autoLodPixelsPerUnit: number;
  /** The screen-space error budget a synthesized level is switched at; see `autoLod`. */
  readonly #autoLodMaxPixelError: number;
  /** Assets widened by their own chain so far, and whether the marker has already collapsed. */
  #chainLodAssets = 0;
  #chainLodSummarised = false;
  /** Fresh meshes created this update, and whether a build waited for next frame's allowance. */
  #freshThisUpdate = 0;
  #meshStalled = false;
  /** Smoothed follow velocity (m/s) and the sample it was last updated from. */
  #velocityX = 0;
  #velocityZ = 0;
  #lastSample: { readonly x: number; readonly z: number; readonly t: number } | undefined;
  readonly #ring: number;
  readonly #terrain: TerrainTiles | undefined;
  readonly #hasColliders: boolean;
  readonly #lodHysteresis: number;
  readonly #placementLevels: Uint32Array | undefined;
  readonly #placementReach: Float32Array | undefined;
  readonly #reachRanges: Map<
    IWorldCell,
    Map<string, { min: number; max: number; minY: number; maxY: number }>
  >;
  readonly #transparentScatter: "cutout" | "blend";
  readonly #baseUrl: string;
  readonly #logicalBase: string;
  /**
   * Asset ids the package named twice for one model, each pointing at the id kept. Every lookup of
   * an id by a run's `asset` goes through {@link #canonical}, so a duplicate's placements are built,
   * keyed, prewarmed, refcounted and released as the one asset they really are. Empty when the
   * package has no duplicates, and then the lookup is the identity.
   */
  readonly #aliases: ReadonlyMap<string, string>;
  readonly #assets = new Map<string, IAssetState>();
  /**
   * Exact `assets.model` cache paths this world holds, and how many of its asset states ask for
   * each. Two distinct canonical assets can name the same path when their `lods`/`maxDistance`
   * differ — the package's own aliasing leaves them separate — so the loader entry is released only
   * when the last state naming the path goes. Keyed on the logical path requested, which is what the
   * loader caches by, not the cooked url it resolves to. Empty under a `loadModel` override, which
   * reaches no cache.
   */
  readonly #modelPaths = new Map<string, number>();
  readonly #resident = new Map<string, IResidentCell>();
  /** Surfaces shared by material content across every asset part; see `materialKey`. */
  readonly #surfaces = new Map<string, ISharedSurface>();
  /** One shared mesh per `asset:level:part`, holding every resident cell's segment; see SharedBatch. */
  readonly #shared = new Map<string, SharedBatch>();
  readonly #bundleSafety = new BundleSurfaceSafety();
  /**
   * `asset:level:part` -> a released batch kept for the walk back over the same ground, oldest
   * first. `#release` used to throw the mesh away with the asset, so a cell that left the ring and
   * came back drew into a brand new one — a uuid three had never built a node for, in the main pass
   * and in every shadow pass, which is the walk-time frame cost the standing frame rate never pays.
   * The batch is empty by then (`#evict` clears a cell's own block before the refcount reaches
   * zero), so it is handed back whole; only its parts are gone, and `rebind` replaces them.
   */
  readonly #retired = new Map<string, SharedBatch>();
  #retiredBytes = 0;
  /**
   * Games waiting on `whenSpawnReady`, settled by the update that follows admissions or by dispose.
   * One set, no listener registry and no polling: the update that already walks residency observes
   * these, so a world nobody is waiting on scans nothing. See {@link whenSpawnReady}.
   */
  readonly #spawnWaiters = new Set<ISpawnWaiter>();
  readonly #extentBounds: Box3;
  /** The largest run of each asset in any cell: the segment size every cell of it fits. */
  readonly #runMax = new Map<string, number>();
  /** How many of an asset's finest levels cast shadows; 0 when the game asked for none. */
  readonly #castShadowLevels: number;
  readonly #receiveShadow: boolean;
  /** Asset bounds height under which a wide caster goes on the finest level's layer only. */
  readonly #smallCasterMetres: number;
  /** The triangle cap a chunk's instanced meshes are expanded under; see the load option. */
  readonly #chunkMergeMaxTriangles: number;
  /** The six planes of `#camera`'s frustum, as the live-state reference reads them; reused per check. */
  readonly #gpuPlanes = new Float32Array(24);
  /**
   * Side of a world-grid square, and how many cells fit in one. One `SharedBatch` per
   * `asset:level:part` per square, so the mesh's bounds are that square's records and every camera
   * culls at square granularity. A cell's placements never move, so a record's square is the one
   * its own cell sits in and nothing is ever re-clustered.
   */
  readonly #clusterSize: number;
  readonly #cellsPerCluster: number;
  /**
   * Streamed records changed since the shadow levels were last told, and when they were last told.
   * One blanket `invalidate` a second, and only for a game that passed the hook: the companions
   * used to make the hook necessary, and now the levels cull clusters themselves.
   */
  // `true` so the first `update` runs a residency pass: `#residencyStale` reads it, and a fresh
  // world has admitted nothing.
  #shadowMoved = true;
  #shadowToldAt = Number.NEGATIVE_INFINITY;
  /**
   * The union of the bounds of the records that moved since the levels were last told, so the tell
   * carries the region rather than the whole cascade. `undefined` is a change with no region to
   * name — the prewarm's blanket ask — and is handed on as no argument at all.
   */
  #shadowRegion: IShadowRegion | undefined;
  /** When `TN_WORLD_MAIN_CULL` was last printed; see {@link #reportMainCull}. */
  #mainCullToldAt = 0;
  /** Window repacks since the last marker; see {@link #reportMainCull}. */
  #mainCullRepacks = 0;
  /** Frusta the main cull has built, one a frame; see `IWorldCellsStats.mainCull`. */
  #mainCullFrustums = 0;
  /** Windows main batches have had to re-derive, cumulative; see `IWorldCellsStats.mainCull`. */
  #mainCullWindows = 0;
  /** Window repacks, cumulative; see `IWorldCellsStats.mainCull`. */
  #mainCullPacks = 0;
  /**
   * One AABB per resident visibility cell, and how many resident world cells hold it. Shared by
   * every key, so the main cull is O(visibility cells) a frame rather than O(keys × cells); see
   * {@link #cullMainPass}.
   */
  readonly #cullCells = new Map<string, { cells: number; box: Box3 }>();
  /** World cells per main-cull visibility cell; see `MAIN_CULL_SQUARE_METRES`. */
  readonly #cellsPerCullCell: number;
  /** The visibility cells the last cull kept and the frame's set, trading places; see `#cullMainPass`. */
  #visibleSquares: Set<string> = new Set();
  #cullScratch: Set<string> = new Set();
  /** Bumped only when `#visibleSquares` changed, so a settled camera repacks no batch at all. */
  #visibleEpoch = 0;
  /** The follow point the last full residency pass ran for; see `#residencyStale`. */
  readonly #residencyPoint = new Vector3(Number.NaN, 0, Number.NaN);
  /** The follow point's cell at the last residency pass; a move of more than one is a jump. */
  #residencyCell: { readonly x: number; readonly z: number } | undefined;
  /** The follow point the last refilter pass ran for; see `#refilterStale`. */
  readonly #refilterPoint = new Vector3(Number.NaN, 0, Number.NaN);
  /** Bumped by every admission and eviction, so a residency change owes a refilter that update. */
  #residencyEpoch = 0;
  /** The residency epoch the last refilter pass saw; see `#refilterStale`. */
  #refilterEpoch = -1;
  /** The last pass found more stale cell-assets than `rebuildsPerUpdate` could queue. */
  #refilterOwed = false;
  /** The game's hook to refresh the shadow levels after streamed records changed. */
  readonly #invalidateShadows: ((region?: IShadowRegion) => void) | undefined;
  /** Cell-asset builds waiting for budget, in admission order: nearest cell first. */
  #jobs: IBuildJob[] = [];
  /** The (cell, run) pairs already queued, so a refilter cannot queue itself twice. */
  readonly #queued = new Set<IWorldRun>();
  readonly #position = new Vector3();
  readonly #rotation = new Quaternion();
  readonly #scale = new Vector3();
  readonly #matrix = new Matrix4();
  readonly #instance = new Matrix4();
  /** The authored bounds' centre, placed: the source sphere's centre. See `#addPlacements`. */
  readonly #sourceCentre = new Vector3();
  /** Reused transformed authored bounds for admission and conservative visibility volumes. */
  readonly #recordBounds = new Box3();
  readonly #pressure = { cells: 0, instances: 0, bytes: 0 };
  readonly #budgetMs: number;
  readonly #coveredBudgetMs: number;
  /** Set for the length of one `process` call that runs behind the startup cover. */
  #covered = false;
  readonly #now: () => number;
  #admission = { spentMs: 0, deferred: 0, backlog: 0 };
  #instances = 0;
  #bytes = 0;
  #evictions = 0;
  #failures = 0;
  #rebuilds = 0;
  /** Refilter passes run, whether or not they queued anything; see `IWorldCellsStats.refilters`. */
  #refilters = 0;
  /** Refilters whose rebuild came back identical and were settled without a write. */
  #unchanged = 0;
  /** Every distinct gate distance the world's assets have, ascending; see `#noteGate`. */
  readonly #gates: number[] = [];
  /** The reused hit list and the reused per-cell seen set; see `#staleIn`. */
  readonly #stale: Array<{ cell: IResidentCell; distance: number; id: string }> = [];
  readonly #staleSeen = new Set<string>();
  /** Stale cell-assets the passes found, cumulative; see `IWorldCellsStats.refilterEntries`. */
  #staleEntries = 0;
  #generation = 0;
  #released = false;
  /**
   * The GPU-driven main pass, and whether the world asked for it. Off is byte-for-byte this class's
   * own CPU path: nothing below reads `on` except the four places the option changes what a frame
   * does. See the `gpuScene` load option and `#cullMainPass`.
   */
  readonly #gpuScene = new WorldGpuScene();
  /**
   * How the shadow cascade reaches this world's GPU keys: a level render hands its own four numbers
   * here and gets its set selected into the shadow twins, which the shadow key meshes on
   * `VIRTUAL_SHADOW_KEY_LAYER` then draw. Published on this object — the world's own root, which is
   * what `VirtualShadowNode` walks — and duck-typed there, because the world chunk and the shadow
   * node are separate and neither names the other's package types.
   *
   * Published only when `?tnShadowGpuKeys=1` asked for it, which is what makes the node's own
   * keyed path and this world's twin meshes one switch: with nothing published a level reads no
   * keys, mints no twin and submits nothing, and every picture is the one it drew before.
   */
  readonly tnShadowGpuKeys: ((renderer: IRendererLike, level: IShadowLevel) => void) | undefined =
    shadowGpuKeysRequested()
      ? (renderer: IRendererLike, level: IShadowLevel): void => {
          this.#gpuScene.dispatchShadow(renderer, level);
        }
      : undefined;
  /** Every main key this world has minted a shadow twin for, which is what a level's dispatch asks for. */
  readonly #shadowKeyNames = new Set<string>();
  readonly #gpuWanted: boolean;
  /** `gpuSceneValidate` as the load asked for it, before the query string and the environment. */
  readonly #gpuValidate: boolean | undefined;
  /**
   * Whether the GPU scene samples what it actually draws, so `TN_FRAME_BUDGET` and
   * `stats().gpuScene` can report a GPU-selected count. A validation turns it on too; the engine
   * also turns it on when the frame budget is, so a game pays nothing when neither is.
   */
  #gpuTally = false;
  readonly #occlusion: OcclusionMode;
  /** Resident placements per canonical asset, which is the capacity a key of that asset needs. */
  readonly #gpuResident = new Map<string, number>();
  /**
   * The `BundleGroup`s every recorded main batch mesh is parented under, one per shard of
   * {@link MAIN_BUNDLE_SHARDS}, and the number of times one has been re-recorded. A shard is minted by
   * the first mesh that lands in it, so a world that never dresses a mesh has no group to pay for.
   *
   * A re-record is a structural change and nothing else: see `IWorldCellsStats.bundle` and
   * {@link #bumpBundle}. Streaming, culling and LOD are GPU-side answers and never move it. A record
   * walks every draw its group holds, so a mint pays for its own shard and not the whole main pass.
   */
  readonly #bundles = new Map<number, BundleGroup>();
  #bundleRecords = 0;
  /**
   * Shards re-recorded while a compile was in flight, so they are re-recorded again once it settles.
   * Three encodes a draw only when its pipeline is ready, so a record cut during a `compileAsync`
   * silently leaves a not-yet-ready draw out, and the replay never re-checks it. Bumped from
   * {@link #bumpBundle} while {@link #compileBusy}, flushed at the top of the update that sees the
   * compile settle.
   */
  #compileSeen = 0;
  #compileBusy = false;
  readonly #recordedWhileBusy = new Set<BundleGroup>();
  /**
   * One `BundleGroup` per resident cell that has chunks attached, keyed by cell key, each with the
   * main-cull cluster whose answer decides whether it is in the frame. Minted by the first chunk a
   * cell attaches, so a world with no chunks pays nothing; see the `bundles` option.
   *
   * Per cell and not one group for the whole world: a record is fixed when it is made, so a group's
   * own answer to "is this in view" cannot change without a re-record — which is the whole cost this
   * is removing. A cell is the granularity the coarse cull already answers at, so `visible` on the
   * group is a write rather than a record. See `#cullMainPass`.
   */
  readonly #chunkBundles = new Map<
    string,
    { readonly cluster: string; readonly group: BundleGroup }
  >();
  /** How many chunk roots those groups hold, so `stats().bundle.children` costs nothing to read. */
  #chunkBundleChildren = 0;
  /** `bundles` as the load asked for it, before the query string and the environment. */
  readonly #bundlesWanted: boolean;
  /**
   * Who decided that: the load that named `bundles`, the launch that asked for `off` or `on`, or
   * nothing at all — which is what the marker reports so a run on the default is never mistaken for
   * one a flag turned off. See {@link bundlesAsked}.
   */
  readonly #bundleReason: string;
  /** `adaptiveLod` resolved against the launch override; see the option. */
  readonly #adaptiveLod: boolean;
  readonly #preserveAuthoredParts: boolean;
  /** The main pass's allowed GPU share of a frame; see the option. */
  readonly #mainGpuShare: number;
  /** The distance multiplier both selection paths are using right now. */
  #lodBias = LOD_BIAS_MIN;
  /** The clock the step cadence and the first marker line are measured from. */
  readonly #lodBiasStartedAt: number;
  /** The last time a rise or decay step ran. */
  #lodBiasStepAt: number;
  /** The last time the `TN_LOD_BIAS` line printed. */
  #lodBiasToldAt: number;
  /** The resident ring has been handed to the scene once; see `#seedGpuSources`. */
  #gpuSeeded = false;

  readonly #prewarm: CellPrewarm;
  readonly #chunks: CellChunks;
  readonly #impostorState: CellImpostors;

  private constructor(init: IWorldCellsInit) {
    super();
    this.#prewarm = new CellPrewarm({
      released: () => this.#released,
      parent: () => this.parent,
      invalidateShadows: () => this.#invalidateShadows?.(),
      backlog: () => this.#backlog(),
      keysForShadow: () => this.#keysForShadow(),
      hasShared: (key) => this.#shared.has(key),
      hasRetired: (key) => this.#retired.has(key),
      runMax: (asset) => this.#runMax.get(asset),
      residentCells: () => this.#budgets.residentCells,
      extentBounds: () => this.#extentBounds,
      smallCaster: (asset) => this.#smallCaster(asset),
      dressMesh: (shared, receiveShadow) => this.#dressMesh(shared, receiveShadow),
      receiveShadow: () => this.#receiveShadow,
      adoptGpu: (shared, asset, key, level, part) =>
        this.#adoptGpu(shared, asset, key, level, part),
      setShared: (key, shared) => this.#shared.set(key, shared),
      attach: (shared) => this.#attach(shared),
      casts: (level) => this.#casts(level),
      wideOwed: (asset, part) => this.#wideOwed(asset, part),
      followCluster: () => this.#followCluster(),
      wideShape: (asset, level, part, fallback) => this.#wideShape(asset, level, part, fallback),
    });
    this.#budgets = {
      bytes: positiveInteger(init.budgets.bytes, "budgets.bytes"),
      instances: positiveInteger(init.budgets.instances, "budgets.instances"),
      residentCells: positiveInteger(init.budgets.residentCells, "budgets.residentCells"),
    };
    this.#ring = nonNegativeInteger(init.ring, "ring");
    this.#budgetMs = admissionBudgetMs(init.admissionBudgetMs ?? DEFAULT_ADMISSION_BUDGET_MS);
    this.#coveredBudgetMs =
      init.coveredAdmissionBudgetMs === undefined
        ? this.#budgetMs * COVERED_BUDGET_SCALE
        : admissionBudgetMs(init.coveredAdmissionBudgetMs);
    this.#now = init.admissionNow ?? ((): number => globalThis.performance?.now() ?? Date.now());
    this.#follow = init.follow;
    this.#manifest = init.manifest;
    // Before the first `#canonical` read, which is the run loop below.
    this.#aliases = init.aliases;
    this.#cells = init.manifest.cells;
    const candidates = new Set<string>();
    for (const cell of this.#cells)
      for (const run of cell.runs) {
        // By the canonical id, so one key's buffer is sized for the largest run of *any* member of
        // the group and a duplicate's placements never overflow the block their canonical minted.
        const id = this.#canonical(run.asset);
        this.#runMax.set(id, Math.max(this.#runMax.get(id) ?? 0, run.count));
        // Every species the map places, however far from the follow point it starts: the far half
        // has to be able to bake it without the near ring ever bringing it in.
        if (run.count > 0) candidates.add(id);
      }

    this.#cellSize = init.manifest.cellSize;
    this.#minX = init.manifest.extent.minX;
    const { extent, terrain } = init.manifest;
    // Scatter stands on the terrain: its height range, with headroom for tall trees and props.
    this.#extentBounds = new Box3(
      new Vector3(extent.minX, terrain.heightMin - 16, extent.minZ),
      new Vector3(extent.minX + extent.sizeX, terrain.heightMax + 64, extent.minZ + extent.sizeZ),
    );
    this.#minZ = init.manifest.extent.minZ;
    this.#placements = init.placements;
    this.#lodHysteresis = init.lodHysteresis ?? 0;
    this.#placementLevels =
      this.#lodHysteresis > 0
        ? new Uint32Array(init.placements.byteLength / PLACEMENT_RECORD_BYTES)
        : undefined;
    this.#placementReach = init.placementReach;
    this.#reachRanges = init.reachRanges;
    this.#rebuildsPerUpdate = positiveInteger(init.rebuildsPerUpdate ?? 16, "rebuildsPerUpdate");
    this.#autoLodPixelsPerUnit = autoLodScale(init.autoLod);
    this.#autoLodMaxPixelError = autoLodPixelError(init.autoLod);
    // The marker is periodic, and a world's first five seconds are its own: the clock starts at the
    // world, not before it, so loading does not print a line.
    this.#mainCullToldAt = this.#now();
    this.#prefetchSeconds = init.prefetchSeconds ?? 1.5;
    this.#freshMeshesPerUpdate = positiveInteger(
      init.freshMeshesPerUpdate ?? 2,
      "freshMeshesPerUpdate",
    );
    this.#coveredFreshMeshesPerUpdate = positiveInteger(
      init.coveredFreshMeshesPerUpdate ??
        Math.min(Number.MAX_SAFE_INTEGER, this.#freshMeshesPerUpdate * COVERED_BUDGET_SCALE),
      "coveredFreshMeshesPerUpdate",
    );
    if (!(this.#prefetchSeconds >= 0) || !Number.isFinite(this.#prefetchSeconds))
      throw new Error("WorldCells prefetchSeconds must be a finite number >= 0.");
    this.#baseUrl = init.baseUrl;
    this.#logicalBase = init.logicalBase;
    this.#loader = init.assets ?? createAssetLoader();
    this.#ownsLoader = init.ownsAssets ?? init.assets === undefined;
    this.#loadModel = init.loadModel;
    this.#limiter = new ModelLoadLimiter(
      positiveInteger(init.concurrency ?? WORLD_LOAD_CONCURRENCY, "concurrency"),
    );
    this.#transparentScatter = init.transparentScatter ?? "cutout";
    this.#gpuWanted = init.gpuScene ?? gpuSceneRequested();
    const asked = bundlesAsked();
    this.#bundlesWanted = init.bundles ?? asked !== "off";
    this.#bundleReason =
      init.bundles === undefined ? (asked === "default" ? "default" : "launch") : "option";

    this.#adaptiveLod = init.adaptiveLod ?? adaptiveLodRequested();
    this.#preserveAuthoredParts = init.preserveAuthoredParts ?? false;
    this.#mainGpuShare = mainGpuShare(init.mainGpuShare);
    // The warm-up and the step cadence are the world's own clock, so loading does not count as a
    // second of adaptation and a test can drive the loop with an injected `admissionNow`.
    this.#lodBiasStartedAt = this.#now();
    this.#lodBiasStepAt = this.#lodBiasStartedAt;
    this.#lodBiasToldAt = this.#lodBiasStartedAt - LOD_BIAS_MARKER_SECONDS * 1000;
    this.#gpuValidate = init.gpuSceneValidate;
    this.#occlusion = init.occlusion ?? occlusionMode();
    this.#gpuTally = init.gpuSceneTally === true;
    this.#castShadowLevels =
      init.shadows?.cast === true
        ? positiveInteger(init.shadows.castLevels ?? 1, "shadows.castLevels")
        : 0;
    this.#receiveShadow = init.shadows?.receive === true;
    this.#smallCasterMetres = positiveMetres(
      init.shadows?.smallCasterMetres ?? SMALL_CASTER_METRES,
      "shadows.smallCasterMetres",
    );
    this.#chunkMergeMaxTriangles = positiveInteger(
      init.chunkMergeMaxTriangles ?? CHUNK_MERGE_MAX_TRIANGLES,
      "chunkMergeMaxTriangles",
    );
    // Validated and dropped. Clusters bound what a shadow level submits now, so a game that set
    // this keeps compiling and keeps loading; see the option's TSDoc.
    if (init.shadows?.castDistance !== undefined)
      positiveInteger(init.shadows.castDistance, "shadows.castDistance");
    this.#clusterSize =
      init.clusterSize === undefined
        ? this.#cellSize
        : positiveInteger(init.clusterSize, "clusterSize");
    // Rounded, so a cluster is a whole number of cells and a cell belongs to exactly one of them.
    this.#cellsPerCluster = Math.max(1, Math.round(this.#clusterSize / this.#cellSize));
    // The main cull's own grid, which is a whole number of world cells or nothing: see
    // `MAIN_CULL_SQUARE_METRES`. A `cellSize` that is not a whole multiple of 32 m — and every
    // `cellSize` larger than it — falls back to one cell, which is the cull this shipped before it
    // had a grid of its own.
    this.#cellsPerCullCell =
      MAIN_CULL_SQUARE_METRES % this.#cellSize === 0 ? MAIN_CULL_SQUARE_METRES / this.#cellSize : 1;
    this.#invalidateShadows = init.shadows?.invalidate;
    if (this.#transparentScatter !== "cutout" && this.#transparentScatter !== "blend")
      throw new Error("WorldCells transparentScatter must be 'cutout' or 'blend'.");
    this.#hasColliders = init.terrain !== false && init.createCollider !== undefined;

    this.#chunks = new CellChunks(
      init.hlod !== false,
      {
        loadModel: this.#loadModel,
        byteBudget: this.#budgets.bytes,
        logicalBase: this.#logicalBase,
        receiveShadow: this.#receiveShadow,
        placementReach: this.#placementReach,
        autoLodMaxPixelError: this.#autoLodMaxPixelError,
        chunkMergeMaxTriangles: this.#chunkMergeMaxTriangles,
        castShadowLevels: this.#castShadowLevels,
        bundlesWanted: this.#bundlesWanted,
      },
      {
        disposeProxyModel: (state) => {
          if (
            this.#loadModel !== undefined ||
            state.retainedPaths.every((path) => (this.#modelPaths.get(path) ?? 0) <= 1)
          )
            this.#failures += this.#disposeLoaded(state.model);
        },
        disposeLoaded: (model) => this.#disposeLoaded(model),
        releaseModelPaths: (paths) => this.#releaseModelPaths(paths),
        retainModelPaths: (paths, into) => this.#retainModelPaths(paths, into),
        addFailures: (count) => {
          this.#failures += count;
        },
        sourceBytes: () => this.#bytes + this.#impostorState.farBytes,
        load: (path, wanted) => this.#limiter.load(() => this.#model(path), wanted),
        cellLive: (cell, generation) => this.#cellLive(cell, generation),
        add: (object) => this.add(object),
        intersectsObject: (mesh) => _cullFrustum.intersectsObject(mesh),
        gpuSceneOn: () => this.#gpuScene.on,
        asset: (id) => this.#assets.get(this.#canonical(id)),
        invalidateBundles: (key) => {
          for (const group of this.#bundles.values()) this.#bumpBundle(group);
          const chunks = this.#chunkBundles.get(key)?.group;
          if (chunks !== undefined) this.#bumpBundle(chunks);
        },
        worldSphere: (bounds) => worldSphere(bounds, this),
        reportCellFailure: (stage, key, paths, error) =>
          this.#reportCellFailure(stage, key, paths, error),
        parent: () => this.parent,
        prepareCompile: (root, camera, renderer) => {
          let scene: Object3D = this;
          while (scene.parent !== null) scene = scene.parent;
          if (Reflect.get(scene, "isScene") !== true) return;
          return () => renderer.compileAsync(root, camera, scene);
        },
        compileChunk: (renderer, chunk, camera) => renderer.compileAsync(chunk, camera, this),
        addChunk: (cell, object) => this.#addChunk(cell, object),
        publishChunkBounds: (cell, box, proxies) => {
          if (box !== undefined) {
            if (proxies > 0) this.#shadowRecordsMoved(box);
            // A bundled chunk is drawn or not by its cell's record, and that record is answered from
            // the cell's cull volume — which is built from the cell's placements. A chunk is a cell's
            // other half, so a cell holding chunks and no scatter would have an empty volume and never
            // be drawn at all. Widened here rather than shrunk on eviction: the volume outlives one cell
            // whenever a neighbour still holds the cluster, and a stale box only ever shows a cell that
            // is there.
            if (this.#bundlesWanted)
              this.#cullCells
                .get(clusterOf(cell.x, cell.z, this.#cellsPerCullCell))
                ?.box.union(box);
          }
        },
      },
    );
    this.#impostorState = new CellImpostors(
      {
        enabled: init.impostors ?? false,
        candidates: [...candidates],
        cells: this.#cells,
        manifest: this.#manifest,
        placements: this.#placements,
        transparentScatter: this.#transparentScatter,
        autoLodPixelsPerUnit: this.#autoLodPixelsPerUnit,
        castShadowLevels: this.#castShadowLevels,
        budgets: this.#budgets,
      },
      {
        released: () => this.#released,
        renderer: () => this.#chunks.renderer,
        asset: (id) => this.#assets.get(id),
        hasAsset: (id) => this.#assets.has(id),
        assets: () => this.#assets.values(),
        nearWorkPending: () =>
          this.#jobs.length > 0 ||
          this.#limiter.inFlight > 0 ||
          this.#limiter.queued > 0 ||
          this.#prewarm.queued > 0,
        newAsset: (id, definition) => this.#newAsset(id, definition),
        startAssetLoad: (asset) => this.#startAssetLoad(asset),
        release: (id) => this.#release(id),
        noteGate: (gate) => this.#noteGate(gate),
        retargetWideCasters: (asset) => this.#retargetWideCasters(asset),
        terminalLevelReady: (asset) => {
          this.#prewarm.queuePrewarm(asset);
          for (const cell of [...this.#resident.values()]) {
            for (const run of cell.cell.runs) {
              if (this.#canonical(run.asset) === asset.id) this.#queueBuild(asset, cell, run, true);
            }
          }
        },
        residentCell: (key) => this.#resident.get(key),
        canonical: (id) => this.#canonical(id),
        shadowRecordsMoved: () => this.#shadowRecordsMoved(),
        residency: () => ({
          instances: this.#instances,
          bytes: this.#bytes,
          hlodBytes: this.#chunks.bytes,
        }),
        add: (object) => {
          this.add(object);
        },
        remove: (object) => {
          this.remove(object);
        },
        addFailure: () => {
          this.#failures += 1;
        },
        markReleasedPart: (part) => {
          releasedParts.add(part);
        },
      },
    );
    if (init.terrain === false) return;
    // Terrain can reach further than the props do, so its radius is its own option; the collider
    // radius stays on the ring, which is how far a player can actually walk into this world.
    const streamRadius = nonNegativeInteger(
      init.terrain?.streamRadius ?? this.#ring,
      "terrain.streamRadius",
    );
    const colliderRadius = nonNegativeInteger(
      init.terrain?.colliderRadius ?? this.#ring,
      "terrain.colliderRadius",
    );
    const tileCount = (2 * streamRadius + 1) ** 2;
    this.#terrain = new TerrainTiles({
      ...(init.createCollider === undefined
        ? {}
        : { colliderRadius, createCollider: init.createCollider }),
      receiveShadow: init.shadows?.receive === true,
      ...(init.terrain?.lodDistances === undefined
        ? {}
        : { lodDistances: init.terrain.lodDistances }),
      ...(init.terrain?.lodFactors === undefined ? {} : { lodFactors: init.terrain.lodFactors }),
      ...(init.terrain?.skirtDepth === undefined ? {} : { skirtDepth: init.terrain.skirtDepth }),
      // Sized from the terrain stream radius: the wanted square fits the tile budget. ponytail: no
      // terrain byte cap (a tile's bytes are deterministic from the radius, and the cells own the
      // memory budget); give `TerrainTiles` its own byte budget when terrain is not radius-bounded.
      // A tile that still cannot fit is caught in `update` and reported as pressure.
      residentByteBudget: Number.MAX_SAFE_INTEGER,
      residentTileBudget: tileCount,
      sampleHeight: heightSamplerFromHeightmap(
        init.manifest.terrain,
        init.manifest.extent,
        init.heightmap,
      ),
      streamRadius,
      surface: init.surface,
      tileResolution: init.terrain?.tileResolution ?? DEFAULT_TILE_RESOLUTION,
      tileSize: init.terrain?.tileSize ?? this.#cellSize,
    });
    this.add(this.#terrain);
  }

  static async load(options: IWorldCellsLoadOptions): Promise<WorldCells> {
    if (options.preserveAuthoredParts && options.impostors)
      throw new Error("WorldCells preserveAuthoredParts requires impostors:false.");
    if (
      options.lodHysteresis !== undefined &&
      (!Number.isFinite(options.lodHysteresis) ||
        options.lodHysteresis < 0 ||
        options.lodHysteresis >= 1 ||
        options.gpuScene !== false ||
        options.impostors === true)
    )
      throw new Error(
        "WorldCells lodHysteresis must be in [0, 1) with gpuScene:false and impostors:false.",
      );
    const assets = options.assets ?? createAssetLoader();
    const baseUrl = options.url.slice(0, options.url.lastIndexOf("/") + 1);
    // Logical paths, which is what the loader keys its manifest by: the authored name with no
    // leading slash, and the directory the manifest itself sits in as their base.
    const manifestPath = options.url.replace(/^\//u, "");
    const logicalBase = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
    const manifest =
      options.data?.manifest ??
      (await loadLogical(
        assets,
        manifestPath,
        async (url) => (await (await fetchOk(url)).json()) as IWorldPackage,
      ));
    const placements =
      options.data?.placements ??
      (await loadLogical(assets, resolveRelative(logicalBase, manifest.placements), async (url) =>
        (await fetchOk(url)).arrayBuffer(),
      ));
    const heightmap =
      options.terrain === false
        ? new Uint16Array(0)
        : (options.data?.heightmap ??
          (await loadLogical(
            assets,
            resolveRelative(logicalBase, manifest.terrain.heightmap),
            loadWorldHeightmap,
          )));
    const validation = validateWorldPackage(manifest, {
      ...(options.terrain === false ? {} : { heightmapByteLength: heightmap.length * 2 }),
      placementsByteLength: placements.byteLength,
    });
    if (!validation.ok) {
      const codes = new Set<string>();
      const details: string[] = [];
      for (const entry of validation.errors) {
        codes.add(entry.code);
        details.push(`${entry.path} ${entry.message}`);
      }
      const error = new Error(
        `World package '${options.url}' failed validation: ${[...codes].join(", ")}. ${details.join(" ")}`,
      );
      error.name = "WorldPackageValidationError";
      throw error;
    }
    const reach = options.placementReach;
    if (reach !== undefined) {
      if (
        !(reach instanceof Float32Array) ||
        reach.length !== placements.byteLength / PLACEMENT_RECORD_BYTES
      )
        throw new Error("WorldCells placementReach length must match the placement record count.");
    }
    // One line, at the one moment the whole package is known: how many assets it names and how many
    // of them are one model under several names. `canonical` equal to `assets` is a package with no
    // duplicates, which is most of them.
    const aliases = await assetAliases(assets, manifest, logicalBase);
    const reachRanges = new Map<
      IWorldCell,
      Map<string, { min: number; max: number; minY: number; maxY: number }>
    >();
    if (reach !== undefined) {
      // Cap each load-time unit, then yield when the measured slice budget is spent.
      // One host turn per cheap chunk delays registration behind hundreds of loading frames.
      function* validationChunks() {
        for (let start = 0; start < (reach as Float32Array).length; start += 512) yield start;
      }
      await addInSlices(
        validationChunks(),
        (start) => {
          for (let index = start; index < Math.min(start + 512, reach.length); index++) {
            const value = reach[index] as number;
            if (!(value >= 0) || (value !== Number.POSITIVE_INFINITY && !Number.isFinite(value)))
              throw new Error(
                "WorldCells placementReach values must be nonnegative metres or Infinity.",
              );
          }
        },
        { marker: false },
      );
      // Start indexing in a fresh host turn instead of combining two separate slice budgets.
      await yieldToHost();
      const records = new Float32Array(placements);
      function* chunks() {
        for (const cell of manifest.cells)
          for (const run of cell.runs)
            for (let start = run.offset; start < run.offset + run.count; start += 512)
              yield { cell, run, start, end: Math.min(start + 512, run.offset + run.count) };
      }
      await addInSlices(
        chunks(),
        ({ cell, run, start, end }) => {
          const id = aliases.get(run.asset) ?? run.asset;
          const ranges =
            reachRanges.get(cell) ??
            new Map<string, { min: number; max: number; minY: number; maxY: number }>();
          const range = ranges.get(id) ?? {
            min: Number.POSITIVE_INFINITY,
            max: 0,
            minY: Number.POSITIVE_INFINITY,
            maxY: Number.NEGATIVE_INFINITY,
          };
          for (let index = start; index < end; index++) {
            const value = reach[index] as number;
            if (value !== Number.POSITIVE_INFINITY) {
              range.min = Math.min(range.min, value);
              range.max = Math.max(range.max, value);
            }
            const y = records[index * PLACEMENT_RECORD_FLOATS + 1] as number;
            range.minY = Math.min(range.minY, y);
            range.maxY = Math.max(range.maxY, y);
          }
          ranges.set(id, range);
          reachRanges.set(cell, ranges);
        },
        { marker: false },
      );
    }
    const named = Object.keys(manifest.assets).length;
    console.info(
      `TN_WORLD_ASSET_ALIAS assets=${String(named)} canonical=${String(named - aliases.size)}`,
    );
    return new WorldCells({
      ...options,
      aliases,
      reachRanges,
      assets,
      baseUrl,
      heightmap,
      logicalBase,
      manifest,
      // The loader made here when the game supplied none is this world's to release; one the game
      // passed in is the game's, and `#releaseModelPaths` never touches its cache.
      ownsAssets: options.assets === undefined,
      placements,
    });
  }

  get released(): boolean {
    return this.#released;
  }

  get warmupNodes(): readonly unknown[] {
    return this.#terrain?.warmupNodes ?? [];
  }

  /**
   * Resolves once every minted batch has been drawn at least once, main and shadow context.
   *
   * The loading gate a game with a loading screen waits on, so the shader builds the prewarm exists
   * to move happen behind it instead of in the first seconds of play. It counts updates the world
   * was in a scene for, because a batch added while the world is not in a scene is projected by
   * nothing and builds nothing. `dispose` settles it too: a world torn down mid-load must not leave
   * a game awaiting it forever.
   */
  get prewarmed(): Promise<void> {
    return this.#prewarm.prewarmed;
  }

  /**
   * Per-frame residency step; call it wherever `TerrainTiles.process` is called.
   *
   * Reads the follow target, keeps the in-ring cells, evicts cells beyond the hysteresis ring, and
   * spends one admission budget on everything the ring newly wants: cell-asset batches, terrain
   * tiles, colliders and the `maxDistance`/`lods` refilters the follow point has moved far enough to
   * have changed. Whatever does not fit waits for the next call — nothing is dropped, and
   * `stats().admission` is the honest report of what is waiting. A terrain budget throw is caught
   * and counted, and so is a teardown that throws while releasing what left; `failures` carries
   * both. Every other error, the game's included, escapes.
   *
   * The residency pass itself is skipped while the follow point has moved less than half a metre
   * since the last one and nothing is pending (a load, a cell build, a deferred terrain admission, a
   * prewarm mint or a shadow level not yet told), because the pass would re-derive the set the
   * world already holds. The drain, the prewarm, the invalidation and the main cull below it run
   * every time.
   *
   * `camera` is the frame's render camera, which the engine's render-cadence dispatch hands over
   * because it is the one this world draws with. A game that drives this world itself can pass it,
   * and a game that does not keeps every resident record drawn.
   */
  update(renderer?: IRendererLike, camera?: Camera): void {
    if (this.#released) return;
    // Kept for the chunk warm-up below: a chunk is loaded asynchronously and compiled when it
    // arrives, which can be a frame or a loading screen after the frame that gave us these.
    if (renderer !== undefined) this.#chunks.renderer = renderer;
    if (camera !== undefined) this.#chunks.camera = camera;
    // A bundle recorded while a compile was in flight left out every draw whose pipeline was not
    // ready, and the replay never re-checks; re-record those shards now that it has settled. Set
    // `#compileBusy` first, so this flush's own bumps are not added back to the set.
    const compiles = renderer?.compileCount ?? 0;
    const busy = renderer?.compiling === true || compiles !== this.#compileSeen;
    this.#compileSeen = compiles;
    this.#compileBusy = busy;
    if (!busy && this.#recordedWhileBusy.size > 0) {
      const recorded = [...this.#recordedWhileBusy];
      this.#recordedWhileBusy.clear();
      for (const group of recorded) if (group.parent !== null) this.#bumpBundle(group);
    }
    // The adaptive LOD bias, before the dispatch below reads the gates it scales.
    this.#adaptLodBias(renderer);
    // The first frame that hands over a renderer is the only one that can answer whether this
    // backend can run the GPU scene, and it prints its answer once: `enable` reports, then returns
    // early for the rest of the world's life.
    if (renderer !== undefined)
      this.#gpuScene.enable(
        renderer,
        this.#gpuWanted,
        this.#gpuValidate ?? gpuSceneValidationRequested(),
        this.#gpuTally,
        this.#occlusion,
      );
    // The one check the scene cannot make for itself, and the only one that reads this class's own
    // numbers rather than the scene's tables: a dressed main mesh's own indirect record, against the
    // instances this path composes for the key that mesh is named. Registered before the keys are
    // seeded, because the first check is a whole ring's worth of meshes and every one of them is
    // already dressed by the time it runs.
    this.#gpuScene.drawsFrom(() => this.#gpuDraws());
    // The scene coming up under a ring that was already built: every placement swapped in before it
    // was on has no source record, and the dispatch draws nothing it is not given. One rebuild of the
    // resident ring puts them in, through the same build every first-seen asset takes.
    if (this.#gpuScene.on && this.#gpuSeeded === false) {
      this.#gpuSeeded = true;
      this.#seedGpuSources();
      this.#seedGpuKeys();
      // After the keys, because that is the only point at which the marker can say how many of the
      // world's main meshes are dressed: printed at enable it would read the ring as it was a frame
      // earlier, which is the state the run that found this was in.
      this.#gpuScene.announce(this.#chunks.renderer as IRendererLike, this.#gpuCensus());
    }
    // A new upload epoch, so no batch's pending span outlives the render that consumed it. See
    // `SharedBatch#touched`.
    advanceWriteEpoch();
    const x = this.#follow.position.x;
    const z = this.#follow.position.z;
    // Terrain admits first, and a tile is one unit of several milliseconds, so after a jump (a
    // teleport, a review camera) the 17 x 17 terrain ring spent the whole allowance every frame for
    // seconds and the prop queue got nothing: the forest never built where the camera landed. While
    // props are queued the terrain is held to half, and the props get whatever it left.
    const budgetMs = this.#covered ? this.#coveredBudgetMs : this.#budgetMs;
    const terrainMs = this.#jobs.length > 0 ? budgetMs / 2 : budgetMs;
    const budget = new AdmissionBudget(terrainMs, this.#now);
    this.#freshThisUpdate = 0;
    this.#meshStalled = false;
    // The residency pass is a function of the follow point, so a follow point that has not moved
    // and a world with nothing pending has the same answer as the last update: hundreds of cells
    // walked and re-sorted, every resident cell refiltered, every terrain tile re-levelled, all of
    // it to reach the set it already holds. Skipped while both hold. A move, a load, a build, a
    // deferred admission or a shadow level not yet told runs the pass exactly as before.
    if (this.#residencyStale(x, z)) {
      this.#residencyPoint.set(x, this.#followY(), z);
      try {
        this.#terrain?.follow({ x, z }, budget);
        this.#terrain?.process(renderer);
      } catch (error) {
        if (!(error instanceof TerrainTileBudgetError)) throw error;
        this.#pressure.bytes += 1;
      }
      const ahead = this.#ahead(x, z);
      this.#updateResidency(
        {
          x: Math.floor((ahead.x - this.#minX) / this.#cellSize),
          z: Math.floor((ahead.z - this.#minZ) / this.#cellSize),
        },
        ahead.x,
        ahead.z,
      );
      // The refilter is a scan of every resident cell, so it runs on its own cadence rather than
      // with the residency pass above; see `#refilterStale` and `LEVEL_REFILTER_STEP_METRES`.
      // The GPU scene selects the level per instance on the dispatch, but a build still culls at
      // `maxDistance` from where it ran, and a placement it culled has no source record to select:
      // with the pass skipped, ground cover built from a cell's far side never appeared as the
      // camera walked in. With the scene on, `#staleIn` reads the cull gate alone.
      if (this.#refilterStale(x, z)) {
        this.#refilterPoint.set(x, this.#followY(), z);
        this.#refilterEpoch = this.#residencyEpoch;
        this.#updateMaxDistance(x, z);
      }
    } else if (
      // A blend in flight is not a settled ring, and the blend is advanced by `process` alone —
      // `follow` only re-levels tiles. A follow point standing still used to skip both, so a
      // three-frame tile morph froze on its first frame until the player moved again. Only the
      // transition frames pay it: `blendingTiles` is 0 the rest of the time.
      (this.#terrain?.blendingTiles ?? 0) > 0
    ) {
      this.#terrain?.process(renderer);
    }
    const props = new AdmissionBudget(budgetMs - Math.min(budget.spentMs, terrainMs), this.#now);
    this.#drain(props);
    // The prewarm runs outside the admission budget on purpose — it is not residency, it is the
    // shader builds the residency is about to need, and the allowance that spreads those is
    // `PREWARM_PER_UPDATE`.
    this.#prewarm.drainPrewarm();
    // One bake view per render update, after the prewarm so its own atlas allocation never delays a
    // node build the walk is waiting on, and before the levels are told so a level the bake just
    // appended is in this frame's window.
    this.#impostorState.stepImpostor(renderer);
    // After the bake handoff, so a wide block it deferred to this frame's exhausted allowance is
    // claimed now; a no-op on every frame with nothing waiting.
    this.#impostorState.retryWide();
    // After the near work, so a species no resident run has asked for still bakes and reaches the
    // far mesh without the camera ever traversing its cell. Bounded to one asset per idle frame.
    this.#impostorState.pumpFarAcquisition();
    // After the drain, so the levels are told about this update's records and not the last one's.
    this.#tellShadows();
    // After the drain too, so a record admitted this update is in the window the camera draws and
    // not one frame behind it.
    this.#chunks.restoreSources();
    this.#cullMainPass(camera);
    // With it, because it reads the drain's own answer: a caster whose main counterpart is not
    // drawable this frame must not cast before the levels render this frame's maps.
    this.#publishCasterAdmission();
    // After main publication/culling: an exclusive source key stays fully resident, so returning
    // near detail never waits for admission or an instance allocation. Proxy loads/staging alone
    // consume admission units; the synchronous visibility commit always protects the current view.
    this.#chunks.stepCellProxies(
      this.#resident.values(),
      this.matrixWorld,
      props,
      renderer,
      camera,
    );
    this.#reportMainCull();
    this.#admission = {
      backlog: this.#backlog(),
      deferred: this.#jobs.length,
      spentMs: budget.spentMs + props.spentMs,
    };
    // After this frame's admissions, so a region admitted by this update answers its waiters in it.
    this.#settleSpawnWaiters();
  }

  /**
   * Narrow every main batch's draw window to the world-grid squares `camera`'s frustum covers, once
   * per frame, for the whole set at once.
   *
   * This used to be each main mesh's own `onBeforeRender`, which three never calls for an invisible
   * mesh — so the moment a batch that draws nothing was hidden, the one thing that could show it
   * again when the camera turned back was gone with it, and the world lost its trees for good. The
   * decision therefore moved to the frame's own driver: the render-cadence compute dispatch, which
   * the engine already runs once per rendered frame — on the same readiness gate residency itself
   * sits behind, so a frame that skips this skipped the world's records too — and which now hands the
   * render camera to the world, so it reaches every main mesh whether it is drawn or not.
   *
   * The camera rules are the ones the hook had, and they are the whole of what decides a window:
   *
   * - **An orthographic camera never repacks.** A virtual-shadow level's camera is a
   *   `DirectionalLightShadow`'s own, which three makes orthographic, so a level's window — one shadow
   *   slice of the ring, deliberately not the main view's — can never overwrite the main pass's. A
   *   game whose own camera is orthographic keeps the old behaviour: everything resident is drawn, and
   *   nothing pops. That is a lost saving, never a wrong picture.
   * - **The render camera is the one that decides.** The engine dispatches this with the camera it
   *   is about to draw the main pass with, so the second-perspective-camera race the hook had to
   *   arbitrate per mesh cannot arise: a mirror or a minimap is drawn with its own camera and is
   *   served the main view's window, which is the honest trade for a world with one main view.
   * - **A set that did not change touches nothing.** The frustum, the visible cells and the epoch
   *   are the frame's, derived once for the whole pass; a batch whose records have not moved since it
   *   packed at that epoch compares two integers and returns. A camera at rest costs one frustum and
   *   one test per resident visibility cell a frame, and nothing at all per mesh.
   */
  #cullMainPass(camera: Camera | undefined): void {
    if (camera === undefined || (camera as ICamera).isOrthographicCamera === true) return;
    this.#mainCullFrustums += 1;
    const frustum = _cullFrustum.setFromProjectionMatrix(
      _cullProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    // The visible visibility cells, for the whole pass, into a set that is reused and compared
    // rather than allocated: two sets trading places, so a settled camera allocates nothing at all.
    const next = this.#cullScratch;
    next.clear();
    for (const [cell, entry] of this.#cullCells) {
      // An occupied cell whose placements have not been decoded yet holds nothing to draw, and its
      // Y range is still empty — a volume that cannot be tested against ±Infinity is not one this
      // frame's answer may rest on.
      if (entry.box.isEmpty() === false && frustum.intersectsBox(entry.box)) next.add(cell);
    }
    if (!sameSquares(next, this.#visibleSquares)) {
      this.#visibleEpoch += 1;
      const was = this.#visibleSquares;
      this.#visibleSquares = next;
      this.#cullScratch = was;
      this.#cullScratch.clear();
    }
    // A chunk's record is frozen, so its cell's answer is the only thing that can take it out of the
    // frame without re-recording it: a write per resident cell that has chunks, at the same
    // granularity every other coarse gate in this pass uses. See the `bundles` option.
    for (const entry of this.#chunkBundles.values()) {
      const visible = this.#visibleSquares.has(entry.cluster);
      if (entry.group.visible !== visible) entry.group.visible = visible;
    }
    const gpu = this.#gpuScene;
    const dressed: Array<{ asset: string; shared: SharedBatch }> = [];
    const version = gpu.version;
    for (const shared of [...this.#shared.values()]) {
      if (shared.role !== "main") continue;
      // A dressed batch draws from the GPU scene's own buffers, so the frame's per-instance answer is
      // the dispatch's and this mesh's own window would be a second, stale copy of it.
      if (gpu.on && shared.gpu !== undefined) {
        this.#dressGpu(shared, shared.gpu);
        // A bundled mesh is in a render list three fixed when it recorded the bundle, and the
        // dispatch has already culled per instance: there is nothing coarse left to hide, and a
        // `visible` written here is one the replay never reads. See `#bundleIn`.
        if (shared.bundled === false) dressed.push({ asset: shared.gpu.asset, shared });
        continue;
      }
      // A batch the GPU scene does not own, and every one of a world without it: its own window is
      // the CPU path's answer, and it is a per-frame answer a frozen render list never re-reads. So
      // the record answers the gate instead of the gate writing `visible` into it — a batch the gate
      // shows joins, one it hides leaves, and a window that moved is one more record, because the
      // record holds the layout the move made. The same trade a cell's chunk record makes, at the
      // granularity this gate already uses. See `#bundleIn`.
      const outcome = shared.cullFrom(this.#visibleSquares, this.#visibleEpoch);
      this.#recordCpuMain(shared, outcome);
      if (outcome === "settled") continue;
      this.#mainCullWindows += 1;
      if (outcome === "repacked") {
        this.#mainCullRepacks += 1;
        this.#mainCullPacks += 1;
      }
    }
    // A regrow late in the loop replaces the scene's `drawn` — and, a non-grouped key, its `args` —
    // after an earlier mesh in the same loop was dressed against the generation before it, so that
    // mesh would read a buffer the dispatch no longer writes for one frame. One more pass over the
    // same settled set, only when the scene changed under the first, rebinds every mesh to the final
    // buffers. Registration is idempotent and every key is already minted and sized, so this pass
    // mints nothing and cannot grow the scene again.
    if (gpu.on && gpu.version !== version) {
      for (const shared of [...this.#shared.values()])
        if (shared.role === "main" && shared.gpu !== undefined) this.#dressGpu(shared, shared.gpu);
      // And every shadow key, for the same reason: minting one grew the twin buffers every other
      // key was dressed against, so a sibling dressed earlier in the loop above is holding the
      // generation the dispatch replaced. The main key's own dress brings its twin with it; this is
      // what closes the seam for the keys whose main key was dressed before the grow.
      for (const shared of [...this.#shared.values()])
        if (shared.role === "key")
          this.#dressShadowKey(shared, shared.mesh.name.slice(0, -GPU_KEY_SUFFIX.length));
    }
    // After every key has been dressed, so the asset's answer is the union across its levels and
    // parts.
    this.#applyGpuMain(dressed);
    // After the coarse gate, and only for the main camera: an orthographic one — every shadow
    // level's own — returned at the top, so a level's render never dispatches over the main pass's
    // compaction.
    if (gpu.on) gpu.dispatch(this.#chunks.renderer as IRendererLike, camera);
  }

  /**
   * The coarse gate for the GPU-dressed main pass, computed per asset and reused across every level
   * and part of it.
   *
   * A key's own CPU squares are the level the follow point picked when it built them, and the
   * dispatch re-picks the level from the camera every frame — so a key the CPU never gave a cell to
   * can be exactly the one the dispatch draws, and a per-key answer hid it: a tree walked into at a
   * level it was not built at disappeared. One conservative answer per asset — any key holds a
   * visible cell, or still owes its prewarm draw — is what shows all of them, and the indirect
   * record decides what each one actually draws.
   */
  #applyGpuMain(dressed: readonly { asset: string; shared: SharedBatch }[]): void {
    const shown = new Map<string, boolean>();
    for (const { asset, shared } of dressed) {
      if (shown.get(asset) === true || shared.seenIn(this.#visibleSquares)) shown.set(asset, true);
      else if (shown.has(asset) === false) shown.set(asset, false);
    }
    for (const { asset, shared } of dressed) shared.applyGpuVisible(shown.get(asset) === true);
  }

  /** Borrowed scratch box: consume its transformed volume before the next bounds query. */
  #boundsAt(bounds: IWorldAsset["bounds"], matrix: Matrix4): Box3 {
    this.#recordBounds.min.fromArray(bounds.min);
    this.#recordBounds.max.fromArray(bounds.max);
    return this.#recordBounds.applyMatrix4(matrix);
  }

  /**
   * The one volume per resident visibility cell, shared by every key: its own XZ footprint, and in Y
   * the range its resident placements actually reach once their assets' own bounds are added to them,
   * padded by `MAIN_CULL_PAD_METRES`.
   *
   * It is derived here, on admission, and never a frame — a volume walked every frame to answer a
   * question about placements that never move is a frame's work for an admission's answer.
   *
   * It is deliberately not per key. Every key drew the same cell set, so deriving it per key meant
   * ~230 frusta and ~230 sets a frame to learn the same answer; one volume per cell is what makes the
   * pass O(cells) instead of O(keys × cells).
   *
   * The Y is what makes it a volume rather than a slab. It used to be the whole terrain height range
   * widened by the tallest asset bound in the world — ~100 m of Y on a map with a 10 m relief, which
   * made every cell's bounding sphere a ~90 m radius that a view beside the world still cleared, and
   * handed the vertex stage the whole ring. This is per placement instead: a sub-square of flat
   * ground with ferns on it is the height of its ferns.
   */

  #cullResident(cell: IWorldCell): void {
    const per = this.#cellsPerCullCell;
    const side = per * this.#cellSize;
    const first = Math.floor(cell.x / per);
    const firstZ = Math.floor(cell.z / per);
    const name = clusterOf(cell.x, cell.z, per);
    let entry = this.#cullCells.get(name);
    if (entry === undefined) {
      // XZ from the grid, padded, and an empty Y: this cell's own placements are unioned in below,
      // and a cell holding none of them yet is never visible rather than visible by its footprint.
      const box = new Box3(
        new Vector3(
          this.#minX + first * side - MAIN_CULL_PAD_METRES,
          Number.POSITIVE_INFINITY,
          this.#minZ + firstZ * side - MAIN_CULL_PAD_METRES,
        ),
        new Vector3(
          this.#minX + (first + 1) * side + MAIN_CULL_PAD_METRES,
          Number.NEGATIVE_INFINITY,
          this.#minZ + (firstZ + 1) * side + MAIN_CULL_PAD_METRES,
        ),
      );
      entry = { box, cells: 0 };
      this.#cullCells.set(name, entry);
    }
    entry.cells += 1;
    const box = entry.box;
    for (const run of cell.runs) {
      const bounds = this.#manifest.assets[this.#canonical(run.asset)]?.bounds;
      if (bounds === undefined || run.count === 0) continue;
      const records = cellPlacements(this.#placements, run);
      for (let index = 0; index < run.count; index += 1) {
        const at = index * PLACEMENT_RECORD_FLOATS;
        // The placement, widened by its own asset's bounds at the scale it is drawn at, and by the
        // pad — a union, so the pad is counted once however many placements there are.
        const scale = records[at + 7] as number;
        this.#position.fromArray(records, at);
        this.#rotation.fromArray(records, at + 3);
        this.#scale.setScalar(scale);
        this.#matrix.compose(this.#position, this.#rotation, this.#scale);
        box.union(
          this.#boundsAt(bounds, this.#matrix).expandByScalar(
            MAIN_CULL_PAD_METRES * Math.max(1, Math.abs(scale)),
          ),
        );
      }
    }
  }

  /**
   * Drop the visibility cell an evicted cell sat in once nothing resident is left in it. Records are
   * cleared before this runs, so a batch can never be holding a cell the cull no longer knows: an
   * unknown cell is not in the visible set, and that would be a tree nobody draws.
   *
   * The box goes with it, so a cell that comes back derives its volume again — which is what keeps a
   * released asset's height out of a cell that no longer holds it.
   */
  #cullEvicted(cell: IResidentCell): void {
    const name = clusterOf(cell.x, cell.z, this.#cellsPerCullCell);
    const entry = this.#cullCells.get(name);
    if (entry === undefined) return;
    entry.cells -= 1;
    if (entry.cells <= 0) this.#cullCells.delete(name);
  }

  /**
   * Does this update have to run the residency pass, or is the follow point still inside the half
   * metre it last moved less than and the world holding still?
   *
   * "Still" is every kind of work the pass exists to hand on: a model load in flight or queued, a
   * cell build in `#jobs` (which is also what queues refilters), a prewarm mint owed or in flight, a
   * terrain admission or collider the admission budget refused, and a companion that has not been
   * rebuilt since the follow point last moved. A world standing still on a loaded ring answers none
   * of those, so the pass is skipped; the first update after anything changes is a full pass again.
   */
  #residencyStale(x: number, z: number): boolean {
    if (
      Math.hypot(
        x - this.#residencyPoint.x,
        this.#followY() - this.#residencyPoint.y,
        z - this.#residencyPoint.z,
      ) >= SETTLED_FOLLOW_METRES
    )
      return true;
    return (
      this.#limiter.inFlight > 0 ||
      this.#limiter.queued > 0 ||
      this.#jobs.length > 0 ||
      this.#refilterOwed ||
      this.#prewarm.queued > 0 ||
      this.#prewarm.pending > 0 ||
      this.#shadowMoved === true ||
      (this.#terrain?.deferredAdmissions ?? 0) > 0
    );
  }

  /**
   * Does this update have to run the `maxDistance`/`lods` refilter pass?
   *
   * Three things, and the pass runs when any of them holds: the follow point has moved
   * `LEVEL_REFILTER_STEP_METRES` since the last one, so a walk re-derives its brackets every two
   * metres instead of every half; residency changed, because a cell that arrived or left is the
   * bracket the pass is about; and the last pass found more stale cell-assets than
   * `rebuildsPerUpdate` could queue, so the ones it could not queue are still owed and a still
   * follow point has to keep coming back for them. Anything else is the same brackets, so the pass
   * is skipped and the world does nothing for that update.
   */
  #followY(): number {
    return this.#placementReach === undefined ? 0 : (this.#follow.position.y ?? 0);
  }

  #refilterStepMetres(): number {
    return this.#placementReach === undefined ? LEVEL_REFILTER_STEP_METRES : 0.75;
  }

  #refilterStale(x: number, z: number): boolean {
    if (this.#refilterOwed) return true;
    if (this.#refilterEpoch !== this.#residencyEpoch) return true;
    return (
      Math.hypot(
        x - this.#refilterPoint.x,
        this.#followY() - this.#refilterPoint.y,
        z - this.#refilterPoint.z,
      ) >= this.#refilterStepMetres()
    );
  }

  /**
   * The render-cadence dispatch. The engine hands the frame's render camera over, and this world's
   * main windows follow it; see {@link #cullMainPass} for why the decision is not the meshes' own.
   */
  /** New batch meshes this update may create: scaled while the startup cover hides the world. */
  #freshAllowance(): number {
    return this.#covered ? this.#coveredFreshMeshesPerUpdate : this.#freshMeshesPerUpdate;
  }

  process(renderer?: IRendererLike, camera?: Camera, covered = false): void {
    this.#covered = covered;
    try {
      this.update(renderer, camera);
    } finally {
      this.#covered = false;
    }
  }

  /**
   * The adaptive LOD bias control loop. Reads the main pass's smoothed GPU time from the renderer
   * and, once per `LOD_BIAS_STEP_SECONDS`, raises the shared bias while that pass is over its share
   * of the frame and decays it back toward 1 while it is comfortably under; between the two it
   * holds, which is the band that keeps a level sitting on the budget from oscillating. A window with
   * no fresh sample is a hold, never a rise on a stale number, and a rise needs the world itself to be
   * the thing being drawn — see {@link #biasOverBudget}, which is also what replaced the warmup
   * seconds. The decay is never gated: a world that can afford its main pass gives the bias back.
   */
  #adaptLodBias(renderer: IRendererLike | undefined): void {
    if (this.#adaptiveLod === false) {
      // Byte-identical to the pre-bias selection: the multiplier is pinned at 1 every frame.
      this.#applyLodBias(LOD_BIAS_MIN);
      return;
    }
    const now = this.#now();
    if (now - this.#lodBiasStepAt < LOD_BIAS_STEP_SECONDS * 1000) return;
    const source = renderer ?? this.#chunks.renderer;
    // The frame the budget is a share of: the game's resolved target, 60 fps until one is known.
    // Never the frame just measured — an expensive pass makes its own frame long and would pass its
    // own test, and a fast one shrank the share until a 3 ms pass coarsened a world running at
    // 400 fps against a 120 fps target (PRD-478).
    const target = source?.targetFps?.();
    const frameMs = 1000 / (target !== undefined && target > 0 ? target : DEFAULT_TARGET_FPS);
    const gpuMs = source?.gpuMainMs?.();
    if (gpuMs === undefined) return;
    this.#lodBiasStepAt = now;
    const affordableMs = this.#mainGpuShare * frameMs;
    if (!(affordableMs > 0)) return;
    const bias =
      gpuMs > affordableMs
        ? this.#biasOverBudget()
        : gpuMs < LOD_BIAS_DECAY_SHARE * affordableMs
          ? Math.max(LOD_BIAS_MIN, this.#lodBias * LOD_BIAS_DECAY)
          : this.#lodBias;
    if (bias === this.#lodBias) return;
    this.#applyLodBias(bias);
    if (now - this.#lodBiasToldAt >= LOD_BIAS_MARKER_SECONDS * 1000) {
      this.#lodBiasToldAt = now;
      const triangles = this.gpuSceneTally()?.triangles;
      console.info(
        `${LOD_BIAS_MARKER} bias=${bias.toFixed(3)} gpuMs=${gpuMs.toFixed(2)} ` +
          `budgetMs=${affordableMs.toFixed(2)} ` +
          `tris=${triangles === undefined ? "n/a" : String(triangles)}`,
      );
    }
  }

  /**
   * The next bias while the main pass is over its share of the frame, or the bias unchanged when the
   * world is not what that pass is drawing.
   *
   * A load's GPU time is shader compiles, buffer uploads and the prewarm — none of it main-pass world
   * geometry, so a coarser selection cannot take any of it back. What it costs is the first playable
   * frame: every tree selects the level authored for its distance times the bias, the coarsest levels
   * hold almost nothing, and the shadow casters, which take no bias, leave a band of tree shadows with
   * no trees 80-300 m out. Measured on Machinefall (RTX 2080, WebGPU), the bias climbed 1.08 → 2.33
   * over six `TN_LOD_BIAS` steps, all of them before the loading overlay dropped.
   *
   * So the rise waits for the two measurements that say the world is being drawn: the prewarm gate —
   * what a game's loading screen waits on, and `stats().pendingPrewarm` as the same thing as a number
   * — and the main pass's own GPU-selected triangle tally, where a tally that landed and says zero is
   * a world drawn as nothing. A world with no tally at all (no GPU scene, or nothing landed yet) has no
   * opinion about its own triangles, so the prewarm speaks for it alone. Both are measurements of the
   * thing being judged, which is what the warmup seconds were standing in for.
   */
  #biasOverBudget(): number {
    if (this.#prewarm.queued > 0 || this.#prewarm.owed > this.#prewarm.drawn) return this.#lodBias;
    if (this.gpuSceneTally()?.triangles === 0) return this.#lodBias;
    return Math.min(LOD_BIAS_MAX, this.#lodBias * LOD_BIAS_RISE);
  }

  /** Writes the bias to both selection paths: the shared CPU multiplier and the GPU uniform. */
  #applyLodBias(bias: number): void {
    this.#lodBias = bias;
    setLodBias(bias);
    this.#gpuScene.setLodBias(bias);
  }

  /**
   * Where the ring centres: the follow point led by its smoothed velocity. Samples closer than a
   * few milliseconds are the same frame and move nothing; a jump longer than the ring is a teleport
   * and resets the velocity rather than reading as speed.
   */
  #ahead(x: number, z: number): { x: number; z: number } {
    if (this.#prefetchSeconds === 0) return { x, z };
    const now = this.#now();
    const last = this.#lastSample;
    if (last === undefined) {
      this.#lastSample = { t: now, x, z };
    } else {
      const seconds = (now - last.t) / 1000;
      if (seconds >= 0.004) {
        const dx = x - last.x;
        const dz = z - last.z;
        if (Math.hypot(dx, dz) > this.#cellSize * this.#ring) {
          this.#velocityX = 0;
          this.#velocityZ = 0;
        } else {
          // ~0.25 s smoothing, so one jittery frame does not swing the ring.
          const blend = Math.min(1, seconds / 0.25);
          this.#velocityX += (dx / seconds - this.#velocityX) * blend;
          this.#velocityZ += (dz / seconds - this.#velocityZ) * blend;
        }
        this.#lastSample = { t: now, x, z };
      }
    }
    let leadX = this.#velocityX * this.#prefetchSeconds;
    let leadZ = this.#velocityZ * this.#prefetchSeconds;
    const limit = this.#cellSize * this.#ring * 0.75;
    const length = Math.hypot(leadX, leadZ);
    if (length > limit) {
      leadX *= limit / length;
      leadZ *= limit / length;
    }
    return { x: x + leadX, z: z + leadZ };
  }

  attachRenderer(renderer: IRendererLike): void {
    this.#terrain?.attachRenderer(renderer);
  }

  /** Current per-asset reference count; an asset absent from the map is `0`. */
  assetRefCounts(): Readonly<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const [id, asset] of this.#assets) counts[id] = asset.refcount;
    return counts;
  }

  /**
   * Turn on the GPU-selected tally for the rest of the world's life.
   *
   * The engine calls this when the frame budget is on, and a `gpuSceneValidate` turns it on without
   * it. Set `gpuSceneTally: true` at load instead when a world is driven outside a frame budget.
   */
  enableGpuSceneTally(): void {
    this.#gpuTally = true;
  }

  /**
   * The GPU's own main-pass selection from the last landed tally, or `undefined` before one lands.
   *
   * `triangles` is the GPU-selected count, which `renderer.info.render.triangles` cannot give for an
   * indirect draw: three counts the mesh capacity there, an upper bound over what the kernel could
   * select. This is what the kernel selected. Main pass only, and `ageFrames` is its staleness.
   */
  gpuSceneTally(): IWorldCellsGpuTally | undefined {
    const gpu = this.#gpuScene.report();
    if (gpu.gpuTriangles === undefined) return undefined;
    return {
      ageFrames: gpu.gpuTallyAgeFrames ?? 0,
      instances: gpu.gpuInstances ?? 0,
      triangles: gpu.gpuTriangles,
    };
  }

  stats(): IWorldCellsStats {
    const gpu = this.#gpuScene.report();
    const census = this.#gpuCensus();
    return {
      admission: { ...this.#admission },
      bundle: {
        children: this.#mainBundleChildren() + this.#chunkBundleChildren,
        on:
          this.#bundlesWanted && (this.#mainBundleChildren() > 0 || this.#chunkBundleChildren > 0),
        cpuMeshes: [...this.#shared.values()].filter(
          (shared) => shared.bundled && shared.gpu === undefined,
        ).length,
        gpuMeshes: [...this.#shared.values()].filter(
          (shared) => shared.bundled && shared.gpu !== undefined,
        ).length,
        eligibility: { ...this.#bundleSafety.stats },
        reason: this.#bundleReason,
        records: this.#bundleRecords,
      },
      evictions: this.#evictions,
      failures: this.#failures,
      gpuScene: {
        dispatches: gpu.dispatches,
        instances: gpu.instances,
        keys: gpu.keys,
        on: gpu.on,
        reason: gpu.reason,
        dressed: census.dressed,
        meshes: census.meshes,
        ...(gpu.gpuTriangles === undefined
          ? {}
          : {
              gpuInstances: gpu.gpuInstances,
              gpuTallyAgeFrames: gpu.gpuTallyAgeFrames,
              gpuTriangles: gpu.gpuTriangles,
            }),
        ...(gpu.occlusion === undefined ? {} : { occlusion: gpu.occlusion }),
      },
      hlod: this.#chunks.stats(),
      impostor: this.#impostorState.impostorStats(),
      instances: this.#instances,
      loadsInFlight: this.#limiter.inFlight,
      loadsQueued: this.#limiter.queued,
      mainCull: {
        frustums: this.#mainCullFrustums,
        repacks: this.#mainCullPacks,
        visibleEpoch: this.#visibleEpoch,
        windows: this.#mainCullWindows,
      },
      // Minted meshes still owed a first draw, not minted meshes. The two used to be the same
      // number, so a loading bar read minting as the whole of the prewarm and then stood still for
      // the whole draw — the node builds a bar cannot show. The gate is a promise about batches, so
      // the settle zeroes this pair: `0` once `prewarmed` has resolved.
      pendingPrewarm: this.#prewarm.queued + this.#prewarm.owed - this.#prewarm.drawn,
      prewarmMinted: this.#prewarm.minted,
      pressure: { ...this.#pressure },
      // The pass itself, counted whether or not it found anything: `rebuilds` cannot tell a skipped
      // pass from one that scanned every resident cell and found the same brackets, and that gap is
      // the whole cost of the 2 m step. See `#refilterStale`.
      refilters: this.#refilters,
      refilterEntries: this.#staleEntries,
      rebuilds: this.#rebuilds,
      // The share of `rebuilds` the swap found unchanged, which is the honest report of how much of
      // the refilter pass is a bracket that was wider than any placement.
      unchanged: this.#unchanged,
      residentCells: this.#resident.size,
      residentBytes: this.#bytes,
      loadedCells: [...this.#resident.values()].filter((cell) => this.#cellLoaded(cell)).length,
      residentKeys: [...this.#resident.keys()].sort(),
      residentTiles: this.#terrain?.residentTileCount ?? 0,
      residentColliders: this.#hasColliders ? (this.#terrain?.residentColliderKeys.length ?? 0) : 0,
    };
  }

  detach(): void {
    this.dispose();
  }

  #cellLoaded(cell: IResidentCell): boolean {
    return cellLoaded(cell);
  }

  /** Completed content intersecting a square around a fixed spawn, in world metres. */
  readinessAt(
    position: { readonly x: number; readonly z: number },
    radius = 0,
  ): IWorldRegionReadiness {
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      throw new Error("WorldCells readiness requires finite coordinates and a nonnegative radius.");
    const lowX = Math.floor((position.x - radius - this.#minX) / this.#cellSize);
    const highX = Math.floor((position.x + radius - this.#minX) / this.#cellSize);
    const lowZ = Math.floor((position.z - radius - this.#minZ) / this.#cellSize);
    const highZ = Math.floor((position.z + radius - this.#minZ) / this.#cellSize);
    let requiredCells = 0;
    let loadedCells = 0;
    let failures = 0;
    for (const cell of this.#cells) {
      if (cell.x < lowX || cell.x > highX || cell.z < lowZ || cell.z > highZ) continue;
      requiredCells++;
      const resident = this.#resident.get(cellKey(cell.x, cell.z));
      if (resident && this.#cellLoaded(resident)) loadedCells++;
      if (resident?.chunkFailed) failures++;
      for (const run of cell.runs)
        if (this.#assets.get(this.#canonical(run.asset))?.failed) failures++;
    }
    const terrain = this.#terrain?.readinessAt(position, radius) ?? { required: 0, loaded: 0 };
    return {
      requiredCells,
      loadedCells,
      requiredTerrainTiles: terrain.required,
      loadedTerrainTiles: terrain.loaded,
      failures,
      cancelled: this.#released,
      ready:
        !this.#released &&
        failures === 0 &&
        loadedCells === requiredCells &&
        terrain.loaded === terrain.required,
    };
  }

  /**
   * Resolves when the content a fixed spawn needs has finished loading.
   *
   * The one-shot gate a streamed game waits on before it releases its loading screen. Readiness is
   * `readinessAt` and nothing else, so there is one authority for "the spawn's data is loaded": every
   * required cell and terrain tile in `radius` loaded with no failure. The position is snapshotted
   * here, so a caller may keep mutating the object it passed; `update` observes the held waiters
   * right after the frame's admissions, so a region an update admits settles its waiter in it.
   *
   * Fail closed: malformed coordinates, a negative radius or an unsupported timer deadline reject
   * before a waiter is armed. A failed asset and a torn-down world reject with their own named
   * error, and the deadline rejects with the budget it named. Every settlement removes the waiter
   * and clears its timer, so a settled waiter holds neither the deadline nor the world, and a
   * region evicted after its waiter resolved changes nothing.
   */
  whenSpawnReady(
    position: { readonly x: number; readonly z: number },
    radius = 0,
    timeoutMs = 120_000,
  ): Promise<IWorldRegionReadiness> {
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      return Promise.reject(
        new Error(
          "WorldCells spawn readiness requires finite coordinates and a nonnegative radius.",
        ),
      );
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2 ** 31 - 1)
      return Promise.reject(
        new Error("WorldCells spawn readiness requires a timeout in (0, 2147483647] ms."),
      );
    if (this.#released) return Promise.reject(new Error("WorldCells disposed"));
    const snapshot = { x: position.x, z: position.z };
    const immediate = this.readinessAt(snapshot, radius);
    if (immediate.failures > 0)
      return Promise.reject(new Error("WorldCells spawn assets failed to load"));
    if (immediate.ready) return Promise.resolve(immediate);
    return new Promise<IWorldRegionReadiness>((resolve, reject) => {
      const waiter: ISpawnWaiter = {
        position: snapshot,
        radius,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.#spawnWaiters.delete(waiter);
          reject(new Error(`WorldCells spawn exceeded ${String(timeoutMs)} ms`));
        }, timeoutMs),
      };
      this.#spawnWaiters.add(waiter);
    });
  }

  /** Settle the waiters this frame's admissions can answer; a non-Disposed, non-Failed region waits. */
  #settleSpawnWaiters(): void {
    if (this.#spawnWaiters.size === 0) return;
    for (const waiter of this.#spawnWaiters) {
      const readiness = this.readinessAt(waiter.position, waiter.radius);
      if (readiness.failures > 0) {
        this.#spawnWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("WorldCells spawn assets failed to load"));
      } else if (readiness.ready) {
        this.#spawnWaiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(readiness);
      }
    }
  }

  dispose(): void {
    if (this.#released) return;
    this.#released = true;
    // A world torn down mid-wait must not leave a game awaiting its spawn gate, nor a deadline
    // outliving the world that armed it.
    for (const waiter of this.#spawnWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WorldCells spawn cancelled"));
    }
    this.#spawnWaiters.clear();
    this.#prewarm.releaseHooks();
    for (const cell of [...this.#resident.values()]) this.#evict(cell);
    // Every chunk is gone by now, so the surfaces the world owns on their behalf are the last thing
    // holding them, and they are released here rather than by whichever chunk contributed them.
    this.#chunks.releaseMaterials();
    this.#chunks.renderer = undefined;
    this.#chunks.camera = undefined;
    this.#recordedWhileBusy.clear();
    // After every asset's release above, so no record is still held by a surface; disposes the cached
    // atlases and aborts any bake still in flight.
    this.#impostorState.drainImpostors();
    this.#gpuScene.dispose();
    this.#bundleSafety.clear();
    this.#gpuResident.clear();
    if (this.#drainShared() > 0) this.#failures += 1;
    // The batches `#drainShared` just retired. Their geometry and material were released by the
    // refcount path above, which is why they are disposed and not reused.
    for (const shared of this.#retired.values()) shared.mesh.dispose();
    this.#retired.clear();
    this.#retiredBytes = 0;
    // A world torn down mid-prewarm must not leave a game awaiting its gate.
    this.#prewarm.settleDisposal();
    drainMeshPool();
    this.#terrain?.dispose();
    this.removeFromParent();
  }

  #updateResidency(followCell: { x: number; z: number }, x: number, z: number): void {
    const wanted: Array<{ cell: IWorldCell; distance: number }> = [];
    for (const cell of this.#cells) {
      if (Math.max(Math.abs(cell.x - followCell.x), Math.abs(cell.z - followCell.z)) > this.#ring)
        continue;
      const centerX = this.#minX + (cell.x + 0.5) * this.#cellSize;
      const centerZ = this.#minZ + (cell.z + 0.5) * this.#cellSize;
      wanted.push({ cell, distance: Math.hypot(x - centerX, z - centerZ) });
    }
    wanted.sort((a, b) => a.distance - b.distance || a.cell.z - b.cell.z || a.cell.x - b.cell.x);

    for (const resident of [...this.#resident.values()]) {
      if (
        Math.max(Math.abs(resident.x - followCell.x), Math.abs(resident.z - followCell.z)) >
        this.#ring + 1
      )
        this.#evict(resident);
    }
    // A follow point that crossed more than one cell in one pass jumped (a teleport, a review
    // camera). Only then does the hysteresis ring yield. Read off the follow point itself, not the
    // lookahead `followCell`: that leads by up to 1.5 cells, so a walk that stopped and started moved
    // it by two, and yielding there evicted and re-admitted a whole row each time.
    const here = {
      x: Math.floor((this.#follow.position.x - this.#minX) / this.#cellSize),
      z: Math.floor((this.#follow.position.z - this.#minZ) / this.#cellSize),
    };
    const last = this.#residencyCell;
    const jumped =
      last !== undefined && Math.max(Math.abs(last.x - here.x), Math.abs(last.z - here.z)) > 1;
    this.#residencyCell = here;

    for (const candidate of wanted) {
      const key = cellKey(candidate.cell.x, candidate.cell.z);
      if (this.#resident.has(key)) continue;
      const instances = candidate.cell.runs.reduce((total, run) => total + run.count, 0);
      const bytes = instances * PLACEMENT_RECORD_BYTES;
      // After a jump, a cell the one-ring hysteresis above kept is not wanted, so it yields its share
      // of the budgets to one that is. Without this the budgets stayed full of the ring the camera
      // jumped from and the cells around it were refused until it moved again.
      while (
        jumped &&
        (this.#resident.size >= this.#budgets.residentCells ||
          this.#instances + this.#impostorState.farInstances + instances >
            this.#budgets.instances ||
          this.#bytes + this.#impostorState.farBytes + this.#chunks.bytes + bytes >
            this.#budgets.bytes)
      ) {
        const spare = this.#farthestUnwanted(followCell);
        if (spare === undefined) break;
        this.#evict(spare);
      }
      if (this.#resident.size >= this.#budgets.residentCells) {
        this.#pressure.cells += 1;
        continue;
      }
      // The retained far aggregates are physical allocations the renderer holds too, so they are
      // charged against the same declared limits as the near ring: admitting a cell over the top of
      // them would put the world past `budgets.instances`/`budgets.bytes` with the far half invisible
      // to this check. See `#farBudgetRefuses`, the far half of the same total.
      if (
        this.#instances + this.#impostorState.farInstances + instances >
        this.#budgets.instances
      ) {
        this.#pressure.instances += 1;
        continue;
      }
      if (
        this.#bytes + this.#impostorState.farBytes + this.#chunks.bytes + bytes >
        this.#budgets.bytes
      ) {
        this.#pressure.bytes += 1;
        continue;
      }
      this.#admit(candidate.cell, instances, bytes);
    }
  }

  /** The resident cell farthest outside the wanted ring, or none when every resident is wanted. */
  #farthestUnwanted(followCell: { x: number; z: number }): IResidentCell | undefined {
    let farthest: IResidentCell | undefined;
    let reach = this.#ring;
    for (const resident of this.#resident.values()) {
      const away = Math.max(
        Math.abs(resident.x - followCell.x),
        Math.abs(resident.z - followCell.z),
      );
      if (away > reach) {
        reach = away;
        farthest = resident;
      }
    }
    return farthest;
  }

  #admit(cell: IWorldCell, instances: number, bytes: number): void {
    const state: IResidentCell = {
      mainChunkMeshes: [],
      completedRuns: new Set(),
      chunksLoaded: (cell.chunks?.length ?? 0) === 0,
      chunkFailed: false,
      batches: [],
      bytes,
      cell,
      chunks: [],
      filterFar: Number.NEGATIVE_INFINITY,
      filterNear: Number.POSITIVE_INFINITY,
      generation: this.#generation++,
      instances,
      key: cellKey(cell.x, cell.z),
      retainedModelPaths: [],
      x: cell.x,
      z: cell.z,
    };
    this.#resident.set(state.key, state);
    this.#cullResident(cell);
    this.#residencyEpoch += 1;
    this.#instances += instances;
    this.#bytes += bytes;
    for (const run of cell.runs) this.#acquire(run, state);
    if (cell.chunks !== undefined && cell.chunks.length > 0) this.#chunks.startChunkLoad(state);
  }

  /**
   * The asset id a run's `asset` really is: itself, or the one canonical id its model is loaded
   * under. Every path from a run to the state that holds it goes through here, so a duplicate costs
   * one `IAssetState`, one model load, one set of `canonical:level:part` keys and one refcount —
   * released when the last run naming any member of the group leaves the ring. A placement keeps its
   * own transform, because those are read from the run's own records.
   */
  #canonical(id: string): string {
    return this.#aliases.get(id) ?? id;
  }

  /** One fresh asset state for a definition, registered and its gates noted. */
  #newAsset(id: string, definition: IWorldAsset): IAssetState {
    const asset: IAssetState = {
      ...assetLevels(definition),
      definition,
      disposed: false,
      id,
      levels: [],
      pending: false,
      failed: false,
      refcount: 0,
      hlodSafe: false,
      retainedPaths: [],
      resolvedGlb: "",
      spilled: [],
    };
    if (this.#lodHysteresis > 0 && definition.lods !== undefined) {
      asset.gates = [
        ...asset.gates,
        ...asset.distances.slice(1).map((gate) => gate * (1 - this.#lodHysteresis)),
      ];
      asset.threshold = Math.min(...asset.gates);
    }
    this.#assets.set(id, asset);
    for (const gate of asset.gates) this.#noteGate(gate);
    return asset;
  }

  #acquire(run: IWorldRun, cell: IResidentCell): void {
    const id = this.#canonical(run.asset);
    let asset = this.#assets.get(id);
    if (asset === undefined) {
      const definition = this.#manifest.assets[id];
      if (definition === undefined) return;
      asset = this.#newAsset(id, definition);
    }
    asset.refcount += 1;
    if (asset.levels.length > 0) {
      this.#queueBuild(asset, cell, run);
      return;
    }
    if (!asset.pending) this.#startAssetLoad(asset);
  }

  /**
   * Ask for one cell-asset run to be built, and do not build it yet.
   *
   * Admission is the only thing in this class that has no frame-time ceiling, so it is the only
   * thing that became a queue: the cell keeps its residency slot from `#admit`, the work waits for
   * a frame with budget in it, and a game that outruns the backlog sees it as `admission.backlog`
   * rather than as a frozen frame. A run already queued is not queued twice, which is what stops a
   * refilter — stale for as many frames as it waits — from stacking a second copy of itself.
   *
   * `replaced` is a refilter's outgoing batches, captured now and kept drawn until the replacement
   * is attached, so a rebuild that waits three frames shows the old level for those three frames
   * instead of a hole.
   */
  #queueBuild(
    asset: IAssetState,
    cell: IResidentCell,
    run: IWorldRun,
    replace = false,
    force = false,
  ): void {
    // Keyed on the run, not the asset: one cell can hold two runs of the same canonical asset —
    // two names for one model — and each has its own records to build. A token per asset made the
    // second run a no-op and dropped its placements on the floor.
    if (this.#queued.has(run)) return;
    // A cell that already draws this run is not built again, which is where an adopted asset's
    // second acquire over a still-resident cell lands.
    if (!replace && cell.batches.some((entry) => entry.asset === asset.id && entry.run === run))
      return;
    this.#queued.add(run);
    this.#jobs.push({
      asset,
      batches: undefined,
      boxes: undefined,
      cell,
      force,
      gpuByLevel: undefined,
      filterY: this.#followY(),
      filterX: this.#follow.position.x,
      filterZ: this.#follow.position.z,
      fresh: [],
      next: 0,
      published: 0,
      records: undefined,
      replaced: replace
        ? cell.batches.filter((entry) => entry.asset === asset.id && entry.run === run)
        : [],
      roots: undefined,
      run,
      sources: undefined,
    });
  }

  /**
   * Spend the frame's budget on queued builds, one unit each, and stop when it is gone.
   *
   * The queue is served in admission order, which is nearest cell first, and a build is taken to
   * completion before the next one starts: the units of one run are cheaper together than the
   * per-frame bookkeeping of interleaving them, and the cell behind it is the same distance away.
   * A build whose cell or asset has gone is dropped rather than resumed — there is nothing left to
   * draw it into — and a frame that runs out of budget leaves the rest of the queue for the next.
   */
  #drain(budget: IAdmissionBudget): void {
    const index = 0;
    while (index < this.#jobs.length) {
      const job = this.#jobs[index] as IBuildJob;
      if (this.#resident.get(job.cell.key) !== job.cell || job.asset.levels.length === 0) {
        this.#forget(index, job);
        continue;
      }
      let finished = false;
      if (
        !budget.admit(() => {
          finished = this.#step(job);
        })
      )
        break;
      // Out of fresh meshes this frame: later jobs would only stall the same way.
      if (this.#meshStalled) break;
      // A finished build leaves the queue at this index, so the next one is served without a skip.
      if (finished) {
        job.cell.completedRuns.add(job.run);
        this.#forget(index, job);
        // A camera that moved during this bounded build may already have consumed the global
        // refilter step before these batches existed. Owe one pass after publication, even if
        // it now stands still, so the coherent old snapshot can converge to the latest pose.
        if (
          Math.hypot(
            this.#follow.position.x - job.filterX,
            this.#followY() - job.filterY,
            this.#follow.position.z - job.filterZ,
          ) >= this.#refilterStepMetres()
        )
          this.#refilterOwed = true;
      }
    }
  }

  #forget(index: number, job: IBuildJob): void {
    this.#jobs.splice(index, 1);
    this.#queued.delete(job.run);
  }

  /** Units of work the queue still owes: placement slices left, plus meshes left to publish. */
  #backlog(): number {
    let units = 0;
    for (const job of this.#jobs) {
      const meshes = job.batches === undefined ? 0 : publishCount(job.batches);
      units +=
        Math.ceil(Math.max(0, job.run.count - job.next) / ADMISSION_SLICE_PLACEMENTS) +
        Math.max(0, meshes - job.published);
    }
    return units;
  }

  /**
   * One unit of one build: a slice of placements, or one mesh built, or the swap that attaches the
   * finished batch and retires what a refilter replaced. `true` means the job is done.
   */
  #step(job: IBuildJob): boolean {
    // A queued run may wait behind admission or fresh-mesh work while the camera moves.
    // Take its filter snapshot when the first placement slice actually starts, then keep
    // that snapshot for every slice so one publication never mixes different camera poses.
    if (job.next === 0 && job.batches === undefined) {
      job.filterX = this.#follow.position.x;
      job.filterY = this.#followY();
      job.filterZ = this.#follow.position.z;
    }
    if (job.next < job.run.count) {
      job.batches ??= newBatches(job.asset);
      // One box per `(level, part)` beside the batches it measures, so the swap that hands the
      // records to the renderer can name where they are; see `#addPlacements`.
      job.boxes ??= newBoxes(job.batches);
      const end = Math.min(job.next + ADMISSION_SLICE_PLACEMENTS, job.run.count);
      this.#addPlacements(job, job.next, end);
      job.next = end;
      return false;
    }
    const batches = job.batches;
    // A run with nothing placed in it publishes nothing, exactly as an unbounded build would.
    if (batches === undefined) return true;
    if (job.published < publishCount(batches)) {
      this.#buildOne(job, batches);
      return false;
    }
    return this.#swap(job);
  }

  /**
   * Hand the cell its finished batches and take back the ones they replace, in one step.
   *
   * This is the no-hole rule. Attaching and detaching in the same synchronous block means no frame
   * ever shows the replacement beside the batch it replaces, and a refilter that waits three frames
   * for budget shows the level the cell already had for those three frames rather than nothing.
   */
  #swap(job: IBuildJob): boolean {
    const { cell } = job;
    // A refilter that rebuilt byte-for-byte the records the cell already draws must write, clear and
    // move nothing. `#staleIn` queues on the *cell's* distance bracket, which is wider than any one
    // placement's, so a rebuild whose level or cull answer did not move still comes back identical.
    // A matched pair is settled here instead: the outgoing entry keeps its block and its place in
    // the cell, only its filter point moves, so the next gate is measured from where the follow
    // point is now rather than from where it was when the answer was already right. Everything
    // else falls through to the swap below untouched.
    for (let index = job.fresh.length - 1; index >= 0 && job.force === false; index -= 1) {
      const fresh = job.fresh[index] as ICellBatch;
      const at = job.replaced.findIndex(
        (old) =>
          old.level === fresh.level && old.part === fresh.part && old.batch.equals(fresh.batch),
      );
      if (at < 0) continue;
      const same = job.replaced.splice(at, 1)[0] as ICellBatch;
      this.#unchanged += 1;
      same.lastFilterY = fresh.lastFilterY;
      same.lastFilterX = fresh.lastFilterX;
      same.lastFilterZ = fresh.lastFilterZ;
      this.#widenFilterRange(cell, fresh.lastFilterX, fresh.lastFilterZ);
      job.fresh.splice(index, 1);
      // The batch that stays is the one that was already drawing, so its source records are its own
      // — and a cell the ring built before the scene came up has none. This is the only path that
      // hands them over for a rebuild whose records came out identical, which is every one of them:
      // the records are the same, so the fast path is always the one taken.
      if (this.#gpuScene.on && same.gpu === undefined) same.gpu = this.#placeSources(job, same);
    }
    // Every segment first, so a frame out of fresh meshes leaves the old batches drawing whole.
    for (const entry of job.fresh) {
      if (entry.batch.count === 0) continue;
      // Both halves for every fresh entry, whether or not a stalled frame already claimed one:
      // skipping an entry that has its main block meant the retry never asked for its cluster, so
      // those records reached the main pass and no shadow map.
      if (entry.segment < 0) {
        const shared = this.#sharedFor(job.asset.id, entry);
        const segment =
          shared === undefined
            ? undefined
            : this.#segmentIn(shared, entry.batch.count, this.#cullCellOf(cell));
        if (shared === undefined || segment === undefined) {
          this.#meshStalled = true;
          return false;
        }
        entry.shared = shared;
        entry.segment = segment;
      }
      // The caster cluster, when this level casts. A frame that runs out of fresh meshes between
      // the main mesh and its cluster leaves the main one drawing whole and takes the cluster next
      // frame, which is the same no-hole rule as above: never half a replacement.
      if (!this.#claimCaster(job.asset.id, entry, cell)) {
        this.#meshStalled = true;
        return false;
      }
      // The wide half, by the same no-hole rule: a key with a cluster and no wide caster draws into
      // a level that may already be reading the wide layer with nothing in it.
      if (!this.#claimWide(job.asset.id, entry)) {
        this.#meshStalled = true;
        return false;
      }
    }
    for (const entry of job.replaced) {
      const at = cell.batches.indexOf(entry);
      if (at >= 0) cell.batches.splice(at, 1);
      this.#clearSegment(entry);
    }
    for (const entry of job.fresh) {
      cell.batches.push(entry);
      if (entry.shared !== undefined) entry.shared.write(entry.segment, entry.batch);
      if (this.#gpuScene.on) entry.gpu = this.#placeSources(job, entry);
      if (entry.caster !== undefined) entry.caster.write(entry.casterSegment, entry.batch);
      // The wide half draws the whole-asset impostor at the placement root when this entry kept one,
      // and the source part shape otherwise; see `ICellBatch.wideRoot`.
      if (entry.wide !== undefined)
        entry.wide.write(entry.wideSegment, entry.wideRoot ?? entry.batch);
    }
    // A batch the walk just wrote to, cleared or compacted holds new records, so the shadow levels
    // that drew the old ones are stale. One flag, told at most once a second.
    if (job.fresh.length > 0 || job.replaced.length > 0)
      this.#shadowRecordsMoved(this.#changedBounds(job.fresh, job.replaced));
    // This run's near representation is attached, so the far mesh stops drawing its original roots in
    // the same synchronous block: a cell is never drawn by both and never by neither. A no-op until
    // the asset's atlas lands; see `#syncFarSegments` for the build-time half and `#restoreFar`.
    this.#impostorState.disableFar(job.run);
    return true;
  }

  /**
   * The world bounds of the records these groups moved: the union of what each batch held, in and
   * out. Both sides, because a record that leaves is ground a level was drawing; `undefined` when
   * neither held one, and then the tell is the blanket one.
   */
  #changedBounds(fresh: readonly ICellBatch[], replaced: readonly ICellBatch[]): Box3 | undefined {
    let union: Box3 | undefined;
    for (const group of [fresh, replaced])
      for (const entry of group) {
        const box = entry.shadowBounds;
        if (box === undefined) continue;
        if (union === undefined) union = box.clone();
        else union.union(box);
      }
    return union;
  }

  /**
   * Claim this cell's block in its caster cluster, when the level casts and it does not have one.
   * `false` means the frame's fresh allowance is spent and the swap waits, so the main mesh and its
   * cluster are never half attached.
   */
  #claimCaster(assetId: string, entry: ICellBatch, cell: IResidentCell): boolean {
    const level = this.#castLevelOf(entry);
    if (entry.casterSegment >= 0 || level === undefined) return true;
    // Nothing to claim, and nothing to wait for: a world whose levels draw its keys mints no caster
    // half at all (`#casterFor`), so reading that as a spent allowance refused every swap in the
    // world — the main mesh was never attached, no cell published its placements, and the main pass
    // drew nothing while its meshes sat there prewarmed and empty.
    if (this.#keysForShadow()) return true;
    const caster = this.#casterFor(assetId, entry, cell, level);
    const at = caster === undefined ? undefined : this.#segmentIn(caster, entry.batch.count);
    if (caster === undefined || at === undefined) return false;
    entry.caster = caster;
    entry.casterSegment = at;
    return true;
  }

  /**
   * Claim this cell's block in its key's wide caster mesh, when the level casts and it does not
   * have one. `false` means the frame's fresh allowance is spent and the swap waits, so the
   * clusters and the wide half are never half attached.
   */
  #claimWide(assetId: string, entry: ICellBatch): boolean {
    const level = this.#castLevelOf(entry);
    if (entry.wideSegment >= 0 || level === undefined) return true;
    // A part the asset's one whole-asset representation already covers: the entry keeps its near
    // main and cluster, and the far shadow reads part 0's one quad; see `#wideOwed`.
    if (!this.#wideOwed(assetId, entry.part)) return true;
    // As `#claimCaster`: the key twin is this level's wide half, and there is no mesh to wait on.
    if (this.#keysForShadow()) return true;
    const wide = this.#wideFor(assetId, entry, level);
    // The impostor's far half draws the placement root, not `placement * part local`, so its block
    // is sized to the root records the build kept beside the part's own; see `ICellBatch.wideRoot`.
    const count = entry.wideRoot?.count ?? entry.batch.count;
    const at = wide === undefined ? undefined : this.#segmentIn(wide, count);
    if (wide === undefined || at === undefined) return false;
    entry.wide = wide;
    entry.wideSegment = at;
    return true;
  }

  #clearSegment(entry: ICellBatch): void {
    if (entry.shared !== undefined && entry.segment >= 0) entry.shared.clear(entry.segment);
    // The source records go back with the block that held them, on every path a cell's records leave:
    // a refilter's replacement, an eviction, and a queued build dropped with its cell. Releasing one
    // twice is a no-op, which is what lets a level's parts share a single list.
    if (entry.gpu !== undefined) {
      const placed = entry.gpu.length;
      for (const at of entry.gpu) this.#gpuScene.release(at);
      const left = (this.#gpuResident.get(entry.asset) ?? 0) - placed;
      if (left > 0) this.#gpuResident.set(entry.asset, left);
      else this.#gpuResident.delete(entry.asset);
      // Before the halves go below, which is what clears the handles this reads.
      this.#countPlaced(entry, -placed);
    }
    entry.gpu = undefined;
    if (entry.caster !== undefined && entry.casterSegment >= 0)
      entry.caster.clear(entry.casterSegment);
    if (entry.wide !== undefined && entry.wideSegment >= 0) entry.wide.clear(entry.wideSegment);
    entry.shared = undefined;
    entry.segment = -1;
    entry.caster = undefined;
    entry.casterSegment = -1;
    entry.wide = undefined;
    entry.wideSegment = -1;
  }

  /**
   * One cell's records changed, so the shadow levels that cover it redraw — at most once a second,
   * and only for a game that passed the hook. The levels cull clusters themselves now, so nothing
   * has to be copied for them; the flag only says "what you last drew is out of date".
   *
   * `bounds` is the records that changed and is kept until the tell, unioned with whatever else
   * changed in the same second. A change with no bounds is a blanket one: it has to be, because
   * there is nothing narrower to say.
   */
  #shadowRecordsMoved(bounds?: Box3): void {
    this.#shadowMoved = true;
    if (bounds === undefined || bounds.isEmpty()) return;
    const current = this.#shadowRegion;
    if (current === undefined) {
      this.#shadowRegion = {
        max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
        min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
      };
      return;
    }
    current.min.x = Math.min(current.min.x, bounds.min.x);
    current.min.y = Math.min(current.min.y, bounds.min.y);
    current.min.z = Math.min(current.min.z, bounds.min.z);
    current.max.x = Math.max(current.max.x, bounds.max.x);
    current.max.y = Math.max(current.max.y, bounds.max.y);
    current.max.z = Math.max(current.max.z, bounds.max.z);
  }

  /**
   * Tell the shadow levels once, if anything changed and a second has passed.
   *
   * The companions used to make this the expensive call it still is; the levels redraw from
   * scratch, so the cadence is the only lever and once a second is the one that keeps a walk's
   * frames off the shadow lane without leaving the ground stale behind a player. The region is
   * what the changed records' own bounds add: a hook that forwards it redraws the levels whose
   * window covers them, which for a streaming world is usually the finest one alone.
   */
  #tellShadows(): void {
    if (!this.#shadowMoved) return;
    // No hook means there is no level to tell, so the flag is discharged here. Leaving it set made
    // `#residencyStale` true forever, and every update ran a full residency pass on a world that had
    // nothing left to do.
    if (this.#invalidateShadows === undefined) {
      this.#shadowMoved = false;
      this.#shadowRegion = undefined;
      return;
    }
    const now = this.#now();
    if (now - this.#shadowToldAt < 1e3) return;
    this.#shadowToldAt = now;
    this.#shadowMoved = false;
    const region = this.#shadowRegion;
    this.#shadowRegion = undefined;
    if (region === undefined) this.#invalidateShadows();
    else this.#invalidateShadows(region);
  }

  /**
   * Publish, on every caster half, whether the main pass will draw the records behind it this frame.
   *
   * A caster whose main counterpart is not drawable casts the shadow of nothing. With the GPU scene
   * on, a dressed main mesh draws from the dispatch's own record, and a batch the scene holds no
   * placement for submits that record and draws none of it — while the caster halves are plain CPU
   * batches whose `#clustered` is false for every role but `main` (see the constructor), so they keep
   * `#drawn`, the whole resident ring, and a shadow level submits all of it. `#seedGpuSources` is
   * what puts the placements in, by queueing a rebuild of the ring behind the admission budget, so
   * the hole lasts as long as that takes to drain and the picture shows canopy on empty ground for
   * every frame of it.
   *
   * Per caster half, which is the granularity the ring is placed at and the only one that cannot draw
   * a shadow for a source the dispatch has not been given: a `@x,z` cluster covers the cells of one
   * world-grid square and a `@*` wide mesh every cell of its asset, so each compares its own placed
   * count (`SharedBatch#gpuPlaced`, kept by `#placeSources` and `#clearSegment`) with its own live
   * records. Per asset was one count too coarse and it showed: near cells of an asset are placed first,
   * so a per-asset rule admitted every far cluster of that asset and its unplaced canopies drew
   * shadows on empty ground — one capture in four showed dozens of them at the start pose.
   *
   * The direction is fail-closed, and the only price is a shadow that arrives with its trees: a half
   * whose sources are still being placed casts nothing this frame, and casts once they are all there.
   *
   * Not the camera's frustum, which is the other narrowing and the wrong one: an off-screen caster
   * the main pass has no reason to draw is the reason a shadow map exists.
   */
  #publishCasterAdmission(): void {
    // With the scene off there is no dress to wait for: a main batch draws from its own records and
    // its own cull window, so every caster half is admitted whatever the camera is looking at. One
    // comparison per half, no name work and no allocation: `live` is the records the main pass would
    // have to be drawing for this half to cast at all.
    const gpu = this.#gpuScene.on;
    for (const shared of this.#shared.values()) {
      if (shared.role === "main") continue;
      shared.setMainAdmitted(gpu === false || shared.gpuPlaced >= shared.live);
    }
  }

  /**
   * `TN_WORLD_MAIN_CULL`, every `MAIN_CULL_MARKER_MS`: what the main pass holds, what it is drawing,
   * how many of its meshes are submitted at all, and how many times the window moved to get there.
   *
   * `instances` is every live record the main batches hold — the whole resident ring, which is what
   * three's whole-mesh test used to hand the vertex stage — and `drawn` is what the cull left in the
   * windows. The gap between them is the saving, `repacks` says what it cost to get: a settled camera
   * repacks nothing, so a walk that repacks dozens of times a second is a window that is chasing the
   * camera, not one that is thrashing. `hidden` and `castersHidden` are the batches with nothing to
   * draw that are now not submitted at all: in three r185's WebGPU path a zero-count `InstancedMesh`
   * still runs the whole per-draw JS chain, so an empty batch was CPU a frame for no draw — the number
   * is the part of the census that no longer costs anything.
   *
   * `dressed=N/M` is the GPU scene's own claim, repeated every five seconds: a scene that is on over
   * meshes nothing is dressed into compacts a set the CPU path is still drawing, and `keys` alone
   * cannot say so — a ring built before the scene came up has no keys at all and looks healthy.
   */
  #reportMainCull(): void {
    const now = this.#now();
    if (now - this.#mainCullToldAt < MAIN_CULL_MARKER_MS) return;
    this.#mainCullToldAt = now;
    const repacks = this.#mainCullRepacks;
    this.#mainCullRepacks = 0;
    let instances = 0;
    let drawn = 0;
    let hidden = 0;
    let castersHidden = 0;
    let clusterWithheld = 0;
    let clusterRecords = 0;
    let clusterMissing = 0;
    let wideWithheld = 0;
    let wideRecords = 0;
    let wideMissing = 0;
    // What the two caster layers hold between them, per layer: the resident triangle bill a shadow
    // level that picked that layer submits. Two numbers that must not be equal is the whole claim —
    // the wide half draws the asset's coarsest level, so it is the one that falls.
    let clusterTriangles = 0;
    let wideTriangles = 0;
    let dressed = 0;
    let mainMeshes = 0;
    for (const shared of this.#shared.values()) {
      if (shared.role !== "main") {
        if (shared.mesh.visible === false) castersHidden += 1;
        if (shared.mesh.mainAdmitted === false && shared.live > 0) {
          if (shared.role === "cluster") {
            clusterWithheld += 1;
            clusterRecords += shared.live;
            clusterMissing += Math.max(0, shared.live - shared.gpuPlaced);
          } else if (shared.role === "wide") {
            wideWithheld += 1;
            wideRecords += shared.live;
            wideMissing += Math.max(0, shared.live - shared.gpuPlaced);
          }
        }
        // Zero records add zero, so an empty batch needs no test of its own here.
        const triangles = levelTriangles(shared.mesh.geometry) * shared.live;
        if (shared.role === "cluster") clusterTriangles += triangles;
        else wideTriangles += triangles;
        continue;
      }
      mainMeshes += 1;
      if (shared.gpu !== undefined) dressed += 1;
      instances += shared.live;
      drawn += shared.drawn;
      if (shared.mesh.visible === false) hidden += 1;
    }
    console.info(
      `TN_WORLD_MAIN_CULL instances=${String(instances)} drawn=${String(drawn)} ` +
        `hidden=${String(hidden)} castersHidden=${String(castersHidden)} repacks=${String(repacks)} ` +
        `clusterTris=${String(clusterTriangles)} wideTris=${String(wideTriangles)} ` +
        `dressed=${String(dressed)}/${String(mainMeshes)}`,
    );
    console.info(
      `TN_WORLD_SHADOW_ADMISSION clusterWithheld=${String(clusterWithheld)} ` +
        `clusterRecords=${String(clusterRecords)} clusterMissing=${String(clusterMissing)} ` +
        `wideWithheld=${String(wideWithheld)} wideRecords=${String(wideRecords)} ` +
        `wideMissing=${String(wideMissing)} seeded=${String(this.#gpuSeeded)} ` +
        `queued=${String(this.#jobs.length)}`,
    );
    // The bundles on their own line, because the pair reads against a different question: how many
    // objects are recorded, and how many times the recording was thrown away and redone. A walk
    // streaming and culling holds `records` at the keys and chunks that came and went; a walk that
    // repacks it every frame is drawing a moving set, which is the bug a bundle cannot have. `reason`
    // is on it because the default is now on: a reader has to be able to tell a run that turned it
    // off from a run where recording never happened.
    const bundles = this.stats().bundle;
    console.info(
      `TN_WORLD_BUNDLE ${bundles.on ? "on" : "off"} reason=${bundles.reason} ` +
        `children=${String(bundles.children)} cpuMeshes=${String(bundles.cpuMeshes)} gpuMeshes=${String(bundles.gpuMeshes)} records=${String(bundles.records)}`,
    );
  }

  /**
   * Filter one slice of a run's placements into the batches they draw from, culling on the position
   * this build was queued for and switching level where an asset's `lods` say to.
   */
  #addPlacements(job: IBuildJob, from: number, to: number): void {
    const { asset, filterX, filterZ } = job;
    if (job.records === undefined) job.records = cellPlacements(this.#placements, job.run);
    const records = job.records;
    const inner = cullDistance(asset.definition.maxDistance);
    // Half the diagonal of the asset's authored bounds: the sphere the dispatch culls this placement
    // with, and the one number about its extent that comes from the package rather than from here.
    const authored = asset.definition.bounds;
    const boundsRadius =
      0.5 *
      Math.hypot(
        (authored.max[0] as number) - (authored.min[0] as number),
        (authored.max[1] as number) - (authored.min[1] as number),
        (authored.max[2] as number) - (authored.min[2] as number),
      );
    // Decided once per slice, not per placement: the wide half needs the placement root only for an
    // asset that can append a whole-asset impostor. See `ICellBatch.wideRoot`.
    const wantRoots = this.#impostorState.rootsNeeded(asset);
    for (let index = from; index < to; index += 1) {
      const base = index * PLACEMENT_RECORD_FLOATS;
      const x = records[base] as number;
      const y = records[base + 1] as number;
      const z = records[base + 2] as number;
      const distance =
        this.#placementReach === undefined
          ? Math.hypot(x - filterX, z - filterZ)
          : Math.hypot(x - filterX, y - job.filterY, z - filterZ);
      if (inner !== undefined && distance > inner) continue;
      const reach = this.#placementReach?.[job.run.offset + index];
      if (reach !== undefined && distance > reach) continue;
      this.#position.set(x, y, z);
      this.#rotation.set(
        records[base + 3] as number,
        records[base + 4] as number,
        records[base + 5] as number,
        records[base + 6] as number,
      );
      this.#scale.setScalar(records[base + 7] as number);
      this.#matrix.compose(this.#position, this.#rotation, this.#scale);
      const scale = this.#scale.x;
      // The placement transform, then the part's own offset inside the model: a bark primitive at
      // the trunk and a needles primitive higher up both land in the one instance matrix.
      // The level is picked by the shared gate rule: authored world-metre gates directly, and a
      // whole-asset impostor's terminal gate scaled by this placement's own scale. The bias is the
      // same adaptive multiplier the dispatch carries, so a biased walk crosses a switch here too.
      let level = levelAtGates(
        { distances: asset.distances, impostor: asset.impostor !== undefined },
        biasedLodDistance(distance),
        scale,
      );
      if (this.#placementLevels !== undefined && asset.definition.lods !== undefined) {
        const record = job.run.offset + index;
        let previous = this.#placementLevels[record] as number;
        // Outward gates remain authored; returning inward retains the previous level until the margin.
        if (level > previous) previous = level;
        while (
          previous > level &&
          biasedLodDistance(distance) <
            (asset.distances[previous] as number) * (1 - this.#lodHysteresis)
        )
          previous--;
        level = previous;
        this.#placementLevels[record] = level;
      }
      // The record's own world bounds: the placement widened by the asset's authored bounds at the
      // scale it is drawn at. Read here because this loop already holds the placement and the scale,
      // and it is the one number the shadow levels' invalidation is tested against — the cell box is
      // 64 m of it, so a level whose window is 48 m wide was redrawing over ground nothing in it.
      const bounds = asset.definition.bounds;
      // The far shadow of an asset that can bake a whole-asset impostor draws one quad per placement
      // at the placement root: the parts' own offsets are baked into the atlas, so composing a source
      // part's offset again would apply it twice. One root record per placement, beside the per-part
      // batches and read only by the wide half; see `ICellBatch.wideRoot`.
      if (wantRoots) {
        job.roots ??= [];
        const roots = job.roots;
        let root = roots[level];
        if (root === undefined) {
          const anchor = asset.levels[level]?.[0];
          if (anchor !== undefined) {
            root = new InstancedBatch({ geometry: anchor.geometry, material: anchor.material });
            roots[level] = root;
          }
        }
        root?.add(this.#matrix);
      }
      // The GPU scene's source record for this placement: the placement's own transform, the level it
      // reached, and a sphere the dispatch tests against the camera's planes. The part offset is the
      // key's own, so one record serves every part of the level — see `#placeSources`.
      if (this.#gpuScene.on) {
        const list = job.sources ?? [];
        job.sources = list;
        // The sphere is the asset's authored bounds *as placed*, centred where the bounds' centre
        // lands under the placement's own transform: a sphere at the placement instead is not a
        // bound of the placement, and every prop whose model does not straddle the origin lost the
        // half of itself that reaches away from it — a post, a stump, a fern, all of them culled at
        // the edge of the view with their bases outside it. The CPU path's own gate is the cell's box
        // over the same widened bounds, and it is conservative in exactly the way this is now. The
        // centre is the matrix applied to the authored centre, so the placement's quaternion rotates
        // it: composing the offsets by hand dropped the rotation and put a turned off-centre prop's
        // sphere where the unturned one would be. The radius is rotation-invariant and takes the
        // scale alone, which is uniform.
        const centre = this.#sourceCentre
          .set(
            ((bounds.min[0] as number) + (bounds.max[0] as number)) * 0.5,
            ((bounds.min[1] as number) + (bounds.max[1] as number)) * 0.5,
            ((bounds.min[2] as number) + (bounds.max[2] as number)) * 0.5,
          )
          .applyMatrix4(this.#matrix);
        list.push({
          level,
          matrix: this.#matrix.clone(),
          // `boundsRadius` is already the asset's authored bounds radius (half the diagonal), so the
          // placement's sphere radius is that times its own uniform scale — halving it again put the
          // sphere inside the prop and culled the half of it that reaches away from the placement.
          radius: boundsRadius * Math.abs(scale),
          // The magnitude, finite-sanitised: the dispatch's impostor gate takes `|scale|` exactly as
          // `levelAtGates` does, so a mirrored placement reaches the atlas the same way.
          scale: Number.isFinite(scale) ? Math.abs(scale) : 1,
          x: centre.x,
          y: centre.y,
          z: centre.z,
        });
      }
      // Authored bounds include model-part offsets; apply the whole placement transform so
      // rotated, mirrored and off-centre casters cannot fall outside visibility/shadow regions.
      this.#boundsAt(bounds, this.#matrix);
      const parts = asset.levels[level] as readonly IAssetPart[];
      const levelBatches = job.batches?.[level] as InstancedBatch[];
      const levelBoxes = job.boxes?.[level] as Box3[] | undefined;
      for (const [part, entry] of parts.entries()) {
        this.#instance.multiplyMatrices(this.#matrix, entry.local);
        (levelBatches[part] as InstancedBatch).add(this.#instance);
        const box = levelBoxes?.[part];
        if (box === undefined) continue;
        box.union(this.#recordBounds);
      }
    }
  }

  /**
   * Build one (level, part) batch into a mesh. One mesh is one unit, because this is where every
   * instance matrix is written and the batch's bounds are first computed — the part of admission the
   * renderer pays for again on the frame it first draws the result. The mesh joins the cell in
   * {@link #swap}, with the rest of the job, so it is never half a replacement.
   *
   * ponytail: a hard switch, no crossfade — a placement crosses a level boundary by being rebuilt
   * into the other level's batch, so the swap pops. A blend needs a per-instance mix the
   * InstancedBatch has no slot for; add one when a game's swap is visible enough to pay for it.
   */
  /**
   * Fold one batch's own filter point into the cell's bracket, which only ever widens. See
   * `IResidentCell.filterNear` and `#staleIn`.
   */
  #widenFilterRange(cell: IResidentCell, filterX: number, filterZ: number): void {
    const [near, far] = this.#span(cell, filterX, filterZ);
    if (near < cell.filterNear) cell.filterNear = near;
    if (far > cell.filterFar) cell.filterFar = far;
  }

  #buildOne(job: IBuildJob, batches: readonly InstancedBatch[][]): void {
    const { asset } = job;
    const { cell } = job;
    this.#widenFilterRange(cell, job.filterX, job.filterZ);
    let part = job.published;
    for (const [level, levelBatches] of batches.entries()) {
      if (part >= levelBatches.length) {
        part -= levelBatches.length;
        continue;
      }
      const box = job.boxes?.[level]?.[part];
      job.fresh.push({
        asset: asset.id,
        batch: levelBatches[part] as InstancedBatch,
        caster: undefined,
        casterSegment: -1,
        gpu: undefined,
        wide: undefined,
        wideSegment: -1,
        wideRoot: job.roots?.[level],
        lastFilterY: job.filterY,
        lastFilterX: job.filterX,
        lastFilterZ: job.filterZ,
        level,
        part,
        run: job.run,
        segment: -1,
        shared: undefined,
        // Where these records are, for the shadow invalidation this entry's swap hands over.
        shadowBounds: box === undefined || box.isEmpty() ? undefined : box,
        threshold: this.#reachRanges.get(cell.cell)?.has(asset.id)
          ? Math.min(asset.threshold ?? Number.POSITIVE_INFINITY, 6)
          : asset.threshold,
      });
      job.published += 1;
      return;
    }
  }

  /** The main pass's one mesh for an asset part at a level, covering every resident cell. */
  #sharedFor(assetId: string, entry: ICellBatch): SharedBatch | undefined {
    return this.#batchFor(assetId, entry, this.#keyOf(entry), "main", this.#receiveShadow);
  }

  /**
   * The shadow-caster cluster for one asset part at one level, or `undefined` when the level does
   * not cast or the frame's fresh allowance is spent.
   *
   * One per `(key, cluster)`, on `VIRTUAL_SHADOW_CASTER_LAYER` and off the main camera, so a level
   * culls the clusters its own window covers while the main pass keeps drawing one mesh per key.
   */
  #casterFor(
    assetId: string,
    entry: ICellBatch,
    cell: IResidentCell,
    level = entry.level,
  ): SharedBatch | undefined {
    // A world whose shadow levels draw its keys mints no cluster: the two are the same placements by
    // two routes, and a level's map can only draw one of them.
    if (!this.#casts(level) || this.#keysForShadow()) return undefined;
    return this.#batchFor(
      assetId,
      entry,
      `${this.#keyOf(entry, level)}@${this.#clusterOf(cell)}`,
      "cluster",
      false,
      level,
    );
  }

  /**
   * The wide caster for one asset part at one level, or `undefined` when the level does not cast or
   * the frame's fresh allowance is spent.
   *
   * One per key, holding every cell's records, on the wide caster layer: a level whose window
   * covers the whole resident ring pays one draw for the key instead of one per square, and the fine
   * levels that cull clusters never see this layer.
   */
  #wideFor(assetId: string, entry: ICellBatch, level = entry.level): SharedBatch | undefined {
    // As `#casterFor`: the key twin replaces both halves, so neither is minted.
    if (!this.#casts(level) || this.#keysForShadow()) return undefined;
    // A whole-asset impostor is one shape for every part and level, so its far shadow is ONE mesh per
    // asset holding one root record per placement, not one mesh per level whose records a source part
    // offset would then double. Every other asset keeps the per-key mesh its per-part shapes need.
    const impostor = this.#assets.get(assetId)?.impostor !== undefined;
    const key = impostor
      ? `${assetId}:*@${WIDE_CLUSTER}`
      : `${this.#keyOf(entry, level)}@${WIDE_CLUSTER}`;
    return this.#batchFor(assetId, entry, key, "wide", false, level);
  }

  /** `asset:level:part`, the main pass's one mesh per key. */
  #keyOf(entry: ICellBatch, level = entry.level): string {
    return `${entry.asset}:${String(level)}:${String(entry.part)}`;
  }

  /**
   * The level a cell batch casts with: its own when that level casts, otherwise the coarsest
   * casting level, when that level holds the same parts — a chain's derived levels do, authored
   * `lods` need not — so a tree past `castLevels` keeps its shadow in the last shape that has a
   * caster rather than leaving a hole in the map (PRD-541). `undefined`: it casts nothing.
   */
  #castLevelOf(entry: ICellBatch): number | undefined {
    if (this.#casts(entry.level)) return entry.level;
    if (this.#castShadowLevels === 0) return undefined;
    const asset = this.#assets.get(entry.asset);
    if (asset === undefined || asset.definition.lods !== undefined) return undefined;
    const level = Math.min(entry.level, this.#castShadowLevels) - 1;
    return asset.levels[level]?.[entry.part] === undefined ? undefined : level;
  }

  /**
   * Whether a shadow level draws this world's keys instead of its two caster halves: the GPU scene
   * is up *and* a provider registered on it, which `?tnShadowGpuKeys=1` is what asks for. Both, or
   * neither — a provider with the scene off is a world whose shadow maps have nothing to draw, so
   * the world keeps the caster path until both are true.
   */
  #keysForShadow(): boolean {
    return this.#gpuScene.on && this.#gpuScene.shadowKeys;
  }

  /**
   * The shadow twin of one main key: a second mesh on the key layer, over the shadow twin of the
   * dispatch's output, so a level's map submits one indirect draw for this key instead of one per
   * world-grid square the two caster halves split it into.
   *
   * Its records are never written — the twin buffers are the dispatch's, and this mesh's count is
   * its region's capacity — so it holds no instance buffer of its own and is minted at one slot.
   * Minted for the levels that cast, which is what the caster halves did and what the CPU path
   * already meant: a placement the dispatch routes to a level with no mesh casts nothing here,
   * exactly as it casts nothing from a caster half nobody minted.
   */
  #shadowKeyFor(key: IKeyDescriptor, part: IAssetPart): void {
    // Registered here rather than at construction, because it is a question about keys that exist:
    // a level's dispatch asks the provider for the keys a map draws, and the answer is this world's.
    // Without a provider the scene registers nothing, which is what keeps the flag from minting
    // anything at all; see `shadowGpuKeysRequested`.
    this.#gpuScene.shadowKeysFrom(() => this.#shadowKeyNames);
    if (this.#keysForShadow() === false || this.#casts(key.level) === false) return;
    const name = `${key.key}${GPU_KEY_SUFFIX}`;
    this.#shadowKeyNames.add(key.key);
    let shared = this.#shared.get(name);
    if (shared === undefined) {
      // A released twin keeps its uuid and the node three built for it, for the same reason a
      // caster half's does: rebinding is cheaper than a fresh mesh, and a fresh mesh is a fresh
      // node build inside a shadow pass.
      const released = this.#retired.get(name);
      if (released !== undefined) {
        this.#retired.delete(name);
        this.#retiredBytes -= this.#heldBytes(released);
        shared = released;
      } else {
        // A fresh mesh is charged against the frame's allowance like any other; the walk that runs
        // out of it comes back for this key rather than paying its build inside a shadow render.
        if (this.#freshThisUpdate >= this.#freshAllowance()) return;
        this.#freshThisUpdate += 1;
        shared = new SharedBatch(
          part.geometry,
          part.material,
          1,
          1,
          name,
          this.#extentBounds,
          "key",
        );
      }
      shared.rebind(part.geometry, part.material);
      shared.mesh.name = name;
      this.#dressMesh(shared, false);
      this.#shared.set(name, shared);
      this.#attach(shared);
      // Owed a draw, and shown because it is empty: a key is submitted by a shadow level, so the
      // build behind the gate is the prewarm's whole job. Only while the gate is still open — a key
      // streamed in afterwards owes nothing, exactly as a streamed caster half does not.
      if (this.#prewarm.settled === false) this.#prewarm.awaitDraw(shared);
    }
    this.#dressShadowKey(shared, key.key);
  }

  /**
   * Point a shadow key's mesh at the twins, with the same shape and the same reasons as
   * {@link #dressGpu}: the mesh's `instanceMatrix` becomes the scene's twin compaction buffer, its
   * geometry a view carrying this key's twin record over the same attributes, and its whole-mesh
   * frustum test off, because the dispatch tested every instance and the mesh's own bounds are the
   * resident ring. Idempotent, so a settled walk reads one comparison — and so a regrown twin, which
   * is a new attribute and a new pipeline like the main pass's, is re-dressed rather than left
   * pointing at the buffer the dispatch replaced.
   */
  #dressShadowKey(shared: SharedBatch, key: string): void {
    const scene = this.#gpuScene;
    // The twin record has to exist before a mesh can be dressed against it: a record minted inside
    // the render it would draw in is one render late for every key. Idempotent, and a no-op without
    // a provider.
    scene.shadowKey(key);
    const region = scene.shadowRegionOf(key);
    const drawn = scene.shadowDrawn;
    const args = scene.shadowArgs;
    const geometry = shared.mesh.geometry;
    if (
      drawn !== undefined &&
      shared.mesh.instanceMatrix === drawn &&
      shared.mesh.frustumCulled === false &&
      shared.gpuCount === region?.capacity &&
      geometry.indirect === args &&
      geometry.indirectOffset === (region?.argsIndex ?? -1) * DRAW_ARGS_BYTES
    )
      return;
    if (region === undefined || drawn === undefined || args === undefined) return;
    // The submission bound: three skips an `InstancedMesh` at count 0 before the GPU reads the
    // record, so a key with no instances of its own is submitted at its region's capacity and the
    // record decides. See `gpuCount`.
    shared.gpuCount = region.capacity;
    const mesh = shared.mesh;
    const view = indirectView(geometry, args, region.argsIndex * DRAW_ARGS_BYTES);
    // A fresh object for the same reason the main pass needs one: three binds the `instanceMatrix`
    // an object held when its node was built and keeps that binding for the object's whole life.
    if (mesh.instanceMatrix !== drawn) {
      const next = freshMeshFor(mesh, view, mesh.count) as ICasterScaleMesh;
      redressMaterial(next);
      this.#prewarm.carryPrewarm(mesh, next);
      this.#seat(shared.replaceMesh(next), next);
      next.instanceMatrix = drawn;
      next.frustumCulled = false;
    } else {
      mesh.geometry = view;
      mesh.instanceMatrix = drawn;
      mesh.frustumCulled = false;
    }
    // Shown and submitted whatever the records say: a key's own count is its region's capacity, and
    // the twin record inside is what decides how many instances this map draws of it. See
    // `SharedBatch#publish`. Never bundled — a bundle's record is fixed when it is recorded and only
    // the main pass's draws are replayed from it, so a shadow key in the group would be drawn by the
    // main camera's replay from the wrong buffer. See `#attach`.
    mesh.count = shared.gpuCount;
    mesh.visible = true;
  }

  /**
   * The geometry and material one caster half draws, and the one place the coarse shape is chosen.
   *
   * Only the wide half is coarse. A shadow level picks its granularity by bill — one mesh per square
   * on `VIRTUAL_SHADOW_CASTER_LAYER`, one mesh per key on the wide layer — so the wide half is what
   * the levels whose window holds the resident ring submit, and their texels are metres across: the
   * shape such a map resolves cannot tell level 0 from the asset's coarsest level, so it draws the
   * coarsest one per part and the triangles it saves are triangles no fragment ever sampled. A
   * cluster is the fine half, culled down to the squares one level's own window covers, so it keeps
   * the level the placement selected. An asset with one level is its own coarsest, and every half
   * draws what it draws today.
   */
  /**
   * The shape the coarse wide half draws for one `(level, part)`, or `fallback` when the level has no
   * honest coarse counterpart. Shared by {@link #shapeFor} and the prewarm, so the mesh minted behind
   * the gate carries the same geometry the swap would later ask for — a prewarm built from the
   * coarsest level's part 0 and then handed back unchanged is the wrong shape for good.
   */
  #wideShape(
    asset: IAssetState | undefined,
    level: number,
    part: number,
    fallback: IBatchShape,
  ): IBatchShape {
    if (this.#preserveAuthoredParts) return fallback;
    const terminal = asset?.levels.at(-1);
    // The whole-asset impostor is the one case where a part index has no meaning: it is a single
    // representation of every LOD0 part, so every part routes through it. `terminal?.[0]` is only
    // that shape. On the source-only path the terminal must have a part at this index with the same
    // role — an alpha slot drawn with an opaque part's shape (or vice versa) is a different object,
    // and a terminal with fewer parts must not fall back to part 0's, which duplicates it.
    if (asset?.impostor !== undefined) {
      const coarse = terminal?.[0];
      if (coarse !== undefined) return coarse;
    }
    const coarse = terminal?.[part];
    const source = asset?.levels[level]?.[part];
    if (
      coarse !== undefined &&
      source !== undefined &&
      isAlphaFoliage(source.material) === isAlphaFoliage(coarse.material)
    )
      return coarse;
    return fallback;
  }

  #shapeFor(
    entry: ICellBatch,
    role: "cluster" | "key" | "main" | "wide",
    level = entry.level,
  ): IBatchShape {
    // A batch cast at a finer level than its own (`#castLevelOf`) draws that level's part.
    const own =
      level === entry.level
        ? { geometry: entry.batch.geometry, material: entry.batch.material }
        : (this.#assets.get(entry.asset)?.levels[level]?.[entry.part] as IAssetPart);
    if (role === "wide")
      return this.#wideShape(this.#assets.get(entry.asset), level, entry.part, {
        geometry: own.geometry,
        material: own.material,
      });
    return { geometry: own.geometry, material: own.material };
  }

  /**
   * Whether this entry still owes a wide caster. A terminal whole-asset impostor is one part, and one
   * wide mesh per level already holds every placement: only part 0 opens it, so a walk pays one quad
   * per placement on the far shadow instead of one per bark/needle part.
   */
  #wideOwed(assetId: string, part: number): boolean {
    if (part === 0) return true;
    return this.#assets.get(assetId)?.impostor === undefined;
  }

  /** The `@x,z` half of a caster cluster key, for a resident cell. */
  #clusterOf(cell: IResidentCell): string {
    return clusterOf(cell.x, cell.z, this.#cellsPerCluster);
  }

  /**
   * The `@x,z` half of the main cull's own visibility-cell key, for a resident cell. This is what a
   * main batch's blocks are grouped by and what `#cullMainPass` tests, so it is the granularity the
   * main pass is culled at; the caster clusters above are the shadow levels' and are left alone.
   */
  #cullCellOf(cell: IResidentCell): string {
    return clusterOf(cell.x, cell.z, this.#cellsPerCullCell);
  }

  /**
   * The shared batch for one key, created (a new mesh: counted against the frame's fresh allowance)
   * the first time any cell draws it. `undefined` means the allowance is spent and the caller waits
   * a frame. A caster batch carries the shadow flags and the caster layer; a main batch casts
   * nothing, because its records reach the shadow maps through the caster cluster.
   *
   * The buffer starts with a block per cell that can hold this key, plus the one a refilter holds
   * alongside the blocks it replaces — the cluster's own cells for a caster cluster, the whole ring
   * for the main pass's one mesh per key — not the eight it used to start with. Sizing a main batch
   * by its cluster's cells left it with two blocks for a ring of dozens, so a walk filled the
   * buffer, `grow` minted a fresh mesh — a uuid three had never built a node for, in every shadow
   * pass too — and put the old one in an array nothing ever read. Those two sizes are ceilings, so
   * this is what stops growing. Cost: a main buffer is ring-sized for assets that never fill it;
   * give `residentCells` a smaller value if that outweighs a re-mint.
   */
  #batchFor(
    assetId: string,
    entry: ICellBatch,
    key: string,
    role: "cluster" | "key" | "main" | "wide",
    receiveShadow: boolean,
    level = entry.level,
  ): SharedBatch | undefined {
    const existing = this.#shared.get(key);
    if (existing !== undefined) return existing;
    const shape = this.#shapeFor(entry, role, level);
    const smallCaster = this.#smallCaster(assetId);
    // The batch released when this asset's last cell left the ring is the one to draw into again,
    // so the mesh keeps the uuid and the node three built for it. It costs no fresh allowance,
    // because it is not a fresh mesh.
    const released = this.#retired.get(key);
    if (released !== undefined) {
      this.#retired.delete(key);
      this.#retiredBytes -= this.#heldBytes(released);
      released.rebind(shape.geometry, shape.material);
      released.mesh.name = key;
      released.smallCaster = smallCaster;
      this.#dressMesh(released, receiveShadow);
      // A rebind swaps the geometry and may swap the buffer, so the key is dressed again: the indirect
      // record and the shared matrix buffer belong to the mesh, not to the batch.
      this.#adoptGpu(released, entry.asset, key, level, entry.part);
      this.#shared.set(key, released);
      this.#attach(released);
      return released;
    }
    if (this.#freshThisUpdate >= this.#freshAllowance()) return undefined;
    this.#freshThisUpdate += 1;
    const shared = new SharedBatch(
      shape.geometry,
      shape.material,
      this.#runMax.get(assetId) ?? entry.batch.count,
      // A caster cluster's block count is bounded by the cluster's own cells; a wide caster and the
      // main pass's one mesh per key are both bounded by the whole ring, so either way the one a
      // refilter holds beside the block it replaces.
      role === "cluster"
        ? this.#cellsPerCluster * this.#cellsPerCluster + 1
        : this.#budgets.residentCells + 1,
      key,
      this.#extentBounds,
      role,
    );
    shared.smallCaster = smallCaster;
    this.#dressMesh(shared, receiveShadow);
    this.#adoptGpu(shared, entry.asset, key, level, entry.part);
    this.#shared.set(key, shared);
    this.#attach(shared);
    return shared;
  }

  /**
   * The shadow half of the split, and the two granularities of it. A caster mesh lives alone on
   * `VIRTUAL_SHADOW_CASTER_LAYER` — one per world-grid square, which a level whose window is a
   * fraction of the ring culls down to the squares it covers — and a wide mesh alone on
   * `VIRTUAL_SHADOW_WIDE_CASTER_LAYER`, one per key, which a level whose window covers the ring
   * submits once. The level cameras draw one of the two layers and never both, so a key costs the
   * main pass one draw, a fine level a few and a wide level one. Neither receives: nothing but a
   * shadow level ever sees either. A main mesh keeps layer 0 and casts nothing, because its records
   * reach the shadow maps only through a caster half.
   */
  #dressMesh(shared: SharedBatch, receiveShadow: boolean): void {
    const mesh = shared.mesh;
    const role = shared.role;
    // Every role's records are written into the instance buffer, never moved in the world, and the
    // mesh is created and released per role — so this is the one place that covers a fresh mesh, a
    // rebound one and the three roles. Static here is only safe because every write announces
    // itself: `instanceMatrix.needsUpdate` bumps the attribute's version, which is what a settled
    // draw watches to know it still has to scan.
    markStatic(mesh);
    if (role !== "main") {
      mesh.layers.set(
        role === "cluster"
          ? VIRTUAL_SHADOW_CASTER_LAYER
          : role === "key"
            ? VIRTUAL_SHADOW_KEY_LAYER
            : shared.smallCaster
              ? VIRTUAL_SHADOW_SMALL_CASTER_LAYER
              : VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
      );
      mesh.castShadow = true;
      mesh.receiveShadow = false;
      return;
    }
    mesh.layers.set(0);
    mesh.castShadow = false;
    mesh.receiveShadow = receiveShadow;
    // The origin a draw of this mesh is counted under until the GPU scene dresses it
    // (`RenderPassBudget`). `#dressGpu` runs straight after this and overwrites it with `gpuScene`
    // when the key really is dressed, so what survives here is a main batch the CPU path draws per
    // object — a backend with no compute, `gpuScene: false`, or a dress that gave up. A caster half
    // returns above and keeps no origin: it lives off layer 0, so the main pass never counts it.
    mesh.userData.tnDrawSource = "instanced";
    // Nothing to hang off a main mesh: the window is narrowed by `#cullMainPass` for the whole set,
    // because a batch that drew nothing is hidden and three never reaches an invisible mesh's own
    // hooks — a mesh that could only re-narrow itself in its `onBeforeRender` would stay hidden for
    // as long as the camera looked away. That leaves `onBeforeRender` to the prewarm borrow alone.
  }

  /**
   * Parent one dressed main mesh under the world's single `BundleGroup`, so a settled frame replays
   * its draw instead of re-walking three's per-object path for it.
   *
   * A mesh is shown once, here, and never hidden again: the bundle's render list is fixed when it is
   * recorded, the dispatch already decided which instances each key draws, and an indirect draw of
   * zero instances is close to free on the GPU — where a `visible` write would force the whole group
   * to be recorded again. The prewarm draw this batch may still owe comes out of that same record.
   *
   * CPU joins and changed material revisions invalidate the record here, including a repaired mesh
   * joining on a settled frame. GPU dressing invalidates its completed record at the caller.
   *
   * A mesh whose draw needs a live pass is refused rather than recorded — a transmissive impostor or
   * a GPU batch reaching the framebuffer, the same answer a chunk's draws get. It keeps the per-object
   * path and the coarse gate that hides it, which is the path it was already on. See `bundleSafe`.
   */
  #bundleIn(shared: SharedBatch, reuseSafety = false): void {
    if (this.#bundlesWanted === false) return;
    // Shared batches normally carry one material. A mutable array keeps the existing per-object path
    // rather than compressing several material identities/revisions into an incomplete signature.
    const arrayMaterial = Array.isArray(shared.mesh.material);
    const checked =
      reuseSafety && !arrayMaterial
        ? this.#bundleSafety.test(shared.mesh.material as Material)
        : undefined;
    shared.bundlable = reuseSafety
      ? checked !== undefined &&
        !ownHook(shared.mesh, "onBeforeRender") &&
        !ownHook(shared.mesh, "onAfterRender") &&
        Reflect.get(shared.mesh, "isSkinnedMesh") !== true &&
        shared.mesh.morphTargetInfluences === undefined &&
        checked.safe
      : bundleSafe(shared.mesh);
    if (shared.bundlable === false) {
      if (shared.bundled) this.#bundleOut(shared);
      // A previously culled key may already be detached. Refusal still owes its live source draw.
      if (shared.mesh.parent !== this) this.add(shared.mesh);
      return;
    }
    const group = this.#shardOf(shared);
    if (checked !== undefined) {
      if (shared.bundled && shared.bundleMaterialRevision !== checked.revision)
        this.#bumpBundle(group);
      shared.bundleMaterialRevision = checked.revision;
    }
    if (shared.mesh.parent !== group) {
      group.add(shared.mesh);
      if (reuseSafety) this.#bumpBundle(group);
    }
    shared.bundled = true;
    shared.bundledCount = shared.mesh.count;
    // A recorded draw was cut from this camera's frustum, so the mesh's own whole-mesh test would drop
    // it the moment the camera turned away from a window the record still holds. Off, like a chunk's.
    shared.mesh.frustumCulled = false;
    shared.mesh.visible = true;
    // Read by `VirtualShadowNode#probe`, which must not hide a bundled mesh: the render list a bundle
    // recorded is fixed, and `visible = false` would take the mesh out of every record after the next
    // re-record. See `bundled`.
    shared.mesh.userData.tnBundled = true;
  }

  /**
   * Take a mesh back out of the group, because the key it was minted under is leaving the world.
   *
   * A retire is a structural change — the recorded bundle still holds this render object, and
   * replaying it would draw a key nothing owns — so it is one of the two events that re-records.
   */
  #bundleOut(shared: SharedBatch): void {
    if (shared.bundled === false) return;
    shared.bundled = false;
    shared.bundledCount = -1;
    shared.mesh.userData.tnBundled = false;
    // Back on the per-object path, so the mesh's own whole-mesh test is its gate again.
    shared.mesh.frustumCulled = true;
    const group = this.#bundles.get(mainShard(shared.mesh.name));
    if (group === undefined) return;
    if (shared.mesh.parent === group) group.remove(shared.mesh);
    this.#bumpBundle(group);
  }

  /** One re-record, counted: `BundleGroup.needsUpdate` is a version bump, and nothing else. */
  #bumpBundle(group: BundleGroup): void {
    this.#bundleRecords += 1;
    group.needsUpdate = true;
    if (this.#compileBusy) this.#recordedWhileBusy.add(group);
  }

  /**
   * Put one CPU-path main batch into the world's record, or take it out, by the coarse gate's answer.
   *
   * A main batch the GPU scene dresses is recorded from `#dressGpu`, because its submission bound is
   * its key's region capacity — a number only the dress writes, so the entry cannot go stale. A batch
   * the scene does not own submits its own CPU window instead, and that window is per frame: the gate
   * narrows it, a residency change repacks it, and a batch it narrows to nothing must draw nothing.
   * A record fixes its render list, so all three are the record's business rather than a `visible`
   * write the replay ignores. Hence this: the gate's answer is a join or a leave, a window that moved
   * or a count that changed is one more record, and `frustumCulled` is off because the record's own
   * list was cut by the same frustum when it was made.
   *
   * The trade is the one a cell's chunk record already makes and the visual A/B already judged: a
   * batch whose window is half the view draws the half that faced the camera when the record was cut.
   */
  #recordCpuMain(shared: SharedBatch, outcome: "settled" | "narrowed" | "repacked"): void {
    if (this.#bundlesWanted === false) return;
    // `#publish` has just written this frame's answer onto the mesh, which is the only place it is.
    if (shared.mesh.visible === false) {
      this.#bundleOut(shared);
      return;
    }
    this.#bundleIn(shared, true);
    if (shared.bundled === false) return;
    // The count a record freezes, and the layout behind it: a repack moves records inside the window
    // without moving its length, so the epoch answer and the count are both read here.
    if (outcome === "settled" && shared.mesh.count === shared.bundledCount) return;
    shared.bundledCount = shared.mesh.count;
    this.#bumpBundle(this.#shardOf(shared));
  }

  /**
   * Where a dressed main batch's mesh belongs: its key's main record shard, or the world itself when there is
   * none — a world with bundles off, a draw no record can replay, and the very first dress of a batch
   * the mint has not attached yet.
   *
   * It answers with the batch's own last refusal rather than re-asking, so the settled walk compares
   * parentage without walking a material graph per key per frame. See `bundleSafe`.
   */
  #bundleHome(shared: SharedBatch): Object3D | null {
    if (this.#bundlesWanted === false || shared.bundlable === false) return this;
    return this.#bundles.get(mainShard(shared.mesh.name)) ?? null;
  }

  /**
   * Attach one prepared chunk: to its cell's own record, or to the world when `bundles` is off.
   *
   * The group is minted with the first chunk the cell attaches, and a chunk added to it is a
   * structural change — the recorded list does not hold this render object and the replay would draw
   * the cell's chunks without it — so this is also the one re-record. See the `bundles` option for
   * why the group is per cell.
   *
   * Only the draws a bundle can replay are recorded, and they carry the `tnBundled` marker and the
   * frozen cull with them; the rest keep the per-object path. See `bundleSafe`.
   */
  #addChunk(cell: IResidentCell, chunk: Object3D): void {
    if (this.#bundlesWanted === false) {
      this.add(chunk);
      return;
    }
    // What the record can hold, and whether anything had to be left behind. A chunk whose every draw
    // is recorded goes in whole, which is one entry per chunk; a chunk holding a draw a bundle cannot
    // replay stays in the world and hands its safe draws to the record on their own, so one glass
    // window does not put the whole building back on the per-object path. See `bundleSafe`.
    const draws = chunkDraws(chunk);
    const recorded = draws.filter((mesh) => bundleSafe(mesh));
    if (recorded.length === 0) {
      this.add(chunk);
      return;
    }
    let entry = this.#chunkBundles.get(cell.key);
    if (entry === undefined) {
      const group = new BundleGroup();
      group.name = `${CHUNK_NAME}-bundles:${cell.key}`;
      this.add(group);
      entry = { cluster: clusterOf(cell.x, cell.z, this.#cellsPerCullCell), group };
      this.#chunkBundles.set(cell.key, entry);
    }
    const whole = recorded.length === draws.length;
    if (whole) entry.group.add(chunk);
    else {
      // The chunk keeps its own hierarchy around whatever it could not record, and each recorded
      // draw is attached rather than added so it keeps the world transform it was merged at. The root
      // it came out of travels with it, because that is what releases the draw again.
      this.add(chunk);
      for (const mesh of recorded) {
        mesh.userData.tnChunkRoot = chunk;
        entry.group.attach(mesh);
      }
    }
    // A recorded draw is frozen where it stands: the group is a child of the world at identity, so
    // its matrix will never move, and the freeze is what lets three's settled-object path skip the
    // per-object work for the draw a frame is not re-recording anyway. See `markStatic`.
    for (const mesh of recorded) {
      mesh.userData.tnBundled = true;
      mesh.frustumCulled = false;
      if (whole === false) markStatic(mesh);
    }
    this.#chunkBundleChildren += whole ? 1 : recorded.length;
    this.#bumpBundle(entry.group);
  }

  /**
   * Take a cell's chunk record out of the world, because the cell that owned every chunk in it has
   * left: a record nothing owns must not be replayed, and the cell coming back mints its own.
   *
   * A chunk the bake split left its recorded draws in the group rather than under their own root, so
   * each goes back to the root it came out of first: the caller's own disposal walk finds them there,
   * and a draw released by neither is a buffer nothing ever asks for again.
   */
  #dropChunkBundles(cell: IResidentCell): void {
    const entry = this.#chunkBundles.get(cell.key);
    if (entry === undefined) return;
    this.#chunkBundles.delete(cell.key);
    const roots = new Set(cell.chunks);
    // Counted before anything leaves the group, because that is what it is holding.
    this.#chunkBundleChildren -= entry.group.children.length;
    for (const child of entry.group.children) {
      const root = child.userData.tnChunkRoot as Object3D | undefined;
      if (roots.has(child) === false && root !== undefined) {
        child.userData.tnChunkRoot = undefined;
        root.attach(child);
      }
    }
    entry.group.removeFromParent();
    this.#bumpBundle(entry.group);
  }

  /** The main-record shard a batch's key lands in, minted as a child of the world on first use. */
  #shardOf(shared: SharedBatch): BundleGroup {
    const shard = mainShard(shared.mesh.name);
    let group = this.#bundles.get(shard);
    if (group === undefined) {
      group = new BundleGroup();
      group.name = "world-main-bundles";
      this.add(group);
      this.#bundles.set(shard, group);
    }
    return group;
  }

  /** The recorded main batches, over every shard. */
  #mainBundleChildren(): number {
    let children = 0;
    for (const group of this.#bundles.values()) children += group.children.length;
    return children;
  }

  /**
   * Where a freshly bound or grown main batch's mesh goes: the bundle group when it has been dressed
   * into one, the world otherwise. Three re-parents on `add`, so a bundled mesh has to be asked for
   * or it silently leaves the group it was recorded in.
   */
  #attach(shared: SharedBatch): void {
    // A grow replaces the mesh object, so the marker `#bundleIn` set has to follow the batch's own
    // flag onto it. See `bundled`.
    shared.mesh.userData.tnBundled = shared.bundled;
    if (shared.bundled === true) this.#shardOf(shared).add(shared.mesh);
    else this.add(shared.mesh);
    // A record holds the object it was cut from, so a mesh that arrived by a rebind or a grow is not
    // the one the last record named: one re-record, and the record counts this mesh from here.
    if (shared.bundled === true) {
      shared.mesh.frustumCulled = false;
      shared.bundledCount = shared.mesh.count;
      this.#bumpBundle(this.#shardOf(shared));
    }
  }

  /**
   * Name one main key to the GPU scene, and dress its mesh against the scene's live buffers.
   *
   * A caster or wide key is named `@x,z` or `@*` and belongs to the shadow passes, which the GPU scene
   * does not touch, so those are left exactly as they were.
   *
   * The key is recorded whether or not the scene is on, because a prewarm mints a whole ring before
   * the first frame that can answer whether this backend can run the scene, and a key recorded only
   * when the dress happened is a key the scene is never told about. `#seedGpuKeys` comes back for
   * those; see there.
   */
  #adoptGpu(shared: SharedBatch, assetId: string, key: string, level: number, part: number): void {
    if (shared.role !== "main") return;
    const named = { asset: this.#canonical(assetId), key, level, part };
    shared.main = named;
    if (this.#gpuScene.on === false) return;
    shared.gpu = named;
    this.#dressGpu(shared, named);
  }

  /**
   * Point one main key's mesh at the GPU scene's buffers, and hand the asset's gate table over.
   *
   * The mesh's `instanceMatrix` becomes the shared compacted matrix buffer, its geometry a clone that
   * shares the part's own attributes and carries this key's indirect record, and its whole-mesh
   * frustum test is off — the dispatch already tested every instance against the camera's six
   * planes, and the mesh's own bounds are the whole resident ring. Idempotent: a settled frame's
   * buffers are the ones it was dressed against, and a regrow, a rebind or a `grow` replaces them,
   * which is the only thing that brings a dressed mesh back through here.
   *
   * A key whose placements outgrew its region is regrown here rather than silently dropping instances
   * against the capacity guard, which is what a fixed ceiling did to any key a walk filled past.
   *
   * The buffers are read after `scene.key` rather than before it, because minting the first key is
   * what allocates them: a dress that gave up on their absence was a dress that never happened, and
   * the only frame that would have retried it was one whose fast path had already found the mesh
   * dressed. A regrow replaces them, so the attribute handed to the mesh is the one a draw will read.
   */
  #dressGpu(shared: SharedBatch, key: IKeyDescriptor): void {
    const scene = this.#gpuScene;
    const asset = this.#assets.get(key.asset);
    const part = asset?.levels[key.level]?.[key.part];
    if (asset === undefined || part === undefined) return;
    // The asset's own resident placements, not one level's share of them: a placement's level is
    // decided per frame from where the camera is, so every level's region has to hold all of them.
    const capacity = Math.max(shared.liveCeiling, this.#gpuResident.get(key.asset) ?? 0);
    const settled = scene.drawn;
    const held = scene.regionOf(key.key);
    // The args buffer and the drawn buffer are allocated and grown independently: minting a key
    // grows `args` and leaves `drawn` the object it was, so the mesh's `instanceMatrix` and its
    // indirect record can point at two different generations. The fast path used to watch only
    // `drawn`, and a mesh left holding an old args record was one the dispatch no longer wrote —
    // a forest that drew nothing while the readback said the counts were correct.
    const geometry = shared.mesh.geometry;
    const liveArgs = scene.args;
    const bound =
      liveArgs !== undefined &&
      geometry.indirect === liveArgs &&
      geometry.indirectOffset === (held?.argsIndex ?? -1) * DRAW_ARGS_BYTES;
    if (
      settled !== undefined &&
      shared.mesh.instanceMatrix === settled &&
      shared.mesh.frustumCulled === false &&
      (held?.capacity ?? 0) >= capacity &&
      bound &&
      // Where the mesh hangs is part of what this pass owns: a batch that was retired and handed back
      // by a rebind is a child of the world again, and the bundle that last recorded it no longer
      // draws it. Without this the walk would re-mint a key into a bundle that is missing it.
      shared.mesh.parent === this.#bundleHome(shared)
    ) {
      // A sibling may have grown the level's capacity without moving this mesh, so the submission
      // bound follows the live region rather than the dress that wrote it. See `gpuCount`.
      shared.gpuCount = held?.capacity ?? shared.gpuCount;
      this.#shadowKeyFor(key, part);
      return;
    }
    const region = scene.key(key.key, new Float32Array(part.local.elements), capacity, {
      group: `${key.asset}:${String(key.level)}`,
      part: key.part,
      // The whole run at once, so a part minted later lands in the slot `firstKey + part` names
      // rather than at the end of the key space, where another level's key is in between.
      parts: (asset.levels[key.level] as readonly IAssetPart[]).length,
    });
    if (region === undefined) return;
    const drawn = scene.drawn;
    const args = scene.args;
    const args2 = scene.regionOf(key.key);
    if (drawn === undefined || args === undefined || args2 === undefined) return;
    // Before the mesh is dressed, so the republish a replacement does takes the dressed branch and
    // submits at this bound rather than at a zero the CPU never drew. See `gpuCount`.
    shared.gpuCount = args2.capacity;
    // Before the mesh is dressed, so the republish a replacement does takes the dressed branch: a
    // batch that draws from the scene's buffers is shown by the per-asset gate in `#cullMainPass`,
    // not by its own count.
    shared.gpu = key;
    const mesh = shared.mesh;
    // Its own geometry object, so the indirect record is this mesh's, over the SAME attributes: the
    // original is the shape the caster halves and a rebind still draw with. `clone()` would copy
    // every vertex buffer of every key a second time.
    const view = indirectView(mesh.geometry, args, args2.argsIndex * DRAW_ARGS_BYTES);
    // A mesh three has already compiled cannot be re-dressed by writing fields onto it: its node
    // binds the `instanceMatrix` the object held at that compile, and three keeps that binding for
    // the object's whole life. A regrow is the same case — a new `drawn` attribute is a new binding
    // for the same reason — so both take the same road: a fresh object carrying everything the old
    // one had, and the old one let go. Measured on machinefall, where the prewarm had compiled every
    // main batch on the CPU path: 3,724 indirect draws submitted in 2 s over records that were
    // correct at draw time, and a dressed forest that drew nothing, until the meshes were fresh
    // objects; a material of its own (below) never changed that on its own.
    if (mesh.instanceMatrix !== drawn) {
      const next = freshMeshFor(mesh, view, mesh.count) as ICasterScaleMesh;
      redressMaterial(next);
      this.#prewarm.carryPrewarm(mesh, next);
      this.#seat(shared.replaceMesh(next), next);
      next.instanceMatrix = drawn;
      next.frustumCulled = false;
    } else {
      mesh.geometry = view;
      mesh.instanceMatrix = drawn;
      mesh.frustumCulled = false;
    }
    // What the record has to say for the draw to name a triangle: the view's own index count, which
    // is the shape this key draws. The scene is told rather than left to guess, so its validation can
    // hold the record against it.
    scene.indexCount(key.key, view.index?.count ?? 0);
    // The asset's gate table is built from the keys minted so far, so a level whose key is not minted
    // yet carries no parts and the dispatch draws that level nowhere. Re-registering is a no-op while
    // the table holds, and a rewrite when a key joined it.
    scene.slot(key.asset, this.#gatesOf(key.asset, asset));
    // The origin this key's main-pass draws are counted under, read off the object at the draw
    // (`RenderPassBudget`). Written after the mesh swap above, so a re-dressed fresh object carries
    // it, and before `#bundleIn`, which supersedes it with `tnBundled` for a world with bundles on.
    shared.mesh.userData.tnDrawSource = "gpuScene";
    // The bundle the last settled frame replayed is now wrong: this pass minted or regrown a key,
    // swapped the geometry, or took a fresh mesh object onto the scene's new buffers. Reaching here
    // is one of the three, which is why this is the only place a re-record happens — the fast path
    // above is every other frame of the walk.
    this.#bundleIn(shared);
    if (shared.bundled === true) this.#bumpBundle(this.#shardOf(shared));
    // The shadow twin of this key, minted and dressed on the same pass that named the main one: a
    // level that draws keys finds its mesh in the same frame the main pass found its buffer, and a
    // regrown twin is re-dressed here rather than left on the buffer the dispatch replaced.
    this.#shadowKeyFor(key, part);
  }

  /**
   * The replacement takes the old object's place, and the old one is let go: `InstancedMesh.dispose`
   * frees nothing the replacement shares — the vertex buffers and the part's own material belong to
   * the refcount path that made them.
   *
   * Through `add` and `removeFromParent` rather than by writing `parent` and `children`, because
   * three fires `childadded`/`childremoved` on the way and the clustered-mesh tracker answers the
   * world's arrivals and departures by those alone. The old slot is restored afterwards, so the
   * parent's traversal order — and so every draw's order within a frame — is what it was.
   */
  #seat(old: InstancedMesh, next: InstancedMesh): void {
    const parent = old.parent;
    if (parent === null) this.add(next);
    else {
      const at = parent.children.indexOf(old);
      old.removeFromParent();
      parent.add(next);
      const here = parent.children.indexOf(next);
      if (at >= 0 && here >= 0) {
        parent.children.splice(here, 1);
        parent.children.splice(at, 0, next);
      }
    }
    old.dispose();
  }

  /**
   * The asset's own gates, as the kernel reads them: the CPU path's switch distances and cull
   * distance, and the scene key each level's parts draw into. A level with no minted key has no parts,
   * so the dispatch draws nothing at that level rather than reading a key that is not there.
   */
  #gatesOf(id: string, asset: IAssetState): IAssetSlot {
    const gates: { firstKey: number; parts: number }[] = [];
    // The level's own contiguous run, which is what the kernel's `firstKey + part` addresses. Read
    // back from the scene rather than remembered here: a table that recorded the key index it saw
    // last named the wrong part as the first, and a multi-part asset then drew nothing anywhere.
    for (const [level] of asset.levels.entries())
      gates.push(this.#gpuScene.levelKeys(`${id}:${String(level)}`) ?? { firstKey: 0, parts: 0 });
    return {
      cull: cullDistance(asset.definition.maxDistance),
      distances: asset.distances,
      // The dispatch scales the whole-asset impostor's terminal gate by each placement's own scale;
      // the same flag the live-state reference reads, so the two cannot cross it differently.
      impostor: asset.impostor !== undefined,
      levels: gates,
    };
  }

  /**
   * Rebuild every resident run once, so a scene that came up after the ring was built is given the
   * source records it was built without.
   *
   * `WorldCells.update` can be called before it has a renderer, and a renderer that is not WebGPU
   * never turns the scene on at all; either way the cells that were swapped in while it was off hold
   * placements the dispatches have never heard of, and nothing else in the class would ever hand them
   * over. One rebuild of the ring is the whole fix, and it is the same build every first-seen asset
   * takes: `replace` keeps the old batches drawn until each new one is attached, so the rebuild is
   * not a frame of holes.
   */
  #seedGpuSources(): void {
    // A pending build may already have consumed CPU-only slices. Restart it before any swap can
    // publish a partial source list; its outgoing batches keep drawing until the new build lands.
    const pending = this.#jobs;
    this.#jobs = [];
    for (const job of pending) {
      this.#queued.delete(job.run);
      for (const entry of job.fresh) this.#clearSegment(entry);
      this.#queueBuild(job.asset, job.cell, job.run, true, job.force);
    }
    for (const cell of this.#resident.values())
      for (const batch of cell.batches) {
        const asset = this.#assets.get(batch.asset);
        if (asset === undefined || asset.levels.length === 0) continue;
        // One rebuild per run, not per batch: a run's placements are one build, and queueing it per
        // batch would rebuild the same placements once per level and part.
        this.#queueBuild(asset, cell, batch.run, true);
      }
  }

  /**
   * Dress every main batch the world already holds, the mirror of {@link #seedGpuSources} for the
   * keys rather than the sources: the keys a prewarm minted on the loading screen were minted with
   * the scene off, and a key is only named at mint time, so a ring built that way came up with an
   * empty region table and every batch still drawing from its own buffer. The dispatch was drawing
   * 21,094 placements into no region at all, and the validation marker said so — `compared=0` — for
   * a scene that reported itself on.
   *
   * The pool is seeded with the rest: a retained key's mesh is handed back by a rebind rather than
   * re-minted, and rebinding replaces the instance buffer, so a parked batch is undressed by the
   * park and dressing it here is what leaves the walk with a key that is already in the table. From
   * here every main batch carries `gpu`, which is what puts it on the dispatch's per-instance answer
   * and off the CPU repack and the refilter.
   */
  #seedGpuKeys(): void {
    for (const shared of [...this.#shared.values()]) this.#seedGpuKey(shared);
    for (const shared of this.#retired.values()) this.#seedGpuKey(shared);
  }

  /** Dress one undressed main batch, or leave a batch the scene does not touch. */
  #seedGpuKey(shared: SharedBatch): void {
    // `main` is the key; `gpu` is the mesh pointing at the scene's buffers. A dressed mesh is left
    // alone, and `#dressGpu` says so itself — it is idempotent against the buffers it was given.
    if (shared.main === undefined || shared.gpu !== undefined) return;
    this.#dressGpu(shared, shared.main);
  }

  /**
   * The main meshes the scene owns and the main meshes the world holds, live and pooled, which is
   * the `dressed=N/M` the marker carries. A scene reporting itself on over a ring it never dressed
   * read `dressed=0/21094` on nothing, so the number is the owner's: the scene cannot see the meshes.
   */
  #gpuCensus(): { readonly dressed: number; readonly meshes: number } {
    let dressed = 0;
    let meshes = 0;
    for (const batch of [...this.#shared.values(), ...this.#retired.values()]) {
      if (batch.role !== "main") continue;
      meshes += 1;
      if (batch.gpu !== undefined) dressed += 1;
    }
    return { dressed, meshes };
  }

  /**
   * Every dressed main mesh's own draw, and what this class's **live** state says it must be holding.
   *
   * The scene's own validation mirrors its own kernel, so a key, a record, a gate table and a mesh
   * that do not correspond are one both sides reproduce and a check that reports `ok` over a forest
   * drawn with another tree's geometry. These are the three numbers that are not the scene's: the
   * mesh's own name, the record its own geometry points at (`indirectOffset`, which a dress wrote),
   * and the instances the owner's own state selects for that name — `asset.distances` as
   * {@link levelAt} reads it right now, `cullDistance(definition.maxDistance)`, the camera's own six
   * planes over the scene's own placements, and each part's own offset composed in exactly as the
   * dispatch composes it.
   *
   * Not the per-cell records this path's own refilter left behind: the GPU scene bypasses that
   * refilter, so the moment it does, the records a mesh is checked against are a snapshot of a
   * level selection that no longer applies. A far placement is then compared against a set that
   * counted it at its near level, and the check reads `ok` over the picture it cannot see.
   */
  #gpuDraws(): readonly IMeshDraw[] {
    const camera = this.#chunks.camera;
    if (camera === undefined) return [];
    const lives = this.#liveGates();
    if (lives.size === 0) return [];
    // The dispatch's own camera, its own planes: this is asked for inside the dispatch that is
    // running, so the eye and the six planes are the ones the kernel is reading now.
    const planes = this.#gpuPlanes;
    _cullFrustum.setFromProjectionMatrix(
      _cullProjScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    for (const [index, plane] of _cullFrustum.planes.entries()) {
      const at = index * 4;
      planes[at] = plane.normal.x;
      planes[at + 1] = plane.normal.y;
      planes[at + 2] = plane.normal.z;
      planes[at + 3] = plane.constant;
    }
    _gpuEye.setFromMatrixPosition(camera.matrixWorld);
    const expected = liveKeyInstances(
      this.#gpuScene.placements,
      (slot) => {
        const id = this.#gpuScene.slotAsset(slot);
        return id === undefined ? undefined : lives.get(id);
      },
      { planes, x: _gpuEye.x, y: _gpuEye.y, z: _gpuEye.z },
    );
    const draws: IMeshDraw[] = [];
    const args = this.#gpuScene.args;
    for (const shared of this.#shared.values()) {
      if (shared.role !== "main" || shared.gpu === undefined) continue;
      const geometry = shared.mesh.geometry;
      // `indirectOffset` is typed as an offset or a list of them; a scene's own record is one
      // number, and a list is not a record this check can name, so it is not compared.
      const offset = geometry.indirectOffset;
      if (geometry.indirect === undefined || typeof offset !== "number") continue;
      const region = this.#gpuScene.regionOf(shared.mesh.name);
      draws.push({
        // The actual binding, asked of the mesh and the scene at this turn, not the record number:
        // an offset can name the right record while the mesh reads an older args buffer with the
        // same layout, and the field is what lets the check see a stale binding at all.
        bound:
          args !== undefined &&
          geometry.indirect === args &&
          offset === (region?.argsIndex ?? -1) * DRAW_ARGS_BYTES,
        instances: expected.get(shared.mesh.name) ?? new Float32Array(0),
        name: shared.mesh.name,
        record: offset / DRAW_ARGS_BYTES,
      });
    }
    return draws;
  }

  /**
   * Every adopted asset's own gates as they stand right now, keyed by id.
   *
   * The part offsets are copied out of each part's `Matrix4` once per check, because the composition
   * reads them as `Float32Array`s and a part's matrix is what the dispatch already composed with.
   */
  #liveGates(): Map<string, ILiveAsset> {
    const out = new Map<string, ILiveAsset>();
    for (const asset of this.#assets.values()) {
      if (asset.levels.length === 0) continue;
      const locals: Float32Array[][] = [];
      for (const parts of asset.levels) {
        const level: Float32Array[] = [];
        for (const part of parts) level.push(Float32Array.from(part.local.elements));
        locals.push(level);
      }
      out.set(asset.id, {
        cull: cullDistance(asset.definition.maxDistance),
        distances: asset.distances,
        id: asset.id,
        impostor: asset.impostor !== undefined,
        locals,
      });
    }
    return out;
  }

  /**
   * The source records one swapped-in entry draws from: one per placement, not per part, because the
   * part's own offset is the key's and the dispatch composes it. Every part of the level shares the
   * list, which is why releasing one is idempotent and a whole level's records are handed back by the
   * first of its entries that leaves.
   */
  #placeSources(job: IBuildJob, entry: ICellBatch): number[] | undefined {
    const sources = job.sources;
    if (sources === undefined) return undefined;
    const asset = this.#assets.get(entry.asset);
    if (asset === undefined) return undefined;
    const slot = this.#gpuScene.slot(entry.asset, this.#gatesOf(entry.asset, asset));
    if (slot < 0) return undefined;
    const byLevel = job.gpuByLevel ?? new Map<number, number[]>();
    job.gpuByLevel = byLevel;
    const held = byLevel.get(entry.level);
    // A sibling part of this level shares the list already placed, and counts its own halves for
    // itself: `#gpuResident` is the asset's, so this half's records are counted here.
    if (held !== undefined) {
      this.#countPlaced(entry, held.length);
      return held;
    }
    const records: number[] = [];
    for (const source of sources)
      if (source.level === entry.level) {
        const at = this.#gpuScene.place(
          slot,
          source.matrix,
          source.x,
          source.y,
          source.z,
          source.radius,
          source.scale,
        );
        if (at >= 0) records.push(at);
      }
    byLevel.set(entry.level, records);
    // What a key of this asset has to be able to hold, on any level: see `#dressGpu`.
    this.#gpuResident.set(entry.asset, (this.#gpuResident.get(entry.asset) ?? 0) + records.length);
    this.#countPlaced(entry, records.length);
    return records;
  }

  /**
   * The placed sources one cell's block contributed, carried onto the two caster halves behind it —
   * `gpuPlaced`, the count `#publishCasterAdmission` measures a half against its own live records.
   *
   * One place for both halves and both directions, because `#gpuResident` counts the asset once and a
   * half counts only what its own block contributed: every part of a level shares one list of placed
   * sources and each half needs its own answer. Negative is the release path's way back down.
   */
  #countPlaced(entry: ICellBatch, placed: number): void {
    if (entry.caster !== undefined) entry.caster.gpuPlaced += placed;
    if (entry.wide !== undefined) entry.wide.gpuPlaced += placed;
  }

  /** The world-grid square the follow point is in, as the `@x,z` half of a cluster key. */
  #followCluster(): string {
    return clusterOf(
      Math.floor((this.#follow.position.x - this.#minX) / this.#cellSize),
      Math.floor((this.#follow.position.z - this.#minZ) / this.#cellSize),
      this.#cellsPerCluster,
    );
  }

  /** What a released batch costs to keep: its instance buffer, which is all of it. */
  #heldBytes(shared: SharedBatch): number {
    return (shared.mesh.instanceMatrix.array as Float32Array).byteLength;
  }

  /**
   * Keeps a released batch for the walk back, or drops it.
   *
   * Empty is the precondition, and `#evict` guarantees it: it clears a cell's own block before the
   * refcount falls, and the refcount is what calls this. A batch that still holds records means the
   * buffer state cannot be trusted, so it goes the same way as one over the byte budget.
   */
  #retire(key: string, shared: SharedBatch): void {
    // Live records, not the draw window: a main batch whose squares are all behind the camera still
    // holds its records, and that is not a batch to dispose.
    if (shared.live > 0) {
      shared.mesh.dispose();
      return;
    }
    // Parked before the budget is measured, or the retained set is charged for buffers nothing keeps
    // and the byte budget evicts entries as they arrive — the walk then finds nothing to hand back
    // and mints a second mesh for every key it returns to.
    shared.park();
    const bytes = this.#heldBytes(shared);
    this.#retired.delete(key);
    this.#retired.set(key, shared);
    this.#retiredBytes += bytes;
    for (const [oldest, held] of this.#retired) {
      if (this.#retiredBytes <= RETIRED_SHARED_BYTES) break;
      this.#retired.delete(oldest);
      this.#retiredBytes -= this.#heldBytes(held);
      held.mesh.dispose();
    }
  }

  /**
   * Whether this level's own batches cast. Only the caster clusters ask; a main mesh never casts, so
   * the shadow map holds exactly the cluster meshes a level's window covers.
   */
  #casts(level: number): boolean {
    return this.#castShadowLevels > level;
  }

  /**
   * An asset too small to resolve in any window but the finest one's, so its wide caster goes on
   * that level's layer alone. Measured on the authored bounds the package carries, which is the one
   * number a world has for every asset it never loaded a tree for.
   */
  #smallCaster(assetId: string): boolean {
    const bounds = this.#manifest.assets[assetId]?.bounds;
    if (bounds === undefined) return false;
    return bounds.max[1] - bounds.min[1] < this.#smallCasterMetres;
  }

  /**
   * A block in `shared` for one cell's `count` records, growing the buffer when it is full. `cluster`
   * is the world-grid square the cell sits in, and only a main batch keeps it: its draw window is
   * narrowed per square, and a square is a grouping, not a position.
   */
  #segmentIn(shared: SharedBatch, count: number, cluster?: string): number | undefined {
    const segment = shared.allocate(count, cluster);
    if (segment !== undefined) return segment;
    // A dressed batch's grow is logical: it raises the ceiling the GPU scene sizes this key's region
    // from and mints no mesh, so the fresh-mesh allowance — which bounds new pooled meshes and their
    // node builds — does not gate it. A CPU grow is a real replacement mesh and still respects it.
    if (shared.gpu === undefined && this.#freshThisUpdate >= this.#freshAllowance())
      return undefined;
    const old = shared.grow();
    // Only a real replacement is a new object to dress, attach and hand to the pool; a logical GPU
    // grow keeps the live mesh, which `#dressGpu` re-points at the grown region before the draw.
    if (old !== undefined) {
      this.#freshThisUpdate += 1;
      // The replacement is a different object, so the layer and the cull hook `grow` copied neither of
      // have to be dressed onto it again — a grown caster that kept layer 0 would be drawn by the main
      // camera and lost to the shadow level, and a grown main batch would stop narrowing at all.
      this.#dressMesh(shared, shared.role === "main" && this.#receiveShadow);
      this.#attach(shared);
      // The mesh this grow replaced goes back to the pool: a cached shadow level can still replay a
      // draw of it until its window next moves, and the pool keeps the buffer and the uuid rather
      // than letting one array of retired meshes grow without bound.
      parkMesh(old);
    }
    return shared.allocate(count, cluster);
  }

  /**
   * One model, from the loader the package was given. `loadModel` keeps the override and takes the
   * authored url, so a game's own GLB loader is unchanged; without it the logical path goes to
   * `assets.model`, which is what makes a compiled package and its KTX2 textures work.
   */
  #model(path: string): Promise<Object3D> {
    return this.#loadModel === undefined
      ? loadModelWith(this.#loader, path)
      : this.#loadModel(resolveRelative(this.#baseUrl, path));
  }

  /**
   * Every level of one asset, through the same limiter and the same resolution as `lod0`, so a
   * package's compiled output and compressed textures reach the renderer the game booted with. One
   * level refusing is not the asset refusing: it is counted and `#adoptAsset` falls back to the
   * level below it, so the far placements still draw.
   */
  #startAssetLoad(asset: IAssetState): void {
    asset.pending = true;
    // The source models this state asks `assets.model` for are this world's to hand back; the
    // loader caches by logical path and would otherwise pin every texture for the world's life.
    // Counted once per state, so a load retried after an empty answer does not double-count.
    // `loadModel` overrides the cache entirely, so it retains nothing.
    if (this.#loadModel === undefined && asset.retainedPaths.length === 0) {
      this.#retainModelPaths(
        Array.from(asset.glbs, (glb) => resolveRelative(this.#logicalBase, glb)),
        asset.retainedPaths,
      );
    }
    const wanted = (): boolean =>
      !this.#released && this.#assets.get(asset.id) === asset && !asset.disposed;
    // `Promise.all` hands back the levels in `glbs` order, and the limiter is what bounds them: it
    // already caps every load in flight across the resident cells, assets and chunks together.
    const loads: Array<Promise<Object3D | undefined>> = [];
    for (const glb of asset.glbs) {
      const path = resolveRelative(this.#logicalBase, glb);
      loads.push(
        this.#limiter
          .load(() => this.#model(path), wanted)
          .catch((error: unknown) => {
            asset.failed = true;
            this.#failures += 1;
            this.#reportCellFailure("asset", asset.id, [path], error);
            return undefined;
          }),
      );
    }
    // The cooked url LOD0 was actually fetched from, resolved the same way `assetSignature` does,
    // so the atlas key names the bytes rather than the package entry. It is needed before adoption,
    // so the two promises are awaited together; a path the loader cannot resolve falls back to the
    // logical url, exactly as `assetSignature`'s caller does.
    const lod0 = resolveRelative(this.#logicalBase, asset.glbs[0] as string);
    const resolved = this.#loader
      .resolve(lod0)
      .then((candidates) => candidates[0] ?? lod0)
      .catch(() => lod0);
    void Promise.all([Promise.all(loads), resolved]).then(([models, url]) => {
      // The state stays, refcount and all, whatever the loads answered: cells still resident are
      // holding it, and the next acquire retries. Dropping it here would let a later cell refcount
      // from zero and hand an eviction of an old cell the geometry a still-resident cell draws.
      asset.resolvedGlb = url;
      asset.pending = false;
      this.#adoptAsset(asset, models);
    });
  }

  /** One loaded model's drawable parts, or `undefined` when it carries nothing to draw. */
  #partsOf(model: Object3D | undefined): readonly IAssetPart[] | undefined {
    if (model === undefined) return undefined;
    const parts = renderableParts(model, (material) => this.#surfaceFor(material));
    if (parts.length === 0) {
      // Same as a refused load: counted, released, and the next acquire retries.
      this.#failures += 1;
      this.#failures += this.#disposeLoaded(model);
      return undefined;
    }
    return parts;
  }

  /**
   * One part list per loaded model: level 0 is the asset's own shape, and every level below it
   * falls back to the one above when it did not load. `undefined` is the asset refusing to exist —
   * no `lod0` to fall back to — and the levels that did load are released rather than held by an
   * asset that draws nothing, cutout clones included. The refcounted state stays either way, so the
   * next acquire retries.
   */
  #adoptLevels(
    models: readonly (Object3D | undefined)[],
  ): readonly (readonly IAssetPart[])[] | undefined {
    const levels: (readonly IAssetPart[])[] = [];
    for (const [index, model] of models.entries()) {
      const level = this.#partsOf(model) ?? levels[index - 1];
      if (level === undefined) {
        for (const model of models.slice(index)) this.#failures += this.#disposeLoaded(model);
        for (const parts of levels) this.#failures += this.#releaseParts(parts);
        return undefined;
      }
      levels.push(level);
    }
    return levels;
  }

  /**
   * An asset's levels are in, so every resident cell holding it needs its batches — queued, not
   * built. This is the path that used to be worst: adopting one asset rebuilt every resident cell's
   * batches for it in a single frame, and a 218-asset package pays it over and over as the ring
   * moves. The queue turns it into the same per-frame allowance every other admission path gets.
   */
  #adoptAsset(asset: IAssetState, models: readonly (Object3D | undefined)[]): void {
    if (this.#released || this.#assets.get(asset.id) !== asset || asset.disposed) {
      for (const model of models) this.#failures += this.#disposeLoaded(model);
      return;
    }
    asset.hlodSafe = models[0] !== undefined && cellProxySourceSafe(models[0]);
    const adopted = this.#adoptLevels(models);
    if (adopted === undefined) {
      // A far-only asset that would not load has nothing to bake; drop the temporary reference so
      // the source it did fetch is not held for the world's whole life.
      if (this.#impostorState.hasFarTemp(asset.id)) this.#impostorState.releaseFarTemp(asset.id);
      return;
    }
    // Before the prewarm and the queued builds, both of which read the levels, the distances and
    // the gates: an asset whose chain widened it is batched at those levels from its first build.
    asset.levels = this.#widenWithChain(asset, adopted);
    // A far-only asset is drawn by no near run, so it takes no prewarm and queues no cell build:
    // its whole job is the atlas behind the aggregate, and its source is released once that lands.
    if (this.#impostorState.hasFarTemp(asset.id)) {
      this.#impostorState.maybeQueueImpostor(asset);
      // Nothing to bake (no alpha-cutout LOD0) and nothing queued: release the source now.
      if (asset.impostor === undefined && !this.#impostorState.hasQueued(asset.id))
        this.#impostorState.releaseFarTemp(asset.id);
      return;
    }
    // After the chain, so the impostor's switch sits beyond every synthesized gate; before the
    // prewarm, so a cached atlas appends its level in this same admission.
    this.#impostorState.maybeQueueImpostor(asset);
    // Every level and part of the asset now, before any of them is asked for. A level with no
    // placement in it is not drawn and would otherwise mint its mesh — and pay its node build — on
    // the frame a walk first moves far enough to switch into it.
    this.#prewarm.queuePrewarm(asset);
    for (const cell of [...this.#resident.values()]) {
      for (const run of cell.cell.runs) {
        if (this.#canonical(run.asset) === asset.id) this.#queueBuild(asset, cell, run);
      }
    }
  }

  /**
   * An asset's loaded levels, widened with the ones its model's baked AutoLOD chain carries.
   *
   * An asset with authored `lods` keeps its own switch distances and its own middle geometry: each
   * level draws the shape the pipeline authored for it, with the root LOD0's alpha cutouts appended
   * to any level that authored fewer of them so no middle loses its leaves; see
   * `coverAuthoredLevels`. A chain the loader also happens to have registered is a fallback for a
   * package that named no `lods`, not a second opinion over one that did. Everything downstream is
   * unchanged either way — a level is a level, and its switch is a gate like any other — so the
   * batch keys, the prewarm, the caster clusters and the retire/rebind pool all see the derived
   * levels as ordinary ones.
   */
  #widenWithChain(
    asset: IAssetState,
    levels: readonly (readonly IAssetPart[])[],
  ): readonly (readonly IAssetPart[])[] {
    if ((asset.definition.lods?.length ?? 0) > 0)
      return this.#preserveAuthoredParts ? levels : coverAuthoredLevels(levels);
    // An empty list names no authored rung. Prepared static parts can use their existing chain,
    // while sectioned/deforming or replaced-attribute copies keep their supplied source shape.
    if (asset.definition.lods !== undefined && !(levels[0] ?? []).every(preparedChainSafe))
      return levels;
    const chained = chainLevels(
      levels[0] as readonly IAssetPart[],
      this.#autoLodPixelsPerUnit,
      this.#autoLodMaxPixelError,
      asset.definition.maxDistance,
    );
    if (chained === undefined) return levels;
    asset.distances = chained.distances;
    asset.gates = [...chained.distances.slice(1), ...asset.gates];
    for (const gate of asset.gates) this.#noteGate(gate);
    asset.threshold = asset.gates.length === 0 ? undefined : Math.min(...asset.gates);
    this.#reportChainLod(asset.id, chained);
    return chained.levels;
  }

  /**
   * Move this asset's already-built wide casters into the one whole-asset mesh, with root records.
   *
   * Before the bake landed the far shadow held one wide mesh per (level, part 0), each carrying
   * `placement * part 0 local` for its own level's placements. The whole-asset representation is one
   * root draw per placement, so every one of those segments is dropped and re-claimed from the root
   * records the builds kept (`ICellBatch.wideRoot`) in the single mesh `#wideFor` now names. When a
   * block cannot be taken in this update's fresh-mesh allowance the asset is retried next frame; the
   * old per-level meshes, empty by then, are retired so the far shadow stops submitting them.
   */
  #retargetWideCasters(asset: IAssetState): void {
    const impostor = asset.impostor;
    if (impostor === undefined) return;
    const globalKey = `${asset.id}:*@${WIDE_CLUSTER}`;
    for (const cell of this.#resident.values())
      for (const entry of cell.batches) {
        if (entry.asset !== asset.id) continue;
        if (entry.wide !== undefined && entry.wide.mesh.name === globalKey) continue;
        // The old segment's shape and its doubled part offset are both wrong now; hand it back. Its
        // placed count goes with the records, so the mesh left behind does not read as fully placed
        // and the global one does not read as unplaced: see `SharedBatch#gpuPlaced`.
        const placed = entry.gpu?.length ?? 0;
        if (entry.wide !== undefined && entry.wideSegment >= 0) {
          entry.wide.gpuPlaced -= placed;
          entry.wide.clear(entry.wideSegment);
        }
        entry.wide = undefined;
        entry.wideSegment = -1;
        if (!this.#casts(entry.level) || !this.#wideOwed(asset.id, entry.part)) continue;
        const source = entry.wideRoot;
        if (source === undefined) continue;
        const wide = this.#batchFor(asset.id, entry, globalKey, "wide", false);
        const at = wide === undefined ? undefined : this.#segmentIn(wide, source.count);
        if (wide === undefined || at === undefined) {
          this.#impostorState.deferWide(asset.id);
          continue;
        }
        entry.wide = wide;
        entry.wideSegment = at;
        wide.gpuPlaced += placed;
        wide.write(at, source);
      }
    this.#retireWideKeys(asset.id, globalKey);
  }

  /** Give the asset's pre-bake per-key wide meshes back, once the handoff has emptied them. */
  #retireWideKeys(assetId: string, keep: string): void {
    const prefix = `${assetId}:`;
    for (const [key, shared] of [...this.#shared]) {
      if (key === keep || shared.role !== "wide" || !key.startsWith(prefix)) continue;
      if (shared.live > 0) continue;
      shared.mesh.removeFromParent();
      this.#bundleOut(shared);
      this.#shared.delete(key);
      this.#retire(key, shared);
    }
  }

  /**
   * `TN_WORLD_CELL_FAILURE`, one line per refused world load: which stage refused (`asset`, `chunk`
   * or `attach`), the asset id or cell key it refused for, the paths it was reading, and the error
   * behind it. A counted failure alone says a world lost something; this says which world load and
   * why, which is the only thing a playtest's `state.failures` can be attributed from. A warning
   * rather than an error, because a refused load is a world that draws the rest, not a crash.
   */
  #reportCellFailure(
    kind: "asset" | "chunk" | "attach",
    id: string,
    paths: readonly string[],
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `TN_WORLD_CELL_FAILURE kind=${kind} id=${id} paths=${paths.join(",")} message=${message}`,
    );
  }

  /**
   * `TN_WORLD_LOD_CHAIN`, one line per asset that was widened: how many levels it is now drawn at,
   * where each takes over in metres to one decimal, and what each submits in triangles. Level 0
   * leads, so the first triangle count is what the asset submits today and the last is what it
   * submits past the last switch: the reduction is the whole point of the line.
   */
  #reportChainLod(id: string, chained: IChainLevels): void {
    this.#chainLodAssets += 1;
    if (this.#chainLodAssets > CHAIN_LOD_MARKER_LIMIT) {
      if (this.#chainLodSummarised) return;
      this.#chainLodSummarised = true;
      console.info(
        `TN_WORLD_LOD_CHAIN more than ${String(CHAIN_LOD_MARKER_LIMIT)} assets carry a chain; ` +
          `the rest are one line: assets=${String(this.#chainLodAssets)}`,
      );
      return;
    }
    const listed: string[] = [];
    for (const distance of chained.distances) listed.push(distance.toFixed(1));
    console.info(
      `TN_WORLD_LOD_CHAIN ${id}: levels=${String(chained.levels.length)} ` +
        `distances=${listed.join(",")} tris=${chained.triangles.join(",")}`,
    );
  }

  /**
   * The `[nearest, farthest]` distance from `(x, z)` to the rectangle a cell's placements lie in.
   *
   * ponytail: the rectangle is the compiler's contract — a run's records belong to the cell they
   * are filed under — so one interval covers every placement in a cell. A hand-edited package that
   * files a placement under a neighbouring cell keeps it at the level its own distance selects; a
   * validator check on the placement buffer is the fix if that ever has to be caught.
   */
  #span(cell: IResidentCell, x: number, z: number): readonly [number, number] {
    const left = this.#minX + cell.x * this.#cellSize;
    const near = this.#minZ + cell.z * this.#cellSize;
    const right = left + this.#cellSize;
    const far = near + this.#cellSize;
    return [
      Math.hypot(Math.max(left - x, x - right, 0), Math.max(near - z, z - far, 0)),
      Math.hypot(
        Math.max(Math.abs(x - left), Math.abs(x - right)),
        Math.max(Math.abs(z - near), Math.abs(z - far)),
      ),
    ];
  }

  /**
   * One entry per asset of `cell` the follow point has moved a gate of, nearest placement first.
   *
   * The cell's own bracket is the caller's: it was derived once for the cell, and every batch of a
   * cell is measured against the same rectangle, so deriving it per batch was the same four
   * `Math.max` and two `Math.hypot` calls as many times as the cell had batches. What is left here is
   * per batch: one moved-point test and, for a batch that moved, its own bracket.
   *
   * Nothing is allocated to find them: the entries go into one reused array, the per-cell "already
   * seen" set into another, and a pass that crossed no gate anywhere pushes nothing at all.
   */
  #staleIn(cell: IResidentCell, x: number, z: number, near: number, far: number): void {
    const seen = this.#staleSeen;
    seen.clear();
    for (const entry of cell.batches) {
      const reach = this.#reachRanges.get(cell.cell)?.get(entry.asset);
      if ((entry.threshold === undefined && reach === undefined) || seen.has(entry.asset)) continue;
      // Deferred runs of one asset can start at different camera snapshots. Only deduplicate
      // after one entry proves the asset stale: an earlier matching run cannot settle the others.
      if (
        Math.hypot(
          x - entry.lastFilterX,
          this.#followY() - entry.lastFilterY,
          z - entry.lastFilterZ,
        ) <=
        (entry.threshold ?? 6) / 8
      )
        continue;
      const asset = this.#assets.get(entry.asset);
      if (asset === undefined) continue;
      // With the GPU scene on the dispatch switches levels itself, so only the cull gate changes
      // which placements a build hands it; an asset with no cull has nothing to rebuild for.
      const cull = cullDistance(asset.definition.maxDistance);
      const gates = this.#gpuScene.on ? (cull === undefined ? [] : [cull]) : asset.gates;
      const [builtNear, builtFar] = this.#span(cell, entry.lastFilterX, entry.lastFilterZ);
      let low = Math.min(near, builtNear);
      // Ends included, so a placement exactly on a gate is one of the reasons to rebuild.
      let high = Math.max(far, builtFar);
      let reachCrossed = false;
      if (reach !== undefined) {
        const vertical = (y: number): [number, number] => [
          Math.max(reach.minY - y, y - reach.maxY, 0),
          Math.max(Math.abs(y - reach.minY), Math.abs(y - reach.maxY)),
        ];
        const current = vertical(this.#followY());
        const previous = vertical(entry.lastFilterY);
        const reachLow = Math.min(Math.hypot(near, current[0]), Math.hypot(builtNear, previous[0]));
        const reachHigh = Math.max(Math.hypot(far, current[1]), Math.hypot(builtFar, previous[1]));
        reachCrossed = reach.min <= reachHigh && reach.max >= reachLow;
        low = reachLow;
        high = reachHigh;
      }
      if (!reachCrossed && !gates.some((gate) => gate >= low && gate <= high)) continue;
      seen.add(entry.asset);
      this.#stale.push({ cell, distance: near, id: entry.asset });
      this.#staleEntries += 1;
    }
  }

  /**
   * Record that one more gate distance exists, keeping the world's list ascending so
   * {@link crossesGate} can binary search it. A gate is never withdrawn: an asset whose ring left
   * still leaves its distances behind, which costs a cell the gate test does not reject and never a
   * rebuild the pass owes.
   */
  #noteGate(gate: number): void {
    const gates = this.#gates;
    if (gates.includes(gate)) return;
    let at = gates.length;
    while (at > 0 && (gates[at - 1] as number) > gate) at -= 1;
    gates.splice(at, 0, gate);
  }

  /**
   * Queue a refilter for every batch whose follow point has moved far enough to have crossed a
   * boundary: a cull distance, or one of the asset's `lods` switches. This is the same step the
   * `maxDistance` filter always took, with the level switch added to the distances it can be
   * crossed at, so there is still no per-frame refiltering pass.
   *
   * Two things keep that pass from costing a frame. A cell's placements all sit inside one
   * rectangle, so the two points that matter — where the batch was built and where the follow point
   * is now — bracket every distance a placement of that cell can have had; with no gate of the
   * asset in that span the level and cull answer is the same and the rebuild could change nothing,
   * and the position the batch was built from is kept so the next move is still measured from it.
   * What is genuinely stale is queued nearest cell first, `rebuildsPerUpdate` of them per call, and
   * the queue spends the frame's admission budget on them like any other build — so a refilter that
   * cannot be afforded this frame leaves the cell drawing the level it has, not a hole.
   */
  #updateMaxDistance(x: number, z: number): void {
    this.#refilters += 1;
    const stale = this.#stale;
    stale.length = 0;
    this.#collectStale(x, z);
    // Only what was found, and usually a handful of entries.
    if (stale.length > 1) stale.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    // What the cap could not queue is still owed, and `#refilterStale` reads that: a standing follow
    // point has to keep coming back for it, or a walk that stopped mid-drain never finished.
    this.#refilterOwed = stale.length > this.#rebuildsPerUpdate;
    for (const job of stale.slice(0, this.#rebuildsPerUpdate)) {
      const asset = this.#assets.get(job.id);
      if (asset === undefined || asset.levels.length === 0) continue;
      // Every run of the group, not just the one that happens to carry the canonical's name: a cell
      // holding two names for one model has two stale answers, and rebuilding only the named one
      // left the other drawing the level its own distance has moved out of.
      for (const run of job.cell.cell.runs) {
        if (this.#canonical(run.asset) !== job.id) continue;
        this.#queueBuild(asset, job.cell, run, true);
        this.#rebuilds += 1;
      }
    }
  }

  /**
   * Every resident cell's stale assets, into the reused list, nearest placement first.
   *
   * A cell is gated as a whole before one of its batches is looked at: its own bracket is derived
   * once, unioned with every distance any of its batches was filtered from, and one binary search
   * over the world's gates decides it. No gate in that range means no asset of the cell can have
   * changed side of one, so its batches are not walked at all — which is the whole cost of a pass in
   * which the follow point has not yet reached anything that switches.
   */
  #collectStale(x: number, z: number): void {
    for (const cell of this.#resident.values()) {
      const [near, far] = this.#span(cell, x, z);
      const low = near < cell.filterNear ? near : cell.filterNear;
      const high = far > cell.filterFar ? far : cell.filterFar;
      if (!this.#reachRanges.has(cell.cell) && !crossesGate(this.#gates, low, high)) continue;
      this.#staleIn(cell, x, z, near, far);
    }
  }

  #cellLive(cell: IResidentCell, generation: number): boolean {
    return (
      !this.#released && this.#resident.get(cell.key) === cell && cell.generation === generation
    );
  }

  #evict(cell: IResidentCell): void {
    this.#chunks.evictProxy(cell);
    this.#residencyEpoch += 1;
    // Every run this cell held goes back to the far mesh BEFORE the near batches below are cleared:
    // the far mesh owns the ORIGINAL roots and this is the same synchronous block, so no frame draws
    // the cell twice or not at all. Skipped at teardown, where the far aggregates are drained whole.
    if (!this.#released) for (const run of cell.cell.runs) this.#impostorState.restoreFar(run);
    // Work queued for a cell that has left is dropped, not resumed: a later frame would build
    // batches into a graph that no longer holds the cell, and the residency slot is already gone.
    this.#jobs = this.#jobs.filter((job) => {
      if (job.cell !== cell) return true;
      this.#queued.delete(job.run);
      // A swap that ran out of fresh meshes leaves its claims in `fresh`, which is not in
      // `cell.batches` until the swap completes. Dropping the job without handing those blocks back
      // keeps them reserved and unwritten, so `mesh.count` never falls to zero, the asset's release
      // retires a batch that still counts records and drops the key outright, and the walk back
      // mints a second mesh for it.
      for (const entry of job.fresh) this.#clearSegment(entry);
      return false;
    });
    for (const entry of cell.batches) this.#clearSegment(entry);
    // The same invalidation `#swap` makes, for the eviction path: the records that just left the
    // ring are ground the levels were drawing, and they are named one batch at a time.
    this.#shadowRecordsMoved(this.#changedBounds(cell.batches, []));
    cell.batches.length = 0;
    // The cell's record of those chunks goes with them, so a replay can never draw a cell the world
    // has released — before they leave the group, which is where it counts what it holds. See
    // `#addChunk`.
    this.#dropChunkBundles(cell);
    for (const chunk of cell.chunks) {
      chunk.removeFromParent();
      this.#failures += this.#disposeLoaded(chunk);
    }
    cell.chunks.length = 0;
    // The cell's chunk sources go back to the loader here, on the last cell that named them, exactly
    // as an asset's levels do in `#release`. Run even at teardown: the loader is never cleared, so a
    // path this world asked for must be handed back however the world leaves.
    this.#releaseModelPaths(cell.retainedModelPaths);
    this.#resident.delete(cell.key);
    this.#cullEvicted(cell);
    this.#instances -= cell.instances;
    this.#bytes -= cell.bytes;
    this.#evictions += 1;
    // Room just freed: retry the far aggregates a full budget refused, so a species held back while
    // the ring was tight appears without another scan. Skipped at teardown, where the far half drains.
    if (!this.#released) this.#impostorState.retryFar();
    // One per run, so the canonical's refcount reaches zero exactly when the last run naming any
    // member of its group has left the ring.
    for (const run of cell.cell.runs) this.#release(this.#canonical(run.asset));
  }

  /**
   * Release every part's shape and every surface it owns — its own material and, for a scattered
   * transparent part, the cutout clone made for it.
   *
   * At most once per resource, the same contract `release` gives the single-shape case: two parts
   * of one GLB routinely share a material, a level that fell back shares the level below's whole
   * part list, and every cell batch of the asset drew the same one. A clone is a resource this
   * class made, so it is released here and nowhere else.
   *
   * @returns how many teardowns threw, for the caller to count.
   */
  /**
   * Tear down a model the loader handed this world, respecting who owns the loader.
   *
   * A model from the loader this world created is the world's to dispose. A model from an
   * explicitly supplied loader is the caller's — another world or game may hold the same cached
   * scene — so this world drops its batches but leaves the shapes and surfaces alone; the caller's
   * own `release` ends that lifetime. See `#releaseModelPaths`.
   */
  #disposeLoaded(model: Object3D | undefined): number {
    if (model === undefined) return 0;
    return this.#ownsLoader ? disposeModel(model) : 0;
  }

  /**
   * Release an adopted source shape or authored surface, unless a caller-supplied loader owns it.
   * The caller's cache holds another world's copy too, so only a world-owned loader disposes what
   * it adopted; a cutout this world built is always its own. See `#disposeLoaded`.
   */
  #releaseSource(target: { dispose: () => void } | undefined): boolean {
    return this.#ownsLoader && release(target);
  }

  #releaseParts(parts: readonly IAssetPart[]): number {
    let failed = 0;
    for (const part of parts) {
      if (releasedParts.has(part)) continue;
      releasedParts.add(part);
      // A parked mesh holds the part's own geometry and material, so once those are released the
      // parked mesh can never be handed out again — it would give the next cell that asks for one a
      // buffer waiting on a disposed resource. Dropped here, so it does not sit in the pool counting
      // against the meshes a walk can park.
      dropPooledFor(part.geometry, part.material);
      if (this.#releaseSource(part.geometry)) failed += 1;
      failed += this.#releaseSurface(part.surface);
    }
    return failed;
  }

  /**
   * The shared surface for a material's content: the first material seen for a key becomes the
   * canonical one (converted to a cutout when it is transparent scatter), and every later material
   * with the same content is released on arrival and draws with it instead.
   */
  #surfaceFor(source: Material): { readonly key: string; readonly material: Material } {
    const key = this.#preserveAuthoredParts ? source.uuid : materialKey(source);
    const shared = this.#surfaces.get(key);
    if (shared !== undefined) {
      shared.users += 1;
      if (!shared.owned.includes(source) && this.#releaseSource(source)) this.#failures += 1;
      return { key, material: shared.material };
    }
    const drawn = scatterMaterial(source, this.#transparentScatter);
    this.#surfaces.set(key, { material: drawn.material, owned: drawn.owned, users: 1 });
    return { key, material: drawn.material };
  }

  /** One user gone; the last one tears the shared surface down. Returns teardowns that threw. */
  #releaseSurface(key: string): number {
    const shared = this.#surfaces.get(key);
    if (shared === undefined) return 0;
    shared.users -= 1;
    if (shared.users > 0) return 0;
    this.#surfaces.delete(key);
    let failed = 0;
    // A caller-supplied loader's authored surfaces belong to the caller's cache, like its shapes.
    // The cutout clones this world built are still the world's to release — `worldOwned` is the
    // marker. See `#releaseSource`.
    for (const material of shared.owned)
      if ((this.#ownsLoader || worldOwned.has(material)) && release(material)) failed += 1;
    return failed;
  }

  #release(id: string): void {
    const asset = this.#assets.get(id);
    if (asset === undefined) return;
    asset.refcount -= 1;
    if (asset.refcount > 0) return;
    this.#assets.delete(id);
    asset.disposed = true;
    // Before anything is released: a pending bake stages this asset's borrowed geometry, and a view
    // drawn after the teardown reads a disposed buffer. Then the terminal level's own surface, whose
    // geometry and material `#releaseParts` must skip; see `#releaseImpostor`.
    this.#impostorState.cancelImpostor(asset);
    this.#impostorState.releaseImpostor(asset);
    // The last cell drawing this asset is gone, so this is the one teardown its levels get. It is
    // also the one a lost device makes expensive, which is why every part goes through `release`:
    // at most once per resource, and a level that fell back shares the level below's parts, so one
    // shape is torn down once however many levels point at it. One refusal is counted per asset,
    // the way one refused `lod0` load was.
    const levels = asset.levels;
    const spilled = asset.spilled;
    asset.levels = [];
    asset.spilled = [];
    let failed = 0;
    failed += this.#drainShared(id);
    for (const parts of levels) failed += this.#releaseParts(parts);
    // The middle levels' own reduced foliage cards, taken out of DRAW but still owned here. The
    // released-parts set makes the ones a draw level also holds single-teardown, so a shared surface
    // is never dropped early.
    failed += this.#releaseParts(spilled);
    if (failed > 0) this.#failures += 1;
    this.#releaseModelPaths(asset.retainedPaths);
  }

  /**
   * Note the exact `assets.model` cache paths an owner (an asset's levels, a cell's chunks) asks the
   * loader for, in the one world-wide `#modelPaths` map, so the last owner to let a path go can hand
   * it back. Both owners share the map, so an asset and a chunk that name the same bytes keep the
   * entry alive until neither holds it.
   */
  #retainModelPaths(paths: readonly string[], into: string[]): void {
    for (const path of paths) {
      this.#modelPaths.set(path, (this.#modelPaths.get(path) ?? 0) + 1);
      into.push(path);
    }
  }

  /**
   * Hand back the exact `assets.model` cache paths this owner requested, so the loader drops the
   * source scenes and their textures instead of pinning them for the world's whole life.
   *
   * A path another owner still names is not released: two definitions that fetch the same bytes but
   * carry different `lods`/`maxDistance` are distinct assets, and the one leaving the ring must not
   * tear out a cached source the other still draws with. Keyed on the requested logical path, so a
   * path this world never asked for is never touched.
   *
   * Only the loader this world created is released. An explicitly supplied `assets` loader is the
   * caller's: another game or world may hold the same cached model, so this world never drops a
   * cache entry it does not own — the caller's own `release` is where that lifetime ends.
   */
  #releaseModelPaths(paths: string[]): void {
    for (const path of paths) {
      const holders = (this.#modelPaths.get(path) ?? 1) - 1;
      if (holders > 0) {
        this.#modelPaths.set(path, holders);
        continue;
      }
      this.#modelPaths.delete(path);
      if (this.#ownsLoader) this.#loader.release("model", path);
    }
    paths.length = 0;
  }

  /** Releases the shared meshes of one asset (or of every asset), keeping them for the walk back. */
  #drainShared(assetId?: string): number {
    const failed = 0;
    for (const [key, shared] of this.#shared) {
      if (assetId !== undefined && !key.startsWith(`${assetId}:`)) continue;
      shared.mesh.removeFromParent();
      // The mesh is out of the world, so it is out of the bundle the world recorded. A key that comes
      // back is minted or rebound into the group again, and each of those is one re-record.
      this.#bundleOut(shared);
      this.#shared.delete(key);
      // Retired, not dropped, so the cell that comes back draws into the same mesh.
      this.#retire(key, shared);
    }
    return failed;
  }
}
