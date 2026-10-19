import { pairedExposureSamples, qualifyExposureCase } from "./proof.js";

/** Authored snapHi=8 guarantees a full snap for the unchanged eleven-stop camera cut. */
export function qualifyExposureSnap(
  report: Parameters<typeof qualifyExposureCase>[0],
  snapGain: 0 | 1,
) {
  const complete = qualifyExposureCase(report, {
    applied: true,
    cameraCut: true,
    cutStops: 11,
    deterministic: true,
  });
  const samples = pairedExposureSamples(report.observations?.console ?? []);
  const first = samples[180];
  const before = samples[179];
  if (
    first === undefined ||
    before === undefined ||
    first.updates !== 181 ||
    Reflect.get(first, "deltaSeconds") !== 1 / 60 ||
    before.updates !== 180 ||
    Math.abs(Math.abs(first.measurement.targetStops - before.measurement.targetStops) - 11) > 0.25
  )
    throw new Error("Snap proof lacks the first paired sample at the unchanged new camera target.");
  const terminal = samples.at(-1)?.measurement;
  for (const measurement of [before.measurement, first.measurement, terminal]) {
    if (
      measurement === undefined ||
      measurement.measured !== true ||
      measurement.applied !== true ||
      typeof measurement.settled !== "boolean" ||
      ![measurement.luminance, measurement.exposureStops, measurement.targetStops].every(
        Number.isFinite,
      ) ||
      measurement.luminance <= 0
    )
      throw new Error("Snap proof requires real finite applied GPU measurements.");
  }
  if (
    terminal === undefined ||
    Math.abs(first.measurement.targetStops - terminal.targetStops) > 0.25
  )
    throw new Error("First snap sample is not at the observed post-cut GPU target.");
  const errorStops = Math.abs(first.measurement.exposureStops - first.measurement.targetStops);
  if (!Number.isFinite(errorStops)) throw new Error("Snap proof error is unavailable.");
  const failure =
    errorStops > 0.25
      ? `TN_EXPOSURE_SNAP_RESPONSE_MISSING: First post-cut GPU update remains ${errorStops} stops from the target (limit 0.25).`
      : undefined;
  if ((snapGain === 1 && failure !== undefined) || (snapGain === 0 && failure === undefined))
    throw new Error(failure ?? "Zero-gain mutation unexpectedly met first-update snap response.");
  return {
    ...complete,
    before: before.measurement,
    first: first.measurement,
    errorStops,
    ...(failure === undefined ? {} : { expectedFailure: failure }),
  };
}
