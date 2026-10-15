// PRD-117 §5.1/§5.2: parse both arms' run reports fail-closed, refuse to compare two scenes that
// were not the same scene, and only then compute a knee. A missing field, a wrong type, or an
// empty sample array is an error here — never a default, never a skip.

import os from "node:os";
import {
  FRAME_STAT_KEYS,
  type IFoxMeasurement,
  type IFrameStats,
  type ILadderCounts,
  LADDER_COUNT_KEYS,
  type RealisticRung,
  expectedLadderCounts,
  foxMeasurementReason,
  foxParityReason,
  ladderCountDiff,
  ladderRank,
} from "../../examples/engine-load-test/src/ladder.js";
import { PHASES, type Phase } from "../../examples/engine-load-test/src/phases.js";
import {
  DEFAULT_AXES,
  type IWorkloadAxes,
  RENDER_MODES,
  type RenderMode,
  isRealisticRung,
} from "../../examples/engine-load-test/src/workload.js";
import { blankFrameReason } from "../capture-guard.js";

function parseFrameRgba(value: unknown, label: string): NonNullable<IRunReportRung["frameRgba"]> {
  const frame = requireObject(value, `${label}.frameRgba`);
  const width = requireNumber(frame, "width", label);
  const height = requireNumber(frame, "height", label);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    typeof frame.data !== "string" ||
    frame.data.length !== width * height * 8 ||
    /[^0-9a-f]/u.test(frame.data)
  )
    throw new BenchError("TN_BENCH_VISUAL_MISSING", `${label}: invalid RGBA capture`);
  return { width, height, data: frame.data };
}

export const KNEE_THRESHOLD_MS = 20;
export const ARMS = [
  "tn-web",
  "tn-android",
  "tn-desktop",
  "tn-engine-desktop",
  "tn-engine-web",
  "godot-web",
  "godot-android",
  "godot-desktop",
  "plain-three-webgpu",
] as const;

export type Arm = (typeof ARMS)[number];
type EngineName = "godot" | "threenative" | "three";
// The scene's own mode list, re-exported rather than restated: a report whose reader and whose
// writer disagree on what a mode is would reject a run the harness happily produced.
export type { RenderMode };
export type BuildType = "release" | "debug";
export type BenchExitCode = 1 | 2;

export const REQUIRED_PLATFORM_LANES = [
  "browser-webgpu",
  "native-linux",
  "native-windows",
  "native-macos",
  "native-android",
  "native-ios",
] as const;

export type RequiredPlatformLane = (typeof REQUIRED_PLATFORM_LANES)[number];

export type PerformanceLaneProvisioning =
  | "hosted-software"
  | "physical-hardware"
  | "simulator"
  | "unprovisioned";

export interface IPerformancePromotionPolicy {
  readonly accuracyRuns: number;
  readonly baselineRegeneration: "separate-reviewed-change";
  readonly calibrationStatus: "accepted" | "unverified";
  readonly calibrationPairs: number;
  readonly ciCostRuns: number;
  readonly maxIncrementalRunnerMinutes: number;
  readonly maxQueueSeconds: number;
  readonly minimumCalibrationSessions: number;
  readonly requiredCheckPromotion: "maintainer-review";
}

export interface IRunReportRung {
  /** Last measured frame, captured outside the timed window and persisted beside the run JSON. */
  framePath?: string;
  /** Capture transport only; saveFrames removes these before writing the report. */
  framePng?: string;
  /** Hex RGBA avoids retaining millions of boxed numbers in the native process. */
  frameRgba?: { width: number; height: number; data: string };
  collapseMs?: number[];
  /**
   * CPU milliseconds the host process spent per frame inside the timed window (every thread), read by the
   * runner from /proc at the page's window markers (`host-cpu.ts`). Absent on arms the runner cannot read.
   */
  cpuMsPerFrame?: number;
  /**
   * PRD-449 §7.4's primary metric: the wall window for N completed frames over N, cadence included.
   * Optional because reports written before it existed still parse; `null` with a reason when the arm
   * could not observe finished work.
   */
  completedWorkMeanMs?: number | null;
  /** Non-null exactly when `completedWorkMeanMs` is null. */
  completedWorkReason?: string | null;
  /** The uncapped CPU submit half, kept beside the primary metric and never in place of it. */
  cpuSubmitMeanMs?: number;
  /** Fill/drain policy and timing scope, as recorded by the driver. */
  drainPolicy?: string;
  drawCalls: number;
  frameMs: number[];
  /**
   * PRD-464: how big R3's characters came out in this engine's own import — the world bounding-box
   * height of one of them and the share of the viewport it covers. Gated by `foxMeasurementReason`
   * below, so a run carrying one has already proved its foxes are the size the ladder specifies.
   */
  foxMeasurement?: IFoxMeasurement;
  /** Frames the timed window covered, which the driver also writes as `frameMs.length`. */
  measuredFrames?: number;
  /**
   * PRD-464's asserted scene cost, present exactly on the realistic-scene rungs and checked against
   * `expectedLadderCounts` below. A ladder rung without it is a hole in the measurement, not a rung
   * that measured nothing, so it fails the run.
   */
  ladder?: ILadderCounts;
  /**
   * PRD-464's proof that the rung drew something: what the frame read back after warmup said about
   * itself. Present exactly on the realistic-scene rungs and gated by `blankFrameReason` above, so a
   * run carrying one has already passed it.
   */
  renderCheck?: IFrameStats;
  mode: RenderMode;
  objectCount: number;
  /** Optional on legacy/native reports; every initial built placement on new browser reports. */
  initialPlacementSha256?: string;
  /**
   * Pipelines the renderer created inside the measured window (the warmup's are excluded). Optional
   * so reports from before the counter still parse; `scoreboardRows` refuses a rung without it.
   */
  pipelineCompiles?: number;
  positionHash: string;
  repeat: number;
  stepMs?: number[];
  /**
   * Main-thread CPU ms per drawn frame without the surface present call (CLOCK_THREAD_CPUTIME_ID), when the run
   * asked for it. Both desktop arms print it.
   */
  threadCpuMs?: number[];
  /** Thread CPU ms inside the surface present call per frame; the same instrument and clock in both desktop arms. */
  presentCpuMs?: number[];
  /** C ABI crossings per frame; only the owned engine player counts them. */
  bridgeCalls?: number[];
  /** Thread CPU ms per frame inside the engine player's own render call, which the page's `render` phase cannot see. */
  renderCpuMs?: number[];
  /**
   * Where the page's own work went, per frame in thread CPU ms (the clock `threadCpuMs` uses): one series per
   * `PHASES` name, each as long as `frameMs`. Present when the run turned the telemetry on (`--pair` does).
   */
  phases?: Record<Phase, number[]>;
  /** The names the engine player crossed the C ABI with most, as crossings per frame (`TN_BENCH_CROSSINGS=1`). */
  crossingTop?: Array<[string, number]>;
  triangles: number;
  visibleObjects: number;
}

/**
 * The phases a summary can carry: the page's five, the host's `present` call, and `other`, which is whatever
 * the frame's thread CPU holds beyond the five (host work, GC, bookkeeping), so the phases sum to the frame.
 */
export const SUMMARY_PHASES = [...PHASES, "present", "other"] as const;
export type SummaryPhase = (typeof SUMMARY_PHASES)[number];
export interface IPhaseStat {
  mean: number;
  p50: number;
}

export interface IDeviceCondition {
  batteryPercent: number;
  charging: boolean;
  chargingSource: string;
  provisional: string[];
  screenOn: boolean;
  serial: string;
  thermalStatus: string;
  thermalStatusCode: number;
}

export interface IRunReport {
  arm: Arm;
  axes?: IWorkloadAxes;
  build: { notes: string; type: BuildType };
  device: { battery: number | null; label: string };
  deviceCondition?: IDeviceCondition;
  display: { height: number; refreshHz: number; vsync: boolean; width: number };
  driver: { adapter: string; renderer: string };
  engine: { name: EngineName; version: string };
  /** Host load when the run finished, stamped by the CLI; see `withHostLoad`. */
  hostLoad?: IHostLoad;
  identity?: IPerformanceIdentity;
  provisional?: string[];
  rungs: IRunReportRung[];
  /** A web arm's startup, memory and shipped bytes (PRD-573 slice 7); see `parseWebMetrics`. */
  web?: IWebReport;
}

/** What a web arm measures beyond its frames: the page's own startup and memory, and the runner's byte count. */
export interface IWebReport {
  startup?: { entryMs: number; firstFrameMs: number | null; wasmInstantiateMs: number[] };
  memory?: { jsHeapUsedBytes: number | null; wasmMemoryBytes: number | null };
  artifact?: { jsBytes: number; jsGzipBytes: number; wasmBytes: number; wasmGzipBytes: number };
  engineWasm?: { mtime: string; sha256: string };
}

const nonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Fails closed on a web block whose fields are not what the page and runner write. */
export function parseWebMetrics(value: unknown): IWebReport {
  const root = requireObject(value, "report.web");
  const fail = (field: string): never => {
    throw new BenchError("TN_BENCH_BAD_SHAPE", `report.web.${field} is malformed`);
  };
  const out: IWebReport = {};
  if (root.startup !== undefined) {
    const startup = requireObject(root.startup, "report.web.startup");
    const instantiate = startup.wasmInstantiateMs;
    if (!nonNegative(startup.entryMs)) fail("startup.entryMs");
    if (startup.firstFrameMs !== null && !nonNegative(startup.firstFrameMs))
      fail("startup.firstFrameMs");
    if (!Array.isArray(instantiate) || !instantiate.every(nonNegative))
      fail("startup.wasmInstantiateMs");
    out.startup = {
      entryMs: startup.entryMs as number,
      firstFrameMs: startup.firstFrameMs as number | null,
      wasmInstantiateMs: instantiate as number[],
    };
  }
  if (root.memory !== undefined) {
    const memory = requireObject(root.memory, "report.web.memory");
    for (const field of ["jsHeapUsedBytes", "wasmMemoryBytes"] as const)
      if (memory[field] !== null && !nonNegative(memory[field])) fail(`memory.${field}`);
    out.memory = {
      jsHeapUsedBytes: memory.jsHeapUsedBytes as number | null,
      wasmMemoryBytes: memory.wasmMemoryBytes as number | null,
    };
  }
  if (root.artifact !== undefined) {
    const artifact = requireObject(root.artifact, "report.web.artifact");
    for (const field of ["jsBytes", "jsGzipBytes", "wasmBytes", "wasmGzipBytes"] as const)
      if (!nonNegative(artifact[field])) fail(`artifact.${field}`);
    out.artifact = artifact as unknown as NonNullable<IWebReport["artifact"]>;
  }
  if (root.engineWasm !== undefined) {
    const wasm = requireObject(root.engineWasm, "report.web.engineWasm");
    out.engineWasm = {
      mtime: requireString(wasm, "mtime", "report.web.engineWasm"),
      sha256: requireString(wasm, "sha256", "report.web.engineWasm"),
    };
  }
  return out;
}

/**
 * The one-minute load average and the core count of the machine that ran the bench. Absolute
 * milliseconds measured while more than half the cores were busy are somebody else's contention.
 */
export interface IHostLoadReading {
  cores: number;
  load1: number;
}
export interface IHostLoad extends IHostLoadReading {
  absolutes: "invalid-absolute" | "valid";
}

