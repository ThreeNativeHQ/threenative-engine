// Generated for you. Camera framing is yours to edit.
//
// A third-person follow camera, written from `afterPhysics` in `scenes/Play.ts`, so it frames
// where the body ended up this step rather than where it was. It owns no target logic: it reads
// the lock-on's target, if there is one, and eases its yaw onto the line from that target through
// Wren. Unlocked, it holds its yaw (it starts looking north) until the target button, pressed with
// nothing to lock, swings it behind Wren: "up" on the stick keeps its meaning until the player asks
// for a new one.
//
// Locked, it frames the fight the way Ocarina does: it slides over Wren's right shoulder, drops,
// backs off for a tall or a close target, and aims part of the way toward the target, so Wren
// stands in the lower third and never hides what she fights. Its yaw, the one the stick reads,
// does not change: the shoulder offset and the aim only move the picture.
import { type Box3, MathUtils, type PerspectiveCamera, Vector3 } from "three";

const DISTANCE = 5.6;
const HEIGHT = 2.6;
/** Where it aims, above the body origin (Wren's waist): her shoulders. */
const AIM_HEIGHT = 0.9;
/** Yaw ease rate, per second. */
const YAW_RATE = 4;
/** Distance kept in front of a wall the arm would pass through. */
const WALL_MARGIN = 0.35;
/** The most a pulled-in camera climbs above its usual height, unlocked. */
const MAX_CLIMB = 1.6;

/** The locked framing: every number a fight's picture depends on. */
const LOCK = {
  /** Metres to the right of Wren, over her shoulder. */
  shoulder: 0.7,
  /**
   * Radians the camera swings round Wren to her right while it keeps aiming down the fight: the
   * shoulder offset alone leaves a target 3-8 m ahead behind her on screen. A far target needs
   * `orbit`; each metre closer than `orbitFrom` adds `orbitPerMetre`, up to `orbitMax`.
   */
  orbit: 0.25,
  orbitFrom: 6,
  orbitPerMetre: 0.11,
  orbitMax: 0.75,
  /** Metres added to the arm while locked. */
  back: 1,
  /** Metres added when the target is closer than `closeAt`, so Wren never hides it. */
  closeBack: 1.5,
  closeAt: 3,
  /** Metres added per metre the target stands taller than Wren, up to `tallMax`. */
  tallBack: 0.8,
  tallMax: 2,
  /** The arm never grows past this. */
  maxDistance: 9,
  /** How much lower than `HEIGHT` the camera sits. */
  drop: 0.6,
  /** The share of the way the aim moves from Wren's shoulders toward the target's middle. */
  aimPull: 0.45,
  /** The steepest the camera looks down at its aim. */
  maxPitch: MathUtils.degToRad(35),
};

/** A ray from `from` to `to`; returns the hit distance, or undefined when nothing is in the way. */
export type CameraBlocker = (from: Vector3, to: Vector3) => number | undefined;

/** The locked target, as the camera frames it: its live bounds and the marker's top. */
export interface ILockFrame {
  readonly bounds: Box3;
  readonly markerTop: number;
}

