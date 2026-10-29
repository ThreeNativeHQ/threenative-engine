/**
 * What crosses the bridge, and what the engine sees. A transform write is a store into the Wasm
 * memory the engine owns, so N writes cost no crossing, and the engine reads the new value in the same
 * frame. The memory can grow between two writes (the engine allocates), which replaces every typed
 * view of it: a write after growth must land in the new memory, and a handle sent to the engine must
 * be read from it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
} from "../src/browser-backend.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const registry = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "packages", "three-native", "api", "native-registry.json"),
    "utf8",
  ),
) as IRegistryDump;

/** Engine memory is one Float64Array; an object's position lanes sit at its `__address`. */
function memoryRuntime() {
  const heap = new Float64Array(1024);
  const calls: string[] = [];
  let next = 0;
  const addresses = new Map<string, number>();
  const types = new Map<string, number>();
  const typeId = (name: string) =>
    types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
  const construct = (name: string): IEngineRef => {
    const key = `${name}:${next}`;
    addresses.set(key, next * 256);
    next += 1;
    return { key, type: typeId(name) };
  };
  const runtime: IBrowserRuntime = {
    typeId,
    construct(name) {
      calls.push(`construct ${name}`);
      return construct(name);
    },
    invoke(_self, method) {
      calls.push(`invoke ${method}`);
      return null;
    },
    get(self, property) {
      if (property === "__address") return addresses.get(self.key) as number;
      calls.push(`get ${property}`);
      if (
        property === "position" ||
        property === "scale" ||
        property === "quaternion" ||
        property === "rotation"
      ) {
        const ref = construct(
          property === "quaternion" ? "Quaternion" : property === "rotation" ? "Euler" : "Vector3",
        );
        // The member's lanes follow its owner's, as the transform page lays them out.
        addresses.set(
          ref.key,
          (addresses.get(self.key) as number) +
            (property === "scale"
              ? 64
              : property === "quaternion"
                ? 128
                : property === "rotation"
                  ? 160
                  : 0),
        );
        return ref;
      }
      throw new Error(`unexpected get ${property}`);
    },
    set(_self, property) {
      calls.push(`set ${property}`);
    },
    release: () => undefined,
    setCallback: () => undefined,
    readDoubles: (address, count) =>
      count === 1
        ? (heap[address / 8] as number)
        : [...heap.subarray(address / 8, address / 8 + count)],
    writeDouble(address, value) {
      heap[address / 8] = value;
    },
    readByte: () => 0,
  };
  return { runtime, calls, heap, addresses };
}

describe("transform writes on the browser back end", () => {
  it("cross no call however many there are, and the engine's memory holds each at once", () => {
    const { runtime, calls, heap, addresses } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Object3D = classes.Object3D as new () => {
      position: { x: number; set(x: number, y: number, z: number): unknown };
      scale: { set(x: number, y: number, z: number): unknown };
    };
    const object = new Object3D();
    const { position, scale } = object;
    const base = addresses.get(engineKey(object)) as number;
    const crossingsBefore = calls.filter((call) => /^(set|invoke) /u.test(call)).length;
    for (let write = 0; write < 300; write += 1) {
      position.set(write, write + 1, write + 2);
      position.x = write + 0.5;
      scale.set(2, 3, 4);
      // The engine reads its own memory: the value is there before the next statement.
      expect(heap[base / 8]).toBe(write + 0.5);
      expect(heap[base / 8 + 1]).toBe(write + 1);
    }
    expect(heap[(base + 64) / 8 + 2]).toBe(4);
    expect(calls.filter((call) => /^(set|invoke) /u.test(call))).toHaveLength(crossingsBefore);
  });
});

function engineKey(object: object): string {
  const ref = (object as Record<symbol, IEngineRef>)[
    Object.getOwnPropertySymbols(object)[0] as symbol
  ];
  return (ref as IEngineRef).key;
}

