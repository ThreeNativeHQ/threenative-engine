/// <reference types="vite/client" />
/**
 * Character-dynamics verification scene (PRD epic `docs/PRDs/Unreal/character-dynamics/`).
 *
 * One animated mannequin wears a cape and runs a fixed motion script: idle, jog, turn, sprint,
 * hard stop, jump, snap turn, teleport. The scene measures what a cape must do on a moving body
 * (trail behind on motion, swing on a stop, stay out of the torso, keep its length, survive a
 * teleport) and prints one `TN_CHARACTER_DYNAMICS:` line.
 *
 * `?arm=softbody` (the default today) is the incumbent `SoftBody3D`, given its best shot: it cannot
 * be parented under a bone (reparenting fires `removed`, which detaches it), so its frame follows
 * `spine_03` by hand every tick and its gravity is rotated into that frame.
 */
import { type ICtx, Scene, SkeletalMesh3D, SoftBody3D, defineGame } from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  AmbientLight,
  type AnimationClip,
  type Bone,
  Color,
  DirectionalLight,
  DoubleSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { MeshStandardNodeMaterial } from "three/webgpu";

type Glb = { animations: AnimationClip[]; scene: Object3D };

const STEP = 1 / 60;
const GRAVITY = 9.81;

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

/** The fixed motion script. Speeds in m/s, yaw rate in rad/s. */
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

interface IPhaseMetrics {
  /** Largest hem-centroid move away from its settled spot, in the body (spine_03) frame, metres. */
  hemOffset: number;
  /** Largest angle between the pin-to-hem line and world down, degrees. */
  hemTrail: number;
  /** Largest spring stretch, as a fraction of rest length. */
  maxStretch: number;
  /** Largest number of cloth vertices inside the torso capsule in one sample. */
  bodyPenetration: number;
  samples: number;
}

interface IState extends Record<string, unknown> {
  arm: string;
  phase: string;
  tick: number;
  complete: boolean;
  finite: boolean;
  phases: Record<string, IPhaseMetrics>;
}

function arm(): string {
  const value = new URLSearchParams(globalThis.location?.search ?? "").get("arm") ?? "softbody";
  if (value !== "softbody") throw new Error(`CHARACTER_DYNAMICS_UNKNOWN_ARM arm=${value}`);
  return value;
}

function boneOf(root: Object3D, name: string): Bone {
  const bone = root.getObjectByName(name) as Bone | undefined;
  if (bone === undefined) throw new Error(`CHARACTER_DYNAMICS_BONE_MISSING ${name}`);
  return bone;
}

/** Distance from p to segment ab. */
function segmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a);
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / ab.lengthSq()));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

class CharacterDynamics extends Scene<IState> {
  static override readonly initialState: IState = {
    arm: "softbody",
    phase: "settle",
    tick: 0,
    complete: false,
    finite: true,
    phases: {},
  };

  #model: Glb | undefined;

  override async load(ctx: ICtx<IState>): Promise<void> {
    this.#model = await ctx.assets.model<Glb>("mannequin.glb");
  }

