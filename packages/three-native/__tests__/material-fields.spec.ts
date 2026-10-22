/**
 * A material's fields are enumerable.
 *
 * In three a material keeps its slots as fields, so `for...in` finds them: core's node-twin copy loops
 * and the starter's current-visibility replay rely on it. The browser back end put them on the prototype
 * and left them hidden, so on the web every one of those loops saw an empty material. They are now
 * enumerable on the prototype. A build defines nothing on the instance (12 us for 40 own accessors, 4 us
 * for none), so `Object.keys` and `JSON.stringify` see no field on the web; `for...in` is the way to walk one.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { MeshStandardMaterial as ThreeStandardMaterial } from "three";
import { describe, expect, it, vi } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";

const registry = JSON.parse(
  readFileSync(path.join(process.cwd(), "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

/** Answers 0 for a number, and one stable object for a colour, a texture or a mesh's material. */
function runtime(log: string[] = []): IBrowserRuntime {
  const ids = new Map<string, number>();
  const typeId = (name: string): number => {
    if (!ids.has(name)) ids.set(name, ids.size + 1);
    return ids.get(name) as number;
  };
  let serial = 0;
  const ref = (type: string): IEngineRef => ({
    key: `${type}:0:${++serial}:1`,
    type: typeId(type),
  });
  const objects = new Map<string, IEngineRef>();
  const OBJECTS: Record<string, string> = {
    color: "Color",
    emissive: "Color",
    map: "Texture",
    material: "MeshStandardMaterial",
  };
  return {
    typeId,
    construct: (name) => ref(name),
    invoke: () => null,
    get(self, property): EngineValue {
      log.push(`get ${property}`);
      const type = OBJECTS[property];
      if (type === undefined) return 0;
      const key = `${self.key}.${property}`;
      if (!objects.has(key)) objects.set(key, ref(type));
      return objects.get(key) as IEngineRef;
    },
    set(_self, property) {
      log.push(`set ${property}`);
    },
    release() {},
    setCallback() {},
  };
}

type Constructible = new () => object;
const classesOf = (log?: string[]) => defineBrowserClasses(registry, runtime(log)).classes;

/** The names `for...in` reaches, as a copy loop sees them. */
function forIn(value: object): string[] {
  const keys: string[] = [];
  for (const key in value) keys.push(key);
  return keys;
}

