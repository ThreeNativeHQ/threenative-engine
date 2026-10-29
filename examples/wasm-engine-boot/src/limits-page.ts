/**
 * PRD-762: the Wasm host asks for the adapter's own device limits, as the desktop host does. A default device
 * caps a 2D texture at 8192 texels, and an adapter such as the RTX 2080 allows 32768; so does it for a
 * fragment stage's sampled textures (16 by default, 48 on that adapter). A 9000 x 1 render target is drawn with
 * a uv ramp and read at its last texel: red 255 where the device allows it, nothing where it does not. Then one
 * fragment reads 17 textures of one sampler state: more than 16 samplers, so the program shares them.
 */
import {
  DataTexture,
  NearestFilter,
  NoColorSpace,
  RGBAFormat,
  RenderTarget,
  UnsignedByteType,
} from "three";
import { texture, uv, vec4 } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;
const probe = {
  adapter: "",
  software: true,
  error: "",
  ticks: 0,
  done: false,
  last: "",
  sum: "",
};
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-array",
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
      components: { "wasm-limits": { probe: { ...probe } } },
    }),
  },
});

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (canvas === null) throw new Error("Missing #c canvas.");
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(320, 180, false);
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

  // Draw after the scenario's first sample, so the pixel is a change the scenario sees.
  while (probe.ticks < 20)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const width = 9000;
  const material = new MeshBasicNodeMaterial();
  material.colorNode = vec4(uv().x, 0, 0, 1);
  const target = new RenderTarget(width, 1, { type: UnsignedByteType });
  renderer.setRenderTarget(target);
  new QuadMesh(material).render(renderer);
  renderer.setRenderTarget(null);
  probe.last = Array.from(
    await renderer.readRenderTargetPixelsAsync(target, width - 1, 0, 1, 1),
  ).join(",");

  // 17 textures with one sampler state in one fragment: past 16 samplers, equal ones share a binding. Texture i
  // holds red i + 1, so the sum is (1 + ... + 17) / 255 = 153 / 255.
  const reads = [];
  for (let i = 0; i < 17; i += 1) {
    const data = new DataTexture(
      new Uint8Array([i + 1, 0, 0, 255]),
      1,
      1,
      RGBAFormat,
      UnsignedByteType,
    );
    data.colorSpace = NoColorSpace;
    data.magFilter = NearestFilter;
    data.minFilter = NearestFilter;
    data.needsUpdate = true;
    reads.push(texture(data, uv()).r);
  }
  const summed = new MeshBasicNodeMaterial();
  summed.colorNode = vec4(
    reads.reduce((a, b) => a.add(b)),
    0,
    0,
    1,
  );
  const one = new RenderTarget(1, 1, { type: UnsignedByteType });
  renderer.setRenderTarget(one);
  new QuadMesh(summed).render(renderer);
  renderer.setRenderTarget(null);
  probe.sum = Array.from(await renderer.readRenderTargetPixelsAsync(one, 0, 0, 1, 1)).join(",");
  probe.done = true;
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
