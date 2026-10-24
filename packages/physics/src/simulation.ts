import type * as rapier from "@dimforge/rapier3d-compat";
import { interactionGroups } from "./collision.js";
import {
  type IPhysicsBodyHandle,
  type IPhysicsColliderHandle,
  type IPhysicsHandle,
  physicsBodyHandle,
  physicsColliderHandle,
  physicsHandle,
} from "./handles.js";

/** One record is logical body id, xyz position, and xyzw rotation. */
export const PHYSICS_TRANSFORM_STRIDE = 8;

export const PHYSICS_COLLISION_EVENT_STRIDE = 4;

/** One record is logical body id and a sleeping flag encoded as 0 or 1. */
export const PHYSICS_SLEEP_STATE_STRIDE = 2;

/**
 * One solved contact manifold.
 *
 * `[collider id, world x, y, z, normal x, y, z, impulse]`. The point is the mean of the
 * manifold's solver contacts and the normal points from the read target toward the touching
 * collider. The impulse is the step's summed normal impulse in newton-seconds, not a measured
 * force: divide it by the step to estimate load, and say so.
 */
export const PHYSICS_CONTACT_STRIDE = 8;
/** Caps native query buffers while remaining exactly representable by the native ABI. */
export const MAX_PHYSICS_QUERY_RESULTS = 1024;

/** Matches the f32::EPSILON boundary used by the native Rapier seam. */
const F32_EPSILON = Math.fround(2 ** -23);
/** Native nalgebra's UnitVector::try_new compares the squared norm with this value. */
const F32_EPSILON_SQUARED = Math.fround(F32_EPSILON * F32_EPSILON);

/** Mirrors the native seam's f32 conversion and left-to-right f32 length-squared arithmetic. */
function f32LengthSquared(values: readonly number[]): number {
  let lengthSquared = 0;
  for (const value of values) {
    const component = Math.fround(value);
    lengthSquared = Math.fround(lengthSquared + Math.fround(component * component));
  }
  return lengthSquared;
}

export type PhysicsShapeKind =
  | "box"
  | "sphere"
  | "capsule"
  | "trimesh"
  | "convexHull"
  | "heightfield";

/** Portable shape data. Backend-specific objects are created only by a simulation adapter. */
export interface IPhysicsShapeDescriptor {
  readonly kind: PhysicsShapeKind;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly vertices?: Float32Array;
  readonly indices?: Uint32Array;
  readonly rows?: number;
  readonly columns?: number;
  readonly heights?: Float32Array;
  readonly scale?: { readonly x: number; readonly y: number; readonly z: number };
  readonly shape?: unknown;
  collisionLayer: number;
  collisionMask: number;
  sensor: boolean;
}

export type PhysicsBodyType = "character" | "dynamic" | "fixed" | "kinematic";

/** Return the backend-effective CCD setting; only dynamic bodies can use continuous collision. */
export function effectiveContinuousCollision(
  type: PhysicsBodyType,
  requested: boolean | undefined,
): boolean {
  return type === "dynamic" && (requested ?? true);
}

export interface IPhysicsBodyCreateOptions {
  readonly type: PhysicsBodyType;
  readonly shape: IPhysicsShapeDescriptor;
  readonly entity?: string;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  readonly mass: number;
  /** Must match `shape.sensor`; conflicting values are rejected during body creation. */
  readonly sensor: boolean;
  /** Enable continuous collision for fast-moving dynamic bodies. Defaults true for dynamic bodies and is always false for non-dynamic bodies. */
  readonly continuousCollision?: boolean;
}

