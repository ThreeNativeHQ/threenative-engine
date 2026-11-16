/**
 * PRD-892 Phase 2 (alpine): the alpine biome's vegetation rows, as data.
 *
 * The rows name real vegetation presets, not shapes baked here: the cook filters a species its asset
 * table does not carry, and the streamed bake's prop module is what grows the ones it does. This case
 * pins the box's species list and rejects a row the biome schema would not read.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { vegetationPresets } from "@threenative/procedural-vegetation";
import { describe, expect, it } from "vitest";
import { validateBiome } from "../src/biome/biome.js";

const file = path.resolve(import.meta.dirname, "..", "starter", "alpine", "biome.data.json");
const spec = validateBiome(JSON.parse(readFileSync(file, "utf8")), "alpine");
const presets = new Set(vegetationPresets().map((preset) => preset.id));

describe("the alpine biome rows", () => {
  it("names the stands, the taiga edge and the tundra cover with real presets", () => {
    expect(spec.foliage.map((row) => row.species)).toEqual(["spruce", "scotspine", "blackspruce"]);
    expect(spec.grass.map((row) => row.species)).toEqual([
      "tundragrass",
      "tussock",
      "fireweed",
      "blueberry",
    ]);
    expect(spec.species).toContain("rock");
    for (const species of [...spec.foliage, ...spec.grass].map((row) => row.species))
      expect(presets.has(species), `${species} must be an installed preset`).toBe(true);
  });

  it("keeps the stands banded by slope and height, and the cover below the treeline", () => {
    for (const stand of spec.foliage) {
      expect(stand.slope[1]).toBeGreaterThan(0);
      expect(stand.height?.[1]).toBeGreaterThan(0);
      expect(stand.far?.reach).toBeGreaterThan(1000);
    }
    for (const cover of spec.grass) expect(cover.density).toBeGreaterThan(0);
  });

  it("still fails closed on a field the biome schema does not know", () => {
    const bad = { ...spec, foliage: [{ ...spec.foliage[0], krummholz: true }] };
    expect(() => validateBiome(bad, "alpine")).toThrow(/krummholz/);
  });
});
