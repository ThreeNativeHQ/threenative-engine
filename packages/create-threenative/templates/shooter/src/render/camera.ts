// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// First-person framing, in one place, because it is the loudest thing in a
// screenshot and the one thing every change to the fight touches: where the eye
// sits, how wide it sees, and how far it shakes when a round lands.
//
// A spring arm is the obvious thing to reach for and it is wrong here — the eye
// is welded to a head that physics already solved, so smoothing it only ever
// puts the crosshair somewhere the body is not. The rule this file exists to
// state is the opposite one: compose the camera from the body's *solved* pose,
// every frame, with no interpolation of its own.
import { MathUtils, type PerspectiveCamera } from "three";

/** The numbers a first-person camera is built from, in one table. */
export const FIRST_PERSON = {
  /** Hip-fire field of view, in degrees. Wide enough to see a soldier flanking. */
  hipFov: 70,
  /** Aimed field of view. A 22° sight picture is about 1.3× a real red dot. */
  aimFov: 22,
  /** Near plane: the viewmodel's own hands are 40 cm from the eye. */
  near: 0.02,
  /** Far plane: the town is 84 m and the sky behind it is further. */
  far: 240,
  /** How fast the field of view slides between hip and aimed. */
  fovRate: 14,
  pitchMin: MathUtils.degToRad(-66),
  pitchMax: MathUtils.degToRad(72),
} as const;

export interface IEyeFrame {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
  readonly pitch: number;
  /** 0..1 hit shake, eased by the caller. Zero when nothing has hit you. */
  readonly shake: number;
  /** Seconds since the scene started; the shake's phase, not a clock of its own. */
  readonly phase: number;
}

/**
 * Place the camera for this frame.
 *
 * `rotation.order` is `"YXZ"` so yaw is applied before pitch: with the default
 * order, looking up and turning at the same time rolls the horizon, which is the
 * single most common way a first-person camera goes wrong.
 */
export function applyFirstPerson(camera: PerspectiveCamera, frame: IEyeFrame): void {
  // A hit shoves the view; the caller decays it back to the aim, so the shake
  // never fights the player for control.
  const kick = frame.shake * frame.shake;
  camera.position.set(frame.x, frame.y, frame.z);
  camera.rotation.set(
    frame.pitch + Math.sin(frame.phase * 37) * 0.05 * kick,
    frame.yaw + Math.sin(frame.phase * 23) * 0.05 * kick,
    Math.sin(frame.phase * 17) * 0.04 * kick,
    "YXZ",
  );
}

/**
 * Set the projection once, at construction. Changing it per frame forces a
 * matrix rebuild for a value that never changes after the first call.
 */
export function configureFirstPerson(camera: PerspectiveCamera): void {
  camera.fov = FIRST_PERSON.hipFov;
  camera.near = FIRST_PERSON.near;
  camera.far = FIRST_PERSON.far;
  camera.updateProjectionMatrix();
}

/** The smoothed field of view for this frame, hip or aimed. */
export function firstPersonFov(current: number, aiming: boolean, dt: number): number {
  return MathUtils.damp(
    current,
    aiming ? FIRST_PERSON.aimFov : FIRST_PERSON.hipFov,
    FIRST_PERSON.fovRate,
    dt,
  );
}
