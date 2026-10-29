/**
 * PRD-762: three's `DataArrayTexture` on the Wasm engine. Three solid layers (red, green, blue) with a
 * full mip chain per layer, read through TSL `texture(array, uv).depth(layer)` into a render target:
 * a constant layer, a layer picked per pixel, the default layer 0 and a coarse mip of the last layer.
 * Then core's `stackLayers` writes two 2D textures into the layers of an array on the GPU: initTexture
 * with `source.dataReady = false`, and one copyTextureToTexture per source into layer z.
 */
import {
  DataArrayTexture,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  NoColorSpace,
  RGBAFormat,
  RenderTarget,
  UnsignedByteType,
} from "three";
import { float, int, texture, uv } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";
import { stackLayers } from "../../../packages/core/src/world-terrain-splat.js";

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;
const probe = {
  adapter: "",
  software: true,
  error: "",
  ticks: 0,
  done: false,
  flags: "",
  constant: "",
  perPixel: "",
  defaultLayer: "",
  coarseMip: "",
  copied0: "",
  copied1: "",
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
      components: { "wasm-array": { probe: { ...probe } } },
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

  // Draw after the scenario's first sample, so every probe is a change the scenario sees.
  while (probe.ticks < 20)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  // 4x4 layers, one solid colour each: layer 0 red, 1 green, 2 blue.
  const colours = [
    [255, 0, 0, 255],
    [0, 255, 0, 255],
    [0, 0, 255, 255],
  ] as const;
  const bytes = new Uint8Array(4 * 4 * colours.length * 4);
  colours.forEach((rgba, layer) => {
    for (let texel = 0; texel < 16; texel += 1) bytes.set(rgba, (layer * 16 + texel) * 4);
  });
  const array = new DataArrayTexture(bytes, 4, 4, colours.length);
  array.format = RGBAFormat;
  array.type = UnsignedByteType;
  array.colorSpace = NoColorSpace;
  array.magFilter = LinearFilter;
  array.minFilter = LinearMipmapLinearFilter;
  array.generateMipmaps = true;
  array.needsUpdate = true;
  probe.flags = [array.isDataArrayTexture, array.isArrayTexture].join(",");

  const draw = async (colorNode: unknown, width: number): Promise<string> => {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = colorNode as MeshBasicNodeMaterial["colorNode"];
    const target = new RenderTarget(width, 1, { type: UnsignedByteType });
    renderer.setRenderTarget(target);
    new QuadMesh(material).render(renderer);
    renderer.setRenderTarget(null);
    return Array.from(await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, 1)).join(",");
  };
  probe.constant = await draw(texture(array, uv()).depth(int(1)), 1);
  // The layer is a node, not a constant: pixel centres at 1/6, 3/6 and 5/6 pick layers 0, 1 and 2.
  probe.perPixel = await draw(texture(array, uv()).depth(int(uv().x.mul(3).floor())), 3);
  probe.defaultLayer = await draw(texture(array, uv()), 1);
  // Mip 2 of a 4x4 layer is one texel: it is only blue when layer 2 has its own mip chain.
  probe.coarseMip = await draw(texture(array, uv()).depth(int(2)).level(float(2)), 1);

  // Two 2D textures, red and green, copied into the layers of an array that holds no CPU texels.
  const solid = (rgba: readonly number[]) => {
    const data = new Uint8Array(4 * 4 * 4);
    for (let texel = 0; texel < 16; texel += 1) data.set(rgba, texel * 4);
    const map = new DataTexture(data, 4, 4, RGBAFormat, UnsignedByteType);
    map.colorSpace = NoColorSpace;
    map.needsUpdate = true;
    return map;
  };
  const maps = [solid(colours[0]), solid(colours[1])];
  // Core's own stacking (world-terrain-splat.ts), through the renderer's initTexture and copyTextureToTexture.
  const stacked = stackLayers(maps, { raw: renderer } as unknown as Parameters<
    typeof stackLayers
  >[1]);
  if (stacked === undefined)
    throw new Error("stackLayers returned undefined: no GPU stacking on this engine.");
  probe.copied0 = await draw(texture(stacked, uv()).depth(int(0)), 1);
  probe.copied1 = await draw(texture(stacked, uv()).depth(int(1)), 1);
  probe.done = true;
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
