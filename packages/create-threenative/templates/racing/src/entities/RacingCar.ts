import type { Vector3 } from "three";
import { Boost } from "../kart/boost.js";
import { createMaterials } from "../render/materials.js";
import type { ITouchInput } from "../render/touch-controls.js";
import { CarBody, type CarCtx, FEEL } from "./CarBody.js";
import { LineDriver } from "./LineDriver.js";

/**
 * The demo driver's pace, in m/s, and the side of the road it keeps.
 *
 * Just under the rival's, on purpose: the demo driver is here to show the circuit and to let a
 * playtest ask a car to follow it, not to win the race. A demo driver that beat the rival would
 * make "finishing behind the rival is a DNF" untestable from the grid, and that rule is one of the
 * things this template has to prove.
 */
export const AUTOPILOT_PACE = 15.5;
const AUTOPILOT_OFFSET = -1.5;

/**
 * The player's car: input in, a `VehicleBody3D` out — or the same closed-loop driver the rival
 * uses, when the autopilot is engaged.
 *
 * The old car was a kinematic fake: `#speed` and `#heading` as numbers, velocity rewritten every
 * frame, the chassis pinned level. Everything that made a car feel like a car lived in those two
 * numbers, so the same corner at the same speed always produced the same line. Here the input only
 * ever writes three values: `engineForce`, `brake` and `steering`. Grip, weight transfer,
 * understeer and the way a kerb lifts a wheel are the backend's, not this file's.
 */
export class RacingCar {
  readonly car: CarBody;
  readonly boost = new Boost();
  /** The demo driver. Present whether or not it is engaged, so engaging is not an allocation. */
  readonly autopilot = new LineDriver({ offset: AUTOPILOT_OFFSET, pace: AUTOPILOT_PACE });
  #autopilotOn = false;
  #speedAfterBoost = 0;
  #topSpeed = 0;
  #boostWasActive = false;

  constructor(ctx: CarCtx, spawn: Vector3, yaw = 0) {
    this.car = new CarBody(ctx, { materials: createMaterials(), spawn, yaw });
    this.car.measure(1 / 60);
  }

  get body(): CarBody {
    return this.car;
  }

  get mesh(): CarBody["mesh"] {
    return this.car.mesh;
  }

  get forward(): Vector3 {
    return this.car.forward;
  }

  /** Where the car is measured to be going. `Lap` reads this, never `forward`. */
  get travelDirection(): Vector3 {
    return this.car.travelDirection;
  }

  get normaliseFactor(): number {
    return this.car.normaliseFactor;
  }

  get lateralLoad(): number {
    return this.car.lateralLoad;
  }

  get speed(): number {
    return this.car.speedMagnitude;
  }

  get topSpeed(): number {
    return this.#topSpeed;
  }

  get boosting(): boolean {
    return this.boost.active;
  }

  /** Whether the closed-loop driver has the wheel. Published, so a scenario can prove it drove. */
  get autopilotEngaged(): boolean {
    return this.#autopilotOn;
  }

  /** The speed measured on the frame a boost ran out, which is what the boost playtest reads. */
  speedAfterBoost(): number {
    return this.#speedAfterBoost;
  }

  /**
   * One frame of driving: the input becomes an engine force, a brake and a steering angle.
   *
   * Reverse engages below half a metre per second, so holding back is a brake while the car is
   * rolling and a gear once it has stopped — the same rule every arcade racer uses, and the reason
   * a car can be backed out of a barrier rather than trapped against it.
   */
  update(ctx: CarCtx, dt: number, touch?: ITouchInput): void {
    this.boost.update(dt);
    if (ctx.input.justPressed("boost") || touch?.boostPressed === true) this.boost.activate();
    const move = ctx.input.vector("move");
    if (touch !== undefined) {
      move.x += touch.move.x;
      move.y += touch.move.y;
      move.clampLength(0, 1);
    }
    if (ctx.input.justPressed("autopilot")) this.#autopilotOn = !this.#autopilotOn;
    // Touching the wheel takes it back, the way a driving game's demo lap does. A scenario that
    // wants to hand the car over presses a key; a player who grabs the stick gets their car.
    if (this.#autopilotOn && move.lengthSq() > 0.02) this.#autopilotOn = false;
    if (this.#autopilotOn) {
      this.autopilot.update(this.car, dt);
    } else {
      this.drive(move, ctx.input.pressed("brake") || touch?.brakePressed === true);
      this.car.measure(dt);
    }
    if (this.boost.active) {
      this.#boostWasActive = true;
    } else if (this.#boostWasActive) {
      this.#boostWasActive = false;
      this.#speedAfterBoost = this.speed;
    }
    this.#topSpeed = Math.max(this.#topSpeed, this.speed);
  }

  private drive(move: { x: number; y: number }, braking: boolean): void {
    const body = this.car.body;
    const speed = body.speed;
    // The sign: `move.x` is +1 to the right, and a positive Rapier steering angle turns toward the
    // chassis's -z, which is the driver's left. Flipping here keeps "right means right" for the
    // physics and for the visual front wheels, which take the same angle.
    body.steering = -move.x * this.car.lockAt(speed);
    // The brake key (shift, the touch brake button) wins over the throttle, and holds a stopped car.
    if (braking) {
      body.engineForce = 0;
      body.brake = FEEL.brake;
    } else if (move.y > 0) {
      const top = this.boost.active ? FEEL.boostTopSpeed : FEEL.topSpeed;
      body.engineForce =
        move.y *
        FEEL.engineForce *
        (this.boost.active ? FEEL.boostForce : 1) *
        Math.max(0, 1 - speed / top);
      body.brake = 0;
    } else if (speed > FEEL.reverseEnterSpeed) {
      body.engineForce = 0;
      body.brake = FEEL.brake;
    } else if (move.y === 0) {
      // **Handbrake at a standstill.** The main straight climbs at 1.6% and a ray-cast vehicle has no
      // rolling resistance, so a car left on the grid with no input freewheels backwards down the
      // hill: measured, 75 m of it before the race began, which put the grid slot 862 m around the
      // lap and made the ranking scenario's baseline a car that had already been rescued.
      body.engineForce = 0;
      body.brake = FEEL.brake * 0.5;
    } else {
      body.engineForce =
        move.y * FEEL.engineForce * Math.max(0, 1 - Math.abs(speed) / FEEL.reverseTopSpeed);
      body.brake = 0;
    }
  }

  /** Places the car back on the road facing `heading`, which is what a rescue does. */
  setHeading(heading: Vector3): void {
    const flat = heading.clone().setY(0);
    if (flat.lengthSq() < 0.0001) return;
    flat.normalize();
    this.car.teleport(
      { x: this.car.position.x, y: this.car.position.y, z: this.car.position.z },
      Math.atan2(flat.z, flat.x),
    );
  }

  debug(): Record<string, unknown> {
    return {
      autopilot: this.#autopilotOn,
      boostActive: this.boost.active,
      boostUses: this.boost.uses,
      lateralLoad: Math.round(this.lateralLoad * 100) / 100,
      normaliseFactor: this.car.normaliseFactor,
      position: this.car.position.toArray(),
      speed: this.speed,
      topSpeed: this.#topSpeed,
      travelDirection: this.travelDirection.toArray(),
      wheelsInContact: this.car.wheels.map((_wheel, index) => this.car.body.wheelContact(index)),
    };
  }

  dispose(): void {
    this.car.dispose();
  }
}
