import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { inflateSync } from "node:zlib";
import type { ISurveyRow } from "../core/surveys.js";

/**
 * Real ground for the cook: AWS terrain tiles, cached on disk, decoded and resampled onto the
 * recipe's grid. Node only — the cook is a Node process, and nothing here reaches a game at runtime.
 *
 * The decode is a terrarium PNG: an 8-bit RGB tile where `height = R·256 + G + B/256 − 32768` metres.
 * `core/io.ts` carries no RGB decoder (`decodeHeightPNG` is grayscale only), and this package has no
 * PNG dependency, so the tile is read with Node's own zlib: the chunk walk plus the five row filters
 * is all a fixed 256×256 RGB tile needs.
 */

const TERRARIUM = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium";
const TILE_PX = 256;
/** Metres per degree of latitude, and of longitude at the equator. */
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;

const tileUrl = (z: number, x: number, y: number): string => `${TERRARIUM}/${z}/${x}/${y}.png`;

/** Where a tile is read from before the network: `TN_TERRAIN_TILE_CACHE`, else the OS cache dir. */
export function tileCacheDir(): string {
  const configured = process.env.TN_TERRAIN_TILE_CACHE;
  if (configured !== undefined && configured !== "") return configured;
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "threenative", "terrarium");
}

/** The tile a longitude sits in, as a fractional Web Mercator column at this zoom. */
const column = (lon: number, z: number): number => ((lon + 180) / 360) * 2 ** z;

/** The tile a latitude sits in, as a fractional Web Mercator row at this zoom (north is row 0). */
function row(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 2 ** z;
}

/** A decoded terrarium tile: metres, row-major, north at row 0. */
export interface ITerrariumTile {
  readonly width: number;
  readonly height: number;
  readonly heights: Float32Array;
}

/** The header and image data a terrarium tile's chunk walk yields, before it is trusted. */
interface ITerrariumPNG {
  readonly width: number;
  readonly height: number;
  readonly bitDepth: number;
  readonly colorType: number;
  readonly interlace: number;
  readonly idat: Uint8Array[];
}

