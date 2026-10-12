/**
 * Per-presented-frame cost attribution, on by default, for every platform.
 *
 * A device once read 18.3 fps with nothing in the repository able to say where the frame went;
 * the answer took a hand-written 468-line probe that monkey-patched `requestAnimationFrame` and
 * `renderer.render` from inside the game. That probe had to guess the phase boundaries because it
 * lived outside the loop. This lives inside the loop, so it knows them: the framework owns the
 * simulation/render split, the render call and the frame's start and end, and no game should ever
 * write this again.
 *
 * Two consumers, one measurement:
 *
 *  - a windowed `TN_FRAME_BUDGET` marker line, printed periodically on stdout (and therefore in
 *    logcat on Android), so a cold agent reading standard device-lane output sees the attribution
 *    without instrumenting anything;
 *  - a per-frame sample carried into the playtest render series, so `assert.performance` can bound
 *    an fps floor and a per-phase ceiling and a mobile regression is a red gate rather than a vibe.
 *
 * Fail closed: malformed options throw at construction rather than silently disabling the budget,
 * and a phase that was never measured reports zero samples so a consumer asserting on it fails
 * instead of skipping.
 */

import type { IFrameCounters } from "./profiling/FrameCounters.js";
import {
  FRAME_PASS_KINDS,
  type FramePassKind,
  type IRenderPassSample,
  MAIN_DRAW_SOURCES,
  type MainDrawSource,
} from "./render-pass-budget.js";
import type { ITargetFps, TargetFpsSource } from "./target-fps.js";

const TARGET_FPS_SOURCES: readonly TargetFpsSource[] = [
  "config",
  "display",
  "fallback",
  "mobile-default",
];

/**
 * Fail closed: a resolved budget nobody can act on is not a budget. A rate that is not a
 * non-negative number, or a source that names no rule, would be read as an answer.
 */
function requireTarget(target: ITargetFps): ITargetFps {
  if (!Number.isFinite(target.targetFps) || target.targetFps < 0)
    throw new Error(
      `Frame budget targetFps must be a non-negative number, received ${String(target.targetFps)}.`,
    );
  if (!TARGET_FPS_SOURCES.includes(target.source))
    throw new Error(
      `Frame budget targetSource must name how the target was chosen, received ${String(target.source)}.`,
    );
  return target;
}

/** Marker printed once per report window. */
export const FRAME_BUDGET_MARKER = "TN_FRAME_BUDGET";
/** Marker printed the moment a gap between presented frames exceeds `hitchMs`. */
export const FRAME_HITCH_MARKER = "TN_FRAME_HITCH";

/**
 * The named parts of one presented frame. They partition the frame: `hostGap` is the time before
 * the callback (present wait plus whatever the host did between callbacks), and `update`,
 * `render`, `overlay`, `ui` and `residual` sum to the callback's own duration.
 *
 * `overlay` and `ui` are two different draws that happen to sit next to each other. `overlay` is
 * the three.js HUD pass; `ui` is the native UI layer's composite of the page's pixels into the
 * game's own frame — one upload and one quad — which is why it is a phase of its own and not part
 * of `overlay`.
 */
export const FRAME_BUDGET_PHASES = [
  "hostGap",
  "update",
  "render",
  "overlay",
  "ui",
  "residual",
] as const;

export type FrameBudgetPhase = (typeof FRAME_BUDGET_PHASES)[number];

/** One frame's cost, split by phase. Every field is milliseconds. */
export interface IFramePhaseSample {
  readonly hostGap: number;
  readonly update: number;
  readonly render: number;
  readonly overlay: number;
  readonly ui: number;
  readonly residual: number;
}

/**
 * What the frame the window measured was actually drawn at.
 *
 * A resolution number without its sample count does not describe an image, and neither of them
 * describes anything at all unless the window that carries the fps also carries them. This is
 * reported whether the scale was pinned by the game or chosen by the engine: turning the
 * convention off does not turn its measurement off.
 */
export interface IFrameSurfaceState {
  /** The applied drawing-buffer scale, in `(0, 1]`. */
  readonly resolutionScale: number;
  /**
   * `"pinned"` when the game fixed the number, `"auto"` when the engine chose it, and
   * `"auto-pinned"` when the engine chose it and then stopped moving it — the oscillation guard
   * holding a rung is a different state from a game that pinned one, and reads as one.
   */
  readonly scaleSource: "pinned" | "auto" | "auto-pinned";
  /** Multisample count of the 3D drawing buffer; 1 when sampling is off. */
  readonly sampleCount: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  /**
   * True when the scaler is at its lowest rung and the tail is still over budget.
   *
   * A window that reports 0.23 and nothing else reads as a met budget at a low resolution. It is
   * the opposite: the engine ran out of room and the game is still missing its target. Always
   * false under a pinned scale, which has no floor to reach.
   */
  readonly atFloor: boolean;
  /** Compilation overlapped the measured window; automatic scaling waits for a clean window. */
  readonly compiling?: boolean;
}

const SCALE_SOURCES: readonly IFrameSurfaceState["scaleSource"][] = [
  "pinned",
  "auto",
  "auto-pinned",
];

/** Fail closed: a surface that cannot describe an image is never reported as one. */
function requireSurface(surface: IFrameSurfaceState): IFrameSurfaceState {
  const {
    atFloor,
    compiling,
    drawingBufferHeight,
    drawingBufferWidth,
    resolutionScale,
    sampleCount,
    scaleSource,
  } = surface;
  if (compiling !== undefined && typeof compiling !== "boolean")
    throw new Error("Frame budget surface compiling must be a boolean when observed.");
  if (typeof atFloor !== "boolean")
    throw new Error(
      `Frame budget surface atFloor must say whether the scaler had room left, received ${String(atFloor)}.`,
    );
  if (!Number.isFinite(resolutionScale) || resolutionScale <= 0 || resolutionScale > 1)
    throw new Error(
      `Frame budget surface resolutionScale must be within (0, 1], received ${String(resolutionScale)}.`,
    );
  if (!SCALE_SOURCES.includes(scaleSource))
    throw new Error(
      `Frame budget surface scaleSource must name how the scale was chosen, received ${String(scaleSource)}.`,
    );
  if (!Number.isInteger(sampleCount) || sampleCount < 1)
    throw new Error(
      `Frame budget surface sampleCount must be an integer of at least one, received ${String(sampleCount)}.`,
    );
  for (const [name, value] of [
    ["drawingBufferWidth", drawingBufferWidth],
    ["drawingBufferHeight", drawingBufferHeight],
  ] as const) {
    if (!Number.isInteger(value) || value < 1)
      throw new Error(
        `Frame budget surface ${name} must be an integer of at least one, received ${String(value)}.`,
      );
  }
  return {
    atFloor,
    ...(compiling === undefined ? {} : { compiling }),
    drawingBufferHeight,
    drawingBufferWidth,
    resolutionScale,
    sampleCount,
    scaleSource,
  };
}

