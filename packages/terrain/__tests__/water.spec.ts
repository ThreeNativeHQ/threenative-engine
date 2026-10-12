import { describe, expect, it } from "vitest";

import { createSegmentIndex } from "../src/index.js";

/** Deterministic xorshift, so a failure reproduces. */
function seeded(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function distance(x: number, z: number, a: readonly number[], b: readonly number[]): number {
  const dx = (b[0] ?? 0) - (a[0] ?? 0);
  const dz = (b[1] ?? 0) - (a[1] ?? 0);
  const t = Math.max(
    0,
    Math.min(1, ((x - (a[0] ?? 0)) * dx + (z - (a[1] ?? 0)) * dz) / (dx * dx + dz * dz || 1)),
  );
  return Math.hypot(x - (a[0] ?? 0) - t * dx, z - (a[1] ?? 0) - t * dz);
}

describe("createSegmentIndex", () => {
  it("returns every segment within reach of a point, like a full scan", () => {
    const random = seeded(541);
    const segments = Array.from({ length: 400 }, (_, id) => {
      const a = [random() * 512 - 256, random() * 512 - 256] as const;
      const station = random() < 0.3;
      const b = station ? a : ([a[0] + random() * 40 - 20, a[1] + random() * 40 - 20] as const);
      return { a, b, reach: random() * 30, data: id };
    });
    for (const cellSize of [5, 13, 32, 100]) {
      const index = createSegmentIndex(segments, cellSize);
      for (let point = 0; point < 3000; point++) {
        const x = random() * 560 - 280;
        const z = random() * 560 - 280;
        const found = new Set(index.nearby(x, z));
        for (const segment of segments)
          if (distance(x, z, segment.a, segment.b) <= segment.reach)
            expect(
              found.has(segment.data),
              `cell ${cellSize}: segment ${segment.data} at (${x}, ${z})`,
            ).toBe(true);
      }
    }
  });

  it("returns nothing where no segment reaches", () => {
    const index = createSegmentIndex([{ a: [0, 0], b: [10, 0], reach: 2, data: "river" }], 8);
    expect(index.nearby(500, 500)).toEqual([]);
  });

  it("rejects an invalid cell size or reach", () => {
    expect(() => createSegmentIndex([], 0)).toThrow(/TN_TERRAIN_WATER_CELL_INVALID/);
    expect(() => createSegmentIndex([], Number.NaN)).toThrow(/TN_TERRAIN_WATER_CELL_INVALID/);
    expect(() => createSegmentIndex([{ a: [0, 0], b: [0, 0], reach: -1, data: 0 }], 8)).toThrow(
      /TN_TERRAIN_WATER_REACH_INVALID/,
    );
  });
});