export interface IPhysicsVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface IPhysicsRotation {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

export type PhysicsJointKind = "pin" | "hinge" | "fixed";

export interface IPhysicsJointLimit {
  readonly lower: number;
  readonly upper: number;
}

/** Backend-neutral data for a cold-path joint creation call. Anchors and frames are local-space. */
export interface IPhysicsJointCreateOptions {
  readonly type: PhysicsJointKind;
  readonly bodyA: number;
  readonly bodyB: number;
  readonly anchorA: IPhysicsVector3;
  readonly anchorB: IPhysicsVector3;
  readonly axis?: IPhysicsVector3;
  readonly limit?: IPhysicsJointLimit;
  readonly frameA?: IPhysicsRotation;
  readonly frameB?: IPhysicsRotation;
}

export interface IPhysicsRayQuery {
  readonly from: IPhysicsVector3;
  readonly to: IPhysicsVector3;
  readonly collisionMask: number;
}

export interface IPhysicsShapeQuery {
  readonly shape: IPhysicsShapeDescriptor;
  readonly position: IPhysicsVector3;
  readonly rotation: IPhysicsRotation;
  readonly collisionMask: number;
  readonly maxResults: number;
}

export interface IPhysicsPointQuery {
  readonly position: IPhysicsVector3;
  readonly collisionMask: number;
  readonly maxResults: number;
}

export interface IPhysicsQueryHit {
  readonly body: IPhysicsBodyHandle;
  readonly entity?: string;
  readonly position: IPhysicsVector3;
}

export interface IPhysicsRayHit extends IPhysicsQueryHit {
  readonly normal: IPhysicsVector3;
  readonly distance: number;
}

export interface IPhysicsBodyRegistration {
  readonly body: IPhysicsBodyHandle;
  readonly collider: IPhysicsColliderHandle;
  readonly controller?: IPhysicsHandle;
  /** The backend shape object to expose through `CollisionShape3D.raw`. */
  readonly rawShape: unknown;
}

export interface IPhysicsCharacterOptions {
  readonly offset: number;
  readonly maxSlopeClimbAngle: number;
  readonly autostep?: {
    readonly maxHeight: number;
    readonly minWidth: number;
    readonly includeDynamicBodies: boolean;
  };
  readonly snapToGround?: number;
  readonly oneWayLayers: number;
  /** Let the character shove dynamic bodies it collides with, instead of sliding past them. */
  readonly pushesDynamicBodies?: boolean;
}

export interface IPhysicsCharacterState {
  readonly grounded: boolean;
  readonly groundBody?: IPhysicsBodyHandle;
  readonly groundCollider?: number;
  readonly groundNormal?: IPhysicsVector3;
}

/** One record is wheel contact (0 or 1), suspension length in metres, and rotation in radians. */
export const PHYSICS_VEHICLE_WHEEL_STRIDE = 3;

/** Godot's `VehicleWheel3D`, as backend-neutral data: the numbers, never a vehicle object. */
export interface IPhysicsVehicleWheelOptions {
  /** The wheel's attachment point in chassis-local space. */
  readonly position: IPhysicsVector3;
  readonly wheelRadius: number;
  readonly suspensionRestLength: number;
  /**
   * Suspension stiffness, mass-normalised: the square of the suspension's natural frequency in
   * rad/s, not newtons per metre. Sag is about `9.81 / (4 * suspensionStiffness)` metres, so `100`
   * is a road car and `20` — Godot's default number — bottoms the strut out under its own weight.
   */
  readonly suspensionStiffness: number;
  /** Damping while the suspension compresses. */
  readonly dampingCompression: number;
  /** Damping while the suspension extends. */
  readonly dampingRelaxation: number;
  /** How hard this tyre grips; a higher value brakes harder and flips the car more easily. */
  readonly wheelFrictionSlip: number;
  /** Maximum travel either side of the rest length, in metres. */
  readonly maxSuspensionTravel?: number;
  readonly useAsSteering: boolean;
  readonly useAsTraction: boolean;
}

export interface IPhysicsVehicleCreateOptions {
  /** The chassis body the wheels hang from; it must be dynamic. */
  readonly bodyId: number;
  /** Chassis-local forward axis: `0` = x, `2` = z. */
  readonly forwardAxis: 0 | 2;
  /**
   * The wheels' axle, chassis-local. The vehicle's forward is `up × axle`, so its sign decides
   * which way a positive `engineForce` drives and which way a positive `speed` means.
   */
  readonly axle: IPhysicsVector3;
  readonly wheels: readonly IPhysicsVehicleWheelOptions[];
}

export interface IPhysicsVehicleInput {
  /** Newtons per traction wheel. */
  readonly engineForce: number;
  /** Braking impulse per wheel. */
  readonly brake: number;
  /** Steering angle in radians, on steering wheels only. */
  readonly steering: number;
}

/**
 * Reflects the most recently completed step, and reuses one record per vehicle, so the next call
 * overwrites the object it returned. Read it in the same tick, or copy the fields out before the
 * step advances.
 */
export interface IPhysicsVehicleState {
  /** Signed metres per second along the chassis forward axis. */
  speed: number;
  /** Reused flat per-wheel records; see `PHYSICS_VEHICLE_WHEEL_STRIDE`. */
  readonly wheels: Float32Array;
}

export interface IPhysicsInputSnapshot {
  /** One eight-float record per kinematic body. The buffer is caller-owned and reusable. */
  readonly kinematicTransforms: Readonly<Float32Array>;
  readonly kinematicCount: number;
}

/** The backend seam used by all shared physics nodes. */
export interface IPhysicsSimulation {
  createBody(options: IPhysicsBodyCreateOptions): IPhysicsBodyRegistration;
  createJoint(options: IPhysicsJointCreateOptions): number;
  configureCharacter(id: number, options: IPhysicsCharacterOptions): void;
  removeBody(id: number): void;
  removeJoint(id: number): void;
  /** Cold-path repositioning for teleport/setup. Per-frame kinematics use `step()` input. */
  setBodyTransform(
    id: number,
    position: { readonly x: number; readonly y: number; readonly z: number },
  ): void;
  /**
   * Dynamic-body actuation. Without these a game cannot move a dynamic body at all: a transform
   * write is overwritten by the next step, so `setBodyTransform` is genuinely cold-path only.
   */
  applyBodyImpulse(id: number, impulse: IPhysicsVector3): void;
  applyBodyForce(id: number, force: IPhysicsVector3): void;
  applyBodyForceAtPoint(id: number, force: IPhysicsVector3, point: IPhysicsVector3): void;
  setBodyLinearVelocity(id: number, velocity: IPhysicsVector3): void;
  readBodyLinearVelocity(id: number): IPhysicsVector3;
  step(deltaTime: number, inputSnapshot?: IPhysicsInputSnapshot): void;
  readVisibleTransforms(renderBuffer: Float32Array): number;
  readBodySleepStates(buffer: Float32Array): number;
  intersectRay(query: IPhysicsRayQuery): IPhysicsRayHit | undefined;
  intersectShape(query: IPhysicsShapeQuery): readonly IPhysicsQueryHit[];
  intersectPoint(query: IPhysicsPointQuery): readonly IPhysicsQueryHit[];
  readBodyTransform?(id: number):
    | {
        readonly position: { readonly x: number; readonly y: number; readonly z: number };
        readonly rotation: {
          readonly x: number;
          readonly y: number;
          readonly z: number;
          readonly w: number;
        };
      }
    | undefined;
  /**
   * Reflects the most recently completed step, independent of visible-transform reads.
   *
   * This reuses one record per character, so the next call overwrites the object it returned.
   * Read it in the same tick, or copy the fields out before the step advances.
   */
  readCharacterState?(id: number): IPhysicsCharacterState | undefined;
  /**
   * Reflects the most recently completed step, independent of visible-transform reads.
   *
   * This reuses one set per area, so the next call overwrites the set it returned. Read it in
   * the same tick, or copy the fields out before the step advances.
   */
  areaIntersections?(id: number): ReadonlySet<number>;
  /**
   * Persistent solved contacts between one target collider and a set of candidate colliders.
   *
   * Collision start/stop events say a pair began touching; they carry no point, normal or load,
   * so a contact that persists cannot be observed through them. This reads the narrow phase's
   * solved manifolds directly, which is what a deformation or support consumer needs.
   *
   * One `PHYSICS_CONTACT_STRIDE` record per solved manifold, written from index 0. Returns the
   * total record count; when that exceeds the buffer's capacity only the first records were
   * written, and the caller must grow the buffer and read again before the next step. A sleeping
   * body was not solved and reports nothing. Optional: a backend with no narrow-phase access
   * omits it, and a caller that needs contacts must fail closed instead of assuming support.
   */
  readContacts?(
    target: IPhysicsColliderHandle,
    colliders: Uint32Array,
    buffer: Float32Array,
  ): number;
  /**
   * Replace a collider's shape in place, keeping its handle, owning body, filters and scene
   * cleanup. Recreating a collider instead leaves every recorded identity stale. Bodies sleeping
   * on the old shape must wake, since the new one may no longer support them.
   */
  setColliderShape?(collider: IPhysicsColliderHandle, shape: IPhysicsShapeDescriptor): void;
  /**
   * Attach ray-cast wheels to a dynamic chassis. A vehicle lives and dies with its body, so
   * `removeBody()` releases its controller; there is no separate vehicle removal call.
   *
   * Optional because a backend that cannot honour it must fail loudly at construction rather than
   * simulate a car that is not there. `VehicleBody3D` throws `TN_VEHICLE_NATIVE_UNAVAILABLE` when
   * these are absent.
   */
  createVehicle?(options: IPhysicsVehicleCreateOptions): number;
  setVehicleInput?(id: number, input: IPhysicsVehicleInput): void;
  readVehicleState?(id: number): IPhysicsVehicleState | undefined;
  /** Cold-path respawn: move the chassis, drop both velocities, and face the given yaw in radians. */
  resetVehicle?(id: number, position: IPhysicsVector3, yaw: number): void;
  drainCollisionEvents(buffer: Uint32Array): number;
  dispose(): void;
}

/**
 * A NaN reaching Rapier corrupts the body's state for the rest of the run rather than throwing,
 * and the symptom surfaces frames later as a body that vanished. Reject it at the seam.
 */
export function requireFiniteVector(vector: IPhysicsVector3, label: string): void {
  if (
    typeof vector?.x !== "number" ||
    typeof vector.y !== "number" ||
    typeof vector.z !== "number" ||
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  )
    throw new Error(`TN_PHYSICS_NON_FINITE: ${label} must be a finite { x, y, z }.`);
}

export function requireFiniteRotation(rotation: IPhysicsRotation, label: string): void {
  if (
    typeof rotation?.x !== "number" ||
    typeof rotation.y !== "number" ||
    typeof rotation.z !== "number" ||
    typeof rotation.w !== "number" ||
    !Number.isFinite(rotation.x) ||
    !Number.isFinite(rotation.y) ||
    !Number.isFinite(rotation.z) ||
    !Number.isFinite(rotation.w)
  )
    throw new Error(`TN_PHYSICS_NON_FINITE: ${label} must be a finite { x, y, z, w }.`);
  if (f32LengthSquared([rotation.x, rotation.y, rotation.z, rotation.w]) <= F32_EPSILON)
    throw new Error(`TN_PHYSICS_INVALID: ${label} must not have zero length.`);
}

export function requirePhysicsJointCreateOptions(
  options: IPhysicsJointCreateOptions,
): IPhysicsJointCreateOptions {
  if (typeof options !== "object" || options === null)
    throw new Error("IPhysicsSimulation joint options must be an object.");
  if (options.type !== "pin" && options.type !== "hinge" && options.type !== "fixed")
    throw new Error("IPhysicsSimulation joint options have an unknown type.");
  if (
    !Number.isSafeInteger(options.bodyA) ||
    options.bodyA < 0 ||
    !Number.isSafeInteger(options.bodyB) ||
    options.bodyB < 0 ||
    options.bodyA === options.bodyB
  )
    throw new Error("IPhysicsSimulation joint options must reference two distinct body ids.");
  requireFiniteVector(options.anchorA, "joint anchorA");
  requireFiniteVector(options.anchorB, "joint anchorB");
  if (options.type === "hinge") {
    if (options.axis === undefined) throw new Error("IPhysicsSimulation hinge requires an axis.");
    requireFiniteVector(options.axis, "joint axis");
    if (f32LengthSquared([options.axis.x, options.axis.y, options.axis.z]) <= F32_EPSILON_SQUARED)
      throw new Error("IPhysicsSimulation hinge axis must not have zero length.");
    if (options.limit !== undefined) {
      if (typeof options.limit !== "object" || options.limit === null)
        throw new Error("IPhysicsSimulation hinge limit must contain ordered finite bounds.");
      if (
        !Number.isFinite(options.limit.lower) ||
        !Number.isFinite(options.limit.upper) ||
        options.limit.lower > options.limit.upper
      )
        throw new Error("IPhysicsSimulation hinge limit must contain ordered finite bounds.");
    }
  } else if (options.axis !== undefined || options.limit !== undefined) {
    throw new Error("IPhysicsSimulation joint limits and axes are only valid for a hinge.");
  }
  if (options.type !== "fixed" && (options.frameA !== undefined || options.frameB !== undefined))
    throw new Error("IPhysicsSimulation joint frames are only valid for a fixed joint.");
  if (options.frameA !== undefined) requireFiniteRotation(options.frameA, "joint frameA");
  if (options.frameB !== undefined) requireFiniteRotation(options.frameB, "joint frameB");
  return options;
}

function requireVehicleNumber(value: unknown, label: string, positive: boolean): void {
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0))
    throw new Error(
      `TN_VEHICLE_INVALID: ${label} must be a finite ${positive ? "positive" : "non-negative"} number.`,
    );
}

/**
 * Wheels that reach Rapier as zeroes divide the suspension term, and a vehicle with none has
 * nothing to stand on, so both are rejected at the seam every backend shares.
 */
