/**
 * Screen-space GI on the Wasm engine, through three's own API: `pass` with an MRT that asks for the normal
 * and the diffuse colour, `ssgi(beauty, depth, normal, camera)`, and the example's compose
 * `beauty + diffuseColor * gi`. A white floor with no light but a faint ambient is dark; a glowing box
 * stands on it. Only the gather can light the floor beside the box, so the scenario reads it in pixels:
 * the floor next to the box is not dark, the floor far from it still is.
 */
import { BoxGeometry, Mesh, PerspectiveCamera, PlaneGeometry, Scene } from "three";
import { ssgi } from "three/addons/tsl/display/SSGINode.js";
import { convertToTexture, diffuseColor, mrt, normalView, output, pass, vec4 } from "three/tsl";
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  RenderPipeline,
  WebGPURenderer,
} from "three/webgpu";

const probe = { frames: 0, ticks: 0, error: "", draws: 0, hits: -1 };
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-ssgi",
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
      components: { "wasm-ssgi": { probe: { ...probe } } },
    }),
  },
});

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (canvas === null) throw new Error("Missing #c canvas.");
  // `?gi=0` draws the same scene without the gather: the scenario's red arm.
  const withGi = new URLSearchParams(location.search).get("gi") !== "0";
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(640, 360, false);
  await renderer.init();
  renderer.setClearColor(0x000000, 1);

  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 640 / 360, 0.1, 80);
  camera.position.set(0, 3.2, 9);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  // The only thing in the frame that emits: HDR white, 4x. `?unlit=1` makes it an unlit material instead, which
  // the normal and albedo passes skip: the gather must still light the floor from it and leave it untouched.
  const glow =
    new URLSearchParams(location.search).get("unlit") === "1"
      ? new MeshBasicNodeMaterial()
      : new MeshStandardNodeMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 4 });
  if (glow instanceof MeshBasicNodeMaterial) glow.colorNode = vec4(4, 4, 4, 1);
  const box = new Mesh(new BoxGeometry(1.5, 1.5, 1.5), glow);
  box.position.set(-3, 0.75, 0);
  // A white floor with no lights in the scene: black, but for what the gather brings.
  const floor = new Mesh(
    new PlaneGeometry(40, 40),
    new MeshStandardNodeMaterial({ color: 0xffffff, roughness: 1 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(box, floor);

  const scenePass = pass(scene, camera);
  scenePass.setMRT(
    new URLSearchParams(location.search).get("nodiffuse") === "1"
      ? mrt({ output, normal: normalView })
      : mrt({ output, normal: normalView, diffuseColor }),
  );
  const colour = scenePass.getTextureNode("output");
  const depth = scenePass.getTextureNode("depth");
  const normal = scenePass.getTextureNode("normal");
  const noDiffuse = new URLSearchParams(location.search).get("nodiffuse") === "1";
  const albedo = noDiffuse ? colour : scenePass.getTextureNode("diffuseColor");
  type ChainNode = typeof colour;
  const pipeline = new RenderPipeline(renderer);
  if (withGi) {
    const gi = (ssgi as unknown as (...args: unknown[]) => ChainNode & Record<string, never>)(
      colour,
      depth,
      normal,
      camera,
    ) as unknown as { radius: { value: number }; getGINode(): ChainNode };
    gi.radius.value = 6;
    // The albedo target is bound for the chain's passes, so the compose is a pass of its own.
    pipeline.outputNode = convertToTexture(colour.add(vec4(albedo.rgb.mul(gi.getGINode().rgb), 0)));
    const show = new URLSearchParams(location.search).get("show");
    if (show === "gi") pipeline.outputNode = vec4(gi.getGINode().rgb.mul(4), 1);
    if (show === "hits") pipeline.outputNode = vec4(gi.getGINode().a, 0, 0, 1);
    // A named target is only bound for a pass of the chain, so each debug view goes through its own.
    if (show === "albedo") pipeline.outputNode = convertToTexture(vec4(albedo.rgb, 1));
    if (show === "albedoA")
      pipeline.outputNode = convertToTexture(vec4(albedo.a, albedo.a, albedo.a, 1));
    if (show === "depth")
      pipeline.outputNode = convertToTexture(vec4(depth.r, depth.r, depth.r, 1));
    if (show === "normal")
      pipeline.outputNode = convertToTexture(vec4(normal.rgb.mul(0.5).add(0.5), 1));
  } else pipeline.outputNode = colour;

  const frame = () => {
    probe.ticks += 1;
    try {
      pipeline.render();
      probe.frames += 1;
      probe.draws = renderer.info.render.drawCalls;
      requestAnimationFrame(frame);
    } catch (error) {
      probe.error = error instanceof Error ? error.message : String(error);
    }
  };
  requestAnimationFrame(frame);
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
