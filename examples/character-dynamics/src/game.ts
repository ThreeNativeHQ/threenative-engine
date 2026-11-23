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
 * `spine_03` by hand every tick and its gravity is rotated into that frame. `?arm=cloth` is the skinned
 * `SoftBody3D` cape, `?arm=hair` the `SpringBoneChain3D` ponytail and `?arm=strands` 64 `HairStrands3D`
 * guides drawn as cards. `?cape=0` hides the cape so the hair reads from behind.
 */
import {
  HairStrands3D,
  type ICtx,
  type ISoftBodyCapsule,
  type ISpringBoneCapsule,
  Scene,
  SkeletalMesh3D,
  SoftBody3D,
  SpringBoneChain3D,
  WindField3D,
  defineGame,
  measureBodyCapsules,
} from "@threenative/core";
import { playtest } from "@threenative/core/playtest";
import {
  AmbientLight,
  type AnimationClip,
  Bone,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Group,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  PlaneGeometry,
  Quaternion,
  SkinnedMesh,
  Vector3,
} from "three";
import { attribute, cameraViewMatrix, length, normalize, uniform, varying, vec4 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { createHairCardMaterial } from "../../../packages/create-threenative/templates/starter/src/render/hair.js";
import { strandAtlas } from "./hair-atlas.js";
import {
  type IProbeCapsule,
  centroid,
  countInsideCapsules,
  maxEdgeStretch,
  maxSegmentStretch,
  toFrame,
  trailAngleDegrees,
} from "./probe.js";

type Glb = { animations: AnimationClip[]; scene: Object3D };

const STEP = 1 / 60;
const GRAVITY = 9.81;
/** SoftBody3D's default `colliderThickness` (Chaos CollisionThickness, 1 cm). */
const COLLIDER_THICKNESS = 0.01;

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
const ACCELERATION = 8;
const BRAKING = 12;
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
  /** Largest tip-bone move away from its end-of-settle spot, in the Head bone frame, metres. */
  hairTipOffset: number;
  /** Largest |segment length / rest length - 1| over the chain. */
  hairStretch: number;
  /** Largest number of simulated hair points inside the head, neck, back or shoulder capsules in one sample. */
  hairInsideHead: number;
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
  if (value !== "softbody" && value !== "cloth" && value !== "hair" && value !== "strands")
    throw new Error(`CHARACTER_DYNAMICS_UNKNOWN_ARM arm=${value}`);
  return value;
}

