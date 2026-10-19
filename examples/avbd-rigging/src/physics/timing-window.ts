import type { IPipelineCensus } from "@threenative/core";
import { requiredAt } from "./vendor/required-at.js";

export interface ISecondaryTickSample {
  readonly tick: number;
  readonly cpuSubmissionMs: number;
  readonly diagnosticSubmissionMs: number;
  readonly gpuLowerMs: number;
  /** Queue elapsed envelope includes CPU/queue idle; this is not GPU busy time. */
  readonly gpuUpperMs: number;
  readonly diagnosticTailUpperMs: number;
  readonly queryIds: readonly string[];
  readonly phaseMs: readonly number[];
}
export interface ISecondaryTickReceipt {
  readonly generation: object;
  readonly tick: number;
  read(): ISecondaryTickSample | undefined;
}
export interface ISecondaryFrameSample {
  readonly frame: number;
  readonly renderCallbackAtMs: number;
  readonly renderCallbackElapsedMs: number;
  readonly compilation?: {
    readonly compileCount: number;
    readonly census: Pick<IPipelineCensus, "complete" | "overflowed" | "unsupported" | "counts">;
  };
  readonly ticks: readonly ISecondaryTickSample[];
  readonly cpuSubmissionMs: number;
  readonly diagnosticSubmissionMs: number;
  readonly gpuLowerMs: number;
  readonly gpuUpperMs: number;
  readonly diagnosticTailUpperMs: number;
}

function observed(sample: ISecondaryTickSample): void {
  if (
    !Array.isArray(sample.phaseMs) ||
    sample.phaseMs.length !== 4 ||
    !Array.isArray(sample.queryIds)
  )
    throw new Error(
      "TN_RIGGING_TIMING_INVALID: four phases and dense query membership are required.",
    );
  const numbers = [
    sample.cpuSubmissionMs,
    sample.diagnosticSubmissionMs,
    sample.gpuLowerMs,
    sample.gpuUpperMs,
    sample.diagnosticTailUpperMs,
    ...Array.from(sample.phaseMs),
  ];
  const fault = numbers.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
    ? "nonfinite or negative value"
    : sample.gpuLowerMs <= 0
      ? "zero GPU lower bound"
      : sample.gpuLowerMs > sample.gpuUpperMs
        ? "GPU lower bound above queue upper bound"
        : sample.queryIds.length === 0 ||
            Array.from(sample.queryIds).some((id) => typeof id !== "string" || id.length === 0) ||
            new Set(sample.queryIds).size !== sample.queryIds.length
          ? "missing or duplicate query ids"
          : undefined;
  if (fault !== undefined)
    throw new Error(
      `TN_RIGGING_TIMING_INVALID: missing, nonfinite or inconsistent tick data (${fault}; lower ${sample.gpuLowerMs} ms, upper ${sample.gpuUpperMs} ms, phases ${Array.from(sample.phaseMs).join("/")}).`,
    );
}

/** Original 300-ready-frame warmup and 1800 measured render frames, retaining every fixed tick. */
export class SecondaryTimingWindow {
  readonly #generation: object;
  readonly #receipts = new Map<number, ISecondaryTickReceipt>();
  readonly #samples = new Map<number, ISecondaryTickSample>();
  readonly #frames: { ticks: number[]; atMs: number }[] = [];
  readonly #queries = new Set<string>();
  #current: number[] = [];
  #lastTick = -1;
  #sealed = false;
  #retired = false;
  #failed = false;
  #failure: unknown;

  constructor(generation: object, firstTick = 0) {
    if (generation === null || typeof generation !== "object" || Array.isArray(generation))
      throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: an opaque generation is required.");
    if (!Number.isSafeInteger(firstTick) || firstTick < 0 || firstTick > 12000)
      throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: bounded initial fixed tick is required.");
    this.#generation = generation;
    this.#lastTick = firstTick - 1;
  }
  get frames(): number {
    return this.#frames.length;
  }
  get completedTicks(): number {
    return this.#samples.size;
  }
  get sealed(): boolean {
    return this.#sealed;
  }

