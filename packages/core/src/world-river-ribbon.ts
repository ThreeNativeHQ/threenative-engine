import { BufferAttribute, BufferGeometry } from "three";
import type { Heightfield } from "./world-heightfield.js";
import { type IWaterLake, WATER_RIBBON_REACH, lakeReach } from "./world-water-bodies.js";

/** How a ribbon is cut; every value has the default `WaterBodies` and the Strata preview use. */
export interface IRiverRibbonOptions {
  /** Vertices across each station. Default 25. */
  readonly columns?: number;
  /** Reach either side of the centreline, per metre of channel width. Default `WATER_RIBBON_REACH`. */
  readonly reach?: number;
  /** Deepest water the `metres` attribute records. Default unbounded. */
  readonly maxDepth?: number;
  /** Metres of depth lost per metre toward the ribbon's edge, so the edges read shallow. Default 0.2. */
  readonly edgeSlope?: number;
}

/**
 * The water surface of every river, as one geometry with one group per river.
 *
 * Each station is a row across the river at its own surface height, out to `reach` widths either side
 * of the centreline, the reach `WaterBodies` floods; one more row a reach past each end stands where
 * `WaterBodies` clamps a segment, so the water a swimmer finds past a river's end is drawn there too
 * (cut at the end station, the surface stopped in a straight edge with its carved bed dry beyond).
 * Quads dry on both rows against `field` are dropped, so the surface ends at the shore.
 * Past an end where the ground falls below the end's bed, the water would run off: that cap is not
 * drawn, and the end stays cut at its last station.
 *
 * Attributes for the game's water material: `flow` (the unit downstream heading), `flowUv` (metres
 * down the centreline, metres across it) and `metres` (water depth over the ground). It decides no
 * colour, ripple or opacity: the game shades it.
 *
 * @situation draw a river's water surface from the baked stations
 * @situation a river's water stops in a straight edge, or a swimmer floats where no water is drawn
 * @situation share one river shape between the drawn water and the swimmer
 * @situation river water hangs over dry ground past the river's head or tail
 * @constraint stations, width and reach come from the game's bake; the game's material shades the geometry
 * @example const geometry = riverRibbonGeometry(rivers, field, { maxDepth: 1.6 });
 */
