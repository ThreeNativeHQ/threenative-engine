import { type Bone, Matrix4, Quaternion, Vector3 } from "three";

const FIXED_STEP = 1 / 120;
/** Collision and segment-length rounds per particle per substep. */
const COLLISION_ROUNDS = 4;
const MAX_SUBSTEPS = 8;
const MAX_BONES = 32;
const DIRECTION_EPSILON = 1e-12;

/** A world-space capsule the chain is pushed out of. `a === b` is a sphere. */
export interface ISpringBoneCapsule {
  a: Vector3;
  b: Vector3;
  radius: number;
}

export interface ISpringBoneChain3DOptions {
  /** Spring stiffness in s^-2. Unreal `AnimNode_SpringBone` default 50. */
  readonly stiffness?: number;
  /** Velocity damping in s^-1. Unreal default 4. */
  readonly damping?: number;
  /** World-space gravity. Default (0, -9.81, 0); Unreal SpringBone has none. */
  readonly gravity?: Vector3;
  /** Gravity multiplier. Default 0, so gravity is off. */
  readonly gravityScale?: number;
  /** World-space capsules. The game may mutate the entries every step. */
  readonly colliders?: ISpringBoneCapsule[];
  /** Clearance beyond each collider radius, in metres. Default 0.005. */
  readonly thickness?: number;
  /** Root movement in one step that snaps the chain, in metres. Default 1.5. */
  readonly teleportDistance?: number;
  /** Particle error from its target that snaps the chain, in metres. Default 1. */
  readonly errorResetDistance?: number;
}

function finite(name: string, value: number): void {
  if (!Number.isFinite(value)) throw new Error(`SpringBoneChain3D.${name} must be finite.`);
}

function nonNegative(name: string, value: number): void {
  finite(name, value);
  if (value < 0) throw new Error(`SpringBoneChain3D.${name} must be non-negative.`);
}

function vector(name: string, value: Vector3 | undefined): Vector3 {
  if (value === undefined || value === null || (value as Vector3).isVector3 !== true)
    throw new Error(`SpringBoneChain3D.${name} must be a Vector3.`);
  finite(`${name}.x`, value.x);
  finite(`${name}.y`, value.y);
  finite(`${name}.z`, value.z);
  return value;
}

function at<T>(items: readonly T[], index: number): T {
  return items[index] as T;
}

/**
 * Simulate a chain of bones for a ponytail, braid, tail, ears or a dangling prop.
 *
 * Unreal's `AnimNode_SpringBone` algorithm and defaults (UE 5.8.3:
 * Engine/Source/Runtime/AnimGraphRuntime/Private/BoneControllers/AnimNode_SpringBone.cpp:16-20):
 * stiffness 50, damping 4, a 1/120 s fixed step and an error-reset threshold. The root bone is the
 * anchor and follows its animated parent; the first-child path below it is simulated. Call
 * {@link step} once per fixed step, after the animation mixer poses the root's parent. The
 * simulator owns every chain bone's rotation, the root's included (its position follows the parent);
 * keep them out of animation clips.
 *
 * @situation make a ponytail or braid swing with the head
 * @situation make a tail or ears swing as the character moves
 * @situation jiggle bones on a character
 * @situation hair that moves with the head
 * @constraint CPU, fixed step, at most 32 bones per chain
 * @override stiffness, damping, gravityScale, colliders, teleportDistance, errorResetDistance
 * @example
 * import { SpringBoneChain3D } from "@threenative/core";
 * const root = character.getObjectByName("ponytail_01") as Bone;
 * const ponytail = new SpringBoneChain3D(root, { stiffness: 50, damping: 4 });
 * // in the scene's fixed step:
 * update(_ctx, dt) { ponytail.step(dt); }
 */
export class SpringBoneChain3D {
  readonly root: Bone;
  /** The root followed by its first-child path, capped at 32 simulated bones. */
  readonly bones: readonly Bone[];
  /** World-space particle per simulated bone, in chain order. */
  readonly particles: readonly Vector3[];
  readonly stiffness: number;
  readonly damping: number;
  readonly gravity: Vector3;
  readonly gravityScale: number;
  readonly colliders: ISpringBoneCapsule[];
  readonly thickness: number;
  readonly teleportDistance: number;
  readonly errorResetDistance: number;
  readonly fixedStep = FIXED_STEP;

