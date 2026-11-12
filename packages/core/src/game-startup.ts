import { type Object3D, Scene as ThreeScene, Vector2 } from "three";
import { createAssetLoader } from "./assets.js";
import { AutoBatch } from "./auto-batch.js";
import { CanvasLayer } from "./canvas-layer.js";
import { isComputeDriven } from "./compute-driven.js";
import { Registry } from "./entities.js";
import {
  type IBootPhase,
  type ILoopPhase,
  clearScene,
  runAll,
  throwFirst,
} from "./game-boot-phase.js";
import { type DevToolsHost, installDevTools } from "./game-dev-tools.js";
import type { IGameFrameLoop } from "./game-frame-loop.js";
import { createCamera } from "./game-validate.js";
import type {
  IGameObservationContribution,
  IGamePluginHooks,
  IGamePluginRuntime,
  IGameRuntimeObservations,
  PluginCleanup,
} from "./game.js";
import { InputMap } from "./input.js";
import { PhysicsInterpolation } from "./interpolation.js";
import {
  reportLaunchFailure,
  reportSceneLoadFailure,
  watchDeviceLoss,
  watchStartupStall,
} from "./launch-diagnostics.js";
import { type FixedStepLoop, createAfterPhysicsPhase } from "./loop.js";
import { MatrixWorldPass } from "./matrix-world.js";
import { ScenePicker } from "./picking.js";
import { getPlatform, hostDocument, hostWindow } from "./platform.js";
import { PointerEvents3D } from "./pointer-events.js";
import { debugRequested } from "./profiling/debug-telemetry.js";
import {
  UNLIT_FOLIAGE_FIX,
  formatUnlitFoliageWarning,
  unlitFoliageWarning,
} from "./profiling/unlit-foliage-warning.js";
import { createRandom } from "./random.js";
import { RenderCameraCull } from "./render-camera-cull.js";
import type { VirtualShadowNode } from "./render/virtual-shadow.js";
import { SceneRenderProjection } from "./renderProjection.js";
import {
  resolveMatrixWorldMode,
  resolveRendererAlphaAntialiasing,
  resolveRendererAntialias,
  resolveRendererScaleSetting,
} from "./renderer-config.js";
import { rendererFacts } from "./renderer-facts.js";
import { createRenderer } from "./renderer.js";
import type { ICtx, IStartupStatus, IStartupTimeline } from "./scene.js";
import { Scheduler } from "./schedule.js";
import {
  type IStartupOffscreenBytes,
  STARTUP_OFFSCREEN_BYTES_MARKER,
  measureStartupOffscreenBytes,
  reportUnusedModelsLater,
} from "./startup-offscreen-bytes.js";
import {
  type IStartupImageState,
  STARTUP_COMPILE_BUDGET_MS,
  STARTUP_STALL_MS,
  type StartupCompile,
  StartupReadiness,
} from "./startup-readiness.js";
import { Viewport } from "./viewport.js";
import {
  type IWarmUpOptions,
  type IWarmUpReport,
  prepareSceneEnvironment,
  sceneNeedsEnvironmentPreparation,
  warmUpScene,
  warmUpSceneWithCompletion,
} from "./warmup.js";

/** The global a native host reads to know the world is on screen; one spelling on both sides. */
const STARTUP_READY_GLOBAL = "__TN_STARTUP_READY__";

/**
 * Drawn frames the state publish waits after startup readiness. Three, because a renderer keeps at
 * most two frames on the GPU (the Wasm engine's gate declines a third), so the third drawn frame
 * proves the first uncovered one has left it and the page can paint a state change over it.
 */
export const STARTUP_HANDOFF_FRAMES = 3;

/** The GPU-selected main-pass count a streamed world publishes, read once per budget window. */
type GpuTally = () => { readonly instances: number; readonly triangles: number } | undefined;

export type IGameStartup<TState extends Record<string, unknown>, TPhysics> = NonNullable<
  Awaited<ReturnType<typeof startGameWorld<TState, TPhysics>>>
>;

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

/** The first phase of `#boot`: everything up to the entered start scene. */

