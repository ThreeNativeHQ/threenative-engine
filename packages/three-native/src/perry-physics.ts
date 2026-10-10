/** Perry's native resident over the same Rapier C ABI as the V8 host. */
import { alloc, free, physicsCall, physicsCopy, physicsVersion } from "tn-native-transport";
import type {
  INativeBodyOptions,
  INativePhysicsHost,
  INativeShapeDescriptor,
  INativeSimulation,
} from "../../physics/src/native/host.js";

type Buffer = Float32Array | Uint32Array;
const MAX_ID = 16_777_215;
function invalid(what: string): never {
  throw new Error(`TN_PERRY_PHYSICS_INVALID: ${what}`);
}
function scalar(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38)
    invalid("expected a finite float32");
  return value;
}
function integer(value: number, maximum = 0xffff_ffff): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) invalid("invalid integer");
  return value;
}
function flag(value: boolean): number {
  if (typeof value !== "boolean") invalid("expected a boolean");
  return value ? 1 : 0;
}
function vector(value: { readonly x: number; readonly y: number; readonly z: number }): number[] {
  return [scalar(value.x), scalar(value.y), scalar(value.z)];
}
function rotation(value: {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}): number[] {
  return [...vector(value), scalar(value.w)];
}
function shapeKind(shape: INativeShapeDescriptor): number {
  switch (shape.kind) {
    case "box":
      return 0;
    case "sphere":
      return 1;
    case "capsule":
      return 2;
    case "trimesh":
      return 3;
    case "heightfield":
      return 4;
    default:
      return invalid("unknown shape");
  }
}
function bodyKind(body: INativeBodyOptions): number {
  switch (body.type) {
    case "dynamic":
      return 0;
    case "fixed":
      return 1;
    case "kinematic":
      return 2;
    case "character":
      return 3;
    default:
      return invalid("unknown body type");
  }
}
function heightfield(shape: INativeShapeDescriptor): [Float32Array, number[]] {
  const { heights, rows, columns, scale } = shape;
  if (!(heights instanceof Float32Array) || rows === undefined || columns === undefined || !scale)
    invalid("heightfield needs samples, grid and scale");
  integer(rows, 65536);
  integer(columns, 65536);
  if (rows < 2 || columns < 2 || heights.length !== rows * columns) invalid("heightfield grid");
  return [heights, [rows, columns, ...vector(scale)]];
}

