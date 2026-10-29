import { countDebug, debugRequested } from "./debug-telemetry.js";

/**
 * Host-boundary counters, default-off, on the frame budget's own record.
 *
 * Two of the three hypotheses about the render phase's unattributed time are about crossings and
 * bytes — "the V8↔host boundary dominates" and "a buffer write per object per pass dominates" —
 * and neither can be answered by a JS CPU profile, because the time is spent on the other side of a
 * call the profiler attributes to a single frame. This counts the calls instead.
 *
 * What it counts, precisely, because a counter that overstates itself is worse than none:
 *
 *  - `hostCalls` — every WebGPU method invoked on the device's command encoders and on its queue.
 *    On a native host each of those is one crossing; in a browser it is one API call. It is not
 *    every crossing a frame makes: `mapAsync`, `getCurrentTexture` and the presentation path are
 *    issued by three and by the host outside these objects, and they are named here rather than
 *    folded in so the number can be checked against a host that counts its own.
 *  - `gpuBytes` — the byte count handed to `queue.writeBuffer`, exactly. Texture uploads are not
 *    included: a `writeTexture` size is a function of the destination's format, and estimating it
 *    from `data.byteLength` would be a number nobody could reconcile.
 *  - `jsAllocBytes` — the change in `performance.memory.usedJSHeapSize`, where the platform has it.
 *    Absent on a host without `performance.memory`, never zero: an unmeasurable allocation rate and
 *    a frame that allocated nothing are different facts.
 *
 * Wrapping every method of a command encoder is not free — it is one extra JS call per command, and
 * this is why the counters ride the same opt-in flag as the spans rather than being always on.
 */

/**
 * One frame's boundary counts, plus the simulation tick it closed on.
 *
 * Every boundary field is absent when the platform cannot report it. `simulationTick` is not a
 * platform reading: it is the loop's fixed-step count, absent when the caller fed none, and it
 * rides here so a plain frame-budget window can be joined to the simulation without the spans flag.
 */
export interface IFrameCounters {
  readonly gpuBytes?: number;
  readonly hostCalls?: number;
  readonly jsAllocBytes?: number;
  /**
   * JS->Wasm crossings this frame, from the web back end's own count (`createCrossingReader`).
   * Absent on a host whose back end keeps no such count.
   */
  readonly bridgeCrossings?: number;
  /**
   * This frame's engine work counts by name (`createEngineCounterReader`): the web back end's and the
   * engine's own totals, and `globalThis.__tnEngineCost`, differenced per frame. Absent unless a
   * playtest asked for them.
   */
  readonly engine?: Readonly<Record<string, number>>;
  /** The loop's fixed-step count at the frame's end; absent when the caller did not feed one. */
  readonly simulationTick?: number;
}

/** The slice of a WebGPU device this reads. Structural, so a test can stand in a fake. */
export interface ICounterDevice {
  createCommandEncoder?(): unknown;
  createRenderBundleEncoder?(): unknown;
  queue?: unknown;
}

/**
 * Methods never wrapped: lifecycle and events. `constructor` is skipped by name in the walk rather
 * than listed here, because an object literal's `constructor` key collides with `Object`'s own.
 */
const SKIP: Record<string, true> = {
  addEventListener: true,
  destroy: true,
  dispatchEvent: true,
  onuncapturederror: true,
  removeEventListener: true,
};

const GPU_COUNTERS: Readonly<Record<string, string>> = {
  createBuffer: "gpuBufferCreates",
  createTexture: "gpuTextureCreates",
  createBindGroup: "gpuBindGroupCreates",
  createRenderPipeline: "gpuPipelineCompiles",
  createRenderPipelineAsync: "gpuPipelineCompiles",
  mapAsync: "gpuReadbackMaps",
  submit: "gpuQueueSubmits",
  resolveQuerySet: "gpuQueryResolves",
  beginRenderPass: "gpuRenderPasses",
};

/**
 * Every function-valued method name on an object and its prototype chain.
 *
 * Enumerated rather than listed because the set of encoder methods is the WebGPU spec's, and a
 * hard-coded list silently stops counting the day a method is added.
 */
function methodNames(target: object): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let node: object | null = target;
  while (node !== null && node !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(node)) {
      if (name === "constructor" || seen.has(name) || SKIP[name] === true) continue;
      seen.add(name);
      // Read the descriptor, never the property. A WebGPU interface puts `label`, `queue`,
      // `features`, `limits` and `lost` on its prototype as accessors, and invoking one of those
      // getters with the prototype as `this` throws `TypeError: Illegal invocation` in Chrome —
      // measured, as a blank page with the flag on. A descriptor read cannot run user code, so
      // an accessor is simply not a method and is skipped.
      const descriptor = Object.getOwnPropertyDescriptor(node, name);
      if (descriptor === undefined || typeof descriptor.value !== "function") continue;
      names.push(name);
    }
    node = Object.getPrototypeOf(node) as object | null;
  }
  return names;
}

/**
 * The function stored at `name` on `owner` or its prototype chain, found without reading the
 * property. Returns `undefined` for an accessor, which is never a method worth counting.
 */
