/**
 * PRD-540 phase 1: under `engine: "native"` every upstream `three*` export name is bound to an
 * engine class or a catalog constant, or throws its catalog diagnostic on first use. None resolves
 * to upstream three.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { bindUpstreamExports } from "../src/browser-entry.js";
import { type ICatalog, loadCatalog } from "../src/catalog.js";

const REPO = process.cwd();
const catalog: ICatalog = loadCatalog(REPO);
const registry = JSON.parse(
  readFileSync(path.join(REPO, "packages/three-native/api/native-registry.json"), "utf8"),
) as { classes: Record<string, unknown> };
// Stand-ins: the binding is under test here, the classes themselves in browser-backend-coverage.
const classes = Object.fromEntries(
  Object.keys(registry.classes).map((name) => [name, class {}] as const),
);

// Upstream three resolves from core, which depends on it; three-native does not.
const fromCore = createRequire(path.join(REPO, "packages/core/package.json"));
const upstream = Object.assign(
  {},
  ...(await Promise.all(
    ["three", "three/webgpu", "three/tsl"].map(
      (id) => import(pathToFileURL(fromCore.resolve(id)).href) as Promise<object>,
    ),
  )),
) as Record<string, unknown>;
const names = Object.keys(upstream).filter((name) => name !== "default");
const bound = bindUpstreamExports(names, catalog, classes);

describe("bindUpstreamExports", () => {
  it("binds every registry class and keeps catalog constant values", () => {
    // A class three does not export (DirectionalLightShadow is only ever `light.shadow`) has no
    // import name to bind; every class it does export binds to the engine's.
    const exported = Object.keys(classes).filter((name) => names.includes(name));
    expect(exported.length).toBeGreaterThan(0);
    // three's MathUtils and SkeletonUtils are namespace objects: the one instance of the engine class.
    for (const name of exported)
      if (name === "MathUtils" || name === "SkeletonUtils")
        expect(bound[name], name).toBeInstanceOf(classes[name] as new () => object);
      else expect(bound[name], name).toBe(classes[name]);
    expect(bound.ACESFilmicToneMapping).toBe(4);
    expect(bound.SRGBColorSpace).toBe("srgb");
  });

  it("throws the catalog diagnostic when an unbound export is used", () => {
    const Renderer = bound.WebGPURenderer as new () => unknown;
    expect(() => new Renderer()).toThrow("TN_NATIVE_UNSUPPORTED_WEBGPURENDERER");
    expect(() => (bound.pass as () => unknown)()).toThrow("TN_NATIVE_UNSUPPORTED_PASS");
    expect(() => (bound.RenderPipeline as { prototype: unknown }).prototype).toThrow(
      "TN_NATIVE_UNSUPPORTED_RENDERPIPELINE",
    );
    const uncatalogued = names.find(
      (name) => !catalog.entries.some((entry) => entry.name === name),
    );
    expect(uncatalogued).toBeDefined();
    expect(() => (bound[uncatalogued as string] as () => unknown)()).toThrow(
      `TN_NATIVE_UNCATALOGUED_${(uncatalogued as string).toUpperCase()}`,
    );
  });

  it("binds every upstream name, and none of them to upstream three", () => {
    expect(names.length).toBeGreaterThan(1000);
    // Compared by identity only: `expect` would inspect a refusal, and inspecting one throws.
    // A primitive constant equal by value is the same constant, not an upstream object.
    const missing = names.filter((name) => !Object.hasOwn(bound, name));
    const leaked = names.filter(
      (name) =>
        typeof upstream[name] !== "number" &&
        typeof upstream[name] !== "string" &&
        bound[name] === upstream[name],
    );
    expect({ missing, leaked }).toEqual({ missing: [], leaked: [] });
  });
});
