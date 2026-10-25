import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";

import { parseStandalonePlaytestArgs, PlaytestCliUsageError, withScenarioClock } from "../src/runner/config.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import { buildReport } from "../src/runner/runner-support.js";
import { failureReport } from "../src/runner/shared.js";
import type { IPlaytestScenario } from "../src/index.js";

/**
 * `--live-clock`: the browser half of what the native production profile's own `--live-clock` does
 * there. A standing scene cannot be measured on counted ticks — the runner batches `waitTicks` into
 * `advance()` calls that present no frames, so a game that stands still reports one boot window and
 * nothing after it. The switch puts the clock request ahead of every page script, and the run says
 * which clock it measured on, because a rate off the wrong clock is not a rate.
 */
function project(): string {
  const root = makeTempDirSync("tn-live-clock-");
  const scenarioPath = join(root, "standing.playtest.json");
  writeFileSync(scenarioPath, JSON.stringify({
    name: "standing",
    schemaVersion: 1,
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 1,
    steps: [{ waitTicks: 300 }],
    assert: { performance: { maxFrameP95: 16.7 } },
  }));
  return root;
}

test("the flag is off by default and names the browser and desktop lanes", () => {
  const root = project();
  expect(parseStandalonePlaytestArgs(["standing.playtest.json", "--project", root]).liveClock).toBeUndefined();
  expect(parseStandalonePlaytestArgs(["standing.playtest.json", "--project", root, "--live-clock"]).liveClock).toBe(true);
  // The native desktop host reads the same request through TN_PLAYTEST_CLOCK, so a counted batch
  // that presents no frame stops being the only clock a standing scene can be measured on there.
  expect(parseStandalonePlaytestArgs([
    "standing.playtest.json",
    "--project",
    root,
    "--target",
    "desktop",
    "--executable",
    "game",
    "--live-clock",
  ]).liveClock).toBe(true);
  // Fail closed rather than silently measuring on the clock nobody asked for: the device lanes take
  // this switch from the production profile's injected instrumentation, not from this runner.
  for (const target of ["android", "ios"]) {
    expect(() => parseStandalonePlaytestArgs([
      "standing.playtest.json",
      "--project",
      root,
      "--target",
      target,
      "--live-clock",
    ])).toThrow(/browser and desktop/u);
  }
  // The named targets are the whole accepted set, so the message names both of them.
  expect(() => parseStandalonePlaytestArgs([
    "standing.playtest.json",
    "--project",
    root,
    "--target",
    "android",
    "--live-clock",
  ])).toThrow(PlaytestCliUsageError);
});

test("a scenario asks for the wall clock itself, so one glob run measures a performance scenario beside counted ones", () => {
  const base = { name: "standing", schemaVersion: 1, steps: [{ waitTicks: 300 }], target: "web", viewport: { height: 720, width: 1280 } };
  expect(validatePlaytestScenario({ ...base, clock: "wall-clock" }, "perf.playtest.json").clock).toBe("wall-clock");
  expect(validatePlaytestScenario(base, "counted.playtest.json").clock).toBeUndefined();
  expect(() => validatePlaytestScenario({ ...base, clock: "fast" }, "bad.playtest.json")).toThrow(/clock must be 'wall-clock'/u);
  expect(() => validatePlaytestScenario({ ...base, clock: "wall-clock", target: "desktop" }, "desktop.playtest.json")).toThrow(/clock is browser-only/u);
  const config = { artifactDirectory: "/tmp/artifacts", headless: false, url: "http://127.0.0.1:5173" } as Parameters<typeof buildReport>[0];
  const asks = validatePlaytestScenario({ ...base, clock: "wall-clock" }, "perf.playtest.json");
  const counted = validatePlaytestScenario(base, "counted.playtest.json");
  expect(withScenarioClock(config, asks).liveClock).toBe(true);
  expect(withScenarioClock(config, counted).liveClock).toBeUndefined();
  expect(buildReport(withScenarioClock(config, asks), asks, undefined, undefined, [], []).clock).toBe("wall-clock");
});

test("every report names the clock it measured on", () => {
  const config = {
    artifactDirectory: "/tmp/artifacts",
    headless: false,
    liveClock: true,
    url: "http://127.0.0.1:5173",
  } as Parameters<typeof buildReport>[0];
  const scenario = {
    name: "standing",
    schemaVersion: 1,
    steps: [{ waitTicks: 300 }],
    target: "web",
  } as unknown as IPlaytestScenario;

  expect(buildReport(config, scenario, undefined, undefined, [], []).clock).toBe("wall-clock");
  expect(buildReport({ ...config, liveClock: undefined }, scenario, undefined, undefined, [], []).clock)
    .toBe("fixed-step");
  // A run that never reached its assertions measured no clock of its own, but the clock it asked
  // for is still what the report must say: the failure is read on a machine, not beside a browser.
  expect(failureReport(config, scenario, {
    code: "TN_PLAYTEST_BRIDGE_MISSING",
    fix: { instruction: "install the bridge" },
    message: "no bridge",
    severity: "error",
  }).clock).toBe("wall-clock");
});