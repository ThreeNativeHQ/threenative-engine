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
 *   perturb  editor: the same script 3 more times, each run k starting the cloth particles and the
 *            ponytail chain k * 1e-4 cm off (AC-3 perturbation spread; see `perturbation` in reference.json).
 *   metrics  Saved/runs/run-N.json and perturb-N.json -> reference.json, with the game's own probe math (probe.ts).
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
/** AC-3 perturbation spread: run k starts the cloth particles and ponytail_2..6 k * PERTURB_CM off (CharDynProbe.h). */
const PERTURB_RUNS = [1, 2, 3];
const PERTURB_CM = 1e-4;

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
const HAIR_METRICS = ["hairTipOffset", "hairStretch", "hairInsideHead"] as const;
/** CharDynProbe FCharDynAnimProxy::Dynamics: the FAnimNode_AnimDynamics arms of one run. */
const DYNAMICS_ARMS = ["stock", "swing", "swingWorld"] as const;
/**
 * CharDynProbe FCharDynAnimProxy::SpringArms: recorded FAnimNode_SpringBone chains with option overrides
 * (PRD-912 AC-3 `hairSpringBoneRotate`). rotate = bRotateX/Y/Z; limit* = bLimitDisplacement with
 * MaxDisplacement 3.9 cm (half a rest segment) or 7.8 cm (one).
 */
const SPRING_ARMS = [
  "rotate",
  "limitHalf",
  "limitFull",
  "rotateLimitHalf",
  "rotateLimitFull",
] as const;
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
  /** ponytail_1 .. ponytail_6 (world cm), the SpringBone chain. */
  hair: number[];
  /** ponytail_1 .. ponytail_6 (world cm) per AnimDynamics arm, evaluated beside the springs. */
  hairDynamics?: Record<string, number[]>;
  /** ponytail_1 .. ponytail_6 (world cm) per recorded SpringBone arm with option overrides. */
  hairSpringArms?: Record<string, number[]>;
  /** Proxy updates and evaluations so far: each tick must add one of each (AnimDynamics steps per evaluation). */
  updates?: number;
  evaluations?: number;
  /** Stock capsules of the bones the ponytail falls onto: a xyz, b xyz, radius (world cm). */
  hairCapsules: number[];
}
interface IRun {
  initial: ISample;
  ticks: ISample[];
  ue: Record<string, unknown>;
}

function metricsOfRun(
  run: IRun,
  cape: ICape,
  map: ReturnType<typeof fitMap>,
  /** The unperturbed run's t = 0 SpringBone chain: a perturbed run measures against the same rest lengths. */
  restInitialHair: number[] = run.initial.hair,
) {
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
  const hairOf = (flat: number[] | undefined, what: string) => {
    if (flat?.length !== HAIR_BONES * 3) fail(`a sample has no ${what} hair; rebuild and rerun`);
    const out = new Float32Array(HAIR_BONES * 3);
    for (let b = 0; b < HAIR_BONES; b++) toThree(flat, b * 3).toArray(out, b * 3);
    for (const value of out) if (!Number.isFinite(value)) fail(`non-finite ${what} hair`);
    return out;
  };
  // game.ts hairRestLengths: the segment lengths on the Idle_Loop t = 0 pose.
  const restHair = hairOf(restInitialHair, "SpringBone");
  const hairRestLengths = Array.from({ length: HAIR_BONES - 1 }, (_, k) =>
    new Vector3()
      .fromArray(restHair, k * 3)
      .distanceTo(new Vector3().fromArray(restHair, k * 3 + 3)),
  );
  const phases: Record<string, Record<(typeof METRICS)[number] | "samples", number>> = {};
  // game.ts measureHair, per chain: the tip in the Head frame, the segment stretch, and the
  // simulated points (all but the root) inside the head, back and shoulder capsules.
  type HairMetrics = Record<(typeof HAIR_METRICS)[number], number>;
  const sources = ["springBone", ...DYNAMICS_ARMS, ...SPRING_ARMS] as const;
  const hairPhases = Object.fromEntries(
    sources.map((s) => [s, {} as Record<string, HairMetrics>]),
  ) as Record<(typeof sources)[number], Record<string, HairMetrics>>;
  const hairRestTip: Partial<Record<(typeof sources)[number], Vector3>> = {};
  let restHem: Vector3 | undefined;
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
    for (const source of sources)
      hairPhases[source][phase.name] = { hairTipOffset: 0, hairStretch: 0, hairInsideHead: 0 };
    for (let k = 0; k < phase.ticks; k++) {
      const prev = tick === 0 ? run.initial : (run.ticks[tick - 1] as ISample);
      const sample = run.ticks[tick++] ?? fail(`run has only ${tick - 1} ticks`);
      if (
        sample.updates !== (prev.updates ?? Number.NaN) + 1 ||
        sample.evaluations !== (prev.evaluations ?? Number.NaN) + 1
      )
        fail(`tick ${tick} is not one anim update and one evaluation; rebuild and rerun`);
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
      const toHead = frame(sample.headFrame).invert();
      const hairCapsules = capsulesOf(sample.hairCapsules);
      if (hairCapsules.length === 0) fail(`no hair capsules at tick ${tick}`);
      for (const source of sources) {
        const hair =
          source === "springBone"
            ? hairOf(sample.hair, `tick ${tick} SpringBone`)
            : (SPRING_ARMS as readonly string[]).includes(source)
              ? hairOf(sample.hairSpringArms?.[source], `tick ${tick} SpringBone arm ${source}`)
              : hairOf(sample.hairDynamics?.[source], `tick ${tick} AnimDynamics ${source}`);
        const h = hairPhases[source][phase.name] as HairMetrics;
        const tipLocal = new Vector3().fromArray(hair, (HAIR_BONES - 1) * 3).applyMatrix4(toHead);
        if (phase.name === "settle") hairRestTip[source] = tipLocal.clone();
        const restTip = hairRestTip[source];
        if (restTip !== undefined)
          h.hairTipOffset = Math.max(h.hairTipOffset, tipLocal.distanceTo(restTip));
        h.hairStretch = Math.max(h.hairStretch, probe.maxSegmentStretch(hair, hairRestLengths));
        h.hairInsideHead = Math.max(
          h.hairInsideHead,
          probe.countInsideCapsules(hair.subarray(3), hairCapsules, HAIR_THICKNESS),
        );
      }
      Object.assign(m, hairPhases.springBone[phase.name]);
      m.samples++;
    }
    phases[phase.name] = m;
  }
  if (tick !== run.ticks.length) fail(`run has ${run.ticks.length} ticks, script has ${tick}`);
  return { phases, hairPhases };
}

