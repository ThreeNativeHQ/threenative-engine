/**
 * The browser-JS back end (PRD-532): three's class names as JS classes over the engine's C ABI
 * compiled to Wasm.
 *
 * The classes are built from the binding registry snapshot (`api/native-registry.json`): every class
 * the registry binds becomes a constructor whose prototype carries exactly that class's methods,
 * top-level getters and setters, and member objects. That is the surface the catalog marks supported
 * (`catalog-registry.spec.ts`), and nothing else. Dotted registry paths (`position.x`) are protocol
 * paths and stay off the prototype: `mesh.position.x` goes through the member object.
 *
 * One wrapper per engine handle, so identity survives (`mesh.position === mesh.position`); a
 * collected wrapper releases its object.
 */

import { UpstreamVector3, defineMath } from "./browser-math.js";
import type { ITslRuntime, TslArgValue } from "./browser-tsl.js";
import { detachVirtualShadow, shadowFilterOptions, virtualShadowOptions } from "./shadow-node.js";
import { withUpdateRanges } from "./update-ranges.js";

export interface IRegistryClass {
  readonly constructor: boolean;
  readonly methods: readonly string[];
  readonly getters: readonly string[];
  readonly setters: readonly string[];
  readonly members: readonly string[];
  /** Language callbacks the engine calls back (`onBeforeRender`). */
  readonly callbacks: readonly string[];
  /** Event types the engine dispatches (AnimationMixer's `finished`, `loop`). */
  readonly events?: readonly string[];
  /** Members the owner keeps for life (`position`, `matrixWorld`): the first answer may be kept. */
  readonly fixedMembers?: readonly string[];
  /** Doubles held in place: [byte offset from the object's `__address`, count] (JSON arrays). */
  readonly fields?: Readonly<Record<string, readonly number[]>>;
}

export interface IRegistryDump {
  readonly classes: Readonly<Record<string, IRegistryClass>>;
}

/** A ref with its handle words kept (see `createWasmRuntime`): type | context << 16, index, generation. */
interface IPackedRef extends IEngineRef {
  w0: number;
  w1: number;
  w2: number;
}

/** An engine object as the back end sees it: an opaque key and its catalog type id. */
export interface IEngineRef {
  readonly key: string;
  readonly type: number;
}

export type EngineValue =
  | null
  | undefined
  | number
  | boolean
  | string
  | readonly EngineValue[]
  | IEngineRef
  | { readonly [key: string]: EngineValue };

/** What the classes call; the Wasm ABI implements it, and a surface-only runtime refuses every call. */
export interface IBrowserRuntime {
  typeId(className: string): number;
  construct(className: string, args: readonly EngineValue[]): IEngineRef;
  invoke(self: IEngineRef, method: string, args: readonly EngineValue[]): EngineValue;
  get(self: IEngineRef, path: string): EngineValue;
  set(self: IEngineRef, path: string, value: EngineValue): void;
  release(self: IEngineRef): void;
  /** For each ref, how many references other engine objects hold to its object; one call a batch. */
  engineReferences?(refs: readonly IEngineRef[]): ArrayLike<number>;
  /** Doubles at `address` in the engine's memory (one as a number, more as an array); Wasm only. */
  readDoubles?(address: number, count: number): number | number[];
  /**
   * The engine's memory as doubles, current: Emscripten replaces the view when the memory grows, so a caller
   * reads it per operation and never keeps it. Wasm only.
   */
  heapF64?(): Float64Array;
  /** The byte at `address` in the engine's memory; Wasm only. A registry field `[offset, 0]` is a byte flag. */
  readByte?(address: number): number;
  /** Writes one double at `address` in the engine's memory; Wasm only. */
  writeDouble?(address: number, value: number): void;
  /**
   * A copy of the attribute's data, of its scalar type; three's `attribute.array` is built on it.
   * With `offset`/`count`, a copy of that scalar subrange only (a per-vertex setter syncs one item).
   */
  attributeArray?(self: IEngineRef, offset?: number, count?: number): TypedArray;
  /**
   * Writes `array` into the attribute's data; present with attributeArray. With `offset`, writes that
   * subrange; without it, `array` must be the attribute's whole data.
   */
  attributeWrite?(self: IEngineRef, array: TypedArray, offset?: number): void;
  /** Sets (or, with null, clears) a callback the engine runs; `handler` gets the engine's arguments. */
  setCallback(
    self: IEngineRef,
    name: string,
    handler: ((args: readonly EngineValue[]) => void) | null,
  ): void;
  /** TSL by name (PRD-540), when the module carries `tn_tsl_call`. */
  readonly tsl?: ITslRuntime;
  /** A GLB through the engine's own glTF loader (PRD-540), when the module carries the web host. */
  loadGltf?(
    bytes: Uint8Array,
    files?: ReadonlyMap<string, Uint8Array>,
  ): { readonly scene: IEngineRef; readonly animations: IEngineRef[] };
}

/** The engine node id a TSL wrapper (`browser-tsl.ts`) carries. */
export const TSL_NODE = Symbol("tn.tslNode");

/** The defined classes and the callback safe point the host runs between frames. */
export interface IBrowserEngine {
  readonly classes: Record<string, new (...args: unknown[]) => object>;
  /**
   * The safe point (the renderer runs one before every frame). A wrapper the engine references (a
   * parent, a material slot) is held, so its JS state (userData, expandos, a subclass, callbacks)
   * survives while JS keeps no reference; once nothing in the engine references it, it is let go,
   * so a detached subtree, its closures and its wrappers are collected.
   */
  collect(): void;
  /** Engine crossings so far (construct, get, set, invoke, engineReferences): a bench rung's bridgeCalls. */
  crossings(): number;
  /** The wrapper for an engine object the engine handed over (a loaded model's scene). */
  wrap(ref: IEngineRef): object;
}

/** Safe points a pass over the settled wrappers spans. */
const SETTLED_PASS = 64;

const REF = Symbol("tn.engineRef");

type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;
/** A number list that came from a typed array names it, so the engine keeps three's storage type. */
const TYPED = Symbol("tn.typedArray");
// The engine's Scalar order: F32, F64, I8, U8, I16, U16, I32, U32.
const SCALARS = [
  Float32Array,
  Float64Array,
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
];
const ATTRIBUTE_CLASSES = new Set([
  "BufferAttribute",
  "Float32BufferAttribute",
  "Uint16BufferAttribute",
  "Uint32BufferAttribute",
  "InstancedBufferAttribute",
]);

interface IWrapped {
  [REF]: IEngineRef;
}

/** One own, enumerable field of a material: its descriptor is built once per class and shared by every instance. */
interface IOwnField {
  readonly key: string;
  readonly descriptor: PropertyDescriptor;
}

/**
 * Define a class's own fields on one instance. A loop of `Object.defineProperty` takes about 12 us for the
 * 40 fields of a standard material where one `Object.defineProperties` takes 17 us (node 20, 20000 builds).
 */
function defineOwn(target: object, own: readonly IOwnField[]): void {
  for (const field of own) Object.defineProperty(target, field.key, field.descriptor);
}

/** The engine object behind a back-end wrapper, for a host that talks to the ABI directly. */
export function engineRef(object: object): IEngineRef | undefined {
  return (object as Partial<IWrapped>)[REF];
}

function isRef(value: unknown): value is IEngineRef {
  return typeof value === "object" && value !== null && "key" in value && "type" in value;
}

function isPlainObject(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isWrapperOf(
  value: unknown,
  className: string,
): value is Record<string, (...args: unknown[]) => unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    REF in value &&
    value.constructor.name === className
  );
}

/** three's `Color.set`: a hex number, a CSS string, or another Color. */
function setColor(color: Record<string, (...args: unknown[]) => unknown>, value: unknown): void {
  if (typeof value === "number") color.setHex?.(value);
  else if (typeof value === "string") color.setStyle?.(value);
  else color.copy?.(value);
}

/**
 * three's `Material.setValues`: an undefined value is skipped, a Color member is set from a hex,
 * a CSS string or another Color, a Vector3 member copies a Vector3, everything else is assigned.
 * three warns and drops a key the object does not have; here that key fails.
 */
function setValues(target: object, className: string, values: object): void {
  const self = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const current = self[key];
    if (current === undefined)
      throw new TypeError(`TN_BROWSER_PARAMETER_UNSUPPORTED: ${className} has no '${key}'`);
    if (isWrapperOf(current, "Color")) setColor(current, value);
    else if (isWrapperOf(current, "Vector3") && (value as { isVector3?: boolean }).isVector3)
      current.copy?.(value);
    else self[key] = value;
  }
}

/** What the back end reads from the catalog: each class's parent and three's `is*` flags. */
export interface ICatalogShape {
  readonly entries: readonly {
    readonly name: string;
    readonly kind: string;
    readonly extends?: string | null;
    readonly fields?: readonly {
      readonly name: string;
      readonly type: string;
      readonly mutable?: boolean;
    }[];
  }[];
}

/** Members every scene-graph class gets in JavaScript: game state, walks over `children` and `raycast`. */
export const LANGUAGE_MEMBERS = [
  "userData",
  "traverse",
  "traverseVisible",
  "traverseAncestors",
  "getObjectsByProperty",
  "getObjectByProperty",
  "getObjectByName",
  "getObjectById",
  "raycast",
] as const;

type TraverseCallback = (object: object) => void;

/**
 * The `traverse` family, written over `children`, as three writes it. A class whose engine binding
 * has no `children` refuses by name instead of visiting only the root.
 */
