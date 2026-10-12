import { BufferAttribute, BufferGeometry, Group, Sphere, Vector3 } from "three";
import type { IComputeDriven } from "./compute-driven.js";
import { GPUReadback, type IGPUReadbackSample } from "./gpu-readback.js";
import type { IRendererLike } from "./renderer.js";
import {
  type IWorldErosionOptions,
  type IWorldGpuPasses,
  createWorldGpuPasses,
  simulateWorldPassesCpu,
} from "./world-passes.js";
import { unionBounds } from "./world-region.js";

export interface IHeightfieldOrigin {
  readonly x: number;
  readonly z: number;
}

export interface IHeightfieldOptions {
  readonly columns: number;
  readonly depth: number;
  readonly heights: Float32Array;
  readonly origin: IHeightfieldOrigin;
  readonly rows: number;
  readonly width: number;
  readonly worldPasses?: IHeightfieldWorldPassOptions;
}

/** A rectangular window of a heightfield's canonical samples, in grid indices. */
/** Hands out the union of every window `updateHeights` wrote since the last `take`. */
export interface IHeightfieldChangeTracker {
  /** The changed window since the previous take, or undefined when nothing changed. */
  take(): IHeightfieldRegionBounds | undefined;
  /** Stop tracking. Idempotent. */
  dispose(): void;
}

export interface IHeightfieldRegionBounds {
  /** First column (x index), inclusive. */
  readonly column: number;
  /** Number of columns covered. */
  readonly columns: number;
  /** First row (z index), inclusive. */
  readonly row: number;
  /** Number of rows covered. */
  readonly rows: number;
}

/** A rectangular window plus the replacement samples written over it. */
export interface IHeightfieldRegion extends IHeightfieldRegionBounds {
  /** Row-major samples, `columns * rows` long and read with the region's own stride. */
  readonly heights: Float32Array;
}

export interface IHeightfieldWorldPassOptions {
  /** Maximum TSL compute dispatches submitted by one rendered frame. */
  readonly dispatchBudget: number;
  /** Reserved GPU path; true is rejected until GPU readback owns the canonical field. */
  readonly gpu?: boolean;
  /** Every physical coefficient is game supplied; core owns no terrain preset. */
  readonly erosion: IWorldErosionOptions;
}

export interface IHeightfieldSamplerOptions extends Omit<IHeightfieldOptions, "heights"> {
  /** Game-owned terrain function. It is evaluated once and never retained. */
  readonly sampleHeight: (x: number, z: number) => number;
}

interface IStoredHeightfieldChannels {
  readonly flow?: Float32Array;
  readonly moisture?: Float32Array;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`Heightfield ${name} must be finite.`);
  return value;
}

function positive(value: number, name: string): number {
  finite(value, name);
  if (value <= 0) throw new Error(`Heightfield ${name} must be greater than zero.`);
  return value;
}

function count(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 2)
    throw new Error(`Heightfield ${name} must be an integer of at least 2.`);
  return value;
}

/** Validates one axis of an update window against the field's own sample count. */
function regionAxis(
  start: number,
  size: number,
  total: number,
  names: readonly [string, string],
): { readonly count: number; readonly start: number } {
  if (!Number.isInteger(start) || start < 0)
    throw new Error(`Heightfield region ${names[0]} must be an integer of at least 0.`);
  if (!Number.isInteger(size) || size < 1)
    throw new Error(`Heightfield region ${names[1]} must be an integer of at least 1.`);
  if (start + size > total)
    throw new Error(
      `Heightfield region ${names[0]} ${String(start)} + ${names[1]} ${String(size)} exceeds the field's ${String(total)} samples.`,
    );
  return { count: size, start };
}

function regionColumns(
  region: IHeightfieldRegionBounds,
  total: number,
): { readonly count: number; readonly start: number } {
  return regionAxis(region.column, region.columns, total, ["column", "columns"]);
}

function regionRows(
  region: IHeightfieldRegionBounds,
  total: number,
): { readonly count: number; readonly start: number } {
  return regionAxis(region.row, region.rows, total, ["row", "rows"]);
}

function shouldBuildGpuPasses(options: IHeightfieldWorldPassOptions | undefined): boolean {
  return options?.gpu === true;
}

