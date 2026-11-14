import type { IAssetLoader } from "@threenative/core";
import {
  Heightfield,
  HeightfieldCollar,
  type IHeightfieldCollarSite,
} from "@threenative/core/world";
import { fetchBakedFile } from "../bakedFile.js";
import type { WorldName } from "../biomes.js";
import type { IBakedWorld } from "./terrain.js";

/** `world/horizon.json`: each world's same-site USGS surroundings, as `scripts/bake/bake.mjs` writes them. */
export type HorizonSurroundings = Record<
  string,
  { resolution: number; size: number; heights: number[]; massif?: IPackedMassif }
>;

/**
 * A placed survey massif at its tile's own spacing (`placeMassif`), for the collar's relief map:
 * int16 decimetres above `offset`, base64, row-major from `origin`, +X east and +Z south.
 */
export interface IPackedMassif {
  readonly origin: readonly [number, number];
  readonly spacing: number;
  readonly columns: number;
  readonly rows: number;
  readonly offset: number;
  readonly heights: string;
}

// Each world keeps its own surroundings in the installed Heightfield query. They are fetched, not
// imported: as a module the 7 MB file took about 3 s to compile before the first frame.
let continuationFields: Record<string, Heightfield> = {};
let sources: HorizonSurroundings = {};

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
  sources = baked;
  continuationFields = Object.fromEntries(
    Object.entries(baked).map(([name, source]) => [
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

const catmullRom = (a: number, b: number, c: number, d: number, t: number): number =>
  b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));

/**
 * The survey at `(x, z)` through a Catmull-Rom patch of its 4×4 nearest samples: C1 across cell
 * edges, so a diagonal wall draws a straight skyline, and it passes through every sample, so no
 * ridge or gully is lost to a blur. Throws outside the survey, as `Heightfield.heightAt` does.
 */
export function cubicAt(world: string, x: number, z: number): number {
  const source = sources[world];
  if (!source) throw new RangeError(`Missing surveyed surroundings for '${world}'`);
  const { heights, resolution: n, size } = source;
  const column = (x / size + 0.5) * (n - 1);
  const row = (z / size + 0.5) * (n - 1);
  if (!(column >= 0 && row >= 0 && column <= n - 1 && row <= n - 1))
    throw new RangeError(`Survey query (${x}, ${z}) is outside '${world}'`);
  const c0 = Math.min(n - 2, Math.floor(column));
  const r0 = Math.min(n - 2, Math.floor(row));
  const at = (r: number, c: number): number =>
    heights[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))] as number;
  const line = (r: number): number =>
    catmullRom(at(r, c0 - 1), at(r, c0), at(r, c0 + 1), at(r, c0 + 2), column - c0);
  return catmullRom(line(r0 - 1), line(r0), line(r0 + 1), line(r0 + 2), row - r0);
}

/**
 * How far past the playable square the surveyed surroundings are ground: a hill at the edge is
 * climbable up to here, and the level's walls stand at this band's outer edge.
 */
export const HORIZON_WALK_BAND = 200;

/** Rings of the far collar, and the radius they reach: the survey's own rim, at 2.1 km. */
const HORIZON_RINGS = 384;
export const HORIZON_REACH = 2100;

/**
 * The far collar for one world: the square's edge continued onto that site's surveyed surroundings,
 * 384 rings out to 2.1 km. Every height it answers is this game's look — the survey itself, its
 * Catmull-Rom sample blended in past 300 m, and the seam step that closes the detail boundary.
 */
export function createHorizonCollar(data: IBakedWorld, world: WorldName): HeightfieldCollar {
  return new HeightfieldCollar({
    height: collarHeight(data, world),
    resolution: data.resolution,
    ringDistance: (ring) => (ring / HORIZON_RINGS) ** 1.65 * HORIZON_REACH,
    rings: HORIZON_RINGS,
    size: data.size,
    walkBand: HORIZON_WALK_BAND,
  });
}

/** The square's own heights as a bilinear query, centred on the origin. */
function squareField(data: IBakedWorld): Heightfield {
  return new Heightfield({
    rows: data.resolution,
    columns: data.resolution,
    width: data.size,
    depth: data.size,
    origin: { x: 0, z: 0 },
    heights: Float32Array.from(data.heights),
  });
}

/**
 * The ground at any `(x, z)` of one world: the playable square inside it, the collar's own height
 * past its edge (`distance` is how far past the edge the point stands). Streamed tiles sample this,
 * so a tile that crosses the edge draws the same surface the square and the collar draw.
 */
export function createWorldHeight(
  data: IBakedWorld,
  world: WorldName,
): (x: number, z: number) => number {
  const square = squareField(data);
  const collar = collarHeight(data, world);
  const half = data.size / 2;
  return (x, z) => {
    const distance = Math.max(Math.abs(x), Math.abs(z)) - half;
    return distance <= 0
      ? square.heightAt(x, z)
      : collar({ distance, x, z } as IHeightfieldCollarSite);
  };
}

