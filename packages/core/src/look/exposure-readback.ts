import type { RenderTarget } from "three";
import type { Renderer } from "three/webgpu";

/**
 * A cold start reads a target the adapt pass has not drawn yet: pipelines compile asynchronously,
 * so the first draws are skipped and the 1x1 target is still all zero. The adapt pass can also draw
 * before the histogram pass has: then its histogram is empty and it writes -1 into luminance. This
 * happens at a cold start and after every reset. Both are "not measured yet": retry on the next
 * frame, and fail only when no measurement arrives. Any other bad value fails at once.
 */
const COLD_READS_BEFORE_FAILURE = 120;

export class ExposureReadback {
  #cold = 0;
  #pending = false;
  #generation = 0;
  #lastReport = Number.NEGATIVE_INFINITY;
  #disposed = false;
  #value: Record<string, unknown>;
  constructor(
    readonly constant: number,
    readonly enabled: () => boolean,
  ) {
    this.#value = { measured: false, applied: enabled() };
  }
  invalidate(): void {
    this.#generation++;
    this.#value = { measured: false, applied: this.enabled() };
    this.#lastReport = Number.NEGATIVE_INFINITY;
  }
  get(): Record<string, unknown> {
    return { ...this.#value };
  }
  dispose(): void {
    this.#disposed = true;
    this.#generation++;
  }
  report(renderer: Renderer, result: RenderTarget, time: number, interval: number): void {
    if (this.#pending || time - this.#lastReport < interval) return;
    this.#pending = true;
    this.#lastReport = time;
    const generation = this.#generation;
    const current = () => !this.#disposed && generation === this.#generation;
    const enabled = this.enabled;
    const constant = this.constant;
    const publish = (observation: Record<string, unknown>) => {
      this.#value = observation;
    };
    const finished = () => {
      this.#pending = false;
    };
    void renderer
      .readRenderTargetPixelsAsync(result, 0, 0, 1, 1)
      .then((values) => {
        if (!current()) return;
        if (
          values instanceof Float32Array &&
          (values[1] === 0 || values[1] === -1) &&
          ++this.#cold < COLD_READS_BEFORE_FAILURE
        ) {
          this.#lastReport = Number.NEGATIVE_INFINITY;
          return;
        }
        this.#cold = 0;
        if (
          !(values instanceof Float32Array) ||
          values.length < 4 ||
          !Array.from(values).every(Number.isFinite) ||
          (values[1] ?? 0) <= 0
        )
          throw new Error("Exposure readback is invalid; measurement is unavailable.");
        const observation = {
          measured: true,
          applied: enabled(),
          luminance: values[1],
          exposureStops: enabled() ? values[0] : Math.log2(constant),
          targetStops: values[2],
          settled: values[3] === 1,
        };
        publish(observation);
        console.info(`TN_AUTO_EXPOSURE:${JSON.stringify(observation)}`);
      })
      .catch((error: unknown) => {
        if (!current()) return;
        const observation = {
          measured: false,
          applied: enabled(),
          reason: String(error),
        };
        publish(observation);
        console.error(`TN_AUTO_EXPOSURE:${JSON.stringify(observation)}`);
      })
      .finally(() => {
        finished();
      });
  }
}
