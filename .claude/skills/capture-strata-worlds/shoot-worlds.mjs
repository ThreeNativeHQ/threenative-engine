// Capture the five Strata preview worlds from a served build, headed, on the real GPU.
// usage: node shoot-worlds.mjs <baseUrl> <outDir> [--worlds forest,coastal] [--repo <checkout the build came from>] [--allow-software]
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { chromium } = createRequire(`${root}/packages/playtest/package.json`)("playwright");

const [base, out, ...flags] = process.argv.slice(2);
if (!base || !out)
  throw new Error("usage: shoot-worlds.mjs <baseUrl> <outDir> [--worlds a,b] [--allow-software]");
const worldsFlag = flags.indexOf("--worlds");
const worlds =
  worldsFlag >= 0
    ? flags[worldsFlag + 1].split(",")
    : ["forest", "coastal", "alpine", "desert", "tundra"];
const repoFlag = flags.indexOf("--repo");
const repo = repoFlag >= 0 ? resolve(flags[repoFlag + 1]) : root; // the checkout whose build is served
const allowSoftware = flags.includes("--allow-software");

// Fixed on purpose: a comparison across runs needs the same viewport, views and settle time.
const VIEWPORT = { width: 1600, height: 900 };
const VIEWS = ["player", "meadow-close", "overview", "river"]; // KeyV cycles these in order
const SETTLE_MS = 4000;
const LOAD_TIMEOUT_MS = 240000;
const LOADED_BYTES = 150000; // the loading screen PNG is far smaller than a rendered scene

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
  ],
});
const report = {
  commit: execSync("git rev-parse --short HEAD", { cwd: repo }).toString().trim(),
  viewport: VIEWPORT,
  worlds: {},
};
let failed = false;
for (const world of worlds) {
  const page = await browser.newPage({ viewport: VIEWPORT });
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${r.url()}`));
  await page.goto(`${base}/?world=${world}`, { waitUntil: "load", timeout: 120000 });
  const adapter = await page.evaluate(async () => {
    const a = await navigator.gpu?.requestAdapter();
    return a
      ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device }
      : null;
  });
  if (
    !adapter ||
    (/swiftshader|llvmpipe|software/i.test(JSON.stringify(adapter)) && !allowSoftware)
  ) {
    throw new Error(
      `no real GPU adapter: ${JSON.stringify(adapter)} (pass --allow-software to accept)`,
    );
  }
  const t0 = Date.now();
  let loaded = false;
  while (!loaded && Date.now() - t0 < LOAD_TIMEOUT_MS) {
    await page.waitForTimeout(5000);
    loaded = (await page.screenshot()).length > LOADED_BYTES;
  }
  const loadSeconds = Math.round((Date.now() - t0) / 1000);
  await page.mouse.click(VIEWPORT.width / 2, VIEWPORT.height / 2).catch(() => {});
  const frames = {};
  for (const view of VIEWS) {
    await page.waitForTimeout(SETTLE_MS);
    const png = await page.screenshot({ path: `${out}/${world}-${view}.png` });
    frames[view] = png.length;
    if (png.length < LOADED_BYTES) failed = true; // blank or still loading
    await page.keyboard.press("KeyV");
  }
  report.worlds[world] = {
    adapter,
    loaded,
    loadSeconds,
    frameBytes: frames,
    errors: errors.slice(0, 20),
  };
  console.log(
    world,
    adapter.vendor,
    adapter.architecture,
    `load ${loadSeconds}s`,
    loaded ? "ok" : "NOT LOADED",
  );
  await page.close();
}
writeFileSync(`${out}/report.json`, JSON.stringify(report, null, 2));
await browser.close();
if (failed) {
  console.error(
    "FAIL: at least one frame is blank or still on the loading screen; see report.json",
  );
  process.exit(1);
}