export interface IFrameBudgetSummary {
  readonly samples: number;
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

/** Where one resolved frame's GPU milliseconds went. Closed on purpose, like the phases. */
export const FRAME_GPU_BUCKETS = ["main", "shadow", "other", "compute"] as const;

export type FrameGpuBucket = (typeof FRAME_GPU_BUCKETS)[number];

/** One frame's GPU milliseconds per bucket; a bucket the device did not resolve is absent. */
export type IFrameGpuBucketSample = Partial<Record<FrameGpuBucket, number>> & {
  /**
   * Shadow passes the frame recorded, from the producer. `0` means the frame drew no shadow and its
   * `shadow` bucket is a known zero; `> 0` means it rendered one. Absent when the source cannot say,
   * and no frame is then counted as rendered.
   */
  readonly shadowPasses?: number;
};

/**
 * One render-pass kind's submissions across a window, so a change that trades triangles for CPU is
 * visible in the same report as the milliseconds it traded for.
 */
export interface IFrameBudgetPassSummary {
  readonly draws: IFrameBudgetSummary;
  /**
   * The main pass's own draws per origin, summarised like every other series in this window.
   *
   * The per-frame counts sum to `draws` exactly, which is the invariant the split exists to answer;
   * the percentiles below do not have to, because a source that draws on some frames and not others
   * has a median over its own frames rather than over the window's. A source no frame drew is
   * absent. Absent altogether — never a set of zeros — when the renderer named no object behind one
   * of the pass's draws, which is the same rule the pass record itself follows. One exception to the
   * sum: a world with bundles on counts its replays here, and three never traverses a replay, so the
   * sources can exceed `draws`; the sum holds for the sources that went through the per-draw path.
   */
  readonly drawsBySource?: Readonly<Partial<Record<MainDrawSource, IFrameBudgetSummary>>>;
  /** Frames in the window that submitted a pass of this kind. */
  readonly frames: number;
  /**
   * Three's CPU figure: `instanceCount * count / 3` per draw, where an indirect batch's `count` is
   * the merged geometry's capacity. An upper bound over what the GPU could select.
   */
  readonly triangles: IFrameBudgetSummary;
  /**
   * What the GPU selected, main pass only: the streamed world's own indirect tally, beside the
   * figure above so a reader of the pass record can tell which of the two it is holding. Absent
   * rather than zero when the world reported no tally — see `mainGpuTriangles`.
   */
  readonly gpuTriangles?: number;
}

/**
 * One reported window of the frame meter.
 *
 * **The cadence here is the loop's, not necessarily the display's.** `endFrame` is called once per
 * frame the game's loop runs, and on the web that is one `requestAnimationFrame` per vblank, so the
 * interval is a presented frame's. On a native host the loop's dispatch is what drives it — the host
 * says so itself: "the JavaScript budget reads the same interval as presentedDelta"
 * (`runtime-native/src/runtime.cpp`, `executeAnimationFrameCallbacks`). Its presentation cap paces
 * the **present**, never the loop, so a loop that outruns 60 Hz iterates many times per present and
 * this window's `fps` is inflated by exactly that ratio. Measured on midway's native launch:
 * `fps 2631.58` beside the host's own `TN_PRESENTS_TICK:{"frames":1740,"presents":133,"capHz":60}`.
 * The display's rate is the host's series; a reader that has both must not print this one as though
 * it were a player's — `threenative-playtest perf` refuses to (`TN_PERF_VIRTUAL_DISPLAY`).
 */
export interface IFrameBudgetWindow {
  /** Browser Long Tasks, independent of vsync/GPU waits. Unavailable on hosts without this API. */
  readonly longTasks:
    | { readonly available: false }
    | {
        readonly available: true;
        readonly count: number;
        readonly longestMs: number;
        readonly afterFirstFrameMs: number;
      };
  /** 1 for the first reported window, incrementing thereafter. */
  readonly window: number;
  /** Loop frames counted in this window, hitches excluded — one per present on the web. */
  readonly frames: number;
  /** Frames excluded from the window because their present gap exceeded `hitchMs`. */
  readonly hitches: number;
  /**
   * Derived from the mean interval between loop frames. The number a player would read off a
   * counter only where the loop's cadence is the display's, as it is on the web via rAF.
   */
  readonly fps: number;
  /**
   * Frames that reached the display in this window, when the host reports them.
   *
   * Absent on the web, where rAF *is* the display's cadence and a second number would be the same
   * one. On a native host the presentation cap lets the loop dispatch many times per present, so
   * this is the count a player saw and `fps` is not. **Zero is a reading**: a window of loop frames
   * can be shorter than one present period, and the display genuinely showed nothing in it.
   */
  readonly presents?: number;
  /**
   * Presents per second over this window's own duration. Absent when the window counted none —
   * a rate needs at least one present, and a window too short to contain one carries no rate to
   * assess rather than a zero.
   */
  readonly presentedFps?: number;
  /** Interval between loop frames — the honest frame period where the loop presents every frame. */
  readonly presented: IFrameBudgetSummary;
  /** Duration of the frame callback itself, entry to exit. */
  readonly frame: IFrameBudgetSummary;
  /** Fixed simulation steps executed in the callback. */
  readonly substeps: IFrameBudgetSummary;
  readonly phases: Readonly<Record<FrameBudgetPhase, IFrameBudgetSummary>>;
  /** Each phase's mean as a fraction of the mean presented interval. */
  readonly shares: Readonly<Record<FrameBudgetPhase, number>>;
  /**
   * Draw calls and triangles submitted per render pass, when a pass recorder was installed.
   *
   * Absent rather than defaulted: a renderer whose submissions nothing measured and a frame that
   * submitted nothing are different facts, and a zero would merge them. A kind no frame submitted
   * is absent; `frames` says how many frames did.
   */
  readonly passes?: Readonly<Partial<Record<FramePassKind, IFrameBudgetPassSummary>>>;
  /**
   * Instances and triangles the GPU actually selected in the main pass, from the streamed world's
   * own indirect-args tally when it has one.
   *
   * These are the honest counterpart of `passes.main`: three's `renderer.info.render.triangles`
   * counts a mesh's CPU window/capacity for an indirect draw, so `passes.main.triangles` is an upper
   * bound over what the GPU could draw, while `mainGpuTriangles` is the sum over the indirect
   * records of `instanceCount x indexCount / 3` — what the kernel selected. Main pass only: shadow
   * passes are not tallied. Absent, never zero, before the first sample lands.
   */
  readonly mainGpuInstances?: number;
  readonly mainGpuTriangles?: number;
  /**
   * The resolution and sampling this window's frames were drawn at, when the loop reported one.
   * Absent rather than defaulted: a consumer asserting on it must fail loudly instead of reading
   * a fabricated `1.0` that no frame was ever drawn at.
   */
  readonly surface?: IFrameSurfaceState;
  /**
   * The rate the loop is holding, and what decided it, when the engine resolved one.
   *
   * Two fields rather than an object, and a harness reads them without unwrapping anything: a
   * number nobody can place (`targetSource: "fallback"`) is the difference between a game holding
   * its panel and a game settling for 60, and only this line says which one happened.
   */
  readonly targetFps?: number;
  readonly targetSource?: TargetFpsSource;
  /**
   * Frames in this window that ran past the target frame (`1000 / targetFps`, the target this
   * window started with): `render` over every counted frame's render phase, `gpu` over the frames
   * with a resolved GPU sample. A pooled p95 is under the target exactly when at most 5 % of the
   * pooled frames are, which window quantiles can only bound (PRD-478). Absent until a target is
   * known.
   */
  readonly overTarget?: { readonly frameMs: number; readonly gpu: number; readonly render: number };
  /**
   * GPU milliseconds per resolved frame in this window, from `timestamp-query`, summarised like a
   * phase — mean/p50/p95/p99/max over the frames the device actually reported.
   *
   * A single instantaneous `info.render.timestamp` read is lagged by up to `gpuAgeFrames` and
   * spread 3.5x between consecutive reads of one steady frame, so it is not the frame's GPU cost
   * and is not what this reports. Absent rather than zero when no frame resolved a reading: an
   * adapter without timestamps and a frame that genuinely cost no GPU time are different facts,
   * and a zero would merge them.
   */
  readonly gpu?: IFrameBudgetSummary;
  /**
   * Frames in the window whose GPU reading had not advanced since the previous frame, or was
   * absent. `gpu.samples + gpuStale` is the frames the device was asked about; a window where
   * every frame is stale reports `gpu` absent rather than the last reading looking current.
   */
  readonly gpuStale: number;
  /**
   * The window mean of `gpu`, when present. The scalar the resolution scaler reads.
   *
   * It is the same number as `gpu.mean`; a single field keeps the scaler and the perf report on
   * one series rather than a second instantaneous read.
   */
  readonly gpuMs?: number;
  /** Resolved renderer-frame range behind this window; unavailable for unframed samples. */
  readonly gpuFrames?: { readonly first: number; readonly last: number };
  /** Age of the most recent resolved GPU timestamp in Three.js frame IDs; absent means unobservable. */
  readonly gpuAgeFrames?: number;
  /**
   * GPU milliseconds per resolved frame, split by where the device spent them: the main scene
   * pass, every shadow pass, everything else in the render pool (post chain, reflections, HUD) and
   * the compute pool. Each is the window's p50 over the frames that resolved it, one decimal.
   *
   * `gpu` is their sum's series; these say which pass owns it. Absent rather than zero when that
   * bucket never resolved — an unmeasured pass and a free one are different facts — so
   * `gpuMain + gpuShadow + gpuOther` reconciles with `gpuMs` only when all three are present.
   */
  readonly gpuMain?: number;
  readonly gpuShadow?: number;
  readonly gpuOther?: number;
  readonly gpuCompute?: number;
  /**
   * The shadow bucket's p95 and coverage over **every** frame that resolved a shadow reading,
   * known-zero frames included, so the p95 can sit at zero while the shadow renders are expensive.
   * Kept for compatibility beside {@link gpuShadowRendered}, which is the same tail over the frames
   * that actually rendered a shadow — the distribution the phase comparison should read.
   */
  readonly gpuShadowP95?: number;
  readonly gpuShadowSamples?: number;
  /**
   * The shadow bucket's distribution over the frames that **actually rendered a shadow**, distinct
   * from the known-zero frames the p50 and all-frame p95 above include.
   *
   * `samples` is how many frames rendered one, so observed renders are tellable from frames that
   * drew none (`gpuShadowSamples - gpuShadowRendered.samples`). Absent, never a zeroed summary, when
   * no rendered shadow resolved: a render that cost 0 ms is still a render, and only the producer's
   * own `shadowPasses` record says one happened, so the count is not guessed from `shadow > 0`.
   */
  readonly gpuShadowRendered?: IFrameBudgetSummary;
  /** Pyramid build GPU milliseconds per resolved build, including the depth copy/resolve. */
  readonly gpuPyramid?: IFrameBudgetSummary;
  /**
   * The frame's boundary counts, when something counted them, plus the simulation tick the window
   * closed on when the loop fed one.
   *
   * Each boundary series is absent when nothing measured it, and a series present with zero samples
   * is not possible: an uncounted frame and a frame that crossed the boundary zero times are
   * different facts, and a fabricated zero merges them. `hostCalls` and `gpuBytes` come from
   * `FrameCounters`; `jsAllocBytes` needs a platform that publishes `performance.memory`.
   * `simulationTick` is not a platform reading — it is the loop's latest fixed-step count, so the
   * object is present whenever `addCounters` carried a tick even with no boundary field measured.
   */
  readonly counters?: {
    readonly hostCalls?: IFrameBudgetSummary;
    readonly gpuBytes?: IFrameBudgetSummary;
    readonly jsAllocBytes?: IFrameBudgetSummary;
    readonly simulationTick?: number;
  };
}

export interface IFrameBudgetOptions {
  /** Presented frames per report window. Default 300. */
  readonly reportEvery?: number;
  /** A present gap at or above this is a hitch, not a frame. Default 2000 ms. */
  readonly hitchMs?: number;
  /** Ring capacity per series. Default 1024. */
  readonly capacity?: number;
  /** Where marker lines go. Default `console.log`. In defineGame, also receives all window telemetry; without a custom sink its existing info/warn severities remain. */
  readonly report?: (line: string) => void;
  /** Wall clock for hitch markers. Default `Date.now`. */
  readonly wallClock?: () => number;
  /**
   * Called with each completed window, after its marker line. A HUD reads it to show the split
   * on screen; a measurement run reads it to advance in lockstep with the instrument instead of
   * guessing when a window closed.
   */
  readonly onWindow?: (window: IFrameBudgetWindow) => void;
  /**
   * Reads what the frames were drawn at, called once per reported window. Wired by the frame
   * loop, which is the only place that knows both the renderer and the window boundary.
   */
  readonly readSurface?: () => IFrameSurfaceState;
  /**
   * The engine's resolved frame budget, read once per reported window.
   *
   * Wired by the game, which owns the rule and the panel measurement behind it. A window with no
   * resolver reports no target rather than a default that looks measured.
   */
  readonly readTarget?: () => ITargetFps | undefined;
  /**
   * Frames the display has presented so far, when the platform can say.
   *
   * Defaults to the native host's `__tnPresentedCount`, whose presence is the whole signal: the
   * web has no such seam and needs none. A counter that goes backwards or non-finite is ignored
   * for the window rather than reported as a negative rate.
   */
  readonly readPresentCount?: () => number | undefined;
  /** Reads the successful GPU query frame age, not the age of the last resolve attempt. */
  readonly readGpuAgeFrames?: () => number | undefined;
  /**
   * The GPU-selected main-pass instance and triangle count, read once per reported window.
   *
   * Wired by the game from the streamed world's own tally; `undefined` until its first sample lands
   * or when the world has none, so a window reports absent rather than a fabricated zero.
   */
  readonly readGpuTally?: () =>
    | { readonly instances: number; readonly triangles: number }
    | undefined;
}

const DEFAULT_REPORT_EVERY = 300;
const DEFAULT_HITCH_MS = 2_000;
const DEFAULT_CAPACITY = 1_024;

function requirePositiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1)
    throw new Error(
      `Frame budget ${name} must be an integer of at least one, received ${String(value)}.`,
    );
  return value;
}

