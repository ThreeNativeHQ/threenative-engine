import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Material,
  Matrix4,
  Mesh,
  Object3D,
  Quaternion,
  SkinnedMesh,
  Sphere,
  Vector3,
} from "three";
import { BundleGroup } from "three/webgpu";
import { type IAssetLoader, createAssetLoader } from "./assets.js";
import type { IComputeDriven } from "./compute-driven.js";
import { isEngineRenderHook, markEngineRenderHook } from "./engine-render-hook.js";
import { INSTANCED_LOD_MAX_PIXEL_ERROR } from "./instanced-batch-lod.js";
import { InstancedBatch } from "./instanced-batch.js";
import { mergeByMaterial } from "./merge-parts.js";
import {
  type ILodChain,
  biasedLodDistance,
  conservativeViewDepth,
  lodChainOf,
  setLodBias,
  worldSphere,
} from "./model-lod.js";
import { displacesVertices } from "./projection-plan.js";
import { type OcclusionMode, occlusionMode } from "./render/depth-pyramid.js";
import { cutoutSurface } from "./render/foliage-alpha.js";
import { materialKey } from "./render/material-key.js";
import {
  advanceWriteEpoch,
  currentWriteEpoch,
  drainMeshPool,
  dropPooledFor,
  parkMesh,
  pooledMesh,
} from "./render/mesh-pool.js";
import {
  IMPOSTOR_FAR_CULL_ATTRIBUTE,
  WorldImpostorSurface,
} from "./render/world-impostor-surface.js";
import {
  type IImpostorPart,
  type IImpostorRawRenderer,
  IMPOSTOR_FRAME_PIXELS,
  IMPOSTOR_VIEWS,
  WORLD_IMPOSTOR_MARKER,
  type WorldImpostorAtlas,
  WorldImpostorBaker,
  impostorBounds,
} from "./render/world-impostor.js";
import type { IRendererLike } from "./renderer.js";
import { isStatic, markStatic } from "./static-transform.js";
import { addInSlices, loadAll } from "./streaming.js";
import { DEFAULT_TARGET_FPS } from "./target-fps.js";
import { within, yieldToHost } from "./warmup.js";
import {
  CellProxySelection,
  type IPreparedCellProxy,
  cellProxyGeometrySafe,
  cellProxyMaterialMatches,
  cellProxyMaterialSafe,
  cellProxySourceSafe,
  cellProxyWorldScale,
  measureCellProxy,
  prepareCellProxy,
} from "./world-cell-proxy.js";
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

const PLACEMENT_RECORD_BYTES = 32;
const PLACEMENT_RECORD_FLOATS = 8;
const DEFAULT_TILE_RESOLUTION = 129;
const CHUNK_NAME = "world-chunk";
/**
 * Bytes one merged chunk group may hold: 4 MiB, which is where a single first-draw upload stops
 * being a few milliseconds and becomes a frame.
 *
 * The 228.8 MB of `createAttribute` buffers a browser walk measured — 826 buffers, 33 over 1 MB,
 * the largest 23.2 / 18.1 / 17.2 / 16.4 MB — all arrived on the first draw of a merged chunk mesh,
 * and that first draw took up to 230 ms. A group is split rather than grown, so each of those
 * uploads is bounded and none of them is a stall.
 */
const CHUNK_MERGE_MAX_BYTES = 4 * 1024 * 1024;
/** Position (12) + normal (12) + uv (8) in float32: the three channels a merged group keeps. */
const CHUNK_MERGE_BYTES_PER_VERTEX = 32;
/** Vertices in 4 MiB of the above. The budget a chunk's material group is split on. */
const CHUNK_MERGE_MAX_VERTICES = CHUNK_MERGE_MAX_BYTES / CHUNK_MERGE_BYTES_PER_VERTEX;
/**
 * Triangles a chunk's merged material group may reach before one of its `InstancedMesh` is left
 * instanced instead. A merged group is one draw; past this many triangles the instanced draw is the
 * cheaper of the two, so the mesh is kept rather than expanded. It is the same 4 MiB counted in the
 * worst case, a de-indexed triangle of three 32-byte vertices, so the cap and the vertex budget above
 * are the one size read in two units. See `IWorldCellsLoadOptions.chunkMergeMaxTriangles`.
 */
const CHUNK_MERGE_MAX_TRIANGLES = Math.floor(
  CHUNK_MERGE_MAX_BYTES / (3 * CHUNK_MERGE_BYTES_PER_VERTEX),
);
/**
 * How long one chunk's warm-up may take before the chunk is attached uncompiled. The engine's own
 * loading-screen bound for a single pipeline is 2,000 ms, and a compile that outlives it is a
 * compile that is not coming back — which is a slow frame rather than a chunk that never appears.
 */
const CHUNK_WARM_TIMEOUT_MS = 2000;
/** The engine frame clock, for the warm-up's bound. */
const warmClock = (): number => globalThis.performance?.now() ?? Date.now();
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
 * Records a retired batch's instance buffer is shrunk to; see `SharedBatch.park`.
 *
 * A released batch holds no records, so what keeping it is buying is the uuid three built a node for,
 * and the buffer is the whole of what that retention costs. At the batch's own ring capacity the
 * walk's back-traffic costs more than the byte budget holds, so the budget evicts the very keys a
 * walk is about to return to and the walk re-mints a mesh for each of them. Parked, a key costs
 * `PARKED_SHARED_CAPACITY` records; `rebind` puts the capacity back before anything is written.
 */
const PARKED_SHARED_CAPACITY = 1;
/**
 * Prewarmed batches minted per update, and the updates a minted batch must survive before it counts
 * as drawn. Three keys its render-object/node cache by `object.uuid`, so every InstancedMesh it has
 * never drawn costs a NodeBuilder build the first frame it is projected (~9 ms in the main pass, and
 * again in the shadow pass for a level that casts): hundreds of them land in a few seconds of
 * walking, which is the walk-time frame cost this pays earlier instead.
 *
 * The rate is a rate of *rendered* updates, not of `update` calls. Minting a batch is cheap (an
 * InstancedMesh and a zeroed buffer) and its build is paid by the next render, so an unbounded queue
 * would hand the whole map's seconds of builds to one frame. 8 per update is ~150 ms of build on the
 * frame that pays it, which the loading screen covers.
 */
const PREWARM_PER_UPDATE = 8;
/**
 * Two updates is the honest floor for "drawn at least once in both the main and the shadow
 * context": the mesh is added during one update and the next render projects it. Tracking it per
 * context would mean hooking the renderer, which this class does not own.
 */
const PREWARM_WARM_UPDATES = 2;
/**
 * Updates a mesh may still be owed a prewarm draw after the gate settled before its borrow is handed
 * back anyway. An empty prewarmed batch draws, so this is the ceiling on the ones that never will —
 * a projection that collapsed the world, a camera that never reached the mesh — and not a diagnosis
 * of any of them. Without it those meshes would hold their hook for the whole walk.
 */
const PREWARM_RELEASE_UPDATES = 8;
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
 * GPU bytes of completed impostor atlases one world admits, 128 MiB. A 128 px two-attachment RGBA8
 * atlas with mips is 2,796,160 B, so 48 fit and the 49th is refused before its atlas is allocated,
 * keeping its source LODs. An atlas a live asset still draws from is never evicted, so the active
 * record count is a hard admission cap rather than a target the cache trims toward — eviction only
 * ever drops an inactive record to make room for a new one.
 */
const DEFAULT_IMPOSTOR_ATLAS_BUDGET_BYTES = 128 * 1024 * 1024;
/**
 * The declared byte cost of one atlas at the bake's fixed frame, the same numbers
 * `WorldImpostorAtlas.bytes` reports: both RGBA8 attachments' mip chains, the logical colour atlas
 * cost rather than every physical GPU buffer a render target holds. Computed here so the cache
 * budget is enforced BEFORE `baker.begin` allocates the atlas, never after.
 */
const IMPOSTOR_ATLAS_BYTES = ((): number => {
  const levels = Math.floor(Math.log2(Math.max(1, IMPOSTOR_FRAME_PIXELS))) + 1;
  let bytes = 0;
  for (let level = 0; level < levels; level += 1) {
    const edge = Math.max(1, IMPOSTOR_FRAME_PIXELS >> level);
    bytes += edge * edge * IMPOSTOR_VIEWS * 4;
  }
  return 2 * bytes;
})();
/**
 * The far-residency diagnostic marker: one bounded line per whole-map aggregate built, naming the one
 * `InstancedMesh` per atlas cache key, its original placements, the live/near-owned split, its
 * physical instance bytes and how many times its instance buffer has been written.
 */
const WORLD_IMPOSTOR_FAR_MARKER = "TN_WORLD_IMPOSTOR_FAR";
/**
 * Bytes one far instance costs: its sixteen-float32 matrix plus the one-float per-instance cull the
 * shared far surface reads. Both are physical allocations the budget bounds; the cull is uploaded
 * once because the placement never moves.
 */
const FAR_INSTANCE_BYTES = 16 * 4 + 4;
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
 * The layer the level shadow cameras render and the main camera does not; see
 * `VirtualShadowNode`'s `VIRTUAL_SHADOW_CASTER_LAYER`. Duplicated from `index.ts` rather than
 * imported, because the world chunk is separate from the main one and this is the one value the two
 * halves of the cascade have to agree on.
 */
const VIRTUAL_SHADOW_CASTER_LAYER = 28;
/**
 * The layer the wide shadow levels render and the fine ones do not: one caster mesh per
 * `asset:level:part` holding every cell's records, for a level whose window covers the whole
 * resident ring, where a cluster per square is a draw per square for the same pixels. Duplicated
 * from `index.ts` like the layer above, and a bit of its own so a level camera renders one caster
 * granularity or the other and never both.
 */
const VIRTUAL_SHADOW_WIDE_CASTER_LAYER = 27;
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
/** The whole ring, as one caster cluster: `@*` is every square's records in one mesh. */
const WIDE_CLUSTER = "*";
/**
 * Placements filtered per unit of admission work.
 *
 * One unit is what a frame can overshoot its budget by, so it is sized to stay small rather than to
 * divide the work evenly: a slice is a few hundred placements' worth of matrix maths, tens of
 * microseconds, whatever the cell holds. ponytail: a count, not a time — the budget is the clock,
 * and this only decides how often it is read.
 */
const ADMISSION_SLICE_PLACEMENTS = 256;

/** The point a streamed world follows; an `Object3D` satisfies this shape. */
export interface IWorldCellsFollow {
  readonly position: { readonly x: number; readonly y?: number; readonly z: number };
}

/** Hard caps on what stays resident. A cap that is reached reports pressure, it never throws. */
export interface IWorldCellsBudget {
  readonly residentCells: number;
  readonly instances: number;
  /** Placement-record bytes (`32` per instance) the resident cells are allowed to weigh. */
  readonly bytes: number;
}

/** Terrain options forwarded to the composed `TerrainTiles`; `tileSize` defaults to `cellSize`. */
export interface IWorldCellsTerrainOptions {
  readonly tileSize?: number;
  readonly tileResolution?: number;
  readonly lodFactors?: readonly number[];
  readonly lodDistances?: readonly number[];
  readonly skirtDepth?: number;
  /**
   * Tiles kept resident around the follow tile, independent of the cell `ring`: terrain can reach
   * to the horizon while props stay near. Defaults to `ring`, so raising only this widens the
   * ground without widening the props, and the far tiles take the coarser `lodDistances` levels.
   */
  readonly streamRadius?: number;
  /**
   * Tiles that get a `createCollider` body, by Chebyshev radius from the follow tile. Defaults to
   * `ring`. A tile entering or leaving it creates or disposes its collider, so a wide terrain
   * radius does not have to mean a physics body for every tile in it.
   */
  readonly colliderRadius?: number;
}

export interface IWorldCellsLoadOptions {
  /**
   * Logical path of `world.json` (`world/world.json`); every other path in the package resolves
   * against it. A leading `/` is accepted and stripped, so an uncompiled `public/world` keeps
   * working.
   */
  readonly url: string;
  /**
   * Loader the package's paths resolve through — its manifest, or the authored names when there is
   * none. Defaults to a fresh `createAssetLoader()`; inside a game, pass `ctx.assets` so the
   * package's compiled output and compressed textures reach the renderer the game booted with.
   *
   * The world releases the source models it asks this loader for only when it created the loader
   * itself: each asset's requested level paths are released through `release("model", path)` once
   * the last asset naming a path is gone, so a streamed package does not pin an internally owned
   * cache. An explicitly supplied loader is the caller's — the world never releases its cache, so a
   * second game or world holding the same model keeps it alive; the caller ends that lifetime with
   * its own `release`. The loader is never cleared, and a path this world never asked for is never
   * touched either way.
   */
  readonly assets?: IAssetLoader;
  /** Game-owned terrain surface, handed straight to `TerrainTiles`. */
  readonly surface: IWorldTilesOptions["surface"];
  /** Passed straight to `TerrainTiles` for per-tile colliders. */
  readonly createCollider?: IWorldTilesOptions["createCollider"];
  /** Read once per update; an `Object3D` works. */
  readonly follow: IWorldCellsFollow;
  /** Chebyshev radius in cells to keep resident; a cell leaves only beyond `ring + 1`. */
  readonly ring: number;
  readonly budgets: IWorldCellsBudget;
  /** False streams props/chunks only; the caller owns terrain geometry and collision. */
  readonly terrain?: IWorldCellsTerrainOptions | false;
  /** Cooked cell proxies are considered by default; false retains source rendering. Static CPU
   * cells only, with strict measured triangle/draw savings and projected-error hysteresis.
   * Source collision and shadow representations stay resident; unsupported sources retain detail. */
  readonly hlod?: boolean;
  /** Optional immutable per-record 3D draw reach in metres, indexed like placements.
   * Nonnegative finite values or Infinity (no extra limit); combined with asset maxDistance.
   * Filtered by the existing admission/refilter budget, never by a separate culler.
   */
  readonly placementReach?: Float32Array;
  /** Inward return margin for authored CPU LODs, in [0, 1). Requires gpuScene:false and impostors:false (the default).
   * Omitted, selection uses the existing direct gates. State survives cell eviction/revisit. */
  readonly lodHysteresis?: number;
  /** Preserve supplied part/material identity and exact authored LOD membership, including shadow batches. Requires impostors:false (the default).
   * Default content sharing and missing-alpha-part coverage remain enabled when omitted. */
  readonly preserveAuthoredParts?: boolean;
  /** Already decoded immutable world-v1 data; URL still supplies the base for model paths. */
  readonly data?: {
    readonly manifest: IWorldPackage;
    readonly placements: ArrayBuffer;
    /** Omitted values load the manifest heightmap unless terrain is false. */
    readonly heightmap?: Uint16Array;
  };
  /**
   * How a scattered part whose own material is `transparent` is drawn. `"cutout"` (the default)
   * gives the part a clone of that material with `transparent: false` and an `alphaTest`, so the
   * instanced draw needs no per-instance sorting and the depth buffer rejects what is behind it;
   * `"blend"` draws the material as authored. One clone per asset part, never per cell.
   */
  readonly transparentScatter?: "cutout" | "blend";
  /**
   * Shadows for the streamed world, all off by default. `cast` makes scattered batches cast into
   * the scene's shadow map. Their `castLevels` finest distance levels (default 1: the near shape)
   * each cast their own shape; a placement drawn at a coarser level of a chain casts with the
   * coarsest of those, so it keeps its shadow without a caster mesh per level — every level casting
   * its own minted ~3x the casters and the churn showed as garbage collection on a walk (PRD-541).
   * Authored `lods` past `castLevels` cast nothing. `receive` lets scatter and terrain receive
   * shadows.
   */
  readonly shadows?: {
    readonly cast?: boolean;
    readonly castLevels?: number;
    readonly receive?: boolean;
    /**
     * @deprecated Accepted and ignored. Clusters replace it: what a shadow level submits is bounded
     * by the clusters its own window covers, not by a hand-tuned radius. It still validates, so a
     * game that set it keeps compiling and keeps loading.
     */
    readonly castDistance?: number;
    /**
     * Called at most once a second after streamed records changed, so the shadow levels that read
     * them redraw. `VirtualShadowNode.invalidateAll` is the whole of it, and a call with no region
     * is exactly that. Not called per frame, and not called at all when nothing changed.
     *
     * When it is called about records, it is called with the union of the bounds of the records
     * that changed — the placement position widened by the asset's own bounds, unioned over the
     * records of this update and nothing else, so a hook that forwards it to
     * `VirtualShadowNode.invalidateRegion` redraws the levels whose window covers them and leaves
     * the rest of the cascade holding its maps. A call with no region is still a blanket one: the
     * prewarm passes it while a caster's first draw is owed, and there is no region for that.
     */
    readonly invalidate?: (region?: IShadowRegion) => void;
    /**
     * An asset whose authored bounds are shorter than this casts into the finest shadow level only,
     * default 1.5 m. Ground cover below it — ferns, grass, bushes — casts a shadow that is sub-texel
     * noise at every range a wide level covers, and costs one draw per key per level there. Raise it
     * to draw everything at every range, lower it to cull more. Measured on the authored bounds, so
     * a package that scales a fern up four times is judged on the un-scaled fern.
     */
    readonly smallCasterMetres?: number;
  };
  /**
   * Triangles a hand-placed chunk's merged material group may reach before one of its
   * `InstancedMesh` is left instanced. Defaults to 43,690, the same 4 MiB
   * budget the merged buffers are split on counted in the worst case, a de-indexed triangle: a merged
   * group is a single draw, so expanding into it wins until the merged geometry is too big for the
   * frame, and above it the instanced draw is the cheaper of the two. A group that crosses the budget
   * is split into several meshes in traversal order rather than grown, and an instanced shape over
   * 2,048 triangles is never expanded. Everything else in a chunk merges regardless — one mesh per
   * material, in the main pass and in every shadow pass that redraws it.
   */
  readonly chunkMergeMaxTriangles?: number;
  /**
   * `(url) => Promise<Object3D>`, overriding `assets.model`; a raw `GLTFLoader` or a game's own
   * loader works. The url is the authored one, so a compiled package wants `assets` instead.
   */
  readonly loadModel?: (url: string) => Promise<Object3D>;
  /**
   * Model loads in flight at once, assets and chunks together. Defaults to `loadAll`'s
   * `concurrency`, six.
   */
  readonly concurrency?: number;
  /**
   * Cell-asset batches refiltered per `update`, nearest cell first. Defaults to 16. A cell that did
   * not get its turn keeps drawing the batches it has until a later update replaces them.
   */
  readonly rebuildsPerUpdate?: number;
  /**
   * Seconds of motion to stream ahead of, default 1.5: the ring centres on where the follow point
   * will be (`position + velocity * prefetchSeconds`), so a fast camera finds cells already loaded
   * instead of outrunning them. The lead is capped at three quarters of the ring, so the cell the
   * follow point is in always stays resident. `0` streams around the follow point itself.
   */
  readonly prefetchSeconds?: number;
  /**
   * New batch meshes created per update, default 2. On WebGPU each new InstancedMesh builds its
   * own shader the first frame it draws (~10-20 ms of main thread), so a burst of first-seen assets
   * is spread over frames instead of stacked into one; recycled meshes are not counted.
   */
  readonly freshMeshesPerUpdate?: number;
  /**
   * New batch meshes per update while the startup cover hides the world, default 8x
   * `freshMeshesPerUpdate`. The first-draw shader cost the default spreads is invisible behind an
   * opaque loading screen, and a canopy that needs fresh meshes otherwise trickles in two a frame.
   */
  readonly coveredFreshMeshesPerUpdate?: number;
  /**
   * Side of the world-grid square one shared batch's records are clustered into, in world units.
   * Defaults to the package's own `cellSize`, which is the square the placements are already cut
   * on. Each `(key, cluster)` is its own caster InstancedMesh with its own bounds on the shadow
   * caster layer, so a virtual-shadow level submits only the clusters its window covers. The main
   * pass keeps one mesh per `asset:level:part` whatever this is, so it costs main-pass draws
   * nothing. A larger square means fewer caster meshes and more of the world in every level render.
   */
  readonly clusterSize?: number;
  /**
   * Milliseconds one `update` may spend admitting streamed content — cell batches, terrain tiles,
   * colliders and `maxDistance`/`lods` refilters together. Defaults to 2, and `Infinity` opts out
   * of the ceiling entirely.
   *
   * The ceiling is a budget, not a promise: one unit of work always finishes, so a frame spends at
   * most this plus its last unit. Work that does not fit waits for the next `update` rather than
   * being dropped, and `stats().admission` reports what is waiting. A frame that admits nothing
   * costs nothing here.
   */
  readonly admissionBudgetMs?: number;
  /**
   * The admission budget while the startup cover hides the world and readiness is pending. Defaults
   * to 8x `admissionBudgetMs` (16 ms for the 2 ms default), so the spawn a loading screen waits on
   * is admitted in fewer frames. Set it equal to `admissionBudgetMs` to keep one budget throughout.
   */
  readonly coveredAdmissionBudgetMs?: number;
  /**
   * Milliseconds source for the admission budget, `performance.now` by default. Injectable so a
   * test can prove the ceiling instead of hoping a machine is slow enough to show it.
   */
  readonly admissionNow?: () => number;
  /**
   * The screen-space projection the extra levels of a baked AutoLOD chain are switched at, for an
   * asset whose `world.json` entry names no nonempty authored `lods` of its own. An explicit empty
   * list also uses the chain when prepared geometry and material still match its static contract.
   *
   * A chain measures its levels' geometric error in world units and the model runtime turns that
   * into pixels per frame; a batched draw cannot, so the same test is solved for distance once,
   * here, and every placement beyond it draws the next level. `fovY` is the vertical field of view
   * in degrees and `viewportHeight` the drawing-buffer height in raster pixels — a CSS height is the
   * wrong number, exactly as it is for the model runtime.
   *
   * Defaults are 60° over 1080 raster rows: a desktop view, and what the switch distance is a
   * function of. A world whose camera this class cannot see should pass its own, or a world with a
   * narrow field of view (a telephoto gun sight) or a tall window will switch earlier than its
   * pixels ask for. An asset with nonempty authored `lods` ignores all three numbers entirely: the package is
   * the authority on its own shape.
   *
   * `maxPixelError` is the error budget, in pixels, every synthesized level is selected against, and
   * it defaults to 4 rather than to the budget the asset's chain was registered with. The
   * registered budget is calibrated for a `ModelLod`, which picks a level for *one* mesh from where
   * that mesh is on screen; an instanced draw cannot, because every placement in the draw is at its
   * own distance and the draw is one call with one geometry. The batched answer has to be solved
   * once, for the whole key, which moves every switch distance outward by the ratio of the budgets —
   * and a 1 px budget is calibrated for a hero object filling the screen. At 1 px a tree's switches
   * land at 400–600 m on a 1080-row view, which on a 2 km map with a 640 m ring is past most of the
   * resident world: the levels are all there and none of them is ever selected, which is the same
   * full triangle bill the chain was added to remove. Four pixels puts the first switch inside the
   * ring, where it can actually do something.
   */
  readonly autoLod?: {
    readonly fovY?: number;
    readonly viewportHeight?: number;
    readonly maxPixelError?: number;
  };
  /**
   * The GPU-driven main pass: one compute dispatch culls and LOD-selects every resident placement
   * into a shared matrix buffer, and each main key draws its own region of it through an indirect
   * record. The CPU keeps only the coarse per-cell visibility, so a walking camera costs no repack
   * and no `maxDistance`/`lods` refilter.
   *
   * `true` by default where the backend can run it: it needs compute, storage buffers and
   * `drawIndexedIndirect`, and a backend without them falls back to exactly this class's CPU path —
   * a lost saving, never a wrong picture. `gpuScene: false`, `TN_GPU_SCENE=0` or `?tnGpuScene=0`
   * turns it off, and `stats().gpuScene` and the `TN_WORLD_GPU_SCENE` line say which path a run
   * took.
   */
  readonly gpuScene?: boolean;
  /**
   * Hold every dispatch's indirect args against the pure `cullAndSelect` reference and print the keys
   * that disagree. `false` by default, and `TN_GPU_SCENE_VALIDATE=1` or `?tnGpuSceneValidate=1` turns
   * it on.
   *
   * A readback is a queue submission and a mapped buffer, so this is a mode for answering "which key
   * draws fewer instances than the CPU path" and never a walk to be measured with.
   */
  readonly gpuSceneValidate?: boolean;
  /**
   * Sample what the GPU actually selects in the main pass — a readback of the indirect args every
   * 30 dispatches — and report it as `stats().gpuScene` and on the `TN_WORLD_GPU_SCENE`
   * line. Off unless asked: the engine asks when the frame budget is on, and a validation turns it on
   * by itself, so `TN_FRAME_BUDGET`'s `mainGpuTriangles` is the GPU-selected count and not the mesh
   * capacity `tri=` reports. Set it explicitly when driving the world without a frame budget.
   */
  readonly gpuSceneTally?: boolean;
  /**
   * Run the hierarchical-depth occlusion test in the cull kernel and report what it would cull.
   *
   * `"measure"` (the default unless `?tnOcclusion=off`, `TN_OCCLUSION=off` or a caller's own value
   * says otherwise) builds a max-distance pyramid from the previous frame's scene-pass depth and
   * counts the placements the test hides **while drawing all of them**: a measured frame is the frame
   * an unmeasured run draws, so the only difference between the two runs is the count and the cost of
   * building the pyramid. `"off"` runs no test and allocates nothing. `stats().gpuScene.occlusion`
   * reports the counts, the pyramid's own cost, and `refused: no scene depth` when no render chain
   * installed a pass to take a depth from.
   *
   * See {@link occlusionMode} and `render/depth-pyramid.ts`.
   */
  readonly occlusion?: OcclusionMode;
  /**
   * Record every GPU-dressed main batch mesh and every resident cell's hand-placed chunks into
   * `BundleGroup`s, and replay the records instead of re-walking three's per-object path for each
   * draw. On by default: PRD-494 AC-2 measured the walking `draw` span at a 5.0 ms lower p95 than
   * develop over 3 interleaved runs with bundles on and a picture a blind world gate called equal,
   * which is the measurement the old opt-in default was decided without — so `bundles: false`,
   * `?tnBundles=0` or `TN_BUNDLES=0` is the way back to the per-object path, and `stats().bundle`
   * and the `TN_WORLD_BUNDLE` line say which way a run took and what asked for it.
   *
   * A record is an encoder, not a render pass, so only a draw that needs no live pass is recorded:
   * a framebuffer reader, a transmissive impostor, a skinned or morphed mesh and a per-object hook
   * all stay on the path they were already on. See `bundleSafe`.
   *
   * The render list inside a bundle is fixed when it is recorded, so a bundled mesh is never hidden:
   * the dispatch draws zero instances for a key the camera cannot see, and an indirect draw of zero
   * instances costs the GPU nothing. Toggling `visible` would force a re-record instead, and the
   * shadow node's texel gate skips a bundled mesh for the same reason.
   *
   * A chunk has no dispatch behind it, so the two answers it needs are its own: its meshes are never
   * culled by the record, because a mesh a record dropped is missing geometry the moment the camera
   * turns towards it, and each cell records into its own group whose `visible` is the main cull's
   * answer for that cell — the same coarse answer the scatter batches take, one cell wide. What that
   * costs is the price of the option: a cell the cull cannot see is not drawn at all, which takes its
   * chunk casters out of the shadow levels with it, and a cell it can only partly see draws the part
   * facing away. Both rasterize nothing or nearly so; the missing shadow is the real difference.
   */
  readonly bundles?: boolean;
  /**
   * Raise the LOD distance bias when the main pass is over its share of the frame's GPU budget, and
   * decay it back toward 1 when it is comfortably under, default true.
   *
   * The main pass is triangle-bound: a flyover's near and mid tree levels are millions of triangles
   * and the GPU time tracks that count. When `renderer.gpuMainMs()` — the smoothed main-pass GPU
   * time — exceeds `mainGpuShare` of a 60 fps frame, every LOD switch is crossed earlier by
   * multiplying the camera distance both selection paths compare by one shared multiplier, coarsening
   * the same placements the GPU is already struggling to draw. It rises in bounded steps, never in a
   * jump, so no level pops. `false` pins the bias at 1 for the whole run, which is byte-identical to
   * the selection before this feature existed: `?tnAdaptiveLod=0`, `TN_ADAPTIVE_LOD=0` or
   * `__tnAdaptiveLod = 0` also turns it off.
   */
  readonly adaptiveLod?: boolean;
  /**
   * The fraction of a frame's GPU time the main pass may take before the adaptive LOD bias rises,
   * `(0, 1]`, default 0.5.
   *
   * The budget is `mainGpuShare x min(deltaTime, 1/60 s)`: the frame cap keeps the budget honest the
   * same way the shadow refresh gate does, because the frame that draws an expensive main pass is
   * itself long and reading its own inflated delta would let the cost it judges pass its own test.
   * `?tnMainGpuShare=0.1`, `TN_MAIN_GPU_SHARE=0.1` or `__tnMainGpuShare = 0.1` forces adaptation on a
   * GPU that would otherwise never exceed the share.
   */
  readonly mainGpuShare?: number;
  /**
   * Bake a whole-asset octahedral impostor for every alpha-cutout foliage asset and append it as the
   * asset's terminal, two-triangle LOD, default false.
   *
   * Opt-in until the impostor casts a forest's shadow: it replaces the coarsest level the wide
   * shadow levels draw, and its two-triangle card leaves the road and forest floor almost unshaded
   * (PR #375 visual regression), so a default world keeps its source levels as shadow casters.
   *
   * The bake runs inside the render cadence — one of its sixteen views per `process` — so it costs a
   * slice of a frame rather than a hitch, and it starts only after the asset's own model has been
   * adopted. A seamless switch needs the impostor's atlas to cover the same cutout the source draws,
   * so an asset whose levels carry no alpha-cutout part is never baked. `false` drops only the atlas
   * terminal: every level the authored package and its baked chain give is kept, and the authored
   * middle-level cutout coverage a level would otherwise be missing its foliage at is still applied.
   */
  readonly impostors?: boolean;
}

