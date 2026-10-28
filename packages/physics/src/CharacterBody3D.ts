import { type Object3D, Vector3 } from "three";
import type { CollisionShape3D } from "./CollisionShape3D.js";
import { interactionGroups } from "./collision.js";
import type {
  IPhysicsBodyHandle,
  IPhysicsColliderHandle,
  IPhysicsHandle,
  IPhysicsWorldHandle,
} from "./handles.js";
import type { IPhysicsContext } from "./plugin.js";
import {
  type IPhysicsCharacterOptions,
  type IPhysicsSimulation,
  requirePhysicsSimulation,
} from "./simulation.js";
import { bulkTransformValue, setRotationIfChanged } from "./transformRecord.js";

export interface ICharacterBody3DOptions {
  readonly object: Object3D;
  readonly entity?: string;
  readonly physics?: IPhysicsContext;
  /** @deprecated Prefer `physics`; a raw web world is backend-specific. */
  readonly world?: IPhysicsWorldHandle | unknown;
  readonly shape: CollisionShape3D;
  readonly offset?: number;
  readonly maxSlopeClimbAngle?: number;
  readonly autostep?: {
    readonly maxHeight: number;
    readonly minWidth: number;
    readonly includeDynamicBodies?: boolean;
  };
  readonly snapToGround?: number;
  /**
   * Vertical acceleration in m/s², added to `velocity.y` every `moveAndSlide(dt)`. It is a
   * signed component of a velocity, not a strength: **down is negative**. `-9.81` is earth,
   * `-24` a snappy platformer, `0` a planar top-down game that must not fall, and a positive
   * value accelerates the character upward.
   *
   * Passing the magnitude — `gravity: 24` — makes the character fly, which on screen is
   * indistinguishable from a broken collider. Default `-9.81`.
   */
  readonly gravity?: number;
  /** Terminal downward speed in m/s, as a positive magnitude. Default 50. */
  readonly maxFallSpeed?: number;
  /** Godot's collision_layer — which layers this body occupies. Default 1. */
  readonly collisionLayer?: number;
  /** Godot's collision_mask — which layers this body scans. Default 0xffff. */
  readonly collisionMask?: number;
  /** Collider layer bits to ignore while moving upward. */
  readonly oneWayLayers?: number;
  /**
   * Shove dynamic bodies the character walks into, instead of sliding past them. Default false,
   * matching Rapier. Without it a character collides with a crate and the crate never moves,
   * which reads as a physics bug rather than a default.
   */
  readonly pushesDynamicBodies?: boolean;
}

export class CharacterBody3D {
  readonly body: IPhysicsBodyHandle;
  readonly collider: IPhysicsColliderHandle;
  readonly controller: IPhysicsHandle;
  readonly object: Object3D;
  readonly velocity: Vector3;
  /** Signed vertical acceleration; see `ICharacterBody3DOptions.gravity`. Down is negative. */
  gravity: number;
  maxFallSpeed: number;
  readonly oneWayLayers: number;
  grounded = false;
  /** Contact normal from the completed physics step; reset to +Y while airborne. */
  readonly groundNormal = new Vector3(0, 1, 0);
  /** Portable handle for the body currently supporting this character. */
  groundBody: IPhysicsBodyHandle | undefined;
  /** Radians between `groundNormal` and world up (+Y). */
  slopeAngle = 0;
  readonly #simulation: IPhysicsSimulation;
  readonly #physics: IPhysicsContext | undefined;
  #desired = { x: 0, y: 0, z: 0 };
  #sliding = false;
  #groundCollider: number | undefined;
  #beforeY = 0;
  #desiredY = 0;
  #disposed = false;
  #interpolate = true;

