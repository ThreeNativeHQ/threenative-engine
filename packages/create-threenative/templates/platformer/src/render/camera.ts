// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// One side-on camera that trails the fox and leads the run. It is called from `afterPhysics` in
// `scenes/Play.ts`, never from the scene's own frame function: `moveAndSlide` only queues motion,
// so a camera written before the physics step frames where the body was, not where it ended up.
import { type PerspectiveCamera, Vector3 } from "three";

/** Behind and above, in metres, from the fox. */
const CAMERA_OFFSET = { x: -5.5, y: 5.2, z: 14.5 } as const;
/** Rate the camera closes on its target. Above 0 the frame time is treated as seconds. */
const FOLLOW_RATE = 0.0018;

/** Where the lens must stop: how far a ray runs before it meets something solid, or `undefined`. */
export type LensObstruction = (
  origin: Vector3,
  direction: Vector3,
  far: number,
) => number | undefined;

// Godot's SpringArm3D collision: the ray starts at the fox's chest, never at the ground under her,
// and the lens stops `MARGIN` short of what it met, never closer than `MIN_ARM` to her.
const PIVOT_HEIGHT = 1;
const MARGIN = 0.5;
const MIN_ARM = 1.5;
const pivot = new Vector3();
const toLens = new Vector3();

export function setupCamera(camera: PerspectiveCamera): void {
  camera.fov = 52;
  camera.near = 0.1;
  camera.far = 900;
  camera.updateProjectionMatrix();
}

export function followCamera(
  camera: PerspectiveCamera,
  player: Vector3,
  velocityX: number,
  dt: number,
  obstruction?: LensObstruction,
): void {
  camera.position.x += (player.x + CAMERA_OFFSET.x - camera.position.x) * (1 - FOLLOW_RATE ** dt);
  camera.position.y +=
    (Math.max(player.y + CAMERA_OFFSET.y, player.y + 2.2) - camera.position.y) *
    (1 - FOLLOW_RATE ** dt);
  camera.position.z = player.z + CAMERA_OFFSET.z;
  if (obstruction !== undefined) {
    // A cliff, a tower or an island between the lens and the fox pulls the lens in front of it.
    pivot.copy(player);
    pivot.y += PIVOT_HEIGHT;
    toLens.subVectors(camera.position, pivot);
    const length = toLens.length();
    if (length > MIN_ARM) {
      toLens.multiplyScalar(1 / length);
      const hit = obstruction(pivot, toLens, length);
      if (hit !== undefined)
        camera.position.copy(pivot).addScaledVector(toLens, Math.max(MIN_ARM, hit - MARGIN));
    }
  }
  // Look ahead of the run, so the next gap is on screen before the fox reaches it.
  camera.lookAt(player.x + 3.4 + velocityX * 0.14, player.y + 2.6, player.z * 0.5);
}