function defineTraversal(
  prototype: Record<string, unknown>,
  className: string,
  hasChildren: boolean,
  walks: boolean,
) {
  const childrenOf = (object: object): object[] => {
    if (!hasChildren) throw new TypeError(`TN_BROWSER_UNBOUND: ${className}.children`);
    return (object as { children: object[] }).children;
  };
  // The engine's walk: one crossing for the whole subtree, in three's order (`__walk`).
  const walk = (object: object, visibleOnly: boolean): object[] =>
    (object as { __walk(visibleOnly: boolean): object[] }).__walk(visibleOnly);
  const methods: Record<string, (this: object, callback: TraverseCallback) => void> = {
    traverse(callback) {
      if (walks) {
        for (const object of walk(this, false)) callback(object);
        return;
      }
      callback(this);
      for (const child of childrenOf(this))
        (child as { traverse(c: TraverseCallback): void }).traverse(callback);
    },
    traverseVisible(callback) {
      if (walks) {
        for (const object of walk(this, true)) callback(object);
        return;
      }
      if ((this as { visible: boolean }).visible === false) return;
      callback(this);
      for (const child of childrenOf(this))
        (child as { traverseVisible(c: TraverseCallback): void }).traverseVisible(callback);
    },
    traverseAncestors(callback) {
      const parent = (this as { parent: object | null }).parent;
      if (parent === null) return;
      callback(parent);
      (parent as { traverseAncestors(c: TraverseCallback): void }).traverseAncestors(callback);
    },
  };
  for (const [name, value] of Object.entries(methods))
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value });
  // three's lookups, written over `traverse` as three writes them: the first match in walk order.
  const lookups: Record<string, (this: object, ...args: never[]) => unknown> = {
    getObjectsByProperty(this: object, name: string, value: unknown, result: object[] = []) {
      (this as { traverse(c: TraverseCallback): void }).traverse((object) => {
        if ((object as Record<string, unknown>)[name] === value) result.push(object);
      });
      return result;
    },
    getObjectByProperty(this: object, name: string, value: unknown) {
      return (
        this as { getObjectsByProperty(n: string, v: unknown): object[] }
      ).getObjectsByProperty(name, value)[0];
    },
    getObjectByName(this: object, name: string) {
      return (this as { getObjectByProperty(n: string, v: unknown): object }).getObjectByProperty(
        "name",
        name,
      );
    },
    getObjectById(this: object, id: number) {
      return (this as { getObjectByProperty(n: string, v: unknown): object }).getObjectByProperty(
        "id",
        id,
      );
    },
  };
  for (const [name, value] of Object.entries(lookups))
    Object.defineProperty(prototype, name, { configurable: true, writable: true, value });
  // three's Object3D.raycast(raycaster, intersects): push this object's own hits, no recursion. The engine
  // answers them through Raycaster.intersectObject (the object's native raycast; a Group answers none).
  Object.defineProperty(prototype, "raycast", {
    configurable: true,
    writable: true,
    value(
      this: object,
      raycaster: { intersectObject(object: object, recursive: boolean): unknown[] },
      intersects: unknown[],
    ) {
      intersects.push(...raycaster.intersectObject(this, false));
    },
  });
}

/**
 * Defines every registry class over `runtime`. With `catalog`, classes chain as three's do
 * (`mesh instanceof Object3D`) and carry three's `is*` flags.
 */