function boneOf(root: Object3D, name: string): Bone {
  const bone = root.getObjectByName(name) as Bone | undefined;
  if (bone === undefined) throw new Error(`CHARACTER_DYNAMICS_BONE_MISSING ${name}`);
  return bone;
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
    const head = boneOf(player.root, "Head");

    // Facing is measured, not assumed: the foot-to-ball line points forward on any rig.
    const facing = boneOf(player.root, "ball_l")
      .getWorldPosition(new Vector3())
      .sub(boneOf(player.root, "foot_l").getWorldPosition(new Vector3()))
      .setY(0)
      .normalize();
    const bindYaw = Math.atan2(facing.x, facing.z);
    const height = head.getWorldPosition(new Vector3()).y;

    // The ponytail is the same rig in every arm: a 6-bone chain hanging off Head, one tapered
    // shaft per bone. Only `?arm=hair` simulates it; every other arm is the rigid control.
    const back = facing.clone().negate();
    const hairBones: Bone[] = [];
    const hairLocalPoints: Vector3[] = [];
    const hairAnchor = head.getWorldPosition(new Vector3());
    let hairParent: Bone = head;
    for (let index = 0; index < 6; index++) {
      // The root sits on the back of the skull (the Head bone is at the top of the neck); the chain
      // falls back and down, clear of the neck and the upper back.
      const offset =
        index === 0
          ? back.clone().multiplyScalar(0.12).setY(0.15)
          : back.clone().multiplyScalar(0.03).setY(-0.06);
      hairAnchor.add(offset);
      const bone = new Bone();
      bone.name = `ponytail_${index + 1}`;
      bone.position.copy(hairParent.worldToLocal(hairAnchor.clone()));
      hairParent.add(bone);
      bone.updateWorldMatrix(true, false);
      hairBones.push(bone);
      hairLocalPoints.push(bone.position.clone());
      hairParent = bone;
    }
    const hairMaterial = new MeshStandardNodeMaterial({ color: 0x3a2416, roughness: 0.72 });
    const up = new Vector3(0, 1, 0);
    for (let index = 0; index < hairBones.length; index++) {
      const segment =
        index + 1 < hairLocalPoints.length
          ? (hairLocalPoints[index + 1] as Vector3).clone().sub(hairLocalPoints[index] as Vector3)
          : (hairLocalPoints[index] as Vector3).clone().sub(hairLocalPoints[index - 1] as Vector3);
      const length = segment.length();
      const radius = (step: number): number => 0.022 - 0.014 * (step / hairBones.length);
      const mesh = new Mesh(
        new CylinderGeometry(radius(index + 1), radius(index), length, 6),
        hairMaterial,
      );
      mesh.quaternion.setFromUnitVectors(up, segment.normalize());
      mesh.position.copy(segment).multiplyScalar(length / 2);
      (hairBones[index] as Bone).add(mesh);
    }

    const hairWorld: Vector3[] = hairBones.map(() => new Vector3());
    const readHairWorld = (): void => {
      for (let index = 0; index < hairBones.length; index++)
        (hairWorld[index] as Vector3).setFromMatrixPosition((hairBones[index] as Bone).matrixWorld);
    };
    readHairWorld();
    const hairRestLengths = hairWorld
      .slice(1)
      .map((point, index) => point.distanceTo(hairWorld[index] as Vector3));

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
    // `?arm=cloth`: the cape is a SkinnedMesh on the mannequin's skeleton, rigidly weighted to
    // spine_03, with red vertex colour 1 on the top row (follows the skin) and 0 below (simulates).
    // SoftBody3D measures body capsules from the mannequin's skin and simulates in world space.
    const capeMatrix = new Matrix4();
    const placeCape = (): void => {
      spine.updateWorldMatrix(true, false);
      spine.matrixWorld.decompose(boneP, boneQ, boneS);
      capeMatrix.compose(
        offsetP.clone().applyQuaternion(boneQ).add(boneP),
        boneQ.clone().multiply(offsetQ),
        new Vector3(1, 1, 1),
      );
    };
    placeCape();
    let cloth: SoftBody3D;
    // ?wind=<m/s>: a WindField3D blowing from the front, read by the skinned cape every step.
    const windSpeed = Number(
      new URLSearchParams(globalThis.location?.search ?? "").get("wind") ?? 0,
    );
    if (windSpeed > 0)
      ctx.add(
        new WindField3D(
          facing.clone().multiplyScalar(-windSpeed).toArray() as [number, number, number],
        ),
      );
    let probeCapsules: ISoftBodyCapsule[] = [];
    let skinnedCape: SkinnedMesh | undefined;
    // The skinned cape exists in every arm: the cloth arm simulates it, and every arm's probe measures
    // penetration against the body capsules the solver would measure from it.
    {
      const body = player.root.getObjectByProperty("isSkinnedMesh", true) as
        | SkinnedMesh
        | undefined;
      if (body === undefined) throw new Error("CHARACTER_DYNAMICS_NO_SKINNED_BODY");
      const spineIndex = body.skeleton.bones.indexOf(spine);
      // Skinning reads bind-pose positions: take the world cape back through spine_03's current
      // skinning matrix (boneWorld · boneInverse), then into the cape mesh's own frame.
      character.updateMatrixWorld(true);
      body.skeleton.update();
      const spineSkin = new Matrix4().fromArray(body.skeleton.boneMatrices ?? [], spineIndex * 16);
      const capeGeometry = geometry
        .clone()
        .applyMatrix4(capeMatrix)
        .applyMatrix4(spineSkin.invert())
        .applyMatrix4(character.matrixWorld.clone().invert());
      const count = capeGeometry.getAttribute("position").count;
      const skinIndex = new Uint16Array(count * 4);
      const skinWeight = new Float32Array(count * 4);
      const colour = new Float32Array(count * 3);
      const pinnedSet = new Set(pinned);
      for (let v = 0; v < count; v++) {
        skinIndex[v * 4] = spineIndex;
        skinWeight[v * 4] = 1;
        colour[v * 3] = pinnedSet.has(v) ? 1 : 0;
      }
      capeGeometry.setAttribute("skinIndex", new BufferAttribute(skinIndex, 4));
      capeGeometry.setAttribute("skinWeight", new BufferAttribute(skinWeight, 4));
      capeGeometry.setAttribute("color", new BufferAttribute(colour, 3));
      const capeSkin = new SkinnedMesh(capeGeometry, material);
      character.add(capeSkin);
      capeSkin.updateMatrixWorld(true);
      capeSkin.bind(body.skeleton, capeSkin.matrixWorld);
      const restWorld = geometry.clone().applyMatrix4(capeMatrix).getAttribute("position")
        .array as Float32Array;
      probeCapsules = measureBodyCapsules(capeSkin, 16, restWorld, COLLIDER_THICKNESS);
      skinnedCape = capeSkin;
    }
    // The hair collides with capsules measured from the skin, by the same physics-asset rule as the
    // cape's body capsules (the head merges into `neck_01`). The probe reads the same shapes.
    const allCapsules = measureBodyCapsules(skinnedCape as SkinnedMesh);
    console.info(
      `TN_CHARACTER_DYNAMICS_BODY_CAPSULES:${JSON.stringify(allCapsules.map((c) => `${c.bone.name}:${c.radius.toFixed(3)}`))}`,
    );
    // The hair falls onto the head, neck, upper back and shoulders.
    const hairBoneNames = new Set(["neck_01", "spine_03", "spine_02", "upperarm_l", "upperarm_r"]);
    const hairCapsules = allCapsules.filter((capsule) => hairBoneNames.has(capsule.bone.name));
    if (hairCapsules.length === 0) throw new Error("CHARACTER_DYNAMICS_NO_HEAD_CAPSULE");
    const hairColliders: ISpringBoneCapsule[] = hairCapsules.map((capsule) => ({
      a: new Vector3(),
      b: new Vector3(),
      radius: capsule.radius,
    }));
    const updateHairColliders = (): void => {
      hairCapsules.forEach((capsule, index) => {
        const collider = hairColliders[index] as ISpringBoneCapsule;
        capsule.bone.updateWorldMatrix(true, false);
        collider.a.copy(capsule.start ?? new Vector3()).applyMatrix4(capsule.bone.matrixWorld);
        collider.b.copy(capsule.end).applyMatrix4(capsule.bone.matrixWorld);
      });
    };
    updateHairColliders();
    console.info(
      `TN_CHARACTER_DYNAMICS_HAIR_COLLIDERS:${JSON.stringify(hairCapsules.map((c) => `${c.bone.name}:${c.radius.toFixed(3)}`))}`,
    );
    const ponytail =
      armName === "hair"
        ? new SpringBoneChain3D(hairBones[0] as Bone, { colliders: hairColliders })
        : undefined;
    // `?arm=strands`: 64 guides of 16 points on the GPU, each the ponytail curve resampled and spread
    // across the back of the head; the rigid ponytail hides. Lines read the solver's buffer directly.
    const STRAND_POINTS = 16;
    const STRAND_COUNT = 64;
    const strandTuning = (): Record<string, number> => {
      const query = new URLSearchParams(globalThis.location?.search ?? "");
      const tuning: Record<string, number> = {};
      for (const key of [
        "airDrag",
        "iterations",
        "substeps",
        "globalStiffness",
        "localStiffness",
      ]) {
        const value = query.get(key);
        if (value !== null) tuning[key] = Number(value);
      }
      return tuning;
    };
    let strands: HairStrands3D | undefined;
    // The head's world frame for the cards' across vectors, refreshed every step.
    const headFrame = uniform(head.matrixWorld.clone());
    if (armName === "strands") {
      (hairBones[0] as Bone).visible = false;
      const curve = hairWorld.map((point) => point.clone());
      const total = curve
        .slice(1)
        .reduce((sum, point, index) => sum + point.distanceTo(curve[index] as Vector3), 0);
      const across = new Vector3().crossVectors(up, back).normalize();
      const guides = new Float32Array(STRAND_COUNT * STRAND_POINTS * 3);
      const point = new Vector3();
      for (let g = 0; g < STRAND_COUNT; g++) {
        const shift = across.clone().multiplyScalar(((g + 0.5) / STRAND_COUNT - 0.5) * 0.1);
        for (let p = 0; p < STRAND_POINTS; p++) {
          // Walk the polyline to arc length p / (n - 1) of the whole.
          let left = (total * p) / (STRAND_POINTS - 1);
          let k = 0;
          for (; k < curve.length - 2; k++) {
            const length = (curve[k + 1] as Vector3).distanceTo(curve[k] as Vector3);
            if (left <= length) break;
            left -= length;
          }
          const a = curve[k] as Vector3;
          const b = curve[k + 1] as Vector3;
          point.lerpVectors(a, b, Math.min(1, left / a.distanceTo(b))).add(shift);
          point.toArray(guides, (g * STRAND_POINTS + p) * 3);
        }
      }
      strands = ctx.add(
        new HairStrands3D(guides, {
          pointsPerStrand: STRAND_POINTS,
          bone: head,
          colliders: hairCapsules,
          readbackEveryFrames: 2,
          // Named overrides from the URL, for tuning runs: ?airDrag=0&iterations=8
          ...strandTuning(),
        }),
      );
      // One ribbon card per guide: two vertices per guide point, spread across the head's left-right
      // axis and tapering to the tip. The position node reads the solver's buffer, so nothing reads back.
      const cardPoint = new Float32Array(STRAND_COUNT * STRAND_POINTS * 2);
      const cardAcross = new Float32Array(STRAND_COUNT * STRAND_POINTS * 2 * 3);
      const cardUv = new Float32Array(STRAND_COUNT * STRAND_POINTS * 2 * 2);
      const acrossHead = across.clone().transformDirection(head.matrixWorld.clone().invert());
      const triangles: number[] = [];
      for (let g = 0; g < STRAND_COUNT; g++)
        for (let p = 0; p < STRAND_POINTS; p++) {
          const v = (g * STRAND_POINTS + p) * 2;
          const half = 0.012 * (1 - (0.5 * p) / (STRAND_POINTS - 1));
          for (const side of [0, 1]) {
            cardPoint[v + side] = g * STRAND_POINTS + p;
            cardUv.set([side, p / (STRAND_POINTS - 1)], (v + side) * 2);
            acrossHead
              .clone()
              .multiplyScalar(side === 0 ? -half : half)
              .toArray(cardAcross, (v + side) * 3);
          }
          if (p + 1 < STRAND_POINTS) triangles.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        }
      const cardGeometry = new BufferGeometry();
      cardGeometry.setAttribute(
        "position",
        new BufferAttribute(new Float32Array(cardPoint.length * 3), 3),
      );
      cardGeometry.setAttribute("guidePoint", new BufferAttribute(cardPoint, 1));
      cardGeometry.setAttribute("across", new BufferAttribute(cardAcross, 3));
      cardGeometry.setAttribute("uv", new BufferAttribute(cardUv, 2));
      cardGeometry.setIndex(triangles);
      // PRD-909's card material from the starter template's generated `src/render/hair.ts`, with a
      // generated strand atlas; each pass reads the solver buffer in its position node.
      const cardPosition = strands.positions
        .element(attribute("guidePoint", "float").toUint())
        // The head frame carries the rig's import scale: take its direction, keep the authored width.
        .add(
          normalize(headFrame.mul(vec4(attribute("across", "vec3"), 0)).xyz).mul(
            length(attribute("across", "vec3")),
          ),
        );
      // Hair-card normals point out from the head, the usual card trick: the cards carry no normal
      // attribute, and three's (0, 1, 0) fallback faces down on the back faces the camera sees.
      const cardNormal = normalize(
        cameraViewMatrix.mul(
          vec4(varying(normalize(cardPosition.sub(headFrame.mul(vec4(0, 0, 0, 1)).xyz))), 0),
        ).xyz,
      );
      const passes = createHairCardMaterial({ atlas: strandAtlas() });
      [passes.inner, passes.outer].forEach((material, order) => {
        if (material === null) return;
        material.positionNode = cardPosition;
        material.normalNode = cardNormal;
        const cards = new Mesh(cardGeometry, material);
        cards.frustumCulled = false;
        cards.renderOrder = order;
        ctx.add(cards);
      });
    }
    if (armName === "cloth") {
      const capeSkin = skinnedCape as SkinnedMesh;
      // Named overrides from the URL, for tuning runs: ?substeps=10&colliders=0
      const query = new URLSearchParams(globalThis.location?.search ?? "");
      const tuning: Record<string, number> = {};
      for (const key of [
        "substeps",
        "drag",
        "iterations",
        "lift",
        "tetherSlack",
        "damping",
        "velocityScale",
        "angularVelocityScale",
        "bendStiffness",
        "friction",
      ]) {
        const value = query.get(key);
        if (value !== null) tuning[key] = Number(value);
      }
      cloth = ctx.add(
        new SoftBody3D(capeSkin, {
          cloth: "color.r",
          readbackEveryFrames: 2,
          ...tuning,
          ...(query.get("colliders") === "0" ? { bodyColliders: false as const } : {}),
        }),
      );
      console.info(`TN_CHARACTER_DYNAMICS_CLOTH:${JSON.stringify(cloth.debug())}`);
    } else {
      (skinnedCape as SkinnedMesh).visible = false;
      cloth = ctx.add(new SoftBody3D(new Mesh(geometry, material), options));
      cloth.matrixAutoUpdate = false;
    }
    // `?cape=0` hides the cape in any arm, so the hair arms and their rigid control read the same back.
    if (new URLSearchParams(globalThis.location?.search ?? "").get("cape") === "0")
      cloth.visible = false;
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
    const free = Array.from({ length: unique }, (_, v) => v).filter((v) => !top.includes(v));

    const followQ = new Quaternion();
    const followP = new Vector3();
    const gravityLocal = new Vector3();
    const followBone = (): void => {
      if (armName === "cloth") return;
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
    let speed = 0;
    const world = new Vector3();

    const enterPhase = (phase: IPhase): void => {
      phases[phase.name] = {
        hemOffset: 0,
        hemTrail: 0,
        maxStretch: 0,
        bodyPenetration: 0,
        hairTipOffset: 0,
        hairStretch: 0,
        hairInsideHead: 0,
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

    // A readback sample is `staleFrames` steps old: measure it against the body pose of the step that
    // produced it, or a running character reads as metres of hem offset that the cloth never had.
    interface IPose {
      readonly toBody: Matrix4;
      readonly clothWorld: Matrix4;
      readonly capsules: IProbeCapsule[];
      readonly hairCapsules: IProbeCapsule[];
      readonly toHead: Matrix4;
    }
    const poses = new Map<number, IPose>();
    const capsulesNow = (capsules: readonly ISoftBodyCapsule[]): IProbeCapsule[] =>
      capsules.map((capsule) => {
        capsule.bone.updateWorldMatrix(true, false);
        return {
          a: (capsule.start ?? new Vector3()).clone().applyMatrix4(capsule.bone.matrixWorld),
          b: capsule.end.clone().applyMatrix4(capsule.bone.matrixWorld),
          radius: capsule.radius,
        };
      });
    const bonePose = (): Pick<IPose, "capsules" | "hairCapsules" | "toHead"> => {
      head.updateWorldMatrix(true, false);
      return {
        capsules: capsulesNow(probeCapsules),
        hairCapsules: capsulesNow(hairCapsules),
        toHead: head.matrixWorld.clone().invert(),
      };
    };
    let steps = 0;
    const recordPose = (): void => {
      steps++;
      poses.set(steps, {
        toBody: capeMatrix.clone().invert(),
        clothWorld: cloth.matrixWorld.clone(),
        ...bonePose(),
      });
      poses.delete(steps - 120);
    };
    const measure = (metrics: IPhaseMetrics, phaseName: string): void => {
      const sample = cloth.sample;
      if (sample === undefined) return;
      // This step's process has not run yet: the newest sample is from step (steps - 1 - staleFrames).
      const pose = poses.get(steps - 1 - sample.staleFrames);
      if (pose === undefined) return;
      const data = sample.data;
      for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i] as number)) finite = false;
      // The cloth arm samples world positions; the probe measures the hem in the body frame.
      const toBody = armName === "cloth" ? pose.toBody : undefined;
      const hemC = centroid(data, hem);
      const topC = centroid(data, top);
      const hemWorld = hemC.clone().applyMatrix4(pose.clothWorld);
      const topWorld = topC.clone().applyMatrix4(pose.clothWorld);
      if (toBody !== undefined) hemC.applyMatrix4(toBody);
      if (phaseName === "settle") restHem = hemC.clone();
      if (restHem !== undefined)
        metrics.hemOffset = Math.max(metrics.hemOffset, hemC.distanceTo(restHem));
      metrics.hemTrail = Math.max(metrics.hemTrail, trailAngleDegrees(topWorld, hemWorld));
      metrics.maxStretch = Math.max(
        metrics.maxStretch,
        maxEdgeStretch(data, topology.springs, topology.restLengths),
      );
      // AC-2: free vertices (the pinned top row follows the skin) deeper than the collider thickness
      // inside the body capsules the solver measures, at the pose that produced this sample.
      const worldPositions = new Float32Array(free.length * 3);
      free.forEach((v, k) =>
        world
          .fromArray(data, v * 3)
          .applyMatrix4(pose.clothWorld)
          .toArray(worldPositions, k * 3),
      );
      metrics.bodyPenetration = Math.max(
        metrics.bodyPenetration,
        countInsideCapsules(worldPositions, pose.capsules, COLLIDER_THICKNESS),
      );
      metrics.samples++;
    };

    // Hair is measured every tick, unlike the readback cloth: the tip offset uses the Head bone
    // frame, so the head's own motion cancels and only the chain's lag shows.
    const hairPositions = new Float32Array(hairBones.length * 3);
    const headPosition = new Vector3();
    const headOrientation = new Quaternion();
    let hairRestTip: Vector3 | undefined;
    const measureStrands = (
      metrics: IPhaseMetrics,
      phaseName: string,
      hair: HairStrands3D,
    ): void => {
      const sample = hair.sample;
      if (sample === undefined) return;
      const pose = poses.get(steps - 1 - sample.staleFrames);
      if (pose === undefined) return;
      const data = sample.data;
      for (let i = 0; i < data.length; i++) if (!Number.isFinite(data[i] as number)) finite = false;
      const n = hair.pointsPerStrand;
      const tipLocal = new Vector3()
        .fromArray(data, ((STRAND_COUNT / 2) * n + n - 1) * 3)
        .applyMatrix4(pose.toHead);
      if (phaseName === "settle") hairRestTip = tipLocal.clone();
      if (hairRestTip !== undefined)
        metrics.hairTipOffset = Math.max(metrics.hairTipOffset, tipLocal.distanceTo(hairRestTip));
      let inside = 0;
      for (let g = 0; g < hair.strandCount; g++) {
        const strand = data.subarray(g * n * 3, (g + 1) * n * 3);
        metrics.hairStretch = Math.max(
          metrics.hairStretch,
          maxSegmentStretch(strand, hair.restLengths.subarray(g * n, g * n + n - 1)),
        );
        // The root rides the head and is not simulated.
        inside += countInsideCapsules(strand.subarray(3), pose.hairCapsules, 0.005);
      }
      metrics.hairInsideHead = Math.max(metrics.hairInsideHead, inside);
    };
    const measureHair = (metrics: IPhaseMetrics, phaseName: string): void => {
      if (strands !== undefined) {
        measureStrands(metrics, phaseName, strands);
        return;
      }
      readHairWorld();
      head.getWorldPosition(headPosition);
      head.getWorldQuaternion(headOrientation);
      for (let index = 0; index < hairWorld.length; index++)
        (hairWorld[index] as Vector3).toArray(hairPositions, index * 3);
      const tipLocal = toFrame(
        hairWorld[hairWorld.length - 1] as Vector3,
        headPosition,
        headOrientation,
      );
      if (phaseName === "settle") hairRestTip = tipLocal.clone();
      if (hairRestTip !== undefined)
        metrics.hairTipOffset = Math.max(metrics.hairTipOffset, tipLocal.distanceTo(hairRestTip));
      metrics.hairStretch = Math.max(
        metrics.hairStretch,
        maxSegmentStretch(hairPositions, hairRestLengths),
      );
      metrics.hairInsideHead = Math.max(
        metrics.hairInsideHead,
        // The root bone rides the head and is not simulated: count only the chain below it.
        countInsideCapsules(hairPositions.subarray(3), hairColliders, 0.005),
      );
    };

    return (frameCtx: ICtx<IState>) => {
      if (complete) return;
      // The solvers read the bones when they process, after this tick; record that pose for the
      // probes here, before this tick moves anything.
      const solved = poses.get(steps);
      if (solved !== undefined) poses.set(steps, { ...solved, ...bonePose() });
      const phase = SCRIPT[phaseIndex] as IPhase;
      // Character root motion: the clips play in place, the script moves the body.
      character.rotation.y += (phase.yawRate ?? 0) * STEP;
      forward.copy(facing).applyAxisAngle(new Vector3(0, 1, 0), character.rotation.y);
      // A runner reaches a new speed at about 8 m/s² and stops at about 12 m/s²; an instant velocity step
      // is an impulse no body makes, and it swings any cape past horizontal.
      const accel = phase.speed > speed ? ACCELERATION : BRAKING;
      speed +=
        Math.sign(phase.speed - speed) * Math.min(Math.abs(phase.speed - speed), accel * STEP);
      character.position.addScaledVector(forward, speed * STEP);
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
      updateHairColliders();
      headFrame.value.copy(head.matrixWorld);
      ponytail?.step(STEP);
      followBone();
      placeCape();
      placeCamera();
      recordPose();
      measure(phases[phase.name] as IPhaseMetrics, phase.name);
      measureHair(phases[phase.name] as IPhaseMetrics, phase.name);
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
