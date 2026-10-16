import { emitTone } from "./evaluators/tone.js";
// Facade for the evaluator family modules (PRD-182 Phase 2). Import paths are unchanged:
// every existing consumer of @threenative/playtest keeps working through this entry.
import type { IPlaytestAssertionResult, IPlaytestDiagnostic } from "./assertion-report.js";
import type { IPlaytestReport } from "./report.js";
import type { IPlaytestScenario } from "./scenario.js";
import type { IEvaluationContext } from "./evaluators/context.js";
import { emitDeviceMetrics } from "./evaluators/device-metrics.js";
import { emitEvidenceFamilies } from "./evaluators/evidence-families.js";
import { emitMovementEvidence } from "./evaluators/movement-evidence.js";
import { emitDisplayFamilies } from "./evaluators/framebuffer-reachability.js";
import { emitParity } from "./evaluators/parity-evidence.js";
import { emitPerfSignalsWorld } from "./evaluators/perf-signals-world.js";
import { emitWorldGameplay } from "./evaluators/world-gameplay.js";
import { emitRenderChain } from "./evaluators/render-chain.js";
import { emitCausedBy } from "./evaluators/caused-by.js";
import { emitSceneNodes } from "./evaluators/scene-nodes.js";
import { emitScene } from "./evaluators/scene.js";
import { emitStartup } from "./evaluators/startup.js";
import { emitPipelineCensus } from "./evaluators/pipeline-census.js";

export { overlayNodeObservationKey } from "./evaluators/helpers.js";

export function evaluateRichPlaytestAssertions(input: {
  report: IPlaytestReport;
  scenario: IPlaytestScenario;
}): { assertions: IPlaytestAssertionResult[]; diagnostics: IPlaytestDiagnostic[] } {
  const assertions: IPlaytestAssertionResult[] = [];
  const diagnostics: IPlaytestDiagnostic[] = [];
  const scenarioAssertions = input.scenario.assert ?? {};
  const ctx: IEvaluationContext = { assertions, diagnostics, input, scenarioAssertions };
  emitTone(ctx);
  emitDeviceMetrics(ctx);
  emitDisplayFamilies(ctx);
  emitEvidenceFamilies(ctx);
  emitParity(ctx);
  emitPerfSignalsWorld(ctx);
  emitWorldGameplay(ctx);
  emitRenderChain(ctx);
  emitPipelineCensus(ctx);
  emitScene(ctx);
  emitSceneNodes(ctx);
  // A geometry request carries no bounds of its own, so its one result says the capture actually
  // happened: a missing or unavailable report fails rather than passing on a request alone.
  if (scenarioAssertions.geometry !== undefined) {
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
  emitCausedBy(ctx);
  emitStartup(ctx);
  emitMovementEvidence(ctx);
  if (
    assertions.length === 0 ||
    (scenarioAssertions.diagnostics === undefined && !assertions.some(({ id }) => id !== "diagnostics"))
  ) {
    const id = "scenario.assertions";
    assertions.push({ details: { reason: "no-evaluated-assertions" }, id, pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_SCENARIO_NO_ASSERTIONS",
      message: `Scenario '${input.scenario.name}' completed without evaluating any assertions.`,
      severity: "error",
      ...(input.scenario.sourcePath === undefined ? {} : { sourcePath: input.scenario.sourcePath }),
      suggestion:
        "Declare a supported assertion and ensure its evaluator observes a result before treating the scenario as proof.",
    });
  }
  return { assertions, diagnostics };
}
