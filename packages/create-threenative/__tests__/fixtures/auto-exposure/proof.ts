import { assertExposureCameraCut } from "./cameraProof.js";

interface IExposureProofReport {
  pass: boolean;
  capture?: { rendererKind: string; adapter: Record<string, string> };
  diagnostics: readonly { code: string }[];
  observations?: { console: readonly { text: string }[]; startup?: { phase: string } };
}

interface IExposureMeasurement {
  measured: true;
  applied: boolean;
  luminance: number;
  exposureStops: number;
  targetStops: number;
  settled: boolean;
}

export interface IExposureCaseProof {
  applied: boolean;
  expectedLuminance?: number;
  cameraCut?: boolean;
  cutStops?: number;
  reject?: string;
  deterministic?: boolean;
}

/** A negative control may fail its one named gate; runtime errors never qualify the mutation. */
export function qualifyExposureCase(report: IExposureProofReport, expectation: IExposureCaseProof) {
  assertExposureRuntime(report);
  if (expectation.cameraCut === true) assertExposureCameraCut(report, expectation.cutStops ?? 0);
  if (expectation.deterministic === true) assertExposureWarmup(report);
  const frameBudget =
    expectation.deterministic === true ? assertDeterministicExposureBudget(report) : undefined;
  // Terminal integrity is mandatory for both deterministic arms. An expected settlement
  // failure can never stand in for a missing, stale, unapplied or incorrect GPU measurement.
  const terminal =
    expectation.deterministic === true
      ? assertExposureProof(report, expectation.applied, expectation.expectedLuminance, false)
      : undefined;
  if (terminal !== undefined) assertTerminalCutTarget(report, expectation, terminal);
  const failures: Error[] = [];
  const check = <T>(gate: () => T): T | undefined => {
    try {
      return gate();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failures.push(error);
      return undefined;
    }
  };
  check(() =>
    assertExposureClock(report, expectation.deterministic === true ? "fixed-step" : "wall-clock"),
  );
  const measurement =
    terminal ??
    check(() => assertExposureProof(report, expectation.applied, expectation.expectedLuminance));
  const cutTiming =
    expectation.cutStops === undefined
      ? undefined
      : check(() => {
          if (terminal !== undefined && terminal.settled !== true)
            throw new Error(
              `TN_EXPOSURE_NOT_SETTLED: Terminal GPU measurement remains unsettled after 180 rendered updates; observed time ${JSON.stringify(frameBudget)}.`,
            );
          return exposureCutTiming(report, expectation.cutStops as number, 180);
        });
  if (failures.length > 0) {
    const [error] = failures;
    if (
      failures.length === 1 &&
      expectation.reject !== undefined &&
      error?.message.startsWith(`${expectation.reject}:`)
    )
      return {
        expectedFailure: error.message,
        ...(frameBudget === undefined ? {} : { frameBudget }),
      };
    throw new Error(failures.map((error) => error.message).join("\n"));
  }
  if (expectation.reject !== undefined)
    throw new Error(`Exposure mutation unexpectedly passed ${expectation.reject}.`);
  return { measurement, cutTiming, ...(frameBudget === undefined ? {} : { frameBudget }) };
}

function assertTerminalCutTarget(
  report: IExposureProofReport,
  expectation: IExposureCaseProof,
  terminal: IExposureMeasurement,
): void {
  const { cut } = cutEntries(report);
  if (
    expectation.cutStops === undefined ||
    Math.abs(Math.abs(terminal.targetStops - cut.targetStops) - expectation.cutStops) > 0.25
  )
    throw new Error("Exposure terminal measurement does not match the new cut target.");
}

interface IExposureSample {
  updates: number;
  consumedSeconds: number;
  realConsumedSeconds: number;
  nodeTime: number;
  nodeFrameId: number;
  clock: string;
  measurement: IExposureMeasurement;
}

function settledAtNewTarget(
  value: { settled: boolean; targetStops: number },
  start: number,
  stops: number,
): boolean {
  return (
    value.settled === true &&
    Number.isFinite(value.targetStops) &&
    Math.abs(Math.abs(value.targetStops - start) - stops) <= 0.25
  );
}

function validElapsed(value: { renderedUpdates: number; consumedSeconds: number }): boolean {
  return (
    Number.isInteger(value.renderedUpdates) &&
    value.renderedUpdates > 0 &&
    Number.isFinite(value.consumedSeconds) &&
    value.consumedSeconds > 0
  );
}

