import { flushAnimationTicks } from "./animation-batch.js";
import type { AutoBatch } from "./auto-batch.js";
import { updateClusteredMeshes } from "./clustered-mesh.js";
import type { ComputeDrivenRegistry } from "./compute-driven.js";
import type { Registry } from "./entities.js";
import { FrameBudget } from "./frame-budget.js";
import { isDevLaunch } from "./game-dev-tools.js";
import {
  combineRenderPerformanceMetrics,
  rendererDrawCallCount,
  rendererPerformanceMetrics,
  resetRendererPerformanceMetrics,
} from "./game-renderer-metrics.js";
import { STARTUP_HANDOFF_FRAMES } from "./game-startup.js";
import type { IGameStartup } from "./game-startup.js";
import type { IGameConfig, IGamePlatformSource, IGamePluginHooks, PluginCleanup } from "./game.js";
import { GeometryCapture, rendererBackendIdentity } from "./geometry-capture.js";
import type { InputMap } from "./input.js";
import type { PhysicsInterpolation } from "./interpolation.js";
import type { IAfterPhysicsPhase } from "./loop.js";
import { FixedStepLoop, type IRenderPerformanceMetrics } from "./loop.js";
import type { MatrixWorldPass } from "./matrix-world.js";
import { updateModelLods } from "./model-lod.js";
import type { ScenePicker } from "./picking.js";
import { getPlatform } from "./platform.js";
import type { PointerEvents3D } from "./pointer-events.js";
import {
  FrameCounters,
  counterDeviceOf,
  createCrossingReader,
  createEngineCounterReader,
} from "./profiling/FrameCounters.js";
import {
  createStageReader,
  createWorkReader,
  stageMetersRequested,
} from "./profiling/FrameStages.js";
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
import { countDebug, measureDebug, observeDebugGc } from "./profiling/debug-telemetry.js";
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
import type { RenderCameraCull } from "./render-camera-cull.js";
import { RenderPassBudget } from "./render-pass-budget.js";
import type { VirtualShadowNode } from "./render/virtual-shadow.js";
import type { SceneRenderProjection } from "./renderProjection.js";
import { resolvePlatformResolutionFloor } from "./renderer-config.js";
import type { IRendererLike } from "./renderer.js";
import { rendererFrameGateSkips, rendererWorldPresented } from "./renderer.js";
import { RESOLUTION_SCALER, ResolutionScaler } from "./resolution-scaler.js";
import type { ICtx, Scene, SceneFrame } from "./scene.js";
import type { Scheduler } from "./schedule.js";
import { STARTUP_STABLE_WINDOW_MS } from "./startup-readiness.js";
import type { GameStore } from "./state.js";
import {
  STATIC_TRANSFORM_MARKER,
  refreshStaticTransforms,
  staticRoots,
  staticTransformCensus,
} from "./static-transform.js";
import { resolveTargetFps } from "./target-fps.js";
import type { IUiBridge } from "./ui-bridge.js";
import { UI_DEV_METRICS_MESSAGE } from "./ui-bridge.js";
import type { Viewport } from "./viewport.js";
import type { IWarmUpOptions } from "./warmup.js";

/**
 * The game's own state, as a boot phase sees it: every member is the private field of the same
 * name, so a phase assigns and reads exactly what it did inside the class.
 */
