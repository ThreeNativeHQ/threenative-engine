/**
 * three's `uniform(value).value` for both engine back ends (PRD-540). As r185's InputNode, `.value = x`
 * replaces the value and the getter returns what was written; a Color or VectorN value can then be
 * edited in place (`origin.value.set(x, z)`, as Midway's ocean does), and `sync()` pushes the edited
 * objects' lanes before a frame draws. A write goes through at once, and the engine refuses one whose
 * lanes do not fit the uniform's type. Either way the engine keeps the program.
 */

import { callerOf } from "./bridge-meter.js";
import { debugRequested } from "./debug-telemetry.js";

/** three's update `frame`: the rendering camera and scene, with the frame counter. */
export interface IUpdateFrame {
  frameId: number;
  camera?: unknown;
  scene?: unknown;
  renderer?: unknown;
}

/** What one sync is for: the draw's camera and root, the renderer's frame, and a dispatch's kernels (engine node ids). */
export interface ISyncFrame {
  camera?: unknown;
  scene?: unknown;
  renderer?: unknown;
  frameId?: number;
  kernels?: readonly number[];
}

interface IUniformState {
  value: unknown;
  /** three's `node.update`, set by onRenderUpdate/onFrameUpdate; its result becomes `.value`. */
  update?: (frame: IUpdateFrame) => unknown;
  /** three's update type: "frame" runs once per renderer frame, "render" once per render call. */
  updateType?: string;
  /** Bounded debug-only callback registration site. */
  debugSource?: string;
  /** The renderer frame a "frame" update last ran in. */
  ranFrame?: number;
  /** The lanes last written to the engine: an unchanged value is not written again. */
  lanes?: readonly number[];
  /** True when sync() scans this uniform's value object every call (it could not be watched). */
  scanned?: boolean;
  /** Reused extraction storage, never aliased with `lanes`: the sink reads it before it is refilled. */
  scratch?: number[];
}

/** A watched value's hook back to scanning, called by a back end before it replaces the value's lanes. */
export const UNWATCH = Symbol.for("threenative.uniformUnwatch");

/** The lanes a watched value object (Color, VectorN) carries as plain fields. */
const WATCHED_LANES = ["x", "y", "z", "w", "r", "g", "b"] as const;

function sameLanes(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/** A three Matrix3 or Matrix4's elements (9 or 16 numbers), or undefined for any other value. */
export function matrixElements(value: unknown): ArrayLike<number> | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const elements = (value as { elements?: unknown }).elements;
  if (
    (Array.isArray(elements) || ArrayBuffer.isView(elements)) &&
    ((elements as ArrayLike<number>).length === 16 || (elements as ArrayLike<number>).length === 9)
  )
    return elements as ArrayLike<number>;
  return undefined;
}

/** "mat3" or "mat4" for a three Matrix3 or Matrix4, the type its uniform is made at; otherwise undefined. */
function matrixType(value: unknown): "mat3" | "mat4" | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as { isMatrix3?: unknown; isMatrix4?: unknown };
  return v.isMatrix3 === true ? "mat3" : v.isMatrix4 === true ? "mat4" : undefined;
}

/**
 * One float per lane: a number, a Color's r, g, b, a VectorN's x, y, z, w, or a Matrix3/Matrix4's
 * elements (column-major, as three stores them). `out`, when given, receives the lanes and is
 * returned, so a uniform can refill one bounded scratch array per sync.
 */
export function uniformLanes(value: unknown, out?: number[]): number[] {
  // A Matrix3 or Matrix4: its column-major elements, the order the engine writes a matN uniform in.
  const elements = matrixElements(value);
  if (elements === undefined) return valueLanes(value, out ?? []);
  const lanes = out ?? [];
  lanes.length = elements.length;
  for (let i = 0; i < elements.length; i += 1) lanes[i] = elements[i] as number;
  return lanes;
}