export function requirePhysicsVehicleCreateOptions(
  options: IPhysicsVehicleCreateOptions,
): IPhysicsVehicleCreateOptions {
  if (typeof options !== "object" || options === null)
    throw new Error("IPhysicsSimulation vehicle options must be an object.");
  if (options.forwardAxis !== 0 && options.forwardAxis !== 2)
    throw new Error("TN_VEHICLE_INVALID: forwardAxis must be 0 (x) or 2 (z).");
  requireFiniteVector(options.axle, "vehicle axle");
  if (!Array.isArray(options.wheels) || options.wheels.length < 1)
    throw new Error("TN_VEHICLE_INVALID: a vehicle needs at least one wheel.");
  for (const [index, wheel] of options.wheels.entries()) {
    requireFiniteVector(wheel.position, `vehicle wheel ${index} position`);
    requireVehicleNumber(wheel.wheelRadius, `wheel ${index} wheelRadius`, true);
    requireVehicleNumber(wheel.suspensionRestLength, `wheel ${index} suspensionRestLength`, true);
    requireVehicleNumber(wheel.suspensionStiffness, `wheel ${index} suspensionStiffness`, false);
    requireVehicleNumber(wheel.dampingCompression, `wheel ${index} dampingCompression`, false);
    requireVehicleNumber(wheel.dampingRelaxation, `wheel ${index} dampingRelaxation`, false);
    requireVehicleNumber(wheel.wheelFrictionSlip, `wheel ${index} wheelFrictionSlip`, false);
    if (wheel.maxSuspensionTravel !== undefined)
      requireVehicleNumber(wheel.maxSuspensionTravel, `wheel ${index} maxSuspensionTravel`, false);
  }
  return options;
}

/** Runtime metadata needed to expose backend-specific escape hatches without leaking them. */
export interface IPhysicsRuntimeSimulation extends IPhysicsSimulation {
  readonly version: string;
  readonly rawWorld: unknown;
  readonly rawEventQueue: unknown;
}

export interface IPhysicsSimulationBackend {
  initialize(): Promise<void>;
  createSimulation(options?: {
    readonly gravity?: { readonly x: number; readonly y: number; readonly z: number };
  }): IPhysicsRuntimeSimulation;
  createShape?(shape: IPhysicsShapeDescriptor): unknown;
  simulationForWorld?(world: unknown): IPhysicsSimulation;
}

let selectedBackend: IPhysicsSimulationBackend | undefined;

export function installPhysicsSimulationBackend(backend: IPhysicsSimulationBackend): void {
  selectedBackend = backend;
}

export function physicsSimulationBackend(): IPhysicsSimulationBackend {
  if (selectedBackend === undefined)
    throw new Error("TN_PHYSICS_BACKEND_MISSING: no IPhysicsSimulation backend was selected");
  return selectedBackend;
}

interface ISimulationBody {
  readonly id: number;
  readonly body: rapier.RigidBody;
  readonly bodyHandle: IPhysicsBodyHandle;
  readonly collider: rapier.Collider;
  readonly characterState: IStoredCharacterState;
  readonly entity?: string;
  readonly type: PhysicsBodyType;
  controller?: rapier.KinematicCharacterController;
  controllerHandle?: IPhysicsHandle;
  character?: IPhysicsCharacterOptions;
  groundCollider?: number;
}

interface IStoredCharacterState {
  grounded: boolean;
  groundBody?: IPhysicsBodyHandle;
  groundCollider?: number;
  readonly groundNormal: { x: number; y: number; z: number };
}

interface IVehicleRecord {
  readonly bodyId: number;
  readonly body: rapier.RigidBody;
  readonly controller: rapier.DynamicRayCastVehicleController;
  readonly state: IPhysicsVehicleState;
  readonly wheels: Float32Array;
  /** Index of the wheels that take engine force and the ones that steer. */
  readonly traction: number[];
  readonly steering: number[];
  readonly restLengths: number[];
  /**
   * The chassis' own collision groups, so a wheel ray misses whatever the chassis is masked
   * against. A JS filter predicate is not an option: Rapier holds the collider set borrowed while
   * it calls back into JS, and touching a collider from there is a WASM ownership fault.
   */
  readonly rayGroups: number;
  /** Which way along its forward axis the engine force drives; see `vehicleSpeed`. */
  readonly direction: 1 | -1;
  readonly forwardAxis: 0 | 2;
}

interface IWebPhysicsSimulationOptions {
  readonly rapier: typeof rapier;
  readonly world: rapier.World;
  readonly eventQueue: rapier.EventQueue;
  readonly version: string;
}

export function requirePhysicsStepInput(
  deltaTime: number,
  inputSnapshot: IPhysicsInputSnapshot | undefined,
  bodyExists: (id: number) => boolean,
): void {
  if (!Number.isFinite(deltaTime) || deltaTime <= 0)
    throw new Error("IPhysicsSimulation.step requires a positive finite deltaTime.");
  if (inputSnapshot === undefined) return;
  if (!(inputSnapshot.kinematicTransforms instanceof Float32Array))
    throw new Error("IPhysicsSimulation input must use a Float32Array.");
  if (
    !Number.isSafeInteger(inputSnapshot.kinematicCount) ||
    inputSnapshot.kinematicCount < 0 ||
    inputSnapshot.kinematicCount >
      Math.floor(inputSnapshot.kinematicTransforms.length / PHYSICS_TRANSFORM_STRIDE)
  ) {
    throw new Error("IPhysicsSimulation input has an invalid kinematic record count.");
  }
  for (let index = 0; index < inputSnapshot.kinematicCount; index += 1) {
    const offset = index * PHYSICS_TRANSFORM_STRIDE;
    for (let scalar = 0; scalar < PHYSICS_TRANSFORM_STRIDE; scalar += 1) {
      if (!Number.isFinite(inputSnapshot.kinematicTransforms[offset + scalar]))
        throw new Error("IPhysicsSimulation input contains a non-finite transform.");
    }
    const id = inputSnapshot.kinematicTransforms[offset] as number;
    if (!Number.isInteger(id) || id < 0)
      throw new Error("IPhysicsSimulation input contains an invalid body id.");
    if (!bodyExists(id)) throw new Error("IPhysicsSimulation input contains an unknown body id.");
  }
}

export function requirePhysicsRenderBuffer(renderBuffer: Float32Array, bodyCount: number): void {
  if (!(renderBuffer instanceof Float32Array))
    throw new Error("IPhysicsSimulation output must use a Float32Array.");
  if (renderBuffer.length < bodyCount * PHYSICS_TRANSFORM_STRIDE)
    throw new Error("IPhysicsSimulation output buffer is too small for visible transforms.");
}

export function requirePhysicsSleepStateBuffer(buffer: Float32Array, bodyCount: number): void {
  if (!(buffer instanceof Float32Array))
    throw new Error("IPhysicsSimulation sleep states must use a Float32Array.");
  if (buffer.length < bodyCount * PHYSICS_SLEEP_STATE_STRIDE)
    throw new Error("IPhysicsSimulation sleep state buffer is too small.");
}

export function requirePhysicsEventBuffer(buffer: Uint32Array): void {
  if (!(buffer instanceof Uint32Array))
    throw new Error("IPhysicsSimulation events must use a Uint32Array.");
}

export function requirePhysicsBodySensor(
  options: Pick<IPhysicsBodyCreateOptions, "sensor" | "shape">,
): boolean {
  if (options.sensor !== options.shape.sensor)
    throw new Error(
      `TN_PHYSICS_SENSOR_CONFLICT: options.sensor (${options.sensor}) must match shape.sensor (${options.shape.sensor}).`,
    );
  return options.sensor;
}

// Reused across kinematic input records in `step`: per-body-per-step object literals here were
// pure garbage handed to the collector at frame rate. Rapier reads each of them synchronously
// within the same call that receives it.
const kinematicScratch = {
  target: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  desired: { x: 0, y: 0, z: 0 },
  nextTranslation: { x: 0, y: 0, z: 0 },
};
// One closure instead of one per character per step; the layers it tests are set right before
// computeColliderMovement, which consumes it synchronously.
let oneWayFilterLayers = 0;
const oneWayFilterPredicate = (collider: rapier.Collider): boolean =>
  ((collider.collisionGroups() >>> 16) & oneWayFilterLayers) === 0;

const QUERY_SHAPE_KINDS = new Set<PhysicsShapeKind>([
  "box",
  "sphere",
  "capsule",
  "trimesh",
  "convexHull",
  "heightfield",
]);

function queryObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null)
    throw new Error(`IPhysicsSimulation ${label} must be an object.`);
  return value as Record<string, unknown>;
}

function queryVector(value: unknown, label: string): IPhysicsVector3 {
  const object = queryObject(value, `${label} vector`);
  const x = object.x;
  const y = object.y;
  const z = object.z;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  )
    throw new Error(`IPhysicsSimulation ${label} vector must contain finite x, y, and z values.`);
  return { x, y, z };
}

