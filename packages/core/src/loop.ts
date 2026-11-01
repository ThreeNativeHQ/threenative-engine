import type { FrameBudget, IFramePhaseSample } from "./frame-budget.js";
import type { PhysicsInterpolation } from "./interpolation.js";
import type { SpanRecorder } from "./profiling/Spans.js";
import type { FramePassKind, IRenderPassSample } from "./render-pass-budget.js";

export type AfterPhysicsCallback = (dt: number) => void;

export interface IAfterPhysicsContext {
  readonly afterPhysics: (callback: AfterPhysicsCallback) => () => void;
}

export interface IAfterPhysicsPhase {
  clear(): void;
  register(callback: AfterPhysicsCallback): () => void;
  run(dt: number): void;
}

export function createAfterPhysicsPhase(): IAfterPhysicsPhase {
  const callbacks = new Set<AfterPhysicsCallback>();
  // Snapshot storage reused across frames, with one array per nesting level so a dispatch
  // started from inside a running callback cannot clobber its parent's snapshot.
  const snapshots: AfterPhysicsCallback[][] = [];
  let depth = 0;
  return {
    clear: () => callbacks.clear(),
    register: (callback) => {
      if (typeof callback !== "function")
        throw new Error("afterPhysics requires a callback function.");
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    run: (dt) => {
      if (!Number.isFinite(dt) || dt <= 0)
        throw new Error(`afterPhysics requires a positive finite dt, received ${String(dt)}.`);
      if (callbacks.size === 0) return;
      let snapshot = snapshots[depth];
      if (snapshot === undefined) {
        snapshot = [];
        snapshots[depth] = snapshot;
      }
      depth += 1;
      snapshot.length = 0;
      // Snapshot before running: a callback that registers or removes work affects the next
      // dispatch, not this one, and one already snapshotted still runs after a later removal.
      for (const callback of callbacks) snapshot.push(callback);
      try {
        for (let index = 0; index < snapshot.length; index += 1) snapshot[index]?.(dt);
      } finally {
        depth -= 1;
      }
    },
  };
}

/** Register work that reads transforms after every simulation step and before the frame renders. */
export function afterPhysics(
  context: IAfterPhysicsContext,
  callback: AfterPhysicsCallback,
): () => void {
  if (typeof context?.afterPhysics !== "function")
    throw new Error("afterPhysics requires a game context.");
  return context.afterPhysics(callback);
}

export interface IFixedStepLoopOptions {
  readonly interpolation?: PhysicsInterpolation;
  readonly step?: number;
  readonly maxSteps?: number;
  /**
   * The most wall time one frame adds to the simulation, in seconds. Default 1/20, after Unreal's
   * `MaxPhysicsDeltaTime` (1/30 in UE 5.8.3: Engine/Source/Runtime/Engine/Private/PhysicsEngine/PhysicsSettings.cpp:22,
   * applied per frame in PhysLevel.cpp:212). A slower frame slows the simulation instead of running
   * extra whole updates to catch up. `Infinity` turns the clamp off; `maxSteps` still bounds a frame.
   */
  readonly maxPhysicsDeltaTime?: number;
  /** Collect per-frame render samples for diagnostics consumers. Default false. */
  readonly collectMetrics?: boolean;
  /** Runs once per presented frame, before any fixed-step simulation dispatches. */
  readonly onBeginFrame?: () => void;
  readonly onUpdate: (dt: number) => void;
  /** Runs after `onUpdate` has completed and before `onRender` starts. */
  readonly onAfterPhysics?: (dt: number) => void;
  readonly onRender?: (alpha: number) => undefined | IRenderPerformanceMetrics;
  /** Actual wall time spent in one simulation+render callback, for startup gates and diagnostics. */
  readonly onFrame?: (frameMs: number) => void;
  readonly requestFrame?: (callback: (time: number) => void) => number;
  readonly cancelFrame?: (handle: number) => void;
  /**
   * Per-frame cost attribution. The loop is the only place that knows where the simulation phase
   * ends and the render phase begins, so it is the only honest place to measure them; a game
   * wrapping `requestAnimationFrame` from outside has to guess that boundary.
   */
  readonly budget?: FrameBudget;
  /**
   * The render-phase span tree, when `TN_FRAME_SPANS` asked for one.
   *
   * The loop is where the frame budget's own phase split becomes a number, so it is the only place
   * that can close the span tree against the same render phase the meter charged. A tree closed
   * anywhere else would be arithmetic against a second, slightly different interval.
   */
  readonly spans?: SpanRecorder;
  /** Monotonic clock for phase boundaries. Defaults to `performance.now`. */
  readonly now?: () => number;
}

export interface IRenderPerformanceMetrics {
  readonly drawCalls?: number;
  readonly passes?: readonly IRenderPassSample[];
  readonly triangles?: number;
}

export interface IRenderPerformanceSample extends IRenderPerformanceMetrics {
  readonly frameMs: number;
  /** Successful render-callback completion ID; absolute across clears and retention. */
  readonly sequence?: number;
  /** Completion boundary from the monotonic phase clock, not the rAF timestamp or render-body cost. */
  readonly completedAtMs?: number;
  /** Where this frame's milliseconds went. Present whenever a frame budget is installed. */
  readonly phases?: IFramePhaseSample;
}

const MAX_RENDER_PERFORMANCE_SAMPLES = 1_024;

/**
 * One entry per pass kind, summed, for a retained sample.
 *
 * `RenderPassBudget` records one entry per `render()` call, which is what the frame budget and the
 * geometry capture need to attribute a submission to the innermost call. A retained sample does
 * not: it is a 1,024-frame window shipped to the playtest bridge under a 1 MB payload ceiling, and
 * a frame with 30 nested calls made that window ~1.4 MB, so `assert.performance` failed with
 * TN_PLAYTEST_PAYLOAD_TOO_LARGE before frame 0. Consumers read per-kind values, and taking the
 * first of N silently undercounted every lane past its first call.
 */
function aggregatePassesByKind(passes: readonly IRenderPassSample[]): IRenderPassSample[] {
  const totals = new Map<FramePassKind, IRenderPassSample>();
  for (const pass of passes) {
    const total = totals.get(pass.kind);
    totals.set(pass.kind, {
      draws: (total?.draws ?? 0) + pass.draws,
      kind: pass.kind,
      triangles: (total?.triangles ?? 0) + pass.triangles,
    });
  }
  return [...totals.values()];
}

/**
 * How many fixed steps a frozen clock runs once, before the run's first observation.
 *
 * This is the settling the boot used to do by accident, counted instead of measured. Live frames
 * during the startup compile wait advanced the simulation at whatever rate the machine managed —
 * 59 ticks before the first sample on a quiet one, thousands on a loaded one — and games leaned on
 * that: the platformer character captures its visual-attachment baseline on its first grounded
 * contact, so a run that started at tick 0 read `visualAttached: false` where a run that started at
 * tick 59 read `true`, from the same build. A fixed count is the same settling with the machine out
 * of it, and one second is what the quiet machine actually delivered. A run's own steps are
 * unaffected: this happens once, before the runner takes its first tick, and `#tick` counts it, so
 * the report says how old the simulation is.
 */
const FROZEN_SETTLE_STEPS = 60;

/**
 * The most simulated time one frame may add. Unreal clamps at 1/30 s (`MaxPhysicsDeltaTime`); 1/20 s keeps
 * real time for a 30 fps frame that lands at 34 ms (physics/__tests__/determinism.spec.ts holds 30 and
 * 144 fps to one result) and still bounds an overloaded 60 Hz frame at 3 ticks instead of 5.
 */
const MAX_PHYSICS_DELTA_SECONDS = 1 / 20;

export class FixedStepLoop {
  readonly step: number;
  readonly maxSteps: number;
  readonly maxPhysicsDeltaTime: number;
  #onBeginFrame: (() => void) | undefined;
  #onUpdate: (dt: number) => void;
  #onAfterPhysics: (dt: number) => void;
  #onRender: (alpha: number) => undefined | IRenderPerformanceMetrics;
  #onFrame: (frameMs: number) => void;
  #requestFrame: (callback: (time: number) => void) => number;
  #cancelFrame: (handle: number) => void;
  readonly #interpolation: PhysicsInterpolation | undefined;
  #accumulator = 0;
  #lastTime: number | undefined;
  #frameTime = 0;
  #frameHandle: number | undefined;
  #running = false;
  #held = false;
  #clockFrozen = false;
  #driven = false;
  #primePending = false;
  #settleSteps = FROZEN_SETTLE_STEPS;
  #tick = 0;
  #fps = 0;
  #lastRenderTime: number | undefined;
  #renderPerformanceSamples: IRenderPerformanceSample[] = [];
  #renderCompletionSequence = 0;
  #frameCallback: (time: number) => void;
  #budget: FrameBudget | undefined;
  #spans: SpanRecorder | undefined;
  #now: () => number;
  // Sample collection is opt-in because nothing outside a diagnostics consumer reads the series:
  // collecting unconditionally spent allocations on every rendered frame of every game.
  #collectMetrics: boolean;

  constructor(options: IFixedStepLoopOptions) {
    const step = options.step ?? 1 / 60;
    if (!Number.isFinite(step) || step <= 0) {
      throw new Error(
        `FixedStepLoop step must be a finite number of seconds greater than zero, received ${String(options.step)}.`,
      );
    }
    this.step = step;
    this.#interpolation = options.interpolation;
    // A maxSteps below one passed the while-loop bound `updates < maxSteps` zero
    // times per frame: the game rendered but never simulated, silently.
    const maxSteps = options.maxSteps ?? 5;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new Error(
        `FixedStepLoop maxSteps must be an integer of at least one, received ${String(options.maxSteps)}.`,
      );
    }
    this.maxSteps = maxSteps;
    const maxPhysicsDeltaTime = options.maxPhysicsDeltaTime ?? MAX_PHYSICS_DELTA_SECONDS;
    if (Number.isNaN(maxPhysicsDeltaTime) || maxPhysicsDeltaTime <= 0) {
      throw new Error(
        `FixedStepLoop maxPhysicsDeltaTime must be seconds greater than zero, received ${String(options.maxPhysicsDeltaTime)}.`,
      );
    }
    this.maxPhysicsDeltaTime = maxPhysicsDeltaTime;
    this.#collectMetrics = options.collectMetrics ?? false;
    this.#budget = options.budget;
    this.#spans = options.spans;
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.#onBeginFrame = options.onBeginFrame;
    this.#onUpdate = options.onUpdate;
    this.#onAfterPhysics = options.onAfterPhysics ?? (() => undefined);
    this.#onRender = options.onRender ?? (() => undefined);
    this.#onFrame = options.onFrame ?? (() => undefined);
    this.#requestFrame =
      options.requestFrame ??
      ((callback) =>
        typeof globalThis.requestAnimationFrame === "function"
          ? globalThis.requestAnimationFrame(callback)
          : 0);
    this.#cancelFrame =
      options.cancelFrame ??
      ((handle) => {
        if (typeof globalThis.cancelAnimationFrame === "function")
          globalThis.cancelAnimationFrame(handle);
      });
    this.#frameCallback = (time) => this.#frame(time);
  }

  /** Frame callback timestamp in milliseconds. */
  get frameTime(): number {
    return this.#frameTime;
  }

  /** Fraction of the next fixed step accumulated for this presented frame. */
  get alpha(): number {
    return Math.max(0, Math.min(1 - Number.EPSILON, this.#accumulator / this.step));
  }

  get running(): boolean {
    return this.#running;
  }
  get fps(): number {
    return this.#fps;
  }
  runtimeDiagnosticsSeries(): readonly IRenderPerformanceSample[] {
    return this.#renderPerformanceSamples.map((sample) => ({ ...sample }));
  }
  /**
   * Forget the render samples taken so far. The game calls it once, when the world first draws:
   * the frames before it are the boot — held behind the startup compile, drawing nothing — and a
   * steady-state window that keeps them fails `maxDrawCalls` closed on frames that have no draw
   * count and puts seconds of compile into the frame-time percentile.
   */
  clearRuntimeDiagnostics(): void {
    this.#renderPerformanceSamples = [];
  }
  /** The frame budget this loop feeds, when one is installed. */
  get budget(): FrameBudget | undefined {
    return this.#budget;
  }
  /** Turns sample collection on for the rest of the run; a diagnostics consumer asking for the series is the only caller. */
  setCollectMetrics(enabled: boolean): void {
    this.#collectMetrics = enabled;
  }
  /** True while the loop renders without simulating. */
  get held(): boolean {
    return this.#held;
  }
  /**
   * Render without simulating.
   *
   * Boot needs frames on the screen before the start scene has finished loading: on native the
   * render loop is the only thing that can draw, so a loop that starts after `load()` resolves
   * leaves the screen black for the whole asset load and a loading screen never appears. A held
   * loop draws and does nothing else -- `onUpdate` is never called, `tick()` still reads zero,
   * and the hold banks no time, so the first tick after release gets one frame of `dt` rather
   * than one covering the entire load.
   */
  setHeld(held: boolean): void {
    this.#held = held;
  }
  /** Reserved playtest seam: transition without banking elapsed wall time. */
  _setClockMode(mode: "fixed-step" | "wall-clock"): void {
    if (mode !== "fixed-step" && mode !== "wall-clock") throw new Error("Unknown clock mode.");
    const frozen = mode === "fixed-step";
    if (this.#clockFrozen === frozen) return;
    this.#clockFrozen = frozen;
    this.#primePending = false;
    this.#accumulator = 0;
    this.#lastTime = frozen ? Number.POSITIVE_INFINITY : undefined;
    this.#lastRenderTime = undefined;
    this.#driven = false;
    this.clearRuntimeDiagnostics();
    if (this.#running && this.#frameHandle === undefined)
      this.#frameHandle = this.#requestFrame(this.#frameCallback);
  }

  /**
   * Stop the live clock: from here a rendered frame draws and simulates nothing, and banks no
   * time. `advance()` is then the only thing that moves the simulation.
   *
   * This is the whole-run form of the hold above, and it exists because the hold is undone by the
   * first tick while the clock is not. A tick-counting playtest run banks real wall-clock seconds
   * into the same simulation its ticks measure: the runner pumps live frames for the rAF warmup
   * and then for the whole startup wait -- compile settlement is 30s+ on a software adapter and
   * is itself a function of how loaded the machine is -- and every one of those frames advanced
   * the game. Measured on the racing template's `racing-finish-behind-rival-is-dnf`: 164 ticks
   * (2.73s of race time) elapsed before the scenario pressed a key on a fast machine with a real
   * GPU, and that scenario's third lap lands at 47.0s against a 90s in-game race limit, so the
   * 42.7s of headroom is spent by boot time rather than by the scenario. The same scenario then
   * fails its `completedLaps` assertion on a loaded runner and passes on a quiet one, from the
   * same build. Idempotent, and implied by `advance()`.
   *
   * Frozen stops *time*, not the frame function: the loop still settles the world with a fixed
   * number of steps — see `#primeFrame`. A game lays out per-frame state in `update` (action-rpg's
   * touch overlay places itself against the viewport there and is parented to the camera), and a
   * run reads its first observation before it takes its first tick, so a freeze that skipped
   * updates outright left that state at its constructed pose: the overlay sat on the camera's own
   * origin and `point.project` divided by a zero w, which is `NaN` bounds in the entity observation
   * and took the scenario down before it asserted anything.
   *
   * @param settleSteps Fixed steps to run once the loop is live. Defaults to one second; zero
   *   leaves the world exactly as the game built it.
   */
  freezeClock(settleSteps = FROZEN_SETTLE_STEPS): void {
    // Armed by the *transition* into frozen, so `advance()` — which implies the freeze — does not
    // re-arm it and spend a settling pass after every tick-counted step the runner takes.
    if (!Number.isInteger(settleSteps) || settleSteps < 0)
      throw new Error("settleSteps must be a non-negative integer.");
    if (!this.#clockFrozen) this.#primePending = true;
    this.#clockFrozen = true;
    this.#settleSteps = settleSteps;
    this.#lastTime = Number.POSITIVE_INFINITY;
  }
  /** True once the live clock no longer drives the simulation. */
  get clockFrozen(): boolean {
    return this.#clockFrozen;
  }
  readonly tick = (): number => this.#tick;
  start(now = globalThis.performance?.now() ?? 0): void {
    if (this.#running) return;
    this.#running = true;
    this.#driven = false;
    // A freeze asked for before the loop ran outranks the start timestamp, or a playtest bridge
    // that installs first would be undone by the boot it is supposed to cover.
    this.#lastTime = this.#clockFrozen ? Number.POSITIVE_INFINITY : now;
    this.#lastRenderTime = undefined;
    this.#tick = 0;
    this.#fps = 0;
    this.#renderPerformanceSamples = [];
    this.#frameHandle = this.#requestFrame(this.#frameCallback);
  }
  stop(): void {
    this.#running = false;
    if (this.#frameHandle !== undefined) this.#cancelFrame(this.#frameHandle);
    this.#frameHandle = undefined;
    this.#lastTime = undefined;
    this.#accumulator = 0;
  }

  #advanceSimulation(now: number): number {
    if (this.#held || this.#clockFrozen) {
      // The whole accumulate-and-update block is skipped rather than just the callback: `#tick`
      // advances inside that loop, and a held frame that moved the tick would break the
      // determinism contract every playtest hold depends on. The clock still moves forward so
      // the hold banks no time.
      this.#lastTime = Math.max(this.#lastTime ?? now, now);
      this.#primeFrame();
      return 0;
    }
    const elapsed = Math.max(0, (now - (this.#lastTime ?? now)) / 1000);
    this.#lastTime = Math.max(this.#lastTime ?? now, now);
    // An overloaded frame (the stress lab at load 4 drew at 12 fps) ran five whole game updates per
    // frame to catch up, so the next frame was slower still; Unreal clamps instead.
    this.#accumulator += Math.min(elapsed, this.maxPhysicsDeltaTime);
    let updates = 0;
    while (this.#accumulator + Number.EPSILON >= this.step && updates < this.maxSteps) {
      this.#interpolation?.beginTick();
      this.#onUpdate(this.step);
      this.#onAfterPhysics(this.step);
      this.#interpolation?.endTick();
      this.#tick += 1;
      this.#accumulator -= this.step;
      updates += 1;
    }
    if (updates === this.maxSteps && this.#accumulator >= this.step) this.#accumulator = 0;
    return updates;
  }

  /**
   * Settle the world once, on the first live frame after the clock froze.
   *
   * `freezeClock` means the wall clock stops moving the simulation, not that the game stops being
   * called: a scene computes per-frame state in `update` — action-rpg's touch overlay measures the
   * viewport and parents itself to the camera there — and a playtest run reads its first
   * observation before it takes its first tick. Without this pass that state is still whatever its
   * constructor left it, which for a camera-parented overlay is a 72-unit ring sitting on the
   * camera's own origin: `point.project` divides by a zero `w`, and the observation the run reads
   * carries `NaN` bounds, which takes the scenario down before it asserts anything.
   *
   * It is `advance()` over a fixed count, so it is a tick-counted settle rather than a timed one:
   * what it costs is a constant no machine speed can change, and `#tick` moves with it, because the
   * simulation really is that many steps old and the run's report should say so. `FROZEN_SETTLE_STEPS`
   * is where the count comes from.
   *
   * A held boot frame cannot spend it: the scene has not entered yet, so there is nothing of the
   * game's to settle, and the arm survives the hold to fire when the loop is genuinely live. Once,
   * because a second pass would repeat input edge detection and per-frame bookkeeping for nothing.
   */
  #primeFrame(): void {
    if (!this.#primePending || this.#held) return;
    this.#primePending = false;
    if (this.#settleSteps > 0) this.advance(this.#settleSteps);
  }

  #recordFrameTiming(now: number): number | undefined {
    if (!Number.isFinite(now)) return undefined;
    const frameMs = this.#lastRenderTime === undefined ? undefined : now - this.#lastRenderTime;
    if (frameMs !== undefined && frameMs > 0) this.#fps += (1_000 / frameMs - this.#fps) * 0.1;
    this.#lastRenderTime = now;
    return frameMs;
  }

  stepFrame(now: number, driven: boolean | "render-only" = false): number {
    this.#frameTime = now;
    const callbackStartedAt = this.#now();
    const budget = this.#budget;
    budget?.beginFrame(now, this.#now());
    let updates = 0;
    let frameMs: number | undefined;
    let callbackMs: number | undefined;
    let callbackFinishedAt = Number.NaN;
    let metrics: IRenderPerformanceMetrics | undefined;
    let phases: IFramePhaseSample | undefined;
    try {
      this.#onBeginFrame?.();
      if (driven === true) {
        this.#onUpdate(this.step);
        this.#onAfterPhysics(this.step);
        this.#tick += 1;
        updates = 1;
      } else if (driven !== "render-only") updates = this.#advanceSimulation(now);
      budget?.markSimulationEnd(this.#now(), updates);
      frameMs = this.#recordFrameTiming(now);
      // onRender does the rendering itself; only its metrics return value is optional.
      metrics = this.#onRender(this.alpha);
    } finally {
      // A renderer can throw before it returns (for example, when SwiftShader rejects a buffer).
      // Close the budget before propagating that error so later frames report the real failure
      // instead of flooding the console with beginFrame calls against a poisoned budget.
      phases = budget?.endFrame(this.#now(), this.#collectMetrics);
      // Closed against the meter's own render phase, so the tree's residual is arithmetic against
      // the number the window reports rather than against a second measurement of the same work.
      // A frame that threw keeps its half-open stack out of the window instead of contributing a
      // fabricated zero.
      const spans = this.#spans;
      if (spans !== undefined) {
        // From the meter's own reading, never from the optional phase sample: `endFrame` builds a
        // sample only when a consumer asked for one, and shipping games do not, so closing the
        // tree on `phases` abandoned every frame and the span window never appeared.
        const renderMs = budget?.lastRenderMs;
        if (renderMs !== undefined && spans.depth === 0) spans.endFrame(renderMs);
        else spans.abandonFrame();
      }
      callbackFinishedAt = this.#now();
      if (Number.isFinite(callbackStartedAt) && Number.isFinite(callbackFinishedAt)) {
        callbackMs = Math.max(0, callbackFinishedAt - callbackStartedAt);
      }
    }
    // Reached only after successful rendering; IDs also reveal gaps across disabled collection.
    const sequence = ++this.#renderCompletionSequence;
    if (callbackMs !== undefined) this.#onFrame(callbackMs);
    if (this.#collectMetrics && frameMs !== undefined && frameMs > 0) {
      const sample: IRenderPerformanceSample = {
        frameMs,
        sequence,
        completedAtMs: callbackFinishedAt,
        ...(metrics === undefined || metrics.drawCalls === undefined
          ? {}
          : { drawCalls: metrics.drawCalls }),
        ...(metrics?.passes === undefined || metrics.passes.length === 0
          ? {}
          : { passes: aggregatePassesByKind(metrics.passes) }),
        ...(phases === undefined ? {} : { phases }),
        ...(metrics === undefined || metrics.triangles === undefined
          ? {}
          : { triangles: metrics.triangles }),
      };
      this.#renderPerformanceSamples.push(sample);
      if (this.#renderPerformanceSamples.length > MAX_RENDER_PERFORMANCE_SAMPLES)
        this.#renderPerformanceSamples.shift();
    }
    return updates;
  }

  /**
   * Run `ticks` fixed steps now and return how many ran. `until` is asked after each tick and ends
   * the batch early when it answers true, so a caller can stop where an asynchronous change began.
   */
  advance(ticks: number, options?: { render?: boolean; until?: () => boolean }): number {
    if (!this.#running) throw new Error("Cannot advance a stopped loop.");
    if (!Number.isInteger(ticks) || ticks <= 0)
      throw new Error("advance ticks must be a positive integer.");
    // Driving one tick is a statement that the run counts ticks, so it also stops the live clock
    // racing it. `freezeClock()` exists for the frames *before* that statement, which is where a
    // boot's wall clock used to reach the simulation. The prime is not armed from here: this line
    // has just delivered a real update, so the game has had its pass, and arming it would spend
    // one more zero-dt update after every step a run counts. For the same reason a settle still
    // pending is spent: it would otherwise land inside a later counted step as extra ticks.
    this.#primePending = false;
    this.#clockFrozen = true;
    this.#lastTime = Number.POSITIVE_INFINITY;
    if (options?.render === true && !this.#held) {
      // Held startup still needs automatic loading/warmup frames.
      this.#driven = true;
      if (this.#frameHandle !== undefined) this.#cancelFrame(this.#frameHandle);
      this.#frameHandle = undefined;
      for (let index = 0; index < ticks; index += 1) {
        this.stepFrame(this.#now(), true);
        if (options.until?.() === true) return index + 1;
      }
      return ticks;
    }
    // A counted batch is metered, because a tick-counted run — which is what a playtest run is — is
    // simulated entirely by `advance()` and reported `update 0 ms`, `substeps 0` and one boot window
    // followed by nothing but hitches, a blocking batch having pushed the next live timestamp past
    // `hitchMs`. It is charged as simulation, not as a frame: it presents nothing, so counting it as
    // one put zero-millisecond frames that drew nothing into half of every window's frame and render
    // percentiles. `addSimulation` decides which it is from the frame it lands in, so an `advance()`
    // from inside a live frame — the frozen prime's settle — is charged there exactly once.
    const startedAt = this.#now();
    let ran = 0;
    while (ran < ticks) {
      this.#interpolation?.beginTick();
      this.#onUpdate(this.step);
      this.#onAfterPhysics(this.step);
      this.#interpolation?.endTick();
      this.#tick += 1;
      ran += 1;
      if (options?.until?.() === true) break;
    }
    const finishedAt = this.#now();
    const budget = this.#budget;
    if (budget !== undefined && Number.isFinite(startedAt) && Number.isFinite(finishedAt))
      budget.addSimulation(Math.max(0, finishedAt - startedAt), ran);
    return ran;
  }

  /**
   * Draw the world once without stepping it, for a native deterministic screenshot: the automatic
   * frame pump is off between ticks, so nothing presents and a desktop capture would time out.
   * `render-only` runs the render hooks but skips the frozen startup settle, so the copy is the
   * standing world rather than a simulation change; a live clock fails closed.
   */
  renderCurrentFrame(): number {
    if (!this.#running) throw new Error("Cannot render a stopped loop.");
    if (!this.#clockFrozen)
      throw new Error(
        "renderCurrentFrame requires a frozen clock; a live loop advances through its own frames.",
      );
    return this.stepFrame(this.#now(), "render-only");
  }

  #frame(time: number): void {
    if (!this.#running || this.#driven) return;
    try {
      this.stepFrame(time);
    } finally {
      if (this.#running && !this.#driven) {
        this.#frameHandle = this.#requestFrame(this.#frameCallback);
      }
    }
  }
}
