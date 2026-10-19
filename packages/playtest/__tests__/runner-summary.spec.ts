import { describe, expect, it } from "vitest";
import { formatScenarioSummary } from "../src/runner/scenario-summary.js";
import type { IStandalonePlaytestReport } from "../src/runner/shared.js";

describe("scenarioSummary reasons", () => {
  it("omits reasons when there are no error diagnostics", () => {
    const report = {
      assertionResults: [{ id: "movement", pass: false }],
      diagnostics: [
        { code: "TN_WARN", message: "warning message", severity: "warning" },
      ],
      frames: 10,
      pass: false,
      scenario: "test-scenario",
    } as unknown as IStandalonePlaytestReport;

    const summary = formatScenarioSummary(report);
    expect(summary.scenarioSummary.diagnostics).toEqual(["TN_WARN"]);
    expect(summary.scenarioSummary.failed).toEqual(["movement"]);
    expect(summary.scenarioSummary).not.toHaveProperty("reasons");
  });

  it("includes reasons with error diagnostic messages", () => {
    const report = {
      assertionResults: [{ id: "diagnostics", pass: false }],
      diagnostics: [
        { code: "TN_PLAYTEST_OPERATION_TIMEOUT", message: "Bridge operation 'advance' exceeded 5000ms", severity: "error" },
        { code: "TN_WARN", message: "just a warning", severity: "warning" },
      ],
      frames: 0,
      pass: false,
      scenario: "starter-game-over",
    } as unknown as IStandalonePlaytestReport;

    const summary = formatScenarioSummary(report);
    expect(summary.scenarioSummary.diagnostics).toEqual(["TN_PLAYTEST_OPERATION_TIMEOUT", "TN_WARN"]);
    expect(summary.scenarioSummary.failed).toEqual(["diagnostics"]);
    expect(summary.scenarioSummary.reasons).toEqual(["Bridge operation 'advance' exceeded 5000ms"]);
  });
});