/** Identity fields that make a timed result comparable to its accepted baseline. */
export interface IPerformanceIdentity {
  readonly architecture?: string;
  readonly artifactHash?: string;
  readonly browser?: string;
  readonly device?: string;
  readonly graphicsBackend?: string;
  readonly gpu?: string;
  readonly instrumentationRevision?: string;
  readonly jsRuntime?: string;
  readonly nativeBinaryHash?: string;
  readonly operatingSystem?: string;
  readonly presentMode?: string;
  readonly resolution?: string;
  readonly sourceSha?: string;
  readonly workloadHash?: string;
}

export interface IRungSummary {
  godotRatio?: number;
  /** Median across repeats of the host process's CPU ms per frame in the timed window; undefined when no repeat carried it. */
  cpuMsPerFrame?: number;
  drawCalls: number;
  /** Frames over `HITCH_FACTOR` times the rung's own p50, median across repeats. */
  hitches: number;
  mode: RenderMode;
  objectCount: number;
  p50: number;
  p95: number;
  p99: number;
  /** Median across repeats; undefined when no repeat carried the counter. */
  pipelineCompiles?: number;
  repeats: number;
  sampleCount: number;
  /** Median across repeats of the main-thread CPU p50 per frame without the present call; undefined when no repeat carried it. */
  threadCpuP50?: number;
  /** Median across repeats of the thread CPU p50 spent inside the present call; undefined when no repeat carried it. */
  presentCpuP50?: number;
  /** Median across repeats of the crossings p50 per frame; undefined unless the arm counts them. */
  crossingsP50?: number;
  /** Per phase, the median across repeats of its p50 and its mean, in thread CPU ms per frame. */
  phases?: Partial<Record<SummaryPhase, IPhaseStat>>;
  /** The first repeat's most crossed names per frame; undefined unless the arm counts them. */
  crossingTop?: Array<[string, number]>;
  triangles: number;
  visibleObjects: number;
}

export interface IEquivalenceFailure {
  field: string;
  left: string;
  right: string;
  rung: string;
}

export interface IComparison {
  left: IRunReport;
  leftKnee: Record<RenderMode, number | null>;
  leftSummaries: IRungSummary[];
  right: IRunReport;
  rightKnee: Record<RenderMode, number | null>;
  rightSummaries: IRungSummary[];
}

export class BenchError extends Error {
  readonly code: string;
  readonly exitCode: BenchExitCode;

  constructor(code: string, detail: string, exitCode: BenchExitCode = 2) {
    super(`${code}: ${detail}`);
    this.name = code;
    this.code = code;
    this.exitCode = exitCode;
  }
}

// Exported for the v2 campaign reader (`campaign-report.ts`), which parses the same way. Adding the
// keyword changes no legacy behaviour; the helpers were already the only fail-closed path here.
export function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new BenchError("TN_BENCH_BAD_SHAPE", `${path} must be an object`);
  return value as Record<string, unknown>;
}

export function requireString(source: Record<string, unknown>, key: string, path: string): string {
  const value = source[key];
  if (typeof value !== "string" || value.length === 0)
    throw new BenchError("TN_BENCH_BAD_SHAPE", `${path}.${key} must be a non-empty string`);
  return value;
}

export function requireNumber(source: Record<string, unknown>, key: string, path: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new BenchError("TN_BENCH_BAD_SHAPE", `${path}.${key} must be a finite number`);
  return value;
}

export function requireBoolean(
  source: Record<string, unknown>,
  key: string,
  path: string,
): boolean {
  const value = source[key];
  if (typeof value !== "boolean")
    throw new BenchError("TN_BENCH_BAD_SHAPE", `${path}.${key} must be a boolean`);
  return value;
}

// The matrix axes a run reports. Absent on Godot reports and on reports written before the axes
// existed, so the field is optional; present, it is validated like everything else.
function parseRunAxes(value: unknown): IWorkloadAxes {
  const source = requireObject(value, "report.axes");
  const geometry = requireString(source, "geometry", "report.axes");
  const material = requireString(source, "material", "report.axes");
  if (geometry !== "shared" && geometry !== "unique")
    throw new BenchError("TN_BENCH_BAD_SHAPE", `report.axes.geometry ${geometry} is not a mode`);
  if (material !== "shared" && material !== "unique")
    throw new BenchError("TN_BENCH_BAD_SHAPE", `report.axes.material ${material} is not a mode`);
  const hierarchyDepth = requireNumber(source, "hierarchyDepth", "report.axes");
  const mutationRate = requireNumber(source, "mutationRate", "report.axes");
  const passCount = requireNumber(source, "passCount", "report.axes");
  const shadowCasterShare = requireNumber(source, "shadowCasterShare", "report.axes");
  const visibleFraction = requireNumber(source, "visibleFraction", "report.axes");
  if (!Number.isInteger(hierarchyDepth) || hierarchyDepth < 0)
    throw new BenchError("TN_BENCH_BAD_SHAPE", "report.axes.hierarchyDepth is not a depth");
  if (!Number.isInteger(passCount) || passCount < 1)
    throw new BenchError("TN_BENCH_BAD_SHAPE", "report.axes.passCount is not a pass count");
  for (const [name, fraction] of [
    ["mutationRate", mutationRate],
    ["shadowCasterShare", shadowCasterShare],
    ["visibleFraction", visibleFraction],
  ] as const) {
    if (fraction < 0 || fraction > 1)
      throw new BenchError("TN_BENCH_BAD_SHAPE", `report.axes.${name} is not a fraction`);
  }
  return {
    geometry,
    hierarchyDepth,
    material,
    mutationRate,
    passCount,
    shadowCasterShare,
    visibleFraction,
  };
}

// Field-by-field so a reordered but equal record still compares equal; the report's `axes` is built
// in one order, but a test or a future writer need not preserve it.
function sameWorkloadAxes(left: IWorkloadAxes, right: IWorkloadAxes): boolean {
  return (
    left.geometry === right.geometry &&
    left.hierarchyDepth === right.hierarchyDepth &&
    left.material === right.material &&
    left.mutationRate === right.mutationRate &&
    left.passCount === right.passCount &&
    left.shadowCasterShare === right.shadowCasterShare &&
    left.visibleFraction === right.visibleFraction
  );
}

function parseProvisional(value: unknown, path: string, required: boolean): string[] | undefined {
  if (value === undefined && !required) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new BenchError("TN_BENCH_BAD_SHAPE", `${path} must be an array of non-empty strings`);
  }
  return value;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function parseDeviceCondition(
  value: unknown,
  arm: Arm,
  provisional: string[] | undefined,
): IDeviceCondition | undefined {
  const required = arm.endsWith("-android");
  if (value === undefined && !required) return undefined;
  const condition = requireObject(value, "report.deviceCondition");
  if (provisional === undefined) {
    throw new BenchError("TN_BENCH_MISSING_DEVICE_CONDITION", "report.provisional is absent");
  }
  if (required && condition.provisional === undefined) {
    throw new BenchError(
      "TN_BENCH_MISSING_DEVICE_CONDITION",
      "report.deviceCondition.provisional is absent",
    );
  }
  const conditionProvisional = parseProvisional(
    condition.provisional,
    "report.deviceCondition.provisional",
    required,
  );
  if (conditionProvisional !== undefined && !sameStringArray(provisional, conditionProvisional)) {
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      "report.provisional must match report.deviceCondition.provisional",
    );
  }
  return {
    batteryPercent: requireNumber(condition, "batteryPercent", "report.deviceCondition"),
    charging: requireBoolean(condition, "charging", "report.deviceCondition"),
    chargingSource: requireString(condition, "chargingSource", "report.deviceCondition"),
    provisional: conditionProvisional ?? provisional,
    screenOn: requireBoolean(condition, "screenOn", "report.deviceCondition"),
    serial: requireString(condition, "serial", "report.deviceCondition"),
    thermalStatus: requireString(condition, "thermalStatus", "report.deviceCondition"),
    thermalStatusCode: requireNumber(condition, "thermalStatusCode", "report.deviceCondition"),
  };
}

export function percentile(samples: readonly number[], fraction: number): number {
  if (samples.length === 0) throw new BenchError("TN_BENCH_EMPTY_SERIES", "no frame samples");
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank] as number;
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new BenchError("TN_BENCH_EMPTY_SERIES", "no values to median");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2) as number;
}

function parseReportIdentity(value: unknown): IPerformanceIdentity | undefined {
  if (value === undefined) return undefined;
  const source = requireObject(value, "report.identity");
  const fields: readonly (keyof IPerformanceIdentity)[] = [
    "architecture",
    "artifactHash",
    "browser",
    "device",
    "graphicsBackend",
    "gpu",
    "instrumentationRevision",
    "jsRuntime",
    "nativeBinaryHash",
    "operatingSystem",
    "presentMode",
    "resolution",
    "sourceSha",
    "workloadHash",
  ];
  const identity: Partial<Record<keyof IPerformanceIdentity, string>> = {};
  for (const field of fields) {
    const fieldValue = source[field];
    if (fieldValue !== undefined) {
      if (typeof fieldValue !== "string" || fieldValue.length === 0) {
        throw new BenchError(
          "TN_BENCH_BAD_SHAPE",
          `report.identity.${field} must be a non-empty string`,
        );
      }
      identity[field] = fieldValue;
    }
  }
  return identity;
}

/** A number that must be finite and non-negative, or `undefined` when the field is absent. */
function optionalNonNegative(source: Record<string, unknown>, key: string, path: string) {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path}.${key} must be a finite non-negative number when present`,
    );
  return value;
}

/**
 * PRD-449 §7.4's completed-work fields, kept so a saved report still carries them: the CLI serialises
 * the *parsed* report, so a field dropped here is a field that never reaches the JSON on disk.
 *
 * Optional as a block, so a report written before the metric existed still parses. Present, they are
 * validated like everything else, and the metric and its reason are one exclusive pair — a reason
 * without a hole, or a hole without one, is a record nobody can read.
 */
type TCompletedWork = Pick<
  IRunReportRung,
  | "completedWorkMeanMs"
  | "completedWorkReason"
  | "cpuSubmitMeanMs"
  | "drainPolicy"
  | "measuredFrames"
>;

/** The metric and the reason for its absence, as one exclusive pair, or `undefined` when absent. */
function parseCompletedWorkPair(
  rung: Record<string, unknown>,
  path: string,
): Pick<TCompletedWork, "completedWorkMeanMs" | "completedWorkReason"> | undefined {
  const completedWorkMeanMs = rung.completedWorkMeanMs;
  const completedWorkReason = rung.completedWorkReason;
  if (completedWorkMeanMs === undefined && completedWorkReason === undefined) return undefined;
  if (completedWorkMeanMs === undefined || completedWorkReason === undefined)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path} must carry completedWorkMeanMs and completedWorkReason together`,
    );
  if (completedWorkMeanMs === null) {
    if (typeof completedWorkReason !== "string" || completedWorkReason.length === 0)
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.completedWorkReason must be a non-empty string when completedWorkMeanMs is null`,
      );
    return { completedWorkMeanMs, completedWorkReason };
  }
  if (
    typeof completedWorkMeanMs !== "number" ||
    !Number.isFinite(completedWorkMeanMs) ||
    completedWorkMeanMs < 0
  )
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path}.completedWorkMeanMs must be a finite non-negative number or null`,
    );
  if (completedWorkReason !== null)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path}.completedWorkReason is for a null measurement only`,
    );
  return { completedWorkMeanMs, completedWorkReason };
}

/** The frames the window covered, which the driver also writes as `frameMs.length`. */
function parseMeasuredFrames(
  rung: Record<string, unknown>,
  path: string,
  sampleCount: number,
): number | undefined {
  const measuredFrames = optionalNonNegative(rung, "measuredFrames", path);
  if (measuredFrames === undefined) return undefined;
  if (!Number.isInteger(measuredFrames) || measuredFrames < 1)
    throw new BenchError("TN_BENCH_BAD_SHAPE", `${path}.measuredFrames must be a positive integer`);
  // The driver writes one interval per measured frame, so a declared window that disagrees with the
  // series beside it means the two halves of the record came from different runs.
  if (measuredFrames !== sampleCount)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path}.measuredFrames ${measuredFrames} does not match ${sampleCount} frame samples`,
    );
  return measuredFrames;
}

