/**
 * `WebGPURenderer` on the Wasm engine (PRD-540): three's renderer surface over the product host
 * (`packages/runtime-native/src/engine/wasm/web_host.cpp`). The engine owns the device, the canvas
 * surface and every draw; this class turns three's calls into host calls and reports what the
 * engine did. What it does not implement throws its diagnostic rather than doing nothing.
 */
import { TSL_NODE, type TnAbiModule, engineRef } from "./browser-backend.js";
import { type ITslRuntime, defineTsl, isTslNode } from "./browser-tsl.js";
import { GPU_STAGES, SHADOW_SEGMENT_FIELD, SHADOW_STAGE } from "./gpu-stages.js";
import type { PassDraw } from "./pass-node.js";
import { defineRenderTargets, targetTexelBytes } from "./render-target.js";
import { ShadowMap } from "./shadow-map.js";
import { syncVirtualShadowLods } from "./shadow-node.js";
import { defineSphereReflectionCapture } from "./sphere-reflection-capture.js";
import { readStorageBytes } from "./storage.js";
import type { INodeFrame } from "./temp-node.js";
import { defineToneMappingLibrary } from "./tone-mapping.js";

/** The product host's exports beside the catalog ABI (all numbers: pointers, sizes, status). */
type HostCall =
  | "_tnw_web_init"
  | "_tnw_web_host_abi"
  | "_tnw_web_poll"
  | "_tnw_web_error"
  | "_tnw_web_adapter"
  | "_tnw_web_resize"
  | "_tnw_web_render"
  | "_tnw_web_compile_async"
  | "_tnw_web_compile_status"
  | "_tnw_web_renderer_state"
  | "_tnw_web_frame"
  | "_tnw_web_render_target"
  | "_tnw_web_read_target"
  | "_tnw_web_read_target_take"
  | "_tnw_web_capture_face"
  | "_tnw_web_threads";

export type WebHostModule = Record<HostCall, (...args: number[]) => number> & {
  readonly specialHTMLTargets: Record<string, unknown>;
};

export type WebEngineModule = TnAbiModule & WebHostModule;

export function isWebHostModule(module: TnAbiModule): module is WebEngineModule {
  return typeof (module as Partial<WebHostModule>)._tnw_web_init === "function";
}

/**
 * The tnw_* contract this facade speaks (web_host.cpp `kWebHostAbi`). Bump both on every tnw_*
 * signature change: web-host-abi.spec.ts pins the signatures per number, and a mismatch fails init.
 */
export const WEB_HOST_ABI = 5;

/** The canvas key the host's surface looks up; Emscripten resolves it before any DOM query. */
const CANVAS_TARGET = "!threenative-canvas";
const READY = 1;
/** The facade's own redraw, for RenderPipeline (browser-entry.ts). */
export const RENDER_AGAIN = Symbol("tn.renderAgain");
/** The last RenderPipeline's post graph install, which the warm-up entry points run first (browser-entry.ts). */
export const PIPELINE_POST = Symbol("tn.pipelinePost");
const DRAW_TARGET = Symbol("tn.drawTarget");
const FAILED = 2;
/**
 * `tnw_web_frame` field of the first named stage's segment (web_host.cpp): 19 + 4 shadow, scene, other and output
 * passes. `GPU_STAGES` counts on from there, one segment per stage.
 */
const GPU_STAGE_FIELD = 23;

interface IAdapterInfo {
  readonly vendor: string;
  readonly architecture: string;
  readonly description: string;
  readonly device: string;
}

