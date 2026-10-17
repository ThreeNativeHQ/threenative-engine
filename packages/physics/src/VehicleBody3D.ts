import type { Object3D } from "three";
import type { CollisionShape3D } from "./CollisionShape3D.js";
import { RigidBody3D } from "./RigidBody3D.js";
import type { IPhysicsWorldHandle } from "./handles.js";
import type { IPhysicsContext } from "./plugin.js";
import {
  type IPhysicsSimulation,
  type IPhysicsVector3,
  type IPhysicsVehicleState,
  type IPhysicsVehicleWheelOptions,
  PHYSICS_VEHICLE_WHEEL_STRIDE,
  requirePhysicsSimulation,
} from "./simulation.js";

/** Godot's `VehicleWheel3D`, one entry of `IVehicleBody3DOptions.wheels`. */
export type IVehicleWheel3D = IPhysicsVehicleWheelOptions;

/**
 * Which chassis-local axis the car drives along, and which way `engineForce` pushes it. `-z` is the
 * default because that is the direction a Three.js object faces.
 */
export type VehicleForwardAxis = "-x" | "-z" | "x" | "z";

export interface IVehicleBody3DOptions {
  /** The visual root the body drives; its position and quaternion are written back every step. */
  readonly object: Object3D;
  readonly entity?: string;
  readonly physics?: IPhysicsContext;
  /** @deprecated Prefer `physics`; a raw web world is backend-specific. */
  readonly world?: IPhysicsWorldHandle | unknown;
  /** The chassis collider, and the only shape the wheels are not tested against. */
  readonly shape: CollisionShape3D;
  /** Chassis mass in kg. Default 0, which Rapier fills in from the collider. */
  readonly mass?: number;
  readonly forwardAxis?: VehicleForwardAxis;
  readonly wheels: readonly IVehicleWheel3D[];
  /** Godot's collision_layer — which layers the chassis occupies. Default 1. */
  readonly collisionLayer?: number;
  /** Godot's collision_mask — which layers the chassis and its wheel rays scan. Default 0xffff. */
  readonly collisionMask?: number;
}

/**
 * Rapier takes a forward axis index, and the axle's sign is what decides which way along that axis
 * a positive `engineForce` drives, so a signed axis name becomes a pair. Flipping any one entry
 * below reverses that car.
 */
const FORWARD_AXES: Readonly<
  Record<VehicleForwardAxis, { readonly axle: IPhysicsVector3; readonly index: 0 | 2 }>
> = {
  "-x": { axle: { x: 0, y: 0, z: -1 }, index: 0 },
  "-z": { axle: { x: 1, y: 0, z: 0 }, index: 2 },
  x: { axle: { x: 0, y: 0, z: 1 }, index: 0 },
  z: { axle: { x: -1, y: 0, z: 0 }, index: 2 },
};

function requireFinite(value: number, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`TN_VEHICLE_INVALID: ${label} must be a finite number.`);
}

/**
 * Godot's `VehicleBody3D`: a dynamic chassis carried on ray-cast wheels with a real suspension.
 *
 * It is a `RigidBody3D` — the chassis collider, mass, transform sync and `dispose()` are the ones
 * that class already has — plus the wheel controller, which is why a vehicle's lifetime is its
 * body's lifetime and there is no separate removal call.
 */
export class VehicleBody3D extends RigidBody3D {
  /** A vehicle always drives an object; the base type only allows one for fixed bodies. */
  declare readonly object: Object3D;
  readonly wheels: readonly IVehicleWheel3D[];
  readonly #object: Object3D;
  readonly #simulation: IPhysicsSimulation;
  readonly #readState: NonNullable<IPhysicsSimulation["readVehicleState"]>;
  readonly #setInput: NonNullable<IPhysicsSimulation["setVehicleInput"]>;
  readonly #vehicle: number;
  #engineForce = 0;
  #brake = 0;
  #steering = 0;
  #disposed = false;

