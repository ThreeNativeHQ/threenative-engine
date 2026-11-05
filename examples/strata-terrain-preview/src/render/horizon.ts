import type { IAssetLoader } from "@threenative/core";
import {
  Heightfield,
  HeightfieldCollar,
  type IHeightfieldCollarSite,
} from "@threenative/core/world";
import { fetchBakedFile } from "./bakedFile.js";
import type { WorldName } from "./biomes.js";
import type { IBakedWorld } from "./terrain.js";

/** `world/horizon.json`: each world's same-site USGS surroundings, as `scripts/bake.mjs` writes them. */
export type HorizonSurroundings = Record<
  string,
  { resolution: number; size: number; heights: number[] }
>;

// Each world keeps its own surroundings in the installed Heightfield query. They are fetched, not
// imported: as a module the 7 MB file took about 3 s to compile before the first frame.
let continuationFields: Record<string, Heightfield> = {};
let prefilteredFields: Record<string, Heightfield> = {};
let sources: HorizonSurroundings = {};

/**
 * Two separable box passes of radius 2 cells (about a 15 m Gaussian at 9.8 m cells). Far collar
 * rings read this copy: bilinear heights turn a diagonal wall into grid-aligned stair steps on the
 * skyline, which a prefiltered field does not, as a mip level does for a far texture.
 */
export function prefiltered(heights: Float32Array, size: number): Float32Array {
  let source = heights;
  // Rows then columns, twice: [stride between lines, stride along a line].
  for (const [line, step] of [
    [size, 1],
    [1, size],
    [size, 1],
    [1, size],
  ] as const)
    source = boxPass(source, size, line, step);
  return source;
}

function boxPass(source: Float32Array, size: number, line: number, step: number): Float32Array {
  const out = new Float32Array(source.length);
  for (let a = 0; a < size; a++)
    for (let b = 0; b < size; b++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++)
        sum += source[a * line + Math.min(size - 1, Math.max(0, b + k)) * step] as number;
      out[a * line + b * step] = sum / 5;
    }
  return out;
}

/**
 * `world/horizon.json`, fetched once per page and installed here. A failed fetch clears the memo
 * before it rethrows, so the next world load retries instead of rethrowing the first failure for
 * the page's whole life.
 */
let horizonLoad: Promise<void> | undefined;

export function loadHorizonSurroundings(assets: Pick<IAssetLoader, "resolve">): Promise<void> {
  horizonLoad ??= fetchBakedFile(assets, "world/horizon.json")
    .then((response) => response.json())
    .then((distant) => setHorizonSurroundings(distant as HorizonSurroundings))
    .catch((error: unknown) => {
      horizonLoad = undefined;
      throw error;
    });
  return horizonLoad;
}

/** Installs the surroundings `createHorizonCollar` reads; call once before building terrain. */
export function setHorizonSurroundings(baked: HorizonSurroundings): void {
  // TEMP-MASSIF knob: remove before report.
  const { "forest-before": before, ...current } = baked;
  const distant =
    before && new URLSearchParams(globalThis.location?.search ?? "").get("massif") === "before"
      ? { ...current, forest: before }
      : current;
  sources = distant;
  prefilteredFields = {};
  continuationFields = Object.fromEntries(
    Object.entries(distant).map(([name, source]) => [
      name,
      field(source, new Float32Array(source.heights)),
    ]),
  );
}

/** One world's installed surroundings, unfiltered, as the bake wrote them. */
export function horizonSurroundings(name: string): HorizonSurroundings[string] | undefined {
  return sources[name];
}

function field(source: HorizonSurroundings[string], heights: Float32Array): Heightfield {
  return new Heightfield({
    rows: source.resolution,
    columns: source.resolution,
    width: source.size,
    depth: source.size,
    origin: { x: 0, z: 0 },
    heights,
  });
}