/**
 * What the GPU actually selected in the main pass, from the scene's last landed tally.
 *
 * `triangles` is the GPU-selected count (`instanceCount x indexCount / 3` summed over the indirect
 * records), never the mesh-capacity upper bound `renderer.info.render.triangles` reports, and it
 * covers the main pass only: shadow passes are not tallied. `ageFrames` is how many dispatches have
 * passed since those bytes were issued, so a caller never mistakes a stale sample for this frame's.
 */
export interface IWorldCellsGpuTally {
  readonly instances: number;
  readonly triangles: number;
  readonly ageFrames: number;
}

export interface IWorldCellsStats {
  readonly residentCells: number;
  /** Resident cells whose initial placement runs and chunks have completed admission. */
  readonly loadedCells: number;
  readonly residentKeys: readonly string[];
  /** Terrain tiles drawn, out to `terrain.streamRadius`; independent of the props' `ring`. */
  readonly residentTiles: number;
  /** Tiles holding a `createCollider` body, inside `terrain.colliderRadius`; 0 with no factory. */
  readonly residentColliders: number;
  /** Placement instances the resident cells hold, before any `maxDistance` filter. */
  readonly instances: number;
  readonly loadsInFlight: number;
  /** Model loads waiting for a free lane; served nearest-cell first, in admission order. */
  readonly loadsQueued: number;
  /**
   * Shared batches still to be minted, plus the ones minted and not yet drawn; `0` once
   * `prewarmed` has resolved.
   */
  readonly pendingPrewarm: number;
  /** Shared batches minted by the prewarm so far, cumulative. */
  readonly prewarmMinted: number;
  readonly evictions: number;
  /** Cumulative `maxDistance`/`lods` refilters performed, across every update. */
  readonly rebuilds: number;
  /**
   * Cumulative refilter *passes* run, whether or not they queued a rebuild. The pass walks every
   * resident cell, derives both distance brackets and sorts what it found, so this is what says
   * whether a follow point standing inside the 2 m step paid for it; `rebuilds` only says whether it
   * was worth anything. See `LEVEL_REFILTER_STEP_METRES`.
   */
  readonly refilters: number;
  /**
   * Cumulative stale cell-assets the refilter passes found, across every update. The pass walks every
   * resident cell and gates it as a whole before it looks at one batch, so a follow point that has
   * crossed nothing leaves this still — which is what says the walk cost brackets and comparisons and
   * not allocations.
   */
  readonly refilterEntries: number;
  /**
   * Cumulative refilters whose rebuild held the same records and were settled without a write,
   * clear or compaction. A rising share of `rebuilds` is a follow point crossing a cell's distance
   * bracket rather than any placement crossing a gate.
   */
  readonly unchanged: number;
  readonly failures: number;
  /**
   * What the main-pass cull cost, cumulative, and the evidence that a settled camera costs nothing.
   *
   * `frustums` is one a frame that had a perspective camera — it used to be one per main mesh, ~230
   * of them on a 2 km walk. `windows` is how many of those meshes had to re-derive their window at
   * all, and `repacks` how many copied records: both are 0 on a frame where the visible squares did
   * not change and no record joined or left, which is what the two integer comparisons in
   * `SharedBatch.cullFrom` buy.
   */
  readonly mainCull: {
    readonly frustums: number;
    readonly windows: number;
    readonly repacks: number;
    readonly visibleEpoch: number;
  };
  /**
   * What the GPU-driven main pass is doing, and why it is not: `on` is the answer, `reason` is the
   * one line `TN_WORLD_GPU_SCENE` printed, and `dispatches` is what the walk actually paid for its
   * per-instance work. `mainCull.repacks` and `refilters` stay at `0` while it is on — that is the
   * CPU work it replaced, counted by the same counters that report it when it is off. `dressed` over
   * `meshes` is the marker line's own pair, and it is the one that says the scene has meshes to draw
   * with: an `on` with `0` dressed is a ring the CPU path is still drawing.
   */
  readonly gpuScene: {
    readonly on: boolean;
    readonly reason: string;
    readonly dispatches: number;
    /** Resident source records: one per placement, shared by every part of the level it reached. */
    readonly instances: number;
    readonly keys: number;
    readonly dressed: number;
    readonly meshes: number;
    /**
     * Instances and triangles the GPU actually selected in the main pass, and the age of that
     * sample in dispatches. Absent until the first tally lands, never zero: the scene's own
     * `instances` above is what it holds, and `gpuInstances` is what the GPU drew.
     */
    readonly gpuInstances?: number;
    readonly gpuTriangles?: number;
    readonly gpuTallyAgeFrames?: number;
    /**
     * What the pyramid occlusion test would cull, when a launch asked it to measure. `share` is the
     * would-cull share of the main pass's GPU-selected triangles from the same landed readback, which
     * is the number the go/no-go multiplies by `gpuMain`; `reason` names why nothing was measured.
     */
    readonly occlusion?: NonNullable<IWorldGpuSceneReport["occlusion"]>;
  };
  /**
   * Main-pass bundle membership: `children` counts grouped roots — every recorded main mesh under one
   * of the main record's shards, plus every chunk of every resident cell under that cell's own group —
   * `cpuMeshes` and `gpuMeshes` count shared batch members, and `on` reports actual main/chunk
   * membership. These are membership counts, not observed backend draws. `records` counts
   * invalidations since load: membership, material or geometry changes and CPU window repacks
   * invalidate; GPU indirect count updates do not.
   *
   * `eligibility` counts CPU material checks, snapshot validations, fresh structural walks and
   * oversized or unsupported child output. Snapshots check own links and Three's child readers on
   * every check, detecting deep edits without requiring `needsUpdate`; child discovery still allocates.
   *
   * `reason` is who asked: `default` is a run that set nothing, `option` is a load that named
   * `bundles`, and `launch` is `?tnBundles` / `TN_BUNDLES` / `__tnBundles`. It is on the marker line
   * too, because a run that turns the default off is exactly the run a reader cannot tell from a
   * failing one without it.
   */
  readonly bundle: {
    readonly on: boolean;
    readonly children: number;
    readonly cpuMeshes: number;
    readonly gpuMeshes: number;
    readonly eligibility: {
      readonly checks: number;
      readonly refreshes: number;
      readonly validations: number;
      readonly uncached: number;
    };
    readonly reason: string;
    readonly records: number;
  };
  /**
   * The runtime impostor path: how many assets appended a terminal level, how many bakes are still
   * queued or in flight, the triangles all terminal levels submit together — the number the whole
   * feature exists to reduce — and the cache size: the logical colour atlas bytes held (each atlas's
   * RGBA8 colour and normal mip chains), not every physical GPU buffer a render target may own, and
   * the budget those bytes are enforced against.
   */
  readonly impostor: {
    readonly assets: number;
    readonly pending: number;
    readonly atlasBytes: number;
    readonly budgetBytes: number;
    readonly terminalTriangles: number;
    /**
     * The whole-map far aggregates: one `InstancedMesh` per atlas cache key, the ORIGINAL placements
     * they hold (`instances`), how many of those the near ring has taken back (`nearOwned`), the
     * physical instance bytes, and how many times an aggregate's buffer has been written. Missing
     * measurements stay absent; a settled camera holds `uploads` still.
     */
    readonly far: {
      readonly aggregates: number;
      readonly instances: number;
      readonly live: number;
      readonly nearOwned: number;
      readonly bytes: number;
      readonly uploads: number;
    };
  };
  /** Cumulative rejected requests: cells skipped, instances or bytes refused, terrain retries. */
  /** Compilation and zero-count main backend submission are separate observations. These counts
   * do not prove GPU execution, image quality, or reduced frame time. bytes includes pending
   * reservation and decoded copies/textures, never a claim about physical driver allocation. */
  readonly hlod: {
    readonly on: boolean;
    readonly loaded: number;
    readonly compiled: number;
    readonly observed: number;
    readonly active: number;
    readonly pending: number;
    readonly bytes: number;
    readonly refused: number;
    readonly failures: number;
  };
  readonly pressure: { readonly cells: number; readonly instances: number; readonly bytes: number };
  /**
   * What the last `update` spent on admitting streamed content, and what it left behind.
   *
   * A rising `backlog` is the honest signal that admission is not keeping up with the follow point;
   * it is the one number that says a player is outrunning the world.
   */
  readonly admission: {
    /** Milliseconds the last `update` spent admitting; at most the budget plus its last unit. */
    readonly spentMs: number;
    /** Cell-asset builds the last `update` had no budget for, still queued for a later one. */
    readonly deferred: number;
    /** Units of work those builds still owe — placement slices left plus meshes left to publish. */
    readonly backlog: number;
  };
}

/** Local render coverage, independent of shader prewarm and distant admission. */
export interface IWorldRegionReadiness {
  readonly requiredCells: number;
  readonly loadedCells: number;
  readonly requiredTerrainTiles: number;
  readonly loadedTerrainTiles: number;
  readonly failures: number;
  readonly cancelled: boolean;
  readonly ready: boolean;
}

interface ICellBatch {
  readonly asset: string;
  /**
   * The run these records came from. One cell can hold two runs of one canonical asset — two names
   * for the same model — and each builds its own, so a refilter and a rebuild have to know which of
   * the cell's entries belong to the run they are replacing.
   */
  readonly run: IWorldRun;
  readonly batch: InstancedBatch;
  readonly level: number;
  readonly part: number;
  /** How far the follow point has to move before this batch is refiltered, `undefined` never. */
  readonly threshold: number | undefined;
  /** The shared mesh this cell's instances are written into, and its segment there (-1: none). */
  shared: SharedBatch | undefined;
  segment: number;
  /**
   * The GPU scene's source records this entry draws from, shared by every part of its level, and
   * handed back by `#clearSegment`. `undefined` while the scene is off or the records are the
   * dispatches' own already — a record released twice is a no-op, which is what lets one list be
   * held by a whole level's parts.
   */
  gpu: number[] | undefined;
  /**
   * The shadow-caster cluster this cell's records also go into, and its segment there (-1: none).
   * The main mesh is one per key and casts nothing; the same records are written into one mesh per
   * `(key, cluster)` on the caster layer, which is what a virtual-shadow level culls.
   */
  caster: SharedBatch | undefined;
  casterSegment: number;
  /**
   * The wide-caster half, and its segment there (-1: none): the same records again, in one mesh per
   * key covering the whole ring, alone on the wide caster layer. A shadow level whose window covers
   * the ring would otherwise submit one cluster per square for the same pixels.
   */
  wide: SharedBatch | undefined;
  wideSegment: number;
  /**
   * The root-matrix records this entry's level put in the far shadow, when the asset has an
   * impostor: the placement transform alone, never `placement * part local`. The whole-asset impostor
   * bakes every LOD0 part's own transform into its atlas, so its quad is drawn at the placement root
   * and composing a source part's offset again would apply that part's transform twice. `undefined`
   * for a non-impostor asset, whose wide half keeps the per-part source records.
   */
  wideRoot: InstancedBatch | undefined;
  /**
   * The world bounds of the records this entry holds, from the filter that built it. The shadow
   * invalidation is the union of these over the entries a swap moved in and out, which is the point
   * of measuring them per record rather than per cell: a 48 m level's window is smaller than the
   * cell box, so the cell box always covered it and always redrew it.
   */
  shadowBounds: Box3 | undefined;
  lastFilterY: number;
  lastFilterX: number;
  lastFilterZ: number;
}

/** The geometry and material one batch draws; a part is one of these plus what it does not need. */
type IBatchShape = Pick<IAssetPart, "geometry" | "material">;

/** Which GPU-scene key one main batch draws: `asset:level:part`, and the part's place in the model. */
interface IKeyDescriptor {
  readonly asset: string;
  readonly key: string;
  readonly level: number;
  readonly part: number;
}

/** One key a loaded asset's levels contributed to the prewarm queue. */

/** One asset's placements, waiting to be built, or already holding their own cell's records. */
interface IPrewarmEntry {
  readonly asset: string;
  /**
   * Which pass this mesh is: the main pass's key, its caster cluster, its wide, or the shadow twin
   * of the main key that a GPU-driven map draws instead of the two caster halves.
   */
  readonly role: "cluster" | "key" | "main" | "wide";
  readonly geometry: BufferGeometry;
  readonly key: string;
  readonly level: number;
  readonly material: Material;
  /** The part of the level, which is the third half of a key's name. */
  readonly part: number;
}

/**
 * A plain `{ min, max }` region, the shape a shadow level's invalidation reads and the shape a game
 * can be handed without importing three. Plain numbers, so the object a caller records its bounds
 * in is the object that crosses the boundary.
 */
export interface IShadowRegion {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
}

/**
 * One asset part at one distance level, drawn for every resident cell by a single InstancedMesh.
 *
 * Each cell owns a block of the instance buffer, admitted as the count it needs and freed as one,
 * so the draw object count is per asset part and level rather than per cell: a 25-cell ring of a
 * 218-asset world was ~5,000 meshes and 20+ ms of CPU a frame in three's per-object render path.
 *
 * A shared batch packs its live instances at the front of the instance buffer, so `mesh.count` is
 * the live total. It used to be `(the highest used segment + 1) * segmentSize`, which drew every
 * zero-matrix slot of a partly filled segment and of every freed segment below the top one — tens of
 * thousands of slots per pass — and each empty slot still ran the vertex shader over the whole mesh
 * in the main pass and in every shadow pass. A block is now sized to its own cell's batch instead of
 * to the asset's largest cell, and a freed or shortened block is compacted into the lowest hole, so
 * the drawn range holds nothing but live records. The handles are opaque: `allocate` only hands one
 * back to `write` and `clear`.
 *
 * A **main** batch is `clustered`, and that changes the packing: its blocks are laid out grouped by
 * the world-grid square they sit in, the same square the caster clusters are keyed by, and
 * {@link SharedBatch.cullFrom} narrows `mesh.count` to the squares the main camera's frustum covers.
 * Three's whole-mesh frustum test cannot do this on its own — the bounds are the whole ring, so the
 * test always passes and every instance behind or beside the camera is vertex-shaded. See
 * {@link WorldCells.#cullMainPass} for which camera is allowed to decide.
 */
/**
 * A `SharedBatch`'s mesh plus the one field it publishes for a shadow level's size gate: the largest
 * instance scale any live record carries. Duck-typed rather than augmented into `three`, the same as
 * `isInstancedMesh` — `render/virtual-shadow.ts` reads it back off the mesh.
 */
interface ICasterScaleMesh extends InstancedMesh {
  casterInstanceScale: number;
  /**
   * Whether the main pass will draw the records behind this caster half this frame; see
   * {@link SharedBatch.setMainAdmitted}. Read by `VirtualShadowNode`'s probe beside the other two
   * flags this class writes on a mesh.
   */
  mainAdmitted?: boolean;
}

/** One world-grid square's records in a clustered batch: how many of them there are. */
type ISquareSizes = Map<string, number>;

/**
 * The one buffer a clustered regroup permutes through.
 *
 * A regroup is a permutation of `[0, drawn)`, and there is no in-place order for one: putting the
 * visible squares at the front necessarily writes over squares that have not been copied out yet. A
 * snapshot is the honest way to do it — read every block into here, then write the new layout back —
 * and one buffer is enough for the whole world, because a regroup never nests and the largest
 * main batch is the only bound on it. Module-level like the upload epoch, because there is one world
 * drawing at a time.
 */
let regroupScratch = new Float32Array(0);

/** A scratch with room for `floats`, kept between regroups so a walk allocates it once. */
function scratchFor(floats: number): Float32Array {
  if (regroupScratch.length < floats) regroupScratch = new Float32Array(floats * 2);
  return regroupScratch;
}

/** The two scratch objects a cull builds its frustum in, and whether two square sets are the same. */
const _cullFrustum = new Frustum();
const _cullProjScreen = new Matrix4();
/** The eye the live-state reference measures every placement's XZ distance from. */
const _gpuEye = new Vector3();

/** Records a square's blocks hold, which is its share of the batch. */
function sizeOf(square: { blocks: Array<[number, number, number, string]> }): number {
  let size = 0;
  for (const block of square.blocks) size += block[2];
  return size;
}

function sameSquares(next: Set<string>, was: Set<string> | undefined): boolean {
  if (was === undefined || was.size !== next.size) return false;
  for (const cluster of next) if (!was.has(cluster)) return false;
  return true;
}

class SharedBatch {
  mesh: ICasterScaleMesh;
  /** The pass this batch draws in; see `#dressMesh`. Only `main` is clustered. */
  readonly role: "cluster" | "key" | "main" | "wide";
  /**
   * Set by `WorldCells` from the asset's own bounds: a wide caster of ground cover goes on the
   * finest level's small-caster layer rather than the wide one. Written after construction because
   * `#segmentIn` re-dresses a grown mesh with nothing but the batch to hand, and a flag the batch
   * carries is the one thing that survives that.
   */
  smallCaster = false;
  /**
   * Set when the GPU scene owns this batch's draw, with the key it was minted under. See
   * `WorldCells#dressGpu`.
   *
   * It is a field rather than a name test because a dressed batch's `mesh.instanceMatrix` is the
   * scene's shared compaction buffer, and everything below writes records into that attribute: a
   * dressed batch keeps its bookkeeping and skips every byte of it, which is the whole of what the
   * `gpu` guards in `write`, `clear`, `#settle`, `#touched` and `#publish` are.
   */
  gpu:
    | {
        readonly asset: string;
        readonly level: number;
        readonly part: number;
        readonly key: string;
      }
    | undefined;
  /**
   * The instance count a GPU-dressed mesh is submitted with: its key's region capacity, written by
   * `WorldCells#dressGpu`.
   *
   * A dressed mesh's own records are not what it draws — the dispatch appends survivors into the
   * scene's shared buffer and the indirect record decides how many — so `#drawn` is not its count.
   * Three skips the indirect draw entirely before the GPU ever reads the record when an
   * `InstancedMesh.count` is zero (`RenderObject.getDrawParameters`), so the region's capacity is the
   * submission bound: the record's own count draws what the GPU selected, and this only admits the
   * submission. `0` until the mesh is dressed.
   */
  gpuCount = 0;
  /**
   * How many of this batch's live records the GPU scene holds a placement for, carried beside the
   * buffer and the segments so admission is one comparison per caster half a frame. Incremented by
   * `WorldCells#placeSources` and decremented by `#clearSegment`, where the asset's own `#gpuResident`
   * count already moves; see {@link WorldCells.#publishCasterAdmission}.
   */
  gpuPlaced = 0;
  /**
   * Whether this batch's mesh is parented under one of the world's main record shards. Set by
   * `WorldCells#bundleIn` and cleared by `#bundleOut`.
   *
   * It is a field rather than `mesh.parent` because a bundled mesh's `visible` is never written
   * again: three fixes a bundle's render list when it records it, and the replay never re-reads
   * visibility — so the two places that hide an empty batch have to know, and a mesh that has just
   * been detached from the group by a retire has still been in the last recorded one.
   */
  bundled = false;
  /**
   * Last checked eligibility of this mesh. CPU draws revalidate bounded material graph snapshots
   * and live object hooks each frame, so deep mutations can return the mesh to the per-object path.
   */
  bundlable = false;
  bundleMaterialRevision = -1;
  /**
   * The instance count the world's last record of this mesh was cut at. A record freezes the draw's
   * instance count, so a CPU-path batch's moving window is one re-record when this moves; a dressed
   * batch submits its key's region capacity, which only the dress changes and which re-records there.
   */
  bundledCount = -1;
  /**
   * The same descriptor, recorded whether or not the GPU scene is on, which is the whole of what
   * lets a mesh minted before the scene came up be dressed after it: `gpu` says the mesh draws from
   * the scene's buffers, `main` says which key it would draw. A prewarm that mints a whole ring on a
   * loading screen mints it with the scene off, and the first frame with a renderer turns it on.
   */
  main:
    | {
        readonly asset: string;
        readonly level: number;
        readonly part: number;
        readonly key: string;
      }
    | undefined;
  readonly #clustered: boolean;
  readonly #segmentSize: number;
  /** Block handle -> the block's first instance record. */
  readonly #start = new Map<number, number>();
  /** Block handle -> live records in it; the reserved count until `write` reports the real one. */
  readonly #size = new Map<number, number>();
  /** Block handle -> the world-grid square it sits in; only a clustered batch records it. */
  readonly #blockCluster = new Map<number, string>();
  /** World-grid square -> its records in the buffer, so the window can be summed. See `#regroup`. */
  readonly #squareSizes: ISquareSizes = new Map();
  /** The squares the last cull kept, how many records of the batch they are, and whether that is current. */
  #visible: Set<string> | undefined;
  /** The `visibleEpoch` this batch last laid itself out at; see {@link SharedBatch.cullFrom}. */
  #packedEpoch = -1;
  /** Reused across culls, so a repack allocates no set. */
  #scratch: Set<string> = new Set();
  #window = 0;
  #narrowed = false;
  /**
   * A prewarmed batch whose first draw is still owed, so it is visible at count 0 until that draw
   * counts. The draw is the whole of the prewarm; see {@link #publish}.
   */
  #awaitingPrewarm = false;
  /**
   * Whether the main pass will draw this batch's records this frame; a main batch is always
   * admitted, so this only ever says something about a caster half. See
   * {@link WorldCells.#publishCasterAdmission}.
   */
  #mainAdmitted = true;
  /** Free record ranges `[from, to)`, sorted, disjoint and never adjacent. */
  #free: Array<[number, number]> = [];
  #handles = 0;
  /** One past the last live record: the range the whole buffer holds. A clustered batch draws `#window`. */
  #drawn = 0;
  /** Block handle -> the AABB of the records it holds, and the union of those is the mesh's bounds. */
  readonly #boxes = new Map<number, Box3>();
  /** Block handle -> the largest instance scale in it; the union is published on the mesh. */
  readonly #scales = new Map<number, number>();
  /** Carried out of the last `#boxOf` pass, which already reads every record's basis. */
  #maxScale = 0;
  #localGeometry: BufferGeometry | undefined;
  readonly #localCenter = new Vector3();
  readonly #localHalf = new Vector3();
  readonly #union = new Box3();
  readonly #point = new Vector3();
  /** This batch's own pending upload span, and the `update` it was opened in. See `#touched`. */
  #pendingLow = 0;
  #pendingHigh = 0;
  #pendingEpoch = -1;

