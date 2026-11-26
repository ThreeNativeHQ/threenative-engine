// What a guard or a camera can see and hear. Pure functions over positions plus one physics ray,
// so a scenario can reason about them and a game can retune them in one place.
//
// Reference: metal-gear-solid-1 `guard-vision` — a horizontal cone, a vertical window and a line
// of sight trace; the cone half angle is 0x200 of a 4096-unit turn (45 degrees each side), the eye
// reaches 4000 units (4 m, scaled 2.5x to this compound: 10 m), and inside 500 units (0.5 m) the
// cone is bypassed. `guard-hearing` — a footstep is a local noise with a short reach (1500 units,
// 3.75 m scaled), a loud noise reaches 0x1F40 units. `alert-escalation` — sightings add alert
// points per frame up to a ceiling and decay four times faster than they rise.
import { Vector3 } from "three";
import { SHADOWS } from "../level.js";
import type { Stance } from "../state.js";

/** Half the guard's view cone, radians: 45 degrees each side. */
export const GUARD_HALF_ANGLE = Math.PI / 4;
/** How far a guard sees a standing player in light, metres. */
export const GUARD_RANGE = 10;
/** Inside this distance a guard notices a player who is not crouched, whatever way it faces. */
export const CLOSE_SENSE = 0.8;
/** Guard eye height, metres. */
export const EYE_HEIGHT = 1.6;
/** The point a sight line aims at on the player: chest height by stance. */
export const CHEST_HEIGHT = { crouch: 0.55, stand: 1.2, wall: 1.2 } as const;

/** Visibility multipliers. Crouching halves the silhouette; a shadow pool cuts it to a third. */
export const CROUCH_VISIBILITY = 0.5;
export const SHADOW_VISIBILITY = 0.35;
/** A running player is a moving shape: easier to notice. */
export const RUN_VISIBILITY = 1.4;

/**
 * Suspicion rise per second at point-blank full visibility. It scales down linearly with distance
 * to zero at the edge of the cone's reach, so a guard 2 m away fills in about half a second and
 * one at 9 m takes several seconds — the distance falloff the stealth genre is built on.
 */
export const SUSPICION_RISE = 2.4;
/** Suspicion drop per second while the guard cannot see the player. Four times slower than MGS's decay, so a glimpse lingers. */
export const SUSPICION_DECAY = 0.35;
/** At this suspicion the guard stops and turns to look ("?"); at 1 it has seen the player ("!"). */
export const SUSPICIOUS_AT = 0.3;

/** Noise radii, metres. A footstep while running; a knock on a wall. */
export const RUN_NOISE = 4;
export const KNOCK_NOISE = 7;

export interface IViewer {
  /** Eye position, world space. */
  readonly eye: Vector3;
  /** Facing yaw, three.js convention (0 faces +z). */
  readonly yaw: number;
  readonly halfAngle: number;
  readonly range: number;
  /**
   * Metres inside which a standing target is sensed whatever the facing — a guard feels someone
   * bump into it. 0 or absent for a camera, which only sees what is in its cone.
   */
  readonly closeSense?: number;
  /** Metres inside which the viewer cannot see at all: the blind spot under a wall camera. */
  readonly minRange?: number;
}

export interface ITarget {
  readonly position: Vector3;
  readonly stance: Stance;
  readonly running: boolean;
}

/** Ray query the scene provides: true when the segment from → to is clear of world geometry. */
export type ClearLine = (from: Vector3, to: Vector3) => boolean;

export function inShadow(x: number, z: number): boolean {
  for (const [cx, cz, width, depth] of SHADOWS)
    if (Math.abs(x - cx) <= width / 2 && Math.abs(z - cz) <= depth / 2) return true;
  return false;
}

/** The stance, light and motion multiplier on how visible the target is. */
export function visibilityFactor(target: ITarget): number {
  let factor = 1;
  if (target.stance === "crouch") factor *= CROUCH_VISIBILITY;
  if (inShadow(target.position.x, target.position.z)) factor *= SHADOW_VISIBILITY;
  if (target.running) factor *= RUN_VISIBILITY;
  return factor;
}

const _chest = new Vector3();
const _toTarget = new Vector3();

/**
 * How strongly the viewer sees the target this tick, 0 (not at all) to 1 (point-blank, lit,
 * standing). 0 when the target is outside the cone, beyond the reach, or behind cover.
 */
export function sightStrength(viewer: IViewer, target: ITarget, clear: ClearLine): number {
  _chest.copy(target.position);
  _chest.y = CHEST_HEIGHT[target.stance];
  _toTarget.copy(_chest).sub(viewer.eye);
  const flat = Math.hypot(_toTarget.x, _toTarget.z);
  const visibility = visibilityFactor(target);
  // A darker, lower target is seen from less far away, not only more slowly.
  const reach = viewer.range * Math.min(1, 0.45 + 0.55 * visibility);
  if (flat > reach || flat < (viewer.minRange ?? 0)) return 0;
  const closeSense = flat <= (viewer.closeSense ?? 0) && target.stance !== "crouch";
  if (!closeSense) {
    const bearing = Math.atan2(_toTarget.x, _toTarget.z);
    if (Math.abs(angleBetween(bearing, viewer.yaw)) > viewer.halfAngle) return 0;
  }
  if (!clear(viewer.eye, _chest)) return 0;
  return Math.min(1, (1 - flat / reach) * visibility + (closeSense ? 1 : 0));
}

/** Signed smallest difference a - b, radians, in (-PI, PI]. */
export function angleBetween(a: number, b: number): number {
  let difference = (a - b) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference <= -Math.PI) difference += Math.PI * 2;
  return difference;
}

/** One noise in the world: where, how far it carries, and what made it. */
export type Noise = {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly source: "footstep" | "knock";
};

/**
 * The tick's noises. The scene posts into it and every guard reads it; it is cleared once per tick
 * after the guards ran, so a noise is heard exactly once.
 */
export class NoiseBus {
  readonly noises: Noise[] = [];
  post(noise: Noise): void {
    this.noises.push(noise);
  }
  clear(): void {
    this.noises.length = 0;
  }
}
