import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ISurveyRow } from "./surveys.js";

/**
 * Real ground for the cook: Mapterhorn terrain tiles, cached on disk, decoded and resampled onto the
 * recipe's grid. Node only — the cook is a Node process, and nothing here reaches a game at runtime.
 *
 * A tile is a 512 px lossless WebP in the terrarium encoding: `height = R·256 + G + B/256 − 32768`
 * metres. Copernicus GLO-30 covers the planet to zoom 12; national lidar surveys cover zoom 13 to 17
 * where they exist, and a tile that does not exist answers 404 (https://mapterhorn.com/data-access).
 * `sharp` decodes the WebP; it loads on the first decode, so only a cook that fetches ground pays for it.
 */

const TILES = "https://tiles.mapterhorn.com";
const TILE_PX = 512;
/** Mapterhorn's finest zoom, the lidar one. */
const MAX_ZOOM = 17;
/** Metres per degree of latitude, and of longitude at the equator. */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;
/** Metres per pixel of a 512 px tile at zoom 0 on the equator. */
const EQUATOR_M_PER_PX = 40_075_016.686 / TILE_PX;

const tileUrl = (z: number, x: number, y: number): string => `${TILES}/${z}/${x}/${y}.webp`;

/** Where a tile is read from before the network: `TN_TERRAIN_TILE_CACHE`, else the OS cache dir. */
export function tileCacheDir(): string {
  const configured = process.env.TN_TERRAIN_TILE_CACHE;
  if (configured !== undefined && configured !== "") return configured;
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "threenative", "mapterhorn");
}

/** The tile a longitude sits in, as a fractional Web Mercator column at this zoom. */
const column = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;