function collarHeight(
  data: IBakedWorld,
  world: WorldName,
): (site: IHeightfieldCollarSite) => number {
  const surveyed = continuationFields[world];
  if (!surveyed || !sources[world])
    throw new RangeError(`Missing surveyed surroundings for '${world}'`);
  const square = squareField(data);
  const half = data.size / 2;
  return ({ distance, x, z }: IHeightfieldCollarSite): number => {
    // The square's edge point this vertex grew from: the seam is stated there, not out at the ring.
    const scale = (half + distance) / half;
    const edgeX = Math.min(half, Math.max(-half, x / scale));
    const edgeZ = Math.min(half, Math.max(-half, z / scale));
    const near = surveyed.heightAt(x, z);
    // Past 300 m the collar takes a Catmull-Rom sample of the survey, blended in over 600 m:
    // bilinear heights turn a diagonal wall into grid-aligned skyline stairs, and the curve has no
    // stairs while it keeps every ridge and gully the survey holds. The box-filtered copy it
    // replaces erased them, and a 1 km peak read as smooth clay.
    const fold = Math.min(1, Math.max(0, (distance - 300) / 600));
    const smoothed = fold > 0 ? (cubicAt(world, x, z) - near) * fold * fold * (3 - 2 * fold) : 0;
    // Match the exact detail boundary; fade only the resolution/erosion difference over 40 m.
    // Unlike the procedural collar, all surveyed relief immediately beyond that seam is real. The
    // square's edge is read between its vertices too, so a streamed tile meets it with no step.
    const seam = square.heightAt(edgeX, edgeZ) - surveyed.heightAt(edgeX, edgeZ);
    return near + smoothed + seam * Math.exp(-distance / 40);
  };
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

/**
 * The collar triangle under `(x, z)` as it is drawn (not a bilinear blend of its quad): its three
 * vertex indices and the point's weights. Undefined where there is no collar.
 */
function collarTriangle(
  collar: HeightfieldCollar,
  x: number,
  z: number,
): { indices: [number, number, number]; weights: [number, number, number] } | undefined {
  const quad = collar.locate(x, z);
  if (quad === undefined) return undefined;
  const position = collar.geometry.getAttribute("position");
  const a = collar.index(quad.lower, quad.from);
  const b = collar.index(quad.lower, quad.to);
  const c = collar.index(quad.upper, quad.from);
  const d = collar.index(quad.upper, quad.to);
  // The collar's two triangles per quad are (a, b, c) and (b, d, c); the point's barycentrics in
  // the plane pick the one it lies in.
  for (const [p, q, r] of [
    [a, b, c],
    [b, d, c],
  ] as const) {
    const [px, pz] = [position.getX(p), position.getZ(p)];
    const [qx, qz] = [position.getX(q), position.getZ(q)];
    const [rx, rz] = [position.getX(r), position.getZ(r)];
    const det = (qz - rz) * (px - rx) + (rx - qx) * (pz - rz);
    const u = ((qz - rz) * (x - rx) + (rx - qx) * (z - rz)) / det;
    const v = ((rz - pz) * (x - rx) + (px - rx) * (z - rz)) / det;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6)
      return { indices: [p, q, r], weights: [u, v, 1 - u - v] };
  }
  return undefined;
}

/** The collar's drawn height under `(x, z)`; null where there is no collar. */
export function collarDrawnHeight(collar: HeightfieldCollar, x: number, z: number): number | null {
  const triangle = collarTriangle(collar, x, z);
  if (triangle === undefined) return null;
  const position = collar.geometry.getAttribute("position");
  const [p, q, r] = triangle.indices;
  const [u, v, w] = triangle.weights;
  return u * position.getY(p) + v * position.getY(q) + w * position.getY(r);
}

/**
 * PRD-790: where streamed tiles meet the collar. The tiles draw inside the square
 * `(centreX, centreZ, half)` and the collar outside it, so the seam is that square's edge, past the
 * playable square. `gap` is the largest step at the tiles' edge vertices (`spacing` apart), as core
 * measures a tile-to-tile seam; `fold` is the largest step between them, where a fold of the
 * collar's coarser triangles crosses a tile's straight edge.
 */
export function collarSeamGap(
  collar: HeightfieldCollar,
  height: (x: number, z: number) => number,
  centreX: number,
  centreZ: number,
  half: number,
  spacing: number,
  step = 0.1,
): { fold: number; gap: number } {
  let gap = 0;
  let fold = 0;
  const cells = Math.round((2 * half) / spacing);
  // Each edge of the square: its first corner and the unit step along it.
  const edges = [
    [centreX - half, centreZ - half, 1, 0],
    [centreX - half, centreZ + half, 1, 0],
    [centreX - half, centreZ - half, 0, 1],
    [centreX + half, centreZ - half, 0, 1],
  ] as const;
  for (const [startX, startZ, dx, dz] of edges)
    for (let cell = 0; cell < cells; cell += 1) {
      const h0 = height(startX + dx * cell * spacing, startZ + dz * cell * spacing);
      const h1 = height(startX + dx * (cell + 1) * spacing, startZ + dz * (cell + 1) * spacing);
      for (let offset = 0; offset < spacing; offset += step) {
        const along = cell * spacing + offset;
        const drawn = collarDrawnHeight(collar, startX + dx * along, startZ + dz * along);
        if (drawn === null) continue;
        const rise = Math.abs(drawn - (h0 + ((h1 - h0) * offset) / spacing));
        if (offset === 0) gap = Math.max(gap, rise);
        else fold = Math.max(fold, rise);
      }
    }
  return { fold, gap };
}
