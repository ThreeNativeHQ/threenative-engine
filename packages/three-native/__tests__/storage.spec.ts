/**
 * PRD-620 phase 1 and 2 on the Wasm facade: three's storage buffers over engine BufferAttributes, the
 * `.compute()` node method, and the result forms of `getArrayBufferAsync`. The engine behind these
 * calls is proven on the V8 player (tests/native-engine/player-compute.mjs) and in the browser page.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { type ITslRuntime, type TslArgValue, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";
import { ReadbackBuffer, readStorageBytes } from "../src/storage.js";

const REPO = process.cwd();
const catalog = loadCatalog(REPO);
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

interface IStorageBuffer {
  value: { count: number; itemSize: number; needsUpdate: boolean };
  element(index: unknown): object;
  toAtomic(): IStorageBuffer;
}
interface ICall {
  name: string;
  receiver: number | null;
  args: readonly TslArgValue[];
}

/** An engine that keeps each BufferAttribute's array and answers its count and item size. */
function engine() {
  const arrays = new Map<string, Float32Array>();
  const sizes = new Map<string, number>();
  let next = 0;
  const runtime: IBrowserRuntime = {
    typeId: () => 1,
    construct(name, args) {
      const key = `${name}:0:${++next}:1`;
      const array = (args[0] ?? new Float32Array(0)) as unknown as Float32Array;
      arrays.set(key, array);
      sizes.set(key, Number(args[1]));
      return { key, type: 1 };
    },
    invoke: (): EngineValue => null,
    get(self: IEngineRef, property: string): EngineValue {
      const array = arrays.get(self.key);
      if (property === "itemSize") return sizes.get(self.key) ?? 0;
      if (property === "count")
        return array === undefined ? 0 : array.length / (sizes.get(self.key) || 1);
      return 0;
    },
    set() {},
    release() {},
    setCallback() {},
    attributeArray: (self) => arrays.get(self.key) as never,
    attributeWrite: (self, array) => void arrays.set(self.key, array as Float32Array),
  };
  return { runtime, arrays };
}

function tslOver(calls: ICall[], extras: Partial<ITslRuntime> = {}) {
  const { runtime } = engine();
  const { classes } = defineBrowserClasses(registry, runtime, catalog);
  let serial = 0;
  const tslRuntime: ITslRuntime = {
    call: (name, receiver, args) => {
      calls.push({ name, receiver, args });
      return ++serial;
    },
    release: vi.fn(),
    set: vi.fn(),
    setUniform: vi.fn(),
    setPost: vi.fn(),
    effectParameter: vi.fn(),
    compute: vi.fn(),
    readStorage: vi.fn(),
    deleteStorage: vi.fn(),
    ...extras,
  };
  return defineTsl(tslRuntime, classes as never).exports;
}

