import { type Heightfield, type IWaterOcean, WaterBodies } from "@threenative/core/world";
import {
  type IBakedLake,
  type IBakedRiver,
  LAKE_REACH,
  RIVER_FLOW_MPS,
} from "../render/water/river.js";

/**
 * The baked water rows as the one mechanism reads them, and the queries the swimmer asks.
 *
 * A river stands at its spline's own heights across `WATER_RIBBON_REACH` widths of its bed, and
 * carries the flow its ripples are drawn at. A lake stands level over the waterline its basin
 * measures, `LAKE_REACH` times out, capped at the radius its biome row names. A sea stands at its
 * level out to the reach of its drawn surface. One store answers the drawn geometry and the swimmer,
 * so the height a player swims at and the flow that carries them cannot disagree.
 */
export function waterBodies(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
  sea?: IWaterOcean,
): WaterBodies {
  return new WaterBodies({
    field,
    lakes: lakes.map((lake) => ({
      at: lake.at,
      level: lake.level,
      margin: LAKE_REACH,
      radius: lake.radius,
    })),
    ocean: sea,
    ribbons: rivers.map((river) => ({
      flow: RIVER_FLOW_MPS,
      points: river.points,
      width: river.width,
    })),
  });
}

/**
 * The height of the water the player sees at (x, z), or `undefined` where none is drawn: the query
 * `CharacterBody3D.water` swims in. `sea` is the sea the world draws, where it draws one.
 *
 * Ground above the surface is dry by itself, because the body measures its immersion against this
 * height.
 */
export function waterSurfaceAt(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
  sea?: IWaterOcean,
): (x: number, z: number) => number | undefined {
  const bodies = waterBodies(rivers, lakes, field, sea);
  return (x, z) => bodies.surfaceAt(x, z);
}

/**
 * The flow the river carries a body with at (x, z), in m/s, or `undefined` where there is no water:
 * the query `CharacterBody3D.waterCurrent` drifts a swimmer with. A lake and the sea stand still and
 * report zero. `sea` is the sea the world draws, where it draws one.
 *
 * The direction is the downstream tangent at the nearest spline station — the direction the surface
 * is drawn flowing in — at `RIVER_FLOW_MPS`, so the ripples and the swimmer travel at one speed.
 */
export function waterCurrentAt(
  rivers: readonly IBakedRiver[],
  lakes: readonly IBakedLake[],
  field: Heightfield,
  sea?: IWaterOcean,
): (x: number, z: number) => { x: number; z: number } | undefined {
  const bodies = waterBodies(rivers, lakes, field, sea);
  return (x, z) => bodies.currentAt(x, z);
}
