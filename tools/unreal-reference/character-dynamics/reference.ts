/**
 * PRD-910 Phase 3: the Unreal Engine 5.8.3 reference for examples/character-dynamics.
 *
 *   pnpm exec tsx tools/unreal-reference/character-dynamics/reference.ts [stage]
 *
 * Stages (default `all`, in this order):
 *   prepare  mannequin.glb -> Saved/gen/body.glb, Saved/gen/mannequin_cape.glb, Saved/gen/cape.json.
 *            The cape is the game's grid (game.ts: 0.5 m x 0.62*height, 10x18 segments, top row
 *            pinned) placed on spine_03 in the Idle_Loop t=0 pose, skinned 100% to spine_03.
 *   build    editor: build_scene.py imports both GLBs, makes the Chaos Cloth asset, writes scene.json.
 *   drive    Saved/gen/drive.json: the game.ts SCRIPT replayed tick by tick (root motion, clip
 *            plays), mapped into Unreal space with the bone fit from scene.json.
 *   run      editor: build_scene.py plays drive.json 3 times at a fixed 1/60 s step.
 *   metrics  Saved/runs/run-N.json -> reference.json, with the game's own probe math (probe.ts).
 *
 * The ponytail (PRD-912 AC-3) is the game's 6-bone chain under Head, added in `prepare` to the caped
 * mesh only, and simulated by stock FAnimNode_SpringBone nodes in the CharDynProbe anim proxy.
 *
 * The probe definitions are the game's: hem and top rows, the body frame (the cape frame on
 * spine_03), and the free cape vertices deeper than the 1 cm collider thickness inside the capsules
 * the cloth collides with (game.ts: countInsideCapsules(free, pose.capsules, COLLIDER_THICKNESS)).
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Document, type Node as GltfNode, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dequantize } from "@gltf-transform/functions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");
const EXAMPLE = path.join(REPO, "examples/character-dynamics");
const GEN = path.join(HERE, "Saved/gen");
const RUNS = path.join(HERE, "Saved/runs");
const UPROJECT = path.join(HERE, "CharacterDynamicsReference.uproject");
const RUN_COUNT = 3;

// three and the probe load from the example that owns them (the same ESM three probe.ts imports).
const THREE = (await import(
  pathToFileURL(path.join(EXAMPLE, "node_modules/three/build/three.module.js")).href
)) as typeof import("three");
const probe = (await import(
  pathToFileURL(path.join(EXAMPLE, "src/probe.ts")).href
)) as typeof import("../../../examples/character-dynamics/src/probe.js");
const { Matrix4, Quaternion, Vector3 } = THREE;
type Matrix4 = InstanceType<typeof Matrix4>;
type Vector3 = InstanceType<typeof Vector3>;

// --- the game.ts script (kept literal so a diff against game.ts reads line by line) ---------
const STEP = 1 / 60;
const GRAVITY = 9.81;
const ACCELERATION = 8;
const BRAKING = 12;
interface IPhase {
  readonly name: string;
  readonly ticks: number;
  readonly clip: string;
  readonly speed: number;
  readonly yawRate?: number;
  readonly jumpSpeed?: number;
  readonly snapYaw?: number;
  readonly teleport?: number;
}
const SCRIPT: readonly IPhase[] = [
  { name: "settle", ticks: 90, clip: "Idle_Loop", speed: 0 },
  { name: "jog", ticks: 90, clip: "Jog_Fwd_Loop", speed: 3.4 },
  { name: "jogTurn", ticks: 120, clip: "Jog_Fwd_Loop", speed: 3.4, yawRate: 1.5 },
  { name: "sprint", ticks: 90, clip: "Sprint_Loop", speed: 5.6 },
  { name: "hardStop", ticks: 60, clip: "Idle_Loop", speed: 0 },
  { name: "jump", ticks: 75, clip: "Jump_Loop", speed: 0, jumpSpeed: 4.2 },
  { name: "snapTurn", ticks: 45, clip: "Idle_Loop", speed: 0, snapYaw: Math.PI },
  { name: "teleport", ticks: 45, clip: "Idle_Loop", speed: 0, teleport: 8 },
];
const COLS = 11;
const ROWS = 19;
const CAPE_WIDTH = 0.5;
const METRICS = [
  "hemOffset",
  "hemTrail",
  "maxStretch",
  "bodyPenetration",
  "hairTipOffset",
  "hairStretch",
  "hairInsideHead",
] as const;
/** game.ts: ponytail_1 .. ponytail_6 under Head. */
const HAIR_BONES = 6;
/** game.ts measureHair: the clearance countInsideCapsules adds to each hair collider. */
const HAIR_THICKNESS = 0.005;
/** game.ts COLLIDER_THICKNESS, metres: the probe's shrink and the rest clearance of every capsule. */
const COLLIDER_THICKNESS = 0.01;

