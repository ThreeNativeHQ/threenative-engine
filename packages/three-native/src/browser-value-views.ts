/**
 * three's math values on the browser back end (PRD-532, PRD-573, PRD-803): `new Vector3()` is JS and
 * holds its own lanes, an engine value (`mesh.position`) reads and writes them in the engine's
 * memory, and a value that crosses into an engine call is borrowed or promoted. Each engine keeps
 * its own pools and prototypes, so the back end builds them per engine.
 */
import type { EngineValue, IBrowserRuntime, IEngineRef } from "./browser-abi-types.js";
import type { IRegistryClass, IRegistryDump, IWrapped } from "./browser-backend.js";
import { REF, SCALARS, TYPED, type TypedArray, isPlainObject } from "./browser-marshal.js";
import { UNWATCH } from "./tsl-uniforms.js";

// three's math values are JS (browser-math.ts): `new Vector3()` holds its own lanes. The engine's
// vectors (`mesh.position`) share that prototype through `engine`, whose lanes are its memory.
// An engine call takes a JS value by value: a method borrows a pooled engine object and copies
// the lanes back after the call (an output argument); a constructor or setter, which may keep the
// object, gets the value itself turned into an engine object in place, so identity survives.
//
// A class may store its lanes under three's private names (`Quaternion._x`, `Matrix4.elements`) or
// hold them in member vectors (`Box3.min`): its plan reads and writes those, and says which own
// properties a promoted value must drop so the engine accessors take over.
/** A value class's JS storage: its public lanes, three's private names, and member vectors. */
export interface IValueLanes {
  [key: string]: unknown;
  _x?: number;
  _y?: number;
  _z?: number;
  _w?: number;
  _order?: string;
  elements?: number[];
  radius?: number;
  min?: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  max?: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
  center?: { x: number; y: number; z: number; set(x: number, y: number, z: number): unknown };
}
export interface IValuePlan {
  /** The engine's lane names, in the order its constructor takes them. */
  lanes: readonly string[];
  /** Own JS properties the class keeps its storage in; a promoted value drops them. */
  drop: readonly string[];
  /** The lanes of a JS value, in `lanes` order (Euler appends its order). */
  read(value: IValueLanes): number[];
  /** Writes engine lanes back into a JS value, as `lend` copies them back. */
  write(value: IValueLanes, values: readonly number[]): void;
  /** Engine constructor arguments; the lanes themselves by default. */
  args?(values: number[], make: (name: string, values: number[]) => IEngineRef): EngineValue[];
  /** A method argument becomes an engine object in place: whole-object lanes and output targets. */
  promote?: boolean;
  /** Copies the lanes from one value to another with no list between: a loan's two copies. */
  copy?(target: IValueLanes, source: IValueLanes): void;
}
export interface IValueClass {
  name: string;
  engine: object;
  pool: object[];
  top: number;
  plan: IValuePlan;
}
const eulerOrders = ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"] as const;
export const defaultPlan = (lanes: readonly string[]): IValuePlan => ({
  lanes,
  drop: lanes,
  copy: (target, source) => {
    for (const lane of lanes) target[lane] = source[lane];
  },
  read: (value) => lanes.map((lane) => value[lane] as number),
  write: (value, values) => {
    lanes.forEach((lane, index) => {
      value[lane] = values[index] as number;
    });
  },
});
/** A value's member vector (`Box3.min`, `Sphere.center`): present on every real instance. */
const memberVector = (vector: IValueLanes["min"]): NonNullable<IValueLanes["min"]> => {
  if (vector === undefined) throw new TypeError("TN_BROWSER_VALUE_MEMBER: the value has no vector");
  return vector;
};
// three's private storage names, and the classes whose lanes are not plain fields.
export const valuePlans: Record<string, IValuePlan> = {
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Color: defaultPlan(["r", "g", "b"]),
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Vector4: defaultPlan(["x", "y", "z", "w"]),
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Quaternion: {
    lanes: ["x", "y", "z", "w"],
    drop: ["_x", "_y", "_z", "_w"],
    read: (value) => [value._x, value._y, value._z, value._w] as number[],
    write: (value, values) => {
      value._x = values[0];
      value._y = values[1];
      value._z = values[2];
      value._w = values[3];
    },
  },
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Euler: {
    lanes: ["x", "y", "z"],
    drop: ["_x", "_y", "_z", "_order"],
    read: (value) =>
      [
        value._x,
        value._y,
        value._z,
        eulerOrders.indexOf(value._order as (typeof eulerOrders)[number]),
      ] as number[],
    write: (value, values) => {
      value._x = values[0];
      value._y = values[1];
      value._z = values[2];
      value._order = eulerOrders[values[3] as number] ?? "XYZ";
    },
    args: (values) => [values[0], values[1], values[2], eulerOrders[values[3] as number] ?? "XYZ"],
  },
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Matrix3: {
    promote: true,
    lanes: ["elements"],
    drop: ["elements"],
    read: (value) => Array.from(value.elements as number[]),
    write: (value, values) => {
      value.elements = Array.from(values);
    },
    // `elements` is column-major; the engine constructor takes three's row-major set order.
    args: (values) => [0, 3, 6, 1, 4, 7, 2, 5, 8].map((index) => values[index] as number),
  },
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Matrix4: {
    promote: true,
    lanes: ["elements"],
    drop: ["elements"],
    read: (value) => Array.from(value.elements as number[]),
    write: (value, values) => {
      value.elements = Array.from(values);
    },
    // `elements` is column-major; the engine constructor takes three's row-major set order.
    args: (values) =>
      [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15].map(
        (index) => values[index] as number,
      ),
  },
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Box3: {
    promote: true,
    lanes: [],
    drop: ["min", "max"],
    read: (value) => {
      const min = memberVector(value.min);
      const max = memberVector(value.max);
      return [min.x, min.y, min.z, max.x, max.y, max.z];
    },
    write: (value, values) => {
      memberVector(value.min).set(values[0] as number, values[1] as number, values[2] as number);
      memberVector(value.max).set(values[3] as number, values[4] as number, values[5] as number);
    },
    args: (values, make) => [
      make("Vector3", values.slice(0, 3).map(Number)),
      make("Vector3", values.slice(3, 6).map(Number)),
    ],
  },
  // quality-allow: the plan table is keyed by three's PascalCase class names, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: keyed by three's class name.
  Sphere: {
    promote: true,
    lanes: ["radius"],
    drop: ["center", "radius"],
    read: (value) => {
      const center = memberVector(value.center);
      return [center.x, center.y, center.z, value.radius as number];
    },
    write: (value, values) => {
      memberVector(value.center).set(values[0] as number, values[1] as number, values[2] as number);
      value.radius = values[3] as number;
    },
    args: (values, make) => [make("Vector3", values.slice(0, 3).map(Number)), values[3]],
  },
};