function parseCompletedWork(
  rung: Record<string, unknown>,
  path: string,
  sampleCount: number,
): Partial<TCompletedWork> {
  const cpuSubmitMeanMs = optionalNonNegative(rung, "cpuSubmitMeanMs", path);
  const drainPolicy = rung.drainPolicy;
  if (drainPolicy !== undefined) requireString(rung, "drainPolicy", path);
  const measuredFrames = parseMeasuredFrames(rung, path, sampleCount);
  const pair = parseCompletedWorkPair(rung, path);
  return {
    ...(pair === undefined ? {} : pair),
    ...(cpuSubmitMeanMs === undefined ? {} : { cpuSubmitMeanMs }),
    ...(drainPolicy === undefined ? {} : { drainPolicy: drainPolicy as string }),
    ...(measuredFrames === undefined ? {} : { measuredFrames }),
  };
}

export function parseRunReport(value: unknown): IRunReport {
  const root = requireObject(value, "report");
  const arm = requireString(root, "arm", "report");
  if (!(ARMS as readonly string[]).includes(arm))
    throw new BenchError("TN_BENCH_BAD_ARM", `unknown arm ${arm}`);
  const typedArm = arm as Arm;
  const provisional = parseProvisional(
    root.provisional,
    "report.provisional",
    typedArm.endsWith("-android"),
  );
  const deviceCondition = parseDeviceCondition(root.deviceCondition, typedArm, provisional);

  const engine = requireObject(root.engine, "report.engine");
  const engineName = requireString(engine, "name", "report.engine");
  // An arm is one engine, so the report's engine has to be the one that arm runs: a `three` report
  // stamped `tn-web` is a build that is not the arm it was published under, and its numbers are then
  // somebody else's. Pairing rather than membership is what keeps `three` off every other arm.
  const expectedEngine: EngineName = typedArm.startsWith("godot-")
    ? "godot"
    : typedArm === "plain-three-webgpu"
      ? "three"
      : "threenative";
  if (engineName !== expectedEngine)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `report.engine.name ${engineName} is not an engine the ${typedArm} arm runs`,
    );

  const build = requireObject(root.build, "report.build");
  const buildType = requireString(build, "type", "report.build");
  if (buildType !== "release" && buildType !== "debug")
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `report.build.type ${buildType} is not a build type`,
    );

  const display = requireObject(root.display, "report.display");
  // A report that cannot name the backend the engine actually chose is not comparable: a web
  // export that silently fell back would otherwise be published as that engine's result (§4.5).
  const driverSource = root.driver;
  if (typeof driverSource !== "object" || driverSource === null)
    throw new BenchError("TN_BENCH_MISSING_DRIVER", "report.driver is absent");
  const driver = requireObject(driverSource, "report.driver");
  let renderer: string;
  let adapter: string;
  try {
    renderer = requireString(driver, "renderer", "report.driver");
    adapter = requireString(driver, "adapter", "report.driver");
  } catch {
    throw new BenchError("TN_BENCH_MISSING_DRIVER", "report.driver is missing renderer or adapter");
  }

  const device = requireObject(root.device, "report.device");
  const battery = device.battery;
  if (battery !== null && (typeof battery !== "number" || !Number.isFinite(battery)))
    throw new BenchError("TN_BENCH_BAD_SHAPE", "report.device.battery must be a number or null");

  const rawRungs = root.rungs;
  if (!Array.isArray(rawRungs) || rawRungs.length === 0)
    throw new BenchError("TN_BENCH_NO_RUNGS", "report.rungs is empty");

  const rungs = rawRungs.map((rawRung, index) => {
    const path = `report.rungs[${index}]`;
    const rung = requireObject(rawRung, path);
    const mode = requireString(rung, "mode", path);
    if (!(RENDER_MODES as readonly string[]).includes(mode))
      throw new BenchError("TN_BENCH_BAD_SHAPE", `${path}.mode ${mode} is not a render mode`);
    const frameMs = rung.frameMs;
    if (!Array.isArray(frameMs) || frameMs.length === 0)
      throw new BenchError("TN_BENCH_EMPTY_SERIES", `${path}.frameMs carries no samples`);
    for (const sample of frameMs) {
      if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
        throw new BenchError("TN_BENCH_BAD_SHAPE", `${path}.frameMs holds a non-finite sample`);
    }
    const timingSeries: Partial<Pick<IRunReportRung, "stepMs" | "collapseMs">> = {};
    for (const field of ["stepMs", "collapseMs"] as const) {
      const samples = rung[field];
      if (samples === undefined) continue;
      if (
        !Array.isArray(samples) ||
        samples.length !== frameMs.length ||
        samples.some(
          (sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0,
        )
      )
        throw new BenchError(
          "TN_BENCH_BAD_SHAPE",
          `${path}.${field} must match frameMs with finite nonnegative samples`,
        );
      timingSeries[field] = samples as number[];
    }
    const cpuMsPerFrame = rung.cpuMsPerFrame;
    if (
      cpuMsPerFrame !== undefined &&
      (typeof cpuMsPerFrame !== "number" || !Number.isFinite(cpuMsPerFrame) || cpuMsPerFrame < 0)
    )
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.cpuMsPerFrame must be a non-negative number when present`,
      );
    const threadCpuMs = rung.threadCpuMs;
    if (
      threadCpuMs !== undefined &&
      (!Array.isArray(threadCpuMs) ||
        threadCpuMs.length === 0 ||
        threadCpuMs.some(
          (sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0,
        ))
    )
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.threadCpuMs must be a non-empty array of non-negative numbers when present`,
      );
    const presentCpuMs = optionalSeries(rung, "presentCpuMs", path);
    const bridgeCalls = optionalSeries(rung, "bridgeCalls", path);
    const renderCpuMs = optionalSeries(rung, "renderCpuMs", path);
    const phases = parsePhases(rung.phases, frameMs.length, `${path}.phases`);
    const crossingTop = parseCrossingTop(rung.crossingTop, `${path}.crossingTop`);
    const initialPlacementSha256 = rung.initialPlacementSha256;
    if (
      initialPlacementSha256 !== undefined &&
      (typeof initialPlacementSha256 !== "string" ||
        !/^[0-9a-f]{64}$/u.test(initialPlacementSha256))
    )
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.initialPlacementSha256 must be a lowercase SHA-256 digest`,
      );
    // PRD-464's rung gate. Both engines build the ladder from the same rung number, so the counts
    // they record are the only thing that can tell a real R4 from an R1 published under its name:
    // no counts, or counts that do not match the rung, is a failed run and not a row.
    const objectCount = requireNumber(rung, "objectCount", path);
    let ladder: ILadderCounts | undefined;
    let foxMeasurement: IFoxMeasurement | undefined;
    let renderCheck: IFrameStats | undefined;
    if (isRealisticRung(mode as RenderMode)) {
      // Read exactly the keys the rung spec asserts and nothing else: `ladderCountDiff` compares
      // with `!==`, so a missing key, a string where a number belongs and a count that is simply
      // wrong all fail the same way — a non-zero exit, never a row.
      const recorded = requireObject(rung.ladder, `${path}.ladder`);
      ladder = Object.fromEntries(
        LADDER_COUNT_KEYS.map((key) => [key, recorded[key]]),
      ) as unknown as ILadderCounts;
      const diff = ladderCountDiff(
        expectedLadderCounts(mode as RealisticRung, objectCount),
        ladder,
      );
      if (diff !== null)
        throw new BenchError(
          "TN_BENCH_LADDER_COUNTS",
          `${path} mode ${mode} does not match its rung spec: ${diff}`,
        );
      // The rung's own proof that it drew something. A fast frame that drew a flat fill is the
      // dangerous outcome here, not a good one, so a missing read-back, a frame with no draws or no
      // triangles, and a frame whose pixels carry no variation all fail the run rather than
      // publishing a number for a scene nobody saw.
      const stats =
        rung.renderCheck === undefined
          ? undefined
          : requireObject(rung.renderCheck, `${path}.renderCheck`);
      if (stats === undefined)
        throw new BenchError(
          "TN_BENCH_RENDER_CHECK_MISSING",
          `${path} mode ${mode} recorded no frame read-back`,
        );
      const drawCalls = requireNumber(rung, "drawCalls", path);
      const triangles = requireNumber(rung, "triangles", path);
      if (drawCalls <= 0 || triangles <= 0)
        throw new BenchError(
          "TN_BENCH_NOTHING_DRAWN",
          `${path} mode ${mode} submitted ${drawCalls} draw call(s) and ${triangles} triangle(s)`,
        );
      const readBack = Object.fromEntries(
        FRAME_STAT_KEYS.map((key) => [
          key,
          requireNumber(stats as Record<string, unknown>, key, `${path}.renderCheck`),
        ]),
      ) as unknown as IFrameStats;
      const blank = blankFrameReason(readBack);
      if (blank !== null)
        throw new BenchError(
          "TN_BENCH_BLANK_FRAME",
          `${path} mode ${mode} read back a blank or uniform frame: ${blank}`,
        );
      renderCheck = readBack;
      // A rung with characters must also say how big they came out. The Khronos Fox is authored in
      // centimetres, and an unscaled import is a 79 m statue: the counts still match, the frame is
      // still non-blank, and the number published would be a measurement of overdraw. A rung above
      // R3 that recorded no measurement, or recorded one outside `LADDER_FOX_TOLERANCE` of
      // `LADDER_FOX_HEIGHT`, is a failed run.
      if (ladderRank(mode as RealisticRung) >= ladderRank("R3")) {
        const recordedFox = requireObject(rung.foxMeasurement, `${path}.foxMeasurement`);
        foxMeasurement = {
          heightM: requireNumber(recordedFox, "heightM", `${path}.foxMeasurement`),
          screenFraction: requireNumber(recordedFox, "screenFraction", `${path}.foxMeasurement`),
        };
        const wrongFox = foxMeasurementReason(foxMeasurement);
        if (wrongFox !== null)
          throw new BenchError("TN_BENCH_FOX_SIZE", `${path} mode ${mode}: ${wrongFox}`);
      } else if (rung.foxMeasurement !== undefined) {
        throw new BenchError(
          "TN_BENCH_BAD_SHAPE",
          `${path}.foxMeasurement is only meaningful on a rung with characters, not on ${mode}`,
        );
      }
    } else if (
      rung.ladder !== undefined ||
      rung.renderCheck !== undefined ||
      rung.foxMeasurement !== undefined
    ) {
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.ladder, .renderCheck and .foxMeasurement are only meaningful on a realistic-scene rung, not on ${mode}`,
      );
    }
    const pipelineCompiles = rung.pipelineCompiles;
    if (
      pipelineCompiles !== undefined &&
      (typeof pipelineCompiles !== "number" ||
        !Number.isInteger(pipelineCompiles) ||
        pipelineCompiles < 0)
    )
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.pipelineCompiles must be a non-negative integer when present`,
      );
    return {
      ...(rung.framePath === undefined
        ? {}
        : { framePath: requireString(rung, "framePath", path) }),
      ...(rung.framePng === undefined ? {} : { framePng: requireString(rung, "framePng", path) }),
      ...(rung.frameRgba === undefined ? {} : { frameRgba: parseFrameRgba(rung.frameRgba, path) }),
      ...parseCompletedWork(rung, path, frameMs.length),
      ...(cpuMsPerFrame === undefined ? {} : { cpuMsPerFrame }),
      ...(threadCpuMs === undefined ? {} : { threadCpuMs: threadCpuMs as number[] }),
      ...(presentCpuMs === undefined ? {} : { presentCpuMs }),
      ...(bridgeCalls === undefined ? {} : { bridgeCalls }),
      ...(renderCpuMs === undefined ? {} : { renderCpuMs }),
      ...(phases === undefined ? {} : { phases }),
      ...(crossingTop === undefined ? {} : { crossingTop }),
      drawCalls: requireNumber(rung, "drawCalls", path),
      ...(pipelineCompiles === undefined ? {} : { pipelineCompiles }),
      frameMs: frameMs as number[],
      ...(foxMeasurement === undefined ? {} : { foxMeasurement }),
      ...(ladder === undefined ? {} : { ladder }),
      ...(renderCheck === undefined ? {} : { renderCheck }),
      ...timingSeries,
      mode: mode as RenderMode,
      objectCount,
      ...(initialPlacementSha256 === undefined ? {} : { initialPlacementSha256 }),
      positionHash: requireString(rung, "positionHash", path),
      repeat: requireNumber(rung, "repeat", path),
      triangles: requireNumber(rung, "triangles", path),
      visibleObjects: requireNumber(rung, "visibleObjects", path),
    };
  });

  return {
    arm: arm as Arm,
    ...(root.axes === undefined ? {} : { axes: parseRunAxes(root.axes) }),
    build: { notes: typeof build.notes === "string" ? build.notes : "", type: buildType },
    device: {
      battery: (battery as number | null) ?? null,
      label: requireString(device, "label", "report.device"),
    },
    display: {
      height: requireNumber(display, "height", "report.display"),
      refreshHz: requireNumber(display, "refreshHz", "report.display"),
      vsync: requireBoolean(display, "vsync", "report.display"),
      width: requireNumber(display, "width", "report.display"),
    },
    driver: { adapter, renderer },
    ...(deviceCondition === undefined ? {} : { deviceCondition }),
    engine: {
      name: engineName as EngineName,
      version: requireString(engine, "version", "report.engine"),
    },
    ...(root.hostLoad === undefined ? {} : { hostLoad: parseHostLoad(root.hostLoad) }),
    ...(root.identity === undefined ? {} : { identity: parseReportIdentity(root.identity) }),
    ...(provisional === undefined ? {} : { provisional }),
    rungs,
    ...(root.web === undefined ? {} : { web: parseWebMetrics(root.web) }),
  };
}

/** Absolutes are invalid once the one-minute load passes half the cores. */
export function absolutesVerdict(reading: IHostLoadReading): IHostLoad["absolutes"] {
  return reading.load1 > reading.cores / 2 ? "invalid-absolute" : "valid";
}

export interface IHostLoadSource {
  cores(): number;
  loadavg(): number[];
}

/** Defaults to this machine; a spec passes a stub. */
export function readHostLoad(
  source: IHostLoadSource = { cores: () => os.availableParallelism(), loadavg: os.loadavg },
): IHostLoadReading {
  const cores = source.cores();
  const load1 = source.loadavg()[0];
  if (!Number.isInteger(cores) || cores < 1 || load1 === undefined || !Number.isFinite(load1))
    throw new BenchError(
      "TN_BENCH_HOST_LOAD_UNREADABLE",
      `cannot read host load (load1 ${String(load1)}, cores ${String(cores)}); an unmeasured load cannot vouch for absolutes`,
    );
  return { cores, load1 };
}

export function withHostLoad(run: IRunReport, reading: IHostLoadReading): IRunReport {
  return { ...run, hostLoad: { ...reading, absolutes: absolutesVerdict(reading) } };
}

function parseHostLoad(value: unknown): IHostLoad {
  const source = requireObject(value, "report.hostLoad");
  const reading = {
    cores: requireNumber(source, "cores", "report.hostLoad"),
    load1: requireNumber(source, "load1", "report.hostLoad"),
  };
  // Recomputed, never trusted: a report that says "valid" above half the cores is lying.
  const absolutes = absolutesVerdict(reading);
  if (source.absolutes !== absolutes)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `report.hostLoad.absolutes is ${String(source.absolutes)} but load ${reading.load1} on ${reading.cores} cores is ${absolutes}`,
    );
  return { ...reading, absolutes };
}

export function rungKey(mode: RenderMode, objectCount: number): string {
  return `${mode}@${objectCount}`;
}

/** A hitch is a frame slower than this many times the rung's own median: a missed deadline. */
export const HITCH_FACTOR = 2;

function countHitches(frameMs: readonly number[]): number {
  const limit = HITCH_FACTOR * percentile(frameMs, 0.5);
  return frameMs.filter((sample) => sample > limit).length;
}

/**
 * The scoreboard's rows: `summarize` plus the refusal to publish a row with a counter missing. The
 * percentiles, hitches and draw calls come from the frame series, so the only counter a driver can
 * leave out is `pipelineCompiles`, and a rung that did not report one is a hole, never a zero.
 */
export function scoreboardRows(report: IRunReport, godot?: IRunReport): IRungSummary[] {
  report.rungs.forEach((rung, index) => {
    const path = `report.rungs[${index}] (${rung.mode}@${rung.objectCount})`;
    if (!Number.isInteger(rung.drawCalls) || rung.drawCalls < 1)
      throw new BenchError("TN_BENCH_COUNTER_MISSING", `${path} drawCalls is ${rung.drawCalls}`);
    const compiles = rung.pipelineCompiles;
    // ponytail: Godot's load test has no pipeline counter (Godot 4.x exposes
    // RENDERING_INFO_PIPELINE_COMPILATIONS_*; add it to load_test.gd and drop this exemption).
    if (report.engine.name === "godot" && compiles === undefined) return;
    if (compiles === undefined || !Number.isInteger(compiles) || compiles < 0)
      throw new BenchError(
        "TN_BENCH_COUNTER_MISSING",
        `${path} reported no pipelineCompiles (${String(compiles)}); a scoreboard row needs the counter, not a default`,
      );
  });
  const rows = summarize(report);
  if (godot === undefined) return rows;
  if (godot.arm !== "godot-desktop")
    throw new BenchError("TN_BENCH_BAD_SHAPE", "godotRatio requires godot-desktop");
  const reference = scoreboardRows(godot);
  return rows.map((row) => {
    const match = reference.find(
      (other) => other.mode === row.mode && other.objectCount === row.objectCount,
    );
    if (!["R2", "R3", "R5"].includes(row.mode) || match === undefined) return row;
    if (row.p50 <= 0 || match.p50 <= 0)
      throw new BenchError("TN_BENCH_BAD_SHAPE", "godotRatio requires positive frame p50");
    return { ...row, godotRatio: match.p50 / row.p50 };
  });
}

/** A per-frame series a rung may carry: a non-empty array of non-negative numbers, or absent. */
function optionalSeries(
  rung: Record<string, unknown>,
  field: string,
  path: string,
): number[] | undefined {
  const series = rung[field];
  if (series === undefined) return undefined;
  if (
    !Array.isArray(series) ||
    series.length === 0 ||
    series.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
  )
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path}.${field} must be a non-empty array of non-negative numbers when present`,
    );
  return series as number[];
}