  constructor(options: IVehicleBody3DOptions) {
    const forward = FORWARD_AXES[options.forwardAxis ?? "-z"];
    if (forward === undefined)
      throw new Error(
        `TN_VEHICLE_INVALID: forwardAxis '${String(options.forwardAxis)}' must be one of -x, -z, x, z.`,
      );
    const simulation = requirePhysicsSimulation(options.physics, options.world);
    const createVehicle = simulation.createVehicle;
    const setVehicleInput = simulation.setVehicleInput;
    const readVehicleState = simulation.readVehicleState;
    // Fail closed like every other missing-backend-capability seam: a car that silently never
    // moves is the one bug that reads as "the physics is broken" on a single platform.
    if (
      createVehicle === undefined ||
      setVehicleInput === undefined ||
      readVehicleState === undefined
    )
      throw new Error(
        "TN_VEHICLE_NATIVE_UNAVAILABLE: the active physics backend has no vehicle controller. Use RigidBody3D instead.",
      );
    super({
      collisionLayer: options.collisionLayer,
      collisionMask: options.collisionMask,
      entity: options.entity,
      mass: options.mass ?? 0,
      object: options.object,
      physics: options.physics,
      shape: options.shape,
      type: "dynamic",
      world: options.world,
    });
    this.wheels = options.wheels;
    this.#object = options.object;
    this.#simulation = simulation;
    this.#readState = readVehicleState;
    this.#setInput = setVehicleInput;
    try {
      this.#vehicle = createVehicle.call(simulation, {
        axle: forward.axle,
        bodyId: this.body.id,
        forwardAxis: forward.index,
        wheels: options.wheels,
      });
    } catch (error) {
      // The chassis exists; a car whose wheels were rejected must not leave it behind.
      this.dispose();
      throw error;
    }
  }

  /**
   * Godot's `engine_force`, in newtons. Every wheel with `useAsTraction` receives the full value,
   * so two driven wheels are twice the force. Negative is reverse.
   */
  get engineForce(): number {
    this.#requireLive("engineForce");
    return this.#engineForce;
  }

  set engineForce(value: number) {
    requireFinite(value, "engineForce");
    if (value === this.#engineForce) return;
    this.#engineForce = value;
    this.#pushInput();
  }

  /** Godot's `brake`, applied to every wheel. It is a braking impulse, not a force. */
  get brake(): number {
    this.#requireLive("brake");
    return this.#brake;
  }

  set brake(value: number) {
    requireFinite(value, "brake");
    if (value === this.#brake) return;
    this.#brake = value;
    this.#pushInput();
  }

  /** Godot's `steering`, in radians, applied to every wheel with `useAsSteering`. */
  get steering(): number {
    this.#requireLive("steering");
    return this.#steering;
  }

  set steering(value: number) {
    requireFinite(value, "steering");
    if (value === this.#steering) return;
    this.#steering = value;
    this.#pushInput();
  }

  /**
   * Signed metres per second along `forwardAxis`: positive while accelerating forward. It reflects
   * the last completed step, so read it after the physics update.
   */
  get speed(): number {
    return this.#state().speed;
  }

  /** Whether this wheel's suspension ray found ground on the last completed step. */
  wheelContact(index: number): boolean {
    return this.#wheel(index, 0) === 1;
  }

  /** How far the wheel hangs below its attachment point, in metres. Below the rest length while loaded. */
  wheelSuspensionLength(index: number): number {
    return this.#wheel(index, 1);
  }

  /** The wheel's spin angle in radians, for animating the mesh. */
  wheelRotation(index: number): number {
    return this.#wheel(index, 2);
  }

  /**
   * Respawn: move the chassis, face `yaw` radians, and drop both velocities. Wheels keep their
   * cached spin, so the first frame after a rescue is one frame of stale wheel animation.
   */
  teleport(position: Pick<Object3D["position"], "x" | "y" | "z">, yaw: number): void {
    this.#requireLive("teleport");
    if (this.#simulation.resetVehicle === undefined)
      throw new Error(
        "TN_VEHICLE_NATIVE_UNAVAILABLE: the active physics backend cannot respawn a vehicle.",
      );
    requireFinite(yaw, "yaw");
    this.#simulation.resetVehicle(this.#vehicle, position, yaw);
    this.#object.position.set(position.x, position.y, position.z);
    this.#object.rotation.set(0, yaw, 0);
    this.physics?.resetInterpolation?.(this.#object);
  }

  override dispose(): void {
    // The chassis owns the wheels: removing the body releases the controller with it.
    super.dispose();
    this.#disposed = true;
  }

  #pushInput(): void {
    if (this.#disposed) throw new Error("VehicleBody3D input cannot be used after dispose.");
    this.#setInput(this.#vehicle, {
      brake: this.#brake,
      engineForce: this.#engineForce,
      steering: this.#steering,
    });
  }

  #state(): IPhysicsVehicleState {
    this.#requireLive("vehicle state");
    const state = this.#readState(this.#vehicle);
    if (state === undefined) throw new Error("TN_VEHICLE_UNKNOWN: the vehicle left the backend.");
    return state;
  }

  #wheel(index: number, field: number): number {
    if (!Number.isSafeInteger(index) || index < 0 || index >= this.wheels.length)
      throw new Error(
        `TN_VEHICLE_INVALID: wheel index ${String(index)} is outside 0 through ${this.wheels.length - 1}.`,
      );
    return this.#state().wheels[index * PHYSICS_VEHICLE_WHEEL_STRIDE + (field as number)] ?? 0;
  }

  #requireLive(operation: string): void {
    if (this.#disposed) throw new Error(`VehicleBody3D.${operation} cannot be used after dispose.`);
  }
}