export function defineBrowserClasses(
  registry: IRegistryDump,
  source: IBrowserRuntime,
  catalog?: ICatalogShape,
): IBrowserEngine {
  // Every call into the engine counts, one increment each: the bench's crossing budget reads it per frame.
  let crossings = 0;
  const counted =
    <A extends unknown[], R>(call: (...args: A) => R) =>
    (...args: A): R => {
      crossings++;
      return call(...args);
    };
  const runtime: IBrowserRuntime = {
    ...source,
    construct: counted(source.construct),
    get: counted(source.get),
    set: counted(source.set),
    invoke: counted(source.invoke),
    ...(source.engineReferences === undefined
      ? {}
      : { engineReferences: counted(source.engineReferences) }),
  };
  const classes: Record<string, new (...args: unknown[]) => object> = {};
  const byType = new Map<number, { prototype: object; own?: readonly IOwnField[] }>();
  const typeNames = new Map<number, string>();
  (globalThis as { __tnEngineTypes?: Map<number, string> }).__tnEngineTypes = typeNames;
  // Reads that need no engine call: a field the engine holds in place is read from its memory (Wasm,
  // `readDoubles`), and a fixed member (`position`, `matrixWorld`) is kept after its first answer.
  // Writes still go through the engine's setters, which it reacts to.
  const addresses = new WeakMap<object, number>();
  // Each object's kept `rotation` Euler (or `quaternion`) -> the object, whose other form a write syncs.
  const rotations = new WeakMap<object, object>();
  const quaternions = new WeakMap<object, object>();
  // Properties only the object's own setter or methods change: `name` and `type` (read per track and
  // per bone while a game binds animations), an attribute's shape (read per merge), a mesh's
  // geometry and material. The answer is kept until JS sets it or calls a method on that object.
  // ponytail: an engine call on another object that changes one of these is missed; none does today.
  const labelled = new Set([
    "name",
    "type",
    "itemSize",
    "normalized",
    "gpuType",
    "geometry",
    "material",
  ]);
  const labels = new WeakMap<object, Map<string, unknown>>();
  const mixerStats = new WeakMap<object, object>();
  const fastGetter = (binding: IRegistryClass, property: string) => {
    const field = binding.fields?.[property];
    const read = runtime.readDoubles;
    const readByte = runtime.readByte;
    if (field !== undefined && read !== undefined) {
      const [offset = 0, count = 1] = field;
      // `[offset, 0]` is a byte flag (visible, castShadow, receiveShadow), `[offset, n]` n doubles.
      if (count === 0)
        return readByte === undefined
          ? undefined
          : function (this: object) {
              return readByte(addressOf(this) + offset) !== 0;
            };
      return function (this: object) {
        return read(addressOf(this) + offset, count);
      };
    }
    if (binding.fixedMembers?.includes(property) && !binding.setters.includes(property))
      // The first read defines the member as the object's own read-only property, as three's
      // Object3D has it: every later read is a plain property load, never this getter (R5 reads
      // position and rotation three times per cube per frame).
      return function (this: object) {
        const member = fromEngine(runtime.get(refOf(this), property));
        Object.defineProperty(this, property, { value: member, writable: false });
        if (property === "rotation") rotations.set(member as object, this);
        if (property === "quaternion") quaternions.set(member as object, this);
        return member;
      };
    return undefined;
  };
  const addressOf = (self: object): number => {
    let address = addresses.get(self);
    if (address === undefined) {
      address = runtime.get(refOf(self), "__address") as number;
      addresses.set(self, address);
    }
    return address;
  };
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
  interface IValueLanes {
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
  interface IValuePlan {
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
  }
  interface IValueClass {
    name: string;
    engine: object;
    pool: object[];
    top: number;
    plan: IValuePlan;
  }
  const eulerOrders = ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"] as const;
  const defaultPlan = (lanes: readonly string[]): IValuePlan => ({
    lanes,
    drop: lanes,
    read: (value) => lanes.map((lane) => value[lane] as number),
    write: (value, values) => {
      lanes.forEach((lane, index) => {
        value[lane] = values[index] as number;
      });
    },
  });
  /** A value's member vector (`Box3.min`, `Sphere.center`): present on every real instance. */
  const memberVector = (vector: IValueLanes["min"]): NonNullable<IValueLanes["min"]> => {
    if (vector === undefined)
      throw new TypeError("TN_BROWSER_VALUE_MEMBER: the value has no vector");
    return vector;
  };
  // three's private storage names, and the classes whose lanes are not plain fields.
  const valuePlans: Record<string, IValuePlan> = {
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
      args: (values) => [
        values[0],
        values[1],
        values[2],
        eulerOrders[values[3] as number] ?? "XYZ",
      ],
    },
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
        memberVector(value.center).set(
          values[0] as number,
          values[1] as number,
          values[2] as number,
        );
        value.radius = values[3] as number;
      },
      args: (values, make) => [make("Vector3", values.slice(0, 3).map(Number)), values[3]],
    },
  };
  const math = defineMath() as Record<string, new (...args: unknown[]) => object>;
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
    info.plan.write(lanes, info.plan.read(value));
    loans.push([value, lanes, info]);
    return refOf(scratch);
  };
  // Copies each borrowed object's lanes back to its JS value; the result answers the value itself.
  const repay = (mark: number, returned: unknown): unknown => {
    let result = returned;
    for (let i = loans.length - 1; i >= mark; i--) {
      const [value, scratch, info] = loans[i] as (typeof loans)[number];
      info.plan.write(value, info.plan.read(scratch));
      info.top--;
      if (result === scratch) result = value;
    }
    loans.length = mark;
    return result;
  };
  const promote = (value: IValueLanes, info: IValueClass): void => {
    const values = info.plan.read(value);
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
      ? (address: number): number => heap()[address / 8] as number
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
            write(addressOf(this) + offset, Number(value));
          },
        });
      });
      skip.add("x").add("y").add("z").add("w");
      // three syncs an Object3D's rotation from its quaternion; the engine does it in C++.
      Object.defineProperty(accessors, "_onChangeCallback", {
        configurable: true,
        writable: true,
        value(this: object): void {
          const owner = quaternions.get(this) as
            | { rotation?: object & { _order?: string } }
            | undefined;
          if (owner?.rotation === undefined) return;
          // The rotation's own order; the engine refuses a missing one on this call.
          runtime.invoke(refOf(owner.rotation), "setFromQuaternion", [
            refOf(this),
            owner.rotation._order ?? "XYZ",
          ]);
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
            write(addressOf(this) + offset, Number(value));
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
      Object.defineProperty(accessors, "elements", {
        configurable: true,
        get(this: object): number[] {
          const address = addressOf(this) + offset;
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
          const memory = read(address, count) as number[];
          for (let i = 0; i < count; i++) mirror.values[i] = memory[i] as number;
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
  const wrappers = new Map<string, WeakRef<object>>();
  // Callbacks: the function lives on its wrapper (a WeakMap entry), so wrapper -> closure is an edge
  // the collector sees; `held` roots a wrapper while the engine may still call it.
  const callbackFunctions = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>();
  const callbackNames = new Map<string, Set<string>>(); // by handle key, to clear on collection
  const held = new Set<object>(); // handed out since the last safe point: asked at the next one
  const settled = new Set<object>(); // the engine referenced it when asked: asked again a pass at a time
  const hold = (wrapper: object): void => {
    if (!settled.has(wrapper)) held.add(wrapper);
  };
  let cursor = settled.values(); // collect()'s place in `settled`
  let peak = 0; // the most wrappers settled since this pass of `cursor` began
  // userData is the game's: it lives with the wrapper, which `held` keeps while the engine references it.
  const userData = new WeakMap<object, unknown>();
  const shaderNodes = new Map<string, Map<string, unknown>>(); // material key -> slot -> TSL node
  // three's `attribute.array` is the attribute's own JS typed array (PRD-540): the array the
  // constructor was handed, or a copy of the engine's data on first read. A view of Wasm memory
  // would detach when the memory grows, so the shadow is a JS array. The shadow and the engine's
  // store are kept in step (PRD-617): an engine mutator copies back ONLY the range it wrote, so a
  // later game edit to the array wins, and `needsUpdate` sends the array to the engine. A read hands
  // the game the array, so the attribute is `pending` until its array is written back before the next
  // engine call (a per-vertex setter reads no kept array and flushes nothing).
  const { attributeArray, attributeWrite } = runtime;
  const arrays = new WeakMap<object, { array: TypedArray }>();
  const itemSizes = new WeakMap<object, number>();
  const pending = new Set<object>();
  const writeBack = (): void => {
    for (const attribute of pending) {
      const entry = arrays.get(attribute);
      if (entry !== undefined) attributeWrite?.call(runtime, refOf(attribute), entry.array);
    }
    pending.clear();
  };
  const itemSizeOf = (attribute: object): number => {
    let size = itemSizes.get(attribute);
    if (size === undefined) {
      size = Number(runtime.get(refOf(attribute), "itemSize"));
      itemSizes.set(attribute, size);
    }
    return size;
  };
  // The scalar range an attribute mutator wrote: derived from the method and its arguments, so the
  // engine syncs back only those elements. A component setter writes one, setXY/XYZ/XYZW an item's
  // lanes, copyAt a whole destination item.
  const lanes: Record<string, number> = { setX: 0, setY: 1, setZ: 2, setW: 3 };
  const rangeOf = (
    method: string,
    args: readonly unknown[],
    itemSize: number,
  ): readonly [number, number] => {
    const at = Number(args[0]) * itemSize;
    if (method === "copyAt") return [at, itemSize];
    const component = lanes[method];
    if (component !== undefined) return [at + component, 1];
    if (method === "setComponent") return [at + Number(args[1]), 1];
    return [at, method === "setXY" ? 2 : method === "setXYZ" ? 3 : 4];
  };
  const syncRange = (
    attribute: object,
    entry: { array: TypedArray },
    offset: number,
    count: number,
  ): void => {
    // A malformed range (a fraction, NaN, Infinity, a negative offset or a non-positive count) names
    // no element: it must fail, not slip to element 0 through subarray's own coercion. A range that
    // only runs past the end is the engine's documented bounds no-op (`setComponent`/`setRaw`
    // ignore it, as JS does), so there is nothing to read back. A required range read that comes
    // back missing or short is a provider fault, never a silently stale shadow.
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count <= 0)
      throw new RangeError(
        `TN_NATIVE_ATTRIBUTE_RANGE: [${String(offset)}, ${String(count)}) is not a valid element range`,
      );
    if (offset + count > entry.array.length) return;
    const fresh = attributeArray?.call(runtime, refOf(attribute), offset, count);
    if (fresh === undefined || fresh.length !== count)
      throw new TypeError(
        `TN_NATIVE_ATTRIBUTE_SYNC: attributeArray gave ${fresh === undefined ? "no array" : `${String(fresh.length)} elements`} for [${String(offset)}, ${String(count)})`,
      );
    entry.array.set(fresh, offset);
  };
  const syncFull = (attribute: object, entry: { array: TypedArray }): void => {
    const fresh = attributeArray?.call(runtime, refOf(attribute));
    if (fresh === undefined) return;
    if (fresh.length === entry.array.length) entry.array.set(fresh);
    else entry.array = fresh;
  };
  const released = new FinalizationRegistry<IEngineRef>((ref) => {
    if (wrappers.get(ref.key)?.deref() === undefined) {
      wrappers.delete(ref.key);
      shaderNodes.delete(ref.key); // the engine material keeps its graph; the JS nodes may go
      for (const name of callbackNames.get(ref.key) ?? []) runtime.setCallback(ref, name, null);
      callbackNames.delete(ref.key);
      runtime.release(ref);
    }
  });

  const adopt = (target: object, ref: IEngineRef): object => {
    (target as IWrapped)[REF] = ref;
    wrappers.set(ref.key, new WeakRef(target));
    released.register(target, ref);
    return target;
  };
  const wrap = (ref: IEngineRef): object => {
    const live = wrappers.get(ref.key)?.deref();
    if (live !== undefined) return live;
    const cls = byType.get(ref.type);
    if (cls === undefined)
      throw new TypeError(`TN_BROWSER_TYPE_UNKNOWN: no class for engine type ${ref.type}`);
    // Held until the next safe point decides: the engine may reference what it just handed out.
    const wrapper = adopt(Object.create(cls.prototype) as object, ref);
    if (cls.own !== undefined) defineOwn(wrapper, cls.own);
    hold(wrapper);
    return wrapper;
  };
  const refOf = (self: unknown): IEngineRef => {
    const ref = (self as Partial<IWrapped> | null)?.[REF];
    if (ref === undefined)
      throw new TypeError(
        "TN_BROWSER_NOT_ENGINE_OBJECT: called on an object the engine does not own",
      );
    return ref;
  };
  const toEngine = (value: unknown): EngineValue => {
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string")
      return value;
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
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
  const fromEngine = (value: EngineValue): unknown => {
    if (isRef(value)) return wrap(value);
    if (Array.isArray(value)) return value.map(fromEngine);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, fromEngine(item)]),
      );
    return value;
  };
  // A geometry bulk mutator (`translate`, `applyMatrix4`, `computeVertexNormals`, ...) writes the
  // bytes of its attributes. The engine already keeps the geometry's current attribute list, so the
  // wrapper enumerates it (one `__attributeNames` read, then a `getAttribute` each) rather than track
  // links that an engine-side attribute replacement would leave stale. A game's edit reaches the
  // engine before the call, and a kept array follows the transform after it.
  const geometryAttributes = (geometry: object): object[] => {
    const listed = runtime.get(refOf(geometry), "__attributeNames");
    if (typeof listed !== "string" || listed === "") return [];
    const found: object[] = [];
    for (const name of listed.split("\n")) {
      const attribute = fromEngine(runtime.invoke(refOf(geometry), "getAttribute", [name]));
      if (typeof attribute === "object" && attribute !== null) found.push(attribute);
    }
    return found;
  };
  const uploadGeometry = (geometry: object): void => {
    for (const attribute of geometryAttributes(geometry)) {
      const entry = arrays.get(attribute);
      if (entry !== undefined) attributeWrite?.call(runtime, refOf(attribute), entry.array);
    }
  };
  const refreshGeometry = (geometry: object): void => {
    for (const attribute of geometryAttributes(geometry)) {
      const entry = arrays.get(attribute);
      if (entry !== undefined) syncFull(attribute, entry);
    }
  };
  // Attribute methods that write only their own range, and the full-array transforms that read their
  // own data. A per-vertex setter must not flush a whole shadow (O(N) per call); a full transform
  // uploads its own shadow once before the call (O(N), bulk, as three reads its array).
  const rangeMethods = new Set([
    "setX",
    "setY",
    "setZ",
    "setW",
    "setXY",
    "setXYZ",
    "setXYZW",
    "setComponent",
    "copyAt",
  ]);
  const transformMethods = new Set([
    "applyMatrix3",
    "applyMatrix4",
    "applyNormalMatrix",
    "transformDirection",
  ]);
  // Geometry methods that write attribute bytes, so a kept shadow must be refreshed after them.
  const geometryWrites = new Set([
    "applyMatrix4",
    "translate",
    "rotateX",
    "rotateY",
    "rotateZ",
    "scale",
    "center",
    "computeVertexNormals",
    "normalizeNormals",
    "setFromPoints",
    "setIndex",
  ]);

  for (const [name, binding] of Object.entries(registry.classes)) {
    const adopts =
      attributeWrite !== undefined &&
      (name === "BufferAttribute" || name === "InstancedBufferAttribute");
    const attributeClass = ATTRIBUTE_CLASSES.has(name);
    const geometryClass = name.endsWith("Geometry");
    // three keeps a material's slots as own, enumerable fields, and the desktop host gives each
    // material instance its accessors as own ones. `for...in`, `Object.keys` and `Object.values` find
    // them on the web too: core's node-twin copy loops and "dispose every texture" rely on that.
    const materialClass = name.endsWith("Material");
    const own: IOwnField[] = [];
    const engineClass = class {
      constructor(...args: unknown[]) {
        if (!binding.constructor) throw new TypeError(`TN_BROWSER_NOT_CONSTRUCTIBLE: ${name}`);
        // three's parameters object (`new MeshStandardMaterial({ color })`) is construct, then
        // setValues, which the wrapper applies key by key. Other classes take an options object as
        // a record argument (ExtrudeGeometry).
        const parameters =
          name.endsWith("Material") && isPlainObject(args.at(-1))
            ? (args.at(-1) as object)
            : undefined;
        const engineArgs = parameters === undefined ? args : args.slice(0, -1);
        adopt(this, runtime.construct(name, engineArgs.map(toEngine)));
        if (materialClass) defineOwn(this, own);
        if (parameters !== undefined) setValues(this, name, parameters);
        // three's BufferAttribute keeps the typed array it is handed; the typed subclasses copy.
        const handed = args[0];
        if (adopts && ArrayBuffer.isView(handed) && !(handed instanceof DataView)) {
          arrays.set(this, { array: handed as TypedArray });
          itemSizes.set(this, Number(args[1]));
          pending.add(this);
        }
      }
    };
    const valueClass = math[name];
    const cls = (valueClass ?? engineClass) as typeof engineClass;
    Object.defineProperty(cls, "name", { value: name });
    const prototype = cls.prototype as Record<string, unknown>;
    // A value class's engine accessors (its lanes, `__address`) live on the engine side only.
    const accessors = (valueClass === undefined ? prototype : Object.create(prototype)) as Record<
      string,
      unknown
    >;
    // Engine properties a class's own view already names: the generic accessors stay off them.
    const skip = new Set<string>();
    if (valueClass !== undefined) {
      const info: IValueClass = {
        name,
        engine: accessors,
        pool: [],
        top: 0,
        plan: valuePlans[name] ?? defaultPlan(Object.keys(binding.fields ?? {})),
      };
      valueClasses.set(prototype, info);
      // Box3 and Sphere build their default members from three's own Vector3 module, not the
      // hand-written class; both are the same value and cross the same way.
      if (name === "Vector3") valueClasses.set(UpstreamVector3.prototype, info);
      defineValueView(name, accessors, binding, skip);
    }
    for (const method of binding.methods) {
      if (valueClass !== undefined && Object.hasOwn(prototype, method)) continue;
      // A geometry's attribute lookups are kept with its labels, until anything else runs on it.
      const query = method === "getAttribute" || method === "hasAttribute";
      // A read-only method keeps them too: core's projection asks each mesh __tnVisibleInWorld a frame,
      // and dropping the labels there re-crossed and re-kept every mesh's geometry and material each frame.
      const keeps = query || /^(get|has|clone|equals|toJSON|__tnVisibleInWorld$)/u.test(method);
      // PRD-617 shadows. Apart from an attribute's own range, an engine mutator touches the game's
      // kept arrays: a geometry transform sends and refreshes its attributes' shadows. The three
      // kinds are exclusive, so an attribute setter never enumerates a geometry and vice versa.
      const rangeMethod = attributeClass && rangeMethods.has(method);
      const transformMethod = attributeClass && transformMethods.has(method);
      const geometryWrite = geometryClass && geometryWrites.has(method);
      Object.defineProperty(prototype, method, {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]) {
          // three's toArray(array, offset) writes the lanes into the array it is given and answers that array; the
          // engine answers a new one, since a plain array crosses by value.
          if (method === "toArray" && args[0] !== undefined) {
            const target = args[0] as number[];
            const start = (args[1] as number | undefined) ?? 0;
            const lanes = (prototype.toArray as () => unknown[]).call(this);
            for (let i = 0; i < lanes.length; i++) target[start + i] = lanes[i] as number;
            return target;
          }
          const intersections = method === "intersectObject" || method === "intersectObjects";
          const key = query ? `${method} ${String(args[0])}` : "";
          if (query && labels.get(this)?.has(key)) return labels.get(this)?.get(key);
          // A per-vertex setter writes its own range and reads no kept array, so a whole-shadow flush
          // would cost O(N) a call; it syncs just its range back below. Anything else flushes edits.
          if (pending.size > 0 && !rangeMethod) writeBack();
          // A full-array attribute transform reads its own array: send the game's shadow first.
          if (transformMethod) {
            const entry = arrays.get(this);
            if (entry !== undefined) attributeWrite?.call(runtime, refOf(this), entry.array);
          }
          if (geometryWrite) uploadGeometry(this);
          // copyAt reads the source attribute's item: send that item first, then the engine copies it.
          if (
            rangeMethod &&
            method === "copyAt" &&
            typeof args[1] === "object" &&
            args[1] !== null
          ) {
            const source = args[1] as object;
            const entry = arrays.get(source);
            if (entry !== undefined) {
              const item = itemSizeOf(source) * Number(args[2]);
              attributeWrite?.call(
                runtime,
                refOf(source),
                entry.array.subarray(item, item + itemSizeOf(source)),
                item,
              );
            }
          }
          if (!keeps) labels.delete(this);
          const mark = loans.length;
          let result: unknown;
          try {
            result = fromEngine(
              runtime.invoke(
                refOf(this),
                method,
                toEngineArgs(intersections ? args.slice(0, 2) : args),
              ),
            );
          } finally {
            if (loans.length > mark) result = repay(mark, result);
          }
          // The engine wrote only this range: copy it back, so a later game edit to the shadow wins.
          if (rangeMethod) {
            const entry = arrays.get(this);
            if (entry !== undefined) {
              const [offset, count] = rangeOf(method, args, itemSizeOf(this));
              syncRange(this, entry, offset, count);
            }
          } else if (transformMethod) {
            const entry = arrays.get(this);
            if (entry !== undefined) syncFull(this, entry);
          } else if (geometryWrite) refreshGeometry(this);
          if (intersections && args[2] !== undefined) {
            if (!Array.isArray(args[2]) || !Array.isArray(result))
              throw new TypeError("intersection target must be an array");
            args[2].push(...result);
            args[2].sort((a, b) => a.distance - b.distance);
            return args[2];
          }
          if (query)
            labels.get(this)?.set(key, result) ?? labels.set(this, new Map([[key, result]]));
          return result;
        },
      });
    }
    // A transform matrix (`mesh.matrixWorld`, a projection's kept copy) is 16 doubles at an engine address:
    // copy and equals between two engine matrices run over that memory, not as engine calls (PRD-573 web
    // cut 2, the web side of the desktop's TransformPage views). Anything else takes the engine method.
    const elements = binding.fields?.elements;
    const heapF64 = runtime.heapF64;
    if (
      valueClass === undefined &&
      elements !== undefined &&
      heapF64 !== undefined &&
      binding.methods.includes("copy")
    ) {
      const [offset = 0, count = 0] = elements;
      const engineCopy = prototype.copy as (this: object, other: unknown) => object;
      const engineEquals = prototype.equals as (this: object, other: unknown) => boolean;
      Object.defineProperties(prototype, {
        copy: {
          configurable: true,
          writable: true,
          value(this: object, other: unknown) {
            if (
              other === null ||
              typeof other !== "object" ||
              Object.getPrototypeOf(other) !== prototype
            )
              return engineCopy.call(this, other);
            const from = (addressOf(other) + offset) / 8;
            heapF64().copyWithin((addressOf(this) + offset) / 8, from, from + count);
            return this;
          },
        },
        equals: {
          configurable: true,
          writable: true,
          value(this: object, other: unknown) {
            if (
              other === null ||
              typeof other !== "object" ||
              Object.getPrototypeOf(other) !== prototype
            )
              return engineEquals.call(this, other);
            const heap = heapF64();
            const a = (addressOf(this) + offset) / 8;
            const b = (addressOf(other) + offset) / 8;
            for (let i = 0; i < count; i++) if (heap[a + i] !== heap[b + i]) return false;
            return true;
          },
        },
      });
    }
    const setters = new Set(binding.setters);
    // A node material's TSL slots (`colorNode`) take an engine graph node, which no ABI value
    // carries: the graph goes in through the TSL runtime, and reading the slot answers the node set.
    for (const property of binding.setters.filter((key) => /^[a-z]+Node$/u.test(key))) {
      Object.defineProperty(prototype, property, {
        configurable: true,
        get(this: object) {
          return shaderNodes.get(refOf(this).key)?.get(property) ?? null;
        },
        set(this: object, value: unknown) {
          const ref = refOf(this);
          if (property === "filterNode") {
            runtime.set(ref, property, shadowFilterOptions(value));
            const slots = shaderNodes.get(ref.key) ?? new Map<string, unknown>();
            shaderNodes.set(ref.key, slots.set(property, value));
            return;
          }
          if (property === "shadowNode") {
            if (shaderNodes.get(ref.key)?.get(property) === value) return;
            const options = virtualShadowOptions(value, (command) =>
              runtime.set(
                ref,
                property,
                Object.fromEntries(
                  Object.entries(command).map(([key, item]) => [key, toEngine(item)]),
                ),
              ),
            );
            runtime.set(
              ref,
              property,
              options === null
                ? null
                : Object.fromEntries(
                    Object.entries(options).map(([key, item]) => [key, toEngine(item)]),
                  ),
            );
            const slots = shaderNodes.get(ref.key) ?? new Map<string, unknown>();
            if (slots.get(property) !== value) detachVirtualShadow(slots.get(property));
            shaderNodes.set(ref.key, slots.set(property, value));
            return;
          }
          if (value === null) {
            runtime.set(ref, property, null);
            shaderNodes.get(ref.key)?.delete(property);
            return;
          }
          if (typeof value !== "object" || !(TSL_NODE in value) || !runtime.tsl)
            throw new TypeError(`TN_BROWSER_SHADER_NODE: ${name}.${property} takes a TSL node`);
          runtime.tsl.set(ref, property, (value as Record<symbol, number>)[TSL_NODE] as number);
          const slots = shaderNodes.get(ref.key) ?? new Map<string, unknown>();
          shaderNodes.set(ref.key, slots.set(property, value));
        },
      });
    }
    // A list getter with indexed setters (`morphTargetInfluences.0`) is a live array, as on the V8 adapter:
    // an index write and a whole-array assignment (core's projection shares the source's) reach the engine.
    const indexed = (head: string) =>
      binding.setters.some(
        (path) => path.startsWith(`${head}.`) && /^\d+$/u.test(path.slice(head.length + 1)),
      );
    for (const property of binding.getters) {
      if (
        property.includes(".") ||
        setters.has(property) ||
        skip.has(property) ||
        !indexed(property)
      )
        continue;
      Object.defineProperty(prototype, property, {
        configurable: true,
        get(this: object) {
          const ref = refOf(this);
          const list = fromEngine(runtime.get(ref, property));
          if (!Array.isArray(list)) return list;
          return new Proxy(list, {
            set(target, key, value) {
              target[key as never] = value as never;
              if (typeof key === "string" && /^\d+$/u.test(key))
                runtime.set(ref, `${property}.${key}`, toEngine(value));
              return true;
            },
          });
        },
        set(this: object, value: ArrayLike<number>) {
          const ref = refOf(this);
          for (let index = 0; index < value.length; index++)
            runtime.set(ref, `${property}.${index}`, value[index] as number);
        },
      });
    }
    const write = runtime.writeDouble;
    for (const property of [...binding.getters, ...binding.members]) {
      if (
        property.includes(".") ||
        binding.methods.includes(property) ||
        Object.hasOwn(accessors, property) ||
        skip.has(property)
      )
        continue;
      // A value class's lane is written in place: its engine setter is a plain store.
      const lane = valueClass !== undefined ? binding.fields?.[property] : undefined;
      const flagField = binding.fields?.[property];
      const peek = runtime.readByte;
      const flag =
        flagField !== undefined && flagField[1] === 0 && peek !== undefined
          ? (self: object): boolean => peek(addressOf(self) + (flagField[0] ?? 0)) !== 0
          : undefined;
      const accessor: PropertyDescriptor = {
        configurable: true,
        get:
          fastGetter(binding, property) ??
          (name === "AnimationMixer" && property === "stats"
            ? function (this: object) {
                let stats = mixerStats.get(this);
                if (stats !== undefined) return stats;
                const count = (name: string) => {
                  const read = (field: "total" | "inUse") => {
                    const counts = (
                      runtime.get(refOf(this), "stats") as Record<
                        string,
                        Record<string, number> | undefined
                      >
                    )[name];
                    if (counts === undefined)
                      throw new TypeError(`TN_BROWSER_STATS_MISSING: ${name}`);
                    return counts[field];
                  };
                  return Object.defineProperties(
                    {},
                    {
                      total: { get: () => read("total"), enumerable: true, configurable: true },
                      inUse: { get: () => read("inUse"), enumerable: true, configurable: true },
                    },
                  );
                };
                stats = {
                  actions: count("actions"),
                  bindings: count("bindings"),
                  controlInterpolants: count("controlInterpolants"),
                };
                mixerStats.set(this, stats);
                return stats;
              }
            : undefined) ??
          (labelled.has(property)
            ? function (this: object) {
                let known = labels.get(this);
                if (known === undefined) {
                  known = new Map();
                  labels.set(this, known);
                }
                if (!known.has(property))
                  known.set(property, fromEngine(runtime.get(refOf(this), property)));
                return known.get(property);
              }
            : function (this: object) {
                return fromEngine(runtime.get(refOf(this), property));
              }),
        ...(lane !== undefined && write !== undefined
          ? {
              set(this: object, value: number) {
                write(addressOf(this) + (lane[0] ?? 0), value);
              },
            }
          : setters.has(property)
            ? {
                set(this: object, value: unknown) {
                  // A flag write of the value the flag holds changes nothing in the engine: a game
                  // writes `visible` on hundreds of nodes a frame, so those stay out of the bridge.
                  if (flag !== undefined && typeof value === "boolean" && flag(this) === value)
                    return;
                  labels.delete(this);
                  runtime.set(refOf(this), property, toEngine(value));
                },
              }
            : {}),
      };
      Object.defineProperty(accessors, property, accessor);
      if (materialClass) own.push({ key: property, descriptor: { ...accessor, enumerable: true } });
    }
    // A dotted path whose head is no member of its own (three's plain `morphAttributes` object) is
    // a holder made per read, as the V8 adapter makes it: each tail reads and writes the full path.
    const holders = new Map<string, string[]>();
    // A getter-only head (three's `drawRange`) is a holder too, when every path under it is one level deep.
    const flatGetters = binding.getters.filter(
      (path) =>
        path.indexOf(".") === path.lastIndexOf(".") &&
        !binding.getters
          .concat(binding.members)
          .some(
            (other) =>
              other.startsWith(`${path.slice(0, path.indexOf("."))}.`) &&
              other.split(".").length > 2,
          ),
    );
    for (const path of new Set([...binding.setters, ...flatGetters])) {
      const dot = path.indexOf(".");
      if (dot < 0) continue;
      const head = path.slice(0, dot);
      if (binding.members.includes(head) || binding.getters.includes(head)) continue;
      const tails = holders.get(head) ?? [];
      if (!tails.includes(path)) tails.push(path);
      holders.set(head, tails);
    }
    for (const [head, paths] of holders) {
      Object.defineProperty(prototype, head, {
        configurable: true,
        get(this: object) {
          const ref = refOf(this);
          const holder = {};
          for (const path of paths) {
            const readable = binding.members.includes(path) || binding.getters.includes(path);
            Object.defineProperty(holder, path.slice(head.length + 1), {
              enumerable: true,
              ...(readable ? { get: () => fromEngine(runtime.get(ref, path)) } : {}),
              ...(setters.has(path)
                ? { set: (value: unknown) => runtime.set(ref, path, toEngine(value)) }
                : {}),
            });
          }
          return holder;
        },
      });
    }
    // A write-only setter (three's `texture.needsUpdate`) is a property too: without an accessor
    // the write lands on a plain JS property and never reaches the engine.
    for (const property of binding.setters) {
      if (property.includes(".") || Object.hasOwn(accessors, property) || skip.has(property))
        continue;
      Object.defineProperty(accessors, property, {
        configurable: true,
        set(this: object, value: unknown) {
          runtime.set(refOf(this), property, toEngine(value));
        },
      });
    }
    for (const callback of binding.callbacks) {
      Object.defineProperty(prototype, callback, {
        configurable: true,
        get(this: object) {
          return callbackFunctions.get(this)?.get(callback) ?? null;
        },
        set(this: object, fn: unknown) {
          const ref = refOf(this);
          const functions = callbackFunctions.get(this) ?? new Map();
          if (fn === null || fn === undefined) {
            runtime.setCallback(ref, callback, null);
            functions.delete(callback);
            callbackNames.get(ref.key)?.delete(callback);
            return;
          }
          if (typeof fn !== "function")
            throw new TypeError(`${callback} must be a function or null`);
          const self = new WeakRef(this);
          runtime.setCallback(ref, callback, (args) => {
            const target = self.deref();
            const current =
              target === undefined ? undefined : callbackFunctions.get(target)?.get(callback);
            current?.apply(target, args.map(fromEngine));
          });
          functions.set(callback, fn as (...args: unknown[]) => unknown);
          callbackFunctions.set(this, functions);
          callbackNames.set(ref.key, (callbackNames.get(ref.key) ?? new Set()).add(callback));
          hold(this);
        },
      });
    }
    // three's EventDispatcher, as the V8 adapter keeps it: listeners live in JS, and the engine
    // calls back once per native event type something listens to; `target` is set while they run.
    if (binding.methods.includes("addEventListener")) {
      const native = new Set(binding.events ?? []);
      type Listener = (this: object, event: Record<string, unknown>) => void;
      const listeners = new WeakMap<object, Map<string, Listener[]>>();
      const dispatch = (target: object, event: Record<string, unknown>): void => {
        const list = listeners.get(target)?.get(String(event.type));
        if (list === undefined) return;
        event.target = target;
        for (const listener of [...list]) listener.call(target, event);
        event.target = null;
      };
      const listenerArgs = (name: string, type: unknown, listener: unknown): Listener => {
        if (typeof type !== "string" || typeof listener !== "function")
          throw new TypeError(`${name} needs a type and a function`);
        return listener as Listener;
      };
      Object.defineProperties(prototype, {
        addEventListener: {
          configurable: true,
          writable: true,
          value(this: object, type: unknown, fn: unknown): void {
            const listener = listenerArgs("addEventListener", type, fn);
            const table = listeners.get(this) ?? new Map<string, Listener[]>();
            listeners.set(this, table);
            let list = table.get(type as string);
            if (list === undefined) {
              list = [];
              table.set(type as string, list);
              if (native.has(type as string)) {
                const ref = refOf(this);
                const self = new WeakRef(this);
                runtime.setCallback(ref, type as string, (args) => {
                  const target = self.deref();
                  if (target !== undefined)
                    dispatch(target, fromEngine(args[0] as EngineValue) as Record<string, unknown>);
                });
                callbackNames.set(
                  ref.key,
                  (callbackNames.get(ref.key) ?? new Set()).add(type as string),
                );
                hold(this);
              }
            }
            if (!list.includes(listener)) list.push(listener);
          },
        },
        hasEventListener: {
          configurable: true,
          writable: true,
          value(this: object, type: unknown, fn: unknown): boolean {
            const listener = listenerArgs("hasEventListener", type, fn);
            return (
              listeners
                .get(this)
                ?.get(type as string)
                ?.includes(listener) ?? false
            );
          },
        },
        removeEventListener: {
          configurable: true,
          writable: true,
          value(this: object, type: unknown, fn: unknown): void {
            const listener = listenerArgs("removeEventListener", type, fn);
            const table = listeners.get(this);
            const list = table?.get(type as string);
            if (table === undefined || list === undefined || !list.includes(listener)) return;
            list.splice(list.indexOf(listener), 1);
            if (list.length > 0) return;
            table.delete(type as string);
            if (native.has(type as string)) {
              const ref = refOf(this);
              runtime.setCallback(ref, type as string, null);
              callbackNames.get(ref.key)?.delete(type as string);
            }
          },
        },
        dispatchEvent: {
          configurable: true,
          writable: true,
          value(this: object, event: unknown): void {
            if (typeof event !== "object" || event === null)
              throw new TypeError("dispatchEvent needs an event object");
            dispatch(this, event as Record<string, unknown>);
          },
        },
      });
    }
    const graphNode = binding.members.includes("parent") || binding.getters.includes("parent");
    // three gives Object3D, Material, Texture and BufferGeometry a `userData`; the engine classes
    // with a parent or a `dispose` are those.
    if (graphNode || binding.methods.includes("dispose")) {
      Object.defineProperty(prototype, "userData", {
        configurable: true,
        get(this: object) {
          if (!userData.has(this)) userData.set(this, {});
          return userData.get(this);
        },
        set(this: object, value: unknown) {
          userData.set(this, value);
        },
      });
    }
    if (graphNode) {
      defineTraversal(
        prototype,
        name,
        binding.members.includes("children") || binding.getters.includes("children"),
        binding.methods.includes("__walk"),
      );
    }
    classes[name] = cls;
    byType.set(runtime.typeId(name), { prototype: accessors, ...(materialClass ? { own } : {}) });
    typeNames.set(runtime.typeId(name), name);
  }
  for (const name of ATTRIBUTE_CLASSES) {
    const cls = classes[name];
    if (cls !== undefined) withUpdateRanges(cls.prototype);
  }
  if (attributeArray !== undefined && attributeWrite !== undefined) {
    for (const name of ATTRIBUTE_CLASSES) {
      const cls = classes[name];
      if (cls === undefined) continue;
      Object.defineProperty(cls.prototype, "array", {
        configurable: true,
        get(this: object) {
          let entry = arrays.get(this);
          if (entry === undefined) {
            entry = { array: attributeArray.call(runtime, refOf(this)) };
            arrays.set(this, entry);
          }
          // A storage attribute's array is its initial contents: a kernel writes the GPU copy, never this array,
          // so reading it is not an edit, and writing it back would overwrite the kernel's result.
          const flags = this as {
            isStorageBufferAttribute?: boolean;
            isStorageInstancedBufferAttribute?: boolean;
          };
          if (!flags.isStorageBufferAttribute && !flags.isStorageInstancedBufferAttribute)
            pending.add(this);
          return entry.array;
        },
      });
      // needsUpdate is a property write, not a call: it hands the shadow to the engine as it stands.
      const needsUpdate = Object.getOwnPropertyDescriptor(cls.prototype, "needsUpdate");
      if (needsUpdate?.set !== undefined)
        Object.defineProperty(cls.prototype, "needsUpdate", {
          ...needsUpdate,
          set(this: object, value: unknown) {
            const entry = arrays.get(this);
            if (value === true && entry !== undefined) {
              attributeWrite.call(runtime, refOf(this), entry.array);
              pending.delete(this);
            }
            needsUpdate.set?.call(this, value);
          },
        });
    }
  }
  const entries = new Map((catalog?.entries ?? []).map((entry) => [entry.name, entry]));
  const isFlag = (field: { name: string; type: string; mutable?: boolean }) =>
    /^is[A-Z]/u.test(field.name) &&
    (field.type === "true" || (field.type === "boolean" && field.mutable === false));
  for (const [name, cls] of Object.entries(classes)) {
    const entry = entries.get(name);
    const parent = entry?.extends ? classes[entry.extends] : undefined;
    if (parent !== undefined) Object.setPrototypeOf(cls.prototype, parent.prototype);
    // Flags come from the whole chain: `Material` is unbound, yet a material is `isMaterial`.
    for (
      let link = entry;
      link !== undefined;
      link = link.extends ? entries.get(link.extends) : undefined
    )
      // Writable: three's own value classes assign `this.isColor = true` in their constructors.
      for (const field of (link.fields ?? []).filter(isFlag))
        Object.defineProperty(cls.prototype, field.name, {
          configurable: true,
          writable: true,
          value: true,
        });
  }
  return {
    classes,
    wrap,
    crossings: () => crossings,
    collect() {
      // A wrapper handed out since the last safe point is asked now: the engine either references it (it
      // settles) or does not (JS alone keeps it). A settled wrapper is asked again a sixty-fourth of the
      // settled set per safe point, round robin (a live Set iterator): Midway settles about 50,000
      // scene-attached wrappers, and asking an eighth of them every frame cost 2.5 ms of a 21 ms frame.
      // The sixty-fourth is of the pass's peak, so releases during a pass do not shrink it: a wrapper the
      // engine lets go is asked within two passes (tests/browser-backend-gc.ts). Holding a wrapper a
      // little longer only delays its release.
      peak = Math.max(peak, settled.size);
      const budget = Math.ceil(peak / SETTLED_PASS);
      const candidates: object[] = [...held];
      const fresh = candidates.length;
      while (candidates.length < fresh + budget) {
        const next = cursor.next();
        if (!next.done) {
          candidates.push(next.value);
          continue;
        }
        cursor = settled.values();
        peak = settled.size;
        // An emptied set would restart forever: a safe point that let the last wrapper go hung here.
        if (candidates.length > fresh || settled.size === 0) break;
      }
      const counts = runtime.engineReferences?.(candidates.map(refOf));
      candidates.forEach((wrapper, i) => {
        const referenced =
          counts !== undefined
            ? (counts[i] as number) > 0
            : callbackNames.has(refOf(wrapper).key) &&
              runtime.get(refOf(wrapper), "parent") !== null;
        if (i < fresh) {
          held.delete(wrapper);
          if (referenced) settled.add(wrapper);
        } else if (!referenced) settled.delete(wrapper);
      });
    },
  };
}

