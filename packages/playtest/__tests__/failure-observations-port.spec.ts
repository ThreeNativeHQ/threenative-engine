import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import type { IPlaytestBridgeClient } from "../src/runner/bridgeClient.js";
const fixture = vi.hoisted(() => ({
  failure: undefined as Error | undefined,
  callbacks: new Map<string, (...args: unknown[]) => void>(),
  lateClose: false, directory: "", writtenTrace: "",
  closes: 0, stepMode: false, advances: 0, samples: 0, tick: 4,
}));
vi.mock("playwright", () => ({ chromium: { launch: async () => ({
  newContext: async () => ({ close: async () => {
    if (fixture.lateClose) {
      fixture.writtenTrace = await readFile(join(fixture.directory, "runtime-trace.json"), "utf8");
      throw fixture.failure;
    }
  }, newPage: async () => ({
    addInitScript: async () => undefined,
    evaluate: async () => true,
    on: (event: string, callback: (...args: unknown[]) => void) => fixture.callbacks.set(event, callback),
  }) }),
}) } }));
vi.mock("../src/runner/browserSession.js", async (original) => ({
  ...await original<typeof import("../src/runner/browserSession.js")>(),
  remoteBrowserFor: () => undefined,
  playwrightProfileDirectories: () => [],
  removeStrandedProfiles: () => [],
  teardownBrowserSession: async () => { fixture.closes++; },
  openRunnerPage: async () => {
    fixture.callbacks.get("console")?.({ text: () => "actual collected handshake log", type: () => "info" });
    fixture.callbacks.get("requestfailed")?.({ method: () => "GET", url: () => "https://fixture.invalid/asset" });
    if (!fixture.stepMode) throw fixture.failure;
    return {
      description: { capabilities: [] },
      sample: async () => { fixture.samples++; return { clock: { mode: "fixed-step", tick: fixture.tick }, diagnostics: [{ code: "OBSERVED_RUNTIME", message: "prior observed diagnostic" }], entities: [{ id: "observed-player", visible: true }] }; },
      advance: async (ticks: number) => {
        fixture.advances++;
        fixture.callbacks.get("console")?.({ text: () => `advance requested ${ticks}`, type: () => "info" });
        if (fixture.advances === 2 && !fixture.lateClose) throw fixture.failure;
        fixture.tick += ticks;
      },
    };
  },
}));
vi.mock("../src/runner/steps.js", async (original) => ({
  ...await original<typeof import("../src/runner/steps.js")>(),
  waitFrames: async () => undefined,
  runStep: async (_page: unknown, bridge: IPlaytestBridgeClient, step: { waitTicks: number }) => {
    await bridge.advance(step.waitTicks);
    return { inputDriven: false };
  },
}));
vi.mock("../src/runner/observationSampling.js", async (original) => ({
  ...await original<typeof import("../src/runner/observationSampling.js")>(),
  readCaptureProvenance: async () => ({ target: "web", rendererKind: "webgpu", captureMethod: "page.screenshot",
    viewport: { width: 64, height: 64 }, browserArgs: ["--enable-unsafe-webgpu"], adapter: { description: "observed fixture adapter" } }),
}));
import { runStandalonePlaytest, writeObservationArtifacts } from "../src/runner/runner.js";
import { PlaytestBridgeError } from "../src/runner/bridgeClient.js";
import { playtestDiagnostic } from "../src/index.js";