function queryRotation(value: unknown): IPhysicsRotation {
  const object = queryObject(value, "shape rotation");
  const x = object.x;
  const y = object.y;
  const z = object.z;
  const w = object.w;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    typeof w !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z) ||
    !Number.isFinite(w)
  )
    throw new Error("IPhysicsSimulation shape rotation must contain finite x, y, z, and w values.");
  const lengthSquared = x * x + y * y + z * z + w * w;
  if (lengthSquared <= Number.EPSILON)
    throw new Error("IPhysicsSimulation shape rotation must not have zero length.");
  return { w, x, y, z };
}

export function requirePhysicsCollisionMask(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 0xffff)
    throw new Error("IPhysicsSimulation collisionMask must be an integer from 0 through 65535.");
  return value;
}

export function requirePhysicsMaxResults(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_PHYSICS_QUERY_RESULTS
  )
    throw new Error(
      `IPhysicsSimulation maxResults must be an integer from 1 through ${MAX_PHYSICS_QUERY_RESULTS}.`,
    );
  return value;
}

function queryShape(value: unknown): IPhysicsShapeDescriptor {
  const shape = queryObject(value, "query shape");
  const kind = shape.kind;
  if (typeof kind !== "string" || !QUERY_SHAPE_KINDS.has(kind as PhysicsShapeKind))
    throw new Error("IPhysicsSimulation query shape has an unknown kind.");
  const x = shape.x;
  const y = shape.y;
  const z = shape.z;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof z !== "number" ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(z)
  )
    throw new Error("IPhysicsSimulation query shape dimensions must be finite.");
  if (kind === "box" && (x <= 0 || y <= 0 || z <= 0))
    throw new Error("IPhysicsSimulation query box dimensions must be positive.");
  if (kind === "sphere" && x <= 0)
    throw new Error("IPhysicsSimulation query sphere radius must be positive.");
  if (kind === "capsule" && (x < 0 || y <= 0))
    throw new Error("IPhysicsSimulation query capsule dimensions are invalid.");
  return shape as unknown as IPhysicsShapeDescriptor;
}

export function requirePhysicsRayQuery(value: unknown): IPhysicsRayQuery {
  const query = queryObject(value, "ray query");
  const from = queryVector(query.from, "ray from");
  const to = queryVector(query.to, "ray to");
  if (from.x === to.x && from.y === to.y && from.z === to.z)
    throw new Error("IPhysicsSimulation ray must have non-zero length.");
  return {
    collisionMask: requirePhysicsCollisionMask(query.collisionMask),
    from,
    to,
  };
}

export function requirePhysicsShapeQuery(value: unknown): IPhysicsShapeQuery {
  const query = queryObject(value, "shape query");
  return {
    collisionMask: requirePhysicsCollisionMask(query.collisionMask),
    maxResults: requirePhysicsMaxResults(query.maxResults),
    position: queryVector(query.position, "shape position"),
    rotation: queryRotation(query.rotation),
    shape: queryShape(query.shape),
  };
}

export function requirePhysicsPointQuery(value: unknown): IPhysicsPointQuery {
  const query = queryObject(value, "point query");
  return {
    collisionMask: requirePhysicsCollisionMask(query.collisionMask),
    maxResults: requirePhysicsMaxResults(query.maxResults),
    position: queryVector(query.position, "point position"),
  };
}

export function createWebPhysicsShape(
  rapier: typeof import("@dimforge/rapier3d-compat"),
  shape: IPhysicsShapeDescriptor,
  sensor = shape.sensor,
): rapier.ColliderDesc {
  let descriptor: rapier.ColliderDesc | null;
  if (shape.kind === "box") descriptor = rapier.ColliderDesc.cuboid(shape.x, shape.y, shape.z);
  else if (shape.kind === "sphere") descriptor = rapier.ColliderDesc.ball(shape.x);
  else if (shape.kind === "capsule") descriptor = rapier.ColliderDesc.capsule(shape.x, shape.y);
  else if (shape.kind === "trimesh") {
    if (shape.vertices === undefined || shape.indices === undefined)
      throw new Error("CollisionShape3D.trimesh is missing mesh data.");
    descriptor = rapier.ColliderDesc.trimesh(
      shape.vertices,
      shape.indices,
      rapier.TriMeshFlags.FIX_INTERNAL_EDGES,
    );
  } else if (shape.kind === "convexHull") {
    if (shape.vertices === undefined)
      throw new Error("CollisionShape3D.convexHull is missing vertices.");
    descriptor = rapier.ColliderDesc.convexHull(shape.vertices);
    if (descriptor === null) throw new Error("CollisionShape3D could not build a convex hull.");
  } else {
    if (
      shape.rows === undefined ||
      shape.columns === undefined ||
      shape.heights === undefined ||
      shape.scale === undefined
    )
      throw new Error("CollisionShape3D.heightfield is missing height data.");
    descriptor = rapier.ColliderDesc.heightfield(
      shape.rows - 1,
      shape.columns - 1,
      shape.heights,
      shape.scale,
      rapier.HeightFieldFlags.FIX_INTERNAL_EDGES,
    );
  }
  descriptor.setCollisionGroups(interactionGroups(shape.collisionLayer, shape.collisionMask));
  descriptor.setSensor(sensor);
  descriptor.setActiveEvents(rapier.ActiveEvents.COLLISION_EVENTS);
  return descriptor;
}

function bodyDescription(
  rapier: typeof import("@dimforge/rapier3d-compat"),
  type: PhysicsBodyType,
  position: IPhysicsBodyCreateOptions["position"],
  rotation: IPhysicsBodyCreateOptions["rotation"],
  continuousCollision: boolean,
): rapier.RigidBodyDesc {
  const description =
    type === "fixed"
      ? rapier.RigidBodyDesc.fixed()
      : type === "kinematic" || type === "character"
        ? rapier.RigidBodyDesc.kinematicPositionBased()
        : rapier.RigidBodyDesc.dynamic();
  description
    .setTranslation(position.x, position.y, position.z)
    .setRotation({ x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w });
  // Rapier applies CCD to kinematic position targets as a sweep. Kinematic bodies are driven
  // transforms (including teleports), so enabling it there changes the existing bulk-transform
  // contract; CCD is meaningful for the dynamic bodies this option targets.
  if (type === "dynamic") description.setCcdEnabled(continuousCollision);
  return description;
}

function jointDescription(
  rapier: typeof import("@dimforge/rapier3d-compat"),
  jointOptions: IPhysicsJointCreateOptions,
): rapier.JointData {
  if (jointOptions.type === "pin")
    return rapier.JointData.spherical(jointOptions.anchorA, jointOptions.anchorB);
  if (jointOptions.type === "hinge") {
    return rapier.JointData.revolute(
      jointOptions.anchorA,
      jointOptions.anchorB,
      jointOptions.axis as IPhysicsVector3,
    );
  }
  return rapier.JointData.fixed(
    jointOptions.anchorA,
    jointOptions.frameA ?? { x: 0, y: 0, z: 0, w: 1 },
    jointOptions.anchorB,
    jointOptions.frameB ?? { x: 0, y: 0, z: 0, w: 1 },
  );
}

function characterState(
  simulationBody: ISimulationBody,
  byCollider: ReadonlyMap<number, ISimulationBody>,
): IPhysicsCharacterState {
  const state = simulationBody.characterState;
  const controller = simulationBody.controller;
  if (controller === undefined) return state;
  let groundCollider: number | undefined;
  let groundBody: IPhysicsBodyHandle | undefined;
  let groundNormal: IPhysicsVector3 | undefined;
  // Rapier flags a contact as ground at any positive up component, so a wall that leans back a
  // degree reads as floor. When the only contacts are such walls, the character is not grounded;
  // a snap-to-ground step records no contact, so no contacts leaves Rapier's answer alone.
  let walkable = false;
  let contacts = 0;
  for (let index = 0; index < controller.numComputedCollisions(); index += 1) {
    const collision = controller.computedCollision(index);
    if (collision?.collider === null || collision?.collider === undefined) continue;
    contacts += 1;
    if ((collision.normal1.y ?? Number.NEGATIVE_INFINITY) >= 0.5) {
      walkable = true;
      const contacted = byCollider.get(collision.collider.handle);
      if (contacted !== undefined) {
        groundCollider = contacted.id;
        groundBody = contacted.bodyHandle;
        groundNormal = collision.normal1;
        break;
      }
    }
  }
  const grounded = controller.computedGrounded() && (walkable || contacts === 0);
  if (groundCollider !== undefined) simulationBody.groundCollider = groundCollider;
  else if (!grounded) simulationBody.groundCollider = undefined;
  state.grounded = grounded;
  state.groundCollider = simulationBody.groundCollider;
  if (groundBody !== undefined) state.groundBody = groundBody;
  else if (!grounded) state.groundBody = undefined;
  if (groundNormal !== undefined) {
    state.groundNormal.x = groundNormal.x;
    state.groundNormal.y = groundNormal.y;
    state.groundNormal.z = groundNormal.z;
  } else if (!grounded) {
    state.groundNormal.x = 0;
    state.groundNormal.y = 1;
    state.groundNormal.z = 0;
  }
  return state;
}