  override enter(ctx: ICtx<IState>) {
    const model = this.#model;
    if (model === undefined) throw new Error("CHARACTER_DYNAMICS_MODEL_NOT_LOADED");
    const armName = arm();
    ctx.scene.background = new Color(0x263346);
    ctx.add(new AmbientLight(0xd5e3ff, 1.6));
    const key = new DirectionalLight(0xffe4c4, 3);
    key.position.set(3, 6, 4);
    ctx.add(key);
    const floor = new Mesh(
      new PlaneGeometry(80, 80, 40, 40),
      new MeshStandardMaterial({ color: 0x526474, roughness: 0.95 }),
    );
    floor.rotation.x = -Math.PI / 2;
    ctx.add(floor);
    // A grid of posts so motion reads in a still frame.
    for (let x = -20; x <= 20; x += 4)
      for (let z = -20; z <= 20; z += 4) {
        const post = new Mesh(
          new PlaneGeometry(0.08, 0.6),
          new MeshStandardMaterial({ color: 0x8aa0b4, side: DoubleSide }),
        );
        post.position.set(x, 0.3, z);
        ctx.add(post);
      }

    const player = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      strideSync: false,
    });
    const character = new Group();
    character.add(player.root);
    ctx.add(character);
    player.play("Idle_Loop");
    player.update(0, true);
    character.updateMatrixWorld(true);

    const spine = boneOf(player.root, "spine_03");
    const pelvis = boneOf(player.root, "pelvis");
    const neck = boneOf(player.root, "neck_01");
    const head = boneOf(player.root, "Head");

    // Facing is measured, not assumed: the foot-to-ball line points forward on any rig.
    const facing = boneOf(player.root, "ball_l")
      .getWorldPosition(new Vector3())
      .sub(boneOf(player.root, "foot_l").getWorldPosition(new Vector3()))
      .setY(0)
      .normalize();
    const bindYaw = Math.atan2(facing.x, facing.z);
    const height = head.getWorldPosition(new Vector3()).y;
    const spineWorld = spine.getWorldPosition(new Vector3());
    const capeWidth = 0.5;
    const capeLength = 0.62 * height;
    const geometry = new PlaneGeometry(capeWidth, capeLength, 10, 18);
    geometry.translate(0, -capeLength / 2, 0);
    const pinned: number[] = [];
    const position = geometry.getAttribute("position");
    for (let vertex = 0; vertex < position.count; vertex++)
      if (Math.abs(position.getY(vertex)) < 1e-6) pinned.push(vertex);

    // Bind offset of the cape frame in the spine bone frame, with the bone's scale removed.
    const boneQ = new Quaternion();
    const boneP = new Vector3();
    const boneS = new Vector3();
    spine.matrixWorld.decompose(boneP, boneQ, boneS);
    const capeWorld = spineWorld
      .clone()
      .addScaledVector(facing, -0.09 * height)
      .setY(spineWorld.y + 0.08 * height);
    const offsetP = capeWorld.clone().sub(boneP).applyQuaternion(boneQ.clone().invert());
    const offsetQ = boneQ.clone().invert();

    const material = new MeshStandardNodeMaterial({
      color: 0xb3262e,
      roughness: 0.8,
      side: DoubleSide,
    });
    const options = {
      pinned,
      stiffness: 4000,
      damping: 2,
      gravity: [0, -GRAVITY, 0] as [number, number, number],
      wind: [0, 0, 0] as [number, number, number],
      readbackEveryFrames: 2,
    };
    // PlaneGeometry has no duplicate positions, so SoftBody3D's welded order is the vertex order.
    const restLengths: number[] = [];
    const springPairs: number[] = [];
    {
      const index = geometry.getIndex();
      if (index === null) throw new Error("CHARACTER_DYNAMICS_CAPE_NOT_INDEXED");
      const seen = new Set<string>();
      for (let t = 0; t < index.count; t += 3)
        for (const [p, q] of [
          [0, 1],
          [1, 2],
          [2, 0],
        ] as const) {
          const i = index.getX(t + p);
          const j = index.getX(t + q);
          const key = i < j ? `${i}:${j}` : `${j}:${i}`;
          if (seen.has(key)) continue;
          seen.add(key);
          springPairs.push(i, j);
          restLengths.push(
            Math.hypot(
              position.getX(i) - position.getX(j),
              position.getY(i) - position.getY(j),
              position.getZ(i) - position.getZ(j),
            ),
          );
        }
    }
    const topology = {
      positions: geometry.getAttribute("position").array as Float32Array,
      springs: springPairs,
      restLengths,
    };
    const cloth = ctx.add(new SoftBody3D(new Mesh(geometry, material), options));
    cloth.matrixAutoUpdate = false;
    const unique = topology.positions.length / 3;
    let minY = Number.POSITIVE_INFINITY;
    for (let v = 0; v < unique; v++) minY = Math.min(minY, topology.positions[v * 3 + 1] as number);
    const hem: number[] = [];
    const top: number[] = [];
    for (let v = 0; v < unique; v++) {
      const y = topology.positions[v * 3 + 1] as number;
      if (Math.abs(y - minY) < 1e-5) hem.push(v);
      if (Math.abs(y) < 1e-5) top.push(v);
    }

    const followQ = new Quaternion();
    const followP = new Vector3();
    const gravityLocal = new Vector3();
    const followBone = (): void => {
      spine.updateWorldMatrix(true, false);
      spine.matrixWorld.decompose(boneP, boneQ, boneS);
      followQ.copy(boneQ).multiply(offsetQ);
      followP.copy(offsetP).applyQuaternion(boneQ).add(boneP);
      cloth.matrix.compose(followP, followQ, new Vector3(1, 1, 1));
      cloth.matrixWorld.copy(cloth.matrix);
      gravityLocal.set(0, -GRAVITY, 0).applyQuaternion(followQ.clone().invert());
      cloth.gravity.copy(gravityLocal);
    };
    followBone();

    // Follow camera: rear three-quarter view so a trailing cape reads against the body.
    const cameraOffset = new Vector3(2.4, 1.5, -3.4)
      .multiplyScalar(height / 1.8)
      .applyAxisAngle(new Vector3(0, 1, 0), bindYaw);
    const look = new Vector3();
    const placeCamera = (): void => {
      const eye = cameraOffset
        .clone()
        .applyAxisAngle(new Vector3(0, 1, 0), character.rotation.y)
        .add(character.position);
      ctx.camera.position.copy(eye);
      look.copy(character.position).setY(character.position.y + 0.55 * height);
      ctx.camera.lookAt(look);
    };
    placeCamera();

    const phases: Record<string, IPhaseMetrics> = {};
    let phaseIndex = 0;
    let phaseTick = 0;
    let vy = 0;
    let finite = true;
    let restHem: Vector3 | undefined;
    let complete = false;
    let tick = 0;
    const forward = new Vector3();
    const local = new Vector3();
    const world = new Vector3();
    const a = new Vector3();
    const b = new Vector3();
    const torsoRadius = 0.075 * height;

    const enterPhase = (phase: IPhase): void => {
      phases[phase.name] = {
        hemOffset: 0,
        hemTrail: 0,
        maxStretch: 0,
        bodyPenetration: 0,
        samples: 0,
      };
      if (phase.jumpSpeed !== undefined) {
        vy = phase.jumpSpeed;
        player.play("Jump_Start", { fade: 0.1, mode: "once" });
      } else player.play(phase.clip, { fade: 0.2 });
      if (phase.snapYaw !== undefined) character.rotation.y += phase.snapYaw;
      if (phase.teleport !== undefined) character.position.x += phase.teleport;
    };
    enterPhase(SCRIPT[0] as IPhase);

    const measure = (metrics: IPhaseMetrics, phaseName: string): void => {
      const sample = cloth.sample;
      if (sample === undefined) return;
      const data = sample.data;
      for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i] as number)) finite = false;
      const hemC = new Vector3();
      for (const v of hem) hemC.add(local.fromArray(data, v * 3));
      hemC.divideScalar(hem.length);
      const topC = new Vector3();
      for (const v of top) topC.add(local.fromArray(data, v * 3));
      topC.divideScalar(top.length);
      if (phaseName === "settle") restHem = hemC.clone();
      if (restHem !== undefined)
        metrics.hemOffset = Math.max(metrics.hemOffset, hemC.distanceTo(restHem));
      const hemW = hemC.clone().applyMatrix4(cloth.matrixWorld);
      const topW = topC.clone().applyMatrix4(cloth.matrixWorld);
      const drop = hemW.sub(topW).normalize();
      metrics.hemTrail = Math.max(
        metrics.hemTrail,
        (Math.acos(Math.min(1, Math.max(-1, -drop.y))) * 180) / Math.PI,
      );
      for (let s = 0; s < topology.springs.length; s += 2) {
        const i = topology.springs[s] as number;
        const j = topology.springs[s + 1] as number;
        const len = Math.hypot(
          (data[i * 3] as number) - (data[j * 3] as number),
          (data[i * 3 + 1] as number) - (data[j * 3 + 1] as number),
          (data[i * 3 + 2] as number) - (data[j * 3 + 2] as number),
        );
        metrics.maxStretch = Math.max(
          metrics.maxStretch,
          len / (topology.restLengths[s / 2] as number) - 1,
        );
      }
      pelvis.getWorldPosition(a);
      neck.getWorldPosition(b);
      let inside = 0;
      for (let v = 0; v < unique; v++) {
        world.fromArray(data, v * 3).applyMatrix4(cloth.matrixWorld);
        if (segmentDistance(world, a, b) < torsoRadius) inside++;
      }
      metrics.bodyPenetration = Math.max(metrics.bodyPenetration, inside);
      metrics.samples++;
    };

    return (frameCtx: ICtx<IState>) => {
      if (complete) return;
      const phase = SCRIPT[phaseIndex] as IPhase;
      // Character root motion: the clips play in place, the script moves the body.
      character.rotation.y += (phase.yawRate ?? 0) * STEP;
      forward.copy(facing).applyAxisAngle(new Vector3(0, 1, 0), character.rotation.y);
      character.position.addScaledVector(forward, phase.speed * STEP);
      if (phase.jumpSpeed !== undefined) {
        if (phaseTick === 6) player.play("Jump_Loop", { fade: 0.1 });
        if (phaseTick >= 6 && (vy > 0 || character.position.y > 0)) {
          character.position.y = Math.max(0, character.position.y + vy * STEP);
          vy -= GRAVITY * STEP;
          if (character.position.y === 0 && vy < 0) {
            vy = 0;
            player.play("Jump_Land", { fade: 0.05, mode: "once" });
          }
        }
      }
      player.update(STEP);
      character.updateMatrixWorld(true);
      followBone();
      placeCamera();
      measure(phases[phase.name] as IPhaseMetrics, phase.name);
      phaseTick++;
      if (phaseTick >= phase.ticks) {
        phaseIndex++;
        phaseTick = 0;
        if (phaseIndex >= SCRIPT.length) complete = true;
        else enterPhase(SCRIPT[phaseIndex] as IPhase);
      }
      const state: IState = {
        arm: armName,
        phase: complete ? "done" : (SCRIPT[phaseIndex] as IPhase).name,
        tick: ++tick,
        complete,
        finite,
        phases,
      };
      frameCtx.state.set(state);
      if (complete) {
        frameCtx.state.flush();
        console.log(
          `TN_CHARACTER_DYNAMICS:${JSON.stringify({ arm: armName, finite, height, phases })}`,
        );
      }
    };
  }
}

export default defineGame<IState>({
  camera: { projection: "perspective", fov: 50, near: 0.05, far: 120 },
  plugins: [playtest()],
  renderer: { preferWebGPU: true, projection: false },
  scenes: { dynamics: CharacterDynamics },
  start: "dynamics",
  step: STEP,
});
