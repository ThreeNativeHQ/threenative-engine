import type { Heightfield } from "@threenative/core/world";
import {
  type IBakedLake,
  type IBakedRiver,
  surfaceHeights,
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

/**
 * The height of the water the player sees at (x, z), or `undefined` where none is drawn: the query
 * `CharacterBody3D.water` swims in.
 *
 * It reads the same baked splines and levels `createRivers` and `createLakes` draw from, with the
 * same surface rules: a footprint-limited river (forest, tundra) stands at its spline's own heights
 * across 2.5 widths, any other at `surfaceHeights` across 13 m; a lake stands level over its measured
 * waterline, 1.12 times out. Ground above the surface is dry by itself, because the body measures
 * its immersion against this height. Where a river and a lake overlap, the higher surface wins.
 */
export function waterSurfaceAt(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
  limitToFootprint: boolean,
): (x: number, z: number) => number | undefined {
  const reaches: IReach[] = [];
  for (const river of rivers) {
    const { points } = river;
    const heights = limitToFootprint
      ? points.map((point) => point[1] ?? 0)
      : surfaceHeights(field, points);
    const reach = limitToFootprint ? river.width * 2.5 : 13;
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
    const radius = limitToFootprint ? Math.min(measured, lake.radius) : measured;
    return { x: lake.at[0] ?? 0, z: lake.at[1] ?? 0, radius2: radius * radius, level: lake.level };
  });
  return (x, z) => {
    // ponytail: a linear scan of ~120 segments a call; a grid index if a world bakes thousands.
    let nearest = Number.POSITIVE_INFINITY;
    let surface: number | undefined;
    for (const piece of reaches) {
      const t = Math.max(
        0,
        Math.min(1, ((x - piece.ax) * piece.dx + (z - piece.az) * piece.dz) / piece.length2),
      );
      const distance = Math.hypot(x - piece.ax - piece.dx * t, z - piece.az - piece.dz * t);
      if (distance <= piece.reach && distance < nearest) {
        nearest = distance;
        surface = piece.ha + (piece.hb - piece.ha) * t;
      }
    }
    for (const pool of pools)
      if ((x - pool.x) ** 2 + (z - pool.z) ** 2 <= pool.radius2)
        surface = Math.max(surface ?? pool.level, pool.level);
    return surface;
  };
}
