import { CatmullRomCurve3, Vector3 } from "three";

/**
 * The circuit, once.
 *
 * Every other thing on this track — the road mesh, the kerbs, the run-off, the barriers, the pit
 * lane, the lap gates, the sectors, the rescue points, the rival's line and the autopilot's line —
 * is read off {@link CIRCUIT}. The old build drew the road as boxes between five hand-typed route
 * points and drove a *different* curve, and the two drifted: the racing line bulged 4.5 m off the
 * tarmac and the rival drove into the tyre walls. There is one centreline here, and nothing else
 * in the template is allowed to name a coordinate of its own.
 *
 * ## The layout
 *
 * One lap, about 850 m, a teardrop with a real circuit's grammar: a long front straight, a fast
 * right-hand sweeper (R 77 m) that tightens (R 55 m) into a left kink, a short straight, a 180-degree
 * hairpin (R 16 m) at the far end, a run back with a four-corner esses section (R 55 m, alternating),
 * and a wide last corner (R 45 m, 139 degrees) that feeds the front straight. The tarmac climbs and
 * falls with {@link groundHeight}, so the straight runs downhill and the hairpin sits in a hollow.
 *
 * Every corner is an arc of a chosen radius and the two straights were solved so the loop closes;
 * the layout is kept because it was **measured**: no two parts of the circuit come within 45 m of
 * each other across more than 130 m of road, and the tightest radius is the hairpin.
 */

/** The control points, in metres, in driving order. Closed: the last point joins the first.
 *  Laid out from arcs and straights (each turn's radius and angle chosen, then the two straights
 *  solved so the loop closes), so every corner is a real arc and none is a chord of the world grid. */
const CONTROL: readonly (readonly [number, number])[] = [
  [-120.0, 100.0],
  [-77.1, 100.0],
  [-34.3, 100.0],
  [8.6, 100.0],
  [47.3, 110.4],
  [75.6, 138.8],
  [85.9, 177.6],
  [85.7, 214.1],
  [94.0, 253.3],
  [117.8, 285.5],
  [130.0, 296.3],
  [134.7, 303.4],
  [135.2, 311.9],
  [131.5, 319.5],
  [124.3, 324.3],
  [115.8, 324.8],
  [108.2, 321.0],
  [82.0, 298.0],
  [55.8, 274.9],
  [41.6, 265.8],
  [25.3, 261.5],
  [9.0, 257.1],
  [-5.3, 248.0],
  [-27.5, 236.1],
  [-52.6, 235.4],
  [-77.8, 234.6],
  [-99.9, 222.7],
  [-124.8, 200.8],
  [-149.8, 178.8],
  [-162.1, 161.1],
  [-164.7, 139.7],
  [-157.1, 119.5],
  [-140.9, 105.2],
];

/** Metres between samples of the centreline. Everything sampled coarser than this reads a corner
 *  as a straight, and the road mesh built on it cuts the apex. */
const SPACING = 1.1;

/** Half-width, in samples, of the curvature box filter. See the constructor for why. */
const SMOOTH_RADIUS = 10;

/** Tarmac width. 9 m is two cars wide and leaves room for a run-off on each side. */
export const TRACK_WIDTH = 9;
/** Half the tarmac width: the offset every other surface on the circuit is measured from. */
export const HALF = TRACK_WIDTH / 2;

/** How proud of the tarmac the kerb stands. 50-80 mm is real kerbing and the chassis collider
 * clears it, so a wheel rides over it instead of stopping dead: measured, 80 mm lifts the car 8 mm
 * and costs no speed, and 120 mm stops it. */
export const KERB_HEIGHT = 0.05;
export const KERB_WIDTH = 1.1;

/** Paved run-off beyond the white line, then the barrier. A circuit with no run-off is a wall
 * with a tarmac stripe on it, and a car that runs wide deserves somewhere to lose a lap. */
export const RUNOFF = 6.5;
export const BARRIER_OFFSET = RUNOFF + 1.2;

