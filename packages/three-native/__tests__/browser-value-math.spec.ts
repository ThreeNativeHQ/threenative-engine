/**
 * PRD-742: every three math value class the engine binds is JS on the browser back end, so CPU-side
 * value arithmetic crosses nothing, and an engine-owned value reads and writes its lanes in memory.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  type AmbientLight as ThreeAmbientLight,
  type Box3 as ThreeBox3,
  Color as ThreeColor,
  type Euler as ThreeEuler,
  type Matrix3 as ThreeMatrix3,
  type Matrix4 as ThreeMatrix4,
  type Mesh as ThreeMesh,
  type Quaternion as ThreeQuaternion,
  type Sphere as ThreeSphere,
  type Vector2 as ThreeVector2,
  type Vector3 as ThreeVector3,
  type Vector4 as ThreeVector4,
} from "three";
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

/** A runtime that fails on any engine call: a JS value must make none. */
function silentRuntime(): IBrowserRuntime {
  let types = 0;
  const refuse = (what: string) => () => {
    throw new Error(`engine call: ${what}`);
  };
  return {
    typeId: () => ++types,
    construct: refuse("construct"),
    invoke: refuse("invoke"),
    get: refuse("get"),
    set: refuse("set"),
    release: () => undefined,
    setCallback: () => undefined,
  };
}

const classesOf = () => defineBrowserClasses(registry, silentRuntime()).classes;

