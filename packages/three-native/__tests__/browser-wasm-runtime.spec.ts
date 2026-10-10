// createWasmRuntime against a fake ABI module: the scratch, handle and value paths every engine call
// crosses, without the real Wasm build.
import { describe, expect, it } from "vitest";
import { type IEngineRef, type TnAbiModule, createWasmRuntime } from "../src/browser-backend.js";

const VALUE = 56;
const KIND = { number: 1, handle: 4, numbers: 5, array: 6 };

function fakeModule() {
  let memory = new ArrayBuffer(1 << 20);
  let top = 1024;
  const freed: number[] = [];
  const dirty: string[] = []; // scratch handed to the engine that did not read as zero
  let result: (out: number) => void = () => {};
  let grow = false;
  const module = {
    HEAPU8: new Uint8Array(memory),
    HEAPF64: new Float64Array(memory),
    _malloc: (size: number) => {
      const pointer = top;
      top += (size + 7) & ~7;
      return pointer;
    },
    _free: (pointer: number) => void freed.push(pointer),
    lengthBytesUTF8: (text: string) => new TextEncoder().encode(text).length,
    stringToUTF8: (text: string, pointer: number) => {
      const bytes = new TextEncoder().encode(text);
      module.HEAPU8.set(bytes, pointer);
      module.HEAPU8[pointer + bytes.length] = 0;
    },
    UTF8ToString: (pointer: number, max?: number) => {
      let end = pointer;
      while (module.HEAPU8[end] !== 0 && (max === undefined || end < pointer + max)) end++;
      return new TextDecoder().decode(module.HEAPU8.subarray(pointer, end));
    },
    addFunction: () => 1,
    _tn_engine_version: () => 0,
    _tn_context_create: (out: number) => {
      new DataView(memory).setUint32(out, 1, true);
      return 0;
    },
    _tn_type_id: () => 1,
    _tn_object_release: () => 0,
    _tn_object_engine_references: () => 0,
    _tn_set_callback: () => 0,
    _tn_diagnostic_release: () => 0,
    _tn_construct: () => 0,
    _tn_invoke: (
      handle: number,
      _name: number,
      args: number,
      count: number,
      out: number,
      diag: number,
    ) => {
      const zero = (at: number, size: number, what: string) => {
        if (module.HEAPU8.subarray(at, at + size).some((byte) => byte !== 0)) dirty.push(what);
      };
      zero(out, VALUE, "out");
      zero(diag, 8, "diagnostic");
      const v = new DataView(memory);
      calls.push({
        handle: [
          v.getUint16(handle, true),
          v.getUint16(handle + 2, true),
          v.getUint32(handle + 4, true),
          v.getUint32(handle + 8, true),
        ],
        args: Array.from({ length: count }, (_, i) => v.getUint32(args + i * VALUE, true)),
      });
      if (grow) {
        // Memory growth mid-call: Emscripten swaps the heap views for ones over a new buffer.
        const bigger = new ArrayBuffer(memory.byteLength * 2);
        new Uint8Array(bigger).set(new Uint8Array(memory));
        memory = bigger;
        module.HEAPU8 = new Uint8Array(memory);
        module.HEAPF64 = new Float64Array(memory);
      }
      result(out);
      return 0;
    },
    _tn_get: () => 0,
    _tn_set: () => 0,
  };
  const calls: { handle: number[]; args: number[] }[] = [];
  return {
    module,
    calls,
    freed,
    dirty,
    view: () => new DataView(memory),
    returns: (write: (out: number) => void) => {
      result = write;
    },
    growNextCall: () => {
      grow = true;
    },
  };
}

const ref: IEngineRef = { key: "7:1:42:3", type: 7 };