export interface IGameBootGame<TState extends Record<string, unknown>, TPhysics> {
  /** The cleanups `#teardown` drains in its own release step, in the order they were pushed. */
  readonly cleanup: Array<() => void>;
  readonly computeDriven: ComputeDrivenRegistry;
  readonly config: IGameConfig<TState, TPhysics>;
  readonly platform: IGamePlatformSource | undefined;
  readonly state: GameStore<TState>;
  readonly beforeRenderCallbacks: Set<() => void>;
  readonly activePlugins: Array<IGamePluginHooks<TState, TPhysics>>;
  readonly uiBridge: IUiBridge | undefined;
  readonly sceneFrame: SceneFrame<TState, TPhysics> | undefined;
  readonly sceneEntered: boolean;
  readonly sceneGeneration: number;
  readonly pendingSceneEnter: Promise<void> | undefined;
  readonly paused: boolean;
  readonly aborted: boolean;
  readonly uiReady: boolean;
  // Assigned by a phase, exactly as the field was.
  renderer: IRendererLike | undefined;
  scene: Scene<TState, TPhysics> | undefined;
  sceneName: string | undefined;
  ctx: ICtx<TState, TPhysics> | undefined;
  input: InputMap | undefined;
  viewport: Viewport | undefined;
  picker: ScenePicker | undefined;
  pointerEvents: PointerEvents3D | undefined;
  matrixWorld: MatrixWorldPass | undefined;
  projection: SceneRenderProjection | undefined;
  autoBatch: AutoBatch | undefined;
  cameraCull: RenderCameraCull | undefined;
  entities: Registry | undefined;
  scheduler: Scheduler | undefined;
  afterPhysicsPhase: IAfterPhysicsPhase | undefined;
  frameBudget: FrameBudget | undefined;
  interpolation: PhysicsInterpolation | undefined;
  geometryCapture: GeometryCapture | undefined;
  beforeRenderSnapshots: Array<Array<() => void>>;
  beforeRenderDepth: number;
  hasDepthCoupledOutput: boolean;
  startupGateStarted: boolean;
  onStartSceneEntered: (() => void) | undefined;
  renderMetricsEnabled: boolean;
  uiRevealed: boolean;
  started: boolean;
  resumeScene: string | undefined;
  connectUi(): IUiBridge;
  enterScene(scene: Scene<TState, TPhysics>, ctx: ICtx<TState, TPhysics>): boolean;
  goto(name: string, ctx: ICtx<TState, TPhysics>): Promise<void>;
  postUiStartup(): void;
  teardown(ctx?: ICtx<TState, TPhysics>): void;
  warmUpConfiguredExplicitly(): boolean;
  warmUpOptions(): IWarmUpOptions;
}

/** The frame loop, and the instruments that only exist while it runs. */
export interface IGameFrameLoop {
  /** Stops the loop, where `#teardown` always stopped it. Its frame budget is `game.frameBudget`. */
  readonly dispose: PluginCleanup;
  readonly geometryCapture: GeometryCapture;
  readonly loop: FixedStepLoop;
}