describe("storage buffers on the Wasm facade", () => {
  it("builds storage over an engine attribute of the type's own array and item size", () => {
    const tsl = tslOver([]);
    const make = tsl.instancedArray as (
      count: number | Float32Array,
      type: string,
    ) => IStorageBuffer;
    expect(make(256, "float").value.count).toBe(256);
    expect(make(256, "float").value.itemSize).toBe(1);
    expect(make(3, "uint").value.itemSize).toBe(1);
    expect(make(2, "vec2").value.itemSize).toBe(2);
    expect(make(2, "vec4").value.itemSize).toBe(4);
    // WGSL strides a vec3 array at 16 bytes, so three pads a packed vec3 array to four lanes.
    const packed = make(new Float32Array([1, 2, 3, 4, 5, 6]), "vec3");
    expect(packed.value.count).toBe(2);
    expect(packed.value.itemSize).toBe(4);
    const attribute = packed.value as unknown as { array: Float32Array };
    expect(Array.from(attribute.array)).toEqual([1, 2, 3, 0, 4, 5, 6, 0]);
    expect(() => make(0, "float")).toThrow(/storage count must be positive/u);
    expect(() => make(4, "mat7")).toThrow(/TN_TSL storage/u);
  });

  it("sends the contents to the engine at construction so no later write-back covers a kernel's result", () => {
    const writes: string[] = [];
    const { runtime } = engine();
    const write = runtime.attributeWrite;
    runtime.attributeWrite = (self, array) => {
      writes.push(self.key);
      write?.call(runtime, self, array);
    };
    const { classes } = defineBrowserClasses(registry, runtime, catalog);
    const tsl = defineTsl(
      {
        call: () => 1,
        release: vi.fn(),
        set: vi.fn(),
        setUniform: vi.fn(),
        setPost: vi.fn(),
        effectParameter: vi.fn(),
        compute: vi.fn(),
        readStorage: vi.fn(),
        deleteStorage: vi.fn(),
      },
      classes as never,
    ).exports;
    const buffer = (tsl.instancedArray as (count: number, type: string) => IStorageBuffer)(
      4,
      "float",
    );
    expect(writes).toHaveLength(1);
    // Any later engine call finds nothing pending: the array is not written over the GPU copy again.
    (buffer.value as unknown as { clone(): unknown }).clone();
    expect(writes).toHaveLength(1);
    // Reading the CPU array of a storage attribute hands the game its initial contents; it is not a pending edit,
    // so a later engine call does not write it over what a kernel put on the GPU.
    const attribute = buffer.value as unknown as { array: Float32Array; clone(): unknown };
    expect(attribute.array).toHaveLength(4);
    attribute.clone();
    expect(writes).toHaveLength(1);
    // An edit followed by needsUpdate still reaches the engine.
    attribute.array[0] = 9;
    buffer.value.needsUpdate = true;
    expect(writes).toHaveLength(2);
  });

  it("indexes an element of the attribute's own buffer, atomically when asked", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    const counter = (tsl.instancedArray as (count: number, type: string) => IStorageBuffer)(
      2,
      "uint",
    ).toAtomic();
    counter.element(1);
    const [element] = calls.filter((call) => call.name === "storage:object");
    expect(element?.args.map((arg) => arg.kind)).toEqual([
      "handle",
      "string",
      "string",
      "number",
      "number",
    ]);
    expect(element?.args[1]).toEqual({ kind: "string", text: "uint" });
    expect(element?.args[4]).toEqual({ kind: "number", number: 1 });
    expect(() =>
      (tsl.instancedArray as (count: number, type: string) => IStorageBuffer)(
        2,
        "float",
      ).toAtomic(),
    ).toThrow(/toAtomic: expected int or uint/u);
  });

  it.each(["instancedArray", "attributeArray"])(
    "carries %s storage from its vertex-stage index",
    (name) => {
      const calls: ICall[] = [];
      const tsl = tslOver(calls);
      const buffer = (
        tsl[name] as (count: number, type: string) => IStorageBuffer & { toAttribute(): object }
      )(4, "vec3");
      expect(buffer.toAttribute()).toBeDefined();
      const element = calls.filter((call) => call.name === "storage:object").at(-1);
      expect(element?.args[3]?.kind).toBe("node");
      expect(
        calls.some(
          (call) =>
            call.name === `constant:${name === "instancedArray" ? "instanceIndex" : "vertexIndex"}`,
        ),
      ).toBe(true);
      expect(calls.at(-1)?.name).toBe("varying");
    },
  );

  it("names the compute dispatch size through the shared node method", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    const kernel = (
      tsl.Fn as (f: () => void) => () => { compute(count: number, size?: number): object }
    )(() => {})();
    kernel.compute(1000, 32);
    const compute = calls.find((call) => call.name === "compute");
    expect((kernel.compute(1, 1) as { isComputeNode?: boolean }).isComputeNode).toBe(true);
    expect(compute?.args).toEqual([
      { kind: "number", number: 1000 },
      { kind: "number", number: 32 },
    ]);
  });
});