/** What a value class's engine side needs from the back end whose objects it belongs to. */
export interface IValueViewHost {
  readonly runtime: IBrowserRuntime;
  readonly registry: IRegistryDump;
  refOf(self: unknown): IEngineRef;
  adopt(target: object, ref: IEngineRef): object;
  wrap(ref: IEngineRef): object;
  hold(wrapper: object): void;
  addressOf(self: object): number;
  readonly rotations: WeakMap<object, object>;
  readonly quaternions: WeakMap<object, object>;
  readonly sharedTransformWrite?: (self: object, address: number, value: number) => void;
}

/** The value marshalling one engine keeps: its classes, its loan pool, and both directions. */
export interface IValueViews {
  toEngine(value: unknown): EngineValue;
  /** JS prototype -> its engine side. */
  readonly valueClasses: Map<object, IValueClass>;
  /** The loans not yet copied back, from `lend` to `repay`. */
  readonly loans: [IValueLanes, IValueLanes, IValueClass][];
  repay(mark: number, returned: unknown): unknown;
  toEngineArgs(args: readonly unknown[]): EngineValue[];
  defineValueView(
    name: string,
    accessors: Record<string, unknown>,
    binding: IRegistryClass,
    skip: Set<string>,
  ): void;
}

export function defineValueViews(host: IValueViewHost): IValueViews {
  const {
    runtime,
    registry,
    refOf,
    adopt,
    wrap,
    hold,
    addressOf,
    rotations,
    quaternions,
    sharedTransformWrite,
  } = host;
  const valueClasses = new Map<object, IValueClass>(); // JS prototype -> its engine side
  const loans: [IValueLanes, IValueLanes, IValueClass][] = [];
  let borrowing = false;
  const toEngineArgs = (args: readonly unknown[]): EngineValue[] => {
    borrowing = true;
    try {
      return args.map(toEngine);
    } finally {
      borrowing = false;
    }
  };
  // A plan's member-vector arguments (Box3's two, Sphere's one) are native temporaries: the engine
  // copies them, so they are released as soon as the value that owns the lanes is constructed.
  const engineArgs = (
    info: IValueClass,
    values: number[],
  ): { args: EngineValue[]; temporaries: IEngineRef[] } => {
    if (info.plan.args === undefined) return { args: values, temporaries: [] };
    const temporaries: IEngineRef[] = [];
    const args = info.plan.args(values, (name, lanes) => {
      const ref = runtime.construct(name, lanes);
      temporaries.push(ref);
      return ref;
    });
    return { args, temporaries };
  };
  const lend = (value: IValueLanes, info: IValueClass): IEngineRef => {
    let scratch = info.pool[info.top];
    if (scratch === undefined) {
      const built = engineArgs(info, info.plan.read(value));
      try {
        scratch = wrap(runtime.construct(info.name, built.args));
      } finally {
        for (const temporary of built.temporaries) runtime.release(temporary);
      }
      info.pool.push(scratch);
    }
    info.top++;
    const lanes = scratch as IValueLanes;
    if (info.plan.copy !== undefined) info.plan.copy(lanes, value);
    else info.plan.write(lanes, info.plan.read(value));
    loans.push([value, lanes, info]);
    return refOf(scratch);
  };
  // Copies each borrowed object's lanes back to its JS value; the result answers the value itself.
  const repay = (mark: number, returned: unknown): unknown => {
    let result = returned;
    for (let i = loans.length - 1; i >= mark; i--) {
      const [value, scratch, info] = loans[i] as (typeof loans)[number];
      if (info.plan.copy !== undefined) info.plan.copy(value, scratch);
      else info.plan.write(value, info.plan.read(scratch));
      info.top--;
      if (result === scratch) result = value;
    }
    loans.length = mark;
    return result;
  };
  const promote = (value: IValueLanes, info: IValueClass): void => {
    const values = info.plan.read(value);
    (value as { [UNWATCH]?: () => void })[UNWATCH]?.(); // a uniform's watched lanes go: scan it instead
    for (const key of info.plan.drop) delete value[key];
    Object.setPrototypeOf(value, info.engine);
    const built = engineArgs(info, values);
    try {
      adopt(value, runtime.construct(info.name, built.args));
    } finally {
      for (const temporary of built.temporaries) runtime.release(temporary);
    }
  };
  // An engine-owned value reads and writes its lanes in the engine's memory through accessors named
  // for the storage its class actually uses. Quaternion and Euler store `_x`, Matrix stores
  // `elements`, and an Euler's order is a string over the engine's byte enum; Box3 and Sphere reach
  // their vectors through the registry's fixed members, so they need nothing here.
  const defineValueView = (
    name: string,
    accessors: Record<string, unknown>,
    binding: IRegistryClass,
    skip: Set<string>,
  ): void => {
    const read = runtime.readDoubles;
    const write = runtime.writeDouble;
    const peek = runtime.readByte;
    if (read === undefined || write === undefined) return;
    const heap = runtime.heapF64;
    const lane = heap
      ? (address: number): number => heap(address + 8)[address / 8] as number
      : (address: number): number => read(address, 1) as number;
    if (name === "Quaternion" && binding.fields !== undefined) {
      const offsets = ["x", "y", "z", "w"].map((key) => binding.fields?.[key]?.[0] ?? 0);
      ["_x", "_y", "_z", "_w"].forEach((key, index) => {
        const offset = offsets[index] as number;
        Object.defineProperty(accessors, key, {
          configurable: true,
          get(this: object): number {
            return lane(addressOf(this) + offset);
          },
          set(this: object, value: number): void {
            const address = addressOf(this) + offset;
            const next = Number(value);
            sharedTransformWrite?.(this, address, next);
            write(address, next);
          },
        });
      });
      skip.add("x").add("y").add("z").add("w");
      // three syncs an Object3D's rotation from its quaternion. Physics interpolation sets every body's
      // quaternion every frame, so a call per sync cost 1,732 crossings a frame on the stress lab. This is
      // Euler::setFromQuaternion with update off (Euler.cpp), written into the rotation's lanes: the same
      // formulas, and Math is V8's fdlibm, which the engine's ieee754 functions are, so the bits match.
      const eulerFields = registry.classes.Euler?.fields;
      const angles = ["x", "y", "z"].map((key) => eulerFields?.[key]?.[0]);
      const orderAt = eulerFields?.__order?.[0];
      const local =
        peek !== undefined && orderAt !== undefined && angles.every((at) => at !== undefined);
      const [ax, ay, az] = angles as [number, number, number];
      Object.defineProperty(accessors, "_onChangeCallback", {
        configurable: true,
        writable: true,
        value(this: object): void {
          const owner = quaternions.get(this) as
            | { rotation?: object & { _order?: string } }
            | undefined;
          if (owner?.rotation === undefined) return;
          if (!local) {
            // The rotation's own order; the engine refuses a missing one on this call.
            runtime.invoke(refOf(owner.rotation), "setFromQuaternion", [
              refOf(this),
              owner.rotation._order ?? "XYZ",
            ]);
            return;
          }
          const q = addressOf(this);
          const e = addressOf(owner.rotation);
          const [ex, ey, ez] = eulerFromQuaternion(
            lane(q + (offsets[0] as number)),
            lane(q + (offsets[1] as number)),
            lane(q + (offsets[2] as number)),
            lane(q + (offsets[3] as number)),
            eulerOrders[(peek as (address: number) => number)(e + (orderAt as number))] ?? "XYZ",
          );
          write(e + ax, ex);
          write(e + ay, ey);
          write(e + az, ez);
        },
      });
      return;
    }
    if (name === "Euler" && binding.fields !== undefined && peek !== undefined) {
      const offsets = ["x", "y", "z"].map((key) => binding.fields?.[key]?.[0] ?? 0) as number[];
      const orderAt = binding.fields.__order?.[0] ?? 0;
      const quaternionFields = registry.classes.Quaternion?.fields;
      const targets = ["x", "y", "z", "w"].map((key) => quaternionFields?.[key]?.[0] ?? 0);
      // three's setFromEuler: each order only signs the second terms, in the engine enum's order.
      const signs = [
        [1, -1, 1, -1],
        [1, -1, -1, 1],
        [-1, 1, 1, -1],
        [-1, 1, -1, 1],
        [1, 1, -1, -1],
        [-1, -1, 1, 1],
      ];
      const sync = (euler: object): void => {
        const owner = rotations.get(euler) as { quaternion?: object } | undefined;
        if (owner?.quaternion === undefined) return;
        const at = addressOf(euler);
        const q = addressOf(owner.quaternion);
        const x = lane(at + (offsets[0] as number)) / 2;
        const y = lane(at + (offsets[1] as number)) / 2;
        const z = lane(at + (offsets[2] as number)) / 2;
        const sign = signs[peek(at + orderAt)] ?? (signs[0] as number[]);
        const c1 = Math.cos(x);
        const c2 = Math.cos(y);
        const c3 = Math.cos(z);
        const s1 = Math.sin(x);
        const s2 = Math.sin(y);
        const s3 = Math.sin(z);
        write(q + (targets[0] as number), s1 * c2 * c3 + (sign[0] as number) * c1 * s2 * s3);
        write(q + (targets[1] as number), c1 * s2 * c3 + (sign[1] as number) * s1 * c2 * s3);
        write(q + (targets[2] as number), c1 * c2 * s3 + (sign[2] as number) * s1 * s2 * c3);
        write(q + (targets[3] as number), c1 * c2 * c3 + (sign[3] as number) * s1 * s2 * s3);
      };
      ["_x", "_y", "_z"].forEach((key, index) => {
        const offset = offsets[index] as number;
        Object.defineProperty(accessors, key, {
          configurable: true,
          get(this: object): number {
            return lane(addressOf(this) + offset);
          },
          set(this: object, value: number): void {
            const address = addressOf(this) + offset;
            const next = Number(value);
            sharedTransformWrite?.(this, address, next);
            write(address, next);
          },
        });
      });
      Object.defineProperty(accessors, "_order", {
        configurable: true,
        get(this: object): string {
          return eulerOrders[peek(addressOf(this) + orderAt)] ?? "XYZ";
        },
        set(this: object, value: unknown): void {
          const index = eulerOrders.indexOf(value as (typeof eulerOrders)[number]);
          if (index < 0)
            throw new TypeError(
              `Euler order is not one of ${eulerOrders.join(", ")}: ${String(value)}`,
            );
          // The order is the engine's byte enum: its setter reorders and syncs, so only a change
          // crosses (four numbers are not worth a call on every `rotation.set`).
          if (index !== peek(addressOf(this) + orderAt))
            runtime.set(refOf(this), "order", value as string);
        },
      });
      Object.defineProperty(accessors, "_onChangeCallback", {
        configurable: true,
        writable: true,
        value(this: object): void {
          sync(this);
        },
      });
      skip.add("x").add("y").add("z").add("order");
      return;
    }
    if ((name === "Matrix3" || name === "Matrix4") && binding.fields?.elements !== undefined) {
      const [offset = 0, count = 0] = binding.fields.elements;
      // three keeps one `elements` array; this keeps one proxy per matrix over a mirrored array and
      // writes every element it sets straight to engine memory, so the array never detaches.
      const mirrors = new WeakMap<object, { values: number[]; view: number[] }>();
      // Off the heap view when there is one: a game reads `matrixWorld.elements` hundreds of times
      // a frame, and a copy call allocates two arrays a read.
      const refresh = heap
        ? (address: number, values: number[]): void => {
            const memory = heap(address + count * 8);
            for (let i = 0, at = address / 8; i < count; i++) values[i] = memory[at + i] as number;
          }
        : (address: number, values: number[]): void => {
            const memory = read(address, count) as number[];
            for (let i = 0; i < count; i++) values[i] = memory[i] as number;
          };
      // Shared memory (the threads build) never detaches when it grows, so a view onto it is the
      // matrix itself: three's compose wrote 16 trapped elements a call, 49 ms of a laptop load (PRD-860).
      const shared = new WeakMap<object, Float64Array>();
      Object.defineProperty(accessors, "elements", {
        configurable: true,
        get(this: object): number[] {
          const address = addressOf(this) + offset;
          const memory = heap?.(address + count * 8);
          if (
            typeof SharedArrayBuffer !== "undefined" &&
            memory?.buffer instanceof SharedArrayBuffer
          ) {
            let view = shared.get(this);
            if (view === undefined) {
              view = memory.subarray(address / 8, address / 8 + count);
              shared.set(this, view);
            }
            // quality-allow: three's elements are an indexable number list; a Float64Array is one.
            return view as unknown as number[];
          }
          let mirror = mirrors.get(this);
          if (mirror === undefined) {
            const values = new Array<number>(count);
            const view = new Proxy(values, {
              set: (target, key, value): boolean => {
                const index = typeof key === "string" ? Number(key) : Number.NaN;
                if (Number.isInteger(index) && index >= 0 && index < count)
                  write(address + index * 8, Number(value));
                target[key as never] = value as never;
                return true;
              },
            });
            mirror = { values, view };
            mirrors.set(this, mirror);
          }
          refresh(address, mirror.values);
          return mirror.view;
        },
        set(this: object, value: ArrayLike<number>): void {
          const address = addressOf(this) + offset;
          for (let i = 0; i < count; i++) write(address + i * 8, Number(value[i]));
        },
      });
      skip.add("elements");
    }
  };
  const toEngine = (value: unknown): EngineValue => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string")
      return value;
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      // An image's `getImageData` pixels are a Uint8ClampedArray: boxed into a list, a 4096x2048 sky took 1.4 s.
      if (
        runtime.typedArrays === true &&
        (value instanceof Uint8ClampedArray || SCALARS.some((scalar) => value instanceof scalar))
      )
        return value as TypedArray;
      // quality-allow: a typed-array view read as its numeric index signature, which ArrayBufferView does not declare.
      const list = Array.from(value as unknown as ArrayLike<number>);
      Object.defineProperty(list, TYPED, { value: value.constructor.name });
      return list;
    }
    if (Array.isArray(value)) return Array.from(value as ArrayLike<unknown>, toEngine);
    const info = valueClasses.get(Object.getPrototypeOf(value) as object);
    if (info !== undefined) {
      if (borrowing && info.plan.promote !== true) return lend(value as IValueLanes, info);
      promote(value as IValueLanes, info);
    }
    if (typeof value === "object" && REF in value) {
      // A wrapper passed into the engine is held until the next safe point decides (collect()).
      hold(value);
      return (value as IWrapped)[REF];
    }
    // An options object (`new ExtrudeGeometry(shape, { depth })`) crosses as a record of scalars and
    // engine objects, as the V8 adapter passes it; an undefined value is left out, as three reads it.
    if (isPlainObject(value)) {
      const fields: Record<string, EngineValue> = {};
      for (const [key, item] of Object.entries(value as object)) {
        if (item === undefined) continue;
        if (
          item !== null &&
          typeof item === "object" &&
          !(REF in item) &&
          !valueClasses.has(Object.getPrototypeOf(item) as object)
        )
          throw new TypeError(
            `TN_BROWSER_ARGUMENT_UNSUPPORTED: option ${key} cannot cross to the engine`,
          );
        fields[key] = toEngine(item);
      }
      return fields;
    }
    throw new TypeError(
      `TN_BROWSER_ARGUMENT_UNSUPPORTED: ${typeof value} cannot cross to the engine`,
    );
  };
  return {
    toEngine,
    valueClasses,
    loans,
    repay,
    toEngineArgs,
    defineValueView,
  };
}

