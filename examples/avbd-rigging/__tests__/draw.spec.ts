import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, it } from "vitest";
import {
  assertRiggingCapture,
  qualifyRiggingDraw,
  riggingPixels,
  riggingScenario,
} from "../verify-capture.js";
const { PNG } = createRequire(import.meta.resolve("@threenative/playtest/package.json"))(
  "pngjs",
) as {
  PNG: { sync: { write: (image: { width: number; height: number; data: Buffer }) => Buffer } };
};
function capture(shift = 0, missingRopes = false) {
  const data = Buffer.alloc(1280 * 720 * 4);
  for (let i = 0; i < data.length; i += 4) data.set([0x10, 0x1c, 0x27, 255], i);
  for (const [start, count, color] of [
    [shift, 2048, [0xe4, 0xc5, 0x92, 255]],
    [10000 + shift, 256, [0x5b, 0xbd, 0xb6, 255]],
    [20000 + shift, missingRopes ? 0 : 32, [0xd4, 0x5e, 0xf0, 255]],
  ] as const)
    for (let i = start; i < start + count; i++) data.set(color, i * 4);
  return PNG.sync.write({ width: 1280, height: 720, data });
}
it("rejects a stage-only capture and an independently missing rope draw", () => {
  const stage = Buffer.alloc(1280 * 720 * 4);
  for (let i = 0; i < stage.length; i += 4) stage.set([0x78, 0x90, 0x9b, 255], i);
  expect(() => riggingPixels(PNG.sync.write({ width: 1280, height: 720, data: stage }))).toThrow(
    /TN_AVBD_DRAW.*sail/,
  );
  expect(() => riggingPixels(capture(0, true))).toThrow(/TN_AVBD_DRAW.*rope/);
});
it("requires changed rope/sail pixels for the ladder and discloses the lifecycle override", () => {
  const before = capture();
  expect(() => qualifyRiggingDraw(before, before)).toThrow(/TN_AVBD_DRAW.*pixels changed/);
  expect(qualifyRiggingDraw(before, capture(800)).changedPixels).toBeGreaterThanOrEqual(64);
  expect(qualifyRiggingDraw(before, before, false)).toMatchObject({
    pass: true,
    requireChange: false,
    changedPixels: 0,
  });
});

it("binds qualification modes to the complete canonical scenario", () => {
  const correctness = readFileSync(new URL("../playtests/rigging.playtest.json", import.meta.url));
  const lifecycle = readFileSync(
    new URL("../playtests/rigging-lifecycle.playtest.json", import.meta.url),
  );
  expect(riggingScenario(correctness)).toBe("correctness");
  expect(riggingScenario(lifecycle)).toBe("lifecycle");
  const benchmark = readFileSync(
    new URL("../playtests/rigging-benchmark.playtest.json", import.meta.url),
  );
  expect(riggingScenario(benchmark)).toBe("benchmark");
  const partial = JSON.parse(benchmark.toString("utf8"));
  partial.steps[1].waitForResource.equals = 1;
  expect(() => riggingScenario(Buffer.from(JSON.stringify(partial)))).toThrow(
    /TN_AVBD_QUALIFICATION/,
  );
  const shortened = JSON.parse(correctness.toString("utf8"));
  shortened.steps = shortened.steps.slice(0, 1);
  expect(() => riggingScenario(Buffer.from(JSON.stringify(shortened)))).toThrow(
    /TN_AVBD_QUALIFICATION.*frozen/,
  );
});
it("rejects absent, unnamed or software provenance before hardware qualification", () => {
  const capture = {
    adapter: { description: "NVIDIA test fixture" },
    browserArgs: [],
    captureMethod: "device.screenshot" as const,
    rendererKind: "webgpu" as const,
    target: "desktop",
    viewport: { width: 1280, height: 720 },
  };
  expect(() => assertRiggingCapture(undefined, "desktop")).toThrow(/TN_AVBD_QUALIFICATION/);
  expect(() => assertRiggingCapture({ ...capture, adapter: {} }, "desktop")).toThrow(
    /TN_AVBD_QUALIFICATION/,
  );
  expect(() =>
    assertRiggingCapture(
      { ...capture, adapter: { features: "timestamp-query", vendor: " " } },
      "desktop",
    ),
  ).toThrow(/TN_AVBD_QUALIFICATION/);
  expect(() =>
    assertRiggingCapture({ ...capture, adapter: { description: "SwiftShader" } }, "desktop"),
  ).toThrow(/TN_AVBD_QUALIFICATION/);
  expect(() => assertRiggingCapture(capture, "browser")).toThrow(/TN_AVBD_QUALIFICATION/);
  expect(() => assertRiggingCapture(capture, "desktop")).not.toThrow();
  expect(() =>
    assertRiggingCapture(
      { ...capture, target: "web", captureMethod: "page.screenshot" },
      "browser",
    ),
  ).not.toThrow();
});
