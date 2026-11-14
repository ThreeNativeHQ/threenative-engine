import type { IBiomeSpec, IFoliageType } from "../biome/biome.js";
import type { TerrainKit } from "../biome/kits.js";
import { EU_DEM, type ISurveyRow, TILES, USGS_3DEP } from "../ground/surveys.js";

/**
 * The regions a request may name: a row per ecoregion, holding the real ground it stands on and the
 * plant community that grows there.
 *
 * A region is data, like the other request tables: the parser resolves a word to a row, and the row
 * fills arguments a caller could pass by hand — a survey site for `ground`, a starter for the
 * surface, and `IBiomeSpec` overrides for the canopy (the object `terrain_biome_new` takes). A
 * request with no region word keeps the starter as shipped, and a tree word alone still swaps the
 * kit's one tree, so the quick path stays quick.
 *
 * Each site is a few kilometres of that region, and its comment records the decoded range of that
 * crop and of the world's own 512 m patch inside it, both measured with `isForestFloor`
 * (`ground/ground.ts`): a site whose floor is not a forest floor is replaced, as `SURVEYS` rows are.
 * `terrain-survey.spec.ts` decodes every row from a checked-in tile, so the range is checked, not a
 * claim.
 */
export interface IEcoregionRow {
  /** The row's name, reported as `decided.region` and as the cooked world's biome. */
  readonly id: string;
  /** The request words that select it; a word with a space is matched as a phrase. */
  readonly words: readonly string[];
  /** The starter whose surface, ground cover and assets suit the region. */
  readonly kit: TerrainKit;
  /** The real place the world is cut from: its crop, its source and its attribution. */
  readonly site: ISurveyRow;
  /**
   * The kit's own canopy, by asset id: a region's rows are that region's stand, so the kit's authored
   * tree scatter is replaced by them. Its understorey, stones, road and water stay.
   */
  readonly canopy: readonly string[];
  /** `IBiomeSpec` fields the region replaces on the kit's file: here, the canopy's species rows. */
  readonly overrides: IBiomeOverrides;
}

/** The `IBiomeSpec` fields a region may replace: the same overrides `terrain_biome_new` applies. */
export type IBiomeOverrides = { readonly [K in keyof IBiomeSpec]?: IBiomeSpec[K] };

/**
 * The far field every region's trees share, in the forest kit's own numbers: a region borrows the
 * kit's surface, so its stand fades out over the same distance and slopes.
 */
const FAR = {
  cell: 6,
  spacing: [6.5, 13],
  spacingAt: [150, 1500],
  slope: [36, 46],
  meadowSlope: [12, 24],
  reach: 2300,
  treelineJitter: 30,
  stand: [0.26, 0.4],
  impostor: 110,
} as const;

/**
 * One canopy species of a region: an `arbor:<preset>@<seed>` id, its own count and spacing, and a
 * far-field seed of its own. Two rows per species give a stand two tree shapes instead of one cloned
 * one, which is what `arbor:<preset>@<seed>` names.
 */
function canopyRow(species: string, density: number, farSeed: number): IFoliageType {
  return {
    species,
    density,
    slope: [0, 32],
    height: null,
    spacing: [3.6, 6.4],
    collision: "trunk",
    stands: true,
    grassThreshold: 0.3,
    standThreshold: 0.16,
    far: { ...FAR, seed: farSeed },
  };
}

/**
 * The regions, in table order: a request that names two cooks the first.
 *
 * A row's canopy names only presets `vegetationPresets()` returns; `arbor-species.spec.ts` checks
 * every one, and that the merged biome validates, so a misspelt species fails there and not at a
 * cook.
 */
