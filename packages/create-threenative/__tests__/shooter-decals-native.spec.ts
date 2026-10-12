import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { loadPlaytestScenario, requiredPlaytestCapabilities } from "../../playtest/dist/index.js";
import {
  ANDROID_TRANSPORT_CAPABILITIES,
  type IBridgeTransport,
  connectPlaytestBridgeTransport,
} from "../../playtest/dist/runner/index.js";
import { PLAYTEST_PROTOCOL_LIMITS } from "../../playtest/src/protocol.js";
import { validatePlaytestScenario } from "../../playtest/src/scenario.js";
import {
  assertNativeDecalCapture,
  evaluateDecalPixels,
  nativeDecalCases,
  nativeDecalScenario,
} from "./fixtures/bounded-decals/native-proof.js";

const fixture = fileURLToPath(new URL("./fixtures/bounded-decals/", import.meta.url));
const consoleEvidence = [{ type: "log", text: "TN_NATIVE_SMOKE_FIRST_FRAME" }];
function report(): Parameters<typeof assertNativeDecalCapture>[0] {
  return {
    pass: true,
    runtime: "native",
    target: "desktop",
    diagnostics: [],
    startup: { phase: "ready", progress: 1, compileSettled: true, rule: "compile-settled" },
    assertionResults: [{ id: "resources.0", pass: true }],
    capture: {
      target: "desktop",
      rendererKind: "webgpu",
      captureMethod: "device.screenshot",
      browserArgs: [],
      adapter: { description: "llvmpipe" },
      viewport: { width: 960, height: 540 },
    },
  };
}

it("requires genuine native provenance, readiness, nonempty assertions and clean host console", () => {
  expect(() => assertNativeDecalCapture(report(), consoleEvidence)).not.toThrow();
  for (const mutation of [
    { pass: false },
    { runtime: "web" },
    { target: "browser" },
    { capture: undefined },
    { startup: undefined },
    { startup: { phase: "ready", progress: 1, compileSettled: false, rule: "compile-settled" } },
    { assertionResults: [] },
    { assertionResults: [{ id: "resources.0", pass: false }] },
    { diagnostics: [{ severity: "warning", code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" }] },
    { diagnostics: [{ severity: "error", code: "unrelated" }] },
  ])
    expect(() =>
      assertNativeDecalCapture(
        { ...report(), ...mutation } as Parameters<typeof assertNativeDecalCapture>[0],
        consoleEvidence,
      ),
    ).toThrow();
  for (const bad of [
    [],
    undefined,
    [{ type: "error", text: "unrelated" }],
    [{ type: "log", text: "[WebGPU] Device error (Validation): invalid binding" }],
    [{ type: "log", text: "TypeError: unavailable API" }],
    [{ type: "log", text: "no frame" }],
  ])
    expect(() => assertNativeDecalCapture(report(), bad)).toThrow();
  const native = report();
  if (native.capture === undefined) throw new Error("Missing fixture capture");
  native.capture.adapter = { features: "some-feature", description: "unknown" };
  expect(() => assertNativeDecalCapture(native, consoleEvidence)).toThrow();
  native.capture.adapter = { description: "llvmpipe" };
  native.capture.captureMethod = "page.screenshot";
  expect(() => assertNativeDecalCapture(native, consoleEvidence)).toThrow();
  native.capture.captureMethod = "device.screenshot";
  native.capture.viewport.width = 800;
  expect(() => assertNativeDecalCapture(native, consoleEvidence)).toThrow();
});

it("preserves all authored predicates and passes actual minimal-native mailbox preflight", async () => {
  // Actual shared transport capabilities plus the minimal QuickJS describe shape from PR396.
  // This proves protocol admission, not execution on a native renderer.
  const transport: IBridgeTransport = {
    capabilities: ANDROID_TRANSPORT_CAPABILITIES,
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
      throw new Error(`Unexpected preflight call ${method}`);
    },
  };
  for (const { scenario: name } of nativeDecalCases) {
    const authored = await loadPlaytestScenario(fixture, `${name}.playtest.json`);
    const native = nativeDecalScenario(authored);
    expect(native.assert?.resources).toEqual(
      authored.assert?.components?.map(({ entity: _entity, component, ...predicate }) => ({
        id: "state",
        path: component,
        ...predicate,
      })),
    );
    expect(native.steps).toEqual(authored.steps);
    expect(native.assert?.visual).toBeUndefined();
    expect(requiredPlaytestCapabilities(native, "desktop")).not.toContain("runtime.diagnostics");
    expect(validatePlaytestScenario(native, name).target).toBe("desktop");
    await expect(
      connectPlaytestBridgeTransport(transport, native, 1000, "desktop"),
    ).resolves.toBeDefined();
  }
});

it("uses unchanged visual predicates on actual capture bytes and rejects hidden partial fade", async () => {
  const fading = await loadPlaytestScenario(fixture, "fading.playtest.json");
  const actual = await readFile(
    new URL("../../../docs/verification/vq11-decals-37003284983/fading.png", import.meta.url),
  );
  const hidden = await readFile(
    new URL(
      "../../../docs/verification/vq11-decals-36991562324/hidden-decals.png",
      import.meta.url,
    ),
  );
  expect(evaluateDecalPixels(actual, fading).assertions.every(({ pass }) => pass)).toBe(true);
  expect(
    evaluateDecalPixels(hidden, fading)
      .assertions.filter(({ pass }) => !pass)
      .map(({ id }) => id),
  ).toEqual(["visual.3.region.darkPixels", "visual.4.region.darkPixels"]);
  expect(() =>
    evaluateDecalPixels(actual, { ...fading, viewport: { width: 800, height: 540 } }),
  ).toThrow();
  expect(() => nativeDecalScenario({ ...fading, assert: {} })).toThrow();
  expect(() =>
    nativeDecalScenario({
      ...fading,
      assert: { ...fading.assert, fps: { min: 60 } },
    } as typeof fading),
  ).toThrow();
});
