/**
 * What crosses the bridge, and what the engine sees. A transform write is a store into the Wasm
 * memory the engine owns, so N writes cost no crossing, and the engine reads the new value in the same
 * frame. The memory can grow between two writes (the engine allocates), which replaces every typed
 * view of it: a write after growth must land in the new memory, and a handle sent to the engine must
 * be read from it.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
} from "../src/browser-backend.js";

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
      if (property === "position" || property === "scale") {
        const ref = construct("Vector3");
        // The member's lanes follow its owner's, as the transform page lays them out.
        addresses.set(
          ref.key,
          (addresses.get(self.key) as number) + (property === "scale" ? 64 : 0),
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
  } as unknown as TnAbiModule & { handlesSeen: number[][] };
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
    return pointer;
  };
  abi._free = () => 0;
  abi._tn_engine_version = () => 0;
  abi._tn_context_create = () => 0;
  abi._tn_diagnostic_release = () => 0;
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
