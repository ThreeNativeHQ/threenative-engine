// Final frozen-source original fixture proof; run only after the serial template matrix.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseStandalonePlaytestArgs,
  runStandalonePlaytest,
} from "../../../../playtest/dist/runner/index.js";
const root = process.cwd();
const base = resolve("artifacts/backlight-defaults/final-fixture2");
const fixture = resolve("packages/create-threenative/__tests__/fixtures/backlight-defaults");
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
const cases = [
  ["edge-enabled-acceptance1", "edge-enabled", "enabled", "backlit-black-ibl", false],
  ["edge-rim-zero-acceptance1", "edge-rim-zero", "rim-zero", "backlit-black-ibl", false],
  ["fill-enabled-acceptance1", "fill-enabled", "enabled", "dark", false],
  ["fill-fill-black-acceptance1", "fill-fill-black", "fill-black", "dark", false],
  ["marker-positive-proof1", "fill-enabled", "enabled", "dark", false],
  ["marker-omitted-proof1", "fill-enabled", "enabled", "dark", true],
];
const results = [];
for (const [name, scenario, arm, shot, omit] of cases) {
  const output = resolve(base, name);
  await mkdir(output, { recursive: true });
  const url = `http://127.0.0.1:5193/packages/create-threenative/__tests__/fixtures/backlight-defaults/index.html?arm=${arm}&shot=${shot}${omit ? "&omitReport=1" : ""}`;
  const config = parseStandalonePlaytestArgs([
    "--headed",
    "--project",
    root,
    "--scenario",
    resolve(fixture, `${scenario}.playtest.json`),
    "--url",
    url,
    "--timeout",
    "60000",
    "--artifacts",
    output,
    ...flags.flatMap((flag) => ["--browser-arg", flag]),
  ]);
  const result = { name, url, scenario };
  try {
    const report = await runStandalonePlaytest(config);
    await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    result.reportPass = report.pass;
    result.failedIds = report.assertionResults.filter((row) => !row.pass).map((row) => row.id);
  } catch (error) {
    result.error = { message: error.message, stack: error.stack };
  }
  results.push(result);
  await writeFile(resolve(base, "runs.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(result));
}
