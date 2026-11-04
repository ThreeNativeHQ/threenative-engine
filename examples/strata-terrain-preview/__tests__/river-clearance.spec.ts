import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { decodePlacements } from "../src/render/placements.js";
import { waterSurfaceAt } from "../src/world/water.js";

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
const GROWING = new Set(["spruce", "sapling", "bush", "fern", "grass", "scrub", "poppy", "litter"]);
const TRUNKS = new Set(["spruce", "sapling"]);
const AROUND = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

describe("forest river clearance", () => {
  it("grows nothing in the river or the lake, and keeps every trunk a metre off the water", () => {
    const bytes = file("forest.placements.bin");
    const { placements } = decodePlacements(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const drowned = placements.filter(
      ({ asset, position: [x, , z] }) =>
        GROWING.has(asset) &&
        AROUND.slice(0, TRUNKS.has(asset) ? 5 : 1).some(([dx, dz]) => flooded(x + dx, z + dz)),
    );
    expect(placements.length).toBeGreaterThan(10_000);
    expect(drowned.map(({ id }) => id)).toEqual([]);
  });
  it("lays cobbles on the river bed, under the water, and river rocks along its banks", () => {
    const bytes = file("forest.placements.bin");
    const { counts, placements } = decodePlacements(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    const cobbles = placements.filter(({ asset }) => asset === "pebble");
    expect(cobbles.length).toBeGreaterThan(800);
    expect(cobbles.filter(({ position: [x, , z] }) => !flooded(x, z)).map(({ id }) => id)).toEqual(
      [],
    );
    expect(counts.riverrock).toBeGreaterThan(250);
  });
});
