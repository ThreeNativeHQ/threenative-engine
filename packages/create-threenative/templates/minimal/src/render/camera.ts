// Generated for you. Camera framing is yours to edit.
import { type PerspectiveCamera, Vector3 } from "three";

/** Where the camera sits relative to the player's body centre: up and behind, over the shoulder. */
const OFFSET = new Vector3(0.6, 1.4, 4.6);
/** What it looks at relative to the same centre: just above the head, so the floor fills the frame. */
const AIM = new Vector3(0, 0.7, 0);
const _desired = new Vector3();
const _aim = new Vector3();
/** Clearance kept between the lens and a wall it was pulled in front of. */
const WALL_MARGIN = 0.3;
/** The most a pulled-in camera climbs above its usual height. */
const MAX_CLIMB = 1.6;

/** Metres from `from` toward `to` to the first wall, or undefined when the way is clear. */
export type WallProbe = (from: Vector3, to: Vector3) => number | undefined;

export function setupCamera(camera: PerspectiveCamera): void {
  // 60° vertical is Unreal's 90° horizontal at 16:9 — the framing a third-person game is judged by.
  camera.fov = 60;
  camera.near = 0.1;
  camera.far = 20_000;
  camera.position.set(-2 + OFFSET.x, 1 + OFFSET.y, OFFSET.z);
  camera.lookAt(-2, 1 + AIM.y, 0);
  camera.updateProjectionMatrix();
}

/**
 * A spring-arm follow: eases toward the offset behind `target` (framerate-independent) and aims
 * above it. A wall between the aim and the offset pulls the lens in front of it at once, so the
 * wall never hides the player, and the shortened arm climbs so the lens looks down on the player
 * instead of ending inside the head; a second ray keeps that climb out of the wall. It eases back
 * out once the way is clear. Call it after physics has moved the body, or the camera trails a
 * frame behind.
 */
export function followCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  dt: number,
  probe: WallProbe,
): void {
  _aim.copy(target).add(AIM);
  _desired.copy(target).add(OFFSET);
  const wall = probe(_aim, _desired);
  if (wall === undefined) camera.position.lerp(_desired, 1 - Math.exp(-dt * 8));
  else {
    const arm = _aim.distanceTo(_desired);
    const length = Math.max(0, wall - WALL_MARGIN);
    _desired.sub(_aim).setLength(length).add(_aim);
    _desired.y += Math.min(MAX_CLIMB, (arm - length) * 0.5);
    const roof = probe(_aim, _desired);
    if (roof !== undefined)
      _desired
        .sub(_aim)
        .setLength(Math.max(0, roof - WALL_MARGIN))
        .add(_aim);
    camera.position.copy(_desired);
  }
  camera.lookAt(_aim);
}
