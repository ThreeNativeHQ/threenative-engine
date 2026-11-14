// The water the editor draws, and the water a full-world export carries.
//
// The live game has a spectral ocean and a screen-space river (`ocean.ts`, `river.ts`), and neither
// of those travels inside a GLB: both are per-frame simulations whose result is a shader, not
// geometry. A portable world still has to contain its water, so this file bakes the same bodies as
// ordinary static `MeshStandardMaterial` surfaces: the evaluated river ribbon and the flooded
// extent, coloured per vertex by the metres of water standing on each vertex.
//
// Two rules make it honest rather than decorative:
//
// - The geometry comes from the evaluated state (`ITerrainState.rivers` / `.waters`), never from the
//   recipe's authoring intent, so what the export carries is what the world actually evaluated.
// - The colour comes from the same depth the live composite grades by, so the baked surface and the
//   live one are the same body at the same instant rather than two different blue shapes.
//
// Every number here is this game's appearance. `ITerrainState` supplies the shape and nothing else.
import type { ITerrainState } from "@threenative/terrain";
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Mesh,
  MeshStandardMaterial,
  type Vector3,
} from "three";

/** A height query in world metres; the same one the terrain mesh and the collider read. */
export type GroundQuery = (x: number, z: number) => number;

/** This game's water: what a metre of depth looks like, and how the surface is finished. */
const WATER = {
  /** Metres of water over the deepest point of a carved river bed. */
  fill: 1.1,
  /** Vertices across the river surface, so the shore fade spans more than one quad. */
  across: 13,
  /** How far either side of the centreline the surface reaches, in river widths. */
  reach: 1.1,
  /** Stations over which the fill tapers to nothing at each end, so it meets the ground. */
  taper: 9,
  /** Metres of water past which the bed stops contributing. */
  opaque: 1.2,
  /** The shallow silt, the deep body and the foam that sits on both. */
  silt: 0xc0ad84,
  deep: 0x1f3833,
  deepGain: 0.26,
  foam: 0xe8efe8,
  /** A surface this smooth is water; this dry is wet gravel. */
  roughness: 0.08,
  metalness: 0,
  /** Shallow water is nearly clear, so the surface is mostly transparent. */
  opacity: 0.82,
  /** Metres one uv tile spans, so a receiving game can put a normal map on the surface. */
  tile: 4,
} as const;

/** Metres of water past which the bed stops contributing, as a 0..1 share. */
function depthShare(depth: number): number {
  return Math.min(1, depth / WATER.opaque);
}

/** The last hand's depth whitens towards foam, which is where a stream catches the light. */
function foamShare(depth: number): number {
  return 1 - Math.min(1, depth / 0.25);
}

/** Depth graded colour in linear space: `new Color(hex)` has already converted sRGB. */
function shade(depth: number, out: Color): Color {
  const silt = new Color(WATER.silt);
  const deep = new Color(WATER.deep);
  const foam = new Color(WATER.foam);
  const share = depthShare(depth) * (1 + WATER.deepGain);
  const wash = foamShare(depth);
  return out.setRGB(
    silt.r + (deep.r - silt.r) * share + (foam.r - (silt.r + (deep.r - silt.r) * share)) * wash,
    silt.g + (deep.g - silt.g) * share + (foam.g - (silt.g + (deep.g - silt.g) * share)) * wash,
    silt.b + (deep.b - silt.b) * share + (foam.b - (silt.b + (deep.b - silt.b) * share)) * wash,
  );
}

/** One finished water surface, ready both to draw and to hand to the exporter. */
export interface IWaterSurface {
  readonly id: string;
  readonly mesh: Mesh;
  /** Vertex count, so a caller can prove the surface is real geometry and not an empty shell. */
  readonly triangles: number;
}

function material(): MeshStandardMaterial {
  return new MeshStandardMaterial({
    metalness: WATER.metalness,
    roughness: WATER.roughness,
    transparent: true,
    opacity: WATER.opacity,
    vertexColors: true,
  });
}

function surface(
  id: string,
  positions: number[],
  depths: number[],
  indices: number[],
): IWaterSurface {
  const geometry = new BufferGeometry();
  const count = positions.length / 3;
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(count * 3), 3));
  // The exporter requires uv and normal on every static mesh, and a water surface is drawn with
  // both: the normal is what a still surface has, and the uv lets a receiving game put a normal map
  // on it without unwrapping a world-space ribbon.
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array(count * 2), 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const colors = geometry.getAttribute("color");
  const uvs = geometry.getAttribute("uv");
  const shaded = new Color();
  for (let index = 0; index < count; index += 1) {
    shade(depths[index] ?? 0, shaded);
    colors.setXYZ(index, shaded.r, shaded.g, shaded.b);
    // World metres as uv, so a receiving game can tile a normal map over the surface without
    // unwrapping a ribbon; the terrain's own uv is 0..1 and this surface has no such frame.
    uvs.setXY(
      index,
      (positions[index * 3] ?? 0) / WATER.tile,
      (positions[index * 3 + 2] ?? 0) / WATER.tile,
    );
  }
  const mesh = new Mesh(geometry, material());
  mesh.name = `water:${id}`;
  return { id, mesh, triangles: (indices.length ?? 0) / 3 };
}

/**
 * The river's surface height along its path: a fill over the bed, never running uphill.
 *
 * The same three passes the live river uses — downhill, smoothed, downhill again — because a
 * surface that copies the bed's erosion noise steps up and down like a staircase.
 */
