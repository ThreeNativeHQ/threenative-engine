import { expect, test } from "vitest";

import { classifyRunnerError, exitCodeForReport } from "../src/runner/cli.js";
import { PlaytestCliUsageError } from "../src/runner/config.js";
import { PlaytestScenarioError } from "../src/scenario.js";

test.each([
  [new PlaytestCliUsageError("Missing scenario path."), "TN_PLAYTEST_CLI_USAGE"],
  [new Error("browserType.launch: Target page, context or browser has been closed"), "TN_PLAYTEST_BROWSER_UNAVAILABLE"],
  [new Error("browserType.launch: Timeout 180000ms exceeded"), "TN_PLAYTEST_BROWSER_UNAVAILABLE"],
  [new Error("page.evaluate: Error: Cannot advance fixed-step clock"), "TN_PLAYTEST_RUNNER_FAILED"],
  [new Error("page.goto: Timeout 15000ms exceeded"), "TN_PLAYTEST_PAGE_UNREACHABLE"],
  [new Error("ENOENT: no such file or directory, open 'playtests/boot-to-play.playtest.json'"), "TN_PLAYTEST_SCENARIO_UNREADABLE"],
  [new Error("Playtest scenario 'playtests/boot-to-play.playtest.json' could not be read."), "TN_PLAYTEST_SCENARIO_UNREADABLE"],
  [new Error("TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED: --cpu-prof is not supported on the android target; use the browser or desktop target."), "TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED"],
  [new Error("TN_PLAYTEST_CPU_PROFILE_WRITE_FAILED: ENOENT: no such file or directory, open '/missing/out.cpuprofile'"), "TN_PLAYTEST_CPU_PROFILE_WRITE_FAILED"],
  [new Error("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: the requested host display requires DISPLAY."), "TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE"],
  [new Error("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: cannot verify DISPLAY=:0: xdpyinfo spawnSync xdpyinfo ENOENT."), "TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE"],
] as const)("classifies %s as %s", (error, code) => {
  expect(classifyRunnerError(error, { cwd: "/project" }).code).toBe(code);
});

test("an unavailable host display points to the display and probe rather than the scenario", () => {
  const result = classifyRunnerError(new Error("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: DISPLAY=:0 is unavailable."));
  expect(result.fix.instruction).toContain("DISPLAY");
  expect(result.fix.instruction).toContain("xdpyinfo");
});

test("an invalid scenario keeps its existing diagnostic code", () => {
  const error = new PlaytestScenarioError({
    code: "TN_PLAYTEST_SCENARIO_INVALID",
    message: "invalid scenario",
    severity: "error",
  });

  expect(classifyRunnerError(error).code).toBe("TN_PLAYTEST_SCENARIO_INVALID");
});

test("an unrecognised error gets the unrecognised fix lead", () => {
  const diagnostic = classifyRunnerError(new Error("page.evaluate: Error: Cannot advance"));

  expect(diagnostic.code).toBe("TN_PLAYTEST_RUNNER_FAILED");
  expect(diagnostic.fix.instruction).toContain("Unexpected runner error");
});

test.each([
  [{ pass: true, assertionResults: [] }, 0],
  [{ pass: false, assertionResults: [{ id: "assertion", pass: false }] }, 1],
  [{ pass: false, assertionResults: [{ details: { reason: "not-evaluated" }, id: "diagnostics", pass: false }] }, 2],
  [{ pass: false }, 2],
] as const)("report %o produces exit code %i", (report, exitCode) => {
  expect(exitCodeForReport(report)).toBe(exitCode);
});