/**
 * The engine's C ABI as built by `tn-native-engine-abi-module` (Emscripten, wasm32). The names are
 * Emscripten's (`HEAPU8`, `_malloc`, `_tn_*`), so they are declared as record keys.
 */
type AbiCall =
  | "_malloc"
  | "_free"
  | "_tn_engine_version"
  | "_tn_context_create"
  | "_tn_type_id"
  | "_tn_object_release"
  | "_tn_object_engine_references"
  | "_tn_construct"
  | "_tn_invoke"
  | "_tn_get"
  | "_tn_set"
  | "_tn_set_callback"
  | "_tn_diagnostic_release";
export type TnAbiModule = Record<AbiCall, (...args: number[]) => number> &
  Partial<
    Record<"_tnw_attribute_view" | "_tnw_attribute_view_release", (...args: number[]) => number>
  > &
  Record<"HEAPU8", Uint8Array> &
  Record<"HEAPF64", Float64Array> &
  Record<"UTF8ToString", (pointer: number, maxBytes?: number) => string> &
  Record<
    "addFunction",
    (fn: (...args: number[]) => number | undefined, signature: string) => number
  > & {
    stringToUTF8(text: string, pointer: number, maxBytes: number): void;
    lengthBytesUTF8(text: string): number;
  };

// wasm32 layouts of tn_abi.h, measured with offsetof under emcc: tn_handle_t 12 bytes; tn_value_t
// 56 bytes (kind 0, boolean 4, number 8, handle 16, text 32, count 40, numbers 48); tn_diagnostic_t
// 8 bytes (message 0, code 4); tn_version_info_t 32 bytes. A struct passed by value goes by pointer.
const HANDLE = 12;
const VALUE = 56;
const KIND = {
  null: 0,
  number: 1,
  bool: 2,
  string: 3,
  handle: 4,
  numbers: 5,
  array: 6,
  record: 7,
  undefined: 8,
} as const;

