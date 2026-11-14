import type { LandformKind } from "./presets.js";

/**
 * One real place a landform is measured from: a square ground footprint cut out of the Mapterhorn
 * terrain tiles. Shape only, like the presets themselves: nothing here names a material or a colour.
 *
 * A row's `lat`/`lon`/`extentMeters` are what the cook fetches (at the zoom its grid cell needs), so a row is a reproducible
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
  /** The data source's own attribution text, as Mapterhorn and its producers require it. */
  readonly attribution: string;
}

/**
 * Where every survey comes from: one tile set, one credit. Mapterhorn asks for "© Mapterhorn" with a
 * link to its attribution page, and that page lists the producer and licence of every source it
 * merges (https://download.mapterhorn.com/attribution.json: 151 sources, all open licences).
 */
export const TILES =
  "Terrain tiles © Mapterhorn (https://mapterhorn.com/attribution), built from open elevation data; the producers and licences of its sources are listed there.";

// One statement per producer, as `attribution.json` names it and its licence file requires it.
export const USGS_3DEP =
  "United States 3DEP terrain data, U.S. Geological Survey (public domain, U.S. Government work).";
export const COPERNICUS =
  "Copernicus GLO-30 DEM, © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved.";
const SWISSTOPO = "swissALTI3D, Federal Office of Topography swisstopo (Open Government Data).";
const IGN =
  "MNT LiDAR HD, Institut national de l'information géographique et forestière IGN (Licence Ouverte 2.0).";
const GSI =
  "Digital elevation model of the Fundamental Geospatial Data, Geospatial Information Authority of Japan (国土交通省国土地理院).";

/**
 * The landform's own survey. Each row names the producers Mapterhorn merges there: 3DEP in the United
 * States, the national lidar of the country in Europe and Japan, with Copernicus GLO-30 under all of it.
 */
export const SURVEYS: Readonly<Record<LandformKind, ISurveyRow>> = {
  alpine: {
    name: "Matterhorn massif, Pennine Alps (Switzerland / Italy)",
    lat: 45.9763,
    lon: 7.6586,
    extentMeters: 6_000,
    attribution: `${SWISSTOPO} ${COPERNICUS} ${TILES}`,
    // measured: 2 164..4 468 m (the summit is 4 478 m, at 13 m per pixel)
  },
  temperateMountains: {
    name: "Sprague Lake and Glacier Creek, Rocky Mountain National Park, Colorado",
    lat: 40.32,
    lon: -105.6067,
    extentMeters: 6_000,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 2 385..3 433 m
  },
  rollingHills: {
    name: "Coon Valley, Driftless Area, Wisconsin",
    lat: 43.7019,
    lon: -91.0139,
    extentMeters: 6_000,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 211..391 m: 3 % relief over its 6 km, which is the preset's own 0.03 ratio
  },
  desertMesa: {
    name: "Monument Valley, Arizona / Utah",
    lat: 36.998,
    lon: -110.0985,
    extentMeters: 5_000,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 1 542..1 969 m (the valley floor to the butte tops)
  },
  coastalCliffs: {
    name: "Étretat chalk cliffs, Normandy, France",
    lat: 49.707,
    lon: 0.203,
    extentMeters: 4_000,
    attribution: `${IGN} ${COPERNICUS} ${TILES}`,
    // measured: -3..109 m (the sea to the cliff top)
  },
  tundra: {
    name: "Trail Ridge, Rocky Mountain National Park, Colorado",
    lat: 40.4103,
    lon: -105.735,
    extentMeters: 5_000,
    attribution: `${USGS_3DEP} ${TILES}`,
    // measured: 2 946..3 798 m, above the tree line
  },
  volcanic: {
    name: "Mount Fuji, Honshu, Japan",
    lat: 35.3606,
    lon: 138.7274,
    extentMeters: 6_000,
    attribution: `${GSI} ${COPERNICUS} ${TILES}`,
    // measured: 1 535..3 770 m (the summit is 3 776 m)
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
      attribution: `${USGS_3DEP} ${TILES}`,
    },
  ],
  alpine: [
    {
      name: "Grand Teton and the Cathedral Group, Wyoming",
      lat: 43.7455,
      lon: -110.8024,
      extentMeters: 3_600,
      attribution: `${USGS_3DEP} ${TILES}`,
    },
    {
      name: "Maroon Bells, Elk Mountains, Colorado",
      lat: 39.0708,
      lon: -106.989,
      extentMeters: 3_600,
      attribution: `${USGS_3DEP} ${TILES}`,
    },
  ],
};

/** How much ground a bare `{ location }` covers: the survey rows' own default. */
const LOCATION_EXTENT_METERS = 6_000;

const finite = (value: number, axis: string): number => {
  if (!Number.isFinite(value))
    throw new TypeError(`ground.location.${axis} must be a finite number.`);
  return value;
};

/**
 * A survey row for a caller's own coordinates: the same footprint the curated rows use, and
 * the attribution of the global base every Mapterhorn tile carries (Copernicus GLO-30), since a bare
 * coordinate says nothing about which country's survey covers it.
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
    attribution: `${COPERNICUS} ${TILES}`,
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
      /** The tile source, the zoom the survey landed on after any step down, and that zoom's pixel size. */
      readonly tiles: "mapterhorn";
      readonly zoom: number;
      readonly metersPerPixel: number;
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
