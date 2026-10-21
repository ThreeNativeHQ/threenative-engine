// PRD-620 on the V8 player: three's TSL compute through the facade and the real player (headless GPU).
// instancedArray builds storage, `Fn().compute(n)` kernels run through renderer.compute in call order,
// renderer.getArrayBufferAsync returns the written bytes exactly, atomics count exactly (a thread past
// the dispatch count writes nothing), and a render material reads what a kernel wrote in the same frame.
import assert from "node:assert/strict";
import { runComputeGame } from "./compute-harness.mjs";

const executable = process.argv[2];
assert(executable, "Usage: player-compute.mjs <tn-native-engine-player-v8>");

const { verdict, output } = await runComputeGame(executable, `
import { DoubleSide, Mesh, OrthographicCamera, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, HalfFloatType, RGBAFormat, UnsignedByteType } from "three";
import { Fn, If, atomicAdd, atomicLoad, atomicStore, float, instanceIndex, instancedArray, uint, uniform, uvec2, vec2, texture, textureStore, storageTexture, vec3, vec4, vertexIndex } from "three/tsl";
import { MeshBasicNodeMaterial, QuadMesh, StorageTexture, WebGPURenderer } from "three/webgpu";

const faults = [];
const same = (label, got, want) => {
  const a = Array.from(got), b = Array.from(want);
  if (a.length !== b.length || a.some((value, i) => value !== b[i])) faults.push(label + " got [" + a.slice(0, 12) + "] want [" + b.slice(0, 12) + "]");
};
let started = false;
const waiting = [];
const frames = (n) => new Promise((done) => waiting.push({ left: n, done }));
globalThis.tn.onFrame(() => {
  for (const wait of waiting.splice(0)) { wait.left -= 1; if (wait.left <= 0) wait.done(); else waiting.push(wait); }
});
globalThis.tn.onUpdate(() => {
  if (started) return;
  started = true;
  globalThis.tn.scene = new Scene();
  globalThis.tn.camera = new PerspectiveCamera();
  run().then(
    () => globalThis.tn.log(faults.length === 0 ? "COMPUTE_OK" : "COMPUTE_BAD " + faults.join(" | ")),
    (error) => globalThis.tn.log("COMPUTE_ERROR " + (error && (error.message + " @@ " + String(error.stack).split(String.fromCharCode(10)).join(" | ")) || error)),
  );
});

async function run() {
  const renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 } });

  // Disposal observes every event but releases GPU storage after already queued work/readbacks.
  const lifetime = instancedArray(new Float32Array([7]), "float");
  const advance = Fn(() => { lifetime.element(instanceIndex).addAssign(100); })().compute(1);
  renderer.compute(advance);
  same("dispose warm", new Float32Array(await renderer.getArrayBufferAsync(lifetime.value)), [107]);
  let disposals = 0, lastEvent;
  function onDispose(event) {
    if (this !== lifetime.value || event.target !== lifetime.value) faults.push("dispose target identity");
    disposals += 1;
    lastEvent = event;
  }
  lifetime.value.addEventListener("dispose", onDispose);
  lifetime.value.addEventListener("dispose", onDispose);
  renderer.compute(advance);
  const queuedRead = renderer.getArrayBufferAsync(lifetime.value);
  lifetime.value.dispose();
  lifetime.value.dispose();
  same("dispose queued read", new Float32Array(await queuedRead), [207]);
  same("dispose CPU retained", lifetime.value.array, [7]);
  same("dispose GPU released", new Float32Array(await renderer.getArrayBufferAsync(lifetime.value)), [7]);
  if (disposals !== 2 || lastEvent.target !== null) faults.push("dispose event count/clear " + disposals);
  lifetime.value.removeEventListener("dispose", onDispose);
  lifetime.value.dispose();
  renderer.compute(advance);
  same("dispose reuse", new Float32Array(await renderer.getArrayBufferAsync(lifetime.value)), [107]);
  if (disposals !== 2) faults.push("dispose listener removal");

  // Storage: a count, a packed vec3 typed array (three pads it to WGSL's 16-byte stride), a uint array.
  const filled = instancedArray(256, "float");
  const packed = instancedArray(new Float32Array([1, 2, 3, 4, 5, 6]), "vec3");
  const words = instancedArray(new Uint32Array([7, 8, 9]), "uint");
  if (filled.value.count !== 256) faults.push("count " + filled.value.count);
  if (packed.value.count !== 2 || packed.value.itemSize !== 4) faults.push("vec3 count " + packed.value.count + " itemSize " + packed.value.itemSize);

  // A kernel writes storage; the readback returns the bytes, past-the-end threads write nothing.
  const fill = Fn(() => { filled.element(instanceIndex).assign(float(instanceIndex).mul(3).add(1)); })().compute(256);
  renderer.compute(fill);
  same("fill", new Float32Array(await renderer.getArrayBufferAsync(filled.value)), Array.from({ length: 256 }, (_, i) => i * 3 + 1));

  // Typed-array contents arrive on the GPU; a vec3 kernel reads and writes the padded elements.
  const lift = Fn(() => { packed.element(instanceIndex).assign(packed.element(instanceIndex).add(vec3(10, 20, 30))); })().compute(2);
  renderer.compute(lift);
  same("vec3", new Float32Array(await renderer.getArrayBufferAsync(packed.value)), [11, 22, 33, 0, 14, 25, 36, 0]);
  const step = Fn(() => { words.element(instanceIndex).assign(words.element(instanceIndex).add(uint(100))); })().compute(3);
  renderer.compute(step);
  renderer.compute([step, step]);
  same("uint", new Uint32Array(await renderer.getArrayBufferAsync(words.value)), [307, 308, 309]);

  // Atomics: reset in its own dispatch, then 1000 threads (16 workgroups of 64 cover 1024 threads) count exactly.
  const counter = instancedArray(2, "uint").toAtomic();
  const loaded = instancedArray(2, "uint");
  const reset = Fn(() => { atomicStore(counter.element(0), uint(0)); atomicStore(counter.element(1), uint(0)); })().compute(1);
  const count = Fn(() => {
    If(instanceIndex.mod(uint(3)).equal(uint(0)), () => { atomicAdd(counter.element(0), uint(1)); });
    atomicAdd(counter.element(1), uint(1));
  })();
  for (let round = 0; round < 2; round += 1) {
    renderer.compute(reset);
    renderer.compute(count.compute(1000));
    same("atomics round " + round, new Uint32Array(await renderer.getArrayBufferAsync(counter.value)), [334, 1000]);
    // atomicLoad reads the settled counts into plain storage.
    renderer.compute(Fn(() => { loaded.element(0).assign(atomicLoad(counter.element(0))); loaded.element(1).assign(atomicLoad(counter.element(1))); })().compute(1));
    same("atomicLoad round " + round, new Uint32Array(await renderer.getArrayBufferAsync(loaded.value)), [334, 1000]);
  }

  // A uniform is read at the call: each queued dispatch keeps the value it was called with, not a later one.
  const scale = uniform(2);
  const scaled = instancedArray(4, "float");
  const scale4 = Fn(() => { scaled.element(instanceIndex).addAssign(float(instanceIndex).mul(scale)); })().compute(4);
  renderer.compute(scale4);
  scale.value = 5;
  renderer.compute(scale4);
  same("uniform", new Float32Array(await renderer.getArrayBufferAsync(scaled.value)), [0, 7, 14, 21]);

  // A render material reads what a kernel wrote, in the same frame the kernel was queued.
  const colour = instancedArray(new Float32Array([0, 0, 0, 0]), "vec4");
  const write = Fn(() => { colour.element(0).assign(vec4(0.25, 0.5, 0.75, 1)); })().compute(1);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = colour.element(0);
  const target = new RenderTarget(4, 4, { type: UnsignedByteType });
  renderer.compute(write);
  renderer.setRenderTarget(target);
  new QuadMesh(material).render(renderer);
  renderer.setRenderTarget(null);
  same("render read", await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1), [64, 128, 191, 255]);

  // A storage texture's writes reach the next kernel and the ordinary sampled-texture path.
  const extent = new StorageTexture();
  if (!extent.isStorageTexture || extent.image.width !== 1 || extent.image.height !== 1 ||
      extent.minFilter !== 1006 || extent.magFilter !== 1006 || !extent.generateMipmaps || !extent.mipmapsAutoUpdate)
    faults.push("storage texture defaults");
  extent.setSize(4, 4);
  if (extent.image.width !== 4 || extent.image.height !== 4) faults.push("storage texture setSize");
  extent.dispose();
  const lut = new StorageTexture(4, 4);
  lut.type = HalfFloatType;
  lut.format = RGBAFormat;
  lut.mipmapsAutoUpdate = false;
  lut.generateMipmaps = false;
  const texels = instancedArray(16, "vec4");
  const bake = Fn(() => {
    const x = instanceIndex.mod(4), y = instanceIndex.div(4);
    textureStore(lut, uvec2(x, y), vec4(float(x).div(4), float(y).div(4), float(x.add(y)).div(8), 1));
  })().compute(16);
  const sample = Fn(() => {
    const x = instanceIndex.mod(4), y = instanceIndex.div(4);
    const centre = vec2(float(x).add(0.5), float(y).add(0.5)).div(4);
    texels.element(instanceIndex).assign(texture(lut, centre).level(0));
  })().compute(16);
  renderer.compute(bake);
  renderer.compute(sample);
  const pixels = new Float32Array(await renderer.getArrayBufferAsync(texels.value));
  const expected = Array.from({ length: 16 }, (_, i) => [i % 4 / 4, Math.floor(i / 4) / 4, (i % 4 + Math.floor(i / 4)) / 8, 1]).flat();
  if (pixels.length !== expected.length || pixels.some((v, i) => !Number.isFinite(v) || Math.abs(v - expected[i]) > 1e-3))
    faults.push("storage texture compute read " + Array.from(pixels));
  const lutMaterial = new MeshBasicNodeMaterial();
  lutMaterial.colorNode = texture(lut, vec2(1.5 / 4, 2.5 / 4)).level(0);
  renderer.setRenderTarget(target);
  new QuadMesh(lutMaterial).render(renderer);
  renderer.setRenderTarget(null);
  same("storage texture render read", await renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1), [64, 128, 96, 255]);

  // r185's storageTexture node can be handed to textureStore, or append its own store.
  renderer.compute(Fn(() => {
    textureStore(storageTexture(lut), uvec2(0, 0), vec4(0.5, 0.25, 0.75, 1));
    storageTexture(lut, uvec2(1, 0), vec4(0.25, 0.5, 0.75, 1)).toStack();
  })().compute(1));
  renderer.compute(sample);
  const stored = new Float32Array(await renderer.getArrayBufferAsync(texels.value));
  same("storageTexture node", stored.slice(0, 8), [0.5, 0.25, 0.75, 1, 0.25, 0.5, 0.75, 1]);
  const invalidTexture = new StorageTexture();
  invalidTexture.type = 1010;
  try { Fn(() => { textureStore(invalidTexture, uvec2(0, 0), vec4(1)); })(); faults.push("unsupported storage texture format accepted"); }
  catch (error) { if (!/TN_NATIVE_STORAGE_TEXTURE_FORMAT:.*1010.*1023/.test(String(error.message))) faults.push("storage format error " + error.message); }
  lut.dispose();

  // A vertex-stage read: a plane's corners come from padded vec3 storage by vertexIndex, and the left half of
  // the target is covered. Row 0 of the read is the target's top row.
  const corners = instancedArray(4, "vec3");
  const place = Fn(() => {
    const x = float(instanceIndex.mod(uint(2))).sub(1);
    const y = float(instanceIndex.div(uint(2))).mul(2).sub(1);
    corners.element(instanceIndex).assign(vec3(x, y, 0));
  })().compute(4);
  const half = new MeshBasicNodeMaterial();
  half.colorNode = vec4(1, 0, 0, 1);
  half.side = DoubleSide;  // the kernel lays the corners out mirrored, so the winding flips
  half.positionNode = corners.element(vertexIndex);
  const scene = new Scene();
  scene.add(new Mesh(new PlaneGeometry(2, 2), half));
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  camera.updateMatrixWorld(true);
  renderer.compute(place);
  const wide = new RenderTarget(8, 2, { type: UnsignedByteType });
  renderer.setRenderTarget(wide);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  const row = await renderer.readRenderTargetPixelsAsync(wide, 0, 0, 8, 1);
  same("vertex read", Array.from({ length: 8 }, (_, i) => row[i * 4]), [255, 255, 255, 255, 0, 0, 0, 0]);

  // The main frame: a kernel queued in a game callback has run before that frame's passes. The quad fills
  // the view and is shown through the output pass, so the colour is the sRGB encoding of what the kernel wrote.
  const screen = new MeshBasicNodeMaterial();
  screen.colorNode = colour.element(0);
  const wall = new Scene();
  wall.add(new Mesh(new PlaneGeometry(2, 2), screen));
  globalThis.tn.scene = wall;
  globalThis.tn.camera = camera;
  renderer.compute(Fn(() => { colour.element(0).assign(vec4(0.5, 0.25, 1, 1)); })().compute(1));
  await frames(3);
  const frame = await globalThis.tn.readFrame();
  const encode = (value) => Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
  const at = ((frame.length / 8) | 0) * 4 + 4;
  const seen = Array.from(frame.slice(at, at + 4)), want = [encode(0.5), encode(0.25), 255, 255];
  if (!seen.every((value, i) => Math.abs(value - want[i]) <= 2)) faults.push("main frame got [" + seen + "] want about [" + want + "]");

  // What the engine cannot run refuses at the call, by name, and leaves the renderer running.
  const refused = (work) => { try { work(); return "ran"; } catch (error) { return String(error.message).split(":")[0]; } };
  same("refusals", [
    refused(() => renderer.compute({})),
    refused(() => renderer.compute(Fn(() => {})())),
    refused(() => Fn(() => {})().compute(0)),
    refused(() => renderer.compute(step, [4, 1, 1])),
  ].map((name) => name === "ran" ? 0 : 1), [1, 1, 1, 1]);
  await renderer.getArrayBufferAsync(filled.value, null, 2).then(() => faults.push("offset 2 resolved"), () => {});
  renderer.compute(step);
  same("after refusals", new Uint32Array(await renderer.getArrayBufferAsync(words.value)), [407, 408, 409]);

  renderer.deleteAttribute(filled.value);
}
`);
assert.equal(verdict, "COMPUTE_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS TSL compute on the V8 player: storage, dispatch order, exact readback, exact atomics, render read");
