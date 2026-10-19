// Generated for you. Framing is a game-owned decision.
import type { PerspectiveCamera } from "three";
import type { CameraView } from "../state.js";

export function setupCamera(camera: PerspectiveCamera): void {
  camera.fov = fieldOfView(camera.aspect);
  camera.near = 0.075;
  camera.far = 500;
  camera.updateProjectionMatrix();
}

/**
 * Vertical field of view for an aspect ratio. A portrait phone keeps the landscape view's
 * horizontal reach rather than its vertical angle, or the explorer fills the screen.
 */
export function fieldOfView(aspect: number): number {
  if (aspect >= 1) return 43;
  const horizontal = 2 * Math.atan(Math.tan((43 * Math.PI) / 360) * 1.25);
  const vertical = 2 * Math.atan(Math.tan(horizontal / 2) / aspect);
  return Math.min(70, (vertical * 180) / Math.PI);
}

/** Orbit distance and elevation (radians from straight down) for each view. */
const VIEWS: Record<CameraView, { readonly radius: number; readonly polar: number }> = {
  // Over the shoulder, high enough that the trail behind the explorer reads.
  follow: { polar: 1.1, radius: 11.6 },
  // Low and close on the last footprint: the tread, the rim and the compaction.
  surface: { polar: 1.22, radius: 3.1 },
  overhead: { polar: 0.23, radius: 19 },
};

/**
 * A damped orbit around a target. Drag and the zoom axis move the goal; the camera eases to it,
 * and never dips under the snow it is looking at.
 */
export class OrbitFollow {
  yaw = 0.68;
  #polar = VIEWS.follow.polar;
  #radius = VIEWS.follow.radius;
  #goalPolar = VIEWS.follow.polar;
  #goalRadius = VIEWS.follow.radius;
  readonly #target = { x: 0, y: 0.95, z: 0 };

  setView(view: CameraView): void {
    this.#goalRadius = VIEWS[view].radius;
    this.#goalPolar = VIEWS[view].polar;
  }

  /** Drag by pixels: sideways turns, vertical tilts. */
  drag(dx: number, dy: number): void {
    this.yaw -= dx * 0.005;
    this.#goalPolar = Math.max(0.12, Math.min(1.43, this.#goalPolar + dy * 0.004));
  }

  zoom(amount: number): void {
    this.#goalRadius = Math.max(1.65, Math.min(30, this.#goalRadius * Math.exp(-amount * 0.001)));
  }

  update(
    camera: PerspectiveCamera,
    goal: { readonly x: number; readonly y: number; readonly z: number },
    ground: (x: number, z: number) => number,
    dt: number,
  ): void {
    const ease = 1 - Math.exp(-dt * 4.5);
    const settle = 1 - Math.exp(-dt * 5);
    this.#target.x += (goal.x - this.#target.x) * ease;
    this.#target.y += (goal.y - this.#target.y) * ease;
    this.#target.z += (goal.z - this.#target.z) * ease;
    this.#radius += (this.#goalRadius - this.#radius) * settle;
    this.#polar += (this.#goalPolar - this.#polar) * settle;
    const sine = Math.sin(this.#polar);
    const x = this.#target.x + Math.sin(this.yaw) * sine * this.#radius;
    const z = this.#target.z + Math.cos(this.yaw) * sine * this.#radius;
    const y = this.#target.y + Math.cos(this.#polar) * this.#radius;
    const fov = fieldOfView(camera.aspect);
    if (Math.abs(fov - camera.fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.position.set(x, Math.max(y, ground(x, z) + 0.3), z);
    camera.lookAt(this.#target.x, this.#target.y, this.#target.z);
  }
}
