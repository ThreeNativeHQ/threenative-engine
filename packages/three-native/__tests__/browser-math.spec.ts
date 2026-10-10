/**
 * three's math values on the browser back end: a `new Vector3()` is JS and its arithmetic never
 * calls the engine; an engine vector (`mesh.position`) is the same class over the engine's memory;
 * a JS value crosses to the engine by value.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { Euler, Quaternion, Color as ThreeColor, Vector3 as ThreeVector3 } from "three";
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
  const members = new Map<string, [string, number | undefined][]>();
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
      // An object's members, and the one record that answers all their addresses.
      if (property === "__addresses")
        return Object.fromEntries([
          ["__address", addresses.get(self.key)],
          ...(members.get(self.key) ?? []),
        ]);
      if (property === "position" || property === "layers") {
        const member = construct(property === "layers" ? "Layers" : "Vector3", [7, 8, 9]);
        members.set(self.key, [
          ...(members.get(self.key) ?? []),
          [property, addresses.get(member.key)],
        ]);
        return member;
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

  it("reads and writes an object's members in the engine's memory, one address call", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    const Object3D = classes.Object3D as new () => { position: IVec; layers: { mask: number } };
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const object = new Object3D();
    const { position, layers } = object;
    expect(position).toBeInstanceOf(Vector3);
    position.add(new Vector3(1, 1, 1));
    expect([position.x, position.y, position.z]).toEqual([8, 9, 10]);
    expect([...heap.subarray(8, 11)]).toEqual([8, 9, 10]);
    expect(calls.filter((call) => call.startsWith("invoke") || call.startsWith("set"))).toEqual([]);
    expect(layers.mask).toBe(7);
    // The object answers both members' addresses in one call; neither member asks its own.
    expect(calls.filter((call) => call.startsWith("get __address"))).toEqual(["get __addresses"]);
  });

  it("hands a later object's members without asking the engine for them", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(self, property) {
        if (property !== "__addresses") return runtime.get(self, property);
        calls.push("get __addresses");
        // The engine's record holds every member, read or not.
        const at = 4096 + Number(self.key.split(":")[1]) * 64;
        return { __address: at, position: at + 16, layers: at + 48 };
      },
    });
    type Owner = { position: IVec; layers: { mask: number; enable(channel: number): void } };
    const Object3D = classes.Object3D as new () => Owner & { lookAt(v: IVec): void };
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const first = new Object3D();
    expect(first.position).toBeInstanceOf(Vector3);
    expect(first.layers.mask).toBe(0); // read where the record says
    calls.length = 0;
    const second = new Object3D(); // the third engine object: its record starts at 4096 + 3 * 64
    const { position, layers } = second;
    expect(position).toBeInstanceOf(Vector3);
    expect(second.position).toBe(position);
    position.set(1, 2, 3);
    layers.enable(1);
    expect([...heap.subarray(4096 / 8 + 24 + 2, 4096 / 8 + 24 + 5)]).toEqual([1, 2, 3]);
    expect(heap[4096 / 8 + 24 + 6]).toBe(2);
    expect(calls).toEqual(["construct Object3D", "get __addresses"]);
    // A call that takes the member as an engine object asks for its Ref then, once.
    calls.length = 0;
    first.lookAt(position);
    first.lookAt(position);
    expect(calls.filter((call) => call === "get position")).toEqual(["get position"]);
    expect(second.position).toBe(position);
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

  it("answers a curve's point with a JS vector when the game gives no target", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      invoke(self, method, args) {
        if (method !== "getPoint" && method !== "getTangent")
          return runtime.invoke(self, method, args);
        calls.push(`invoke ${method} ${String(args.length)}`);
        const target = args[1] as IEngineRef | undefined;
        if (target === undefined) return runtime.construct("Vector3", [1, 2, 3]);
        const at = Number(target.key.split(":")[1]) * 8; // object n sits at n * 64 bytes
        heap.set([1, 2, 3], at);
        return target;
      },
    });
    const Curve = classes.CatmullRomCurve3 as new (
      points: IVec[],
    ) => {
      getPoint(t: number, target?: IVec): IVec;
      getTangent(t: number): IVec;
    };
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const curve = new Curve([]);
    curve.getPoint(0);
    calls.length = 0;
    const point = curve.getPoint(0.5);
    const tangent = curve.getTangent(0.5);
    expect(point).toBeInstanceOf(Vector3);
    expect(engineRef(point)).toBeUndefined();
    expect(tangent).not.toBe(point);
    expect([point.x, point.y, point.z, tangent.x, tangent.y, tangent.z]).toEqual([
      1, 2, 3, 1, 2, 3,
    ]);
    // The lent engine vector is the pool's: no new engine object, no address asked.
    expect(calls).toEqual(["invoke getPoint 2", "invoke getTangent 2"]);
    const own = new Vector3();
    expect(curve.getPoint(0.5, own)).toBe(own);
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

  it("reads an attribute's shape with one engine call", () => {
    const { runtime } = memoryRuntime();
    const reads: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      construct: (name) => ({ key: name, type: runtime.typeId(name) }),
      get(_self, property) {
        reads.push(property);
        return property === "__shape"
          ? [4, 3, 1, 1015]
          : (
              { count: 4, itemSize: 3, normalized: true, gpuType: 1015 } as Record<
                string,
                number | boolean
              >
            )[property];
      },
    });
    const attribute = new (
      classes.BufferAttribute as new (
        array: Float32Array,
        itemSize: number,
      ) => { count: number; itemSize: number; normalized: boolean; gpuType: number }
    )(new Float32Array(12), 3);
    const shape = () => [
      attribute.count,
      attribute.itemSize,
      attribute.normalized,
      attribute.gpuType,
    ];
    expect([shape(), shape()]).toEqual([
      [4, 3, true, 1015],
      [4, 3, true, 1015],
    ]);
    expect(reads).toEqual(["__shape"]);
  });

  it("reads and writes attribute elements at index * itemSize + k, scaled when normalized", () => {
    const { runtime } = memoryRuntime();
    const shapes = [
      [2, 3, 0, 1015],
      [2, 2, 1, 1015],
    ];
    let next = 0;
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      construct: (name) => ({ key: String(next++), type: runtime.typeId(name) }),
      get: (self, property) => {
        if (property === "__shape") return shapes[Number(self.key)] as number[];
        throw new Error(`unexpected get ${property}`);
      },
      attributeArray: () => {
        throw new Error("an adopted array is read in place");
      },
      attributeDefer: () => undefined,
    });
    type Attribute = {
      getX(i: number): number;
      getY(i: number): number;
      getZ(i: number): number;
      getComponent(i: number, k: number): number;
      setXY(i: number, x: number, y: number): Attribute;
      setXYZ(i: number, x: number, y: number, z: number): Attribute;
      setComponent(i: number, k: number, value: number): Attribute;
    };
    const Attribute = classes.BufferAttribute as new (
      array: ArrayLike<number>,
      itemSize: number,
      normalized?: boolean,
    ) => Attribute;
    const floats = new Float32Array([1, 2, 3, 4, 5, 6]);
    const plain = new Attribute(floats, 3);
    expect([plain.getX(1), plain.getY(1), plain.getZ(0), plain.getComponent(1, 2)]).toEqual([
      4, 5, 3, 6,
    ]);
    plain.setXYZ(0, 7, 8, 9).setComponent(1, 0, 10);
    expect([...floats]).toEqual([7, 8, 9, 10, 5, 6]);
    const bytes = new Uint8Array([0, 255, 51, 102]);
    const unit = new Attribute(bytes, 2, true);
    expect([unit.getX(0), unit.getY(0), unit.getX(1), unit.getY(1)]).toEqual([0, 1, 0.2, 0.4]);
    unit.setXY(1, 1, 0.6);
    expect([...bytes]).toEqual([0, 255, 255, 153]);
  });

  it("copies an attribute's data again after an engine method only when the engine wrote it", () => {
    const { runtime } = memoryRuntime();
    const data = new Float32Array([1, 2, 3]);
    let writes = 0;
    let engineWrites = false;
    const copies: string[] = [];
    let take: (() => ArrayLike<number>) | undefined;
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      construct: (name) => ({ key: name, type: runtime.typeId(name) }),
      get: () => [1, 3, 0, 1015],
      invoke: () => {
        if (engineWrites) {
          // The engine pulls the deferred JS copy before it writes; the pull leaves the count.
          data.set(take?.() ?? []);
          take = undefined;
          data[0] = 7;
          writes++;
        }
        return null;
      },
      attributeArray: (self) => {
        copies.push(self.key);
        return data.slice();
      },
      attributeDefer: (_self, pull) => {
        take = pull;
      },
      attributeWrites: () => writes,
    });
    const attribute = new (
      classes.BufferAttribute as new (
        array: number[],
        itemSize: number,
      ) => { array: Float32Array }
    )([1, 2, 3], 3);
    const geometry = new (classes.BufferGeometry as new () => { translate(x: number): void })();
    const array = attribute.array;
    geometry.translate(1);
    expect([attribute.array, copies]).toEqual([array, ["BufferAttribute"]]);
    engineWrites = true;
    geometry.translate(1);
    expect(attribute.array).toBe(array);
    expect([[...array], copies.length]).toEqual([[7, 2, 3], 2]);
  });

  it("writes the game's array into the attribute only when the engine pulls it", () => {
    const { runtime } = memoryRuntime();
    const takes: (() => Float32Array)[] = [];
    const counted: unknown[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      construct: (name, _args, deferred) => {
        counted.push(deferred);
        return { key: name, type: runtime.typeId(name) };
      },
      get: () => [2, 2, 0, 1015],
      invoke: () => null,
      attributeArray: () => {
        throw new Error("an adopted array is read in place");
      },
      attributeDefer: (_self, take) => {
        takes.push(take as () => Float32Array);
      },
      attributeWrites: () => 0,
    });
    type Attribute = {
      array: Float32Array;
      setX(i: number, x: number): void;
      needsUpdate: boolean;
    };
    const handed = new Float32Array([1, 2, 3, 4]);
    const attribute = new (
      classes.BufferAttribute as new (
        array: Float32Array,
        itemSize: number,
      ) => Attribute
    )(handed, 2);
    // The array crosses as its count; storage the engine converts (Int16) needs the bytes.
    const converted = new Int16Array(2);
    new (classes.BufferAttribute as new (array: Int16Array, itemSize: number) => object)(
      converted,
      1,
    );
    expect(counted).toEqual([handed, undefined]);
    takes.pop();
    const geometry = new (classes.BufferGeometry as new () => { translate(x: number): void })();
    // Reads, element writes and engine calls before the pull defer once: nothing crosses.
    attribute.array[0] = 5;
    attribute.setX(1, 6);
    geometry.translate(1);
    geometry.translate(1);
    expect(takes.length).toBe(1);
    expect([...(takes[0]?.() ?? [])]).toEqual([5, 2, 6, 4]);
    // After the pull, the next hand-out or needsUpdate defers again.
    expect(attribute.array).toBe(handed);
    expect(takes.length).toBe(2);
    takes[1]?.();
    attribute.needsUpdate = true;
    expect(takes.length).toBe(3);
  });

  it("answers a geometry's attributes, names and shapes with one engine call", () => {
    const { runtime } = memoryRuntime();
    const reads: string[] = [];
    const attribute = runtime.typeId("BufferAttribute");
    const ref = (name: string) => ({ key: `attribute ${name}`, type: attribute });
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      construct: (name) => ({ key: name, type: runtime.typeId(name) }),
      get(_self, property) {
        reads.push(property);
        return property === "__attributes"
          ? {
              position: [ref("position"), [4, 3, 0, 1015]],
              normal: [ref("normal"), [4, 3, 0, 1015]],
              uv: [ref("uv"), [4, 2, 1, 1015]],
            }
          : [9, 9, 0, 0];
      },
      invoke: (_self, method) => {
        reads.push(method);
        return null;
      },
    });
    type Attribute = { count: number; itemSize: number; normalized: boolean };
    type Geometry = {
      __attributeNames: string;
      getAttribute(name: string): Attribute | null;
      hasAttribute(name: string): boolean;
      translate(...xyz: number[]): void;
      deleteAttribute(name: string): void;
    };
    const geometry = new (classes.BufferGeometry as new () => Geometry)();
    const position = geometry.getAttribute("position");
    const uv = geometry.getAttribute("uv");
    expect([position?.count, position?.itemSize, uv?.itemSize, uv?.normalized]).toEqual([
      4,
      3,
      2,
      true,
    ]);
    expect([geometry.hasAttribute("normal"), geometry.hasAttribute("color")]).toEqual([
      true,
      false,
    ]);
    expect([geometry.getAttribute("color"), geometry.__attributeNames]).toEqual([
      null,
      "position\nnormal\nuv",
    ]);
    expect(reads).toEqual(["__attributes"]);
    // Removing one attribute keeps the others listed.
    geometry.deleteAttribute("uv");
    expect([geometry.getAttribute("uv"), geometry.hasAttribute("position")]).toEqual([null, true]);
    expect([geometry.__attributeNames, reads]).toEqual([
      "position\nnormal",
      ["__attributes", "deleteAttribute"],
    ]);
    // After a method that may change attributes, the record is asked for again.
    geometry.translate(1, 0, 0);
    reads.length = 0;
    expect(geometry.getAttribute("normal")?.itemSize).toBe(3);
    expect(reads).toEqual(["__attributes"]);
  });

  it("keeps a mesh's geometry until it is set", () => {
    const { runtime } = memoryRuntime();
    const reads: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(self, property) {
        reads.push(property);
        return self;
      },
      set: () => undefined,
    });
    const mesh = new (classes.Mesh as new () => { geometry: unknown })();
    for (let i = 0; i < 3; i++) mesh.geometry;
    expect(reads).toEqual(["geometry"]);
    mesh.geometry = {};
    mesh.geometry;
    expect(reads).toEqual(["geometry", "geometry"]);
  });

  it("keeps a geometry's index until a method changes it", () => {
    const { runtime } = memoryRuntime();
    const reads: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(self, property) {
        reads.push(property);
        return self;
      },
      invoke: (_self, method) => {
        reads.push(method);
        return null;
      },
    });
    const geometry = new (
      classes.BufferGeometry as new () => {
        index: unknown;
        setIndex(index: unknown): void;
      }
    )();
    for (let i = 0; i < 3; i++) geometry.index;
    expect(reads).toEqual(["index"]);
    geometry.setIndex(null);
    geometry.index;
    expect(reads).toEqual(["index", "setIndex", "index"]);
  });

  it("keeps a geometry's attribute lookups until a method changes it", () => {
    const { runtime } = memoryRuntime();
    const calls: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      get(_self, property) {
        calls.push(property);
        return {
          position: [{ key: "a", type: runtime.typeId("BufferAttribute") }, [4, 3, 0, 1015]],
        };
      },
      invoke(_self, method, args) {
        calls.push(`${method} ${String(args[0])}`);
        return null;
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
    expect(calls).toEqual(["__attributes", "setAttribute uv", "__attributes"]);
  });

  it("keeps a geometry's attribute lookups across a setter of another property", () => {
    const { runtime } = memoryRuntime();
    const reads: string[] = [];
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      set: () => undefined,
      get(_self, property) {
        reads.push(property);
        return {
          instanceColor: [{ key: "a", type: runtime.typeId("BufferAttribute") }, [4, 3, 0, 1015]],
        };
      },
    });
    const geometry = new (
      classes.InstancedBufferGeometry as new () => {
        instanceCount: number;
        hasAttribute(name: string): boolean;
      }
    )();
    for (let i = 0; i < 3; i++) {
      geometry.instanceCount = i;
      expect(geometry.hasAttribute("instanceColor")).toBe(true);
    }
    expect(reads).toEqual(["__attributes"]);
  });

  it("runs three's Layers bit operations on the engine's mask in place", () => {
    const { runtime, calls } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, runtime);
    interface ILayers {
      mask: number;
      set(channel: number): void;
      enable(channel: number): void;
      enableAll(): void;
      toggle(channel: number): void;
      disable(channel: number): void;
      disableAll(): void;
      test(layers: ILayers): boolean;
      isEnabled(channel: number): boolean;
    }
    const Layers = classes.Layers as new () => ILayers;
    const a = new Layers();
    const b = new Layers();
    a.mask = 1;
    a.enable(1);
    expect(a.mask).toBe(3);
    a.disable(0);
    a.toggle(31);
    expect(a.mask).toBe(2 | (1 << 31)); // three keeps the signed result of `|=`
    expect(a.isEnabled(31)).toBe(true);
    a.set(31);
    expect(a.mask).toBe(2147483648);
    b.enableAll();
    expect(b.mask).toBe(-1);
    expect(a.test(b)).toBe(true);
    b.disableAll();
    expect(a.test(b)).toBe(false);
    expect(calls).toEqual([
      "construct Layers",
      "construct Layers",
      "get __address",
      "get __address",
    ]);
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
        if (property === "__addresses") {
          calls.push("get __addresses");
          return { rotation: 64, quaternion: 128 };
        }
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
    const { rotation, quaternion } = group; // at 64 and 128
    orders.forEach((order, i) => {
      bytes[64 + orderOffset] = i; // the Euler is the second object
      rotation.y = 0.5 + i;
      rotation.z = -1;
      expect(rotation.set(0.25, rotation.y, 2 - i, i % 2 ? order : undefined)).toBe(rotation);
      const { x, y, z, w } = quaternion;
      const expected = new Quaternion().setFromEuler(new Euler(0.25, 0.5 + i, 2 - i, order));
      expect([x, y, z, w]).toEqual([expected.x, expected.y, expected.z, expected.w]);
    });
    // One call answers both members' addresses; nothing else crosses.
    expect(calls.filter((call) => /^(set|invoke) |__address/u.test(call))).toEqual([
      "get __addresses",
    ]);
    rotation.set(0, 0, 0, "XYZ"); // a new order: the engine reorders and syncs
    expect(calls.at(-1)).toBe("invoke set");
    // An Euler no object owns still crosses, so its own callback (if any) runs in the engine.
    const free = new (classes.Euler as new () => IRotation)();
    free.x = 1;
    expect(calls.at(-1)).toBe("set x");
  });

  it("runs three's quaternion math on the lanes and syncs an object's rotation as three does", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const bytes = new Uint8Array(heap.buffer);
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      readByte: (address) => bytes[address] as number,
      get(self, property) {
        if (property === "__addresses") {
          calls.push("get __addresses");
          return { rotation: 64, quaternion: 128 };
        }
        if (property === "rotation") return runtime.construct("Euler", []);
        if (property === "quaternion") return runtime.construct("Quaternion", [0, 0, 0, 1]);
        return runtime.get(self, property);
      },
    });
    interface IQuat {
      x: number;
      y: number;
      z: number;
      w: number;
      setFromUnitVectors(from: IVec, to: IVec): IQuat;
      setFromAxisAngle(axis: IVec, angle: number): IQuat;
      multiply(q: IQuat): IQuat;
      premultiply(q: IQuat): IQuat;
    }
    const Vector3 = classes.Vector3 as new (x?: number, y?: number, z?: number) => IVec;
    const Quat = classes.Quaternion as new () => IQuat;
    const lanes = (q: { x: number; y: number; z: number; w: number }) => [q.x, q.y, q.z, q.w];
    const pairs = [
      [0, 0, 1, 0.3, -0.5, 0.8],
      [0, 1, 0, 0.6, 0.0, -0.8],
      [0, 0, 1, 0, 0, -1], // opposite, |x| <= |z|
      [1, 0, 0, -1, 0, 0], // opposite, |x| > |z|
    ].map(([a = 0, b = 0, c = 0, d = 0, e = 0, f = 0]) => {
      const to = new ThreeVector3(d, e, f).normalize();
      return [new ThreeVector3(a, b, c), to] as const;
    });
    const group = new (classes.Group as new () => { rotation: IVec; quaternion: IQuat })();
    const { rotation, quaternion } = group; // at 64 and 128
    const [orderOffset = -1] = registry.classes.Euler?.fields?.__order ?? [];
    const orders = ["XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"] as const;
    for (const [from, to] of pairs) {
      const ours = [new Quat(), new Quat()];
      const theirs = [new Quaternion(), new Quaternion()];
      const [q, twist] = ours as [IQuat, IQuat];
      const [tq, tTwist] = theirs as [Quaternion, Quaternion];
      const vFrom = new Vector3(from.x, from.y, from.z);
      const vTo = new Vector3(to.x, to.y, to.z);
      expect(q.setFromUnitVectors(vFrom, vTo)).toBe(q);
      expect(lanes(q)).toEqual(lanes(tq.setFromUnitVectors(from, to)));
      expect(twist.setFromAxisAngle(vTo, 0.7)).toBe(twist);
      expect(lanes(twist)).toEqual(lanes(tTwist.setFromAxisAngle(to, 0.7)));
      expect(lanes(q.multiply(twist))).toEqual(lanes(tq.multiply(tTwist)));
      expect(lanes(q.premultiply(twist))).toEqual(lanes(tq.premultiply(tTwist)));
      // An object's own quaternion turns its rotation, in every order, at the gimbal edge too.
      orders.forEach((order, i) => {
        bytes[64 + orderOffset] = i;
        const expected = new Quaternion().setFromUnitVectors(from, to);
        quaternion.setFromUnitVectors(vFrom, vTo);
        expect(lanes(quaternion)).toEqual(lanes(expected));
        const turned = new Euler().setFromQuaternion(expected, order);
        expect([rotation.x, rotation.y, rotation.z]).toEqual([turned.x, turned.y, turned.z]);
        quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
        const edge = new Euler().setFromQuaternion(
          expected.setFromAxisAngle(new ThreeVector3(0, 1, 0), Math.PI / 2),
          order,
        );
        expect([rotation.x, rotation.y, rotation.z]).toEqual([edge.x, edge.y, edge.z]);
      });
    }
    // Each JS quaternion asks for its address once; the object answers both members' in one call.
    expect(calls.filter((call) => /^(set|invoke) /u.test(call))).toEqual([]);
    expect(calls.filter((call) => call.startsWith("get __address")).sort()).toEqual([
      ...Array.from({ length: 8 }, () => "get __address"),
      "get __addresses",
    ]);
  });

  it.each(["visible", "castShadow", "receiveShadow"])(
    "reads `%s` in place and skips an unchanged set",
    (flag) => {
      const { runtime, calls, heap } = memoryRuntime();
      const bytes = new Uint8Array(heap.buffer);
      const { classes } = defineBrowserClasses(registry, {
        ...runtime,
        readByte: (address) => bytes[address] as number,
      });
      const group = new (classes.Group as new () => Record<string, boolean>)();
      const [offset = -1] = registry.classes.Group?.fields?.[flag] ?? [];
      bytes[offset] = 1; // the only object sits at address 0
      expect(group[flag]).toBe(true);
      group[flag] = true;
      group[flag] = false;
      expect(calls.filter((call) => call.includes(flag))).toEqual([`set ${flag}`]);
      // A group's own address comes in its `__addresses` record, which its members share.
      expect(calls.filter((call) => call.startsWith("get __address"))).toEqual(["get __addresses"]);
    },
  );

  it("runs three's colour math in JS and makes a colour an engine object for an engine-only method", () => {
    const { runtime, calls, heap } = memoryRuntime();
    const { classes } = defineBrowserClasses(registry, {
      ...runtime,
      invoke(self, method, args) {
        if (method !== "setStyle") return runtime.invoke(self, method, args);
        calls.push(`invoke setStyle ${String(args[0])}`);
        return self;
      },
    });
    interface IColor {
      r: number;
      g: number;
      b: number;
      setHex(hex: number, colorSpace?: string): IColor;
      setRGB(r: number, g: number, b: number, colorSpace?: string): IColor;
      convertSRGBToLinear(): IColor;
      convertLinearToSRGB(): IColor;
      lerp(color: IColor, alpha: number): IColor;
      multiplyScalar(s: number): IColor;
      addScalar(s: number): IColor;
      sub(color: IColor): IColor;
      clone(): IColor;
      equals(color: IColor): boolean;
      toArray(): number[];
      getHex(colorSpace?: string): number;
      getHexString(): string;
      setStyle(style: string): IColor;
    }
    type ColorClass = new (...args: unknown[]) => IColor;
    const script = (C: ColorClass) => {
      const a = new C(0xc0dce1).convertSRGBToLinear();
      const b = new C(0.2, 0.5, 0.9);
      const c = new C().setHex(0x123456, "srgb-linear").setRGB(0.3, 0.6, 0.1, "srgb");
      a.lerp(b, 0.3).multiplyScalar(1.7).addScalar(0.1).sub(c);
      const d = a.clone().convertLinearToSRGB();
      return [
        ...[a, b, c, d].flatMap((color) => color.toArray()),
        a.getHex(),
        d.getHex("srgb-linear"),
        b.getHexString(),
        a.equals(a.clone()),
        new C(b).equals(b),
      ];
    };
    const Color = classes.Color as ColorClass;
    expect(script(Color)).toEqual(script(ThreeColor as unknown as ColorClass));
    expect(calls).toEqual([]);
    // setStyle is the engine's: the JS value becomes an engine object in place, lanes in r, g, b order.
    const named = new Color(0.1, 0.2, 0.3);
    expect(named.setStyle("white")).toBe(named);
    expect(engineRef(named)).toBeDefined();
    expect(calls.filter((call) => !call.startsWith("get"))).toEqual([
      "construct Color",
      "invoke setStyle white",
    ]);
    const at = (runtime.get(engineRef(named) as IEngineRef, "__address") as number) / 8;
    expect([...heap.subarray(at, at + 3)]).toEqual([0.1, 0.2, 0.3]);
  });
});
