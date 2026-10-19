#!/usr/bin/env node
/**
 * Browser-oracle comparison for the native-css Core HUD corpus.
 *
 * For each fixture in `fixtures.mjs`: render it in pinned headless Chromium (the oracle) and in the
 * native CSS engine (the crate's `oracle` example, no GPU, no window), then compare
 *   - every element's border box: each edge must be within 1 CSS px (the PRD's bar), and
 *   - the full frame: luminance SSIM must be >= 0.99 (the PRD's target).
 * Both bars come from docs/PRDs/PRD-native-overlay-utility-styling.md and are not relaxed here;
 * a miss is reported by fixture, element and edge, never averaged away.
 *
 * `desktop.mjs` runs the same comparison with the real desktop host as the subject; both read the
 * tree numbering, the asset staging, the SSIM arithmetic and the bars from `shared.mjs`.
 *
 * Usage: node corpus/oracle.mjs [fixture-name ...]    Output: corpus/out/ (gitignored) + report.json
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { FIXTURES, FONT } from "./fixtures.mjs";
import {
  CHROMIUM_ARGS,
  EDGE_PX,
  FONT_FILES,
  IMAGE_FILES,
  SSIM_MIN,
  SSIM_MIN_GLYPHS,
  bar,
  edgeMisses,
  example,
  fontDir,
  here,
  imageDir,
  luminance,
  ops,
  renderChromiumFixture,
  ssim,
} from "./shared.mjs";

const crate = join(example, "..", "..", "packages", "runtime-native", "native", "css-ui");
const out = join(here, "out");

const only = process.argv.slice(2);
const fixtures = FIXTURES.filter((f) => only.length === 0 || only.includes(f.name));
if (fixtures.length === 0)
  throw new Error("TN_ORACLE_NO_FIXTURE: no fixture matches the names given");

rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: CHROMIUM_ARGS });
const report = [];
const browserVersion = browser.version();
try {
  for (const fixture of fixtures) {
    const [width, height] = fixture.size;
    const dir = join(out, fixture.name);
    mkdirSync(dir, { recursive: true });
    const { boxes: expected, count } = await renderChromiumFixture(browser, fixture, dir, FONT);

    // Subject: the native CSS engine.
    writeFileSync(join(dir, "batch.json"), JSON.stringify(ops(fixture, count, FONT)));
    const run = spawnSync(
      "cargo",
      [
        "run",
        "--release",
        "--quiet",
        "--example",
        "oracle",
        "--",
        dir,
        String(width),
        String(height),
        String(fixture.dpr ?? 1),
      ],
      { cwd: crate, encoding: "utf8" },
    );
    if (run.status !== 0) {
      report.push({
        name: fixture.name,
        error: `native render failed: ${(run.stderr || run.stdout).trim().slice(0, 600)}`,
      });
      continue;
    }
    const nativeRects = JSON.parse(readFileSync(join(dir, "rects.json"), "utf8"));
    const rgba = readFileSync(join(dir, "frame.rgba"));
    const dpr = fixture.dpr ?? 1;
    const native = new PNG({ width: width * dpr, height: height * dpr });
    rgba.copy(native.data);
    writeFileSync(join(dir, "native.png"), PNG.sync.write(native));

    const misses = edgeMisses(expected, nativeRects);
    const chrome = PNG.sync.read(readFileSync(join(dir, "chrome.png")));
    const score = ssim(luminance(chrome), luminance(native), width * dpr, height * dpr);
    report.push({
      name: fixture.name,
      boxes: expected.length,
      edgeMisses: misses,
      ssim: Number(score.toFixed(4)),
      ssimMin: bar(fixture),
      pass: misses.length === 0 && score >= bar(fixture),
    });
  }
} finally {
  await browser.close();
}

writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
// What the PRD asks a reference capture to record: exact sources, hashes, tool and platform versions.
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");
const manifest = {
  chromium: browserVersion,
  chromiumArgs: CHROMIUM_ARGS,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  thresholds: { edgePx: EDGE_PX, ssim: SSIM_MIN, ssimGlyphs: SSIM_MIN_GLYPHS },
  fonts: Object.fromEntries(FONT_FILES.map((f) => [f, sha(readFileSync(join(fontDir, f)))])),
  images: Object.fromEntries(IMAGE_FILES.map((f) => [f, sha(readFileSync(join(imageDir, f)))])),
  fixtures: Object.fromEntries(
    fixtures.map((f) => [
      f.name,
      { size: f.size, dpr: f.dpr ?? 1, source: sha(JSON.stringify([f.css, f.tree])) },
    ]),
  ),
};
writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const r of report) {
  if (r.error) console.log(`ERROR ${r.name}: ${r.error}`);
  else
    console.log(
      `${r.pass ? "PASS " : "FAIL "} ${r.name}  boxes=${r.boxes} edgeMisses=${r.edgeMisses.length} ssim=${r.ssim}`,
    );
}
const failed = report.filter((r) => r.error || !r.pass);
console.log(
  `${report.length - failed.length}/${report.length} fixtures within 1px edges and SSIM >= ${SSIM_MIN}`,
);
process.exit(failed.length === 0 ? 0 : 1);
