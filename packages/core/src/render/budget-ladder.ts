/**
 * A cost ladder for one stage: the stage runs at one level, and a window of measured milliseconds
 * moves it. A window above the level's budget steps down one level. A step up needs a window below
 * `stepUpShare` of the next level's budget, so a level cannot flap on noise. A level that failed
 * waits a growing number of windows before the next try, because the cheaper level's own reading
 * cannot say what the dearer one would cost.
 *
 * Measurement and decision only. What a level draws belongs to the game, which applies the step.
 * The same ladder serves the GI method (`GIBudget`) and the shadow filter samples.
 */

export interface IBudgetLadderOptions<L extends string> {
  /** Levels from the cheapest to the dearest. */
  readonly levels: readonly L[];
  /** Milliseconds each level may cost over a window. Every level needs an entry. */
  readonly budgetMs: Readonly<Record<L, number>>;
  /** The level the stage starts at. */
  readonly start: L;
  /** The author fixed the level: a window over budget is reported and the level never changes. */
  readonly explicit?: boolean;
  /** Frames per window. Default 120. */
  readonly windowFrames?: number;
  /** Resolved readings a window needs before it may move the level. Default 8. */
  readonly minSamples?: number;
  /** A step up needs the window mean under this share of the next level's budget. Default 0.7. */
  readonly stepUpShare?: number;
  /** Windows to wait before retrying a level that failed once; each further failure doubles it. Default 5. */
  readonly retryWindows?: number;
  /**
   * The whole frame's GPU allowance in milliseconds. When set, a step up also needs the window's
   * frame mean, plus what the next level may add over this one, to fit inside it. Without it a
   * stage that reads zero because it is off would climb on a GPU that has no room for it.
   */
  readonly frameBudgetMs?: number;
}

export type BudgetVerdict = "over" | "within" | "under" | "unobserved";

/** One closed window. */
export interface IBudgetWindow<L extends string> {
  /** 1 for the first window the ladder closes. */
  readonly number: number;
  readonly level: L;
  /** Mean of the resolved readings, or `undefined` for an unobserved window. */
  readonly windowMs: number | undefined;
  /** The budget of the level the window ran at. */
  readonly budgetMs: number;
  readonly samples: number;
  /** Mean of the whole frame's readings in the window, when the caller supplied them. */
  readonly frameMs: number | undefined;
  readonly verdict: BudgetVerdict;
  /** The level the ladder moved to when this window moved it. */
  readonly stepped: L | undefined;
  readonly explicit: boolean;
}

const DEFAULT_WINDOW_FRAMES = 120;
const DEFAULT_MIN_SAMPLES = 8;
const DEFAULT_STEP_UP_SHARE = 0.7;
const DEFAULT_RETRY_WINDOWS = 5;
/** A level that keeps failing is retried at most this many windows apart. */
const MAX_RETRY_WINDOWS = 160;

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1)
    throw new RangeError(`BudgetLadder ${name} must be an integer of at least one, got ${value}.`);
  return value;
}

export class BudgetLadder<L extends string> {
  readonly #levels: readonly L[];
  readonly #budgetMs: Readonly<Record<L, number>>;
  readonly #explicit: boolean;
  readonly #windowFrames: number;
  readonly #minSamples: number;
  readonly #stepUpShare: number;
  readonly #retryWindows: number;
  readonly #frameBudgetMs: number | undefined;
  #index: number;
  #frames = 0;
  #samples = 0;
  #sum = 0;
  #frameSamples = 0;
  #frameSum = 0;
  #windowNumber = 0;
  /** Failure count and the window number before which a level may not be tried again. */
  readonly #failures = new Map<L, { count: number; retryAt: number }>();