describe("createWasmRuntime", () => {
  it("hands the engine zeroed scratch on every call, after earlier calls wrote into it", () => {
    const fake = fakeModule();
    const runtime = createWasmRuntime(fake.module as unknown as TnAbiModule);
    runtime.invoke(ref, "setStyle", ["a string that fills the scratch with bytes", 1, true]);
    runtime.invoke(ref, "copy", [ref, new Float32Array([1, 2, 3]), [4, 5]]);
    runtime.invoke(ref, "update", []);
    expect(fake.dirty).toEqual([]);
    expect(fake.calls.map((call) => call.handle)).toEqual([
      [7, 1, 42, 3],
      [7, 1, 42, 3],
      [7, 1, 42, 3],
    ]);
    expect(fake.calls[1]?.args).toEqual([KIND.handle, KIND.numbers, KIND.numbers]);
  });

  it("sends a list as numbers only when every element is a number", () => {
    const fake = fakeModule();
    const runtime = createWasmRuntime(fake.module as unknown as TnAbiModule);
    runtime.invoke(ref, "set", [[1, 2], [], [1, "a"], [ref, 2]]);
    expect(fake.calls[0]?.args).toEqual([KIND.numbers, KIND.numbers, KIND.array, KIND.array]);
  });

  it("writes every handle field of a ref it has not seen before, up to 32-bit values", () => {
    const fake = fakeModule();
    const runtime = createWasmRuntime(fake.module as unknown as TnAbiModule);
    runtime.invoke({ key: "12:3:70000:4294967295", type: 12 }, "update", []);
    runtime.invoke({ key: "65535:65535:0:0", type: 65535 }, "update", []);
    expect(fake.calls.map((call) => call.handle)).toEqual([
      [12, 3, 70000, 4294967295],
      [65535, 65535, 0, 0],
    ]);
  });

  it("clears scratch once per call, not once per block", () => {
    const fake = fakeModule();
    const runtime = createWasmRuntime(fake.module as unknown as TnAbiModule);
    let fills = 0;
    const heap = fake.module.HEAPU8;
    const fill = heap.fill.bind(heap);
    heap.fill = ((...args: Parameters<typeof fill>) => {
      fills++;
      return fill(...args);
    }) as typeof heap.fill;
    runtime.invoke(ref, "setRGB", [0.1, 0.2, 0.3]);
    expect(fills).toBeLessThanOrEqual(1);
  });

  it("copies a list larger than the scratch through malloc and frees it after the call", () => {
    const fake = fakeModule();
    const runtime = createWasmRuntime(fake.module as unknown as TnAbiModule);
    const big = Float32Array.from({ length: 20_000 }, (_, i) => i / 4);
    let seen: number[] = [];
    fake.returns(() => {});
    const invoke = fake.module._tn_invoke;
    fake.module._tn_invoke = (handle, name, args, count, out, diag) => {
      const v = fake.view();
      const at = v.getUint32(args + 48, true) / 8;
      seen = Array.from(
        fake.module.HEAPF64.subarray(at, at + Number(v.getBigUint64(args + 40, true))),
      );
      return invoke(handle, name, args, count, out, diag);
    };
    runtime.invoke(ref, "set", [big]);
    expect(seen).toEqual(Array.from(big));
    expect(fake.freed).toHaveLength(1);
  });

  it("reads a numbers result as a plain array, and reads it after the heap grew during the call", () => {
    const fake = fakeModule();
    const runtime = createWasmRuntime(fake.module as unknown as TnAbiModule);
    fake.growNextCall();
    fake.returns((out) => {
      const list = fake.module._malloc(3 * 8);
      fake.module.HEAPF64.set([1.5, -2, 3e9], list / 8);
      const v = fake.view();
      v.setUint32(out, KIND.numbers, true);
      v.setUint32(out + 48, list, true);
      v.setBigUint64(out + 40, 3n, true);
    });
    const value = runtime.invoke(ref, "toArray", []);
    expect(value).toEqual([1.5, -2, 3e9]);
    expect(Array.isArray(value)).toBe(true);
    fake.returns((out) => {
      const v = fake.view();
      v.setUint32(out, KIND.number, true);
      v.setFloat64(out + 8, 0.25, true);
    });
    expect(runtime.invoke(ref, "length", [])).toBe(0.25);
  });
});
