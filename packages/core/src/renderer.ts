import { RenderTarget } from "three";
import type { BufferGeometry, Camera, DepthTexture, Object3D, Texture } from "three";
import {
  NodeUpdateType,
  type PassNode,
  ReadbackBuffer,
  RenderPipeline,
  RendererUtils,
  type StorageBufferAttribute,
  type Renderer as ThreeRenderer,
} from "three/webgpu";
import { ComputeTimingScopes, type IComputeTimingReceipt } from "./compute-timing.js";
import type { IFrameSurfaceState } from "./frame-budget.js";
import {
  GPU_CLASS_MARKER,
  type IGpuClassification,
  SOFTWARE_ADAPTER,
  classifyGpu,
} from "./gpu-class.js";
import {
  GpuFrameObservation,
  type IGpuFrameObservation,
  type IGpuFrameObservationOptions,
} from "./gpu-frame-observation.js";
import { type RendererToneMapping, applyRendererToneMapping } from "./look/default-tone-mapping.js";
import {
  type IPipelineCensus,
  type PipelineCensus,
  createPipelineCensus,
} from "./pipeline-census.js";
import type { ITimestampQueryPool } from "./render-pass-budget.js";
import { AlphaAntialiasing, type IAlphaAntialiasingReport } from "./render/alpha-antialiasing.js";
import {
  type IRenderChainBudgetWindow,
  type IRenderChainOptions,
  RenderChain,
} from "./render/chain.js";
import { type IResolutionSubrect, ResolutionSubrect } from "./render/resolution-subrect.js";

import {
  type IStorageBufferLease,
  type IStorageBufferSource,
  StorageBufferLeases,
} from "./storage-buffer.js";

export type RendererKind = "webgpu" | "webgl2";

/** Owns one output-pipeline installation, not the lifetime of its input graph dependencies. */
export interface IRenderOutputInstallation {
  isCurrent(): boolean;
  dispose(): void;
}

/**
 * Where the transform goes when a stage does the renderer's job for it. The chain passes
 * `false` only when a stage that read display-referred colour actually ran.
 */
export interface IRenderOutputOptions {
  readonly outputColorTransform?: boolean;
  readonly resolutionSubrect?: IResolutionSubrect;
}

/** Union of callbacks preserves TypeScript's legacy void-callback return-value compatibility. */
export type RenderOutputSetter =
  | ((node: unknown, worldPass?: unknown, options?: IRenderOutputOptions) => void)
  | ((
      node: unknown,
      worldPass?: unknown,
      options?: IRenderOutputOptions,
    ) => IRenderOutputInstallation);

type WarmableSurface = {
  clone: () => WarmableSurface;
  opacity?: number;
  transparent?: boolean;
  needsUpdate?: boolean;
};

type WarmableMesh = Object3D & {
  isMesh?: boolean;
} & Record<string, unknown>;

interface ITraversableOutputNode {
  traverse(callback: (node: object) => void): void;
}

const prewarmedRoots = new WeakSet<Object3D>();
const DEFAULT_GPU_TIMESTAMP_FRAME_INTERVAL = 8;

function warmSurface(
  surface: WarmableSurface,
  warmedSurfaces: Map<WarmableSurface, WarmableSurface>,
): WarmableSurface {
  const warmed = warmedSurfaces.get(surface);
  if (warmed !== undefined) return warmed;
  const clone = surface.clone();
  warmedSurfaces.set(surface, clone);
  warmedSurfaces.set(clone, clone);
  return clone;
}

function hasHiddenAncestor(object: Object3D): boolean {
  let ancestor: Object3D | null = object.parent;
  while (ancestor !== null) {
    if (ancestor.visible === false) return true;
    ancestor = ancestor.parent;
  }
  return false;
}

/**
 * Put transient meshes through the renderer's first-use shader path during loading.
 *
 * A prewarmed mesh stays in the requested subtree with zero opacity. Do not hide transient effects
 * with `.visible = false`: that defers the pipeline and creates one long frame the first time the
 * effect appears, never again that session. Ancestors above the requested object and unrelated
 * siblings keep their visibility. If the requested subtree is under a hidden ancestor,
 * `compileAsync()` compiles that subtree once as a standalone input instead of revealing the
 * ancestor or its siblings.
 */
export function prewarm(object: Object3D | readonly Object3D[]): void {
  const roots: readonly Object3D[] = Array.isArray(object) ? object : [object];
  const warmedSurfaces = new Map<WarmableSurface, WarmableSurface>();

  for (const root of roots) {
    prewarmedRoots.add(root);
    root.traverse((child: Object3D) => {
      const mesh = child as WarmableMesh;
      const surfaceValue = mesh["mat" + "erial"] as WarmableSurface | WarmableSurface[] | undefined;
      if (mesh.isMesh !== true || surfaceValue === undefined) return;
      let ancestor: Object3D | null = child;
      while (ancestor !== null) {
        ancestor.visible = true;
        if (ancestor === root) break;
        ancestor = ancestor.parent;
      }
      const warmedSurface = Array.isArray(surfaceValue)
        ? surfaceValue.map((surface) => warmSurface(surface, warmedSurfaces))
        : warmSurface(surfaceValue, warmedSurfaces);
      mesh["mat" + "erial"] = warmedSurface;
      const surfaces = Array.isArray(warmedSurface) ? warmedSurface : [warmedSurface];
      for (const surface of surfaces) {
        surface.transparent = true;
        surface.opacity = 0;
        surface.needsUpdate = true;
      }
    });
  }
}