/** A rung's phase series: exactly the `PHASES` names, each as long as `frameMs`, finite and non-negative. */
function parsePhases(
  value: unknown,
  frames: number,
  path: string,
): Record<Phase, number[]> | undefined {
  if (value === undefined) return undefined;
  const series = requireObject(value, path);
  const unknown = Object.keys(series).filter(
    (name) => !(PHASES as readonly string[]).includes(name),
  );
  if (unknown.length > 0)
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path} names unknown phases: ${unknown.join(", ")}`,
    );
  for (const name of PHASES) {
    const samples = series[name];
    if (
      !Array.isArray(samples) ||
      samples.length !== frames ||
      samples.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
    )
      throw new BenchError(
        "TN_BENCH_BAD_SHAPE",
        `${path}.${name} must carry ${frames} finite non-negative samples, one per frame`,
      );
  }
  return series as Record<Phase, number[]>;
}

/** Up to five `[name, crossings per frame]` pairs, most crossed first. */
function parseCrossingTop(value: unknown, path: string): Array<[string, number]> | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    value.some(
      (pair) =>
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        typeof pair[0] !== "string" ||
        pair[0].length === 0 ||
        typeof pair[1] !== "number" ||
        !Number.isFinite(pair[1]) ||
        pair[1] < 0,
    )
  )
    throw new BenchError(
      "TN_BENCH_BAD_SHAPE",
      `${path} must be at most five [name, non-negative crossings per frame] pairs`,
    );
  return value as Array<[string, number]>;
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * One repeat's phase stats. `present` and `other` need the host's frame line (`threadCpuMs` without the
 * present call, `presentCpuMs`), joined to the page's frames by index from the start of the window; the
 * host prints a frame or two more or fewer than the page measures, so the shortest series sets the length.
 * The engine player's facade defers the real draw until the page's frame is over and reports it as
 * `renderCpuMs`; it is added to `render`, so both arms' `render` is the whole draw call, Dawn work included.
 */
export function rungPhaseStats(
  rung: IRunReportRung,
): Partial<Record<SummaryPhase, IPhaseStat>> | undefined {
  const phases = rung.phases;
  if (phases === undefined) return undefined;
  const { threadCpuMs: thread, presentCpuMs: present, renderCpuMs: host } = rung;
  const hostSeries = [thread, present, host].filter((series) => series !== undefined);
  const frames = Math.min(rung.frameMs.length, ...hostSeries.map((series) => series.length));
  const stat = (series: readonly number[]): IPhaseStat => ({
    mean: mean(series),
    p50: percentile(series, 0.5),
  });
  const series = (name: Phase): number[] =>
    phases[name]
      .slice(0, frames)
      .map((ms, index) =>
        name === "render" && host !== undefined ? ms + (host[index] as number) : ms,
      );
  const out: Partial<Record<SummaryPhase, IPhaseStat>> = {};
  for (const name of PHASES) out[name] = stat(series(name));
  if (thread !== undefined && present !== undefined) {
    const measured = PHASES.map(series);
    out.present = stat(present.slice(0, frames));
    out.other = stat(
      thread
        .slice(0, frames)
        .map(
          (ms, index) => ms - measured.reduce((sum, column) => sum + (column[index] as number), 0),
        ),
    );
  }
  return out;
}

/** The median across repeats of each phase's stats; a phase only some repeats carry is left out. */
export function pooledPhaseStats(
  stats: ReadonlyArray<Partial<Record<SummaryPhase, IPhaseStat>> | undefined>,
): Partial<Record<SummaryPhase, IPhaseStat>> | undefined {
  if (stats.some((entry) => entry === undefined)) return undefined;
  const out: Partial<Record<SummaryPhase, IPhaseStat>> = {};
  for (const name of SUMMARY_PHASES) {
    const found = stats.map((entry) => entry?.[name]);
    if (found.every((entry) => entry !== undefined))
      out[name] = {
        mean: median(found.map((entry) => (entry as IPhaseStat).mean)),
        p50: median(found.map((entry) => (entry as IPhaseStat).p50)),
      };
  }
  return out;
}

export function summarize(report: IRunReport): IRungSummary[] {
  const groups = new Map<string, IRunReportRung[]>();
  for (const rung of report.rungs) {
    const key = rungKey(rung.mode, rung.objectCount);
    const bucket = groups.get(key) ?? [];
    bucket.push(rung);
    groups.set(key, bucket);
  }
  const summaries: IRungSummary[] = [];
  for (const bucket of groups.values()) {
    const first = bucket[0] as IRunReportRung;
    const compiles = bucket.map((rung) => rung.pipelineCompiles);
    const cpu = bucket.map((rung) => rung.cpuMsPerFrame);
    const thread = bucket.map((rung) => rung.threadCpuMs);
    const present = bucket.map((rung) => rung.presentCpuMs);
    const crossings = bucket.map((rung) => rung.bridgeCalls);
    const phaseStats = pooledPhaseStats(bucket.map(rungPhaseStats));
    const crossingTop = bucket.find((rung) => rung.crossingTop !== undefined)?.crossingTop;
    summaries.push({
      ...(phaseStats === undefined ? {} : { phases: phaseStats }),
      ...(crossingTop === undefined ? {} : { crossingTop }),
      ...(cpu.every((value) => value !== undefined)
        ? { cpuMsPerFrame: median(cpu as number[]) }
        : {}),
      ...(thread.every((series) => series !== undefined)
        ? { threadCpuP50: median((thread as number[][]).map((series) => percentile(series, 0.5))) }
        : {}),
      ...(present.every((series) => series !== undefined)
        ? {
            presentCpuP50: median((present as number[][]).map((series) => percentile(series, 0.5))),
          }
        : {}),
      ...(crossings.every((series) => series !== undefined)
        ? {
            crossingsP50: median(
              (crossings as number[][]).map((series) => percentile(series, 0.5)),
            ),
          }
        : {}),
      drawCalls: median(bucket.map((rung) => rung.drawCalls)),
      hitches: median(bucket.map((rung) => countHitches(rung.frameMs))),
      mode: first.mode,
      objectCount: first.objectCount,
      p50: median(bucket.map((rung) => percentile(rung.frameMs, 0.5))),
      p95: median(bucket.map((rung) => percentile(rung.frameMs, 0.95))),
      p99: median(bucket.map((rung) => percentile(rung.frameMs, 0.99))),
      ...(compiles.every((count) => count !== undefined)
        ? { pipelineCompiles: median(compiles as number[]) }
        : {}),
      repeats: bucket.length,
      sampleCount: first.frameMs.length,
      triangles: median(bucket.map((rung) => rung.triangles)),
      visibleObjects: median(bucket.map((rung) => rung.visibleObjects)),
    });
  }
  return summaries.sort((left, right) =>
    left.mode === right.mode
      ? left.objectCount - right.objectCount
      : left.mode.localeCompare(right.mode),
  );
}

// The knee is the last ladder rung before the first crossing of the threshold — not the largest
// rung that happens to sit under it, which a noisy non-monotone curve would misreport.
export function knee(
  summaries: readonly IRungSummary[],
  mode: RenderMode,
  thresholdMs: number = KNEE_THRESHOLD_MS,
): number | null {
  const ladder = summaries
    .filter((summary) => summary.mode === mode)
    .sort((left, right) => left.objectCount - right.objectCount);
  let best: number | null = null;
  for (const summary of ladder) {
    if (summary.p95 > thresholdMs) return best;
    best = summary.objectCount;
  }
  return best;
}

/**
 * The performance a device run is required to keep, per arm.
 *
 * Recorded, not computed: each entry is a number some named device actually produced, and the file
 * that produced it is cited so a reader can check the conditions rather than trust the figure.
 *
 * **Why a baseline at all.** The realistic regression here is not drift, it is a *cliff*: the
 * Android engine default reverting to QuickJS takes the top rung from 8.34 ms to 101.24 ms. That is
 * 12x, and it is invisible without a comparison because the build still succeeds, the APK still
 * installs, and the frames still render. `--expect-engine` catches it when a gate asks; this catches
 * it when a benchmark runs.
 */
export const PERFORMANCE_BASELINES: Readonly<Record<string, IPerformanceBaseline>> = {
  // The emulator canary, keyed separately because it measures something else. Its numbers are 8x the
  // phone's for identical work — swiftshader is a CPU rasteriser, so software rendering dominates the
  // frame and squeezes the engine ratio from 12.1x to 2.4x. Still catchable, which is the point: this
  // is the only Android performance gate that can run without a phone attached.
  //
  // **Never quote these as performance figures.** They are a tripwire, not a measurement.
  "tn-android@emulator": {
    status: "diagnostic",
    evidence: "docs/verification/prd-130-emulator-canary-2026-08-17.md",
    rungs: { "L2@4096": 75.17, "L2@16384": 204.08, "L3@4096": 48.03, "L3@16384": 65.76 },
  },
  "tn-android": {
    status: "diagnostic",
    // docs/verification/prd-130-phase-6-2026-08-16.md — Pixel 8 `37251FDJH0037Z`, V8, vsync on at
    // 120 Hz. Every rung is at the frame interval, so these are ceilings on V8's real cost.
    evidence: "docs/verification/prd-130-phase-6-2026-08-16.md",
    rungs: { "L2@4096": 8.27, "L2@16384": 8.21, "L3@4096": 8.29, "L3@16384": 8.34 },
  },
};

export type PerformanceBaselineStatus = "accepted" | "diagnostic" | "unavailable";

export interface IPerformanceBaselineIdentity extends IPerformanceIdentity {
  readonly device: string;
}

export interface IPerformanceBaseline {
  readonly evidence: string;
  /** p50 milliseconds, keyed `<mode>@<objectCount>`. */
  readonly rungs: Readonly<Record<string, number>>;
  /** Accepted baselines are eligible for required gates; old entries remain diagnostic by default. */
  readonly status?: PerformanceBaselineStatus;
  readonly reason?: string;
  readonly lane?: string;
  readonly workload?: string;
  readonly device?: string;
  readonly identity?: IPerformanceBaselineIdentity;
}

export interface IPerformanceLaneBaseline {
  readonly status: PerformanceBaselineStatus;
  readonly evidence?: string;
  readonly provenance?: string;
  readonly reason?: string;
  readonly rungs?: Readonly<Record<string, number>>;
  readonly identity?: IPerformanceBaselineIdentity;
}

export interface IPerformanceLane {
  readonly id: string;
  readonly platform: RequiredPlatformLane;
  readonly arms: readonly Arm[];
  readonly workload: string;
  readonly requiredMetrics: readonly string[];
  readonly producer: string;
  readonly evidenceClass: string;
  readonly baseline: IPerformanceLaneBaseline;
  readonly deviceResource?: string;
  readonly provisioning?: PerformanceLaneProvisioning;
  readonly required?: boolean;
}

export interface IPerformanceLaneManifest {
  readonly schemaVersion: 1;
  readonly policyRevision: string;
  readonly lanes: readonly IPerformanceLane[];
  readonly promotionPolicy?: IPerformancePromotionPolicy;
}

function parseStringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field} must be an array of non-empty strings`,
    );
  }
  if (!allowEmpty && value.length === 0) {
    throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", `${field} must not be empty`);
  }
  return [...value];
}

