// TSL authoring calls the native lazy graph; no upstream shader implementation enters the player.
import { liveUniforms, withConstValues } from "../../../../three-native/src/tsl-uniforms.ts";
import { defineReflector } from "../../../../three-native/src/reflector.ts";
import { definePass, markNormalTarget } from "../../../../three-native/src/pass-node.ts";
import { Color, Object3D, PerspectiveCamera, Vector2, Vector3, Vector4 } from "./core-three.mjs";
import { defineStruct } from "../../../../three-native/src/tsl-struct.ts";
import { unsupportedExport } from "../../../../three-native/src/refused.ts";

// r185's ConstNode.value on float(), vec3(), color() and the other constants (shared with the Wasm back end).
const constants = { ...globalThis.tsl };
withConstValues(constants, { Vector2, Vector3, Vector4, Color });

// three's `uniform.value = x` (shared with the Wasm back end): a number goes through at once; an
// edited Color or VectorN goes through `syncUniforms`, which the renderer calls before each frame.
const live = liveUniforms(globalThis.tsl.uniform, (node, lanes) => globalThis.tsl.setUniform(node, ...lanes));
export const uniform = live.uniform;
export const uniformArray = live.uniformArray;
export const reference = live.reference;
export const syncUniforms = live.sync;

export const { float, int, uint, vec2, vec3, color } = constants;
export const vec4 = markNormalTarget(constants.vec4, globalThis.tsl.normalView);
export const {
  atomicAdd, atomicStore, lightShadowMatrix, attribute, uv, texture, renderOutput, Fn, If, Loop, luminance, viewZToOrthographicDepth, viewZToPerspectiveDepth, logarithmicDepthToViewZ, vertexIndex,
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

// r185's saturate(x) is clamp(x, 0, 1).
export const saturate = (value) => globalThis.tsl.clamp(value, 0, 1);

// r185's densityFogFactor (nodes/fog/Fog.js): 1 - exp(-density^2 * viewZ^2). The fragment's view-space
// depth is the one linearDepth() encodes, so -positionView.z = near + linearDepth() * (far - near).
export const densityFogFactor = (density) => {
  const { cameraNear, cameraFar, linearDepth, float } = globalThis.tsl;
  const viewZ = cameraNear.add(linearDepth().mul(cameraFar.sub(cameraNear)));
  const d = typeof density === "number" ? float(density) : density;
  return d.mul(d).mul(viewZ).mul(viewZ).negate().exp().oneMinus();
};

// r185's fog(color, factor) composes the finished fragment (`output.rgb`), which a native material
// graph cannot read. It returns the description `scene.fogNode` holds; the renderer reports once that
// the engine does not apply it (TN_NATIVE_FOG_NODE_IGNORED), and `scene.fog` still does.
export const fog = (color, factor) => Object.freeze({ isFogNode: true, color, factor });

// context() and velocity: the context that carries the previous-frame velocity, and that accessor. The
// native engine has neither (develop's temporal chain reaches them only through core's velocity
// provision, which the native renderer does not provide), so they refuse at use, by name.
export const context = unsupportedExport("context");
export const velocity = unsupportedExport("velocity");

export const struct = defineStruct(globalThis.tsl.struct);

import { defineRtt } from "../../../../three-native/src/rtt.ts";
export const rtt = defineRtt(globalThis.tsl.rtt);

import { defineWgslFn } from "../../../../three-native/src/wgsl-fn.ts";
export const wgslFn = defineWgslFn(globalThis.tsl.wgslFunction);
