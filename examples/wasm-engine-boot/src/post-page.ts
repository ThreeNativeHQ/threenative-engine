/**
 * PRD-540 phase 3: the `minimal` template's post chain on the Wasm engine, through three's own API:
 * `pass` with an MRT normal, GTAO with its denoise, bloom, a vignette and SMAA under the reversible
 * Karis squeeze, composed in a `RenderPipeline`. A bright box on black is the subject: bloom is the
 * only stage that lights the ring of pixels around it, so the scenario reads the chain in pixels.
 */
import { BoxGeometry, Mesh, PerspectiveCamera, PlaneGeometry, Scene } from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { denoise } from "three/addons/tsl/display/DenoiseNode.js";
import { ao } from "three/addons/tsl/display/GTAONode.js";
import { smaa } from "three/addons/tsl/display/SMAANode.js";
import {
  float,
  length,
  max,
  mrt,
  normalView,
  output,
  pass,
  screenUV,
  smoothstep,
  sub,
  vec2,
  vec4,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  RenderPipeline,
  WebGPURenderer,
} from "three/webgpu";

const probe = {
  frames: 0,
  ticks: 0,
  error: "",
  draws: 0,
  /** Setup work added after frame 10 (see renderer-page.ts); -1 until frame 10 has drawn. */
  steadyCompiles: -1,
  steadyTextKeys: -1,
  steadyBindGroups: -1,
  steadyGraphKeys: -1,
  steadyPrograms: -1,
};
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-post",
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
      while (probe.frames < 1 && probe.error === "")
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
      components: { "wasm-post": { probe: { ...probe } } },
    }),
  },
});

type EngineCounters = Record<
  "compiles" | "textLookups" | "bindGroups" | "graphKeys" | "programs",
  number
>;

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (canvas === null) throw new Error("Missing #c canvas.");
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(640, 360, false);
  await renderer.init();
  renderer.setClearColor(0x000000, 1);

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 640 / 360, 0.1, 50);
  camera.position.set(0, 0, 6);
  camera.lookAt(0, 0, 0);
  // HDR emissive (4x white): above bloom's threshold, so the glow spreads past the silhouette.
  const glow = new MeshBasicNodeMaterial();
  glow.colorNode = vec4(4, 4, 4, 1);
  // Large enough that the frame is not "blank" to the capture guard (5% bright) without bloom.
  const box = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), glow);
  box.rotation.set(0.4, 0.6, 0);
  // A dark floor behind it gives GTAO depth and normals to read; it stays far below `nonblank`.
  const floor = new Mesh(
    new PlaneGeometry(40, 40),
    new MeshStandardNodeMaterial({ color: 0x000000 }),
  );
  floor.position.z = -3;
  scene.add(box, floor);

  const scenePass = pass(scene, camera);
  scenePass.setMRT(mrt({ output, normal: normalView }));
  const colour = scenePass.getTextureNode("output");
  const depth = scenePass.getTextureNode("depth");
  const normal = scenePass.getTextureNode("normal");
  const contact = ao(depth, normal, camera);
  contact.radius.value = 0.35;
  // three's typings give the effect nodes no swizzles; the template casts them the same way.
  type ChainNode = typeof colour;
  const occlusion = denoise(
    contact.getTextureNode(),
    depth,
    normal,
    camera,
  ) as unknown as ChainNode;
  const occluded = colour.mul(occlusion.r);
  const lit = occluded.add(bloom(occluded, 1, 0.6, 0.5));
  const vignette = sub(
    float(1),
    smoothstep(float(0.55), float(1.02), length(screenUV.sub(vec2(0.5)).mul(2))).mul(0.3),
  );
  const graded = lit.mul(vignette);
  // SMAA under the reversible Karis squeeze, as the template runs it last.
  const rgbMax = (c: typeof graded) => max(c.r, max(c.g, c.b));
  const squeezed = graded.div(rgbMax(graded).add(1));
  const filtered = smaa(squeezed) as unknown as ChainNode;
  const pipeline = new RenderPipeline(renderer);
  pipeline.outputNode = filtered.div(max(sub(float(1), rgbMax(filtered)), float(1e-4)));

  let baseline: EngineCounters | undefined;
  const frame = () => {
    probe.ticks += 1;
    box.rotation.y += 0.01;
    try {
      pipeline.render();
      probe.frames += 1;
      probe.draws = renderer.info.render.drawCalls;
      const engine = (renderer.info as unknown as { engine: EngineCounters }).engine;
      if (probe.frames === 10) baseline = { ...engine };
      if (baseline !== undefined) {
        probe.steadyCompiles = engine.compiles - baseline.compiles;
        probe.steadyTextKeys = engine.textLookups - baseline.textLookups;
        probe.steadyBindGroups = engine.bindGroups - baseline.bindGroups;
        probe.steadyGraphKeys = engine.graphKeys - baseline.graphKeys;
        probe.steadyPrograms = engine.programs - baseline.programs;
      }
      requestAnimationFrame(frame);
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
  };
  requestAnimationFrame(frame);
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