// wasm32 layout of tn_tsl_arg_t (tn_tsl.h): kind 0, lanes 4, node 8 (u64), number 16, text 24,
// numbers 32 (four f64); 64 bytes. A handle argument's 12 bytes start at lanes (4) and run through node.
const TSL_ARG = 64;
const TSL_KIND = {
  node: 0,
  number: 1,
  string: 2,
  named: 3,
  rgb: 4,
  vector: 5,
  other: 6,
  handle: 7,
} as const;
type TslCall =
  | "_tn_tsl_call"
  | "_tn_tsl_release"
  | "_tn_tsl_set"
  | "_tn_tsl_set_uniform"
  | "_tn_tsl_effect_parameter"
  | "_tnw_web_set_post"
  | "_tnw_web_compute"
  | "_tnw_web_compute_flush"
  | "_tnw_web_read_storage"
  | "_tnw_web_read_storage_size"
  | "_tnw_web_read_storage_take"
  | "_tnw_web_delete_storage"
  | "_tnw_web_poll"
  | "_tnw_web_error";

interface IAbiHelpers {
  scoped<T>(work: () => T): T;
  alloc(size: number): number;
  string(text: string): { pointer: number; bytes: number };
  diagnostic(): number;
  check(status: number, diag: number, what: string): void;
  handleOf(ref: IEngineRef): number;
  writeHandle(pointer: number, ref: IEngineRef): void;
  view(): DataView;
}

