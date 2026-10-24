/**
 * PRD-532: the browser-JS back end covers every catalog entry marked supported, and nothing else.
 *
 * The back end builds its classes from the registry snapshot, and `catalog-registry.spec.ts` proves
 * that snapshot equals the catalog's supported set; this spec proves the classes the back end
 * defines carry exactly that surface. The surface runtime refuses every call; the attribute-sync
 * block below builds its own engine, and `native_engine_wasm_browser_backend` drives the same
 * classes over the Wasm ABI.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  LANGUAGE_MEMBERS,
  defineBrowserClasses,
  engineRef,
} from "../src/browser-backend.js";
import { type ICatalogClassEntry, loadCatalog } from "../src/catalog.js";

// Resolved from this module, so the spec passes from the repository root or `packages/three-native`.
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages", "three-native", "api", "native-registry.json"), "utf8"),
) as IRegistryDump;

function surfaceOnly(): IBrowserRuntime {
  const types = new Map<string, number>();
  const refuse = (): never => {
    throw new Error("surface-only runtime");
  };
  return {
    typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
    construct: refuse,
    invoke: refuse,
    get: refuse,
    set: refuse,
    release: () => undefined,
    setCallback: refuse,
  };
}

describe("the browser-JS back end", () => {
  const runtime = surfaceOnly();
  const { classes, wrap } = defineBrowserClasses(registry, runtime);

  it("defines exactly the catalog's supported classes", () => {
    const supported = loadCatalog(REPO)
      .entries.filter((entry): entry is ICatalogClassEntry => entry.kind === "class")
      .filter((entry) => entry.status.kind === "supported")
      .map((entry) => entry.name);
    expect(Object.keys(classes).sort()).toEqual(supported.sort());
  });

  it("gives each class exactly its registry members", () => {
    for (const [name, binding] of Object.entries(registry.classes)) {
      const prototype = classes[name]?.prototype as object;
      // A math value class (`Vector3`) keeps its engine accessors on the side its engine objects use.
      const engineSide = Object.getPrototypeOf(
        wrap({ key: `${name}:surface`, type: runtime.typeId(name) }),
      ) as object;
      const sides = engineSide === prototype ? [prototype] : [prototype, engineSide];
      const exposed = sides
        .flatMap((side) => Object.getOwnPropertyNames(side))
        .filter((key) => key !== "constructor");
      // PRD-540: scene-graph classes also carry the JavaScript-side members (browser-surface.spec.ts).
      // Disposable classes (textures, materials, geometries) carry `userData` as three's do.
      const language: readonly string[] = binding.members.includes("parent")
        ? LANGUAGE_MEMBERS
        : binding.methods.includes("dispose")
          ? ["userData"]
          : [];
      const expected = new Set([
        ...binding.methods,
        ...binding.getters.filter((key) => !key.includes(".")),
        ...binding.members.filter((key) => !key.includes(".")),
        ...binding.callbacks,
        ...language,
        // A write-only setter (`needsUpdate`) is a property of its own, or the write never lands.
        ...binding.setters.filter((key) => !key.includes(".")),
        // A dotted setter whose head is no member or getter (`morphAttributes.position`) exposes its
        // head as a holder object, as the V8 adapter does.
        ...binding.setters
          .filter((key) => key.includes("."))
          .map((key) => key.slice(0, key.indexOf(".")))
          .filter((head) => !binding.members.includes(head) && !binding.getters.includes(head)),
        // A getter-only head whose paths are all one level deep (`drawRange.count`) is a holder as well.
        ...binding.getters
          .filter(
            (key) =>
              key.indexOf(".") === key.lastIndexOf(".") &&
              key.includes(".") &&
              ![...binding.getters, ...binding.members].some(
                (other) =>
                  other.startsWith(`${key.slice(0, key.indexOf("."))}.`) &&
                  other.split(".").length > 2,
              ),
          )
          .map((key) => key.slice(0, key.indexOf(".")))
          .filter((head) => !binding.members.includes(head) && !binding.getters.includes(head)),
      ]);
      expect(exposed.sort(), name).toEqual([...expected].sort());
      for (const key of exposed) {
        const descriptor = sides
          .map((side) => Object.getOwnPropertyDescriptor(side, key))
          .find((found) => found !== undefined);
        if (
          descriptor?.get === undefined ||
          binding.callbacks.includes(key) ||
          language.includes(key)
        )
          continue;
        // A list getter with indexed setters (`morphTargetInfluences.0`) is a live array, assignable whole.
        const liveArray = binding.setters.some((path) =>
          new RegExp(`^${key}\\.\\d+$`, "u").test(path),
        );
        expect(descriptor.set !== undefined, `${name}.${key} settable`).toBe(
          binding.setters.includes(key) || liveArray,
        );
      }
    }
  });

  it("pushes an object's own hits from raycast, without recursing (core's picking calls it)", () => {
    const seen: unknown[][] = [];
    const raycaster = {
      intersectObject: (...args: unknown[]) => {
        seen.push(args);
        return [{ distance: 1 }, { distance: 2 }];
      },
    };
    const into: unknown[] = [{ distance: 0 }];
    const group = {};
    (classes.Group?.prototype as { raycast(r: unknown, into: unknown[]): void }).raycast.call(
      group,
      raycaster,
      into,
    );
    expect(into).toHaveLength(3);
    expect(seen).toEqual([[group, false]]);
  });

  it("makes each registry callback a settable accessor", () => {
    for (const [name, binding] of Object.entries(registry.classes)) {
      for (const callback of binding.callbacks) {
        const descriptor = Object.getOwnPropertyDescriptor(
          classes[name]?.prototype as object,
          callback,
        );
        expect(
          descriptor?.get !== undefined && descriptor.set !== undefined,
          `${name}.${callback}`,
        ).toBe(true);
      }
    }
  });

  it("writes geometry bounds and clears them through the native bridge while keeping id read-only", () => {
    const writes: unknown[][] = [];
    const runtime: IBrowserRuntime = {
      ...surfaceOnly(),
      construct: (name) => ({ key: name, type: runtime.typeId(name) }),
      set: (self, property, value) => void writes.push([self.key, property, value]),
    };
    const { classes: bound } = defineBrowserClasses(registry, runtime);
    const Geometry = bound.BufferGeometry as new () => Record<string, unknown>;
    const Sphere = bound.Sphere as new () => object;
    const Box3 = bound.Box3 as new () => object;
    const geometry = new Geometry();
    geometry.boundingSphere = new Sphere();
    geometry.boundingBox = new Box3();
    geometry.boundingSphere = null;
    geometry.boundingBox = null;
    expect(writes).toEqual([
      ["BufferGeometry", "boundingSphere", { key: "Sphere", type: runtime.typeId("Sphere") }],
      ["BufferGeometry", "boundingBox", { key: "Box3", type: runtime.typeId("Box3") }],
      ["BufferGeometry", "boundingSphere", null],
      ["BufferGeometry", "boundingBox", null],
    ]);
    expect(Reflect.set(geometry, "id", 42)).toBe(false);
    expect(Object.hasOwn(geometry, "boundingSphere")).toBe(false);
    expect(Object.hasOwn(geometry, "boundingBox")).toBe(false);
  });

  it("keeps mixer stats and nested counts stable while reading live snapshots", () => {
    let total = 1;
    const runtime: IBrowserRuntime = {
      ...surfaceOnly(),
      construct: (name) => ({ key: name, type: runtime.typeId(name) }),
      get: (_self, property) => {
        if (property !== "stats") throw new Error(`unexpected getter ${property}`);
        return {
          actions: { total, inUse: 1 },
          bindings: { total: 1, inUse: 1 },
          controlInterpolants: { total: 0, inUse: 0 },
        };
      },
    };
    const { classes: bound } = defineBrowserClasses(registry, runtime);
    const mixer = new (bound.AnimationMixer as new (...args: unknown[]) => object)({});
    const first = (mixer as { stats: object }).stats;
    const actions = (first as { actions: object }).actions;
    total = 2;
    expect((mixer as { stats: object }).stats).toBe(first);
    expect((first as { actions: object }).actions).toBe(actions);
    expect((actions as { total: number }).total).toBe(2);
    expect(Object.keys(actions)).toEqual(["total", "inUse"]);
    expect(Object.getOwnPropertyDescriptor(actions, "total")?.configurable).toBe(true);
    expect(JSON.stringify(first)).toContain('"total":2');
  });

  it("sends a write-only setter to the engine instead of keeping a JS property", () => {
    const writes: unknown[][] = [];
    const runtime: IBrowserRuntime = {
      ...surfaceOnly(),
      construct: (name) => ({ key: name, type: 1 }),
      set: (self, property, value) => {
        writes.push([self.key, property, value]);
      },
    };
    const { classes: recorded } = defineBrowserClasses(registry, runtime);
    const DataTexture = recorded.DataTexture as new () => { needsUpdate: boolean };
    const texture = new DataTexture();
    texture.needsUpdate = true;
    expect(writes).toEqual([["DataTexture", "needsUpdate", true]]);
    expect(Object.hasOwn(texture, "needsUpdate")).toBe(false);
  });

  it("refuses to construct a class the registry gives no constructor", () => {
    for (const [name, binding] of Object.entries(registry.classes)) {
      if (binding.constructor) continue;
      const cls = classes[name];
      expect(() => (cls === undefined ? undefined : new cls()), name).toThrow(
        /TN_BROWSER_NOT_CONSTRUCTIBLE/,
      );
    }
  });
});

type Typed =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

interface IAttribute {
  array: Typed;
  needsUpdate: boolean;
  getX(index: number): number;
  getY(index: number): number;
  getZ(index: number): number;
  setX(index: number, value: number): unknown;
  setY(index: number, value: number): unknown;
  setXYZ(index: number, x: number, y: number, z: number): unknown;
  copyAt(index: number, attribute: unknown, source: number): unknown;
}

interface IGeometry {
  setAttribute(name: string, attribute: unknown): unknown;
  getAttribute(name: string): IAttribute | null;
  applyMatrix4(matrix: unknown): unknown;
  translate(x: number, y: number, z: number): unknown;
}

// The typed array a value crossed as, by the marker `toEngine` puts on it: the mock keeps the same
// scalar type the Wasm ABI would, so a normalized integer attribute stays a Uint8Array end to end.
function typedName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const symbol of Object.getOwnPropertySymbols(value))
    if (symbol.description === "tn.typedArray") return (value as Record<symbol, string>)[symbol];
  return undefined;
}

function makeStore(name: string | undefined, values: readonly number[]): Typed {
  switch (name) {
    case "Uint8Array":
      return Uint8Array.from(values);
    case "Uint16Array":
      return Uint16Array.from(values);
    case "Uint32Array":
      return Uint32Array.from(values);
    case "Int8Array":
      return Int8Array.from(values);
    case "Int16Array":
      return Int16Array.from(values);
    case "Int32Array":
      return Int32Array.from(values);
    case "Float64Array":
      return Float64Array.from(values);
    default:
      return Float32Array.from(values);
  }
}

/**
 * PRD-617: an engine-side attribute write (`setY`, `setXYZ`, `copyAt`, a geometry transform) and a
 * direct game edit of the JS array must reflect the same logical data. three's `BufferAttribute`
 * keeps the typed array it is handed, so the Wasm facade adopts it as the JS shadow while the
 * engine's `BufferStore` stays canonical. The engine here mirrors that copy semantics: a store of
 * the handed scalar type, `attributeArray` a copy of a range, `attributeWrite` a range write, and
 * the setters and geometry transforms mutate the store. No GPU and no Wasm module.
 */