  /** Draw between solved ticks; false presents this body at its true tick pose. */
  get interpolate(): boolean {
    return this.#interpolate;
  }
  set interpolate(enabled: boolean) {
    if (this.#disposed)
      throw new Error("CharacterBody3D.interpolate cannot be used after dispose.");
    if (typeof enabled !== "boolean") throw new Error("interpolate must be a boolean.");
    if (enabled === this.#interpolate) return;
    this.#interpolate = enabled;
    this.#physics?.updateInterpolation?.(this);
  }

  constructor(options: ICharacterBody3DOptions) {
    this.#simulation = requirePhysicsSimulation(options.physics, options.world);
    this.#physics = options.physics;
    this.object = options.object;
    this.velocity = this.object.position.clone().set(0, 0, 0);
    this.gravity = options.gravity ?? -9.81;
    this.maxFallSpeed = options.maxFallSpeed ?? 50;
    this.oneWayLayers = options.oneWayLayers ?? 0;
    const shape = options.shape.descriptor;
    if (options.collisionLayer !== undefined || options.collisionMask !== undefined) {
      const layer = options.collisionLayer ?? shape.collisionLayer;
      const mask = options.collisionMask ?? shape.collisionMask;
      options.shape.setCollisionGroups(interactionGroups(layer, mask));
    }
    const registration = this.#simulation.createBody({
      entity: options.entity,
      mass: 0,
      position: this.object.position,
      rotation: this.object.quaternion,
      sensor: shape.sensor,
      shape,
      type: "character",
    });
    if (registration.controller === undefined) {
      this.#simulation.removeBody(registration.body.id);
      throw new Error("Physics character backend did not provide a controller handle.");
    }
    options.shape.bindRaw(registration.rawShape);
    this.body = registration.body;
    this.collider = registration.collider;
    this.controller = registration.controller;
    const characterOptions: IPhysicsCharacterOptions = {
      autostep:
        options.autostep === undefined
          ? undefined
          : {
              includeDynamicBodies: options.autostep.includeDynamicBodies ?? false,
              maxHeight: options.autostep.maxHeight,
              minWidth: options.autostep.minWidth,
            },
      maxSlopeClimbAngle: options.maxSlopeClimbAngle ?? Math.PI / 4,
      offset: options.offset ?? 0.01,
      oneWayLayers: this.oneWayLayers,
      pushesDynamicBodies: options.pushesDynamicBodies ?? false,
      snapToGround: options.snapToGround,
    };
    try {
      this.#simulation.configureCharacter(this.body.id, characterOptions);
    } catch (error) {
      this.#simulation.removeBody(this.body.id);
      throw error;
    }
    this.#physics?.add(this);
  }

  move(desiredTranslation: Pick<Vector3, "x" | "y" | "z">): void {
    this.#desired.x = desiredTranslation.x;
    this.#desired.y = desiredTranslation.y;
    this.#desired.z = desiredTranslation.z;
    this.#sliding = false;
  }

  /**
   * Queue velocity-based motion for the shared bulk physics step.
   *
   * @remarks
   * This does not move `object` synchronously. The solver writes the transform after the step, so
   * reading `object.position` immediately after this call still observes the previous transform.
   * Three.js `Vector3` instances are mutable, so do not retain `object.position` itself as the
   * snapshot: use `const before = object.position.clone()` (or copy its `x`, `y`, and `z` scalars).
   * Compare that snapshot with `object.position` only after the deferred bulk physics step,
   * typically on the next frame, to measure the motion that the solver applied.
   */
  moveAndSlide(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new Error("CharacterBody3D.moveAndSlide requires a finite non-negative dt.");
    this.velocity.y = Math.max(this.velocity.y + this.gravity * dt, -this.maxFallSpeed);
    this.#desired.x = this.velocity.x * dt;
    this.#desired.y = this.velocity.y * dt;
    this.#desired.z = this.velocity.z * dt;
    this.#sliding = true;
  }