function validateWorldPassBudget(options: IHeightfieldWorldPassOptions): void {
  if (!Number.isInteger(options.dispatchBudget) || options.dispatchBudget <= 0)
    throw new Error("Heightfield world passes dispatchBudget must be a positive integer.");
  if (options.gpu === true) return;
  if (!Number.isInteger(options.erosion.iterations) || options.erosion.iterations < 0) return;
  if (options.erosion.iterations > options.dispatchBudget)
    throw new Error("Heightfield dispatchBudget cannot cover synchronous CPU erosion iterations.");
}

/**
 * One height buffer shared by world queries, rendered geometry, and a physics heightfield.
 *
 * The game supplies every value, so changing the terrain's shape never requires a package edit.
 * `fromSampler` evaluates that game function exactly once at each vertex and retains only the
 * resulting numbers. Queries interpolate those same numbers instead of evaluating the function
 * again.
 *
 * @situation build terrain geometry and collision from one game-authored height function
 * @situation generate a terrain a player can walk across
 * @situation query the same ground height or normal that a player sees and collides with
 * @situation ask how high the ground is here
 * @situation build islands and coastlines from terrain
 * @situation keep a collider or other copy of a deforming terrain in step without rescanning the whole field (`trackChanges`)
 * @constraint sampleHeight owns the terrain shape and stays in game source; the framework stores and interpolates its output
 * @constraint rows and columns are vertex counts; geometry is row-major z-then-x and collider export transposes once into Rapier's column-major matrix order
 * @override rows, columns, width, depth, origin, and sampleHeight are explicit on every field
 * @example const field = Heightfield.fromSampler({ rows: 65, columns: 65, width: 64, depth: 64, origin: { x: 0, z: 0 }, sampleHeight: terrainHeight });
 */
export class Heightfield extends Group implements IComputeDriven {
  readonly columns: number;
  readonly depth: number;
  readonly origin: IHeightfieldOrigin;
  readonly rows: number;
  readonly width: number;
  readonly processCadence = "render" as const;
  readonly warmupNodes: readonly unknown[];
  readonly #cellDepth: number;
  readonly #cellWidth: number;
  readonly #colliderHeights: Float32Array;
  readonly #trackers = new Set<{ region: IHeightfieldRegionBounds | undefined }>();
  readonly #heights: Float32Array;
  readonly #minimumX: number;
  readonly #minimumZ: number;
  readonly #flow: Float32Array | undefined;
  readonly #moisture: Float32Array | undefined;
  readonly #gpu: IWorldGpuPasses | undefined;
  readonly #heightReadback: GPUReadback | undefined;
  readonly #flowReadback: GPUReadback | undefined;
  readonly #moistureReadback: GPUReadback | undefined;
  #renderer: IRendererLike | undefined;
  #gpuCompletionObserved = false;
  #released = false;
  #version = 0;