function optionalString(
  source: Record<string, unknown>,
  key: string,
  field: string,
): string | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.${key} must be a non-empty string`,
    );
  }
  return value;
}

function optionalBoolean(
  source: Record<string, unknown>,
  key: string,
  field: string,
): boolean | undefined {
  const value = source[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", `${field}.${key} must be boolean`);
  }
  return value;
}

function optionalProvisioning(
  source: Record<string, unknown>,
  field: string,
): PerformanceLaneProvisioning | undefined {
  const value = optionalString(source, "provisioning", field);
  if (value === undefined) return undefined;
  if (
    value !== "hosted-software" &&
    value !== "physical-hardware" &&
    value !== "simulator" &&
    value !== "unprovisioned"
  ) {
    throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", `${field}.provisioning is unknown`);
  }
  return value;
}

function positiveInteger(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.${key} must be a positive integer`,
    );
  }
  return value;
}

function nonNegativeNumber(source: Record<string, unknown>, key: string, field: string): number {
  const value = source[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.${key} must be a finite non-negative number`,
    );
  }
  return value;
}

function parsePromotionPolicy(value: unknown): IPerformancePromotionPolicy | undefined {
  if (value === undefined) return undefined;
  const field = "lane manifest.promotionPolicy";
  const source = requireObject(value, field);
  const requiredCheckPromotion = requireString(source, "requiredCheckPromotion", field);
  const baselineRegeneration = requireString(source, "baselineRegeneration", field);
  const calibrationStatus = requireString(source, "calibrationStatus", field);
  if (requiredCheckPromotion !== "maintainer-review") {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.requiredCheckPromotion must be maintainer-review`,
    );
  }
  if (baselineRegeneration !== "separate-reviewed-change") {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.baselineRegeneration must be separate-reviewed-change`,
    );
  }
  if (calibrationStatus !== "accepted" && calibrationStatus !== "unverified") {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.calibrationStatus must be accepted or unverified`,
    );
  }
  const requiredCounts = {
    accuracyRuns: 20,
    calibrationPairs: 10,
    ciCostRuns: 20,
    maxIncrementalRunnerMinutes: 6,
    maxQueueSeconds: 120,
    minimumCalibrationSessions: 3,
  } as const;
  for (const [key, expected] of Object.entries(requiredCounts)) {
    if (source[key] !== expected) {
      throw new BenchError(
        "TN_BENCH_BAD_LANE_MANIFEST",
        `${field}.${key} must remain ${expected} until measured promotion evidence is reviewed`,
      );
    }
  }
  return {
    accuracyRuns: positiveInteger(source, "accuracyRuns", field),
    baselineRegeneration,
    calibrationStatus,
    calibrationPairs: positiveInteger(source, "calibrationPairs", field),
    ciCostRuns: positiveInteger(source, "ciCostRuns", field),
    maxIncrementalRunnerMinutes: nonNegativeNumber(source, "maxIncrementalRunnerMinutes", field),
    maxQueueSeconds: nonNegativeNumber(source, "maxQueueSeconds", field),
    minimumCalibrationSessions: positiveInteger(source, "minimumCalibrationSessions", field),
    requiredCheckPromotion,
  };
}

