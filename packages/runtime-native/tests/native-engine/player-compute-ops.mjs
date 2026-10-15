// PRD-620 Phase 3 prerequisites on the V8 player: the TSL operators core's SoftBody3D kernel uses, each read back
// exactly. ElseIf chains, three's object-form Loop with a uint index, start and a node end, comparisons, bool logic,
// all/any, the numeric conversions and uvec2 storage.
import assert from "node:assert/strict";
import { runComputeGame } from "./compute-harness.mjs";

const executable = process.argv[2];
assert(executable, "Usage: player-compute-ops.mjs <tn-native-engine-player-v8>");

const { verdict, output } = await runComputeGame(executable, `
import { PerspectiveCamera, Scene } from "three";
import { Fn, If, Loop, all, and, any, float, instanceIndex, instancedArray, not, or, select, uint, vec3 } from "three/tsl";
import { WebGPURenderer } from "three/webgpu";

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

  // A refusal names the unsupported form.
  let refusal = "";
  try { Fn(() => { Loop({ type: "uint", end: 3, update: "+= 2" }, () => {}); })(); } catch (error) { refusal = String(error.message); }
  if (!/Loop update is not supported/u.test(refusal)) faults.push("loop update refusal was [" + refusal + "]");
}
`);
assert.equal(verdict, "COMPUTE_OK", `${verdict}\n${output.slice(-2000)}`);
console.log("PASS TSL operators on the V8 player: ElseIf, object-form Loop, comparisons, bool logic, conversions, uvec2");
