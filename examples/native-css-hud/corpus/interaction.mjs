#!/usr/bin/env node
/**
 * Interaction oracle for the native-css Core HUD profile (see interactions.mjs for the script
 * grammar). Chromium runs each scenario to produce the expected observations; the engine's
 * `interact` example runs the same script and must produce the same list:
 *   focus / clicks / scroll offsets — exactly equal;
 *   pixels — within 3 per channel (colour interpolation rounding), both sides over #18181b.
 * Time is virtual on both sides (`advance`): Chromium's animations are paused and seeked, never waited.
 *
 * Usage: node corpus/interaction.mjs [scenario-name ...]    Output: corpus/out-interaction/
 */
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { PNG } from "pngjs";
import { INTERACTIONS } from "./interactions.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(
  resolve(here, "..", "..", ".."),
  "packages",
  "runtime-native",
  "native",
  "css-ui",
);
const fontDir = join(resolve(here, ".."), "src", "ui", "fonts");
// Same staging rule as the oracle: an asset a scenario names is copied flat into both the
// Chromium page directory and the native `ui` directory, so both sides resolve the same path.
const imageDir = join(resolve(here, ".."), "src", "ui", "images");
const IMAGE_FILES = existsSync(imageDir)
  ? readdirSync(imageDir).filter((f) => f.endsWith(".png"))
  : [];
const out = join(here, "out-interaction");
const PIXEL_TOLERANCE = 3;

const only = process.argv.slice(2);
const scenarios = INTERACTIONS.filter((s) => only.length === 0 || only.includes(s.name));
if (scenarios.length === 0)
  throw new Error("TN_INTERACTION_NO_SCENARIO: no scenario matches the names given");

function number(tree) {
  let n = 0;
  const walk = (node) => {
    if (node.text !== undefined) return;
    node.n = ++n;
    for (const child of node.children) walk(child);
  };
  for (const root of tree) walk(root);
  return n;
}
const esc = (s) =>
  s.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
function html(node) {
  if (node.text !== undefined) return esc(node.text);
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => (v === "" ? ` ${k}` : ` ${k}="${esc(v)}"`))
    .join("");
  return `<${node.tag} data-n="${node.n}"${attrs}>${node.children.map(html).join("")}</${node.tag}>`;
}
function ops(scenario, elementCount) {
  const list = [{ op: "sheet", key: "scenario", css: scenario.css }];
  let textId = elementCount;
  const walk = (node, parent) => {
    if (node.text !== undefined) {
      const id = ++textId;
      list.push({ op: "text", id, text: node.text }, { op: "append", parent, child: id });
      return;
    }
    list.push({ op: "create", id: node.n, tag: node.tag });
    for (const [name, value] of Object.entries(node.attrs))
      list.push({ op: "attr", id: node.n, name, value });
    list.push({ op: "append", parent, child: node.n });
    for (const child of node.children) walk(child, node.n);
  };
  for (const node of scenario.tree) walk(node, 0);
  for (const id of scenario.listen ?? []) list.push({ op: "listen", id, event: "click" });
  return { ops: list };
}

const frame = (page) =>
  page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