/** Walks a PNG's chunks, keeping the header and the image data: the terrarium service's own shape. */
function readPNGChunks(bytes: Uint8Array, url: string): ITerrariumPNG {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || !signature.every((value, at) => bytes[at] === value)) {
    throw new Error(`cook: ground survey tile ${url} is not a PNG.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const idat: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = decoder.decode(bytes.subarray(offset + 4, offset + 8));
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error(`cook: ground survey tile ${url} is truncated.`);
    if (type === "IHDR") {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      bitDepth = bytes[offset + 16] as number;
      colorType = bytes[offset + 17] as number;
      interlace = bytes[offset + 20] as number;
    }
    if (type === "IDAT") idat.push(bytes.subarray(offset + 8, end - 4));
    if (type === "IEND") return { width, height, bitDepth, colorType, interlace, idat };
    offset = end;
  }
  throw new Error(`cook: ground survey tile ${url} is incomplete.`);
}

/** PNG's Paeth predictor: whichever neighbour the plane through all three lands nearest. */
function paeth(left: number, up: number, corner: number): number {
  const p = left + up - corner;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - corner);
  if (pa <= pb && pa <= pc) return left;
  return pb <= pc ? up : corner;
}

/** What a filtered row adds back to each pixel, per PNG's five filter types. */
function predicted(filter: number, left: number, up: number, corner: number): number {
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  if (filter === 4) return paeth(left, up, corner);
  return 0;
}

/** Reverses a PNG's row filters, the one step between its zlib stream and its pixels. */
function unfilter(
  raw: Uint8Array,
  width: number,
  height: number,
  channels: number,
  url: string,
): Uint8Array {
  const stride = width * channels;
  const pixels = new Uint8Array(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)] as number;
    if (filter > 4)
      throw new Error(`cook: ground survey tile ${url} uses PNG row filter ${filter}.`);
    for (let x = 0; x < stride; x += 1) {
      const at = y * stride + x;
      const left = x >= channels ? (pixels[at - channels] as number) : 0;
      const up = y > 0 ? (pixels[at - stride] as number) : 0;
      const corner = y > 0 && x >= channels ? (pixels[at - stride - channels] as number) : 0;
      const value = raw[y * (stride + 1) + 1 + x] as number;
      pixels[at] = (value + predicted(filter, left, up, corner)) & 255;
    }
  }
  return pixels;
}

/**
 * Decodes one terrarium PNG. Fails closed on anything but the fixed 8-bit RGB tile the service
 * serves, naming the tile: a wrongly decoded tile would be a wrong landscape, not an error.
 */
export function decodeTerrarium(bytes: Uint8Array, url: string): ITerrariumTile {
  const png = readPNGChunks(bytes, url);
  if (png.bitDepth !== 8 || png.colorType !== 2 || png.interlace !== 0) {
    throw new Error(
      `cook: ground survey tile ${url} is not an 8-bit RGB PNG (bit depth ${png.bitDepth}, colour type ${png.colorType}, interlace ${png.interlace}).`,
    );
  }
  const channels = 3;
  const raw = inflateSync(Buffer.concat(png.idat));
  if (raw.length !== (png.width * channels + 1) * png.height) {
    throw new Error(`cook: ground survey tile ${url} decodes to ${raw.length} bytes, not a tile.`);
  }
  const pixels = unfilter(raw, png.width, png.height, channels, url);
  const heights = new Float32Array(png.width * png.height);
  for (let at = 0; at < heights.length; at += 1) {
    heights[at] =
      (pixels[at * channels] as number) * 256 +
      (pixels[at * channels + 1] as number) +
      (pixels[at * channels + 2] as number) / 256 -
      32768;
  }
  return { width: png.width, height: png.height, heights };
}

/**
 * One tile from the cache, or from the service when it is not cached yet. A tile that is neither
 * cached nor fetchable throws: a cook that silently fell back to procedural ground would ship a
 * different world than the one it reported.
 */
async function loadTile(z: number, x: number, y: number): Promise<ITerrariumTile> {
  const url = tileUrl(z, x, y);
  const file = join(tileCacheDir(), String(z), String(x), `${y}.png`);
  const cached = await readFile(file).catch(() => undefined);
  if (cached !== undefined) return decodeTerrarium(new Uint8Array(cached), url);
  let bytes: Uint8Array;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw new Error(
      `cook: ground survey tile ${url} is not cached in ${tileCacheDir()} and could not be fetched (${error instanceof Error ? error.message : String(error)}). Pass ground: "procedural" to cook the preset's own noise instead.`,
    );
  }
  // Decoded first: a truncated or replaced download never becomes a cache entry this cook reads.
  const tile = decodeTerrarium(bytes, url);
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

/**
 * A survey row's ground, resampled onto a `resolution` square grid: the tiles covering the
 * footprint are decoded, stitched and cropped to the row's own square, then sampled bilinearly.
 * North is grid row 0, so the landscape reads the way a map does.
 */
export async function surveyHeights(
  survey: ISurveyRow,
  resolution: number,
): Promise<ISurveyHeights> {
  if (!Number.isInteger(resolution) || resolution < 2 || resolution > 4097) {
    throw new RangeError(`cook: a survey needs a grid of 2..4097 samples, not ${resolution}.`);
  }
  const z = survey.zoom;
  const halfLat = survey.extentMeters / 2 / M_PER_DEG_LAT;
  const halfLon =
    survey.extentMeters / 2 / (M_PER_DEG_LON * Math.cos((survey.lat * Math.PI) / 180));
  const west = column(survey.lon - halfLon, z);
  const east = column(survey.lon + halfLon, z);
  const north = row(survey.lat + halfLat, z);
  const south = row(survey.lat - halfLat, z);
  const x0 = Math.floor(west);
  const x1 = Math.floor(east);
  const y0 = Math.floor(north);
  const y1 = Math.floor(south);
  const columns = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const width = columns * TILE_PX;
  const height = rows * TILE_PX;
  const stitched = new Float32Array(width * height);
  const tiles: Promise<void>[] = [];
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      tiles.push(
        loadTile(z, x, y).then((tile) => {
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
  // The footprint inside the stitched raster, in pixels, so the crop is the row's own square.
  const left = (west - x0) * TILE_PX;
  const top = (north - y0) * TILE_PX;
  const spanX = (east - west) * TILE_PX;
  const spanY = (south - north) * TILE_PX;
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
  return { width: resolution, height: resolution, values, min, max };
}
