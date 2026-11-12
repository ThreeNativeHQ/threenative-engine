import { Box3, type Camera, Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import { Frustum } from "three";
import type { BundleGroup } from "three/webgpu";
import type { IRendererLike } from "./renderer.js";
import type { SharedBatch } from "./world-cell-batches.js";
import { sameSquares } from "./world-cell-batches.js";
import { levelTriangles } from "./world-cell-chunks.js";
import type {
  ICamera,
  IKeyDescriptor,
  IResidentCell,
  IShadowRegion,
  IWorldCellsStats,
} from "./world-cell-data.js";
import { clusterOf } from "./world-cell-data.js";
import { PLACEMENT_RECORD_FLOATS } from "./world-cell-impostors.js";
import {
  GPU_KEY_SUFFIX,
  MAIN_CULL_MARKER_MS,
  MAIN_CULL_PAD_METRES,
} from "./world-cell-render-util.js";
import type { ICellRenderHost } from "./world-cell-render.js";
import type { WorldGpuScene } from "./world-gpu-scene.js";
import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldPackage,
  cellPlacements,
} from "./world-package.js";
import { localClip } from "./world-root-frame.js";

/**
 * The main pass's coarse cull: one volume per resident visibility cell, one frustum a frame, and the
 * per-batch window each key's mesh narrows itself to.
 *
 * This is the part of the renderer that answers "which squares are in this frame" and what it costs.
 * The answer is derived from the camera alone, so it holds nothing of the world but the volumes it
 * has admitted and the counters that report what the frame paid — see `IWorldCellsStats.mainCull`.
 */

/** What the cull asks the renderer it runs in. */
export interface ICellMainCullHost {
  render(): ICellRenderHost;
  /** Every shared batch, which is what a frame narrows. */
  shared(): Map<string, SharedBatch>;
  gpuScene(): WorldGpuScene;
  /** Every resident cell's frozen chunk record, and the square whose answer shows it. */
  chunkGroups(): Map<string, { readonly cluster: string; readonly group: BundleGroup }>;
  /** Reset the bundle eligibility counters at the top of the pass. */
  beginBundleFrame(): void;
  recordCpuMain(shared: SharedBatch, outcome: "settled" | "narrowed" | "repacked"): void;
  dressGpu(shared: SharedBatch, key: IKeyDescriptor): void;
  dressShadowKey(shared: SharedBatch, key: string): void;
  applyGpuMain(dressed: readonly { asset: string; shared: SharedBatch }[]): void;
  /** Whether the prewarm has already named every key the scene should draw. */
  gpuSeeded(): boolean;
}

/** The grid and the tables a cull derives its volumes from, fixed for the world's life. */
export interface ICellMainCullSettings {
  readonly cellSize: number;
  readonly minX: number;
  readonly minZ: number;
  readonly manifest: IWorldPackage;
  readonly placements: ArrayBuffer;
  readonly cellsPerCullCell: number;
  readonly mainCullToldAt: number;
}

/** The two scratch objects a cull builds its frustum in. */
const _cullFrustum = new Frustum();
const _cullProjScreen = new Matrix4();

export class CellMainCull {
  readonly #host: ICellMainCullHost;

  readonly #cellSize: number;

  readonly #minX: number;

  readonly #minZ: number;

  readonly #manifest: IWorldPackage;

  readonly #placements: ArrayBuffer;

  readonly #cellsPerCullCell: number;

  constructor(settings: ICellMainCullSettings, host: ICellMainCullHost) {
    this.#host = host;
    this.#cellSize = settings.cellSize;
    this.#minX = settings.minX;
    this.#minZ = settings.minZ;
    this.#manifest = settings.manifest;
    this.#placements = settings.placements;
    this.#cellsPerCullCell = settings.cellsPerCullCell;
    this.#mainCullToldAt = settings.mainCullToldAt;
  }

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

  /** The visibility cells the last cull kept and the frame's set, trading places; see `#cullMainPass`. */
  #visibleSquares: Set<string> = new Set();

  #cullScratch: Set<string> = new Set();

  /** Bumped only when `#visibleSquares` changed, so a settled camera repacks no batch at all. */
  #visibleEpoch = 0;

  readonly #position = new Vector3();

  readonly #rotation = new Quaternion();

  readonly #scale = new Vector3();

  readonly #matrix = new Matrix4();

