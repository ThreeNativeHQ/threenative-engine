import type { Camera } from "three";
import type { IFrameBudgetWindow } from "./frame-budget.js";

/** One simulation that can yield its compute work. */
export interface IBudgetCandidate {
  /** Return projected size, or undefined when this simulation costs nothing. */
  significance(camera: Camera): number | undefined;
  /** Pause or resume without changing the simulation's buffers. */
  yield(yielded: boolean): void;
}

export interface IParticleSignificanceOptions {
  /**
   * Fraction of compute shedding recovered per second. Defaults to 0.1.
   * @situation Let effects return gradually after GPU pressure falls.
   * @constraint Must be finite and non-negative.
   */
  readonly decayPerSecond?: number;
  /**
   * Seconds between changes to one candidate. Defaults to 1.
   * @situation Keep effects from flickering as GPU pressure changes.
   * @constraint Must be finite and non-negative.
   */
  readonly graceSeconds?: number;
}

/**
 * Yield the least significant simulations using measured GPU compute cost.
 * @situation Keep particle simulation within the measured frame budget.
 * @constraint Missing GPU measurements never increase shedding.
 */
export class ParticleSignificance {
  #shed = 0;
  readonly #decayPerSecond: number;
  readonly #graceSeconds: number;
  readonly #states = new WeakMap<IBudgetCandidate, { yielded: boolean; changedAt: number }>();

  constructor(options: IParticleSignificanceOptions = {}) {
    // Reference: UE 5.8.3 FXBudget.cpp and NiagaraEffectType.h use 0.1/s decay and 1 s grace.
    this.#decayPerSecond = options.decayPerSecond ?? 0.1;
    this.#graceSeconds = options.graceSeconds ?? 1;
    for (const [name, value] of Object.entries({
      decayPerSecond: this.#decayPerSecond,
      graceSeconds: this.#graceSeconds,
    })) {
      if (!Number.isFinite(value) || value < 0)
        throw new Error(`ParticleSignificance.${name} must be finite and non-negative.`);
    }
  }

  observe(
    window: Pick<IFrameBudgetWindow, "frames" | "presented" | "gpuMs" | "gpuCompute" | "targetFps">,
  ): void {
    const { gpuMs, gpuCompute, targetFps } = window;
    const raw =
      gpuMs !== undefined &&
      Number.isFinite(gpuMs) &&
      gpuMs >= 0 &&
      gpuCompute !== undefined &&
      Number.isFinite(gpuCompute) &&
      gpuCompute > 0 &&
      targetFps !== undefined &&
      Number.isFinite(targetFps) &&
      targetFps > 0
        ? // Render mean plus compute p50 estimates the frame; the pools are reported separately.
          Math.max(0, Math.min(1, (gpuMs + gpuCompute - 1000 / targetFps) / gpuCompute))
        : 0;
    const elapsed = (window.frames * window.presented.mean) / 1000;
    const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    this.#shed = Math.max(raw, this.#shed - this.#decayPerSecond * seconds);
  }

  get shed(): number {
    return this.#shed;
  }

  apply(candidates: Iterable<IBudgetCandidate>, camera: Camera, nowSeconds: number): void {
    const ranked: { candidate: IBudgetCandidate; significance: number }[] = [];
    for (const candidate of candidates) {
      const significance = candidate.significance(camera);
      if (significance !== undefined) ranked.push({ candidate, significance });
    }
    ranked.sort((a, b) => a.significance - b.significance);
    const count = Math.ceil(this.#shed * ranked.length);
    for (const [index, { candidate }] of ranked.entries()) {
      let state = this.#states.get(candidate);
      if (state === undefined) {
        state = { yielded: false, changedAt: Number.NEGATIVE_INFINITY };
        this.#states.set(candidate, state);
      }
      const yielded = index < count;
      if (state.yielded === yielded || nowSeconds - state.changedAt < this.#graceSeconds) continue;
      candidate.yield(yielded);
      state.yielded = yielded;
      state.changedAt = nowSeconds;
    }
  }
}
