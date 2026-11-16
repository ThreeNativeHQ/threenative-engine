/**
 * PRD-792 phase 2: the package's bake against the Phase 1 digests.
 *
 * Phase 1 pinned today's five Strata worlds in the example's `bake-golden.spec.ts`: per world a
 * placement-table digest, the accepted count per species, a height digest and a world-manifest
 * digest, plus the continuation ring. This spec runs each of the five biome files
 * (`starter/<biome>/biome.data.json`) through the package and compares the result, digest for digest.
 *
 * A file that says `"stream": "ordered"` runs the package's ordered scatter — the game's fifteen
 * generators, one draw stream, one fixed order, copied into `scatter-ordered.ts` line for line. That
 * stream emits the game's own instances, so the counts and the placement sequence are the Phase 1
 * ones; the package writes no cell container for it because the game still writes its own table
 * (`bake.mjs`, box 3), and a different container cannot share a sha256.
 *
 * A file that says `"stream": "seeded"` runs the four named stages instead: `foliageScatterRules`
 * turns a foliage row into one `IScatterRule`, `Terrain.evaluate()`'s scatter runs that rule through
 * `surfaceSample`, `densityFilter`, `selfPrune` and `meshSpawn`, and `bakeBiome` writes the cell runs.
 * That path is the package's own sampler, and the last test here pins what its four fields do.
 *
 * The package tests may not import example source (`example-imports.spec.ts`), so `PHASE_1` and
 * `PHASE_1_CANONICAL` below are verbatim copies of the Phase 1 measurements. Change them only from a
 * fresh Phase 1 measurement.
 *
 * The table has no `horizon` line: the continuation ring is five further terrains, not a biome, and
 * `bakeBiome` writes no continuation.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { type IBakedBiome, bakeBiome, foliageScatterRules } from "../src/biome/bake-biome.js";
import {
  type IBiomeSpec,
  type IFoliageType,
  type IUnderstoreySpec,
  validateBiome,
} from "../src/biome/biome.js";
import { decodeRAW16 } from "../src/core/io.js";
import { finalizeState } from "../src/core/operations.js";
import { Terrain } from "../src/core/terrain.js";
import type { IPlacement, ITerrainState } from "../src/core/types.js";
import type { IWorldPackageAsset } from "../src/package/world-package.js";

const WORLDS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;
type World = (typeof WORLDS)[number];

/**
 * The Phase 1 table, copied from the example spec. Since 2026-11-15 the forest and tundra rows omit
 * the solid props inside the 4 m spawn clearing (forest 3 boulders, 1 bush, 4 saplings, 1 spruce;
 * tundra 6 bushes); every other placement is unchanged.
 */
const PHASE_1: Record<
  World,
  { heights: string; manifest: string; placements: string; counts: Record<string, number> }
> = {
  forest: {
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
    placements: "d108ef0946632404625e7cd82ec56f0cf22641140d0f627ce782b27476b47c0e",
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
    counts: { boulder: 2028, bush: 588, grass: 30490, riverrock: 612, sapling: 55, scrub: 6680 },
    heights: "dc182307fa2789f7297d53e96c77720b7fac97119489f725d8ebbb44e1d60533",
    manifest: "72c72e6f86b2a800aeae246b4800390b6c57fe6b95dc87510193549f9106c943",
    placements: "2c0123035d9a528128da5053880256b56c9a6003002a25441394dcd4631d4867",
  },
};

/**
 * The Phase 1 placement sequence, as one digest both sides can compute.
 *
 * The example's `placements.bin` is its own container — a JSON header, per-asset runs, an order-index
 * table and the canopy floats — so its sha256 above can never match a package's cell file. The
 * sequence inside it can: every instance's asset, id, layer, alignment and pose, with each number
 * rounded to the float32 the container stores, serialized in draw order. This table was measured on
 * `5afb42b1c` from the game's own `scatterProps` output, which is the list the committed
 * `placements.bin` was encoded from.
 */
const PHASE_1_CANONICAL: Record<World, string> = {
  forest: "f9ec1259f6e14aa51fc24f86d40df980c1e856a3335fa30236dc16ab8d0694c1",
  coastal: "5ca73a9acf36f84c536e70b5fe86fd51f88554d871a453eb024d5dc34d304d4e",
  alpine: "10c755d4856a51fabe05f38fe59d9550bc5236edd4a1cb11e1f7f6ced1c9e7f8",
  desert: "fa52459ddcda51b336764219ce033add8ccd90f3fd299cd95d43878cf38813b3",
  tundra: "16c97133058d9ab0b9585a62befbf859313c55d6f6d1dc13d55033e5fc76a04f",
};

