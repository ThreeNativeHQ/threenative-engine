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
import { resolveKey, validateControls } from "./backlightControls.js";

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

const graphs = new WeakMap<IBacklightControls, ReturnType<typeof createGraph>>();

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
  // NodeMaterial.copy skips Material.copy, and `alphaTest` lives in `_alphaTest`, which it never copies.
  material.alphaTest = source.alphaTest;
  let graph = graphs.get(controls);
  if (!graph) {
    graph = createGraph(controls);
    graphs.set(controls, graph);
  }
  material.emissiveNode = graph;
  return material;
}

function createGraph(controls: IBacklightControls) {
  const rimGain = uniform(controls.rimGain).onRenderUpdate(() => {
    validateControls(controls);
    return controls.rimGain;
  });
  const fillGain = uniform(0).onRenderUpdate(() => {
    validateControls(controls);
    return controls.fillAdmitted ? controls.fillGain : 0;
  });
  const fillColor = uniform(controls.fillColor).onRenderUpdate(() => {
    validateControls(controls);
    return controls.fillColor;
  });
  const fillDirection = uniform(controls.fillDirection).onRenderUpdate(() => {
    validateControls(controls);
    return controls.fillDirection;
  });
  const fillAngularSize = uniform(controls.fillAngularSize).onRenderUpdate(() => {
    validateControls(controls);
    return controls.fillAngularSize;
  });
  const keyColor = uniform(controls.key.color).onRenderUpdate(() => {
    validateControls(controls);
    return controls.key.color;
  });
  const keyDirectionValue = new Vector3(0, 1, 0);
  const keyTargetValue = new Vector3();
  const keyDirection = uniform(keyDirectionValue).onRenderUpdate((frame) => {
    resolveKey(controls, keyDirectionValue, keyTargetValue, frame.camera ?? controls.camera);
    return keyDirectionValue;
  });
  // Removal/visibility/intensity are live. A removed sun cannot leave an invented rim behind.
  const keyGain = uniform(0).onRenderUpdate((frame) =>
    resolveKey(controls, keyDirectionValue, keyTargetValue, frame.camera ?? controls.camera),
  );
  const N = normalView.normalize();
  const V = positionViewDirection.normalize();
  const L = cameraViewMatrix.transformDirection(keyDirection);
  const grazing = pow(float(1).sub(clamp(dot(N, V), 0, 1)), 3);
  const behind = max(dot(L, V).negate(), 0);
  // Suppress broad surfaces already facing the key; back-facing edges retain wrap.
  // Tint by base reflectance so dark surfaces do not inherit a white emissive wash.
  const surfaceBacklit = float(1).sub(smoothstep(-0.15, 0.15, dot(N, L)));
  const rim = keyColor
    .mul(keyGain)
    .mul(rimGain)
    .mul(grazing)
    .mul(behind)
    .mul(surfaceBacklit)
    .mul(clamp(materialColor, 0, 1));

  const F = cameraViewMatrix.transformDirection(fillDirection.normalize());
  const cosRadius = fillAngularSize.cos();
  // Broaden a rough surface's reflected disc with approximate solid-angle attenuation,
  // not a proven energy-conserving BRDF. A positive transition avoids equal smoothstep bounds.
  const spread = fillAngularSize.add(max(materialRoughness.mul(1.2), 0.005)).min(Math.PI / 2);
  const reflectedDisc = smoothstep(spread.cos(), cosRadius, dot(reflect(V.negate(), N), F));
  const energy = float(1)
    .sub(cosRadius)
    .div(max(float(1).sub(spread.cos()), 0.0001));
  const reflectance = mix(vec3(0.04), materialColor, materialMetalness);
  const specularFill = reflectance.mul(reflectedDisc).mul(energy);
  const diffuseFill = materialColor
    .mul(float(1).sub(materialMetalness))
    .mul(max(dot(N, F), 0))
    .mul(float(1).sub(cosRadius))
    .mul(2);
  const fill = diffuseFill.add(specularFill).mul(fillColor).mul(fillGain);
  return materialEmissive.add(rim).add(fill);
}
