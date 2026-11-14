import { describe, expect, it } from "vitest";
import { searchCapabilities } from "../../packages/engine-mcp/src/index.js";

// The phrasings a game agent typed before it found nothing and hand-wrote trees (sandbox grove).
describe("procedural vegetation guidance", () => {
  for (const query of ["foliage vegetation trees wind sway", "trees swaying in the wind"])
    it(`points "${query}" at the bake package and the game's own wind`, () => {
      const response = searchCapabilities(query);
      expect(response.verdict).toBe("none");
      expect(response.guidance).toMatch(/@threenative\/procedural-vegetation/u);
      expect(response.guidance).toMatch(/render\/wind\.ts/u);
    });
  for (const query of ["procedural trees", "grow procedural tree meshes"])
    it(`finds bakeVegetation for "${query}"`, () => {
      const response = searchCapabilities(query);
      expect(response.verdict).toBe("matched");
      expect(response.results[0]?.symbol).toBe("bakeVegetation");
    });
});
