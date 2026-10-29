import { CellModels, type IAssetState, assetAliases } from "./world-cell-models.js";
import { CellRender, MAIN_CULL_SQUARE_METRES, mainShard } from "./world-cell-render.js";
export type { IAssetState } from "./world-cell-models.js";

import type {
  IAssetPart,
  IBuildJob,
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
  PLACEMENT_RECORD_BYTES,
  PLACEMENT_RECORD_FLOATS,
  cullDistance,
} from "./world-cell-impostors.js";

import {
  admissionBudgetMs,
  cellKey,
  crossesGate,
  nonNegativeInteger,
  positiveInteger,
  positiveMetres,
  sameLodRanges,
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
  type Camera,
  DynamicDrawUsage,
  Frustum,
  Group,
  Matrix4,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";

import { type IAssetLoader, createAssetLoader } from "./assets.js";
import type { IComputeDriven } from "./compute-driven.js";
import { INSTANCED_LOD_MAX_PIXEL_ERROR } from "./instanced-batch-lod.js";
import { InstancedBatch } from "./instanced-batch.js";
import { biasedLodDistance, setLodBias, worldSphere } from "./model-lod.js";
import { type OcclusionMode, occlusionMode } from "./render/depth-pyramid.js";

import { advanceWriteEpoch, drainMeshPool } from "./render/mesh-pool.js";
import type { IRendererLike } from "./renderer.js";

import { addInSlices } from "./streaming.js";
import { DEFAULT_TARGET_FPS } from "./target-fps.js";
import { yieldToHost } from "./warmup.js";

import { SharedBatch } from "./world-cell-batches.js";
import {
  CHUNK_MERGE_MAX_TRIANGLES,
  CellChunks,
  cellLoaded,
  release,
  resolveRelative,
} from "./world-cell-chunks.js";
import { CellPrewarm } from "./world-cell-prewarm.js";

import {
  type IShadowLevel,
  type IWorldGpuFrameValidation,
  bundlesAsked,
  gpuSceneRequested,
  levelAtGates,
  shadowGpuKeysRequested,
} from "./world-gpu-scene.js";
import { heightSamplerFromHeightmap, loadWorldHeightmap } from "./world-heightmap.js";
import { AdmissionBudget } from "./world-load-limiter.js";
import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldPackage,
  type IWorldRun,
  cellPlacements,
  validateWorldPackage,
} from "./world-package.js";
import { type IAdmissionBudget, TerrainTileBudgetError, TerrainTiles } from "./world-tiles.js";

const _readinessPosition = new Vector3();
const LOD_RANGE_RECORD_BYTES = 8;

export { bundleSafeMaterial } from "./world-bundle-safety.js";

const DEFAULT_TILE_RESOLUTION = 129;

/**
 * One tile vertex per heightmap sample, rounded up so every default lod factor (1, 2, 4) divides it
 * and capped at the old fixed 129. A finer tile only interpolates the same samples: 129 over a 2 m
 * heightmap drew 3.01M terrain triangles, 25 ms on an Iris Xe (PRD-762).
 */
function tileResolutionFor(tileSize: number, spacing: number): number {
  const cells = Math.ceil(tileSize / spacing / 4) * 4;
  return Math.min(DEFAULT_TILE_RESOLUTION, Math.max(9, cells + 1));
}
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

/**
 * Whether a launch opts into the whole-asset impostors: off unless `?tnImpostors=1`, `TN_IMPOSTORS=1`
 * or `__tnImpostors = 1` says so. Opt-in because the judged Machinefall capture of the default
 * (PRD-473 AC-3, 2026-10-14) read REGRESSION — ground shadows and canopy density differ — and its
 * pinned frame windows showed no frame-time gain, so a game gets the source levels it had until the
 * proof passes. `impostors: true` still asks explicitly.
 */
