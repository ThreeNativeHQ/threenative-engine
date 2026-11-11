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

/**
 * Seating a standing character. Rapier's controller does not hold a grounded body still: each
 * gravity step ends with a 0.1 mm nudge along the contact normal (`normal_nudge_factor`), and a
 * walk leaves the body up to 9 mm inside its contact offset, from where it climbs back 0.1 mm a
 * step. A follow camera aimed at such a body turns 0.02 px a frame, which flips antialiasing
 * samples along every high-contrast edge on screen.
 *
 * A grounded body that asks for no travel but its gravity step is seated instead. `Step` sends the
 * gravity step until the solver answers with less than `SEAT_BAND` of travel. `Lift` then raises
 * the body `SEAT_LIFT`, or one gravity step when that is less, and `Check` sends the gravity step: a body that rises is still inside its offset and lifts
 * again, and a body the ground stops has landed on its offset. `Rest` sends no travel from then
 * on, so the body stays where it landed. Asking to move, a moving floor, ground that can move
 * with no notice and losing the ground all return to `Step`.
 */
enum Seat {
  Step = 0,
  Lift = 1,
  Check = 2,
  Rest = 3,
}
const SEAT_LIFT = 1e-3;
/** The solver's answer counts as no travel under a quarter of the gravity step, and never under two nudges. */
const SEAT_BAND = 2e-4;
/** Half a nudge: the ground stopped a step that ends this far short of the travel it asked for. */
const SEAT_STOPPED = 5e-5;
/** One contact offset of the default size, with slack: after this many lifts the body rests where it is. */
const SEAT_LIFTS = 16;
/**
 * Rapier slides a body down ground steeper than 45 degrees, and at a high step rate one step of
 * that slide is shorter than `SEAT_BAND`. Ground within 10 degrees of that angle, the noise in a
 * contact normal, does not seat.
 */
const SEAT_GROUND_Y = Math.cos(Math.PI / 4 - Math.PI / 18);
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
  /**
   * The water surface height in metres at world (x, z), or `undefined` where there is none. With
   * it the body swims the way Unreal's CharacterMovementComponent does: once its centre is under
   * the surface it is `swimming`, buoyancy and fluid friction replace gravity, and its horizontal
   * speed is held to `maxSwimSpeed`; shallower water only slows it. Without it nothing changes.
   */
  readonly water?: CharacterWaterQuery;
  /**
   * The water's own velocity at world (x, z) in m/s, or `undefined` where there is none. While any
   * part of the body is under water it is carried downstream, added to its horizontal motion before
   * its own move input: a swimmer floats at the river's full speed, and a wader, whose feet hold the
   * bed, takes a share that grows with depth until its centre goes under. Unreal pushes a body in a
   * river towards the spline's own velocity while it moves slower than the water, so a floating body
   * settles at the water's speed (UE 5.8.3:
   * Engine/Plugins/Experimental/Water/Source/Runtime/Private/BuoyancyComponent.cpp:724-753).
   * Without it nothing changes.
   */
  readonly waterCurrent?: CharacterWaterCurrentQuery;
  /**
   * Unreal's `Buoyancy`: the body floats where `buoyancy * immersionDepth = 1`. Default 1.6, which
   * floats it with its centre just under the surface. Unreal ships 1.0, which is neutral: the body
   * drifts to the bottom.
   */
  readonly buoyancy?: number;
  /** Unreal's `MaxSwimSpeed` in m/s: half its walk speed. Default 3. */
  readonly maxSwimSpeed?: number;
  /**
   * Unreal's water-volume `FluidFriction`, applied to vertical speed while swimming. Default 12,
   * which settles a swimmer in about a second; Unreal's 0.3 bobs it for many seconds.
   */
  readonly fluidFriction?: number;
}

/** Water surface height at world (x, z), or `undefined` where there is no water. */
export type CharacterWaterQuery = (x: number, z: number) => number | undefined;

/** The water's own velocity in m/s at world (x, z), or `undefined` where there is no water. */
export type CharacterWaterCurrentQuery = (
  x: number,
  z: number,
) => { x: number; z: number } | undefined;