function fail(message: string): never {
  throw new Error(`TN_UE_CHARDYN ${message}`);
}

function readJson<T>(file: string): T {
  if (!existsSync(file)) fail(`missing ${path.relative(REPO, file)}; run the earlier stage first`);
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

// --- prepare ------------------------------------------------------------------------------
function parentOf(node: GltfNode): GltfNode | undefined {
  return node.listParents().find((p) => p.propertyType === "Node") as GltfNode | undefined;
}

function localMatrix(t: number[], r: number[], s: number[]): Matrix4 {
  return new Matrix4().compose(
    new Vector3(t[0], t[1], t[2]),
    new Quaternion(r[0], r[1], r[2], r[3]),
    new Vector3(s[0], s[1], s[2]),
  );
}

/** World matrices of every node for a pose (node -> local TRS override). */
function worldMatrices(
  doc: Document,
  pose: Map<GltfNode, { t?: number[]; r?: number[]; s?: number[] }>,
) {
  const out = new Map<GltfNode, Matrix4>();
  const world = (node: GltfNode): Matrix4 => {
    const cached = out.get(node);
    if (cached) return cached;
    const o = pose.get(node) ?? {};
    const local = localMatrix(
      o.t ?? node.getTranslation(),
      o.r ?? node.getRotation(),
      o.s ?? node.getScale(),
    );
    const parent = parentOf(node);
    const m = parent ? world(parent).clone().multiply(local) : local;
    out.set(node, m);
    return m;
  };
  for (const node of doc.getRoot().listNodes()) world(node);
  return out;
}

/** Idle_Loop at t = 0: the first keyframe of each LINEAR channel (all inputs start at 0). */
function idlePose(doc: Document) {
  const clip = doc
    .getRoot()
    .listAnimations()
    .find((a) => a.getName() === "Idle_Loop");
  if (!clip) fail("Idle_Loop missing");
  const pose = new Map<GltfNode, { t?: number[]; r?: number[]; s?: number[] }>();
  for (const channel of clip.listChannels()) {
    const sampler = channel.getSampler();
    const node = channel.getTargetNode();
    if (!sampler || !node) continue;
    if (sampler.getInterpolation() !== "LINEAR") fail("only LINEAR channels are handled");
    const input = sampler.getInput();
    if (!input || input.getElement(0, [])[0] !== 0) fail("a channel does not start at t = 0");
    const value = sampler.getOutput()?.getElement(0, []) ?? fail("empty channel");
    const entry = pose.get(node) ?? {};
    const key = { translation: "t", rotation: "r", scale: "s" }[channel.getTargetPath() as string];
    if (key) (entry as Record<string, number[]>)[key] = value;
    pose.set(node, entry);
  }
  return pose;
}

async function prepare(): Promise<void> {
  mkdirSync(GEN, { recursive: true });
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(path.join(EXAMPLE, "public/mannequin.glb"));
  await doc.transform(dequantize());
  const root = doc.getRoot();
  const skin = root.listSkins()[0] ?? fail("no skin");
  const joints = skin.listJoints();
  const byName = (name: string) =>
    root.listNodes().find((n) => n.getName() === name) ?? fail(`bone ${name} missing`);

  // gltfpack folds the position dequantisation into the inverse bind matrices. Bake it into the
  // vertices so the bind pose is the rest pose in metres, which every importer reads the same way.
  const rest = worldMatrices(doc, new Map());
  const ibmAccessor = skin.getInverseBindMatrices() ?? fail("no inverse bind matrices");
  const ibm = (j: number) => new Matrix4().fromArray(ibmAccessor.getElement(j, []));
  const dequant = (rest.get(joints[0] as GltfNode) as Matrix4).clone().multiply(ibm(0));
  for (let j = 0; j < joints.length; j++) {
    const d = (rest.get(joints[j] as GltfNode) as Matrix4).clone().multiply(ibm(j));
    for (let k = 0; k < 16; k++)
      if (Math.abs((d.elements[k] as number) - (dequant.elements[k] as number)) > 1e-4)
        fail(`joint ${j} bind pose differs from its rest pose; baking would move it`);
  }
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(dequant);
  for (const mesh of root.listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION") ?? fail("no POSITION");
      const nor = prim.getAttribute("NORMAL");
      const v = new Vector3();
      for (let i = 0; i < pos.getCount(); i++) {
        pos.setElement(i, v.fromArray(pos.getElement(i, [])).applyMatrix4(dequant).toArray());
        if (nor)
          nor.setElement(
            i,
            v.fromArray(nor.getElement(i, [])).applyMatrix3(normalMatrix).normalize().toArray(),
          );
      }
    }
  for (let j = 0; j < joints.length; j++)
    ibmAccessor.setElement(
      j,
      (rest.get(joints[j] as GltfNode) as Matrix4).clone().invert().toArray(),
    );
  await io.write(path.join(GEN, "body.glb"), doc);

  // The game's cape, measured exactly as game.ts measures it on the Idle_Loop t = 0 pose.
  const t0 = worldMatrices(doc, idlePose(doc));
  const at = (name: string) => new Vector3().setFromMatrixPosition(t0.get(byName(name)) as Matrix4);
  const facing = at("ball_l").sub(at("foot_l")).setY(0).normalize();
  const height = at("Head").y;
  const spineWorld = at("spine_03");
  const capeLength = 0.62 * height;
  const capeWorld = spineWorld
    .clone()
    .addScaledVector(facing, -0.09 * height)
    .setY(spineWorld.y + 0.08 * height);
  // capeMatrix at t = 0 is a pure translation: boneQ * offsetQ = boneQ * boneQ^-1.
  const spineRest = rest.get(byName("spine_03")) as Matrix4;
  const toBind = spineRest
    .clone()
    .multiply((t0.get(byName("spine_03")) as Matrix4).clone().invert());
  const local: number[] = [];
  for (let iy = 0; iy < ROWS; iy++)
    for (let ix = 0; ix < COLS; ix++)
      local.push(
        ix * (CAPE_WIDTH / (COLS - 1)) - CAPE_WIDTH / 2,
        -iy * (capeLength / (ROWS - 1)),
        0,
      );
  const count = COLS * ROWS;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const jointsAttr = new Uint8Array(count * 4);
  const weights = new Float32Array(count * 4);
  const spineJoint = joints.indexOf(byName("spine_03"));
  const bindNormal = new Vector3(0, 0, 1).transformDirection(toBind);
  const v = new Vector3();
  for (let i = 0; i < count; i++) {
    v.fromArray(local, i * 3)
      .add(capeWorld)
      .applyMatrix4(toBind)
      .toArray(positions, i * 3);
    bindNormal.toArray(normals, i * 3);
    // UV0 carries the grid id (column, row) so the Unreal side can name every cloth particle.
    uvs[i * 2] = i % COLS;
    uvs[i * 2 + 1] = Math.floor(i / COLS);
    jointsAttr[i * 4] = spineJoint;
    weights[i * 4] = 1;
  }
  // PlaneGeometry's index and its spring list (game.ts: unique triangle edges in order).
  const index: number[] = [];
  for (let iy = 0; iy < ROWS - 1; iy++)
    for (let ix = 0; ix < COLS - 1; ix++) {
      const a = ix + COLS * iy;
      const b = ix + COLS * (iy + 1);
      const c = ix + 1 + COLS * (iy + 1);
      const d = ix + 1 + COLS * iy;
      index.push(a, b, d, b, c, d);
    }
  const springs: number[] = [];
  const restLengths: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < index.length; t += 3)
    for (const [p, q] of [
      [0, 1],
      [1, 2],
      [2, 0],
    ] as const) {
      const i = index[t + p] as number;
      const j = index[t + q] as number;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (seen.has(key)) continue;
      seen.add(key);
      springs.push(i, j);
      restLengths.push(
        Math.hypot(
          (local[i * 3] as number) - (local[j * 3] as number),
          (local[i * 3 + 1] as number) - (local[j * 3 + 1] as number),
        ),
      );
    }
  const buffer = root.listBuffers()[0];
  const accessor = (
    array: Float32Array | Uint8Array | Uint32Array,
    type: "VEC2" | "VEC3" | "VEC4" | "SCALAR",
  ) =>
    doc
      .createAccessor()
      .setArray(array)
      .setType(type)
      .setBuffer(buffer ?? null);
  const material = doc
    .createMaterial("M_Cape")
    .setDoubleSided(true)
    .setBaseColorFactor([0.7, 0.15, 0.18, 1]);
  const cape = doc
    .createPrimitive()
    .setMaterial(material)
    .setIndices(accessor(new Uint32Array(index), "SCALAR"))
    .setAttribute("POSITION", accessor(positions, "VEC3"))
    .setAttribute("NORMAL", accessor(normals, "VEC3"))
    .setAttribute("TEXCOORD_0", accessor(uvs, "VEC2"))
    .setAttribute("JOINTS_0", accessor(jointsAttr, "VEC4"))
    .setAttribute("WEIGHTS_0", accessor(weights, "VEC4"));
  (root.listMeshes()[0] ?? fail("no mesh")).addPrimitive(cape);

  // The game's ponytail (game.ts): 6 bones under Head, placed on the Idle_Loop t = 0 pose with the
  // root 12 cm back and 15 cm up from Head, then 5 cm back and 6 cm down per bone, each with the
  // rotation of its parent. Only the caped mesh gets them, so body.glb's physics asset is unchanged.
  const back = facing.clone().negate();
  const anchor = at("Head");
  let parentT0 = (t0.get(byName("Head")) as Matrix4).clone();
  let parentRest = (rest.get(byName("Head")) as Matrix4).clone();
  let parentNode = byName("Head");
  const ibmArray = Array.from(ibmAccessor.getArray() ?? fail("no inverse bind array"));
  for (let index = 0; index < HAIR_BONES; index++) {
    anchor.add(
      index === 0
        ? back.clone().multiplyScalar(0.12).setY(0.15)
        : back.clone().multiplyScalar(0.05).setY(-0.06),
    );
    const local = anchor.clone().applyMatrix4(parentT0.clone().invert());
    const bone = doc.createNode(`ponytail_${index + 1}`).setTranslation(local.toArray());
    parentNode.addChild(bone);
    skin.addJoint(bone);
    const localM = new Matrix4().makeTranslation(local);
    parentT0 = parentT0.multiply(localM);
    parentRest = parentRest.multiply(localM);
    ibmArray.push(...parentRest.clone().invert().toArray());
    parentNode = bone;
  }
  ibmAccessor.setArray(new Float32Array(ibmArray));
  await io.write(path.join(GEN, "mannequin_cape.glb"), doc);

  const restBones: Record<string, number[]> = {};
  for (const joint of joints)
    restBones[joint.getName()] = new Vector3()
      .setFromMatrixPosition(rest.get(joint) as Matrix4)
      .toArray();
  const left = at("thigh_l").sub(at("thigh_r")).setY(0).normalize();
  writeFileSync(
    path.join(GEN, "cape.json"),
    `${JSON.stringify({ height, capeLength, capeWorld: capeWorld.toArray(), facing: facing.toArray(), left: left.toArray(), springs, restLengths, restBones }, null, 1)}\n`,
  );
  console.log(
    `TN_UE_CHARDYN prepare height=${height.toFixed(4)} m cape=${CAPE_WIDTH}x${capeLength.toFixed(4)} m springs=${restLengths.length}`,
  );
}

