/**
 * `WebGPURenderer` on the Wasm engine (PRD-540): three's renderer surface over the product host
 * (`packages/runtime-native/src/engine/wasm/web_host.cpp`). The engine owns the device, the canvas
 * surface and every draw; this class turns three's calls into host calls and reports what the
 * engine did. What it does not implement throws its diagnostic rather than doing nothing.
 */
import { TSL_NODE, type TnAbiModule, engineRef } from "./browser-backend.js";
import { type ITslRuntime, isTslNode } from "./browser-tsl.js";
import type { PassDraw } from "./pass-node.js";
import { defineRenderTargets } from "./render-target.js";
import { ShadowMap } from "./shadow-map.js";
import { readStorageBytes } from "./storage.js";
import type { INodeFrame } from "./temp-node.js";

/** The product host's exports beside the catalog ABI (all numbers: pointers, sizes, status). */
type HostCall =
  | "_tnw_web_init"
  | "_tnw_web_poll"
  | "_tnw_web_error"
  | "_tnw_web_adapter"
  | "_tnw_web_resize"
  | "_tnw_web_render"
  | "_tnw_web_renderer_state"
  | "_tnw_web_frame"
  | "_tnw_web_render_target"
  | "_tnw_web_read_target"
  | "_tnw_web_read_target_take";

export type WebHostModule = Record<HostCall, (...args: number[]) => number> & {
  readonly specialHTMLTargets: Record<string, unknown>;
};

export type WebEngineModule = TnAbiModule & WebHostModule;

export function isWebHostModule(module: TnAbiModule): module is WebEngineModule {
  return typeof (module as Partial<WebHostModule>)._tnw_web_init === "function";
}

/** The canvas key the host's surface looks up; Emscripten resolves it before any DOM query. */
const CANVAS_TARGET = "!threenative-canvas";
const READY = 1;
/** The facade's own redraw, for RenderPipeline (browser-entry.ts). */
export const RENDER_AGAIN = Symbol("tn.renderAgain");
const DRAW_TARGET = Symbol("tn.drawTarget");
const FAILED = 2;

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
    };
    #pixelRatio = 1;
    #width: number;
    #height: number;
    #clear: [number, number, number, number] = [0, 0, 0, 1];
    #initialized: Promise<this> | undefined;
    #adapter: IAdapterInfo | undefined;
    #last: [unknown, unknown] | undefined;
    /** The host is Failed for good (the GPU process destroyed the device, an uncaptured error): see #drawStatus. */
    #lost = false;
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
      this.domElement.setAttribute("data-engine", "threenative wasm webgpu");
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
      };
    }

    init(): Promise<this> {
      this.#initialized ??= (async () => {
        if (started === undefined) {
          started = this.domElement;
          module.specialHTMLTargets[CANVAS_TARGET] = this.domElement;
          handles = module._malloc(36) >>> 0;
          const selector = string(CANVAS_TARGET);
          try {
            check(module._tnw_web_init(selector, this.#drawWidth(), this.#drawHeight()));
          } finally {
            module._free(selector);
          }
        } else {
          // The disposed renderer's post graph must not outlive its game.
          tsl?.setPost(null);
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
      const value = (
        typeof color === "object" && color !== null ? color : new Color(color)
      ) as IColorLike;
      this.#clear = [value.r, value.g, value.b, alpha];
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

    render(scene: unknown, camera: unknown): void {
      if (this.#adapter === undefined)
        throw new Error("TN_WASM_RENDERER: render() before init() finished.");
      if (this.#lost) return;
      // Chromium queues a submitted frame without bound. When rAF outruns the GPU (an unthrottled
      // loop, a heavy scene) the page blocks until the GPU drains and the GPU process is killed.
      // The host says 1 while two drawn frames are still on the GPU: draw nothing this call.
      if (module._tnw_web_frame(11) === 1) {
        // Counted, never hidden: the loop's render phase for this frame is near zero, and a meter that
        // averages it with drawn frames reads cheaper than the work that was done (core's `renderSkips`).
        this.info.engine.frameGateSkips += 1;
        return;
      }
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
      this.#drawStatus(module._tnw_web_render(handles, handles + 12, ...this.#clear, renderFrame));
      this.info.frame += 1;
      this.info.render.frameCalls = module._tnw_web_frame(0);
      this.info.render.calls += this.info.render.frameCalls;
      this.info.render.drawCalls += this.info.render.frameCalls;
      this.info.render.triangles += module._tnw_web_frame(1);
      const gpuSamples = module._tnw_web_frame(8);
      if (gpuSamples > this.#gpuSamples) {
        this.#gpuSamples = gpuSamples;
        const gpuMs = module._tnw_web_frame(7);
        // The engine reports which submitted frame this sample belongs to; the readback can land
        // many frames later, so the arrival frame is never the sample's age.
        if (Number.isFinite(gpuMs) && gpuMs > 0) {
          this.info.render.timestamp = gpuMs;
          this.#timestampFrames = [module._tnw_web_frame(9)];
        }
      }
      const engine = this.info.engine;
      engine.compiles = module._tnw_web_frame(2);
      engine.textLookups = module._tnw_web_frame(3);
      engine.bindGroups = module._tnw_web_frame(4);
      engine.graphKeys = module._tnw_web_frame(5);
      engine.programs = module._tnw_web_frame(6);
    }

    /** three's output and shadow settings, handed to the engine when they change. */
    #applyState(): void {
      const { toneMapping, toneMappingExposure, outputColorSpace, shadowMap, samples } = this;
      const key = `${toneMapping}|${toneMappingExposure}|${outputColorSpace}|${shadowMap.enabled}|${shadowMap.type}|${samples}`;
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
      if (status !== 0 && module._tnw_web_poll() === FAILED) this.#lost = true;
      check(status);
    }

    /** The last scene and camera again: RenderPipeline.render() draws through its post graph. */
    [RENDER_AGAIN](): void {
      if (this.#last !== undefined) this.render(...this.#last);
    }

    /** WebGPUCapabilities.getMaxAnisotropy, as on the V8 player: WebGPU samplers clamp to 16. */
    getMaxAnisotropy(): number {
      return 16;
    }

    compileAsync(): Promise<void> {
      return Promise.resolve();
    }

    /**
     * Startup warm-up's native counterpart of three's PMREM preparer: the engine bakes an environment
     * a retained packet per render and skips every frame until it is done, so draw the held scene
     * (behind the loading cover) until a render is no longer skipped for it. True when it drew;
     * false at `deadlineMs` (a `performance.now()` time), so a bake that never finishes cannot
     * hold the caller or keep drawing after it gave up.
     */
    async prepareEnvironmentAsync(
      scene: unknown,
      camera: unknown,
      deadlineMs = Number.POSITIVE_INFINITY,
    ): Promise<boolean> {
      while (performance.now() < deadlineMs) {
        const gated = this.info.engine.frameGateSkips;
        this.render(scene, camera);
        if (this.info.engine.frameGateSkips === gated && module._tnw_web_frame(12) === 0)
          return true;
        // A macrotask, not a frame: the work-done callbacks that advance the bake arrive between tasks.
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return false;
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
    const size = width * height * 8;
    const out = module._malloc(size) >>> 0;
    try {
      for (;;) {
        module._tnw_web_poll();
        const status = module._tnw_web_read_target_take(id, out, size);
        if (status === 1) return module.HEAPU8.slice(out, out + size);
        if (status < 0) throw new Error("TN_WASM_READ_TARGET: the read failed");
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      module._free(out);
    }
  };
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
