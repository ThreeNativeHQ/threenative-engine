/**
 * The engine telling the agent that built the scene what a human would otherwise find by playing.
 *
 * A scene reached 1,815 triangles per draw with its GPU ten times under budget and nobody knew,
 * because the census and the phase split are measured every frame and nothing reads them. The
 * frame already carries the shape: how many objects the cull considered, how many draws each pass
 * submitted, how many casters are exempt, and what share of the frame the GPU actually used. This
 * turns those numbers into a verdict, once per reported window.
 *
 * **The rule is derived, never a constant an author is told to revisit.** It fires when
 *
 *  - the GPU used less than a third of the frame — the device is not the constraint, and
 *  - the JS render phase alone, in the typical (median) frame, is longer than the display's own
 *    period — so the scene cannot make the display's rate even if everything else in the frame
 *    were free.
 *
 * Both numbers come from the frame meter. The display's period comes from the host's own
 * presentation cap where there is one, and otherwise from the frame rate the game itself declared;
 * no third source is invented, and a launch that can name neither gets no verdict rather than a
 * guessed one.
 *
 * It is silent on an honestly GPU-bound scene with the same draw count, which is the property that
 * makes it worth reading: a warning that fires on every heavy scene is a warning nobody reads.
 */

import type { IFrameBudgetWindow } from "../frame-budget.js";
import type { IRenderCameraCullReport } from "../render-camera-cull.js";
import type { FramePassKind } from "../render-pass-budget.js";

/** Marker printed at most once per reported window. */
export const SCENE_WARNING_MARKER = "TN_SCENE_WARNING";

/** The GPU share below which the device is not what the frame is waiting for. */
const GPU_IDLE_SHARE = 1 / 3;

/**
 * What the frame already knows about the scene's shape.
 *
 * Every field is a count the engine measures anyway — the projection's cull census and the render
 * pass budget — so the warning adds a reading, never a measurement.
 */
export interface ISceneShape {
  /** Objects the projected-size cull looked at this window. */
  readonly objectsConsidered: number;
  /** Objects it hid. */
  readonly culled: number;
  /** Objects exempt from the gate because they cast shadows. */
  readonly shadowExemptCasters: number;
  /** Draws submitted per pass kind, from the render pass budget. */
  readonly draws: Readonly<Partial<Record<FramePassKind, number>>>;
  /** Triangles per draw across every pass; the number a merge or an atlas moves. */
  readonly trianglesPerDraw: number;
}