export const ECOREGION_ROWS: readonly IEcoregionRow[] = [
  {
    id: "european-broadleaf",
    // "beech" alone stays a tree word (`TREE_WORD_ROWS`): only a region word selects this row.
    words: ["european", "europe"],
    kit: "forest",
    site: {
      name: "Hainich National Park, Thuringia, Germany",
      lat: 51.0833,
      lon: 10.4667,
      extentMeters: 3_000,
      zoom: 12,
      attribution: `${EU_DEM} ${TILES}`,
      // measured: 309..496 m over its 3 km, and 403..438 m at the world's own 512 m (a beech wood's
      // floor: 5.6 and 4.5 degrees at the 90th percentile, no hydro-flattened water)
    },
    canopy: ["fir", "fir-c"],
    overrides: {
      // The European beech forest's own mix: beech dominant, sessile oak and silver birch among it,
      // each at two seeds so no two trees of a species are the same bake.
      foliage: [
        canopyRow("arbor:beech@11", 900, 466611),
        canopyRow("arbor:beech@12", 900, 466612),
        canopyRow("arbor:oak@13", 650, 466613),
        canopyRow("arbor:oak@14", 650, 466614),
        canopyRow("arbor:birch@15", 450, 466615),
        canopyRow("arbor:birch@16", 450, 466616),
      ],
    },
  },
  {
    id: "boreal",
    words: ["boreal", "taiga", "nordic", "scandinavian"],
    kit: "forest",
    site: {
      name: "Oulanka National Park, Kuusamo, Finland",
      lat: 66.3667,
      lon: 29.3167,
      extentMeters: 3_000,
      zoom: 12,
      attribution: `${EU_DEM} ${TILES}`,
      // measured: 158..342 m over its 3 km, and 175..226 m at 512 m (a spruce stand on a river's
      // bank: 12.1 and 23.6 degrees at the 90th percentile)
    },
    canopy: ["fir", "fir-c"],
    overrides: {
      // The boreal mix of the kit's own stand: Norway spruce with downy birch and aspen, two bakes each.
      foliage: [
        canopyRow("arbor:spruce@21", 1000, 466621),
        canopyRow("arbor:spruce@22", 1000, 466622),
        canopyRow("arbor:birch@23", 600, 466623),
        canopyRow("arbor:birch@24", 600, 466624),
        canopyRow("arbor:aspen@25", 400, 466625),
        canopyRow("arbor:aspen@26", 400, 466626),
      ],
    },
  },
  {
    id: "mediterranean",
    words: ["mediterranean", "tuscan"],
    kit: "desert",
    site: {
      name: "Val d'Orcia, Tuscany, Italy",
      lat: 43.0667,
      lon: 11.6167,
      extentMeters: 3_000,
      zoom: 12,
      attribution: `${EU_DEM} ${TILES}`,
      // measured: 283..434 m over its 3 km, and 334..401 m at 512 m (a clay hillside with its olive
      // and cypress: 10.2 and 12.4 degrees at the 90th percentile)
    },
    // The desert kit ships no tree art of its own, so there is no authored canopy to replace.
    canopy: [],
    overrides: {
      // The Mediterranean hill's own three: olive, Italian cypress and downy oak, two bakes each.
      foliage: [
        canopyRow("arbor:olive@31", 500, 466631),
        canopyRow("arbor:olive@32", 500, 466632),
        canopyRow("arbor:cypress@33", 350, 466633),
        canopyRow("arbor:cypress@34", 350, 466634),
        canopyRow("arbor:oak@35", 300, 466635),
        canopyRow("arbor:oak@36", 300, 466636),
      ],
    },
  },
  {
    id: "pacific-northwest",
    // Two words, matched as the phrase a request writes them in; "pacific" and "northwest" alone
    // name nothing, so "a pacific island" stays the coastal world it is.
    words: ["pacific northwest", "cascadia"],
    kit: "forest",
    site: {
      name: "Humptulips valley, Olympic National Forest, Washington",
      lat: 47.2,
      lon: -123.9,
      extentMeters: 3_000,
      zoom: 12,
      attribution: `${USGS_3DEP} ${TILES}`,
      // measured: 45..221 m over its 3 km, and 84..163 m at 512 m (a Douglas-fir valley floor: 24.1
      // and 26.7 degrees at the 90th percentile, under the 28 the floor accepts)
    },
    canopy: ["fir", "fir-c"],
    overrides: {
      // The coastal rainforest's own three: Douglas-fir, western redcedar and bigleaf maple.
      foliage: [
        canopyRow("arbor:douglasfir@41", 900, 466641),
        canopyRow("arbor:douglasfir@42", 900, 466642),
        canopyRow("arbor:redcedar@43", 550, 466643),
        canopyRow("arbor:redcedar@44", 550, 466644),
        canopyRow("arbor:bigleafmaple@45", 350, 466645),
        canopyRow("arbor:bigleafmaple@46", 350, 466646),
      ],
    },
  },
];

/**
 * Every word the rows answer to, a phrase split into the words a request is written with: what the
 * tool reports as read, so "pacific northwest" never comes back as two words nothing answered to.
 */
export const ECOREGION_WORDS: readonly string[] = ECOREGION_ROWS.flatMap((row) =>
  row.words.flatMap((word) => word.split(" ")),
);
