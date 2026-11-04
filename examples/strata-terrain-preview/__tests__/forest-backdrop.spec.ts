import { readFileSync } from "node:fs";
import { terrainStats } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { BIOMES, measureBiome } from "../src/render/biomes.js";
import { prefiltered } from "../src/render/horizon.js";

// `pnpm test` bakes first, so the forest backdrop in horizon.json is the one the game loads.
// The smooth USGS surroundings that read as rounded blobs measure curvature kurtosis 13.7; the
// generated fluvial backdrop measures about 80 (alpine DEM 89). The floor is set between them.
describe("forest backdrop", () => {
  const { forest } = JSON.parse(
    readFileSync(new URL("../src/world/horizon.json", import.meta.url), "utf8"),
  ) as { forest: { size: number; resolution: number; heights: number[] } };
  const stats = terrainStats(forest.heights, forest.resolution, forest.size);

  it("keeps the real place's relief and a sharp, branching surface", () => {
    expect(stats.relief).toBeGreaterThan(800);
    // Owner goal 2026-11-04 (rocky alpine peaks): ridged crests add ~100 m, so 950 became 1050.
    expect(stats.relief).toBeLessThan(1050);
    expect(stats.curvatureKurtosis).toBeGreaterThan(40);
  });

  it("breaks the massif into peaks with cliff faces, not one 30 degree wall", () => {
    // The fluvial pass alone left one smooth wall: 6% of the collar steeper than 40 degrees and a
    // 34 degree 90th percentile, cut by straight radial channels that read as vertical streaks.
    const n = forest.resolution;
    const cell = forest.size / (n - 1);
    let collar = 0;
    let cliffs = 0;
    for (let row = 1; row < n - 1; row++)
      for (let column = 1; column < n - 1; column++) {
        const reach = Math.max(Math.abs(column / (n - 1) - 0.5), Math.abs(row / (n - 1) - 0.5));
        if (reach * forest.size <= 256 || reach * forest.size > 2356) continue;
        const at = (r: number, c: number) => forest.heights[r * n + c] as number;
        const dx = (at(row, column + 1) - at(row, column - 1)) / (2 * cell);
        const dz = (at(row + 1, column) - at(row - 1, column)) / (2 * cell);
        collar++;
        if (Math.atan(Math.hypot(dx, dz)) > (40 * Math.PI) / 180) cliffs++;
      }
    expect(cliffs / collar).toBeGreaterThan(0.15);
    expect(stats.slopeP90).toBeGreaterThan(42);
  });

  it("keeps snow to the peaks instead of every saddle", () => {
    // The cap band is a fraction of the 41 m walkable range; at 227 m it lay under a third of the
    // generated ridges and read as a white band across the valley from the spawn.
    const baked = JSON.parse(
      readFileSync(new URL("../src/world/baked.json", import.meta.url), "utf8"),
    ) as { forest: { heights: number[] } };
    const [snowline] = measureBiome(BIOMES.forest, baked.forest.heights).heightBands.cap;
    const n = forest.resolution;
    let collar = 0;
    let snowy = 0;
    for (let row = 0; row < n; row++)
      for (let column = 0; column < n; column++) {
        const reach = Math.max(Math.abs(column / (n - 1) - 0.5), Math.abs(row / (n - 1) - 0.5));
        const metres = reach * forest.size;
        if (metres <= 256 || metres > 2356) continue;
        collar++;
        if ((forest.heights[row * n + column] as number) > snowline) snowy++;
      }
    expect(snowy / collar).toBeLessThan(0.15);
  });

  it("meets the surveyed ground at the centre", () => {
    const half = (forest.resolution - 1) / 2;
    expect(forest.heights[half * forest.resolution + half]).toBeCloseTo(13.1, 0);
  });

  it("hazes the ridges instead of swapping them for cloudless sky", () => {
    // The haze composite replaces a surface with sky by `horizonFade`; at [400, 1500] the median
    // 700 m+ ridge kept 0% and showed only as a hole when a cloud passed behind it.
    const [start, end] = BIOMES.forest.atmosphere.horizonFade;
    const n = forest.resolution;
    const ridges: number[] = [];
    for (let row = 0; row < n; row++)
      for (let column = 0; column < n; column++) {
        const x = (column / (n - 1) - 0.5) * forest.size;
        const z = (row / (n - 1) - 0.5) * forest.size;
        const inCollar = Math.max(Math.abs(x), Math.abs(z)) <= 2356;
        if (inCollar && (forest.heights[row * n + column] as number) > 700)
          ridges.push(Math.hypot(x, z));
      }
    ridges.sort((a, b) => a - b);
    const median = ridges[ridges.length >> 1] as number;
    const t = Math.min(1, Math.max(0, (median - start) / (end - start)));
    expect(1 - t * t * (3 - 2 * t)).toBeGreaterThan(0.5);
  });

  it("prefilters the far collar so a wall cannot alias into skyline stairs", () => {
    const n = forest.resolution;
    const source = Float32Array.from(forest.heights);
    const smooth = prefiltered(source, n);
    const maxStep = (v: Float32Array) => {
      let max = 0;
      for (let row = 0; row < n; row++)
        for (let column = 0; column < n - 1; column++)
          max = Math.max(
            max,
            Math.abs((v[row * n + column + 1] as number) - (v[row * n + column] as number)),
          );
      return max;
    };
    const mean = (v: Float32Array) => v.reduce((sum, h) => sum + h, 0) / v.length;
    expect(maxStep(smooth)).toBeLessThan(maxStep(source) * 0.6);
    expect(Math.abs(mean(smooth) - mean(source))).toBeLessThan(0.5);
  });
});
