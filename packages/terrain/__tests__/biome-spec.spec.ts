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
  });

  it("names the biome it is asked about, not the file it was read from", () => {
    const { look: _look, ...broken } = read("forest");
    const message = rejection(broken, "a sixth biome");
    expect(message.startsWith("a sixth biome: ")).toBe(true);
    expect(message).toContain("'look' is missing");
  });
});
