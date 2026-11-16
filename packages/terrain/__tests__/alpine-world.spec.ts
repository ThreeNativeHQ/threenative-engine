/**
 * PRD-892 Phase 2 (alpine): the streamed bake's world row.
 *
 * `bakeKit`'s streamed path reads `recipe.json`'s `world` row: the name every baked file takes, the
 * ground table the splat is painted from, and the art the bake copies. The far ring is the one part
 * still blocked on a real Longs Peak surround survey, so this case checks the row that exists and
 * keeps a ring, once authored, honest about its survey.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const starter = path.resolve(import.meta.dirname, "..", "starter");
const assets = path.resolve(import.meta.dirname, "..", "starter-assets");
const recipe = JSON.parse(readFileSync(path.join(starter, "alpine", "recipe.json"), "utf8")) as {
  world?: {
    name: string;
    ground: { base: string; layers: readonly string[]; roughness: number };
    farRing?: { survey: string };
    art: readonly string[];
  };
};

describe("the alpine world row", () => {
  const world = recipe.world;
  it("names the world and paints the ground from real layers", () => {
    expect(world?.name).toBe("alpine");
    expect(world?.ground.base).toBeTruthy();
    expect(world?.ground.layers.length).toBeGreaterThan(0);
    expect(world?.ground.roughness).toBeGreaterThan(0);
  });

  it("copies only art the starter assets actually hold", () => {
    expect(world?.art.length).toBeGreaterThan(0);
    for (const entry of world?.art ?? [])
      expect(existsSync(path.join(assets, entry)), `${entry} must exist in starter-assets`).toBe(
        true,
      );
  });

  it("keeps a ring's survey resolvable the day the row grows one", () => {
    const survey = world?.farRing?.survey;
    if (survey === undefined) return; // No long-surround survey exists yet; the PRD records the gap.
    expect(existsSync(path.join(assets, "survey", `${survey}.json`))).toBe(true);
    expect(existsSync(path.join(assets, "survey", `${survey}.bin`))).toBe(true);
  });
});
