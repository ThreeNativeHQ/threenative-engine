// Capture the PRD-648 comparison frames, headed, on a real GPU. Three arms, the same four views:
//   incumbent  the sailing kit's own sea (served build of sailing-incumbent)
//   realistic  the same kit with the opt-in bundle adopted (sailing-realistic)
//   upstream   Noniv/web-ocean's ocean.html at the pinned commit, as its README poses them
// usage: node realistic-ocean-capture.mjs --arm <incumbent|realistic|upstream> --url <url> --out <dir>
//          [--runs 2] [--poses low,oblique,elevated] [--width 1280] [--height 720] [--hide <css selector>]
// Every frame records the adapter it ran on: a software adapter's picture is not evidence.
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
const arm = option("arm");
const url = option("url");
const out = option("out");
if (!["incumbent", "realistic", "upstream"].includes(arm) || !url || !out)
  throw new Error("usage: --arm <incumbent|realistic|upstream> --url <url> --out <dir>");
const runs = Number(option("runs", "2"));
const width = Number(option("width", "1280"));
const height = Number(option("height", "720"));
const hide = option("hide", "");
const wanted = option("poses", "low,oblique,elevated,sunpath").split(",");

// web-ocean's README views: 2.4 m looking toward the sun, 75 degrees off it at 2.4 m, 30 m up
// looking toward the sun. `yaw` is degrees from the sun's bearing; pitch is degrees, down negative.
const POSES = {
  low: { x: 0, y: 2.4, z: 0, yaw: 0, pitch: 4 },
  oblique: { x: 0, y: 2.4, z: 0, yaw: 75, pitch: 4 },
  elevated: { x: 0, y: 30, z: 0, yaw: 0, pitch: -10 },
  // Aimed where the sailing sky's sun (48 degrees up) reflects: the glitter path and backlit crests.
  sunpath: { x: 0, y: 2.4, z: 0, yaw: 0, pitch: -40 },
};
// web-ocean's own camera is `x,y,z,yawDeg,pitchDeg`, yaw measured from +Z; its default sun is
// near yaw 0. Passed through unchanged, so the frames are the ones its README documents.
const UPSTREAM = {
  low: "0,2.4,0,0,3",
  oblique: "0,2.4,0,75,3",
  elevated: "0,30,0,0,-10",
  // web-ocean's own low sun is already on the horizon in its low view.
  sunpath: "0,2.4,0,0,-3",
};

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
const report = { arm, url, width, height, runs, frames: [] };
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const name of wanted) {
      const pose = POSES[name];
      if (!pose) throw new Error(`unknown pose ${name}`);
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
      page.on("pageerror", (e) => errors.push(`pageerror ${e.message}`));
      if (arm === "upstream") {
        const target = new URL(url);
        target.searchParams.set("cam", UPSTREAM[name]);
        target.searchParams.set("ui", "0");
        target.searchParams.set("w", String(width));
        target.searchParams.set("h", String(height));
        await page.goto(target.toString(), { waitUntil: "load", timeout: 120_000 });
        await page.waitForTimeout(9_000);
      } else {
        await page.addInitScript((value) => {
          globalThis.__TN_OCEAN_POSE = value;
        }, pose);
        await page.goto(url, { waitUntil: "load", timeout: 120_000 });
        await page.waitForSelector("canvas", { timeout: 60_000 });
        await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 120_000 });
        if (hide) await page.addStyleTag({ content: `${hide}{display:none !important}` });
        await page.waitForTimeout(6_000);
      }
      const adapter = await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        return a
          ? { vendor: a.info.vendor, architecture: a.info.architecture, device: a.info.device }
          : null;
      });
      const file = `${arm}-${name}-run${run}.png`;
      await page.screenshot({ path: `${out}/${file}`, type: "png" });
      report.frames.push({ file, pose: name, run, adapter, errors });
      await page.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(`${out}/${arm}-report.json`, JSON.stringify(report, null, 2));
}
const software = report.frames.some(
  (frame) => !frame.adapter || /swiftshader|llvmpipe|software/i.test(JSON.stringify(frame.adapter)),
);
if (software) {
  console.error("TN_OCEAN_CAPTURE_SOFTWARE_ADAPTER: at least one frame ran on a software adapter.");
  process.exitCode = 1;
}
console.log(JSON.stringify({ arm, frames: report.frames.map((f) => [f.file, f.adapter]) }));
