import { Euler, Group, Material, Matrix4, Mesh, type Object3D, Vector3 } from "three";
import { createAnimalBounds } from "./bounds.js";
import { animalError, requireValidatedBake } from "./format.js";
import type { IAnimalBake } from "./format.js";
import { createAnimalPose } from "./pose.js";
import type { IAnimalPose, IAnimalSkeleton } from "./pose.js";
import { geometryFromValidatedBake } from "./runtime.js";

export type AnimalActionResult = "done" | "interrupted" | "stopped" | "refused" | "disposed";
export interface IAnimalMotion {
  readonly input: {
    speed: number;
    target: unknown;
    heading: number;
    follow: { position: Vector3; velocity: Vector3; heading: number } | null;
  };
  update(dt: number): void;
  reset(position: Vector3, heading: number): void;
  play(name: string): Promise<AnimalActionResult>;
  dispose(): void;
}
export interface IAnimalMotionContext {
  readonly data: IAnimalBake;
  readonly skeleton: IAnimalSkeleton;
  readonly ground: (x: number, z: number) => number;
  readonly position: Vector3;
  readonly heading: number;
  readonly emit: (name: string, data: unknown) => void;
}
export interface IAnimalAcceptedState {
  readonly position: Readonly<Pick<Vector3, "x" | "y" | "z">>;
  readonly velocity: Readonly<Pick<Vector3, "x" | "y" | "z">>;
  readonly heading: number;
}
export interface IAnimalActorOptions {
  readonly motion: (context: IAnimalMotionContext) => IAnimalMotion;
  readonly material: (pose: IAnimalPose) => Material;
  readonly ground: (x: number, z: number) => number;
  readonly parent?: Object3D;
  /** Game's rig origin relative to the physics origin (capsules are centred). Reported verbatim. */
  readonly visualOriginOffset?: Readonly<Pick<Vector3, "x" | "y" | "z">>;
}

const identity = new Matrix4();
function requireIdentityParent(object: Object3D | null): void {
  if (!object) return;
  if (!object.matrix.elements.every(Number.isFinite))
    throw animalError("PARENT_TRANSFORM", "parent local matrix must be finite");
  object.updateWorldMatrix(true, false);
  if (
    object.matrixWorld.elements.some(
      (value, index) =>
        !Number.isFinite(value) || Math.abs(value - (identity.elements[index] ?? 0)) > 1e-9,
    )
  )
    throw animalError(
      "PARENT_TRANSFORM",
      "the first animal adapter requires an identity parent world transform",
    );
}
function finiteVector(value: Readonly<Pick<Vector3, "x" | "y" | "z">>): void {
  if (!value || ![value.x, value.y, value.z].every(Number.isFinite))
    throw animalError("FOLLOW_STATE", "accepted vectors must be finite");
}

