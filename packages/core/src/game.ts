import type { IAssetLoaderOptions } from "./assets.js";
import type { IAutoBatchConfig } from "./auto-batch.js";
import type { IThreeNativeConfig } from "./config.js";
import type { IFrameBudgetOptions, IFrameBudgetWindow } from "./frame-budget.js";
import {
  type IBootGame,
  clearScene,
  createBootGame,
  drainCleanup,
  throwFirst,
} from "./game-boot-phase.js";
import { startFrameLoop } from "./game-frame-loop.js";
import { startGameWorld, startScenes } from "./game-startup.js";
import { type IGameUiSeam, createGameUi } from "./game-ui.js";
import { assertCarry, validateCameraConfig } from "./game-validate.js";
import type { IGeometryCaptureReport, IGeometryCaptureRequest } from "./geometry-capture.js";
import type { ContextMenuPolicy, InputBindings, InputMap } from "./input.js";
import { reportLaunchFailure, reportSceneLoadFailure } from "./launch-diagnostics.js";
import type { IRenderPerformanceSample } from "./loop.js";
import type { IPipelineCensus } from "./pipeline-census.js";
import { installQuietMarkers, uninstallQuietMarkers } from "./quiet-markers.js";
import type { IRandom } from "./random.js";
import { type GameRendererConfig, adoptLegacyRenderKey } from "./renderer-config.js";
import type { IRendererOptions } from "./renderer.js";
import {
  SCENE_ENTRY_INSPECTORS,
  type SceneEntryInspector,
  inspectSceneEntry,
} from "./scene-entry-inspectors.js";
import type { ICtx, IStartupTimeline, Scene, SceneConstructor } from "./scene.js";
import type { IStartupOffscreenBytes } from "./startup-offscreen-bytes.js";
import { STARTUP_COMPILE_BUDGET_MS } from "./startup-readiness.js";
import { type GameStore, createGameStore } from "./state.js";
import type { IViewportOptions } from "./viewport.js";
import { type IWarmUpOptions, prepareSceneEnvironment, warmUpComputeNodes } from "./warmup.js";

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
  /**
   * Runs `ticks` fixed steps and returns how many ran. Fewer than asked when a `goto()` began
   * inside the batch: the ticks after it belong to the destination scene, which does not exist
   * until `sceneTransition()` settles.
   */
  readonly fixedStep: (ticks: number, options?: { render?: boolean }) => number;
  /**
   * The `goto()` in flight, or undefined when no scene is loading. Settles once the destination
   * scene has loaded and entered, and never rejects: a failed load is reported as a launch
   * failure. A runner that counts ticks awaits it before spending more, exactly as it awaits
   * `holdStart` at boot, so a restart cannot be outrun by the ticks that follow it.
   */
  readonly sceneTransition?: () => Promise<void> | undefined;
  /** Completed scene updates and primary world render requests, independent of budget windows. */
  readonly frameCounts?: () => { updates: number; renders: number };
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
   *
   * `settleSteps` is the settling pass the world is owed: a zero freeze lets `settleClock` spend it
   * instead, once the world's scene is live.
   */
  readonly freezeClock?: (settleSteps?: number) => void;
  /**
   * Spend the settling pass now, from a caller that knows the world's scene is live.
   *
   * Present only when the runtime can spend it later than the freeze: a game that boots through a
   * loading scene otherwise settles the loading scene, and the world's own clock misses those fixed
   * steps — a playtest pose then depends on how fast the machine booted. Optional, and paired with
   * `freezeClock(0)`: a runtime without it settles on its first live frame, as before.
   */
  readonly settleClock?: (steps?: number) => void;
  /**
   * Draw the current world once without advancing it, for a screenshot taken while the loop is
   * driven by `fixedStep` and presents nothing between ticks. Optional: a runtime without a frozen
   * render loop just never draws a standing frame. The runner asks for it only when the bridge
   * advertises it and the capture cannot otherwise see a present.
   */
  readonly renderCurrent?: () => number;
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
  /**
   * Settles when the start scene's `load()` has finished, so its entities are registered. A runner's
   * pre-entry setup awaits it: setup names entities `load()` adds, and an async `load()` (a texture
   * or a model fetch) is still pending when the runner first attaches. Rejects when `load()` throws.
   */
  readonly startSceneLoaded?: () => Promise<void>;
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
  /** The loading cover has lifted: the startup hand-off finished and page UI shows state. */
  readonly startupRevealed?: () => boolean;
  /** When the startup milestones happened, for the playtest bridge's startup observation. */
  readonly startupTimeline?: () => IStartupTimeline;
  /** What the reveal waited for that the spawn camera does not show; absent until the reveal. */
  readonly startupOffscreenBytes?: () => IStartupOffscreenBytes | undefined;
  /** The renderer-owned bounded pipeline capture, when the renderer has not been opted out. */
  readonly pipelineCensus?: () => IPipelineCensus;
  /**
   * Arms one per-object geometry capture and answers its report after the next presented world
   * frame. Absent on a runtime with no render loop to arm.
   */
  readonly geometryCapture?: (request?: IGeometryCaptureRequest) => Promise<IGeometryCaptureReport>;
  readonly step: number;
}