function cutEntries(report: IExposureProofReport) {
  const entries = report.observations?.console ?? [];
  const cuts = entries.filter(({ text }) => text.startsWith("TN_EXPOSURE_CUT:"));
  if (cuts.length !== 1) throw new Error("Exposure proof needs exactly one observed cut.");
  const cutEntry = cuts[0];
  if (cutEntry === undefined) throw new Error("Exposure cut missing.");
  const cut = JSON.parse(cutEntry.text.slice("TN_EXPOSURE_CUT:".length));
  if (
    cut.settled !== true ||
    ![cut.updates, cut.consumedSeconds, cut.targetStops].every(Number.isFinite)
  )
    throw new Error("Exposure cut needs one observed, settled starting pose.");
  return { cut, after: entries.slice(entries.indexOf(cutEntry) + 1) };
}

export function pairedExposureSamples(entries: readonly { text: string }[]): IExposureSample[] {
  const samples: IExposureSample[] = [];
  let accepted: IExposureMeasurement | undefined;
  for (const { text } of entries) {
    if (text.startsWith("TN_AUTO_EXPOSURE:")) {
      if (accepted !== undefined)
        throw new Error("TN_EXPOSURE_FRAME_BUDGET: Unpaired accepted exposure measurement.");
      accepted = JSON.parse(text.slice("TN_AUTO_EXPOSURE:".length));
    }
    if (!text.startsWith("TN_EXPOSURE_SAMPLE:")) continue;
    const sample = JSON.parse(text.slice("TN_EXPOSURE_SAMPLE:".length));
    if (
      accepted === undefined ||
      sample.measurement === undefined ||
      Object.keys(accepted).some(
        (key) => accepted?.[key as keyof IExposureMeasurement] !== sample.measurement[key],
      ) ||
      Object.keys(accepted).length !== Object.keys(sample.measurement).length
    )
      throw new Error(
        "TN_EXPOSURE_FRAME_BUDGET: Sample lacks its paired accepted exposure measurement.",
      );
    samples.push(sample);
    accepted = undefined;
  }
  if (accepted !== undefined)
    throw new Error("TN_EXPOSURE_FRAME_BUDGET: Unpaired terminal exposure measurement.");
  return samples;
}

type ExposureTiming = Omit<IExposureSample, "measurement">;
const exposureTimingFields = [
  "updates",
  "consumedSeconds",
  "realConsumedSeconds",
  "nodeTime",
  "nodeFrameId",
  "clock",
] as const;

function assertExposureSampleSequence(
  samples: IExposureSample[],
  start: ExposureTiming,
  phase: "warmup" | "post-cut",
): ExposureTiming {
  if (samples.length !== 180)
    throw new Error(
      `TN_EXPOSURE_FRAME_BUDGET: Expected 180 completed GPU samples during ${phase}; observed ${samples.length}.`,
    );
  let previous = start;
  for (const [index, value] of samples.entries()) {
    if (
      value.clock !== start.clock ||
      value.updates !== start.updates + index + 1 ||
      !Number.isInteger(value.nodeFrameId) ||
      value.nodeFrameId <= previous.nodeFrameId ||
      !Number.isFinite(value.nodeTime) ||
      value.nodeTime <= previous.nodeTime ||
      !Number.isFinite(value.realConsumedSeconds) ||
      value.realConsumedSeconds < previous.realConsumedSeconds ||
      !Number.isFinite(value.consumedSeconds) ||
      Math.abs(value.consumedSeconds - start.consumedSeconds - (index + 1) / 60) > 1e-9
    )
      throw new Error(
        `TN_EXPOSURE_FRAME_BUDGET: Mismatched GPU updates, readback or clock provenance during ${phase}.`,
      );
    previous = value;
  }
  return previous;
}