describe("PRD-742 value math stays in JS on the web engine", () => {
  it("computes 10k Color lerp/copy/setHex calls with no engine call", () => {
    const Color = classesOf().Color as unknown as new (
      r?: number,
      g?: number,
      b?: number,
    ) => ThreeColor;
    const color = new Color(0.1, 0.2, 0.3);
    const other = new Color(0.9, 0.8, 0.7);
    for (let i = 0; i < 10_000; i++) {
      other.setHex(i & 0xffffff);
      color.lerp(other, 0.5);
      color.copy(other);
    }
    expect(Number.isFinite(color.r + color.g + color.b)).toBe(true);
    expect(color).toBeInstanceOf(Color);
  });

  it("matches three's colour management on setHex, setStyle and getHex", () => {
    const Color = classesOf().Color as new (r?: number, g?: number, b?: number) => ThreeColor;
    for (const hex of [0x000000, 0x336699, 0xff0000, 0x7f7f7f]) {
      const ours = new Color().setHex(hex);
      const theirs = new ThreeColor().setHex(hex);
      expect([ours.r, ours.g, ours.b]).toEqual([theirs.r, theirs.g, theirs.b]);
      expect(ours.getHex()).toBe(theirs.getHex());
      expect(ours.getHexString()).toBe(theirs.getHexString());
    }
    for (const style of ["#123456", "rgb(10, 20, 30)", "hsl(210, 50%, 40%)", "cornflowerblue"]) {
      const ours = new Color().setStyle(style);
      const theirs = new ThreeColor().setStyle(style);
      expect([ours.r, ours.g, ours.b]).toEqual([theirs.r, theirs.g, theirs.b]);
      expect(ours.getStyle()).toBe(theirs.getStyle());
    }
  });

  it("computes 10k Vector2, Vector4, Quaternion, Euler, Matrix3, Matrix4, Box3 and Sphere calls in JS", () => {
    const classes = classesOf();
    const Vector2 = classes.Vector2 as typeof ThreeVector2;
    const Vector4 = classes.Vector4 as typeof ThreeVector4;
    const Quaternion = classes.Quaternion as typeof ThreeQuaternion;
    const Euler = classes.Euler as typeof ThreeEuler;
    const Matrix3 = classes.Matrix3 as typeof ThreeMatrix3;
    const Matrix4 = classes.Matrix4 as typeof ThreeMatrix4;
    const Box3 = classes.Box3 as typeof ThreeBox3;
    const Sphere = classes.Sphere as typeof ThreeSphere;
    const Vector3 = classes.Vector3 as typeof ThreeVector3;

    const v2 = new Vector2(1, 2);
    const v4 = new Vector4(1, 2, 3, 4);
    const q = new Quaternion();
    const e = new Euler();
    const m3 = new Matrix3();
    const m4 = new Matrix4();
    const box = new Box3();
    const sphere = new Sphere();
    for (let i = 0; i < 10_000; i++) {
      v2.add(new Vector2(1, 1)).multiplyScalar(0.5);
      v4.add(new Vector4(1, 1, 1, 1)).multiplyScalar(0.5);
      q.multiply(new Quaternion(0, 0, 0, 1));
      e.set(0.1, 0.2, 0.3, i % 2 === 0 ? "XYZ" : "YXZ");
      m3.multiply(new Matrix3());
      m4.multiply(new Matrix4());
      box.expandByPoint(new Vector3(i % 3, 0, 0));
      sphere.union(new Sphere(new Vector3(), 1));
    }
    expect([v2.x, v4.w, q.w, e.order]).toHaveLength(4);
  });

  it("reads and writes an engine colour's lanes in the engine's memory with no engine call", () => {
    // AmbientLight's `color` is a fixed member: one engine get answers it, then it is a wrapper.
    const heap = new Float64Array(256);
    let next = 0;
    const addresses = new Map<string, number>();
    const types = new Map<string, number>();
    const typeId = (name: string) =>
      types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
    const construct = (name: string, args: readonly unknown[]): IEngineRef => {
      const key = `${name}:${next}`;
      addresses.set(key, next * 32);
      heap.set(args.filter((arg) => typeof arg === "number") as number[], next * 4);
      next++;
      return { key, type: typeId(name) };
    };
    const { classes } = defineBrowserClasses(registry, {
      typeId,
      construct,
      invoke: () => {
        throw new Error("invoke");
      },
      get(self, property) {
        if (property === "__address") return addresses.get(self.key) as number;
        if (property === "color") return construct("Color", [1, 0, 0]);
        throw new Error(`get ${property}`);
      },
      set: () => {
        throw new Error("set");
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
    });
    const AmbientLight = classes.AmbientLight as typeof ThreeAmbientLight;
    const Color = classes.Color as unknown as new (
      r?: number,
      g?: number,
      b?: number,
    ) => ThreeColor;
    const light = new AmbientLight();
    const color = light.color;
    expect(color).toBeInstanceOf(Color);
    const at = (addresses.get((engineRef(color) as IEngineRef).key) as number) / 8;
    color.lerp(new Color(0, 1, 0), 1);
    expect([...heap.subarray(at, at + 3)]).toEqual([0, 1, 0]);
    color.r = 0.5;
    expect(heap[at]).toBe(0.5);
  });

  it("writes an engine matrix's elements through to the engine's memory, as views", () => {
    const heap = new Float64Array(256);
    let next = 0;
    const addresses = new Map<string, number>();
    const types = new Map<string, number>();
    const typeId = (name: string) =>
      types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
    const construct = (name: string, args: readonly unknown[]): IEngineRef => {
      const key = `${name}:${next}`;
      addresses.set(key, next * 32);
      heap.set(args.filter((arg) => typeof arg === "number") as number[], next * 4);
      next++;
      return { key, type: typeId(name) };
    };
    const { classes } = defineBrowserClasses(registry, {
      typeId,
      construct,
      invoke: () => {
        throw new Error("invoke");
      },
      get(self, property) {
        if (property === "__address") return addresses.get(self.key) as number;
        if (property === "matrix")
          return construct("Matrix4", [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
        throw new Error(`get ${property}`);
      },
      set: () => {
        throw new Error("set");
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
    });
    const Mesh = classes.Mesh as typeof ThreeMesh;
    const Matrix4 = classes.Matrix4 as typeof ThreeMatrix4;
    const mesh = new Mesh();
    const matrix = mesh.matrix;
    expect(matrix).toBeInstanceOf(Matrix4);
    expect(Array.isArray(matrix.elements)).toBe(true);
    const at = (addresses.get((engineRef(matrix) as IEngineRef).key) as number) / 8;
    matrix.elements[12] = 7;
    expect(heap[at + 12]).toBe(7);
    matrix.copy(new Matrix4().makeTranslation(1, 2, 3));
    expect([...heap.subarray(at + 12, at + 15)]).toEqual([1, 2, 3]);
  });

  it("promotes a JS matrix with row-major constructor arguments, not transposed", () => {
    const constructed: { name: string; args: unknown[] }[] = [];
    let types = 0;
    const typeId = () => ++types;
    const construct = (name: string, args: readonly unknown[]): IEngineRef => {
      constructed.push({ name, args: [...args] });
      return { key: `${name}:${constructed.length}`, type: typeId() };
    };
    const { classes } = defineBrowserClasses(registry, {
      typeId,
      construct,
      invoke: () => null,
      get(self, property) {
        if (property === "__address") return 0;
        throw new Error(`get ${property}`);
      },
      set: () => undefined,
      release: () => undefined,
      setCallback: () => undefined,
    });
    const Plane = classes.Plane as new () => { applyMatrix4(m: object): void };
    const Matrix4 = classes.Matrix4 as typeof ThreeMatrix4;
    const matrix = new Matrix4().makeTranslation(1, 2, 3);
    new Plane().applyMatrix4(matrix);
    const promoted = constructed.find((entry) => entry.name === "Matrix4");
    expect(promoted).toBeDefined();
    // Row-major n14/n24/n34 are indices 3, 7, 11; column-major elements would put them at 12, 13, 14.
    expect([promoted?.args[3], promoted?.args[7], promoted?.args[11]]).toEqual([1, 2, 3]);
  });

  it.each([
    { name: "Color", lanes: [0.25, 0.5, 0.75] },
    { name: "Vector4", lanes: [1, 2, 3, 4] },
  ])("crosses a JS $name to the engine with its lanes in order", ({ name, lanes }) => {
    const constructed: { name: string; args: unknown[] }[] = [];
    const types = new Map<string, number>();
    const typeId = (className: string) =>
      types.get(className) ?? types.set(className, types.size + 1).get(className) ?? 0;
    const { classes } = defineBrowserClasses(registry, {
      typeId,
      construct(className, args) {
        constructed.push({ name: className, args: [...args] });
        return { key: `${className}:${constructed.length}`, type: typeId(className) };
      },
      invoke: () => null,
      get: () => 0,
      set: () => undefined,
      release: () => undefined,
      setCallback: () => undefined,
    });
    const InstancedMesh = classes.InstancedMesh as new (
      geometry: object,
      material: object,
      count: number,
    ) => { setColorAt(index: number, value: object): void };
    const Geometry = classes.BufferGeometry as new () => object;
    const Material = classes.MeshBasicMaterial as new () => object;
    const Value = classes[name] as new (...valueLanes: number[]) => object;
    // The runtime spy checks argument marshalling before native method signature validation.
    const mesh = new InstancedMesh(new Geometry(), new Material(), 1);
    mesh.setColorAt(0, new Value(...lanes));
    const sent = constructed.find((entry) => entry.name === name);
    expect(sent?.args).toEqual(lanes);
  });

  it("releases the temporary vectors a Box3 or Sphere promotion builds", () => {
    let released = 0;
    const types = new Map<string, number>();
    const typeId = (name: string) =>
      types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0;
    const { classes } = defineBrowserClasses(registry, {
      typeId,
      construct: (name) => ({ key: `${name}:${types.size}`, type: typeId(name) }),
      invoke: () => null,
      get: (self, property) => (property === "__address" ? 0 : 0),
      set: () => undefined,
      release: () => {
        released++;
      },
      setCallback: () => undefined,
    });
    const Box3 = classes.Box3 as typeof ThreeBox3;
    const Sphere = classes.Sphere as typeof ThreeSphere;
    const Geometry = classes.BufferGeometry as new () => {
      boundingBox: object | null;
      boundingSphere: object | null;
    };
    const geometry = new Geometry();
    geometry.boundingBox = new Box3();
    expect(released).toBe(2);
    geometry.boundingSphere = new Sphere();
    expect(released).toBe(3);
  });

  it("keeps Box3 and Sphere values JS, with copies on the engine side", () => {
    const classes = classesOf();
    const Vector3 = classes.Vector3 as typeof ThreeVector3;
    const Box3 = classes.Box3 as typeof ThreeBox3;
    const Sphere = classes.Sphere as typeof ThreeSphere;
    const box = new Box3(new Vector3(1, 2, 3), new Vector3(4, 5, 6));
    expect(box.getSize(new Vector3()).toArray()).toEqual([3, 3, 3]);
    const sphere = new Sphere(new Vector3(1, 2, 3), 4);
    expect(sphere.containsPoint(new Vector3(1, 2, 3))).toBe(true);
    expect(engineRef(box)).toBeUndefined();
    expect(engineRef(sphere)).toBeUndefined();
  });
  it("promotes a JS matrix with row-major constructor arguments", () => {
    const seen: number[][] = [];
    let types = 0;
    const { classes } = defineBrowserClasses(registry, {
      typeId: () => ++types,
      construct(name, args) {
        if (name === "Matrix4") seen.push(args.map(Number));
        return { key: `${name}:${++types}`, type: types };
      },
      invoke: () => null,
      get: () => 0,
      set: () => undefined,
      release: () => undefined,
      setCallback: () => undefined,
    });
    const Plane = classes.Plane as new () => { applyMatrix4(m: ThreeMatrix4): unknown };
    const Matrix4 = classes.Matrix4 as typeof ThreeMatrix4;
    new Plane().applyMatrix4(new Matrix4().makeTranslation(1, 2, 3));
    const args = seen.at(-1) as number[];
    // The native constructor reads three's row-major set order: m14/m24/m34 are 3, 7 and 11.
    expect([args[3], args[7], args[11]]).toEqual([1, 2, 3]);
  });

  it("releases the temporary vectors a Box3 or Sphere promotion builds", () => {
    let released = 0;
    let types = 0;
    const { classes } = defineBrowserClasses(registry, {
      typeId: () => ++types,
      construct: (name) => ({ key: `${name}:${++types}`, type: types }),
      invoke: () => null,
      get: () => 0,
      set: () => undefined,
      release: () => {
        released++;
      },
      setCallback: () => undefined,
    });
    const Geometry = classes.BufferGeometry as new () => {
      boundingBox: object;
      boundingSphere: object;
    };
    const Box3 = classes.Box3 as typeof ThreeBox3;
    const Sphere = classes.Sphere as typeof ThreeSphere;
    const geometry = new Geometry();
    geometry.boundingBox = new Box3();
    expect(released).toBe(2);
    geometry.boundingSphere = new Sphere();
    expect(released).toBe(3);
  });
});
