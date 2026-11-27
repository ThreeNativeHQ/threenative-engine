// The city as data: roads, blocks, the directed lane graph traffic drives on, the sidewalk loops
// pedestrians walk, and the named places (hospital, police, respray, job sites). No Three.js
// meshes here — `render/city.ts` draws this, `scenes/Play.ts` plays on it.
import { Vector3 } from "three";

/**
 * Roads per axis. Ten roads make a 9 x 9 grid of blocks, about 460 m across: too much to keep
 * built at once, so `systems/streaming.ts` builds the blocks near the player and an instanced skyline
 * stands in for the rest.
 */
export const ROADS = 10;
/**
 * The first road of downtown, the 3 x 3 blocks in the middle that hold every landmark. Index
 * `DOWNTOWN + 1` is the road just west (or north) of the centre block.
 */
export const DOWNTOWN = 3;
/** Centre-line to centre-line spacing of two parallel roads, in metres. */
export const PITCH = 48;
/** Kerb to kerb. Two lanes, one each way. */
export const ROAD_WIDTH = 12;
/** A lane centre sits this far right of the road's centre line (right-hand traffic). */
export const LANE_OFFSET = 2.75;
/** The sidewalk ring around each block, inside the kerb, and its kerb height. */
export const SIDEWALK = 3;
export const KERB = 0.15;
/** Lanes start and end this far from the intersection centre: the stop line. */
export const STOP_LINE = ROAD_WIDTH / 2 + 1;
/** Half the city's road grid, kerb to kerb, plus the outer sidewalk. */
export const CITY_HALF = (PITCH * (ROADS - 1)) / 2 + ROAD_WIDTH / 2;
/** A wall at this distance keeps everything inside the map. */
export const BOUNDARY = CITY_HALF + 10;

/** Road centre line `index` (0..ROADS-1), on either axis. */
export function roadLine(index: number): number {
  return (index - (ROADS - 1) / 2) * PITCH;
}

export interface IBlock {
  readonly i: number;
  readonly j: number;
  readonly center: Vector3;
  /** Kerb to kerb, in metres. */
  readonly size: number;
  readonly kind: "buildings" | "plaza" | "hospital" | "police" | "respray" | "dropoff";
}

/** The named blocks; every other block holds four buildings. */
const SPECIAL: Readonly<Record<string, IBlock["kind"]>> = {
  [`${DOWNTOWN + 1},${DOWNTOWN + 1}`]: "plaza",
  [`${DOWNTOWN},${DOWNTOWN}`]: "hospital",
  [`${DOWNTOWN + 2},${DOWNTOWN + 2}`]: "police",
  [`${DOWNTOWN + 2},${DOWNTOWN}`]: "respray",
  [`${DOWNTOWN},${DOWNTOWN + 2}`]: "dropoff",
};

export const BLOCKS: readonly IBlock[] = (() => {
  const out: IBlock[] = [];
  for (let i = 0; i < ROADS - 1; i += 1)
    for (let j = 0; j < ROADS - 1; j += 1)
      out.push({
        center: new Vector3(
          (roadLine(i) + roadLine(i + 1)) / 2,
          0,
          (roadLine(j) + roadLine(j + 1)) / 2,
        ),
        i,
        j,
        kind: SPECIAL[`${i},${j}`] ?? "buildings",
        size: PITCH - ROAD_WIDTH,
      });
  return out;
})();

export function block(kind: IBlock["kind"]): IBlock {
  const found = BLOCKS.find((candidate) => candidate.kind === kind);
  if (found === undefined) throw new Error(`No block of kind '${kind}'.`);
  return found;
}

/**
 * The places the game uses, each on a sidewalk or a kerb-side lane so a respawn never lands inside
 * a building. `respray` is the drive-in pad on the respray block's road edge.
 */
export const PLACES = {
  hospital: block("hospital")
    .center.clone()
    .add(new Vector3(0, 0, block("hospital").size / 2 - 1.5)),
  police: block("police")
    .center.clone()
    .add(new Vector3(0, 0, -block("police").size / 2 + 1.5)),
  respray: new Vector3(
    block("respray").center.x,
    0,
    block("respray").center.z + block("respray").size / 2 - 4,
  ),
  phone: block("plaza")
    .center.clone()
    .add(new Vector3(-2.5, 0, 2.5)),
  dropoff: block("dropoff")
    .center.clone()
    .add(new Vector3(0, 0, -block("dropoff").size / 2 + 5)),
  playerSpawn: block("plaza")
    .center.clone()
    .add(new Vector3(0, 0, block("plaza").size / 2 - 1.5)),
} as const;

/** An intersection: where two road centre lines cross. */
export interface INode {
  readonly id: number;
  readonly i: number;
  readonly j: number;
  readonly position: Vector3;
}

/**
 * One directed lane from intersection `from` to `to`: a straight run between the two stop lines,
 * on the right-hand side of travel.
 */
export interface ILane {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  /** Unit direction of travel. */
  readonly direction: Vector3;
  readonly start: Vector3;
  readonly end: Vector3;
}

export const NODES: readonly INode[] = (() => {
  const out: INode[] = [];
  for (let i = 0; i < ROADS; i += 1)
    for (let j = 0; j < ROADS; j += 1)
      out.push({ i, id: i * ROADS + j, j, position: new Vector3(roadLine(i), 0, roadLine(j)) });
  return out;
})();

