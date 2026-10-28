// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// A spring arm, after Godot's SpringArm3D: the camera trails an anchor on a
// damped spring instead of being assigned its position every frame. A plain
// `camera.position.lerp(target, 0.1)` is framerate-dependent and reads as
// rubber-banding; the exponential below is stable at any dt.
//
// Camera framing is one of the loudest things in a screenshot, so it lives
// here in your repo rather than behind a framework option.
import type { PerspectiveCamera, Vector3 } from "three";
import { Vector3 as Vec3 } from "three";

export interface ISpringArmOptions {
  /** Where the camera sits relative to its target, before smoothing. */
  readonly offset?: Vector3;
  /** How far ahead of the target the camera looks. Lead the action. */
  readonly lookAhead?: Vector3;
  /** Seconds for the arm to close most of the distance. Higher trails more. */
  readonly damping?: number;
  /** Closest target-relative distance allowed by the game's framing. */
  readonly minDistance?: number;
  /** Farthest target-relative distance allowed by the game's framing. */
  readonly maxDistance?: number;
  /** Target-relative distance units moved by one full zoom axis unit per second. */
  readonly dollySpeed?: number;
  /**
   * How far a ray from `origin` along `direction` runs before it meets something solid, or
   * `undefined`: Godot's SpringArm3D collision. The arm shortens to stop in front of the hit, so a
   * wall behind the player never ends up between the lens and the player. Unset, the arm is free.
   */
  readonly obstruction?: (origin: Vector3, direction: Vector3, far: number) => number | undefined;
}

export interface ISpringArm {
  /** Call once per frame from `update(dt)`. */
  readonly follow: (target: Vector3, dt: number) => void;
  /** Jump the camera to its resting pose — use on spawn and respawn. */
  readonly snap: (target: Vector3) => void;
  /** Move toward or away from the target; positive intent moves the camera closer. */
  readonly dolly: (amount: number, dt: number) => void;
}

export function createSpringArm(
  camera: PerspectiveCamera,
  options: ISpringArmOptions = {},
): ISpringArm {
  // Keep the starter's target-relative distance below the 9.5-unit look budget
  // so the player and nearby route stay readable after the camera settles.
  const offset = (options.offset ?? new Vec3(-1, 4.2, 8.2)).clone();
  // Lead the route rather than centring the character. The level runs left to right, so
  // aiming ahead of the player puts the gap and the flag in frame from the first tick
  // instead of leaving half the picture empty behind them.
  const lookAhead = options.lookAhead ?? new Vec3(1.8, 0.35, -1.15);
  const damping = options.damping ?? 0.18;
  const startingDistance = offset.length();
  const offsetDirection =
    startingDistance > 0 ? offset.clone().multiplyScalar(1 / startingDistance) : new Vec3(0, 0, 1);
  const minDistance = Math.max(0.1, options.minDistance ?? startingDistance * 0.55);
  const maxDistance = Math.max(minDistance, options.maxDistance ?? startingDistance * 1.35);
  const dollySpeed = Math.max(0, options.dollySpeed ?? 10);
  let distance = Math.min(Math.max(startingDistance, minDistance), maxDistance);

  const desired = new Vec3();
  const aim = new Vec3();
  const currentOffset = new Vec3();
  const pivot = new Vec3();
  const toLens = new Vec3();
  // The ray starts at the player's chest, where the lens is looking, never at the floor it stands on.
  const PIVOT_HEIGHT = 1;
  // Space kept between the lens and the solid it stopped in front of, and the shortest arm.
  const MARGIN = 0.5;
  const MIN_ARM = 1.5;

  const clear = (target: Vector3): void => {
    if (options.obstruction === undefined) return;
    pivot.copy(target);
    pivot.y += PIVOT_HEIGHT;
    toLens.subVectors(camera.position, pivot);
    const length = toLens.length();
    if (!(length > MIN_ARM)) return;
    toLens.multiplyScalar(1 / length);
    const hit = options.obstruction(pivot, toLens, length);
    if (hit !== undefined)
      camera.position.copy(pivot).addScaledVector(toLens, Math.max(MIN_ARM, hit - MARGIN));
  };

  const dolly = (amount: number, dt: number): void => {
    if (!Number.isFinite(amount) || !Number.isFinite(dt) || dt <= 0) return;
    distance = Math.min(maxDistance, Math.max(minDistance, distance - amount * dollySpeed * dt));
  };

  const targetOffset = (): Vector3 => currentOffset.copy(offsetDirection).multiplyScalar(distance);

  const snap = (target: Vector3): void => {
    camera.position.copy(target).add(targetOffset());
    clear(target);
    camera.lookAt(aim.copy(target).add(lookAhead));
  };

  const follow = (target: Vector3, dt: number): void => {
    desired.copy(target).add(targetOffset());
    // 1 - e^(-dt/damping): the frame-rate-independent form of a lerp. At 30fps
    // and 120fps the camera ends up in the same place after the same second.
    camera.position.lerp(desired, 1 - Math.exp(-dt / damping));
    clear(target);
    camera.lookAt(aim.copy(target).add(lookAhead));
  };

  return { dolly, follow, snap };
}
