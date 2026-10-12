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
  loadGltf?(bytes: Uint8Array): { readonly scene: IEngineRef; readonly animations: IEngineRef[] };
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
    else if (isWrapperOf(current, "Vector3") && isWrapperOf(value, "Vector3"))
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
  const typeNames = new Map<number, string>();
  (globalThis as { __tnEngineTypes?: Map<number, string> }).__tnEngineTypes = typeNames;
  // Reads that need no engine call: a field the engine holds in place is read from its memory (Wasm,
  // `readDoubles`), and a fixed member (`position`, `matrixWorld`) is kept after its first answer.
  // Writes still go through the engine's setters, which it reacts to.
  const addresses = new WeakMap<object, number>();
  const kept = new WeakMap<object, Map<string, unknown>>();
  const fastGetter = (binding: IRegistryClass, property: string) => {
    const field = binding.fields?.[property];
    const read = runtime.readDoubles;
    if (field !== undefined && read !== undefined) {
      const [offset = 0, count = 1] = field;
      return function (this: object) {
        let address = addresses.get(this);
        if (address === undefined) {
          address = runtime.get(refOf(this), "__address") as number;
          addresses.set(this, address);
        }
        return read(address + offset, count);
      };
    }
    if (binding.fixedMembers?.includes(property) && !binding.setters.includes(property))
      return function (this: object) {
        let members = kept.get(this);
        if (members === undefined) {
          members = new Map();
          kept.set(this, members);
        }
        if (!members.has(property))
          members.set(property, fromEngine(runtime.get(refOf(this), property)));
        return members.get(property);
      };
    return undefined;
  };
  const wrappers = new Map<string, WeakRef<object>>();
  // Callbacks: the function lives on its wrapper (a WeakMap entry), so wrapper -> closure is an edge
  // the collector sees; `held` roots a wrapper while the engine may still call it.
  const callbackFunctions = new WeakMap<object, Map<string, (...args: unknown[]) => unknown>>();
  const callbackNames = new Map<string, Set<string>>(); // by handle key, to clear on collection
  const held = new Set<object>();
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
    held.add(wrapper);
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
      const list = Array.from(value as unknown as ArrayLike<number>);
      Object.defineProperty(list, TYPED, { value: value.constructor.name });
      return list;
    }
    if (Array.isArray(value)) return Array.from(value as ArrayLike<unknown>, toEngine);
    if (typeof value === "object" && REF in value) {
      // A wrapper passed into the engine is held until the next safe point decides (collect()).
      held.add(value);
      return (value as IWrapped)[REF];
    }
    // An options object (`new ExtrudeGeometry(shape, { depth })`) crosses as a record of scalars and
    // engine objects, as the V8 adapter passes it; an undefined value is left out, as three reads it.
    if (isPlainObject(value)) {
      const fields: Record<string, EngineValue> = {};
      for (const [key, item] of Object.entries(value as object)) {
        if (item === undefined) continue;
        if (item !== null && typeof item === "object" && !(REF in item))
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

  for (const [name, binding] of Object.entries(registry.classes)) {
    const adopts =
      attributeWrite !== undefined &&
      (name === "BufferAttribute" || name === "InstancedBufferAttribute");
    const writesAttributes = ATTRIBUTE_CLASSES.has(name) || name.endsWith("Geometry");
    const cls = class {
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
        if (parameters !== undefined) setValues(this, name, parameters);
        // three's BufferAttribute keeps the typed array it is handed; the typed subclasses copy.
        const handed = args[0];
        if (adopts && ArrayBuffer.isView(handed) && !(handed instanceof DataView)) {
          arrays.set(this, { array: handed as TypedArray, epoch });
          pending.add(this);
        }
      }
    };
    Object.defineProperty(cls, "name", { value: name });
    const prototype = cls.prototype as Record<string, unknown>;
    for (const method of binding.methods) {
      const bumps = writesAttributes && !/^(get|has|clone|equals|toJSON)/u.test(method);
      Object.defineProperty(prototype, method, {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]) {
          const intersections = method === "intersectObject" || method === "intersectObjects";
          if (pending.size > 0) writeBack();
          const result = fromEngine(
            runtime.invoke(
              refOf(this),
              method,
              (intersections ? args.slice(0, 2) : args).map(toEngine),
            ),
          );
          if (bumps) epoch++;
          if (intersections && args[2] !== undefined) {
            if (!Array.isArray(args[2]) || !Array.isArray(result))
              throw new TypeError("intersection target must be an array");
            args[2].push(...result);
            args[2].sort((a, b) => a.distance - b.distance);
            return args[2];
          }
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
    for (const property of [...binding.getters, ...binding.members]) {
      if (
        property.includes(".") ||
        binding.methods.includes(property) ||
        Object.hasOwn(prototype, property)
      )
        continue;
      Object.defineProperty(prototype, property, {
        configurable: true,
        get:
          fastGetter(binding, property) ??
          function (this: object) {
            return fromEngine(runtime.get(refOf(this), property));
          },
        ...(setters.has(property)
          ? {
              set(this: object, value: unknown) {
                runtime.set(refOf(this), property, toEngine(value));
              },
            }
          : {}),
      });
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
      if (property.includes(".") || Object.hasOwn(prototype, property)) continue;
      Object.defineProperty(prototype, property, {
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
          held.add(this);
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
                held.add(this);
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
      defineTraversal(
        prototype,
        name,
        binding.members.includes("children") || binding.getters.includes("children"),
        binding.methods.includes("__walk"),
      );
    }
    classes[name] = cls;
    byType.set(runtime.typeId(name), cls);
    typeNames.set(runtime.typeId(name), name);
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
            entry = { array: attributeArray.call(runtime, refOf(this)), epoch };
            arrays.set(this, entry);
          } else if (entry.epoch !== epoch && !pending.has(this)) {
            const fresh = attributeArray.call(runtime, refOf(this));
            if (fresh.length === entry.array.length) entry.array.set(fresh);
            else entry.array = fresh;
            entry.epoch = epoch;
          }
          pending.add(this);
          return entry.array;
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
      const candidates = [...held];
      const counts = runtime.engineReferences?.(candidates.map(refOf));
      // ponytail: every held wrapper is asked each safe point, in one call; keep a dirty set if a
      // scene's held count shows in a profile.
      candidates.forEach((wrapper, i) => {
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

/** The engine glTF loader over the product web host's `tnw_web_load_gltf`, when the module has it. */
function gltfOf(
  abi: TnAbiModule,
  context: number,
  h: Pick<IAbiHelpers, "scoped" | "alloc"> & { keyOf(pointer: number): IEngineRef },
): Pick<IBrowserRuntime, "loadGltf"> {
  const host = abi as unknown as Partial<
    Record<"_tnw_web_load_gltf" | "_tnw_web_load_error", (...args: number[]) => number>
  >;
  const { _tnw_web_load_gltf: load, _tnw_web_load_error: error } = host;
  if (load === undefined || error === undefined) return {};
  return {
    loadGltf: (bytes) =>
      h.scoped(() => {
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
  const keyOf = (pointer: number): IEngineRef => {
    const v = view();
    const type = v.getUint16(pointer, true);
    const key = `${type}:${v.getUint16(pointer + 2, true)}:${v.getUint32(pointer + 4, true)}:${v.getUint32(pointer + 8, true)}`;
    return { key, type };
  };
  // A ref's handle fields, parsed from its key once.
  const handles = new WeakMap<IEngineRef, readonly [number, number, number, number]>();
  const writeHandle = (pointer: number, ref: IEngineRef) => {
    let fields = handles.get(ref);
    if (fields === undefined) {
      fields = ref.key.split(":").map(Number) as [number, number, number, number];
      handles.set(ref, fields);
    }
    const [type, context, index, generation] = fields;
    const v = view();
    v.setUint16(pointer, type, true);
    v.setUint16(pointer + 2, context, true);
    v.setUint32(pointer + 4, index, true);
    v.setUint32(pointer + 8, generation, true);
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
