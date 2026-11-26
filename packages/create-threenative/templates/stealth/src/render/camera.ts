// Generated for you. Camera framing is yours to edit.
//
// The overhead infiltration view: high, steep, north always up, so a guard's patrol reads as a
// path across the floor and the radar matches the screen. At a wall end the view turns toward the
// side the player leans out of — the corner peek that shows what waits around it.
//
// Steep on purpose: the lens drops 4.7 m for every metre it sits back, so a 2.2 m wall or crate
// touching the player's back still passes under the line to the player's chest. Tilt it further
// and a player pressed to the north face of a wall disappears behind it.
//
// Reference: metal-gear-solid-1 `chase-camera-follow` — a short exponential phase, then a linear
// blend before it locks; a damped follow with a fast rate gives the same settle.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** Where the camera sits relative to the player's body centre: high and a little south. */
const OFFSET = new Vector3(0, 15, 3.2);
/** What it looks at relative to the same centre. */
const AIM = new Vector3(0, 0, -0.6);
/** How far the aim slides toward the wall end the player leans out of, metres. The lens stays put. */
const PEEK = 3.2;
const FOLLOW_RATE = 6;
const _desired = new Vector3();
const _aim = new Vector3();
const _peek = new Vector3();

export interface ICameraRig {
  readonly follow: (target: Vector3, peek: { x: number; z: number }, dt: number) => void;
  readonly snap: (target: Vector3) => void;
}

export function createInfiltrationCamera(camera: PerspectiveCamera): ICameraRig {
  camera.fov = 50;
  camera.updateProjectionMatrix();
  return {
    follow: (target, peek, dt) => {
      _peek.lerp(_desired.set(peek.x * PEEK, 0, peek.z * PEEK), MathUtils.damp(0, 1, 4, dt));
      _desired.copy(target).add(OFFSET);
      camera.position.lerp(_desired, MathUtils.damp(0, 1, FOLLOW_RATE, dt));
      camera.lookAt(_aim.copy(target).add(_peek).add(AIM));
    },
    snap: (target) => {
      _peek.set(0, 0, 0);
      camera.position.copy(target).add(OFFSET);
      camera.lookAt(_aim.copy(target).add(AIM));
    },
  };
}
