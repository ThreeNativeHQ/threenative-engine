import type { LandformKind } from "./presets.js";

/**
 * One real place a landform is measured from: a square ground footprint cut out of the AWS terrain
 * tiles. Shape only, like the presets themselves: nothing here names a material or a colour.
 *
 * A row's `lat`/`lon`/`extentMeters`/`zoom` are what the cook fetches, so a row is a reproducible
 * crop, not a hint. The measured range in each comment is the decoded metres of that crop (see
 * `mcp/survey.ts`), which is what `pnpm exec vitest run packages/terrain/__tests__/terrain-survey.spec.ts`
 * checks the decoder against.
 */
export interface ISurveyRow {
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  /** Ground footprint the survey covers, metres: a square centred on `lat`/`lon`. */
  readonly extentMeters: number;
  /** Terrarium zoom: 12 is about 30 m per pixel, which a few kilometres of ground reads at. */
  readonly zoom: number;
  /** The data source's own attribution text, as `tilezen/joerd` requires it. */
  readonly attribution: string;
}

/** Where every survey comes from, at every zoom: one tile set, one credit. */
const TILES = "AWS Terrain Tiles (github.com/tilezen/joerd, Mapzen terrain tiles).";

// The per-source statements `tilezen/joerd` asks for, verbatim (docs/attribution.md).
const USGS_3DEP =
  "United States 3DEP (formerly NED) terrain data courtesy of the U.S. Geological Survey.";
const EU_DEM =
  "Produced using Copernicus data and information funded by the European Union - EU-DEM layers.";
const SRTM = "SRTM data courtesy of the U.S. Geological Survey.";

/**
 * The landform's own survey. Each row's source is the one the tile set actually composites there
 * (the `X-Imagery-Sources` header of its tiles): 3DEP/NED in the United States, EU-DEM in Europe
 * and SRTM elsewhere.
 */
export const SURVEYS: Readonly<Record<LandformKind, ISurveyRow>> = {
  alpine: {
    name: "Matterhorn massif, Pennine Alps (Switzerland / Italy)",
    lat: 45.9763,
    lon: 7.6586,
    extentMeters: 6_000,
    zoom: 12,
    attribution: `${EU_DEM} ${TILES}`,
    // measured: 2 168..4 352 m (the summit is 4 478 m, at about 30 m per pixel)
  },
  temperateMountains: {
    name: "Sprague Lake and Glacier Creek, Rocky Mountain National Park, Colorado",
    lat: 40.32,
    lon: -105.6067,
    extentMeters: 6_000,
    zoom: 12,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 2 387..3 434 m
  },
  rollingHills: {
    name: "Coon Valley, Driftless Area, Wisconsin",
    lat: 43.7019,
    lon: -91.0139,
    extentMeters: 6_000,
    zoom: 12,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 209..391 m: 3 % relief over its 6 km, which is the preset's own 0.03 ratio
  },
  desertMesa: {
    name: "Monument Valley, Arizona / Utah",
    lat: 36.998,
    lon: -110.0985,
    extentMeters: 5_000,
    zoom: 12,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 1 542..1 972 m (the valley floor to the butte tops)
  },
  coastalCliffs: {
    name: "Étretat chalk cliffs, Normandy, France",
    lat: 49.707,
    lon: 0.203,
    extentMeters: 4_000,
    zoom: 12,
    attribution: `${EU_DEM} ${TILES}`,
    // measured: -9..112 m (the sea to the cliff top)
  },
  tundra: {
    name: "Trail Ridge, Rocky Mountain National Park, Colorado",
    lat: 40.4103,
    lon: -105.735,
    extentMeters: 5_000,
    zoom: 12,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 2 956..3 797 m, above the tree line
  },
  volcanic: {
    name: "Mount Fuji, Honshu, Japan",
    lat: 35.3606,
    lon: 138.7274,
    extentMeters: 6_000,
    zoom: 12,
    attribution: `${SRTM} ${TILES}`,
    // measured: 1 548..3 753 m (the summit is 3 776 m)
  },
};

/**
 * Whole mountains a cooked world's far ring stands behind it (PRD-866), keyed by the landform whose
 * ring they rise from and drawn from its own kind of range: a Front Range peak behind Rocky Mountain
 * ground, sharp alpine peaks behind the alpine survey. Each row is cut foot to foot, its border
 * valley floor or a col, so the lifted mountain has no cliff at its edge; the cook's seed picks one.
 * Zoom 12 keeps their main ridges, which is all a ring past the playable square shows.
 */
export const MASSIFS: Readonly<Partial<Record<LandformKind, readonly ISurveyRow[]>>> = {
  temperateMountains: [
    {
      name: "Longs Peak and Mount Meeker, Rocky Mountain National Park, Colorado",
      lat: 40.2549,
      lon: -105.6101,
      extentMeters: 4_400,
      zoom: 12,
      attribution: `${USGS_3DEP} ${TILES}`,
    },
  ],
  alpine: [
    {
      name: "Grand Teton and the Cathedral Group, Wyoming",
      lat: 43.7455,
      lon: -110.8024,
      extentMeters: 3_600,
      zoom: 12,
      attribution: `${USGS_3DEP} ${TILES}`,
    },
    {
      name: "Maroon Bells, Elk Mountains, Colorado",
      lat: 39.0708,
      lon: -106.989,
      extentMeters: 3_600,
      zoom: 12,
      attribution: `${USGS_3DEP} ${TILES}`,
    },
  ],
};

/** How much ground a bare `{ location }` covers, and how finely: the survey rows' own defaults. */
const LOCATION_EXTENT_METERS = 6_000;
const LOCATION_ZOOM = 12;

const finite = (value: number, axis: string): number => {
  if (!Number.isFinite(value))
    throw new TypeError(`ground.location.${axis} must be a finite number.`);
  return value;
};

/**
 * A survey row for a caller's own coordinates: the same footprint and zoom the curated rows use, and
 * the attribution the global fallback sources (SRTM and GMTED2010) require, since a bare coordinate
 * says nothing about which country's survey covers it.
 */
export function locationSurvey(lat: number, lon: number): ISurveyRow {
  const latitude = finite(lat, "lat");
  const longitude = finite(lon, "lon");
  if (Math.abs(latitude) > 90)
    throw new RangeError("ground.location.lat must be between -90 and 90.");
  if (Math.abs(longitude) > 180)
    throw new RangeError("ground.location.lon must be between -180 and 180.");
  return {
    name: `${latitude}, ${longitude}`,
    lat: latitude,
    lon: longitude,
    extentMeters: LOCATION_EXTENT_METERS,
    zoom: LOCATION_ZOOM,
    attribution: `${SRTM} ${TILES}`,
  };
}

/** How a request names the world's ground: the preset's own noise, a file, or a real place. */
export type IGroundRequest =
  | "procedural"
  | { readonly heightmap: string; readonly min?: number; readonly max?: number }
  | { readonly location: { readonly lat: number; readonly lon: number } };

/** What the cooked world's ground came from, as the result reports it. */
export type IGroundDecision =
  | {
      readonly source: "survey";
      readonly name: string;
      readonly lat: number;
      readonly lon: number;
      readonly attribution: string;
    }
  | { readonly source: "heightmap"; readonly heightmap: string }
  | { readonly source: "procedural" };

/** The ground choice a request recorded: an argument as written, or what the default will be. */
export type IGroundChoice =
  | "procedural"
  | "survey"
  | "starter"
  | { readonly heightmap: string; readonly min?: number; readonly max?: number }
  | { readonly location: { readonly lat: number; readonly lon: number } };
