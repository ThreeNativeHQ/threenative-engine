import { describe, expect, it } from "vitest";
import { searchCapabilities } from "../../packages/engine-mcp/src/index.js";

// The phrasings a game agent typed before it found nothing and hand-wrote trees (sandbox grove).
describe("procedural vegetation guidance", () => {
  // Matched, since the bake package is an engine capability (PRD-892's nature discovery); what the
  // verdict must never become is a claim that the engine renders or animates the trees.
  for (const query of ["foliage vegetation trees wind sway", "trees swaying in the wind"])
    it(`points "${query}" at the bake package and the game's own wind`, () => {
      const response = searchCapabilities(query);
      expect(response.verdict).toBe("matched");
      expect(response.results[0]?.symbol).toBe("bakeVegetation");
      expect(response.guidance).toMatch(/@threenative\/procedural-environment/u);
      expect(response.guidance).toMatch(/render\/wind\.ts/u);
    });
  for (const query of ["procedural trees", "grow procedural tree meshes"])
    it(`finds bakeVegetation for "${query}"`, () => {
      const response = searchCapabilities(query);
      expect(response.verdict).toBe("matched");
      expect(response.results[0]?.symbol).toBe("bakeVegetation");
    });
});
