import type { Object3D, Vector3 } from "three";
import { resolveInitialTransform } from "./Area3D.js";
import type { Buoyancy3D } from "./Buoyancy3D.js";
import type { CollisionShape3D } from "./CollisionShape3D.js";
import { interactionGroups } from "./collision.js";
import type { IPhysicsBodyHandle, IPhysicsColliderHandle, IPhysicsWorldHandle } from "./handles.js";
import type { IPhysicsContext } from "./plugin.js";
import {
  type IPhysicsSimulation,
  effectiveContinuousCollision,
  requirePhysicsSimulation,
} from "./simulation.js";
import { bulkTransformValue } from "./transformRecord.js";

export type RigidBodyType = "dynamic" | "fixed" | "kinematic";

export interface IRigidBody3DOptions {
  /** The transform this body drives. Omit for a fixed collider with no visual; supply `position`. */
  readonly object?: Object3D;
  /** Initial world position. Only for a fixed body with no `object`. */
  readonly position?: Pick<Vector3, "x" | "y" | "z">;
  readonly entity?: string;
  readonly physics?: IPhysicsContext;
  /** @deprecated Prefer `physics`; a raw web world is backend-specific. */
  readonly world?: IPhysicsWorldHandle | unknown;
  readonly shape: CollisionShape3D;
  readonly mass?: number;
  readonly type?: RigidBodyType;
  /** Godot's collision_layer — which layers this body occupies. Default 1. */
  readonly collisionLayer?: number;
  /** Godot's collision_mask — which layers this body scans. Default 0xffff. */
  readonly collisionMask?: number;
  /** Enable continuous collision for fast-moving dynamic bodies. Dynamic defaults true; fixed and kinematic bodies are always disabled. */
  readonly continuousCollision?: boolean;
}

export class RigidBody3D {
  readonly body: IPhysicsBodyHandle;
  readonly collider: IPhysicsColliderHandle;
  /** The supplied transform; position-only fixed bodies have no runtime object. */
  readonly object: Object3D | undefined;
  readonly shape: CollisionShape3D;
  readonly type: RigidBodyType;
  readonly mass: number;
  /** The effective continuous-collision setting; dynamic defaults true, fixed and kinematic are always false. */
  readonly continuousCollision: boolean;
  buoyancy: Buoyancy3D | undefined;
  readonly #simulation: IPhysicsSimulation;
  readonly #physics: IPhysicsContext | undefined;
  readonly #object: Object3D | undefined;
  #lastPosition: { x: number; y: number; z: number };
  // Scratch returned by kinematicMotion(); the plugin retains it only within one update pass.
  readonly #motion = { x: 0, y: 0, z: 0 };
  readonly #zeroMotion: { readonly x: 0; readonly y: 0; readonly z: 0 } = { x: 0, y: 0, z: 0 };
  #disposed = false;
  #interpolate = true;