describe("TSL operators SoftBody3D needs, on the Wasm facade", () => {
  type Node = Record<string, (...args: unknown[]) => Node>;
  it("calls the engine for comparisons, bool logic, all, any and conversions", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    const v = (tsl.vec3 as (...a: number[]) => Node)(1, 2, 3);
    const w = (tsl.vec3 as (...a: number[]) => Node)(1, 5, 2);
    const lanes = v.lessThanEqual?.(w) as Node;
    lanes.greaterThanEqual?.(w);
    lanes.and?.(lanes);
    lanes.or?.(lanes);
    lanes.not?.();
    lanes.all?.();
    lanes.any?.();
    v.toUint?.();
    v.toInt?.();
    v.toFloat?.();
    (tsl.and as (a: unknown, b: unknown) => unknown)(lanes, lanes);
    (tsl.all as (a: unknown) => unknown)(lanes);
    const names = calls.map((call) => call.name);
    for (const name of [
      "lessThanEqual",
      "greaterThanEqual",
      "and",
      "or",
      "not",
      "all",
      "any",
      "toUint",
      "toInt",
      "toFloat",
    ])
      expect(names, name).toContain(name);
    // The module-level forms carry no receiver; the method forms carry theirs.
    expect(
      calls.filter((call) => call.name === "and").map((call) => call.receiver === null),
    ).toEqual([false, true]);
  });

  it("chains ElseIf between If and Else, one engine call each", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    const ran: string[] = [];
    (tsl.Fn as (f: () => void) => () => void)(() => {
      const zero = (tsl.float as (n: number) => Node)(0);
      const test = zero.lessThan?.(zero) as Node;
      const chain = (tsl.If as (c: unknown, f: () => void) => Node)(test, () => ran.push("if"));
      chain.ElseIf?.(test, () => ran.push("elseif1"));
      chain.ElseIf?.(test, () => ran.push("elseif2"));
      chain.Else?.(() => ran.push("else"));
    })();
    expect(ran).toEqual(["if", "elseif1", "elseif2", "else"]);
    const names = calls.map((call) => call.name).filter((n) => /^(If|ElseIf|Else)$/u.test(n));
    expect(names).toEqual(["If", "ElseIf", "ElseIf", "Else"]);
    const elseIf = calls.find((call) => call.name === "ElseIf");
    expect(elseIf?.args.map((arg) => arg.kind)).toEqual(["node", "node"]);
  });

  it("makes Break, Continue and Return statements, and log and deltaTime nodes", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    (tsl.Fn as (f: () => void) => () => void)(() => {
      (tsl.Loop as (n: number, f: () => void) => void)(2, () => {
        (tsl.Continue as () => unknown)();
        (tsl.Break as () => unknown)();
      });
      (tsl.Return as () => unknown)();
    })();
    expect(
      calls.map((call) => call.name).filter((n) => /^(Break|Continue|Return)$/u.test(n)),
    ).toEqual(["Continue", "Break", "Return"]);
    const one = (tsl.float as (n: number) => Node)(1);
    (tsl.log as (a: unknown) => unknown)(one);
    expect(calls.some((call) => call.name === "log")).toBe(true);
    expect(tsl.deltaTime).toBeDefined();
    expect(() => (tsl.Break as () => unknown)()).toThrow(/outside Fn|Fn/u);
  });

  it("passes uniform(value, type) and a stepped Loop's start and step to the engine", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    (tsl.uniform as (v: number, t: string) => unknown)(3, "uint");
    const uniform = calls.find((call) => call.name === "uniform");
    expect(uniform?.args).toEqual([
      { kind: "number", number: 3 },
      { kind: "string", text: "uint" },
    ]);
    (tsl.Fn as (f: () => void) => () => void)(() => {
      (tsl.Loop as (p: unknown, f: () => void) => void)(
        { type: "uint", start: 1, end: 9, update: 4 },
        () => {},
      );
    })();
    const loop = calls.find((call) => call.name === "Loop");
    expect(loop?.args.slice(3)).toEqual([
      { kind: "number", number: 1 },
      { kind: "number", number: 4 },
    ]);
  });

  it("takes three's object-form Loop: type, start, end and the index name", () => {
    const calls: ICall[] = [];
    const tsl = tslOver(calls);
    let seen: unknown;
    (tsl.Fn as (f: () => void) => () => void)(() => {
      (tsl.Loop as (p: unknown, f: (o: Record<string, unknown>) => void) => void)(
        { type: "uint", start: 2, end: 6, name: "k" },
        ({ k }) => {
          seen = k;
        },
      );
    })();
    expect(seen).toBeDefined();
    expect(calls.find((call) => call.name === "Loop:index")?.args).toEqual([
      { kind: "string", text: "uint" },
    ]);
    const loop = calls.find((call) => call.name === "Loop");
    expect(loop?.args.map((arg) => arg.kind)).toEqual(["number", "node", "node", "number"]);
    expect(loop?.args[0]).toEqual({ kind: "number", number: 6 });
    expect(loop?.args[3]).toEqual({ kind: "number", number: 2 });
    expect(() =>
      (tsl.Fn as (f: () => void) => () => void)(() => {
        (tsl.Loop as (p: unknown, f: () => void) => void)({ end: 3, update: "+= 2" }, () => {});
      })(),
    ).toThrow(/update is not supported/u);
  });
});

describe("getArrayBufferAsync result forms", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  const read = async () => bytes.slice(0);

  it("resolves a new ArrayBuffer, sliced by offset and count", async () => {
    expect(new Uint8Array((await readStorageBytes(read, {})) as ArrayBuffer)).toEqual(
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    expect(new Uint8Array((await readStorageBytes(read, {}, null, 4, 4)) as ArrayBuffer)).toEqual(
      new Uint8Array([5, 6, 7, 8]),
    );
  });

  it("fills an ArrayBuffer target and hands a ReadbackBuffer its bytes", async () => {
    const target = new ArrayBuffer(8);
    expect(await readStorageBytes(read, {}, target)).toBe(target);
    expect(new Uint8Array(target)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    const buffer = { isReadbackBuffer: true, buffer: null as unknown };
    expect(await readStorageBytes(read, {}, buffer)).toBe(buffer);
    expect(new Uint8Array(buffer.buffer as ArrayBuffer)).toEqual(new Uint8Array(bytes));
  });

  it("hands the shared ReadbackBuffer its bytes and tells its release listeners", async () => {
    const buffer = new ReadbackBuffer(8);
    const heard: string[] = [];
    buffer.addEventListener("release", (event) => heard.push((event as { type: string }).type));
    expect(await readStorageBytes(read, {}, buffer)).toBe(buffer);
    expect(new Uint8Array(buffer.buffer as ArrayBuffer)).toEqual(new Uint8Array(bytes));
    expect(buffer.maxByteLength).toBe(8);
    buffer.release();
    expect(heard).toEqual(["release"]);
  });

  it("refuses an offset or count that is not a multiple of 4, as three does", async () => {
    await expect(readStorageBytes(read, {}, null, 2)).rejects.toThrow(/multiple of 4/u);
    await expect(readStorageBytes(read, {}, null, 0, 6)).rejects.toThrow(/multiple of 4/u);
  });
});
