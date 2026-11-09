import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import {
  Material,
  defineObjectSurface,
  defineReleaseNoops,
  defineTypeFlags,
} from "../../../../three-native/src/object-surface.ts";
import { definePropertyBinding } from "../../../../three-native/src/property-binding.ts";
import { defineGridHelper } from "../../../../three-native/src/grid-helper.ts";
import { AnimationUtils, defineCreateInterpolant } from "../../../../three-native/src/animation-utils.ts";
import { defineBox2 } from "../../../../three-native/src/box2.ts";
import { defineTypedBufferAttribute } from "../../../../three-native/src/buffer-attributes.ts";
import { defineEdgesGeometry } from "../../../../three-native/src/edges-geometry.ts";
import { defineLayeredTargets } from "../../../../three-native/src/render-target.ts";
// Identity-preserving imports over the V8 adapter, never upstream Three.js.
import { audio } from "./core-audio.mjs";
export const {
  ACESFilmicToneMapping,
  AddEquation,
  AdditiveBlending,
  AgXToneMapping,
  AmbientLight,
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  AttachedBindMode,
  BackSide,
  Bone,
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Camera,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ClampToEdgeWrapping,
  Color,
  ConeGeometry,
  ConstantAlphaFactor,
  ConstantColorFactor,
  CubeTexture,
  CustomBlending,
  CylinderGeometry,
  DataArrayTexture,
  DepthTexture,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
  DstAlphaFactor,
  DstColorFactor,
  DynamicDrawUsage,
  EquirectangularReflectionMapping,
  Euler,
  ExtrudeGeometry,
  Float32BufferAttribute,
  FloatType,
  Fog,
  FogExp2,
  FrontSide,
  Frustum,
  Group,
  HemisphereLight,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedMesh,
  LOD,
  LatheGeometry,
  Layers,
  Line,
  LineBasicMaterial,
  LineSegments,
  LinearFilter,
  LinearMipmapLinearFilter,
  LinearSRGBColorSpace,
  LoopOnce,
  LoopPingPong,
  LoopRepeat,
  Matrix3,
  Matrix4,
  MaxEquation,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  MinEquation,
  MultiplyBlending,
  NearestFilter,
  NeutralToneMapping,
  NoBlending,
  NoColorSpace,
  NoToneMapping,
  NormalBlending,
  NumberKeyframeTrack,
  Object3D,
  OctahedronGeometry,
  OneFactor,
  OneMinusConstantAlphaFactor,
  OneMinusConstantColorFactor,
  OneMinusDstAlphaFactor,
  OneMinusDstColorFactor,
  OneMinusSrcAlphaFactor,
  OneMinusSrcColorFactor,
  OrthographicCamera,
  PCFShadowMap,
  PCFSoftShadowMap,
  Path,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PointLight,
  Quaternion,
  QuaternionKeyframeTrack,
  RGBAFormat,
  Ray,
  Raycaster,
  RenderTarget,
  RepeatWrapping,
  ReverseSubtractEquation,
  RingGeometry,
  RoundedBoxGeometry,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  Skeleton,
  SkinnedMesh,
  Sphere,
  SphereGeometry,
  SpotLight,
  Sprite,
  SpriteMaterial,
  SrcAlphaFactor,
  SrcAlphaSaturateFactor,
  SrcColorFactor,
  StaticDrawUsage,
  SubtractEquation,
  SubtractiveBlending,
  TorusGeometry,
  TorusKnotGeometry,
  TubeGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  VectorKeyframeTrack,
  ZeroFactor,
} = globalThis;
// three's PropertyBinding statics and console function over the engine class (shared with Wasm).
export const { PropertyBinding, getConsoleFunction, setConsoleFunction } = definePropertyBinding(
  globalThis.PropertyBinding,
);
// Texture sources (typed array, canvas, ImageBitmap) the engine copies; see core-textures.mjs.
import { DataTexture, Texture } from "./core-textures.mjs";
export {
  CanvasTexture,
  DataTexture,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  ImageBitmapLoader,
  Texture,
  TextureLoader,
} from "./core-textures.mjs";

