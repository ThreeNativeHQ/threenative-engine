import { type IStageGpuReading, stageGpuReading } from "../render-pass-budget.js";
import { BudgetLadder, type IBudgetWindow } from "./budget-ladder.js";

/** `TN_GI` lines carry one report as JSON. */
export const GI_MARKER = "TN_GI";

/**
 * The ways a game gathers bounce light, from the cheapest to the dearest. The names follow Unreal's
 * `r.Lumen.FinalGatherMethod` and the three levels of `sg.GlobalIlluminationQuality` the tiers map to.
 */
export const GI_METHODS = ["none", "irradianceField", "screenProbeGather"] as const;

export type GIMethod = (typeof GI_METHODS)[number];

/** `sg.GlobalIlluminationQuality` of the Unreal level each method follows (Low, Medium, Epic). */
const UNREAL_QUALITY: Readonly<Record<GIMethod, 0 | 1 | 3>> = {
  irradianceField: 1,
  none: 0,
  screenProbeGather: 3,
};

export interface IGIBudgetReport {
  /** The method the game runs. It never changes while the game runs, as in Unreal. */
  readonly finalGatherMethod: GIMethod;
  /** Read-only: the `sg.GlobalIlluminationQuality` the method follows. */
  readonly globalIlluminationQuality: 0 | 1 | 3;
  /** The quality tier the game started at, when it named one. */
  readonly tier: string | undefined;
  /** Mean GI-stage GPU milliseconds over the window, or `undefined` when no frame resolved. */
  readonly windowMs: number | undefined;
  /** Mean whole-frame GPU milliseconds over the window. */
  readonly frameMs: number | undefined;
  /** The GI stage's share of the GPU frame, or `undefined` when either reading is missing. */
  readonly share: number | undefined;
  /** The frame period the frame is compared with. */
  readonly periodMs: number;
  /** The frame period less its headroom. */
  readonly targetMs: number;
  /** Resolved whole-frame readings in the window. */
  readonly samples: number;
  /** 1 for the first window the watcher closes, so a reader can skip the warm-up window. */
  readonly window: number;
  /** Which of the named `stages` resolved in the window. Empty when a stage name is wrong: that reads as 0 ms. */
  readonly stagesSeen: readonly string[];
  /** Every nested pass name that resolved in the window, to find the name a stage goes by. */
  readonly passes: readonly string[];
  /** `over` when the frame mean is above the target. The primary resolution scale is the lever, not the method. */
  readonly verdict: "over" | "within" | "unobserved";
  readonly reason: string;
}

export interface IGIBudgetOptions {
  /** The method the game runs: the tier's `finalGatherMethod`. */
  readonly method: GIMethod;
  /** Names of the render passes that are GI work (three names its passes by scene, such as `SSGI`). */
  readonly stages: readonly string[];
  /** The frame period in milliseconds, such as 1000 / 60. The whole GPU frame is compared with it. */
  readonly framePeriodMs: number;
  /** The quality tier the method came from, for the report. */
  readonly tier?: string;
  /** Frames per window. Default 120. */
  readonly windowFrames?: number;
  /** Where `TN_GI` lines go. Default `console.info`. */
  readonly report?: (line: string) => void;
  /** Reads a renderer's newest stage reading. Default `stageGpuReading`; a test supplies its own. */
  readonly read?: (renderer: unknown) => IStageGpuReading | undefined;
}

/**
 * Reports what a game's global illumination costs against the frame period. The method holds its
 * scalability level while the game runs, as Unreal's Lumen does: no Lumen file declares a run-time
 * budget (`sg.GlobalIlluminationQuality` comes from the benchmark or the device profile). A frame
 * over its period gets cheaper through the primary resolution scale (`ResolutionScaler`), and the
 * GI pass follows the lower resolution.
 *
 * This reads the GPU time of the passes the game names, once per resolved frame. A window of frames
 * (120 by default) reports the GI share of the whole GPU frame and whether the frame fits its
 * period less 10% headroom (`FrameTimeBudget`). An adapter without timestamp queries resolves no
 * frame, so the window is reported unobserved.
 *
 * @situation global illumination costs too much on a weak GPU
 * @situation see what share of the GPU frame the bounce light takes
 * @situation quality tier for indirect lighting that follows the hardware
 * @constraint the method never changes while the game runs: the primary resolution scale is the run-time lever
 * @constraint the GPU time of a pass is read by the scene name three or the game gave it, so name every GI pass in `stages`
 * @constraint timestamp queries are needed: without them every window is unobserved
 * @alias lumen scalability
 * @alias sg.GlobalIlluminationQuality
 * @alias final gather method
 * @example
 * const gi = new GIBudget({ method: "screenProbeGather", stages: ["SSGI"], framePeriodMs: 1000 / 60 });
 * ctx.beforeRender(() => gi.observeRenderer(ctx.renderer.raw));
 */
export class GIBudget {
  readonly #ladder: BudgetLadder<GIMethod>;
  readonly #options: IGIBudgetOptions;
  readonly #read: (renderer: unknown) => IStageGpuReading | undefined;
  #lastFrame = -1;
  readonly #seen = new Set<string>();
  readonly #passes = new Set<string>();
  #last: IGIBudgetReport | undefined;
  #lastVerdict: string | undefined;