  constructor(options: IBudgetLadderOptions<L>) {
    if (options.levels.length === 0) throw new RangeError("BudgetLadder levels must not be empty.");
    const start = options.levels.indexOf(options.start);
    if (start === -1)
      throw new RangeError(`BudgetLadder start ${String(options.start)} is not one of its levels.`);
    for (const level of options.levels) {
      const budget = options.budgetMs[level];
      if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0)
        throw new RangeError(
          `BudgetLadder budget for ${level} must be a finite number of at least zero.`,
        );
    }
    this.#levels = options.levels;
    this.#budgetMs = options.budgetMs;
    this.#index = start;
    this.#explicit = options.explicit === true;
    this.#windowFrames = positiveInteger(
      options.windowFrames ?? DEFAULT_WINDOW_FRAMES,
      "windowFrames",
    );
    this.#minSamples = positiveInteger(options.minSamples ?? DEFAULT_MIN_SAMPLES, "minSamples");
    if (this.#minSamples > this.#windowFrames)
      throw new RangeError("BudgetLadder minSamples cannot exceed windowFrames.");
    this.#stepUpShare = options.stepUpShare ?? DEFAULT_STEP_UP_SHARE;
    if (!(this.#stepUpShare > 0 && this.#stepUpShare <= 1))
      throw new RangeError("BudgetLadder stepUpShare must be in (0, 1].");
    this.#retryWindows = positiveInteger(
      options.retryWindows ?? DEFAULT_RETRY_WINDOWS,
      "retryWindows",
    );
    if (
      options.frameBudgetMs !== undefined &&
      !(Number.isFinite(options.frameBudgetMs) && options.frameBudgetMs > 0)
    )
      throw new RangeError("BudgetLadder frameBudgetMs must be a finite number above zero.");
    this.#frameBudgetMs = options.frameBudgetMs;
  }

  get level(): L {
    return this.#levels[this.#index] as L;
  }

  get explicit(): boolean {
    return this.#explicit;
  }

  /**
   * Feeds one frame. `ms` is the stage's GPU time and `frameMs` the whole frame's; `undefined` is a
   * frame whose GPU time has not resolved. Returns the closed window on the frame that ends one,
   * `undefined` while a window is open.
   */
  observe(ms: number | undefined, frameMs?: number): IBudgetWindow<L> | undefined {
    for (const value of [ms, frameMs]) {
      if (value !== undefined && (!Number.isFinite(value) || value < 0))
        throw new RangeError(
          `BudgetLadder readings must be finite and at least zero, got ${value}.`,
        );
    }
    if (ms !== undefined) {
      this.#samples += 1;
      this.#sum += ms;
    }
    if (frameMs !== undefined) {
      this.#frameSamples += 1;
      this.#frameSum += frameMs;
    }
    this.#frames += 1;
    if (this.#frames < this.#windowFrames) return undefined;
    const closed = this.#close();
    this.#frames = 0;
    this.#samples = 0;
    this.#sum = 0;
    this.#frameSamples = 0;
    this.#frameSum = 0;
    return closed;
  }

  #close(): IBudgetWindow<L> {
    this.#windowNumber += 1;
    const level = this.level;
    const budgetMs = this.#budgetMs[level];
    const samples = this.#samples;
    const frameMs = this.#frameSamples > 0 ? this.#frameSum / this.#frameSamples : undefined;
    const base = {
      budgetMs,
      explicit: this.#explicit,
      frameMs,
      level,
      number: this.#windowNumber,
      samples,
    };
    if (samples < this.#minSamples)
      return { ...base, stepped: undefined, verdict: "unobserved", windowMs: undefined };
    const windowMs = this.#sum / samples;
    if (windowMs > budgetMs) {
      const lower = this.#index - 1;
      if (this.#explicit || lower < 0)
        return { ...base, stepped: undefined, verdict: "over", windowMs };
      this.#fail(level);
      this.#index = lower;
      return { ...base, stepped: this.level, verdict: "over", windowMs };
    }
    const upper = this.#index + 1;
    const upperLevel = this.#levels[upper];
    if (
      !this.#explicit &&
      upperLevel !== undefined &&
      windowMs < this.#stepUpShare * this.#budgetMs[upperLevel] &&
      this.#windowNumber >= (this.#failures.get(upperLevel)?.retryAt ?? 0) &&
      this.#fitsFrame(windowMs, upperLevel)
    ) {
      this.#index = upper;
      return { ...base, stepped: upperLevel, verdict: "under", windowMs };
    }
    return { ...base, stepped: undefined, verdict: "within", windowMs };
  }

  /** The frame has room for the dearer level at its full budget. True when no frame budget is set. */
  #fitsFrame(windowMs: number, upper: L): boolean {
    if (this.#frameBudgetMs === undefined) return true;
    if (this.#frameSamples < this.#minSamples) return false;
    const frameMean = this.#frameSum / this.#frameSamples;
    return frameMean + (this.#budgetMs[upper] - windowMs) <= this.#frameBudgetMs;
  }

  /** The level failed its budget: wait longer each time before trying it again. */
  #fail(level: L): void {
    const count = (this.#failures.get(level)?.count ?? 0) + 1;
    const wait = Math.min(MAX_RETRY_WINDOWS, this.#retryWindows * 2 ** (count - 1));
    this.#failures.set(level, { count, retryAt: this.#windowNumber + wait });
  }
}
