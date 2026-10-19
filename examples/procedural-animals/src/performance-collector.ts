import type { ICtx } from "@threenative/core";
export type GpuFrameObservation = ReturnType<NonNullable<ICtx["renderer"]["observeGpuFrames"]>>;
export type GpuObservedFrame = ReturnType<GpuFrameObservation["take"]>[number];

export const WARMUP_FRAMES = 300;
export const MEASURED_FRAMES = 1800;
const TOTAL_FRAMES = WARMUP_FRAMES + MEASURED_FRAMES;
const PREFIX = "TN_ANIMAL_PERFORMANCE_";
const validId = (value: number) => Number.isSafeInteger(value) && value >= 0;
const duration = (value: number) => Number.isFinite(value) && value >= 0;
interface IWindow {
  readonly window: number;
  readonly frames: number;
  readonly hitches: number;
  readonly frame: {
    readonly samples: number;
    readonly mean: number;
    readonly p50: number;
    readonly p95: number;
    readonly p99: number;
    readonly max: number;
  };
  readonly presents?: number;
  readonly substeps: { readonly samples: number; readonly mean: number };
}
interface IRow {
  readonly frame: number;
  readonly warmup: boolean;
  readonly main: number[];
  readonly shadow: number[];
  ended: boolean;
  cpuWindow?: number;
  cpuMs?: number;
  substeps?: number;
  presents?: number;
  gpu?: GpuObservedFrame;
}
type RecordedRow = Omit<IRow, "main" | "shadow"> & {
  readonly main: readonly number[];
  readonly shadow: readonly number[];
};
export interface IPerformanceReceipt {
  readonly warmupFrames: 300;
  readonly measuredFrames: 1800;
  readonly wolves: 0 | 1 | 32;
  readonly cpuRoundingUncertaintyMs: 0.005;
  readonly warmup: readonly Readonly<RecordedRow>[];
  readonly measurement: readonly Readonly<RecordedRow>[];
  readonly cpuP95Ms: number;
  readonly gpuP95Ms: number;
  readonly ignoredGpuFrames: number;
  readonly simulationSubsteps: number;
  readonly measuredSimulationSubsteps: number;
  readonly observerStatus: ReturnType<GpuFrameObservation["status"]>;
}
export class AnimalPerformanceCollector {
  #rows: IRow[] = [];
  #byFrame = new Map<number, IRow>();
  #pending: IRow | undefined;
  #lastWindow = -1;
  #ignoredGpuFrames = 0;
  #state: "active" | "draining" | "complete" | "failed" | "disposed" = "active";
  #deadline = 0;
  #lastNow = -1;
  #failure: Error | undefined;
  #receipt: IPerformanceReceipt | undefined;
  readonly #generation: number;
  constructor(
    readonly wolves: 0 | 1 | 32,
    private readonly observer: GpuFrameObservation,
  ) {
    if (![0, 1, 32].includes(wolves)) this.#fail("WOLF_COUNT");
    const status = observer.status();
    if (status.state !== "active" || !validId(status.generation) || status.generation === 0)
      this.#fail("OBSERVER_NOT_ACTIVE");
    this.#generation = status.generation;
  }
  get renderedFrames(): number {
    return this.#rows.length;
  }
  #fail(reason: string): never {
    this.#state = "failed";
    this.#failure = new Error(`${PREFIX}${reason}`);
    this.observer.stop();
    throw this.#failure;
  }
  #usable() {
    if (this.#failure) throw this.#failure;
    if (this.#state === "disposed") throw new Error(`${PREFIX}DISPOSED`);
  }
  #clock(nowMs: number) {
    if (!duration(nowMs) || nowMs < this.#lastNow) this.#fail("CLOCK");
    this.#lastNow = nowMs;
  }
  /** Scene onBeforeRender, only when its camera is the actual world camera. */
  beginWorld(frame: number) {
    this.#usable();
    if (this.#state !== "active") return;
    const last = this.#rows.at(-1);
    if (
      !validId(frame) ||
      this.#pending !== undefined ||
      this.#rows.length >= TOTAL_FRAMES ||
      (last !== undefined && frame <= last.frame)
    )
      this.#fail("WORLD_FRAME_ORDER");
    const row: IRow = {
      frame,
      warmup: this.#rows.length < WARMUP_FRAMES,
      main: new Array<number>(this.wolves).fill(0),
      shadow: new Array<number>(this.wolves).fill(0),
      ended: false,
    };
    this.#pending = row;
    this.#rows.push(row);
    this.#byFrame.set(frame, row);
  }
  /** Backend-confirmed public renderer.info.update; callbacks supply pass identity only. */
  submitted(frame: number, wolf: number, pass: "main" | "shadow") {
    this.#usable();
    if (this.#state !== "active") return;
    const row = this.#pending;
    if (!row || row.ended || row.frame !== frame || !validId(wolf) || wolf >= this.wolves)
      this.#fail("SUBMISSION_IDENTITY");
    if (pass !== "main" && pass !== "shadow") this.#fail("SUBMISSION_PASS");
    row[pass][wolf] = (row[pass][wolf] ?? 0) + 1;
  }
  /** Matching Scene onAfterRender; every selected frame must include every surface. */
  endWorld(frame: number) {
    this.#usable();
    if (this.#state !== "active") return;
    const row = this.#pending;
    if (!row || row.ended || row.frame !== frame) this.#fail("WORLD_FRAME_ORDER");
    if (row.main.some((count) => count !== 1) || row.shadow.some((count) => count < 1))
      this.#fail("VISIBLE_WOLF_NOT_SUBMITTED");
    row.ended = true;
  }
  /** Existing frameBudget.onWindow with reportEvery:1; no wall/presentation/GPU substitution. */
  cpu(window: IWindow, nowMs: number) {
    this.#usable();
    if (this.#state !== "active") return;
    this.#clock(nowMs);
    const row = this.#pending;
    if (
      !row?.ended ||
      !validId(window.window) ||
      (this.#lastWindow >= 0 && window.window !== this.#lastWindow + 1) ||
      window.frames !== 1 ||
      window.hitches !== 0 ||
      window.frame.samples !== 1 ||
      window.substeps?.samples !== 1 ||
      !validId(window.substeps.mean) ||
      !duration(window.frame.mean) ||
      [window.frame.p50, window.frame.p95, window.frame.p99, window.frame.max].some(
        (value) => value !== window.frame.mean,
      ) ||
      !duration(nowMs) ||
      (window.presents !== undefined && !validId(window.presents))
    )
      this.#fail("CPU_WINDOW_INCOMPLETE");
    this.#lastWindow = window.window;
    row.cpuWindow = window.window;
    row.cpuMs = window.frame.mean;
    row.substeps = window.substeps.mean;
    row.presents = window.presents;
    this.#pending = undefined;
    if (this.#rows.length === TOTAL_FRAMES) {
      this.#state = "draining";
      this.#deadline = nowMs + 2000;
      this.observer.stop();
    }
  }
  #gpu(sample: GpuObservedFrame) {
    if (sample.generation !== this.#generation || !validId(sample.frame))
      this.#fail("GPU_GENERATION");
    const row = this.#byFrame.get(sample.frame);
    if (!row) {
      // Overlay/drain queries have real IDs but do not stand in for selected world renders.
      this.#ignoredGpuFrames += 1;
      return;
    }
    if (row.gpu) this.#fail("GPU_DUPLICATE");
    if (!validId(sample.batch) || !duration(sample.ms) || sample.queries.length === 0)
      this.#fail("GPU_INCOMPLETE");
    const uids = new Set<string>();
    const offsets = new Set<number>();
    let sum = 0;
    for (const query of sample.queries) {
      if (
        !/^r:[^\s]+:f\d+$/.test(query.uid) ||
        Number(query.uid.slice(query.uid.lastIndexOf(":f") + 2)) !== sample.frame ||
        uids.has(query.uid) ||
        !validId(query.begin) ||
        query.begin % 2 !== 0 ||
        query.end !== query.begin + 1 ||
        offsets.has(query.begin) ||
        !duration(query.ms)
      )
        this.#fail("GPU_QUERY_MEMBERSHIP");
      uids.add(query.uid);
      offsets.add(query.begin);
      sum += query.ms;
    }
    if (Math.abs(sum - sample.ms) > Number.EPSILON * Math.max(1, sum) * sample.queries.length)
      this.#fail("GPU_QUERY_SUM");
    // Preserve immutable numeric receipts, never alias the backend's reusable Maps/arrays.
    row.gpu = Object.freeze({
      ...sample,
      queries: Object.freeze(sample.queries.map((query) => Object.freeze({ ...query }))),
    });
  }
  poll(nowMs: number): IPerformanceReceipt | undefined {
    this.#usable();
    this.#clock(nowMs);
    if (this.#state === "complete") return this.#receipt;
    for (const sample of this.observer.take()) this.#gpu(sample);
    const status = this.observer.status();
    if (
      status.generation !== this.#generation ||
      status.state === "failed" ||
      status.state === "disposed" ||
      status.droppedFrames !== 0 ||
      status.droppedQueries !== 0 ||
      status.allocationLoss !== "not-observed"
    )
      this.#fail("OBSERVER_INCOMPLETE");
    if (this.#state !== "draining") return;
    // Completion is observed here: a later poll cannot prove this batch drained within the bound.
    if (nowMs >= this.#deadline) this.#fail("DRAIN_TIMEOUT");
    const measured = this.#rows.slice(WARMUP_FRAMES);
    const settled =
      status.state === "stopped" &&
      status.pendingFrames === 0 &&
      status.undrainedFrames === 0 &&
      status.queuedFrames === 0;
    if (measured.every((row) => row.gpu !== undefined) && settled) {
      const simulationSubsteps = this.#rows.reduce((sum, row) => sum + (row.substeps ?? 0), 0);
      const measuredSimulationSubsteps = measured.reduce(
        (sum, row) => sum + (row.substeps ?? 0),
        0,
      );
      if (measuredSimulationSubsteps < 1) this.#fail("NO_SIMULATION");
      const frozen = this.recordedRows();
      this.#receipt = Object.freeze({
        warmupFrames: WARMUP_FRAMES,
        measuredFrames: MEASURED_FRAMES,
        wolves: this.wolves,
        cpuRoundingUncertaintyMs: 0.005,
        warmup: Object.freeze(frozen.slice(0, WARMUP_FRAMES)),
        measurement: Object.freeze(frozen.slice(WARMUP_FRAMES)),
        cpuP95Ms: percentile95(
          measured.map((row) => {
            if (row.cpuMs === undefined) this.#fail("CPU_WINDOW_INCOMPLETE");
            return row.cpuMs;
          }),
        ),
        gpuP95Ms: percentile95(
          measured.map((row) => {
            if (row.gpu === undefined) this.#fail("GPU_INCOMPLETE");
            return row.gpu.ms;
          }),
        ),
        ignoredGpuFrames: this.#ignoredGpuFrames,
        simulationSubsteps,
        measuredSimulationSubsteps,
        observerStatus: status,
      });
      this.#state = "complete";
      return this.#receipt;
    }
  }
  /** Immutable raw rows for post-failure diagnostics; incomplete rows do not form a receipt. */
  recordedRows(): readonly Readonly<RecordedRow>[] {
    return Object.freeze(
      this.#rows.map((row) =>
        Object.freeze({
          ...row,
          main: Object.freeze([...row.main]),
          shadow: Object.freeze([...row.shadow]),
        }),
      ),
    );
  }
  dispose() {
    this.#state = "disposed";
    this.observer.dispose();
    this.#rows = [];
    this.#byFrame.clear();
    this.#pending = undefined;
  }
}
export function percentile95(values: readonly number[]) {
  if (values.length !== MEASURED_FRAMES || values.some((value) => !duration(value)))
    throw new Error(`${PREFIX}SERIES_INCOMPLETE`);
  const value = [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  if (value === undefined) throw new Error(`${PREFIX}SERIES_INCOMPLETE`);
  return value;
}
