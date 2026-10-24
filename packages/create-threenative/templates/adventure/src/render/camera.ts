// Generated for you. Camera framing is yours to edit.
//
// A third-person follow camera, written from `afterPhysics` in `scenes/Play.ts`, so it frames
// where the body ended up this step rather than where it was. It owns no target logic: it reads
// the lock-on's target, if there is one, and eases its yaw onto the line from that target through
// Wren, so both stay in frame. Unlocked, it holds its yaw (it starts looking north) until the
// target button, pressed with nothing to lock, swings it behind Wren: "up" on the stick keeps its
// meaning until the player asks for a new one.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

const DISTANCE = 5.6;
const HEIGHT = 2.6;
/** Where it aims, above the body origin (Wren's waist): her shoulders. */
const AIM_HEIGHT = 0.9;
/** Yaw ease rate, per second. */
const YAW_RATE = 4;
/** Distance kept in front of a wall the arm would pass through. */
const WALL_MARGIN = 0.35;
/** The most a pulled-in camera climbs above its usual height. */
const MAX_CLIMB = 1.6;

/** A ray from `from` to `to`; returns the hit distance, or undefined when nothing is in the way. */
export type CameraBlocker = (from: Vector3, to: Vector3) => number | undefined;

export interface IFollowCamera {
  /** The yaw the camera sits at around Wren: 0 puts it south of her, looking north. */
  readonly yaw: number;
  update(focus: Vector3, target: Vector3 | undefined, dt: number): void;
  /** Swing round to `yaw` and stay there: the target button with nothing to lock recentres. */
  recenter(yaw: number): void;
  /** Jump to a pose at once: after a respawn or a room change, never ease across the map. */
  snap(focus: Vector3, yaw?: number): void;
}

export function setupCamera(camera: PerspectiveCamera, blocked: CameraBlocker): IFollowCamera {
  camera.fov = 55;
  camera.near = 0.1;
  camera.far = 600;
  camera.updateProjectionMatrix();
  let yaw = 0;
  // Unlocked, the camera holds this yaw; a lock swings it onto the target line and leaves it there.
  let home = 0;
  const pivot = new Vector3();
  const desired = new Vector3();
  const aim = new Vector3();
  const direction = new Vector3();
  const place = (focus: Vector3, ease: number): void => {
    pivot.set(focus.x, focus.y + AIM_HEIGHT + 0.4, focus.z);
    desired.set(
      focus.x + Math.sin(yaw) * DISTANCE,
      focus.y + HEIGHT,
      focus.z + Math.cos(yaw) * DISTANCE,
    );
    // Pull the arm in in front of a wall, so the camera never ends up inside one or behind it.
    // A short arm climbs instead of ending at the back of her head: with a wall at her back the
    // camera looks down over her, and a second ray keeps that climb under the ceiling.
    const hit = blocked(pivot, desired);
    if (hit !== undefined) {
      const length = Math.max(0.6, hit - WALL_MARGIN);
      direction.subVectors(desired, pivot).normalize();
      desired.copy(pivot).addScaledVector(direction, length);
      desired.y += Math.min(MAX_CLIMB, (DISTANCE - length) * 0.5);
      const roof = blocked(pivot, desired);
      if (roof !== undefined) {
        direction.subVectors(desired, pivot).normalize();
        desired.copy(pivot).addScaledVector(direction, Math.max(0.6, roof - WALL_MARGIN));
      }
    }
    camera.position.lerp(desired, ease);
    camera.lookAt(aim.set(focus.x, focus.y + AIM_HEIGHT, focus.z));
  };
  return {
    get yaw(): number {
      return yaw;
    },
    update(focus: Vector3, target: Vector3 | undefined, dt: number): void {
      if (target !== undefined) home = Math.atan2(focus.x - target.x, focus.z - target.z);
      const goal = home;
      const turn = MathUtils.euclideanModulo(goal - yaw + Math.PI, Math.PI * 2) - Math.PI;
      yaw += turn * (1 - Math.exp(-YAW_RATE * dt));
      place(focus, 1 - Math.exp(-10 * dt));
    },
    recenter(to: number): void {
      home = to;
    },
    snap(focus: Vector3, to = 0): void {
      yaw = to;
      home = to;
      place(focus, 1);
    },
  };
}
