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
  /** The method after this window. */
  readonly finalGatherMethod: GIMethod;
  /** Read-only: the `sg.GlobalIlluminationQuality` the method follows. */
  readonly globalIlluminationQuality: 0 | 1 | 3;
  /** The quality tier the game started at, when it named one. */
  readonly tier: string | undefined;
  /** Mean GI-stage GPU milliseconds over the window, or `undefined` when too few frames resolved. */
  readonly windowMs: number | undefined;
  /** Mean whole-frame GPU milliseconds over the window, to read the GI share against. */
  readonly frameMs: number | undefined;
  /** The budget of the method the window ran at. */
  readonly budgetMs: number;
  readonly samples: number;
  /** 1 for the first window the watcher closes, so a reader can skip the warm-up window. */
  readonly window: number;
  /** Which of the named `stages` resolved in the window. Empty when a stage name is wrong: that reads as 0 ms. */
  readonly stagesSeen: readonly string[];
  /** Every nested pass name that resolved in the window, to find the name a stage goes by. */
  readonly passes: readonly string[];
  /** The method the ladder moved to, when this window moved it. */
  readonly stepped: GIMethod | undefined;
  /** The game fixed `finalGatherMethod`: an exceeded budget is reported and nothing changes. */
  readonly explicit: boolean;
  readonly reason: string;
}

export interface IGIBudgetOptions {
  /** The method the game starts at: the tier's `finalGatherMethod`. */
  readonly method: GIMethod;
  /**
   * The methods the game can switch between while it runs, cheapest first. Default all three. A game
   * that baked its world cache at start cannot step to `none` later, so it lists the other two.
   */
  readonly methods?: readonly GIMethod[];
  /** The game set `finalGatherMethod` itself: the watcher reports and never changes it. */
  readonly explicit?: boolean;
  /** GPU milliseconds each method may cost: Unreal's measured GI time at the matching level. */
  readonly budgetMs: Readonly<Record<GIMethod, number>>;
  /** Names of the render passes that are GI work (three names its passes by scene, such as `SSGI`). */
  readonly stages: readonly string[];
  /** The whole frame's GPU allowance in milliseconds, usually the target frame period. */
  readonly frameBudgetMs?: number;
  /** The quality tier the method came from, for the report. */
  readonly tier?: string;
  /** Frames per window. Default 120. */
  readonly windowFrames?: number;
  /** Resolved frames a window needs before it may move the method. Default 8. */
  readonly minSamples?: number;
  /** Called after the watcher moved the method; the game applies it to its own render chain. */
  readonly onStep?: (method: GIMethod, report: IGIBudgetReport) => void;
  /** Where `TN_GI` lines go. Default `console.info`. */
  readonly report?: (line: string) => void;
  /** Reads a renderer's newest stage reading. Default `stageGpuReading`; a test supplies its own. */
  readonly read?: (renderer: unknown) => IStageGpuReading | undefined;
}

