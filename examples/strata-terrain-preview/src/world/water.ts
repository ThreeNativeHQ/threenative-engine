import type { Heightfield } from "@threenative/core/world";
import {
  type IBakedLake,
  type IBakedRiver,
  RIVER_FLOW_MPS,
  waterlineRadius,
} from "../render/river.js";

/** One straight piece of a river's centreline: its ends, its surface heights and how far it reaches. */
interface IReach {
  readonly ax: number;
  readonly az: number;
  readonly dx: number;
  readonly dz: number;
  readonly length2: number;
  readonly ha: number;
  readonly hb: number;
  readonly reach: number;
}

/** One lake as the surface sees it: where it stands, how far it reaches and how high it is. */
interface IPool {
  readonly x: number;
  readonly z: number;
  readonly radius2: number;
  readonly level: number;
}

/** Both waters in the form the queries scan: river segments and level pools. */
interface IWaterBodies {
  readonly reaches: readonly IReach[];
  readonly pools: readonly IPool[];
}

/** What stands at one (x, z): its surface height, and the river piece carrying it if one is. */
interface ISample {
  readonly surface: number;
  readonly river: IReach | undefined;
}

/**
 * The baked splines and levels `createRivers` and `createLakes` draw from, as segments and pools: a
 * river stands at its spline's own heights across 2.5 widths, the footprint the bake measured; a lake
 * stands level over its measured waterline, 1.12 times out, capped at the radius the biome file names.
 * One builder, the height a player swims at and the flow that carries them cannot disagree.
 */
function waterBodies(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
): IWaterBodies {
  const reaches: IReach[] = [];
  for (const river of rivers) {
    const { points } = river;
    const heights = points.map((point) => point[1] ?? 0);
    const reach = river.width * 2.5;
    for (let k = 1; k < points.length; k += 1) {
      const [ax = 0, , az = 0] = points[k - 1] as readonly number[];
      const [bx = 0, , bz = 0] = points[k] as readonly number[];
      const dx = bx - ax;
      const dz = bz - az;
      reaches.push({
        ax,
        az,
        dx,
        dz,
        length2: dx * dx + dz * dz || 1,
        ha: heights[k - 1] as number,
        hb: heights[k] as number,
        reach,
      });
    }
  }
  const pools = lakes.map((lake) => {
    const measured = waterlineRadius(field, lake.at, lake.level) * 1.12;
    const radius = Math.min(measured, lake.radius);
    return { x: lake.at[0] ?? 0, z: lake.at[1] ?? 0, radius2: radius * radius, level: lake.level };
  });
  return { reaches, pools };
}

/**
 * The water at (x, z), or `undefined` where none is drawn: the nearest river segment within its
 * reach, unless a lake's level stands over it — where a river and a lake overlap, the higher surface
 * wins and the river stops carrying anything.
 */
function sampleWater(bodies: IWaterBodies, x: number, z: number): ISample | undefined {
  // ponytail: a linear scan of ~120 segments a call; a grid index if a world bakes thousands.
  let nearest = Number.POSITIVE_INFINITY;
  let river: IReach | undefined;
  let t = 0;
  for (const piece of bodies.reaches) {
    const along = Math.max(
      0,
      Math.min(1, ((x - piece.ax) * piece.dx + (z - piece.az) * piece.dz) / piece.length2),
    );
    const distance = Math.hypot(x - piece.ax - piece.dx * along, z - piece.az - piece.dz * along);
    if (distance <= piece.reach && distance < nearest) {
      nearest = distance;
      river = piece;
      t = along;
    }
  }
  let surface =
    river === undefined ? Number.NEGATIVE_INFINITY : river.ha + (river.hb - river.ha) * t;
  for (const pool of bodies.pools)
    if ((x - pool.x) ** 2 + (z - pool.z) ** 2 <= pool.radius2 && pool.level > surface) {
      surface = pool.level;
      river = undefined;
    }
  return surface === Number.NEGATIVE_INFINITY ? undefined : { surface, river };
}

/**
 * The height of the water the player sees at (x, z), or `undefined` where none is drawn: the query
 * `CharacterBody3D.water` swims in.
 *
 * Ground above the surface is dry by itself, because the body measures its immersion against this
 * height.
 */
export function waterSurfaceAt(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
): (x: number, z: number) => number | undefined {
  const bodies = waterBodies(rivers, lakes, field);
  return (x, z) => sampleWater(bodies, x, z)?.surface;
}

/**
 * The flow the river carries a body with at (x, z), in m/s, or `undefined` where there is no water:
 * the query `CharacterBody3D.waterCurrent` drifts a swimmer with. A lake stands still and reports
 * zero.
 *
 * The direction is the downstream tangent at the nearest spline station — the direction the surface
 * is drawn flowing in — at `RIVER_FLOW_MPS`, so the ripples and the swimmer travel at one speed.
 */
export function waterCurrentAt(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
): (x: number, z: number) => { x: number; z: number } | undefined {
  const bodies = waterBodies(rivers, lakes, field);
  return (x, z) => {
    const water = sampleWater(bodies, x, z);
    if (water === undefined) return undefined;
    const piece = water.river;
    if (piece === undefined) return { x: 0, z: 0 };
    const length = Math.sqrt(piece.length2);
    return { x: (piece.dx / length) * RIVER_FLOW_MPS, z: (piece.dz / length) * RIVER_FLOW_MPS };
  };
}
