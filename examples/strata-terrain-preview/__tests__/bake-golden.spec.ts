/**
 * PRD-792 phase 1: today's bake is the reference a general `bakeBiome` has to reproduce.
 *
 * The pin is the committed table below: per world, a digest of the placement table, the placement
 * count per species, a digest of the baked heights and a digest of the world manifest, plus the
 * continuation ring. Two forced bakes must produce the same numbers, so the table is a statement
 * about the recipe and not about one run's luck; a changed scatter rule, erosion pass, palette or
 * height crop fails here, named.
 *
 * `--force` because the bake's stamp would otherwise skip the work under a warm `pnpm test`; the
 * recipe is seeded and the outputs are byte-identical, so the run rewrites the tracked files with
 * their own bytes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodePlacements } from "../src/render/placements.js";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const worldDir = new URL("../src/world/", import.meta.url);

const WORLDS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;
/** The two worlds that share `baked.json`; the other three have their own module-sized file. */
const DRAWN = new Set<string>(["forest", "coastal"]);

/** The recipe's own output, measured on `8edfd6d81` before any bake code moved. */
const GOLDEN = {
  forest: {
    placements: "74edefef7a48688be2d6e5fea0bd9e8292b49962ee8959cf27339f07bc53ec17",
    counts: {
      boulder: 105,
      bush: 1384,
      fern: 7211,
      grass: 144698,
      litter: 2694,
      mountain: 7,
      pebble: 1616,
      poppy: 3316,
      riverrock: 357,
      sapling: 5379,
      scrub: 43242,
      spruce: 3131,
    },
    heights: "c3b5a7ebe3784e844604799f599950ea52f98477ca3a3e8b0c63cf76c08b6770",
    manifest: "df9936f9e3a31532426972a19c47c168262efc6117040d5a577863500307dd2c",
  },
  coastal: {
    placements: "aeb61fac3fd8fe3a792208d4fd0849dcd9289ef4f1c0b11bdd788993c54ef386",
    counts: {
      boulder: 235,
      bush: 1225,
      fern: 7466,
      grass: 95231,
      litter: 2097,
      mountain: 75,
      poppy: 440,
      riverrock: 170,
      sapling: 5536,
      scrub: 28517,
      spruce: 3200,
    },
    heights: "0c374becf41357b1db5526209ff7acbeb44a3a047e67cb88a0515a7c0660688c",
    manifest: "5bb08aeccc829c5dd5fc36954cfcd883f53b0b7c83b06233f9fdec7c833528a8",
  },
  alpine: {
    placements: "3352e12dde3a034926b9ca271786a665084264458802f11122179b8d83e68503",
    counts: { boulder: 1082, mountain: 231, scree: 2285 },
    heights: "f2ca8381d0b7fc707a8225b2c078af699ee723ef1b681fb87274ea95899f313f",
    manifest: "927b5daf593923d63bb216968baf66d2a735269801915c6395aa84e60c1b4f86",
  },
  desert: {
    placements: "64ce8648b98a1f8248b60dd9b90d841b979fa10a7492657838a2fb3185793201",
    counts: { boulder: 248, grass: 2506, reveal: 170, scrub: 393, volcanic: 237 },
    heights: "aa401a0bd80952f20f20e3f2fe5f7b81820d4b2ce2b1b6bc4116620b28188f02",
    manifest: "8d979f26cf4a02dd6c46d2a5c67e7aae7c50cab0920c1c9673039b7d43472872",
  },
  tundra: {
    placements: "2c0123035d9a528128da5053880256b56c9a6003002a25441394dcd4631d4867",
    counts: { boulder: 2028, bush: 594, grass: 30490, riverrock: 612, sapling: 55, scrub: 6680 },
    heights: "dc182307fa2789f7297d53e96c77720b7fac97119489f725d8ebbb44e1d60533",
    manifest: "72c72e6f86b2a800aeae246b4800390b6c57fe6b95dc87510193549f9106c943",
  },
  horizon: "8b1a00d743b472e10ef523c5783ad8f60d3f5c0e08fbb489c233b62491dac8e7",
} as const;

const read = (name: string): Uint8Array => readFileSync(new URL(name, worldDir));
const hash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, worldDir), "utf8")) as T;

/** One world's measured output: what the bake wrote, read back the way the game reads it. */
function worldDigest(world: (typeof WORLDS)[number], baked: Record<string, { heights: number[] }>) {
  const bytes = read(`${world}.placements.bin`);
  const { counts } = decodePlacements(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const heights = DRAWN.has(world)
    ? baked[world]?.heights
    : json<{ heights: number[] }>(`${world}.json`).heights;
  return {
    placements: hash(bytes),
    counts: Object.fromEntries(
      Object.entries(counts)
        .filter(([, count]) => count > 0)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    heights: hash(JSON.stringify(heights)),
    manifest: hash(read(`${world}.world.json`)),
  };
}

function snapshot() {
  const baked = json<Record<string, { heights: number[] }>>("baked.json");
  return {
    ...Object.fromEntries(WORLDS.map((world) => [world, worldDigest(world, baked)])),
    horizon: hash(read("horizon.json")),
  };
}

function bake(): Record<string, unknown> {
  execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/bake.mjs", import.meta.url)), "--force"],
    {
      cwd: exampleRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return snapshot();
}

describe("the bake's golden digests", () => {
  it("reproduces the committed table twice, seed for seed", () => {
    const first = bake();
    const second = bake();
    expect(second).toEqual(first);
    expect(first).toEqual(GOLDEN);
  }, 300_000);
});
