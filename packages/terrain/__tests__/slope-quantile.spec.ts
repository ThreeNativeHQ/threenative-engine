import { describe, expect, it } from "vitest";

import { slopeAtIndex, slopeQuantile } from "../src/index.js";

describe("slopeQuantile", () => {
  it("reads the given share of interior slopes, matching slopeAtIndex", () => {
    const n = 17;
    const size = 32;
    const height = new Float32Array(n * n);
    for (let z = 0; z < n; z++)
      for (let x = 0; x < n; x++) height[z * n + x] = (x * x) / 8 + z * 0.25;
    const grid = { height, resolution: n, size };
    const interior: number[] = [];
    for (let z = 1; z < n - 1; z++)
      for (let x = 1; x < n - 1; x++) interior.push(slopeAtIndex(grid, z * n + x));
    interior.sort((a, b) => a - b);
    expect(slopeQuantile(grid, 0)).toBe(interior[0]);
    expect(slopeQuantile(grid, 0.5)).toBe(interior[Math.floor(interior.length * 0.5)]);
    expect(slopeQuantile(grid, 1)).toBe(interior[interior.length - 1]);
  });

  it("rejects a quantile outside [0, 1]", () => {
    const grid = { height: new Float32Array(9), resolution: 3, size: 2 };
    expect(() => slopeQuantile(grid, 1.5)).toThrow(/TN_TERRAIN_SLOPE_QUANTILE_INVALID/);
    expect(() => slopeQuantile(grid, Number.NaN)).toThrow(/TN_TERRAIN_SLOPE_QUANTILE_INVALID/);
  });
});
