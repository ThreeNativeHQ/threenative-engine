import { Heightfield } from "@threenative/core/world";
import { BufferGeometry, Float32BufferAttribute } from "three";
import distant from "../world/horizon.json";
import type { IBakedWorld } from "./terrain.js";

// Each world keeps its own same-site USGS surroundings in the installed Heightfield query.
const continuationFields = Object.fromEntries(
  Object.entries(distant).map(([name, source]) => [
    name,
    new Heightfield({
      rows: source.resolution,
      columns: source.resolution,
      width: source.size,
      depth: source.size,
      origin: { x: 0, z: 0 },
      heights: new Float32Array(source.heights),
    }),
  ]),
);
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
  if (!surveyed) throw new RangeError(`Missing surveyed surroundings for '${name}'`);
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
      const surveyedHeight =
        surveyed.heightAt(x, z) +
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
