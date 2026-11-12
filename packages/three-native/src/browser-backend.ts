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

import { ENGINE_COST_KNOB, createBridgeMeter } from "./bridge-meter.js";
import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  isRef,
} from "./browser-abi-types.js";
import { ATTRIBUTE_CLASSES, defineAttributeSync, denormalize } from "./browser-attribute-sync.js";
import { REF, type TypedArray, isPlainObject, setValues } from "./browser-marshal.js";
import { UpstreamVector3, defineMath } from "./browser-math.js";
import {
  type IValueClass,
  defaultPlan,
  defineValueViews,
  valuePlans,
} from "./browser-value-views.js";
import { debugTelemetry } from "./debug-telemetry.js";
import { isCustomMrtOutput } from "./pass-node.js";
import { detachVirtualShadow, shadowFilterOptions, virtualShadowOptions } from "./shadow-node.js";
import { uploadRanges, withUpdateRanges } from "./update-ranges.js";

// The surface this module has always exported, kept on its path (PRD-803): `browser-entry.ts`,
// `browser-renderer.ts`, `browser-tsl.ts`, `texture-sources.ts` and the specs import them here.
export type {
  EngineValue,
  IBrowserRuntime,
  IEngineRef,
  TnAbiModule,
} from "./browser-abi-types.js";
export { createWasmRuntime } from "./browser-wasm-runtime.js";
export { eulerFromQuaternion } from "./browser-value-views.js";

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
  /** Running work totals by name (this back end's and the engine's), for TN_FRAME_BUDGET.counters.engine. */
  counters(): Record<string, number>;
  /** The wrapper for an engine object the engine handed over (a loaded model's scene). */
  wrap(ref: IEngineRef): object;
}

/** Safe points a pass over the settled wrappers spans. */
const SETTLED_PASS = 64;

/** An engine object's address, kept on it after the first ask: every lane read and write needs it. */
const ADDRESS = Symbol("tn.engineAddress");

export interface IWrapped {
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
  "dispose",
] as const;

/**
 * three r187's `Object3D.dispose()`: it fires `dispose`, the event a renderer frees the object's
 * render objects on, so a game's `Group` subclass can end its own `dispose()` with
 * `super.dispose()`. An engine binding with a `dispose` of its own keeps that one.
 */
function disposeObject(this: { dispatchEvent?(event: { type: string }): void }): void {
  this.dispatchEvent?.({ type: "dispose" });
}

type TraverseCallback = (object: object) => void;

/** The engine classes with their own raycast (`Mesh::raycast`, `Line::raycast`, `LOD::raycast`). */
const RAYCASTERS = new Set(["Mesh", "Line", "Sprite", "LOD"]);

/**
 * The `traverse` family, written over `children`, as three writes it. A class whose engine binding
 * has no `children` refuses by name instead of visiting only the root.
 */
