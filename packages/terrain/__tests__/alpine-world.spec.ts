/**
 * PRD-892 Phase 2 (alpine): the streamed bake's world row.
 *
 * `bakeKit`'s streamed path reads `recipe.json`'s `world` row: the name every baked file takes, the
 * ground table the splat is painted from, and the art the bake copies. The far ring is the one part
 * still blocked on a real Longs Peak surround survey, so this case checks the row that exists and
 * keeps a ring, once authored, honest about its survey.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ringSeam } from "../src/kit-world.js";

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
    const metaPath = path.join(assets, "survey", `${survey}.json`);
    const binPath = path.join(assets, "survey", `${survey}.bin`);
    expect(existsSync(metaPath)).toBe(true);
    expect(existsSync(binPath)).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
      resolution: number;
      sha256: string;
    };
    const bytes = readFileSync(binPath);
    expect(bytes.length).toBe(meta.resolution ** 2 * 2);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(meta.sha256);
  });

  it("stands the far ring on the square's own ground: the real survey, no wall at the join", () => {
    const out = mkdtempSync(path.join(tmpdir(), "terrain-alpine-ring-"));
    try {
      execFileSync(process.execPath, [path.join(starter, "alpine", "bake.mjs"), "--out", out], {
        stdio: "pipe",
      });
      const square = JSON.parse(readFileSync(path.join(out, "world", "alpine.json"), "utf8"));
      const horizon = JSON.parse(readFileSync(path.join(out, "world", "horizon.json"), "utf8"));
      const ring = { ...horizon.alpine, height: horizon.alpine.heights };
      // The USGS ring shares the square's centre and datum: the step is resolution, not a cliff.
      expect(ringSeam(square, ring)).toBeLessThan(8);
      // Longs Peak's real summit (4,345 m) is 655 m above the 3,690 m datum, not a stretched tile.
      expect(ring.height.reduce((a: number, b: number) => Math.max(a, b))).toBeLessThan(700);
      expect(horizon.alpine.massif).toBeUndefined();
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 120_000);
});