/** A module whose memory can grow: every view is replaced, as Emscripten does after `memory.grow`. */
function growableModule() {
  const module = {
    HEAPU8: new Uint8Array(1 << 20),
    HEAPF64: new Float64Array(0),
    handlesSeen: [] as number[][],
    mallocs: [] as Array<{ pointer: number; size: number }>,
    frees: [] as number[],
  } as unknown as TnAbiModule & {
    handlesSeen: number[][];
    mallocs: Array<{ pointer: number; size: number }>;
    frees: number[];
  };
  module.HEAPF64 = new Float64Array(module.HEAPU8.buffer);
  const grow = () => {
    const bigger = new Uint8Array(2 << 20);
    bigger.set(module.HEAPU8);
    module.HEAPU8 = bigger;
    module.HEAPF64 = new Float64Array(bigger.buffer);
  };
  let top = 1 << 12;
  const abi = module as unknown as Record<string, unknown>;
  abi._malloc = (size: number) => {
    const pointer = top;
    top += (size + 7) & ~7;
    module.mallocs.push({ pointer, size });
    return pointer;
  };
  abi._free = (pointer: number) => {
    module.frees.push(pointer);
    return 0;
  };
  abi._tn_engine_version = () => 0;
  abi._tn_context_create = () => 0;
  abi._tn_diagnostic_release = () => 0;
  // A get whose result is known: writes the number kind and its value into the output slot.
  abi._tn_get = (_handle: number, _name: number, out: number) => {
    const v = new DataView(module.HEAPU8.buffer);
    v.setUint32(out, 1, true);
    v.setFloat64(out + 8, 42, true);
    return 0;
  };
  abi._tn_invoke = (_handle: number, _name: number, _args: number, _count: number, out: number) => {
    new DataView(module.HEAPU8.buffer).setUint32(out, 8, true);
    return 0;
  };
  abi.lengthBytesUTF8 = (text: string) => text.length;
  abi.stringToUTF8 = () => undefined;
  abi.addFunction = () => 1;
  // The engine side of engineReferences: reads each handle's three words from the memory it sees now.
  abi._tn_object_engine_references = (handles: number, count: number, out: number) => {
    const words = new Uint32Array(module.HEAPU8.buffer, handles, count * 3);
    module.handlesSeen.push([...words]);
    const counts = new Uint32Array(module.HEAPU8.buffer, out, count);
    for (let i = 0; i < count; i += 1) counts[i] = 1;
    return 0;
  };
  return { module, grow };
}

describe("Wasm memory growth under the bridge", () => {
  it("lands a transform write in the memory as it is after the engine grew it", () => {
    const { module, grow } = growableModule();
    const runtime = createWasmRuntime(module);
    runtime.writeDouble?.(800, 1.5);
    grow();
    runtime.writeDouble?.(808, 2.5);
    expect(module.HEAPF64[100]).toBe(1.5);
    expect(module.HEAPF64[101]).toBe(2.5);
    expect(runtime.readDoubles?.(800, 2)).toEqual([1.5, 2.5]);
  });

  it("sends a handle from the memory after growth, three stores and no parse", () => {
    const { module, grow } = growableModule();
    const runtime = createWasmRuntime(module);
    const ref = { key: "5:2:7:9", type: 5 };
    runtime.engineReferences?.([ref]);
    grow();
    runtime.engineReferences?.([ref, { key: "6:0:1:2", type: 6 }]);
    expect(module.handlesSeen).toEqual([
      [5 | (2 << 16), 7, 9],
      [5 | (2 << 16), 7, 9, 6, 1, 2],
    ]);
  });
});

describe("scope cleanup on the Wasm bridge", () => {
  const ref: IEngineRef = { key: "5:2:7:9", type: 5 };

  it("allocates no empty cleanup array on an ordinary get", () => {
    const { module } = growableModule();
    const runtime = createWasmRuntime(module);
    const results: unknown[] = [];
    const splice = Array.prototype.splice;
    let empty = 0;
    Array.prototype.splice = function (this: unknown[], ...args: unknown[]) {
      if (this.length === 0 && args.length === 1) empty += 1;
      return Reflect.apply(splice, this, args) as unknown[];
    } as typeof Array.prototype.splice;
    try {
      for (let call = 0; call < 100; call += 1) results.push(runtime.get(ref, "value"));
    } finally {
      Array.prototype.splice = splice;
    }
    expect(results).toEqual(Array.from({ length: 100 }, () => 42));
    expect(empty).toBe(0);
  });

  it("frees an overflow allocation exactly once", () => {
    const { module } = growableModule();
    const runtime = createWasmRuntime(module);
    runtime.invoke(ref, "overflow", [new Float64Array(9000)]);
    const fallbacks = module.mallocs.filter((entry) => entry.size > 64 * 1024);
    expect(fallbacks).toHaveLength(1);
    expect(module.frees.filter((pointer) => pointer === fallbacks[0]?.pointer)).toHaveLength(1);
  });

  it("frees an outer overflow allocation only after a nested call returns", () => {
    const { module } = growableModule();
    const runtime = createWasmRuntime(module);
    let freesWhenNested = -1;
    const abi = module as unknown as Record<string, unknown>;
    abi._tn_invoke = (
      _handle: number,
      _name: number,
      _args: number,
      _count: number,
      out: number,
    ) => {
      runtime.get(ref, "value");
      freesWhenNested = module.frees.length;
      new DataView(module.HEAPU8.buffer).setUint32(out, 8, true);
      return 0;
    };
    runtime.invoke(ref, "overflow", [new Float64Array(9000)]);
    const overflow = module.mallocs.find((entry) => entry.size > 64 * 1024);
    expect(freesWhenNested).toBe(0);
    expect(module.frees.filter((pointer) => pointer === overflow?.pointer)).toHaveLength(1);
  });

  it("rewinds the arena when a scoped call throws", () => {
    const { module } = growableModule();
    const runtime = createWasmRuntime(module);
    const abi = module as unknown as Record<string, unknown>;
    let fail = true;
    abi._tn_invoke = (
      _handle: number,
      _name: number,
      _args: number,
      _count: number,
      out: number,
      diag: number,
    ) => {
      const v = new DataView(module.HEAPU8.buffer);
      if (fail) {
        fail = false;
        v.setUint32(diag, 0, true);
        return 1;
      }
      v.setUint32(out, 8, true);
      return 0;
    };
    // 8000 doubles fill the arena without overflowing it, so a rewound arena fits the retry.
    const value = new Float64Array(8000);
    expect(() => runtime.invoke(ref, "fill", [value])).toThrow(/TN_ABI_1/u);
    const mallocs = module.mallocs.length;
    runtime.invoke(ref, "fill", [value]);
    expect(module.mallocs.length).toBe(mallocs);
    expect(module.frees).toHaveLength(0);
  });
});

