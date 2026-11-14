/**
 * The forest cover-density rules, locked on the biome file's own bake.
 *
 * The ground and the rows are loaded the way `bake-golden.spec.ts` loads them, and the
 * `IOrderedScatterField` is built the way `orderedField` builds it, so these are the ordered
 * stream's own placements. Each test pins one rule the forest's cover promises: the water
 * exclusion, the slope gate every grass cell passes, and the stand field the ferns follow.
 */
import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { beforeAll, describe, expect, it } from "vitest";
import { validateBiome } from "../src/biome/biome.js";
import { decodeRAW16 } from "../src/core/io.js";
import { Terrain } from "../src/core/terrain.js";
import type { IPlacement, ITerrainState } from "../src/core/types.js";
import { STAND_FIELD, fieldWeight } from "../src/population/cover-field.js";
import {
  type IOrderedScatterField,
  orderedScatterRules,
  scatterProps,
  slopeDegrees,
} from "../src/population/scatter-ordered.js";

interface IRaw16 {
  readonly height: number;
  readonly max: number;
  readonly min: number;
  readonly raw16: string;
  readonly width: number;
  values?: number[];
}

const dir = new URL("../starter/forest/", import.meta.url);
const { recipe } = JSON.parse(readFileSync(new URL("recipe.json", dir), "utf8")) as {
  recipe: {
    layers: { id: string; params?: { at?: number[]; data?: IRaw16 }; type: string }[];
  };
};
for (const layer of recipe.layers) {
  const data = layer.params?.data;
  if (data === undefined) continue;
  const raw = readFileSync(new URL(data.raw16, dir));
  data.values = Array.from(decodeRAW16(raw, data).values, (value) => Math.round(value * 10) / 10);
}
const spec = validateBiome(
  JSON.parse(readFileSync(new URL("biome.data.json", dir), "utf8")),
  "forest",
);

/** Stones the `put` guard admits into the water by design. */
const STONES = new Set(["riverrock", "pebble"]);
const GRID = 64;

let state: ITerrainState;
let field: IOrderedScatterField;
let placements: IPlacement[];

beforeAll(() => {
  state = Terrain.fromJSON(recipe as never).evaluate();
  field = {
    erosion: state.erosion,
    field: new Heightfield({
      rows: state.resolution,
      columns: state.resolution,
      width: state.size,
      depth: state.size,
      origin: { x: 0, z: 0 },
      heights: Float32Array.from(state.height),
    }),
    resolution: state.resolution,
    size: state.size,
    waterLevel: state.waters.find((water) => water.kind === "ocean")?.level ?? null,
    rules: orderedScatterRules(spec),
    spec,
    rivers: state.rivers,
    lakes: state.waters.flatMap((water) =>
      water.kind === "lake" && water.at !== undefined && water.radius !== undefined
        ? [{ at: water.at, radius: water.radius, level: water.level ?? 0 }]
        : [],
    ),
  };
  placements = scatterProps(
    field,
    { x: spec.spawn.focus[0], z: spec.spawn.focus[1] },
    spec.cover.clearings,
  ).placements;
});

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const heightAt = (x: number, z: number): number => field.field.heightAt(x, z);

/** The same water test the generators run: the ocean level and every lake's drowned band. */
const wet = (x: number, z: number): boolean =>
  (field.waterLevel !== null && heightAt(x, z) < field.waterLevel + 0.35) ||
  (field.lakes ?? []).some(
    (lake) =>
      Math.hypot(x - (lake.at[0] ?? 0), z - (lake.at[1] ?? 0)) < lake.radius &&
      heightAt(x, z) < lake.level + 0.35,
  );

describe("the forest cover-density rules", () => {
  it("keeps every accepted placement except the stones above the water level", () => {
    // The forest carries a lake and no ocean, so `waterLevel` is null: the water the guard actually
    // tests is the lake's drowned band, and the placement rule keeps every non-stone out of it.
    const stonesInWater = placements.filter(
      (placement) =>
        STONES.has(placement.asset) && wet(placement.position[0], placement.position[2]),
    );
    const drowned = placements.filter(
      (placement) =>
        !STONES.has(placement.asset) && wet(placement.position[0], placement.position[2]),
    );
    expect(drowned).toEqual([]);
    // The guard is not vacuous: at least one stone does stand in the drowned band.
    expect(stonesInWater.length).toBeGreaterThan(0);
  });

  it("keeps every grass placement inside the 34-degree cover gate", () => {
    // `coverAt` refuses a candidate above 34 degrees before the meadow's slope falloff runs, so the
    // file's `grassSlopeLimit + grassSlopeFalloff` (42 + 20) is looser than the gate that decides.
    const grass = placements.filter((placement) => placement.asset === "grass");
    const steep = grass.filter(
      (placement) => slopeDegrees(field, placement.position[0], placement.position[2]) > 34,
    );
    expect(grass.length).toBeGreaterThan(0);
    expect(steep).toEqual([]);
  });

  it("puts the ferns on the stand field, not on the average ground", () => {
    // Ferns are drawn under closed crowns and in damp hollows of a stand, so their mean stand-field
    // weight must beat a fixed 64 x 64 sample of the whole world, not just tie with it.
    const ferns = placements.filter((placement) => placement.asset === "fern");
    const half = field.size / 2;
    const step = field.size / GRID;
    const grid: number[] = [];
    for (let row = 0; row < GRID; row++)
      for (let column = 0; column < GRID; column++)
        grid.push(
          fieldWeight(STAND_FIELD, -half + (column + 0.5) * step, -half + (row + 0.5) * step),
        );
    const fernsWeight = mean(
      ferns.map((placement) =>
        fieldWeight(STAND_FIELD, placement.position[0], placement.position[2]),
      ),
    );
    const groundWeight = mean(grid);
    expect(ferns.length).toBeGreaterThan(0);
    expect(fernsWeight).toBeGreaterThan(groundWeight);
  });
});
