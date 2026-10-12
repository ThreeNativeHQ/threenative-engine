// PRD-532: the browser-JS back end over the real Wasm ABI (tn-native-engine-abi-module), under node.
//   tsx tests/browser-backend-smoke.ts <path to tn-native-engine-abi-module.js>
// Prints TN_BROWSER_BACKEND_OK and exits 0 when every check holds; names the first that fails.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

import type * as THREE from "three";

import { defineBufferGeometryUtils } from "../src/addons/merge-geometries.js";
import { definePostEffects } from "../src/addons/post-effects.js";
import type { defineAudioClasses } from "../src/audio.js";
import {
  type IRegistryDump,
  TSL_NODE,
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
  engineRef,
} from "../src/browser-backend.js";
import { bindWebEngine } from "../src/browser-entry.js";
import { type ITslRuntime, type TslArgValue, defineTsl } from "../src/browser-tsl.js";
import { defineReflector } from "../src/reflector.js";
import type { ConstClasses } from "../src/tsl-uniforms.js";

const modulePath = process.argv[2];
if (modulePath === undefined) throw new Error("usage: browser-backend-smoke.ts <abi module .js>");
const createTnAbi = createRequire(import.meta.url)(
  path.resolve(modulePath),
) as () => Promise<TnAbiModule>;
const registry = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "api", "native-registry.json"), "utf8"),
) as IRegistryDump;

// The back end mirrors three's API, so three's declarations type it.
const abi = await createTnAbi();
const runtime = createWasmRuntime(abi);
const engine = defineBrowserClasses(registry, runtime);
const {
  Box3,
  BoxGeometry,
  DataTexture,
  Mesh,
  MeshBasicNodeMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Quaternion,
  Scene,
  Texture,
  Vector2,
  Vector3,
  Vector4,
} = engine.classes as unknown as typeof THREE;

const constClasses = engine.classes as unknown as ConstClasses;

function check(condition: boolean, what: string): void {
  if (!condition) {
    process.stderr.write(`TN_BROWSER_BACKEND_FAILED: ${what}\n`);
    process.exit(1);
  }
}

const v = new Vector3(1, 2, 3);
check(v.add(new Vector3(1, 1, 1)) === v, "a chaining method returns its own wrapper");
check(v.x === 2 && v.y === 3 && v.z === 4, `Vector3.add (${v.x}, ${v.y}, ${v.z})`);
v.x = 7;
check(v.x === 7, "a setter reaches the engine");

const material = new MeshStandardMaterial();
const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
const position = mesh.position;
check(position === mesh.position, "a member object keeps one identity");
mesh.position.x = 5;
mesh.updateMatrixWorld();
check(
  mesh.matrixWorld.elements[12] === 5,
  `matrixWorld.elements[12] is ${mesh.matrixWorld.elements[12]}`,
);
check(mesh.material === material, "the material member is the constructor's material");
material.color.r = 0.25;
check(
  (mesh.material as THREE.MeshStandardMaterial).color.r === 0.25,
  "a member chain writes through",
);
const geometry = mesh.geometry;
check(geometry === mesh.geometry, "the geometry member keeps one identity");
const bounds = new Box3().setFromObject(mesh);
check(bounds.min.x === 4.5 && bounds.max.x === 5.5, "object bounds include the world transform");
check(new Box3().setFromObject(mesh, true).equals(bounds), "precise object bounds reach vertices");
check(
  new Box3().expandByObject(mesh).equals(bounds),
  "expandByObject reaches the same scene bounds",
);
const worldPosition = new Vector3();
const worldScale = new Vector3();
const worldDirection = new Vector3();
const worldQuaternion = new Quaternion();
check(
  mesh.getWorldPosition(worldPosition) === worldPosition && worldPosition.x === 5,
  "world position returns its target",
);
check(
  mesh.getWorldScale(worldScale) === worldScale && worldScale.x === 1,
  "world scale returns its target",
);
check(
  mesh.getWorldDirection(worldDirection) === worldDirection && worldDirection.z === 1,
  "world direction returns its target",
);
check(
  mesh.getWorldQuaternion(worldQuaternion) === worldQuaternion && worldQuaternion.w === 1,
  "world quaternion returns its target",
);
const camera = new PerspectiveCamera(60, 1, 0.1, 100);
camera.position.z = 5;
camera.updateMatrixWorld();
const projected = new Vector3();
check(
  projected.project(camera) === projected && projected.z > 0,
  "camera projection returns the vector",
);
check(
  projected.unproject(camera) === projected && Math.abs(projected.z) < 1e-12,
  "camera unprojection reverses projection",
);
let refused = "";
try {
  mesh.applyMatrix4("not a matrix" as never);
} catch (error) {
  refused = String(error);
}
check(refused.includes("TN_ABI_"), `an engine refusal surfaces as an error (${refused || "none"})`);

// Callbacks: the engine fires onBeforeRender (here through the module's test hook, as the renderer
// would before a draw) and the closure gets three's arguments and the mesh as `this`.
const scene = new Scene();
scene.add(mesh);
let seen = "";
const callback = function (
  this: unknown,
  renderer: unknown,
  s: unknown,
  camera: unknown,
  g: unknown,
  m: unknown,
  group: unknown,
) {
  seen = [
    renderer === null,
    s === scene,
    camera === null,
    g === mesh.geometry,
    m === mesh.material,
    group === null,
    this === mesh,
  ].join();
};
mesh.onBeforeRender = callback as never;
check(mesh.onBeforeRender === (callback as never), "the callback reads back");
const fire = () => {
  const ref = engineRef(mesh);
  if (ref === undefined) throw new Error("no engine ref");
  const [type, context, index, generation] = ref.key.split(":").map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const pointer = abi._malloc(12);
  const view = new DataView(abi.HEAPU8.buffer);
  view.setUint16(pointer, type, true);
  view.setUint16(pointer + 2, context, true);
  view.setUint32(pointer + 4, index, true);
  view.setUint32(pointer + 8, generation, true);
  const status = (
    abi as unknown as { _tnw_fire_before_render(p: number): number }
  )._tnw_fire_before_render(pointer);
  abi._free(pointer);
  return status;
};
check(fire() === 0, "the engine ran the callback");
check(seen === "true,true,true,true,true,true,true", `callback arguments ${seen}`);
mesh.onBeforeRender = (() => {
  throw new Error("boom");
}) as never;
check(fire() === 1, "a throw comes back as a failure, not a crash");
mesh.onBeforeRender = null as never;
check(mesh.onBeforeRender === null && fire() === 2, "a cleared callback is gone from the engine");
let rejected = "";
try {
  mesh.onBeforeRender = 42 as never;
} catch (error) {
  rejected = String(error);
}
check(rejected.includes("must be a function"), "a non-function callback is refused");
engine.collect();