export function createPerryPhysicsHost(): INativePhysicsHost {
  return {
    version: physicsVersion(),
    createSimulation(options?: unknown): INativeSimulation {
      let gravity = [0, -9.81, 0];
      if (options !== undefined) {
        if (typeof options !== "object" || options === null) invalid("simulation options");
        const requested = (
          options as { gravity?: number | number[] | { x: number; y: number; z: number } }
        ).gravity;
        if (typeof requested === "number") gravity = [0, scalar(requested), 0];
        else if (Array.isArray(requested)) {
          if (requested.length !== 3) invalid("gravity needs three values");
          gravity = requested.map(scalar);
        } else if (requested !== undefined) gravity = vector(requested);
      }
      const packet = alloc(32 * 8);
      if (!packet) throw new Error("TN_PERRY_PHYSICS_OUT_OF_MEMORY");
      const fields = new Float64Array(32);
      const pointers = [0, 0, 0];
      const sizes = [0, 0, 0];
      let world = 0;
      let nextBody = 0;
      let disposed = false;
      const reserve = (slot: number, bytes: number): number => {
        if (bytes > (sizes[slot] ?? 0)) {
          const pointer = alloc(bytes);
          if (!pointer) throw new Error("TN_PERRY_PHYSICS_OUT_OF_MEMORY");
          free(pointers[slot] ?? 0);
          pointers[slot] = pointer;
          sizes[slot] = bytes;
        }
        return pointers[slot] ?? 0;
      };
      const writeBuffer = (slot: number, values: Buffer, count = values.length): number => {
        if (!(values instanceof Float32Array) && !(values instanceof Uint32Array))
          invalid("typed buffer");
        const pointer = reserve(slot, count * 4);
        for (let i = 0; i < count; i++) scalar(values[i] as number);
        if (physicsCopy(values, pointer, count, values instanceof Uint32Array ? 5 : 6, true))
          invalid("input transfer");
        return pointer;
      };
      const invoke = (
        op: number,
        values: number[],
        input?: Buffer,
        count = input?.length ?? 0,
        output?: Buffer,
        auxiliary?: Buffer,
      ): number => {
        if (disposed) throw new Error("TN_PERRY_PHYSICS_DISPOSED");
        if (values.length > 32) invalid("packet overflow");
        for (let i = 0; i < values.length; i++) fields[i] = scalar(values[i] as number);
        if (physicsCopy(fields, packet, 32, 7, true)) invalid("packet transfer");
        if (
          (output !== undefined || (op >= 5 && op <= 9) || op === 20) &&
          (op === 8 || op === 9
            ? !(output instanceof Uint32Array)
            : !(output instanceof Float32Array))
        )
          invalid("output buffer type");
        if (op === 20 && !(input instanceof Uint32Array)) invalid("contact candidates");
        const inputPointer = input ? writeBuffer(0, input, op === 4 ? count * 8 : count) : 0;
        const auxiliaryPointer = auxiliary ? writeBuffer(2, auxiliary) : 0;
        const outputPointer = output ? reserve(1, output.length * 4) : 0;
        const result = physicsCall(
          op,
          world,
          packet,
          inputPointer,
          count,
          outputPointer,
          output?.length ?? 0,
          auxiliaryPointer,
          auxiliary?.length ?? 0,
        );
        if (result < 0 && op >= 5 && op <= 9)
          throw new Error(`TN_PERRY_PHYSICS_BUFFER_TOO_SMALL: operation ${op} buffer is too small`);
        if (result < 0 && (op < 15 || op > 19))
          throw new Error(`TN_PERRY_PHYSICS_REJECTED: operation ${op}, status ${result}`);
        // Never copy a stale tail: contact counts may exceed capacity, other reads return records.
        if (output) {
          const stride =
            op === 5 || op === 20
              ? 8
              : op === 6 || op === 8
                ? 2
                : op === 7
                  ? 6
                  : op === 9 || op === 12 || op === 13
                    ? 4
                    : op === 11
                      ? 8
                      : 3;
          const length =
            op === 18
              ? result === 1
                ? 3
                : 0
              : Math.min(Math.floor(output.length / stride) * stride, result * stride);
          if (
            physicsCopy(output, outputPointer, length, output instanceof Uint32Array ? 5 : 6, false)
          )
            invalid("output transfer");
        }
        return result;
      };
      const accepted = (
        op: number,
        values: number[],
        input?: Buffer,
        count?: number,
        auxiliary?: Buffer,
      ) => {
        if (invoke(op, values, input, count, undefined, auxiliary) !== 1)
          throw new Error(`TN_PERRY_PHYSICS_REJECTED: operation ${op}`);
      };
      const actuate = (op: number, values: number[], output?: Float32Array) => {
        const status = invoke(op, values, undefined, 0, output);
        if (status !== 1) {
          const name =
            status === 0
              ? "UNKNOWN_BODY"
              : status === -1
                ? "NOT_DYNAMIC"
                : status === -2
                  ? "NON_FINITE"
                  : "INVALID";
          throw new Error(`TN_PHYSICS_${name}: actuation rejected`);
        }
      };
      try {
        world = invoke(0, gravity);
        if (!world) throw new Error("TN_PERRY_PHYSICS_CREATE_FAILED");
      } catch (error) {
        free(packet);
        throw error;
      }
      const queryHits = (op: number, values: number[], maxResults: number) => {
        integer(maxResults);
        if (!maxResults) invalid("maxResults must be positive");
        const output = new Float32Array(maxResults * 4);
        const count = invoke(op, values, undefined, 0, output);
        const hits = [];
        for (let i = 0; i < count; i++)
          hits.push({
            bodyId: output[i * 4] as number,
            position: {
              x: output[i * 4 + 1] as number,
              y: output[i * 4 + 2] as number,
              z: output[i * 4 + 3] as number,
            },
          });
        return hits;
      };
      return {
        createBody(body) {
          const id = integer(nextBody, MAX_ID);
          const shape = body.shape;
          const values = [
            id,
            bodyKind(body),
            shapeKind(shape),
            ...vector(body.position),
            ...rotation(body.rotation),
            scalar(shape.x),
            scalar(shape.y ?? 0),
            scalar(shape.z ?? 0),
            scalar(body.mass ?? 0),
            integer(body.collisionLayer),
            integer(body.collisionMask),
            flag(body.sensor),
            flag(body.continuousCollision),
          ];
          if (shape.kind === "trimesh") {
            if (
              !(shape.vertices instanceof Float32Array) ||
              !(shape.indices instanceof Uint32Array)
            )
              invalid("trimesh buffers");
            accepted(1, values, shape.vertices, shape.vertices.length, shape.indices);
          } else if (shape.kind === "heightfield") {
            const [heights, fields] = heightfield(shape);
            accepted(1, [...values, ...fields], heights);
          } else accepted(1, values);
          nextBody++;
          return id;
        },
        removeBody(id) {
          accepted(2, [integer(id, MAX_ID)]);
        },
        configureCharacter(id, options) {
          const auto = options.autostep;
          accepted(3, [
            integer(id, MAX_ID),
            scalar(options.offset),
            scalar(options.maxSlopeClimbAngle),
            auto === undefined ? 0 : 1,
            scalar(auto?.maxHeight ?? 0),
            scalar(auto?.minWidth ?? 0),
            flag(auto?.includeDynamicBodies ?? false),
            options.snapToGround === undefined ? 0 : 1,
            scalar(options.snapToGround ?? 0),
            integer(options.oneWayLayers ?? 0),
            flag(options.pushesDynamicBodies ?? false),
          ]);
        },
        step(dt, input) {
          scalar(dt);
          if (dt <= 0) invalid("deltaTime must be positive");
          const count = integer(input?.kinematicCount ?? 0);
          if (
            input &&
            (!(input.kinematicTransforms instanceof Float32Array) ||
              count > input.kinematicTransforms.length / 8)
          )
            invalid("kinematic count");
          accepted(4, [dt], input?.kinematicTransforms, count);
        },
        readVisibleTransforms(output) {
          return invoke(5, [], undefined, 0, output);
        },
        readBodySleepStates(output) {
          return invoke(6, [], undefined, 0, output);
        },
        readCharacterStates(output) {
          return invoke(7, [], undefined, 0, output);
        },
        readAreaIntersections(output) {
          return invoke(8, [], undefined, 0, output);
        },
        drainCollisionEvents(output) {
          return invoke(9, [], undefined, 0, output);
        },
        intersectRay(query, output = new Float32Array(8)) {
          if (!(output instanceof Float32Array) || output.length < 8) invalid("ray output");
          return invoke(
            11,
            [...vector(query.from), ...vector(query.to), integer(query.collisionMask)],
            undefined,
            0,
            output,
          );
        },
        intersectShape(query) {
          const kind = shapeKind(query.shape);
          if (kind > 2) invalid("shape query supports box, sphere and capsule");
          return queryHits(
            12,
            [
              kind,
              scalar(query.shape.x),
              scalar(query.shape.y),
              scalar(query.shape.z),
              ...vector(query.position),
              ...rotation(query.rotation),
              integer(query.collisionMask),
              integer(query.maxResults),
            ],
            query.maxResults,
          );
        },
        intersectPoint(query) {
          return queryHits(
            13,
            [...vector(query.position), integer(query.collisionMask), integer(query.maxResults)],
            query.maxResults,
          );
        },
        setBodyTransform(id, position) {
          accepted(14, [integer(id, MAX_ID), ...vector(position)]);
        },
        applyBodyImpulse(id, impulse) {
          actuate(15, [integer(id, MAX_ID), ...vector(impulse)]);
        },
        applyBodyForce(id, force) {
          actuate(16, [integer(id, MAX_ID), ...vector(force)]);
        },
        setBodyLinearVelocity(id, velocity) {
          actuate(17, [integer(id, MAX_ID), ...vector(velocity)]);
        },
        readBodyLinearVelocity(id) {
          const output = new Float32Array(3);
          actuate(18, [integer(id, MAX_ID)], output);
          return { x: output[0] as number, y: output[1] as number, z: output[2] as number };
        },
        applyBodyForceAtPoint(id, force, point) {
          actuate(19, [integer(id, MAX_ID), ...vector(force), ...vector(point)]);
        },
        readContacts(id, candidates, output) {
          return invoke(20, [integer(id, MAX_ID)], candidates, candidates.length, output);
        },
        setColliderShape(id, shape) {
          if (shape.kind !== "heightfield") invalid("setColliderShape requires a heightfield");
          const [heights, fields] = heightfield(shape);
          accepted(21, [integer(id, MAX_ID), ...fields], heights);
        },
        dispose() {
          if (disposed) return;
          invoke(10, []);
          disposed = true;
          free(packet);
          for (const pointer of pointers) free(pointer);
          world = 0;
        },
      };
    },
  };
}