  #restOffsets: Vector3[] = [];
  /** Rest local rotation of every chain bone, the root first: the simulator owns them all. */
  #boneRest: Quaternion[] = [];
  #restLengths: number[] = [];
  #restLocalMatrices: Matrix4[] = [];
  #velocities: Vector3[] = [];
  #targets: Vector3[] = [];
  #lastDt = 0;
  #accumulator = 0;
  #lastRoot = new Vector3();
  #rootPosition = new Vector3();
  #lastReset: "teleport" | "error" | "manual" | null = null;
  #accel = new Vector3();
  #delta = new Vector3();
  #axis = new Vector3();
  #capsuleAxis = new Vector3();
  #capsuleClosest = new Vector3();
  #bonePosition = new Vector3();
  #childPosition = new Vector3();
  #currentDir = new Vector3();
  #desiredDir = new Vector3();
  #scratchPosition = new Vector3();
  #scratchScale = new Vector3();
  #restWorld = new Matrix4();
  #restPosition = new Vector3();
  #nextRestPosition = new Vector3();
  #parentQuat = new Quaternion();
  #worldQuat = new Quaternion();
  #desiredQuat = new Quaternion();
  #localQuat = new Quaternion();
  #rotation = new Quaternion();

  constructor(root: Bone, options: ISpringBoneChain3DOptions = {}) {
    if (root === undefined || root === null || (root as Bone).isBone !== true)
      throw new Error("SpringBoneChain3D.root must be a Bone.");
    if (options === null || typeof options !== "object")
      throw new Error("SpringBoneChain3D.options must be an object.");
    const stiffness = options.stiffness ?? 50;
    const damping = options.damping ?? 4;
    const gravity = options.gravity ?? new Vector3(0, -9.81, 0);
    const gravityScale = options.gravityScale ?? 0;
    const thickness = options.thickness ?? 0.005;
    const teleportDistance = options.teleportDistance ?? 1.5;
    const errorResetDistance = options.errorResetDistance ?? 1;
    nonNegative("stiffness", stiffness);
    nonNegative("damping", damping);
    vector("gravity", gravity);
    finite("gravityScale", gravityScale);
    nonNegative("thickness", thickness);
    nonNegative("teleportDistance", teleportDistance);
    nonNegative("errorResetDistance", errorResetDistance);
    const colliders = options.colliders ?? [];
    if (!Array.isArray(colliders)) throw new Error("SpringBoneChain3D.colliders must be an array.");
    for (const capsule of colliders) {
      if (capsule === undefined || capsule === null || typeof capsule !== "object")
        throw new Error("SpringBoneChain3D.colliders entries must be capsules.");
      vector("colliders.a", capsule.a);
      vector("colliders.b", capsule.b);
      nonNegative("colliders.radius", capsule.radius);
    }
    this.root = root;
    this.stiffness = stiffness;
    this.damping = damping;
    this.gravity = gravity.clone();
    this.gravityScale = gravityScale;
    this.colliders = colliders;
    this.thickness = thickness;
    this.teleportDistance = teleportDistance;
    this.errorResetDistance = errorResetDistance;

    const bones: Bone[] = [root];
    let parent = root;
    while (bones.length <= MAX_BONES) {
      const child = parent.children.find(
        (candidate): candidate is Bone => (candidate as Bone).isBone === true,
      );
      if (child === undefined) break;
      bones.push(child);
      parent = child;
    }
    if (bones.length === 1)
      throw new Error(
        `SpringBoneChain3D root '${root.name || "(unnamed)"}' has no child bone to simulate.`,
      );
    this.bones = bones;

    const particles: Vector3[] = [];
    const velocities: Vector3[] = [];
    const targets: Vector3[] = [];
    root.updateWorldMatrix(true, true);
    this.#boneRest = bones.map((bone) => bone.quaternion.clone());
    for (let index = 1; index < bones.length; index++) {
      const bone = at(bones, index);
      this.#restOffsets.push(bone.position.clone());
      this.#restLengths.push(bone.position.length());
      this.#restLocalMatrices.push(
        new Matrix4().compose(bone.position, bone.quaternion, bone.scale),
      );
      const particle = new Vector3().setFromMatrixPosition(bone.matrixWorld);
      particles.push(particle);
      velocities.push(new Vector3());
      targets.push(new Vector3());
    }
    this.particles = particles;
    this.#velocities = velocities;
    this.#targets = targets;
    this.#lastRoot.setFromMatrixPosition(root.matrixWorld);
    this.#rootPosition.copy(this.#lastRoot);
  }

  /** Why the last reset happened, or `null` after a normal step. */
  get lastReset(): "teleport" | "error" | "manual" | null {
    return this.#lastReset;
  }

  /** Advance the chain by one caller-supplied fixed-step delta. */
  step(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("SpringBoneChain3D.step delta must be finite and non-negative.");
    if (dt === 0) return;
    this.#lastReset = null;
    // The root's rotation is simulated output; its rest rotation under the animated parent is the input.
    this.root.quaternion.copy(at(this.#boneRest, 0));
    this.root.updateWorldMatrix(true, false);
    for (let index = 1; index < this.bones.length; index++)
      at(this.bones, index).updateWorldMatrix(false, false);

    this.#rootPosition.setFromMatrixPosition(this.root.matrixWorld);
    if (
      this.#rootPosition.distanceToSquared(this.#lastRoot) >
      this.teleportDistance * this.teleportDistance
    ) {
      this.#snapToPose();
      this.#lastReset = "teleport";
      return;
    }

    this.#restWorld.copy(this.root.matrixWorld);
    this.#restPosition.setFromMatrixPosition(this.#restWorld);
    for (let index = 0; index < this.particles.length; index++) {
      this.#restWorld.multiply(at(this.#restLocalMatrices, index));
      this.#nextRestPosition.setFromMatrixPosition(this.#restWorld);
      this.#restLengths[index] = this.#restPosition.distanceTo(this.#nextRestPosition);
      at(this.#targets, index)
        .copy(index === 0 ? this.#rootPosition : at(this.particles, index - 1))
        .add(this.#nextRestPosition)
        .sub(this.#restPosition);
      this.#restPosition.copy(this.#nextRestPosition);
    }
    for (let index = 0; index < this.particles.length; index++) {
      if (
        at(this.particles, index).distanceToSquared(at(this.#targets, index)) >
        this.errorResetDistance * this.errorResetDistance
      ) {
        this.#snapToPose();
        this.#lastReset = "error";
        return;
      }
    }

    let frameDt = dt;
    if (this.#lastDt > 0 && frameDt > this.#lastDt * 1.5)
      frameDt = Math.min(frameDt, MAX_SUBSTEPS * FIXED_STEP);
    this.#lastDt = frameDt;
    this.#accumulator = Math.min(this.#accumulator + frameDt, MAX_SUBSTEPS * FIXED_STEP);
    let substeps = Math.floor(this.#accumulator / FIXED_STEP);
    if (substeps > MAX_SUBSTEPS) substeps = MAX_SUBSTEPS;
    this.#accumulator -= substeps * FIXED_STEP;
    for (let index = 0; index < substeps; index++) this.#substep();
    this.#writeBack();
    this.#lastRoot.copy(this.#rootPosition);
  }

  /** Snap every particle to the captured rest pose and clear its velocity. */
  reset(): void {
    this.#lastReset = "manual";
    this.#lastDt = 0;
    this.#snapToPose();
  }

  #substep(): void {
    for (let index = 0; index < this.particles.length; index++) {
      const particle = at(this.particles, index);
      const velocity = at(this.#velocities, index);
      this.#accel
        .copy(at(this.#targets, index))
        .sub(particle)
        .multiplyScalar(this.stiffness)
        .addScaledVector(velocity, -this.damping)
        .addScaledVector(this.gravity, this.gravityScale);
      velocity.addScaledVector(this.#accel, FIXED_STEP);
      particle.addScaledVector(velocity, FIXED_STEP);
      this.#constrain(index);
      this.#collide(index);
    }
  }

  #constrain(index: number): void {
    const particle = at(this.particles, index);
    const parent = index === 0 ? this.#rootPosition : at(this.particles, index - 1);
    this.#delta.copy(particle).sub(parent);
    const distance = this.#delta.length();
    if (distance > 1e-9) {
      particle.copy(parent).addScaledVector(this.#delta, at(this.#restLengths, index) / distance);
      return;
    }
    this.#delta.copy(at(this.#targets, index)).sub(parent);
    const fallback = this.#delta.length();
    if (fallback > 1e-9) {
      particle.copy(parent).addScaledVector(this.#delta, at(this.#restLengths, index) / fallback);
      return;
    }
    particle.copy(parent).addScaledVector(this.#axis.set(0, 1, 0), at(this.#restLengths, index));
  }

  #collide(index: number): void {
    // Push-out and the segment length fight: the length projection can carry a pushed-out particle back
    // inside. Alternate them until no collider is hit (a few rounds settle it on the capsule's surface).
    for (let round = 0; round < COLLISION_ROUNDS; round++) if (!this.#pushOut(index)) return;
  }

  /** Push particle `index` out of every collider, then restore its segment length. True on a hit. */
  #pushOut(index: number): boolean {
    const particle = at(this.particles, index);
    let hit = false;
    for (let colliderIndex = 0; colliderIndex < this.colliders.length; colliderIndex++) {
      const capsule = at(this.colliders, colliderIndex);
      this.#capsuleAxis.copy(capsule.b).sub(capsule.a);
      const lengthSq = this.#capsuleAxis.lengthSq();
      let t = 0;
      if (lengthSq > 1e-12) {
        t = this.#capsuleClosest.copy(particle).sub(capsule.a).dot(this.#capsuleAxis) / lengthSq;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
      }
      this.#capsuleClosest.copy(capsule.a).addScaledVector(this.#capsuleAxis, t);
      this.#delta.copy(particle).sub(this.#capsuleClosest);
      const distance = this.#delta.length();
      const minimum = capsule.radius + this.thickness;
      if (distance >= minimum) continue;
      hit = true;
      if (distance > 1e-9)
        particle.copy(this.#capsuleClosest).addScaledVector(this.#delta, minimum / distance);
      else particle.copy(this.#capsuleClosest).addScaledVector(this.#axis.set(1, 0, 0), minimum);
    }
    this.#constrain(index);
    return hit;
  }

  /** Rotate bone i (the root first) so its child lands on particle i. Positions never stretch. */
  #writeBack(): void {
    for (let index = 0; index < this.particles.length; index++) {
      const bone = at(this.bones, index);
      bone.updateWorldMatrix(false, false);
      if (bone.parent === null) this.#parentQuat.identity();
      else
        bone.parent.matrixWorld.decompose(
          this.#scratchPosition,
          this.#parentQuat,
          this.#scratchScale,
        );
      this.#worldQuat.copy(this.#parentQuat).multiply(bone.quaternion);
      this.#bonePosition.setFromMatrixPosition(bone.matrixWorld);
      this.#childPosition.copy(at(this.#restOffsets, index)).applyMatrix4(bone.matrixWorld);
      this.#currentDir.copy(this.#childPosition).sub(this.#bonePosition);
      this.#desiredDir
        .copy(at(this.particles, index))
        .sub(index === 0 ? this.#rootPosition : at(this.particles, index - 1));
      if (this.#currentDir.lengthSq() < 1e-18 || this.#desiredDir.lengthSq() < 1e-18) continue;
      this.#currentDir.normalize();
      this.#desiredDir.normalize();
      if (this.#currentDir.dot(this.#desiredDir) > 1 - DIRECTION_EPSILON) continue;
      this.#rotation.setFromUnitVectors(this.#currentDir, this.#desiredDir);
      this.#desiredQuat.copy(this.#rotation).multiply(this.#worldQuat);
      this.#localQuat.copy(this.#parentQuat).invert().multiply(this.#desiredQuat).normalize();
      bone.quaternion.copy(this.#localQuat);
      bone.updateWorldMatrix(false, false);
    }
    at(this.bones, this.bones.length - 1).updateWorldMatrix(false, false);
  }

  #snapToPose(): void {
    this.root.quaternion.copy(at(this.#boneRest, 0));
    this.root.updateWorldMatrix(true, false);
    for (let index = 0; index < this.particles.length; index++) {
      const bone = at(this.bones, index + 1);
      bone.quaternion.copy(at(this.#boneRest, index + 1));
      bone.updateWorldMatrix(false, false);
      at(this.particles, index).setFromMatrixPosition(bone.matrixWorld);
      at(this.#velocities, index).set(0, 0, 0);
    }
    this.#accumulator = 0;
    this.#rootPosition.setFromMatrixPosition(this.root.matrixWorld);
    this.#lastRoot.copy(this.#rootPosition);
  }
}