function resolveMethod(owner: object, name: string): ((...args: unknown[]) => unknown) | undefined {
  let node: object | null = owner;
  while (node !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(node, name);
    if (descriptor !== undefined)
      return typeof descriptor.value === "function"
        ? (descriptor.value as (...args: unknown[]) => unknown)
        : undefined;
    node = Object.getPrototypeOf(node) as object | null;
  }
  return undefined;
}

/** The WebGPU device behind a raw three renderer, when the backend exposes one. */
export function counterDeviceOf(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("backend" in raw)) return undefined;
  const backend = raw.backend;
  if (typeof backend !== "object" || backend === null || !("device" in backend)) return undefined;
  return backend.device;
}

/**
 * Counts the frame's boundary crossings and bytes, and reads what the platform will say about
 * allocation. Install once per renderer; `read` returns the counts since the previous `read`.
 */
export class FrameCounters {
  readonly #debug = debugRequested();
  #hostCalls = 0;
  #gpuBytes = 0;
  #lastHeapBytes: number | undefined;
  readonly #restore: (() => void)[] = [];
  readonly #wrappedEncoders = new WeakSet<object>();

  private constructor(device: ICounterDevice) {
    // A new encoder per pass, so an encoder's methods are wrapped the first time it is seen rather
    // than once at install: a wrapper installed on one encoder would miss every later pass.
    this.#wrap(
      device,
      this.#debug ? methodNames(device) : ["createCommandEncoder", "createRenderBundleEncoder"],
      (name, result) => {
        if (typeof result !== "object" || result === null) return;
        if (name.endsWith("Encoder")) this.#wrapEncoder(result);
        if (this.#debug && name === "createBuffer") this.#wrap(result, ["mapAsync"], undefined);
      },
    );
    const queue = device.queue;
    if (typeof queue === "object" && queue !== null)
      this.#wrap(queue, methodNames(queue), undefined);
  }

  /** Installs the counters on a device, or answers `undefined` when it has nothing to count. */
  static install(device: unknown): FrameCounters | undefined {
    if (typeof device !== "object" || device === null) return undefined;
    const counterDevice = device as ICounterDevice;
    if (typeof counterDevice.queue !== "object" || counterDevice.queue === null) return undefined;
    return new FrameCounters(counterDevice);
  }

  #wrapEncoder(encoder: object): void {
    if (this.#wrappedEncoders.has(encoder)) return;
    this.#wrappedEncoders.add(encoder);
    this.#wrap(encoder, methodNames(encoder), undefined);
  }

  #wrap(
    owner: object,
    names: readonly string[],
    after: ((name: string, result: unknown) => void) | undefined,
  ): void {
    const target = owner as Record<string, unknown>;
    for (const name of names) {
      // Same rule on the way in: resolve the function through descriptors along the chain rather
      // than through a property read, so an accessor anywhere on the chain cannot be invoked.
      const original = resolveMethod(owner, name);
      if (original === undefined) continue;
      const wrapped = (...args: unknown[]): unknown => {
        this.#hostCalls += 1;
        const start = this.#debug ? performance.now() : undefined;
        if (name === "writeBuffer") {
          // `writeBuffer(buffer, offset, data, dataOffset, size)`; `size` defaults to the rest of
          // the source, exactly as the spec says, so the count matches the bytes the driver sees.
          const data = args[2];
          const dataOffset = typeof args[3] === "number" ? args[3] : 0;
          const size = typeof args[4] === "number" ? args[4] : undefined;
          const available =
            typeof data === "object" &&
            data !== null &&
            "byteLength" in data &&
            typeof data.byteLength === "number"
              ? data.byteLength
              : 0;
          const elementBytes =
            ArrayBuffer.isView(data) &&
            "BYTES_PER_ELEMENT" in data &&
            typeof data.BYTES_PER_ELEMENT === "number"
              ? data.BYTES_PER_ELEMENT
              : 1;
          this.#gpuBytes +=
            size === undefined
              ? Math.max(0, available - dataOffset * elementBytes)
              : size * elementBytes;
        }
        const result = original.apply(owner, args);
        if (this.#debug) {
          const field = GPU_COUNTERS[name];
          if (field !== undefined) countDebug(field, 1, "gpu", `WebGPU.${name}`);
          if (start !== undefined)
            countDebug(`gpu.${name}Ms`, performance.now() - start, "gpu", `WebGPU.${name}`, "ms");
        }
        after?.(name, result);
        return result;
      };
      try {
        target[name] = wrapped;
        const weak = new WeakRef(target);
        this.#restore.push(() => {
          const live = weak.deref();
          if (live !== undefined) live[name] = original;
        });
      } catch {
        // A native binding may expose a non-writable method. Losing that one from the count is a
        // smaller error than throwing on a diagnostic install, and the report says how many were
        // counted rather than claiming completeness.
      }
    }
  }

  /** The counts since the previous read. */
  read(): IFrameCounters {
    const counters: IFrameCounters = {
      gpuBytes: this.#gpuBytes,
      hostCalls: this.#hostCalls,
    };
    this.#hostCalls = 0;
    this.#gpuBytes = 0;
    const heap = readHeapBytes();
    if (heap !== undefined) {
      const previous = this.#lastHeapBytes;
      this.#lastHeapBytes = heap;
      if (this.#debug) {
        countDebug("jsHeapBytesSampled", heap, "memory", "performance.memory.usedJSHeapSize");
        if (previous !== undefined)
          countDebug(
            heap >= previous ? "jsHeapGrowthBytes" : "jsHeapShrinkBytes",
            Math.abs(heap - previous),
            "memory",
            "performance.memory.usedJSHeapSize",
          );
      }
      if (previous !== undefined && heap >= previous)
        return { ...counters, jsAllocBytes: heap - previous };
      return counters;
    }
    return counters;
  }

  /** Removes every wrapper. A game that disposes its renderer must not leave the counters behind. */
  uninstall(): void {
    for (let index = this.#restore.length - 1; index >= 0; index -= 1) this.#restore[index]?.();
    this.#restore.length = 0;
  }
}