/**
 * How proud of the terrain the tarmac sits, in metres.
 *
 * The terrain grid samples {@link terrainHeight}, which already follows the banked road plane
 * inside the corridor, so this only has to cover the grid's own interpolation error across a 5 m
 * cell where the bank is bending back to the open terrain — measured at 0.07 m. A tenth of a metre
 * reads as a kerb-height lip at the edge of the tarmac, which is what a real circuit is.
 */
export const ROAD_LIFT = 0.12;

/** How far from the centreline the terrain is the road's own banked plane, and where it is the
 * open ground again. Between the two the ground is cut and filled to meet the banking. */
const CORRIDOR = HALF + RUNOFF;
const BLEND_END = CORRIDOR + 14;

/** The circuit's footprint, so the far field skips the projection entirely. */
const BOUNDS = {
  maxX: Number.NEGATIVE_INFINITY,
  maxZ: Number.NEGATIVE_INFINITY,
  minX: Number.POSITIVE_INFINITY,
  minZ: Number.POSITIVE_INFINITY,
};

/**
 * Banking, and the radii it applies between.
 *
 * `curvature * gain` reaches the ceiling by a 30 m radius, and the ceiling is faded back to nothing
 * by 20 m — so a fast sweeper is banked and a hairpin is flat, which is both what the brief asks
 * for ("camber/banking on the big corners") and what a real circuit does. It also removes a real
 * defect: a 6.8-degree bank across a 15 m hairpin is a 1.1 m height difference between the inside
 * and the outside of the corner, and the cut-and-fill terrain has to follow all of it.
 */
const BANK_GAIN = 4;
const MAX_BANK_TAN = 0.12;
const BANK_NONE_RADIUS = 20;
const BANK_FULL_RADIUS = 55;

function bankFade(radius: number): number {
  if (!Number.isFinite(radius) || radius >= BANK_FULL_RADIUS) return 1;
  if (radius <= BANK_NONE_RADIUS) return 0;
  const fade = (radius - BANK_NONE_RADIUS) / (BANK_FULL_RADIUS - BANK_NONE_RADIUS);
  return fade * fade * (3 - 2 * fade);
}

/**
 * The ground the circuit is laid on: three slow sines, ±7.5 m, never steeper than about 3%.
 *
 * A flat circuit reads as a car on a table. This is what makes the main straight look like it
 * falls away and the hairpin sit in a hollow, and it costs one function: the road mesh, the
 * run-off, the barriers, the trees and the rescue ray all call it, so the car can never be
 * airborne over a crest the ground does not have.
 */
export function groundHeight(x: number, z: number): number {
  return 3.5 * Math.sin(x / 220) + 2.5 * Math.cos((z + 141) / 170) + 1.5 * Math.sin((x + z) / 250);
}

export interface ICircuitSample {
  /** The centreline point, on the terrain. */
  point: Vector3;
  /** Unit tangent, flattened: which way this part of the circuit runs. */
  tangent: Vector3;
  /** The unit vector to the **driver's right**, flattened. */
  right: Vector3;
  /** The left and right tarmac edges, already banked. */
  left: Vector3;
  rightEdge: Vector3;
  /** Signed curvature in 1/m: positive turns toward `right`, so a right-hand corner is positive. */
  curvature: number;
  /** The signed radius, or `Infinity` on a straight. */
  radius: number;
  /** `tan` of the banking angle, positive raising the outside edge of a right-hand corner. */
  bank: number;
}

/** Reused by {@link CircuitLine.project} so a projection allocates nothing per frame. */
const projectScratch = new Vector3();

