// PRD-748: the JS glue each crossing pays over the real Wasm ABI module, timed per crossing kind, under node.
//   tsx tests/browser-backend-glue-bench.ts <path to tn-native-engine-abi-module.js> [rounds]
// Prints each kind's median ns per call and GLUE_BENCH. Compare two code states as interleaved runs on a quiet,
// pinned CPU (`taskset -c 2`); a loaded host moves these numbers by 2x.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type * as THREE from "three";

import {
  type IRegistryDump,
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const modulePath = process.argv[2];
if (modulePath === undefined)
  throw new Error("usage: browser-backend-glue-bench.ts <abi module .js> [rounds]");
const rounds = Number(process.argv[3] ?? 7);
const createTnAbi = createRequire(import.meta.url)(
  path.resolve(modulePath),
) as () => Promise<TnAbiModule>;
const registry = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "api", "native-registry.json"), "utf8"),
) as IRegistryDump;
const engine = defineBrowserClasses(registry, createWasmRuntime(await createTnAbi()));
const { BoxGeometry, Euler, Group, Mesh, MeshBasicMaterial, Quaternion, Scene, Vector3 } =
  engine.classes as unknown as typeof THREE;

const scene = new Scene();
const group = new Group();
scene.add(group);
const material = new MeshBasicMaterial();
const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
group.add(mesh);
const euler = new Euler();
const quaternion = new Quaternion(0, 0.38268343, 0, 0.92387953);
const out = new Vector3();
const position = mesh.geometry.getAttribute("position");
if (position === null) throw new Error("the box has no position attribute");

// The shooter's top crossing kinds (2026-10-27 census), two lane accesses that cross nothing, and the
// two entries a cached read pays instead of a crossing: the glue a frame pays for a property the back end
// already holds is the descriptor getter, not the engine call.
const kinds: Record<string, () => unknown> = {
  "call Group.updateWorldMatrix": () => group.updateWorldMatrix(false, false),
  "call Euler.setFromQuaternion": () => euler.setFromQuaternion(quaternion),
  "call Group.getWorldPosition": () => group.getWorldPosition(out),
  "call Mesh.__tnVisibleInWorld": () =>
    (mesh as unknown as { __tnVisibleInWorld(): boolean }).__tnVisibleInWorld(),
  "get BufferAttribute.version": () => position.version,
  "cached get MeshBasicMaterial.opacity": () => material.opacity,
  "cached get Mesh.renderOrder": () => mesh.renderOrder,
  "lane Mesh.position.x read+write": () => {
    mesh.position.x += 1;
  },
  "lane Vector3 copy from engine": () => out.copy(mesh.position),
  "set MeshBasicMaterial.opacity": () => {
    material.opacity = material.opacity === 1 ? 0.5 : 1;
  },
};

const calls = 20_000;
const times = new Map<string, number[]>();
for (let round = 0; round < rounds; round++)
  for (const [name, call] of Object.entries(kinds)) {
    const start = performance.now();
    for (let i = 0; i < calls; i++) call();
    const ns = ((performance.now() - start) * 1e6) / calls;
    times.set(name, [...(times.get(name) ?? []), ns]);
  }
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN;
for (const [name, values] of times)
  console.log(`${median(values).toFixed(0).padStart(6)} ns  ${name}`);
const medians = [...times.values()].map(median);
console.log(
  `GLUE_BENCH mean ${(medians.reduce((a, b) => a + b, 0) / medians.length).toFixed(0)} ns per call`,
);
