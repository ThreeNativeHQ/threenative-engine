import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import * as cpuWindow from "../src/runner/linuxCpuWindow.js";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { playtestDiagnostic } from "../src/index.js";
import { runDevicePlaytest } from "../src/runner/androidRunner.js";
import { PlaytestBridgeError } from "../src/runner/bridgeClient.js";
import { runDesktopPlaytest } from "../src/runner/desktopRunner.js";
import { DeviceMailboxTransport, type IDevicePlaytestTransport } from "../src/runner/deviceTransport.js";

test("mailbox timeout preserves its bounded request before cleanup", async () => {
  const files = new Map<string, string>();
  const transport = new DeviceMailboxTransport({
    read: async (path) => files.get(path),
    remove: async (path) => { files.delete(path); },
    write: async (path, contents) => { files.set(path, contents); },
  }, { request: "request", response: "response" }, 10);
  await transport.start();
  files.set("response", JSON.stringify({ id: "ready", result: null }));
  await transport.waitForBridge(100);
  await expect(transport.call("advance", 60, 15)).rejects.toThrow("exceeded 15ms");
  expect(transport.getPendingRequest?.()).toEqual({ requestId: "1", method: "advance", argument: 60, order: 1, timeoutMs: 15 });
  await transport.close();
  expect(transport.getPendingRequest?.()).toBeUndefined();
});

test("mailbox request context bounds large arguments and clears successful requests", async () => {
  const files = new Map<string, string>();
  let respond = false;
  const transport = new DeviceMailboxTransport({
    read: async (path) => files.get(path),
    remove: async (path) => { files.delete(path); },
    write: async (path, contents) => { const request = JSON.parse(contents); if (respond) files.set("response", JSON.stringify({ id: request.id, result: null })); else files.set(path, contents); },
  }, { request: "request", response: "response" }, 10);
  await transport.start(); files.set("response", JSON.stringify({ id: "ready", result: null })); await transport.waitForBridge(100);
  try {
    await expect(transport.call("sample", { large: "x".repeat(10000) })).rejects.toThrow("exceeded 10ms");
    expect(transport.getPendingRequest?.()).toMatchObject({ argumentTruncated: true, method: "sample", order: 1, timeoutMs: 10 });
    expect(JSON.stringify(transport.getPendingRequest?.()).length).toBeLessThan(5000);
    respond = true; await transport.call("ready"); expect(transport.getPendingRequest?.()).toBeUndefined();
  } finally { await transport.close(); }
});

