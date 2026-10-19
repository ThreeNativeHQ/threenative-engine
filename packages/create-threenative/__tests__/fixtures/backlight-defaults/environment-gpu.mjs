import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import {
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../../playtest/dist/runner/index.js";
const flags = [
  "--ozone-platform=x11",
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--use-vulkan=native",
  "--disable-vulkan-fallback-to-gl-for-testing",
];

const out = "artifacts/backlight-defaults/actual-jpeg-gpu-sample1";
const config = parseStandalonePlaytestArgs([
  "--scenario",
  "packages/create-threenative/__tests__/fixtures/backlight-defaults/cost.playtest.json",
  "--url",
  "http://127.0.0.1:5193/packages/create-threenative/__tests__/fixtures/backlight-defaults/index.html?arm=enabled&shot=backlit&gpuSample=1",
  "--timeout",
  "60000",
  "--artifacts",
  out,
  ...flags.flatMap((flag) => ["--browser-arg", flag]),
]);
await withBrowserCapture(config, async (session) => {
  const sample = await session.page.evaluate(() => globalThis.__BACKLIGHT_SOURCE_SAMPLE__);
  assert.equal(sample.measurement.status, "measured");
  assert.equal(sample.sourceWidth, 4096);
  assert.equal(sample.sourceHeight, 2048);
  assert.equal(sample.intensity, 2.5);
  assert.ok(
    Math.abs(sample.measurement.meanRadiance - 0.5471439738825153) < 0.04,
    "Actual GPU estimate must agree with independent spherical-linear JPEG oracle within disclosed sample tolerance.",
  );
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/sample.json`,
    JSON.stringify(
      {
        sample,
        provenance: session.provenance,
        oracle: {
          meanRadiance: 0.5471439738825153,
          tolerance: 0.04,
          method:
            "independent full JPEG spherical-weighted sRGB-to-linear CPU decode; not used in shipped source",
        },
      },
      null,
      2,
    ),
  );
  await session.screenshot("sampled-character");
  console.log(JSON.stringify(sample));
});
