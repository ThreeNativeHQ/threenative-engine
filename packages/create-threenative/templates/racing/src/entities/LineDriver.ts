import { MathUtils, Vector3 } from "three";
import { CIRCUIT, type CircuitLine } from "../track/circuit.js";
import type { CarBody } from "./CarBody.js";
import { FEEL, driveForce } from "./CarBody.js";

/**
 * The closed-loop driver: aim at a point ahead on the circuit, brake for what is coming.
 *
 * It is the **only** thing in this template that turns "where the car is" into "what the driver
 * does", and both cars on the circuit use it — the rival, and the autopilot the playtest presses.
 * That is deliberate: a scenario that wants a car to lap the circuit cannot do it with recorded key
 * timings, because a chassis with suspension and weight transfer answers a fixed key script
 * differently on every corner. It can do it by pressing the same button the rival's controller
 * obeys, and the result is a lap that is a **consequence** of the physics rather than a timing
 * that happens to be near the road.
 *
 * The sign in {@link headingError} is the whole mechanic, so it is exported and pinned: positive
 * is to the driver's right, and a positive Rapier steering angle is to its left.
 */

export function headingError(yaw: number, target: Vector3, from: Vector3): number {
  const wanted = Math.atan2(target.z - from.z, target.x - from.x);
  return Math.atan2(Math.sin(wanted - yaw), Math.cos(wanted - yaw));
}

/** How far ahead of itself the driver aims, in metres, plus its own speed. */
const LOOKAHEAD_BASE = 3.5;
const LOOKAHEAD_PER_MPS = 0.3;

/** How close to the edge of the road the driver lets the car get before it starts recovering. */
const SAFE_HALF = 3.1;

/**
 * The demo driver's get-out-of-trouble rule.
 *
 * Below {@link BEACHED_SPEED} for {@link BEACHED_SECONDS} the car is beached: this chassis can end
 * up nose-down with its driven wheels in the air and its rear on the tarmac, and no amount of
 * throttle or reverse moves it. The driver then puts the car back on the racing line, six metres
 * further along than the last place it was actually driving, facing the right way.
 *
 * This is a **demo** driver — the attract-mode lap a player watches, and the follower a playtest
 * presses. Its contract is "follow the circuit", and rejoining the line is how it keeps that
 * contract after a mistake. It is not the game's rescue: `RacingCar` does not know it happened, the
 * `rescues` counter does not move, and the player is never affected.
 */
const BEACHED_SPEED = 1.6;
const BEACHED_SECONDS = 1.1;
const REJOIN_AHEAD = 6;

/** Steering gain: the fraction of the heading error it takes as steering input. */
const STEER_GAIN = 2.2;

/** How far ahead it looks for a corner to slow for, and how often it samples. */
const BRAKE_SCAN = 46;
const BRAKE_STEP = 4;

/** The fraction of the tyres' lateral limit a corner is actually taken at. */
const CORNER_MARGIN = 0.62;

export interface ILineDriverOptions {
  /** The pace held where the road is straight, in m/s. */
  readonly pace: number;
  /** How hard the brakes bite, in m/s². Used only to decide *when* to start braking. */
  readonly deceleration?: number;
  /**
   * Lateral offset of the driven line from the centreline, in metres. Positive is to the right.
   *
   * Two cars on the same line fight: they are the same chassis, the same width and the same pace,
   * so they touch on the first corner and lock. Giving each driver its own offset is what lets the
   * player's demo lap and the rival run the same circuit at the same time without a collision.
   */
  readonly offset?: number;
}

export class LineDriver {
  readonly line: CircuitLine;
  /** Monotonic progress around the lap, in metres. It keeps counting past the line. */
  #progress = 0;
  #lastProjected = 0;
  #started = false;
  #beached = 0;
  #driven = 0;
  #steering = 0;
  #pace: number;
  #deceleration: number;
  #offset: number;

  constructor(options: ILineDriverOptions, line: CircuitLine = CIRCUIT) {
    if (!(options.pace > 0)) throw new Error("LineDriver pace must be positive.");
    this.line = line;
    this.#pace = options.pace;
    this.#deceleration = options.deceleration ?? FEEL.brake * 0.55;
    this.#offset = options.offset ?? 0;
  }

  set pace(value: number) {
    if (!(value > 0)) throw new Error("LineDriver pace must be positive.");
    this.#pace = value;
  }

  get progress(): number {
    return this.#progress;
  }

  /** Puts the driver on the circuit at `distance`, as a car placed on the grid is. */
  reset(distance: number): void {
    this.#progress = distance;
    this.#lastProjected =
      ((distance % this.line.totalLength) + this.line.totalLength) % this.line.totalLength;
    this.#started = true;
  }

