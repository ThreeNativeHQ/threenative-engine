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

import { PLACED_STRIDE, clusterOf, sameLodRanges } from "./world-cell-data.js";

import {
  Box3,
  BufferGeometry,
  type Camera,
  Frustum,
  type InstancedMesh,
  type Material,
  type Matrix4,
  type Mesh,
  type Object3D,
  Quaternion,
  Vector3,
} from "three";
import { renderGroup, uniform } from "three/tsl";
import type { BundleGroup } from "three/webgpu";

import { lodChainOf, setLodBias } from "./model-lod.js";
import type { OcclusionMode } from "./render/depth-pyramid.js";

import { parkMesh } from "./render/mesh-pool.js";
import {
  VIRTUAL_SHADOW_KEY_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
} from "./render/virtual-shadow-layers.js";
import {
  type ITemporalLod,
  advanceTemporalLod,
  worldLodMaterial,
} from "./render/world-impostor-surface.js";
import type { IRendererLike } from "./renderer.js";
import { isStatic, markStatic } from "./static-transform.js";

import { CellBundles } from "./world-cell-render-bundles.js";
import { CellGpuDress } from "./world-cell-render-gpu-dress.js";
import { CellMainCull } from "./world-cell-render-main-cull.js";
import {
  type IShadowClaimHost,
  castLevelOf,
  casts,
  claimCaster,
  claimWide,
  clearSegment,
  keysForShadow,
  shadowFloorOf,
  smallCaster,
  wideOwed,
} from "./world-cell-render-shadow-claims.js";
import {
  GPU_KEY_SUFFIX,
  MAIN_CULL_MARKER_MS,
  MAIN_CULL_PAD_METRES,
  MAIN_CULL_SQUARE_METRES,
  RETIRED_SHARED_BYTES,
  SHADOW_REGION_CAP,
  UNDITHERED_LOD_WIDTH,
  assertSlotFree,
  chunkDraws,
  freshMeshFor,
  heldBytes,
  indirectView,
  mainShard,
  redressMaterial,
  followCluster as squareOf,
} from "./world-cell-render-util.js";

// The split's constants stay named from this module, which is where every caller imports them.
export {
  MAIN_CULL_SQUARE_METRES,
  UNDITHERED_LOD_WIDTH,
  mainShard,
} from "./world-cell-render-util.js";
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

export interface ICellRenderHost {
  asset(id: string): IAssetState | undefined;
  assets(): Iterable<IAssetState>;
  canonical(id: string): string;
  renderer(): IRendererLike | undefined;
  camera(): Camera | undefined;
  /** The world root's own `matrixWorld`: the frame its placements are recorded in. */
  root(): Matrix4;
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
  readonly shadowMinLevel: number;
  readonly extentBounds: Box3;
  readonly preserveAuthoredParts: boolean;
  readonly lodHysteresis: number;
  readonly lodTransition: "band" | "none" | "temporal";
  readonly lodSpatial: boolean;
  readonly cellsPerCluster: number;
  readonly cellsPerCullCell: number;
  readonly smallCasterMetres: number;
  readonly bundlesWanted: boolean;
  readonly bundleReason: string;
  readonly invalidateShadows: ((region?: IShadowRegion) => void) | undefined;
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

  /** Every record the main pass draws through, and the chunk records under each resident cell. */
  readonly #bundles: CellBundles;

  /** The volumes and windows the main pass culls with; see {@link CellMainCull}. */
  readonly #cull: CellMainCull;

  /** The mesh a key draws: its shape, its LOD material and its dress against the GPU scene. */
  readonly #dress: CellGpuDress;

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

  /** `shadows.minLevel`: the finest level a placement's shadow draws; see `shadowFloorOf`. */
  readonly #shadowMinLevel: number;

  readonly #receiveShadow: boolean;

  /** Asset bounds height under which a wide caster goes on the finest level's layer only. */
  readonly #smallCasterMetres: number;

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
  /** Changed records' boxes since the last tell, merged only where they overlap; see `shadowRecordsMoved`. */
  readonly #shadowRegions: IShadowRegion[] = [];
  readonly #shadowAdmissions: IShadowRegion[] = [];
  #shadowFull = false;