function valueLanes(value: unknown, lanes: number[]): number[] {
  if (typeof value === "number") {
    lanes.length = 1;
    lanes[0] = value;
    return lanes;
  }
  if (typeof value === "object" && value !== null) {
    const v = value as Record<string, unknown>;
    if (typeof v.x === "number" && typeof v.y === "number") {
      lanes.length = 2;
      lanes[0] = v.x;
      lanes[1] = v.y;
      if (typeof v.z === "number") lanes[lanes.length] = v.z;
      if (typeof v.w === "number") lanes[lanes.length] = v.w;
      return lanes;
    }
    if (typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") {
      lanes.length = 3;
      lanes[0] = v.r;
      lanes[1] = v.g;
      lanes[2] = v.b;
      return lanes;
    }
  }
  throw new TypeError(
    `TN_TSL_UNIFORM_VALUE: ${String(value)} is not a number, Color, vector or Matrix3/Matrix4`,
  );
}

function referenceValue(property: string, type: string, object: unknown): unknown {
  const types: Readonly<Record<string, number>> = { float: 1, color: 3, vec2: 2, vec3: 3, vec4: 4 };
  const lanes = types[type];
  if (lanes === undefined)
    throw new TypeError(
      `TN_TSL_REFERENCE_TYPE: reference '${type}' needs typed integer, boolean, matrix or buffer uniforms`,
    );
  if (typeof object !== "object" || object === null)
    throw new TypeError(
      "TN_TSL_REFERENCE_OBJECT: reference needs an explicit object; per-draw object references are unbound",
    );
  let value: unknown = object;
  for (const key of property.split(".")) {
    if (typeof value !== "object" || value === null)
      throw new TypeError(`TN_TSL_REFERENCE_VALUE: missing ${property}`);
    value = Reflect.get(value, key);
  }
  const values = uniformLanes(value);
  if (values.length !== lanes || !values.every(Number.isFinite))
    throw new TypeError(
      `TN_TSL_REFERENCE_VALUE: ${property} must match ${type} with finite values`,
    );
  return value;
}

/**
 * Wraps a back end's `uniform` so each uniform node it returns answers `.value` (an accessor on the
 * node itself: a V8 node has no prototype of its own to carry it) and three's update hooks. `setValues`
 * writes a node's lanes into the engine. `sync()` runs once per render: the update callbacks first,
 * then the edited objects' lanes, each written only when its lanes changed. With `setMany`, every
 * write of one sync crosses as one call (node i takes `counts[i]` of the packed `lanes`, PRD-828);
 * a `.value` set outside a sync still goes through `setValues` at once. `reads` (PRD-878) asks the engine which
 * of the hooked nodes one draw or dispatch reads, as indices into `hooked`; undefined runs every hook, as a
 * scene's render does.
 */
