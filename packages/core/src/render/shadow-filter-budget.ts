import { type IStageGpuReading, SHADOW_STAGE, stageGpuReading } from "../render-pass-budget.js";
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

/** The stage the engines name the shadow passes' GPU time by: the owned engine's shadow segment, three's `Shadow Map` passes. */
export const SHADOW_STAGES: readonly string[] = [SHADOW_STAGE];

export interface IShadowFilterReport {
  /** The tier after this window. */
  readonly tier: ShadowFilterTier;
  /** Read-only: the `sg.ShadowQuality` the tier follows. */
  readonly shadowQuality: 0 | 1 | 3;
  /** Mean GPU milliseconds of the shadow stages over the window, or `undefined` when too few frames resolved. */
  readonly windowMs: number | undefined;
  /** Mean whole-frame GPU milliseconds over the window, to read the shadow share against. */
  readonly frameMs: number | undefined;
  /** The budget of the tier the window ran at. */
  readonly budgetMs: number;
  readonly samples: number;
  /** Which of the named `stages` resolved in the window. Empty when a stage name is wrong: that reads as 0 ms. */
  readonly stagesSeen: readonly string[];
  readonly stepped: ShadowFilterTier | undefined;
  readonly explicit: boolean;
  readonly reason: string;
}

export interface IShadowFilterBudgetOptions {
  /** The tier the game starts at: its quality tier's shadow row. */
  readonly tier: ShadowFilterTier;
  /** The game set the sample counts itself: the watcher reports and never changes them. */
  readonly explicit?: boolean;
  /** GPU milliseconds the shadow stages may cost at each tier: Unreal's measured `ShadowDepths` time at the matching level. */
  readonly budgetMs: Readonly<Record<ShadowFilterTier, number>>;
  /** Names of the render passes that are shadow work. Default {@link SHADOW_STAGES}. */
  readonly stages?: readonly string[];
  /**
   * The whole frame's GPU allowance in milliseconds, such as 1000 / 60. A step up also needs the
   * frame to have room for the dearer tier, so a stage that reads zero because it is off does not
   * climb on a GPU with none to spare. Without it the stage's own budget decides alone.
   */
  readonly frameBudgetMs?: number;
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
 * Steps a game's soft-shadow tier down when the GPU time of its shadow passes stays over the tier's
 * budget, and back up when there is room. Only the shadow stages' own time moves the tier: a frame
 * that is slow for another reason (the gather, the post chain, a weak adapter) never costs the
 * shadows their samples. The game owns what each tier draws and rebuilds its filter on each step.
 *
 * Over a window of frames (120 by default) above the tier's budget, the tier steps down. It steps up
 * only below 70% of the next tier's budget, with room for that tier in the whole frame when
 * `frameBudgetMs` is set, and a tier that failed is retried after a longer wait each time. A game
 * that sets the sample counts itself keeps them: the report says the budget is exceeded and nothing
 * changes. An adapter without timestamp queries resolves no frame, so every window is unobserved and
 * the tier holds. Redraw cost keeps its own levers in `VirtualShadowNode`.
 *
 * @situation soft shadow filter costs too much on a weak GPU
 * @situation step the shadow quality tier from the measured GPU time of the shadow passes
 * @situation shadow quality tier that follows the hardware
 * @constraint the game rebuilds its filter with the tier's sample counts on each step; this class draws nothing
 * @constraint timestamp queries are needed: without them every window is unobserved and the tier holds
 * @constraint the signal is the GPU time of the shadow passes (the `Shadow` stage), which the receiver filter inside the colour pass is not part of
 * @override explicit: true keeps the game's own sample counts and reports an exceeded budget
 * @alias virtual shadow map scalability
 * @alias sg.ShadowQuality
 * @example
 * const filter = new ShadowFilterBudget({ tier: "high", budgetMs: { low: 0.3, medium: 0.3, high: 0.5 }, onStep: (tier) => { light.shadow.filterNode = filterFor(tier); } });
 * ctx.beforeRender(() => filter.observeRenderer(ctx.renderer.raw));
 */
export class ShadowFilterBudget {
  readonly #ladder: BudgetLadder<ShadowFilterTier>;
  readonly #options: IShadowFilterBudgetOptions;
  readonly #read: (renderer: unknown) => IStageGpuReading | undefined;
  readonly #stages: readonly string[];
  readonly #seen = new Set<string>();
  #lastFrame = -1;
  #last: IShadowFilterReport | undefined;
  #reportedOver = false;