// --- the three -> Unreal map, fitted on the rest pose ---------------------------------------
interface IScene {
  readonly refBones: Record<string, number[]>;
}
interface ICape {
  height: number;
  capeLength: number;
  capeWorld: number[];
  facing: number[];
  springs: number[];
  restLengths: number[];
  restBones: Record<string, number[]>;
}

/** Least-squares affine fit ue = A * three + t over every shared bone, checked to be a scaled isometry. */
function fitMap(cape: ICape, scene: IScene) {
  const names = Object.keys(cape.restBones).filter((n) => scene.refBones[n] !== undefined);
  if (names.length < 8) fail(`only ${names.length} bones shared between glTF and Unreal`);
  // Normal equations for each Unreal axis: [x y z 1] * coeffs = ue_axis.
  const rows = names.map((n) => [...(cape.restBones[n] as number[]), 1]);
  const solve = (axis: number) => {
    const m = Array.from({ length: 4 }, () => new Array(5).fill(0) as number[]);
    for (const [k, n] of names.entries()) {
      const r = rows[k] as number[];
      const y = (scene.refBones[n] as number[])[axis] as number;
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) (m[i] as number[])[j] += (r[i] as number) * (r[j] as number);
        (m[i] as number[])[4] += (r[i] as number) * y;
      }
    }
    for (let c = 0; c < 4; c++) {
      let p = c;
      for (let r = c + 1; r < 4; r++)
        if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[p] as number[])[c] as number))
          p = r;
      [m[c], m[p]] = [m[p] as number[], m[c] as number[]];
      for (let r = 0; r < 4; r++) {
        if (r === c) continue;
        const f = ((m[r] as number[])[c] as number) / ((m[c] as number[])[c] as number);
        for (let k = c; k < 5; k++) (m[r] as number[])[k] -= f * ((m[c] as number[])[k] as number);
      }
    }
    return [0, 1, 2, 3].map(
      (i) => ((m[i] as number[])[4] as number) / ((m[i] as number[])[i] as number),
    );
  };
  const coeffs = [solve(0), solve(1), solve(2)];
  // A as a three Matrix4 (column vectors), scale s, rotation-or-reflection U = A / s.
  const A = new Matrix4().set(
    ...(coeffs[0] as [number, number, number, number]),
    ...(coeffs[1] as [number, number, number, number]),
    ...(coeffs[2] as [number, number, number, number]),
    0,
    0,
    0,
    1,
  );
  const scale = Math.cbrt(Math.abs(A.determinant()));
  let residual = 0;
  for (const n of names) {
    const p = new Vector3().fromArray(cape.restBones[n] as number[]).applyMatrix4(A);
    residual = Math.max(
      residual,
      p.distanceTo(new Vector3().fromArray(scene.refBones[n] as number[])),
    );
  }
  // A scaled isometry: A^T A = s^2 I.
  const ata = A.clone().transpose().multiply(A);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) {
      const want = i === j ? scale * scale : 0;
      if (Math.abs((ata.elements[i * 4 + j] as number) - want) > 1e-3 * scale * scale)
        fail("the glTF -> Unreal bone map is not a scaled isometry");
    }
  if (residual > 0.1) fail(`bone fit residual ${residual.toFixed(3)} cm > 0.1 cm`);
  // Yaw about three's +Y must be yaw about Unreal's +Z, or the actor rotation below is wrong.
  if (new Vector3(0, 1, 0).transformDirection(A).z < 0.9999)
    fail("three +Y does not map to Unreal +Z");
  const inverse = A.clone().invert();
  return { A, inverse, scale, residual, bones: names.length };
}

