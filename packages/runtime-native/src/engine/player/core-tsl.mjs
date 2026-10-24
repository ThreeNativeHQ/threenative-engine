// TSL authoring calls the native lazy graph; no upstream shader implementation enters the player.
import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import { liveUniforms, withConstValues } from "../../../../three-native/src/tsl-uniforms.ts";
import { defineReflector } from "../../../../three-native/src/reflector.ts";
import { definePass, markNormalTarget } from "../../../../three-native/src/pass-node.ts";
import { BufferAttribute, Color, Object3D, PerspectiveCamera, Vector2, Vector3, Vector4 } from "./core-three.mjs";
import { defineStorage, defineStorageTextures } from "../../../../three-native/src/storage.ts";
import { defineStruct } from "../../../../three-native/src/tsl-struct.ts";
import { defineTslExtras } from "../../../../three-native/src/tsl-extras.ts";
import { withFnBuilder } from "../../../../three-native/src/fn-builder.ts";

// r185's ConstNode.value on float(), vec3(), color() and the other constants (shared with the Wasm back end).
const constants = { ...globalThis.tsl };
withConstValues(constants, { Vector2, Vector3, Vector4, Color });

// three's `uniform.value = x` (shared with the Wasm back end): a number goes through at once; an
// edited Color or VectorN goes through `syncUniforms`, which the renderer calls before each frame.
const live = liveUniforms(globalThis.tsl.uniform, (node, lanes) => globalThis.tsl.setUniform(node, ...lanes));
export const uniform = (value, type) => {
  if (typeof value !== "boolean") return live.uniform(value, type);
  if (type !== undefined && type !== "bool")
    throw new TypeError("TN_TSL_UNIFORM_VALUE: a boolean uniform requires bool type");
  // The ABI stores numeric lanes; compare the live float to produce a shader bool, as on Wasm.
  const scalar = live.uniform(Number(value));
  const boolean = scalar.notEqual(0);
  return Object.defineProperty(boolean, "value", {
    get: () => Boolean(scalar.value),
    set: (next) => {
      if (typeof next !== "boolean")
        throw new TypeError("TN_TSL_UNIFORM_VALUE: expected a boolean");
      scalar.value = Number(next);
    },
  });
};
export const uniformArray = live.uniformArray;
export const reference = live.reference;
export const syncUniforms = live.sync;

export const { float, int, uint, vec2, vec3, color } = constants;
export const vec4 = markNormalTarget(constants.vec4, globalThis.tsl.normalView);
export const Fn = withFnBuilder(globalThis.tsl.Fn);
export const {
  atomicAdd, atomicStore, atomicLoad, Break, Continue, Return, log, lightShadowMatrix, attribute, uv, renderOutput, If, Loop, luminance, viewZToOrthographicDepth, viewZToPerspectiveDepth, logarithmicDepthToViewZ, vertexIndex,
  add, sub, mul, div, negate, lessThan, greaterThan, equal, lessThanEqual, greaterThanEqual, and, or, not, all, any, abs, sin, cos,
  floor, fract, sqrt, exp, exp2, log2, normalize, length, min, max, pow, step, dot,
  distance, cross, mix, clamp, smoothstep, select, positionLocal, positionWorld, positionWorldDirection,
  normalViewGeometry, instanceIndex, cameraViewMatrix, modelWorldMatrix, ivec2, uvec2, nodeObject, reflect, textureLoad,
  mx_noise_float, mx_worley_noise_float, mx_worley_noise_vec2, pmremTexture, texture3D,
  convertToTexture, screenUV, materialColor, materialEmissive, materialMetalness, materialRoughness,
  cameraPosition, cameraProjectionMatrix, cameraWorldMatrix, positionGeometry, normalWorld, varying,
  cameraNear, cameraFar, screenSize, depth, viewportSharedTexture, viewportDepthTexture, linearDepth, viewportLinearDepth,
} = globalThis.tsl;
export const {
  oneMinus, screenCoordinate, normalGeometry, tangentGeometry, positionViewDirection, dFdx, dFdy, lengthSq,
  normalLocal, tangentLocal, positionPrevious,
  atan, mod, fwidth, saturation, mat2, hash, time, deltaTime, transformDirection, normalWorldGeometry,
  getViewPosition, frameGroup, renderGroup, objectGroup, transformNormalToView, property,
} = globalThis.tsl;

