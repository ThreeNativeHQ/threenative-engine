// Integration of the game bundler, native import facade and real V8 player, with a scene MRT readback.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bundleNativeEngine } from "../../scripts/bundle-native-engine.mjs";
import { runComputeGame } from "./compute-harness.mjs";

const native = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const executable = process.argv[2];
assert(executable, "Usage: player-imports.mjs <tn-native-engine-player-v8>");
const work = await mkdtemp(resolve(native, "build/player-imports-"));
process.once("exit", () => rmSync(work, { recursive: true, force: true }));
const entry = resolve(work, "imports.ts");
const outfile = resolve(work, "imports.js");
const three = createRequire(resolve(native, "package.json"))("three");
const constants = ["ACESFilmicToneMapping", "AgXToneMapping", "NeutralToneMapping", "PCFSoftShadowMap",
  "NoColorSpace", "LinearSRGBColorSpace", "SRGBColorSpace", "RepeatWrapping", "ClampToEdgeWrapping",
  "NearestFilter", "LinearFilter", "LinearMipmapLinearFilter", "UnsignedByteType", "FloatType",
  "RGBAFormat", "EquirectangularReflectionMapping", "NoToneMapping", "LoopOnce", "LoopRepeat", "AttachedBindMode",
  "FrontSide", "BackSide", "DoubleSide", "StaticDrawUsage", "DynamicDrawUsage",
  "NoBlending", "NormalBlending", "AdditiveBlending", "PCFShadowMap",
  "LessEqualCompare", "GreaterEqualCompare", "CustomToneMapping", "AlwaysDepth", "VSMShadowMap"];
const names = ["PerspectiveCamera", "Camera", "Object3D", "Mesh", "PlaneGeometry", "MeshStandardMaterial",
  "SkinnedMesh", "CylinderGeometry", "BufferGeometry", "Float32BufferAttribute", "BufferAttribute",
  "CanvasTexture", "DataTexture", "Texture", "Color", "PropertyBinding", "getConsoleFunction", "setConsoleFunction", "MathUtils", "Scene", "Raycaster", "Vector3", "Euler", "LOD", "MeshBasicMaterial", "DirectionalLight", "OrthographicCamera", "LatheGeometry", "Vector2", "CatmullRomCurve3", "TubeGeometry", "AnimationClip",
  "QuaternionKeyframeTrack", "VectorKeyframeTrack", "NumberKeyframeTrack", "AudioListener", "PositionalAudio", "Audio", "Shape", "Path", "ShapeGeometry",
  "ExtrudeGeometry", "SpriteMaterial", "Line", "LineSegments", "LineBasicMaterial", ...constants];
const panel = (T) => {
  const shape = new T.Shape();
  shape.moveTo(-0.3, -0.2); shape.lineTo(0.25, -0.2); shape.quadraticCurveTo(0.3, -0.2, 0.3, -0.15);
  shape.lineTo(0.3, 0.2); shape.absarc(0.2, 0.2, 0.1, 0, Math.PI / 2, false); shape.lineTo(-0.3, 0.3);
  const gauge = new T.Path(); gauge.absarc(0, 0, 0.08, 0, Math.PI * 2, true);
  shape.holes.push(gauge);
  return [new T.ExtrudeGeometry(shape, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 8 }),
    new T.ExtrudeGeometry(shape, { depth: 0.1, steps: 2, bevelEnabled: false, curveSegments: 12 }),
    new T.ShapeGeometry(shape, 16), shape.holes.length];
};
const answers = (geometries) => JSON.stringify(geometries.slice(0, 3).map((g) => [g.getAttribute("position").array, g.getAttribute("uv").array,
  g.getAttribute("normal").array, g.groups].map((v) => Array.isArray(v) ? v : Array.from(v))).concat([geometries[3]]));
await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { ${names.join(", ")} } from "three";
const THREE = { ${names.join(", ")} };
import { MeshStandardNodeMaterial, MeshBasicNodeMaterial, Vector3, NodeUpdateType, WebGPURenderer, StorageBufferAttribute, BlendMode } from "three/webgpu";
import { screenCoordinate, positionGeometry, normalGeometry, tangentGeometry, positionViewDirection } from "three/tsl";
import { atan, mod, fwidth, saturation, mat2, hash, time } from "three/tsl";
import { AudioBus } from "@threenative/core";
import { clone } from "three/addons/utils/SkeletonUtils.js";
import { clone as cloneByExamplesPath } from "three/examples/jsm/utils/SkeletonUtils.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { DecalGeometry } from "three/addons/geometries/DecalGeometry.js";
import { Material } from "three";
import { vec3, float, clamp, texture, uv, Fn, color, nodeObject, ivec2, reflect, textureLoad, cameraViewMatrix, mx_noise_float, mx_worley_noise_float, mx_worley_noise_vec2, pmremTexture, reflector, screenUV, storage, instanceIndex, normalLocal } from "three/tsl";
function check(condition, name) { if (!condition) throw Error("IMPORT_CHECK: " + name); }
check(globalThis.__THREENATIVE_NATIVE__.platform.runtime === "native", "native platform marker");
const camera = new THREE.PerspectiveCamera();
check(camera instanceof THREE.Camera && camera instanceof THREE.Object3D, "camera inheritance");
const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
check(mesh instanceof THREE.Object3D && mesh.isMesh && mesh.isObject3D, "mesh identity");
const segments = new THREE.LineSegments();
check(segments instanceof THREE.Line && segments instanceof THREE.Object3D && segments.isLineSegments && segments.isLine, "line inheritance");
check(new THREE.SkinnedMesh() instanceof THREE.Mesh, "skinned inheritance");
check(new THREE.CylinderGeometry() instanceof THREE.BufferGeometry, "geometry inheritance");
const profile = [[0.055, 0], [0.098, 0], [0.103, 0.025], [0.091, 0.18]];
const lathe = new THREE.LatheGeometry(profile.map(([x, y]) => new THREE.Vector2(x, y)), 6);
check(lathe instanceof THREE.BufferGeometry && JSON.stringify(Array.from(lathe.getAttribute("position").array)) ===
  ${JSON.stringify(JSON.stringify(Array.from(new three.LatheGeometry([[0.055, 0], [0.098, 0], [0.103, 0.025], [0.091, 0.18]].map(([x, y]) => new three.Vector2(x, y)), 6).attributes.position.array)))}, "lathe geometry");
const grip = [[0, -0.11, 1.21], [0.02, -0.24, 1.26], [0.06, -0.35, 1.32], [0.085, -0.42, 1.37]];
const gripPoints = grip.map(([x, y, z]) => new THREE.Vector3(x, y, z));
const curve = new THREE.CatmullRomCurve3(gripPoints, false, "centripetal");
// With JS math the caller's Vector3s are three's own and the native curve copies them (the value, not the
// object, crosses), so the points are equal but not identical; with native math they were the same objects.
const samePoint = (a, b) => a === b || (a.x === b.x && a.y === b.y && a.z === b.z);
check(curve.isCatmullRomCurve3 && curve.points.length === gripPoints.length && samePoint(curve.points[0], gripPoints[0]),
  "curve keeps the caller's points");
const curveAnswers = [...curve.getPoints(4), curve.getTangent(0.25), curve.getPointAt(0.6), curve.getTangentAt(0.9)]
  .map((v) => v.toArray()).concat([curve.getLength()]);
check(JSON.stringify(curveAnswers) === ${JSON.stringify(JSON.stringify((() => {
  const c = new three.CatmullRomCurve3([[0, -0.11, 1.21], [0.02, -0.24, 1.26], [0.06, -0.35, 1.32], [0.085, -0.42, 1.37]].map(([x, y, z]) => new three.Vector3(x, y, z)), false, "centripetal");
  return [...c.getPoints(4), c.getTangent(0.25), c.getPointAt(0.6), c.getTangentAt(0.9)].map((v) => v.toArray()).concat([c.getLength()]);
})()))}, "CatmullRomCurve3 answers");
const tube = new THREE.TubeGeometry(curve, 12, 0.05, 10, false);
check(tube instanceof THREE.BufferGeometry && JSON.stringify(Array.from(tube.getAttribute("position").array)) ===
  ${JSON.stringify(JSON.stringify(Array.from(new three.TubeGeometry(new three.CatmullRomCurve3([[0, -0.11, 1.21], [0.02, -0.24, 1.26], [0.06, -0.35, 1.32], [0.085, -0.42, 1.37]].map(([x, y, z]) => new three.Vector3(x, y, z)), false, "centripetal"), 12, 0.05, 10, false).attributes.position.array)))}, "tube geometry");
const streamed = new THREE.Float32BufferAttribute([0, 1, 2], 3).setUsage(THREE.DynamicDrawUsage);
check(streamed.usage === THREE.DynamicDrawUsage, "attribute usage");
const sit = new THREE.AnimationClip("sit", 2, [new THREE.VectorKeyframeTrack("hip.position", [0, 2], [0, 0, 0, 1, 2, 3]),
  new THREE.QuaternionKeyframeTrack("arm.quaternion", [0, 2], [0, 0, 0, 1, 0, 0, 0, 1])]);
const gripTracks = sit.tracks.map((track) => track.name.endsWith(".quaternion")
  ? new THREE.QuaternionKeyframeTrack(track.name, [0, sit.duration], [0, 0.6, 0, 0.8, 0, 0.6, 0, 0.8]) : track.clone());
const gripClip = new THREE.AnimationClip("grip", sit.duration, gripTracks);
check(gripClip.duration === 2 && gripClip.tracks.length === 2 && gripClip.tracks[0].name === "hip.position" &&
  gripClip.tracks[1].ValueTypeName === "quaternion" && Array.from(gripClip.tracks[1].values).join() === Array.from(new Float32Array([0, 0.6, 0, 0.8, 0, 0.6, 0, 0.8])).join() &&
  gripClip.tracks[0] instanceof THREE.VectorKeyframeTrack, "authored clip from cloned and new tracks");
const glow = new THREE.MeshBasicMaterial(); glow.blending = THREE.AdditiveBlending;
check(glow.blending === THREE.AdditiveBlending, "additive blending");
const authored = new THREE.BufferGeometry();
authored.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
authored.setAttribute("instanceOffset", new THREE.Float32BufferAttribute([0, 0, 0], 3));
check(authored.attributes === authored.attributes && authored.attributes.position === authored.getAttribute("position") &&
  authored.attributes.position.count === 3 && "instanceOffset" in authored.attributes && !("normal" in authored.attributes) &&
  Object.keys(authored.attributes).sort().join() === "instanceOffset,position", "geometry.attributes");
