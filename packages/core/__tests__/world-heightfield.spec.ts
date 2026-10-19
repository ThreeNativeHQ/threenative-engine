import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Heightfield } from "../src/world.js";

function terrain(seed: number, x: number, z: number): number {
  const phase = seed * 0.013;
  const warpX = Math.sin(z * 0.021 + phase) * 19;
  const warpZ = Math.cos(x * 0.017 - phase) * 17;
  return (
    Math.sin((x + warpX) * 0.012 + phase) * 18 +
    Math.cos((z + warpZ) * 0.019 - phase) * 9 +
    Math.sin((x + z) * 0.047 + phase * 3) * 2
  );
}

function field(seed: number): Heightfield {
  return Heightfield.fromSampler({
    columns: 17,
    depth: 48,
    origin: { x: 32, z: -16 },
    rows: 13,
    sampleHeight: (x, z) => terrain(seed, x, z),
    width: 64,
  });
}

function hash(values: Float32Array): string {
  return createHash("sha256")
    .update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
    .digest("hex");
}

describe("Heightfield", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should produce an identical field for an identical game seed", () => {
    expect(hash(field(1337).heights)).toBe(hash(field(1337).heights));
  });

  it("should produce a materially different field for a different game seed", () => {
    const first = field(1337).heights;
    const second = field(7331).heights;
    let squaredDistance = 0;
    for (let index = 0; index < first.length; index += 1) {
      const difference = (first[index] ?? Number.NaN) - (second[index] ?? Number.NaN);
      squaredDistance += difference * difference;
    }
    expect(Math.sqrt(squaredDistance / first.length)).toBeGreaterThan(1);
  });

  it("should agree between heightAt, rendered vertices, and Rapier collider columns", () => {
    const value = field(1337);
    const geometry = value.toGeometry();
    const positions = geometry.getAttribute("position");
    const collider = value.toColliderHeights();
    expect(collider).not.toBe(value.heights);

    let maximumError = 0;
    for (let row = 0; row < value.rows; row += 1) {
      for (let column = 0; column < value.columns; column += 1) {
        const renderIndex = row * value.columns + column;
        const colliderIndex = column * value.rows + row;
        const worldX = positions.getX(renderIndex) + value.origin.x;
        const worldZ = positions.getZ(renderIndex) + value.origin.z;
        maximumError = Math.max(
          maximumError,
          Math.abs(value.heightAt(worldX, worldZ) - positions.getY(renderIndex)),
          Math.abs((collider[colliderIndex] ?? Number.NaN) - positions.getY(renderIndex)),
        );
      }
    }
    geometry.dispose();

    expect(maximumError).toBeLessThanOrEqual(1e-6);
  });

  it("should bulk-write plain float geometry without per-vertex setters", () => {
    const value = field(1337);
    const geometry = value.toGeometry();
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    const originalX = Float32Array.from({ length: position.count }, (_, i) => position.getX(i));
    const originalY = Float32Array.from({ length: position.count }, (_, i) => position.getY(i));
    const originalZ = Float32Array.from({ length: position.count }, (_, i) => position.getZ(i));
    const originalNormal = new Float32Array(position.count * 3);
    for (let lane = 0; lane < position.count * 3; lane += 1)
      originalNormal[lane] = normal.array[lane] as number;

    const setY = vi.spyOn(BufferAttribute.prototype, "setY");
    const setXYZ = vi.spyOn(BufferAttribute.prototype, "setXYZ");

    // Columns span both borders; rows start at the z border and stop short of the far one.
    const region = { column: 0, columns: value.columns, row: 0, rows: 6 };
    value.updateHeights({
      ...region,
      heights: Float32Array.from({ length: region.columns * region.rows }, (_, i) => (i % 7) - 3),
    });
    value.refreshGeometry(geometry, region);

    expect(setY).not.toHaveBeenCalled();
    expect(setXYZ).not.toHaveBeenCalled();

    const heights = value.heights;
    const cellWidth = value.width / (value.columns - 1);
    const cellDepth = value.depth / (value.rows - 1);
    const sample = (row: number, column: number): number =>
      heights[row * value.columns + column] as number;
    const inWindow = (row: number, column: number): boolean =>
      row >= region.row &&
      row < region.row + region.rows &&
      column >= region.column &&
      column < region.column + region.columns;

    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maximumError = 0;
    for (let row = 0; row < value.rows; row += 1) {
      for (let column = 0; column < value.columns; column += 1) {
        const vertex = row * value.columns + column;
        const worldX = position.getX(vertex) + value.origin.x;
        const worldZ = position.getZ(vertex) + value.origin.z;
        const expectedHeight = value.heightAt(worldX, worldZ);
        minY = Math.min(minY, expectedHeight);
        maxY = Math.max(maxY, expectedHeight);
        maximumError = Math.max(maximumError, Math.abs(position.getY(vertex) - expectedHeight));
        // Only the y lane moves; x and z must survive the bulk write untouched.
        expect(position.getX(vertex)).toBe(originalX[vertex]);
        expect(position.getZ(vertex)).toBe(originalZ[vertex]);

        if (!inWindow(row, column)) {
          expect(position.getY(vertex)).toBe(originalY[vertex]);
          for (let lane = 0; lane < 3; lane += 1)
            expect(normal.array[vertex * 3 + lane]).toBe(originalNormal[vertex * 3 + lane]);
          continue;
        }

        // The declared refresh normal is the grid central difference, not `normalAt`'s bilinear one.
        const left = Math.max(0, column - 1);
        const right = Math.min(value.columns - 1, column + 1);
        const near = Math.max(0, row - 1);
        const far = Math.min(value.rows - 1, row + 1);
        const slopeX = (sample(row, right) - sample(row, left)) / ((right - left) * cellWidth);
        const slopeZ = (sample(far, column) - sample(near, column)) / ((far - near) * cellDepth);
        const length = Math.hypot(slopeX, 1, slopeZ);
        maximumError = Math.max(
          maximumError,
          Math.abs(normal.getX(vertex) - -slopeX / length),
          Math.abs(normal.getY(vertex) - 1 / length),
          Math.abs(normal.getZ(vertex) - -slopeZ / length),
        );
      }
    }

    expect(maximumError).toBeLessThanOrEqual(1e-6);

    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    expect(geometry.boundingSphere).not.toBeNull();
    expect(box?.min.y ?? Number.NaN).toBeLessThanOrEqual(minY + 1e-6);
    expect(box?.max.y ?? Number.NaN).toBeGreaterThanOrEqual(maxY - 1e-6);
    geometry.dispose();
  });

  it("should upload only the refreshed rows, and never shrink a pending full refresh", () => {
    const value = field(1337);
    const geometry = value.toGeometry();
    const position = geometry.getAttribute("position") as BufferAttribute;
    const normal = geometry.getAttribute("normal") as BufferAttribute;
    position.clearUpdateRanges();
    normal.clearUpdateRanges();

    // Rows 2..4, columns 3..7 of a 17-column field: one span from (2,3) to the end of (4,7).
    value.refreshGeometry(geometry, { column: 3, columns: 5, row: 2, rows: 3 });
    const window = { count: (4 * 17 + 8 - (2 * 17 + 3)) * 3, start: (2 * 17 + 3) * 3 };
    expect(position.updateRanges).toEqual([window]);
    expect(normal.updateRanges).toEqual([window]);

    // A full refresh in the same frame records the whole buffer, so the upload covers it.
    value.refreshGeometry(geometry);
    expect(position.updateRanges).toContainEqual({ count: position.array.length, start: 0 });
    expect(normal.updateRanges).toContainEqual({ count: normal.array.length, start: 0 });
  });

  it("should keep per-vertex setters for interleaved and normalized geometry", () => {
    const value = field(1337);
    const count = value.rows * value.columns;
    const interleaved = new InterleavedBuffer(new Float32Array(count * 4), 4);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new InterleavedBufferAttribute(interleaved, 3, 0));
    geometry.setAttribute("normal", new BufferAttribute(new Int16Array(count * 3), 3, true));
    const position = geometry.getAttribute("position");
    const normal = geometry.getAttribute("normal");
    const setY = vi.spyOn(position, "setY");
    const setXYZ = vi.spyOn(normal, "setXYZ");

    const region = { column: 2, columns: 3, row: 4, rows: 2 };
    value.refreshGeometry(geometry, region);

    expect(setY).toHaveBeenCalledTimes(region.columns * region.rows);
    expect(setXYZ).toHaveBeenCalledTimes(region.columns * region.rows);
    const vertex = 4 * value.columns + 2;
    // The fallback still writes the canonical sample at that grid vertex.
    expect(position.getY(vertex)).toBe(value.heights[vertex]);
  });

  it("should keep per-vertex setters for a custom attribute that overrides setY", () => {
    const value = field(1337);
    const count = value.rows * value.columns;
    class SurfaceAttribute extends BufferAttribute {
      override setY(index: number, y: number): this {
        return super.setY(index, y);
      }
    }
    const geometry = new BufferGeometry();
    const position = new SurfaceAttribute(new Float32Array(count * 3), 3);
    geometry.setAttribute("position", position);
    const setY = vi.spyOn(SurfaceAttribute.prototype, "setY");

    const region = { column: 2, columns: 3, row: 4, rows: 2 };
    value.refreshGeometry(geometry, region);

    expect(setY).toHaveBeenCalledTimes(region.columns * region.rows);
    const vertex = 4 * value.columns + 2;
    expect(position.getY(vertex)).toBe(value.heights[vertex]);
    geometry.dispose();
  });

  it("should reject a heights buffer whose length is not rows times columns", () => {
    expect(
      () =>
        new Heightfield({
          columns: 4,
          depth: 3,
          heights: new Float32Array(11),
          origin: { x: 0, z: 0 },
          rows: 3,
          width: 4,
        }),
    ).toThrow("expected 12 heights, received 11");
  });

  it("should keep render, query, and collider storage isolated from caller mutation", () => {
    const source = new Float32Array([0, 1, 2, 3, 4, 5]);
    const value = new Heightfield({
      columns: 3,
      depth: 1,
      heights: source,
      origin: { x: 0, z: 0 },
      rows: 2,
      width: 2,
    });
    source[0] = 99;
    value.heights[0] = 98;
    value.toColliderHeights()[0] = 97;

    expect(value.heightAt(-1, -0.5)).toBe(0);
    const geometry = value.toGeometry();
    expect(geometry.getAttribute("position").getY(0)).toBe(0);
    geometry.dispose();
    expect(value.toColliderHeights()[0]).toBe(0);
  });

  it("should fail closed outside its resident region", () => {
    const value = field(1337);
    expect(() => value.heightAt(-0.000_001, value.origin.z)).toThrow(/outside/u);
    expect(() => value.sample("missing", value.origin.x, value.origin.z)).toThrow(
      /unknown channel/u,
    );
  });

  it("should reject GPU generation until a GPU field can be canonical", () => {
    expect(
      () =>
        new Heightfield({
          columns: 3,
          depth: 2,
          heights: new Float32Array([3, 2, 1, 2, 1, 0, 1, 0, -1]),
          origin: { x: 0, z: 0 },
          rows: 3,
          width: 2,
          worldPasses: {
            dispatchBudget: 1,
            erosion: {
              depositionRate: 0.35,
              erosionRate: 0.22,
              evaporation: 0.04,
              iterations: 0,
              rainfall: 0.08,
              sedimentCapacity: 0.7,
              timeStep: 0.05,
            },
            gpu: true,
          },
        }),
    ).toThrow(/GPU generation cannot be canonical/u);
  });

  it("should keep an omitted GPU flag on the canonical CPU path", () => {
    const value = new Heightfield({
      columns: 3,
      depth: 2,
      heights: new Float32Array([3, 2, 1, 2, 1, 0, 1, 0, -1]),
      origin: { x: 0, z: 0 },
      rows: 3,
      width: 2,
      worldPasses: {
        dispatchBudget: 1,
        erosion: {
          depositionRate: 0.35,
          erosionRate: 0.22,
          evaporation: 0.04,
          iterations: 0,
          rainfall: 0.08,
          sedimentCapacity: 0.7,
          timeStep: 0.05,
        },
      },
    });

    expect(value.generationComplete).toBe(true);
    expect(value.debug()).toMatchObject({ complete: true, dispatched: 0 });
  });

  it("should reject synchronous CPU erosion that exceeds its dispatch budget", () => {
    expect(() =>
      Heightfield.fromSampler({
        columns: 3,
        depth: 2,
        origin: { x: 0, z: 0 },
        rows: 3,
        sampleHeight: (x, z) => x - z,
        width: 2,
        worldPasses: {
          dispatchBudget: 1,
          erosion: {
            depositionRate: 0.35,
            erosionRate: 0.22,
            evaporation: 0.04,
            iterations: 2,
            rainfall: 0.08,
            sedimentCapacity: 0.7,
            timeStep: 0.05,
          },
          gpu: false,
        },
      }),
    ).toThrow(/dispatchBudget.*CPU/u);
  });

  it("should construct no appearance under the world subpath", () => {
    const source = readFileSync(path.resolve("packages/core/src/world.ts"), "utf8");
    expect(source).not.toMatch(
      /new\s+\w*Material|new\s+Color|new\s+\w*Light|Texture\(|tonemapping|postprocessing/iu,
    );
  });

  it("should reject invalid dimensions, origins, and channel samples", () => {
    const base = {
      columns: 2,
      depth: 1,
      heights: new Float32Array(4),
      origin: { x: 0, z: 0 },
      rows: 2,
      width: 2,
    };
    expect(() => new Heightfield({ ...base, columns: 1 })).toThrow("columns must be an integer");
    expect(() => new Heightfield({ ...base, width: Number.POSITIVE_INFINITY })).toThrow(
      "width must be finite",
    );
    expect(() => new Heightfield({ ...base, depth: 0 })).toThrow("depth must be greater than zero");
    expect(() => new Heightfield({ ...base, origin: { x: Number.NaN, z: 0 } })).toThrow(
      "origin.x must be finite",
    );
    expect(() => new Heightfield({ ...base, flow: new Float32Array(3) })).toThrow(
      "expected 4 flow samples",
    );
    expect(() => new Heightfield({ ...base, moisture: new Float32Array(3) })).toThrow(
      "expected 4 moisture samples",
    );
    expect(
      () => new Heightfield({ ...base, heights: new Float32Array([0, 0, 0, Number.NaN]) }),
    ).toThrow("height sample must be finite");
    expect(
      () =>
        new Heightfield({ ...base, flow: new Float32Array([0, 0, 0, Number.POSITIVE_INFINITY]) }),
    ).toThrow("flow sample must be finite");
    expect(
      () => new Heightfield({ ...base, moisture: new Float32Array([0, 0, 0, Number.NaN]) }),
    ).toThrow("moisture sample must be finite");
  });

  it("should validate world-pass budgets and tolerate non-iteration counts", () => {
    const base = {
      columns: 2,
      depth: 1,
      heights: new Float32Array(4),
      origin: { x: 0, z: 0 },
      rows: 2,
      width: 2,
    };
    const erosion = {
      depositionRate: 0.35,
      erosionRate: 0.22,
      evaporation: 0.04,
      iterations: 0,
      rainfall: 0.08,
      sedimentCapacity: 0.7,
      timeStep: 0.05,
    };
    expect(() => new Heightfield({ ...base, worldPasses: { dispatchBudget: 0, erosion } })).toThrow(
      "dispatchBudget must be a positive integer",
    );
    expect(
      () =>
        new Heightfield({
          ...base,
          worldPasses: { dispatchBudget: 1, erosion: { ...erosion, iterations: -1 }, gpu: false },
        }),
    ).toThrow("World passes iterations must be a non-negative integer");
    expect(
      () =>
        new Heightfield({
          ...base,
          worldPasses: { dispatchBudget: 1, erosion: { ...erosion, iterations: 1.5 }, gpu: false },
        }),
    ).toThrow("World passes iterations must be a non-negative integer");
    expect(
      () =>
        new Heightfield({
          ...base,
          worldPasses: { dispatchBudget: 1, erosion: { ...erosion, iterations: 2 }, gpu: false },
        }),
    ).toThrow("dispatchBudget cannot cover synchronous CPU erosion iterations");
  });

  it("should interpolate height, slope, flow, and moisture channels", () => {
    const value = new Heightfield({
      columns: 3,
      depth: 1,
      flow: new Float32Array([0, 1, 2, 3, 4, 5]),
      heights: new Float32Array([0, 1, 2, 3, 4, 5]),
      moisture: new Float32Array([5, 4, 3, 2, 1, 0]),
      origin: { x: 0, z: 0 },
      rows: 2,
      width: 2,
    });
    expect(value.sample("height", 0, 0)).toBe(2.5);
    expect(value.sample("slope", 0, 0)).toBeGreaterThan(0);
    expect(value.sample("flow", 0, 0)).toBeCloseTo(2.5, 12);
    expect(value.sample("moisture", 0, 0)).toBeCloseTo(2.5, 12);
    expect(() => value.sample("missing", 0, 0)).toThrow("unknown channel");
    expect(() => value.sample("flow", Number.POSITIVE_INFINITY, 0)).toThrow(
      "query x must be finite",
    );
    expect(() => value.sample("flow", 2, 0)).toThrow("outside its resident region");
  });

  it("should report no GPU sample before one exists and guard its lifecycle", () => {
    const value = new Heightfield({
      columns: 2,
      depth: 1,
      heights: new Float32Array(4),
      origin: { x: 0, z: 0 },
      rows: 2,
      width: 2,
    });
    expect(value.released).toBe(false);
    expect(value.generationComplete).toBe(true);
    expect(value.gpuHeightSample).toBeUndefined();
    expect(value.gpuHeightSample?.staleFrames).toBeUndefined();
    value.attachRenderer({} as never);
    value.process();
    expect(value.gpuHeightSample).toBeUndefined();
    value.detach();
    expect(value.released).toBe(true);
    value.detach();
    expect(() => value.attachRenderer({} as never)).toThrow("cannot be attached after release");
    value.process();
  });
});