export function liveUniforms<TNode extends object>(
  uniform: (value: unknown, type?: unknown) => TNode,
  setValues: (node: TNode, lanes: readonly number[]) => void,
  setMany?: (nodes: readonly TNode[], counts: readonly number[], lanes: readonly number[]) => void,
  reads?: (frame: ISyncFrame, hooked: readonly TNode[]) => ArrayLike<number> | undefined,
): {
  uniform: (value: unknown, type?: unknown) => TNode;
  uniformArray: (
    values: unknown[],
    type?: string,
  ) => { array: unknown[]; element(index: unknown): TNode };
  reference(property: string, type: string, object?: unknown): TNode;
  sync(frame?: ISyncFrame): void;
} {
  const debug = debugRequested();
  const host = globalThis as {
    __tnEngineCost?: Record<string, number>;
    __tnDebugSources?: Record<
      string,
      { area: string; caller: string; lever: string; unit?: string }
    >;
  };
  if (debug) {
    host.__tnEngineCost ??= {};
    host.__tnDebugSources ??= {};
  }
  const totals = debug ? host.__tnEngineCost : undefined;
  const sources = debug ? host.__tnDebugSources : undefined;
  let callbackSites = 0;
  const count = (name: string, value = 1, caller = "tsl-uniforms.ts:liveUniforms.sync") => {
    if (totals === undefined || sources === undefined) return;
    totals[name] = (totals[name] ?? 0) + value;
    sources[name] ??= {
      area: "uniform",
      caller,
      ...(name.endsWith("Ms") ? { unit: "ms" } : {}),
      lever:
        "PERFORMANCE-LEARNINGS.md#2026-10-28--post-stages-re-run-the-scene-materials-render-callbacks--open-sized-not-cut",
    };
  };
  const states = new WeakMap<object, IUniformState>();
  // Object values sync() must scan every call: a matrix (its elements edit in place) or an object whose lanes it
  // cannot watch (accessors, a frozen or native object).
  // A hook's node or an object-valued node (`uniform(camera.matrixWorld)`) is chained into a material and dropped,
  // so the wrapper is all JS holds, and a collected wrapper silently ended its updates (a stale eye in a post
  // pass). An object-valued node is therefore pinned through the value the game owns, not forever: it lives as long
  // as the object it reads, so a per-material matrix is released with that matrix instead of growing a page-wide set
  // every sync walks. ponytail: the value is the closest owner this module sees; the engine release of such a node
  // waits too.
  const objects = new Set<WeakRef<TNode>>();
  const pinned = new WeakMap<object, TNode[]>();
  // The node lives exactly as long as `value` does, so a wrapper the game dropped is released with the object it
  // reads.
  const own = (node: TNode, value: object) => {
    const owners = pinned.get(value);
    if (owners === undefined) pinned.set(value, [node]);
    else owners.push(node);
  };
  // A plain Color or VectorN value is watched instead: its lanes become accessors that mark the uniforms reading it
  // dirty, so a sync reads only what was edited since the last one, however many uniforms the app holds. An edit
  // between two renders of one frame still reaches the second (FluidVolume edits uniforms between its passes).
  const watchers = new WeakMap<object, WeakRef<TNode>[]>();
  // Weak, as `objects` is: the value owns the node (own), and an entry whose node went with its value is dropped by
  // the sync that finds it gone.
  const dirty = new Set<WeakRef<TNode>>();
  const watch = (node: TNode, value: object): boolean => {
    if (matrixType(value) !== undefined) return false;
    const known = watchers.get(value);
    if (known !== undefined) {
      known.push(new WeakRef(node));
      own(node, value);
      return true;
    }
    const keys = WATCHED_LANES.filter((key) => Object.hasOwn(value, key));
    const plain = (key: string) => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return (
        field !== undefined &&
        "value" in field &&
        field.writable === true &&
        field.configurable === true
      );
    };
    if (keys.length === 0 || !keys.every(plain)) return false;
    const readers = [new WeakRef(node)];
    watchers.set(value, readers);
    own(node, value);
    // The Wasm back end gives a value it adopts (promote) engine-backed lanes: it calls this first, and the
    // uniforms reading it go back to being scanned.
    Object.defineProperty(value, UNWATCH, {
      configurable: true,
      value: () => {
        watchers.delete(value);
        for (const reader of readers) {
          const target = reader.deref();
          const state = target === undefined ? undefined : states.get(target);
          if (target === undefined || state === undefined || state.scanned === true) continue;
          state.scanned = true;
          objects.add(new WeakRef(target));
          own(target, value);
        }
      },
    });
    for (const key of keys) {
      let lane = (value as Record<string, unknown>)[key];
      Object.defineProperty(value, key, {
        configurable: true,
        enumerable: true,
        get: () => lane,
        set: (next: unknown) => {
          if (Object.is(next, lane)) return;
          lane = next;
          for (const reader of readers) {
            const target = reader.deref();
            if (target !== undefined) dirty.add(new WeakRef(target));
          }
        },
      });
    }
    return true;
  };
  const track = (node: TNode, state: IUniformState, value: unknown) => {
    if (typeof value !== "object" || value === null) return;
    dirty.add(new WeakRef(node)); // its first sync writes it, as a scan did
    if (state.scanned !== true && !watch(node, value)) {
      state.scanned = true;
      objects.add(new WeakRef(node));
      own(node, value);
    }
  };
  // Every node with an update callback, in the order its first callback was set (the engine's `reads` indexes it).
  const updating: TNode[] = [];
  // The render hooks alone: a nested render of a frame whose frame hooks all ran walks only these.
  const renders = new Set<TNode>();
  let hookedFrame: number | undefined;
  let frameId = 0;
  // One sync's writes, sent as one crossing at its end (PRD-828); a write outside a sync goes at once.
  let batching = false;
  const pendingNodes: TNode[] = [];
  const pendingCounts: number[] = [];
  const pendingLanes: number[] = [];
  const clear = () => {
    pendingNodes.length = 0;
    pendingCounts.length = 0;
    pendingLanes.length = 0;
  };
  // A batch that was refused or never sent (a hook threw) counts as not uploaded: the next sync writes each
  // node's current value again, so a `.value` set in between is not overwritten by a stale lane.
  const requeue = () => {
    for (const node of pendingNodes) {
      const state = states.get(node);
      if (state !== undefined) state.lanes = undefined;
      dirty.add(new WeakRef(node));
    }
    clear();
  };
  const flush = () => {
    if (pendingNodes.length === 0 || setMany === undefined) return;
    setMany(pendingNodes, pendingCounts, pendingLanes);
    if (debug) count("uniformWriteCrossings");
    clear();
  };
  // An unchanged value is not written again: an edited Color or vector is found by its lanes, and a
  // hook that returns the same number every render costs no engine write.
  const write = (node: TNode, state: IUniformState, lanes: readonly number[]) => {
    if (debug) {
      count("uniformWriteAttempts");
      count("uniformLaneWriteAttempts", lanes.length);
    }
    if (sameLanes(state.lanes, lanes)) {
      if (debug) {
        count("uniformUnchangedWriteAttempts");
        count("uniformUnchangedLaneWriteAttempts", lanes.length);
      }
      return;
    }
    // A snapshot for the sink and the state: `lanes` is the state's scratch, refilled by the next
    // extraction, so a sink that keeps its argument must not see later values.
    const written = lanes.slice();
    if (batching) {
      pendingNodes.push(node);
      pendingCounts.push(written.length);
      for (const lane of written) pendingLanes.push(lane);
    } else {
      setValues(node, written);
      if (debug) count("uniformWriteCrossings");
    }
    if (debug) {
      count("uniformWrites");
      count("uniformLaneWrites", lanes.length);
    }
    state.lanes = written;
  };
  // One sync's frame: one object, refilled each sync, as three's NodeFrame is one object.
  const frame: IUpdateFrame = { frameId: 0 };
  // Runs one node's update callback for this sync and writes what it returns.
  const updateNode = (node: TNode, rendererFrame: number | undefined): void => {
    const state = states.get(node);
    if (state?.update === undefined) return;
    if (state.updateType === "frame" && rendererFrame !== undefined) {
      if (state.ranFrame === rendererFrame) return;
      state.ranFrame = rendererFrame;
    }
    let next: unknown;
    if (debug) {
      const callbackStart = performance.now();
      count(state.updateType === "frame" ? "uniformFrameCallbacks" : "uniformRenderCallbacks");
      try {
        next = state.update(frame);
      } finally {
        const elapsed = performance.now() - callbackStart;
        count("uniformCallbackMs", elapsed);
        if (state.debugSource !== undefined)
          count(`uniformCallback:${state.debugSource}Ms`, elapsed, state.debugSource);
      }
    } else next = state.update(frame);
    if (next !== undefined) (node as { value: unknown }).value = next;
  };
  const live = {
    uniform(value: unknown, type?: unknown): TNode {
      // A matrix uniform is made by its type name at identity, then given the matrix's elements.
      const matrix = matrixType(value);
      const node =
        matrix !== undefined
          ? uniform(matrix)
          : type === undefined
            ? uniform(value)
            : uniform(value, type);
      const state: IUniformState = { value, scratch: [] };
      states.set(node, state);
      if (matrix !== undefined) write(node, state, uniformLanes(value, state.scratch));
      Object.defineProperty(node, "value", {
        configurable: true,
        get: () => state.value,
        set: (next: unknown) => {
          write(node, state, uniformLanes(next, state.scratch));
          if (next !== state.value) track(node, state, next);
          state.value = next;
        },
      });
      track(node, state, value);
      // three's UniformNode.onUpdate: the callback runs with the node as `this` and its result,
      // unless undefined, becomes the value. RENDER runs once per sync (one per render call); FRAME
      // runs once per renderer frame. A post chain renders about ten passes a frame (Lantern Vale), and
      // running every FRAME callback in each of them cost a tenth of the frame.
      const onUpdate = (
        callback: (this: TNode, frame: unknown, node: TNode) => unknown,
        updateType: string,
      ) => {
        if (updateType !== "frame" && updateType !== "render")
          throw new Error(
            `TN_TSL_UPDATE_UNSUPPORTED: a native uniform updates per frame or render, not per '${updateType}'`,
          );
        if (state.update === undefined) updating.push(node);
        if (updateType === "render") renders.add(node);
        else renders.delete(node);
        hookedFrame = undefined; // a frame hook added mid-frame runs at the next render
        state.update = (frame) => callback.call(node, frame, node);
        state.updateType = updateType;
        if (debug) {
          state.debugSource = undefined;
          if (callbackSites < 64) {
            state.debugSource = callerOf(new Error().stack);
            callbackSites++;
          }
        }
        state.ranFrame = undefined;
        return node;
      };
      Object.defineProperties(node, {
        onUpdate: { configurable: true, value: onUpdate },
        onFrameUpdate: {
          configurable: true,
          value: (callback: never) => onUpdate(callback, "frame"),
        },
        onRenderUpdate: {
          configurable: true,
          value: (callback: never) => onUpdate(callback, "render"),
        },
        onObjectUpdate: {
          configurable: true,
          value: (callback: never) => onUpdate(callback, "object"),
        },
      });
      return node;
    },
    reference(property: string, type: string, object?: unknown): TNode {
      if (typeof property !== "string" || property.split(".").some((key) => key.length === 0))
        throw new TypeError("TN_TSL_REFERENCE_PROPERTY: expected a nonempty property path");
      const node = live.uniform(referenceValue(property, type, object)) as TNode & {
        object: unknown;
        onRenderUpdate(callback: () => unknown): TNode;
      };
      Object.defineProperty(node, "object", { configurable: true, writable: true, value: object });
      node.onRenderUpdate(() => referenceValue(property, type, node.object));
      return node;
    },
    /**
     * three's uniformArray(values): `element(i)` at a constant index is a uniform that reads
     * `values[i]` before each render, as UniformArrayNode copies its array per update. A node index
     * (a Loop's `i`) selects among those uniforms. ponytail: one select per element on each read; an
     * engine uniform array when a game indexes long arrays.
     */
    uniformArray(values: unknown[]) {
      if (!Array.isArray(values))
        throw new TypeError("TN_TSL_UNIFORM_ARRAY: uniformArray takes an array");
      const elements = new Map<number, TNode>();
      type IIndexNode = { equal(k: number): { select(a: TNode, b: TNode): TNode } };
      const element = (index: unknown): TNode => {
        if (
          typeof index === "object" &&
          index !== null &&
          typeof (index as Partial<IIndexNode>).equal === "function" &&
          values.length > 0
        ) {
          let picked = element(values.length - 1);
          for (let k = values.length - 2; k >= 0; k--)
            picked = (index as IIndexNode).equal(k).select(element(k), picked);
          return picked;
        }
        if (
          typeof index !== "number" ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= values.length
        )
          throw new RangeError(
            `TN_TSL_UNIFORM_ARRAY: element needs a constant index in [0, ${values.length})`,
          );
        let node = elements.get(index);
        if (node === undefined) {
          node = live.uniform(values[index]);
          // quality-allow: TNode does not expose internal onRenderUpdate hook from WebGPU node system.
          const updatable = node as unknown as {
            onRenderUpdate: (callback: () => unknown) => void;
          };
          updatable.onRenderUpdate(() => values[index]);
          elements.set(index, node);
        }
        return node;
      };
      return { array: values, element };
    },
    sync(extra?: ISyncFrame) {
      // `extra.frameId` is the renderer's frame: every render, target draw and compute of one frame
      // shares it. The callbacks see this module's own counter, as three's NodeFrame counts renders.
      const started = debug ? performance.now() : 0;
      if (debug) count("uniformSyncCalls");
      const outer = !batching;
      batching = setMany !== undefined;
      try {
        const rendererFrame = extra?.frameId;
        frame.frameId = ++frameId;
        frame.camera = extra?.camera;
        frame.scene = extra?.scene;
        frame.renderer = extra?.renderer;
        // A nested render of a frame whose frame hooks already ran skips them without walking them.
        const nested = rendererFrame !== undefined && rendererFrame === hookedFrame;
        // A draw of one mesh or a dispatch runs only the hooks its graphs read (the engine answers which).
        const picked = extra === undefined ? undefined : reads?.(extra, updating);
        if (picked !== undefined)
          for (let index = 0; index < picked.length; index += 1)
            updateNode(updating[picked[index] as number] as TNode, rendererFrame);
        else for (const node of nested ? renders : updating) updateNode(node, rendererFrame);
        // Only once every hook returned: one that threw leaves later frame hooks to the next render. A picked
        // sync ran some hooks only, so it does not stand for the frame's.
        if (picked === undefined) hookedFrame = rendererFrame;
        // Deleted only once written: a sink that throws leaves the rest to retry at the next sync.
        for (const ref of dirty) {
          const node = ref.deref();
          if (node !== undefined) {
            const state = states.get(node);
            if (state !== undefined) write(node, state, uniformLanes(state.value, state.scratch));
          }
          dirty.delete(ref);
        }
        for (const ref of objects) {
          const node = ref.deref();
          if (node === undefined) {
            objects.delete(ref);
            continue;
          }
          const state = states.get(node);
          if (state !== undefined) write(node, state, uniformLanes(state.value, state.scratch));
        }
        flush();
      } finally {
        if (outer) {
          batching = false;
          requeue();
        }
        if (debug) count("uniformSyncMs", performance.now() - started);
      }
    },
  };
  return live;
}

