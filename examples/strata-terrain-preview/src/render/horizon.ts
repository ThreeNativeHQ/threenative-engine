import { Heightfield } from "@threenative/core/world";
import { BufferGeometry, Float32BufferAttribute } from "three";
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
/** Decorative land beyond the collider; the inner ring uses the bake's exact edge vertices. */
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
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring <= rings; ring++) {
    const distance = (ring / rings) ** 1.65 * 2100;
    for (let vertex = 0; vertex < perimeter; vertex++) {
      const side = Math.floor(vertex / segments);
      const along = vertex % segments;
      const [startX, startZ] = starts[side] as readonly [number, number];
      const [stepX, stepZ] = directions[side] as readonly [number, number];
      const column = startX + along * stepX;
      const row = startZ + along * stepZ;
      const edge = row * data.resolution + column;
      const scale = 1 + distance / (data.size / 2);
      const x = (column / segments - 0.5) * data.size * scale;
      const z = (row / segments - 0.5) * data.size * scale;
      // Match the exact detail boundary; fade only the resolution/erosion difference over 40 m.
      // Unlike the procedural collar, all surveyed relief immediately beyond that seam is real.
      const edgeX = (column / segments - 0.5) * data.size;
      const edgeZ = (row / segments - 0.5) * data.size;
      const far = Math.min(1, Math.max(0, (distance - 300) / 600));
      const surveyedHeight =
        surveyed.heightAt(x, z) +
        (smooth.heightAt(x, z) - surveyed.heightAt(x, z)) * far * far * (3 - 2 * far) +
        ((data.heights[edge] as number) - surveyed.heightAt(edgeX, edgeZ)) *
          Math.exp(-distance / 40);
      positions.push(x, surveyedHeight, z);
      colors.push(
        data.colors[edge * 3] as number,
        data.colors[edge * 3 + 1] as number,
        data.colors[edge * 3 + 2] as number,
      );
      if (ring === rings) continue;
      const a = ring * perimeter + vertex;
      const b = ring * perimeter + ((vertex + 1) % perimeter);
      const c = a + perimeter;
      const d = b + perimeter;
      indices.push(a, b, c, b, d, c);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}