/** The controlled comparison starts only after the same accepted GPU warmup in both arms. */
function assertExposureWarmup(report: IExposureProofReport): void {
  const entries = report.observations?.console ?? [];
  const indexOf = (prefix: string) => {
    const matches = entries.flatMap(({ text }, index) => (text.startsWith(prefix) ? [index] : []));
    if (matches.length !== 1)
      throw new Error("Exposure warmup/readiness evidence is missing or duplicated.");
    return matches[0] as number;
  };
  const warmupIndex = indexOf("TN_EXPOSURE_WARMUP:");
  const readyIndex = indexOf("TN_EXPOSURE_READY:");
  const cutIndex = indexOf("TN_EXPOSURE_CUT:");
  if (
    warmupIndex >= readyIndex ||
    readyIndex >= cutIndex ||
    report.observations?.startup?.phase !== "ready"
  )
    throw new Error("Exposure readiness arrived without the exact warmup evidence.");
  const warmup = JSON.parse(entries[warmupIndex]?.text.slice("TN_EXPOSURE_WARMUP:".length) ?? "{}");
  const ready = JSON.parse(entries[readyIndex]?.text.slice("TN_EXPOSURE_READY:".length) ?? "{}");
  const samples = pairedExposureSamples(entries.slice(0, warmupIndex));
  const last = samples.at(-1);
  const terminal = assertExposureSampleSequence(
    samples,
    {
      updates: 0,
      consumedSeconds: 0,
      realConsumedSeconds: 0,
      nodeTime: 0,
      nodeFrameId: 0,
      clock: "deterministic-per-render",
    },
    "warmup",
  );
  if (
    last === undefined ||
    exposureTimingFields.some((key) => warmup[key] !== terminal[key]) ||
    JSON.stringify(warmup.measurement) !== JSON.stringify(last.measurement) ||
    ready.warmupComplete !== true ||
    !Number.isFinite(warmup.elapsedMs) ||
    warmup.elapsedMs < 0 ||
    warmup.elapsedMs > 60_000 ||
    !Number.isFinite(ready.elapsedMs) ||
    ready.elapsedMs < warmup.elapsedMs
  )
    throw new Error("Exposure warmup is incomplete, unpaired or expired.");
  const measurement = assertExposureProof(
    { ...report, observations: { console: entries.slice(0, warmupIndex) } },
    true,
  );
  const { cut } = cutEntries(report);
  if (
    exposureTimingFields.some((key) => cut[key] !== terminal[key]) ||
    Object.keys(measurement).some(
      (key) => measurement[key as keyof IExposureMeasurement] !== cut[key],
    )
  )
    throw new Error("Exposure cut changed the accepted warmup timing or measurement.");
}

/** Pin the terminal readback, not just submissions, to the same 180-update controlled clock. */
export function assertDeterministicExposureBudget(report: IExposureProofReport) {
  const { cut, after } = cutEntries(report);
  if (cut.clock !== "deterministic-per-render")
    throw new Error("TN_EXPOSURE_FRAME_BUDGET: Incorrect cut clock provenance.");
  if (
    cut.updates !== 180 ||
    Math.abs(cut.consumedSeconds - 3) > 1e-9 ||
    ![cut.realConsumedSeconds, cut.nodeTime, cut.nodeFrameId].every(Number.isFinite)
  )
    throw new Error(
      "TN_EXPOSURE_FRAME_BUDGET: Expected the 180-update warmup before terminal update 360.",
    );
  const samples = pairedExposureSamples(after);
  const previous = assertExposureSampleSequence(samples, cut, "post-cut");
  return {
    renderedUpdates: 180,
    adaptationSeconds: previous.consumedSeconds - cut.consumedSeconds,
    realConsumedSeconds: previous.realConsumedSeconds - cut.realConsumedSeconds,
    realElapsedSeconds: previous.nodeTime - cut.nodeTime,
    clock: cut.clock,
  };
}

/** Readback arrival is a conservative upper bound on the frame that produced the settled value. */
export function exposureCutTiming(
  report: IExposureProofReport,
  stops: number,
  frameBudget: number,
) {
  const { cut, after } = cutEntries(report);
  let elapsed = { renderedUpdates: 0, consumedSeconds: 0 };
  for (const { text } of after) {
    if (text.startsWith("TN_EXPOSURE_TIMING:")) {
      const value = JSON.parse(text.slice("TN_EXPOSURE_TIMING:".length));
      elapsed = {
        renderedUpdates: value.updates - cut.updates,
        consumedSeconds: value.consumedSeconds - cut.consumedSeconds,
      };
      if (!validElapsed(elapsed)) throw new Error("Exposure cut timing is invalid.");
      continue;
    }
    if (!text.startsWith("TN_AUTO_EXPOSURE:") || elapsed.renderedUpdates === 0) continue;
    const value = JSON.parse(text.slice("TN_AUTO_EXPOSURE:".length));
    if (!settledAtNewTarget(value, cut.targetStops, stops)) continue;
    if (elapsed.renderedUpdates > frameBudget)
      throw new Error(
        `TN_EXPOSURE_NOT_SETTLED: Exposure settled after ${elapsed.renderedUpdates} rendered updates; budget ${frameBudget}.`,
      );
    return elapsed;
  }
  throw new Error(
    `TN_EXPOSURE_NOT_SETTLED: Exposure did not settle within ${frameBudget} rendered updates; observed ${elapsed.renderedUpdates} updates and ${elapsed.consumedSeconds} seconds.`,
  );
}

