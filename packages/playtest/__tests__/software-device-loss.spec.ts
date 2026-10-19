import { describe, expect, test } from "vitest";

import { buildReport } from "../src/runner/runner-support.js";
import type { IPlaytestCaptureProvenance, IPlaytestScenario } from "../src/index.js";
import type { IRunnerConsoleEntry } from "../src/runner/shared.js";

const scenario = {
  assert: { diagnostics: { noConsoleErrors: true } },
  name: "software-device-loss",
  schemaVersion: 1,
  subject: "player",
  target: "web" as const,
  viewport: { height: 720, width: 1280 },
  warmupFrames: 1,
  steps: [{ release: true, waitTicks: 1 }],
} as unknown as IPlaytestScenario;

const softwareCapture = {
  adapter: { architecture: "swiftshader", vendor: "google" },
  browserArgs: ["--enable-features=Vulkan"],
  captureMethod: "page.screenshot",
  rendererKind: "webgpu",
  target: "web",
  viewport: { height: 720, width: 1280 },
} as IPlaytestCaptureProvenance;

const hardwareCapture = {
  ...softwareCapture,
  adapter: { architecture: "turing", vendor: "nvidia" },
} as IPlaytestCaptureProvenance;

const deviceLossCascade: IRunnerConsoleEntry[] = [
  {
    source: "browser-console",
    text: "THREE.THREE.WebGPURenderer: WebGPU Device Lost:\n\nMessage: A valid external Instance reference no longer exists.\nReason: unknown",
    type: "error",
  },
  {
    source: "browser-console",
    text: "TN_DEVICE_LOST: The GPU device was lost (unknown): A valid external Instance reference no longer exists.",
    type: "error",
  },
  {
    source: "browser-console",
    text: "THREE.Error resolving queries: AbortError: Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists.",
    type: "error",
  },
  {
    source: "browser-console",
    text: "OperationError: Instance dropped in popErrorScope\n    at http://127.0.0.1:4176/node_modules/.vite/deps/three_webgpu.js?v=fe38ffa0:55823:38",
    type: "pageerror",
  },
  {
    source: "page-error",
    text: "OperationError: Instance dropped error in getCompilationInfo\n    at WebGPUPipelineUtils._reportShaderDiagnostics",
    type: "pageerror",
  },
];

const realError: IRunnerConsoleEntry = {
  source: "browser-console",
  text: "TypeError: cannot read properties of undefined",
  type: "error",
};

function config(allowSoftwareAdapter: boolean) {
  return {
    allowSoftwareAdapter,
    artifactDirectory: "/tmp/artifacts",
    headless: false,
    url: "http://127.0.0.1:5173",
  } as Parameters<typeof buildReport>[0];
}

function reportWith(
  allowSoftwareAdapter: boolean,
  capture: IPlaytestCaptureProvenance,
  consoleEntries: IRunnerConsoleEntry[],
) {
  return buildReport(
    config(allowSoftwareAdapter),
    scenario,
    undefined,
    undefined,
    consoleEntries,
    [],
    0,
    {},
    true,
    undefined,
    [],
    undefined,
    capture,
  );
}

describe("a declared software lane reports a lost GPU device without failing noConsoleErrors", () => {
  test("allow-software downgrades the device-loss cascade to a visible diagnostic", () => {
    const report = reportWith(true, softwareCapture, deviceLossCascade);
    expect(report.pass).toBe(true);
    expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SOFTWARE_DEVICE_LOST");
    expect(report.observations?.console).toEqual([]);
  });

  test("a hardware run still fails noConsoleErrors on the same device loss", () => {
    const report = reportWith(true, hardwareCapture, deviceLossCascade);
    expect(report.pass).toBe(false);
    expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CONSOLE_ERROR");
    expect(report.diagnostics.map(({ code }) => code)).not.toContain("TN_PLAYTEST_SOFTWARE_DEVICE_LOST");
  });

  test("a software lane without the operator's declaration is not downgraded", () => {
    const report = reportWith(false, softwareCapture, deviceLossCascade);
    expect(report.pass).toBe(false);
    expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CONSOLE_ERROR");
  });

  test("a real console error on a declared software lane still fails", () => {
    const report = reportWith(true, softwareCapture, [...deviceLossCascade, realError]);
    expect(report.pass).toBe(false);
    expect(report.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_CONSOLE_ERROR");
    expect(report.observations?.console).toContainEqual(realError);
  });
});