export async function startGameWorld<TState extends Record<string, unknown>, TPhysics>(
  game: IBootPhase<TState, TPhysics>,
) {
  const progress = {
    explicitWarmUpSettled: !game.warmUpConfiguredExplicitly(),
    gpuTallyProvider: undefined as GpuTally | undefined,
    offscreenBytes: undefined as IStartupOffscreenBytes | undefined,
    projectionSettled: false,
    renders: 0,
    stateHandOffFrames: 0,
    updates: 0,
    warmUpStatus: undefined as IStartupStatus["warmup"] | undefined,
    worldRendered: false,
  };
  const debug = debugRequested();
  const bootSceneName = game.resumeScene ?? game.config.start;
  game.resumeScene = undefined;
  const SceneType = game.config.scenes[bootSceneName];
  if (SceneType === undefined) throw new Error(`Unknown start scene '${bootSceneName}'.`);
  game.connectUi();

  const renderer = await createRenderer({
    ...game.config.renderer,
    canvas: game.config.canvas ?? game.config.renderer?.canvas,
    preferWebGPU: game.config.renderer?.preferWebGPU,
    // One rule on both runtimes, decided 2026-09-01 after a HiDPI desktop browser upscaled a
    // DPR-1 web buffer into visible pixelation: the device's real density, with an explicit
    // `renderer.pixelRatio` winning over it (the old branch silently clobbered that value).
    // Headless capture lanes run at DPR 1 and are unaffected; the resolution scaler composes
    // on top, so a density the GPU cannot afford is trimmed by rungs, not by the developer.
    pixelRatio: game.config.renderer?.pixelRatio ?? globalThis.devicePixelRatio ?? 1,
    antialias: resolveRendererAntialias(game.config.renderer, undefined, getPlatform().os),
    alphaAntialiasing: resolveRendererAlphaAntialiasing(
      game.config.renderer,
      undefined,
      getPlatform().os,
    ),
    ...resolveRendererScaleSetting(game.config.renderer, undefined, getPlatform().os),
    source: game.config.renderer?.source ?? game.platform?.renderer,
  });
  if (game.aborted) {
    renderer.dispose();
    return;
  }
  game.renderer = renderer;
  // Pushed first, so it runs last: nothing acquired after the renderer outlives it, and the
  // presentation hold below lifts just before the renderer goes.
  game.cleanup.push(() => {
    renderer.dispose();
    const mounted = game.platform;
    if (mounted === undefined) renderer.domElement.remove?.();
    else mounted.unmountCanvas(renderer.domElement);
    game.renderer = undefined;
  });
  // Before anything draws for this startup, including the warm-up and every covered world frame: the owned
  // engine keeps drawing, but presents nothing until a frame's shadow and exposure inputs are ready, so the
  // player never sees the two unsettled pictures a cold post chain produced (measured 185 -> 124 -> 108 mean
  // brightness). A renderer without the seam presents every frame exactly as before.
  renderer.setPresentationHeld?.(true);
  game.cleanup.push(() => renderer.setPresentationHeld?.(false));
  const canvas = renderer.domElement;
  const platform = game.platform;
  const page = hostDocument();
  if (platform !== undefined) platform.mountCanvas(canvas, game.config.container);
  else if (game.config.container !== undefined && canvas.parentElement !== game.config.container)
    game.config.container.append(canvas);
  else if (canvas.parentElement === null && page !== undefined) page.body.append(canvas);

  const inputTarget =
    game.config.inputTarget ??
    (platform === undefined ? (hostWindow() ?? canvas) : (platform.inputTarget ?? canvas));
  // The store starts before the input and so stops after it: `stop()` releases the input, then the store.
  game.state.start();
  game.cleanup.push(() => game.state.stop());
  const input = new InputMap(
    game.config.input,
    inputTarget,
    canvas,
    platform?.input,
    game.config.contextMenu,
    { gamepadDeadZone: game.config.gamepadDeadZone },
  );
  game.input = input;
  game.cleanup.push(() => {
    input.dispose();
    game.input = undefined;
  });
  const threeScene = new ThreeScene();
  // Pushed before the objects built on this scene, so it runs after they are released.
  game.cleanup.push(() => clearScene(threeScene, game.computeDriven));
  if (debug && "__debugTelemetry" in threeScene)
    (threeScene as ThreeScene & { __debugTelemetry: boolean }).__debugTelemetry = true;
  const camera = createCamera(game.config.camera);
  const interpolation = new PhysicsInterpolation(game.config.physicsInterpolation);
  game.interpolation = interpolation;
  game.cleanup.push(() => {
    interpolation.clear();
    game.interpolation = undefined;
  });
  interpolation.track(camera);
  const viewport = new Viewport({ camera, renderer: game.renderer, source: platform?.viewport });
  game.viewport = viewport;
  game.cleanup.push(() => {
    viewport.dispose();
    game.viewport = undefined;
  });
  const canvasLayer = new CanvasLayer(viewport);
  game.cleanup.push(() => canvasLayer.dispose());
  // The renderer goes to the asset loader so compiled KTX2 textures detect transcoding
  // support against the real backend; a target that supports none fails right here.
  const assets = createAssetLoader({ ...game.config.assets, renderer: renderer.raw });
  if (assets.compressedTextures !== undefined) await assets.compressedTextures.ready;
  game.cleanup.push(() => assets.dispose());
  const entities = new Registry();
  const random = createRandom(game.config.seed);
  const scheduler = new Scheduler();
  const afterPhysicsPhase = createAfterPhysicsPhase();
  const picker = new ScenePicker({
    camera,
    // Input reports window-relative client coordinates; the picker's NDC math is
    // canvas-relative. Subtract the canvas page offset like replay.ts does for recorded
    // pointers, or every pick lands displaced by wherever the canvas sits in the layout.
    pointer: () => {
      const position = input.raw.pointer.position;
      const rect = (canvas as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
      return rect === undefined
        ? position
        : new Vector2(position.x - rect.left, position.y - rect.top);
    },
    scene: threeScene,
    viewport,
  });
  game.picker = picker;
  game.cleanup.push(() => {
    picker.dispose();
    game.picker = undefined;
  });
  const pointerEvents = new PointerEvents3D({
    screen: (position, target) => {
      const rect = (canvas as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect?.();
      return rect === undefined
        ? target.copy(position)
        : target.set(position.x - rect.left, position.y - rect.top);
    },
  });
  game.pointerEvents = pointerEvents;
  game.cleanup.push(() => {
    pointerEvents.dispose();
    game.pointerEvents = undefined;
  });
  const loopState: { current?: FixedStepLoop } = {};
  // The engine owns the world-matrix walk, not three's renderer: on by default it does not recurse
  // into a hidden subtree, and `renderer.matrixWorld: "all"` restores the every-node walk. The
  // authored scene is marked once, here, so three never walks it a second time; the mirror scene
  // is marked at the render site, where whichever root is drawn this frame is known.
  const matrixWorldPass = new MatrixWorldPass({
    mode: resolveMatrixWorldMode(game.config.renderer),
  });
  game.matrixWorld = matrixWorldPass;
  game.cleanup.push(() => {
    matrixWorldPass.dispose();
    game.matrixWorld = undefined;
  });
  threeScene.matrixWorldAutoUpdate = false;
  // Built before the context because `ctx.startup` reads it: a game asks what the framework's
  // startup is doing, and the answer is this pass.
  // The owned renderer retains its own velocity history; JS snapshots serve Three's accessors.
  const { ownedEngine } = rendererFacts(renderer);
  const projection = new SceneRenderProjection(threeScene, {
    // The game's `renderer.projection` value verbatim: `false` declines the mirror, an object
    // names the material check beside accepting it, and the projection owns both readings.
    projection: game.config.renderer?.projection,
    velocity: () => !ownedEngine && (renderer.renderChainUsesPerObjectVelocity?.() ?? false),
    matrixWorld: matrixWorldPass,
  });
  game.projection = projection;
  const autoBatchConfig = game.config.autoBatch;
  const autoBatch = new AutoBatch(threeScene, {
    enabled: autoBatchConfig !== false,
    entities,
    ...(typeof autoBatchConfig === "object" ? autoBatchConfig : {}),
    report: (line) =>
      (game.config.frameBudget === false ? undefined : game.config.frameBudget?.report)?.(line) ??
      console.info(line),
  });
  game.autoBatch = autoBatch;
  // Runs before the scene is cleared (pushed after it), so the batches give their sources back first.
  game.cleanup.push(() => autoBatch.reset());
  // Do not submit what the render camera cannot resolve. On by default at a conservative 0.5 px,
  // and measured whether or not the game narrows or declines it. Its decision is per camera, so
  // a shadow caster and anything attached to the camera are never dropped on the main view alone.
  const cameraCull = new RenderCameraCull({
    minimumPixels: game.config.renderer?.minimumProjectedPixels,
  });
  game.cameraCull = cameraCull;
  game.cleanup.push(() => {
    cameraCull.dispose();
    game.cameraCull = undefined;
  });
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
    if (progress.projectionSettled) return 1;
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
  let markProjectionSettled: () => void = () => undefined;
  let rejectProjection: (error: unknown) => void = () => undefined;
  const projectionReady = new Promise<void>((resolve, reject) => {
    markProjectionSettled = resolve;
    rejectProjection = reject;
  });
  void projectionReady.catch(() => undefined);
  const startupShadows = new Set<VirtualShadowNode>();
  const startupReadiness = new StartupReadiness({
    // An attached light with no shadow receiver never asks Three to update its maps.
    settled: () =>
      progress.worldRendered &&
      [...startupShadows].every((node) => node.stats.frame === 0 || node.settled),
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
     * The report budget is a third of the compile budget because this pass runs after the player
     * has already waited behind a curtain. If a compile has started when that budget expires,
     * the readiness gate still joins that original operation within its existing bounded window;
     * work that never started remains lazy.
     */
    afterHolds: async () => {
      await warmUp("TN_STARTUP_WARMUP_HELD", Math.round(STARTUP_COMPILE_BUDGET_MS / 3), false);
    },
    /**
     * The renderer's own answer, which no timer may stand in for: a world frame whose shadow inputs are
     * initialized and whose meter has measured within 3% of its target. On the owned engine the hidden world
     * keeps drawing behind the cover, so this becomes true on its own; a renderer without the seam answers
     * true, and its launch is exactly what it was. The answer names the input it is short of, so a launch that
     * reached its deadline (`STARTUP_IMAGE_TIMEOUT_MS`) reports which one never arrived.
     */
    imageReady: (): boolean | IStartupImageState => {
      // A cover the game asked not to draw the world behind has no frame to wait for, and waiting would
      // hold it open forever; every other game keeps drawing and reaches this on its own.
      if (
        canvasLayer.opaque &&
        !canvasLayer.renderWorldDuringStartup &&
        !canvasLayer.keepWorldRendering
      )
        return true;
      return renderer.firstWorldFrame?.() ?? true;
    },
  });
  game.cleanup.push(() => startupReadiness.cancel());
  // Startup readiness does not wait on `ui-ready`, and cannot. The intent proves the page's
  // script ran, not that a pixel reached the screen, so waiting on it never closed the race it
  // was added for — it only made the losing side lose later, after up to 45 s of held frames.
  // The race no longer exists: the native UI is now composited into the game's own frame, so the
  // cover and the world share one swapchain and there is no second surface left to arrive late.
  // The held loop starts before an explicit warm-up so the loading surface can animate. A native
  // frame may therefore arrive while that pass is still awaiting a compile promise; keep first-use
  // rendering and compute behind the same held boundary until the explicit pass has settled.
  // A web UI is the loading surface on native and on the web. Its bridge must be both attached
  // and announced ready: an attached but unrendered web view is not a cover the player can see.
  // Keep this predicate tied to an actually attached and rendered web UI. The render path still
  // lets a settled world render behind either kind of cover; only the unresolved first-use work
  // is held, so a persistent HUD cannot stop the world pass after loading.
  const startupCoverActive = (): boolean =>
    !startupReadiness.ready &&
    (canvasLayer.opaque || (game.uiReady && game.uiBridge?.hasPeer() === true));
  // A draw the warm-up makes in a timer task is presented by the browser on its own, without the
  // frame loop's overlay: a Wasm engine still baking the environment presents black, and the
  // cover flickers against it. Paint the cover again in the same task.
  const repaintCover = (): void => {
    if (canvasLayer.opaque && canvasLayer.scene.children.length > 0)
      renderer.renderOverlay(canvasLayer.scene, canvasLayer.camera);
  };
  const timeline: { -readonly [K in keyof IStartupTimeline]: IStartupTimeline[K] } = {};
  const now = (): number => globalThis.performance?.now() ?? Date.now();
  /**
   * A launch that stops making progress says so, on the page, instead of leaving a loading
   * screen up forever. Measured on `midway-open-pacific`: a 104 s launch and then a lost GPU
   * device, with the only account of either on a terminal the player does not have.
   */
  const stopStallWatch = watchStartupStall({
    pending: () => [
      ...assets.progress.pending,
      ...startupReadiness.pendingHolds,
      ...startupReadiness.pendingImage,
    ],
    progress: () => game.ctx?.startup.progress ?? 0,
    workProgress: () => assets.progress.settled + startupReadiness.workProgress,
    stallMs: STARTUP_STALL_MS,
  });
  game.cleanup.push(stopStallWatch);
  watchDeviceLoss(
    (
      renderer.raw as {
        backend?: { device?: { lost?: Promise<{ reason?: string; message?: string }> } };
      }
    ).backend?.device,
    () => game.aborted || game.renderer !== renderer,
  );
  // Stamped when the FRAMEWORK is done, which is before `whenReady()` whenever the game has
  // registered a `startup.hold()`. Two stamps, because one number cannot be both "what the
  // framework cost" and "what the player waited for", and collapsing them is how a valley that
  // took 8.8 s to appear reported 1.5 s.
  void startupReadiness.whenFrameworkReady().then(() => {
    if (game.aborted) return;
    timeline.compileSettledMs ??= now();
    timeline.frameworkReadyMs ??= now();
  });
  // What the gate was still waiting on: logged when it fails and when it reveals late.
  const settlementDetail = () => ({
    worldRendered: progress.worldRendered,
    shadows: [...startupShadows].map((node) => {
      try {
        const frame = node.stats.frame;
        const settled = node.settled;
        return {
          frame,
          settled,
          pending: frame !== 0 && !settled,
          pendingInvalidations: node.tracker.pending,
        };
      } catch {
        return { frame: null, settled: null, pending: null, pendingInvalidations: null };
      }
    }),
    pendingHolds: startupReadiness.pendingHolds,
    compileSettled: startupReadiness.compileSettled,
    frameworkReady: startupReadiness.frameworkReady,
    timeline: {
      loadStartedMs: timeline.loadStartedMs ?? null,
      enteredMs: timeline.enteredMs ?? null,
      compileSettledMs: timeline.compileSettledMs ?? null,
      frameworkReadyMs: timeline.frameworkReadyMs ?? null,
      readyMs: timeline.readyMs ?? null,
    },
  });
  void startupReadiness.whenReady().then(
    () => {
      if (game.aborted) return;
      stopStallWatch();
      // A bounded wait ran out and the world was revealed anyway; say what was still pending.
      if (startupReadiness.timedOut !== undefined)
        console.warn(
          `TN_STARTUP_LATE:${JSON.stringify({ timedOut: startupReadiness.timedOut, ...settlementDetail() })}`,
        );
      // A renderer without first-use compilation settles without running the compile closure
      // below, so the settle stamp is guaranteed here at the latest.
      timeline.compileSettledMs ??= now();
      timeline.frameworkReadyMs ??= now();
      timeline.readyMs ??= now();
      progress.projectionSettled = true;
      // The first world frame the player sees is the next one this renderer draws, so the hold comes off
      // here and only here: every exit before it (abort, dispose, a failed launch) leaves the cover up.
      renderer.setPresentationHeld?.(false);
      game.frameBudget?.markRevealed();
      for (const node of startupShadows) node.startupCovered = false;
      startupShadows.clear();
      // What a game does on `whenReady()` (lift its cover, show its HUD) reaches the page with the
      // world frame, not before it: see `STARTUP_HANDOFF_FRAMES`.
      progress.stateHandOffFrames = STARTUP_HANDOFF_FRAMES;
      markProjectionSettled();
      // The reveal is the first moment the network is free and the player is playing: fill the
      // rest of the release at idle priority from here, never before.
      void assets.startBackgroundFill();
      // A host capturing a frame has no other way to know the world is on screen. Counting frames
      // cannot express it: on a software rasteriser the gate resolves on its bounded window rather
      // than on five in-budget frames, so a fast 300-frame run finishes before the world is shown
      // and captures the loading state. The native screenshot path waits on this flag.
      (globalThis as Record<string, unknown>)[STARTUP_READY_GLOBAL] = true;
      // Measurement only: what the reveal waited for that the spawn camera does not show. A throw
      // here must cost the report, never the game that is already ready.
      try {
        progress.offscreenBytes = measureStartupOffscreenBytes(assets.resolved, threeScene, camera);
        if (progress.offscreenBytes.offscreenBytes > 0)
          (progress.offscreenBytes.warn ? console.warn : console.log)(
            `${STARTUP_OFFSCREEN_BYTES_MARKER}:${JSON.stringify(progress.offscreenBytes)}`,
          );
      } catch (error) {
        console.warn(
          `${STARTUP_OFFSCREEN_BYTES_MARKER}_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Once, a minute on: an awaited model no scene object came from (TN_ASSET_UNUSED).
      game.cleanup.push(
        reportUnusedModelsLater(
          new Map(assets.resolved),
          threeScene,
          () => game.aborted || game.renderer !== renderer,
        ),
      );
      // Again at ready: a world that streams its foliage in under `startup.hold` has none at entry.
      const unlit = unlitFoliageWarning(threeScene);
      if (unlit !== undefined)
        console.warn(`${formatUnlitFoliageWarning(unlit)} ${UNLIT_FOLIAGE_FIX}`);
    },
    (error: unknown) => {
      if (game.aborted) return;
      stopStallWatch();
      rejectProjection(error);
      reportLaunchFailure({ kind: "stalled", message: String(error) });
      console.info(
        `TN_STARTUP_SETTLEMENT:${JSON.stringify({ ...settlementDetail(), failedAtMs: now() })}`,
      );
    },
  );
  const warmUp = async (marker: string, budgetMs: number, stamp: boolean): Promise<void> => {
    if (game.aborted || game.renderer === undefined) return;
    let report: IWarmUpReport | undefined;
    let heldCompletion: Promise<void> | undefined;
    let failure: string | undefined;
    let heldFailure: unknown;
    let heldFailed = false;
    try {
      projection.reconcile();
      // The frame loop's own walk, run here too because the warm-up draws before that loop does.
      // Three is told not to walk the scene (`matrixWorldAutoUpdate = false`), and a declined
      // projection returns from `reconcile()` without walking it, so without this the warm render
      // compiles every pipeline against stale world matrices and the real frames then build the
      // rest synchronously -- tens of seconds each on a software adapter, which loses the device.
      game.matrixWorld?.apply(projection.root);
      const options = game.warmUpOptions();
      const result = await warmUpSceneWithCompletion(renderer, projection.root, camera, {
        afterCoveredDraw: repaintCover,
        budgetMs,
        computeNodes: game.computeDriven.warmupNodes,
        renderPasses: options.renderPasses,
        includeHidden: options.includeHidden,
        yieldFrame: options.yieldFrame,
      });
      report = result.report;
      if (!stamp) heldCompletion = result.completion;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (!stamp) {
        heldFailure = error;
        heldFailed = true;
      }
    }
    // With an explicit warm-up, this held pass is only the first half of startup. Stamp after
    // the explicit pass so its own pipelines remain inside the settled boundary; without one,
    // this is the only warm-up completion.
    if (stamp || !game.warmUpConfiguredExplicitly()) renderer.warmUpSettled?.();
    progress.warmUpStatus =
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
    if (heldFailed) throw heldFailure;
    if (heldCompletion !== undefined) await heldCompletion;
  };
  const startupCompile: StartupCompile = async (): Promise<void> => {
    await warmUp("TN_STARTUP_WARMUP", STARTUP_COMPILE_BUDGET_MS, true);
  };
  // A game with no cover skips the compile above, yet readiness still waits for the scene's
  // environment: the owned engine skips every frame while it bakes, and a skipped frame is fast,
  // so the frame window would pass before the world drew once. (An explicit warm-up bakes it.)
  const startupEnvironment = (): StartupCompile | undefined =>
    sceneNeedsEnvironmentPreparation(renderer, projection.root) ? bakeEnvironment : undefined;
  const bakeEnvironment: StartupCompile = async (): Promise<void> => {
    if (game.aborted) return;
    await prepareSceneEnvironment(
      renderer,
      projection.root,
      camera,
      now() + STARTUP_COMPILE_BUDGET_MS,
      repaintCover,
    );
  };
  // The GPU-selected main-pass tally, registered by whichever streamed world is added to the
  // scene. The frame budget reads it once per window; a world with no sample reports undefined, so
  // the window carries nothing rather than a zero no frame selected.
  const ctx: ICtx<TState, TPhysics> = {
    get frameTime() {
      return loopState.current?.frameTime ?? 0;
    },
    get alpha() {
      return loopState.current?.alpha ?? 0;
    },
    interpolate: (object) => interpolation.track(object),
    resetInterpolation: (object) => interpolation.reset(object),
    add: (object) => {
      // Narrowed through a plain `Object3D` rather than the type parameter: a type guard applied
      // to `T` yields `T & IComputeDriven`, which TypeScript will not carry to the registry's
      // `Object3D & IComputeDriven` without a cast. The local keeps the guard honest and the
      // return keeps the caller's own type, so a game never casts back what it just built.
      const node: Object3D = object;
      threeScene.add(node);
      if (typeof (node as { aerialPerspective?: unknown }).aerialPerspective === "function") {
        game.hasDepthCoupledOutput = true;
      }
      if (isComputeDriven(node)) {
        const activeRenderer = game.renderer;
        if (activeRenderer === undefined)
          throw new Error("Cannot add a compute-driven object before the game starts.");
        game.computeDriven.add(node, activeRenderer);
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
        progress.gpuTallyProvider = tallySource.gpuSceneTally.bind(node);
        if (game.config.frameBudget !== false) tallySource.enableGpuSceneTally?.();
      }
      return object;
    },
    assets,
    after: (delay, callback) => scheduler.after(delay, callback),
    afterPhysics: (callback) => afterPhysicsPhase.register(callback),
    beforeRender: (callback) => {
      if (typeof callback !== "function")
        throw new Error("beforeRender requires a callback function.");
      game.beforeRenderCallbacks.add(callback);
      return () => game.beforeRenderCallbacks.delete(callback);
    },
    camera,
    canvasLayer,
    entities,
    every: (callback) => scheduler.every(callback),
    get fps() {
      return loopState.current?.fps ?? 0;
    },
    goto: (name) => game.goto(name, ctx),
    input: game.input,
    pointer: pointerEvents,
    physics: undefined as TPhysics,
    random,
    raycast: (options) => picker.raycast(options),
    raycastAll: (options, target) => picker.raycastAll(options, target),
    startup: {
      get warmup() {
        return progress.warmUpStatus;
      },
      get phase() {
        // The projection is reconciled before the first world draw, but readiness is not reported
        // until first-use work and a sustained in-budget window have completed. An opaque loading
        // layer cannot turn `whenReady()` into a first-present signal while work is still waiting
        // behind it.
        if (progress.projectionSettled) return "ready" as const;
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
      hold: (label, work, budgetMs, progress) => {
        startupReadiness.hold(label, work, budgetMs, progress);
      },
      get timeline() {
        return { ...timeline };
      },
      whenReady: () => projectionReady,
      whenFrameworkReady: () => startupReadiness.whenFrameworkReady(),
    },
    renderer: game.renderer,
    viewport,
    scene: threeScene,
    state: game.state,
    tween: (target, properties, duration, options) =>
      scheduler.tween(target, properties, duration, options),
  };
  game.ctx = ctx;
  game.entities = entities;
  game.scheduler = scheduler;
  game.afterPhysicsPhase = afterPhysicsPhase;
  // The scene-owned registries. Pushed after the autobatcher, so they empty before it resets (the
  // order `#teardown` always had), and before the frame loop and plugins, so both release first.
  game.cleanup.push(() => {
    afterPhysicsPhase.clear();
    game.beforeRenderCallbacks.clear();
    scheduler.clear();
    entities.clear();
    game.afterPhysicsPhase = undefined;
    game.scheduler = undefined;
    game.entities = undefined;
  });
  const devToolsHost = platform === undefined ? hostWindow() : platform.devToolsHost;
  game.cleanup.push(
    installDevTools(entities, devToolsHost as DevToolsHost | undefined, () => game.geometryCapture),
  );
  game.scene = new SceneType();
  game.sceneName = bootSceneName;

  // The frame loop and scene entry see the narrower view; the compiler holds `IBootPhase` to it.
  const loopPhase: ILoopPhase<TState, TPhysics> = game;
  return Object.assign(progress, {
    afterPhysicsPhase,
    autoBatch,
    camera,
    canvasLayer,
    ctx,
    debug,
    game: loopPhase,
    input,
    interpolation,
    loopState,
    now,
    picker,
    pointerEvents,
    projection,
    random,
    renderer,
    repaintCover,
    scheduler,
    startupCompile,
    startupCoverActive,
    startupEnvironment,
    startupReadiness,
    startupShadows,
    threeScene,
    timeline,
  });
}

/** The last phase of `#boot`: the start scene's load and entry, the plugin gates, the release. */
export async function startScenes<TState extends Record<string, unknown>, TPhysics>(
  startup: IGameStartup<TState, TPhysics>,
  frameLoop: IGameFrameLoop,
): Promise<void> {
  const game = startup.game;
  const {
    camera,
    ctx,
    now,
    projection,
    random,
    renderer,
    repaintCover,
    startupReadiness,
    timeline,
  } = startup;
  const { geometryCapture, loop: gameLoop } = frameLoop;

  const startGates: Array<{
    readonly gate: Promise<void>;
    readonly rejectEntered: (error: unknown) => void;
    readonly resolveEntered: () => void;
  }> = [];
  let settleLoaded: (error?: unknown) => void = () => undefined;
  const startLoaded = new Promise<void>((resolve, reject) => {
    settleLoaded = (error) => (error === undefined ? resolve() : reject(error));
  });
  // A run with no setup never awaits it; a failed load is reported by start() itself.
  void startLoaded.catch(() => undefined);
  const runtime: IGamePluginRuntime = {
    startSceneLoaded: () => startLoaded,
    fixedStep: (ticks, options) =>
      gameLoop.advance(ticks, { ...options, until: () => game.pendingSceneEnter !== undefined }),
    sceneTransition: () =>
      game.pendingSceneEnter?.then(
        () => undefined,
        () => undefined,
      ),
    frameCounts: () => ({ updates: startup.updates, renders: startup.renders }),
    frameBudgetWindow: () => game.frameBudget?.window(),
    freezeClock: (settleSteps) => gameLoop.freezeClock(settleSteps),
    // Spend the settling pass once the world's scene is live: this boot runs through a loading scene, so
    // a runtime that settled on its first live frame would settle the loading scene (playtest settle).
    settleClock: (steps) => gameLoop.settleNow(steps),
    renderCurrent: () => gameLoop.renderCurrentFrame(),
    enableRuntimeDiagnostics: () => {
      game.renderMetricsEnabled = true;
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
    seed: game.config.seed ?? null,
    startupCompileSettled: () => startupReadiness.compileSettled,
    startupRevealed: () => game.uiRevealed,
    startupTimeline: () => ({ ...timeline }),
    startupOffscreenBytes: () => startup.offscreenBytes,
    step: gameLoop.step,
    runtimeDiagnosticsSeries: () => gameLoop.runtimeDiagnosticsSeries(),
  };
  Object.assign(runtime, {
    _setClockMode: (mode: "fixed-step" | "wall-clock") => gameLoop._setClockMode(mode),
  });
  // Release order, newest push first (see `drainCleanup`): the loop stops, the scene exits, then every active
  // plugin's `dispose`, then every plugin's setup cleanup, each group in the order its plugins were
  // set up. Both plugin groups are pushed before the first `setup` runs, so a boot that aborts or
  // throws inside the loop below still releases the plugins it had reached.
  const pluginCleanups: PluginCleanup[] = [];
  game.cleanup.push(() => throwFirst(runAll(pluginCleanups.splice(0))));
  const disposed = new Set<IGamePluginHooks<TState, TPhysics>>();
  game.cleanup.push(() => {
    const active = game.activePlugins;
    game.activePlugins = [];
    throwFirst(
      runAll(
        active.map((plugin) => () => {
          if (disposed.has(plugin)) return;
          disposed.add(plugin);
          plugin.dispose?.(ctx);
        }),
      ),
    );
  });
  game.cleanup.push(() => {
    try {
      if (game.sceneEntered) game.scene?.exit(ctx);
    } finally {
      game.sceneFrame = undefined;
      game.sceneEntered = false;
    }
  });
  // Pushed last of all, so the loop stops before anything it drives is released.
  game.cleanup.push(() => gameLoop.stop());
  // A boot that throws must end exactly like an aborted boot: every cleanup attempted, every
  // resource released — and the original error rethrown, not a teardown error standing in
  // for it. The abort branches below stay outside these guards: they tear down themselves.
  for (const plugin of game.config.plugins ?? []) {
    let cleanup: PluginCleanup | undefined;
    try {
      cleanup = typeof plugin === "function" ? plugin(ctx) : await plugin.setup?.(ctx, runtime);
    } catch (error) {
      game.teardown();
      throw error;
    }
    if (typeof plugin !== "function") game.activePlugins.push(plugin);
    if (cleanup !== undefined) pluginCleanups.push(cleanup);
    if (game.aborted) {
      game.teardown();
      return;
    }
  }
  const scene = game.scene;
  if (scene === undefined) {
    game.teardown();
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
    settleLoaded();
  } catch (error) {
    reportSceneLoadFailure(error);
    settleLoaded(error);
    // A runner's describe waits on these: answer it with the failure now, as every other start
    // failure below does, instead of leaving it to run out its whole handshake budget.
    for (const startGate of startGates) startGate.rejectEntered(error);
    game.teardown();
    throw error;
  }
  if (game.aborted) {
    game.teardown();
    return;
  }
  // Plugins that need to mutate scene-load placeholders hold here. Setup must land before
  // Scene.enter() transfers those values into authoritative physics/gameplay state.
  if (startGates.length > 0) {
    try {
      await Promise.all(startGates.map(({ gate }) => gate));
    } catch (error) {
      for (const startGate of startGates) startGate.rejectEntered(error);
      game.teardown();
      throw error;
    }
    if (game.aborted) {
      const error = new Error("Game start was aborted before the start scene entered.");
      for (const startGate of startGates) startGate.rejectEntered(error);
      game.teardown();
      return;
    }
  }
  try {
    // A boot scene can navigate during enter(). Describe the destination's registered entities
    // after it enters, while readiness and the full goto() still wait for first-use warm-up.
    game.onStartSceneEntered = () => {
      for (const startGate of startGates) startGate.resolveEntered();
    };
    game.enterScene(scene, ctx);
    timeline.enteredMs ??= now();
    void game.pendingSceneEnter?.catch((error: unknown) => {
      for (const startGate of startGates) startGate.rejectEntered(error);
    });
  } catch (error) {
    for (const startGate of startGates) startGate.rejectEntered(error);
    game.teardown();
    throw error;
  }
  if (game.aborted) {
    game.teardown();
    return;
  }
  // The scene is built and the loop is still held, which is the only window where compiling can
  // cost frames nobody is playing. Warming up here rather than letting the first real frame do
  // it is what keeps a launch from freezing inside one 24-second frame. PRD-218.
  if (game.warmUpConfiguredExplicitly() && game.renderer !== undefined) {
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
      game.matrixWorld?.apply(projection.root);
      const warmUpOptions: IWarmUpOptions = game.warmUpOptions();
      report = await warmUpScene(game.renderer, projection.root, camera, {
        afterCoveredDraw: repaintCover,
        ...warmUpOptions,
        computeNodes: [...(warmUpOptions.computeNodes ?? []), ...game.computeDriven.warmupNodes],
      });
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    game.renderer.warmUpSettled?.();
    startup.warmUpStatus =
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
    startup.explicitWarmUpSettled = true;
    if (game.aborted) {
      game.teardown();
      return;
    }
  }
  game.started = true;
  // Every gate has resolved and the scene has entered, so the simulation may move. The first
  // tick after this reads a single frame's dt, not one spanning the load.
  gameLoop.setHeld(false);
  gameLoop.start();
}
