import { type Box3, type Matrix4, Vector3 } from "three";
import type { Camera } from "three";
import type { IRendererLike } from "./renderer.js";
import type { CellChunks } from "./world-cell-chunks.js";
import type {
  IBuildJob,
  IResidentCell,
  IWorldCellsBudget,
  IWorldCellsFollow,
} from "./world-cell-data.js";
import { cellKey } from "./world-cell-data.js";
import { PLACEMENT_RECORD_BYTES } from "./world-cell-impostors.js";
import type { CellImpostors } from "./world-cell-impostors.js";
import type { IAssetState } from "./world-cell-models.js";
import type { CellModels } from "./world-cell-models.js";
import { ADMISSION_SLICE_PLACEMENTS, SETTLED_FOLLOW_METRES } from "./world-cell-options.js";
import {
  type CellPlacements,
  newBatches,
  newBoxes,
  publishCount,
} from "./world-cell-placements.js";
import type { CellPrewarm } from "./world-cell-prewarm.js";
import type { CellRender } from "./world-cell-render.js";
import type { IWorldCell, IWorldRun } from "./world-package.js";
import { localPoint } from "./world-root-frame.js";
import {
  type IAdmissionBudget,
  type IWorldTilesLodView,
  TerrainTileBudgetError,
} from "./world-tiles.js";
import type { TerrainTiles } from "./world-tiles.js";

/** Bytes one resident cell pays for a record: see `#admit`. */
const LOD_RANGE_RECORD_BYTES = 16;

/** The five collaborators a residency pass drives, as one read. */
interface ICellResidencyParts {
  readonly render: CellRender;
  readonly chunks: CellChunks;
  readonly models: CellModels;
  readonly impostor: CellImpostors;
  readonly prewarm: CellPrewarm;
  readonly placements: CellPlacements;
  readonly terrain: TerrainTiles | undefined;
}

/**
 * What a residency pass asks its world for. The pass owns the ring, the build queue and the counters
 * below; every other number is the world's, read through this interface.
 */
export interface ICellResidencyHost {
  released(): boolean;
  cells(): readonly IWorldCell[];
  /** The world grid's origin and cell side. */
  extent(): { readonly cellSize: number; readonly minX: number; readonly minZ: number };
  ring(): number;
  budgets(): IWorldCellsBudget;
  follow(): IWorldCellsFollow;
  /** The world's clock: admission pricing and the prefetch lookahead read it. */
  now(): number;
  /** Seconds the ring is led by the follow point's smoothed velocity. */
  prefetchSeconds(): number;
  lodHysteresis(): number;
  /** `camera` or `follow`: where the LOD eye is measured from. */
  lodFrom(): "camera" | "follow";
  /** The world root's own `matrixWorld`: the frame its placements are recorded in. */
  root(): Matrix4;
  asset(id: string): IAssetState | undefined;
  canonical(id: string): string;
  parts(): ICellResidencyParts;
  /** Hands one finished build's shadow bounds to the game's publication hook. */
  published(bounds: Box3): void;
  addFailures(count: number): void;
}

/**
 * The resident ring, the build queue that fills it, and the counters both report.
 *
 * One pass decides which cells are wanted around the follow point and admits what the budgets allow;
 * the queue that follows spends one admission budget on the cell-asset builds it left, nearest cell
 * first, and each build is taken to completion, so a cell draws whole levels. Eviction returns
 * a cell's records to the far aggregate, drops its queued work and releases what it held.
 *
 * The residency decision itself runs only when the follow point moved or something is pending; see
 * `stale`, which is what keeps a standing world from re-deriving the set it already holds.
 */
