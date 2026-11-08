import type { IEvaluationContext } from "./context.js";

/**
 * A geometry request carries no bounds of its own, so its one result says the capture actually
 * happened: a missing or unavailable report fails rather than passing on a request alone.
 */
export function emitGeometry({ assertions, diagnostics, input, scenarioAssertions }: IEvaluationContext): void {
  if (scenarioAssertions.geometry === undefined) return;
  const observed = input.report.observations?.geometry;
  const status = (observed as { status?: unknown } | undefined)?.status;
  const pass = status === "captured";
  assertions.push({ details: { observed, status }, id: "geometry.observed", pass });
  if (!pass) diagnostics.push({
    code: "TN_PLAYTEST_GEOMETRY_UNOBSERVED",
    message: "A geometry assertion was evaluated against a run whose bridge reported no captured geometry frame.",
    observedRuntimePath: "observations.json/geometry",
    severity: "error",
    suggestion: "Request the capture on a target whose bridge advertises runtime.geometry and is presenting world frames.",
  });
}