/**
 * three's `uniform(false)` (a boolean toggle such as the exposure meter's `enabled`) over a back end's numeric
 * uniform. The ABI stores numeric lanes, so the boolean is the live float compared with zero (`notZero`); its
 * `.value` reads and writes booleans. Any other value goes to `uniform` as before.
 */
export function booleanUniforms<TNode extends object>(
  uniform: (value: unknown, type?: unknown) => TNode,
  notZero: (scalar: TNode) => TNode,
): (value: unknown, type?: unknown) => TNode {
  return (value, type) => {
    if (typeof value !== "boolean") return uniform(value, type);
    if (type !== undefined && type !== "bool")
      throw new TypeError("TN_TSL_UNIFORM_VALUE: a boolean uniform requires bool type");
    const scalar = uniform(Number(value)) as TNode & { value: number };
    return Object.defineProperty(notZero(scalar), "value", {
      get: () => Boolean(scalar.value),
      set: (next: unknown) => {
        if (typeof next !== "boolean")
          throw new TypeError("TN_TSL_UNIFORM_VALUE: expected a boolean");
        scalar.value = Number(next);
      },
    });
  };
}

/** The three classes a constant's value is made of. */
export type ConstClasses = Readonly<
  Record<"Vector2" | "Vector3" | "Vector4" | "Color", new (...lanes: number[]) => object>
