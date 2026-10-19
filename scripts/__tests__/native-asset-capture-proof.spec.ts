import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { requiredPlaytestCapabilities } from "../../packages/playtest/src/assertion-schema.js";
import { PLAYTEST_PROTOCOL_LIMITS } from "../../packages/playtest/src/protocol.js";
import {
  type IBridgeTransport,
  connectPlaytestBridgeTransport,
} from "../../packages/playtest/src/runner/bridgeClient.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";
import {
  assertNativeAssetCapture,
  inspectNativeAssetScreenshot,
} from "../native-asset-capture-proof.js";

const cleanConsole = [{ type: "log", text: "TN_NATIVE_SMOKE_FIRST_FRAME" }];

// Synthetic pixels are unit inputs only. Published evidence must come from the native runner.
function image(missingRegion = -1, transparent = false): Buffer {
  const png = new PNG({ width: 960, height: 640 });
  const colours = [
    [
      [20, 210, 225],
      [240, 85, 35],
    ],
    [
      [235, 45, 170],
      [245, 205, 35],
    ],
    [
      [95, 210, 60],
      [85, 100, 235],
    ],
  ];
  for (let y = 180; y < 440; y++)
    for (let x = 0; x < 960; x++) {
      const region = Math.floor(x / 320);
      if (region === missingRegion) continue;
      const rgb = colours[region]?.[x % 32 < 16 ? 0 : 1] ?? [0, 0, 0];
      png.data.set(
        [rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0, transparent ? 0 : 255],
        (y * 960 + x) * 4,
      );
    }
  return PNG.sync.write(png);
}

function report(): Parameters<typeof assertNativeAssetCapture>[0] {
  return {
    pass: true,
    startup: { phase: "ready", progress: 1, compileSettled: true, rule: "compile-settled" },
    runtime: "native",
    target: "desktop",
    assertionResults: [{ pass: true, id: "resources.0" }],
    diagnostics: [],
    capture: {
      target: "desktop",
      rendererKind: "webgpu",
      adapter: { description: "llvmpipe" },
      browserArgs: [],
      captureMethod: "device.screenshot",
      viewport: { width: 960, height: 640 },
    },
  };
}

test("requires both rendered colours for all three asset routes", () => {
  expect(inspectNativeAssetScreenshot(image()).counts).toHaveLength(3);
  for (const region of [0, 1, 2])
    expect(() => inspectNativeAssetScreenshot(image(region))).toThrow(`Specimen ${region}`);
});
test("rejects an empty or wrong-sized capture", () => {
  expect(() => inspectNativeAssetScreenshot(Buffer.from([]))).toThrow();
  expect(() =>
    inspectNativeAssetScreenshot(PNG.sync.write(new PNG({ width: 32, height: 32 }))),
  ).toThrow();
});
test("requires native provenance and nonempty live assertions", () => {
  expect(() => assertNativeAssetCapture(report(), cleanConsole)).not.toThrow();
  for (const mutation of [
    { assertionResults: [] },
    { pass: false },
    { capture: undefined },
    { capture: { target: "web", rendererKind: "webgpu", adapter: { description: "GPU" } } },
    { capture: { target: "desktop", rendererKind: "webgpu", adapter: { description: "" } } },
    { diagnostics: [{ severity: "warning", code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" }] },
  ])
    expect(() =>
      assertNativeAssetCapture(
        { ...report(), ...mutation } as Parameters<typeof assertNativeAssetCapture>[0],
        cleanConsole,
      ),
    ).toThrow();
});

test("invisible RGB cannot satisfy the native screenshot proof", () => {
  expect(() => inspectNativeAssetScreenshot(image(-1, true))).toThrow("Specimen 0");
});

test.each([
  "[WebGPU] Device error (Validation): invalid texture format",
  "[FATAL] The GPU device was lost: driver reset",
  "TN_ASSETS_UNRESOLVED: authored model failed to load",
  "TypeError: native renderer failed",
])("native console failures remain fatal even when classified as log: %s", (text) => {
  expect(() =>
    assertNativeAssetCapture(report(), [...cleanConsole, { type: "log", text }]),
  ).toThrow(text);
});

test("native scenario retains supported diagnostics without requesting an unavailable observer", () => {
  const scenario = validatePlaytestScenario(
    JSON.parse(
      readFileSync(
        "examples/abyss-framework/playtests/vq-native-asset-capabilities.playtest.json",
        "utf8",
      ),
    ),
    "vq01",
  );
  expect(requiredPlaytestCapabilities(scenario, "desktop")).not.toContain("runtime.diagnostics");
  expect(scenario.assert?.diagnostics).toBeUndefined();
  expect(requiredPlaytestCapabilities(scenario, "desktop")).toContain("runtime.startup");
  expect(scenario.assert?.startup?.maxReadyMs).toBe(120000);
});

test("native console evidence cannot be omitted or empty", () => {
  for (const console of [undefined, [], [{ type: "log", text: "no frame marker" }]]) {
    expect(() => assertNativeAssetCapture(report(), console)).toThrow();
  }
});

test("unclassified error-labelled native lines remain fatal", () => {
  expect(() =>
    assertNativeAssetCapture(report(), [
      ...cleanConsole,
      { type: "error", text: "Unexpected host failure" },
    ]),
  ).toThrow("Unexpected host failure");
});

test("the actual native bridge preflight accepts the fixture's assertion families", async () => {
  const scenario = validatePlaytestScenario(
    JSON.parse(
      readFileSync(
        "examples/abyss-framework/playtests/vq-native-asset-capabilities.playtest.json",
        "utf8",
      ),
    ),
    "vq01",
  );
  // Minimal subset of the real QuickJS handshake captured in run 36996645116.
  const transport: IBridgeTransport = {
    capabilities: ["browser.console", "browser.screenshot"],
    waitForBridge: async () => true,
    close: async () => {},
    async call<T>(method: string): Promise<T> {
      if (method === "describe")
        return {
          capabilities: [
            "runtime.network",
            "runtime.resources",
            "runtime.fixedStep",
            "runtime.startup",
          ],
          limits: PLAYTEST_PROTOCOL_LIMITS,
          name: "@threenative/playtest/three",
          protocolVersion: 1,
        } as T;
      if (method === "ready") return { ready: true } as T;
      throw new Error(`Unexpected preflight call: ${method}`);
    },
  };
  await expect(
    connectPlaytestBridgeTransport(transport, scenario, 1000, "desktop"),
  ).resolves.toBeDefined();
});

test("native ready and settled compilation cannot be omitted or inferred from pixels", () => {
  for (const startup of [
    undefined,
    { phase: "loading", progress: 0.9, compileSettled: true, rule: "compile-settled" },
    { phase: "ready", progress: 1, compileSettled: false, rule: "compile-settled" },
  ]) {
    expect(() => assertNativeAssetCapture({ ...report(), startup }, cleanConsole)).toThrow();
  }
});