function wrapAngle(value: number): number {
  let angle = value;
  while (angle > Math.PI) angle -= 2 * Math.PI;
  while (angle < -Math.PI) angle += 2 * Math.PI;
  return angle;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/**
 * The centreline, resampled to a dense polyline and measured.
 *
 * `PathFollow3D` is the right tool for a route a car *follows*, and it is what the sibling
 * templates use — but it projects a car onto 128 samples, which on an 830 m circuit is one sample
 * every 6.5 m. The rival and the autopilot aim at a point 3 m ahead of where they are, so a 6.5 m
 * quantisation put the aim point off the road. This is the same idea at 1.1 m, and it is also the
 * geometry the road is built from, so "the line the car drives" and "the tarmac under it" are the
 * same array.
 */
export class CircuitLine {
  readonly totalLength: number;
  readonly count: number;
  readonly spacing: number;
  readonly #points: Vector3[] = [];
  readonly #tangents: Vector3[] = [];
  readonly #rights: Vector3[] = [];
  readonly #curvature: number[] = [];
  readonly #scratch: ICircuitSample = {
    bank: 0,
    curvature: 0,
    left: new Vector3(),
    point: new Vector3(),
    radius: Number.POSITIVE_INFINITY,
    right: new Vector3(),
    rightEdge: new Vector3(),
    tangent: new Vector3(),
  };

  constructor(control: readonly (readonly [number, number])[]) {
    if (control.length < 4) throw new Error("CircuitLine needs at least four control points.");
    const curve = new CatmullRomCurve3(
      control.map(([x, z]) => new Vector3(x, 0, z)),
      true,
      "centripetal",
      0.5,
    );
    const total = curve.getLengths(4000).at(-1) ?? 0;
    if (!(total > 0)) throw new Error("CircuitLine requires a positive-length circuit.");
    this.totalLength = total;
    const count = Math.max(16, Math.round(total / SPACING));
    this.count = count;
    this.spacing = total / count;
    // `getSpacedPoints` returns one more point than asked for on a closed curve, and the extra one
    // is the first one again. Dropping it is not cosmetic: leaving the duplicate in is what gave an
    // earlier draft a 0.3 m radius at s = 0 and a 0.9 m self-approach across the seam.
    const spaced = curve.getSpacedPoints(this.count);
    for (let index = 0; index < this.count; index += 1) {
      const point = spaced[index];
      if (point === undefined) throw new Error("CircuitLine sample is missing.");
      this.#points.push(new Vector3(point.x, groundHeight(point.x, point.z) + ROAD_LIFT, point.z));
    }
    const raw: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const before = this.#points[(index - 1 + count) % count];
      const here = this.#points[index];
      const after = this.#points[(index + 1) % count];
      if (before === undefined || here === undefined || after === undefined)
        throw new Error("CircuitLine sample is missing.");
      const tangent = new Vector3().subVectors(after, before).setY(0);
      if (tangent.lengthSq() < 1e-9) throw new Error("CircuitLine has a zero-length segment.");
      this.#tangents.push(tangent.normalize());
      this.#rights.push(new Vector3(-tangent.z, 0, tangent.x));
      const turn = wrapAngle(
        Math.atan2(after.z - here.z, after.x - here.x) -
          Math.atan2(here.z - before.z, here.x - before.x),
      );
      raw.push(turn / (2 * this.spacing));
    }
    // The curvature is smoothed before anything reads it, because the **banking** is derived from
    // it and a ray-cast vehicle has no body roll: its chassis stays level while the surface under it
    // tilts, so a camber that changes over two metres compresses one side's strut to its stop and
    // the car beaches on two wheels. A real circuit's camber changes over tens of metres, and so
    // does this one: a nine-tap box over 1.1 m stations is a 10 m window.
    for (let index = 0; index < count; index += 1) {
      let total = 0;
      for (let step = -SMOOTH_RADIUS; step <= SMOOTH_RADIUS; step += 1) {
        total += raw[(index + step + count) % count] ?? 0;
      }
      this.#curvature.push(total / (SMOOTH_RADIUS * 2 + 1));
    }
  }

  /** The point at `distance` metres around the lap, filling and returning `target`. */
  at(distance: number, target: ICircuitSample = this.#scratch): ICircuitSample {
    const wrapped = ((distance % this.totalLength) + this.totalLength) % this.totalLength;
    const position = wrapped / this.spacing;
    const index = Math.floor(position) % this.count;
    const next = (index + 1) % this.count;
    const blend = position - Math.floor(position);
    const here = this.#points[index];
    const there = this.#points[next];
    if (here === undefined || there === undefined)
      throw new Error("CircuitLine sample is missing.");
    const tangentHere = this.#tangents[index];
    const tangentThere = this.#tangents[next];
    const curvatureHere = this.#curvature[index];
    const curvatureThere = this.#curvature[next];
    if (
      tangentHere === undefined ||
      tangentThere === undefined ||
      curvatureHere === undefined ||
      curvatureThere === undefined
    )
      throw new Error("CircuitLine sample is missing.");
    target.point.lerpVectors(here, there, blend);
    target.tangent.lerpVectors(tangentHere, tangentThere, blend).normalize();
    target.right.set(-target.tangent.z, 0, target.tangent.x);
    target.curvature = curvatureHere * (1 - blend) + curvatureThere * blend;
    target.radius =
      Math.abs(target.curvature) < 1e-6 ? Number.POSITIVE_INFINITY : 1 / Math.abs(target.curvature);
    target.bank =
      clamp(target.curvature * BANK_GAIN, -MAX_BANK_TAN, MAX_BANK_TAN) * bankFade(target.radius);
    const rise = target.bank * HALF;
    target.left.copy(target.point).addScaledVector(target.right, -HALF);
    target.left.y += rise;
    target.rightEdge.copy(target.point).addScaledVector(target.right, HALF);
    target.rightEdge.y -= rise;
    return target;
  }

  /**
   * A sample the caller **keeps**.
   *
   * {@link at} without a target fills one shared scratch, so reading two samples "at once" gives
   * the same object twice. The road builder keeps 750 of them, and the racing line keeps one per
   * frame, so both ask for their own.
   */
  createSample(): ICircuitSample {
    return {
      bank: 0,
      curvature: 0,
      left: new Vector3(),
      point: new Vector3(),
      radius: Number.POSITIVE_INFINITY,
      right: new Vector3(),
      rightEdge: new Vector3(),
      tangent: new Vector3(),
    };
  }

  /**
   * Where a world position sits on the circuit: the distance around the lap, how far to the side
   * of the centreline it is (positive on the driver's right) and the closest point on the line.
   */
  project(
    position: Vector3,
    target: {
      distance: number;
      lateral: number;
      point: Vector3;
      tangent: Vector3;
      curvature: number;
    },
  ): { distance: number; lateral: number; point: Vector3; tangent: Vector3; curvature: number } {
    if (![position.x, position.y, position.z].every(Number.isFinite))
      throw new Error("CircuitLine projection position must be finite.");
    let nearest = Number.POSITIVE_INFINITY;
    let index = 0;
    for (let scan = 0; scan < this.count; scan += 1) {
      const point = this.#points[scan];
      if (point === undefined) throw new Error("CircuitLine sample is missing.");
      const gap = (point.x - position.x) ** 2 + (point.z - position.z) ** 2;
      if (gap < nearest) {
        nearest = gap;
        index = scan;
      }
    }
    // Refine inside the winning segment **and its neighbours**, so the answer is a point on the
    // road rather than the nearest 1.1 m sample. Clamping to the winning segment alone is off by up
    // to a whole sample whenever the car is nearer the one before it, and half a sample of aim
    // error is a metre of the racing line on a 14 m corner.
    let bestAlong = 0;
    let bestSegment = index;
    let bestGap = Number.POSITIVE_INFINITY;
    for (let step = -1; step <= 1; step += 1) {
      const at = (index + step + this.count) % this.count;
      const from = this.#points[at];
      const to = this.#points[(at + 1) % this.count];
      if (from === undefined || to === undefined) throw new Error("CircuitLine sample is missing.");
      const spanX = to.x - from.x;
      const spanZ = to.z - from.z;
      const spanSq = spanX * spanX + spanZ * spanZ;
      const along =
        spanSq > 1e-9
          ? clamp(((position.x - from.x) * spanX + (position.z - from.z) * spanZ) / spanSq, 0, 1)
          : 0;
      const gap =
        (from.x + spanX * along - position.x) ** 2 + (from.z + spanZ * along - position.z) ** 2;
      if (gap < bestGap) {
        bestGap = gap;
        bestAlong = along;
        bestSegment = at;
      }
    }
    const from = this.#points[bestSegment];
    const to = this.#points[(bestSegment + 1) % this.count];
    if (from === undefined || to === undefined) throw new Error("CircuitLine sample is missing.");
    target.point.lerpVectors(from, to, bestAlong);
    target.tangent.set(to.x - from.x, 0, to.z - from.z);
    const fallback = this.#tangents[bestSegment];
    if (fallback === undefined) throw new Error("CircuitLine sample is missing.");
    if (target.tangent.lengthSq() < 1e-9) target.tangent.copy(fallback);
    else target.tangent.normalize();
    const right = projectScratch.set(-target.tangent.z, 0, target.tangent.x);
    target.lateral =
      (position.x - target.point.x) * right.x + (position.z - target.point.z) * right.z;
    target.distance = (bestSegment + bestAlong) * this.spacing;
    const curvature = this.#curvature[bestSegment];
    if (curvature === undefined) throw new Error("CircuitLine sample is missing.");
    target.curvature = curvature;
    return target;
  }
}