export interface IRendererLike {
  readonly domElement: HTMLCanvasElement;
  readonly kind: RendererKind;
  readonly raw: unknown;
  /**
   * The underlying renderer's statistics (`render.drawCalls`, `render.triangles`, …).
   *
   * Throws when the running renderer has none — the same fail-closed shape as `setOutputNode` —
   * because a game that cannot count its own draws cannot apply a draw-count lever on evidence.
   */
  get info(): unknown;
  /**
   * Builds and compiles a scene's pipelines before anything draws it.
   *
   * On a phone each distinct shader is compiled the first time something using it is drawn, which
   * happens inside a frame the player is watching: 2,500 ms of a 2,882 ms Pixel 8 cold start sits
   * between the bundle finishing and the first frame reaching the display. Calling this during
   * load moves that cost somewhere the player is already waiting.
   *
   * It is on the wrapper for one reason: without it a game must cast through `.raw` to warm up,
   * and a game that cannot warm up without a cast will not warm up.
   */
  compileAsync(scene: Object3D, camera: Camera, targetScene?: Object3D): Promise<void>;
  /** A warm-up may outlive its caller's timeout; its render targets must remain alive. */
  readonly compiling?: boolean;
  /** Compilation starts, including work that settles entirely between rendered frames. */
  readonly compileCount?: number;
  /** The bounded, fail-closed pipeline observation for this renderer, when enabled. */
  readonly pipelineCensus?: () => IPipelineCensus;
  /** Marks the completion of the renderer's current scene warm-up attempt. */
  warmUpSettled?(): void;
  /** Marks a repeatable streamed warm-up boundary for the next first draw. */
  warmUpScopeSettled?(label: string, target?: Object3D): void;
  /** Performs one covered output-pipeline render without marking first present. */
  warmUpWorldPass?(scene: Object3D, camera: Camera, targetScene?: Object3D): void;
  /**
   * What alpha antialiasing did with the multisampled surface, and why, when it did nothing.
   *
   * MSAA resolves triangle edges; a cutout silhouette is carved inside the triangle by an alpha
   * test and resolves through the coverage mask or not at all. This is where to read whether the
   * samples this surface pays for reach the game's foliage, fences and hair.
   *
   * Optional on the interface for the same reason the render-chain seams are: a stub renderer
   * implements the drawing contract, not every report. `createRenderer` always provides it, and
   * the `TN_ALPHA_ANTIALIASING` marker is printed either way, so nothing is only readable here.
   */
  alphaAntialiasing?: () => IAlphaAntialiasingReport;
  /**
   * The `adapter.info` field value that identifies a CPU rasteriser — `swiftshader`, `llvmpipe`,
   * a `Microsoft Basic Render Driver` — when the adapter named one, else absent.
   *
   * Reading it needs `navigator.gpu`, so it is read here rather than in a game's render source.
   * It is a fact about the machine, not a look: which tier a game runs on a software adapter is
   * that game's own decision, and every tier name it might pick is already in its own
   * `src/render/quality.ts`. What this removes is the reason it could not make that decision
   * before its first expensive frame — a CPU rasteriser running a desktop render chain can lose
   * the device on the very first frame, which no adaptation after it survives.
   *
   * Absent means no software name was found, never that the adapter is hardware. The native host
   * exposes the same four `adapter.info` fields, so the same read works on every target.
   */
  readonly softwareAdapter?: string;
  /**
   * The GPU family the adapter belongs to, the rule that named it and the four raw `adapter.info`
   * fields it was read from; absent when no adapter reported (a WebGL2 fallback).
   *
   * A fact about the machine, like `softwareAdapter`, and the better input for a start tier: it
   * tells a Mali-G52 from a Mali-G715 and an iGPU from a discrete card, where `mobile` and
   * `software` cannot. `unknown` means no rule matched; treat it as the behaviour before this
   * existed. Measurement still outranks it, and the class only picks where the first window starts.
   */
  readonly gpuClass?: IGpuClassification;
  /** Advances the GPU sample once before a presented frame's simulation and render passes. */
  beginFrame?(): void;
  compute(node: unknown, span?: "depthPyramid"): void;
  /** Opt-in synchronous dispatch scope; consumes exact Three-owned query UID membership once resolved. */
  computeTiming?(
    operation: () => unknown,
    options?: { readonly maxCalls?: number },
  ): IComputeTimingReceipt;
  /**
   * Creates the GPU buffers these geometries draw from, through the backend's own attribute path,
   * and reports how many it created.
   *
   * `compileAsync` builds pipelines, not buffers: a streamed mesh's first draw is where its
   * attributes reach the device, and one chunk's first draw measured 230 ms of a frame for it. This
   * moves that to admission, one chunk at a time. WebGPU only — the WebGL fallback has no seam
   * this can call without inventing a GL enum — and absent or throwing answers 0, so the first
   * draw uploads exactly as it did before.
   */
  uploadAttributes?(geometries: Iterable<BufferGeometry>): number;
  /** Exclusive Float32 vec4 storage on the existing WebGPU device; release its receipt on scene exit. */
  storageBuffer?(attribute: StorageBufferAttribute): IStorageBufferLease;
  /**
   * Copies one streamed subtree's textures to the device, through three's own texture path, and
   * reports how many it took.
   *
   * The same argument as `uploadAttributes`, one resource class over: `compileAsync` builds
   * pipelines, not pixels, so a streamed chunk's textures reach the device inside `_renderObjectDirect`
   * on the frame the chunk first draws. On a Machinefall map-walk with three's internals counted per
   * render, that was 87 ms of a 94 ms first draw in one frame, 79 ms of 131 ms in another, and 519 ms
   * in a third — 10 renders of 19,000 hold the whole 2,574 ms the run spends on first draws.
   * `Textures.updateTexture` returns early when the texture is already at its current version, so this
   * is a move rather than a second upload, and a material the world shares with what is already on
   * screen costs one call and no work. WebGPU only — the WebGL fallback has no seam here — and
   * absent or throwing answers 0, so the first draw uploads exactly as it did before.
   */
  uploadTextures?(object: Object3D): number;
  /**
   * Prepares unique cold compressed textures before their first compile or draw. WebGPU uses
   * one upload lane, a measured 2 ms budget and at most 64 KiB per write; one final write may
   * overshoot the time budget. Await this gate before exposing the textures to rendering.
   * Original Texture/GPUTexture identities, formats and mip levels are retained. Cancellation
   * releases this caller's interest; another caller of the same texture may still complete.
   * Ordinary textures and the WebGL fallback retain their existing paths and report no work.
   * `onProgress` receives the completed unique compressed texture count after each preparation
   * promise resolves; queued textures and writes that have not settled receive no credit.
   */
  prepareTextures?(
    textures: Iterable<Texture>,
    signal?: AbortSignal,
    onProgress?: (completed: number) => void,
  ): Promise<number>;
  /**
   * Copies one GPU storage attribute back to the CPU, asynchronously.
   *
   * It is on the wrapper for the same reason `compute` is: the call is WebGPU-only and a game that
   * must cast through `.raw` to read its own simulation will either not read it or read it wrong.
   * The copy is asynchronous by nature — the caller gets the bytes some frames after the frame
   * that produced them, and `GPUReadback` is what turns that latency into a reported number
   * instead of a silent one. Pass a public ReadbackBuffer to own staging cleanup on rejected maps;
   * the returned bytes are copied before the caller disposes that target in finally.
   */
  readback(attribute: unknown, target?: ReadbackBuffer): Promise<ArrayBuffer>;
  /**
   * The scene pass's stored depth attachment and sample count, from an authored pass or three's
   * internal framebuffer target. `undefined` when neither has rendered a depth to read.
   *
   * Optional because a backend that cannot render into a target of its own has no scene-pass depth to
   * hand over. A cull reads this every dispatch: on the frame it answers, the texture holds what the
   * previous frame's pass wrote, because this is asked before the frame draws.
   */
  scenePassDepth?():
    | {
        readonly texture: DepthTexture;
        readonly width: number;
        readonly height: number;
        readonly samples?: number;
      }
    | undefined;
  render(scene: Object3D, camera: Camera): void;
  /** Draws after the world without clearing or passing through the world's output pipeline. */
  renderOverlay(scene: Object3D, camera: Camera): void;
  /** Legacy input-filtered clear; use an installation receipt for same-node replacement safety. */
  clearOutputNode?(expectedNode?: unknown): void;
  /** Creates the core-owned chain seam without making generated render source import the package. */
  createRenderChain?: (options: Omit<IRenderChainOptions, "renderer">) => RenderChain;
  /** Feeds automatic render-chain tiers the completed frame-budget window. */
  observeRenderChainBudget?: (window: IRenderChainBudgetWindow) => void;
  /** Samples render-chain telemetry after the renderer completes a frame. */
  observeRenderChainFrame?: () => void;
  /** Whether the active chain requested core-owned per-object velocity history. */
  renderChainUsesPerObjectVelocity?: () => boolean;
  /** Internal callback used by RenderChain; games should request velocity through the chain. */
  setRenderChainVelocityEnabled?: (enabled: boolean) => void;
  /** Installs a graph; pass the authored world pass when the graph contains auxiliary passes. */
  // The owned renderer returns a unique receipt. Legacy adapters may return void, without
  // installation-level replacement safety; callers still own graph dependency disposal.
  setOutputNode: RenderOutputSetter;
  createResolutionSubrect?: () => IResolutionSubrect;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  /**
   * The GPU time the last resolved frame actually cost, in milliseconds, or `undefined` when the
   * adapter has no `timestamp-query` and there is nothing to report.
   *
   * Every GPU number in this repository's performance record before this was wall-clock algebra:
   * ablate scene content, difference a blocking device poll in a diagnostic build that never
   * ships. This is the measurement itself. Resolving is asynchronous and off the frame path — the
   * caller reads whatever the last resolve produced.
   */
  gpuFrameMs(): number | undefined;
  /** Age in Three.js frame IDs of the resolved render timestamp; absent when unobservable. */
  gpuFrameAge?(): number | undefined;
  /**
   * The last resolved GPU frame's duration and the Three.js frame id it belongs to, or
   * `undefined` when no resolved reading is available.
   *
   * `gpuFrameMs` is that duration alone; the frame id is what tells a reading still in flight
   * from the current frame's cost, so a caller building a per-frame series never measures one
   * resolve twice. Optional like `gpuFrameAge`, for stubs that implement only the drawing
   * contract. `createRenderer` always provides it.
   */
  gpuFrameSample?(): { readonly frame: number; readonly ms: number } | undefined;
  /**
   * Observes complete allocated render-query groups without changing ordinary sampling.
   * Frame IDs are Three query IDs, including any overlay draws; callers map world callbacks.
   * Capacities bound undrained, pending and queued membership. maxQueries counts timestamp
   * slots (two per pass). A failed receipt is sticky and must be disposed before replacement.
   * Requires timestamp-capable WebGPU and its existing asynchronous resolver.
   */
  observeGpuFrames?(options: IGpuFrameObservationOptions): IGpuFrameObservation;
  /**
   * GPU milliseconds of the last resolved compute frame, when the adapter reports one.
   *
   * The compute pool is a separate series from the render pool and `resolveGpuFrame` resolves it,
   * so a GPU simulation's cost is measurable instead of being charged to whatever render frame
   * happened to overlap. `undefined` for a WebGL2 fallback, an adapter without timestamps, or a
   * frame that ran no compute.
   */
  gpuComputeMs?(): number | undefined;
  /** Consume one fresh timestamped pyramid build, including its depth resolve; absent until resolved. */
  gpuPyramidMs?(): number | undefined;
  /**
   * The main render pass's GPU milliseconds, smoothed over fresh resolved samples, or `undefined`
   * while no reading is fresh.
   *
   * `gpuFrameMs` is the whole render pool, main plus every shadow, reflection, post and HUD pass;
   * the adaptive LOD control loop needs the main-pass share alone. `game.ts` splits the resolved
   * frame through the pass recorder and feeds the sample here with {@link noteGpuMainMs}. A
   * repeated frame id is a resolve still in flight and not a new reading, and with no fresh sample
   * for too long the value reads absent, so a caller never adapts on a stale number.
   */
  gpuMainMs?(): number | undefined;
  /**
   * Records one resolved frame's main-pass GPU milliseconds into {@link gpuMainMs}. Called once a
   * frame by `game.ts`; `ms` is `undefined` when the frame attributed no main-pass reading.
   */
  noteGpuMainMs?(ms: number | undefined, frame?: number): void;
  /**
   * The frame rate the game resolved as its target (`resolveTargetFps`), or `undefined` before one
   * is known or when it is uncapped. Budgets that are a share of a frame read it, so a frame that ran
   * faster than the target does not shrink what the next one may spend.
   */
  targetFps?(): number | undefined;
  /** Records the resolved target; called by `game.ts` when it resolves or retargets. */
  noteTargetFps?(fps: number): void;
  /** Starts a resolve of the GPU timestamps for the frames drawn since the last call. */
  resolveGpuFrame(): void;
  /**
   * Moves the drawing-buffer scale, deferring while a compile retains its targets. The adaptive scaler is the only
   * caller; a pinned game never reaches this, which is what makes "pinned" mean pinned.
   */
  setResolutionScale(scale: number, scaleSource: "auto" | "auto-pinned"): void;
  /**
   * What this renderer is actually drawing at. Read once per frame-budget window so every fps
   * number is self-describing; a record and a tree once disagreed about the scale for a whole
   * session because nothing in the measurement could say which one produced it.
   */
  surface(): IFrameSurfaceState;
  /**
   * The drawing buffer height on its own, for a caller that wants one number every frame and no
   * record. Optional so a platform or test double can keep exposing only `surface()`.
   */
  surfaceDrawingBufferHeight?(): number;
  dispose(): void;
}

export interface IRendererPlatformSource {
  createCanvas(): HTMLCanvasElement;
  hasWebGPU(): boolean;
  observeResize(canvas: HTMLCanvasElement, resize: () => void): () => void;
  readSize(canvas: HTMLCanvasElement): readonly [width: number, height: number];
}

export interface IRendererOptions {
  /**
   * Resolves alpha-tested cutout silhouettes — foliage, fences, hair — through the multisample
   * coverage mask instead of a binary `discard`. Defaults to true, and does nothing at all on a
   * single-sampled surface, which it reports rather than pretends. Godot's
   * `alpha_antialiasing_mode`, in Three.js's `alphaToCoverage`.
   */
  alphaAntialiasing?: boolean;
  /** Requests multisample antialiasing from the renderer. Defaults to true. */
  antialias?: boolean;
  /**
   * The tone curve a WebGPU renderer starts with. Defaults to `filmic`, a fresh Unreal 5.8.3
   * project's curve; `aces`, `agx`, `neutral` and `none` (three's linear output) are the named
   * overrides. A renderer that cannot run the curve keeps ACES and reports `TN_TONEMAP`. Setting
   * `renderer.raw.toneMapping` afterwards still wins.
   */
  toneMapping?: RendererToneMapping;
  canvas?: HTMLCanvasElement;
  gpuTimestampFrameInterval?: number;
  preferWebGPU?: boolean;
  /** CSS-pixel multiplier for the drawing buffer. The default is intentional DPR 1. */
  resolutionScale?: number;
  /** Whether the game pinned that scale or the engine chose it. Reported, never inferred. */
  scaleSource?: "pinned" | "auto" | "auto-pinned";
  /**
   * Physical pixels per logical (CSS) pixel of the canvas this draws into. Default: the device's
   * own `devicePixelRatio` on both runtimes (unified 2026-09-01; web's old DPR-1 buffer read as
   * pixelation on any HiDPI display). The resolution scaler composes on top, so an unaffordable
   * density is trimmed by scaler rungs rather than by the developer. An explicit value wins on
   * both runtimes.
   */
  pixelRatio?: number;
  /** Where convention markers go. Defaults to the console, exactly as the render chain reports. */
  report?: (line: string) => void;
  /**
   * Bounded pipeline detail for a real launch capture. It is on by default so a town does not
   * need an instrumented build; pass `false` for an identical-build overhead control.
   */
  pipelineCensus?: false | { readonly limit?: number };
  source?: IRendererPlatformSource;
  webgpuFactory?: (
    canvas: HTMLCanvasElement,
    options: Readonly<{ antialias: boolean }>,
  ) => Promise<unknown> | unknown;
  webgl2Factory?: (canvas: HTMLCanvasElement, options: Readonly<{ antialias: boolean }>) => unknown;
}