/** A downgraded lost software device can pass harness plumbing, but never pixel qualification. */
export function assertExposureRuntime(report: IExposureProofReport): void {
  if (report.diagnostics.some(({ code }) => code === "TN_PLAYTEST_SOFTWARE_DEVICE_LOST"))
    throw new Error(
      "Exposure proof rejected software device loss; these pixels are not render evidence.",
    );
  if (!report.pass)
    throw new Error(`Exposure scenario failed: ${JSON.stringify(report.diagnostics)}`);
  if (
    report.capture?.rendererKind !== "webgpu" ||
    !Object.values(report.capture.adapter).some((value) => value.length > 0)
  )
    throw new Error("Exposure proof requires observed WebGPU adapter provenance.");
}

export function assertExposureClock(
  report: IExposureProofReport,
  expected: "wall-clock" | "fixed-step" = "wall-clock",
): void {
  const marker = report.observations?.console
    .filter(({ text }) => text.startsWith("TN_EXPOSURE_CLOCK:"))
    .at(-1);
  if (marker === undefined)
    throw new Error("TN_EXPOSURE_CLOCK_MISSING: Bridge clock was not observed.");
  const { mode } = JSON.parse(marker.text.slice("TN_EXPOSURE_CLOCK:".length));
  if (mode !== expected)
    throw new Error(`TN_EXPOSURE_WRONG_CLOCK: Expected ${expected}; observed ${String(mode)}.`);
}

export function assertExposureProof(
  report: IExposureProofReport,
  applied: boolean,
  expectedLuminance?: number,
  requireSettled = true,
): IExposureMeasurement {
  assertExposureRuntime(report);
  const last = report.observations?.console
    .filter(({ text }) => text.startsWith("TN_AUTO_EXPOSURE:"))
    .at(-1);
  if (last === undefined)
    throw new Error("TN_EXPOSURE_MEASUREMENT_MISSING: GPU exposure observation missing.");
  const measurement = JSON.parse(last.text.slice("TN_AUTO_EXPOSURE:".length));
  if (
    measurement.measured !== true ||
    measurement.applied !== applied ||
    ![measurement.luminance, measurement.exposureStops, measurement.targetStops].every(
      (value) => typeof value === "number" && Number.isFinite(value),
    ) ||
    measurement.luminance <= 0 ||
    (applied &&
      (typeof measurement.settled !== "boolean" ||
        measurement.settled !==
          Math.abs(measurement.targetStops - measurement.exposureStops) <= 0.25 ||
        (requireSettled && measurement.settled !== true))) ||
    (!applied && measurement.exposureStops !== 0)
  )
    throw new Error(`Exposure measurement failed: ${JSON.stringify(measurement)}`);
  if (
    expectedLuminance !== undefined &&
    Math.abs(measurement.luminance / expectedLuminance - 1) > 0.02
  )
    throw new Error(
      `TN_EXPOSURE_METER_RANGE: Luminance ${measurement.luminance} differs from this fixture's ${expectedLuminance} reference by more than 2%.`,
    );
  return measurement;
}

/** Consumer qualification requires the generated environment's actual owned node. */
export function assertExposureConsumer(report: Pick<IExposureProofReport, "observations">): void {
  const markers = (report.observations?.console ?? []).filter(({ text }) =>
    text.startsWith("TN_EXPOSURE_CONSUMER:"),
  );
  const installed = markers[0];
  if (markers.length !== 1 || installed === undefined)
    throw new Error("Exposure consumer requires one actual installation.");
  const state = JSON.parse(installed.text.slice("TN_EXPOSURE_CONSUMER:".length));
  if (state.installed !== true || state.owned !== true)
    throw new Error("Exposure consumer did not own the generated environment's actual graph.");
}