export function riverRibbonGeometry(
  rivers: readonly { readonly points: readonly (readonly number[])[]; readonly width: number }[],
  field: Heightfield,
  options: IRiverRibbonOptions = {},
): BufferGeometry {
  const columns = options.columns ?? 25;
  if (!Number.isInteger(columns) || columns < 2)
    throw new Error(
      `TN_RIVER_RIBBON_INVALID: columns must be an integer of at least 2, received ${columns}.`,
    );
  const perWidth = options.reach ?? WATER_RIBBON_REACH;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  const edgeSlope = options.edgeSlope ?? 0.2;
  if (!(perWidth > 0) || !(maxDepth > 0) || !(edgeSlope >= 0))
    throw new Error(
      "TN_RIVER_RIBBON_INVALID: reach and maxDepth must be positive, edgeSlope not negative.",
    );
  const positions: number[] = [];
  const flows: number[] = [];
  const uvs: number[] = [];
  const depths: number[] = [];
  const indices: number[] = [];
  const geometry = new BufferGeometry();
  for (const river of rivers) {
    if (!(river.width > 0) || river.points.length < 2)
      throw new Error(
        `TN_RIVER_RIBBON_INVALID: a river needs a positive width and two stations, received width ${river.width} and ${river.points.length} stations.`,
      );
    const start = indices.length;
    ribbon(field, river.points, river.width * perWidth, columns, maxDepth, edgeSlope, {
      depths,
      flows,
      indices,
      positions,
      uvs,
    });
    geometry.addGroup(start, indices.length - start, 0);
  }
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("flow", new BufferAttribute(new Float32Array(flows), 2));
  geometry.setAttribute("flowUv", new BufferAttribute(new Float32Array(uvs), 2));
  geometry.setAttribute("metres", new BufferAttribute(new Float32Array(depths), 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Metres the ground past an end may sit under its bed before the cap there counts as drained. */
const DRAIN_TOLERANCE = 0.05;

/** A station `reach` metres past `end`, away from `inner`, at the end's surface height. */
function beyond(
  end: readonly number[],
  inner: readonly number[],
  reach: number,
): readonly number[] {
  const dx = (end[0] ?? 0) - (inner[0] ?? 0);
  const dz = (end[2] ?? 0) - (inner[2] ?? 0);
  const length = Math.hypot(dx, dz) || 1;
  return [
    (end[0] ?? 0) + (dx / length) * reach,
    end[1] ?? 0,
    (end[2] ?? 0) + (dz / length) * reach,
  ];
}

function ribbon(
  field: Heightfield,
  stations: readonly (readonly number[])[],
  reach: number,
  columns: number,
  maxDepth: number,
  edgeSlope: number,
  out: { positions: number[]; flows: number[]; uvs: number[]; depths: number[]; indices: number[] },
): void {
  const points = [
    beyond(stations[0] as readonly number[], stations[1] as readonly number[], reach),
    ...stations,
    beyond(stations.at(-1) as readonly number[], stations.at(-2) as readonly number[], reach),
  ];
  const base = out.positions.length / 3;
  // A cap past a river that ends at the field's edge samples the edge: no ground is known past it.
  const minX = field.origin.x - field.width / 2;
  const minZ = field.origin.z - field.depth / 2;
  const ground = (x: number, z: number): number =>
    field.heightAt(
      Math.min(minX + field.width, Math.max(minX, x)),
      Math.min(minZ + field.depth, Math.max(minZ, z)),
    );
  const wet: number[] = [];
  // A cap vertex over ground below the bed at its end station is drained: water there would run off,
  // not stand at the end's level, so the quads that reach it are dropped and that end stays cut.
  const last = points.length - 1;
  const bedAt = (station: readonly number[]): number => ground(station[0] ?? 0, station[2] ?? 0);
  const capBed = [
    bedAt(stations[0] as readonly number[]),
    bedAt(stations.at(-1) as readonly number[]),
  ];
  const drained: boolean[] = [];
  // Metres down the centreline, as Unreal builds a river's sections by distance along its spline and
  // carries the flow per vertex (UE 5.8.3:
  // Engine/Plugins/Experimental/Water/Source/Runtime/Private/WaterBodyRiverComponent.cpp:104-138).
  let downstream = 0;
  for (let k = 0; k < points.length; k += 1) {
    const [x = 0, y = 0, z = 0] = points[k] as readonly number[];
    if (k > 0) {
      const [px = 0, , pz = 0] = points[k - 1] as readonly number[];
      downstream += Math.hypot(x - px, z - pz);
    }
    const before = points[Math.max(0, k - 1)] as readonly number[];
    const after = points[Math.min(points.length - 1, k + 1)] as readonly number[];
    let dx = (after[0] ?? 0) - (before[0] ?? 0);
    let dz = (after[2] ?? 0) - (before[2] ?? 0);
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    for (let c = 0; c < columns; c += 1) {
      const across = (c / (columns - 1) - 0.5) * 2 * reach;
      const vx = x - dz * across;
      const vz = z + dx * across;
      out.positions.push(vx, y, vz);
      out.flows.push(dx, dz);
      out.uvs.push(downstream, across);
      const below = ground(vx, vz);
      const bed = k === 0 ? capBed[0] : k === last ? capBed[1] : undefined;
      const dry = bed !== undefined && below < bed - DRAIN_TOLERANCE;
      const depth = dry
        ? 0
        : Math.min(
            maxDepth,
            Math.max(0, y - below),
            Math.max(0, (reach - Math.abs(across)) * edgeSlope),
          );
      out.depths.push(depth);
      wet.push(depth > 0 ? 1 : 0);
      drained.push(dry);
    }
  }
  for (let k = 1; k < points.length; k += 1) {
    for (let c = 1; c < columns; c += 1) {
      const a = (k - 1) * columns + c - 1;
      const d = k * columns + c - 1;
      // A quad with a dry corner stays, so the game's depth ramp has dry ground to dissolve across;
      // only a quad dry on both rows is dropped, which takes the surface off the hillside.
      const rowA = (wet[a - 1] ?? 0) + (wet[a + 1] ?? 0) + (wet[d - 1] ?? 0) + (wet[d + 1] ?? 0);
      const rowB = (wet[a] ?? 0) + (wet[a + 1] ?? 0) + (wet[d] ?? 0) + (wet[d + 1] ?? 0);
      if (rowA === 0 && rowB === 0) continue;
      if (drained[a] || drained[a + 1] || drained[d] || drained[d + 1]) continue;
      // Wound so the face points up: along × across points down, so the pair is taken the other way.
      out.indices.push(base + a, base + a + 1, base + d, base + a + 1, base + d + 1, base + d);
    }
  }
}

/** How a lake's disc is meshed; every default is the Strata preview's. */
export interface ILakeSurfaceOptions {
  /** Rings from the centre to the reach. Default 44. */
  readonly rings?: number;
  /** Vertices around each ring. Default 88. */
  readonly spokes?: number;
  /** How the ring spacing grows outwards; above 1 packs vertices into the near water. Default 1.7. */
  readonly packing?: number;
  /** Deepest water the `metres` attribute records. Default unbounded. */
  readonly maxDepth?: number;
}

/**
 * A lake's water surface: a level disc out to `lakeReach`, the footprint `WaterBodies` floods, with a
 * `metres` attribute (water depth over the ground). Only cells with water at a corner get triangles,
 * so the surface does not hover over dry hillside and the shore follows the ground's contour. The
 * rings pack towards the middle, so an irregular basin costs vertices where the camera sees them.
 * Returns `undefined` when the basin holds no water at its level.
 *
 * @situation draw a lake's water surface from the baked level and seed
 * @situation a lake's drawn water and the swimmer's water disagree
 * @constraint the lake row and field come from the game's bake; the game's material shades the geometry
 * @example const geometry = lakeSurfaceGeometry({ ...lake, margin: 1.12 }, field, { maxDepth: 1.6 });
 */
export function lakeSurfaceGeometry(
  lake: IWaterLake,
  field: Heightfield,
  options: ILakeSurfaceOptions = {},
): BufferGeometry | undefined {
  const rings = options.rings ?? 44;
  const spokes = options.spokes ?? 88;
  const packing = options.packing ?? 1.7;
  const maxDepth = options.maxDepth ?? Number.POSITIVE_INFINITY;
  if (!Number.isInteger(rings) || rings < 2 || !Number.isInteger(spokes) || spokes < 3)
    throw new Error(
      `TN_LAKE_SURFACE_INVALID: rings must be an integer of at least 2 and spokes of at least 3, received ${rings} and ${spokes}.`,
    );
  if (!(packing > 0) || !(maxDepth > 0))
    throw new Error("TN_LAKE_SURFACE_INVALID: packing and maxDepth must be positive.");
  const reach = lakeReach(field, lake);
  if (!(reach > 0)) return undefined;
  const [cx = 0, cz = 0] = lake.at;
  const minX = field.origin.x - field.width / 2;
  const minZ = field.origin.z - field.depth / 2;
  const count = (rings - 1) * spokes + 1;
  const positions = new Float32Array(count * 3);
  const depths = new Float32Array(count);
  const place = (index: number, radius: number, spoke: number): void => {
    const angle = (spoke / spokes) * Math.PI * 2;
    const x = Math.max(minX, Math.min(minX + field.width, cx + Math.cos(angle) * radius));
    const z = Math.max(minZ, Math.min(minZ + field.depth, cz + Math.sin(angle) * radius));
    positions[index * 3] = x;
    positions[index * 3 + 1] = lake.level;
    positions[index * 3 + 2] = z;
    depths[index] = Math.min(maxDepth, Math.max(0, lake.level - field.heightAt(x, z)));
  };
  place(0, 0, 0);
  for (let ring = 1; ring < rings; ring += 1) {
    const radius = reach * (ring / (rings - 1)) ** packing;
    for (let spoke = 0; spoke < spokes; spoke += 1)
      place(1 + (ring - 1) * spokes + spoke, radius, spoke);
  }
  const depth = (index: number): number => depths[index] ?? 0;
  const indices: number[] = [];
  // A cell with one wet corner stays, so the game's depth ramp has dry ground to fade across.
  for (let spoke = 0; spoke < spokes; spoke += 1) {
    const first = 1 + spoke;
    const next = 1 + ((spoke + 1) % spokes);
    if (depth(0) + depth(first) + depth(next) > 0) indices.push(0, first, next);
  }
  for (let ring = 2; ring < rings; ring += 1)
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const next = (spoke + 1) % spokes;
      const inner = 1 + (ring - 2) * spokes + spoke;
      const innerNext = 1 + (ring - 2) * spokes + next;
      const outer = 1 + (ring - 1) * spokes + spoke;
      const outerNext = 1 + (ring - 1) * spokes + next;
      if (depth(inner) + depth(innerNext) + depth(outer) + depth(outerNext) <= 0) continue;
      indices.push(inner, outer, innerNext, innerNext, outer, outerNext);
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("metres", new BufferAttribute(depths, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}
