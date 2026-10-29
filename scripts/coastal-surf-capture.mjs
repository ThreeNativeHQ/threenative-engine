// PRD-766: photograph the coastal sea from the shore, headed, on a real GPU, so two builds can be
// compared at the same three poses.
//
// The Strata preview's own benchmark framings look out to sea, inland, or down from a hillside; a
// breaker is a 1 m crest in the last 40 m of water, so these poses stand in it. Each page is pinned
// with `__TN_STRATA_CAM` (the global `examples/strata-terrain-preview/src/game.ts` honours) so the
// camera is the same pose on every build, and the label the run was given is drawn over the frame
// before the shutter.
//
// usage: node coastal-surf-capture.mjs --label <BEFORE|AFTER> --url <url> --out <dir>
//          [--poses beach,oblique,above] [--runs 2] [--settle 12000] [--width 1600] [--height 900]
// Every frame records its adapter and the engine's own `TN_FRAME_BUDGET` presented p95 over the
// window it was taken in: a software adapter's picture is not evidence, and a frame either pays for
// the breakers or it does not.
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = createRequire(`${root}/packages/playtest/package.json`)("playwright");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};
const label = option("label");
const url = option("url");
const out = option("out");
if (!/^(BEFORE|AFTER)/u.test(label ?? "") || !url || !out)
  throw new Error("usage: --label <BEFORE|AFTER> --url <url> --out <dir>");
const runs = Number(option("runs", "2"));
const settle = Number(option("settle", "12000"));
const width = Number(option("width", "1600"));
const height = Number(option("height", "900"));
const wanted = option("poses", "beach,oblique,above").split(",");

// [camera x, y, z, target x, y, z], in the coastal world's metres. The beach runs east-west at
// z = 148, open water to the south; the ground rises to the north.
const POSES = {
  // Standing on the sand a few metres above the waterline, looking out over the surf zone.
  beach: [110, 4.4, 140, 130, 1.5, 190],
  // Out over the water at the western end, looking east along the beach at the fronts arriving.
  oblique: [30, 7, 200, 240, 2, 165],
  // Over the coast from inland and 90 m up, so a whole shoreline of fronts is in one frame.
  above: [60, 90, 40, 180, 0, 170],
};

mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  headless: false,
  args: [
    "--ozone-platform=x11",
    "--enable-unsafe-webgpu",
    "--disable-gpu-sandbox",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
  ],
});
const report = {
  label,
  commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
  url,
  width,
  height,
  runs,
  settle,
  frames: [],
};
let failed = false;
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const name of wanted) {
      const pose = POSES[name];
      if (!pose) throw new Error(`unknown pose ${name}`);
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      let budget;
      page.on("console", (message) => {
        const text = message.text();
        if (message.type() === "error") errors.push(text);
        const marker = text.indexOf("TN_FRAME_BUDGET:{");
        if (marker < 0) return;
        try {
          budget = JSON.parse(text.slice(marker + "TN_FRAME_BUDGET:".length));
        } catch {
          errors.push(`unreadable frame budget: ${text.slice(marker, marker + 80)}`);
        }
      });
      page.on("pageerror", (error) => errors.push(`pageerror ${error.message}`));
      await page.addInitScript((value) => {
        globalThis.__TN_STRATA_CAM = value;
      }, pose);
      await page.goto(url, { waitUntil: "load", timeout: 120_000 });
      // The loading screen is a small frame; a rendered coastal scene is not.
      const started = Date.now();
      for (let loaded = false; !loaded && Date.now() - started < 240_000; ) {
        await page.waitForTimeout(5_000);
        loaded = (await page.screenshot()).length > 150_000;
      }
      const loadSeconds = Math.round((Date.now() - started) / 1000);
      const adapter = await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        return a
          ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device }
          : null;
      });
      await page.waitForTimeout(settle);
      // Large, unmissable, and out of the picture's way: top-left over sky or sand.
      await page.evaluate((text) => {
        const stamp = document.createElement("div");
        stamp.textContent = text;
        stamp.style.cssText =
          "position:fixed;left:28px;top:18px;z-index:2147483647;font:700 84px/1 system-ui,sans-serif;" +
          "color:#fff;text-shadow:0 0 10px #000,0 0 26px #000;letter-spacing:2px;pointer-events:none";
        document.body.append(stamp);
      }, `${label} ${name}`);
      const file = `${label.toLowerCase()}-${name}-run${run}.png`;
      const png = await page.screenshot({ path: `${out}/${file}`, type: "png" });
      if (png.length < 150_000) failed = true;
      report.frames.push({
        file,
        pose: pose.join(","),
        run,
        loadSeconds,
        adapter,
        presentedP50: budget?.presented?.p50 ?? null,
        presentedP95: budget?.presented?.p95 ?? null,
        windows: budget?.window ?? null,
        errors,
      });
      await page.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(`${out}/${label.toLowerCase()}-report.json`, JSON.stringify(report, null, 2));
}
const software = report.frames.some((frame) =>
  /swiftshader|llvmpipe|software/iu.test(JSON.stringify(frame.adapter)),
);
if (software) {
  console.error("TN_SURF_CAPTURE_SOFTWARE_ADAPTER: at least one frame ran on a software adapter.");
  process.exitCode = 1;
}
if (failed) {
  console.error("FAIL: at least one frame is blank or still on the loading screen.");
  process.exitCode = 1;
}
console.log(
  JSON.stringify({
    label,
    frames: report.frames.map((f) => [f.file, f.adapter?.architecture ?? null, f.presentedP95]),
  }),
);
