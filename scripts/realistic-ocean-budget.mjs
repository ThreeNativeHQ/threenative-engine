// Collect the engine's own TN_FRAME_BUDGET windows (CPU phases and GPU time) from a served build, headed,
// on a real GPU, at 1920x1080. Both arms, interleaved, the same pose (the game's own start).
// usage: node realistic-ocean-budget.mjs --incumbent <url> --realistic <url> --out <file.json> [--runs 3] [--seconds 40]
import { writeFileSync } from "node:fs";
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
const arms = { incumbent: option("incumbent"), realistic: option("realistic") };
const out = option("out");
if (!arms.incumbent || !arms.realistic || !out)
  throw new Error("usage: --incumbent <url> --realistic <url> --out <file>");
const runs = Number(option("runs", "3"));
const seconds = Number(option("seconds", "40"));

const browser = await chromium.launch({
  headless: false,
  args: [
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--enable-features=Vulkan",
    "--use-angle=vulkan",
  ],
});
const result = { viewport: [1920, 1080], seconds, runs: [] };
try {
  for (let run = 1; run <= runs; run += 1) {
    for (const arm of ["incumbent", "realistic"]) {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      const lines = [];
      page.on("console", (m) => {
        const text = m.text();
        if (text.includes("TN_FRAME_BUDGET")) lines.push(text);
      });
      await page.goto(arms[arm], { waitUntil: "load", timeout: 120_000 });
      await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 120_000 });
      await page.waitForTimeout(seconds * 1000);
      const adapter = await page.evaluate(async () => {
        const a = await navigator.gpu?.requestAdapter();
        return a ? { vendor: a.info.vendor, architecture: a.info.architecture } : null;
      });
      result.runs.push({ arm, run, adapter, lines });
      await page.close();
    }
  }
} finally {
  await browser.close();
  writeFileSync(out, JSON.stringify(result, null, 2));
}
console.log(JSON.stringify(result.runs.map((r) => [r.arm, r.run, r.lines.length])));