function surfaceHeights(ground: GroundQuery, points: readonly (readonly number[])[]): number[] {
  const last = points.length - 1;
  const raw = points.map(([x = 0, , z = 0], index) => {
    const fromEnd = Math.min(index, last - index) / WATER.taper;
    return ground(x, z) + WATER.fill * Math.max(0, Math.min(1, fromEnd));
  });
  for (let index = 1; index < raw.length; index += 1)
    raw[index] = Math.min(raw[index] as number, raw[index - 1] as number);
  const smooth = raw.map((_, index) => {
    let sum = 0;
    let samples = 0;
    for (
      let other = Math.max(0, index - 3);
      other <= Math.min(raw.length - 1, index + 3);
      other += 1
    ) {
      sum += raw[other] as number;
      samples += 1;
    }
    return sum / samples;
  });
  for (let index = 1; index < smooth.length; index += 1)
    smooth[index] = Math.min(smooth[index] as number, smooth[index - 1] as number);
  return smooth;
}

/** One river as a ribbon across its width, dropping the quads that sit on dry ground. */
function river(
  id: string,
  points: readonly (readonly [number, number, number])[],
  width: number,
  ground: GroundQuery,
): IWaterSurface {
  const heights = surfaceHeights(ground, points);
  const columns = WATER.across;
  const reach = (width / 2) * WATER.reach;
  const positions: number[] = [];
  const depths: number[] = [];
  const indices: number[] = [];
  const wet: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const before = points[Math.max(0, index - 1)] as readonly number[];
    const after = points[Math.min(points.length - 1, index + 1)] as readonly number[];
    let dx = (after[0] ?? 0) - (before[0] ?? 0);
    let dz = (after[2] ?? 0) - (before[2] ?? 0);
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const [x = 0, , z = 0] = points[index] as readonly number[];
    const y = heights[index] as number;
    for (let column = 0; column < columns; column += 1) {
      const across = (column / (columns - 1) - 0.5) * 2 * reach;
      const vx = x - dz * across;
      const vz = z + dx * across;
      positions.push(vx, y, vz);
      const depth = Math.max(0, y - ground(vx, vz));
      depths.push(depth);
      wet.push(depth > 0 ? 1 : 0);
    }
  }
  for (let index = 1; index < points.length; index += 1) {
    for (let column = 1; column < columns; column += 1) {
      const a = (index - 1) * columns + column - 1;
      const b = a + 1;
      const d = index * columns + column - 1;
      const e = d + 1;
      // A quad dry on both of its rows is dropped outright: that is what takes the surface off the
      // hillside rather than folding it back along the centreline.
      if (
        (wet[a - 1] ?? 0) + (wet[b] ?? 0) + (wet[d - 1] ?? 0) + (wet[e] ?? 0) === 0 &&
        (wet[a] ?? 0) + (wet[b] ?? 0) + (wet[d] ?? 0) + (wet[e] ?? 0) === 0
      )
        continue;
      indices.push(a, b, d, b, e, d);
    }
  }
  return surface(id, positions, depths, indices);
}

/**
 * One flooded body as a flat surface at its level, clipped to the ground that is under it.
 *
 * The mask is the evaluated one, so the shoreline is the world's own contour rather than a drawn
 * circle, and every vertex carries the metres of water standing on it.
 */
function body(id: string, level: number, state: ITerrainState, ground: GroundQuery): IWaterSurface {
  const resolution = state.resolution;
  const cell = state.size / (resolution - 1);
  const half = state.size / 2;
  const positions: number[] = [];
  const depths: number[] = [];
  const indices: number[] = [];
  const wet: number[] = [];
  for (let row = 0; row < resolution; row += 1)
    for (let column = 0; column < resolution; column += 1) {
      const x = -half + column * cell;
      const z = -half + row * cell;
      const depth = Math.max(0, level - ground(x, z));
      positions.push(x, level, z);
      depths.push(depth);
      wet.push(depth > 0 ? 1 : 0);
    }
  for (let row = 0; row < resolution - 1; row += 1)
    for (let column = 0; column < resolution - 1; column += 1) {
      const a = row * resolution + column;
      const b = a + 1;
      const d = a + resolution;
      const e = d + 1;
      if ((wet[a] ?? 0) + (wet[b] ?? 0) + (wet[d] ?? 0) + (wet[e] ?? 0) === 0) continue;
      indices.push(a, d, b, b, d, e);
    }
  return surface(id, positions, depths, indices);
}

/**
 * Every water body the evaluated world contains, as static portable surfaces.
 *
 * @param ground a world-metre height query; the same heights the terrain mesh was built from
 */
export function bakeWater(state: ITerrainState, ground: GroundQuery): IWaterSurface[] {
  const surfaces: IWaterSurface[] = [];
  for (const entry of state.rivers)
    surfaces.push(river(entry.id, entry.points, entry.width, ground));
  for (const entry of state.waters) surfaces.push(body(entry.id, entry.level, state, ground));
  return surfaces;
}

/** A water surface's world bounds, so an export or a focus can measure what it drew. */
export function waterBounds(surface: IWaterSurface): { min: Vector3; max: Vector3 } {
  surface.mesh.geometry.computeBoundingBox();
  const box = surface.mesh.geometry.boundingBox;
  if (!box) throw new Error(`Water '${surface.id}' has no bounds`);
  return { min: box.min, max: box.max };
}