/** The circuit. One instance, built once, read by everything. */
export const CIRCUIT = new CircuitLine(CONTROL);

for (let index = 0; index < CIRCUIT.count; index += 1) {
  const point = CIRCUIT.at(
    (index * CIRCUIT.totalLength) / CIRCUIT.count,
    CIRCUIT.createSample(),
  ).point;
  BOUNDS.minX = Math.min(BOUNDS.minX, point.x);
  BOUNDS.maxX = Math.max(BOUNDS.maxX, point.x);
  BOUNDS.minZ = Math.min(BOUNDS.minZ, point.z);
  BOUNDS.maxZ = Math.max(BOUNDS.maxZ, point.z);
}

const terrainSample = CIRCUIT.createSample();
const terrainProjection = {
  curvature: 0,
  distance: 0,
  lateral: 0,
  point: new Vector3(),
  tangent: new Vector3(),
};

/**
 * The ground's height: the road's own banked plane beside the circuit, the open terrain beyond it.
 *
 * This is the cut and fill a banked corner actually is. The alternative — a road that simply tilts
 * on top of a smooth hill — puts one edge of the tarmac **below** the grass, and the ground then
 * pokes through the racing line exactly where the corner is banked most. Measured: the autopilot
 * drove into the rising edge of the buried tarmac at the exit of the hairpin and stopped dead.
 */
