/**
 * PRD-532: the browser-JS back end covers every catalog entry marked supported, and nothing else.
 *
 * The back end builds its classes from the registry snapshot, and `catalog-registry.spec.ts` proves
 * that snapshot equals the catalog's supported set; this spec proves the classes the back end
 * defines carry exactly that surface. The runtime here refuses every call, so only the surface is
 * under test; `native_engine_wasm_browser_backend` drives the same classes over the Wasm ABI.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type IBrowserRuntime,
  type IRegistryDump,
  LANGUAGE_MEMBERS,
  defineBrowserClasses,
} from "../src/browser-backend.js";
import { type ICatalogClassEntry, loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
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
  const { classes } = defineBrowserClasses(registry, surfaceOnly());

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
      const exposed = Object.getOwnPropertyNames(prototype).filter((key) => key !== "constructor");
      // PRD-540: scene-graph classes also carry the JavaScript-side members (browser-surface.spec.ts).
      const language: readonly string[] = binding.members.includes("parent")
        ? LANGUAGE_MEMBERS
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
      ]);
      expect(exposed.sort(), name).toEqual([...expected].sort());
      for (const key of exposed) {
        const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
        if (
          descriptor?.get === undefined ||
          binding.callbacks.includes(key) ||
          language.includes(key)
        )
          continue;
        expect(descriptor.set !== undefined, `${name}.${key} settable`).toBe(
          binding.setters.includes(key),
        );
      }
    }
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