// --- drive --------------------------------------------------------------------------------
interface IPlay {
  clip: string;
  fade: number;
  once: boolean;
}

/** game.ts's frame loop without the cloth: root position, yaw and clip plays per tick. */
function replayScript(facing: Vector3) {
  const ticks: { phase: string; position: number[]; yaw: number; plays: IPlay[] }[] = [];
  const up = new Vector3(0, 1, 0);
  const position = new Vector3();
  let yaw = 0;
  let speed = 0;
  let vy = 0;
  let phaseIndex = 0;
  let phaseTick = 0;
  let pending: IPlay[] = [];
  const play = (clip: string, fade: number, once = false) => pending.push({ clip, fade, once });
  const enterPhase = (phase: IPhase) => {
    if (phase.jumpSpeed !== undefined) {
      vy = phase.jumpSpeed;
      play("Jump_Start", 0.1, true);
    } else play(phase.clip, 0.2);
    if (phase.snapYaw !== undefined) yaw += phase.snapYaw;
    if (phase.teleport !== undefined) position.x += phase.teleport;
  };
  enterPhase(SCRIPT[0] as IPhase);
  const forward = new Vector3();
  while (phaseIndex < SCRIPT.length) {
    const phase = SCRIPT[phaseIndex] as IPhase;
    yaw += (phase.yawRate ?? 0) * STEP;
    forward.copy(facing).applyAxisAngle(up, yaw);
    const accel = phase.speed > speed ? ACCELERATION : BRAKING;
    speed += Math.sign(phase.speed - speed) * Math.min(Math.abs(phase.speed - speed), accel * STEP);
    position.addScaledVector(forward, speed * STEP);
    if (phase.jumpSpeed !== undefined) {
      if (phaseTick === 6) play("Jump_Loop", 0.1);
      if (phaseTick >= 6 && (vy > 0 || position.y > 0)) {
        position.y = Math.max(0, position.y + vy * STEP);
        vy -= GRAVITY * STEP;
        if (position.y === 0 && vy < 0) {
          vy = 0;
          play("Jump_Land", 0.05, true);
        }
      }
    }
    ticks.push({ phase: phase.name, position: position.toArray(), yaw, plays: pending });
    pending = [];
    phaseTick++;
    if (phaseTick >= phase.ticks) {
      phaseIndex++;
      phaseTick = 0;
      if (phaseIndex < SCRIPT.length) enterPhase(SCRIPT[phaseIndex] as IPhase);
    }
  }
  return ticks;
}