/**
 * Signed metres per second along the vehicle's own forward axis.
 *
 * Rapier's `currentVehicleSpeed()` is not this: it follows the positive forward axis regardless of
 * which way the car drives, and on a settled car it reports the suspension's residual vertical
 * velocity — a parked car reading 0.5 m/s. Rotating the chassis velocity into the chassis frame
 * and taking the forward component is the number the contract names, on both backends.
 */
function vehicleSpeed(entry: ISimulationBody, forwardAxis: 0 | 2, sign: 1 | -1): number {
  const rotation = entry.body.rotation();
  const velocity = entry.body.linvel();
  // Rotating by the conjugate of the chassis rotation is its inverse.
  const cx = -rotation.x;
  const cy = -rotation.y;
  const cz = -rotation.z;
  const tx = 2 * (cy * velocity.z - cz * velocity.y);
  const ty = 2 * (cz * velocity.x - cx * velocity.z);
  const tz = 2 * (cx * velocity.y - cy * velocity.x);
  const w = rotation.w;
  const localX = velocity.x + w * tx + (cy * tz - cz * ty);
  const localZ = velocity.z + w * tz + (cx * ty - cy * tx);
  return (forwardAxis === 2 ? localZ : localX) * sign;
}

/**
 * Rapier compat 0.19.3 exposes no out-parameter for rigid-body transforms. Keep its two
 * short-lived wrapper records behind this adapter and write their values directly to the shared
 * typed record; reaching through Rapier's private raw set would be an unstable API seam.
 */
function writeRapierTransformRecord(
  entry: ISimulationBody,
  renderBuffer: Float32Array,
  offset: number,
): void {
  const translation = entry.body.translation();
  const rotation = entry.body.rotation();
  renderBuffer[offset] = entry.id;
  renderBuffer[offset + 1] = translation.x;
  renderBuffer[offset + 2] = translation.y;
  renderBuffer[offset + 3] = translation.z;
  renderBuffer[offset + 4] = rotation.x;
  renderBuffer[offset + 5] = rotation.y;
  renderBuffer[offset + 6] = rotation.z;
  renderBuffer[offset + 7] = rotation.w;
}

/** One `PHYSICS_CONTACT_STRIDE` record summarising a solved manifold. */
function writeContactRecord(
  buffer: Float32Array,
  record: number,
  colliderId: number,
  manifold: rapier.TempContactManifold,
  flipped: boolean,
): void {
  const solved = manifold.numSolverContacts();
  let impulse = 0;
  for (let point = 0; point < manifold.numContacts(); point += 1)
    impulse += manifold.contactImpulse(point);
  let x = 0;
  let y = 0;
  let z = 0;
  for (let point = 0; point < solved; point += 1) {
    const world = manifold.solverContactPoint(point);
    x += world.x;
    y += world.y;
    z += world.z;
  }
  const normal = manifold.normal();
  const sign = flipped ? -1 : 1;
  const offset = record * PHYSICS_CONTACT_STRIDE;
  buffer[offset] = colliderId;
  buffer[offset + 1] = x / solved;
  buffer[offset + 2] = y / solved;
  buffer[offset + 3] = z / solved;
  buffer[offset + 4] = normal.x * sign;
  buffer[offset + 5] = normal.y * sign;
  buffer[offset + 6] = normal.z * sign;
  buffer[offset + 7] = impulse;
}

