// The first-person camera: it rides the solved eye pose, takes the recoil kick on the view and the
// aim blend on the field of view. The render layer owns the numbers, the player owns the pose.
import { MathUtils, type PerspectiveCamera, type Vector3 } from "three";

/** What the camera reads off the player each frame. */
export interface IEyePose {
  /** How far into aim-down-sights the weapon is, 0 to 1. */
  readonly ads: number;
  /** The eye, in world space, solved by physics. */
  readonly eye: Vector3;
  /** Vertical field of view in degrees: hip, then aim-down-sights. */
  readonly fov: { readonly ads: number; readonly hip: number };
  readonly kickPitch: number;
  readonly kickYaw: number;
  readonly pitch: number;
  readonly yaw: number;
}

/** Places the camera on the pose, with the kick on the view and the field of view on the blend. */
export function syncEyeCamera(camera: PerspectiveCamera, pose: IEyePose): void {
  camera.position.copy(pose.eye);
  camera.rotation.set(
    pose.pitch + MathUtils.degToRad(pose.kickPitch),
    pose.yaw + MathUtils.degToRad(pose.kickYaw),
    0,
    "YXZ",
  );
  const fov = MathUtils.lerp(pose.fov.hip, pose.fov.ads, pose.ads);
  if (Math.abs(camera.fov - fov) > 0.01) {
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }
}
