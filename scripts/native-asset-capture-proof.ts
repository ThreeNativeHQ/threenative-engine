import assert from "node:assert/strict";
import { PNG } from "pngjs";
import type { IStandalonePlaytestReport } from "../packages/playtest/src/runner/runner.js";

/** Rendered checker colours in each specimen's own third of the frame, not a global nonblank test. */
export function inspectNativeAssetScreenshot(bytes: Buffer) {
  const png = PNG.sync.read(bytes);
  assert.equal(png.width, 960, "Native fixture capture width");
  assert.equal(png.height, 640, "Native fixture capture height");
  const counts = [
    [0, 0],
    [0, 0],
    [0, 0],
  ];
  for (let y = 100; y < 535; y++)
    for (let x = 0; x < png.width; x++) {
      const offset = (y * png.width + x) * 4;
      if ((png.data[offset + 3] ?? 0) < 250) continue;
      const r = png.data[offset] ?? 0;
      const g = png.data[offset + 1] ?? 0;
      const b = png.data[offset + 2] ?? 0;
      const region = Math.floor(x / 320);
      const first =
        region === 0
          ? g > 100 && b > 100 && r < g * 0.7
          : region === 1
            ? r > 100 && b > 80 && g < r * 0.65
            : g > 100 && g > r * 1.25 && g > b * 1.25;
      const second =
        region === 0
          ? r > 130 && r > g * 1.3 && b < r * 0.65
          : region === 1
            ? r > 120 && g > 100 && b < g * 0.65
            : b > 110 && b > r * 1.25 && b > g * 1.25;
      const row = counts[region];
      if (row && first) row[0] = (row[0] ?? 0) + 1;
      if (row && second) row[1] = (row[1] ?? 0) + 1;
    }
  for (const [region, row] of counts.entries())
    for (const [colour, pixels] of row.entries()) {
      assert.ok(
        pixels >= 200,
        `Specimen ${region} checker colour ${colour}: only ${pixels} pixels`,
      );
    }
  return { width: png.width, height: png.height, counts };
}

/** No successful screenshot proof can carry a lost device, empty assertions or unnamed adapter. */
export function assertNativeAssetCapture(
  report: Pick<
    IStandalonePlaytestReport,
    "pass" | "assertionResults" | "capture" | "diagnostics" | "runtime" | "target" | "startup"
  >,
  nativeConsole: unknown,
): void {
  assert.equal(report.pass, true, JSON.stringify(report.diagnostics));
  assert.equal(report.startup?.phase, "ready", "Native world never reached ready");
  assert.equal(report.startup.compileSettled, true, "Native compilation never settled");
  assert.equal(report.runtime, "native");
  assert.equal(report.target, "desktop");
  assert.equal(report.capture?.captureMethod, "device.screenshot");
  assert.ok(report.assertionResults?.length, "Native proof must evaluate assertions");
  assert.ok(
    report.assertionResults.every((result) => result.pass),
    "Native assertions failed",
  );
  assert.equal(report.capture?.target, "desktop", "Native proof cannot be a browser capture");
  assert.equal(report.capture.rendererKind, "webgpu");
  assert.ok(
    report.capture.adapter && Object.values(report.capture.adapter).some((value) => value.trim()),
    "Native adapter identity missing",
  );
  assert.ok(
    Array.isArray(nativeConsole) && nativeConsole.length > 0,
    "Native console evidence missing",
  );
  for (const entry of nativeConsole) {
    assert.ok(
      entry && typeof entry.text === "string" && typeof entry.type === "string",
      "Malformed native console evidence",
    );
    assert.notEqual(entry.type, "error", entry.text);
    assert.doesNotMatch(
      entry.text,
      /\[FATAL\]|\[WebGPU\].*(?:Device error|Device lost|Failed)|validation error|device(?:[ _-]| was )?lost|(?:Type|Reference|Range|Syntax)Error|TN_(?:NATIVE_START_FAILED|ASSETS_UNRESOLVED|NATIVE_KTX2_UNSUPPORTED|NATIVE_MESH_COMPRESSION_UNSUPPORTED)/iu,
    );
  }
  assert.ok(
    nativeConsole.some((entry) => entry.text.includes("TN_NATIVE_SMOKE_FIRST_FRAME")),
    "Native first-frame marker missing",
  );
  for (const diagnostic of report.diagnostics) {
    assert.notEqual(diagnostic.severity, "error", diagnostic.code);
    assert.doesNotMatch(diagnostic.code, /DEVICE_LOST|BRIDGE_MISSING/u);
  }
}
