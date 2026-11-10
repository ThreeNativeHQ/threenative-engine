import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Terrain } from "@threenative/terrain";
import { afterAll, expect, it } from "vitest";

// PRD-866 Phase 3: `STRATA_WORLD=<terrain_generate out dir> pnpm bake` bakes the forest from a cooked
// world: its recipe (ground, layers, seed) and its far ring. The fixture is what the cook writes
// there, `recipe.json` (a terrain document) and `ring.json`, built small in a temporary folder.
const example = fileURLToPath(new URL("..", import.meta.url));
const bake = (env: NodeJS.ProcessEnv) =>
  execFileSync(process.execPath, ["scripts/bake.mjs", "--force"], {
    cwd: example,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
const read = (file: string) =>
  JSON.parse(readFileSync(join(example, "src", "world", file), "utf8"));

afterAll(() => {
  // The pinned bake is the one every other spec and the game read.
  const { STRATA_WORLD: _, ...pinned } = process.env;
  execFileSync(process.execPath, ["scripts/bake.mjs", "--force"], {
    cwd: example,
    env: pinned,
    stdio: "ignore",
  });
}, 300_000);

it("bakes the forest from a cooked world's ground and ring, and the pinned bake when unset", async () => {
  // This process has no STRATA_WORLD, so its stamp is the pinned bake's.
  const { isFresh } = await import("../scripts/stamp.mjs");
  const { outputDir } = await import("../scripts/recipe.mjs");
  const cook = mkdtempSync(join(tmpdir(), "strata-cooked-"));
  // The cook's own layer order (`terrain_generate` writes ground, hydraulic and thermal erosion,
  // smoothing), on a seeded ground that needs no survey tile.
  const recipe = new Terrain({ size: 512, resolution: 257, seed: 9 })
    .erode({ id: "runoff", method: "hydraulic", droplets: 4000, maxSteps: 30 })
    .erode({ id: "talus", method: "thermal", talus: 38, iterations: 1, rate: 0.004 })
    .toJSON();
  writeFileSync(join(cook, "recipe.json"), JSON.stringify(recipe));
  const ring = new Terrain({ size: 5120, resolution: 129, seed: 2 }).evaluate();
  writeFileSync(
    join(cook, "ring.json"),
    JSON.stringify({ size: 5120, resolution: 129, heights: Array.from(ring.height) }),
  );
  bake({ STRATA_WORLD: cook });
  const forest = read("baked.json").forest as { size: number; heights: number[] };
  expect(forest.size).toBe(512);
  expect(forest.heights).toEqual(Array.from(Terrain.fromJSON(recipe).evaluate().height));
  const horizon = read("horizon.json").forest as { size: number; heights: number[] };
  expect(horizon.size).toBe(5120);
  expect(horizon.heights).toEqual(Array.from(ring.height, (h: number) => Math.round(h * 10) / 10));
  expect(await isFresh(outputDir)).toBe(false);
  // Unset, the bake is the pinned one again, and the stamp calls it fresh.
  const { STRATA_WORLD: _, ...pinned } = process.env;
  bake(pinned);
  expect(await isFresh(outputDir)).toBe(true);
  expect(read("horizon.json").forest.size).toBe(5000);
}, 600_000);