function drive(): void {
  const cape = readJson<ICape>(path.join(GEN, "cape.json"));
  const scene = readJson<IScene>(path.join(HERE, "scene.json"));
  const map = fitMap(cape, scene);
  const facing = new Vector3().fromArray(cape.facing);
  // Unreal yaw (degrees, +X toward +Y about +Z) of three's yaw (radians about +Y), measured.
  const yawUe = (yaw: number) => {
    const a = new Vector3(1, 0, 0).transformDirection(map.A);
    const b = new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).transformDirection(map.A);
    return ((Math.atan2(b.y, b.x) - Math.atan2(a.y, a.x)) * 180) / Math.PI;
  };
  const yawSign = Math.sign(yawUe(0.01));
  const ticks = replayScript(facing).map((t) => ({
    phase: t.phase,
    location: new Vector3().fromArray(t.position).applyMatrix4(map.A).toArray(),
    yaw: (yawSign * t.yaw * 180) / Math.PI,
    plays: t.plays,
  }));
  writeFileSync(
    path.join(GEN, "drive.json"),
    `${JSON.stringify({ step: STEP, initialClip: "Idle_Loop", ticks })}\n`,
  );
  console.log(
    `TN_UE_CHARDYN drive ticks=${ticks.length} map scale=${map.scale.toFixed(4)} residual=${map.residual.toFixed(4)} cm bones=${map.bones} yawSign=${yawSign}`,
  );
}

