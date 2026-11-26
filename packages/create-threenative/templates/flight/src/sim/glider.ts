// The hang glider's flight model: a point mass in moving air with a wing, not a steered velocity.
//
// The pilot holds an angle of attack. Pulling it up buys lift and costs speed, so a climb trades
// speed for height and a dive trades it back. Lift and drag both grow with the square of the speed
// through the air, so the glider settles at a trim speed for each angle. Below a minimum airspeed it
// stalls: lift goes, the nose drops, and it flies again only when the speed is back above a higher one.
//
// Borrowed algorithms and constants, pilotwings-64-n64decomp (speeds are m/s here):
//   `stall-threshold`: latch under 4 (`hang_glider2.c:253`), clear over 12 (`:249`), lift share
//     ramped between 4 and 8 (`:252`), a ground clearance under 0.2 clears the latch (`:408`).
//   `glide-lift`: lift grows with the square of airspeed, scaled by a table of angle of attack
//     whose peak holds through the middle and collapses at extreme angles (`:47`, peak 1.85),
//     and fades to nothing over a 100-unit band above a ceiling (`:555`).
//   `glide-drag`: drag grows with the square of speed, and above a 22 reference it is divided by
//     the speed ratio, capped at 2, so a long dive settles into a terminal glide (`:333`, `:335`).
//   `hang-glider`: bank turns the glider because the lift vector tilts with the wing.
import { GRAVITY, type IVec3, smoothstep } from "./world.js";

const DEG = Math.PI / 180;
export const STALL_IN = 4;
export const STALL_OUT = 12;
export const LIFT_FULL = 8;
/** The heads-up warning shows under this airspeed. Reference: `hang_glider1.c:423`. */
export const STALL_WARNING = 8;
export const MAX_BANK = 40 * DEG;
const ROLL_RATE = 1.4;
const ROLL_RETURN = 0.9;
const ALPHA_RATE = 1.3;
const ALPHA_TRIM = 6 * DEG;
/** Full pull holds the peak of the lift table, the slowest steady flight: 13 m/s. */
const ALPHA_PULL = 20 * DEG;
const ALPHA_PUSH = -4 * DEG;
/** The nose the wing takes while it is stalled, so the glider drops its nose to fly again. */
const ALPHA_STALLED = -14 * DEG;
/** Lift acceleration per squared airspeed at the table's peak (1 g at 18 m/s and 6 degrees). */
const LIFT_K = 0.055;
const DRAG_PARASITE = 0.0025;
const DRAG_INDUCED = 0.0029;
const DRAG_FORM = 0.012;
const DRAG_REFERENCE = 22;
const DRAG_DIVISOR_CAP = 2;
/** The trim glide's lift over drag, used only to start a glider in balance. */
const GLIDE_RATIO = 9;
/** Extra drag per m/s the glider flies faster than its trim speed: a dive settles instead of ringing. */
const SPEED_DAMPING = 0.5;
const CEILING_START = 260;
const CEILING_BAND = 40;

/** Angle of attack in degrees to the share of peak lift. Rises, holds through the middle, then collapses. */
const LIFT_TABLE: ReadonlyArray<readonly [number, number]> = [
  [-90, 0.2],
  [-20, -0.3],
  [-4, -0.02],
  [0, 0.25],
  [6, 0.55],
  [12, 0.9],
  [16, 1],
  [22, 1],
  [28, 0.45],
  [40, 0.3],
  [90, 0.25],
];