// The binding registry represents the stateless namespaces as native objects.
// With JS math (the player's default) the global is three's own namespace object; otherwise a bound class.
export const MathUtils = typeof globalThis.MathUtils === "function" ? new globalThis.MathUtils() : globalThis.MathUtils;
const skeletonUtils = new globalThis.SkeletonUtils();
export const clone = (root) => skeletonUtils.clone(root);


// three's BatchedMesh: an engine class (PRD-552), each geometry's instances drawn as one instanced mesh.
export const { BatchedMesh } = globalThis;
// three's InstancedBufferGeometry: an engine class, drawn instanceCount times.
export const { InstancedBufferGeometry } = globalThis;
// three's GridHelper: engine LineSegments with vertex colours (shared definer, ported from three).
export const GridHelper = defineGridHelper(globalThis);
// three's EdgesGeometry, Box2, typed BufferAttributes and AnimationUtils: JS ports over engine classes,
// shared with the Wasm entry (PRD-784 P5-9).
export const EdgesGeometry = defineEdgesGeometry(globalThis);
export const Box2 = defineBox2(globalThis);
export const Uint8BufferAttribute = defineTypedBufferAttribute(BufferAttribute, Uint8Array);
export const Uint16BufferAttribute = defineTypedBufferAttribute(BufferAttribute, Uint16Array);
export const Uint32BufferAttribute = defineTypedBufferAttribute(BufferAttribute, Uint32Array);
export { AnimationUtils };
// three's track.createInterpolant over the engine tracks (shared with the Wasm entry, PRD-854).
defineCreateInterpolant(globalThis);
// three's flags on the engine's layered texture, as the Wasm entry sets them (texture-sources.ts).
Object.assign(DataArrayTexture.prototype, { isArrayTexture: true, isDataArrayTexture: true });
// three exports the engine does not provide: refused at use, by name, as on Wasm (unsupportedExport).
export const LineLoop = unsupportedExport("LineLoop");
export const Points = unsupportedExport("Points");
export const WebGLRenderer = unsupportedExport("WebGLRenderer");
export const CompressedArrayTexture = unsupportedExport("CompressedArrayTexture");
export const InstancedInterleavedBuffer = unsupportedExport("InstancedInterleavedBuffer");
export const TextureUtils = unsupportedExport("TextureUtils");
// three's CubeRenderTarget, RenderTarget3D and CubeCamera (shared with the Wasm back end).
export const { CubeRenderTarget, RenderTarget3D, CubeCamera } = defineLayeredTargets(globalThis);
export const { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader } = audio;