export class CellResidency {
  readonly #host: ICellResidencyHost;
  readonly #resident = new Map<string, IResidentCell>();
  /** Cell-asset builds waiting for budget, in admission order: nearest cell first. */
  #jobs: IBuildJob[] = [];
  /** The (cell, run) pairs already queued, so a refilter cannot queue itself twice. */
  readonly #queued = new Set<IWorldRun>();
  readonly #pressure = { cells: 0, instances: 0, bytes: 0 };
  #instances = 0;
  #bytes = 0;
  #evictions = 0;
  /** Completed admission steps; queued, refused and discarded work does not count. */
  #admissionCompletedUnits = 0;
  /** The follow point the last full residency pass ran for; see `stale`. */
  readonly #residencyPoint = new Vector3(Number.NaN, 0, Number.NaN);
  /** No pass has run yet: a fresh world owes its first ring whatever the follow point reads. */
  #passed = false;
  /** Actual cell at the last residency pass; only a jump reclaims retained hysteresis. */
  #residencyCell: { readonly x: number; readonly z: number } | undefined;
  /** Bumped by every admission and eviction, so a residency change owes a refilter that update. */
  #residencyEpoch = 0;
  /** Smoothed follow velocity (m/s) and the sample it was last updated from. */
  #velocityX = 0;
  #velocityZ = 0;
  #lastSample: { readonly x: number; readonly z: number; readonly t: number } | undefined;
  /** The point levels and `maxDistance` are measured from this update; see `updateEye`. */
  readonly #eye = new Vector3();
  /** The follow point `updateEye` pulls the camera toward. */
  readonly #eyeFollow = new Vector3();
  #generation = 0;
  /** The world grid, read once: a package's origin and cell side do not change for a world's life. */
  #grid: { readonly cellSize: number; readonly minX: number; readonly minZ: number } | undefined;

  constructor(host: ICellResidencyHost) {
    this.#host = host;
  }

  /** The resident ring, by cell key. */
  get resident(): ReadonlyMap<string, IResidentCell> {
    return this.#resident;
  }
  /** The LOD eye: where this update's levels and `maxDistance` are measured from. */
  get eye(): Vector3 {
    return this.#eye;
  }
  /** Builds waiting for budget. */
  get queuedBuilds(): number {
    return this.#jobs.length;
  }
  get instances(): number {
    return this.#instances;
  }
  get bytes(): number {
    return this.#bytes;
  }
  get residencyEpoch(): number {
    return this.#residencyEpoch;
  }
  /** Whether a build for this cell is still queued, so its content is not finished. */
  hasBuild(cell: IResidentCell): boolean {
    return this.#jobs.some((job) => job.cell === cell);
  }

  /** The counters a world reports; see `IWorldCellsStats`. */
  counters(): {
    readonly admissionCompletedUnits: number;
    readonly bytes: number;
    readonly evictions: number;
    readonly instances: number;
    readonly pressure: {
      readonly cells: number;
      readonly instances: number;
      readonly bytes: number;
    };
    readonly residentCells: number;
  } {
    return {
      admissionCompletedUnits: this.#admissionCompletedUnits,
      bytes: this.#bytes,
      evictions: this.#evictions,
      instances: this.#instances,
      pressure: { ...this.#pressure },
      residentCells: this.#resident.size,
    };
  }

  /**
   * One residency pass: the terrain ring follows, then the wanted cells are admitted against the
   * budgets, each one led by the follow point's own lookahead.
   */
  pass(
    x: number,
    z: number,
    budget: IAdmissionBudget,
    renderer: IRendererLike | undefined,
    camera: Camera | undefined,
    terrainView: IWorldTilesLodView | undefined,
  ): void {
    this.#grid ??= this.#host.extent();
    const { cellSize, minX, minZ } = this.#grid;
    this.#passed = true;
    this.#residencyPoint.set(x, this.#host.parts().placements.followY(), z);
    try {
      this.#host.parts().terrain?.follow({ x, z }, budget, terrainView);
      this.#host.parts().terrain?.process(renderer, camera, undefined, terrainView);
    } catch (error) {
      if (!(error instanceof TerrainTileBudgetError)) throw error;
      this.#pressure.bytes += 1;
    }
    const ahead = this.ahead(x, z);
    this.#pass(
      {
        x: Math.floor((ahead.x - minX) / cellSize),
        z: Math.floor((ahead.z - minZ) / cellSize),
      },
      ahead.x,
      ahead.z,
    );
  }