authored.deleteAttribute("instanceOffset");
check(Object.keys(authored.attributes).join() === "position" && authored.attributes.instanceOffset === undefined, "attributes after delete");
check(Object.keys(new THREE.PlaneGeometry().attributes).join() === "position,normal,uv", "generator attributes");
const panel = (T) => {
  const shape = new T.Shape();
  shape.moveTo(-0.3, -0.2); shape.lineTo(0.25, -0.2); shape.quadraticCurveTo(0.3, -0.2, 0.3, -0.15);
  shape.lineTo(0.3, 0.2); shape.absarc(0.2, 0.2, 0.1, 0, Math.PI / 2, false); shape.lineTo(-0.3, 0.3);
  const gauge = new T.Path(); gauge.absarc(0, 0, 0.08, 0, Math.PI * 2, true);
  shape.holes.push(gauge);
  return [new T.ExtrudeGeometry(shape, { depth: 0.026, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 8 }),
    new T.ExtrudeGeometry(shape, { depth: 0.1, steps: 2, bevelEnabled: false, curveSegments: 12 }),
    new T.ShapeGeometry(shape, 16), shape.holes.length];
};
const answers = (geometries) => JSON.stringify(geometries.slice(0, 3).map((g) => [g.getAttribute("position").array, g.getAttribute("uv").array,
  g.getAttribute("normal").array, g.groups].map((v) => Array.isArray(v) ? v : Array.from(v))).concat([geometries[3]]));
const panels = panel(THREE);
check(panels[0] instanceof THREE.BufferGeometry && answers(panels) === ${JSON.stringify(answers(panel(three)))}, "Shape, holes and ExtrudeGeometry as three");
const refuses = (make, pattern) => { try { make(); return false; } catch (error) { return pattern.test(String(error.message)); } };
check(refuses(() => new THREE.ExtrudeGeometry(new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(1, 0), new THREE.Vector2(0, 1)]),
  { extrudePath: curve }), /extrudePath is not supported/), "extrudePath refused");
const paramTexture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
const painted = new THREE.MeshStandardMaterial({ color: 0x336699, emissive: "#ff8800", roughness: 0.4, metalness: 0.2,
  transparent: true, opacity: 0.5, map: paramTexture, side: THREE.DoubleSide, name: "panel", depthWrite: undefined });
check(JSON.stringify([painted.color.r, painted.color.g, painted.color.b, painted.emissive.r, painted.emissive.g, painted.emissive.b,
  painted.roughness, painted.metalness, painted.transparent, painted.opacity, painted.side, painted.name, painted.depthWrite]) ===
  ${JSON.stringify(JSON.stringify((() => { const m = new three.MeshStandardMaterial({ color: 0x336699, emissive: "#ff8800", roughness: 0.4, metalness: 0.2, transparent: true, opacity: 0.5, side: three.DoubleSide, name: "panel" }); return [m.color.r, m.color.g, m.color.b, m.emissive.r, m.emissive.g, m.emissive.b, m.roughness, m.metalness, m.transparent, m.opacity, m.side, m.name, m.depthWrite]; })()))} &&
  painted.map === paramTexture, "material parameters as three's setValues");
const bumped = new THREE.MeshStandardMaterial({ normalMap: paramTexture, normalScale: new THREE.Vector2(0.25, -0.5) });
check(bumped.normalMap === paramTexture && bumped.normalScale.x === 0.25 && bumped.normalScale.y === -0.5, "normalMap parameters");
bumped.normalScale.set(1, 2);
check(bumped.normalScale.y === 2, "normalScale is the material's own Vector2");
const orm = new THREE.MeshStandardMaterial({ roughnessMap: paramTexture, metalnessMap: paramTexture, aoMap: paramTexture,
  aoMapIntensity: 0.6, emissiveMap: paramTexture });
check(orm.roughnessMap === paramTexture && orm.metalnessMap === paramTexture && orm.aoMap === paramTexture &&
  orm.emissiveMap === paramTexture && orm.aoMapIntensity === 0.6, "packed ORM and emissive map parameters");
const twin = painted.clone();
check(twin instanceof THREE.MeshStandardMaterial && twin !== painted && twin.map === painted.map && twin.roughness === painted.roughness, "material clone");
// Midway's WaterEffects: base.index.clone() and attributes.position.clone() into a new geometry.
const cloneSource = new THREE.BufferAttribute(new Float32Array([1, 2, 3, 4]), 2).setUsage(THREE.DynamicDrawUsage);
const cloneCopy = cloneSource.clone();
check(cloneCopy instanceof THREE.BufferAttribute && cloneCopy !== cloneSource && cloneCopy.itemSize === 2 && cloneCopy.count === 2 &&
  cloneCopy.getX(1) === 3 && cloneCopy.usage === THREE.DynamicDrawUsage, "attribute clone");
cloneCopy.setX(0, 9);
check(cloneSource.getX(0) === 1, "attribute clone owns its array");
const plane = new THREE.PlaneGeometry(1, 1);
check(plane.index.clone().count === 6 && plane.attributes.position.clone().count === 4, "index and position clone");
// Midway's cloneModel: gltf.scene.clone(true) shares geometry and material; clone(false) is shallow.
const world = new THREE.Scene(), part = new THREE.Object3D();
part.position.set(1, 2, 3);
part.add(new THREE.Mesh(plane, painted));
world.add(part);
const twinWorld = world.clone(true);
check(twinWorld instanceof THREE.Scene && twinWorld !== world && twinWorld.children.length === 1 &&
  twinWorld.children[0] !== part && twinWorld.children[0].position.y === 2 &&
  twinWorld.children[0].children[0].geometry === plane && twinWorld.children[0].children[0].material === painted, "Object3D clone");