>;

const CONSTANTS = ["float", "int", "uint", "vec2", "vec3", "vec4", "color"] as const;

/**
 * r185's ConstNode.value on the constant constructors, as getValueFromType makes it: float(2).value is
 * 2, vec3(1, 2, 3).value a Vector3 (one number fills every lane) and color(0xff0000).value a Color. A
 * call with a node argument is a conversion and keeps no value. Replaces the functions in `fns`.
 */
export function withConstValues(fns: Record<string, unknown>, classes: ConstClasses): void {
  for (const name of CONSTANTS) {
    const make = fns[name];
    if (typeof make !== "function") continue;
    const lanes = name.startsWith("vec") ? Number(name.slice(3)) : 0;
    const cls =
      name === "color"
        ? classes.Color
        : lanes > 0
          ? classes[`Vector${lanes}` as "Vector2"]
          : undefined;
    fns[name] = (...args: unknown[]) => {
      const node = (make as (...a: unknown[]) => object)(...args);
      if (args.length > 0 && args.every((arg) => typeof arg === "number")) {
        const numbers = args as number[];
        const value =
          cls === undefined
            ? numbers[0]
            : new cls(
                ...(numbers.length === 1 && lanes > 0 ? Array(lanes).fill(numbers[0]) : numbers),
              );
        Object.defineProperty(node, "value", { configurable: true, value });
      }
      return node;
    };
  }
}
