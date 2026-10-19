import type { IComputeDriven } from "@threenative/core";
import type { AvbdRigging } from "./avbd-adapter.js";
import { GpuTimingBatches, type IGpuTimingTick } from "./gpu-timing.js";
import type { ISecondaryTickReceipt } from "./timing-window.js";
import { requiredAt } from "./vendor/required-at.js";

type ComputeRenderer = Parameters<IComputeDriven["process"]>[0];
type CoreReceipt = ReturnType<NonNullable<ComputeRenderer["computeTiming"]>>;
type CoreSamples = NonNullable<ReturnType<CoreReceipt["read"]>>;

export function candidateTimingReceipt(
  row: AvbdRigging["timingRows"][number],
  run: string,
): ISecondaryTickReceipt {
  return Object.freeze({
    generation: row.receipt.generation,
    tick: row.receipt.tick,
    read: () => {
      const ns = row.receipt.read();
      if (ns === undefined) return undefined;
      const interval = (a: number, b: number) => (requiredAt(ns, b) - requiredAt(ns, a)) / 1e6;
      const lower = interval(1, 9);
      if (lower <= 0)
        throw new Error(
          "TN_RIGGING_TIMING_INVALID: solver including clears has no positive duration.",
        );
      return Object.freeze({
        tick: row.receipt.tick,
        cpuSubmissionMs: row.cpuSubmissionMs,
        diagnosticSubmissionMs: row.diagnosticSubmissionMs,
        gpuLowerMs: lower,
        gpuUpperMs: interval(0, 10),
        diagnosticTailUpperMs: interval(9, 10),
        queryIds: Object.freeze(
          Array.from({ length: 11 }, (_, i) => `${run}:candidate:${row.receipt.tick}:stamp:${i}`),
        ),
        phaseMs: Object.freeze(Array.from({ length: 4 }, (_, i) => interval(2 + i * 2, 3 + i * 2))),
      });
    },
  });
}

/** Sail then flag are the two real registry objects; the core receipt binds all four compute calls. */
export class SpringTimings {
  readonly #renderer: ComputeRenderer;
  readonly #batches: GpuTimingBatches;
  readonly #run: string;
  readonly #rows: ISecondaryTickReceipt[] = [];
  #tick = 0;
  #active: { scope: IGpuTimingTick; receipts: CoreReceipt[]; cpuMs: number } | undefined;
  #generation: object | undefined;
  #retired = false;
  #failed = false;
  #failure: unknown;

  constructor(renderer: ComputeRenderer, device: GPUDevice, run: string) {
    if (typeof renderer.computeTiming !== "function")
      throw new Error(
        "TN_RIGGING_TIMING_UNSUPPORTED: exact renderer compute receipts are required.",
      );
    this.#renderer = renderer;
    this.#batches = new GpuTimingBatches(device, 4);
    this.#run = run;
  }
  get rows(): readonly ISecondaryTickReceipt[] {
    return this.#rows;
  }
  get generation(): object {
    this.#live();
    if (this.#generation === undefined)
      throw new Error(
        "TN_RIGGING_TIMING_MISSING: no completed spring tick identifies the generation yet.",
      );
    return this.#generation;
  }

  #live(): void {
    if (this.#retired)
      throw new Error("TN_RIGGING_TIMING_STALE: spring timing generation retired.");
    if (this.#failed) throw this.#failure;
  }
  #fail(error: unknown): never {
    this.#failed = true;
    this.#failure = error;
    this.#active?.scope.abort(error);
    throw error;
  }
  #guard<T>(operation: () => T): T {
    this.#live();
    try {
      return operation();
    } catch (error) {
      return this.#fail(error);
    }
  }
  process(name: string, operation: () => void): void {
    this.#guard(() => {
      if (name === "sail") {
        if (this.#active !== undefined)
          throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: flag did not complete the previous tick.");
        this.#active = { scope: this.#batches.begin(this.#tick), receipts: [], cpuMs: 0 };
      }
      const active = this.#active;
      const index = name === "sail" ? 0 : name === "flag" ? 1 : -1;
      if (active === undefined || index !== active.receipts.length)
        throw new Error(
          "TN_RIGGING_TIMING_MEMBERSHIP: expected real sail then flag registry dispatches.",
        );
      active.scope.bookend(index * 2);
      const start = performance.now();
      const receipt = this.#renderer.computeTiming?.(operation, { maxCalls: 2 });
      const cpuMs = performance.now() - start;
      if (receipt === undefined || receipt.calls.length !== 2)
        throw new Error(
          "TN_RIGGING_TIMING_MISSING: each spring patch must submit exactly two compute calls.",
        );
      active.receipts.push(receipt);
      active.cpuMs += cpuMs;
      active.scope.bookend(index * 2 + 1);
      if (index === 1) {
        const bookends = active.scope.finish();
        this.#generation ??= bookends.generation;
        const cached: (CoreSamples | undefined)[] = [undefined, undefined];
        let ns: readonly number[] | undefined;
        let consumed = false;
        this.#rows.push(
          Object.freeze({
            generation: bookends.generation,
            tick: this.#tick,
            read: () =>
              this.#guard(() => {
                if (consumed)
                  throw new Error(
                    "TN_RIGGING_TIMING_DUPLICATE: completed spring tick consumed twice.",
                  );
                ns ??= bookends.read();
                for (const [i, core] of active.receipts.entries()) cached[i] ??= core.read();
                if (ns === undefined || cached.some((samples) => samples === undefined))
                  return undefined;
                const samples = cached.flatMap((values) => values ?? []);
                if (samples.length !== 4)
                  throw new Error("TN_RIGGING_TIMING_MISSING: four spring calls must complete.");
                consumed = true;
                return Object.freeze({
                  tick: bookends.tick,
                  cpuSubmissionMs: active.cpuMs,
                  diagnosticSubmissionMs: 0,
                  diagnosticTailUpperMs: 0,
                  // Without absolute endpoints the maximum mandatory pass is a proven lower bound.
                  // Report all four phase durations separately; their sum is not assumed nonoverlapping.
                  gpuLowerMs: Math.max(...samples.map((sample) => sample.gpuMs)),
                  // Empty marker passes may be stamped before earlier work ends (Mesa), so the span alone
                  // can undercut a pass; GPU busy time never exceeds the summed pass durations.
                  gpuUpperMs: Math.max(
                    (requiredAt(ns, 3) - requiredAt(ns, 0)) / 1e6,
                    samples.reduce((sum, sample) => sum + sample.gpuMs, 0),
                  ),
                  queryIds: Object.freeze(
                    samples.map((sample) => `${this.#run}:spring:${sample.uid}`),
                  ),
                  phaseMs: Object.freeze(samples.map((sample) => sample.gpuMs)),
                });
              }),
          }),
        );
        this.#tick += 1;
        this.#active = undefined;
      }
    });
  }
  settle(): Promise<void> {
    return this.#guard(() => {
      if (this.#active !== undefined)
        throw new Error("TN_RIGGING_TIMING_MISSING: spring tick is missing its flag dispatch.");
      return this.#batches.settle().catch((error: unknown) => this.#fail(error));
    });
  }
  retire(): Promise<void> {
    this.#retired = true;
    return this.#batches.retire();
  }
}
