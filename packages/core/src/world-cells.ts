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
import { InstancedBatch } from "./instanced-batch.js";
import { biasedLodDistance, setLodBias, worldSphere } from "./model-lod.js";
import { type OcclusionMode, occlusionMode } from "./render/depth-pyramid.js";

import { drainMeshPool } from "./render/mesh-pool.js";
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

import { CellLodBias } from "./world-cell-lod-bias.js";
import { CellPlacements, newBatches, newBoxes, publishCount } from "./world-cell-placements.js";
import { CellReadiness } from "./world-cell-readiness.js";
import { batchRecords } from "./world-cell-records.js";
import { CellResidency } from "./world-cell-residency.js";
import {
  type IShadowLevel,
  type IWorldGpuFrameValidation,
  bundlesAsked,
  gpuSceneRequested,
  levelAtGates,
  lodFromFollowRequested,
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

import {
  ADMISSION_SLICE_PLACEMENTS,
  COVERED_BUDGET_SCALE,
  DEFAULT_ADMISSION_BUDGET_MS,
  DEFAULT_AUTO_LOD_MAX_PIXEL_ERROR,
  DEFAULT_TILE_RESOLUTION,
  type IWorldCellsInit,
  LEVEL_REFILTER_STEP_METRES,
  SETTLED_FOLLOW_METRES,
  SMALL_CASTER_METRES,
  adaptiveLodRequested,
  autoLodPixelError,
  autoLodScale,
  impostorFarOption,
  impostorsRequested,
  mainGpuShare,
  tileResolutionFor,
} from "./world-cell-options.js";

// Four floats per record (`LOD_RANGE_STRIDE`): the published levels and the fade a swap stamps.

export { bundleSafeMaterial } from "./world-bundle-safety.js";
export { LOD_BIAS_MARKER } from "./world-cell-lod-bias.js";

/** Milliseconds one `update` may spend admitting streamed content, unless the game says otherwise. */

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
 * @constraint residency and `placementReach` follow `follow`; levels and `maxDistance` are graded from the render camera, as UE picks instance LODs per view; `lodFrom: "follow"`, `?tnLodFromCamera=0` or `TN_LOD_FROM_CAMERA=0` grade from `follow`, reported as `TN_WORLD_MAIN_CULL lodFrom=`
 * @constraint admission is bounded by `admissionBudgetMs` (default 2) per update across every path, plus at most one unit each for terrain and props; while props are queued terrain takes at most half, so neither starves the other, and a deferred cell keeps drawing what it has
 * @constraint SkinnedMesh parts are skipped; an instanced copy would draw one rest pose
 * @constraint a baked chain's switch distances are measured against `autoLod` (default 4 px of error over 60° and 1080 raster rows), because an instanced draw cannot select a level per instance; an asset with nonempty authored `lods` never consults it; explicit empty lists enroll only unchanged static geometry/material parts
 * @constraint eligible static sources can use cooked HLOD (chunk-only alongside GPU scatter, whole-cell on CPU) after compilation and an observed main-context backend submission; projected-error hysteresis requires actual source triangle reduction and no extra material draws, unsupported or shared source stays resident, and collision/shadow paths retain source representations; stats().hlod counts lifecycle and charged resources, not GPU timing or physical allocation
 * @override `hlod: false` keeps source rendering; ring, budgets, terrain tile size/resolution, terrain stream and collider radius, `transparentScatter`, `clusterSize` and `shadows.invalidate`, load `concurrency`, `rebuildsPerUpdate`, `admissionBudgetMs` and the package's per-asset maxDistance; `impostorFar: "always"` keeps the far aggregate the near ring's guaranteed radius made unnecessary
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
  readonly #ring: number;
  #terrain: TerrainTiles | undefined;
  readonly #hasColliders: boolean;
  readonly #lodHysteresis: number;
  /** The placement build: records to batches, and when a walk makes that answer stale. */
  readonly #placementBuild: CellPlacements;
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
  /** The resident ring, the build queue that fills it, and both sets of counters. */
  readonly #residency: CellResidency;
  readonly #extentBounds: Box3;
  /** The largest run of each asset in any cell: the segment size every cell of it fits. */
  readonly #runMax = new Map<string, number>();
  /** How many of an asset's finest levels cast shadows; 0 when the game asked for none. */
  readonly #castShadowLevels: number;
  /** Whether a short-range asset keeps a whole-map far aggregate; see the load option. */
  readonly #impostorFar: "ring" | "always";
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
  /** The game's hook to refresh the shadow levels after streamed records changed. */
  readonly #invalidateShadows: ((region?: IShadowRegion) => void) | undefined;
  readonly #budgetMs: number;
  readonly #coveredBudgetMs: number;
  /** Set for the length of one `process` call that runs behind the startup cover. */
  #covered = false;
  readonly #now: () => number;
  #admission = { spentMs: 0, deferred: 0, backlog: 0 };
  #failures = 0;
  /** Refilters whose rebuild came back identical and were settled without a write. */
  #unchanged = 0;
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
  /** See `IWorldCellsLoadOptions.lodFrom`. */
  readonly #lodFrom: "camera" | "follow";
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
  readonly #preserveAuthoredParts: boolean;
  /** The adaptive LOD bias loop: `adaptiveLod` and `mainGpuShare` resolved, and the bias it moves. */
  readonly #adaptiveBias: CellLodBias;

  readonly #render: CellRender;
  readonly #onPublication: IWorldCellsInit["onPublication"];
  /** Publications told after the frame's records reach the engine, so a told batch is drawable. */
  readonly #publications: Box3[] = [];
  /** The spawn and view gates, and the waiters they settle. */
  readonly #readiness: CellReadiness;
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
      backlog: () => this.#residency.backlog() + this.#impostorState.impostorStats().pending,
      workPending: () =>
        this.#residency.resident.size > 0 ||
        this.#models.loadsInFlight > 0 ||
        this.#models.loadsQueued > 0,
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
    this.#placementBuild = new CellPlacements(
      {
        lodHysteresis: this.#lodHysteresis,
        placementReach: init.placementReach,
        placements: init.placements,
        reachRanges: init.reachRanges,
        rebuildsPerUpdate: positiveInteger(init.rebuildsPerUpdate ?? 16, "rebuildsPerUpdate"),
      },
      {
        asset: (id) => this.#models.asset(id),
        canonical: (id) => this.#canonical(id),
        eye: () => this.#residency.eye,
        extent: () => ({ cellSize: this.#cellSize, minX: this.#minX, minZ: this.#minZ }),
        follow: () => this.#follow,
        gpuOn: () => this.#render.gpuOn,
        queueBuild: (asset, cell, run, replace) =>
          this.#residency.queueBuild(asset, cell, run, replace === true),
        residencyEpoch: () => this.#residency.residencyEpoch,
        resident: () => this.#residency.resident.values(),
        rootsNeeded: (asset) => this.#impostorState.rootsNeeded(asset),
      },
    );
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
        noteGate: (gate) => this.#placementBuild.noteGate(gate),
        queueBuild: (asset, cell, run, force) =>
          this.#residency.queueBuild(asset, cell, run, force),
        released: () => this.#released,
        failures: () => this.#failures,
        setFailures: (count) => {
          this.#failures = count;
        },
        reportCellFailure: (stage, key, paths, error) =>
          this.#reportCellFailure(stage, key, paths, error),
        drainShared: (assetId) => this.#render.drainShared(assetId),
        residentCells: () => this.#residency.resident.values(),
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
    this.#lodFrom = init.lodFrom ?? (lodFromFollowRequested() ? "follow" : "camera");
    const asked = bundlesAsked();
    this.#bundlesWanted = init.bundles ?? asked !== "off";
    this.#bundleReason =
      init.bundles === undefined ? (asked === "default" ? "default" : "launch") : "option";

    this.#preserveAuthoredParts = init.preserveAuthoredParts ?? false;
    // The warm-up and the step cadence are the world's own clock, so loading does not count as a
    // second of adaptation and a test can drive the loop with an injected `admissionNow`.
    this.#adaptiveBias = new CellLodBias(
      init.adaptiveLod ?? adaptiveLodRequested(),
      // Ahead of `impostorFar` and `clusterSize`, as it always was: with more than one invalid
      // option the share's error is the one a game sees. See `world-cells-options.spec.ts`.
      mainGpuShare(init.mainGpuShare),
      {
        now: () => this.#now(),
        apply: (bias) => {
          setLodBias(bias);
          this.#render.setLodBias(bias);
        },
        gpuTriangles: () => this.gpuSceneTally()?.triangles,
        prewarm: () => ({
          queued: this.#prewarm.queued,
          owed: this.#prewarm.owed,
          drawn: this.#prewarm.drawn,
        }),
        renderer: () => this.#chunks.renderer,
      },
    );
    this.#gpuValidate = init.gpuSceneValidate;
    this.#occlusion = init.occlusion ?? occlusionMode();
    this.#gpuTally = init.gpuSceneTally === true;
    this.#castShadowLevels =
      init.shadows?.cast === true
        ? positiveInteger(init.shadows.castLevels ?? 1, "shadows.castLevels")
        : 0;
    this.#receiveShadow = init.shadows?.receive === true;
    this.#impostorFar = impostorFarOption(init.impostorFar);
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
        shadowMinLevel:
          init.shadows?.minLevel === undefined
            ? 0
            : nonNegativeInteger(init.shadows.minLevel, "shadows.minLevel"),
        extentBounds: this.#extentBounds,
        preserveAuthoredParts: this.#preserveAuthoredParts,
        lodHysteresis: this.#lodHysteresis,
        lodTransition: init.lodTransition ?? "band",
        lodSpatial: this.#placementBuild.placementReach !== undefined,
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
        // Live, not a snapshot: three refreshes `matrixWorld` before it renders, so a game that moves
        // the root reads its own frame from the next update on — the same answer `stepCellProxies`
        // is handed below.
        root: () => this.matrixWorld,
        now: () => this.#now(),
        stats: () => this.stats(),
        residentCells: () => this.#residency.resident.values(),
        runMax: (asset) => this.#runMax.get(asset),
        widenFilterRange: (cell, x, z) => this.#placementBuild.widenFilterRange(cell, x, z),
        cellBatchesChanged: (cell) => this.#placementBuild.cellBatchesChanged(cell),
        addUnchanged: () => {
          this.#unchanged += 1;
        },
        disableFar: (run) => this.#impostorState.disableFar(run),
        deferWide: (id) => this.#impostorState.deferWide(id),
        queuedBuilds: () => this.#residency.queuedBuilds,
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
        placementReach: this.#placementBuild.placementReach,
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
        sourceBytes: () => this.#residency.bytes + this.#impostorState.farBytes,
        load: (path, wanted) => this.#models.load(path, wanted),
        cellLive: (cell, generation) => this.#residency.cellLive(cell, generation),
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
        impostorFar: this.#impostorFar,
        // The ring guarantees every cell this close is resident, so a far record past it is always
        // further than the asset's own cull; see `CellImpostors.#farReaches`.
        nearRingRadius: this.#ring * this.#cellSize,
      },
      {
        released: () => this.#released,
        covered: () => this.#covered,
        renderer: () => this.#chunks.renderer,
        asset: (id) => this.#models.asset(id),
        hasAsset: (id) => this.#models.hasAsset(id),
        assets: () => this.#models.assets(),
        nearWorkPending: () =>
          this.#residency.queuedBuilds > 0 ||
          this.#models.loadsInFlight > 0 ||
          this.#models.loadsQueued > 0 ||
          this.#prewarm.queued > 0,
        newAsset: (id, definition) => this.#models.newAsset(id, definition),
        startAssetLoad: (asset) => this.#models.startAssetLoad(asset),
        release: (id) => this.#models.release(id),
        noteGate: (gate) => this.#placementBuild.noteGate(gate),
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
                this.#residency.counters().residentCells + 1,
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
          for (const cell of [...this.#residency.resident.values()]) {
            for (const run of cell.cell.runs) {
              if (this.#canonical(run.asset) === asset.id)
                this.#residency.queueBuild(asset, cell, run, true);
            }
          }
        },
        residentCell: (key) => this.#residency.resident.get(key),
        canonical: (id) => this.#canonical(id),
        shadowRecordsMoved: () => this.#render.shadowRecordsMoved(),
        residency: () => ({
          instances: this.#residency.instances,
          bytes: this.#residency.bytes,
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
    // One read of the residency collaborators, built once: the pass asks for it many times a frame,
    // so a fresh object per ask would allocate on the hot path. `terrain` is the one part the
    // constructor builds after this host, so it is a getter; a copied value would read as no terrain
    // for the world's whole life.
    const world = this;
    const parts = {
      chunks: this.#chunks,
      impostor: this.#impostorState,
      models: this.#models,
      placements: this.#placementBuild,
      prewarm: this.#prewarm,
      render: this.#render,
      get terrain(): TerrainTiles | undefined {
        return world.#terrain;
      },
    };
    this.#residency = new CellResidency({
      addFailures: (count) => {
        this.#failures += count;
      },
      asset: (id) => this.#models.asset(id),
      budgets: () => this.#budgets,
      canonical: (id) => this.#canonical(id),
      cells: () => this.#cells,
      extent: () => ({ cellSize: this.#cellSize, minX: this.#minX, minZ: this.#minZ }),
      follow: () => this.#follow,
      lodFrom: () => this.#lodFrom,
      lodHysteresis: () => this.#lodHysteresis,
      now: () => this.#now(),
      parts: () => parts,
      prefetchSeconds: () => this.#prefetchSeconds,
      published: (bounds) => {
        if (this.#onPublication !== undefined) this.#publications.push(bounds.clone());
      },
      released: () => this.#released,
      ring: () => this.#ring,
      root: () => this.matrixWorld,
    });
    this.#readiness = new CellReadiness({
      asset: (id) => this.#models.asset(id),
      buildQueued: (cell) => this.#residency.hasBuild(cell),
      canonical: (id) => this.#canonical(id),
      cells: () => this.#cells,
      extent: () => ({ cellSize: this.#cellSize, minX: this.#minX, minZ: this.#minZ }),
      extentBounds: () => this.#extentBounds,
      gpuOn: () => this.#render.gpuOn,
      loaded: (cell) => cellLoaded(cell),
      manifestAsset: (id) => this.#manifest.assets[id],
      placementReach: () => this.#placementBuild.placementReach,
      placements: () => this.#placements,
      prewarm: () => this.#prewarm,
      refilterOwed: () => this.#placementBuild.owed,
      released: () => this.#released,
      renderer: () => this.#chunks.renderer,
      resident: (key) => this.#residency.resident.get(key),
      root: () => this,
      shadowMoved: () => this.#render.shadowMoved,
      terrain: () => this.#terrain,
      terrainHeights: () => [init.manifest.terrain.heightMin, init.manifest.terrain.heightMax],
    });
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
      extent: {
        maxX: init.manifest.extent.minX + init.manifest.extent.sizeX,
        maxZ: init.manifest.extent.minZ + init.manifest.extent.sizeZ,
        minX: init.manifest.extent.minX,
        minZ: init.manifest.extent.minZ,
      },
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
   * nothing and builds nothing. A world with nothing to prewarm — no resident cell and no model
   * load, so no update of its own can queue one — settles on those updates like a drained world,
   * which is what lets a game await it for every world it streams. `dispose` settles it too: a
   * world torn down mid-load must not leave a game awaiting it forever.
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
    for (const child of this.#snapshotChildren) this.remove(child);
    this.#snapshotChildren.length = 0;
    // Kept for the chunk warm-up below: a chunk is loaded asynchronously and compiled when it
    // arrives, which can be a frame or a loading screen after the frame that gave us these.
    if (renderer !== undefined) this.#chunks.renderer = renderer;
    if (camera !== undefined) this.#chunks.camera = camera;
    this.#residency.updateEye();
    this.#render.updateLodEye(this.#residency.eye.x, this.#residency.eye.y, this.#residency.eye.z);
    this.#render.flushCompiles(renderer);
    // The adaptive LOD bias, before the dispatch below reads the gates it scales.
    this.#adaptiveBias.step(renderer);
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
      this.#residency.seedGpuSources();
      this.#render.seedGpuKeys();
      // After the keys, because that is the only point at which the marker can say how many of the
      // world's main meshes are dressed: printed at enable it would read the ring as it was a frame
      // earlier, which is the state the run that found this was in.
      this.#render.announceGpu();
    }
    const x = this.#follow.position.x;
    const z = this.#follow.position.z;
    // Terrain admits first, and a tile is one unit of several milliseconds, so after a jump (a
    // teleport, a review camera) the 17 x 17 terrain ring spent the whole allowance every frame for
    // seconds and the prop queue got nothing: the forest never built where the camera landed. While
    // props are queued the terrain is held to half, and the props get whatever it left.
    const budgetMs = this.#covered ? this.#coveredBudgetMs : this.#budgetMs;
    const terrainMs = this.#residency.queuedBuilds > 0 ? budgetMs / 2 : budgetMs;
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
    if (this.#residency.stale(x, z))
      this.#residency.pass(x, z, budget, renderer, camera, terrainView);
    else if (
      // A blend in flight is not a settled ring, and the blend is advanced by `process` alone —
      // `follow` only re-levels tiles. A follow point standing still used to skip both, so a
      // three-frame tile morph froze on its first frame until the player moved again.
      // With a render view, settled tiles also recheck cached errors against the current projection.
      terrainView !== undefined ||
      (this.#terrain?.blendingTiles ?? 0) > 0
    ) {
      this.#terrain?.process(renderer, camera, undefined, terrainView);
    }
    // The refilter is a scan of every resident cell, so it runs on its own cadence rather than
    // with the residency pass above; see `#refilterStale` and `LEVEL_REFILTER_STEP_METRES`. Outside
    // that pass, because a camera moving round a player standing still moves the LOD eye alone.
    // GPU source admission keeps every resident maxDistance candidate, so the dispatch's slot
    // cull and level gates handle a moving camera without a CPU replacement. `#staleIn` still
    // watches placementReach, whose per-record admission boundary has no GPU slot equivalent.
    if (this.#placementBuild.stale(x, z)) this.#placementBuild.refilter(x, z);
    const props = new AdmissionBudget(budgetMs - Math.min(budget.spentMs, terrainMs), this.#now);
    this.#residency.drain(props);
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
      this.#residency.resident.values(),
      this.matrixWorld,
      props,
      renderer,
      camera,
    );
    this.#render.reportMainCull();
    // Last, after every write, clear, compact, grow and cull repack above: the frame's instance
    // records reach the engine in one call (see `world-cell-records.ts`).
    batchRecords.flush();
    this.#tellPublications();
    this.#admission = {
      backlog: this.#residency.backlog(),
      deferred: this.#residency.queuedBuilds,
      spentMs: budget.spentMs + props.spentMs,
    };
    // After this frame's admissions, so a region admitted by this update answers its waiters in it.
    this.#readiness.settleWaiters();
  }

  /** The frame's publications, told once their records are in the engine's buffers. */
  #tellPublications(): void {
    for (const bounds of this.#publications.splice(0)) this.#onPublication?.(bounds);
  }

  process(renderer?: IRendererLike, camera?: Camera, covered = false): void {
    this.#covered = covered;
    try {
      this.update(renderer, camera);
    } finally {
      this.#covered = false;
    }
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
    const counters = this.#residency.counters();
    const gpu = this.#render.report();
    const census = this.#render.gpuCensus();
    return {
      admission: { ...this.#admission },
      bundle: this.#render.bundleStats(),
      evictions: counters.evictions,
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
      instances: counters.instances,
      loadsInFlight: this.#models.loadsInFlight,
      loadsQueued: this.#models.loadsQueued,
      admissionBacklog: this.#residency.backlog(),
      admissionCompletedUnits: counters.admissionCompletedUnits,
      mainCull: this.#render.mainCullStats(),
      // Minted meshes still owed a first draw, not minted meshes. The two used to be the same
      // number, so a loading bar read minting as the whole of the prewarm and then stood still for
      // the whole draw — the node builds a bar cannot show. The gate is a promise about batches, so
      // the settle zeroes this pair: `0` once `prewarmed` has resolved.
      pendingPrewarm: this.#prewarm.queued + this.#prewarm.owed - this.#prewarm.drawn,
      prewarmMinted: this.#prewarm.minted,
      pressure: { ...counters.pressure },
      // The pass itself, counted whether or not it found anything: `rebuilds` cannot tell a skipped
      // pass from one that scanned every resident cell and found the same brackets, and that gap is
      // the whole cost of the 2 m step. See `#refilterStale`.
      refilters: this.#placementBuild.refilters,
      refilterEntries: this.#placementBuild.refilterEntries,
      rebuilds: this.#placementBuild.rebuilds,
      levelRefilters: this.#placementBuild.levelRefilters,
      lodFrom: this.#lodFrom,
      // The share of `rebuilds` the swap found unchanged, which is the honest report of how much of
      // the refilter pass is a bracket that was wider than any placement.
      unchanged: this.#unchanged,
      residentCells: this.#residency.counters().residentCells,
      residentBytes: counters.bytes,
      loadedCells: [...this.#residency.resident.values()].filter((cell) => this.#cellLoaded(cell))
        .length,
      residentKeys: [...this.#residency.resident.keys()].sort(),
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
    return this.#readiness.at(position, radius);
  }

  /** Terrain data needed by the current camera, including visible tiles not yet admitted. */
  terrainReadinessInView(camera: Camera): { required: number; loaded: number } {
    return this.#readiness.terrainReadinessInView(camera);
  }

  /** Visible CPU scatter batches still awaiting a nonempty main-camera backend submission. */
  pendingCpuDrawsInView(camera: Camera): number {
    return this.#readiness.pendingCpuDrawsInView(camera);
  }

  /** Resolves when the content a fixed spawn needs has finished loading; see `CellReadiness`. */
  whenSpawnReady(
    position: { readonly x: number; readonly z: number },
    radius = 0,
    timeoutMs = 120_000,
  ): Promise<IWorldRegionReadiness> {
    return this.#readiness.whenSpawnReady(position, radius, timeoutMs);
  }

  override dispose(): void {
    if (this.#released) return;
    this.#released = true;
    // A world torn down mid-wait must not leave a game awaiting its spawn gate, nor a deadline
    // outliving the world that armed it.
    this.#readiness.cancelWaiters();
    this.#prewarm.releaseHooks();
    this.#residency.evictAll();
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
    // r186's Object3D.dispose() dispatches the dispose event the renderer frees this object's
    // render objects on, so an override must reach it.
    super.dispose();
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
}
