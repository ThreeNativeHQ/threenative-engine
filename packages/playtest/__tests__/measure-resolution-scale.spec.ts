import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PLAYTEST_STARTUP_READY_TIMEOUT_MS } from "../src/protocol.js";

const fixture = vi.hoisted(() => {
  const server = {
    close: vi.fn(),
    listen: vi.fn(),
    resolvedUrls: { local: ["http://127.0.0.1:4173"] },
  };
  const display = {
    env: {},
    release: vi.fn(),
    strategy: { kind: "existing" as const, display: ":0" },
  };
  return {
    browserLaunch: vi.fn(),
    captureLease: { release: vi.fn() },
    acquireCaptureLease: vi.fn(),
    createProject: vi.fn(),
    createServer: vi.fn(),
    display,
    fs: {
      mkdir: vi.fn(),
      readFile: vi.fn(),
      symlink: vi.fn(),
      writeFile: vi.fn(),
    },
    provideDisplay: vi.fn(),
    server,
  };
});

vi.mock("node:fs/promises", () => fixture.fs);
vi.mock("node:module", () => ({
  createRequire: () => ({
    resolve: (specifier: string) => specifier,
  }),
}));
vi.mock("playwright", () => ({ chromium: { launch: fixture.browserLaunch } }));
vi.mock("vite", () => ({ createServer: fixture.createServer }));
vi.mock("../src/runner/captureEnvironment.js", () => ({ provideDisplay: fixture.provideDisplay }));
vi.mock("../src/runner/runner-support.js", () => ({ acquireRunnerCaptureLock: fixture.acquireCaptureLease }));
vi.mock("../../create-threenative/src/index.ts", () => ({ createProject: fixture.createProject }));
vi.mock("../src/runner/bridgeClient.js", () => ({
  PlaywrightTransport: class {
    async waitForBridge() { return true; }
    async call() { return {}; }
  },
  bridgeWaitTimeoutMs: () => 20_000,
}));
vi.mock("../src/runner/startupReady.js", () => ({ waitForStartupReady: async () => ({ phase: "ready" }) }));

const importMeasurement = () => {
  vi.resetModules();
  return import("../src/runner/measure-resolution-scale.js");
};

