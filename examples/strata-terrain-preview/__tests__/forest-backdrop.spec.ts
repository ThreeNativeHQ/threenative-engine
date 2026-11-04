import { readFileSync } from "node:fs";
import { terrainStats } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

// `pnpm test` bakes first, so the forest backdrop in horizon.json is the one the game loads.
// The smooth USGS surroundings that read as rounded blobs measure curvature kurtosis 13.7; the
// generated fluvial backdrop measures about 80 (alpine DEM 89). The floor is set between them.
describe("forest backdrop", () => {
  const { forest } = JSON.parse(
    readFileSync(new URL("../src/world/horizon.json", import.meta.url), "utf8"),
  ) as Record<string, { size: number; resolution: number; heights: number[] }>;
  const stats = terrainStats(forest.heights, forest.resolution, forest.size);

  it("keeps the real place's relief and a sharp, branching surface", () => {
    expect(stats.relief).toBeGreaterThan(800);
    expect(stats.relief).toBeLessThan(950);
    expect(stats.curvatureKurtosis).toBeGreaterThan(40);
  });

  it("meets the surveyed ground at the centre", () => {
    const half = (forest.resolution - 1) / 2;
    expect(forest.heights[half * forest.resolution + half]).toBeCloseTo(13.1, 0);
  });
});
