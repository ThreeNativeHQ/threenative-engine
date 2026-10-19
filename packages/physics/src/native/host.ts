import { physicsBodyHandle, physicsColliderHandle, physicsHandle } from "../handles.js";
import type {
  IPhysicsBodyCreateOptions,
  IPhysicsInputSnapshot,
  IPhysicsJointCreateOptions,
  IPhysicsPointQuery,
  IPhysicsQueryHit,
  IPhysicsRayHit,
  IPhysicsRayQuery,
  IPhysicsRuntimeSimulation,
  IPhysicsShapeDescriptor,
  IPhysicsShapeQuery,
  IPhysicsSimulation,
  IPhysicsVector3,
  IPhysicsVehicleCreateOptions,
  IPhysicsVehicleInput,
  IPhysicsVehicleState,
} from "../simulation.js";
import {
  PHYSICS_TRANSFORM_STRIDE,
  PHYSICS_VEHICLE_WHEEL_STRIDE,
  effectiveContinuousCollision,
  requireFiniteRotation,
  requireFiniteVector,
  requirePhysicsBodySensor,
  requirePhysicsEventBuffer,
  requirePhysicsJointCreateOptions,
  requirePhysicsPointQuery,
  requirePhysicsRayQuery,
  requirePhysicsRenderBuffer,
  requirePhysicsShapeQuery,
  requirePhysicsSleepStateBuffer,
  requirePhysicsStepInput,
  requirePhysicsVehicleCreateOptions,
} from "../simulation.js";

export interface INativeShapeDescriptor {
  readonly kind: "box" | "capsule" | "heightfield" | "sphere" | "trimesh";
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** Present for `trimesh` only: a flat xyz vertex buffer and a flat triangle-index buffer. */
  readonly vertices?: Float32Array;
  readonly indices?: Uint32Array;
  /** Present for `heightfield` only: column-major samples, the grid and its full extent. */
  readonly heights?: Float32Array;
  readonly rows?: number;
  readonly columns?: number;
  readonly scale?: { readonly x: number; readonly y: number; readonly z: number };
  collisionLayer: number;
  collisionMask: number;
  sensor: boolean;
}

export interface INativeBodyOptions {
  readonly collisionLayer: number;
  readonly collisionMask: number;
  readonly entity?: string;
  readonly mass: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly w: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly sensor: boolean;
  readonly shape: INativeShapeDescriptor;
  readonly type: "character" | "dynamic" | "fixed" | "kinematic";
  readonly continuousCollision: boolean;
}

export type INativeJointOptions = IPhysicsJointCreateOptions;

