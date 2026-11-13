import { BIOME_WORD_ROWS } from "./biome-words.js";
import type { IBiomeWaterBody } from "./biome.js";
import type { TerrainKit } from "./kits.js";
import type { LandformKind } from "./presets.js";

/**
 * The words a request may use beyond the biome's own: the landform it asks for, the water it asks
 * for and the size it asks for. One row per choice, read in table order, so a request naming two
 * shapes of the same kind always cooks the same one.
 *
 * The tables are data, never branches: a word added here is a word the tool answers to, and
 * `terrain-mcp.spec.ts` has a case per row.
 */
export const LANDFORM_WORD_ROWS: readonly (readonly [LandformKind, readonly string[]])[] = [
  // First: a volcano is the more specific shape, so "a volcanic island" is a volcano in the sea.
  ["volcanic", ["volcano", "volcanoes", "volcanic"]],
  ["alpine", ["alpine", "alps", "mountain", "mountains", "peaks"]],
  ["temperateMountains", ["foothills", "valley", "valleys"]],
  ["rollingHills", ["hill", "hills", "rolling"]],
  ["desertMesa", ["butte", "buttes", "canyon", "canyons", "mesa", "mesas"]],
  [
    "coastalCliffs",
    ["cliff", "cliffs", "coast", "coastal", "fjord", "fjords", "island", "islands"],
  ],
  ["tundra", ["arctic", "tundra"]],
];

/**
 * The water body a word asks for. Each row carries the measurement the cooked world needs, and the
 * numbers are the shipped starters' own: the forest's river ribbon and lake radius, the coastal
 * starter's sea level (`starter/<kit>/biome.data.json`), so a word floods what a starter does.
 */
export const WATER_WORD_ROWS: readonly (readonly [IBiomeWaterBody, readonly string[]])[] = [
  [{ kind: "river", width: 5.32 }, ["creek", "creeks", "river", "rivers", "stream", "streams"]],
  [{ kind: "lake", radius: 105 }, ["lake", "lakes", "pond", "ponds"]],
  [
    { kind: "ocean", level: 1.5 },
    ["fjord", "fjords", "island", "islands", "ocean", "oceans", "sea", "seas"],
  ],
];

/**
 * The starter whose surface and assets suit a landform, for a request that names a shape but no
 * biome: "rolling hills" grow the forest's grass and trees, "a canyon" the desert's sand and rock.
 */
export const LANDFORM_BIOME: Readonly<Record<LandformKind, TerrainKit>> = {
  alpine: "alpine",
  temperateMountains: "forest",
  rollingHills: "forest",
  desertMesa: "desert",
  coastalCliffs: "coastal",
  tundra: "tundra",
  volcanic: "alpine",
};

/**
 * The tree a request word asks for: an Arbor preset id (`@threenative/procedural-vegetation`) and
 * the words that name it. A request that names one cooks that species in place of the kit's own
 * tree, as `arbor:<id>`. A word a biome already answers to ("spruce", "pine", "fir") keeps its
 * meaning, the kit's own conifer, so a starter's request still cooks that starter as shipped.
 * Each id is checked against `vegetationPresets()` in `arbor-species.spec.ts`.
 */
export const TREE_WORD_ROWS: readonly (readonly [string, readonly string[]])[] = [
  ["oak", ["oak", "oaks"]],
  ["beech", ["beech"]],
  ["birch", ["birch", "birches"]],
  ["aspen", ["aspen", "aspens"]],
  ["redcedar", ["cedar", "cedars"]],
  ["bigleafmaple", ["maple", "maples"]],
  ["cypress", ["cypress", "cypresses"]],
  ["olive", ["olive", "olives"]],
  ["acacia", ["acacia", "acacias"]],
  ["baobab", ["baobab", "baobabs"]],
  ["coconut", ["coconut", "palm", "palms"]],
  ["banana", ["banana", "bananas"]],
  ["sakura", ["sakura", "cherry", "blossom"]],
  ["ginkgo", ["ginkgo"]],
  ["bamboo", ["bamboo"]],
  ["saguaro", ["saguaro", "cactus", "cacti"]],
  ["joshua", ["joshua"]],
  ["jacaranda", ["jacaranda"]],
];