export interface IFollowCamera {
  /** The yaw the camera sits at around Wren: 0 puts it south of her, looking north. */
  readonly yaw: number;
  update(focus: Vector3, lock: ILockFrame | undefined, dt: number): void;
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
  // 0 unlocked, 1 locked, eased between, so a lock glides into the fight framing.
  let locked = 0;
  let extra = 0;
  let swing = LOCK.orbit;
  const pivot = new Vector3();
  const desired = new Vector3();
  const aim = new Vector3();
  const goalAim = new Vector3();
  const middle = new Vector3();
  const direction = new Vector3();
  const place = (focus: Vector3, ease: number): void => {
    const distance = DISTANCE + extra * locked;
    const right = LOCK.shoulder * locked;
    // The picture's yaw: the stick's yaw, swung right while locked.
    const view = yaw + swing * locked;
    pivot.set(
      focus.x + Math.cos(view) * right,
      focus.y + AIM_HEIGHT + 0.4,
      focus.z - Math.sin(view) * right,
    );
    desired.set(
      pivot.x + Math.sin(view) * distance,
      focus.y + HEIGHT - LOCK.drop * locked,
      pivot.z + Math.cos(view) * distance,
    );
    // Pull the arm in in front of a wall, so the camera never ends up inside one or behind it.
    // Unlocked, a short arm climbs instead of ending at the back of her head, and a second ray
    // keeps that climb under the ceiling. Locked, the shoulder offset already clears her head.
    const hit = blocked(pivot, desired);
    if (hit !== undefined) {
      const length = Math.max(0.6, hit - WALL_MARGIN);
      direction.subVectors(desired, pivot).normalize();
      desired.copy(pivot).addScaledVector(direction, length);
      desired.y += Math.min(MAX_CLIMB, (distance - length) * 0.5) * (1 - locked);
      const roof = blocked(pivot, desired);
      if (roof !== undefined) {
        direction.subVectors(desired, pivot).normalize();
        desired.copy(pivot).addScaledVector(direction, Math.max(0.6, roof - WALL_MARGIN));
      }
    }
    aim.lerp(goalAim, ease);
    // Locked, never steeper than LOCK.maxPitch: a steep camera loses the target off the top.
    const run = Math.hypot(desired.x - aim.x, desired.z - aim.z);
    const cap = aim.y + run * Math.tan(LOCK.maxPitch);
    if (desired.y > cap) desired.y = MathUtils.lerp(desired.y, cap, locked);
    camera.position.lerp(desired, ease);
    camera.lookAt(aim);
  };
  const aimAt = (focus: Vector3, lock: ILockFrame | undefined): void => {
    goalAim.set(focus.x, focus.y + AIM_HEIGHT, focus.z);
    if (lock === undefined) return;
    lock.bounds.getCenter(middle);
    middle.y = (lock.bounds.min.y + Math.max(lock.bounds.max.y, lock.markerTop)) / 2;
    goalAim.lerp(middle, LOCK.aimPull);
  };
  return {
    get yaw(): number {
      return yaw;
    },
    update(focus: Vector3, lock: ILockFrame | undefined, dt: number): void {
      const rate = 1 - Math.exp(-YAW_RATE * dt);
      if (lock !== undefined) {
        lock.bounds.getCenter(middle);
        home = Math.atan2(focus.x - middle.x, focus.z - middle.z);
        const apart = Math.hypot(focus.x - middle.x, focus.z - middle.z);
        const tall = Math.max(lock.bounds.max.y, lock.markerTop) - (focus.y + AIM_HEIGHT + 1);
        const goal =
          LOCK.back +
          (apart < LOCK.closeAt ? LOCK.closeBack : 0) +
          MathUtils.clamp(tall * LOCK.tallBack, 0, LOCK.tallMax);
        extra += (Math.min(goal, LOCK.maxDistance - DISTANCE) - extra) * rate;
        const wantSwing = MathUtils.clamp(
          LOCK.orbit + (LOCK.orbitFrom - apart) * LOCK.orbitPerMetre,
          LOCK.orbit,
          LOCK.orbitMax,
        );
        swing += (wantSwing - swing) * rate;
      }
      locked += ((lock === undefined ? 0 : 1) - locked) * rate;
      const turn = MathUtils.euclideanModulo(home - yaw + Math.PI, Math.PI * 2) - Math.PI;
      yaw += turn * rate;
      aimAt(focus, lock);
      place(focus, 1 - Math.exp(-10 * dt));
    },
    recenter(to: number): void {
      home = to;
    },
    snap(focus: Vector3, to = 0): void {
      yaw = to;
      home = to;
      locked = 0;
      aimAt(focus, undefined);
      aim.copy(goalAim);
      place(focus, 1);
    },
  };
}
