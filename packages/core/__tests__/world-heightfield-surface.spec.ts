import { Mesh, Raycaster, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { Heightfield } from "../src/world.js";

/**
 * `surfaceAt` answers the plane of the triangle `toGeometry` emits, so the reference is a stock
 * `Raycaster` on that same geometry — never a second copy of the formula. A seeded sweep of the
 * whole field is the pin: the bilinear `heightAt` is compared alongside it, so a case where the two
 * agree cannot make a wrong `surfaceAt` look right.
 */
function field(rows: number, columns: number, size: number): Heightfield {
  const heights = new Float32Array(rows * columns);
  let seed = 12345;
  for (let index = 0; index < heights.length; index += 1) {
    // A deterministic lattice with saddles in it: two incommensurate sines plus a coarse step.
    seed = (seed * 1_103_515_245 + 12_345) >>> 0;
    const noise = (seed / 0xffffffff - 0.5) * 2;
    heights[index] = Math.sin(index * 0.7) * 6 + Math.cos(index * 0.31) * 3 + noise * 0.5;
  }
  return new Heightfield({
    rows,
    columns,
    width: size,
    depth: size,
    origin: { x: 0, z: 0 },
    heights,
  });
}

function reference(grid: Heightfield) {
  const mesh = new Mesh(grid.toGeometry());
  mesh.updateMatrixWorld(true);
  return (x: number, z: number): number | null => {
    const hit = new Raycaster(new Vector3(x, 10_000, z), new Vector3(0, -1, 0)).intersectObject(
      mesh,
      false,
    )[0];
    return hit?.point.y ?? null;
  };
}

describe("Heightfield.surfaceAt", () => {
  it("matches the drawn triangle at 10 000 seeded points, and differs from the bilinear height", () => {
    const grid = field(33, 33, 256);
    const ray = reference(grid);
    const half = 128;
    let seed = 7;
    let compared = 0;
    let disagreed = 0;
    for (let sample = 0; sample < 10_000; sample += 1) {
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      const x = ((seed / 0xffffffff) * 2 - 1) * (half - 1e-3);
      seed = (seed * 1_103_515_245 + 12_345) >>> 0;
      const z = ((seed / 0xffffffff) * 2 - 1) * (half - 1e-3);
      const expected = ray(x, z);
      if (expected === null) continue;
      const surface = grid.surfaceAt(x, z);
      expect(surface, `surfaceAt(${x}, ${z})`).toBeCloseTo(expected, 4);
      compared += 1;
      if (Math.abs(surface - grid.heightAt(x, z)) > 1e-3) disagreed += 1;
    }
    expect(compared).toBe(10_000);
    // The pin bites only if the two heights are actually different answers somewhere.
    expect(disagreed).toBeGreaterThan(1_000);
  });

  it("lands exactly on each of the four cell corners and the shared diagonal", () => {
    const grid = field(5, 5, 64);
    const half = 32;
    const cell = 16;
    for (let row = 0; row < 4; row += 1)
      for (let column = 0; column < 4; column += 1) {
        const x = -half + column * cell;
        const z = -half + row * cell;
        // A corner is a vertex, so both the surface and the bilinear query read its sample.
        expect(grid.surfaceAt(x, z)).toBeCloseTo(grid.heightAt(x, z), 6);
      }
    // The diagonal is the shared edge: both halves of the split answer the same height on it.
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const x = -half + fraction * cell;
      const z = -half + (1 - fraction) * cell;
      const expected = reference(grid)(x, z) as number;
      expect(grid.surfaceAt(x, z)).toBeCloseTo(expected, 4);
    }
  });

  it("answers on the field's own boundary and fails closed outside it", () => {
    const grid = field(9, 9, 64);
    expect(Number.isFinite(grid.surfaceAt(32, -32))).toBe(true);
    expect(Number.isFinite(grid.surfaceAt(-32, 32))).toBe(true);
    expect(() => grid.surfaceAt(32.5, 0)).toThrow(
      "Heightfield query (32.5, 0) is outside its resident region.",
    );
    expect(() => grid.surfaceAt(0, Number.NaN)).toThrow("Heightfield query z must be finite.");
  });
});