function parseIdentity(
  value: unknown,
  field: string,
  required: boolean,
): IPerformanceBaselineIdentity | undefined {
  if (value === undefined) {
    if (required)
      throw new BenchError(
        "TN_BENCH_BAD_LANE_MANIFEST",
        `${field} is required for an accepted baseline`,
      );
    return undefined;
  }
  const source = requireObject(value, field);
  const device = optionalString(source, "device", field);
  if (required && device === undefined) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.device is required for an accepted baseline`,
    );
  }
  const identity = {
    architecture: optionalString(source, "architecture", field),
    artifactHash: optionalString(source, "artifactHash", field),
    browser: optionalString(source, "browser", field),
    device: device ?? "",
    graphicsBackend: optionalString(source, "graphicsBackend", field),
    gpu: optionalString(source, "gpu", field),
    instrumentationRevision: optionalString(source, "instrumentationRevision", field),
    jsRuntime: optionalString(source, "jsRuntime", field),
    nativeBinaryHash: optionalString(source, "nativeBinaryHash", field),
    operatingSystem: optionalString(source, "operatingSystem", field),
    presentMode: optionalString(source, "presentMode", field),
    resolution: optionalString(source, "resolution", field),
    sourceSha: optionalString(source, "sourceSha", field),
    workloadHash: optionalString(source, "workloadHash", field),
  };
  if (required) {
    const missing = [
      "architecture",
      "artifactHash",
      "browser",
      "graphicsBackend",
      "gpu",
      "instrumentationRevision",
      "jsRuntime",
      "nativeBinaryHash",
      "operatingSystem",
      "presentMode",
      "resolution",
      "sourceSha",
      "workloadHash",
    ].filter((key) => identity[key as keyof typeof identity] === undefined);
    if (missing.length > 0) {
      throw new BenchError(
        "TN_BENCH_BAD_LANE_MANIFEST",
        `${field} is missing identity fields: ${missing.join(", ")}`,
      );
    }
  }
  return identity as IPerformanceBaselineIdentity;
}

function parseLaneBaseline(value: unknown, field: string): IPerformanceLaneBaseline {
  const source = requireObject(value, field);
  const status = optionalString(source, "status", field);
  if (status !== "accepted" && status !== "diagnostic" && status !== "unavailable") {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field}.status must be accepted, diagnostic, or unavailable`,
    );
  }
  const reason = optionalString(source, "reason", field);
  const evidence = optionalString(source, "evidence", field);
  const provenance = optionalString(source, "provenance", field);
  const rawRungs = source.rungs;
  let rungs: Record<string, number> | undefined;
  if (rawRungs !== undefined) {
    const parsed = requireObject(rawRungs, `${field}.rungs`);
    rungs = {};
    for (const [rung, valueForRung] of Object.entries(parsed)) {
      if (
        rung.length === 0 ||
        typeof valueForRung !== "number" ||
        !Number.isFinite(valueForRung) ||
        valueForRung <= 0
      ) {
        throw new BenchError(
          "TN_BENCH_BAD_LANE_MANIFEST",
          `${field}.rungs must contain finite positive numbers keyed by rung`,
        );
      }
      rungs[rung] = valueForRung;
    }
  }
  if (status === "unavailable") {
    if (reason === undefined) {
      throw new BenchError(
        "TN_BENCH_BAD_LANE_MANIFEST",
        `${field}.reason is required when unavailable`,
      );
    }
    if (rungs !== undefined || evidence !== undefined || provenance !== undefined) {
      throw new BenchError(
        "TN_BENCH_BAD_LANE_MANIFEST",
        `${field} unavailable baselines cannot carry accepted evidence or rung values`,
      );
    }
    return { reason, status };
  }
  const evidencePath = evidence ?? provenance;
  if (evidencePath === undefined) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${field} must name evidence or provenance when status is ${status}`,
    );
  }
  if (rungs === undefined || Object.keys(rungs).length === 0) {
    throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", `${field}.rungs must not be empty`);
  }
  const identity = parseIdentity(source.identity, `${field}.identity`, status === "accepted");
  return {
    evidence: evidencePath,
    ...(provenance === undefined ? {} : { provenance }),
    ...(reason === undefined ? {} : { reason }),
    rungs,
    ...(identity === undefined ? {} : { identity }),
    status,
  };
}

/** Parse the checked-in lane contract; missing observations are data, not an implicit pass. */
export function parsePerformanceLaneManifest(value: unknown): IPerformanceLaneManifest {
  const root = requireObject(value, "lane manifest");
  if (root.schemaVersion !== 1) {
    throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", "schemaVersion must be 1");
  }
  const policyRevision = requireString(root, "policyRevision", "lane manifest");
  const rawLanes = root.lanes;
  if (!Array.isArray(rawLanes) || rawLanes.length === 0) {
    throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", "lanes must not be empty");
  }
  const seenIds = new Set<string>();
  const seenPlatforms = new Set<string>();
  const seenWorkloads = new Set<string>();
  const lanes = rawLanes.map((valueForLane, index) => {
    const field = `lane manifest.lanes[${index}]`;
    const source = requireObject(valueForLane, field);
    const id = requireString(source, "id", field);
    const platform = requireString(source, "platform", field);
    if (!(REQUIRED_PLATFORM_LANES as readonly string[]).includes(platform)) {
      throw new BenchError(
        "TN_BENCH_BAD_LANE_MANIFEST",
        `${field}.platform ${platform} is unknown`,
      );
    }
    const workloadKey = `${platform}:${requireString(source, "workload", field)}`;
    if (seenIds.has(id) || seenWorkloads.has(workloadKey)) {
      throw new BenchError("TN_BENCH_BAD_LANE_MANIFEST", `${field} duplicates lane id or platform`);
    }
    seenIds.add(id);
    seenWorkloads.add(workloadKey);
    seenPlatforms.add(platform);
    const arms = parseStringArray(source.arms, `${field}.arms`, true).map((arm) => {
      if (!(ARMS as readonly string[]).includes(arm)) {
        throw new BenchError(
          "TN_BENCH_BAD_LANE_MANIFEST",
          `${field}.arms contains unknown arm ${arm}`,
        );
      }
      return arm as Arm;
    });
    const deviceResource = optionalString(source, "deviceResource", field);
    const provisioning = optionalProvisioning(source, field);
    const required = optionalBoolean(source, "required", field);
    return {
      arms,
      baseline: parseLaneBaseline(source.baseline, `${field}.baseline`),
      ...(deviceResource === undefined ? {} : { deviceResource }),
      evidenceClass: requireString(source, "evidenceClass", field),
      id,
      platform: platform as RequiredPlatformLane,
      producer: requireString(source, "producer", field),
      ...(provisioning === undefined ? {} : { provisioning }),
      requiredMetrics: parseStringArray(source.requiredMetrics, `${field}.requiredMetrics`),
      ...(required === undefined ? {} : { required }),
      workload: requireString(source, "workload", field),
    };
  });
  const missingPlatforms = REQUIRED_PLATFORM_LANES.filter(
    (platform) => !seenPlatforms.has(platform),
  );
  if (missingPlatforms.length > 0) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `missing required platform lanes: ${missingPlatforms.join(", ")}`,
    );
  }
  const promotionPolicy = parsePromotionPolicy(root.promotionPolicy);
  if (
    promotionPolicy?.calibrationStatus !== "accepted" &&
    lanes.some((lane) => lane.required === true)
  ) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      "required performance lanes need accepted calibration evidence before promotion",
    );
  }
  const unapprovedRequiredLanes = lanes.filter(
    (lane) => lane.required === true && lane.baseline.status !== "accepted",
  );
  if (unapprovedRequiredLanes.length > 0) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `required performance lanes need accepted baselines: ${unapprovedRequiredLanes.map((lane) => lane.id).join(", ")}`,
    );
  }
  return {
    lanes,
    policyRevision,
    ...(promotionPolicy === undefined ? {} : { promotionPolicy }),
    schemaVersion: 1,
  };
}

export function laneForArm(
  manifest: IPerformanceLaneManifest,
  arm: Arm,
): IPerformanceLane | undefined {
  const matches = manifest.lanes.filter((lane) => lane.arms.includes(arm));
  if (matches.length > 1) {
    throw new BenchError(
      "TN_BENCH_AMBIGUOUS_LANE",
      `${arm} is assigned to multiple lanes: ${matches.map((lane) => lane.id).join(", ")}`,
    );
  }
  return matches[0];
}

export function laneForId(
  manifest: IPerformanceLaneManifest,
  id: string,
): IPerformanceLane | undefined {
  return manifest.lanes.find((lane) => lane.id === id);
}

export function baselineForLane(lane: IPerformanceLane): IPerformanceBaseline | undefined {
  if (lane.baseline.status !== "accepted") return undefined;
  const evidence = lane.baseline.evidence ?? lane.baseline.provenance;
  const rungs = lane.baseline.rungs;
  if (evidence === undefined || rungs === undefined || lane.baseline.identity === undefined) {
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `${lane.id} accepted baseline is missing evidence, rungs, or identity`,
    );
  }
  return {
    evidence,
    identity: lane.baseline.identity,
    lane: lane.id,
    rungs,
    status: lane.baseline.status,
    workload: lane.workload,
  };
}

/**
 * How much slower than its baseline a rung may read before it is a regression.
 *
 * Deliberately loose. Device frame timings swing with thermal state and machine load, and a tight
 * bound turns this into a false-alarm generator that people learn to ignore — which is worse than no
 * gate. It is set to catch the cliff described above, not to police a few per cent: at 0.25 a 12x
 * engine revert trips it forty-odd times over, while an ordinary noisy afternoon does not.
 */
export const PERFORMANCE_REGRESSION_TOLERANCE = 0.25;

export interface IPerformanceRegression {
  readonly allowedMs: number;
  readonly baselineMs: number;
  readonly measuredMs: number;
  readonly rung: string;
}

export interface IPerformanceCheck {
  readonly arm: Arm;
  readonly checked: readonly string[];
  readonly evidence: string;
  readonly regressions: readonly IPerformanceRegression[];
  readonly tolerance: number;
}

export interface IPerformanceCheckOptions {
  /** Required lanes fail with exit-code 2 when no accepted baseline is available. */
  readonly required?: boolean;
  /** Manifest lane identity expected by the caller. */
  readonly laneId?: string;
}

function reportDeviceIdentity(report: IRunReport): string {
  return report.deviceCondition?.serial ?? report.identity?.device ?? report.device.label;
}

function validateBaseline(
  report: IRunReport,
  baseline: IPerformanceBaseline,
  options: IPerformanceCheckOptions,
): void {
  if (options.required && (baseline.status === "diagnostic" || baseline.status === "unavailable")) {
    throw new BenchError(
      "TN_BENCH_BASELINE_MISSING",
      `${report.arm} has no accepted baseline${baseline.reason === undefined ? "" : `: ${baseline.reason}`}`,
    );
  }
  if (
    typeof baseline.evidence !== "string" ||
    baseline.evidence.length === 0 ||
    /TBD|UNVERIFIED|missing/i.test(baseline.evidence)
  ) {
    throw new BenchError(
      "TN_BENCH_BASELINE_EVIDENCE_MISSING",
      `${report.arm} baseline evidence is empty or not an accepted record: ${String(baseline.evidence)}`,
    );
  }
  if (
    typeof baseline.rungs !== "object" ||
    baseline.rungs === null ||
    Array.isArray(baseline.rungs)
  ) {
    throw new BenchError(
      "TN_BENCH_BASELINE_EMPTY",
      `${report.arm} baseline evidence has no rung map; an empty baseline cannot pass`,
    );
  }
  const rungEntries = Object.entries(baseline.rungs);
  if (rungEntries.length === 0) {
    throw new BenchError(
      "TN_BENCH_BASELINE_EMPTY",
      `${report.arm} baseline evidence names no rungs; an empty baseline cannot pass`,
    );
  }
  for (const [rung, value] of rungEntries) {
    if (!/^L[123]@[1-9][0-9]*$/u.test(rung) || !Number.isFinite(value) || value <= 0) {
      throw new BenchError(
        "TN_BENCH_BASELINE_BAD_RUNG",
        `${report.arm} baseline rung ${rung} must carry a finite positive timing`,
      );
    }
  }
  if (
    options.laneId !== undefined &&
    baseline.lane !== undefined &&
    baseline.lane !== options.laneId
  ) {
    throw new BenchError(
      "TN_BENCH_BASELINE_IDENTITY_MISMATCH",
      `${report.arm} baseline belongs to lane ${baseline.lane}, requested ${options.laneId}`,
    );
  }
  const identity = baseline.identity;
  const expectedDevice = baseline.device ?? identity?.device;
  if (expectedDevice !== undefined && expectedDevice !== reportDeviceIdentity(report)) {
    throw new BenchError(
      "TN_BENCH_BASELINE_IDENTITY_MISMATCH",
      `${report.arm} baseline device ${expectedDevice} does not match run device ${reportDeviceIdentity(report)}`,
    );
  }
  if (identity === undefined) return;
  const reportIdentity = report.identity;
  if (reportIdentity === undefined) {
    if (options.required) {
      throw new BenchError(
        "TN_BENCH_BASELINE_IDENTITY_MISSING",
        `${report.arm} required run has no source/artifact identity to compare with its baseline`,
      );
    }
    return;
  }
  if (options.required) {
    const missingProvenance = ["sourceSha", "artifactHash", "nativeBinaryHash"].filter((field) => {
      const value = reportIdentity[field as keyof IPerformanceIdentity];
      return typeof value !== "string" || value.length === 0;
    });
    if (missingProvenance.length > 0) {
      throw new BenchError(
        "TN_BENCH_BASELINE_IDENTITY_MISSING",
        `${report.arm} required run is missing provenance fields: ${missingProvenance.join(", ")}`,
      );
    }
  }
  const identityFields: readonly (keyof IPerformanceIdentity)[] = [
    "architecture",
    "browser",
    "graphicsBackend",
    "gpu",
    "instrumentationRevision",
    "jsRuntime",
    "operatingSystem",
    "presentMode",
    "resolution",
    "workloadHash",
  ];
  for (const field of identityFields) {
    const baselineValue = identity[field];
    const reportValue = reportIdentity[field];
    if (baselineValue !== undefined && reportValue !== baselineValue) {
      throw new BenchError(
        "TN_BENCH_BASELINE_IDENTITY_MISMATCH",
        `${report.arm} baseline ${field} ${baselineValue} does not match run ${reportValue ?? "missing"}`,
      );
    }
  }
}

/**
 * Compares a run against its arm's recorded baseline. Fails closed in every direction.
 *
 * A rung the baseline names and the report does not is a **failure**, never a skip: a benchmark that
 * silently stops measuring the top rung is exactly how a regression hides, and it is the same defect
 * class as v1's harness reporting pass on a scenario that asserted nothing. A provisional report is
 * refused for the same reason `compare` refuses one — a number taken outside its declared conditions
 * cannot clear a bar.
 */
export function checkPerformance(
  report: IRunReport,
  baselines: Readonly<Record<string, IPerformanceBaseline>> = PERFORMANCE_BASELINES,
  tolerance: number = PERFORMANCE_REGRESSION_TOLERANCE,
  options: IPerformanceCheckOptions = {},
): IPerformanceCheck | undefined {
  // An emulator run is compared against the emulator baseline, never the phone's: the same arm on
  // software rendering is 8x slower for identical work, so crossing them would report a regression on
  // every emulator run and a pass on nothing.
  const serial = report.deviceCondition?.serial ?? "";
  const key = /^emulator-/u.test(serial) ? `${report.arm}@emulator` : report.arm;
  const baseline = baselines[key];
  if (baseline === undefined) {
    if (options.required) {
      throw new BenchError(
        "TN_BENCH_BASELINE_MISSING",
        `${report.arm} has no accepted baseline for requested lane${options.laneId === undefined ? "" : ` ${options.laneId}`}`,
      );
    }
    return undefined;
  }
  validateBaseline(report, baseline, options);
  if (report.provisional !== undefined && report.provisional.length > 0) {
    throw new BenchError(
      "TN_BENCH_PROVISIONAL_BASELINE",
      `${report.arm} report is provisional (${report.provisional.join(", ")}); a provisional number cannot clear a performance baseline.`,
    );
  }
  if (report.hostLoad?.absolutes === "invalid-absolute") {
    throw new BenchError(
      "TN_BENCH_INVALID_ABSOLUTE",
      `${report.arm} ran at load ${report.hostLoad.load1} on ${report.hostLoad.cores} cores; its absolute milliseconds cannot clear a performance baseline.`,
    );
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new BenchError(
      "TN_BENCH_BAD_TOLERANCE",
      `tolerance must be a non-negative number, received ${String(tolerance)}.`,
    );
  }

  const measured = new Map(
    summarize(report).map((entry) => [rungKey(entry.mode, entry.objectCount), entry.p50]),
  );
  const regressions: IPerformanceRegression[] = [];
  const checked: string[] = [];
  for (const [rung, baselineMs] of Object.entries(baseline.rungs)) {
    const measuredMs = measured.get(rung);
    if (measuredMs === undefined) {
      throw new BenchError(
        "TN_BENCH_BASELINE_RUNG_MISSING",
        `${report.arm} baseline names ${rung} and the run did not measure it. A run that stops measuring a rung cannot clear its baseline.`,
      );
    }
    checked.push(rung);
    const allowedMs = baselineMs * (1 + tolerance);
    if (measuredMs > allowedMs) regressions.push({ allowedMs, baselineMs, measuredMs, rung });
  }
  return { arm: key as Arm, checked, evidence: baseline.evidence, regressions, tolerance };
}

export function renderPerformanceCheck(check: IPerformanceCheck): string {
  const head = `**Performance baseline** — ${check.arm}, tolerance +${Math.round(check.tolerance * 100)}%, from \`${check.evidence}\`.`;
  if (check.regressions.length === 0) {
    return `${head} ${check.checked.length} rung(s) within budget.`;
  }
  return [
    head,
    "",
    "| Rung | Baseline p50 | Measured p50 | Allowed |",
    "| --- | ---: | ---: | ---: |",
    ...check.regressions.map(
      (row) =>
        `| ${row.rung} | ${row.baselineMs.toFixed(2)} ms | **${row.measuredMs.toFixed(2)} ms** | ${row.allowedMs.toFixed(2)} ms |`,
    ),
  ].join("\n");
}