/** Web adapter. It is the only implementation that names Rapier's JS objects. */
export function createWebPhysicsSimulation(
  options: IWebPhysicsSimulationOptions,
): IPhysicsRuntimeSimulation {
  const bodies = new Map<number, ISimulationBody>();
  const byCollider = new Map<number, ISimulationBody>();
  const joints = new Map<
    number,
    { readonly handle: number; readonly bodyA: number; readonly bodyB: number }
  >();
  const dirtyBodies = new Set<ISimulationBody>();
  const areaIntersections = new Map<number, Set<number>>();
  const emptyAreaIntersections = new Set<number>();
  let areaIntersectionId = -1;
  let areaIntersectionMask = 0;
  let areaIntersectionMembers: Set<number> | undefined;
  const areaIntersectionCallback = (collider: rapier.Collider): boolean => {
    const members = areaIntersectionMembers;
    if (members === undefined) return true;
    const body = byCollider.get(collider.handle);
    if (
      body !== undefined &&
      body.id !== areaIntersectionId &&
      !collider.isSensor() &&
      ((collider.collisionGroups() >>> 16) & areaIntersectionMask) !== 0
    )
      members.add(body.id);
    return true;
  };
  // Flat stride-4 records instead of one array per event: contact-heavy scenes
  // drained hundreds of short-lived tuples per step into the collector.
  const pendingCollisionEvents: number[] = [];
  const vehicles = new Map<number, IVehicleRecord>();
  let nextId = 0;
  let nextJointId = 0;
  let nextVehicleId = 0;
  let disposed = false;

  const requireLive = () => {
    if (disposed) throw new Error("Physics simulation is disposed.");
  };

  // Actuation on a fixed, kinematic or character body is not a weaker push, it is no push at
  // all -- Rapier discards it. Failing here beats a silently motionless body.
  const requireDynamic = (
    entry: ISimulationBody | undefined,
    id: number,
    operation: string,
  ): ISimulationBody => {
    if (entry === undefined)
      throw new Error(`TN_PHYSICS_UNKNOWN_BODY: ${operation} references an unknown body ${id}.`);
    if (entry.type !== "dynamic")
      throw new Error(
        `TN_PHYSICS_NOT_DYNAMIC: ${operation} needs a dynamic body; body ${id} is '${entry.type}'.`,
      );
    return entry;
  };

  const queryPredicate =
    (collisionMask: number) =>
    (collider: rapier.Collider): boolean => {
      const body = byCollider.get(collider.handle);
      return (
        body !== undefined &&
        !dirtyBodies.has(body) &&
        !collider.isSensor() &&
        ((collider.collisionGroups() >>> 16) & collisionMask) !== 0
      );
    };

  const queryMatches = (collisionMask: number, collider: rapier.Collider): boolean => {
    const body = byCollider.get(collider.handle);
    return (
      body !== undefined &&
      !collider.isSensor() &&
      ((collider.collisionGroups() >>> 16) & collisionMask) !== 0
    );
  };

  const queryHit = (entry: ISimulationBody): IPhysicsQueryHit => {
    const position = entry.body.translation();
    return {
      body: physicsBodyHandle(entry.id, entry.body, entry.entity),
      entity: entry.entity,
      position: { x: position.x, y: position.y, z: position.z },
    };
  };

  const removeJointRecord = (id: number): void => {
    const record = joints.get(id);
    if (record === undefined) return;
    joints.delete(id);
    const joint = options.world.impulseJoints.get(record.handle);
    if (joint !== null) options.world.removeImpulseJoint(joint, true);
  };

  const removeVehicleRecord = (id: number): void => {
    const record = vehicles.get(id);
    if (record === undefined) return;
    vehicles.delete(id);
    // Before the chassis goes: the controller holds a raw handle to that body.
    options.world.removeVehicleController(record.controller);
  };

  const requireVehicle = (id: number, operation: string): IVehicleRecord => {
    const record = vehicles.get(id);
    if (record === undefined)
      throw new Error(`TN_VEHICLE_UNKNOWN: ${operation} references an unknown vehicle ${id}.`);
    return record;
  };

  const simulation: IPhysicsRuntimeSimulation = {
    version: options.version,
    rawWorld: options.world,
    rawEventQueue: options.eventQueue,
    createBody: (bodyOptions) => {
      requireLive();
      const sensor = requirePhysicsBodySensor(bodyOptions);
      if (!Number.isFinite(bodyOptions.mass) || bodyOptions.mass < 0)
        throw new Error("Physics body mass must be a finite non-negative number.");
      if (
        bodyOptions.continuousCollision !== undefined &&
        typeof bodyOptions.continuousCollision !== "boolean"
      )
        throw new Error("Physics body continuousCollision must be a boolean.");
      // A NaN reaching Rapier corrupts the body for the rest of the run and surfaces
      // frames later as a body that vanished; reject it here like every other seam.
      requireFiniteVector(bodyOptions.position, "body position");
      requireFiniteRotation(bodyOptions.rotation, "body rotation");
      const id = nextId;
      nextId += 1;
      const rawShape = createWebPhysicsShape(options.rapier, bodyOptions.shape, sensor);
      // Explicit mass is the body's total mass. Adding it to the collider's density-derived
      // mass made `mass: 2` weigh 10 kg on a 2 m cube, while the public field still said 2.
      if (bodyOptions.mass > 0) rawShape.setMass(bodyOptions.mass);
      const rawBody = options.world.createRigidBody(
        bodyDescription(
          options.rapier,
          bodyOptions.type,
          bodyOptions.position,
          bodyOptions.rotation,
          effectiveContinuousCollision(bodyOptions.type, bodyOptions.continuousCollision),
        ),
      );
      const rawCollider = options.world.createCollider(rawShape, rawBody);
      const bodyHandle = physicsBodyHandle(id, rawBody, bodyOptions.entity);
      const entry: ISimulationBody = {
        body: rawBody,
        bodyHandle,
        characterState: { grounded: false, groundNormal: { x: 0, y: 1, z: 0 } },
        collider: rawCollider,
        entity: bodyOptions.entity,
        id,
        type: bodyOptions.type,
      };
      if (bodyOptions.type === "character") {
        entry.controller = options.world.createCharacterController(0.01);
        entry.controllerHandle = physicsHandle(entry.controller);
      }
      bodies.set(id, entry);
      byCollider.set(rawCollider.handle, entry);
      if (bodyOptions.sensor) areaIntersections.set(id, new Set());
      dirtyBodies.add(entry);
      return {
        body: bodyHandle,
        collider: physicsColliderHandle(id, rawCollider),
        controller: entry.controllerHandle,
        rawShape,
      };
    },
    createJoint: (jointOptions) => {
      requireLive();
      const normalized = requirePhysicsJointCreateOptions(jointOptions);
      const bodyA = bodies.get(normalized.bodyA);
      const bodyB = bodies.get(normalized.bodyB);
      if (bodyA === undefined || bodyB === undefined)
        throw new Error("TN_PHYSICS_UNKNOWN_BODY: joint references an unknown body.");
      if (!bodyA.body.isValid() || !bodyB.body.isValid())
        throw new Error("TN_PHYSICS_INVALID_BODY: joint references an invalid body.");
      const joint = options.world.createImpulseJoint(
        jointDescription(options.rapier, normalized),
        bodyA.body,
        bodyB.body,
        true,
      );
      if (normalized.limit !== undefined) {
        const revoluteJoint = joint as rapier.UnitImpulseJoint;
        if (typeof revoluteJoint.setLimits !== "function") {
          options.world.removeImpulseJoint(joint, true);
          throw new Error(
            "TN_PHYSICS_JOINT_LIMIT_UNSUPPORTED: web backend cannot set hinge limits.",
          );
        }
        revoluteJoint.setLimits(normalized.limit.lower, normalized.limit.upper);
      }
      const id = nextJointId;
      nextJointId += 1;
      joints.set(id, { bodyA: normalized.bodyA, bodyB: normalized.bodyB, handle: joint.handle });
      return id;
    },
    configureCharacter: (id, characterOptions) => {
      requireLive();
      const entry = bodies.get(id);
      if (entry?.controller === undefined)
        throw new Error("Physics character configuration references a non-character body.");
      if (characterOptions.offset !== 0.01) {
        options.world.removeCharacterController(entry.controller);
        entry.controller = options.world.createCharacterController(characterOptions.offset);
        if (entry.controllerHandle !== undefined)
          (entry.controllerHandle as { raw: unknown }).raw = entry.controller;
      }
      entry.character = characterOptions;
      entry.controller.setMaxSlopeClimbAngle(characterOptions.maxSlopeClimbAngle);
      if (characterOptions.autostep !== undefined) {
        entry.controller.enableAutostep(
          characterOptions.autostep.maxHeight,
          characterOptions.autostep.minWidth,
          characterOptions.autostep.includeDynamicBodies,
        );
      }
      if (characterOptions.snapToGround !== undefined)
        entry.controller.enableSnapToGround(characterOptions.snapToGround);
      // Off by default in Rapier, so a character collides with crates without ever moving them.
      entry.controller.setApplyImpulsesToDynamicBodies(
        characterOptions.pushesDynamicBodies === true,
      );
    },
    removeBody: (id) => {
      requireLive();
      const entry = bodies.get(id);
      if (entry === undefined) return;
      for (const [jointId, joint] of joints) {
        if (joint.bodyA === id || joint.bodyB === id) removeJointRecord(jointId);
      }
      for (const [vehicleId, vehicle] of vehicles) {
        if (vehicle.bodyId === id) removeVehicleRecord(vehicleId);
      }
      bodies.delete(id);
      byCollider.delete(entry.collider.handle);
      areaIntersections.delete(id);
      dirtyBodies.delete(entry);
      if (entry.controller !== undefined) options.world.removeCharacterController(entry.controller);
      if (entry.body.isValid()) options.world.removeRigidBody(entry.body);
    },
    removeJoint: (id) => {
      if (disposed) return;
      removeJointRecord(id);
    },
    setBodyTransform: (id, position) => {
      requireLive();
      const entry = bodies.get(id);
      if (entry === undefined)
        throw new Error("Physics body transform references an unknown body.");
      entry.body.setTranslation(position, true);
      options.world.propagateModifiedBodyPositionsToColliders();
      dirtyBodies.add(entry);
    },
    applyBodyImpulse: (id, impulse) => {
      requireLive();
      requireFiniteVector(impulse, "impulse");
      // wakeUp: an impulse applied to a sleeping body is otherwise silently discarded, which is
      // the same class of no-op as a discarded transform write.
      requireDynamic(bodies.get(id), id, "applyImpulse").body.applyImpulse(impulse, true);
    },
    applyBodyForce: (id, force) => {
      requireLive();
      requireFiniteVector(force, "force");
      requireDynamic(bodies.get(id), id, "applyForce").body.addForce(force, true);
    },
    applyBodyForceAtPoint: (id, force, point) => {
      requireLive();
      requireFiniteVector(force, "force");
      requireFiniteVector(point, "force point");
      requireDynamic(bodies.get(id), id, "applyForceAtPoint").body.addForceAtPoint(
        force,
        point,
        true,
      );
    },
    setBodyLinearVelocity: (id, velocity) => {
      requireLive();
      requireFiniteVector(velocity, "velocity");
      requireDynamic(bodies.get(id), id, "linearVelocity").body.setLinvel(velocity, true);
    },
    readBodyLinearVelocity: (id) => {
      requireLive();
      const { x, y, z } = requireDynamic(bodies.get(id), id, "linearVelocity").body.linvel();
      return { x, y, z };
    },
    step: (deltaTime, inputSnapshot) => {
      requireLive();
      requirePhysicsStepInput(deltaTime, inputSnapshot, (id) => bodies.has(id));
      if (inputSnapshot !== undefined) {
        for (let index = 0; index < inputSnapshot.kinematicCount; index += 1) {
          const offset = index * PHYSICS_TRANSFORM_STRIDE;
          const id = inputSnapshot.kinematicTransforms[offset] as number;
          const entry = bodies.get(id);
          if (entry === undefined) throw new Error("IPhysicsSimulation input body disappeared.");
          const { target, rotation } = kinematicScratch;
          target.x = inputSnapshot.kinematicTransforms[offset + 1] as number;
          target.y = inputSnapshot.kinematicTransforms[offset + 2] as number;
          target.z = inputSnapshot.kinematicTransforms[offset + 3] as number;
          rotation.x = inputSnapshot.kinematicTransforms[offset + 4] as number;
          rotation.y = inputSnapshot.kinematicTransforms[offset + 5] as number;
          rotation.z = inputSnapshot.kinematicTransforms[offset + 6] as number;
          rotation.w = inputSnapshot.kinematicTransforms[offset + 7] as number;
          if (entry.type === "character") {
            const controller = entry.controller;
            const config = entry.character;
            if (controller === undefined || config === undefined)
              throw new Error("Physics character was not configured before stepping.");
            const current = entry.body.translation();
            const desired = kinematicScratch.desired;
            desired.x = target.x - current.x;
            desired.y = target.y - current.y;
            desired.z = target.z - current.z;
            const characterGroups = entry.collider.collisionGroups();
            const oneWayActive = config.oneWayLayers !== 0 && desired.y > 0;
            const filterGroups = oneWayActive
              ? interactionGroups(
                  characterGroups >>> 16,
                  characterGroups & 0xffff & (0xffff ^ config.oneWayLayers),
                )
              : characterGroups;
            let filterPredicate: ((collider: rapier.Collider) => boolean) | undefined;
            if (oneWayActive) {
              oneWayFilterLayers = config.oneWayLayers;
              filterPredicate = oneWayFilterPredicate;
            }
            controller.computeColliderMovement(
              entry.collider,
              desired,
              options.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
              filterGroups,
              filterPredicate,
            );
            const movement = controller.computedMovement();
            const nextTranslation = kinematicScratch.nextTranslation;
            nextTranslation.x = current.x + movement.x;
            nextTranslation.y = current.y + movement.y;
            nextTranslation.z = current.z + movement.z;
            entry.body.setNextKinematicTranslation(nextTranslation);
          } else {
            if (!entry.body.isKinematic())
              throw new Error("IPhysicsSimulation received kinematic input for a dynamic body.");
            entry.body.setNextKinematicTranslation(target);
          }
          entry.body.setNextKinematicRotation(rotation);
        }
      }
      options.world.timestep = deltaTime;
      // The wheels ray-cast and write the chassis' velocity, so they run before the solver.
      for (const vehicle of vehicles.values()) {
        // Sensors are excluded from the wheel rays, exactly as every other query on this seam does.
        // An `Area3D` is a trigger volume — the finish-line gate a car drives under, a boost pad, a
        // pickup — and a wheel that rests on one reads the strut as fully compressed: measured on
        // the racing template, a car crossing a gate sensor was thrown 30 cm into the air and then
        // landed on its own chassis collider. A trigger volume is never ground.
        vehicle.controller.updateVehicle(
          deltaTime,
          options.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
          vehicle.rayGroups,
        );
        // A loaded wheel is holding the car up, and `updateVehicle` writes velocity rather than
        // impulses. Rapier skips a sleeping body, so a car that dozed off mid-drop would hang in
        // the air for good; only an unloaded car is left alone to sleep.
        for (const [index, restLength] of vehicle.restLengths.entries()) {
          if (
            vehicle.controller.wheelIsInContact(index) &&
            (vehicle.controller.wheelSuspensionLength(index) ?? 0) < restLength
          ) {
            vehicle.body.wakeUp();
            break;
          }
        }
      }
      options.world.step(options.eventQueue);
      // Rapier retains accumulated forces and torques unless the caller clears them. The public
      // seam is a fixed-step force — an off-centre one adds a torque — so clear both after every
      // step to keep web and native actuation aligned.
      for (const entry of bodies.values()) {
        entry.body.resetForces(true);
        entry.body.resetTorques(true);
      }
      dirtyBodies.clear();
    },
    readVisibleTransforms: (renderBuffer) => {
      requireLive();
      requirePhysicsRenderBuffer(renderBuffer, bodies.size);
      let index = 0;
      for (const entry of bodies.values()) {
        if (!entry.body.isValid()) continue;
        const offset = index * PHYSICS_TRANSFORM_STRIDE;
        writeRapierTransformRecord(entry, renderBuffer, offset);
        index += 1;
      }
      return index;
    },
    readBodySleepStates: (buffer) => {
      requireLive();
      requirePhysicsSleepStateBuffer(buffer, bodies.size);
      let index = 0;
      for (const entry of bodies.values()) {
        if (!entry.body.isValid()) continue;
        const offset = index * PHYSICS_SLEEP_STATE_STRIDE;
        buffer[offset] = entry.id;
        buffer[offset + 1] = entry.body.isSleeping() ? 1 : 0;
        index += 1;
      }
      return index;
    },
    intersectRay: (value) => {
      requireLive();
      const query = requirePhysicsRayQuery(value);
      const dx = query.to.x - query.from.x;
      const dy = query.to.y - query.from.y;
      const dz = query.to.z - query.from.z;
      const distance = Math.hypot(dx, dy, dz);
      const ray = new options.rapier.Ray(query.from, {
        x: dx / distance,
        y: dy / distance,
        z: dz / distance,
      });
      const hit = options.world.castRayAndGetNormal(
        ray,
        distance,
        true,
        options.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        queryPredicate(query.collisionMask),
      );
      let closestCollider = hit?.collider;
      let closestTime = hit?.timeOfImpact;
      let closestNormal = hit?.normal;
      for (const dirtyBody of dirtyBodies) {
        if (!queryMatches(query.collisionMask, dirtyBody.collider)) continue;
        const dirtyHit = dirtyBody.collider.castRayAndGetNormal(ray, distance, true);
        if (
          dirtyHit === null ||
          (closestTime !== undefined && dirtyHit.timeOfImpact >= closestTime)
        )
          continue;
        closestCollider = dirtyBody.collider;
        closestTime = dirtyHit.timeOfImpact;
        closestNormal = dirtyHit.normal;
      }
      if (closestCollider === undefined || closestTime === undefined || closestNormal === undefined)
        return undefined;
      const entry = byCollider.get(closestCollider.handle);
      if (entry === undefined)
        throw new Error("IPhysicsSimulation query returned an unknown body.");
      const position = ray.pointAt(closestTime);
      return {
        ...queryHit(entry),
        distance: closestTime,
        normal: { x: closestNormal.x, y: closestNormal.y, z: closestNormal.z },
        position: { x: position.x, y: position.y, z: position.z },
      };
    },
    intersectShape: (value) => {
      requireLive();
      const query = requirePhysicsShapeQuery(value);
      const rawShape = createWebPhysicsShape(options.rapier, query.shape, false).shape;
      const hits: IPhysicsQueryHit[] = [];
      options.world.intersectionsWithShape(
        query.position,
        query.rotation,
        rawShape,
        (collider) => {
          const entry = byCollider.get(collider.handle);
          if (entry !== undefined && queryPredicate(query.collisionMask)(collider))
            hits.push(queryHit(entry));
          return hits.length < query.maxResults;
        },
        options.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        queryPredicate(query.collisionMask),
      );
      for (const dirtyBody of dirtyBodies) {
        if (
          hits.length < query.maxResults &&
          queryMatches(query.collisionMask, dirtyBody.collider) &&
          dirtyBody.collider.intersectsShape(rawShape, query.position, query.rotation)
        )
          hits.push(queryHit(dirtyBody));
      }
      return hits;
    },
    intersectPoint: (value) => {
      requireLive();
      const query = requirePhysicsPointQuery(value);
      const hits: IPhysicsQueryHit[] = [];
      options.world.intersectionsWithPoint(
        query.position,
        (collider) => {
          const entry = byCollider.get(collider.handle);
          if (entry !== undefined && queryPredicate(query.collisionMask)(collider))
            hits.push(queryHit(entry));
          return hits.length < query.maxResults;
        },
        options.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
        undefined,
        undefined,
        undefined,
        queryPredicate(query.collisionMask),
      );
      for (const dirtyBody of dirtyBodies) {
        if (
          hits.length < query.maxResults &&
          queryMatches(query.collisionMask, dirtyBody.collider) &&
          dirtyBody.collider.containsPoint(query.position)
        )
          hits.push(queryHit(dirtyBody));
      }
      return hits;
    },
    readBodyTransform: (id) => {
      requireLive();
      const entry = bodies.get(id);
      if (entry === undefined || !entry.body.isValid()) return undefined;
      const position = entry.body.translation();
      const rotation = entry.body.rotation();
      return { position, rotation };
    },
    readCharacterState: (id) => {
      requireLive();
      const entry = bodies.get(id);
      return entry === undefined ? undefined : characterState(entry, byCollider);
    },
    areaIntersections: (id) => {
      requireLive();
      const area = bodies.get(id);
      const current = areaIntersections.get(id);
      if (area === undefined || current === undefined) return emptyAreaIntersections;
      current.clear();
      areaIntersectionId = id;
      areaIntersectionMask = area.collider.collisionGroups() & 0xffff;
      areaIntersectionMembers = current;
      try {
        options.world.intersectionsWithShape(
          area.collider.translation(),
          area.collider.rotation(),
          area.collider.shape,
          areaIntersectionCallback,
          options.rapier.QueryFilterFlags.EXCLUDE_SENSORS,
          undefined,
          area.collider,
        );
      } finally {
        areaIntersectionMembers = undefined;
        areaIntersectionId = -1;
        areaIntersectionMask = 0;
      }
      return current;
    },
    readContacts: (target, colliders, buffer) => {
      requireLive();
      if (!(buffer instanceof Float32Array))
        throw new Error("IPhysicsSimulation.readContacts requires a Float32Array buffer.");
      if (!(colliders instanceof Uint32Array))
        throw new Error("IPhysicsSimulation.readContacts requires a Uint32Array of collider ids.");
      // Seam ids are logical body ids, not Rapier handles: resolve through the registry.
      const targetCollider = bodies.get(target.id)?.collider;
      if (targetCollider === undefined)
        throw new Error(
          `IPhysicsSimulation contact target ${String(target.id)} is not a live collider.`,
        );
      const capacity = Math.floor(buffer.length / PHYSICS_CONTACT_STRIDE);
      let count = 0;
      for (let index = 0; index < colliders.length; index += 1) {
        const otherId = colliders[index] as number;
        if (otherId === target.id) continue;
        const entry = bodies.get(otherId);
        // A sleeping body was not solved this step, so its stored impulses are not this step's.
        if (entry === undefined || entry.body.isSleeping()) continue;
        // A heightfield reports one candidate manifold per touched sub-shape and most carry no
        // solver contact at all, so only manifolds the solver actually used are kept.
        options.world.contactPair(targetCollider, entry.collider, (manifold, flipped) => {
          if (manifold.numSolverContacts() === 0) return;
          if (count < capacity) writeContactRecord(buffer, count, otherId, manifold, flipped);
          count += 1;
        });
      }
      return count;
    },
    setColliderShape: (collider, shape) => {
      requireLive();
      const entry = bodies.get(collider.id);
      if (entry === undefined)
        throw new Error(
          `IPhysicsSimulation shape target ${String(collider.id)} is not a live collider.`,
        );
      entry.collider.setShape(createWebPhysicsShape(options.rapier, shape).shape);
    },
    createVehicle: (vehicleOptions) => {
      requireLive();
      const requested = requirePhysicsVehicleCreateOptions(vehicleOptions);
      const entry = requireDynamic(bodies.get(requested.bodyId), requested.bodyId, "createVehicle");
      const id = nextVehicleId;
      nextVehicleId += 1;
      const controller = options.world.createVehicleController(entry.body);
      // The suspension ray is cast along this direction from the wheel's attachment point.
      const suspensionDirection = { x: 0, y: -1, z: 0 };
      const wheels = new Float32Array(requested.wheels.length * PHYSICS_VEHICLE_WHEEL_STRIDE);
      // The engine force follows `up × axle`, so that is also the direction a positive speed means.
      const axleComponent = requested.forwardAxis === 2 ? requested.axle.x : requested.axle.z;
      const forwardComponent = requested.forwardAxis === 2 ? -axleComponent : axleComponent;
      const record: IVehicleRecord = {
        body: entry.body,
        bodyId: requested.bodyId,
        controller,
        rayGroups: entry.collider.collisionGroups(),
        restLengths: requested.wheels.map((wheel) => wheel.suspensionRestLength),
        direction: forwardComponent < 0 ? -1 : 1,
        forwardAxis: requested.forwardAxis,
        state: { speed: 0, wheels },
        steering: [],
        traction: [],
        wheels,
      };
      controller.indexUpAxis = 1;
      controller.setIndexForwardAxis = requested.forwardAxis;
      for (const [index, wheel] of requested.wheels.entries()) {
        controller.addWheel(
          wheel.position,
          suspensionDirection,
          requested.axle,
          wheel.suspensionRestLength,
          wheel.wheelRadius,
        );
        controller.setWheelSuspensionStiffness(index, wheel.suspensionStiffness);
        controller.setWheelSuspensionCompression(index, wheel.dampingCompression);
        controller.setWheelSuspensionRelaxation(index, wheel.dampingRelaxation);
        controller.setWheelFrictionSlip(index, wheel.wheelFrictionSlip);
        if (wheel.maxSuspensionTravel !== undefined)
          controller.setWheelMaxSuspensionTravel(index, wheel.maxSuspensionTravel);
        if (wheel.useAsTraction) record.traction.push(index);
        if (wheel.useAsSteering) record.steering.push(index);
      }
      vehicles.set(id, record);
      return id;
    },
    setVehicleInput: (id, input) => {
      requireLive();
      if (
        typeof input?.engineForce !== "number" ||
        typeof input.brake !== "number" ||
        typeof input.steering !== "number" ||
        !Number.isFinite(input.engineForce) ||
        !Number.isFinite(input.brake) ||
        !Number.isFinite(input.steering)
      )
        throw new Error(
          "TN_PHYSICS_NON_FINITE: vehicle input needs a finite engineForce, brake and steering.",
        );
      const { controller, steering, traction } = requireVehicle(id, "setVehicleInput");
      // Indexed, not `for…of`: a car writes engine force, brake and steering every physics step, so
      // this runs three times a frame per car and the iterator call it avoids is the one a
      // template's allocation sentinel measures (`create-threenative`'s `template-runtime-cost`
      // spec refuses an array iteration in a scene's ordinary frame).
      for (let index = 0; index < traction.length; index += 1)
        controller.setWheelEngineForce(traction[index] as number, input.engineForce);
      for (let index = 0; index < steering.length; index += 1)
        controller.setWheelSteering(steering[index] as number, input.steering);
      for (let wheel = 0; wheel < controller.numWheels(); wheel += 1)
        controller.setWheelBrake(wheel, input.brake);
    },
    readVehicleState: (id) => {
      requireLive();
      const record = requireVehicle(id, "readVehicleState");
      const { controller, state, wheels } = record;
      const entry = bodies.get(record.bodyId);
      if (entry === undefined) throw new Error("TN_VEHICLE_UNKNOWN: the chassis left the backend.");
      state.speed = vehicleSpeed(entry, record.forwardAxis, record.direction);
      for (let index = 0; index < controller.numWheels(); index += 1) {
        const offset = index * PHYSICS_VEHICLE_WHEEL_STRIDE;
        wheels[offset] = controller.wheelIsInContact(index) ? 1 : 0;
        wheels[offset + 1] = controller.wheelSuspensionLength(index) ?? 0;
        wheels[offset + 2] = controller.wheelRotation(index) ?? 0;
      }
      return state;
    },
    resetVehicle: (id, position, yaw) => {
      requireLive();
      requireFiniteVector(position, "vehicle position");
      if (typeof yaw !== "number" || !Number.isFinite(yaw))
        throw new Error("TN_PHYSICS_NON_FINITE: vehicle yaw must be a finite number of radians.");
      const record = requireVehicle(id, "resetVehicle");
      const entry = requireDynamic(bodies.get(record.bodyId), record.bodyId, "resetVehicle");
      entry.body.setTranslation(position, true);
      entry.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
      entry.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      entry.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      options.world.propagateModifiedBodyPositionsToColliders();
      dirtyBodies.add(entry);
    },
    drainCollisionEvents: (buffer) => {
      requireLive();
      requirePhysicsEventBuffer(buffer);
      options.eventQueue.drainCollisionEvents((first, second, started) => {
        const left = byCollider.get(first)?.id;
        const right = byCollider.get(second)?.id;
        if (left !== undefined && right !== undefined) {
          pendingCollisionEvents.push(left, right, Number(started), 1);
        }
      });
      const count = pendingCollisionEvents.length / PHYSICS_COLLISION_EVENT_STRIDE;
      if (buffer.length < pendingCollisionEvents.length)
        throw new Error("IPhysicsSimulation collision event buffer is too small.");
      for (let index = 0; index < pendingCollisionEvents.length; index += 1)
        buffer[index] = pendingCollisionEvents[index] as number;
      pendingCollisionEvents.length = 0;
      return count;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const id of [...vehicles.keys()]) removeVehicleRecord(id);
      for (const entry of bodies.values()) {
        if (entry.controller !== undefined)
          options.world.removeCharacterController(entry.controller);
        if (entry.body.isValid()) options.world.removeRigidBody(entry.body);
      }
      bodies.clear();
      byCollider.clear();
      joints.clear();
      dirtyBodies.clear();
      areaIntersections.clear();
      pendingCollisionEvents.length = 0;
      options.eventQueue.free();
      options.world.free();
    },
  };
  return simulation;
}

