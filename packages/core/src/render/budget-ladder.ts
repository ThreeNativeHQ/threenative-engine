import {
  type FrameTimeModel,
  FrameTimeBudget,
  type IFrameTimeBudgetOptions,
} from "./frame-time-budget.js";

/**
 * A cost ladder for one stage: the stage runs at one level, and the whole GPU frame moves it. The
 * frame-period rule of `FrameTimeBudget` (Unreal's DynamicRenderScaling heuristic) says when the
 * frame is too dear or has room. A stage steps down only when it could absorb the overage even at
 * zero cost, so a frame that another stage made slow keeps its level. A level that failed waits a
 * growing number of frames before the next try, because the cheaper level's own reading cannot say
 * what the dearer one would cost.
 *
 * Measurement and decision only. What a level draws belongs to the game, which applies the step.
 * The same ladder serves the shadow filter samples (`ShadowFilterBudget`) and, with one level, the
 * GI report (`GIBudget`).
 */

export interface IBudgetLadderOptions<L extends string> {
  /** Levels from the cheapest to the dearest. */
  readonly levels: readonly L[];
  /** The level the stage starts at. */
  readonly start: L;
  /** The author fixed the level: an over-budget frame is reported and the level never changes. */
  readonly explicit?: boolean;
  /** The frame period in milliseconds, such as 1000 / 60. The rule compares the whole GPU frame with it. */
  readonly framePeriodMs: number;
  /** The Unreal settings of the rule. Defaults are the primary dynamic resolution ones. */
  readonly rule?: Omit<IFrameTimeBudgetOptions, "periodMs">;
  /** Frames per report when nothing moves. Default 120. */
  readonly windowFrames?: number;
  /** Frames to wait before retrying a level that failed once; each further failure doubles it. Default 600. */
  readonly retryFrames?: number;
}

export type BudgetVerdict = "over" | "within" | "under" | "unobserved";

/** One closed window: a report every `windowFrames` frames, or earlier when the level moves. */
export interface IBudgetWindow<L extends string> {
  /** 1 for the first window the ladder closes. */
  readonly number: number;
  readonly level: L;
  /** Mean of the stage's resolved readings, or `undefined` when none resolved. */
  readonly windowMs: number | undefined;
  /** The frame period the rule compares the GPU frame with. */
  readonly periodMs: number;
  /** The period less its headroom: the frame the rule steers to. */
  readonly targetMs: number;
  /** Frames in the window. */
  readonly frames: number;
  /** Frames in the window with a resolved whole-frame reading. */
  readonly samples: number;
  /** Mean of the whole frame's readings in the window, or `undefined` when none resolved. */
  readonly frameMs: number | undefined;
  readonly verdict: BudgetVerdict;
  /** The level the ladder moved to when this window moved it. */
  readonly stepped: L | undefined;
  /** Two consecutive frames over the period moved the level without the change-period gate. */
  readonly panic: boolean;
  /** The frame was over the target but the stage could not absorb the overage even at zero cost. */
  readonly notBlamed: boolean;
  readonly explicit: boolean;
}

const DEFAULT_WINDOW_FRAMES = 120;
const DEFAULT_RETRY_FRAMES = 600;
/** A level that keeps failing is retried at most this many frames apart. */
const MAX_RETRY_FRAMES = 160 * DEFAULT_WINDOW_FRAMES;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`BudgetLadder ${name} must be an integer of at least one, got ${value}.`);
  return value;
}

export type { FrameTimeModel };

export class BudgetLadder<L extends string> {
  readonly #levels: readonly L[];
  readonly #explicit: boolean;
  readonly #windowFrames: number;
  readonly #retryFrames: number;
  readonly #rule: FrameTimeBudget;
  readonly #historyFrames: number;
  #index: number;
  #frames = 0;
  #frameSamples = 0;
  #frameSum = 0;
  #stageSamples = 0;
  #stageSum = 0;
  #windowNumber = 0;
  #loopFrame = 0;
  #panic = false;
  #notBlamed = false;
  /** The newest readings the rule reads, to size the stage against the overage. */
  #recent: { frame: number; stage: number | undefined }[] = [];
  /** Failure count, the loop frame before which a level may not be tried again, and what the level cost in its failed window. */
  readonly #failures = new Map<L, { count: number; retryAt: number; ms: number }>();