/**
 * The heap the platform will admit to, in bytes.
 *
 * Only Chromium publishes `performance.memory`, and only when its precise-memory flag is on; a
 * host without it answers `undefined` and the field stays absent rather than reading zero.
 */
function readHeapBytes(): number | undefined {
  const perf = globalThis.performance as { memory?: { usedJSHeapSize?: unknown } } | undefined;
  const used = perf?.memory?.usedJSHeapSize;
  return typeof used === "number" && Number.isFinite(used) ? used : undefined;
}

/**
 * The web back end's running count of JS->Wasm crossings, when the engine publishes one.
 *
 * `@threenative/three-native` installs `globalThis.__tnCrossingCount` (browser-entry.ts) and answers
 * the total so far, so one frame's crossings are a difference of two reads. It is a different number
 * from `hostCalls`: this counts the game's and the engine's calls into the engine's own ABI, which
 * on the owned engine is a Wasm boundary on the game thread, and `hostCalls` counts WebGPU API calls.
 * A host with no such back end (upstream three, the native player) answers `undefined`, and the
 * field stays absent rather than reading zero.
 *
 * Per frame, not cumulative: the counter rides the frame budget's window, whose series are
 * per-frame samples, and a cumulative total would climb with the window and say nothing about a frame.
 */
/** Set to `true` by a playtest that bounds engine counters (`engineCost`); three-native reads the same name. */
export const ENGINE_COST_KNOB = "__THREENATIVE_ENGINE_COST__";

interface IEngineCounterHost {
  readonly __tnDebugSources?: Readonly<Record<string, { readonly unit?: string }>>;
  readonly __THREENATIVE_ENGINE_COST__?: unknown;
  /** The web back end's running totals by name (three-native browser-entry.ts). */
  readonly __tnEngineCounters?: () => Readonly<Record<string, number>>;
  /** Totals any module counts by name (`bag[name] = (bag[name] ?? 0) + 1`), on every engine. */
  readonly __tnEngineCost?: Readonly<Record<string, number>>;
}

/**
 * One reader for every engine work counter, so a playtest bounds them all from one surface,
 * `TN_FRAME_BUDGET.counters.engine` (PRD-748's engine-cost row). Each source answers running totals;
 * this answers one frame's difference per name. Off unless `ENGINE_COST_KNOB` is set, so a shipped
 * frame pays nothing; the first read of a run is the baseline, not a frame.
 */
export function createEngineCounterReader(
  host: IEngineCounterHost = globalThis as IEngineCounterHost,
): () => Record<string, number> | undefined {
  const debug = debugRequested();
  let last: Record<string, number> | undefined;
  return () => {
    if (!debug && host.__THREENATIVE_ENGINE_COST__ !== true) return undefined;
    const totals: Record<string, number> = {
      ...host.__tnEngineCost,
      ...host.__tnEngineCounters?.(),
    };
    const previous = last;
    last = totals;
    if (previous === undefined) return undefined;
    const frame: Record<string, number> = {};
    // A name first counted this frame started from zero after the baseline.
    for (const [name, total] of Object.entries(totals)) {
      if (!Number.isFinite(total) || total < 0)
        throw new Error(`TN_DEBUG: invalid ${name} counter.`);
      frame[name] =
        debug && host.__tnDebugSources?.[name]?.unit === "gauge"
          ? total
          : Math.max(0, total - (previous[name] ?? 0));
    }
    return frame;
  };
}

export function createCrossingReader(
  host: { readonly __tnCrossingCount?: () => number } = globalThis as {
    readonly __tnCrossingCount?: () => number;
  },
): () => number | undefined {
  let last: number | undefined;
  return () => {
    if (typeof host.__tnCrossingCount !== "function") return undefined;
    const total = host.__tnCrossingCount();
    if (!Number.isFinite(total)) return undefined;
    const previous = last;
    last = total;
    // The first read of a run is not a frame's worth of crossings: it is everything since boot.
    return previous === undefined ? undefined : Math.max(0, total - previous);
  };
}