check(part.clone(false).children.length === 0 && part.clone().children.length === 1, "clone recursion");
twin.roughness = 0.95;
check(painted.roughness !== 0.95, "a clone is independent");
const sprite = new THREE.SpriteMaterial({ transparent: false });
check(sprite.transparent === false, "SpriteMaterial parameters after its defaults");
check(refuses(() => new THREE.MeshBasicMaterial({ wireframe: true }), /TN_NATIVE_MATERIAL_PARAMETER: MeshBasicMaterial\.wireframe/), "unbound material parameter refused");
const shadowRenderer = new WebGPURenderer({ canvas: { width: 1, height: 1 } });
check(shadowRenderer.shadowMap.enabled === false && shadowRenderer.shadowMap.type === THREE.PCFShadowMap, "three's shadowMap defaults");
check(refuses(() => { shadowRenderer.shadowMap.type = 3; }, /TN_NATIVE_SHADOWMAP_TYPE_UNSUPPORTED/), "VSMShadowMap refused");
shadowRenderer.shadowMap.enabled = true;
shadowRenderer.shadowMap.type = THREE.PCFSoftShadowMap;
check(shadowRenderer.shadowMap.enabled && shadowRenderer.shadowMap.type === THREE.PCFSoftShadowMap, "shadowMap settings");
// The settings reach the player with the renderer's others when it draws (tn.setRendererState).
shadowRenderer.render(new THREE.Scene(), new THREE.PerspectiveCamera());
check(shadowRenderer.getMaxAnisotropy() === 16, "WebGPU's maximum anisotropy");
for (const texture of [new THREE.Texture(), new THREE.DataTexture(new Uint8Array([1, 2, 3, 255]), 1, 1), new THREE.CanvasTexture({
  width: 1, height: 1, getContext: () => ({ getImageData: () => ({ data: new Uint8Array([1, 2, 3, 255]) }) }),
})]) {
  texture.name = "shared-image"; texture.repeat.set(2, 3); texture.offset.set(0.1, 0.2);
  texture.center.set(0.3, 0.4); texture.rotation = 0.5; texture.wrapT = THREE.RepeatWrapping;
  const clone = texture.clone();
  check(clone !== texture && clone instanceof texture.constructor && clone.source === texture.source,
    "texture clone preserves its class and shares its source");
  check(clone.name === texture.name && clone.repeat.x === 2 && clone.offset.y === 0.2 &&
    clone.center.x === 0.3 && clone.rotation === 0.5 && clone.wrapT === texture.wrapT &&
    clone.minFilter === texture.minFilter && clone.flipY === texture.flipY && clone.type === texture.type,
    "texture clone copies sampler and transform fields");
  if (texture.image?.data) check(clone.image === texture.image, "texture clone shares its JS image");
  clone.repeat.set(7, 8); clone.offset.set(0.7, 0.8); clone.center.set(0, 0); clone.wrapS = THREE.RepeatWrapping;
  check(texture.repeat.x === 2 && texture.offset.y === 0.2 && texture.center.x === 0.3 &&
    texture.wrapS === THREE.ClampToEdgeWrapping, "texture clone edits are independent");
}
paramTexture.anisotropy = 8;
check(paramTexture.anisotropy === 8 && refuses(() => { paramTexture.anisotropy = 0; }, /anisotropy must be/), "texture anisotropy");
const sided = new THREE.MeshBasicMaterial(); sided.side = THREE.DoubleSide;
check(new THREE.Mesh(lathe, sided).material.side === THREE.DoubleSide, "double-sided material");
check(new THREE.Float32BufferAttribute([0.1, 0.2], 2) instanceof THREE.BufferAttribute, "attribute inheritance");
check(new THREE.DataTexture(new Uint8Array([255, 0, 0, 255]), 1, 1) instanceof THREE.Texture, "texture inheritance");
check(Vector3 === THREE.Vector3, "cross-entry identity");
check(Math.abs(THREE.MathUtils.euclideanModulo(-1, 3) - 2) < 1e-6, "MathUtils namespace");
check(Math.abs(THREE.MathUtils.damp(0, 1, 1, 1) - (1 - Math.exp(-1))) < 1e-9 && THREE.MathUtils.pingpong(3, 2) === 1, "MathUtils number-only functions (damp, pingpong)");
check(new BlendMode().blendSrc === 204 && new BlendMode(2).clone().blending === 2, "three/webgpu BlendMode");
const scene = new THREE.Scene(); scene.add(mesh); scene.updateMatrixWorld(true);
check(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(scene.uuid) && scene.uuid !== mesh.uuid, "native object UUID");
check(scene.children[0] === mesh && mesh.parent === scene, "native child identity");
let visited = 0; scene.traverse(object => { check(object instanceof THREE.Object3D, "traversed identity"); visited++; });
check(visited === 2, "native traversal");
const binding = new THREE.PropertyBinding(scene, '.position'); binding.bind();
check(binding.targetObject === scene && THREE.PropertyBinding.findNode(scene, undefined) === scene, "native PropertyBinding");
{
  // three's PropertyBinding surface over the engine (three-native/src/property-binding.ts): the statics,
  // targetObject as a property, and a failed bind reported through setConsoleFunction's function.
  const rig = new THREE.Object3D(); const hip = new THREE.Object3D(); hip.name = "hip"; rig.add(hip);
  check(THREE.PropertyBinding.parseTrackName("hip.position[x]").propertyIndex === "x", "track parsing");
  check(THREE.PropertyBinding.findNode(rig, "hip") === hip, "node search");
  const previous = THREE.getConsoleFunction(); const messages = [];
  THREE.setConsoleFunction((type, message) => messages.push([type, message]));
  const track = new THREE.PropertyBinding(rig, "hip.position"); track.bind();
  check(track.targetObject === hip && messages.length === 0, "track target");
  track.unbind(); hip.name = "renamed"; track.bind();
  check(track.targetObject === null && messages.length === 1 && messages[0][0] === "error" &&
    messages[0][1].includes("No target node found"), "rebind diagnostic through the console function");
  THREE.setConsoleFunction(previous);
  check(THREE.getConsoleFunction() === previous, "console hook restoration");
}
const copied = clone(mesh);
check(copied instanceof THREE.Mesh && copied.geometry === mesh.geometry && copied.material === mesh.material, "clone native resources");
const ray = new THREE.Raycaster(new THREE.Vector3(0.2, -0.3, 5), new THREE.Vector3(0, 0, -1));
check(ray.intersectObject(mesh).length > 0, "native picking");
const lod = new THREE.LOD(); lod.addLevel(mesh, 0); check(lod.levels[0].object === mesh, "native LOD");
const material = new MeshStandardNodeMaterial();
check(material instanceof THREE.MeshStandardMaterial && material.isNodeMaterial, "node material inheritance");
material.colorNode = vec3(1, 0.5, 0).normalize().mul(0.5).clamp(0, 1).rgb;
const basic = new MeshBasicNodeMaterial();
check(basic instanceof THREE.MeshBasicMaterial, "basic node material inheritance");
const source = new THREE.Texture(); source.name = "testTexture";
basic.colorNode = texture(source, uv()).rgb;
check(nodeObject(basic.colorNode) === basic.colorNode, "nodeObject identity");
basic.colorNode = color("#808080");
basic.colorNode = color(new THREE.Color(0.1, 0.2, 0.3));
basic.colorNode = color(0.1, 0.2, 0.3);
basic.colorNode = reflect(vec3(1, -1, 0), vec3(0, 1, 0));
basic.colorNode = textureLoad(source, ivec2(0, 0)).rgb;
basic.colorNode = vec3(mx_noise_float(uv().mul(4), 0.5, 0.5).add(mx_worley_noise_float()), mx_worley_noise_vec2(uv().mul(3), 0.9).x, 0);
const sky = new THREE.DataTexture(new Uint8Array(64 * 32 * 4), 64, 32);
sky.mapping = THREE.EquirectangularReflectionMapping;
basic.colorNode = pmremTexture(sky, vec3(0, 1, 0), float(0.5));
// reflector(): WaterSurface3D's layered mirror. A wrapper over getVirtualCamera runs once, against
// the one engine virtual camera; updateBefore is refused by name, since nothing would call it.
const mirror = reflector({ resolutionScale: 0.5, bounces: false });
mirror.target.rotateX(-Math.PI / 2);
check(mirror.target instanceof THREE.Object3D, "reflector target");
const reflection = mirror._reflectorBaseNode;
const mint = reflection.getVirtualCamera.bind(reflection);
reflection.getVirtualCamera = (viewer) => { const virtual = mint(viewer); virtual.layers.mask = 2; return virtual; };
check(reflection.getVirtualCamera(camera).layers.mask === 2, "reflector virtual camera layers");
let hook = "";
try { reflection.updateBefore.bind(reflection); } catch (error) { hook = String(error); }
check(hook.includes("TN_NATIVE_REFLECTOR_UPDATE_HOOK"), "reflector refuses updateBefore: " + hook);
basic.colorNode = mirror.sample(screenUV.flipX()).rgb.add(mirror.rgb);
check(cameraViewMatrix !== undefined, "camera view uniform");
check(NodeUpdateType.FRAME === "frame" && NodeUpdateType.RENDER === "render", "NodeUpdateType");
basic.colorNode = vec3(screenCoordinate.mul(0.001), positionViewDirection.z);
check([atan(1), mod(1, 2), fwidth(1), saturation(vec3(1, 0, 0)), hash(1), time].every((node) => node && typeof node.mul === "function") && typeof mat2 === "function", "TSL atan, mod, fwidth, saturation, mat2, hash and time");
basic.positionNode = positionGeometry.add(normalGeometry.mul(tangentGeometry.w.mul(0)));
check(basic.colorNode !== null && basic.positionNode !== null, "screen coordinate, geometry attributes, view direction");
const hex = new THREE.Color(0xff0000);
check(hex.isColor && hex.r === 1 && hex.g === 0 && hex.b === 0, "Color(hex)");
check(new THREE.Color("#00ff00").g === 1 && new THREE.Color(hex).r === 1, "Color(style), Color(color)");
check(hex.set(0x0000ff).b === 1 && hex.set("red").r === 1 && hex.set(0.5, 0.25, 0).g === 0.25, "Color.set");
const parameters = new THREE.MeshStandardMaterial({ color: 0x00ff00, roughness: 0.25, transparent: true, map: null });
check(parameters.color.r === 0 && parameters.color.g === 1 && parameters.roughness === 0.25 && parameters.transparent, "material parameters");
let unboundParameter = false;
try { new THREE.MeshBasicMaterial({ notAMaterialProperty: 1 }); }
catch (error) { unboundParameter = /TN_NATIVE_MATERIAL_PARAMETER: MeshBasicMaterial\.notAMaterialProperty/.test(error.message); }
check(unboundParameter, "an unbound material parameter refuses by name");
class Tinted extends THREE.MeshStandardMaterial {}
const tinted = new Tinted({ roughness: 0.25, color: 0xff0000 });
check(tinted instanceof THREE.MeshStandardMaterial && tinted.roughness === 0.25 && tinted.color.r === 1, "a material subclass takes parameters");
const sun = new THREE.DirectionalLight();
sun.shadow.mapSize.set(1024, 2048); sun.shadow.camera.near = 2; sun.shadow.bias = -0.5; sun.shadow.radius = 3;
check(sun.shadow === sun.shadow && sun.shadow.mapSize.y === 2048 && sun.shadow.camera.near === 2 &&
  sun.shadow.camera instanceof THREE.OrthographicCamera && sun.shadow.bias === -0.5 && sun.shadow.radius === 3, "light shadow");
const rounded = new RoundedBoxGeometry(2, 1, 1, 2, 0.1);
check(rounded instanceof THREE.BufferGeometry && rounded.index === null && rounded.type === "RoundedBoxGeometry", "RoundedBoxGeometry");
check(new THREE.Vector3().fromBufferAttribute(rounded.getAttribute("position"), 0).length() > 0.5, "fromBufferAttribute");
const grid = new THREE.DataTexture(new Uint8Array([1, 2, 3, 4]), 1, 1);
const version = grid.source.version;
grid.generateMipmaps = true; grid.anisotropy = 16; grid.needsUpdate = true;
check(grid.generateMipmaps && grid.anisotropy === 16 && grid.source === grid.source && grid.source.version === grid.version && grid.version > version, "texture sampling fields and source");
const lit = new THREE.MeshStandardMaterial({ normalMap: grid, normalScale: new THREE.Vector2(0.5, 0.25) });
check(lit.normalMap === grid && lit.normalScale.y === 0.25 && lit.normalScale === lit.normalScale, "normalMap and normalScale");
const before = grid.version; grid.needsUpdate = true;
check(grid.version === before + 1 && !Object.hasOwn(grid, "needsUpdate"), "needsUpdate reaches the engine");
grid.dispose();
check(grid.version === before + 2, "Texture.dispose frees the GPU copy and the texture uploads again");
// three's material array: one material per geometry group, kept as an array until a single one replaces it.
const flat = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
const slotted = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), [lit, flat]);
check(Array.isArray(slotted.material) && slotted.material.length === 2 && slotted.material[1].color.g === 1, "a Mesh takes a material array");
slotted.material = flat;
check(slotted.material === flat || (!Array.isArray(slotted.material) && slotted.material.color.g === 1), "a single material replaces the array");
slotted.material = [flat, lit];
check(Array.isArray(slotted.material) && slotted.material[0].color.g === 1, "an array replaces a single material");
check(Array.isArray(slotted.clone().material) && slotted.clone().material.length === 2, "clone keeps the material array");
check(cloneByExamplesPath === clone, "SkeletonUtils answers under three/examples/jsm as under three/addons");
// three's DecalGeometry: the faces of a mesh clipped to the projector's box, uvs across it.
const wall = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), lit);
wall.updateMatrixWorld(true);
const decal = new DecalGeometry(wall, new THREE.Vector3(0.25, 0, 0), new Euler(), new THREE.Vector3(1, 1, 1));
const decalPosition = decal.getAttribute("position");
const decalUv = decal.getAttribute("uv");
let decalInside = decalPosition.count >= 3 && decalPosition.count % 3 === 0 && decalUv.count === decalPosition.count;
for (let i = 0; i < decalPosition.count; i += 1) {
  decalInside &&= decalPosition.getX(i) >= -0.25 - 1e-6 && decalPosition.getX(i) <= 0.75 + 1e-6 && Math.abs(decalPosition.getY(i)) <= 0.5 + 1e-6;
  decalInside &&= decalUv.getX(i) >= -1e-6 && decalUv.getX(i) <= 1 + 1e-6;
}
check(decalInside && decal instanceof THREE.BufferGeometry && decal.getAttribute("normal").count === decalPosition.count, "DecalGeometry clips a mesh to the projector box");
check(lit instanceof Material && lit.onBeforeCompile === Material.prototype.onBeforeCompile && lit.isMaterial, "Material base");
const vertex = new THREE.Vector3();
check(new THREE.Mesh(rounded, lit).getVertexPosition(0, vertex) === vertex && vertex.equals(new THREE.Vector3().fromBufferAttribute(rounded.getAttribute("position"), 0)), "getVertexPosition");
const graph = Fn(() => float(0.5).pow(2).min(1).max(0).smoothstep(0, 1).mix(1, 0.5))();
basic.opacityNode = clamp(graph, 0, 1);
// Midway's ocean and whitewater: += on a variable, screen derivatives, sign and cbrt.
const summed = Fn(() => {
  const height = float(0).toVar();
  height.addAssign(float(0.25));
  height.subAssign(0.05);
  height.mulAssign(2);
  height.divAssign(float(4));
  return height.add(uv().x.dFdx().abs()).add(uv().y.dFdy().sign()).add(float(-8).cbrt());
})();
check(summed && typeof summed.addAssign === "function" && typeof summed.cbrt === "function", "assign forms, dFdx, sign, cbrt");
// The starter's temporal resolve: Fn with array parameters, built per call, and setLayout chaining; an object argument names its parameters.
const blend = Fn(([colour, weight]) => { const w = weight.toVar(); w.mulAssign(0.5); return colour.mul(w); }).setLayout({ name: "blend", type: "vec3", inputs: [] });
const blended = blend(vec3(1, 2, 3), 2);
check(blended && typeof blended.mul === "function" && blend(vec3(1), float(1)) !== blended, "Fn with array parameters");
check(typeof Fn(({ x }) => x.add(1))({ x: float(1) }).add === "function", "Fn with named parameters");
// Every swizzle three answers, as Midway's ocean reads positionWorld.xz.
const lanes = vec3(1, 2, 3);
check(lanes.xz && lanes.zxy && lanes.st && lanes.bgr && lanes.xxxx && lanes.xyzwx === undefined, "swizzles");
// core's projection-skinned: a bone palette read with storage(); a write to normalLocal is refused by name.
const bones = new StorageBufferAttribute(8, 16);
check(bones instanceof THREE.BufferAttribute && bones.isStorageBufferAttribute && bones.count === 8, "StorageBufferAttribute");
const bone = storage(bones, "mat4", 8).toReadOnly().element(instanceIndex);
check(bone && typeof bone.mul === "function", "storage element");
let refusedWrite = false;
try { Fn(() => { normalLocal.assign(vec3(0, 1, 0)); })(); } catch (error) { refusedWrite = /normalLocal/.test(error.message); }
check(refusedWrite, "normalLocal write refused by name");
basic.alphaTestNode = summed.clamp();
basic.alphaTestNode = clamp(summed, 0.1);
for (const [name, expected] of Object.entries(${JSON.stringify(Object.fromEntries(constants.map((name) => [name, three[name]])))}))
  check(THREE[name] === expected, name + " differs from pinned Three.js");
