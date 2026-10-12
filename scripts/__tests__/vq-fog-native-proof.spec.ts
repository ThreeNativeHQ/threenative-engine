import { PNG } from "pngjs";
import { expect, it } from "vitest";
import { assertCaptureNotBlank } from "../../packages/playtest/dist/capture.js";
import {
  ANDROID_TRANSPORT_CAPABILITIES,
  type IBridgeTransport,
  connectPlaytestBridgeTransport,
} from "../../packages/playtest/dist/runner/index.js";
import { requiredPlaytestCapabilities } from "../../packages/playtest/src/assertion-schema.js";
import { PLAYTEST_PROTOCOL_LIMITS } from "../../packages/playtest/src/protocol.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";
import {
  fogCaptureScenarios,
  fogNativeCaptureIsValid,
  fogNativePixelMetrics,
  fogResizeControlScenarios,
  nativeFogScenario,
  readFogNativeConsole,
} from "../verify-volumetric-fog.js";

const consoleEvidence = [{ type: "log", text: "TN_NATIVE_SMOKE_FIRST_FRAME" }];
it("rejects a native frame below the authored five-percent nonblank threshold", () => {
  // Verifier-only synthetic input, never screenshot evidence. The native generic dark-frame
  // exemption accepts this image, but the authored fog scenario requires five percent.
  const png = new PNG({ width: 640, height: 400 });
  for (let pixel = 0; pixel < 640 * 400; pixel += 1) png.data[pixel * 4 + 3] = 255;
  for (let pixel = 0; pixel < 10000; pixel += 1)
    for (let channel = 0; channel < 3; channel += 1)
      png.data[pixel * 4 + channel] = 32 + (pixel % 96);
  expect(() => assertCaptureNotBlank(PNG.sync.write(png), "synthetic unit input")).not.toThrow();
  expect(fogNativePixelMetrics(png).nonblankPixelRatio).toBe(0.0390625);
  expect(fogNativePixelMetrics(png).pass).toBe(false);
  for (let pixel = 10000; pixel < 12800; pixel += 1)
    for (let channel = 0; channel < 3; channel += 1) png.data[pixel * 4 + channel] = 128;
  expect(fogNativePixelMetrics(png).pass).toBe(true);
});
it("surfaces the primary host failure before trying a missing console file", async () => {
  await expect(
    readFogNativeConsole(
      {
        ...report(),
        pass: false,
        diagnostics: [
          {
            code: "TN_PLAYTEST_HOST_EXITED",
            severity: "error",
            message: "Surface image is already acquired; SIGABRT",
          },
        ],
      },
      "/does-not-exist/vq07/console.json",
    ),
  ).rejects.toThrow(/TN_PLAYTEST_HOST_EXITED.*Surface image is already acquired/u);
});
it("isolates native resize with fog off while preserving the original fog sequence", async () => {
  const original = await fogCaptureScenarios();
  const controls = fogResizeControlScenarios();
  expect(controls.map(({ mode }) => mode)).toEqual(["resizeOff", "resizeOffRestore"]);
  for (const { scenario, mode } of controls) {
    expect(validatePlaytestScenario(scenario, mode)).toBeDefined();
    expect(scenario.steps[0]).toMatchObject({ press: ["KeyO"] });
    expect(scenario.steps.some((step) => "press" in step && step.press?.includes("KeyF"))).toBe(
      false,
    );
    expect(scenario.steps.some((step) => "press" in step && step.press?.includes("KeyR"))).toBe(
      true,
    );
    for (const component of ["createdTargets", "releasedTargets", "liveTargets"])
      expect(scenario.assert?.components).toContainEqual(
        expect.objectContaining({ component, equals: 0 }),
      );
  }
  expect(
    controls[1]?.scenario.steps.some((step) => "press" in step && step.press?.includes("KeyT")),
  ).toBe(true);
  expect(original.slice(0, 17).map(({ mode }) => mode)).toEqual([
    "off",
    "zero",
    "fog",
    "inside",
    "sunOff",
    "pointOff",
    "overlap",
    "half",
    "wallOff",
    "blackOff",
    "scatter",
    "scatterSunOff",
    "scatterPointOff",
    "lifecycle",
    "lifecycleOff",
    "resizeSmall",
    "resizeRestore",
  ]);
  expect(original).toHaveLength(29);
  expect(original.find(({ mode }) => mode === "resizeSmall")?.scenario.steps[0]).toMatchObject({
    press: ["KeyF"],
  });
});
function report(): Parameters<typeof fogNativeCaptureIsValid>[0] {
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
      viewport: { width: 640, height: 400 },
    },
  };
}
it("requires actual native provenance, assertions, readiness and console evidence", () => {
  expect(fogNativeCaptureIsValid(report(), consoleEvidence)).toBe(true);
  for (const mutation of [
    { pass: false },
    { runtime: "browser" },
    { target: "web" },
    { capture: undefined },
    { assertionResults: [] },
    { startup: undefined },
    { diagnostics: [{ severity: "warning", code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" }] },
  ])
    expect(
      fogNativeCaptureIsValid(
        { ...report(), ...mutation } as Parameters<typeof fogNativeCaptureIsValid>[0],
        consoleEvidence,
      ),
    ).toBe(false);
  for (const badConsole of [
    [],
    undefined,
    [{ type: "error", text: "other error" }],
    [{ type: "log", text: "[WebGPU] Device error (Validation): invalid texture" }],
    [{ type: "log", text: "TypeError: unsupported graph" }],
    [{ type: "log", text: "no first-frame marker" }],
  ])
    expect(fogNativeCaptureIsValid(report(), badConsole)).toBe(false);
});
it("preserves every fog state predicate through supported native resources", async () => {
  for (const { mode, scenario } of await fogCaptureScenarios()) {
    const native = nativeFogScenario(scenario);
    expect(native.assert?.resources).toEqual(
      scenario.assert?.components?.map(({ entity: _entity, component, ...predicate }) => ({
        id: "state",
        path: component,
        ...predicate,
      })),
    );
    expect(native.assert?.diagnostics).toBeUndefined();
    expect(native.assert?.visual).toBeUndefined();
    expect(native.assert?.startup?.maxReadyMs).toBe(120000);
    expect(requiredPlaytestCapabilities(native, "desktop")).not.toContain("runtime.diagnostics");
    expect(validatePlaytestScenario(native, mode).target).toBe("desktop");
  }
});
it("passes the real native handshake preflight for every generated arm", async () => {
  // Minimal real QuickJS handshake captured by PR396 run36996645116, plus the actual
  // shared mailbox transport capabilities (including host key injection). Not a native render claim.
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
  for (const { scenario } of await fogCaptureScenarios())
    await expect(
      connectPlaytestBridgeTransport(transport, nativeFogScenario(scenario), 1000, "desktop"),
    ).resolves.toBeDefined();
});

it("declares the native backing-surface size for the small-target capture without weakening defaults", async () => {
  const authored = (await fogCaptureScenarios()).find(
    ({ mode }) => mode === "resizeSmall",
  )?.scenario;
  if (authored === undefined) throw new Error("Missing small-target scenario");
  const viewport = { width: 320, height: 240 };
  expect(nativeFogScenario(authored, viewport).viewport).toEqual(viewport);
  const capture = report().capture;
  if (!capture) throw new Error("Missing native capture fixture");
  const small = { ...report(), capture: { ...capture, viewport } };
  expect(fogNativeCaptureIsValid(small, consoleEvidence)).toBe(false);
  expect(fogNativeCaptureIsValid(small, consoleEvidence, viewport)).toBe(true);
});
