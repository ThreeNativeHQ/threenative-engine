import type { Camera, Color, Object3D, Vector3 } from "three";
import type { BacklightControls } from "./material.js";
function finiteColor(color: Color) {
  return (
    Number.isFinite(color.r) &&
    color.r >= 0 &&
    Number.isFinite(color.g) &&
    color.g >= 0 &&
    Number.isFinite(color.b) &&
    color.b >= 0
  );
}
export function validateControls(controls: BacklightControls) {
  if (
    !Number.isFinite(controls.rimGain) ||
    controls.rimGain < 0 ||
    !Number.isFinite(controls.key.intensity) ||
    controls.key.intensity < 0 ||
    !finiteColor(controls.key.color) ||
    !Number.isFinite(controls.fillGain) ||
    controls.fillGain < 0 ||
    !Number.isFinite(controls.fillAngularSize) ||
    controls.fillAngularSize <= 0 ||
    controls.fillAngularSize > 1.5 ||
    !Number.isFinite(controls.fillDirection.lengthSq()) ||
    controls.fillDirection.lengthSq() === 0 ||
    !finiteColor(controls.fillColor)
  )
    throw new Error(
      "Backlight controls require finite nonnegative gains, a direction and angular size in (0, 1.5].",
    );
}
export function resolveKey(
  controls: BacklightControls,
  direction: Vector3,
  target: Vector3,
  camera: Camera = controls.camera,
) {
  validateControls(controls);
  // Read the renderer/game-updated matrices, as upstream Three light uniforms do.
  // Targets outside the scene must be updated by their owner before rendering.
  // Never mutate shared light/ancestor matrices inside a material render callback.
  target.setFromMatrixPosition(controls.key.target.matrixWorld);
  direction.setFromMatrixPosition(controls.key.matrixWorld).sub(target);
  if (
    !Number.isFinite(direction.x) ||
    !Number.isFinite(direction.y) ||
    !Number.isFinite(direction.z)
  )
    throw new Error("Key endpoints must be finite.");
  const lengthSq = direction.lengthSq();
  if (!Number.isFinite(lengthSq)) throw new Error("Key direction magnitude must be finite.");
  if (lengthSq <= 1e-12) {
    direction.set(0, 1, 0);
    return 0;
  }
  direction.normalize();
  if (!controls.key.layers.test(camera.layers)) return 0;
  let current: Object3D | null = controls.key;
  while (current !== null) {
    if (!current.visible) return 0;
    if (current === controls.scene) return controls.key.intensity;
    current = current.parent;
  }
  return 0;
}
