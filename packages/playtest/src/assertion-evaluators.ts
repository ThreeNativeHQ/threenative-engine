// Facade for the evaluator family modules (PRD-182 Phase 2). Import paths are unchanged:
// every existing consumer of @threenative/playtest keeps working through this entry.
import type { IPlaytestAssertionResult, IPlaytestDiagnostic } from "./assertion-report.js";
import type { IPlaytestReport } from "./report.js";
import type { IPlaytestScenario } from "./scenario.js";
import { ASSERTION_EMITTERS } from "./assertion-bindings.js";
import type { IEvaluationContext } from "./evaluators/context.js";

export function evaluateRichPlaytestAssertions(input: {
  report: IPlaytestReport;
  scenario: IPlaytestScenario;
}): { assertions: IPlaytestAssertionResult[]; diagnostics: IPlaytestDiagnostic[] } {
  const assertions: IPlaytestAssertionResult[] = [];
  const diagnostics: IPlaytestDiagnostic[] = [];
  const scenarioAssertions = input.scenario.assert ?? {};
  const ctx: IEvaluationContext = { assertions, diagnostics, input, scenarioAssertions };
  // The emitter list is the registry's bindings (assertion-bindings.ts), not a hand list here.
  for (const emit of ASSERTION_EMITTERS) emit(ctx);
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
