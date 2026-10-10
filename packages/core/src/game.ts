import {
  type Camera,
  type Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene as ThreeScene,
  Vector2,
} from "three";
import { type IAssetLoaderOptions, createAssetLoader } from "./assets.js";
import { CanvasLayer } from "./canvas-layer.js";
import { updateClusteredMeshes } from "./clustered-mesh.js";
import { ComputeDrivenRegistry, isComputeDriven } from "./compute-driven.js";
import type { IThreeNativeConfig } from "./config.js";
import { type EntitySnapshot, Registry } from "./entities.js";
import { FrameBudget, type IFrameBudgetOptions, type IFrameBudgetWindow } from "./frame-budget.js";
import {
  GeometryCapture,
  type IGeometryCaptureReport,
  type IGeometryCaptureRequest,
  rendererBackendIdentity,
} from "./geometry-capture.js";
import { type ContextMenuPolicy, type InputBindings, InputMap } from "./input.js";
import { watchDeviceLoss, watchStartupStall } from "./launch-diagnostics.js";
import {
  FixedStepLoop,
  type IAfterPhysicsPhase,
  type IRenderPerformanceMetrics,
  type IRenderPerformanceSample,
  createAfterPhysicsPhase,
} from "./loop.js";
import { MatrixWorldPass } from "./matrix-world.js";
import { updateModelLods } from "./model-lod.js";
import { ScenePicker } from "./picking.js";
import type { IPipelineCensus } from "./pipeline-census.js";
import { getPlatform } from "./platform.js";
import { PointerEvents3D } from "./pointer-events.js";
import { FrameCounters, counterDeviceOf } from "./profiling/FrameCounters.js";
import {
  SPANS,
  SpanRecorder,
  addSpan,
  beginSpan,
  endSpan,
  formatSpansWindow,
  setSpanRecorder,
  spanNow,
  spansRequested,
} from "./profiling/Spans.js";
import {
  RenderListValidator,
  formatValidationReport,
  renderListValidationRequested,
} from "./profiling/render-list-validate.js";
import {
  describeSceneShape,
  describeSceneWarning,
  formatSceneWarning,
  sceneWarning,
} from "./profiling/scene-warning.js";
import { installSpanProbes } from "./profiling/span-probes.js";
import { formatProjectionWindow } from "./projection-marker.js";
import { type IRandom, createRandom } from "./random.js";
import { RenderCameraCull } from "./render-camera-cull.js";
import { RenderPassBudget } from "./render-pass-budget.js";
import { SceneRenderProjection } from "./renderProjection.js";
import {
  resolveMatrixWorldMode,
  resolvePlatformResolutionFloor,
  resolveRendererAlphaAntialiasing,
  resolveRendererAntialias,
  resolveRendererScaleSetting,
} from "./renderer-config.js";
import {
  type IRendererLike,
  type IRendererOptions,
  type RendererKind,
  createRenderer,
} from "./renderer.js";
import { ResolutionScaler } from "./resolution-scaler.js";
import type {
  ICtx,
  IStartupStatus,
  IStartupTimeline,
  Scene,
  SceneConstructor,
  SceneFrame,
} from "./scene.js";
import { Scheduler } from "./schedule.js";
import {
  STARTUP_COMPILE_BUDGET_MS,
  STARTUP_STALL_MS,
  type StartupCompile,
  StartupReadiness,
} from "./startup-readiness.js";
import { type GameStore, createGameStore } from "./state.js";
import {
  STATIC_TRANSFORM_MARKER,
  refreshStaticTransforms,
  staticRoots,
  staticTransformCensus,
} from "./static-transform.js";
import { resolveTargetFps } from "./target-fps.js";
import {
  type IUiBridge,
  UI_DEV_METRICS_MESSAGE,
  UI_READY_INTENT,
  connectUiBridge,
} from "./ui-bridge.js";
import { type IUiStatePublisher, onUiIntent, publishUiState } from "./ui-state.js";
import { type IViewportOptions, Viewport } from "./viewport.js";
import {
  type IWarmUpOptions,
  type IWarmUpReport,
  warmUpComputeNodes,
  warmUpScene,
} from "./warmup.js";

export type PluginCleanup = () => void;

export interface IGameObservationSampleRequest {
  readonly entities?: readonly string[];
  /** Asks for one armed per-object geometry capture. Absent means no capture is collected. */
  readonly geometry?: IGeometryCaptureRequest;
  readonly include?: readonly string[];
  readonly label?: string;
  readonly resources?: readonly string[];
}

export interface IGameObservationContribution {
  readonly capabilities: readonly string[];
  /**
   * May answer a promise: an observation that has to wait for the renderer — a geometry capture
   * waits for one presented world frame — cannot be produced inside the request that asked for it.
   */
  readonly sample: (
    request: IGameObservationSampleRequest,
  ) => Readonly<Record<string, unknown>> | Promise<Readonly<Record<string, unknown>>>;
}

export interface IGameRuntimeObservations {
  contribute(contribution: IGameObservationContribution): PluginCleanup;
  contributions(): readonly IGameObservationContribution[];
}

export interface IGamePluginRuntime {
  readonly fixedStep: (ticks: number) => number;
  /**
   * Announces that a diagnostics consumer is going to read render metrics, turning per-frame
   * sample collection on for the rest of the run. Optional: a runtime without collection
   * support just never enables. Games collect nothing until this fires — the samples exist for
   * assertions, not for every frame of every game.
   */
  readonly enableRuntimeDiagnostics?: () => void;
  /** The frame's cost attribution so far, or undefined when the game turned the budget off. */
  readonly frameBudgetWindow?: () => IFrameBudgetWindow | undefined;
  /**
   * Stop the live clock, so a rendered frame simulates nothing and banks no wall-clock time.
   *
   * A run that counts fixed-step ticks must not also accumulate real seconds into the same
   * simulation, and the frames before its first `advance()` are exactly where a boot's seconds
   * used to land. Optional: a runtime without a clock just never freezes one.
   */
  readonly freezeClock?: () => void;
  /**
   * Hold start-scene entry until `gate` settles.
   *
   * The returned promise settles after the scene that owns the world has entered: the start scene
   * unless it navigated out of its own `enter()`, in which case it is the scene it navigated to,
   * loaded and entered. A runner can therefore release the gate after applying pre-entry setup,
   * then await the returned promise before describing entity-derived capabilities — the entities
   * they read are the ones the world actually has. The frame loop remains held throughout.
   */
  readonly holdStart?: (gate: Promise<void>) => Promise<void>;
  readonly observations: IGameRuntimeObservations;
  readonly tick: () => number;
  readonly runtimeDiagnosticsSeries?: () => readonly IRenderPerformanceSample[];
  readonly random?: Pick<IRandom, "state">;
  rapier?: string | null;
  readonly seed: number | null;
  /**
   * Whether first-use compilation has settled, separately from full readiness.
   *
   * Readiness also requires a sustained in-budget frame window, which is a player-experience
   * gate — a CPU rasteriser never meets it and resolves on the window's own timeout instead. A
   * harness that has been told the machine has no GPU needs the earlier, cheaper signal, and it
   * must be reported rather than inferred from a phase that cannot distinguish the two.
   */
  readonly startupCompileSettled?: () => boolean;
  /** When the startup milestones happened, for the playtest bridge's startup observation. */
  readonly startupTimeline?: () => IStartupTimeline;
  /** The renderer-owned bounded pipeline capture, when the renderer has not been opted out. */
  readonly pipelineCensus?: () => IPipelineCensus;
  /**
   * Arms one per-object geometry capture and answers its report after the next presented world
   * frame. Absent on a runtime with no render loop to arm.
   */
  readonly geometryCapture?: (request?: IGeometryCaptureRequest) => Promise<IGeometryCaptureReport>;
  readonly step: number;
}

interface IDevTools {
  snapshot(): EntitySnapshot;
  /**
   * Arms one per-object geometry capture for a development overlay. Absent until the game has a
   * render loop; the overlay treats that as "not ready", never as an empty scene.
   */
  geometry?(request?: IGeometryCaptureRequest): Promise<IGeometryCaptureReport>;
}

type DevToolsHost = Record<string, unknown> & Partial<Record<"__THREENATIVE__", IDevTools>>;

export interface IGamePlatformSource {
  readonly devToolsHost?: Record<string, unknown>;
  readonly input: NonNullable<ConstructorParameters<typeof InputMap>[3]>;
  readonly inputTarget?: EventTarget;
  readonly renderer: NonNullable<IRendererOptions["source"]>;
  readonly viewport: NonNullable<IViewportOptions["source"]>;
  mountCanvas(canvas: HTMLCanvasElement, container?: HTMLElement): void;
  unmountCanvas(canvas: HTMLCanvasElement): void;
}

/**
 * Whether this launch is a development one.
 *
 * A web build answers through Vite's own flag. A native build has no bundler flag at launch, so the
 * host publishes `DEV_MODE` on `process.env` — the one place a game can read how it was started —
 * and this reads it. Both routes answer the same question: should the dev surfaces exist.
 */
/**
 * The bundler's dev flag.
 *
 * The `import.meta.env` access must stay written out exactly here. Vite replaces that member
 * expression at build time; any indirection — a variable holding `import.meta`, or a helper that
 * takes it as an argument — survives into the bundle, where the game is compiled as a script and
 * not a module, and the whole bundle then fails to parse with "Cannot use 'import.meta' outside a
 * module". That is a game that never starts, so the literal access is load-bearing, not style.
 */
