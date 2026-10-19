import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { afterEach, expect, it } from "vitest";
import type { IStandalonePlaytestReport } from "../../packages/playtest/src/runner/shared.js";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  assertWorldCaptureGateRejection,
  verifyWorldCaptureReport,
} from "../verify-world-capture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const scenario = JSON.parse(
  readFileSync(
    new URL(
      "../../examples/abyss-framework/playtests/phase477-world-capture.playtest.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as { steps: { screenshot: string }[] };

async function fixture() {
  const directory = await makeTempDir("verify-world-capture-");
  roots.push(directory);
  const png = new PNG({ width: 16, height: 16 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = (index / 4) % 256;
    png.data[index + 1] = 100;
    png.data[index + 2] = 255 - ((index / 4) % 256);
    png.data[index + 3] = 255;
  }
  for (const step of scenario.steps)
    writeFileSync(path.join(directory, `${step.screenshot}.png`), PNG.sync.write(png));
  // Synthetic pixels validate the verifier only; they are never runtime evidence.
  const report: Pick<
    IStandalonePlaytestReport,
    "pass" | "capture" | "diagnostics" | "observations"
  > = {
    pass: true,
    capture: {
      adapter: { vendor: "google", architecture: "swiftshader" },
      browserArgs: ["--enable-unsafe-webgpu", "--enable-features=Vulkan"],
      captureMethod: "page.screenshot",
      rendererKind: "webgpu",
      target: "web",
      viewport: { width: 16, height: 16 },
    },
    diagnostics: [],
    observations: { console: [], hud: {}, network: [], resources: {} },
  };
  return { directory, report };
}

it("inspects all 34 captured PNGs including the settled end pose", async () => {
  const { directory, report } = await fixture();
  const frames = verifyWorldCaptureReport(report, directory);
  expect(frames.map(({ image }) => image)).toEqual(
    scenario.steps.map(({ screenshot }) => `${screenshot}.png`),
  );
  expect(frames).toHaveLength(34);
  expect(
    frames.every(
      ({ sha256, width, height }) => /^[a-f0-9]{64}$/.test(sha256) && width === 16 && height === 16,
    ),
  ).toBe(true);
});

it.each(["missing", "blank", "wrong-size"])("rejects a %s settled screenshot", async (defect) => {
  const { directory, report } = await fixture();
  const file = path.join(directory, "phase477-pose-end.png");
  if (defect === "missing") rmSync(file);
  else {
    const png = new PNG({ width: defect === "wrong-size" ? 32 : 16, height: 16 });
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = defect === "blank" ? 0 : (index / 4) % 256;
      png.data[index + 1] = 100;
      png.data[index + 2] = 255;
      png.data[index + 3] = 255;
    }
    writeFileSync(file, PNG.sync.write(png));
  }
  expect(() => verifyWorldCaptureReport(report, directory)).toThrow();
});

it.each(["device-loss", "console-error", "runtime-error", "failed-report"])(
  "rejects %s despite retained PNGs",
  async (defect) => {
    const { directory, report } = await fixture();
    if (defect === "device-loss")
      report.diagnostics.push({
        code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
        severity: "warning",
        message: "Device was lost",
      });
    if (defect === "console-error")
      report.observations?.console.push({ type: "error", text: "WebGPU device lost" });
    if (defect === "runtime-error")
      report.diagnostics.push({
        code: "TN_TEST_ERROR",
        severity: "error",
        message: "Runtime failed",
      });
    if (defect === "failed-report") report.pass = false;
    expect(() => verifyWorldCaptureReport(report, directory)).toThrow();
  },
);

it("requires the original gate's software-provenance rejection, not any exit 2", () => {
  const adapter = { architecture: "swiftshader" };
  const rejection = {
    status: 2,
    stderr: "TN_WORLD_VISUAL_INVALID: requires hardware WebGPU browser capture provenance\n",
  };
  expect(() => assertWorldCaptureGateRejection(rejection, adapter)).not.toThrow();
  expect(() =>
    assertWorldCaptureGateRejection({ status: 0, stderr: rejection.stderr }, adapter),
  ).toThrow();
  expect(() =>
    assertWorldCaptureGateRejection(
      { status: 2, stderr: "TN_WORLD_VISUAL_INVALID: missing image" },
      adapter,
    ),
  ).toThrow();
  expect(() =>
    assertWorldCaptureGateRejection(rejection, { description: "NVIDIA RTX 2080" }),
  ).toThrow();
});
