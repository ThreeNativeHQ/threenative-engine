import { type IStageGpuReading, SHADOW_STAGE, stageGpuReading } from "../render-pass-budget.js";
import { BudgetLadder, type BudgetVerdict, type IBudgetWindow } from "./budget-ladder.js";

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
  /** Mean GPU milliseconds of the shadow stages over the window, or `undefined` when no frame resolved. */
  readonly windowMs: number | undefined;
  /** Mean whole-frame GPU milliseconds over the window. */
  readonly frameMs: number | undefined;
  /** The frame period the frame is compared with. */
  readonly periodMs: number;
  /** The frame period less its headroom. */
  readonly targetMs: number;
  /** Resolved whole-frame readings in the window. */
  readonly samples: number;
  /** Which of the named `stages` resolved in the window. Empty when a stage name is wrong: that reads as 0 ms. */
  readonly stagesSeen: readonly string[];
  readonly stepped: ShadowFilterTier | undefined;
  /** Two consecutive frames over the period moved the tier without the change-period gate. */
  readonly panic: boolean;
  /** The frame was over the target but the shadow passes could not absorb the overage even at zero cost. */
  readonly notBlamed: boolean;
  readonly verdict: BudgetVerdict;
  readonly explicit: boolean;
  readonly reason: string;
}

export interface IShadowFilterBudgetOptions {
  /** The tier the game starts at: its quality tier's shadow row. */
  readonly tier: ShadowFilterTier;
  /** The game set the sample counts itself: the watcher reports and never changes them. */
  readonly explicit?: boolean;
  /** Names of the render passes that are shadow work. Default {@link SHADOW_STAGES}. */
  readonly stages?: readonly string[];
  /** The frame period in milliseconds, such as 1000 / 60. The whole GPU frame is compared with it. */
  readonly framePeriodMs: number;
  /** Frames per report when nothing moves. Default 120. */
  readonly windowFrames?: number;
  /** Called after the watcher moved the tier; the game rebuilds its filter with that tier's samples. */
  readonly onStep?: (tier: ShadowFilterTier, report: IShadowFilterReport) => void;
  /** Where `TN_SHADOW_TIER` lines go. Default `console.info`. */
  readonly report?: (line: string) => void;
  /** Reads a renderer's newest GPU reading. Default `stageGpuReading`; a test supplies its own. */
  readonly read?: (renderer: unknown) => IStageGpuReading | undefined;
}

/**
 * Steps a game's soft-shadow tier down when the whole GPU frame stays over the frame period, and
 * back up when the frame has room. The rule is Unreal's DynamicRenderScaling heuristic with the
 * settings of its virtual shadow map budget (`VirtualShadowMapArray.cpp:831-845`: a linear model,
 * 5% headroom, a 1% change threshold). Unreal's own budget compares the stage with a time the
 * author sets, which is off by default and depends on the GPU clock, so this one compares the
 * frame with its period. A frame that is slow for another reason keeps its shadows: the tier steps
 * only when the shadow passes could absorb the overage even at zero cost. The game owns what each
 * tier draws and rebuilds its filter on each step.
 *
 * Two frames over the period step the tier down at once. Otherwise a move waits 8 frames after the
 * last one, and a tier that failed is retried after a longer wait each time. A game that sets the
 * sample counts itself keeps them: the report says the frame is over and nothing changes. An
 * adapter without timestamp queries resolves no frame, so every window is unobserved and the tier
 * holds. Redraw cost keeps its own levers in `VirtualShadowNode`.
 *
 * @situation soft shadow filter costs too much on a weak GPU
 * @situation step the shadow quality tier when the GPU frame goes over the frame period
 * @situation shadow quality tier that follows the hardware
 * @constraint the game rebuilds its filter with the tier's sample counts on each step; this class draws nothing
 * @constraint timestamp queries are needed: without them every window is unobserved and the tier holds
 * @constraint the rule reads the whole GPU frame and the `Shadow` stage, which the receiver filter inside the colour pass is not part of
 * @override explicit: true keeps the game's own sample counts and reports an over-budget frame
 * @alias virtual shadow map scalability
 * @alias sg.ShadowQuality
 * @example
 * const filter = new ShadowFilterBudget({ tier: "high", framePeriodMs: 1000 / 60, onStep: (tier) => { light.shadow.filterNode = filterFor(tier); } });
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
      framePeriodMs: options.framePeriodMs,
      levels: SHADOW_FILTER_TIERS,
      // The virtual shadow map budget's own settings (VirtualShadowMapArray.cpp:834-841).
      rule: { changeThreshold: 0.01, headroom: 0.05, model: "linear" },
      start: options.tier,
      ...(options.explicit === undefined ? {} : { explicit: options.explicit }),
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
    const frame = window.frameMs;
    const shown = frame === undefined ? "" : `frame ${Number(frame.toFixed(2))} ms`;
    const target = `${Number(window.targetMs.toFixed(2))} ms target (period ${Number(window.periodMs.toFixed(2))} ms)`;
    let reason: string;
    if (frame === undefined) {
      reason = `no GPU time resolved in the window (${window.frames} frames): ${window.level} holds`;
    } else if (window.stepped !== undefined && window.verdict === "over") {
      reason = `${shown} is over the ${target}${window.panic ? " for 2 frames in a row" : ""}: stepped down to ${window.stepped}`;
    } else if (window.stepped !== undefined) {
      reason = `${shown} leaves room under the ${target}: stepped up to ${window.stepped}`;
    } else if (window.verdict === "over") {
      const base = `${shown} is over the ${target}`;
      reason = window.explicit
        ? `${base}: sample counts are set by the game and stay at ${window.level}`
        : window.notBlamed
          ? `${base}, and the shadow passes (${Number((ms ?? 0).toFixed(2))} ms) are too small to absorb it: ${window.level} holds`
          : `${base} and ${window.level} is the cheapest tier or the move waits for the change period`;
    } else {
      reason = `${shown} is inside the ${target}`;
    }
    return {
      explicit: window.explicit,
      frameMs: frame === undefined ? undefined : Number(frame.toFixed(3)),
      notBlamed: window.notBlamed,
      panic: window.panic,
      periodMs: Number(window.periodMs.toFixed(3)),
      reason,
      samples: window.samples,
      shadowQuality: UNREAL_QUALITY[after],
      stagesSeen: [...this.#seen],
      stepped: window.stepped,
      targetMs: Number(window.targetMs.toFixed(3)),
      tier: after,
      verdict: window.verdict,
      windowMs: ms === undefined ? undefined : Number(ms.toFixed(3)),
    };
  }

  /** A step, or the first window an explicit tier spends over budget, is worth a line. */
  #emit(report: IShadowFilterReport): void {
    const over = report.verdict === "over";
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
    return SHADOW_FILTER_TIERS.includes(report.tier) && typeof report.periodMs === "number"
      ? report
      : undefined;
  } catch {
    return undefined;
  }
}
