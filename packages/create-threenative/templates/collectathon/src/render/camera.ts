// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// An orbit follow camera. It sits behind the hero on a fixed arm, swings slowly toward the
// direction the hero travels (so a long run straightens the view out behind it), and pulls in
// in front of any wall between the hero and the arm's end. `scenes/Play.ts` calls `update` from
// `afterPhysics`: `moveAndSlide` only queues motion, so a camera written earlier frames where the
// body was, not where it ended up. The wall test is a function the scene passes in, because this
// folder imports no physics.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** Camera framing, in metres and radians. */
export const CAMERA_RIG = {
  /** Arm length from the aim point. */
  distance: 9,
  /** Arm angle above the horizon. */
  elevation: 0.32,
  /** The aim point sits this high above the hero's waist, so the ground ahead fills the frame. */
  aimHeight: 1.1,
  /**
   * The lens looks this far above the aim point at full arm length (less as the arm shortens), so
   * the view pitches about 8° down instead of the arm's 18°: the hero sits in the lower third and
   * the horizon, the hills and the castle fill the top, as in a 3D platformer's establishing view.
   */
  lookAbove: 1.6,
  /** How fast the arm swings toward the travel direction at full run, in 1/s. */
  swingRate: 1.6,
  /** Closest the camera comes to the aim point, even when the hero has its back to a wall. */
  minDistance: 0.3,
  /** Gap kept between the camera and the wall it is pulled in front of. */
  wallGap: 0.35,
  /** Ease toward the arm's end, in 1/s; a pull-in snaps instead. */
  followRate: 9,
  /**
   * When a wall would pull the camera closer than this, it looks for a clearer arm instead: in a
   * shaft the open side is beside the hero, and a camera at 0.3 m shows the back of the cap.
   */
  craneBelow: 4,
  /** The steepest arm angle it tries: 35° above the horizon, so the view never turns top-down. */
  craneElevation: 0.61,
  /** The headings it tries, as offsets from the current yaw, nearest first. */
  craneHeadings: [0, Math.PI / 2, -Math.PI / 2, Math.PI / 4, -Math.PI / 4, 2.36, -2.36],
  /** Mouse orbit, in radians per pixel of pointer motion. */
  lookSensitivity: 0.0035,
  /** The arm angles the mouse can tilt between: just above the ground to 50° above the horizon. */
  lookElevation: [0.05, 0.87],
  /** After the mouse turns the arm, the travel swing waits this long, in seconds. */
  lookHold: 1.5,
} as const;

/** Distance along the ray from `from` to `to` to the first wall, or undefined when clear. */
export type WallProbe = (from: Vector3, to: Vector3) => number | undefined;

export interface IOrbitCamera {
  /** The yaw the camera looks along (Three.js convention: forward is -Z at 0). */
  readonly yaw: number;
  /** Puts the camera behind a hero facing `yaw`, with no easing. */
  snap(target: Vector3, yaw: number, probe: WallProbe): void;
  /** Turns the arm by a pointer delta in pixels: right turns the view right, down raises the arm. */
  look(dx: number, dy: number): void;
  update(target: Vector3, velocity: Vector3, dt: number, probe: WallProbe): void;
  debug(): Record<string, unknown>;
}

