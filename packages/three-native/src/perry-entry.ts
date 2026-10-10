/** The browser facade over native C calls; no separate set of three classes. */
import catalog from "../api/catalog.json" with { type: "json" };
import registry from "../api/native-registry.json" with { type: "json" };
import { type IRegistryDump, defineBrowserClasses, engineRef } from "./browser-backend.js";
import { bindUpstreamExports, withTextureSources } from "./browser-entry.js";
import { defineTsl } from "./browser-tsl.js";
import type { ICatalog } from "./catalog.js";
import { Material, defineObjectSurface, defineTypeFlags } from "./object-surface.js";
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
  bound.Material = Material;
  Object.assign(bound, definePropertyBinding(classes.PropertyBinding as never));
  bound.QuadMesh = defineQuadMesh(classes as never);
  bound.reflector = defineReflector(
    tsl.exports.reflector as (...args: unknown[]) => object,
    classes as never,
  );
  bound.WebGPURenderer = class WebGPURenderer {
    readonly isWebGPURenderer = true;
    readonly domElement: HTMLCanvasElement;
    readonly shadowMap = { enabled: false, type: 1 };
    constructor(options: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement =
        options.canvas ?? ({ width: 300, height: 150, style: {} } as HTMLCanvasElement);
    }
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "srgb";
    private width = 300;
    private height = 150;
    private disposed = false;
    private clear: [number, number, number, number] = [0, 0, 0, 1];
    setClearColor(color: unknown, alpha = 1): void {
      const value = (typeof color === "object" && color !== null ? color : new Color(color)) as {
        r: number;
        g: number;
        b: number;
      };
      if (![value.r, value.g, value.b, alpha].every(Number.isFinite))
        throw new TypeError("TN_PERRY_RENDER_CLEAR_COLOR");
      this.clear = [value.r, value.g, value.b, alpha];
    }
    getClearAlpha(): number {
      return this.clear[3];
    }
    setClearAlpha(alpha: number): void {
      if (!Number.isFinite(alpha)) throw new TypeError("TN_PERRY_RENDER_CLEAR_ALPHA");
      this.clear[3] = alpha;
    }
    setSize(width: number, height: number): void {
      if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
        throw new RangeError("TN_PERRY_RENDER_SIZE");
      this.width = width;
      this.height = height;
    }
    async init(): Promise<void> {
      if (this.disposed) throw new Error("TN_PERRY_RENDER_DISPOSED");
    }
    render(scene: unknown, camera: unknown): void {
      if (this.disposed) throw new Error("TN_PERRY_RENDER_DISPOSED");
      if (this.outputColorSpace !== "srgb" && this.outputColorSpace !== "srgb-linear")
        throw new TypeError("TN_PERRY_RENDER_COLOR_SPACE");
      if (
        typeof scene !== "object" ||
        scene === null ||
        typeof camera !== "object" ||
        camera === null
      )
        throw new TypeError("TN_PERRY_RENDER_ARGUMENT");
      const sceneRef = engineRef(scene);
      const cameraRef = engineRef(camera);
      if (sceneRef === undefined || cameraRef === undefined)
        throw new TypeError("TN_PERRY_RENDER_ARGUMENT");
      engine.collect();
      tsl.sync();
      runtime.render(
        sceneRef,
        cameraRef,
        this.width,
        this.height,
        this.toneMapping,
        this.toneMappingExposure,
        this.outputColorSpace === "srgb",
        this.clear,
      );
    }
    dispose(): void {
      this.disposed = true;
    }
  };
  return {
    ...bindUpstreamExports(names, catalog as unknown as ICatalog, bound),
    __tnTsl: tsl.exports,
    __tnLoadAsset: (kind: number, source: string | Uint8Array, type?: number) =>
      runtime.loadAsset(kind, source, type).map(engine.wrap),
  };
}
