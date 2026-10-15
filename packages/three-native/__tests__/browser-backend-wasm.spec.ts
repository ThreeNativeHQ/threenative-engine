import { describe, expect, it, vi } from "vitest";

import {
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
} from "../src/browser-backend.js";

function fakeWasm() {
  const memory = new WebAssembly.Memory({ initial: 1 });
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const functions: ((...args: number[]) => number | undefined)[] = [];
  let next = 8;
  const abi: TnAbiModule = {
    HEAPU8: new Uint8Array(memory.buffer),
    HEAPF64: new Float64Array(memory.buffer),
    _malloc: vi.fn((size: number) => {
      const pointer = next;
      next += Math.ceil(size / 8) * 8;
      if (next > memory.buffer.byteLength) {
        memory.grow(Math.ceil((next - memory.buffer.byteLength) / 65536));
        abi.HEAPU8 = new Uint8Array(memory.buffer);
        abi.HEAPF64 = new Float64Array(memory.buffer);
      }
      return pointer;
    }),
    _free: vi.fn(() => 0),
    lengthBytesUTF8: (text) => encoder.encode(text).length,
    stringToUTF8: (text, pointer, capacity) => {
      if (capacity === 0) return;
      const bytes = encoder.encode(text).subarray(0, capacity - 1);
      abi.HEAPU8.set(bytes, pointer);
      abi.HEAPU8[pointer + bytes.length] = 0;
    },
    UTF8ToString: (pointer, maxBytes) => {
      const end = maxBytes === undefined ? abi.HEAPU8.indexOf(0, pointer) : pointer + maxBytes;
      return decoder.decode(abi.HEAPU8.subarray(pointer, end));
    },
    addFunction: (fn) => functions.push(fn),
    _tn_engine_version: () => 0,
    _tn_context_create: (out) => {
      new DataView(abi.HEAPU8.buffer).setUint32(out, 1, true);
      return 0;
    },
    _tn_type_id: () => 1,
    _tn_construct: (_context, _name, _args, _count, out) => {
      const view = new DataView(abi.HEAPU8.buffer);
      view.setUint16(out, 1, true);
      view.setUint32(out + 4, 1, true);
      view.setUint32(out + 8, 1, true);
      return 0;
    },
    _tn_invoke: () => 0,
    _tn_get: () => 0,
    _tn_set: () => 0,
    _tn_object_release: () => 0,
    _tn_object_engine_references: () => 0,
    _tn_set_callback: () => 0,
    _tn_diagnostic_release: vi.fn(() => 0),
  };
  return { abi, functions };
}

const ref = { key: "1:0:1:1", type: 1 };

describe("the Wasm browser binding scratch arena", () => {
  it.each([8, 10000])(
    "reuses scratch for 100 sequential set/invoke pairs with %i lanes",
    (lanes) => {
      const { abi } = fakeWasm();
      const runtime = createWasmRuntime(abi);
      const payload = Array.from({ length: lanes }, (_, i) => i + 0.5);
      runtime.set(ref, "payload", payload);
      runtime.invoke(ref, "update", [payload]);
      vi.mocked(abi._malloc).mockClear();
      vi.mocked(abi._free).mockClear();

      for (let i = 0; i < 100; i++) {
        payload.push(i);
        runtime.set(ref, "payload", payload);
        runtime.invoke(ref, "update", [payload]);
      }

      expect(abi._free).not.toHaveBeenCalled();
      expect(abi._malloc).not.toHaveBeenCalled();
    },
  );

  it("preserves outer arguments when a callback re-enters and grows Wasm memory", () => {
    const { abi, functions } = fakeWasm();
    const runtime = createWasmRuntime(abi);
    const payload = Array.from({ length: 10000 }, (_, i) => i + 0.25);
    let callback = 0;
    let handler = 0;
    abi._tn_set_callback = (_self, _name, invoke, id) => {
      callback = invoke;
      handler = id;
      return 0;
    };
    runtime.setCallback(ref, "onBeforeRender", () => {
      runtime.invoke(ref, "nested", [payload, "nested"]);
      runtime.set(ref, "payload", payload);
    });
    let callbacks = 0;
    abi._tn_invoke = (_self, method, args, count, out) => {
      if (abi.UTF8ToString(method) !== "outer") return 0;
      const view = new DataView(abi.HEAPU8.buffer);
      const text = view.getUint32(args + 32, true);
      const numbers = view.getUint32(args + 3 * 56 + 48, true);
      expect(numbers % 8).toBe(0);
      const before = abi.HEAPU8.slice(args, args + count * 56);
      const beforeNumbers = abi.HEAPU8.slice(numbers, numbers + payload.length * 8);
      const buffer = abi.HEAPU8.buffer;
      expect(functions[callback - 1]?.(handler, 0, 0, 0, 0)).toBe(0);
      callbacks++;
      expect(abi.HEAPU8.buffer).not.toBe(buffer);
      expect(abi.HEAPU8.slice(args, args + count * 56)).toEqual(before);
      expect(abi.HEAPU8.slice(numbers, numbers + payload.length * 8)).toEqual(beforeNumbers);
      expect(abi.UTF8ToString(text)).toBe("outer café");
      const current = new DataView(abi.HEAPU8.buffer);
      current.setUint32(out, 1, true);
      current.setFloat64(out + 8, 42.5, true);
      return 0;
    };

    expect(runtime.invoke(ref, "outer", ["outer café", 42.5, ref, payload])).toBe(42.5);
    expect(callbacks).toBe(1);
    expect(abi._free).not.toHaveBeenCalled();
  });

  it("rewinds scratch after an error and preserves diagnostic text", () => {
    const { abi } = fakeWasm();
    const runtime = createWasmRuntime(abi);
    const payload = Array.from({ length: 10000 }, () => 1);
    abi._tn_set = (_self, name, _value, diag) => {
      new DataView(abi.HEAPU8.buffer).setUint32(diag, name, true);
      return 7;
    };
    const fail = () => {
      expect(() => runtime.set(ref, "payload", payload)).toThrow("TN_ABI_7: set payload: payload");
    };
    fail();
    const allocations = vi.mocked(abi._malloc).mock.calls.length;
    for (let i = 0; i < 9; i++) fail();
    expect(abi._tn_diagnostic_release).toHaveBeenCalledTimes(10);
    expect(abi._malloc).toHaveBeenCalledTimes(allocations);
    expect(abi._free).not.toHaveBeenCalled();
  });

  it("counts construct, get, set, invoke and engineReferences once each, including errors", () => {
    const { abi } = fakeWasm();
    const engine = defineBrowserClasses(
      {
        classes: {
          Probe: {
            constructor: true,
            methods: ["update"],
            getters: ["payload"],
            setters: ["payload"],
            members: [],
            callbacks: [],
          },
        },
      },
      createWasmRuntime(abi),
    );
    const Probe = engine.classes.Probe as new () => { payload: number; update(): unknown };
    expect(engine.crossings()).toBe(0);
    const probe = new Probe();
    expect(engine.crossings()).toBe(1);
    expect(probe.payload).toBeNull();
    expect(engine.crossings()).toBe(2);
    probe.payload = 1;
    expect(engine.crossings()).toBe(3);
    expect(probe.update()).toBeNull();
    expect(engine.crossings()).toBe(4);
    engine.collect();
    expect(engine.crossings()).toBe(5);
    abi._tn_invoke = () => 7;
    expect(() => probe.update()).toThrow("TN_ABI_7: update()");
    expect(engine.crossings()).toBe(6);
  });
});