// --- metrics ------------------------------------------------------------------------------
interface ISample {
  cloth: number[];
  spine: number[]; // origin, axis x, axis y, axis z (Unreal world, cm)
  pelvis: number[];
  neck: number[];
  /** The posed capsules the cloth collides with: per capsule a xyz, b xyz, radius (world cm). */
  capsules: number[];
  /** The Head bone frame: origin, axis x, axis y, axis z (Unreal world, cm). */
  headFrame: number[];
  /** ponytail_1 .. ponytail_6 (world cm). */
  hair: number[];
  /** Stock capsules of the bones the ponytail falls onto: a xyz, b xyz, radius (world cm). */
  hairCapsules: number[];
}
interface IRun {
  initial: ISample;
  ticks: ISample[];
  ue: Record<string, unknown>;
}

function metricsOfRun(run: IRun, cape: ICape, map: ReturnType<typeof fitMap>) {
  const toThree = (p: number[], k = 0) =>
    new Vector3(p[k] as number, p[k + 1] as number, p[k + 2] as number).applyMatrix4(map.inverse);
  // A rigid frame in three space from Unreal origin + axes: conjugate by the fitted map.
  const frame = (s: number[]) => {
    const o = toThree(s, 0);
    const axis = (k: number) =>
      new Vector3(s[k] as number, s[k + 1] as number, s[k + 2] as number).transformDirection(
        map.inverse,
      );
    const x = axis(3);
    const y = axis(6);
    const z = axis(9);
    const m = new Matrix4().makeBasis(x, y, z).setPosition(o);
    if (m.determinant() < 0) m.makeBasis(x, y, z.negate()).setPosition(o);
    return m;
  };
  // game.ts: capeMatrix = spine rigid * offset, offset fixed at t = 0 with the cape at capeWorld.
  const offset = frame(run.initial.spine)
    .invert()
    .multiply(new Matrix4().makeTranslation(new Vector3().fromArray(cape.capeWorld)));
  const hem: number[] = [];
  const top: number[] = [];
  for (let i = 0; i < COLS; i++) {
    top.push(i);
    hem.push((ROWS - 1) * COLS + i);
  }
  // The pinned top row follows the skin; game.ts counts only the free rows.
  const free = Array.from({ length: (ROWS - 1) * COLS }, (_, k) => COLS + k);
  const capsulesOf = (flat: number[]) => {
    const out: { a: Vector3; b: Vector3; radius: number }[] = [];
    for (let c = 0; c + 6 < flat.length; c += 7)
      out.push({
        a: toThree(flat, c),
        b: toThree(flat, c + 3),
        radius: (flat[c + 6] as number) / map.scale,
      });
    return out;
  };
  const hairOf = (sample: ISample) => {
    if (sample.hair?.length !== HAIR_BONES * 3) fail("a sample has no hair; rebuild and rerun");
    const out = new Float32Array(HAIR_BONES * 3);
    for (let b = 0; b < HAIR_BONES; b++) toThree(sample.hair, b * 3).toArray(out, b * 3);
    return out;
  };
  // game.ts hairRestLengths: the segment lengths on the Idle_Loop t = 0 pose.
  const restHair = hairOf(run.initial);
  const hairRestLengths = Array.from({ length: HAIR_BONES - 1 }, (_, k) =>
    new Vector3()
      .fromArray(restHair, k * 3)
      .distanceTo(new Vector3().fromArray(restHair, k * 3 + 3)),
  );
  const phases: Record<string, Record<(typeof METRICS)[number] | "samples", number>> = {};
  let restHem: Vector3 | undefined;
  let hairRestTip: Vector3 | undefined;
  let tick = 0;
  for (const phase of SCRIPT) {
    const m = {
      hemOffset: 0,
      hemTrail: 0,
      maxStretch: 0,
      bodyPenetration: 0,
      hairTipOffset: 0,
      hairStretch: 0,
      hairInsideHead: 0,
      samples: 0,
    };
    for (let k = 0; k < phase.ticks; k++) {
      const sample = run.ticks[tick++] ?? fail(`run has only ${tick - 1} ticks`);
      const world = new Float32Array(COLS * ROWS * 3);
      for (let v = 0; v < COLS * ROWS; v++) toThree(sample.cloth, v * 3).toArray(world, v * 3);
      for (const value of world)
        if (!Number.isFinite(value)) fail(`non-finite cloth at tick ${tick}`);
      const toBody = frame(sample.spine).multiply(offset).invert();
      const hemWorld = probe.centroid(world, hem);
      const topWorld = probe.centroid(world, top);
      const hemC = hemWorld.clone().applyMatrix4(toBody);
      if (phase.name === "settle") restHem = hemC.clone();
      if (restHem !== undefined) m.hemOffset = Math.max(m.hemOffset, hemC.distanceTo(restHem));
      m.hemTrail = Math.max(m.hemTrail, probe.trailAngleDegrees(topWorld, hemWorld));
      m.maxStretch = Math.max(
        m.maxStretch,
        probe.maxEdgeStretch(world, cape.springs, cape.restLengths),
      );
      const capsules = capsulesOf(sample.capsules);
      if (capsules.length === 0) fail(`no capsules at tick ${tick}`);
      const freeWorld = new Float32Array(free.length * 3);
      free.forEach((v, k) => freeWorld.set(world.subarray(v * 3, v * 3 + 3), k * 3));
      m.bodyPenetration = Math.max(
        m.bodyPenetration,
        probe.countInsideCapsules(freeWorld, capsules, COLLIDER_THICKNESS),
      );
      // game.ts measureHair: the tip in the Head frame, the segment stretch, and the simulated
      // points (all but the root) inside the head, back and shoulder capsules.
      const hair = hairOf(sample);
      for (const value of hair)
        if (!Number.isFinite(value)) fail(`non-finite hair at tick ${tick}`);
      const tipLocal = new Vector3()
        .fromArray(hair, (HAIR_BONES - 1) * 3)
        .applyMatrix4(frame(sample.headFrame).invert());
      if (phase.name === "settle") hairRestTip = tipLocal.clone();
      if (hairRestTip !== undefined)
        m.hairTipOffset = Math.max(m.hairTipOffset, tipLocal.distanceTo(hairRestTip));
      m.hairStretch = Math.max(m.hairStretch, probe.maxSegmentStretch(hair, hairRestLengths));
      const hairCapsules = capsulesOf(sample.hairCapsules);
      if (hairCapsules.length === 0) fail(`no hair capsules at tick ${tick}`);
      m.hairInsideHead = Math.max(
        m.hairInsideHead,
        probe.countInsideCapsules(hair.subarray(3), hairCapsules, HAIR_THICKNESS),
      );
      m.samples++;
    }
    phases[phase.name] = m;
  }
  if (tick !== run.ticks.length) fail(`run has ${run.ticks.length} ticks, script has ${tick}`);
  return phases;
}