  /** Draw between solved ticks; false presents this body at its true tick pose. */
  get interpolate(): boolean {
    return this.#interpolate;
  }
  set interpolate(enabled: boolean) {
    this.#requireLive("interpolate");
    if (typeof enabled !== "boolean") throw new Error("interpolate must be a boolean.");
    if (enabled === this.#interpolate) return;
    this.#interpolate = enabled;
    this.#physics?.updateInterpolation?.(this);
  }

  constructor(options: IRigidBody3DOptions) {
    const initial = resolveInitialTransform(options);
    const type = options.type ?? "dynamic";
    if (options.object === undefined && type !== "fixed")
      throw new Error("RigidBody3D position-only bodies must be fixed.");
    this.#simulation = requirePhysicsSimulation(options.physics, options.world);
    this.#physics = options.physics;
    this.object = options.object;
    this.shape = options.shape;
    this.#object = options.object;
    this.type = type;
    this.mass = options.mass ?? 0;
    if (
      options.continuousCollision !== undefined &&
      typeof options.continuousCollision !== "boolean"
    )
      throw new Error("RigidBody3D continuousCollision must be a boolean.");
    this.continuousCollision = effectiveContinuousCollision(type, options.continuousCollision);
    this.buoyancy = undefined;
    const shape = options.shape.descriptor;
    if (options.collisionLayer !== undefined || options.collisionMask !== undefined) {
      const layer = options.collisionLayer ?? shape.collisionLayer;
      const mask = options.collisionMask ?? shape.collisionMask;
      options.shape.setCollisionGroups(interactionGroups(layer, mask));
    }
    const registration = this.#simulation.createBody({
      entity: options.entity,
      mass: this.mass,
      position: initial.position,
      rotation: initial.rotation,
      sensor: shape.sensor,
      shape,
      type: this.type,
      continuousCollision: this.continuousCollision,
    });
    options.shape.bindRaw(registration.rawShape);
    this.body = registration.body;
    this.collider = registration.collider;
    this.#lastPosition = {
      x: initial.position.x,
      y: initial.position.y,
      z: initial.position.z,
    };
    this.#physics?.add(this);
  }

  get physics(): IPhysicsContext | undefined {
    return this.#physics;
  }

  /** Called by the shared plugin before a bulk step. */
  writeKinematic(buffer: Float32Array, offset: number): void {
    const object = this.#object;
    if (this.#disposed || object === undefined) return;
    // Scalar writes: an array literal here was one more thrown-away object per body per step.
    buffer[offset] = this.body.id;
    buffer[offset + 1] = object.position.x;
    buffer[offset + 2] = object.position.y;
    buffer[offset + 3] = object.position.z;
    buffer[offset + 4] = object.quaternion.x;
    buffer[offset + 5] = object.quaternion.y;
    buffer[offset + 6] = object.quaternion.z;
    buffer[offset + 7] = object.quaternion.w;
  }

  /** Displacement since the last backend transform, used for moving-platform carry. */
  kinematicMotion(): { readonly x: number; readonly y: number; readonly z: number } {
    const object = this.#object;
    if (object === undefined) return this.#zeroMotion;
    // Reused per body: the plugin keeps this value only until the end of the update pass.
    this.#motion.x = object.position.x - this.#lastPosition.x;
    this.#motion.y = object.position.y - this.#lastPosition.y;
    this.#motion.z = object.position.z - this.#lastPosition.z;
    return this.#motion;
  }

  /** Assign a world position to teleport; mutate object.position for ordinary kinematic motion. */
  get position(): Pick<Vector3, "x" | "y" | "z"> {
    const position =
      this.#object?.position ?? this.#simulation.readBodyTransform?.(this.body.id)?.position;
    if (position === undefined) throw new Error("RigidBody3D position is unavailable.");
    return position;
  }

  set position(position: Pick<Vector3, "x" | "y" | "z">) {
    this.#requireLive("position");
    this.#simulation.setBodyTransform(this.body.id, position);
    this.#lastPosition.x = position.x;
    this.#lastPosition.y = position.y;
    this.#lastPosition.z = position.z;
    if (this.#object !== undefined) {
      this.#object.position.set(position.x, position.y, position.z);
      this.#physics?.resetInterpolation?.(this.#object);
    }
  }

  syncToPhysics(): void {
    // The plugin collects this object's transform into the reusable bulk input buffer.
  }

  /**
   * Godot's `apply_impulse`. The one-shot shove: a thrown crate, a jump pad, a hit reaction.
   *
   * These four members exist because there is otherwise no portable way to move a dynamic body
   * at all. `body.raw` is a Rapier object on web and opaque on native, so reaching through it
   * forks the game by platform, and a transform write is discarded by the next step.
   */
  applyImpulse(impulse: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.#requireLive("applyImpulse");
    this.#simulation.applyBodyImpulse(this.body.id, impulse);
  }

  /** Godot's `apply_force`. Continuous push; cleared by the backend each step. */
  applyForce(force: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.#requireLive("applyForce");
    this.#simulation.applyBodyForce(this.body.id, force);
  }

  /** Godot's force-at-position equivalent. Continuous push in world space; cleared each step. */
  applyForceAtPoint(
    force: { readonly x: number; readonly y: number; readonly z: number },
    point: { readonly x: number; readonly y: number; readonly z: number },
  ): void {
    this.#requireLive("applyForceAtPoint");
    this.#simulation.applyBodyForceAtPoint(this.body.id, force, point);
  }

  /** Godot's `linear_velocity`. */
  get linearVelocity(): { readonly x: number; readonly y: number; readonly z: number } {
    this.#requireLive("linearVelocity");
    return this.#simulation.readBodyLinearVelocity(this.body.id);
  }

  set linearVelocity(velocity: { readonly x: number; readonly y: number; readonly z: number }) {
    this.#requireLive("linearVelocity");
    this.#simulation.setBodyLinearVelocity(this.body.id, velocity);
  }

  #requireLive(operation: string): void {
    if (this.#disposed) throw new Error(`RigidBody3D.${operation} cannot be used after dispose.`);
  }

  syncFromPhysics(): void {
    const object = this.#object;
    if (object === undefined) return;
    // Fail closed like every other missing-backend-capability seam: a silent return here
    // would leave the object stale on one platform only.
    if (this.#simulation.readBodyTransform === undefined)
      throw new Error(
        "TN_PHYSICS_READ_TRANSFORM_MISSING: the active physics backend cannot read body transforms.",
      );
    const transform = this.#simulation.readBodyTransform(this.body.id);
    if (transform === undefined) return;
    object.position.set(transform.position.x, transform.position.y, transform.position.z);
    object.quaternion.set(
      transform.rotation.x,
      transform.rotation.y,
      transform.rotation.z,
      transform.rotation.w,
    );
    this.#lastPosition.x = transform.position.x;
    this.#lastPosition.y = transform.position.y;
    this.#lastPosition.z = transform.position.z;
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
    const object = this.#object;
    if (object === undefined) return;
    object.position.set(x, y, z);
    object.quaternion.set(qx, qy, qz, qw);
    this.#lastPosition.x = x;
    this.#lastPosition.y = y;
    this.#lastPosition.z = z;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.buoyancy?.dispose();
    this.buoyancy = undefined;
    this.#physics?.remove(this);
    this.#simulation.removeBody(this.body.id);
  }
}
