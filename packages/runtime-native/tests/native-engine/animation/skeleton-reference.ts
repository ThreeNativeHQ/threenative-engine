/**
 * Records three@0.185.1's Bone and Skeleton as a C++ table the native test compares against
 * (PRD-518 phase 1). Nine rigs: the joint hierarchies of the repository's skinned glTF files (parsed here, no
 * GLTFLoader, so no DOM) plus six seeded synthetic rigs. After every recorded pose the table holds
 * the skeleton's float32 `boneMatrices` bits and every node's float64 `matrixWorld` bits.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/animation/skeleton-reference.ts
 *   ... -- --check   (fails when the committed table is not what this three produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bone, Matrix4, Object3D, Quaternion, Skeleton, Vector3 } from "three";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "skeleton_reference.inc");
const REPO = path.resolve(HERE, "../../../../..");
// The repository's skinned glTF files: the small test rig and the templates' own characters.
const GLBS = [
  "test-support/fixtures/skinned-character.glb",
  "packages/create-threenative/template-assets/assets/mannequin.glb",
  "packages/create-threenative/template-assets/assets/player-viewmodel.glb",
].map((file) => path.join(REPO, file));

// ------------------------------------------------------------------------ bit helpers

const f32bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0] as number;
const f64bits = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const d = (x: number) => `std::bit_cast<double>(0x${f64bits(x).toString(16).padStart(16, "0")}ull)`;
const h32 = (bits: number) => `0x${bits.toString(16).padStart(8, "0")}u`;
const h64 = (bits: bigint) => `std::bit_cast<double>(0x${bits.toString(16).padStart(16, "0")}ull)`;

// ------------------------------------------------------------------------ rig specs

interface INodeSpec {
  name: string;
  parent: number; // -1 = root
  isBone: boolean;
  t: number[];
  q: number[];
  s: number[];
}
interface IRigSpec {
  nodes: INodeSpec[];
  root: number;
  /** One entry per skeleton slot: a node index, or null for three's `undefined` hole. */
  bones: (number | null)[];
  /** Explicit matrices (GLB accessor), "bind" (inverse of the bind-pose world), or null (compute). */
  inverses: number[][] | "bind" | null;
}

// ------------------------------------------------------------------------ GLB container

interface IGlbNode {
  name?: string;
  children?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  matrix?: number[];
}
interface IGlbAccessor {
  bufferView: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
}
interface IGlbBufferView {
  byteOffset?: number;
  byteStride?: number;
}
interface IGlbSkin {
  joints: number[];
  inverseBindMatrices: number;
}
interface IGlbJson {
  nodes: IGlbNode[];
  accessors: IGlbAccessor[];
  bufferViews: IGlbBufferView[];
  skins: IGlbSkin[];
}
interface IGlb {
  json: IGlbJson;
  bin: Uint8Array;
}

function parseGlb(bytes: Uint8Array): IGlb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x46546c67) throw new Error("TN_FIXTURE_NOT_GLB");
  const total = view.getUint32(8, true);
  let offset = 12;
  let json: IGlbJson | null = null;
  let bin: Uint8Array | null = null;
  while (offset < total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (type === 0x4e4f534a)
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, start + length)));
    else if (type === 0x004e4942) bin = bytes.subarray(start, start + length);
    offset = start + length;
  }
  if (json === null || bin === null) throw new Error("TN_FIXTURE_GLB_CHUNKS");
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Reads a float32/int accessor's numeric values. The rig corpus only needs float32 matrices. */
function readAccessor(json: IGlbJson, bin: Uint8Array, index: number): number[] {
  const accessor = json.accessors[index];
  if (accessor.componentType !== 5126) throw new Error("TN_FIXTURE_ACCESSOR_COMPONENT");
  const bufferView = json.bufferViews[accessor.bufferView];
  const componentCount = COMPONENTS[accessor.type];
  if (componentCount === undefined) throw new Error("TN_FIXTURE_ACCESSOR_TYPE");
  const elementSize = componentCount * 4;
  const stride = bufferView.byteStride ?? elementSize;
  const base = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const out: number[] = [];
  for (let i = 0; i < accessor.count; ++i)
    for (let c = 0; c < componentCount; ++c)
      out.push(view.getFloat32(base + i * stride + c * 4, true));
  return out;
}

