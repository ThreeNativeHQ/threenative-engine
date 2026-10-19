import type { IStandalonePlaytestReport } from "./shared.js";

export function formatScenarioSummary(report: IStandalonePlaytestReport): { scenarioSummary: Record<string, unknown> } {
  const failedAssertions = (report.assertionResults ?? [])
    .filter(({ pass }) => pass === false)
    .map(({ id }) => id);
  const codes = report.diagnostics.map(({ code }) => code);
  // The code alone made a reader guess. `TN_PLAYTEST_OPERATION_TIMEOUT` says an operation
  // exceeded its budget and not which one, and the full report, which does carry the message, is
  // exactly what a CI log truncates. Carry the messages of the failing diagnostics on this line.
  const reasons = report.diagnostics
    .filter(({ severity }) => severity === "error")
    .map(({ message }) => message);
  return {
    scenarioSummary: {
      diagnostics: codes,
      failed: failedAssertions,
      ...(reasons.length === 0 ? {} : { reasons }),
      // A fixed-step scenario should reach the same tick on any machine, so a run that disagrees
      // with a developer's says the loop did not step the same way: a harness or engine property.
      firstTick: report.before?.tick,
      frames: report.frames,
      lastTick: report.after?.tick,
      pass: report.pass,
      scenario: report.scenario,
    },
  };
}
