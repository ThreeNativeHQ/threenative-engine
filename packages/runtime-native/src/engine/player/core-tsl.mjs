// TSL authoring calls the native lazy graph; no upstream shader implementation enters the player.
import { liveUniforms, withConstValues } from "../../../../three-native/src/tsl-uniforms.ts";
import { defineReflector } from "../../../../three-native/src/reflector.ts";
import { definePass, markNormalTarget } from "../../../../three-native/src/pass-node.ts";
import { Color, Object3D, PerspectiveCamera, Vector2, Vector3, Vector4 } from "./core-three.mjs";
import { defineTslExtras } from "../../../../three-native/src/tsl-extras.ts";

// r185's ConstNode.value on float(), vec3(), color() and the other constants (shared with the Wasm back end).
const constants = { ...globalThis.tsl };
withConstValues(constants, { Vector2, Vector3, Vector4, Color });

// three's `uniform.value = x` (shared with the Wasm back end): a number goes through at once; an
// edited Color or VectorN goes through `syncUniforms`, which the renderer calls before each frame.
const live = liveUniforms(globalThis.tsl.uniform, (node, lanes) => globalThis.tsl.setUniform(node, ...lanes));
export const uniform = live.uniform;
export const uniformArray = live.uniformArray;
export const syncUniforms = live.sync;

export const { float, int, uint, vec2, vec3, color } = constants;
export const vec4 = markNormalTarget(constants.vec4, globalThis.tsl.normalView);
export const {
  attribute, uv, texture, Fn, If, Loop,
  instancedArray, add, sub, mul, div, negate, lessThan, greaterThan, equal, abs, sin, cos,
  floor, fract, sqrt, exp, exp2, log2, normalize, length, min, max, pow, step, dot,
  distance, cross, mix, clamp, smoothstep, select, positionLocal, positionWorld,
  normalViewGeometry, instanceIndex, cameraViewMatrix, ivec2, nodeObject, reflect, textureLoad,
  mx_noise_float, mx_worley_noise_vec2, pmremTexture, texture3D,
  convertToTexture, screenUV, materialColor, materialEmissive, materialMetalness, materialRoughness,
  cameraPosition, cameraProjectionMatrix, cameraWorldMatrix, positionGeometry, normalWorld, varying,
  cameraNear, cameraFar, screenSize, depth, viewportSharedTexture, viewportDepthTexture, linearDepth, viewportLinearDepth,
} = globalThis.tsl;
export const {
  oneMinus, screenCoordinate, normalGeometry, tangentGeometry, positionViewDirection, dFdx, dFdy, lengthSq,
  normalLocal, tangentLocal, positionPrevious, storage,
  atan, mod, fwidth, saturation, mat2, hash, time, transformDirection, normalWorldGeometry,
  getViewPosition, frameGroup, renderGroup, objectGroup, transformNormalToView, property,
} = globalThis.tsl;

// three's pass(), mrt() and MRT slots over the player's one scene pass (shared with the Wasm back
// end); the player draws the scene and camera a pass is pointed at.
export const { pass, mrt, output, normalView, metalness, roughness } = definePass(globalThis.tsl, (scene, camera) => {
  globalThis.tn.scene = scene;
  globalThis.tn.camera = camera;
});

export const reflector = defineReflector(globalThis.tsl.reflector, { Object3D, PerspectiveCamera });

// saturate, densityFogFactor, fog, context and velocity: plain JS over the engine's TSL functions,
// shared with the Wasm back end.
export const { saturate, densityFogFactor, fog, context, velocity } = defineTslExtras({
  get cameraNear() { return globalThis.tsl.cameraNear; },
  get cameraFar() { return globalThis.tsl.cameraFar; },
  clamp: (...args) => globalThis.tsl.clamp(...args),
  float: (value) => globalThis.tsl.float(value),
  linearDepth: () => globalThis.tsl.linearDepth(),
});
