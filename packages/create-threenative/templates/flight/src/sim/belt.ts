// The rocket belt: a second flight model on the same map. Thrust fights gravity along the pilot's
// back, so leaning the body steers, and the tank decides how long it can hover.
//
// Borrowed algorithms and constants, pilotwings-64-n64decomp:
//   `jet-thrust`: gravity 9.8 along the local vertical (`rocket_belt.c:394`), thrust along the body
//     axis, attitude feeding lateral acceleration, quadratic drag per component.
//   `rotor-fuel`: burn keyed on the lever with idle, half and full in the ratio 1 : 2 : 5
//     (`gyrocopter.c:86-88`), a low-fuel warning under 0.15 (`code_7CF30.c:497`), and thrust that
//     fades out under a ceiling band (`gyrocopter.c:1490`).
import { GRAVITY, type IVec3, smoothstep } from "./world.js";

const DEG = Math.PI / 180;
/** Thrust at a full lever, m/s^2: 1.8 g, enough to climb and to hover while leaning. */
export const THRUST = 17.6;
/** Quadratic drag per velocity component, 1/m. Terminal fall speed is about 20 m/s. */
const DRAG = 0.02;
/** A linear drag too, 1/s, so a belt at rest in the air settles instead of coasting. */
const DRAG_LINEAR = 0.12;
export const MAX_LEAN = 32 * DEG;
const LEAN_RATE = 1.6;
const YAW_RATE = 1.5;
const LEVER_RATE = 3;
/** A closed lever still burns a little and sinks at about 3 m/s. */
const LEVER_DOWN = 0.55;
/** The hover holds height: it adds thrust for every m/s of sink and removes it for every m/s of climb. */
const HOVER_GAIN = 3;
/** Full-lever burn, tank fractions per second: a full tank lasts 20 s at full thrust. */
const BURN_FULL = 0.05;
/** Idle, half and full lever, as the reference's 1 : 2 : 5 ratio over the full rate. */
const BURN_CURVE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.2],
  [0.5, 0.4],
  [1, 1],
];
export const LOW_FUEL = 0.15;
const CEILING_START = 150;
const CEILING_BAND = 30;

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Tank fraction burned per second at a lever setting. */
export function burnRate(lever: number): number {
  for (let index = 1; index < BURN_CURVE.length; index += 1) {
    const upper = BURN_CURVE[index];
    const lower = BURN_CURVE[index - 1];
    if (upper === undefined || lower === undefined || lever > upper[0]) continue;
    return (BURN_FULL * (lower[1] + ((upper[1] - lower[1]) * (lever - lower[0])) / (upper[0] - lower[0])));
  }
  return BURN_FULL;
}

export interface IBeltInput {
  /** +1 leans forward, -1 leans back. */
  readonly lean: number;
  /** +1 turns right, -1 turns left. */
  readonly turn: number;
  /** +1 opens the lever (climb), -1 closes it (sink), 0 holds the hover. */
  readonly climb: number;
}

export class RocketBelt {
  readonly pos: IVec3;
  readonly vel: IVec3 = { x: 0, y: 0, z: 0 };
  yaw: number;
  /** Forward lean, radians. */
  lean = 0;
  /** Lever 0..1: the thrust share. */
  lever = 0;
  fuel = 1;
  /** True while the burner stands on the ground and has not lifted off. */
  grounded = true;
  /** True on a tick the engine fired. */
  burning = false;

  constructor(x: number, y: number, z: number, yaw: number) {
    this.pos = { x, y, z };
    this.yaw = yaw;
  }

  get lowFuel(): boolean {
    return this.fuel > 0 && this.fuel < LOW_FUEL;
  }

  step(dt: number, input: IBeltInput, air: IVec3, groundY: number): void {
    const lead = clamp(input.lean, -1, 1) * MAX_LEAN;
    this.lean += clamp(lead - this.lean, -LEAN_RATE * dt, LEAN_RATE * dt);
    if (!this.grounded) this.yaw -= input.turn * YAW_RATE * dt;

    // Held neutral the lever sits at the hover: thrust that cancels gravity at the current lean.
    const hover = clamp((GRAVITY - HOVER_GAIN * this.vel.y) / (THRUST * Math.cos(this.lean)), 0, 1);
    const wanted =
      this.fuel <= 0 ? 0 : input.climb > 0 ? 1 : input.climb < 0 ? LEVER_DOWN : this.grounded ? 0 : hover;
    this.lever += clamp(wanted - this.lever, -LEVER_RATE * dt, LEVER_RATE * dt);
    this.burning = this.lever > 0.01 && this.fuel > 0;
    if (this.burning) this.fuel = Math.max(0, this.fuel - burnRate(this.lever) * dt);

    const fade = 1 - smoothstep(CEILING_START, CEILING_START + CEILING_BAND, this.pos.y);
    const thrust = this.burning ? this.lever * THRUST * fade : 0;
    if (this.grounded) {
      if (thrust * Math.cos(this.lean) <= GRAVITY) {
        this.vel.x = this.vel.y = this.vel.z = 0;
        this.pos.y = groundY;
        return;
      }
      this.grounded = false;
    }
    const rx = this.vel.x - air.x;
    const ry = this.vel.y - air.y;
    const rz = this.vel.z - air.z;
    const forward = thrust * Math.sin(this.lean);
    this.vel.x += (forward * Math.sin(this.yaw) - (DRAG * Math.abs(rx) + DRAG_LINEAR) * rx) * dt;
    this.vel.y += (thrust * Math.cos(this.lean) - GRAVITY - (DRAG * Math.abs(ry) + DRAG_LINEAR) * ry) * dt;
    this.vel.z += (forward * Math.cos(this.yaw) - (DRAG * Math.abs(rz) + DRAG_LINEAR) * rz) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }
}