/** The verdict, and the shape behind it. */
export interface ISceneWarning {
  readonly window: number;
  /** The GPU's share of the frame, as a fraction. */
  readonly gpuShare: number;
  /** The JS render phase's median, in milliseconds. */
  readonly renderMs: number;
  /** The period the display works at, in milliseconds, and where that number came from. */
  readonly displayPeriodMs: number;
  readonly displaySource: "host-cap" | "declared-target";
  /** The largest thing the CPU describes every frame, and its share of the terms compared. */
  readonly dominantTerm: string;
  readonly dominantShare: number;
  readonly shape: ISceneShape;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The display's own period, in milliseconds, or `undefined` when nothing can say.
 *
 * The host's presentation cap first, because on a native launch that is literally the rate frames
 * reach the display at. A browser has no refresh-rate API, so the rate the game declared is the
 * only honest second source — and it is the same number the resolution scaler already judges
 * against, not a new one.
 */
export function displayPeriodMs(
  declaredTargetFps: number | undefined,
): { ms: number; source: ISceneWarning["displaySource"] } | undefined {
  const host = globalThis as { __tnPresentationCap?: unknown };
  if (typeof host.__tnPresentationCap === "function") {
    const capped: unknown = host.__tnPresentationCap();
    if (typeof capped === "number" && Number.isFinite(capped) && capped > 0)
      return { ms: 1_000 / capped, source: "host-cap" };
  }
  if (
    declaredTargetFps !== undefined &&
    Number.isFinite(declaredTargetFps) &&
    declaredTargetFps > 0
  )
    return { ms: 1_000 / declaredTargetFps, source: "declared-target" };
  return undefined;
}

/**
 * The verdict for one reported window, or `undefined` when the frame does not earn one.
 *
 * Fails closed in both directions: a window whose GPU was never measured gets no verdict, because
 * "the GPU is idle" is a claim and an absent reading is not evidence for it; and a window with no
 * shape to report gets none either, because a warning that cannot say what to change is noise.
 * A software adapter gets none: its rasteriser runs inside the CPU's submit, so the render phase
 * carries the GPU's work and "the GPU is idle" is false (a 3-draw UI frame read 54 ms on
 * `Microsoft Basic Render Driver`).
 */
export function sceneWarning(
  window: IFrameBudgetWindow,
  shape: ISceneShape | undefined,
  declaredTargetFps: number | undefined,
  gpuClass?: string,
): ISceneWarning | undefined {
  if (shape === undefined || gpuClass === "software") return undefined;
  const gpuMs = window.gpu?.mean;
  const frameMs = window.presented.mean;
  if (gpuMs === undefined || !(frameMs > 0)) return undefined;
  const gpuShare = gpuMs / frameMs;
  if (gpuShare >= GPU_IDLE_SHARE) return undefined;
  const period = displayPeriodMs(declaredTargetFps);
  if (period === undefined) return undefined;
  // The median, not the mean: this verdict is about the scene's shape, which every frame pays. A
  // single first-use compile in a short window lifts the mean past the period and says nothing about
  // the scene (TN_FRAME_HITCH and the frame bounds report that stall).
  const renderMs = window.phases.render.p50;
  if (renderMs <= period.ms) return undefined;

  // The terms are the things the CPU describes once per frame. They are counts, not milliseconds,
  // and the record says so: the point is to name what to reduce, and the phase split beside it
  // already says how much a reduction is worth.
  const terms: readonly { term: string; count: number }[] = [
    { count: shape.objectsConsidered, term: "objectsConsidered" },
    { count: shape.draws.shadow ?? 0, term: "shadowDraws" },
    { count: shape.draws.main ?? 0, term: "mainDraws" },
    { count: shape.draws.reflection ?? 0, term: "reflectionDraws" },
  ];
  let dominant = terms[0] ?? { count: 0, term: "objectsConsidered" };
  let total = 0;
  for (const candidate of terms) {
    total += candidate.count;
    if (candidate.count > dominant.count) dominant = candidate;
  }
  return {
    displayPeriodMs: round(period.ms),
    displaySource: period.source,
    dominantShare: total > 0 ? round(dominant.count / total) : 0,
    dominantTerm: dominant.term,
    gpuShare: round(gpuShare),
    renderMs: round(renderMs),
    shape,
    window: window.window,
  };
}

/**
 * The scene's shape for one window, from the counts the frame already reported.
 *
 * `undefined` when the window carries no pass split: without draws there is nothing to name, and
 * a verdict built on an absent census would be a sentence about a scene nobody measured.
 */
export function describeSceneShape(
  window: IFrameBudgetWindow,
  cull: IRenderCameraCullReport | undefined,
): ISceneShape | undefined {
  const passes = window.passes;
  if (passes === undefined) return undefined;
  const draws: Partial<Record<FramePassKind, number>> = {};
  let totalDraws = 0;
  let totalTriangles = 0;
  for (const [kind, summary] of Object.entries(passes)) {
    if (summary === undefined) continue;
    draws[kind as FramePassKind] = Math.round(summary.draws.mean);
    totalDraws += summary.draws.mean;
    totalTriangles += summary.triangles.mean;
  }
  if (totalDraws <= 0) return undefined;
  return {
    culled: cull?.culled ?? 0,
    draws,
    objectsConsidered: cull?.considered ?? 0,
    shadowExemptCasters: cull?.exemptShadowCasters ?? 0,
    trianglesPerDraw: Math.round(totalTriangles / totalDraws),
  };
}

/** The one-line summary a reader sees without opening a log viewer. */
export function describeSceneWarning(warning: ISceneWarning): string {
  const gpuPercent = Math.round(warning.gpuShare * 100);
  return `the GPU used ${gpuPercent}% of the frame while the render phase took ${warning.renderMs} ms against a ${warning.displayPeriodMs} ms display period; ${warning.dominantTerm} is the largest term at ${warning.shape.trianglesPerDraw} triangles per draw`;
}

/** The marker line. */
export function formatSceneWarning(warning: ISceneWarning): string {
  return `${SCENE_WARNING_MARKER}:${JSON.stringify(warning)}`;
}