async function failedRunner(error: Error, blockedConsole = false, stepMode = false, lateClose = false) {
  fixture.lateClose = lateClose; fixture.failure = error; fixture.closes = 0; fixture.callbacks.clear();
  fixture.stepMode = stepMode; fixture.advances = 0; fixture.samples = 0; fixture.tick = 4;
  const directory = await makeTempDir("tn-runner-failure-");
  fixture.directory = directory;
  await writeFile(join(directory, "scenario.json"), JSON.stringify({
    schemaVersion: 1, name: "failure-integrity", target: "web", warmupFrames: 0,
    artifacts: { screenshots: false, ...(lateClose ? { runtimeTrace: true } : {}) }, viewport: { width: 64, height: 64 },
    awaitStartup: false,
    steps: stepMode ? [{ label: "completed", waitTicks: 1 }, { label: "hung", waitTicks: 50 }] : [{ waitTicks: 1 }],
  }));
  if (blockedConsole) await mkdir(join(directory, "console.json"));
  const config = { artifactDirectory: directory, projectPath: directory, scenarioPath: "scenario.json",
    ...(stepMode ? { browserArgs: ["--enable-unsafe-webgpu"] } : {}),
    headless: true, trace: false, timeoutMs: 15000, url: "http://fixture.invalid" };
  return { directory, result: runStandalonePlaytest(config) };
}

test("the actual runner catch preserves collected logs for unknown errors and rethrows the identical primary error", async () => {
  const primary = new Error("unknown handshake failure");
  const { directory, result } = await failedRunner(primary);
  await expect(result).rejects.toBe(primary);
  expect(JSON.parse(await readFile(join(directory, "console.json"), "utf8"))).toEqual([
    { source: "browser-console", text: "actual collected handshake log", type: "info" },
  ]);
  expect(JSON.parse(await readFile(join(directory, "network.json"), "utf8"))).toHaveLength(1);
  expect(fixture.closes).toBe(1);
});

test("the actual runner retains its recognized diagnostic despite a secondary artifact I/O failure", async () => {
  const primary = new PlaytestBridgeError(playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "advance timed out", "Inspect the collected console."));
  const { directory, result } = await failedRunner(primary, true);
  const report = await result;
  expect(report.pass).toBe(false);
  expect(report.diagnostics[0]?.code).toBe(primary.diagnostic.code);
  expect(report.assertionResults?.[0]?.details?.reason).toBe("not-evaluated");
  await expect(readFile(join(directory, "network.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  expect(fixture.closes).toBe(1);
});

test("partial step console survives timeout without extra bridge queries", async () => {
  const primary = new PlaytestBridgeError(playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "advance timed out", "Inspect logs."));
  const { directory, result } = await failedRunner(primary, false, true);
  expect((await result).diagnostics[0]?.code).toBe(primary.diagnostic.code);
  expect(fixture.advances).toBe(2);
  expect(fixture.samples).toBe(2);
  expect(fixture.closes).toBe(1);
  expect(JSON.parse(await readFile(join(directory, "console.json"), "utf8")).map((entry: { text: string }) => entry.text))
    .toEqual(["actual collected handshake log", "advance requested 1", "advance requested 50"]);
});

test("failure reuse keeps existing artifact privacy policy and does not expand acquisition", async () => {
  const directory = await makeTempDir("tn-failure-existing-policy-");
  const observed = [{ source: "browser-console", type: "info", text: "fixture-local-log" }];
  expect(await writeObservationArtifacts(directory, { console: false, network: false, runtimeTrace: false }, {
    console: observed, network: [], runtimeTrace: undefined,
  })).toEqual(["console.json"]);
  expect(JSON.parse(await readFile(join(directory, "console.json"), "utf8"))).toEqual(observed);
  await expect(readFile(join(directory, "network.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(directory, "runtime-trace.json"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("late context failure preserves already-written runtime trace bytes and primary error", async () => {
  const primary = new Error("late context-close failure");
  const { directory, result } = await failedRunner(primary, false, true, true);
  await expect(result).rejects.toBe(primary);
  const retained = await readFile(join(directory, "runtime-trace.json"), "utf8");
  expect(retained).toBe(fixture.writtenTrace);
  const trace = JSON.parse(retained);
  expect(trace.recentRuntimeErrors).toContainEqual({ code: "OBSERVED_RUNTIME", message: "prior observed diagnostic" });
  expect(trace.scene.renderedEntities).toContainEqual({ id: "observed-player", visible: true });
  expect(fixture.advances).toBe(2);
  expect(fixture.samples).toBe(4);
  expect(fixture.closes).toBe(1);
});
