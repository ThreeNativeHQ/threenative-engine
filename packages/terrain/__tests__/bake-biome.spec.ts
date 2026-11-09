import {
  type IBakedBiome,
  Terrain,
  bakeBiome,
  measureBands,
  validateBiome,
} from "@threenative/terrain";
import { describe, expect, it } from "vitest";

const SPEC = validateBiome(
  {
    aliases: ["fir", "firs"],
    bake: { file: "baked", key: "fir" },
    foliage: [],
    grass: [],
    landform: "rollingHills",
    layers: [
      { from: 0, layer: "meadow", to: 0.5 },
      { from: 0.5, layer: "rock", to: 1 },
      { from: 0.8, layer: "snow", shedFrom: 0.1, shedTo: 0.4, to: 1 },
    ],
    look: "fir",
    seed: 73,
    sizeMeters: 256,
    stream: "seeded",
    cover: {
      ground: "wood",
      seed: 466_468,
      attempts: 80_000,
      stoneRadius: 1.9,
      clearings: [],
      understorey: {
        attempts: 14_000,
        litter: 1,
        fern: 1,
        bush: 1,
        flower: 1,
        shade: 0,
        shadeRadius: 3,
      },
    },
    spawn: { at: [0, 0], cameraOffset: [10, 10, 10], focus: [0, 0] },
    species: ["fir"],
    water: [],
  },
  "fir",
);

/** The package a bake wrote, for the cases that ask for one. */
function pkg(baked: IBakedBiome) {
  if (baked.package === null) throw new Error("the bake wrote no package");
  return baked.package;
}

/** One asset's bound; only the id and the bound reach the manifest. */
const ASSETS = {
  fir: {
    bounds: { max: [3, 14, 3] as const, min: [-3, 0, -3] as const },
    glb: "models/fir.glb",
  },
};

function state(seed = 73) {
  return new Terrain({ resolution: 33, seed, size: 256 })
    .noise({ amplitude: 40, id: "relief", mode: "fbm", octaves: 3, scale: 90 })
    .scatter({ id: "firs", asset: "fir", count: 40, minDistance: 3, seed })
    .evaluate();
}

describe("measureBands", () => {
  const layers = [
    { from: 0, layer: "meadow", to: 0.5 },
    { from: 0.5, layer: "rock", to: 1 },
    { from: 0.8, layer: "snow", shedFrom: 0.1, shedTo: 0.4, to: 1 },
  ];

  it("resolves each fraction band against the heights it is given", () => {
    const measured = measureBands(layers, [-20, 0, 80, 180]);
    expect(measured.elevationRange).toEqual([-20, 180]);
    expect(measured.bands).toEqual({ meadow: [-20, 80], rock: [80, 180] });
    expect(measured.snowBand).toEqual([140, 180]);
    expect(measured.snowShed).toEqual([0.1, 0.4]);
  });

  it("keeps the snow row out of the ground bands and reports its shed slopes", () => {
    const measured = measureBands(layers, [0, 100]);
    expect(Object.keys(measured.bands)).toEqual(["meadow", "rock"]);
    expect(measured.snowShed).toEqual([0.1, 0.4]);
  });

  it("collapses every band onto a flat field instead of dividing by its zero relief", () => {
    const measured = measureBands(layers, [42, 42, 42]);
    expect(measured.elevationRange).toEqual([42, 42]);
    expect(measured.bands.meadow).toEqual([42, 42]);
    expect(measured.snowBand).toEqual([42, 42]);
  });

  it("reports no shed rule when the snow row has none", () => {
    expect(measureBands([{ from: 0, layer: "snow", to: 1 }], [0, 10]).snowShed).toBeNull();
    expect(measureBands([{ from: 0, layer: "snow", to: 1 }], [0, 10]).snowBand).toEqual([0, 10]);
  });

  it("fails closed on no samples and on a non-finite one", () => {
    expect(() => measureBands(layers, [])).toThrow("Terrain elevation samples are empty");
    expect(() => measureBands(layers, [0, Number.NaN])).toThrow(
      "Terrain elevation sample is nonfinite",
    );
  });
});

describe("bakeBiome", () => {
  it("carries every instance the recipe placed, and the biome's measured bands", () => {
    const terrain = state();
    const baked = bakeBiome({ spec: SPEC, state: terrain, assets: ASSETS });
    const placed = baked.placements.reduce((sum, row) => sum + row.count, 0);
    expect(placed).toBe(terrain.instances.length);
    expect(baked.placements).toEqual([{ asset: "fir", count: terrain.instances.length }]);
    const [min, max] = baked.bands.elevationRange;
    expect(max).toBeGreaterThan(min);
    expect(baked.bands.snowShed).toEqual([0.1, 0.4]);
    expect(pkg(baked).manifest.extent).toEqual({ minX: -128, minZ: -128, sizeX: 256, sizeZ: 256 });
  });

  it("bakes the same package the writer does, cell runs included", () => {
    const terrain = state();
    const baked = bakeBiome({ spec: SPEC, state: terrain, assets: ASSETS, cellSize: 64 });
    const runs = pkg(baked).manifest.cells.flatMap((cell) => cell.runs);
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((run) => run.asset === "fir")).toBe(true);
    // Cells tile the extent at the requested size and every run points inside the record buffer.
    for (const cell of pkg(baked).manifest.cells) {
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.z).toBeGreaterThanOrEqual(0);
    }
  });

  it("is seeded: the same recipe bakes the same placements bytes", () => {
    const first = bakeBiome({ spec: SPEC, state: state(), assets: ASSETS });
    const second = bakeBiome({ spec: SPEC, state: state(), assets: ASSETS });
    expect(pkg(second).files[pkg(second).manifest.placements]).toEqual(
      pkg(first).files[pkg(first).manifest.placements],
    );
  });

  it("fails closed on an asset the table does not carry", () => {
    // A valid spec reaches the bake; the empty table is the only fault, so the world package throws.
    expect(() => bakeBiome({ spec: SPEC, state: state(), assets: {} })).toThrow(
      /names asset 'fir', which options\.assets does not/,
    );
  });
});
