/**
 * PRD-867: compressed textures on the Wasm engine. three's KTX2Loader asks the renderer which block
 * formats it takes (`detectSupport` reads `hasFeature`), transcodes a red ETC1S KTX2 to BC7 and hands
 * back a CompressedTexture, which draws red. Then a streamed texture: a CompressedTexture whose level 0
 * is not resident draws its coarse level (one all-zero BC7 block: transparent black), and once level 0
 * arrives with `needsUpdate`, the same texture draws red.
 */
import {
  CompressedTexture,
  LoadingManager,
  NearestFilter,
  NoColorSpace,
  RGBA_BPTC_Format,
  RenderTarget,
  UnsignedByteType,
} from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import transcoderJs from "three/examples/jsm/libs/basis/basis_transcoder.js?url";
import transcoderWasm from "three/examples/jsm/libs/basis/basis_transcoder.wasm?url";
import { texture, uv } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";
import redKtx2 from "./red-etc1s.ktx2?url";

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;
const probe = {
  adapter: "",
  software: true,
  error: "",
  ticks: 0,
  done: false,
  bptcSupported: false,
  loadedFormat: 0,
  loaded: "",
  coarse: "",
  streamed: "",
};
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-compressed",
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
      components: { "wasm-compressed": { probe: { ...probe } } },
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
  while (probe.ticks < 20)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const draw = async (map: CompressedTexture): Promise<string> => {
    const material = new MeshBasicNodeMaterial();
    material.colorNode = texture(map, uv());
    // 8x8 pixels over the 8x8 texture: level 0's footprint, so a resident level 0 is the one sampled.
    const target = new RenderTarget(8, 8, { type: UnsignedByteType });
    renderer.setRenderTarget(target);
    new QuadMesh(material).render(renderer);
    renderer.setRenderTarget(null);
    return Array.from(await renderer.readRenderTargetPixelsAsync(target, 4, 4, 1, 1)).join(",");
  };

  // The transcoder files by their built URLs: KTX2Loader asks for them by fixed name.
  const manager = new LoadingManager();
  manager.setURLModifier((url) =>
    url.endsWith("basis_transcoder.js")
      ? transcoderJs
      : url.endsWith("basis_transcoder.wasm")
        ? transcoderWasm
        : url,
  );
  const loader = new KTX2Loader(manager).setTranscoderPath("/basis/").detectSupport(renderer);
  probe.bptcSupported =
    (loader as unknown as { workerConfig: { bptcSupported: boolean } }).workerConfig
      .bptcSupported === true;
  const loaded = (await loader.loadAsync(redKtx2)) as CompressedTexture;
  probe.loadedFormat = loaded.format;
  probe.loaded = await draw(loaded);

  // A stream: level 0 arrives after the coarse level drew. The finer blocks are the loaded red ones.
  const fine = (loaded.mipmaps[0] as { data: Uint8Array }).data;
  const mipmaps = [
    { data: null as Uint8Array | null, width: 8, height: 8 },
    { data: new Uint8Array(16), width: 4, height: 4 },
  ];
  const streamed = new CompressedTexture(mipmaps as unknown as ImageData[], 8, 8, RGBA_BPTC_Format);
  streamed.colorSpace = NoColorSpace;
  streamed.minFilter = NearestFilter;
  streamed.magFilter = NearestFilter;
  streamed.needsUpdate = true;
  probe.coarse = await draw(streamed);
  (mipmaps[0] as { data: Uint8Array | null }).data = fine;
  streamed.needsUpdate = true;
  probe.streamed = await draw(streamed);
  loader.dispose();
  probe.done = true;
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
