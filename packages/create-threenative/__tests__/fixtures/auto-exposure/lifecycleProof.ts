import { assertExposureClock, assertExposureRuntime, pairedExposureSamples } from "./proof.js";

export function qualifyExposureLifecycle(report: Parameters<typeof assertExposureRuntime>[0]) {
  assertExposureRuntime(report);
  assertExposureClock(report, "fixed-step");
  const entries = report.observations?.console ?? [];
  const samples = pairedExposureSamples(entries);
  if (samples.length !== 720) throw new Error("Lifecycle requires exactly 720 paired GPU samples.");
  let pendingTiming: Record<string, unknown> | undefined;
  let setupCount = 0;
  for (const { text } of entries) {
    if (text.startsWith("TN_EXPOSURE_SETUP:")) {
      const setup = JSON.parse(text.slice("TN_EXPOSURE_SETUP:".length));
      if (!Number.isInteger(setup.setupCount) || setup.setupCount !== setupCount + 1)
        throw new Error("Invalid setup provenance.");
      setupCount = setup.setupCount;
    }
    if (text.startsWith("TN_EXPOSURE_TIMING:")) {
      if (pendingTiming !== undefined) throw new Error("Unpaired lifecycle timing.");
      pendingTiming = JSON.parse(text.slice("TN_EXPOSURE_TIMING:".length));
    }
    if (text.startsWith("TN_EXPOSURE_SAMPLE:")) {
      const sample = JSON.parse(text.slice("TN_EXPOSURE_SAMPLE:".length));
      if (
        pendingTiming === undefined ||
        Object.keys(pendingTiming).some((key) => pendingTiming?.[key] !== sample[key]) ||
        sample.setupCount !== setupCount
      )
        throw new Error("Lifecycle timing/setup lacks producer order provenance.");
      pendingTiming = undefined;
    }
  }
  if (pendingTiming !== undefined) throw new Error("Unpaired terminal lifecycle timing.");
  let previousFrame = 0;
  let previousTime = 0;
  let previousReal = 0;
  for (const [index, sample] of samples.entries()) {
    const measurement = sample.measurement;
    const delta = Reflect.get(sample, "deltaSeconds");
    const realDelta = sample.realConsumedSeconds - previousReal;
    const elapsed = sample.nodeTime - previousTime;
    if (
      !Number.isFinite(delta) ||
      Math.abs(delta - 1 / 60) > 1e-12 ||
      !Number.isFinite(realDelta) ||
      realDelta < 0 ||
      realDelta > elapsed + 1e-9 ||
      (sample.nodeFrameId === previousFrame + 1 && Math.abs(realDelta - elapsed) > 1e-9) ||
      sample.updates !== index + 1 ||
      sample.clock !== "deterministic-per-render" ||
      !Number.isInteger(sample.nodeFrameId) ||
      sample.nodeFrameId <= previousFrame ||
      !Number.isFinite(sample.nodeTime) ||
      sample.nodeTime <= previousTime ||
      !Number.isFinite(sample.realConsumedSeconds) ||
      sample.realConsumedSeconds < previousReal ||
      !Number.isFinite(sample.consumedSeconds) ||
      Math.abs(sample.consumedSeconds - (index + 1) / 60) > 1e-9 ||
      measurement.measured !== true ||
      measurement.applied !== true ||
      typeof measurement.settled !== "boolean" ||
      ![measurement.luminance, measurement.exposureStops, measurement.targetStops].every(
        Number.isFinite,
      ) ||
      measurement.luminance <= 0
    )
      throw new Error("Invalid lifecycle GPU sample, measurement, order or clock.");
    previousFrame = sample.nodeFrameId;
    previousTime = sample.nodeTime;
    previousReal = sample.realConsumedSeconds;
  }
  for (const [marker, update] of [
    ["REBUILD", 180],
    ["RESIZE", 360],
    ["RESET_CUT", 540],
  ] as const) {
    const matches = entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.text.startsWith(`TN_EXPOSURE_${marker}:`));
    const match = matches[0];
    if (matches.length !== 1 || match === undefined)
      throw new Error(`Lifecycle missing unique ${marker} operation.`);
    const observed = JSON.parse(match.entry.text.slice(`TN_EXPOSURE_${marker}:`.length));
    const before = entries.findIndex(
      ({ text }) =>
        text.startsWith("TN_EXPOSURE_SAMPLE:") &&
        JSON.parse(text.slice("TN_EXPOSURE_SAMPLE:".length)).updates === update,
    );
    const after = entries.findIndex(
      ({ text }) =>
        text.startsWith("TN_EXPOSURE_SAMPLE:") &&
        JSON.parse(text.slice("TN_EXPOSURE_SAMPLE:".length)).updates === update + 1,
    );
    if (observed.updates !== update || match.index <= before || match.index >= after)
      throw new Error(`Lifecycle ${marker} operation lacks ordered sample boundaries.`);
  }
  const extra = (index: number) =>
    samples[index - 1] as (typeof samples)[number] & {
      width: number;
      height: number;
      setupCount: number;
    };
  const before = extra(180);
  const rebuilt = extra(181);
  const resized = extra(361);
  const resetBefore = extra(540);
  const reset = extra(541);
  if (
    ![before.setupCount, rebuilt.setupCount].every(Number.isInteger) ||
    rebuilt.setupCount <= before.setupCount ||
    Math.abs(before.measurement.exposureStops) < 1 ||
    Math.abs(rebuilt.measurement.exposureStops - before.measurement.exposureStops) > 0.01
  )
    throw new Error("Actual rebuilt output graph discarded history or was not recompiled.");
  if (
    extra(360).width !== 640 ||
    extra(360).height !== 360 ||
    resized.width !== 320 ||
    resized.height !== 180 ||
    Math.abs(resized.measurement.exposureStops - extra(360).measurement.exposureStops) > 0.01
  )
    throw new Error("Actual drawing buffer resize discarded exposure history or did not occur.");
  if (
    Math.abs(Math.abs(reset.measurement.targetStops - resetBefore.measurement.targetStops) - 11) >
      0.25 ||
    Math.abs(reset.measurement.exposureStops - reset.measurement.targetStops) > 1e-5 ||
    reset.measurement.settled !== true
  )
    throw new Error("Reset failed to adopt the new measured GPU target on its first sample.");
  return {
    before: before.measurement,
    rebuilt: rebuilt.measurement,
    resized: resized.measurement,
    reset: reset.measurement,
    updates: samples.length,
  };
}
