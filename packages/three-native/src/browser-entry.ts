/**
 * What a web game's `three`, `three/webgpu` and `three/tsl` imports become under
 * `engine: "threenative"` (PRD-540): every upstream export name, bound to the Wasm engine or refused.
 *
 * Registry classes come from the browser-JS back end and catalog constants keep their values. Every
 * other name is a stub that throws its catalog diagnostic the moment it is called, constructed or
 * read through, so a game bundles and an unbound symbol fails loudly. Nothing here imports upstream
 * three, so no name can fall back to it.
 */
import catalogJson from "../api/catalog.json" with { type: "json" };
import registry from "../api/native-registry.json" with { type: "json" };
import { DataUtils } from "./addons/data-utils.js";
import { type IAudioEngine, defineAudioClasses } from "./audio.js";
import { BlendMode } from "./blend-mode.js";
import {
  type IBrowserRuntime,
  type IRegistryDump,
  TSL_NODE,
  type TnAbiModule,
  createWasmRuntime,
  defineBrowserClasses,
} from "./browser-backend.js";
import { ColorManagement } from "./browser-math.js";
import { RENDER_AGAIN, defineWebRenderer, isWebHostModule } from "./browser-renderer.js";
import { type ITslRuntime, defineTsl, isTslNode } from "./browser-tsl.js";
import type { CatalogEntry, ICatalog } from "./catalog.js";
import { withMathUtilsExtras } from "./math-utils.js";
import { Material, defineObjectSurface, defineTypeFlags } from "./object-surface.js";
import { type PassDraw, definePass } from "./pass-node.js";
import { definePropertyBinding } from "./property-binding.js";
import { defineQuadMesh } from "./quad-mesh.js";
import { defineReflector } from "./reflector.js";
import { defineRendererUtils } from "./renderer-utils.js";
import { ShadowBaseNode } from "./shadow-node.js";
import { ReadbackBuffer } from "./storage.js";
import { defineTextureSources } from "./texture-sources.js";

// quality-allow: the JSON import is typed by its literal values, which ICatalog does not accept.
const engineCatalog = catalogJson as unknown as ICatalog;

type PassUpdate = (surface: () => { width: number; height: number }, draw: PassDraw) => void;

const UPSTREAM_SOURCES = new Set(["three", "three/webgpu", "three/tsl"]);

/**
 * A value that throws `diagnostic` on any call, construction or property access. Its `prototype`
 * alone reads, so a module may declare a subclass (core's `VirtualShadowNode extends ShadowBaseNode`)
 * and fail only when it constructs one.
 */
function refused(name: string, diagnostic: string): unknown {
  const fail = (): never => {
    throw new Error(`${diagnostic}: ${name} is not available on the Wasm engine.`);
  };
  return new Proxy(function refusedExport() {}, {
    apply: fail,
    construct: fail,
    get: (target, key) => (key === "prototype" ? target.prototype : fail()),
    set: fail,
    has: fail,
    ownKeys: fail,
    getPrototypeOf: fail,
    defineProperty: fail,
    deleteProperty: fail,
    getOwnPropertyDescriptor: fail,
  });
}

function constantValue(entry: CatalogEntry): unknown {
  if (entry.kind !== "constant" || entry.status.kind === "unsupported") return undefined;
  return typeof entry.value === "string" ? JSON.parse(entry.value) : entry.value;
}

const NAMESPACES = new Set(["MathUtils", "SkeletonUtils"]);

/** Binds each upstream export name to an engine class, a catalog constant, or a refusal. */
export function bindUpstreamExports(
  names: readonly string[],
  catalog: Pick<ICatalog, "entries">,
  classes: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const entries = new Map(
    catalog.entries
      .filter((entry) => UPSTREAM_SOURCES.has(entry.source))
      .map((entry) => [entry.name, entry]),
  );
  const bound: Record<string, unknown> = {};
  for (const name of names) {
    const entry = entries.get(name);
    // three's MathUtils and SkeletonUtils are namespace objects: the engine binds each as a class,
    // exported as its one instance (as the V8 player's core-three.mjs does).
    if (Object.hasOwn(classes, name))
      bound[name] = NAMESPACES.has(name)
        ? new (classes[name] as new () => object)()
        : classes[name];
    else if (entry !== undefined && constantValue(entry) !== undefined)
      bound[name] = constantValue(entry);
    else
      bound[name] = refused(
        name,
        entry?.status.kind === "unsupported"
          ? entry.status.diagnostic
          : `TN_NATIVE_${entry === undefined ? "UNCATALOGUED" : "UNBOUND"}_${name.toUpperCase()}`,
      );
  }
  return bound;
}