export interface IGamePlatformSource {
  readonly devToolsHost?: Record<string, unknown>;
  readonly input: NonNullable<ConstructorParameters<typeof InputMap>[3]>;
  readonly inputTarget?: EventTarget;
  readonly renderer: NonNullable<IRendererOptions["source"]>;
  readonly viewport: NonNullable<IViewportOptions["source"]>;
  mountCanvas(canvas: HTMLCanvasElement, container?: HTMLElement): void;
  unmountCanvas(canvas: HTMLCanvasElement): void;
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
   * Radial dead zone for both controller sticks, `0`..`1`. Default `0.2`, the stock Enhanced Input
   * value, so a worn stick resting at `0.08` reads zero instead of walking the character. A stick
   * past the zone is rescaled so full tilt is still `1`. Pass `0` to read raw axes.
   */
  readonly gamepadDeadZone?: number;
  /**
   * Per-frame cost attribution, on by default. Every `reportEvery` presented frames the game
   * prints one `TN_FRAME_BUDGET` line naming where the frame went — present wait, simulation,
   * three.js render, overlay, the rest — which is what a device lane reads instead of guessing.
   * Pass `false` to silence the marker; the same numbers still reach a playtest `performance`
   * assertion, because turning a convention off must not turn its measurement off.
   */
  readonly frameBudget?: IFrameBudgetOptions | false;
  /**
   * Static meshes that share a material merge into one draw once the scene has settled, on by
   * default and reported as `TN_AUTO_BATCH`. A mesh the game later moves, hides or re-materials
   * comes back at once. `false` turns the pass off; `userData.batch = "off"` on a mesh or any
   * ancestor keeps just that subtree out.
   */
  readonly autoBatch?: boolean | IAutoBatchConfig;
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
  /** Smooth physics objects and the camera between fixed ticks. Default true. */
  readonly physicsInterpolation?: boolean;
  readonly maxSteps?: number;
  readonly platform?: IGamePlatformSource;
  readonly plugins?: readonly GamePlugin<TState, TPhysics>[];
  /**
   * The project's `display` block, passed straight through from `threenative.config.ts`. The
   * adaptive scale holds `maxFps` as its budget, so a game that does not pass this gets the
   * 60 fps default rather than a scaler with no target.
   */
  readonly display?: NonNullable<IThreeNativeConfig["display"]>;
  /**
   * The project's renderer settings: `config.renderer` from `threenative.config.ts` beside the live
   * renderer options, as one key.
   *
   * `render` once carried the portable half, so a game wrote `render: config.renderer` beside a
   * second `renderer:` and the antialias and scale resolvers each fell back from one to the other.
   * The keys are one now; `render` is adopted onto this one and reported as renamed.
   */
  readonly renderer?: GameRendererConfig;
  /**
   * @deprecated The retired name for {@link renderer}, adopted onto it and reported. Move the object
   * to `renderer` with no other change.
   */
  readonly render?: GameRendererConfig;
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
  /**
   * Boot into `name` instead of `config.start` on the next `start()`. Hot reload's restore path.
   * `revealed`: the session already showed its HUD, so the restarted game keeps the cover lifted.
   */
  resumeScene(name: string, options?: { readonly revealed?: boolean }): void;
  start(): Promise<void>;
  pause(): void;
  resume(): void;
  stop(): void;
}

