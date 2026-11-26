// The AI behind the wheel. Every AI car is a real `Car` on the same suspension as the player's;
// these drivers only decide its pedal and its wheel angle.
import type { IRandom } from "@threenative/core";
import { MathUtils, Vector3 } from "three";
import {
  type ILane,
  LANES,
  exitsOf,
  nearestLane,
  routeToward,
  turnPoints,
  type INode,
  NODES,
} from "../city/layout.js";
import type { Car } from "../entities/Car.js";

/**
 * Traffic. Cruise speeds are GTA III's lane speeds, 9 to 14 m/s (MCP card
 * grand-theft-auto-iii-re3/traffic-cruise-speed); a rammed car panics at the 17 m/s an
 * emergency vehicle returns at (same card).
 */
export const TRAFFIC = {
  cruiseMin: 9,
  cruiseMax: 14,
  panic: 17,
  panicTime: 5,
  turnSpeed: 6,
  /** Bumper-to-bumper gap kept to whatever is ahead, in metres. */
  gap: 3,
  /** Half-width of the corridor ahead that counts as "in my lane". */
  corridor: 1.6,
  stuckTime: 3.5,
  reverseTime: 1.4,
} as const;

const WHEELBASE = 2.7;
/** Half the car's length: obstacles are measured from the nose. */
const NOSE = 2.1;

/** Anything a driver must not hit: another car, a person, the player. */
export interface IObstacle {
  readonly position: Vector3;
  /** Half its length along the driver's line, so a car ahead stops a car-length short. */
  readonly halfLength: number;
}

/**
 * Who holds each intersection. A car takes the box before it crosses the stop line and frees it
 * once it is past the turn; a car that finds the box taken waits at the line.
 */
export class Intersections {
  readonly #holder = new Map<number, Car>();

  take(node: number, car: Car): boolean {
    const holder = this.#holder.get(node);
    // A holder that left the box without freeing it (a wreck, a replan, a chase) loses it.
    const stale =
      holder !== undefined && holder.position.distanceTo((NODES[node] as INode).position) > 25;
    if (holder === undefined || holder === car || holder.wrecked || stale) {
      this.#holder.set(node, car);
      return true;
    }
    return false;
  }