/** The tile a latitude sits in, as a fractional Web Mercator row at this zoom (north is row 0). */
function row(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** Ground metres one pixel covers at this latitude and zoom. */
const metersPerPixel = (lat: number, z: number): number =>
  (EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

/** A decoded terrarium tile: metres, row-major, north at row 0. */
export interface ITerrariumTile {
  readonly width: number;
  readonly height: number;
  readonly heights: Float32Array;
}

/**
 * Decodes one Mapterhorn tile. Fails closed on anything but the 512 px tile the service serves,
 * naming the tile: a wrongly decoded tile would be a wrong landscape, not an error.
 */
export async function decodeTerrarium(bytes: Uint8Array, url: string): Promise<ITerrariumTile> {
  const { default: sharp } = await import("sharp");
  const { data, info } = await sharp(bytes)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
    .catch((error: unknown) => {
      throw new Error(
        `cook: ground survey tile ${url} could not be decoded (${error instanceof Error ? error.message : String(error)}).`,
      );
    });
  if (info.width !== TILE_PX || info.height !== TILE_PX || info.channels !== 3) {
    throw new Error(
      `cook: ground survey tile ${url} is ${info.width}x${info.height} with ${info.channels} channels, not a ${TILE_PX} px RGB tile.`,
    );
  }
  const heights = new Float32Array(TILE_PX * TILE_PX);
  for (let at = 0; at < heights.length; at += 1) {
    heights[at] =
      (data[at * 3] as number) * 256 +
      (data[at * 3 + 1] as number) +
      (data[at * 3 + 2] as number) / 256 -
      32768;
  }
  return { width: TILE_PX, height: TILE_PX, heights };
}

/**
 * One tile from the cache, or from the service when it is not cached yet; undefined where the
 * service has no tile (HTTP 404), so the caller can try a coarser zoom. A tile that is neither
 * cached nor fetchable throws: a cook that silently fell back to procedural ground would ship a
 * different world than the one it reported.
 */
async function loadTile(z: number, x: number, y: number): Promise<ITerrariumTile | undefined> {
  const url = tileUrl(z, x, y);
  const file = join(tileCacheDir(), String(z), String(x), `${y}.webp`);
  const cached = await readFile(file).catch(() => undefined);
  if (cached !== undefined) return decodeTerrarium(new Uint8Array(cached), url);
  let bytes: Uint8Array;
  try {
    const response = await fetch(url);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `cook: ground survey tile ${url} is not cached in ${tileCacheDir()} and could not be fetched (${error instanceof Error ? error.message : String(error)}). Pass ground: "procedural" to cook the preset's own noise instead.`,
    );
  }
  // Decoded first: a truncated or replaced download never becomes a cache entry this cook reads.
  const tile = await decodeTerrarium(bytes, url);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return tile;
}

/** A survey resampled onto a square grid: metres, row-major, north at row 0. */
export interface ISurveyHeights {
  readonly width: number;
  readonly height: number;
  readonly values: Float32Array;
  readonly min: number;
  readonly max: number;
  /** The zoom the tiles were read at, after any step down, and the ground metres one pixel of it covers. */
  readonly zoom: number;
  readonly metersPerPixel: number;
}

const bilinear = (
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): number => {
  const fx = Math.min(width - 1, Math.max(0, x));
  const fy = Math.min(height - 1, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const top =
    (values[y0 * width + x0] as number) * (1 - tx) + (values[y0 * width + x1] as number) * tx;
  const bottom =
    (values[y1 * width + x0] as number) * (1 - tx) + (values[y1 * width + x1] as number) * tx;
  return top * (1 - ty) + bottom * ty;
};

/** The footprint's tiles at one zoom, stitched into one raster; undefined when any tile is missing. */
async function stitch(survey: ISurveyRow, z: number) {
  const halfLat = survey.extentMeters / 2 / M_PER_DEG_LAT;
  const halfLon =
    survey.extentMeters / 2 / (M_PER_DEG_LON * Math.cos((survey.lat * Math.PI) / 180));
  const west = column(survey.lon - halfLon, z);
  const east = column(survey.lon + halfLon, z);
  const north = row(survey.lat + halfLat, z);
  const south = row(survey.lat - halfLat, z);
  const x0 = Math.floor(west);
  const y0 = Math.floor(north);
  const width = (Math.floor(east) - x0 + 1) * TILE_PX;
  const height = (Math.floor(south) - y0 + 1) * TILE_PX;
  const stitched = new Float32Array(width * height);
  let missing = false;
  const tiles: Promise<void>[] = [];
  for (let y = y0; y <= Math.floor(south); y += 1) {
    for (let x = x0; x <= Math.floor(east); x += 1) {
      tiles.push(
        loadTile(z, x, y).then((tile) => {
          if (tile === undefined) {
            missing = true;
            return;
          }
          for (let ty = 0; ty < TILE_PX; ty += 1) {
            for (let tx = 0; tx < TILE_PX; tx += 1) {
              stitched[((y - y0) * TILE_PX + ty) * width + (x - x0) * TILE_PX + tx] = tile.heights[
                ty * TILE_PX + tx
              ] as number;
            }
          }
        }),
      );
    }
  }
  await Promise.all(tiles);
  if (missing) return undefined;
  // The footprint inside the stitched raster, in pixels, so the crop is the row's own square.
  return {
    stitched,
    width,
    height,
    left: (west - x0) * TILE_PX,
    top: (north - y0) * TILE_PX,
    spanX: (east - west) * TILE_PX,
    spanY: (south - north) * TILE_PX,
  };
}

/**
 * A survey row's ground, resampled onto a `resolution` square grid: the tiles covering the
 * footprint are decoded, stitched and cropped to the row's own square, then sampled bilinearly.
 * The zoom is the coarsest whose pixel is no wider than a grid cell, so a 2 m grid reads 1.8 m
 * pixels; a site with no tile at that zoom (a 404 on any of its tiles) steps to the next coarser one,
 * and the result names the zoom it used. North is grid row 0, so the landscape reads the way a map does.
 */
export async function surveyHeights(
  survey: ISurveyRow,
  resolution: number,
): Promise<ISurveyHeights> {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 4097) {
    throw new RangeError(`cook: a survey needs a grid of 2..4097 samples, not ${resolution}.`);
  }
  const cell = survey.extentMeters / (resolution - 1);
  const wanted = Math.log2(metersPerPixel(survey.lat, 0) / cell);
  for (let z = Math.min(MAX_ZOOM, Math.max(0, Math.ceil(wanted))); z >= 0; z -= 1) {
    const raster = await stitch(survey, z);
    if (raster === undefined) continue;
    const { stitched, width, height, left, top, spanX, spanY } = raster;
    const values = new Float32Array(resolution * resolution);
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        const value = bilinear(
          stitched,
          width,
          height,
          left + (x / (resolution - 1)) * spanX,
          top + (y / (resolution - 1)) * spanY,
        );
        values[y * resolution + x] = value;
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    }
    return {
      width: resolution,
      height: resolution,
      values,
      min,
      max,
      zoom: z,
      metersPerPixel: metersPerPixel(survey.lat, z),
    };
  }
  throw new Error(
    `cook: ground survey '${survey.name}' (${survey.lat}, ${survey.lon}) has no Mapterhorn tile at any zoom. Pass ground: "procedural" to cook the preset's own noise instead.`,
  );
}
