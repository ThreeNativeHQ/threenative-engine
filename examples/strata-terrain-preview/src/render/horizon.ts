import { Heightfield } from "@threenative/core/world";
import { BufferAttribute, BufferGeometry } from "three";
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

/** Installs the surroundings `createHorizonGeometry` reads; call once before building terrain. */
export function setHorizonSurroundings(distant: HorizonSurroundings): void {
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

interface IHorizonWalk {
  readonly rings: number;
  readonly perimeter: number;
  /** Metres past the square's edge where the band ends. */
  readonly extent: number;
}

/**
 * The walkable near band of the surroundings, as the drawn triangles themselves (a view of the same
 * vertex buffer, not a resample), so a collider built from it is the ground the eye sees.
 */
export function horizonWalkGeometry(horizon: BufferGeometry): {
  geometry: BufferGeometry;
  extent: number;
} {
  const walk = horizon.userData.walk as IHorizonWalk | undefined;
  const index = horizon.getIndex();
  if (walk === undefined || index === null)
    throw new RangeError("horizonWalkGeometry needs a createHorizonGeometry result");
  const position = horizon.getAttribute("position").array as Float32Array;
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(position.subarray(0, (walk.rings + 1) * walk.perimeter * 3), 3),
  );
  geometry.setIndex(
    new BufferAttribute(
      (index.array as Uint32Array).subarray(0, walk.rings * walk.perimeter * 6),
      1,
    ),
  );
  return { geometry, extent: walk.extent };
}

/** Land beyond the playable square; the inner ring uses the bake's exact edge vertices. */
export function createHorizonGeometry(
  data: IBakedWorld,
  landform: "mountain" | "alpine" | "mesa" | "plain" = "mountain",
  _field?: Heightfield,
): BufferGeometry {
  const name =
    data.waterLevel !== null
      ? "coastal"
      : landform === "alpine"
        ? "alpine"
        : landform === "mesa"
          ? "desert"
          : landform === "plain"
            ? "tundra"
            : "forest";
  const surveyed = continuationFields[name];
  const smooth = prefilteredField(name);
  if (!surveyed || !smooth) throw new RangeError(`Missing surveyed surroundings for '${name}'`);
  const segments = data.resolution - 1;
  const perimeter = segments * 4;
  const rings = 384;
  const starts = [
    [0, 0],
    [segments, 0],
    [segments, segments],
    [0, segments],
  ] as const;
  const directions = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const;
  // Per edge vertex, once: its bake cell and the seam step between the bake and the survey there.
  // The collar has 385 rings of these, and the edge terms took most of its 0.5 s build.
  const edges = new Int32Array(perimeter);
  const unitX = new Float64Array(perimeter);
  const unitZ = new Float64Array(perimeter);
  const seams = new Float64Array(perimeter);
  for (let vertex = 0; vertex < perimeter; vertex++) {
    const side = Math.floor(vertex / segments);
    const along = vertex % segments;
    const [startX, startZ] = starts[side] as readonly [number, number];
    const [stepX, stepZ] = directions[side] as readonly [number, number];
    const column = startX + along * stepX;
    const row = startZ + along * stepZ;
    const edge = row * data.resolution + column;
    edges[vertex] = edge;
    const u = column / segments - 0.5;
    const w = row / segments - 0.5;
    unitX[vertex] = u;
    unitZ[vertex] = w;
    // Match the exact detail boundary; fade only the resolution/erosion difference over 40 m.
    // Unlike the procedural collar, all surveyed relief immediately beyond that seam is real.
    seams[vertex] =
      (data.heights[edge] as number) - surveyed.heightAt(u * data.size, w * data.size);
  }
  const positions = new Float32Array((rings + 1) * perimeter * 3);
  const colors = new Float32Array((rings + 1) * perimeter * 3);
  const indices = new Uint32Array(rings * perimeter * 6);
  let p = 0;
  let q = 0;
  const ringDistance = (ring: number): number => (ring / rings) ** 1.65 * 2100;
  let walkRings = 0;
  while (walkRings < rings && ringDistance(walkRings + 1) <= HORIZON_WALK_BAND) walkRings++;
  for (let ring = 0; ring <= rings; ring++) {
    const distance = ringDistance(ring);
    const scale = 1 + distance / (data.size / 2);
    const far = Math.min(1, Math.max(0, (distance - 300) / 600));
    const fade = Math.exp(-distance / 40);
    for (let vertex = 0; vertex < perimeter; vertex++) {
      const edge = edges[vertex] as number;
      const x = (unitX[vertex] as number) * data.size * scale;
      const z = (unitZ[vertex] as number) * data.size * scale;
      const near = surveyed.heightAt(x, z);
      // The prefiltered copy is read only where it blends in; the sum is the same where it does not.
      const smoothed = far > 0 ? (smooth.heightAt(x, z) - near) * far * far * (3 - 2 * far) : 0;
      positions[p] = x;
      positions[p + 1] = near + smoothed + (seams[vertex] as number) * fade;
      positions[p + 2] = z;
      colors[p] = data.colors[edge * 3] as number;
      colors[p + 1] = data.colors[edge * 3 + 1] as number;
      colors[p + 2] = data.colors[edge * 3 + 2] as number;
      p += 3;
      if (ring === rings) continue;
      const a = ring * perimeter + vertex;
      const b = ring * perimeter + ((vertex + 1) % perimeter);
      const c = a + perimeter;
      const d = b + perimeter;
      indices[q++] = a;
      indices[q++] = b;
      indices[q++] = c;
      indices[q++] = b;
      indices[q++] = d;
      indices[q++] = c;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.userData.walk = {
    rings: walkRings,
    perimeter,
    extent: ringDistance(walkRings),
  } satisfies IHorizonWalk;
  return geometry;
}
