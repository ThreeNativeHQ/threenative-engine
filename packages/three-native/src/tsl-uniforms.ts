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
  /** Reused extraction storage, never aliased with `lanes`: the sink reads it before it is refilled. */
  scratch?: number[];
}

function sameLanes(a: readonly number[] | undefined, b: readonly number[]): boolean {
  if (a === undefined || a.length !== b.length) return false;
  for (let i = 0; i < b.length; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

/**
 * One float per lane: a number, a Color's r, g, b, or a VectorN's x, y, z, w. `out`, when given,
 * receives the lanes and is returned, so a uniform can refill one bounded scratch array per sync.
 */
export function uniformLanes(value: unknown, out?: number[]): number[] {
  const lanes = out ?? [];
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
  throw new TypeError(`TN_TSL_UNIFORM_VALUE: ${String(value)} is not a number, Color or vector`);
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
 * then the edited objects' lanes, each written only when its lanes changed.
 */
export function liveUniforms<TNode extends object>(
  uniform: (value: unknown, type?: unknown) => TNode,
  setValues: (node: TNode, lanes: readonly number[]) => void,
): {
  uniform: (value: unknown, type?: unknown) => TNode;
  uniformArray: (
    values: unknown[],
    type?: string,
  ) => { array: unknown[]; element(index: unknown): TNode };
  reference(property: string, type: string, object?: unknown): TNode;
  sync(frame?: { camera?: unknown; scene?: unknown; frameId?: number }): void;
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
  const objects = new Set<WeakRef<TNode>>();
  // Strong: a hook's node is chained into a material and dropped, so the wrapper is all JS holds, and a
  // collected wrapper silently ended its updates. ponytail: kept for the page's life; the engine release
  // of such a node waits too. Release with the owning material if a game builds hooked uniforms in a loop.
  const updating = new Set<TNode>();
  let frameId = 0;
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
    setValues(node, written);
    if (debug) {
      count("uniformWrites");
      count("uniformLaneWrites", lanes.length);
    }
    state.lanes = written;
  };
  const live = {
    uniform(value: unknown, type?: unknown): TNode {
      const node = type === undefined ? uniform(value) : uniform(value, type);
      const state: IUniformState = { value, scratch: [] };
      states.set(node, state);
      Object.defineProperty(node, "value", {
        configurable: true,
        get: () => state.value,
        set: (next: unknown) => {
          write(node, state, uniformLanes(next, state.scratch));
          state.value = next;
        },
      });
      if (typeof value === "object" && value !== null) objects.add(new WeakRef(node));
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
        if (state.update === undefined) updating.add(node);
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
     * `values[i]` before each render, as UniformArrayNode copies its array per update. ponytail: a
     * node index needs an engine uniform array; it is refused by name.
     */
    uniformArray(values: unknown[]) {
      if (!Array.isArray(values))
        throw new TypeError("TN_TSL_UNIFORM_ARRAY: uniformArray takes an array");
      const elements = new Map<number, TNode>();
      return {
        array: values,
        element(index: unknown): TNode {
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
        },
      };
    },
    sync(extra?: { camera?: unknown; scene?: unknown; frameId?: number }) {
      // `extra.frameId` is the renderer's frame: every render, target draw and compute of one frame
      // shares it. The callbacks see this module's own counter, as three's NodeFrame counts renders.
      const started = debug ? performance.now() : 0;
      if (debug) count("uniformSyncCalls");
      try {
        const rendererFrame = extra?.frameId;
        const frame: IUpdateFrame = { ...extra, frameId: ++frameId };
        for (const node of updating) {
          const state = states.get(node);
          if (state?.update === undefined) continue;
          if (state.updateType === "frame" && rendererFrame !== undefined) {
            if (state.ranFrame === rendererFrame) continue;
            state.ranFrame = rendererFrame;
          }
          let next: unknown;
          if (debug) {
            const callbackStart = performance.now();
            count(
              state.updateType === "frame" ? "uniformFrameCallbacks" : "uniformRenderCallbacks",
            );
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
      } finally {
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