/** Which Phase 1 line the ordered bake reproduces today, and which it cannot. */
const MATCHES: Record<World, Record<"counts" | "heights", boolean>> = {
  alpine: { counts: true, heights: true },
  coastal: { counts: true, heights: true },
  desert: { counts: true, heights: true },
  forest: { counts: true, heights: true },
  tundra: { counts: true, heights: true },
};

/** One world as this spec measures it: the kit's ground, the file's rows and what the bake made. */
interface IRun {
  readonly baked: IBakedBiome;
  readonly canonical: string | null;
  readonly counts: Record<string, number>;
  readonly ground: ITerrainState;
  /** The recipe's layer ids, in order, and the `at` of each water layer: the ground's own record. */
  readonly layers: readonly string[];
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
const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** The float32 the game's container stores, so both sides compare the same numbers. */
const f32 = (value: number): number => Math.fround(value);

/**
 * The placement sequence as one digest: every instance in draw order, each number as its float32.
 * The same rows, in the same order, give the same digest on both sides of the container.
 */
function canonical(placements: readonly IPlacement[]): string {
  const rows = placements.map((placement) => [
    placement.asset,
    placement.id,
    placement.layer,
    placement.alignToNormal,
    ...placement.position.map(f32),
    f32(placement.rotation),
    f32(placement.scale),
    ...placement.normal.map(f32),
  ]);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

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
 * The kit's ground plus the file's rows, baked. `edit` rewrites the foliage rows first, so one stage
 * can be tightened while the others keep the file's numbers, and `stream` overrides the file's own.
 *
 * The ordered stream places the game's species, which this spec holds no asset table for, so it hands
 * the instances back and writes no container. The seeded stages place the row's species, so they are
 * baked with an asset per row and write the package the container digest is taken from.
 */
function place(
  ground: ITerrainState,
  spec: IBiomeSpec,
  edit?: (rows: readonly IFoliageType[]) => IFoliageType[],
  stream?: "ordered" | "seeded",
): IBakedBiome {
  const rows = (edit ? edit(spec.foliage) : spec.foliage).filter((row) => row.density > 0);
  // `finalizeState` re-runs the water flood and the scatter, so the rules reach the same stages
  // `terrain_generate` runs.
  const state = finalizeState({
    ...ground,
    scatterRules: foliageScatterRules(rows, ground.height),
  });
  if ((stream ?? spec.stream) === "ordered") return bakeBiome({ spec, state });
  const assets: Record<string, IWorldPackageAsset> = Object.fromEntries(
    rows.map((row) => [
      row.species,
      {
        bounds: { max: [1, 1, 1], min: [-1, 0, -1] },
        glb: `models/${row.species}.glb`,
      } satisfies IWorldPackageAsset,
    ]),
  );
  return bakeBiome({ assets, spec, state, stream: "seeded" });
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
    canonical: baked.scatter === null ? null : canonical(baked.scatter.placements),
    counts: countsOf(baked),
    ground,
    layers: recipe.layers.map((layer) => layer.id),
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
  it("reproduces every Phase 1 species count, exactly", () => {
    // The strict equality: not "how many agree" but "every species, every world, the same number".
    // A row that cannot carry a count is a row whose generator this package does not run.
    for (const world of WORLDS) expect(run(world).counts, world).toEqual(PHASE_1[world].counts);
  });

  it("reproduces the Phase 1 placement sequence, instance for instance", () => {
    // The counts can agree while the placements do not: one extra rejected candidate moves every
    // later draw. The digest covers every instance's asset, identity and pose in draw order.
    for (const world of WORLDS) expect(run(world).canonical, world).toBe(PHASE_1_CANONICAL[world]);
  });

  it("reproduces every Phase 1 height digest, and the counts with it", () => {
    const matches = Object.fromEntries(
      WORLDS.map((world) => [
        world,
        {
          counts: same(run(world).counts, PHASE_1[world].counts),
          heights: hash(Array.from(run(world).ground.height)) === PHASE_1[world].heights,
        },
      ]),
    );
    expect(matches).toEqual(MATCHES);
  });

  it("names why the container digests cannot match: the game's table is not the package's", () => {
    // `placements.bin` is a JSON header, per-asset runs, an order-index table and canopy floats;
    // `world.json` is the game's surface manifest. A package cell file and its manifest are a
    // different schema, so those two Phase 1 digests stay the example's own (box 3 pins them there).
    for (const world of WORLDS) expect(run(world).baked.package, world).toBeNull();
    // The seeded stages do write a package, and the four fields of a row drive them.
    const seeded = place(run("forest").ground, run("forest").spec, undefined, "seeded");
    expect(seeded.package).not.toBeNull();
    expect(seeded.scatter).toBeNull();
  });

  it("closes the last two height digests with the layers and the kettles Phase 1 graded", () => {
    // Forest: Phase 1 grades an access road and flattens a building pad, which the file did not carry.
    expect(run("forest").layers).toContain("access-road");
    expect(run("forest").layers).toContain("building-pad");
    // Tundra: Phase 1 floods the near kettle at [65, 80] (28.8 m) and the far one at [-65, -50] (30 m).
    expect(run("tundra").water).toEqual([
      [65, 80],
      [-65, -50],
    ]);
  });

  it("runs the four stages, one field of a row at a time", () => {
    const { ground, spec } = run("forest");
    const row = spec.foliage[0];
    if (row === undefined) throw new Error("forest has no foliage row");
    const counted = (edit: Partial<IFoliageType>): number =>
      Object.values(
        countsOf(place(ground, spec, (rows) => rows.map((one) => ({ ...one, ...edit })), "seeded")),
      ).reduce((sum, count) => sum + count, 0);
    // surfaceSample: the row's count is how many candidates the rule asks for.
    expect(counted({ density: 5 })).toBe(5);
    // densityFilter: a height band above every sample rejects every candidate.
    expect(counted({ height: [10_000, 10_001] })).toBe(0);
    // selfPrune: a spacing wider than the world keeps one.
    expect(counted({ spacing: [1000, 1000] })).toBe(1);
    // meshSpawn: the accepted candidates carry the row's own asset, eight float32 values each.
    const forest = place(ground, spec, undefined, "seeded");
    const pkg = forest.package;
    if (pkg === null) throw new Error("the seeded bake wrote no package");
    expect(forest.placements).toEqual([{ asset: "spruce", count: 7000 }]);
    expect(pkg.files[pkg.manifest.placements]?.byteLength).toBe(7000 * 8 * 4);
  });

  it("grows the understorey from the wood's own row", () => {
    // The layer under the canopy is data, not code: the file's own numbers give the Phase 1 counts,
    // twice the bracken thickens the ferns, and a budget of no candidates plants no needle litter.
    const { ground, spec } = run("forest");
    const scattered = (understorey: Partial<IUnderstoreySpec>): Record<string, number> =>
      Object.fromEntries(
        bakeBiome({
          spec: {
            ...spec,
            cover: { ...spec.cover, understorey: { ...spec.cover.understorey, ...understorey } },
          },
          state: ground,
        }).placements.map((placed) => [placed.asset, placed.count]),
      );
    const plain = scattered({});
    expect(plain).toMatchObject(PHASE_1.forest.counts);
    expect(scattered({ fern: spec.cover.understorey.fern * 2 }).fern ?? 0).toBeGreaterThan(
      plain.fern ?? 0,
    );
    expect(scattered({ attempts: 0 }).litter).toBe(0);
    // A crown thins the grass under it: full shade over four metres drops blades, and the trees
    // that cast it do not move.
    const shaded = scattered({ shade: 1, shadeRadius: 4 });
    expect(shaded.grass ?? 0).toBeLessThan(plain.grass ?? 0);
    expect(shaded.spruce).toBe(plain.spruce);
  });

  it("moves no tree and no rock when the understorey thickens or the crowns shade", () => {
    // The understorey and the shade draw from streams of their own: a row that grows more ferns
    // changes the ferns, and every layer placed after them keeps its exact pose.
    const { ground, spec } = run("forest");
    const graded = {
      attempts: 14_000,
      litter: 1,
      fern: 1,
      bush: 1,
      flower: 1,
      deadfall: 0,
      shade: 0,
      shadeRadius: 3,
    };
    const placed = (understorey: IUnderstoreySpec) =>
      bakeBiome({
        spec: { ...spec, cover: { ...spec.cover, understorey } },
        state: ground,
      }).scatter?.placements ?? [];
    const plain = placed(graded);
    const thick = placed({ ...graded, attempts: 60_000, fern: 2, shade: 0.5, deadfall: 3 });
    const poses = (list: typeof plain, asset: string) =>
      list
        .filter((one) => one.asset === asset)
        .map((one) => [one.position, one.rotation, one.scale]);
    for (const asset of ["spruce", "sapling", "boulder", "riverrock"]) {
      expect(poses(plain, asset).length).toBeGreaterThan(0);
      expect(poses(thick, asset)).toEqual(poses(plain, asset));
    }
    expect(poses(thick, "fern").length).toBeGreaterThan(poses(plain, "fern").length);
    expect(poses(thick, "grass").length).toBeLessThan(poses(plain, "grass").length);
    // A row that grows fallen wood lays logs under its closed stands, and the graded row grows none.
    expect(poses(thick, "deadfall").length).toBeGreaterThan(0);
    expect(poses(plain, "deadfall").length).toBe(0);
  });
});
