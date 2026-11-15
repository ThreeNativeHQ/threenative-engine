// Generated for you. Camera framing is yours to edit.
//
// The action-RPG three-quarter view: high and behind, far enough back that the room reads as a
// room. It has to clear the **south wall**, which stands at z = +6 and is low so the camera can
// see over it — the oldest trick in an isometric dungeon, and it costs one row of wall table.
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

/** Where the camera sits relative to the player's body centre. */
const OFFSET = new Vector3(0, 10.2, 9.2);
/** What it looks at relative to the same centre: past the player, into the room ahead. */
const AIM = new Vector3(0, 0.4, -1.8);
const _desired = new Vector3();
const _aim = new Vector3();

export interface ICameraRig {
  readonly follow: (target: Vector3, dt: number) => void;
  readonly snap: (target: Vector3) => void;
}

export function createDungeonCamera(camera: PerspectiveCamera): ICameraRig {
  const pose = (target: Vector3): void => {
    camera.position.copy(target).add(OFFSET);
    camera.lookAt(_aim.copy(target).add(AIM));
  };
  return {
    follow: (target, dt) => {
      _desired.copy(target).add(OFFSET);
      camera.position.lerp(_desired, MathUtils.damp(0, 1, 5, dt));
      camera.lookAt(_aim.copy(target).add(AIM));
    },
    snap: pose,
  };
}
