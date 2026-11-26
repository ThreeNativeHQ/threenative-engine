// The chase camera behind the ship. It follows the ship's offset from the rail at a fraction, so
// the ship slides toward the screen edge as it nears the corridor wall.
//
// Reference: Star Fox 64 `camera-rails` (the eye follows the offset by about 0.78) and
// `arwing-boost` / `arwing-brake` (boost pulls the camera back, braking pulls it in).
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import type { IRailFrame } from "../rail.js";
import { CAMERA } from "../tuning.js";

const _eye = new Vector3();
const _look = new Vector3();
const _axis = new Vector3();

export interface ICameraInput {
  /** Eye and look-at frames on the rail, written by the caller from `Rail.frameAt`. */
  readonly behind: IRailFrame;
  readonly ahead: IRailFrame;
  readonly offsetX: number;
  readonly offsetY: number;
  /** -1 braking, +1 boosting. */
  readonly push: number;
  readonly bank: number;
  /** A hit's shake, metres, added to the eye. */
  readonly shake: Vector3;
}

export interface IRailCamera {
  readonly follow: (input: ICameraInput, dt: number) => void;
  readonly snap: (input: ICameraInput) => void;
}

export function createRailCamera(camera: PerspectiveCamera): IRailCamera {
  camera.fov = CAMERA.fov;
  camera.updateProjectionMatrix();
  let setback = 0;
  const place = (input: ICameraInput, blend: number): void => {
    const { behind, ahead, offsetX, offsetY } = input;
    _eye
      .copy(behind.position)
      .addScaledVector(behind.right, offsetX * CAMERA.follow)
      .addScaledVector(behind.up, offsetY * CAMERA.follow + CAMERA.lift)
      .addScaledVector(behind.forward, -setback)
      .add(input.shake);
    _look
      .copy(ahead.position)
      .addScaledVector(ahead.right, offsetX * CAMERA.follow)
      .addScaledVector(ahead.up, offsetY * CAMERA.follow);
    camera.position.lerp(_eye, blend);
    camera.up
      .set(0, 1, 0)
      .applyAxisAngle(
        _axis.subVectors(_look, camera.position).normalize(),
        input.bank * CAMERA.roll,
      );
    camera.lookAt(_look);
  };
  return {
    follow: (input, dt) => {
      const target = input.push > 0 ? CAMERA.boostBack : input.push < 0 ? CAMERA.brakeBack : 0;
      setback = MathUtils.damp(setback, target, 4, dt);
      const fov = MathUtils.damp(camera.fov, input.push > 0 ? CAMERA.boostFov : CAMERA.fov, 4, dt);
      if (Math.abs(fov - camera.fov) > 0.01) {
        camera.fov = fov;
        camera.updateProjectionMatrix();
      }
      place(input, MathUtils.damp(0, 1, 9, dt));
    },
    snap: (input) => {
      setback = 0;
      place(input, 1);
    },
  };
}