/** A field's descriptor wherever it sits on the chain: the instance or a prototype. */
function descriptorOf(value: object, key: string): PropertyDescriptor | undefined {
  for (let o: object | null = value; o !== null; o = Object.getPrototypeOf(o) as object | null) {
    const found = Object.getOwnPropertyDescriptor(o, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** What the engine reads of a class: its getters and members, minus a dotted path and a method. */
function readable(name: string): string[] {
  const binding = registry.classes[name];
  if (binding === undefined) throw new Error(`${name} is not in the registry`);
  return [...binding.getters, ...binding.members].filter(
    (key) =>
      !key.includes(".") &&
      !binding.methods.includes(key) &&
      // A node slot (`colorNode`) is no value field. It is a graph, set through the TSL runtime.
      !(name.endsWith("NodeMaterial") && /^[a-z]+Node$/u.test(key)),
  );
}

const MATERIALS = Object.keys(registry.classes).filter((name) => name.endsWith("Material"));

/** Fields the engine adds to a material that three has not: a new one needs a line here and a reason. */
const ENGINE_FIELDS = ["twoSidedFoliage"];

describe("a native material's fields are enumerable", () => {
  it("covers the material classes of the registry", () => {
    expect(MATERIALS).toContain("MeshStandardMaterial");
    expect(MATERIALS).toContain("MeshStandardNodeMaterial");
  });

  it.each(MATERIALS)("%s: for...in lists the fields the engine reads", (name) => {
    const material = new (classesOf()[name] as Constructible)();
    expect(forIn(material).sort()).toEqual(readable(name).sort());
  });

  it.each(MATERIALS)("%s: a build defines no property on the instance", (name) => {
    const Material = classesOf()[name] as Constructible;
    const spy = vi.spyOn(Object, "defineProperty");
    try {
      const material = new Material();
      expect(spy.mock.calls.filter((call) => call[0] === material)).toEqual([]);
      expect(Object.keys(material)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  it("lists three's own field names and the engine's own fields, nothing else", () => {
    const material = new (classesOf().MeshStandardMaterial as Constructible)();
    const three = new ThreeStandardMaterial();
    const names = forIn(material);
    // Every name is one three has, as a field or as an accessor, or an engine field named here.
    expect(names.filter((key) => !(key in three) && !ENGINE_FIELDS.includes(key))).toEqual([]);
    // Every field three enumerates that the engine implements is listed.
    const threeFields = new Set(forIn(three));
    expect(names).toEqual(
      expect.arrayContaining(
        readable("MeshStandardMaterial").filter((key) => threeFields.has(key)),
      ),
    );
    expect(names).toEqual(
      expect.arrayContaining(["color", "roughness", "metalness", "emissive", "opacity", "map"]),
    );
  });

  it("keeps the methods, the write-only setter and the shader-node slots off the list", () => {
    const classes = classesOf();
    const standard = new (classes.MeshStandardMaterial as Constructible)();
    expect(forIn(standard)).not.toContain("clone");
    expect(forIn(standard)).not.toContain("copy");
    expect(forIn(standard)).not.toContain("dispose");
    // three's `needsUpdate` is a setter on the prototype, never a listed field.
    expect(forIn(standard)).not.toContain("needsUpdate");
    const node = new (classes.MeshStandardNodeMaterial as Constructible)();
    expect(forIn(node)).not.toContain("colorNode");
    expect(forIn(node)).toContain("roughness");
    expect("colorNode" in node).toBe(true);
  });

  it("reads and writes through the engine, with each field an enumerable accessor of the prototype", () => {
    const log: string[] = [];
    const material = new (classesOf(log).MeshStandardMaterial as Constructible)() as Record<
      string,
      unknown
    >;
    const roughness = descriptorOf(material, "roughness");
    expect(roughness).toMatchObject({ enumerable: true, configurable: true });
    expect(typeof roughness?.get).toBe("function");
    expect(typeof roughness?.set).toBe("function");
    // The engine gives a material's id, type and uuid for reading only.
    expect(descriptorOf(material, "uuid")?.set).toBeUndefined();
    material.roughness = 0.4;
    void material.metalness;
    expect(log.filter((line) => /roughness|metalness/u.test(line))).toEqual([
      "set roughness",
      "get metalness",
    ]);
  });

  it("shares one getter and one setter across instances", () => {
    const Standard = classesOf().MeshStandardMaterial as Constructible;
    const first = descriptorOf(new Standard(), "roughness");
    const second = descriptorOf(new Standard(), "roughness");
    expect(first?.get).toBeDefined();
    expect(second?.get).toBe(first?.get);
    expect(second?.set).toBe(first?.set);
  });

  it("keeps the fields on a game's subclass of a native material, and its writes reach the engine", () => {
    const log: string[] = [];
    const Standard = classesOf(log).MeshStandardMaterial as new () => Record<string, unknown>;
    class Glow extends Standard {
      constructor() {
        super();
        this.emissiveIntensity = 2;
      }
    }
    const glow = new Glow();
    expect(forIn(glow).sort()).toEqual(readable("MeshStandardMaterial").sort());
    expect(log).toContain("set emissiveIntensity");
  });

  it("lets a three-style copy loop copy one native material onto another", () => {
    const log: string[] = [];
    const Standard = classesOf(log).MeshStandardMaterial as Constructible;
    const source = new Standard();
    const target = new Standard();
    log.length = 0;
    // The loop core's node twins and the starter's current-visibility replay run over a source.
    for (const key in source) Reflect.set(target, key, Reflect.get(source, key));
    const sets = log.filter((line) => line.startsWith("set ")).map((line) => line.slice(4));
    for (const field of ["color", "roughness", "metalness", "opacity", "transparent", "map"])
      expect(sets, field).toContain(field);
    // A field the engine reads and never writes is skipped by Reflect.set, not thrown over.
    for (const field of ["id", "uuid", "type"]) expect(sets, field).not.toContain(field);
    expect(sets).toHaveLength(
      readable("MeshStandardMaterial").filter((key) =>
        registry.classes.MeshStandardMaterial?.setters.includes(key),
      ).length,
    );
  });

  it("lets a for...in dispose loop find a material's texture", () => {
    const material = new (classesOf().MeshStandardMaterial as Constructible)() as {
      map: object;
    };
    expect(material.map).toBeTypeOf("object");
    const found = forIn(material).map((key) => (material as Record<string, unknown>)[key]);
    expect(found).toContain(material.map);
  });

  it("gives a material the engine hands out the same fields as one a game constructs", () => {
    const mesh = new (classesOf().Mesh as Constructible)() as { material: object };
    expect(forIn(mesh.material).sort()).toEqual(readable("MeshStandardMaterial").sort());
  });

  it("serialises to JSON without a throw, and lists no field", () => {
    const material = new (classesOf().MeshStandardMaterial as Constructible)();
    expect(JSON.stringify(material)).toBe("{}");
  });

  it("applies a parameters object key by key, as three's setValues does", () => {
    const log: string[] = [];
    const Standard = classesOf(log).MeshStandardMaterial as new (values: object) => object;
    log.length = 0;
    new Standard({ roughness: 0.5, metalness: 0.25, transparent: true });
    expect(log.filter((line) => line.startsWith("set "))).toEqual([
      "set roughness",
      "set metalness",
      "set transparent",
    ]);
  });

  it("sends needsUpdate to the engine, and clone and copy run there", () => {
    const calls: string[] = [];
    const base = runtime();
    const classes = defineBrowserClasses(registry, {
      ...base,
      invoke: (self, method, args) => {
        calls.push(method);
        return base.invoke(self, method, args);
      },
      set: (self, property, value) => {
        calls.push(`set ${property}`);
        base.set(self, property, value);
      },
    }).classes;
    const material = new (classes.MeshStandardMaterial as Constructible)() as {
      needsUpdate: boolean;
      clone(): unknown;
      copy(other: unknown): unknown;
    };
    material.needsUpdate = true;
    material.clone();
    material.copy(material);
    expect(calls).toEqual(["set needsUpdate", "clone", "copy"]);
  });

  it("leaves a class that is not a material with no own fields", () => {
    const classes = classesOf();
    expect(Object.keys(new (classes.Mesh as Constructible)())).toEqual([]);
    expect(Object.keys(new (classes.BoxGeometry as Constructible)())).toEqual([]);
  });
});
