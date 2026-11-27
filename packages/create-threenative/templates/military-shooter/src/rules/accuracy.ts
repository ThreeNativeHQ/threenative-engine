// How well a soldier shoots, and when. Two cards, two jobs.
//
// Accuracy is game-owned. Distance sets a base value, posture scales it, and a target that runs
// along the line of fire loses more.
// Burst timing: halo-combat-evolved-opence `ai-bursts`. Gaps and burst lengths are seconds
// converted to ticks.
import type { Stance } from "./movement.js";
import { UNIT } from "./movement.js";

/** Game-owned: 0.5 inside 800 units, 0.1 beyond 2000, linear between. */
const NEAR_FACTOR = 0.5;
const NEAR_EDGE = 800 * UNIT;
const FAR_FACTOR = 0.1;
const FAR_EDGE = 2000 * UNIT;
/** Game-owned: a prone target halves it, a crouched one takes a quarter off. */
const POSTURE_FACTOR: Readonly<Record<Stance, number>> = { stand: 1, crouch: 0.75, prone: 0.5 };
/** Game-owned: closing speed counts up to 250 units per second, at 0.004 each, with a floor of 0.1. */
const MOTION_SPEED_CAP = 250;
const MOTION_SLOPE = 0.004;
const MOTION_FLOOR = 0.1;

/** `closingSpeed` is the target's speed along the line of fire in m/s, either way. */
export function soldierAccuracy(distance: number, posture: Stance, closingSpeed: number): number {
  const t = Math.min(1, Math.max(0, (distance - NEAR_EDGE) / (FAR_EDGE - NEAR_EDGE)));
  const base = NEAR_FACTOR + (FAR_FACTOR - NEAR_FACTOR) * t;
  const units = Math.min(MOTION_SPEED_CAP, Math.abs(closingSpeed) / UNIT);
  const motion = Math.max(MOTION_FLOOR, 1 - units * MOTION_SLOPE);
  return base * POSTURE_FACTOR[posture] * motion;
}

/**
 * The burst: how long the trigger is held and how long the soldier waits before the next one, in
 * seconds, drawn uniformly. The ranges are game-owned (the card says the variant supplies them).
 */
export const BURST_SECONDS = { min: 0.4, max: 0.8 } as const;
export const BURST_GAP_SECONDS = { min: 0.8, max: 1.6 } as const;
/** The error cone of a missed round, degrees. Also game-owned. */
export const MISS_CONE = { min: 1.5, max: 4 } as const;