function bundlerDevFlag(): boolean {
  // quality-allow: DEV is the bundler's own name for the flag, so the name rule cannot apply.
  // biome-ignore lint/style/useNamingConvention: the bundler's own flag name.
  return (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
}

function isDevLaunch(): boolean {
  // `process.env` exists only where a host installed one: the native runtime does, a browser
  // bundle does not. Narrowed rather than asserted, so a host that installs something else
  // answers "not dev" instead of reading a field that is not there.
  const scope: unknown = globalThis;
  if (typeof scope === "object" && scope !== null && "process" in scope) {
    const hostProcess: unknown = scope.process;
    if (typeof hostProcess === "object" && hostProcess !== null && "env" in hostProcess) {
      const env: unknown = hostProcess.env;
      if (typeof env === "object" && env !== null && "DEV_MODE" in env) {
        const flag: unknown = env.DEV_MODE;
        if (typeof flag === "string" && flag !== "" && flag !== "0" && flag !== "false")
          return true;
      }
    }
  }
  return bundlerDevFlag();
}

function installDevTools(
  entities: Registry,
  host: DevToolsHost | undefined,
  // Late-bound: the capture is constructed with the render loop, after this install runs.
  geometry: () => GeometryCapture | undefined,
): PluginCleanup {
  // Written out here, not through `isDevLaunch()`: the bundler must see the literal flag to strip
  // this whole install from a production build, and a runtime `DEV_MODE` check cannot be stripped.
  const isDev =
    (import.meta as ImportMeta & { env?: Record<"DEV", boolean | undefined> }).env?.DEV === true;
  if (!isDev || host === undefined) return () => undefined;
  const devTools: IDevTools = {
    ...(host.__THREENATIVE__ as (IDevTools & Record<string, unknown>) | undefined),
    geometry: async (request) => {
      const capture = geometry();
      if (capture === undefined) {
        return {
          reason: "TN_GEOMETRY_CAPTURE_NO_LOOP: the game has no running render loop to capture.",
          status: "unavailable",
        };
      }
      return capture.request(request);
    },
    snapshot: () => entities.snapshot(),
  };
  host.__THREENATIVE__ = devTools;
  return () => {
    if (host.__THREENATIVE__ !== devTools) return;
    const remaining = Object.fromEntries(
      Object.entries(devTools).filter(([key]) => key !== "snapshot" && key !== "geometry"),
    );
    host.__THREENATIVE__ =
      // quality-allow: what other dev tools left on the shared global after this game removed its own.
      Object.keys(remaining).length === 0 ? undefined : (remaining as unknown as IDevTools);
  };
}

export type GamePluginFunction<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> = (ctx: ICtx<TState, TPhysics>) => undefined | PluginCleanup;

export interface IGamePluginHooks<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> {
  setup?(
    ctx: ICtx<TState, TPhysics>,
    runtime?: IGamePluginRuntime,
  ): undefined | PluginCleanup | Promise<undefined | PluginCleanup>;
  beforeUpdate?(ctx: ICtx<TState, TPhysics>, dt: number): void;
  update?(ctx: ICtx<TState, TPhysics>, dt: number): void;
  sceneExit?(ctx: ICtx<TState, TPhysics>): void;
  dispose?(ctx: ICtx<TState, TPhysics>): void;
}

export type GamePlugin<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> = GamePluginFunction<TState, TPhysics> | IGamePluginHooks<TState, TPhysics>;

/**
 * The global a native host reads to know the world is on screen. Named here rather than written
 * inline so the host and the framework agree on one spelling.
 */
const STARTUP_READY_GLOBAL = "__TN_STARTUP_READY__";

export interface IGameConfig<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> {
  readonly assets?: IAssetLoaderOptions;
  readonly camera?: CameraConfig;
  readonly canvas?: HTMLCanvasElement;
  readonly container?: HTMLElement;
  readonly input?: InputBindings;
  /**
   * Browser context menu over the game surface. Defaults to `"suppress"`, which is what a game
   * wants: right-click is a binding, not a menu. Set `"allow"` only if your game genuinely needs
   * the browser menu over its canvas.
   */
  readonly contextMenu?: ContextMenuPolicy;
  /**
   * Per-frame cost attribution, on by default. Every `reportEvery` presented frames the game
   * prints one `TN_FRAME_BUDGET` line naming where the frame went — present wait, simulation,
   * three.js render, overlay, the rest — which is what a device lane reads instead of guessing.
   * Pass `false` to silence the marker; the same numbers still reach a playtest `performance`
   * assertion, because turning a convention off must not turn its measurement off.
   */
  readonly frameBudget?: IFrameBudgetOptions | false;
  readonly initialState?: TState;
  /**
   * The **pre-start** shader warm-up. Off by default, and that is not the same as no warm-up.
   *
   * Every distinct pipeline is otherwise built the first time something using it is drawn, inside
   * the first rendered frame of a fully built scene. On a Pixel 8 that frame lasted **12.0 s, of
   * which 8.0 s was 105 pipeline compiles** — a launch the player reads as a hang, because the
   * loop presents nothing for the whole span. Warming those pipelines while the loading screen is
   * up is the obvious fix, and it is the one this option exists for.
   *
   * **A game with this unset still warms up.** `startupCompile` runs the same `warmUpScene` from
   * inside the loading layer's bounded readiness gate, where the opaque layer is on screen and the
   * loop is turning. This option only moves that work *earlier*, to before `start()` releases the
   * loop, where nothing is presenting — which is a thing to choose deliberately, not a default.
   *
   * **What PRD-327 changed is the mechanism, not this default.** The native host used to answer
   * `createRenderPipelineAsync` with the synchronous create wrapped in a resolved promise, so
   * `compileAsync` compiled on the main loop and was abandoned by its own budget having finished
   * nothing — `TN_WARMUP:{"compiled":0,"abandoned":1,"timedOut":true,"elapsedMs":15325}` — while
   * the first frame compiled the identical pipelines in 8.0 s anyway. Both entries are native
   * handlers now, handing the descriptor to a host compile pool and holding the main thread for
   * 0.27 ms of a 70 ms compile (ratio 0.0038 against a pre-registered bar of 0.25, asserted by
   * `threenative-async-pipeline-thread-test`). The default path started working without its
   * default moving.
   *
   * Pass `{}` or an options object to opt in, or `false` to opt out of warm-up entirely. Either
   * way `TN_WARMUP` and `TN_STARTUP_WARMUP` report what happened, because turning a convention off
   * must not turn its measurement off.
   */
  readonly warmUp?: IWarmUpOptions | false | true;
  readonly inputTarget?: EventTarget;
  /**
   * Maximum simulation steps per rendered frame. Default 5. Caps the catch-up burst after a
   * stall so a slow frame cannot cascade into a spiral of longer frames.
   */
  readonly maxSteps?: number;
  readonly platform?: IGamePlatformSource;
  readonly plugins?: readonly GamePlugin<TState, TPhysics>[];
  /**
   * The project's `display` block, passed straight through from `threenative.config.ts`. The
   * adaptive scale holds `maxFps` as its budget, so a game that does not pass this gets the
   * 60 fps default rather than a scaler with no target.
   */
  readonly display?: NonNullable<IThreeNativeConfig["display"]>;
  readonly render?: NonNullable<IThreeNativeConfig["renderer"]>;
  readonly renderer?: IRendererOptions;
  readonly seed?: number;
  readonly scenes: Record<string, SceneConstructor<TState, TPhysics>>;
  /**
   * Fixed simulation step in seconds, e.g. `1 / 60`. **This is the fixed-step knob a game
   * wants**; every `update(ctx, dt)` receives exactly this `dt`, never a variable frame time,
   * so gameplay and physics advance together and never see a stall.
   *
   * Do not write your own accumulator on top of this. Doing so runs the scene's update several
   * times per already-fixed step and decouples gameplay from the simulation — a real build lost
   * its largest wrong turn to exactly that, because this field carried no documentation.
   */
  readonly step?: number;
  readonly start: string;
  /** Optional slower UI publication interval. Omitted publishes once per rendered frame. */
  readonly stateFlushMs?: number;
}

export interface IPerspectiveCameraConfig {
  readonly projection: "perspective";
  readonly fov?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface IOrthogonalCameraConfig {
  readonly projection: "orthogonal";
  readonly size: number;
  readonly near?: number;
  readonly far?: number;
}

export type CameraConfig = IPerspectiveCameraConfig | IOrthogonalCameraConfig;

/**
 * The game's end of the UI bridge.
 *
 * The UI renders through the platform's own browser-class renderer, which on every native
 * target is a different realm from this one — so it holds a mirror of the game's published
 * state and sends intents back rather than calling into the game. The web target uses the same
 * two channels through an in-process broker, which is what keeps one `src/ui/` honest: a HUD
 * that works here works on a phone.
 *
 * Publication is automatic at the rendered frame cadence (or the named stateFlushMs override), and it stops
 * entirely when nothing is listening — a game whose `ui.renderer` is `native` pays nothing.
 */
export interface IGameUi {
  /**
   * Whether a UI layer has announced itself.
   *
   * Stricter than "a transport exists": the UI sends `tn:ready` once its tree has rendered and its
   * interactive rectangles are published, and only then is this true. A transport with nothing on
   * the other end and a UI that failed to render look the same to a game otherwise.
   */
  readonly connected: boolean;
  /** Handle an intent the UI sent — `restart`, `pause`, whatever the game defines. */
  onIntent(listener: (intent: string, payload: unknown) => void): () => void;
  /** Publish the current state now, whether or not it changed. */
  publish(): void;
}

export interface IGotoOptions<TState extends Record<string, unknown>> {
  readonly carry?: Partial<TState>;
}

export interface IGame<
  TState extends Record<string, unknown> = Record<string, unknown>,
  TPhysics = undefined,
> {
  readonly ctx: ICtx<TState, TPhysics> | undefined;
  readonly scene: Scene<TState, TPhysics> | undefined;
  /** The name of the entered scene, or undefined before `start()`. */
  readonly sceneName: string | undefined;
  readonly state: GameStore<TState>;
  /** The seam between the game and its UI layer, on every target. @see IGameUi */
  readonly ui: IGameUi;
  /** Rebuilds the requested scene from its initial state, then merges an optional carry patch. */
  goto(name: string, options?: IGotoOptions<TState>): Promise<void>;
  /** Boot into `name` instead of `config.start` on the next `start()`. Hot reload's restore path. */
  resumeScene(name: string): void;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

function positiveCameraValue(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`camera.${name} must be finite and positive.`);
  return value;
}

function assertJsonSafe(value: unknown, path = "$", seen = new WeakSet<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new TypeError(`${path} must contain only finite JSON numbers.`);
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new TypeError(`${path} must be JSON-safe and cannot be cyclic.`);
    seen.add(value);
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new TypeError(`${path} must be a JSON-safe array.`);
      }
      for (let index = 0; index < value.length; index += 1) {
        assertJsonSafe(value[index], `${path}[${index}]`, seen);
      }
      seen.delete(value);
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must be a JSON-safe plain object.`);
    }
    for (const [key, item] of Object.entries(value)) assertJsonSafe(item, `${path}.${key}`, seen);
    seen.delete(value);
    return;
  }
  throw new TypeError(`${path} must be JSON-safe.`);
}

function assertCarry(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("goto carry must be a JSON object.");
  }
  assertJsonSafe(value, "$.carry");
}

function validateCameraConfig(config: CameraConfig | undefined): void {
  if (config === undefined) return;
  const near = positiveCameraValue("near", config.near ?? 0.1);
  const far = positiveCameraValue("far", config.far ?? 2_000);
  if (far <= near) throw new Error("camera.far must be greater than camera.near.");
  if (config.projection === "perspective") {
    const fov = config.fov ?? 60;
    if (!Number.isFinite(fov) || fov <= 0 || fov >= 180)
      throw new Error("camera.fov must be finite and between 0 and 180 degrees.");
    return;
  }
  positiveCameraValue("size", config.size);
}

function clearScene(scene: ThreeScene, computeDriven: ComputeDrivenRegistry): void {
  computeDriven.clear();
  scene.clear();
  scene.background = null;
  scene.environment = null;
  scene.fog = null;
}

/** The measured draw count on its own, for the projection line that reads it every frame. */
function rendererDrawCallCount(raw: unknown): number | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const info = (raw as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return undefined;
  const render = (info as { render?: unknown }).render;
  if (typeof render !== "object" || render === null) return undefined;
  const drawCalls = (render as { drawCalls?: unknown }).drawCalls;
  const calls = drawCalls ?? (render as { calls?: unknown }).calls;
  return typeof calls === "number" && Number.isFinite(calls) && calls >= 0 ? calls : undefined;
}

function rendererPerformanceMetrics(raw: unknown): {
  drawCalls?: number;
  triangles?: number;
} {
  if (typeof raw !== "object" || raw === null) return {};
  const info = (raw as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return {};
  const render = (info as { render?: unknown }).render;
  if (typeof render !== "object" || render === null) return {};
  const triangles = (render as { triangles?: unknown }).triangles;
  const drawCalls = rendererDrawCallCount(raw);
  return {
    ...(drawCalls === undefined ? {} : { drawCalls }),
    ...(typeof triangles === "number" && Number.isFinite(triangles) && triangles >= 0
      ? { triangles }
      : {}),
  };
}

function resetRendererPerformanceMetrics(raw: unknown): void {
  if (typeof raw !== "object" || raw === null) return;
  const info = (raw as { info?: unknown }).info;
  if (typeof info !== "object" || info === null) return;
  const reset = (info as { reset?: unknown }).reset;
  if (typeof reset === "function") reset.call(info);
}

/**
 * One frame's two render calls, combined.
 *
 * The two renderers' `info` do not mean the same thing, and the old sum only ever held for one of
 * them. `WebGLRenderer` ends every `render()` with `info.reset()`, so the world sample and the
 * overlay sample are disjoint and add up. WebGPU never resets: the engine owns the
 * requestAnimationFrame loop, so it calls `info.reset()` itself once per frame before the world
 * draw (see the render block), which leaves the overlay sample *cumulative* — world plus overlay.
 * Adding it to the world sample reported every world draw twice, and the packed racing scenario
 * read 358 draw calls against a 330 ceiling on a frame that submits far fewer.
 *
 * The world pass split belongs to the world call in both renderers and rides the same sample, so
 * it is carried across rather than summed — a summed split attributes the world's shadow and
 * reflection passes to the overlay too.
 */
function combineRenderPerformanceMetrics(
  kind: RendererKind,
  world: IRenderPerformanceMetrics | undefined,
  overlay: IRenderPerformanceMetrics,
): IRenderPerformanceMetrics {
  const passes = world?.passes;
  if (kind === "webgpu") {
    return passes === undefined ? overlay : { ...overlay, passes };
  }
  if (world === undefined) return overlay;
  return {
    ...(world.drawCalls === undefined || overlay.drawCalls === undefined
      ? {}
      : { drawCalls: world.drawCalls + overlay.drawCalls }),
    ...(world.triangles === undefined || overlay.triangles === undefined
      ? {}
      : { triangles: world.triangles + overlay.triangles }),
    ...(passes === undefined ? {} : { passes }),
  };
}

function createCamera(config: CameraConfig | undefined): Camera {
  if (config === undefined) return new PerspectiveCamera(60, 1, 0.1, 2_000);
  validateCameraConfig(config);
  const near = config.near ?? 0.1;
  const far = config.far ?? 2_000;
  if (config.projection === "perspective")
    return new PerspectiveCamera(config.fov ?? 60, 1, near, far);
  const size = config.size;
  return new OrthographicCamera(-size, size, size, -size, near, far);
}

class GameImpl<TState extends Record<string, unknown>, TPhysics>
  implements IGame<TState, TPhysics>
{
  #config: IGameConfig<TState, TPhysics>;

  /**
   * Whether the caller asked for the pre-start warm-up *by hand*.
   *
   * PRD-327 Phase 2 proposed flipping this default on for native. Executing it showed the
   * prescription was wrong, and the reason is worth keeping: **the framework already warms up by
   * default, in a better place.** `startupCompile` below calls the same `warmUpScene`, but from
   * inside the loading layer's readiness gate — opaque layer on screen, loop turning — whereas the
   * pre-start block runs before `start()` releases the loop, with nothing presenting.
   *
   * What was actually broken was the mechanism, not the default: `compileAsync` could not resolve
   * on native because `createRenderPipelineAsync` was the synchronous create wrapped in a resolved
   * promise, so the default path compiled nothing and reported
   * `{"compiled":0,"abandoned":1,"timedOut":true}`. Phase 1 fixed that, and the default path
   * started working without its default moving.
   *
   * Flipping it anyway cost two regressions CI caught and a local run did not: the loading screen
   * stopped covering startup (`verify-desktop-loading.mjs`: `loadingVisible: false` at every
   * startup sample, on macOS and Windows), and the scene then compiled twice — once before the
   * loop and once inside the gate — which pushed `verify-desktop-physics.mjs` past its 180-frame
   * budget on macOS. Both are gone with the default back where it was.
   */
  #warmUpConfiguredExplicitly(): boolean {
    return this.#config.warmUp !== undefined && this.#config.warmUp !== false;
  }

  /** The warm-up options for the pre-start block, once an explicit opt-in has asked for it. */
  #warmUpOptions(): IWarmUpOptions {
    const configured = this.#config.warmUp;
    return configured === undefined || configured === true || configured === false
      ? {}
      : configured;
  }
  #ctx: ICtx<TState, TPhysics> | undefined;
  #scene: Scene<TState, TPhysics> | undefined;
  /** The name of the scene currently entered. Carried across a hot update so a reload resumes
   * where the session was, instead of restoring the game's state into its start scene. */
  #sceneName: string | undefined;
  #resumeScene: string | undefined;
  #sceneFrame: SceneFrame<TState, TPhysics> | undefined;
  #renderer: IRendererLike | undefined;
  #viewport: Viewport | undefined;
  #input: InputMap | undefined;
  #state: GameStore<TState>;
  #initialState: TState;
  #loop: FixedStepLoop | undefined;
  #projection: SceneRenderProjection | undefined;
  #cameraCull: RenderCameraCull | undefined;
  #matrixWorld: MatrixWorldPass | undefined;
  #cleanup: Array<() => void> = [];
  #computeDriven = new ComputeDrivenRegistry();
  #entities: Registry | undefined;
  #picker: ScenePicker | undefined;
  #pointerEvents: PointerEvents3D | undefined;
  #scheduler: Scheduler | undefined;
  #afterPhysicsPhase: IAfterPhysicsPhase | undefined;
  // Unlike afterPhysics, this seam's frame boundary is the world-render block below, so it is a
  // plain scene-owned set rather than a phase on the loop.
  #beforeRenderCallbacks = new Set<() => void>();
  // Reused snapshot buffers, one per nesting depth, so a steady frame allocates no callback array.
  #beforeRenderSnapshots: Array<Array<() => void>> = [];
  #beforeRenderDepth = 0;
  #frameBudget: FrameBudget | undefined;
  #geometryCapture: GeometryCapture | undefined;
  /** Bumped on every scene change, so a row id is stable exactly as long as the scene is. */
  #sceneGeneration = 0;
  #activePlugins: Array<IGamePluginHooks<TState, TPhysics>> = [];
  #disposedPlugins = new Set<IGamePluginHooks<TState, TPhysics>>();
  #pendingStart: Promise<void> | undefined;
  #aborted = false;
  #sceneEntered = false;
  /**
   * The scene a `goto()` is loading right now, or undefined when none is.
   *
   * Between a `goto()` and its `enter()` the registry is cleared and nothing owns the world, so a
   * reader that needs the world's entities has to wait for this rather than for the scene it
   * navigated from. The playtest handshake reads exactly that.
   */
  #pendingSceneEnter: Promise<void> | undefined;
  #paused = false;
  #started = false;
  #uiBridge: IUiBridge | undefined;
  #uiPublisher: IUiStatePublisher | undefined;
  #uiReady = false;
  // Flipped only by a diagnostics consumer announcing itself; see enableRuntimeDiagnostics().
  #renderMetricsEnabled = false;
  // Depth-coupled output needs the scene hook before its pass; ordinary scenes retain the
  // historical after-render hook so an atmosphere-free game has the same render path as HEAD.
  #hasDepthCoupledOutput = false;

  constructor(config: IGameConfig<TState, TPhysics>) {
    this.#config = config;
    validateCameraConfig(config.camera);
    const startScene = this.#config.scenes[this.#config.start];
    if (startScene === undefined) throw new Error(`Unknown start scene '${this.#config.start}'.`);
    const initialState =
      this.#config.initialState ??
      (startScene as SceneConstructor<TState, TPhysics> & { initialState?: TState }).initialState;
    if (initialState === undefined) {
      throw new Error(
        `Scene '${this.#config.start}' must declare static initialState or provide config.initialState.`,
      );
    }
    this.#state = createGameStore(initialState, this.#config.stateFlushMs);
    this.#initialState = { ...initialState };
  }

  get ctx(): ICtx<TState, TPhysics> | undefined {
    return this.#ctx;
  }

  get scene(): Scene<TState, TPhysics> | undefined {
    return this.#scene;
  }

  /** The name of the entered scene, or undefined before `start()`. */
  get sceneName(): string | undefined {
    return this.#sceneName;
  }

  /**
   * Boot into `name` instead of `config.start` on the next `start()`.
   *
   * Hot reload's restore path is the only caller. `acceptHotUpdate` carries the state store across
   * a module update and hands it back before the game runs — and without this the game rebuilt
   * itself at `config.start`, so a session that was playing came back holding its own state on the
   * main menu, with every entity and its physics world gone. Calling `goto()` instead is not
   * available here: it throws before `start()`, and it resets state to the destination's
   * `initialState`, which would discard the very state being restored.
   */
  resumeScene(name: string): void {
    if (this.#config.scenes[name] === undefined) throw new Error(`Unknown scene '${name}'.`);
    this.#resumeScene = name;
  }

  get state(): GameStore<TState> {
    return this.#state;
  }

  /**
   * The UI seam. Startup connects it even for a read-only HUD; accessing it before startup
   * connects early so the game can register intents. No state is serialized without a UI peer.
   */
  get ui(): IGameUi {
    const bridge = this.#connectUi();
    const ready = () => this.#uiReady;
    return {
      get connected() {
        return bridge.hasPeer() && ready();
      },
      onIntent: (listener) => onUiIntent(bridge, listener),
      publish: () => this.#uiPublisher?.publish(),
    };
  }

  #connectUi(): IUiBridge {
    if (this.#uiBridge !== undefined) return this.#uiBridge;
    const bridge = connectUiBridge({ end: "game" });
    this.#uiBridge = bridge;
    // The store already coalesces writes at flush. Deferring this again waits for the native
    // host's next microtask pump, after that frame's WebView event pump has already passed.
    this.#uiPublisher = publishUiState(bridge, this.#state, { schedule: (flush) => flush() });
    onUiIntent(bridge, (intent) => {
      if (intent !== UI_READY_INTENT) return;
      this.#uiReady = true;
      // Publish immediately: the UI has just rendered against nothing, and waiting for the store's
      // next change would leave a HUD showing its initial values for up to a tick.
      this.#uiPublisher?.publish();
    });
    return bridge;
  }

  #disconnectUi(): void {
    this.#uiPublisher?.stop();
    this.#uiPublisher = undefined;
    this.#uiReady = false;
    this.#uiBridge?.close();
    this.#uiBridge = undefined;
  }

  goto(name: string, options?: IGotoOptions<TState>): Promise<void> {
    if (this.#ctx === undefined) throw new Error("Cannot call game.goto() before start().");
    // Validate before the reset: a typo'd scene name must not wipe the live session's state on
    // its way to throwing.
    const SceneType = this.#config.scenes[name];
    if (SceneType === undefined) throw new Error(`Unknown scene '${name}'.`);
    const carry = options?.carry;
    if (carry !== undefined) assertCarry(carry);
    const destinationInitialState =
      (SceneType as SceneConstructor<TState, TPhysics> & { initialState?: TState }).initialState ??
      this.#initialState;
    this.#state.stop();
    this.#state.setState({ ...destinationInitialState, ...(carry as Partial<TState> | undefined) });
    this.#state.start();
    return this.#goto(name, this.#ctx);
  }

  #goto(name: string, ctx: ICtx<TState, TPhysics>): Promise<void> {
    const SceneType = this.#config.scenes[name];
    if (SceneType === undefined) throw new Error(`Unknown scene '${name}'.`);

    this.#hasDepthCoupledOutput = false;
    this.#sceneGeneration += 1;
    // The objects a pending capture armed are leaving the graph; a report about them would be
    // about a scene that no longer exists.
    this.#geometryCapture?.cancel("TN_GEOMETRY_CAPTURE_SCENE_EXIT: the scene changed mid-capture.");
    this.#sceneFrame = undefined;
    this.#afterPhysicsPhase?.clear();
    this.#beforeRenderCallbacks.clear();
    this.#scene?.exit(ctx);
    this.#pointerEvents?.clear();
    this.#sceneEntered = false;
    this.#scheduler?.clear();
    this.#entities?.clear();
    for (const plugin of this.#config.plugins ?? []) {
      if (typeof plugin !== "function") plugin.sceneExit?.(ctx);
    }
    // The projection holds batches built from the outgoing scene's geometry. Released before the
    // scene is cleared, so a scene change cannot leave the next level drawing the last one's
    // props — and released rather than rebuilt, because every source it referenced is about to go.
    this.#projection?.dispose();
    // Put back anything the cull hid before the outgoing scene is cleared, so a scene change never
    // leaves an object invisible if the game keeps a reference to it.
    this.#cameraCull?.restore();
    clearScene(ctx.scene, this.#computeDriven);
    const scene = new SceneType();
    this.#scene = scene;
    this.#sceneName = name;
    const loaded = scene.load(ctx);
    const transition =
      loaded === undefined
        ? this.#enterTransitionScene(scene, ctx)
        : Promise.resolve(loaded).then(() => this.#enterTransitionScene(scene, ctx));
    const settled = (): void => {
      if (this.#pendingSceneEnter === transition) this.#pendingSceneEnter = undefined;
    };
    // Handled here as well as by the caller: a start scene that navigates inside `enter()` throws
    // its transition away, and the gate below still has to learn that no world arrived.
    void transition.then(settled, settled);
    this.#pendingSceneEnter = transition;
    return transition;
  }

  #enterScene(scene: Scene<TState, TPhysics>, ctx: ICtx<TState, TPhysics>): boolean {
    const frame = scene.enter(ctx);
    if (frame !== undefined && typeof frame !== "function") {
      throw new Error("Scene.enter() must return a frame function or undefined.");
    }
    // A boot scene may navigate synchronously; do not replace the frame installed by #goto().
    if (this.#scene !== scene) return false;
    this.#sceneFrame = typeof frame === "function" ? frame : undefined;
    this.#sceneEntered = true;
    return true;
  }

  async #enterTransitionScene(
    scene: Scene<TState, TPhysics>,
    ctx: ICtx<TState, TPhysics>,
  ): Promise<void> {
    if (!this.#enterScene(scene, ctx)) return;
    const renderer = this.#renderer;
    const nodes = this.#computeDriven.warmupNodes;
    if (renderer === undefined || nodes.length === 0) return;
    this.#sceneEntered = false;
    let report: Awaited<ReturnType<typeof warmUpComputeNodes>> | undefined;
    let failure: string | undefined;
    try {
      report = await warmUpComputeNodes(renderer, nodes, this.#warmUpOptions());
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    console.log(
      `TN_TRANSITION_COMPUTE_WARMUP:${JSON.stringify(
        report === undefined
          ? { failed: failure ?? "unknown" }
          : {
              compiled: report.compiled,
              abandoned: report.abandoned,
              unsupported: report.unsupported,
              timedOut: report.timedOut,
            },
      )}`,
    );
    if (!this.#aborted && this.#scene === scene) this.#sceneEntered = true;
  }

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    if (this.#pendingStart !== undefined) return this.#pendingStart;
    this.#aborted = false;
    const pendingStart = this.#boot().catch((error: unknown) => {
      this.#disconnectUi();
      throw error;
    });
    this.#pendingStart = pendingStart;
    void pendingStart.then(
      () => {
        if (this.#pendingStart === pendingStart) this.#pendingStart = undefined;
      },
      () => {
        if (this.#pendingStart === pendingStart) this.#pendingStart = undefined;
      },
    );
    return pendingStart;
  }

  async #boot(): Promise<void> {
    const bootSceneName = this.#resumeScene ?? this.#config.start;
    this.#resumeScene = undefined;
    const SceneType = this.#config.scenes[bootSceneName];
    if (SceneType === undefined) throw new Error(`Unknown start scene '${bootSceneName}'.`);
    this.#connectUi();

    const renderer = await createRenderer({
      ...this.#config.renderer,
      canvas: this.#config.canvas ?? this.#config.renderer?.canvas,
      preferWebGPU: this.#config.render?.preferWebGPU ?? this.#config.renderer?.preferWebGPU,
      // One rule on both runtimes, decided 2026-09-01 after a HiDPI desktop browser upscaled a
      // DPR-1 web buffer into visible pixelation: the device's real density, with an explicit
      // `renderer.pixelRatio` winning over it (the old branch silently clobbered that value).
      // Headless capture lanes run at DPR 1 and are unaffected; the resolution scaler composes
      // on top, so a density the GPU cannot afford is trimmed by rungs, not by the developer.
      pixelRatio: this.#config.renderer?.pixelRatio ?? globalThis.devicePixelRatio ?? 1,
      antialias: resolveRendererAntialias(
        this.#config.render,
        this.#config.renderer?.antialias,
        getPlatform().os,
      ),
      alphaAntialiasing: resolveRendererAlphaAntialiasing(
        this.#config.render,
        this.#config.renderer?.alphaAntialiasing,
        getPlatform().os,
      ),
      ...resolveRendererScaleSetting(
        this.#config.render,
        this.#config.renderer?.resolutionScale,
        getPlatform().os,
      ),
      source: this.#config.renderer?.source ?? this.#config.platform?.renderer,
    });
    if (this.#aborted) {
      renderer.dispose();
      return;
    }
    this.#renderer = renderer;
    const canvas = renderer.domElement;
    const platform = this.#config.platform;
    if (platform !== undefined) platform.mountCanvas(canvas, this.#config.container);
    else if (
      this.#config.container !== undefined &&
      canvas.parentElement !== this.#config.container
    )
      this.#config.container.append(canvas);
    else if (canvas.parentElement === null && typeof document !== "undefined")
      document.body.append(canvas);

    const inputTarget =
      this.#config.inputTarget ??
      (platform === undefined
        ? typeof window === "undefined"
          ? canvas
          : window
        : (platform.inputTarget ?? canvas));
    this.#input = new InputMap(
      this.#config.input,
      inputTarget,
      canvas,
      platform?.input,
      this.#config.contextMenu,
    );
    this.#state.start();
    const threeScene = new ThreeScene();
    const camera = createCamera(this.#config.camera);
    const viewport = new Viewport({ camera, renderer: this.#renderer, source: platform?.viewport });
    const canvasLayer = new CanvasLayer(viewport);
    this.#viewport = viewport;
    // The renderer goes to the asset loader so compiled KTX2 textures detect transcoding
    // support against the real backend; a target that supports none fails right here.
    const assets = createAssetLoader({ ...this.#config.assets, renderer: renderer.raw });
    if (assets.compressedTextures !== undefined) await assets.compressedTextures.ready;
    const entities = new Registry();
    const random = createRandom(this.#config.seed);
    const scheduler = new Scheduler();
    const afterPhysicsPhase = createAfterPhysicsPhase();
    const input = this.#input;
    const picker = new ScenePicker({
      camera,
      // Input reports window-relative client coordinates; the picker's NDC math is
      // canvas-relative. Subtract the canvas page offset like replay.ts does for recorded
      // pointers, or every pick lands displaced by wherever the canvas sits in the layout.
      pointer: () => {
        const position = input.raw.pointer.position;
        const rect = (
          canvas as { getBoundingClientRect?: () => DOMRect }
        ).getBoundingClientRect?.();
        return rect === undefined
          ? position
          : new Vector2(position.x - rect.left, position.y - rect.top);
      },
      scene: threeScene,
      viewport,
    });
    this.#picker = picker;
    const pointerEvents = new PointerEvents3D({
      screen: (position, target) => {
        const rect = (
          canvas as { getBoundingClientRect?: () => DOMRect }
        ).getBoundingClientRect?.();
        return rect === undefined
          ? target.copy(position)
          : target.set(position.x - rect.left, position.y - rect.top);
      },
    });
    this.#pointerEvents = pointerEvents;
    const loopState: { current?: FixedStepLoop } = {};
    // The engine owns the world-matrix walk, not three's renderer: on by default it does not recurse
    // into a hidden subtree, and `renderer.matrixWorld: "all"` restores the every-node walk. The
    // authored scene is marked once, here, so three never walks it a second time; the mirror scene
    // is marked at the render site, where whichever root is drawn this frame is known.
    const matrixWorldPass = new MatrixWorldPass({
      mode: resolveMatrixWorldMode(this.#config.render),
    });
    this.#matrixWorld = matrixWorldPass;
    threeScene.matrixWorldAutoUpdate = false;
    // Built before the context because `ctx.startup` reads it: a game asks what the framework's
    // startup is doing, and the answer is this pass.
    const projection = new SceneRenderProjection(threeScene, {
      // The game's `renderer.projection` value verbatim: `false` declines the mirror, an object
      // names the material check beside accepting it, and the projection owns both readings.
      projection: this.#config.render?.projection,
      velocity: () => renderer.renderChainUsesPerObjectVelocity?.() ?? false,
      matrixWorld: matrixWorldPass,
    });
    this.#projection = projection;
    // Do not submit what the render camera cannot resolve. On by default at a conservative 0.5 px,
    // and measured whether or not the game narrows or declines it. Its decision is per camera, so
    // a shadow caster and anything attached to the camera are never dropped on the main view alone.
    const cameraCull = new RenderCameraCull({
      minimumPixels: this.#config.render?.minimumProjectedPixels,
    });
    this.#cameraCull = cameraCull;
    let projectionSettled = false;
    /**
     * Progress is a high-water mark over the measured load state, never a value that can fall.
     *
     * The ratio's denominator grows: a request registered after an earlier one settled shrinks
     * `settled / requested`, and the file-count and byte branches can disagree across the switch
     * the first weighed manifest entry triggers. Both make the bar jump backwards, which a player
     * reads as the load restarting. Measured: a second texture requested after the first settled
     * took the reported value from 0.7 to 0.35.
     */
    let reportedProgress = 0;
    /** What the load state says right now. This may fall; `startup.progress` is what never does. */
    const measuredProgress = (): number => {
      if (projectionSettled) return 1;
      // A registered hold owns the last tenth. Without this the bar sat at 0.9 for the whole
      // of the game's own tier and then jumped, which is the reading a player calls frozen.
      if (startupReadiness.frameworkReady) {
        const held = startupReadiness.holdReport.length;
        if (held === 0) return 0.9;
        const settled = held - startupReadiness.pendingHolds.length;
        return 0.9 + 0.1 * (settled / held);
      }
      if (startupReadiness.compileSettled) return 0.9;
      if (timeline.enteredMs !== undefined) return 0.8;
      const { requested, requestedBytes, settled, settledBytes } = assets.progress;
      // Bytes when the manifest knows them, files when it does not. A file count spends the
      // same travel on a 4 KB icon as on a 710 MB model, which is how a bar reaches 92% and
      // then stands still for the rest of the download.
      if (requestedBytes > 0) return 0.7 * Math.min(1, settledBytes / requestedBytes);
      return requested === 0 ? 0 : 0.7 * Math.min(1, settled / requested);
    };
    let worldRendered = false;
    let loadingFramePresented = false;
    let markProjectionSettled: () => void = () => undefined;
    const projectionReady = new Promise<void>((resolve) => {
      markProjectionSettled = resolve;
    });
    const startupReadiness = new StartupReadiness({
      /**
       * The second warm-up: everything a game attached while it held startup.
       *
       * The first pass runs at framework readiness, which for a streaming game is before most of
       * the world exists. Without this, `hold()` buys a complete *picture* and leaves a scene whose
       * every material still compiles on first sight — which is worse than the pop-in it replaced,
       * because a compile stall lands while the player is walking rather than while they are
       * waiting. Measured on a 46,190-instance forest: 8 pipelines warmed, then 28 main-thread
       * tasks over 40 ms in a minute of play, the worst 267 ms.
       *
       * A third of the compile budget, not the whole of it, because this one is spent with the
       * player already waiting behind a curtain that has been up for seconds. Whatever does not
       * fit still compiles lazily — the same as before — so the ceiling on the wait is bounded and
       * the worst case is the behaviour we already had.
       */
      afterHolds: async () => {
        await warmUp("TN_STARTUP_WARMUP_HELD", Math.round(STARTUP_COMPILE_BUDGET_MS / 3), false);
      },
    });
    // Startup readiness does not wait on `ui-ready`, and cannot. The intent proves the page's
    // script ran, not that a pixel reached the screen, so waiting on it never closed the race it
    // was added for — it only made the losing side lose later, after up to 45 s of held frames.
    // The race no longer exists: the native UI is now composited into the game's own frame, so the
    // cover and the world share one swapchain and there is no second surface left to arrive late.
    // The held loop starts before an explicit warm-up so the loading surface can animate. A native
    // frame may therefore arrive while that pass is still awaiting a compile promise; keep first-use
    // rendering and compute behind the same held boundary until the explicit pass has settled.
    let explicitWarmUpSettled = !this.#warmUpConfiguredExplicitly();
    // A web UI is the loading surface on native and on the web. Its bridge must be both attached
    // and announced ready: an attached but unrendered web view is not a cover the player can see.
    // Keep this predicate tied to an actually attached and rendered web UI. The render path still
    // lets a settled world render behind either kind of cover; only the unresolved first-use work
    // is held, so a persistent HUD cannot stop the world pass after loading.
    const startupCoverActive = (): boolean =>
      !startupReadiness.ready &&
      (canvasLayer.opaque || (this.#uiReady && this.#uiBridge?.hasPeer() === true));
    const timeline: { -readonly [K in keyof IStartupTimeline]: IStartupTimeline[K] } = {};
    let warmUpStatus: IStartupStatus["warmup"];
    const now = (): number => globalThis.performance?.now() ?? Date.now();
    /**
     * A launch that stops making progress says so, on the page, instead of leaving a loading
     * screen up forever. Measured on `midway-open-pacific`: a 104 s launch and then a lost GPU
     * device, with the only account of either on a terminal the player does not have.
     */
    const stopStallWatch = watchStartupStall({
      pending: () => assets.progress.pending,
      progress: () => this.#ctx?.startup.progress ?? 0,
      stallMs: STARTUP_STALL_MS,
    });
    watchDeviceLoss(
      (
        renderer.raw as {
          backend?: { device?: { lost?: Promise<{ reason?: string; message?: string }> } };
        }
      ).backend?.device,
    );
    // Stamped when the FRAMEWORK is done, which is before `whenReady()` whenever the game has
    // registered a `startup.hold()`. Two stamps, because one number cannot be both "what the
    // framework cost" and "what the player waited for", and collapsing them is how a valley that
    // took 8.8 s to appear reported 1.5 s.
    void startupReadiness.whenFrameworkReady().then(() => {
      timeline.compileSettledMs ??= now();
      timeline.frameworkReadyMs ??= now();
    });
    void startupReadiness.whenReady().then(() => {
      stopStallWatch();
      // A renderer without first-use compilation settles without running the compile closure
      // below, so the settle stamp is guaranteed here at the latest.
      timeline.compileSettledMs ??= now();
      timeline.frameworkReadyMs ??= now();
      timeline.readyMs ??= now();
      projectionSettled = true;
      markProjectionSettled();
      // A host capturing a frame has no other way to know the world is on screen. Counting frames
      // cannot express it: on a software rasteriser the gate resolves on its bounded window rather
      // than on five in-budget frames, so a fast 300-frame run finishes before the world is shown
      // and captures the loading state. The native screenshot path waits on this flag.
      (globalThis as Record<string, unknown>)[STARTUP_READY_GLOBAL] = true;
    });
    const warmUp = async (marker: string, budgetMs: number, stamp: boolean): Promise<void> => {
      if (this.#aborted || this.#renderer === undefined) return;
      let report: IWarmUpReport | undefined;
      let failure: string | undefined;
      try {
        projection.reconcile();
        // The frame loop's own walk, run here too because the warm-up draws before that loop does.
        // Three is told not to walk the scene (`matrixWorldAutoUpdate = false`), and a declined
        // projection returns from `reconcile()` without walking it, so without this the warm render
        // compiles every pipeline against stale world matrices and the real frames then build the
        // rest synchronously -- tens of seconds each on a software adapter, which loses the device.
        this.#matrixWorld?.apply(projection.root);
        report = await warmUpScene(renderer, projection.root, camera, {
          budgetMs,
          computeNodes: this.#computeDriven.warmupNodes,
          renderPasses: this.#warmUpOptions().renderPasses,
          includeHidden: this.#warmUpOptions().includeHidden,
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      warmUpStatus =
        report === undefined
          ? { status: "unavailable" }
          : {
              attempted: report.attempted,
              candidates: report.candidates,
              observed: report.observed,
              status: report.observed.status,
            };
      if (stamp) timeline.compileSettledMs ??= now();
      console.log(
        `${marker}:${JSON.stringify(
          report === undefined
            ? { failed: failure ?? "unknown" }
            : {
                compiled: report.compiled,
                pipelines: report.pipelines,
                candidates: report.candidates,
                attempted: report.attempted,
                observed: report.observed,
                slices: report.slices,
                elapsedMs: Math.round(report.elapsedMs),
                unsupported: report.unsupported,
                abandoned: report.abandoned,
                timedOut: report.timedOut,
                computeCompiled: report.computeCompiled,
                computeAbandoned: report.computeAbandoned,
                computeUnsupported: report.computeUnsupported,
                computeTimedOut: report.computeTimedOut,
                passes: report.passes,
                passPipelines: report.passPipelines,
                cullingForced: report.cullingForced,
                visibilityForced: report.visibilityForced,
                cache: report.cache,
              },
        )}`,
      );
    };
    const startupCompile: StartupCompile = async (): Promise<void> => {
      await warmUp("TN_STARTUP_WARMUP", STARTUP_COMPILE_BUDGET_MS, true);
    };
    // The GPU-selected main-pass tally, registered by whichever streamed world is added to the
    // scene. The frame budget reads it once per window; a world with no sample reports undefined, so
    // the window carries nothing rather than a zero no frame selected.
    let gpuTallyProvider:
      | (() => { readonly instances: number; readonly triangles: number } | undefined)
      | undefined;
    const ctx: ICtx<TState, TPhysics> = {
      add: (object) => {
        // Narrowed through a plain `Object3D` rather than the type parameter: a type guard applied
        // to `T` yields `T & IComputeDriven`, which TypeScript will not carry to the registry's
        // `Object3D & IComputeDriven` without a cast. The local keeps the guard honest and the
        // return keeps the caller's own type, so a game never casts back what it just built.
        const node: Object3D = object;
        threeScene.add(node);
        if (typeof (node as { aerialPerspective?: unknown }).aerialPerspective === "function") {
          this.#hasDepthCoupledOutput = true;
        }
        if (isComputeDriven(node)) {
          const activeRenderer = this.#renderer;
          if (activeRenderer === undefined)
            throw new Error("Cannot add a compute-driven object before the game starts.");
          this.#computeDriven.add(node, activeRenderer);
        }
        // A streamed world that can say what the GPU selected, so `TN_FRAME_BUDGET` reports the
        // GPU-selected main-pass count beside its pass record. The tally is asked for only when the
        // frame budget is on: with it off and no validation, the world adds no readback at all.
        const tallySource = node as {
          enableGpuSceneTally?: () => void;
          gpuSceneTally?: () =>
            | { readonly instances: number; readonly triangles: number }
            | undefined;
        };
        if (typeof tallySource.gpuSceneTally === "function") {
          gpuTallyProvider = tallySource.gpuSceneTally.bind(node);
          if (this.#config.frameBudget !== false) tallySource.enableGpuSceneTally?.();
        }
        return object;
      },
      assets,
      after: (delay, callback) => scheduler.after(delay, callback),
      afterPhysics: (callback) => afterPhysicsPhase.register(callback),
      beforeRender: (callback) => {
        if (typeof callback !== "function")
          throw new Error("beforeRender requires a callback function.");
        this.#beforeRenderCallbacks.add(callback);
        return () => this.#beforeRenderCallbacks.delete(callback);
      },
      camera,
      canvasLayer,
      entities,
      every: (callback) => scheduler.every(callback),
      get fps() {
        return loopState.current?.fps ?? 0;
      },
      goto: (name) => this.#goto(name, ctx),
      input: this.#input,
      pointer: pointerEvents,
      physics: undefined as TPhysics,
      random,
      raycast: (options) => picker.raycast(options),
      raycastAll: (options, target) => picker.raycastAll(options, target),
      startup: {
        get warmup() {
          return warmUpStatus;
        },
        get phase() {
          // The projection is reconciled before the first world draw, but readiness is not reported
          // until first-use work and a sustained in-budget window have completed. An opaque loading
          // layer cannot turn `whenReady()` into a first-present signal while work is still waiting
          // behind it.
          if (projectionSettled) return "ready" as const;
          return "collapsing" as const;
        },
        // True once first-use compilation has settled, which is earlier than `phase === "ready"`
        // and is the signal a game wants when it must not act during the launch. `phase` cannot
        // express it: it is binary, and readiness additionally requires a sustained in-budget
        // frame window that a software rasteriser can only ever let expire. A game gated on
        // `phase` alone therefore does nothing for ~25s on such a lane — measured as a chase route
        // of length 0.000000 where 6 was required, because the scenario ended first.
        get compileSettled() {
          return startupReadiness.compileSettled;
        },
        // Honest and monotonic: the asset ratio carries the first 70% while the start scene
        // loads, entering the world is 80%, compile settling 90%, and only readiness is 1.
        // Monotonicity is enforced rather than assumed — see the high-water mark above.
        get progress() {
          reportedProgress = Math.max(reportedProgress, measuredProgress());
          return reportedProgress;
        },
        hold: (label, work, budgetMs) => {
          startupReadiness.hold(label, work, budgetMs);
        },
        get timeline() {
          return { ...timeline };
        },
        whenReady: () => projectionReady,
        whenFrameworkReady: () => startupReadiness.whenFrameworkReady(),
      },
      renderer: this.#renderer,
      viewport,
      scene: threeScene,
      state: this.#state,
      tween: (target, properties, duration, options) =>
        scheduler.tween(target, properties, duration, options),
    };
    this.#ctx = ctx;
    this.#entities = entities;
    this.#scheduler = scheduler;
    this.#afterPhysicsPhase = afterPhysicsPhase;
    const devToolsHost =
      platform === undefined
        ? typeof window === "undefined"
          ? undefined
          : window
        : platform.devToolsHost;
    this.#cleanup.push(
      installDevTools(
        entities,
        devToolsHost as DevToolsHost | undefined,
        () => this.#geometryCapture,
      ),
    );
    this.#scene = new SceneType();
    this.#sceneName = bootSceneName;
    // The scaler exists whenever the scale is automatic, which now includes a game that said
    // nothing about it. A pinned number leaves this undefined, which is what makes "pinned" a
    // guarantee rather than a preference the loop may overrule. `maxFps: 0` removes the ceiling,
    // and a scaler with no budget is not a scaler with a loose one, so an uncapped game simply
    // does not get adaptive scaling.
    const initialTarget = resolveTargetFps(this.#config, getPlatform());
    let heldTargetFps = initialTarget.targetFps;
    // Frame-share budgets elsewhere (the world's adaptive LOD) read the target, not the last frame.
    renderer.noteTargetFps?.(initialTarget.targetFps);
    const scaler =
      renderer.surface().scaleSource === "auto" && initialTarget.targetFps > 0
        ? new ResolutionScaler({
            // Phones keep the device ladder; a desktop stops before its bottom, where a picture
            // with nothing reconstructing it stops being a faster frame and becomes a blur.
            minScale: resolvePlatformResolutionFloor(getPlatform().os),
            targetFps: initialTarget.targetFps,
            // The renderer publishes no active-stage list, so this reads the one core-owned seam
            // that is set exactly while the installed chain runs a stage consuming temporal
            // motion data: while that is true the floor is lifted, and the deep rungs — the ones
            // only a reconstruction can pay for — are reachable.
            temporalUpscale: () => renderer.renderChainUsesPerObjectVelocity?.() === true,
          })
        : undefined;
    // The panel's own rate, once a window of presented frames can say it. The native host's
    // present counter is the only series there that counts displays rather than loop iterations;
    // on the web one rAF callback is one vblank, so the median presented interval is the period.
    let measuredRefreshHz: number | undefined;
    // The world pass's own draw-call count, kept from the last frame of the window so the
    // projection line can report what the renderer was handed beside what the plan predicted.
    // A plan and a measurement that disagree is the finding; one number pretending to be both
    // is how an optimizer reports a win it did not deliver.
    let lastWorldDrawCalls: number | undefined;
    // Completion on the last frame must not make an otherwise compiling window look clean.
    let compilingInWindow = false;
    let lastCompileCount = renderer.compileCount;
    const observeCompilation = (): void => {
      const count = renderer.compileCount;
      compilingInWindow ||= renderer.compiling === true || count !== lastCompileCount;
      lastCompileCount = count;
    };
    // Built here rather than inside the loop so `frameBudget: false` is a single decision with a
    // single owner, and so the render phases below feed the same instrument the loop feeds.
    const frameBudget =
      this.#config.frameBudget === false
        ? undefined
        : new FrameBudget({
            ...this.#config.frameBudget,
            // The scaler reads the same windows the marker reports, so what it acted on and what
            // the record shows are the same measurement rather than two sampling paths.
            onWindow: (reported) => {
              const sink =
                this.#config.frameBudget === false ? undefined : this.#config.frameBudget?.report;
              const reportInfo = sink ?? console.info;
              const reportWarning = sink ?? console.warn;
              observeCompilation();
              const compileObserved = compilingInWindow;
              compilingInWindow = false;
              // The display's own rate, read once per window from the cadence the loop already
              // measured: the host's present counter where there is one, else the median presented
              // interval, which on the web is the vblank period because rAF is the presentation.
              measuredRefreshHz =
                reported.presentedFps ??
                (reported.presented.p50 > 0 ? 1_000 / reported.presented.p50 : undefined);
              const target = resolveTargetFps(this.#config, getPlatform(), measuredRefreshHz);
              renderer.noteTargetFps?.(target.targetFps);
              if (
                scaler !== undefined &&
                target.targetFps > 0 &&
                target.targetFps !== heldTargetFps
              ) {
                heldTargetFps = target.targetFps;
                scaler.retarget(heldTargetFps);
              }
              renderer.observeRenderChainBudget?.(reported);
              this.#computeDriven.observeBudget(reported);
              const projection = this.#projection;
              // Printed every window, projecting or declined. `TN_RENDER_PROJECTION` says once
              // whether the optimizer engaged; this says, repeatedly, what it is still leaving on
              // the exact lane and whether the renderer agrees with the plan.
              if (projection !== undefined) {
                reportInfo(
                  formatProjectionWindow(
                    projection.report,
                    reported.window,
                    lastWorldDrawCalls,
                    this.#cameraCull?.report,
                    this.#matrixWorld?.report,
                  ),
                );
              }
              if (this.#config.frameBudget !== false)
                this.#config.frameBudget?.onWindow?.(reported);
              // The span tree closes on the same window, so the two lines in a log describe the
              // same frames and a reader can subtract one from the other without a second clock.
              const spanWindow = spans?.window();
              if (spanWindow !== undefined) reportInfo(formatSpansWindow(spanWindow));
              // The scene-shape verdict, on by default, from the census the frame already took.
              // An agent building a scene of the wrong shape reads it in the log before a human
              // ever plays the game and calls it slow.
              const staticCensus = staticTransformCensus();
              if (staticCensus.roots > 0)
                reportInfo(`${STATIC_TRANSFORM_MARKER}:${JSON.stringify(staticCensus)}`);
              const validation = renderListValidator?.report();
              if (validation !== undefined) reportInfo(formatValidationReport(validation));
              const warning = sceneWarning(
                reported,
                describeSceneShape(reported, this.#cameraCull?.report),
                target.targetFps,
              );
              if (warning !== undefined) reportWarning(formatSceneWarning(warning));
              // The same sentence goes to the UI on a dev launch, so a human watching the window
              // and an agent reading the log are told the same thing at the same time. No frame
              // rate rides it: the loop's own rAF rate reads throttled under a compositor or a
              // virtual display, so a number drawn from it lies in exactly the sessions where
              // somebody is trying to measure.
              if (
                devMetricsEnabled &&
                warning !== undefined &&
                this.#uiBridge?.hasPeer() === true
              ) {
                const verdict = describeSceneWarning(warning);
                if (verdict !== postedVerdict) {
                  postedVerdict = verdict;
                  this.#uiBridge.post({ type: UI_DEV_METRICS_MESSAGE, sceneWarning: verdict });
                }
              }
              if (scaler === undefined) return;
              // **Not while the world is still arriving.** The scaler judges the game by closed
              // frame-budget windows, and the windows that close during a launch are not the game:
              // they are asset decode, scene construction and first-use compilation. Measured on
              // sandbox/wildwood, a 46,190-instance forest, the first two windows reported 18.8
              // and 27.3 fps against a 60 fps budget — a deficit large enough that `#rungsToDrop`
              // crossed three rungs at once and the buffer went from 1600x900 to 976x549 before
              // the player had control. It then settled at 0.72, which is 52% of the pixels, and
              // re-probed 0.85 every thirty seconds, missed, and fell back — so the picture went
              // soft a few seconds in and never fully recovered. The owner's report was "after a
              // while everything becomes blurry, and keeps getting worse".
              //
              // Readiness is the right gate rather than a frame count or a timer: it is the moment
              // the framework already defines as "the world is safe to show", it now includes
              // anything the game held startup for, and a host that never reaches it still gets
              // there on the bounded fallbacks inside `StartupReadiness`.
              if (!startupReadiness.ready || compileObserved) return;
              const stepped = scaler.observe(reported);
              if (stepped !== undefined) renderer.setResolutionScale(stepped, scaler.scaleSource);
            },
            // Last, so the engine's own renderer answers this and a game cannot report a
            // resolution it is not drawing at. The window carries it in both pinned and auto
            // modes: turning the convention off does not turn its measurement off.
            readGpuAgeFrames: () => renderer.gpuFrameAge?.(),
            // The world's own count of what the GPU selected, not `info.render.triangles`' upper
            // bound over mesh capacity. Absent until the world's first tally lands.
            readGpuTally: () => gpuTallyProvider?.(),
            // The resolved budget rides the window rather than a marker of its own, so a harness
            // reads the target and the frames it was judged against out of one line. It lags the
            // window by one, because the window is built before this callback runs.
            readTarget: () => resolveTargetFps(this.#config, getPlatform(), measuredRefreshHz),
            readSurface: () => {
              observeCompilation();
              return {
                ...renderer.surface(),
                ...(scaler === undefined ? {} : { atFloor: scaler.atFloor }),
                ...(compilingInWindow ? { compiling: true } : {}),
              };
            },
          });
    this.#frameBudget = frameBudget;
    // Per-pass draws and triangles ride the frame budget's window by default. The same property
    // that makes `info.render` an aggregate — one reset per frame before the world render, and
    // nested shadow/reflection renders sharing that counter — is what this recorder unwinds.
    const renderPassBudget =
      frameBudget === undefined
        ? undefined
        : RenderPassBudget.install(renderer.raw as Parameters<typeof RenderPassBudget.install>[0]);
    // Spans are a diagnostic, never a convention: nothing installs them unless `TN_FRAME_SPANS`
    // asks for them, and every call site below is one guarded return when it does not. They wrap
    // three's own render path rather than reimplementing it, so what they measure is the path that
    // ships, and they are removed with the game.
    const spans = spansRequested() ? new SpanRecorder() : undefined;
    if (spans !== undefined) setSpanRecorder(spans);
    const removeSpanProbes =
      spans === undefined
        ? undefined
        : installSpanProbes(renderer.raw as Parameters<typeof installSpanProbes>[0], threeScene);
    // The boundary counts ride the same flag: they wrap every WebGPU command of the frame, which is
    // work a shipped build must not pay for a diagnostic it did not ask for.
    const frameCounters =
      spans === undefined ? undefined : FrameCounters.install(counterDeviceOf(renderer.raw));
    // The parity oracle for the static freeze. Off by default and expensive on purpose: it
    // recomputes every world matrix the long way and throws on the first that disagrees with what
    // the frame is about to draw.
    const renderListValidator = renderListValidationRequested()
      ? new RenderListValidator()
      : undefined;
    if (removeSpanProbes !== undefined) {
      this.#cleanup.push(() => {
        removeSpanProbes();
        setSpanRecorder(undefined);
      });
    }
    if (frameCounters !== undefined) this.#cleanup.push(() => frameCounters.uninstall());
    // Holds no hook and does no work between requests, so an idle game pays nothing for it.
    const geometryCapture = new GeometryCapture();
    this.#geometryCapture = geometryCapture;
    const budgetNow = (): number => globalThis.performance?.now() ?? Date.now();
    // The dev verdict is decided once per launch, and sent when it changes rather than on a timer:
    // a chip that re-sent an unchanged sentence four times a second would pay a JSON round trip to
    // say nothing new.
    const devMetricsEnabled = isDevLaunch();
    let postedVerdict: string | undefined;
    const gameLoop = new FixedStepLoop({
      ...(frameBudget === undefined ? {} : { budget: frameBudget }),
      ...(spans === undefined ? {} : { spans }),
      maxSteps: this.#config.maxSteps,
      onBeginFrame: () => {
        // The engine owns this requestAnimationFrame loop instead of delegating to Three's
        // setAnimationLoop(). Three's renderer therefore cannot reset its frame counters for us;
        // a concurrent internal renderer callback can otherwise leave stale work in the first
        // sample after a held playtest start.
        resetRendererPerformanceMetrics(renderer.raw);
        renderer.beginFrame?.();
      },
      onRender: () => {
        observeCompilation();
        renderPassBudget?.beginFrame();
        // Runs on web as well as native, so the two stay one behaviour rather than diverging into
        // a fast path nobody tests. When the world is drawn, reconciliation happens immediately
        // before the render, inside the same frame, so a change the game made this tick reaches
        // the screen this tick instead of the next one. Scenes under its mesh floor get their own
        // graph back and pay nothing.
        // A goto clears the graph before its destination enters, and the projection has to drop
        // those objects on the very next frame. During the first-use hold, however, reconciling a
        // large scene would be more work before the loader has even presented. Present one
        // loader-only frame and keep reconciling skipped until first-use work settles; then the
        // world pass and projection start together behind the still-opaque layer.
        let worldMetrics: IRenderPerformanceMetrics | undefined;
        const firstWorldPass = !worldRendered && this.#sceneEntered;
        const explicitWarmUpPending = this.#warmUpConfiguredExplicitly() && !explicitWarmUpSettled;
        const loaderHasPixels = canvasLayer.scene.children.length > 0;
        const mustPresentLoader =
          firstWorldPass && canvasLayer.opaque && loaderHasPixels && !loadingFramePresented;
        if (firstWorldPass && !explicitWarmUpPending) {
          // `startupCompile` is the fallback that compiles inside the readiness gate. When warm-up
          // is on it has already happened behind the loading screen, so running it again here
          // would pay the same cost twice.
          startupReadiness.start(
            startupCoverActive() && !this.#warmUpConfiguredExplicitly()
              ? startupCompile
              : undefined,
          );
        }
        // Render-cadence compute is first-use work too: keep it behind an opaque startup layer
        // until readiness settles, or a particle process dispatch compiles in the loader frame.
        //
        // It is charged to the render phase, because it is render-path work and a bake hidden in
        // `residual` leaves the frame budget unable to enforce its per-frame limit. It cannot be
        // called from inside the render block below to get that attribution, though: that block
        // runs on `!opaque || !ready`, which is exactly the window this dispatch has to stay out
        // of. Moving the call in there dispatched on every loader frame and never once after
        // readiness — the inverse of the rule — so it stays here and adds its own render time.
        if (
          this.#renderer !== undefined &&
          this.#sceneEntered &&
          !explicitWarmUpPending &&
          (!startupCoverActive() || startupReadiness.ready)
        ) {
          const computeStart = frameBudget === undefined ? 0 : budgetNow();
          beginSpan(SPANS.compute);
          try {
            // The render camera comes with it, because a render-cadence consumer that culls by the
            // view — a streamed world's main batches — has to be driven from here and not from a draw
            // three skips for a mesh that is hidden because it has nothing to draw.
            this.#computeDriven.processRender(this.#renderer, camera);
          } finally {
            endSpan(SPANS.compute);
          }
          frameBudget?.addRender(budgetNow() - computeStart);
        }
        const waitingForFirstUse =
          firstWorldPass &&
          (explicitWarmUpPending || (startupCoverActive() && !startupReadiness.compileSettled));
        let worldPasses: ReturnType<RenderPassBudget["passes"]> | undefined;
        if (
          !mustPresentLoader &&
          !waitingForFirstUse &&
          (!canvasLayer.opaque || !startupReadiness.ready)
        ) {
          // The projection's own scene when it is faithful, the game's when it is not. Nothing
          // here branches on which: `root` is the single render input either way, so there is no
          // second optional render path to leave untested.
          // The reconcile is bracketed with the render it feeds: its walk, grouping and matrix
          // sync are render-path work, and a frame budget that hid it in `residual` made the
          // optimizer's own cost unmeasurable exactly where the optimizer is engaged.
          const renderStart = frameBudget === undefined ? 0 : budgetNow();
          // Before anything walks: a frozen subtree whose author moved its root thaws here, so the
          // walk that follows sees a transform nobody had to remember to announce.
          refreshStaticTransforms();
          // Scene prep that must read the frame's last solved state before the projection packs and
          // the renderer draws. Inside the world-render block it cannot land on a held loader frame.
          if (this.#beforeRenderCallbacks.size > 0) {
            let snapshot = this.#beforeRenderSnapshots[this.#beforeRenderDepth];
            if (snapshot === undefined) {
              snapshot = [];
              this.#beforeRenderSnapshots[this.#beforeRenderDepth] = snapshot;
            }
            this.#beforeRenderDepth += 1;
            snapshot.length = 0;
            for (const callback of this.#beforeRenderCallbacks) snapshot.push(callback);
            beginSpan(SPANS.beforeRender);
            try {
              for (const callback of snapshot) callback();
            } finally {
              endSpan(SPANS.beforeRender);
              this.#beforeRenderDepth -= 1;
            }
          }
          // Let a depth-coupled scene update its output node while the scene pass is still the
          // next render. Ordinary scenes keep the historical hook order and timing.
          const depthCoupledOutput = this.#hasDepthCoupledOutput;
          if (depthCoupledOutput && this.#sceneEntered) this.#scene?.render(ctx);
          // The engine's own walk owns the frame's world matrices, so the count starts here and
          // covers both applications below: the authored scene the projection reconciles from and
          // the root the renderer is actually handed.
          this.#matrixWorld?.beginFrame();
          if (this.#projection !== undefined) {
            beginSpan(SPANS.reconcile);
            try {
              this.#projection.reconcile();
            } finally {
              endSpan(SPANS.reconcile);
            }
          }
          // Virtual geometry ships on by default, so the engine takes the cut rather than waiting
          // for a game to know it should. It runs here, before the render and after the reconcile,
          // because an empty cut has to skip its draw rather than submit a zero-count one — and a
          // scene holding no clustered mesh pays no traversal at all, only the tracked set.
          beginSpan(SPANS.clustered);
          try {
            updateClusteredMeshes(
              this.#projection?.root ?? threeScene,
              camera,
              renderer.surfaceDrawingBufferHeight?.() ?? renderer.surface().drawingBufferHeight,
            );
          } finally {
            endSpan(SPANS.clustered);
          }
          // Automatic discrete LOD ships on with the pipeline, so the engine takes the selection
          // too. It shares the render root and the same drawing-buffer height, and a scene with no
          // managed mesh pays only the tracked-set walk.
          beginSpan(SPANS.lod);
          try {
            updateModelLods(
              this.#projection?.root ?? threeScene,
              camera,
              renderer.surface().drawingBufferHeight,
            );
          } finally {
            endSpan(SPANS.lod);
          }
          // Projected-size cull, per render camera, default on. It writes only `object.visible` —
          // the one per-frame flag the projection's batch key ignores — and restores what it hid
          // immediately after the draw, so the authored scene is untouched between frames. The
          // renderer walks the same root the projection is about to draw, so a declined projection
          // and an active one both get the gate.
          const drawingBufferHeight = renderer.surface().drawingBufferHeight;
          const cullApplyStart = spans === undefined ? 0 : spanNow();
          this.#cameraCull?.apply(
            this.#projection?.root ?? threeScene,
            camera,
            drawingBufferHeight,
          );
          // Added, not bracketed: the render call sits between the apply and the restore, and a
          // span that contained it would report the world pass as cull work.
          if (spans !== undefined) addSpan(SPANS.cull, spanNow() - cullApplyStart);
          const capturing = geometryCapture.armed();
          if (capturing) {
            // The mirror is what the renderer sees; arming the authored scene would attribute the
            // frame to objects that were never submitted.
            geometryCapture.beginFrame({
              camera,
              generation: this.#sceneGeneration,
              root: this.#projection?.root ?? threeScene,
              tick: gameLoop.tick(),
              viewportHeight: renderer.surface().drawingBufferHeight,
              viewportWidth: renderer.surface().drawingBufferWidth,
              ...(renderPassBudget === undefined
                ? {}
                : { activePassKind: () => renderPassBudget.activeKind() }),
              ...(this.#projection === undefined
                ? {}
                : { ownership: this.#projection.describeOwnership() }),
              ...(rendererBackendIdentity(renderer.raw) === undefined
                ? {}
                : { backend: rendererBackendIdentity(renderer.raw) as string }),
            });
          }
          const renderRoot = this.#projection?.root ?? threeScene;
          // three's renderer walks whatever scene it is handed, so it is told not to: the pass above
          // is the walk. Handing it the mirror sets the mirror scene's flag; the authored scene was
          // marked at construction.
          renderRoot.matrixWorldAutoUpdate = false;
          this.#matrixWorld?.apply(renderRoot);
          renderer.render(renderRoot, camera);
          // *After* the render, because that is where the draw happened. The matrices read here are
          // the ones drawn: the walk above refreshed them and `render()` did not touch them. The
          // frozen roots are passed because the draw root is the projection's mirror when the
          // engine is collapsing, and validating only that reassured about a scene it never
          // looked at. `?.` short-circuits before the spread, so `staticRoots()` is not called
          // at all on a frame without the flag — verified, a million optional calls evaluate the
          // argument zero times — and this stays a single undefined check in a shipped game.
          renderListValidator?.frame(renderRoot, ...staticRoots());
          const cullRestoreStart = spans === undefined ? 0 : spanNow();
          this.#cameraCull?.restore();
          if (spans !== undefined) addSpan(SPANS.cull, spanNow() - cullRestoreStart);
          this.#projection?.commit();
          renderer.observeRenderChainFrame?.();
          frameBudget?.addRender(budgetNow() - renderStart);
          // Read the split before the overlay renders: the overlay is its own draw, not part of the
          // world pass, and the budget window already accounts for it in its own phase.
          worldPasses = renderPassBudget?.passes();
          if (worldPasses !== undefined && worldPasses.length > 0)
            frameBudget?.addRenderPasses(worldPasses);
          // After the passes are read, so the rows reconcile against this frame's own totals.
          if (capturing) geometryCapture.finishFrame(worldPasses ?? []);
          // Resolve the GPU timestamps every frame, not once per reported window.
          //
          // `trackTimestamp` spends two queries per render pass, and three's pool holds 2048.
          // A scene with a post-processing chain runs tens of passes per frame — a cathedral
          // with SSGI, denoise, godrays, SSR and bloom measured 27 — so the pool fills in
          // 2048 / (2 x 27) = 38 frames. The resolve used to be wired to the frame-budget
          // window boundary, 300 frames by default, which is eight times too slow: three
          // warned `Maximum number of queries exceeded`, stopped recording, and every window
          // after the first reported `gpuMs: undefined`. The one instrument that exists so the
          // GPU record is not wall-clock algebra was reading nothing.
          //
          // This does not put the GPU on the frame path. `resolveTimestampsAsync` is
          // fire-and-forget and already catch-guarded, which was the original cadence's only
          // stated concern.
          // Deliberately unspanned. The resolve runs *after* `addRender` closed the render phase,
          // so its milliseconds are in the frame's `residual`, not in `render`. A span for it was
          // measured on the native smoke game at 0.18 ms and showed up as exactly that much
          // negative residual — the tree reporting, correctly, that it had been handed a term from
          // outside the phase it is dividing up. The frame budget already carries this cost.
          renderer.resolveGpuFrame();
          frameBudget?.addGpuPyramidMs(renderer.gpuPyramidMs?.());
          // The budget's GPU series is fed every frame, not read once per reported window. A
          // single window-close read is one instantaneous, lagged `info.render.timestamp` — the
          // sample that made a 17.6 ms frame read as 2.98–10.40 ms. The sample carries the
          // resolved frame id so a resolve still in flight is counted stale, not measured twice.
          //
          // The reading is the frame's own passes out of three's per-pass map, handed out one
          // resolved frame per presented frame. Three's resolve answers with one number for the
          // batch — the last frame in it — so reading that instead dropped every frame a batch
          // caught up on, and because the resolve is asked for on the same 1-in-8 stride the
          // sampler uses, how many frames a batch caught up on was a function of frame rate.
          // The pass recorder is what reads three's per-pass map back into per-frame numbers; a
          // renderer it cannot instrument falls back to the batch's own single number, which is the
          // reading there was before — one sample per resolve rather than one per sampled frame.
          const gpuFrame = renderPassBudget?.nextGpuFrame();
          const gpuSample = gpuFrame === undefined ? renderer.gpuFrameSample?.() : undefined;
          frameBudget?.addGpuMs(
            gpuFrame?.total ?? gpuSample?.ms,
            gpuFrame?.frame ?? gpuSample?.frame,
          );
          // Where one resolved frame's GPU time went: main and shadow come from the pass
          // recorder's per-uid query results, and everything else in that pool (post chain,
          // reflections, HUD) is the remainder. Compute is its own pool.
          if (gpuFrame !== undefined) {
            const computeMs = renderer.gpuComputeMs?.();
            // The recorder hands out a frame only when every pass it recorded resolved, so `total`
            // is the whole frame and never a partial sum; `main` and `shadow` are whole or zero.
            // `other` is the remainder of the frame (post chain, reflection, HUD). `shadowPasses`
            // rides along so a consumer can tell a frame that rendered a shadow from one that drew
            // none, since a real render can resolve to 0 ms.
            frameBudget?.addGpuBucketMs({
              main: gpuFrame.main,
              shadow: gpuFrame.shadow,
              shadowPasses: gpuFrame.shadowPasses,
              other: Math.max(0, gpuFrame.total - gpuFrame.main - gpuFrame.shadow),
              ...(computeMs === undefined ? {} : { compute: computeMs }),
            });
            // The main pass's own GPU series, for the adaptive LOD control loop: the frame
            // budget's `gpuMain` bucket is the record, and this is the same number smoothed on the
            // renderer so a world holding only the renderer can read it. Fed per delivered frame,
            // fresh or not.
            renderer.noteGpuMainMs?.(gpuFrame.main, gpuFrame.frame);
          } else {
            renderer.noteGpuMainMs?.(undefined);
          }
          if (!depthCoupledOutput && this.#sceneEntered) this.#scene?.render(ctx);
          if (this.#sceneEntered) {
            if (!worldRendered) gameLoop.clearRuntimeDiagnostics();
            worldRendered = true;
          }
          if (this.#renderMetricsEnabled) {
            const metrics = rendererPerformanceMetrics(renderer.raw);
            worldMetrics =
              worldPasses === undefined || worldPasses.length === 0
                ? metrics
                : { ...metrics, passes: worldPasses.map((pass) => ({ ...pass })) };
          }
          // Read whether or not the game asked for render metrics: the projection line reports
          // the measured draw count, and a convention's measurement does not switch off with the
          // convention that happens to sit beside it.
          lastWorldDrawCalls = rendererDrawCallCount(renderer.raw);
        }
        if (mustPresentLoader) loadingFramePresented = true;
        // Include state written by beforeRender and Scene.render in this frame's UI snapshot.
        if (this.#config.stateFlushMs === undefined) this.#state.flush();
        // Every frame, including one whose canvas layer is empty: the native UI is composited into
        // the game's own frame whether or not the game draws a HUD of its own, so a frame that
        // skipped this would report work it did pay as `residual`. The host reports what the
        // *previous* frame's composite cost — the only reading that exists when a frame begins —
        // so this charges the phase to the frame that paid it, one frame late rather than never.
        // Absent on the web target and on any host with no overlay, where the work is zero rather
        // than unknown, so an absent global must read as zero and not as a missing measurement.
        // The boundary counts ride the span flag, but the simulation tick does not need them: it is
        // fed every frame so a plain `TN_FRAME_BUDGET` log can join a window's start and end ticks
        // without `TN_FRAME_SPANS`. `addCounters` keeps the last tick a caller did provide.
        frameBudget?.addCounters({
          ...(frameCounters?.read() ?? {}),
          simulationTick: gameLoop.tick(),
        });
        const uiHost = globalThis as { __tnUiCompositeMs?: () => number };
        frameBudget?.addUi(
          typeof uiHost.__tnUiCompositeMs === "function" ? (uiHost.__tnUiCompositeMs() ?? 0) : 0,
        );
        if (canvasLayer.scene.children.length > 0) {
          const overlayStart = frameBudget === undefined ? 0 : budgetNow();
          // The overlay is its own render call and its own frame-budget phase. The span probes sit
          // on `render`, so without this they would charge the HUD's draw to the render phase the
          // spans are explaining — measured on the native smoke game as `coverage 1.03` and a
          // residual of −0.37 ms, two render calls per frame where the phase paid for one. The
          // recorder is unhooked rather than flagged, so every probe takes the same guarded return
          // it takes in a shipped build and the span stack cannot be left half-open.
          if (spans !== undefined) setSpanRecorder(undefined);
          try {
            renderer.renderOverlay(canvasLayer.scene, canvasLayer.camera);
          } finally {
            if (spans !== undefined) setSpanRecorder(spans);
          }
          frameBudget?.addOverlay(budgetNow() - overlayStart);
          if (!this.#renderMetricsEnabled) return undefined;
          const overlayMetrics = rendererPerformanceMetrics(renderer.raw);
          return combineRenderPerformanceMetrics(renderer.kind, worldMetrics, overlayMetrics);
        }
        return this.#renderMetricsEnabled ? worldMetrics : undefined;
      },
      onAfterPhysics: (dt) => {
        if (this.#paused) return;
        afterPhysicsPhase.run(dt);
      },
      onUpdate: (dt) => {
        if (this.#paused) return;
        this.#input?.tick();
        scheduler.tick(dt);
        pointerEvents.tick(input.raw.pointers, picker, input.raw.pointer, input.raw.pointerEdges);
        for (const plugin of this.#activePlugins) plugin.beforeUpdate?.(ctx, dt);
        const scene = this.#scene;
        const frame = this.#sceneFrame;
        if (frame !== undefined) frame(ctx, dt);
        // An async goto() installs the incoming scene before its load resolves; until enter()
        // has run there is no gameplay to step and a game-overridden update() would run against
        // a cleared graph.
        else if (this.#sceneEntered && scene !== undefined) scene.update(ctx, dt);
        if (this.#scene !== scene || this.#sceneFrame !== frame) return;
        for (const plugin of this.#activePlugins) plugin.update?.(ctx, dt);
        this.#entities?.sweep();
        const computeBlockedByStartup =
          !worldRendered &&
          ((this.#warmUpConfiguredExplicitly() && !explicitWarmUpSettled) ||
            (startupCoverActive() && !this.#warmUpConfiguredExplicitly()));
        if (this.#renderer !== undefined && this.#sceneEntered && !computeBlockedByStartup)
          this.#computeDriven.process(this.#renderer);
      },
      onFrame: (frameMs) => startupReadiness.observe(frameMs),
      step: this.#config.step,
    });
    loopState.current = gameLoop;
    this.#loop = gameLoop;
    const startGates: Array<{
      readonly gate: Promise<void>;
      readonly rejectEntered: (error: unknown) => void;
      readonly resolveEntered: () => void;
    }> = [];
    const runtime: IGamePluginRuntime = {
      fixedStep: (ticks) => gameLoop.advance(ticks),
      frameBudgetWindow: () => this.#frameBudget?.window(),
      freezeClock: () => gameLoop.freezeClock(),
      enableRuntimeDiagnostics: () => {
        this.#renderMetricsEnabled = true;
        gameLoop.setCollectMetrics(true);
      },
      holdStart: (gate) => {
        let rejectEntered: (error: unknown) => void = () => undefined;
        let resolveEntered: () => void = () => undefined;
        const entered = new Promise<void>((resolve, reject) => {
          rejectEntered = reject;
          resolveEntered = resolve;
        });
        startGates.push({ gate, rejectEntered, resolveEntered });
        return entered;
      },
      geometryCapture: (request) => geometryCapture.request(request),
      observations: createRuntimeObservations(),
      ...(renderer.pipelineCensus === undefined ? {} : { pipelineCensus: renderer.pipelineCensus }),
      tick: gameLoop.tick,
      random,
      rapier: null,
      seed: this.#config.seed ?? null,
      startupCompileSettled: () => startupReadiness.compileSettled,
      startupTimeline: () => ({ ...timeline }),
      step: gameLoop.step,
      runtimeDiagnosticsSeries: () => gameLoop.runtimeDiagnosticsSeries(),
    };
    // A boot that throws must end exactly like an aborted boot: every cleanup attempted, every
    // resource released — and the original error rethrown, not a teardown error standing in
    // for it. The abort branches below stay outside these guards: they tear down themselves.
    for (const plugin of this.#config.plugins ?? []) {
      let cleanup: PluginCleanup | undefined;
      try {
        cleanup = typeof plugin === "function" ? plugin(ctx) : await plugin.setup?.(ctx, runtime);
      } catch (error) {
        this.#teardown(ctx);
        throw error;
      }
      if (typeof plugin !== "function") this.#activePlugins.push(plugin);
      if (this.#aborted) {
        if (cleanup !== undefined) this.#cleanup.push(cleanup);
        this.#teardown(ctx);
        return;
      }
      if (cleanup !== undefined) this.#cleanup.push(cleanup);
    }
    const scene = this.#scene;
    if (scene === undefined) {
      this.#teardown(ctx);
      return;
    }
    // Held: the loop renders every frame from here but steps nothing. On native the render loop
    // is the only thing that can put pixels on the screen, so an async load starts it before the
    // await; a synchronous load has already completed and starts it after the call. Holding rather
    // than simply starting keeps the determinism contract intact: no tick advances and no elapsed
    // time is banked before the release below.
    const startHeldLoop = (): void => {
      gameLoop.setHeld(true);
      gameLoop.start();
    };
    try {
      timeline.loadStartedMs ??= now();
      const loaded = scene.load(ctx);
      startHeldLoop();
      if (loaded !== undefined) await loaded;
    } catch (error) {
      this.#teardown(ctx);
      throw error;
    }
    if (this.#aborted) {
      this.#teardown(ctx);
      return;
    }
    // Plugins that need to mutate scene-load placeholders hold here. Setup must land before
    // Scene.enter() transfers those values into authoritative physics/gameplay state.
    if (startGates.length > 0) {
      try {
        await Promise.all(startGates.map(({ gate }) => gate));
      } catch (error) {
        for (const startGate of startGates) startGate.rejectEntered(error);
        this.#teardown(ctx);
        throw error;
      }
      if (this.#aborted) {
        const error = new Error("Game start was aborted before the start scene entered.");
        for (const startGate of startGates) startGate.rejectEntered(error);
        this.#teardown(ctx);
        return;
      }
    }
    try {
      this.#enterScene(scene, ctx);
      timeline.enteredMs ??= now();
      // A start scene that navigates inside `enter()` — every `boot` template does — has handed the
      // run a world that is still in `load()`, and the entity registry is empty until it enters.
      // Releasing the gate there described a game that had not been built yet, so every
      // entity-derived capability was read off nothing. The gate follows the scene that entered.
      const worldEntered = this.#pendingSceneEnter;
      const entered = (): void => {
        for (const startGate of startGates) startGate.resolveEntered();
      };
      if (worldEntered === undefined) entered();
      else
        void worldEntered.then(entered, (error: unknown) => {
          for (const startGate of startGates) startGate.rejectEntered(error);
        });
    } catch (error) {
      for (const startGate of startGates) startGate.rejectEntered(error);
      this.#teardown(ctx);
      throw error;
    }
    if (this.#aborted) {
      this.#teardown(ctx);
      return;
    }
    // The scene is built and the loop is still held, which is the only window where compiling can
    // cost frames nobody is playing. Warming up here rather than letting the first real frame do
    // it is what keeps a launch from freezing inside one 24-second frame. PRD-218.
    if (this.#warmUpConfiguredExplicitly() && this.#renderer !== undefined) {
      // Never fatal, and never able to hang the launch. This block sits between "the scene is
      // built" and "the game may start", so anything it does wrong is something the player
      // experiences as the game not starting -- which is exactly what the first version did: a
      // `compileAsync` that never resolved on a Pixel 8 left this `await` pending forever, the
      // loop stayed held, the simulation never advanced, and the game sat on its loading screen
      // with no error anywhere. A warm-up that fails must cost the launch its speed, never its
      // start, so the failure is reported and boot carries on.
      let report: IWarmUpReport | undefined;
      let failure: string | undefined;
      try {
        projection.reconcile();
        // Same walk as the held warm-up above: the explicit warm-up also draws before the frame
        // loop's own matrix pass, and a declined projection left the scene un-walked.
        this.#matrixWorld?.apply(projection.root);
        const warmUpOptions: IWarmUpOptions = this.#warmUpOptions();
        report = await warmUpScene(this.#renderer, projection.root, camera, {
          ...warmUpOptions,
          computeNodes: [...(warmUpOptions.computeNodes ?? []), ...this.#computeDriven.warmupNodes],
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      warmUpStatus =
        report === undefined
          ? { status: "unavailable" }
          : {
              attempted: report.attempted,
              candidates: report.candidates,
              observed: report.observed,
              status: report.observed.status,
            };
      // One greppable line on every platform, so a device lane reads what the warm-up did without
      // instrumenting anything -- including the cases where it could do nothing, ran out of
      // budget, or threw.
      console.log(
        `TN_WARMUP:${JSON.stringify(
          report === undefined
            ? { failed: failure ?? "unknown" }
            : {
                compiled: report.compiled,
                pipelines: report.pipelines,
                candidates: report.candidates,
                attempted: report.attempted,
                observed: report.observed,
                slices: report.slices,
                elapsedMs: Math.round(report.elapsedMs),
                unsupported: report.unsupported,
                abandoned: report.abandoned,
                timedOut: report.timedOut,
                computeCompiled: report.computeCompiled,
                computeAbandoned: report.computeAbandoned,
                computeUnsupported: report.computeUnsupported,
                computeTimedOut: report.computeTimedOut,
                passes: report.passes,
                passPipelines: report.passPipelines,
                cullingForced: report.cullingForced,
                visibilityForced: report.visibilityForced,
                cache: report.cache,
              },
        )}`,
      );
      explicitWarmUpSettled = true;
      if (this.#aborted) {
        this.#teardown(ctx);
        return;
      }
    }
    this.#started = true;
    // Every gate has resolved and the scene has entered, so the simulation may move. The first
    // tick after this reads a single frame's dt, not one spanning the load.
    gameLoop.setHeld(false);
    gameLoop.start();
  }
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  stop(): void {
    this.#aborted = true;
    this.#geometryCapture?.cancel("TN_GEOMETRY_CAPTURE_STOPPED: the game stopped mid-capture.");
    this.#teardown();
  }

  #disposePlugin(plugin: IGamePluginHooks<TState, TPhysics>, ctx: ICtx<TState, TPhysics>): void {
    if (this.#disposedPlugins.has(plugin)) return;
    this.#disposedPlugins.add(plugin);
    plugin.dispose?.(ctx);
  }

  #teardown(startingCtx?: ICtx<TState, TPhysics>): void {
    const ctx = this.#ctx ?? startingCtx;
    // Teardown is failure-atomic: one throwing release must not strand the resources after it.
    // Every attempt runs, errors are collected, and the first — the original cause — is thrown
    // once all attempts and the final leak check have completed.
    const failures: unknown[] = [];
    this.#disconnectUi();
    this.#loop?.stop();
    this.#afterPhysicsPhase?.clear();
    this.#beforeRenderCallbacks.clear();
    if (this.#sceneEntered && ctx !== undefined) {
      try {
        this.#scene?.exit(ctx);
      } catch (error) {
        failures.push(error);
      }
    }
    this.#sceneFrame = undefined;
    this.#sceneEntered = false;
    this.#scheduler?.clear();
    this.#entities?.clear();
    this.#entities = undefined;
    if (ctx !== undefined)
      for (const plugin of this.#activePlugins) {
        try {
          this.#disposePlugin(plugin, ctx);
        } catch (error) {
          failures.push(error);
        }
      }
    this.#activePlugins = [];
    for (const cleanup of this.#cleanup.splice(0)) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (ctx !== undefined) clearScene(ctx.scene, this.#computeDriven);
    this.#cameraCull?.dispose();
    this.#cameraCull = undefined;
    this.#matrixWorld?.dispose();
    this.#matrixWorld = undefined;
    this.#input?.dispose();
    this.#state.stop();
    ctx?.canvasLayer.dispose();
    this.#viewport?.dispose();
    const renderer = this.#renderer;
    renderer?.dispose();
    if (renderer !== undefined) {
      if (this.#config.platform === undefined) renderer.domElement.remove?.();
      else this.#config.platform.unmountCanvas(renderer.domElement);
    }
    this.#renderer = undefined;
    this.#viewport = undefined;
    this.#input = undefined;
    this.#scene = undefined;
    this.#ctx = undefined;
    this.#hasDepthCoupledOutput = false;
    this.#loop = undefined;
    this.#pointerEvents?.dispose();
    this.#pointerEvents = undefined;
    this.#picker?.dispose();
    this.#picker = undefined;
    this.#scheduler = undefined;
    this.#afterPhysicsPhase = undefined;
    this.#disposedPlugins.clear();
    this.#paused = false;
    this.#started = false;
    // Runs even when releases above failed; its verdict loses to a real cleanup error, which is
    // the more actionable diagnosis of what went wrong while stopping.
    if ((ctx?.scene.children.length ?? 0) > 0)
      failures.push(new Error("IGame teardown leaked scene objects."));
    if (failures.length > 0) throw failures[0];
  }
}

function createRuntimeObservations(): IGameRuntimeObservations {
  const contributions = new Set<IGameObservationContribution>();
  return {
    contribute: (contribution) => {
      contributions.add(contribution);
      return () => contributions.delete(contribution);
    },
    contributions: () => [...contributions],
  };
}

export function defineGame<TState extends Record<string, unknown>, TPhysics = undefined>(
  config: IGameConfig<TState, TPhysics>,
): IGame<TState, TPhysics> {
  return new GameImpl<TState, TPhysics>(config);
}
