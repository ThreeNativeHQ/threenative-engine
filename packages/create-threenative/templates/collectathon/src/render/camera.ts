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
  /** How fast the arm swings toward the travel direction at full run, in 1/s. */
  swingRate: 1.6,
  /** Closest the camera comes to the aim point, even when the hero has its back to a wall. */
  minDistance: 0.3,
  /** Gap kept between the camera and the wall it is pulled in front of. */
  wallGap: 0.35,
  /** Ease toward the arm's end, in 1/s; a pull-in snaps instead. */
  followRate: 9,
} as const;

/** Distance along the ray from `from` to `to` to the first wall, or undefined when clear. */
export type WallProbe = (from: Vector3, to: Vector3) => number | undefined;

export interface IOrbitCamera {
  /** The yaw the camera looks along (Three.js convention: forward is -Z at 0). */
  readonly yaw: number;
  /** Puts the camera behind a hero facing `yaw`, with no easing. */
  snap(target: Vector3, yaw: number, probe: WallProbe): void;
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
  let pulledIn = false;

  const place = (target: Vector3, probe: WallProbe, ease: number): void => {
    aim.set(target.x, target.y + CAMERA_RIG.aimHeight, target.z);
    const flat = Math.cos(CAMERA_RIG.elevation);
    arm.set(Math.sin(yaw) * flat, Math.sin(CAMERA_RIG.elevation), Math.cos(yaw) * flat);
    desired.copy(aim).addScaledVector(arm, CAMERA_RIG.distance);
    const hit = probe(aim, desired);
    pulledIn = hit !== undefined;
    const reach =
      hit === undefined
        ? CAMERA_RIG.distance
        : Math.max(CAMERA_RIG.minDistance, hit - CAMERA_RIG.wallGap);
    // Out is eased, in is immediate: a camera that eases into a wall shows the inside of it.
    distance = reach < distance ? reach : distance + (reach - distance) * ease;
    camera.position.copy(aim).addScaledVector(arm, distance);
    camera.lookAt(aim);
  };

  return {
    get yaw() {
      return yaw;
    },
    snap(target, heroYaw, probe) {
      yaw = heroYaw;
      distance = CAMERA_RIG.distance;
      place(target, probe, 1);
    },
    update(target, velocity, dt, probe) {
      const speed = Math.hypot(velocity.x, velocity.z);
      if (speed > 1) {
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
      return { distance, pulledIn, yaw };
    },
  };
}
