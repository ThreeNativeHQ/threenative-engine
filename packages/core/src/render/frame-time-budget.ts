/**
 * The frame-period rule that decides when a render cost moves, as Unreal's DynamicRenderScaling does.
 *
 * It compares the whole GPU frame with the frame period, never one stage's milliseconds. A stage
 * reading depends on the GPU clock (the SSGI pass read 6.3 ms at P5 and 2.1 to 3.0 ms at boost on one
 * scene), and the frame period does not. The rule follows UE 5.8.3:
 * `Engine/Source/Runtime/Engine/Private/DynamicResolution.cpp` (the `r.DynamicRes.*` defaults at
 * `:32-103`, the history walk at `:219-330`, the change gate at `:370-390`) and
 * `Engine/Source/Runtime/RenderCore/Private/DynamicRenderScaling.cpp` (`GetTargetedMs`,
 * `EstimateResolutionFactor`, `DoesResolutionChangeEnough`).
 *
 * Measurement and decision only: the caller applies a move and calls `reset()`, because the frames of
 * the old level say nothing about the new one.
 */

export type FrameTimeModel = "linear" | "quadratic";

export interface IFrameTimeBudgetOptions {
  /** The frame period in milliseconds: `r.DynamicRes.FrameTimeBudget`, such as 1000 / 60. */
  readonly periodMs: number;
  /** The share of the period to keep free: `TargetedGPUHeadRoomPercentage`. Default 0.10. */
  readonly headroom?: number;
  /** Frames kept in the history: `r.DynamicRes.HistorySize`. Default 16. */
  readonly historyFrames?: number;
  /** Weight of frame N-1 against frame N: `r.DynamicRes.FrameWeightExponent`. Default 0.9. */
  readonly frameWeight?: number;
  /** Frames between two changes: `r.DynamicRes.MinResolutionChangePeriod`. Default 8. */
  readonly minChangeFrames?: number;
  /** Consecutive frames over the period that force an immediate drop: `MaxConsecutiveOverBudgetGPUFrameCount`. Default 2. */
  readonly panicFrames?: number;
  /** The smallest move worth a change: `ChangePercentageThreshold`. Default 0.02. */
  readonly changeThreshold?: number;
  /** How cost scales with the lever: pixels are quadratic in the resolution fraction, a throttle is linear. Default quadratic. */
  readonly model?: FrameTimeModel;
}

export type FrameDirection = "down" | "up" | "hold";

/** What the rule says about the newest frame. */
export interface IFrameTimeDecision {
  readonly direction: FrameDirection;
  /** Two or more consecutive frames over the period: the drop skips the change-period gate. */
  readonly panic: boolean;
  /** Weighted estimate of the lever scale the history supports: below 1 the frame is too dear, above 1 it has room. */
  readonly suggested: number | undefined;
  /** Weighted mean frame milliseconds of the frames the rule read. */
  readonly meanMs: number | undefined;
  /** Frames the rule read. */
  readonly frames: number;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(
      `FrameTimeBudget ${name} must be a finite number above zero, got ${value}.`,
    );
  return value;
}

export class FrameTimeBudget {
  readonly periodMs: number;
  readonly targetMs: number;
  readonly #historyFrames: number;
  readonly #frameWeight: number;
  readonly #minChangeFrames: number;
  readonly #panicFrames: number;
  readonly #changeThreshold: number;
  readonly #model: FrameTimeModel;
  /** Newest last. */
  #history: number[] = [];
  #framesSinceChange = 0;

  constructor(options: IFrameTimeBudgetOptions) {
    this.periodMs = positive(options.periodMs, "periodMs");
    const headroom = options.headroom ?? 0.1;
    if (!(headroom >= 0 && headroom < 1))
      throw new RangeError("FrameTimeBudget headroom must be in [0, 1).");
    this.targetMs = this.periodMs * (1 - headroom);
    this.#historyFrames = Math.floor(positive(options.historyFrames ?? 16, "historyFrames"));
    this.#frameWeight = positive(options.frameWeight ?? 0.9, "frameWeight");
    this.#minChangeFrames = Math.max(0, Math.floor(options.minChangeFrames ?? 8));
    this.#panicFrames = Math.max(2, Math.floor(options.panicFrames ?? 2));
    this.#changeThreshold = options.changeThreshold ?? 0.02;
    if (!(this.#changeThreshold >= 0 && this.#changeThreshold < 1))
      throw new RangeError("FrameTimeBudget changeThreshold must be in [0, 1).");
    this.#model = options.model ?? "quadratic";
  }

  /** The caller applied a move: the old frames and the change-period count start again. */
  reset(): void {
    this.#history = [];
    this.#framesSinceChange = 0;
  }

  /**
   * Feeds one loop frame: the whole GPU frame in milliseconds, or `undefined` for a frame whose GPU
   * time has not resolved (it counts toward the change period and enters no history).
   */
  observe(frameMs: number | undefined): IFrameTimeDecision {
    if (frameMs !== undefined) {
      if (!Number.isFinite(frameMs) || frameMs < 0)
        throw new RangeError(
          `FrameTimeBudget readings must be finite and at least zero, got ${frameMs}.`,
        );
      this.#history.push(frameMs);
      if (this.#history.length > this.#historyFrames) this.#history.shift();
    }
    this.#framesSinceChange += 1;
    const walk = this.#walk();
    if (walk === undefined)
      return {
        direction: "hold",
        frames: 0,
        meanMs: undefined,
        panic: false,
        suggested: undefined,
      };
    const { consecutive, frames, meanMs, suggested } = walk;
    // Unreal panics when every frame it read is over the period. A one-entry history is the first
    // frame after a reset, so the run needs `panicFrames` frames to count as a run.
    const panic = consecutive === frames && frames >= this.#panicFrames;
    if (panic) return { direction: "down", frames, meanMs, panic, suggested };
    if (this.#framesSinceChange < this.#minChangeFrames)
      return { direction: "hold", frames, meanMs, panic, suggested };
    const direction: FrameDirection =
      suggested < 1 - this.#changeThreshold
        ? "down"
        : suggested > 1 + this.#changeThreshold
          ? "up"
          : "hold";
    return { direction, frames, meanMs, panic, suggested };
  }

  /** Newest first, stopping at the panic run: frames before it say nothing about now. */
  #walk(): { consecutive: number; frames: number; meanMs: number; suggested: number } | undefined {
    let weight = 1;
    let totalWeight = 0;
    let sumSuggested = 0;
    let sumMs = 0;
    let consecutive = 0;
    let frames = 0;
    for (let at = this.#history.length - 1; at >= 0; at--) {
      const ms = this.#history[at] as number;
      consecutive = ms > this.periodMs ? consecutive + 1 : 0;
      const ratio = ms === 0 ? Number.POSITIVE_INFINITY : this.targetMs / ms;
      const scale = this.#model === "quadratic" ? Math.sqrt(ratio) : ratio;
      sumSuggested += Math.min(scale, 1e6) * weight;
      sumMs += ms * weight;
      totalWeight += weight;
      frames += 1;
      weight *= this.#frameWeight;
      if (consecutive === this.#panicFrames) break;
    }
    if (frames === 0) return undefined;
    return {
      consecutive,
      frames,
      meanMs: sumMs / totalWeight,
      suggested: sumSuggested / totalWeight,
    };
  }
}
