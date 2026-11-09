import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validateBiome } from "../src/index.js";

const KITS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;

/** One kit's own file, as JSON: the game and the MCP read the same bytes. */
const read = (kit: string): Record<string, unknown> =>
  JSON.parse(readFileSync(new URL(`../starter/${kit}/biome.data.json`, import.meta.url), "utf8"));

/** The message a rejection throws, so a test can name the field it must report. */
function rejection(spec: unknown, name: string): string {
  try {
    validateBiome(spec, name);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`${name}'s malformed file was accepted`);
}

describe("a biome file", () => {
  it("validates for every shipped kit, and names itself in its aliases", () => {
    for (const kit of KITS) {
      const spec = validateBiome(read(kit), kit);
      expect(spec.look).toBe(kit);
      expect(spec.aliases[0]).toBe(kit);
      expect(spec.foliage.length).toBeGreaterThan(0);
      expect(spec.grass.length).toBeGreaterThan(0);
      expect(spec.layers.length).toBeGreaterThan(0);
      expect(spec.sizeMeters).toBe(512);
      expect(spec.bake.file.length).toBeGreaterThan(0);
      // Two biomes generated from one DEM share a bundle and name their key inside it.
      expect(spec.bake.key === null || spec.bake.key.length > 0).toBe(true);
    }
  });

  it("rejects a field a biome does not have", () => {
    const message = rejection({ ...read("forest"), sky: 0.4 }, "forest");
    expect(message).toContain("forest");
    expect(message).toContain("'sky'");
  });

  it("rejects a missing field", () => {
    const { seed: _seed, ...broken } = read("alpine");
    const message = rejection(broken, "alpine");
    expect(message).toContain("alpine");
    expect(message).toContain("'seed' is missing");
    const { spacing: _spacing, ...grass } = (
      read("desert").grass as Record<string, unknown>[]
    )[0] as {
      spacing: number;
    };
    const nested = rejection({ ...read("desert"), grass: [grass] }, "desert");
    expect(nested).toContain("desert");
    expect(nested).toContain("'grass[0].spacing' is missing");
  });

  it("rejects a value outside the range its field can hold", () => {
    const steep = read("forest") as { foliage: { slope: number[] }[] };
    (steep.foliage[0] as { slope: number[] }).slope = [0, 120];
    const message = rejection(steep, "forest");
    expect(message).toContain("forest");
    expect(message).toContain("'foliage[0].slope[1]' must be at most 90");

    const covered = read("tundra") as { grass: { density: number }[] };
    (covered.grass[0] as { density: number }).density = 1.4;
    expect(rejection(covered, "tundra")).toContain("'grass[0].density' must be at most 1");

    const inverted = read("desert") as { layers: { from: number; to: number }[] };
    (inverted.layers[1] as { from: number }).from = 3;
    expect(rejection(inverted, "desert")).toContain("'layers[1]' must end above where it starts");

    const unknownLandform = { ...read("coastal"), landform: "moon" };
    expect(rejection(unknownLandform, "coastal")).toContain("'landform' must be one of");

    const drifter = read("coastal") as { water: { kind: string; level?: number }[] };
    drifter.water[0] = { kind: "ocean" };
    expect(rejection(drifter, "coastal")).toContain("'water[0].level' is missing");

    const namelessBake = { ...read("forest"), bake: { file: "", key: "forest" } };
    expect(rejection(namelessBake, "forest")).toContain("'bake.file' must be a non-empty string");
    const keylessBake = { ...read("forest"), bake: { file: "baked", key: "forest", at: 1 } };
    expect(rejection(keylessBake, "forest")).toContain("'bake.at' is not a field a biome has");
  });

  it("range-checks every interval and every nullable field, not just their presence", () => {
    // A nullable height: null is a value, and anything else must be a band of metres.
    const noCeiling = read("forest") as { foliage: Record<string, unknown>[] };
    expect(validateBiome(noCeiling, "forest").foliage[0]?.height).toBeNull();
    for (const height of ["8", [0], { from: 0, to: 8 }]) {
      const wrong = { ...read("forest") } as { foliage: Record<string, unknown>[] };
      (wrong.foliage[0] as Record<string, unknown>).height = height;
      expect(rejection(wrong, "forest")).toContain(
        "'foliage[0].height' must be an array of 2 numbers",
      );
    }
    const belowFloor = { ...read("alpine") } as { foliage: Record<string, unknown>[] };
    (belowFloor.foliage[0] as Record<string, unknown>).height = [0, -5];
    expect(rejection(belowFloor, "alpine")).toContain("'foliage[0].height[1]' must be at least 0");
    const upsideDown = { ...read("alpine") } as { foliage: Record<string, unknown>[] };
    (upsideDown.foliage[0] as Record<string, unknown>).height = [52, 0];
    expect(rejection(upsideDown, "alpine")).toContain("'foliage[0].height' must ascend");

    // Intervals ascend and stay inside the range their field can hold.
    const tightSpacing = { ...read("forest") } as { foliage: Record<string, unknown>[] };
    (tightSpacing.foliage[0] as Record<string, unknown>).spacing = [6.4, 3.2];
    expect(rejection(tightSpacing, "forest")).toContain("'foliage[0].spacing' must ascend");
    const negativeSpacing = { ...read("forest") } as { foliage: Record<string, unknown>[] };
    (negativeSpacing.foliage[0] as Record<string, unknown>).spacing = [-1, 3.2];
    expect(rejection(negativeSpacing, "forest")).toContain(
      "'foliage[0].spacing[0]' must be at least 0",
    );
    const steep = { ...read("tundra") } as { foliage: Record<string, unknown>[] };
    (steep.foliage[0] as Record<string, unknown>).slope = [32, 0];
    expect(rejection(steep, "tundra")).toContain("'foliage[0].slope' must ascend");
    const wild = { ...read("tundra") } as { foliage: Record<string, unknown>[] };
    (wild.foliage[0] as Record<string, unknown>).slope = [0, 120];
    expect(rejection(wild, "tundra")).toContain("'foliage[0].slope[1]' must be at most 90");

    // Every number that is a size is strictly positive, and snow sheds the right way round.
    const noCell = { ...read("forest") } as { grass: Record<string, unknown>[] };
    (noCell.grass[0] as Record<string, unknown>).spacing = 0;
    expect(rejection(noCell, "forest")).toContain("'grass[0].spacing' must be greater than 0");
    const backwardsSnow = { ...read("alpine") } as { layers: Record<string, unknown>[] };
    (backwardsSnow.layers[7] as Record<string, unknown>).shedFrom = 0.5;
    expect(rejection(backwardsSnow, "alpine")).toContain(
      "'layers[7]' must shed from a gentler slope than it sheds to",
    );
    const dryRiver = { ...read("forest") } as { water: Record<string, unknown>[] };
    (dryRiver.water[0] as Record<string, unknown>).width = 0;
    expect(rejection(dryRiver, "forest")).toContain("'water[0].width' must be greater than 0");

    // A mat field band is a threshold and a span, both weights, and a span of zero covers nothing.
    for (const mats of ["0.47", [0.47], { threshold: 0.47, span: 0.3 }, [0.47, 2]]) {
      const wrong = { ...read("tundra") } as { grass: Record<string, unknown>[] };
      (wrong.grass[0] as Record<string, unknown>).mats = mats;
      expect(rejection(wrong, "tundra")).toContain("'grass[0].mats");
    }
    const flatField = { ...read("tundra") } as { grass: Record<string, unknown>[] };
    (flatField.grass[0] as Record<string, unknown>).mats = [0.47, 0];
    expect(rejection(flatField, "tundra")).toContain("'grass[0].mats[1]' must be greater than 0");
    // Null is a value too: ground with no mats thins on something else.
    const noMats = { ...read("desert") } as { grass: Record<string, unknown>[] };
    expect(validateBiome(noMats, "desert").grass[0]?.mats).toBeNull();

    // The species a biome holds is a list of names, each once.
    const nameless = { ...read("alpine"), species: [] };
    expect(rejection(nameless, "alpine")).toContain("'species' must be a non-empty array");
    const twice = { ...read("alpine"), species: ["spruce", "spruce"] };
    expect(rejection(twice, "alpine")).toContain("'species[1]' repeats 'spruce'");
  });

  it("carries every field the ordered stream reads, and refuses a malformed one", () => {
    // Accepted: forest's own values, field by field, from the file through the validator.
    const forest = validateBiome(read("forest"), "forest");
    expect(forest.stream).toBe("ordered");
    expect(forest.cover).toEqual({
      ground: "wood",
      seed: 466_468,
      attempts: 240_000,
      stoneRadius: 1.9,
      clearings: [
        [165, -95, 10],
        [-145, -120, 10],
        [360, 200, 10],
      ],
      understorey: {
        attempts: 120_000,
        litter: 1.6,
        fern: 2.2,
        bush: 0.35,
        flower: 0.5,
        shade: 0.8,
        shadeRadius: 1.2,
      },
    });
    expect(forest.grass[0]).toMatchObject({
      drift: { field: "stand", frequency: [3.1, 2.7], offset: 0.8, amplitude: 0.2, band: [0, 1] },
      bladeScale: 1,
      bladeJitter: 0.65,
      scrubChance: 0.3,
      scrubScale: 0.9,
      scrubJitter: 0.6,
      scrubBush: false,
      shoreGround: false,
      cobbledBed: true,
    });
    // A second biome may name another field and another ground: the row is data, not a branch.
    expect(validateBiome(read("tundra"), "tundra").grass[0]?.drift.field).toBe("mats");
    expect(validateBiome(read("alpine"), "alpine").cover.ground).toBe("crag");

    // Malformed: each field is named, with the value it cannot hold.
    const grass = (file: Record<string, unknown>) =>
      (file.grass as Record<string, unknown>[])[0] as Record<string, unknown>;
    const drift = (file: Record<string, unknown>) => grass(file).drift as Record<string, unknown>;
    const rejects = (message: string, edit: (file: Record<string, unknown>) => void): void => {
      const file = structuredClone(read("forest")) as Record<string, unknown>;
      edit(file);
      expect(rejection(file, "forest")).toContain(message);
    };
    rejects("'stream' must be one of ordered, seeded", (file) => {
      file.stream = "unordered";
    });
    rejects("'cover' is missing", (file) => {
      Reflect.deleteProperty(file, "cover");
    });
    rejects("'cover.extra' is not a field a biome has", (file) => {
      (file.cover as Record<string, unknown>).extra = 1;
    });
    rejects("'cover.ground' must be one of wood, crag, mesa, mats", (file) => {
      (file.cover as Record<string, unknown>).ground = "moon";
    });
    rejects("'cover.seed' must be a whole number", (file) => {
      (file.cover as Record<string, unknown>).seed = 1.5;
    });
    rejects("'cover.attempts' must be at least 1", (file) => {
      (file.cover as Record<string, unknown>).attempts = 0;
    });
    rejects("'cover.stoneRadius' must be greater than 0", (file) => {
      (file.cover as Record<string, unknown>).stoneRadius = 0;
    });
    rejects("'cover.clearings' must be an array", (file) => {
      (file.cover as Record<string, unknown>).clearings = 3;
    });
    rejects("'cover.clearings[0]' must be an array of 3 numbers", (file) => {
      (file.cover as { clearings: number[][] }).clearings = [[165, -95]] as unknown as number[][];
    });
    rejects("'cover.clearings[0][2]' must be greater than 0", (file) => {
      (file.cover as { clearings: number[][] }).clearings = [[165, -95, 0]];
    });
    const under = (file: Record<string, unknown>) =>
      (file.cover as Record<string, unknown>).understorey as Record<string, unknown>;
    rejects("'cover.understorey.litter' is missing", (file) => {
      Reflect.deleteProperty(under(file), "litter");
    });
    rejects("'cover.understorey.attempts' must be a whole number", (file) => {
      under(file).attempts = 1.5;
    });
    rejects("'cover.understorey.fern' must be at least 0", (file) => {
      under(file).fern = -1;
    });
    rejects("'cover.understorey.shade' must be at most 1", (file) => {
      under(file).shade = 1.5;
    });
    rejects("'cover.understorey.shadeRadius' must be at least 0", (file) => {
      under(file).shadeRadius = -1;
    });
    rejects("'grass[0].drift' is missing", (file) => {
      Reflect.deleteProperty(grass(file), "drift");
    });
    rejects("'grass[0].drift.field' must be one of stand, mats", (file) => {
      drift(file).field = "meadow";
    });
    rejects("'grass[0].drift.frequency' must be two positive frequencies", (file) => {
      drift(file).frequency = [0, 1];
    });
    rejects("'grass[0].drift.offset' must be at most 1", (file) => {
      drift(file).offset = 2;
    });
    rejects("'grass[0].drift.amplitude' must be at least 0", (file) => {
      drift(file).amplitude = -1;
    });
    rejects("'grass[0].drift.band[1]' must be greater than 0", (file) => {
      drift(file).band = [0.5, 0];
    });
    rejects("'grass[0].bladeScale' must be a finite number", (file) => {
      grass(file).bladeScale = "1";
    });
    rejects("'grass[0].bladeJitter' must be at least 0", (file) => {
      grass(file).bladeJitter = -1;
    });
    rejects("'grass[0].scrubChance' must be at most 1", (file) => {
      grass(file).scrubChance = 1.5;
    });
    rejects("'grass[0].scrubScale' must be at least 0", (file) => {
      grass(file).scrubScale = -1;
    });
    rejects("'grass[0].scrubJitter' must be at least 0", (file) => {
      grass(file).scrubJitter = -0.5;
    });
    rejects("'grass[0].scrubBush' must be true or false", (file) => {
      grass(file).scrubBush = "yes";
    });
    rejects("'grass[0].shoreGround' must be true or false", (file) => {
      grass(file).shoreGround = 1;
    });
    rejects("'grass[0].cobbledBed' must be true or false", (file) => {
      grass(file).cobbledBed = null;
    });
  });

  it("names the biome it is asked about, not the file it was read from", () => {
    const { look: _look, ...broken } = read("forest");
    const message = rejection(broken, "a sixth biome");
    expect(message.startsWith("a sixth biome: ")).toBe(true);
    expect(message).toContain("'look' is missing");
  });
});
