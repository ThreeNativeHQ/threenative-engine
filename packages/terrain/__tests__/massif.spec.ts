import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type IMassifTile, Terrain, placeMassif, terrainStats } from "../src/index.js";

// PRD-866: a surveyed whole mountain (Maroon Bells, 3DEP 1 m lidar, every 4th 4 m vertex) placed
// behind a world by seed. A flat host isolates the mountain, so its own relief, curvature and
// lower-slope gradient are what the gates read.
const fixture = new URL("./fixtures/massif/", import.meta.url);
const meta = JSON.parse(readFileSync(new URL("maroon-16m.json", fixture), "utf8")) as {
  size: number;
  resolution: number;
  elevationOffset: number;
  sha256: string;
};
const bytes = readFileSync(new URL("maroon-16m.bin", fixture));
const tile: IMassifTile = {
  id: "maroon",
  size: meta.size,
  resolution: meta.resolution,
  heights: Float32Array.from(
    new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2),
    (dm) => meta.elevationOffset + dm / 10,
  ),
};
// `heightmap` adds a layer to the terrain it is called on: every placement needs its own host.
const place = (seed: number) =>
  placeMassif(
    new Terrain({ size: 8000, resolution: 257 }).heightmap({
      id: "flat",
      data: { width: 2, height: 2, values: [0, 0, 0, 0] },
    }),
    { seed, tile, keepOut: 420 },
  );
const hash = ({ terrain, placement }: ReturnType<typeof place>) =>
  createHash("sha256")
    .update(new Float32Array(terrain.evaluate().height))
    .update(placement.detail.heights)
    .digest("hex");

describe("placeMassif", () => {
  it("reads the checked-in fixture", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
  });

  it("places the same mountain for the same seed and another for the next", () => {
    expect(hash(place(3))).toBe(hash(place(3)));
    expect(hash(place(3))).not.toBe(hash(place(4)));
  });

  it.each([0, 1, 2, 3, 4, 5, 6, 7])(
    "seed %i keeps the real relief, sharp surface and wooded foot",
    (seed) => {
      const { terrain, placement } = place(seed);
      const state = terrain.evaluate();
      const stats = terrainStats(state.height, state.resolution, state.size);
      // Maroon stands 696 m above its perimeter; the default height draws 0.85 to 1.15 of that.
      expect(stats.relief).toBeGreaterThan(550);
      expect(stats.relief).toBeLessThan(1200);
      expect(stats.curvatureKurtosis).toBeGreaterThan(40);
      // The lower half of the mountain, above its foot: 60% or more under 40 degrees.
      const { spacing, columns, rows, heights } = placement.detail;
      const at = (row: number, column: number) => heights[row * columns + column] as number;
      let floor = Number.POSITIVE_INFINITY;
      for (const height of heights) floor = Math.min(floor, height);
      let lower = 0;
      let gentle = 0;
      for (let row = 1; row < rows - 1; row++)
        for (let column = 1; column < columns - 1; column++) {
          const height = at(row, column);
          if (height < floor + 50 || height > floor + placement.height / 2) continue;
          const dx = (at(row, column + 1) - at(row, column - 1)) / (2 * spacing);
          const dz = (at(row + 1, column) - at(row - 1, column)) / (2 * spacing);
          lower++;
          if (Math.atan(Math.hypot(dx, dz)) < (40 * Math.PI) / 180) gentle++;
        }
      expect(lower).toBeGreaterThan(5000);
      expect(gentle / lower).toBeGreaterThanOrEqual(0.6);
    },
  );
});