function metrics(): void {
  const cape = readJson<ICape>(path.join(GEN, "cape.json"));
  const scene = readJson<IScene & Record<string, unknown>>(path.join(HERE, "scene.json"));
  const map = fitMap(cape, scene);
  const runs = Array.from({ length: RUN_COUNT }, (_, r) =>
    readJson<IRun>(path.join(RUNS, `run-${r + 1}.json`)),
  );
  const perRun = runs.map((run) => metricsOfRun(run, cape, map));
  const phases: Record<string, Record<string, unknown>> = {};
  for (const phase of SCRIPT) {
    const entry: Record<string, unknown> = { ticks: phase.ticks };
    for (const metric of METRICS) {
      const values = perRun.map((p) => (p[phase.name] as Record<string, number>)[metric] as number);
      entry[metric] = {
        mean: values.reduce((a, b) => a + b, 0) / values.length,
        min: Math.min(...values),
        max: Math.max(...values),
        runs: values,
      };
    }
    phases[phase.name] = entry;
  }
  const record = {
    prd: "PRD-910",
    scene: "examples/character-dynamics (?arm=cloth probe definitions)",
    unreal: scene.unreal,
    command: "pnpm exec tsx tools/unreal-reference/character-dynamics/reference.ts all",
    runs: RUN_COUNT,
    step: STEP,
    units: {
      hemOffset: "m",
      hemTrail: "deg",
      maxStretch: "fraction of rest length",
      bodyPenetration: "cape vertices",
      hairTipOffset: "m",
      hairStretch: "fraction of rest length",
      hairInsideHead: "hair bones",
    },
    probe: {
      hem: "bottom row (11 vertices)",
      top: "pinned top row (11 vertices)",
      bodyFrame: "cape frame on spine_03 (game.ts capeMatrix)",
      bodyPenetration: `free cape vertices (rows 1-18) deeper than ${COLLIDER_THICKNESS} m inside the posed physics-asset capsules the cloth collides with`,
      height: cape.height,
      hairTip:
        "ponytail_6 in the Head bone frame; offset from its spot at the end of settle (game.ts measureHair)",
      hairStretch:
        "largest |segment / rest - 1| over ponytail_1..6, rest on the Idle_Loop t = 0 pose",
      hairInsideHead: `ponytail_2..6 inside the stock capsules of Head, spine_03, spine_02, upperarm_l, upperarm_r plus ${HAIR_THICKNESS} m (game.ts also has neck_01; Unreal generates no neck_01 body)`,
    },
    map: { scale: map.scale, residualCm: map.residual, bones: map.bones },
    cloth: scene.cloth,
    // Per capsule: the stock radius, the clearance to the rest cape, and the radius the run used.
    restClearance: (runs[0] as IRun).ue.restClearance,
    overrides: {
      ...(scene.overrides as Record<string, unknown>),
      capsuleRestClearance:
        "every capsule radius = min(stock radius, distance to the nearest rest cape vertex - 1 cm) on the Idle_Loop t = 0 pose, dropped under 0.1 cm (game.ts: measureBodyCapsules(capeSkin, 16, restWorld, COLLIDER_THICKNESS)); applied in RunDrive, in memory, restored after the run",
    },
    determinism:
      "3 separate simulations (a fresh world and fresh clothing actors per run, CharDynProbe RunDrive); Chaos Cloth at a fixed step is deterministic, so the run files are byte-identical and the spread is 0",
    differences: scene.differences,
    hair: {
      node: "FAnimNode_SpringBone, one per simulated bone (ponytail_2..6), parent first, each fed the previous node's pose, driven in UCharDynAnimInstance's proxy; ponytail_1 rides Head (SpringBoneChain3D's root)",
      defaults:
        "stock (UE 5.8.3: Engine/Source/Runtime/AnimGraphRuntime/Private/BoneControllers/AnimNode_SpringBone.cpp:16-38): SpringStiffness 50, SpringDamping 4, ErrorResetThresh 256 cm, bLimitDisplacement false, translate X/Y/Z on, rotate X/Y/Z off; fixed step 1/120 s (:62-63); no gravity, no collision",
      differences:
        "SpringBoneChain3D (game) keeps each segment at its rest length, rotates the bones toward the particles and pushes them out of the body capsules; the stock SpringBone translates the bone only, so segments stretch, and it has no collider. Its damping acts on the world velocity and OwnerVelocity is 0 for an actor's own component (AnimNode_SpringBone.cpp:139-157, 257-266), so each spring trails its target by damping * speed / stiffness (27 cm at 3.4 m/s) and the 5 springs add up. Teleport: SpringBone resets past 256 cm of error, SpringBoneChain3D past 1.5 m of root move or 1 m of error",
      start:
        "the springs are placed on the Idle_Loop t = 0 pose by a zero-length evaluation before tick 1 (InitAnim's zero tick, SkeletalMeshComponent.cpp:1213-1216; the game builds SpringBoneChain3D on that pose)",
    },
    phases,
  };
  writeFileSync(path.join(HERE, "reference.json"), `${JSON.stringify(record, null, 2)}\n`);
  for (const phase of SCRIPT) {
    const p = phases[phase.name] as Record<string, { mean: number; min: number; max: number }>;
    console.log(
      `TN_UE_CHARDYN ${phase.name.padEnd(9)} ${METRICS.map((m) => `${m}=${p[m]?.mean.toFixed(3)} [${p[m]?.min.toFixed(3)}, ${p[m]?.max.toFixed(3)}]`).join(" ")}`,
    );
  }
}