/** The right-hand side of a direction of travel on the XZ plane (forward -z has right +x). */
export function rightOf(direction: Vector3, out = new Vector3()): Vector3 {
  return out.set(-direction.z, 0, direction.x);
}

export const LANES: readonly ILane[] = (() => {
  const out: ILane[] = [];
  for (const from of NODES)
    for (const to of NODES) {
      if (Math.abs(from.i - to.i) + Math.abs(from.j - to.j) !== 1) continue;
      const direction = to.position.clone().sub(from.position).normalize();
      const right = rightOf(direction).multiplyScalar(LANE_OFFSET);
      out.push({
        direction,
        end: to.position.clone().addScaledVector(direction, -STOP_LINE).add(right),
        from: from.id,
        id: out.length,
        start: from.position.clone().addScaledVector(direction, STOP_LINE).add(right),
        to: to.id,
      });
    }
  return out;
})();

/** Lanes leaving each node, indexed by node id. */
export const LANES_FROM: readonly (readonly ILane[])[] = NODES.map((node) =>
  LANES.filter((lane) => lane.from === node.id),
);

/**
 * The lanes a car may take on reaching `lane.to`: every exit but the U-turn back where it came
 * from. A corner of the grid has one; a T has two; a crossroads three.
 */
export function exitsOf(lane: ILane): readonly ILane[] {
  return (LANES_FROM[lane.to] ?? []).filter((next) => next.to !== lane.from);
}

/**
 * The turn through an intersection, as points on a quadratic curve from one lane's end to the
 * next lane's start. Its control point is where the two lane lines cross, so a straight-on run is
 * a line and a turn is a smooth arc that stays on its own side of the box.
 */
export function turnPoints(from: ILane, to: ILane, steps = 6): Vector3[] {
  const a = from.end;
  const b = to.start;
  const cross = from.direction.x * to.direction.z - from.direction.z * to.direction.x;
  // Parallel lanes (straight on): the midpoint is the control point.
  let control: Vector3;
  if (Math.abs(cross) < 1e-6) control = a.clone().add(b).multiplyScalar(0.5);
  else {
    // a + t * d1 = b - s * d2, solved for t on the XZ plane.
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const t = (dx * to.direction.z - dz * to.direction.x) / cross;
    control = a.clone().addScaledVector(from.direction, t);
  }
  const points: Vector3[] = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const u = 1 - t;
    points.push(
      new Vector3(
        u * u * a.x + 2 * u * t * control.x + t * t * b.x,
        0,
        u * u * a.z + 2 * u * t * control.z + t * t * b.z,
      ),
    );
  }
  return points;
}

/** The lane whose straight run passes nearest `point`, and how far along it the point is. */
export function nearestLane(point: Vector3): { lane: ILane; along: number; distance: number } {
  let best = { along: 0, distance: Number.POSITIVE_INFINITY, lane: LANES[0] as ILane };
  for (const lane of LANES) {
    const length = lane.start.distanceTo(lane.end);
    const along = Math.min(
      length,
      Math.max(
        0,
        (point.x - lane.start.x) * lane.direction.x + (point.z - lane.start.z) * lane.direction.z,
      ),
    );
    const x = lane.start.x + lane.direction.x * along - point.x;
    const z = lane.start.z + lane.direction.z * along - point.z;
    const distance = Math.hypot(x, z);
    if (distance < best.distance) best = { along, distance, lane };
  }
  return best;
}

/**
 * Breadth-first lane route from `start` to the lane that ends nearest `goal`. Police use it to
 * drive the streets toward the player instead of straight through a building.
 */
export function routeToward(start: ILane, goal: Vector3): ILane[] {
  const target = nearestLane(goal).lane.id;
  const previous = new Map<number, number>([[start.id, -1]]);
  const queue = [start];
  while (queue.length > 0) {
    const lane = queue.shift() as ILane;
    if (lane.id === target) break;
    for (const next of exitsOf(lane)) {
      if (previous.has(next.id)) continue;
      previous.set(next.id, lane.id);
      queue.push(next);
    }
  }
  if (!previous.has(target)) return [start];
  const route: ILane[] = [];
  for (let id = target; id !== -1; id = previous.get(id) as number)
    route.unshift(LANES[id] as ILane);
  return route;
}

/** A sidewalk loop around one block, corners in walking order, on the sidewalk's centre line. */
export function sidewalkLoop(target: IBlock): Vector3[] {
  const half = target.size / 2 - SIDEWALK / 2;
  const { x, z } = target.center;
  return [
    new Vector3(x - half, KERB, z - half),
    new Vector3(x + half, KERB, z - half),
    new Vector3(x + half, KERB, z + half),
    new Vector3(x - half, KERB, z + half),
  ];
}

/** Whether a point stands on a sidewalk (inside a block, outside its building lot). */
export function onSidewalk(point: Vector3): boolean {
  for (const target of BLOCKS) {
    const dx = Math.abs(point.x - target.center.x);
    const dz = Math.abs(point.z - target.center.z);
    const half = target.size / 2;
    if (dx <= half && dz <= half && (dx > half - SIDEWALK || dz > half - SIDEWALK)) return true;
  }
  return false;
}