function nodeTrs(node: IGlbNode): { t: number[]; q: number[]; s: number[] } {
  if (Array.isArray(node.matrix)) {
    // The fixture uses TRS only; a matrix node is decomposed so both sides build from the same TRS.
    const position = new Vector3();
    const quaternion = new Quaternion();
    const scale = new Vector3();
    new Matrix4().fromArray(node.matrix).decompose(position, quaternion, scale);
    return {
      t: [position.x, position.y, position.z],
      q: [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
      s: [scale.x, scale.y, scale.z],
    };
  }
  return {
    t: node.translation ?? [0, 0, 0],
    q: node.rotation ?? [0, 0, 0, 1],
    s: node.scale ?? [1, 1, 1],
  };
}

function glbRig(file: string): IRigSpec {
  const { json, bin } = parseGlb(new Uint8Array(readFileSync(file)));
  const skin = json.skins[0];
  const joints: number[] = skin.joints;
  const parentOf = new Map<number, number>();
  json.nodes.forEach((node: IGlbNode, i: number) => {
    for (const child of node.children ?? []) parentOf.set(child, i);
  });
  // The root above the first joint: a file's first root may be its mesh, whose subtree has no bones.
  let root = joints[0] as number;
  while (parentOf.has(root)) root = parentOf.get(root) as number;
  const nodes: INodeSpec[] = json.nodes.map((node: IGlbNode, i: number) => ({
    name: node.name ?? "",
    parent: parentOf.get(i) ?? -1,
    isBone: joints.includes(i),
    ...nodeTrs(node),
  }));
  const flat = readAccessor(json, bin, skin.inverseBindMatrices);
  const inverses: number[][] = [];
  for (let i = 0; i < joints.length; ++i) inverses.push(flat.slice(i * 16, (i + 1) * 16));
  return { nodes, root, bones: joints.slice(), inverses };
}

// ------------------------------------------------------------------------ synthetic rigs

const bone = (
  name: string,
  parent: number,
  t: number[],
  q: number[] = [0, 0, 0, 1],
  s: number[] = [1, 1, 1],
): INodeSpec => ({
  name,
  parent,
  isBone: true,
  t,
  q,
  s,
});
const object = (
  name: string,
  parent: number,
  t: number[],
  q: number[] = [0, 0, 0, 1],
  s: number[] = [1, 1, 1],
): INodeSpec => ({
  name,
  parent,
  isBone: false,
  t,
  q,
  s,
});

function syntheticRigs(): IRigSpec[] {
  return [
    // A straight chain.
    {
      nodes: [
        object("chain-root", -1, [0.5, -0.25, 1]),
        bone("c0", 0, [0, 0.4, 0], [0, 0, 0.25881904510252074, 0.9659258262890683]),
        bone("c1", 1, [0.2, 0.5, 0]),
        bone("c2", 2, [0, 0.3, 0]),
        bone("c3", 3, [0.1, 0.2, 0]),
      ],
      root: 0,
      bones: [1, 2, 3, 4],
      inverses: "bind",
    },
    // A branching tree.
    {
      nodes: [
        object("tree-root", -1, [-0.5, 0, 0.25]),
        bone("t0", 0, [0, 0.3, 0]),
        bone("t1", 1, [0.3, 0.4, 0]),
        bone(
          "t2",
          1,
          [-0.25, 0.35, 0.1],
          [0.1830127018922193, 0.1830127018922193, 0.6830127018922193, 0.6830127018922193],
        ),
        bone("t3", 2, [0, 0.25, 0]),
      ],
      root: 0,
      bones: [1, 2, 3, 4],
      inverses: "bind",
    },
    // A bone with a non-uniform scale.
    {
      nodes: [
        object("scale-root", -1, [0, 0, 0]),
        bone("s0", 0, [0, 0.2, 0]),
        bone("s1", 1, [0, 0.3, 0], [0, 0, 0, 1], [2, 3, 0.5]),
        bone("s2", 2, [0, 0.25, 0]),
      ],
      root: 0,
      bones: [1, 2, 3],
      inverses: "bind",
    },
    // A bone with a negative scale.
    {
      nodes: [
        object("neg-root", -1, [0, 0, 0]),
        bone("n0", 0, [0.1, 0.2, -0.1]),
        bone("n1", 1, [0, 0.35, 0], [0, 0, 0, 1], [-1.5, 2, 0.75]),
      ],
      root: 0,
      bones: [1, 2],
      inverses: "bind",
    },
    // No inverse list: Skeleton.calculateInverses runs.
    {
      nodes: [
        object("calc-root", -1, [0, 0.1, 0]),
        bone("a0", 0, [0, 0.2, 0]),
        bone("a1", 1, [0, 0.4, 0], [0.13052619222005157, 0, 0, 0.9914448613738104]),
        bone("a2", 2, [0, 0.15, 0]),
      ],
      root: 0,
      bones: [1, 2, 3],
      inverses: null,
    },
    // A hole in the bone list: slot 1 is three's `undefined`.
    {
      nodes: [
        object("hole-root", -1, [0, 0, 0]),
        bone("h0", 0, [0, 0.3, 0]),
        bone("h1", 1, [0, 0.3, 0], [0.2, -0.1, 0.3, 0.9273618495495703]),
      ],
      root: 0,
      bones: [1, null, 2],
      inverses: "bind",
    },
  ];
}

// ------------------------------------------------------------------------ PRNG

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randomQuat = (rng: () => number): number[] => {
  const x = rng() * 2 - 1;
  const y = rng() * 2 - 1;
  const z = rng() * 2 - 1;
  const w = rng() * 2 - 1;
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
};

// ------------------------------------------------------------------------ three replay

interface IPose {
  writes: { bone: number; t: number[]; q: number[]; s: number[] }[];
  callPose: boolean;
}
interface IRecorded {
  matrices: number[];
  worlds: bigint[];
}

function buildRig(spec: IRigSpec) {
  const nodes: Object3D[] = spec.nodes.map((n) => (n.isBone ? new Bone() : new Object3D()));
  nodes.forEach((o, i) => {
    const n = spec.nodes[i] as INodeSpec;
    o.name = n.name;
    o.position.set(n.t[0] as number, n.t[1] as number, n.t[2] as number);
    o.quaternion.set(n.q[0] as number, n.q[1] as number, n.q[2] as number, n.q[3] as number);
    o.scale.set(n.s[0] as number, n.s[1] as number, n.s[2] as number);
  });
  spec.nodes.forEach((n, i) => {
    if (n.parent >= 0) (nodes[n.parent] as Object3D).add(nodes[i] as Object3D);
  });
  const root = nodes[spec.root] as Object3D;
  root.updateMatrixWorld(true);

  const bones = spec.bones.map((idx) => (idx === null ? undefined : (nodes[idx] as Bone)));
  let inverses: Matrix4[];
  if (spec.inverses === null) inverses = [];
  else if (spec.inverses === "bind")
    inverses = spec.bones.map((idx) =>
      idx === null
        ? new Matrix4().makeTranslation(0.25, -0.5, 1)
        : new Matrix4().copy((nodes[idx] as Object3D).matrixWorld).invert(),
    );
  else inverses = spec.inverses.map((a) => new Matrix4().fromArray(a));

  const skeleton = new Skeleton(bones as unknown as Bone[], inverses);
  const rng = mulberry32(0x51800000);
  const poses: IPose[] = [];
  for (let p = 0; p < 3; ++p) {
    const writes: IPose["writes"] = [];
    for (let slot = 0; slot < spec.bones.length; ++slot) {
      if (spec.bones[slot] === null) continue;
      writes.push({
        bone: slot,
        t: [rng() * 3 - 1.5, rng() * 3 - 1.5, rng() * 3 - 1.5],
        q: randomQuat(rng),
        s: [rng() * 3 - 1.5, rng() * 3 - 1.5, rng() * 3 - 1.5],
      });
    }
    poses.push({ writes, callPose: false });
  }
  poses.push({ writes: [], callPose: true });
  return { spec, nodes, root, bones, skeleton, poses };
}

function record(rig: ReturnType<typeof buildRig>, pose: IPose): IRecorded {
  if (pose.callPose) rig.skeleton.pose();
  else
    for (const w of pose.writes) {
      const b = rig.bones[w.bone];
      if (!b) continue;
      b.position.set(w.t[0] as number, w.t[1] as number, w.t[2] as number);
      b.quaternion.set(w.q[0] as number, w.q[1] as number, w.q[2] as number, w.q[3] as number);
      b.scale.set(w.s[0] as number, w.s[1] as number, w.s[2] as number);
    }
  rig.root.updateMatrixWorld(true);
  rig.skeleton.update();
  const matrices = Array.from(rig.skeleton.boneMatrices ?? [], f32bits);
  const worlds = rig.nodes.flatMap((o) => Array.from(o.matrixWorld.elements, f64bits));
  return { matrices, worlds };
}

// ------------------------------------------------------------------------ emit

function emitRig(rig: ReturnType<typeof buildRig>, index: number): string {
  const name = `Rig${index}`;
  const lines: string[] = [];
  lines.push(`static const SkinnedNode kNodes${name}[] = {`);
  for (const n of rig.spec.nodes)
    lines.push(
      `    {${JSON.stringify(n.name)}, ${n.parent}, ${n.isBone ? 1 : 0}, {${n.t.map(d).join(", ")}}, {${n.q.map(d).join(", ")}}, {${n.s.map(d).join(", ")}}},`,
    );
  lines.push("};");
  lines.push(
    `static const int kBones${name}[] = {${rig.spec.bones.map((b) => (b === null ? -1 : b)).join(", ")}};`,
  );

  let inverseRef = "nullptr";
  if (rig.skeleton.boneInverses.length > 0) {
    lines.push(`static const double kInverses${name}[] = {`);
    for (const m of rig.skeleton.boneInverses) lines.push(`    ${m.elements.map(d).join(", ")},`);
    lines.push("};");
    inverseRef = `kInverses${name}`;
  }

  const recorded = rig.poses.map((pose) => record(rig, pose));
  const poseEntries: string[] = [];
  rig.poses.forEach((pose, p) => {
    let writesRef = "nullptr";
    if (pose.writes.length > 0) {
      lines.push(`static const SkinnedWrite kWrites${name}_${p}[] = {`);
      for (const w of pose.writes)
        lines.push(
          `    {${w.bone}, {${w.t.map(d).join(", ")}}, {${w.q.map(d).join(", ")}}, {${w.s.map(d).join(", ")}}},`,
        );
      lines.push("};");
      writesRef = `kWrites${name}_${p}`;
    }
    lines.push(
      `static const unsigned int kMatrices${name}_${p}[] = {${(recorded[p] as IRecorded).matrices.map(h32).join(", ")}};`,
    );
    lines.push(
      `static const double kWorlds${name}_${p}[] = {${(recorded[p] as IRecorded).worlds.map(h64).join(", ")}};`,
    );
    poseEntries.push(
      `    {${writesRef}, ${pose.writes.length}, ${pose.callPose ? 1 : 0}, kMatrices${name}_${p}, kWorlds${name}_${p}},`,
    );
  });
  lines.push(`static const SkinnedPose kPoses${name}[] = {`);
  lines.push(...poseEntries);
  lines.push("};");

  const firstBoneSlot = rig.spec.bones.findIndex((b) => b !== null);
  const lookupName = rig.nodes[rig.spec.bones[firstBoneSlot] as number]?.name ?? "";
  lines.push(
    `static const SkinnedRig kRig${index} = {kNodes${name}, ${rig.spec.nodes.length}, ${rig.spec.root}, kBones${name}, ${rig.spec.bones.length}, ${inverseRef}, ` +
      `${rig.skeleton.boneInverses.length}, kPoses${name}, ${rig.poses.length}, ${JSON.stringify(lookupName)}, ${firstBoneSlot}, "__missing__"};`,
  );
  return lines.join("\n");
}

// ------------------------------------------------------------------------ main

const rigs = [
  ...GLBS.map((file) => buildRig(glbRig(file))),
  ...syntheticRigs().map((spec) => buildRig(spec)),
];

const text = [
  "// Generated by packages/runtime-native/tests/native-engine/animation/skeleton-reference.ts.",
  "// Do not edit: rerun the generator. Bones are three@0.185.1, matrices their exact bits.",
  "struct SkinnedNode { const char* name; int parent; int isBone; double t[3]; double q[4]; double s[3]; };",
  "struct SkinnedWrite { int bone; double t[3]; double q[4]; double s[3]; };",
  "struct SkinnedPose { const SkinnedWrite* writes; int writeCount; int callPose; const unsigned int* matrices; const double* worlds; };",
  "struct SkinnedRig { const SkinnedNode* nodes; int nodeCount; int root; const int* bones; int boneCount; const double* inverses; int inverseCount; const SkinnedPose* poses; int poseCount; const char* lookupName; int lookupResult; const char* absentName; };",
  "",
  ...rigs.map((rig, i) => emitRig(rig, i)),
  "",
  "static const SkinnedRig kRigs[] = {",
  ...rigs.map((_, i) => `    kRig${i},`),
  "};",
  `static const int kRigCount = ${rigs.length};`,
  "",
].join("\n");

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      `TN_FIXTURE_STALE: ${path.relative(process.cwd(), OUT)} is not what three produces`,
    );
    process.exit(1);
  }
  console.log(`current: ${rigs.length} rigs`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${rigs.length} rigs`);
}
