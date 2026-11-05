/**
 * PRD-792 phase 2: the package's bake against the Phase 1 digests.
 *
 * Phase 1 pinned today's five Strata worlds in the example's `bake-golden.spec.ts`: per world a
 * placement-table digest, the accepted count per species, a height digest and a world-manifest
 * digest, plus the continuation ring. This spec runs each of the five biome files
 * (`starter/<biome>/biome.data.json`) through the package and compares the result, digest for digest.
 *
 * The stages are the shipped ones: `foliageScatterRules` turns a foliage row into one
 * `IScatterRule`, `Terrain.evaluate()`'s scatter runs that rule through `surfaceSample`,
 * `densityFilter`, `selfPrune` and `meshSpawn`, and `bakeBiome` validates the file and writes the
 * cell runs. The ground is the kit's own recipe, decoded onto the 0.1 m lattice `cook.ts` reads.
 *
 * The package tests may not import example source (`example-imports.spec.ts`), so `PHASE_1` below is
 * a verbatim copy of the Phase 1 table. Change it only from a fresh Phase 1 measurement.
 *
 * The table has no `horizon` line: the continuation ring is five further terrains, not a biome, and
 * `bakeBiome` writes no continuation.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type IBakedBiome, bakeBiome, foliageScatterRules } from "../src/core/bake-biome.js";
import { type IBiomeSpec, type IFoliageType, validateBiome } from "../src/core/biome.js";
import { decodeRAW16 } from "../src/core/io.js";
import { finalizeState } from "../src/core/operations.js";
import { Terrain } from "../src/core/terrain.js";
import type { ITerrainState } from "../src/core/types.js";
import type { IWorldPackageAsset } from "../src/core/world-package.js";

const WORLDS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;
type World = (typeof WORLDS)[number];

/** The Phase 1 table, copied from the example spec without a change. */
const PHASE_1: Record<
  World,
  { heights: string; manifest: string; placements: string; counts: Record<string, number> }
> = {
  forest: {
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
    placements: "74edefef7a48688be2d6e5fea0bd9e8292b49962ee8959cf27339f07bc53ec17",
  },
  coastal: {
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
    placements: "aeb61fac3fd8fe3a792208d4fd0849dcd9289ef4f1c0b11bdd788993c54ef386",
  },
  alpine: {
    counts: { boulder: 1082, mountain: 231, scree: 2285 },
    heights: "f2ca8381d0b7fc707a8225b2c078af699ee723ef1b681fb87274ea95899f313f",
    manifest: "927b5daf593923d63bb216968baf66d2a735269801915c6395aa84e60c1b4f86",
    placements: "3352e12dde3a034926b9ca271786a665084264458802f11122179b8d83e68503",
  },
  desert: {
    counts: { boulder: 248, grass: 2506, reveal: 170, scrub: 393, volcanic: 237 },
    heights: "aa401a0bd80952f20f20e3f2fe5f7b81820d4b2ce2b1b6bc4116620b28188f02",
    manifest: "8d979f26cf4a02dd6c46d2a5c67e7aae7c50cab0920c1c9673039b7d43472872",
    placements: "64ce8648b98a1f8248b60dd9b90d841b979fa10a7492657838a2fb3185793201",
  },
  tundra: {
    counts: { boulder: 2028, bush: 594, grass: 30490, riverrock: 612, sapling: 55, scrub: 6680 },
    heights: "dc182307fa2789f7297d53e96c77720b7fac97119489f725d8ebbb44e1d60533",
    manifest: "72c72e6f86b2a800aeae246b4800390b6c57fe6b95dc87510193549f9106c943",
    placements: "2c0123035d9a528128da5053880256b56c9a6003002a25441394dcd4631d4867",
  },
};

/**
 * Which Phase 1 digests this bake reproduces today.
 *
 * The three heights that match are the worlds whose kit recipe is the recipe Phase 1 baked. Every
 * other line differs, and each cause is stated in the test below that names it.
 */
const MATCHES: Record<World, Record<"counts" | "heights" | "manifest" | "placements", boolean>> = {
  alpine: { counts: false, heights: true, manifest: false, placements: false },
  coastal: { counts: false, heights: true, manifest: false, placements: false },
  desert: { counts: false, heights: true, manifest: false, placements: false },
  forest: { counts: false, heights: false, manifest: false, placements: false },
  tundra: { counts: false, heights: false, manifest: false, placements: false },
};