/**
 * three's `Euler.setFromQuaternion` (and the engine's Euler.cpp, whose ieee754 functions are V8's fdlibm, so the
 * bits match): the rotation matrix of a unit quaternion, then the angles of the given order.
 */
export function eulerFromQuaternion(
  x: number,
  y: number,
  z: number,
  w: number,
  order: string,
): [number, number, number] {
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const m11 = 1 - (yy + zz);
  const m12 = xy - wz;
  const m13 = xz + wy;
  const m21 = xy + wz;
  const m22 = 1 - (xx + zz);
  const m23 = yz - wx;
  const m31 = xz - wy;
  const m32 = yz + wx;
  const m33 = 1 - (xx + yy);
  const asin = (value: number): number => Math.asin(Math.max(-1, Math.min(1, value)));
  const free = (value: number): boolean => Math.abs(value) < 0.9999999;
  switch (order) {
    case "YXZ":
      return free(m23)
        ? [-asin(m23), Math.atan2(m13, m33), Math.atan2(m21, m22)]
        : [-asin(m23), Math.atan2(-m31, m11), 0];
    case "ZXY":
      return free(m32)
        ? [asin(m32), Math.atan2(-m31, m33), Math.atan2(-m12, m22)]
        : [asin(m32), 0, Math.atan2(m21, m11)];
    case "ZYX":
      return free(m31)
        ? [Math.atan2(m32, m33), -asin(m31), Math.atan2(m21, m11)]
        : [0, -asin(m31), Math.atan2(-m12, m22)];
    case "YZX":
      return free(m21)
        ? [Math.atan2(-m23, m22), Math.atan2(-m31, m11), asin(m21)]
        : [0, Math.atan2(m13, m33), asin(m21)];
    case "XZY":
      return free(m12)
        ? [Math.atan2(m32, m22), Math.atan2(m13, m11), -asin(m12)]
        : [Math.atan2(-m23, m33), 0, -asin(m12)];
    default:
      return free(m13)
        ? [Math.atan2(-m23, m33), asin(m13), Math.atan2(-m12, m11)]
        : [Math.atan2(m32, m22), asin(m13), 0];
  }
}
