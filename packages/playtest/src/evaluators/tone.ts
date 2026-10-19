import { TONE_METRICS } from "../tone.js";
import type { IToneMetrics, IToneRegion, IPlaytestRegionalToneObservation } from "../tone.js";
import type { IEvaluationContext } from "./context.js";

export function emitTone({
  assertions,
  diagnostics,
  input,
  scenarioAssertions,
}: IEvaluationContext): void {
  for (const [index, expected] of (scenarioAssertions.tone ?? []).entries()) {
    const label = expected.atStep ?? "after.png";
    const frames = input.report.observations?.tone;
    // A step may use the reserved-looking name "after". The terminal capture is appended last.
    const frame = Array.isArray(frames)
      ? frames
          .slice()
          .reverse()
          .find((entry) => {
            if (entry === null || typeof entry !== "object") return false;
            const regional = entry as Partial<IPlaytestRegionalToneObservation>;
            const identity =
              expected.region === undefined
                ? regional.assertionIndex === undefined && regional.region === undefined
                : regional.assertionIndex === index && sameRegion(regional.region, expected.region);
            return (
              identity &&
              (expected.atStep === undefined
                ? entry.atStep === undefined && entry.label === "after.png"
                : entry.atStep === expected.atStep)
            );
          })
      : undefined;
    const regional = frame as IPlaytestRegionalToneObservation | undefined;
    if (
      frame?.code !== "TN_TONE" ||
      regional?.error !== undefined ||
      !validMetrics(frame) ||
      (expected.compare !== undefined &&
        (regional?.reference?.error !== undefined ||
          !sameRegion(regional?.reference?.region, expected.compare.region) ||
          !validMetrics(regional?.reference?.metrics)))
    ) {
      assertions.push({
        id: `tone.${index}.observed`,
        pass: false,
        details: { expected, observed: frame },
      });
      diagnostics.push({
        code: "TN_PLAYTEST_TONE_UNOBSERVED",
        message: `Tone capture '${label}' is missing or has invalid luminance metrics.`,
        severity: "error",
        observedRuntimePath: "observations.json/tone",
      });
      continue;
    }
    if (expected.compare !== undefined) {
      const { metric, minDelta } = expected.compare;
      const observed = (frame as IToneMetrics)[metric] - regional!.reference!.metrics![metric];
      const pass = observed >= minDelta;
      assertions.push({
        id: `tone.${index}.compare`,
        pass,
        details: { observed, expected: expected.compare, frame },
      });
      if (!pass)
        diagnostics.push({
          code: "TN_PLAYTEST_TONE_ASSERTION_FAILED",
          message: `Tone '${label}' ${metric} primary minus reference measured ${observed}; required >= ${minDelta}.`,
          severity: "error",
          observedRuntimePath: "observations.json/tone",
        });
    }
    for (const key of TONE_METRICS) {
      const bound = expected[key];
      if (bound === undefined) continue;
      const observed = (frame as IToneMetrics)[key];
      const pass =
        (bound.min === undefined || observed >= bound.min) &&
        (bound.max === undefined || observed <= bound.max);
      assertions.push({
        id: `tone.${index}.${key}`,
        pass,
        details: { observed, expected: bound, frame },
      });
      if (!pass)
        diagnostics.push({
          code: "TN_PLAYTEST_TONE_ASSERTION_FAILED",
          message: `Tone '${label}' ${key} measured ${observed}; required ${JSON.stringify(bound)}.`,
          severity: "error",
          observedRuntimePath: "observations.json/tone",
        });
    }
  }
}

function sameRegion(value: unknown, expected: IToneRegion): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const observed = value as Record<string, unknown>;
  return (
    observed.x === expected.x &&
    observed.y === expected.y &&
    observed.width === expected.width &&
    observed.height === expected.height
  );
}
function validMetrics(value: unknown): value is IToneMetrics {
  if (typeof value !== "object" || value === null) return false;
  const metrics = value as IToneMetrics;
  return TONE_METRICS.every(
    (key) =>
      typeof metrics[key] === "number" &&
      Number.isFinite(metrics[key]) &&
      metrics[key] >= 0 &&
      metrics[key] <= (key.endsWith("Fraction") ? 1 : 255),
  );
}