describe("per-crossing glue on the Wasm bridge", () => {
  /** A module whose invoke answers the handle in `answer` (type|context, index, generation). */
  function answering(answer: number[]) {
    const { module, grow } = growableModule();
    const scratch: number[][] = [];
    (module as unknown as Record<string, unknown>)._tn_invoke = (
      _handle: number,
      _name: number,
      _args: number,
      _count: number,
      out: number,
      diag: number,
    ) => {
      const words = new Uint32Array(module.HEAPU8.buffer);
      // What the engine finds in its output and diagnostic slots before it writes them.
      scratch.push([
        ...words.subarray(out >>> 2, (out + 56) >>> 2),
        words[diag >>> 2] ?? -1,
        words[(diag >>> 2) + 1] ?? -1,
      ]);
      const v = new DataView(module.HEAPU8.buffer);
      v.setUint32(out, 4, true); // KIND.handle
      v.setUint32(out + 16, answer[0] ?? 0, true);
      v.setUint32(out + 20, answer[1] ?? 0, true);
      v.setUint32(out + 24, answer[2] ?? 0, true);
      // Junk the next call must not see.
      v.setUint32(out + 40, 0xdeadbeef, true);
      v.setUint32(diag, 0xdeadbeef, true);
      return 0;
    };
    return { module, grow, scratch, runtime: createWasmRuntime(module) };
  }
  const self: IEngineRef = { key: "5:0:1:1", type: 5 };

  it("hands every call zeroed output and diagnostic slots, before and after the memory grows", () => {
    const { runtime, grow, scratch } = answering([5, 7, 9]);
    runtime.invoke(self, "updateMatrixWorld", []);
    runtime.invoke(self, "updateMatrixWorld", []);
    grow();
    runtime.invoke(self, "updateMatrixWorld", []);
    expect(scratch).toHaveLength(3);
    for (const seen of scratch) expect(seen.every((word) => word === 0)).toBe(true);
  });

  // The glue a crossing pays, counted: `view()` used to read two `.buffer`s per use (3 uses here) and
  // `alloc` filled its scratch through `HEAPU8.fill`, 466 ns a crossing against 340 with the kept views
  // and the word-store zeroing (PERFORMANCE-LEARNINGS 2026-10-27, bridge glue). Both counts are zero
  // again the moment the views are rebuilt per use, so undoing the lever reds this test.
  it("reads the heap's buffer once a crossing, and zeroes its scratch without a fill", () => {
    const { module } = growableModule();
    let bufferReads = 0;
    let fills = 0;
    const counted = (heap: Uint8Array) =>
      new Proxy(heap, {
        get(target, property) {
          if (property === "buffer") bufferReads += 1;
          if (property === "fill") fills += 1;
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? (value as () => unknown).bind(target) : value;
        },
      });
    module.HEAPU8 = counted(module.HEAPU8) as Uint8Array;
    const runtime = createWasmRuntime(module);
    // The fixture's own `_tn_invoke` answers through one DataView of the heap, per crossing.
    runtime.invoke(self, "updateMatrixWorld", []);
    const readsBefore = bufferReads;
    const fillsBefore = fills;
    for (let crossing = 0; crossing < 50; crossing += 1)
      runtime.invoke(self, "updateMatrixWorld", []);
    expect((bufferReads - readsBefore) / 50).toBeLessThanOrEqual(1);
    expect(fills - fillsBefore).toBe(0);
  });
});

