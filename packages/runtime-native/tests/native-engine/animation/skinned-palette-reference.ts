/**
 * Records the CPU state of `SkinnedBatch` (packages/core/src/projection-skinned.ts) as a C++ table
 * the native test replays against its ported `SkinnedPalette` (PRD-518 phases 2-3). It drives a real
 * `SkinnedBatch` through a scripted sequence of frames: claim, write (twice, as a main and shadow
 * pass), hide, release, slot reuse, restart and a full batch. After every frame it records the
 * palette and history float bits, `used`, the free list, the fresh and collapsed slots, the number
 * of `skeleton.update` calls and the number of `write` calls. Every double is recorded as its
 * binary64 bit pattern and every float as uint32, so the comparison is exact.
 *
 * It also records `isSimilarityTransform` over a table of ~20 matrices (uniform, uneven, sheared,
 * mirrored, near-tolerance and zero).
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/animation/skinned-palette-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Bone,
  BufferGeometry,
  Float32BufferAttribute,
  Matrix4,
  MeshStandardMaterial,
  type Skeleton,
  SkinnedMesh,
  Skeleton as ThreeSkeleton,
  Uint16BufferAttribute,
  Vector3,
} from "three";
import { SkinnedBatch, isSimilarityTransform } from "../../../../core/src/projection-skinned.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "skinned_palette_reference.inc");

const BONES = 3;
const CAPACITY = 5;
const FRAMES = 12;
const RIG_COUNT = 6;

// ------------------------------------------------------------------------ bit helpers

const f32bits = (x: number): number => new Uint32Array(new Float32Array([x]).buffer)[0] as number;
const f64bits = (x: number): bigint => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const d = (value: unknown): string => {
  const x = value as number;
  return `std::bit_cast<double>(0x${f64bits(x).toString(16).padStart(16, "0")}ull)`;
};
const h32 = (bits: number): string => `0x${(bits >>> 0).toString(16).padStart(8, "0")}u`;

// ------------------------------------------------------------------------ rigs

interface IRig {
  mesh: SkinnedMesh;
  bones: Bone[];
  skeleton: Skeleton;
  name: string;
}

function rigGeometry(): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 1, 0, 0, 2, 0], 3));
  geometry.setAttribute("normal", new Float32BufferAttribute([1, 0, 0, 1, 0, 0, 1, 0, 0], 3));
  geometry.setAttribute(
    "skinIndex",
    new Uint16BufferAttribute([0, 0, 0, 0, 1, 0, 0, 0, 2, 0, 0, 0], 4),
  );
  geometry.setAttribute(
    "skinWeight",
    new Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4),
  );
  return geometry;
}

const GEOMETRY = rigGeometry();
const MATERIAL = new MeshStandardMaterial();

function chainOfBones(): Bone[] {
  const bones: Bone[] = [];
  for (let index = 0; index < BONES; index += 1) {
    const bone = new Bone();
    bone.position.y = index === 0 ? 0 : 1;
    bones[index - 1]?.add(bone);
    bones.push(bone);
  }
  return bones;
}

/**
 * Kinds match the native test's rig table. Every rig's inverse list is computed by three at the
 * origin bind pose, as `new Skeleton(bones)` does.
 */
function makeRig(name: string, kind: "identity" | "offset" | "detached"): IRig {
  const bones = chainOfBones();
  const mesh = new SkinnedMesh(GEOMETRY, MATERIAL);
  mesh.add(bones[0] as Bone);
  if (kind === "identity") {
    mesh.bind(new ThreeSkeleton(bones));
  } else if (kind === "offset") {
    mesh.bind(new ThreeSkeleton(bones));
    mesh.bind(mesh.skeleton, new Matrix4().makeTranslation(0.5, -1, 0.25));
    mesh.position.set(1.5, 0.5, -0.5);
  } else {
    mesh.bind(new ThreeSkeleton(bones));
    mesh.bindMode = "detached";
    mesh.position.set(-4, 0, 1);
    mesh.rotation.z = 0.4;
    mesh.scale.set(1, 1.5, 1);
    mesh.bind(mesh.skeleton, new Matrix4().makeRotationX(0.3));
  }
  mesh.updateMatrixWorld(true);
  return { mesh, bones, skeleton: mesh.skeleton, name };
}