type RendererInstance = IStorageBufferSource & {
  autoClear?: boolean;
  /** three's resolved GPU timings; `info.render.timestamp` is milliseconds. */
  info?: {
    frame?: number;
    render?: { timestamp?: number };
    compute?: { timestamp?: number };
  };
  backend?: {
    trackTimestamp?: boolean;
    timestampQueryPool?: Record<string, ITimestampQueryPool | null>;
    /** The backend's own attribute creation, which a compile does not do. */
    createAttribute?: (attribute: unknown) => void;
    createIndexAttribute?: (attribute: unknown) => void;
    getTimestampFrames?: (type: string) => number[];
    createRenderPipeline?: (...args: unknown[]) => unknown;
    createComputePipeline?: (...args: unknown[]) => unknown;
    get?: (value: unknown) => unknown;
    gpu?: {
      requestAdapter?: (options?: unknown) => Promise<unknown> | unknown;
    };
    parameters?: { powerPreference?: unknown };
  };
  xr?: { enabled?: unknown };
  resolveTimestampsAsync?: (type?: string) => Promise<number | undefined>;
  /** Three answers an `antialias` request with a sample count; 0 means one sample per pixel. */
  samples?: number;
  /** Whether the backend owns resizable render targets for retained sub-rectangle rendering. */
  supportsRetainedTargetSubrect?: boolean;
  domElement: HTMLCanvasElement;
  init?: () => Promise<void>;
  compileAsync?: (scene: Object3D, camera: Camera, targetScene?: Object3D) => Promise<void>;
  prepareTextureAsync?: (
    texture: Texture,
    options: { budgetMs: number; maxBytesPerWrite: number; signal: AbortSignal },
  ) => Promise<void>;
  compute?: (node: unknown) => void;
  getArrayBufferAsync?: (
    attribute: unknown,
    target?: ReadbackBuffer,
  ) => Promise<ArrayBuffer | ReadbackBuffer>;
  render: (scene: Object3D, camera: Camera) => void;
  setSize: (width: number, height: number, updateStyle?: boolean) => void;
  dispose?: () => void;
  /** three's per-draw seam, present on the WebGPU renderer and absent on the WebGL2 fallback. */
  getRenderObjectFunction?: () => RenderObjectFunction | null;
  /** three's compile-time render target seam; see the `compileAsync` wrapper. */
  needsFrameBufferTarget?: boolean;
  getRenderTarget?: () => unknown;
  setRenderTarget?: (target: unknown) => void;
  getMRT?: () => unknown;
  setMRT?: (mrt: unknown) => void;
  _getFrameBufferTarget?: () => unknown;
  /** What `getRenderTarget()` answers, and the only honest read while that answer is overridden. */
  _renderTarget?: unknown;
  renderObject?: RenderObjectFunction;
  setRenderObjectFunction?: (renderObjectFunction: RenderObjectFunction) => void;
};

type RenderObjectFunction = (...args: unknown[]) => void;

/** `samples` is the answer, `antialias` was only the request; three reports 0 for one sample. */
function resolveSampleCount(raw: RendererInstance): number {
  return Number.isInteger(raw.samples) && (raw.samples ?? 0) > 0 ? (raw.samples ?? 1) : 1;
}

/**
 * Catch a material the first time the renderer draws with it.
 *
 * Warm-up compiles through three's own `renderObject`, never this one, so this fires only for
 * content that arrived after the last warm-up — whose pipeline is being built for the first time
 * regardless, which is why converting here costs no rebuild. A game that installs its own render
 * object function replaces this one and opts out; the marker still names what was decided.
 */
function installDrawHook(raw: RendererInstance, alphaAntialiasing: AlphaAntialiasing): void {
  if (typeof raw.setRenderObjectFunction !== "function") return;
  const previous = raw.getRenderObjectFunction?.() ?? null;
  const delegate = previous ?? raw.renderObject;
  if (typeof delegate !== "function") return;
  raw.setRenderObjectFunction((...args) => {
    alphaAntialiasing.convertMaterial(args[4]);
    delegate.apply(raw, args);
  });
}

export function readCanvasSize(canvas: HTMLCanvasElement): readonly [number, number] {
  return [
    Math.max(1, canvas.clientWidth || globalThis.innerWidth || 1),
    Math.max(1, canvas.clientHeight || globalThis.innerHeight || 1),
  ];
}

export function observeCanvasResize(canvas: HTMLCanvasElement, resize: () => void): () => void {
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }
  if (typeof globalThis.addEventListener !== "function") return () => undefined;
  globalThis.addEventListener("resize", resize);
  return () => globalThis.removeEventListener("resize", resize);
}

/**
 * Runs one covered render through Three's asynchronous pipeline path.
 *
 * `compileAsync` is the only stock Three entry that hands `PipelineCache.getForRender` a promise
 * list, which is what switches a device create to `createRenderPipelineAsync`. A normal `render()`
 * passes none and therefore creates every missing pipeline synchronously, on the calling thread.
 * The warm-up is a real render because only an output pipeline reaches the post and reflection
 * passes, so it cannot be replaced by `compileAsync`; this lends that render the same promise list
 * through the cache's own seam. A draw whose pipeline is still pending is skipped by
 * `PipelineCache.isReady` — the pending/skip path `compileAsync` already relies on — and the
 * warm-up awaits the whole list before the first visible frame. The frame is invisible behind the
 * startup cover, so a skipped draw costs nothing.
 *
 * Returns `undefined` on a renderer without that cache or without async device creation, which
 * keeps the previous synchronous covered render as the fallback.
 *
 * @internal Exported for the warm-up contract; not part of the public renderer API.
 */
export function beginAsyncPipelines(
  raw: unknown,
): { readonly restore: () => void; readonly settled: () => Promise<void> } | undefined {
  if (!isObject(raw)) return undefined;
  const pipelines = raw._pipelines;
  if (!isObject(pipelines) || typeof pipelines.getForRender !== "function") return undefined;
  const device = isObject(raw.backend) ? raw.backend.device : undefined;
  if (!isObject(device) || typeof device.createRenderPipelineAsync !== "function") return undefined;
  const original = pipelines.getForRender as (...args: unknown[]) => unknown;
  const pending: Promise<unknown>[] = [];
  pipelines.getForRender = function (this: unknown, ...args: unknown[]): unknown {
    const next = [...args];
    if (next.length < 2 || next[1] === undefined || next[1] === null) next[1] = pending;
    return original.apply(this, next);
  };
  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      pipelines.getForRender = original;
    },
    settled: async () => {
      // A failed async creation resolves through Three's own error path and never rejects here;
      // settle every ticket so one refusal cannot hide the compiles that did land.
      await Promise.all(pending.map((ticket) => Promise.resolve(ticket).catch(() => undefined)));
    },
  };
}

