import { expect, test } from "vitest";
import type { IPlaytestCaptureProvenance } from "../../packages/playtest/src/index.js";
import { buildReport } from "../../packages/playtest/src/runner/runner-support.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";
import { assertToneCaptureDiagnostics } from "../tone-capture-proof.js";

function report(variant: "underexposed" | "restored", error?: string) {
  const scenario = validatePlaytestScenario(
    {
      schemaVersion: 1,
      name: "tone-proof",
      steps: [{ waitTicks: 1 }],
      assert: { diagnostics: { noConsoleErrors: true }, tone: [{ mean: { min: 100 } }] },
    },
    "tone.json",
  );
  const args: Parameters<typeof buildReport> = [
    {
      allowSoftwareAdapter: true,
      artifactDirectory: "/tmp/tone-proof",
      headless: false,
      url: "http://127.0.0.1:5173",
    } as Parameters<typeof buildReport>[0],
    scenario,
    undefined,
    undefined,
    error === undefined ? [] : [{ type: "error", source: "browser-console", text: error }],
    [],
  ];
  args[12] = {
    adapter: { architecture: "swiftshader", vendor: "google" },
    browserArgs: [],
    captureMethod: "page.screenshot",
    rendererKind: "webgpu",
    target: "web",
    viewport: { width: 1280, height: 720 },
  } as IPlaytestCaptureProvenance;
  args[20] = [
    {
      code: "TN_TONE",
      label: "after.png",
      mean: variant === "restored" ? 127.5 : 32,
      p1: 2,
      p50: 127,
      p99: 253,
      clipFraction: 0,
      blackFraction: 0,
    },
  ];
  return buildReport(...args);
}

test.each(["underexposed", "restored"] as const)(
  "%s cannot qualify pixels after a downgraded software-device loss",
  (variant) => {
    const result = report(variant, "WebGPU Device Lost: Instance dropped in popErrorScope");
    expect(result.diagnostics.some(({ code }) => code === "TN_PLAYTEST_SOFTWARE_DEVICE_LOST")).toBe(
      true,
    );
    expect(result.pass).toBe(variant === "restored");
    expect(() => assertToneCaptureDiagnostics(result.diagnostics, variant)).toThrow(
      "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
    );
  },
);

test("an expected tone failure cannot hide an unrelated renderer error", () => {
  const result = report("underexposed", "TypeError: broken renderer");
  expect(result.pass).toBe(false);
  expect(() => assertToneCaptureDiagnostics(result.diagnostics, "underexposed")).toThrow(
    "TN_PLAYTEST_CONSOLE_ERROR",
  );
});

test.each(["underexposed", "restored"] as const)(
  "%s accepts only its clean expected diagnostics",
  (variant) => {
    const result = report(variant);
    expect(result.pass).toBe(variant === "restored");
    expect(() => assertToneCaptureDiagnostics(result.diagnostics, variant)).not.toThrow();
  },
);

test("the restored arm cannot accept a tone assertion error", () => {
  expect(() =>
    assertToneCaptureDiagnostics(report("underexposed").diagnostics, "restored"),
  ).toThrow("TN_PLAYTEST_TONE_ASSERTION_FAILED");
});