// three's audio classes are engine objects over the player's WebAudio, and the native tick pushes
// world poses to it: the listener on the camera, a voice on a moving mesh.
const context = new THREE.AudioListener().context;
const heard = [];
const createPanner = context.createPanner.bind(context);
let panners = 0;
context.createPanner = () => {
  const panner = createPanner();
  const setPosition = panner.setPosition.bind(panner);
  const who = "voice" + panners++;
  panner.setPosition = (x, y, z) => { heard.push([who, x, y, z]); setPosition(x, y, z); };
  return panner;
};
const setListener = context.listener.setPosition.bind(context.listener);
context.listener.setPosition = (x, y, z) => { heard.push(["listener", x, y, z]); setListener(x, y, z); };
const pose = (who) => heard.filter((entry) => entry[0] === who).at(-1)?.slice(1).map((v) => Math.round(v * 1000) / 1000).join(",");
camera.position.set(0, 1, 5); scene.add(camera);
const bus = new AudioBus({ camera, maxVoices: 4, gestureTarget: null });
check(bus.listener instanceof THREE.AudioListener && bus.listener instanceof THREE.Object3D, "listener identity");
check(camera.children.includes(bus.listener) && bus.listener.parent === camera, "listener on the camera");
const buffer = context.createBuffer(1, 4410, 44100);
bus.unlock().then(() => {
  const fixed = bus.playAt(buffer, new THREE.Vector3(3, 0, -2));
  check(fixed instanceof THREE.PositionalAudio && fixed.isPlaying, "fixed positional voice");
  const welded = bus.playAt(buffer, mesh);
  check(welded.parent === mesh && mesh.children.includes(welded), "voice welded to the mesh");
  check(bus.play(buffer) instanceof THREE.Audio, "flat voice");
  mesh.position.set(-4, 0, 1);
  globalThis.tn.__update(1 / 60);
  check(pose("voice0") === "3,0,-2", "fixed voice position " + pose("voice0"));
  check(pose("voice1") === "-4,0,1", "voice follows its mesh on the tick " + pose("voice1"));
  check(pose("listener") === "0,1,5", "listener follows the camera on the tick " + pose("listener"));
  globalThis.tn.scene = scene; globalThis.tn.camera = camera; globalThis.tn.onUpdate(() => {});
}).catch((error) => { globalThis.tn.__startupError = String(error.stack ?? error); });
`);
await bundleNativeEngine({ entry, outfile, boot: false });
// The dummy driver keeps the check hermetic: the context runs with no sound card.
const run = spawnSync(resolve(executable), ["--check-game", outfile], {
  encoding: "utf8", env: { ...process.env, SDL_AUDIO_DRIVER: "dummy" } });
assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
assert.match(run.stdout, /engine=native gameRuntime=v8 startup=passed shadowMap=on:2/);
// BufferGeometryUtils.mergeGeometries over engine geometries equals three's over its own: indexed
// parts with groups and morph targets, the arrays' types included; then core's mergeParts on it.
{
  const fromNative = createRequire(resolve(native, "package.json"));
  const T = await import(pathToFileURL(fromNative.resolve("three/webgpu")).href);
  const { mergeGeometries } = await import(pathToFileURL(fromNative.resolve("three/addons/utils/BufferGeometryUtils.js")).href);
  const parts = (K) => {
    const box = new K.BoxGeometry(1, 2, 3);
    const sphere = new K.SphereGeometry(1, 5, 4);
    for (const g of [box, sphere]) {
      const p = g.getAttribute("position");
      g.morphAttributes.position = [new K.Float32BufferAttribute(new Float32Array(p.count * 3).map((_, i) => i / 9), 3)];
    }
    return [box, sphere];
  };
  const dump = (g) => JSON.stringify([g.index.array.constructor.name, ...["position", "normal", "uv"].map((n) =>
    [g.getAttribute(n).array.constructor.name, Array.from(g.getAttribute(n).array)]), Array.from(g.index.array),
    g.morphAttributes.position.map((a) => Array.from(a.array)), g.groups]);
  const expected = dump(mergeGeometries(parts(T), true));
  await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { BoxGeometry, SphereGeometry, Float32BufferAttribute, Scene, PerspectiveCamera, Color } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { mergeParts } from "@threenative/core";
function check(value, name) { if (!value) throw Error("MERGE_CHECK: " + name); }
const parts = ${parts.toString()};
const merged = mergeGeometries(parts({ BoxGeometry, SphereGeometry, Float32BufferAttribute }), true);
check((${dump.toString()})(merged) === ${JSON.stringify(expected)}, "mergeGeometries equals three's");
const baked = mergeParts([{ geometry: new BoxGeometry(), color: new Color(1, 0, 0) },
  { geometry: new SphereGeometry(1, 5, 4), color: new Color(0, 0, 1), position: [2, 0, 0] }], { label: "probe" });
check(baked.getAttribute("color").count === baked.getAttribute("position").count, "mergeParts paints every vertex");
globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); globalThis.tn.onUpdate(() => {});
`);
  await bundleNativeEngine({ entry, outfile, boot: false });
  const merged = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8" });
  assert.equal(merged.status, 0, `${merged.stdout}\n${merged.stderr}`);
}
// BufferGeometry.setFromPoints, Curve.computeFrenetFrames and InstancedMesh.computeBoundingSphere equal three's: Vector3 and Vector2 points fill a new `position`
// (z reads 0), and a shorter list overwrites the front of an attribute already there.
{
  const fromNative = createRequire(resolve(native, "package.json"));
  const T = await import(pathToFileURL(fromNative.resolve("three/webgpu")).href);
  const probe = (K) => {
    const out = [];
    const line = new K.BufferGeometry().setFromPoints([new K.Vector3(1, 2, 3), new K.Vector3(-4, 5, 6.5)]);
    out.push(Array.from(line.getAttribute("position").array));
    out.push(Array.from(new K.BufferGeometry().setFromPoints([new K.Vector2(7, 8)]).getAttribute("position").array));
    const filled = new K.BoxGeometry(1, 1, 1);
    const before = filled.getAttribute("position").count;
    filled.setFromPoints([new K.Vector3(9, 9, 9)]);
    const position = filled.getAttribute("position");
    out.push([position.count === before, position.getX(0), position.getY(0), position.getZ(0)]);
    // Curve.computeFrenetFrames, as the shooter's palm trunk sweeps its rings.
    const spine = new K.CatmullRomCurve3([new K.Vector3(0, 0, 0), new K.Vector3(0.4, 2, 0.1), new K.Vector3(1.1, 4, -0.3)]);
    const frames = spine.computeFrenetFrames(6, false);
    out.push(["tangents", "normals", "binormals"].map((name) => frames[name].map((v) => [v.x, v.y, v.z].map((n) => Math.round(n * 1e9) / 1e9))));
    // Object3D.localToWorld and worldToLocal answer the vector they were handed.
    const frame = new K.Group();
    frame.position.set(1, 2, 3);
    frame.updateMatrixWorld(true);
    const local = new K.Vector3(1, 0, 0);
    out.push([frame.localToWorld(local) === local, local.toArray(), frame.worldToLocal(new K.Vector3(5, 5, 5)).toArray()]);
    // InstancedMesh.computeBoundingSphere: the union of every instance's sphere, as the shooter's palms.
    const grove = new K.InstancedMesh(new K.BoxGeometry(1, 2, 1), new K.MeshBasicMaterial(), 3);
    [[0, 0, 0], [5, 1, -2], [-3, 0, 4]].forEach(([x, y, z], slot) => grove.setMatrixAt(slot, new K.Matrix4().makeTranslation(x, y, z)));
    grove.computeBoundingSphere();
    const sphere = grove.boundingSphere;
    out.push([sphere.center.x, sphere.center.y, sphere.center.z, sphere.radius].map((n) => Math.round(n * 1e9) / 1e9));
    return JSON.stringify(out);
  };
  await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { BufferGeometry, BoxGeometry, CatmullRomCurve3, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Vector2, Vector3, Scene, PerspectiveCamera } from "three";
function check(value, name) { if (!value) throw Error("POINTS_CHECK: " + name); }
const probe = ${probe.toString()};
check(probe({ BufferGeometry, BoxGeometry, CatmullRomCurve3, Group, InstancedMesh, Matrix4, MeshBasicMaterial, Vector2, Vector3 }) === ${JSON.stringify(probe(T))}, "setFromPoints, computeFrenetFrames and computeBoundingSphere and localToWorld equal three's");
globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); globalThis.tn.onUpdate(() => {});
`);
  await bundleNativeEngine({ entry, outfile, boot: false });
  const points = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8" });
  assert.equal(points.status, 0, `${points.stdout}\n${points.stderr}`);
}
const { build } = createRequire(resolve(native, "package.json"))("esbuild");
const writer = resolve(work, "package-writer.mjs");
await build({ entryPoints: [resolve(native, "../assets/src/native-package.ts")], outfile: writer,
  bundle: true, platform: "node", format: "esm", logLevel: "silent" });
const { writeNativePackage } = await import(writer);
// Cooked audio is a Buffer entry of encoded bytes, any length; WebAudio decodes it on the worker.
await mkdir(resolve(work, "audio"));
const audioPackage = resolve(work, "audio/assets.tnpk");
await writeFile(audioPackage, writeNativePackage([
  { name: "beep.ogg", kind: 1, data: Buffer.from("OggS!"), uploadSize: 0 },
  { name: "/assets/audio/engine.ogg", kind: 1, data: Buffer.from("OggS!"), uploadSize: 0 },
  { name: "sky.jpg", kind: 2, data: Buffer.alloc(16), uploadSize: 4 },
]));
await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { createAssetLoader } from ${JSON.stringify(resolve(native, "src/engine/player/core-assets.mjs"))};
import { Scene, PerspectiveCamera, AudioLoader } from "three";
function check(value, name) { if (!value) throw Error("AUDIO_ASSET_CHECK: " + name); }
const record = globalThis.tn.loadAsset("audio", "beep.ogg");
check(record.value instanceof ArrayBuffer && String.fromCharCode(...new Uint8Array(record.value)) === "OggS!", "cooked audio bytes");
let mismatch = false;
try { globalThis.tn.loadAsset("audio", "sky.jpg"); } catch (error) { mismatch = /TN_NATIVE_ASSET_KIND_MISMATCH/.test(error.message); }
check(mismatch, "a texture entry is not audio");
// core's IAssetLoader on a native host: no disk cache (the files are installed), prefetch serves nothing.
// The playtest bridge's state sample reads this report on every observation.
const loader = createAssetLoader({ cache: false, backgroundFill: false });
check(loader.cache.enabled === false && loader.cache.reason === "native host reads installed files" &&
  loader.cache.bytesOnDisk === 0 && typeof loader.cache.clear === "function", "native asset cache report");
check(typeof loader.prefetch === "function" && typeof loader.startBackgroundFill === "function", "native prefetch and fill");
// A decode settles on the first tick's drain, which a check never runs: reaching the decoder leaves
// both pending, and any refusal before it rejects inside this check's microtasks.
// "audio/engine.ogg" is not a package name: core's source fallback finds it under assets/, as the
// web loader does for a game without a manifest (Midway's cues).
for (const [name, decoding] of [["assets.audio", createAssetLoader().audio("beep.ogg")],
  ["assets.audio from source", createAssetLoader().audio("audio/engine.ogg")],
  ["AudioLoader", new AudioLoader().loadAsync("beep.ogg")]])
  decoding.catch((error) => { globalThis.tn.__startupError = name + " refused: " + error.message; });
createAssetLoader({ sourcePath: "" }).audio("audio/engine.ogg").then(
  () => { globalThis.tn.__startupError = "an empty sourcePath still fell back"; },
  (error) => { if (!/TN_NATIVE_ASSET_MISSING/.test(error.message)) globalThis.tn.__startupError = error.message; });
globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); globalThis.tn.onUpdate(() => {});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const audioRun = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8",
  env: { ...process.env, SDL_AUDIO_DRIVER: "dummy", TN_NATIVE_ASSET_PACKAGE: audioPackage } });
assert.equal(audioRun.status, 0, `${audioRun.stdout}\n${audioRun.stderr}`);
// An async boot publishes its scene ticks later, as Midway's does after its audio decodes settle;
// the player keeps the event loop turning until the scene arrives instead of refusing it.
await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { Scene, PerspectiveCamera } from "three";
setTimeout(() => { globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); }, 500);
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const lateRun = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8" });
assert.equal(lateRun.status, 0, `${lateRun.stdout}\n${lateRun.stderr}`);
await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { Scene, PerspectiveCamera } from "three";
// A pass node publishes the scene while start() is still running; __booting holds the check.
globalThis.tn.__booting = true;
globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera();
setTimeout(() => { globalThis.tn.__startupError = "late failure"; }, 500);
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const lateFailure = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8" });
assert.equal(lateFailure.status, 1);
assert.match(lateFailure.stderr, /core startup failed: late failure/);
// The player owns the window: a game's setSize cannot resize it, so getDrawingBufferSize reports the surface
// the player opens (TN_PLAYER_WIDTH x TN_PLAYER_HEIGHT, else 1280x720), never the size the game asked for.
const surfaceGame = (want) => `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { Scene, PerspectiveCamera, Vector2 } from "three";
import { WebGPURenderer } from "three/webgpu";
const renderer = new WebGPURenderer({ canvas: globalThis.canvas });
renderer.setSize(1920, 1080, false);
const size = renderer.getDrawingBufferSize(new Vector2());
globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera();
if (size.x + "x" + size.y !== ${JSON.stringify(want)}) globalThis.tn.__startupError = "getDrawingBufferSize reported " + size.x + "x" + size.y;
`;
for (const [env, want] of [[{ TN_PLAYER_WIDTH: "640", TN_PLAYER_HEIGHT: "360" }, "640x360"], [{}, "1280x720"]]) {
  const surfaceEntry = resolve(work, "surface.ts");
  const surfaceOut = resolve(work, "surface.js");
  await writeFile(surfaceEntry, surfaceGame(want));
  await bundleNativeEngine({ entry: surfaceEntry, outfile: surfaceOut, boot: false });
  const surface = spawnSync(resolve(executable), ["--check-game", surfaceOut], { encoding: "utf8", env: { ...process.env, ...env } });
  assert.equal(surface.status, 0, `${want}: ${surface.stdout}\n${surface.stderr}`);
}
// An installed package may keep its own `dist/three/` folder (@threenative/playtest does); only the `three` package is upstream.
await mkdir(resolve(work, "node_modules/@acme/viz/dist/three"), { recursive: true });
await writeFile(resolve(work, "node_modules/@acme/viz/dist/three/index.js"), "export const mark = () => {};");
await writeFile(resolve(work, "viz.ts"), 'import { Scene } from "three"; import { mark } from "./node_modules/@acme/viz/dist/three/index.js"; globalThis.tn.scene = new Scene(); mark();');
await bundleNativeEngine({ entry: resolve(work, "viz.ts"), outfile: resolve(work, "viz.js"), boot: false });
// Core's shadow filters, virtual shadow map and rough diffuse bundle and run (PRD-650, PRD-634, PRD-653):
// the engine draws them in C++, so their three-only TSL bodies may name what the engine refuses
// (cubeTexture, Stack, AssignNode) and never call it, and a refused class's prototype reads, as on Wasm.
const coreLookEntry = resolve(work, "core-look.ts");
const coreLookOut = resolve(work, "core-look.js");
await writeFile(coreLookEntry, `
import { DirectionalLight, Mesh, MeshStandardMaterial, PerspectiveCamera, PlaneGeometry, PointLight, Scene, SpotLight } from "three";
import { sourceAngleShadowFilter, sourceRadiusShadowFilter } from ${JSON.stringify(resolve(native, "../core/src/render/soft-shadow.ts"))};
import { useRoughDiffuse } from ${JSON.stringify(resolve(native, "../core/src/render/rough-diffuse.ts"))};
import { VirtualShadowNode } from ${JSON.stringify(resolve(native, "../core/src/render/virtual-shadow.ts"))};
const scene = new Scene();
const sun = new DirectionalLight(0xffffff, 3); sun.castShadow = true;
sun.shadow.filterNode = sourceAngleShadowFilter({ sourceAngleRad: 0.02, minPenumbraPixels: 3 });
const virtual = new VirtualShadowNode(sun, { clipExtents: [8], mapSize: 1024, marker: false });
sun.shadow.shadowNode = virtual;
if (sun.shadow.shadowNode !== virtual) throw new Error("the sun lost its virtual shadow");
scene.add(sun, sun.target);
const filter = sourceRadiusShadowFilter({ sourceRadius: 0.25 });
const spot = new SpotLight(0xffffff, 40); spot.castShadow = true; spot.shadow.filterNode = filter;
const point = new PointLight(0xffffff, 40); point.castShadow = true; point.shadow.filterNode = filter;
scene.add(new Mesh(new PlaneGeometry(), new MeshStandardMaterial()), spot, point);
if (useRoughDiffuse(scene) !== 1) throw new Error("rough diffuse marked no material");
if (point.shadow.filterNode !== filter) throw new Error("the lamp lost its filter");
globalThis.tn.scene = scene; globalThis.tn.camera = new PerspectiveCamera(); globalThis.tn.onUpdate(() => {});
`);
await bundleNativeEngine({ entry: coreLookEntry, outfile: coreLookOut, boot: false });
const coreLook = spawnSync(resolve(executable), ["--check-game", coreLookOut], { encoding: "utf8" });
assert.equal(coreLook.status, 0, coreLook.stderr);
// A game TempNode (PRD-636's LocalExposureNode) on the V8 player: setup() builds its engine node once and
// it is an operand and a receiver. A check has no renderer, as a game's startup has none, so render()
// runs no FRAME node's updateBefore (its draws would have nothing to draw with); the local-exposure
// parity row proves the per-frame update on the GPU. RendererUtils is bound.
const tempEntry = resolve(work, "temp-node.ts");
const tempOut = resolve(work, "temp-node.js");
await writeFile(tempEntry, `
import { PerspectiveCamera, RenderTarget, Scene } from "three";
import { float } from "three/tsl";
import { NodeUpdateType, RendererUtils, TempNode, WebGPURenderer } from "three/webgpu";
let setups = 0;
let updates = 0;
class Exposure extends TempNode {
  constructor() { super("float"); this.updateBeforeType = NodeUpdateType.FRAME; }
  setup(builder) { super.setup(builder); setups += 1; return float(2); }
  updateBefore({ renderer }) {
    updates += 1;
    const state = RendererUtils.resetRendererState(renderer);
    try { renderer.setRenderTarget(target); } finally { RendererUtils.restoreRendererState(renderer, state); }
  }
}
const target = new RenderTarget(4, 4);
const node = new Exposure();
if (typeof float(node).mul(node).add(node.mul(3)).toVar !== "function") throw new Error("a TempNode is no operand");
const renderer = new WebGPURenderer({ canvas: { width: 64, height: 64 } });
const scene = new Scene(); const camera = new PerspectiveCamera();
renderer.render(scene, camera); renderer.render(scene, camera);
if (setups !== 1 || updates !== 0) throw new Error("setup " + setups + " update " + updates);
const state = RendererUtils.resetRendererState(renderer);
renderer.setRenderTarget(target);
RendererUtils.restoreRendererState(renderer, state);
if (renderer.getRenderTarget() !== null) throw new Error("RendererUtils left the target set");
node.dispose();
let disposed = false;
try { float(node); } catch (error) { disposed = /TN_NATIVE_TEMPNODE_DISPOSED/.test(error.message); }
if (!disposed) throw new Error("a disposed TempNode was consumed");
globalThis.tn.scene = scene; globalThis.tn.camera = camera; globalThis.tn.onUpdate(() => {});
`);
await bundleNativeEngine({ entry: tempEntry, outfile: tempOut, boot: false });
const temp = spawnSync(resolve(executable), ["--check-game", tempOut], { encoding: "utf8" });
assert.equal(temp.status, 0, temp.stderr);
for (const antialias of [false, true]) {
// The post frame reads both names from one packed geometry target, with scalar outputs splatted.
for (const target of ["material", "normal"]) {
const targetReadback = await runComputeGame(executable, `
import { Mesh, MeshStandardMaterial, OrthographicCamera, PlaneGeometry, Scene, Vector2 } from "three";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { convertToTexture, metalness, mrt, output, pass, roughness, normalView, vec4 } from "three/tsl";
let started = false;
const waiting = [];
const frames = (count) => new Promise((done) => waiting.push({ count, done }));
globalThis.tn.onFrame(() => {
  for (const wait of waiting.splice(0)) {
    if (--wait.count === 0) wait.done(); else waiting.push(wait);
  }
});
globalThis.tn.onUpdate(() => {
  if (started) return;
  started = true;
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 1;
  const plane = new Mesh(new PlaneGeometry(2, 2), new MeshStandardMaterial({ metalness: 0.25, roughness: 0.75 }));
  // A slope distinguishes pixel-centre depth from MSAA sample 0; a flat plane hides the bug.
  plane.rotation.y = 0.3; scene.add(plane);
  globalThis.tn.scene = scene; globalThis.tn.camera = camera;
  const renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 }, antialias: ${antialias} });
  const scenePass = pass(scene, camera);
  // An MRT with the normal target reads metalness and roughness from its alpha (3-bit metalness, the
  // Unreal-look surface packing); without it they come from the exact material target this case checks.
  scenePass.setMRT(mrt(${target === "material" ? "{ output, metalness, roughness }" : "{ output, normal: normalView, metalness, roughness }"}));
  const metal = scenePass.getTextureNode("metalness"), rough = scenePass.getTextureNode("roughness");
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  // Read inside a post pass, as SSR does: an output-only graph has no pass to plan the targets for.
  const normal = ${target === "material" ? "null" : 'scenePass.getTextureNode("normal")'};
  pipeline.outputNode = convertToTexture(${target === "material" ? "vec4(metal.r, rough.g, metal.b, rough.a)" : "vec4(normal.xyz, 1)"});
  pipeline.render();
  // Pipelines compile asynchronously: read until the post pass has drawn (alpha non-zero), at most 120 frames.
  const drawn = (left) => frames(3).then(() => globalThis.tn.readFrame()).then((pixels) => pixels.some((v, i) => i % 4 === 3 && v !== 0) || left === 0 ? pixels : drawn(left - 1));
  drawn(40).then((pixels) => {
    // The canvas size is a request: read the centre of the buffer the player drew, which the tilted plane covers.
    const size = renderer.getDrawingBufferSize(new Vector2());
    const at = (Math.floor(size.y / 2) * size.x + Math.floor(size.x / 2)) * 4;
    const seen = Array.from(pixels.slice(at, at + 4));
    const ok = seen.length === 4 && ${JSON.stringify(target === "material" ? [64, 191, 64, 191] : [Math.round(Math.sin(0.3) * 255), 0, Math.round(Math.cos(0.3) * 255), 255])}.every((value, i) => Math.abs(value - seen[i]) <= 2);
    globalThis.tn.log(ok ? "COMPUTE_OK" : "COMPUTE_BAD ${target} MRT (MSAA=${antialias}) " + seen);
  }).catch((error) => globalThis.tn.log("COMPUTE_ERROR " + error.message));
});
`);
assert.equal(targetReadback.verdict, "COMPUTE_OK", targetReadback.output);
}

// Reflect the red front-face centre (0,1,1) across y=0. The camera-to-image line
// meets the floor at (0,0,2.25); its reflected ray hits (0,1,1), not a tuned screen pixel.
const ssrReadback = await runComputeGame(executable, `
import { BoxGeometry, Mesh, MeshStandardMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene, Vector2, Vector3 } from "three";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { convertToTexture, metalness, mrt, normalView, output, pass, roughness } from "three/tsl";
import { ssr } from "three/addons/tsl/display/SSRNode.js";
let started = false;
const waiting = [];
const frames = (count) => new Promise((done) => waiting.push({ count, done }));
globalThis.tn.onFrame(() => {
  for (const wait of waiting.splice(0)) {
    if (--wait.count === 0) wait.done(); else waiting.push(wait);
  }
});
globalThis.tn.onUpdate(() => {
  if (started) return;
  started = true;
  const scene = new Scene();
  const renderer = new WebGPURenderer({ antialias: ${antialias} }); renderer.toneMapping = NoToneMapping;
  const size = renderer.getDrawingBufferSize(new Vector2());
  const camera = new PerspectiveCamera(60, size.x / size.y, 0.1, 50);
  camera.position.set(0,3,6); camera.lookAt(0,0.5,0);
  const floorMaterial = new MeshStandardMaterial({ color: 0x040404, metalness: 1, roughness: 0 });
  const floor = new Mesh(new PlaneGeometry(20,20), floorMaterial);
  floor.rotation.x = -Math.PI / 2; scene.add(floor);
  const box = new Mesh(new BoxGeometry(2,2,2), new MeshStandardMaterial({ color: 0, emissive: 0xff0000, metalness: 0, roughness: 1 }));
  box.position.y = 1; scene.add(box);
  globalThis.tn.scene = scene; globalThis.tn.camera = camera;
  const scenePass = pass(scene,camera);
  scenePass.setMRT(mrt({ output, normal: normalView, metalness, roughness }));
  const base = convertToTexture(scenePass.getTextureNode());
  const reflection = ssr(base, scenePass.getTextureNode("depth"), scenePass.getTextureNode("normal"), {
    camera, metalnessNode: scenePass.getTextureNode("metalness").r,
    roughnessNode: scenePass.getTextureNode("roughness").g, reflectNonMetals: true,
  });
  reflection.maxDistance.value = 30; reflection.quality.value = 1; reflection.resolutionScale = 0.5;
  if (reflection.thickness.value !== Math.fround(0.1) || reflection.opacity.value !== 1)
    throw Error("SSR defaults did not reach the native effect");
  const pipeline = new RenderPipeline(renderer); pipeline.outputColorTransform = false;
  const capture = async (node) => {
    pipeline.outputNode = node; pipeline.render();
    await frames(3);
    const pixels = await globalThis.tn.readFrame();
    if (pixels.length !== size.x * size.y * 4) throw Error("SSR frame readback is empty or has the wrong extent: " + pixels.length);
    const sample = (point) => {
      const projected = point.project(camera);
      const x = Math.floor((projected.x * 0.5 + 0.5) * size.x);
      const y = Math.floor((0.5 - projected.y * 0.5) * size.y);
      if (x < 0 || x >= size.x || y < 0 || y >= size.y) throw Error("SSR geometry projects outside the frame");
      return Array.from(pixels.slice((y * size.x + x) * 4, (y * size.x + x) * 4 + 4));
    };
    return { hit: sample(new Vector3(0,0,2.25)), far: sample(new Vector3(3,0,2.25)) };
  };
  (async () => {
    const baseline = await capture(base);
    const mirror = await capture(base.add(reflection));
    // Ideal linear red = (1-1/30)^2 * 3.75^2/(3^2+3.75^2) = 0.570; >145/255.
    // An 80-code rise allows raster/march error while excluding a missing reflection.
    if (mirror.hit[0] - baseline.hit[0] < 80) throw Error("SSR mirror did not reflect red: " + JSON.stringify({baseline,mirror}));
    if (mirror.far.some((v,i) => Math.abs(v - baseline.far[i]) > 2)) throw Error("SSR changed a floor pixel whose ray misses the box");
    reflection.reflectNonMetals = false;
    floorMaterial.metalness = 0; floorMaterial.roughness = 1;
    const roughBaseline = await capture(base);
    const roughFloor = await capture(base.add(reflection));
    if (["hit","far"].some((key) => roughFloor[key].some((v,i) => Math.abs(v - roughBaseline[key][i]) > 2)))
      throw Error("SSR reflected a rough non-metal: " + JSON.stringify({roughBaseline,roughFloor}));
    globalThis.tn.log("COMPUTE_OK");
  })().catch((error) => globalThis.tn.log("COMPUTE_ERROR " + error.message));
});
`);
assert.equal(ssrReadback.verdict, "COMPUTE_OK", ssrReadback.output);

}

// Perspective depth must stay a depth resource in both intermediate and output graph programs.
for (const postPass of [true, false]) {
  const depthReadback = await runComputeGame(executable, `
