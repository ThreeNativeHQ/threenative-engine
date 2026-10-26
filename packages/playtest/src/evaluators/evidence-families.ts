import { isRecord, jsonEqual, runtimeDiagnosticsSnapshot } from '../assertion-report.js';
import { assertionNotEvaluatedDiagnostic, overlayNodeObservationKey, projectedPixelsForEntity } from './helpers.js';
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import type { IEvaluationContext } from "./context.js";

export function emitEvidenceFamilies(ctx: IEvaluationContext): void {
  const { assertions, diagnostics } = ctx;
  const { input, scenarioAssertions } = ctx;
  for (const assertion of scenarioAssertions.overlayNodes ?? []) {
    const id = overlayNodeObservationKey(assertion.overlayId, assertion.selector);
    if (input.scenario.target !== "web") {
      assertions.push({ details: { reason: "target-unsupported", target: input.scenario.target }, id: `overlayNode.${id}`, pass: false });
      diagnostics.push(assertionNotEvaluatedDiagnostic(`overlayNode.${id}`, `target '${input.scenario.target}' cannot evaluate same-origin overlay DOM state`));
      continue;
    }
    const snapshot = input.report.observations?.overlayNodes?.[id]?.after;
    const observed = isRecord(snapshot) ? snapshot : {};
    const value = assertion.attribute === undefined ? observed.text : observed.attribute;
    const checks = [
      ...(Object.hasOwn(assertion, "equals") ? [jsonEqual(value, assertion.equals)] : []),
      ...(assertion.textIncludes === undefined ? [] : [String(value ?? "").includes(assertion.textIncludes)]),
      ...(assertion.visible === undefined ? [] : [observed.visible === assertion.visible]),
    ];
    const pass = checks.length > 0 && checks.every(Boolean);
    assertions.push({ details: { expected: assertion, observed }, id: `overlayNode.${id}`, pass });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_OVERLAY_NODE_ASSERTION_FAILED",
      message: `Overlay '${assertion.overlayId}' node '${assertion.selector}' did not satisfy the DOM assertion.`,
      severity: "error",
      suggestion: "Inspect observations.json/overlayNodes and verify the overlay subscription, selector, attribute, and computed style.",
    });
  }
  const captureFailure = input.report.observations?.visual?.captureFailure;
  const hasVisualSamples = input.report.observations?.visual !== undefined && captureFailure === undefined;
  if ((scenarioAssertions.visual?.length ?? 0) > 0 && captureFailure !== undefined) {
    for (const [index] of scenarioAssertions.visual!.entries()) {
      // A missing observation fails: a green row for an assertion that never ran is the v1
      // dropped-assertion shape, even though the composite verdict already carries
      // TN_CAPTURE_BLANK as its own diagnostic.
      assertions.push({
        details: { captureFailure, reason: "not-evaluated" },
        id: `visual.${index}`,
        pass: false,
      });
      diagnostics.push(
        assertionNotEvaluatedDiagnostic(
          `visual.${index}`,
          `the screenshot could not be captured (${captureFailure.code}: ${captureFailure.reason})`,
        ),
      );
    }
  } else if ((scenarioAssertions.visual?.length ?? 0) > 0 && !hasVisualSamples) {
    for (const [index] of scenarioAssertions.visual!.entries()) {
      assertions.push({ id: `visual.${index}`, pass: false, details: { reason: "target-unsupported", target: input.scenario.target } });
      diagnostics.push(assertionNotEvaluatedDiagnostic(`visual.${index}`, `target '${input.scenario.target}' does not expose visual assertion samples`));
    }
  }
  for (const [index, visual] of (hasVisualSamples ? scenarioAssertions.visual ?? [] : []).entries()) {
    if (visual.frameDiff !== undefined) {
      const ratio = input.report.observations?.visual?.changedPixelRatio;
      const pass = ratio !== undefined
        && (visual.frameDiff.minChangedPixelRatio === undefined || ratio >= visual.frameDiff.minChangedPixelRatio)
        && (visual.frameDiff.maxChangedPixelRatio === undefined || ratio <= visual.frameDiff.maxChangedPixelRatio);
      assertions.push({ id: `visual.${index}.frameDiff`, pass, details: { after: pass, changedPixelRatio: ratio, comparisonSource: input.report.observations?.visual?.comparisonSource, expected: { equals: true }, ...visual.frameDiff } });
      if (!pass) diagnostics.push({ code: "TN_PLAYTEST_FRAME_DIFF_FAILED", message: `Screenshot changed-pixel ratio ${ratio ?? "unavailable"} was outside the asserted range.`, severity: "error", suggestion: "Check whether the expected visual change rendered and whether the thresholds match the scenario." });
    }
    if (visual.region !== undefined) {
      const minimum = visual.region.minNonblankPixelRatio ?? 0.002;
      if ("element" in visual.region) {
        const observed = input.report.observations?.visual?.elementRegions?.find(({ assertionIndex }) => assertionIndex === index);
        const bounds = observed?.bounds;
        const hasBounds = bounds !== undefined
          && Number.isFinite(bounds.x)
          && Number.isFinite(bounds.y)
          && Number.isFinite(bounds.width)
          && Number.isFinite(bounds.height)
          && bounds.width > 0
          && bounds.height > 0;
        const pass = observed?.rendered === true
          && hasBounds
          && observed.nonblankPixelRatio !== undefined
          && observed.nonblankPixelRatio >= minimum;
        assertions.push({
          id: `visual.${index}.region`,
          pass,
          details: {
            after: pass,
            bounds: observed?.bounds,
            element: visual.region.element,
            expected: { equals: true },
            minimum,
            observed: observed?.nonblankPixelRatio,
            rendered: observed?.rendered ?? false,
          },
        });
        if (!pass) diagnostics.push({ code: "TN_PLAYTEST_REGION_BLANK", message: `Screenshot bounds for element '${describeVisualElement(visual.region.element)}' did not meet nonblank ratio ${minimum}.`, severity: "error", suggestion: "Check that the target element exists, has rendered computed styles, and contains nonblank screenshot pixels." });
        if (visual.region.minDarkPixelRatio !== undefined) {
          const darkPass = observed?.rendered === true
            && hasBounds
            && observed.darkPixelRatio !== undefined
            && observed.darkPixelRatio >= visual.region.minDarkPixelRatio;
          assertions.push({
            id: `visual.${index}.region.darkPixels`,
            pass: darkPass,
            details: {
              bounds: observed?.bounds,
              element: visual.region.element,
              maximumLuminance: visual.region.maxLuminance ?? 0.25,
              minimumDarkPixelRatio: visual.region.minDarkPixelRatio,
              observedDarkPixelRatio: observed?.darkPixelRatio,
              rendered: observed?.rendered ?? false,
            },
          });
          if (!darkPass) diagnostics.push({
            code: "TN_PLAYTEST_REGION_DARK_PIXEL_RATIO_FAILED",
            message: `Screenshot bounds for element '${describeVisualElement(visual.region.element)}' contained ${observed?.darkPixelRatio ?? "unavailable"} dark pixels, below required ratio ${visual.region.minDarkPixelRatio}.`,
            severity: "error",
            suggestion: "Check that the target element renders the expected foreground pixels inside its captured bounds.",
          });
        }
        if (visual.region.maxDarkPixelRatio !== undefined) {
          const darkPass = observed?.rendered === true
            && hasBounds
            && observed.darkPixelRatio !== undefined
            && observed.darkPixelRatio <= visual.region.maxDarkPixelRatio;
          assertions.push({
            id: `visual.${index}.region.maxDarkPixels`,
            pass: darkPass,
            details: {
              bounds: observed?.bounds,
              element: visual.region.element,
              maximumDarkPixelRatio: visual.region.maxDarkPixelRatio,
              observedDarkPixelRatio: observed?.darkPixelRatio,
              rendered: observed?.rendered ?? false,
            },
          });
          if (!darkPass) diagnostics.push({
            code: "TN_PLAYTEST_REGION_DARK_PIXEL_RATIO_EXCEEDED",
            message: `Screenshot bounds for element '${describeVisualElement(visual.region.element)}' contained ${observed?.darkPixelRatio ?? "unavailable"} dark pixels, above maximum ratio ${visual.region.maxDarkPixelRatio}.`,
            severity: "error",
            suggestion: "Check whether unexpected dark foreground geometry occupies the asserted element bounds.",
          });
        }
      } else {
        const staticRegion = visual.region;
        const observed = input.report.observations?.visual?.nonblankRegions?.find((region) => region.x === staticRegion.x && region.y === staticRegion.y && region.width === staticRegion.width && region.height === staticRegion.height);
        const pass = observed !== undefined && observed.nonblankPixelRatio >= minimum;
        assertions.push({ id: `visual.${index}.region`, pass, details: { after: pass, expected: { equals: true }, minimum, observed: observed?.nonblankPixelRatio } });
        if (!pass) diagnostics.push({ code: "TN_PLAYTEST_REGION_BLANK", message: `Screenshot region at (${staticRegion.x}, ${staticRegion.y}) did not meet nonblank ratio ${minimum}.`, severity: "error", suggestion: "Check camera framing and whether expected geometry renders in the asserted region." });
        if (staticRegion.minSharpness !== undefined) {
          const sharpness = observed?.sharpness;
          const sharpPass = sharpness !== undefined && sharpness >= staticRegion.minSharpness;
          assertions.push({ id: `visual.${index}.region.sharpness`, pass: sharpPass, details: { minimum: staticRegion.minSharpness, observed: sharpness ?? null } });
          if (!sharpPass) diagnostics.push({
            code: "TN_PLAYTEST_REGION_BLURRED",
            message: `Screenshot region at (${staticRegion.x}, ${staticRegion.y}) measured sharpness ${sharpness === undefined ? "unavailable" : sharpness.toFixed(3)}, below the floor ${staticRegion.minSharpness} (luminance Laplacian variance at full resolution over half resolution).`,
            severity: "error",
            suggestion: "A post stage that smears the frame (motion blur at rest, a blur or low-resolution pass) or a surface with no detail drops this. Capture the frame and fix the stage; do not lower the floor to pass.",
          });
        }
        if (staticRegion.minDarkPixelRatio !== undefined) {
          const darkPass = observed?.darkPixelRatio !== undefined && observed.darkPixelRatio >= staticRegion.minDarkPixelRatio;
          assertions.push({
            id: `visual.${index}.region.darkPixels`,
            pass: darkPass,
            details: {
              maximumLuminance: staticRegion.maxLuminance ?? 0.25,
              minimumDarkPixelRatio: staticRegion.minDarkPixelRatio,
              observedDarkPixelRatio: observed?.darkPixelRatio,
            },
          });
          if (!darkPass) diagnostics.push({
            code: "TN_PLAYTEST_REGION_DARK_PIXEL_RATIO_FAILED",
            message: `Screenshot region at (${staticRegion.x}, ${staticRegion.y}) contained ${observed?.darkPixelRatio ?? "unavailable"} dark pixels, below required ratio ${staticRegion.minDarkPixelRatio}.`,
            severity: "error",
            suggestion: "Check whether the expected foreground silhouette occupies the asserted raster region.",
          });
        }
        if (staticRegion.maxDarkPixelRatio !== undefined) {
          const darkPass = observed?.darkPixelRatio !== undefined && observed.darkPixelRatio <= staticRegion.maxDarkPixelRatio;
          assertions.push({
            id: `visual.${index}.region.maxDarkPixels`,
            pass: darkPass,
            details: {
              maximumDarkPixelRatio: staticRegion.maxDarkPixelRatio,
              observedDarkPixelRatio: observed?.darkPixelRatio,
            },
          });
          if (!darkPass) diagnostics.push({
            code: "TN_PLAYTEST_REGION_DARK_PIXEL_RATIO_EXCEEDED",
            message: `Screenshot region at (${staticRegion.x}, ${staticRegion.y}) contained ${observed?.darkPixelRatio ?? "unavailable"} dark pixels, above maximum ratio ${staticRegion.maxDarkPixelRatio}.`,
            severity: "error",
            suggestion: "Check whether unexpected dark foreground geometry occupies the asserted raster region.",
          });
        }
      }
    }
    if (visual.entityVisible !== undefined) {
      const frameSeries = input.report.observations?.visual?.runtimeDiagnosticsSeries;
      const samples = frameSeries ?? [input.report.observations?.runtimeDiagnostics];
      const selected = visual.entityVisible.throughoutFrames === true ? samples : samples.slice(-1);
      const projected = selected.map((sample) => projectedPixelsForEntity(runtimeDiagnosticsSnapshot(sample), visual.entityVisible!.entity, input.scenario.viewport));
      const hasRequiredSeries = visual.entityVisible.throughoutFrames !== true || (frameSeries !== undefined && frameSeries.length > 0);
      const pass = hasRequiredSeries && projected.length > 0 && projected.every((pixels) => pixels !== undefined && pixels >= visual.entityVisible!.minProjectedPixels);
      assertions.push({ id: `visual.${index}.entityVisible`, pass, details: { entity: visual.entityVisible.entity, hasRequiredSeries, projectedPixels: projected } });
      if (!pass) diagnostics.push({ code: "TN_PLAYTEST_ENTITY_VISIBILITY_DROPPED", message: `Entity '${visual.entityVisible.entity}' dropped below ${visual.entityVisible.minProjectedPixels} projected pixels.`, severity: "error", suggestion: "Check per-frame visibility, camera clipping, scale, and renderer state." });
    }
  }
}

function describeVisualElement(element: { id?: string; selector?: string }): string {
  return element.id === undefined ? `selector ${JSON.stringify(element.selector)}` : `id ${JSON.stringify(element.id)}`;
}
