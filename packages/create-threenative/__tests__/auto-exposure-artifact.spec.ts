import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { qualifyExposureCapture } from "./fixtures/auto-exposure/captureProof.js";

function cleanReport() {
  return {
    pass: true,
    diagnostics: [] as { code: string }[],
    capture: { rendererKind: "webgpu", adapter: { architecture: "swiftshader" } },
    observations: {
      startup: { phase: "ready" },
      console: [
        { text: 'TN_EXPOSURE_CLOCK:{"mode":"wall-clock"}' },
        {
          text: 'TN_AUTO_EXPOSURE:{"measured":true,"applied":true,"luminance":0.002,"exposureStops":6.5,"targetStops":6.6,"settled":true}',
        },
      ],
    },
  };
}

describe("exposure capture failure precedence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await makeTempDir("tn-exposure-artifact-");
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("preserves the original resource timeout when no screenshot was produced", async () => {
    const report = {
      ...cleanReport(),
      pass: false,
      diagnostics: [{ code: "TN_PLAYTEST_OBSERVATION_UNAVAILABLE" }],
    };
    await expect(
      qualifyExposureCapture(
        report,
        { applied: true },
        join(directory, "after.png"),
        "camera-reverse",
      ),
    ).rejects.toThrow(/TN_PLAYTEST_OBSERVATION_UNAVAILABLE/);
  });

  it("still rejects a missing screenshot after otherwise clean runtime proof", async () => {
    await expect(
      qualifyExposureCapture(
        cleanReport(),
        { applied: true },
        join(directory, "after.png"),
        "static",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still rejects an empty screenshot after otherwise clean runtime proof", async () => {
    const screenshot = join(directory, "after.png");
    await writeFile(screenshot, "");
    await expect(
      qualifyExposureCapture(cleanReport(), { applied: true }, screenshot, "static"),
    ).rejects.toThrow("static: runtime screenshot missing.");
  });

  it("returns the existing qualification only after the artifact guard passes", async () => {
    const screenshot = join(directory, "after.png");
    await writeFile(screenshot, new Uint8Array([1]));
    await expect(
      qualifyExposureCapture(cleanReport(), { applied: true }, screenshot, "static"),
    ).resolves.toMatchObject({ measurement: { luminance: 0.002 } });
  });
});
