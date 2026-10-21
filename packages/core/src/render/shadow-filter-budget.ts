import { type IStageGpuReading, stageGpuReading } from "../render-pass-budget.js";
import { BudgetLadder, type IBudgetWindow } from "./budget-ladder.js";

/** `TN_SHADOW_TIER` lines carry one report as JSON. */
export const SHADOW_TIER_MARKER = "TN_SHADOW_TIER";

/** The shadow filter tiers, cheapest first. The game maps each one to its own sample counts. */
export const SHADOW_FILTER_TIERS = ["low", "medium", "high"] as const;

export type ShadowFilterTier = (typeof SHADOW_FILTER_TIERS)[number];

/** `sg.ShadowQuality` of the Unreal level each tier follows (Low, Medium, Epic). */
const UNREAL_QUALITY: Readonly<Record<ShadowFilterTier, 0 | 1 | 3>> = {
  high: 3,
  low: 0,
  medium: 1,
};

export interface IShadowFilterReport {
  /** The tier after this window. */
  readonly tier: ShadowFilterTier;
  /** Read-only: the `sg.ShadowQuality` the tier follows. */
  readonly shadowQuality: 0 | 1 | 3;
  /** Mean whole-frame GPU milliseconds over the window, or `undefined` when too few frames resolved. */
  readonly windowMs: number | undefined;
  readonly budgetMs: number;
  readonly samples: number;
  readonly stepped: ShadowFilterTier | undefined;
  readonly explicit: boolean;
  readonly reason: string;
}

export interface IShadowFilterBudgetOptions {
  /** The tier the game starts at: its quality tier's shadow row. */
  readonly tier: ShadowFilterTier;
  /** The game set the sample counts itself: the watcher reports and never changes them. */
  readonly explicit?: boolean;
  /** The frame period in milliseconds the whole frame's GPU time is held to, such as 1000 / 60. */
  readonly frameBudgetMs: number;
  /** Frames per window. Default 120. */
  readonly windowFrames?: number;
  /** Resolved frames a window needs before it may move the tier. Default 8. */
  readonly minSamples?: number;
  /** Called after the watcher moved the tier; the game rebuilds its filter with that tier's samples. */
  readonly onStep?: (tier: ShadowFilterTier, report: IShadowFilterReport) => void;
  /** Where `TN_SHADOW_TIER` lines go. Default `console.info`. */
  readonly report?: (line: string) => void;
  /** Reads a renderer's newest GPU reading. Default `stageGpuReading`; a test supplies its own. */
  readonly read?: (renderer: unknown) => IStageGpuReading | undefined;
}

/**
 * Steps a game's soft-shadow filter down a tier when the frame's GPU time stays over its period, and
 * back up when there is room. The receiver filter runs inside the colour pass and three labels no
 * pass for it, so its own cost cannot be read: the whole frame's GPU time is the pressure signal, held
 * to the frame period. The game owns what each tier samples and rebuilds its filter on each step.
 *
 * Over a window of frames (120 by default) above the period, the tier steps down. It steps up only
 * below 70% of the period, and a tier that failed is retried after a longer wait each time. A game
 * that sets the sample counts itself keeps them: the report says the budget is exceeded and nothing
 * changes. An adapter without timestamp queries resolves no frame, so every window is unobserved and
 * the tier holds. Redraw cost keeps its own levers in `VirtualShadowNode`.
 *
 * @situation soft shadow filter costs too much on a weak GPU
 * @situation step the shadow filter samples from measured frame time
 * @situation shadow quality tier that follows the hardware
 * @constraint the game rebuilds its filter with the tier's sample counts on each step; this class draws nothing
 * @constraint timestamp queries are needed: without them every window is unobserved and the tier holds
 * @constraint the signal is the whole frame's GPU time, so a frame slow for another reason also steps the filter down
 * @override explicit: true keeps the game's own sample counts and reports an exceeded period
 * @alias shadow quality
 * @alias virtual shadow map scalability
 * @alias sg.ShadowQuality
 * @example
 * const filter = new ShadowFilterBudget({ tier: "high", frameBudgetMs: 1000 / 60, onStep: (tier) => { light.shadow.filterNode = filterFor(tier); } });
 * ctx.beforeRender(() => filter.observeRenderer(ctx.renderer.raw));
 */
export class ShadowFilterBudget {
  readonly #ladder: BudgetLadder<ShadowFilterTier>;
  readonly #options: IShadowFilterBudgetOptions;
  readonly #read: (renderer: unknown) => IStageGpuReading | undefined;
  #lastFrame = -1;
  #last: IShadowFilterReport | undefined;
  #reportedOver = false;

