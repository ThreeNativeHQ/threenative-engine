// Generated for you. Camera framing is yours to edit.
//
// A high three-quarter view from the south: the lens sits behind and above the farmer and looks
// north across the field, so rows run left to right and the tile in front of the farmer reads
// clearly. The follow is a damped chase, so a stop settles instead of snapping.
//
// Reference: harvest-moon-64 card `camera-follow` keeps the camera as a world position the view
// is offset by; a damped follow gives the same settle.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** Where the camera sits relative to the farmer's body centre: above and behind (south). */
const OFFSET = new Vector3(0, 10.5, 8.5);
/** What it looks at relative to the same centre: a little ahead of the farmer. */
const AIM = new Vector3(0, 0, -1.6);
const FOLLOW_RATE = 5;
const _desired = new Vector3();
const _aim = new Vector3();

export interface ICameraRig {
  readonly follow: (target: Vector3, dt: number) => void;
  readonly snap: (target: Vector3) => void;
}

export function createFarmCamera(camera: PerspectiveCamera): ICameraRig {
  camera.fov = 45;
  camera.updateProjectionMatrix();
  return {
    follow: (target, dt) => {
      _desired.copy(target).add(OFFSET);
      camera.position.lerp(_desired, MathUtils.damp(0, 1, FOLLOW_RATE, dt));
      camera.lookAt(_aim.copy(target).add(AIM));
    },
    snap: (target) => {
      camera.position.copy(target).add(OFFSET);
      camera.lookAt(_aim.copy(target).add(AIM));
    },
  };
}
