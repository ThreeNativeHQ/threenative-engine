import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { terrainStats } from "@threenative/terrain";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { BENCHMARK } from "../src/render/benchmark.js";
import { BIOMES, measureBiome } from "../src/render/biomes.js";
import { cubicAt, setHorizonSurroundings } from "../src/render/ground/horizon.js";

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
    // Owner goal 2026-11-04 (rocky alpine peaks, then a near massif in the vista): 950 became 1200.
    expect(stats.relief).toBeLessThan(1200);
    expect(stats.curvatureKurtosis).toBeGreaterThan(40);
  });

  it("stands the vista's near massif in the upper left of its frame", () => {
    // Owner goal 2026-11-04 ("make sure we have the proper mountain on this capture"): the goal
    // frame's summit is ~2% below its top edge and its massif fills the left ~45% of the width.
    // The generated backdrop had a valley on that bearing, its skyline 27-42% down the frame.
    const vista = BENCHMARK.forest.poses.vista;
    if (!vista) throw new Error("The forest has no vista pose");
    const { at, eyeY = 0, look, lookY = 0 } = vista;
    const n = forest.resolution;
    const cell = forest.size / (n - 1);
    const sample = (row: number, column: number) => forest.heights[row * n + column] as number;
    const height = (x: number, z: number) => {
      const u = Math.min(Math.max((x + forest.size / 2) / cell, 0), n - 1.001);
      const v = Math.min(Math.max((z + forest.size / 2) / cell, 0), n - 1.001);
      const [i, j] = [Math.floor(u), Math.floor(v)];
      const [a, b] = [u - i, v - j];
      return (
        (sample(j, i) * (1 - a) + sample(j, i + 1) * a) * (1 - b) +
        (sample(j + 1, i) * (1 - a) + sample(j + 1, i + 1) * a) * b
      );
    };
    // The game's camera: 60 degree vertical field, the playtest's 1280 x 720 viewport.
    const forward = new Vector3(look[0] - at[0], lookY - eyeY, look[1] - at[1]).normalize();
    const right = forward
      .clone()
      .cross(new Vector3(0, 1, 0))
      .normalize();
    const up = right.clone().cross(forward);
    const t = Math.tan(Math.PI / 6);
    const skyline: number[] = [];
    for (let column = 0; column <= 576; column += 16) {
      const ray = forward
        .clone()
        .addScaledVector(right, ((2 * (column + 0.5)) / 1280 - 1) * t * (16 / 9))
        .setY(0)
        .normalize();
      let top = Number.NEGATIVE_INFINITY;
      for (let d = 30; d < 4500; d += 5) {
        const [x, z] = [at[0] + ray.x * d, at[1] + ray.z * d];
        if (Math.max(Math.abs(x), Math.abs(z)) > 2356) break;
        const toGround = new Vector3(x - at[0], height(x, z) - eyeY, z - at[1]);
        top = Math.max(top, toGround.dot(up) / toGround.dot(forward));
      }
      skyline.push((1 - top / t) / 2);
    }
    expect(Math.min(...skyline)).toBeLessThan(0.1);
    expect(skyline.reduce((sum, row) => sum + row, 0) / skyline.length).toBeLessThan(0.15);
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

  it("leaves the massif's lower slopes gentle enough for forest", () => {
    // PRD-866: stamped cones were one 35 to 50 degree wall from foot to summit, so trees stood only on
    // the valley floor. A real mountain's lower slopes are walkable wood under its rock.
    const { massif } = JSON.parse(
      readFileSync(new URL("../src/world/horizon.json", import.meta.url), "utf8"),
    ).forest as {
      massif: { spacing: number; columns: number; rows: number; offset: number; heights: string };
    };
    const raw = Buffer.from(massif.heights, "base64");
    const heights = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength / 2);
    const at = (row: number, column: number) =>
      massif.offset + (heights[row * massif.columns + column] as number) / 10;
    const baked = JSON.parse(
      readFileSync(new URL("../src/world/baked.json", import.meta.url), "utf8"),
    ) as { forest: { heights: number[] } };
    const [treeline] = measureBiome(BIOMES.forest, baked.forest.heights).heightBands.treeline;
    const floor = massif.offset;
    let lower = 0;
    let gentle = 0;
    for (let row = 1; row < massif.rows - 1; row++)
      for (let column = 1; column < massif.columns - 1; column++) {
        const height = at(row, column);
        if (height < floor + 50 || height > treeline) continue;
        const dx = (at(row, column + 1) - at(row, column - 1)) / (2 * massif.spacing);
        const dz = (at(row + 1, column) - at(row - 1, column)) / (2 * massif.spacing);
        lower++;
        if (Math.atan(Math.hypot(dx, dz)) < (40 * Math.PI) / 180) gentle++;
      }
    expect(lower).toBeGreaterThan(1000);
    expect(gentle / lower).toBeGreaterThanOrEqual(0.6);
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

  it("samples the far collar on a C1 curve that keeps every surveyed ridge", () => {
    setHorizonSurroundings({ forest });
    const n = forest.resolution;
    const cell = forest.size / (n - 1);
    const sample = (row: number, column: number) => forest.heights[row * n + column] as number;
    // Interpolating: every survey sample is reproduced, so no summit or gully is blurred away.
    // The box-filtered copy it replaces moved the forest's 1 km peaks by tens of metres.
    let worst = 0;
    for (let row = 4; row < n - 4; row += 7)
      for (let column = 4; column < n - 4; column += 7) {
        const x = (column / (n - 1) - 0.5) * forest.size;
        const z = (row / (n - 1) - 0.5) * forest.size;
        worst = Math.max(worst, Math.abs(cubicAt("forest", x, z) - sample(row, column)));
      }
    expect(worst).toBeLessThan(1e-3);
    // C1 across cell edges: a diagonal wall has no slope jump at each sample line, which is
    // what bilinear heights draw as skyline stairs.
    const kink = (height: (x: number, z: number) => number) => {
      let worstKink = 0;
      const e = cell * 1e-3;
      for (let k = 40; k < n - 40; k += 3) {
        // A point on a sample line, walked along the diagonal.
        const x = (k / (n - 1) - 0.5) * forest.size;
        const z = ((k + 0.37) / (n - 1) - 0.5) * forest.size;
        const centre = height(x, z);
        const left = (centre - height(x - e, z - e)) / e;
        const right = (height(x + e, z + e) - centre) / e;
        worstKink = Math.max(worstKink, Math.abs(right - left));
      }
      return worstKink;
    };
    const bilinear = new Heightfield({
      rows: n,
      columns: n,
      width: forest.size,
      depth: forest.size,
      origin: { x: 0, z: 0 },
      heights: Float32Array.from(forest.heights),
    });
    // The control: bilinear heights kink at every sample line; the curve does not.
    expect(kink((x, z) => bilinear.heightAt(x, z))).toBeGreaterThan(0.05);
    expect(kink((x, z) => cubicAt("forest", x, z))).toBeLessThan(0.01);
  });
});
