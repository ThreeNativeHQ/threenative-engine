/**
 * ThreeNative side of the startup benchmark against Unreal (the Unreal side is tools/unreal-reference's launch log).
 *
 *   pnpm tsx scripts/unreal-look/startup-bench.ts --out <dir> [--layer L9] [--sun 60,25] [--runs cold,warm,warm]
 *
 * Starts the dev server of the PRD-631 scaffold, loads the reference page once per run in a headed WebGPU
 * Chromium and writes one JSON per run. Times are milliseconds since the page navigation started, read inside the
 * page (performance.now), so the driver's own work is not in them:
 *   scriptStart    the first script ran            ready     data-threenative-startup="ready" (scene entered, GI baked)
 *   giBakeMs       TN_GI_CACHE milliseconds        frame1    the first presented frame after ready
 *   frame60        the 60th presented frame after ready
 * `cold` clears the dev server's dependency cache and uses a fresh browser profile; `warm` reuses both.
 * Hold the capture lock for the whole run, as for any GPU capture.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { WEBGPU_BROWSER_ARGS } from "../../packages/playtest/src/runner/browser.js";
import { assertVisualPortAvailable, stopVisualServer } from "../visual-gate.js";
import { HIDE_UI, freePort, scaffold, waitForServer } from "./capture-threenative.js";

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};

// Runs in the page before any script: timestamps of the first frames after the scene is ready.
const PROBE = `(() => {
  const t = { frames: [], ready: null, scriptStart: performance.now() };
  window.__tnStartup = t;
  const watch = new MutationObserver(() => {
    if (t.ready === null && document.querySelector('[data-threenative-startup="ready"]')) t.ready = performance.now();
  });
  watch.observe(document, { attributes: true, childList: true, subtree: true });
  const tick = () => {
    if (t.ready !== null && t.frames.length < 61) t.frames.push(performance.now());
    if (t.frames.length < 61) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function main(): Promise<void> {
  const out = path.resolve(flag("--out", "startup-bench"));
  const layer = flag("--layer", "L9");
  const sun = flag("--sun", "60,25");
  const runs = flag("--runs", "cold,warm,warm").split(",");
  const work = process.env.TN_UNREAL_LOOK_WORK;
  if (work === undefined) throw new Error("TN_UNREAL_LOOK_WORK: set a work directory of your own");
  const target = await scaffold(work, true, false);
  await mkdir(out, { recursive: true });
  const port = await freePort();
  await assertVisualPortAvailable(port);
  const server = spawn(
    "pnpm",
    ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"],
    { cwd: target, detached: true, stdio: ["ignore", "inherit", "inherit"] },
  );
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await waitForServer(origin, server);
    let browser = await chromium.launch({ args: [...WEBGPU_BROWSER_ARGS], headless: false });
    for (const [index, kind] of runs.entries()) {
      if (kind === "cold") {
        await browser.close();
        // The dev server's pre-bundled dependencies are part of a cold start.
        await rm(path.join(target, "node_modules/.vite"), { recursive: true, force: true });
        browser = await chromium.launch({ args: [...WEBGPU_BROWSER_ARGS], headless: false });
      }
      const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      await page.addInitScript(PROBE);
      const markers: { atMs: number; text: string }[] = [];
      const begin = Date.now();
      page.on("console", (message) => {
        if (
          /^(TN_GI_CACHE|TN_REFLECTION_CAPTURE|GPU sky|CPU environment sky|TN_AUTO_EXPOSURE)/.test(
            message.text(),
          )
        )
          markers.push({ atMs: Date.now() - begin, text: message.text().slice(0, 600) });
      });
      const load = `${origin}?tnRef=${layer}&sun=${sun}${process.env.TN_UNREAL_LOOK_QUERY ?? ""}`;
      const load0 = Date.now();
      await page.goto(load, { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: HIDE_UI });
      await page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 900_000 });
      await page.waitForFunction("window.__tnStartup.frames.length >= 61", undefined, {
        timeout: 120_000,
      });
      const marks = (await page.evaluate("window.__tnStartup")) as {
        frames: number[];
        ready: number;
        scriptStart: number;
      };
      const gi = markers.find((m) => m.text.startsWith("TN_GI_CACHE"));
      const result = {
        label: `${kind}${index + 1}`,
        kind,
        layer,
        sun,
        load: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3),
        navigationToScriptMs: Math.round(marks.scriptStart),
        readyMs: Math.round(marks.ready),
        frame1Ms: Math.round(marks.frames[0] ?? Number.NaN),
        frame60Ms: Math.round(marks.frames[60] ?? Number.NaN),
        giCache: gi === undefined ? null : JSON.parse(gi.text.replace(/^TN_GI_CACHE /, "")),
        markers,
        startedAt: new Date(load0).toISOString(),
      };
      await writeFile(
        path.join(out, `${result.label}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      console.info(`TN_STARTUP ${JSON.stringify({ ...result, markers: undefined })}`);
      await page.close();
    }
    await browser.close();
  } finally {
    await stopVisualServer(server);
  }
}

await main();