/** Built on first use: only the world being shown pays the filter at load. */
function prefilteredField(name: string): Heightfield | undefined {
  const source = sources[name];
  if (!source) return undefined;
  prefilteredFields[name] ??= field(
    source,
    prefiltered(new Float32Array(source.heights), source.resolution),
  );
  return prefilteredFields[name];
}

/**
 * How far past the playable square the surveyed surroundings are ground: a hill at the edge is
 * climbable up to here, and the level's walls stand at this band's outer edge.
 */
export const HORIZON_WALK_BAND = 200;

/** Rings of the far collar, and the radius they reach: the survey's own rim, at 2.1 km. */
const HORIZON_RINGS = 384;
const HORIZON_REACH = 2100;

/**
 * The far collar for one world: the square's edge continued onto that site's surveyed surroundings,
 * 384 rings out to 2.1 km. Every height it answers is this game's look — the survey itself, its
 * prefiltered copy blended in past 300 m, and the seam step that closes the detail boundary.
 */
export function createHorizonCollar(data: IBakedWorld, world: WorldName): HeightfieldCollar {
  const surveyed = continuationFields[world];
  const smooth = prefilteredField(world);
  if (!surveyed || !smooth) throw new RangeError(`Missing surveyed surroundings for '${world}'`);
  const segments = data.resolution - 1;
  const half = data.size / 2;
  const height = ({ distance, x, z }: IHeightfieldCollarSite): number => {
    // The square's edge point this vertex grew from: the seam is stated there, not out at the ring.
    const scale = (half + distance) / half;
    const edgeX = x / scale;
    const edgeZ = z / scale;
    const column = Math.round((edgeX / data.size + 0.5) * segments);
    const row = Math.round((edgeZ / data.size + 0.5) * segments);
    const near = surveyed.heightAt(x, z);
    // Past 300 m the collar draws the prefiltered copy, blended in over 600 m, as a mip level does
    // for a far texture: bilinear heights turn a diagonal wall into grid-aligned skyline stairs.
    const fold = Math.min(1, Math.max(0, (distance - 300) / 600));
    const smoothed = fold > 0 ? (smooth.heightAt(x, z) - near) * fold * fold * (3 - 2 * fold) : 0;
    // Match the exact detail boundary; fade only the resolution/erosion difference over 40 m.
    // Unlike the procedural collar, all surveyed relief immediately beyond that seam is real.
    const seam =
      (data.heights[row * data.resolution + column] as number) - surveyed.heightAt(edgeX, edgeZ);
    return near + smoothed + seam * Math.exp(-distance / 40);
  };
  return new HeightfieldCollar({
    height,
    resolution: data.resolution,
    ringDistance: (ring) => (ring / HORIZON_RINGS) ** 1.65 * HORIZON_REACH,
    rings: HORIZON_RINGS,
    size: data.size,
    walkBand: HORIZON_WALK_BAND,
  });
}

/**
 * The collar's colours: every ring carries the square's own boundary colour at that perimeter
 * vertex, so the ring grid grows out of the detail mesh without a visible seam.
 */
export function collarColors(collar: HeightfieldCollar, data: IBakedWorld): Float32Array {
  const boundary = new Float32Array(collar.perimeter * 3);
  for (let vertex = 0; vertex < collar.perimeter; vertex++) {
    const { column, row } = collar.boundary(vertex);
    const edge = (row * data.resolution + column) * 3;
    for (let lane = 0; lane < 3; lane++)
      boundary[vertex * 3 + lane] = data.colors[edge + lane] as number;
  }
  const count = collar.geometry.getAttribute("position").count;
  const colors = new Float32Array(count * 3);
  for (let vertex = 0; vertex < count; vertex++) {
    const source = (vertex % collar.perimeter) * 3;
    colors[vertex * 3] = boundary[source] as number;
    colors[vertex * 3 + 1] = boundary[source + 1] as number;
    colors[vertex * 3 + 2] = boundary[source + 2] as number;
  }
  return colors;
}
