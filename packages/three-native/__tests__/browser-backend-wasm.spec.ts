import { expect, it, vi } from "vitest";

import {
  type IBrowserRuntime,
  type IEngineRef,
  defineBrowserClasses,
} from "../src/browser-backend.js";

it.each([true, false])("preserves only node labels across visibility writes (node=%s)", (node) => {
  const original = { key: "material:1", type: 2 };
  const replacement = { key: "material:2", type: 2 };
  let material: IEngineRef = original;
  let visible = true;
  const get = vi.fn<IBrowserRuntime["get"]>((_self, path) =>
    path === "material" ? material : visible,
  );
  const runtime: IBrowserRuntime = {
    typeId: (name) => (name === "Mesh" ? 1 : 2),
    construct: () => ({ key: "mesh", type: 1 }),
    get,
    set: (_self, path, value) => {
      if (path === "material") material = value as IEngineRef;
      else visible = value as boolean;
    },
    invoke: () => null,
    release: () => {},
    setCallback: () => {},
  };
  const binding = {
    constructor: true,
    methods: [],
    getters: ["material", "visible"],
    setters: ["material", "visible"],
    members: [],
    callbacks: [],
  };
  const engine = defineBrowserClasses(
    { classes: { Mesh: { ...binding, methods: node ? ["__walk"] : [] }, Material: binding } },
    runtime,
  );
  const Mesh = engine.classes.Mesh as new () => { material: object; visible: boolean };
  const mesh = new Mesh();
  const first = mesh.material;
  get.mockClear();
  for (const value of [false, true, false]) {
    mesh.visible = value;
    expect(mesh.visible).toBe(value);
    expect(mesh.material).toBe(first);
  }
  expect(get.mock.calls.filter(([, path]) => path === "material")).toHaveLength(node ? 0 : 3);
  get.mockClear();
  mesh.material = engine.wrap(replacement);
  expect(mesh.material).toBe(engine.wrap(replacement));
  expect(mesh.material).not.toBe(first);
  expect(get.mock.calls.filter(([, path]) => path === "material")).toHaveLength(1);
});
