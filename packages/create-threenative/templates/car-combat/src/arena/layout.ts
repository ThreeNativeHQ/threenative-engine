// The arena is one closed stadium circuit on an open walled floor: two straights joined by two
// half circles. Everything that places a car, a gate or a pad reads this file, so the geometry
// has one owner. Distances are metres. The nose of a car points down -z; a heading of (fx, fz)
// is the three.js yaw `atan2(-fx, -fz)`.

/** Half length of each straight, and the radius of each end turn, on the circuit's centre line. */
export const STRAIGHT = 80;
export const TURN = 42;
export const ROAD_HALF = 8;
export const LAP_LENGTH = 4 * STRAIGHT + 2 * Math.PI * TURN;
/** Half extents of the walled floor. */
export const FLOOR = { x: STRAIGHT + TURN + 34, z: TURN + 38 } as const;
export const WALL = { height: 1.6, thickness: 2 } as const;

export interface IPathPoint {
  readonly x: number;
  readonly z: number;
  /** Unit heading along the circuit. */
  readonly fx: number;
  readonly fz: number;
}

/** The point `s` metres along the centre line, wrapping the lap. s = 0 is the middle of the bottom straight. */
export function pathAt(distance: number): IPathPoint {
  const s = (((distance + STRAIGHT) % LAP_LENGTH) + LAP_LENGTH) % LAP_LENGTH;
  const straight = 2 * STRAIGHT;
  const arc = Math.PI * TURN;
  // s = 0 is the straight's west end here; the shift above puts s = 0 of the caller at its middle.
  if (s < straight) return { fx: 1, fz: 0, x: -STRAIGHT + s, z: TURN };
  if (s < straight + arc) {
    const phi = (s - straight) / TURN;
    return {
      fx: Math.cos(phi),
      fz: -Math.sin(phi),
      x: STRAIGHT + TURN * Math.sin(phi),
      z: TURN * Math.cos(phi),
    };
  }
  if (s < 2 * straight + arc)
    return { fx: -1, fz: 0, x: STRAIGHT - (s - straight - arc), z: -TURN };
  const phi = (s - 2 * straight - arc) / TURN;
  return {
    fx: -Math.cos(phi),
    fz: Math.sin(phi),
    x: -STRAIGHT - TURN * Math.sin(phi),
    z: -TURN * Math.cos(phi),
  };
}

export function yawOf(point: Pick<IPathPoint, "fx" | "fz">): number {
  return Math.atan2(-point.fx, -point.fz);
}

/**
 * Where on the lap a car at (x, z) is, searched in a window around its last known distance so a
 * car on the far straight is never mistaken for one beside it.
 */
export function trackDistance(x: number, z: number, from: number): number {
  let best = from;
  let bestSq = Number.POSITIVE_INFINITY;
  for (let s = from - 12; s <= from + 48; s += 2) {
    const p = pathAt(s);
    const sq = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (sq < bestSq) {
      bestSq = sq;
      best = s;
    }
  }
  return best;
}

/** Six gates, evenly spaced. Gate 0 is the start and finish line. */
export const GATES = 6;
export const GATE_SPACING = LAP_LENGTH / GATES;

export function gateAt(index: number): IPathPoint {
  return pathAt(index * GATE_SPACING);
}

/** Repair pads in the infield, off the road, with the radius that counts as standing on one. */
export const PADS = [
  { radius: 5, x: 0, z: 0 },
  { radius: 5, x: 62, z: -4 },
] as const;

/** Concrete blocks in the infield: bodies for a car to hit and rivals to bounce off. */
export const BLOCKS = [
  { depth: 6, height: 2, width: 6, x: -34, z: 6 },
  { depth: 6, height: 2, width: 6, x: 22, z: -14 },
  { depth: 4, height: 2, width: 10, x: -8, z: 18 },
] as const;