// Native traversal and child enumeration are host callbacks, not a second JS scene graph.
const bags = new WeakMap();
// three's userData is the game's object, kept with the wrapper; a game may also replace it (`x.userData = {...}`).
const userData = {
  configurable: true,
  get() {
    if (!bags.has(this)) bags.set(this, {});
    return bags.get(this);
  },
  set(value) {
    bags.set(this, value);
  },
};
for (const name of [
  "Object3D",
  "Scene",
  "Mesh",
  "Group",
  "SkinnedMesh",
  "InstancedMesh",
  "Camera",
  "PerspectiveCamera",
  "OrthographicCamera",
  "DirectionalLight",
  "AmbientLight",
  "HemisphereLight",
  "PointLight",
  "SpotLight",
  "Bone",
  "LOD",
  "Sprite",
  "Line",
  "LineSegments",
]) {
  const prototype = globalThis[name].prototype;
  const parent = Object.getOwnPropertyDescriptor(prototype, "parent").get;
  Object.defineProperties(prototype, {
    parent: {
      get() {
        return parent.call(this) ?? null;
      },
    },
    userData,
  });
  // The engine's walk (`__walk`, shared with the Wasm back end): one call for the whole subtree.
  prototype.traverse = function (callback) {
    for (const object of this.__walk(false)) callback(object);
  };
  prototype.traverseVisible = function (callback) {
    for (const object of this.__walk(true)) callback(object);
  };
}
defineTypeFlags(globalThis);
defineReleaseNoops(globalThis);
// three gives Material, Texture and BufferGeometry a userData too: as on Wasm (browser-backend.ts), every engine
// class with a dispose method (prd493's terrain splat writes material.userData.TN_TERRAIN_SPLAT).
for (const name of Object.getOwnPropertyNames(globalThis)) {
  const prototype = typeof globalThis[name] === "function" ? globalThis[name].prototype : undefined;
  if (typeof prototype?.dispose === "function" && !Object.hasOwn(prototype, "userData"))
    Object.defineProperty(prototype, "userData", userData);
}
const geometries = [
  BoxGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  PlaneGeometry,
  RingGeometry,
  RoundedBoxGeometry,
  SphereGeometry,
  TorusGeometry,
  LatheGeometry,
  TubeGeometry,
  ShapeGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  CapsuleGeometry,
  DodecahedronGeometry,
  OctahedronGeometry,
  TorusKnotGeometry,
  InstancedBufferGeometry,
];
// Adapt wrapper inheritance only; native classes continue to own every scene operation.
for (const [base, names] of [
  [
    Object3D,
    [
      Scene,
      Mesh,
      Group,
      Camera,
      Bone,
      LOD,
      Sprite,
      AmbientLight,
      DirectionalLight,
      HemisphereLight,
      PointLight,
      SpotLight,
      Line,
    ],
  ],
  [Line, [LineSegments]],
  [Camera, [PerspectiveCamera, OrthographicCamera]],
  [Mesh, [SkinnedMesh, InstancedMesh]],
  [BufferGeometry, geometries],
  [BufferAttribute, [Float32BufferAttribute, InstancedBufferAttribute]],
  [Texture, [DepthTexture, DataTexture, DataArrayTexture, globalThis.CanvasTexture]],
  [Path, [Shape]],
]) {
  for (const derived of names) Object.setPrototypeOf(derived.prototype, base.prototype);
}
// The type flags three defines on its value classes (`isColor`, `isVector3`, ...).
for (const value of [
  Color,
  Vector2,
  Vector3,
  Vector4,
  Quaternion,
  Euler,
  Matrix3,
  Matrix4,
  Box3,
  Plane,
  Texture,
  DepthTexture,
  DataTexture,
  BufferGeometry,
  BufferAttribute,
  InstancedBufferAttribute,
])
  value.prototype[`is${value.name}`] = true;
CatmullRomCurve3.prototype.isCatmullRomCurve3 = true;
// attributes/groups, shape.holes and the abstract Material: shared with the Wasm back end.
defineObjectSurface({
  bufferGeometry: BufferGeometry,
  geometries,
  shape: Shape,
  materials: [
    LineBasicMaterial,
    MeshBasicMaterial,
    MeshLambertMaterial,
    MeshPhongMaterial,
    MeshPhysicalMaterial,
    MeshStandardMaterial,
    SpriteMaterial,
  ],
});
export { Material };

// three's blending constant "use the material's own blending" (constants.js). It is a value in three,
// not an engine class, so it has no catalog entry; `new BlendMode(MaterialBlending)` names it.
export const MaterialBlending = 6;

// three r185 constants that core's own modules compare against and the Wasm engine already exports
// with these catalog values. CustomToneMapping is the mode the tone-mapping library compiles
// (tone-mapping.ts); the depth and shadow-map values only label what the engine refuses or ignores.
export const LessEqualCompare = 515;
export const GreaterEqualCompare = 518;
export const CustomToneMapping = 5;
export const AlwaysDepth = 1;
export const VSMShadowMap = 3;
// three's interpolation and animation blend constants (constants.js); the engine's keyframe track and
// AnimationClip constructors accept exactly these values.
export const InterpolateDiscrete = 2300;
export const InterpolateLinear = 2301;
export const InterpolateSmooth = 2302;
export const NormalAnimationBlendMode = 2500;
export const AdditiveAnimationBlendMode = 2501;
