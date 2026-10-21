import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import {
  Material,
  defineObjectSurface,
  defineTypeFlags,
} from "../../../../three-native/src/object-surface.ts";
import { definePropertyBinding } from "../../../../three-native/src/property-binding.ts";
// Identity-preserving imports over the V8 adapter, never upstream Three.js.
import { audio } from "./core-audio.mjs";
export const {
  ACESFilmicToneMapping,
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
  CylinderGeometry,
  DepthTexture,
  DirectionalLight,
  DodecahedronGeometry,
  DoubleSide,
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
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshPhongMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NearestFilter,
  NeutralToneMapping,
  NoBlending,
  NoColorSpace,
  NoToneMapping,
  NormalBlending,
  NumberKeyframeTrack,
  Object3D,
  OctahedronGeometry,
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
  StaticDrawUsage,
  TorusGeometry,
  TorusKnotGeometry,
  TubeGeometry,
  UnsignedByteType,
  Vector2,
  Vector3,
  Vector4,
  VectorKeyframeTrack,
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
// three's BatchedMesh/InstancedMesh.dispose frees the instance textures; the engine frees its instance
// buffers with the object, so the call has nothing to release (core's projection mirror makes it).
for (const instanced of [BatchedMesh, InstancedMesh]) instanced.prototype.dispose ??= function dispose() {};
// three's InstancedBufferGeometry: an engine class, drawn instanceCount times.
export const { InstancedBufferGeometry } = globalThis;
// three exports the engine does not provide: refused at use, by name, as on Wasm (unsupportedExport).
export const LineLoop = unsupportedExport("LineLoop");
export const Points = unsupportedExport("Points");
export const WebGLRenderer = unsupportedExport("WebGLRenderer");
export const { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader } = audio;

// Native traversal and child enumeration are host callbacks, not a second JS scene graph.
const bags = new WeakMap();
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
    userData: {
      get() {
        if (!bags.has(this)) bags.set(this, {});
        return bags.get(this);
      },
    },
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
  [Texture, [DepthTexture, DataTexture, globalThis.CanvasTexture]],
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
