import { Box3, Matrix4, Quaternion, Vector3 } from "three";
import { InstancedBatch } from "./instanced-batch.js";
import { biasedLodDistance } from "./model-lod.js";
import {
  type IAssetPart,
  type IBuildJob,
  type IResidentCell,
  type IWorldCellsFollow,
  crossesGate,
} from "./world-cell-data.js";
import {
  PLACEMENT_RECORD_BYTES,
  PLACEMENT_RECORD_FLOATS,
  cullDistance,
} from "./world-cell-impostors.js";
import type { IAssetState } from "./world-cell-models.js";
import { LEVEL_REFILTER_STEP_METRES } from "./world-cell-options.js";
import { levelAtGates } from "./world-gpu-scene.js";
import {
  type IWorldAsset,
  type IWorldCell,
  type IWorldRun,
  cellPlacements,
} from "./world-package.js";

/**
 * One empty batch per (level, part), so a placement is filtered and drawn together and an emptied
 * level or a part nobody placed costs one missing mesh rather than the whole cell's run.
 */
export function newBatches(asset: IAssetState): InstancedBatch[][] {
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
export function publishCount(batches: readonly InstancedBatch[][]): number {
  let total = 0;
  for (const levelBatches of batches) total += levelBatches.length;
  return total;
}

/**
 * One empty bounds box per `(level, part)`, beside the batches `addPlacements` measures. Written as a
 * loop because this file is held to a rule that the array method's name is a material's texture
 * property.
 */
export function newBoxes(batches: readonly InstancedBatch[][]): Box3[][] {
  const boxes: Box3[][] = [];
  for (const levelBatches of batches) {
    const level: Box3[] = [];
    for (const _batch of levelBatches) level.push(new Box3());
    boxes.push(level);
  }
  return boxes;
}

/** What the placement build asks its world for. Every read is the world's own state, not a copy. */
export interface ICellPlacementsHost {
  extent(): { readonly cellSize: number; readonly minX: number; readonly minZ: number };
  /** The point `placementReach` is measured from. */
  follow(): IWorldCellsFollow;
  /** The point levels and `maxDistance` are measured from this update; see `updateEye`. */
  eye(): Vector3;
  /** Bumped by every admission and eviction, so a residency change owes a refilter. */
  residencyEpoch(): number;
  asset(id: string): IAssetState | undefined;
  canonical(id: string): string;
  queueBuild(asset: IAssetState, cell: IResidentCell, run: IWorldRun, replace?: boolean): void;
  /** The renderer's own switch: the dispatch grades levels itself while it is on. */
  gpuOn(): boolean;
  /** Whether this asset can append a whole-asset impostor, so a placement root is wanted. */
  rootsNeeded(asset: IAssetState): boolean;
  /** The resident ring: what the refilter pass scans. */
  resident(): Iterable<IResidentCell>;
}

/**
 * Where a cell's placement records become drawable batches, and when a walk makes that answer stale.
 *
 * The build is the same build `world-cells.ts` ran: one slice of a run's records at a time, the
 * CPU `maxDistance`/`placementReach` filters at the position the slice started from, the level a
 * shared gate rule picks, the fade a swap stamps, and the per-placement bounds the shadow levels
 * are invalidated by. `refilter` is the pass that queues a rebuild when the follow point has moved
 * a gate, and `stale` says whether it runs at all.
 *
 * The record filters, the published levels, the world's gate list and the refilter points live here;
 * everything else — the renderer's own GPU switch, the resident ring, the build queue — is asked of
 * the host.
 */
export class CellPlacements {
  readonly #host: ICellPlacementsHost;
  /** The authored placement records, immutable for the world's life. */
  readonly #placements: ArrayBuffer;
  readonly #placementReach: Float32Array | undefined;
  /** Per cell and asset, the reach range the load measured; empty when no reach was authored. */
  readonly #reachRanges: ReadonlyMap<
    IWorldCell,
    Map<string, { min: number; max: number; minY: number; maxY: number }>
  >;
  readonly #lodHysteresis: number;
  readonly #rebuildsPerUpdate: number;
  /** Each record's last published level, kept only when a walking level hysteresis is on. */
  readonly #placementLevels: Uint32Array | undefined;
  /** Each record's last published levels, `(min + 1) | (max + 1) << 4` (0: none yet). */
  readonly #placementRanges: Uint8Array | undefined;
  /** Every distinct gate distance the world's assets have, ascending; see `noteGate`. */
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
  /** Refilter passes run, whether or not they queued anything; see `IWorldCellsStats.refilters`. */
  #refilters = 0;
  /** Replacement builds that entered `addPlacements`; initial admission is not CPU refilter work. */
  #levelRefilters = 0;
  /** The follow point the last refilter pass ran for; see `stale`. */
  readonly #refilterPoint = new Vector3(Number.NaN, 0, Number.NaN);
  /** The LOD eye the last refilter pass ran for; see `stale`. */
  readonly #refilterEye = new Vector3(Number.NaN, 0, Number.NaN);
  /** The residency epoch the last refilter pass saw; see `stale`. */
  #refilterEpoch = -1;
  /** The last pass found more stale cell-assets than `rebuildsPerUpdate` could queue. */
  #refilterOwed = false;
  #rebuilds = 0;
  readonly #position = new Vector3();
  readonly #rotation = new Quaternion();
  readonly #scale = new Vector3();
  readonly #matrix = new Matrix4();
  readonly #recordBounds = new Box3();
  readonly #instance = new Matrix4();
  /** The authored bounds' centre, placed: the source sphere's centre. See `addPlacements`. */
  readonly #sourceCentre = new Vector3();
  /** The world grid, read once: a package's origin and cell side do not change for a world's life. */
  #grid: { readonly cellSize: number; readonly minX: number; readonly minZ: number } | undefined;

  constructor(
    options: {
      readonly placements: ArrayBuffer;
      readonly placementReach: Float32Array | undefined;
      readonly reachRanges: ReadonlyMap<
        IWorldCell,
        Map<string, { min: number; max: number; minY: number; maxY: number }>
      >;
      readonly lodHysteresis: number;
      readonly rebuildsPerUpdate: number;
    },
    host: ICellPlacementsHost,
  ) {
    this.#host = host;
    this.#placements = options.placements;
    this.#placementReach = options.placementReach;
    this.#reachRanges = options.reachRanges;
    this.#lodHysteresis = options.lodHysteresis;
    this.#rebuildsPerUpdate = options.rebuildsPerUpdate;
    this.#placementLevels =
      options.lodHysteresis > 0
        ? new Uint32Array(options.placements.byteLength / PLACEMENT_RECORD_BYTES)
        : undefined;
    this.#placementRanges =
      this.#placementLevels === undefined
        ? undefined
        : new Uint8Array(this.#placementLevels.length);
  }

  get placementReach(): Float32Array | undefined {
    return this.#placementReach;
  }
  /** Replacement builds that entered `addPlacements`; see `IWorldCellsStats.levelRefilters`. */
  get levelRefilters(): number {
    return this.#levelRefilters;
  }
  /** Rebuilds a refilter pass queued; see `IWorldCellsStats.rebuilds`. */
  get rebuilds(): number {
    return this.#rebuilds;
  }
  /** Refilter passes run, whether or not they queued anything. */
  get refilters(): number {
    return this.#refilters;
  }
  /** Stale cell-assets the passes found, cumulative. */
  get refilterEntries(): number {
    return this.#staleEntries;
  }
  /** Whether the last pass left work it could not queue. */
  get owed(): boolean {
    return this.#refilterOwed;
  }
  /** The far entry of the asset's finest gate, or none: the eye's blend limit. */
  get firstGate(): number {
    return this.#gates[0] ?? Number.POSITIVE_INFINITY;
  }
  /** The next pass owes a rerun even at a standing follow point. */
  owe(): void {
    this.#refilterOwed = true;
  }

  /** Borrowed scratch box: consume its transformed volume before the next bounds query. */
  #boundsAt(bounds: IWorldAsset["bounds"], matrix: Matrix4): Box3 {
    this.#recordBounds.min.fromArray(bounds.min);
    this.#recordBounds.max.fromArray(bounds.max);
    return this.#recordBounds.applyMatrix4(matrix);
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
  followY(): number {
    return this.#placementReach === undefined ? 0 : (this.#host.follow().position.y ?? 0);
  }

  stepMetres(): number {
    return this.#placementReach === undefined ? LEVEL_REFILTER_STEP_METRES : 0.75;
  }

  stale(x: number, z: number): boolean {
    if (this.#refilterOwed) return true;
    if (this.#refilterEpoch !== this.#host.residencyEpoch()) return true;
    return (
      Math.hypot(
        x - this.#refilterPoint.x,
        this.followY() - this.#refilterPoint.y,
        z - this.#refilterPoint.z,
      ) >= this.stepMetres() ||
      // The GPU dispatch grades levels from the camera every frame; only the CPU path rebuilds.
      (this.#host.gpuOn() === false &&
        this.#host.eye().distanceTo(this.#refilterEye) >= this.stepMetres())
    );
  }

  /**
   * Filter one slice of a run's placements into the batches they draw from, applying the CPU
   * maxDistance/reach filters at the build position and switching level where an asset's `lods` say
   * to. GPU admission retains maxDistance candidates for the dispatch; placementReach stays here
   * because it is an explicit per-record source boundary.
   */
  addPlacements(job: IBuildJob, from: number, to: number): void {
    const { asset, filterX, filterZ, lodX, lodY, lodZ } = job;
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
    const wantRoots = this.#host.rootsNeeded(asset);
    for (let index = from; index < to; index += 1) {
      const base = index * PLACEMENT_RECORD_FLOATS;
      const x = records[base] as number;
      const y = records[base + 1] as number;
      const z = records[base + 2] as number;
      // Streaming reach from the follow point; level and `maxDistance` from the LOD eye, which is
      // the camera the GPU dispatch measures from too. See `IWorldCellsLoadOptions.lodFrom`.
      const reachDistance =
        this.#placementReach === undefined
          ? Math.hypot(x - filterX, z - filterZ)
          : Math.hypot(x - filterX, y - job.filterY, z - filterZ);
      const distance =
        this.#placementReach === undefined
          ? Math.hypot(x - lodX, z - lodZ)
          : Math.hypot(x - lodX, y - lodY, z - lodZ);
      if (this.#host.gpuOn() === false && inner !== undefined && distance > inner) continue;
      const reach = this.#placementReach?.[job.run.offset + index];
      if (reach !== undefined && reachDistance > reach) continue;
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
      // A refilter that lands after the walk entered a dither band would swap a tree's look in one
      // frame. UE 5.8.3 fades every LOD change over `lod.TemporalLag` (0.5 s,
      // Engine/Source/Runtime/Engine/Private/SceneManagement.cpp:28): a record that was one whole
      // level and now publishes two names that level, and the swap stamps when the fade starts.
      let fadeFrom = -1;
      if (this.#placementRanges !== undefined) {
        const record = job.run.offset + index;
        const before = this.#placementRanges[record] as number;
        const beforeMin = (before & 15) - 1;
        const beforeMax = (before >> 4) - 1;
        if (
          before !== 0 &&
          beforeMin === beforeMax &&
          minPublished !== maxPublished &&
          beforeMin >= minPublished &&
          beforeMin <= maxPublished
        )
          fadeFrom = beforeMin;
        this.#placementRanges[record] = (minPublished + 1) | ((maxPublished + 1) << 4);
      }
      // The record's own world bounds: the placement widened by the asset's authored bounds at the
      // scale it is drawn at. Read here because this loop already holds the placement and the scale,
      // and it is the one number the shadow levels' invalidation is tested against — the cell box is
      // 64 m of it, so a level whose window is 48 m wide was redrawing over ground nothing in it.
      const bounds = asset.definition.bounds;
      const placedBox = this.#boundsAt(bounds, this.#matrix);
      job.placed ??= [];
      job.placed.push(
        index,
        placedBox.min.x,
        placedBox.min.y,
        placedBox.min.z,
        placedBox.max.x,
        placedBox.max.y,
        placedBox.max.z,
      );
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
        if (this.#host.gpuOn()) {
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
          if (range !== undefined) range.push(minPublished, maxPublished, fadeFrom, 0);
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
  widenFilterRange(cell: IResidentCell, filterX: number, filterZ: number): void {
    const [near, far] = this.#span(cell, filterX, filterZ);
    if (near < cell.filterNear) cell.filterNear = near;
    if (far > cell.filterFar) cell.filterFar = far;
  }

  buildOne(job: IBuildJob, batches: readonly InstancedBatch[][]): void {
    const { asset } = job;
    const { cell } = job;
    this.widenFilterRange(cell, job.lodX, job.lodZ);
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
        lastLodX: job.lodX,
        lastLodY: job.lodY,
        lastLodZ: job.lodZ,
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
   * The `[nearest, farthest]` distance from `(x, z)` to the rectangle a cell's placements lie in.
   *
   * ponytail: the rectangle is the compiler's contract — a run's records belong to the cell they
   * are filed under — so one interval covers every placement in a cell. A hand-edited package that
   * files a placement under a neighbouring cell keeps it at the level its own distance selects; a
   * validator check on the placement buffer is the fix if that ever has to be caught.
   */
  #span(cell: IResidentCell, x: number, z: number): readonly [number, number] {
    this.#grid ??= this.#host.extent();
    const { cellSize, minX, minZ } = this.#grid;
    const left = minX + cell.x * cellSize;
    const near = minZ + cell.z * cellSize;
    const right = left + cellSize;
    const far = near + cellSize;
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
    const eye = this.#host.eye();
    const [eyeNear, eyeFar] = this.#span(cell, eye.x, eye.z);
    for (const entry of cell.batches) {
      const reach = this.#reachRanges.get(cell.cell)?.get(entry.asset);
      if ((entry.threshold === undefined && reach === undefined) || seen.has(entry.asset)) continue;
      // Deferred runs of one asset can start at different camera snapshots. Only deduplicate
      // after one entry proves the asset stale: an earlier matching run cannot settle the others.
      const step = (entry.threshold ?? 6) / 8;
      if (
        Math.hypot(
          x - entry.lastFilterX,
          this.followY() - entry.lastFilterY,
          z - entry.lastFilterZ,
        ) <= step &&
        Math.hypot(eye.x - entry.lastLodX, eye.y - entry.lastLodY, eye.z - entry.lastLodZ) <= step
      )
        continue;
      const asset = this.#host.asset(entry.asset);
      if (asset === undefined) continue;
      // GPU dispatch handles maxDistance and LOD gates; placementReach remains a CPU boundary.
      const gates = this.#host.gpuOn() ? [] : asset.gates;
      // Gates bracket the LOD eye's distances, reach the follow point's: see `#addPlacements`.
      const [builtNear, builtFar] = this.#span(cell, entry.lastLodX, entry.lastLodZ);
      let low = Math.min(eyeNear, builtNear);
      // Ends included, so a placement exactly on a gate is one of the reasons to rebuild.
      let high = Math.max(eyeFar, builtFar);
      let reachCrossed = false;
      if (reach !== undefined) {
        const vertical = (y: number): [number, number] => [
          Math.max(reach.minY - y, y - reach.maxY, 0),
          Math.max(Math.abs(y - reach.minY), Math.abs(y - reach.maxY)),
        ];
        const eyeNow = vertical(eye.y);
        const eyeBefore = vertical(entry.lastLodY);
        low = Math.min(Math.hypot(eyeNear, eyeNow[0]), Math.hypot(builtNear, eyeBefore[0]));
        high = Math.max(Math.hypot(eyeFar, eyeNow[1]), Math.hypot(builtFar, eyeBefore[1]));
        const [reachBuiltNear, reachBuiltFar] = this.#span(
          cell,
          entry.lastFilterX,
          entry.lastFilterZ,
        );
        const current = vertical(this.followY());
        const previous = vertical(entry.lastFilterY);
        const reachLow = Math.min(
          Math.hypot(near, current[0]),
          Math.hypot(reachBuiltNear, previous[0]),
        );
        const reachHigh = Math.max(
          Math.hypot(far, current[1]),
          Math.hypot(reachBuiltFar, previous[1]),
        );
        reachCrossed = reach.min <= reachHigh && reach.max >= reachLow;
      }
      if (!reachCrossed && !gates.some((gate) => gate >= low && gate <= high)) continue;
      seen.add(entry.asset);
      this.#stale.push({ cell, distance: eyeNear, id: entry.asset });
      this.#staleEntries += 1;
    }
  }

  /**
   * Record that one more gate distance exists, keeping the world's list ascending so
   * {@link crossesGate} can binary search it. A gate is never withdrawn: an asset whose ring left
   * still leaves its distances behind, which costs a cell the gate test does not reject and never a
   * rebuild the pass owes.
   */
  noteGate(gate: number): void {
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
  refilter(x: number, z: number): void {
    this.#refilterPoint.set(x, this.followY(), z);
    this.#refilterEye.copy(this.#host.eye());
    this.#refilterEpoch = this.#host.residencyEpoch();
    this.#refilters += 1;
    const stale = this.#stale;
    stale.length = 0;
    this.#collectStale(x, z);
    // Only what was found, and usually a handful of entries.
    if (stale.length > 1) stale.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    // What the cap could not queue is still owed, and `stale` reads that: a standing follow
    // point has to keep coming back for it, or a walk that stopped mid-drain never finished.
    this.#refilterOwed = stale.length > this.#rebuildsPerUpdate;
    for (const job of stale.slice(0, this.#rebuildsPerUpdate)) {
      const asset = this.#host.asset(job.id);
      if (asset === undefined || asset.levels.length === 0) continue;
      // Every run of the group, not just the one that happens to carry the canonical's name: a cell
      // holding two names for one model has two stale answers, and rebuilding only the named one
      // left the other drawing the level its own distance has moved out of.
      for (const run of job.cell.cell.runs) {
        if (this.#host.canonical(run.asset) !== job.id) continue;
        this.#host.queueBuild(asset, job.cell, run, true);
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
    for (const cell of this.#host.resident()) {
      // Gates are measured from the LOD eye, and `filterNear`/`filterFar` hold the eyes built from.
      const [eyeNear, eyeFar] = this.#span(cell, this.#host.eye().x, this.#host.eye().z);
      const low = eyeNear < cell.filterNear ? eyeNear : cell.filterNear;
      const high = eyeFar > cell.filterFar ? eyeFar : cell.filterFar;
      if (!this.#reachRanges.has(cell.cell) && !crossesGate(this.#gates, low, high)) continue;
      const [near, far] = this.#span(cell, x, z);
      this.#staleIn(cell, x, z, near, far);
    }
  }
}