function defineTraversal(
  prototype: Record<string, unknown>,
  className: string,
  hasChildren: boolean,
  walks: boolean,
  keep?: (object: object) => Record<string, unknown> | undefined,
  visited?: (count: number) => void,
  raycasts = true,
) {
  const childrenOf = (object: object): object[] => {
    if (!hasChildren) throw new TypeError(`TN_BROWSER_UNBOUND: ${className}.children`);
    return (object as { children: object[] }).children;
  };
  // The engine's walk: one crossing for the whole subtree, in three's order (`__walk`). The whole walk
  // depends on the hierarchy alone, so it is kept with `children` until the hierarchy counter moves;
  // a visible-only walk reads the visible flags too, so it is asked each time.
  const walk = (object: object, visibleOnly: boolean): object[] => {
    const entry = visibleOnly ? undefined : keep?.(object);
    if (entry !== undefined && entry.__walk !== undefined) return entry.__walk as object[];
    const found = (object as { __walk(visibleOnly: boolean): object[] }).__walk(visibleOnly);
    if (entry !== undefined) entry.__walk = found;
    visited?.(found.length);
    return found;
  };
  const methods: Record<string, (this: object, callback: TraverseCallback) => void> = {
    traverse(callback) {
      if (walks) {
        for (const object of walk(this, false)) callback(object);
        return;
      }
      visited?.(1);
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
      visited?.(1);
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
  // answers them through Raycaster.intersectObject (the object's native raycast). A class the engine
  // raycasts nothing for (a Group, a Bone, a light) keeps three's empty raycast and crosses nothing.
  const raycast = function (
    this: object,
    raycaster: { intersectObject(object: object, recursive: boolean): unknown[] },
    intersects: unknown[],
  ) {
    intersects.push(...raycaster.intersectObject(this, false));
  };
  Object.defineProperty(prototype, "raycast", {
    configurable: true,
    writable: true,
    value: raycasts ? raycast : () => undefined,
  });
}

/**
 * Defines every registry class over `runtime`. With `catalog`, classes chain as three's do
 * (`mesh instanceof Object3D`) and carry three's `is*` flags.
 */
/** A catalog field that is one of three's `is<Class>` type flags, which the back end sets to true. */
export const isTypeFlagField = (field: { name: string; type: string; mutable?: boolean }) =>
  /^is[A-Z]/u.test(field.name) &&
  (field.type === "true" || (field.type === "boolean" && field.mutable === false));

export function defineBrowserClasses(
  registry: IRegistryDump,
  source: IBrowserRuntime,
  catalog?: ICatalogShape,
): IBrowserEngine {
  // Every call into the engine counts, one increment each: the bench's crossing budget reads it per frame.
  // A census frame (bridge-meter.ts) also records each one by name, so a redundant read is named.
  let crossings = 0;
  const debug = source.debugTelemetry ?? debugTelemetry(source);
  let debugActivated = false;
  let crossingMicros: number | undefined;
  const typeNames = new Map<number, string>();
  const calibratedCrossingMicros = (): number => {
    if (crossingMicros === undefined) {
      const ref = source.construct("Group", []);
      const start = performance.now();
      for (let i = 0; i < 1000; i++) source.get(ref, "name");
      crossingMicros = performance.now() - start;
      source.release(ref);
      if (!Number.isFinite(crossingMicros) || crossingMicros < 0)
        throw new Error("TN_DEBUG: invalid crossing calibration.");
    }
    return crossingMicros;
  };
  const meter = createBridgeMeter({
    now: () => performance.now(),
    // Getter-equivalent microseconds: a thousand crossings measured in milliseconds.
    crossingMicros: calibratedCrossingMicros,
    typeName: (type) => typeNames.get(type) ?? String(type),
    stack: () => new Error().stack,
    report: (line) => console.warn(line),
  });
  const runtime: IBrowserRuntime = {
    ...source,
    construct: (className, args) => {
      crossings++;
      const ref = source.construct(className, args);
      if (meter.counting) meter.record("construct", ref, className);
      debug?.crossing("construct", ref, className, className);
      return ref;
    },
    get: (self, path) => {
      crossings++;
      if (meter.counting) meter.record("get", self, path);
      debug?.crossing("get", self, path, typeNames.get(self.type) ?? String(self.type));
      return source.get(self, path);
    },
    set: (self, path, value) => {
      crossings++;
      if (meter.counting) meter.record("set", self, path);
      debug?.crossing("set", self, path, typeNames.get(self.type) ?? String(self.type));
      source.set(self, path, value);
    },
    invoke: (self, method, args) => {
      crossings++;
      if (meter.counting) meter.record("call", self, method);
      debug?.crossing("call", self, method, typeNames.get(self.type) ?? String(self.type));
      return source.invoke(self, method, args);
    },
    ...(source.engineReferences === undefined
      ? {}
      : {
          engineReferences: (refs: readonly IEngineRef[]) => {
            crossings++;
            const first = refs[0];
            if (meter.counting && first !== undefined)
              meter.record("engineReferences", first, "engineReferences");
            if (debug !== undefined)
              debug.crossing(
                "engineReferences",
                first ?? { key: "batch", type: 0 },
                "engineReferences",
                "Object3D",
              );
            return source.engineReferences?.(refs) ?? [];
          },
        }),
  };
  if (debug !== undefined) {
    runtime.release = (self) => {
      debug.crossing("release", self, "release", typeNames.get(self.type) ?? String(self.type));
      source.release(self);
    };
    runtime.setCallback = (self, name, callback) => {
      debug.crossing("callback", self, name, typeNames.get(self.type) ?? String(self.type));
      source.setCallback(self, name, callback);
    };
    const attributeArray = source.attributeArray;
    if (attributeArray !== undefined)
      runtime.attributeArray = (self, offset, count) => {
        debug.crossing(
          "attributeRead",
          self,
          "array",
          typeNames.get(self.type) ?? String(self.type),
        );
        return attributeArray(self, offset, count);
      };
    const attributeWrite = source.attributeWrite;
    if (attributeWrite !== undefined)
      runtime.attributeWrite = (self, value, offset) => {
        debug.crossing(
          "attributeWrite",
          self,
          "array",
          typeNames.get(self.type) ?? String(self.type),
        );
        attributeWrite(self, value, offset);
      };
  }
  const classes: Record<string, new (...args: unknown[]) => object> = {};
  const byType = new Map<number, { prototype: object; own?: readonly IOwnField[] }>();
  (globalThis as { __tnEngineTypes?: Map<number, string> }).__tnEngineTypes = typeNames;
  // Reads that need no engine call: a field the engine holds in place is read from its memory (Wasm,
  // `readDoubles`), and a fixed member (`position`, `matrixWorld`) is kept after its first answer.
  // Writes still go through the engine's setters, which it reacts to.
  // Each object's kept `rotation` Euler (or `quaternion`) -> the object, whose other form a write syncs.
  const rotations = new WeakMap<object, object>();
  const quaternions = new WeakMap<object, object>();
  const sharedTransforms = debug === undefined ? undefined : new WeakSet<object>();
  const sharedTransformWrite =
    debug === undefined
      ? undefined
      : (self: object, address: number, value: number): void => {
          if (!sharedTransforms?.has(self)) return;
          debug.add(
            "sharedTransformWrites",
            1,
            "scene",
            "browser-backend.ts:shared transform setter",
          );
          if (source.readDoubles !== undefined && Object.is(source.readDoubles(address, 1), value))
            debug.add(
              "unchangedSharedTransformWrites",
              1,
              "scene",
              "browser-backend.ts:shared transform setter",
            );
        };
  // Properties only the object's own setter or methods change: `name` and `type` (read per track and
  // per bone while a game binds animations), an attribute's shape (read per merge), a mesh's
  // geometry and material. The answer is kept until JS sets it or calls a method on that object.
  // ponytail: an engine call on another object that changes one of these is missed; none does today.
  const legacyLabelled = new Set([
    "name",
    "type",
    "itemSize",
    "normalized",
    "gpuType",
    "geometry",
    "material",
  ]);
  // The bridge-read mirror (PRD-748): more properties whose only writers are their own setter and the
  // object's own methods, read from the bindings and every engine-side write (rg over src/engine), so
  // a game that reads them per callback pays one crossing, not one a read. Object3D's flags
  // (static_transform.cpp writes the two auto-update flags but nothing calls it), a light's shape and
  // target, fog density, the scene's slots, and the material state no animation track drives.
  // A fixed member with a setter (a light's or material's `color`) is a value the setter copies into,
  // so its handle is kept too, and so is a material's texture slot (`map`, `normalMap`, ...).
  const labelled = new Set([
    ...legacyLabelled,
    "id",
    "uuid",
    "renderOrder",
    "frustumCulled",
    "matrixAutoUpdate",
    "matrixWorldAutoUpdate",
    "static",
    "__alwaysRender",
    "distance",
    "decay",
    "angle",
    "penumbra",
    "sourceRadius",
    "target",
    "density",
    "fog",
    "background",
    "environment",
    "backgroundIntensity",
    "backgroundBlurriness",
    "environmentIntensity",
    "side",
    "shadowSide",
    "transparent",
    "depthTest",
    "depthWrite",
    "blending",
    "toneMapped",
    "vertexColors",
    "flatShading",
    "colorWrite",
    "alphaHash",
    "forceSinglePass",
    "polygonOffset",
    "polygonOffsetFactor",
    "polygonOffsetUnits",
    "envMapIntensity",
    "aoMapIntensity",
    "bumpScale",
    // AnimationClip only: no setter, and no engine call rewrites a clip's length.
    "duration",
  ]);
  // The numbers an animation track can also drive (animation/property_binding.cpp: a light's intensity,
  // a perspective camera's lens, a material's numbers): kept like the rest, and dropped by any mixer or
  // action call, since the mixer writes them in the engine. Colours are written in place, so they stay.
  const animatedNames = new Set([
    "intensity",
    "fov",
    "zoom",
    "near",
    "far",
    "aspect",
    "focus",
    "opacity",
    "alphaTest",
    "emissiveIntensity",
    "roughness",
    "metalness",
    "shininess",
    "ior",
    "specularIntensity",
    // An action's and a mixer's own state (only these two classes carry the names): the mixer's update
    // advances time, ends fades and warps, and finishes a clip, so the same rule holds.
    "time",
    "timeScale",
    "weight",
    "paused",
    "enabled",
    "loop",
    "repetitions",
    "clampWhenFinished",
  ]);
  const mirrored = (binding: IRegistryClass, property: string, setters: Set<string>): boolean =>
    labelled.has(property) ||
    animatedNames.has(property) ||
    (setters.has(property) &&
      (binding.fixedMembers?.includes(property) === true || /^(map|[a-z]+Map)$/u.test(property)));
  const labels = new WeakMap<object, Map<string, unknown>>();
  let animated = new WeakMap<object, Map<string, unknown>>();
  // An action's `isScheduled()`: the mixer's list of active actions, which only the action's own
  // play/stop and the mixer's stopAllAction/uncache calls change (animation/mixer.cpp), never update,
  // setTime or clipAction (a rifle asks clipAction each frame).
  // core's AnimationPlayer asks it of every clip of every rig each step: 171 crossings a frame.
  let scheduling = new WeakMap<object, unknown>();
  // Object3D methods that move only the transform: the mirrored labels and numbers stay.
  const transformOnly =
    /^(updateMatrix|updateMatrixWorld|updateWorldMatrix|lookAt|rotate(X|Y|Z|OnAxis|OnWorldAxis)|translate(X|Y|Z|OnAxis)|apply(Matrix4|Quaternion)|setRotationFrom\w+|localToWorld|worldToLocal|updateProjectionMatrix)$/u;
  // `__THREENATIVE_BRIDGE_CACHE__ = false` (a page global the worker host forwards) turns the mirror, the
  // hierarchy cache and the JS Layers test off at the next safe point: the paired A/B knob.
  const knob = "__THREENATIVE_BRIDGE_CACHE__";
  const cacheWanted = () => (globalThis as Record<string, unknown>)[knob] !== false;
  let caching = cacheWanted();
  // Running totals a playtest bounds per frame (TN_FRAME_BUDGET.counters.engine): JS reads of
  // `children` (core's auto batch read the scene's each still frame) and the objects a `traverse`
  // visits (the projection window line walked 8,900 nodes every five seconds). One add each.
  let childrenReads = 0;
  let walkVisits = 0;
  const walked = (count: number) => {
    walkVisits += count;
  };
  // The glue's own entries, which the crossing count cannot see: a method wrapper and a property getter
  // run whether the cache answers or the engine does, and the cache answers most of them. Counted only
  // while a playtest bounds engine counters, so a shipped frame pays one branch and no store;
  // `collect()` is the safe point that reads the flag.
  let methodCalls = 0;
  let propertyReads = 0;
  let glueCounting = false;
  // The hierarchy cache: `children`, `parent` and a whole-subtree walk are kept until the engine's
  // process-wide hierarchy counter (Object3D::hierarchyVersion, read in place) moves. Every add,
  // remove, attach, clear and destructor moves it, and nothing else in the engine writes a children
  // list, so a kept answer is never stale. The table is replaced when the counter moves, so a kept
  // array never holds a removed subtree alive past the next read or safe point.
  let hierarchyAt: number | undefined;
  let engineCountersAt: readonly (readonly [string, number])[] = [];
  let keptVersion = -1;
  let kept = new WeakMap<object, Record<string, unknown>>();
  const readWord = source.readWord;
  const hierarchyKept = (self: object): Record<string, unknown> | undefined => {
    if (!caching || readWord === undefined) return undefined;
    hierarchyAt ??= runtime.get(refOf(self), "__hierarchy") as number;
    const version = readWord(hierarchyAt);
    if (version !== keptVersion) {
      keptVersion = version;
      kept = new WeakMap();
    }
    let entry = kept.get(self);
    if (entry === undefined) {
      entry = {};
      kept.set(self, entry);
    }
    return entry;
  };
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
              if (glueCounting) propertyReads += 1;
              return readByte(addressOf(this) + offset) !== 0;
            };
      return function (this: object) {
        if (glueCounting) propertyReads += 1;
        return read(addressOf(this) + offset, count);
      };
    }
    if (binding.fixedMembers?.includes(property) && !binding.setters.includes(property))
      // The first read defines the member as the object's own read-only property, as three's
      // Object3D has it: every later read is a plain property load, never this getter (R5 reads
      // position and rotation three times per cube per frame).
      return function (this: object) {
        if (glueCounting) propertyReads += 1;
        const member = fromEngine(runtime.get(refOf(this), property));
        Object.defineProperty(this, property, { value: member, writable: false });
        if (
          property === "position" ||
          property === "scale" ||
          property === "rotation" ||
          property === "quaternion"
        )
          sharedTransforms?.add(member as object);
        if (property === "rotation") rotations.set(member as object, this);
        if (property === "quaternion") quaternions.set(member as object, this);
        return member;
      };
    return undefined;
  };
  // An own property, not a WeakMap: `position.x` and every other lane access reads it (PRD-748).
  const addressOf = (self: object): number => {
    const known = (self as { [ADDRESS]?: number })[ADDRESS];
    if (known !== undefined) return known;
    const address = runtime.get(refOf(self), "__address") as number;
    Object.defineProperty(self, ADDRESS, { value: address });
    return address;
  };

  const math = defineMath() as Record<string, new (...args: unknown[]) => object>;
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

  const released = new FinalizationRegistry<IEngineRef>((ref) => {
    if (wrappers.get(ref.key)?.deref() === undefined) {
      debug?.add("bridgeWrappersReleased");
      wrappers.delete(ref.key);
      shaderNodes.delete(ref.key); // the engine material keeps its graph; the JS nodes may go
      for (const name of callbackNames.get(ref.key) ?? []) runtime.setCallback(ref, name, null);
      callbackNames.delete(ref.key);
      runtime.release(ref);
    }
  });

  const adopt = (target: object, ref: IEngineRef): object => {
    debug?.add("bridgeWrappersCreated");
    (target as IWrapped)[REF] = ref;
    wrappers.set(ref.key, new WeakRef(target));
    released.register(target, ref);
    return target;
  };
  const wrap = (ref: IEngineRef): object => {
    debug?.add("bridgeWrapRequests");
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

  const { toEngine, valueClasses, loans, repay, toEngineArgs, defineValueView } = defineValueViews({
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
  });
  const {
    attributeArray,
    attributeWrite,
    arrays,
    itemSizes,
    shapes,
    pending,
    dirty,
    writeBack,
    itemSizeOf,
    rangeOf,
    syncRange,
    syncFull,
    instanceItem,
    writeItemAt,
  } = defineAttributeSync({ runtime, refOf });

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

  const entries = new Map((catalog?.entries ?? []).map((entry) => [entry.name, entry]));
  // The engine raycasts a Mesh, a Line, a Sprite (each a Mesh in C++) and a LOD, and every kind of
  // them; any other node answers no hits. Without a catalog the chain is unknown, so every node asks.
  const raycasts = (name: string): boolean => {
    if (catalog === undefined) return true;
    for (
      let link = entries.get(name);
      link !== undefined;
      link = link.extends ? entries.get(link.extends) : undefined
    )
      if (RAYCASTERS.has(link.name)) return true;
    return false;
  };
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
    const hierarchyClass = readWord !== undefined && binding.getters.includes("__hierarchy");
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
        if (
          debug !== undefined &&
          !debugActivated &&
          binding.setters.includes("__debugTelemetry")
        ) {
          runtime.set(refOf(this), "__debugTelemetry", true);
          debugActivated = true;
        }
        // The hierarchy counter's address, asked once a process at the first scene node made, and the
        // engine's work counts ("name@address,..."), each read in place per frame by counters().
        if (hierarchyAt === undefined && hierarchyClass) {
          hierarchyAt = runtime.get(refOf(this), "__hierarchy") as number;
          if (binding.getters.includes("__engineCounters"))
            engineCountersAt = String(runtime.get(refOf(this), "__engineCounters"))
              .split(",")
              .map((entry) => entry.split("@"))
              .map(([counter, address]) => [String(counter), Number(address)] as const);
        }
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
      // Update-range bookkeeping reads no attribute bytes, so it flushes no shadow: a streamed batch
      // that clears and re-adds its range each write sent every pending array, whole, twice.
      const bookkeeping =
        attributeClass && (method === "clearUpdateRanges" || method === "addUpdateRange");
      const geometryWrite = geometryClass && geometryWrites.has(method);
      // A mesh-level write into an attribute a game can hold a shadow of (see `instanceItem`).
      const instanceWrite =
        name !== "InstancedMesh"
          ? undefined
          : method === "setMatrixAt"
            ? "instanceMatrix"
            : method === "setColorAt"
              ? "instanceColor"
              : undefined;
      // A mixer or action call may write the tracks' targets (update, stop restoring originals).
      const drives =
        /^Animation(Mixer|Action|ObjectGroup)$/u.test(name) && !keeps && !/^is[A-Z]/u.test(method);
      const transforms = hierarchyClass && transformOnly.test(method);
      const schedule =
        name === "AnimationAction" && method === "isScheduled"
          ? "read"
          : name === "AnimationAction" && drives
            ? "own"
            : drives && !/^(update|setTime|clipAction|existingAction)$/u.test(method)
              ? "all"
              : undefined;
      // An action's clip and root are its construction arguments: kept like a geometry's attributes.
      const lifelong = name === "AnimationAction" && (method === "getClip" || method === "getRoot");
      Object.defineProperty(prototype, method, {
        configurable: true,
        writable: true,
        value(this: object, ...args: unknown[]) {
          if (glueCounting) methodCalls += 1;
          // An instance's matrix or colour is an array write, as in three, sent before the next engine call.
          if (instanceWrite !== undefined && writeItemAt(this, instanceWrite, args[0], args[1])) {
            labels.delete(this);
            animated.delete(this);
            return this;
          }
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
          const kept = query || (lifelong && caching);
          const key = kept ? `${method} ${String(args[0])}` : "";
          if (kept && labels.get(this)?.has(key)) return labels.get(this)?.get(key);
          if (schedule === "read" && caching && scheduling.has(this)) return scheduling.get(this);
          if (schedule === "own") {
            scheduling.delete(this);
            for (const arg of args)
              if (typeof arg === "object" && arg !== null) scheduling.delete(arg);
          } else if (schedule === "all") scheduling = new WeakMap();
          // A per-vertex setter writes its own range and reads no kept array, so a whole-shadow flush
          // would cost O(N) a call; it syncs just its range back below. Anything else flushes edits.
          if ((pending.size > 0 || dirty.size > 0) && !rangeMethod && !bookkeeping) writeBack();
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
          if (!keeps && !(transforms && caching)) {
            labels.delete(this);
            animated.delete(this);
          }
          // The item a mesh-level attribute write makes: read before the arguments cross, since a
          // Matrix4 is promoted in place, and written into the game's array once the call lands.
          const item =
            instanceWrite === undefined
              ? undefined
              : instanceItem(this, instanceWrite, args[0], args[1]);
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
            if (drives) animated = new WeakMap();
          }
          // The engine's clone and copy carry the material's graphs; the TSL nodes a slot reads back
          // follow them, or `clone().maskNode` answers null and a composed mask drops the source's.
          if (materialClass && (method === "clone" || method === "copy")) {
            const [from, to] = method === "clone" ? [this, result] : [args[0], this];
            const slots = shaderNodes.get(refOf(from as object).key);
            if (slots === undefined) shaderNodes.delete(refOf(to as object).key);
            else shaderNodes.set(refOf(to as object).key, new Map(slots));
          }
          if (method === "copy") {
            shapes.delete(this);
            itemSizes.delete(this);
          } else if (instanceWrite !== undefined) {
            const known = shapes.get(this);
            // The engine creates `instanceColor` on the first setColorAt: a cached null is stale.
            if (instanceWrite === "instanceColor" && known?.get("instanceColor") === null)
              known.delete("instanceColor");
            if (item !== undefined) item.array.set(item.values, item.at);
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
          if (kept)
            labels.get(this)?.set(key, result) ?? labels.set(this, new Map([[key, result]]));
          if (schedule === "read" && caching) scheduling.set(this, result);
          return result;
        },
      });
    }
    // three's `layers.test(other)` is one AND of two masks the engine holds in place (field `mask`): a
    // game tests each light's layers against the camera's per callback, so it stays in JS.
    if (
      name === "Layers" &&
      binding.fields?.mask !== undefined &&
      Object.hasOwn(prototype, "test")
    ) {
      const engineTest = prototype.test as (this: object, other: unknown) => boolean;
      Object.defineProperty(prototype, "test", {
        configurable: true,
        writable: true,
        value(this: { mask: number }, other: unknown) {
          if (!caching || other === null || typeof other !== "object")
            return engineTest.call(this, other);
          if (Object.getPrototypeOf(other) !== prototype) return engineTest.call(this, other);
          return (this.mask & (other as { mask: number }).mask) !== 0;
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
            const to = addressOf(this) + offset;
            const from = addressOf(other) + offset;
            heapF64(Math.max(to, from) + count * 8).copyWithin(to / 8, from / 8, from / 8 + count);
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
            const a = (addressOf(this) + offset) / 8;
            const b = (addressOf(other) + offset) / 8;
            const heap = heapF64((Math.max(a, b) + count) * 8);
            for (let i = 0; i < count; i++) if (heap[a + i] !== heap[b + i]) return false;
            return true;
          },
        },
      });
    }
    const setters = new Set(binding.setters);
    // A node material's TSL slots (`colorNode`) take an engine graph node, which no ABI value
    // carries: the graph goes in through the TSL runtime, and reading the slot answers the node set.
    for (const property of binding.setters.filter((key) => /^[a-z][A-Za-z]*Node$/u.test(key))) {
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
          // three's MRTNode: one engine graph node per output name, each at its own slot path, so a
          // material writes every colour target its mrt() names (pass-node.ts accepts any name).
          if (property === "mrtNode") {
            const slots = shaderNodes.get(ref.key) ?? new Map<string, unknown>();
            const previous =
              (slots.get(property) as { outputs?: Record<string, unknown> } | undefined)?.outputs ??
              {};
            if (value === null) {
              for (const [slot, node] of Object.entries(previous))
                if (isCustomMrtOutput(slot, node)) runtime.tsl?.set(ref, `mrtNode.${slot}`, 0);
              slots.delete(property);
              shaderNodes.set(ref.key, slots);
              return;
            }
            const outputs = (value as { isMRTNode?: boolean; outputs?: unknown }).outputs;
            if (
              (value as { isMRTNode?: boolean }).isMRTNode !== true ||
              outputs === null ||
              typeof outputs !== "object"
            )
              throw new TypeError(`TN_BROWSER_SHADER_NODE: ${name}.mrtNode takes mrt()`);
            for (const [slot, node] of Object.entries(outputs as Record<string, unknown>)) {
              // The scene pass draws the reserved targets itself; a material writes the custom ones.
              if (!isCustomMrtOutput(slot, node)) continue;
              if (node === null || typeof node !== "object" || !(TSL_NODE in node))
                throw new TypeError(
                  `TN_BROWSER_SHADER_NODE: ${name}.mrtNode '${slot}' is not a TSL node`,
                );
              runtime.tsl?.set(
                ref,
                `mrtNode.${slot}`,
                (node as Record<symbol, number>)[TSL_NODE] as number,
              );
            }
            for (const [slot, node] of Object.entries(previous))
              if (isCustomMrtOutput(slot, node) && !Object.hasOwn(outputs as object, slot))
                runtime.tsl?.set(ref, `mrtNode.${slot}`, 0);
            slots.set(property, value);
            shaderNodes.set(ref.key, slots);
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
      // One flag is a plain store in the engine: `matrixWorldNeedsUpdate` has no revision and no deferred
      // transform behind its setter, and core's physics interpolation arms it on every body after the draw
      // (stress lab: 300 crossings a frame). It is written in place, as the engine's own walks write it. The
      // render flags keep their call: `visible`, `castShadow` and `receiveShadow` bump render revisions.
      const store = runtime.writeByte;
      const inPlace =
        property === "matrixWorldNeedsUpdate" && store !== undefined ? flagField : undefined;
      // A geometry's bounds, once present, are one engine object the engine recomputes in place
      // (BufferGeometry::computeBoundingSphere); only its setter, copy() or another method replaces it.
      const bounds = geometryClass && (property === "boundingSphere" || property === "boundingBox");
      const shape =
        (attributeClass && ["itemSize", "count", "normalized", "gpuType"].includes(property)) ||
        (name === "InstancedMesh" &&
          ["count", "instanceMatrix", "instanceColor"].includes(property));
      const accessor: PropertyDescriptor = {
        configurable: true,
        get:
          (shape
            ? function (this: object) {
                if (property === "itemSize") return itemSizeOf(this);
                let known = shapes.get(this);
                if (known === undefined) {
                  known = new Map();
                  shapes.set(this, known);
                }
                if (!known.has(property))
                  known.set(property, fromEngine(runtime.get(refOf(this), property)));
                return known.get(property);
              }
            : undefined) ??
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
          // `children`, `parent` and an object's hierarchy revision are the kept hierarchy answers: every
          // add, remove and attach moves the engine's counter, and nothing else changes who is under whom or
          // when a subtree last did (`Object3D::subtreeVersion`, stamped from that same counter). Core's camera
          // pass reads each rate root's revision every frame to keep its rig index (stress lab: 120 a frame).
          ((property === "children" ||
            property === "parent" ||
            property === "__hierarchyRevision") &&
          binding.getters.includes("__hierarchy")
            ? function (this: object) {
                if (glueCounting) propertyReads += 1;
                if (property === "children") {
                  childrenReads += 1;
                  // The census names who reads it, though the cache answers without a crossing.
                  if (meter.counting) meter.record("read", refOf(this), "children");
                }
                const entry = hierarchyKept(this);
                if (entry === undefined) return fromEngine(runtime.get(refOf(this), property));
                if (!(property in entry))
                  entry[property] = fromEngine(runtime.get(refOf(this), property));
                return entry[property];
              }
            : mirrored(binding, property, setters) || bounds
              ? function (this: object) {
                  if (glueCounting) propertyReads += 1;
                  const legacy = legacyLabelled.has(property);
                  if (!caching && !legacy) return fromEngine(runtime.get(refOf(this), property));
                  const table = !legacy && animatedNames.has(property) ? animated : labels;
                  let known = table.get(this);
                  if (known === undefined) {
                    known = new Map();
                    table.set(this, known);
                  }
                  if (!known.has(property)) {
                    const value = fromEngine(runtime.get(refOf(this), property));
                    // The renderer computes a missing bound itself, so only a present one is kept.
                    if (bounds && value === null) return value;
                    known.set(property, value);
                  }
                  return known.get(property);
                }
              : function (this: object) {
                  if (glueCounting) propertyReads += 1;
                  return fromEngine(runtime.get(refOf(this), property));
                }),
        ...(lane !== undefined && write !== undefined
          ? {
              set(this: object, value: number) {
                const address = addressOf(this) + (lane[0] ?? 0);
                sharedTransformWrite?.(this, address, value);
                write(address, value);
              },
            }
          : setters.has(property)
            ? {
                set(this: object, value: unknown) {
                  // A flag write of the value the flag holds changes nothing in the engine: a game
                  // writes `visible` on hundreds of nodes a frame, so those stay out of the bridge.
                  if (flag !== undefined && typeof value === "boolean" && flag(this) === value)
                    return;
                  if (inPlace !== undefined && typeof value === "boolean") {
                    (store as (address: number, byte: number) => void)(
                      addressOf(this) + (inPlace[0] ?? 0),
                      value ? 1 : 0,
                    );
                    return;
                  }
                  if (caching && (mirrored(binding, property, setters) || bounds)) {
                    // A mirrored property's setter writes only that property: the others stay kept,
                    // and a write of the primitive the mirror holds changes nothing in the engine.
                    const legacy = legacyLabelled.has(property);
                    const known = (!legacy && animatedNames.has(property) ? animated : labels).get(
                      this,
                    );
                    if (
                      (value === null || typeof value !== "object") &&
                      known?.has(property) &&
                      known.get(property) === value
                    )
                      return;
                    labels.get(this)?.delete(property);
                    animated.get(this)?.delete(property);
                  } else {
                    labels.delete(this);
                    animated.delete(this);
                  }
                  // The shadow LOD sync skips its scene walk until this or the hierarchy moves.
                  if (property === "geometry") {
                    const host = globalThis as Record<symbol, unknown>;
                    const key = Symbol.for("threenative.geometryAssignments");
                    host[key] = ((host[key] as number | undefined) ?? 0) + 1;
                  }
                  runtime.set(refOf(this), property, toEngine(value));
                  if (shape) {
                    let known = shapes.get(this);
                    if (known === undefined) {
                      known = new Map();
                      shapes.set(this, known);
                    }
                    known.set(property, value);
                  }
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
        binding.getters.includes("__hierarchy") ? hierarchyKept : undefined,
        walked,
        raycasts(name),
      );
      if (!binding.methods.includes("dispose"))
        Object.defineProperty(prototype, "dispose", {
          configurable: true,
          writable: true,
          value: disposeObject,
        });
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
      // three's per-element getters read the attribute's own array; one engine call each made a vertex
      // walk (core's pose measurement over a licensed forest) cost 15 s of load. They read the shadow,
      // which the engine's own mutators keep in step, fetched once without marking it pending: the game
      // never holds this array, so there is no edit to write back.
      const shadow = (attribute: object): TypedArray => {
        let entry = arrays.get(attribute);
        if (entry === undefined) {
          entry = { array: attributeArray.call(runtime, refOf(attribute)) };
          arrays.set(attribute, entry);
        }
        return entry.array;
      };
      const component = (attribute: object, index: number, lane: number): number => {
        const array = shadow(attribute);
        const value = Number(array[index * itemSizeOf(attribute) + lane]);
        return (attribute as { normalized?: boolean }).normalized === true
          ? denormalize(value, array)
          : value;
      };
      Object.defineProperties(cls.prototype, {
        getX: {
          configurable: true,
          value(this: object, i: number) {
            return component(this, i, 0);
          },
        },
        getY: {
          configurable: true,
          value(this: object, i: number) {
            return component(this, i, 1);
          },
        },
        getZ: {
          configurable: true,
          value(this: object, i: number) {
            return component(this, i, 2);
          },
        },
        getW: {
          configurable: true,
          value(this: object, i: number) {
            return component(this, i, 3);
          },
        },
        getComponent: {
          configurable: true,
          value(this: object, i: number, lane: number) {
            return component(this, i, lane);
          },
        },
      });
      // needsUpdate is a property write, not a call: it hands the shadow to the engine as it stands.
      // Declared update ranges send only themselves, as three's own upload does
      // (WebGPUAttributeUtils.updateAttribute): a 10,000-instance batch that rewrote 40 records sent
      // all 10,000 each time. An edit outside the declared ranges stays unsent, as on three's GPU.
      const needsUpdate = Object.getOwnPropertyDescriptor(cls.prototype, "needsUpdate");
      if (needsUpdate?.set !== undefined)
        Object.defineProperty(cls.prototype, "needsUpdate", {
          ...needsUpdate,
          set(this: object, value: unknown) {
            const entry = arrays.get(this);
            if (value === true && entry !== undefined) {
              const ranges = uploadRanges(this);
              if (ranges.length === 0) attributeWrite.call(runtime, refOf(this), entry.array);
              for (const { start, count } of ranges) {
                const end = Math.min(start + count, entry.array.length);
                if (end > start)
                  attributeWrite.call(
                    runtime,
                    refOf(this),
                    entry.array.subarray(start, end),
                    start,
                  );
              }
              pending.delete(this);
              dirty.delete(this);
            }
            needsUpdate.set?.call(this, value);
          },
        });
    }
  }
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
      for (const field of (link.fields ?? []).filter(isTypeFlagField))
        Object.defineProperty(cls.prototype, field.name, {
          configurable: true,
          writable: true,
          value: true,
        });
  }
  // PRD-828: the engine advances a whole frame's animation rigs in one crossing. Core finds it by this
  // name and keeps its own per-rig loop when a backend installs nothing, so this cannot change a game
  // that runs on a backend without it.
  if (source.animTick !== undefined) {
    (globalThis as { __tnAnimationTick?: unknown }).__tnAnimationTick = (
      rigs: readonly {
        readonly mixer: object;
        readonly action: object | null;
        readonly strideRoot: object | null;
        readonly dt: number;
        readonly elapsed: number;
        readonly step: boolean;
        readonly reset: boolean;
        readonly lastRate: number;
        readonly clipGroundSpeed: number;
        readonly strideSync: boolean;
      }[],
      status: Float64Array,
    ): void => {
      const count = rigs.length;
      if (count === 0) return;
      const mixers: ReturnType<typeof refOf>[] = [];
      const actions: (ReturnType<typeof refOf> | null)[] = [];
      const roots: (ReturnType<typeof refOf> | null)[] = [];
      const values = new Float64Array(count * 5);
      for (let i = 0; i < count; i += 1) {
        const rig = rigs[i];
        if (rig === undefined) continue;
        mixers.push(refOf(rig.mixer));
        actions.push(rig.action === null ? null : refOf(rig.action));
        roots.push(rig.strideRoot === null ? null : refOf(rig.strideRoot));
        values[i * 5] = rig.dt;
        values[i * 5 + 1] = rig.elapsed;
        values[i * 5 + 2] = rig.clipGroundSpeed;
        values[i * 5 + 3] = rig.lastRate;
        // bit 0: the stride convention applies; bit 1: the action is real; bit 2: the body is real;
        // bit 3: this tick poses the rig; bit 4: the player spent ticks this batch did not.
        values[i * 5 + 4] =
          (rig.strideSync ? 1 : 0) |
          (rig.action === null ? 0 : 2) |
          (rig.strideRoot === null ? 0 : 4) |
          (rig.step ? 8 : 0) |
          (rig.reset ? 16 : 0);
      }
      crossings += 1;
      const first = mixers[0];
      if (meter.counting && first !== undefined) meter.record("call", first, "tn_anim_tick");
      source.animTick?.({ mixers, actions, roots, values, status });
      // Nothing to invalidate: every field this call writes — the mixer's `time`, the action's `time`,
      // `timeScale` and `weight` — is an engine-memory field on this back end (`fastGetter` over
      // `readDoubles` in the registry's `fields`), not a JS mirror, so a read after it is the engine's
      // answer. `bridge-mirror.spec.ts` pins exactly that.
    };
  }

  return {
    classes,
    wrap,
    crossings: () => crossings,
    // The back end's running totals, for TN_FRAME_BUDGET.counters.engine. `hierarchyMoves` is the
    // engine's hierarchy counter itself: each move drops every cache keyed on it, here and in C++.
    counters: () => {
      // Crossings ride their own series, TN_FRAME_BUDGET.counters.bridgeCrossings (__tnCrossingCount).
      // `methodCalls` and `propertyReads` are the glue entries that series cannot see: every wrapper
      // entry, crossed or answered by the cache.
      const totals: Record<string, number> = {
        childrenReads,
        methodCalls,
        propertyReads,
        walkVisits,
      };
      if (debug !== undefined) {
        // Getter-equivalent estimate, calibrated on this host; no per-crossing timer.
        const estimated = ((debug.totals.bridgeCrossings ?? 0) * calibratedCrossingMicros()) / 1000;
        debug.add(
          "bridgeCrossingMs",
          Math.max(0, estimated - (debug.totals.bridgeCrossingMs ?? 0)),
          "bridge",
          "browser-backend.ts",
          "estimated-ms",
        );
        debug.add("bridgeLiveWrappers", 0, "bridge", "browser-backend.ts", "gauge");
        Object.assign(totals, debug.totals, { bridgeLiveWrappers: wrappers.size });
      }
      if (readWord === undefined) return totals;
      if (hierarchyAt !== undefined) totals.hierarchyMoves = readWord(hierarchyAt);
      // Debug uses coherent 64-bit totals; off retains the original single-word census.
      for (const [counter, address] of engineCountersAt) {
        let value: number;
        if (debug === undefined) value = readWord(address) >>> 0;
        else {
          let before: number;
          let high: number;
          let low: number;
          do {
            before = readWord(address + 4) >>> 0;
            low = readWord(address) >>> 0;
            high = readWord(address + 4) >>> 0;
          } while (before !== high);
          value = high * 0x100000000 + low;
        }
        if (counter.endsWith("Micros")) totals[`${counter.slice(0, -6)}Ms`] = value / 1000;
        else totals[counter] = value;
      }
      return totals;
    },
    collect() {
      meter.frame();
      debug?.frame();
      glueCounting =
        debug !== undefined || (globalThis as Record<string, unknown>)[ENGINE_COST_KNOB] === true;
      const wanted = cacheWanted();
      // A setter or method drops an object's kept answers whether or not the cache is on, so turning it
      // back on keeps nothing stale; the two tables that other calls drop are emptied anyway.
      if (wanted !== caching) {
        caching = wanted;
        animated = new WeakMap();
        scheduling = new WeakMap();
        kept = new WeakMap();
      }
      if (
        hierarchyAt !== undefined &&
        readWord !== undefined &&
        readWord(hierarchyAt) !== keptVersion
      )
        kept = new WeakMap();
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
