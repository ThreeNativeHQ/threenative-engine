/**
 * PRD-861/PRD-867: a KTX2 model draws on the Wasm engine. three's GLTFLoader (the engine's own glTF
 * loader here) reads `ktx2-textured.glb`: one triangle (0,0)-(1,0)-(0,1) whose UVs equal its
 * positions, an ETC1S red base colour map and a UASTC green emissive map, transcoded to the device's
 * block format. Each map draws over the triangle into an 8x8 target and two texels are read back:
 * the right-angle corner (inside, the map's colour) and the opposite corner (outside, the blue clear).
 * The canvas shows both maps side by side, and the triangle's UVs as red/green, for the screenshot.
 */
import {
  Color,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  OrthographicCamera,
  RenderTarget,
  Scene,
  type Texture,
  UnsignedByteType,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { texture, uv, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial, WebGPURenderer } from "three/webgpu";
import model from "../../../packages/runtime-native/tests/native-engine/assets/ktx2-textured.glb?url";

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;
const probe = {
  adapter: "",
  software: true,
  error: "",
  ticks: 0,
  done: false,
  baseInside: "",
  baseOutside: "",
  emissiveInside: "",
  emissiveOutside: "",
  /** The engine's TN_TEXTURE_TRANSCODE_TARGET line: which format the KTX2 images took. */
  transcodeTarget: "",
};
// The engine writes it to stdout, which the web build routes to console.log.
const log = console.log.bind(console);
console.log = (...args: unknown[]) => {
  const line = args.join(" ");
  if (line.startsWith("TN_TEXTURE_TRANSCODE_TARGET")) probe.transcodeTarget = line;
  log(...args);
};
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-ktx2-model",
      protocolVersion: 1,
      capabilities: ["runtime.components", "runtime.fixedStep"],
      limits: {
        maxEntitiesPerSample: 100,
        maxEventsPerDrain: 1000,
        maxPayloadBytes: 1000000,
        operationTimeoutMs: 5000,
      },
    }),
    ready: async () => {
      while (probe.ticks < 1 && probe.error === "")
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { ready: true };
    },
    advance: async (count: number) => {
      const target = probe.ticks + count;
      while (probe.ticks < target && probe.error === "")
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { clock: { mode: "fixed-step", tick: probe.ticks }, ticks: count };
    },
    sample: () => ({
      clock: { mode: "fixed-step", tick: probe.ticks, timeMs: performance.now() - started },
      components: { "wasm-ktx2-model": { probe: { ...probe } } },
    }),
  },
});

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (canvas === null) throw new Error("Missing #c canvas.");
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(640, 320, false);
  renderer.setClearColor(new Color(0, 0, 1), 1);
  await renderer.init();
  const gpu = (
    renderer as unknown as { backend: { gpu: { requestAdapter(): Promise<{ info: object }> } } }
  ).backend.gpu;
  const facts = Object.values((await gpu.requestAdapter()).info).join(" ");
  probe.adapter = facts;
  probe.software = SOFTWARE.test(facts) || facts.trim() === "";
  const tick = () => {
    probe.ticks += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // After the playtest's baseline sample, so every result below is the scenario's own.
  while (probe.ticks < 20)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const gltf = await new GLTFLoader().loadAsync(model);
  let mesh: Mesh | undefined;
  gltf.scene.traverse((object: Object3D) => {
    if ((object as Mesh).isMesh === true) mesh = object as Mesh;
  });
  if (mesh === undefined) throw new Error("The model has no mesh.");
  const triangle: Mesh = mesh;
  const loaded = triangle.material as MeshStandardMaterial;
  if (loaded.map === null || loaded.emissiveMap === null)
    throw new Error("The model's base colour or emissive map did not load.");
  const flat = (map: Texture): MeshBasicNodeMaterial => {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = texture(map, uv());
    return material;
  };
  const base = flat(loaded.map);
  const emissive = flat(loaded.emissiveMap);

  // The triangle fills x + y < 1 of [0,1]^2; readback rows run top down, so (0,7) is the corner at
  // uv (0,0) and (7,0) the one at uv (1,1).
  const scene = new Scene();
  scene.add(gltf.scene);
  const square = new OrthographicCamera(0, 1, 1, 0, -1, 1);
  const read = async (material: MeshBasicNodeMaterial): Promise<[string, string]> => {
    triangle.material = material;
    const target = new RenderTarget(8, 8, { type: UnsignedByteType });
    renderer.setRenderTarget(target);
    renderer.render(scene, square);
    renderer.setRenderTarget(null);
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, 8, 8);
    const at = (x: number, y: number) =>
      Array.from(pixels.slice((y * 8 + x) * 4, (y * 8 + x) * 4 + 4)).join(",");
    return [at(0, 7), at(7, 0)];
  };
  [probe.baseInside, probe.baseOutside] = await read(base);
  [probe.emissiveInside, probe.emissiveOutside] = await read(emissive);

  // The screenshot: the base colour map, the emissive map, then the UVs (u red, v green), whose
  // gradient also gives the capture more than the three flat colours of the maps and the clear.
  const right = triangle.clone();
  right.material = emissive;
  right.position.x = 1.2;
  triangle.material = base;
  scene.add(right);
  const uvs = triangle.clone();
  const gradient = new MeshBasicNodeMaterial();
  gradient.colorNode = vec4(uv(), 0, 1);
  uvs.material = gradient;
  uvs.position.x = 2.4;
  scene.add(uvs);
  const wide = new OrthographicCamera(-0.1, 3.5, 1.4, -0.4, -1, 1);
  const frame = () => {
    renderer.render(scene, wide);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  probe.done = true;
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