async function runChromium(browser, scenario, dir) {
  const [width, height] = scenario.size;
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    ...(scenario.touch ? { hasTouch: true, isMobile: true } : {}),
  });
  const page = await context.newPage();
  await page.goto(`file://${join(dir, "page.html")}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.__clicks = [];
    for (const n of window.__listen) {
      document
        .querySelector(`[data-n="${n}"]`)
        .addEventListener("click", () => window.__clicks.push(n));
    }
    window.__seen = new WeakSet();
    window.__t = new WeakMap();
  });
  const seek = (ms) =>
    page.evaluate((delta) => {
      for (const a of document.getAnimations()) {
        if (!window.__seen.has(a)) {
          window.__seen.add(a);
          a.pause();
          window.__t.set(a, 0);
          a.currentTime = 0;
        }
        const next = window.__t.get(a) + delta;
        window.__t.set(a, next);
        a.currentTime = next;
      }
    }, ms);
  const observations = [];
  for (const step of scenario.script) {
    if (step.obs === "focus") {
      observations.push(await page.evaluate(() => Number(document.activeElement?.dataset?.n ?? 0)));
    } else if (step.obs === "clicks") {
      observations.push(await page.evaluate(() => [...window.__clicks]));
    } else if (step.obs === "scroll") {
      observations.push(
        await page.evaluate((n) => {
          const el = document.querySelector(`[data-n="${n}"]`);
          return [el.scrollLeft, el.scrollTop];
        }, step.n),
      );
    } else if (step.obs === "pixel") {
      const shot = PNG.sync.read(
        await page.screenshot({ clip: { x: step.x, y: step.y, width: 1, height: 1 } }),
      );
      observations.push([shot.data[0], shot.data[1], shot.data[2]]);
    } else if (step.t === "key") {
      const key = step.key === " " ? "Space" : step.key;
      await page.keyboard.press(step.shift ? `Shift+${key}` : key);
      await frame(page);
    } else if (step.t === "pointer") {
      if (step.pointerType === "touch") {
        if (step.type === "down") await page.touchscreen.tap(step.x, step.y); // down+up in one gesture
      } else if (step.type === "move") await page.mouse.move(step.x, step.y);
      else if (step.type === "down") {
        await page.mouse.move(step.x, step.y);
        await page.mouse.down();
      } else if (step.type === "up") await page.mouse.up();
      await frame(page);
      await seek(0);
    } else if (step.t === "wheel") {
      await page.mouse.move(step.x, step.y);
      await page.mouse.wheel(step.dx ?? 0, step.dy);
      await frame(page);
    } else if (step.t === "advance") {
      await seek(step.ms);
      await frame(page);
    } else if (step.t === "env") {
      await page.emulateMedia({
        ...(step.dark !== undefined ? { colorScheme: step.dark ? "dark" : "light" } : {}),
        ...(step.reducedMotion !== undefined
          ? { reducedMotion: step.reducedMotion ? "reduce" : "no-preference" }
          : {}),
      });
      await frame(page);
    }
  }
  await context.close();
  return observations;
}

rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  args: ["--font-render-hinting=none", "--disable-smooth-scrolling"],
});
const results = [];
try {
  for (const scenario of scenarios) {
    const dir = join(out, scenario.name);
    mkdirSync(join(dir, "ui"), { recursive: true });
    for (const font of ["NotoSans-Regular.ttf", "NotoSans-Bold.ttf"]) {
      copyFileSync(join(fontDir, font), join(dir, "ui", font));
      copyFileSync(join(fontDir, font), join(dir, font));
    }
    for (const image of IMAGE_FILES) {
      copyFileSync(join(imageDir, image), join(dir, "ui", image));
      copyFileSync(join(imageDir, image), join(dir, image));
    }
    const FONT =
      "@font-face{font-family:Noto;font-weight:400;src:url(NotoSans-Regular.ttf)}@font-face{font-family:Noto;font-weight:700;src:url(NotoSans-Bold.ttf)}";
    const count = number(scenario.tree);
    const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>${FONT}${scenario.css}</style></head><body>${scenario.tree.map(html).join("")}<script>window.__listen=${JSON.stringify(scenario.listen ?? [])}</script></body></html>`;
    writeFileSync(join(dir, "page.html"), page);
    const expected = await runChromium(browser, scenario, dir);
    if (process.env.CHROMIUM_ONLY) {
      console.log(scenario.name, JSON.stringify(expected));
      // Counted like any other result, so the summary line is not "0/0" when only the expected
      // values were asked for.
      results.push({
        name: scenario.name,
        observations: expected.length,
        mismatches: [],
        pass: true,
      });
      continue;
    }

    const withFont = ops(scenario, count);
    withFont.ops[0].css = FONT + withFont.ops[0].css;
    writeFileSync(join(dir, "batch.json"), JSON.stringify(withFont));
    writeFileSync(join(dir, "script.json"), JSON.stringify(scenario.script));
    // The device Chromium is given as `hasTouch` above is a fact about the run, not a step in
    // it, so it travels beside the script: the engine is told the pointer is a finger, which is
    // what makes `(hover: none)` match here and `(hover: hover)` stop matching.
    writeFileSync(join(dir, "env.json"), JSON.stringify({ touch: scenario.touch === true }));
    const run = spawnSync(
      "cargo",
      [
        "run",
        "--release",
        "--quiet",
        "--example",
        "interact",
        "--",
        dir,
        String(scenario.size[0]),
        String(scenario.size[1]),
      ],
      { cwd: crate, encoding: "utf8" },
    );
    if (run.status !== 0) {
      results.push({
        name: scenario.name,
        error: `native run failed: ${(run.stderr || run.stdout).trim().slice(0, 500)}`,
        expected,
      });
      continue;
    }
    const actual = JSON.parse(readFileSync(join(dir, "obs.json"), "utf8"));
    const observed = scenario.script.filter((s) => s.obs);
    const mismatches = [];
    for (const [i, step] of observed.entries()) {
      const a = actual[i];
      const e = expected[i];
      const same =
        step.obs === "pixel"
          ? Array.isArray(a) && a.every((v, k) => Math.abs(v - e[k]) <= PIXEL_TOLERANCE)
          : JSON.stringify(a) === JSON.stringify(e);
      if (!same) mismatches.push({ index: i, obs: step, expected: e, actual: a });
    }
    results.push({
      name: scenario.name,
      observations: observed.length,
      mismatches,
      pass: mismatches.length === 0 && actual.length === expected.length,
    });
  }
} finally {
  await browser.close();
}
writeFileSync(join(out, "report.json"), JSON.stringify(results, null, 2));
for (const r of results) {
  if (r.error) console.log(`ERROR ${r.name}: ${r.error}`);
  else
    console.log(
      `${r.pass ? "PASS " : "FAIL "} ${r.name}  observations=${r.observations} mismatches=${r.mismatches.length}`,
    );
}
const failed = results.filter((r) => r.error || !r.pass);
console.log(
  `${results.length - failed.length}/${results.length} interaction scenarios match Chromium`,
);
process.exit(failed.length === 0 ? 0 : 1);
