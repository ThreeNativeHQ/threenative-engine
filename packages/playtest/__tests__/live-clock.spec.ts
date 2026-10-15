import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { chromium } from "playwright";
import { runStandalonePlaytest } from "../src/runner/runner.js";
import { PlaytestBridgeError } from "../src/runner/bridgeClient.js";
import { waitFrames } from "../src/runner/steps.js";

import { makeTempDirSync } from "../../../test-support/temp-dir.js";

import { parseStandalonePlaytestArgs, PlaytestCliUsageError } from "../src/runner/config.js";
import { buildReport } from "../src/runner/runner-support.js";
import { failureReport } from "../src/runner/shared.js";
import type { IPlaytestScenario } from "../src/index.js";

// These clock-selection tests refuse browser launch and never use the GPU.
vi.mock("../src/runner/captureLock.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/runner/captureLock.js")>(),
  decideLockPolicy: () => ({ mode: "none" }),
}));

/**
 * `--live-clock`: the browser half of what the native production profile's own `--live-clock` does
 * there. A standing scene cannot be measured on counted ticks — the runner batches `waitTicks` into
 * `advance()` calls that present no frames, so a game that stands still reports one boot window and
 * nothing after it. The switch puts the clock request ahead of every page script, and the run says
 * which clock it measured on, because a rate off the wrong clock is not a rate.
 */
function project(performance: NonNullable<IPlaytestScenario["assert"]>["performance"] = { maxFrameMsP95: 16.7 }): string {
  const root = makeTempDirSync("tn-live-clock-");
  const scenarioPath = join(root, "standing.playtest.json");
  writeFileSync(scenarioPath, JSON.stringify({
    name: "standing",
    schemaVersion: 1,
    target: "web",
    viewport: { height: 720, width: 1280 },
    warmupFrames: 1,
    steps: [{ waitTicks: 300 }],
    assert: { performance },
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
// Frame-time assertions need the game's frame pump, not ten forced simulation ticks per frame.
test.each([
  { liveClock: undefined, target: "browser" as const, performance: { maxFrameMsP95: 16.7 }, expected: "wall-clock" },
  { liveClock: undefined, target: "browser" as const, performance: { minFps: 30 }, expected: "wall-clock" },
  { liveClock: undefined, target: "browser" as const, performance: { maxDrawCalls: 100 }, expected: "fixed-step" },
  { liveClock: false, target: "browser" as const, performance: { maxFrameMsP95: 16.7 }, expected: "fixed-step" },
  { liveClock: undefined, target: "android" as const, performance: { maxFrameMsP95: 16.7 }, expected: "fixed-step" },
])("$target performance requests $expected before browser launch", async ({ liveClock, target, performance, expected }) => {
  const root = project(performance);
  const launch = vi.spyOn(chromium, "launch").mockRejectedValue(new PlaytestBridgeError({
    code: "TN_PLAYTEST_BRIDGE_MISSING",
    message: "Controlled launch refusal checks the requested clock without a browser.",
    fix: { instruction: "This fixture deliberately stops before a browser starts." },
    severity: "error",
  }));
  try {
    const report = await runStandalonePlaytest({
      artifactDirectory: join(root, "artifacts"), headless: true,
      projectPath: root, scenarioPath: "standing.playtest.json", timeoutMs: 1000,
      trace: false, url: "http://127.0.0.1:5173", liveClock, target,
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(report.pass).toBe(false);
    expect(report.clock).toBe(expected);
  } finally {
    launch.mockRestore();
  }
});

test("waitFrames does nothing for zero or negative frame counts", async () => {
  const page = { evaluate: vi.fn() };
  await waitFrames(page as never, 0);
  await waitFrames(page as never, -3);
  expect(page.evaluate).not.toHaveBeenCalled();
});

test("waitFrames rejects a pending RAF at the supplied remaining budget", async () => {
  vi.useFakeTimers();
  try {
    const page = { evaluate: vi.fn(() => new Promise<void>(() => {})) };
    const pending = waitFrames(page as never, 1, 50).catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = await pending;
    expect(error).toMatchObject({ diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" } });
  } finally {
    vi.useRealTimers();
  }
});

test("waitFrames preserves queued RAF ordering through a long supplied budget", async () => {
  vi.useFakeTimers();
  const callbacks: Array<() => void> = [];
  const schedule = vi.fn((callback: () => void) => { callbacks.push(callback); return callbacks.length; });
  vi.stubGlobal("requestAnimationFrame", schedule);
  try {
    const page = { evaluate: vi.fn((callback: (count: number) => Promise<void>, count: number) => callback(count)) };
    const settled = vi.fn();
    const pending = waitFrames(page as never, 3, 40_000).then(() => { settled(); });
    for (let frame = 0; frame < 3; frame += 1) {
      expect(callbacks).toHaveLength(1);
      expect(settled).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(12_000);
      const callback = callbacks.shift();
      expect(callback).toBeTypeOf("function");
      callback?.();
    }
    await pending;
    expect(schedule).toHaveBeenCalledTimes(3);
    expect(callbacks).toHaveLength(0);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("waitFrames rejects after N minus one RAF callbacks and releases its timer", async () => {
  vi.useFakeTimers();
  const callbacks: Array<() => void> = [];
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { callbacks.push(callback); return callbacks.length; });
  try {
    const page = { evaluate: vi.fn((callback: (count: number) => Promise<void>, count: number) => callback(count)) };
    const pending = waitFrames(page as never, 3, 50).catch((error) => error);
    for (let frame = 0; frame < 2; frame += 1) {
      const callback = callbacks.shift();
      expect(callback).toBeTypeOf("function");
      callback?.();
    }
    expect(callbacks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(50);
    expect(await pending).toMatchObject({ diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" } });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});

test("waitFrames rejects an already-expired supplied budget without launching page.evaluate", async () => {
  const page = { evaluate: vi.fn(() => new Promise<void>(() => {})) };
  await expect(waitFrames(page as never, 1, 0)).rejects.toMatchObject({
    diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" },
  });
  expect(page.evaluate).not.toHaveBeenCalled();
});

test("waitFrames rejects malformed supplied budgets", async () => {
  const page = { evaluate: vi.fn(() => new Promise<void>(() => {})) };
  for (const budget of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    await expect(waitFrames(page as never, 1, budget)).rejects.toMatchObject({
      diagnostic: { code: "TN_PLAYTEST_OPERATION_TIMEOUT" },
    });
  }
  expect(page.evaluate).not.toHaveBeenCalled();
});
