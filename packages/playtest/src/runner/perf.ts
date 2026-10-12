import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { decideDisplayStrategy } from "./captureEnvironment.js";

import { discoverAdb } from "./android.js";
import { formatPipelineCacheObservations, parsePipelineCacheObservations, type IPipelineCacheObservation } from "./pipeline-cache-observations.js";
import { PlaytestCliUsageError } from "./config.js";
import { parsePipelineEventMarkers, type IPipelineCaptureEvent } from "./pipeline-summary.js";

/**
 * `threenative-playtest perf` — read the frame the host already reports, without opening a log by
 * hand. `TN_FRAME_BUDGET` (JS-side, every target) and `TN_HOST_GAP` (native host, between-callback
 * truth) carried every number in the Android-fps hunt, and not one line of either was read by
 * code — each number in `docs/verification/runtime-perf-state.md` was grepped by hand. This
 * command is that grep, with the hunt's paid-for protocol rules built in: window 1 is discarded
 * (it always lies — startup stall, shader compile), a run with fewer steady windows than required
 * fails instead of reporting, and a marker line whose JSON cannot be read throws rather than
 * being silently dropped.
 *
 * This command reports and optionally bounds; it never launches a browser (the browser lane
 * already owns `assert.performance`) and never tunes anything. A run whose markers never arrive
 * is a failure, never a healthy-looking empty report.
 */

export const FRAME_BUDGET_MARKER = "TN_FRAME_BUDGET:";
/**
 * The per-window scene-projection line. Read here rather than in the game so an agent can rank
 * what the optimizer is still leaving on its one-draw-each lane without owning the device it ran
 * on. The literal is duplicated from `@threenative/core` deliberately: this module parses a log,
 * it does not import the runtime that wrote it.
 */
export const PROJECTION_MARKER = "TN_PROJECTION:";
export const HOST_GAP_MARKER = "TN_HOST_GAP:";
export const HITCH_MARKER = "TN_FRAME_HITCH:";

/**
 * The host's own stall report, emitted after any phase that took at least 250 ms
 * (`runtime-native/src/runtime.cpp`, `SlowPhaseWatch`). `atMs` is the phase's **end**.
 */
export const SLOW_PHASE_MARKER = "TN_SLOW_PHASE:";

/**
 * The host's own frames-versus-presents counter (`runtime-native/src/webgpu/bindings_presentation.cpp`,
 * `reportPresentTick`), emitted periodically on every platform.
 *
 * It is the only reading in a log that says whether the loop's cadence reached the display: the
 * presentation cap lets a loop iterate many times per present, so a budget window's `fps` can be the
 * loop's rate rather than the display's. Measured on midway's native launch: 1740 loop frames, 133
 * presents, cap 60 Hz, beside a window reporting 2631 fps.
 */
export const PRESENTS_TICK_MARKER = "TN_PRESENTS_TICK:";

export interface IPresentsTickJson {
  readonly bufferMB?: number;
  readonly capHz?: number;
  readonly frames: number;
  readonly presents: number;
  readonly textureMB?: number;
  readonly textures?: number;
}

export interface IPerfSummary {
  readonly mean: number;
  readonly p50: number;
  readonly p95: number;
}

/**
 * One pass's submissions in a window, as the runtime reported them.
 *
 * `triangles` is three's CPU figure — `instanceCount * count / 3` per draw, and an indirect batch's
 * `count` is its merged geometry's capacity, so a streamed world reads in the hundreds of millions.
 * `gpuTriangles` is what the kernel selected, which is the number to bound work against.
 */
export interface IPerfPassJson extends IPassJson {
  readonly triangles?: IPerfSummary;
  readonly gpuTriangles?: number;
}

/** What the window's frames were drawn at, when the loop reported it. */
export interface IFrameSurfaceJson {
  /** Present only when the runtime measured whether asynchronous pipeline compilation remained active. */
  readonly compiling?: boolean;
  readonly resolutionScale: number;
  readonly scaleSource: string;
  readonly sampleCount: number;
  readonly drawingBufferWidth: number;
  readonly drawingBufferHeight: number;
  readonly atFloor?: boolean;
}

/**
 * One render pass's submissions, as `packages/core/src/render-pass-budget.ts` reports them.
 *
 * `drawsBySource` is PRD-494's per-origin split of the main pass's draws: the frame-level counts sum
 * to `draws`, so the percentiles of two different sources need not, and the line below is read as
 * "which origin owns the pass", not as arithmetic.
 */
export interface IPassJson {
  readonly draws?: IPerfSummary;
  readonly drawsBySource?: Readonly<Record<string, IPerfSummary>>;
  readonly frames?: number;
}

export interface IFrameBudgetWindowJson {
  /**
   * The loop's cadence. It is the display's where the loop presents every frame — the web, via rAF —
   * and is inflated by the presentation-cap ratio where it does not, so prefer
   * {@link presentedFps} whenever the engine reports it.
   */
  readonly fps: number;
  readonly frames: number;
  readonly frame?: IPerfSummary;
  readonly hitches: number;
  readonly phases?: Readonly<Record<string, IPerfSummary>>;
  /** Frames that reached the display in this window, when the host can count them. */
  readonly presents?: number;
  /** The rate those presents imply, over the window's own duration. */
  readonly presentedFps?: number;
  readonly surface?: IFrameSurfaceJson;
  /** GPU milliseconds from `timestamp-query`, absent when the adapter has none. */
  readonly gpuMs?: number;
  /** Per-pass draws and triangles, absent on a runtime that measured no passes. */
  readonly passes?: Readonly<Record<string, IPerfPassJson>>;
  readonly window: number;
}

export interface IHostGapSegmentJson {
  readonly meanMs: number;
  readonly p50Ms: number;
}

export interface IHostGapWindowJson {
  readonly frames: number;
  readonly periodP50Ms: number;
  readonly segments: Readonly<Record<string, IHostGapSegmentJson>>;
  readonly sumP50Ms?: number;
}