/** The starter a request with no biome, landform or sea word cooks: the forest, reported as such. */
export const DEFAULT_BIOME: TerrainKit = "forest";

/** A shape a word carves into whatever ground the world stands on, preset, survey or starter crop. */
export type TerrainFeature = "canyon" | "fjord";

/**
 * The words that carve a feature. A landform word only picks a preset, and a preset that is the
 * kit's own keeps the kit's ground, so "a desert canyon" needs its cut made explicitly.
 */
export const FEATURE_WORD_ROWS: readonly (readonly [TerrainFeature, readonly string[]])[] = [
  ["canyon", ["canyon", "canyons", "gorge", "gorges", "ravine", "ravines"]],
  ["fjord", ["fjord", "fjords", "inlet", "inlets"]],
];

/** How a size word scales the biome's own `sizeMeters`: "huge" doubles 512 m, "small" halves it. */
export const SIZE_WORD_ROWS: readonly (readonly [number, readonly string[]])[] = [
  [2, ["big", "huge", "large"]],
  [0.5, ["small", "tiny"]],
];

/** One starter's own declaration: the ground it authors, the size it spans, the water it floods. */
export interface IBiomeOwn {
  readonly landform: LandformKind;
  readonly sizeMeters: number;
  readonly water: readonly IBiomeWaterBody[];
}

/**
 * Each starter's own landform, size and water, mirrored here because the tool's request parser is
 * synchronous and the files are read at bake time, not at parse time.
 *
 * A word that names what its biome already declares changes nothing: the starter's authored ground
 * stays the ground, and the water it floods stays what it floods. A size word scales `sizeMeters`,
 * so "huge" is 1 024 m of the 512 m every starter ships.
 *
 * The file stays the owner: `terrain-mcp.spec.ts` fails if a row stops matching its starter, so a
 * starter that changes its ground, size or water reaches the words only through this list.
 */
export const BIOME_OWN: Readonly<Record<TerrainKit, IBiomeOwn>> = {
  alpine: { landform: "alpine", sizeMeters: 512, water: [] },
  coastal: { landform: "coastalCliffs", sizeMeters: 512, water: [{ kind: "ocean", level: 1.5 }] },
  desert: { landform: "desertMesa", sizeMeters: 512, water: [] },
  forest: {
    landform: "temperateMountains",
    sizeMeters: 512,
    water: [
      { kind: "river", width: 5.32 },
      { kind: "lake", radius: 105 },
    ],
  },
  tundra: {
    landform: "tundra",
    sizeMeters: 512,
    water: [
      { kind: "river", width: 5.32 },
      { kind: "river", width: 3.04 },
      { kind: "lake", radius: 34 },
      { kind: "lake", radius: 46 },
    ],
  },
};

/** Scaffolding a request is written with: a word here names no row, and is never reported unused. */
export const REQUEST_STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "create",
  "for",
  "game",
  "in",
  "like",
  "make",
  "me",
  "of",
  "on",
  "some",
  "terrain",
  "the",
  "with",
  "world",
]);

/** Every word any row answers to: a request word in this set named a choice, whatever won. */
/**
 * A landform word after one of these names the mountains past the square, not the ground: "a spruce
 * forest under mountains" stands on the forest's own ground with a massif of that range behind it.
 */
export const BACKDROP_WORDS: readonly string[] = [
  "under",
  "below",
  "beneath",
  "behind",
  "among",
  "beside",
];

export const REQUEST_KNOWN_WORDS: ReadonlySet<string> = new Set([
  ...[
    ...BIOME_WORD_ROWS,
    ...LANDFORM_WORD_ROWS,
    ...WATER_WORD_ROWS,
    ...SIZE_WORD_ROWS,
    ...FEATURE_WORD_ROWS,
    ...TREE_WORD_ROWS,
  ].flatMap(([, names]) => names),
  ...BACKDROP_WORDS,
]);
