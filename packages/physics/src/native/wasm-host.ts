import type { INativePhysicsHost, INativeQueryHit, INativeSimulation } from "./host.js";

/**
 * The physics crate's standalone Wasm module (`packages/physics/wasm/`) as the native physics
 * host: a TypeScript port of `runtime-native/src/physics/native_bindings.cpp`, with the same
 * validation, messages and id rules, so web and the native player run one crate behind one seam.
 * Records are the crate's repr(C) layouts on wasm32 (bool = 1 byte, usize = 4 bytes). Every
 * record and scratch buffer lives in Wasm memory, allocated once per simulation and grown only
 * when too small, so a ray query is one export call and a pose read is one call plus one copy.
 */

const EXPORTS = [
  "tn_physics_add_body",
  "tn_physics_add_convex_hull_body",
  "tn_physics_add_heightfield_body",
  "tn_physics_add_trimesh_body",
  "tn_physics_alloc",
  "tn_physics_apply_body_force",
  "tn_physics_apply_body_force_at_point",
  "tn_physics_apply_body_impulse",
  "tn_physics_configure_character",
  "tn_physics_create",
  "tn_physics_create_joint",
  "tn_physics_create_vehicle",
  "tn_physics_destroy",
  "tn_physics_drain_collision_events",
  "tn_physics_free",
  "tn_physics_intersect_point",
  "tn_physics_intersect_ray",
  "tn_physics_intersect_shape",
  "tn_physics_read_area_intersections",
  "tn_physics_read_body_linear_velocity",
  "tn_physics_read_body_sleep_states",
  "tn_physics_read_character_states",
  "tn_physics_read_contacts",
  "tn_physics_read_vehicle_state",
  "tn_physics_read_visible_transforms",
  "tn_physics_remove_body",
  "tn_physics_remove_joint",
  "tn_physics_reset_vehicle",
  "tn_physics_set_body_linear_velocity",
  "tn_physics_set_body_transform",
  "tn_physics_set_heightfield_shape",
  "tn_physics_set_vehicle_input",
  "tn_physics_set_vehicle_wheel_friction",
  "tn_physics_step",
  "tn_physics_version",
] as const;

type WasmFunction = (...args: number[]) => number;
type PhysicsWasm = { readonly memory: WebAssembly.Memory } & {
  readonly [Name in (typeof EXPORTS)[number]]: WasmFunction;
};
type BulkRead =
  | "tn_physics_drain_collision_events"
  | "tn_physics_read_area_intersections"
  | "tn_physics_read_body_sleep_states"
  | "tn_physics_read_character_states"
  | "tn_physics_read_visible_transforms";
type Actuation =
  | "tn_physics_apply_body_force"
  | "tn_physics_apply_body_impulse"
  | "tn_physics_set_body_linear_velocity";
type Fields = Record<string, unknown>;

const MAX_EXACT_FLOAT_ID = 16_777_215;
const F32_MAX = 3.4028234663852886e38;
const ACTUATION_OK = 1;
/** One record block per simulation: every options record fits in 96 bytes; the ray hit sits at 32. */
const RECORD_BYTES = 128;
const RAY_HIT = 32;
const QUERY_HIT_BYTES = 16;
const WHEEL_WIDTH = 12;
/** Thrown by the parsers and turned into the calling method's message, like a C++ `false`. */
const INVALID = Symbol("invalid");

interface IScratch {
  ptr: number;
  bytes: number;
}

function fields(value: unknown): Fields {
  if (typeof value !== "object" || value === null) throw INVALID;
  return value as Fields;
}

function finite(object: Fields, name: string): number {
  const value = object[name];
  if (typeof value !== "number" || !(value >= -F32_MAX && value <= F32_MAX)) throw INVALID;
  return value;
}

function optionalFinite(object: Fields, name: string, fallback: number): number {
  return object[name] === undefined ? fallback : finite(object, name);
}

function group(object: Fields, name: string, fallback: number): number {
  const value = object[name];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
    throw INVALID;
  return value;
}

function flag(object: Fields, name: string, fallback: boolean): boolean {
  const value = object[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw INVALID;
  return value;
}

function bodyId(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_EXACT_FLOAT_ID
  )
    throw INVALID;
  return value;
}