  constructor(options: IShadowFilterBudgetOptions) {
    this.#options = options;
    this.#read = options.read ?? stageGpuReading;
    const stages = options.stages ?? SHADOW_STAGES;
    if (stages.length === 0)
      throw new RangeError("ShadowFilterBudget stages must name at least one render pass.");
    this.#stages = stages;
    this.#ladder = new BudgetLadder<ShadowFilterTier>({
      budgetMs: options.budgetMs,
      levels: SHADOW_FILTER_TIERS,
      start: options.tier,
      ...(options.explicit === undefined ? {} : { explicit: options.explicit }),
      ...(options.frameBudgetMs === undefined ? {} : { frameBudgetMs: options.frameBudgetMs }),
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

  /**
   * Feeds one loop frame: the shadow stages' GPU milliseconds and the whole frame's, or `undefined`
   * for a frame whose GPU time has not resolved. Returns the report when this frame closes a window.
   */
  observe(ms: number | undefined, frameMs?: number): IShadowFilterReport | undefined {
    const window = this.#ladder.observe(ms, frameMs);
    if (window === undefined) return undefined;
    const report = this.#toReport(window);
    this.#last = report;
    this.#seen.clear();
    this.#emit(report);
    if (window.stepped !== undefined) this.#options.onStep?.(window.stepped, report);
    return report;
  }

  /**
   * Feeds one loop frame from an instrumented renderer: the named shadow stages of the newest whole
   * resolved frame, counted once however many loop frames wait for the next one.
   */
  observeRenderer(renderer: unknown): IShadowFilterReport | undefined {
    const reading = this.#read(renderer);
    if (reading === undefined || reading.frame === this.#lastFrame) return this.observe(undefined);
    this.#lastFrame = reading.frame;
    let ms = 0;
    for (const name of this.#stages) {
      const stageMs = reading.stages[name];
      if (stageMs === undefined) continue;
      this.#seen.add(name);
      ms += stageMs;
    }
    return this.observe(ms, reading.total);
  }

  #toReport(window: IBudgetWindow<ShadowFilterTier>): IShadowFilterReport {
    const after = window.stepped ?? window.level;
    const ms = window.windowMs;
    const shown = ms === undefined ? "" : `shadow passes ${Number(ms.toFixed(2))} ms`;
    let reason: string;
    if (ms === undefined) {
      reason = `no GPU time resolved in the window (${window.samples} readings): ${window.level} holds`;
    } else if (window.verdict === "over") {
      const base = `${shown} are over the ${window.budgetMs} ms budget`;
      reason =
        window.stepped !== undefined
          ? `${base}: stepped down to ${window.stepped}`
          : window.explicit
            ? `${base}: sample counts are set by the game and stay at ${window.level}`
            : `${base} and ${window.level} is the cheapest tier`;
    } else if (window.stepped !== undefined) {
      reason = `${shown} leave room: stepped up to ${window.stepped}`;
    } else {
      reason = `${shown} are inside the ${window.budgetMs} ms budget`;
    }
    return {
      budgetMs: window.budgetMs,
      explicit: window.explicit,
      frameMs: window.frameMs === undefined ? undefined : Number(window.frameMs.toFixed(3)),
      reason,
      samples: window.samples,
      shadowQuality: UNREAL_QUALITY[after],
      stagesSeen: [...this.#seen],
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
