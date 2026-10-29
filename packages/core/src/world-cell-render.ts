import type { IAssetState } from "./world-cell-models.js";

import type {
  IAssetPart,
  IBatchShape,
  IBuildJob,
  ICamera,
  ICellBatch,
  IKeyDescriptor,
  IResidentCell,
  IShadowRegion,
  IWorldCellsBudget,
  IWorldCellsFollow,
  IWorldCellsStats,
} from "./world-cell-data.js";
import { PLACEMENT_RECORD_FLOATS, cullDistance, isAlphaFoliage } from "./world-cell-impostors.js";

import { clusterOf, sameLodRanges } from "./world-cell-data.js";

import {
  Box3,
  BufferGeometry,
  type Camera,
  Frustum,
  InstancedMesh,
  type Material,
  Matrix4,
  type Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { renderGroup, uniform } from "three/tsl";
import { BundleGroup } from "three/webgpu";

import { lodChainOf, setLodBias } from "./model-lod.js";
import type { OcclusionMode } from "./render/depth-pyramid.js";

import { parkMesh } from "./render/mesh-pool.js";
import { worldLodMaterial } from "./render/world-impostor-surface.js";
import type { IRendererLike } from "./renderer.js";
import { isStatic, markStatic } from "./static-transform.js";

import { BundleSurfaceSafety, bundleSafe, ownHook } from "./world-bundle-safety.js";
import { type ICasterScaleMesh, SharedBatch, sameSquares } from "./world-cell-batches.js";
import { levelTriangles, release } from "./world-cell-chunks.js";
import { WIDE_CLUSTER } from "./world-cell-prewarm.js";
import {
  CHUNK_NAME,
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
} from "./world-chunk-shadow.js";
import {
  DRAW_ARGS_BYTES,
  type IAssetSlot,
  type ILiveAsset,
  type IMeshDraw,
  type IShadowLevel,
  WorldGpuScene,
  gpuSceneValidationRequested,
  liveKeyInstances,
} from "./world-gpu-scene.js";

import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldPackage,
  type IWorldRun,
  cellPlacements,
} from "./world-package.js";

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
export const MAIN_CULL_SQUARE_METRES = 32;

/**
 * How often `TN_WORLD_MAIN_CULL` is printed. Five seconds is a line a playtest capture can hold and
 * a walk long enough to see the window move; every frame is a wall of text over the marker it would
 * report on.
 */
const MAIN_CULL_MARKER_MS = 5e3;

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

/** The two scratch objects a cull builds its frustum in, and whether two square sets are the same. */
const _cullFrustum = new Frustum();

const _cullProjScreen = new Matrix4();

