import type { IEvaluationContext } from "./context.js";
import { fpsFromFrameTimes } from "./render-evidence.js";

/**
 * Judges a PRD-222 Tier 2 parity pair: the same scene on the same device, once in the browser,
 * once native. The assertion lives in the second run and carries the first run's reference,
 * hydrated at scenario load.
 *
 * It proves what the artifacts can prove — same device, thermally comparable, ratio at or above
 * the floor — and reports the directed ratio either way. A verdict that refuses comparability
 * withdraws the claim, never the measurement: the ratio is in the result details on every path,
 * including the refusals.
 */
export function emitParity(ctx: IEvaluationContext): void {
  const assertion = ctx.scenarioAssertions.parity;
  if (assertion === undefined) return;
  const { assertions, diagnostics, input } = ctx;
  const sourcePath = input.scenario.sourcePath;

  const reference = assertion.reference;
  if (reference === undefined) {
    // The load step hydrates this; arriving here means the scenario reached evaluation without
    // having been loaded through that path. Fail rather than invent a reference.
    assertions.push({ details: { reason: "no-hydrated-reference" }, id: "parity.observed", pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_REFERENCE_UNHYDRATED",
      message: `Scenario '${input.scenario.name}' asserts parity but its reference from '${assertion.referenceReport}' was never read.`,
      observedRuntimePath: "observations.json/performanceSeries",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Load the scenario through loadPlaytestScenario, which hydrates the parity reference at load.",
    });
    return;
  }

  const series = input.report.observations?.performanceSeries ?? [];
  if (series.length === 0) {
    assertions.push({ details: { sampleCount: series.length }, id: "parity.observed", pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_SERIES_MISSING",
      message: `Scenario '${input.scenario.name}' asserts parity but this run produced no measurable frame-time series.`,
      observedRuntimePath: "observations.json/performanceSeries",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Run against a target that measures the render loop and keep the performance bridge provider installed.",
    });
    return;
  }
  const frameTimes = series.map((sample) => (sample as { frameMs?: unknown }).frameMs);
  if (!frameTimes.every((value): value is number =>
    typeof value === "number" && Number.isFinite(value) && value > 0)) {
    assertions.push({ details: { sampleCount: series.length }, id: "parity.observed", pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_SERIES_MALFORMED",
      message: `Scenario '${input.scenario.name}' asserts parity but this run produced a malformed frame-time sample.`,
      observedRuntimePath: "observations.json/performanceSeries",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Fix the performance bridge provider so every sample carries a finite positive frameMs.",
    });
    return;
  }
  const thisFps = fpsFromFrameTimes(frameTimes) as number;
  // The directed ratio the Tier 2 table names: nativeFps ÷ webFps, whichever half the reference is.
  const ratio = assertion.referenceSide === "native" ? reference.fps / thisFps : thisFps / reference.fps;
  assertions.push({
    details: { referenceFps: reference.fps, referenceSide: assertion.referenceSide, ratio, unit: "ratio" },
    id: "parity.fpsRatio",
    pass: ratio >= assertion.minFpsRatio,
  });
  if (ratio < assertion.minFpsRatio) {
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_BELOW_FLOOR",
      message: `Parity ratio ${ratio.toFixed(3)} is below the ${assertion.minFpsRatio} floor (reference ${reference.fps.toFixed(2)} fps, this run ${thisFps.toFixed(2)} fps).`,
      observedRuntimePath: "observations.json/performanceSeries",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion:
        "Per PRD-222: a ratio under 0.85 on the same device routes to engine work — read TN_FRAME_BUDGET's phases and find which one owns the gap.",
    });
  }

  // Same device, or no verdict at all: a pair whose halves cannot both prove their device is not
  // a parity pair. The refusals are named; the ratio above is still in the record.
  const thisSerial = input.report.observations?.deviceMetrics?.serial;
  const referenceSerial = reference.serial;
  if (thisSerial === undefined || referenceSerial === undefined) {
    assertions.push({
      details: { reason: thisSerial === undefined ? "this-run-has-no-device-identity" : "reference-has-no-device-identity" },
      id: "parity.sameDevice",
      pass: false,
    });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_DEVICE_UNPROVABLE",
      message: `Parity cannot prove both halves ran on the same device: ${thisSerial === undefined ? "this run" : "the reference"} carries no device serial.`,
      observedRuntimePath: "observations.json/deviceMetrics",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Run both halves with --target android or --target browser --device <serial> so each report carries deviceMetrics.serial.",
    });
  } else if (thisSerial !== referenceSerial) {
    assertions.push({ details: { referenceSerial, thisSerial }, id: "parity.sameDevice", pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_DEVICE_MISMATCH",
      message: `The parity halves ran on different devices: this run on '${thisSerial}', the reference on '${referenceSerial}'. A cross-device ratio measures the hardware, not the framework.`,
      observedRuntimePath: "observations.json/deviceMetrics",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Take both halves on the same device in the same thermal window, then rerun.",
    });
  } else {
    assertions.push({ details: { serial: thisSerial }, id: "parity.sameDevice", pass: true });
  }

  const thisConfounded = input.report.observations?.deviceMetrics?.verdict.thermallyConfounded;
  if (reference.thermallyConfounded === undefined || thisConfounded === undefined) {
    assertions.push({
      details: {
        referenceVerdictObserved: reference.thermallyConfounded !== undefined,
        thisRunVerdictObserved: thisConfounded !== undefined,
      },
      id: "parity.thermalComparability",
      pass: false,
    });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_THERMAL_UNPROVABLE",
      message: "Parity cannot prove thermal comparability because at least one half carries no thermal verdict.",
      observedRuntimePath: "observations.json/deviceMetrics",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Run both halves through the Android device metrics recorder, then rerun the comparison.",
    });
  } else if (reference.thermallyConfounded || thisConfounded) {
    assertions.push({ details: { referenceThermallyConfounded: reference.thermallyConfounded === true, thisRunThermallyConfounded: thisConfounded === true }, id: "parity.thermalComparability", pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_PARITY_THERMALLY_CONFOUNDED",
      message: "At least one half of the parity pair is thermally confounded; the ratio it produced is not a same-thermal-window comparison.",
      observedRuntimePath: "observations.json/deviceMetrics",
      severity: "error",
      ...(sourcePath === undefined ? {} : { sourcePath }),
      suggestion: "Let the device cool to thermal status 0 and rerun both halves; the measured ratios stay in the reports.",
    });
  } else {
    assertions.push({
      details: { referenceThermallyConfounded: false, thisRunThermallyConfounded: false },
      id: "parity.thermalComparability",
      pass: true,
    });
  }

  const minRenderParity = assertion.minRenderParity;
  if (minRenderParity !== undefined) {
    const renderTimes = series
      .map((sample) => (sample as { phases?: { render?: unknown } }).phases?.render);
    const completeRenderTimes = renderTimes.every(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
    )
      ? renderTimes
      : undefined;
    if (reference.renderP95 === undefined || completeRenderTimes === undefined) {
      assertions.push({
        details: {
          referenceRenderP95: reference.renderP95 ?? null,
          thisRunSamplesWithRender: completeRenderTimes?.length ?? 0,
        },
        id: "parity.renderParity",
        pass: false,
      });
      diagnostics.push({
        code: "TN_PLAYTEST_PARITY_RENDER_UNMEASURED",
        message: "A render-parity floor was requested but at least one half's series carries no render-phase split.",
        observedRuntimePath: "observations.json/performanceSeries",
        severity: "error",
        ...(sourcePath === undefined ? {} : { sourcePath }),
        suggestion: "Keep the engine frame budget installed on both halves so every sample carries its phase split.",
      });
      return;
    }
    // Inverted render parity, per the Tier 2 table: lower render p95 is better, so the native
    // half's time in the numerator would reward slowness. Divide the browser's by the native's.
    const thisRenderP95Value = [...completeRenderTimes].sort((left, right) => left - right)[Math.ceil(completeRenderTimes.length * 0.95) - 1] as number;
    const renderRatio = assertion.referenceSide === "native" ? thisRenderP95Value / reference.renderP95 : reference.renderP95 / thisRenderP95Value;    assertions.push({
      details: { referenceRenderP95: reference.renderP95, renderRatio, thisRunRenderP95: thisRenderP95Value, unit: "ratio" },
      id: "parity.renderParity",
      pass: renderRatio >= minRenderParity,
    });
    if (renderRatio < minRenderParity) {
      diagnostics.push({
        code: "TN_PLAYTEST_PARITY_BELOW_FLOOR",
        message: `Inverted render p95 parity ${renderRatio.toFixed(3)} is below the ${minRenderParity} floor.`,
        observedRuntimePath: "observations.json/performanceSeries",
        severity: "error",
        ...(sourcePath === undefined ? {} : { sourcePath }),
        suggestion: "Read the render phase on both halves and find the submission cost the native half pays that the browser does not.",
      });
    }
  }
}
