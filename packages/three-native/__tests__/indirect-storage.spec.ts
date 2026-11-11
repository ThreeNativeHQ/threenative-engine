/**
 * PRD-857 phase 1: three's indirect draw records on the Wasm facade. Core's GPU world scene builds its
 * record buffer with `new IndirectStorageBufferAttribute(...)` and hands it to
 * `geometry.setIndirect(attribute, offset)`, and then reads `geometry.indirect` and
 * `geometry.indirectOffset` back every frame to decide whether a mesh still points at the record the
 * kernel writes. Neither existed on the owned engine, so the scene threw or gated off.
 *
 * The engine behind these calls (the C++ BufferGeometry field, its binding and the draw path that reads
 * it) is proven on the native renderer; this spec proves the facade and the values it crosses.
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
import { type ITslRuntime, defineTsl } from "../src/browser-tsl.js";
import { loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const catalog = loadCatalog(REPO);
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

interface IObject {
  readonly cls: string;
  readonly array?: Float32Array;
  readonly itemSize: number;
  readonly fields: Map<string, EngineValue>;
}

/** An engine that keeps each object's fields and answers the calls this spec makes. */
function engine() {
  const types = new Map<string, number>();
  const objects = new Map<string, IObject>();
  const calls: { method: string; args: readonly EngineValue[] }[] = [];
  let serial = 0;
  const typeId = (name: string) =>
    types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
  const runtime: IBrowserRuntime = {
    typeId,
    construct(name, args) {
      const key = `${name}:${++serial}`;
      const array = ArrayBuffer.isView(args[0]) ? (args[0] as Float32Array) : undefined;
      objects.set(key, { cls: name, array, itemSize: Number(args[1] ?? 0), fields: new Map() });
      return { key, type: typeId(name) };
    },
    invoke(self, method, args) {
      calls.push({ method, args });
      const object = objects.get(self.key);
      // The engine's BufferGeometry::setIndirect stores the pair and getIndirect shares it back; every
      // other method here chains, as three's do, answering the object it was called on.
      if (method === "setIndirect") {
        object?.fields.set("indirect", args[0] ?? null);
        object?.fields.set("indirectOffset", args[1] ?? 0);
        return self;
      }
      if (method === "getIndirect") return object?.fields.get("indirect") ?? null;
      return self;
    },
    get(self, property): EngineValue {
      const object = objects.get(self.key);
      if (object === undefined) return null;
      if (property === "itemSize") return object.itemSize;
      if (property === "count")
        return object.array === undefined ? 0 : object.array.length / (object.itemSize || 1);
      // The engine answers its declared ranges as canonical JSON; this stub declares none.
      if (property === "updateRanges") return "[]";
      return object.fields.get(property) ?? null;
    },
    set(self, property, value) {
      objects.get(self.key)?.fields.set(property, value);
    },
    release: () => undefined,
    setCallback: () => undefined,
    attributeArray: (self) => (objects.get(self.key)?.array ?? new Float32Array(0)) as never,
    attributeWrite: (self, array) => {
      const object = objects.get(self.key);
      if (object !== undefined) (object as { array?: Float32Array }).array = array as Float32Array;
    },
  };
  return { runtime, calls };
}

function facade() {
  const { runtime, calls } = engine();
  const { classes } = defineBrowserClasses(registry, runtime, catalog);
  const tslRuntime: ITslRuntime = {
    call: () => 1,
    release: vi.fn(),
    set: vi.fn(),
    setUniform: vi.fn(),
    setPost: vi.fn(),
    effectParameter: vi.fn(),
    compute: vi.fn(),
    readStorage: vi.fn(),
    deleteStorage: vi.fn(),
  };
  const exports = defineTsl(tslRuntime, classes as never).exports;
  const BufferGeometry = classes.BufferGeometry as new () => {
    setIndirect(attribute: unknown, offset?: number): object;
    getIndirect(): unknown;
    readonly indirect: unknown;
    readonly indirectOffset: unknown;
  };
  const Indirect = exports.IndirectStorageBufferAttribute as new (
    count: number | Uint32Array,
    itemSize: number,
    typeClass?: Uint32ArrayConstructor,
  ) => {
    count: number;
    itemSize: number;
    array: Uint32Array;
    isIndirectStorageBufferAttribute?: boolean;
    isStorageBufferAttribute?: boolean;
  };
  return { BufferGeometry, Indirect, calls };
}

describe("three's indirect draw records on the Wasm facade", () => {
  it("builds an IndirectStorageBufferAttribute, which is a storage attribute too", () => {
    const { Indirect } = facade();
    const attribute = new Indirect(new Uint32Array(5), 5);
    expect(attribute.isIndirectStorageBufferAttribute).toBe(true);
    // three's class extends StorageBufferAttribute, so a kernel-filled record buffer takes the same
    // rule as any other storage buffer: its JS array is never written back over the GPU copy.
    expect(attribute.isStorageBufferAttribute).toBe(true);
    expect([attribute.count, attribute.itemSize]).toEqual([1, 5]);
    // `new IndirectStorageBufferAttribute(count, itemSize)` allocates Uint32 words, as upstream does.
    const allocated = new Indirect(4, 1);
    expect(allocated.array).toBeInstanceOf(Uint32Array);
    expect(allocated.array).toHaveLength(4);
    expect(allocated.count).toBe(4);
  });

  it("sets a geometry's indirect record and reads the pair back from the engine", () => {
    const { BufferGeometry, Indirect, calls } = facade();
    const geometry = new BufferGeometry();
    const record = new Indirect(20, 1);

    expect(geometry.setIndirect(record, 20)).toBe(geometry);
    expect(calls.at(-1)?.method).toBe("setIndirect");
    expect(geometry.getIndirect()).toBe(record);
    // Both fields are read as core's dress path reads them, and the attribute keeps its identity
    // across the bridge (one wrapper per engine handle), so `geometry.indirect === args` holds.
    expect(geometry.indirect).toBe(record);
    expect(geometry.indirectOffset).toBe(20);

    // three's default offset is 0, and either field is writable, as upstream's are.
    geometry.setIndirect(record);
    expect(geometry.indirectOffset).toBe(0);
    geometry.setIndirect(undefined, 40);
    expect(geometry.indirect).toBeNull();
    expect(geometry.indirectOffset).toBe(40);
    expect(geometry.getIndirect()).toBeNull();
  });
});
