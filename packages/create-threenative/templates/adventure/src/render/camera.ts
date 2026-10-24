// Generated for you. Camera framing is yours to edit.
//
// A third-person follow camera, written from `afterPhysics` in `scenes/Play.ts`, so it frames
// where the body ended up this step rather than where it was. It owns no target logic: it reads
// the lock-on's target, if there is one, and eases its yaw onto the line from that target through
// Wren. Unlocked, it holds its yaw (it starts looking north) until the target button, pressed with
// nothing to lock, swings it behind Wren: "up" on the stick keeps its meaning until the player asks
// for a new one.
//
// Locked, it frames the fight the way Ocarina does: it slides over Wren's shoulder, drops,
// backs off for a tall or a close target, and aims part of the way toward the target, so Wren
// stands in the lower third and never hides what she fights. Its yaw, the one the stick reads,
// does not change: the shoulder offset and the aim only move the picture. Then it measures the
// picture: when Wren or the target would leave the frame, it turns the lens onto both of them and
// widens it, up to `FIT.maxFov`, until both fit.
//
// Then it checks the picture itself: while walls fill the front half of the way to Wren (a doorway
// behind her, the jamb of a nook she walks into), the arm shortens, so the camera follows her
// through instead of filming her past the stone.
import { Box3, MathUtils, type PerspectiveCamera, Quaternion, Vector3 } from "three";

const DISTANCE = 5.6;
const HEIGHT = 2.6;
/** Where it aims, above the body origin (Wren's waist): her shoulders. */
const AIM_HEIGHT = 0.9;
/** Yaw ease rate, per second. */
const YAW_RATE = 4;
/**
 * Ease rate, per second, of the camera's place and of the lock's orbit into the fight framing: a
 * lock that started on the fight line is off it within a few ticks, so Wren never hides the target.
 */
const FRAME_RATE = 10;
/** Distance kept in front of a wall the arm would pass through. */
const WALL_MARGIN = 0.35;
/** The most a pulled-in camera climbs above its usual height, unlocked. */
const MAX_CLIMB = 1.6;
/** The shortest arm, in metres. */
const MIN_ARM = 0.6;
/** How much the arm shortens per try while walls clutter the view. */
const ARM_STEP = 0.75;
/**
 * The most of the view (a 6 by 4 grid of rays) that walls in the front `reach` of the way to Wren
 * may cover before the arm shortens: stricter than the playtests' half-way and 20%, for margin.
 */
const CLUTTER = { reach: 0.6, share: 2 / 24 };
const FOV = 55;
/**
 * The fastest the view may turn, in radians per second (140°/s, about 2.3° a 60 Hz tick): a lock,
 * a target switch or a boss charging past swings the picture no faster, so it reads instead of
 * smearing. A snap (respawn, room change) is a cut and ignores it.
 */
const MAX_TURN = MathUtils.degToRad(140);
/** Wren's body around her origin (her waist), for the framing: soles to the top of her cap. */
const HERO = { below: 0.85, above: 0.95, radius: 0.35 };
/** Locked framing: both bodies stay inside `share` of the frame, the lens never wider than this. */
const FIT = { share: 0.8, maxFov: 75 };

/** The locked framing: every number a fight's picture depends on. */
const LOCK = {
  /** Metres beside Wren, over her shoulder on the side the camera orbits to. */
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
  /**
   * A target taller than `bigAt` metres (the Warden) swings on faster, `bigPerMetre`, up to
   * `bigOrbitMax` (77°, from 2 m in), so its chest reads beside Wren, not behind her: a sideways
   * step or a higher camera barely moves a 9 m arm's picture. A small target keeps the gentle
   * ramp: on the steep one a bat swooping past her comes round to the lens side.
   */
  bigAt: 2,
  bigPerMetre: 0.275,
  bigOrbitMax: 1.35,
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
  /**
   * Swings tried, nearest the wanted one first, when a wall cuts the arm under `clearShare` of its
   * length: with her back to a wall the camera films the fight from the side instead.
   */
  swings: [0, 0.5, -0.5, 1, -1, 1.5, -1.5],
  clearShare: 0.8,
};

/** A ray from `from` to `to`; returns the first hit, or undefined when nothing is in the way. */
export type CameraBlocker = (
  from: Vector3,
  to: Vector3,
) => { readonly distance: number; readonly normal: { readonly y: number } } | undefined;

/** The locked target, as the camera frames it: its live bounds and the marker's top. */
export interface ILockFrame {
  readonly bounds: Box3;
  readonly markerTop: number;
}

export interface IFollowCamera {
  /** The yaw the camera sits at around Wren: 0 puts it south of her, looking north. */
  readonly yaw: number;
  /** `watch`: a body kept in the picture with nothing locked, such as a boss that just woke. */
  update(focus: Vector3, lock: ILockFrame | undefined, dt: number, watch?: Box3): void;
  /** Swing round to `yaw` and stay there: the target button with nothing to lock recentres. */
  recenter(yaw: number): void;
  /** Jump to a pose at once: after a respawn or a room change, never ease across the map. */
  snap(focus: Vector3, yaw?: number): void;
}