  constructor(options: IShadowFilterBudgetOptions) {
    this.#options = options;
    this.#read = options.read ?? stageGpuReading;
    this.#ladder = new BudgetLadder<ShadowFilterTier>({
      budgetMs: {
        high: options.frameBudgetMs,
        low: options.frameBudgetMs,
        medium: options.frameBudgetMs,
      },
      levels: SHADOW_FILTER_TIERS,
      start: options.tier,
      ...(options.explicit === undefined ? {} : { explicit: options.explicit }),
      ...(options.minSamples === undefined ? {} : { minSamples: options.minSamples }),
      ...(options.windowFrames === undefined ? {} : { windowFrames: options.windowFrames }),
    });
  }

  get tier(): ShadowFilterTier {
    return this.#ladder.level;
  }

  get shadowQuality(): 0 | 1 | 3 {
    return UNREAL_QUALITY[this.#ladder.level];
  }

  /** The newest closed window's report, or `undefined` before the first closes. */
  lastReport(): IShadowFilterReport | undefined {
    return this.#last;
  }

  /** Feeds one loop frame: the whole frame's GPU milliseconds, or `undefined` while unresolved. */
  observe(frameMs: number | undefined): IShadowFilterReport | undefined {
    const window = this.#ladder.observe(frameMs);
    if (window === undefined) return undefined;
    const report = this.#toReport(window);
    this.#last = report;
    this.#emit(report);
    if (window.stepped !== undefined) this.#options.onStep?.(window.stepped, report);
    return report;
  }

  /** Feeds one loop frame from an instrumented renderer, counting each resolved frame once. */
  observeRenderer(renderer: unknown): IShadowFilterReport | undefined {
    const reading = this.#read(renderer);
    if (reading === undefined || reading.frame === this.#lastFrame) return this.observe(undefined);
    this.#lastFrame = reading.frame;
    return this.observe(reading.total);
  }

  #toReport(window: IBudgetWindow<ShadowFilterTier>): IShadowFilterReport {
    const after = window.stepped ?? window.level;
    const ms = window.windowMs;
    const shown = ms === undefined ? "" : `frame ${Number(ms.toFixed(2))} ms`;
    let reason: string;
    if (ms === undefined) {
      reason = `no GPU time resolved in the window (${window.samples} readings): ${window.level} holds`;
    } else if (window.verdict === "over") {
      const base = `${shown} is over the ${window.budgetMs} ms period`;
      reason =
        window.stepped !== undefined
          ? `${base}: stepped down to ${window.stepped}`
          : window.explicit
            ? `${base}: sample counts are set by the game and stay at ${window.level}`
            : `${base} and ${window.level} is the cheapest tier`;
    } else if (window.stepped !== undefined) {
      reason = `${shown} leaves room: stepped up to ${window.stepped}`;
    } else {
      reason = `${shown} is inside the ${window.budgetMs} ms period`;
    }
    return {
      budgetMs: window.budgetMs,
      explicit: window.explicit,
      reason,
      samples: window.samples,
      shadowQuality: UNREAL_QUALITY[after],
      stepped: window.stepped,
      tier: after,
      windowMs: ms === undefined ? undefined : Number(ms.toFixed(3)),
    };
  }

  #emit(report: IShadowFilterReport): void {
    const over = report.windowMs !== undefined && report.windowMs > report.budgetMs;
    const worth = report.stepped !== undefined || (report.explicit && over && !this.#reportedOver);
    this.#reportedOver = over;
    if (!worth) return;
    const line = `${SHADOW_TIER_MARKER} ${JSON.stringify(report)}`;
    if (this.#options.report !== undefined) this.#options.report(line);
    else console.info(line);
  }
}

/** Parses a `TN_SHADOW_TIER` line back into its report, or `undefined` for any other line. */
export function readShadowTierMarker(line: string): IShadowFilterReport | undefined {
  if (!line.startsWith(`${SHADOW_TIER_MARKER} `)) return undefined;
  try {
    const parsed: unknown = JSON.parse(line.slice(SHADOW_TIER_MARKER.length + 1));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const report = parsed as IShadowFilterReport;
    return SHADOW_FILTER_TIERS.includes(report.tier) && typeof report.budgetMs === "number"
      ? report
      : undefined;
  } catch {
    return undefined;
  }
}
