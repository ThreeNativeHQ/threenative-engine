/**
 * PRD-540: the language half of three's object surface on the browser back end. The catalog marks
 * these `native-not-bound` because they are JavaScript, not engine state: the class chain
 * (`mesh instanceof Object3D`), the `is*` flags, `userData`, and the `traverse` family over
 * `children`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type EngineValue,
  type IBrowserRuntime,
  type IEngineRef,
  type IRegistryDump,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const catalog = loadCatalog(REPO);
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as IRegistryDump;

/** A scene graph held by the fake engine: `children` answers each object's child refs. */
function sceneRuntime(children: Map<string, IEngineRef[]>, visible: Set<string>): IBrowserRuntime {
  const types = new Map<string, number>();
  let next = 0;
  return {
    typeId(name) {
      if (!types.has(name)) types.set(name, types.size + 1);
      return types.get(name) as number;
    },
    construct(name) {
      return { key: `${name}:0:${++next}:1`, type: types.get(name) ?? 0 };
    },
    // `__walk`: the engine's preorder walk of this graph, only visible subtrees when asked.
    invoke(self, method, args): EngineValue {
      if (method !== "__walk") return null;
      const walked: IEngineRef[] = [];
      const visit = (ref: IEngineRef) => {
        if (args[0] === true && !visible.has(ref.key)) return;
        walked.push(ref);
        for (const child of children.get(ref.key) ?? []) visit(child);
      };
      visit(self);
      return walked;
    },
    get(self, property): EngineValue {
      if (property === "children") return children.get(self.key) ?? [];
      if (property === "visible") return visible.has(self.key);
      if (property === "parent") return null;
      return 0;
    },
    set() {},
    release() {},
    setCallback() {},
  };
}

/** The registry without `children` (and the walk over it), as it was before the engine bound it. */
function withoutChildren(dump: IRegistryDump): IRegistryDump {
  return {
    classes: Object.fromEntries(
      Object.entries(dump.classes).map(([name, binding]) => [
        name,
        {
          ...binding,
          members: binding.members.filter((member) => member !== "children"),
          methods: binding.methods.filter((method) => method !== "__walk"),
        },
      ]),
    ),
  };
}

type Constructor = new (...args: unknown[]) => Record<string, unknown>;

describe("browser back end object surface", () => {
  it("chains classes as three does and carries three's is* flags", () => {
    const { classes } = defineBrowserClasses(registry, sceneRuntime(new Map(), new Set()), catalog);
    const mesh = new (classes.Mesh as Constructor)();
    expect(mesh instanceof (classes.Object3D as Constructor)).toBe(true);
    expect(mesh.isMesh).toBe(true);
    expect(mesh.isObject3D).toBe(true);
    expect(mesh.isMaterial).toBeUndefined();
    const material = new (classes.MeshStandardMaterial as Constructor)();
    expect(material.isMeshStandardMaterial && material.isMaterial).toBe(true);
  });

  it("keeps one userData object per engine object", () => {
    const { classes } = defineBrowserClasses(registry, sceneRuntime(new Map(), new Set()), catalog);
    const group = new (classes.Group as Constructor)();
    expect(group.userData).toEqual({});
    (group.userData as Record<string, unknown>).hp = 3;
    expect(group.userData).toEqual({ hp: 3 });
    group.userData = { team: "red" };
    expect(group.userData).toEqual({ team: "red" });
  });

  it("walks children depth first, and only visible subtrees for traverseVisible", () => {
    const children = new Map<string, IEngineRef[]>();
    const visible = new Set<string>();
    const runtime = sceneRuntime(children, visible);
    const { classes } = defineBrowserClasses(registry, runtime, catalog);
    const make = (name: string) => {
      const object = new (classes.Group as Constructor)();
      object.label = name;
      return object;
    };
    const [root, a, a1, b] = ["root", "a", "a1", "b"].map(make) as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const refOf = (object: Record<string, unknown>) =>
      Object.getOwnPropertySymbols(object).map(
        (s) => (object as Record<symbol, unknown>)[s],
      )[0] as IEngineRef;
    children.set(refOf(root).key, [refOf(a), refOf(b)]);
    children.set(refOf(a).key, [refOf(a1)]);
    for (const object of [root, a, b]) visible.add(refOf(object).key);

    const all: unknown[] = [];
    (root.traverse as (fn: (o: Record<string, unknown>) => void) => void)((o) => all.push(o.label));
    expect(all).toEqual(["root", "a", "a1", "b"]);
    visible.delete(refOf(a).key);
    const shown: unknown[] = [];
    (root.traverseVisible as (fn: (o: Record<string, unknown>) => void) => void)((o) =>
      shown.push(o.label),
    );
    expect(shown).toEqual(["root", "b"]);
  });

  it("refuses traverse on a class whose binding has no children", () => {
    const { classes } = defineBrowserClasses(
      withoutChildren(registry),
      sceneRuntime(new Map(), new Set()),
      catalog,
    );
    const group = new (classes.Group as Constructor)();
    expect(() => (group.traverse as (fn: () => void) => void)(() => {})).toThrow(
      "TN_BROWSER_UNBOUND: Group.children",
    );
  });
});