  /** Called by the shared plugin before a bulk step. */
  writeKinematic(buffer: Float32Array, offset: number): void {
    if (this.#disposed) return;
    this.#beforeY = this.object.position.y;
    this.#desiredY = this.#desired.y;
    const carry =
      this.#sliding && this.grounded && this.velocity.y <= 0 && this.#groundCollider !== undefined
        ? this.#physics?.kinematicMotion?.(this.#groundCollider)
        : undefined;
    const carryX = carry?.x ?? 0;
    const carryY = carry?.y ?? 0;
    const carryZ = carry?.z ?? 0;
    // Scalar writes: an array literal here was one more thrown-away object per body per step.
    buffer[offset] = this.body.id;
    buffer[offset + 1] = this.object.position.x + this.#desired.x + carryX;
    buffer[offset + 2] = this.object.position.y + this.#desired.y + carryY;
    buffer[offset + 3] = this.object.position.z + this.#desired.z + carryZ;
    buffer[offset + 4] = this.object.quaternion.x;
    buffer[offset + 5] = this.object.quaternion.y;
    buffer[offset + 6] = this.object.quaternion.z;
    buffer[offset + 7] = this.object.quaternion.w;
  }

  syncToPhysics(): void {
    // The plugin collects the requested target into the reusable bulk input buffer.
  }

  step(): void {
    // Kept as a public compatibility method; the shared plugin performs the bulk step.
  }

  teleport(position: Pick<Vector3, "x" | "y" | "z">): void {
    if (this.#disposed) throw new Error("CharacterBody3D.teleport cannot be used after dispose.");
    this.#simulation.setBodyTransform(this.body.id, position);
    this.object.position.set(position.x, position.y, position.z);
    this.#physics?.resetInterpolation?.(this.object);
    this.velocity.set(0, 0, 0);
    this.#desired.x = 0;
    this.#desired.y = 0;
    this.#desired.z = 0;
    this.#sliding = false;
    this.#clearGroundState();
  }

  applyTransform(values: Readonly<Float32Array>, offset: number): void {
    // Indexed reads with the same slot-order validation the old array-building helper performed.
    const x = bulkTransformValue(values, offset + 1);
    const y = bulkTransformValue(values, offset + 2);
    const z = bulkTransformValue(values, offset + 3);
    const qx = bulkTransformValue(values, offset + 4);
    const qy = bulkTransformValue(values, offset + 5);
    const qz = bulkTransformValue(values, offset + 6);
    const qw = bulkTransformValue(values, offset + 7);
    const state = this.#simulation.readCharacterState?.(this.body.id);
    this.grounded =
      state?.grounded ??
      (this.#sliding && this.#desiredY < 0 && y - this.#beforeY > this.#desiredY + 0.0001);
    this.#groundCollider = state?.groundCollider;
    if (this.grounded && state?.groundNormal !== undefined) {
      this.groundNormal.set(state.groundNormal.x, state.groundNormal.y, state.groundNormal.z);
      this.groundBody = state.groundBody;
      this.slopeAngle = Math.acos(Math.max(-1, Math.min(1, this.groundNormal.y)));
    } else if (!this.grounded) {
      this.#clearGroundState();
    }
    if (this.#sliding && this.grounded && this.velocity.y < 0) this.velocity.y = 0;
    this.object.position.set(x, y, z);
    setRotationIfChanged(this.object.quaternion, qx, qy, qz, qw);
    this.#desired.x = 0;
    this.#desired.y = 0;
    this.#desired.z = 0;
    this.#sliding = false;
  }

  syncFromPhysics(): void {
    // Fail closed like every other missing-backend-capability seam: a silent return here
    // would leave the object stale on one platform only.
    if (this.#simulation.readBodyTransform === undefined)
      throw new Error(
        "TN_PHYSICS_READ_TRANSFORM_MISSING: the active physics backend cannot read body transforms.",
      );
    const transform = this.#simulation.readBodyTransform(this.body.id);
    if (transform === undefined) return;
    this.object.position.set(transform.position.x, transform.position.y, transform.position.z);
    setRotationIfChanged(
      this.object.quaternion,
      transform.rotation.x,
      transform.rotation.y,
      transform.rotation.z,
      transform.rotation.w,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#physics?.remove(this);
    this.#simulation.removeBody(this.body.id);
    this.#clearGroundState();
  }

  #clearGroundState(): void {
    this.grounded = false;
    this.#groundCollider = undefined;
    this.groundBody = undefined;
    this.groundNormal.set(0, 1, 0);
    this.slopeAngle = 0;
  }
}