describe("Heightfield change trackers", () => {
  const flat = () =>
    Heightfield.fromSampler({
      columns: 9,
      depth: 8,
      origin: { x: 0, z: 0 },
      rows: 9,
      sampleHeight: () => 0,
      width: 8,
    });

  it("hands each tracker the union of the windows written since its own last take", () => {
    const field = flat();
    const first = field.trackChanges();
    const second = field.trackChanges();
    expect(first.take()).toBeUndefined();
    field.updateHeights({
      column: 1,
      columns: 2,
      row: 1,
      rows: 1,
      heights: new Float32Array([1, 1]),
    });
    field.updateHeights({
      column: 5,
      columns: 1,
      row: 6,
      rows: 2,
      heights: new Float32Array([2, 2]),
    });
    expect(first.take()).toEqual({ column: 1, columns: 5, row: 1, rows: 7 });
    expect(first.take()).toBeUndefined();
    // The second tracker never took, so it still holds both writes.
    expect(second.take()).toEqual({ column: 1, columns: 5, row: 1, rows: 7 });
    second.dispose();
    field.updateHeights({ column: 0, columns: 1, row: 0, rows: 1, heights: new Float32Array([3]) });
    expect(second.take()).toBeUndefined();
    expect(first.take()).toEqual({ column: 0, columns: 1, row: 0, rows: 1 });
  });

  it("reads one collider sample without copying the field", () => {
    const field = flat();
    field.updateHeights({
      column: 3,
      columns: 1,
      row: 5,
      rows: 1,
      heights: new Float32Array([0.7]),
    });
    const copy = field.toColliderHeights();
    expect(field.colliderHeight(5, 3)).toBeCloseTo(0.7, 6);
    expect(field.colliderHeight(5, 3)).toBe(copy[3 * field.rows + 5]);
    expect(() => field.colliderHeight(9, 0)).toThrow(/outside/);
  });
});