function drawCallFailure(
  mode: RenderMode,
  objectCount: number,
  left: IRungSummary,
  right: IRungSummary,
): IEquivalenceFailure | undefined {
  // L1 and L4 both draw one call per authored cube — L4 with a material per cube, which is exactly
  // what stops an engine from folding them — so the "one arm silently batched" guard is the same
  // check, and the L2 batch check below must not be applied to a rung of 4,096 draws.
  if (mode === "L1" || mode === "L4") {
    // An arm reporting one draw where the other reports N has silently auto-batched and is not
    // running this rung at all — the single most likely way this comparison gets published wrong
    // (§5.2).
    for (const [side, summary] of [
      ["left", left],
      ["right", right],
    ] as const) {
      const expected = Math.max(0, summary.visibleObjects);
      if (Math.abs(summary.drawCalls - expected) > 2 && summary.drawCalls < objectCount * 0.5) {
        return {
          field: `drawCalls (${side} arm auto-batched ${mode})`,
          left: String(left.drawCalls),
          right: String(right.drawCalls),
          rung: rungKey(mode, objectCount),
        };
      }
    }
    return ratioFailure(left, right, mode, objectCount);
  }
  // L2's own claim is that the batch is small enough to be comparable. R1-R5 are L3's authoring —
  // the projection folds the cubes and the rungs add real draws on top of it, R3 by one per skinned
  // character — so the ceiling belongs to L2 alone, and the rungs get the same ratio guard L3 does.
  if (mode === "L2") {
    if (
      left.drawCalls > 8 ||
      right.drawCalls > 8 ||
      Math.abs(left.drawCalls - right.drawCalls) > 4
    ) {
      return {
        field: "drawCalls (L2 must be a small, comparable batch)",
        left: String(left.drawCalls),
        right: String(right.drawCalls),
        rung: rungKey(mode, objectCount),
      };
    }
    return undefined;
  }
  return ratioFailure(left, right, mode, objectCount);
}

/** Two arms of the same batched rung drawing wildly different counts are not the same scene. */
function ratioFailure(
  left: IRungSummary,
  right: IRungSummary,
  mode: RenderMode,
  objectCount: number,
): IEquivalenceFailure | undefined {
  const ratio =
    Math.max(left.drawCalls, right.drawCalls) /
    Math.max(1, Math.min(left.drawCalls, right.drawCalls));
  if (ratio > 1.25) {
    return {
      field: "drawCalls",
      left: String(left.drawCalls),
      right: String(right.drawCalls),
      rung: rungKey(mode, objectCount),
    };
  }
  return undefined;
}

function groupRungs(report: IRunReport): Map<string, IRunReportRung[]> {
  const groups = new Map<string, IRunReportRung[]>();
  for (const rung of report.rungs) {
    const key = rungKey(rung.mode, rung.objectCount);
    const bucket = groups.get(key) ?? [];
    bucket.push(rung);
    groups.set(key, bucket);
  }
  return groups;
}

// A frame interval that barely moves while the object count grows 16x is the display pacing the
// arm, not the engine costing anything. Godot's Android export ignores VSYNC_DISABLED and reported
// ~19 ms at every rung of a 16x ladder; the requested `display.vsync` said false and the gate let
// it through, so the flatness is detected from the samples instead of taken on trust.
export function looksVsyncPinned(summaries: readonly IRungSummary[], mode: RenderMode): boolean {
  const ladder = summaries
    .filter((summary) => summary.mode === mode)
    .sort((left, right) => left.objectCount - right.objectCount);
  if (ladder.length < 3) return false;
  const first = ladder[0] as IRungSummary;
  const last = ladder[ladder.length - 1] as IRungSummary;
  const objectGrowth = last.objectCount / Math.max(1, first.objectCount);
  if (objectGrowth < 4) return false;
  const costGrowth = last.p95 / Math.max(0.001, first.p95);
  return costGrowth < 1.25;
}

export function isSoftwareRasteriser(adapter: string): boolean {
  return /swiftshader|llvmpipe|softwarerasterizer|software adapter/i.test(adapter);
}

