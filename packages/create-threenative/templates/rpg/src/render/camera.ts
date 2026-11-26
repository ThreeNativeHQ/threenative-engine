// Generated for you. Camera framing is yours to edit.
//
// A three-quarter view behind the leader, north always up, so the party reads as a group and a
// click-free keyboard lead is simple. In a conversation the camera cuts to a shot that holds both
// speakers, framed the way the reference does.
//
// Reference: star-wars-knights-of-the-old-republic-reone card `conversation-framing`
// (object/camera/dialog.cpp): the two-subject shot puts the eye 2.25 times the speaker gap to the
// side of the midpoint, capped at 4 m (:110), lifts it 0.25 m and aims 0.25 m below the midpoint
// (:114). Card `camera-relative-movement`: the held keys resolve against the camera yaw, which is
// fixed at zero here, so up is north.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** Where the camera sits relative to the leader's body centre: high and south. */
const OFFSET = new Vector3(0, 12, 8.5);
const AIM = new Vector3(0, 0, -1);
const FOLLOW_RATE = 6;
const CUT_RATE = 8;
/** dialog.cpp:110. */
const BOTH_OFFSET_FRACTION = 2.25;
const BOTH_OFFSET_CAP = 4;
/** dialog.cpp:114, and the lift of the eye over the midpoint. */
const BOTH_AIM_DROP = 0.25;
const BOTH_LIFT = 0.25;
/** Body centre height of a standing figure, so "the midpoint" is at the chest. */
const CHEST = 1.35;
const _desired = new Vector3();
const _aim = new Vector3();
const _look = new Vector3();

export interface ICameraRig {
  readonly follow: (target: Vector3, dt: number) => void;
  /** Hold the two-subject shot between a speaker and a listener. */
  readonly converse: (a: Vector3, b: Vector3, dt: number) => void;
  readonly snap: (target: Vector3) => void;
}

export function createPartyCamera(camera: PerspectiveCamera): ICameraRig {
  camera.fov = 50;
  camera.updateProjectionMatrix();
  _look.set(0, 0, 0);
  const move = (eye: Vector3, aim: Vector3, rate: number, dt: number): void => {
    camera.position.lerp(eye, MathUtils.damp(0, 1, rate, dt));
    _look.lerp(aim, MathUtils.damp(0, 1, rate, dt));
    camera.lookAt(_look);
  };
  return {
    converse: (a, b, dt) => {
      const gap = Math.hypot(b.x - a.x, b.z - a.z);
      const mid = _aim.set((a.x + b.x) / 2, CHEST, (a.z + b.z) / 2);
      // The side of the line a-b that faces the camp's south edge, so the shot never looks from behind a wall.
      const dirX = (b.x - a.x) / Math.max(gap, 1e-6);
      const dirZ = (b.z - a.z) / Math.max(gap, 1e-6);
      let sideX = -dirZ;
      let sideZ = dirX;
      if (sideZ < 0) {
        sideX = -sideX;
        sideZ = -sideZ;
      }
      const push = Math.min(gap * BOTH_OFFSET_FRACTION, BOTH_OFFSET_CAP);
      _desired.set(mid.x + sideX * push, mid.y + BOTH_LIFT, mid.z + sideZ * push);
      mid.y -= BOTH_AIM_DROP;
      move(_desired, mid, CUT_RATE, dt);
    },
    follow: (target, dt) => {
      _desired.copy(target).add(OFFSET);
      move(_desired, _aim.copy(target).add(AIM), FOLLOW_RATE, dt);
    },
    snap: (target) => {
      camera.position.copy(target).add(OFFSET);
      _look.copy(target).add(AIM);
      camera.lookAt(_look);
    },
  };
}
