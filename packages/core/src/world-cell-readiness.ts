import { Box3, type Camera, Frustum, Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import type { IRendererLike } from "./renderer.js";
import {
  type IResidentCell,
  type ISpawnWaiter,
  type IWorldRegionReadiness,
  cellKey,
} from "./world-cell-data.js";
import { PLACEMENT_RECORD_FLOATS, cullDistance } from "./world-cell-impostors.js";
import type { IAssetState } from "./world-cell-models.js";
import type { CellPrewarm } from "./world-cell-prewarm.js";
import { type IWorldAsset, type IWorldCell, cellPlacements } from "./world-package.js";
import type { TerrainTiles } from "./world-tiles.js";

const _readinessPosition = new Vector3();

/**
 * What the spawn and view gates ask their world for. Every member is a read; the two gates settle
 * themselves, and `update` and `dispose` only tell them when to look.
 */
export interface ICellReadinessHost {
  released(): boolean;
  cells(): readonly IWorldCell[];
  /** The world grid's origin and cell side. */
  extent(): { readonly cellSize: number; readonly minX: number; readonly minZ: number };
  extentBounds(): Box3;
  placements(): ArrayBuffer;
  placementReach(): Float32Array | undefined;
  canonical(id: string): string;
  /** The loaded asset state, which is where a failed model is counted. */
  asset(id: string): IAssetState | undefined;
  /** The package's own asset definition, which carries the authored bounds. */
  manifestAsset(id: string): IWorldAsset | undefined;
  terrain(): TerrainTiles | undefined;
  terrainHeights(): readonly [number, number];
  loaded(cell: IResidentCell): boolean;
  resident(key: string): IResidentCell | undefined;
  /** Whether a build for this cell is still queued, so its content is not finished. */
  buildQueued(cell: IResidentCell): boolean;
  gpuOn(): boolean;
  shadowMoved(): boolean;
  refilterOwed(): boolean;
  prewarm(): CellPrewarm;
  renderer(): IRendererLike | undefined;
  root(): Object3D;
}

/**
 * The two readiness questions a streamed world answers, and the spawn gate built on them.
 *
 * `readinessAt` is the one authority for "the spawn's data is loaded"; `terrainReadinessInView` is
 * the same question for terrain alone, which is what a camera-based gate reads. The spawn waiters
 * are one set observed by the update that already walks residency, so a world nobody waits on scans
 * nothing.
 *
 * The view cache is keyed on the camera's projection, transform, focus point and the GPU scene's own
 * switch, and on `placementReach`'s contents: package placements and bounds are immutable, so a
 * camera that has not moved asks the same cells the same question.
 */
export class CellReadiness {
  readonly #host: ICellReadinessHost;
  readonly #visible = new Map<IWorldCell, boolean>();
  #view: number[] = [];
  #reach: Float32Array | undefined;
  readonly #frustum = new Frustum();
  readonly #projection = new Matrix4();
  /** Games waiting on `whenSpawnReady`, settled by the update that follows admissions or by dispose. */
  readonly #waiters = new Set<ISpawnWaiter>();
  /** Borrowed scratch for one position: consume it before the next query. */
  readonly #cameraPosition = _readinessPosition;
  readonly #position = new Vector3();
  readonly #rotation = new Quaternion();
  readonly #scale = new Vector3();
  readonly #matrix = new Matrix4();
  readonly #recordBounds = new Box3();
  /** The authored bounds' centre, placed: the source sphere's centre. See `#cellInView`. */
  readonly #sourceCentre = new Vector3();

  constructor(host: ICellReadinessHost) {
    this.#host = host;
  }

  /** Borrowed scratch box: consume its transformed volume before the next bounds query. */
  #boundsAt(bounds: IWorldAsset["bounds"], matrix: Matrix4): Box3 {
    this.#recordBounds.min.fromArray(bounds.min);
    this.#recordBounds.max.fromArray(bounds.max);
    return this.#recordBounds.applyMatrix4(matrix);
  }

  /** Completed content intersecting a square around a fixed spawn, in world metres. */
  at(
    position: Camera | { readonly x: number; readonly z: number },
    radius = 0,
  ): IWorldRegionReadiness {
    const { cellSize, minX, minZ } = this.#host.extent();
    const camera = "isCamera" in position && position.isCamera ? position : undefined;
    if (camera !== undefined) {
      camera.updateMatrixWorld(true);
      if (
        ![...camera.projectionMatrix.elements, ...camera.matrixWorldInverse.elements].every(
          Number.isFinite,
        )
      )
        throw new Error("WorldCells readiness requires a finite camera projection and transform.");
      this.#frustum.setFromProjectionMatrix(
        this.#projection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        camera.coordinateSystem,
      );
    }
    const point = camera
      ? camera.getWorldPosition(this.#cameraPosition)
      : (position as { readonly x: number; readonly z: number });
    if (
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.z) ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      throw new Error("WorldCells readiness requires finite coordinates and a nonnegative radius.");
    if (camera !== undefined) {
      const reach = this.#host.placementReach();
      const view = [
        ...camera.projectionMatrix.elements,
        ...camera.matrixWorldInverse.elements,
        point.x,
        (point as Vector3).y,
        point.z,
        camera.coordinateSystem,
        Number(this.#host.gpuOn()),
      ];
      // Package placements/bounds are immutable; reach is compared too so edits cannot go stale.
      if (
        !view.every((value, index) => value === this.#view[index]) ||
        reach?.some((value, index) => value !== this.#reach?.[index])
      ) {
        this.#visible.clear();
        this.#view = view;
        if (reach !== undefined) {
          this.#reach ??= new Float32Array(reach.length);
          this.#reach.set(reach);
        }
      }
    }
    const lowX = Math.floor((point.x - radius - minX) / cellSize);
    const highX = Math.floor((point.x + radius - minX) / cellSize);
    const lowZ = Math.floor((point.z - radius - minZ) / cellSize);
    const highZ = Math.floor((point.z + radius - minZ) / cellSize);
    let requiredCells = 0;
    let loadedCells = 0;
    let failures = 0;
    let requiredTerrainTiles = 0;
    let loadedTerrainTiles = 0;
    for (const cell of this.#host.cells()) {
      if (camera === undefined) {
        if (cell.x < lowX || cell.x > highX || cell.z < lowZ || cell.z > highZ) continue;
      } else if (!this.#cellInView(cell, point as Vector3)) continue;
      requiredCells++;
      const resident = this.#host.resident(cellKey(cell.x, cell.z));
      if (
        resident &&
        this.#host.loaded(resident) &&
        (camera === undefined || !this.#host.buildQueued(resident))
      )
        loadedCells++;
      if (resident?.chunkFailed) failures++;
      for (const run of cell.runs)
        if (this.#host.asset(this.#host.canonical(run.asset))?.failed) failures++;
    }
    if (camera !== undefined) {
      const terrain = this.#host
        .terrain()
        ?.readinessInView(camera, this.#host.terrainHeights()) ?? {
        required: 0,
        loaded: 0,
      };
      requiredTerrainTiles = terrain.required;
      loadedTerrainTiles = terrain.loaded;
    } else {
      const terrain = this.#host.terrain()?.readinessAt(point, radius) ?? {
        required: 0,
        loaded: 0,
      };
      requiredTerrainTiles = terrain.required;
      loadedTerrainTiles = terrain.loaded;
    }
    return {
      requiredCells,
      loadedCells,
      requiredTerrainTiles,
      loadedTerrainTiles,
      failures,
      cancelled: this.#host.released(),
      ready:
        !this.#host.released() &&
        failures === 0 &&
        loadedCells === requiredCells &&
        loadedTerrainTiles === requiredTerrainTiles &&
        (camera === undefined || (!this.#host.shadowMoved() && !this.#host.refilterOwed())),
    };
  }
  /** Use the same authored placement bounds and distance test as admission, even before residency. */
  #cellInView(cell: IWorldCell, eye: Vector3): boolean {
    const { cellSize, minX, minZ } = this.#host.extent();
    const cached = this.#visible.get(cell);
    if (cached !== undefined) return cached;
    this.#visible.set(cell, false);
    if (this.#host.terrain() !== undefined || (cell.chunks?.length ?? 0) > 0) {
      const box = this.#recordBounds;
      box.min.set(
        minX + cell.x * cellSize,
        this.#host.extentBounds().min.y,
        minZ + cell.z * cellSize,
      );
      box.max.set(
        minX + (cell.x + 1) * cellSize,
        this.#host.extentBounds().max.y,
        minZ + (cell.z + 1) * cellSize,
      );
      if (this.#frustum.intersectsBox(box)) {
        this.#visible.set(cell, true);
        return true;
      }
    }
    for (const run of cell.runs) {
      const asset = this.#host.manifestAsset(this.#host.canonical(run.asset));
      if (asset === undefined) continue;
      const records = cellPlacements(this.#host.placements(), run);
      for (let index = 0; index < run.count; index++) {
        const at = index * PLACEMENT_RECORD_FLOATS;
        this.#position.fromArray(records, at);
        const distance =
          this.#host.placementReach() === undefined
            ? Math.hypot(this.#position.x - eye.x, this.#position.z - eye.z)
            : this.#position.distanceTo(eye);
        const reach = this.#host.placementReach()?.[run.offset + index];
        if (reach !== undefined && distance > reach) continue;
        this.#rotation.fromArray(records, at + 3);
        this.#scale.setScalar(records[at + 7] as number);
        this.#matrix.compose(this.#position, this.#rotation, this.#scale);
        const box = this.#boundsAt(asset.bounds, this.#matrix);
        const inner = cullDistance(asset.maxDistance);
        const centre = box.getCenter(this.#sourceCentre);
        const drawDistance = this.#host.gpuOn()
          ? Math.hypot(centre.x - eye.x, centre.z - eye.z)
          : distance;
        if (inner !== undefined && drawDistance > inner) continue;
        if (this.#frustum.intersectsBox(box)) {
          this.#visible.set(cell, true);
          return true;
        }
      }
    }
    return false;
  }

  /** Terrain data needed by the current camera, including visible tiles not yet admitted. */
  terrainReadinessInView(camera: Camera): { required: number; loaded: number } {
    return (
      this.#host.terrain()?.readinessInView(camera, this.#host.terrainHeights()) ?? {
        required: 0,
        loaded: 0,
      }
    );
  }

  /** Visible CPU scatter batches still awaiting a nonempty main-camera backend submission. */
  pendingCpuDrawsInView(camera: Camera): number {
    return this.#host
      .prewarm()
      .pendingCpuDrawsInView(this.#host.root(), camera, this.#host.renderer());
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
    if (this.#host.released()) return Promise.reject(new Error("WorldCells disposed"));
    const snapshot = { x: position.x, z: position.z };
    const immediate = this.at(snapshot, radius);
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
          this.#waiters.delete(waiter);
          reject(new Error(`WorldCells spawn exceeded ${String(timeoutMs)} ms`));
        }, timeoutMs),
      };
      this.#waiters.add(waiter);
    });
  }

  /** Settle the waiters this frame's admissions can answer; a non-Disposed, non-Failed region waits. */
  settleWaiters(): void {
    if (this.#waiters.size === 0) return;
    for (const waiter of this.#waiters) {
      const readiness = this.at(waiter.position, waiter.radius);
      if (readiness.failures > 0) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.reject(new Error("WorldCells spawn assets failed to load"));
      } else if (readiness.ready) {
        this.#waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(readiness);
      }
    }
  }
  /** Reject every waiter a teardown found: a world torn down mid-wait answers its games. */
  cancelWaiters(): void {
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("WorldCells spawn cancelled"));
    }
    this.#waiters.clear();
  }
}