import { Mesh, MeshBasicMaterial, NoToneMapping, PerspectiveCamera, PlaneGeometry, Scene } from "three";
import { RenderPipeline, WebGPURenderer } from "three/webgpu";
import { convertToTexture, pass, vec4 } from "three/tsl";
let started = false, remaining = 3;
globalThis.tn.onUpdate(() => {
  if (started) return;
  started = true;
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 20);
  camera.position.z = 1;
  const plane = new Mesh(new PlaneGeometry(20, 20), new MeshBasicMaterial());
  plane.position.z = -3; scene.add(plane);
  globalThis.tn.scene = scene; globalThis.tn.camera = camera;
  const renderer = new WebGPURenderer(); renderer.toneMapping = NoToneMapping;
  const scenePass = pass(scene, camera);
  const distance = scenePass.getViewZNode().negate().div(10);
  const linearDepth = vec4(distance, distance, distance, 1);
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = ${postPass ? "convertToTexture(linearDepth)" : "linearDepth"};
  pipeline.render();
  globalThis.tn.onFrame(() => {
    if (--remaining !== 0) return;
    globalThis.tn.readFrame().then((pixels) => {
      const at = Math.floor(pixels.length / 8) * 4;
      const seen = Array.from(pixels.slice(at, at + 4));
      // Linear distance 4 / 10 is 170 in sRGB-encoded RGBA8.
      const ok = seen.length === 4 && [170, 170, 170, 255].every((v, i) => Math.abs(v - seen[i]) <= 3);
      globalThis.tn.log(ok ? "COMPUTE_OK" : "COMPUTE_BAD scene depth (post=${postPass}) " + seen);
    }).catch((error) => globalThis.tn.log("COMPUTE_ERROR " + error.message));
  });
});
`);
  assert.equal(depthReadback.verdict, "COMPUTE_OK", depthReadback.output);
}

const worldMatrixReadback = await runComputeGame(executable, `
import { Group, Mesh, NoToneMapping, OrthographicCamera, PlaneGeometry, Scene, Vector2 } from "three";
import { MeshBasicNodeMaterial, WebGPURenderer } from "three/webgpu";
import { modelWorldMatrix, positionLocal, vec3, vec4 } from "three/tsl";
let started = false;
let remaining = 0;
globalThis.tn.onUpdate(() => {
  if (started) return;
  started = true;
  const scene = new Scene();
  const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 10);
  camera.position.z = 2;
  const material = new MeshBasicNodeMaterial();
  material.positionNode = positionLocal.add(vec3(modelWorldMatrix.element(3).x, 0, 0));
  material.colorNode = vec3(modelWorldMatrix.mul(vec4(0, 0, 0, 1)).x.add(0.5), modelWorldMatrix.element(3).y, 0);
  for (const direction of [-1, 1]) {
    const parent = new Group(); parent.position.set(direction * 0.25, 0.25, 0);
    const mesh = new Mesh(new PlaneGeometry(0.5, 0.5), material);
    mesh.position.set(direction * 0.25, 0.25, 0);
    parent.add(mesh); scene.add(parent);
  }
  globalThis.tn.scene = scene; globalThis.tn.camera = camera;
  const renderer = new WebGPURenderer(); renderer.toneMapping = NoToneMapping;
  remaining = 3;
  globalThis.tn.onFrame(() => {
    if (--remaining !== 0) return;
    globalThis.tn.readFrame().then((pixels) => {
      const size = renderer.getDrawingBufferSize(new Vector2());
      const pixel = (x, y) => Array.from(pixels.slice((Math.floor(y * size.y) * size.x + Math.floor(x * size.x)) * 4,
        (Math.floor(y * size.y) * size.x + Math.floor(x * size.x)) * 4 + 4));
      const left = pixel(0.25, 0.375), right = pixel(0.75, 0.375), middle = pixel(0.5, 0.375);
      const close = (seen, expected) => seen.length === 4 && expected.every((v, i) => Math.abs(seen[i] - v) <= 3);
      const ok = close(left, [0, 188, 0, 255]) && close(right, [255, 188, 0, 255]) && close(middle, [0, 0, 0, 255]);
      globalThis.tn.log(ok ? "COMPUTE_OK" : "COMPUTE_BAD modelWorldMatrix " + JSON.stringify({ left, right, middle, size }));
    }).catch((error) => globalThis.tn.log("COMPUTE_ERROR " + error.message));
  });
});
`);
assert.equal(worldMatrixReadback.verdict, "COMPUTE_OK", worldMatrixReadback.output);

// A real inline GLB, with a black base so only the scaled red emissive can contribute.
function emissiveGlb(strength, required = "KHR_materials_emissive_strength") {
  const positions = Buffer.from(new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]).buffer);
  const json = Buffer.from(JSON.stringify({ asset: { version: "2.0" }, scene: 0,
    scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    buffers: [{ byteLength: positions.length }], bufferViews: [{ buffer: 0, byteLength: positions.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-1, -1, 0], max: [1, 1, 0] }],
    extensionsUsed: [required], extensionsRequired: [required],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0, 0, 0, 1] }, emissiveFactor: [1, 0, 0],
      extensions: { KHR_materials_emissive_strength: strength === undefined ? {} : { emissiveStrength: strength } } }],
  }));
  const padded = Math.ceil(json.length / 4) * 4;
  const glb = Buffer.alloc(28 + padded + positions.length, 0x20);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded, 12); glb.writeUInt32LE(0x4e4f534a, 16); json.copy(glb, 20);
  glb.writeUInt32LE(positions.length, 20 + padded); glb.writeUInt32LE(0x004e4942, 24 + padded);
  positions.copy(glb, 28 + padded);
  return glb;
}
const emissivePackage = resolve(work, "emissive.tnpk");
await writeFile(emissivePackage, writeNativePackage([
  { name: "emissive.glb", kind: 6, data: emissiveGlb(2), uploadSize: 0 },
  { name: "default.glb", kind: 6, data: emissiveGlb(undefined), uploadSize: 0 },
  { name: "unknown.glb", kind: 6, data: emissiveGlb(2, "UNKNOWN_required_extension"), uploadSize: 0 },
]));
await writeFile(entry, `
import { Scene, PerspectiveCamera } from "three";
try {
  for (const [name, expected] of [["emissive.glb", 2], ["default.glb", 1]]) {
    const model = globalThis.tn.loadAsset("model", name).value;
    let checked = 0;
    model.scene.traverse((object) => {
      if (!object.isMesh) return;
      checked++;
      const material = object.material;
      if (material.emissiveIntensity !== expected || material.emissive.r !== 1 || material.emissive.g !== 0 || material.emissive.b !== 0)
        throw Error("emissive strength not loaded: " + material.emissiveIntensity);
    });
    if (checked !== 1) throw Error("emissive fixture has no mesh");
  }
  let refused = "";
  try { globalThis.tn.loadAsset("model", "unknown.glb"); } catch (error) { refused = error.message; }
  if (!refused.includes("TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED UNKNOWN_required_extension"))
    throw Error("unknown required extension did not fail by name: " + refused);
  globalThis.tn.log("EMISSIVE_STRENGTH_OK");
} catch (error) {
  if (${process.argv.includes("--imports-only")} && /TN_NATIVE_GLTF_UNAVAILABLE/.test(error.message))
    globalThis.tn.log("EMISSIVE_STRENGTH_UNAVAILABLE: built without cgltf");
  else throw error;
}
globalThis.tn.scene = new Scene(); globalThis.tn.camera = new PerspectiveCamera(); globalThis.tn.onUpdate(() => {});
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const emissiveRun = spawnSync(resolve(executable), ["--check-game", outfile], { encoding: "utf8",
  env: { ...process.env, TN_NATIVE_ASSET_PACKAGE: emissivePackage } });
