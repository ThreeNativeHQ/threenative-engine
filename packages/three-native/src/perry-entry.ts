/** The browser facade over native C calls; no separate set of three classes. */
import catalog from "../api/catalog.json" with { type: "json" };
import registry from "../api/native-registry.json" with { type: "json" };
import { type IAudioEngine, defineAudioClasses } from "./audio.js";
import { type IRegistryDump, defineBrowserClasses } from "./browser-backend.js";
import { bindUpstreamExports, defineRenderPipeline, withTextureSources } from "./browser-entry.js";
import { defineTsl } from "./browser-tsl.js";
import type { ICatalog } from "./catalog.js";
import { Material, defineObjectSurface, defineTypeFlags } from "./object-surface.js";
import { definePass } from "./pass-node.js";
import { definePerryRenderer } from "./perry-renderer.js";
import { createPerryRuntime } from "./perry-transport.js";
import { definePropertyBinding } from "./property-binding.js";
import { defineQuadMesh } from "./quad-mesh.js";
import { defineReflector } from "./reflector.js";

export function bindPerryEngine(names: readonly string[]): Record<string, unknown> {
  const runtime = createPerryRuntime();
  const engine = defineBrowserClasses(
    registry as IRegistryDump,
    runtime,
    catalog as unknown as ICatalog,
    true,
  );
  const { classes } = engine;
  const Color = classes.Color as new (color: unknown) => { r: number; g: number; b: number };
  defineTypeFlags(classes);
  defineObjectSurface({
    bufferGeometry: classes.BufferGeometry as never,
    geometries: Object.values(classes).filter(
      (cls) => cls !== classes.BufferGeometry && Object.hasOwn(cls.prototype, "setAttribute"),
    ) as never,
    shape: classes.Shape as never,
    materials: catalog.entries
      .filter((entry) => entry.kind === "class" && entry.extends === "Material")
      .map((entry) => classes[entry.name])
      .filter(Boolean) as never,
  });
  if (runtime.tsl === undefined) throw new Error("TN_PERRY_TSL_MISSING");
  const tsl = defineTsl(runtime.tsl, classes as never);
  const bound = { ...withTextureSources(classes, runtime), ...tsl.exports };
  const target: { scene?: unknown; camera?: unknown } = {};
  bound.RenderPipeline = defineRenderPipeline(runtime.tsl, target);
  Object.assign(
    bound,
    definePass(tsl.exports as never, (scene, camera) => {
      target.scene = scene;
      target.camera = camera;
    }),
  );
  const audio = defineAudioClasses({
    ...(classes as unknown as Omit<IAudioEngine, "read">),
    read: async (url) => {
      const response = await globalThis.fetch(url);
      if (!response.ok) throw new Error(`TN_AUDIO_FETCH: ${String(response.status)} ${url}`);
      return response.arrayBuffer();
    },
  });
  const { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader } = audio;
  Object.assign(bound, { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader });
  bound.Material = Material;
  Object.assign(bound, definePropertyBinding(classes.PropertyBinding as never));
  bound.QuadMesh = defineQuadMesh(classes as never);
  bound.reflector = defineReflector(
    tsl.exports.reflector as (...args: unknown[]) => object,
    classes as never,
  );
  bound.WebGPURenderer = definePerryRenderer({
    color: Color,
    sync: () => {
      engine.collect();
      tsl.sync();
      audio.updateAudio();
    },
    render: runtime.render,
  });
  // Only the bound classes: a refused export throws on any read.
  for (const value of Object.values(bound))
    if (typeof value === "function" && typeof value.prototype === "object") exactInstanceof(value);
  const exports = bindUpstreamExports(names, catalog as unknown as ICatalog, bound);
  return {
    ...exports,
    __tnTsl: tsl.exports,
    __tnLoadAsset: (kind: number, source: string | Uint8Array, type?: number) =>
      runtime.loadAsset(kind, source, type).map(engine.wrap),
  };
}

// Perry answers `instanceof` by the class a value was compiled from, so every engine class (one
// factory `class`) matches every other and none matches `Material`; the prototype chain is three's
// answer. A function owns the capture: Perry gives a static member no closure.
function exactInstanceof(cls: { prototype: object }): void {
  Object.defineProperty(cls, Symbol.hasInstance, {
    configurable: true,
    value: (value: unknown) => {
      if (typeof value !== "object" || value === null) return false;
      for (
        let link = Object.getPrototypeOf(value);
        link !== null;
        link = Object.getPrototypeOf(link)
      )
        if (link === cls.prototype) return true;
      return false;
    },
  });
}