interface IColorLike {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Resolves once compilation `id` (0: it never started) has built every pipeline; rejects naming the refusal. */
async function compiled(module: WebEngineModule, id: number): Promise<void> {
  const refused = (): Error => new Error(module.UTF8ToString(module._tnw_web_error()));
  if (id === 0) throw refused();
  for (;;) {
    const status = module._tnw_web_compile_status(id);
    if (status === 1) return;
    if (status < 0) throw refused();
    // A macrotask: the browser delivers the pipelines' completions between tasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function unsupported(name: string): never {
  throw new Error(`TN_NATIVE_UNSUPPORTED_${name.toUpperCase()}: not available on the Wasm engine.`);
}

/** Defines the renderer class over one loaded module; the module owns one device and one canvas. */
export function defineWebRenderer(
  module: WebEngineModule,
  Color: new (...args: unknown[]) => IColorLike,
  beforeRender: (frame?: INodeFrame) => void = () => {},
  tsl?: ITslRuntime,
  /** Draws the offscreen PassNodes into their targets (pass-node.ts); given the drawing buffer and the target draw. */
  drawSecondaryPasses: (
    surface: () => { width: number; height: number },
    draw: PassDraw,
  ) => void = () => {},
  DataTexture?: Parameters<typeof defineSphereReflectionCapture>[1],
): new (
  parameters?: Record<string, unknown>,
) => object {
  let claimed = false;
  // The engine starts once per page: one device, and one surface bound to the first renderer's canvas.
  // A renderer built after that one was disposed (a hot update re-runs the game) adopts both.
  let started: HTMLCanvasElement | undefined;
  const string = (text: string): number => {
    const bytes = module.lengthBytesUTF8(text) + 1;
    const pointer = module._malloc(bytes) >>> 0;
    module.stringToUTF8(text, pointer, bytes);
    return pointer;
  };
  const check = (status: number): void => {
    if (status !== 0) throw new Error(module.UTF8ToString(module._tnw_web_error()));
  };
  // Three tn_handle_t (12 bytes each): the scene, the camera and the render target of the current call.
  let handles = 0;
  const writeHandle = (offset: number, object: unknown, what: string): void => {
    const ref = typeof object === "object" && object !== null ? engineRef(object) : undefined;
    if (ref === undefined)
      throw new TypeError(`TN_WASM_RENDER: the ${what} is not an engine object.`);
    const [type, context, slot, generation] = ref.key.split(":").map(Number) as [
      number,
      number,
      number,
      number,
    ];
    const view = new DataView(module.HEAPU8.buffer);
    view.setUint16(handles + offset, type, true);
    view.setUint16(handles + offset + 2, context, true);
    view.setUint32(handles + offset + 4, slot, true);
    view.setUint32(handles + offset + 8, generation, true);
  };

  const Renderer = class WebGPURenderer {
    readonly isWebGPURenderer = true;
    /** The native scene pass draws to the surface; there is no frame RenderTarget to retain. */
    readonly supportsRetainedTargetSubrect = false;
    renderScale = 1;
    get temporalUpscale(): boolean {
      return module._tnw_web_frame(34) === 1;
    }
    setRenderScale(scale: number): void {
      if (!Number.isFinite(scale) || scale < 0.25 || scale > 1)
        throw new Error("renderScale must be finite and between 0.25 and 1.");
      this.renderScale = scale;
    }
    readonly domElement: HTMLCanvasElement;
    readonly info = {
      autoReset: true,
      frame: 0,
      calls: 0,
      render: { calls: 0, drawCalls: 0, frameCalls: 0, triangles: 0, timestamp: 0 },
      compute: { calls: 0, frameCalls: 0, timestamp: 0 },
      memory: { geometries: 0, textures: 0 },
      // Not three's: the setup work the engine has done so far. A steady frame adds none of it, so a
      // playtest holds each count still across frames (examples/wasm-engine-boot renderer scenario).
      // `frameGateSkips` is the exception: render() calls the frame gate declined, which only grows.
      engine: {
        compiles: 0,
        textLookups: 0,
        bindGroups: 0,
        graphKeys: 0,
        programs: 0,
        frameGateSkips: 0,
        // True while prepareEnvironmentAsync draws the held scene under the loading cover. The world
        // is still unlit, so these pixels are not the view's first frame: core's eye adaptation holds
        // its history rather than adopting this bake's black target.
        environmentBake: false,
        // The temporal pass, read from the engine each frame. `active` is false until a traa() effect is in the post
        // graph, so a graph that never reached the engine shows here as a pass that never ran.
        temporal: {
          active: false,
          frame: 0,
          historyValid: false,
          jitter: [0, 0] as [number, number],
          // The newest counted frame (one in 16 is counted): the pixels whose history the resolve discarded and the pixels
          // whose history it pulled into the colour neighbourhood, of `pixels`, and which frame it was. 0 until the first.
          rejected: 0,
          clamped: 0,
          pixels: 0,
          countedFrame: 0,
          inputWidth: 0,
          inputHeight: 0,
          outputWidth: 0,
          outputHeight: 0,
          jitterLength: 0,
        },
        // The samples the scene draws with. `samples` above is what was asked for; 1 here while the temporal pass runs.
        samples: 1,
        // The GPU milliseconds of the sample `render.timestamp` reports, by named stage (gpu-stages.ts). A stage that
        // drew no pass is absent; core's `stageGpuReading` hands it to the GI and shadow budgets.
        gpuStages: {} as Record<string, number>,
        // The last frame's shadow passes, the spot and point light maps apart from the sun's (PRD-650):
        // lamp maps redrawn and their draws, every shadow draw (the sun's are the rest), and the GPU
        // milliseconds of each part in the sample `render.timestamp` reports, -1 until one resolves.
        // `lampMapMin` and `lampMapMax` are the edges of the lamp maps the engine sized from their footprint.
        // `keptMaps` counts the maps (sun or lamp) kept from the last frame because nothing they draw changed.
        shadows: {
          lampRedraws: 0,
          lampDraws: 0,
          shadowDraws: 0,
          sunGpuMs: -1,
          lampGpuMs: -1,
          lampMapMin: 0,
          lampMapMax: 0,
          keptMaps: 0,
        },
        // The bytes of per-draw uniforms the last frame uploaded.
        uniformBytes: 0,
      },
      // three's Info: render() adds to drawCalls and triangles, and the caller resets once per frame, so a
      // frame that draws its world and then its overlay reports both (core does this in onBeginFrame).
      reset(): void {
        this.render.drawCalls = 0;
        this.render.frameCalls = 0;
        this.render.triangles = 0;
      },
    };
    /** three's WebGPURenderer: `antialias` is 4x MSAA, `samples` 0 or 1 is none; the engine draws 1 or 4. */
    readonly samples: number;
    autoClear = true;
    readonly library = defineToneMappingLibrary(
      () => {
        if (!tsl) throw new Error("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING: no TSL runtime");
        const { exports } = defineTsl(tsl);
        const color = (exports.toneMappingColor as () => unknown)();
        const exposure = (exports.uniform as (value: number) => { setName(name: string): unknown })(
          1,
        ).setName("toneMappingExposure");
        return [color, exposure];
      },
      (node) => {
        if (!isTslNode(node))
          throw new TypeError("TN_NATIVE_CUSTOM_TONEMAPPING_TYPE: expected a TSL vec3 node");
        if (!tsl?.setToneMapping)
          throw new Error("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING: no output binding");
        tsl.setToneMapping(node[TSL_NODE]);
      },
    );
    toneMapping = 0;
    toneMappingExposure = 1;
    outputColorSpace = "srgb";
    readonly shadowMap = new ShadowMap();
    /**
     * What core reads to name the adapter: the engine's own device, not a second request. `pipelineCompiles`
     * is the engine's own pipeline cache count, as the V8 player's facade exposes it to the bench harness.
     */
    readonly backend: {
      readonly gpu: { requestAdapter(): Promise<{ info: IAdapterInfo }> };
      trackTimestamp: boolean;
      getTimestampFrames(type: string): number[];
      pipelineCompiles(): number;
      /** Resolves as three's GPUDevice.lost does once the host loses its device; core reports it (TN_DEVICE_LOST). */
      readonly device: { readonly lost: Promise<{ reason: string; message: string }> };
    };
    #deviceLost: (info: { reason: string; message: string }) => void = () => undefined;
    #pixelRatio = 1;
    #width: number;
    #height: number;
    #clear: [number, number, number, number] = [0, 0, 0, 1];
    /** The last number or string clear colour and its lanes: each is converted once. */
    #clearKey: unknown = Symbol("unset");
    #clearLanes: [number, number, number] = [0, 0, 0];
    #initialized: Promise<this> | undefined;
    #adapter: IAdapterInfo | undefined;
    #last: [unknown, unknown] | undefined;
    [PIPELINE_POST]?: () => void;
    /** The host is Failed for good (the GPU process destroyed the device, an uncaptured error): see #drawStatus. */
    #lost = false;
    /** A draw got through in this task, so later draws land on its surface texture: see render(). */
    #frameOpen = false;
    /** The draw in flight is renderOverlay's. */
    #overlay = false;
    #state: string | undefined;
    #gpuSamples = 0;
    #holdsSlot = true;
    #timestampFrames: number[] = [];

    constructor(parameters: Record<string, unknown> = {}) {
      if (claimed)
        throw new Error("TN_WASM_RENDERER_SINGLE: the Wasm engine drives one renderer per page.");
      claimed = true;
      // The surface cannot move to another canvas, so the engine's own canvas stays the one core mounts
      // (it mounts `renderer.domElement`, not the canvas it asked for).
      this.domElement =
        started ??
        (parameters.canvas as HTMLCanvasElement | undefined) ??
        document.createElement("canvas");
      // three's WebGPURenderer marks its canvas `three.js r<rev> webgpu`; tools read the backend there.
      // A worker's OffscreenCanvas has no attributes (PRD-752).
      this.domElement.setAttribute?.("data-engine", "threenative wasm webgpu");
      const samples = parameters.samples ?? (parameters.antialias ? 4 : 1);
      this.samples = Math.max(1, Number(samples));
      this.#width = this.domElement.width || 300;
      this.#height = this.domElement.height || 150;
      const adapter = () => this.#adapter;
      const timestampFrames = (type: string) => (type === "render" ? this.#timestampFrames : []);
      this.backend = {
        gpu: {
          async requestAdapter() {
            const info = adapter();
            if (info === undefined) throw new Error("TN_WASM_RENDERER: init() has not finished.");
            return { info };
          },
        },
        trackTimestamp: Boolean(parameters.trackTimestamp ?? true),
        getTimestampFrames: timestampFrames,
        pipelineCompiles: () => module._tnw_web_frame(2),
        device: {
          lost: new Promise((resolve) => {
            this.#deviceLost = resolve;
          }),
        },
      };
    }

    init(): Promise<this> {
      this.#initialized ??= (async () => {
        if (started === undefined) {
          // A module of another ABI reads every later call's arguments as something else: the
          // overlay flag as the frame number drew the world without post (39295d1f3).
          const engine = (module as Partial<WebHostModule>)._tnw_web_host_abi?.();
          if (engine !== WEB_HOST_ABI)
            throw new Error(
              `TN_WASM_ABI_MISMATCH: this facade speaks web host ABI ${WEB_HOST_ABI}, the engine ${engine ?? "none (older than ABI 2)"}: install create-threenative and @threenative/runtime-native from one build`,
            );
          started = this.domElement;
          module.specialHTMLTargets[CANVAS_TARGET] = this.domElement;
          handles = module._malloc(36) >>> 0;
          const selector = string(CANVAS_TARGET);
          try {
            check(
              module._tnw_web_init(selector, this.#drawWidth(), this.#drawHeight(), WEB_HOST_ABI),
            );
          } finally {
            module._free(selector);
          }
        } else {
          // The disposed renderer's post graph must not outlive its game.
          tsl?.setPost(null);
          tsl?.setToneMapping?.(null);
        }
        for (;;) {
          const state = module._tnw_web_poll();
          if (state === READY) break;
          if (state === FAILED) check(1);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        const field = (index: number) => module.UTF8ToString(module._tnw_web_adapter(index));
        this.#adapter = {
          vendor: field(0),
          architecture: field(1),
          description: field(2),
          device: field(2),
        };
        // Honest, like the engine: a device without timestamp-query times no frame, so no caller
        // may be told timestamps are enabled. An explicit opt-out stays off.
        if (module._tnw_web_frame(10) === 0) this.backend.trackTimestamp = false;
        return this;
      })();
      return this.#initialized;
    }

    #drawWidth(): number {
      return Math.max(1, Math.floor(this.#width * this.#pixelRatio));
    }

    #drawHeight(): number {
      return Math.max(1, Math.floor(this.#height * this.#pixelRatio));
    }

    #resize(): void {
      this.domElement.width = this.#drawWidth();
      this.domElement.height = this.#drawHeight();
      if (handles !== 0) check(module._tnw_web_resize(this.#drawWidth(), this.#drawHeight()));
    }

    setSize(width: number, height: number, updateStyle = true): void {
      this.#width = width;
      this.#height = height;
      if (updateStyle) {
        this.domElement.style.width = `${width}px`;
        this.domElement.style.height = `${height}px`;
      }
      this.#resize();
    }

    getSize<T extends { set(x: number, y: number): T }>(target: T): T {
      return target.set(this.#width, this.#height);
    }

    setPixelRatio(ratio = 1): void {
      this.#pixelRatio = ratio;
      this.#resize();
    }

    getPixelRatio(): number {
      return this.#pixelRatio;
    }

    getDrawingBufferSize<T extends { set(x: number, y: number): T }>(target: T): T {
      return target.set(this.#drawWidth(), this.#drawHeight());
    }

    setClearColor(color: unknown, alpha = 1): void {
      if (typeof color === "object" && color !== null) {
        const value = color as IColorLike;
        this.#clear = [value.r, value.g, value.b, alpha];
        return;
      }
      // Every post pass resets the clear colour to 0 (RendererUtils), and an engine Color per call
      // was a construction across the boundary each time.
      if (!Object.is(color, this.#clearKey)) {
        const value = new Color(color) as IColorLike;
        this.#clearLanes = [value.r, value.g, value.b];
        this.#clearKey = color;
        const host = globalThis as { __tnEngineCost?: Record<string, number> };
        host.__tnEngineCost ??= {};
        host.__tnEngineCost.clearColorConversions =
          (host.__tnEngineCost.clearColorConversions ?? 0) + 1;
      }
      const lanes = this.#clearLanes;
      this.#clear = [lanes[0], lanes[1], lanes[2], alpha];
    }

    getClearColor<T extends IColorLike & { setRGB(r: number, g: number, b: number): T }>(
      target: T,
    ): T {
      return target.setRGB(this.#clear[0], this.#clear[1], this.#clear[2]);
    }

    getClearAlpha(): number {
      return this.#clear[3];
    }

    setClearAlpha(alpha: number): void {
      this.#clear[3] = alpha;
    }

    /**
     * core's canvas-layer overlay (a loading screen, a canvas HUD): drawn over the frame already on the canvas, with
     * no post and no temporal step. Through render() it replaced the world frame and moved the temporal history and
     * the metered exposure, so the world came back ghosted and blurred after the loading screen.
     */
    renderOverlay(scene: unknown, camera: unknown): void {
      this.#overlay = true;
      try {
        this.render(scene, camera);
      } finally {
        this.#overlay = false;
      }
    }

    render(scene: unknown, camera: unknown): void {
      if (this.#adapter === undefined)
        throw new Error("TN_WASM_RENDERER: render() before init() finished.");
      if (this.#lost) return;
      // Chromium queues a submitted frame without bound. When rAF outruns the GPU (an unthrottled
      // loop, a heavy scene) the page blocks until the GPU drains and the GPU process is killed.
      // The host says 1 while two drawn frames are still on the GPU: draw nothing this call.
      // The gate holds back a frame, not a draw: a draw after one that got through in the same task
      // (the overlay over the world, a loading cover over a covered bake) lands on the surface
      // texture already taken, so refusing it saves no frame and presents the world without it.
      // Measured on Lantern Vale: every cover over a drawn frame was refused, so the loading screen
      // flickered black for the whole environment bake and then showed the unfinished world.
      if (!this.#frameOpen && module._tnw_web_frame(11) === 1) {
        // A lost device leaves its frames on the GPU for good, so the gate declines every later frame
        // and no draw ever returns a status: name the loss here, where the frame poll just ran.
        if (this.#noticeLost()) return;
        // Counted, never hidden: the loop's render phase for this frame is near zero, and a meter that
        // averages it with drawn frames reads cheaper than the work that was done (core's `renderSkips`).
        this.info.engine.frameGateSkips += 1;
        return;
      }
      if (!this.#frameOpen) {
        this.#frameOpen = true;
        // Every draw of a frame is synchronous in one task (the frame loop's callback, a warm-up timer
        // task), so the frame closes when the task's synchronous work is done.
        queueMicrotask(() => {
          this.#frameOpen = false;
        });
      }
      syncVirtualShadowLods();
      beforeRender({ camera, scene, renderer: this, frameId: this.info.frame });
      drawSecondaryPasses(
        () => ({ width: this.#drawWidth(), height: this.#drawHeight() }),
        (target, root, view) => this[DRAW_TARGET](target, root, view, true),
      );
      this.#last = [scene, camera];
      this.#applyState();
      writeHandle(0, scene, "scene");
      writeHandle(12, camera, "camera");
      const renderFrame = this.info.frame;
      this.#drawStatus(
        module._tnw_web_render(
          handles,
          handles + 12,
          ...this.#clear,
          this.#overlay ? 1 : 0,
          renderFrame,
        ),
      );
      this.info.frame += 1;
      this.info.render.frameCalls = module._tnw_web_frame(0);
      this.info.render.calls += this.info.render.frameCalls;
      this.info.render.drawCalls += this.info.render.frameCalls;
      this.info.render.triangles += module._tnw_web_frame(1);
      const shadows = this.info.engine.shadows;
      shadows.lampRedraws = module._tnw_web_frame(25);
      shadows.lampDraws = module._tnw_web_frame(26);
      shadows.shadowDraws = module._tnw_web_frame(27);
      shadows.lampMapMin = module._tnw_web_frame(28);
      shadows.lampMapMax = module._tnw_web_frame(29);
      shadows.keptMaps = module._tnw_web_frame(40);
      this.info.engine.uniformBytes = module._tnw_web_frame(41);
      const gpuSamples = module._tnw_web_frame(8);
      if (gpuSamples > this.#gpuSamples) {
        this.#gpuSamples = gpuSamples;
        const gpuMs = module._tnw_web_frame(7);
        // The engine reports which submitted frame this sample belongs to; the readback can land
        // many frames later, so the arrival frame is never the sample's age.
        if (Number.isFinite(gpuMs) && gpuMs > 0) {
          this.info.render.timestamp = gpuMs;
          this.#timestampFrames = [module._tnw_web_frame(9)];
          const stages: Record<string, number> = {};
          GPU_STAGES.forEach((name, index) => {
            const stageMs = module._tnw_web_frame(GPU_STAGE_FIELD + index);
            if (stageMs > 0) stages[name] = stageMs;
          });
          const shadowMs = module._tnw_web_frame(SHADOW_SEGMENT_FIELD);
          if (shadowMs > 0) stages[SHADOW_STAGE] = shadowMs;
          this.info.engine.gpuStages = stages;
          this.info.engine.shadows.sunGpuMs = module._tnw_web_frame(19);
          this.info.engine.shadows.lampGpuMs = module._tnw_web_frame(24);
        }
      }
      const engine = this.info.engine;
      engine.compiles = module._tnw_web_frame(2);
      engine.textLookups = module._tnw_web_frame(3);
      engine.bindGroups = module._tnw_web_frame(4);
      engine.graphKeys = module._tnw_web_frame(5);
      engine.programs = module._tnw_web_frame(6);
      const temporal = engine.temporal;
      temporal.active = module._tnw_web_frame(13) === 1;
      temporal.frame = module._tnw_web_frame(14);
      temporal.historyValid = module._tnw_web_frame(15) === 1;
      temporal.jitter[0] = module._tnw_web_frame(16);
      temporal.jitter[1] = module._tnw_web_frame(17);
      temporal.rejected = module._tnw_web_frame(30);
      temporal.clamped = module._tnw_web_frame(31);
      temporal.pixels = module._tnw_web_frame(32);
      temporal.countedFrame = module._tnw_web_frame(33);
      temporal.inputWidth = module._tnw_web_frame(35);
      temporal.inputHeight = module._tnw_web_frame(36);
      temporal.jitterLength = module._tnw_web_frame(37);
      temporal.outputWidth = module._tnw_web_frame(38);
      temporal.outputHeight = module._tnw_web_frame(39);
      engine.samples = module._tnw_web_frame(18);
    }

    /** three's output and shadow settings, handed to the engine when they change. */
    #applyState(): void {
      const {
        toneMapping,
        toneMappingExposure,
        outputColorSpace,
        shadowMap,
        samples,
        renderScale,
      } = this;
      this.library.apply(toneMapping);
      const key = `${toneMapping}|${toneMappingExposure}|${outputColorSpace}|${shadowMap.enabled}|${shadowMap.type}|${samples}|${renderScale}`;
      if (key === this.#state) return;
      const space = string(String(outputColorSpace));
      try {
        check(
          module._tnw_web_renderer_state(
            toneMapping,
            toneMappingExposure,
            space,
            shadowMap.enabled ? 1 : 0,
            shadowMap.type,
            samples,
            renderScale,
          ),
        );
      } finally {
        module._free(space);
      }
      this.#state = key;
    }

    /**
     * render() while a render target is set (render-target.ts): draws into the target. `deferred` (an offscreen PassNode)
     * plans the draw and has the engine record it in the frame that samples the target.
     */
    [DRAW_TARGET](target: unknown, root: unknown, camera: unknown, deferred = false): void {
      if (this.#adapter === undefined)
        throw new Error("TN_WASM_RENDERER: render() before init() finished.");
      if (this.#lost) return;
      syncVirtualShadowLods();
      beforeRender({ camera, scene: root, renderer: this, frameId: this.info.frame });
      this.#applyState();
      writeHandle(0, root, "scene");
      writeHandle(12, camera, "camera");
      writeHandle(24, target, "render target");
      this.#drawStatus(
        module._tnw_web_render_target(
          handles + 24,
          handles,
          handles + 12,
          ...this.#clear,
          deferred ? 1 : 0,
        ),
      );
    }

    /**
     * A draw's status. The host stays Failed once it lost its device and answers every later draw with the
     * same message, so the first one throws and the renderer draws nothing after it: one diagnostic, not one
     * page error per frame. A refusal that leaves the host running (a render target's) still throws each time.
     */
    #drawStatus(status: number): void {
      if (status !== 0) this.#noticeLost();
      check(status);
    }

    /**
     * True once the host is Failed for good. The first time, the console names it: the throw from a draw
     * is the only other report, and a warm-up or a frame hook may swallow it. A lost device also resolves
     * `backend.device.lost`; another host failure (an uncaptured error) is not a lost device.
     */
    #noticeLost(): boolean {
      if (this.#lost || module._tnw_web_poll() !== FAILED) return this.#lost;
      this.#lost = true;
      const message = module.UTF8ToString(module._tnw_web_error());
      console.error(
        `TN_WASM_RENDERER_LOST: this renderer draws nothing after this call. ${message}`,
      );
      if (message.startsWith("TN_WASM_DEVICE_LOST"))
        this.#deviceLost({ reason: "unknown", message });
      return true;
    }

    /** The last scene and camera again: RenderPipeline.render() draws through its post graph. */
    [RENDER_AGAIN](): void {
      if (this.#last !== undefined) this.render(...this.#last);
    }

    /** WebGPUCapabilities.getMaxAnisotropy, as on the V8 player: WebGPU samplers clamp to 16. */
    getMaxAnisotropy(): number {
      return 16;
    }

    /**
     * three's compileAsync: the engine builds the pipelines the first draw of `scene` takes through
     * createRenderPipelineAsync (tnw_web_compile_async), and this resolves once every one is built. A no-op
     * here left them to that draw, which compiled each one synchronously: all 205 of Lantern Vale's, behind
     * its loading screen. A refusal rejects; the first draw then compiles instead.
     */
    async compileAsync(scene: unknown, camera: unknown, targetScene?: unknown): Promise<void> {
      if (this.#adapter === undefined)
        throw new Error("TN_WASM_RENDERER: compileAsync() before init() finished.");
      if (this.#lost) return;
      // The game's first draw runs through its RenderPipeline: compile with that graph's settings.
      this[PIPELINE_POST]?.();
      this.#applyState();
      writeHandle(0, scene, "scene");
      writeHandle(12, camera, "camera");
      if (targetScene != null) writeHandle(24, targetScene, "target scene");
      const id = module._tnw_web_compile_async(
        handles,
        handles + 12,
        targetScene == null ? 0 : handles + 24,
      );
      await compiled(module, id);
    }

    /**
     * Startup warm-up's native counterpart of three's PMREM preparer: the engine bakes an environment
     * a retained packet per render and skips every frame until it is done, so draw the held scene
     * (behind the loading cover) until a render is no longer skipped for it. True when it drew;
     * false at `deadlineMs` (a `performance.now()` time), so a bake that never finishes cannot
     * hold the caller or keep drawing after it gave up.
     *
     * Each draw runs in a timer task, not in the animation frame, so the browser presents it by
     * itself: an environment still baking presents black. `afterDraw` runs straight after every
     * draw, in the same task, so the caller can paint its loading cover over that frame; without
     * it the cover flickers against black for as long as the bake lasts.
     */
    async prepareEnvironmentAsync(
      scene: unknown,
      camera: unknown,
      deadlineMs = Number.POSITIVE_INFINITY,
      afterDraw?: () => void,
    ): Promise<boolean> {
      // Lantern Vale's bake drew the main pass at 4x MSAA before its TRAA graph was installed: 39
      // pipelines the game never drew, compiled synchronously behind the cover.
      this[PIPELINE_POST]?.();
      // The bake's last draw is the scene's first, so build its pipelines off the queue first: on
      // Lantern Vale that draw compiled 84 synchronously and held the GPU queue for over a second
      // (ready 6.3 s -> 4.5 s). A refusal is the draw's to report, where it compiles that pipeline again.
      // It waits at most half the time left, so a slow compile still leaves the bake its draws.
      const compiling = this.compileAsync(scene, camera).catch(() => undefined);
      const left = (deadlineMs - performance.now()) / 2;
      if (Number.isFinite(left)) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          compiling,
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.max(0, left));
          }),
        ]);
        clearTimeout(timer);
      } else await compiling;
      this.info.engine.environmentBake = true;
      try {
        while (performance.now() < deadlineMs) {
          const gated = this.info.engine.frameGateSkips;
          this.render(scene, camera);
          // Read before `afterDraw`: the cover is a draw too, and the engine's "skipped for an unbaked
          // environment" flag describes the last draw it made.
          const baked =
            this.info.engine.frameGateSkips === gated && module._tnw_web_frame(12) === 0;
          afterDraw?.();
          if (baked) return true;
          // A macrotask, not a frame: the work-done callbacks that advance the bake arrive between tasks.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        return false;
      } finally {
        this.info.engine.environmentBake = false;
      }
    }

    async resolveTimestampsAsync(type = "render"): Promise<number | undefined> {
      if (type !== "render") return undefined;
      return this.info.render.timestamp > 0 ? this.info.render.timestamp : undefined;
    }

    /**
     * three's renderer.compute(node | node[]) (PRD-620): the kernels queue in call order, each with the uniform
     * values it was called with, and run ahead of the next draw or read. A kernel the engine cannot lower
     * refuses here, by name.
     */
    compute(computeNodes: unknown, dispatchSize: unknown = null): void {
      if (tsl === undefined) unsupported("compute");
      if (dispatchSize !== null)
        throw new Error(
          "TN_COMPUTE_DISPATCH_SIZE: renderer.compute(nodes, dispatchSize) is not available on the Wasm engine; give the node its count.",
        );
      beforeRender();
      for (const node of Array.isArray(computeNodes) ? computeNodes : [computeNodes]) {
        if (!isTslNode(node))
          throw new TypeError(
            "TN_COMPUTE_NODE: renderer.compute takes the node Fn(() => { ... })().compute(count) makes",
          );
        tsl.compute(node[TSL_NODE]);
      }
    }

    async computeAsync(computeNodes: unknown, dispatchSize: unknown = null): Promise<void> {
      this.compute(computeNodes, dispatchSize);
    }

    /** The attribute's storage bytes after every kernel queued before this call (three's resolved forms). */
    getArrayBufferAsync(
      attribute: object,
      target: ArrayBuffer | { isReadbackBuffer?: boolean; buffer: unknown } | null = null,
      offset = 0,
      count = -1,
    ): Promise<ArrayBuffer | { isReadbackBuffer?: boolean; buffer: unknown }> {
      const runtime = tsl;
      if (runtime === undefined) return unsupported("getArrayBufferAsync");
      const ref = engineRef(attribute);
      if (ref === undefined)
        throw new TypeError(
          "TN_NATIVE_READ_STORAGE: expected the BufferAttribute of a storage buffer",
        );
      return readStorageBytes(
        (a) => runtime.readStorage(engineRef(a as object) ?? ref),
        attribute,
        target,
        offset,
        count,
      );
    }

    /** Drops the attribute's GPU copy; the next use uploads its CPU contents again. */
    deleteAttribute(attribute: object): this {
      const ref = engineRef(attribute);
      if (tsl === undefined || ref === undefined)
        throw new TypeError("TN_NATIVE_DELETE_ATTRIBUTE: expected a BufferAttribute");
      tsl.deleteStorage(ref);
      return this;
    }

    getRenderTarget(): null {
      return null;
    }

    setRenderTarget(target: unknown): void {
      if (target !== null) unsupported("RenderTarget");
    }

    setAnimationLoop(): never {
      return unsupported("setAnimationLoop");
    }

    /** Releases the page's one renderer slot; the engine and its canvas stay for the next renderer. */
    dispose(): void {
      if (!this.#holdsSlot) return;
      this.#holdsSlot = false;
      claimed = false;
    }
  };
  const read = async (target: unknown, x: number, y: number, width: number, height: number) => {
    writeHandle(24, target, "render target");
    const id = module._tnw_web_read_target(handles + 24, x, y, width, height);
    if (id === 0) check(1);
    const size =
      width * height * targetTexelBytes((target as { texture: { type: number } }).texture.type);
    const out = module._malloc(size) >>> 0;
    try {
      for (;;) {
        module._tnw_web_poll();
        const status = module._tnw_web_read_target_take(id, out, size);
        if (status === 1) return module.HEAPU8.slice(out, out + size);
        // A read the lost device dropped says so, so the caller's report is read as that one loss.
        if (status < 0)
          throw new Error(
            module._tnw_web_poll() === FAILED
              ? `TN_WASM_READ_TARGET: the read failed: ${module.UTF8ToString(module._tnw_web_error())}`
              : "TN_WASM_READ_TARGET: the read failed",
          );
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      module._free(out);
    }
  };
  if (DataTexture !== undefined)
    Object.assign(Renderer.prototype, {
      // quality-allow: the capture API takes the requested Unreal actor name
      // biome-ignore lint/style/useNamingConvention: capture API uses the requested Unreal actor name.
      SphereReflectionCapture: defineSphereReflectionCapture(async (scene, x, y, z, size, face) => {
        beforeRender();
        writeHandle(0, scene, "scene");
        const id = module._tnw_web_capture_face(handles, x, y, z, size, face);
        if (id === -2) return null;
        if (id < 0) check(1);
        const bytes = size * size * 3 * 4;
        const out = module._malloc(bytes) >>> 0;
        try {
          for (;;) {
            module._tnw_web_poll();
            const status = module._tnw_web_read_target_take(id, out, bytes);
            if (status === 1) return new Float32Array(module.HEAPU8.slice(out, out + bytes).buffer);
            if (status < 0) throw new Error("TN_REFLECTION_CAPTURE_READ");
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        } finally {
          module._free(out);
        }
      }, DataTexture),
    });
  defineRenderTargets(Renderer.prototype, (renderer) => ({
    draw: (target, root, camera) =>
      (renderer as { [DRAW_TARGET](t: unknown, r: unknown, c: unknown): void })[DRAW_TARGET](
        target,
        root,
        camera,
      ),
    read,
  }));
  return Renderer;
}