  /** Evict every resident cell, for a teardown that has already disposed the rest of the world. */
  evictAll(): void {
    for (const cell of [...this.#resident.values()]) this.evict(cell);
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
  stale(x: number, z: number): boolean {
    if (!this.#passed) return true;
    if (
      Math.hypot(
        x - this.#residencyPoint.x,
        this.#host.parts().placements.followY() - this.#residencyPoint.y,
        z - this.#residencyPoint.z,
      ) >= SETTLED_FOLLOW_METRES
    )
      return true;
    return (
      this.#host.parts().models.loadsInFlight > 0 ||
      this.#host.parts().models.loadsQueued > 0 ||
      this.#jobs.length > 0 ||
      this.#host.parts().placements.owed ||
      this.#host.parts().prewarm.queued > 0 ||
      this.#host.parts().prewarm.pending > 0 ||
      this.#host.parts().render.shadowMoved === true ||
      (this.#host.parts().terrain?.deferredAdmissions ?? 0) > 0
    );
  }

  /**
   * The LOD eye: the render camera's world position, or `follow` before a camera has reached
   * `update` or under `lodFrom: "follow"`. Height counts only where `placementReach` makes the
   * distances 3D, exactly as `#followY` does for the follow point. The camera's offset from
   * `follow` counts only past the world's first gate: an orbit or chase camera inside it grades
   * exactly as `follow` does, so turning in place swaps no level and pays no CPU rebuild, and a
   * camera far off grades from a point at most that gate short of it. Continuous, so a camera
   * resting near the gate does not flip the eye between the two.
   */
  updateEye(): void {
    // The camera and the player are in world space; the placements the eye grades are in the root's
    // own frame, so both points are read there before the pull below measures between them.
    const root = this.#host.root();
    const follow = localPoint(
      this.#eyeFollow.set(
        this.#host.follow().position.x,
        this.#host.parts().placements.followY(),
        this.#host.follow().position.z,
      ),
      root,
    );
    const camera = this.#host.lodFrom() === "camera" ? this.#host.parts().chunks.camera : undefined;
    if (camera === undefined) {
      this.#eye.copy(follow);
      return;
    }
    localPoint(this.#eye.setFromMatrixPosition(camera.matrixWorld), root);
    if (this.#host.parts().placements.placementReach === undefined) this.#eye.y = 0;
    const inside = this.#host.parts().placements.firstGate;
    const offset = this.#eye.distanceTo(follow);
    this.#eye.lerp(follow, offset > inside ? inside / offset : 1);
  }

  /**
   * Where the ring centres: the follow point led by its smoothed velocity. Samples closer than a
   * few milliseconds are the same frame and move nothing; a jump longer than the ring is a teleport
   * and resets the velocity rather than reading as speed.
   */
  ahead(x: number, z: number): { x: number; z: number } {
    this.#grid ??= this.#host.extent();
    const { cellSize } = this.#grid;
    if (this.#host.prefetchSeconds() === 0) return { x, z };
    const now = this.#host.now();
    const last = this.#lastSample;
    if (last === undefined) {
      this.#lastSample = { t: now, x, z };
    } else {
      const seconds = (now - last.t) / 1000;
      if (seconds >= 0.004) {
        const dx = x - last.x;
        const dz = z - last.z;
        if (Math.hypot(dx, dz) > cellSize * this.#host.ring()) {
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
    let leadX = this.#velocityX * this.#host.prefetchSeconds();
    let leadZ = this.#velocityZ * this.#host.prefetchSeconds();
    const limit = cellSize * this.#host.ring() * 0.75;
    const length = Math.hypot(leadX, leadZ);
    if (length > limit) {
      leadX *= limit / length;
      leadZ *= limit / length;
    }
    return { x: x + leadX, z: z + leadZ };
  }

  #pass(followCell: { x: number; z: number }, x: number, z: number): void {
    this.#grid ??= this.#host.extent();
    const { cellSize, minX, minZ } = this.#grid;
    const wanted: Array<{ cell: IWorldCell; distance: number }> = [];
    for (const cell of this.#host.cells()) {
      if (
        Math.max(Math.abs(cell.x - followCell.x), Math.abs(cell.z - followCell.z)) >
        this.#host.ring()
      )
        continue;
      const centerX = minX + (cell.x + 0.5) * cellSize;
      const centerZ = minZ + (cell.z + 0.5) * cellSize;
      wanted.push({ cell, distance: Math.hypot(x - centerX, z - centerZ) });
    }
    wanted.sort((a, b) => a.distance - b.distance || a.cell.z - b.cell.z || a.cell.x - b.cell.x);

    for (const resident of [...this.#resident.values()]) {
      if (
        Math.max(Math.abs(resident.x - followCell.x), Math.abs(resident.z - followCell.z)) >
        this.#host.ring() + 1
      )
        this.evict(resident);
    }
    // A follow point that crossed more than one cell in one pass jumped (a teleport, a review
    // camera). Only then does the hysteresis ring yield. Read off the follow point itself, not the
    // lookahead `followCell`: that leads by up to 1.5 cells, so a walk that stopped and started moved
    // it by two, and yielding there evicted and re-admitted a whole row each time.
    const here = {
      x: Math.floor((this.#host.follow().position.x - minX) / cellSize),
      z: Math.floor((this.#host.follow().position.z - minZ) / cellSize),
    };
    const last = this.#residencyCell;
    const jumped =
      last !== undefined && Math.max(Math.abs(last.x - here.x), Math.abs(last.z - here.z)) > 1;
    this.#residencyCell = here;

    for (const candidate of wanted) {
      const key = cellKey(candidate.cell.x, candidate.cell.z);
      if (this.#resident.has(key)) continue;
      const instances = candidate.cell.runs.reduce((total, run) => total + run.count, 0);
      const rangeRoots =
        this.#host.lodHysteresis() > 0 && !this.#host.parts().render.gpuOn ? instances : 0;
      // One 16 B range record per root, which is what the batch allocates for them
      // (`capacity * LOD_RANGE_STRIDE` in world-cell-batches.ts); the repack scratch that copies
      // them is one shared pool, not a second record per cell.
      const bytes = instances * PLACEMENT_RECORD_BYTES + rangeRoots * LOD_RANGE_RECORD_BYTES;
      // After a jump, a cell the one-ring hysteresis above kept is not wanted, so it yields its share
      // of the budgets to one that is. Without this the budgets stayed full of the ring the camera
      // jumped from and the cells around it were refused until it moved again.
      while (
        jumped &&
        (this.#resident.size >= this.#host.budgets().residentCells ||
          this.#instances + this.#host.parts().impostor.farInstances + instances >
            this.#host.budgets().instances ||
          this.#bytes +
            this.#host.parts().impostor.farBytes +
            this.#host.parts().chunks.bytes +
            bytes >
            this.#host.budgets().bytes)
      ) {
        const spare = this.#farthestUnwanted(followCell);
        if (spare === undefined) break;
        this.evict(spare);
      }
      if (this.#resident.size >= this.#host.budgets().residentCells) {
        this.#pressure.cells += 1;
        continue;
      }
      // The retained far aggregates are physical allocations the renderer holds too, so they are
      // charged against the same declared limits as the near ring: admitting a cell over the top of
      // them would put the world past `budgets.instances`/`budgets.bytes` with the far half invisible
      // to this check. See `#farBudgetRefuses`, the far half of the same total.
      if (
        this.#instances + this.#host.parts().impostor.farInstances + instances >
        this.#host.budgets().instances
      ) {
        this.#pressure.instances += 1;
        continue;
      }
      if (
        this.#bytes +
          this.#host.parts().impostor.farBytes +
          this.#host.parts().chunks.bytes +
          bytes >
        this.#host.budgets().bytes
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
    let reach = this.#host.ring();
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
    this.#host.parts().render.cullResident(cell);
    this.#residencyEpoch += 1;
    this.#instances += instances;
    this.#bytes += bytes;
    for (const run of cell.runs) this.#host.parts().models.acquire(run, state);
    if (cell.chunks !== undefined && cell.chunks.length > 0)
      this.#host.parts().chunks.startChunkLoad(state);
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
  queueBuild(
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
      placed: undefined,
      lodRanges: undefined,
      cell,
      force,
      gpuByLevel: undefined,
      filterY: this.#host.parts().placements.followY(),
      filterX: this.#host.follow().position.x,
      filterZ: this.#host.follow().position.z,
      lodX: this.#eye.x,
      lodY: this.#eye.y,
      lodZ: this.#eye.z,
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
  drain(budget: IAdmissionBudget): void {
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
      if (this.#host.parts().render.meshStalled) break;
      // A finished build leaves the queue at this index, so the next one is served without a skip.
      if (finished) {
        for (const entry of job.fresh)
          if (entry.batch.count > 0 && entry.shadowBounds !== undefined)
            this.#host.published(entry.shadowBounds);
        job.cell.completedRuns.add(job.run);
        this.#forget(index, job);
        // A camera that moved during this bounded build may already have consumed the global
        // refilter step before these batches existed. Owe one pass after publication, even if
        // it now stands still, so the coherent old snapshot can converge to the latest pose.
        if (
          Math.hypot(
            this.#host.follow().position.x - job.filterX,
            this.#host.parts().placements.followY() - job.filterY,
            this.#host.follow().position.z - job.filterZ,
          ) >= this.#host.parts().placements.stepMetres()
        )
          this.#host.parts().placements.owe();
      }
    }
  }

  /**
   * Put the unstarted build nearest the follow point at the front, unless a build is mid-way.
   * Each model's load queues every resident cell at once, so append order is load order: the
   * spawn cell of the last model to load waited behind the whole ring.
   */
  #frontNearest(): void {
    this.#grid ??= this.#host.extent();
    const { cellSize, minX, minZ } = this.#grid;
    const front = this.#jobs[0];
    if (front === undefined || front.next > 0 || front.batches !== undefined) return;
    const { x, z } = this.#host.follow().position;
    let nearest = 0;
    let best = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.#jobs.length; i++) {
      const job = this.#jobs[i] as IBuildJob;
      if (job.next > 0 || job.batches !== undefined) continue;
      const d = Math.hypot(
        minX + (job.cell.x + 0.5) * cellSize - x,
        minZ + (job.cell.z + 0.5) * cellSize - z,
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
  backlog(): number {
    let units = this.#host.parts().terrain?.deferredAdmissions ?? 0;
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
      job.filterX = this.#host.follow().position.x;
      job.filterY = this.#host.parts().placements.followY();
      job.filterZ = this.#host.follow().position.z;
      job.lodX = this.#eye.x;
      job.lodY = this.#eye.y;
      job.lodZ = this.#eye.z;
    }
    if (job.next < job.run.count) {
      job.batches ??= newBatches(job.asset);
      if (this.#host.lodHysteresis() > 0 && job.asset.distances.length > 1)
        job.lodRanges ??= job.batches.map((levels) => levels.map(() => []));
      // One box per `(level, part)` beside the batches it measures, so the swap that hands the
      // records to the renderer can name where they are; see `#addPlacements`.
      job.boxes ??= newBoxes(job.batches);
      const end = Math.min(job.next + ADMISSION_SLICE_PLACEMENTS, job.run.count);
      this.#host.parts().placements.addPlacements(job, job.next, end);
      job.next = end;
      this.#admissionCompletedUnits += 1;
      return false;
    }
    const batches = job.batches;
    // A run with nothing placed in it publishes nothing, exactly as an unbounded build would.
    if (batches === undefined) return true;
    if (job.published < publishCount(batches)) {
      const published = job.published;
      this.#host.parts().placements.buildOne(job, batches);
      if (job.published > published) this.#admissionCompletedUnits += 1;
      return false;
    }
    const swapped = this.#host.parts().render.swap(job);
    if (swapped) this.#admissionCompletedUnits += 1;
    return swapped;
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
  seedGpuSources(): void {
    // A pending build may already have consumed CPU-only slices. Restart it before any swap can
    // publish a partial source list; its outgoing batches keep drawing until the new build lands.
    const pending = this.#jobs;
    this.#jobs = [];
    for (const job of pending) {
      this.#queued.delete(job.run);
      for (const entry of job.fresh) this.#host.parts().render.clearSegment(entry);
      this.queueBuild(job.asset, job.cell, job.run, true, job.force);
    }
    for (const cell of this.#resident.values())
      for (const batch of cell.batches) {
        const asset = this.#host.parts().models.asset(batch.asset);
        if (asset === undefined || asset.levels.length === 0) continue;
        // One rebuild per run, not per batch: a run's placements are one build, and queueing it per
        // batch would rebuild the same placements once per level and part.
        this.queueBuild(asset, cell, batch.run, true);
      }
  }

  cellLive(cell: IResidentCell, generation: number): boolean {
    return (
      !this.#host.released() &&
      this.#resident.get(cell.key) === cell &&
      cell.generation === generation
    );
  }

  evict(cell: IResidentCell): void {
    this.#host.parts().chunks.evictProxy(cell);
    this.#residencyEpoch += 1;
    // Every run this cell held goes back to the far mesh BEFORE the near batches below are cleared:
    // the far mesh owns the ORIGINAL roots and this is the same synchronous block, so no frame draws
    // the cell twice or not at all. Skipped at teardown, where the far aggregates are drained whole.
    if (!this.#host.released())
      for (const run of cell.cell.runs) this.#host.parts().impostor.restoreFar(run);
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
      for (const entry of job.fresh) this.#host.parts().render.clearSegment(entry);
      return false;
    });
    for (const entry of cell.batches) this.#host.parts().render.clearSegment(entry);
    // The same invalidation `#swap` makes, for the eviction path: the records that just left the
    // ring are ground the levels were drawing, and they are named one batch at a time.
    // Each placement's own box when the cell kept the list, so an evicted neighbour does not redraw
    // the finest level under the player; the batch union otherwise.
    if (cell.placed !== undefined && cell.placed.size > 0)
      for (const placed of cell.placed.values())
        this.#host.parts().render.tellPlacementChanges(placed, []);
    else
      this.#host
        .parts()
        .render.shadowRecordsMoved(this.#host.parts().render.changedBounds(cell.batches));
    cell.batches.length = 0;
    cell.placed?.clear();
    // The cell's record of those chunks goes with them, so a replay can never draw a cell the world
    // has released — before they leave the group, which is where it counts what it holds. See
    // `#addChunk`.
    this.#host.parts().render.dropChunkBundles(cell);
    for (const chunk of cell.chunks) {
      chunk.removeFromParent();
      this.#host.addFailures(this.#host.parts().models.disposeLoaded(chunk));
    }
    cell.chunks.length = 0;
    // The cell's chunk sources go back to the loader here, on the last cell that named them, exactly
    // as an asset's levels do in `#release`. Run even at teardown: the loader is never cleared, so a
    // path this world asked for must be handed back however the world leaves.
    this.#host.parts().models.releaseModelPaths(cell.retainedModelPaths);
    this.#resident.delete(cell.key);
    this.#host.parts().render.cullEvicted(cell);
    this.#instances -= cell.instances;
    this.#bytes -= cell.bytes;
    this.#evictions += 1;
    // Room just freed: retry the far aggregates a full budget refused, so a species held back while
    // the ring was tight appears without another scan. Skipped at teardown, where the far half drains.
    if (!this.#host.released()) this.#host.parts().impostor.retryFar();
    // One per run, so the canonical's refcount reaches zero exactly when the last run naming any
    // member of its group has left the ring.
    for (const run of cell.cell.runs)
      this.#host.parts().models.release(this.#host.canonical(run.asset));
  }
}
