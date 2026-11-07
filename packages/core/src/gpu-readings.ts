/**
 * One owner for a GPU timing series: the sample, the frame it belongs to, how stale it is, and the
 * smoothed value a decision may act on.
 *
 * The renderer, the resolution scaler and the frame budget each worked this out for themselves, with
 * three different freshness rules — consecutive stale frames in the renderer, an absolute age in the
 * scaler, "did the frame id repeat" in the budget — so the same reading could be current for one
 * subsystem and stale for another with nothing failing. The numbers they disagree about now live
 * here once, and each caller says which rule it wants.
 *
 * Nothing here decides how anything looks: it takes the milliseconds the engine resolved and answers
 * whether they describe the frame under consideration.
 */

/** Samples older than this many consecutive stale frames are dropped by the adaptive loop. */
export const GPU_STALE_FRAME_LIMIT = 8;

/**
 * A resolved sample stays usable for a window decision this many frames after its own frame. The
 * scaler reads this; its own age check stays inline because it rejects an unknown age where a series
 * would treat one as fresh.
 */
export const GPU_READING_MAX_AGE_FRAMES = 16;

/** Window GPU samples that make a window's own median fresh evidence when the latest is too old. */
export const GPU_WINDOW_MIN_SAMPLES = 4;

/** One resolved GPU time and the drawn frame it was submitted under. */
export interface IGpuReading {
  /** Milliseconds, finite and non-negative as the engine reports them. */
  readonly ms: number;
  /** The drawn frame that submitted the sample, when the caller knows it. */
  readonly frame?: number;
}

/** How a series smooths and when it gives up; the defaults are the engine's. */
export interface IGpuReadingsOptions {
  /** Weight of a new sample: 0.5 is half/half, 1 keeps only the newest. */
  readonly smoothing?: number;
  /** Consecutive stale notes that drop the smoothed value. */
  readonly staleLimit?: number;
}

/**
 * A GPU series fed one resolved sample at a time.
 *
 * A repeated frame id is the previous resolve still in flight, not a new measurement, so it counts
 * as stale — that rule is the one three callers each wrote for themselves.
 */
export class GpuReadings {
  readonly #smoothing: number;
  readonly #staleLimit: number;
  #ema: number | undefined;
  #lastFrame: number | undefined;
  #last: IGpuReading | undefined;
  #stale = 0;

  constructor(options: IGpuReadingsOptions = {}) {
    this.#smoothing = options.smoothing ?? 0.5;
    this.#staleLimit = options.staleLimit ?? GPU_STALE_FRAME_LIMIT;
  }

  /** The smoothed value a decision may act on, or `undefined` when the series went stale. */
  get ema(): number | undefined {
    return this.#ema;
  }

  /** The newest accepted reading, before smoothing. */
  get last(): IGpuReading | undefined {
    return this.#last;
  }

  /** Whether `frame` repeated the last accepted sample, which is a resolve still in flight. */
  repeats(frame: number | undefined): boolean {
    return frame !== undefined && frame === this.#lastFrame;
  }

  /** Records one resolved sample. `undefined`, a non-number or a negative value counts as stale. */
  note(ms: number | undefined, frame?: number): void {
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
      this.#markStale();
      return;
    }
    if (this.repeats(frame)) {
      this.#markStale();
      return;
    }
    if (frame !== undefined) this.#lastFrame = frame;
    this.#stale = 0;
    this.#last = frame === undefined ? { ms } : { frame, ms };
    this.#ema = this.#ema === undefined ? ms : this.#ema + (ms - this.#ema) * this.#smoothing;
  }

  #markStale(): void {
    this.#stale += 1;
    if (this.#stale >= this.#staleLimit) this.#ema = undefined;
  }
}