  constructor(
    geometry: BufferGeometry,
    material: Material,
    segmentSize: number,
    segments: number,
    name: string,
    bounds: Box3,
    role: "cluster" | "key" | "main" | "wide",
  ) {
    this.role = role;
    this.#clustered = role === "main";
    this.#segmentSize = Math.max(1, segmentSize);
    this.#bounds = bounds;
    this.mesh = SharedBatch.#meshFor(
      geometry,
      material,
      this.#segmentSize * segments,
      name,
      bounds,
    );
    this.#free = [[0, this.mesh.instanceMatrix.count]];
    this.#ceiling = this.mesh.instanceMatrix.count;
    this.#rebound();
  }

  /** This batch's own record ceiling; see {@link liveCeiling}. */
  #ceiling = 0;

  /** The package extent, the conservative fallback when a part's own box cannot be read. */
  readonly #bounds: Box3;

  /**
   * Takes a pooled mesh with room for `capacity`, so a shared batch that outgrows its buffer keeps
   * the uuid — and the node three built for it — instead of getting a new one. Every field a pooled
   * mesh carries stale is written here, and the two shadow flags are set false because `grow` copies
   * them off the mesh it replaces and the world sets them per level.
   */
  static #meshFor(
    geometry: BufferGeometry,
    material: Material,
    capacity: number,
    name: string,
    bounds: Box3,
  ): ICasterScaleMesh {
    const mesh = pooledMesh(geometry, material, capacity) as ICasterScaleMesh;
    mesh.name = name;
    mesh.boundingBox = bounds.clone();
    mesh.boundingSphere = bounds.getBoundingSphere(mesh.boundingSphere ?? new Sphere());
    mesh.count = 0;
    mesh.visible = false;
    // Cullable, because the bounds are now this batch's own. Every camera three draws this mesh
    // with — the main one and each virtual-shadow level's — asks first, which is what stops a 48 m
    // shadow level from submitting every shared batch in the world.
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    (mesh.instanceMatrix.array as Float32Array).fill(0);
    mesh.instanceMatrix.needsUpdate = true;
    // A pooled mesh arrives carrying the last user's scale; nothing lives here yet.
    mesh.casterInstanceScale = 0;
    // Nor the last user's bundle membership: a mesh is only bundled while `WorldCells#bundleIn` says
    // so, and the shadow node reads this marker to keep its texel gate off a bundled mesh.
    mesh.userData.tnBundled = false;
    // Nor the last caster's admission: a main batch is always admitted, and this mesh is not one.
    mesh.mainAdmitted = true;
    return mesh;
  }

  /** Point an empty batch at the parts a reload brought; see {@link rebind}. */
  rebind(geometry: BufferGeometry, material: Material): this {
    this.mesh.geometry = geometry;
    this.mesh.material = material;
    this.#localGeometry = undefined;
    // A new surface is the one thing a rebind can bring that a mesh swap cannot, so what can be
    // recorded has to be asked again: the answer cached for the old material is not this one's.
    this.bundlable = false;
    if (this.#parked > 1) this.#resize(this.#parked);
    this.#rebound();
    return this;
  }

  /** The capacity this batch had when it was parked; see {@link park}. */
  #parked = 0;

  /**
   * Give up the instance buffer of a batch that holds no records, keeping the mesh.
   *
   * This is what makes a retained set affordable. Unparked, a walk's back-traffic costs a ring-sized
   * buffer per key, so `RETIRED_SHARED_BYTES` could hold only the last few dozen keys of a world with
   * hundreds of them, `#sharedFor` then found nothing to hand back, and the walk minted a second
   * mesh for every key it returned to. Parked, the same keys cost `PARKED_SHARED_CAPACITY` records
   * each and `rebind` gives the buffer back before the first record is written into it.
   */
  park(): this {
    // The batch's own ceiling, never its mesh's `count`: a dressed batch's `instanceMatrix` is the
    // GPU scene's shared compaction buffer, so its count is the whole world's, and parking by it
    // turned one key's capacity into the whole buffer — `rebind` then resized every later batch
    // against the world and the shared buffer regrew until the device refused it.
    this.#parked = this.#ceiling;
    // `gpu` too, not only a capacity over one: a dressed batch's `instanceMatrix` is the GPU scene's
    // shared compaction buffer whatever its logical ceiling is, so a batch parked at a ceiling of one
    // that skipped this resized nothing and left the retired mesh holding the whole world's records.
    if (this.gpu !== undefined || this.#parked > PARKED_SHARED_CAPACITY)
      this.#resize(PARKED_SHARED_CAPACITY);
    return this;
  }

  /**
   * Swap in an instance buffer of `capacity` records, and with it the free range and the drawn count
   * the buffer is the record of. The mesh is off the world and holds no records when this runs, so
   * `#start`, `#size` and `#boxes` are already empty and the one free range is the whole buffer.
   */
  #resize(capacity: number): void {
    const mesh = this.mesh;
    mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    this.#ceiling = capacity;
    this.#publish(0);
    this.#free = [[0, capacity]];
    this.#drawn = 0;
  }

  /**
   * The mesh's own extent, the union of the blocks' boxes, written on every add and remove. A union
   * over at most one box per resident cell is a few dozen comparisons, against a per-draw saving of
   * every batch the camera does not overlap. `#compact` moves records between slots but never between
   * blocks, so a block's box survives a compaction untouched.
   */
  #rebound(): void {
    const box = this.#union;
    let live = false;
    for (const one of this.#boxes.values()) {
      if (live === false) {
        box.copy(one);
        live = true;
      } else box.union(one);
    }
    if (live === false) box.copy(this.#bounds);
    (this.mesh.boundingBox as Box3).copy(box);
    this.mesh.boundingSphere = this.mesh.boundingSphere ?? new Sphere();
    box.getBoundingSphere(this.mesh.boundingSphere);
    // The size a per-instance shadow gate reads, published next to the mesh rather than asked for
    // again per level: the cluster's own sphere is ~24 m of grid square, so gating on it dropped
    // nothing, while a fern is 0.3 m and every fern cluster clears every coarse level.
    this.mesh.casterInstanceScale = live === false ? 0 : Math.max(...this.#scales.values());
  }

  /**
   * The AABB of records `[from, from + count)` of the instance buffer, read from the bytes just
   * written rather than from the batch that wrote them, so it is the same numbers the GPU gets. The
   * half-extents are `|basis| * half`, which is the box a rotated or stretched instance of the part
   * actually covers — a translate-only box would let a scaled trunk through the shadow cull.
   */
  #boxOf(from: number, count: number): Box3 {
    const array = this.mesh.instanceMatrix.array as Float32Array;
    const geometry = this.mesh.geometry;
    if (this.#localGeometry !== geometry) {
      this.#localGeometry = geometry;
      if (geometry?.boundingBox === null || geometry?.boundingBox === undefined)
        geometry?.computeBoundingBox?.();
      const local = geometry?.boundingBox;
      // No readable local box means no readable instances either; the package extent is the answer
      // that cannot be wrong, and it is what these meshes carried before the blocks were sized.
      if (local === undefined || local === null || local.isEmpty()) return this.#bounds;
      this.#localCenter.copy(local.getCenter(this.#point));
      this.#localHalf.copy(local.getSize(this.#point)).multiplyScalar(0.5);
    }
    const cx = this.#localCenter.x;
    const cy = this.#localCenter.y;
    const cz = this.#localCenter.z;
    const hx = this.#localHalf.x;
    const hy = this.#localHalf.y;
    const hz = this.#localHalf.z;
    const out = new Box3();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let scale = 0;
    for (let index = from; index < from + count; index += 1) {
      const at = index * 16;
      const m0 = array[at] as number;
      const m1 = array[at + 1] as number;
      const m2 = array[at + 2] as number;
      const m4 = array[at + 4] as number;
      const m5 = array[at + 5] as number;
      const m6 = array[at + 6] as number;
      const m8 = array[at + 8] as number;
      const m9 = array[at + 9] as number;
      const m10 = array[at + 10] as number;
      const px = m0 * cx + m4 * cy + m8 * cz + (array[at + 12] as number);
      const py = m1 * cx + m5 * cy + m9 * cz + (array[at + 13] as number);
      const pz = m2 * cx + m6 * cy + m10 * cz + (array[at + 14] as number);
      const ex = Math.abs(m0) * hx + Math.abs(m4) * hy + Math.abs(m8) * hz;
      const ey = Math.abs(m1) * hx + Math.abs(m5) * hy + Math.abs(m9) * hz;
      const ez = Math.abs(m2) * hx + Math.abs(m6) * hy + Math.abs(m10) * hz;
      if (px - ex < minX) minX = px - ex;
      if (py - ey < minY) minY = py - ey;
      if (pz - ez < minZ) minZ = pz - ez;
      if (px + ex > maxX) maxX = px + ex;
      if (py + ey > maxY) maxY = py + ey;
      if (pz + ez > maxZ) maxZ = pz + ez;
      // The largest column of the instance basis: the scale a fern or a trunk is drawn at.
      const basis = Math.max(
        Math.hypot(m0, m1, m2),
        Math.hypot(m4, m5, m6),
        Math.hypot(m8, m9, m10),
      );
      if (basis > scale) scale = basis;
    }
    this.#maxScale = scale;
    out.min.set(minX, minY, minZ);
    out.max.set(maxX, maxY, maxZ);
    return out;
  }

  /** A handle for `count` free records, or `undefined` when the buffer has none and must grow. */
  allocate(count: number, cluster?: string): number | undefined {
    const at = this.#take(count);
    if (at < 0) return undefined;
    const handle = this.#handles;
    this.#handles += 1;
    this.#start.set(handle, at);
    this.#size.set(handle, count);
    // Only a clustered batch groups, so only it pays for the lookup. The square is the caller's
    // cell's, and a cell's placements never move, so a record is only ever grouped when the cell
    // holding it is admitted or evicted.
    if (this.#clustered && cluster !== undefined) this.#blockCluster.set(handle, cluster);
    return handle;
  }

  /**
   * Doubles the buffer in a new mesh (same data), returning the one it replaces for the pool.
   *
   * The replacement comes from the pool, and what it replaces is offered back to it, so the pair
   * costs one new uuid between them instead of one each. This used to push the old mesh onto an
   * unbounded `retired` array that nothing ever read and nothing ever freed.
   */
  grow(): InstancedMesh | undefined {
    const old = this.mesh;
    if (this.gpu !== undefined) {
      // A dressed batch's records are the GPU scene's, held in a buffer this batch must not copy,
      // zero or regroup: its own share is the logical ceiling the next `#dressGpu` sizes the scene's
      // region from, so growth is that number and nothing else. The live mesh is kept and nothing is
      // returned: `#segmentIn` dresses, attaches and parks only a real replacement, and the next
      // `#dressGpu` grows the region from this ceiling before the draw.
      const was = this.#ceiling;
      this.#ceiling = was * 2;
      this.#hole(was, this.#ceiling);
      return undefined;
    }
    const mesh = SharedBatch.#meshFor(
      old.geometry,
      old.material as Material,
      old.instanceMatrix.count * 2,
      old.name,
      this.#bounds,
    );
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    mesh.castShadow = old.castShadow;
    mesh.receiveShadow = old.receiveShadow;
    this.mesh = mesh;
    this.#ceiling = mesh.instanceMatrix.count;
    this.#settle();
    // The whole drawn range, because this is a different buffer. `#meshFor` left the new
    // attribute's range list empty, and an empty list is how three is told "upload everything" — so
    // before the coalescing below, this was the whole buffer by default and the records copied out
    // of the old array reached the GPU. A narrow range here would leave the new buffer's first
    // records as the zeros it was created with.
    this.#touched(0, this.#drawn);
    this.#rebound();
    return old;
  }

  /**
   * Swap in the object this batch draws with, and hand back the one it replaces.
   *
   * Every reference the batch holds is `this.mesh` read at the moment it is needed, so the swap is
   * the field. What does not follow the field is what the batch derives rather than stores — the
   * bounds, the instance scale, the count and the visibility published on the object, and the two
   * containers a fresh object starts out without them in. Those are republished here from the
   * batch's own records, so a replacement draws exactly what the object it replaced drew.
   */
  replaceMesh(next: ICasterScaleMesh): ICasterScaleMesh {
    const old = this.mesh;
    this.mesh = next;
    this.mesh.boundingBox = this.mesh.boundingBox ?? new Box3();
    this.mesh.boundingSphere = this.mesh.boundingSphere ?? new Sphere();
    (next as { casterPrewarmOwed?: boolean }).casterPrewarmOwed = this.#awaitingPrewarm;
    next.mainAdmitted = this.#mainAdmitted;
    this.#rebound();
    this.#publish(this.#drawn);
    return old;
  }

  write(segment: number, batch: InstancedBatch): void {
    const start = this.#start.get(segment);
    const reserved = this.#size.get(segment);
    if (start === undefined || reserved === undefined) return;
    if (this.gpu !== undefined) {
      // The records themselves are the GPU scene's, written by its dispatch from the source buffer;
      // what the coarse per-cell gate and the counters need is the per-square count and the total.
      const cluster = this.#blockCluster.get(segment) ?? "";
      this.#size.set(segment, batch.count);
      this.#squareSizes.set(cluster, (this.#squareSizes.get(cluster) ?? 0) + batch.count);
      this.#drawn += batch.count;
      this.#publish(this.#drawn);
      return;
    }
    const array = this.mesh.instanceMatrix.array as Float32Array;
    const written = batch.writeMatrices(array, start);
    array.fill(0, (start + written) * 16, (start + reserved) * 16);
    if (written < reserved) this.#hole(start + written, start + reserved);
    this.#size.set(segment, written);
    // The block's extent, read from the records where they are now, because `#compact` is about to
    // move them. The box is keyed by handle, so the move cannot falsify it.
    if (written > 0) {
      this.#boxes.set(segment, this.#boxOf(start, written));
      this.#scales.set(segment, this.#maxScale);
    } else {
      this.#boxes.delete(segment);
      this.#scales.delete(segment);
    }
    this.#settle();
    this.#touched(start, written);
    this.#rebound();
  }

  clear(segment: number): void {
    const start = this.#start.get(segment);
    if (start === undefined) return;
    const size = this.#size.get(segment) ?? 0;
    if (this.gpu !== undefined) {
      // The mirrored half of `write`: the coarse gate and the live total follow the records that left,
      // and no byte of the shared buffer is touched, because none of them were ever in it.
      const cluster = this.#blockCluster.get(segment) ?? "";
      this.#squareSizes.set(cluster, Math.max(0, (this.#squareSizes.get(cluster) ?? 0) - size));
      this.#drawn -= size;
    }
    this.#start.delete(segment);
    this.#size.delete(segment);
    this.#blockCluster.delete(segment);
    if (this.gpu !== undefined) {
      // The block's range goes back to the free list, exactly as the CPU path's does below. Without
      // this the GPU path's free list only ever shrank: a walk that streamed cells in and out
      // exhausted it, `allocate` failed, `grow` doubled the batch's ceiling, and the scene's region
      // — and with it the shared buffer — regrew for records that had already left.
      this.#hole(start, start + size);
      this.#publish(this.#drawn);
      return;
    }
    (this.mesh.instanceMatrix.array as Float32Array).fill(0, start * 16, (start + size) * 16);
    this.#hole(start, start + size);
    this.#settle();
    // The drawn range, not nothing. `#compact` closed the hole by moving the topmost block down
    // into it, so the bytes below `#drawn` changed and an empty range list is read by three as
    // "upload the whole buffer" — a ring-sized write to zero a block that is no longer drawn.
    this.#touched(0, this.#drawn);
    this.#boxes.delete(segment);
    this.#scales.delete(segment);
    this.#rebound();
  }

  /** The first free range with room for `count` records, taken out of the list; -1 when there is none. */
  #take(count: number): number {
    for (let index = 0; index < this.#free.length; index += 1) {
      const range = this.#free[index] as [number, number];
      const size = range[1] - range[0];
      if (size < count) continue;
      if (size === count) this.#free.splice(index, 1);
      else this.#free[index] = [range[0] + count, range[1]];
      return range[0];
    }
    return -1;
  }

  /** Records `[from, to)` back as free, merged with every range it touches. */
  #hole(from: number, to: number): void {
    if (to <= from) return;
    const free = this.#free;
    free.push([from, to]);
    free.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of free) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range[0] <= last[1]) {
        if (range[1] > last[1]) last[1] = range[1];
        continue;
      }
      merged.push(range);
    }
    this.#free = merged;
  }

  /**
   * Closes every hole below the drawn range, so `mesh.count` is the live total: the topmost block
   * moves into the lowest hole, or, when it does not fit, everything above the hole shifts down over
   * it. Whatever sits past the topmost block is free again, so one cell's room serves the next cell
   * instead of a `grow`, and the free list is left as the single tail range `[drawn, capacity)`.
   */
  #compact(): void {
    const array = this.mesh.instanceMatrix.array as Float32Array;
    for (;;) {
      let drawn = 0;
      let top = -1;
      let topFrom = 0;
      for (const [handle, start] of this.#start) {
        const end = start + (this.#size.get(handle) ?? 0);
        if (end <= drawn) continue;
        drawn = end;
        top = handle;
        topFrom = start;
      }
      this.#drawn = drawn;
      const lowest = this.#free[0];
      if (top < 0 || lowest === undefined || lowest[0] >= drawn) break;
      const [holeStart, holeEnd] = lowest;
      const size = this.#size.get(top) ?? 0;
      if (size <= holeEnd - holeStart) {
        array.copyWithin(holeStart * 16, topFrom * 16, drawn * 16);
        this.#start.set(top, holeStart);
        if (holeEnd - holeStart > size) this.#free[0] = [holeStart + size, holeEnd];
        else this.#free.shift();
        this.#hole(topFrom, drawn);
        this.#drawn = holeStart + size;
        this.#touched(holeStart, size);
      } else {
        const shift = holeEnd - holeStart;
        array.copyWithin(holeStart * 16, holeEnd * 16, drawn * 16);
        this.#free.shift();
        for (const [handle, start] of this.#start) {
          if (start >= holeEnd) this.#start.set(handle, start - shift);
        }
        for (const range of this.#free) {
          if (range[0] >= holeEnd) {
            range[0] -= shift;
            range[1] -= shift;
          }
        }
        this.#drawn = drawn - shift;
        this.#touched(holeStart, this.#drawn - holeStart);
      }
    }
    const capacity = this.mesh.instanceMatrix.count;
    const free: Array<[number, number]> = [];
    for (const [from, to] of this.#free) {
      if (from < this.#drawn) free.push([from, to > this.#drawn ? this.#drawn : to]);
    }
    if (this.#drawn < capacity) free.push([this.#drawn, capacity]);
    this.#free = free;
  }

  /**
   * Close the holes a write, a clear or a grow left, the way this batch's role needs.
   *
   * A caster batch compacts: one square holds the key's records, so the lowest hole is where the
   * topmost block belongs. A main batch regroups instead, because compaction would carry a block
   * away from the square it belongs to and the frustum test reads the squares.
   */
  #settle(): void {
    // A dressed batch's layout is the dispatch's: its `instanceMatrix` is the scene's shared buffer,
    // so a compact or regroup here would read that buffer's count as this batch's capacity and
    // shuffle the whole world's records. `write` and `clear` bypass this already; `grow` does too.
    if (this.gpu !== undefined) return;
    if (this.#clustered) {
      this.#regroup();
      // Records moved, so `mesh.count` is the live total again and the window has to be re-narrowed
      // by the next draw — with no copy, because the regroup just put the squares in place.
      this.#narrowed = false;
    } else this.#compact();
  }

  /**
   * Lay every live block out again, grouped by its world-grid square, `visible`'s squares first.
   *
   * A regroup is a permutation of `[0, drawn)` and there is no in-place order for one: writing the
   * visible squares to the front necessarily lands on squares whose records have not been read out
   * yet, in either direction. So every block is copied into {@link regroupScratch} and the new order
   * is copied back — two passes over the drawn range, and only when a square entered or left the
   * window, which on a settled camera is not once a frame.
   *
   * Squares keep their relative order within each half, so a residency change regroups in place and
   * a cull that found the same set writes nothing. What each square holds is recorded here, because
   * that is the only per-key data the window needs: the squares' world volumes belong to the grid,
   * not to a key, and are derived once a frame for all of them. See {@link WorldCells.#cullMainPass}.
   *
   * Only the records that actually moved are handed to the upload, and on a walk that is usually the
   * tail or nothing at all: the squares that stayed in the half they were in keep their offsets
   * exactly, so a square crossing the boundary between the two halves moves the records from there
   * to the boundary and leaves `[0, boundary)` byte-identical. Uploading `[0, drawn)` instead — which
   * is what this did — re-sent a whole key's records to the GPU on every frame the window moved,
   * which on a walking camera is most frames, and on the largest key in a 2 km walk measured
   * **37 draws over 7 ms each**. An identity reorder now costs no bytes at all, and the rest costs
   * the span that moved; `#touched` still widens a span over half the drawn range, so the ranges
   * stay few and large rather than many and small.
   */
  #regroup(visible = this.#visible): void {
    const array = this.mesh.instanceMatrix.array as Float32Array;
    const squares = this.#squares();
    let total = 0;
    for (const square of squares) total += sizeOf(square);
    const scratch = scratchFor(total * 16);
    // The visible squares first. `filter` is stable, so both halves keep the order the buffer had
    // them in and a residency change lays out exactly what the last one did.
    const front = squares.filter((one) => visible?.has(one.cluster) ?? true);
    const back = squares.filter((one) => !(visible?.has(one.cluster) ?? true));
    let written = 0;
    // Where the layout departed from the one the GPU holds: the first record written somewhere other
    // than where it was read from, and the last one after it. `-1` until something moves, so an
    // identity reorder touches nothing.
    let movedFrom = -1;
    let movedTo = 0;
    this.#squareSizes.clear();
    for (const square of [...front, ...back]) {
      const union = new Box3();
      for (const [handle, start, count] of square.blocks) {
        scratch.set(array.subarray(start * 16, (start + count) * 16), written * 16);
        // Read before it is overwritten: a block written back to its own offset is a record the GPU
        // already holds, and is the whole difference between a repack that costs nothing and one
        // that re-uploads the key.
        if (this.#start.get(handle) !== written) {
          if (movedFrom < 0) movedFrom = written;
          movedTo = written + count;
        }
        this.#start.set(handle, written);
        const box = this.#boxes.get(handle);
        // A fresh `Box3` is already empty, so the first block's box is the square's and every block
        // after it unions into it.
        if (box !== undefined) union.union(box);
        written += count;
      }
      this.#squareSizes.set(square.cluster, sizeOf(square));
    }
    array.set(scratch.subarray(0, written * 16));
    this.#drawn = written;
    const capacity = this.mesh.instanceMatrix.count;
    this.#free = written < capacity ? [[written, capacity]] : [];
    this.#window = this.#windowOf(visible);
    // After `#drawn`, because `#touched` measures the span it may widen against the drawn range, and
    // before the caller's own `#touched`, which the epoch unions with it rather than replacing it.
    if (movedFrom >= 0) this.#touched(movedFrom, movedTo - movedFrom);
  }

  /**
   * The live blocks, in buffer order and gathered into the squares they belong to.
   *
   * Buffer order is what "the squares keep their relative order" means, and it is not the order of
   * `#start`, which is keyed by handle rather than by position. A square's blocks are only adjacent
   * because the last regroup made them so — a cell admitted after that lands anywhere in the free
   * tail — so the squares are gathered here and written out by {@link #regroup}, and it is these
   * two orders that a residency change has to preserve.
   */
  #squares(): Array<{ cluster: string; blocks: Array<[number, number, number, string]> }> {
    const blocks: Array<[number, number, number, string]> = [];
    for (const [handle, start] of this.#start) {
      const size = this.#size.get(handle) ?? 0;
      if (size > 0) blocks.push([handle, start, size, this.#blockCluster.get(handle) ?? ""]);
    }
    blocks.sort((a, b) => a[1] - b[1]);
    const squares: Array<{ cluster: string; blocks: typeof blocks }> = [];
    const squareOf = new Map<string, number>();
    for (const block of blocks) {
      const cluster = block[3] as string;
      const index = squareOf.get(cluster);
      if (index === undefined) {
        squareOf.set(cluster, squares.length);
        squares.push({ cluster, blocks: [block] });
        continue;
      }
      (squares[index] as { blocks: typeof blocks }).blocks.push(block);
    }
    return squares;
  }

  /** Records of the squares in `visible`, the count a clustered batch's `mesh.count` draws. */
  #windowOf(visible: Set<string> | undefined): number {
    if (visible === undefined) return this.#drawn;
    let window = 0;
    for (const [cluster, size] of this.#squareSizes) if (visible.has(cluster)) window += size;
    return window;
  }

  /**
   * Narrow the draw window to the visibility cells `visible` names, rewriting the instance buffer
   * when this batch's own share of that set changed. `settled` when nothing had to be looked at,
   * `narrowed` when the count was re-widened, `repacked` when records were copied.
   *
   * `visible` and `epoch` are the frame's answer, derived once for the whole main pass by
   * {@link WorldCells.#cullMainPass}: one frustum, one set of visible visibility cells, and an epoch
   * that only moves when that set did. A batch whose records have not moved since it last packed at
   * that epoch answers `false` from two integer comparisons — no frustum, no set, no copy — which is
   * the whole of a settled frame across the ~230 meshes of a 2 km walk. Before that it was every
   * batch rebuilding a frustum from the same camera, allocating a set and re-testing its own per-key
   * volumes: ~4 ms a frame of `compute` for an answer that had not changed.
   *
   * Three's whole-mesh test cannot do this at all: the mesh's bounds are every resident cell's, so on
   * a 640 m ring the test always passes and every instance behind or beside the camera is
   * vertex-shaded — which on a tree-heavy 2 km map is most of a 65 M-triangle main pass, and the
   * whole cost of it is vertex work that half resolution does not touch.
   *
   * The cells are the main cull's own and the volumes are per placement (see
   * {@link WorldCells.#cullMainPass}), which is what this narrowness is spent on: a cell's XZ is
   * one world cell rather than a 128 m caster square, and its Y is the height its own placements
   * reach rather than the whole map's terrain range.
   *
   * A draw that finds the same cells it found last time touches nothing at all: no copy, no
   * `needsUpdate`, and therefore no attribute version — which is what a settled static draw watches
   * to know it still has to scan.
   */
  cullFrom(visible: ReadonlySet<string>, epoch: number): "settled" | "narrowed" | "repacked" {
    if (!this.#clustered) return "settled";
    // A batch holding no square draws nothing whatever the camera found, so it is published empty
    // and takes no set and no scan — a prewarmed batch sits in exactly this state.
    if (this.#squareSizes.size === 0) {
      this.#publish(0);
      return "settled";
    }
    // Settled: the frame's set is the one this window was laid out at and no record joined or left
    // since. O(1), and no allocation of any kind.
    if (this.#narrowed && this.#packedEpoch === epoch) return "settled";
    const next = this.#scratch;
    next.clear();
    for (const square of this.#squareSizes.keys()) if (visible.has(square)) next.add(square);
    // The same squares as the buffer holds: a residency change or a square elsewhere entering and
    // leaving the view. The layout is already right, so the window only has to be re-narrowed — a
    // residency change left `mesh.count` at the live total, and `#settle`'s regroup put the squares
    // in the window's order with no copy.
    if (sameSquares(next, this.#visible)) {
      this.#publish(this.#window);
      this.#narrowed = true;
      this.#packedEpoch = epoch;
      return "narrowed";
    }
    this.#regroup(next);
    // The reorder hands its own upload, over the records that actually moved — a window that moved
    // a square across the half boundary and left every record where it was costs nothing here, which
    // is the walking camera's common case. See `#regroup`.
    // The layout now belongs to the other set, so the two trade places and the next cull reuses the
    // one this batch is no longer holding.
    const was = this.#visible;
    this.#visible = next;
    this.#scratch = was ?? new Set();
    this.#scratch.clear();
    // `#publish` is what hides a window the camera narrowed to nothing, and what shows it again when
    // the camera turns back.
    this.#publish(this.#window);
    this.#narrowed = true;
    this.#packedEpoch = epoch;
    return "repacked";
  }

  /** Live records this batch holds, whether the camera is drawing them or not. */
  get live(): number {
    return this.#drawn;
  }

  /**
   * The record ceiling of this batch's *own* buffer, which is what a key's GPU region is sized from:
   * the same ring-sized ceiling the CPU path stops growing at. Held rather than read, because a
   * dressed batch's `mesh.instanceMatrix` is the GPU scene's shared buffer and its count is that
   * buffer's, not this key's.
   */
  get liveCeiling(): number {
    return this.#ceiling;
  }

  /** Records `mesh.count` draws: every live one, until a cull narrows the window. */
  get drawn(): number {
    return this.#clustered ? this.#window : this.#drawn;
  }

  /**
   * One coalesced upload per mesh, not one per moved, written or zeroed record range. Three's WebGPU
   * backend turns each entry of `updateRanges` into its own `GPUQueue.writeBuffer`, so the
   * per-range bookkeeping here was the walk's largest CPU cost: thousands of sub-1 KB vertex writes
   * per frame, over a second of a short walk spent on the queue. The dirty span is accumulated here
   * across every write, compact and clear of one update, so a frame that touches a mesh from
   * several directions still issues one writeBuffer. A span over half the drawn range becomes the
   * whole drawn range, which is never more bytes than the two halves it replaced.
   */
  #touched(from: number, count: number): void {
    // A dressed batch's records were never in this attribute, so there is nothing to upload and
    // nothing to put back in charge of culling: the dispatch decided what it drew.
    if (this.gpu !== undefined) return;
    const matrix = this.mesh.instanceMatrix;
    // A record is 16 array elements, and that is the unit `updateRanges` is in: three reads them
    // as element offsets into `array`, not as bytes.
    const drawn = this.#drawn * 16;
    const low0 = from * 16;
    const high0 = (from + count) * 16;
    // The pending span is ours, and it lasts one update. Three's WebGPU path uploads through the
    // interleaved buffer it derives from `instanceMatrix.array` and only that buffer's ranges are
    // cleared after the write, so the ranges on `instanceMatrix` are never consumed: they were
    // unioned in here forever, and after one wide write every later write re-uploaded the whole
    // drawn range. The epoch moves once per `update()`, and the render at the end of an update is
    // what consumes the span, so a fresh epoch is a fresh span.
    let low = low0;
    let high = high0;
    const epoch = currentWriteEpoch();
    if (this.#pendingEpoch === epoch) {
      if (this.#pendingLow < low) low = this.#pendingLow;
      if (this.#pendingHigh > high) high = this.#pendingHigh;
    }
    if (low > 0 && (high - low) * 2 > drawn) {
      low = 0;
      high = drawn;
    }
    this.#pendingLow = low;
    this.#pendingHigh = high;
    this.#pendingEpoch = epoch;
    matrix.clearUpdateRanges();
    if (high > low) matrix.addUpdateRange(low, high - low);
    matrix.needsUpdate = true;
    this.#publish(this.#drawn);
    // Records are real, so the bounds are the ones `#rebound` just wrote and the mesh goes back to
    // being culled.
    this.mesh.frustumCulled = true;
  }

  /**
   * The one place `mesh.count` is written, so a batch that would draw nothing is not submitted.
   *
   * In three r185's WebGPU path an `InstancedMesh` with `count === 0` still runs the whole per-draw
   * JS chain — nodes, bindings, pipeline, attributes — and only the backend's `getDrawParameters`
   * finally answers null. A walk census measured 322 of 871 main batch meshes and 437 of 1,574
   * caster meshes at count 0, so every empty batch was ~17 µs of CPU a frame for nothing drawn.
   * `visible` is the one flag three reads before any of that, so a batch with nothing to draw is
   * hidden here and shown again by the first write that gives it a record: a placement add, a
   * rebind of a retained batch, a residency change, or the main cull's window opening again.
   *
   * The exception is a batch still owed its prewarm draw, which stays visible *because* it is empty:
   * that one draw is what builds the node and the pipeline the loading screen exists to pay for,
   * and hiding it would hand the build to the first walk frame that wants the key. It hides as soon
   * as the draw is counted — see {@link prewarmDrew} — so this costs one zero-count draw per
   * prewarmed batch over the whole load, which is the cost the prewarm is for.
   */
  #publish(count: number): void {
    // A shadow key is submitted every render of a map that covers it: its own records are the
    // dispatch's, so an empty-looking key is one this map draws nothing of, not one to hide.
    if (this.role === "key") {
      this.mesh.count = this.gpuCount;
      this.mesh.visible = true;
      return;
    }
    // A dressed batch's instances are the GPU scene's, and its own `count` says nothing about how
    // many the dispatch kept — a zero there makes three skip the indirect draw before the GPU reads
    // the record at all. So the mesh is submitted at its region's capacity and the record decides
    // what draws; the per-asset coarse gate in `#cullMainPass` runs after this every frame and is
    // what shows it. Until then the prewarm draw is the one reason to stay visible *because* it is
    // empty: that submission is what builds the node and the pipeline.
    if (this.gpu !== undefined) {
      this.mesh.count = this.gpuCount;
      if (this.bundled === false) this.mesh.visible = this.#awaitingPrewarm;
      return;
    }
    this.mesh.count = count;
    this.mesh.visible = count > 0 || this.#awaitingPrewarm;
  }

  /**
   * The GPU-driven main pass's coarse gate, asked per key and answered per asset: whether any of
   * this batch's CPU grid squares is in `visible`, or it still owes the draw that builds its node.
   *
   * It is deliberately *not* the draw decision. A key's squares are the level the CPU picked from the
   * follow point when it built them, and the dispatch re-picks the level from the camera every frame
   * — so a key holding no cell can be the one the dispatch draws, and hiding on its own empty answer
   * is how a tree disappeared on approach. The caller unions this across every level and part of the
   * asset and hands the asset's answer back; see `WorldCells#cullMainPass` and `applyGpuVisible`.
   */
  seenIn(visible: ReadonlySet<string>): boolean {
    if (this.#awaitingPrewarm) return true;
    for (const square of this.#squareSizes.keys()) if (visible.has(square)) return true;
    return false;
  }

  /**
   * Apply the asset's conservative visibility answer to this dressed mesh, and publish the count a
   * draw and the census read. A bundled mesh is shown by its recorded bundle and never asked.
   */
  applyGpuVisible(shown: boolean): void {
    // The region's capacity, not this batch's own records: an empty-looking key — one the CPU built
    // at another level — must still submit its indirect draw, and the record inside it draws nothing
    // when the dispatch selected none. See `gpuCount`.
    this.mesh.count = this.gpuCount;
    this.mesh.visible = shown;
  }

  /**
   * Owe this batch its prewarm draw, and show it: empty, unsubmitted work is not what a prewarm
   * wants, one submission is.
   *
   * The flag on the mesh is what `VirtualShadowNode`'s `#probe` reads: a caster is drawn by a level,
   * and a level picks one of the two caster layers, so a level that finds an owed caster renders
   * both — otherwise the half it did not pick would leave its prewarm casters unbuilt for the whole
   * walk. Engine bookkeeping on the mesh, beside the `casterInstanceScale` the probe already reads.
   */
  awaitPrewarmDraw(): void {
    this.#awaitingPrewarm = true;
    (this.mesh as { casterPrewarmOwed?: boolean }).casterPrewarmOwed = true;
    this.#publish(this.drawn);
  }

  /**
   * Publish this batch's admission for the frame, on the mesh beside the other two flags the shadow
   * probe reads off it. A `main` batch has nothing to say — it is the truth the caster halves are
   * measured against — and writes its own mesh, which is on layer 0 and no level ever draws.
   */
  setMainAdmitted(admitted: boolean): void {
    if (this.role === "main" || this.#mainAdmitted === admitted) return;
    this.#mainAdmitted = admitted;
    this.mesh.mainAdmitted = admitted;
  }

  /**
   * The owed draw is counted, or it can never come, so the batch follows the count again and hides
   * if no placement ever gave it a record. Only `visible` is written: the count three is submitting
   * this frame is the right one, and `#publish` would replace it with a window no cull has run for.
   */
  prewarmDrew(): void {
    this.#awaitingPrewarm = false;
    (this.mesh as { casterPrewarmOwed?: boolean }).casterPrewarmOwed = false;
    // A bundled mesh is in a render list three fixed when it recorded the bundle, and the replay
    // never re-reads visibility — so hiding it here would not save this frame's draw and would lose
    // the mesh from every record after the next structural change. See `bundled`.
    if (this.bundled === true) return;
    this.mesh.visible = this.mesh.count > 0;
  }
}

/**
 * A camera, plus the one flag the exclusion rule reads. Three sets `isOrthographicCamera` on an
 * `OrthographicCamera` at runtime and declares it on no base camera type, so it is duck-typed here
 * the same way `ICasterScaleMesh` and `isInstancedMesh` are.
 */
type ICamera = Camera & { readonly isOrthographicCamera?: boolean };

/**
 * The `@x,z` half of a cluster key, for a cell index. `cellsPerCluster` squares of cells per
 * cluster, so the answer is stable for as long as the grid is: placements never move, so a record is
 * only ever clustered when the cell holding it is admitted or evicted.
 */
function clusterOf(cellX: number, cellZ: number, cellsPerCluster: number): string {
  return `${String(Math.floor(cellX / cellsPerCluster))},${String(Math.floor(cellZ / cellsPerCluster))}`;
}

/**
 * Whether any of `gates` — ascending — lies in `[low, high]`. One binary search for the first gate at
 * or past `low`, against the walk of every gate a scan does per cell: a follow point that has not
 * carried anything across a boundary is the common case, and the refilter runs it over every resident
 * cell every 2 m of travel. Ends included, so a placement exactly on a gate is one of the reasons to
 * rebuild.
 */
function crossesGate(gates: readonly number[], low: number, high: number): boolean {
  let start = 0;
  let end = gates.length;
  while (start < end) {
    const middle = (start + end) >> 1;
    if ((gates[middle] as number) < low) start = middle + 1;
    else end = middle;
  }
  return start < gates.length && (gates[start] as number) <= high;
}

interface ICellProxyState {
  readonly cell: IResidentCell;
  readonly selector: CellProxySelection;
  readonly retainedPaths: string[];
  pending: boolean;
  compiling: boolean;
  cancelled: boolean;
  compiled: boolean;
  active: boolean;
  bytes: number;
  model?: Object3D;
  prepared?: IPreparedCellProxy;
  readonly observed: Set<Mesh>;
  readonly hidden: Map<Mesh, boolean>;
}

interface IResidentCell {
  proxy?: ICellProxyState;
  readonly mainChunkMeshes: Mesh[];
  readonly completedRuns: Set<IWorldRun>;
  chunksLoaded: boolean;
  chunkFailed: boolean;
  readonly key: string;
  readonly x: number;
  readonly z: number;
  readonly cell: IWorldCell;
  /**
   * The union of the distances from every one of this cell's batches' own filter points to the cell's
   * rectangle, widened as batches are built and never narrowed; see `#staleIn`. Monotone on purpose:
   * too wide a range means a cell the gate test does not reject, and too narrow one would drop a
   * rebuild the pass owes.
   */
  filterNear: number;
  filterFar: number;
  readonly generation: number;
  readonly instances: number;
  readonly bytes: number;
  readonly batches: ICellBatch[];
  readonly chunks: Object3D[];
  /**
   * The exact `assets.model` cache paths this cell's chunks asked the loader for, held in
   * `#modelPaths` and handed back once the last cell naming a path is gone, exactly like an asset's
   * levels; see `#releaseModelPaths`. Empty for a cell with no chunks or a `loadModel` override.
   */
  readonly retainedModelPaths: string[];
}

/**
 * One cell's asset run waiting to be built, in units small enough to fit a frame's admission
 * budget: a slice of placements, or one mesh built.
 *
 * A job outlives the `update` that queued it, so every field it needs to resume is on the job and
 * not on the call stack — a streamed cell holds its residency slot while it waits, so the work is
 * never spent on a cell that has since left.
 */
interface IBuildJob {
  readonly asset: IAssetState;
  readonly cell: IResidentCell;
  readonly run: IWorldRun;
  /** The follow snapshot taken at first admission, held fixed across every placement slice. */
  filterY: number;
  filterX: number;
  filterZ: number;
  /** A refilter's outgoing batches, drawn until this job's own batches are attached. */
  replaced: ICellBatch[];
  /** This job's built batches, attached together when the last one is ready. */
  readonly fresh: ICellBatch[];
  /** The run's placement records, read once and kept across the slices that filter them. */
  records: Float32Array | undefined;
  /** Next placement to filter; the filter is complete when it reaches `run.count`. */
  next: number;
  batches: InstancedBatch[][] | undefined;
  /**
   * One root-matrix batch per level the filter reached, filled only when the asset can become a
   * whole-asset impostor: the placement transform with no part offset, which is what its far quad
   * needs. `undefined` for every other asset, so nothing pays for records the wide half never reads.
   */
  roots: (InstancedBatch | undefined)[] | undefined;
  /**
   * Bypass the refilter's identical-answer fast path. A handoff that changes what a wide segment must
   * hold is not an identical answer even when the level and records are, so the rebuild has to swap.
   */
  force: boolean;
  /** One world-bounds box per `(level, part)` batch, filled by `#addPlacements` and read on swap. */
  boxes: Box3[][] | undefined;
  /** How many of the (level, part) meshes have been built. */
  published: number;
  /**
   * The GPU scene's source records for the placements this filter kept, one per placement beside the
   * level it reached — filled by `#addPlacements` only while the scene is on, and read on the swap.
   */
  sources: IGpuSource[] | undefined;
  /** The records placed per level, so every part of a level shares one list; see `#placeSources`. */
  gpuByLevel: Map<number, number[]> | undefined;
}

/** One placement as the GPU scene's source buffer holds it: the placement's own transform, no part. */
interface IGpuSource {
  readonly level: number;
  readonly matrix: Matrix4;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Half the diagonal of the asset's authored bounds at this placement's scale. */
  readonly radius: number;
  /** The placement's uniform scale, carried so the dispatch can scale a whole-asset impostor gate. */
  readonly scale: number;
}

/** One drawable part of one level, read out of the level's own GLB. */
interface IAssetPart {
  readonly geometry: BufferGeometry;
  /** The mesh's transform relative to the model root, composed into every instance matrix. */
  readonly local: Matrix4;
  /** The surface the batch draws with: the shared surface for this part's material content. */
  readonly material: Material;
  /** The `materialKey` of that surface, released through the shared-surface registry. */
  readonly surface: string;
}

/**
 * One completed whole-asset atlas, cached by its content key and its source cutout contract.
 *
 * Bounded, not a generic cache: the atlas is the one GPU resource a later far reference may want to
 * hold without keeping the full source GLB, and the CPU `center`/`radius` are the two scalars the
 * surface needs to project it. `users` counts the live assets drawing it; a record with no user is
 * inactive and evictable once the byte budget is over, and one with a user is never evicted.
 */
interface IImpostorRecord {
  readonly key: string;
  readonly atlas: WorldImpostorAtlas;
  readonly center: Vector3;
  readonly radius: number;
  readonly bytes: number;
  users: number;
}

/** The terminal LOD one asset appended once its bake landed; owned and released with the asset. */
interface IImpostorState {
  readonly part: IAssetPart;
  readonly surface: WorldImpostorSurface;
  readonly record: IImpostorRecord;
}

/**
 * One `(cell, run)`'s slice of a whole-map far aggregate.
 *
 * The records are the run's ORIGINAL placement roots, composed once when the aggregate is built and
 * never rewritten while the camera moves. `live` is false while the near ring owns the run, which is
 * the atomic handoff: a run is drawn by exactly one of the two, never both and never neither.
 */
interface IFarSegment {
  readonly cell: IWorldCell;
  readonly run: IWorldRun;
  /** First instance record in the aggregate's buffer, and how many the run holds. */
  readonly start: number;
  readonly count: number;
  /** This run's own view-distance gate, `Infinity` when its asset authored no `maxDistance`. */
  readonly cull: number;
  live: boolean;
}

/**
 * One whole-map far aggregate per exact atlas cache key: a single `InstancedMesh` holding every
 * ORIGINAL placement root of every canonical asset that bakes to that key, independent of the near
 * full-geometry ring and of the near source GLBs.
 *
 * The surface is the aggregate's own, built from the record's atlas and the first source material
 * that baked to it, so disposing a near asset's surface cannot invalidate the far mesh. The atlas is
 * borrowed: `record.users` is incremented once for the aggregate and held until the world disposes,
 * which is what stops `#evictImpostors` dropping an atlas the far mesh still draws.
 */
interface IFarAggregate {
  readonly key: string;
  readonly surface: WorldImpostorSurface;
  readonly record: IImpostorRecord;
  mesh: InstancedMesh;
  capacity: number;
  /** Every original placement root the aggregate holds, live and near-owned. */
  readonly segments: Map<IWorldRun, IFarSegment>;
  /** How many times the instance buffer has been written, for the settled-frame check. */
  uploads: number;
}

/**
 * The metadata a refused far cohort is kept as, without its source GLB.
 *
 * A hard budget refusal releases the asset's geometry and materials the way any release does; the
 * atlas is pinned by one borrowed `users` and the aggregate's own surface is built once here, so a
 * later capacity release retries from this alone — no full model is held alive for a cohort that may
 * never fit. See `#deferFar`, `#retryFar`.
 */
interface IFarCohort {
  readonly id: string;
  readonly key: string;
  readonly record: IImpostorRecord;
  /** The alpha-foliage source material to twin; absent once a refused cohort has its surface built. */
  readonly source?: Material;
  readonly alphaTest: number;
  readonly cull: number;
  readonly runs: ReadonlyArray<{ cell: IWorldCell; run: IWorldRun }>;
}

/**
 * A refused far cohort kept without its source GLB: metadata plus the surface already built from the
 * source at refusal. No material, geometry or texture of the model survives here — only the surface,
 * which cleared its UV maps and borrows the pinned atlas.
 */
interface IFarRetryEntry {
  readonly id: string;
  readonly key: string;
  readonly record: IImpostorRecord;
  readonly alphaTest: number;
  readonly cull: number;
  readonly runs: ReadonlyArray<{ cell: IWorldCell; run: IWorldRun }>;
  readonly surface: WorldImpostorSurface;
}

/** A surface every part with the same material content draws with, and who still uses it. */
interface ISharedSurface {
  readonly material: Material;
  /** The canonical source and any cutout made from it, torn down with the last user. */
  readonly owned: readonly Material[];
  users: number;
}

/** Parts already handed back, so a level that fell back to the one above releases it once. */
const releasedParts = new WeakSet<IAssetPart>();

interface IAssetState {
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

/** GPU resources already handed to a `dispose`, so no second path can tear the same one down. */
const tornDown = new WeakSet<object>();

/**
 * Release one GPU resource: at most once per resource, and never by throwing.
 *
 * Exactly once is the streaming contract: an asset's geometry is shared by every cell batch drawn
 * from it, so several residency paths can reach the same object, and a second teardown is the
 * renderer's problem, not the game's.
 *
 * Never throwing is the other half. Three disposes a geometry by deleting each of its attributes,
 * and `WebGPUAttributeUtils.destroyAttribute` reads the GPU buffer off the attribute and calls
 * `destroy` on it with no guard — so disposing a geometry whose upload never produced that buffer
 * throws `TypeError: Cannot read properties of undefined (reading 'destroy')` from wherever the
 * teardown was called. A cell leaving range is the most ordinary thing a streaming world does, so
 * that has to land as a counted failure here, not as a dead frame.
 *
 * @returns `true` when the teardown itself threw, for the caller to count.
 */
function release(target: { dispose: () => void } | undefined): boolean {
  if (target === undefined || tornDown.has(target)) return false;
  tornDown.add(target);
  try {
    target.dispose();
  } catch {
    return true;
  }
  return false;
}

async function loadModelWith(assets: IAssetLoader, path: string): Promise<Object3D> {
  const gltf = await assets.model<{ scene?: Object3D }>(path);
  const scene = gltf?.scene;
  if (!(scene instanceof Object3D))
    throw new Error(`World asset '${path}' loaded without an Object3D scene.`);
  return scene;
}

function resolveRelative(baseUrl: string, relative: string): string {
  if (/^(?:[a-z]+:)?\/\//iu.test(relative) || relative.startsWith("data:")) return relative;
  return `${baseUrl}${relative.replace(/^\//u, "")}`;
}

/**
 * The raw renderer seam the impostor bake needs, or `undefined` when this backend does not expose it.
 *
 * `IRendererLike.raw` is `unknown` on purpose: it is whatever the running renderer is, and a backend
 * without layered render targets has no bake seam at all. The shape is checked rather than cast, so a
 * stub whose raw is not a renderer leaves the bake un-run instead of throwing inside a frame.
 *
 * A WebGL renderer is the reason the three-method shape alone is not enough: it carries `render`,
 * `setRenderTarget` and `initRenderTarget` and would pass, then fail mid-frame on the layered MRT
 * capture it cannot run. So the backend must declare itself WebGPU (`kind` and the renderer's own
 * `isWebGPURenderer`), which a WebGL fallback and an unsupported native backend do not, and the full
 * getter/setter seam the baker calls must be present before the cast — the ones the baker reaches
 * with `?.` still have to exist on a real backend, and a raw object missing them would be half-run,
 * not skipped cleanly.
 */
const REQUIRED_IMPOSTOR_METHODS = [
  "getActiveCubeFace",
  "getActiveMipmapLevel",
  "getClearAlpha",
  "getClearColor",
  "getMRT",
  "getRenderTarget",
  "initRenderTarget",
  "render",
  "setClearAlpha",
  "setClearColor",
  "setMRT",
  "setRenderTarget",
] as const;

function impostorRawRenderer(
  renderer: IRendererLike | undefined,
): IImpostorRawRenderer | undefined {
  if (renderer === undefined || renderer.kind !== "webgpu") return undefined;
  const raw = renderer.raw as
    | (Partial<IImpostorRawRenderer> & { isWebGPURenderer?: boolean })
    | null;
  if (raw === null || raw === undefined) return undefined;
  if (raw.isWebGPURenderer !== true) return undefined;
  // A `WebGPURenderer` can wrap the WebGL fallback backend and still report `kind: 'webgpu'` and
  // `isWebGPURenderer === true`; that backend cannot run a layered MRT capture, so the method shape
  // alone would accept it and fail mid-frame. The backend it actually wrapped is the honest answer.
  if ((raw as { backend?: { isWebGLBackend?: boolean } }).backend?.isWebGLBackend === true)
    return undefined;
  for (const method of REQUIRED_IMPOSTOR_METHODS)
    if (typeof raw[method] !== "function") return undefined;
  return raw as IImpostorRawRenderer;
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
 * The alpha threshold a cutout gets when the part's own material names none. ponytail: a fixed
 * 0.5, because the cutout point is authored data a GLB carries per texture and nothing reads it
 * here. A tree whose needles visibly dither at 0.5 wants a lower one — give
 * `transparentScatter` a third mode carrying a threshold when that is worth a knob.
 */
const DEFAULT_CUTOUT_ALPHA = 0.5;

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

/** What one chunk's merge did, for `TN_WORLD_CHUNK_MERGE`. */
interface IChunkMerge {
  /** Meshes the chunk held before, and the ones its subtree submits after. */
  readonly meshes: number;
  readonly draws: number;
  /**
   * Bytes the merged groups hold: exactly what the first draw of those meshes uploads, and the
   * number this merge exists to keep small.
   */
  readonly bytes: number;
  /** Instanced meshes baked into a material's group, and the ones left instanced. */
  readonly expanded: number;
  readonly keptInstanced: number;
  /** Teardowns of the consumed shapes that threw, for the caller to count. */
  readonly failed: number;
  /** Shadow-only proxies, per side for merged and retained parts; 0 when nothing casts. */
  readonly shadowDraws: number;
  /**
   * The opaque meshes a proxy covers. They keep drawing the main pass and keep receiving, and
   * they stop casting: the depth pass reads positions, not materials, so it reads the proxy instead.
   */
  readonly shadowCovered: readonly Mesh[];
}

function meshesOf(root: Object3D): number {
  let meshes = 0;
  root.traverse((object) => {
    if ((object as Mesh).isMesh === true) meshes += 1;
  });
  return meshes;
}

/**
 * The one surface each `side` of a chunk shadow proxy draws with, world-wide.
 *
 * A depth pass cannot tell one material from another: it reads `side`, `alphaTest` and position,
 * and a proxy covers only opaque, non-alphaTest meshes, so every covered material with the same
 * `side` produces the same shadow pipeline. Borrowing one per covered group built a new one for
 * every chunk that loaded — 23 shadow draws over 125 ms and a 18 ms worst case on the walk this
 * measured, each one compiling a pipeline the one before it had already proven was identical. The
 * first covered material seen for a side is the world's, and every later proxy of that side borrows
 * it, so a world pays at most one shadow pipeline per side over its whole life.
 *
 * The materials are the world's own, so `disposeModel` must not release them with the chunk that
 * happened to contribute them.
 */
const worldOwned = new WeakSet<Material>();

/**
 * A depth pass cannot tell one material from another, so a chunk's shadow bill is its material
 * count, not its triangle count: ~100 shadow draws a level render on the map, each a per-material
 * mesh walked through the light's frustum. Positions are all it needs, and a position-only geometry
 * grouped by `side` — the one thing a depth material does read — collapses that bill to one draw per
 * side.
 *
 * Every proxy sits on both caster halves: covered originals no longer cast, so choosing
 * key-wide scatter must retain the buildings, towers and fences represented by the proxy.
 * Either way it is counted by the same `#probe` window test as the scatter caster
 * clusters, so a level whose window does not reach the chunk drops it for free. Nothing here decides
 * how anything looks: the covered meshes keep the game's own materials and keep drawing the main pass
 * with them, and the proxy carries the world's material for its `side` by reference — the group it
 * was grouped *by* is the material's own `side`, so the depth pass reads exactly what the covered
 * mesh's own depth material would have read, and this file still constructs no material.
 *
 * Alpha-tested and transparent meshes keep casting themselves. Retained static instances use
 * separate per-side proxies, so their per-part gates do not change the existing merged proxies.
 */
function buildChunkShadowProxies(
  chunk: Object3D,
  merged: readonly Mesh[],
  label: string,
  proxyMaterials: Map<number, Material>,
  selectParts = false,
): { readonly covered: Mesh[]; readonly proxies: Mesh[] } {
  const sides = new Map<number, { material: Material; meshes: Mesh[] }>();
  for (const mesh of merged) {
    const material = mesh.material;
    if (Array.isArray(material) || material.transparent === true || material.alphaTest > 0)
      continue;
    const side = material.side;
    const group = sides.get(side);
    if (group === undefined) sides.set(side, { material, meshes: [mesh] });
    else group.meshes.push(mesh);
  }
  const covered: Mesh[] = [];
  const proxies: Mesh[] = [];
  for (const [side, group] of sides) {
    // Three's sides occupy 0..2; retained sources have their own compatible material pool.
    const key = side + (selectParts ? 3 : 0);
    const held = proxyMaterials.get(key);
    const material = held ?? group.material;
    if (held === undefined) {
      proxyMaterials.set(key, material);
      worldOwned.add(material);
    }
    const proxy = new Mesh(shadowProxyGeometry(group.meshes, label, chunk), material);
    if (selectParts) selectChunkShadowParts(proxy, group.meshes);
    proxy.name = `${CHUNK_NAME}-shadow`;
    // The origin a draw of this mesh is counted under (`RenderPassBudget`). A proxy on the caster
    // layers never reaches the main pass, so this only says anything where the world's own cull
    // left one on layer 0 — and it is written here rather than inferred, so the tag cannot rot.
    proxy.userData.tnDrawSource = "proxies";
    proxy.layers.set(VIRTUAL_SHADOW_CASTER_LAYER);
    proxy.layers.enable(VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
    proxy.castShadow = true;
    proxy.receiveShadow = false;
    chunk.add(proxy);
    markStatic(proxy);
    proxies.push(proxy);
    for (const mesh of group.meshes) {
      mesh.castShadow = false;
      covered.push(mesh);
    }
  }
  return { covered, proxies };
}

/**
 * One position-only geometry holding every covered mesh's vertices, indices preserved.
 *
 * Read through the attribute's own accessors, because a cooked model's positions can be quantized
 * and interleaved (`KHR_mesh_quantization`) and the raw array behind them is not what three would
 * have drawn. One pass at load time; the result is a depth buffer's whole input.
 */
/**
 * One mesh's vertices, placed into `positions` from `vertexAt`.
 *
 * A merged mesh's positions came out of `mergeByMaterial` as one plain float array, so that is three
 * reads, three multiplies and three writes per vertex. The arithmetic is three's, term for term and
 * including `applyMatrix4`'s homogeneous divide, so a proxy holds the vertices it held before. A
 * retained source can still be quantized and interleaved (`KHR_mesh_quantization`), and it takes the
 * accessor loop, which is what that arithmetic resolves to.
 */
function placeVertices(
  position: BufferAttribute,
  matrix: Matrix4,
  positions: Float32Array,
  vertexAt: number,
): void {
  if (
    position.array instanceof Float32Array &&
    !position.normalized &&
    !("isInterleavedBufferAttribute" in position)
  ) {
    const values = position.array as Float32Array;
    const e = matrix.elements;
    for (let index = 0; index < position.count; index += 1) {
      const x = values[index * 3] as number;
      const y = values[index * 3 + 1] as number;
      const z = values[index * 3 + 2] as number;
      const w = 1 / (e[3] * x + e[7] * y + e[11] * z + e[15]);
      const out = (vertexAt + index) * 3;
      positions[out] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * w;
      positions[out + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w;
      positions[out + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w;
    }
    return;
  }
  const vertex = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    vertex.fromBufferAttribute(position, index).applyMatrix4(matrix);
    vertex.toArray(positions, (vertexAt + index) * 3);
  }
}

function shadowProxyGeometry(
  meshes: readonly Mesh[],
  label: string,
  chunk: Object3D,
): BufferGeometry {
  chunk.updateMatrixWorld(true);
  const toRoot = chunk.matrixWorld.clone().invert();
  const place = new Matrix4();
  const instance = new Matrix4();
  const matrix = new Matrix4();
  let vertices = 0;
  let drawn = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    if (position === undefined)
      throw new Error(`Chunk shadow proxy (${label}): a merged mesh carries no position.`);
    const copies = mesh instanceof InstancedMesh ? mesh.count : 1;
    const total = mesh.geometry.getIndex()?.count ?? position.count;
    const start = Math.min(total, Math.max(0, mesh.geometry.drawRange.start));
    vertices += position.count * copies;
    drawn += Math.max(0, Math.min(total, start + mesh.geometry.drawRange.count) - start) * copies;
  }
  const positions = new Float32Array(vertices * 3);
  const indices = new Uint32Array(drawn);
  let vertexAt = 0;
  let indexAt = 0;
  const geometry = new BufferGeometry();
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute("position");
    if (position === undefined)
      throw new Error(`Chunk shadow proxy (${label}): a merged mesh carries no position.`);
    const source = mesh.geometry.getIndex();
    const total = source?.count ?? position.count;
    const start = Math.min(total, Math.max(0, mesh.geometry.drawRange.start));
    const end = Math.min(total, start + mesh.geometry.drawRange.count);
    const groupAt = indexAt;
    place.multiplyMatrices(toRoot, mesh.matrixWorld);
    for (let copy = 0; copy < (mesh instanceof InstancedMesh ? mesh.count : 1); copy += 1) {
      if (mesh instanceof InstancedMesh) mesh.getMatrixAt(copy, instance);
      else instance.identity();
      matrix.multiplyMatrices(place, instance);
      placeVertices(position as BufferAttribute, matrix, positions, vertexAt);
      for (let index = start; index < end; index += 1)
        indices[indexAt++] = (source?.getX(index) ?? index) + vertexAt;
      vertexAt += position.count;
    }
    geometry.addGroup(groupAt, indexAt - groupAt);
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Keep retained sources' visibility, frustum and texel decisions on each level's single draw. */
function selectChunkShadowParts(proxy: Mesh, sources: readonly Mesh[]): void {
  const caster = proxy as Mesh & { chunkShadowProxy?: boolean; casterMinDiameter?: number };
  caster.chunkShadowProxy = true;
  // The source frustums below decide the exact inputs; the union must not veto that decision.
  proxy.frustumCulled = false;
  const geometry = proxy.geometry;
  const complete = ((geometry.getIndex() as BufferAttribute).array as Uint32Array).slice();
  const levels = new Map<Camera, { geometry: BufferGeometry; selected: Uint8Array }>();
  const disposeLevels = (event: { target: unknown }) => {
    const geometries = new Set([geometry]);
    for (const level of levels.values()) geometries.add(level.geometry);
    for (const held of geometries) held.removeEventListener("dispose", disposeLevels);
    for (const held of geometries) if (held !== event.target) held.dispose();
    levels.clear();
  };
  geometry.addEventListener("dispose", disposeLevels);
  const frustum = new Frustum();
  const projection = new Matrix4();
  const sphere = new Sphere();
  proxy.onBeforeRender = function (_renderer, _scene, camera) {
    let level = levels.get(camera);
    if (level === undefined) {
      if (levels.size === 3) {
        // ponytail: three resident camera buffers; extra cameras reuse the oldest slot.
        const oldest = levels.keys().next().value as Camera;
        level = levels.get(oldest) as { geometry: BufferGeometry; selected: Uint8Array };
        levels.delete(oldest);
        level.selected.fill(255);
      } else {
        const perLevel = levels.size === 0 ? geometry : new BufferGeometry();
        if (perLevel !== geometry) {
          perLevel.setAttribute("position", geometry.getAttribute("position"));
          perLevel.setIndex(new BufferAttribute(new Uint32Array(complete.length), 1));
          perLevel.boundingSphere = geometry.boundingSphere;
          perLevel.addEventListener("dispose", disposeLevels);
        }
        level = { geometry: perLevel, selected: new Uint8Array(sources.length).fill(255) };
      }
      levels.set(camera, level);
    }
    // Three fetches the render object after this hook and detects geometry identity changes,
    // even when different cameras share a render object. Exact projection stand-ins use `this`.
    this.geometry = level.geometry;
    const index = level.geometry.getIndex() as BufferAttribute;
    const selected = level.selected;
    frustum.setFromProjectionMatrix(
      projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
      camera.reversedDepth,
    );
    let changed = false;
    let count = 0;
    for (let part = 0; part < sources.length; part += 1) {
      const source = sources[part] as InstancedMesh;
      if (source.boundingSphere === null) source.computeBoundingSphere();
      sphere.copy(source.boundingSphere as Sphere).applyMatrix4(source.matrixWorld);
      let visible = true;
      for (let node: Object3D | null = source; node !== null; node = node.parent)
        if (!node.visible) visible = false;
      const draws =
        visible &&
        sphere.radius * 2 >= (caster.casterMinDiameter ?? 0) &&
        (!source.frustumCulled || frustum.intersectsObject(source));
      const next = draws ? 1 : 0;
      if (selected[part] !== next) changed = true;
      selected[part] = next;
      if (draws) count += geometry.groups[part]?.count ?? 0;
    }
    if (changed) {
      let at = 0;
      for (let part = 0; part < sources.length; part += 1) {
        const range = geometry.groups[part];
        if (selected[part] !== 1 || range === undefined) continue;
        (index.array as Uint32Array).set(
          complete.subarray(range.start, range.start + range.count),
          at,
        );
        at += range.count;
      }
      index.needsUpdate = true;
    }
    level.geometry.setDrawRange(0, count);
  };
}

/**
 * One chunk's static meshes merged by material, in place, before the chunk is added.
 *
 * A hand-placed chunk is a bridge or a yard, not a prop: its mesh nodes are packed a few dozen to a
 * few hundred per file over a handful of materials, and each one is its own draw — in the main pass
 * and again in every shadow level that redraws it. Merging by material is what the cook already did
 * for repeated meshes (hence the `InstancedMesh`es in a loaded chunk), so this is the same fix one
 * step further out: one draw per material per chunk instead of one per node.
 *
 * Nothing here decides how anything looks. The merged mesh draws the game's own material and holds
 * the geometry exactly as authored, baked into the chunk root's space; what changes is how many
 * calls it takes to draw. `mergeByMaterial` does the bake and owns the refusals, so a group it
 * cannot merge (a material whose meshes disagree about `uv`) leaves the whole chunk as it was and is
 * counted as a failure — a chunk never disappears over a draw-call saving.
 *
 * Left alone: a skinned mesh (posed per frame), one carrying morph targets (the bake drops them), a
 * multi-material mesh (one draw per material already), and anything carrying a baked AutoLOD chain,
 * whose own `ModelLod` swaps its geometry and would be swapped for nothing. No chunk node is
 * animation-targeted: the chunk path takes `gltf.scene` and never a clip list.
 *
 * `disposeSources` says who owns the shapes the bake consumed. The merged buffers are the chunk's
 * own and are released with it on eviction; a shape nothing draws any more is released here, unless
 * the loader cache still holds it — `createAssetLoader` keys models by path and hands the same scene
 * back on the next load, so a cached shape is not this world's to tear down. A geometry a kept mesh
 * still draws is never released either way.
 *
 * `castShadow` says the chunk's shadow bill exists at all — the same answer the caller hands the
 * chunk's nodes — and only then is it worth one position-only proxy per `side`. See
 * `buildChunkShadowProxies`, which draws every side of every chunk with the world's one material for
 * that side.
 *
 * @returns what the merge did, or `undefined` when the bake refused the whole chunk.
 */
function mergeChunk(
  chunk: Object3D,
  maxTriangles: number,
  disposeSources: boolean,
  castShadow: boolean,
  proxyMaterials: Map<number, Material>,
): IChunkMerge | undefined {
  chunk.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  const skipped = new Set<Mesh>();
  let instanced = 0;
  chunk.traverse((object) => {
    const mesh = object as Mesh & { isInstancedMesh?: boolean };
    if (mesh.isMesh !== true) return;
    meshes.push(mesh);
    // A chain is baked into the geometry the mesh draws, so a merged buffer would carry a `ModelLod`
    // that has nothing to swap: the mesh keeps its own geometry and its own level selection.
    if (lodChainOf(mesh.geometry) !== undefined) {
      skipped.add(mesh);
      return;
    }
    if (Object.keys(mesh.geometry.morphAttributes).length > 0) {
      skipped.add(mesh);
      return;
    }
    if (mesh.isInstancedMesh === true) instanced += 1;
  });
  const before = meshes.length;
  let result: Mesh[];
  try {
    result = mergeByMaterial(chunk, {
      expandInstancedUnderTriangles: maxTriangles,
      label: `world chunk ${chunk.name}`,
      maxGroupVertices: CHUNK_MERGE_MAX_VERTICES,
      skip: (mesh) => skipped.has(mesh),
    });
  } catch {
    return undefined;
  }
  const kept = new Set(skipped);
  let keptInstanced = 0;
  for (const mesh of result) {
    if ((mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh !== true) continue;
    kept.add(mesh);
    keptInstanced += 1;
  }
  const held = new Set<BufferGeometry>();
  for (const mesh of kept) held.add(mesh.geometry);
  let failed = 0;
  // Only what the bake consumed leaves its place; a kept mesh draws the same either way, so it is
  // not re-parented and the chunk's authored hierarchy survives around the merged groups.
  for (const mesh of meshes) {
    if (kept.has(mesh)) continue;
    if (disposeSources && !held.has(mesh.geometry) && release(mesh.geometry)) failed += 1;
    mesh.removeFromParent();
  }
  for (const mesh of result)
    if (!(mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh === true) chunk.add(mesh);
  // Only what the bake produced is covered: a kept mesh was never merged, so it still holds its own
  // per-material draw and its own materials the proxy knows nothing about.
  const shadow = castShadow
    ? buildChunkShadowProxies(
        chunk,
        result.filter((mesh) => !kept.has(mesh)),
        `world chunk ${chunk.name}`,
        proxyMaterials,
      )
    : undefined;
  // AutoLOD and morphs remain their own draws. Only unmodified static instance silhouettes qualify.
  const toRoot = chunk.matrixWorld.clone().invert();
  const retained = castShadow
    ? buildChunkShadowProxies(
        chunk,
        [...kept].filter(
          (mesh) =>
            mesh instanceof InstancedMesh &&
            mesh.count > 0 &&
            mesh.layers.isEnabled(0) &&
            lodChainOf(mesh.geometry) === undefined &&
            Object.keys(mesh.geometry.morphAttributes).length === 0 &&
            mesh.morphTexture === null &&
            mesh.customDepthMaterial === undefined &&
            mesh.customDistanceMaterial === undefined &&
            mesh.onBeforeRender === Object3D.prototype.onBeforeRender &&
            !Array.isArray(mesh.material) &&
            !displacesVertices(mesh.material) &&
            mesh.material.visible &&
            mesh.material.allowOverride &&
            mesh.material.onBeforeCompile === Material.prototype.onBeforeCompile &&
            Reflect.get(mesh.material, "isShaderMaterial") !== true &&
            mesh.material.shadowSide === null &&
            (mesh.material.clippingPlanes?.length ?? 0) === 0 &&
            Reflect.get(mesh.material, "vertexNode") == null &&
            Reflect.get(mesh.material, "depthNode") == null &&
            Reflect.get(mesh.material, "castShadowNode") == null &&
            Reflect.get(mesh.material, "wireframe") !== true &&
            Reflect.get(mesh.geometry, "indirect") == null &&
            Reflect.get(mesh, "casterInstanceScale") == null &&
            new Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld).determinant() >= 0,
        ),
        `world chunk ${chunk.name} retained`,
        proxyMaterials,
        true,
      )
    : undefined;
  return {
    bytes: mergedBytes(result, kept),
    draws: meshesOf(chunk),
    expanded: instanced - keptInstanced,
    failed,
    keptInstanced,
    meshes: before,
    shadowCovered: [...(shadow?.covered ?? []), ...(retained?.covered ?? [])],
    shadowDraws: (shadow?.proxies.length ?? 0) + (retained?.proxies.length ?? 0),
  };
}

/**
 * Bytes the bake's own meshes hold, indices included: the upload their first draw would have paid.
 * A kept mesh is not one of them — it was never merged, and it draws the same either way.
 */
function mergedBytes(merged: readonly Mesh[], kept: ReadonlySet<Mesh>): number {
  let bytes = 0;
  for (const mesh of merged) {
    if (kept.has(mesh)) continue;
    for (const attribute of Object.values(mesh.geometry.attributes))
      bytes += attribute.array.byteLength;
    const index = mesh.geometry.getIndex();
    if (index !== null) bytes += index.array.byteLength;
  }
  return bytes;
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

/**
 * The value `NodeUpdateType.RENDER` has, read as text so this file needs no import for it: a node
 * whose `updateBefore` runs on every render is a node whose work happens inside the draw that
 * recorded it, which is the whole test.
 */
const PER_RENDER_UPDATE = "render";

/**
 * Whether a node graph copies or renders the framebuffer, which a bundle encoder cannot be asked for.
 *
 * Every such node does its work in `updateBefore` and every one of them touches the *current* render
 * pass: `ViewportTextureNode` copies the bound framebuffer into a texture, and transmission, an
 * `RTTNode`, a `ReflectorNode` or a `PassNode` renders into one. Recorded into a bundle, the current
 * pass is a `GPURenderBundleEncoder`, which has no `end()` to close and no framebuffer to read, so
 * the call throws `currentPass.end is not a function` from inside the record and takes the whole
 * bundle's frame with it.
 *
 * Structural, over own properties and plain sub-objects, because a material's slots are node graphs
 * rather than one node: a `viewportSharedTexture()` under an arithmetic chain is still this. What it
 * cannot see is a node hidden inside an `Fn` body, which is how three keeps its own transmission
 * sampler — hence `transmission` is asked of the material itself as well.
 */
interface IBundleGraphSnapshot {
  readonly node: object;
  readonly keys: readonly string[];
  readonly links: readonly unknown[];
  readonly isNode: unknown;
  readonly beforeType: unknown;
  readonly before: string;
  readonly version: unknown;
  readonly terminal: boolean;
  readonly childReader: unknown;
  readonly children: readonly object[] | undefined;
}
interface IBundleGraphCapture {
  readonly rows: IBundleGraphSnapshot[];
  links: number;
  overflow: boolean;
}
interface IBundleMaterialCheck {
  readonly safe: boolean;
  readonly revision: number;
  readonly version: number;
  readonly transparent: boolean;
  readonly visible: boolean;
  readonly transmission: unknown;
  readonly rows: readonly IBundleGraphSnapshot[];
}

/** Own-link and installed-Node child snapshots avoid inherited TSL method scans. Deep unversioned
 * edits still invalidate: version/root identity alone cannot certify a mutable node graph. A large
 * graph uses the uncached safety walk, and conservatively rerecords rather than reusing a verdict. */
class BundleSurfaceSafety {
  #checks = new WeakMap<Material, IBundleMaterialCheck>();
  #revision = 0;
  readonly stats = { checks: 0, refreshes: 0, validations: 0, uncached: 0 };

  clear(): void {
    this.#checks = new WeakMap();
  }

  test(material: Material): IBundleMaterialCheck {
    this.stats.checks++;
    const previous = this.#checks.get(material);
    if (
      previous !== undefined &&
      previous.version === material.version &&
      previous.transparent === material.transparent &&
      previous.visible === material.visible &&
      previous.transmission === Reflect.get(material, "transmission") &&
      previous.rows.every(graphSnapshotCurrent)
    ) {
      this.stats.validations++;
      return previous;
    }
    this.stats.refreshes++;
    const capture: IBundleGraphCapture = { rows: [], links: 0, overflow: false };
    const checked: IBundleMaterialCheck = {
      safe: bundleSafeMaterial(material, capture),
      revision: ++this.#revision,
      version: material.version,
      transparent: material.transparent,
      visible: material.visible,
      transmission: Reflect.get(material, "transmission"),
      rows: capture.rows,
    };
    if (capture.overflow) {
      this.stats.uncached++;
      this.#checks.delete(material);
    } else this.#checks.set(material, checked);
    return checked;
  }
}

function graphSnapshotCurrent(row: IBundleGraphSnapshot): boolean {
  const node = row.node;
  const before = typeof Reflect.get(node, "updateBefore");
  if (
    Reflect.get(node, "isNode") !== row.isNode ||
    Reflect.get(node, "updateBeforeType") !== row.beforeType ||
    before !== row.before ||
    Reflect.get(node, "version") !== row.version
  )
    return false;
  if (row.terminal) return true; // Still a framebuffer reader, whatever its other children do.
  // TSL prototypes carry thousands of enumerable chaining methods, which are not child links.
  // Own slots stay cheap; Three's actual child reader witnesses inherited container links below.
  const keys = bundleGraphKeys(node);
  if (keys.length !== row.keys.length) return false;
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index] as string;
    if (row.keys[index] !== key) return false;
    const value = Reflect.get(node, key);
    if ((value !== null && typeof value === "object" ? value : undefined) !== row.links[index])
      return false;
  }
  const reader = bundleGraphChildReader(node);
  if (reader !== row.childReader) return false;
  const children = readBundleGraphChildren(node, reader);
  return (
    children !== undefined &&
    row.children !== undefined &&
    children.length === row.children.length &&
    children.every((child, index) => child === row.children?.[index])
  );
}

/** Three reads non-enumerable own Node/Material slots, but never inherited TSL chain methods. */
function bundleGraphKeys(node: object): string[] {
  return Reflect.get(node, "isNode") === true || Reflect.get(node, "isMaterial") === true
    ? Object.getOwnPropertyNames(node)
    : Object.keys(node);
}
function bundleGraphChildReader(node: object): unknown {
  return Reflect.get(node, "isNode") === true ? Reflect.get(node, "getChildren") : undefined;
}
function readBundleGraphChildren(node: object, reader: unknown): readonly object[] | undefined {
  if (reader === undefined) return [];
  if (typeof reader !== "function") return undefined;
  try {
    const result: unknown = reader.call(node);
    if (
      result === null ||
      typeof result !== "object" ||
      typeof Reflect.get(result, Symbol.iterator) !== "function"
    )
      return undefined;
    const children: object[] = [];
    for (const child of result as Iterable<unknown>) {
      if (
        children.length >= 8192 ||
        child === null ||
        typeof child !== "object" ||
        Reflect.get(child, "isNode") !== true
      )
        return undefined;
      children.push(child);
    }
    return children;
  } catch {
    return undefined;
  }
}
function captureBundleGraph(
  node: object,
  terminal: boolean,
  capture: IBundleGraphCapture,
  childReader: unknown,
  children: readonly object[] | undefined,
): readonly unknown[] {
  const entries = terminal
    ? []
    : bundleGraphKeys(node).map((key) => [key, Reflect.get(node, key)] as const);
  capture.links += entries.length + (children?.length ?? 0);
  if (children === undefined) capture.overflow = true;
  if (capture.rows.length >= 1024 || capture.links > 8192) capture.overflow = true;
  if (!capture.overflow)
    capture.rows.push({
      node,
      terminal,
      childReader,
      children,
      keys: entries.map(([key]) => key),
      links: entries.map(([, value]) =>
        value !== null && typeof value === "object" ? value : undefined,
      ),
      isNode: Reflect.get(node, "isNode"),
      beforeType: Reflect.get(node, "updateBeforeType"),
      before: typeof Reflect.get(node, "updateBefore"),
      version: Reflect.get(node, "version"),
    });
  return entries.map(([, value]) => value);
}

function samplesFramebuffer(
  node: unknown,
  seen: Set<unknown>,
  capture?: IBundleGraphCapture,
): boolean {
  // Pixels and vertex data hold no node, and Object.values would copy every element of them.
  if (node === null || typeof node !== "object" || ArrayBuffer.isView(node) || seen.has(node))
    return false;
  seen.add(node);
  const candidate = node as {
    readonly isNode?: boolean;
    readonly updateBefore?: unknown;
    readonly updateBeforeType?: unknown;
  };
  if (
    candidate.isNode === true &&
    typeof candidate.updateBefore === "function" &&
    candidate.updateBeforeType === PER_RENDER_UPDATE
  ) {
    if (capture !== undefined) captureBundleGraph(node, true, capture, undefined, []);
    return true;
  }
  // getChildren owns Three's non-enumerable, dictionary and sparse-array child semantics. Its
  // ordered identities are a live witness, including prototype edits with unchanged own keys.
  const reader = bundleGraphChildReader(node);
  const children = readBundleGraphChildren(node, reader);
  const values =
    capture === undefined
      ? bundleGraphKeys(node).map((key) => Reflect.get(node, key))
      : captureBundleGraph(node, false, capture, reader, children);
  // Malformed/oversized child output retains the live source path. The stored witness is capped;
  // Three's eager getChildren implementation can still scan an authored array before yielding.
  if (children === undefined) return true;
  for (const value of [...values, ...children]) {
    if (value === null || typeof value !== "object") continue;
    if (samplesFramebuffer(value, seen, capture)) return true;
  }
  return false;
}

/**
 * Whether one mesh's draw can be recorded into a bundle and replayed from it.
 *
 * A bundle is an encoder, not a render pass: three fixes its render list and its draw order when it
 * records it, and every replay runs the encoded commands with no pass of its own to ask anything of.
 * So a mesh is bundle-safe only when nothing about its draw needs a live pass — the one question
 * {@link samplesFramebuffer} and the checks below both ask, of the node graph and of the object.
 *
 * - **The framebuffer.** A viewport or screen-space refraction sample, transmission, a render target,
 *   a reflector: `samplesFramebuffer`, plus `transmission` itself, which three's own lighting model
 *   reaches through an `Fn` body no structural walk can see.
 * - **Per-frame order.** A transparent mesh is sorted against its neighbours every frame; a record
 *   froze that order when it was made, so a bundled one draws in the order it happened to be in.
 * - **Per-object hooks.** `onBeforeRender`/`onAfterRender` are the two places a game reads the camera
 *   and the frame for a draw, and a replay runs them once at record time and never again. The
 *   engine's own borrow — the prewarm counting its batch's first submitted draw — is bookkeeping
 *   about the draw rather than a claim on the object, so it does not refuse; `isEngineRenderHook` is
 *   what tells them apart, the same answer `projection-plan.ts` gives.
 * - **Per-frame vertices.** A skinned or morphed mesh's positions are posed per frame from bones the
 *   record never reads, so its encoded vertices are its rest pose forever.
 *
 * A mesh that fails this stays on the per-object path — the path every chunk drew before bundles
 * existed — so a refusal costs the draw it was already paying and nothing else.
 */
function bundleSafe(mesh: Mesh): boolean {
  if (ownHook(mesh, "onBeforeRender")) return false;
  if (ownHook(mesh, "onAfterRender")) return false;
  if ((mesh as Mesh & { readonly isSkinnedMesh?: boolean }).isSkinnedMesh === true) return false;
  if (mesh.morphTargetInfluences !== undefined) return false;
  return (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every((material) =>
    bundleSafeMaterial(material),
  );
}

/**
 * Whether this mesh carries a render hook of its own that is the game's, which a record freezes.
 *
 * `Object.hasOwn`, not the prototype comparison: the engine installs its own hook as an own property
 * on the very batches a prewarm borrowed, and refusing those would keep every batch of a streamed
 * world on the per-object path.
 */
function ownHook(mesh: Mesh, name: "onAfterRender" | "onBeforeRender"): boolean {
  return Object.hasOwn(mesh, name) && isEngineRenderHook(mesh[name]) === false;
}

/** The material half of {@link bundleSafe}: nothing it draws may need a pass it was recorded in. */
export function bundleSafeMaterial(
  material: Material | undefined,
  capture?: IBundleGraphCapture,
): boolean {
  if (material === undefined) return true;
  if (material.transparent === true) return false;
  // Read structurally: a `MeshPhysicalMaterial` always has the number and nothing else does, and
  // three's transmission sampler is not a node slot, so `transmission` is the only way to see it.
  const transmission = Reflect.get(material, "transmission");
  if (typeof transmission === "number" && transmission > 0) return false;
  return samplesFramebuffer(material, new Set(), capture) === false;
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
 * The distance a `maxDistance` prop actually culls at, one eighth short of itself: the slack
 * `#addPlacements` leaves, so a follow point that has not moved a whole eighth of the cull distance
 * cannot have culled a placement it had not already culled.
 */
function cullDistance(maxDistance: number | undefined): number | undefined {
  return maxDistance === undefined ? undefined : maxDistance - maxDistance / 8;
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

/** Triangles one geometry submits; the count the `TN_WORLD_LOD_CHAIN` marker reports per level. */
function levelTriangles(geometry: BufferGeometry): number {
  const drawn = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
  return Math.floor(drawn / 3);
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

/** The one test that separates an alpha-cutout foliage part from an opaque one: MASK or BLEND. */
function isAlphaFoliage(material: Material): boolean {
  return material.transparent || material.alphaTest > 0;
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

/** The bake's view of one asset level: each part's geometry, transform and surface, by reference. */
function impostorParts(parts: readonly IAssetPart[]): IImpostorPart[] {
  const staged: IImpostorPart[] = [];
  for (const part of parts)
    staged.push({ geometry: part.geometry, local: part.local, material: part.material });
  return staged;
}

/**
 * Model loads in flight for a streamed world. `loadAll`'s six suits a scene's one-off load; a
 * world crossing new asset types as it moves spends most of each load waiting on the network and
 * the transcoder workers, so more in flight keeps the ring ahead of a fast camera.
 */
const WORLD_LOAD_CONCURRENCY = 12;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new Error(`WorldCells ${name} must be a positive integer.`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`WorldCells ${name} must be a non-negative integer.`);
  return value;
}

/** A metre threshold, unlike the counts above: 1.5 m is the whole point of the option. */
function positiveMetres(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`WorldCells ${name} must be a finite number greater than 0.`);
  return value;
}

/**
 * The admission budget: a positive number of milliseconds, or `Infinity` for no ceiling at all —
 * which is what a game that wants one `update` to admit everything it can asks for. Zero is refused
 * rather than obeyed, because a world whose budget is spent before it starts never streams at all,
 * and that is never what anyone meant to write.
 */
function admissionBudgetMs(value: number): number {
  if (Number.isNaN(value) || value <= 0)
    throw new Error("WorldCells admissionBudgetMs must be a positive number of milliseconds.");
  return value;
}

function cellKey(x: number, z: number): string {
  return `${String(x)}:${String(z)}`;
}

interface IQueuedModelLoad {
  readonly run: () => Promise<Object3D>;
  readonly wanted: () => boolean;
  readonly resolve: (model: Object3D | undefined) => void;
  readonly reject: (error: unknown) => void;
}

/**
 * One bounded lane for every model load a `WorldCells` starts. Assets and chunks share it, so the
 * number of `loadModel` calls in flight at once cannot grow with the number of admitted cells.
 * Queued loads keep admission order, which is nearest-cell first, and one whose cell left (or
 * whose asset was released) before its turn resolves `undefined` without touching the loader.
 */
class ModelLoadLimiter {
  readonly #concurrency: number;
  readonly #queue: IQueuedModelLoad[] = [];
  #inFlight = 0;

  constructor(concurrency: number) {
    this.#concurrency = concurrency;
  }

  get inFlight(): number {
    return this.#inFlight;
  }

  get queued(): number {
    return this.#queue.length;
  }

  load(run: () => Promise<Object3D>, wanted: () => boolean): Promise<Object3D | undefined> {
    return new Promise((resolve, reject) => {
      this.#queue.push({ reject, resolve, run, wanted });
      this.#pump();
    });
  }

  #pump(): void {
    while (this.#inFlight < this.#concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift() as IQueuedModelLoad;
      if (!job.wanted()) {
        job.resolve(undefined);
        continue;
      }
      this.#inFlight += 1;
      try {
        job.run().then(
          (model) => {
            this.#inFlight -= 1;
            job.resolve(model);
            this.#pump();
          },
          (error: unknown) => {
            this.#inFlight -= 1;
            job.reject(error);
            this.#pump();
          },
        );
      } catch (error) {
        // A loader that throws instead of rejecting must not strand its lane.
        this.#inFlight -= 1;
        job.reject(error);
        this.#pump();
      }
    }
  }
}

/**
 * One frame's admission allowance, shared by every path that puts streamed content on screen.
 *
 * A streaming world has no frame-time ceiling anywhere else: a cell row arriving builds a batch per
 * asset run over every placement in it, a terrain tile builds every LOD level, and the game's
 * `createCollider` runs for every resident tile — all in the one frame that discovers them. That is
 * the 100-330 ms hitch a 60 m/s camera feels every time the ring moves, and it is admission cost,
 * not streaming: the loads never fail.
 *
 * The budget is opened once per `update` and drawn down by the units it admits. A unit always
 * finishes, so a frame spends at most the limit plus the unit that crossed it, and the rest of the
 * backlog waits for the next frame rather than being dropped.
 */
class AdmissionBudget implements IAdmissionBudget {
  readonly #limitMs: number;
  readonly #now: () => number;
  #spentMs = 0;

  constructor(limitMs: number, now: () => number) {
    this.#limitMs = limitMs;
    this.#now = now;
  }

  get spentMs(): number {
    return this.#spentMs;
  }

  admit(work: () => void): boolean {
    if (this.#spentMs >= this.#limitMs) return false;
    const startedAt = this.#now();
    work();
    this.#spentMs += this.#now() - startedAt;
    return true;
  }
}

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
  readonly #hlod: boolean;
  readonly #cellProxies = new Set<ICellProxyState>();
  #hlodBytes = 0;
  #hlodRefused = 0;
  #hlodFailures = 0;
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
   * Every `asset:level:part` of a loaded asset is minted empty, before any placement wants it, so
   * the node build lands in the loading phase instead of the frame a cell row first draws the key.
   * `#prewarmQueue` is the keys still to mint, `#prewarmKeys` the ones queued (a retried load must
   * not queue the same key twice), and `#prewarmPending` the ones minted but not yet
   * `PREWARM_WARM_UPDATES` updates old. `prewarmed` is the game's gate for "safe to show me this
   * world"; `stats().pendingPrewarm` is the same thing as a number.
   */
  readonly #prewarmQueue: IPrewarmEntry[] = [];
  readonly #prewarmKeys = new Set<string>();
  #prewarmPending = 0;
  /** Every mint so far, so a loading bar can read minted / (minted + pending). */
  #prewarmMinted = 0;
  /**
   * Minted meshes whose first draw has been submitted, and the meshes still owed one. A mint is
   * only half the work: the node is built when the mesh is first submitted, and that is the frame
   * the loading bar used to sit still for. `pendingPrewarm` reports this pair, so the bar counts the
   * draw half instead of jumping from minting straight to done. The gate is a promise about batches
   * (`#prewarmPending`), never about these: a companion no shadow level covers is owed a draw
   * forever, and the gate must not wait on it.
   */
  #prewarmOwed = 0;
  #prewarmDrawn = 0;
  #prewarmEpoch = 0;
  #prewarmWait = 0;
  /**
   * Awaited meshes that only a shadow level can draw, and the share of them that have had one.
   *
   * A caster's node is built in the shadow context, so a walk-time first shadow draw of a streamed
   * key is a `NodeBuilder.build` inside a shadow pass — a third of the shadow lane's CPU on the
   * 2 km walk. Counting them separately is what `TN_WORLD_PREWARM`'s `shadowPrewarmed` reports and
   * what the gate waits on; a count of "every batch drew once" cannot tell the two apart.
   */
  #prewarmCasterMinted = 0;
  #prewarmCasterOwed = 0;
  #prewarmCasterDrawn = 0;
  /**
   * Meshes still carrying a prewarm borrow, with the hook each one has to be handed back, the batch
   * holding it visible, and the post-settle updates it has waited; see
   * {@link #releaseImpossibleBorrows}.
   */
  readonly #awaited = new Map<
    InstancedMesh,
    {
      batch: SharedBatch;
      borrow: unknown;
      own: unknown;
      hadOwn: boolean;
      waited: number;
      epoch: number;
    }
  >();
  #prewarmSettled = false;
  #prewarmResolve: () => void = () => {
    // replaced in the field initialiser below, once `this` exists
  };
  readonly #prewarmed: Promise<void> = new Promise<void>((resolve) => {
    this.#prewarmResolve = resolve;
  });
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
   * Per-side surfaces shared world-wide, separately for merged and retained proxies. See
   * `worldOwned`: a chunk teardown must not release another chunk's shadow surface.
   */
  readonly #proxyMaterials = new Map<number, Material>();
  /**
   * The renderer and camera of the last frame that ran, kept so a chunk streamed in between frames
   * can be compiled before it is attached. `update(renderer, camera)` is the only place either is
   * known, and the admission that loads a chunk is not a place that has them.
   */
  #renderer: IRendererLike | undefined;
  #camera: Camera | undefined;
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
  /** Whether alpha-foliage assets append a baked whole-asset terminal level; see the option. */
  readonly #impostors: boolean;
  /** The baker one view per render-cadence update; see `#stepImpostor`. */
  readonly #baker = new WorldImpostorBaker();
  /** Assets whose bake is queued, in adoption order; `#impostorQueued` is the same set by id. */
  readonly #impostorQueue: IAssetState[] = [];
  readonly #impostorQueued = new Set<string>();
  /** The asset whose bake holds the baker right now, if any. */
  #impostorBaking: IAssetState | undefined;
  /**
   * Completed atlases by content key. An atlas a live asset draws from is active and never evicted;
   * one with no user is kept for a later reference until the byte budget needs the room.
   */
  readonly #impostorRecords = new Map<string, IImpostorRecord>();
  #impostorRecordBytes = 0;
  /** The declared bytes of the one bake in flight, held against the budget before `begin`. */
  #impostorReservedBytes = 0;
  readonly #impostorBudgetBytes: number;
  /** Assets whose `TN_WORLD_IMPOSTOR` line has printed, so the marker is one per asset. */
  readonly #impostorReported = new Set<string>();
  /**
   * Assets whose pre-bake wide segments are still waiting for a block in the one whole-asset mesh,
   * because the frame that handed the bake over had spent its fresh-mesh allowance. Retried on the
   * next update rather than left with no far shadow.
   */
  readonly #wideRetry = new Set<string>();
  /**
   * The whole-map far aggregates, one per exact atlas cache key, and the `run -> aggregate` index a
   * near-ready handoff and an eviction read to toggle a run's far segment without asking the asset.
   *
   * `#farInstances` and `#farBytes` are the physical allocations those meshes hold, charged against
   * the world's own instance and byte budgets beside the near ring's records.
   */
  readonly #far = new Map<string, IFarAggregate>();
  readonly #farSegments = new Map<IWorldRun, IFarAggregate>();
  #farInstances = 0;
  #farBytes = 0;
  /** Atlas keys whose `TN_WORLD_IMPOSTOR_FAR` line has printed, so the marker is one per aggregate. */
  readonly #farReported = new Set<string>();
  /**
   * Cohorts whose far aggregate a full budget refused, as metadata plus a built surface and never
   * the source GLB. Retried when a near cell releases its allocation — an event, not a per-frame
   * scan — so a walk away from the ring makes room and the refused species appears without holding
   * a full model alive; see {@link IFarRetryEntry}, `#retryFar` and `#deferFar`.
   */
  readonly #farRetry = new Map<string, IFarRetryEntry>();
  /**
   * Canonical asset ids placed anywhere in the map, adopted on idle frames so a species that never
   * enters the near ring still bakes its atlas and appears on the far mesh. Enumerated once from the
   * static placements; see `#pumpFarAcquisition`.
   */
  readonly #farCandidateIds: readonly string[];
  /** The rotating cursor over `#farCandidateIds`, so the map is walked a bounded step per idle frame. */
  #farCursor = 0;
  /** Canonical ids whose far handling has settled: baked and built, or classified with no atlas. */
  readonly #farSeen = new Set<string>();
  /** Canonical ids acquired for the far half alone, held until their aggregate lands or is refused. */
  readonly #farTemp = new Set<string>();
  /** Every candidate is settled, so the idle pump can stop scanning the map; see `#pumpFarAcquisition`. */
  #farExhausted = false;

  private constructor(init: IWorldCellsInit) {
    super();
    this.#budgets = {
      bytes: positiveInteger(init.budgets.bytes, "budgets.bytes"),
      instances: positiveInteger(init.budgets.instances, "budgets.instances"),
      residentCells: positiveInteger(init.budgets.residentCells, "budgets.residentCells"),
    };
    this.#ring = nonNegativeInteger(init.ring, "ring");
    this.#hlod = init.hlod !== false;
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
    this.#farCandidateIds = [...candidates];
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
    this.#impostors = init.impostors ?? false;
    this.#impostorBudgetBytes = DEFAULT_IMPOSTOR_ATLAS_BUDGET_BYTES;
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
    return this.#prewarmed;
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
    if (renderer !== undefined) this.#renderer = renderer;
    if (camera !== undefined) this.#camera = camera;
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
      this.#gpuScene.announce(this.#renderer as IRendererLike, this.#gpuCensus());
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
    this.#drainPrewarm();
    // One bake view per render update, after the prewarm so its own atlas allocation never delays a
    // node build the walk is waiting on, and before the levels are told so a level the bake just
    // appended is in this frame's window.
    this.#stepImpostor(renderer);
    // After the bake handoff, so a wide block it deferred to this frame's exhausted allowance is
    // claimed now; a no-op on every frame with nothing waiting.
    this.#retryWide();
    // After the near work, so a species no resident run has asked for still bakes and reaches the
    // far mesh without the camera ever traversing its cell. Bounded to one asset per idle frame.
    this.#pumpFarAcquisition();
    // After the drain, so the levels are told about this update's records and not the last one's.
    this.#tellShadows();
    // After the drain too, so a record admitted this update is in the window the camera draws and
    // not one frame behind it.
    for (const state of this.#cellProxies) this.#restoreCellProxySource(state);
    this.#cullMainPass(camera);
    // With it, because it reads the drain's own answer: a caster whose main counterpart is not
    // drawable this frame must not cast before the levels render this frame's maps.
    this.#publishCasterAdmission();
    // After main publication/culling: an exclusive source key stays fully resident, so returning
    // near detail never waits for admission or an instance allocation. Proxy loads/staging alone
    // consume admission units; the synchronous visibility commit always protects the current view.
    this.#stepCellProxies(props, renderer, camera);
    this.#reportMainCull();
    this.#admission = {
      backlog: this.#backlog(),
      deferred: this.#jobs.length,
      spentMs: budget.spentMs + props.spentMs,
    };
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
    if (gpu.on) gpu.dispatch(this.#renderer as IRendererLike, camera);
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
      this.#prewarmQueue.length > 0 ||
      this.#prewarmPending > 0 ||
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
   * Mint this update's prewarm allowance, then settle the readiness signal.
   *
   * A batch minted while the world is not in a scene is projected by nothing and builds nothing, so
   * the ready count only advances on an update that had somewhere to draw: a `load()` loop filling
   * the ring mints the whole ring and still leaves the gate shut, which is the honest answer.
   */
  #drainPrewarm(): void {
    if (this.#released) return;
    // The loading rate drops to the same 2-per-update a fresh mesh costs once the loading screen is
    // gone. 8 per update is ~150 ms of node builds on the frame that pays it, and the loading
    // screen is the only thing that was covering it: a walk that streams a new asset in afterwards
    // used to hand that frame's builds to a frame that is trying to hold its rate.
    const perUpdate = this.#prewarmSettled ? 2 : PREWARM_PER_UPDATE;
    let minted = 0;
    while (minted < perUpdate && this.#prewarmQueue.length > 0) {
      const entry = this.#prewarmQueue.shift() as IPrewarmEntry;
      this.#prewarmKeys.delete(entry.key);
      this.#mintPrewarm(entry);
      minted += 1;
    }
    // A minted batch is only *owed* a draw by `#awaitDraw`; nothing made anything draw it. A main
    // batch is drawn by the next main render, but a caster is drawn by a shadow level, and the
    // levels render when their window moves or something invalidates them — on a loading screen the
    // follow point stands still, so every caster minted after the first frame sat in the graph with
    // a node no level had ever asked for and the walk's first window move built all of them in one
    // shadow pass. Invalidating while the gate is open, minting or not, is what makes the prewarm
    // prewarm: the build is paid by the loading screen, which is the only frame rate hiding it.
    if (minted > 0) this.#prewarmWait = 0;
    // A caster's draw is a shadow level's, and the levels render at most one per frame, so the gate
    // keeps asking them to while one is owed — bounded, because a borrow nothing draws is handed
    // back by `#releaseImpossibleBorrows` below and a world that never draws one settles anyway.
    const waitingOnCasters = this.parent !== null && this.#prewarmCasterOwed > 0;
    if (minted > 0 || waitingOnCasters) this.#invalidateShadows?.();
    else if (this.parent !== null) this.#prewarmWait += 1;
    this.#releaseImpossibleBorrows();
    if (this.#prewarmQueue.length > 0 || this.#prewarmPending <= 0) return;
    if (this.#prewarmWait < PREWARM_WARM_UPDATES) return;
    // A caster still owed a draw is a build the walk would otherwise pay inside a shadow pass, so the
    // gate holds for it until its borrow is handed back, which is the bound.
    if (waitingOnCasters) return;
    // A build still owed draws nothing until it lands. When the scene comes up over a ring built
    // without it, that is the whole ring re-seeded: the gate settled over 1,378 owed builds and a
    // third of Machinefall's forest arrived in the first 4 s of play (PRD-478). The loading screen
    // covers them instead.
    if (this.#backlog() > 0) return;
    this.#prewarmPending = 0;
    // The gate is settled, so nothing is owed a draw. A companion no shadow level covers leaves its
    // pair non-zero, and `pendingPrewarm` is documented `0` from here on.
    this.#prewarmOwed = 0;
    this.#prewarmDrawn = 0;
    // Retained first-draw hooks belong to the counters just cleared, not later streamed work.
    this.#prewarmEpoch += 1;
    this.#prewarmWait = 0;
    this.#settlePrewarm();
  }

  /**
   * The empty batch for one prewarmed key, built exactly as `#batchFor` builds the real one so a
   * placement that later wants it draws into this mesh and keeps the node three built for it. Both
   * halves of the split are queued: the main key, and the follow point's own caster cluster, which
   * is the one the first shadow level render asks for.
   */
  #mintPrewarm(entry: IPrewarmEntry): void {
    // A world whose shadow levels draw its keys mints no caster half: the two are the same
    // placements by two routes, and a level's map can only draw one of them, so a prewarmed half is
    // a build behind the gate that pays for nothing and an owed draw the gate waits on until it
    // gives up. Decided at the mint rather than at the queue, which is filled before the first
    // renderer hands the GPU scene over. The shadow keys are prewarmed where they are minted
    // instead; see `#shadowKeyFor`.
    if (entry.role !== "main" && this.#keysForShadow()) return;
    // A key the retained set is holding needs no prewarmed batch: `#batchFor` rebinds that mesh
    // when the walk comes back, and rebinding is the whole point of keeping it. The prewarm did not
    // ask, so it minted a second InstancedMesh for a key that already had one — a uuid three built a
    // node for twice, in the main pass and in every shadow pass, for the whole of a walk back.
    if (this.#released || this.#shared.has(entry.key) || this.#retired.has(entry.key)) return;
    const shared = new SharedBatch(
      entry.geometry,
      entry.material,
      this.#runMax.get(entry.asset) ?? 1,
      this.#budgets.residentCells + 1,
      entry.key,
      this.#extentBounds,
      entry.role,
    );
    shared.smallCaster = this.#smallCaster(entry.asset);
    this.#dressMesh(shared, entry.role === "main" && this.#receiveShadow);
    // Dressed here, before the walk that fills it: the prewarm is what mints every key of an asset
    // before its first placement is swapped, so this is where the whole gate table comes from.
    this.#adoptGpu(shared, entry.asset, entry.key, entry.level, entry.part);
    this.#shared.set(entry.key, shared);
    this.#attach(shared);
    this.#prewarmPending += 1;
    this.#prewarmMinted += 1;
    // Every role is owed a draw by `#awaitDraw` and is shown while empty until that draw is counted:
    // the node, the bindings and the pipeline are built by a submission, and one zero-count
    // submission per prewarmed batch is the price of having the walk never pay for it. A caster's
    // submission is a shadow level's, not the main pass's — which is why `#drainPrewarm` keeps the
    // levels rendering while one is owed, and why `VirtualShadowNode`'s `#probe` renders both caster
    // layers when it finds one. A caster that is not awaited here is built on the first shadow draw
    // of the walk, inside a shadow pass, which is the cost this prewarm exists to move.
    this.#awaitDraw(shared);
  }

  /** Count this batch's first submitted draw, once, then hand `onBeforeRender` back to whoever had it. */
  #awaitDraw(shared: SharedBatch): void {
    const mesh = shared.mesh;
    const caster = shared.role !== "main";
    this.#prewarmOwed += 1;
    if (caster) {
      this.#prewarmCasterMinted += 1;
      this.#prewarmCasterOwed += 1;
    }
    shared.awaitPrewarmDraw();
    // three's `Object3D` carries an inherited no-op, so reading `onBeforeRender` off a fresh mesh
    // hands back a function that was never an own property. Writing it back as one leaves every
    // batch that has drawn since looking permanently hooked, and the projection's `hasRenderHook`
    // reads own properties — so the borrow has to remember whether there was one to give back.
    const hadOwn = Object.hasOwn(mesh, "onBeforeRender");
    this.#borrowDraw(shared, mesh, hadOwn, hadOwn ? mesh.onBeforeRender : undefined);
  }

  /**
   * The borrow that counts `mesh`'s first submitted draw and then gives the mesh its own hook back,
   * keyed by the mesh object — so an object that is replaced has to be handed the borrow of the one
   * it replaces; see `#carryPrewarm`.
   */
  #borrowDraw(
    shared: SharedBatch,
    mesh: InstancedMesh,
    hadOwn: boolean,
    own: unknown,
    epoch = this.#prewarmEpoch,
  ): void {
    const caster = shared.role !== "main";
    const borrow = own as ((...args: unknown[]) => void) | undefined;
    const counted = (...args: unknown[]): void => {
      if (epoch === this.#prewarmEpoch) this.#prewarmDrawn += 1;
      if (caster) {
        this.#prewarmCasterOwed -= 1;
        this.#prewarmCasterDrawn += 1;
      }
      this.#handBack(mesh, hadOwn, own);
      this.#awaited.delete(mesh);
      // The node is built and the pipeline is compiled: the batch owes nothing more, so an empty one
      // goes back to hiding.
      shared.prewarmDrew();
      borrow?.(...args);
    };
    // Engine bookkeeping, not a claim on the mesh: the scene-render projection's `hasRenderHook`
    // ignores a marked borrow, so a streamed world's prewarmed batches stay eligible for the
    // collapse they exist to be folded into. Unmarked, 202 of them permanently declined it.
    markEngineRenderHook(counted);
    this.#awaited.set(mesh, { batch: shared, borrow: counted, own, hadOwn, waited: 0, epoch });
    mesh.onBeforeRender = counted as typeof mesh.onBeforeRender;
  }

  /**
   * Hand back the borrow of a mesh whose prewarm draw can never come, so no hook outlives the
   * prewarm it served.
   *
   * A mesh that is merely empty now draws — `visible` at count 0 is what builds its node and its
   * pipeline, and the borrow is counted off that one submission — so emptiness is no longer a
   * reason to release anything. What is left is a mesh nothing can draw, and which mesh that is
   * depends on the role: a main batch is drawn by the main pass, so a world projected by nothing
   * (`parent === null`, which is a `load()` loop's prewarm and settles the moment the world joins a
   * scene) still owes it one, while a *caster* is drawn by a shadow level, and a world nothing
   * projects has no level to draw it — its visible-at-count-0 exception is handed straight back
   * rather than held for the whole load. Otherwise a level is a frame's schedule away and the
   * borrow waits `PREWARM_RELEASE_UPDATES` updates for it. That is a ceiling rather than a
   * diagnosis — a projection that collapsed the world, a camera that never reached the mesh, a game
   * that passed no `shadows.invalidate` for the levels to be told by — and it is here so those
   * meshes neither hold a hook nor sit visible at count 0 for the whole walk.
   */
  #releaseImpossibleBorrows(): void {
    const projected = this.parent !== null;
    for (const [mesh, entry] of [...this.#awaited]) {
      entry.waited += 1;
      const caster = entry.batch.role !== "main";
      if (projected === true && entry.waited < PREWARM_RELEASE_UPDATES) continue;
      if (projected === false && caster === false) continue;
      if (mesh.onBeforeRender === entry.borrow) this.#handBack(mesh, entry.hadOwn, entry.own);
      this.#awaited.delete(mesh);
      if (caster) this.#prewarmCasterOwed -= 1;
      entry.batch.prewarmDrew();
    }
  }

  /** Give a borrowed mesh back the hook it had, or none at all when it never had one of its own. */
  #handBack(mesh: InstancedMesh, hadOwn: boolean, own: unknown): void {
    if (hadOwn) mesh.onBeforeRender = own as typeof mesh.onBeforeRender;
    // Deleted rather than assigned `undefined`: three calls `object.onBeforeRender(...)`
    // unconditionally, and an own `undefined` shadows the prototype's no-op and throws.
    // quality-allow: the hook must go back to the prototype, which only `delete` can restore.
    // biome-ignore lint/performance/noDelete: restoring the prototype lookup is the point.
    else delete (mesh as Partial<InstancedMesh>).onBeforeRender;
  }

  /**
   * Every level and every part of one asset, queued to be minted empty: the main key, and the one
   * caster cluster under the follow point. One square because a cluster per cell of the map would
   * be a prewarm of the whole package, and the squares a walk reaches first are minted by
   * residency, two an update.
   */
  #queuePrewarm(asset: IAssetState): void {
    const wideKey = `${asset.id}:*@${WIDE_CLUSTER}`;
    for (const [level, parts] of asset.levels.entries()) {
      for (const [part, entry] of parts.entries()) {
        const key = `${asset.id}:${String(level)}:${String(part)}`;
        for (const role of ["main", "cluster", "wide"] as const) {
          // Only a level that casts has a caster half at all; see `#casts`.
          if (role !== "main" && !this.#casts(level)) continue;
          // One whole-asset representation covers the far shadow; see `#wideOwed`.
          if (role === "wide" && !this.#wideOwed(asset.id, part)) continue;
          // A baked impostor's far half is one mesh per asset, not one per level; prewarm the mesh the
          // handoff will keep rather than a per-level key it would retire one frame later.
          const name =
            role === "main"
              ? key
              : role === "wide" && asset.impostor !== undefined
                ? wideKey
                : `${key}@${role === "cluster" ? this.#followCluster() : WIDE_CLUSTER}`;
          // A retained key is already paid for; see `#mintPrewarm`.
          if (this.#shared.has(name) || this.#retired.has(name) || this.#prewarmKeys.has(name))
            continue;
          // The wide half is prewarmed with the same shape the swap draws; see `#wideShape`.
          const shape = role === "wide" ? this.#wideShape(asset, level, part, entry) : entry;
          this.#prewarmKeys.add(name);
          this.#prewarmQueue.push({
            asset: asset.id,
            role,
            geometry: shape.geometry,
            key: name,
            level,
            material: shape.material,
            part,
          });
        }
      }
    }
  }

  #settlePrewarm(): void {
    if (this.#prewarmSettled) return;
    this.#prewarmSettled = true;
    // The one line a walk's log needs to say the prewarm paid what it exists to pay:
    // `shadowPrewarmed` is the casters whose shadow-context node was built behind the gate, and
    // `castersUnbuilt` the ones it could not reach — a non-zero there is the walk-time first shadow
    // build the prewarm was supposed to move, named rather than inferred.
    console.info(
      `TN_WORLD_PREWARM minted=${String(this.#prewarmMinted)} ` +
        `shadowPrewarmed=${String(this.#prewarmCasterDrawn)} ` +
        `castersUnbuilt=${String(Math.max(0, this.#prewarmCasterMinted - this.#prewarmCasterDrawn))}`,
    );
    this.#prewarmResolve();
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
    const source = renderer ?? this.#renderer;
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
    if (this.#prewarmQueue.length > 0 || this.#prewarmOwed > this.#prewarmDrawn)
      return this.#lodBias;
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
      hlod: {
        on: this.#hlod,
        loaded: [...this.#cellProxies].filter(
          (state) => state.prepared !== undefined && !state.cancelled,
        ).length,
        compiled: [...this.#cellProxies].filter((state) => state.compiled && !state.cancelled)
          .length,
        observed: [...this.#cellProxies].filter(
          (state) => this.#proxyObserved(state) && !state.cancelled,
        ).length,
        active: [...this.#cellProxies].filter((state) => state.active).length,
        pending: [...this.#cellProxies].filter(
          (state) =>
            state.pending ||
            state.compiling ||
            (!state.cancelled && !state.compiled && state.prepared !== undefined),
        ).length,
        bytes: this.#hlodBytes,
        refused: this.#hlodRefused,
        failures: this.#hlodFailures,
      },
      impostor: this.#impostorStats(),
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
      pendingPrewarm: this.#prewarmQueue.length + this.#prewarmOwed - this.#prewarmDrawn,
      prewarmMinted: this.#prewarmMinted,
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
    return cell.chunksLoaded && cell.completedRuns.size === cell.cell.runs.length;
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

  dispose(): void {
    if (this.#released) return;
    this.#released = true;
    for (const [mesh, entry] of [...this.#awaited]) {
      if (mesh.onBeforeRender === entry.borrow) this.#handBack(mesh, entry.hadOwn, entry.own);
    }
    this.#awaited.clear();
    for (const cell of [...this.#resident.values()]) this.#evict(cell);
    // Every chunk is gone by now, so the surfaces the world owns on their behalf are the last thing
    // holding them, and they are released here rather than by whichever chunk contributed them.
    for (const material of this.#proxyMaterials.values())
      this.#failures += release(material) ? 1 : 0;
    this.#proxyMaterials.clear();
    this.#renderer = undefined;
    this.#camera = undefined;
    this.#recordedWhileBusy.clear();
    // After every asset's release above, so no record is still held by a surface; disposes the cached
    // atlases and aborts any bake still in flight.
    this.#drainImpostors();
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
    this.#prewarmQueue.length = 0;
    this.#prewarmKeys.clear();
    this.#settlePrewarm();
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
          this.#instances + this.#farInstances + instances > this.#budgets.instances ||
          this.#bytes + this.#farBytes + this.#hlodBytes + bytes > this.#budgets.bytes)
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
      if (this.#instances + this.#farInstances + instances > this.#budgets.instances) {
        this.#pressure.instances += 1;
        continue;
      }
      if (this.#bytes + this.#farBytes + this.#hlodBytes + bytes > this.#budgets.bytes) {
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
    if (cell.chunks !== undefined && cell.chunks.length > 0) this.#startChunkLoad(state);
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
    this.#disableFar(job.run);
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
    const wantRoots = this.#rootsNeeded(asset);
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
      if (this.#prewarmSettled === false) this.#awaitDraw(shared);
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
      this.#carryPrewarm(mesh, next);
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
      this.#carryPrewarm(mesh, next);
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
   * Hand a replaced mesh's prewarm borrow to the object that replaced it.
   *
   * The borrow is keyed by the mesh object and counts *that* object's first submitted draw, so an
   * object that goes away before its draw would take the owed draw with it: the batch would sit
   * visible at count 0 for the rest of the load, and the owed counters would never balance. Nothing
   * new is prewarmed here — the batch still owes exactly the one draw it owed.
   */
  #carryPrewarm(old: InstancedMesh, next: InstancedMesh): void {
    const entry = this.#awaited.get(old);
    if (entry === undefined) return;
    this.#awaited.delete(old);
    this.#borrowDraw(entry.batch, next, entry.hadOwn, entry.own, entry.epoch);
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
    const camera = this.#camera;
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
      if (this.#farTemp.has(asset.id)) this.#releaseFarTemp(asset.id);
      return;
    }
    // Before the prewarm and the queued builds, both of which read the levels, the distances and
    // the gates: an asset whose chain widened it is batched at those levels from its first build.
    asset.levels = this.#widenWithChain(asset, adopted);
    // A far-only asset is drawn by no near run, so it takes no prewarm and queues no cell build:
    // its whole job is the atlas behind the aggregate, and its source is released once that lands.
    if (this.#farTemp.has(asset.id)) {
      this.#maybeQueueImpostor(asset);
      // Nothing to bake (no alpha-cutout LOD0) and nothing queued: release the source now.
      if (asset.impostor === undefined && !this.#impostorQueued.has(asset.id))
        this.#releaseFarTemp(asset.id);
      return;
    }
    // After the chain, so the impostor's switch sits beyond every synthesized gate; before the
    // prewarm, so a cached atlas appends its level in this same admission.
    this.#maybeQueueImpostor(asset);
    // Every level and part of the asset now, before any of them is asked for. A level with no
    // placement in it is not drawn and would otherwise mint its mesh — and pay its node build — on
    // the frame a walk first moves far enough to switch into it.
    this.#queuePrewarm(asset);
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
   * Whether this asset can append a whole-asset impostor, so its builds keep the placement-root
   * records the far quad draws from. The same test `#maybeQueueImpostor` makes, minus the cache: an
   * asset with no alpha-cutout LOD0 part never bakes, so it never needs the extra records.
   */
  #rootsNeeded(asset: IAssetState): boolean {
    if (this.#impostors === false) return false;
    const parts = asset.levels[0];
    return parts !== undefined && this.#impostorSource(parts) !== undefined;
  }

  /**
   * The first LOD0 part that is alpha foliage, and the cutoff its own material authored — or
   * `undefined` when no part is. A BLEND part carries `alphaTest 0`, and the scatter path draws it
   * through the same cutout a MASK part gets, so the contract records that default rather than a
   * zero that would bake a solid impostor.
   */
  #impostorSource(
    parts: readonly IAssetPart[],
  ): { readonly source: Material; readonly alphaTest: number } | undefined {
    for (const part of parts) {
      const material = part.material;
      if (!isAlphaFoliage(material)) continue;
      return {
        source: material,
        alphaTest: material.alphaTest > 0 ? material.alphaTest : DEFAULT_CUTOUT_ALPHA,
      };
    }
    return undefined;
  }

  /**
   * The content key one impostor atlas is cached under: the loader's resolved cooked url of LOD0,
   * plus every LOD0 source part's surface/content key and its exact cutout contract. Two package
   * entries that fetch the same cooked model and draw the same parts with the same cutoffs are one
   * bake, which is the canonical-asset idea applied to the atlas rather than to the levels — the
   * package's own `lods`/`maxDistance` metadata may have stopped the two entries aliasing, but the
   * atlas is built from LOD0 alone, so it must be shared anyway.
   *
   * The cutoff is the exact number the bake uses, never a rounded one: `0.42` and `0.420001` are
   * different silhouettes and must not collide in the cache.
   */
  #impostorKey(asset: IAssetState): string {
    const parts = asset.levels[0] ?? [];
    const contract: string[] = [];
    for (const part of parts) {
      const cutoff = isAlphaFoliage(part.material)
        ? part.material.alphaTest > 0
          ? part.material.alphaTest
          : DEFAULT_CUTOUT_ALPHA
        : 0;
      contract.push(`${part.surface}@${String(cutoff)}`);
    }
    return `${asset.resolvedGlb}|${this.#transparentScatter}|${contract.join(",")}`;
  }

  /** Mark a cached atlas touched, so the least recently used inactive record is the one evicted. */
  #touchImpostor(key: string, record: IImpostorRecord): void {
    this.#impostorRecords.delete(key);
    this.#impostorRecords.set(key, record);
  }

  /**
   * Queue one adopted asset's whole-asset impostor, or append it at once from a cached atlas.
   *
   * Called after `#widenWithChain` and before the prewarm, so the terminal level is known to the same
   * prewarm and rebuild machinery every adoption uses. An asset with no alpha-cutout LOD0 part is
   * never baked: a solid impostor is not the thing it replaces.
   */
  #maybeQueueImpostor(asset: IAssetState): void {
    if (this.#impostors === false || asset.impostor !== undefined) return;
    const parts = asset.levels[0];
    if (parts === undefined) return;
    const source = this.#impostorSource(parts);
    if (source === undefined) return;
    const key = this.#impostorKey(asset);
    const cached = this.#impostorRecords.get(key);
    if (cached !== undefined) {
      this.#touchImpostor(key, cached);
      this.#finishImpostor(asset, cached);
      return;
    }
    if (this.#impostorQueued.has(asset.id)) return;
    this.#impostorQueued.add(asset.id);
    this.#impostorQueue.push(asset);
  }

  /**
   * One view of the bake per render-cadence update, then the terminal level when it completes.
   *
   * The renderer is asked for its raw seam and the bake waits for one that can run it: a world that
   * has no renderer yet — or a backend whose raw seam is not the layered-target API — simply does
   * not advance, and nothing downstream of the bake is owed until it does. No landmark is already
   * waited on, so a bake that never runs never deadlocks a loading screen.
   */
  #stepImpostor(renderer: IRendererLike | undefined): void {
    if (this.#impostors === false || this.#released) return;
    // A renderer that exists but carries no layered bake seam is a real answer, not a delay. Waiting
    // on it would leave every queued asset pending and its atlas bytes reserved for the world's whole
    // life, so the bake is cancelled, the reservation and queue dropped, and each asset reported:
    // the source LODs stay, which is the documented fallback. A world with no renderer yet keeps
    // waiting — that is the loading-screen case the wait exists for.
    const current = renderer ?? this.#renderer;
    if (current !== undefined && impostorRawRenderer(current) === undefined) {
      this.#dropUnsupportedImpostors();
      return;
    }
    if (this.#impostorBaking === undefined) {
      while (this.#impostorQueue.length > 0) {
        const asset = this.#impostorQueue.shift() as IAssetState;
        this.#impostorQueued.delete(asset.id);
        if (this.#assets.get(asset.id) !== asset || asset.disposed || asset.impostor !== undefined)
          continue;
        const parts = asset.levels[0];
        if (parts === undefined || this.#impostorSource(parts) === undefined) continue;
        // Re-check the completed cache when DEQUEUED, not only when queued: two entries whose bake
        // was queued before either finished share one atlas instead of baking it twice.
        const key = this.#impostorKey(asset);
        const cached = this.#impostorRecords.get(key);
        if (cached !== undefined) {
          this.#touchImpostor(key, cached);
          this.#finishImpostor(asset, cached);
          continue;
        }
        // Enforce the declared colour+mip budget BEFORE the atlas is allocated, and never at the
        // cost of an atlas a live asset draws from: inactive LRU records make room first.
        if (
          this.#impostorRecordBytes + this.#impostorReservedBytes + IMPOSTOR_ATLAS_BYTES >
          this.#impostorBudgetBytes
        )
          this.#evictImpostors(IMPOSTOR_ATLAS_BYTES);
        if (this.#impostorRecordBytes + IMPOSTOR_ATLAS_BYTES > this.#impostorBudgetBytes) {
          // Out of room: keep the source LODs and say why, rather than overrun the budget with one
          // more atlas or evict one still in use.
          this.#reportImpostor(asset, "budget");
          // A far-only species fetched for the far half alone has no near run to fall back on, and
          // nothing here retries an atlas-budget refusal, so keeping its source GLB alive buys
          // nothing. Release it; the near path re-acquires it normally if the follow point reaches it.
          if (this.#farTemp.has(asset.id)) this.#releaseFarTemp(asset.id);
          continue;
        }
        const staged: IImpostorPart[] = impostorParts(parts);
        try {
          this.#baker.begin(asset.id, staged, { pixels: IMPOSTOR_FRAME_PIXELS });
        } catch {
          this.#failures += 1;
          this.#reportImpostor(asset, "begin-failed");
          continue;
        }
        this.#impostorReservedBytes = IMPOSTOR_ATLAS_BYTES;
        this.#impostorBaking = asset;
        break;
      }
    }
    const baking = this.#impostorBaking;
    if (baking === undefined) return;
    const raw = impostorRawRenderer(renderer);
    if (raw === undefined) return;
    let atlas: WorldImpostorAtlas | undefined;
    try {
      atlas = this.#baker.step(raw);
    } catch {
      this.#failures += 1;
      this.#impostorBaking = undefined;
      this.#impostorReservedBytes = 0;
      this.#reportImpostor(baking, "bake-failed");
      return;
    }
    if (atlas === undefined) return;
    this.#impostorBaking = undefined;
    this.#adoptImpostorAtlas(baking, atlas);
  }

  /**
   * Drop every queued and in-flight bake because the renderer cannot run the layered capture, and
   * report each asset once. The reservation is released with the abort, so a later supported renderer
   * (a device swap, a backend that only comes up after a frame) can still bake: the queue is empty,
   * but a fresh adoption re-queues, and an asset already refused here is left with its source LODs.
   */
  #dropUnsupportedImpostors(): void {
    if (this.#impostorQueue.length === 0 && this.#impostorBaking === undefined) return;
    const dropped: IAssetState[] = [];
    if (this.#impostorBaking !== undefined) {
      dropped.push(this.#impostorBaking);
      this.#reportImpostor(this.#impostorBaking, "unsupported");
      this.#baker.abort();
      this.#impostorBaking = undefined;
      this.#impostorReservedBytes = 0;
    }
    const queued = this.#impostorQueue.splice(0, this.#impostorQueue.length);
    this.#impostorQueued.clear();
    dropped.push(...queued);
    for (const asset of queued) this.#reportImpostor(asset, "unsupported");
    // A far-only species cannot bake on a backend that has none, so it must not keep holding the
    // source it fetched for a bake that will never land. Its atlas cache key stays for a later backend.
    for (const asset of dropped) if (this.#farTemp.has(asset.id)) this.#releaseFarTemp(asset.id);
  }

  /** Store a finished atlas and hand the asset its terminal level. */ #adoptImpostorAtlas(
    asset: IAssetState,
    atlas: WorldImpostorAtlas,
  ): void {
    this.#impostorReservedBytes = 0;
    const parts = asset.levels[0];
    const source = parts === undefined ? undefined : this.#impostorSource(parts);
    if (parts === undefined || source === undefined || asset.impostor !== undefined) {
      atlas.dispose();
      return;
    }
    const key = this.#impostorKey(asset);
    const existing = this.#impostorRecords.get(key);
    if (existing !== undefined) {
      atlas.dispose();
      this.#touchImpostor(key, existing);
      this.#finishImpostor(asset, existing);
      return;
    }
    const staged: IImpostorPart[] = impostorParts(parts);
    const bounds = impostorBounds(staged);
    const record: IImpostorRecord = {
      atlas,
      bytes: atlas.bytes,
      center: bounds.center,
      key,
      radius: bounds.radius,
      users: 0,
    };
    this.#impostorRecords.set(key, record);
    this.#impostorRecordBytes += record.bytes;
    // Acquire the active user BEFORE any eviction, so the fresh record cannot be the eviction
    // victim and `#finishImpostor` never builds a surface that borrows a disposed atlas. Admission
    // already reserved this record's bytes, so the trim below only drops older inactive records.
    this.#finishImpostor(asset, record);
    this.#evictImpostors();
  }

  /**
   * Append the whole-asset terminal level: one part, identity local, two triangles, and a switch at
   * the projection the 128 px atlas sphere reaches — never a fixed metre, and strictly beyond the
   * last authored or chain gate so `levelAt` cannot pick it before the level that gate named.
   *
   * The surface's own geometry and material are the part's, so the level is a normal level to every
   * consumer downstream: the prewarm mints its keys, the swap rebuilds the resident runs, and the
   * caster halves read it through `#shapeFor` like any other. The atlas is borrowed and released by
   * the record; see `#releaseImpostor`.
   */
  #finishImpostor(asset: IAssetState, record: IImpostorRecord): void {
    if (asset.impostor !== undefined || asset.disposed) return;
    if (this.#assets.get(asset.id) !== asset) return;
    const parts = asset.levels[0];
    if (parts === undefined) return;
    const source = this.#impostorSource(parts);
    if (source === undefined) return;
    let surface: WorldImpostorSurface;
    try {
      surface = new WorldImpostorSurface({
        alphaTest: source.alphaTest,
        atlas: record.atlas,
        center: record.center,
        radius: record.radius,
        source: source.source,
      });
    } catch {
      this.#failures += 1;
      this.#reportImpostor(asset, "surface-failed");
      return;
    }
    // The terminal gate is stored as the BASE-sphere projected distance — the distance at which the
    // asset's own LOD0 sphere, at scale 1, covers the 128 px atlas — and the placement's own scale is
    // applied per placement at selection (`levelAtGates`). A placement scaled 8-12x therefore reaches
    // the atlas 8-12x as far instead of switching at the unit-scale distance. There is no fixed
    // margin: `levelAtGates` floors the terminal one representable Float32 step past the last source
    // gate, so the source level keeps a window while the ordering survives the f32 store.
    const switchAt = (2 * record.radius * this.#autoLodPixelsPerUnit) / IMPOSTOR_FRAME_PIXELS;
    if (!Number.isFinite(switchAt) || switchAt <= 0) {
      surface.dispose();
      return;
    }
    const part: IAssetPart = {
      geometry: surface.geometry,
      local: new Matrix4(),
      material: surface.material,
      surface: "",
    };
    asset.levels = [...asset.levels, [part]];
    asset.distances = [...asset.distances, switchAt];
    asset.gates = [...asset.gates, switchAt];
    this.#noteGate(switchAt);
    asset.threshold = asset.gates.length === 0 ? undefined : Math.min(...asset.gates);
    asset.impostor = { part, record, surface };
    record.users += 1;
    // The whole-map far aggregate for this atlas key, before the rebuild loop below: its segments
    // exist when the swaps land, and any run already near-ready is handed over immediately. A budget
    // refusal keeps only the far cohort's metadata and surface in `#farRetry`; see `#buildFar`.
    this.#buildFar(asset, record);
    this.#reportImpostor(asset, "ready");
    // A far-only asset has no near batches or casters to hand over; once its aggregate is up its
    // temporary source has done its job and goes, while the atlas the aggregate borrows stays. A
    // refusal releases the source too — the deferred cohort in `#farRetry` holds only metadata and a
    // surface, never the GLB — so a far species that cannot fit is not kept alive wholesale.
    if (this.#farTemp.has(asset.id)) {
      this.#releaseFarTemp(asset.id);
      return;
    }
    // The far casters of the levels that were already built: part 0's key is re-pointed at the one
    // whole-asset shape, and the per-part keys the terminal level has no counterpart for are dropped,
    // so the far shadow draws one quad per placement rather than a duplicate per bark/needle part.
    this.#retargetWideCasters(asset);
    // The terminal level's keys and every resident run of this asset, through the same prewarm and
    // swap the first build took: no active job array is mutated halfway.
    this.#queuePrewarm(asset);
    for (const cell of [...this.#resident.values()]) {
      for (const run of cell.cell.runs) {
        if (this.#canonical(run.asset) === asset.id) this.#queueBuild(asset, cell, run, true);
      }
    }
  }

  /**
   * The whole-map far aggregate for one exact atlas cache key: every ORIGINAL placement root of every
   * canonical asset that bakes to that key, in one `InstancedMesh`, independent of the near ring and
   * of the near source GLBs.
   *
   * One aggregate per EXACT atlas key, never one per `maxDistance`: a shared atlas can back assets
   * with different authored cutoffs, and each placement's own value rides the instance buffer (see
   * {@link IFarSegment.cull}) rather than splitting the key into a second aggregate — the exact key
   * is what the atlas cache already bounds, and a split would build a second surface for one atlas.
   * The first asset to bake a key builds the aggregate's own surface and instance buffer; a later
   * canonical asset that shares the key appends its own runs to the same mesh, growing the buffer at
   * most once per asset. A key already carrying every one of this asset's runs is left untouched, so
   * re-adopting an asset from the cached atlas after its near source was released rebuilds nothing.
   * Never `part.local`: the atlas bakes each part's own transform, so the far quad is the placement
   * root alone.
   */
  #buildFar(asset: IAssetState, record: IImpostorRecord): boolean {
    const parts = asset.levels[0];
    const source = parts === undefined ? undefined : this.#impostorSource(parts);
    if (parts === undefined || source === undefined) return false;
    // Every run this asset owns anywhere in the map: the far half covers the whole map, not the ring.
    const runs = this.#farRuns(asset.id);
    if (runs.length === 0) return true;
    return this.#buildFarCohort({
      alphaTest: source.alphaTest,
      cull: cullDistance(asset.definition.maxDistance) ?? Number.POSITIVE_INFINITY,
      id: asset.id,
      key: record.key,
      record,
      runs,
      source: source.source,
    });
  }

  /** Every run of one canonical asset anywhere in the map, the whole set a far aggregate holds. */
  #farRuns(id: string): Array<{ cell: IWorldCell; run: IWorldRun }> {
    const runs: Array<{ cell: IWorldCell; run: IWorldRun }> = [];
    for (const held of this.#cells)
      for (const run of held.runs) {
        if (this.#canonical(run.asset) !== id || run.count <= 0) continue;
        runs.push({ cell: held, run });
      }
    return runs;
  }

  /**
   * Build or grow one far cohort's aggregate, or defer it against the hard budget.
   *
   * The budget check counts the growth transient, not the net new count: a grow allocates the new
   * larger buffer while the old one is still alive, so the peak is the new buffer's size — the old
   * buffer is already charged in `#farBytes`. See {@link #farBudgetRefuses}. A refusal is remembered
   * as metadata plus a built surface, never the source GLB; see {@link #deferFar}.
   */
  #buildFarCohort(cohort: IFarCohort): boolean {
    const key = cohort.key;
    const aggregate = this.#far.get(key);
    const missing =
      aggregate === undefined
        ? cohort.runs
        : cohort.runs.filter((entry) => !(aggregate as IFarAggregate).segments.has(entry.run));
    if (missing.length === 0) {
      this.#dropFarRetry(cohort.id);
      return true;
    }
    const extra = missing.reduce((total, entry) => total + entry.run.count, 0);
    const peak = aggregate === undefined ? extra : (aggregate as IFarAggregate).capacity + extra;
    if (this.#farBudgetRefuses(peak)) {
      // Hard finite budget: say why rather than overrun it, and keep only the metadata the retry
      // needs. Never the full source GLB; see `#deferFar`.
      this.#reportFarBudget(key, cohort.id, extra);
      this.#deferFar(cohort);
      return false;
    }
    let built = aggregate as IFarAggregate | undefined;
    const deferred = this.#farRetry.get(cohort.id);
    // The surface actually drawn by the aggregate after this call. A new aggregate adopts the
    // deferred surface; a grow reuses the aggregate's own and leaves the deferred one unused.
    let usedSurface: WorldImpostorSurface | undefined;
    if (built === undefined) {
      usedSurface = deferred?.surface ?? this.#makeFarSurface(cohort);
      if (usedSurface === undefined) return false;
      built = {
        capacity: extra,
        key,
        mesh: this.#newFarMesh(usedSurface, extra, cohort.id),
        record: cohort.record,
        segments: new Map<IWorldRun, IFarSegment>(),
        surface: usedSurface,
        uploads: 0,
      };
      cohort.record.users += 1;
      this.#far.set(key, built);
      this.#farInstances += extra;
      this.#farBytes += extra * FAR_INSTANCE_BYTES;
    } else {
      this.#growFar(built, extra);
    }
    this.#dropFarRetry(cohort.id, usedSurface);
    let at = this.#farAllocated(built);
    for (const { cell: held, run } of missing) {
      const segment: IFarSegment = {
        cell: held,
        count: run.count,
        cull: cohort.cull,
        live: true,
        run,
        start: at,
      };
      at += run.count;
      built.segments.set(run, segment);
      this.#farSegments.set(run, built);
      this.#writeFarSegment(built, segment);
    }
    this.#syncFarSegments(built);
    // The far half just gained records, so the shadow levels drawing the ground they stand on are
    // stale; the same blanket tell a near swap makes. See `#shadowRecordsMoved`.
    this.#shadowRecordsMoved();
    if (!this.#farReported.has(key)) {
      this.#farReported.add(key);
      const split = this.#farSplit(built);
      console.info(
        `${WORLD_IMPOSTOR_FAR_MARKER} key=${key} asset=${cohort.id} ` +
          `instances=${String(built.capacity)} live=${String(split.live)} ` +
          `nearOwned=${String(split.nearOwned)} bytes=${String(built.capacity * FAR_INSTANCE_BYTES)} ` +
          `uploads=${String(built.uploads)}`,
      );
    }
    return true;
  }

  /** The aggregate's own far surface: the record's atlas, the cohort's material twin, per-instance cull. */
  #makeFarSurface(cohort: IFarCohort): WorldImpostorSurface | undefined {
    if (cohort.source === undefined) return undefined;
    try {
      return new WorldImpostorSurface({
        alphaTest: cohort.alphaTest,
        atlas: cohort.record.atlas,
        center: cohort.record.center,
        cull: true,
        radius: cohort.record.radius,
        source: cohort.source,
      });
    } catch {
      this.#failures += 1;
      return undefined;
    }
  }

  /**
   * Keep a refused far cohort as metadata alone: the atlas pinned by one borrowed user, the runs, and
   * a built surface. The asset's own geometry and materials are released by the caller, so a refused
   * far species never holds a full GLB alive; `#retryFar` rebuilds from this when a near release frees
   * room. Idempotent: a repeat refusal keeps the surface already built.
   */
  #deferFar(cohort: IFarCohort): void {
    if (this.#farRetry.has(cohort.id)) return;
    const surface = this.#makeFarSurface(cohort);
    if (surface === undefined) return;
    cohort.record.users += 1;
    this.#farRetry.set(cohort.id, {
      alphaTest: cohort.alphaTest,
      cull: cohort.cull,
      id: cohort.id,
      key: cohort.key,
      record: cohort.record,
      runs: cohort.runs,
      surface,
    });
  }

  /** Drop a deferred cohort, releasing its surface and the atlas user it pinned. */
  #dropFarRetry(id: string, consumedSurface?: WorldImpostorSurface): void {
    const entry = this.#farRetry.get(id);
    if (entry === undefined) return;
    this.#farRetry.delete(id);
    if (consumedSurface !== entry.surface) entry.surface.dispose();
    entry.record.users = Math.max(0, entry.record.users - 1);
    this.#evictImpostors();
  }

  /** Retry the far aggregates a full budget refused, when a near cell freed its allocation. */
  #retryFar(): void {
    if (this.#farRetry.size === 0) return;
    for (const entry of [...this.#farRetry.values()]) this.#buildFarCohort(entry);
  }

  /**
   * Adopt one far-only species per idle frame: a canonical asset the map places but no resident run
   * has asked for yet. Its LOD0 is loaded through the same limiter, classified by its actual
   * materials, baked on the same queue, and its source released once the aggregate lands. Gated on an
   * empty near queue so loading the unseen never delays the near ring or holds its overlay open.
   */
  #pumpFarAcquisition(): void {
    if (this.#impostors === false || this.#released || this.#farExhausted) return;
    if (this.#farCandidateIds.length === 0) return;
    // Near work first: a queued build, an in-flight near load, a bake in flight or waiting. Only a
    // settled frame spends itself on the unseen far half.
    if (
      this.#jobs.length > 0 ||
      this.#limiter.inFlight > 0 ||
      this.#limiter.queued > 0 ||
      this.#prewarmQueue.length > 0 ||
      this.#impostorQueue.length > 0 ||
      this.#impostorBaking !== undefined
    )
      return;
    // The bake needs a renderer that can run it; acquiring before one exists would hold source GLBs
    // for a bake with no way to land. A renderer that is present but unsupported is the same answer.
    const renderer = this.#renderer;
    if (renderer === undefined || impostorRawRenderer(renderer) === undefined) return;
    const count = this.#farCandidateIds.length;
    for (let step = 0; step < count; step += 1) {
      const at = (this.#farCursor + step) % count;
      const id = this.#farCandidateIds[at] as string;
      if (this.#farSeen.has(id) || this.#assets.has(id) || this.#farRetry.has(id)) continue;
      this.#farCursor = (at + 1) % count;
      const definition = this.#manifest.assets[id];
      if (definition === undefined) {
        this.#farSeen.add(id);
        continue;
      }
      const asset = this.#newAsset(id, definition);
      asset.refcount += 1;
      this.#farTemp.add(id);
      this.#startAssetLoad(asset);
      return;
    }
    // A full pass with nothing startable means every species is either baked, held for a retry, or
    // classified as having no atlas. Static placements add none later, so the scan stops here.
    this.#farExhausted = true;
  }

  /**
   * Drop a far-only asset's temporary reference once its atlas is held by an aggregate or has been
   * deferred. The deferred cohort keeps its own pinned atlas user, so it is not dropped here.
   */
  #releaseFarTemp(id: string): void {
    this.#farTemp.delete(id);
    this.#farSeen.add(id);
    this.#release(id);
  }

  /**
   * Whether an incoming far allocation would overrun the world's instance or byte budget.
   *
   * `count` is the peak, not the net: a grow allocates the new larger buffer while the old one is
   * still alive, so the caller passes the new buffer's full size — the old buffer is already inside
   * `#farInstances`/`#farBytes`. A net-new count would understate the transient a resize holds.
   */
  #farBudgetRefuses(count: number): boolean {
    return (
      this.#instances + this.#farInstances + count > this.#budgets.instances ||
      this.#bytes + this.#farBytes + this.#hlodBytes + count * FAR_INSTANCE_BYTES >
        this.#budgets.bytes
    );
  }

  /** One bounded line for a far aggregate the world's own budgets refused, once per atlas key. */
  #reportFarBudget(key: string, assetId: string, count: number): void {
    if (this.#farReported.has(key)) return;
    this.#farReported.add(key);
    console.info(
      `${WORLD_IMPOSTOR_FAR_MARKER} key=${key} asset=${assetId} ` +
        `instances=${String(count)} reason=budget`,
    );
  }

  /**
   * One far mesh: the whole-asset quad, every original root, drawn regardless of how far the camera
   * resolves it. `frustumCulled = false` is what keeps the draw: the projected-size gate exempts it
   * before it ever reads bounds, so no `alwaysRender` marker is needed when a game configured no
   * shadows to exempt it under `renderer.minimumProjectedPixels`. The per-placement cull rides the
   * geometry's instance attribute, one static value per placement; see
   * {@link IMPOSTOR_FAR_CULL_ATTRIBUTE}.
   */
  #newFarMesh(surface: WorldImpostorSurface, capacity: number, assetId: string): InstancedMesh {
    const mesh = new InstancedMesh(surface.geometry, surface.material, capacity);
    mesh.count = capacity;
    mesh.frustumCulled = false;
    // Three's default usage uploads by version; grow/write/zero announce every matrix change through
    // needsUpdate. DynamicDrawUsage would upload the same whole-map buffer on every settled draw.
    mesh.name = `tn-far:${assetId}`;
    // Drawn on layer 0, so this is a main-pass draw the frame budget counts under the impostor
    // aggregate's own source rather than under `other` (`RenderPassBudget`).
    mesh.userData.tnDrawSource = "proxies";
    if (surface.cull) this.#attachFarCull(surface.geometry, capacity);
    // Far trees cast like near ones, into the coarse wide caster layer. The same mesh draws the main
    // pass (layer 0) and the virtual-shadow levels (wide layer), so one representation covers both
    // and a run hands its far segment over to the near ring exactly once; see `#disableFar`. The
    // per-asset maxDistance gate is a main-pass shader gate, so the shadow half still reaches the map.
    if (this.#castShadowLevels > 0) {
      mesh.layers.enable(VIRTUAL_SHADOW_WIDE_CASTER_LAYER);
      mesh.castShadow = true;
      mesh.receiveShadow = false;
    }
    this.add(mesh);
    return mesh;
  }

  /** Install a fresh per-instance cull buffer on the aggregate's shared geometry, all gates open. */
  #attachFarCull(geometry: BufferGeometry, capacity: number): void {
    geometry.setAttribute(
      IMPOSTOR_FAR_CULL_ATTRIBUTE,
      new InstancedBufferAttribute(new Float32Array(capacity).fill(Number.POSITIVE_INFINITY), 1),
    );
  }

  /** Append `extra` instance slots to an aggregate, one mesh swap, charged to the budgets. */
  #growFar(aggregate: IFarAggregate, extra: number): void {
    const old = aggregate.mesh;
    const capacity = aggregate.capacity + extra;
    // Capture the cull values before the replacement mesh attaches a fresh buffer to the SHARED
    // geometry; the old attribute object is replaced in place there.
    const oldCull = aggregate.surface.cull
      ? (
          aggregate.surface.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE)?.array as
            | Float32Array
            | undefined
        )?.slice(0, aggregate.capacity)
      : undefined;
    const next = this.#newFarMesh(aggregate.surface, capacity, old.name.replace(/^tn-far:/u, ""));
    (next.instanceMatrix.array as Float32Array).set(
      (old.instanceMatrix.array as Float32Array).subarray(0, aggregate.capacity * 16),
    );
    next.instanceMatrix.needsUpdate = true;
    if (oldCull !== undefined) {
      const attribute = next.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE) as
        | InstancedBufferAttribute
        | undefined;
      if (attribute !== undefined) (attribute.array as Float32Array).set(oldCull, 0);
    }
    this.remove(old);
    old.dispose();
    aggregate.mesh = next;
    aggregate.capacity = capacity;
    aggregate.uploads += 1;
    this.#farInstances += extra;
    this.#farBytes += extra * FAR_INSTANCE_BYTES;
  }

  /** Slots allocated in an aggregate: the sum of its segment counts, the offset the next one takes. */
  #farAllocated(aggregate: IFarAggregate): number {
    let at = 0;
    for (const segment of aggregate.segments.values()) at += segment.count;
    return at;
  }

  /** Compose one run's ORIGINAL placement roots into its segment, exactly as `#addPlacements` does. */
  #writeFarSegment(aggregate: IFarAggregate, segment: IFarSegment): void {
    const records = cellPlacements(this.#placements, segment.run);
    const array = aggregate.mesh.instanceMatrix.array as Float32Array;
    const base = segment.start * 16;
    for (let index = 0; index < segment.count; index += 1) {
      const at = index * PLACEMENT_RECORD_FLOATS;
      this.#position.set(
        records[at] as number,
        records[at + 1] as number,
        records[at + 2] as number,
      );
      this.#rotation.set(
        records[at + 3] as number,
        records[at + 4] as number,
        records[at + 5] as number,
        records[at + 6] as number,
      );
      this.#scale.setScalar(records[at + 7] as number);
      this.#matrix.compose(this.#position, this.#rotation, this.#scale);
      this.#matrix.toArray(array, base + index * 16);
    }
    aggregate.mesh.instanceMatrix.needsUpdate = true;
    // The per-placement gate is static, so it is written with the matrices and re-uploaded only when
    // a handoff rewrites this segment. A whole-map surface reads it so every canonical asset keeps
    // its own authored cutoff over the shared atlas. See {@link IFarSegment.cull}.
    const cull = aggregate.mesh.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE) as
      | InstancedBufferAttribute
      | undefined;
    if (cull !== undefined) {
      (cull.array as Float32Array).fill(segment.cull, segment.start, segment.start + segment.count);
      cull.needsUpdate = true;
    }
    aggregate.uploads += 1;
    this.#farBoundsStale(aggregate);
  }

  /**
   * Zero one segment's records: the run is drawn by the near ring now, not the far mesh. Each record
   * keeps a homogeneous `w` of 1 while its xyz/scale terms collapse to 0, so the instance projects
   * to the origin and draws nothing. An all-zero record would leave `w = 0`, and Three's
   * `Box3.applyMatrix4` divides by it, so `computeBoundingBox` over the shared buffer would return
   * NaN and every caster in the aggregate would be dropped by the shadow levels.
   */
  #zeroFarSegment(aggregate: IFarAggregate, segment: IFarSegment): void {
    const array = aggregate.mesh.instanceMatrix.array as Float32Array;
    const from = segment.start * 16;
    const to = (segment.start + segment.count) * 16;
    array.fill(0, from, to);
    for (let at = from; at < to; at += 16) array[at + 15] = 1;
    aggregate.mesh.instanceMatrix.needsUpdate = true;
    aggregate.uploads += 1;
    this.#farBoundsStale(aggregate);
  }

  /**
   * A far matrix write changes the mesh's instance extent, so drop the cached pair and let Three
   * rebuild it on the next read; this is the native `null` convention `computeBoundingBox` honors.
   */
  #farBoundsStale(aggregate: IFarAggregate): void {
    aggregate.mesh.boundingBox = null;
    aggregate.mesh.boundingSphere = null;
  }

  /** The near ring has attached this run's full representation; the far mesh stops drawing it. */
  #disableFar(run: IWorldRun): void {
    const aggregate = this.#farSegments.get(run);
    if (aggregate === undefined) return;
    const segment = aggregate.segments.get(run);
    if (segment === undefined || segment.live === false) return;
    this.#zeroFarSegment(aggregate, segment);
    segment.live = false;
  }

  /** This run is leaving the ring; the far mesh draws it again before the near batches are cleared. */
  #restoreFar(run: IWorldRun): void {
    const aggregate = this.#farSegments.get(run);
    if (aggregate === undefined) return;
    const segment = aggregate.segments.get(run);
    if (segment === undefined || segment.live === true) return;
    this.#writeFarSegment(aggregate, segment);
    segment.live = true;
  }

  /**
   * Hand over every run of an aggregate a resident cell already draws. A run is near-ready exactly
   * when the cell holds one of its batches; the whole job is attached in one swap, so presence is the
   * answer. This is the build-time half of the atomic handoff; `#swap` is the per-frame half.
   */
  #syncFarSegments(aggregate: IFarAggregate): void {
    for (const segment of aggregate.segments.values()) {
      if (segment.live === false) continue;
      const resident = this.#resident.get(cellKey(segment.cell.x, segment.cell.z));
      if (resident === undefined) continue;
      if (!resident.batches.some((entry) => entry.run === segment.run)) continue;
      this.#zeroFarSegment(aggregate, segment);
      segment.live = false;
    }
  }

  /** An aggregate's live and near-owned instance counts. */
  #farSplit(aggregate: IFarAggregate): { live: number; nearOwned: number } {
    let live = 0;
    let nearOwned = 0;
    for (const segment of aggregate.segments.values()) {
      if (segment.live) live += segment.count;
      else nearOwned += segment.count;
    }
    return { live, nearOwned };
  }

  /** The far block {@link stats} reports: aggregates, physical instances/bytes and their split. */
  #farStats(): IWorldCellsStats["impostor"]["far"] {
    let instances = 0;
    let live = 0;
    let nearOwned = 0;
    let uploads = 0;
    for (const aggregate of this.#far.values()) {
      instances += aggregate.capacity;
      uploads += aggregate.uploads;
      const split = this.#farSplit(aggregate);
      live += split.live;
      nearOwned += split.nearOwned;
    }
    return {
      aggregates: this.#far.size,
      bytes: this.#farBytes,
      instances,
      live,
      nearOwned,
      uploads,
    };
  }

  /** Dispose every far aggregate: its own mesh and surface, and its borrowed atlas user. */
  #drainFar(): void {
    for (const aggregate of this.#far.values()) {
      aggregate.mesh.removeFromParent();
      aggregate.mesh.dispose();
      aggregate.surface.dispose();
      aggregate.record.users = Math.max(0, aggregate.record.users - 1);
    }
    this.#far.clear();
    this.#farSegments.clear();
    this.#farInstances = 0;
    this.#farBytes = 0;
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
          this.#wideRetry.add(asset.id);
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

  /** Retry the handoffs a frame's fresh-mesh allowance deferred; one bounded pass per update. */
  #retryWide(): void {
    if (this.#wideRetry.size === 0) return;
    const ids = [...this.#wideRetry];
    this.#wideRetry.clear();
    for (const id of ids) {
      const asset = this.#assets.get(id);
      if (asset === undefined || asset.impostor === undefined) continue;
      this.#retargetWideCasters(asset);
    }
  }

  /** The impostor block {@link stats} reports: assets landed, bakes pending, atlas bytes, terminal tris. */
  #impostorStats(): IWorldCellsStats["impostor"] {
    let assets = 0;
    let terminalTriangles = 0;
    for (const asset of this.#assets.values()) {
      if (asset.impostor === undefined) continue;
      assets += 1;
      terminalTriangles += levelTriangles(asset.impostor.part.geometry);
    }
    return {
      assets,
      atlasBytes: this.#impostorRecordBytes,
      budgetBytes: this.#impostorBudgetBytes,
      far: this.#farStats(),
      pending: this.#impostorQueue.length + (this.#impostorBaking === undefined ? 0 : 1),
      terminalTriangles,
    };
  }

  /** Drop queued/baking work for an asset whose source geometry is about to be released. */
  #cancelImpostor(asset: IAssetState): void {
    this.#impostorQueued.delete(asset.id);
    const at = this.#impostorQueue.indexOf(asset);
    if (at >= 0) this.#impostorQueue.splice(at, 1);
    if (this.#impostorBaking === asset) {
      // Before the borrowed source geometry is released: the baker stages it, and a view drawn after
      // the teardown reads a disposed buffer.
      this.#baker.abort();
      this.#impostorBaking = undefined;
      this.#impostorReservedBytes = 0;
    }
  }

  /** Release an asset's terminal level and give its atlas back to the cache; see `#release`. */
  #releaseImpostor(asset: IAssetState): void {
    const impostor = asset.impostor;
    if (impostor === undefined) return;
    asset.impostor = undefined;
    // Marked first, so `#releaseParts` skips the part whose geometry and material the surface owns.
    releasedParts.add(impostor.part);
    dropPooledFor(impostor.part.geometry, impostor.part.material);
    impostor.surface.dispose();
    impostor.record.users = Math.max(0, impostor.record.users - 1);
    this.#evictImpostors();
  }

  /**
   * Drop the oldest inactive atlases until the cache is back under budget; active ones are kept.
   *
   * `reserve` is the declared bytes of a bake about to start: the caller asks whether evicting
   * inactive records can make room for it. A record with a live user is never dropped, so a full
   * cache of active atlases simply leaves the reservation unmet and the caller refuses the bake.
   */
  #evictImpostors(reserve = 0): void {
    if (this.#impostorRecordBytes + reserve <= this.#impostorBudgetBytes) return;
    for (const [key, record] of [...this.#impostorRecords]) {
      if (this.#impostorRecordBytes + reserve <= this.#impostorBudgetBytes) break;
      if (record.users > 0) continue;
      this.#impostorRecords.delete(key);
      this.#impostorRecordBytes -= record.bytes;
      record.atlas.dispose();
    }
  }

  /** Dispose every cached atlas and any in-flight bake; the world's teardown path calls it once. */
  #drainImpostors(): void {
    // Far-only sources no cell run owns would otherwise never reach `#evict`; release them here so
    // their geometry goes the way every near asset's does.
    for (const id of [...this.#farTemp]) this.#release(id);
    this.#farTemp.clear();
    // Deferred far cohorts own a surface and pin an atlas user; release both before the records are
    // disposed below, so no surface is left pointing at a disposed atlas.
    for (const entry of this.#farRetry.values()) {
      entry.surface.dispose();
      entry.record.users = Math.max(0, entry.record.users - 1);
    }
    this.#farRetry.clear();
    this.#farSeen.clear();
    // The far aggregates own surfaces over these atlases and hold a user on their records; they go
    // first, so no far surface is left pointing at an atlas disposed below it.
    this.#drainFar();
    this.#impostorQueue.length = 0;
    this.#impostorQueued.clear();
    this.#impostorBaking = undefined;
    this.#impostorReservedBytes = 0;
    this.#baker.dispose();
    for (const record of this.#impostorRecords.values()) record.atlas.dispose();
    this.#impostorRecords.clear();
    this.#impostorRecordBytes = 0;
  }

  /**
   * `TN_WORLD_IMPOSTOR`, one bounded line per asset: its terminal level, the metres it takes over at,
   * the views the atlas holds, its GPU bytes, and — when the world can name it — why it did not land.
   */
  #reportImpostor(asset: IAssetState, reason: string): void {
    if (this.#impostorReported.has(asset.id)) return;
    this.#impostorReported.add(asset.id);
    const impostor = asset.impostor;
    const atlas = impostor?.record.atlas ?? this.#baker.pending?.atlas;
    console.info(
      `${WORLD_IMPOSTOR_MARKER} asset=${asset.id} level=${String(asset.levels.length - 1)} ` +
        `switch=${(asset.distances.at(-1) ?? 0).toFixed(1)} ` +
        `views=${String(atlas === undefined ? 0 : IMPOSTOR_VIEWS)} ` +
        `bytes=${String(atlas?.bytes ?? 0)} reason=${reason}`,
    );
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

  #proxyObserved(state: ICellProxyState): boolean {
    return state.prepared !== undefined && state.observed.size === state.prepared.meshes.length;
  }

  #releaseCellProxy(state: ICellProxyState): void {
    if (!this.#cellProxies.delete(state)) return;
    state.prepared?.root.removeFromParent();
    for (const mesh of state.prepared?.meshes ?? []) {
      mesh.onBeforeRender = Mesh.prototype.onBeforeRender;
      mesh.onAfterRender = Mesh.prototype.onAfterRender;
      this.#failures += release(mesh.geometry) ? 1 : 0;
    }
    // Cached model ownership uses the same global path holders as chunks and source LODs.
    // A compilation never races this release: cancellation retains everything until settlement.
    if (
      this.#loadModel !== undefined ||
      state.retainedPaths.every((path) => (this.#modelPaths.get(path) ?? 0) <= 1)
    )
      this.#failures += this.#disposeLoaded(state.model);
    this.#releaseModelPaths(state.retainedPaths);
    this.#hlodBytes -= state.bytes;
    state.bytes = 0;
  }

  #beginCellProxy(cell: IResidentCell): void {
    const proxy = cell.cell.proxy;
    if (proxy === undefined) return;
    // The cook already limits a decoded mesh unit; reserve source + private fixed copies before IO.
    // A world too tight to retain both source and proxy retains source instead of trading a hole.
    const reserve = CHUNK_MERGE_MAX_BYTES * 2;
    const state: ICellProxyState = {
      cell,
      selector: new CellProxySelection(proxy),
      retainedPaths: [],
      pending: true,
      compiling: false,
      cancelled: false,
      compiled: false,
      active: false,
      bytes: 0,
      observed: new Set(),
      hidden: new Map(),
    };
    const source = this.#cellProxySource(state);
    // A retained neighboring key or a cheaper source LOD cannot benefit. Reconsider after later
    // residency changes without allocating another copy or running a proxy load meanwhile.
    if (
      !source.compatible ||
      proxy.triangles >= source.triangles ||
      proxy.materialGroups > source.draws
    )
      return;
    cell.proxy = state;
    if (this.#bytes + this.#farBytes + this.#hlodBytes + reserve > this.#budgets.bytes) {
      state.cancelled = true;
      this.#hlodRefused++;
      return;
    }
    state.bytes = reserve;
    this.#hlodBytes += reserve;
    this.#cellProxies.add(state);
    const path = resolveRelative(this.#logicalBase, proxy.glb);
    if (this.#loadModel === undefined) this.#retainModelPaths([path], state.retainedPaths);
    void this.#limiter
      .load(
        () => this.#model(path),
        () => this.#cellLive(cell, cell.generation),
      )
      .then(
        (model) => {
          state.pending = false;
          state.model = model;
          if (!this.#cellLive(cell, cell.generation) || state.cancelled || model === undefined) {
            state.cancelled = true;
            this.#releaseCellProxy(state);
            return;
          }
          try {
            measureCellProxy(model, proxy);
          } catch {
            state.cancelled = true;
            this.#hlodRefused++;
            this.#releaseCellProxy(state);
            return;
          }
          // Preparation waits for an admission unit on a rendered update.
        },
        () => {
          state.pending = false;
          state.cancelled = true;
          this.#hlodFailures++;
          this.#releaseCellProxy(state);
        },
      );
  }

  #prepareCellProxy(state: ICellProxyState): void {
    try {
      const prepared = prepareCellProxy(
        state.model as Object3D,
        state.cell.cell.proxy as NonNullable<IWorldCell["proxy"]>,
      );
      state.prepared = prepared;
      if (prepared.bytes > state.bytes)
        throw new Error("Cell proxy exceeds its reserved decoded budget.");
      this.#hlodBytes += prepared.bytes - state.bytes;
      state.bytes = prepared.bytes;
      prepared.root.name = `world-cell-proxy:${state.cell.key}`;
      for (const mesh of prepared.meshes) mesh.receiveShadow = this.#receiveShadow;
      this.add(prepared.root);
    } catch {
      state.cancelled = true;
      this.#hlodRefused++;
      this.#releaseCellProxy(state);
    }
  }

  #compileCellProxy(state: ICellProxyState, renderer: IRendererLike, camera: Camera): void {
    const prepared = state.prepared;
    if (prepared === undefined) return;
    let scene: Object3D = this;
    while (scene.parent !== null) scene = scene.parent;
    if (Reflect.get(scene, "isScene") !== true) return;
    state.compiling = true;
    // No timeout counts as cancellation. This original promise owns every staged resource until it
    // settles, even if the cell/world has already left. Refusal keeps source and releases afterward.
    void Promise.resolve()
      .then(() => renderer.compileAsync(prepared.root, camera, scene))
      .then(
        () => {
          state.compiling = false;
          if (state.cancelled || !this.#cellLive(state.cell, state.cell.generation)) {
            state.cancelled = true;
            this.#releaseCellProxy(state);
            return;
          }
          this.#uploadAttributes(prepared.root);
          state.compiled = true;
          // Three calls render hooks during compile too, and may swallow pipeline errors. Observe a
          // matching main-camera backend submission only AFTER this compile settles. Zero-count
          // submission proves readiness of that route, not full-triangle execution or visual quality.
          for (const mesh of prepared.meshes) {
            let before: number | undefined;
            const calls = (): number | undefined => {
              try {
                const info = renderer.info as { render?: { drawCalls?: number; calls?: number } };
                const value = info.render?.drawCalls ?? info.render?.calls;
                return Number.isSafeInteger(value) && (value as number) >= 0 ? value : undefined;
              } catch {
                return undefined;
              }
            };
            mesh.onBeforeRender = (_raw, _scene, drawnCamera) => {
              before =
                drawnCamera === this.#camera && renderer.compiling !== true ? calls() : undefined;
            };
            markEngineRenderHook(mesh.onBeforeRender);
            mesh.onAfterRender = (_raw, _scene, drawnCamera) => {
              const after = calls();
              if (
                drawnCamera === this.#camera &&
                renderer.compiling !== true &&
                before !== undefined &&
                after !== undefined &&
                after > before
              )
                state.observed.add(mesh);
              before = undefined;
            };
            markEngineRenderHook(mesh.onAfterRender);
          }
        },
        () => {
          state.compiling = false;
          state.cancelled = true;
          this.#hlodFailures++;
          this.#releaseCellProxy(state);
        },
      )
      .catch(() => {
        state.compiling = false;
        state.cancelled = true;
        this.#hlodFailures++;
        this.#releaseCellProxy(state);
      });
  }

  #cellSourceDrawn(mesh: Mesh): boolean {
    if (
      this.#camera === undefined ||
      !this.#camera.layers.test(mesh.layers) ||
      Array.isArray(mesh.material) ||
      !mesh.material.visible
    )
      return false;
    for (let object: Object3D | null = mesh; object !== null; object = object.parent)
      if (!object.visible) return false;
    if (mesh.frustumCulled && !_cullFrustum.intersectsObject(mesh)) return false;
    return true;
  }

  #cellProxySource(state: ICellProxyState): {
    compatible: boolean;
    triangles: number;
    draws: number;
    meshes: Mesh[];
  } {
    const cell = state.cell;
    const meshes = [...cell.mainChunkMeshes];
    const materials = new Set<Material>();
    let triangles = 0;
    let draws = 0;
    let compatible = this.#cellLoaded(cell) && !this.#gpuScene.on;
    for (const mesh of meshes) {
      if (
        mesh.castShadow ||
        !cellProxySourceSafe(mesh) ||
        Array.isArray(mesh.material) ||
        !cellProxyGeometrySafe(mesh.geometry) ||
        !cellProxyMaterialSafe(mesh.material as Material) ||
        lodChainOf(mesh.geometry) !== undefined
      )
        compatible = false;
      else materials.add(mesh.material as Material);
      if (this.#cellSourceDrawn(mesh)) {
        triangles += levelTriangles(mesh.geometry);
        draws++;
      }
    }
    if (state.cell.cell.proxy?.scope === "cell") {
      const counts = new Map<SharedBatch, number>();
      const costs = new Map<SharedBatch, number>();
      for (const run of cell.cell.runs) {
        const asset = this.#assets.get(this.#canonical(run.asset));
        if (
          asset === undefined ||
          !asset.hlodSafe ||
          asset.impostor !== undefined ||
          asset.definition.maxDistance !== undefined ||
          this.#placementReach !== undefined
        ) {
          compatible = false;
          continue;
        }
        for (const [part, shape] of (asset.levels[0] ?? []).entries()) {
          const entries = cell.batches.filter((entry) => entry.run === run && entry.part === part);
          if (
            entries.length !== 1 ||
            entries[0]?.level !== 0 ||
            entries[0]?.batch.count !== run.count ||
            !cellProxyMaterialSafe(shape.material)
          ) {
            compatible = false;
            continue;
          }
          materials.add(shape.material);
        }
      }
      for (const entry of cell.batches) {
        if (entry.shared === undefined || entry.segment < 0 || entry.level !== 0) {
          compatible = false;
          continue;
        }
        counts.set(entry.shared, (counts.get(entry.shared) ?? 0) + entry.batch.count);
        costs.set(
          entry.shared,
          (costs.get(entry.shared) ?? 0) + levelTriangles(entry.batch.geometry) * entry.batch.count,
        );
      }
      for (const [shared, count] of counts) {
        // Retain the segment, hence near restoration is a flag write with no budget dependency.
        // A neighboring holder keeps this key drawn; such a key cannot be retired for this cell.
        if (shared.live !== count) compatible = false;
        else {
          if (this.#cellSourceDrawn(shared.mesh)) {
            draws++;
            triangles += costs.get(shared) ?? 0;
          }
          meshes.push(shared.mesh);
        }
      }
    }
    for (const mesh of state.prepared?.meshes ?? []) {
      if (
        ![...materials].some((material) =>
          cellProxyMaterialMatches(mesh.material as Material, material),
        )
      )
        compatible = false;
    }
    return { compatible, triangles, draws, meshes };
  }

  #restoreCellProxySource(state: ICellProxyState): void {
    for (const [mesh, visible] of state.hidden) mesh.visible = visible;
    state.hidden.clear();
  }

  #showCellProxy(state: ICellProxyState, active: boolean, meshes?: readonly Mesh[]): void {
    const prepared = state.prepared;
    if (prepared === undefined) return;
    const changed = state.active !== active;
    // Sources are never released or overwritten. Caster meshes/colliders are untouched.
    this.#restoreCellProxySource(state);
    if (active)
      for (const mesh of meshes ?? this.#cellProxySource(state).meshes) {
        if (mesh.layers.isEnabled(0)) {
          state.hidden.set(mesh, mesh.visible);
          mesh.visible = false;
        }
      }
    prepared.root.visible = active || !this.#proxyObserved(state);
    prepared.meshes.forEach((mesh, index) => {
      const range = prepared.ranges[index];
      if (range !== undefined) mesh.geometry.setDrawRange(range.start, active ? range.count : 0);
    });
    state.active = active;
    if (changed) {
      for (const group of this.#bundles.values()) this.#bumpBundle(group);
      const chunks = this.#chunkBundles.get(state.cell.key)?.group;
      if (chunks !== undefined) this.#bumpBundle(chunks);
    }
  }

  #stepCellProxies(budget: IAdmissionBudget, renderer?: IRendererLike, camera?: Camera): void {
    if (!this.#hlod) return;
    for (const cell of this.#resident.values()) {
      if (cell.cell.proxy === undefined) continue;
      if (cell.proxy === undefined) {
        if (this.#cellLoaded(cell)) budget.admit(() => this.#beginCellProxy(cell));
        continue;
      }
      const state = cell.proxy;
      if (state.cancelled || state.pending) continue;
      if (state.model !== undefined && state.prepared === undefined)
        budget.admit(() => this.#prepareCellProxy(state));
      if (state.cancelled || state.prepared === undefined) continue;
      if (!state.compiled && !state.compiling && renderer !== undefined && camera !== undefined)
        budget.admit(() => this.#compileCellProxy(state, renderer, camera));
      const source = this.#cellProxySource(state);
      const scale = cellProxyWorldScale(this.matrixWorld);
      const sphere = worldSphere(state.prepared.bounds, this);
      sphere.radius = state.prepared.bounds.radius * scale;
      const view =
        camera === undefined
          ? undefined
          : conservativeViewDepth(
              camera,
              sphere.center,
              sphere.radius,
              Reflect.get(camera, "near") ?? 0.1,
            );
      const height = renderer?.domElement.height;
      const selected = state.selector.select({
        sourceReady: this.#cellLoaded(cell),
        proxyReady: state.compiled && this.#proxyObserved(state),
        sourceCompatible: source.compatible && scale > 0,
        sourceTriangles: source.triangles,
        replaceableSourceDraws: source.draws,
        views:
          camera !== undefined &&
          height !== undefined &&
          Number.isFinite(height) &&
          height > 0 &&
          view !== undefined
            ? [
                {
                  camera,
                  viewportHeight: height,
                  ...view,
                  finest: Reflect.get(camera, "isOrthographicCamera") === true || view.degenerate,
                },
              ]
            : [],
        // Collapsing a valid Three transform retains detail; a zero error scale cannot select LOD.
        errorScale: scale === 0 ? 1 : scale,
        maxPixelError: this.#autoLodMaxPixelError,
      });
      this.#showCellProxy(state, selected === "proxy", source.meshes);
    }
  }

  #startChunkLoad(cell: IResidentCell): void {
    const generation = cell.generation;
    const paths: string[] = [];
    for (const chunk of cell.cell.chunks ?? [])
      paths.push(resolveRelative(this.#logicalBase, chunk));
    // A chunk's source is the same loader cache entry an asset's level would be: held while this
    // cell is resident and handed back with the last cell naming the path, through the one
    // `#modelPaths` map. A `loadModel` override parses per load and reaches no cache, so it owns
    // nothing here either; see `#releaseModelPaths`.
    if (this.#loadModel === undefined) this.#retainModelPaths(paths, cell.retainedModelPaths);
    loadAll(
      paths,
      (path) =>
        this.#limiter.load(
          () => this.#model(path),
          () => this.#cellLive(cell, generation),
        ),
      { marker: false },
    ).then(
      (models) => {
        void this.#attachChunks(
          cell,
          generation,
          models.filter((model): model is Object3D => model !== undefined),
        );
      },
      (error: unknown) => {
        cell.chunkFailed = true;
        this.#failures += 1;
        this.#reportCellFailure("chunk", cell.key, paths, error);
      },
    );
  }

  /**
   * Hand the chunk's own buffers to the renderer now, and report how many it took.
   *
   * A compile builds pipelines, not geometry, so the bake's new attributes reached the device on
   * whichever frame first drew them — 826 buffers and 228.8 MB on an 8 s walk, 33 of them over a
   * megabyte, lining up exactly with the p95 and max frame spikes. The backend's own attribute
   * creation is idempotent, so this is a move rather than a second upload, and a renderer with no
   * such seam answers 0 and behaves as it did.
   */
  #uploadAttributes(chunk: Object3D): number {
    const upload = this.#renderer?.uploadAttributes;
    if (upload === undefined) return 0;
    const geometries = new Set<BufferGeometry>();
    chunk.traverse((object) => {
      const mesh = object as Mesh;
      if (mesh.isMesh === true) geometries.add(mesh.geometry);
    });
    return upload(geometries);
  }

  /**
   * Hand this chunk's own textures to the device now, and report how many it took.
   *
   * The same argument as the buffers above, one resource class over: a compile builds pipelines, not
   * pixels, so the bake's textures reached the device inside `_renderObjectDirect` on the frame the
   * chunk first drew — 87 ms of a 94 ms first draw in one frame of a Machinefall map-walk, and 79 ms
   * of 131 ms in another. A texture the world already shares with what is on screen is one early
   * return inside three and no work here.
   */
  #uploadTextures(chunk: Object3D): number {
    const upload = this.#renderer?.uploadTextures;
    if (upload === undefined) return 0;
    return upload(chunk);
  }

  /**
   * Compile a merged chunk before anything can draw it, and report whether the compile came back.
   *
   * A chunk's first draw is the most expensive frame a streaming world has: its own first draw built
   * nodes and a render pipeline synchronously, and one chunk cost **248 ms of a 291 ms walk** in the
   * census that found it. The engine already owns this work — `warmUpScene` drives the renderer's
   * own `compileAsync`, and this is that same call with the world as the target scene, so the chunk's
   * materials resolve the same lights, environment and clipping the real frame will resolve them
   * against. A pipeline compiled against no lights would be a different pipeline, and the frame would
   * still pay for it.
   *
   * It is bounded by `within`, the warm-up's own bound: a compile that never settles is abandoned and
   * the chunk is attached anyway, because a missing chunk is worse than a slow frame. A world that is
   * in no scene is skipped outright — nothing projects it, so a compile would build nothing, which is
   * the same answer `load()` gets, where the loading screen is about to draw it anyway.
   */
  async #warmChunk(chunk: Object3D): Promise<boolean> {
    const renderer = this.#renderer;
    const camera = this.#camera;
    if (renderer === undefined || camera === undefined || this.parent === null) return false;
    // The rejected compile is a pipeline this warm-up could not build, not a reason to fail the
    // admission: the frame that needs it will try again and fail there, where the error belongs.
    return within(
      renderer.compileAsync(chunk, camera, this),
      CHUNK_WARM_TIMEOUT_MS,
      yieldToHost,
      warmClock,
    );
  }

  async #attachChunks(
    cell: IResidentCell,
    generation: number,
    models: readonly Object3D[],
  ): Promise<void> {
    const live = (): boolean => this.#cellLive(cell, generation);
    let attached = 0;
    // Merged and shaped, not yet in the world: the compile below runs between the two, and a cell
    // that left the ring in the middle takes its prepared chunks with it.
    const prepared: { readonly object: Object3D; readonly proxies: number }[] = [];
    try {
      const report = await addInSlices(
        models,
        (object) => {
          if (!live()) return;
          object.name = CHUNK_NAME;
          // One draw per material before the chunk is ever added, so the main pass and every shadow
          // level that redraws it submit the chunk's materials rather than its nodes. A refusal
          // leaves the chunk exactly as authored and is counted: it never costs the chunk itself.
          const merge = mergeChunk(
            object,
            this.#chunkMergeMaxTriangles,
            // A `loadModel` override parses per load, so a chunk's shapes are this world's to
            // release; `assets.model` caches by path and hands the same scene back, so they are not.
            this.#loadModel !== undefined,
            this.#castShadowLevels > 0,
            this.#proxyMaterials,
          );
          // Where the frame budget counts this chunk's main-pass draws (`RenderPassBudget`). Written
          // after the bake and over the whole subtree, because that is the only point where all three
          // outcomes exist at once: a merged group, an instanced mesh the bake kept, and a chunk it
          // refused whole are all one chunk's draws. The proxies the bake built are off layer 0 and
          // keep the `proxies` origin they were given.
          object.traverse((node) => {
            if ((node as Mesh).isMesh !== true || node.layers.isEnabled(0) === false) return;
            node.userData.tnDrawSource = "chunks";
          });
          // The buffers the bake just made, uploaded here rather than on the chunk's first draw,
          // which is the frame that uploads them today: 228.8 MB over 826 `createAttribute` calls
          // in a browser walk, and up to 230 ms inside the frames that first submitted them.
          // `addInSlices` is the admission budget, so this is one chunk per update, never a batch.
          const uploaded = this.#uploadAttributes(object);
          this.#uploadTextures(object);
          if (merge === undefined) this.#failures += 1;
          else {
            this.#failures += merge.failed;
            console.info(
              `TN_WORLD_CHUNK_MERGE meshes=${String(merge.meshes)} draws=${String(merge.draws)} ` +
                `bytes=${String(merge.bytes)} uploaded=${String(uploaded)} ` +
                `instancedExpanded=${String(merge.expanded)} keptInstanced=${String(merge.keptInstanced)} ` +
                `shadowDraws=${String(merge.shadowDraws)}`,
            );
          }
          // Hand-placed chunks are the buildings and set dressing: full shape, so they cast with the
          // near scatter and receive like everything else when the game asks for shadows. A merged
          // opaque mesh the proxy covers keeps receiving and stops casting: the depth pass reads the
          // proxy, so casting from both would pay the bill the proxy was built to remove. The proxy
          // itself is off layer 0 and already carries what the level cameras need of it.
          if (this.#castShadowLevels > 0 || this.#receiveShadow) {
            const covered = new Set(merge?.shadowCovered);
            object.traverse((node) => {
              if (node.layers.isEnabled(0) === false) return;
              node.castShadow = this.#castShadowLevels > 0 && !covered.has(node as Mesh);
              node.receiveShadow = this.#receiveShadow;
            });
          }
          prepared.push({ object, proxies: merge?.shadowDraws ?? 0 });
        },
        { marker: false, while: live },
      );
      if (report.stopped)
        for (let i = report.added; i < models.length; i += 1)
          this.#failures += this.#disposeLoaded(models[i] as Object3D);
      for (const { object, proxies } of prepared) {
        // The compile is the whole point of the wait, and the wait is the only thing between the
        // merge and the attach. Everything the world does not own is released when the cell that
        // asked for the chunk is gone, so a chunk that arrives after its cell left is torn down here
        // rather than compiled and thrown at a world that is not looking.
        if (live()) await this.#warmChunk(object);
        if (!live()) {
          this.#failures += this.#disposeLoaded(object);
          continue;
        }
        cell.chunks.push(object);
        object.traverse((node) => {
          if (node instanceof Mesh && node.layers.isEnabled(0)) cell.mainChunkMeshes.push(node);
        });
        // The chunk's own box, from the merged geometry's boxes rather than its vertices: a chunk
        // is loaded once and both consumers of it are only asked to be no wider than the chunk. Read
        // before `#addChunk`, which may hand part of the subtree to a cell's record and leave the
        // rest behind, so the box is the chunk's whatever ends up where.
        const box =
          proxies > 0 || this.#bundlesWanted ? new Box3().setFromObject(object, false) : undefined;
        this.#addChunk(cell, object);
        // A loaded chunk is placed once and never rewritten: its transforms, geometry and material
        // are the ones the export gave it, so it is the one subtree here with nothing to announce.
        markStatic(object);
        // The proxies' shadow pipelines are the one thing a compile cannot build — three creates a
        // shadow variant on the first pass that draws the caster, and the pass is the levels'. So
        // the levels are told a caster arrived, exactly as a prewarmed caster cluster tells them:
        // the first level whose window covers the chunk submits the proxy and builds it. With one
        // material per `side` world-wide, that is one pipeline for the world's first chunk of each
        // side and a node binding for every chunk after it, not a compile per chunk.
        if (box !== undefined) {
          if (proxies > 0) this.#shadowRecordsMoved(box);
          // A bundled chunk is drawn or not by its cell's record, and that record is answered from
          // the cell's cull volume — which is built from the cell's placements. A chunk is a cell's
          // other half, so a cell holding chunks and no scatter would have an empty volume and never
          // be drawn at all. Widened here rather than shrunk on eviction: the volume outlives one cell
          // whenever a neighbour still holds the cluster, and a stale box only ever shows a cell that
          // is there.
          if (this.#bundlesWanted)
            this.#cullCells.get(clusterOf(cell.x, cell.z, this.#cellsPerCullCell))?.box.union(box);
        }
        attached += 1;
      }
    } catch (error) {
      cell.chunkFailed = true;
      this.#failures += 1;
      this.#reportCellFailure(
        "attach",
        cell.key,
        Array.from(cell.cell.chunks ?? [], (chunk) => resolveRelative(this.#logicalBase, chunk)),
        error,
      );
      for (let i = attached; i < models.length; i += 1)
        this.#failures += this.#disposeLoaded(models[i] as Object3D);
    }
    if (this.#cellLive(cell, generation) && !cell.chunkFailed) cell.chunksLoaded = true;
  }

  #evict(cell: IResidentCell): void {
    if (cell.proxy !== undefined) {
      this.#showCellProxy(cell.proxy, false);
      cell.proxy.cancelled = true;
      cell.proxy.prepared?.root.removeFromParent();
      if (!cell.proxy.pending && !cell.proxy.compiling) this.#releaseCellProxy(cell.proxy);
    }
    this.#residencyEpoch += 1;
    // Every run this cell held goes back to the far mesh BEFORE the near batches below are cleared:
    // the far mesh owns the ORIGINAL roots and this is the same synchronous block, so no frame draws
    // the cell twice or not at all. Skipped at teardown, where the far aggregates are drained whole.
    if (!this.#released) for (const run of cell.cell.runs) this.#restoreFar(run);
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
    if (!this.#released) this.#retryFar();
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
    this.#cancelImpostor(asset);
    this.#releaseImpostor(asset);
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