  #live(): void {
    if (this.#failed) throw this.#failure;
    if (this.#retired) throw new Error("TN_RIGGING_TIMING_STALE: window generation retired.");
  }
  #guard<T>(operation: () => T): T {
    this.#live();
    try {
      return operation();
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
      throw error;
    }
  }
  add(receipt: ISecondaryTickReceipt): void {
    this.#guard(() => {
      if (this.#sealed)
        throw new Error("TN_RIGGING_TIMING_SEALED: measured window already closed.");
      if (
        receipt.generation !== this.#generation ||
        !Number.isSafeInteger(receipt.tick) ||
        receipt.tick < 0 ||
        receipt.tick !== this.#lastTick + 1 ||
        this.#receipts.has(receipt.tick)
      )
        throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: stale, duplicate or missing fixed tick.");
      if (this.#current.length >= 5)
        throw new Error(
          "TN_RIGGING_TIMING_CAPACITY: existing loop permits at most five ticks per render frame.",
        );
      this.#lastTick = receipt.tick;
      this.#current.push(receipt.tick);
      this.#receipts.set(receipt.tick, receipt);
    });
  }
  /** Called once by Scene.render, after the real fixed-step registry, never by process(). */
  frame(observation: { readonly atMs: number; readonly paused: boolean }): boolean {
    return this.#guard(() => {
      if (this.#sealed)
        throw new Error("TN_RIGGING_TIMING_SEALED: frame added after the exact window.");
      const previous = this.#frames.at(-1);
      if (
        observation === null ||
        typeof observation !== "object" ||
        typeof observation.atMs !== "number" ||
        !Number.isFinite(observation.atMs) ||
        observation.atMs < 0 ||
        observation.paused !== false ||
        (previous !== undefined && observation.atMs <= previous.atMs)
      )
        throw new Error(
          "TN_RIGGING_TIMING_CADENCE: unpaused monotonic render callback time is required.",
        );
      this.#frames.push({ ticks: this.#current, atMs: observation.atMs });
      this.#current = [];
      this.#sealed = this.#frames.length === 2100;
      return this.#sealed;
    });
  }
  /** Poll completed membership from the existing render callback, without awaiting GPU work. */
  collect(): void {
    this.#guard(() => {
      const staged = new Map<number, ISecondaryTickSample>();
      const queries = new Set(this.#queries);
      for (const [tick, receipt] of this.#receipts) {
        if (this.#samples.has(tick)) continue;
        const sample = receipt.read();
        if (sample === undefined) continue;
        if (sample.tick !== tick)
          throw new Error("TN_RIGGING_TIMING_MEMBERSHIP: completed tick changed identity.");
        observed(sample);
        for (const id of sample.queryIds) {
          if (queries.has(id))
            throw new Error("TN_RIGGING_TIMING_DUPLICATE: query supplied multiple ticks.");
          queries.add(id);
        }
        staged.set(
          tick,
          Object.freeze({
            ...sample,
            queryIds: Object.freeze([...sample.queryIds]),
            phaseMs: Object.freeze([...sample.phaseMs]),
          }),
        );
      }
      for (const [tick, sample] of staged) this.#samples.set(tick, sample);
      for (const id of queries) this.#queries.add(id);
    });
  }
  /** Absent pending data is incomplete, never zero. The final rows preserve zero-tick render frames. */
  result(): readonly ISecondaryFrameSample[] | undefined {
    return this.#guard(() => {
      if (!this.#sealed || this.#samples.size !== this.#receipts.size) return undefined;
      if (this.#receipts.size === 0)
        throw new Error("TN_RIGGING_TIMING_MISSING: no simulation tick was observed.");
      const rows = this.#frames.slice(300).map((frame, index) => {
        const ticks = frame.ticks.map((id) => {
          const sample = this.#samples.get(id);
          if (sample === undefined)
            throw new Error("TN_RIGGING_TIMING_MISSING: frame lost its tick.");
          return sample;
        });
        const sum = (
          key:
            | "cpuSubmissionMs"
            | "diagnosticSubmissionMs"
            | "gpuLowerMs"
            | "gpuUpperMs"
            | "diagnosticTailUpperMs",
        ) => ticks.reduce((total, tick) => total + tick[key], 0);
        return Object.freeze({
          frame: index + 300,
          renderCallbackAtMs: frame.atMs,
          renderCallbackElapsedMs: frame.atMs - requiredAt(this.#frames, index + 299).atMs,
          ticks: Object.freeze(ticks),
          cpuSubmissionMs: sum("cpuSubmissionMs"),
          diagnosticSubmissionMs: sum("diagnosticSubmissionMs"),
          // Duration-only receipts cannot establish nonoverlap between independent fixed ticks.
          gpuLowerMs: Math.max(0, ...ticks.map((tick) => tick.gpuLowerMs)),
          gpuUpperMs: sum("gpuUpperMs"),
          diagnosticTailUpperMs: sum("diagnosticTailUpperMs"),
        });
      });
      if (rows.length !== 1800 || rows.every((row) => row.ticks.length === 0))
        throw new Error("TN_RIGGING_TIMING_MISSING: the measured simulation window is empty.");
      const elapsedMs = requiredAt(this.#frames, 2099).atMs - requiredAt(this.#frames, 299).atMs;
      const ticks = rows.reduce((total, row) => total + row.ticks.length, 0);
      // At each boundary the existing accumulator can own at most five catch-up ticks.
      // Report all frames, but never let a paused/dropped fixed workload qualify as cheap simulation.
      if (Math.abs(ticks - (elapsedMs * 60) / 1000) > 5)
        throw new Error(
          `TN_RIGGING_TIMING_CADENCE: ${ticks} measured ticks do not cover ${elapsedMs} ms at1/60s.`,
        );
      return Object.freeze(rows);
    });
  }
  retire(): void {
    this.#retired = true;
  }
}

/** Full-precision nearest-rank p95; FrameBudget's rounded summaries cannot decide a 0.5 ms boundary. */
export function timingP95(values: readonly number[]): number {
  if (
    !Array.isArray(values) ||
    values.length !== 1800 ||
    Array.from(values).some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)
  )
    throw new Error(
      "TN_RIGGING_TIMING_MISSING: exactly 1800 finite frame observations are required.",
    );
  return requiredAt(
    [...values].sort((a, b) => a - b),
    Math.ceil(values.length * 0.95) - 1,
  );
}