/** Boots the Wasm module and returns every upstream export name bound over it. */
export async function bindWebEngine(
  createModule: () => Promise<TnAbiModule>,
  names: readonly string[],
): Promise<Record<string, unknown>> {
  const module = await createModule();
  // The engine's linear memory, for a bench page's memory report (`memory.buffer` survives growth).
  const memory = (module as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
  if (memory !== undefined)
    (globalThis as { __tnWasmMemoryBytes?: () => number }).__tnWasmMemoryBytes = () =>
      memory.buffer.byteLength;
  const runtime = createWasmRuntime(module);
  const { classes, wrap, collect, crossings } = defineBrowserClasses(
    registry as IRegistryDump,
    runtime,
    engineCatalog,
  );
  // Engine crossings so far, for a bench page's per-frame bridgeCalls (the pair's crossing budget).
  (globalThis as { __tnCrossingCount?: () => number }).__tnCrossingCount = crossings;
  defineTypeFlags(classes);
  // three's BatchedMesh/InstancedMesh.dispose frees the instance textures; the engine frees its instance
  // buffers with the object, so the call has nothing to release (core's projection mirror makes it).
  for (const name of ["BatchedMesh", "InstancedMesh"]) {
    const prototype = (classes[name] as { prototype: { dispose?: () => void } } | undefined)
      ?.prototype;
    if (prototype !== undefined) prototype.dispose ??= () => {};
  }
  // attributes/groups, shape.holes and the abstract Material, as on the V8 player (object-surface.ts).
  const entries = engineCatalog.entries;
  const extending = (base: string) =>
    entries
      .filter(
        (entry) =>
          entry.kind === "class" && entry.extends === base && classes[entry.name] !== undefined,
      )
      .map((entry) => classes[entry.name] as new (...args: never[]) => object);
  if (classes.BufferGeometry !== undefined)
    defineObjectSurface({
      bufferGeometry: classes.BufferGeometry,
      // Every geometry class that binds its own setAttribute, not only BufferGeometry's children.
      geometries: Object.values(classes).filter(
        (cls) => cls !== classes.BufferGeometry && Object.hasOwn(cls.prototype, "setAttribute"),
      ) as (new (
        ...args: never[]
      ) => object)[],
      ...(classes.Shape === undefined ? {} : { shape: classes.Shape }),
      materials: extending("Material"),
    });
  // TSL through the engine's shared name table (tn_tsl_call), when the module carries it.
  const tsl = runtime.tsl ? defineTsl(runtime.tsl, classes as never) : undefined;
  const bound: Record<string, unknown> = {
    ...withTextureSources(classes, runtime),
    ...tsl?.exports,
  };
  bound.RendererUtils = defineRendererUtils(classes.Color as never);
  bound.Material = Material;
  bound.ShadowBaseNode = ShadowBaseNode;
  bound.ReadbackBuffer = ReadbackBuffer;
  // three's PropertyBinding statics and console function over the engine class (shared with V8).
  if (classes.PropertyBinding !== undefined)
    Object.assign(bound, definePropertyBinding(classes.PropertyBinding as never));
  // three's audio classes over the engine Object3D and the page's WebAudio; the renderer pushes
  // world poses to WebAudio each frame, where three's own render calls updateMatrixWorld.
  const audio = defineAudioClasses({
    // quality-allow: the registry classes are read as the audio engine surface, which declares only the classes it uses.
    ...(classes as unknown as Omit<IAudioEngine, "read">),
    read: async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`TN_AUDIO_FETCH: ${String(response.status)} ${url}`);
      return response.arrayBuffer();
    },
  });
  const { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader } = audio;
  Object.assign(bound, { AudioContext, AudioListener, Audio, PositionalAudio, AudioLoader });
  // three's QuadMesh over the engine Mesh (quad-mesh.ts), shared with the V8 player.
  bound.QuadMesh = defineQuadMesh(classes as never);
  // three/webgpu's BlendMode, the record mrt().setBlendMode takes (data only, as on the engine's scene pass).
  bound.BlendMode = BlendMode;
  // The engine's four MathUtils functions, with the rest of three's number-only ones beside them.
  bound.MathUtils = withMathUtilsExtras(bound.MathUtils as new () => object);
  // Offscreen PassNodes (pass-node.ts) draw into their targets at the top of each frame; the TSL block below binds it.
  let drawSecondaryPasses: PassUpdate = () => {};
  // The product host draws; a module without it (the ABI-only test module) keeps the refusal.
  // Before each frame: edited Color/VectorN uniform values reach the engine, world poses WebAudio,
  // and the wrapper safe point runs (collect: held while the engine references them).
  // The safe point and the audio pose run once per renderer frame: collect asks a sixty-fourth of the
  // settled wrappers per call, sized for one call a frame, and a post chain renders about ten passes.
  let updating = false;
  let collectedFrame: number | undefined;
  if (isWebHostModule(module))
    bound.WebGPURenderer = defineWebRenderer(
      module,
      classes.Color as never,
      (frame) => {
        const frameId = frame?.frameId;
        if (updating || (frameId !== undefined && frameId === collectedFrame)) {
          tsl?.sync(frame);
          return;
        }
        collectedFrame = frameId;
        updating = true;
        try {
          collect();
          tsl?.sync(frame);
          audio.updateAudio();
        } finally {
          updating = false;
        }
      },
      runtime.tsl,
      (surface, draw) => drawSecondaryPasses(surface, draw),
      bound.DataTexture as never,
    );
  // A GLB through the engine's own glTF loader, for the web GLTFLoader (addons/gltf-loader-web.ts).
  const { loadGltf } = runtime;
  if (loadGltf !== undefined)
    bound.__tnLoadGltf = (bytes: Uint8Array, files?: ReadonlyMap<string, Uint8Array>) => {
      const loaded = loadGltf.call(runtime, bytes, files);
      return { scene: wrap(loaded.scene), animations: loaded.animations.map(wrap) };
    };
  if (tsl !== undefined && runtime.tsl !== undefined) {
    const native = tsl.exports.reflector as (...args: unknown[]) => object;
    bound.reflector = defineReflector(native, classes as never);
    // The engine's TSL functions three does not export by name (ao, bloom, ...), for the shared post
    // effects (addons/post-effects-web.ts), and three's RenderPipeline over the web host.
    bound.__tnTsl = tsl.exports;
    // three's pass() and mrt() over the engine's scene pass, as on the V8 player: RenderPipeline
    // draws the scene and camera the pass points at.
    const target: { scene?: unknown; camera?: unknown } = {};
    bound.RenderPipeline = defineRenderPipeline(runtime.tsl, target);
    const passes = definePass(
      tsl.exports as never,
      (scene, camera) => {
        target.scene = scene;
        target.camera = camera;
      },
      classes.RenderTarget === undefined
        ? undefined
        : // quality-allow: three's class name, so a back end passes its class map.
          // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
          { RenderTarget: classes.RenderTarget as never },
    );
    drawSecondaryPasses = passes.updateSecondaryPasses;
    Object.assign(bound, passes);
  }
  return bindUpstreamExports(names, engineCatalog, bound);
}

