// The rifle's rules: the spread accumulator, the cones it reads, the shot's random offset and the
// view kick. Pure maths, so the scene stays about the world.
//
// Inspired by modern military shooters. The spread accumulator, the stance blend, the shot cone and
// the recoil are game-owned: no reference card pins them.
import { STANCES, UNIT } from "./movement.js";

/** Game-owned: the accumulator runs 0..255. */
export const SPREAD_CEILING = 255;
/** Game-owned: the turn term is the turn rate in degrees per second times 0.01 and the weapon's turn add. */
const TURN_FACTOR = 0.01;

/**
 * Weapon values are game-owned, in points per
 * second: how fast turning, moving and decay move the accumulator. Walking at base speed grows it
 * by 300 a second and decay takes 150 a second, so a walk fills the cone in under two seconds.
 */
const TURN_ADD = 110;
const MOVE_ADD = 300;
const MOVE_THRESHOLD = 0.5;
const BASE_SPEED = STANCES.stand.speed;
const DECAY_PER_SECOND = 150;

/** Cone half-angles in degrees, [still, fully grown], per stance and down the sights. Game-owned numbers. */
const CONES = {
  stand: [1.2, 7],
  crouch: [0.9, 5],
  prone: [0.6, 3.5],
  ads: [0.15, 1.2],
} as const;

/** Rifle numbers: game-owned. */
export const RIFLE = {
  /** Seconds between rounds: 600 a minute. */
  interval: 0.1,
  magazine: 30,
  reserve: 120,
  reloadSeconds: 2.2,
  damage: 28,
  /** A head hit doubles it (halo-combat-evolved-opence `body-vitality`, source/objects/damage.c:1264). */
  headMultiplier: 2,
  /** View kick per round, degrees, and the centring speed, degrees per second, hip then down the sights. */
  kickPitch: 1,
  kickYaw: 0.3,
  adsKickScale: 0.7,
  centring: { hip: 6, ads: 9 },
  /** Field of view in degrees. Hip is Halo's default of 70 (source/camera/first_person_camera.c:169). */
  hipFov: 70,
  adsFov: 45,
  /** The field of view changes over 0.18 s (source/camera/first_person_camera.c:149). */
  fovSeconds: 0.18,
  /** Range of a round, metres. */
  range: 120,
} as const;

/** Spread points added or removed this step. Growth wins over decay, never both (game-owned). */
export function stepSpread(
  points: number,
  turnDegreesPerSecond: number,
  speed: number,
  dt: number,
): number {
  const growth =
    turnDegreesPerSecond * TURN_FACTOR * TURN_ADD +
    (speed > MOVE_THRESHOLD ? (speed * MOVE_ADD) / BASE_SPEED : 0);
  const next = growth > 0 ? points + growth * dt : points - DECAY_PER_SECOND * dt;
  return Math.min(SPREAD_CEILING, Math.max(0, next));
}

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * Math.min(1, Math.max(0, t));
}

function cone([still, grown]: readonly [number, number], fraction: number): number {
  return lerp(still, grown, fraction);
}

/**
 * The cone half-angle in degrees. Down the sights it reads the aim cone. Otherwise the eye height
 * blends the cones: prone to crouch over the 29 units from 11 to 40, crouch to stand over the 20
 * from 40 to 60 (game-owned).
 */
export function spreadDegrees(points: number, eyeHeight: number, ads: boolean): number {
  const fraction = points / SPREAD_CEILING;
  if (ads) return cone(CONES.ads, fraction);
  const units = eyeHeight / UNIT;
  if (units <= 40)
    return lerp(cone(CONES.prone, fraction), cone(CONES.crouch, fraction), (units - 11) / 29);
  return lerp(cone(CONES.crouch, fraction), cone(CONES.stand, fraction), (units - 40) / 20);
}

/**
 * A round's direction offset: the tangent of the cone angle sets the radius, the radius is uniform
 * and the angle is uniform over a full turn, so the cone is a disc (game-owned).
 * `random` returns 0..1. The result is a sideways and an upward offset to add to a unit direction.
 */
export function shotOffset(
  coneDegrees: number,
  random: () => number,
): { right: number; up: number } {
  const radius = Math.tan((coneDegrees * Math.PI) / 180) * random();
  const angle = random() * Math.PI * 2;
  return { right: Math.cos(angle) * radius, up: Math.sin(angle) * radius };
}

/** Game-owned: recoil recovers in sub-steps of at most 5 ms, damped 0.06 near zero, clamped at 10 degrees. */
const KICK_SUB_STEP = 0.005;
const KICK_DAMPER = 0.06;
const KICK_CLAMP = 10;

/** The view kick, in degrees. It moves the view, not the body, and settles back by itself. */
export class ViewKick {
  pitch = 0;
  yaw = 0;

  add(pitch: number, yaw: number): void {
    this.pitch = Math.max(-KICK_CLAMP, Math.min(KICK_CLAMP, this.pitch + pitch));
    this.yaw = Math.max(-KICK_CLAMP, Math.min(KICK_CLAMP, this.yaw + yaw));
  }

  recover(dt: number, centring: number): void {
    for (let left = dt; left > 1e-9; left -= KICK_SUB_STEP) {
      const step = centring * Math.min(KICK_SUB_STEP, left);
      this.pitch = settle(this.pitch, step);
      this.yaw = settle(this.yaw, step);
    }
  }
}

function settle(value: number, step: number): number {
  const amount = Math.abs(value) <= step ? step * KICK_DAMPER : step;
  return Math.sign(value) * Math.max(0, Math.abs(value) - amount);
}