function wrapRenderer(
  raw: RendererInstance,
  kind: RendererKind,
  applied: { width: number; height: number },
  state: ISurfaceState,
  reapply: { resize: (() => void) | undefined },
  alphaAntialiasing: AlphaAntialiasing,
  pipelineCensus: PipelineCensus | undefined,
  timestampCapable: boolean,
  timestampFrameInterval: number,
  softwareAdapter?: string,
  gpuClass?: IGpuClassification,
): IRendererLike {
  let outputPipeline: RenderPipeline | undefined;
  // Keep caller identity separately: RenderPipeline may wrap its public output node.
  let outputInput: unknown;
  let outputPass: PassNode | undefined;
  let pendingWorldPassRefresh = false;
  // Nested bloom/temporal quads sample this pass under distinct renderIds.
  const refreshWorldPassOnce = (pass: PassNode | undefined): (() => void) | undefined => {
    if (pass === undefined) return undefined;
    const updateBefore = pass.updateBefore;
    const updateBeforeType = pass.updateBeforeType;
    const hadOwnUpdateBefore = Object.hasOwn(pass, "updateBefore");
    let updated = false;
    pass.updateBeforeType = NodeUpdateType.RENDER;
    pass.updateBefore = function (frame) {
      if (updated) return;
      updated = true;
      updateBefore.call(this, frame);
    };
    return () => {
      pass.updateBeforeType = updateBeforeType;
      if (hadOwnUpdateBefore) pass.updateBefore = updateBefore;
      else Reflect.deleteProperty(pass, "updateBefore");
    };
  };
  let warmOutputTarget: RenderTarget | undefined;
  const renderChains = new Set<RenderChain>();
  let renderChainUsesPerObjectVelocity = false;
  let activeCompiles = 0;
  let compileCount = 0;
  let disposed = false;
  const texturePreparations = new Set<AbortController>();
  const storageBuffers = new StorageBufferLeases(() => raw);
  let computeTimings: ComputeTimingScopes | undefined;
  let pendingScale: { scale: number; source: "auto" | "auto-pinned" } | undefined;
  let pendingSize: Parameters<IRendererLike["setSize"]> | undefined;
  let timestampFrame = -1;
  let timestampFramesManaged = false;
  const pyramidQueries: string[][] = [];
  let gpuObservation: GpuFrameObservation | undefined;
  let gpuObservationGeneration = 0;
  const setTimestampTracking = (): void => {
    // Three advances info.frame only in its own animation loop, which we do not run.
    // Advance once per presented frame: compute, world and overlay share its sample and query id.
    timestampFrame += 1;
    const rawInfo = (raw as { info?: { frame: number } | null }).info;
    if (rawInfo !== undefined && rawInfo !== null) rawInfo.frame = timestampFrame;
    const backend = raw.backend;
    if (!timestampCapable || backend === undefined) return;
    backend.trackTimestamp = timestampFrame % timestampFrameInterval === 0;
  };

  /**
   * The last resolved GPU timestamp and the frame id it belongs to.
   *
   * `info.render.timestamp` alone is the last frame of the most recent resolve batch, and a batch
   * that cleared several frames at once loses all but its last. The id is what lets the frame
   * budget tell a reading still in flight from the current frame's cost instead of pushing the
   * same lagged sample every frame. `backend.getTimestampFrames("render")` is Three's tracked
   * resolved-frame list; its last entry is the sample, matching `gpuFrameAge`.
   */
  /**
   * The engine's own frame id once it has rendered. Three's `init()` starts its own rAF loop, which
   * writes `info.frame = nodeFrame.frameId` every animation frame, so `info.frame` read between
   * renders can be that smaller counter while the timestamp queries carry this one.
   */
  const currentFrame = (): number | undefined =>
    timestampFrame >= 0 ? timestampFrame : raw.info?.frame;
  const gpuFrameSample = (): { frame: number; ms: number } | undefined => {
    const frame = currentFrame();
    const frames = raw.backend?.getTimestampFrames?.("render");
    const sampled = frames?.[frames.length - 1];
    const timestamp = raw.info?.render?.timestamp;
    if (
      frame === undefined ||
      sampled === undefined ||
      !Number.isInteger(frame) ||
      !Number.isInteger(sampled) ||
      sampled < 0 ||
      frame < sampled ||
      typeof timestamp !== "number" ||
      !Number.isFinite(timestamp) ||
      timestamp <= 0
    )
      return undefined;
    return { frame: sampled, ms: timestamp };
  };

  /**
   * A warm-up or a pass can leave a target bound with nothing left to restore it, and
   * `getRenderTarget()` answers null across that overlap, so read the field. Pipelines restore their
   * own offscreen targets, so only the surface paths need this.
   */
  const bindSurface = (): void => {
    if (typeof raw.setRenderTarget !== "function") return;
    const bound = "_renderTarget" in raw ? raw._renderTarget : raw.getRenderTarget?.();
    if (bound === null || bound === undefined) return;
    raw.setRenderTarget(null);
  };

  let renderingFrame = 0;
  const renderFrame = (scene: Object3D, camera: Camera): void => {
    pipelineCensus?.beginWorldFrame(scene);
    const refreshPass = pendingWorldPassRefresh ? outputPass : undefined;
    const restoreWorldPass = refreshWorldPassOnce(refreshPass);
    let completed = false;
    try {
      bindSurface();
      if (outputPipeline === undefined) raw.render(scene, camera);
      else {
        // RenderPipeline.render() has no scene argument and PassNode keeps the scene it captured
        // when the graph was built. Retarget only the authored world pass at the root the wrapper
        // is rendering so a projection mirror and its velocity history remain the same input.
        setOutputPipelineRoot(outputPass, scene, camera);
        outputPipeline.render();
      }
      if (refreshPass !== undefined) pendingWorldPassRefresh = false;
      pipelineCensus?.firstPresent();
      completed = true;
    } finally {
      restoreWorldPass?.();
      pipelineCensus?.endWorldFrame(scene, completed);
    }
  };
  let overlayReported = false;
  const renderOverlayFrame = (scene: Object3D, camera: Camera): void => {
    bindSurface();
    // The owned engine draws an overlay over the presented frame with no post, no temporal step and
    // no tone curve; through its render() the loading screen moved the world's temporal history and
    // exposure (a ghosted hand-off).
    const overlay = (raw as { renderOverlay?: (scene: Object3D, camera: Camera) => void })
      .renderOverlay;
    // The canvas layer is UI, and UI composites after the tone curve, as Unreal draws Slate onto the
    // already tone-mapped back buffer (UE 5.8.3: Engine/Source/Runtime/SlateRHIRenderer/Private/
    // SlateRHIRenderer.cpp:986 and :1032). Reported, because three's WebGPURenderer cannot: it tone
    // maps the canvas layer and the world below it in one output pass over a shared frame buffer.
    if (!overlayReported) {
      overlayReported = true;
      console.log(
        `TN_CANVAS_LAYER:${JSON.stringify(
          overlay !== undefined
            ? { toneMapping: "none", composite: "after the tone curve" }
            : { toneMapping: "renderer", composite: "with the world in three's output pass" },
        )}`,
      );
    }
    if (overlay !== undefined) {
      overlay.call(raw, scene, camera);
      return;
    }
    const hadOwnAutoClear = Object.hasOwn(raw, "autoClear");
    const autoClear = raw.autoClear;
    raw.autoClear = false;
    try {
      raw.render(scene, camera);
    } finally {
      if (hadOwnAutoClear) raw.autoClear = autoClear;
      else Reflect.deleteProperty(raw, "autoClear");
    }
  };
  // The main pass's own GPU series, fed a frame at a time by `game.ts` because only the pass
  // recorder can attribute the render pool to its main call. Half/half smoothing, and a short
  // freshness window: the adaptive LOD loop reads this every half second and must not act on a
  // resolve that stopped landing.
  const mainSmoothing = 0.5;
  const mainStaleLimit = 8;
  let gpuMainEma: number | undefined;
  let targetFps: number | undefined;
  let gpuMainStaleFrames = 0;
  let gpuMainLastFrame: number | undefined;
  const noteGpuMainMs = (ms: number | undefined, frame?: number): void => {
    const stale = (): void => {
      gpuMainStaleFrames += 1;
      if (gpuMainStaleFrames >= mainStaleLimit) gpuMainEma = undefined;
    };
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
      stale();
      return;
    }
    // A repeated frame id is the previous resolve still in flight, not a new reading.
    if (frame !== undefined && frame === gpuMainLastFrame) {
      stale();
      return;
    }
    if (frame !== undefined) gpuMainLastFrame = frame;
    gpuMainStaleFrames = 0;
    gpuMainEma = gpuMainEma === undefined ? ms : gpuMainEma + (ms - gpuMainEma) * mainSmoothing;
  };
  const wrapped: IRendererLike = {
    get compileCount() {
      return compileCount;
    },
    get compiling() {
      return activeCompiles > 0;
    },
    ...(pipelineCensus === undefined ? {} : { pipelineCensus: () => pipelineCensus.snapshot() }),
    ...(pipelineCensus === undefined
      ? {}
      : { warmUpSettled: () => pipelineCensus.warmUpSettled() }),
    ...(pipelineCensus === undefined
      ? {}
      : {
          warmUpScopeSettled: (label: string, target?: Object3D) =>
            pipelineCensus.warmUpScopeSettled(label, target),
        }),
    get warmUpWorldPass() {
      if (outputPipeline === undefined) return undefined;
      const drawOnce = (
        scene: Object3D,
        camera: Camera,
        targetScene?: Object3D,
      ): void | Promise<void> => {
        const outputRoot = targetScene ?? scene;
        const scoped = targetScene !== undefined && targetScene !== scene;
        const previousPassScene = outputPass?.scene;
        const previousPassCamera = outputPass?.camera;
        let restoreWorldPass: (() => void) | undefined;
        let asyncPipelines:
          | { readonly restore: () => void; readonly settled: () => Promise<void> }
          | undefined;
        const warmRenderer = raw as RendererInstance &
          ThreeRenderer & {
            contextNode?: unknown;
            opaque?: boolean;
            transparent?: boolean;
          };
        const rendererState = RendererUtils.saveRendererState(warmRenderer);
        // An in-flight compile exposes a virtual target through the getter; restore the bound one.
        if ("_renderTarget" in raw)
          rendererState.renderTarget = Reflect.get(
            raw,
            "_renderTarget",
          ) as typeof rendererState.renderTarget;
        const hadOwnTransparent = Object.hasOwn(raw, "transparent");
        const hadOwnOpaque = Object.hasOwn(raw, "opaque");
        const hadOwnContextNode = Object.hasOwn(raw, "contextNode");
        const previousTransparent = Reflect.get(raw, "transparent");
        const previousOpaque = Reflect.get(raw, "opaque");
        const previousContextNode = Reflect.get(raw, "contextNode");
        const previousXr = warmRenderer.xr;
        const hadOwnXrEnabled = previousXr !== undefined && Object.hasOwn(previousXr, "enabled");
        const previousXrEnabled =
          previousXr === undefined ? undefined : Reflect.get(previousXr, "enabled");
        const hadOwnSceneOverrideMaterial = Object.hasOwn(scene, "overrideMaterial");
        const hadOwnOutputRootOverrideMaterial = Object.hasOwn(outputRoot, "overrideMaterial");
        const previousSceneName = scene.name;
        const previousOutputRootName = outputRoot.name;
        const previousSceneOverrideMaterial = Reflect.get(scene, "overrideMaterial");
        const previousOutputRootOverrideMaterial = Reflect.get(outputRoot, "overrideMaterial");
        const previousCameraMask = camera.layers.mask;
        const restoreField = (
          object: object,
          key: string,
          hadOwn: boolean,
          value: unknown,
        ): void => {
          if (hadOwn) Reflect.set(object, key, value);
          else Reflect.deleteProperty(object, key);
        };
        const originalParent = scene.parent;
        const originalMatrix = scene.matrix.clone();
        const originalMatrixWorld = scene.matrixWorld.clone();
        const attached = scoped && !isInObject3DSubtree(outputRoot, scene);
        if (attached) outputRoot.add(scene);
        renderingFrame += 1;
        try {
          if (scoped && outputPass !== undefined) {
            restoreWorldPass = refreshWorldPassOnce(outputPass);
            pendingWorldPassRefresh = true;
          }
          if (scoped) {
            if (raw.setRenderTarget === undefined)
              throw new Error(
                "TN_WARMUP_OFFSCREEN_TARGET_UNAVAILABLE: scoped world warm-up needs a render target seam.",
              );
            warmOutputTarget ??= new RenderTarget(1, 1);
            raw.setRenderTarget(warmOutputTarget);
          } else bindSurface();
          setOutputPipelineRoot(outputPass, outputRoot, camera);
          asyncPipelines = beginAsyncPipelines(raw);
          outputPipeline?.render();
        } finally {
          renderingFrame -= 1;
          asyncPipelines?.restore();
          if (outputPass !== undefined) {
            outputPass.scene = previousPassScene as Object3D;
            outputPass.camera = previousPassCamera as Camera;
            restoreWorldPass?.();
          }
          RendererUtils.restoreRendererState(warmRenderer, rendererState);
          restoreField(raw, "transparent", hadOwnTransparent, previousTransparent);
          restoreField(raw, "opaque", hadOwnOpaque, previousOpaque);
          restoreField(raw, "contextNode", hadOwnContextNode, previousContextNode);
          if (previousXr !== undefined)
            restoreField(previousXr, "enabled", hadOwnXrEnabled, previousXrEnabled);
          restoreField(
            scene,
            "overrideMaterial",
            hadOwnSceneOverrideMaterial,
            previousSceneOverrideMaterial,
          );
          restoreField(
            outputRoot,
            "overrideMaterial",
            hadOwnOutputRootOverrideMaterial,
            previousOutputRootOverrideMaterial,
          );
          scene.name = previousSceneName;
          outputRoot.name = previousOutputRootName;
          camera.layers.mask = previousCameraMask;
          if (attached) {
            outputRoot.remove(scene);
            if (originalParent !== null) originalParent.add(scene);
          }
          scene.matrix.copy(originalMatrix);
          scene.matrixWorld.copy(originalMatrixWorld);
        }
        // Every pipeline this covered render requested now exists in the renderer's caches, so the
        // first visible frame finds them instead of compiling them synchronously. A renderer with
        // no async cache still returns synchronously, exactly as before.
        return asyncPipelines?.settled();
      };
      return (scene: Object3D, camera: Camera, targetScene?: Object3D): void | Promise<void> =>
        drawPastFrameGate(raw, () => drawOnce(scene, camera, targetScene));
    },
    gpuFrameMs: () => gpuFrameSample()?.ms,
    gpuFrameAge: () => {
      const sample = gpuFrameSample();
      const frame = currentFrame();
      if (sample === undefined || frame === undefined || !Number.isInteger(frame)) return undefined;
      // A fulfilled resolve may return the pool's lastValue on failure. The successful query's
      // frame ID, not the promise or a changed duration, is the evidence of freshness.
      return frame - sample.frame;
    },
    gpuFrameSample,
    observeGpuFrames: (options) => {
      if (
        disposed ||
        kind !== "webgpu" ||
        !timestampCapable ||
        typeof raw.resolveTimestampsAsync !== "function" ||
        // Three's backend creates the pool record at construction; a backend without it (the owned web
        // engine's facade) never allocates one, so an observer would wait on it forever.
        raw.backend === undefined ||
        !("timestampQueryPool" in raw.backend)
      )
        throw new Error("TN_GPU_FRAME_OBSERVATION_UNSUPPORTED");
      if (gpuObservation !== undefined && gpuObservation.status().state !== "disposed")
        throw new Error("TN_GPU_FRAME_OBSERVATION_ALREADY_ACTIVE");
      gpuObservation = new GpuFrameObservation(
        ++gpuObservationGeneration,
        timestampFrame + 1,
        () => raw.backend?.timestampQueryPool?.render,
        () => timestampFrame,
        options,
      );
      return gpuObservation;
    },
    gpuMainMs: () => gpuMainEma,
    noteGpuMainMs,
    targetFps: () => targetFps,
    noteTargetFps: (fps: number) => {
      targetFps = Number.isFinite(fps) && fps > 0 ? fps : undefined;
    },
    gpuComputeMs: () => {
      const timestamp = raw.info?.compute?.timestamp;
      // Three writes `0` before the first resolve and on a failed one, so a non-positive value is
      // no reading rather than a frame that cost nothing.
      return typeof timestamp === "number" && Number.isFinite(timestamp) && timestamp > 0
        ? timestamp
        : undefined;
    },
    gpuPyramidMs: () => {
      const timestamps = raw.backend?.timestampQueryPool?.compute?.timestamps;
      if (timestamps === undefined) return undefined;
      for (const [index, uids] of pyramidQueries.entries()) {
        const values = uids.map((uid) => timestamps.get(uid));
        if (values.some((ms) => ms === undefined || !Number.isFinite(ms) || ms < 0)) continue;
        pyramidQueries.splice(index, 1);
        return values.reduce<number>((sum, ms) => sum + (ms ?? 0), 0);
      }
      return undefined;
    },
    resolveGpuFrame: () => {
      // Fire and forget: a rejected resolve means this adapter has no timestamps, which is a
      // reported absence rather than a frame-time error.
      const resolveTimestampsAsync = raw.resolveTimestampsAsync;
      if (resolveTimestampsAsync === undefined) return;
      const observationBatch =
        gpuObservation !== undefined && raw.backend?.trackTimestamp === true
          ? gpuObservation.capture()
          : undefined;
      void resolveTimestampsAsync.call(raw)?.catch(() => undefined);
      gpuObservation?.submitted(observationBatch);
      // Three maintains independent 2,048-query pools for render and compute passes. Resolving
      // only the default render pool lets GPU simulations exhaust the compute pool even when the
      // render pool is healthy, after which the adapter can be lost instead of merely reporting
      // an absent timestamp.
      void resolveTimestampsAsync.call(raw, "compute")?.catch(() => undefined);
    },
    setResolutionScale: (scale, scaleSource) => {
      if (disposed) return;
      // Three's asynchronous compile retains a depth target across yields. Resizing here
      // disposes it before pipeline creation reads its format. Keep the latest request only.
      if (activeCompiles > 0) {
        pendingScale = { scale, source: scaleSource };
        return;
      }
      state.resolutionScale = scale;
      state.scaleSource = scaleSource;
      reapply.resize?.();
    },
    surface: () => ({
      // The renderer cannot be at a floor it does not know about; the loop that owns the scaler
      // overrides this when one exists.
      atFloor: false,
      ...(activeCompiles > 0 ? { compiling: true } : {}),
      drawingBufferHeight: applied.height,
      drawingBufferWidth: applied.width,
      resolutionScale: state.resolutionScale,
      ...(raw.supportsRetainedTargetSubrect === false
        ? { resolutionSubrect: false }
        : state.resolutionSubrect?.active === true
          ? { resolutionSubrect: true }
          : {}),
      // Three reports 0 for a single sample per pixel; a sample count of zero would describe no
      // image at all.
      sampleCount: resolveSampleCount(raw),
      scaleSource: state.scaleSource,
    }),
    surfaceDrawingBufferHeight: () => applied.height,
    alphaAntialiasing: () => alphaAntialiasing.report(),
    ...(softwareAdapter === undefined ? {} : { softwareAdapter }),
    ...(gpuClass === undefined ? {} : { gpuClass }),
    domElement: raw.domElement,
    kind,
    raw,
    get info() {
      const info = (raw as { info?: unknown }).info;
      if (info === undefined || info === null)
        throw new Error(`info is unavailable on the ${kind} renderer.`);
      return info;
    },
    compileAsync: async (scene, camera, targetScene) => {
      if (disposed) return;
      // Before the compile, never after: three builds a pipeline from `alphaToCoverage` and
      // rebuilds it when the flag moves, so converting afterwards would throw away the warm-up
      // this call exists to buy. Ahead of the WebGL guard below for the same reason — the
      // fallback renderer honours the flag too, and this is the only hook it has.
      alphaAntialiasing.convertTree(scene);
      // WebGL has no equivalent and needs none — it compiles on first draw either way. Resolving
      // rather than throwing keeps one warm-up call working on every renderer a game may get.
      if (typeof raw.compileAsync !== "function") return;
      const hiddenRoots: Object3D[] = [];
      if (typeof scene.traverse === "function") {
        scene.traverse((object) => {
          if (prewarmedRoots.has(object) && hasHiddenAncestor(object)) hiddenRoots.push(object);
        });
      }
      const compileTargetScene = targetScene ?? scene;
      // three's `compile()` picks the frame-buffer target for its render context but never binds it
      // (`Renderer.js:908`, unlike `_renderScene`'s `setRenderTarget`). Inside one compile that
      // leaves a viewport-depth copy destination sized from that target's `samples` (4) while the
      // bind group layout for the same binding is sized from `currentSamples` (0): Dawn refuses the
      // bind group, the command buffer carrying it is invalid, and the device is lost the first
      // time a material samples depth under warm-up.
      //
      // The two halves disagree through one accessor. `getTextureSampleData` asks
      // `renderer.getRenderTarget()` for a depth texture that carries no target of its own
      // (`WebGPUUtils.js:112`), while the copy destination is built from the target `compile()`
      // already chose. So this answers that question and nothing else: `_renderTarget` is left
      // alone, because `render()` reads the field directly and this compile deliberately yields to
      // the frame loop between objects (`Renderer.js:1062`, `await yieldToMain()`). Binding the
      // target instead would put the live loading screen's frames into the frame-buffer target for
      // the whole warm-up, which is a frozen screen and a worse bug than the one being fixed.
      const previousGetRenderTarget = raw.getRenderTarget;
      const overrideTarget =
        raw.needsFrameBufferTarget === true &&
        typeof previousGetRenderTarget === "function" &&
        typeof raw._getFrameBufferTarget === "function" &&
        previousGetRenderTarget.call(raw) === null
          ? raw._getFrameBufferTarget()
          : undefined;
      const hadOwnGetRenderTarget = Object.hasOwn(raw, "getRenderTarget");
      const boundBeforeCompile =
        (previousGetRenderTarget as (() => unknown) | undefined)?.call(raw) ?? null;
      if (overrideTarget !== undefined) {
        // Only the compile may see it. A frame rendered inside this window must get the real
        // answer, because three's own reflector saves `getRenderTarget()` at the top of its
        // `updateBefore` and restores what it saved: handed the frame-buffer target, it puts the
        // frame-buffer target back, and from that frame on the renderer draws into it instead of
        // the swapchain. Measured on a game with a water reflection — the swapchain image was
        // never acquired again, presents froze at 137 while the loop ran at 59 fps, and the window
        // showed the same loading screen for the rest of the session.
        raw.getRenderTarget = () =>
          (previousGetRenderTarget as () => unknown).call(raw) ??
          (renderingFrame > 0 ? null : overrideTarget);
      }
      activeCompiles += 1;
      compileCount += 1;
      try {
        for (const root of hiddenRoots) {
          if (disposed) return;
          await raw.compileAsync(root, camera, compileTargetScene);
          prewarmedRoots.delete(root);
        }
        if (!disposed) {
          if (targetScene === undefined) await raw.compileAsync(scene, camera);
          else await raw.compileAsync(scene, camera, targetScene);
        }
      } finally {
        if (overrideTarget !== undefined) {
          if (hadOwnGetRenderTarget) raw.getRenderTarget = previousGetRenderTarget;
          else Reflect.deleteProperty(raw as object, "getRenderTarget");
          // Put back the target that was bound when this compile started.
          //
          // three's compile runs node `updateBefore` hooks, and a reflector's saves
          // `renderer.getRenderTarget()`, draws its mirror, and restores what it saved. Inside the
          // window above that answer is the frame-buffer target, so the reflector *binds* it and
          // leaves it bound: from the next frame on the renderer draws into that target instead of
          // the swapchain, the swapchain image is never acquired again, and the window keeps
          // showing whatever was on it. Measured on a game with a water reflection — presents
          // frozen at 137 while the loop ran at 59 fps, with `TN_FRAME_NOT_PRESENTED`
          // (`texture:false`) every frame for the rest of the session.
          const boundNow = (previousGetRenderTarget as () => unknown).call(raw);
          if (boundNow === overrideTarget && typeof raw.setRenderTarget === "function")
            raw.setRenderTarget(boundBeforeCompile);
        }
        activeCompiles -= 1;
        if (activeCompiles === 0) {
          const requestedScale = pendingScale;
          const requestedSize = pendingSize;
          pendingScale = undefined;
          pendingSize = undefined;
          if (!disposed) {
            // Re-read the latest viewport when scale also changed; a queued old-scale size
            // must not overwrite the new drawing buffer.
            if (requestedScale !== undefined)
              wrapped.setResolutionScale(requestedScale.scale, requestedScale.source);
            else if (requestedSize !== undefined) wrapped.setSize(...requestedSize);
          }
        }
      }
    },
    beginFrame: () => {
      timestampFramesManaged = true;
      setTimestampTracking();
    },
    compute: (node, span) => {
      if (kind !== "webgpu") throw new Error(`compute is unavailable on the ${kind} renderer.`);
      if (typeof raw.compute !== "function")
        throw new Error("webgpu renderer does not expose compute().");
      // As a standalone draw: a caller that does not manage frames with beginFrame() gets one
      // sampler frame per dispatch, which is what the compute timing scope keys its calls by.
      if (!timestampFramesManaged) setTimestampTracking();
      const backend = raw.backend;
      const before = backend?.timestampQueryPool?.compute?.queryOffsets?.size ?? 0;
      raw.compute(node);
      if (span === "depthPyramid") {
        const offsets = backend?.timestampQueryPool?.compute?.queryOffsets;
        const uids = offsets === undefined ? [] : [...offsets.keys()].slice(before);
        if (uids.length > 0) pyramidQueries.push(uids);
        // Match the render-pass recorder's bounded query retention on a stalled resolve.
        if (pyramidQueries.length > 64) pyramidQueries.shift();
      }
    },
    computeTiming: (operation, options) => {
      if (disposed) throw new Error("TN_COMPUTE_TIMING_STALE: renderer disposed.");
      computeTimings ??= new ComputeTimingScopes(() => raw);
      return computeTimings.capture(operation, options);
    },
    uploadAttributes: (geometries) => {
      const backend = kind === "webgpu" ? raw.backend : undefined;
      if (typeof backend?.createAttribute !== "function") return 0;
      let created = 0;
      try {
        for (const geometry of geometries) {
          for (const attribute of Object.values(geometry.attributes)) {
            backend.createAttribute(attribute);
            created += 1;
          }
          const index = geometry.getIndex();
          if (index !== null && typeof backend.createIndexAttribute === "function") {
            backend.createIndexAttribute(index);
            created += 1;
          }
        }
      } catch {
        // A backend that will not take an attribute is a device that has already lost; the frame
        // that needs it tries again there, where the error belongs.
      }
      return created;
    },
    prepareTextures: async (textures, signal, onProgress) => {
      if (disposed) throw new Error("Renderer disposed during texture preparation.");
      if (kind !== "webgpu") return 0;
      const unique = new Set(
        [...textures].filter(
          (texture) => "isCompressedTexture" in texture && texture.isCompressedTexture === true,
        ),
      );
      if (unique.size === 0) return 0;
      if (typeof raw.prepareTextureAsync !== "function")
        throw new Error("WebGPU renderer lacks bounded compressed texture preparation.");
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      texturePreparations.add(controller);
      let completed = 0;
      try {
        for (const texture of unique) {
          if (controller.signal.aborted) throw controller.signal.reason;
          await raw.prepareTextureAsync(texture, {
            budgetMs: 2,
            maxBytesPerWrite: 65_536,
            signal: controller.signal,
          });
          completed += 1;
          onProgress?.(completed);
        }
        return unique.size;
      } finally {
        texturePreparations.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
    scenePassDepth: () => {
      // Three's implicit depth is in Textures.updateRenderTarget's data, not target.depthTexture.
      // Never fall through to presentation depth: the output blit does not draw the world there.
      // Read the existing attachment without creating a target or claiming texture bookkeeping.
      const host = raw as {
        needsFrameBufferTarget?: boolean;
        _getFrameBufferTarget?: () => {
          depthTexture?: DepthTexture | null;
          samples?: number;
        } | null;
        _textures?: { get(t: unknown): { depthTexture?: DepthTexture | null } };
      };
      const target =
        outputPass?.renderTarget ??
        (host.needsFrameBufferTarget === true ? host._getFrameBufferTarget?.() : undefined);
      if (!target) return undefined;
      const texture = host._textures?.get(target).depthTexture ?? target.depthTexture;
      if (!texture) return undefined;
      const width = texture.image.width ?? 0;
      const height = texture.image.height ?? 0;
      if (width < 2 || height < 2) return undefined;
      return { height, texture, width, samples: Math.max(1, target.samples ?? 1) };
    },
    uploadTextures: (object) => {
      // three's own texture path, not the backend's: `Textures.updateTexture` owns the bookkeeping
      // (`initialized`, `generation`, the bind groups to invalidate) that is what makes the first draw
      // skip the upload, and a backend call without it would upload twice.
      const textures = (raw as { _textures?: { updateTexture?: (t: unknown, o: object) => void } })
        ._textures;
      if (kind !== "webgpu" || typeof textures?.updateTexture !== "function") return 0;
      const pending = new Set<unknown>();
      object.traverse((node) => {
        const material = (node as { material?: unknown }).material;
        if (material === undefined || material === null) return;
        for (const entry of Array.isArray(material) ? material : [material]) {
          if (typeof entry !== "object" || entry === null) continue;
          // A material's texture slots are own enumerable values and a `ShaderMaterial`'s live ones
          // are in `uniforms`; both are found by reading the value and asking whether it is a texture.
          for (const value of Object.values(entry as Record<string, unknown>)) {
            if ((value as { isTexture?: boolean } | null)?.isTexture === true) pending.add(value);
          }
          for (const uniform of Object.values(
            (entry as { uniforms?: Record<string, { value?: unknown }> }).uniforms ?? {},
          )) {
            if ((uniform?.value as { isTexture?: boolean } | null)?.isTexture === true)
              pending.add(uniform.value);
          }
        }
      });
      let created = 0;
      try {
        for (const texture of pending) {
          // `updateTexture` fills width, height, mip levels and the image list into the options it is
          // handed, so each texture needs an object of its own.
          textures.updateTexture?.(texture, {});
          created += 1;
        }
      } catch {
        // A device that will not take the texture takes it on the frame that needs it, where the
        // error belongs.
      }
      return created;
    },
    storageBuffer: (attribute) => storageBuffers.allocate(attribute),
    readback: async (attribute, target) => {
      if (kind !== "webgpu") throw new Error(`readback is unavailable on the ${kind} renderer.`);
      if (typeof raw.getArrayBufferAsync !== "function")
        throw new Error("webgpu renderer does not expose getArrayBufferAsync().");
      if (
        target !== undefined &&
        (!(target instanceof ReadbackBuffer) ||
          !Number.isSafeInteger(target.maxByteLength) ||
          target.maxByteLength <= 0 ||
          target.maxByteLength % 4 !== 0 ||
          target.buffer !== null)
      )
        throw new Error(
          "TN_READBACK_TARGET_INVALID: a fresh aligned public ReadbackBuffer is required.",
        );
      const result = await raw.getArrayBufferAsync(attribute, target);
      if (target === undefined) {
        if (!(result instanceof ArrayBuffer))
          throw new Error("TN_READBACK_RESULT_INVALID: CPU bytes are absent.");
        return result;
      }
      if (
        result !== target ||
        !(target.buffer instanceof ArrayBuffer) ||
        target.buffer.byteLength > target.maxByteLength
      )
        throw new Error(
          "TN_READBACK_RESULT_INVALID: caller-owned target did not receive bounded CPU bytes.",
        );
      return target.buffer.slice(0);
    },
    dispose: () => {
      computeTimings?.dispose();
      if (disposed) {
        storageBuffers.dispose();
        return;
      }
      disposed = true;
      state.resolutionSubrect?.deactivate?.();
      state.resolutionSubrect = undefined;
      for (const preparation of texturePreparations)
        preparation.abort(new Error("Renderer disposed during texture preparation."));
      texturePreparations.clear();
      gpuObservation?.dispose();
      gpuObservation = undefined;
      pendingScale = undefined;
      pendingSize = undefined;
      for (const chain of renderChains) chain.dispose();
      renderChains.clear();
      renderChainUsesPerObjectVelocity = false;
      outputPipeline?.dispose();
      pendingWorldPassRefresh = false;
      outputPipeline = undefined;
      warmOutputTarget?.dispose();
      warmOutputTarget = undefined;
      outputInput = undefined;
      outputPass = undefined;
      pipelineCensus?.dispose();
      try {
        storageBuffers.dispose();
      } finally {
        raw.dispose?.();
      }
    },
    render: (scene, camera) => {
      // Standalone render callers retain one frame per draw unless they supply beginFrame().
      if (!timestampFramesManaged) setTimestampTracking();
      renderingFrame += 1;
      try {
        renderFrame(scene, camera);
      } finally {
        renderingFrame -= 1;
      }
    },
    renderOverlay: (scene, camera) => {
      renderingFrame += 1;
      try {
        renderOverlayFrame(scene, camera);
      } finally {
        renderingFrame -= 1;
      }
    },
    ...(raw.supportsRetainedTargetSubrect === false
      ? {}
      : { createResolutionSubrect: () => new ResolutionSubrect() }),
    setOutputNode: (node, worldPass, options) => {
      if (kind !== "webgpu")
        throw new Error(`setOutputNode is unavailable on the ${kind} renderer.`);
      const nextOutputPass = selectOutputPass(node, worldPass);
      const nextPipeline = new RenderPipeline(
        raw as unknown as ConstructorParameters<typeof RenderPipeline>[0],
        node as ConstructorParameters<typeof RenderPipeline>[1],
      );
      // The pipeline applies the tone curve and the output encode by default. A stage that took
      // the transform over applies it itself, so the pipeline must not apply a second one.
      if (options?.outputColorTransform !== undefined) {
        nextPipeline.outputColorTransform = options.outputColorTransform;
      }
      if (state.resolutionSubrect !== options?.resolutionSubrect)
        state.resolutionSubrect?.deactivate?.();
      state.resolutionSubrect = options?.resolutionSubrect;
      state.resolutionSubrect?.activate?.(state.resolutionScale);
      outputPipeline?.dispose();
      pendingWorldPassRefresh = false;
      outputPass = nextOutputPass;
      outputPipeline = nextPipeline;
      outputInput = node;
      reapply.resize?.();
      return {
        isCurrent: () => outputPipeline === nextPipeline,
        dispose: () => {
          if (outputPipeline !== nextPipeline) return;
          pendingWorldPassRefresh = false;
          outputPipeline = undefined;
          outputInput = undefined;
          outputPass = undefined;
          nextPipeline.dispose();
          state.resolutionSubrect?.deactivate?.();
          state.resolutionSubrect = undefined;
          reapply.resize?.();
        },
      };
    },
    clearOutputNode: (expectedNode) => {
      if (expectedNode !== undefined && expectedNode !== outputInput) return;
      outputPipeline?.dispose();
      pendingWorldPassRefresh = false;
      outputPipeline = undefined;
      outputInput = undefined;
      outputPass = undefined;
      state.resolutionSubrect?.deactivate?.();
      state.resolutionSubrect = undefined;
      reapply.resize?.();
    },
    renderChainUsesPerObjectVelocity: () => renderChainUsesPerObjectVelocity,
    setRenderChainVelocityEnabled: (enabled) => {
      renderChainUsesPerObjectVelocity = enabled;
    },
    createRenderChain: (options) => {
      // One renderer has one output pipeline. Disposing the previous chain prevents an old scene's
      // automatic tier from reinstalling its graph after a scene transition.
      for (const chain of renderChains) chain.dispose();
      renderChains.clear();
      const chain = new RenderChain(wrapped, options);
      renderChains.add(chain);
      return chain;
    },
    observeRenderChainBudget: (window) => {
      for (const chain of renderChains) {
        if (chain.disposed) {
          renderChains.delete(chain);
          continue;
        }
        chain.observeFrameBudget(window);
      }
    },
    observeRenderChainFrame: () => {
      for (const chain of renderChains) {
        if (chain.disposed) {
          renderChains.delete(chain);
          continue;
        }
        chain.observeFrame();
      }
    },
    setSize: (width, height, updateStyle = false) => {
      if (disposed) return;
      if (activeCompiles > 0) {
        pendingSize = [width, height, updateStyle];
        return;
      }
      raw.setSize(width, height, updateStyle);
      applied.width = width;
      applied.height = height;
    },
  };
  return wrapped;
}

function isOutputPassNode(node: unknown): node is PassNode {
  return isObject(node) && node.isPassNode === true;
}

/** How long a covered warm-up draw waits for the GPU to take a frame before it fails. */
const FRAME_GATE_WAIT_MS = 5000;

/** Cumulative render() calls the renderer declined to draw (the Wasm web engine's frame gate), when it counts them. */
export function rendererFrameGateSkips(raw: unknown): number | undefined {
  const info = (raw as { info?: { engine?: { frameGateSkips?: unknown } } } | null)?.info;
  const skips = info?.engine?.frameGateSkips;
  return typeof skips === "number" && Number.isFinite(skips) ? skips : undefined;
}

/**
 * Runs a covered warm-up draw until the renderer takes it. The Wasm web engine's frame gate declines
 * a draw while two frames are still on the GPU, and a declined draw compiles nothing: on Lantern Vale
 * the startup pass was declined, so the TRAA, aux and post pipelines (92) compiled synchronously
 * 1.1 s after the reveal and stalled the queue for 2.3 s. A renderer with no gate, or one that took
 * the first draw, returns that draw's result unchanged.
 */
export function drawPastFrameGate(
  raw: unknown,
  draw: () => void | Promise<void>,
  waitMs = FRAME_GATE_WAIT_MS,
): void | Promise<void> {
  const before = rendererFrameGateSkips(raw);
  const first = draw();
  if (before === undefined || rendererFrameGateSkips(raw) === before) return first;
  const now = (): number => globalThis.performance?.now() ?? Date.now();
  return (async () => {
    await first;
    // The wait starts once the declined draw settled, so a slow settle does not use up the retries.
    const deadline = now() + waitMs;
    while (now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 16));
      const skips = rendererFrameGateSkips(raw);
      const drawn = draw();
      if (rendererFrameGateSkips(raw) === skips) return drawn;
      await drawn;
    }
    throw new Error(
      `TN_WARMUP_FRAME_GATE: the covered warm-up draw waited ${waitMs} ms for the GPU to take a frame and never drew.`,
    );
  })();
}