test.each(["alive", "dead", "capture-fails", "write-fails", "request-write-fails", "outer-write-fails"])("timeout retains failed-host evidence without changing the %s verdict", async (mode) => {
  const root = await makeTempDir("device-failure-evidence-");
  const artifactDirectory = join(root, "artifacts");
  const consoleEntries = [{ text: "TN_SLOW_PHASE: actual failed workload", type: "log" }];
  const context = { requestId: "3", method: "advance", argument: 60, order: 3, timeoutMs: 35000 };
  let stopped = false;
  let captured = false;
  const transport: IDevicePlaytestTransport = {
    capabilities: [], start: async () => undefined, waitForBridge: async () => true,
    call: async () => { throw new PlaytestBridgeError(playtestDiagnostic("TN_PLAYTEST_OPERATION_TIMEOUT", "original timeout", "original fix")); },
    getPendingRequest: () => context,
    close: async () => { expect(captured).toBe(true); },
  };
  try {
    await writeFile(join(root, "scenario.json"), JSON.stringify({ schemaVersion: 1, name: "failure-evidence", target: "desktop", warmupFrames: 0, steps: [{ waitFrames: 1 }], viewport: { width: 640, height: 360 } }));
    await mkdir(artifactDirectory);
    if (mode === "write-fails" || mode === "outer-write-fails") await mkdir(join(artifactDirectory, "console.json"));
    if (mode === "request-write-fails") await mkdir(join(artifactDirectory, "device-request-context.json"));
    const config = { projectPath: root, scenarioPath: "scenario.json", artifactDirectory, target: "desktop" as const, timeoutMs: 10, headless: true, trace: false, url: "unused", desktop: { executable: "/unused-cpu-fixture" } };
    const driver = {
      prepare: async () => undefined, isAlive: async () => mode !== "dead", screenshot: async () => undefined,
      captureConsole: async () => { expect(stopped).toBe(false); captured = true; if (mode === "capture-fails") throw new Error("capture unavailable"); return consoleEntries; },
      stop: async () => { stopped = true; },
    };
    const report = mode === "outer-write-fails"
      ? await runDesktopPlaytest(config, { driver, transport, mailboxRoot: join(root, "mailbox") })
      : await runDevicePlaytest(config, { name: "desktop", processName: "CPU fixture", mailboxPaths: { request: "request", response: "response" }, transport, driver });
    expect(report.pass).toBe(false);
    expect(report.diagnostics[0]?.code).toBe(mode === "dead" ? "TN_PLAYTEST_HOST_EXITED" : "TN_PLAYTEST_OPERATION_TIMEOUT");
    expect(stopped).toBe(true);
    if (mode !== "request-write-fails") expect(JSON.parse(await readFile(join(artifactDirectory, "device-request-context.json"), "utf8"))).toEqual(context);
    if (mode !== "capture-fails") {
      expect(report.observations?.console).toEqual(consoleEntries);
      if (mode !== "write-fails" && mode !== "outer-write-fails") expect(JSON.parse(await readFile(join(artifactDirectory, "console.json"), "utf8"))).toEqual(consoleEntries);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test.each(["native", "legacy"])("CPU window failure releases only the %s engine render hold", async (engine) => {
  const root = await makeTempDir("device-render-hold-");
  const calls: Array<{ method: string; argument?: unknown }> = [];
  let held = false;
  const measure = vi.spyOn(cpuWindow, "measureCpuWindow").mockImplementation(async (_label, _owner, bridge) => {
    expect(held).toBe(engine === "native");
    await bridge.sample({});
    expect(held).toBe(engine === "native");
    throw new Error("CPU window fixture failed after first sample");
  });
  vi.stubEnv("TN_PLAYTEST_CPU_WINDOW_LABELS", '["pose"]');
  const transport: IDevicePlaytestTransport = {
    capabilities: ["browser.console"], start: async () => undefined, waitForBridge: async () => true,
    close: async () => undefined,
    call: async <T>(method: string, argument?: unknown): Promise<T> => {
      calls.push({ method, argument });
      if (method === "_holdAutomaticRender") held = argument === true;
      const result = method === "describe"
        ? { capabilities: ["runtime.fixedStep", "runtime.diagnostics", "runtime.network"], limits: { maxEntitiesPerSample: 100, maxEventsPerDrain: 1000, maxPayloadBytes: 1000000, operationTimeoutMs: 5000 }, name: "fixture", protocolVersion: 1, ...(engine === "native" ? { profile: { engine: "native" } } : {}) }
        : method === "ready" ? { ready: true }
        : method === "sample" ? { clock: { mode: "fixed-step", tick: 0 }, diagnostics: [], entities: [], network: { entries: [], requests: 0 }, resources: {} }
        : null;
      return result as T;
    },
  };
  try {
    await writeFile(join(root, "scenario.json"), JSON.stringify({ schemaVersion: 1, name: "hold", target: "web", awaitStartup: false, warmupFrames: 0, artifacts: { screenshots: false }, assert: { diagnostics: { noConsoleErrors: true } }, steps: [{ kind: "wait", label: "pose", waitTicks: 1000 }], viewport: { width: 640, height: 360 } }));
    await expect(runDevicePlaytest({ projectPath: root, scenarioPath: "scenario.json", artifactDirectory: join(root, "artifacts"), target: "desktop", timeoutMs: 1000, headless: true, trace: false, url: "unused" }, {
      name: "desktop", processName: "fixture", mailboxPaths: { request: "request", response: "response" }, transport,
      driver: { prepare: async () => undefined, isAlive: async () => true, screenshot: async () => undefined, captureConsole: async () => [], stop: async () => { expect(held).toBe(false); } },
    })).rejects.toThrow("CPU window fixture failed after first sample");
    expect(measure).toHaveBeenCalledOnce();
    expect(calls.filter(({ method }) => method === "_holdAutomaticRender").map(({ argument }) => argument)).toEqual(engine === "native" ? [true, false] : []);
    expect(held).toBe(false);
  } finally {
    measure.mockRestore();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  }
});