export function checkEquivalence(left: IRunReport, right: IRunReport): IEquivalenceFailure[] {
  const failures: IEquivalenceFailure[] = [];
  const push = (field: string, a: unknown, b: unknown, rung = "-"): void => {
    failures.push({ field, left: String(a), right: String(b), rung });
  };

  if (left.build.type !== right.build.type) push("build.type", left.build.type, right.build.type);
  // A hardware arm against a software-rasterised one is the same class of mistake as release
  // against debug: both would publish a ratio that is about the fallback, not about the engine.
  if (isSoftwareRasteriser(left.driver.adapter) !== isSoftwareRasteriser(right.driver.adapter))
    push(
      "driver.adapter (software rasteriser on one arm only)",
      left.driver.adapter,
      right.driver.adapter,
    );
  if (left.display.refreshHz !== right.display.refreshHz)
    push("display.refreshHz", left.display.refreshHz, right.display.refreshHz);
  if (left.display.vsync !== right.display.vsync)
    push("display.vsync", left.display.vsync, right.display.vsync);
  if (left.display.width !== right.display.width || left.display.height !== right.display.height) {
    push(
      "display.viewport",
      `${left.display.width}x${left.display.height}`,
      `${right.display.width}x${right.display.height}`,
    );
  }

  // `positionHash` covers only the initial placements, so two different matrix cells can hash alike.
  // A missing record is the PRD-117 default scene, permitted only against another missing record or
  // an explicit default; a nondefault TN cell against a Godot report that never carried axes fails
  // here rather than sailing through on the hash.
  const leftAxes = left.axes ?? DEFAULT_AXES;
  const rightAxes = right.axes ?? DEFAULT_AXES;
  if (!sameWorkloadAxes(leftAxes, rightAxes))
    push("axes", renderAxes(leftAxes), renderAxes(rightAxes));

  // Grouped, never last-wins: a hash that diverges on a single repeat is exactly the failure this
  // gate exists to catch, and keying one rung per ladder step would hide every repeat but the last.
  const leftHashes = groupRungs(left);
  const rightHashes = groupRungs(right);
  for (const key of leftHashes.keys()) {
    if (!rightHashes.has(key)) push("rung present on one arm only", key, "absent", key);
  }
  for (const key of rightHashes.keys()) {
    if (!leftHashes.has(key)) push("rung present on one arm only", "absent", key, key);
  }

  const leftSummaries = summarize(left);
  const rightSummaries = summarize(right);
  for (const mode of RENDER_MODES) {
    const leftPinned = looksVsyncPinned(leftSummaries, mode);
    const rightPinned = looksVsyncPinned(rightSummaries, mode);
    if (leftPinned !== rightPinned) {
      push(
        `${mode} frame interval is display-pinned on one arm only`,
        leftPinned ? "pinned" : "load-following",
        rightPinned ? "pinned" : "load-following",
        mode,
      );
    }
  }
  for (const leftSummary of leftSummaries) {
    const key = rungKey(leftSummary.mode, leftSummary.objectCount);
    const rightSummary = rightSummaries.find(
      (summary) => rungKey(summary.mode, summary.objectCount) === key,
    );
    if (rightSummary === undefined) continue;

    const leftRungs = leftHashes.get(key) ?? [];
    const rightRungs = rightHashes.get(key) ?? [];
    const leftHashSet = new Set(leftRungs.map((entry) => entry.positionHash));
    const rightHashSet = new Set(rightRungs.map((entry) => entry.positionHash));
    // Every repeat of every rung must hash the same scene, within an arm and across the two.
    if (leftHashSet.size > 1 || rightHashSet.size > 1) {
      push(
        "positionHash (repeats disagree within an arm)",
        [...leftHashSet],
        [...rightHashSet],
        key,
      );
    } else if ([...leftHashSet][0] !== [...rightHashSet][0]) {
      push("positionHash", [...leftHashSet][0], [...rightHashSet][0], key);
    }
    const leftPlacements = new Set(leftRungs.map((entry) => entry.initialPlacementSha256));
    const rightPlacements = new Set(rightRungs.map((entry) => entry.initialPlacementSha256));
    if (leftPlacements.size > 1 || rightPlacements.size > 1) {
      push(
        "initialPlacementSha256 (repeats disagree within an arm)",
        [...leftPlacements],
        [...rightPlacements],
        key,
      );
    } else if ([...leftPlacements][0] !== [...rightPlacements][0]) {
      push("initialPlacementSha256", [...leftPlacements][0], [...rightPlacements][0], key);
    }
    if (leftSummary.sampleCount !== rightSummary.sampleCount)
      push("sampleCount", leftSummary.sampleCount, rightSummary.sampleCount, key);
    if (leftSummary.repeats !== rightSummary.repeats)
      push("repeats", leftSummary.repeats, rightSummary.repeats, key);

    const drawFailure = drawCallFailure(
      leftSummary.mode,
      leftSummary.objectCount,
      leftSummary,
      rightSummary,
    );
    if (drawFailure !== undefined) failures.push(drawFailure);

    const maxTriangles = Math.max(leftSummary.triangles, rightSummary.triangles);
    if (maxTriangles > 0) {
      const delta = Math.abs(leftSummary.triangles - rightSummary.triangles) / maxTriangles;
      if (delta > 0.05)
        push("triangles (>5% apart)", leftSummary.triangles, rightSummary.triangles, key);
    }

    // PRD-464: on a rung with characters, the two engines must have drawn the same fox. Each arm
    // already proved its own against `LADDER_FOX_HEIGHT`; this is the half neither can check alone,
    // because a fox that is 0.5 m on one side and 0.52 m on the other passes both per-arm gates
    // and is still two different scenes. Measured per rung, so a rung that lost the measurement
    // names itself rather than failing the whole comparison anonymously.
    if (isRealisticRung(leftSummary.mode) && ladderRank(leftSummary.mode) >= ladderRank("R3")) {
      const foxFailure = foxFailureFor(key, leftRungs, rightRungs);
      if (foxFailure !== undefined) failures.push(foxFailure);
    }
  }
  return failures;
}

/** The one fox-parity failure a rung can carry, or undefined when both arms agree. */
function foxFailureFor(
  key: string,
  leftRungs: readonly IRunReportRung[],
  rightRungs: readonly IRunReportRung[],
): IEquivalenceFailure | undefined {
  const measure = (rungs: readonly IRunReportRung[]): IFoxMeasurement | undefined =>
    rungs.find((rung) => rung.foxMeasurement !== undefined)?.foxMeasurement;
  const leftFox = measure(leftRungs);
  const rightFox = measure(rightRungs);
  const reason = foxParityReason(leftFox, rightFox);
  if (reason === null) return undefined;
  return {
    field: `foxMeasurement (${reason})`,
    left: leftFox === undefined ? "absent" : `${leftFox.heightM.toFixed(4)} m`,
    right: rightFox === undefined ? "absent" : `${rightFox.heightM.toFixed(4)} m`,
    rung: key,
  };
}

export function compare(left: IRunReport, right: IRunReport): IComparison {
  for (const [label, report] of [
    ["left", left],
    ["right", right],
  ] as const) {
    if (report.arm.endsWith("-android")) {
      const nestedProvisional = report.deviceCondition?.provisional;
      if (
        !Array.isArray(report.provisional) ||
        report.provisional.some((entry) => typeof entry !== "string" || entry.length === 0) ||
        !Array.isArray(nestedProvisional) ||
        nestedProvisional.some((entry) => typeof entry !== "string" || entry.length === 0)
      ) {
        throw new BenchError(
          "TN_BENCH_BAD_SHAPE",
          `${label} Android report must carry both provisional arrays`,
        );
      }
      if (!sameStringArray(report.provisional, nestedProvisional)) {
        throw new BenchError(
          "TN_BENCH_BAD_SHAPE",
          `${label} Android report provisional arrays disagree`,
        );
      }
    }
    if (report.provisional !== undefined && report.provisional.length > 0) {
      throw new BenchError(
        "TN_BENCH_PROVISIONAL_COMPARISON",
        `${label} report is provisional: ${report.provisional.join(", ")}`,
      );
    }
  }
  const failures = checkEquivalence(left, right);
  if (failures.length > 0) {
    const detail = failures
      .map(
        (failure) =>
          `${failure.rung} ${failure.field}: ${left.arm}=${failure.left} ${right.arm}=${failure.right}`,
      )
      .join("; ");
    throw new BenchError("TN_BENCH_NOT_EQUIVALENT", detail);
  }
  const leftSummaries = summarize(left);
  const rightSummaries = summarize(right);
  // One entry per mode the scene defines, so a mode added to the ladder cannot be quietly absent
  // from the knee table the markdown renders.
  const knees = (summaries: readonly IRungSummary[]): Record<RenderMode, number | null> =>
    Object.fromEntries(RENDER_MODES.map((mode) => [mode, knee(summaries, mode)])) as Record<
      RenderMode,
      number | null
    >;
  return {
    left,
    leftKnee: knees(leftSummaries),
    leftSummaries,
    right,
    rightKnee: knees(rightSummaries),
    rightSummaries,
  };
}

export function renderArmMarkdown(report: IRunReport): string {
  const summaries = summarize(report);
  const lines = [
    `### Arm \`${report.arm}\``,
    "",
    `- engine: ${report.engine.name} ${report.engine.version}`,
    `- build: ${report.build.type}${report.build.notes.length > 0 ? ` — ${report.build.notes}` : ""}`,
    `- driver: ${report.driver.renderer}`,
    `- adapter: ${report.driver.adapter}`,
    `- device: ${report.device.label}, ${report.display.width}×${report.display.height} @ ${report.display.refreshHz} Hz, vsync ${report.display.vsync ? "on" : "off"}`,
    "",
    "| mode | N | p50 ms | p95 ms | p99 ms | hitches | draws | compiles | tris | visible | repeats × samples |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  if (report.hostLoad !== undefined) {
    lines.splice(
      6,
      0,
      `- host load: ${report.hostLoad.load1.toFixed(2)} on ${report.hostLoad.cores} cores, absolutes ${report.hostLoad.absolutes}`,
    );
  }
  if (report.deviceCondition !== undefined) {
    lines.splice(
      6,
      0,
      `- device condition: battery ${report.deviceCondition.batteryPercent}%, ${report.deviceCondition.charging ? "charging" : "discharging"}, thermal ${report.deviceCondition.thermalStatus}, screen ${report.deviceCondition.screenOn ? "on" : "off"}`,
    );
  }
  if (report.axes !== undefined) {
    // The matrix cell this row belongs to; Godot reports carry no axes and print no line.
    lines.splice(6, 0, `- axes: ${renderAxes(report.axes)}`);
  }
  if (report.provisional !== undefined && report.provisional.length > 0) {
    lines.splice(7, 0, `- provisional: ${report.provisional.join(", ")}`);
  }
  for (const summary of summaries) {
    lines.push(
      `| ${summary.mode} | ${summary.objectCount} | ${summary.p50.toFixed(2)} | ${summary.p95.toFixed(2)} | ${summary.p99.toFixed(2)} | ${summary.hitches} | ${summary.drawCalls} | ${summary.pipelineCompiles ?? "n/a"} | ${summary.triangles} | ${summary.visibleObjects} | ${summary.repeats} × ${summary.sampleCount} |`,
    );
  }
  lines.push(
    "",
    `**Knee at ≤ ${KNEE_THRESHOLD_MS} ms p95** — L1: ${formatKnee(knee(summaries, "L1"))}, L2: ${formatKnee(knee(summaries, "L2"))}, L3: ${formatKnee(knee(summaries, "L3"))}`,
  );
  return lines.join("\n");
}

export function formatKnee(value: number | null): string {
  return value === null ? "below the first rung" : String(value);
}

export function renderAxes(axes: IWorkloadAxes): string {
  return [
    `geometry ${axes.geometry}`,
    `material ${axes.material}`,
    `hierarchy ${axes.hierarchyDepth}`,
    `visible ${axes.visibleFraction}`,
    `mutation ${axes.mutationRate}`,
    `shadow-casters ${axes.shadowCasterShare}`,
    `passes ${axes.passCount}`,
  ].join(", ");
}

export function renderComparisonMarkdown(comparison: IComparison): string {
  const lines = [
    `## ${comparison.left.arm} vs ${comparison.right.arm}`,
    "",
    "Product-to-product. Each arm is what that engine actually ships to this surface; the two run",
    "different rendering backends by construction and no line below is a graphics-API claim.",
    "",
    `| mode | knee — ${comparison.left.arm} | knee — ${comparison.right.arm} |`,
    "|---|---|---|",
  ];
  for (const mode of RENDER_MODES) {
    lines.push(
      `| ${mode} | ${formatKnee(comparison.leftKnee[mode])} | ${formatKnee(comparison.rightKnee[mode])} |`,
    );
  }
  lines.push(
    "",
    `| mode | N | ${comparison.left.arm} p95 ms | ${comparison.right.arm} p95 ms | ratio |`,
    "|---|---|---|---|---|",
  );
  for (const leftSummary of comparison.leftSummaries) {
    const rightSummary = comparison.rightSummaries.find(
      (summary) =>
        summary.mode === leftSummary.mode && summary.objectCount === leftSummary.objectCount,
    );
    if (rightSummary === undefined) continue;
    const ratio = leftSummary.p95 / rightSummary.p95;
    lines.push(
      `| ${leftSummary.mode} | ${leftSummary.objectCount} | ${leftSummary.p95.toFixed(2)} | ${rightSummary.p95.toFixed(2)} | ${ratio.toFixed(2)}× |`,
    );
  }
  lines.push("", renderArmMarkdown(comparison.left), "", renderArmMarkdown(comparison.right));
  return lines.join("\n");
}
