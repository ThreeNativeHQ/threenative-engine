// Read the engine's real frame/timestamp windows; own no renderer, meter or browser lifetime.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../../playtest/dist/runner/index.js";
const arm = process.argv[2];
const view = process.argv[3] ?? "backlit";
if (!["baseline", "enabled"].includes(arm) || !["backlit", "dark"].includes(view))
  throw new Error("Expected baseline|enabled and backlit|dark");
// Optional explicit output preserves earlier measurements; defaults remain backward compatible.
const out = resolve(process.argv[4] ?? `artifacts/backlight-defaults/live-${view}-${arm}`);
const url = `http://127.0.0.1:5193/packages/create-threenative/__tests__/fixtures/backlight-defaults/index.html?arm=${arm}&shot=${view}&liveCost=1`;
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
const config = parseStandalonePlaytestArgs([
  "--scenario",
  "packages/create-threenative/__tests__/fixtures/backlight-defaults/cost.playtest.json",
  "--url",
  url,
  "--timeout",
  "60000",
  "--artifacts",
  out,
  ...flags.flatMap((flag) => ["--browser-arg", flag]),
]);
await withBrowserCapture(config, async (session) => {
  const errors = [];
  session.page.on("pageerror", (error) => errors.push(String(error)));
  session.page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  // The readiness handshake pauses its initial game. Reload with liveCost's explicit non-held
  // plugin and do not handshake again, so the engine's actual RAF loop generates these windows.
  await session.page.reload({ waitUntil: "domcontentloaded" });
  await session.page.waitForFunction(
    () => globalThis.__BACKLIGHT_BUDGET_WINDOWS__?.length >= 5,
    {},
    { timeout: 55000 },
  );
  const windows = await session.page.evaluate(() => globalThis.__BACKLIGHT_BUDGET_WINDOWS__);
  const adapter = await session.page.evaluate(async () => {
    const a = await navigator.gpu.requestAdapter();
    return a?.info && { vendor: a.info.vendor, architecture: a.info.architecture };
  });
  if (adapter?.vendor !== "nvidia" || adapter.architecture !== "turing")
    throw new Error(`Unqualified adapter ${JSON.stringify(adapter)}`);
  // Report does not expose compilation completion; this is only a bounded startup discard.
  const steady = windows.filter((w) => w.window > 2);
  if (
    steady.length < 3 ||
    steady.some(
      (w) =>
        w.frames !== 60 ||
        !Number.isInteger(w.gpu?.samples) ||
        w.gpu.samples <= 0 ||
        w.surface?.resolutionScale !== 1 ||
        w.surface?.sampleCount !== 4 ||
        !Number.isFinite(w.gpuMs) ||
        w.gpuMs <= 0 ||
        w.surface?.drawingBufferWidth !== 1280 ||
        w.surface?.drawingBufferHeight !== 720,
    )
  )
    throw new Error(`Unqualified timing windows ${JSON.stringify(steady)}`);
  if (errors.length) throw new Error(`Runtime errors ${JSON.stringify(errors)}`);
  await mkdir(out, { recursive: true });
  await writeFile(
    `${out}/windows.json`,
    JSON.stringify(
      {
        arm,
        view,
        adapter,
        provenance: session.provenance,
        windows,
        steady,
        qualification: "actual engine timestamp windows; private-display fps is not claimed",
      },
      null,
      2,
    ),
  );
  await session.screenshot("steady");
  console.log(JSON.stringify({ arm, view, steady }));
});