  /** Reused transformed authored bounds for admission and conservative visibility volumes. */
  readonly #recordBounds = new Box3();

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
    this.#host.beginBundleFrame();
    this.#mainCullFrustums += 1;
    // The volumes this tests and the records it narrows are the root's own, so the frustum is taken
    // in the root's frame: a game that moves its world draws the squares that are over the camera.
    const root = this.#host.render().root();
    const frustum = _cullFrustum.setFromProjectionMatrix(localClip(_cullProjScreen, camera, root));
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
    for (const entry of this.#host.chunkGroups().values()) {
      const visible = this.#visibleSquares.has(entry.cluster);
      if (entry.group.visible !== visible) entry.group.visible = visible;
    }
    const gpu = this.#host.gpuScene();
    const dressed: Array<{ asset: string; shared: SharedBatch }> = [];
    const version = gpu.version;
    for (const shared of [...this.#host.shared().values()]) {
      if (shared.role !== "main") continue;
      // A dressed batch draws from the GPU scene's own buffers, so the frame's per-instance answer is
      // the dispatch's and this mesh's own window would be a second, stale copy of it.
      if (gpu.on && shared.gpu !== undefined) {
        this.#host.dressGpu(shared, shared.gpu);
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
      this.#host.recordCpuMain(shared, outcome);
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
      for (const shared of [...this.#host.shared().values()])
        if (shared.role === "main" && shared.gpu !== undefined)
          this.#host.dressGpu(shared, shared.gpu);
      // And every shadow key, for the same reason: minting one grew the twin buffers every other
      // key was dressed against, so a sibling dressed earlier in the loop above is holding the
      // generation the dispatch replaced. The main key's own dress brings its twin with it; this is
      // what closes the seam for the keys whose main key was dressed before the grow.
      for (const shared of [...this.#host.shared().values()])
        if (shared.role === "key")
          this.#host.dressShadowKey(shared, shared.mesh.name.slice(0, -GPU_KEY_SUFFIX.length));
    }
    // After every key has been dressed, so the asset's answer is the union across its levels and
    // parts.
    this.#host.applyGpuMain(dressed);
    // After the coarse gate, and only for the main camera: an orthographic one — every shadow
    // level's own — returned at the top, so a level's render never dispatches over the main pass's
    // compaction.
    if (gpu.on) gpu.dispatch(this.#host.render().renderer() as IRendererLike, camera, root);
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
      const bounds = this.#manifest.assets[this.#host.render().canonical(run.asset)]?.bounds;
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
    const now = this.#host.render().now();
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
    for (const shared of this.#host.shared().values()) {
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
    const stats = this.#host.render().stats();
    console.info(
      `TN_WORLD_MAIN_CULL instances=${String(instances)} drawn=${String(drawn)} ` +
        `hidden=${String(hidden)} castersHidden=${String(castersHidden)} repacks=${String(repacks)} ` +
        `refilters=${String(stats.refilters)} levelRefilters=${String(stats.levelRefilters)} ` +
        `lodFrom=${stats.lodFrom} ` +
        `clusterTris=${String(clusterTriangles)} wideTris=${String(wideTriangles)} ` +
        `dressed=${String(dressed)}/${String(mainMeshes)}`,
    );
    console.info(
      `TN_WORLD_SHADOW_ADMISSION clusterWithheld=${String(clusterWithheld)} ` +
        `clusterRecords=${String(clusterRecords)} clusterMissing=${String(clusterMissing)} ` +
        `wideWithheld=${String(wideWithheld)} wideRecords=${String(wideRecords)} ` +
        `wideMissing=${String(wideMissing)} seeded=${String(this.#host.gpuSeeded())} ` +
        `queued=${String(this.#host.render().queuedBuilds())}`,
    );
    const hlod = stats.hlod;
    let proxyDraws = 0;
    let replacedSources = 0;
    for (const cell of this.#host.render().residentCells()) {
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

  mainCullStats(): IWorldCellsStats["mainCull"] {
    return {
      frustums: this.#mainCullFrustums,
      repacks: this.#mainCullPacks,
      visibleEpoch: this.#visibleEpoch,
      windows: this.#mainCullWindows,
    };
  }
  /**
   * Whether the frame's own frustum holds this object. It is the frustum the last cull built, which
   * is why it lives here: a caller that answered from a copy no frame wrote would hold everything.
   */
  intersectsObject(mesh: Object3D): boolean {
    return _cullFrustum.intersectsObject(mesh);
  }

  /** The volume each resident visibility cell covers, which the chunk bounds widen on admission. */
  cells(): Map<string, { cells: number; box: Box3 }> {
    return this.#cullCells;
  }

  /** The visibility cells the last cull kept, which the GPU dress's coarse gate reads. */
  get visible(): Set<string> {
    return this.#visibleSquares;
  }
}