describe("BufferAttribute sync between the JS array and the engine, on the browser back end", () => {
  function engine() {
    const types = new Map<string, number>();
    const typeId = (name: string): number => {
      let id = types.get(name);
      if (id === undefined) {
        id = types.size + 1;
        types.set(name, id);
      }
      return id;
    };
    const stores = new Map<string, Typed>();
    const itemSizes = new Map<string, number>();
    const geometries = new Map<string, Map<string, IEngineRef>>();
    const matrices = new Map<string, readonly number[]>();
    const counts = { reads: 0, writes: 0 };
    let next = 0;
    const store = (self: IEngineRef): Typed => stores.get(self.key) ?? new Float32Array(0);
    const size = (self: IEngineRef): number => itemSizes.get(self.key) ?? 1;
    const at = (self: IEngineRef, index: number, component: number): number =>
      index * size(self) + component;
    const read = (self: IEngineRef, index: number, component: number): number =>
      store(self)[at(self, index, component)] as number;
    const write = (self: IEngineRef, index: number, component: number, value: number): void => {
      store(self)[at(self, index, component)] = value;
    };
    const shift = (geometry: IEngineRef, translation: readonly number[]): void => {
      const attribute = geometries.get(geometry.key)?.get("position");
      if (attribute === undefined) return;
      const data = store(attribute);
      const stride = size(attribute);
      for (let item = 0; item * stride + stride <= data.length; item++)
        for (let c = 0; c < 3 && c < stride; c++)
          data[item * stride + c] = (data[item * stride + c] as number) + (translation[c] ?? 0);
    };
    const geometryInvoke = (self: IEngineRef, method: string, args: EngineValue[]): EngineValue => {
      const attributes = geometries.get(self.key) as Map<string, IEngineRef>;
      const name = String(args[0]);
      switch (method) {
        case "setAttribute":
          attributes.set(name, args[1] as IEngineRef);
          return null;
        case "getAttribute":
          return attributes.get(name) ?? null;
        case "hasAttribute":
          return attributes.has(name);
        case "deleteAttribute":
          return attributes.delete(name);
        case "translate":
          shift(self, [Number(args[0]), Number(args[1]), Number(args[2])]);
          return null;
        case "applyMatrix4":
          shift(self, matrices.get((args[0] as IEngineRef).key) ?? [0, 0, 0]);
          return null;
        default:
          return null;
      }
    };
    const attributeInvoke = (
      self: IEngineRef,
      method: string,
      args: EngineValue[],
    ): EngineValue => {
      const index = Number(args[0]);
      switch (method) {
        case "getX":
          return read(self, index, 0);
        case "getY":
          return read(self, index, 1);
        case "getZ":
          return read(self, index, 2);
        case "getW":
          return read(self, index, 3);
        case "getComponent":
          return read(self, index, Number(args[1]));
        case "setX":
          write(self, index, 0, Number(args[1]));
          return null;
        case "setY":
          write(self, index, 1, Number(args[1]));
          return null;
        case "setZ":
          write(self, index, 2, Number(args[1]));
          return null;
        case "setW":
          write(self, index, 3, Number(args[1]));
          return null;
        case "setComponent":
          write(self, index, Number(args[1]), Number(args[2]));
          return null;
        case "setXY":
        case "setXYZ":
        case "setXYZW": {
          const lanes = method === "setXY" ? 2 : method === "setXYZ" ? 3 : 4;
          for (let c = 0; c < lanes; c++) write(self, index, c, Number(args[1 + c]));
          return null;
        }
        case "copyAt": {
          const source = args[1] as IEngineRef;
          for (let c = 0; c < size(self); c++)
            write(self, index, c, read(source, Number(args[2]), c));
          return null;
        }
        default:
          return null;
      }
    };
    const runtime: IBrowserRuntime = {
      typeId,
      construct(name, args) {
        const key = `${name}:0:${++next}:1`;
        const ref: IEngineRef = { key, type: typeId(name) };
        if (name.endsWith("Geometry")) {
          geometries.set(key, new Map());
          return ref;
        }
        if (name === "Matrix4") return ref;
        const handed = args[0];
        stores.set(
          key,
          makeStore(typedName(handed), Array.isArray(handed) ? (handed as number[]) : []),
        );
        itemSizes.set(key, Number(args[1]));
        return ref;
      },
      invoke(self, method, args): EngineValue {
        return geometries.has(self.key)
          ? geometryInvoke(self, method, args as EngineValue[])
          : attributeInvoke(self, method, args as EngineValue[]);
      },
      get(self, property): EngineValue {
        if (property === "__attributeNames") {
          const attributes = geometries.get(self.key);
          return attributes === undefined ? "" : [...attributes.keys()].join("\n");
        }
        if (property === "itemSize") return itemSizes.get(self.key) ?? 0;
        if (property === "count") {
          const stride = size(self);
          return stride === 0 ? 0 : store(self).length / stride;
        }
        return 0;
      },
      set() {},
      release() {},
      setCallback() {},
      // A copy of the attribute's data, or of a scalar subrange of it: the shadow is never a view.
      attributeArray: (self, offset, count) => {
        const from = offset ?? 0;
        const data = store(self);
        const copy = data.slice(from, count === undefined ? data.length : from + count) as Typed;
        counts.reads += copy.length;
        return copy;
      },
      // A range write into the store, as the engine copies a whole array or one item.
      attributeWrite: (self, array, offset = 0) => {
        store(self).set(array as never, offset);
        counts.writes += array.length;
      },
    };
    return { runtime, matrices, counts };
  }

  function facade() {
    const { runtime, matrices, counts } = engine();
    const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
    return { classes, matrices, counts };
  }

  function attributeClass(classes: Record<string, new (...args: never[]) => object>) {
    return classes.BufferAttribute as unknown as new (
      array: Typed,
      itemSize: number,
    ) => IAttribute;
  }

  it("keeps an engine setY that a later needsUpdate would clobber", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const handed = new Float32Array([0, 0, 0, 0, 0, 0]);
    const p = new Attribute(handed, 3);
    expect(p.array).toBe(handed);
    p.setY(1, 42);
    p.needsUpdate = true;
    expect(p.getY(1)).toBe(42);
    expect(p.array[4]).toBe(42);
  });

  it("keeps an engine setXYZ that a later needsUpdate would clobber", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const p = new Attribute(new Float32Array(9), 3);
    p.setXYZ(0, 1, 2, 3);
    p.needsUpdate = true;
    expect([p.getX(0), p.getY(0), p.getZ(0)]).toEqual([1, 2, 3]);
  });

  it("still sends a direct array edit to the engine on needsUpdate", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const p = new Attribute(new Float32Array([0, 0, 0]), 3);
    p.array[1] = 7;
    p.needsUpdate = true;
    expect(p.getY(0)).toBe(7);
  });

  it("keeps a handed-array edit when an unrelated attribute is written first", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const handedA = new Float32Array(3);
    const a = new Attribute(handedA, 3);
    const b = new Attribute(new Float32Array(3), 3);
    b.setY(0, 5);
    handedA[1] = 7;
    a.needsUpdate = true;
    expect(a.getY(0)).toBe(7);
  });

  it("keeps a retained array edit across an unrelated attribute write", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const a = new Attribute(new Float32Array(3), 3);
    const b = new Attribute(new Float32Array(3), 3);
    const arr = a.array;
    b.setY(0, 5);
    b.setY(1, 6);
    arr[1] = 9;
    a.needsUpdate = true;
    expect(a.getY(0)).toBe(9);
  });

  it("keeps an own-attribute setter write mixed with a later direct edit", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const a = new Attribute(new Float32Array(3), 3);
    a.setY(0, 5);
    a.array[1] = 9;
    a.needsUpdate = true;
    expect(a.getY(0)).toBe(9);
  });

  it("lets a game edit after an engine setY on the same component win", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const handed = new Float32Array([0, 0, 0, 0, 0, 0]);
    const p = new Attribute(handed, 3);
    p.setY(1, 42);
    handed[4] = 7;
    p.needsUpdate = true;
    expect(p.getY(1)).toBe(7);
    expect(p.array[4]).toBe(7);
  });

  it("lets an engine setter win over a game edit before it on the same component", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const handed = new Float32Array([0, 0, 0, 0, 0, 0]);
    const p = new Attribute(handed, 3);
    handed[4] = 7;
    p.setY(1, 42);
    p.needsUpdate = true;
    expect(p.getY(1)).toBe(42);
    expect(p.array[4]).toBe(42);
  });

  it("preserves an unrelated component when a setter meets a later game edit", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const handed = new Float32Array([0, 0, 0, 0, 0, 0]);
    const p = new Attribute(handed, 3);
    p.setY(1, 42);
    handed[3] = 7;
    p.needsUpdate = true;
    expect(p.getX(1)).toBe(7);
    expect(p.getY(1)).toBe(42);
  });

  it("copies only the range a setter wrote, so many setters stay linear", () => {
    const { classes, counts } = facade();
    const Attribute = attributeClass(classes);
    const p = new Attribute(new Float32Array(3000), 3);
    for (let i = 0; i < 300; i++) p.setY(i, i);
    p.needsUpdate = true;
    // One element read back per setter and one whole-array write, never a whole array per setter.
    expect(counts.reads).toBeLessThan(600);
    expect(counts.writes).toBeLessThan(6000);
    expect(counts.reads).toBeLessThan(300 * 3000);
  });

  it("sends copyAt's source item before the engine copies it", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const source = new Attribute(new Float32Array([1, 2, 3, 4, 5, 6]), 3);
    const destination = new Attribute(new Float32Array(6), 3);
    const s = source.array;
    s[1] = 9;
    destination.copyAt(1, source, 0);
    destination.needsUpdate = true;
    expect(destination.getY(1)).toBe(9);
  });

  it("preserves a normalized integer attribute's raw bytes and type", () => {
    const { classes } = facade();
    const Attribute = attributeClass(classes);
    const handed = new Uint8Array([0, 128, 255, 10, 20, 30]);
    const p = new Attribute(handed, 3);
    p.setY(0, 200);
    const array = p.array;
    expect(array).toBe(handed);
    expect(array).toBeInstanceOf(Uint8Array);
    expect(array[1]).toBe(200);
    array[1] = 7;
    p.needsUpdate = true;
    expect(p.getY(0)).toBe(7);
  });

  it("follows a geometry translate in a retained position array, both edits included", () => {
    const { classes } = facade();
    const Geometry = classes.BufferGeometry as unknown as new () => IGeometry;
    const Attribute = attributeClass(classes);
    const geometry = new Geometry();
    const position = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    geometry.setAttribute("position", new Attribute(position, 3));
    position[3] = 5;
    geometry.translate(1, 0, 0);
    expect(Array.from(position)).toEqual([1, 0, 0, 6, 0, 0, 1, 1, 0]);
    position[4] = 7;
    geometry.translate(0, 1, 0);
    expect(Array.from(position)).toEqual([1, 1, 0, 6, 8, 0, 1, 2, 0]);
  });

  it("follows a geometry applyMatrix4 in a retained position array", () => {
    const { classes, matrices } = facade();
    const Geometry = classes.BufferGeometry as unknown as new () => IGeometry;
    const Attribute = attributeClass(classes);
    const Matrix = classes.Matrix4 as unknown as new () => object;
    const geometry = new Geometry();
    const position = new Float32Array([0, 0, 0, 1, 0, 0]);
    geometry.setAttribute("position", new Attribute(position, 3));
    const matrix = new Matrix();
    const ref = engineRef(matrix) as IEngineRef;
    matrices.set(ref.key, [2, 3, 0]);
    geometry.applyMatrix4(matrix);
    expect(Array.from(position)).toEqual([2, 3, 0, 3, 3, 0]);
  });

  it("does not touch an unrelated attribute's shadow in a geometry transform", () => {
    const { classes } = facade();
    const Geometry = classes.BufferGeometry as unknown as new () => IGeometry;
    const Attribute = attributeClass(classes);
    const geometry = new Geometry();
    const position = new Float32Array([0, 0, 0]);
    geometry.setAttribute("position", new Attribute(position, 3));
    const uv = new Attribute(new Float32Array([0, 0]), 2);
    uv.needsUpdate = true;
    const before = uv.array[0];
    geometry.translate(1, 0, 0);
    expect(uv.array[0]).toBe(before);
  });

  // PRD-617: syncRange fails closed. A mutator's range comes from its own arguments, so a malformed
  // index is an error (not a silent read of element 0), and a provider that answers a required range
  // read short or not at all is a fault, never a silently stale shadow. A merely out-of-range index
  // is the engine's bounds no-op, so it syncs nothing.
  it("throws when a setter's index is malformed", () => {
    const { classes } = facade();
    const p = new (attributeClass(classes))(new Float32Array(6), 3);
    expect(() => p.setX(Number.NaN, 1)).toThrow(/TN_NATIVE_ATTRIBUTE_RANGE/);
    expect(() => p.setX(1.5, 1)).toThrow(/TN_NATIVE_ATTRIBUTE_RANGE/);
    expect(() => p.setX(-1, 1)).toThrow(/TN_NATIVE_ATTRIBUTE_RANGE/);
  });

  it("does not throw for an out-of-range index, which the engine ignores", () => {
    const { classes } = facade();
    const p = new (attributeClass(classes))(new Float32Array(3), 3);
    expect(() => p.setY(5, 1)).not.toThrow();
  });

  it("throws when the required range read comes back the wrong length", () => {
    const { runtime } = engine();
    runtime.attributeArray = () => new Float32Array(2);
    const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
    const p = new (attributeClass(classes))(new Float32Array(6), 3);
    expect(() => p.setY(0, 1)).toThrow(/TN_NATIVE_ATTRIBUTE_SYNC/);
  });

  it("throws when the required range read is missing", () => {
    const { runtime } = engine();
    runtime.attributeArray = undefined;
    const { classes } = defineBrowserClasses(registry, runtime, loadCatalog(REPO));
    const p = new (attributeClass(classes))(new Float32Array(6), 3);
    expect(() => p.setY(0, 1)).toThrow(/TN_NATIVE_ATTRIBUTE_SYNC/);
  });
});