export const { storageTexture, textureStore } = defineStorageTextures(globalThis.tsl);

// three's storage buffers over engine BufferAttributes (shared with the Wasm back end): `storage`,
// `instancedArray` and `attributeArray` build the engine's storage node, whose kernels `renderer.compute` runs.
export const { storage, instancedArray, attributeArray, StorageBufferAttribute, StorageInstancedBufferAttribute } =
  defineStorage(globalThis.tsl, BufferAttribute);

// three's pass(), mrt() and MRT slots over the player's one scene pass (shared with the Wasm back
// end); the player draws the scene and camera a pass is pointed at.
// An offscreen `new PassNode(PassNode.COLOR, scene, camera)` owns a RenderTarget that the renderer draws before the
// frame (updateSecondaryPasses, called from core-webgpu.mjs); only pass() publishes the frame's scene and camera.
export const { pass, PassNode, updateSecondaryPasses, mrt, output, normalView, metalness, roughness, diffuseColor, emissive } = definePass(
  globalThis.tsl,
  (scene, camera) => {
    globalThis.tn.scene = scene;
    globalThis.tn.camera = camera;
  },
  { RenderTarget: globalThis.RenderTarget, surface: () => globalThis.tn.surfaceSize() },
);

export const reflector = defineReflector(globalThis.tsl.reflector, { Object3D, PerspectiveCamera });

// saturate, densityFogFactor, fog, context and velocity: plain JS over the engine's TSL functions,
// shared with the Wasm back end.
export const { saturate, densityFogFactor, fog, context, velocity } = defineTslExtras({
  get cameraNear() { return globalThis.tsl.cameraNear; },
  get cameraFar() { return globalThis.tsl.cameraFar; },
  clamp: (...args) => globalThis.tsl.clamp(...args),
  float: (value) => globalThis.tsl.float(value),
  linearDepth: () => globalThis.tsl.linearDepth(),
  vec4: (...args) => vec4(...args),
});

export const struct = defineStruct(globalThis.tsl.struct);

import { defineRtt } from "../../../../three-native/src/rtt.ts";
import { defineQuadMesh } from "../../../../three-native/src/quad-mesh.ts";
export const rtt = defineRtt(globalThis.tsl.rtt, { NodeMaterial: globalThis.NodeMaterial, RenderTarget: globalThis.RenderTarget, QuadMesh: defineQuadMesh(globalThis) });

import { defineWgslFn } from "../../../../three-native/src/wgsl-fn.ts";
export const wgslFn = defineWgslFn(globalThis.tsl.wgslFunction);

export function texture(value, ...args) {
  const node = globalThis.tsl.texture(value, ...args);
  let current = value;
  return Object.defineProperty(node, "value", {
    get: () => current,
    set: (next) => {
      if (next === current) return;
      node.textureValue(next);
      current = next;
    },
  });
}

export const {
  EPSILON, INFINITY, PI, PI2, TWO_PI, HALF_PI, radians,
  degrees, inverseSqrt, ceil, sinh, cosh, tan, tanh,
  asin, asinh, acos, acosh, atanh, sign, round,
  reciprocal, trunc, transpose, determinant, inverse, difference, pow2,
  pow3, pow4, transformNormalByViewMatrix, transformNormalByInverseViewMatrix, cbrt, refract, faceForward,
  rand, mixElement, smoothstepElement, stepElement, faceforward, inversesqrt, notEqual,
  xor, bitAnd, bitNot, bitOr, bitXor, shiftLeft, shiftRight,
  incrementBefore, decrementBefore, increment, decrement, mat3, mat4,
} = globalThis.tsl;

// Refused at use, as on Wasm: the engine draws a lamp's cube shadow taps (shadowFilterOptions) and the
// virtual shadow map (virtualShadowOptions) in C++, so the three-only bodies of core's soft-shadow.ts
// and VirtualShadowNode.setup name these and never call them here.
export const cubeTexture = unsupportedExport("cubeTexture");
export const Stack = unsupportedExport("Stack");
export const getShadowMaterial = unsupportedExport("getShadowMaterial");
export const shadow = unsupportedExport("shadow");
export const shadowPositionWorld = unsupportedExport("shadowPositionWorld");

// Refused at use, as on Wasm: core's WorldEnvironment imports textureSize for the
// resolutionSubrect && !ownedEngine geometric-normals branch, which the owned path never takes.
export const textureSize = unsupportedExport("textureSize");
