import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { PLAYTEST_PROTOCOL_LIMITS, PLAYTEST_PROTOCOL_VERSION, playtestDiagnostic } from "../src/index.js";
import { runDevicePlaytest } from "../src/runner/androidRunner.js";
import { PlaytestBridgeError } from "../src/runner/bridgeClient.js";
import type { IDevicePlaytestTransport } from "../src/runner/deviceTransport.js";

type FixtureMode = "recovering" | "skip-startup" | "no-startup" | "warmup-timeout";

async function runStartupWarmup(mode: FixtureMode, target: "android" | "desktop" = "desktop") {
  const root = await makeTempDir("device-startup-warmup-");
  const calls: Array<{ method: string; argument?: unknown; timeoutMs?: number }> = [];
  const samples: number[] = [];
  const advances: number[] = [];
  let ready = mode === "warmup-timeout";
  let startupPumps = 0;
  let tick = 0;
  let prepared = false;
  let stopped = false;
  const timeout = (message: string) => new PlaytestBridgeError(playtestDiagnostic(
    "TN_PLAYTEST_OPERATION_TIMEOUT", message, "Inspect the host frame pump.",
  ));
  const transport: IDevicePlaytestTransport = {
    capabilities: ["browser.console"],
    start: async () => undefined,
    waitForBridge: async () => prepared,
    close: async () => undefined,
    call: async <T>(method: string, argument?: unknown, timeoutMs?: number): Promise<T> => {
      calls.push({ method, argument, timeoutMs });
      let result: unknown;
      if (method === "describe") {
        result = {
          capabilities: ["runtime.fixedStep", "runtime.diagnostics", "runtime.network", ...(mode === "no-startup" ? [] : ["runtime.startup"])],
          limits: PLAYTEST_PROTOCOL_LIMITS,
          name: "CPU startup fixture",
          protocolVersion: PLAYTEST_PROTOCOL_VERSION,
        };
      } else if (method === "ready") {
        result = { ready: true, ...(mode === "no-startup" ? {} : { startup: { phase: ready ? "ready" : "collapsing", progress: ready ? 1 : 0 } }) };
      } else if (method === "advance") {
        const ticks = Number(argument);
        advances.push(ticks);
        if (ticks === 60) {
          if (mode === "recovering" && !ready) throw timeout("Full warmup requested before startup recovered.");
          if (mode === "warmup-timeout") throw timeout("Warmup still times out after startup readiness.");
        } else if (mode === "recovering" && !ready) {
          startupPumps += 1;
          if (startupPumps === 1) throw timeout("First startup pump is temporarily blocked by compilation.");
          ready = true;
        }
        tick += ticks;
        result = { clock: { mode: "fixed-step", tick }, ticks };
      } else if (method === "sample") {
        if (mode === "warmup-timeout") throw timeout("Warmup still times out after startup readiness.");
        samples.push(tick);
        result = { clock: { mode: "fixed-step", tick }, diagnostics: [], entities: [], resources: {}, network: { requests: 0, entries: [] } };
      } else {
        throw new Error(`Unexpected fixture operation ${method}`);
      }
      return result as T;
    },
  };
  try {
    await writeFile(join(root, "scenario.json"), JSON.stringify({
      schemaVersion: 1,
      name: "startup-before-warmup",
      target: "web",
      ...(mode === "skip-startup" ? { awaitStartup: false } : {}),
      artifacts: { screenshots: false },
      assert: { diagnostics: { noConsoleErrors: true, noRuntimeDiagnostics: true } },
      warmupFrames: 60,
      steps: [{ waitFrames: 2 }],
      viewport: { width: 640, height: 360 },
    }));
    const report = await runDevicePlaytest({
      projectPath: root, scenarioPath: "scenario.json", artifactDirectory: join(root, "artifacts"),
      target, timeoutMs: 1000, headless: true, trace: false, url: "unused",
    }, {
      name: target, processName: "CPU startup fixture", mailboxPaths: { request: "request", response: "response" }, transport,
      driver: {
        prepare: async () => { prepared = true; },
        isAlive: async () => true,
        screenshot: async () => undefined,
        captureConsole: async () => [],
        stop: async () => { stopped = true; },
      },
    });
    return { report, calls, samples, advances, stopped };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test.each(["desktop", "android"] as const)("%s waits through a temporary startup timeout before observing every warmup frame without advancing simulation", async (target) => {
  const result = await runStartupWarmup("recovering", target);
  expect(result.report.diagnostics).toEqual([]);
  expect(result.report.assertionResults?.filter(({ pass }) => !pass)).toEqual([]);
  expect(result.report.pass).toBe(true);
  expect(result.report.observations?.startup).toMatchObject({ phase: "ready", rule: "sustained-frames" });
  expect(result.advances).toEqual([1, 1, 2]);
  expect(result.samples).toEqual([...Array<number>(61).fill(1), 3, 3]);
  expect(result.calls.filter(({ method }) => method === "advance").map(({ timeoutMs }) => timeoutMs)).toEqual([20250, 20250, 20500]);
  expect(result.report.assertionResults).toContainEqual(expect.objectContaining({ id: "diagnostics", pass: true }));
  expect(result.stopped).toBe(true);
});

test.each(["skip-startup", "no-startup"] as const)("%s retains immediate complete warmup", async (mode) => {
  const result = await runStartupWarmup(mode);
  expect(result.report.diagnostics).toEqual([]);
  expect(result.report.assertionResults?.filter(({ pass }) => !pass)).toEqual([]);
  expect(result.report.pass).toBe(true);
  expect(result.calls.slice(0, 3).map(({ method }) => method)).toEqual(["describe", "ready", "sample"]);
  expect(result.calls.filter(({ method }) => method === "ready")).toHaveLength(1);
  expect(result.advances).toEqual([2]);
  expect(result.samples).toEqual([...Array<number>(61).fill(0), 2, 2]);
  expect(result.report.observations?.startup).toBeUndefined();
});

test("a warmup timeout after readiness still fails before observation", async () => {
  const result = await runStartupWarmup("warmup-timeout");
  expect(result.report.pass).toBe(false);
  expect(result.report.diagnostics).toContainEqual(expect.objectContaining({
    code: "TN_PLAYTEST_OPERATION_TIMEOUT", message: "Warmup still times out after startup readiness.",
  }));
  expect(result.advances).toEqual([]);
  expect(result.samples).toEqual([]);
  expect(result.calls.find(({ method }) => method === "sample")?.argument).toEqual({ entities: [], include: [] });
  expect(result.stopped).toBe(true);
});
