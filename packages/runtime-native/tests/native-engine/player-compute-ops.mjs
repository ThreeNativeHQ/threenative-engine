// PRD-620 Phase 3 prerequisites on the V8 player: the TSL operators core's SoftBody3D kernel uses, each read back
// exactly. ElseIf chains, three's object-form Loop with a uint index, start and a node end, comparisons, bool logic,
// all/any, the numeric conversions and uvec2 storage.
import assert from "node:assert/strict";
import { runComputeGame } from "./compute-harness.mjs";

const executable = process.argv[2];
assert(executable, "Usage: player-compute-ops.mjs <tn-native-engine-player-v8>");

const { verdict, output } = await runComputeGame(executable, `
import { BufferAttribute, InstancedMesh, Matrix4, Mesh, OrthographicCamera, PerspectiveCamera, PlaneGeometry, RenderTarget, Scene, Sprite, UnsignedByteType } from "three";
import { Break, Continue, Fn, If, Loop, Return, all, and, any, deltaTime, float, instanceIndex, instancedArray, log, mod, not, or, positionLocal, select, storage, time, uint, uniform, vec2, vec3 } from "three/tsl";
import { MeshBasicNodeMaterial, SpriteNodeMaterial, WebGPURenderer } from "three/webgpu";

const faults = [];
const same = (label, got, want) => {
  const a = Array.from(got), b = Array.from(want);
  if (a.length !== b.length || a.some((value, i) => value !== b[i])) faults.push(label + " got [" + a + "] want [" + b + "]");
};
let started = false;
globalThis.tn.onUpdate(() => {
  if (started) return;
  started = true;
  globalThis.tn.scene = new Scene();
  globalThis.tn.camera = new PerspectiveCamera();
  run().then(
    () => globalThis.tn.log(faults.length === 0 ? "COMPUTE_OK" : "COMPUTE_BAD " + faults.join(" | ")),
    (error) => globalThis.tn.log("COMPUTE_ERROR " + (error && error.message || error)),
  );
});

async function run() {
  const renderer = new WebGPURenderer({ canvas: { width: 8, height: 8 } });
  const words = async (buffer) => new Uint32Array(await renderer.getArrayBufferAsync(buffer.value));
  const floats = async (buffer) => new Float32Array(await renderer.getArrayBufferAsync(buffer.value));

  // If / ElseIf / ElseIf / Else, with the comparisons, and, or and a uint index.
  const classes = instancedArray(8, "uint");
  renderer.compute(Fn(() => {
    const out = classes.element(instanceIndex);
    If(instanceIndex.lessThanEqual(uint(1)), () => { out.assign(uint(10)); })
      .ElseIf(instanceIndex.greaterThanEqual(uint(6)), () => { out.assign(uint(20)); })
      .ElseIf(instanceIndex.equal(uint(3)).or(instanceIndex.equal(uint(4))), () => { out.assign(uint(30)); })
      .Else(() => { out.assign(uint(40)); });
  })().compute(8));
  same("elseif", await words(classes), [10, 10, 40, 30, 30, 40, 20, 20]);

  // Loop({ type: "uint", start, end }) sums 2 + 3 + 4 + 5; a node end (a uvec2 element's lane) sums 0 + 1 + 2 + 3;
  // the plain count form still counts an i32 index; an If on the uint index reads a uvec2 lane.
  const meta = instancedArray(new Uint32Array([5, 4, 0, 0]), "uvec2");
  const sums = instancedArray(2, "uint");
  renderer.compute(Fn(() => {
    const ranged = uint(0).toVar();
    Loop({ type: "uint", start: 2, end: 6 }, ({ i }) => { ranged.addAssign(i); });
    const bounded = uint(0).toVar();
    Loop({ type: "uint", end: meta.element(0).y }, ({ i }) => {
      If(i.lessThan(meta.element(0).y), () => { bounded.addAssign(i); });
    });
    const counted = uint(0).toVar();
    Loop(3, ({ i }) => { counted.addAssign(i.toUint()); });
    sums.element(0).assign(ranged.add(counted).mul(1000).add(bounded));
    sums.element(1).assign(meta.element(0).x.add(meta.element(0).y));
  })().compute(1));
  same("loops", await words(sums), [(14 + 3) * 1000 + 6, 9]);

  // A stepped loop that starts at a node, as GPUParticles3D's bounds reduction does: thread t sums t, t + 4, ... below 10.
  const strided = instancedArray(4, "uint");
  renderer.compute(Fn(() => {
    const sum = uint(0).toVar();
    Loop({ start: instanceIndex, end: 10, type: "uint", update: 4 }, ({ i }) => { sum.addAssign(i); });
    strided.element(instanceIndex).assign(sum);
  })().compute(4));
  same("stepped loop", await words(strided), [12, 15, 8, 10]);

  // A typed uniform: uniform(3, "uint") adds to a uint index, and a later edit reaches the next dispatch.
  const ring = uniform(3, "uint");
  const wrapped = instancedArray(8, "uint");
  const wrapKernel = Fn(() => { wrapped.element(ring.add(instanceIndex).mod(uint(8))).assign(instanceIndex.add(1)); })().compute(8);
  renderer.compute(wrapKernel);
  same("typed uniform", await words(wrapped), [6, 7, 8, 1, 2, 3, 4, 5]);
  ring.value = 4;
  renderer.compute(wrapKernel);
  same("typed uniform reassigned", await words(wrapped), [5, 6, 7, 8, 1, 2, 3, 4]);

  const exact = uniform(16777217, "uint");
  const signed = uniform(-16777217, "int");
  const unsignedOut = instancedArray(1, "uint");
  const signedOut = instancedArray(1, "int");
  const exactKernel = Fn(() => {
    unsignedOut.element(0).assign(exact);
    signedOut.element(0).assign(signed);
  })().compute(1);
  renderer.compute(exactKernel);
  same("uint above float precision", await words(unsignedOut), [16777217]);
  same("int above float precision", new Int32Array(await renderer.getArrayBufferAsync(signedOut.value)), [-16777217]);
  exact.value = 4294967295;
  signed.value = -2147483648;
  renderer.compute(exactKernel);
  same("uint max reassigned", await words(unsignedOut), [4294967295]);
  same("int min reassigned", new Int32Array(await renderer.getArrayBufferAsync(signedOut.value)), [-2147483648]);

  // mod(vec2, float) widens the scalar, and a negative lane wraps up (GLSL mod, not WGSL's remainder).
  const folded = instancedArray(2, "float");
  renderer.compute(Fn(() => {
    const m = mod(vec2(5.5, -1.5), float(4));
    folded.element(0).assign(m.x);
    folded.element(1).assign(m.y);
  })().compute(1));
  const [m0, m1] = await floats(folded);
  if (Math.abs(m0 - 1.5) > 1e-5 || Math.abs(m1 - 2.5) > 1e-5) faults.push("mod(vec2, float) was [" + m0 + "," + m1 + "]");

  // Bool vectors and logic, and the conversions: vec3(1, 2, 3) <= (1, 5, 2) is (true, true, false).
  const bools = instancedArray(8, "float");
  renderer.compute(Fn(() => {
    const v = vec3(1, 2, 3);
    const w = vec3(1, 5, 2);
    const lanes = v.lessThanEqual(w);
    bools.element(0).assign(select(all(lanes), 1, 0));
    bools.element(1).assign(select(any(lanes), 1, 0));
    bools.element(2).assign(select(lanes.x.and(lanes.y), 1, 0));
    bools.element(3).assign(select(not(lanes.z), 1, 0));
    bools.element(4).assign(select(and(lanes.z, lanes.x).or(lanes.y), 1, 0));
    bools.element(5).assign(float(7.9).toUint().toFloat());
    bools.element(6).assign(float(-2.5).toInt().toFloat());
    bools.element(7).assign(select(v.greaterThanEqual(vec3(1, 2, 4)).any(), 1, 0));
  })().compute(1));
  same("bools", await floats(bools), [0, 1, 1, 1, 1, 7, -2, 1]);

  // toAttribute(): the buffer as a per-instance vertex attribute. Two quads a quarter wide sit where a kernel put
  // them: the target's pixels 1-2 and 5-6 are covered.
  const spots = instancedArray(2, "vec3");
  renderer.compute(Fn(() => {
    spots.element(instanceIndex).assign(vec3(float(instanceIndex).mul(1).sub(0.5), 0, 0));
  })().compute(2));
  const quad = new MeshBasicNodeMaterial();
  // Both typed uniforms are consumed by a fragment: the max uint stays odd and the min int stays negative.
  quad.colorNode = vec3(float(exact.mod(uint(2))).mul(float(ring).div(4)).mul(select(signed.lessThan(0), 1, 0)), 0, 0);
  quad.positionNode = positionLocal.mul(vec3(0.25, 1, 1)).add(spots.toAttribute());
  const field = new Scene();
  const instances = new InstancedMesh(new PlaneGeometry(2, 2), quad, 2);
  for (let i = 0; i < 2; i += 1) instances.setMatrixAt(i, new Matrix4());
  field.add(instances);
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  camera.updateMatrixWorld(true);
  const strip = new RenderTarget(8, 2, { type: UnsignedByteType });
  renderer.setRenderTarget(strip);
  renderer.render(field, camera);
  renderer.setRenderTarget(null);
  const row = await renderer.readRenderTargetPixelsAsync(strip, 0, 0, 8, 1);
  same("toAttribute", Array.from({ length: 8 }, (_, i) => row[i * 4]), [0, 255, 255, 0, 0, 255, 255, 0]);

  // A regular storage attribute advances per vertex: selecting instanceIndex would collapse this quad.
  const corners = storage(new BufferAttribute(new Float32Array([
    -1, 1, 0, 1, 1, 1, 0, 1, -1, -1, 0, 1, 1, -1, 0, 1,
  ]), 4), "vec4");
  const surface = new MeshBasicNodeMaterial();
  surface.positionNode = corners.toAttribute().xyz;
  surface.colorNode = vec3(1, 0, 0);
  const solid = new Scene();
  solid.add(new Mesh(new PlaneGeometry(2, 2), surface));
  renderer.setRenderTarget(strip);
  renderer.render(solid, camera);
  renderer.setRenderTarget(null);
  const filled = await renderer.readRenderTargetPixelsAsync(strip, 0, 0, 8, 1);
  same("regular storage toAttribute", Array.from({ length: 8 }, (_, i) => filled[i * 4]), Array(8).fill(255));

  // A sprite per element: positionNode is the centre, scaleNode multiplies the model scale (0.5 x 2 here), and
  // rotationNode turns it (a quarter turn of a 2 x 0.5 sprite lands on the same footprint).
  for (const [name, scale, rotation] of [["scaleNode", vec2(0.5, 2), undefined], ["rotationNode", vec2(2, 0.5), float(Math.PI / 2)]]) {
    const flake = new SpriteNodeMaterial();
    // Snow consumes both the storage attribute and instanceIndex in its fragment color.
    flake.colorNode = vec3(1, spots.toAttribute().x.add(0.5), float(instanceIndex));
    flake.positionNode = spots.toAttribute();
    flake.scaleNode = scale;
    if (rotation) flake.rotationNode = rotation;
    const cloud = new Sprite(flake);
    cloud.count = 2;
    cloud.frustumCulled = false;
    const sky = new Scene();
    sky.add(cloud);
    const wide = new RenderTarget(8, 2, { type: UnsignedByteType });
    renderer.setRenderTarget(wide);
    renderer.render(sky, camera);
    renderer.setRenderTarget(null);
    const line = await renderer.readRenderTargetPixelsAsync(wide, 0, 0, 8, 1);
    same("sprite " + name, Array.from({ length: 8 }, (_, i) => line[i * 4]), [0, 255, 255, 0, 0, 255, 255, 0]);
    for (const channel of [1, 2])
      same("sprite fragment " + name + " channel " + channel, Array.from({ length: 8 }, (_, i) => line[i * 4 + channel]), [0, 0, 0, 0, 0, 255, 255, 0]);
  }

  // The kernel node carries three's isComputeNode flag, which GPUParticles3D checks.
  if (Fn(() => {})().compute(1).isComputeNode !== true) faults.push("compute node lacks isComputeNode");

  // Return() ends one invocation, Break() and Continue() steer a loop: 0 + 2 + 4 + 6 = 12 (odd skipped, stop past 6).
  const early = instancedArray(6, "uint");
  const steered = instancedArray(1, "uint");
  renderer.compute(Fn(() => {
    If(instanceIndex.greaterThanEqual(uint(3)), () => { Return(); });
    early.element(instanceIndex).assign(uint(7));
  })().compute(6));
  same("return", await words(early), [7, 7, 7, 0, 0, 0]);
  renderer.compute(Fn(() => {
    const sum = uint(0).toVar();
    Loop({ type: "uint", end: 10 }, ({ i }) => {
      If(i.greaterThan(6), () => { Break(); });
      If(i.toFloat().mod(2).equal(1), () => { Continue(); });
      sum.addAssign(i);
    });
    steered.element(0).assign(sum);
  })().compute(1));
  same("break and continue", await words(steered), [12]);

  // log is the natural logarithm; deltaTime and time are the frame clock a kernel is called under.
  const clock = instancedArray(3, "float");
  renderer.compute(Fn(() => {
    clock.element(0).assign(log(float(10)));
    clock.element(1).assign(deltaTime);
    clock.element(2).assign(time);
  })().compute(1));
  const [ln10, delta, elapsed] = await floats(clock);
  if (Math.abs(ln10 - Math.log(10)) > 1e-5) faults.push("log(10) was " + ln10);
  if (!(delta > 0 && delta < 5)) faults.push("deltaTime was " + delta);
  if (!(elapsed > 0 && elapsed < 600)) faults.push("time was " + elapsed);

  // A refusal names the unsupported form.
  let refusal = "";
  try { Fn(() => { Loop({ type: "uint", end: 3, update: "+= 2" }, () => {}); })(); } catch (error) { refusal = String(error.message); }
  if (!/Loop update is not supported/u.test(refusal)) faults.push("loop update refusal was [" + refusal + "]");
  refusal = "";
  try { Fn(() => { Return(float(1)); })(); } catch (error) { refusal = String(error.message); }
  if (!/Return[(]value[)] is not supported/u.test(refusal)) faults.push("Return(value) refusal was [" + refusal + "]");
}
`);
assert.equal(verdict, "COMPUTE_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS TSL operators on the V8 player: ElseIf, object-form Loop, comparisons, bool logic, conversions, uvec2");