export function terrainHeight(x: number, z: number): number {
  const open = groundHeight(x, z);
  if (
    x < BOUNDS.minX - BLEND_END ||
    x > BOUNDS.maxX + BLEND_END ||
    z < BOUNDS.minZ - BLEND_END ||
    z > BOUNDS.maxZ + BLEND_END
  )
    return open;
  const projection = CIRCUIT.project(new Vector3(x, 0, z), terrainProjection);
  const lateral = Math.abs(projection.lateral);
  if (lateral > BLEND_END) return open;
  const centre = CIRCUIT.at(projection.distance, terrainSample);
  const plane = centre.point.y - ROAD_LIFT - projection.lateral * centre.bank;
  if (lateral <= CORRIDOR) return plane;
  const blend = (lateral - CORRIDOR) / (BLEND_END - CORRIDOR);
  return plane + (open - plane) * blend * blend * (3 - 2 * blend);
}

/** Where the start/finish line, the sectors and the grid are, as a fraction of the lap. */
export const LINE_AT = {
  finish: 0.06,
  gridFar: 0.052,
  gridNear: 0.042,
  sector1: 0.28,
  sector2: 0.55,
} as const;

/**
 * The starting grid: the player second, the rival on pole, both on the main straight and both
 * short of the line, so the first gate either car meets is the one the lap is counted on.
 *
 * `player` sits 2.2 m to the left of the centreline and `rival` 2.2 m to the right, and the rival
 * is the further down the straight. Two metres aside on a 9 m road is two cars side by side and a
 * clear line between them — the old grid put both cars on the racing line, which is a rear-end at
 * the first corner.
 */
export const GRID = { player: -2.2, rival: 2.2 } as const;

export const GRID_DISTANCE = {
  player: lineDistance(LINE_AT.gridNear),
  rival: lineDistance(LINE_AT.gridFar),
} as const;

export function lineDistance(fraction: number): number {
  return fraction * CIRCUIT.totalLength;
}