function requirePositiveNumber(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(
      `Frame budget ${name} must be a finite number greater than zero, received ${String(value)}.`,
    );
  return value;
}

/** A fixed-capacity ring of milliseconds. Never allocates after construction. */
class Ring {
  readonly #buffer: Float64Array;
  #count = 0;
  #cursor = 0;
  #total = 0;

  constructor(capacity: number) {
    this.#buffer = new Float64Array(capacity);
  }

  push(value: number): void {
    // A non-finite sample means a clock the host did not deliver; dropping it silently would
    // manufacture a clean percentile out of a broken measurement.
    if (!Number.isFinite(value))
      throw new Error(`Frame budget received a non-finite sample: ${String(value)}.`);
    const capacity = this.#buffer.length;
    const index = this.#cursor % capacity;
    if (this.#count === capacity) this.#total -= this.#buffer[index] ?? 0;
    this.#buffer[index] = value;
    this.#total += value;
    this.#cursor += 1;
    if (this.#count < capacity) this.#count += 1;
  }

  /** Samples currently held. A series with none is reported absent rather than summarised to zero. */
  get count(): number {
    return this.#count;
  }

  reset(): void {
    this.#count = 0;
    this.#cursor = 0;
    this.#total = 0;
  }

  summarize(scratch: Float64Array): IFrameBudgetSummary {
    const count = this.#count;
    if (count === 0) return { max: 0, mean: 0, p50: 0, p95: 0, p99: 0, samples: 0 };
    for (let index = 0; index < count; index += 1) scratch[index] = this.#buffer[index] ?? 0;
    const view = scratch.subarray(0, count);
    view.sort();
    const rank = (fraction: number): number =>
      round(view[Math.min(count - 1, Math.ceil(fraction * count) - 1)] ?? 0);
    return {
      max: round(view[count - 1] ?? 0),
      mean: round(this.#total / count),
      p50: rank(0.5),
      p95: rank(0.95),
      p99: rank(0.99),
      samples: count,
    };
  }
}

/**
 * The native host's presented-frame counter, when this build has one.
 *
 * `__tnPresentedCount` is a private diagnostic seam beside `__tnPresentationCap`; its *presence* is
 * the signal, so the web returns `undefined` here and the window reports no present series at all
 * rather than a zero. Read through a property lookup once, at construction: a per-frame lookup of a
 * global is a per-frame megamorphic access for no gain.
 */
function hostPresentCountReader(): (() => number | undefined) | undefined {
  const host = globalThis as { __tnPresentedCount?: unknown };
  if (typeof host.__tnPresentedCount !== "function") return undefined;
  const read = host.__tnPresentedCount as () => unknown;
  return () => {
    const value = read();
    return typeof value === "number" ? value : undefined;
  };
}

/** Whether a per-source key names a source this window counts. */
function isMainDrawSource(source: string): source is MainDrawSource {
  return (MAIN_DRAW_SOURCES as readonly string[]).includes(source);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** One decimal, for the per-bucket GPU line the harness prints as `<ms>` with a single place. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Accumulates one frame at a time and reports windowed attribution.
 *
 * The caller is the frame loop; the sequence per frame is
 * `beginFrame` → `markSimulationEnd` → (`addRender` / `addOverlay` / `addUi`) → `endFrame`.
 * Calling them out of order throws rather than producing a plausible-looking split. The one
 * exception is `addSimulation`, which reports simulation that ran outside any frame — see it.
 */
export class FrameBudget {
  #taskObserver: PerformanceObserver | undefined;
  #taskCount = 0;
  #longestTaskMs = 0;
  #afterFirstFrameTaskMs = 0;
  readonly reportEvery: number;
  readonly hitchMs: number;
  #report: (line: string) => void;
  #wallClock: () => number;
  #onWindow: ((window: IFrameBudgetWindow) => void) | undefined;
  #readSurface: (() => IFrameSurfaceState) | undefined;
  #readTarget: (() => ITargetFps | undefined) | undefined;
  #readGpuAgeFrames: (() => number | undefined) | undefined;
  #readGpuTally:
    | (() => { readonly instances: number; readonly triangles: number } | undefined)
    | undefined;
  #scratch: Float64Array;
  #presented: Ring;
  #frame: Ring;
  #substeps: Ring;
  #phaseRings: Record<FrameBudgetPhase, Ring>;
  #gpu: Ring;
  #gpuPyramid: Ring;
  #gpuBucketRings: Record<FrameGpuBucket, Ring>;
  #gpuBucketThisFrame: IFrameGpuBucketSample = {};
  /** Shadow milliseconds of this frame's frames that recorded a shadow pass, not its known zeros. */
  #gpuShadowRendered: Ring;
  /** The shadow pass count the producer reported for this frame; `undefined` when it reported none. */
  #gpuShadowPassesThisFrame: number | undefined;
  #passDrawRings: Record<FramePassKind, Ring>;
  #passDrawSourceRings: Record<MainDrawSource, Ring>;
  #passTriangleRings: Record<FramePassKind, Ring>;
  #passFrames: Record<FramePassKind, number> = { main: 0, nested: 0, reflection: 0, shadow: 0 };
  #passesThisFrame: IRenderPassSample[] = [];
  #hostCalls: Ring;
  #gpuBytes: Ring;
  #jsAllocBytes: Ring;
  #countersThisFrame: IFrameCounters | undefined;
  // The latest tick fed this window. It is not a boundary count and does not sum across frames: it
  // is the loop's fixed-step count at the last frame that fed one, so consecutive window closes read
  // a start tick and an end tick and the join is independent of how many frames rendered.
  #simulationTick: number | undefined;
  #lastRenderMs: number | undefined;
  // The resolved frame the last sample belonged to, so a reading still in flight is not measured
  // twice. It survives a window boundary: the first frame of a new window can still be showing the
  // previous window's resolved frame.
  #lastGpuFrame: number | undefined;
  #gpuThisFrame: number | undefined;
  #gpuFrameThisFrame: number | undefined;
  #gpuFirstFrame = Number.POSITIVE_INFINITY;
  #gpuLastFrame = Number.NEGATIVE_INFINITY;
  #gpuUnframed = false;
  #gpuStaleThisFrame = false;
  #gpuStaleInWindow = 0;
  #open = false;
  #frameStart = 0;
  #simulationEnd: number | undefined;
  #renderMs = 0;
  #overlayMs = 0;
  #uiMs = 0;
  #substepCount = 0;
  #hostGap = 0;
  #presentedDelta = 0;
  #lastTimestamp: number | undefined;
  #lastFrameEnd: number | undefined;
  #framesInWindow = 0;
  #hitchesInWindow = 0;
  /** The target frame this window counts against, and its two counts; see `overTarget`. */
  #targetFrameMs: number | undefined;
  #renderOverTarget = 0;
  #gpuOverTarget = 0;
  #windowIndex = 0;
  #readPresentCount: (() => number | undefined) | undefined;
  #lastPresentCount: number | undefined;
  #presentsInWindow = 0;
  #firstFrameStart: number | undefined;
  #firstTaskFrameStart: number | undefined;

  constructor(options: IFrameBudgetOptions = {}) {
    this.reportEvery = requirePositiveInteger(
      options.reportEvery,
      DEFAULT_REPORT_EVERY,
      "reportEvery",
    );
    this.hitchMs = requirePositiveNumber(options.hitchMs, DEFAULT_HITCH_MS, "hitchMs");
    const capacity = requirePositiveInteger(options.capacity, DEFAULT_CAPACITY, "capacity");
    this.#report = options.report ?? ((line) => console.log(line));
    this.#wallClock = options.wallClock ?? (() => Date.now());
    this.#onWindow = options.onWindow;
    this.#readSurface = options.readSurface;
    this.#readTarget = options.readTarget;
    this.#readPresentCount = options.readPresentCount ?? hostPresentCountReader();
    this.#readGpuAgeFrames = options.readGpuAgeFrames;
    this.#readGpuTally = options.readGpuTally;
    if (globalThis.PerformanceObserver?.supportedEntryTypes.includes("longtask")) {
      this.#taskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.#taskCount++;
          this.#longestTaskMs = Math.max(this.#longestTaskMs, entry.duration);
          if (
            this.#firstTaskFrameStart !== undefined &&
            entry.startTime >= this.#firstTaskFrameStart
          )
            this.#afterFirstFrameTaskMs = Math.max(this.#afterFirstFrameTaskMs, entry.duration);
        }
      });
      this.#taskObserver.observe({ type: "longtask", buffered: true });
    }
    this.#scratch = new Float64Array(capacity);
    this.#presented = new Ring(capacity);
    this.#frame = new Ring(capacity);
    this.#substeps = new Ring(capacity);
    this.#gpu = new Ring(capacity);
    this.#gpuPyramid = new Ring(capacity);
    this.#gpuShadowRendered = new Ring(capacity);
    this.#gpuBucketRings = {
      compute: new Ring(capacity),
      main: new Ring(capacity),
      other: new Ring(capacity),
      shadow: new Ring(capacity),
    };
    this.#hostCalls = new Ring(capacity);
    this.#gpuBytes = new Ring(capacity);
    this.#jsAllocBytes = new Ring(capacity);
    this.#phaseRings = {
      hostGap: new Ring(capacity),
      overlay: new Ring(capacity),
      render: new Ring(capacity),
      residual: new Ring(capacity),
      ui: new Ring(capacity),
      update: new Ring(capacity),
    };
    this.#passDrawRings = {
      main: new Ring(capacity),
      nested: new Ring(capacity),
      reflection: new Ring(capacity),
      shadow: new Ring(capacity),
    };
    this.#passDrawSourceRings = {
      bundles: new Ring(capacity),
      chunks: new Ring(capacity),
      gpuScene: new Ring(capacity),
      instanced: new Ring(capacity),
      other: new Ring(capacity),
      proxies: new Ring(capacity),
      sky: new Ring(capacity),
      terrain: new Ring(capacity),
    };
    this.#passTriangleRings = {
      main: new Ring(capacity),
      nested: new Ring(capacity),
      reflection: new Ring(capacity),
      shadow: new Ring(capacity),
    };
  }

  /**
   * @param timestampMs the frame timestamp the host handed the callback — the presented-frame
   *   clock, which is not the same as `nowMs` and is what the interval between frames comes from.
   * @param nowMs the monotonic clock at callback entry.
   */
  dispose(): void {
    this.#taskObserver?.disconnect();
    this.#taskObserver = undefined;
  }

  beginFrame(timestampMs: number, nowMs: number): void {
    if (this.#open)
      throw new Error("FrameBudget.beginFrame called before the previous frame ended.");
    this.#open = true;
    this.#frameStart = nowMs;
    if (this.#firstFrameStart === undefined) this.#firstFrameStart = nowMs;
    this.#firstTaskFrameStart ??= nowMs;
    this.#simulationEnd = undefined;
    this.#renderMs = 0;
    this.#overlayMs = 0;
    this.#uiMs = 0;
    this.#substepCount = 0;
    this.#gpuThisFrame = undefined;
    this.#gpuFrameThisFrame = undefined;
    this.#gpuStaleThisFrame = false;
    this.#gpuBucketThisFrame = {};
    this.#gpuShadowPassesThisFrame = undefined;
    this.#hostGap = this.#lastFrameEnd === undefined ? 0 : Math.max(0, nowMs - this.#lastFrameEnd);
    this.#presentedDelta =
      this.#lastTimestamp === undefined ? 0 : Math.max(0, timestampMs - this.#lastTimestamp);
    this.#lastTimestamp = timestampMs;
  }

  /** The boundary between the fixed-step simulation and everything the render phase does. */
  markSimulationEnd(nowMs: number, substeps: number): void {
    if (!this.#open) throw new Error("FrameBudget.markSimulationEnd called outside a frame.");
    this.#simulationEnd = nowMs;
    // Accumulated, not assigned: `addSimulation` may already have charged a counted batch that ran
    // inside this frame, and that batch's steps are this frame's.
    this.#substepCount += substeps;
  }

  /**
   * Charges one counted simulation batch — the loop's `advance(ticks)`, which is how a tick-counted
   * playtest run simulates at all — to this window's `update` and `substeps`.
   *
   * A batch is not a frame. It presents nothing, so it must not count as one: no frame in the
   * window, no present interval, no GPU sample, no hitch however long it blocked, and no window
   * boundary. Opening a metered frame around it instead put half of a fixed-step run's windows into
   * the frame and render percentiles as zero-millisecond frames that drew nothing, and closed a
   * "300-frame" window on 300 metered frames rather than 300 presented ones — which is how a
   * 300-frame window came to hold ~20 GPU timestamp samples instead of ~37.
   *
   * Inside a live frame — the frozen prime's settle, which is `advance()` called from inside the
   * frame that armed it — the batch's milliseconds are already inside that frame's own measurement
   * and are not charged a second time; only its steps are added, so the frame reports it exactly
   * once. Its blocking cost reaches the window either way: through the enclosing frame's `update`,
   * or here.
   */
  addSimulation(ms: number, ticks: number): void {
    if (!Number.isFinite(ms) || ms < 0)
      throw new Error(
        `Frame budget simulation ms must be a non-negative number, received ${String(ms)}.`,
      );
    if (!Number.isInteger(ticks) || ticks < 0)
      throw new Error(
        `Frame budget simulation ticks must be a non-negative integer, received ${String(ticks)}.`,
      );
    if (this.#open) {
      this.#substepCount += ticks;
      return;
    }
    this.#phaseRings.update.push(ms);
    this.#substeps.push(ticks);
  }

  addRender(ms: number): void {
    if (!this.#open) throw new Error("FrameBudget.addRender called outside a frame.");
    this.#renderMs += ms;
  }

  addOverlay(ms: number): void {
    if (!this.#open) throw new Error("FrameBudget.addOverlay called outside a frame.");
    this.#overlayMs += ms;
  }

  addUi(ms: number): void {
    if (!this.#open) throw new Error("FrameBudget.addUi called outside a frame.");
    this.#uiMs += ms;
  }

  /**
   * Records one presented frame's GPU duration, from a resolved `timestamp-query`.
   *
   * `ms` is `undefined` when the device reported no reading for the frame. `frame` is the
   * Three.js frame id the duration belongs to — `gpuFrameSample`/`gpuFrameAge` on the renderer.
   * A reading whose `frame` has not advanced since the previous frame is the previous frame's
   * resolve still in flight, so it is counted as stale and not pushed again; that repetition was
   * what made one lagged sample read as the current frame's cost. Without a `frame` a reading is
   * always taken as fresh, since there is nothing to tell repeats from a genuine re-measurement.
   *
   * Once per frame. A window with no reading at all reports `gpu` absent, never a zero.
   */
  addGpuMs(ms: number | undefined, frame?: number): void {
    if (!this.#open) throw new Error("FrameBudget.addGpuMs called outside a frame.");
    if (ms === undefined) {
      this.#gpuStaleThisFrame = true;
      return;
    }
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`Frame budget gpuMs must be a non-negative number, received ${String(ms)}.`);
    }
    if (frame !== undefined) {
      if (!Number.isInteger(frame) || frame < 0) {
        throw new Error(
          `Frame budget gpu frame must be a non-negative integer, received ${String(frame)}.`,
        );
      }
      if (frame === this.#lastGpuFrame) {
        this.#gpuStaleThisFrame = true;
        return;
      }
      this.#lastGpuFrame = frame;
    }
    this.#gpuThisFrame = ms;
    this.#gpuFrameThisFrame = frame;
  }

  /** Record one freshly resolved pyramid build, independently of the render pool's cadence. */
  addGpuPyramidMs(ms: number | undefined): void {
    if (!this.#open) throw new Error("FrameBudget.addGpuPyramidMs called outside a frame.");
    if (ms === undefined) return;
    if (ms < 0) throw new Error("Frame budget gpu pyramid must be non-negative.");
    this.#gpuPyramid.push(ms);
  }

  /**
   * Records where one resolved frame's GPU time went, from the per-pass timestamp split.
   *
   * Alongside `addGpuMs`, once per frame. A bucket the producer could not attribute is left out
   * rather than passed as zero: an unmeasured pass and a free one are different facts, and the
   * p50 of a bucket that was never measured is absent from the window. An unknown bucket name
   * throws rather than being dropped, the same fail-closed rule as a phase.
   */
  addGpuBucketMs(sample: IFrameGpuBucketSample): void {
    if (!this.#open) throw new Error("FrameBudget.addGpuBucketMs called outside a frame.");
    const shadowPasses = sample.shadowPasses;
    if (shadowPasses !== undefined) {
      if (!Number.isInteger(shadowPasses) || shadowPasses < 0)
        throw new Error(
          `Frame budget gpu shadowPasses must be a non-negative integer, received ${String(shadowPasses)}.`,
        );
      this.#gpuShadowPassesThisFrame = shadowPasses;
    }
    for (const bucket of FRAME_GPU_BUCKETS) {
      const ms = sample[bucket];
      if (ms === undefined) continue;
      if (!Number.isFinite(ms) || ms < 0)
        throw new Error(
          `Frame budget gpu ${bucket} must be a non-negative number, received ${String(ms)}.`,
        );
      this.#gpuBucketThisFrame[bucket] = ms;
    }
  }

  /**
   * Records the frame's host-boundary counts, from `FrameCounters` or any other source.
   *
   * At most one call per frame; a second replaces the first rather than summing, because the
   * counter's own reader already returns the frame's totals and summing two reads of one frame
   * would double it. A field the platform cannot report is left out of the series entirely.
   *
   * `simulationTick`, when present, must be a finite non-negative integer and is stored as the
   * window's latest tick — never summed, and never cleared by a later call that omits it, so a
   * plain `TN_FRAME_BUDGET` log can join a window's start and end ticks.
   */
  addCounters(counters: IFrameCounters): void {
    if (!this.#open) throw new Error("FrameBudget.addCounters called outside a frame.");
    for (const [name, value] of [
      ["hostCalls", counters.hostCalls],
      ["gpuBytes", counters.gpuBytes],
      ["jsAllocBytes", counters.jsAllocBytes],
    ] as const) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0)
        throw new Error(
          `Frame budget counter ${name} must be a non-negative number, received ${String(value)}.`,
        );
    }
    const tick = counters.simulationTick;
    if (tick !== undefined) {
      if (!Number.isInteger(tick) || tick < 0)
        throw new Error(
          `Frame budget counter simulationTick must be a non-negative integer, received ${String(tick)}.`,
        );
      this.#simulationTick = tick;
    }
    this.#countersThisFrame = counters;
  }

  /**
   * Records the frame's per-pass submissions, from `RenderPassBudget` or any other source. At most
   * one entry per kind per frame is meaningful; a second of the same kind is summed by the caller.
   * An unknown kind throws rather than being dropped, the same fail-closed rule as a phase.
   */
  addRenderPasses(passes: readonly IRenderPassSample[]): void {
    if (!this.#open) throw new Error("FrameBudget.addRenderPasses called outside a frame.");
    for (const pass of passes) {
      if (!(FRAME_PASS_KINDS as readonly string[]).includes(pass.kind))
        throw new Error(
          `FrameBudget received an unknown pass kind: ${String(pass.kind)}. Expected one of: ${FRAME_PASS_KINDS.join(", ")}.`,
        );
      this.#passesThisFrame.push(pass);
    }
  }

  /**
   * Closes the frame and returns its phase split, or `undefined` when the frame was a hitch and
   * therefore excluded — a 27-second startup stall is not a frame time and must not enter a
   * percentile anybody is asked to act on.
   *
   * `wantSample` is false when the caller is going to discard the split, which is the default
   * shipping configuration. The object is small but it escapes this method, so V8 cannot scalar-
   * replace it, and building one per frame is one dead allocation per frame in every game. The
   * window meters below are pushed either way: turning the sample off must not turn measurement
   * off, and `window()` reads the same numbers whichever way this is called.
   */
  endFrame(nowMs: number, wantSample = true): IFramePhaseSample | undefined {
    if (!this.#open) throw new Error("FrameBudget.endFrame called outside a frame.");
    this.#open = false;
    this.#lastRenderMs = undefined;
    const simulationEnd = this.#simulationEnd ?? this.#frameStart;
    const frameMs = Math.max(0, nowMs - this.#frameStart);
    this.#lastFrameEnd = nowMs;

    this.#countPresents();

    const isHitch = this.#presentedDelta >= this.hitchMs;
    if (isHitch) {
      this.#passesThisFrame.length = 0;
      this.#hitchesInWindow += 1;
      this.#report(
        `${FRAME_HITCH_MARKER}:${JSON.stringify({
          gapMs: round(this.#presentedDelta),
          uptimeMs: round(nowMs),
          wallClock: this.#wallClock(),
        })}`,
      );
      this.#maybeReport();
      return undefined;
    }

    const update = Math.max(0, simulationEnd - this.#frameStart);
    const tail = Math.max(0, nowMs - simulationEnd);
    const residual = Math.max(0, tail - this.#renderMs - this.#overlayMs - this.#uiMs);
    const sample: IFramePhaseSample | undefined = wantSample
      ? {
          hostGap: round(this.#hostGap),
          overlay: round(this.#overlayMs),
          render: round(this.#renderMs),
          residual: round(residual),
          ui: round(this.#uiMs),
          update: round(update),
        }
      : undefined;
    this.#frame.push(frameMs);
    this.#substeps.push(this.#substepCount);
    // The first frame has no predecessor, so it has neither an interval nor a host gap; pushing a
    // zero there would drag every percentile toward a frame that never happened.
    if (this.#presentedDelta > 0) this.#presented.push(this.#presentedDelta);
    if (this.#hostGap > 0) this.#phaseRings.hostGap.push(this.#hostGap);
    this.#phaseRings.update.push(update);
    this.#phaseRings.render.push(this.#renderMs);
    if (this.#targetFrameMs !== undefined && this.#renderMs > this.#targetFrameMs)
      this.#renderOverTarget += 1;
    this.#lastRenderMs = this.#renderMs;
    this.#phaseRings.overlay.push(this.#overlayMs);
    this.#phaseRings.residual.push(residual);
    this.#phaseRings.ui.push(this.#uiMs);
    if (this.#gpuThisFrame !== undefined) {
      this.#gpu.push(this.#gpuThisFrame);
      if (this.#gpuFrameThisFrame === undefined) this.#gpuUnframed = true;
      else {
        this.#gpuFirstFrame = Math.min(this.#gpuFirstFrame, this.#gpuFrameThisFrame);
        this.#gpuLastFrame = Math.max(this.#gpuLastFrame, this.#gpuFrameThisFrame);
      }
      if (this.#targetFrameMs !== undefined && this.#gpuThisFrame > this.#targetFrameMs)
        this.#gpuOverTarget += 1;
    }
    for (const bucket of FRAME_GPU_BUCKETS) {
      const ms = this.#gpuBucketThisFrame[bucket];
      if (ms !== undefined && this.#gpuThisFrame !== undefined)
        this.#gpuBucketRings[bucket].push(ms);
    }
    // The shadow tail over frames that actually rendered a shadow, separate from the known-zero
    // frames the ring above also holds: only the producer's count says a render happened, because a
    // real render can resolve to 0 ms and a `shadow > 0` guess would drop it.
    const renderedShadow = this.#gpuBucketThisFrame.shadow;
    if ((this.#gpuShadowPassesThisFrame ?? 0) > 0 && renderedShadow !== undefined)
      this.#gpuShadowRendered.push(renderedShadow);
    this.#gpuShadowPassesThisFrame = undefined;
    this.#gpuBucketThisFrame = {};
    if (this.#gpuStaleThisFrame) this.#gpuStaleInWindow += 1;
    for (const pass of this.#passesThisFrame) {
      this.#passDrawRings[pass.kind].push(pass.draws);
      this.#passTriangleRings[pass.kind].push(pass.triangles);
      // The main pass's per-origin counts, one sample per source the frame drew. A source the
      // frame did not draw contributes no sample, so its percentiles describe the frames that had
      // it — the same rule every other series here follows.
      if (pass.drawsBySource !== undefined)
        for (const [source, count] of Object.entries(pass.drawsBySource)) {
          if (!isMainDrawSource(source))
            throw new Error(
              `FrameBudget received an unknown main draw source: ${source}. Expected one of: ${MAIN_DRAW_SOURCES.join(", ")}.`,
            );
          this.#passDrawSourceRings[source].push(count);
        }
      this.#passFrames[pass.kind] += 1;
    }
    this.#passesThisFrame.length = 0;
    const counters = this.#countersThisFrame;
    this.#countersThisFrame = undefined;
    if (counters?.hostCalls !== undefined) this.#hostCalls.push(counters.hostCalls);
    if (counters?.gpuBytes !== undefined) this.#gpuBytes.push(counters.gpuBytes);
    if (counters?.jsAllocBytes !== undefined) this.#jsAllocBytes.push(counters.jsAllocBytes);
    this.#framesInWindow += 1;
    this.#maybeReport();
    return sample;
  }

  /** Reads the window in progress without disturbing it. */
  window(): IFrameBudgetWindow {
    const presented = this.#presented.summarize(this.#scratch);
    const phases = {
      hostGap: this.#phaseRings.hostGap.summarize(this.#scratch),
      overlay: this.#phaseRings.overlay.summarize(this.#scratch),
      render: this.#phaseRings.render.summarize(this.#scratch),
      residual: this.#phaseRings.residual.summarize(this.#scratch),
      ui: this.#phaseRings.ui.summarize(this.#scratch),
      update: this.#phaseRings.update.summarize(this.#scratch),
    };
    const share = (value: number): number =>
      presented.mean === 0 ? 0 : Math.round((value / presented.mean) * 1_000) / 1_000;
    const passes: Partial<Record<FramePassKind, IFrameBudgetPassSummary>> = {};
    const gpuTally = this.#readGpuTally?.();
    for (const kind of FRAME_PASS_KINDS) {
      if (this.#passFrames[kind] === 0) continue;
      // The split belongs to `main` alone, and it is the only kind the recorder attributes: the
      // rings are per source rather than per kind and per source, so a summary that attached them
      // to a shadow pass would report the main pass's origins under a nested pass's name.
      const drawsBySource: Partial<Record<MainDrawSource, IFrameBudgetSummary>> = {};
      if (kind === "main")
        for (const source of MAIN_DRAW_SOURCES) {
          const ring = this.#passDrawSourceRings[source];
          if (ring.count > 0) drawsBySource[source] = ring.summarize(this.#scratch);
        }
      passes[kind] = {
        draws: this.#passDrawRings[kind].summarize(this.#scratch),
        ...(Object.keys(drawsBySource).length === 0 ? {} : { drawsBySource }),
        frames: this.#passFrames[kind],
        triangles: this.#passTriangleRings[kind].summarize(this.#scratch),
        // Main pass only, and beside three's CPU figure rather than instead of it: the same window
        // that says `triangles 338,000,000` has to say what the kernel actually selected.
        ...(kind === "main" && gpuTally !== undefined ? { gpuTriangles: gpuTally.triangles } : {}),
      };
    }
    const surface =
      this.#readSurface === undefined ? undefined : requireSurface(this.#readSurface());
    const gpuAgeFrames = this.#readGpuAgeFrames?.();
    if (gpuAgeFrames !== undefined && (!Number.isInteger(gpuAgeFrames) || gpuAgeFrames < 0))
      throw new Error(
        `Frame budget gpuAgeFrames must be a non-negative integer, received ${String(gpuAgeFrames)}.`,
      );
    // The window's own duration, for a rate built from presents rather than from loop intervals.
    const windowSpanMs = this.#windowSpanMs;
    // A seam plus one readable sample: zero presents is a reading, absent is no seam. The
    // unreadable flag clears itself on the next good sample, so a transient gap does not end the
    // series for the rest of the run.
    const presentCounted =
      this.#readPresentCount !== undefined && this.#lastPresentCount !== undefined;
    const hostCalls =
      this.#hostCalls.count === 0 ? undefined : this.#hostCalls.summarize(this.#scratch);
    const gpuBytes =
      this.#gpuBytes.count === 0 ? undefined : this.#gpuBytes.summarize(this.#scratch);
    const jsAllocBytes =
      this.#jsAllocBytes.count === 0 ? undefined : this.#jsAllocBytes.summarize(this.#scratch);
    const simulationTick = this.#simulationTick;
    const counters =
      hostCalls === undefined &&
      gpuBytes === undefined &&
      jsAllocBytes === undefined &&
      simulationTick === undefined
        ? undefined
        : {
            ...(gpuBytes === undefined ? {} : { gpuBytes }),
            ...(hostCalls === undefined ? {} : { hostCalls }),
            ...(jsAllocBytes === undefined ? {} : { jsAllocBytes }),
            ...(simulationTick === undefined ? {} : { simulationTick }),
          };
    const gpuSummary = this.#gpu.summarize(this.#scratch);
    const gpu = gpuSummary.samples === 0 ? undefined : gpuSummary;
    const gpuBucket = (bucket: FrameGpuBucket): number | undefined => {
      const summary = this.#gpuBucketRings[bucket].summarize(this.#scratch);
      return summary.samples === 0 ? undefined : round1(summary.p50);
    };
    const gpuMain = gpuBucket("main");
    const gpuShadow = gpuBucket("shadow");
    const gpuOther = gpuBucket("other");
    const gpuCompute = gpuBucket("compute");
    const shadowBucket = this.#gpuBucketRings.shadow.summarize(this.#scratch);
    const shadowRendered = this.#gpuShadowRendered.summarize(this.#scratch);
    const gpuPyramid = this.#gpuPyramid.summarize(this.#scratch);
    const target = this.#readTarget === undefined ? undefined : (this.#readTarget() ?? undefined);
    const resolvedTarget = target === undefined ? undefined : requireTarget(target);
    const overTarget =
      this.#targetFrameMs === undefined
        ? undefined
        : {
            frameMs: round(this.#targetFrameMs),
            gpu: this.#gpuOverTarget,
            render: this.#renderOverTarget,
          };
    // The next window counts against the target this one reports.
    this.#targetFrameMs =
      resolvedTarget !== undefined && resolvedTarget.targetFps > 0
        ? 1_000 / resolvedTarget.targetFps
        : undefined;
    return {
      longTasks:
        this.#taskObserver === undefined
          ? { available: false }
          : {
              available: true,
              count: this.#taskCount,
              longestMs: this.#longestTaskMs,
              afterFirstFrameMs: this.#afterFirstFrameTaskMs,
            },
      fps: presented.mean === 0 ? 0 : round(1_000 / presented.mean),
      frame: this.#frame.summarize(this.#scratch),
      frames: this.#framesInWindow,
      hitches: this.#hitchesInWindow,
      phases,
      presented,
      ...(presentCounted ? { presents: this.#presentsInWindow } : {}),
      ...(presentCounted && this.#presentsInWindow > 0 && windowSpanMs > 0
        ? { presentedFps: round((this.#presentsInWindow * 1_000) / windowSpanMs) }
        : {}),
      shares: {
        hostGap: share(phases.hostGap.mean),
        overlay: share(phases.overlay.mean),
        render: share(phases.render.mean),
        residual: share(phases.residual.mean),
        ui: share(phases.ui.mean),
        update: share(phases.update.mean),
      },
      substeps: this.#substeps.summarize(this.#scratch),
      ...(Object.keys(passes).length === 0 ? {} : { passes }),
      // The GPU-selected main-pass count, beside the pass record it refines: absent until the
      // world's tally has a sample, so a reader never sees a zero that no frame selected.
      ...(gpuTally === undefined
        ? {}
        : { mainGpuInstances: gpuTally.instances, mainGpuTriangles: gpuTally.triangles }),
      // One series, two readers: `gpu` is the distribution and `gpuMs` is its mean for the scaler
      // and the perf record, which want a single number.
      ...(gpu === undefined ? {} : { gpu }),
      gpuStale: this.#gpuStaleInWindow,
      ...(gpu === undefined ? {} : { gpuMs: gpu.mean }),
      ...(gpu === undefined || this.#gpuUnframed
        ? {}
        : { gpuFrames: { first: this.#gpuFirstFrame, last: this.#gpuLastFrame } }),
      ...(gpuAgeFrames === undefined ? {} : { gpuAgeFrames }),
      ...(resolvedTarget === undefined
        ? {}
        : { targetFps: resolvedTarget.targetFps, targetSource: resolvedTarget.source }),
      ...(overTarget === undefined ? {} : { overTarget }),
      ...(surface === undefined ? {} : { surface }),
      ...(counters === undefined ? {} : { counters }),
      window: this.#windowIndex + 1,
      // Appended after every existing field so a parser that reads this line as JSON keeps the
      // keys it already knew; the per-bucket p50s are the only additions.
      ...(gpuMain === undefined ? {} : { gpuMain }),
      ...(gpuShadow === undefined ? {} : { gpuShadow }),
      ...(gpuOther === undefined ? {} : { gpuOther }),
      ...(gpuCompute === undefined ? {} : { gpuCompute }),
      ...(shadowBucket.samples === 0
        ? {}
        : { gpuShadowP95: round1(shadowBucket.p95), gpuShadowSamples: shadowBucket.samples }),
      ...(shadowRendered.samples === 0 ? {} : { gpuShadowRendered: shadowRendered }),
      ...(gpuPyramid.samples === 0 ? {} : { gpuPyramid }),
    };
  }

  /**
   * The render phase of the frame that just closed, or `undefined` when that frame was a hitch and
   * therefore not counted.
   *
   * It exists because the phase split object is optional — `endFrame` builds one only when a
   * consumer asked for per-frame samples, which shipping games do not — and a reader that needs
   * the number must not be forced to turn that allocation on to get it. Reading a measurement and
   * collecting a sample are different requests.
   */
  get lastRenderMs(): number | undefined {
    return this.#lastRenderMs;
  }

  /**
   * Folds the display's own present counter into this window.
   *
   * Read once per frame, at the frame's close, so the delta covers what the display did during it.
   * A counter that went backwards (a host restarting its numbering) or is not finite is treated as
   * a gap in the reading rather than as a negative rate; the window then reports no presents at all
   * rather than a number built from a discontinuity.
   */
  /** Duration of the window's loop frames, first start to last end. */
  get #windowSpanMs(): number {
    if (this.#firstFrameStart === undefined || this.#lastFrameEnd === undefined) return 0;
    return Math.max(0, this.#lastFrameEnd - this.#firstFrameStart);
  }

  #countPresents(): void {
    const read = this.#readPresentCount;
    if (read === undefined) return;
    const count = read();
    if (count === undefined || !Number.isFinite(count)) {
      // One unreadable sample is not a broken counter: the reading resumes on the next frame, and
      // the window still says what it counted.
      this.#lastPresentCount = undefined;
      return;
    }
    const previous = this.#lastPresentCount;
    this.#lastPresentCount = count;
    if (previous === undefined || count < previous) return; // first sample, or a restarted counter
    this.#presentsInWindow += count - previous;
  }

  #maybeReport(): void {
    if (this.#framesInWindow < this.reportEvery) return;
    const completed = this.window();
    this.#report(`${FRAME_BUDGET_MARKER}:${JSON.stringify(completed)}`);
    this.#windowIndex += 1;
    this.#presented.reset();
    this.#frame.reset();
    this.#substeps.reset();
    this.#gpu.reset();
    this.#gpuFirstFrame = Number.POSITIVE_INFINITY;
    this.#gpuLastFrame = Number.NEGATIVE_INFINITY;
    this.#gpuUnframed = false;
    this.#gpuPyramid.reset();
    for (const bucket of FRAME_GPU_BUCKETS) this.#gpuBucketRings[bucket].reset();
    this.#gpuShadowRendered.reset();
    this.#hostCalls.reset();
    this.#gpuBytes.reset();
    this.#jsAllocBytes.reset();
    this.#simulationTick = undefined;
    this.#gpuStaleInWindow = 0;
    for (const phase of FRAME_BUDGET_PHASES) this.#phaseRings[phase].reset();
    for (const kind of FRAME_PASS_KINDS) {
      this.#passDrawRings[kind].reset();
      this.#passTriangleRings[kind].reset();
      this.#passFrames[kind] = 0;
    }
    for (const source of MAIN_DRAW_SOURCES) this.#passDrawSourceRings[source].reset();
    this.#framesInWindow = 0;
    this.#hitchesInWindow = 0;
    this.#renderOverTarget = 0;
    this.#gpuOverTarget = 0;
    this.#presentsInWindow = 0;
    this.#firstFrameStart = undefined;
    // After the reset, so a consumer that changes the scene from this callback changes it for the
    // window that starts now rather than for the one just reported.
    this.#onWindow?.(completed);
  }
}
