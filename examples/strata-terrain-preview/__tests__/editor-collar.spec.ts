import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  type HorizonSurroundings,
  createHorizonCollar,
  setHorizonSurroundings,
} from "../src/render/ground/horizon.js";
import { type IBakedWorld, createTerrain } from "../src/render/ground/terrain.js";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/world/${name}`, import.meta.url), "utf8"));

// The editor calls `createTerrain(data)` with no biome and an authored ocean as `waterLevel`.
it("builds the coastal collar for a biome-less world that has an ocean, the forest one without", () => {
  setHorizonSurroundings(read("horizon.json") as HorizonSurroundings);
  const forest = (read("baked.json") as { forest: IBakedWorld }).forest;
  // The collar has hundreds of thousands of vertices: a strided sample tells the two surveys apart.
  const sample = (collar: ReturnType<typeof createHorizonCollar>) =>
    Array.from(collar.geometry.getAttribute("position").array).filter((_, i) => i % 1009 === 0);
  const ocean = { ...forest, waterLevel: 0 };
  expect(sample(createTerrain(ocean).collar)).toEqual(
    sample(createHorizonCollar(ocean, "coastal")),
  );
  const dry = { ...forest, waterLevel: null };
  expect(sample(createTerrain(dry).collar)).toEqual(sample(createHorizonCollar(dry, "forest")));
  expect(sample(createHorizonCollar(ocean, "coastal"))).not.toEqual(
    sample(createHorizonCollar(ocean, "forest")),
  );
}, 30_000);
