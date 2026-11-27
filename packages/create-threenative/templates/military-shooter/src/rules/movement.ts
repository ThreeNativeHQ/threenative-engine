// Stance, ground movement and the sprint budget. Pure rules: no scene, no input, no physics.
//
// Inspired by modern military shooters. These rules are game-owned: no reference card pins them.
// Numbers are written in inch-sized world units, as shooters of that kind do, and `UNIT` turns them into metres.

export const UNIT = 0.0254;

export type Stance = "stand" | "crouch" | "prone";

/**
 * Per stance: eye height in metres, top speed in m/s and ground acceleration.
 *
 * All numbers here are game-owned.
 * - The eye heights are 60, 40 and 11 units: standing, crouched and prone.
 * - The accelerations are 9, 12 and 19: prone fills fastest, so dropping down does not feel sticky.
 * - The top speeds are in m/s.
 */
export const STANCES: Readonly<
  Record<Stance, { readonly eye: number; readonly speed: number; readonly accel: number }>
> = {
  stand: { eye: 60 * UNIT, speed: 4.5, accel: 9 },
  crouch: { eye: 40 * UNIT, speed: 2.9, accel: 12 },
  prone: { eye: 11 * UNIT, speed: 1.4, accel: 19 },
};

/** Game-owned: friction 5.5 per second, stop speed 100 units, dead zone 1 unit. */
const FRICTION = 5.5;
const STOP_SPEED = 100 * UNIT;
const DEAD_ZONE = 1 * UNIT;

export interface IPlanarVelocity {
  x: number;
  z: number;
}

/**
 * One step of ground movement: friction first, then a capped push toward the wish speed.
 *
 * Below the stop speed, friction removes a constant amount, so a stop is crisp. Above it, friction
 * grows with speed, so a stop from a run glides. The push adds at most `accel * dt * wishSpeed`, and
 * only the part of the wish speed the body does not already have along the wish direction.
 */
export function groundMove(
  velocity: IPlanarVelocity,
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < DEAD_ZONE) {
    velocity.x = 0;
    velocity.z = 0;
  } else {
    const keep = Math.max(0, speed - Math.max(speed, STOP_SPEED) * FRICTION * dt) / speed;
    velocity.x *= keep;
    velocity.z *= keep;
  }
  if (wishSpeed <= 0) return;
  const gap = wishSpeed - (velocity.x * wishX + velocity.z * wishZ);
  if (gap <= 0) return;
  const push = Math.min(gap, accel * dt * wishSpeed);
  velocity.x += wishX * push;
  velocity.z += wishZ * push;
}

/** Game-owned: 4 s of sprint budget. */
export const SPRINT_SECONDS = 4;
/** Game-owned: a sprint starts only with more than 1 s left. */
const SPRINT_MIN_TO_START = 1;
/** Game-owned: sprinting is 1.5 times the stance speed and a strafe counts 0.667. */
export const SPRINT_SPEED_SCALE = 1.5;
export const SPRINT_STRAFE_SCALE = 0.667;
/** Game-owned: the forward axis must pass 105 of 127 to sustain a sprint. */
export const SPRINT_FORWARD_AXIS = 105 / 127;
/** Game-owned: the refill starts at once, at half the drain rate. */
const SPRINT_RECHARGE_PER_SECOND = 0.5;

/**
 * Sprint as a time budget. The budget drains while sprinting and refills at once when not.
 * After an interruption the key must be released and pressed again, so a held key cannot chain sprints.
 */
export class SprintBudget {
  seconds = SPRINT_SECONDS;
  active = false;
  #needsRepress = false;

  /**
   * @param held the sprint key is down
   * @param forward the forward axis, 0..1
   * @param blocked firing, aiming, reloading or throwing: none of them may start or keep a sprint
   */
  update(held: boolean, forward: number, blocked: boolean, dt: number): void {
    if (!held) this.#needsRepress = false;
    const wanted = held && forward > SPRINT_FORWARD_AXIS && !blocked;
    if (this.active && !wanted) {
      this.active = false;
      this.#needsRepress = held;
    }
    if (!this.active && wanted && !this.#needsRepress && this.seconds > SPRINT_MIN_TO_START)
      this.active = true;
    if (this.active) {
      this.seconds = Math.max(0, this.seconds - dt);
      if (this.seconds === 0) {
        this.active = false;
        this.#needsRepress = true;
      }
    } else this.seconds = Math.min(SPRINT_SECONDS, this.seconds + dt * SPRINT_RECHARGE_PER_SECOND);
  }
}
