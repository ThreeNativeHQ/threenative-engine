// Generated for you. Camera framing is yours to edit.
//
// Fixed cameras, the way the classic games framed every room: each zone in `src/level.ts` owns one
// authored lens, and crossing into another zone cuts to it on the same frame — never a pan, never a
// blend (silent-hill `camera-motion`: a pose jump past its easing limits snaps instead of easing).
// A zone marked `track` keeps its lens fixed but turns to follow the player.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import type { ICameraZone } from "../level.js";

const _look = new Vector3();
const _target = new Vector3();
const _now = new Vector3();

export interface IFixedCamera {
  /** Cut to a zone's pose. Calling it with the zone already shown does nothing. */
  readonly cut: (zone: ICameraZone, subject: Vector3) => boolean;
  /** Per frame, after physics: a tracking zone turns toward the subject. */
  readonly follow: (subject: Vector3, dt: number) => void;
  readonly zone: () => ICameraZone | undefined;
  readonly cuts: () => number;
}

export function createFixedCamera(camera: PerspectiveCamera): IFixedCamera {
  let current: ICameraZone | undefined;
  let cuts = 0;
  return {
    cut: (zone, subject) => {
      if (zone === current) return false;
      current = zone;
      cuts += 1;
      camera.position.set(zone.eye[0], zone.eye[1], zone.eye[2]);
      if (camera.fov !== zone.fov) {
        camera.fov = zone.fov;
        camera.updateProjectionMatrix();
      }
      _look.set(zone.look[0], zone.look[1], zone.look[2]);
      if (zone.track === true) _look.lerp(_target.copy(subject).setY(0.9), 0.6);
      camera.lookAt(_look);
      return true;
    },
    follow: (subject, dt) => {
      if (current?.track !== true) return;
      _target.set(current.look[0], current.look[1], current.look[2]);
      _target.lerp(_look.copy(subject).setY(0.9), 0.6);
      // Ease the pan only; the lens itself never moves inside a zone.
      const direction = _look.copy(_target).sub(camera.position).normalize();
      camera.getWorldDirection(_now);
      _now.lerp(direction, MathUtils.damp(0, 1, 4, dt)).normalize();
      camera.lookAt(_target.copy(camera.position).add(_now));
    },
    zone: () => current,
    cuts: () => cuts,
  };
}
