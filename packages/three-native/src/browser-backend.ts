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

import { defineMath } from "./browser-math.js";
import type { ITslRuntime, TslArgValue } from "./browser-tsl.js";

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

/** An engine object as the back end sees it: an opaque key and its catalog type id. */
export interface IEngineRef {
  readonly key: string;
  readonly type: number;
}

/** A decoded page image the web host copies with copyExternalImageToTexture: an ImageBitmap. */
export interface IPageImage {
  readonly width: number;
  readonly height: number;
}

export type EngineValue =
  | null
  | undefined
  | number
  | boolean
  | string
  | readonly EngineValue[]
  | TypedArray
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
  /** Writes one double at `address` in the engine's memory; Wasm only. */
  writeDouble?(address: number, value: number): void;
  /** The byte at `address` in the engine's memory (a field of count 0, a bool); Wasm only. */
  readByte?(address: number): number;
  /** A copy of the attribute's data, of its scalar type; three's `attribute.array` is built on it. */
  attributeArray?(self: IEngineRef): TypedArray;
  /** Writes `array` into the attribute's data; present with attributeArray. */
  attributeWrite?(self: IEngineRef, array: TypedArray): void;
  /** Sets (or, with null, clears) a callback the engine runs; `handler` gets the engine's arguments. */
  setCallback(
    self: IEngineRef,
    name: string,
    handler: ((args: readonly EngineValue[]) => void) | null,
  ): void;
  /** TSL by name (PRD-540), when the module carries `tn_tsl_call`. */
  readonly tsl?: ITslRuntime;
  /** A GLB through the engine's own glTF loader (PRD-540), when the module carries the web host. */
  /**
   * `images[i]` is glTF image i already decoded by the page (an ImageBitmap), which the engine
   * copies to the GPU instead of decoding it in Wasm; `clips` is the model's animation count.
   */
  /**
   * The web host takes `image` (an ImageBitmap, image or canvas) as `texture`'s pixels and copies it
   * on the GPU at each upload, instead of a readback into bytes. Absent without the web host.
   */
  hostImage?(texture: IEngineRef, image: IPageImage): void;
  loadGltf?(
    bytes: Uint8Array,
    images?: readonly (IPageImage | undefined)[],
    clips?: number,
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
  /** The wrapper for an engine object the engine handed over (a loaded model's scene). */
  wrap(ref: IEngineRef): object;
}

const REF = Symbol("tn.engineRef");
/** Held wrappers a safe point re-asks about beyond the new ones (`collect()`). */
const SWEEP = 32;

export type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Uint8ClampedArray;
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

/** The engine object behind a back-end wrapper, for a host that talks to the ABI directly. */
export function engineRef(object: object): IEngineRef | undefined {
  return (object as Partial<IWrapped>)[REF];
}

function isRef(value: unknown): value is IEngineRef {
  return typeof value === "object" && value !== null && "key" in value && "type" in value;
}

