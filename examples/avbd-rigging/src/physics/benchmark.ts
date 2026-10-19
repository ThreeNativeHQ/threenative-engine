import type { IPipelineCensus } from "@threenative/core";
import {
  type ISecondaryFrameSample,
  type ISecondaryTickReceipt,
  SecondaryTimingWindow,
  timingP95,
} from "./timing-window.js";
import { referenceRigging } from "./topology.js";
import { requiredAt } from "./vendor/required-at.js";
const frozenInput = referenceRigging();
for (const rope of frozenInput.ropes) rope.pinned = [0];

/** Frozen before any timed window; geometry/resolution/mapping never change between the paired arms. */
export const riggingComparison = Object.freeze({
  construction: "83b25adb24f671e93a55683913ca9a794dc0f613",
  solver: "b3675dea83c78aba9644b059975f48285bf02a47",
  sail: "4m x4m,32x32vertices,9.6kg",
  flag: "16x16vertices,0.6kg",
  ropes: "4x64segments,0.4kg each,free lower ends; no incumbent rope speedup claim",
  authoredTopology: JSON.stringify(frozenInput),
  fixedStep: 1 / 60,
  maximumCatchUp: 5,
  gravity: Object.freeze([0, -9.81, 0]),
  wind: "constant6m/s,spatial/temporal gust off; original flat-plate spring acceleration mapping",
  anchors: "stationary accepted Rapier mast; identical authored pins/proxies",
  camera: Object.freeze([10, 8, 14, 0.5, 4, 0]),
  resolutionScale: 1,
  maxFps: 60,
  springStiffness: 1000,
  springDamping: 1.8,
  candidateIterations: 12,
  candidateParameters: Object.freeze({
    dt: 1 / 60,
    gravity: -9.81,
    iterations: 12,
    alpha: 0.95,
    betaLin: 10000,
    betaAng: 100,
    gamma: 0.999,
  }),
  warmupFrames: 300,
  measuredFrames: 1800,
  pairs: 3,
  clock: "existing wall-clock frame pump; observations at Scene.render callback",
  candidatePartition: "four split passes in timed/untimed runs; three clears included",
  baselineLower: "maximum mandatory pass; four-pass sum has no claimed endpoint-ordering proof",
  queueUpper: "whole-tick queue elapsed includes host/queue idle; not GPU busy time",
});
export interface IRiggingRun {
  readonly id: string;
  readonly pair: number;
  readonly arm: "candidate" | "spring";
  readonly diagnostics: boolean;
}
export const riggingRuns: readonly IRiggingRun[] = Object.freeze(
  [
    { id: "pair1-candidate", pair: 1, arm: "candidate", diagnostics: false },
    { id: "pair1-spring", pair: 1, arm: "spring", diagnostics: false },
    { id: "pair2-spring", pair: 2, arm: "spring", diagnostics: false },
    { id: "pair2-candidate", pair: 2, arm: "candidate", diagnostics: false },
    { id: "pair3-candidate", pair: 3, arm: "candidate", diagnostics: false },
    { id: "pair3-spring", pair: 3, arm: "spring", diagnostics: false },
    { id: "candidate-diagnostics", pair: 0, arm: "candidate", diagnostics: true },
  ].map((run) => Object.freeze(run as IRiggingRun)),
);
export interface IRiggingTimingSource {
  count(): number;
  receipt(index: number): ISecondaryTickReceipt;
  settle(): Promise<void>;
}

export interface IRiggingReadinessObservation {
  readonly ready: boolean;
  readonly compiling: boolean;
  readonly compileCount: number;
  readonly census?: Pick<IPipelineCensus, "complete" | "overflowed" | "unsupported" | "counts">;
}