/** Per phase and metric: mean, min, max and the value of each run. */
function spreads(perRun: Record<string, Record<string, number>>[], metrics: readonly string[]) {
  const phases: Record<string, Record<string, unknown>> = {};
  for (const phase of SCRIPT) {
    const entry: Record<string, unknown> = { ticks: phase.ticks };
    for (const metric of metrics) {
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
  return phases;
}

/**
 * AC-3 perturbation spread: per phase and metric, the value of the unperturbed run and of each
 * perturbed run, with min, max and spread = max - min over all of them. The runs are [unperturbed,
 * perturbed 1, 2, 3], so the spread is the metric's sensitivity to a float-level start change.
 */
function perturbationSpreads(
  perRun: Record<string, Record<string, number>>[],
  metrics: readonly string[],
) {
  const phases: Record<string, Record<string, unknown>> = {};
  for (const phase of SCRIPT) {
    const entry: Record<string, unknown> = {};
    for (const metric of metrics) {
      const runs = perRun.map((p) => (p[phase.name] as Record<string, number>)[metric] as number);
      const min = Math.min(...runs);
      const max = Math.max(...runs);
      entry[metric] = { unperturbed: runs[0], min, max, spread: max - min, runs };
    }
    phases[phase.name] = entry;
  }
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
  const restInitialHair = (runs[0] as IRun).initial.hair;
  const perturbed = PERTURB_RUNS.map((k) =>
    metricsOfRun(readJson<IRun>(path.join(RUNS, `perturb-${k}.json`)), cape, map, restInitialHair),
  );
  const withPerturbed = [perRun[0] as (typeof perRun)[number], ...perturbed];
  const phases = spreads(
    perRun.map((r) => r.phases),
    METRICS,
  );
  const dynamicsArms = Object.fromEntries(
    DYNAMICS_ARMS.map((arm) => [
      arm,
      spreads(
        perRun.map((r) => r.hairPhases[arm]),
        HAIR_METRICS,
      ),
    ]),
  );
  const springArms = Object.fromEntries(
    SPRING_ARMS.map((arm) => [
      arm,
      spreads(
        perRun.map((r) => r.hairPhases[arm]),
        HAIR_METRICS,
      ),
    ]),
  );
  const CAPE_METRICS = ["hemOffset", "hemTrail", "maxStretch", "bodyPenetration"] as const;
  const perturbation = {
    prd: "PRD-911 AC-3 / PRD-912 AC-3",
    why: "Chaos Cloth, FAnimNode_SpringBone and FAnimNode_AnimDynamics are deterministic, so the 3-run spread of the blocks above is 0. A float-level change in the start state is what moves a chaotic system, so this block is the honest spread: the metric over the unperturbed run and 3 perturbed runs",
    rule: `run k (k = ${PERTURB_RUNS.join(", ")}) starts every free cloth particle (all but the pinned top row, grid row 0) k * ${PERTURB_CM} cm along its own fixed unit vector, FRandomStream(1000 + particle index).VRand(), by editing the cloth asset's physical-mesh vertices in memory before the clothing actors are made. It also starts ponytail_2..6 k * ${PERTURB_CM} cm along FRandomStream(90000 + chain index 1..5).VRand() in component space, by moving them in the evaluation that places the chains, so the SpringBone chain, every SpringBone arm and every AnimDynamics arm start off their bones by the same amount. Nothing else changes: same script, same step, same rest lengths (the unperturbed run's)`,
    offsetsCm: PERTURB_RUNS.map((k) => Number((k * PERTURB_CM).toPrecision(12))),
    runs: "[unperturbed, perturbed 1, perturbed 2, perturbed 3]; the unperturbed values equal the 3 identical runs of the blocks above",
    command:
      "pnpm exec tsx tools/unreal-reference/character-dynamics/reference.ts perturb (TN_UE_PERTURB=1,2,3), then metrics",
    cape: perturbationSpreads(
      withPerturbed.map((r) => r.phases),
      CAPE_METRICS,
    ),
    springBone: perturbationSpreads(
      withPerturbed.map((r) => r.hairPhases.springBone),
      HAIR_METRICS,
    ),
    animDynamics: Object.fromEntries(
      DYNAMICS_ARMS.map((arm) => [
        arm,
        perturbationSpreads(
          withPerturbed.map((r) => r.hairPhases[arm]),
          HAIR_METRICS,
        ),
      ]),
    ),
    springBoneRotate: Object.fromEntries(
      SPRING_ARMS.map((arm) => [
        arm,
        perturbationSpreads(
          withPerturbed.map((r) => r.hairPhases[arm]),
          HAIR_METRICS,
        ),
      ]),
    ),
  };
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
    hairAnimDynamics: {
      prd: "PRD-912 AC-3",
      node: "FAnimNode_AnimDynamics, bChain true, BoundBone ponytail_1, ChainEnd ponytail_6: one rigid body per bone, each joined to its parent at the segment midpoint (InitPhysics, AnimNode_AnimDynamics.cpp:1110-1121); ponytail_1's body is nailed to its animated position (bLinearFullyLocked, :1272-1277), so it rides Head and ponytail_2..6 hang from it. Evaluated in UCharDynAnimInstance's proxy on the animated pose, beside the SpringBone chain; the output is recorded, not applied",
      defaults:
        "stock (UE 5.8.3: Engine/Source/Runtime/AnimGraphRuntime/Private/BoneControllers/AnimNode_AnimDynamics.cpp:190-246 and Public/BoneControllers/AnimNode_AnimDynamics.h:91-110, 241-248): one body definition copied to every chain bone (UpdateChainPhysicsBodyDefinitions, :831-866), BoxExtents 10 x 10 x 10 cm, LocalJointOffset 0, CollisionType CoM, linear X/Y/Z Limited 0..0 (locked), angular type Angular with limits 0..0 on X/Y/Z and twist axis X; GravityScale 1 (:195) with the project gravity -980 cm/s2 (PhysicsSettingsCore.cpp:29, AnimPhysicsSolver.cpp:875); linear and angular damping 0.7 (AnimPhysicsSolver.h:56-59), JointBiasFactor 0.3 (:53), mass 1 (AnimPhysicsSolver.cpp:159); NumSolverIterationsPreUpdate 4, PostUpdate 1 (:202-203); SimulationSpace Component (:205); ComponentLinearAccScale and ComponentLinearVelScale 0 (:238-239), SimSpaceAngularAlpha 0 (:183); no linear or angular spring (:219-220), no wind (:215), no planar or spherical limits (none listed; :208-209), so no collision; adaptive substepping off (p.AnimDynamicsAdaptiveSubstep 0, :26), so one step of the tick delta per tick, capped at MaxPhysicsDeltaTime 1/30 s (:691-701, PhysicsSettings.cpp:22)",
      arms: {
        stock: "every value stock",
        swing:
          "named override: AngularLimitsMin/Max -180/+180 on X/Y/Z, the editor's range end (AnimNode_AnimDynamics.h:170-174). ConstrainAngularRange adds no swing limit for a range of 360 degrees (AnimPhysicsSolver.cpp:733-757); twist stays locked (:759-760). The stock 0..0 range locks each body to its parent (:733-736), a rigid chain",
        swingWorld:
          "swing plus the named override SimulationSpace World. Stock Component space passes no component motion to the bodies (ComponentLinearAccScale/VelScale 0, SimSpaceAngularAlpha 0, :600-646), so locomotion and turns do not reach the chain; World space keeps the bodies in the world, as SpringBoneChain3D does. On the first teleport tick the arms get ResetDynamics(TeleportPhysics), what a SetActorLocation with ETeleportType::TeleportPhysics does to an AnimGraph (SkeletalMeshComponent.cpp:5350-5354, AnimInstance.cpp:696-700); the cloth keeps its own teleport guard",
      },
      boxExtents:
        "stock 10 cm cube kept: with mass 1 per body it sets only the inertia, and it is the same order as the 7.8 cm segment; collision is off, so it touches nothing",
      start:
        "Initialize_AnyThread on the Idle_Loop t = 0 pose before tick 1 (ResetSprings), so InitPhysics places every body on its bone with no time debt (AnimNode_AnimDynamics.cpp:248-268, 1002-1196)",
      restLengths: "the SpringBone block's: segment lengths on the Idle_Loop t = 0 pose",
      arm: dynamicsArms,
    },
    phases,
    hairSpringBoneRotate: {
      prd: "PRD-912 AC-3",
      node: "FAnimNode_SpringBone, one per simulated bone (ponytail_2..6), parent first, as the stock chain above, with named option overrides per arm. Each arm runs on its own copy of the animated pose beside the stock chain; its output is recorded, not applied, so the cape and the stock chain do not change",
      why: "SpringBoneChain3D keeps every segment at its rest length and turns the bones. The stock translate-only chain stretches to metres. These are the stock options that bear on that: rotation (bRotateX/Y/Z) and the displacement limit (bLimitDisplacement, MaxDisplacement)",
      notAnOption:
        "translation off: with bTranslateX/Y/Z all false the node returns before it computes anything (AnimNode_SpringBone.cpp:102-105), so rotation alone moves nothing",
      arms: {
        rotate:
          "bRotateX/Y/Z true, everything else stock. The bone turns by the angle between parent-to-target and parent-to-spring (:206-221), and the next bone's target hangs off the turned bone",
        limitHalf:
          "bLimitDisplacement true, MaxDisplacement 3.9 cm (half the 7.81 cm rest segment): the bone stays within 3.9 cm of its target (:177-187), the only stock bound on the stretch",
        limitFull: "bLimitDisplacement true, MaxDisplacement 7.8 cm (one rest segment)",
        rotateLimitHalf: "rotate plus limitHalf",
        rotateLimitFull: "rotate plus limitFull",
      },
      restLengths: "the SpringBone block's: segment lengths on the Idle_Loop t = 0 pose",
      arm: springArms,
    },
    perturbation,
  };
  writeFileSync(path.join(HERE, "reference.json"), `${JSON.stringify(record, null, 2)}\n`);
  for (const phase of SCRIPT) {
    const p = phases[phase.name] as Record<string, { mean: number; min: number; max: number }>;
    console.log(
      `TN_UE_CHARDYN ${phase.name.padEnd(9)} ${METRICS.map((m) => `${m}=${p[m]?.mean.toFixed(3)} [${p[m]?.min.toFixed(3)}, ${p[m]?.max.toFixed(3)}]`).join(" ")}`,
    );
  }
  for (const arm of SPRING_ARMS)
    for (const phase of SCRIPT) {
      const p =
        (
          springArms[arm] as Record<
            string,
            Record<string, { mean: number; min: number; max: number }>
          >
        )[phase.name] ?? {};
      console.log(
        `TN_UE_CHARDYN springBone.${arm.padEnd(15)} ${phase.name.padEnd(9)} ${HAIR_METRICS.map((m) => `${m}=${p[m]?.mean.toFixed(3)}`).join(" ")}`,
      );
    }
  for (const arm of DYNAMICS_ARMS)
    for (const phase of SCRIPT) {
      const p =
        (
          dynamicsArms[arm] as Record<
            string,
            Record<string, { mean: number; min: number; max: number }>
          >
        )[phase.name] ?? {};
      console.log(
        `TN_UE_CHARDYN animDynamics.${arm.padEnd(10)} ${phase.name.padEnd(9)} ${HAIR_METRICS.map((m) => `${m}=${p[m]?.mean.toFixed(3)} [${p[m]?.min.toFixed(3)}, ${p[m]?.max.toFixed(3)}]`).join(" ")}`,
      );
    }
}

// --- the editor ---------------------------------------------------------------------------
async function editor(mode: "build" | "run", extraEnv: Record<string, string> = {}): Promise<void> {
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
        env: { ...process.env, TN_UE_MODE: mode, TN_UE_RUNS: String(RUN_COUNT), ...extraEnv },
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
  perturb: () => editor("run", { TN_UE_PERTURB: PERTURB_RUNS.join(",") }),
  metrics,
};
if (stage === "all") for (const s of Object.values(stages)) await s();
else await (stages[stage] ?? fail(`unknown stage ${stage}`))();
