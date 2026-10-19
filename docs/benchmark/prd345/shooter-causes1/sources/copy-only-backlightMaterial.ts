// Generated for you. Ordinary Three.js; controls belong to your game.
import {
  type Camera,
  type Color,
  type DirectionalLight,
  Material,
  type MeshStandardMaterial,
  type Object3D,
  type Scene,
  Vector3,
} from "three";
import {
  cameraViewMatrix,
  clamp,
  dot,
  float,
  materialColor,
  materialEmissive,
  materialMetalness,
  materialRoughness,
  max,
  mix,
  normalView,
  positionViewDirection,
  pow,
  reflect,
  smoothstep,
  uniform,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

export interface IBacklightControls {
  readonly key: DirectionalLight;
  readonly scene: Scene;
  readonly camera: Camera;
  /** Mutable game-owned controls: zero disables the rim, independent of source reporting. */
  rimGain: number;
  fillGain: number;
  readonly fillColor: Color;
  readonly fillDirection: Vector3;
  /** Angular radius of the authored fill disc, in radians. */
  fillAngularSize: number;
  /** Caller admits fill only after a measured-dark or missing environment is qualified. */
  fillAdmitted: boolean;
}

function validateControls(controls: IBacklightControls) {
  if (
    !Number.isFinite(controls.rimGain) ||
    controls.rimGain < 0 ||
    !Number.isFinite(controls.key.intensity) ||
    controls.key.intensity < 0 ||
    !controls.key.color.toArray().every((value) => Number.isFinite(value) && value >= 0) ||
    !Number.isFinite(controls.fillGain) ||
    controls.fillGain < 0 ||
    !Number.isFinite(controls.fillAngularSize) ||
    controls.fillAngularSize <= 0 ||
    controls.fillAngularSize > 1.5 ||
    !Number.isFinite(controls.fillDirection.lengthSq()) ||
    controls.fillDirection.lengthSq() === 0 ||
    !controls.fillColor.toArray().every((value) => Number.isFinite(value) && value >= 0)
  )
    throw new Error(
      "Backlight controls require finite nonnegative gains, a direction and angular size in (0, 1.5].",
    );
}
function resolveKey(controls: IBacklightControls, direction: Vector3, target: Vector3) {
  validateControls(controls);
  // Read the renderer/game-updated matrices, as upstream Three light uniforms do.
  // Targets outside the scene must be updated by their owner before rendering.
  // Never mutate shared light/ancestor matrices inside a material render callback.
  target.setFromMatrixPosition(controls.key.target.matrixWorld);
  direction.setFromMatrixPosition(controls.key.matrixWorld).sub(target);
  if (!direction.toArray().every(Number.isFinite)) throw new Error("Key endpoints must be finite.");
  const lengthSq = direction.lengthSq();
  if (!Number.isFinite(lengthSq)) throw new Error("Key direction magnitude must be finite.");
  if (lengthSq <= 1e-12) {
    direction.set(0, 1, 0);
    return 0;
  }
  direction.normalize();
  if (!controls.key.layers.test(controls.camera.layers)) return 0;
  let current: Object3D | null = controls.key;
  while (current !== null) {
    if (!current.visible) return 0;
    if (current === controls.scene) return controls.key.intensity;
    current = current.parent;
  }
  return 0;
}

/**
 * Preserve the upstream standard PBR/normal/skinning paths and original material emissive.
 * This is an additive artistic convention, not a physical subsurface model or IBL replacement.
 * Cache at the caller to preserve shared source-material relationships; dispose only conversions
 * it owns, never maps/source materials borrowed from a loaded model.
 */
export function backlightMaterial(source: MeshStandardMaterial, controls: IBacklightControls) {
  if (
    ("isMeshPhysicalMaterial" in source && source.isMeshPhysicalMaterial === true) ||
    source.onBeforeCompile !== Material.prototype.onBeforeCompile
  )
    throw new Error(
      "Physical/custom standard materials require separate qualification; conversion refused.",
    );
  validateControls(controls);
  const material = new MeshStandardNodeMaterial().copy(source);
  return material;
}