  constructor(options: IBudgetLadderOptions<L>) {
    if (options.levels.length === 0) throw new RangeError("BudgetLadder levels must not be empty.");
    const start = options.levels.indexOf(options.start);
    if (start === -1)
      throw new RangeError(`BudgetLadder start ${String(options.start)} is not one of its levels.`);
    this.#levels = options.levels;
    this.#index = start;
    this.#explicit = options.explicit === true;
    this.#windowFrames = positiveInteger(
      options.windowFrames ?? DEFAULT_WINDOW_FRAMES,
      "windowFrames",
    );
    this.#retryFrames = positiveInteger(options.retryFrames ?? DEFAULT_RETRY_FRAMES, "retryFrames");
    this.#rule = new FrameTimeBudget({ ...options.rule, periodMs: options.framePeriodMs });
    this.#historyFrames = Math.floor(options.rule?.historyFrames ?? 16);
  }

  get level(): L {
    return this.#levels[this.#index] as L;
  }

  get explicit(): boolean {
    return this.#explicit;
  }

  get periodMs(): number {
    return this.#rule.periodMs;
  }

  get targetMs(): number {
    return this.#rule.targetMs;
  }

  /**
   * Feeds one loop frame. `ms` is the stage's GPU time and `frameMs` the whole frame's; `undefined`
   * is a frame whose GPU time has not resolved. Returns the closed window on the frame that ends
   * one or moves the level, `undefined` while a window is open.
   */
  observe(ms: number | undefined, frameMs?: number): IBudgetWindow<L> | undefined {
    for (const value of [ms, frameMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new RangeError(
          `BudgetLadder readings must be finite and at least zero, got ${value}.`,
        );
    }
    this.#loopFrame += 1;
    this.#frames += 1;
    if (ms !== undefined) {
      this.#stageSamples += 1;
      this.#stageSum += ms;
    }
    if (frameMs !== undefined) {
      this.#frameSamples += 1;
      this.#frameSum += frameMs;
      this.#recent.push({ frame: frameMs, stage: ms });
      if (this.#recent.length > this.#historyFrames) this.#recent.shift();
    }
    const decision = this.#rule.observe(frameMs);
    const from = this.level;
    let stepped: L | undefined;
    if (decision.direction === "down") stepped = this.#down(decision.panic);
    else if (decision.direction === "up") stepped = this.#up();
    if (stepped !== undefined) {
      this.#rule.reset();
      this.#recent = [];
      return this.#close(from, stepped);
    }
    return this.#frames < this.#windowFrames ? undefined : this.#close(from, undefined);
  }

  #down(panic: boolean): L | undefined {
    const lower = this.#index - 1;
    if (this.#explicit || lower < 0) return undefined;
    // The stage steps only when zero cost would fit the frame: the mean overage of the frames the
    // rule read must not exceed the mean stage time of the same frames.
    const frame = mean(this.#recent.map((r) => r.frame));
    const stages = this.#recent.flatMap((r) => (r.stage === undefined ? [] : [r.stage]));
    if (frame === undefined || stages.length === 0) return undefined;
    const stage = mean(stages) as number;
    if (stage < frame - this.#rule.targetMs) {
      this.#notBlamed = true;
      return undefined;
    }
    this.#panic = panic;
    this.#fail(this.level, stage);
    this.#index = lower;
    return this.level;
  }

  #up(): L | undefined {
    const upper = this.#index + 1;
    const upperLevel = this.#levels[upper];
    if (this.#explicit || upperLevel === undefined) return undefined;
    if (this.#loopFrame < (this.#failures.get(upperLevel)?.retryAt ?? 0)) return undefined;
    const frame = mean(this.#recent.map((r) => r.frame));
    if (frame === undefined) return undefined;
    const stages = this.#recent.flatMap((r) => (r.stage === undefined ? [] : [r.stage]));
    const stage = mean(stages) ?? 0;
    // The dearer level may cost what it cost when it last failed, over what the stage costs now.
    const extra = Math.max(0, (this.#failures.get(upperLevel)?.ms ?? 0) - stage);
    if (frame + extra > this.#rule.targetMs) return undefined;
    this.#index = upper;
    return upperLevel;
  }

  #close(ranAt: L, stepped: L | undefined): IBudgetWindow<L> {
    this.#windowNumber += 1;
    const frameMs = this.#frameSamples > 0 ? this.#frameSum / this.#frameSamples : undefined;
    const stageMs = this.#stageSamples > 0 ? this.#stageSum / this.#stageSamples : undefined;
    const down =
      stepped !== undefined && this.#levels.indexOf(stepped) < this.#levels.indexOf(ranAt);
    let verdict: BudgetVerdict;
    if (stepped !== undefined) verdict = down ? "over" : "under";
    else if (frameMs === undefined) verdict = "unobserved";
    else verdict = frameMs > this.#rule.targetMs ? "over" : "within";
    const window: IBudgetWindow<L> = {
      explicit: this.#explicit,
      frameMs,
      frames: this.#frames,
      level: ranAt,
      notBlamed: this.#notBlamed,
      number: this.#windowNumber,
      panic: this.#panic,
      periodMs: this.#rule.periodMs,
      samples: this.#frameSamples,
      stepped,
      targetMs: this.#rule.targetMs,
      verdict,
      windowMs: stageMs,
    };
    this.#frames = 0;
    this.#frameSamples = 0;
    this.#frameSum = 0;
    this.#stageSamples = 0;
    this.#stageSum = 0;
    this.#panic = false;
    this.#notBlamed = false;
    return window;
  }

  /** The level failed at `ms`: wait longer each time before trying it again. */
  #fail(level: L, ms: number): void {
    const count = (this.#failures.get(level)?.count ?? 0) + 1;
    const wait = Math.min(MAX_RETRY_FRAMES, this.#retryFrames * 2 ** (count - 1));
    this.#failures.set(level, { count, retryAt: this.#loopFrame + wait, ms });
  }
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}