function cleanupOwned(callbacks: readonly (() => void)[], failure?: unknown): void {
  const errors: unknown[] = failure === undefined ? [] : [failure];
  for (const callback of callbacks) {
    try {
      callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map(String).join("; "));
}

/**
 * Own one actor's pose/lifetime, accepting the completed physics state as its only root writer.
 * @situation follow a baked animal from accepted fixed-step Rapier state
 * @constraint identity parent required; material and motion are editable game source; no move/Mixer/composer writer exists
 * @requires npm i @threenative/procedural-animals
 * @example const wolf = createAnimalActor(bake, { motion, material, ground });
 */
export function createAnimalActor(bake: IAnimalBake, options: IAnimalActorOptions) {
  requireValidatedBake(bake);
  requireIdentityParent(options.parent ?? null);
  const originOffset = new Vector3().copy(options.visualOriginOffset ?? { x: 0, y: 0, z: 0 });
  finiteVector(originOffset);
  if (
    typeof options.ground !== "function" ||
    typeof options.motion !== "function" ||
    typeof options.material !== "function"
  )
    throw animalError("OPTIONS", "ground, game motion and material factories are required");
  const object = new Group();
  const root = new Vector3();
  const velocity = new Vector3();
  const foot = new Vector3();
  const geometry = geometryFromValidatedBake(bake);
  const pose = createAnimalPose(bake);
  const bounds = createAnimalBounds(bake, geometry);
  const worldToLocal = new Matrix4();
  let heading = 0;
  let groundBias = 0;
  let disposed = false;
  let paused = false;
  const actions = new Set<(result: AnimalActionResult) => void>();
  const ground = (x: number, z: number) => {
    const height = options.ground(x, z);
    if (!Number.isFinite(height))
      throw animalError("GROUND", `no finite physics/navigation ground at ${x},${z}`);
    return height + groundBias;
  };
  const createMotion = () =>
    options.motion({
      data: bake,
      skeleton: pose.skeleton,
      ground,
      position: foot.clone(),
      heading,
      emit: () => undefined,
    });
  let material: Material | undefined;
  let motion: IAnimalMotion;
  let motionOwned = false;
  try {
    material = options.material(pose);
    if (!(material instanceof Material))
      throw animalError("MATERIAL", "game factory must return a material");
    motion = createMotion();
    motionOwned = true;
  } catch (error) {
    cleanupOwned(
      [
        () => {
          if (material instanceof Material) material.dispose();
        },
        () => geometry.dispose(),
        () => pose.dispose(),
      ],
      error,
    );
    throw error;
  }
  if (!material) throw animalError("MATERIAL", "missing material");
  const ownedMaterial = material;
  const mesh = new Mesh(geometry, ownedMaterial);
  object.add(mesh);
  geometry.boundingSphere = bounds.sphere;
  geometry.boundingBox = bounds.box;
  const requireLive = () => {
    if (disposed) throw animalError("DISPOSED", "animal actor is disposed");
  };
  const settle = (result: AnimalActionResult) => {
    for (const done of [...actions]) done(result);
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    settle("disposed");
    cleanupOwned([
      () => {
        if (motionOwned) {
          motionOwned = false;
          motion.dispose();
        }
      },
      () => object.removeFromParent(),
      () => object.clear(),
      () => geometry.dispose(),
      () => ownedMaterial.dispose(),
      () => pose.dispose(),
    ]);
  };
  const nextFoot = new Vector3();
  const rootEuler = new Euler();
  const up = new Vector3(0, 1, 0);
  const following = { position: foot, velocity, heading: 0 };
  const assign = (state: IAnimalAcceptedState) => {
    finiteVector(state.position);
    finiteVector(state.velocity);
    if (!Number.isFinite(state.heading))
      throw animalError("FOLLOW_STATE", "accepted heading must be finite");
    requireIdentityParent(object.parent);
    nextFoot.copy(originOffset).applyAxisAngle(up, state.heading).add(state.position);
    finiteVector(nextFoot);
    const sampled = options.ground(nextFoot.x, nextFoot.z);
    if (!Number.isFinite(sampled)) throw animalError("GROUND", "missing ground at accepted root");
    root.copy(state.position);
    velocity.copy(state.velocity);
    heading = state.heading;
    object.position.copy(root);
    object.quaternion.setFromEuler(rootEuler.set(0, heading, 0));
    foot.copy(nextFoot);
    // Upstream follow consumes XZ and derives Y from terrain. Bias the adapter's sampler by the
    // accepted root altitude so teleports/vertical physics never get silently replaced by terrain.
    groundBias = foot.y - sampled;
    motion.input.speed = 0;
    motion.input.target = null;
    motion.input.heading = heading;
    following.heading = heading;
    motion.input.follow = following;
  };
  const upload = () => {
    object.updateMatrix();
    worldToLocal.copy(object.matrix).invert();
    pose.update(worldToLocal);
    bounds.update(pose.data);
  };
  try {
    options.parent?.add(object);
    motion.update(1e-4);
    upload();
  } catch (error) {
    cleanupOwned([dispose], error);
    throw error;
  }
  return {
    object,
    mesh,
    pose,
    bounds,
    /** Measurement survives the explicit origin override. */
    visualOriginOffset: originOffset.clone(),
    get paused() {
      return paused;
    },
    set paused(value: boolean) {
      requireLive();
      paused = value;
    },
    follow(state: IAnimalAcceptedState, dt: number) {
      requireLive();
      if (!Number.isFinite(dt) || dt < 0 || dt > 1 / 20)
        throw animalError("FIXED_STEP", "follow requires a finite fixed step in [0, 1/20]");
      assign(state);
      if (paused || dt === 0) {
        bounds.update(pose.data);
        return;
      }
      motion.update(dt);
      upload();
    },
    teleport(state: IAnimalAcceptedState) {
      requireLive();
      assign(state);
      settle("interrupted");
      try {
        motionOwned = false;
        motion.dispose();
        velocity.set(0, 0, 0);
        motion = createMotion();
        motionOwned = true;
        following.heading = heading;
        motion.input.follow = following;
        motion.update(1e-4);
        upload();
      } catch (error) {
        cleanupOwned([dispose], error);
        throw error;
      }
    },
    play(name: "stand" | "sit" | "lie"): Promise<AnimalActionResult> {
      requireLive();
      if (!["stand", "sit", "lie"].includes(name))
        throw animalError("ACTION", `unsupported first-slice action ${name}`);
      return new Promise((resolve, reject) => {
        const done = (result: AnimalActionResult) => {
          if (!actions.delete(done)) return;
          resolve(result);
        };
        actions.add(done);
        try {
          motion.play(name).then(done, (error: unknown) => {
            actions.delete(done);
            reject(error);
          });
        } catch (error) {
          actions.delete(done);
          reject(error);
        }
      });
    },
    dispose,
  };
}