/** The engine glTF loader over the product web host's `tnw_web_load_gltf`, when the module has it. */
function gltfOf(
  abi: TnAbiModule,
  context: number,
  h: Pick<IAbiHelpers, "scoped" | "alloc"> & { keyOf(pointer: number): IEngineRef },
): Pick<IBrowserRuntime, "loadGltf"> {
  // quality-allow: the Emscripten module is read through the exports this call site names, not its full surface.
  const host = abi as unknown as Partial<
    Record<
      | "_tnw_web_load_gltf"
      | "_tnw_web_load_error"
      | "_tnw_web_gltf_file"
      | "_tnw_web_gltf_files_clear",
      (...args: number[]) => number
    >
  >;
  const {
    _tnw_web_load_gltf: load,
    _tnw_web_load_error: error,
    _tnw_web_gltf_file: file,
    _tnw_web_gltf_files_clear: clearFiles,
  } = host;
  if (load === undefined || error === undefined) return {};
  return {
    loadGltf: (bytes, files) =>
      h.scoped(() => {
        // Files the model names by relative uri (shared images), read by the engine loader.
        if (files !== undefined && files.size > 0) {
          if (file === undefined || clearFiles === undefined)
            throw new Error(
              "TN_WASM_GLTF_FILES_UNAVAILABLE: this web engine cannot read a model's image files",
            );
          for (const [uri, content] of files) {
            const name = h.alloc(abi.lengthBytesUTF8(uri) + 1);
            abi.stringToUTF8(uri, name, abi.lengthBytesUTF8(uri) + 1);
            const copy = h.alloc(Math.max(1, content.byteLength));
            abi.HEAPU8.set(content, copy);
            file(name, copy, content.byteLength);
          }
        }
        try {
          const data = h.alloc(Math.max(1, bytes.byteLength));
          abi.HEAPU8.set(bytes, data);
          const count = h.alloc(4);
          // Retried once with the exact size when the model has more clips than the first guess.
          for (let capacity = 64; ; ) {
            const out = h.alloc(HANDLE * capacity);
            const status = load(context, data, bytes.byteLength, out, capacity, count);
            const needed = new DataView(abi.HEAPU8.buffer).getUint32(count, true);
            if (status === 0) {
              const refs = Array.from({ length: needed }, (_, i) => h.keyOf(out + i * HANDLE));
              return { scene: refs[0] as IEngineRef, animations: refs.slice(1) };
            }
            const reason = abi.UTF8ToString(error());
            if (reason !== "TN_WASM_GLTF_CAPACITY" || needed <= capacity) throw new Error(reason);
            capacity = needed;
          }
        } finally {
          clearFiles?.();
        }
      }),
  };
}

