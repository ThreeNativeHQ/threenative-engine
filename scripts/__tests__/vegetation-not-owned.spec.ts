import { describe, expect, it } from "vitest";
import { searchCapabilities } from "../../packages/engine-mcp/src/index.js";

// The phrasings a game agent typed before it found nothing and hand-wrote trees (sandbox grove).
const queries = [
  "foliage vegetation trees wind sway",
  "procedural trees",
  "trees swaying in the wind",
  "grow procedural tree meshes",
];

describe("procedural vegetation guidance", () => {
  for (const query of queries)
    it(`points "${query}" at the vegetation integration`, () => {
      const response = searchCapabilities(query);
      expect(response.verdict).toBe("none");
      expect(response.guidance).toMatch(/examples\/integrations\/vegetation/u);
    });
});