/** What this bake writes today, so the example half of Phase 2 has a red/green pin to move. */
const PACKAGE: Record<
  World,
  { bytes: number; counts: Record<string, number>; manifest: string; placements: string }
> = {
  alpine: {
    bytes: 0,
    counts: {},
    manifest: "9f28336b10d6b4e2daee9bb07009846b4ef9d638373a24029f53aa8fefe18da9",
    placements: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  coastal: {
    bytes: 102400,
    counts: { spruce: 3200 },
    manifest: "23fbd737ea20eeee64d74fc3fba1d138837954603ce5834a780782d84133e1ff",
    placements: "309bbb4e56285cffbba107d549be8a6402db597c7eb74db0845b30fc718d996e",
  },
  desert: {
    bytes: 0,
    counts: {},
    manifest: "def551ecdd6d1f31c78df4a1361c1c1d8e76aaf49a2d93a56ea09e261bacf3ea",
    placements: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  forest: {
    bytes: 102400,
    counts: { spruce: 3200 },
    manifest: "25b297797cdd3f049f9dc14a39c34d3e5017a98567089b9244009340f2e3d38a",
    placements: "945c996d624ecc42b3e30dbb047614d799e6abd25e6971e2d9f9538fb80bd564",
  },
  tundra: {
    bytes: 1760,
    counts: { sapling: 55 },
    manifest: "3f94939440eb136d83fdc9332071e818c7c5fb922da7b71875020d263c6d78a5",
    placements: "af5e67958630d5fdf05f19ca83cf6e701c59a9dbe9fb0d172cc6768d66666226",
  },
};

/** One world as this spec measures it: the kit's ground, the file's rows and what the bake wrote. */
interface IRun {
  readonly baked: IBakedBiome;
  readonly counts: Record<string, number>;
  readonly ground: ITerrainState;
  /** The recipe's layer ids, in order, and the `at` of each water layer: the ground's own record. */
  readonly layers: readonly string[];
  readonly placements: string;
  readonly spec: IBiomeSpec;
  readonly water: readonly (readonly number[])[];
}

interface IRaw16 {
  readonly height: number;
  readonly max: number;
  readonly min: number;
  readonly raw16: string;
  readonly width: number;
  values?: number[];
}

const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Counts in the Phase 1 shape: one row per asset with an accepted placement, sorted by name. */
function countsOf(baked: IBakedBiome): Record<string, number> {
  return Object.fromEntries(
    baked.placements
      .filter((row) => row.count > 0)
      .map((row): [string, number] => [row.asset, row.count])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * The kit's ground plus the file's rows through the stages, baked. `edit` rewrites the foliage rows
 * first, so one stage can be tightened while the others keep the file's numbers.
 */
function place(
  ground: ITerrainState,
  spec: IBiomeSpec,
  edit?: (rows: readonly IFoliageType[]) => IFoliageType[],
): IBakedBiome {
  const rows = (edit ? edit(spec.foliage) : spec.foliage).filter((row) => row.density > 0);
  const assets: Record<string, IWorldPackageAsset> = Object.fromEntries(
    rows.map((row) => [
      row.species,
      {
        bounds: { max: [1, 1, 1], min: [-1, 0, -1] },
        glb: `models/${row.species}.glb`,
      } satisfies IWorldPackageAsset,
    ]),
  );
  // `finalizeState` re-runs the water flood and the scatter, so the rules reach the same stages
  // `terrain_generate` runs.
  const state = finalizeState({
    ...ground,
    scatterRules: foliageScatterRules(rows, ground.height),
  });
  return bakeBiome({ assets, spec, state });
}

function load(world: World): IRun {
  const dir = new URL(`../starter/${world}/`, import.meta.url);
  const { recipe } = JSON.parse(readFileSync(new URL("recipe.json", dir), "utf8")) as {
    recipe: {
      layers: {
        id: string;
        params?: { at?: number[]; data?: IRaw16 };
        type: string;
      }[];
    };
  };
  for (const layer of recipe.layers) {
    const data = layer.params?.data;
    if (data === undefined) continue;
    const raw = readFileSync(new URL(data.raw16, dir));
    data.values = Array.from(decodeRAW16(raw, data).values, (value) => Math.round(value * 10) / 10);
  }
  const spec = validateBiome(
    JSON.parse(readFileSync(new URL("biome.data.json", dir), "utf8")),
    world,
  );
  const ground = Terrain.fromJSON(recipe as never).evaluate();
  const baked = place(ground, spec);
  return {
    baked,
    counts: countsOf(baked),
    ground,
    layers: recipe.layers.map((layer) => layer.id),
    placements: sha(baked.files[baked.manifest.placements] ?? new Uint8Array()),
    spec,
    water: recipe.layers
      .filter((layer) => layer.type === "water")
      .map((layer) => layer.params?.at ?? []),
  };
}

const RUNS = new Map<World, IRun>();

beforeAll(() => {
  for (const world of WORLDS) RUNS.set(world, load(world));
});

const run = (world: World): IRun => {
  const loaded = RUNS.get(world);
  if (loaded === undefined) throw new Error(`${world} was not loaded`);
  return loaded;
};

describe("the biome files' bake against the Phase 1 table", () => {
  it("reproduces the three height digests it can, and every other line differs", () => {
    const matches = Object.fromEntries(
      WORLDS.map((world) => [
        world,
        {
          counts: same(run(world).counts, PHASE_1[world].counts),
          heights: hash(Array.from(run(world).ground.height)) === PHASE_1[world].heights,
          manifest: hash(run(world).baked.manifest) === PHASE_1[world].manifest,
          placements: run(world).placements === PHASE_1[world].placements,
        },
      ]),
    );
    expect(matches).toEqual(MATCHES);
  });

  it("pins what this bake writes, so a change to it fails here first", () => {
    const written = Object.fromEntries(
      WORLDS.map((world) => [
        world,
        {
          bytes: (run(world).baked.files[run(world).baked.manifest.placements] ?? new Uint8Array())
            .byteLength,
          counts: run(world).counts,
          manifest: hash(run(world).baked.manifest),
          placements: run(world).placements,
        },
      ]),
    );
    expect(written).toEqual(PACKAGE);
  });

  it("names why the height digests of forest and tundra differ", () => {
    // Forest: the kit recipe carries no `access-road` and no `building-pad` layer, so Phase 1's road
    // cut and pad flatten are absent. Its `surfaces` rules differ too, with no height effect.
    expect(run("forest").layers).not.toContain("access-road");
    expect(run("forest").layers).not.toContain("building-pad");
    // Tundra: the kit's two kettle beds and two lakes stand at [24, -120] and [-96, 24]. Phase 1's
    // tundra floods the near kettle at [65, 80] (28.8 m) and the far one at [-65, -50] (30 m).
    expect(run("tundra").water).toEqual([
      [24, -120],
      [-96, 24],
    ]);
  });

  it("names why the counts differ: the rows are the file's, and Phase 1's scatter is the game's", () => {
    // Phase 1 counted 12 species in the forest; the file carries one tree row. The grass rows are an
    // `IGrassType` (a 0..1 share over a spacing grid), so these stages place no ground cover.
    expect(Object.keys(PHASE_1.forest.counts)).toHaveLength(12);
    expect(run("forest").counts).toEqual({ spruce: 3200 });
    // The one shared number disagrees: 3 200 is `surfaceSample`'s count, and the game's rule accepted
    // 3 131 of its 3 200 cap after the stand field, masks and clearings.
    expect(PHASE_1.forest.counts.spruce).toBe(3131);
    // The file's spacing is a range; these stages read its tight end as `selfPrune`'s distance, while
    // the game's rule follows the stand field across the whole range.
    expect(run("forest").spec.foliage[0]?.spacing).toEqual([3.2, 6.4]);
  });

  it("runs the four stages, one field of a row at a time", () => {
    const { ground, spec } = run("forest");
    const row = spec.foliage[0];
    if (row === undefined) throw new Error("forest has no foliage row");
    const counted = (edit: Partial<IFoliageType>): number =>
      Object.values(
        countsOf(place(ground, spec, (rows) => rows.map((one) => ({ ...one, ...edit })))),
      ).reduce((sum, count) => sum + count, 0);
    // surfaceSample: the row's count is how many candidates the rule asks for.
    expect(counted({ density: 5 })).toBe(5);
    // densityFilter: a height band above every sample rejects every candidate.
    expect(counted({ height: [10_000, 10_001] })).toBe(0);
    // selfPrune: a spacing wider than the world keeps one.
    expect(counted({ spacing: [1000, 1000] })).toBe(1);
    // meshSpawn: the accepted candidates carry the row's own asset, eight float32 values each.
    expect(run("forest").baked.placements).toEqual([{ asset: "spruce", count: 3200 }]);
    expect(run("forest").baked.files[run("forest").baked.manifest.placements]?.byteLength).toBe(
      3200 * 8 * 4,
    );
  });
});