assert.equal(emissiveRun.status, 0, `${emissiveRun.stdout}\n${emissiveRun.stderr}`);
assert.match(emissiveRun.stdout, /EMISSIVE_STRENGTH_(OK|UNAVAILABLE)/);
console.log(emissiveRun.stdout.match(/EMISSIVE_STRENGTH_[^\n]*/)[0]);

if (process.argv.includes("--imports-only")) {
  console.log("PASS native imports, identity, picking, clone, TSL and audio");
  process.exit(0);
}
// Same resident, package reader, native handles and installed bridge as the desktop player.
const textureBytes = Buffer.alloc(16);
textureBytes.writeUInt32LE(1, 0); textureBytes.writeUInt32LE(1, 4); textureBytes.writeUInt32LE(19, 8);
textureBytes.set([255, 32, 16, 255], 12);
const packageBytes = writeNativePackage([
  { name: "sky.jpg", kind: 2, data: textureBytes, uploadSize: 4 },
  { name: "model.glb", kind: 6, data: Buffer.from(JSON.stringify({ asset: { version: "2.0" },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "cooked-child" }] })), uploadSize: 0 },
]);
await mkdir(resolve(work, "native"));
const packagePath = resolve(work, "native/assets.tnpk");
await writeFile(packagePath, packageBytes);
await writeFile(entry, `
import ${JSON.stringify(resolve(native, "src/engine/player/core-host.mjs"))};
import { createAssetLoader } from ${JSON.stringify(resolve(native, "src/engine/player/core-assets.mjs"))};
import { Scene, PerspectiveCamera, Mesh, BoxGeometry, MeshBasicMaterial, Color } from "three";
import { WebGPURenderer, RenderPipeline } from "three/webgpu";
import { rtt, vec4, convertToTexture, screenUV, pass, mrt, output, normalView, metalness, roughness, uniform, texture } from "three/tsl";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import { traa } from "three/addons/tsl/display/TRAANode.js";
import { installThreePlaytestBridge } from "@threenative/playtest/three";
function check(value, name) { if (!value) throw Error("SERVICE_CHECK: " + name); }
const host = globalThis.__THREENATIVE_NATIVE__.physics;
check(host && typeof host.version === "string", "native Rapier resident");
const physics = host.createSimulation({ gravity: { x: 0, y: -9.81, z: 0 } });
physics.createBody({ type: "dynamic", mass: 1, position: { x: 0, y: 3, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 }, collisionLayer: 1, collisionMask: 65535,
  sensor: false, continuousCollision: false,
  shape: { kind: "box", x: 0.5, y: 0.5, z: 0.5, collisionLayer: 1, collisionMask: 65535, sensor: false } });
for (let i = 0; i < 30; i++) physics.step(1 / 60);
const positions = new Float32Array(8);
check(physics.readVisibleTransforms(positions) > 0 && positions[2] < 3, "native Rapier gravity");
physics.dispose();
const scene = new Scene(); const camera = new PerspectiveCamera(); camera.position.z = 5;
const player = new Mesh(new BoxGeometry(), new MeshBasicMaterial()); scene.add(player);
scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
const renderer = new WebGPURenderer({ canvas: { width: 1280, height: 720 } });
check(renderer.supportsRetainedTargetSubrect === false, "surface-owned renderer declines retained target subrects");
check(renderer.toneMapping === 0 && renderer.outputColorSpace === "srgb" && !renderer.shadowMap.enabled, "renderer defaults");
renderer.toneMapping = 4; renderer.toneMappingExposure = 0.62; renderer.shadowMap.enabled = true; renderer.shadowMap.type = 2;
renderer.render(scene, camera);
renderer.toneMapping = 5;
let customRefused = false;
try { renderer.render(scene, camera); } catch (error) { customRefused = /TN_NATIVE_RENDERER_STATE: toneMapping 5/.test(error.message); }
check(customRefused, "an unimplemented tone mapping refuses");
check(renderer.info.render.drawCalls === 0 && renderer.info.render.triangles === 0 && renderer.info.render.calls === 0,
  "renderer.info counts the last drawn frame (none in a check)");
renderer.toneMapping = 4;
const pipeline = new RenderPipeline(renderer); pipeline.outputNode = vec4(0.2, 0.3, 0.4, 1);
pipeline.render();
const target = convertToTexture(vec4(0.2, 0.3, 0.4, 1)).setResolutionScale(0.5);
pipeline.outputNode = target.sample(screenUV); pipeline.render();
check(convertToTexture(target) !== undefined, "native post RTT graph");
const manual = rtt(vec4(0.2, 0.3, 0.4, 0.5), 16, 8);
manual.setup({ getSharedContext: () => ({}) });
check(manual._quadMesh.material.isNodeMaterial && manual._quadMesh.material.type === "NodeMaterial", "real RTT quad material");
check(manual._quadMesh.material.fragmentNode !== undefined && manual.renderTarget.texture.type === 1016, "bound RTT source/target");
manual.autoUpdate = false;
let draws = 0, currentTarget = null;
const captureRenderer = { getRenderTarget: () => currentTarget, setRenderTarget: t => { currentTarget = t; },
  render: (q, c) => { check(q === manual._quadMesh && c.isCamera && currentTarget === manual.renderTarget, "RTT manual draw"); ++draws; } };
manual.updateBefore({ renderer: captureRenderer });
manual.needsUpdate = true;
manual.updateBefore({ renderer: captureRenderer });
check(draws === 1 && manual.version === 1 && currentTarget === null, "RTT frozen texture and node invalidation");
manual.textureNeedsUpdate = true;
manual.updateBefore({ renderer: captureRenderer });
check(draws === 2 && !manual.textureNeedsUpdate, "RTT explicit dirty update");
pipeline.outputNode = manual.sample(screenUV); pipeline.render();
camera.aspect = 4 / 3; camera.updateProjectionMatrix();
const originalProjection = JSON.stringify(Array.from(camera.projectionMatrix.elements));
const temporal = traa(texture({ name: "scene" }), texture({ name: "depth" }), texture({ name: "velocity" }), camera);
temporal.setViewOffset(320, 240);
check(JSON.stringify(Array.from(camera.projectionMatrix.elements)) !== originalProjection, "TRAA camera jitter");
temporal.clearViewOffset();
check(JSON.stringify(Array.from(camera.projectionMatrix.elements)) === originalProjection, "TRAA camera restored");
temporal.setup({ context: { renderPipeline: pipeline }, renderer: { getDrawingBufferSize: size => size.set(320, 240) } });
pipeline.outputNode = temporal; pipeline.render();
check(temporal.__effect("viewOffset") === 0 && JSON.stringify(Array.from(camera.projectionMatrix.elements)) === originalProjection,
  "TRAA pipeline clears its camera offset");
// The minimal template's live post chain (PRD-531 slice 4): pass, MRT normals and the four addons.
const scenePass = pass(scene, camera);
let refusedNormal = false;
try { scenePass.getTextureNode("normal"); } catch (error) { refusedNormal = /TN_NATIVE_PASS_TEXTURE_UNSUPPORTED/.test(error.message); }
check(refusedNormal, "normals need the MRT that asks for them");
for (const name of ["metalness", "roughness"]) {
  let refused = false;
  try { scenePass.getTextureNode(name); } catch (error) { refused = /TN_NATIVE_PASS_TEXTURE_UNSUPPORTED/.test(error.message); }
  check(refused, name + " needs its MRT output");
}
scenePass.setMRT(mrt({ output, normal: normalView, metalness, roughness }));
const sceneDepth = scenePass.getTextureNode("depth"), sceneNormal = scenePass.getTextureNode("normal");
let refusedVelocity = false;
try { scenePass.getTextureNode("velocity"); } catch (error) { refusedVelocity = /TN_NATIVE_PASS_TEXTURE_UNSUPPORTED/.test(error.message); }
const sceneSurface = scenePass.getTextureNode("metalness");
check(refusedVelocity && scenePass.getTextureNode("roughness") && scenePass.isPassNode && scenePass.scene === scene && sceneSurface.r !== undefined && sceneSurface.g !== undefined,
  "the native scene pass has colour, depth, normals and the surface (metalness r, roughness g); velocity refuses");
const contact = ao(sceneDepth, sceneNormal, camera);
contact.radius.value = 0.35; contact.resolutionScale = 0.5;
check(contact.radius.value === Math.fround(0.35) && contact.resolutionScale === 0.5 && contact.getTextureNode() === contact, "GTAO uniforms");
const occlusion = denoise(contact.getTextureNode(), sceneDepth, sceneNormal, camera);
let composed = scenePass.getTextureNode().mul(occlusion.r);
const glow = bloom(convertToTexture(composed), 0.22, 0.6, 1);
glow.strength.value = 0.5;
check(glow.strength.value === 0.5 && glow.radius.value === Math.fround(0.6) && glow.threshold.value === 1, "bloom uniforms");
composed = composed.add(glow);
const fall = screenUV.sub(0.5).length().oneMinus();
pipeline.outputNode = smaa(composed.mul(fall));
pipeline.render(); pipeline.render();
// A post-chain frame pushes edited Color/VectorN uniforms, as renderer.render does.
const tint = uniform(new Color(1, 0, 0)); tint.value.g = 0.5;
const setUniform = globalThis.tsl.setUniform; let synced = false;
globalThis.tsl.setUniform = (node, ...lanes) => { synced ||= node === tint && lanes[1] === 0.5; return setUniform(node, ...lanes); };
pipeline.render(); globalThis.tsl.setUniform = setUniform;
check(synced, "RenderPipeline.render syncs edited uniforms");
let refusedSlot = false;
try { mrt({ normal: metalness }); } catch (error) { refusedSlot = /TN_NATIVE_MRT_UNSUPPORTED/.test(error.message); }
check(refusedSlot, "an MRT slot under another name refuses");
globalThis.tn.setPostGraph(JSON.stringify({ version: 1, root: 0, nodes: [
  { kind: "ConstNode", type: "vec4", value: [1, 0.5, 0.25, 1], args: [], dependencies: [] }] }));
let refused = false;
try { globalThis.tn.setPostGraph(JSON.stringify({ version: 1, root: 0, nodes: [
  { kind: "NotANativePostNode", args: [], dependencies: [] }] })); } catch (error) { refused = /TN_NATIVE_POST_INVALID/.test(error.message); }
check(refused, "unknown post nodes refuse");
installThreePlaytestBridge({ scene, camera, renderer,
  entities: [{ id: "registered-player", object: player }],
  components: () => ({ player: { position: [0, 0, 0] } }),
  startup: () => ({ phase: "ready", progress: 1 }),
  resources: { read: () => ({ score: { value: 7 } }) },
  renderChain: () => ({ tier: "high", requested: [], stages: [], dropped: [], contributions: [],
    velocity: { provisioned: false, required: false, source: null } }) });
const assets = createAssetLoader();
Promise.all([assets.texture("sky.jpg"), assets.model("model.glb")]).then(async ([sky, model]) => {
  check(sky.name === "sky.jpg" && sky.colorSpace === "srgb", "cooked native texture");
  check(model.scene.children[0].name === "cooked-child", "native cgltf hierarchy");
  check(await assets.texture("sky.jpg") === sky, "asset cache identity");
  check(assets.progress.requested === 2 && assets.progress.settled === 2 && assets.progress.pending.length === 0, "asset progress");
  check(assets.resolved.get("sky.jpg").via === "manifest", "asset resolution");
  let missing = false;
  try { await assets.texture("absent.jpg"); } catch (error) { missing = /TN_NATIVE_ASSET_MISSING/.test(error.message); }
  check(missing, "missing cooked asset refuses");
}).catch(error => { globalThis.tn.__startupError = error.stack; });
`);
await bundleNativeEngine({ entry, outfile, boot: false });
const checked = spawnSync(resolve(executable), ["--check-game", "--check-request", JSON.stringify({
  id: "observations", method: "sample", argument: { entities: ["registered-player"] },
}), outfile], { encoding: "utf8", env: { ...process.env, TN_NATIVE_ASSET_PACKAGE: packagePath } });
assert.equal(checked.status, 0, `${checked.stdout}\n${checked.stderr}`);
assert.match(checked.stdout, /"id":"registered-player"/);
assert.match(checked.stdout, /"tier":"high"/);
assert.match(checked.stdout, /"score":\{"value":7\}/);
const corrupt = packageBytes.slice(); corrupt[corrupt.length - 1] ^= 1;
await writeFile(packagePath, corrupt);
const rejected = spawnSync(resolve(executable), ["--check-game", outfile], {
  encoding: "utf8", env: { ...process.env, TN_NATIVE_ASSET_PACKAGE: packagePath },
});
assert.equal(rejected.status, 1);
assert.match(rejected.stderr, /TN_PACKAGE_HASH/);
await writeFile(packagePath, packageBytes);
await writeFile(entry, `
import { defineGame, Scene as GameScene, getPlatform } from "@threenative/core";
import { Mesh, BoxGeometry, MeshBasicMaterial } from "three";
class Play extends GameScene {
  static initialState = {};
  enter(ctx) {
    if (getPlatform().runtime !== "native") throw Error("native platform marker missing");
    const player = ctx.add(new Mesh(new BoxGeometry(), new MeshBasicMaterial()));
    player.name = "player";
    return () => {};
  }
}
export default defineGame({ scenes: { play: Play }, start: "play", frameBudget: false,
  render: { projection: false, matrixWorld: "all" } });
`);
// A core game bundles (PRD-552): picking's MeshBVH, core's TSL context nodes and BatchedMesh are bound,
// and the exports the engine does not provide (core's WebGL2 fallback, Points) are refused at use, by
// name, as on Wasm (owner decision 2026-10-09).
await bundleNativeEngine({ entry, outfile });
const accepted = await readFile(outfile, "utf8");
// Refused at use: constructing Points fails at that call with the catalog's diagnostic.
const pointsEntry = resolve(work, "points.ts");
const pointsOut = resolve(work, "points.js");
await writeFile(pointsEntry, 'import { Points, Scene } from "three"; try { new Points(); globalThis.tn.__startupError = "Points constructed"; } catch (error) { globalThis.tn.__startupError = String(error.message); } globalThis.tn.scene = new Scene();');
await bundleNativeEngine({ entry: pointsEntry, outfile: pointsOut, boot: false });
const points = spawnSync(resolve(executable), ["--check-game", pointsOut], { encoding: "utf8" });
assert.equal(points.status, 1);
assert.match(points.stderr, /TN_NATIVE_UNSUPPORTED_POINTS: Points is not available on the native engine/);
await writeFile(entry, 'import { NativeBindingThatDoesNotExist } from "three"; globalThis.tn.scene = new NativeBindingThatDoesNotExist();');
await assert.rejects(bundleNativeEngine({ entry, outfile, boot: false }), /TN_NATIVE_ENGINE_UNBOUND: three:NativeBindingThatDoesNotExist/);
assert.equal(await readFile(outfile, "utf8"), accepted, "failed build must preserve the prior artifact");
await writeFile(entry, `import { Scene } from ${JSON.stringify(createRequire(resolve(native, "package.json")).resolve("three"))}; globalThis.tn.scene = new Scene();`);
await assert.rejects(bundleNativeEngine({ entry, outfile, boot: false }), /TN_NATIVE_ENGINE_UPSTREAM/);
assert.equal(await readFile(outfile, "utf8"), accepted);
await assert.rejects(bundleNativeEngine({ entry, outfile: entry, boot: false }), /TN_NATIVE_ENGINE_OUTPUT/);
await writeFile(entry, 'globalThis.tn.onUpdate(async () => { const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js"); globalThis.tn.scene = new GLTFLoader(); });');
await assert.rejects(bundleNativeEngine({ entry, outfile, boot: false }), /TN_NATIVE_ENGINE_UNBOUND: three\/addons\/loaders\/GLTFLoader.js:GLTFLoader/);
assert.equal(await readFile(outfile, "utf8"), accepted);
await writeFile(resolve(work, "bad.js"), 'globalThis.tn.__startupError = "deliberate startup failure";');
const bad = spawnSync(resolve(executable), ["--check-game", resolve(work, "bad.js")], { encoding: "utf8" });
assert.equal(bad.status, 1);
assert.match(bad.stderr, /deliberate startup failure/);
console.log("PASS native imports, TSL/RTT post, cooked assets/hash refusals, native Rapier, installed bridge and fail-closed publication");
