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
 * the debug `forest-before` survey the `?massif=before` knob swapped in. Four worlds' counts and
 * containers moved once more: alpine, desert and tundra for PRD-892, which puts every kit on the
 * forest's world-building stack, so they scatter the forest's species; coastal for its shore
 * stones, which is the coast scattering the granite it surveys. Heights and manifests are unchanged
 * in all five, which is what makes the move the scatter's and not the ground's; forest is untouched.
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
    placements: "c8f5d0439e240c693f1f5d47f0b20923d5891031d5589e2ec7da3093e745296e",
    counts: {
      boulder: 112,
      bush: 4260,
      deadfall: 846,
      fern: 30055,
      grass: 259588,
      litter: 37602,
      mountain: 7,
      pebble: 1638,
      poppy: 4082,
      riverrock: 318,
      sapling: 9524,
      scrub: 78269,
      spruce: 5648,
    },
    heights: "c3b5a7ebe3784e844604799f599950ea52f98477ca3a3e8b0c63cf76c08b6770",
    manifest: "df9936f9e3a31532426972a19c47c168262efc6117040d5a577863500307dd2c",
  },
  coastal: {
    placements: "2cf9bfa060b249f24514efcd02b3b05914cb255fd332c5e0df8bb26b25542610",
    counts: {
      boulder: 256,
      bush: 1298,
      fern: 7584,
      grass: 154549,
      litter: 2304,
      mountain: 60,
      poppy: 1856,
      riverrock: 147,
      sapling: 5549,
      scrub: 46211,
      spruce: 3200,
    },
    heights: "0c374becf41357b1db5526209ff7acbeb44a3a047e67cb88a0515a7c0660688c",
    manifest: "5bb08aeccc829c5dd5fc36954cfcd883f53b0b7c83b06233f9fdec7c833528a8",
  },
  alpine: {
    placements: "4cc173bafd9990d8e68ac46ee3c822639136f4739006f9f122a4c556612cd355",
    counts: {
      boulder: 492,
      bush: 2422,
      cliff: 29,
      deadfall: 231,
      fern: 5592,
      grass: 40492,
      litter: 13348,
      mountain: 566,
      poppy: 2348,
      sapling: 698,
      scrub: 12227,
      spruce: 382,
    },
    heights: "f2ca8381d0b7fc707a8225b2c078af699ee723ef1b681fb87274ea95899f313f",
    manifest: "927b5daf593923d63bb216968baf66d2a735269801915c6395aa84e60c1b4f86",
  },
  desert: {
    placements: "8c66d03b8aa1bd5e90a3fb8884d15a0a65c8356ae00f15042ce8ac3f040d45b8",
    counts: {
      boulder: 248,
      bush: 27,
      grass: 6559,
      reveal: 158,
      sapling: 161,
      scrub: 909,
      volcanic: 229,
    },
    heights: "aa401a0bd80952f20f20e3f2fe5f7b81820d4b2ce2b1b6bc4116620b28188f02",
    manifest: "8d979f26cf4a02dd6c46d2a5c67e7aae7c50cab0920c1c9673039b7d43472872",
  },
  tundra: {
    placements: "0987d7141890adb90a719cf00aed3cc4733120e43f06090b81c338430c3bdf56",
    counts: {
      boulder: 2098,
      bush: 1247,
      grass: 61160,
      riverrock: 612,
      sapling: 140,
      scrub: 13415,
    },
    heights: "dc182307fa2789f7297d53e96c77720b7fac97119489f725d8ebbb44e1d60533",
    manifest: "72c72e6f86b2a800aeae246b4800390b6c57fe6b95dc87510193549f9106c943",
  },
  horizon: "f9726916885d79f137891288240cfe8ed7ae12cf36d032b315c22b6c39f4f277",
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
    [fileURLToPath(new URL("../scripts/bake/bake.mjs", import.meta.url)), "--force"],
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