/**
 * The engine classes plus what plain JS adds over them: three's texture sources (typed array,
 * canvas, image, ImageBitmapLoader), `DataUtils`, and the `ColorManagement` singleton.
 */
export function withTextureSources(
  classes: Readonly<Record<string, unknown>>,
  runtime: IBrowserRuntime,
): Record<string, unknown> {
  return { ...classes, ...defineTextureSources(classes, runtime), DataUtils, ColorManagement };
}

interface IPipelineRenderer {
  [RENDER_AGAIN]?: () => void;
  render?(scene: unknown, camera: unknown): void;
}

/**
 * three's RenderPipeline on the Wasm engine, as on the V8 player: render() hands the output graph to
 * the web host, which draws it between the scene and the output, over the scene and camera the
 * graph's `pass(scene, camera)` points at (`target`), else the renderer's last scene.
 */
function defineRenderPipeline(tsl: ITslRuntime, target: { scene?: unknown; camera?: unknown }) {
  return class RenderPipeline {
    outputNode: unknown;
    outputColorTransform = true;
    readonly context: { onBeforeRenderPipeline?: () => void; onAfterRenderPipeline?: () => void } =
      {};
    private outputSource?: number;
    private outputGraph?: number;
    readonly renderer: IPipelineRenderer;

    constructor(renderer: IPipelineRenderer, outputNode?: unknown) {
      this.renderer = renderer;
      this.outputNode = outputNode;
    }

    render(): void {
      if (!isTslNode(this.outputNode))
        throw new TypeError("TN_WASM_POST: RenderPipeline.outputNode is not a TSL node");
      this.context.onBeforeRenderPipeline?.();
      try {
        tsl.setPost(this.graph(this.outputNode[TSL_NODE]));
        if (target.scene !== undefined && target.camera !== undefined && this.renderer.render)
          this.renderer.render(target.scene, target.camera);
        else this.renderer[RENDER_AGAIN]?.();
      } finally {
        this.context.onAfterRenderPipeline?.();
      }
    }

    private graph(source: number): number {
      if (this.outputSource !== source) {
        if (this.outputGraph !== undefined) tsl.release(this.outputGraph);
        this.outputSource = source;
        this.outputGraph = undefined;
      }
      if (!this.outputColorTransform)
        this.outputGraph ??= tsl.call("pipelineOutput", null, [
          { kind: "node", node: source },
          { kind: "number", number: 0 },
        ]);
      return this.outputColorTransform ? source : (this.outputGraph ?? source);
    }

    dispose(): void {
      tsl.setPost(null);
      if (this.outputGraph !== undefined) tsl.release(this.outputGraph);
      this.outputGraph = undefined;
    }
  };
}
