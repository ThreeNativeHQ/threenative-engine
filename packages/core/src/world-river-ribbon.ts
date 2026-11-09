import { BufferAttribute, BufferGeometry } from "three";
import type { Heightfield } from "./world-heightfield.js";
import { WATER_RIBBON_REACH } from "./world-water-bodies.js";

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
 *
 * Attributes for the game's water material: `flow` (the unit downstream heading), `flowUv` (metres
 * down the centreline, metres across it) and `metres` (water depth over the ground). It decides no
 * colour, ripple or opacity: the game shades it.
 *
 * @situation draw a river's water surface from the baked stations
 * @situation a river's water stops in a straight edge, or a swimmer floats where no water is drawn
 * @situation share one river shape between the drawn water and the swimmer
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
      const depth = Math.min(
        maxDepth,
        Math.max(0, y - ground(vx, vz)),
        Math.max(0, (reach - Math.abs(across)) * edgeSlope),
      );
      out.depths.push(depth);
      wet.push(depth > 0 ? 1 : 0);
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
      // Wound so the face points up: along × across points down, so the pair is taken the other way.
      out.indices.push(base + a, base + a + 1, base + d, base + a + 1, base + d + 1, base + d);
    }
  }
}