/** The second phase of `#boot`: the scaler, the frame budget, its diagnostics, and the loop. */
export function startFrameLoop<TState extends Record<string, unknown>, TPhysics>(
  startup: IGameStartup<TState, TPhysics>,
): IGameFrameLoop {
  const game = startup.game;
  const {
    afterPhysicsPhase,
    autoBatch,
    camera,
    canvasLayer,
    ctx,
    debug,
    input,
    interpolation,
    loopState,
    now,
    picker,
    pointerEvents,
    projection,
    renderer,
    scheduler,
    startupCompile,
    startupCoverActive,
    startupEnvironment,
    startupReadiness,
    startupShadows,
    threeScene,
    timeline,
  } = startup;

  // The scaler exists whenever the scale is automatic, which now includes a game that said
  // nothing about it. A pinned number leaves this undefined, which is what makes "pinned" a
  // guarantee rather than a preference the loop may overrule. `maxFps: 0` removes the ceiling,
  // and a scaler with no budget is not a scaler with a loose one, so an uncapped game simply
  // does not get adaptive scaling.
  const initialTarget = resolveTargetFps(game.config, getPlatform());
  let heldTargetFps = initialTarget.targetFps;
  // Frame-share budgets elsewhere (the world's adaptive LOD) read the target, not the last frame.
  renderer.noteTargetFps?.(initialTarget.targetFps);
  const automaticScale = renderer.surface().scaleSource === "auto";
  const createScaler = () =>
    automaticScale && heldTargetFps > 0
      ? new ResolutionScaler({
          // Phones keep the device ladder; a desktop stops before its bottom, where a picture
          // with nothing reconstructing it stops being a faster frame and becomes a blur.
          minScale: resolvePlatformResolutionFloor(getPlatform().os),
          // The adapter family picks the first rung; the first eligible window still decides.
          start:
            renderer.temporalUpscaleStartScale?.() ??
            (renderer.gpuClass === undefined
              ? undefined
              : RESOLUTION_SCALER.startScaleByGpuClass[renderer.gpuClass.class]),
          targetFps: heldTargetFps,
          temporalUpscale: () => renderer.temporalUpscale?.() === true,
        })
      : undefined;
  let scaler = createScaler();
  let temporalStartApplied = renderer.temporalUpscale?.() === true;
  // A class that starts below the ceiling must draw there from the first frame; the scaler only
  // reports a scale, and nothing else would apply it until a window steps.
  if (scaler !== undefined && scaler.scale !== 1)
    renderer.setResolutionScale(scaler.scale, scaler.scaleSource);
  // The panel's own rate, once a window of presented frames can say it. The native host's
  // present counter is the only series there that counts displays rather than loop iterations;
  // on the web one rAF callback is one vblank, so the median presented interval is the period.
  let measuredRefreshHz: number | undefined;
  // The world pass's own draw-call count, kept from the last frame of the window so the
  // projection line can report what the renderer was handed beside what the plan predicted.
  // A plan and a measurement that disagree is the finding; one number pretending to be both
  // is how an optimizer reports a win it did not deliver.
  let loadingFramePresented = false;
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
    game.config.frameBudget === false
      ? undefined
      : new FrameBudget({
          ...game.config.frameBudget,
          simulation: {
            tick: () => gameLoop.tick(),
            get step() {
              return gameLoop.step;
            },
            get clockFrozen() {
              return gameLoop.clockFrozen;
            },
          },
          // The scaler reads the same windows the marker reports, so what it acted on and what
          // the record shows are the same measurement rather than two sampling paths.
          onWindow: (reported) => {
            const sink =
              game.config.frameBudget === false ? undefined : game.config.frameBudget?.report;
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
            const target = resolveTargetFps(game.config, getPlatform(), measuredRefreshHz);
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
            game.computeDriven.observeBudget(reported);
            const projection = game.projection;
            // Printed every window, projecting or declined. `TN_RENDER_PROJECTION` says once
            // whether the optimizer engaged; this says, repeatedly, what it is still leaving on
            // the exact lane and whether the renderer agrees with the plan.
            if (projection !== undefined) {
              reportInfo(
                formatProjectionWindow(
                  projection.windowReport,
                  reported.window,
                  lastWorldDrawCalls,
                  game.cameraCull?.report,
                  game.matrixWorld?.report,
                ),
              );
            }
            if (game.config.frameBudget !== false) game.config.frameBudget?.onWindow?.(reported);
            // The span tree closes on the same window, so the two lines in a log describe the
            // same frames and a reader can subtract one from the other without a second clock.
            const spanWindow = spans?.window();
            if (spanWindow !== undefined) reportInfo(formatSpansWindow(spanWindow));
            // The scene-shape verdict, on by default in a debug launch, from the census the
            // frame already took. An agent building a scene of the wrong shape reads it in the
            // log before a human ever plays the game and calls it slow.
            const staticCensus = staticTransformCensus();
            if (staticCensus.roots > 0)
              reportInfo(`${STATIC_TRANSFORM_MARKER}:${JSON.stringify(staticCensus)}`);
            const validation = renderListValidator?.report();
            if (validation !== undefined) reportInfo(formatValidationReport(validation));
            const warning = devMetricsEnabled
              ? sceneWarning(
                  reported,
                  describeSceneShape(reported, game.cameraCull?.report),
                  target.targetFps,
                  renderer.gpuClass?.class,
                )
              : undefined;
            if (warning !== undefined) reportWarning(formatSceneWarning(warning));
            // The same sentence goes to the UI on a dev launch, so a human watching the window
            // and an agent reading the log are told the same thing at the same time. No frame
            // rate rides it: the loop's own rAF rate reads throttled under a compositor or a
            // virtual display, so a number drawn from it lies in exactly the sessions where
            // somebody is trying to measure.
            if (devMetricsEnabled && warning !== undefined && game.uiBridge?.hasPeer() === true) {
              const verdict = describeSceneWarning(warning);
              if (verdict !== postedVerdict) {
                postedVerdict = verdict;
                game.uiBridge.post({ type: UI_DEV_METRICS_MESSAGE, sceneWarning: verdict });
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
          readGpuTally: () => startup.gpuTallyProvider?.(),
          // The resolved budget rides the window rather than a marker of its own, so a harness
          // reads the target and the frames it was judged against out of one line. It lags the
          // window by one, because the window is built before this callback runs.
          readTarget: () => resolveTargetFps(game.config, getPlatform(), measuredRefreshHz),
          readSurface: () => {
            observeCompilation();
            return {
              ...renderer.surface(),
              ...(scaler === undefined ? {} : { atFloor: scaler.atFloor }),
              compiling: compilingInWindow,
            };
          },
        });
  game.frameBudget = frameBudget;
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
  // The engine's own ABI crossings ride every budget window, not the spans flag: one difference of
  // two reads per frame, and the series a fix for repeated crossings is judged on.
  const bridgeCrossings = createCrossingReader();
  // Every engine work counter, per frame, when a playtest bounds them (PRD-748 engine-cost row).
  const engineCounters = createEngineCounterReader();
  if (debug) engineCounters();
  // The parity oracle for the static freeze. Off by default and expensive on purpose: it
  // recomputes every world matrix the long way and throws on the first that disagrees with what
  // the frame is about to draw.
  const renderListValidator = renderListValidationRequested()
    ? new RenderListValidator()
    : undefined;
  if (removeSpanProbes !== undefined) {
    game.cleanup.push(() => {
      removeSpanProbes();
      setSpanRecorder(undefined);
    });
  }
  if (frameCounters !== undefined) game.cleanup.push(() => frameCounters.uninstall());
  if (debug) {
    const stopGc = observeDebugGc();
    if (stopGc !== undefined) game.cleanup.push(stopGc);
  }
  // Holds no hook and does no work between requests, so an idle game pays nothing for it.
  const geometryCapture = new GeometryCapture();
  game.geometryCapture = geometryCapture;
  const budgetNow = (): number => globalThis.performance?.now() ?? Date.now();
  // The stage meters split the render phase (PRD-771): three clock reads a frame and one difference of the
  // engine's running totals. Decided once; `?tnStages=0` turns the whole path off, here and in the engine.
  const stageMeters = frameBudget !== undefined && stageMetersRequested();
  const readStages = stageMeters ? createStageReader(() => renderer.raw) : undefined;
  const readWork = stageMeters ? createWorkReader(() => renderer.raw) : undefined;
  if (!stageMeters)
    (renderer.raw as { setStageMeters?: (enabled: boolean) => void }).setStageMeters?.(false);
  let computeStageMs = 0;
  // The dev verdict is decided once per launch, and sent when it changes rather than on a timer:
  // a chip that re-sent an unchanged sentence four times a second would pay a JSON round trip to
  // say nothing new.
  const devMetricsEnabled = isDevLaunch();
  let postedVerdict: string | undefined;
  let lastGateSkips = 0;
  let readinessGateSkips = 0;
  const gameLoop: FixedStepLoop = new FixedStepLoop({
    interpolation,
    ...(frameBudget === undefined ? {} : { budget: frameBudget }),
    ...(spans === undefined ? {} : { spans }),
    maxSteps: game.config.maxSteps,
    onBeginFrame: () => {
      // The engine owns this requestAnimationFrame loop instead of delegating to Three's
      // setAnimationLoop(). Three's renderer therefore cannot reset its frame counters for us;
      // a concurrent internal renderer callback can otherwise leave stale work in the first
      // sample after a held playtest start.
      resetRendererPerformanceMetrics(renderer.raw);
      renderer.beginFrame?.();
    },
    onRender: (alpha) => {
      observeCompilation();
      // Before the first world pass compiles anything: the merged meshes it compiles are the ones
      // the player will see. A scene that has not entered has nothing built to settle.
      if (game.sceneEntered) {
        if (debug)
          measureDebug("autoBatch", "renderer", "AutoBatch.update", () => autoBatch.update());
        else autoBatch.update();
      }
      if (!startup.projectionSettled) {
        for (const node of startupShadows) node.startupCovered = false;
        startupShadows.clear();
        threeScene.traverseVisible((object) => {
          if (!object.castShadow || !object.visible) return;
          // A type flag, not instanceof: a value import would pull the shadow nodes into every
          // native bundle, where the engine binds none of them.
          const node = Reflect.get(object, "shadow")?.shadowNode as VirtualShadowNode | undefined;
          if (node?.isVirtualShadowNode === true) {
            startupShadows.add(node);
            node.startupCovered = startupCoverActive();
          }
        });
      }
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
      const firstWorldPass = !startup.worldRendered && game.sceneEntered;
      const explicitWarmUpPending =
        game.warmUpConfiguredExplicitly() && !startup.explicitWarmUpSettled;
      const loaderHasPixels = canvasLayer.scene.children.length > 0;
      const mustPresentLoader =
        firstWorldPass && canvasLayer.opaque && loaderHasPixels && !loadingFramePresented;
      if (firstWorldPass && !explicitWarmUpPending) {
        game.startupGateStarted = true;
        // `startupCompile` is the fallback that compiles inside the readiness gate. When warm-up
        // is on it has already happened behind the loading screen, so running it again here
        // would pay the same cost twice.
        startupReadiness.start(
          game.warmUpConfiguredExplicitly()
            ? undefined
            : startupCoverActive()
              ? startupCompile
              : startupEnvironment(),
        );
      }
      // Ordinary render compute waits for startup readiness. Streaming explicitly opts in
      // after compilation so a spawn hold can finish behind the curtain. Present the loader
      // first; charge this admission to the same render phase as normal render compute.
      if (
        game.renderer !== undefined &&
        game.sceneEntered &&
        !explicitWarmUpPending &&
        !mustPresentLoader &&
        (!startupCoverActive() || startupReadiness.compileSettled)
      ) {
        const computeStart = frameBudget === undefined ? 0 : budgetNow();
        computeStageMs = 0;
        beginSpan(SPANS.compute);
        try {
          // The render camera comes with it, because a render-cadence consumer that culls by the
          // view — a streamed world's main batches — has to be driven from here and not from a draw
          // three skips for a mesh that is hidden because it has nothing to draw.
          game.computeDriven.processRender(
            game.renderer,
            camera,
            startupCoverActive() && !startupReadiness.ready,
            gameLoop,
          );
        } finally {
          endSpan(SPANS.compute);
        }
        computeStageMs = frameBudget === undefined ? 0 : budgetNow() - computeStart;
        frameBudget?.addRender(computeStageMs);
      }
      const waitingForFirstUse =
        firstWorldPass &&
        (explicitWarmUpPending || (startupCoverActive() && !startupReadiness.compileSettled));
      let worldPasses: ReturnType<RenderPassBudget["passes"]> | undefined;
      // Before the scene has entered, the world pass runs only under an opaque cover. With nothing
      // over it, the draw presents the clear colour: Hop Garden showed three black frames during
      // `load()` for 0.5 s when the page mounted the canvas. Under the cover it is what compiles the
      // world's pipelines inside the load: skipped, Hop's 10 s first-use compile landed after a
      // playtest's setup had released enter(), and setup.place runs failed.
      if (
        (game.sceneEntered || canvasLayer.opaque) &&
        !mustPresentLoader &&
        !waitingForFirstUse &&
        (!canvasLayer.opaque ||
          (!startupReadiness.ready && canvasLayer.renderWorldDuringStartup) ||
          canvasLayer.keepWorldRendering)
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
        // Camera-rate metadata is an input to scene-owned beforeRender work and the projection
        // palette write, not a post-draw observation. Publish it before either can skip a rig;
        // this pass observes animation only and does not decide draw visibility.
        const drawingBufferHeight = renderer.surface().drawingBufferHeight;
        const cullPrepareStart = spans === undefined ? 0 : spanNow();
        game.cameraCull?.prepareAnimation(
          game.projection?.root ?? threeScene,
          camera,
          drawingBufferHeight,
        );
        if (spans !== undefined) addSpan(SPANS.cull, spanNow() - cullPrepareStart);
        // Scene prep that must read the frame's last solved state before the projection packs and
        // the renderer draws. Inside the world-render block it cannot land on a held loader frame.
        if (game.beforeRenderCallbacks.size > 0) {
          let snapshot = game.beforeRenderSnapshots[game.beforeRenderDepth];
          if (snapshot === undefined) {
            snapshot = [];
            game.beforeRenderSnapshots[game.beforeRenderDepth] = snapshot;
          }
          game.beforeRenderDepth += 1;
          snapshot.length = 0;
          for (const callback of game.beforeRenderCallbacks) snapshot.push(callback);
          beginSpan(SPANS.beforeRender);
          try {
            for (const callback of snapshot) {
              if (debug)
                measureDebug(
                  `beforeRender.${callback.name || "anonymous"}`,
                  "update",
                  callback.name || "ctx.beforeRender",
                  callback,
                );
              else callback();
            }
          } finally {
            endSpan(SPANS.beforeRender);
            game.beforeRenderDepth -= 1;
          }
        }
        // A game is free to tick its rigs here instead of in the update stage (the skinned crowd does,
        // to time its own spans); whatever it queued is advanced before the draw, not a frame after it.
        flushAnimationTicks();
        interpolation.render(gameLoop.clockFrozen || game.paused ? 1 : alpha, () => {
          // Let a depth-coupled scene update its output node while the scene pass is still the
          // next render. Ordinary scenes keep the historical hook order and timing.
          const depthCoupledOutput = game.hasDepthCoupledOutput;
          if (depthCoupledOutput && game.sceneEntered) game.scene?.render(ctx);
          // A depth-coupled scene may have ticked a rig while the scene pass was still the next
          // render; it is drawn this frame, not the next.
          if (depthCoupledOutput) flushAnimationTicks();
          // The engine's own walk owns the frame's world matrices, so the count starts here and
          // covers both applications below: the authored scene the projection reconciles from and
          // the root the renderer is actually handed.
          game.matrixWorld?.beginFrame();
          if (game.projection !== undefined) {
            beginSpan(SPANS.reconcile);
            try {
              game.projection.reconcile();
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
              game.projection?.root ?? threeScene,
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
              game.projection?.root ?? threeScene,
              camera,
              renderer.surface().drawingBufferHeight,
            );
          } finally {
            endSpan(SPANS.lod);
          }
          const renderRoot = game.projection?.root ?? threeScene;
          // The cull reads the matrices the renderer will draw. Projection exact proxies carry the
          // authored world matrix in their local matrix, so their own world walk must precede both
          // the cull and the render rather than following the cull.
          renderRoot.matrixWorldAutoUpdate = false;
          game.matrixWorld?.apply(renderRoot);
          // Projected-size cull, per render camera, default on. It writes only `object.visible` —
          // the one per-frame flag the projection's batch key ignores — and restores what it hid
          // immediately after the draw, so the authored scene is untouched between frames. The
          // renderer walks the same root the projection is about to draw, so a declined projection
          // and an active one both get the gate.
          const cullApplyStart = spans === undefined ? 0 : spanNow();
          game.cameraCull?.apply(game.projection?.root ?? threeScene, camera, drawingBufferHeight);
          // Added, not bracketed: the render call sits between the apply and the restore, and a
          // span that contained it would report the world pass as cull work.
          if (spans !== undefined) addSpan(SPANS.cull, spanNow() - cullApplyStart);
          // The previous frame's capture, when the host drew that frame after its callback.
          geometryCapture.settleDeferred();
          const capturing = geometryCapture.armed();
          if (capturing) {
            // The mirror is what the renderer sees; arming the authored scene would attribute the
            // frame to objects that were never submitted.
            geometryCapture.beginFrame({
              camera,
              generation: game.sceneGeneration,
              root: game.projection?.root ?? threeScene,
              tick: gameLoop.tick(),
              viewportHeight: renderer.surface().drawingBufferHeight,
              viewportWidth: renderer.surface().drawingBufferWidth,
              ...(renderPassBudget === undefined
                ? {}
                : { activePassKind: () => renderPassBudget.activeKind() }),
              ...(game.projection === undefined
                ? {}
                : { ownership: game.projection.describeOwnership() }),
              ...(rendererBackendIdentity(renderer.raw) === undefined
                ? {}
                : { backend: rendererBackendIdentity(renderer.raw) as string }),
            });
          }
          // Scene.enter installs the chain after the scaler is created; choose its tier before its first draw.
          if (!temporalStartApplied && scaler !== undefined && renderer.temporalUpscale?.()) {
            scaler = createScaler();
            temporalStartApplied = true;
            if (scaler !== undefined) renderer.setResolutionScale(scaler.scale, scaler.scaleSource);
          }
          const engineStart = readStages === undefined ? 0 : budgetNow();
          renderer.render(renderRoot, camera);
          const engineEnd = readStages === undefined ? 0 : budgetNow();
          startup.renders += 1;
          // Count declined frames without treating them as drawn-frame render cost.
          const gateSkips = rendererFrameGateSkips(renderer.raw);
          if (gateSkips !== undefined) {
            if (gateSkips > lastGateSkips) frameBudget?.addRenderSkip();
            lastGateSkips = gateSkips;
          }
          // *After* the render, because that is where the draw happened. The matrices read here are
          // the ones drawn: the walk above refreshed them and `render()` did not touch them. The
          // frozen roots are passed because the draw root is the projection's mirror when the
          // engine is collapsing, and validating only that reassured about a scene it never
          // looked at. `?.` short-circuits before the spread, so `staticRoots()` is not called
          // at all on a frame without the flag — verified, a million optional calls evaluate the
          // argument zero times — and this stays a single undefined check in a shipped game.
          renderListValidator?.frame(renderRoot, ...staticRoots());
          const cullRestoreStart = spans === undefined ? 0 : spanNow();
          game.cameraCull?.restore();
          if (spans !== undefined) addSpan(SPANS.cull, spanNow() - cullRestoreStart);
          game.projection?.commit();
          renderer.observeRenderChainFrame?.();
          if (frameBudget !== undefined) {
            const renderEnd = budgetNow();
            frameBudget.addRender(renderEnd - renderStart);
            const stages = readStages?.(
              computeStageMs + (engineStart - renderStart),
              engineEnd - engineStart,
              renderEnd - engineEnd,
            );
            if (stages !== undefined) frameBudget.addStages(stages);
          }
          computeStageMs = 0;
          // Read the split before the overlay renders: the overlay is its own draw, not part of the
          // world pass, and the budget window already accounts for it in its own phase.
          worldPasses = renderPassBudget?.passes();
          if (worldPasses !== undefined && worldPasses.length > 0)
            frameBudget?.addRenderPasses(worldPasses);
          // After the passes are read, so the rows reconcile against this frame's own totals.
          if (capturing)
            geometryCapture.finishFrame(worldPasses ?? [], {
              drawsAfterFrame:
                (renderer.raw as { drawsAfterFrame?: unknown } | undefined)?.drawsAfterFrame ===
                true,
            });
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
          if (!depthCoupledOutput && game.sceneEntered) game.scene?.render(ctx);
          if (game.sceneEntered) {
            if (!startup.worldRendered) gameLoop.clearRuntimeDiagnostics();
            startup.worldRendered = true;
          }
          if (game.renderMetricsEnabled) {
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
        });
      }
      if (mustPresentLoader) loadingFramePresented = true;
      // Include state written by beforeRender and Scene.render in this frame's UI snapshot.
      if (game.config.stateFlushMs === undefined && startup.stateHandOffFrames === 0)
        game.state.flush();
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
      const crossings = bridgeCrossings();
      if (debug) {
        const matrix = game.matrixWorld?.report;
        if (matrix !== undefined)
          countDebug("matrixWorldVisits", matrix.visited, "scene", "MatrixWorldPass");
        const cull = game.cameraCull?.report;
        if (cull !== undefined) {
          countDebug("cullConsidered", cull.considered, "renderer", "RenderCameraCull");
          countDebug("cullRejected", cull.culled, "renderer", "RenderCameraCull");
        }
        const batch = autoBatch.census;
        countDebug("autoBatchSources", batch.meshes, "renderer", "AutoBatch.census");
        countDebug("autoBatchDraws", batch.draws, "renderer", "AutoBatch.census");
        countDebug("autoBatchRefused", batch.refused, "renderer", "AutoBatch.census");
        countDebug("autoBatchUnsettled", batch.unsettled, "renderer", "AutoBatch.census");
      }
      const boundary = frameCounters?.read();
      const engine = engineCounters();
      // The owned engine's work counts; a JS back end with its own queue counters (`boundary`) outranks them.
      const work = readWork?.(crossings);
      frameBudget?.addCounters({
        ...(work ?? {}),
        ...(boundary ?? {}),
        ...(crossings === undefined ? {} : { bridgeCrossings: crossings }),
        ...(engine === undefined ? {} : { engine }),
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
        if (!game.renderMetricsEnabled) return undefined;
        const overlayMetrics = rendererPerformanceMetrics(renderer.raw);
        return combineRenderPerformanceMetrics(renderer.kind, worldMetrics, overlayMetrics);
      }
      return game.renderMetricsEnabled ? worldMetrics : undefined;
    },
    onAfterPhysics: (dt) => {
      if (game.paused) return;
      if (debug)
        measureDebug("afterPhysics", "update", "afterPhysicsPhase.run", () =>
          afterPhysicsPhase.run(dt),
        );
      else afterPhysicsPhase.run(dt);
    },
    onUpdate: (dt) => {
      if (game.paused) return;
      if (debug) {
        measureDebug("input", "update", "Input.tick", () => game.input?.tick());
        measureDebug("scheduler", "update", "Scheduler.tick", () => scheduler.tick(dt));
        measureDebug("picking", "update", "PointerEvents3D.tick", () =>
          pointerEvents.tick(input.raw.pointers, picker, input.raw.pointer, input.raw.pointerEdges),
        );
      } else {
        game.input?.tick();
        scheduler.tick(dt);
        pointerEvents.tick(input.raw.pointers, picker, input.raw.pointer, input.raw.pointerEdges);
      }
      for (const plugin of game.activePlugins) {
        if (debug && plugin.beforeUpdate !== undefined)
          measureDebug(
            `beforeUpdate.${game.activePlugins.indexOf(plugin)}.${plugin.beforeUpdate.name || "anonymous"}`,
            "update",
            `plugins[${game.activePlugins.indexOf(plugin)}].${plugin.beforeUpdate.name || "beforeUpdate"}`,
            () => plugin.beforeUpdate?.(ctx, dt),
          );
        else plugin.beforeUpdate?.(ctx, dt);
      }
      const scene = game.scene;
      const frame = game.sceneFrame;
      if (game.sceneEntered && frame !== undefined) {
        if (debug)
          measureDebug(
            "sceneCallbacks",
            "update",
            `${scene?.constructor.name}.${frame.name || "frame"}`,
            () => frame(ctx, dt),
          );
        else frame(ctx, dt);
        startup.updates += 1;
      }
      // An async goto() installs the incoming scene before its load resolves; until enter()
      // has run there is no gameplay to step and a game-overridden update() would run against
      // a cleared graph.
      else if (game.sceneEntered && scene !== undefined) {
        if (debug)
          measureDebug("sceneCallbacks", "update", `${scene.constructor.name}.update`, () =>
            scene.update(ctx, dt),
          );
        else scene.update(ctx, dt);
        startup.updates += 1;
      }
      // A scene swap mid-update leaves rigs queued; they are advanced with the frame they belong to,
      // before this early return can skip the flush and let the next frame's ticks pile on top of them.
      flushAnimationTicks();
      if (game.scene !== scene || game.sceneFrame !== frame) return;
      for (const plugin of game.activePlugins) {
        if (debug && plugin.update !== undefined)
          measureDebug(
            `plugins.${game.activePlugins.indexOf(plugin)}.${plugin.update.name || "anonymous"}`,
            "update",
            `plugins[${game.activePlugins.indexOf(plugin)}].${plugin.update.name || "update"}`,
            () => plugin.update?.(ctx, dt),
          );
        else plugin.update?.(ctx, dt);
      }
      if (debug) measureDebug("entities", "update", "Registry.sweep", () => game.entities?.sweep());
      else game.entities?.sweep();
      // PRD-828: every rig the frame's update queued is advanced in one crossing, at the end of the
      // update stage — after the game's own per-rig loops and before anything reads a pose.
      if (debug)
        measureDebug("animationTickBatch", "update", "flushAnimationTicks", () =>
          flushAnimationTicks(),
        );
      else flushAnimationTicks();
      if (game.renderer !== undefined && game.sceneEntered) {
        if (debug)
          measureDebug(
            "computeDriven",
            "update",
            "ComputeDriven.process",
            () => game.renderer && game.computeDriven.process(game.renderer),
          );
        else game.computeDriven.process(game.renderer);
      }
    },
    // A frame the renderer declined to draw (the Wasm engine's gate: two frames still on the GPU)
    // is no frame at all for the readiness window. Counted, five cheap declined frames closed the
    // window while the first world frame was still compiling on the GPU, so the cover lifted and
    // the player saw a 0.9 s stall and then a first frame with unmetered exposure (Hop Garden, 4
    // of 13 launches). Not a reset either: a GPU-bound world under the cover declines every other
    // frame, and a reset held every Hop launch to the 10 s window bound.
    onFrame: (frameMs) => {
      const skips = rendererFrameGateSkips(renderer.raw);
      const declined = skips !== undefined && skips > readinessGateSkips;
      if (skips !== undefined) readinessGateSkips = skips;
      if (!declined) startupReadiness.observe(frameMs);
      // Bounded like every other startup wait: a renderer that retires no frame (hosted CI's
      // SwiftShader declined 73 of 73 after readiness) would otherwise keep the HUD covered for
      // the whole session. Past the window the cover lifts anyway, and says why.
      const handOffWaitedMs = now() - (timeline.readyMs ?? now());
      const handOffBounded = handOffWaitedMs >= STARTUP_STABLE_WINDOW_MS;
      // A draw the gate accepted is only queued: the cover lifts once the GPU has finished the first world frame.
      const worldOnDisplay = rendererWorldPresented(renderer.raw) !== false;
      if (startup.stateHandOffFrames > 0 && ((!declined && worldOnDisplay) || handOffBounded)) {
        if (handOffBounded) {
          console.warn(
            `TN_STARTUP_HANDOFF_BOUNDED:${JSON.stringify({
              retiredFrames: STARTUP_HANDOFF_FRAMES - startup.stateHandOffFrames,
              requiredFrames: STARTUP_HANDOFF_FRAMES,
              waitedMs: Math.round(handOffWaitedMs),
              reason:
                "the GPU retired fewer frames than the hand-off needs; the cover lifted at the bound",
            })}`,
          );
          startup.stateHandOffFrames = 0;
        } else startup.stateHandOffFrames -= 1;
        // The frame the held state publishes again is the frame the cover is gone.
        if (startup.stateHandOffFrames === 0) {
          game.uiRevealed = true;
          if (game.uiBridge?.hasPeer()) game.postUiStartup();
        }
      }
    },
    step: game.config.step,
  });
  loopState.current = gameLoop;

  return {
    dispose: () => gameLoop.stop(),
    geometryCapture,
    loop: gameLoop,
  };
}
