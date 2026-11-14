import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { speciesFor } from "../src/render/props/pack.js";

const STARTER = join(import.meta.dirname, "../../../packages/terrain/starter-assets");

describe("the forest canopy is Poly Haven art the starter ships", () => {
  it("draws every spruce level from a starter-assets GLB, not the licensed local pack", () => {
    const canopy = speciesFor("forest").filter((one) => one.asset === "spruce");
    expect(canopy.map((one) => one.level ?? 0).sort()).toEqual([0, 0, 0, 0, 0, 1, 1, 1, 1, 1]);
    for (const one of canopy) {
      expect(one.path).toMatch(/^tree_small_02\/broadleaf(-b)?-(near|mid)\.glb$/u);
      expect(existsSync(join(STARTER, one.path)), one.path).toBe(true);
    }
  });
});
