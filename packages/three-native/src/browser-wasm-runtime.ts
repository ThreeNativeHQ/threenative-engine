/**
 * The browser back end's runtime over a loaded ABI module (PRD-532, PRD-803): one engine context,
 * every call checked, and each call's scratch taken from an arena a scope rewinds.
 */
import {
  type EngineValue,
  HANDLE,
  type IAbiHelpers,
  type IBrowserRuntime,
  type IEngineRef,
  type IPackedRef,
  KIND,
  type TnAbiModule,
  VALUE,
  gltfOf,
  isRef,
  packedRef,
  tslOf,
} from "./browser-abi-types.js";
import { SCALARS, TYPED, type TypedArray } from "./browser-marshal.js";
import { debugTelemetry } from "./debug-telemetry.js";

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
  const debug = debugTelemetry(abi);
  let encoding = "arguments";
  // The heap's views, made again only when the memory grows: Emscripten replaces HEAPU8 then, so one
  // identity test per use stands in for reading two `.buffer`s, which every crossing paid (PRD-748).
  let heap = abi.HEAPU8;
  let heapBytes = heap.byteLength;
  let dataView = new DataView(heap.buffer);
  let words = new Uint32Array(heap.buffer);
  const grown = () => {
    debug?.add("wasmGrowthEvents", 1, "bridge");
    debug?.add("wasmGrowthBytes", Math.max(0, abi.HEAPU8.byteLength - heapBytes), "memory");
    heap = abi.HEAPU8;
    heapBytes = heap.byteLength;
    dataView = new DataView(heap.buffer);
    words = new Uint32Array(heap.buffer);
  };
  const view = () => {
    if (abi.HEAPU8 !== heap) grown();
    return dataView;
  };
  const wordView = () => {
    if (abi.HEAPU8 !== heap) grown();
    return words;
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
    debug?.add("bridgeScratchBytes", aligned, "bridge");
    let pointer: number;
    if (arenaTop + aligned <= arenaBase + arenaSize) {
      pointer = arenaTop;
      arenaTop += aligned;
    } else {
      // `>>> 0`: the module addresses up to 4 GB, and an export returns a pointer as a signed i32.
      pointer = abi._malloc(aligned) >>> 0;
      allocations.push(pointer);
      debug?.add("bridgeOverflowAllocations", 1, "bridge");
      debug?.add("bridgeOverflowBytes", aligned, "bridge");
    }
    // A call's scratch is a few words (a handle, a value, a diagnostic): word stores beat a fill call.
    // `wordView` first: a `_malloc` above may have grown the memory.
    const w = wordView();
    if (aligned > 64) heap.fill(0, pointer, pointer + aligned);
    else for (let at = pointer >>> 2, end = (pointer + aligned) >>> 2; at < end; at++) w[at] = 0;
    return pointer;
  };
  const scoped = <T>(work: () => T): T => {
    const mark = allocations.length;
    const top = arenaTop;
    try {
      return work();
    } finally {
      while (allocations.length > mark) abi._free(allocations.pop() as number);
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
    const packed = packedRef(ref);
    if ((pointer & 3) === 0) {
      const at = pointer >>> 2;
      const w = wordView();
      w[at] = packed.w0;
      w[at + 1] = packed.w1;
      w[at + 2] = packed.w2;
      return;
    }
    const v = view();
    v.setUint32(pointer, packed.w0, true);
    v.setUint32(pointer + 4, packed.w1, true);
    v.setUint32(pointer + 8, packed.w2, true);
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
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
      // A forwarded typed array (see `toEngine`): one heap copy, its view bounds kept, no boxed list.
      const typed = value as TypedArray;
      debug?.widen(typed, encoding, typed.byteLength);
      const numbers = alloc(Math.max(8, typed.byteLength));
      abi.HEAPU8.set(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), numbers);
      const name = string(typed.constructor.name).pointer;
      const w = view();
      w.setUint32(pointer, KIND.bytes, true);
      w.setUint32(pointer + 32, name, true);
      w.setUint32(pointer + 48, numbers, true);
      return w.setBigUint64(pointer + 40, BigInt(typed.length), true);
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
    ...(debug === undefined ? {} : { debugTelemetry: debug }),
    typedArrays: true,
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
        if (debug !== undefined) encoding = method;
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
    // PRD-828: the rig batch, one crossing. Handles are three words each; a rig without an action or
    // a stride body repeats its mixer's handle there, and the flags word says which of the two exist.
    animTick: (batch) => {
      const count = batch.mixers.length;
      if (count === 0) return;
      scoped(() => {
        const triples = alloc(count * 3 * HANDLE);
        for (let i = 0; i < count; i += 1) {
          const at = triples + i * 3 * HANDLE;
          const mixer = batch.mixers[i] as IEngineRef;
          writeHandle(at, mixer);
          writeHandle(at + HANDLE, batch.actions[i] ?? mixer);
          writeHandle(at + 2 * HANDLE, batch.roots[i] ?? mixer);
        }
        const values = alloc(count * 5 * 8);
        const status = alloc(count * 3 * 8);
        const v = view();
        for (let i = 0; i < count * 5; i += 1)
          v.setFloat64(values + i * 8, batch.values[i] as number, true);
        const diag = diagnostic();
        check(
          abi._tn_anim_tick(context, triples, values, count, status, diag),
          diag,
          "tn_anim_tick",
        );
        const after = view();
        for (let i = 0; i < count * 3; i += 1)
          batch.status[i] = after.getFloat64(status + i * 8, true);
      });
    },
    readByte: (address) => abi.HEAPU8[address] as number,
    readWord: (address) => view().getUint32(address, true),
    writeDouble: (address, value) => {
      abi.HEAPF64[address / 8] = value;
    },
    writeByte: (address, value) => {
      abi.HEAPU8[address] = value;
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
        if (debug !== undefined) encoding = path;
        // One value written in place: no one-item list per write.
        const pointer = alloc(VALUE);
        writeValue(pointer, value);
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