describe("debug bridge ABI observations", () => {
  it("preserves actual off malloc/free/crossing census and reports Uint8 fog widening on", () => {
    function run(enabled: boolean) {
      vi.stubEnv("TN_DEBUG", enabled ? "1" : "0");
      vi.stubGlobal("__THREENATIVE_DEBUG__", false);
      vi.stubGlobal("location", { search: "" });
      const { module, grow } = growableModule();
      const sets = vi.fn(() => 0);
      module._tn_set = sets;
      const runtime = createWasmRuntime(module);
      const ref = { key: "1:0:1:1", type: 1 };
      runtime.set(ref, "image.data", new Uint8Array(112 * 112 * 4));
      const before = module.mallocs.length;
      for (let i = 0; i < 995; i++) runtime.get(ref, "count");
      expect(module.mallocs.length).toBe(before + 1); // one interned property name
      grow();
      runtime.get(ref, "count");
      return {
        mallocs: module.mallocs,
        frees: module.frees,
        crossings: sets.mock.calls.length,
        debug: runtime.debugTelemetry,
      };
    }
    const off = run(false);
    expect(off.debug).toBeUndefined();
    const on = run(true);
    expect(on.mallocs).toEqual(off.mallocs);
    expect(on.frees).toEqual(off.frees);
    expect(on.crossings).toBe(off.crossings);
    expect(on.debug?.totals).toMatchObject({
      bridgeTypedSourceBytes: 50176,
      bridgeTypedEncodedBytes: 401408,
      bridgeOverflowAllocations: 1,
      bridgeOverflowBytes: 401408,
      wasmGrowthEvents: 1,
      wasmGrowthBytes: 1048576,
    });
    expect(on.debug?.totals.bridgeScratchBytes).toBeGreaterThan(401408);
    expect(on.debug?.totals["bridge:widen image.data"]).toBe(401408);
  });

  it("routes bridge totals through the existing browser engine counter reader", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {});
    const { runtime } = memoryRuntime();
    const get = runtime.get;
    runtime.get = (self, path) => (path === "name" ? "" : get(self, path));
    const engine = defineBrowserClasses(registry, runtime);
    const Object3D = engine.classes.Object3D as new () => { count: number };
    new Object3D();
    const counters = engine.counters();
    expect(counters.bridgeConstructCrossings).toBe(1);
    expect(counters.bridgeWrappersCreated).toBe(1);
    expect(counters.bridgeLiveWrappers).toBe(1);
    expect(
      (globalThis as { __tnDebugSources?: Record<string, { unit: string }> }).__tnDebugSources
        ?.bridgeLiveWrappers?.unit,
    ).toBe("gauge");
    expect(counters.bridgeCrossingMs).toBeGreaterThanOrEqual(0);
    expect(
      (globalThis as { __tnDebugSources?: Record<string, { unit: string }> }).__tnDebugSources
        ?.bridgeCrossingMs?.unit,
    ).toContain("estimated");
  });
});

describe("shared transform write telemetry", () => {
  it("observes repeated same-value position and quaternion writes without changing their values or crossings", () => {
    function run(enabled: boolean) {
      vi.stubEnv("TN_DEBUG", enabled ? "1" : "0");
      const { runtime, calls, heap, addresses } = memoryRuntime();
      const get = runtime.get;
      runtime.get = (self, property) => (property === "name" ? "" : get(self, property));
      const browser = defineBrowserClasses(registry, runtime);
      const Object3D = browser.classes.Object3D as new () => {
        position: { set(x: number, y: number, z: number): void };
        quaternion: { set(x: number, y: number, z: number, w: number): void };
      };
      const object = new Object3D();
      const { position, quaternion } = object;
      const start = calls.length;
      const now = vi.spyOn(performance, "now");
      position.set(5, 6, 7);
      position.set(5, 6, 7);
      quaternion.set(1, 2, 3, 4);
      quaternion.set(1, 2, 3, 4);
      expect(now).not.toHaveBeenCalled();
      now.mockRestore();
      const writes = calls.slice(start);
      const base = addresses.get(engineKey(object)) ?? 0;
      const values = [
        ...heap.subarray(base / 8, base / 8 + 3),
        ...heap.subarray((base + 128) / 8, (base + 128) / 8 + 4),
      ];
      return { values, writes, counters: browser.counters() };
    }
    const off = run(false);
    const on = run(true);
    expect(off.values).toEqual([5, 6, 7, 1, 2, 3, 4]);
    expect(on.values).toEqual(off.values);
    expect(on.writes).toEqual(off.writes);
    expect(off.counters).not.toHaveProperty("sharedTransformWrites");
    expect(on.counters).toMatchObject({
      sharedTransformWrites: 14,
      unchangedSharedTransformWrites: 7,
    });
  });
});