/** TSL by name over `tn_tsl_call`, when the module exports it (the product web host does). */
function tslOf(
  abi: TnAbiModule,
  context: number,
  h: IAbiHelpers,
): { tsl: ITslRuntime } | undefined {
  // Node ids are u64 in the C ABI; Emscripten passes a 64-bit parameter as a BigInt.
  // quality-allow: the Emscripten module is read through the TSL call exports this call site names, not its full surface.
  const calls = abi as unknown as Partial<
    Record<TslCall, (...args: (number | bigint)[]) => number>
  >;
  const {
    _tn_tsl_call: call,
    _tn_tsl_release: release,
    _tn_tsl_set: set,
    _tn_tsl_set_uniform: setUniform,
    _tn_tsl_effect_parameter: effectParameter,
    _tnw_web_set_post: setPost,
    _tnw_web_compute: computeNode,
    _tnw_web_compute_flush: computeFlush,
    _tnw_web_read_storage: readStorage,
    _tnw_web_read_storage_size: readStorageSize,
    _tnw_web_read_storage_take: readStorageTake,
    _tnw_web_delete_storage: deleteStorage,
    _tnw_web_poll: poll,
    _tnw_web_error: webError,
  } = calls;
  if (
    call === undefined ||
    release === undefined ||
    set === undefined ||
    setUniform === undefined ||
    effectParameter === undefined
  )
    return undefined;
  // Writes tn_tsl_arg_t values; text is allocated first, since an allocation can grow the memory.
  const writeArgs = (args: readonly TslArgValue[]): number => {
    const pointer = h.alloc(Math.max(TSL_ARG, args.length * TSL_ARG));
    args.forEach((arg, i) => {
      const at = pointer + i * TSL_ARG;
      const text = arg.kind === "string" || arg.kind === "named" ? h.string(arg.text).pointer : 0;
      const v = h.view();
      v.setUint32(at, TSL_KIND[arg.kind], true);
      if (arg.kind === "node") v.setBigUint64(at + 8, BigInt(arg.node), true);
      else if (arg.kind === "number") v.setFloat64(at + 16, arg.number, true);
      else if (arg.kind === "rgb" || arg.kind === "vector") {
        v.setUint32(at + 4, arg.numbers.length, true);
        arg.numbers.forEach((c, j) => v.setFloat64(at + 32 + j * 8, c, true));
      } else if (arg.kind === "handle") h.writeHandle(at + 4, arg.ref);
      else v.setUint32(at + 24, text, true);
    });
    return pointer;
  };
  const nodeOf = (node: number | null): number => {
    if (node === null) return 0;
    const pointer = h.alloc(8);
    h.view().setBigUint64(pointer, BigInt(node), true);
    return pointer;
  };
  return {
    tsl: {
      call: (name, receiver, args) =>
        h.scoped(() => {
          const pointer = writeArgs(args);
          const self = nodeOf(receiver);
          const out = h.alloc(8);
          const diag = h.diagnostic();
          h.check(
            call(context, h.string(name).pointer, self, pointer, args.length, out, diag),
            diag,
            `TSL ${name}`,
          );
          return Number(h.view().getBigUint64(out, true));
        }),
      release: (node) =>
        h.scoped(() => {
          const diag = h.diagnostic();
          release(context, BigInt(node), diag);
          abi._tn_diagnostic_release(diag);
        }),
      set: (material, path, node) =>
        h.scoped(() => {
          const diag = h.diagnostic();
          h.check(
            set(context, h.handleOf(material), h.string(path).pointer, BigInt(node), diag),
            diag,
            `set ${path}`,
          );
        }),
      effectParameter: (node, name, value) =>
        h.scoped(() => {
          const self = nodeOf(node);
          const input = value === undefined ? 0 : h.alloc(8);
          if (value !== undefined) h.view().setFloat64(input, value, true);
          const out = h.alloc(8);
          const diag = h.diagnostic();
          h.check(
            effectParameter(context, self, h.string(name).pointer, input, out, diag),
            diag,
            `effect ${name}`,
          );
          return h.view().getFloat64(out, true);
        }),
      // three's RenderPipeline on the product web host: the graph between scene and output.
      setPost: (node) =>
        h.scoped(() => {
          if (setPost === undefined) throw new Error("TN_WASM_POST: this module has no web host");
          if (setPost(context, nodeOf(node), 0) !== 0) throw new Error("TN_WASM_POST: refused");
        }),
      setToneMapping: (node) =>
        h.scoped(() => {
          if (setPost === undefined)
            throw new Error("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING: no web output binding");
          if (setPost(context, nodeOf(node), 1) !== 0)
            throw new Error("TN_NATIVE_CUSTOM_TONEMAPPING_INVALID: refused output node");
        }),
      // PRD-620: renderer.compute and storage reads over the product web host.
      compute: (node) =>
        h.scoped(() => {
          if (computeNode === undefined || webError === undefined)
            throw new Error("TN_WASM_COMPUTE: this module has no web host");
          if (computeNode(context, nodeOf(node)) !== 0)
            throw new Error(abi.UTF8ToString(webError()));
        }),
      readStorage: async (attribute) => {
        if (
          readStorage === undefined ||
          readStorageSize === undefined ||
          readStorageTake === undefined ||
          computeFlush === undefined ||
          poll === undefined ||
          webError === undefined
        )
          throw new Error("TN_WASM_COMPUTE: this module has no web host");
        const id = h.scoped(() => {
          const pointer = h.alloc(HANDLE);
          h.writeHandle(pointer, attribute);
          return readStorage(pointer);
        });
        if (id === 0) throw new Error(abi.UTF8ToString(webError()));
        computeFlush();
        for (;;) {
          poll();
          const size = readStorageSize(id);
          if (size > 0 || readStorageTake(id, 0, 0) < 0) {
            const out = abi._malloc(size) >>> 0;
            try {
              if (readStorageTake(id, out, size) === 1)
                return abi.HEAPU8.slice(out, out + size).buffer;
            } finally {
              abi._free(out);
            }
            throw new Error("TN_NATIVE_READ_STORAGE: the read failed");
          }
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      deleteStorage: (attribute) =>
        h.scoped(() => {
          if (deleteStorage === undefined || webError === undefined)
            throw new Error("TN_WASM_COMPUTE: this module has no web host");
          const pointer = h.alloc(HANDLE);
          h.writeHandle(pointer, attribute);
          if (deleteStorage(pointer) !== 0) throw new Error(abi.UTF8ToString(webError()));
        }),
      setUniform: (node, lanes) =>
        h.scoped(() => {
          const pointer = h.alloc(8);
          const values = h.alloc(Math.max(8, lanes.length * 8));
          const v = h.view();
          v.setBigUint64(pointer, BigInt(node), true);
          lanes.forEach((lane, i) => v.setFloat64(values + i * 8, lane, true));
          const diag = h.diagnostic();
          h.check(setUniform(context, pointer, values, lanes.length, diag), diag, "uniform.value");
        }),
    },
  };
}

/** The runtime over a loaded ABI module: one engine context, every call checked. */
/**
 * Opt-in boundary census for `pnpm profile:wasm-page --calls`: while the page sets
 * `globalThis.__tnCallCounts` to a Map, every engine get, set and invoke counts under
 * "<kind> <type id>.<name>" (`__tnEngineTypes` names the type ids). Off, it costs one global read.
 */
function countCall(kind: string, self: IEngineRef, name: string): void {
  const counts = (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts;
  if (counts === undefined) return;
  const key = `${kind} ${self.type}.${name}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function createWasmRuntime(abi: TnAbiModule): IBrowserRuntime {
  let dataView = new DataView(abi.HEAPU8.buffer);
  const view = () => {
    if (dataView.buffer !== abi.HEAPU8.buffer) dataView = new DataView(abi.HEAPU8.buffer);
    return dataView;
  };
  // Each call frees what it allocated, and only that: a callback can run a nested call.
  // A call's scratch (its handle, arguments, result and diagnostic) comes from one arena that each
  // scope rewinds, a stack as nested calls (a callback inside an invoke) need; a scope that outgrows
  // it falls back to malloc and frees on exit. Every engine call crosses here, many per frame.
  const arenaSize = 64 * 1024;
  const arenaBase = abi._malloc(arenaSize) >>> 0;
  let arenaTop = arenaBase;
  const allocations: number[] = [];
  const alloc = (size: number): number => {
    const aligned = (size + 7) & ~7;
    let pointer: number;
    if (arenaTop + aligned <= arenaBase + arenaSize) {
      pointer = arenaTop;
      arenaTop += aligned;
    } else {
      // `>>> 0`: the module addresses up to 4 GB, and an export returns a pointer as a signed i32.
      pointer = abi._malloc(size) >>> 0;
      allocations.push(pointer);
    }
    abi.HEAPU8.fill(0, pointer, pointer + size);
    return pointer;
  };
  const scoped = <T>(work: () => T): T => {
    const mark = allocations.length;
    const top = arenaTop;
    try {
      return work();
    } finally {
      for (const pointer of allocations.splice(mark)) abi._free(pointer);
      arenaTop = top;
    }
  };
  const string = (text: string): { pointer: number; bytes: number } => {
    const bytes = abi.lengthBytesUTF8(text);
    const pointer = alloc(bytes + 1);
    abi.stringToUTF8(text, pointer, bytes + 1);
    return { pointer, bytes };
  };
  // Member, method and class names: a bounded set, encoded once and kept for the module's life.
  const names = new Map<string, number>();
  const name = (text: string): number => {
    let pointer = names.get(text);
    if (pointer === undefined) {
      const bytes = abi.lengthBytesUTF8(text);
      pointer = abi._malloc(bytes + 1) >>> 0;
      abi.stringToUTF8(text, pointer, bytes + 1);
      names.set(text, pointer);
    }
    return pointer;
  };
  const diagnostic = () => alloc(8);
  const check = (status: number, diag: number, what: string) => {
    if (status === 0) return;
    const message = view().getUint32(diag, true);
    const text = message === 0 ? "" : abi.UTF8ToString(message);
    abi._tn_diagnostic_release(diag);
    throw new Error(`TN_ABI_${status}: ${what}${text ? `: ${text}` : ""}`);
  };
  // A handle is three words in memory: type and context as two halves of the first, then index and
  // generation. A ref made here keeps those words, so writing one back is three stores, no parse.
  let words = new Uint32Array(abi.HEAPU8.buffer);
  const wordView = () => {
    if (words.buffer !== abi.HEAPU8.buffer) words = new Uint32Array(abi.HEAPU8.buffer);
    return words;
  };
  const keyOf = (pointer: number): IEngineRef => {
    const v = view();
    const type = v.getUint16(pointer, true);
    const context = v.getUint16(pointer + 2, true);
    const index = v.getUint32(pointer + 4, true);
    const generation = v.getUint32(pointer + 8, true);
    const ref: IPackedRef = {
      key: `${type}:${context}:${index}:${generation}`,
      type,
      w0: (type | (context << 16)) >>> 0,
      w1: index,
      w2: generation,
    };
    return ref;
  };
  const writeHandle = (pointer: number, ref: IEngineRef) => {
    let packed = ref as Partial<IPackedRef>;
    if (packed.w0 === undefined) {
      // A ref some other source made: parse its key once and keep the words on it.
      const [type = 0, context = 0, index = 0, generation = 0] = ref.key.split(":").map(Number);
      packed = Object.isExtensible(ref) ? (ref as IPackedRef) : { ...ref };
      Object.assign(packed, { w0: (type | (context << 16)) >>> 0, w1: index, w2: generation });
    }
    if ((pointer & 3) === 0) {
      const at = pointer >>> 2;
      const w = wordView();
      w[at] = packed.w0 as number;
      w[at + 1] = packed.w1 as number;
      w[at + 2] = packed.w2 as number;
      return;
    }
    const v = view();
    v.setUint32(pointer, packed.w0 as number, true);
    v.setUint32(pointer + 4, packed.w1 as number, true);
    v.setUint32(pointer + 8, packed.w2 as number, true);
  };
  const handleOf = (ref: IEngineRef): number => {
    const pointer = alloc(HANDLE);
    writeHandle(pointer, ref);
    return pointer;
  };
  const writeValue = (pointer: number, value: EngineValue) => {
    const v = view();
    if (value === null) return v.setUint32(pointer, KIND.null, true);
    if (value === undefined) return v.setUint32(pointer, KIND.undefined, true);
    if (typeof value === "number") {
      v.setUint32(pointer, KIND.number, true);
      return v.setFloat64(pointer + 8, value, true);
    }
    if (typeof value === "boolean") {
      v.setUint32(pointer, KIND.bool, true);
      return v.setUint32(pointer + 4, value ? 1 : 0, true);
    }
    if (typeof value === "string") {
      const text = string(value);
      const w = view();
      w.setUint32(pointer, KIND.string, true);
      w.setUint32(pointer + 32, text.pointer, true);
      return w.setBigUint64(pointer + 40, BigInt(text.bytes), true);
    }
    if (isRef(value)) {
      v.setUint32(pointer, KIND.handle, true);
      return writeHandle(pointer + 16, value);
    }
    if (!Array.isArray(value)) {
      // A record: count key/value pairs, each key a string value, as the engine returns one.
      const entries = Object.entries(value as Record<string, EngineValue>);
      const children = values(entries.flat());
      const w = view();
      w.setUint32(pointer, KIND.record, true);
      w.setUint32(pointer + 48, children, true);
      return w.setBigUint64(pointer + 40, BigInt(entries.length), true);
    }
    if (value.every((item) => typeof item === "number")) {
      const numbers = alloc(Math.max(8, value.length * 8));
      abi.HEAPF64.set(value as number[], numbers / 8);
      const typed = (value as { [TYPED]?: string })[TYPED];
      const name = typed === undefined ? 0 : string(typed).pointer;
      const w = view();
      w.setUint32(pointer, KIND.numbers, true);
      w.setUint32(pointer + 32, name, true);
      w.setUint32(pointer + 48, numbers, true);
      w.setBigUint64(pointer + 40, BigInt(value.length), true);
    } else {
      const children = values(value);
      const w = view();
      w.setUint32(pointer, KIND.array, true);
      w.setUint32(pointer + 48, children, true);
      w.setBigUint64(pointer + 40, BigInt(value.length), true);
    }
  };
  const values = (args: readonly EngineValue[]): number => {
    const pointer = alloc(Math.max(VALUE, args.length * VALUE));
    args.forEach((arg, i) => writeValue(pointer + i * VALUE, arg));
    return pointer;
  };
  const readValue = (pointer: number): EngineValue => {
    const v = view();
    switch (v.getUint32(pointer, true)) {
      case KIND.undefined:
        return undefined;
      case KIND.number:
        return v.getFloat64(pointer + 8, true);
      case KIND.bool:
        return v.getUint32(pointer + 4, true) !== 0;
      case KIND.string:
        return abi.UTF8ToString(
          v.getUint32(pointer + 32, true),
          Number(v.getBigUint64(pointer + 40, true)),
        );
      case KIND.handle:
        return keyOf(pointer + 16);
      case KIND.array: {
        const at = v.getUint32(pointer + 48, true);
        return Array.from({ length: Number(v.getBigUint64(pointer + 40, true)) }, (_, i) =>
          readValue(at + i * VALUE),
        );
      }
      case KIND.record: {
        const at = v.getUint32(pointer + 48, true);
        return Object.fromEntries(
          Array.from({ length: Number(v.getBigUint64(pointer + 40, true)) }, (_, i) => {
            const key = readValue(at + i * 2 * VALUE);
            if (typeof key !== "string") throw new TypeError("TN_ABI_RECORD_KEY: expected string");
            return [key, readValue(at + (i * 2 + 1) * VALUE)];
          }),
        );
      }
      case KIND.numbers: {
        const at = v.getUint32(pointer + 48, true) / 8;
        return Array.from(
          abi.HEAPF64.subarray(at, at + Number(v.getBigUint64(pointer + 40, true))),
        );
      }
      default:
        return null;
    }
  };

  // Callbacks: one invoke and one release trampoline in the function table; the context is a
  // handler id, and the engine's release (once per pair) forgets it.
  const handlers = new Map<number, (args: readonly EngineValue[]) => void>();
  let nextHandler = 1;
  let invokeTrampoline = 0;
  let releaseTrampoline = 0;
  const trampolines = () => {
    if (invokeTrampoline !== 0) return;
    invokeTrampoline = abi.addFunction((id, rawArgs, count, rawError, capacity) => {
      // Pointers arrive as signed i32; the module addresses up to 4 GB.
      const args = (rawArgs ?? 0) >>> 0;
      const error = (rawError ?? 0) >>> 0;
      const handler = handlers.get(id ?? 0);
      if (handler === undefined) return 0;
      const decoded: EngineValue[] = [];
      for (let i = 0; i < (count ?? 0); i++) decoded.push(readValue(args + i * VALUE));
      try {
        handler(decoded);
        return 0;
      } catch (thrown) {
        abi.stringToUTF8(
          thrown instanceof Error ? thrown.message : String(thrown),
          error,
          capacity ?? 0,
        );
        return 8; // TN_ERROR_INVALID_STATE: the engine records it and goes on
      }
    }, "iiiiii");
    releaseTrampoline = abi.addFunction((id) => {
      handlers.delete(id ?? 0);
      return undefined;
    }, "vi");
  };

  // A view over the attribute's storage, used only inside one call: the lease pins the storage and
  // nothing in between can grow the memory and detach the view. A kept view would detach on growth,
  // so the back end keeps JS arrays and copies through this (see defineBrowserClasses).
  const withAttributeView = <T>(self: IEngineRef, use: (view: TypedArray) => T): T =>
    scoped(() => {
      const call = abi._tnw_attribute_view;
      if (call === undefined)
        throw new TypeError("TN_WASM_MODULE: this module exports no attribute views");
      const out = alloc(24);
      const lease = call(handleOf(self), out);
      if (lease === 0) throw new TypeError("TN_NATIVE_UNSUPPORTED array: not an attribute");
      try {
        const v = view();
        const [address, count, scalar] = [0, 8, 16].map((at) =>
          Number(v.getBigUint64(out + at, true)),
        );
        const Typed = SCALARS[scalar ?? -1];
        if (Typed === undefined)
          throw new TypeError(`TN_NATIVE_UNSUPPORTED array: scalar ${String(scalar)}`);
        return use(new Typed(abi.HEAPU8.buffer as ArrayBuffer, address ?? 0, count ?? 0));
      } finally {
        abi._tnw_attribute_view_release?.(lease);
      }
    });

  const context = scoped(() => {
    const version = alloc(32);
    abi._tn_engine_version(version);
    const contextOut = alloc(4);
    const diag = diagnostic();
    check(abi._tn_context_create(contextOut, version, diag), diag, "tn_context_create");
    return view().getUint32(contextOut, true);
  });

  return {
    ...(tslOf(abi, context, {
      scoped,
      alloc,
      string,
      diagnostic,
      check,
      handleOf,
      writeHandle,
      view,
    }) ?? {}),
    ...gltfOf(abi, context, { scoped, alloc, keyOf }),
    typeId: (className) => abi._tn_type_id(name(className)),
    construct: (className, args) =>
      scoped(() => {
        const out = alloc(HANDLE);
        const diag = diagnostic();
        check(
          abi._tn_construct(
            context,
            string(className).pointer,
            values(args),
            args.length,
            out,
            diag,
          ),
          diag,
          `new ${className}`,
        );
        return keyOf(out);
      }),
    invoke: (self, method, args) =>
      scoped(() => {
        countCall("call", self, method);
        const out = alloc(VALUE);
        const diag = diagnostic();
        check(
          abi._tn_invoke(handleOf(self), name(method), values(args), args.length, out, diag),
          diag,
          `${method}()`,
        );
        return readValue(out);
      }),
    engineReferences: (refs) =>
      scoped(() => {
        const handles = alloc(Math.max(1, refs.length) * HANDLE);
        refs.forEach((ref, i) => writeHandle(handles + i * HANDLE, ref));
        const out = alloc(Math.max(1, refs.length) * 4);
        abi._tn_object_engine_references(handles, refs.length, out);
        const v = view();
        return refs.map((_, i) => v.getUint32(out + i * 4, true));
      }),
    readByte: (address) => abi.HEAPU8[address] as number,
    writeDouble: (address, value) => {
      abi.HEAPF64[address / 8] = value;
    },
    heapF64: () => abi.HEAPF64,
    readDoubles: (address, count) => {
      const at = address / 8;
      return count === 1
        ? (abi.HEAPF64[at] as number)
        : Array.from(abi.HEAPF64.subarray(at, at + count));
    },
    get: (self, path) =>
      scoped(() => {
        countCall("get", self, path);
        const out = alloc(VALUE);
        const diag = diagnostic();
        check(abi._tn_get(handleOf(self), name(path), out, diag), diag, `get ${path}`);
        return readValue(out);
      }),
    set: (self, path, value) =>
      scoped(() => {
        countCall("set", self, path);
        const pointer = values([value]);
        const diag = diagnostic();
        check(abi._tn_set(handleOf(self), name(path), pointer, diag), diag, `set ${path}`);
      }),
    release: (self) =>
      scoped(() => {
        const diag = diagnostic();
        abi._tn_object_release(handleOf(self), diag);
        abi._tn_diagnostic_release(diag);
      }),
    attributeArray: (self, offset, count) =>
      withAttributeView(self, (target) => {
        const from = offset === undefined ? 0 : offset;
        const length = count === undefined ? target.length - from : count;
        if (
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(length) ||
          from < 0 ||
          length < 0 ||
          from + length > target.length
        )
          throw new RangeError(
            `TN_NATIVE_ATTRIBUTE_RANGE: [${String(from)}, ${String(length)}) is outside ${String(target.length)} elements`,
          );
        return target.subarray(from, from + length).slice();
      }),
    attributeWrite: (self, array, offset) =>
      withAttributeView(self, (target) => {
        // An omitted offset writes the whole attribute, so the array must be its exact data; an
        // explicit offset (including 0) writes that subrange.
        if (offset === undefined) {
          if (target.length !== array.length)
            throw new RangeError(
              `TN_NATIVE_ATTRIBUTE_LENGTH: attribute.array has ${String(array.length)} elements, the attribute ${String(target.length)}`,
            );
          target.set(array);
          return;
        }
        if (!Number.isSafeInteger(offset) || offset < 0 || offset + array.length > target.length)
          throw new RangeError(
            `TN_NATIVE_ATTRIBUTE_LENGTH: attribute.array has ${String(array.length)} elements at ${String(offset)}, the attribute ${String(target.length)}`,
          );
        target.set(array, offset);
      }),
    setCallback: (self, name, handler) =>
      scoped(() => {
        const diag = diagnostic();
        if (handler === null) {
          check(
            abi._tn_set_callback(handleOf(self), string(name).pointer, 0, 0, 0, diag),
            diag,
            `clear ${name}`,
          );
          return;
        }
        trampolines();
        const id = nextHandler++;
        handlers.set(id, handler);
        const status = abi._tn_set_callback(
          handleOf(self),
          string(name).pointer,
          invokeTrampoline,
          id,
          releaseTrampoline,
          diag,
        );
        if (status !== 0) handlers.delete(id); // a refused pair was never taken
        check(status, diag, `set ${name}`);
      }),
  };
}
