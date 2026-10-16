/**
 * PRD-620: three's TSL compute on the Wasm engine. `instancedArray` storage, `Fn().compute(n)` kernels
 * through `renderer.compute`, exact `getArrayBufferAsync` bytes, exact atomic counts, and a material that
 * reads what a kernel wrote. The same scenario runs on the desktop V8 player in
 * packages/runtime-native/tests/native-engine/player-compute.mjs.
 */
import {
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RenderTarget,
  Scene,
  UnsignedByteType,
} from "three";
import {
  Fn,
  If,
  atomicAdd,
  atomicLoad,
  atomicStore,
  float,
  instanceIndex,
  instancedArray,
  uint,
  uniform,
  vec3,
  vec4,
  vertexIndex,
} from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, WebGPURenderer } from "three/webgpu";

const SOFTWARE = /swiftshader|llvmpipe|lavapipe|softwarerasterizer|software adapter|basic render/iu;
const probe = {
  adapter: "",
  software: true,
  error: "",
  ticks: 0,
  done: false,
  fill: "",
  vec3: "",
  words: "",
  atomics: "",
  uniform: "",
  renderRead: "",
  disposeReuse: "",
  disposeRender: "",
  vertexRead: "",
};
const started = performance.now();

Object.assign(globalThis, {
  __THREENATIVE_PLAYTEST_BRIDGE__: {
    describe: () => ({
      name: "wasm-engine-compute",
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
      components: { "wasm-compute": { probe: { ...probe } } },
    }),
  },
});

const bytes = (buffer: ArrayBuffer, kind: "f" | "u"): string =>
  Array.from(kind === "f" ? new Float32Array(buffer) : new Uint32Array(buffer)).join(",");