// One warning per process, not per node: a scene that builds a hundred bodies from the deprecated
// option would otherwise bury the one line that says what to change.
let warnedDeprecatedWorldOption = false;

export function requirePhysicsSimulation(
  physics: { readonly simulation?: IPhysicsSimulation } | undefined,
  world: unknown,
): IPhysicsSimulation {
  // Warn on the supplied option, not on the path taken: a caller that passes both still gets told
  // the option is going away, and only the current `physics` path stays silent.
  if (world !== undefined && !warnedDeprecatedWorldOption) {
    warnedDeprecatedWorldOption = true;
    console.warn(
      "TN_DEPRECATED_PHYSICS_WORLD_OPTION: the constructor option `world` is deprecated on every physics node; pass an IPhysicsContext as `physics` instead. The node classes themselves are not deprecated.",
    );
  }
  if (physics?.simulation !== undefined) return physics.simulation;
  const candidate =
    typeof world === "object" && world !== null && "simulation" in world
      ? (world as { readonly simulation?: unknown }).simulation
      : world;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    "createBody" in candidate &&
    typeof candidate.createBody === "function" &&
    "step" in candidate &&
    typeof candidate.step === "function"
  )
    return candidate as IPhysicsSimulation;
  const backend = selectedBackend;
  if (world !== undefined && backend?.simulationForWorld !== undefined)
    return backend.simulationForWorld(candidate);
  throw new Error(
    "Physics nodes require an IPhysicsContext. Passing a raw backend world is deprecated and backend-specific.",
  );
}
