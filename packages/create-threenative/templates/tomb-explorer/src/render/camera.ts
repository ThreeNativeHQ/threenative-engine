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
import { SOLID, ceilingAt, floorAt } from "../level.js";
import {
  CAMERA_AIM_HEIGHT,
  CAMERA_CHASE,
  CAMERA_DISTANCE,
  CAMERA_MARGIN,
  CAMERA_PITCH,
  TICK,
} from "../tuning.js";
import { toWorld } from "./temple.js";

const _aim = new Vector3();

export interface ICameraRig {
  /** `x`, `y`, `z` in units: the body. `yaw` is the camera's heading. */
  readonly follow: (x: number, y: number, z: number, yaw: number, dt: number) => void;
  readonly snap: (x: number, y: number, z: number, yaw: number) => void;
}

interface IPoint {
  x: number;
  y: number;
  z: number;
}

const STEPS = 24;
const MIN_FRACTION = 0.08;

/** How far along `from` to `to` (0 to 1) the line stays clear of walls, floors and ceilings. */
function clearFraction(from: IPoint, to: IPoint): number {
  for (let step = 1; step <= STEPS; step += 1) {
    const t = step / STEPS;
    const px = from.x + (to.x - from.x) * t;
    const pz = from.z + (to.z - from.z) * t;
    const py = from.y + (to.y - from.y) * t;
    const floor = floorAt(px, pz);
    if (
      floor >= SOLID ||
      floor > py - CAMERA_MARGIN * 0.5 ||
      ceilingAt(px, pz) < py + CAMERA_MARGIN
    ) {
      return Math.max(MIN_FRACTION, (step - 1) / STEPS);
    }
  }
  return 1;
}

function along(from: IPoint, to: IPoint, t: number): IPoint {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
  };
}

/** The ideal position in units, shortened until it clears the walls. */
function ideal(aim: IPoint, yaw: number): IPoint {
  const far = {
    x: aim.x - Math.sin(yaw) * CAMERA_DISTANCE * Math.cos(CAMERA_PITCH),
    y: aim.y + CAMERA_DISTANCE * Math.sin(CAMERA_PITCH),
    z: aim.z - Math.cos(yaw) * CAMERA_DISTANCE * Math.cos(CAMERA_PITCH),
  };
  return along(aim, far, clearFraction(aim, far));
}

export function createChaseCamera(camera: PerspectiveCamera): ICameraRig {
  camera.fov = 55;
  camera.updateProjectionMatrix();
  // The lens in units. It chases the ideal by smoothing, then is pulled in again from the aim point,
  // so a lagging lens never cuts a corner through a wall.
  let lens: IPoint | undefined;
  const place = (x: number, y: number, z: number, yaw: number, blend: number): void => {
    const aim = { x, y: y + CAMERA_AIM_HEIGHT, z };
    const target = ideal(aim, yaw);
    const chased = lens === undefined ? target : along(lens, target, blend);
    lens = along(aim, chased, clearFraction(aim, chased));
    const [wx, wy, wz] = toWorld(lens.x, lens.y, lens.z);
    camera.position.set(wx, wy, wz);
    const [ax, ay, az] = toWorld(aim.x, aim.y, aim.z);
    camera.lookAt(_aim.set(ax, ay, az));
  };
  return {
    follow: (x, y, z, yaw, dt) => {
      // One update divides the gap by the chase speed; a frame of `dt` seconds runs dt/TICK of them.
      place(x, y, z, yaw, 1 - (1 - 1 / CAMERA_CHASE) ** (dt / TICK));
    },
    snap: (x, y, z, yaw) => {
      lens = undefined;
      place(x, y, z, yaw, 1);
    },
  };
}