/** The eye the live-state reference measures every placement's XZ distance from. */
const _gpuEye = new Vector3();

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
export function mainShard(key: string): number {
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
export interface ICellRenderHost {
  asset(id: string): IAssetState | undefined;
  assets(): Iterable<IAssetState>;
  canonical(id: string): string;
  renderer(): IRendererLike | undefined;
  camera(): Camera | undefined;
  now(): number;
  stats(): IWorldCellsStats;
  residentCells(): IterableIterator<IResidentCell>;
  runMax(asset: string): number | undefined;
  widenFilterRange(cell: IResidentCell, x: number, z: number): void;
  addUnchanged(): void;
  disableFar(run: IWorldRun): void;
  deferWide(id: string): void;
  queuedBuilds(): number;
  covered(): boolean;
  prewarmSettled(): boolean;
  awaitDraw(shared: SharedBatch): void;
  carryPrewarm(old: ICasterScaleMesh, next: ICasterScaleMesh): void;
  add(object: Object3D): void;
  isParent(object: Object3D): boolean;
  isBundleHome(shared: SharedBatch): boolean;
}
interface ICellRenderSettings {
  readonly mainCullToldAt: number;
  readonly follow: IWorldCellsFollow;
  readonly budgets: IWorldCellsBudget;
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly manifest: IWorldPackage;
  readonly placements: ArrayBuffer;
  readonly coveredFreshMeshesPerUpdate: number;
  readonly freshMeshesPerUpdate: number;
  readonly receiveShadow: boolean;
  readonly castShadowLevels: number;
  readonly extentBounds: Box3;
  readonly preserveAuthoredParts: boolean;
  readonly lodHysteresis: number;
  readonly lodSpatial: boolean;
  readonly cellsPerCluster: number;
  readonly cellsPerCullCell: number;
  readonly smallCasterMetres: number;
  readonly bundlesWanted: boolean;
  readonly bundleReason: string;
  readonly invalidateShadows: ((region?: IShadowRegion) => void) | undefined;
}

interface IPublishedGpuGates extends IAssetSlot {
  readonly locals: readonly (readonly Float32Array[])[];
}

export class CellRender {
  readonly #budgets: IWorldCellsBudget;

  readonly #cellSize: number;

  readonly #manifest: IWorldPackage;

  readonly #minX: number;

  readonly #minZ: number;

  readonly #placements: ArrayBuffer;

  readonly #freshMeshesPerUpdate: number;

  readonly #coveredFreshMeshesPerUpdate: number;

  /** Fresh meshes created this update, and whether a build waited for next frame's allowance. */
  #freshThisUpdate = 0;

  #meshStalled = false;

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

  readonly #extentBounds: Box3;

  /** How many of an asset's finest levels cast shadows; 0 when the game asked for none. */
  readonly #castShadowLevels: number;

  readonly #receiveShadow: boolean;

  /** Asset bounds height under which a wide caster goes on the finest level's layer only. */
  readonly #smallCasterMetres: number;

  /** The six planes of `#camera`'s frustum, as the live-state reference reads them; reused per check. */
  readonly #gpuPlanes = new Float32Array(24);

  readonly #cellsPerCluster: number;

  /**
   * Streamed records changed since the shadow levels were last told, and when they were last told.
   * One invalidation batch a second, and only for a game that passed the hook: the companions
   * used to make the hook necessary, and now the levels cull clusters themselves.
   */
  // `true` so the first `update` runs a residency pass: `#residencyStale` reads it, and a fresh
  // world has admitted nothing.
  #shadowMoved = true;

  #shadowToldAt = Number.NEGATIVE_INFINITY;

  /**
   * Separate unions of evicted and admitted records since the levels were last told. An unknown
   * region sets `#shadowFull`, so a narrower later change cannot discard the blanket ask.
   */
  #shadowRegion: IShadowRegion | undefined;
  #shadowAdmissionRegion: IShadowRegion | undefined;
  #shadowFull = false;

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

  /** The game's hook to refresh the shadow levels after streamed records changed. */
  readonly #invalidateShadows: ((region?: IShadowRegion) => void) | undefined;

  readonly #position = new Vector3();

  readonly #rotation = new Quaternion();

  readonly #scale = new Vector3();

  readonly #matrix = new Matrix4();

  /** Reused transformed authored bounds for admission and conservative visibility volumes. */
  readonly #recordBounds = new Box3();

  /**
   * The GPU-driven main pass, and whether the world asked for it. Off is byte-for-byte this class's
   * own CPU path: nothing below reads `on` except the four places the option changes what a frame
   * does. See the `gpuScene` load option and `#cullMainPass`.
   */
  readonly #gpuScene = new WorldGpuScene();
  readonly #publishedGpuGates = new Map<string, IPublishedGpuGates>();
  readonly #gpuLevelKeys = new Map<string, Array<{ firstKey: number; parts: number }>>();

  /** Every main key this world has minted a shadow twin for, which is what a level's dispatch asks for. */
  readonly #shadowKeyNames = new Set<string>();

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

  /**
   * The patched renderer's count of PMREM swaps, as of the last flush. A record holds the bind
   * groups it was made with and a replay never refreshes them, so a sky that finishes after the
   * first record would leave every recorded draw sampling the placeholder until a walk re-records.
   */
  #pmremSwaps = 0;

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

  readonly #preserveAuthoredParts: boolean;

  readonly #lodHysteresis: number;
  readonly #lodSpatial: boolean;

  readonly #lodEye = uniform(new Vector3()).setGroup(renderGroup);

  readonly #lodDistanceBias = uniform(1).setGroup(renderGroup);

  readonly #lodMaterials = new Map<
    string,
    { readonly source: Material; readonly material: Material }
  >();

  /** The resident ring has been handed to the scene once; see `#seedGpuSources`. */
  #gpuSeeded = false;

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
  cullMainPass(camera: Camera | undefined): void {
    if (camera === undefined || (camera as ICamera).isOrthographicCamera === true) return;
    this.#bundleSafety.beginFrame();
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
        this.dressGpu(shared, shared.gpu);
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
      this.recordCpuMain(shared, outcome);
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
        if (shared.role === "main" && shared.gpu !== undefined) this.dressGpu(shared, shared.gpu);
      // And every shadow key, for the same reason: minting one grew the twin buffers every other
      // key was dressed against, so a sibling dressed earlier in the loop above is holding the
      // generation the dispatch replaced. The main key's own dress brings its twin with it; this is
      // what closes the seam for the keys whose main key was dressed before the grow.
      for (const shared of [...this.#shared.values()])
        if (shared.role === "key")
          this.dressShadowKey(shared, shared.mesh.name.slice(0, -GPU_KEY_SUFFIX.length));
    }
    // After every key has been dressed, so the asset's answer is the union across its levels and
    // parts.
    this.applyGpuMain(dressed);
    // After the coarse gate, and only for the main camera: an orthographic one — every shadow
    // level's own — returned at the top, so a level's render never dispatches over the main pass's
    // compaction.
    if (gpu.on) gpu.dispatch(this.#host.renderer() as IRendererLike, camera);
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
  applyGpuMain(dressed: readonly { asset: string; shared: SharedBatch }[]): void {
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

  cullResident(cell: IWorldCell): void {
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
      const bounds = this.#manifest.assets[this.#host.canonical(run.asset)]?.bounds;
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
  cullEvicted(cell: IResidentCell): void {
    const name = clusterOf(cell.x, cell.z, this.#cellsPerCullCell);
    const entry = this.#cullCells.get(name);
    if (entry === undefined) return;
    entry.cells -= 1;
    if (entry.cells <= 0) this.#cullCells.delete(name);
  }

  /**
   * The render-cadence dispatch. The engine hands the frame's render camera over, and this world's
   * main windows follow it; see {@link #cullMainPass} for why the decision is not the meshes' own.
   */
  /** New batch meshes this update may create: scaled while the startup cover hides the world. */
  freshAllowance(): number {
    return this.#host.covered() ? this.#coveredFreshMeshesPerUpdate : this.#freshMeshesPerUpdate;
  }

  /**
   * Hand the cell its finished batches and take back the ones they replace, in one step.
   *
   * This is the no-hole rule. Attaching and detaching in the same synchronous block means no frame
   * ever shows the replacement beside the batch it replaces, and a refilter that waits three frames
   * for budget shows the level the cell already had for those three frames rather than nothing.
   */
  swap(job: IBuildJob): boolean {
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
          old.level === fresh.level &&
          old.part === fresh.part &&
          old.batch.equals(fresh.batch) &&
          sameLodRanges(old.lodRanges, fresh.lodRanges),
      );
      if (at < 0) continue;
      const same = job.replaced.splice(at, 1)[0] as ICellBatch;
      this.#host.addUnchanged();
      same.lastFilterY = fresh.lastFilterY;
      same.lastFilterX = fresh.lastFilterX;
      same.lastFilterZ = fresh.lastFilterZ;
      this.#host.widenFilterRange(cell, fresh.lastFilterX, fresh.lastFilterZ);
      job.fresh.splice(index, 1);
      // The batch that stays is the one that was already drawing, so its source records are its own
      // — and a cell the ring built before the scene came up has none. This is the only path that
      // hands them over for a rebuild whose records came out identical, which is every one of them:
      // the records are the same, so the fast path is always the one taken.
      if (this.#gpuScene.on && same.gpu === undefined) same.gpu = this.placeSources(job, same);
    }
    // Every segment first, so a frame out of fresh meshes leaves the old batches drawing whole.
    for (const entry of job.fresh) {
      if (entry.batch.count === 0) continue;
      // Both halves for every fresh entry, whether or not a stalled frame already claimed one:
      // skipping an entry that has its main block meant the retry never asked for its cluster, so
      // those records reached the main pass and no shadow map.
      if (entry.segment < 0) {
        const shared = this.sharedFor(job.asset.id, entry);
        const segment =
          shared === undefined
            ? undefined
            : this.segmentIn(shared, entry.batch.count, this.cullCellOf(cell));
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
      if (!this.claimCaster(job.asset.id, entry, cell)) {
        this.#meshStalled = true;
        return false;
      }
      // The wide half, by the same no-hole rule: a key with a cluster and no wide caster draws into
      // a level that may already be reading the wide layer with nothing in it.
      if (!this.claimWide(job.asset.id, entry)) {
        this.#meshStalled = true;
        return false;
      }
    }
    for (const entry of job.replaced) {
      const at = cell.batches.indexOf(entry);
      if (at >= 0) cell.batches.splice(at, 1);
      this.clearSegment(entry);
    }
    for (const entry of job.fresh) {
      cell.batches.push(entry);
      if (entry.shared !== undefined)
        entry.shared.write(entry.segment, entry.batch, entry.lodRanges);
      if (this.#gpuScene.on) entry.gpu = this.placeSources(job, entry);
      if (entry.caster !== undefined)
        entry.caster.write(entry.casterSegment, entry.batch, entry.lodRanges);
      // The wide half draws the whole-asset impostor at the placement root when this entry kept one,
      // and the source part shape otherwise; see `ICellBatch.wideRoot`.
      if (entry.wide !== undefined)
        entry.wide.write(entry.wideSegment, entry.wideRoot ?? entry.batch, entry.lodRanges);
    }
    // A batch the walk just wrote to, cleared or compacted holds new records, so the shadow levels
    // that drew the old ones are stale. One flag, told at most once a second.
    this.publishGpuGates(job.asset);
    if (job.fresh.some((entry) => entry.batch.count > 0))
      this.shadowRecordsMoved(this.changedBounds(job.fresh), true);
    if (job.replaced.some((entry) => entry.batch.count > 0))
      this.shadowRecordsMoved(this.changedBounds(job.replaced));
    // This run's near representation is attached, so the far mesh stops drawing its original roots in
    // the same synchronous block: a cell is never drawn by both and never by neither. A no-op until
    // the asset's atlas lands; see `#syncFarSegments` for the build-time half and `#restoreFar`.
    this.#host.disableFar(job.run);
    return true;
  }

  /**
   * The world bounds of these records. A missing bound keeps the tell a blanket one.
   */
  changedBounds(batches: readonly ICellBatch[]): Box3 | undefined {
    let union: Box3 | undefined;
    for (const entry of batches) {
      if (entry.batch.count === 0) continue;
      const box = entry.shadowBounds;
      if (
        box === undefined ||
        box.isEmpty() ||
        ![...box.min.toArray(), ...box.max.toArray()].every(Number.isFinite)
      )
        return undefined;
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
  claimCaster(assetId: string, entry: ICellBatch, cell: IResidentCell): boolean {
    const level = this.castLevelOf(entry);
    if (entry.casterSegment >= 0 || level === undefined) return true;
    // Nothing to claim, and nothing to wait for: a world whose levels draw its keys mints no caster
    // half at all (`#casterFor`), so reading that as a spent allowance refused every swap in the
    // world — the main mesh was never attached, no cell published its placements, and the main pass
    // drew nothing while its meshes sat there prewarmed and empty.
    if (this.keysForShadow()) return true;
    const caster = this.casterFor(assetId, entry, cell, level);
    const at = caster === undefined ? undefined : this.segmentIn(caster, entry.batch.count);
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
  claimWide(assetId: string, entry: ICellBatch): boolean {
    const level = this.castLevelOf(entry);
    if (entry.wideSegment >= 0 || level === undefined) return true;
    // A part the asset's one whole-asset representation already covers: the entry keeps its near
    // main and cluster, and the far shadow reads part 0's one quad; see `#wideOwed`.
    if (!this.wideOwed(assetId, entry.part)) return true;
    // As `#claimCaster`: the key twin is this level's wide half, and there is no mesh to wait on.
    if (this.keysForShadow()) return true;
    const wide = this.wideFor(assetId, entry, level);
    // The impostor's far half draws the placement root, not `placement * part local`, so its block
    // is sized to the root records the build kept beside the part's own; see `ICellBatch.wideRoot`.
    const count = entry.wideRoot?.count ?? entry.batch.count;
    const at = wide === undefined ? undefined : this.segmentIn(wide, count);
    if (wide === undefined || at === undefined) return false;
    entry.wide = wide;
    entry.wideSegment = at;
    return true;
  }

  clearSegment(entry: ICellBatch): void {
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
      this.countPlaced(entry, -placed);
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
  shadowRecordsMoved(bounds?: Box3, admission = false): void {
    this.#shadowMoved = true;
    if (
      bounds === undefined ||
      bounds.isEmpty() ||
      ![bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z].every(
        Number.isFinite,
      )
    ) {
      this.#shadowFull = true;
      return;
    }
    const current = admission ? this.#shadowAdmissionRegion : this.#shadowRegion;
    if (current === undefined) {
      const region: IShadowRegion = {
        ...(admission ? { admission: true } : {}),
        max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
        min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
      };
      if (admission) this.#shadowAdmissionRegion = region;
      else this.#shadowRegion = region;
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
   * Tell the shadow levels in up to two calls; covered loading drains without the walk throttle.
   *
   * The companions used to make this the expensive call it still is; the levels redraw from
   * scratch, so the cadence is the only lever and once a second is the one that keeps a walk's
   * frames off the shadow lane without leaving the ground stale behind a player. The region is
   * what the changed records' own bounds add: a hook that forwards it redraws the levels whose
   * window covers them, which for a streaming world is usually the finest one alone.
   */
  tellShadows(covered = false): void {
    if (!this.#shadowMoved) return;
    // No hook means there is no level to tell, so the flag is discharged here. Leaving it set made
    // `#residencyStale` true forever, and every update ran a full residency pass on a world that had
    // nothing left to do.
    if (this.#invalidateShadows === undefined) {
      this.#shadowMoved = false;
      this.#shadowRegion = undefined;
      this.#shadowAdmissionRegion = undefined;
      this.#shadowFull = false;
      return;
    }
    const now = this.#host.now();
    if (!covered && now - this.#shadowToldAt < 1e3) return;
    this.#shadowToldAt = now;
    this.#shadowMoved = false;
    const region = this.#shadowRegion;
    const admission = this.#shadowAdmissionRegion;
    const full = this.#shadowFull;
    this.#shadowRegion = undefined;
    this.#shadowAdmissionRegion = undefined;
    this.#shadowFull = false;
    if (full || (region === undefined && admission === undefined)) this.#invalidateShadows();
    else {
      if (region !== undefined) this.#invalidateShadows(region);
      if (admission !== undefined) this.#invalidateShadows(admission);
    }
  }

  resetShadows(): void {
    this.#shadowMoved = false;
    this.#shadowRegion = undefined;
    this.#shadowAdmissionRegion = undefined;
    this.#shadowFull = false;
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
  publishCasterAdmission(): void {
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
  reportMainCull(): void {
    const now = this.#host.now();
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
    const stats = this.#host.stats();
    console.info(
      `TN_WORLD_MAIN_CULL instances=${String(instances)} drawn=${String(drawn)} ` +
        `hidden=${String(hidden)} castersHidden=${String(castersHidden)} repacks=${String(repacks)} ` +
        `refilters=${String(stats.refilters)} levelRefilters=${String(stats.levelRefilters)} ` +
        `clusterTris=${String(clusterTriangles)} wideTris=${String(wideTriangles)} ` +
        `dressed=${String(dressed)}/${String(mainMeshes)}`,
    );
    console.info(
      `TN_WORLD_SHADOW_ADMISSION clusterWithheld=${String(clusterWithheld)} ` +
        `clusterRecords=${String(clusterRecords)} clusterMissing=${String(clusterMissing)} ` +
        `wideWithheld=${String(wideWithheld)} wideRecords=${String(wideRecords)} ` +
        `wideMissing=${String(wideMissing)} seeded=${String(this.#gpuSeeded)} ` +
        `queued=${String(this.#host.queuedBuilds())}`,
    );
    const hlod = stats.hlod;
    let proxyDraws = 0;
    let replacedSources = 0;
    for (const cell of this.#host.residentCells()) {
      const state = cell.proxy;
      if (state === undefined || !state.active) continue;
      proxyDraws += state.prepared?.meshes.length ?? 0;
      replacedSources += state.hidden.size + state.mainMasks.size;
    }
    const why = hlod.reason === "" ? "" : ` reason=${JSON.stringify(hlod.reason)}`;
    console.info(
      `TN_WORLD_HLOD on=${String(hlod.on)} loaded=${String(hlod.loaded)} ` +
        `compiled=${String(hlod.compiled)} observed=${String(hlod.observed)} ` +
        `active=${String(hlod.active)} pending=${String(hlod.pending)} ` +
        `draws=${String(proxyDraws)} replaced=${String(replacedSources)} ` +
        `bytes=${String(hlod.bytes)} refused=${String(hlod.refused)} failures=${String(hlod.failures)}${why}`,
    );
    // The bundles on their own line, because the pair reads against a different question: how many
    // objects are recorded, and how many times the recording was thrown away and redone. A walk
    // streaming and culling holds `records` at the keys and chunks that came and went; a walk that
    // repacks it every frame is drawing a moving set, which is the bug a bundle cannot have. `reason`
    // is on it because the default is now on: a reader has to be able to tell a run that turned it
    // off from a run where recording never happened.
    const bundles = stats.bundle;
    console.info(
      `TN_WORLD_BUNDLE ${bundles.on ? "on" : "off"} reason=${bundles.reason} ` +
        `children=${String(bundles.children)} cpuMeshes=${String(bundles.cpuMeshes)} gpuMeshes=${String(bundles.gpuMeshes)} records=${String(bundles.records)}`,
    );
  }

  /** The main pass's one mesh for an asset part at a level, covering every resident cell. */
  sharedFor(assetId: string, entry: ICellBatch): SharedBatch | undefined {
    return this.batchFor(assetId, entry, this.keyOf(entry), "main", this.#receiveShadow);
  }

  /**
   * The shadow-caster cluster for one asset part at one level, or `undefined` when the level does
   * not cast or the frame's fresh allowance is spent.
   *
   * One per `(key, cluster)`, on `VIRTUAL_SHADOW_CASTER_LAYER` and off the main camera, so a level
   * culls the clusters its own window covers while the main pass keeps drawing one mesh per key.
   */
  casterFor(
    assetId: string,
    entry: ICellBatch,
    cell: IResidentCell,
    level = entry.level,
  ): SharedBatch | undefined {
    // A world whose shadow levels draw its keys mints no cluster: the two are the same placements by
    // two routes, and a level's map can only draw one of them.
    if (!this.casts(level) || this.keysForShadow()) return undefined;
    return this.batchFor(
      assetId,
      entry,
      `${this.keyOf(entry, level)}@${this.clusterOf(cell)}`,
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
  wideFor(assetId: string, entry: ICellBatch, level = entry.level): SharedBatch | undefined {
    // As `#casterFor`: the key twin replaces both halves, so neither is minted.
    if (!this.casts(level) || this.keysForShadow()) return undefined;
    // A generated whole-asset impostor is one shape for every part and level, so its far shadow is
    // ONE mesh per asset holding root records. Preserved authored parts keep per-key wide casters.
    const impostor =
      !this.#preserveAuthoredParts && this.#host.asset(assetId)?.impostor !== undefined;
    const key = impostor
      ? `${assetId}:*@${WIDE_CLUSTER}`
      : `${this.keyOf(entry, level)}@${WIDE_CLUSTER}`;
    return this.batchFor(assetId, entry, key, "wide", false, level);
  }

  /** `asset:level:part`, the main pass's one mesh per key. */
  keyOf(entry: ICellBatch, level = entry.level): string {
    return `${entry.asset}:${String(level)}:${String(entry.part)}`;
  }

  /**
   * The level a cell batch casts with: its own when that level casts, otherwise the coarsest
   * casting level, when that level holds the same parts — a chain's derived levels do, authored
   * `lods` need not — so a tree past `castLevels` keeps its shadow in the last shape that has a
   * caster rather than leaving a hole in the map (PRD-541). `undefined`: it casts nothing.
   */
  castLevelOf(entry: ICellBatch): number | undefined {
    if (this.casts(entry.level)) return entry.level;
    if (this.#castShadowLevels === 0) return undefined;
    const asset = this.#host.asset(entry.asset);
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
  keysForShadow(): boolean {
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
  shadowKeyFor(key: IKeyDescriptor, part: IAssetPart): void {
    // Registered here rather than at construction, because it is a question about keys that exist:
    // a level's dispatch asks the provider for the keys a map draws, and the answer is this world's.
    // Without a provider the scene registers nothing, which is what keeps the flag from minting
    // anything at all; see `shadowGpuKeysRequested`.
    this.#gpuScene.shadowKeysFrom(() => this.#shadowKeyNames);
    if (this.keysForShadow() === false || this.casts(key.level) === false) return;
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
        this.#retiredBytes -= this.heldBytes(released);
        shared = released;
      } else {
        // A fresh mesh is charged against the frame's allowance like any other; the walk that runs
        // out of it comes back for this key rather than paying its build inside a shadow render.
        if (this.#freshThisUpdate >= this.freshAllowance()) return;
        this.#freshThisUpdate += 1;
        shared = new SharedBatch(
          part.geometry,
          part.material,
          1,
          1,
          name,
          this.#extentBounds,
          "key",
          key.level,
        );
      }
      shared.rebind(part.geometry, part.material);
      shared.mesh.name = name;
      this.dressMesh(shared, false);
      this.#shared.set(name, shared);
      this.attach(shared);
      // Owed a draw, and shown because it is empty: a key is submitted by a shadow level, so the
      // build behind the gate is the prewarm's whole job. Only while the gate is still open — a key
      // streamed in afterwards owes nothing, exactly as a streamed caster half does not.
      if (this.#host.prewarmSettled() === false) this.#host.awaitDraw(shared);
    }
    this.dressShadowKey(shared, key.key);
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
  dressShadowKey(shared: SharedBatch, key: string): void {
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
      this.#host.carryPrewarm(mesh, next);
      this.seat(shared.replaceMesh(next), next);
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
  wideShape(
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

  shapeFor(
    entry: ICellBatch,
    role: "cluster" | "key" | "main" | "wide",
    level = entry.level,
  ): IBatchShape {
    // A batch cast at a finer level than its own (`#castLevelOf`) draws that level's part.
    const own =
      level === entry.level
        ? { geometry: entry.batch.geometry, material: entry.batch.material }
        : (this.#host.asset(entry.asset)?.levels[level]?.[entry.part] as IAssetPart);
    const shape =
      role === "wide"
        ? this.wideShape(this.#host.asset(entry.asset), level, entry.part, {
            geometry: own.geometry,
            material: own.material,
          })
        : { geometry: own.geometry, material: own.material };
    return {
      ...shape,
      material: this.#lodSurface(entry.asset, level, entry.part, shape.material),
    };
  }

  #lodSurface(assetId: string, level: number, partIndex: number, source: Material): Material {
    const asset = this.#host.asset(assetId);
    const part = asset?.levels[level]?.[partIndex];
    if (this.#lodHysteresis <= 0 || !asset || !part || asset.distances.length < 2) return source;
    const publishedRanges = !this.#gpuScene.on;
    const key = `${assetId}:${level}:${partIndex}:${asset.distances.length}:${publishedRanges ? 1 : 0}`;
    let cached = this.#lodMaterials.get(key);
    if (cached !== undefined && cached.source !== source) {
      cached.material.dispose();
      this.#lodMaterials.delete(key);
      cached = undefined;
    }
    if (cached === undefined) {
      const material = worldLodMaterial(
        source,
        part.local,
        asset.distances,
        level,
        this.#lodHysteresis,
        this.#lodEye,
        this.#lodDistanceBias,
        this.#lodSpatial,
        publishedRanges,
      );
      cached = { source, material };
      this.#lodMaterials.set(key, cached);
    }
    return cached.material;
  }

  updateLodEye(x: number, y: number, z: number): void {
    this.#lodEye.value.set(x, y, z);
  }

  refreshLodMaterials(asset: IAssetState): void {
    for (const shared of this.#shared.values()) {
      if (!shared.mesh.name.startsWith(`${asset.id}:`)) continue;
      const [levelText, partText] = shared.mesh.name.slice(asset.id.length + 1).split(":");
      const level = Number(levelText);
      const partIndex = Number(partText?.split("@")[0]);
      const part = asset.levels[level]?.[partIndex];
      if (part !== undefined) {
        const material = this.#lodSurface(asset.id, level, partIndex, part.material);
        if (
          material.userData.tnPublishedLodRange === true &&
          shared.mesh.geometry.getAttribute("tnPublishedLodRange") === undefined &&
          shared.mesh.count === 0
        )
          shared.rebind(part.geometry, material);
        else shared.mesh.material = material;
        this.bundleOut(shared);
        this.bundleIn(shared);
      }
    }
  }

  impostorDrawn(): number {
    let drawn = 0;
    for (const shared of this.#shared.values()) {
      if (
        shared.role === "main" &&
        shared.mesh.visible &&
        Reflect.get(shared.mesh.material, "userData")?.tnWholeAssetImpostor === true
      )
        drawn += shared.live;
    }
    return drawn;
  }

  /**
   * Whether this entry owes a wide caster. Generated whole-asset impostors use only part 0; preserved
   * authored parts retain each part's own caster and transform.
   */
  wideOwed(assetId: string, part: number): boolean {
    if (part === 0) return true;
    return this.#preserveAuthoredParts || this.#host.asset(assetId)?.impostor === undefined;
  }

  /** The `@x,z` half of a caster cluster key, for a resident cell. */
  clusterOf(cell: IResidentCell): string {
    return clusterOf(cell.x, cell.z, this.#cellsPerCluster);
  }

  /**
   * The `@x,z` half of the main cull's own visibility-cell key, for a resident cell. This is what a
   * main batch's blocks are grouped by and what `#cullMainPass` tests, so it is the granularity the
   * main pass is culled at; the caster clusters above are the shadow levels' and are left alone.
   */
  cullCellOf(cell: IResidentCell): string {
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
  batchFor(
    assetId: string,
    entry: ICellBatch,
    key: string,
    role: "cluster" | "key" | "main" | "wide",
    receiveShadow: boolean,
    level = entry.level,
  ): SharedBatch | undefined {
    const existing = this.#shared.get(key);
    if (existing !== undefined && this.#lodHysteresis === 0) return existing;
    const shape = this.shapeFor(entry, role, level);
    if (existing !== undefined) {
      const rebind =
        shape.material.userData.tnPublishedLodRange === true &&
        existing.mesh.geometry.getAttribute("tnPublishedLodRange") === undefined &&
        existing.mesh.count === 0;
      // The same surface on the same buffer: re-recording it on every call re-walked its whole node
      // graph each time a cell asked for the key (3 s of a 25 s Strata trace). The cached check still
      // re-reads the material's shallow state and hooks, and re-records only when its verdict moved.
      if (!rebind && existing.mesh.material === shape.material) {
        this.bundleIn(existing, true);
        return existing;
      }
      if (rebind) existing.rebind(shape.geometry, shape.material);
      else existing.mesh.material = shape.material;
      this.bundleOut(existing);
      this.bundleIn(existing);
      return existing;
    }
    const smallCaster = this.smallCaster(assetId);
    // The batch released when this asset's last cell left the ring is the one to draw into again,
    // so the mesh keeps the uuid and the node three built for it. It costs no fresh allowance,
    // because it is not a fresh mesh.
    const released = this.#retired.get(key);
    if (released !== undefined) {
      this.#retired.delete(key);
      this.#retiredBytes -= this.heldBytes(released);
      released.rebind(shape.geometry, shape.material);
      released.mesh.name = key;
      released.smallCaster = smallCaster;
      this.dressMesh(released, receiveShadow);
      // A rebind swaps the geometry and may swap the buffer, so the key is dressed again: the indirect
      // record and the shared matrix buffer belong to the mesh, not to the batch.
      this.adoptGpu(released, entry.asset, key, level, entry.part);
      this.#shared.set(key, released);
      this.attach(released);
      return released;
    }
    if (this.#freshThisUpdate >= this.freshAllowance()) return undefined;
    this.#freshThisUpdate += 1;
    const shared = new SharedBatch(
      shape.geometry,
      shape.material,
      this.#host.runMax(assetId) ?? entry.batch.count,
      // A caster cluster's block count is bounded by the cluster's own cells; a wide caster and the
      // main pass's one mesh per key are both bounded by the whole ring, so either way the one a
      // refilter holds beside the block it replaces.
      role === "cluster"
        ? this.#cellsPerCluster * this.#cellsPerCluster + 1
        : this.#budgets.residentCells + 1,
      key,
      this.#extentBounds,
      role,
      level,
    );
    shared.smallCaster = smallCaster;
    this.dressMesh(shared, receiveShadow);
    this.adoptGpu(shared, entry.asset, key, level, entry.part);
    this.#shared.set(key, shared);
    this.attach(shared);
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
  dressMesh(shared: SharedBatch, receiveShadow: boolean): void {
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
  bundleIn(shared: SharedBatch, reuseSafety = false): void {
    if (this.#bundlesWanted === false) return;
    // Shared batches normally carry one material. A mutable array keeps the existing per-object path
    // rather than compressing several material identities/revisions into an incomplete signature.
    const arrayMaterial = Array.isArray(shared.mesh.material);
    const checked =
      reuseSafety && !arrayMaterial
        ? this.#bundleSafety.test(shared.mesh.material as Material)
        : undefined;
    shared.bundlable =
      lodChainOf(shared.mesh.geometry) === undefined &&
      (reuseSafety
        ? checked !== undefined &&
          !ownHook(shared.mesh, "onBeforeRender") &&
          !ownHook(shared.mesh, "onAfterRender") &&
          Reflect.get(shared.mesh, "isSkinnedMesh") !== true &&
          shared.mesh.morphTargetInfluences === undefined &&
          checked.safe
        : bundleSafe(shared.mesh));
    if (shared.bundlable === false) {
      if (shared.bundled) this.bundleOut(shared);
      // A previously culled key may already be detached. Refusal still owes its live source draw.
      if (!this.#host.isParent(shared.mesh)) this.#host.add(shared.mesh);
      return;
    }
    const group = this.shardOf(shared);
    if (checked !== undefined) {
      if (shared.bundled && shared.bundleMaterialRevision !== checked.revision)
        this.bumpBundle(group);
      shared.bundleMaterialRevision = checked.revision;
    }
    if (shared.mesh.parent !== group) {
      group.add(shared.mesh);
      if (reuseSafety) this.bumpBundle(group);
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
  bundleOut(shared: SharedBatch): void {
    if (shared.bundled === false) return;
    shared.bundled = false;
    shared.bundledCount = -1;
    shared.mesh.userData.tnBundled = false;
    // Back on the per-object path, so the mesh's own whole-mesh test is its gate again.
    shared.mesh.frustumCulled = true;
    const group = this.#bundles.get(mainShard(shared.mesh.name));
    if (group === undefined) return;
    if (shared.mesh.parent === group) group.remove(shared.mesh);
    this.bumpBundle(group);
  }

  /** One re-record, counted: `BundleGroup.needsUpdate` is a version bump, and nothing else. */
  bumpBundle(group: BundleGroup): void {
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
  recordCpuMain(shared: SharedBatch, outcome: "settled" | "narrowed" | "repacked"): void {
    if (this.#bundlesWanted === false) return;
    // `#publish` has just written this frame's answer onto the mesh, which is the only place it is.
    if (shared.mesh.visible === false) {
      this.bundleOut(shared);
      return;
    }
    this.bundleIn(shared, true);
    if (shared.bundled === false) return;
    // The count a record freezes, and the layout behind it: a repack moves records inside the window
    // without moving its length, so the epoch answer and the count are both read here.
    if (outcome === "settled" && shared.mesh.count === shared.bundledCount) return;
    shared.bundledCount = shared.mesh.count;
    this.bumpBundle(this.shardOf(shared));
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
  addChunk(cell: IResidentCell, chunk: Object3D): void {
    if (this.#bundlesWanted === false) {
      this.#host.add(chunk);
      return;
    }
    // What the record can hold, and whether anything had to be left behind. A chunk whose every draw
    // is recorded goes in whole, which is one entry per chunk; a chunk holding a draw a bundle cannot
    // replay stays in the world and hands its safe draws to the record on their own, so one glass
    // window does not put the whole building back on the per-object path. See `bundleSafe`.
    const draws = chunkDraws(chunk);
    const recorded = draws.filter(
      (mesh) => lodChainOf(mesh.geometry) === undefined && bundleSafe(mesh),
    );
    if (recorded.length === 0) {
      this.#host.add(chunk);
      return;
    }
    let entry = this.#chunkBundles.get(cell.key);
    if (entry === undefined) {
      const group = new BundleGroup();
      group.name = `${CHUNK_NAME}-bundles:${cell.key}`;
      this.#host.add(group);
      entry = { cluster: clusterOf(cell.x, cell.z, this.#cellsPerCullCell), group };
      this.#chunkBundles.set(cell.key, entry);
    }
    const whole = recorded.length === draws.length;
    if (whole) entry.group.add(chunk);
    else {
      // The chunk keeps its own hierarchy around whatever it could not record, and each recorded
      // draw is attached rather than added so it keeps the world transform it was merged at. The root
      // it came out of travels with it, because that is what releases the draw again.
      this.#host.add(chunk);
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
    this.bumpBundle(entry.group);
  }

  /**
   * Take a cell's chunk record out of the world, because the cell that owned every chunk in it has
   * left: a record nothing owns must not be replayed, and the cell coming back mints its own.
   *
   * A chunk the bake split left its recorded draws in the group rather than under their own root, so
   * each goes back to the root it came out of first: the caller's own disposal walk finds them there,
   * and a draw released by neither is a buffer nothing ever asks for again.
   */
  dropChunkBundles(cell: IResidentCell): void {
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
    this.bumpBundle(entry.group);
  }

  /** The main-record shard a batch's key lands in, minted as a child of the world on first use. */
  shardOf(shared: SharedBatch): BundleGroup {
    const shard = mainShard(shared.mesh.name);
    let group = this.#bundles.get(shard);
    if (group === undefined) {
      group = new BundleGroup();
      group.name = "world-main-bundles";
      this.#host.add(group);
      this.#bundles.set(shard, group);
    }
    return group;
  }

  /** The recorded main batches, over every shard. */
  mainBundleChildren(): number {
    let children = 0;
    for (const group of this.#bundles.values()) children += group.children.length;
    return children;
  }

  /**
   * Where a freshly bound or grown main batch's mesh goes: the bundle group when it has been dressed
   * into one, the world otherwise. Three re-parents on `add`, so a bundled mesh has to be asked for
   * or it silently leaves the group it was recorded in.
   */
  attach(shared: SharedBatch): void {
    // A grow replaces the mesh object, so the marker `#bundleIn` set has to follow the batch's own
    // flag onto it. See `bundled`.
    shared.mesh.userData.tnBundled = shared.bundled;
    if (shared.bundled === true) this.shardOf(shared).add(shared.mesh);
    else this.#host.add(shared.mesh);
    // A record holds the object it was cut from, so a mesh that arrived by a rebind or a grow is not
    // the one the last record named: one re-record, and the record counts this mesh from here.
    if (shared.bundled === true) {
      shared.mesh.frustumCulled = false;
      shared.bundledCount = shared.mesh.count;
      this.bumpBundle(this.shardOf(shared));
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
  adoptGpu(shared: SharedBatch, assetId: string, key: string, level: number, part: number): void {
    if (shared.role !== "main") return;
    const named = { asset: this.#host.canonical(assetId), key, level, part };
    shared.main = named;
    if (this.#gpuScene.on === false) return;
    shared.gpu = named;
    this.dressGpu(shared, named);
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
  dressGpu(shared: SharedBatch, key: IKeyDescriptor): void {
    const scene = this.#gpuScene;
    const asset = this.#host.asset(key.asset);
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
      this.#host.isBundleHome(shared)
    ) {
      // A sibling may have grown the level's capacity without moving this mesh, so the submission
      // bound follows the live region rather than the dress that wrote it. See `gpuCount`.
      shared.gpuCount = held?.capacity ?? shared.gpuCount;
      this.shadowKeyFor(key, part);
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
    const levels = this.#gpuLevelKeys.get(key.asset) ?? [];
    levels[key.level] = {
      firstKey: region - key.part,
      parts: asset.levels[key.level]?.length ?? 0,
    };
    this.#gpuLevelKeys.set(key.asset, levels);
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
      this.#host.carryPrewarm(mesh, next);
      this.seat(shared.replaceMesh(next), next);
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
    scene.slot(key.asset, this.gatesOf(key.asset, asset));
    // The origin this key's main-pass draws are counted under, read off the object at the draw
    // (`RenderPassBudget`). Written after the mesh swap above, so a re-dressed fresh object carries
    // it, and before `#bundleIn`, which supersedes it with `tnBundled` for a world with bundles on.
    shared.mesh.userData.tnDrawSource = "gpuScene";
    // The bundle the last settled frame replayed is now wrong: this pass minted or regrown a key,
    // swapped the geometry, or took a fresh mesh object onto the scene's new buffers. Reaching here
    // is one of the three, which is why this is the only place a re-record happens — the fast path
    // above is every other frame of the walk.
    this.bundleIn(shared);
    if (shared.bundled === true) this.bumpBundle(this.shardOf(shared));
    // The shadow twin of this key, minted and dressed on the same pass that named the main one: a
    // level that draws keys finds its mesh in the same frame the main pass found its buffer, and a
    // regrown twin is re-dressed here rather than left on the buffer the dispatch replaced.
    this.shadowKeyFor(key, part);
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
  seat(old: InstancedMesh, next: InstancedMesh): void {
    const parent = old.parent;
    if (parent === null) this.#host.add(next);
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
  publishGpuGates(asset: IAssetState): void {
    const gates = this.gatesOf(asset.id, asset);
    this.#publishedGpuGates.set(asset.id, {
      cull: gates.cull,
      distances: [...gates.distances],
      impostor: gates.impostor,
      shadowFallback: gates.shadowFallback,
      levels: gates.levels.map((level) => ({ ...level })),
      locals: asset.levels.map((parts) =>
        parts.map((part) => Float32Array.from(part.local.elements)),
      ),
    });
  }

  gatesOf(id: string, asset: IAssetState): IAssetSlot {
    const gates: { firstKey: number; parts: number }[] = [];
    // The level's own contiguous run, which is what the kernel's `firstKey + part` addresses. The
    // owner records it when dressing the key; reading it back from the scene would make the mesh
    // check agree with a corrupted GPU gate table instead of checking that table independently.
    const keyed = this.#gpuLevelKeys.get(id);
    for (const [level] of asset.levels.entries())
      gates.push(keyed?.[level] ?? { firstKey: 0, parts: 0 });
    return {
      cull: cullDistance(asset.definition.maxDistance),
      distances: asset.distances,
      // A generated terminal gate is based on the unit asset sphere and scales per placement. An
      // authored impostorDistance is already a world-metre cutoff and stays fixed across scales.
      impostor: asset.impostor !== undefined && asset.definition.impostorDistance === undefined,
      shadowFallback: asset.definition.lods === undefined,
      levels: gates,
    };
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
  seedGpuKeys(): void {
    for (const shared of [...this.#shared.values()]) this.seedGpuKey(shared);
    for (const shared of this.#retired.values()) this.seedGpuKey(shared);
  }

  /** Dress one undressed main batch, or leave a batch the scene does not touch. */
  seedGpuKey(shared: SharedBatch): void {
    // `main` is the key; `gpu` is the mesh pointing at the scene's buffers. A dressed mesh is left
    // alone, and `#dressGpu` says so itself — it is idempotent against the buffers it was given.
    if (shared.main === undefined || shared.gpu !== undefined) return;
    this.dressGpu(shared, shared.main);
  }

  /**
   * The main meshes the scene owns and the main meshes the world holds, live and pooled, which is
   * the `dressed=N/M` the marker carries. A scene reporting itself on over a ring it never dressed
   * read `dressed=0/21094` on nothing, so the number is the owner's: the scene cannot see the meshes.
   */
  gpuCensus(): { readonly dressed: number; readonly meshes: number } {
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
  gpuDraws(): readonly IMeshDraw[] {
    const camera = this.#host.camera();
    if (camera === undefined) return [];
    const lives = this.liveGates();
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
  liveGates(): Map<string, ILiveAsset> {
    const out = new Map<string, ILiveAsset>();
    const slots = this.#gpuScene.gates();
    for (const [slot] of slots.entries()) {
      const id = this.#gpuScene.slotAsset(slot);
      const asset = id === undefined ? undefined : this.#host.asset(id);
      const published = id === undefined ? undefined : this.#publishedGpuGates.get(id);
      if (asset === undefined || published === undefined) continue;
      out.set(asset.id, {
        cull: published.cull,
        distances: published.distances,
        id: asset.id,
        impostor: published.impostor,
        locals: published.locals,
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
  placeSources(job: IBuildJob, entry: ICellBatch): number[] | undefined {
    const sources = job.sources;
    if (sources === undefined) return undefined;
    const asset = this.#host.asset(entry.asset);
    if (asset === undefined) return undefined;
    const slot = this.#gpuScene.slot(entry.asset, this.gatesOf(entry.asset, asset));
    if (slot < 0) return undefined;
    const byLevel = job.gpuByLevel ?? new Map<number, number[]>();
    job.gpuByLevel = byLevel;
    const held = byLevel.get(entry.level);
    // A sibling part of this level shares the list already placed, and counts its own halves for
    // itself: `#gpuResident` is the asset's, so this half's records are counted here.
    if (held !== undefined) {
      this.countPlaced(entry, held.length);
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
    this.countPlaced(entry, records.length);
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
  countPlaced(entry: ICellBatch, placed: number): void {
    if (entry.caster !== undefined) entry.caster.gpuPlaced += placed;
    if (entry.wide !== undefined) entry.wide.gpuPlaced += placed;
  }

  /** The world-grid square the follow point is in, as the `@x,z` half of a cluster key. */
  followCluster(): string {
    return clusterOf(
      Math.floor((this.#follow.position.x - this.#minX) / this.#cellSize),
      Math.floor((this.#follow.position.z - this.#minZ) / this.#cellSize),
      this.#cellsPerCluster,
    );
  }

  /** What a released batch costs to keep: its instance buffer, which is all of it. */
  heldBytes(shared: SharedBatch): number {
    return (shared.mesh.instanceMatrix.array as Float32Array).byteLength;
  }

  /**
   * Keeps a released batch for the walk back, or drops it.
   *
   * Empty is the precondition, and `#evict` guarantees it: it clears a cell's own block before the
   * refcount falls, and the refcount is what calls this. A batch that still holds records means the
   * buffer state cannot be trusted, so it goes the same way as one over the byte budget.
   */
  retire(key: string, shared: SharedBatch): void {
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
    const bytes = this.heldBytes(shared);
    this.#retired.delete(key);
    this.#retired.set(key, shared);
    this.#retiredBytes += bytes;
    for (const [oldest, held] of this.#retired) {
      if (this.#retiredBytes <= RETIRED_SHARED_BYTES) break;
      this.#retired.delete(oldest);
      this.#retiredBytes -= this.heldBytes(held);
      held.mesh.dispose();
    }
  }

  /**
   * Whether this level's own batches cast. Only the caster clusters ask; a main mesh never casts, so
   * the shadow map holds exactly the cluster meshes a level's window covers.
   */
  casts(level: number): boolean {
    return this.#castShadowLevels > level;
  }

  /**
   * An asset too small to resolve in any window but the finest one's, so its wide caster goes on
   * that level's layer alone. Measured on the authored bounds the package carries, which is the one
   * number a world has for every asset it never loaded a tree for.
   */
  smallCaster(assetId: string): boolean {
    const bounds = this.#manifest.assets[assetId]?.bounds;
    if (bounds === undefined) return false;
    return bounds.max[1] - bounds.min[1] < this.#smallCasterMetres;
  }

  /**
   * A block in `shared` for one cell's `count` records, growing the buffer when it is full. `cluster`
   * is the world-grid square the cell sits in, and only a main batch keeps it: its draw window is
   * narrowed per square, and a square is a grouping, not a position.
   */
  segmentIn(shared: SharedBatch, count: number, cluster?: string): number | undefined {
    const segment = shared.allocate(count, cluster);
    if (segment !== undefined) return segment;
    // A dressed batch's grow is logical: it raises the ceiling the GPU scene sizes this key's region
    // from and mints no mesh, so the fresh-mesh allowance — which bounds new pooled meshes and their
    // node builds — does not gate it. A CPU grow is a real replacement mesh and still respects it.
    if (shared.gpu === undefined && this.#freshThisUpdate >= this.freshAllowance())
      return undefined;
    const old = shared.grow();
    // Only a real replacement is a new object to dress, attach and hand to the pool; a logical GPU
    // grow keeps the live mesh, which `#dressGpu` re-points at the grown region before the draw.
    if (old !== undefined) {
      this.#freshThisUpdate += 1;
      // The replacement is a different object, so the layer and the cull hook `grow` copied neither of
      // have to be dressed onto it again — a grown caster that kept layer 0 would be drawn by the main
      // camera and lost to the shadow level, and a grown main batch would stop narrowing at all.
      this.dressMesh(shared, shared.role === "main" && this.#receiveShadow);
      this.attach(shared);
      // The mesh this grow replaced goes back to the pool: a cached shadow level can still replay a
      // draw of it until its window next moves, and the pool keeps the buffer and the uuid rather
      // than letting one array of retired meshes grow without bound.
      parkMesh(old);
    }
    return shared.allocate(count, cluster);
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
  retargetWideCasters(asset: IAssetState): void {
    const impostor = asset.impostor;
    if (impostor === undefined) return;
    const globalKey = `${asset.id}:*@${WIDE_CLUSTER}`;
    for (const cell of this.#host.residentCells())
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
        if (!this.casts(entry.level) || !this.wideOwed(asset.id, entry.part)) continue;
        const source = entry.wideRoot;
        if (source === undefined) continue;
        const wide = this.batchFor(asset.id, entry, globalKey, "wide", false);
        const at = wide === undefined ? undefined : this.segmentIn(wide, source.count);
        if (wide === undefined || at === undefined) {
          this.#host.deferWide(asset.id);
          continue;
        }
        entry.wide = wide;
        entry.wideSegment = at;
        wide.gpuPlaced += placed;
        wide.write(at, source);
      }
    this.retireWideKeys(asset.id, globalKey);
  }

  /** Give the asset's pre-bake per-key wide meshes back, once the handoff has emptied them. */
  retireWideKeys(assetId: string, keep: string): void {
    const prefix = `${assetId}:`;
    for (const [key, shared] of [...this.#shared]) {
      if (key === keep || shared.role !== "wide" || !key.startsWith(prefix)) continue;
      if (shared.live > 0) continue;
      shared.mesh.removeFromParent();
      this.bundleOut(shared);
      this.#shared.delete(key);
      this.retire(key, shared);
    }
  }

  /** Releases the shared meshes of one asset (or of every asset), keeping them for the walk back. */
  drainShared(assetId?: string): number {
    const failed = 0;
    for (const [key, shared] of this.#shared) {
      if (assetId !== undefined && !key.startsWith(`${assetId}:`)) continue;
      shared.mesh.removeFromParent();
      // The mesh is out of the world, so it is out of the bundle the world recorded. A key that comes
      // back is minted or rebound into the group again, and each of those is one re-record.
      this.bundleOut(shared);
      this.#shared.delete(key);
      // Retired, not dropped, so the cell that comes back draws into the same mesh.
      this.retire(key, shared);
    }
    return failed;
  }
  readonly #follow: IWorldCellsFollow;
  readonly #host: ICellRenderHost;
  constructor(settings: ICellRenderSettings, host: ICellRenderHost) {
    this.#host = host;
    this.#follow = settings.follow;
    this.#budgets = settings.budgets;
    this.#cellSize = settings.cellSize;
    this.#minX = settings.minX;
    this.#minZ = settings.minZ;
    this.#manifest = settings.manifest;
    this.#placements = settings.placements;
    this.#coveredFreshMeshesPerUpdate = settings.coveredFreshMeshesPerUpdate;
    this.#freshMeshesPerUpdate = settings.freshMeshesPerUpdate;
    this.#receiveShadow = settings.receiveShadow;
    this.#castShadowLevels = settings.castShadowLevels;
    this.#extentBounds = settings.extentBounds;
    this.#preserveAuthoredParts = settings.preserveAuthoredParts;
    this.#lodHysteresis = settings.lodHysteresis;
    this.#lodSpatial = settings.lodSpatial;
    this.#cellsPerCluster = settings.cellsPerCluster;
    this.#cellsPerCullCell = settings.cellsPerCullCell;
    this.#smallCasterMetres = settings.smallCasterMetres;
    this.#bundlesWanted = settings.bundlesWanted;
    this.#bundleReason = settings.bundleReason;
    this.#invalidateShadows = settings.invalidateShadows;
    this.#mainCullToldAt = settings.mainCullToldAt;
  }

  get gpuOn(): boolean {
    return this.#gpuScene.on;
  }
  get shadowMoved(): boolean {
    return this.#shadowMoved;
  }
  get meshStalled(): boolean {
    return this.#meshStalled;
  }
  get gpuSeeded(): boolean {
    return this.#gpuSeeded;
  }
  set gpuSeeded(value: boolean) {
    this.#gpuSeeded = value;
  }
  get bundlesWanted(): boolean {
    return this.#bundlesWanted;
  }
  bundleGroup(shard: number): BundleGroup | undefined {
    return this.#bundles.get(shard);
  }
  hasShared(key: string): boolean {
    return this.#shared.has(key);
  }
  hasRetired(key: string): boolean {
    return this.#retired.has(key);
  }
  setShared(key: string, shared: SharedBatch): void {
    this.#shared.set(key, shared);
  }
  intersectsObject(mesh: Object3D): boolean {
    return _cullFrustum.intersectsObject(mesh);
  }
  dispatchShadow(renderer: IRendererLike, level: IShadowLevel): void {
    this.#gpuScene.dispatchShadow(renderer, level);
  }
  setLodBias(bias: number): void {
    this.#lodDistanceBias.value = Number.isFinite(bias) && bias >= 1 ? bias : 1;
    this.#gpuScene.setLodBias(bias);
  }
  report(): ReturnType<WorldGpuScene["report"]> {
    return this.#gpuScene.report();
  }
  resetFresh(): void {
    this.#freshThisUpdate = 0;
    this.#meshStalled = false;
  }
  clearCompileRecords(): void {
    this.#recordedWhileBusy.clear();
  }
  validateGpuFrame(renderer: IRendererLike, frame: number) {
    return this.#gpuScene.validateCurrentDispatch(renderer, frame);
  }

  releaseGpu(): void {
    this.#gpuScene.dispose();
    this.#publishedGpuGates.clear();
    this.#gpuLevelKeys.clear();
    this.#bundleSafety.clear();
    this.#gpuResident.clear();
  }
  releaseLodMaterials(): void {
    for (const { material } of this.#lodMaterials.values()) material.dispose();
    this.#lodMaterials.clear();
  }
  releaseRetired(): void {
    for (const shared of this.#retired.values()) shared.mesh.dispose();
    this.#retired.clear();
    this.#retiredBytes = 0;
  }
  invalidateBundles(key: string): void {
    for (const group of this.#bundles.values()) this.bumpBundle(group);
    const chunks = this.#chunkBundles.get(key)?.group;
    if (chunks !== undefined) this.bumpBundle(chunks);
  }
  publishChunkBounds(cell: IResidentCell, box: Box3 | undefined, proxies: number): void {
    if (box !== undefined) {
      if (proxies > 0) this.shadowRecordsMoved(box, true);
      // A bundled chunk is drawn or not by its cell's record, and that record is answered from
      // the cell's cull volume — which is built from the cell's placements. A chunk is a cell's
      // other half, so a cell holding chunks and no scatter would have an empty volume and never
      // be drawn at all. Widened here rather than shrunk on eviction: the volume outlives one cell
      // whenever a neighbour still holds the cluster, and a stale box only ever shows a cell that
      // is there.
      if (this.#bundlesWanted)
        this.#cullCells.get(clusterOf(cell.x, cell.z, this.#cellsPerCullCell))?.box.union(box);
    }
  }
  bundleStats(): IWorldCellsStats["bundle"] {
    return {
      children: this.mainBundleChildren() + this.#chunkBundleChildren,
      on: this.#bundlesWanted && (this.mainBundleChildren() > 0 || this.#chunkBundleChildren > 0),
      cpuMeshes: [...this.#shared.values()].filter(
        (shared) => shared.bundled && shared.gpu === undefined,
      ).length,
      gpuMeshes: [...this.#shared.values()].filter(
        (shared) => shared.bundled && shared.gpu !== undefined,
      ).length,
      eligibility: { ...this.#bundleSafety.stats },
      reason: this.#bundleReason,
      records: this.#bundleRecords,
    };
  }
  mainCullStats(): IWorldCellsStats["mainCull"] {
    return {
      frustums: this.#mainCullFrustums,
      repacks: this.#mainCullPacks,
      visibleEpoch: this.#visibleEpoch,
      windows: this.#mainCullWindows,
    };
  }

  #rerecordOnPmremSwap(raw: unknown): void {
    const swaps = typeof raw === "object" && raw !== null ? Reflect.get(raw, "_tnPmremSwaps") : 0;
    if (typeof swaps !== "number" || swaps === this.#pmremSwaps) return;
    this.#pmremSwaps = swaps;
    for (const group of this.#bundles.values()) this.bumpBundle(group);
    for (const { group } of this.#chunkBundles.values()) this.bumpBundle(group);
  }

  flushCompiles(renderer: IRendererLike | undefined): void {
    // A bundle recorded while a compile was in flight left out every draw whose pipeline was not
    // ready, and the replay never re-checks; re-record those shards now that it has settled. Set
    // `#compileBusy` first, so this flush's own bumps are not added back to the set.
    const compiles = renderer?.compileCount ?? 0;
    const busy = renderer?.compiling === true || compiles !== this.#compileSeen;
    this.#compileSeen = compiles;
    this.#compileBusy = busy;
    this.#rerecordOnPmremSwap(renderer?.raw);
    if (!busy && this.#recordedWhileBusy.size > 0) {
      const recorded = [...this.#recordedWhileBusy];
      this.#recordedWhileBusy.clear();
      for (const group of recorded) if (group.parent !== null) this.bumpBundle(group);
    }
  }
  enableGpu(
    renderer: IRendererLike | undefined,
    wanted: boolean,
    validate: boolean | undefined,
    tally: boolean,
    occlusion: OcclusionMode,
  ): void {
    // The first frame that hands over a renderer is the only one that can answer whether this
    // backend can run the GPU scene, and it prints its answer once: `enable` reports, then returns
    // early for the rest of the world's life.
    if (renderer !== undefined)
      this.#gpuScene.enable(
        renderer,
        wanted,
        validate ?? gpuSceneValidationRequested(),
        tally,
        occlusion,
      );
    // The one check the scene cannot make for itself, and the only one that reads this class's own
    // numbers rather than the scene's tables: a dressed main mesh's own indirect record, against the
    // instances this path composes for the key that mesh is named. Registered before the keys are
    // seeded, because the first check is a whole ring's worth of meshes and every one of them is
    // already dressed by the time it runs.
    this.#gpuScene.drawsFrom(() => this.gpuDraws());
  }
  announceGpu(): void {
    this.#gpuScene.announce(this.#host.renderer() as IRendererLike, this.gpuCensus());
  }
}