function selectOutputPass(node: unknown, worldPass: unknown): PassNode | undefined {
  return outputPassOf(worldPass) ?? outputPassOf(node) ?? findSoleOutputPass(node);
}

/**
 * The pass a node names, whether it is the pass itself or one of its texture nodes.
 *
 * A game that composes onto the pass output hands `setOutputNode` the composed node, not the pass:
 * `renderer.setOutputNode(scenePass.getTextureNode("output"))` carries the pass on `passNode`, and
 * without reading that the wrapper has no scene-pass depth to give an occlusion cull.
 */
function outputPassOf(node: unknown): PassNode | undefined {
  if (isOutputPassNode(node)) return node;
  if (isObject(node) && node.isPassTextureNode === true && isOutputPassNode(node.passNode))
    return node.passNode;
  return undefined;
}

function findSoleOutputPass(node: unknown): PassNode | undefined {
  if (!isTraversableOutputNode(node)) return undefined;
  const passes = new Set<PassNode>();
  node.traverse((candidate) => {
    const pass = outputPassOf(candidate);
    if (pass !== undefined) passes.add(pass);
  });
  if (passes.size > 1)
    throw new Error(
      "TN_RENDER_OUTPUT_PASS_AMBIGUOUS: output graph contains multiple pass nodes; pass the explicit world pass to setOutputNode().",
    );
  return passes.values().next().value;
}

