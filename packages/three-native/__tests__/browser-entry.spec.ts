/**
 * PRD-540 phase 1: under `engine: "threenative"` every upstream `three*` export name is bound to an
 * engine class or a catalog constant, or throws its catalog diagnostic on first use. None resolves
 * to upstream three.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import * as audioBinding from "../src/audio.js";
import * as backend from "../src/browser-backend.js";
import { bindUpstreamExports, bindWebEngine } from "../src/browser-entry.js";
import * as rendererBinding from "../src/browser-renderer.js";
import * as tslBinding from "../src/browser-tsl.js";
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
    // Defining a subclass is not a use: core declares `class VirtualShadowNode extends ShadowBaseNode`
    // at module scope, and every game imports core. Constructing one is.
    const Pipeline = bound.RenderPipeline as new () => object;
    class Sub extends Pipeline {}
    expect(() => new Sub()).toThrow("TN_NATIVE_UNSUPPORTED_RENDERPIPELINE");
    expect(() => (bound.RenderPipeline as { render: unknown }).render).toThrow(
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

describe("web engine nested render safe points", () => {
  it("keeps collection and audio outermost while syncing mutable uniforms on every draw and recovering from failure", async () => {
    let next = 0;
    const setUniform = vi.fn();
    const tslRuntime: tslBinding.ITslRuntime = {
      call: () => ++next,
      release() {},
      set() {},
      setUniform,
      effectParameter: () => 0,
      setPost() {},
      compute() {},
      readStorage: async () => new ArrayBuffer(0),
      deleteStorage() {},
    };
    const types = new Map<string, number>();
    const runtime: backend.IBrowserRuntime = {
      typeId: (name) => types.get(name) ?? types.set(name, types.size + 1).get(name) ?? 0,
      construct: () => ({ key: `${++next}:0:1:1`, type: 1 }),
      invoke: () => null,
      get: () => undefined,
      set() {},
      release() {},
      setCallback() {},
      tsl: tslRuntime,
    };
    const bindings = backend.defineBrowserClasses(
      registry as backend.IRegistryDump,
      runtime,
      catalog,
    );
    const collect = vi.fn(bindings.collect);
    const audio = audioBinding.defineAudioClasses(bindings.classes as never);
    const updateAudio = vi.fn(audio.updateAudio);
    const tsl = tslBinding.defineTsl(tslRuntime);
    const uniform = (
      tsl.exports.uniform as (value: { isVector2: boolean; x: number; y: number }) => {
        value: { x: number; y: number };
      }
    )({ isVector2: true, x: 0, y: 0 });
    const originalSync = tsl.sync;
    let renderHook: NonNullable<Parameters<typeof rendererBinding.defineWebRenderer>[2]> = () => {
      throw new Error("Renderer callback was not installed");
    };
    let nested = false;
    const sync = vi.spyOn(tsl, "sync").mockImplementation((frame) => {
      if (!nested) {
        nested = true;
        try {
          for (let value = 1; value <= 5; value++) {
            uniform.value.x = value;
            renderHook(frame);
          }
        } finally {
          nested = false;
        }
      }
      originalSync(frame);
    });
    try {
      vi.spyOn(backend, "createWasmRuntime").mockReturnValue(runtime);
      vi.spyOn(backend, "defineBrowserClasses").mockReturnValue({ ...bindings, collect });
      vi.spyOn(audioBinding, "defineAudioClasses").mockReturnValue({ ...audio, updateAudio });
      vi.spyOn(tslBinding, "defineTsl").mockReturnValue(tsl);
      vi.spyOn(rendererBinding, "isWebHostModule").mockReturnValue(true);
      vi.spyOn(rendererBinding, "defineWebRenderer").mockImplementation((...args) => {
        if (args[2] === undefined) throw new Error("Renderer callback is missing");
        renderHook = args[2];
        return class {} as ReturnType<typeof rendererBinding.defineWebRenderer>;
      });
      await bindWebEngine(async () => ({}) as backend.TnAbiModule, []);
      setUniform.mockClear();
      renderHook({ renderer: {}, frameId: 0 });
      expect(collect).toHaveBeenCalledTimes(1);
      expect(updateAudio).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledTimes(6);
      // The outer sync finds x already at 5: an unchanged value is not written again.
      expect(setUniform.mock.calls.map(([, lanes]) => lanes[0])).toEqual([1, 2, 3, 4, 5]);
      sync.mockImplementationOnce(() => {
        throw new Error("meter draw failed");
      });
      expect(() => renderHook({ renderer: {}, frameId: 1 })).toThrow("meter draw failed");
      renderHook({ renderer: {}, frameId: 2 });
      expect(collect).toHaveBeenCalledTimes(3);
      expect(updateAudio).toHaveBeenCalledTimes(2);
      expect(sync).toHaveBeenCalledTimes(13);
      // A second draw in the same renderer frame (a post pass) syncs uniforms but does not collect again.
      renderHook({ renderer: {}, frameId: 2 });
      // A compute dispatch passes no frame; it belongs to the frame already collected.
      renderHook();
      expect(collect).toHaveBeenCalledTimes(3);
      expect(updateAudio).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
