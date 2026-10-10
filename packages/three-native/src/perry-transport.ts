/** Native memory transport for the existing facade. The Wasm transport keeps its original code. */
import {
  bind,
  call,
  free,
  layout,
  alloc as malloc,
  memory,
  physicsCopy,
  readString,
  render,
  stringBytes,
  writeString,
} from "tn-native-transport";
import type { EngineValue, IBrowserRuntime, IEngineRef, TypedArray } from "./browser-backend.js";
import type { ITslRuntime, TslArgValue } from "./browser-tsl.js";

/** All sizes/offsets come from sizeof/offsetof in tn_abi.h, compiled for this target. */
export interface IPerryRuntime extends IBrowserRuntime {
  loadAsset(kind: number, source: string | Uint8Array, type?: number): IEngineRef[];
  render(
    scene: IEngineRef,
    camera: IEngineRef,
    width: number,
    height: number,
    tone: number,
    exposure: number,
    srgb: boolean,
    clear: readonly [number, number, number, number],
  ): void;
}

export function createPerryRuntime(): IPerryRuntime {
  const pointerBytes = layout(0);
  const handleSize = layout(1);
  const valueSize = layout(2);
  const diagnosticSize = layout(3);
  const textAt = layout(4);
  const countAt = layout(5);
  const numbersAt = layout(6);
  const tslSize = layout(7);
  if (
    (pointerBytes !== 4 && pointerBytes !== 8) ||
    handleSize !== 12 ||
    valueSize !== 56 ||
    tslSize !== 64
  )
    throw new Error("TN_PERRY_ABI_LAYOUT: unsupported tn_abi.h layout");
  const read = (at: number, kind = 2) => memory(kind, at);
  const write = (at: number, value: number, kind = 2) => memory(kind + 16, at, value);
  const pointer = (at: number) => read(at, pointerBytes === 8 ? 3 : 2);
  const writePointer = (at: number, value: number) => write(at, value, pointerBytes === 8 ? 3 : 2);
  const allocations: number[] = [];
  const alloc = (size: number) => {
    const at = malloc(Math.max(1, size));
    if (at === 0) throw new Error("TN_PERRY_OUT_OF_MEMORY");
    allocations.push(at);
    return at;
  };
  const scoped = <T>(work: () => T): T => {
    const mark = allocations.length;
    try {
      return work();
    } finally {
      for (const at of allocations.splice(mark)) free(at);
    }
  };
  const string = (text: string) => {
    const bytes = stringBytes(text);
    if (bytes < 0) throw new TypeError("TN_PERRY_STRING: invalid UTF-8 argument");
    const at = alloc(bytes + 1);
    if (writeString(text, at, bytes + 1) !== 0)
      throw new TypeError("TN_PERRY_STRING: conversion failed");
    return { at, bytes };
  };
  const check = (status: number, diag: number, what: string) => {
    if (status === 0) return;
    const message = readString(pointer(diag));
    call(10, diag);
    throw new Error(`TN_ABI_${status}: ${what}${message ? `: ${message}` : ""}`);
  };
  const keyOf = (at: number): IEngineRef => {
    const type = read(at, 1);
    return { type, key: `${type}:${read(at + 2, 1)}:${read(at + 4)}:${read(at + 8)}` };
  };
  const writeHandle = (at: number, ref: IEngineRef) => {
    const fields = ref.key.split(":").map(Number);
    write(at, fields[0] as number, 1);
    write(at + 2, fields[1] as number, 1);
    write(at + 4, fields[2] as number);
    write(at + 8, fields[3] as number);
  };
  const handle = (ref: IEngineRef) => {
    const at = alloc(handleSize);
    writeHandle(at, ref);
    return at;
  };
  const writeNumbers = (at: number, list: ArrayLike<number>, typeName: number) => {
    const data = alloc(list.length * 8);
    for (let i = 0; i < list.length; i++) write(data + i * 8, list[i] as number, 4);
    write(at, 5);
    writePointer(at + textAt, typeName);
    write(at + countAt, list.length, 3);
    writePointer(at + numbersAt, data);
  };
  const writeValue = (at: number, value: EngineValue): void => {
    if (value === null || value === undefined) {
      write(at, value === null ? 0 : 8);
      return;
    }
    if (typeof value === "number") {
      write(at, 1);
      write(at + 8, value, 4);
      return;
    }
    if (typeof value === "boolean") {
      write(at, 2);
      write(at + 4, value ? 1 : 0);
      return;
    }
    if (typeof value === "string") {
      const text = string(value);
      write(at, 3);
      writePointer(at + textAt, text.at);
      write(at + countAt, text.bytes, 3);
      return;
    }
    if ("key" in value && "type" in value) {
      write(at, 4);
      writeHandle(at + 16, value as IEngineRef);
      return;
    }
    if (ArrayBuffer.isView(value)) {
      writeNumbers(at, value, string(value.constructor.name).at);
      return;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
      writeNumbers(at, value as number[], 0);
      return;
    }
    const list = Array.isArray(value) ? value : Object.entries(value).flat();
    const children = values(list as EngineValue[]);
    write(at, Array.isArray(value) ? 6 : 7);
    write(at + countAt, Array.isArray(value) ? list.length : list.length / 2, 3);
    writePointer(at + numbersAt, children);
  };
  const values = (args: readonly EngineValue[]) => {
    const at = alloc(Math.max(valueSize, args.length * valueSize));
    args.forEach((arg, i) => writeValue(at + i * valueSize, arg));
    return at;
  };
  const readNumbers = (at: number, count: number): number[] => {
    const list: number[] = [];
    for (let i = 0; i < count; i++) list.push(read(at + i * 8, 4));
    return list;
  };
  const readValue = (at: number): EngineValue => {
    const kind = read(at);
    if (kind === 8) return undefined;
    if (kind === 1) return read(at + 8, 4);
    if (kind === 2) return read(at + 4) !== 0;
    if (kind === 3) return readString(pointer(at + textAt), read(at + countAt, 3));
    if (kind === 4) return keyOf(at + 16);
    const data = pointer(at + numbersAt);
    const count = read(at + countAt, 3);
    if (kind === 5) return readNumbers(data, count);
    if (kind === 6) return Array.from({ length: count }, (_, i) => readValue(data + i * valueSize));
    if (kind === 7) {
      const record: Record<string, EngineValue> = {};
      for (let i = 0; i < count; i++) {
        const key = readValue(data + i * valueSize * 2);
        if (typeof key !== "string") throw new TypeError("TN_ABI_RECORD_KEY: expected string");
        Object.defineProperty(record, key, {
          value: readValue(data + (i * 2 + 1) * valueSize),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return record;
    }
    return null;
  };
  const context = scoped(() => {
    const version = alloc(32);
    const out = alloc(pointerBytes);
    const diag = alloc(diagnosticSize);
    call(0, version);
    check(call(1, out, version, diag), diag, "tn_context_create");
    return pointer(out);
  });
  const handlers = new Map<number, (args: readonly EngineValue[]) => void>();
  let nextHandler = 1;
  let bound = false;
  const bindCallbacks = () => {
    if (bound) return;
    if (
      bind(
        (id: number, args: number, count: number, packet: number) => {
          const handler = handlers.get(id);
          if (handler === undefined) return 0;
          try {
            handler(Array.from({ length: count }, (_, i) => readValue(args + i * valueSize)));
            return 0;
          } catch (error) {
            writeString(
              error instanceof Error ? error.message : String(error),
              pointer(packet),
              pointer(packet + pointerBytes),
            );
            return 8;
          }
        },
        (id: number) => handlers.delete(id),
      ) !== 0
    )
      throw new Error("TN_PERRY_CALLBACK_CONTEXT: a transport already owns the trampolines");
    bound = true;
  };
  const tsl: ITslRuntime = {
    call: (name, receiver, args) =>
      scoped(() => {
        const at = alloc(Math.max(tslSize, args.length * tslSize));
        args.forEach((arg: TslArgValue, i) => {
          const base = at + i * tslSize;
          const kinds = {
            node: 0,
            number: 1,
            string: 2,
            named: 3,
            rgb: 4,
            vector: 5,
            other: 6,
            handle: 7,
          };
          write(base, kinds[arg.kind]);
          if (arg.kind === "node") write(base + 8, arg.node, 3);
          else if (arg.kind === "number") write(base + 16, arg.number, 4);
          else if (arg.kind === "string" || arg.kind === "named")
            writePointer(base + 24, string(arg.text).at);
          else if (arg.kind === "handle") writeHandle(base + 4, arg.ref);
          else if (arg.kind === "rgb" || arg.kind === "vector") {
            write(base + 4, arg.numbers.length);
            arg.numbers.forEach((number, lane) => write(base + 32 + lane * 8, number, 4));
          }
        });
        const self = receiver === null ? 0 : alloc(8);
        if (self !== 0) write(self, receiver as number, 3);
        const out = alloc(8);
        const diag = alloc(diagnosticSize);
        check(
          call(11, context, string(name).at, self, at, args.length, out, diag),
          diag,
          `TSL ${name}`,
        );
        return read(out, 3);
      }),
    release: (node) =>
      scoped(() => {
        const diag = alloc(diagnosticSize);
        call(12, context, node, diag);
        call(10, diag);
      }),
    set: (material, path, node) =>
      scoped(() => {
        const diag = alloc(diagnosticSize);
        check(
          call(13, context, handle(material), string(path).at, node, diag),
          diag,
          `set ${path}`,
        );
      }),
    setUniform: (node, lanes) =>
      scoped(() => {
        const self = alloc(8);
        write(self, node, 3);
        const data = alloc(lanes.length * 8);
        lanes.forEach((value, i) => write(data + i * 8, value, 4));
        const diag = alloc(diagnosticSize);
        check(call(14, context, self, data, lanes.length, diag), diag, "uniform.value");
      }),
    effectParameter: (node, name, value) =>
      scoped(() => {
        const self = alloc(8);
        write(self, node, 3);
        const input = value === undefined ? 0 : alloc(8);
        if (value !== undefined) write(input, value, 4);
        const out = alloc(8);
        const diag = alloc(diagnosticSize);
        check(call(15, context, self, string(name).at, input, out, diag), diag, `effect ${name}`);
        return read(out, 4);
      }),
    setPost: () => {
      throw new Error("TN_PERRY_POST: desktop post transport is not bound");
    },
  };
  const scalars = [
    Float32Array,
    Float64Array,
    Int8Array,
    Uint8Array,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
  ];
  const scalarKinds = [5, 4, 6, 0, 7, 1, 8, 2];
  const scalarBytes = [4, 8, 1, 1, 2, 2, 4, 4];
  const attribute = <T>(
    ref: IEngineRef,
    use: (at: number, count: number, scalar: number) => T,
  ): T =>
    scoped(() => {
      const out = alloc(24);
      const lease = call(17, handle(ref), out);
      if (lease === 0) throw new TypeError("TN_NATIVE_UNSUPPORTED array: not an attribute");
      try {
        return use(read(out, 3), read(out + 8, 3), read(out + 16, 3));
      } finally {
        call(18, lease);
      }
    });
  return {
    tsl,
    loadAsset: (kind, source, type = 1016) =>
      scoped(() => {
        const output = alloc(pointerBytes + 4);
        let input: number;
        if (typeof source === "string") {
          if (!source || source.includes("\0")) throw new TypeError("TN_PERRY_ASSET_PATH");
          input = string(source).at;
        } else {
          input = alloc(source.byteLength);
          if (physicsCopy(source, input, source.byteLength, 1, true))
            throw new TypeError("TN_PERRY_ASSET_COPY: invalid encoded bytes");
        }
        const error = readString(
          call(
            typeof source === "string" ? 19 : 20,
            context,
            kind,
            input,
            typeof source === "string" ? 0 : source.byteLength,
            output,
            type,
          ),
        );
        if (error) throw new Error(error);
        const handles = pointer(output);
        const count = read(output + pointerBytes);
        try {
          return Array.from({ length: count }, (_, i) => keyOf(handles + i * handleSize));
        } finally {
          free(handles);
        }
      }),
    render: (scene, camera, width, height, tone, exposure, srgb, clear) =>
      scoped(() => {
        const color = alloc(32);
        clear.forEach((value, i) => write(color + i * 8, value, 4));
        const error = readString(
          render(handle(scene), handle(camera), width, height, tone, exposure, srgb ? 1 : 0, color),
        );
        if (error) throw new Error(error);
      }),
    typeId: (name) => scoped(() => call(2, string(name).at)),
    construct: (name, args) =>
      scoped(() => {
        const out = alloc(handleSize);
        const diag = alloc(diagnosticSize);
        check(
          call(5, context, string(name).at, values(args), args.length, out, diag),
          diag,
          `new ${name}`,
        );
        return keyOf(out);
      }),
    invoke: (self, name, args) =>
      scoped(() => {
        const out = alloc(valueSize);
        const diag = alloc(diagnosticSize);
        check(
          call(6, handle(self), string(name).at, values(args), args.length, out, diag),
          diag,
          `${name}()`,
        );
        return readValue(out);
      }),
    get: (self, name) =>
      scoped(() => {
        const out = alloc(valueSize);
        const diag = alloc(diagnosticSize);
        check(call(7, handle(self), string(name).at, out, diag), diag, `get ${name}`);
        return readValue(out);
      }),
    set: (self, name, value) =>
      scoped(() => {
        const diag = alloc(diagnosticSize);
        check(call(8, handle(self), string(name).at, values([value]), diag), diag, `set ${name}`);
      }),
    release: (self) =>
      scoped(() => {
        const diag = alloc(diagnosticSize);
        call(3, handle(self), diag);
        call(10, diag);
      }),
    engineReferences: (refs) =>
      scoped(() => {
        const handles = alloc(refs.length * handleSize);
        refs.forEach((ref, i) => writeHandle(handles + i * handleSize, ref));
        const out = alloc(refs.length * 4);
        call(4, handles, refs.length, out);
        return refs.map((_, i) => read(out + i * 4));
      }),
    readByte: (at) => read(at, 0),
    writeDouble: (at, value) => {
      write(at, value, 4);
    },
    readDoubles: (at, count) => (count === 1 ? read(at, 4) : readNumbers(at, count)),
    attributeArray: (self) =>
      attribute(self, (at, count, scalar) => {
        const Typed = scalars[scalar];
        if (Typed === undefined)
          throw new TypeError(`TN_NATIVE_UNSUPPORTED array: scalar ${scalar}`);
        const result = new Typed(count);
        for (let i = 0; i < count; i++)
          result[i] = read(at + i * (scalarBytes[scalar] as number), scalarKinds[scalar]);
        return result;
      }),
    attributeWrite: (self, array: TypedArray) =>
      attribute(self, (at, count, scalar) => {
        if (array.length !== count)
          throw new RangeError("TN_NATIVE_ATTRIBUTE_LENGTH: attribute.array length differs");
        if (scalarKinds[scalar] === undefined)
          throw new TypeError(`TN_NATIVE_UNSUPPORTED array: scalar ${scalar}`);
        for (let i = 0; i < count; i++)
          write(at + i * (scalarBytes[scalar] as number), array[i] as number, scalarKinds[scalar]);
      }),
    setCallback: (self, name, handler) =>
      scoped(() => {
        const diag = alloc(diagnosticSize);
        if (handler === null) {
          check(call(9, handle(self), string(name).at, 0, 0, 0, diag), diag, `clear ${name}`);
          return;
        }
        bindCallbacks();
        const id = nextHandler++;
        handlers.set(id, handler);
        const status = call(9, handle(self), string(name).at, 1, id, 0, diag);
        if (status !== 0) handlers.delete(id);
        check(status, diag, `set ${name}`);
      }),
  };
}