function maxResults(object: Fields): number {
  const value = object.maxResults;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 0xffffffff)
    throw INVALID;
  return value;
}

function gridCount(object: Fields, name: string): number {
  const value = Math.fround(finite(object, name));
  if (value < 2 || value > 65536 || !Number.isInteger(value)) throw INVALID;
  return value;
}

function fail(error: unknown, message: string): unknown {
  return error === INVALID ? new Error(message) : error;
}

function actuationError(status: number): Error {
  if (status === 0)
    return new Error("TN_PHYSICS_UNKNOWN_BODY: actuation references an unknown body.");
  if (status === -1) return new Error("TN_PHYSICS_NOT_DYNAMIC: actuation needs a dynamic body.");
  if (status === -2) return new Error("TN_PHYSICS_NON_FINITE: actuation vector must be finite.");
  return new Error("TN_NATIVE_PHYSICS_INVALID: actuation was rejected.");
}

export function createWasmPhysicsHost(exports: WebAssembly.Exports): INativePhysicsHost {
  if (
    !(exports.memory instanceof WebAssembly.Memory) ||
    EXPORTS.some((name) => typeof exports[name] !== "function")
  )
    throw new Error("TN_NATIVE_PHYSICS_MISSING: Wasm module does not export the physics ABI");
  const wasm = exports as PhysicsWasm;
  // Any export that allocates can grow memory and detach the old buffer, so every read or write
  // of memory goes through these views after `views()` has checked the buffer's identity.
  let buffer: ArrayBuffer | undefined;
  let f32 = new Float32Array(0);
  let u32 = new Uint32Array(0);
  let u8 = new Uint8Array(0);
  const views = () => {
    if (wasm.memory.buffer === buffer) return;
    buffer = wasm.memory.buffer;
    f32 = new Float32Array(buffer);
    u32 = new Uint32Array(buffer);
    u8 = new Uint8Array(buffer);
  };
  const alloc = (bytes: number): number => {
    const pointer = wasm.tn_physics_alloc(bytes) >>> 0;
    if (pointer === 0) throw new Error("TN_NATIVE_PHYSICS_INVALID: Wasm physics allocation failed");
    return pointer;
  };
  const versionPointer = wasm.tn_physics_version() >>> 0;
  views();
  const version = new TextDecoder().decode(
    u8.subarray(versionPointer, u8.indexOf(0, versionPointer)),
  );

  const writeVector = (object: Fields, name: string, index: number) => {
    const vector = fields(object[name]);
    f32[index] = finite(vector, "x");
    f32[index + 1] = finite(vector, "y");
    f32[index + 2] = finite(vector, "z");
  };
  const writeQuaternion = (object: Fields, name: string, index: number) => {
    const quaternion = fields(object[name]);
    f32[index] = finite(quaternion, "x");
    f32[index + 1] = finite(quaternion, "y");
    f32[index + 2] = finite(quaternion, "z");
    f32[index + 3] = finite(quaternion, "w");
  };
  const readGravity = (options: Fields, index: number) => {
    const gravity = options.gravity;
    if (gravity === undefined) return;
    if (typeof gravity === "number") {
      if (!Number.isFinite(gravity)) throw INVALID;
      f32[index + 1] = gravity;
      return;
    }
    if (Array.isArray(gravity)) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = gravity[axis];
        if (typeof value !== "number" || !Number.isFinite(Math.fround(value))) throw INVALID;
        f32[index + axis] = value;
      }
      return;
    }
    const vector = fields(gravity);
    f32[index] = finite(vector, "x");
    f32[index + 1] = finite(vector, "y");
    f32[index + 2] = finite(vector, "z");
  };

  const createSimulation = (options?: unknown): INativeSimulation => {
    const record = alloc(RECORD_BYTES);
    views();
    const r = record >>> 2;
    f32[r] = 0;
    f32[r + 1] = -9.81;
    f32[r + 2] = 0;
    try {
      if (options !== undefined) readGravity(fields(options), r);
    } catch (error) {
      wasm.tn_physics_free(record, RECORD_BYTES);
      throw fail(error, "physics options contain invalid gravity");
    }
    let simulation = wasm.tn_physics_create(record) >>> 0;
    if (simulation === 0) {
      wasm.tn_physics_free(record, RECORD_BYTES);
      throw new Error("Rapier simulation creation failed");
    }
    let nextId = 0;
    let nextJointId = 0;
    let nextVehicleId = 0;
    const first: IScratch = { bytes: 0, ptr: 0 };
    const second: IScratch = { bytes: 0, ptr: 0 };
    const ensure = (scratch: IScratch, bytes: number): number => {
      if (scratch.bytes >= bytes) return scratch.ptr;
      const size = Math.max(64, bytes, scratch.bytes * 2);
      if (scratch.bytes > 0) wasm.tn_physics_free(scratch.ptr, scratch.bytes);
      scratch.ptr = 0;
      scratch.bytes = 0;
      scratch.ptr = alloc(size);
      scratch.bytes = size;
      return scratch.ptr;
    };
    const live = () => {
      if (simulation === 0) throw new Error("physics simulation is disposed");
    };
    const copyIn = (scratch: IScratch, values: Float32Array | Uint32Array): number => {
      const pointer = ensure(scratch, Math.max(4, values.byteLength));
      views();
      (values instanceof Float32Array ? f32 : u32).set(values, pointer >>> 2);
      return pointer;
    };
    const bulkRead = (
      name: BulkRead,
      output: unknown,
      float: boolean,
      width: number,
      method: string,
      label: string,
    ): number => {
      live();
      if (!(float ? output instanceof Float32Array : output instanceof Uint32Array))
        throw new Error(`${method} requires a ${float ? "Float32Array" : "Uint32Array"}`);
      const target = output as Float32Array | Uint32Array;
      const pointer = ensure(first, Math.max(4, target.byteLength));
      const count = wasm[name](simulation, pointer, target.length);
      if (count < 0) throw new Error(`${label} buffer is too small`);
      views();
      const start = pointer >>> 2;
      target.set((float ? f32 : u32).subarray(start, start + count * width));
      return count;
    };
    const queryHits = (pointer: number, count: number): INativeQueryHit[] => {
      views();
      const hits: INativeQueryHit[] = [];
      for (let index = 0; index < count; index += 1) {
        const h = (pointer >>> 2) + index * (QUERY_HIT_BYTES / 4);
        hits.push({
          bodyId: u32[h] as number,
          position: { x: f32[h + 1] as number, y: f32[h + 2] as number, z: f32[h + 3] as number },
        });
      }
      return hits;
    };
    const actuate = (name: Actuation, args: readonly unknown[], message: string) => {
      live();
      try {
        const id = bodyId(args[0]);
        const vector = fields(args[1]);
        const status = wasm[name](
          simulation,
          id,
          finite(vector, "x"),
          finite(vector, "y"),
          finite(vector, "z"),
        );
        if (status !== ACTUATION_OK) throw actuationError(status);
      } catch (error) {
        throw fail(error, message);
      }
    };

    const host: INativeSimulation = {
      createBody(options) {
        live();
        if (options === undefined || nextId > MAX_EXACT_FLOAT_ID)
          throw new Error("createBody requires options and an available id");
        let added: number;
        try {
          views();
          const value = fields(options);
          const r = record >>> 2;
          const bodyType = ["dynamic", "fixed", "kinematic", "character"].indexOf(
            value.type as string,
          );
          const shape = fields(value.shape);
          const shapeType = [
            "box",
            "sphere",
            "capsule",
            "trimesh",
            "heightfield",
            "convexHull",
          ].indexOf(shape.kind as string);
          if (typeof value.type !== "string" || bodyType < 0) throw INVALID;
          if (typeof shape.kind !== "string" || shapeType < 0) throw INVALID;
          u32[r] = nextId;
          u32[r + 1] = bodyType;
          u32[r + 2] = shapeType;
          writeVector(value, "position", r + 3);
          writeQuaternion(value, "rotation", r + 6);
          f32[r + 10] = finite(shape, "x");
          f32[r + 11] = optionalFinite(shape, "y", 0);
          f32[r + 12] = optionalFinite(shape, "z", 0);
          f32[r + 13] = optionalFinite(value, "mass", 0);
          u32[r + 14] = group(value, "collisionLayer", 1);
          u32[r + 15] = group(value, "collisionMask", 0xffff);
          u8[record + 64] = flag(value, "sensor", false) ? 1 : 0;
          u8[record + 65] = flag(value, "continuousCollision", true) ? 1 : 0;
          if (shapeType === 3) {
            const { vertices, indices } = shape;
            if (!(vertices instanceof Float32Array) || !(indices instanceof Uint32Array))
              throw INVALID;
            const vertexPointer = copyIn(first, vertices);
            const indexPointer = copyIn(second, indices);
            added = wasm.tn_physics_add_trimesh_body(
              simulation,
              record,
              vertexPointer,
              vertices.length,
              indexPointer,
              indices.length,
            );
          } else if (shapeType === 4) {
            const heights = shape.heights;
            if (!(heights instanceof Float32Array)) throw INVALID;
            const rows = gridCount(shape, "rows");
            const columns = gridCount(shape, "columns");
            const scale = fields(shape.scale);
            const sx = finite(scale, "x");
            const sy = finite(scale, "y");
            const sz = finite(scale, "z");
            added = wasm.tn_physics_add_heightfield_body(
              simulation,
              record,
              copyIn(first, heights),
              heights.length,
              rows,
              columns,
              sx,
              sy,
              sz,
            );
          } else if (shapeType === 5) {
            const { vertices } = shape;
            if (!(vertices instanceof Float32Array)) throw INVALID;
            added = wasm.tn_physics_add_convex_hull_body(
              simulation,
              record,
              copyIn(first, vertices),
              vertices.length,
            );
          } else added = wasm.tn_physics_add_body(simulation, record);
        } catch (error) {
          throw fail(error, "physics body options are invalid");
        }
        if (added === 0) throw new Error("physics body options are invalid");
        const id = nextId;
        nextId += 1;
        return id;
      },
      createJoint(options) {
        live();
        if (options === undefined || nextJointId > MAX_EXACT_FLOAT_ID)
          throw new Error("createJoint requires options and an available id");
        try {
          views();
          const value = fields(options);
          const r = record >>> 2;
          u8.fill(0, record, record + 96);
          const jointType = ["pin", "hinge", "fixed"].indexOf(value.type as string);
          if (typeof value.type !== "string" || jointType < 0) throw INVALID;
          u32[r] = nextJointId;
          u32[r + 1] = jointType;
          u32[r + 2] = bodyId(value.bodyA);
          u32[r + 3] = bodyId(value.bodyB);
          writeVector(value, "anchorA", r + 4);
          writeVector(value, "anchorB", r + 7);
          f32[r + 10] = 1;
          if (value.axis !== undefined) writeVector(value, "axis", r + 10);
          if (value.limit !== undefined) {
            if (jointType !== 1) throw INVALID;
            const limit = fields(value.limit);
            f32[r + 14] = finite(limit, "lower");
            f32[r + 15] = finite(limit, "upper");
            u8[record + 52] = 1;
          }
          if (jointType !== 2 && (value.frameA !== undefined || value.frameB !== undefined))
            throw INVALID;
          f32[r + 19] = 1;
          f32[r + 23] = 1;
          if (value.frameA !== undefined) writeQuaternion(value, "frameA", r + 16);
          if (value.frameB !== undefined) writeQuaternion(value, "frameB", r + 20);
        } catch (error) {
          throw fail(error, "physics joint options are invalid");
        }
        const result = wasm.tn_physics_create_joint(simulation, record);
        if (result < 0) throw new Error("physics joint options were rejected");
        nextJointId += 1;
        return result;
      },
      removeBody(id) {
        live();
        if (typeof id !== "number") throw new Error("removeBody requires a numeric id");
        try {
          wasm.tn_physics_remove_body(simulation, bodyId(id));
        } catch (error) {
          throw fail(error, "removeBody received an invalid id");
        }
      },
      removeJoint(id) {
        live();
        try {
          wasm.tn_physics_remove_joint(simulation, bodyId(id));
        } catch (error) {
          throw fail(error, "removeJoint received an invalid id");
        }
      },
      configureCharacter(id, options) {
        live();
        if (typeof id !== "number" || options === undefined)
          throw new Error("configureCharacter requires an id and options");
        try {
          bodyId(id);
        } catch (error) {
          throw fail(error, "configureCharacter received an invalid id");
        }
        let configured: number;
        try {
          views();
          const value = fields(options);
          const r = record >>> 2;
          u8.fill(0, record, record + 40);
          u32[r] = id;
          f32[r + 1] = finite(value, "offset");
          f32[r + 2] = finite(value, "maxSlopeClimbAngle");
          u32[r + 8] = group(value, "oneWayLayers", 0);
          if (value.autostep !== undefined) {
            const autostep = fields(value.autostep);
            f32[r + 4] = finite(autostep, "maxHeight");
            f32[r + 5] = finite(autostep, "minWidth");
            if (typeof autostep.includeDynamicBodies !== "boolean") throw INVALID;
            u8[record + 12] = 1;
            u8[record + 24] = autostep.includeDynamicBodies ? 1 : 0;
          }
          const snap = value.snapToGround;
          if (snap !== undefined) {
            if (typeof snap !== "number" || !Number.isFinite(snap)) throw INVALID;
            u8[record + 25] = 1;
            f32[r + 7] = snap;
          }
          u8[record + 36] = flag(value, "pushesDynamicBodies", false) ? 1 : 0;
          configured = wasm.tn_physics_configure_character(simulation, record);
        } catch (error) {
          throw fail(error, "character controller options are invalid");
        }
        if (configured === 0) throw new Error("character controller options are invalid");
      },
      createVehicle(options) {
        live();
        if (options === undefined || nextVehicleId > MAX_EXACT_FLOAT_ID)
          throw new Error("createVehicle requires options and an available id");
        let id: number;
        try {
          const value = fields(options);
          const chassis = bodyId(value.bodyId);
          const axle = fields(value.axle);
          const ax = finite(axle, "x");
          const ay = finite(axle, "y");
          const az = finite(axle, "z");
          const axis = value.forwardAxis;
          if (axis !== 0 && axis !== 2) throw INVALID;
          const wheels = value.wheels;
          if (!(wheels instanceof Float32Array) || wheels.length < WHEEL_WIDTH) throw INVALID;
          const wheelPointer = copyIn(first, wheels);
          const r = record >>> 2;
          u32[r] = nextVehicleId;
          u32[r + 1] = chassis;
          u32[r + 2] = axis;
          f32[r + 3] = ax;
          f32[r + 4] = ay;
          f32[r + 5] = az;
          u32[r + 6] = Math.floor(wheels.length / WHEEL_WIDTH);
          id = wasm.tn_physics_create_vehicle(simulation, record, wheelPointer);
        } catch (error) {
          throw fail(error, "vehicle options are invalid");
        }
        if (id < 0)
          throw new Error(
            "TN_VEHICLE_INVALID: the chassis is missing, is not dynamic, or the wheels are malformed.",
          );
        nextVehicleId += 1;
        return id;
      },
      setVehicleInput(id, input) {
        live();
        let applied: number;
        try {
          const value = fields(input);
          applied = wasm.tn_physics_set_vehicle_input(
            simulation,
            bodyId(id),
            finite(value, "engineForce"),
            finite(value, "brake"),
            finite(value, "steering"),
          );
        } catch (error) {
          throw fail(
            error,
            "TN_PHYSICS_NON_FINITE: vehicle input needs a finite engineForce, brake and steering.",
          );
        }
        if (applied === 0) throw new Error("TN_VEHICLE_UNKNOWN: the vehicle left the backend.");
      },
      setVehicleWheelFriction(id, wheel, frictionSlip) {
        live();
        try {
          bodyId(id);
        } catch (error) {
          throw fail(error, "setVehicleWheelFriction requires an id, a wheel and a friction slip");
        }
        if (typeof wheel !== "number" || typeof frictionSlip !== "number")
          throw new Error("setVehicleWheelFriction requires an id, a wheel and a friction slip");
        if (!Number.isInteger(wheel) || wheel < 0 || wheel > 0xffffffff)
          throw new Error("TN_VEHICLE_INVALID: the wheel index is not a whole number.");
        if (wasm.tn_physics_set_vehicle_wheel_friction(simulation, id, wheel, frictionSlip) === 0)
          throw new Error(
            "TN_VEHICLE_UNKNOWN: the vehicle or wheel left the backend, or the friction slip is not finite and non-negative.",
          );
      },
      readVehicleState(id, output) {
        live();
        try {
          bodyId(id);
        } catch (error) {
          throw fail(error, "readVehicleState requires an id and a Float32Array");
        }
        if (!(output instanceof Float32Array))
          throw new Error("readVehicleState requires an id and a Float32Array");
        const pointer = ensure(first, Math.max(4, output.byteLength));
        const count = wasm.tn_physics_read_vehicle_state(simulation, id, pointer, output.length);
        if (count < 0)
          throw new Error(
            "TN_VEHICLE_UNKNOWN: the vehicle left the backend or the buffer is too small.",
          );
        views();
        output.set(f32.subarray(pointer >>> 2, (pointer >>> 2) + count));
        return count;
      },
      resetVehicle(id, position, yaw) {
        live();
        let reset: number;
        try {
          const value = fields(position);
          if (typeof yaw !== "number" || !(yaw >= -F32_MAX && yaw <= F32_MAX)) throw INVALID;
          reset = wasm.tn_physics_reset_vehicle(
            simulation,
            bodyId(id),
            finite(value, "x"),
            finite(value, "y"),
            finite(value, "z"),
            yaw,
          );
        } catch (error) {
          throw fail(error, "TN_PHYSICS_NON_FINITE: a respawn needs a finite position and yaw.");
        }
        if (reset === 0) throw new Error("TN_VEHICLE_UNKNOWN: the vehicle left the backend.");
      },
      setBodyTransform(id, position) {
        live();
        if (typeof id !== "number" || !Number.isFinite(id) || position === undefined)
          throw new Error("setBodyTransform requires an id and position");
        if (id < 0 || id > MAX_EXACT_FLOAT_ID || !Number.isInteger(id))
          throw new Error("setBodyTransform received an invalid id");
        let moved: number;
        try {
          const value = fields(position);
          moved = wasm.tn_physics_set_body_transform(
            simulation,
            id,
            finite(value, "x"),
            finite(value, "y"),
            finite(value, "z"),
          );
        } catch (error) {
          throw fail(error, "setBodyTransform received an invalid position");
        }
        if (moved === 0) throw new Error("setBodyTransform received an unknown id");
      },
      applyBodyImpulse(id, impulse) {
        actuate(
          "tn_physics_apply_body_impulse",
          [id, impulse],
          "TN_PHYSICS_NON_FINITE: impulse must be a finite { x, y, z }.",
        );
      },
      applyBodyForce(id, force) {
        actuate(
          "tn_physics_apply_body_force",
          [id, force],
          "TN_PHYSICS_NON_FINITE: force must be a finite { x, y, z }.",
        );
      },
      setBodyLinearVelocity(id, velocity) {
        actuate(
          "tn_physics_set_body_linear_velocity",
          [id, velocity],
          "TN_PHYSICS_NON_FINITE: velocity must be a finite { x, y, z }.",
        );
      },
      applyBodyForceAtPoint(id, force, point) {
        live();
        try {
          const f = fields(force);
          const p = fields(point);
          const status = wasm.tn_physics_apply_body_force_at_point(
            simulation,
            bodyId(id),
            finite(f, "x"),
            finite(f, "y"),
            finite(f, "z"),
            finite(p, "x"),
            finite(p, "y"),
            finite(p, "z"),
          );
          if (status !== ACTUATION_OK) throw actuationError(status);
        } catch (error) {
          throw fail(
            error,
            "TN_PHYSICS_NON_FINITE: force and point must be finite { x, y, z } values.",
          );
        }
      },
      readBodyLinearVelocity(id) {
        live();
        try {
          bodyId(id);
        } catch (error) {
          throw fail(error, "readBodyLinearVelocity received an invalid id");
        }
        const status = wasm.tn_physics_read_body_linear_velocity(simulation, id, record);
        if (status !== ACTUATION_OK) throw actuationError(status);
        views();
        const r = record >>> 2;
        return { x: f32[r] as number, y: f32[r + 1] as number, z: f32[r + 2] as number };
      },
      step(deltaTime, inputSnapshot) {
        live();
        if (typeof deltaTime !== "number") throw new Error("step requires a numeric deltaTime");
        let input = 0;
        let count = 0;
        if (inputSnapshot !== undefined) {
          if (typeof inputSnapshot !== "object" || inputSnapshot === null)
            throw new Error("physics input snapshot must be an object");
          const { kinematicCount, kinematicTransforms } = inputSnapshot;
          if (typeof kinematicCount !== "number" || !(kinematicTransforms instanceof Float32Array))
            throw new Error("physics input snapshot is malformed");
          if (
            !Number.isInteger(kinematicCount) ||
            kinematicCount < 0 ||
            kinematicCount > Math.floor(kinematicTransforms.length / 8)
          )
            throw new Error("physics input snapshot has an invalid count");
          count = kinematicCount;
          if (count > 0) input = copyIn(first, kinematicTransforms.subarray(0, count * 8));
        }
        if (
          !Number.isFinite(deltaTime) ||
          deltaTime <= 0 ||
          wasm.tn_physics_step(simulation, deltaTime, input, count) === 0
        )
          throw new Error("physics step rejected its deltaTime or input");
      },
      readVisibleTransforms(output) {
        return bulkRead(
          "tn_physics_read_visible_transforms",
          output,
          true,
          8,
          "readVisibleTransforms",
          "transform",
        );
      },
      readCharacterStates(output) {
        return bulkRead(
          "tn_physics_read_character_states",
          output,
          true,
          6,
          "readCharacterStates",
          "character state",
        );
      },
      readBodySleepStates(output) {
        return bulkRead(
          "tn_physics_read_body_sleep_states",
          output,
          true,
          2,
          "readBodySleepStates",
          "sleep state",
        );
      },
      readAreaIntersections(output) {
        return bulkRead(
          "tn_physics_read_area_intersections",
          output,
          false,
          2,
          "readAreaIntersections",
          "area intersection",
        );
      },
      drainCollisionEvents(output) {
        return bulkRead(
          "tn_physics_drain_collision_events",
          output,
          false,
          4,
          "drainCollisionEvents",
          "collision event",
        );
      },
      readContacts(target, candidates, output) {
        live();
        try {
          bodyId(target);
          if (!(candidates instanceof Uint32Array) || !(output instanceof Float32Array))
            throw INVALID;
        } catch (error) {
          throw fail(error, "readContacts requires a body id, a Uint32Array and a Float32Array");
        }
        const candidatePointer = copyIn(second, candidates);
        const outputPointer = ensure(first, Math.max(4, output.byteLength));
        const count = wasm.tn_physics_read_contacts(
          simulation,
          target,
          candidatePointer,
          candidates.length,
          outputPointer,
          output.length,
        );
        if (count < 0) throw new Error("readContacts target is not a live body");
        views();
        const written = Math.min(count, Math.floor(output.length / 8)) * 8;
        output.set(f32.subarray(outputPointer >>> 2, (outputPointer >>> 2) + written));
        return count;
      },
      setColliderShape(id, shape) {
        live();
        try {
          bodyId(id);
          fields(shape);
        } catch (error) {
          throw fail(error, "setColliderShape requires a body id and a shape");
        }
        if (typeof shape.kind !== "string")
          throw new Error("setColliderShape requires a shape kind");
        if (shape.kind !== "heightfield")
          throw new Error("setColliderShape supports heightfield shapes");
        try {
          const value = fields(shape);
          const heights = value.heights;
          if (!(heights instanceof Float32Array)) throw INVALID;
          const rows = gridCount(value, "rows");
          const columns = gridCount(value, "columns");
          const scale = fields(value.scale);
          const sx = finite(scale, "x");
          const sy = finite(scale, "y");
          const sz = finite(scale, "z");
          const pointer = copyIn(first, heights);
          if (
            wasm.tn_physics_set_heightfield_shape(
              simulation,
              id,
              pointer,
              heights.length,
              rows,
              columns,
              sx,
              sy,
              sz,
            ) === 0
          )
            throw INVALID;
        } catch (error) {
          throw fail(error, "setColliderShape shape was rejected");
        }
      },
      // The hot query: one export call, no object, records written in place.
      intersectRay(query, output) {
        live();
        if (output === undefined) throw new Error("intersectRay requires query options and output");
        if (!(output instanceof Float32Array))
          throw new Error("intersectRay requires a Float32Array output");
        if (output.length < 8) throw new Error("intersectRay output buffer is too small");
        const r = record >>> 2;
        try {
          views();
          const value = fields(query);
          writeVector(value, "from", r);
          writeVector(value, "to", r + 3);
          u32[r + 6] = group(value, "collisionMask", 0xffff);
          u32[r + 7] = flag(value, "hitFromInside", false) ? 1 : 0;
          if (f32[r] === f32[r + 3] && f32[r + 1] === f32[r + 4] && f32[r + 2] === f32[r + 5])
            throw INVALID;
        } catch (error) {
          throw fail(error, "intersectRay query options are invalid");
        }
        const status = wasm.tn_physics_intersect_ray(simulation, record, record + RAY_HIT);
        if (status < 0)
          throw new Error("intersectRay query arithmetic is invalid or unrepresentable");
        if (status === 0) return 0;
        if (status !== 1) throw new Error("intersectRay returned an invalid status");
        views();
        const h = r + RAY_HIT / 4;
        output[0] = u32[h] as number;
        for (let index = 1; index < 8; index += 1) output[index] = f32[h + index] as number;
        return 1;
      },
      intersectShape(query) {
        live();
        if (query === undefined) throw new Error("intersectShape requires query options");
        let pointer: number;
        let limit: number;
        try {
          const value = fields(query);
          const shape = fields(value.shape);
          const shapeType = ["box", "sphere", "capsule"].indexOf(shape.kind as string);
          if (typeof shape.kind !== "string" || shapeType < 0) throw INVALID;
          limit = maxResults(value);
          pointer = ensure(first, limit * QUERY_HIT_BYTES);
          views();
          const r = record >>> 2;
          u32[r] = shapeType;
          f32[r + 1] = finite(shape, "x");
          f32[r + 2] = finite(shape, "y");
          f32[r + 3] = finite(shape, "z");
          writeVector(value, "position", r + 4);
          writeQuaternion(value, "rotation", r + 7);
          u32[r + 11] = group(value, "collisionMask", 0xffff);
          u32[r + 12] = limit;
        } catch (error) {
          throw fail(error, "intersectShape query options are invalid");
        }
        const count = wasm.tn_physics_intersect_shape(simulation, record, pointer, limit);
        if (count < 0) throw new Error("intersectShape query was rejected");
        return queryHits(pointer, count);
      },
      intersectPoint(query) {
        live();
        if (query === undefined) throw new Error("intersectPoint requires query options");
        let count: number;
        let pointer: number;
        try {
          const value = fields(query);
          const position = fields(value.position);
          const x = finite(position, "x");
          const y = finite(position, "y");
          const z = finite(position, "z");
          const mask = group(value, "collisionMask", 0xffff);
          const limit = maxResults(value);
          pointer = ensure(first, limit * QUERY_HIT_BYTES);
          count = wasm.tn_physics_intersect_point(simulation, x, y, z, mask, limit, pointer, limit);
        } catch (error) {
          throw fail(error, "intersectPoint query options are invalid");
        }
        if (count < 0) throw new Error("intersectPoint query was rejected");
        return queryHits(pointer, count);
      },
      dispose() {
        if (simulation === 0) return;
        wasm.tn_physics_destroy(simulation);
        simulation = 0;
        for (const scratch of [first, second]) {
          if (scratch.bytes > 0) wasm.tn_physics_free(scratch.ptr, scratch.bytes);
          scratch.bytes = 0;
          scratch.ptr = 0;
        }
        wasm.tn_physics_free(record, RECORD_BYTES);
      },
    };
    return host;
  };

  return { createSimulation, version };
}