class GameImpl<TState extends Record<string, unknown>, TPhysics>
  implements IGame<TState, TPhysics>
{
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
    return this.#boot.config.warmUp !== undefined && this.#boot.config.warmUp !== false;
  }

  /** The warm-up options for the pre-start block, once an explicit opt-in has asked for it. */
  #warmUpOptions(): IWarmUpOptions {
    const configured = this.#boot.config.warmUp;
    return configured === undefined || configured === true || configured === false
      ? {}
      : configured;
  }
  #initialState: TState;
  #pendingStart: Promise<void> | undefined;
  /**
   * What the boot phases read and assign. One plain object: a field a phase needs and this object
   * lacks is a type error, never an `undefined` read at run time.
   */
  readonly #boot: IBootGame<TState, TPhysics>;

  /** The scene-entry audits this game runs, in order. The engine's are the default. */
  #sceneEntryInspectors: readonly SceneEntryInspector[] = SCENE_ENTRY_INSPECTORS;
  readonly #ui: IGameUiSeam;

  constructor(config: IGameConfig<TState, TPhysics>) {
    // One key for the renderer settings: a game still on `render` is adopted, reported, and boots.
    const resolved = adoptLegacyRenderKey(config);
    validateCameraConfig(resolved.camera);
    const startScene = resolved.scenes[resolved.start];
    if (startScene === undefined) throw new Error(`Unknown start scene '${resolved.start}'.`);
    const initialState =
      resolved.initialState ??
      (startScene as SceneConstructor<TState, TPhysics> & { initialState?: TState }).initialState;
    if (initialState === undefined) {
      throw new Error(
        `Scene '${resolved.start}' must declare static initialState or provide config.initialState.`,
      );
    }
    this.#initialState = { ...initialState };
    this.#boot = createBootGame({
      config: resolved,
      state: createGameStore(initialState, resolved.stateFlushMs),
      connectUi: () => this.#ui.connect(),
      enterScene: (scene, ctx) => this.#enterScene(scene, ctx),
      goto: (name, ctx) => this.#goto(name, ctx),
      postUiStartup: () => this.#ui.postStartup(),
      teardown: () => this.#teardown(),
      warmUpConfiguredExplicitly: () => this.#warmUpConfiguredExplicitly(),
      warmUpOptions: () => this.#warmUpOptions(),
    });
    this.#ui = createGameUi(this.#boot);
  }

  get ctx(): ICtx<TState, TPhysics> | undefined {
    return this.#boot.ctx;
  }

  get scene(): Scene<TState, TPhysics> | undefined {
    return this.#boot.scene;
  }

  /** The name of the entered scene, or undefined before `start()`. */
  get sceneName(): string | undefined {
    return this.#boot.sceneName;
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
  resumeScene(name: string, options?: { readonly revealed?: boolean }): void {
    if (this.#boot.config.scenes[name] === undefined) throw new Error(`Unknown scene '${name}'.`);
    this.#boot.resumeScene = name;
    // An edit restarts the game, and its HUD would blank until this startup lifted the cover
    // again: seconds after every save on a slow GPU. A session that showed its HUD keeps it.
    // The updated module may have connected its UI already and told a waiting HUD to hide.
    if (options?.revealed !== true) return;
    this.#boot.uiRevealed = true;
    if (this.#boot.uiBridge?.hasPeer()) this.#ui.postStartup();
  }

  get state(): GameStore<TState> {
    return this.#boot.state;
  }

  /**
   * The UI seam. Startup connects it even for a read-only HUD; accessing it before startup
   * connects early so the game can register intents. No state is serialized without a UI peer.
   */
  get ui(): IGameUi {
    return this.#ui.facade();
  }

  goto(name: string, options?: IGotoOptions<TState>): Promise<void> {
    if (this.#boot.ctx === undefined) throw new Error("Cannot call game.goto() before start().");
    // Validate before the reset: a typo'd scene name must not wipe the live session's state on
    // its way to throwing.
    const SceneType = this.#boot.config.scenes[name];
    if (SceneType === undefined) throw new Error(`Unknown scene '${name}'.`);
    const carry = options?.carry;
    if (carry !== undefined) assertCarry(carry);
    const destinationInitialState =
      (SceneType as SceneConstructor<TState, TPhysics> & { initialState?: TState }).initialState ??
      this.#initialState;
    this.#boot.state.stop();
    this.#boot.state.setState({
      ...destinationInitialState,
      ...(carry as Partial<TState> | undefined),
    });
    this.#boot.state.start();
    return this.#goto(name, this.#boot.ctx);
  }

  #goto(name: string, ctx: ICtx<TState, TPhysics>): Promise<void> {
    const SceneType = this.#boot.config.scenes[name];
    if (SceneType === undefined) throw new Error(`Unknown scene '${name}'.`);

    this.#boot.hasDepthCoupledOutput = false;
    this.#boot.sceneGeneration += 1;
    // The objects a pending capture armed are leaving the graph; a report about them would be
    // about a scene that no longer exists.
    this.#boot.geometryCapture?.cancel(
      "TN_GEOMETRY_CAPTURE_SCENE_EXIT: the scene changed mid-capture.",
    );
    this.#boot.sceneFrame = undefined;
    this.#boot.afterPhysicsPhase?.clear();
    this.#boot.beforeRenderCallbacks.clear();
    this.#boot.interpolation?.clear();
    this.#boot.interpolation?.track(ctx.camera);
    this.#boot.scene?.exit(ctx);
    this.#boot.pointerEvents?.clear();
    this.#boot.sceneEntered = false;
    this.#boot.scheduler?.clear();
    this.#boot.entities?.clear();
    for (const plugin of this.#boot.config.plugins ?? []) {
      if (typeof plugin !== "function") plugin.sceneExit?.(ctx);
    }
    // The projection holds batches built from the outgoing scene's geometry. Released before the
    // scene is cleared, so a scene change cannot leave the next level drawing the last one's
    // props — and released rather than rebuilt, because every source it referenced is about to go.
    this.#boot.projection?.dispose();
    // Put back anything the cull hid before the outgoing scene is cleared, so a scene change never
    // leaves an object invisible if the game keeps a reference to it.
    this.#boot.cameraCull?.restore();
    this.#boot.autoBatch?.reset();
    clearScene(ctx.scene, this.#boot.computeDriven);
    const scene = new SceneType();
    this.#boot.scene = scene;
    this.#boot.sceneName = name;
    let loaded: ReturnType<Scene<TState, TPhysics>["load"]>;
    try {
      loaded = scene.load(ctx);
    } catch (error) {
      reportSceneLoadFailure(error);
      throw error;
    }
    const transition =
      loaded === undefined
        ? this.#enterTransitionScene(scene, ctx)
        : Promise.resolve(loaded).then(() => this.#enterTransitionScene(scene, ctx));
    const settled = (): void => {
      if (this.#boot.pendingSceneEnter === transition) this.#boot.pendingSceneEnter = undefined;
    };
    // Handled here as well as by the caller: a start scene that navigates inside `enter()` throws
    // its transition away, and the gate below still has to learn that no world arrived. The failure
    // is reported by name: a swallowed rejection left the loading screen up as a "stall" with
    // nothing outstanding (midway-open-pacific on the Wasm engine).
    void transition.then(settled, (error: unknown) => {
      settled();
      reportLaunchFailure({
        kind: "scene-load-failed",
        message: `Scene '${name}' failed to load: ${error instanceof Error ? error.message : String(error)}`,
      });
    });
    this.#boot.pendingSceneEnter = transition;
    return transition;
  }

  #enterScene(scene: Scene<TState, TPhysics>, ctx: ICtx<TState, TPhysics>): boolean {
    const frame = scene.enter(ctx);
    if (frame !== undefined && typeof frame !== "function") {
      throw new Error("Scene.enter() must return a frame function or undefined.");
    }
    // A boot scene may navigate synchronously; do not replace the frame installed by #goto().
    if (this.#boot.scene !== scene) return false;
    this.#boot.sceneFrame = typeof frame === "function" ? frame : undefined;
    this.#boot.sceneEntered = true;
    // What `enter()` built is what the warm-up compiles and the first frame draws, so it merges
    // now, before either: no frame is ever drawn unmerged, and the compile counts merged meshes,
    // not every source. Anything that moves afterwards is given back by the guard.
    this.#boot.autoBatch?.settleNow();
    // Every entry audit, in the order `scene-entry-inspectors.ts` states: the opacity convention
    // first, so an opacity it made take effect is what the render trap audit then reports. Adding a
    // fourth audit does not edit this file.
    inspectSceneEntry(ctx.scene, this.#sceneEntryInspectors);
    const entered = this.#boot.onStartSceneEntered;
    this.#boot.onStartSceneEntered = undefined;
    entered?.();
    return true;
  }

  async #enterTransitionScene(
    scene: Scene<TState, TPhysics>,
    ctx: ICtx<TState, TPhysics>,
  ): Promise<void> {
    // A load can finish after the game moved on or stopped. Check before `enter()`, because an
    // entry hook mutates the live Three.js scene and no later check can undo that. The check
    // inside `#enterScene` stays: an entry hook may itself navigate.
    if (this.#boot.aborted || this.#boot.ctx !== ctx || this.#boot.scene !== scene) return;
    if (!this.#enterScene(scene, ctx)) return;
    const renderer = this.#boot.renderer;
    const nodes = this.#boot.computeDriven.warmupNodes;
    // Before startup readiness has begun, its own warm-up bakes the entered scene's environment.
    // Baking here too held the world pass for the whole bake: the runner kit's Boot calls
    // goto("run") from enter(), the bake took 35 s on SwiftShader (about 50 s on CI), the startup
    // warm-up then prepared it again, and the launch sat at 80% until TN_STARTUP_STALLED. An
    // explicit warm-up runs once, right after the start scene, so a transition keeps its bake.
    const hasEnvironment =
      ctx.scene.environment?.isTexture === true &&
      (this.#boot.startupGateStarted || this.#warmUpConfiguredExplicitly());
    if (renderer === undefined || (nodes.length === 0 && !hasEnvironment)) return;
    this.#boot.sceneEntered = false;
    let report: Awaited<ReturnType<typeof warmUpComputeNodes>> | undefined;
    let environmentPrepared: boolean | undefined;
    let failure: string | undefined;
    try {
      const options = this.#warmUpOptions();
      if (hasEnvironment) {
        const projection = this.#boot.projection;
        projection?.reconcile();
        const root = projection?.root ?? ctx.scene;
        this.#boot.matrixWorld?.apply(root);
        // A new environment skips world draws until its retained bake has completed. Only the bake:
        // a whole-scene warm-up here held the runner kit's first frame for its 45 s budget on
        // SwiftShader, and the first world frame's startup warm-up compiles the scene anyway.
        const now = globalThis.performance?.now() ?? Date.now();
        environmentPrepared = await prepareSceneEnvironment(
          renderer,
          root,
          ctx.camera,
          now + (options.budgetMs ?? STARTUP_COMPILE_BUDGET_MS),
        );
      }
      if (nodes.length > 0) report = await warmUpComputeNodes(renderer, nodes, options);
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    console.log(
      `${hasEnvironment ? "TN_TRANSITION_WARMUP" : "TN_TRANSITION_COMPUTE_WARMUP"}:${JSON.stringify(
        failure !== undefined || (report === undefined && environmentPrepared === undefined)
          ? { failed: failure ?? "unknown" }
          : {
              ...(environmentPrepared === undefined ? {} : { environmentPrepared }),
              ...(report === undefined
                ? {}
                : {
                    compiled: report.compiled,
                    abandoned: report.abandoned,
                    unsupported: report.unsupported,
                    timedOut: report.timedOut,
                  }),
            },
      )}`,
    );
    if (!this.#boot.aborted && this.#boot.scene === scene) this.#boot.sceneEntered = true;
  }

  start(): Promise<void> {
    if (this.#boot.started) return Promise.resolve();
    if (this.#pendingStart !== undefined) return this.#pendingStart;
    this.#boot.aborted = false;
    installQuietMarkers();
    const pendingStart = this.#launch().catch((error: unknown) => {
      this.#ui.disconnect();
      throw error;
    });
    this.#pendingStart = pendingStart;
    void pendingStart.then(
      () => {
        if (this.#pendingStart === pendingStart) this.#pendingStart = undefined;
      },
      (error: unknown) => {
        if (this.#pendingStart === pendingStart) this.#pendingStart = undefined;
        // Reported by name: a game that writes `void game.start()` otherwise keeps its loading
        // screen up until the stall watcher says "no asset is outstanding".
        reportLaunchFailure({
          kind: "start-failed",
          message: `The game failed to start: ${error instanceof Error ? error.message : String(error)}`,
        });
      },
    );
    return pendingStart;
  }

  async #launch(): Promise<void> {
    const startup = await startGameWorld(this.#boot);
    if (startup === undefined) return;
    const frameLoop = startFrameLoop(startup);
    await startScenes(startup, frameLoop);
  }

  pause(): void {
    this.#boot.paused = true;
  }

  resume(): void {
    this.#boot.paused = false;
  }

  stop(): void {
    this.#boot.aborted = true;
    this.#boot.geometryCapture?.cancel(
      "TN_GEOMETRY_CAPTURE_STOPPED: the game stopped mid-capture.",
    );
    this.#teardown();
    uninstallQuietMarkers();
  }

  /**
   * Releases everything the boot acquired. Each phase pushed its own release onto `cleanup` as it
   * acquired the resource, and they run newest first (`drainCleanup`), so nothing is released while
   * something built on it is still alive. The order the specs pin falls out of the push order:
   * loop, scene exit, plugin `dispose`, plugin cleanups, input, store, renderer.
   *
   * The UI goes first and is not on the stack: its lifetime is the game's, not a boot's, and the
   * scene exit and plugin `dispose` after it must not publish to a page that is leaving.
   */
  #teardown(): void {
    const boot = this.#boot;
    boot.onStartSceneEntered = undefined;
    const ctx = boot.ctx;
    this.#ui.disconnect();
    // Failure-atomic: one throwing release does not strand the ones after it. The first failure,
    // the original cause, is thrown once all have run and the leak check has completed.
    const failures = drainCleanup(boot.cleanup);
    boot.scene = undefined;
    boot.ctx = undefined;
    boot.hasDepthCoupledOutput = false;
    boot.paused = false;
    boot.started = false;
    // Runs even when releases above failed; its verdict loses to a real cleanup error, which is
    // the more actionable diagnosis of what went wrong while stopping.
    if ((ctx?.scene.children.length ?? 0) > 0)
      failures.push(new Error("IGame teardown leaked scene objects."));
    throwFirst(failures);
  }
}

export function defineGame<TState extends Record<string, unknown>, TPhysics = undefined>(
  config: IGameConfig<TState, TPhysics>,
): IGame<TState, TPhysics> {
  return new GameImpl<TState, TPhysics>(config);
}