beforeEach(() => {
  vi.resetModules();
  fixture.browserLaunch.mockReset();
  fixture.captureLease.release.mockReset().mockResolvedValue(undefined);
  fixture.acquireCaptureLease.mockReset().mockResolvedValue(fixture.captureLease);
  fixture.createProject.mockReset().mockResolvedValue(undefined);
  fixture.createServer.mockReset().mockResolvedValue(fixture.server);
  fixture.display.release.mockReset().mockResolvedValue(undefined);
  fixture.fs.mkdir.mockReset().mockResolvedValue(undefined);
  fixture.fs.readFile.mockReset();
  fixture.fs.symlink.mockReset().mockResolvedValue(undefined);
  fixture.fs.writeFile.mockReset().mockResolvedValue(undefined);
  fixture.provideDisplay.mockReset().mockResolvedValue(fixture.display);
  fixture.server.close.mockReset().mockResolvedValue(undefined);
  fixture.server.listen.mockReset().mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllEnvs());

test("control source is wired into starter postprocessing while retaining core type imports", async () => {
  vi.stubEnv("TN_RESOLUTION_CONTROL_SOURCE", "/control/worldEnvironment.ts");
  const control = "export class WorldEnvironment {}";
  const source = 'import { type OutputRenderer, WorldEnvironment } from "@threenative/core";\nconst world = new WorldEnvironment();';
  fixture.fs.readFile.mockResolvedValueOnce(control).mockResolvedValueOnce(source);
  const error = new Error("stop after starter setup");
  fixture.provideDisplay.mockRejectedValue(error);
  await expect(importMeasurement()).rejects.toBe(error);
  expect(fixture.fs.writeFile).toHaveBeenCalledWith(expect.stringMatching(/src\/render\/resolutionControl\.ts$/), control);
  expect(fixture.fs.writeFile).toHaveBeenCalledWith(expect.stringMatching(/src\/render\/postprocessing\.ts$/),
    'import { type OutputRenderer } from "@threenative/core";\nimport { WorldEnvironment } from "./resolutionControl.js";\nconst world = new WorldEnvironment();');
});

test("control source rejects a missing WorldEnvironment import seam before serving", async () => {
  vi.stubEnv("TN_RESOLUTION_CONTROL_SOURCE", "/control/worldEnvironment.ts");
  fixture.fs.readFile.mockResolvedValueOnce("export class WorldEnvironment {}").mockResolvedValueOnce('import { Other } from "@threenative/core";');
  fixture.provideDisplay.mockRejectedValue(new Error("control was not wired"));
  await expect(importMeasurement()).rejects.toThrow("Starter WorldEnvironment control import source is missing");
  expect(fixture.createServer).not.toHaveBeenCalled();
});

test("startup failures close acquired resources and preserve the originating error", async () => {
  const displayError = new Error("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE: xdpyinfo failed");
  fixture.provideDisplay.mockRejectedValue(displayError);
  await expect(importMeasurement()).rejects.toBe(displayError);
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(fixture.browserLaunch).not.toHaveBeenCalled();
  expect(fixture.acquireCaptureLease).toHaveBeenCalledOnce();
  expect(fixture.captureLease.release).toHaveBeenCalledOnce();

  const browserError = new Error("browser launch failed");
  fixture.server.close.mockClear();
  fixture.provideDisplay.mockResolvedValue(fixture.display);
  fixture.browserLaunch.mockRejectedValue(browserError);
  await expect(importMeasurement()).rejects.toBe(browserError);
  expect(fixture.display.release).toHaveBeenCalledOnce();
  expect(fixture.server.close).toHaveBeenCalledOnce();

  const listenError = new Error("server listen failed");
  fixture.server.close.mockClear();
  fixture.provideDisplay.mockClear();
  fixture.server.listen.mockRejectedValue(listenError);
  await expect(importMeasurement()).rejects.toBe(listenError);
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(fixture.provideDisplay).not.toHaveBeenCalled();
});

test("capture acquisition failure closes the server before opening a display", async () => {
  const error = new Error("capture lease timeout");
  fixture.acquireCaptureLease.mockRejectedValue(error);
  await expect(importMeasurement()).rejects.toBe(error);
  expect(fixture.server.close).toHaveBeenCalledOnce();
  expect(fixture.provideDisplay).not.toHaveBeenCalled();
  expect(fixture.captureLease.release).not.toHaveBeenCalled();
});

test("capture lease is released even when display cleanup rejects", async () => {
  const error = new Error("display cleanup failed");
  fixture.browserLaunch.mockRejectedValue(new Error("browser launch failed"));
  fixture.display.release.mockRejectedValue(error);
  await expect(importMeasurement()).rejects.toBe(error);
  expect(fixture.captureLease.release).toHaveBeenCalledOnce();
});

test("cold navigation uses the existing startup readiness budget and releases resources on failure", async () => {
  const error = new Error("navigation failed");
  const goto = vi.fn().mockRejectedValue(error);
  const context = {newPage: vi.fn().mockResolvedValue({on: vi.fn(), goto}), close: vi.fn()};
  const browser = {newContext: vi.fn().mockResolvedValue(context), close: vi.fn()};
  fixture.browserLaunch.mockResolvedValue(browser);
  await expect(importMeasurement()).rejects.toBe(error);
  expect(goto).toHaveBeenCalledWith("http://127.0.0.1:4173", {waitUntil: "domcontentloaded", timeout: PLAYTEST_STARTUP_READY_TIMEOUT_MS});
  expect(context.close).toHaveBeenCalledOnce();
  expect(browser.close).toHaveBeenCalledOnce();
  expect(fixture.captureLease.release).toHaveBeenCalledOnce();
});

test.each(["missing completion", "stalled stop", "completed"])("trace flush %s releases resources and clears its watchdog", async (mode) => {
  vi.useFakeTimers();
  const cdp = Object.assign(new EventEmitter(), {
    send: vi.fn(async (method: string) => {
      if (method !== "Tracing.end") return;
      if (mode === "stalled stop") await new Promise(() => {});
      if (mode === "completed") cdp.emit("Tracing.tracingComplete");
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  });
  const page = {
    on: vi.fn(), goto: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ partial: {}, failure: { name: "Error", message: "observed failure" } }),
  };
  const context = { newPage: vi.fn().mockResolvedValue(page), newCDPSession: vi.fn().mockResolvedValue(cdp), close: vi.fn() };
  const browser = { newContext: vi.fn().mockResolvedValue(context), close: vi.fn() };
  fixture.browserLaunch.mockResolvedValue(browser);
  try {
    const result = expect(importMeasurement()).rejects.toThrow(mode === "completed" ? "observed failure" : "TN_RESOLUTION_TRACE_FLUSH_TIMEOUT");
    await vi.waitFor(() => expect(cdp.send).toHaveBeenCalledWith("Tracing.end"));
    if (mode !== "completed") await vi.advanceTimersByTimeAsync(20_000);
    await result;
    expect(cdp.detach).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(browser.close).toHaveBeenCalledOnce();
    expect(fixture.captureLease.release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