  /** World cells per main-cull visibility cell; see `MAIN_CULL_SQUARE_METRES`. */
  readonly #cellsPerCullCell: number;

  /** The game's hook to refresh the shadow levels after streamed records changed. */
  readonly #invalidateShadows: ((region?: IShadowRegion) => void) | undefined;

  /**
   * The GPU-driven main pass, and whether the world asked for it. Off is byte-for-byte this class's
   * own CPU path: nothing below reads `on` except the four places the option changes what a frame
   * does. See the `gpuScene` load option and `#cullMainPass`.
   */
  readonly #gpuScene = new WorldGpuScene();

  /** Every main key this world has minted a shadow twin for, which is what a level's dispatch asks for. */
  readonly #shadowKeyNames = new Set<string>();

  /** Resident placements per canonical asset, which is the capacity a key of that asset needs. */
  readonly #gpuResident = new Map<string, number>();

  readonly #preserveAuthoredParts: boolean;

  readonly #lodHysteresis: number;
  readonly #lodTransition: "band" | "none" | "temporal";
  readonly #lodSpatial: boolean;

  readonly #lodDistanceBias = uniform(1).setGroup(renderGroup);

  readonly #lodMaterials = new Map<
    string,
    { readonly source: Material; readonly material: Material }
  >();

  /** The resident ring has been handed to the scene once; see `#seedGpuSources`. */
  #gpuSeeded = false;

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
      same.lastLodX = fresh.lastLodX;
      same.lastLodY = fresh.lastLodY;
      same.lastLodZ = fresh.lastLodZ;
      this.#host.widenFilterRange(cell, fresh.lastLodX, fresh.lastLodZ);
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
      // When this answer reached the screen, so a record whose level set grew fades into it.
      const ranges = entry.lodRanges;
      if (ranges !== undefined)
        for (let at = 3; at < ranges.length; at += 4) ranges[at] = this.#dress.clockSeconds;
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
    // A refilter tells the shadow levels only the placements that entered or left this cell's run,
    // each with its own box. A placement that only changed level moved no caster: past `castLevels`
    // a tree keeps casting in the coarsest casting shape (`castLevelOf`). The batch union this told
    // before is the cell, which covers the finest level's whole window, so a walk through the forest
    // redrew whole clip levels for a bush crossing its cull distance 60 m away.
    const before = job.cell.placed?.get(job.run);
    const after = job.placed ?? [];
    job.cell.placed ??= new Map();
    job.cell.placed.set(job.run, after);
    // A first build has no list before it, so every placement it kept is an admission.
    if (!job.replacement || before !== undefined) this.tellPlacementChanges(before ?? [], after);
    else {
      if (job.fresh.some((entry) => entry.batch.count > 0))
        this.shadowRecordsMoved(this.changedBounds(job.fresh), true);
      if (job.replaced.some((entry) => entry.batch.count > 0))
        this.shadowRecordsMoved(this.changedBounds(job.replaced));
    }
    // This run's near representation is attached, so the far mesh stops drawing its original roots in
    // the same synchronous block: a cell is never drawn by both and never by neither. A no-op until
    // the asset's atlas lands; see `#syncFarSegments` for the build-time half and `#restoreFar`.
    this.#host.disableFar(job.run);
    return true;
  }

  /** Tell each placement in only one of two `PLACED_STRIDE` lists, as an admission when it entered. */
  tellPlacementChanges(before: readonly number[], after: readonly number[]): void {
    const gone = new Map<number, number>();
    for (let at = 0; at < before.length; at += PLACED_STRIDE) gone.set(before[at] as number, at);
    const box = this.#placedBox;
    const tell = (list: readonly number[], at: number, admission: boolean): void => {
      box.min.set(list[at + 1] as number, list[at + 2] as number, list[at + 3] as number);
      box.max.set(list[at + 4] as number, list[at + 5] as number, list[at + 6] as number);
      this.shadowRecordsMoved(box, admission);
    };
    for (let at = 0; at < after.length; at += PLACED_STRIDE)
      if (!gone.delete(after[at] as number)) tell(after, at, true);
    for (const at of gone.values()) tell(before, at, false);
  }
  readonly #placedBox = new Box3();

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
   * One cell's records changed, so the shadow levels that cover it redraw — at most once a second,
   * and only for a game that passed the hook. The levels cull clusters themselves now, so nothing
   * has to be copied for them; the flag only says "what you last drew is out of date".
   *
   * `bounds` is the records that changed and is kept until the tell, unioned only with the boxes
   * of the same second that it overlaps. A change with no bounds is a blanket one: it has to be, because
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
    const regions = admission ? this.#shadowAdmissions : this.#shadowRegions;
    // Boxes stay apart unless they overlap: one union of a bush 60 m north and a tree 150 m south
    // covers the ground under the camera, and every clip level redrew whole for it. Past the cap the
    // region whose ground grows least takes the box, which only widens a redraw and never drops one.
    let into = regions.find(
      (region) =>
        region.min.x <= bounds.max.x &&
        region.max.x >= bounds.min.x &&
        region.min.y <= bounds.max.y &&
        region.max.y >= bounds.min.y &&
        region.min.z <= bounds.max.z &&
        region.max.z >= bounds.min.z,
    );
    if (into === undefined && regions.length >= SHADOW_REGION_CAP) {
      let least = Number.POSITIVE_INFINITY;
      for (const region of regions) {
        const growth =
          (Math.max(region.max.x, bounds.max.x) - Math.min(region.min.x, bounds.min.x)) *
            (Math.max(region.max.z, bounds.max.z) - Math.min(region.min.z, bounds.min.z)) -
          (region.max.x - region.min.x) * (region.max.z - region.min.z);
        if (growth < least) [least, into] = [growth, region];
      }
    }
    if (into === undefined) {
      regions.push({
        ...(admission ? { admission: true } : {}),
        max: { x: bounds.max.x, y: bounds.max.y, z: bounds.max.z },
        min: { x: bounds.min.x, y: bounds.min.y, z: bounds.min.z },
      });
      return;
    }
    into.min.x = Math.min(into.min.x, bounds.min.x);
    into.min.y = Math.min(into.min.y, bounds.min.y);
    into.min.z = Math.min(into.min.z, bounds.min.z);
    into.max.x = Math.max(into.max.x, bounds.max.x);
    into.max.y = Math.max(into.max.y, bounds.max.y);
    into.max.z = Math.max(into.max.z, bounds.max.z);
  }

  /**
   * Tell the shadow levels one call per kept region; covered loading drains without the walk throttle.
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
      this.#shadowRegions.length = 0;
      this.#shadowAdmissions.length = 0;
      this.#shadowFull = false;
      return;
    }
    const now = this.#host.now();
    if (!covered && now - this.#shadowToldAt < 1e3) return;
    this.#shadowToldAt = now;
    this.#shadowMoved = false;
    const regions = this.#shadowRegions.splice(0);
    const admissions = this.#shadowAdmissions.splice(0);
    const full = this.#shadowFull;
    this.#shadowFull = false;
    if (full || regions.length + admissions.length === 0) this.#invalidateShadows();
    else for (const region of [...regions, ...admissions]) this.#invalidateShadows(region);
  }

  resetShadows(): void {
    this.#shadowMoved = false;
    this.#shadowRegions.length = 0;
    this.#shadowAdmissions.length = 0;
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
        this.#retiredBytes -= heldBytes(released);
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
      else existing.surface(shape.material);
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
      this.#retiredBytes -= heldBytes(released);
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
    return squareOf(this.#follow, this.#minX, this.#minZ, this.#cellSize, this.#cellsPerCluster);
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
    const bytes = heldBytes(shared);
    this.#retired.delete(key);
    this.#retired.set(key, shared);
    this.#retiredBytes += bytes;
    for (const [oldest, held] of this.#retired) {
      if (this.#retiredBytes <= RETIRED_SHARED_BYTES) break;
      this.#retired.delete(oldest);
      this.#retiredBytes -= heldBytes(held);
      held.mesh.dispose();
    }
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
    this.#shadowMinLevel = settings.shadowMinLevel;
    this.#extentBounds = settings.extentBounds;
    this.#preserveAuthoredParts = settings.preserveAuthoredParts;
    this.#lodHysteresis = settings.lodHysteresis;
    this.#lodTransition = settings.lodTransition;
    this.#lodSpatial = settings.lodSpatial;
    this.#cellsPerCluster = settings.cellsPerCluster;
    this.#cellsPerCullCell = settings.cellsPerCullCell;
    this.#smallCasterMetres = settings.smallCasterMetres;
    this.#invalidateShadows = settings.invalidateShadows;
    this.#dress = new CellGpuDress({
      add: (object) => this.#host.add(object),
      asset: (id) => this.#host.asset(id),
      attach: (shared) => this.attach(shared),
      bumpBundle: (group) => this.bumpBundle(group),
      bundleIn: (shared, reuseSafety) => this.bundleIn(shared, reuseSafety),
      bundleOut: (shared) => this.bundleOut(shared),
      camera: () => this.#host.camera(),
      canonical: (id) => this.#host.canonical(id),
      carryPrewarm: (old, next) => this.#host.carryPrewarm(old, next),
      extentBounds: () => this.#extentBounds,
      freshAllowance: () => this.freshAllowance(),
      freshCount: () => this.#freshThisUpdate,
      gpuScene: () => this.#gpuScene,
      isBundleHome: (shared) => this.#host.isBundleHome(shared),
      lodDistanceBias: () => this.#lodDistanceBias,
      lodHysteresis: () => this.#lodHysteresis,
      lodMaterials: () => this.#lodMaterials,
      lodSpatial: () => this.#lodSpatial,
      lodTransition: () => this.#lodTransition,
      preserveAuthoredParts: () => this.#preserveAuthoredParts,
      receiveShadow: () => this.#receiveShadow,
      renderer: () => this.#host.renderer(),
      resident: () => this.#gpuResident,
      retired: () => this.#retired,
      root: () => this.#host.root(),
      shadowFloorOf: (assetId) => this.shadowFloorOf(assetId),
      shadowKeyFor: (key, part) => this.shadowKeyFor(key, part),
      shared: () => this.#shared,
      shardOf: (shared) => this.shardOf(shared),
      visibleSquares: () => this.visibleSquares(),
    });
    this.#cull = new CellMainCull(
      {
        cellSize: this.#cellSize,
        cellsPerCullCell: this.#cellsPerCullCell,
        mainCullToldAt: settings.mainCullToldAt,
        manifest: this.#manifest,
        minX: this.#minX,
        minZ: this.#minZ,
        placements: this.#placements,
      },
      {
        applyGpuMain: (dressed) => this.applyGpuMain(dressed),
        beginBundleFrame: () => this.beginBundleFrame(),
        chunkGroups: () => this.#bundles.chunkGroups(),
        dressGpu: (shared, key) => this.dressGpu(shared, key),
        dressShadowKey: (shared, key) => this.dressShadowKey(shared, key),
        gpuScene: () => this.#gpuScene,
        gpuSeeded: () => this.#gpuSeeded,
        recordCpuMain: (shared, outcome) => this.recordCpuMain(shared, outcome),
        render: () => this.#host,
        shared: () => this.#shared,
      },
    );
    this.#bundles = new CellBundles(
      {
        bundleReason: settings.bundleReason,
        bundlesWanted: settings.bundlesWanted,
        cellsPerCullCell: settings.cellsPerCullCell,
      },
      {
        add: (object) => this.#host.add(object),
        isParent: (object) => this.#host.isParent(object),
        renderer: () => this.#host.renderer(),
        shared: () => this.#shared,
      },
    );
  }

  // The record's own answers, named here because this class is the world's one surface: every caller
  // below asks the facade and never the bundle module.

  bundleIn(shared: SharedBatch, reuseSafety = false): void {
    this.#bundles.bundleIn(shared, reuseSafety);
  }

  bundleOut(shared: SharedBatch): void {
    this.#bundles.bundleOut(shared);
  }

  ownsBundles(): boolean {
    return this.#bundles.ownsBundles();
  }

  bumpBundle(group: BundleGroup): void {
    this.#bundles.bumpBundle(group);
  }

  recordCpuMain(shared: SharedBatch, outcome: "settled" | "narrowed" | "repacked"): void {
    this.#bundles.recordCpuMain(shared, outcome);
  }

  addChunk(cell: IResidentCell, chunk: Object3D): void {
    this.#bundles.addChunk(cell, chunk);
  }

  dropChunkBundles(cell: IResidentCell): void {
    this.#bundles.dropChunkBundles(cell);
  }

  shardOf(shared: SharedBatch): BundleGroup {
    return this.#bundles.shardOf(shared);
  }

  mainBundleChildren(): number {
    return this.#bundles.mainBundleChildren();
  }

  attach(shared: SharedBatch): void {
    this.#bundles.attach(shared);
  }

  beginBundleFrame(): void {
    this.#bundles.beginFrame();
  }

  invalidateBundles(key: string): void {
    this.#bundles.invalidateBundles(key);
  }

  bundleStats(): IWorldCellsStats["bundle"] {
    return this.#bundles.bundleStats();
  }

  flushCompiles(renderer: IRendererLike | undefined): void {
    this.#bundles.flushCompiles(renderer);
  }

  clearCompileRecords(): void {
    this.#bundles.clearCompileRecords();
  }

  /**
   * What the shadow claims need to see of this renderer: the batches they claim blocks in, the gate
   * table the caster shape comes from, and the scene that decides whether a level draws keys.
   */
  readonly #claimHost: IShadowClaimHost = {
    castShadowLevels: () => this.#castShadowLevels,
    casterFor: (assetId, entry, cell, level) => this.casterFor(assetId, entry, cell, level),
    countPlaced: (entry, placed) => this.countPlaced(entry, placed),
    freshCount: () => this.#freshThisUpdate,
    gpuScene: () => this.#gpuScene,
    manifest: () => this.#manifest,
    preserveAuthoredParts: () => this.#preserveAuthoredParts,
    render: () => this.#host,
    resident: () => this.#gpuResident,
    segmentIn: (shared, count, cluster) => this.segmentIn(shared, count, cluster),
    shadowMinLevel: () => this.#shadowMinLevel,
    smallCasterMetres: () => this.#smallCasterMetres,
    wideFor: (assetId, entry, level) => this.wideFor(assetId, entry, level),
  };

  // The claim decisions, named here because this class is the world's one surface.

  casts(level: number): boolean {
    return casts(this.#claimHost, level);
  }

  smallCaster(assetId: string): boolean {
    return smallCaster(this.#claimHost, assetId);
  }

  wideOwed(assetId: string, part: number): boolean {
    return wideOwed(this.#claimHost, assetId, part);
  }

  castLevelOf(entry: ICellBatch): number | undefined {
    return castLevelOf(this.#claimHost, entry);
  }

  shadowFloorOf(assetId: string): number {
    return shadowFloorOf(this.#claimHost, assetId);
  }

  keysForShadow(): boolean {
    return keysForShadow(this.#claimHost);
  }

  claimCaster(assetId: string, entry: ICellBatch, cell: IResidentCell): boolean {
    return claimCaster(this.#claimHost, assetId, entry, cell);
  }

  claimWide(assetId: string, entry: ICellBatch): boolean {
    return claimWide(this.#claimHost, assetId, entry);
  }

  clearSegment(entry: ICellBatch): void {
    clearSegment(this.#claimHost, entry);
  }

  // The dress's own answers, named here because this class is the world's one surface.

  adoptGpu(shared: SharedBatch, assetId: string, key: string, level: number, part: number): void {
    this.#dress.adoptGpu(shared, assetId, key, level, part);
  }

  applyGpuMain(dressed: readonly { asset: string; shared: SharedBatch }[]): void {
    this.#dress.applyGpuMain(dressed);
  }

  dressGpu(shared: SharedBatch, key: IKeyDescriptor): void {
    this.#dress.dressGpu(shared, key);
  }

  dressMesh(shared: SharedBatch, receiveShadow: boolean): void {
    this.#dress.dressMesh(shared, receiveShadow);
  }

  seat(old: InstancedMesh, next: InstancedMesh): void {
    this.#dress.seat(old, next);
  }

  shapeFor(
    entry: ICellBatch,
    role: "cluster" | "key" | "main" | "wide",
    level?: number,
  ): IBatchShape {
    return this.#dress.shapeFor(entry, role, level);
  }

  wideShape(
    asset: IAssetState | undefined,
    level: number,
    part: number,
    fallback: IBatchShape,
  ): IBatchShape {
    return this.#dress.wideShape(asset, level, part, fallback);
  }

  updateLodEye(x: number, y: number, z: number): void {
    this.#dress.updateLodEye(x, y, z);
    this.#gpuScene.lodEye(x, y, z);
  }

  refreshLodMaterials(asset: IAssetState): void {
    this.#dress.refreshLodMaterials(asset);
  }

  impostorDrawn(): number {
    return this.#dress.impostorDrawn();
  }

  publishGpuGates(asset: IAssetState): void {
    this.#dress.publishGpuGates(asset);
  }

  gatesOf(id: string, asset: IAssetState): IAssetSlot {
    return this.#dress.gatesOf(id, asset);
  }

  seedGpuKeys(): void {
    this.#dress.seedGpuKeys();
  }

  seedGpuKey(shared: SharedBatch): void {
    this.#dress.seedGpuKey(shared);
  }

  gpuCensus(): { readonly dressed: number; readonly meshes: number } {
    return this.#dress.gpuCensus();
  }

  gpuDraws(): readonly IMeshDraw[] {
    return this.#dress.gpuDraws();
  }

  liveGates(): Map<string, ILiveAsset> {
    return this.#dress.liveGates();
  }

  // The main cull's own answers, named here because this class is the world's one surface.

  cullMainPass(camera: Camera | undefined): void {
    this.#cull.cullMainPass(camera);
  }

  cullResident(cell: IWorldCell): void {
    this.#cull.cullResident(cell);
  }

  cullEvicted(cell: IResidentCell): void {
    this.#cull.cullEvicted(cell);
  }

  reportMainCull(): void {
    this.#cull.reportMainCull();
  }

  mainCullStats(): IWorldCellsStats["mainCull"] {
    return this.#cull.mainCullStats();
  }

  /** The squares the last cull kept, at the epoch it kept them for. */
  visibleSquares(): Set<string> {
    return this.#cull.visible;
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
    return this.#bundles.wanted;
  }
  bundleGroup(shard: number): BundleGroup | undefined {
    return this.#bundles.bundleGroup(shard);
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
    return this.#cull.intersectsObject(mesh);
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
  validateGpuFrame(renderer: IRendererLike, frame: number) {
    return this.#gpuScene.validateCurrentDispatch(renderer, frame);
  }

  releaseGpu(): void {
    this.#gpuScene.dispose();
    this.#dress.release();
    this.#bundles.release();
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
  publishChunkBounds(cell: IResidentCell, box: Box3 | undefined, proxies: number): void {
    if (box !== undefined) {
      if (proxies > 0) this.shadowRecordsMoved(box, true);
      // A bundled chunk is drawn or not by its cell's record, and that record is answered from
      // the cell's cull volume — which is built from the cell's placements. A chunk is a cell's
      // other half, so a cell holding chunks and no scatter would have an empty volume and never
      // be drawn at all. Widened here rather than shrunk on eviction: the volume outlives one cell
      // whenever a neighbour still holds the cluster, and a stale box only ever shows a cell that
      // is there.
      if (this.#bundles.wanted)
        this.#cull
          .cells()
          .get(clusterOf(cell.x, cell.z, this.#cellsPerCullCell))
          ?.box.union(box);
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