const RIGS: IRig[] = [
  makeRig("identity", "identity"),
  makeRig("offset", "offset"),
  makeRig("detached", "detached"),
  makeRig("grown", "identity"),
  makeRig("reused", "offset"),
  makeRig("filled", "identity"),
];

for (const rig of RIGS) rig.mesh.position.x += 0.25 * RIGS.indexOf(rig);

// ------------------------------------------------------------------------ the script

type OpKind = "claim" | "release" | "write" | "hide" | "restart";
interface IOp {
  kind: OpKind;
  rig?: number;
  slot?: number;
  times?: number;
}

/** Frames of the replay: claim/release/write/hide/restart, in order, one begin/end per frame. */
const SCRIPT: IOp[][] = [
  // 0: three rigs claimed and written; the first twice, as a main and a shadow pass.
  [
    { kind: "claim", rig: 0 },
    { kind: "write", slot: 0, rig: 0, times: 2 },
    { kind: "claim", rig: 1 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "claim", rig: 2 },
    { kind: "write", slot: 2, rig: 2 },
  ],
  // 1: an ordinary frame.
  [
    { kind: "write", slot: 0, rig: 0, times: 2 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
  ],
  // 2: hide one slot; it keeps its slot but collapses.
  [
    { kind: "hide", slot: 1 },
    { kind: "write", slot: 0, rig: 0 },
    { kind: "write", slot: 2, rig: 2 },
  ],
  // 3: release the hidden rig: its slot joins the free list, collapsed.
  [
    { kind: "release", rig: 1 },
    { kind: "write", slot: 0, rig: 0 },
    { kind: "write", slot: 2, rig: 2 },
  ],
  // 4: re-claim the released rig (slot reuse) and restart slot 0 (a camera cut).
  [
    { kind: "claim", rig: 1 },
    { kind: "restart", slot: 0 },
    { kind: "write", slot: 0, rig: 0 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
  ],
  // 5: an ordinary frame.
  [
    { kind: "write", slot: 0, rig: 0 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
  ],
  // 6: grow the batch by one new rig.
  [
    { kind: "claim", rig: 3 },
    { kind: "write", slot: 0, rig: 0 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
    { kind: "write", slot: 3, rig: 3 },
  ],
  // 7: free slot 0.
  [
    { kind: "release", rig: 0 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
    { kind: "write", slot: 3, rig: 3 },
  ],
  // 8: a different rig reuses slot 0.
  [
    { kind: "claim", rig: 4 },
    { kind: "write", slot: 0, rig: 4 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
    { kind: "write", slot: 3, rig: 3 },
  ],
  // 9: restart slot 3 (a reused skeleton), then write.
  [
    { kind: "restart", slot: 3 },
    { kind: "write", slot: 0, rig: 4 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
    { kind: "write", slot: 3, rig: 3 },
  ],
  // 10: fill the batch, then a claim that must fail because it is full.
  [
    { kind: "claim", rig: 5 },
    { kind: "write", slot: 4, rig: 5 },
    { kind: "write", slot: 0, rig: 4 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
    { kind: "write", slot: 3, rig: 3 },
    { kind: "claim", rig: 0 },
  ],
  // 11: hide and release, ending with two free slots.
  [
    { kind: "hide", slot: 4 },
    { kind: "release", rig: 4 },
    { kind: "write", slot: 1, rig: 1 },
    { kind: "write", slot: 2, rig: 2 },
    { kind: "write", slot: 3, rig: 3 },
  ],
];

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
const rng = mulberry32(0x5180c0de);
const randomQuat = (): number[] => {
  const x = rng() * 2 - 1;
  const y = rng() * 2 - 1;
  const z = rng() * 2 - 1;
  const w = rng() * 2 - 1;
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
};

const POSES: number[][][] = [];
for (let frame = 0; frame < FRAMES; frame += 1) {
  const rigPoses: number[][] = [];
  for (let rig = 0; rig < RIG_COUNT; rig += 1) {
    const pose: number[] = [];
    for (let bone = 0; bone < BONES; bone += 1) {
      pose.push(rng() * 4 - 2, rng() * 4 - 2, rng() * 4 - 2);
      pose.push(...randomQuat());
      pose.push(0.4 + rng() * 1.2, 0.4 + rng() * 1.2, 0.4 + rng() * 1.2);
    }
    rigPoses.push(pose);
  }
  POSES.push(rigPoses);
}

// ------------------------------------------------------------------------ replay

interface IFrameRecord {
  ops: IOp[];
  poses: number[][];
  palette: number[];
  history: number[];
  used: number;
  free: number[];
  fresh: number[];
  collapsed: number[];
  skeletonUpdates: number;
  writes: number;
}

let cumulativeUpdates = 0;
let cumulativeWrites = 0;
let writtenCalls = 0;
const updatesBySkeleton = new Map<Skeleton, number>();
for (const rig of RIGS) {
  const skeleton = rig.skeleton;
  const original = skeleton.update.bind(skeleton);
  skeleton.update = (): void => {
    updatesBySkeleton.set(skeleton, (updatesBySkeleton.get(skeleton) ?? 0) + 1);
    original();
  };
}

const batch = new SkinnedBatch({
  first: RIGS[0]?.mesh as SkinnedMesh,
  capacity: CAPACITY,
  velocity: true,
});
const records: IFrameRecord[] = [];

for (let frame = 0; frame < FRAMES; frame += 1) {
  batch.begin();
  const poses = POSES[frame] as number[][];
  RIGS.forEach((rig, index) => {
    const pose = poses[index] as number[];
    for (let bone = 0; bone < BONES; bone += 1) {
      const b = rig.bones[bone] as Bone;
      const at = bone * 10;
      b.position.set(pose[at] as number, pose[at + 1] as number, pose[at + 2] as number);
      b.quaternion.set(
        pose[at + 3] as number,
        pose[at + 4] as number,
        pose[at + 5] as number,
        pose[at + 6] as number,
      );
      b.scale.set(pose[at + 7] as number, pose[at + 8] as number, pose[at + 9] as number);
    }
    rig.mesh.updateMatrixWorld(true);
  });

  const resolved: IOp[] = [];
  const fresh: number[] = [];
  const collapsed: number[] = [];
  for (const op of SCRIPT[frame] as IOp[]) {
    if (op.kind === "claim") {
      const slot = batch.claim((RIGS[op.rig as number] as IRig).mesh);
      resolved.push({ kind: "claim", rig: op.rig, slot: slot ?? -1 });
      if (slot !== undefined) fresh.push(slot);
    } else if (op.kind === "release") {
      const rig = RIGS[op.rig as number] as IRig;
      const slot = batch.instances.get(rig.mesh) ?? -1;
      batch.release(rig.mesh);
      resolved.push({ kind: "release", rig: op.rig, slot });
      collapsed.push(slot);
    } else if (op.kind === "hide") {
      batch.hide(op.slot as number);
      resolved.push({ kind: "hide", slot: op.slot });
      collapsed.push(op.slot as number);
    } else if (op.kind === "restart") {
      batch.restart(op.slot as number);
      resolved.push({ kind: "restart", slot: op.slot });
      fresh.push(op.slot as number);
    } else {
      const rig = RIGS[op.rig as number] as IRig;
      for (let pass = 0; pass < (op.times ?? 1); pass += 1) {
        batch.write(op.slot as number, rig.mesh);
        writtenCalls += 1;
        resolved.push({ kind: "write", slot: op.slot, rig: op.rig });
      }
    }
  }
  batch.end();

  const palette: number[] = [];
  for (const value of batch.palette) palette.push(f32bits(value));
  const history: number[] = [];
  for (const value of batch.history as Float32Array) history.push(f32bits(value));

  let totalUpdates = 0;
  for (const count of updatesBySkeleton.values()) totalUpdates += count;

  records.push({
    ops: resolved,
    poses,
    palette,
    history,
    used: batch.used,
    free: [...batch.free],
    fresh,
    collapsed,
    skeletonUpdates: totalUpdates - cumulativeUpdates,
    writes: writtenCalls - cumulativeWrites,
  });
  cumulativeUpdates = totalUpdates;
  cumulativeWrites = writtenCalls;
}

// ------------------------------------------------------------------------ isSimilarityTransform table

const similarity: Matrix4[] = [
  new Matrix4(),
  new Matrix4().makeTranslation(1, 2, 3),
  new Matrix4().makeRotationY(1).scale(new Vector3(2, 2, 2)),
  new Matrix4().makeRotationX(-0.7).multiply(new Matrix4().makeScale(0.5, 0.5, 0.5)),
  new Matrix4().makeRotationZ(0.9).multiply(new Matrix4().makeScale(0.001, 0.001, 0.001)),
  new Matrix4().makeScale(2, 2.0000001, 2),
  new Matrix4().makeScale(2, 2.0001, 2),
  new Matrix4().makeScale(1, 2, 1),
  new Matrix4().makeScale(0, 0, 0),
  new Matrix4().makeScale(1e-9, 1e-9, 1e-9),
  new Matrix4().makeScale(1e-6, 1e-6, 1e-6),
  new Matrix4().makeScale(-1, 1, 1),
  new Matrix4().makeScale(-2, -2, -2),
  new Matrix4().makeShear(0.3, 0, 0, 0, 0, 0),
  new Matrix4().makeShear(1e-6, 0, 0, 0, 0, 0),
  new Matrix4().fromArray([1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
  new Matrix4().fromArray([1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1]),
  new Matrix4()
    .makeRotationAxis(new Vector3(1, 1, 1).normalize(), 2.1)
    .multiply(new Matrix4().makeScale(3, 3, 3)),
  new Matrix4().makeRotationX(0.2).multiply(new Matrix4().makeScale(0.5, 0.5, 1.5)),
  new Matrix4().makeScale(4, 4, 4).setPosition(9, -8, 7),
  new Matrix4().makeRotationY(-1.3).multiply(new Matrix4().makeScale(2, -2, 2)),
];
const similarityResults = similarity.map((matrix) =>
  isSimilarityTransform(matrix.elements) ? 1 : 0,
);

// ------------------------------------------------------------------------ emit

const lines: string[] = [];
lines.push(
  "// Generated by packages/runtime-native/tests/native-engine/animation/skinned-palette-reference.ts.",
  "// Do not edit: rerun the generator. Palette and history are the float bits of SkinnedBatch at",
  "// three@0.185.1; every double is its exact bit pattern.",
  "struct PaletteBone { int parent; double t[3]; double q[4]; double s[3]; };",
  "struct PaletteRig { const char* name; int boneCount; const PaletteBone* bones; const double* inverses; int attached; const double* bindMatrix; const double* bindMatrixInverse; const double* matrixWorld; };",
  "struct PaletteOp { int kind; int rig; int slot; };",
  "struct PaletteFrame { const double* poses; int opCount; const PaletteOp* ops; const unsigned int* palette; const unsigned int* history; int used; int freeCount; const int* free; int freshCount; const int* fresh; int collapsedCount; const int* collapsed; int skeletonUpdates; int writes; };",
  "",
);

RIGS.forEach((rig, index) => {
  lines.push(`static const PaletteBone kBonesRig${index}[] = {`);
  rig.bones.forEach((bone, boneIndex) => {
    const parent = boneIndex === 0 ? -1 : boneIndex - 1;
    const { x: px, y: py, z: pz } = bone.position;
    const { x: qx, y: qy, z: qz, w: qw } = bone.quaternion;
    const { x: sx, y: sy, z: sz } = bone.scale;
    lines.push(
      `    {${parent}, {${d(px)}, ${d(py)}, ${d(pz)}}, {${d(qx)}, ${d(qy)}, ${d(qz)}, ${d(qw)}}, {${d(sx)}, ${d(sy)}, ${d(sz)}}},`,
    );
  });
  lines.push("};");
  lines.push(
    `static const double kInversesRig${index}[] = {${rig.skeleton.boneInverses
      .flatMap((matrix: Matrix4) => Array.from(matrix.elements as number[]))
      .map(d)
      .join(", ")}};`,
  );
  lines.push(
    `static const double kBindMatrixRig${index}[] = {${Array.from(rig.mesh.bindMatrix.elements).map(d).join(", ")}};`,
  );
  lines.push(
    `static const double kBindInverseRig${index}[] = {${Array.from(rig.mesh.bindMatrixInverse.elements).map(d).join(", ")}};`,
  );
  lines.push(
    `static const double kWorldRig${index}[] = {${Array.from(rig.mesh.matrixWorld.elements).map(d).join(", ")}};`,
  );
  lines.push(
    `static const PaletteRig kRig${index} = {${JSON.stringify(rig.name)}, ${BONES}, kBonesRig${index}, kInversesRig${index}, ${rig.mesh.bindMode === "detached" ? 0 : 1}, kBindMatrixRig${index}, kBindInverseRig${index}, kWorldRig${index}};`,
  );
});

records.forEach((record, frame) => {
  const poses = record.poses.flat();
  lines.push(`static const double kPoses${frame}[] = {${poses.map(d).join(", ")}};`);
  lines.push(`static const PaletteOp kOpList${frame}[] = {`);
  for (const op of record.ops) {
    const kind = { claim: 0, release: 1, hide: 2, restart: 3, write: 4 }[op.kind];
    lines.push(`    {${kind}, ${op.rig ?? -1}, ${op.slot ?? -1}},`);
  }
  lines.push("};");
  lines.push(
    `static const unsigned int kPalette${frame}[] = {${record.palette.map(h32).join(", ")}};`,
  );
  lines.push(
    `static const unsigned int kHistory${frame}[] = {${record.history.map(h32).join(", ")}};`,
  );
  const ints = (values: number[]): string => (values.length > 0 ? `{${values.join(", ")}}` : "{0}");
  lines.push(`static const int kFree${frame}[] = ${ints(record.free)};`);
  lines.push(`static const int kFresh${frame}[] = ${ints(record.fresh)};`);
  lines.push(`static const int kCollapsed${frame}[] = ${ints(record.collapsed)};`);
  lines.push(
    `static const PaletteFrame kFrame${frame} = {kPoses${frame}, ${record.ops.length}, kOpList${frame}, kPalette${frame}, kHistory${frame}, ${record.used}, ${record.free.length}, kFree${frame}, ${record.fresh.length}, kFresh${frame}, ${record.collapsed.length}, kCollapsed${frame}, ${record.skeletonUpdates}, ${record.writes}};`,
  );
});

const simFlat: number[] = similarity.flatMap((matrix: Matrix4) =>
  Array.from(matrix.elements as number[]),
);
lines.push(`static const double kSimilarityMatrices[] = {${simFlat.map(d).join(", ")}};`);
lines.push(`static const int kSimilarityExpected[] = {${similarityResults.join(", ")}};`);
lines.push(`static const int kSimilarityCount = ${similarity.length};`);
lines.push("");
lines.push("static const PaletteRig kRigs[] = {");
lines.push(...RIGS.map((_, index) => `    kRig${index},`));
lines.push("};");
lines.push(`static const int kRigCount = ${RIGS.length};`);
lines.push("static const PaletteFrame kFrames[] = {");
lines.push(...records.map((_, frame) => `    kFrame${frame},`));
lines.push("};");
lines.push(`static const int kFrameCount = ${records.length};`);
lines.push(`static const int kPaletteBones = ${BONES};`);
lines.push(`static const int kPaletteCapacity = ${CAPACITY};`);
lines.push("static const int kPaletteVelocity = 1;");
lines.push("");

const text = `${lines.join("\n")}\n`;

if (process.argv.includes("--check")) {
  let current: string;
  try {
    current = readFileSync(OUT, "utf8");
  } catch {
    console.error(`TN_FIXTURE_MISSING: ${path.relative(process.cwd(), OUT)}`);
    process.exit(1);
  }
  if (current !== text) {
    console.error(
      `TN_FIXTURE_STALE: ${path.relative(process.cwd(), OUT)} is not what SkinnedBatch produces`,
    );
    process.exit(1);
  }
  console.log(`current: ${RIGS.length} rigs, ${records.length} frames`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${RIGS.length} rigs, ${records.length} frames`);
}