  /**
   * One frame. Writes `steering`, `engineForce` and `brake` on the car's chassis, and nothing else:
   * grip, weight transfer and understeer stay where they belong, in the physics.
   */
  update(car: CarBody, dt: number): void {
    const speed = car.speedMagnitude;
    const projection = this.line.project(car.position, this.#projection);
    const beached = speed < BEACHED_SPEED;
    if (beached) this.#beached += dt;
    else {
      this.#beached = 0;
      this.#driven = this.#progress;
    }
    if (beached && this.#beached > BEACHED_SECONDS) {
      this.#beached = 0;
      const back = this.line.at(this.#driven + REJOIN_AHEAD, this.#rejoin);
      car.teleport(
        { x: back.point.x, y: back.point.y + 0.24, z: back.point.z },
        Math.atan2(back.tangent.z, back.tangent.x),
      );
      this.reset(this.#driven + REJOIN_AHEAD);
    }
    this.drive(car, dt, projection);
  }

  private drive(
    car: CarBody,
    dt: number,
    projection: { readonly distance: number; readonly lateral: number },
  ): void {
    const body = car.body;
    const speed = car.speedMagnitude;
    if (!this.#started) {
      this.reset(projection.distance);
      this.#driven = projection.distance;
    } else {
      const half = this.line.totalLength / 2;
      const full = half * 2;
      this.#progress +=
        ((((projection.distance - this.#lastProjected + half) % full) + full) % full) - half;
      this.#lastProjected = projection.distance;
    }
    const ahead = this.line.at(
      this.#progress + LOOKAHEAD_BASE + speed * LOOKAHEAD_PER_MPS,
      this.#ahead,
    );
    // The line is not the centreline: the driver moves to the **inside** of the corner it is going
    // fast through, which is the difference between a car following a groove and a car racing. The
    // sign of the curvature is the side the corner turns toward, so that is the side to move to.
    let aimOffset =
      this.#offset +
      Math.sign(ahead.curvature) * Math.min(1.8, 1 / Math.max(Math.abs(ahead.curvature), 1 / 90));
    // A racing line is a preference, not a rail. Past {@link SAFE_HALF} the aim comes back toward
    // the centreline in proportion to how far out the car is, because a driver does not drive off
    // the road to hold a line: measured, the pure line put the car 4.8 m out on a 4.5 m road at
    // the hairpin and stopped it on the inside kerb.
    const off = Math.abs(projection.lateral);
    if (off > SAFE_HALF)
      aimOffset -= Math.sign(projection.lateral) * Math.min(3, (off - SAFE_HALF) * 0.9);
    const aim = this.#aim.copy(ahead.point).addScaledVector(ahead.right, aimOffset);
    const yaw = Math.atan2(car.forward.z, car.forward.x);
    const error = headingError(yaw, aim, car.position);
    this.#steering = -MathUtils.clamp(error * STEER_GAIN, -1, 1) * car.lockAt(speed);
    body.steering = this.#steering;
    const target = this.targetSpeed(this.#progress);
    if (speed < target) {
      const want = MathUtils.clamp((target - speed) / 2.5, 0, 1);
      body.engineForce = FEEL.engineForce * want * driveForce(speed, FEEL.topSpeed);
      body.brake = 0;
    } else {
      body.engineForce = 0;
      body.brake = FEEL.brake * MathUtils.clamp((speed - target) / 1.5, 0.15, 1);
    }
    car.measure(dt);
  }

  /**
   * The speed the tyres can hold here, minus what is coming.
   *
   * The forward scan is what makes the car brake *before* the hairpin instead of arriving at it
   * already sideways: for every point in the next {@link BRAKE_SCAN} metres it asks what speed
   * that corner allows, and whether it could still be down to it in the distance available.
   */
  private targetSpeed(progress: number): number {
    let limit = this.#pace;
    for (let look = 0; look <= BRAKE_SCAN; look += BRAKE_STEP) {
      const sample = this.line.at(progress + look, this.#scan);
      const corner = Math.sqrt(
        FEEL.lateral * CORNER_MARGIN * (Number.isFinite(sample.radius) ? sample.radius : 1e6),
      );
      const reachable = Math.sqrt(corner * corner + 2 * this.#deceleration * look);
      if (reachable < limit) limit = reachable;
    }
    return Math.max(6, limit);
  }

  readonly #projection = {
    curvature: 0,
    distance: 0,
    lateral: 0,
    point: new Vector3(),
    tangent: new Vector3(),
  };
  readonly #aim = new Vector3();
  readonly #rejoin = CIRCUIT.createSample();
  readonly #ahead = CIRCUIT.createSample();
  readonly #scan = CIRCUIT.createSample();
}