export interface INativeRayHit {
  readonly bodyId: number;
  readonly distance: number;
  readonly normal: { readonly x: number; readonly y: number; readonly z: number };
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

export interface INativeRayQuery {
  readonly from: { readonly x: number; readonly y: number; readonly z: number };
  readonly to: { readonly x: number; readonly y: number; readonly z: number };
  readonly collisionMask: number;
}

export interface INativeShapeQuery {
  readonly shape: INativeShapeDescriptor;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly rotation: {
    readonly w: number;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly collisionMask: number;
  readonly maxResults: number;
}

export interface INativePointQuery {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly collisionMask: number;
  readonly maxResults: number;
}

export interface INativeQueryHit {
  readonly bodyId: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * The flat wheel record the C ABI takes: twelve floats per wheel, in the order
 * `physics_native.h` documents. Flattening here rather than in the binding keeps the optional
 * `maxSuspensionTravel` decision on the TypeScript side of the seam.
 */
export interface INativeVehicleOptions {
  readonly bodyId: number;
  readonly forwardAxis: 0 | 2;
  readonly axle: IPhysicsVector3;
  readonly wheels: Float32Array;
}

/** Raw object installed by the C++ runtime. It is wrapped before shared nodes see it. */
export interface INativeSimulation {
  configureCharacter(
    id: number,
    options: Parameters<IPhysicsSimulation["configureCharacter"]>[1],
  ): void;
  createBody(options: INativeBodyOptions): number;
  createJoint?(options: INativeJointOptions): number;
  dispose(): void;
  drainCollisionEvents(buffer: Uint32Array): number;
  removeBody(id: number): void;
  removeJoint?(id: number): void;
  setBodyTransform?(
    id: number,
    position: { readonly x: number; readonly y: number; readonly z: number },
  ): void;
  /** Optional so old runtimes fail loudly through the adapter instead of silently diverging. */
  applyBodyImpulse?(id: number, impulse: IPhysicsVector3): void;
  applyBodyForce?(id: number, force: IPhysicsVector3): void;
  applyBodyForceAtPoint?(id: number, force: IPhysicsVector3, point: IPhysicsVector3): void;
  setBodyLinearVelocity?(id: number, velocity: IPhysicsVector3): void;
  readBodyLinearVelocity?(id: number): IPhysicsVector3;
  readVisibleTransforms(renderBuffer: Float32Array): number;
  readBodySleepStates(buffer: Float32Array): number;
  readCharacterStates(buffer: Float32Array): number;
  /** Optional so a runtime built before vehicles still fails loudly through the adapter. */
  createVehicle?(options: INativeVehicleOptions): number;
  setVehicleInput?(id: number, input: IPhysicsVehicleInput): void;
  readVehicleState?(id: number, output: Float32Array): number;
  resetVehicle?(id: number, position: IPhysicsVector3, yaw: number): void;
  readAreaIntersections(buffer: Uint32Array): number;
  /** Optional so old runtimes fail loudly through the adapter instead of reporting no contact. */
  readContacts?(target: number, candidates: Uint32Array, output: Float32Array): number;
  setColliderShape?(id: number, shape: INativeShapeDescriptor): void;
  intersectRay(
    query: INativeRayQuery,
    output?: Float32Array,
  ): INativeRayHit | number | null | undefined;
  intersectShape(query: INativeShapeQuery): readonly INativeQueryHit[];
  intersectPoint(query: INativePointQuery): readonly INativeQueryHit[];
  step(deltaTime: number, inputSnapshot?: IPhysicsInputSnapshot): void;
}

export interface INativePhysicsHost {
  readonly version: string;
  createSimulation(options?: unknown): INativeSimulation;
}

/**
 * The MetaHuman facial rig resident, installed by
 * `packages/runtime-native/src/metahuman/native_bindings.cpp` when the runtime is built with
 * `TN_ENABLE_METAHUMAN=ON`. Declared here because this file owns the global; the interface
 * itself, and the accessor that fails closed with `TN_NATIVE_METAHUMAN_MISSING`, live in
 * `@threenative/metahuman` (`src/native/host.ts`), which must not declare the global twice.
 */
export interface INativeMetaHumanResident {
  readonly version: string;
  create(dna: ArrayBuffer | Uint8Array): number;
  count(id: number, kind: number): number;
  name(id: number, kind: number, index: number): string;
  setLod(id: number, lod: number): void;
  setGui(id: number, values: Float32Array): void;
  setRaw(id: number, values: Float32Array): void;
  evaluate(id: number, useGui: boolean): void;
  jointOutputs(id: number): Float32Array;
  blendShapeOutputs(id: number): Float32Array;
  animatedMapOutputs(id: number): Float32Array;
  neutralJoints(id: number): Float32Array;
  destroy(id: number): void;
  lastError(): string;
}

declare global {
  // One global, three residents: the physics host, the MetaHuman rig host and the playtest
  // mailbox bridge (packages/playtest/src/three/device.ts reads `playtest`). Declared where
  // the name was first declared; keep both shapes in sync with their readers.
  var __THREENATIVE_NATIVE__:
    | {
        readonly physics?: INativePhysicsHost;
        readonly metahuman?: INativeMetaHumanResident;
        readonly playtest?: {
          receive?(path: string): string | undefined;
          respond?(path: string, payload: string): boolean;
        };
      }
    | undefined;
}

export function nativePhysicsHost(): INativePhysicsHost {
  const host = globalThis.__THREENATIVE_NATIVE__?.physics;
  if (
    host === undefined ||
    typeof host.version !== "string" ||
    typeof host.createSimulation !== "function"
  ) {
    throw new Error("TN_NATIVE_PHYSICS_MISSING: runtime did not install the physics ABI");
  }
  return host;
}

export function nativeSimulation(value: unknown): INativeSimulation {
  if (
    typeof value !== "object" ||
    value === null ||
    !("configureCharacter" in value) ||
    typeof value.configureCharacter !== "function" ||
    !("createBody" in value) ||
    typeof value.createBody !== "function" ||
    !("dispose" in value) ||
    typeof value.dispose !== "function" ||
    !("drainCollisionEvents" in value) ||
    typeof value.drainCollisionEvents !== "function" ||
    !("removeBody" in value) ||
    typeof value.removeBody !== "function" ||
    !("readVisibleTransforms" in value) ||
    typeof value.readVisibleTransforms !== "function" ||
    !("readBodySleepStates" in value) ||
    typeof value.readBodySleepStates !== "function" ||
    !("readCharacterStates" in value) ||
    typeof value.readCharacterStates !== "function" ||
    !("readAreaIntersections" in value) ||
    typeof value.readAreaIntersections !== "function" ||
    !("intersectRay" in value) ||
    typeof value.intersectRay !== "function" ||
    !("intersectShape" in value) ||
    typeof value.intersectShape !== "function" ||
    !("intersectPoint" in value) ||
    typeof value.intersectPoint !== "function" ||
    !("step" in value) ||
    typeof value.step !== "function"
  ) {
    throw new Error("TN_NATIVE_PHYSICS_INVALID: physics world is not a native simulation");
  }
  return value as INativeSimulation;
}

function primitiveShape(shape: IPhysicsShapeDescriptor): INativeShapeDescriptor {
  if (shape.kind !== "box" && shape.kind !== "sphere" && shape.kind !== "capsule")
    throw new Error(`TN_NATIVE_PHYSICS_SHAPE_UNSUPPORTED: ${shape.kind} remains OPEN on native`);
  return shape as INativeShapeDescriptor;
}

/**
 * A body's shape, including the concave shapes a level needs.
 *
 * A doorway, an arch or a floor with a hole cannot be a box, a ball or a capsule, so a trimesh is
 * the only shape that keeps the opening the model actually has. A heightfield crosses as its own
 * samples, in the column-major order the web backend hands Rapier, so both runtimes build the same
 * surface. Queries stay primitive-only: the native query path has no trimesh representation and
 * says so instead of silently missing.
 */
function nativeBodyShape(shape: IPhysicsShapeDescriptor): INativeShapeDescriptor {
  if (shape.kind === "heightfield") {
    const { columns, heights, rows, scale } = shape;
    if (
      rows === undefined ||
      columns === undefined ||
      heights === undefined ||
      scale === undefined ||
      heights.length !== rows * columns
    )
      throw new Error(
        "TN_NATIVE_PHYSICS_SHAPE_INVALID: heightfield requires rows x columns heights",
      );
    return {
      collisionLayer: shape.collisionLayer,
      collisionMask: shape.collisionMask,
      columns,
      heights,
      kind: "heightfield",
      rows,
      scale,
      sensor: shape.sensor,
      x: 0,
      y: 0,
      z: 0,
    };
  }
  if (shape.kind === "trimesh") {
    if (shape.vertices === undefined || shape.indices === undefined)
      throw new Error("TN_NATIVE_PHYSICS_SHAPE_INVALID: trimesh requires vertices and indices");
    return {
      collisionLayer: shape.collisionLayer,
      collisionMask: shape.collisionMask,
      indices: shape.indices,
      kind: shape.kind,
      sensor: shape.sensor,
      vertices: shape.vertices,
      x: shape.x,
      y: shape.y,
      z: shape.z,
    };
  }
  return primitiveShape(shape);
}

function opaqueNativeShape(shape: INativeShapeDescriptor): unknown {
  return Object.freeze({ backend: "native", kind: shape.kind });
}

function isSmallBufferError(error: unknown): boolean {
  return error instanceof Error && /buffer is too small/i.test(error.message);
}

function growUint32(buffer: Uint32Array, minimum: number): Uint32Array {
  let length = Math.max(16, buffer.length);
  while (length < minimum) length *= 2;
  return length === buffer.length ? buffer : new Uint32Array(length);
}

interface IStoredCharacterState {
  grounded: boolean;
  groundBody?: ReturnType<typeof physicsBodyHandle>;
  groundCollider?: number;
  readonly groundNormal: { x: number; y: number; z: number };
}

const NATIVE_CHARACTER_STATE_STRIDE = 6;
/** Rapier's own default, sent when a game leaves `maxSuspensionTravel` unset. */
const RAPIER_DEFAULT_MAX_SUSPENSION_TRAVEL = 5;
const NATIVE_VEHICLE_WHEEL_WIDTH = 12;

/** One vehicle's reusable read record: the speed in slot 0, then the wheels the node reads. */
interface IStoredVehicle {
  readonly buffer: Float32Array;
  readonly state: IPhysicsVehicleState;
}

function flattenVehicleWheels(options: IPhysicsVehicleCreateOptions): Float32Array {
  const wheels = new Float32Array(options.wheels.length * NATIVE_VEHICLE_WHEEL_WIDTH);
  options.wheels.forEach((wheel, index) => {
    wheels.set(
      [
        wheel.position.x,
        wheel.position.y,
        wheel.position.z,
        wheel.wheelRadius,
        wheel.suspensionRestLength,
        wheel.suspensionStiffness,
        wheel.dampingCompression,
        wheel.dampingRelaxation,
        wheel.wheelFrictionSlip,
        wheel.maxSuspensionTravel ?? RAPIER_DEFAULT_MAX_SUSPENSION_TRAVEL,
        wheel.useAsSteering ? 1 : 0,
        wheel.useAsTraction ? 1 : 0,
      ],
      index * NATIVE_VEHICLE_WHEEL_WIDTH,
    );
  });
  return wheels;
}

export function createNativePhysicsSimulation(
  raw: INativeSimulation,
  version: string,
): IPhysicsRuntimeSimulation {
  const bodyIds = new Set<number>();
  const bodyHandles = new Map<number, ReturnType<typeof physicsBodyHandle>>();
  const jointBodies = new Map<number, readonly [number, number]>();
  const characterIds = new Set<number>();
  const characterState = new Map<number, IStoredCharacterState>();
  const characterStatePresent = new Set<number>();
  const vehicles = new Map<number, IStoredVehicle>();
  const vehicleBodies = new Map<number, number>();
  const dynamicBodies = new Set<number>();
  let characterStates = new Float32Array(48);
  const rayOutput = new Float32Array(8);
  let areaPairs: Uint32Array<ArrayBufferLike> = new Uint32Array(32);
  const areaIntersections = new Map<number, Set<number>>();
  const emptyAreaIntersections = new Set<number>();
  let bodyTransforms = new Float32Array(PHYSICS_TRANSFORM_STRIDE * 8);
  const bodyTransformRows = new Map<number, number>();
  let characterStateDirty = true;
  let areaIntersectionsDirty = true;
  let bodyTransformsDirty = true;
  let disposed = false;
  const requireLive = () => {
    if (disposed) throw new Error("Physics simulation is disposed.");
  };
  const invalidateObservations = () => {
    characterStateDirty = true;
    areaIntersectionsDirty = true;
    bodyTransformsDirty = true;
  };
  const bodyHandle = (id: number) => {
    const handle = bodyHandles.get(id);
    if (handle === undefined)
      throw new Error("TN_NATIVE_PHYSICS_INVALID: query returned an unknown body");
    return handle;
  };
  const requireVehicle = (id: number, operation: string): IStoredVehicle => {
    const record = vehicles.get(id);
    if (record === undefined)
      throw new Error(`TN_VEHICLE_UNKNOWN: ${operation} references an unknown vehicle ${id}.`);
    return record;
  };
  const finiteQueryVector = (
    value: { readonly x: number; readonly y: number; readonly z: number },
    label: string,
  ) => {
    if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || !Number.isFinite(value.z))
      throw new Error(`TN_NATIVE_PHYSICS_INVALID: ${label} contains a non-finite vector`);
    return { x: value.x, y: value.y, z: value.z };
  };
  const nativeHit = (hit: INativeQueryHit): IPhysicsQueryHit => {
    if (!Number.isSafeInteger(hit.bodyId) || hit.bodyId < 0)
      throw new Error("TN_NATIVE_PHYSICS_INVALID: query returned an invalid body id");
    const body = bodyHandle(hit.bodyId);
    return {
      body,
      entity: body.entity,
      position: finiteQueryVector(hit.position, "query hit position"),
    };
  };
  // The native ABI has no per-body transform call, only the bulk render read the renderer already
  // makes. `readBodyTransform` is the seam a game uses through `syncFromPhysics()`, so serve it
  // from one cached bulk read per step rather than adding an ABI entry point or reading N times.
  const refreshBodyTransforms = () => {
    if (!bodyTransformsDirty) return;
    const required = Math.max(1, bodyIds.size) * PHYSICS_TRANSFORM_STRIDE;
    if (bodyTransforms.length < required) bodyTransforms = new Float32Array(required);
    const count = raw.readVisibleTransforms(bodyTransforms);
    bodyTransformRows.clear();
    for (let index = 0; index < count; index += 1) {
      const offset = index * PHYSICS_TRANSFORM_STRIDE;
      const id = bodyTransforms[offset];
      if (id === undefined || !Number.isInteger(id) || id < 0)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: malformed visible transform record");
      bodyTransformRows.set(id, offset);
    }
    bodyTransformsDirty = false;
  };
  const scalarAt = (offset: number) => {
    const value = bodyTransforms[offset];
    if (value === undefined || !Number.isFinite(value))
      throw new Error("TN_NATIVE_PHYSICS_INVALID: visible transform contains a non-finite scalar");
    return value;
  };
  const refreshCharacterState = () => {
    if (!characterStateDirty) return;
    const required = Math.max(1, characterIds.size) * NATIVE_CHARACTER_STATE_STRIDE;
    if (characterStates.length < required) characterStates = new Float32Array(required);
    characterStates.fill(Number.NaN, 0, required);
    const stateCount = raw.readCharacterStates(characterStates);
    characterStatePresent.clear();
    for (let index = 0; index < stateCount; index += 1) {
      const offset = index * NATIVE_CHARACTER_STATE_STRIDE;
      const id = characterStates[offset];
      const grounded = characterStates[offset + 1];
      const groundCollider = characterStates[offset + 2];
      const normalX = characterStates[offset + 3];
      const normalY = characterStates[offset + 4];
      const normalZ = characterStates[offset + 5];
      if (
        id === undefined ||
        grounded === undefined ||
        groundCollider === undefined ||
        normalX === undefined ||
        normalY === undefined ||
        normalZ === undefined ||
        !Number.isInteger(id) ||
        id < 0 ||
        (grounded !== 0 && grounded !== 1) ||
        !Number.isFinite(groundCollider) ||
        !Number.isFinite(normalX) ||
        !Number.isFinite(normalY) ||
        !Number.isFinite(normalZ)
      )
        throw new Error("TN_NATIVE_PHYSICS_INVALID: malformed six-float character state");
      let state = characterState.get(id);
      if (state === undefined) {
        state = { grounded: false, groundNormal: { x: 0, y: 1, z: 0 } };
        characterState.set(id, state);
      }
      state.grounded = grounded === 1;
      state.groundCollider = groundCollider < 0 ? undefined : groundCollider;
      state.groundBody = groundCollider < 0 ? undefined : bodyHandles.get(groundCollider);
      state.groundNormal.x = normalX;
      state.groundNormal.y = normalY;
      state.groundNormal.z = normalZ;
      characterStatePresent.add(id);
    }
    characterStateDirty = false;
  };
  const refreshAreaIntersections = () => {
    if (!areaIntersectionsDirty) return;
    areaPairs = growUint32(areaPairs, bodyIds.size * 2);
    const maximum = Math.max(16, bodyIds.size * bodyIds.size * 2);
    let pairCount: number;
    for (;;) {
      try {
        pairCount = raw.readAreaIntersections(areaPairs);
        break;
      } catch (error) {
        if (!isSmallBufferError(error) || areaPairs.length >= maximum) throw error;
        areaPairs = growUint32(areaPairs, Math.min(maximum, areaPairs.length * 2));
      }
    }
    for (const members of areaIntersections.values()) members.clear();
    for (let index = 0; index < pairCount; index += 1) {
      const offset = index * 2;
      const areaId = areaPairs[offset];
      const bodyId = areaPairs[offset + 1];
      if (areaId === undefined || bodyId === undefined)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: malformed area intersection");
      areaIntersections.get(areaId)?.add(bodyId);
    }
    areaIntersectionsDirty = false;
  };
  const simulation: IPhysicsRuntimeSimulation = {
    version,
    rawEventQueue: raw,
    rawWorld: raw,
    createBody: (options: IPhysicsBodyCreateOptions) => {
      requireLive();
      if (!Number.isFinite(options.mass) || options.mass < 0)
        throw new Error("Physics body mass must be a finite non-negative number.");
      if (
        options.continuousCollision !== undefined &&
        typeof options.continuousCollision !== "boolean"
      )
        throw new Error("Physics body continuousCollision must be a boolean.");
      // Same seam rule as web: a NaN placement corrupts the body for the rest of
      // the run instead of throwing, and a zero-length rotation normalizes to NaN.
      requireFiniteVector(options.position, "body position");
      requireFiniteRotation(options.rotation, "body rotation");
      const shape = nativeBodyShape(options.shape);
      const sensor = requirePhysicsBodySensor(options);
      const id = raw.createBody({
        collisionLayer: shape.collisionLayer,
        collisionMask: shape.collisionMask,
        mass: options.mass,
        position: options.position,
        rotation: options.rotation,
        sensor,
        shape,
        type: options.type,
        continuousCollision: effectiveContinuousCollision(
          options.type,
          options.continuousCollision,
        ),
      });
      if (!Number.isInteger(id) || id < 0)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: runtime returned an invalid body id");
      const rawHandle = { backend: "native", id };
      const bodyHandleValue = physicsBodyHandle(id, rawHandle, options.entity);
      bodyIds.add(id);
      bodyHandles.set(id, bodyHandleValue);
      if (options.type === "dynamic") dynamicBodies.add(id);
      if (sensor) {
        areaIntersections.set(id, new Set());
      }
      if (options.type === "character") {
        characterIds.add(id);
        characterState.set(id, { grounded: false, groundNormal: { x: 0, y: 1, z: 0 } });
      }
      invalidateObservations();
      return {
        body: bodyHandleValue,
        collider: physicsColliderHandle(id, rawHandle),
        controller: options.type === "character" ? physicsHandle(rawHandle) : undefined,
        rawShape: opaqueNativeShape(shape),
      };
    },
    createJoint: (jointOptions) => {
      requireLive();
      const normalized = requirePhysicsJointCreateOptions(jointOptions);
      if (!bodyIds.has(normalized.bodyA) || !bodyIds.has(normalized.bodyB))
        throw new Error("TN_PHYSICS_UNKNOWN_BODY: joint references an unknown body.");
      if (raw.createJoint === undefined)
        throw new Error("TN_NATIVE_PHYSICS_JOINTS_MISSING: runtime ABI is too old");
      const id = raw.createJoint(normalized);
      if (!Number.isSafeInteger(id) || id < 0)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: runtime returned an invalid joint id");
      if (jointBodies.has(id))
        throw new Error("TN_NATIVE_PHYSICS_INVALID: runtime returned a duplicate joint id");
      jointBodies.set(id, [normalized.bodyA, normalized.bodyB]);
      return id;
    },
    configureCharacter: (id, options) => {
      requireLive();
      raw.configureCharacter(id, options);
      invalidateObservations();
    },
    removeBody: (id) => {
      requireLive();
      raw.removeBody(id);
      bodyIds.delete(id);
      bodyHandles.delete(id);
      dynamicBodies.delete(id);
      for (const [jointId, bodies] of jointBodies) {
        if (bodies[0] === id || bodies[1] === id) jointBodies.delete(jointId);
      }
      areaIntersections.delete(id);
      characterIds.delete(id);
      characterState.delete(id);
      characterStatePresent.delete(id);
      // A vehicle lives and dies with its chassis, so the backend has already dropped the
      // controller; drop the read record with it rather than answering for a car that is gone.
      for (const [vehicleId, bodyId] of vehicleBodies) {
        if (bodyId !== id) continue;
        vehicleBodies.delete(vehicleId);
        vehicles.delete(vehicleId);
      }
      invalidateObservations();
    },
    removeJoint: (id) => {
      if (disposed || !jointBodies.has(id)) return;
      if (raw.removeJoint === undefined)
        throw new Error("TN_NATIVE_PHYSICS_JOINTS_MISSING: runtime ABI is too old");
      raw.removeJoint(id);
      jointBodies.delete(id);
    },
    setBodyTransform: (id, position) => {
      requireLive();
      if (raw.setBodyTransform === undefined)
        throw new Error("TN_NATIVE_PHYSICS_SET_TRANSFORM_MISSING: runtime ABI is too old");
      raw.setBodyTransform(id, position);
    },
    // Keep the optional raw members: an older runtime must throw rather than accept a call and
    // drop the actuation, which would make the same game diverge by platform.
    applyBodyImpulse: (id, impulse) => {
      requireLive();
      requireFiniteVector(impulse, "impulse");
      if (raw.applyBodyImpulse === undefined)
        throw new Error("TN_NATIVE_PHYSICS_ACTUATION_MISSING: runtime ABI is too old");
      raw.applyBodyImpulse(id, impulse);
    },
    applyBodyForce: (id, force) => {
      requireLive();
      requireFiniteVector(force, "force");
      if (raw.applyBodyForce === undefined)
        throw new Error("TN_NATIVE_PHYSICS_ACTUATION_MISSING: runtime ABI is too old");
      raw.applyBodyForce(id, force);
    },
    applyBodyForceAtPoint: (id, force, point) => {
      requireLive();
      requireFiniteVector(force, "force");
      requireFiniteVector(point, "force point");
      if (raw.applyBodyForceAtPoint === undefined)
        throw new Error("TN_NATIVE_PHYSICS_ACTUATION_MISSING: runtime ABI is too old");
      raw.applyBodyForceAtPoint(id, force, point);
    },
    setBodyLinearVelocity: (id, velocity) => {
      requireLive();
      requireFiniteVector(velocity, "linearVelocity");
      if (raw.setBodyLinearVelocity === undefined)
        throw new Error("TN_NATIVE_PHYSICS_ACTUATION_MISSING: runtime ABI is too old");
      raw.setBodyLinearVelocity(id, velocity);
    },
    readBodyLinearVelocity: (id) => {
      requireLive();
      if (raw.readBodyLinearVelocity === undefined)
        throw new Error("TN_NATIVE_PHYSICS_ACTUATION_MISSING: runtime ABI is too old");
      const velocity = raw.readBodyLinearVelocity(id);
      requireFiniteVector(velocity, "native linear velocity");
      return velocity;
    },
    step: (deltaTime, inputSnapshot) => {
      requireLive();
      requirePhysicsStepInput(deltaTime, inputSnapshot, (id) => bodyIds.has(id));
      raw.step(deltaTime, inputSnapshot);
      invalidateObservations();
    },
    readVisibleTransforms: (buffer) => {
      requireLive();
      requirePhysicsRenderBuffer(buffer, bodyIds.size);
      return raw.readVisibleTransforms(buffer);
    },
    readBodySleepStates: (buffer) => {
      if (disposed) throw new Error("Physics simulation is disposed.");
      requirePhysicsSleepStateBuffer(buffer, bodyIds.size);
      return raw.readBodySleepStates(buffer);
    },
    readContacts: (target, colliders, buffer) => {
      requireLive();
      if (raw.readContacts === undefined)
        throw new Error("TN_NATIVE_PHYSICS_CONTACTS_MISSING: runtime ABI is too old");
      if (!(buffer instanceof Float32Array) || !(colliders instanceof Uint32Array))
        throw new Error(
          "IPhysicsSimulation.readContacts requires Uint32Array ids and a Float32Array.",
        );
      if (!bodyIds.has(target.id))
        throw new Error(
          `IPhysicsSimulation contact target ${String(target.id)} is not a live collider.`,
        );
      const count = raw.readContacts(target.id, colliders, buffer);
      if (!Number.isInteger(count) || count < 0)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: contact read returned an invalid count");
      return count;
    },
    setColliderShape: (collider, shape) => {
      requireLive();
      if (raw.setColliderShape === undefined)
        throw new Error("TN_NATIVE_PHYSICS_SHAPE_REFRESH_MISSING: runtime ABI is too old");
      if (!bodyIds.has(collider.id))
        throw new Error(
          `IPhysicsSimulation shape target ${String(collider.id)} is not a live collider.`,
        );
      if (shape.kind !== "heightfield")
        throw new Error(
          `TN_NATIVE_PHYSICS_SHAPE_UNSUPPORTED: native setColliderShape takes a heightfield, not ${shape.kind}`,
        );
      raw.setColliderShape(collider.id, nativeBodyShape(shape));
      invalidateObservations();
    },
    intersectRay: (value) => {
      requireLive();
      const query = requirePhysicsRayQuery(value);
      const hit = raw.intersectRay(query, rayOutput);
      if (typeof hit === "number") {
        if (hit === 0) return undefined;
        if (hit !== 1)
          throw new Error("TN_NATIVE_PHYSICS_INVALID: ray query returned an invalid status");
        const bodyId = rayOutput[0];
        const position = {
          x: rayOutput[1] as number,
          y: rayOutput[2] as number,
          z: rayOutput[3] as number,
        };
        const normal = {
          x: rayOutput[4] as number,
          y: rayOutput[5] as number,
          z: rayOutput[6] as number,
        };
        const distance = rayOutput[7] as number;
        if (
          bodyId === undefined ||
          !Number.isSafeInteger(bodyId) ||
          bodyId < 0 ||
          distance === undefined
        )
          throw new Error("TN_NATIVE_PHYSICS_INVALID: ray output is malformed");
        const base = nativeHit({ bodyId, position });
        if (!Number.isFinite(distance) || distance < 0)
          throw new Error("TN_NATIVE_PHYSICS_INVALID: ray output distance is invalid");
        return { ...base, distance, normal: finiteQueryVector(normal, "ray output normal") };
      }
      if (hit === undefined || hit === null) return undefined;
      if (!Number.isFinite(hit.distance) || hit.distance < 0)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: ray query returned an invalid distance");
      const base = nativeHit({ bodyId: hit.bodyId, position: hit.position });
      return {
        ...base,
        distance: hit.distance,
        normal: finiteQueryVector(hit.normal, "ray hit normal"),
      };
    },
    intersectShape: (value) => {
      requireLive();
      const query = requirePhysicsShapeQuery(value);
      const hits = raw.intersectShape({
        collisionMask: query.collisionMask,
        maxResults: query.maxResults,
        position: query.position,
        rotation: query.rotation,
        shape: primitiveShape(query.shape),
      });
      if (!Array.isArray(hits) || hits.length > query.maxResults)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: malformed shape query result");
      return hits.map(nativeHit);
    },
    intersectPoint: (value) => {
      requireLive();
      const query = requirePhysicsPointQuery(value);
      const hits = raw.intersectPoint(query);
      if (!Array.isArray(hits) || hits.length > query.maxResults)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: malformed point query result");
      return hits.map(nativeHit);
    },
    readBodyTransform: (id) => {
      requireLive();
      refreshBodyTransforms();
      const offset = bodyTransformRows.get(id);
      // A body the backend did not report — removed, or filtered out of the visible set — is
      // absent rather than an error, the same answer the web adapter gives for an invalid body.
      if (offset === undefined) return undefined;
      return {
        position: {
          x: scalarAt(offset + 1),
          y: scalarAt(offset + 2),
          z: scalarAt(offset + 3),
        },
        rotation: {
          x: scalarAt(offset + 4),
          y: scalarAt(offset + 5),
          z: scalarAt(offset + 6),
          w: scalarAt(offset + 7),
        },
      };
    },
    readCharacterState: (id) => {
      requireLive();
      refreshCharacterState();
      return characterStatePresent.has(id) ? characterState.get(id) : undefined;
    },
    areaIntersections: (id) => {
      requireLive();
      refreshAreaIntersections();
      return areaIntersections.get(id) ?? emptyAreaIntersections;
    },
    drainCollisionEvents: (buffer) => {
      requireLive();
      requirePhysicsEventBuffer(buffer);
      return raw.drainCollisionEvents(buffer);
    },
    createVehicle: (options) => {
      requireLive();
      const requested = requirePhysicsVehicleCreateOptions(options);
      // The same fail-closed rule as the web adapter: a car on a fixed or missing chassis is a
      // car that cannot drive, and a silently motionless one reads as broken physics.
      if (!bodyIds.has(requested.bodyId))
        throw new Error(
          `TN_PHYSICS_UNKNOWN_BODY: createVehicle references an unknown body ${requested.bodyId}.`,
        );
      if (!dynamicBodies.has(requested.bodyId))
        throw new Error(
          `TN_PHYSICS_NOT_DYNAMIC: createVehicle needs a dynamic body; body ${requested.bodyId} is not dynamic.`,
        );
      if (raw.createVehicle === undefined)
        throw new Error("TN_NATIVE_PHYSICS_VEHICLE_MISSING: runtime ABI is too old");
      const wheelCount = requested.wheels.length;
      const id = raw.createVehicle({
        axle: requested.axle,
        bodyId: requested.bodyId,
        forwardAxis: requested.forwardAxis,
        wheels: flattenVehicleWheels(requested),
      });
      if (!Number.isSafeInteger(id) || id < 0)
        throw new Error("TN_NATIVE_PHYSICS_INVALID: runtime returned an invalid vehicle id");
      // The speed lands in slot 0 and the per-wheel records follow, so the native call writes
      // straight into the record the node reads — one buffer, no copy, reused every frame.
      const buffer = new Float32Array(1 + wheelCount * PHYSICS_VEHICLE_WHEEL_STRIDE);
      vehicles.set(id, {
        buffer,
        state: { speed: 0, wheels: buffer.subarray(1) },
      });
      vehicleBodies.set(id, requested.bodyId);
      return id;
    },
    setVehicleInput: (id, input) => {
      requireLive();
      if (raw.setVehicleInput === undefined)
        throw new Error("TN_NATIVE_PHYSICS_VEHICLE_MISSING: runtime ABI is too old");
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
      requireVehicle(id, "setVehicleInput");
      raw.setVehicleInput(id, input);
    },
    readVehicleState: (id) => {
      requireLive();
      if (raw.readVehicleState === undefined)
        throw new Error("TN_NATIVE_PHYSICS_VEHICLE_MISSING: runtime ABI is too old");
      const record = requireVehicle(id, "readVehicleState");
      const count = raw.readVehicleState(id, record.buffer);
      // The record is sized once from the wheel count, so the only honest answer is all of it.
      // A short write leaves the tail at whatever the previous frame left there and a longer one
      // means the ABI moved; either way the wheels the game reads would not be this car's.
      if (!Number.isSafeInteger(count) || count < 1)
        throw new Error("TN_VEHICLE_UNKNOWN: the vehicle left the backend.");
      if (count !== record.buffer.length)
        throw new Error(
          `TN_VEHICLE_STATE_SHORT: readVehicleState wrote ${count} of ${record.buffer.length} floats for vehicle ${id}.`,
        );
      record.state.speed = record.buffer[0] ?? 0;
      return record.state;
    },
    resetVehicle: (id, position, yaw) => {
      requireLive();
      if (raw.resetVehicle === undefined)
        throw new Error("TN_NATIVE_PHYSICS_VEHICLE_MISSING: runtime ABI is too old");
      requireVehicle(id, "resetVehicle");
      requireFiniteVector(position, "vehicle position");
      if (typeof yaw !== "number" || !Number.isFinite(yaw))
        throw new Error("TN_PHYSICS_NON_FINITE: vehicle yaw must be a finite number of radians.");
      raw.resetVehicle(id, position, yaw);
      // The chassis jumped, so the cached bulk transform read is stale.
      bodyTransformsDirty = true;
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      raw.dispose();
      bodyIds.clear();
      bodyTransformRows.clear();
      bodyHandles.clear();
      jointBodies.clear();
      vehicles.clear();
      vehicleBodies.clear();
      dynamicBodies.clear();
      characterIds.clear();
      characterState.clear();
      characterStatePresent.clear();
      areaIntersections.clear();
      characterStateDirty = false;
      areaIntersectionsDirty = false;
    },
  };
  return simulation;
}