export function liftCoefficient(alpha: number): number {
  const degrees = alpha / DEG;
  const first = LIFT_TABLE[0];
  const last = LIFT_TABLE[LIFT_TABLE.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (degrees <= first[0]) return first[1];
  if (degrees >= last[0]) return last[1];
  for (let index = 1; index < LIFT_TABLE.length; index += 1) {
    const upper = LIFT_TABLE[index];
    const lower = LIFT_TABLE[index - 1];
    if (upper === undefined || lower === undefined || degrees > upper[0]) continue;
    return lower[1] + ((upper[1] - lower[1]) * (degrees - lower[0])) / (upper[0] - lower[0]);
  }
  return last[1];
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

export interface IGliderInput {
  /** +1 pulls the nose up (more angle of attack), -1 pushes it down. */
  readonly pitch: number;
  /** +1 banks right, -1 banks left. */
  readonly roll: number;
}

export class Glider {
  readonly pos: IVec3;
  readonly vel: IVec3 = { x: 0, y: 0, z: 0 };
  /** Direction of flight through the air, radians, three.js yaw (0 faces +z). */
  heading: number;
  /** Radians, positive banks right. */
  bank = 0;
  /** Wing angle of attack, radians. */
  alpha = ALPHA_TRIM;
  stalled = false;
  /** Speed through the air, m/s. */
  airspeed = 0;
  /** Flight path angle through the air, radians, positive climbs. */
  gamma = 0;
  liftShare = 1;

  /** A glider in trim at `speed` through the air: its sink rate is the glide's, so it starts without a bounce. */
  constructor(x: number, y: number, z: number, heading: number, speed: number, air: IVec3 = { x: 0, y: 0, z: 0 }) {
    this.pos = { x, y, z };
    this.heading = heading;
    this.vel.x = Math.sin(heading) * speed + air.x;
    this.vel.y = -speed / GLIDE_RATIO + air.y;
    this.vel.z = Math.cos(heading) * speed + air.z;
    this.airspeed = speed;
  }

  /** Nose attitude for the drawn model, radians, positive noses up. */
  get attitude(): number {
    return this.gamma + this.alpha;
  }

  /** Metres per second the glider gains in height, in the ground frame. */
  get climb(): number {
    return this.vel.y;
  }

  step(dt: number, input: IGliderInput, air: IVec3, clearance: number): void {
    const target = input.roll * MAX_BANK;
    const rate = input.roll === 0 ? ROLL_RETURN : ROLL_RATE;
    this.bank += clamp(target - this.bank, -rate * dt, rate * dt);

    const rx = this.vel.x - air.x;
    const ry = this.vel.y - air.y;
    const rz = this.vel.z - air.z;
    const speed = Math.hypot(rx, ry, rz);
    this.airspeed = speed;
    // A glider at a standstill in the air falls: its flight direction is straight down.
    const tx = speed > 0.01 ? rx / speed : 0;
    const ty = speed > 0.01 ? ry / speed : -1;
    const tz = speed > 0.01 ? rz / speed : 0;
    if (Math.hypot(rx, rz) > 1) this.heading = Math.atan2(tx, tz);
    this.gamma = Math.asin(clamp(ty, -1, 1));

    if (!this.stalled && speed < STALL_IN) this.stalled = true;
    else if (this.stalled && (speed > STALL_OUT || clearance < 0.2)) this.stalled = false;
    this.liftShare = this.stalled ? 0 : clamp((speed - STALL_IN) / (LIFT_FULL - STALL_IN), 0, 1);

    const command = this.stalled
      ? ALPHA_STALLED
      : input.pitch >= 0
        ? ALPHA_TRIM + input.pitch * (ALPHA_PULL - ALPHA_TRIM)
        : ALPHA_TRIM - input.pitch * (ALPHA_PUSH - ALPHA_TRIM);
    this.alpha += clamp(command - this.alpha, -ALPHA_RATE * dt, ALPHA_RATE * dt);

    const coefficient = liftCoefficient(this.alpha);
    const ceiling = 1 - smoothstep(CEILING_START, CEILING_START + CEILING_BAND, this.pos.y);
    const lift = LIFT_K * speed * speed * coefficient * this.liftShare * ceiling;
    const form = Math.max(0, Math.abs(this.alpha) - 0.45);
    const divisor = clamp(speed / DRAG_REFERENCE, 1, DRAG_DIVISOR_CAP);
    let drag =
      (speed * speed * (DRAG_PARASITE + DRAG_INDUCED * coefficient * coefficient + DRAG_FORM * form * form)) /
      divisor;
    // Trim speed at this angle: where one g of lift balances. Faster than that is paid for in drag.
    if (coefficient > 0.2 && !this.stalled) {
      const trim = Math.sqrt(GRAVITY / (LIFT_K * coefficient));
      drag += Math.max(0, speed - trim) * SPEED_DAMPING;
    }

    // The wing's own axes: `right` from the heading, `up` perpendicular to the flight path, banked.
    const right = { x: -Math.cos(this.heading), z: Math.sin(this.heading) };
    let ux = -right.z * ty;
    let uy = right.z * tx - right.x * tz;
    let uz = right.x * ty;
    const length = Math.hypot(ux, uy, uz) || 1;
    ux /= length;
    uy /= length;
    uz /= length;
    const cosB = Math.cos(this.bank);
    const sinB = Math.sin(this.bank);
    this.vel.x += (lift * (ux * cosB + right.x * sinB) - drag * tx) * dt;
    this.vel.y += (-GRAVITY + lift * uy * cosB - drag * ty) * dt;
    this.vel.z += (lift * (uz * cosB + right.z * sinB) - drag * tz) * dt;
    this.pos.x += this.vel.x * dt;
    this.pos.y += this.vel.y * dt;
    this.pos.z += this.vel.z * dt;
  }
}