// --- the editor ---------------------------------------------------------------------------
async function editor(mode: "build" | "run"): Promise<void> {
  const ueRoot = process.env.UE_ROOT ?? fail("set UE_ROOT to the Unreal 5.8.3 install");
  const binary = path.join(ueRoot, "Engine/Binaries/Linux/UnrealEditor");
  if (!existsSync(binary)) fail(`${binary} not found`);
  mkdirSync(RUNS, { recursive: true });
  const exitFile = path.join(HERE, "Saved", `${mode}.exit`);
  rmSync(exitFile, { force: true });
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(
      binary,
      [
        UPROJECT,
        "-RenderOffscreen",
        "-unattended",
        "-nosplash",
        "-nosound",
        "-stdout",
        "-FullStdOutLogOutput",
        `-ExecCmds=py ${path.join(HERE, "build_scene.py")}`,
      ],
      {
        env: { ...process.env, TN_UE_MODE: mode, TN_UE_RUNS: String(RUN_COUNT) },
        stdio: ["ignore", "inherit", "inherit"],
      },
    );
    child.once("error", reject);
    child.once("exit", resolve);
  });
  // The editor's own exit status says nothing about the script; the script writes its verdict.
  if (!existsSync(exitFile)) fail(`${mode} wrote no verdict (editor exit ${code})`);
  const verdict = readFileSync(exitFile, "utf8").trim();
  if (verdict !== "0") fail(`${mode} failed: ${verdict}`);
}

const stage = process.argv[2] ?? "all";
const stages: Record<string, () => Promise<void> | void> = {
  prepare,
  build: () => editor("build"),
  drive,
  run: () => editor("run"),
  metrics,
};
if (stage === "all") for (const s of Object.values(stages)) await s();
else await (stages[stage] ?? fail(`unknown stage ${stage}`))();