/**
 * Steps a game's global illumination method down when its GPU time stays over budget, and back up
 * when there is room. The game owns what each method draws; this reads the GPU time of the passes
 * the game names, once per resolved frame, and decides only when to move.
 *
 * The method starts where the game's quality tier puts it. Over a window of frames (120 by default)
 * above the method's budget, it steps down one method. It steps up only after a window below 70% of
 * the next method's budget, with room for that method in the whole frame. A method that failed is
 * retried after a longer wait each time, and only once the frame has room for what it cost then. A
 * game that sets `finalGatherMethod` itself keeps it: the report says the budget is exceeded and
 * nothing changes. An adapter without timestamp queries resolves no frame, so the window is reported
 * unobserved and the method holds.
 *
 * @situation global illumination costs too much on a weak GPU
 * @situation pick the bounce light method from measured GPU time
 * @situation quality tier for indirect lighting that follows the hardware
 * @constraint the game applies each step to its own render chain; this class draws nothing
 * @constraint the GPU time of a pass is read by the scene name three or the game gave it, so name every GI pass in `stages`
 * @constraint timestamp queries are needed: without them every window is unobserved and the method holds
 * @override explicit: true keeps the game's own finalGatherMethod and reports an exceeded budget
 * @alias lumen scalability
 * @alias sg.GlobalIlluminationQuality
 * @alias final gather method
 * @example
 * const gi = new GIBudget({ method: "screenProbeGather", stages: ["SSGI"], budgetMs: { none: 0, irradianceField: 1, screenProbeGather: 5 }, onStep: (method) => rebuildChain(method) });
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
  #reportedOver = false;

  constructor(options: IGIBudgetOptions) {
    if (options.stages.length === 0)
      throw new RangeError("GIBudget stages must name at least one render pass.");
    const methods = options.methods ?? GI_METHODS;
    const order = methods.map((m) => GI_METHODS.indexOf(m));
    if (order.some((at, i) => at < 0 || (i > 0 && at <= (order[i - 1] ?? -1))))
      throw new RangeError(
        `GIBudget methods must be listed cheapest first from ${GI_METHODS.join(", ")}.`,
      );
    this.#options = options;
    this.#read = options.read ?? stageGpuReading;
    this.#ladder = new BudgetLadder<GIMethod>({
      budgetMs: options.budgetMs,
      levels: methods,
      start: options.method,
      ...(options.explicit === undefined ? {} : { explicit: options.explicit }),
      ...(options.frameBudgetMs === undefined ? {} : { frameBudgetMs: options.frameBudgetMs }),
      ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }),
      ...(options.windowFrames === undefined ? {} : { windowFrames: options.windowFrames }),
    });
  }

  get finalGatherMethod(): GIMethod {
    return this.#ladder.level;
  }

  get globalIlluminationQuality(): 0 | 1 | 3 {
    return UNREAL_QUALITY[this.#ladder.level];
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
    if (window.stepped !== undefined) this.#options.onStep?.(window.stepped, report);
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
    const after = window.stepped ?? window.level;
    const ms = window.windowMs;
    const shown = ms === undefined ? "" : `window ${Number(ms.toFixed(2))} ms`;
    let reason: string;
    if (ms === undefined) {
      reason = `no GPU time resolved in the window (${window.samples} readings): ${window.level} holds`;
    } else if (window.verdict === "over") {
      const base = `${shown} is over the ${window.budgetMs} ms budget`;
      reason =
        window.stepped !== undefined
          ? `${base}: stepped down to ${window.stepped}`
          : window.explicit
            ? `${base}: finalGatherMethod is set by the game and stays ${window.level}`
            : `${base} and ${window.level} is the cheapest method`;
    } else if (window.stepped !== undefined) {
      reason = `${shown} leaves room for ${window.stepped}: stepped up`;
    } else {
      reason = `${shown} is inside the ${window.budgetMs} ms budget`;
    }
    return {
      budgetMs: window.budgetMs,
      explicit: window.explicit,
      finalGatherMethod: after,
      frameMs: window.frameMs === undefined ? undefined : Number(window.frameMs.toFixed(3)),
      globalIlluminationQuality: UNREAL_QUALITY[after],
      reason,
      samples: window.samples,
      passes: [...this.#passes].sort(),
      stagesSeen: [...this.#seen],
      stepped: window.stepped,
      tier: this.#options.tier,
      window: window.number,
      windowMs: ms === undefined ? undefined : Number(ms.toFixed(3)),
    };
  }

  /** A step, or the first window an explicit method spends over budget, is worth a line. */
  #emit(report: IGIBudgetReport): void {
    const over = report.windowMs !== undefined && report.windowMs > report.budgetMs;
    const worth = report.stepped !== undefined || (report.explicit && over && !this.#reportedOver);
    this.#reportedOver = over;
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
    return GI_METHODS.includes(report.finalGatherMethod) && typeof report.budgetMs === "number"
      ? report
      : undefined;
  } catch {
    return undefined;
  }
}