// An indexed scan: `every` with a callback cost a call per element of each matrix and vertex list.
function allNumbers(list: readonly unknown[]): boolean {
  for (let i = 0; i < list.length; i++) if (typeof list[i] !== "number") return false;
  return true;
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

/** Members every scene-graph class gets in JavaScript: game state and walks over `children`. */
export const LANGUAGE_MEMBERS = [
  "userData",
  "traverse",
  "traverseVisible",
  "traverseAncestors",
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
  seen: (object: object, parent: object) => void,
) {
  const childrenOf = (object: object): object[] => {
    if (!hasChildren) throw new TypeError(`TN_BROWSER_UNBOUND: ${className}.children`);
    return (object as { children: object[] }).children;
  };
  // The engine's walk: one crossing for the whole subtree, in three's order (`__walk`), each object
  // followed by its parent's index in the walk, which `seen` keeps.
  const walk = (object: object, visibleOnly: boolean): object[] => {
    const walked = (
      object as { __walk(visibleOnly: boolean, withParents: boolean): (object | number)[] }
    ).__walk(visibleOnly, true);
    const objects: object[] = [];
    for (let i = 0; i < walked.length; i += 2) {
      const parent = walked[i + 1] as number;
      objects.push(walked[i] as object);
      if (parent >= 0) seen(walked[i] as object, objects[parent] as object);
    }
    return objects;
  };
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
}

/**
 * Defines every registry class over `runtime`. With `catalog`, classes chain as three's do
 * (`mesh instanceof Object3D`) and carry three's `is*` flags.
 */
export function defineBrowserClasses(
  registry: IRegistryDump,
  runtime: IBrowserRuntime,
  catalog?: ICatalogShape,
): IBrowserEngine {
  const classes: Record<string, new (...args: unknown[]) => object> = {};
  const byType = new Map<number, { prototype: object }>();
  // three keeps a material's slots as its own fields, and games find textures with
  // Object.values(material); a material wrapper carries its accessors as own enumerable ones.
  // ponytail: per-instance accessors leave V8's fast mode; materials are few, Object3D stays prototype-only.
  const ownSlots = new Map<object, PropertyDescriptorMap>();
  const typeNames = new Map<number, string>();
  (globalThis as { __tnEngineTypes?: Map<number, string> }).__tnEngineTypes = typeNames;
  // Reads that need no engine call: a field the engine holds in place is read from its memory (Wasm,
  // `readDoubles`), and a fixed member (`position`, `matrixWorld`) is kept after its first answer.
  // Writes still go through the engine's setters, which it reacts to.
  const addresses = new WeakMap<object, number>();
  const kept = new WeakMap<object, Map<string, unknown>>();
  // Properties only the object's own setter or methods change: `name` and `type` (read per track and
  // per bone while a game binds animations), an attribute's shape (read per merge), a mesh's
  // geometry and material, a geometry's index. The answer is kept until JS sets it or calls a method
  // on that object.
  // ponytail: an engine call on another object that changes one of these is missed; none does today.
  const labelled = new Set([
    "name",
    "type",
    "itemSize",
    "normalized",
    "gpuType",
    "geometry",
    "material",
    "index",
    "__attributeNames",
  ]);
  const labels = new WeakMap<object, Map<string, unknown>>();
  // `parent`, which games walk to the root per mesh inside traverse, kept from the walks and the
  // `children` reads that saw it, until add, remove, attach, removeFromParent or clear moves it.
  // ponytail: an engine call that reparents under any other name is missed; none does today.
  let parents = new WeakMap<object, unknown>();
  const moves = new Set(["add", "remove", "attach", "removeFromParent", "clear"]);
  // A kept member -> [its owner, its name]: the owner's one `__addresses` call answers every member's
  // address, and an owned `rotation` write syncs the owner's quaternion.
  const within = new WeakMap<object, [object, string]>();
  const records = new WeakMap<object, Record<string, number>>();
  const recordOf = (owner: object) => {
    let record = records.get(owner);
    if (record === undefined) {
      record = runtime.get(refOf(owner), "__addresses") as Record<string, number>;
      records.set(owner, record);
    }
    return record;
  };
  // An attribute's shape, in the order its `__shape` getter answers it: one call fills all four.
  const shapeKeys = ["count", "itemSize", "normalized", "gpuType"];
  const fastGetter = (binding: IRegistryClass, property: string) => {
    const field = binding.fields?.[property];
    const read = runtime.readDoubles;
    const readByte = runtime.readByte;
    const whole = binding.getters.includes("__addresses");
    if (field?.[1] === 0)
      return readByte === undefined
        ? undefined
        : function (this: object) {
            return readByte(addressOf(this, whole) + (field[0] ?? 0)) !== 0;
          };
    if (field !== undefined && read !== undefined) {
      const [offset = 0, count = 1] = field;
      return function (this: object) {
        return read(addressOf(this, whole) + offset, count);
      };
    }
    if (binding.fixedMembers?.includes(property) && !binding.setters.includes(property)) {
      // The member's class, from the first object of this class that asked the engine for it.
      let memberPrototype: object | undefined;
      const fetch = (owner: object): object => {
        if (whole && memberPrototype !== undefined) {
          const member = deferred(owner, property, memberPrototype);
          within.set(member, [owner, property]);
          return member;
        }
        const member = fromEngine(runtime.get(refOf(owner), property)) as object;
        if (whole) {
          memberPrototype = Object.getPrototypeOf(member) as object;
          within.set(member, [owner, property]);
        }
        return member;
      };
      return function (this: object) {
        let members = kept.get(this);
        if (members === undefined) {
          members = new Map();
          kept.set(this, members);
        }
        if (!members.has(property)) members.set(property, fetch(this));
        return members.get(property);
      };
    }
    return undefined;
  };
  // A kept member of an object that answers `__addresses` reads and writes its lanes where the
  // owner's record says, so the engine is asked for its Ref only when a call takes the member.
  // ponytail: a Ref to it the engine hands out before then gets a second wrapper; none does today.
  const deferred = (owner: object, property: string, prototype: object): object => {
    const member = Object.create(prototype) as object;
    Object.defineProperty(member, REF, {
      configurable: true,
      get() {
        const ref = runtime.get(refOf(owner), property) as IEngineRef;
        delete (member as Partial<IWrapped>)[REF];
        adopt(member, ref);
        hold(member);
        return ref;
      },
    });
    return member;
  };
  // `whole`: the object answers `__addresses`, whose record also holds its own `__address`.
  const addressOf = (self: object, whole = false): number => {
    let address = addresses.get(self);
    if (address === undefined) {
      const home = within.get(self);
      address = whole ? recordOf(self).__address : home ? recordOf(home[0])[home[1]] : undefined;
      address ??= runtime.get(refOf(self), "__address") as number;
      addresses.set(self, address);
    }
    return address;
  };
  // three's math values are JS (browser-math.ts): `new Vector3()` holds its own lanes. The engine's
  // vectors (`mesh.position`) share that prototype through `engine`, whose lanes are its memory.
  // An engine call takes a JS value by value: a method borrows a pooled engine object and copies
  // the lanes back after the call (an output argument); a constructor or setter, which may keep the
  // object, gets the value itself turned into an engine object in place, so identity survives.
  interface IValueClass {
    name: string;
    lanes: string[];
    engine: object;
    pool: object[];
    top: number;
  }
  const math = defineMath(
    () =>
      new (classes.Quaternion as new () => object)() as ReturnType<
        Parameters<typeof defineMath>[0]
      >,
  ) as Record<string, new (...args: unknown[]) => object>;
  const valueClasses = new Map<object, IValueClass>(); // JS prototype -> its engine side
  const loans: [Record<string, number>, Record<string, number>, IValueClass][] = [];
  let borrowing = false;
  const toEngineArgs = (args: readonly unknown[]): EngineValue[] => {
    borrowing = true;
    try {
      return args.map(toEngine);
    } finally {
      borrowing = false;
    }
  };
  const lend = (value: Record<string, number>, info: IValueClass): IEngineRef => {
    let scratch = info.pool[info.top];
    if (scratch === undefined) {
      scratch = wrap(runtime.construct(info.name, []));
      info.pool.push(scratch);
    }
    info.top++;
    const lanes = scratch as Record<string, number>;
    for (const lane of info.lanes) lanes[lane] = value[lane] as number;
    loans.push([value, lanes, info]);
    return refOf(scratch);
  };
  // Copies each borrowed object's lanes back to its JS value; the result answers the value itself.
  const repay = (mark: number, returned: unknown): unknown => {
    let result = returned;
    for (let i = loans.length - 1; i >= mark; i--) {
      const [value, scratch, info] = loans[i] as (typeof loans)[number];
      for (const lane of info.lanes) value[lane] = scratch[lane] as number;
      info.top--;
      if (result === scratch) result = value;
    }
    loans.length = mark;
    return result;
  };
  const promote = (value: Record<string, number>, info: IValueClass): void => {
    const lanes = info.lanes.map((lane) => value[lane] as number);
    for (const lane of info.lanes) delete value[lane];
    Object.setPrototypeOf(value, info.engine);
    adopt(value, runtime.construct(info.name, lanes));
  };
  const wrappers = new Map<string, WeakRef<object>>();
  // Callbacks: the function lives on its wrapper (a WeakMap entry), so wrapper -> closure is an edge
  // the collector sees; `held` roots a wrapper while the engine may still call it.
  const callbackFunctions = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>();
  const callbackNames = new Map<string, Set<string>>(); // by handle key, to clear on collection
  const held = new Set<object>();
  // A safe point asks about every wrapper held since the last one, and a slice of the rest in turn:
  // a wrapper the engine lets go of is released within a few frames, and a frame's cost stays flat
  // whatever the scene holds.
  const fresh = new Set<object>();
  let sweep = held.values();
  const hold = (wrapper: object): void => {
    if (held.has(wrapper)) return;
    held.add(wrapper);
    fresh.add(wrapper);
  };
  // userData is the game's: it lives with the wrapper, which `held` keeps while the engine references it.
  const userData = new WeakMap<object, unknown>();
  const shaderNodes = new Map<string, Map<string, unknown>>(); // material key -> slot -> TSL node
  // three's `attribute.array` is the attribute's own JS typed array (PRD-540): the array the
  // constructor was handed, or a copy of the engine's data on first read. A view of Wasm memory
  // would detach when the memory grows. A read hands the game the array, so the attribute is
  // `pending` until its array is written back before the next engine call; a geometry or attribute
  // method that may write attribute data bumps `epoch`, and a later read refreshes the copy.
  // ponytail: a game that writes a kept array after such a method and before its next read loses
  // that write to the refresh; track writes per attribute if a game does that.
  const { attributeArray, attributeWrite } = runtime;
  const arrays = new WeakMap<object, { array: TypedArray; epoch: number }>();
  const pending = new Set<object>();
  let epoch = 0;
  // An attribute a geometry's `getAttribute` answered -> [that geometry, its name, the epoch]. A shape
  // changes only through a method that bumps `epoch`, so until one runs the geometry's one
  // `__attributes` call answers the shape of each attribute it handed out, fresh wrappers included.
  const homes = new WeakMap<object, [object, string, number]>();
  const geometryShapes = new WeakMap<object, { epoch: number; shapes: Record<string, number[]> }>();
  // One `__attributes` call answers every getAttribute, hasAttribute and `__attributeNames` read on
  // the geometry, kept in its labels, and every attribute's shape for this epoch.
  const listAttributes = (geometry: object): Map<string, unknown> => {
    if (pending.size > 0) writeBack();
    const found = runtime.get(refOf(geometry), "__attributes") as Record<
      string,
      [EngineValue, number[]]
    >;
    const known = labels.get(geometry) ?? new Map<string, unknown>();
    labels.set(geometry, known);
    const shapes: Record<string, number[]> = {};
    for (const [name, [ref, shape]] of Object.entries(found)) {
      const attribute = fromEngine(ref) as object;
      known.set(`getAttribute ${name}`, attribute);
      known.set(`hasAttribute ${name}`, true);
      homes.set(attribute, [geometry, name, epoch]);
      shapes[name] = shape;
    }
    known.set("__attributeNames", Object.keys(found).join("\n"));
    known.set("__attributes", true);
    geometryShapes.set(geometry, { epoch, shapes });
    return known;
  };
  const shapeOf = (attribute: object): number[] => {
    const home = homes.get(attribute);
    if (home === undefined || home[2] !== epoch)
      return runtime.get(refOf(attribute), "__shape") as number[];
    const found = geometryShapes.get(home[0]);
    if (found === undefined || found.epoch !== epoch) listAttributes(home[0]);
    return (
      geometryShapes.get(home[0])?.shapes[home[1]] ??
      (runtime.get(refOf(attribute), "__shape") as number[])
    );
  };
  const writeBack = (): void => {
    for (const attribute of pending) {
      const entry = arrays.get(attribute);
      if (entry !== undefined) attributeWrite?.call(runtime, refOf(attribute), entry.array);
    }
    pending.clear();
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
    const own = ownSlots.get(cls.prototype);
    if (own !== undefined) Object.defineProperties(wrapper, own);
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
    // A typed array crosses as it is: the ABI copies it once and names its type, so the engine keeps
    // three's storage type. Copying it to a list first cost Midway seconds of texels at load.
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value as TypedArray;
    if (Array.isArray(value)) {
      // A number list (a matrix, positions) crosses as it is; only a mixed list is walked.
      for (const item of value) if (typeof item !== "number") return Array.from(value, toEngine);
      return value as number[];
    }
    // A wrapper, the common argument, first: a JS value class has no REF until it is promoted.
    if (typeof value === "object" && REF in value) {
      // A wrapper passed into the engine is held until the next safe point decides (collect()).
      hold(value);
      return (value as IWrapped)[REF];
    }
    const info = valueClasses.get(Object.getPrototypeOf(value) as object);
    if (info !== undefined) {
      if (borrowing) return lend(value as Record<string, number>, info);
      promote(value as Record<string, number>, info);
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
    // A numbers result is a fresh plain array already; mapping it tested every element for a ref.
    if (Array.isArray(value)) return allNumbers(value) ? value : value.map(fromEngine);
    if (typeof value === "object" && value !== null)
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, fromEngine(item)]),
      );
    return value;
  };

  for (const [name, binding] of Object.entries(registry.classes)) {
    const adopts =
      attributeWrite !== undefined &&
      (name === "BufferAttribute" || name === "InstancedBufferAttribute");
    const writesAttributes = ATTRIBUTE_CLASSES.has(name) || name.endsWith("Geometry");
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
        const own = ownSlots.get(engineClass.prototype);
        if (own !== undefined) Object.defineProperties(this, own);
        if (parameters !== undefined) setValues(this, name, parameters);
        // three's BufferAttribute keeps the typed array it is handed; the typed subclasses copy.
        const handed = args[0];
        if (adopts && ArrayBuffer.isView(handed) && !(handed instanceof DataView)) {
          arrays.set(this, { array: handed as TypedArray, epoch });
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
    if (valueClass !== undefined && binding.fields !== undefined)
      valueClasses.set(prototype, {
        name,
        // In memory order, which is the constructor's (the registry lists Color's as b, g, r).
        lanes: Object.entries(binding.fields)
          .sort(([, a], [, b]) => (a[0] ?? 0) - (b[0] ?? 0))
          .map(([lane]) => lane),
        engine: accessors,
        pool: [],
        top: 0,
      });
    const info = valueClasses.get(prototype);
    for (const method of binding.methods) {
      if (valueClass !== undefined && Object.hasOwn(prototype, method)) continue;
      const bumps = writesAttributes && !/^(get|has|clone|equals|toJSON)/u.test(method);
      // A geometry's attribute lookups are kept with its labels, until anything else runs on it.
      const query = method === "getAttribute" || method === "hasAttribute";
      const listed = query && binding.members.includes("__attributes");
      const homed = listed && method === "getAttribute";
      // Removing one attribute forgets only that attribute's lookups; the rest stay listed.
      const deletes = method === "deleteAttribute" && binding.members.includes("__attributes");
      // Without a target the curve answers a new engine vector, whose lanes cost an `__address` call;
      // a JS target, lent to the call, answers a JS vector instead.
      const targeted = name === "CatmullRomCurve3" && /^get(Point|Tangent)(At)?$/u.test(method);
      // Forgotten before the call too, so an `added` listener reads the new parent.
      const forget = moves.has(method)
        ? (self: object, args: unknown[]) => {
            if (method === "clear") parents = new WeakMap();
            for (const moved of method === "removeFromParent" ? [self] : args)
              parents.delete(moved as object);
          }
        : undefined;
      Object.defineProperty(prototype, method, {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]) {
          const intersections = method === "intersectObject" || method === "intersectObjects";
          const key = query ? `${method} ${String(args[0])}` : "";
          if (query && labels.get(this)?.has(key)) {
            const hit = labels.get(this)?.get(key);
            if (homed && typeof hit === "object" && hit !== null)
              homes.set(hit, [this, String(args[0]), epoch]);
            return hit;
          }
          if (listed) {
            const known = labels.get(this);
            if (known?.has("__attributes")) return method === "getAttribute" ? null : false;
            return listAttributes(this).get(key) ?? (method === "getAttribute" ? null : false);
          }
          if (pending.size > 0) writeBack();
          // A JS value runs a method only the engine has (`color.setStyle`) as an engine object.
          if (info !== undefined && !(REF in this)) {
            promote(this as Record<string, number>, info);
            hold(this);
          }
          const known = deletes ? labels.get(this) : undefined;
          if (known?.has("__attributes")) {
            const removed = String(args[0]);
            known.delete(`getAttribute ${removed}`);
            known.delete(`hasAttribute ${removed}`);
            const names = String(known.get("__attributeNames")).split("\n");
            known.set("__attributeNames", names.filter((name) => name !== removed).join("\n"));
          } else if (!query) labels.delete(this);
          if (targeted && args[1] === undefined) args[1] = new (math.Vector3 as new () => object)();
          const mark = loans.length;
          let result: unknown;
          forget?.(this, args);
          try {
            result = fromEngine(
              runtime.invoke(
                refOf(this),
                method,
                toEngineArgs(intersections ? args.slice(0, 2) : args),
              ),
            );
          } finally {
            forget?.(this, args);
            if (loans.length > mark) result = repay(mark, result);
          }
          if (bumps) epoch++;
          if (intersections && args[2] !== undefined) {
            if (!Array.isArray(args[2]) || !Array.isArray(result))
              throw new TypeError("intersection target must be an array");
            args[2].push(...result);
            args[2].sort((a, b) => a.distance - b.distance);
            return args[2];
          }
          if (query)
            labels.get(this)?.set(key, result) ?? labels.set(this, new Map([[key, result]]));
          if (homed && typeof result === "object" && result !== null)
            homes.set(result, [this, String(args[0]), epoch]);
          return result;
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
    const write = runtime.writeDouble;
    const shaped = binding.getters.includes("__shape");
    const listsAttributes = binding.members.includes("__attributes");
    const whole = binding.getters.includes("__addresses");
    for (const property of [...binding.getters, ...binding.members]) {
      if (
        property.includes(".") ||
        binding.methods.includes(property) ||
        Object.hasOwn(accessors, property)
      )
        continue;
      // A value class's lane is written in place: its engine setter is a plain store (Layers' too).
      const lane =
        valueClass !== undefined || name === "Layers" ? binding.fields?.[property] : undefined;
      // A bool field (`visible`, which games set every frame) skips a set that changes nothing.
      const flag = binding.fields?.[property];
      const readFlag = flag?.[1] === 0 ? runtime.readByte : undefined;
      Object.defineProperty(accessors, property, {
        configurable: true,
        get:
          fastGetter(binding, property) ??
          (labelled.has(property) || (shaped && shapeKeys.includes(property))
            ? function (this: object) {
                let known = labels.get(this);
                if (known === undefined) {
                  known = new Map();
                  labels.set(this, known);
                }
                if (!known.has(property)) {
                  if (shaped && shapeKeys.includes(property)) {
                    const shape = shapeOf(this);
                    shapeKeys.forEach((key, i) =>
                      known?.set(key, key === "normalized" ? shape[i] === 1 : shape[i]),
                    );
                  } else if (property === "__attributeNames" && listsAttributes)
                    listAttributes(this);
                  else known.set(property, fromEngine(runtime.get(refOf(this), property)));
                }
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
                  if (
                    readFlag !== undefined &&
                    typeof value === "boolean" &&
                    (readFlag(addressOf(this, whole) + (flag?.[0] ?? 0)) !== 0) === value
                  )
                    return;
                  // A setter changes only its own property; the kept lookups stay.
                  labels.get(this)?.delete(property);
                  runtime.set(refOf(this), property, toEngine(value));
                },
              }
            : {}),
      });
    }
    // Games enable and disable layers on every mesh while they load: with the mask read and written
    // in place, three's Layers.js bit operations need no engine call.
    if (name === "Layers" && binding.fields?.mask !== undefined && runtime.readDoubles && write) {
      type Mask = { mask: number };
      const layerMethods: Record<string, (this: Mask, argument: number & Mask) => unknown> = {
        set(channel) {
          this.mask = ((1 << channel) | 0) >>> 0;
        },
        enable(channel) {
          this.mask |= (1 << channel) | 0;
        },
        enableAll() {
          this.mask = 0xffffffff | 0;
        },
        toggle(channel) {
          this.mask ^= (1 << channel) | 0;
        },
        disable(channel) {
          this.mask &= ~((1 << channel) | 0);
        },
        disableAll() {
          this.mask = 0;
        },
        test(layers) {
          return (this.mask & layers.mask) !== 0;
        },
        isEnabled(channel) {
          return (this.mask & ((1 << channel) | 0)) !== 0;
        },
      };
      for (const [method, value] of Object.entries(layerMethods))
        Object.defineProperty(prototype, method, { configurable: true, writable: true, value });
    }
    // Games turn objects every frame: an object's `rotation` is written in place, and its quaternion
    // follows here, as three's onRotationChange does. Any other Euler still crosses, callback and all.
    const order = binding.fields?.__order;
    const quaternion = registry.classes.Quaternion?.fields;
    const read = runtime.readDoubles;
    const readByte = runtime.readByte;
    if (name === "Euler" && order && quaternion && read && readByte && write) {
      const angles = ["x", "y", "z"].map((lane) => binding.fields?.[lane]?.[0] ?? 0);
      const targets = ["x", "y", "z", "w"].map((lane) => quaternion[lane]?.[0] ?? 0);
      // three's setFromEuler: each order only signs the second terms, in the engine enum's order.
      const names = ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"];
      const signs = [
        [1, -1, 1, -1],
        [1, -1, -1, 1],
        [-1, 1, 1, -1],
        [-1, 1, -1, 1],
        [1, 1, -1, -1],
        [-1, -1, 1, 1],
      ];
      const ownerOf = (euler: object) => {
        const home = within.get(euler);
        return home?.[1] === "rotation" ? home[0] : undefined;
      };
      const sync = (euler: object, owner: object) => {
        const at = addressOf(euler);
        const [x = 0, y = 0, z = 0] = angles.map((offset) => read(at + offset, 1) as number);
        const [sx = 1, sy = 1, sz = 1, sw = 1] = signs[readByte(at + (order[0] ?? 0))] ?? [];
        const c1 = Math.cos(x / 2);
        const c2 = Math.cos(y / 2);
        const c3 = Math.cos(z / 2);
        const s1 = Math.sin(x / 2);
        const s2 = Math.sin(y / 2);
        const s3 = Math.sin(z / 2);
        const q = recordOf(owner).quaternion;
        if (q === undefined) throw new Error("an Object3D's __addresses names no quaternion");
        const [qx = 0, qy = 0, qz = 0, qw = 0] = targets;
        write(q + qx, s1 * c2 * c3 + sx * c1 * s2 * s3);
        write(q + qy, c1 * s2 * c3 + sy * s1 * c2 * s3);
        write(q + qz, c1 * c2 * s3 + sz * s1 * s2 * c3);
        write(q + qw, c1 * c2 * c3 + sw * s1 * s2 * s3);
      };
      angles.forEach((offset, i) => {
        const lane = "xyz"[i] as string;
        const crossing = Object.getOwnPropertyDescriptor(prototype, lane);
        Object.defineProperty(prototype, lane, {
          ...crossing,
          set(this: object, value: number) {
            const owner = ownerOf(this);
            if (owner === undefined) return crossing?.set?.call(this, value);
            write(addressOf(this) + offset, value);
            sync(this, owner);
          },
        });
      });
      const set = prototype.set as (...args: unknown[]) => unknown;
      Object.defineProperty(prototype, "set", {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]) {
          const owner = ownerOf(this);
          if (owner === undefined) return set.apply(this, args);
          const at = addressOf(this);
          // Games pass their one order on every set; only a new order goes to the engine.
          if (args[3] !== undefined && args[3] !== names[readByte(at + (order[0] ?? 0))])
            return set.apply(this, args);
          angles.forEach((offset, i) => write(at + offset, args[i] as number));
          sync(this, owner);
          return this;
        },
      });
    }
    // Games aim objects and instances with these: three's code runs on the quaternion's lanes, and
    // an object's own quaternion syncs its rotation here, as three's onQuaternionChange does.
    const euler = registry.classes.Euler?.fields;
    if (name === "Quaternion" && quaternion && euler?.__order && read && readByte && write) {
      type Quat = { x: number; y: number; z: number; w: number };
      const [ox = 0, oy = 0, oz = 0, ow = 0] = ["x", "y", "z", "w"].map(
        (lane) => quaternion[lane]?.[0] ?? 0,
      );
      const [ex = 0, ey = 0, ez = 0] = ["x", "y", "z"].map((lane) => euler[lane]?.[0] ?? 0);
      const [orderAt = 0] = euler.__order;
      const clamp = (value: number) => Math.max(-1, Math.min(1, value));
      const store = (self: object, x: number, y: number, z: number, w: number) => {
        const at = addressOf(self);
        write(at + ox, x);
        write(at + oy, y);
        write(at + oz, z);
        write(at + ow, w);
        const home = within.get(self);
        if (home?.[1] !== "quaternion") return self;
        const rotation = recordOf(home[0]).rotation;
        if (rotation === undefined) throw new Error("an Object3D's __addresses names no rotation");
        // three's setFromQuaternion: makeRotationFromQuaternion, then setFromRotationMatrix.
        const x2 = x + x;
        const y2 = y + y;
        const z2 = z + z;
        const [xx, xy, xz, yy, yz, zz] = [x * x2, x * y2, x * z2, y * y2, y * z2, z * z2];
        const [wx, wy, wz] = [w * x2, w * y2, w * z2];
        const [m11, m12, m13] = [1 - (yy + zz), xy - wz, xz + wy];
        const [m21, m22, m23] = [xy + wz, 1 - (xx + zz), yz - wx];
        const [m31, m32, m33] = [xz - wy, yz + wx, 1 - (xx + yy)];
        const edge = (value: number) => !(Math.abs(value) < 0.9999999); // NaN as three takes it
        // In the engine enum's order: XYZ, YXZ, ZXY, ZYX, YZX, XZY.
        const angles = [
          () => [
            edge(m13) ? Math.atan2(m32, m22) : Math.atan2(-m23, m33),
            Math.asin(clamp(m13)),
            edge(m13) ? 0 : Math.atan2(-m12, m11),
          ],
          () => [
            Math.asin(-clamp(m23)),
            edge(m23) ? Math.atan2(-m31, m11) : Math.atan2(m13, m33),
            edge(m23) ? 0 : Math.atan2(m21, m22),
          ],
          () => [
            Math.asin(clamp(m32)),
            edge(m32) ? 0 : Math.atan2(-m31, m33),
            edge(m32) ? Math.atan2(m21, m11) : Math.atan2(-m12, m22),
          ],
          () => [
            edge(m31) ? 0 : Math.atan2(m32, m33),
            Math.asin(-clamp(m31)),
            edge(m31) ? Math.atan2(-m12, m22) : Math.atan2(m21, m11),
          ],
          () => [
            edge(m21) ? 0 : Math.atan2(-m23, m22),
            edge(m21) ? Math.atan2(m13, m33) : Math.atan2(-m31, m11),
            Math.asin(clamp(m21)),
          ],
          () => [
            edge(m12) ? Math.atan2(-m23, m33) : Math.atan2(m32, m22),
            edge(m12) ? 0 : Math.atan2(m13, m11),
            Math.asin(-clamp(m12)),
          ],
        ][readByte(rotation + orderAt)];
        if (angles === undefined) throw new Error("an Euler holds an unknown order");
        const [ax = 0, ay = 0, az = 0] = angles();
        write(rotation + ex, ax);
        write(rotation + ey, ay);
        write(rotation + ez, az);
        return self;
      };
      const multiplyQuaternions = (self: object, a: Quat, b: Quat) => {
        const { x: qax, y: qay, z: qaz, w: qaw } = a;
        const { x: qbx, y: qby, z: qbz, w: qbw } = b;
        return store(
          self,
          qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
          qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
          qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
          qaw * qbw - qax * qbx - qay * qby - qaz * qbz,
        );
      };
      const quaternionMethods: Record<string, (this: Quat, ...args: never[]) => unknown> = {
        setFromAxisAngle(axis: Quat, angle: number) {
          const half = angle / 2;
          const s = Math.sin(half);
          return store(this, axis.x * s, axis.y * s, axis.z * s, Math.cos(half));
        },
        setFromUnitVectors(from: Quat, to: Quat) {
          const r = from.x * to.x + from.y * to.y + from.z * to.z + 1;
          // three's epsilon (#31286): opposite vectors turn about any axis normal to `from`.
          const [x, y, z, w] =
            r < 1e-8
              ? Math.abs(from.x) > Math.abs(from.z)
                ? [-from.y, from.x, 0, 0]
                : [0, -from.z, from.y, 0]
              : [
                  from.y * to.z - from.z * to.y,
                  from.z * to.x - from.x * to.z,
                  from.x * to.y - from.y * to.x,
                  r,
                ];
          const length = Math.sqrt(x * x + y * y + z * z + w * w);
          if (length === 0) return store(this, 0, 0, 0, 1);
          const l = 1 / length;
          return store(this, x * l, y * l, z * l, w * l);
        },
        multiply(q: Quat) {
          return multiplyQuaternions(this, this, q);
        },
        premultiply(q: Quat) {
          return multiplyQuaternions(this, q, this);
        },
        multiplyQuaternions(a: Quat, b: Quat) {
          return multiplyQuaternions(this, a, b);
        },
      };
      for (const [method, value] of Object.entries(quaternionMethods))
        Object.defineProperty(prototype, method, { configurable: true, writable: true, value });
    }
    // A dotted path whose head is no member of its own (three's plain `morphAttributes` object) is
    // a holder made per read, as the V8 adapter makes it: each tail reads and writes the full path.
    const holders = new Map<string, string[]>();
    for (const path of binding.setters) {
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
      if (property.includes(".") || Object.hasOwn(accessors, property)) continue;
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
    if (binding.members.includes("parent") || binding.getters.includes("parent")) {
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
      const hasChildren =
        binding.members.includes("children") || binding.getters.includes("children");
      Object.defineProperty(prototype, "parent", {
        configurable: true,
        get(this: object) {
          if (!parents.has(this)) parents.set(this, fromEngine(runtime.get(refOf(this), "parent")));
          return parents.get(this);
        },
      });
      if (hasChildren)
        Object.defineProperty(prototype, "children", {
          configurable: true,
          get(this: object) {
            const children = fromEngine(runtime.get(refOf(this), "children")) as object[];
            for (const child of children) parents.set(child, this);
            return children;
          },
        });
      defineTraversal(
        prototype,
        name,
        hasChildren,
        binding.methods.includes("__walk"),
        (object, parent) => parents.set(object, parent),
      );
    }
    if (name.endsWith("Material")) {
      const own: PropertyDescriptorMap = {};
      for (const property of [...binding.getters, ...binding.members]) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
        if (descriptor?.get !== undefined) own[property] = { ...descriptor, enumerable: true };
      }
      ownSlots.set(prototype, own);
    }
    classes[name] = cls;
    byType.set(runtime.typeId(name), { prototype: accessors });
    typeNames.set(runtime.typeId(name), name);
  }
  if (attributeArray !== undefined && attributeWrite !== undefined) {
    // The attribute's current array, refreshed when an engine method may have written it.
    const current = (self: object): TypedArray => {
      let entry = arrays.get(self);
      if (entry === undefined) {
        entry = { array: attributeArray.call(runtime, refOf(self)), epoch };
        arrays.set(self, entry);
      } else if (entry.epoch !== epoch && !pending.has(self)) {
        const fresh = attributeArray.call(runtime, refOf(self));
        if (fresh.length === entry.array.length) entry.array.set(fresh);
        else entry.array = fresh;
        entry.epoch = epoch;
      }
      return entry.array;
    };
    // itemSize, normalized and count, read from the engine once per epoch (an engine method that may
    // write attributes moves it) and again after any of them is set: three keeps them as plain
    // fields, and a merge loop tests `i < attribute.count` on every iteration.
    type Shape = { itemSize: number; normalized: boolean; count?: number; epoch: number };
    const shapes = new WeakMap<object, Shape>();
    const shape = (self: object): Shape => {
      let found = shapes.get(self);
      if (found === undefined || found.epoch !== epoch) {
        const attribute = self as { itemSize: number; normalized: boolean };
        found = { itemSize: attribute.itemSize, normalized: attribute.normalized, epoch };
        shapes.set(self, found);
      }
      return found;
    };
    // three's element accessors (BufferAttribute.js) over the JS array: an element read or write is
    // a typed-array access, not an engine call. A read leaves the attribute as it is; a write marks
    // it pending, so the whole array goes back once before the next engine call. Each looks the
    // shape up once: a load reads millions of elements, and every lookup is a WeakMap get.
    const read = (self: object, index: number, k: number): number => {
      const { itemSize, normalized } = shape(self);
      const array = current(self);
      const value = array[index * itemSize + k] as number;
      return normalized ? denormalize(value, array) : value;
    };
    const write = (self: object, index: number, k: number, value: number): void => {
      const { itemSize, normalized } = shape(self);
      const array = current(self);
      pending.add(self);
      array[index * itemSize + k] = normalized ? normalize(value, array) : value;
    };
    const accessors: Record<string, (this: object, ...args: number[]) => unknown> = {
      getComponent(index, k) {
        return read(this, index, k);
      },
      setComponent(index, k, value) {
        write(this, index, k, value);
        return this;
      },
      setXY(index, x, y) {
        write(this, index, 0, x);
        write(this, index, 1, y);
        return this;
      },
      setXYZ(index, x, y, z) {
        write(this, index, 0, x);
        write(this, index, 1, y);
        write(this, index, 2, z);
        return this;
      },
      setXYZW(index, x, y, z, w) {
        write(this, index, 0, x);
        write(this, index, 1, y);
        write(this, index, 2, z);
        write(this, index, 3, w);
        return this;
      },
    };
    for (const [k, axis] of ["X", "Y", "Z", "W"].entries()) {
      accessors[`get${axis}`] = function (this: object, index: number) {
        return read(this, index, k);
      };
      accessors[`set${axis}`] = function (this: object, index: number, value: number) {
        write(this, index, k, value);
        return this;
      };
    }
    for (const name of ATTRIBUTE_CLASSES) {
      const cls = classes[name];
      if (cls === undefined) continue;
      for (const [method, value] of Object.entries(accessors))
        Object.defineProperty(cls.prototype, method, { configurable: true, writable: true, value });
      const engineCount = Object.getOwnPropertyDescriptor(cls.prototype, "count");
      if (engineCount?.get !== undefined)
        Object.defineProperty(cls.prototype, "count", {
          ...engineCount,
          get(this: object) {
            const found = shape(this);
            found.count ??= engineCount.get?.call(this) as number;
            return found.count;
          },
        });
      for (const field of ["itemSize", "normalized", "count"]) {
        const own = Object.getOwnPropertyDescriptor(cls.prototype, field);
        if (own?.set !== undefined)
          Object.defineProperty(cls.prototype, field, {
            ...own,
            set(this: object, value: unknown) {
              shapes.delete(this);
              own.set?.call(this, value);
            },
          });
      }
      Object.defineProperty(cls.prototype, "array", {
        configurable: true,
        get(this: object) {
          const array = current(this);
          pending.add(this);
          return array;
        },
      });
      // needsUpdate is a property write, not a call, so it writes the array back itself.
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
      for (const field of (link.fields ?? []).filter(isFlag))
        Object.defineProperty(cls.prototype, field.name, { configurable: true, value: true });
  }
  return {
    classes,
    wrap,
    collect() {
      const candidates = new Set(fresh);
      fresh.clear();
      for (let n = 0; n < SWEEP; ++n) {
        let next = sweep.next();
        if (next.done === true) {
          sweep = held.values();
          next = sweep.next();
        }
        if (next.done === true || candidates.has(next.value)) break;
        candidates.add(next.value);
      }
      const asked = [...candidates];
      const counts = runtime.engineReferences?.(asked.map(refOf));
      asked.forEach((wrapper, i) => {
        const referenced =
          counts !== undefined
            ? (counts[i] as number) > 0
            : callbackNames.has(refOf(wrapper).key) &&
              runtime.get(refOf(wrapper), "parent") !== null;
        if (!referenced) held.delete(wrapper);
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
  bytes: 9,
} as const;
// The typed arrays the engine reads as their own bytes (TN_VALUE_BYTES); any other view crosses as numbers.
const BYTE_ARRAYS = new Set([
  "Float32Array",
  "Float64Array",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
]);

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
  | "_tnw_web_set_post";

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

let nextImage = 1;

/** The web host's page image table (web_host.cpp tnw_js_copy_image), created on first use. */
function imageTable(abi: TnAbiModule): Map<number, IPageImage> {
  // quality-allow: the web host module carries its image table as a property it reads by name.
  const host = abi as unknown as { tnImages?: Map<number, IPageImage> };
  host.tnImages ??= new Map();
  return host.tnImages;
}

/** three's MathUtils.denormalize and normalize: a normalized integer attribute's stored value and its number. */
export function denormalize(value: number, array: TypedArray): number {
  if (array instanceof Uint32Array) return value / 4294967295;
  if (array instanceof Uint16Array) return value / 65535;
  if (array instanceof Uint8Array) return value / 255;
  if (array instanceof Int32Array) return Math.max(value / 2147483647, -1);
  if (array instanceof Int16Array) return Math.max(value / 32767, -1);
  if (array instanceof Int8Array) return Math.max(value / 127, -1);
  return value;
}
export function normalize(value: number, array: TypedArray): number {
  if (array instanceof Uint32Array) return Math.round(value * 4294967295);
  if (array instanceof Uint16Array) return Math.round(value * 65535);
  if (array instanceof Uint8Array) return Math.round(value * 255);
  if (array instanceof Int32Array) return Math.round(value * 2147483647);
  if (array instanceof Int16Array) return Math.round(value * 32767);
  if (array instanceof Int8Array) return Math.round(value * 127);
  return value;
}

/** A game's page image as a texture's pixels over the web host's `tnw_web_texture_image`. */
function hostImageOf(
  abi: TnAbiModule,
  h: Pick<IAbiHelpers, "scoped" | "alloc"> & {
    writeHandle(pointer: number, ref: IEngineRef): void;
  },
): Pick<IBrowserRuntime, "hostImage"> {
  // quality-allow: TnAbiModule does not declare the optional web host export, cast to access it.
  const host = abi as unknown as Partial<
    Record<"_tnw_web_texture_image", (...args: number[]) => number>
  >;
  const take = host._tnw_web_texture_image;
  if (take === undefined) return {};
  return {
    hostImage: (texture, image) =>
      h.scoped(() => {
        const id = nextImage++;
        imageTable(abi).set(id, image);
        const handle = h.alloc(16);
        h.writeHandle(handle, texture);
        if (take(handle, id, image.width, image.height) !== 0) {
          imageTable(abi).delete(id);
          throw new TypeError("TN_BROWSER_TEXTURE_SOURCE: the web host refused the image");
        }
      }),
  };
}

/** The engine glTF loader over the product web host's `tnw_web_load_gltf`, when the module has it. */
function gltfOf(
  abi: TnAbiModule,
  context: number,
  h: Pick<IAbiHelpers, "scoped" | "alloc"> & { keyOf(pointer: number): IEngineRef },
): Pick<IBrowserRuntime, "loadGltf"> {
  // quality-allow: TnAbiModule does not declare optional host glTF C-ABI symbols, cast to access optional exports.
  const host = abi as unknown as Partial<
    Record<"_tnw_web_load_gltf" | "_tnw_web_load_error", (...args: number[]) => number>
  >;
  const { _tnw_web_load_gltf: load, _tnw_web_load_error: error } = host;
  if (load === undefined || error === undefined) return {};
  return {
    loadGltf: (bytes, images = [], clips = 63) =>
      h.scoped(() => {
        const data = h.alloc(Math.max(1, bytes.byteLength));
        abi.HEAPU8.set(bytes, data);
        const count = h.alloc(4);
        // The page's images by id in the host's table (web_host.cpp tnw_js_copy_image); the host
        // closes each with the last texture that holds it, or at once when no texture took it.
        // quality-allow: the web host module carries its image table as a property it reads by name.
        const table = imageTable(abi);
        const triples = h.alloc(Math.max(4, images.length * 12));
        images.forEach((image, i) => {
          const id = image === undefined ? 0 : nextImage++;
          if (image !== undefined) table.set(id, image);
          const v = new DataView(abi.HEAPU8.buffer);
          v.setUint32(triples + i * 12, id, true);
          v.setUint32(triples + i * 12 + 4, image?.width ?? 0, true);
          v.setUint32(triples + i * 12 + 8, image?.height ?? 0, true);
        });
        // The clip count sizes the handles once: a retry would load the images a second time.
        for (let capacity = clips + 1; ; ) {
          const out = h.alloc(HANDLE * capacity);
          const status = load(
            context,
            data,
            bytes.byteLength,
            out,
            capacity,
            count,
            triples,
            images.length,
          );
          const needed = new DataView(abi.HEAPU8.buffer).getUint32(count, true);
          if (status === 0) {
            const refs = Array.from({ length: needed }, (_, i) => h.keyOf(out + i * HANDLE));
            return { scene: refs[0] as IEngineRef, animations: refs.slice(1) };
          }
          const reason = abi.UTF8ToString(error());
          if (reason !== "TN_WASM_GLTF_CAPACITY" || needed <= capacity) throw new Error(reason);
          capacity = needed;
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
  // quality-allow: TnAbiModule does not declare optional TSL C-ABI entrypoints, cast to access optional exports.
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
          if (setPost(context, nodeOf(node)) !== 0) throw new Error("TN_WASM_POST: refused");
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
let callCounts = (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts;
// The global is an accessor over a module variable, so a census that is off costs no global lookup.
Object.defineProperty(globalThis, "__tnCallCounts", {
  configurable: true,
  get: () => callCounts,
  set: (counts: Map<string, number> | undefined) => {
    callCounts = counts;
  },
});
function countCall(kind: string, self: IEngineRef, name: string): void {
  const counts = callCounts;
  if (counts === undefined) return;
  const key = `${kind} ${self.type}.${name}`;
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function createWasmRuntime(abi: TnAbiModule): IBrowserRuntime {
  // Growth replaces HEAPU8; comparing it is one load, where comparing buffers is two getter calls.
  let heap = abi.HEAPU8;
  let dataView = new DataView(heap.buffer);
  const view = () => {
    if (heap !== abi.HEAPU8) {
      heap = abi.HEAPU8;
      dataView = new DataView(heap.buffer);
    }
    return dataView;
  };
  // Each call frees what it allocated, and only that: a callback can run a nested call.
  // A call's scratch (its handle, arguments, result and diagnostic) comes from one arena that each
  // scope rewinds, a stack as nested calls (a callback inside an invoke) need; a scope that outgrows
  // it falls back to malloc and frees on exit. Every engine call crosses here, many per frame.
  // The arena above its top is always zero: a scope clears what it used once, on exit, where
  // clearing each block cost a fill call per handle, value, result and diagnostic.
  const arenaSize = 64 * 1024;
  const arenaBase = abi._malloc(arenaSize) >>> 0;
  abi.HEAPU8.fill(0, arenaBase, arenaBase + arenaSize);
  let arenaTop = arenaBase;
  const allocations: number[] = [];
  // `clear: false` for a block the caller overwrites whole (a number list, a string).
  const alloc = (size: number, clear = true): number => {
    const aligned = (size + 7) & ~7;
    if (arenaTop + aligned <= arenaBase + arenaSize) {
      const pointer = arenaTop;
      arenaTop += aligned;
      return pointer;
    }
    // `>>> 0`: the module addresses up to 4 GB, and an export returns a pointer as a signed i32.
    const pointer = abi._malloc(size) >>> 0;
    allocations.push(pointer);
    if (clear) abi.HEAPU8.fill(0, pointer, pointer + size);
    return pointer;
  };
  const scoped = <T>(work: () => T): T => {
    const mark = allocations.length;
    const top = arenaTop;
    try {
      return work();
    } finally {
      while (allocations.length > mark) abi._free(allocations.pop() as number);
      if (arenaTop > top) abi.HEAPU8.fill(0, top, arenaTop);
      arenaTop = top;
    }
  };
  const string = (text: string): { pointer: number; bytes: number } => {
    const bytes = abi.lengthBytesUTF8(text);
    const pointer = alloc(bytes + 1, false);
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
  const keyOf = (pointer: number): IEngineRef => {
    const v = view();
    const type = v.getUint16(pointer, true);
    const key = `${type}:${v.getUint16(pointer + 2, true)}:${v.getUint32(pointer + 4, true)}:${v.getUint32(pointer + 8, true)}`;
    return { key, type };
  };
  // A ref's handle fields read straight from the digits of its key, "type:context:index:generation".
  // Most refs reach here once (keyOf makes a new one per result), so a per-ref cache only missed.
  const writeHandle = (pointer: number, ref: IEngineRef) => {
    const key = ref.key;
    const v = view();
    let field = 0;
    let value = 0;
    for (let i = 0; i <= key.length; i++) {
      const code = i < key.length ? key.charCodeAt(i) : 58; // ":" ends the last field
      if (code !== 58) {
        value = value * 10 + code - 48;
        continue;
      }
      if (field < 2) v.setUint16(pointer + field * 2, value, true);
      else v.setUint32(pointer + (field - 1) * 4, value, true);
      field++;
      value = 0;
    }
  };
  const handleOf = (ref: IEngineRef): number => {
    const pointer = alloc(HANDLE);
    writeHandle(pointer, ref);
    return pointer;
  };
  // A number list: f64 values, with the typed array's name (0 for a plain array).
  const writeNumbers = (pointer: number, list: ArrayLike<number>, name: number) => {
    const numbers = alloc(Math.max(8, list.length * 8), false);
    abi.HEAPF64.set(list, numbers / 8);
    const w = view();
    w.setUint32(pointer, KIND.numbers, true);
    w.setUint32(pointer + 32, name, true);
    w.setUint32(pointer + 48, numbers, true);
    w.setBigUint64(pointer + 40, BigInt(list.length), true);
  };
  // A typed array the engine knows by name: its own bytes, one copy; an attribute keeps them as its
  // storage with no f64 round trip.
  const writeBytes = (pointer: number, list: TypedArray, name: number) => {
    const bytes = alloc(Math.max(8, list.byteLength), false);
    abi.HEAPU8.set(new Uint8Array(list.buffer, list.byteOffset, list.byteLength), bytes);
    const w = view();
    w.setUint32(pointer, KIND.bytes, true);
    w.setUint32(pointer + 32, name, true);
    w.setUint32(pointer + 48, bytes, true);
    w.setBigUint64(pointer + 40, BigInt(list.length), true);
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
    if (ArrayBuffer.isView(value)) {
      const name = value.constructor.name;
      return BYTE_ARRAYS.has(name)
        ? writeBytes(pointer, value, string(name).pointer)
        : writeNumbers(pointer, value, string(name).pointer);
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
    if (allNumbers(value)) {
      writeNumbers(pointer, value as number[], 0);
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
  // A plain array of f64s; an indexed loop, where Array.from walks the typed array's iterator.
  const doubles = (address: number, count: number): number[] => {
    const heap = abi.HEAPF64;
    const at = address / 8;
    const list = new Array<number>(count);
    for (let i = 0; i < count; i++) list[i] = heap[at + i] as number;
    return list;
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
      case KIND.numbers:
        return doubles(v.getUint32(pointer + 48, true), Number(v.getBigUint64(pointer + 40, true)));
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
    ...hostImageOf(abi, { scoped, alloc, writeHandle }),
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
    writeDouble: (address, value) => {
      abi.HEAPF64[address / 8] = value;
    },
    readByte: (address) => abi.HEAPU8[address] as number,
    readDoubles: (address, count) =>
      count === 1 ? (abi.HEAPF64[address / 8] as number) : doubles(address, count),
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
    attributeArray: (self) => withAttributeView(self, (array) => array.slice()),
    attributeWrite: (self, array) =>
      withAttributeView(self, (target) => {
        if (target.length !== array.length)
          throw new RangeError(
            `TN_NATIVE_ATTRIBUTE_LENGTH: attribute.array has ${String(array.length)} elements, the attribute ${String(target.length)}`,
          );
        target.set(array);
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