  free(node: number, car: Car): void {
    if (this.#holder.get(node) === car) this.#holder.delete(node);
  }

  freeAll(car: Car): void {
    for (const [node, holder] of this.#holder) if (holder === car) this.#holder.delete(node);
  }
}

const _forward = new Vector3();
const _right = new Vector3();
const _to = new Vector3();
const _look = new Vector3();

/**
 * Follows the lane graph: a polyline of lane runs and intersection arcs, steered by pure pursuit
 * to a point one lookahead ahead, at a speed that respects the car ahead and the box it waits for.
 */
export class LaneDriver {
  readonly car: Car;
  cruise: number;
  /** Seconds of panic left after the player rammed this car. */
  panic = 0;
  /** Seconds the driver has wanted to move and could not, for the stuck recovery. */
  #stuck = 0;
  #reverse = 0;
  #points: Vector3[] = [];
  /** The lane each point belongs to, and the node it waits at (-1 inside a turn). */
  #laneOf: ILane[] = [];
  #lane: ILane;
  #heldNode = -1;
  #random: IRandom;
  blocked = false;

  constructor(car: Car, lane: ILane, random: IRandom) {
    this.car = car;
    this.#random = random;
    this.cruise = random.range(TRAFFIC.cruiseMin, TRAFFIC.cruiseMax);
    this.#lane = lane;
    this.restartOn(lane);
  }

  get lane(): ILane {
    return this.#lane;
  }

  /** Replan from the lane nearest the car, after a crash knocked it off its line. */
  replan(): void {
    this.restartOn(nearestLane(this.car.position).lane);
  }

  /**
   * Route along these lanes (police use this to drive the streets toward the player), then go on
   * at random once it runs out.
   */
  follow(lanes: readonly ILane[]): void {
    const first = lanes[0];
    if (first === undefined) return;
    this.#lane = first;
    this.#points = [first.end.clone()];
    this.#laneOf = [first];
    for (let index = 1; index < lanes.length; index += 1) {
      const from = lanes[index - 1] as ILane;
      const to = lanes[index] as ILane;
      for (const point of turnPoints(from, to)) {
        this.#points.push(point);
        this.#laneOf.push(from);
      }
      this.#points.push(to.end.clone());
      this.#laneOf.push(to);
    }
  }

  update(dt: number, obstacles: readonly IObstacle[], intersections: Intersections): void {
    const car = this.car;
    if (car.wrecked) {
      intersections.freeAll(car);
      car.hold();
      return;
    }
    this.panic = Math.max(0, this.panic - dt);
    if (this.#points.length < 4) this.#extend();
    const position = car.position;
    car.forward(_forward);
    _right.set(-_forward.z, 0, _forward.x);
    // Drop the points already passed: behind the nose, or within a metre and a half.
    while (this.#points.length > 1) {
      _to
        .copy(this.#points[0] as Vector3)
        .sub(position)
        .setY(0);
      if (_to.length() > 1.5 && _to.dot(_forward) > 0) break;
      this.#points.shift();
      this.#laneOf.shift();
      // The point now ahead belongs to a new lane once the last turn point is behind: the car
      // has left the box, so the box is free.
      const lane = this.#laneOf[0];
      if (lane !== undefined && lane !== this.#lane) {
        intersections.free(this.#lane.to, car);
        if (this.#heldNode === this.#lane.to) this.#heldNode = -1;
        this.#lane = lane;
      }
    }
    // Knocked far off the line: start again from the nearest lane.
    if (position.distanceTo(this.#points[0] as Vector3) > 18) this.replan();

    const speed = car.speed;
    if (this.#reverse > 0) {
      this.#reverse -= dt;
      car.driveAngle(-0.7, -this.#steerTo(this.#points[0] as Vector3, 6) * 0.5, dt);
      return;
    }
    const lookahead = MathUtils.clamp(4 + Math.abs(speed) * 0.45, 4, 12);
    const target = this.#pointAhead(lookahead);
    const angle = this.#steerTo(target, lookahead);

    let goal = this.panic > 0 ? TRAFFIC.panic : this.cruise;
    // Slow for a turn: the path a little ahead bends away from the nose.
    _look.copy(this.#pointAhead(14)).sub(position).setY(0).normalize();
    if (_look.dot(_forward) < 0.85) goal = Math.min(goal, TRAFFIC.turnSpeed);

    // The car ahead, the pedestrian on the crossing, the player in the road.
    let clear = Number.POSITIVE_INFINITY;
    for (const obstacle of obstacles) {
      _to.copy(obstacle.position).sub(position).setY(0);
      const ahead = _to.dot(_forward) - NOSE - obstacle.halfLength;
      if (ahead < -1 || ahead > 30) continue;
      if (Math.abs(_to.dot(_right)) > TRAFFIC.corridor + 0.5) continue;
      clear = Math.min(clear, ahead);
    }
    this.blocked = clear < 20;
    // Brake late and firm like a driver: the speed that still stops at the gap at a steady 4 m/s².
    if (this.panic === 0) goal = Math.min(goal, Math.sqrt(8 * Math.max(0, clear - TRAFFIC.gap)));

    // The box: take it before the stop line, or wait at the line.
    const toLine = this.#distanceToStopLine();
    if (toLine !== undefined && toLine < 12) {
      if (intersections.take(this.#lane.to, car)) this.#heldNode = this.#lane.to;
      else if (this.panic === 0) goal = Math.min(goal, Math.sqrt(8 * Math.max(0, toLine - 1)));
    }

    if (goal < 0.3 && Math.abs(speed) < 0.6) {
      car.hold();
      this.#stuck = 0;
      return;
    }
    // Stuck against something it cannot see (a wall after a crash): back off, then try again.
    if (goal > 3 && Math.abs(speed) < 0.5) this.#stuck += dt;
    else this.#stuck = 0;
    if (this.#stuck > TRAFFIC.stuckTime) {
      this.#stuck = 0;
      this.#reverse = TRAFFIC.reverseTime;
    }
    car.driveAngle(MathUtils.clamp((goal - speed) * 0.45, -1, 1), angle, dt);
  }

  /** Metres from the nose to this lane's stop line, or undefined once past it. */
  #distanceToStopLine(): number | undefined {
    if (this.#laneOf[0] !== this.#lane) return undefined;
    _to.copy(this.#lane.end).sub(this.car.position);
    const along = _to.dot(this.#lane.direction) - NOSE;
    return along < -2 ? undefined : along;
  }

  /** Pure pursuit: the wheel angle that arcs the rear axle through `target`. */
  #steerTo(target: Vector3, lookahead: number): number {
    _to.copy(target).sub(this.car.position).setY(0);
    const x = _to.dot(_right);
    const z = _to.dot(_forward);
    const alpha = Math.atan2(x, Math.max(z, 0.1));
    return Math.atan2(2 * WHEELBASE * Math.sin(alpha), Math.max(lookahead, _to.length()));
  }

  /** The point `distance` metres along the route from the car. */
  #pointAhead(distance: number): Vector3 {
    let left = distance;
    let from = this.car.position;
    for (const point of this.#points) {
      const step = Math.hypot(point.x - from.x, point.z - from.z);
      if (step >= left) return _look.copy(point).sub(from).setY(0).setLength(left).add(from);
      left -= step;
      from = point;
    }
    return this.#points[this.#points.length - 1] as Vector3;
  }

  /** Drive `lane` from where the car is now, forgetting the old route. */
  restartOn(lane: ILane): void {
    this.#lane = lane;
    this.#points = [lane.end.clone()];
    this.#laneOf = [lane];
  }

  #extend(): void {
    const last = this.#laneOf[this.#laneOf.length - 1] ?? this.#lane;
    const exits = exitsOf(last);
    const next = exits.length > 0 ? this.#random.pick(exits) : (LANES[0] as ILane);
    // The turn belongs to the lane it leaves, so the box is freed only once the car is out of it.
    for (const point of turnPoints(last, next)) {
      this.#points.push(point);
      this.#laneOf.push(last);
    }
    this.#points.push(next.end.clone());
    this.#laneOf.push(next);
  }
}

/**
 * The police driver: the streets toward the player while far, then straight at them once close
 * and in sight — a ram, or a stop beside a player on foot so the officers can get out.
 */
/** A charging cruiser below `speed` m/s for `time` s backs off for `reverse` s. */
const CHARGE_STUCK = { speed: 1, time: 1.5, reverse: 1 } as const;

export class PursuitDriver {
  readonly lanes: LaneDriver;
  #replanIn = 0;
  /** True once close enough to the player that the officers should get out. */
  arrived = false;
  /** False at the cap of officers on foot: the cruiser keeps up the chase instead of stopping. */
  deploy = true;
  /** Seconds charging without moving, and the back-off it triggers (Guard's STUCK_TIME pattern). */
  #stuck = 0;
  #backOff = 0;

  constructor(car: Car, lane: ILane, random: IRandom) {
    this.lanes = new LaneDriver(car, lane, random);
    this.lanes.cruise = 20;
  }

  get car(): Car {
    return this.lanes.car;
  }

  update(
    dt: number,
    player: Vector3,
    playerOnFoot: boolean,
    seesPlayer: boolean,
    obstacles: readonly IObstacle[],
    intersections: Intersections,
  ): void {
    const car = this.car;
    if (car.wrecked) {
      car.hold();
      return;
    }
    const distance = car.position.distanceTo(player);
    this.arrived = this.deploy && playerOnFoot && seesPlayer && distance < 12;
    if (this.arrived) {
      car.hold();
      return;
    }
    if (seesPlayer && distance < 35) {
      // In sight and close: drive straight at the player. A car sitting still gets rammed.
      car.forward(_forward);
      _right.set(-_forward.z, 0, _forward.x);
      _to.copy(player).sub(car.position).setY(0);
      const alpha = Math.atan2(_to.dot(_right), Math.max(_to.dot(_forward), 0.1));
      const angle = Math.atan2(2 * WHEELBASE * Math.sin(alpha), Math.max(6, distance));
      const goal = Math.min(24, 4 + distance * 0.9);
      // Nosed into a wall or a parked car: reverse with the wheel turned away, then charge again.
      if (this.#backOff > 0) {
        this.#backOff -= dt;
        car.driveAngle(-0.8, -angle, dt);
        return;
      }
      this.#stuck = Math.abs(car.speed) < CHARGE_STUCK.speed ? this.#stuck + dt : 0;
      if (this.#stuck >= CHARGE_STUCK.time) {
        this.#stuck = 0;
        this.#backOff = CHARGE_STUCK.reverse;
      }
      car.driveAngle(MathUtils.clamp((goal - car.speed) * 0.5, -1, 1), angle, dt);
      this.#replanIn = 0;
      return;
    }
    this.#replanIn -= dt;
    if (this.#replanIn <= 0) {
      this.#replanIn = 2;
      // A new route drops the old one's boxes, so a replanning cruiser never strands a junction.
      intersections.freeAll(car);
      this.lanes.follow(routeToward(nearestLane(car.position).lane, player));
    }
    // Sirens on: police take the boxes and do not queue behind traffic as patiently.
    this.lanes.panic = Math.max(this.lanes.panic, 0.1);
    this.lanes.update(dt, obstacles, intersections);
  }
}