export function createOrbitCamera(camera: PerspectiveCamera): IOrbitCamera {
  // 60° vertical is Unreal's 90° horizontal at 16:9.
  camera.fov = 60;
  camera.near = 0.1;
  camera.far = 2_000;
  camera.updateProjectionMatrix();
  const aim = new Vector3();
  const desired = new Vector3();
  const arm = new Vector3();
  let yaw = 0;
  let distance: number = CAMERA_RIG.distance;
  let elevation: number = CAMERA_RIG.elevation;
  // The arm angle at rest, which the mouse tilts, and how long the travel swing still waits.
  let tilt: number = CAMERA_RIG.elevation;
  let held = 0;
  let pulledIn = false;
  let cuts = 0;
  let peakElevation = elevation;
  let closest = distance;

  /** How far the arm reaches along `heading` at `angle`; also leaves `arm` pointing along it. */
  const reachAt = (heading: number, angle: number, probe: WallProbe): number => {
    const flat = Math.cos(angle);
    arm.set(Math.sin(heading) * flat, Math.sin(angle), Math.cos(heading) * flat);
    desired.copy(aim).addScaledVector(arm, CAMERA_RIG.distance);
    const hit = probe(aim, desired);
    return hit === undefined ? CAMERA_RIG.distance : hit - CAMERA_RIG.wallGap;
  };

  const place = (target: Vector3, probe: WallProbe, ease: number): void => {
    aim.set(target.x, target.y + CAMERA_RIG.aimHeight, target.z);
    // Crane: when the arm is boxed in, take the heading and angle that reach farthest. A new
    // heading is a cut, not a swing: an arm swept round a shaft passes through its wall.
    let goal = tilt;
    let heading = yaw;
    let best = reachAt(yaw, goal, probe);
    if (best < CAMERA_RIG.craneBelow) {
      for (const offset of CAMERA_RIG.craneHeadings) {
        // The 35° arm first: on a tie it looks down into a shaft instead of along its walls.
        for (const angle of [CAMERA_RIG.craneElevation, CAMERA_RIG.elevation]) {
          const reach = reachAt(yaw + offset, angle, probe);
          if (reach > best + 0.5) [heading, goal, best] = [yaw + offset, angle, reach];
        }
      }
    }
    if (heading !== yaw) {
      [yaw, elevation, distance] = [heading, goal, best];
      cuts += 1;
    }
    // Up is immediate, like a pull-in; back down is eased.
    elevation = goal > elevation ? goal : elevation + (goal - elevation) * ease;
    const hit = reachAt(yaw, elevation, probe);
    pulledIn = hit < CAMERA_RIG.distance;
    const reach = Math.max(CAMERA_RIG.minDistance, hit);
    // Out is eased, in is immediate: a camera that eases into a wall shows the inside of it.
    distance = reach < distance ? reach : distance + (reach - distance) * ease;
    camera.position.copy(aim).addScaledVector(arm, distance);
    camera.lookAt(aim.x, aim.y + (CAMERA_RIG.lookAbove * distance) / CAMERA_RIG.distance, aim.z);
    peakElevation = Math.max(peakElevation, elevation);
    closest = Math.min(closest, distance);
  };

  return {
    get yaw() {
      return yaw;
    },
    snap(target, heroYaw, probe) {
      yaw = heroYaw;
      distance = CAMERA_RIG.distance;
      elevation = tilt = CAMERA_RIG.elevation;
      held = 0;
      [cuts, peakElevation, closest] = [0, elevation, distance];
      place(target, probe, 1);
    },
    look(dx, dy) {
      if (dx === 0 && dy === 0) return;
      yaw -= dx * CAMERA_RIG.lookSensitivity;
      const [low, high] = CAMERA_RIG.lookElevation;
      tilt = MathUtils.clamp(tilt + dy * CAMERA_RIG.lookSensitivity, low, high);
      held = CAMERA_RIG.lookHold;
    },
    update(target, velocity, dt, probe) {
      const speed = Math.hypot(velocity.x, velocity.z);
      held = Math.max(0, held - dt);
      if (speed > 1 && held === 0) {
        const travel = Math.atan2(-velocity.x, -velocity.z);
        const turn = MathUtils.euclideanModulo(travel - yaw + Math.PI, Math.PI * 2) - Math.PI;
        // Running at the camera does not spin it round: only travel within 120° of the view swings it.
        if (Math.abs(turn) < (Math.PI * 2) / 3) {
          const rate = CAMERA_RIG.swingRate * Math.min(1, speed / 9.6);
          yaw += turn * (1 - Math.exp(-dt * rate));
        }
      }
      place(target, probe, 1 - Math.exp(-dt * CAMERA_RIG.followRate));
    },
    debug() {
      return { closest, cuts, distance, elevation, peakElevation, pulledIn, tilt, yaw };
    },
  };
}
