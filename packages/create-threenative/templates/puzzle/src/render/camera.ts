// Ordinary Three.js — ThreeNative does not read this file.
//
// One fixed three-quarter shot of the whole vault, because the reference is a room portrait: the
// warden, the pile, the phase crates and the seal are all supposed to be legible on the first
// screen, and a camera that trails the character loses two of the four every time it moves.
//
// It still breathes. `settle` eases the framing in over the opening drop, and `nudge` lets the
// shot drift a fraction of a metre toward the warden so the picture is not completely static.
import type { PerspectiveCamera, Vector3 } from "three";
import { MathUtils, Vector3 as Vec3 } from "three";

export const VAULT_SHOT = {
  fov: 31,
  /**
   * Where the camera sits: about 44 degrees above the floor and 30 degrees off the room's axis.
   *
   * The yaw is the part that matters, and about twenty degrees is the window. An axis-aligned shot puts the near wall across the bottom of
   * the frame as a flat band and flattens the whole room into a rectangle; swinging the camera
   * onto the corner is what makes the left wall recede and gives the picture the diagonal the
   * reference is built on; past thirty the room reads as a diamond with dead corners.
   *
   * The numbers are solved rather than eyeballed. Four attempts at nudging them by hand each cost
   * a build and a screenshot and each landed with the room cropped on one side; projecting the
   * room's eight outer corners through this exact camera and binary-searching the distance found
   * a fit in one pass. Yaw 17 degrees, elevation 41, the room spanning 1.84 of the 2.0 of clip
   * space vertically — so the near wall is just cropped, as it is in the reference — and biased a
   * little right of centre, which is where the HUD is not.
   */
  position: new Vec3(-4.35, 13.33, 14.72),
  /** What it points at: the middle of the room, biased toward the seal corner. */
  target: new Vec3(0, 0.4, 0.5),
  /** How far the shot is allowed to drift toward the warden, in metres. */
  drift: 0.1,
} as const;

export interface IVaultCamera {
  readonly snap: () => void;
  readonly follow: (subject: Vector3, dt: number) => void;
}

export function createVaultCamera(camera: PerspectiveCamera): IVaultCamera {
  camera.fov = VAULT_SHOT.fov;
  camera.near = 0.5;
  camera.far = 90;
  camera.updateProjectionMatrix();

  const desired = new Vec3();
  const aim = new Vec3();
  const currentAim = VAULT_SHOT.target.clone();

  const snap = (): void => {
    camera.position.copy(VAULT_SHOT.position);
    currentAim.copy(VAULT_SHOT.target);
    camera.lookAt(currentAim);
  };

  const follow = (subject: Vector3, dt: number): void => {
    // Drift a fraction of a metre toward the warden and no further. The shot is the room; this
    // is only enough parallax that the picture is not a still.
    aim.copy(subject).sub(VAULT_SHOT.target);
    aim.y = 0;
    if (aim.lengthSq() > 1e-6) aim.normalize().multiplyScalar(VAULT_SHOT.drift);
    else aim.set(0, 0, 0);
    desired.copy(VAULT_SHOT.position).add(aim);
    // 1 - e^(-dt/tau) is the framerate-independent form of a lerp: the same second of drift at
    // 30 fps and at 120 fps ends in the same place.
    camera.position.lerp(desired, MathUtils.damp(0, 1, 1 / 0.9, dt));
    camera.lookAt(currentAim);
  };

  return { follow, snap };
}