/** Polled by the existing Scene.render callback; owns no device, frame pump or independent clock. */
export class RiggingBenchmark {
  readonly #source: IRiggingTimingSource;
  readonly #pause: () => void;
  #window: SecondaryTimingWindow | undefined;
  #cursor = 0;
  #settled = false;
  #failed = false;
  #failure: unknown;
  #completed = false;
  #retired = false;
  #measurementCompileCount: number | undefined;
  #censusIdentity: string | undefined;
  #frameCompilations: NonNullable<ISecondaryFrameSample["compilation"]>[] = [];
  #admission: Readonly<{ atMs: number; firstTick: number; skippedReceipts: number }> | undefined;
  constructor(source: IRiggingTimingSource, pause: () => void) {
    this.#source = source;
    this.#pause = pause;
  }
  get admission() {
    return this.#admission;
  }
  get frames(): number {
    return this.#window?.frames ?? 0;
  }
  render(
    atMs: number,
    paused: boolean,
    readiness: IRiggingReadinessObservation,
  ): readonly ISecondaryFrameSample[] | undefined {
    if (this.#retired) throw new Error("TN_RIGGING_TIMING_STALE: benchmark scene retired.");
    if (this.#failed) throw this.#failure;
    if (this.#completed) return undefined;
    try {
      if (
        readiness === undefined ||
        typeof readiness.ready !== "boolean" ||
        typeof readiness.compiling !== "boolean" ||
        !Number.isSafeInteger(readiness.compileCount) ||
        readiness.compileCount < 0
      )
        throw new Error(
          "TN_RIGGING_TIMING_READINESS: actual compilation/readiness observation is required.",
        );
      const census = readiness.census;
      let censusIdentity: string | undefined;
      if (readiness.ready) {
        if (
          census === undefined ||
          census.complete !== true ||
          census.overflowed !== false ||
          census.unsupported !== false ||
          census.counts.failures !== 0 ||
          census.counts.pending !== 0 ||
          census.counts.droppedEvents !== 0
        )
          throw new Error(
            "TN_RIGGING_TIMING_READINESS: complete stable device pipeline census is required.",
          );
        const counts = [
          census.counts.creations,
          census.counts.uniquePrograms,
          census.counts.uniquePipelines,
          census.counts.recordedEvents,
          census.counts.deviceCreations,
          census.counts.directCreations,
        ];
        if (counts.some((count) => !Number.isSafeInteger(count) || (count ?? -1) < 0))
          throw new Error("TN_RIGGING_TIMING_READINESS: actual device creation counts are absent.");
        censusIdentity = JSON.stringify(counts);
      }
      if (this.#window === undefined) {
        if (!readiness.ready || readiness.compiling || this.#source.count() === 0) return undefined;
        this.#cursor = this.#source.count() - 1;
        const first = this.#source.receipt(this.#cursor);
        this.#window = new SecondaryTimingWindow(first.generation, first.tick);
        this.#measurementCompileCount = readiness.compileCount;
        this.#censusIdentity = censusIdentity;
        this.#admission = Object.freeze({
          atMs,
          firstTick: first.tick,
          skippedReceipts: this.#cursor,
        });
      }
      const window = this.#window;
      if (window === undefined) return undefined;
      if (
        !window.sealed &&
        (!readiness.ready ||
          readiness.compiling ||
          readiness.compileCount !== this.#measurementCompileCount ||
          censusIdentity !== this.#censusIdentity)
      )
        throw new Error(
          "TN_RIGGING_TIMING_READINESS: post-ready window overlapped compilation or lost readiness.",
        );
      while (this.#cursor < this.#source.count()) window.add(this.#source.receipt(this.#cursor++));
      if (!window.sealed) {
        if (census === undefined)
          throw new Error("TN_RIGGING_TIMING_READINESS: census disappeared.");
        this.#frameCompilations.push(
          Object.freeze({
            compileCount: readiness.compileCount,
            census: Object.freeze({
              complete: census.complete,
              overflowed: census.overflowed,
              unsupported: census.unsupported,
              counts: Object.freeze({ ...census.counts }),
            }),
          }),
        );
      }
      if (!window.sealed && window.frame({ atMs, paused })) {
        this.#pause(); // Admission stops synchronously before settling maps; fixed callbacks never await.
        void this.#source.settle().then(
          () => {
            if (!this.#retired) this.#settled = true;
          },
          (error: unknown) => {
            this.#failed = true;
            this.#failure = error;
          },
        );
      }
      window.collect();
      if (!this.#settled) return undefined;
      const result = window.result();
      this.#completed = result !== undefined;
      return result?.map((row) =>
        Object.freeze({ ...row, compilation: requiredAt(this.#frameCompilations, row.frame) }),
      );
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
      throw error;
    }
  }
  retire(): void {
    this.#retired = true;
    this.#window?.retire();
  }
}
function percentile(values: readonly number[]): number {
  if (
    values.length === 0 ||
    Array.from(values).some((value) => !Number.isFinite(value) || value < 0)
  )
    throw new Error("TN_RIGGING_TIMING_MISSING: active cost observations are absent.");
  return requiredAt(
    [...values].sort((a, b) => a - b),
    Math.ceil(values.length * 0.95) - 1,
  );
}
export function summarizeRiggingRun(rows: readonly ISecondaryFrameSample[]) {
  const active = rows.filter((row) => row.ticks.length > 0);
  const ticks = rows.flatMap((row) => row.ticks);
  return Object.freeze({
    measuredFrames: rows.length,
    activeFrames: active.length,
    zeroTickFrames: rows.length - active.length,
    measuredTicks: ticks.length,
    firstTick: requiredAt(ticks, 0).tick,
    lastTick: requiredAt(ticks, ticks.length - 1).tick,
    renderCallbackSpanMs:
      requiredAt(rows, 1799).renderCallbackAtMs - requiredAt(rows, 0).renderCallbackAtMs,
    coveredRenderCallbackMs: rows.reduce((sum, row) => sum + row.renderCallbackElapsedMs, 0),
    cpuSubmissionP95: timingP95(rows.map((row) => row.cpuSubmissionMs)),
    activeFrameCpuSubmissionP95: percentile(active.map((row) => row.cpuSubmissionMs)),
    fixedTickCpuSubmissionP95: percentile(ticks.map((tick) => tick.cpuSubmissionMs)),
    gpuLowerP95: timingP95(rows.map((row) => row.gpuLowerMs)),
    gpuQueueUpperP95: timingP95(rows.map((row) => row.gpuUpperMs)),
    activeFrameGpuLowerP95: percentile(active.map((row) => row.gpuLowerMs)),
    activeFrameGpuQueueUpperP95: percentile(active.map((row) => row.gpuUpperMs)),
    fixedTickGpuLowerP95: percentile(ticks.map((tick) => tick.gpuLowerMs)),
    fixedTickGpuQueueUpperP95: percentile(ticks.map((tick) => tick.gpuUpperMs)),
    phaseSumP95: timingP95(
      rows.map((row) =>
        row.ticks.reduce((sum, tick) => sum + tick.phaseMs.reduce((a, b) => a + b, 0), 0),
      ),
    ),
    diagnosticSubmissionP95: timingP95(rows.map((row) => row.diagnosticSubmissionMs)),
    diagnosticTailQueueUpperP95: timingP95(rows.map((row) => row.diagnosticTailUpperMs)),
  });
}
/** Chunk only after the complete window, through the existing runner's console artifact. */
export function publishRiggingRows(run: IRiggingRun, rows: readonly ISecondaryFrameSample[]): void {
  if (rows.length !== 1800)
    throw new Error("TN_RIGGING_TIMING_MISSING: cannot publish a partial window.");
  for (let chunk = 0; chunk < 15; chunk++)
    console.log(
      `TN_AVBD_TIMING_ROWS:${JSON.stringify({ run: run.id, chunk, chunks: 15, rows: rows.slice(chunk * 120, (chunk + 1) * 120) })}`,
    );
}
