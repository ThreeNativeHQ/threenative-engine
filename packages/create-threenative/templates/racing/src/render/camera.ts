import { MathUtils, type PerspectiveCamera, Vector3 } from "three";

// Chase height and distance. At 5.8 up and 8.5 back the camera looked down on the roof, which is
// the one angle from which every car in the world reads as a rectangle; 3.0 and 6.6 put the eye
// near the rear wing where the wedge, the arches and the flank are all in view.
const EYE_UP = 3;
const EYE_BACK = 6.6;

/** How far ahead of the car the camera looks, in metres, plus its own speed. */
const LEAD_BASE = 1.5;
const LEAD_PER_MPS = 0.42;

/** The most the camera will bank, in radians. Past this a corner reads as a barrel roll. */
const MAX_BANK = 0.055;

export function setupCamera(camera: PerspectiveCamera): void {
  camera.fov = 56;
  camera.near = 0.1;
  camera.far = 340;
  camera.updateProjectionMatrix();
}

// Reused across frames — the starter camera shows the same pattern. This runs per frame for
// every racing game built from this template; three Vector clones a frame was pure garbage.
const behind = new Vector3();
const desired = new Vector3();
const look = new Vector3();
const velocity = new Vector3();

/**
 * The chase camera: it sits behind the car's **velocity**, not behind its nose, and it looks at
 * where the car is going.
 *
 * Both halves matter on a car that slides. Anchored to the nose, a car sideways in a corner puts
 * the camera broadside — the driver sees a wall of tarmac and no horizon. Anchored to the
 * velocity, the camera stays behind the direction of travel and the corner opens up ahead.
 */
export function chaseCamera(
  camera: PerspectiveCamera,
  target: Vector3,
  heading: Vector3,
  dt: number,
  carVelocity?: { readonly x: number; y: number; z: number },
): void {
  // The direction the car is travelling, flattened. Under half a metre per second there is no
  // direction to speak of and the nose is the best available answer.
  behind.copy(heading).setY(0);
  if (carVelocity !== undefined) {
    velocity.set(carVelocity.x, 0, carVelocity.z);
    if (velocity.lengthSq() > 0.25) behind.copy(velocity).normalize();
  }
  if (behind.lengthSq() < 0.0001) behind.set(1, 0, 0);
  behind.normalize();
  desired.copy(target).addScaledVector(behind, -EYE_BACK);
  desired.y += EYE_UP;
  if (dt >= 1) camera.position.copy(desired);
  else camera.position.lerp(desired, MathUtils.damp(0, 1, 5, dt));
  // Look ahead along the same travel direction, so a fast car sees the corner it is entering
  // rather than the road immediately under its own nose.
  const speed = Math.hypot(velocity.x, velocity.z);
  look.copy(target).addScaledVector(behind, LEAD_BASE + speed * LEAD_PER_MPS);
  look.y = target.y + 1.15;
  camera.lookAt(look);
}

/**
 * The camera's bank, from the car's **lateral load**.
 *
 * The old camera banked on world X: `clamp(-heading.x * 0.018, …)`, which is a function of which
 * way the circuit happens to point rather than of what the car is doing. On a square track the
 * car banks the same amount in every corner and the opposite amount on the straights, so the roll
 * read as a wobble. Lateral acceleration is what a driver's inner ear banks on, and the car
 * measures it, so the camera banks on that and is level on the straights.
 */
export function cameraBank(lateralLoad: number, reference: number): number {
  return MathUtils.clamp(lateralLoad / reference, -1, 1) * MAX_BANK;
}
