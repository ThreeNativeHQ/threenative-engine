/**
 * PRD-792 phase 1: today's bake is the reference a general `bakeBiome` has to reproduce.
 *
 * The pin is the committed table below: per world, a digest of the prop package's containers, the
 * placement count per species, a digest of the baked heights and a digest of the world manifest,
 * plus the continuation ring. The containers replaced the single placement table when the bake
 * stopped writing one (PRD-792 AC-2); the counts and the heights are the Phase 1 numbers, byte for
 * byte, so only the container's own bytes moved here. Two forced bakes must produce the same numbers, so the table is a statement
 * about the recipe and not about one run's luck; a changed scatter rule, erosion pass, palette or
 * height crop fails here, named. The continuation digest moved once, for PRD-806 E19's removal of
 * the debug `forest-before` survey the `?massif=before` knob swapped in.
 *
 * `--force` because the bake's stamp would otherwise skip the work under a warm `pnpm test`; the
 * recipe is seeded and the outputs are byte-identical, so the run rewrites the tracked files with
 * their own bytes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { propAssetOf } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

const exampleRoot = fileURLToPath(new URL("..", import.meta.url));
const worldDir = new URL("../src/world/", import.meta.url);

const WORLDS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;
/** The two worlds that share `baked.json`; the other three have their own module-sized file. */
const DRAWN = new Set<string>(["forest", "coastal"]);

/** The recipe's own output: the Phase 1 numbers, with the container digest re-measured at AC-2. */
const GOLDEN = {
  forest: {
    placements: "d108ef0946632404625e7cd82ec56f0cf22641140d0f627ce782b27476b47c0e",
    counts: {
      boulder: 115,
      bush: 4261,
      deadfall: 846,
      fern: 30055,
      grass: 259588,
      litter: 37602,
      mountain: 7,
      pebble: 1638,
      poppy: 4082,
      riverrock: 318,
      sapling: 9528,
      scrub: 78269,
      spruce: 5649,
    },
    heights: "c3b5a7ebe3784e844604799f599950ea52f98477ca3a3e8b0c63cf76c08b6770",
    manifest: "df9936f9e3a31532426972a19c47c168262efc6117040d5a577863500307dd2c",
  },
  coastal: {
    placements: "ef878ecc5f077bc74d29805cfa7a872436ea5ea8fca8bc0964dc9770f3ba6d49",
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
    placements: "9bbea86d01fc14fc37fb781df11f5bd8f995f0a5bf516580de662f82a0420b6f",
    counts: { boulder: 1082, mountain: 231, scree: 2285 },
    heights: "f2ca8381d0b7fc707a8225b2c078af699ee723ef1b681fb87274ea95899f313f",
    manifest: "927b5daf593923d63bb216968baf66d2a735269801915c6395aa84e60c1b4f86",
  },
  desert: {
    placements: "0ee80bb17d8c40cb8c1a635f882ef5e309af05c096eaae75e434f0f15de3978e",
    counts: { boulder: 248, grass: 2506, reveal: 170, scrub: 393, volcanic: 237 },
    heights: "aa401a0bd80952f20f20e3f2fe5f7b81820d4b2ce2b1b6bc4116620b28188f02",
    manifest: "8d979f26cf4a02dd6c46d2a5c67e7aae7c50cab0920c1c9673039b7d43472872",
  },
  tundra: {
    placements: "8f2d1b7b11444dd74bc9e8e3b5db1016271f57594b630a1d008486accbdb8942",
    counts: { boulder: 2028, bush: 594, grass: 30490, riverrock: 612, sapling: 55, scrub: 6680 },
    heights: "dc182307fa2789f7297d53e96c77720b7fac97119489f725d8ebbb44e1d60533",
    manifest: "72c72e6f86b2a800aeae246b4800390b6c57fe6b95dc87510193549f9106c943",
  },
  horizon: "65b7ca8ada0dca6fe633f317b3f0e115b5e89dedd1dea823bdde6bde44d650f4",
} as const;

const read = (name: string): Uint8Array => readFileSync(new URL(name, worldDir));
const hash = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const json = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, worldDir), "utf8")) as T;

/** One bucket as the prop package's manifest lists it: its files and the runs its cells index. */
interface IBucketListing {
  readonly placements: string;
  readonly cells: readonly { readonly runs: readonly { asset: string; count: number }[] }[];
}

/** One world's measured output: what the bake wrote, read back the way the game reads it. */
function worldDigest(world: (typeof WORLDS)[number], baked: Record<string, { heights: number[] }>) {
  const listing = json<{ buckets: IBucketListing[] }>(`${world}.props.json`);
  const counts: Record<string, number> = {};
  for (const bucket of listing.buckets)
    for (const cell of bucket.cells)
      for (const run of cell.runs) {
        const asset = propAssetOf(run.asset);
        counts[asset] = (counts[asset] ?? 0) + run.count;
      }
  const heights = DRAWN.has(world)
    ? baked[world]?.heights
    : json<{ heights: number[] }>(`${world}.json`).heights;
  return {
    // Every bucket's container, in the manifest's own order: the records themselves.
    placements: hash(Buffer.concat(listing.buckets.map((bucket) => read(bucket.placements)))),
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
