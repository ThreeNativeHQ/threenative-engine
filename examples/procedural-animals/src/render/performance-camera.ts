import { type Camera, OrthographicCamera } from "three";

/** Explicit game-owned benchmark framing, shared by crowd, high and animal-free arms. */
export const performanceProjection = {
  projection: "orthogonal",
  size: 24,
  near: 0.1,
  far: 100,
} as const;
export function performanceCamera(camera: Camera): void {
  if (!(camera instanceof OrthographicCamera)) throw new Error("TN_ANIMAL_PERFORMANCE_CAMERA");
  camera.position.set(0, 40, 3);
  camera.lookAt(0, 0, 1);
  camera.updateMatrixWorld(true);
}