  constructor(options: IHeightfieldOptions & IStoredHeightfieldChannels) {
    super();
    this.columns = count(options.columns, "columns");
    this.rows = count(options.rows, "rows");
    this.width = positive(options.width, "width");
    this.depth = positive(options.depth, "depth");
    this.origin = {
      x: finite(options.origin.x, "origin.x"),
      z: finite(options.origin.z, "origin.z"),
    };
    const expected = this.rows * this.columns;
    if (options.heights.length !== expected)
      throw new Error(
        `Heightfield expected ${expected} heights, received ${options.heights.length}.`,
      );
    if (options.flow !== undefined && options.flow.length !== expected)
      throw new Error(
        `Heightfield expected ${expected} flow samples, received ${options.flow.length}.`,
      );
    if (options.moisture !== undefined && options.moisture.length !== expected)
      throw new Error(
        `Heightfield expected ${expected} moisture samples, received ${options.moisture.length}.`,
      );
    for (const height of options.heights) finite(height, "height sample");
    for (const value of options.flow ?? []) finite(value, "flow sample");
    for (const value of options.moisture ?? []) finite(value, "moisture sample");
    const baseHeights = options.heights.slice();
    const storedFlow = options.flow?.slice();
    const storedMoisture = options.moisture?.slice();
    const passOptions = options.worldPasses;
    if (passOptions !== undefined) validateWorldPassBudget(passOptions);
    if (passOptions?.gpu === true)
      throw new Error(
        "Heightfield GPU generation cannot be canonical; use gpu: false until GPU readback owns the field.",
      );
    const cpu =
      passOptions === undefined
        ? undefined
        : simulateWorldPassesCpu({
            cellDepth: this.depth / (this.rows - 1),
            cellWidth: this.width / (this.columns - 1),
            columns: this.columns,
            erosion: passOptions.erosion,
            heights: baseHeights,
            rows: this.rows,
          });
    this.#heights = cpu?.heights ?? baseHeights;
    this.#flow = cpu?.flow ?? storedFlow;
    this.#moisture = cpu?.moisture ?? storedMoisture;
    // The explicit GPU request is rejected above; omitted and CPU-fallback paths never create GPU
    // state and cannot accidentally expose a CPU-canonical field as GPU-generated.
    this.#gpu =
      passOptions === undefined || !shouldBuildGpuPasses(passOptions)
        ? undefined
        : createWorldGpuPasses({
            cellDepth: this.depth / (this.rows - 1),
            cellWidth: this.width / (this.columns - 1),
            columns: this.columns,
            dispatchBudget: passOptions.dispatchBudget,
            erosion: passOptions.erosion,
            heights: baseHeights,
            rows: this.rows,
          });
    this.warmupNodes = this.#gpu?.stages.flatMap((stage) => stage.nodes) ?? [];
    this.#heightReadback =
      this.#gpu === undefined
        ? undefined
        : new GPUReadback({ attribute: this.#gpu.height.value, everyFrames: 1 });
    this.#flowReadback =
      this.#gpu === undefined
        ? undefined
        : new GPUReadback({ attribute: this.#gpu.flow.value, everyFrames: 1 });
    this.#moistureReadback =
      this.#gpu === undefined
        ? undefined
        : new GPUReadback({ attribute: this.#gpu.moisture.value, everyFrames: 1 });
    this.#colliderHeights = new Float32Array(expected);
    for (let column = 0; column < this.columns; column += 1) {
      for (let row = 0; row < this.rows; row += 1) {
        this.#colliderHeights[column * this.rows + row] = this.#height(row * this.columns + column);
      }
    }
    this.#cellWidth = this.width / (this.columns - 1);
    this.#cellDepth = this.depth / (this.rows - 1);
    this.#minimumX = this.origin.x - this.width / 2;
    this.#minimumZ = this.origin.z - this.depth / 2;
  }

  static fromSampler(options: IHeightfieldSamplerOptions): Heightfield {
    const columns = count(options.columns, "columns");
    const rows = count(options.rows, "rows");
    const width = positive(options.width, "width");
    const depth = positive(options.depth, "depth");
    const originX = finite(options.origin.x, "origin.x");
    const originZ = finite(options.origin.z, "origin.z");
    const minimumX = originX - width / 2;
    const minimumZ = originZ - depth / 2;
    const cellWidth = width / (columns - 1);
    const cellDepth = depth / (rows - 1);
    const heights = new Float32Array(rows * columns);

    for (let row = 0; row < rows; row += 1) {
      const z = minimumZ + row * cellDepth;
      for (let column = 0; column < columns; column += 1) {
        const x = minimumX + column * cellWidth;
        heights[row * columns + column] = finite(options.sampleHeight(x, z), "sampleHeight result");
      }
    }

    return new Heightfield({
      columns,
      depth,
      heights,
      origin: options.origin,
      rows,
      width,
      ...(options.worldPasses === undefined ? {} : { worldPasses: options.worldPasses }),
    });
  }

  sample(channel: string, x: number, z: number): number {
    if (channel === "height") return this.heightAt(x, z);
    if (channel === "slope") return 1 - this.normalAt(x, z).y;
    const values =
      channel === "flow" ? this.#flow : channel === "moisture" ? this.#moisture : undefined;
    if (values === undefined) throw new Error(`Heightfield unknown channel '${channel}'.`);
    return this.#interpolateValues(values, x, z);
  }

  get released(): boolean {
    return this.#released;
  }

  get generationComplete(): boolean {
    return this.#gpu?.queue.complete ?? true;
  }

  get gpuHeightSample(): IGPUReadbackSample | undefined {
    return this.#heightReadback?.sample;
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("Heightfield cannot be attached after release.");
    if (this.#gpu === undefined) return;
    if (renderer.kind !== "webgpu") throw new Error("Heightfield world passes require WebGPU.");
    if (this.#renderer !== undefined && this.#renderer !== renderer)
      throw new Error("Heightfield is already attached to a renderer.");
    this.#renderer = renderer;
  }

  process(renderer = this.#renderer): void {
    if (this.#released || this.#gpu === undefined) return;
    if (renderer === undefined) throw new Error("Heightfield is not attached to a renderer.");
    const submitted = this.#gpu.queue.process(renderer);
    if (submitted > 0 || !this.#gpu.queue.complete) {
      this.#gpuCompletionObserved = false;
      return;
    }
    // Compute is scheduled before the renderer's draw. Delay the first copy until the next loop
    // turn so the submitted passes have actually run; an immediate getArrayBufferAsync observes
    // the previous storage contents on WebGPU and turns parity into a false no-data report.
    if (!this.#gpuCompletionObserved) {
      this.#gpuCompletionObserved = true;
      return;
    }
    if (this.#heightReadback?.sample === undefined) {
      this.#heightReadback?.request(renderer);
      return;
    }
    if (this.#flowReadback?.sample === undefined) {
      this.#flowReadback?.request(renderer);
      return;
    }
    if (this.#moistureReadback?.sample === undefined) this.#moistureReadback?.request(renderer);
  }

  debug(): Record<string, unknown> {
    return {
      complete: this.generationComplete,
      dispatched: this.#gpu?.queue.dispatched ?? 0,
      gpuHeightMaxError: this.#sampleError(this.#heightReadback?.sample, this.#heights),
      gpuFlowMaxError: this.#sampleError(this.#flowReadback?.sample, this.#flow),
      gpuMoistureMaxError: this.#sampleError(this.#moistureReadback?.sample, this.#moisture),
      released: this.#released,
    };
  }

  detach(): void {
    if (this.#released) return;
    this.#renderer = undefined;
    this.#heightReadback?.dispose();
    this.#flowReadback?.dispose();
    this.#moistureReadback?.dispose();
    this.#gpu?.dispose();
    this.#released = true;
  }

  /** A copy of the canonical row-major samples, safe for game-side analysis. */
  get heights(): Float32Array {
    return this.#heights.slice();
  }

  /** A copy of the normalized routed-flow channel, when world passes were requested. */
  get flow(): Float32Array | undefined {
    return this.#flow?.slice();
  }

  /** Bytes retained by this field's CPU channels and its conservative GPU allowance. */
  get memoryBytes(): number {
    const sampleBytes = this.rows * this.columns * Float32Array.BYTES_PER_ELEMENT;
    const cpuBytes =
      sampleBytes * 2 +
      (this.#flow === undefined ? 0 : sampleBytes) +
      (this.#moisture === undefined ? 0 : sampleBytes);
    return this.#gpu === undefined ? cpuBytes : Math.max(cpuBytes, sampleBytes * 24);
  }

  heightAt(x: number, z: number): number {
    finite(x, "query x");
    finite(z, "query z");
    const column = (x - this.#minimumX) / this.#cellWidth;
    const row = (z - this.#minimumZ) / this.#cellDepth;
    const epsilon = 1e-9;
    if (
      column < -epsilon ||
      row < -epsilon ||
      column > this.columns - 1 + epsilon ||
      row > this.rows - 1 + epsilon
    )
      throw new Error(`Heightfield query (${x}, ${z}) is outside its resident region.`);
    return this.#interpolate(
      Math.min(this.columns - 1, Math.max(0, column)),
      Math.min(this.rows - 1, Math.max(0, row)),
    );
  }

  normalAt(x: number, z: number, target = new Vector3()): Vector3 {
    this.heightAt(x, z);
    const leftX = Math.max(this.#minimumX, x - this.#cellWidth);
    const rightX = Math.min(this.#minimumX + this.width, x + this.#cellWidth);
    const nearZ = Math.max(this.#minimumZ, z - this.#cellDepth);
    const farZ = Math.min(this.#minimumZ + this.depth, z + this.#cellDepth);
    const slopeX = (this.heightAt(rightX, z) - this.heightAt(leftX, z)) / (rightX - leftX);
    const slopeZ = (this.heightAt(x, farZ) - this.heightAt(x, nearZ)) / (farZ - nearZ);
    return target.set(-slopeX, 1, -slopeZ).normalize();
  }

  /**
   * Monotonic sample version, incremented by every `updateHeights` call.
   *
   * A renderer or collider that caches derived data compares this against its own last-seen value
   * instead of diffing the whole grid each frame.
   */
  get version(): number {
    return this.#version;
  }

  /**
   * Overwrite one rectangular window of the canonical samples.
   *
   * Height is the one buffer queries, rendered geometry and collider export share, so a second
   * terrain representation is never needed: a simulation writes its surface here and every
   * consumer already reads it. The whole window is validated before any sample changes, so a
   * malformed call leaves the field untouched rather than half-written.
   * @situation deform terrain, snow or water in place and have queries and collision follow
   * @constraint the region must lie inside the field; an out-of-bounds window throws and writes nothing
   * @constraint heights is `columns * rows` long, row-major, and every sample must be finite
   */
  updateHeights(region: IHeightfieldRegion): void {
    if (this.#released) throw new Error("Heightfield cannot be updated after release.");
    const column = regionColumns(region, this.columns);
    const row = regionRows(region, this.rows);
    const expected = column.count * row.count;
    if (region.heights.length !== expected)
      throw new Error(
        `Heightfield region expected ${expected} heights, received ${region.heights.length}.`,
      );
    for (const height of region.heights) finite(height, "region sample");
    for (let index = 0; index < row.count; index += 1) {
      for (let offset = 0; offset < column.count; offset += 1) {
        const target = row.start + index;
        const source = column.start + offset;
        this.#heights[target * this.columns + source] = region.heights[
          index * column.count + offset
        ] as number;
        this.#colliderHeights[source * this.rows + target] = this.#height(
          target * this.columns + source,
        );
      }
    }
    const written = {
      column: column.start,
      columns: column.count,
      row: row.start,
      rows: row.count,
    };
    for (const tracker of this.#trackers) tracker.region = unionBounds(tracker.region, written);
    this.#version += 1;
  }

  /**
   * Follow which samples change, independently of every other follower.
   *
   * A consumer that mirrors the surface — a collider, a GPU copy, a cache — needs the window that
   * changed since *it* last looked; comparing the whole field instead costs every sample on every
   * change. Each tracker keeps its own union of the windows `updateHeights` wrote, so two
   * consumers never take each other's changes.
   *
   * ```ts
   * const changes = field.trackChanges();
   * const changed = changes.take(); // undefined when nothing was written
   * ```
   */
  trackChanges(): IHeightfieldChangeTracker {
    const state: { region: IHeightfieldRegionBounds | undefined } = { region: undefined };
    this.#trackers.add(state);
    return {
      take: () => {
        const region = state.region;
        state.region = undefined;
        return region;
      },
      dispose: () => {
        this.#trackers.delete(state);
      },
    };
  }

  /** The collider sample at `row`, `column`: what `toColliderHeights()` holds there, without a copy. */
  colliderHeight(row: number, column: number): number {
    if (
      !Number.isInteger(row) ||
      !Number.isInteger(column) ||
      row < 0 ||
      column < 0 ||
      row >= this.rows ||
      column >= this.columns
    )
      throw new Error(`Heightfield sample ${row},${column} is outside the field.`);
    return this.#colliderHeights[column * this.rows + row] as number;
  }

  /**
   * Rewrite an existing `toGeometry()` result from the current canonical samples.
   *
   * Positions carry over unchanged because only the surface moves; y and normals are refreshed
   * from the same sampler queries use, which is what keeps a rendered vertex and a height query
   * from disagreeing. Pass a region to touch only the window a simulation just changed.
   * @situation redraw a terrain, snow or water mesh after its samples changed
   * @constraint geometry must come from `toGeometry()` with the same rows and columns
   */
  refreshGeometry(geometry: BufferGeometry, bounds?: IHeightfieldRegionBounds): void {
    const position = geometry.getAttribute("position");
    const normalAttribute = geometry.getAttribute("normal");
    if (position.count !== this.rows * this.columns)
      throw new Error(
        `Heightfield geometry has ${position.count} vertices, expected ${this.rows * this.columns}.`,
      );
    const column =
      bounds === undefined
        ? { count: this.columns, start: 0 }
        : regionColumns(bounds, this.columns);
    const row =
      bounds === undefined ? { count: this.rows, start: 0 } : regionRows(bounds, this.rows);
    let lowest = Number.POSITIVE_INFINITY;
    let highest = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < row.count; index += 1) {
      const target = row.start + index;
      for (let offset = 0; offset < column.count; offset += 1) {
        const source = column.start + offset;
        const vertex = target * this.columns + source;
        const height = this.#height(vertex);
        position.setY(vertex, height);
        lowest = Math.min(lowest, height);
        highest = Math.max(highest, height);
        if (normalAttribute === undefined) continue;
        this.#gridNormal(source, target, normalAttribute, vertex);
      }
    }
    position.needsUpdate = true;
    if (normalAttribute !== undefined) normalAttribute.needsUpdate = true;
    // Only heights move, so a windowed refresh grows the existing bounds by the window's own
    // range instead of walking every vertex again: on a 321-sample field the full recompute cost
    // two milliseconds for a footprint-sized window. Bounds may stay conservative after a refill.
    const box = geometry.boundingBox;
    if (bounds === undefined || box === null) {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      return;
    }
    box.min.y = Math.min(box.min.y, lowest);
    box.max.y = Math.max(box.max.y, highest);
    geometry.boundingSphere = box.getBoundingSphere(geometry.boundingSphere ?? new Sphere());
  }

  /** The same values transposed once into Rapier's column-major height-matrix order. */
  toColliderHeights(): Float32Array {
    return this.#colliderHeights.slice();
  }

  /** Builds an ordinary Three.js geometry without choosing its surface. */
  toGeometry(): BufferGeometry {
    const count = this.rows * this.columns;
    const positions = new Float32Array(count * 3);
    const normals = new Float32Array(count * 3);
    const normal = new Vector3();
    for (let row = 0; row < this.rows; row += 1) {
      const localZ = -this.depth / 2 + row * this.#cellDepth;
      const worldZ = this.origin.z + localZ;
      for (let column = 0; column < this.columns; column += 1) {
        const index = row * this.columns + column;
        const localX = -this.width / 2 + column * this.#cellWidth;
        const worldX = this.origin.x + localX;
        positions[index * 3] = localX;
        positions[index * 3 + 1] = this.#height(index);
        positions[index * 3 + 2] = localZ;
        this.normalAt(worldX, worldZ, normal);
        normals[index * 3] = normal.x;
        normals[index * 3 + 1] = normal.y;
        normals[index * 3 + 2] = normal.z;
      }
    }

    const indices = new Uint32Array((this.rows - 1) * (this.columns - 1) * 6);
    let offset = 0;
    for (let row = 0; row < this.rows - 1; row += 1) {
      for (let column = 0; column < this.columns - 1; column += 1) {
        const upperLeft = row * this.columns + column;
        const upperRight = upperLeft + 1;
        const lowerLeft = upperLeft + this.columns;
        const lowerRight = lowerLeft + 1;
        indices.set([upperLeft, lowerLeft, upperRight, upperRight, lowerLeft, lowerRight], offset);
        offset += 6;
      }
    }

    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    return geometry;
  }

  #interpolate(column: number, row: number): number {
    const column0 = Math.floor(column);
    const row0 = Math.floor(row);
    const column1 = Math.min(this.columns - 1, column0 + 1);
    const row1 = Math.min(this.rows - 1, row0 + 1);
    const columnMix = column - column0;
    const rowMix = row - row0;
    const upperLeft = this.#height(row0 * this.columns + column0);
    const upperRight = this.#height(row0 * this.columns + column1);
    const lowerLeft = this.#height(row1 * this.columns + column0);
    const lowerRight = this.#height(row1 * this.columns + column1);
    const upper = upperLeft + (upperRight - upperLeft) * columnMix;
    const lower = lowerLeft + (lowerRight - lowerLeft) * columnMix;
    return upper + (lower - upper) * rowMix;
  }

  #interpolateValues(values: Float32Array, x: number, z: number): number {
    finite(x, "query x");
    finite(z, "query z");
    const column = (x - this.#minimumX) / this.#cellWidth;
    const row = (z - this.#minimumZ) / this.#cellDepth;
    if (column < 0 || row < 0 || column > this.columns - 1 || row > this.rows - 1)
      throw new Error(`Heightfield query (${x}, ${z}) is outside its resident region.`);
    const column0 = Math.floor(column);
    const row0 = Math.floor(row);
    const column1 = Math.min(this.columns - 1, column0 + 1);
    const row1 = Math.min(this.rows - 1, row0 + 1);
    const columnMix = column - column0;
    const rowMix = row - row0;
    const upper =
      (values[row0 * this.columns + column0] as number) * (1 - columnMix) +
      (values[row0 * this.columns + column1] as number) * columnMix;
    const lower =
      (values[row1 * this.columns + column0] as number) * (1 - columnMix) +
      (values[row1 * this.columns + column1] as number) * columnMix;
    return upper * (1 - rowMix) + lower * rowMix;
  }

  #sampleError(
    sample: IGPUReadbackSample | undefined,
    expected: Float32Array | undefined,
  ): number | undefined {
    if (sample === undefined || expected === undefined) return undefined;
    if (sample.data.length !== expected.length) return Number.POSITIVE_INFINITY;
    let maximum = 0;
    for (let index = 0; index < expected.length; index += 1)
      maximum = Math.max(
        maximum,
        Math.abs((sample.data[index] as number) - (expected[index] as number)),
      );
    return maximum;
  }

  /**
   * `normalAt` at a sample, read straight from the grid: the same central differences, one-sided
   * at the border, without five validated bilinear queries per vertex. On a 401-sample field a
   * windowed refresh spent most of its time in those queries.
   */
  #gridNormal(
    column: number,
    row: number,
    target: { setXYZ(index: number, x: number, y: number, z: number): unknown },
    vertex: number,
  ): void {
    const left = Math.max(0, column - 1);
    const right = Math.min(this.columns - 1, column + 1);
    const near = Math.max(0, row - 1);
    const far = Math.min(this.rows - 1, row + 1);
    const slopeX =
      (this.#height(row * this.columns + right) - this.#height(row * this.columns + left)) /
      ((right - left) * this.#cellWidth);
    const slopeZ =
      (this.#height(far * this.columns + column) - this.#height(near * this.columns + column)) /
      ((far - near) * this.#cellDepth);
    const length = Math.hypot(slopeX, 1, slopeZ);
    target.setXYZ(vertex, -slopeX / length, 1 / length, -slopeZ / length);
  }

  #height(index: number): number {
    const height = this.#heights[index];
    if (height === undefined) throw new Error(`Heightfield internal sample ${index} is missing.`);
    return height;
  }
}

export { TerrainTiles } from "./world-tiles.js";
export type {
  IAdmissionBudget,
  IWorldTileColliderInput,
  IWorldTilesTopologyObservation,
} from "./world-tiles.js";

export {
  TERRAIN_VALIDATE_FLAG,
  TERRAIN_VALIDATE_MARKER,
  terrainValidationRequested,
} from "./world-validate.js";

export { getWorldCapabilities } from "./world-capabilities.js";
export type { IWorldCapabilities } from "./world-capabilities.js";

export { cellPlacements, validateWorldPackage } from "./world-package.js";
export type {
  IWorldAsset,
  IWorldAssetBounds,
  IWorldAssetLod,
  IWorldCell,
  IWorldCellProxy,
  IWorldExtent,
  IWorldPackage,
  IWorldPackageError,
  IWorldPackageValidationOptions,
  IWorldRun,
  IWorldTerrain,
  WorldPackageErrorCode,
} from "./world-package.js";

export { SnowField, snowDiscFootprint } from "./snow-field.js";
export type {
  ISnowContact,
  ISnowFieldOptions,
  ISnowFieldSample,
  ISnowFootprint,
  ISnowFootprintSample,
} from "./snow-field.js";

export { heightSamplerFromHeightmap, loadWorldHeightmap } from "./world-heightmap.js";
export { loadTerrainSplat } from "./world-terrain-splat.js";
export type {
  ILoadTerrainSplatOptions,
  ITerrainSplatLayer,
  ITerrainSplatMaskedLayer,
  ITerrainSplatTable,
  ITerrainSplatWeightContext,
} from "./world-terrain-splat.js";

export { WorldCells } from "./world-cells.js";
export type {
  IShadowRegion,
  IWorldCellsBudget,
  IWorldCellsFollow,
  IWorldCellsLoadOptions,
  IWorldCellsStats,
  IWorldCellsTerrainOptions,
  IWorldRegionReadiness,
} from "./world-cells.js";
