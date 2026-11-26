import {
  AIR_ACCEL,
  AIR_FRICTION,
  AIR_MAX_SPEED,
  AIR_OVERSPEED_DECAY,
  DASH_DECEL,
  DASH_SPEED,
  DOWN_FLICK,
  FAST_FALL_SPEED,
  GRAVITY,
  GROUND_FRICTION,
  LAUNCH_DECAY,
  RUN_SPEED,
  RUN_THRESHOLD,
  STEP,
  TERMINAL_SPEED,
  WALK_SPEED,
} from "./constants.js";
import { totalFrames } from "./attacks.js";
import { type Floor, moveInAir } from "./stage.js";
import type { FighterId, IFighter, Mode, Pad, Side, SimEvent } from "./types.js";

/** What a fighter needs to know about everyone else: who holds each ledge, and the clock. */
export interface IWorld {
  frame: number;
  readonly ledgeOwner: Map<Side, FighterId>;
  readonly emit: (event: SimEvent) => void;
}

export const DEAD_ZONE = 0.1;
/** Frames a landed aerial still has to recover. */
const AERIAL_LANDING_LAG = 8;

export function setMode(f: IFighter, mode: Mode): void {
  f.mode = mode;
  f.timer = 0;
}

export const edge = (f: IFighter, pad: Pad, key: "attack" | "dodge" | "jump" | "strong"): boolean =>
  pad[key] && !f.prev[key];

export const downFlick = (f: IFighter, pad: Pad): boolean =>
  pad.y <= DOWN_FLICK && f.prev.y > DOWN_FLICK;

export function approach(value: number, target: number, amount: number): number {
  if (value < target) return Math.min(target, value + amount);
  return Math.max(target, value - amount);
}

export function land(f: IFighter, floor: Floor): void {
  f.floor = floor;
  f.y = floor.y;
  f.vy = 0;
  f.ky = 0;
  f.jumps = 1;
  f.fastFalling = false;
  // A knocked-back fighter that lands keeps sliding with what is left of the launch.
  f.vx += f.kx;
  f.kx = 0;
  if (f.attack?.def.id === "aerial")
    f.attack.frame = Math.max(f.attack.frame, totalFrames(f.attack.def) - AERIAL_LANDING_LAG);
}

/** Gravity, drift, knockback decay and the move itself: the physics every airborne mode shares. */
export function airMove(f: IFighter, pad: Pad | undefined): void {
  // Over the speed limit the fighter is stepped down to it, not clamped at once (card `air-drift-and-gravity`).
  if (Math.abs(f.vx) > AIR_MAX_SPEED)
    f.vx = approach(f.vx, Math.sign(f.vx) * AIR_MAX_SPEED, AIR_OVERSPEED_DECAY * STEP);
  else if (pad !== undefined && Math.abs(pad.x) > DEAD_ZONE)
    f.vx = Math.max(-AIR_MAX_SPEED, Math.min(AIR_MAX_SPEED, f.vx + pad.x * AIR_ACCEL * STEP));
  f.vx = approach(f.vx, 0, AIR_FRICTION * STEP);
  f.vy -= GRAVITY * STEP;
  if (f.fastFalling) f.vy = -FAST_FALL_SPEED;
  else if (f.vy < -TERMINAL_SPEED) f.vy = -TERMINAL_SPEED;
  const launch = Math.hypot(f.kx, f.ky);
  if (launch > 0) {
    const kept = Math.max(0, launch - LAUNCH_DECAY * STEP) / launch;
    f.kx *= kept;
    f.ky *= kept;
  }
  const floor = moveInAir(f, f.dropThrough > 0);
  if (floor !== undefined) land(f, floor);
  else f.peakY = Math.max(f.peakY, f.y);
}

/** Walk, run and stop on the ground. Walking off an edge starts a fall. */
export function groundMove(f: IFighter, pad: Pad | undefined, friction = GROUND_FRICTION): void {
  const floor = f.floor;
  if (floor === undefined) return;
  const tilt = pad === undefined || Math.abs(pad.x) < DEAD_ZONE ? 0 : Math.abs(pad.x);
  const direction = pad === undefined ? 0 : Math.sign(pad.x);
  const target =
    tilt === 0 ? 0 : direction * (tilt >= RUN_THRESHOLD ? RUN_SPEED : WALK_SPEED * tilt);
  // A flick from a standstill starts a dash: a burst above run speed that sheds back down to it.
  if (
    pad !== undefined &&
    tilt >= RUN_THRESHOLD &&
    Math.abs(f.prev.x) < RUN_THRESHOLD &&
    Math.abs(f.vx) < RUN_SPEED * 0.6
  )
    f.vx = direction * DASH_SPEED;
  const speedingUp = target !== 0 && f.vx * target >= 0 && Math.abs(target) > Math.abs(f.vx);
  const rate = speedingUp || Math.abs(f.vx) > RUN_SPEED ? DASH_DECEL : friction;
  f.vx = approach(f.vx, target, rate * STEP);
  f.x += f.vx * STEP;
  if (f.x < floor.x0 || f.x > floor.x1) {
    f.floor = undefined;
    f.peakY = f.y;
  }
}
