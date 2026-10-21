/**
 * A material's fields are enumerable.
 *
 * In three a material keeps its slots as own, enumerable fields, so `for...in`, `Object.keys` and
 * `Object.values(material)` find them: core's node-twin copy loops, the uniform-group signature, the
 * cell-proxy descriptor and the usual "dispose every texture" idiom all rely on it. The desktop host
 * puts each material's accessors on the instance for that reason. The browser back end put them on the
 * prototype and left them hidden, so on the web every one of those loops saw an empty material.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { MeshStandardMaterial as ThreeStandardMaterial } from "three";
import { describe, expect, it } from "vitest";

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

describe("a native material's fields are enumerable", () => {
  it("covers the material classes of the registry", () => {
    expect(MATERIALS).toContain("MeshStandardMaterial");
    expect(MATERIALS).toContain("MeshStandardNodeMaterial");
  });

  it.each(MATERIALS)("%s: for...in lists the fields the engine reads", (name) => {
    const material = new (classesOf()[name] as Constructible)();
    expect(forIn(material).sort()).toEqual(readable(name).sort());
  });

  it.each(MATERIALS)("%s: the fields are the material's own, so Object.keys finds them", (name) => {
    const material = new (classesOf()[name] as Constructible)();
    expect(Object.keys(material).sort()).toEqual(readable(name).sort());
  });

  it("lists three's own field names and no name three does not know", () => {
    const material = new (classesOf().MeshStandardMaterial as Constructible)();
    const three = new ThreeStandardMaterial();
    const names = forIn(material);
    // Every name the engine reads is a name three has, as a field or as an accessor. The one exception is the
    // engine's Two Sided Foliage marker (PRD-651), which no three type declares.
    expect(names.filter((key) => !(key in three) && key !== "twoSidedFoliage")).toEqual([]);
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

  it("reads and writes through the engine, with each field an accessor of the instance", () => {
    const log: string[] = [];
    const material = new (classesOf(log).MeshStandardMaterial as Constructible)() as Record<
      string,
      unknown
    >;
    const roughness = Object.getOwnPropertyDescriptor(material, "roughness");
    expect(roughness).toMatchObject({ enumerable: true, configurable: true });
    expect(typeof roughness?.get).toBe("function");
    expect(typeof roughness?.set).toBe("function");
    // The engine gives a material's id, type and uuid for reading only.
    expect(Object.getOwnPropertyDescriptor(material, "uuid")?.set).toBeUndefined();
    material.roughness = 0.4;
    void material.metalness;
    expect(log.filter((line) => /roughness|metalness/u.test(line))).toEqual([
      "set roughness",
      "get metalness",
    ]);
  });

  it("shares one getter and one setter across instances, so materials keep one hidden class", () => {
    const Standard = classesOf().MeshStandardMaterial as Constructible;
    const first = Object.getOwnPropertyDescriptor(new Standard(), "roughness");
    const second = Object.getOwnPropertyDescriptor(new Standard(), "roughness");
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

  it("lets Object.values find a material's texture, so a dispose loop reaches it", () => {
    const material = new (classesOf().MeshStandardMaterial as Constructible)() as {
      map: object;
    };
    expect(material.map).toBeTypeOf("object");
    expect(Object.values(material)).toContain(material.map);
  });

  it("gives a material the engine hands out the same fields as one a game constructs", () => {
    const mesh = new (classesOf().Mesh as Constructible)() as { material: object };
    expect(Object.keys(mesh.material).sort()).toEqual(readable("MeshStandardMaterial").sort());
  });

  it("serialises to JSON without a throw", () => {
    const material = new (classesOf().MeshStandardMaterial as Constructible)();
    const json = JSON.parse(JSON.stringify(material)) as Record<string, unknown>;
    expect(json.roughness).toBe(0);
    expect(Object.keys(json)).toEqual(
      expect.arrayContaining(["roughness", "metalness", "opacity"]),
    );
  });

  it("leaves a class that is not a material with no own fields", () => {
    const classes = classesOf();
    expect(Object.keys(new (classes.Mesh as Constructible)())).toEqual([]);
    expect(Object.keys(new (classes.BoxGeometry as Constructible)())).toEqual([]);
  });
});
