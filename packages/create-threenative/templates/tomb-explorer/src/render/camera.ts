// Generated for you. Camera framing is yours to edit.
//
// The chase camera of the reference engine: it aims at a point inside the body, places its ideal
// position a fixed distance behind her yaw and ten degrees above, then closes on that point by
// dividing the remaining gap each update (exponential smoothing: quick when far, slow when near).
// The ideal is pulled in from any wall it would end up inside, and the lens is kept a margin clear
// of the floor and the ceiling.
//
// Reference: tomb-raider-i-ii `camera-follow` (los_camera.c:16 chase speed 10, camera/const.h:7
// distance 1536, los_camera.c:12 pitch, los_camera.c:369 vertical margin 255).
import { type PerspectiveCamera, Vector3 } from "three";
import { ceilingAt, floorAt, SOLID } from "../level.js";
import {
  CAMERA_AIM_HEIGHT,
  CAMERA_CHASE,
  CAMERA_DISTANCE,
  CAMERA_MARGIN,
  CAMERA_PITCH,
  TICK,
  UNIT,
} from "../tuning.js";
import { toWorld } from "./temple.js";

const _aim = new Vector3();
const _want = new Vector3();

export interface ICameraRig {
  /** `x`, `y`, `z` in units: the body. `yaw` is the camera's heading. */
  readonly follow: (x: number, y: number, z: number, yaw: number, dt: number) => void;
  readonly snap: (x: number, y: number, z: number, yaw: number) => void;
}

/** The ideal position in units, shortened until it clears the walls. */
function ideal(x: number, y: number, z: number, yaw: number): { x: number; y: number; z: number } {
  const aimY = y + CAMERA_AIM_HEIGHT;
  const back = CAMERA_DISTANCE * Math.cos(CAMERA_PITCH);
  const up = CAMERA_DISTANCE * Math.sin(CAMERA_PITCH);
  let fraction = 1;
  // March out from the aim point and stop short of the first wall or ceiling.
  for (let step = 1; step <= 12; step += 1) {
    const t = step / 12;
    const px = x - Math.sin(yaw) * back * t;
    const pz = z - Math.cos(yaw) * back * t;
    const py = aimY + up * t;
    const floor = floorAt(px, pz);
    if (
      floor >= SOLID ||
      floor > py - CAMERA_MARGIN * 0.5 ||
      ceilingAt(px, pz) < py + CAMERA_MARGIN
    ) {
      fraction = Math.max(0.15, (step - 1) / 12);
      break;
    }
  }
  return {
    x: x - Math.sin(yaw) * back * fraction,
    y: aimY + up * fraction,
    z: z - Math.cos(yaw) * back * fraction,
  };
}

export function createChaseCamera(camera: PerspectiveCamera): ICameraRig {
  camera.fov = 55;
  camera.updateProjectionMatrix();
  const place = (x: number, y: number, z: number, yaw: number, blend: number): void => {
    const target = ideal(x, y, z, yaw);
    const [wx, wy, wz] = toWorld(target.x, target.y, target.z);
    _want.set(wx, wy, wz);
    camera.position.lerp(_want, blend);
    const [ax, ay, az] = toWorld(x, y + CAMERA_AIM_HEIGHT, z);
    camera.lookAt(_aim.set(ax, ay, az));
  };
  return {
    follow: (x, y, z, yaw, dt) => {
      // One update divides the gap by the chase speed; a frame of `dt` seconds runs dt/TICK of them.
      place(x, y, z, yaw, 1 - (1 - 1 / CAMERA_CHASE) ** (dt / TICK));
    },
    snap: (x, y, z, yaw) => place(x, y, z, yaw, 1),
  };
}

export { UNIT };
