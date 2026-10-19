import assert from "node:assert/strict";
import { PNG } from "pngjs";
import {
  type IPlaytestScenario,
  evaluateRichPlaytestAssertions,
} from "../../../../playtest/dist/index.js";
import type { IStandalonePlaytestReport } from "../../../../playtest/dist/runner/index.js";
import { screenshotObservations } from "../../../../playtest/src/runner/steps.js";

export const nativeDecalCases = [
  ...["static", "motion", "teardown", "restart", "lifecycle"].map((name) => ({
    name,
    scenario: name,
    entry: "native.ts",
    expectedPixelFailures: [] as string[],
  })),
  ...["atlas", "fading", "expired"].map((name) => ({
    name,
    scenario: name,
    entry: "native-atlas.ts",
    expectedPixelFailures: [] as string[],
  })),
  {
    name: "hidden-decals",
    scenario: "static",
    entry: "native-hidden.ts",
    expectedPixelFailures: ["visual.1.region.darkPixels", "visual.2.region.darkPixels"],
  },
  {
    name: "hidden-fading",
    scenario: "fading",
    entry: "native-hidden-fading.ts",
    expectedPixelFailures: ["visual.3.region.darkPixels", "visual.4.region.darkPixels"],
  },
];

/** Native supports resources/startup; pixel predicates remain external and unchanged. */
export function nativeDecalScenario(scenario: IPlaytestScenario): IPlaytestScenario {
  assert.ok(scenario.assert?.components?.length, "Native decals require state predicates.");
  assert.ok(
    scenario.assert.components.every(({ entity }) => entity === "decals"),
    "Unmapped native entity.",
  );
  assert.ok(
    Object.keys(scenario.assert).every((key) =>
      ["components", "visual", "diagnostics"].includes(key),
    ),
    "Unmapped native assertion family.",
  );
  const { sourcePath: _sourcePath, ...portable } = scenario;
  return {
    ...portable,
    target: "desktop",
    artifacts: { screenshots: "after", console: true },
    assert: {
      resources: scenario.assert.components.map(({ entity: _entity, component, ...predicate }) => ({
        id: "state",
        path: component,
        ...predicate,
      })),
      startup: { maxEnteredMs: 120_000, maxReadyMs: 120_000 },
    },
  };
}

export function assertNativeDecalCapture(
  report: Pick<
    IStandalonePlaytestReport,
    "pass" | "runtime" | "target" | "diagnostics" | "capture" | "startup" | "assertionResults"
  >,
  nativeConsole: unknown,
): void {
  assert.equal(report.pass, true, JSON.stringify(report.diagnostics));
  assert.equal(report.runtime, "native");
  assert.equal(report.target, "desktop");
  assert.equal(report.startup?.phase, "ready");
  assert.equal(report.startup.compileSettled, true);
  assert.ok(report.assertionResults?.length, "Native assertions are missing.");
  assert.ok(
    report.assertionResults.every(({ pass }) => pass),
    "Native assertion failed.",
  );
  const capture = report.capture;
  assert.ok(capture, "Native capture provenance is missing.");
  assert.equal(capture.target, "desktop");
  assert.equal(capture.captureMethod, "device.screenshot");
  assert.equal(capture.rendererKind, "webgpu");
  assert.deepEqual(capture.viewport, { width: 960, height: 540 });
  assert.ok(
    ["vendor", "architecture", "device", "description"].some((key) => {
      const value = capture.adapter[key];
      return (
        typeof value === "string" &&
        value.trim() !== "" &&
        !/^(unknown|unavailable|0|0x0)$/iu.test(value)
      );
    }),
    "Native adapter identity is missing.",
  );
  for (const diagnostic of report.diagnostics) {
    assert.notEqual(diagnostic.severity, "error", diagnostic.code);
    assert.doesNotMatch(diagnostic.code, /DEVICE_LOST|BRIDGE_MISSING/u);
  }
  assert.ok(Array.isArray(nativeConsole) && nativeConsole.length > 0, "Native console is missing.");
  for (const entry of nativeConsole) {
    assert.ok(
      entry && typeof entry.text === "string" && typeof entry.type === "string",
      "Malformed native console.",
    );
    assert.notEqual(entry.type, "error", entry.text);
    assert.doesNotMatch(
      entry.text,
      /\[FATAL\]|\[WebGPU\].*(?:Device error|Device lost|Failed)|validation error|device(?:[ _-]| was )?lost|(?:Type|Reference|Range|Syntax)Error|TN_(?:NATIVE_START_FAILED|ASSETS_UNRESOLVED|NATIVE_KTX2_UNSUPPORTED|NATIVE_MESH_COMPRESSION_UNSUPPORTED)/iu,
    );
  }
  assert.ok(
    nativeConsole.some((entry) => entry.text.includes("TN_NATIVE_SMOKE_FIRST_FRAME")),
    "Native first frame is missing.",
  );
}

/** Pure PNG measurement using the maintained evaluator, not a native capability claim. */
export function evaluateDecalPixels(png: Buffer, authored: IPlaytestScenario) {
  const image = PNG.sync.read(png);
  assert.equal(image.width, authored.viewport.width, "Actual screenshot width");
  assert.equal(image.height, authored.viewport.height, "Actual screenshot height");
  assert.ok(authored.assert?.visual?.length, "Visible decal predicates are missing.");
  const scenario = { ...authored, assert: { visual: authored.assert.visual } };
  return evaluateRichPlaytestAssertions({
    scenario,
    report: {
      diagnostics: [],
      distance: 0,
      entity: "",
      expectMoved: false,
      frames: 1,
      trivialityOptOuts: [],
      observations: {
        console: [],
        hud: {},
        network: [],
        resources: {},
        visual: screenshotObservations(undefined, png, scenario),
      },
    },
  });
}