/**
 * One `TN_FRAME_HITCH` window from the native host: the first 300 presented frames after launch,
 * reported as a distribution. The `pipelineCompile` fields are PRD-327 Phase 4's late-sync-compile
 * attribution — absent on lines from hosts older than the field, which must still parse.
 *
 * **Two engine modules emit this marker name with different payloads.** The native host
 * (`runtime-native/include/mystral/cold_start.h`) emits the window below; core's own frame budget
 * (`packages/core/src/frame-budget.ts`, `endFrame`) emits `{ gapMs, uptimeMs, wallClock }` the
 * moment a present gap exceeds `hitchMs`, on every platform. A reader that assumes one shape turns
 * the other into an absent `maxMs` and prints `worst NaN ms` — measured on midway's native launch
 * log, which carried three gap lines of 2.1-3.0 s beside the host's windows.
 */
export interface IHitchWindowJson {
  readonly window: number;
  readonly maxMs: number;
  readonly maxAtFrame: number;
  readonly p99Ms: number;
  readonly p50Ms: number;
  readonly pipelineCompileMs?: number;
  readonly pipelineCompileCalls?: number;
}

/** A phase the native host watched take longer than its stall threshold. */
export interface ISlowPhaseJson {
  readonly atMs: number;
  readonly ms: number;
  readonly phase: string;
}

/** One present gap the JS frame budget reported, not a 300-frame window. */
export interface IPresentGapJson {
  readonly gapMs: number;
  readonly uptimeMs: number;
  readonly wallClock?: number;
}

export type IPerfViolationCode =
  | "TN_PERF_BOUNDS_NOT_ASSESSABLE"
  | "TN_PERF_HOST_EXIT"
  | "TN_PERF_MAX_FRAME_P95"
  | "TN_PERF_MIN_FPS"
  | "TN_PERF_VIRTUAL_DISPLAY"
  | "TN_PERF_WINDOWS_MISSING";

export interface IPerfViolation {
  readonly bound: number;
  readonly code: IPerfViolationCode;
  readonly observed: number | undefined;
  readonly window: number;
}

/**
 * What the projection spent reconciling in one window, as the runtime reported it.
 *
 * `lastReconcileMs` is the per-frame attribution term the perf loop reads; `reconcileMs` is the
 * run's running total and `maxReconcileMs` its worst frame. Absent on a `TN_PROJECTION` line from
 * a runtime older than the field, which is named as unreported, never read as a measured zero.
 */
export interface IProjectionTimingsJson {
  readonly compileMs: number;
  readonly reconcileMs: number;
  readonly lastReconcileMs: number;
  readonly maxReconcileMs: number;
}

export interface IProjectionWindowJson {
  readonly drawsActual?: number;
  readonly drawsPlanned: number;
  readonly exact: Readonly<Record<string, number>>;
  readonly exactObjects: number;
  readonly projecting: boolean;
  readonly reason?: string;
  readonly reasonCode: string;
  readonly sourceRenderables: number;
  readonly timings?: IProjectionTimingsJson;
  readonly window: number;
}

export interface IPerfMarkerParse {
  readonly budgets: readonly IFrameBudgetWindowJson[];
  readonly hitches: readonly IHitchWindowJson[];
  readonly presentGaps: readonly IPresentGapJson[];
  readonly hostGaps: readonly IHostGapWindowJson[];
  readonly pipelineEvents: readonly IPipelineCaptureEvent[];
  readonly pipelineCaches?: readonly IPipelineCacheObservation[];
  readonly presentMode: string | undefined;
  readonly presents: readonly IPresentsTickJson[];
  readonly projections: readonly IProjectionWindowJson[];
  readonly slowPhases: readonly ISlowPhaseJson[];
}

/**
 * What the run painted on, as far as the command can know.
 *
 * `virtual` means the operator never asked for the host display, so whatever this run drew on is a
 * private Xvfb — the arrangement in which the present wait lands inside the engine's update phase
 * and a frame rate is wrong rather than missing. `fpsSuppressed` says the report refused to print
 * one, which the text output must state rather than leave as a blank column.
 */
export interface IPerfDisplay {
  readonly fpsSuppressed: boolean;
  /** Why the frame rate was not presented — a private display, or frames the host never presented. */
  readonly reason?: string;
  readonly strategy: string;
  readonly virtual: boolean;
}

/**
 * Below this share of loop frames reaching the display, the loop's cadence is not a frame rate a
 * player would see. The presentation cap permits many iterations per present, so a loop spinning
 * faster than the cap inflates `fps` by exactly that factor.
 */
export const PRESENTS_REACHED_DISPLAY_RATIO = 0.95;

export interface IPerfReport {
  readonly budgets: readonly IFrameBudgetWindowJson[];
  readonly discardedWindows: readonly number[];
  readonly hitches: readonly IHitchWindowJson[];
  readonly hostGaps: readonly IHostGapWindowJson[];
  readonly pipelineEvents?: readonly IPipelineCaptureEvent[];
  readonly pipelineCaches?: readonly IPipelineCacheObservation[];
  readonly display?: IPerfDisplay;
  readonly pass: boolean;
  readonly presentGaps: readonly IPresentGapJson[];
  readonly presentMode: string | undefined;
  readonly presents: readonly IPresentsTickJson[];
  readonly projections: readonly IProjectionWindowJson[];
  readonly slowPhases: readonly ISlowPhaseJson[];
  readonly source: string;
  readonly violations: readonly IPerfViolation[];
}

/**
 * Orders the exact lane by the draws each reason costs, largest first.
 *
 * The next population worth folding is whichever reason tops this list in a game that is actually
 * slow. Picking it any other way is picking it by intuition.
 */
export function rankExactReasons(
  exact: Readonly<Record<string, number>>,
): { count: number; reason: string }[] {
  return Object.entries(exact)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([reason, count]) => ({ count, reason }))
    .sort((left, right) => right.count - left.count || (left.reason < right.reason ? -1 : 1));
}

export interface IPerfBounds {
  /** Accept a frame rate measured on a private Xvfb, which the same package's `trace` never does. */
  readonly allowVirtualDisplay?: boolean;
  readonly maxFrameMsP95?: number;
  readonly minFps?: number;
  readonly requireWindows: number;
}

export interface IPerfArgs extends IPerfBounds {
  readonly executable: string | undefined;
  readonly file: string | undefined;
  readonly hostArgs: readonly string[];
  readonly logcatSerial: string | undefined;
  readonly text: boolean;
  readonly timeoutSeconds: number;
}

const PRESENT_MODE_PATTERN = /Present mode: (\S+ \(vsync=(?:true|false)\))/u;