function setOutputPipelineRoot(pass: PassNode | undefined, scene: Object3D, camera: Camera): void {
  if (pass === undefined) return;
  pass.scene = scene;
  pass.camera = camera;
}

function isInObject3DSubtree(root: Object3D, object: Object3D): boolean {
  let current: Object3D | null = object;
  while (current !== null) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTraversableOutputNode(value: unknown): value is ITraversableOutputNode {
  return isObject(value) && typeof value.traverse === "function";
}

function addResizeHandling(
  renderer: IRendererLike,
  source: IRendererPlatformSource | undefined,
  state: ISurfaceState,
  pixelRatio: number,
): { resize: () => void; stop: () => void } {
  // The last layout size read and the drawing buffer set from it. A canvas with no CSS size lays
  // out at its drawing buffer, so the buffer set here comes back as the next layout size: that echo
  // is not a new layout, and scaling it again compounds (Midway's canvas fell to 3x3).
  let layout: readonly [number, number] | undefined;
  let applied: readonly [number, number] | undefined;
  const resize = () => {
    let [width, height] =
      source?.readSize(renderer.domElement) ?? readCanvasSize(renderer.domElement);
    if (
      layout !== undefined &&
      applied !== undefined &&
      width === applied[0] &&
      height === applied[1]
    ) {
      [width, height] = layout;
      // The echo proves the canvas has no size of its own, so the page would show it at its buffer:
      // shrunk under a scale below 1 (Midway fell to 1088x612), doubled at ratio 2. Pin it.
      const style = (renderer.domElement as { style?: CSSStyleDeclaration }).style;
      if (style !== undefined) {
        style.width = `${width}px`;
        style.height = `${height}px`;
      }
    }
    layout = [width, height];
    // Recorded as it is applied rather than read back off the canvas: the canvas dimensions are
    // the host's to define and on native they have been the physical surface, which is exactly
    // the number this scale exists to stop a game from paying by hand.
    const subrect = state.resolutionSubrect;
    const scale = subrect?.active ? 1 : state.resolutionScale;
    const physicalWidth = Math.max(1, Math.round(width * pixelRatio * scale));
    const physicalHeight = Math.max(1, Math.round(height * pixelRatio * scale));
    applied = [physicalWidth, physicalHeight];
    const surface = renderer.surface();
    if (
      surface.drawingBufferWidth !== physicalWidth ||
      surface.drawingBufferHeight !== physicalHeight
    )
      renderer.setSize(physicalWidth, physicalHeight, false);
    if (subrect?.active) {
      subrect.setScale?.(state.resolutionScale);
      subrect.setSize?.(physicalWidth, physicalHeight);
    }
  };
  resize();
  const stop =
    source?.observeResize(renderer.domElement, resize) ??
    observeCanvasResize(renderer.domElement, resize);
  return { resize, stop };
}

/** The live scale, mutated only by `setResolutionScale`, read by every window report. */
interface ISurfaceState {
  resolutionSubrect?: IResolutionSubrect | undefined;
  resolutionScale: number;
  scaleSource: "pinned" | "auto" | "auto-pinned";
}

function createRendererPipelineCensus(
  raw: RendererInstance,
  kind: RendererKind,
  options: IRendererOptions,
  adapterIdentity?: string,
): PipelineCensus | undefined {
  if (options.pipelineCensus === false) return undefined;
  const backendName =
    typeof raw.backend === "object" && raw.backend !== null
      ? (raw.backend.constructor as { name?: unknown } | undefined)?.name
      : undefined;
  const census = createPipelineCensus({
    kind,
    ...(options.pipelineCensus === undefined || options.pipelineCensus.limit === undefined
      ? {}
      : { limit: options.pipelineCensus.limit }),
    ...(typeof backendName === "string" && backendName.length > 0
      ? { backendIdentity: `${kind}:${backendName}` }
      : {}),
    ...(kind === "webgpu" ? { adapterIdentity: adapterIdentity ?? "unavailable" } : {}),
  });
  census.installRenderer(raw);
  return census;
}

async function createWebGpuPipelineCensus(
  raw: RendererInstance,
  options: IRendererOptions,
  adapter: IWebGpuAdapterFacts,
): Promise<PipelineCensus | undefined> {
  return createRendererPipelineCensus(raw, "webgpu", options, adapter.identity);
}

/**
 * The adapters `navigator.gpu` has handed this page, kept for the life of the module.
 *
 * A local `const adapter = await requestAdapter()` is the shape every WebGPU sample uses, and it is
 * the shape Chromium punishes: a collected `GPUAdapter` takes the wire instance down with it, and
 * Dawn reports that on every operation still in flight as `A valid external Instance reference no
 * longer exists.` — the `mapAsync` of the timestamp-query pool and of a GPU readback then rejects
 * forever, the canvas stops presenting, and a run that was healthy at 30 s is black at the end.
 * Collecting needs heap pressure, so it shows up only in the long runs.
 *
 * three's backend keeps the device and `navigator.gpu` but not its adapter, so this is the only
 * strong reference to the one core asked for. Two adapters per renderer: one for the device's
 * limits, one for the identity the capture and the software gate are read from.
 */
const retainedAdapters = new Set<unknown>();

/** The adapters core is holding. A test reads this; a run never does. */
export function retainedWebGpuAdapters(): ReadonlySet<unknown> {
  return retainedAdapters;
}

interface IWebGpuAdapterFacts {
  /** The URI-encoded identity the pipeline census records; absent when the adapter reported none. */
  readonly identity?: string;
  /** The field value that names a CPU rasteriser; absent when none of them does. */
  readonly software?: string;
  /** The family the four fields classify as; absent when the adapter reported no info at all. */
  readonly gpuClass?: IGpuClassification;
}

async function readWebGpuAdapterFacts(raw: RendererInstance): Promise<IWebGpuAdapterFacts> {
  const gpu = raw.backend?.gpu;
  if (gpu === undefined || typeof gpu.requestAdapter !== "function") return {};
  try {
    const adapter = await gpu.requestAdapter.call(gpu, {
      featureLevel: "compatibility",
      powerPreference: raw.backend?.parameters?.powerPreference,
      xrCompatible: raw.xr?.enabled === true,
    });
    if (!isObject(adapter)) return {};
    retainedAdapters.add(adapter);
    const infoCandidate = isObject(adapter.info) ? adapter.info : undefined;
    const legacyInfo =
      infoCandidate === undefined && typeof adapter.requestAdapterInfo === "function"
        ? await adapter.requestAdapterInfo()
        : undefined;
    const info = infoCandidate ?? (isObject(legacyInfo) ? legacyInfo : undefined);
    if (info === undefined) return {};
    const fields = ["architecture", "description", "device", "vendor"] as const;
    const entries = fields.flatMap((field) => {
      const value = info[field];
      return typeof value === "string" && value.length > 0
        ? [[field, encodeURIComponent(value)] as const]
        : [];
    });
    const software = fields
      .map((field) => info[field])
      .find((value): value is string => typeof value === "string" && SOFTWARE_ADAPTER.test(value));
    return {
      ...(entries.length === 0
        ? {}
        : { identity: `webgpu:${entries.map(([field, value]) => `${field}=${value}`).join("|")}` }),
      ...(software === undefined ? {} : { software }),
      gpuClass: classifyGpu(
        Object.fromEntries(
          fields.map((field) => [field, typeof info[field] === "string" ? info[field] : ""]),
        ),
      ),
    };
  } catch {
    return {};
  }
}

/** The per-stage texture limits worth raising past WebGPU's portable defaults (16 each). */
/** Each texture limit a device is granted by default, whatever the adapter supports. */
const TEXTURE_LIMITS = {
  maxSampledTexturesPerShaderStage: 16,
  maxSamplersPerShaderStage: 16,
  // three stores every morph target of a mesh as one layer of a texture array: a MetaHuman head
  // carries 821, and past the default 256 the mesh never draws.
  maxTextureArrayLayers: 256,
  // Seven RGBA16Float render targets carry 56 bytes per sample; the device default of 32 invalidates
  // the pipeline even when the adapter reports 128.
  maxColorAttachmentBytesPerSample: 32,
} as const;

/**
 * The adapter's own texture limits, as `requiredLimits` for the device three creates.
 *
 * WebGPU grants a device the portable defaults — 16 sampled textures a stage — unless it asks for
 * more, whatever the adapter supports. A splat terrain (masks, albedos, normals) that also
 * receives an open-world shadow (three levels plus mover maps) needs ~20, and past 16 the pipeline
 * is invalid and the surface silently never draws. Requesting what the adapter reports costs
 * nothing on hardware that has it (desktop: 48+) and changes nothing where it does not.
 */
export async function adapterTextureLimits(): Promise<{ requiredLimits?: Record<string, number> }> {
  const gpu = (
    globalThis.navigator as { gpu?: { requestAdapter?: () => Promise<unknown> } } | undefined
  )?.gpu;
  if (gpu === undefined || typeof gpu.requestAdapter !== "function") return {};
  try {
    const adapter = await gpu.requestAdapter();
    retainedAdapters.add(adapter);
    const limits = isObject(adapter) && isObject(adapter.limits) ? adapter.limits : undefined;
    if (limits === undefined) return {};
    const requiredLimits: Record<string, number> = {};
    for (const [key, portable] of Object.entries(TEXTURE_LIMITS)) {
      const value = (limits as Record<string, unknown>)[key];
      if (typeof value === "number" && value > portable) requiredLimits[key] = value;
    }
    return Object.keys(requiredLimits).length === 0 ? {} : { requiredLimits };
  } catch {
    return {};
  }
}

export async function createRenderer(options: IRendererOptions = {}): Promise<IRendererLike> {
  const source = options.source;
  const gpuTimestampFrameInterval =
    options.gpuTimestampFrameInterval ?? DEFAULT_GPU_TIMESTAMP_FRAME_INTERVAL;
  if (!Number.isInteger(gpuTimestampFrameInterval) || gpuTimestampFrameInterval < 1)
    throw new Error(
      `renderer.gpuTimestampFrameInterval must be a positive integer, received ${String(gpuTimestampFrameInterval)}.`,
    );
  const resolutionScale = options.resolutionScale ?? 1;
  const pixelRatio = options.pixelRatio ?? 1;
  if (!Number.isFinite(pixelRatio) || pixelRatio <= 0)
    throw new Error(
      `renderer.pixelRatio must be a finite number greater than zero, received ${String(pixelRatio)}.`,
    );
  const state: ISurfaceState = { resolutionScale, scaleSource: options.scaleSource ?? "pinned" };
  const reapply: { resize: (() => void) | undefined } = { resize: undefined };
  if (!Number.isFinite(resolutionScale) || resolutionScale <= 0)
    throw new Error("renderer.resolutionScale must be finite and positive.");
  const applied = { height: 1, width: 1 };
  const canvas = options.canvas ?? source?.createCanvas() ?? document.createElement("canvas");
  // An intrinsic canvas follows its width/height attributes. Scaling that buffer then changes
  // clientWidth, so ResizeObserver scales it again until it is one pixel. Own the layout only
  // for the browser canvas we created; supplied canvases and platform surfaces own theirs.
  if (options.canvas === undefined && source === undefined && canvas.style !== undefined) {
    canvas.style.width = "100%";
    canvas.style.height = "100%";
  }
  const preferWebGPU = options.preferWebGPU ?? true;
  // `trackTimestamp` is on so GPU time is measured, not inferred from wall clock; it is inert on an
  // adapter without `timestamp-query`, and `gpuTimestampFrameInterval` samples it (PRD-446).
  const rendererParameters = {
    antialias: options.antialias ?? true,
    trackTimestamp: true,
  } as const;
  const report = options.report ?? ((line: string) => console.log(line));
  // Bound to the instance rather than to the request: the whole point is that `antialias: true`
  // and "this surface has samples to resolve into" are different facts, and only the second one
  // makes the convention do anything.
  const arm = (raw: RendererInstance) =>
    new AlphaAntialiasing({
      enabled: options.alphaAntialiasing ?? true,
      report,
      sampleCount: () => resolveSampleCount(raw),
    });
  let renderer: IRendererLike | undefined;

  if (preferWebGPU && (source?.hasWebGPU() ?? "gpu" in (globalThis.navigator ?? {}))) {
    try {
      const raw = options.webgpuFactory
        ? await options.webgpuFactory(canvas, rendererParameters)
        : await import("three/webgpu").then(async (webgpu) => {
            // Two Sided Foliage lets the sun through on three's lit node materials too (PRD-643).
            (await import("./render/two-sided-foliage.js")).installFoliageTransmission(webgpu);
            return new webgpu.WebGPURenderer({
              canvas,
              ...rendererParameters,
              ...(await adapterTextureLimits()),
            });
          });
      const instance = raw as RendererInstance;
      await instance.init?.();
      // A game that sets `toneMapping` on the renderer later (WorldEnvironment, Daylight) replaces this.
      applyRendererToneMapping(instance, options.toneMapping ?? "filmic", report);
      const alphaAntialiasing = arm(instance);
      const timestampCapable = instance.backend?.trackTimestamp === true;
      const adapter = await readWebGpuAdapterFacts(instance);
      const pipelineCensus = await createWebGpuPipelineCensus(instance, options, adapter);
      installDrawHook(instance, alphaAntialiasing);
      renderer = wrapRenderer(
        instance,
        "webgpu",
        applied,
        state,
        reapply,
        alphaAntialiasing,
        pipelineCensus,
        timestampCapable,
        gpuTimestampFrameInterval,
        adapter.software,
        adapter.gpuClass,
      );
      if (adapter.gpuClass !== undefined)
        report(`${GPU_CLASS_MARKER}:${JSON.stringify(adapter.gpuClass)}`);
    } catch (error) {
      // A facade and Wasm engine from two builds is an install fault, not a device without
      // WebGPU: falling back would report TN_NO_RENDERER and hide the fix.
      if (error instanceof Error && error.message.startsWith("TN_WASM_ABI_MISMATCH")) throw error;
      renderer = undefined;
    }
  }

  if (renderer === undefined) {
    let raw: RendererInstance;
    try {
      raw = (
        options.webgl2Factory
          ? options.webgl2Factory(canvas, rendererParameters)
          : new (await import("three")).WebGLRenderer({ canvas, ...rendererParameters })
      ) as RendererInstance;
    } catch (error) {
      // No WebGPU adapter and no WebGL fallback is a boot failure the player must read. The native
      // engine binds `WebGLRenderer` to a facade that refuses on use, and reporting that refusal
      // verbatim would show an internal "uncatalogued" code; a browser with no context throws
      // three's own message. Neither belongs in front of a player, so both become one named failure.
      throw new Error(
        "TN_NO_RENDERER: WebGPU is not available on this device and the WebGL fallback could not start, so the game cannot run.",
        { cause: error },
      );
    }
    const alphaAntialiasing = arm(raw);
    const pipelineCensus = createRendererPipelineCensus(raw, "webgl2", options);
    installDrawHook(raw, alphaAntialiasing);
    renderer = wrapRenderer(
      raw,
      "webgl2",
      applied,
      state,
      reapply,
      alphaAntialiasing,
      pipelineCensus,
      false,
      gpuTimestampFrameInterval,
    );
  }

  const resizing = addResizeHandling(renderer, source, state, pixelRatio);
  reapply.resize = resizing.resize;
  const stopResize = resizing.stop;
  const dispose = renderer.dispose;
  renderer.dispose = () => {
    stopResize();
    dispose();
  };
  return renderer;
}
