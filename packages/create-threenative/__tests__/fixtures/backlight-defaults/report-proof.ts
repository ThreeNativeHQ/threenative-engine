// Bounded proof over actual retained console records, matching the exposure verifier pattern.
export function assertEnvironmentMarker(
  records: readonly { text: string }[],
  expected: {
    environmentState: "dark" | "missing";
    rimGain: number;
    fillEnabled: boolean;
    blackFill: boolean;
  },
) {
  if (!Array.isArray(records) || records.length > 4096)
    throw new Error("TN_ENVIRONMENT_RECORDS_INVALID");
  const prefix = "TN_ENVIRONMENT_CONTRIBUTION:";
  const markers = records.filter(
    (entry) => typeof entry?.text === "string" && entry.text.startsWith(prefix),
  );
  if (markers.length !== 1) throw new Error("TN_ENVIRONMENT_MARKER_MISSING_OR_DUPLICATE");
  const text = markers[0]?.text;
  if (text.length > 65536) throw new Error("TN_ENVIRONMENT_MARKER_OVERSIZE");
  const value = JSON.parse(text.slice(prefix.length));
  if (
    value?.status !== "measured" ||
    value.meanRadiance !== 0 ||
    !Array.isArray(value.meanRGB) ||
    value.meanRGB.length !== 3 ||
    !value.meanRGB.every((sample: unknown) => sample === 0) ||
    value.environmentState !== expected.environmentState ||
    value.ibl !== "non-contributing" ||
    value.rimGain !== expected.rimGain ||
    value.analyticFill?.admitted !== expected.fillEnabled ||
    value.analyticFill?.blackColorOverride !== expected.blackFill ||
    !Number.isFinite(value.analyticFill?.effectiveGain) ||
    value.analyticFill.effectiveGain !== (expected.fillEnabled ? 1 : 0) ||
    !Array.isArray(value.analyticFill?.color) ||
    value.analyticFill.color.length !== 3 ||
    !value.analyticFill.color.every(
      (sample: unknown) => typeof sample === "number" && Number.isFinite(sample) && sample >= 0,
    )
  )
    throw new Error("TN_ENVIRONMENT_MARKER_INVALID");
  const black = value.analyticFill.color.every((sample: number) => sample === 0);
  if (
    black !== expected.blackFill ||
    typeof value.analyticFill.reason !== "string" ||
    value.analyticFill.reason.length === 0
  )
    throw new Error("TN_ENVIRONMENT_FILL_INVALID");
  return value;
}