/**
 * Parse every marker line out of a captured stream, logcat prefixes and all. A line that names a
 * marker but carries unparsable JSON throws — a meter line that cannot be read must never be
 * counted as absent, because "absent" is itself a failure here and a silent drop would hide the
 * difference between the two.
 */
/**
 * Which of the two `TN_FRAME_HITCH` payloads this is.
 *
 * The gap shape is `{ gapMs, uptimeMs, wallClock }` and nothing else; the window shape carries
 * `window` and a `maxMs`. A payload with neither is treated as a window so the window reader names
 * the fields it is missing rather than this silently dropping the line.
 */
function isPresentGap(payload: IHitchWindowJson | IPresentGapJson): payload is IPresentGapJson {
  const candidate = payload as Partial<IPresentGapJson> & Partial<IHitchWindowJson>;
  return (
    Number.isFinite(candidate.gapMs) &&
    Number.isFinite(candidate.uptimeMs) &&
    candidate.window === undefined
  );
}

export function parsePerformanceMarkers(text: string): IPerfMarkerParse {
  const budgets: IFrameBudgetWindowJson[] = [];
  const budgetPayloads = new Set<string>();
  const hitches: IHitchWindowJson[] = [];
  const presentGaps: IPresentGapJson[] = [];
  const presents: IPresentsTickJson[] = [];
  const slowPhases: ISlowPhaseJson[] = [];
  const hitchPayloads = new Set<string>();
  const hostGaps: IHostGapWindowJson[] = [];
  const projections: IProjectionWindowJson[] = [];
  const projectionPayloads = new Set<string>();
  let presentMode: string | undefined;
  const pipelineEvents = parsePipelineEventMarkers(text);
  for (const line of text.split("\n")) {
    const budget = parseMarkerLine<IFrameBudgetWindowJson>(line, FRAME_BUDGET_MARKER);
    if (budget !== undefined) {
      // Android mirrors console output through MystralStdio and MystralJS. One measured window is
      // therefore present twice in logcat with the exact same payload; count that observation once
      // without hiding a second payload whose measurements differ.
      const payload = JSON.stringify(budget);
      if (!budgetPayloads.has(payload)) {
        budgetPayloads.add(payload);
        budgets.push(budget);
      }
    }
    const hitch = parseMarkerLine<IHitchWindowJson | IPresentGapJson>(line, HITCH_MARKER);
    if (hitch !== undefined) {
      // Same reason the budget lines are de-duplicated: Android mirrors console output twice.
      const payload = JSON.stringify(hitch);
      if (!hitchPayloads.has(payload)) {
        hitchPayloads.add(payload);
        // Two engine modules share this marker name: the native host's 300-frame window and core's
        // own per-frame present gap. Reading every line as a window is what printed `worst NaN ms`.
        if (isPresentGap(hitch)) {
          presentGaps.push(hitch);
        } else {
          // Neither shape: the window reader would print a maximum it never received. Name the
          // line instead — a marker that cannot be read is the finding, never a rendered number.
          if (!Number.isFinite(hitch.maxMs)) {
            throw new Error(
              `TN_PERF_MARKER_MALFORMED: a ${HITCH_MARKER} line carries neither a present gap ` +
                `(gapMs) nor a window's maxMs: ${line.trim()}`,
            );
          }
          hitches.push(hitch);
        }
      }
    }
    const tick = parseMarkerLine<IPresentsTickJson>(line, PRESENTS_TICK_MARKER);
    if (tick !== undefined) presents.push(tick);
    const slowPhase = parseMarkerLine<ISlowPhaseJson>(line, SLOW_PHASE_MARKER);
    if (slowPhase !== undefined) slowPhases.push(slowPhase);
    const hostGap = parseMarkerLine<IHostGapWindowJson>(line, HOST_GAP_MARKER);
    if (hostGap !== undefined) hostGaps.push(hostGap);
    const projection = parseMarkerLine<IProjectionWindowJson>(line, PROJECTION_MARKER);
    if (projection !== undefined) {
      assertProjectionTimings(projection);
      // Same reason the budget lines are de-duplicated: Android mirrors console output twice.
      const payload = JSON.stringify(projection);
      if (!projectionPayloads.has(payload)) {
        projectionPayloads.add(payload);
        projections.push(projection);
      }
    }
    const mode = PRESENT_MODE_PATTERN.exec(line);
    if (mode?.[1] !== undefined) presentMode = mode[1];
  }
  return {
    budgets,
    hitches,
    hostGaps,
    pipelineEvents,
    pipelineCaches: parsePipelineCacheObservations(text),
    presentGaps,
    presentMode,
    presents,
    projections,
    slowPhases,
  };
}

const PROJECTION_TIMING_KEYS = ["compileMs", "reconcileMs", "lastReconcileMs", "maxReconcileMs"] as const;

/**
 * A projection line that carries timings must carry finite numbers for all of them.
 *
 * A string, a missing key or a non-object is a malformed meter, not an absent one: it would let
 * `NaN` reach a reader and read as a measurement. Rejected exactly as unparsable JSON is. A line
 * with no `timings` at all is an older runtime and stays absent, which the report names.
 */
function assertProjectionTimings(projection: IProjectionWindowJson): void {
  const timings: unknown = projection.timings;
  if (timings === undefined) return;
  if (typeof timings !== "object" || timings === null) {
    throw new Error(
      `TN_PERF_MARKER_MALFORMED: a TN_PROJECTION line carried a non-object timings (${JSON.stringify(timings)}).`,
    );
  }
  for (const key of PROJECTION_TIMING_KEYS) {
    const value = (timings as Record<string, unknown>)[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(
        `TN_PERF_MARKER_MALFORMED: a TN_PROJECTION line carried timings.${key} = ${JSON.stringify(value)} — a timing must be a finite number.`,
      );
    }
  }
}

