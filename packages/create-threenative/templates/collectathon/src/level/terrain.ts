import { Heightfield } from "@threenative/core/world";

/** A rectangle [x min, x max, z min, z max] or a disc [x, z, radius] of level ground at y = 0. */
export type LevelZone =
  | readonly [number, number, number, number]
  | readonly [number, number, number];

export interface ITerrainPlan {
  /** Ground the course's metres are measured on: every scenario route and landmark foot. */
  readonly level: readonly LevelZone[];
  /** A flat pad at its own height: x, z, radius, y (the castle's plateau). */
  readonly pad: readonly [number, number, number, number];
  /** Dirt paths, each a polyline of x, z corners; they follow the ground, they do not level it. */
  readonly paths: readonly (readonly (readonly [number, number])[])[];
  readonly seaLevel: number;
}

export interface ITerrain {
  /** One height buffer for the drawn mesh, the collider and every snap (`@threenative/core/world`). */
  readonly field: Heightfield;
  /** Ground height at (x, z), the same bilinear numbers the mesh is built from; the sea floor off it. */
  ground(x: number, z: number): number;
  /** The up component of the ground's normal: 1 is flat, below 0.7 is steeper than the hero's 45° climb. */
  flatness(x: number, z: number): number;
  /** Metres from the nearest dirt path's centre line. */
  pathDistance(x: number, z: number): number;
}

/** The grid: 1 m cells over the main island and the castle's headland to the north. */
export const TERRAIN_BOUNDS = { minX: -46, maxX: 46, minZ: -90, maxZ: 46 } as const;
const ISLAND_RADIUS = 36;
/** The headland the castle stands on: an ellipse joined to the island's north shore. */
const HEADLAND = { x: 2, z: -60, rx: 30, rz: 26 } as const;

const clamp01 = (t: number): number => Math.min(1, Math.max(0, t));
const smooth = (from: number, to: number, value: number): number => {
  const t = clamp01((value - from) / (to - from));
  return t * t * (3 - 2 * t);
};
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Distance from (x, z) to a level zone; 0 inside it. */
function zoneDistance(zone: LevelZone, x: number, z: number): number {
  if (zone.length === 3) return Math.max(0, Math.hypot(x - zone[0], z - zone[1]) - zone[2]);
  const dx = Math.max(zone[0] - x, 0, x - zone[1]);
  const dz = Math.max(zone[2] - z, 0, z - zone[3]);
  return Math.hypot(dx, dz);
}

function segmentDistance(
  x: number,
  z: number,
  [ax, az]: readonly [number, number],
  [bx, bz]: readonly [number, number],
): number {
  const lx = bx - ax;
  const lz = bz - az;
  const t = clamp01(((x - ax) * lx + (z - az) * lz) / (lx * lx + lz * lz));
  return Math.hypot(x - (ax + lx * t), z - (az + lz * t));
}

/** Rounded hills: x, z, radius, height. Placed off the routes, so they rise beside the play, not under it. */
const HILLS = [
  [17, -5, 8, 4.5],
  [21, 24, 11, 7],
  [-19, 31, 8, 4],
  [-34, -8, 7, 5],
  [27, -21, 8, 6],
  [-33, 30, 6, 3],
  [33, 18, 6, 3.5],
] as const;

/**
 * The island's shape in metres, before it is sampled: rolling ground with designed hills, the level
 * zones pressed flat with a 6 m bank, a ramp up to the castle's plateau, and a shore that is a sand
 * beach on the south-west and a rock cliff everywhere else (the long-jump gap to the east islet keeps
 * its cliff edge). Deterministic: no random numbers, so every build and every snap agrees.
 */
function shape(plan: ITerrainPlan, x: number, z: number): number {
  const { seaLevel } = plan;
  // Rolling ground: two crossed waves and a short ripple, about ±1.4 m round a 1 m rise.
  let relief =
    1 +
    0.9 * Math.sin(x * 0.21 + Math.sin(z * 0.17) * 1.7) * Math.cos(z * 0.19 - x * 0.07) +
    0.45 * Math.sin(x * 0.43 + z * 0.37) * Math.cos(z * 0.51 - 0.3);
  for (const [hx, hz, r, h] of HILLS)
    relief += h * Math.exp(-((x - hx) ** 2 + (z - hz) ** 2) / r ** 2);
  // The castle's plateau: the ground climbs northward to the pad's height.
  const [px, pz, pr, py] = plan.pad;
  relief = Math.max(relief, py * smooth(-36, -56, z) * (1 - smooth(18, 30, Math.abs(x - px))));
  relief = Math.max(-0.6, relief);
  // Level zones: flat inside, a bank rising over the next 6 m.
  const away = Math.min(...plan.level.map((zone) => zoneDistance(zone, x, z)));
  let height = relief * smooth(1, 7, away);
  height = lerp(height, py, 1 - smooth(pr, pr + 5, Math.hypot(x - px, z - pz)));

  // The shore: how far (x, z) is inside the coast, positive on land.
  const angle = Math.atan2(z, x);
  const wobble =
    (1.6 * Math.sin(angle * 3 + 0.7) + Math.sin(angle * 7 + 1.9)) *
    smooth(0.3, 0.7, Math.abs(angle));
  const island = ISLAND_RADIUS - Math.hypot(x, z) + wobble;
  const headland =
    HEADLAND.rz * (1 - Math.hypot((x - HEADLAND.x) / HEADLAND.rx, (z - HEADLAND.z) / HEADLAND.rz));
  // A smooth union, so the headland joins the island across a broad neck, not a pinch.
  const blend = clamp01(0.5 + (island - headland) / 16);
  const inland = lerp(headland, island, blend) + 8 * blend * (1 - blend);
  // A beach on the west and south-west, about 2.0 to 3.2 rad; a rock cliff everywhere else.
  const beach = smooth(0.55, 0.85, Math.cos(angle - 2.6)) * (z > -30 ? 1 : 0);
  const cliff = lerp(seaLevel - 6.5, height, smooth(-1.6, 0, inland));
  const sand =
    inland > 0
      ? lerp(seaLevel + 0.35, height, smooth(0, 8, inland))
      : lerp(seaLevel + 0.35, seaLevel - 3.5, smooth(0, -7, inland));
  const coast = lerp(cliff, sand, beach);
  // A level zone stays level up to the shore, whatever the beach does round it.
  return inland > 0 ? lerp(coast, height, 1 - smooth(1, 7, away)) : coast;
}

export function buildTerrain(plan: ITerrainPlan): ITerrain {
  const { minX, maxX, minZ, maxZ } = TERRAIN_BOUNDS;
  const field = Heightfield.fromSampler({
    columns: maxX - minX + 1,
    depth: maxZ - minZ,
    origin: { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2 },
    rows: maxZ - minZ + 1,
    sampleHeight: (x, z) => shape(plan, x, z),
    width: maxX - minX,
  });
  const inside = (x: number, z: number): boolean =>
    x >= minX && x <= maxX && z >= minZ && z <= maxZ;
  const seaFloor = plan.seaLevel - 6.5;
  return {
    field,
    flatness: (x, z) => (inside(x, z) ? field.normalAt(x, z).y : 1),
    ground: (x, z) => (inside(x, z) ? field.heightAt(x, z) : seaFloor),
    pathDistance: (x, z) =>
      Math.min(
        ...plan.paths.flatMap((path) =>
          path.slice(1).map((corner, i) => segmentDistance(x, z, path[i] ?? corner, corner)),
        ),
      ),
  };
}
