import { readFileSync } from "node:fs";
import { Heightfield, WATER_RIBBON_REACH } from "@threenative/core/world";
import { propAssetOf } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { propCounts } from "../src/render/props/propWorld.js";
import { waterSurfaceAt } from "../src/world/water.js";
import { readBakedPropPackage } from "./bakedPropPackage.js";

// `STRATA_WORLD_DIR` points the check at another baked set (the red arm of a red-green run).
const file = (name: string) =>
  readFileSync(
    process.env.STRATA_WORLD_DIR
      ? `${process.env.STRATA_WORLD_DIR}/${name}`
      : new URL(`../src/world/${name}`, import.meta.url),
  );
const forest = JSON.parse(file("baked.json").toString()).forest;
const field = new Heightfield({
  rows: forest.resolution,
  columns: forest.resolution,
  width: forest.size,
  depth: forest.size,
  origin: { x: 0, z: 0 },
  heights: Float32Array.from(forest.heights),
});
// The water the player sees and swims in: the same splines, levels and reach `createRivers` draws.
const surface = waterSurfaceAt(forest.rivers, forest.lakes, field);
const flooded = (x: number, z: number) => {
  const level = surface(x, z);
  return level !== undefined && field.heightAt(x, z) < level;
};
/** The rivers the game draws, with the water's reach either side of their centreline. */
const REACHES: { points: readonly (readonly number[])[]; reach: number }[] = forest.rivers.map(
  (river: { points: readonly (readonly number[])[]; width: number }) => ({
    points: river.points,
    reach: river.width * WATER_RIBBON_REACH,
  }),
);
/** Whether a river's drawn water reaches (x, z): a rock past every ribbon is not on a bank. */
const onRiverBank = (x: number, z: number): boolean =>
  REACHES.some(({ points, reach }) =>
    points.some((b, index) => {
      const a = points[index - 1];
      if (!a) return false;
      const [ax = 0, , az = 0] = a;
      const [bx = 0, , bz = 0] = b;
      const dx = bx - ax;
      const dz = bz - az;
      const t = Math.max(
        0,
        Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz || 1)),
      );
      return Math.hypot(x - ax - t * dx, z - az - t * dz) <= reach;
    }),
  );
const GROWING = new Set(["spruce", "sapling", "bush", "fern", "grass", "scrub", "poppy", "litter"]);
const TRUNKS = new Set(["spruce", "sapling"]);
const AROUND = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

/** Every placement the forest's prop package holds, with the record order the bake wrote. */
async function placementsOfForest() {
  const pkg = await readBakedPropPackage(
    process.env.STRATA_WORLD_DIR
      ? `${process.env.STRATA_WORLD_DIR}/`
      : new URL("../src/world/", import.meta.url),
    "forest",
  );
  const placements = pkg.buckets.flatMap((bucket) => {
    const floats = new Float32Array(
      bucket.placements.buffer,
      bucket.placements.byteOffset,
      bucket.placements.byteLength / 4,
    );
    const assets: string[] = [];
    for (const cell of bucket.cells)
      for (const run of cell.runs)
        for (let index = 0; index < run.count; index++)
          assets[run.offset + index] = propAssetOf(run.asset);
    return bucket.ids.map((id, index) => ({
      id,
      asset: assets[index] as string,
      position: [
        floats[index * 8] as number,
        floats[index * 8 + 1] as number,
        floats[index * 8 + 2] as number,
      ] as const,
    }));
  });
  return { counts: propCounts(pkg), placements };
}

describe("forest river clearance", () => {
  it("grows nothing in the river or the lake, and keeps every trunk a metre off the water", async () => {
    const { placements } = await placementsOfForest();
    const drowned = placements.filter(
      ({ asset, position: [x, , z] }) =>
        GROWING.has(asset) &&
        AROUND.slice(0, TRUNKS.has(asset) ? 5 : 1).some(([dx, dz]) => flooded(x + dx, z + dz)),
    );
    expect(placements.length).toBeGreaterThan(10_000);
    expect(drowned.map(({ id }) => id)).toEqual([]);
  });
  it("lays cobbles on the river bed, under the water, and river rocks along its banks", async () => {
    const { counts, placements } = await placementsOfForest();
    const cobbles = placements.filter(({ asset }) => asset === "pebble");
    expect(cobbles.length).toBeGreaterThan(800);
    expect(cobbles.filter(({ position: [x, , z] }) => !flooded(x, z)).map(({ id }) => id)).toEqual(
      [],
    );
    expect(counts.riverrock).toBeGreaterThan(250);
    expect(
      placements
        .filter(({ asset, position: [x, , z] }) => asset === "riverrock" && !onRiverBank(x, z))
        .map(({ id }) => id),
    ).toEqual([]);
  });
});