function impostorsRequested(): boolean {
  const raw = launchValue("tnImpostors", "TN_IMPOSTORS", "__tnImpostors");
  return raw === "1" || raw === "true";
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

/**
 * Stream a Blender-authored world package by cell and keep it resident around a followed point.
 *
 * The class composes `TerrainTiles` for the package's heightmap, builds one `InstancedBatch` per
 * resident cell asset run, distance level and mesh part, and loads hand-placed chunk GLBs through
 * `loadAll` + `addInSlices`. Ring residency, CPU per-asset `maxDistance` filtering, GPU dispatch
 * culling, the per-asset `lods` levels, hard budgets and generation-tokened cancellation all live
 * here; every geometry, material and surface still comes from the package's GLBs and the game.
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
 * @constraint a cell's model loads at `soon` priority, so a file the running scene awaits through `ctx.assets` starts first
 * @constraint budgets are hard caps that report pressure instead of over-committing
 * @constraint `whenSpawnReady(position, radius, timeoutMs)` snapshots a fixed region and settles from existing updates or disposal; it does not drive streaming, and `prewarmed` remains the separate draw gate
 * @constraint model loads are bounded by `concurrency` (default 12) across every resident cell, not per cell
 * @constraint refilters are bounded by `rebuildsPerUpdate` (default 16) per update, nearest cell first
 * @constraint admission is bounded by `admissionBudgetMs` (default 2) per update across every path, plus at most one unit each for terrain and props; while props are queued terrain takes at most half, so neither starves the other, and a deferred cell keeps drawing what it has
 * @constraint SkinnedMesh parts are skipped; an instanced copy would draw one rest pose
 * @constraint a baked chain's switch distances are measured against `autoLod` (default 4 px of error over 60° and 1080 raster rows), because an instanced draw cannot select a level per instance; an asset with nonempty authored `lods` never consults it; explicit empty lists enroll only unchanged static geometry/material parts
 * @constraint eligible static sources can use cooked HLOD (chunk-only alongside GPU scatter, whole-cell on CPU) after compilation and an observed main-context backend submission; projected-error hysteresis requires actual source triangle reduction and no extra material draws, unsupported or shared source stays resident, and collision/shadow paths retain source representations; stats().hlod counts lifecycle and charged resources, not GPU timing or physical allocation
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
  /** Smoothed follow velocity (m/s) and the sample it was last updated from. */
  #velocityX = 0;
  #velocityZ = 0;
  #lastSample: { readonly x: number; readonly z: number; readonly t: number } | undefined;
  readonly #ring: number;
  #terrain: TerrainTiles | undefined;
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
  readonly #resident = new Map<string, IResidentCell>();
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
  /**
   * Side of a world-grid square, and how many cells fit in one. One `SharedBatch` per
   * `asset:level:part` per square, so the mesh's bounds are that square's records and every camera
   * culls at square granularity. A cell's placements never move, so a record's square is the one
   * its own cell sits in and nothing is ever re-clustered.
   */
  readonly #clusterSize: number;
  readonly #cellsPerCluster: number;
  /** World cells per main-cull visibility cell; see `MAIN_CULL_SQUARE_METRES`. */
  readonly #cellsPerCullCell: number;
  /** The follow point the last full residency pass ran for; see `#residencyStale`. */
  readonly #residencyPoint = new Vector3(Number.NaN, 0, Number.NaN);
  /** Actual cell at the last residency pass; only a jump reclaims retained hysteresis. */
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
  readonly #recordBounds = new Box3();
  readonly #instance = new Matrix4();
  /** The authored bounds' centre, placed: the source sphere's centre. See `#addPlacements`. */
  readonly #sourceCentre = new Vector3();
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
  /** Completed admission steps; queued, refused and discarded work does not count. */
  #admissionCompletedUnits = 0;
  #rebuilds = 0;
  /** Refilter passes run, whether or not they queued anything; see `IWorldCellsStats.refilters`. */
  #refilters = 0;
  /** Replacement builds that entered #addPlacements; initial admission is not CPU refilter work. */
  #levelRefilters = 0;
  /** Refilters whose rebuild came back identical and were settled without a write. */
  #unchanged = 0;
  /** Every distinct gate distance the world's assets have, ascending; see `#noteGate`. */
  readonly #gates: number[] = [];
  /** The reused hit list and the reused per-cell seen set; see `#staleIn`. */
  readonly #stale: Array<{
    cell: IResidentCell;
    distance: number;
    id: string;
  }> = [];
  readonly #staleSeen = new Set<string>();
  /** Stale cell-assets the passes found, cumulative; see `IWorldCellsStats.refilterEntries`. */
  #staleEntries = 0;
  #generation = 0;
  #released = false;
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
          this.#render.dispatchShadow(renderer, level);
        }
      : undefined;
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

  readonly #render: CellRender;
  readonly #onPublication: IWorldCellsInit["onPublication"];
  readonly #readinessVisible = new Map<IWorldCell, boolean>();
  #readinessView: number[] = [];
  #readinessReach: Float32Array | undefined;
  readonly #readinessFrustum = new Frustum();
  readonly #readinessProjection = new Matrix4();
  readonly #prewarm: CellPrewarm;
  readonly #chunks: CellChunks;
  readonly #impostorState: CellImpostors;
  readonly #models: CellModels;

  /** What `clone` rebuilds from: the load's resolved options, shared read-only data included. */
  readonly #init: IWorldCellsInit;
  /** Children the streaming itself added (terrain, chunks, batches, bundles); the rest are authored. */
  readonly #streamed = new WeakSet<Object3D>();
  /** A clone's copies of its source's streamed children, kept until the first update replaces them. */
  #snapshotChildren: Object3D[] = [];

  private constructor(init: IWorldCellsInit) {
    super();
    this.#onPublication = init.onPublication;
    this.#prewarm = new CellPrewarm({
      released: () => this.#released,
      parent: () => this.parent,
      invalidateShadows: () => this.#invalidateShadows?.(),
      backlog: () => this.#backlog() + this.#impostorState.impostorStats().pending,
      keysForShadow: () => this.#render.keysForShadow(),
      hasShared: (key) => this.#render.hasShared(key),
      hasRetired: (key) => this.#render.hasRetired(key),
      runMax: (asset) => this.#runMax.get(asset),
      residentCells: () => this.#budgets.residentCells,
      extentBounds: () => this.#extentBounds,
      smallCaster: (asset) => this.#render.smallCaster(asset),
      dressMesh: (shared, receiveShadow) => this.#render.dressMesh(shared, receiveShadow),
      receiveShadow: () => this.#receiveShadow,
      preserveAuthoredParts: () => this.#preserveAuthoredParts,
      adoptGpu: (shared, asset, key, level, part) =>
        this.#render.adoptGpu(shared, asset, key, level, part),
      setShared: (key, shared) => this.#render.setShared(key, shared),
      attach: (shared) => this.#render.attach(shared),
      casts: (level) => this.#render.casts(level),
      wideOwed: (asset, part) => this.#render.wideOwed(asset, part),
      followCluster: () => this.#render.followCluster(),
      wideShape: (asset, level, part, fallback) =>
        this.#render.wideShape(asset, level, part, fallback),
    });
    this.#init = { ...init };
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
    const mainCullToldAt = this.#now();
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
    this.#models = new CellModels(
      init,
      {
        lodHysteresis: this.#lodHysteresis,
        manifest: this.#manifest,
        baseUrl: this.#baseUrl,
        logicalBase: this.#logicalBase,
        preserveAuthoredParts: init.preserveAuthoredParts ?? false,
        autoLodPixelsPerUnit: this.#autoLodPixelsPerUnit,
        autoLodMaxPixelError: this.#autoLodMaxPixelError,
        transparentScatter: init.transparentScatter ?? "cutout",
      },
      {
        canonical: (id) => this.#canonical(id),
        noteGate: (gate) => this.#noteGate(gate),
        queueBuild: (asset, cell, run, force) => this.#queueBuild(asset, cell, run, force),
        released: () => this.#released,
        failures: () => this.#failures,
        setFailures: (count) => {
          this.#failures = count;
        },
        reportCellFailure: (stage, key, paths, error) =>
          this.#reportCellFailure(stage, key, paths, error),
        drainShared: (assetId) => this.#render.drainShared(assetId),
        residentCells: () => this.#resident.values(),
        queuePrewarm: (asset) => this.#prewarm.queuePrewarm(asset),
        hasFarTemp: (id) => this.#impostorState.hasFarTemp(id),
        releaseFarTemp: (id) => this.#impostorState.releaseFarTemp(id),
        maybeQueueImpostor: (asset) => this.#impostorState.maybeQueueImpostor(asset),
        hasQueuedImpostor: (id) => this.#impostorState.hasQueued(id),
        cancelImpostor: (asset) => this.#impostorState.cancelImpostor(asset),
        releaseImpostor: (asset) => this.#impostorState.releaseImpostor(asset),
      },
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

    this.#render = new CellRender(
      {
        mainCullToldAt,
        follow: this.#follow,
        budgets: this.#budgets,
        cellSize: this.#cellSize,
        minX: this.#minX,
        minZ: this.#minZ,
        manifest: this.#manifest,
        placements: this.#placements,
        coveredFreshMeshesPerUpdate: this.#coveredFreshMeshesPerUpdate,
        freshMeshesPerUpdate: this.#freshMeshesPerUpdate,
        receiveShadow: this.#receiveShadow,
        castShadowLevels: this.#castShadowLevels,
        extentBounds: this.#extentBounds,
        preserveAuthoredParts: this.#preserveAuthoredParts,
        lodHysteresis: this.#lodHysteresis,
        lodSpatial: this.#placementReach !== undefined,
        cellsPerCluster: this.#cellsPerCluster,
        cellsPerCullCell: this.#cellsPerCullCell,
        smallCasterMetres: this.#smallCasterMetres,
        bundlesWanted: this.#bundlesWanted,
        bundleReason: this.#bundleReason,
        invalidateShadows: this.#invalidateShadows,
      },
      {
        asset: (id) => this.#models.asset(id),
        assets: () => this.#models.assets(),
        canonical: (id) => this.#canonical(id),
        renderer: () => this.#chunks.renderer,
        camera: () => this.#chunks.camera,
        now: () => this.#now(),
        stats: () => this.stats(),
        residentCells: () => this.#resident.values(),
        runMax: (asset) => this.#runMax.get(asset),
        widenFilterRange: (cell, x, z) => this.#widenFilterRange(cell, x, z),
        addUnchanged: () => {
          this.#unchanged += 1;
        },
        disableFar: (run) => this.#impostorState.disableFar(run),
        deferWide: (id) => this.#impostorState.deferWide(id),
        queuedBuilds: () => this.#jobs.length,
        covered: () => this.#covered,
        prewarmSettled: () => this.#prewarm.settled,
        awaitDraw: (shared) => this.#prewarm.awaitDraw(shared),
        carryPrewarm: (old, next) => this.#prewarm.carryPrewarm(old, next),
        add: (object) => {
          this.#stream(object);
        },
        isParent: (object) => object.parent === this,
        isBundleHome: (shared) => shared.mesh.parent === this.#bundleHome(shared),
      },
    );

    this.#chunks = new CellChunks(
      init.hlod !== false,
      {
        loadModel: this.#models.loadModel,
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
            this.#models.loadModel !== undefined ||
            state.retainedPaths.every((path) => this.#models.pathUsers(path) <= 1)
          )
            this.#failures += this.#models.disposeLoaded(state.model);
        },
        disposeLoaded: (model) => this.#models.disposeLoaded(model),
        releaseModelPaths: (paths) => this.#models.releaseModelPaths(paths),
        retainModelPaths: (paths, into) => this.#models.retainModelPaths(paths, into),
        addFailures: (count) => {
          this.#failures += count;
        },
        sourceBytes: () => this.#bytes + this.#impostorState.farBytes,
        load: (path, wanted) => this.#models.load(path, wanted),
        cellLive: (cell, generation) => this.#cellLive(cell, generation),
        add: (object) => this.#stream(object),
        intersectsObject: (mesh) => this.#render.intersectsObject(mesh),
        gpuSceneOn: () => this.#render.gpuOn,
        asset: (id) => this.#models.asset(this.#canonical(id)),
        invalidateBundles: (key) => this.#render.invalidateBundles(key),
        worldSphere: (bounds) => worldSphere(bounds, this),
        reportCellFailure: (stage, key, paths, error) =>
          this.#reportCellFailure(stage, key, paths, error),
        parent: () => this.parent,
        targetScene: () => {
          let scene: Object3D = this;
          while (scene.parent !== null) scene = scene.parent;
          return Reflect.get(scene, "isScene") === true ? scene : undefined;
        },
        addChunk: (cell, object) => this.#render.addChunk(cell, object),
        publishChunkBounds: (cell, box, proxies) =>
          this.#render.publishChunkBounds(cell, box, proxies),
      },
    );
    this.#impostorState = new CellImpostors(
      {
        enabled:
          init.impostors ??
          (impostorsRequested() &&
            !(init.preserveAuthoredParts === true || init.lodHysteresis !== undefined)),
        preserveAuthoredParts: this.#preserveAuthoredParts,
        receiveShadow: this.#receiveShadow,
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
        covered: () => this.#covered,
        renderer: () => this.#chunks.renderer,
        asset: (id) => this.#models.asset(id),
        hasAsset: (id) => this.#models.hasAsset(id),
        assets: () => this.#models.assets(),
        nearWorkPending: () =>
          this.#jobs.length > 0 ||
          this.#models.loadsInFlight > 0 ||
          this.#models.loadsQueued > 0 ||
          this.#prewarm.queued > 0,
        newAsset: (id, definition) => this.#models.newAsset(id, definition),
        startAssetLoad: (asset) => this.#models.startAssetLoad(asset),
        release: (id) => this.#models.release(id),
        noteGate: (gate) => this.#noteGate(gate),
        retargetWideCasters: (asset) => this.#render.retargetWideCasters(asset),
        terminalPrewarm: (asset) => {
          this.#models.ditherGates(asset);
          this.#prewarm.queuePrewarm(asset);
          this.#render.refreshLodMaterials(asset);
        },
        terminalLevelReady: (asset) => {
          if (this.#render.gpuOn) {
            const level = asset.levels.length - 1;
            const part = asset.levels[level]?.[0];
            const key = `${asset.id}:${String(level)}:0`;
            if (
              part !== undefined &&
              !this.#render.hasShared(key) &&
              !this.#render.hasRetired(key)
            ) {
              const shared = new SharedBatch(
                part.geometry,
                part.material,
                this.#runMax.get(asset.id) ?? 1,
                this.#resident.size + 1,
                key,
                this.#extentBounds,
                "main",
                level,
              );
              shared.smallCaster = this.#render.smallCaster(asset.id);
              this.#render.dressMesh(shared, this.#receiveShadow);
              this.#render.adoptGpu(shared, asset.id, key, level, 0);
              this.#render.setShared(key, shared);
              this.#render.attach(shared);
              this.#prewarm.awaitDraw(shared);
            }
            this.#render.publishGpuGates(asset);
            this.#prewarm.queuePrewarm(asset);
            return;
          }
          for (const cell of [...this.#resident.values()]) {
            for (const run of cell.cell.runs) {
              if (this.#canonical(run.asset) === asset.id) this.#queueBuild(asset, cell, run, true);
            }
          }
        },
        residentCell: (key) => this.#resident.get(key),
        canonical: (id) => this.#canonical(id),
        shadowRecordsMoved: () => this.#render.shadowRecordsMoved(),
        residency: () => ({
          instances: this.#instances,
          bytes: this.#bytes,
          hlodBytes: this.#chunks.bytes,
        }),
        add: (object) => {
          this.#stream(object);
        },
        remove: (object) => {
          this.remove(object);
        },
        addFailure: () => {
          this.#failures += 1;
        },
        markReleasedPart: (part) => {
          this.#models.markReleasedPart(part);
        },
        drawnImpostorInstances: () => this.#render.impostorDrawn(),
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
      tileResolution:
        init.terrain?.tileResolution ??
        (init.terrain?.lodFactors === undefined
          ? tileResolutionFor(
              init.terrain?.tileSize ?? this.#cellSize,
              init.manifest.terrain.spacing,
            )
          : DEFAULT_TILE_RESOLUTION),
      tileSize: init.terrain?.tileSize ?? this.#cellSize,
    });
    this.#stream(this.#terrain);
  }

  static async load(options: IWorldCellsLoadOptions): Promise<WorldCells> {
    if (
      options.lodHysteresis !== undefined &&
      (!Number.isFinite(options.lodHysteresis) ||
        options.lodHysteresis < 0 ||
        options.lodHysteresis >= 1 ||
        options.gpuScene !== false ||
        (options.impostors === true && options.preserveAuthoredParts !== true))
    )
      throw new Error("WorldCells lodHysteresis must be in [0, 1) with gpuScene:false.");
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
    if (
      options.preserveAuthoredParts &&
      options.impostors &&
      !Object.values(manifest.assets).some((asset) => asset.impostorDistance !== undefined)
    )
      throw new Error(
        "WorldCells preserveAuthoredParts with impostors requires an authored impostorDistance.",
      );
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

  /** Adds what the streaming owns, so `clone` can tell it from what the game added. */
  #stream(child: Object3D): void {
    this.#streamed.add(child);
    this.add(child);
  }

  /** Fresh streaming state; the visible snapshot is replaced on the first update. Owned caches are independent. */
  override clone(recursive = true): this {
    const copy = new WorldCells({
      ...this.#init,
      ...this.#models.cloneAssets(),
    }).copy(this, false);
    if (recursive) {
      // The copy built its own terrain; the source's clone (its visible tiles) takes its place.
      const fresh = copy.#terrain;
      if (fresh !== undefined) {
        copy.remove(fresh);
        fresh.detach();
      }
      for (const child of this.children) {
        const clonedChild = child.clone();
        copy.add(clonedChild);
        if (child === this.#terrain) copy.#terrain = clonedChild as TerrainTiles;
        if (this.#streamed.has(child)) {
          copy.#streamed.add(clonedChild);
          if (child !== this.#terrain) copy.#snapshotChildren.push(clonedChild);
        }
      }
    }
    return copy as this;
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
   * Fence one just-rendered GPU dispatch for a diagnostic walk, resolving after both readbacks land.
   * Call after {@link update} and the render, then await it before advancing the measured frame.
   */
  validateGpuFrame(frame: number): Promise<IWorldGpuFrameValidation> {
    if (this.#released)
      return Promise.reject(new Error("World GPU frame validation cannot run after dispose."));
    if (this.#chunks.renderer === undefined)
      return Promise.reject(new Error("World GPU frame validation needs a renderer."));
    return this.#render.validateGpuFrame(this.#chunks.renderer, frame);
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
    this.#render.updateLodEye(this.#follow.position.x, this.#followY(), this.#follow.position.z);
    for (const child of this.#snapshotChildren) this.remove(child);
    this.#snapshotChildren.length = 0;
    // Kept for the chunk warm-up below: a chunk is loaded asynchronously and compiled when it
    // arrives, which can be a frame or a loading screen after the frame that gave us these.
    if (renderer !== undefined) this.#chunks.renderer = renderer;
    if (camera !== undefined) this.#chunks.camera = camera;
    this.#render.flushCompiles(renderer);
    // The adaptive LOD bias, before the dispatch below reads the gates it scales.
    this.#adaptLodBias(renderer);
    this.#render.enableGpu(
      renderer,
      this.#gpuWanted,
      this.#gpuValidate,
      this.#gpuTally,
      this.#occlusion,
    );
    // The scene coming up under a ring that was already built: every placement swapped in before it
    // was on has no source record, and the dispatch draws nothing it is not given. One rebuild of the
    // resident ring puts them in, through the same build every first-seen asset takes.
    if (this.#render.gpuOn && this.#render.gpuSeeded === false) {
      this.#render.gpuSeeded = true;
      this.#seedGpuSources();
      this.#render.seedGpuKeys();
      // After the keys, because that is the only point at which the marker can say how many of the
      // world's main meshes are dressed: printed at enable it would read the ring as it was a frame
      // earlier, which is the state the run that found this was in.
      this.#render.announceGpu();
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
    this.#render.resetFresh();
    // The residency pass is a function of the follow point, so a follow point that has not moved
    // and a world with nothing pending has the same answer as the last update: hundreds of cells
    // walked and re-sorted, every resident cell refiltered, every terrain tile re-levelled, all of
    // it to reach the set it already holds. Skipped while both hold. A move, a load, a build, a
    // deferred admission or a shadow level not yet told runs the pass exactly as before.
    const terrainView =
      this.#terrain !== undefined &&
      this.#chunks.camera !== undefined &&
      this.#chunks.renderer?.domElement?.height !== undefined
        ? {
            camera: this.#chunks.camera,
            viewportHeight: this.#chunks.renderer.domElement.height,
            maxPixelError: this.#autoLodMaxPixelError,
            hysteresis: this.#lodHysteresis,
          }
        : undefined;
    if (this.#residencyStale(x, z)) {
      this.#residencyPoint.set(x, this.#followY(), z);
      try {
        this.#terrain?.follow({ x, z }, budget, terrainView);
        this.#terrain?.process(renderer, camera, undefined, terrainView);
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
      // GPU source admission keeps every resident maxDistance candidate, so the dispatch's slot
      // cull and level gates handle a moving camera without a CPU replacement. `#staleIn` still
      // watches placementReach, whose per-record admission boundary has no GPU slot equivalent.
      if (this.#refilterStale(x, z)) {
        this.#refilterPoint.set(x, this.#followY(), z);
        this.#refilterEpoch = this.#residencyEpoch;
        this.#updateMaxDistance(x, z);
      }
    } else if (
      // A blend in flight is not a settled ring, and the blend is advanced by `process` alone —
      // `follow` only re-levels tiles. A follow point standing still used to skip both, so a
      // three-frame tile morph froze on its first frame until the player moved again.
      // With a render view, settled tiles also recheck cached errors against the current projection.
      terrainView !== undefined ||
      (this.#terrain?.blendingTiles ?? 0) > 0
    ) {
      this.#terrain?.process(renderer, camera, undefined, terrainView);
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
    this.#render.tellShadows(this.#covered);
    // After the drain too, so a record admitted this update is in the window the camera draws and
    // not one frame behind it.
    this.#chunks.restoreSources();
    this.#render.cullMainPass(camera);
    // With it, because it reads the drain's own answer: a caster whose main counterpart is not
    // drawable this frame must not cast before the levels render this frame's maps.
    this.#render.publishCasterAdmission();
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
    this.#render.reportMainCull();
    this.#admission = {
      backlog: this.#backlog(),
      deferred: this.#jobs.length,
      spentMs: budget.spentMs + props.spentMs,
    };
    // After this frame's admissions, so a region admitted by this update answers its waiters in it.
    this.#settleSpawnWaiters();
  }

  /** Borrowed scratch box: consume its transformed volume before the next bounds query. */
  #boundsAt(bounds: IWorldAsset["bounds"], matrix: Matrix4): Box3 {
    this.#recordBounds.min.fromArray(bounds.min);
    this.#recordBounds.max.fromArray(bounds.max);
    return this.#recordBounds.applyMatrix4(matrix);
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
      this.#models.loadsInFlight > 0 ||
      this.#models.loadsQueued > 0 ||
      this.#jobs.length > 0 ||
      this.#refilterOwed ||
      this.#prewarm.queued > 0 ||
      this.#prewarm.pending > 0 ||
      this.#render.shadowMoved === true ||
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
    this.#render.setLodBias(bias);
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
    for (const [id, asset] of this.#models.entries()) counts[id] = asset.refcount;
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
    const gpu = this.#render.report();
    if (gpu.gpuTriangles === undefined) return undefined;
    return {
      ageFrames: gpu.gpuTallyAgeFrames ?? 0,
      instances: gpu.gpuInstances ?? 0,
      triangles: gpu.gpuTriangles,
    };
  }

  stats(): IWorldCellsStats {
    const gpu = this.#render.report();
    const census = this.#render.gpuCensus();
    return {
      admission: { ...this.#admission },
      bundle: this.#render.bundleStats(),
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
      loadsInFlight: this.#models.loadsInFlight,
      loadsQueued: this.#models.loadsQueued,
      admissionBacklog: this.#backlog(),
      admissionCompletedUnits: this.#admissionCompletedUnits,
      mainCull: this.#render.mainCullStats(),
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
      levelRefilters: this.#levelRefilters,
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
    position: Camera | { readonly x: number; readonly z: number },
    radius = 0,
  ): IWorldRegionReadiness {
    const camera = "isCamera" in position && position.isCamera ? position : undefined;
    if (camera !== undefined) {
      camera.updateMatrixWorld(true);
      if (
        ![...camera.projectionMatrix.elements, ...camera.matrixWorldInverse.elements].every(
          Number.isFinite,
        )
      )
        throw new Error("WorldCells readiness requires a finite camera projection and transform.");
      this.#readinessFrustum.setFromProjectionMatrix(
        this.#readinessProjection.multiplyMatrices(
          camera.projectionMatrix,
          camera.matrixWorldInverse,
        ),
        camera.coordinateSystem,
      );
    }
    const point = camera
      ? camera.getWorldPosition(_readinessPosition)
      : (position as { readonly x: number; readonly z: number });
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.z) ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      throw new Error("WorldCells readiness requires finite coordinates and a nonnegative radius.");
    if (camera !== undefined) {
      const view = [
        ...camera.projectionMatrix.elements,
        ...camera.matrixWorldInverse.elements,
        point.x,
        (point as Vector3).y,
        point.z,
        camera.coordinateSystem,
        Number(this.#render.gpuOn),
      ];
      // Package placements/bounds are immutable; reach is compared too so edits cannot go stale.
      if (
        !view.every((value, index) => value === this.#readinessView[index]) ||
        this.#placementReach?.some((value, index) => value !== this.#readinessReach?.[index])
      ) {
        this.#readinessVisible.clear();
        this.#readinessView = view;
        if (this.#placementReach !== undefined) {
          this.#readinessReach ??= new Float32Array(this.#placementReach.length);
          this.#readinessReach.set(this.#placementReach);
        }
      }
    }
    const lowX = Math.floor((point.x - radius - this.#minX) / this.#cellSize);
    const highX = Math.floor((point.x + radius - this.#minX) / this.#cellSize);
    const lowZ = Math.floor((point.z - radius - this.#minZ) / this.#cellSize);
    const highZ = Math.floor((point.z + radius - this.#minZ) / this.#cellSize);
    let requiredCells = 0;
    let loadedCells = 0;
    let failures = 0;
    let requiredTerrainTiles = 0;
    let loadedTerrainTiles = 0;
    for (const cell of this.#cells) {
      if (camera === undefined) {
        if (cell.x < lowX || cell.x > highX || cell.z < lowZ || cell.z > highZ) continue;
      } else if (!this.#cellInView(cell, point as Vector3)) continue;
      requiredCells++;
      const resident = this.#resident.get(cellKey(cell.x, cell.z));
      if (
        resident &&
        this.#cellLoaded(resident) &&
        (camera === undefined || !this.#jobs.some((job) => job.cell === resident))
      )
        loadedCells++;
      if (resident?.chunkFailed) failures++;
      for (const run of cell.runs)
        if (this.#models.asset(this.#canonical(run.asset))?.failed) failures++;
    }
    if (camera !== undefined) {
      const terrain = this.#terrain?.readinessInView(camera, [
        this.#manifest.terrain.heightMin,
        this.#manifest.terrain.heightMax,
      ]) ?? { required: 0, loaded: 0 };
      requiredTerrainTiles = terrain.required;
      loadedTerrainTiles = terrain.loaded;
    } else {
      const terrain = this.#terrain?.readinessAt(point, radius) ?? { required: 0, loaded: 0 };
      requiredTerrainTiles = terrain.required;
      loadedTerrainTiles = terrain.loaded;
    }
    return {
      requiredCells,
      loadedCells,
      requiredTerrainTiles,
      loadedTerrainTiles,
      failures,
      cancelled: this.#released,
      ready:
        !this.#released &&
        failures === 0 &&
        loadedCells === requiredCells &&
        loadedTerrainTiles === requiredTerrainTiles &&
        (camera === undefined || (!this.#render.shadowMoved && !this.#refilterOwed)),
    };
  }

  /** Use the same authored placement bounds and distance test as admission, even before residency. */
  #cellInView(cell: IWorldCell, eye: Vector3): boolean {
    const cached = this.#readinessVisible.get(cell);
    if (cached !== undefined) return cached;
    this.#readinessVisible.set(cell, false);
    if (this.#terrain !== undefined || (cell.chunks?.length ?? 0) > 0) {
      const box = this.#recordBounds;
      box.min.set(
        this.#minX + cell.x * this.#cellSize,
        this.#extentBounds.min.y,
        this.#minZ + cell.z * this.#cellSize,
      );
      box.max.set(
        this.#minX + (cell.x + 1) * this.#cellSize,
        this.#extentBounds.max.y,
        this.#minZ + (cell.z + 1) * this.#cellSize,
      );
      if (this.#readinessFrustum.intersectsBox(box)) {
        this.#readinessVisible.set(cell, true);
        return true;
      }
    }
    for (const run of cell.runs) {
      const asset = this.#manifest.assets[this.#canonical(run.asset)];
      if (asset === undefined) continue;
      const records = cellPlacements(this.#placements, run);
      for (let index = 0; index < run.count; index++) {
        const at = index * PLACEMENT_RECORD_FLOATS;
        this.#position.fromArray(records, at);
        const distance =
          this.#placementReach === undefined
            ? Math.hypot(this.#position.x - eye.x, this.#position.z - eye.z)
            : this.#position.distanceTo(eye);
        const reach = this.#placementReach?.[run.offset + index];
        if (reach !== undefined && distance > reach) continue;
        this.#rotation.fromArray(records, at + 3);
        this.#scale.setScalar(records[at + 7] as number);
        this.#matrix.compose(this.#position, this.#rotation, this.#scale);
        const box = this.#boundsAt(asset.bounds, this.#matrix);
        const inner = cullDistance(asset.maxDistance);
        const centre = box.getCenter(this.#sourceCentre);
        const drawDistance = this.#render.gpuOn
          ? Math.hypot(centre.x - eye.x, centre.z - eye.z)
          : distance;
        if (inner !== undefined && drawDistance > inner) continue;
        if (this.#readinessFrustum.intersectsBox(box)) {
          this.#readinessVisible.set(cell, true);
          return true;
        }
      }
    }
    return false;
  }

  /** Terrain data needed by the current camera, including visible tiles not yet admitted. */
  terrainReadinessInView(camera: Camera): { required: number; loaded: number } {
    return (
      this.#terrain?.readinessInView(camera, [
        this.#manifest.terrain.heightMin,
        this.#manifest.terrain.heightMax,
      ]) ?? { required: 0, loaded: 0 }
    );
  }

  /** Visible CPU scatter batches still awaiting a nonempty main-camera backend submission. */
  pendingCpuDrawsInView(camera: Camera): number {
    return this.#prewarm.pendingCpuDrawsInView(this, camera, this.#chunks.renderer);
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
    this.#render.resetShadows();
    // Every chunk is gone by now, so the surfaces the world owns on their behalf are the last thing
    // holding them, and they are released here rather than by whichever chunk contributed them.
    this.#chunks.releaseMaterials();
    this.#chunks.renderer = undefined;
    this.#chunks.camera = undefined;
    this.#render.clearCompileRecords();
    // After every asset's release above, so no record is still held by a surface; disposes the cached
    // atlases and aborts any bake still in flight.
    this.#impostorState.drainImpostors();
    this.#render.releaseGpu();
    if (this.#render.drainShared() > 0) this.#failures += 1;
    // The batches `#drainShared` just retired. Their geometry and material were released by the
    // refcount path above, which is why they are disposed and not reused.
    this.#render.releaseRetired();
    this.#render.releaseLodMaterials();
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
      const rangeRoots = this.#lodHysteresis > 0 && !this.#render.gpuOn ? instances : 0;
      const bytes = instances * PLACEMENT_RECORD_BYTES + rangeRoots * LOD_RANGE_RECORD_BYTES * 2;
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
      chunkInstances: new Map(),
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
    this.#render.cullResident(cell);
    this.#residencyEpoch += 1;
    this.#instances += instances;
    this.#bytes += bytes;
    for (const run of cell.runs) this.#models.acquire(run, state);
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
      lodRanges: undefined,
      cell,
      force,
      gpuByLevel: undefined,
      filterY: this.#followY(),
      filterX: this.#follow.position.x,
      filterZ: this.#follow.position.z,
      fresh: [],
      replacement: replace,
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
      this.#frontNearest();
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
      if (this.#render.meshStalled) break;
      // A finished build leaves the queue at this index, so the next one is served without a skip.
      if (finished) {
        for (const entry of job.fresh)
          if (entry.batch.count > 0 && entry.shadowBounds !== undefined)
            this.#onPublication?.(entry.shadowBounds);
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

  /**
   * Put the unstarted build nearest the follow point at the front, unless a build is mid-way.
   * Each model's load queues every resident cell at once, so append order is load order: the
   * spawn cell of the last model to load waited behind the whole ring.
   */
  #frontNearest(): void {
    const front = this.#jobs[0];
    if (front === undefined || front.next > 0 || front.batches !== undefined) return;
    const { x, z } = this.#follow.position;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.#jobs.length; i++) {
      const job = this.#jobs[i] as IBuildJob;
      if (job.next > 0 || job.batches !== undefined) continue;
      const d = Math.hypot(
        this.#minX + (job.cell.x + 0.5) * this.#cellSize - x,
        this.#minZ + (job.cell.z + 0.5) * this.#cellSize - z,
      );
      if (d < best) {
        best = d;
        nearest = i;
      }
    }
    if (nearest > 0) this.#jobs.unshift(...this.#jobs.splice(nearest, 1));
  }

  #forget(index: number, job: IBuildJob): void {
    this.#jobs.splice(index, 1);
    this.#queued.delete(job.run);
  }

  /** Placement slices and meshes left to publish, plus the terrain's outstanding admission. */
  #backlog(): number {
    let units = this.#terrain?.deferredAdmissions ?? 0;
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
      if (this.#lodHysteresis > 0 && job.asset.distances.length > 1)
        job.lodRanges ??= job.batches.map((levels) => levels.map(() => []));
      // One box per `(level, part)` beside the batches it measures, so the swap that hands the
      // records to the renderer can name where they are; see `#addPlacements`.
      job.boxes ??= newBoxes(job.batches);
      const end = Math.min(job.next + ADMISSION_SLICE_PLACEMENTS, job.run.count);
      this.#addPlacements(job, job.next, end);
      job.next = end;
      this.#admissionCompletedUnits += 1;
      return false;
    }
    const batches = job.batches;
    // A run with nothing placed in it publishes nothing, exactly as an unbounded build would.
    if (batches === undefined) return true;
    if (job.published < publishCount(batches)) {
      const published = job.published;
      this.#buildOne(job, batches);
      if (job.published > published) this.#admissionCompletedUnits += 1;
      return false;
    }
    const swapped = this.#render.swap(job);
    if (swapped) this.#admissionCompletedUnits += 1;
    return swapped;
  }

  /**
   * Filter one slice of a run's placements into the batches they draw from, applying the CPU
   * maxDistance/reach filters at the build position and switching level where an asset's `lods` say
   * to. GPU admission retains maxDistance candidates for the dispatch; placementReach stays here
   * because it is an explicit per-record source boundary.
   */
  #addPlacements(job: IBuildJob, from: number, to: number): void {
    const { asset, filterX, filterZ } = job;
    if (job.replacement && job.next === 0) this.#levelRefilters += 1;
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
      if (this.#render.gpuOn === false && inner !== undefined && distance > inner) continue;
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
        {
          distances: asset.distances,
          impostor: asset.impostor !== undefined && asset.definition.impostorDistance === undefined,
        },
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
      const selected = [level];
      if (this.#lodHysteresis > 0) {
        const d = biasedLodDistance(distance);
        for (let adjacent = 0; adjacent < asset.levels.length; adjacent++) {
          if (adjacent === level) continue;
          const near = asset.distances[adjacent] ?? 0;
          const far = asset.distances[adjacent + 1] ?? Number.POSITIVE_INFINITY;
          const slack =
            Math.max(near, Number.isFinite(far) ? far : near) * this.#lodHysteresis +
            (asset.distances[1] ?? 6) / 8;
          if (d >= near - slack && d <= far + slack) selected.push(adjacent);
        }
      }
      const minPublished = Math.min(...selected);
      const maxPublished = Math.max(...selected);
      // The record's own world bounds: the placement widened by the asset's authored bounds at the
      // scale it is drawn at. Read here because this loop already holds the placement and the scale,
      // and it is the one number the shadow levels' invalidation is tested against — the cell box is
      // 64 m of it, so a level whose window is 48 m wide was redrawing over ground nothing in it.
      const bounds = asset.definition.bounds;
      // The far shadow of an asset that can bake a whole-asset impostor draws one quad per placement
      // at the placement root: the parts' own offsets are baked into the atlas, so composing a source
      // part's offset again would apply it twice. One root record per placement, beside the per-part
      // batches and read only by the wide half; see `ICellBatch.wideRoot`.
      for (level of selected) {
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
        if (this.#render.gpuOn) {
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
          const range = job.lodRanges?.[level]?.[part];
          if (range !== undefined) range.push(minPublished, maxPublished);
          const box = levelBoxes?.[part];
          if (box === undefined) continue;
          box.union(this.#recordBounds);
        }
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
        lodRanges: job.lodRanges?.[level]?.[part]?.length
          ? Float32Array.from(job.lodRanges[level]?.[part] ?? [])
          : undefined,
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
    return this.#render.bundleGroup(mainShard(shared.mesh.name)) ?? null;
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
      for (const entry of job.fresh) this.#render.clearSegment(entry);
      this.#queueBuild(job.asset, job.cell, job.run, true, job.force);
    }
    for (const cell of this.#resident.values())
      for (const batch of cell.batches) {
        const asset = this.#models.asset(batch.asset);
        if (asset === undefined || asset.levels.length === 0) continue;
        // One rebuild per run, not per batch: a run's placements are one build, and queueing it per
        // batch would rebuild the same placements once per level and part.
        this.#queueBuild(asset, cell, batch.run, true);
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
      const asset = this.#models.asset(entry.asset);
      if (asset === undefined) continue;
      // GPU dispatch handles maxDistance and LOD gates; placementReach remains a CPU boundary.
      const gates = this.#render.gpuOn ? [] : asset.gates;
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
   * Queue a refilter for every batch whose follow point has moved far enough to have crossed a CPU
   * source-admission boundary: maxDistance/lod gates on the CPU path, or placementReach in either
   * path. GPU maxDistance/lod gates stay in the dispatch, so they do not enter this replacement
   * queue.
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
      const asset = this.#models.asset(job.id);
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
      for (const entry of job.fresh) this.#render.clearSegment(entry);
      return false;
    });
    for (const entry of cell.batches) this.#render.clearSegment(entry);
    // The same invalidation `#swap` makes, for the eviction path: the records that just left the
    // ring are ground the levels were drawing, and they are named one batch at a time.
    this.#render.shadowRecordsMoved(this.#render.changedBounds(cell.batches));
    cell.batches.length = 0;
    // The cell's record of those chunks goes with them, so a replay can never draw a cell the world
    // has released — before they leave the group, which is where it counts what it holds. See
    // `#addChunk`.
    this.#render.dropChunkBundles(cell);
    for (const chunk of cell.chunks) {
      chunk.removeFromParent();
      this.#failures += this.#models.disposeLoaded(chunk);
    }
    cell.chunks.length = 0;
    // The cell's chunk sources go back to the loader here, on the last cell that named them, exactly
    // as an asset's levels do in `#release`. Run even at teardown: the loader is never cleared, so a
    // path this world asked for must be handed back however the world leaves.
    this.#models.releaseModelPaths(cell.retainedModelPaths);
    this.#resident.delete(cell.key);
    this.#render.cullEvicted(cell);
    this.#instances -= cell.instances;
    this.#bytes -= cell.bytes;
    this.#evictions += 1;
    // Room just freed: retry the far aggregates a full budget refused, so a species held back while
    // the ring was tight appears without another scan. Skipped at teardown, where the far half drains.
    if (!this.#released) this.#impostorState.retryFar();
    // One per run, so the canonical's refcount reaches zero exactly when the last run naming any
    // member of its group has left the ring.
    for (const run of cell.cell.runs) this.#models.release(this.#canonical(run.asset));
  }
}