export function setupCamera(camera: PerspectiveCamera, blocked: CameraBlocker): IFollowCamera {
  camera.fov = FOV;
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
  let watching = false;
  // The view's orientation last tick: the next one turns from it by at most MAX_TURN.
  const held = new Quaternion();
  const pivot = new Vector3();
  const desired = new Vector3();
  const aim = new Vector3();
  const goalAim = new Vector3();
  const middle = new Vector3();
  const direction = new Vector3();
  const forward = new Vector3();
  const across = new Vector3();
  const lift = new Vector3();
  const ray = new Vector3();
  const UP = new Vector3(0, 1, 0);
  const heroBox = new Box3();
  const corner = new Vector3();
  const shift = new Vector3();
  const goalShift = new Vector3();
  const look = new Vector3();
  const extent = { x0: 0, x1: 0, y0: 0, y1: 0 };
  // Widens `extent` by a box's corners, as view-space tangents; false when one is behind the lens.
  const measure = (box: Box3): boolean => {
    for (let i = 0; i < 8; i += 1) {
      corner.set(
        i & 1 ? box.max.x : box.min.x,
        i & 2 ? box.max.y : box.min.y,
        i & 4 ? box.max.z : box.min.z,
      );
      corner.applyMatrix4(camera.matrixWorldInverse);
      const depth = -corner.z;
      if (depth < 0.2) return false;
      extent.x0 = Math.min(extent.x0, corner.x / depth);
      extent.x1 = Math.max(extent.x1, corner.x / depth);
      extent.y0 = Math.min(extent.y0, corner.y / depth);
      extent.y1 = Math.max(extent.y1, corner.y / depth);
    }
    return true;
  };
  // The share of the view from `desired` toward the aim that a wall or ceiling (a hit not facing
  // up) covers near the lens: the grid `scenes/Play.ts` measures.
  const clutter = (): number => {
    const reach = desired.distanceTo(goalAim) * CLUTTER.reach;
    forward.subVectors(goalAim, desired).normalize();
    across.crossVectors(forward, UP).normalize();
    lift.crossVectors(across, forward);
    const tall = Math.tan(MathUtils.degToRad(camera.fov / 2));
    let walls = 0;
    for (let u = -0.75; u <= 0.76; u += 0.3)
      for (let v = -0.75; v <= 0.76; v += 0.5) {
        ray
          .copy(forward)
          .addScaledVector(across, u * tall * camera.aspect)
          .addScaledVector(lift, v * tall)
          .setLength(reach)
          .add(desired);
        const hit = blocked(desired, ray);
        if (hit !== undefined && hit.normal.y < 0.7) walls += 1;
      }
    return walls / 24;
  };
  // Locked, or with a boss awake (`watch`), turn the lens onto Wren and that body and widen it
  // until both fit; it eases at the camera's own rate, not the lock's, so a fight never opens with
  // Wren's feet or the boss's head off the frame.
  const frame = (focus: Vector3, box: Box3 | undefined, ease: number): void => {
    let fov = FOV;
    goalShift.set(0, 0, 0);
    if (box !== undefined) {
      camera.updateMatrixWorld();
      heroBox.min.set(focus.x - HERO.radius, focus.y - HERO.below, focus.z - HERO.radius);
      heroBox.max.set(focus.x + HERO.radius, focus.y + HERO.above, focus.z + HERO.radius);
      Object.assign(extent, {
        x0: Number.POSITIVE_INFINITY,
        x1: Number.NEGATIVE_INFINITY,
        y0: Number.POSITIVE_INFINITY,
        y1: Number.NEGATIVE_INFINITY,
      });
      if (measure(heroBox) && measure(box)) {
        const half = Math.max(
          (extent.y1 - extent.y0) / 2,
          (extent.x1 - extent.x0) / 2 / camera.aspect,
        );
        fov = MathUtils.clamp(MathUtils.radToDeg(2 * Math.atan(half / FIT.share)), FOV, FIT.maxFov);
        look.set((extent.x0 + extent.x1) / 2, (extent.y0 + extent.y1) / 2, -1);
        look.transformDirection(camera.matrixWorld).multiplyScalar(aim.distanceTo(camera.position));
        goalShift.copy(camera.position).add(look).sub(aim);
      } else goalShift.copy(shift);
    }
    shift.lerp(goalShift, ease);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov += (fov - camera.fov) * ease;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(look.copy(aim).add(shift));
  };
  // Lays the arm out at `view` into `pivot` and `desired`; returns where a wall cuts it.
  const arm = (
    focus: Vector3,
    view: number,
    distance: number,
    right: number,
  ): number | undefined => {
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
    return blocked(pivot, desired)?.distance;
  };
  // Puts `desired` `length` along the arm. Unlocked, a short arm climbs instead of ending at the
  // back of her head, and a second ray keeps that climb under the ceiling. Locked, the shoulder
  // offset already clears her head.
  const lay = (length: number, distance: number): void => {
    desired.copy(pivot).addScaledVector(direction, length);
    desired.y += Math.min(MAX_CLIMB, (distance - length) * 0.5) * (1 - locked);
    const roof = blocked(pivot, desired)?.distance;
    if (roof !== undefined) {
      ray.subVectors(desired, pivot).normalize();
      desired.copy(pivot).addScaledVector(ray, Math.max(MIN_ARM, roof - WALL_MARGIN));
    }
  };
  const place = (focus: Vector3, box: Box3 | undefined, ease: number, fit = ease): void => {
    const distance = DISTANCE + extra * locked;
    // The picture's yaw: the stick's yaw, swung right while locked.
    const view = yaw + swing * locked;
    const hit = arm(focus, view, distance, LOCK.shoulder * locked * Math.sign(swing || 1));
    direction.subVectors(desired, pivot).normalize();
    // Pull the arm in in front of a wall, so the camera never ends up inside one or behind it, then
    // shorter while walls clutter the view; when no length clears it, the least cluttered one.
    let length = hit === undefined ? distance : Math.max(MIN_ARM, hit - WALL_MARGIN);
    let best = length;
    let least = Number.POSITIVE_INFINITY;
    for (;;) {
      lay(length, distance);
      const share = clutter();
      if (share < least) {
        least = share;
        best = length;
      }
      if (share <= CLUTTER.share || length <= MIN_ARM) break;
      length = Math.max(MIN_ARM, length - ARM_STEP);
    }
    if (best !== length) lay(best, distance);
    aim.lerp(goalAim, ease);
    // Locked, never steeper than LOCK.maxPitch: a steep camera loses the target off the top.
    const run = Math.hypot(desired.x - aim.x, desired.z - aim.z);
    const cap = aim.y + run * Math.tan(LOCK.maxPitch);
    if (desired.y > cap) desired.y = MathUtils.lerp(desired.y, cap, locked);
    camera.position.lerp(desired, ease);
    // Easing toward a pose a wall just cut short can cross that wall: then it cuts, never eases.
    if (blocked(pivot, camera.position) !== undefined) camera.position.copy(desired);
    camera.lookAt(aim);
    frame(focus, box, fit);
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
    update(focus: Vector3, lock: ILockFrame | undefined, dt: number, watch?: Box3): void {
      const rate = 1 - Math.exp(-YAW_RATE * dt);
      const quick = 1 - Math.exp(-FRAME_RATE * dt);
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
        // It orbits on the side of the fight line it already films from, so a new lock or a target
        // switch never swings the picture across the line, where Wren would hide the target.
        const onLine = MathUtils.euclideanModulo(
          yaw + swing * locked - home + Math.PI,
          Math.PI * 2,
        );
        const big = lock.bounds.max.y - lock.bounds.min.y > LOCK.bigAt;
        const wantSwing =
          Math.sign(onLine - Math.PI || 1) *
          MathUtils.clamp(
            LOCK.orbit + (LOCK.orbitFrom - apart) * (big ? LOCK.bigPerMetre : LOCK.orbitPerMetre),
            LOCK.orbit,
            big ? LOCK.bigOrbitMax : LOCK.orbitMax,
          );
        let pick = wantSwing;
        let longest = -1;
        for (const step of LOCK.swings) {
          const free =
            arm(
              focus,
              yaw + wantSwing + step,
              DISTANCE + extra,
              LOCK.shoulder * Math.sign(wantSwing + step || 1),
            ) ?? Number.POSITIVE_INFINITY;
          if (free >= (DISTANCE + extra) * LOCK.clearShare) {
            pick = wantSwing + step;
            break;
          }
          if (free > longest) {
            longest = free;
            pick = wantSwing + step;
          }
        }
        swing += (pick - swing) * quick;
      }
      locked += ((lock === undefined ? 0 : 1) - locked) * quick;
      const turn = MathUtils.euclideanModulo(home - yaw + Math.PI, Math.PI * 2) - Math.PI;
      yaw += turn * rate;
      aimAt(focus, lock);
      // A boss that just woke is framed at once, a reveal cut; then the fit eases as a lock's does.
      const reveal = watch !== undefined && !watching && lock === undefined;
      watching = watch !== undefined;
      place(focus, lock?.bounds ?? watch, quick, reveal ? 1 : quick);
      camera.quaternion.copy(held.rotateTowards(camera.quaternion, MAX_TURN * dt));
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
      shift.set(0, 0, 0);
      place(focus, undefined, 1);
      held.copy(camera.quaternion);
    },
  };
}