try {
  const canvas = document.querySelector<HTMLCanvasElement>("#c");
  if (canvas === null) throw new Error("Missing #c canvas.");
  const renderer = new WebGPURenderer({ canvas });
  renderer.setSize(320, 180, false);
  await renderer.init();
  const info = (
    renderer as unknown as { backend: { gpu: { requestAdapter(): Promise<{ info: object }> } } }
  ).backend.gpu;
  const facts = Object.values((await info.requestAdapter()).info).join(" ");
  probe.adapter = facts;
  probe.software = SOFTWARE.test(facts) || facts.trim() === "";
  // The page ticks from here, so the scenario's first sample is taken before any kernel has been read back.
  const tick = () => {
    probe.ticks += 1;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  // The scenario's first sample comes after ready() and must still read an empty probe: the kernels start later.
  while (probe.ticks < 30)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  // Public disposal events preserve queued GPU results and CPU-seeded reuse on Wasm too.
  const lifetime = instancedArray(new Float32Array([7]), "float");
  const advance = Fn(() => {
    lifetime.element(instanceIndex).addAssign(100);
  })().compute(1);
  renderer.compute(advance);
  if (bytes(await renderer.getArrayBufferAsync(lifetime.value), "f") !== "107")
    throw new Error("dispose warmup");
  let disposals = 0;
  let lastEvent: { target?: unknown } | undefined;
  function onDispose(this: unknown, event: { target?: unknown }) {
    if (this !== lifetime.value || event.target !== lifetime.value)
      throw new Error("dispose target identity");
    disposals += 1;
    lastEvent = event;
  }
  lifetime.value.addEventListener("dispose", onDispose);
  lifetime.value.addEventListener("dispose", onDispose);
  renderer.compute(advance);
  const queuedRead = renderer.getArrayBufferAsync(lifetime.value);
  lifetime.value.dispose();
  lifetime.value.dispose();
  if (bytes(await queuedRead, "f") !== "207") throw new Error("dispose lost queued readback");
  if (Array.from(lifetime.value.array).join(",") !== "7") throw new Error("dispose lost CPU data");
  if (bytes(await renderer.getArrayBufferAsync(lifetime.value), "f") !== "7")
    throw new Error("dispose retained GPU data");
  if (disposals !== 2 || lastEvent?.target !== null)
    throw new Error("dispose event count/target cleanup");
  lifetime.value.removeEventListener("dispose", onDispose);
  lifetime.value.dispose();
  renderer.compute(advance);
  if (bytes(await renderer.getArrayBufferAsync(lifetime.value), "f") !== "107" || disposals !== 2)
    throw new Error("dispose reuse/listener removal");

  // A kernel writes 256 floats; the readback is exact. Threads past the count write nothing.
  const filled = instancedArray(256, "float");
  renderer.compute(
    Fn(() => {
      filled.element(instanceIndex).assign(float(instanceIndex).mul(3).add(1));
    })().compute(256),
  );
  const fill = new Float32Array(await renderer.getArrayBufferAsync(filled.value));
  probe.fill = `${fill.length}:${fill[0]},${fill[1]},${fill[255]}:${fill.every((v, i) => v === i * 3 + 1)}`;

  // A packed vec3 array arrives padded to WGSL's 16-byte stride; a kernel adds to it.
  const packed = instancedArray(new Float32Array([1, 2, 3, 4, 5, 6]), "vec3");
  renderer.compute(
    Fn(() => {
      packed.element(instanceIndex).assign(packed.element(instanceIndex).add(vec3(10, 20, 30)));
    })().compute(2),
  );
  probe.vec3 = bytes(await renderer.getArrayBufferAsync(packed.value), "f");

  // Dispatches run in call order, an array of nodes as written: three adds of 100 to [7, 8, 9].
  const words = instancedArray(new Uint32Array([7, 8, 9]), "uint");
  const step = Fn(() => {
    words.element(instanceIndex).assign(words.element(instanceIndex).add(uint(100)));
  })().compute(3);
  renderer.compute(step);
  renderer.compute([step, step]);
  probe.words = bytes(await renderer.getArrayBufferAsync(words.value), "u");

  // Atomics: 1000 threads count exactly, twice over, after a reset in its own dispatch.
  const counter = instancedArray(2, "uint").toAtomic();
  const reset = Fn(() => {
    atomicStore(counter.element(0), uint(0));
    atomicStore(counter.element(1), uint(0));
  })().compute(1);
  const count = Fn(() => {
    If(instanceIndex.mod(uint(3)).equal(uint(0)), () => {
      atomicAdd(counter.element(0), uint(1));
    });
    atomicAdd(counter.element(1), uint(1));
  })();
  const seen = instancedArray(2, "uint");
  const rounds: string[] = [];
  for (let round = 0; round < 2; round += 1) {
    renderer.compute(reset);
    renderer.compute(count.compute(1000));
    rounds.push(bytes(await renderer.getArrayBufferAsync(counter.value), "u"));
    // atomicLoad reads the settled counts into plain storage.
    renderer.compute(
      Fn(() => {
        seen.element(0).assign(atomicLoad(counter.element(0)));
        seen.element(1).assign(atomicLoad(counter.element(1)));
      })().compute(1),
    );
    rounds.push(bytes(await renderer.getArrayBufferAsync(seen.value), "u"));
  }
  probe.atomics = rounds.join("|");

  // A uniform is read at the call: each queued dispatch keeps the value it was called with.
  const scale = uniform(2);
  const scaled = instancedArray(4, "float");
  const scale4 = Fn(() => {
    scaled.element(instanceIndex).addAssign(float(instanceIndex).mul(scale));
  })().compute(4);
  renderer.compute(scale4);
  scale.value = 5;
  renderer.compute(scale4);
  probe.uniform = bytes(await renderer.getArrayBufferAsync(scaled.value), "f");

  // A fragment reads what a kernel wrote in the same submission.
  const colour = instancedArray(new Float32Array([0, 0, 0, 0]), "vec4");
  const material = new MeshBasicNodeMaterial();
  material.colorNode = colour.element(0);
  const target = new RenderTarget(4, 4, { type: UnsignedByteType });
  renderer.compute(
    Fn(() => {
      colour.element(0).assign(vec4(0.25, 0.5, 0.75, 1));
    })().compute(1),
  );
  renderer.setRenderTarget(target);
  new QuadMesh(material).render(renderer);
  renderer.setRenderTarget(null);
  probe.renderRead = Array.from(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1),
  ).join(",");

  // The starter's scene transition (PRD-620 phase 3): the old scene's storage is disposed on
  // teardown, and the rebuilt scene draws its own storage. The disposed attribute's GPU copy is
  // dropped; the old program that reads it stays cached and is rebound for the rebuilt frame, so
  // its binding must resolve a live buffer, never the destroyed one.
  colour.value.dispose();
  // Reusing the SAME cached material and storage attribute after dispose: a kernel reseeds the
  // disposed attribute, then the original material draws it again. Its cached program must resolve
  // the live reseeded buffer, never the destroyed one; the reseed value is distinct from before.
  renderer.compute(
    Fn(() => {
      colour.element(0).assign(vec4(0.125, 0.5, 0.875, 1));
    })().compute(1),
  );
  renderer.setRenderTarget(target);
  new QuadMesh(material).render(renderer);
  renderer.setRenderTarget(null);
  probe.disposeReuse = Array.from(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1),
  ).join(",");
  colour.value.dispose();
  const replacement = instancedArray(new Float32Array([0, 0, 0, 0]), "vec4");
  const replacementMaterial = new MeshBasicNodeMaterial();
  replacementMaterial.colorNode = replacement.element(0);
  renderer.compute(
    Fn(() => {
      replacement.element(0).assign(vec4(0.5, 0.25, 0.125, 1));
    })().compute(1),
  );
  renderer.setRenderTarget(target);
  new QuadMesh(replacementMaterial).render(renderer);
  renderer.setRenderTarget(null);
  probe.disposeRender = Array.from(
    await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1),
  ).join(",");

  // A vertex shader reads it too: a plane's corners come from padded vec3 storage by vertexIndex and
  // cover the left half of an 8x2 target.
  const corners = instancedArray(4, "vec3");
  renderer.compute(
    Fn(() => {
      const x = float(instanceIndex.mod(uint(2))).sub(1);
      const y = float(instanceIndex.div(uint(2)))
        .mul(2)
        .sub(1);
      corners.element(instanceIndex).assign(vec3(x, y, 0));
    })().compute(4),
  );
  const half = new MeshBasicNodeMaterial();
  half.colorNode = vec4(1, 0, 0, 1);
  half.side = 2; // DoubleSide: the kernel lays the corners out mirrored, so the winding flips
  half.positionNode = corners.element(vertexIndex);
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(2, 2), half));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  camera.updateMatrixWorld(true);
  const wide = new RenderTarget(8, 2, { type: UnsignedByteType });
  renderer.setRenderTarget(wide);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const row = await renderer.readRenderTargetPixelsAsync(wide, 0, 0, 8, 1);
  probe.vertexRead = Array.from({ length: 8 }, (_, i) => row[i * 4]).join(",");

  // The engine's renderer drops an attribute's GPU copy; upstream's typings do not declare it.
  (renderer as unknown as { deleteAttribute(attribute: unknown): void }).deleteAttribute(
    filled.value,
  );
  probe.done = true;
} catch (error) {
  probe.error = error instanceof Error ? error.message : String(error);
}
