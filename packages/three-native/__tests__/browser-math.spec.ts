/**
 * three's math values on the browser back end: a `new Vector3()` is JS and its arithmetic never
 * calls the engine; an engine vector (`mesh.position`) is the same class over the engine's memory;
 * a JS value crosses to the engine by value.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { Euler, Quaternion } from "three";
import { describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
  engineRef,
} from "../src/browser-backend.js";

const registry = JSON.parse(
  readFileSync(
    path.join(process.cwd(), "packages", "three-native", "api", "native-registry.json"),
    "utf8",
  ),
) as IRegistryDump;

interface IVec {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): IVec;
  add(v: IVec): IVec;
  copy(v: IVec): IVec;
  clone(): IVec;
}

/** A runtime whose objects are slots of one Float64Array, as the Wasm engine's memory is. */
function memoryRuntime() {
  const heap = new Float64Array(1024);
  const types = new Map<string, number>();
  const typeId = (name: string) =>
    types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
  const addresses = new Map<string, number>();
  const calls: string[] = [];
  let next = 0;
  const construct = (name: string, args: readonly unknown[]): IEngineRef => {
    calls.push(`construct ${name}`);
    const key = `${name}:${next}`;
    addresses.set(key, next * 64);
    heap.set(
      args.filter((arg) => typeof arg === "number"),
      next * 8,
    );
    next++;
    return { key, type: typeId(name) };
  };
  const runtime: IBrowserRuntime = {
    typeId,
    construct,
    invoke(self, method, args) {
      calls.push(`invoke ${method}`);
      if (method === "getWorldPosition") {
        const target = args[0] as IEngineRef;
        heap.set([4, 5, 6], (addresses.get(target.key) as number) / 8);
        return target;
      }
      if (method === "lookAt") {
        const at = (addresses.get((args[0] as IEngineRef).key) as number) / 8;
        calls.push(`lookAt ${[...heap.subarray(at, at + 3)].join(",")}`);
        return null;
      }
      throw new Error(`unexpected ${self.key}.${method}`);
    },
    get(self, property) {
      calls.push(`get ${property}`);
      if (property === "__address") return addresses.get(self.key) as number;
      if (property === "position") return construct("Vector3", [7, 8, 9]);
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
  return { runtime, calls, heap };
}

describe("three's math values on the browser back end", () => {
  it("computes a JS vector without calling the engine", () => {
    const { runtime, calls } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const v = new Vector3(1, 2, 3).add(new Vector3(1, 1, 1));
    const copy = v.clone();
    expect([copy.x, copy.y, copy.z]).toEqual([2, 3, 4]);
    expect(copy).toBeInstanceOf(Vector3);
    expect(calls).toEqual([]);
  });

  it("reads and writes an engine vector's lanes in the engine's memory, one address read", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Object3D = classes.Object3D as new () => { position: IVec };
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const object = new Object3D();
    const position = object.position;
    expect(position).toBeInstanceOf(Vector3);
    position.add(new Vector3(1, 1, 1));
    expect([position.x, position.y, position.z]).toEqual([8, 9, 10]);
    expect([...heap.subarray(8, 11)]).toEqual([8, 9, 10]);
    expect(calls.filter((call) => call.startsWith("invoke") || call.startsWith("set"))).toEqual([]);
    expect(calls.filter((call) => call === "get __address")).toHaveLength(1);
  });

  it("lends an engine call a vector and copies its lanes back, answering the JS value", () => {
    const { runtime, calls } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Object3D = classes.Object3D as new () => {
      getWorldPosition(target: IVec): IVec;
      lookAt(target: IVec): void;
    };
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const object = new Object3D();
    const target = new Vector3();
    expect(object.getWorldPosition(target)).toBe(target);
    expect([target.x, target.y, target.z]).toEqual([4, 5, 6]);
    expect(engineRef(target)).toBeUndefined();
    object.lookAt(new Vector3(1, 2, 3));
    expect(calls).toContain("lookAt 1,2,3");
    // One engine Vector3 serves both calls.
    expect(calls.filter((call) => call === "construct Vector3")).toHaveLength(1);
  });

  it("turns a value a constructor keeps into an engine object in place", () => {
    const { runtime, heap } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const Box3 = classes.Box3 as new (min: IVec, max: IVec) => object;
    const min = new Vector3(1, 2, 3);
    new Box3(min, new Vector3(4, 5, 6));
    expect(engineRef(min)).toBeDefined();
    expect(min).toBeInstanceOf(Vector3);
    min.x = 10;
    const at = (runtime.get(engineRef(min) as IEngineRef, "__address") as number) / 8;
    expect([...heap.subarray(at, at + 3)]).toEqual([10, 2, 3]);
  });

  it("answers MathUtils without calling the engine", () => {
    const { runtime, calls } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const MathUtils = new (
      classes.MathUtils as new () => {
        clamp(v: number, a: number, b: number): number;
        degToRad(d: number): number;
        euclideanModulo(n: number, m: number): number;
        lerp(x: number, y: number, t: number): number;
      }
    )();
    expect(MathUtils.clamp(5, 0, 1)).toBe(1);
    expect(MathUtils.degToRad(180)).toBe(Math.PI);
    expect(MathUtils.euclideanModulo(-1, 4)).toBe(3);
    expect(MathUtils.lerp(2, 4, 0.5)).toBe(3);
    expect(calls).toEqual([]);
  });

  it("keeps an object's name until it is set or a method runs on it", () => {
    const { runtime } = memoryRuntime();
    let name = "hip";
    let engineReads = 0;
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(self, property) {
        if (property !== "name") return runtime.get(self, property);
        engineReads++;
        return name;
      },
      set(_self, property, value) {
        if (property === "name") name = value as string;
      },
      invoke: () => null,
    });
    const bone = new (classes.Bone as new () => { name: string; updateMatrix(): void })();
    expect([bone.name, bone.name]).toEqual(["hip", "hip"]);
    expect(engineReads).toBe(1);
    bone.name = "spine";
    expect(bone.name).toBe("spine");
    name = "renamed";
    bone.updateMatrix();
    expect(bone.name).toBe("renamed");
    expect(engineReads).toBe(3);
  });

  it("keeps an object's labels across a read-only method, as core's projection calls one per mesh a frame", () => {
    const { runtime } = memoryRuntime();
    let engineReads = 0;
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(self, property) {
        if (property !== "name") return runtime.get(self, property);
        engineReads++;
        return "hip";
      },
      invoke: () => null,
    });
    const bone = new (
      classes.Bone as new () => {
        name: string;
        __tnVisibleInWorld(): void;
        getWorldPosition(target: object): void;
      }
    )();
    expect(bone.name).toBe("hip");
    bone.__tnVisibleInWorld();
    bone.getWorldPosition({});
    expect(bone.name).toBe("hip");
    expect(engineReads).toBe(1);
  });

  it("writes an object's rotation in place and syncs its quaternion as three does", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const bytes = new Uint8Array(heap.buffer);
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      readByte: (address) => bytes[address] as number,
      invoke(self, method, args) {
        if (method !== "set") return runtime.invoke(self, method, args);
        calls.push("invoke set");
        return self;
      },
      get(self, property) {
        if (property === "rotation") return runtime.construct("Euler", []);
        if (property === "quaternion") return runtime.construct("Quaternion", [0, 0, 0, 1]);
        return runtime.get(self, property);
      },
    });
    interface IRotation {
      x: number;
      y: number;
      z: number;
      set(x: number, y: number, z: number, order?: string): IRotation;
    }
    const group = new (
      classes.Group as new () => {
        rotation: IRotation;
        quaternion: { x: number; y: number; z: number; w: number };
      }
    )();
    const [orderOffset = -1] = registry.classes.Euler?.fields?.__order ?? [];
    const orders = ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"] as const;
    const rotation = group.rotation;
    orders.forEach((order, i) => {
      bytes[64 + orderOffset] = i; // the Euler is the second object
      rotation.y = 0.5 + i;
      rotation.z = -1;
      expect(rotation.set(0.25, rotation.y, 2 - i, i % 2 ? order : undefined)).toBe(rotation);
      const { x, y, z, w } = group.quaternion;
      const expected = new Quaternion().setFromEuler(new Euler(0.25, 0.5 + i, 2 - i, order));
      expect([x, y, z, w]).toEqual([expected.x, expected.y, expected.z, expected.w]);
    });
    expect(calls.filter((call) => /^(set|invoke) /u.test(call))).toEqual([]);
    rotation.set(0, 0, 0, "XYZ"); // a new order: the engine reorders and syncs
    expect(calls.at(-1)).toBe("invoke set");
    // An Euler no object owns still crosses, so its own callback (if any) runs in the engine.
    const free = new (classes.Euler as new () => IRotation)();
    free.x = 1;
    expect(calls.at(-1)).toBe("set x");
  });

  it("keeps a mesh's geometry and an attribute's shape until they are set", () => {
    const { runtime } = memoryRuntime();
    const reads: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(self, property) {
        reads.push(property);
        return property === "itemSize" ? 3 : property === "normalized" ? false : self;
      },
      set: () => undefined,
    });
    const mesh = new (classes.Mesh as new () => { geometry: unknown })();
    const attribute = new (
      classes.BufferAttribute as new () => {
        itemSize: number;
        normalized: boolean;
      }
    )();
    for (let i = 0; i < 3; i++) [mesh.geometry, attribute.itemSize, attribute.normalized];
    expect(reads).toEqual(["geometry", "itemSize", "normalized"]);
    mesh.geometry = {};
    mesh.geometry;
    expect(reads).toEqual(["geometry", "itemSize", "normalized", "geometry"]);
  });

  it("keeps a geometry's attribute lookups until a method changes it", () => {
    const { runtime } = memoryRuntime();
    const invokes: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      invoke(_self, method, args) {
        invokes.push(`${method} ${String(args[0])}`);
        return method === "hasAttribute" ? args[0] === "position" : null;
      },
    });
    const geometry = new (
      classes.BufferGeometry as new () => {
        hasAttribute(name: string): boolean;
        setAttribute(name: string, attribute: unknown): void;
      }
    )();
    for (let i = 0; i < 3; i++)
      expect([geometry.hasAttribute("position"), geometry.hasAttribute("uv")]).toEqual([
        true,
        false,
      ]);
    geometry.setAttribute("uv", null);
    geometry.hasAttribute("uv");
    expect(invokes).toEqual([
      "hasAttribute position",
      "hasAttribute uv",
      "setAttribute uv",
      "hasAttribute uv",
    ]);
  });
});