function halfHeightOf(shape: CollisionShape3D): number | undefined {
  const { kind, x, y } = shape.descriptor;
  return kind === "capsule" ? x + y : kind === "box" ? y : kind === "sphere" ? x : undefined;
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
  /** See `ICharacterBody3DOptions.water`; assign it once the water exists. */
  water: CharacterWaterQuery | undefined;
  /** See `ICharacterBody3DOptions.waterCurrent`; assign it once the water exists. */
  waterCurrent: CharacterWaterCurrentQuery | undefined;
  /**
   * The water's own velocity the last `moveAndSlide` applied, in m/s: the full current while
   * swimming, a depth-weighted share of it while wading, `(0, 0)` out of water. Read it to tell a
   * drift from a step.
   */
  readonly currentVelocity = { x: 0, z: 0 };
  buoyancy: number;
  maxSwimSpeed: number;
  fluidFriction: number;
  /** True while the body's centre is under the water surface (Unreal's MOVE_Swimming). */
  swimming = false;
  /** Unreal's `ImmersionDepth`: the share of the collider's height under water, 0 to 1. */
  immersionDepth = 0;
  /** The water surface height the last `moveAndSlide` read, or `undefined` out of water. */
  waterSurface: number | undefined;
  readonly #halfHeight: number | undefined;
  readonly #simulation: IPhysicsSimulation;
  readonly #physics: IPhysicsContext | undefined;
  #desired = { x: 0, y: 0, z: 0 };
  #sliding = false;
  #groundCollider: number | undefined;
  #beforeY = 0;
  #desiredY = 0;
  #still = false;
  #seat = Seat.Step;
  #lifts = 0;
  /** Where the last step started, and the solver's pose after it with the pose the object was given. */
  #from = { x: 0, y: 0, z: 0 };
  #solved = { x: 0, y: 0, z: 0 };
  #shown = { x: 0, y: 0, z: 0 };
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
    this.water = options.water;
    this.waterCurrent = options.waterCurrent;
    this.buoyancy = options.buoyancy ?? 1.6;
    this.maxSwimSpeed = options.maxSwimSpeed ?? 3;
    this.fluidFriction = options.fluidFriction ?? 12;
    if (!(this.buoyancy >= 0 && this.maxSwimSpeed > 0 && this.fluidFriction >= 0))
      throw new Error(
        "CharacterBody3D needs buoyancy >= 0, maxSwimSpeed > 0 and fluidFriction >= 0.",
      );
    this.#halfHeight = halfHeightOf(options.shape);
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
    const depth = this.#immerse();
    let fall = this.gravity;
    if (this.swimming) {
      // UE 5.8.3 PhysSwimming: a fast rise is damped so the body cannot leap out, fluid friction
      // grows with depth, and buoyancy cancels gravity where buoyancy * depth = 1.
      const rise = 0.33 * this.maxSwimSpeed;
      if (this.velocity.y > rise) this.velocity.y = Math.max(rise, this.velocity.y * depth * depth);
      this.velocity.y *= 1 - Math.min(0.5 * this.fluidFriction * depth * dt, 1);
      fall *= 1 - this.buoyancy * depth;
    }
    this.velocity.y = Math.max(this.velocity.y + fall * dt, -this.maxFallSpeed);
    if (depth > 0) {
      // Wading slows the body towards swim speed, reached as its centre goes under.
      const cap = this.maxSwimSpeed / Math.min(1, 2 * depth);
      const speed = Math.hypot(this.velocity.x, this.velocity.z);
      if (speed > cap) {
        this.velocity.x *= cap / speed;
        this.velocity.z *= cap / speed;
      }
    }
    this.#carry(depth);
    // The water moves the body first and the player's own input rides on top of it, so swimming
    // across a river is a heading and not a fight with a speed cap.
    this.#desired.x = (this.velocity.x + this.currentVelocity.x) * dt;
    this.#desired.y = this.velocity.y * dt;
    this.#desired.z = (this.velocity.z + this.currentVelocity.z) * dt;
    this.#sliding = true;
  }

  /** Called by the shared plugin before a bulk step. */
  writeKinematic(buffer: Float32Array, offset: number): void {
    if (this.#disposed) return;
    // A lift is not shown, so the object can trail the body by one step: the step then starts from
    // the solver's pose. An object the game moved itself starts from where the game put it.
    const at = this.object.position;
    const shown = this.#shown;
    const from = at.x === shown.x && at.y === shown.y && at.z === shown.z ? this.#solved : at;
    this.#from.x = from.x;
    this.#from.y = from.y;
    this.#from.z = from.z;
    this.#beforeY = from.y;
    this.#desiredY = this.#desired.y;
    const carry =
      this.#sliding && this.grounded && this.velocity.y <= 0 && this.#groundCollider !== undefined
        ? this.#physics?.kinematicMotion?.(this.#groundCollider)
        : undefined;
    const carryX = carry?.x ?? 0;
    const carryY = carry?.y ?? 0;
    const carryZ = carry?.z ?? 0;
    this.#still =
      this.#sliding &&
      this.grounded &&
      this.#desired.x === 0 &&
      this.#desired.z === 0 &&
      // Seating lets the gravity step land a lifted body: with no gravity step there is nothing to
      // seat, and a lift would never come back down.
      this.#desired.y < 0 &&
      carryX === 0 &&
      carryY === 0 &&
      carryZ === 0 &&
      (this.groundBody === undefined || this.#physics?.groundHolds?.(this.groundBody.id) !== false);
    if (!this.#still) this.#seat = Seat.Step;
    const travelY =
      this.#seat === Seat.Rest
        ? 0
        : this.#seat === Seat.Lift
          ? Math.min(SEAT_LIFT, -this.#desired.y)
          : this.#desired.y;
    // Scalar writes: an array literal here was one more thrown-away object per body per step.
    buffer[offset] = this.body.id;
    buffer[offset + 1] = from.x + this.#desired.x + carryX;
    buffer[offset + 2] = from.y + travelY + carryY;
    buffer[offset + 3] = from.z + this.#desired.z + carryZ;
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
    const lifted = this.#seat === Seat.Lift;
    this.#seated(x - this.#from.x, y - this.#from.y, z - this.#from.z);
    this.#solved.x = x;
    this.#solved.y = y;
    this.#solved.z = z;
    if (!lifted) this.object.position.set(x, y, z);
    this.#shown.x = this.object.position.x;
    this.#shown.y = this.object.position.y;
    this.#shown.z = this.object.position.z;
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

  /**
   * UE 5.8.3 river forces settle a floating body at the water's own speed, so a swimmer (centre
   * under, `immersionDepth > 0.5`) takes the whole current. A wader's feet hold the bed: it takes
   * `(2 * depth)^2` of it, drag on the wetted height, which reaches the whole current exactly where
   * swimming starts, so stepping off the bed is not a jolt. A lake's current is zero.
   */
  #carry(depth: number): void {
    const query = this.waterCurrent;
    const current =
      depth > 0 && query !== undefined
        ? query(this.object.position.x, this.object.position.z)
        : undefined;
    if (current !== undefined && (!Number.isFinite(current.x) || !Number.isFinite(current.z)))
      throw new Error(
        "CharacterBody3D.waterCurrent must return finite x and z in m/s, or undefined.",
      );
    const share = Math.min(1, 2 * depth) ** 2;
    this.currentVelocity.x = current === undefined ? 0 : current.x * share;
    this.currentVelocity.z = current === undefined ? 0 : current.z * share;
  }

  /** UE 5.8.3 ImmersionDepth: the share of the collider below the surface, from top to bottom. */
  #immerse(): number {
    const { x, y, z } = this.object.position;
    const surface = this.water?.(x, z);
    if (surface !== undefined && !Number.isFinite(surface))
      throw new Error("CharacterBody3D.water must return a finite surface height or undefined.");
    const half = this.#halfHeight;
    if (surface !== undefined && half === undefined)
      throw new Error("CharacterBody3D.water needs a capsule, box or sphere shape to measure.");
    this.waterSurface = surface;
    this.immersionDepth =
      surface === undefined || half === undefined
        ? 0
        : Math.min(1, Math.max(0, (surface - y + half) / (2 * half)));
    // Unreal swims once the body's centre is inside the water volume.
    this.swimming = this.immersionDepth > 0.5;
    return this.immersionDepth;
  }

  /** Advances the seat from the solver's answer to the step that just ran. */
  #seated(dx: number, dy: number, dz: number): void {
    if (this.#seat === Seat.Rest && this.#still && this.grounded) return;
    const band = Math.max(SEAT_BAND, -0.25 * this.#desiredY);
    if (
      !this.#still ||
      !this.grounded ||
      this.groundNormal.y < SEAT_GROUND_Y ||
      Math.abs(dx) >= band ||
      Math.abs(dz) >= band
    ) {
      this.#seat = Seat.Step;
      this.#lifts = 0;
    } else if (this.#seat === Seat.Step) {
      if (Math.abs(dy) < band) this.#seat = Seat.Lift;
    } else if (this.#seat === Seat.Lift) {
      this.#seat = Seat.Check;
    } else if (dy >= 0) {
      this.#lifts += 1;
      this.#seat = this.#lifts < SEAT_LIFTS ? Seat.Lift : Seat.Rest;
    } else if (dy > this.#desiredY + SEAT_STOPPED) {
      this.#seat = Seat.Rest;
    }
  }

  #clearGroundState(): void {
    this.grounded = false;
    this.#groundCollider = undefined;
    this.groundBody = undefined;
    this.groundNormal.set(0, 1, 0);
    this.slopeAngle = 0;
  }
}