// three's audio classes on the web engine: bound by the entry over the engine's Object3D, reading
// world poses off the Wasm scene. Node has no WebAudio; a recording context
// stands in for it, so only the engine side is under test here (the WebAudio side: audio.spec.ts).
{
  const web = (await bindWebEngine(createTnAbi, [
    "AudioContext",
    "AudioListener",
    "Audio",
    "PositionalAudio",
    "AudioLoader",
    "Object3D",
    "PerspectiveCamera",
    "Mesh",
    "Scene",
  ])) as unknown as typeof THREE;
  const sound = web as unknown as ReturnType<typeof defineAudioClasses>;
  const heard: string[] = [];
  const spatial = (who: string) => ({
    setPosition: (x: number, y: number, z: number) => heard.push(`${who}:${x},${y},${z}`),
    setOrientation: () => undefined,
  });
  const node = (extra: object = {}) => ({
    connect: () => undefined,
    disconnect: () => undefined,
    ...extra,
  });
  const param = { value: 1, setTargetAtTime: () => undefined };
  sound.AudioContext.setContext({
    currentTime: 0,
    destination: node(),
    listener: spatial("listener"),
    createGain: () => node({ gain: param }),
    createPanner: () => node(spatial("voice")),
    createBufferSource: () =>
      node({ start: () => undefined, stop: () => undefined, playbackRate: param, detune: param }),
  } as never);
  const scene = new web.Scene();
  const camera = new web.PerspectiveCamera();
  const listener = new sound.AudioListener();
  camera.add(listener as never);
  scene.add(camera);
  camera.position.set(0, 1, 5);
  const boat = new web.Mesh();
  scene.add(boat);
  const voice = new sound.PositionalAudio(listener);
  boat.add(voice as never);
  voice.setBuffer({ duration: 1 } as AudioBuffer);
  voice.play();
  boat.position.set(-4, 0, 1);
  check(
    listener instanceof web.Object3D && listener.parent === camera,
    "the listener is an engine child",
  );
  check(voice instanceof sound.Audio && voice.parent === boat, "the voice is welded to the mesh");
  // What three's renderer does each frame: world matrices, then each audio object's override.
  scene.updateMatrixWorld(true);
  listener.updateMatrixWorld(true);
  voice.updateMatrixWorld(true);
  check(heard.includes("listener:0,1,5"), `listener pose ${heard.join(" ")}`);
  check(heard.includes("voice:-4,0,1"), `voice pose ${heard.join(" ")}`);
}
// The engine's Shape and ExtrudeGeometry on the web: a hole pushed onto shape.holes is cut, and the
// options object reaches the generator; positions, normals and uvs equal the pinned three's.
{
  type Ctor = new (...args: unknown[]) => Record<string, unknown>;
  const names = ["Shape", "Path", "Vector2", "ExtrudeGeometry", "ShapeGeometry", "BufferGeometry"];
  const web = (await bindWebEngine(createTnAbi, names)) as Record<string, Ctor>;
  // three/webgpu carries every core class; tsx would map a bare `three` to the generated d.ts.
  const upstream = (await import(
    pathToFileURL(
      createRequire(path.join(import.meta.dirname, "../../core/package.json")).resolve(
        "three/webgpu",
      ),
    ).href
  )) as Record<string, Ctor>;
  const build = (K: Record<string, Ctor>): string => {
    const V = K.Vector2 as Ctor;
    const shape = new (K.Shape as Ctor)([new V(-1, -1), new V(1, -1), new V(1, 1), new V(-1, 1)]);
    const hole = new (K.Path as Ctor)() as { absellipse(...args: unknown[]): unknown };
    hole.absellipse(0, 0, 0.5, 0.3, 0, Math.PI * 2, false, 0.4);
    (shape.holes as unknown[]).push(hole);
    const geometries = [
      new (K.ExtrudeGeometry as Ctor)(shape, {
        depth: 0.2,
        bevelSegments: 2,
        curveSegments: 6,
        steps: 2,
      }),
      new (K.ShapeGeometry as Ctor)(shape, 6),
    ] as unknown as { getAttribute(name: string): { array: ArrayLike<number> } }[];
    return JSON.stringify(
      geometries.map((g) =>
        ["position", "normal", "uv"].map((n) => Array.from(g.getAttribute(n).array)),
      ),
    );
  };
  check(build(web) === build(upstream), "web shape geometries equal three's");
  check(
    new (web.ExtrudeGeometry as Ctor)() instanceof (web.BufferGeometry as Ctor),
    "extrude is a BufferGeometry",
  );
}
// The templates' check (src/render/materialAssignments.ts): a material whose hooks are three's
// defaults reads them from Material.prototype, and a game's own hook is told apart (PRD-546).
{
  type Hooks = { onBeforeCompile: unknown; customProgramCacheKey: () => unknown };
  const web = (await bindWebEngine(createTnAbi, ["MeshStandardMaterial", "Material"])) as Record<
    string,
    new () => Hooks
  >;
  const base = (web.Material as unknown as { prototype: Hooks }).prototype;
  const lit = new (web.MeshStandardMaterial as new () => Hooks)();
  check(
    lit.onBeforeCompile === base.onBeforeCompile &&
      lit.customProgramCacheKey === base.customProgramCacheKey &&
      typeof lit.customProgramCacheKey() === "string",
    "Material hooks read three's defaults",
  );
  lit.onBeforeCompile = () => {};
  check(lit.onBeforeCompile !== base.onBeforeCompile, "a game's onBeforeCompile is its own");
}
// three's CanvasTexture is the engine's own class (PRD-546): three's Texture defaults (flipped, linear,
// mipmapped) on the canvas's pixels, and a needsUpdate re-reads the canvas.
{
  const web = (await bindWebEngine(createTnAbi, ["CanvasTexture", "Texture"])) as Record<
    string,
    new (
      ...args: unknown[]
    ) => Record<string, unknown>
  >;
  let reads = 0;
  const canvas = {
    width: 2,
    height: 1,
    getContext: () => ({
      getImageData: () => {
        reads++;
        return { data: new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]), width: 2, height: 1 };
      },
    }),
  };
  const texture = new (web.CanvasTexture as new (...args: unknown[]) => Record<string, unknown>)(
    canvas,
  );
  check(
    texture.isCanvasTexture === true &&
      texture instanceof (web.Texture as new () => object) &&
      texture.generateMipmaps === true &&
      texture.flipY === true &&
      texture.magFilter === 1006 &&
      texture.minFilter === 1008 &&
      texture.image === canvas,
    "CanvasTexture carries three's Texture defaults",
  );
  texture.needsUpdate = true;
  check(reads === 2, "CanvasTexture re-reads its canvas on needsUpdate");
}
// The mixer's EventDispatcher on the Wasm engine, as on V8: listeners live in JS and the engine calls
// back for `finished` and `loop` while something listens (the minimal template's AnimationPlayer).
{
  type Fn = (...args: unknown[]) => unknown;
  type Ctor = new (
    ...args: unknown[]
  ) => {
    clipAction: Fn;
    update: Fn;
    addEventListener: Fn;
    removeEventListener: Fn;
    hasEventListener: Fn;
  };
  const web = (await bindWebEngine(createTnAbi, [
    "AnimationMixer",
    "AnimationClip",
    "VectorKeyframeTrack",
    "Object3D",
    "LoopOnce",
    "LoopRepeat",
  ])) as Record<string, unknown>;
  const root = new (web.Object3D as Ctor)();
  const track = new (web.VectorKeyframeTrack as Ctor)(".position", [0, 1], [0, 0, 0, 1, 2, 3]);
  const clip = new (web.AnimationClip as Ctor)("move", 1, [track]);
  const mixer = new (web.AnimationMixer as Ctor)(root);
  const action = mixer.clipAction(clip) as {
    setLoop(mode: unknown, repetitions: number): unknown;
    play(): unknown;
    reset(): unknown;
    clampWhenFinished: boolean;
  };
  action.setLoop(web.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const events: Record<string, unknown>[] = [];
  const onFinished = (event: Record<string, unknown>) => events.push({ ...event });
  mixer.addEventListener("finished", onFinished);
  check(mixer.hasEventListener("finished", onFinished) === true, "mixer listener registered");
  mixer.update(0.5);
  check(events.length === 0, "no finished event mid-clip");
  mixer.update(1);
  check(
    events.length === 1 &&
      events[0]?.type === "finished" &&
      events[0]?.action === action &&
      events[0]?.direction === 1 &&
      events[0]?.target === mixer,
    "finished event reaches its listener with its action and target",
  );
  mixer.removeEventListener("finished", onFinished);
  check(mixer.hasEventListener("finished", onFinished) === false, "mixer listener removed");
  const loops: unknown[] = [];
  mixer.addEventListener("loop", (event: Record<string, unknown>) => loops.push(event.loopDelta));
  action.reset();
  action.setLoop(web.LoopRepeat, Number.POSITIVE_INFINITY);
  action.play();
  mixer.update(1.25);
  check(loops.length === 1 && loops[0] === 1, "loop event");
}
// three's MathUtils is a namespace object, not a constructor: its functions are called on the export
// itself (the minimal template's Player wraps its heading with MathUtils.euclideanModulo).
{
  const web = (await bindWebEngine(createTnAbi, ["MathUtils"])) as {
    MathUtils: {
      euclideanModulo(n: number, m: number): number;
      clamp(v: number, a: number, b: number): number;
    };
  };
  check(typeof web.MathUtils === "object", "MathUtils is a namespace object");
  check(web.MathUtils.euclideanModulo(-1, 3) === 2, "MathUtils.euclideanModulo");
  check(web.MathUtils.clamp(5, 0, 1) === 1, "MathUtils.clamp");
}
// three's SkeletonUtils.clone through the engine's namespace (the minimal template's mannequin): a
// cloned skin is bound to the cloned bones, never to its source's.
{
  // biome-ignore lint/suspicious/noExplicitAny: engine objects typed as three's at runtime only
  type Obj = Record<string, any>;
  const web = (await bindWebEngine(createTnAbi, [
    "SkeletonUtils",
    "Group",
    "Bone",
    "SkinnedMesh",
    "Skeleton",
    "BoxGeometry",
    "MeshStandardMaterial",
  ])) as Record<
    "Group" | "Bone" | "SkinnedMesh" | "Skeleton" | "BoxGeometry" | "MeshStandardMaterial",
    new (
      ...args: unknown[]
    ) => Obj
  > & { SkeletonUtils: Obj };
  const root: Obj = new web.Group();
  const hip: Obj = new web.Bone();
  hip.name = "hip";
  root.add(hip);
  const mesh: Obj = new web.SkinnedMesh(new web.BoxGeometry(), new web.MeshStandardMaterial());
  mesh.name = "skin";
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new web.Skeleton([hip]));
  check(typeof web.SkeletonUtils === "object", "SkeletonUtils is a namespace object");
  const copy: Obj = web.SkeletonUtils.clone(root);
  const copyHip = copy.getObjectByName("hip");
  const copyMesh = copy.getObjectByName("skin");
  check(
    copy !== root && copyHip !== hip && copyMesh !== mesh,
    "SkeletonUtils.clone copies the hierarchy",
  );
  check(
    copyMesh.skeleton.bones[0] === copyHip && mesh.skeleton.bones[0] === hip,
    "SkeletonUtils.clone remaps the skin",
  );
}
// Reads that need no engine call (Wasm): a math field the engine holds in place (`x`, `r`, `radius`,
// `elements`) comes from its memory, and a fixed member (`position`, `matrixWorld`) is the same
// object every read. Writes still go through the engine, and memory reads see them, and see what the
// engine itself computes (updateMatrixWorld).
{
  // biome-ignore lint/suspicious/noExplicitAny: engine objects typed as three's at runtime only
  type Any = Record<string, any>;
  const web = (await bindWebEngine(createTnAbi, [
    "Object3D",
    "Vector3",
    "Sphere",
    "Color",
  ])) as Record<string, new (...args: unknown[]) => Any>;
  const object = new (web.Object3D as new () => Any)();
  const sphere = new (web.Sphere as new (...a: unknown[]) => Any)(
    new (web.Vector3 as new (...a: unknown[]) => Any)(1, 2, 3),
    4,
  );
  const colour = new (web.Color as new (...a: unknown[]) => Any)(0.25, 0.5, 0.75);
  object.position.set(1, 2, 3);
  object.updateMatrixWorld(true);
  const counts = new Map<string, number>();
  (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts = counts;
  const position = object.position;
  for (let i = 0; i < 50; i++) {
    void object.position.x;
    void object.matrixWorld.elements;
    void sphere.radius;
    void colour.g;
  }
  const reads = [...counts.values()].reduce((sum, n) => sum + n, 0);
  object.position.x = 7; // a write crosses
  object.updateMatrixWorld(true);
  (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts = undefined;
  check(object.position === position, "a fixed member is the same object every read");
  check(
    object.position.x === 7 && object.matrixWorld.elements[12] === 7,
    "memory reads see engine writes and updates",
  );
  check(
    sphere.radius === 4 && colour.g === 0.5 && sphere.center.z === 3,
    "math fields read in place",
  );
  // Each object's first read asks for its address (position, matrixWorld, its elements' owner, sphere,
  // colour) and each fixed member is fetched once; nothing per read after that.
  check(
    reads <= 8,
    `50 rounds of field reads cost ${reads} engine calls (${[...counts.keys()].join(", ")})`,
  );
}
// traverse and traverseVisible are one engine walk (`__walk`), in three's order: a frame's scene walks
// cost one crossing each, not two per object (the minimal template made 330 such calls a frame).
{
  type Node3D = Record<string, unknown> & {
    name: string;
    visible: boolean;
    add(...children: object[]): void;
    traverse(callback: (object: Node3D) => void): void;
    traverseVisible(callback: (object: Node3D) => void): void;
  };
  const web = (await bindWebEngine(createTnAbi, ["Group", "Object3D"])) as Record<
    string,
    new () => Node3D
  >;
  const made = (name: string) => {
    const node = new (web.Object3D as new () => Node3D)();
    node.name = name;
    return node;
  };
  const root = new (web.Group as new () => Node3D)();
  root.name = "root";
  const a = made("a");
  const b = made("b");
  const a1 = made("a1");
  const b1 = made("b1");
  root.add(a, b);
  a.add(a1);
  b.add(b1);
  b.visible = false;
  const counts = new Map<string, number>();
  (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts = counts;
  const order: string[] = [];
  root.traverse((object) => order.push(object.name));
  const visible: string[] = [];
  root.traverseVisible((object) => visible.push(object.name));
  (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts = undefined;
  const crossings = [...counts.values()].reduce((sum, n) => sum + n, 0);
  check(order.join() === "root,a,a1,b,b1", `traverse order: ${order.join()}`);
  check(
    visible.join() === "root,a,a1",
    `traverseVisible skips a hidden subtree: ${visible.join()}`,
  );
  // Two walks, and the callbacks read `name` (a crossing each): 2 + 8 names.
  check(
    crossings === 10,
    `two walks cost two engine calls plus the names read: ${crossings} (${[...counts.keys()].join(", ")})`,
  );
}
// three's type flags on the scene classes (PRD-540): a game, three's own code and the playtest
// bridge find lights, cameras and bones by `isLight`, `isCamera`, `isBone`, never by class.
{
  const flagged = [
    "DirectionalLight",
    "PointLight",
    "SpotLight",
    "AmbientLight",
    "HemisphereLight",
    "PerspectiveCamera",
    "OrthographicCamera",
    "Bone",
    "SkinnedMesh",
    "InstancedMesh",
    "Sprite",
    "LineSegments",
    "LOD",
    "Scene",
    "Group",
  ];
  const web = (await bindWebEngine(createTnAbi, flagged)) as Record<string, new () => object>;
  const flags = (name: string) => {
    const prototype = web[name]?.prototype as Record<string, unknown>;
    return (flag: string) => prototype[flag] === true;
  };
  for (const light of flagged.slice(0, 5))
    check(
      flags(light)("isLight") && flags(light)(`is${light}`) && flags(light)("isObject3D"),
      `${light} flags`,
    );
  for (const camera of ["PerspectiveCamera", "OrthographicCamera"])
    check(flags(camera)("isCamera") && flags(camera)(`is${camera}`), `${camera} flags`);
  for (const [name, inherited] of [
    ["SkinnedMesh", "isMesh"],
    ["InstancedMesh", "isMesh"],
    ["LineSegments", "isLine"],
  ] as const)
    check(flags(name)(`is${name}`) && flags(name)(inherited), `${name} flags`);
  for (const name of ["Bone", "Sprite", "LOD", "Scene", "Group"])
    check(flags(name)(`is${name}`), `${name} flag`);
  check(!flags("Group")("isLight") && !flags("Bone")("isMesh"), "flags stay on their own classes");
}
// three's attribute.array is the attribute's own JS typed array (PRD-540): of its scalar type, one
// per attribute, kept across Wasm memory growth; an element write is what the engine reads back
// before its next call, BufferAttribute keeps the array it is handed, and needsUpdate sends a write.
{
  let grown: TnAbiModule | undefined;
  const web = (await bindWebEngine(async () => {
    grown = await createTnAbi();
    return grown;
  }, [
    "BufferGeometry",
    "Float32BufferAttribute",
    "BufferAttribute",
    "BoxGeometry",
  ])) as unknown as typeof THREE;
  const g = new web.BufferGeometry();
  g.setAttribute(
    "position",
    new web.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0] as never, 3),
  );
  const p = g.getAttribute("position") as InstanceType<typeof THREE.BufferAttribute>;
  const a = p.array;
  a[3] = 5;
  // A kept array stays the attribute's across memory growth: grow the heap by 64 MB.
  const heap = grown as TnAbiModule;
  const before = heap.HEAPU8.buffer.byteLength;
  heap._free(heap._malloc(64 << 20));
  check(heap.HEAPU8.buffer.byteLength > before, "the heap grew");
  a[4] = 7;
  check(
    a.length === 9 && a[3] === 5 && p.getY(1) === 7,
    `a kept array survives growth: ${String(a.length)}`,
  );
  g.computeBoundingBox();
  g.translate(1, 0, 0);
  const index = new web.BoxGeometry().getIndex() as InstanceType<typeof THREE.BufferAttribute>;
  const handed = new Uint32Array([7, 8]);
  const wide = new web.BufferAttribute(handed, 1);
  wide.array[1] = 9;
  const late = new web.Float32BufferAttribute([0, 0, 0] as never, 3);
  const lateArray = late.array;
  lateArray[2] = 4;
  (late as unknown as { needsUpdate: boolean }).needsUpdate = true;
  const got = [
    a instanceof Float32Array,
    p.array === a,
    p.getX(1),
    g.boundingBox?.max.x,
    a[3],
    index.array instanceof Uint16Array,
    index.array.length,
    wide.array === handed,
    wide.getX(1),
    late.getZ(0),
    late.version,
  ].join();
  check(got === "true,true,6,6,6,true,36,true,9,4,1", `attribute arrays ${got}`);
}
// three's geometry.clone() is a deep copy of the same class, dispose() leaves the CPU data usable,
// and morphAttributes reads back the attributes it was given, on the web as on V8.
{
  const web = (await bindWebEngine(createTnAbi, [
    "BoxGeometry",
    "Float32BufferAttribute",
  ])) as unknown as typeof THREE;
  const box = new web.BoxGeometry(2, 1, 1);
  const target = new web.Float32BufferAttribute(new Float32Array(72) as never, 3);
  box.morphAttributes.position = [target];
  const copy = box.clone();
  (copy.getAttribute("position") as InstanceType<typeof THREE.BufferAttribute>).setX(0, 9);
  box.dispose();
  const morphs = box.morphAttributes as { position: unknown[]; normal: unknown[] };
  const got = [
    copy instanceof web.BoxGeometry,
    copy.type,
    copy !== box,
    (box.getAttribute("position") as InstanceType<typeof THREE.BufferAttribute>).getX(0),
    (copy.getAttribute("position") as InstanceType<typeof THREE.BufferAttribute>).getX(0),
    copy.getIndex()?.count,
    morphs.position.length,
    morphs.position[0] === target,
    morphs.normal.length,
  ].join();
  check(got === "true,BoxGeometry,true,1,9,36,1,true,0", `geometry lifecycle ${got}`);
}
// BufferGeometryUtils.mergeGeometries over the web engine's geometries equals three's over its own:
// indexed parts with groups and morph targets, the arrays' types included.
{
  // biome-ignore lint/suspicious/noExplicitAny: three's and the engine's classes, compared by value.
  type Loose = any;
  const fromCore = createRequire(path.join(import.meta.dirname, "../../core/package.json"));
  const T: Loose = await import(pathToFileURL(fromCore.resolve("three/webgpu")).href);
  const utils: Loose = await import(
    pathToFileURL(fromCore.resolve("three/addons/utils/BufferGeometryUtils.js")).href
  );
  const web: Loose = await bindWebEngine(createTnAbi, [
    "BoxGeometry",
    "SphereGeometry",
    "Float32BufferAttribute",
    "BufferAttribute",
    "BufferGeometry",
  ]);
  const parts = (K: Loose) => {
    const box = new K.BoxGeometry(1, 2, 3);
    const sphere = new K.SphereGeometry(1, 5, 4);
    for (const g of [box, sphere]) {
      const count = g.getAttribute("position").count;
      g.morphAttributes.position = [
        new K.Float32BufferAttribute(
          new Float32Array(count * 3).map((_, i) => i / 9),
          3,
        ),
      ];
    }
    return [box, sphere];
  };
  const dump = (g: Loose) =>
    JSON.stringify([
      g.index.array.constructor.name,
      ...["position", "normal", "uv"].map((n) => [
        g.getAttribute(n).array.constructor.name,
        Array.from(g.getAttribute(n).array),
      ]),
      Array.from(g.index.array),
      g.morphAttributes.position.map((a: Loose) => Array.from(a.array)),
      g.groups,
    ]);
  const ported = defineBufferGeometryUtils(web).mergeGeometries(parts(web) as never, true);
  check(
    dump(ported) === dump(utils.mergeGeometries(parts(T), true)),
    "web mergeGeometries equals three's",
  );
}
// The calls the spec read off its fake runtime, read off the real one. Each node id is numbered in
// the order it was made, from 1, as the fake numbered them, so the spec's expected values hold as written.
interface ITrace {
  readonly calls: { name: string; receiver: number | null; args: TslArgValue[] }[];
  readonly sets: string[];
  readonly uniforms: string[];
  readonly released: number[];
  readonly runtime: ITslRuntime;
  // biome-ignore lint/suspicious/noExplicitAny: smoke test calls dynamic TSL methods
  readonly tsl: Record<string, any>;
  sync(): void;
}

function traceTsl(real: ITslRuntime): ITrace {
  const calls: ITrace["calls"] = [];
  const sets: string[] = [];
  const uniforms: string[] = [];
  const released: number[] = [];
  const numbered = new Map<number, number>();
  let made = 0;
  const ordinal = (node: number): number => numbered.get(node) ?? node;
  const argument = (value: TslArgValue): TslArgValue => {
    if (value.kind === "node") return { kind: "node", node: ordinal(value.node) };
    if (value.kind === "rgb" || value.kind === "vector")
      return { kind: value.kind, numbers: [...value.numbers] };
    return value;
  };
  const runtime: ITslRuntime = {
    call(name, receiver, args) {
      calls.push({
        name,
        receiver: receiver === null ? null : ordinal(receiver),
        args: args.map(argument),
      });
      const node = real.call(name, receiver, args);
      numbered.set(node, ++made);
      return node;
    },
    release(node) {
      released.push(ordinal(node));
      real.release(node);
    },
    set(material, path, node) {
      sets.push(`${material.type}.${path}=${ordinal(node)}`);
      real.set(material, path, node);
    },
    setUniform(node, lanes) {
      uniforms.push(`${ordinal(node)}=${lanes.join(",")}`);
      real.setUniform(node, lanes);
    },
    effectParameter(node, name, value) {
      calls.push({
        name: `effect ${name}`,
        receiver: ordinal(node),
        args: value === undefined ? [] : [{ kind: "number", number: value }],
      });
      return real.effectParameter(node, name, value);
    },
    setPost: (node) => real.setPost(node),
  };
  const live = defineTsl(runtime, constClasses);
  return { calls, sets, uniforms, released, runtime, tsl: live.exports, sync: live.sync };
}

// TSL by name over the real ABI: pmremTexture's texture crosses as a handle in tn_tsl_arg_t.
check(runtime.tsl !== undefined, "the module answers TSL by name");
if (runtime.tsl !== undefined) {
  const tslInstance = defineTsl(runtime.tsl, constClasses);
  // biome-ignore lint/suspicious/noExplicitAny: smoke test calls dynamic TSL methods
  const tsl = tslInstance.exports as Record<string, any>;
  const direction = tsl.vec3?.(0, 1, 0);
  check(
    tsl.pmremTexture?.(new DataTexture(), direction, 0.5) !== undefined,
    "pmremTexture over a texture",
  );
  let refused = "";
  try {
    tsl.pmremTexture?.(new MeshStandardMaterial(), direction, 0.5);
  } catch (error) {
    refused = String(error);
  }
  check(refused.includes("pmremTexture"), `pmremTexture refuses a material: ${refused}`);
  const { Object3D } = engine.classes as unknown as typeof THREE;
  const reflector = defineReflector(tsl.reflector as never, { Object3D, PerspectiveCamera });
  const mirror = reflector({ resolutionScale: 0.5 }) as { target: unknown };
  check(mirror.target instanceof Object3D, "reflector builds its target over the real module");
  let wrong = "";
  try {
    tsl.reflector?.(new PerspectiveCamera(), new PerspectiveCamera(), 1, 1, 0, 0, 0);
  } catch (error) {
    wrong = String(error);
  }
  check(wrong.includes("reflector"), `reflector refuses a camera as its target: ${wrong}`);

  // TSL behaviors on the real Node-Wasm ABI module (PRD-540)
  // 1. builds uniform(0) and its node methods and swizzles
  const clock = tsl.uniform(0);
  const scaled = clock.mul(2);
  const swiz = scaled.x;
  check(typeof swiz[TSL_NODE] === "number", "uniform(0).mul(2).x creates a valid TSL node");

  // 2. turns three values into what TSL makes of them, and assigns graphs to node materials
  const sun = new Vector3(1, 2, 3);
  (sun as { isVector3?: boolean }).isVector3 = true;
  const sunVec = tsl.vec3(sun);
  check(typeof sunVec[TSL_NODE] === "number", "vec3(Vector3) creates a valid TSL node");
  const sea = new Texture();
  sea.name = "sea";
  const sample = tsl.texture(sea, tsl.uv());
  check(typeof sample[TSL_NODE] === "number", "texture(Texture, uv()) creates a valid TSL node");
  const namedSample = tsl.texture({ name: "scene" }, tsl.uv());
  check(
    typeof namedSample[TSL_NODE] === "number",
    "texture({ name: 'scene' }, uv()) creates a valid TSL node",
  );
  const nodeMat = new MeshBasicNodeMaterial();
  nodeMat.colorNode = sample;
  check(nodeMat.colorNode === sample, "MeshBasicNodeMaterial.colorNode setter and getter match");

  // 3. writes uniform.value through to the engine: numbers at once, edited vectors each frame
  const clk = tsl.uniform(0);
  check(clk.value === 0, "uniform(0).value initial is 0");
  clk.value = 2.5;
  check(clk.value === 2.5, "uniform.value setter updates value");
  const origin = new Vector2(1, 2);
  (origin as { isVector2?: boolean }).isVector2 = true;
  const center = tsl.uniform(origin);
  check(center.value === origin, "uniform(Vector2).value preserves vector reference");
  origin.x = 4;
  origin.y = 5;
  tslInstance.sync();
  check(center.value.x === 4 && center.value.y === 5, "uniform vector value synced");

  // 4. runs uniform onRenderUpdate/onFrameUpdate before each frame's lanes
  const ticks = tsl.uniform(0);
  let seenThis: unknown;
  let updateCalls = 0;
  ticks.onRenderUpdate(function (this: unknown, frame: { frameId: number }) {
    seenThis = this;
    updateCalls++;
    return updateCalls * 10;
  });
  const side = tsl.uniform(7);
  let frames = 0;
  side.onFrameUpdate(() => {
    frames++;
  });
  tslInstance.sync();
  tslInstance.sync();
  check(seenThis === ticks, "uniform onRenderUpdate receives node as this");
  check(ticks.value === 20, "uniform onRenderUpdate return value updates .value");
  check(side.value === 7, "uniform without return keeps its value");
  check(frames === 2, "uniform onFrameUpdate called each sync");
  let updateThrew = false;
  try {
    side.onObjectUpdate(() => 1);
  } catch (error) {
    updateThrew = /TN_TSL_UPDATE_UNSUPPORTED/.test(String(error));
  }
  check(updateThrew, "uniform onObjectUpdate is refused by name");

  // 5. reads uniformArray entries each render, caching element by index
  const ships = [new Vector4(1, 2, 3, 4), new Vector4(5, 6, 7, 8)];
  (ships[0] as { isVector4?: boolean }).isVector4 = true;
  (ships[1] as { isVector4?: boolean }).isVector4 = true;
  const array = tsl.uniformArray(ships, "vec4");
  const first = array.element(1);
  check(array.element(1) === first, "uniformArray.element caches node by index");
  (ships[0] as { x: number }).x = 9;
  tslInstance.sync();
  let arrayThrew1 = false;
  try {
    array.element(first);
  } catch (error) {
    arrayThrew1 = /TN_TSL_UNIFORM_ARRAY/.test(String(error));
  }
  check(arrayThrew1, "uniformArray.element refuses non-integer index");
  let arrayThrew2 = false;
  try {
    array.element(2);
  } catch (error) {
    arrayThrew2 = /TN_TSL_UNIFORM_ARRAY/.test(String(error));
  }
  check(arrayThrew2, "uniformArray.element refuses out-of-bounds index");

  // 6. answers every swizzle: xyzw, rgba and stpq, one to four lanes
  const v = tsl.vec3(1, 2, 3);
  for (const alias of ["xz", "zxy", "st", "bgr", "xxxx"]) {
    check(v[alias] !== undefined && typeof v[alias][TSL_NODE] === "number", `swizzle ${alias}`);
  }
  check(v.xyzwx === undefined, "invalid swizzle length is undefined");

  // 7. runs Fn, If, Else and Loop callbacks inside engine scopes
  const shade = tsl.Fn(() => {
    const acc = tsl.float(0).toVar();
    tsl.Loop(2, ({ i }: { i: { lessThan(n: number): unknown } }) => {
      const branch = tsl.If(i.lessThan(1), () => acc.assign(1));
      branch.Else(() => acc.assign(2));
    });
  });
  const built = shade();
  check(shade() === built, "Fn returns cached graph built once at definition");
  let fnThrew = false;
  try {
    tsl.Fn(() => {
      throw new Error("original");
    })();
  } catch (error) {
    fnThrew = String(error).includes("original");
  }
  check(fnThrew, "throwing callback inside Fn preserves original error");
  let ifThrew = false;
  try {
    tsl.If(tsl.float(1), () => {});
  } catch (error) {
    ifThrew = String(error).includes("statement outside Fn");
  }
  check(ifThrew, "statement outside Fn is refused");

  // 8. publishes live effect uniforms as ao(...).radius.value
  const effects = definePostEffects(tsl as never);
  const depthTexture = tsl.texture({ name: "depth" }, tsl.uv());
  const ao = effects.ao(depthTexture, undefined, undefined) as unknown as {
    radius: { value: number };
  };
  check(ao.radius?.value === 0.25, "ao radius initial value");
  ao.radius.value = 0.5;
  check(ao.radius?.value === 0.5, "ao radius updated value");

  // 9. builds screenUV once and flips it
  const screen = tsl.screenUV;
  check(tsl.screenUV === screen, "screenUV singleton instance");
  const flipped = screen.flipX();
  check(typeof flipped[TSL_NODE] === "number", "screenUV.flipX() builds a TSL node");

  // 10. refuses argument TSL has no meaning for
  let sinThrew = false;
  try {
    tsl.sin({ plain: true });
  } catch (error) {
    sinThrew = String(error).includes("TN_TSL sin: argument 0");
  }
  check(sinThrew, "sin refuses argument TSL has no meaning for");

  // The spec's call traces (PRD-540), read off the real module. Each block runs one spec test's
  // steps in the spec's order, so each expected value is the spec's own.
  {
    const t = traceTsl(runtime.tsl);
    const scaled = t.tsl.uniform(0).mul(2);
    void scaled.x;
    check(
      isDeepStrictEqual(t.calls, [
        { name: "uniform", receiver: null, args: [{ kind: "number", number: 0 }] },
        { name: "mul", receiver: 1, args: [{ kind: "number", number: 2 }] },
        { name: "swizzle:x", receiver: 2, args: [] },
      ]),
      "uniform(0).mul(2).x crosses as three calls, each on the node before it",
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const sun = new Vector3(1, 2, 3);
    (sun as { isVector3?: boolean }).isVector3 = true;
    t.tsl.vec3(sun);
    const sea = new Texture();
    sea.name = "sea";
    const sample = t.tsl.texture(sea, t.tsl.uv());
    const names = t.calls.map(({ name }) => name);
    check(names.join() === "vec3,uv,texture", `TSL calls: ${names.join()}`);
    check(
      isDeepStrictEqual(t.calls[0]?.args, [{ kind: "vector", numbers: [1, 2, 3] }]),
      "vec3(Vector3) crosses as its three lanes",
    );
    const handle = t.calls[2]?.args[0];
    check(
      handle?.kind === "handle" &&
        handle.ref.type === runtime.typeId("Texture") &&
        isDeepStrictEqual(t.calls[2]?.args[1], { kind: "node", node: 2 }),
      "an engine Texture crosses as a handle, and uv as node 2",
    );
    t.tsl.texture({ name: "scene" }, t.tsl.uv());
    check(
      isDeepStrictEqual(t.calls[4]?.args[0], { kind: "named", text: "scene" }),
      "a plain object crosses as its name",
    );
    const traced = defineBrowserClasses(registry, { ...runtime, tsl: t.runtime })
      .classes as unknown as typeof THREE;
    const material = new traced.MeshBasicNodeMaterial();
    material.colorNode = sample;
    check(
      t.sets.join() === `${runtime.typeId("MeshBasicNodeMaterial")}.colorNode=3`,
      `colorNode reaches the engine as node 3: ${t.sets.join()}`,
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const clock = t.tsl.uniform(0);
    clock.value = 2.5;
    const origin = new Vector2(0, 0);
    (origin as { isVector2?: boolean }).isVector2 = true;
    t.tsl.uniform(origin);
    origin.x = 4;
    origin.y = 5;
    t.sync();
    check(
      isDeepStrictEqual(t.uniforms, ["1=2.5", "2=4,5"]),
      `uniform lanes reach the engine: ${t.uniforms.join(" ")}`,
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const ticks = t.tsl.uniform(0);
    check(
      ticks.onRenderUpdate((frame: { frameId: number }) => frame.frameId * 10) === ticks,
      "onRenderUpdate returns its node, so calls chain",
    );
    t.tsl.uniform(7).onFrameUpdate(() => undefined);
    t.sync();
    t.sync();
    check(
      isDeepStrictEqual(t.uniforms, ["1=10", "1=20"]),
      `a render update's value reaches the engine each frame: ${t.uniforms.join(" ")}`,
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const first = new Vector4(0, 0, 0, 0);
    const second = new Vector4(0, 0, 0, 0);
    for (const ship of [first, second]) (ship as { isVector4?: boolean }).isVector4 = true;
    t.tsl.uniformArray([first, second], "vec4").element(1);
    second.x = 3;
    second.y = 4;
    second.z = 5;
    second.w = 6;
    t.sync();
    check(
      /^\d+=3,4,5,6$/.test(t.uniforms.at(-1) ?? ""),
      `an array entry's edit reaches the engine: ${t.uniforms.at(-1)}`,
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const v = t.tsl.vec3(1, 2, 3);
    for (const alias of ["xz", "zxy", "st", "bgr", "xxxx"]) {
      void v[alias];
    }
    check(
      isDeepStrictEqual(
        t.calls.map(({ name }) => name).filter((name) => name.startsWith("swizzle:")),
        ["swizzle:xz", "swizzle:zxy", "swizzle:xy", "swizzle:zyx", "swizzle:xxxx"],
      ),
      "each alias crosses as its xyzw lanes: st as xy, bgr as zyx",
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    t.tsl.Fn(() => {
      const acc = t.tsl.float(0).toVar();
      t.tsl.Loop(2, ({ i }: { i: { lessThan(n: number): unknown } }) => {
        const branch = t.tsl.If(i.lessThan(1), () => acc.assign(1));
        branch.Else(() => acc.assign(2));
      });
    });
    const names = () => t.calls.map(({ name }) => name);
    check(
      isDeepStrictEqual(names(), [
        "scope:open",
        "float",
        "toVar",
        "Loop:index",
        "scope:open",
        "lessThan",
        "scope:open",
        "assign",
        "scope:close",
        "If",
        "scope:open",
        "assign",
        "scope:close",
        "Else",
        "scope:close",
        "Loop",
        "scope:close",
      ]),
      "Fn, If, Else and Loop open and close their scopes in order",
    );
    // Each scope's handles are the engine's to hold once they cross: only Fn's graph stays with the game.
    const made = (name: string) => t.calls.flatMap((c, i) => (c.name === name ? [i + 1] : []));
    const handles = [...made("scope:open"), ...made("scope:close").slice(0, -1)];
    check(
      handles.every((handle) => t.released.includes(handle)),
      `every scope handle but Fn's graph is released: made ${handles.join()}, released ${t.released.join()}`,
    );
    t.calls.length = 0;
    let threw = "";
    try {
      t.tsl.Fn(() => {
        throw new Error("original");
      });
    } catch (error) {
      threw = String(error);
    }
    check(
      threw.includes("original") && names().join() === "scope:open,scope:close",
      `a throwing callback closes its scope: ${names().join()}`,
    );
  }
  {
    // r185's InputNode.value: a write replaces the value, the getter returns what was written, and a
    // later edit to it reaches the engine. A value of another type is refused by the engine, by name.
    const t = traceTsl(runtime.tsl);
    const flagged = <T extends object>(value: T, flag: string): T =>
      Object.assign(value, { [flag]: true });
    const offset = t.tsl.uniform(flagged(new Vector2(1, 2), "isVector2"));
    const next = flagged(new Vector2(7, 8), "isVector2");
    offset.value = next;
    check(offset.value === next, "uniform.value returns the value that was written");
    next.x = 9;
    t.sync();
    check(
      t.uniforms.at(-1)?.endsWith("=9,8") === true,
      `an edit to the written vector reaches the engine: ${t.uniforms.join(" ")}`,
    );
    let refused = "";
    try {
      offset.value = flagged(new Vector3(1, 2, 3), "isVector3");
    } catch (error) {
      refused = String(error);
    }
    check(
      refused.includes("TN_TSL_UNIFORM_VALUE") && offset.value === next,
      `a Vector3 written to a vec2 uniform is refused by name and the value stays: ${refused}`,
    );
    // r185's ConstNode.value: float(2).value is 2 and vec3(1, 2, 3).value a Vector3.
    const three = t.tsl.vec3(1, 2, 3).value;
    check(
      t.tsl.float(2).value === 2 &&
        three instanceof Vector3 &&
        three.z === 3 &&
        t.tsl.vec2(4).value?.y === 4,
      "a constant node answers its value as r185's ConstNode does",
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const effects = definePostEffects(t.tsl as never);
    // The engine refuses a bare uv() as ao's depth (TN_TSL_POST_INPUT), so the depth is a texture of uv.
    const depth = t.tsl.texture({ name: "depth" }, t.tsl.uv());
    const ao = effects.ao(depth, undefined, undefined) as unknown as { radius: { value: number } };
    check(
      isDeepStrictEqual(t.calls.at(-1), {
        name: "ao",
        receiver: null,
        args: [{ kind: "node", node: 2 }, { kind: "other" }, { kind: "other" }],
      }),
      "ao crosses with its depth node and two omitted inputs",
    );
    void ao.radius.value;
    ao.radius.value = 0.5;
    check(
      isDeepStrictEqual(
        t.calls.slice(-2).map(({ name, args }) => [name, args]),
        [
          ["effect radius", []],
          ["effect radius", [{ kind: "number", number: 0.5 }]],
        ],
      ),
      "a post effect's uniform reads and writes through the engine",
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    const sky = new DataTexture();
    t.tsl.pmremTexture(sky, t.tsl.uv(), 0.5);
    const call = t.calls[1];
    const texture = call?.args[0];
    check(
      call?.name === "pmremTexture" && call.receiver === null,
      "pmremTexture is the second call, on no receiver",
    );
    check(
      texture?.kind === "handle" && texture.ref.type === runtime.typeId("DataTexture"),
      "pmremTexture takes its texture as an engine handle",
    );
    check(
      isDeepStrictEqual(call?.args.slice(1), [
        { kind: "node", node: 1 },
        { kind: "number", number: 0.5 },
      ]),
      "uv crosses as node 1, and 0.5 as a number",
    );
  }
  {
    const t = traceTsl(runtime.tsl);
    t.tsl.screenUV.flipX();
    check(
      isDeepStrictEqual(t.calls, [
        { name: "constant:screenUV", receiver: null, args: [] },
        { name: "flipX", receiver: 1, args: [] },
      ]),
      "screenUV is built once, and flipX takes it as its receiver",
    );
  }
}
process.stdout.write("TN_BROWSER_BACKEND_OK\n");