  constructor(options: IGIBudgetOptions) {
    if (options.stages.length === 0)
      throw new RangeError("GIBudget stages must name at least one render pass.");
    if (!GI_METHODS.includes(options.method))
      throw new RangeError(
        `GIBudget method ${String(options.method)} is not one of ${GI_METHODS.join(", ")}.`,
      );
    this.#options = options;
    this.#read = options.read ?? stageGpuReading;
    // One level: the method holds, so the ladder only measures and reports.
    this.#ladder = new BudgetLadder<GIMethod>({
      explicit: true,
      framePeriodMs: options.framePeriodMs,
      levels: [options.method],
      start: options.method,
      ...(options.windowFrames === undefined ? {} : { windowFrames: options.windowFrames }),
    });
  }

  get finalGatherMethod(): GIMethod {
    return this.#options.method;
  }

  get globalIlluminationQuality(): 0 | 1 | 3 {
    return UNREAL_QUALITY[this.#options.method];
  }

  /** The newest closed window's report, or `undefined` before the first closes. */
  lastReport(): IGIBudgetReport | undefined {
    return this.#last;
  }

  /**
   * Feeds one loop frame: the GI stages' GPU milliseconds and the whole frame's, or `undefined` for
   * a frame whose GPU time has not resolved. Returns the report when this frame closes a window.
   */
  observe(ms: number | undefined, frameMs?: number): IGIBudgetReport | undefined {
    const window = this.#ladder.observe(ms, frameMs);
    if (window === undefined) return undefined;
    const report = this.#toReport(window);
    this.#last = report;
    this.#seen.clear();
    this.#passes.clear();
    this.#emit(report);
    return report;
  }

  /**
   * Feeds one loop frame from a renderer the frame budget instruments: the named GI passes of the
   * newest whole resolved frame, counted once however many loop frames wait for the next one.
   */
  observeRenderer(renderer: unknown): IGIBudgetReport | undefined {
    const reading = this.#read(renderer);
    if (reading === undefined || reading.frame === this.#lastFrame) return this.observe(undefined);
    this.#lastFrame = reading.frame;
    for (const name of Object.keys(reading.stages)) this.#passes.add(name);
    let ms = 0;
    for (const name of this.#options.stages) {
      const stageMs = reading.stages[name];
      if (stageMs === undefined) continue;
      this.#seen.add(name);
      ms += stageMs;
    }
    return this.observe(ms, reading.total);
  }

  #toReport(window: IBudgetWindow<GIMethod>): IGIBudgetReport {
    const ms = window.windowMs;
    const frame = window.frameMs;
    const verdict =
      window.verdict === "unobserved"
        ? "unobserved"
        : window.verdict === "over"
          ? "over"
          : "within";
    const share = ms !== undefined && frame !== undefined && frame > 0 ? ms / frame : undefined;
    const method = window.level;
    let reason: string;
    if (frame === undefined) {
      reason = `no GPU time resolved in the window (${window.frames} frames): ${method} holds`;
    } else if (verdict === "over") {
      reason = `frame ${Number(frame.toFixed(2))} ms is over the ${Number(window.targetMs.toFixed(2))} ms target (period ${Number(window.periodMs.toFixed(2))} ms): ${method} holds, the primary resolution scale is the lever${share === undefined ? "" : `, GI is ${Math.round(share * 100)}% of the frame`}`;
    } else {
      reason = `frame ${Number(frame.toFixed(2))} ms is inside the ${Number(window.targetMs.toFixed(2))} ms target`;
    }
    return {
      finalGatherMethod: method,
      frameMs: frame === undefined ? undefined : Number(frame.toFixed(3)),
      globalIlluminationQuality: UNREAL_QUALITY[method],
      passes: [...this.#passes].sort(),
      periodMs: Number(window.periodMs.toFixed(3)),
      reason,
      samples: window.samples,
      share: share === undefined ? undefined : Number(share.toFixed(4)),
      stagesSeen: [...this.#seen],
      targetMs: Number(window.targetMs.toFixed(3)),
      tier: this.#options.tier,
      verdict,
      window: window.number,
      windowMs: ms === undefined ? undefined : Number(ms.toFixed(3)),
    };
  }

  /** The first window, and a window that changes the verdict, is worth a line. */
  #emit(report: IGIBudgetReport): void {
    const worth = report.verdict !== this.#lastVerdict;
    this.#lastVerdict = report.verdict;
    if (!worth) return;
    const line = `${GI_MARKER} ${JSON.stringify(report)}`;
    if (this.#options.report !== undefined) this.#options.report(line);
    else console.info(line);
  }
}

/** Parses a `TN_GI` line back into its report, or `undefined` for any other line. */
export function readGIMarker(line: string): IGIBudgetReport | undefined {
  if (!line.startsWith(`${GI_MARKER} `)) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(GI_MARKER.length + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const report = parsed as IGIBudgetReport;
    return GI_METHODS.includes(report.finalGatherMethod) && typeof report.periodMs === "number"
      ? report
      : undefined;
  } catch {
    return undefined;
  }
}
