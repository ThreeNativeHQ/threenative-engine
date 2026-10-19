// Generated for you: async GPU observations stay tied to their owner's live generation.
import type { RenderTarget } from "three";
import type { Renderer } from "three/webgpu";

export class ExposureReadback {
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
