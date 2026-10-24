// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The chase camera, after MK64's: low behind the kart, looking a little ahead of it, the kart at
// the bottom middle of the frame. Its ground position eases toward its goal at 40% a tick and its
// height at 15% (`mk64: src/camera.c:22`, `:614-621`), so a hop or a ramp lifts the kart in the frame
// before the camera follows. It chases the direction of travel, not the nose, and swings 12° to
// the outside of a drift so the slide reads from the side.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import type { Kart } from "../entities/Kart.js";

export const CHASE = {
  /** Metres behind and above the kart, and how far ahead of it the camera looks. */
  behind: 6.2,
  height: 2.3,
  ahead: 5,
  lookHeight: 0.9,
  fov: 62,
  /** Share of the gap closed per 60 Hz tick: ground position, height, heading. */
  follow: 0.4,
  lift: 0.15,
  turn: 0.12,
  /** Extra heading swing during a drift, radians. */
  driftSwing: (12 * Math.PI) / 180,
  /** A boost pulls the camera back and widens the lens a little. */
  boostFov: 8,
} as const;

export interface IChaseCamera {
  update(kart: Kart, dt: number): void;
  snap(kart: Kart): void;
  debug(): Record<string, unknown>;
}

export function createChaseCamera(camera: PerspectiveCamera): IChaseCamera {
  camera.fov = CHASE.fov;
  camera.near = 0.2;
  camera.far = 1200;
  camera.updateProjectionMatrix();
  let heading = 0;
  let fov: number = CHASE.fov;
  const goal = new Vector3();
  const look = new Vector3();
  const place = (kart: Kart, rate: (share: number) => number): void => {
    // Chase the velocity's heading: in a slide the nose points in, the kart travels out.
    const swing = kart.drifting ? kart.driftSide * CHASE.driftSwing : 0;
    const target = kart.velocityYaw - swing;
    heading += (MathUtils.euclideanModulo(target - heading + Math.PI, Math.PI * 2) - Math.PI) * rate(CHASE.turn);
    const bx = Math.sin(heading);
    const bz = Math.cos(heading);
    goal.set(kart.x + bx * CHASE.behind, kart.y + CHASE.height, kart.z + bz * CHASE.behind);
    const k = rate(CHASE.follow);
    camera.position.x += (goal.x - camera.position.x) * k;
    camera.position.z += (goal.z - camera.position.z) * k;
    camera.position.y += (goal.y - camera.position.y) * rate(CHASE.lift);
    // Never under the road the kart is on.
    camera.position.y = Math.max(camera.position.y, kart.course.y[kart.index]! + 1.2);
    look.set(kart.x - bx * CHASE.ahead, kart.y + CHASE.lookHeight, kart.z - bz * CHASE.ahead);
    camera.lookAt(look);
    const boosting = kart.boostTicks > 0 || kart.miniTurboTicks > 0;
    const wantFov = CHASE.fov + (boosting ? CHASE.boostFov : 0);
    fov += (wantFov - fov) * rate(0.08);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  };
  return {
    debug: () => ({ fov: camera.fov, heading, position: camera.position.toArray() }),
    snap(kart) {
      heading = kart.velocityYaw;
      camera.position.set(
        kart.x + Math.sin(heading) * CHASE.behind,
        kart.y + CHASE.height,
        kart.z + Math.cos(heading) * CHASE.behind,
      );
      place(kart, () => 1);
    },
    update(kart, dt) {
      const ticks = dt * 60;
      place(kart, (share) => 1 - (1 - share) ** ticks);
    },
  };
}