function parseMarkerLine<T>(line: string, marker: string): T | undefined {
  const start = line.indexOf(marker);
  if (start === -1) return undefined;
  const json = line.slice(start + marker.length).trim();
  try {
    return JSON.parse(json) as T;
  } catch (error) {
    const name = marker.slice(0, -1);
    throw new Error(
      `TN_PERF_MARKER_MALFORMED: a ${name} line carried unparsable JSON (${json.slice(0, 80)}): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Apply the one-window-always-lies rule and any requested bounds. The first window of a multi-
 * window run is discarded as startup; bounds are checked against every steady window, because a
 * bound that passes on the median and fails on the steady tail is a failed bound. Fewer steady
 * windows than `requireWindows` is a `TN_PERF_WINDOWS_MISSING` violation — the run did not
 * produce enough evidence to assess, which is a failure, not an empty pass.
 */
export function assessPerfMarkers(
  parse: IPerfMarkerParse,
  bounds: IPerfBounds,
  source: string,
  display?: { readonly strategy: string; readonly virtual: boolean },
): IPerfReport {
  const discardCount = parse.budgets.length > 1 ? 1 : 0;
  const discardedWindows = parse.budgets.slice(0, discardCount).map(({ window }) => window);
  const steady = parse.budgets.slice(discardCount);
  const violations: IPerfViolation[] = [];
  /** Windows that counted presents but no present period long enough to carry a rate. */
  const unassessableWindows: number[] = [];
  // A frame rate from a private Xvfb is wrong, not missing: without vsync the present wait lands
  // inside the update phase, and the same package's `trace` measured 13.3 fps there against 57.7
  // on the real display from one build. So the number is never presented, and an fps bound is
  // refused rather than satisfied by it — 16,666 fps passed a 60 bound on midway's desktop build.
  // A log says for itself whether the loop's cadence reached the display: the host counts loop
  // frames and presents separately, and the presentation cap lets many frames pass between them.
  // Midway's native launch: 1740 frames, 133 presents, cap 60 Hz, beside a window reporting 2631
  // fps. That number is the loop's, not a player's, so it is not printed either.
  const tick = parse.presents.at(-1);
  const presentsRatio =
    tick === undefined || !Number.isFinite(tick.frames) || tick.frames <= 0 || !Number.isFinite(tick.presents)
      ? undefined
      : tick.presents / tick.frames;
  // A window that carries the display's own count has answered the question the tick ratio was
  // standing in for: its `presentedFps` is the rate a player saw, so nothing is suppressed.
  const windowsCarryPresents =
    parse.budgets.length > 0 && parse.budgets.every((window) => Number.isFinite(window.presents));
  const unvouchableBy = (): string | undefined => {
    if (windowsCarryPresents) return display?.virtual === true ? `a ${display.strategy} display` : undefined;
    if (presentsRatio !== undefined && presentsRatio < PRESENTS_REACHED_DISPLAY_RATIO) {
      return (
        `the host presented ${tick?.presents} of ${tick?.frames} loop frames` +
        (tick?.capHz === undefined ? "" : ` (cap ${tick.capHz} Hz)`)
      );
    }
    return display?.virtual === true ? `a ${display.strategy} display` : undefined;
  };
  const unvouchable = unvouchableBy();
  const virtualDisplay = unvouchable !== undefined && bounds.allowVirtualDisplay !== true;
  if (virtualDisplay && bounds.minFps !== undefined) {
    violations.push({ bound: bounds.minFps, code: "TN_PERF_VIRTUAL_DISPLAY", observed: undefined, window: -1 });
  }
  if (steady.length < bounds.requireWindows) {
    violations.push({ bound: bounds.requireWindows, code: "TN_PERF_WINDOWS_MISSING", observed: steady.length, window: -1 });
  }
  for (const window of steady) {
    if (bounds.maxFrameMsP95 !== undefined) {
      const frameP95 = window.frame?.p95;
      if (frameP95 === undefined) {
        violations.push({ bound: bounds.maxFrameMsP95, code: "TN_PERF_BOUNDS_NOT_ASSESSABLE", observed: undefined, window: window.window });
      } else if (frameP95 > bounds.maxFrameMsP95) {
        violations.push({ bound: bounds.maxFrameMsP95, code: "TN_PERF_MAX_FRAME_P95", observed: frameP95, window: window.window });
      }
    }
    // Only the frame-rate bound is unassessable here: a frame callback's own duration was still
    // measured, but the rate it was presented at was not.
    if (bounds.minFps !== undefined && !virtualDisplay) {
      // Three cases, and they are not the same fact: a window carrying the display's own rate is
      // assessed on it; a window that counted presents but none of them is too short to carry a
      // rate at all; a window with no present series is assessed on the loop's cadence, as before.
      const rate = window.presentedFps;
      if (rate !== undefined) {
        if (rate < bounds.minFps)
          violations.push({ bound: bounds.minFps, code: "TN_PERF_MIN_FPS", observed: rate, window: window.window });
      } else if (window.presents === undefined) {
        if (window.fps < bounds.minFps)
          violations.push({ bound: bounds.minFps, code: "TN_PERF_MIN_FPS", observed: window.fps, window: window.window });
      } else {
        unassessableWindows.push(window.window);
      }
    }
  }
  // Every steady window counted presents and none of them presented anything: the display's rate
  // was never measured in this run, so the bound is unassessable rather than passed. The same
  // fail-closed rule the frame summary already follows.
  if (
    unassessableWindows.length > 0 &&
    unassessableWindows.length === steady.length &&
    bounds.minFps !== undefined
  ) {
    violations.push({
      bound: bounds.minFps,
      code: "TN_PERF_BOUNDS_NOT_ASSESSABLE",
      observed: undefined,
      window: -1,
    });
  }
  return {
    budgets: parse.budgets,
    discardedWindows,
    ...(display !== undefined || unvouchable !== undefined
      ? {
          display: {
            fpsSuppressed: virtualDisplay,
            ...(unvouchable === undefined ? {} : { reason: unvouchable }),
            strategy: display?.strategy ?? "host",
            virtual: display?.virtual === true,
          },
        }
      : {}),
    hitches: parse.hitches,
    hostGaps: parse.hostGaps,
    presentGaps: parse.presentGaps,
    presents: parse.presents,
    pipelineEvents: parse.pipelineEvents,
    pipelineCaches: parse.pipelineCaches ?? [],
    pass: violations.length === 0 && parse.budgets.length > 0,
    presentMode: parse.presentMode,
    slowPhases: parse.slowPhases,
    projections: parse.projections,
    source,
    violations,
  };
}

export interface IPerfSources {
  executable?: string;
  file?: string;
  hostArgs: string[];
  logcatSerial?: string;
}

export function parsePerfArgs(argv: readonly string[]): IPerfArgs {
  const sources: IPerfSources = { hostArgs: [] };
  const bounds: { allowVirtualDisplay?: boolean; maxFrameMsP95?: number; minFps?: number; requireWindows: number } = {
    requireWindows: 2,
  };
  let text = false;
  let timeoutSeconds = 180;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--text") text = true;
    else if (flag === "--allow-virtual-display") bounds.allowVirtualDisplay = true;
    else if (flag === "--file") { sources.file = requireValue(flag, value); index += 1; }
    else if (flag === "--executable") { sources.executable = requireValue(flag, value); index += 1; }
    else if (flag === "--host-arg") { sources.hostArgs.push(requireValue(flag, value)); index += 1; }
    else if (flag === "--logcat") { sources.logcatSerial = requireValue(flag, value); index += 1; }
    else if (flag === "--max-frame-p95") { bounds.maxFrameMsP95 = requireNumber(flag, value); index += 1; }
    else if (flag === "--min-fps") { bounds.minFps = requireNumber(flag, value); index += 1; }
    else if (flag === "--require-windows") { bounds.requireWindows = requireNumber(flag, value); index += 1; }
    else if (flag === "--timeout") { timeoutSeconds = requireNumber(flag, value); index += 1; }
    else throw new PlaytestCliUsageError(`threenative-playtest perf: unknown flag '${flag}'. See threenative-playtest --help.`);
  }
  const named = [sources.file !== undefined, sources.executable !== undefined, sources.logcatSerial !== undefined]
    .filter(Boolean).length;
  if (named === 0) {
    throw new PlaytestCliUsageError(
      "threenative-playtest perf: name one source — --file <log>, --executable <host binary> (+ repeatable --host-arg), or --logcat <serial>.",
    );
  }
  if (named > 1) {
    throw new PlaytestCliUsageError("threenative-playtest perf: --file, --executable and --logcat are mutually exclusive.");
  }
  return {
    allowVirtualDisplay: bounds.allowVirtualDisplay === true,
    executable: sources.executable,
    file: sources.file,
    hostArgs: sources.hostArgs,
    logcatSerial: sources.logcatSerial,
    maxFrameMsP95: bounds.maxFrameMsP95,
    minFps: bounds.minFps,
    requireWindows: bounds.requireWindows,
    text,
    timeoutSeconds,
  };
}

function requireValue(flag: string, value: string | undefined): string {
  if (value === undefined) throw new PlaytestCliUsageError(`threenative-playtest perf: ${flag} needs a value.`);
  return value;
}

function requireNumber(flag: string, value: string | undefined): number {
  const parsed = Number(value);
  if (value === undefined || value.trim() === "" || Number.isNaN(parsed)) {
    throw new PlaytestCliUsageError(`threenative-playtest perf: ${flag} needs a number, received '${value ?? ""}'.`);
  }
  return parsed;
}

export async function perfCommand(argv: readonly string[]): Promise<number> {
  const args = parsePerfArgs(argv);
  try {
    if (args.file !== undefined) {
      const path = resolve(args.file);
      return emit(parsePerformanceMarkers(await readFile(path, "utf8")), args, `file: ${path}`);
    }
    if (args.logcatSerial !== undefined) {
      return emit(parsePerformanceMarkers(await readLogcat(args.logcatSerial)), args, `logcat: ${args.logcatSerial}`);
    }
    if (args.executable !== undefined) {
      return await runExecutable(args, args.executable);
    }
  } catch (error) {
    if (error instanceof PlaytestCliUsageError) throw error;
    // A source that cannot be read, or a marker that cannot be parsed, is the finding. Report it
    // as the command's failure with its TN_PERF_ code — never as a stack trace, never as an
    // empty success.
    const message = error instanceof Error ? error.message : String(error);
    const namedFailure = message.startsWith("TN_PERF_") || message.startsWith("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE:");
    const code = namedFailure ? (message.split(":")[0] ?? "TN_PERF_SOURCE_UNREADABLE") : "TN_PERF_SOURCE_UNREADABLE";
    process.stderr.write(`${JSON.stringify({ diagnostics: [{ code, message, severity: "error" }], pass: false }, null, 2)}\n`);
    process.exitCode = 2;
    return 2;
  }
  throw new PlaytestCliUsageError("threenative-playtest perf: no source named.");
}

/** Spawn the host, collect its output, and stop once enough windows have closed. */
async function runExecutable(args: IPerfArgs, executable: string): Promise<number> {
  const source = `executable: ${[executable, ...args.hostArgs].join(" ")}`;
  // The same decision every other lane makes: the operator asked for the host display or this run
  // paints on a private one. A run that owns its Xvfb cannot report a frame rate from it.
  const strategy = decideDisplayStrategy({ env: process.env, platform: process.platform });
  const child = spawn(executable, args.hostArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let collected = "";
  let stopped = false;
  let spawnFailed = false;
  // The first window is discarded as startup, so a complete run closes requireWindows + 1.
  const enoughWindows = (): boolean =>
    collected.split(FRAME_BUDGET_MARKER).length - 1 >= args.requireWindows + 1;
  const stop = (): void => {
    if (!stopped) {
      stopped = true;
      child.kill("SIGTERM");
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    collected += chunk.toString("utf8");
    if (enoughWindows()) stop();
  });
  child.stderr.on("data", (chunk: Buffer) => { collected += chunk.toString("utf8"); });
  const timeout = setTimeout(stop, args.timeoutSeconds * 1000);
  return new Promise<number>((settleExit) => {
    child.on("error", (error) => {
      spawnFailed = true;
      clearTimeout(timeout);
      const message = `TN_PERF_SOURCE_UNREADABLE: could not spawn ${executable}: ${error.message}`;
      process.stderr.write(`${JSON.stringify({ diagnostics: [{ code: "TN_PERF_SOURCE_UNREADABLE", message, severity: "error" }], pass: false }, null, 2)}\n`);
      process.exitCode = 2;
      settleExit(2);
    });
    // Wait for 'close', not 'exit'. Close fires after the pipes end, so every marker is read.
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      if (spawnFailed) return;
      const exitCode = emit(
        parsePerformanceMarkers(collected),
        args,
        source,
        { strategy: strategy.kind, virtual: strategy.kind === "private-xvfb" },
        hostFailureStatus(code, signal, stopped),
      );
      process.exitCode = exitCode;
      settleExit(exitCode);
    });
  });
}

async function readLogcat(serial: string): Promise<string> {
  const execFileAsync = promisify(execFile);
  const { stdout } = await execFileAsync(discoverAdb(), ["-s", serial, "logcat", "-d", "-v", "brief"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return newestProcessLines(stdout);
}

/**
 * Keep the lines of the process that wrote the newest marker. Logcat holds earlier launches until
 * its buffer rolls over, and each launch has its own PID. Those older lines are stale, not this run.
 * ponytail: a relaunch that has not written a window yet still reads the previous PID's windows.
 */
export function newestProcessLines(text: string): string {
  const lines = text.split("\n");
  const newest = [...lines].reverse().find((line) => line.includes(FRAME_BUDGET_MARKER));
  const pid = newest === undefined ? undefined : logcatPid(newest);
  if (pid === undefined) return text;
  return lines.filter((line) => logcatPid(line) === undefined || logcatPid(line) === pid).join("\n");
}

/** The PID in a brief-format header, such as `I/MystralStdio( 4321): message`. */
function logcatPid(line: string): string | undefined {
  return /\(\s*(\d+)\)/u.exec(line)?.[1];
}

/**
 * The host's failure status, or undefined when it stopped on its own terms. A signal reads as the
 * shell status 128 plus its number, so a SIGSEGV is 139. Our own SIGTERM after enough windows is a
 * normal stop.
 * ponytail: a host that dies from the default SIGTERM action reads as our stop. A host that catches
 * SIGTERM and exits non-zero is judged on its status.
 */
function hostFailureStatus(code: number | null, signal: NodeJS.Signals | null, stoppedByUs: boolean): number | undefined {
  if (code === 0 || (code === null && signal === "SIGTERM" && stoppedByUs)) return undefined;
  if (code !== null) return code;
  return signal === null ? 128 : 128 + osConstants.signals[signal];
}

function emit(
  parse: IPerfMarkerParse,
  args: IPerfArgs,
  source: string,
  display?: { readonly strategy: string; readonly virtual: boolean },
  hostStatus?: number,
): number {
  const assessed = assessPerfMarkers(parse, args, source, display);
  // A host that failed on its own fails the run, whatever its markers say.
  const report: IPerfReport = hostStatus === undefined ? assessed : {
    ...assessed,
    pass: false,
    violations: [...assessed.violations, { bound: 0, code: "TN_PERF_HOST_EXIT", observed: hostStatus, window: -1 }],
  };
  const windowsMissing = report.violations.some(({ code }) => code === "TN_PERF_WINDOWS_MISSING");
  const exitCode: 0 | 1 | 2 = windowsMissing ? 2 : report.pass ? 0 : 1;
  process.stdout.write(args.text ? formatPerfReport(report) : `${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = exitCode;
  return exitCode;
}


function describeSuppression(report: IPerfReport): string {
  const reason = report.display?.reason;
  if (reason !== undefined) {
    return reason.startsWith("the host presented")
      ? `${reason} — the loop's cadence, not the display's`
      : `this run painted on ${reason}, where the present wait lands inside the update phase`;
  }
  return "this run's frame rate could not be vouched for";
}

export function formatPerfReport(report: IPerfReport): string {
  const lines: string[] = [`perf — ${report.budgets.length} window(s) from ${report.source}`];
  lines.push(formatPipelineCacheObservations(report.pipelineCaches ?? []));
  const pipelineEvents = report.pipelineEvents ?? [];
  if (pipelineEvents.length > 0) {
    const serviceMs = pipelineEvents.reduce((sum, event) => sum + (event.serviceMs ?? 0), 0);
    const wallMs = pipelineEvents.reduce((sum, event) => sum + (event.wallMs ?? event.serviceMs ?? 0), 0);
    lines.push(
      `pipeline events: ${pipelineEvents.length} observed, ${serviceMs.toFixed(3)} ms summed service, ` +
        `${wallMs.toFixed(3)} ms summed wall (overlap may make wall lower)`,
    );
  } else {
    lines.push("pipeline events: not reported — this log cannot attribute shader compilation");
  }
  if (report.presentMode !== undefined) lines.push(`present mode: ${report.presentMode}`);
  // Reported once, from the last window, next to the fps it explains. Named as unreported when
  // absent rather than left off: a reader who sees no scale line must not assume a full-resolution
  // single-sample frame, which is exactly how a perf record and its tree came to disagree.
  const surface = report.budgets.at(-1)?.surface;
  lines.push(
    surface === undefined
      ? "surface: unreported — this fps does not say what resolution or sampling produced it"
      : `surface: scale ${surface.resolutionScale} ${surface.scaleSource}, ` +
        `${surface.drawingBufferWidth}x${surface.drawingBufferHeight}, ${surface.sampleCount}x samples` +
        (surface.compiling === undefined
          ? ""
          : surface.compiling
            ? ", compile pending"
            : ", compile idle") +
        // At the floor the scaler has no room left and the target is still missed. Saying only
        // the scale here would read as a budget met at a low resolution.
        (surface.atFloor === true ? " — AT FLOOR, budget not met" : ""),
  );
  const anyGpu = report.budgets.some((window) => window.gpuMs !== undefined);
  // The meter reports nothing rather than zero when it cannot measure, so a missing GPU column has
  // to say *why*. A blank one reads as "the GPU cost nothing", which is the opposite of the truth
  // and is how a phone's GPU time went unattributed for months.
  if (!anyGpu && report.budgets.length > 0) {
    lines.push(
      "gpu: not reported — the meter emits nothing rather than zero when the device did not grant " +
        "'timestamp-query'. Check the TN_WEBGPU_FEATURES line in the same log for what it did grant.",
    );
  }
  const fpsSuppressed = report.display?.fpsSuppressed === true;
  if (fpsSuppressed) {
    // Named, never blank: a missing column reads as a zero, and the number it would have carried is
    // not zero — it is wrong. The phase rows below are unaffected and are what the native lane's
    // baselines quote.
    lines.push(
      `fps suppressed: ${describeSuppression(report)}, so the frame rate is not the one a player ` +
        "would read. The phase rows below are unaffected. Rerun on the host display with " +
        "TN_PLAYTEST_HOST_DISPLAY=1 for a quotable frame rate, or pass --allow-virtual-display to " +
        "accept the phase timings with it.",
    );
  }
  lines.push(
    `window  ${fpsSuppressed ? "        " : "fps     "}frame p50/p95    render p50/p95   hostGap p50/p95${anyGpu ? "  gpu ms" : ""}`,
  );
  for (const window of report.budgets) {
    const label = report.discardedWindows.includes(window.window) ? `${window.window}*` : String(window.window);
    lines.push(
      [
        label.padEnd(7),
        fpsSuppressed
          ? "".padEnd(7)
          : (window.presentedFps ?? (window.presents === 0 ? 0 : window.fps)).toFixed(2).padEnd(7),
        summary(window.frame).padEnd(16),
        summary(window.phases?.render).padEnd(16),
        summary(window.phases?.hostGap),
        // "unmeasured" rather than a dash: a dash in a column of numbers reads as a zero, and this
        // one window may be the only one the device refused.
        ...(anyGpu
          ? [` ${window.gpuMs === undefined ? "unmeasured" : window.gpuMs.toFixed(2)}`]
          : []),
      ].join(" "),
    );
  }
  if (report.discardedWindows.length > 0) lines.push("* discarded as startup (window 1 always lies)");
  lines.push(...formatMainPassTriangles(report.budgets));
  // A zero in the fps column is true and easy to misread as a frozen game: name the windows where
  // the display simply showed nothing in a window of loop frames too short to contain a present.
  const presentedNothing = report.budgets.filter((window) => window.presents === 0);
  if (presentedNothing.length > 0) {
    lines.push(
      `windows ${presentedNothing.map((window) => window.window).join(", ")} presented nothing in their loop frames: ` +
        "too short to contain a present, so their frame rate is unmeasured rather than zero",
    );
  }
  lines.push(...formatDrawSources(report.budgets));
  lines.push(...formatProjection(report.projections));
  const lastGap = report.hostGaps.at(-1);
  if (lastGap !== undefined) {
    lines.push(`host gap segments (${lastGap.frames}-frame window, p50 ms):`);
    for (const [name, segment] of Object.entries(lastGap.segments).sort(([, a], [, b]) => b.p50Ms - a.p50Ms)) {
      lines.push(`  ${name.padEnd(16)}${segment.p50Ms.toFixed(3)}`);
    }
  }
  lines.push(...formatHitches(report.hitches, report.presentGaps, report.slowPhases));
  for (const violation of report.violations) {
    const observed = violation.observed === undefined ? "absent" : round(violation.observed).toString();
    lines.push(`FAIL ${violation.code}: window ${violation.window} observed ${observed} against bound ${violation.bound}`);
  }
  if (report.pass) lines.push("PASS");
  return `${lines.join("\n")}\n`;
}

/**
 * The main pass's triangle count, from the last window, and which of the two figures it is.
 *
 * Three counts a draw as `instanceCount * count / 3`, and for an indirect batch `count` is the
 * merged geometry's capacity rather than what the GPU selected — a streamed world read 338 million
 * triangles for 402 thousand actually drawn. The GPU figure is the one worth acting on, so it wins
 * when it is there and the CPU figure is named as the ceiling it is. A window that submitted no main
 * pass says so rather than printing a zero.
 */
function formatMainPassTriangles(windows: readonly IFrameBudgetWindowJson[]): string[] {
  const main = windows.at(-1)?.passes?.main;
  if (main?.triangles === undefined) return [];
  const capacity = Math.round(main.triangles.p50).toLocaleString("en-US");
  if (main.gpuTriangles === undefined)
    return [`main pass triangles: ${capacity} (three's CPU capacity figure; the GPU-selected count was not reported)`];
  return [
    `main pass triangles: ${main.gpuTriangles.toLocaleString("en-US")} GPU-selected, ` +
      `${capacity} CPU capacity`,
  ];
}


/**
 * Where the main pass's draws came from, from the last window that reported the split (PRD-494).
 *
 * One line, ranked largest first, because the question this answers is which origin owns the pass —
 * GPU-scene keys, the world's bundle, terrain tiles, proxies, or the meshes no world system claimed.
 * A run whose runtime predates the field is named as unreported rather than printed as an empty
 * ranking, which would read as a measured "nothing was drawn from anywhere".
 */
function formatDrawSources(windows: readonly IFrameBudgetWindowJson[]): string[] {
  const last = [...windows].reverse().find((window) => window.passes?.main?.drawsBySource !== undefined);
  const bySource = last?.passes?.main?.drawsBySource;
  if (last === undefined || bySource === undefined)
    return ["main-pass draws by source: not reported — this runtime predates the per-source split"];
  const ranked = Object.entries(bySource).sort(([, left], [, right]) => right.p50 - left.p50);
  const draws = last.passes?.main?.draws?.p50;
  return [
    `main-pass draws by source, window ${String(last.window)} p50: ` +
      ranked.map(([source, sourceSummary]) => `${source} ${sourceSummary.p50.toFixed(0)}`).join(", ") +
      (draws === undefined ? "" : ` — ${draws.toFixed(0)} draws in the pass`),
  ];
}

/**
 * The scene projection, from the last window, ranked by what each exact-lane reason costs.
 *
 * Says "not reported" rather than printing an empty table when the marker is absent: a reader who
 * sees no projection section must not conclude the exact lane was empty, which is how an
 * unmeasured lane comes to be described as a measured zero.
 */
function formatProjection(windows: readonly IProjectionWindowJson[]): string[] {
  const last = windows.at(-1);
  if (last === undefined) {
    return ["scene projection: not reported — this run does not say what it drew one-at-a-time"];
  }
  const measured =
    last.drawsActual === undefined
      ? "unmeasured"
      : `${last.drawsActual}${last.drawsActual === last.drawsPlanned ? "" : " (all passes; the plan counts the colour pass only)"}`;
  const lines = [
    last.projecting
      ? `scene projection: on (${last.reasonCode}); ${last.sourceRenderables} authored renderables, ` +
        `${last.drawsPlanned} draws planned, ${measured} actual`
      : `scene projection: DECLINED (${last.reasonCode})${last.reason === undefined ? "" : ` — ${last.reason}`}; ` +
        `${last.sourceRenderables} authored renderables drawn one at a time`,
  ];
  // The per-frame attribution term this section exists for. A line from a runtime older than the
  // field is named as unreported rather than omitted: a reader who sees no reconcile number must
  // not conclude the projection reconciled for free.
  lines.push(
    last.timings === undefined
      ? "  reconcile: unreported — this TN_PROJECTION line predates the timing field"
      : `  reconcile: ${last.timings.lastReconcileMs.toFixed(3)} ms last frame, ` +
        `${last.timings.reconcileMs.toFixed(3)} ms cumulative, ${last.timings.maxReconcileMs.toFixed(3)} ms worst`,
  );
  const ranked = rankExactReasons(last.exact);
  if (last.exactObjects > 0 && ranked.length === 0) {
    lines.push(
      `  ${last.exactObjects} object(s) on the exact lane with no reason recorded — that is a bug in the reporter, not an empty lane`,
    );
    return lines;
  }
  if (ranked.length === 0) return lines;
  lines.push(`  exact lane, ${last.exactObjects} draw(s), by reason:`);
  for (const { count, reason } of ranked) lines.push(`    ${reason.padEnd(22)}${count}`);
  return lines;
}

function summary(summaryValue: IPerfSummary | undefined): string {
  return summaryValue === undefined ? "—" : `${summaryValue.p50.toFixed(1)}/${summaryValue.p95.toFixed(1)}`;
}

/**
 * The native host's post-launch hitch windows, with the late sync compile named when one happened.
 *
 * A window whose payload carries a nonzero `pipelineCompile` is a material that appeared mid-game
 * and compiled synchronously inside a frame — the anonymous 200 ms spike this section exists to
 * name. A host older than the field omits it and is named as such rather than read as a zero,
 * which is the same rule the gpu column follows.
 */
/**
 * The two `TN_FRAME_HITCH` series, reported as what each one measured.
 *
 * A window is the host's distribution over its first 300 presented frames; a present gap is one
 * frame the JS budget found more than `hitchMs` after the last. Folding the second into the first
 * printed `worst NaN ms` beside a note blaming an older host, and threw away the only record of a
 * multi-second stall the launch had.
 */

/**
 * Which of the host's slow phases fall inside a present gap, innermost first.
 *
 * A gap spans `[uptimeMs - gapMs, uptimeMs]` — the budget notices at a present that the last one was
 * that long ago. A phase spans `[atMs - ms, atMs]`, its `atMs` being the end. The host's outermost
 * watcher brackets a whole iteration and therefore *contains* the phases inside it, so a containing
 * phase is dropped whenever it also overlaps a phase it contains: naming `pollEvents` for a stall
 * the host itself attributed to `imageDecodeDrain` would be the same empty answer as naming nothing.
 */
export function phasesWithinGap(
  gap: IPresentGapJson,
  slowPhases: readonly ISlowPhaseJson[],
): ISlowPhaseJson[] {
  const start = gap.uptimeMs - gap.gapMs;
  const overlapping = slowPhases.filter(
    (phase) => phase.atMs > start && phase.atMs - phase.ms < gap.uptimeMs,
  );
  const innermost = overlapping.filter(
    (candidate) =>
      !overlapping.some(
        (other) =>
          other !== candidate &&
          other.atMs <= candidate.atMs &&
          other.atMs - other.ms >= candidate.atMs - candidate.ms,
      ),
  );
  const reportable = innermost.length > 0 ? innermost : overlapping;
  return [...reportable].sort((left, right) => right.ms - left.ms).slice(0, 3);
}

function describeGap(gap: IPresentGapJson, slowPhases: readonly ISlowPhaseJson[]): string {
  const phases = phasesWithinGap(gap, slowPhases);
  if (phases.length === 0) {
    return slowPhases.length === 0
      ? "no slow phase reported in this log"
      : "no slow phase fell inside it";
  }
  return phases.map((phase) => `${phase.phase} ${phase.ms.toFixed(3)} ms`).join(", ");
}

function formatHitches(
  hitches: readonly IHitchWindowJson[],
  presentGaps: readonly IPresentGapJson[] = [],
  slowPhases: readonly ISlowPhaseJson[] = [],
): string[] {
  const lines: string[] = [];
  if (presentGaps.length > 0) {
    const worst = Math.max(...presentGaps.map((gap) => gap.gapMs));
    const at = presentGaps.reduce((best, gap) => (gap.gapMs >= best.gapMs ? gap : best));
    lines.push(
      `present gaps (${presentGaps.length}): worst ${worst.toFixed(3)} ms at uptime ${at.uptimeMs.toFixed(0)} ms` +
        ` — one frame each, reported by the frame budget's own hitch threshold`,
    );
    // The host watched the phases either side of those gaps and said so in another marker. Joining
    // them is the difference between "3000 ms" and "3000 ms, and it was the image decode" — the
    // engine's own stall report exists because a stall that names nothing is nobody's to fix.
    for (const gap of presentGaps) lines.push(`  gap ${gap.gapMs.toFixed(3)} ms at uptime ${gap.uptimeMs.toFixed(0)} ms: ${describeGap(gap, slowPhases)}`);
  }
  if (hitches.length === 0) return lines;
  const windows = `hitch windows (post-launch, ${hitches.length}): worst ${Math.max(...hitches.map((h) => h.maxMs)).toFixed(3)} ms`;
  lines.push(windows);
  const named = hitches.filter((hitch) => (hitch.pipelineCompileCalls ?? 0) > 0);
  if (named.length === 0) {
    // A missing field and a measured zero are different facts: the first means the host predates
    // the attribution, the second means no late compile happened. Never merge them into one line.
    const anyField = hitches.some((hitch) => hitch.pipelineCompileCalls !== undefined);
    lines.push(
      anyField
        ? "  late sync compile: none — every window reported pipelineCompileCalls 0"
        : "  late sync compile: unreported — this host predates the pipelineCompile fields (TN_FRAME_HITCH without them)",
    );
    return lines;
  }
  for (const hitch of named) {
    lines.push(
      `  late sync compile: ${hitch.pipelineCompileMs?.toFixed(3) ?? "unreported"} ms across ` +
        `${hitch.pipelineCompileCalls} call(s) in the window whose worst frame landed at ` +
        `frame ${hitch.maxAtFrame}`,
    );
  }
  return lines;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
