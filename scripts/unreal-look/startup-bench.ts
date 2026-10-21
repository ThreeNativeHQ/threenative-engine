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
 *   firstFrame     the first animation frame of the page; longestFrameGap the longest wait between two frames until giConverged
 *   --model <folder> [--shots] [--pose <json>]  a calibration scene lit by the reference, and a screenshot of one pose once converged
 *   giConverged    the full GI bake landed (window.__tnRef.giConverged); equals ready when the bake is not progressive
 * `cold` clears the dev server's dependency cache and uses a fresh browser profile; `warm` reuses both.
 * Hold the capture lock for the whole run, as for any GPU capture.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";
import { WEBGPU_BROWSER_ARGS } from "../../packages/playtest/src/runner/browser.js";
import { assertVisualPortAvailable, stopVisualServer } from "../visual-gate.js";
import { HIDE_UI, freePort, scaffold, waitForServer } from "./capture-threenative.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};

// Runs in the page before any script: timestamps of the first frames after the scene is ready.
const PROBE = `(() => {
  const t = { frames: [], ready: null, converged: null, scriptStart: performance.now(), longTasks: [], gaps: [], firstFrame: null };
  window.__tnStartup = t;
  // Main-thread stalls: every task over 50 ms, and the longest gap between two animation frames until the GI converges.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) t.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  let last = null;
  const watch = new MutationObserver(() => {
    if (t.ready === null && document.querySelector('[data-threenative-startup="ready"]')) t.ready = performance.now();
  });
  watch.observe(document, { attributes: true, childList: true, subtree: true });
  const tick = () => {
    const now = performance.now();
    if (t.firstFrame === null) t.firstFrame = now;
    if (t.converged === null && last !== null) t.gaps.push([Math.round(last), Math.round(now - last)]);
    last = now;
    if (t.ready !== null && t.frames.length < 61) t.frames.push(performance.now());
    if (t.converged === null && window.__tnRef && window.__tnRef.giConverged === true) t.converged = performance.now();
    if (t.frames.length < 61 || t.converged === null) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

async function main(): Promise<void> {
  const out = path.resolve(flag("--out", "startup-bench"));
  const layer = flag("--layer", "L9");
  const sun = flag("--sun", "60,25");
  const runs = flag("--runs", "cold,warm,warm").split(",");
  const model = flag("--model", "");
  // `--executable <path>`: another Chromium (the owner's Brave) instead of the bundled one.
  const executable = flag("--executable", "");
  const shots = process.argv.includes("--shots") ? true : undefined;
  const pose = flag(
    "--pose",
    '{"name":"sun15-window","position":[0,1.5,-5.5],"target":[0,1.2,0],"hfovDeg":90}',
  );
  const work = process.env.TN_UNREAL_LOOK_WORK;
  if (work === undefined) throw new Error("TN_UNREAL_LOOK_WORK: set a work directory of your own");
  const target = await scaffold(work, true, false);
  if (process.argv.includes("--no-compact")) {
    // The GI capture's setting: the cook keeps each mesh as it is authored, with no joining and no instancing.
    const config = path.join(target, "threenative.config.ts");
    const source = readFileSync(config, "utf8");
    const anchor = '  nativeEntry: "src/game.ts",';
    if (!source.includes("compact: false")) {
      if (!source.includes(anchor))
        throw new Error(`TN_STARTUP_BENCH: '${anchor}' not in ${config}`);
      await writeFile(
        config,
        source.replace(anchor, `${anchor}\n  assets: { models: { compact: false } },`),
      );
    }
  }
  if (model !== "") {
    // `model=<folder>` loads a calibration scene's glb: it has to be an asset before the dev server lists them.
    const to = path.join(target, "assets/unreal-reference/gi", model);
    await mkdir(to, { recursive: true });
    await cp(
      path.join(REPO_ROOT, "tools/unreal-reference/gi", model, "scene.glb"),
      path.join(to, "scene.glb"),
    );
  }
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
    let browser = await chromium.launch({
      args: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      ...(executable === "" ? {} : { executablePath: executable }),
    });
    for (const [index, kind] of runs.entries()) {
      if (kind === "cold") {
        await browser.close();
        // The dev server's pre-bundled dependencies are part of a cold start.
        await rm(path.join(target, "node_modules/.vite"), { recursive: true, force: true });
        browser = await chromium.launch({
          args: [...WEBGPU_BROWSER_ARGS],
          headless: false,
          ...(executable === "" ? {} : { executablePath: executable }),
        });
      }
      const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      await page.addInitScript(PROBE);
      // At document start, so a page that reloads (a dev server re-optimising its dependencies) is still hidden.
      await page.addInitScript(
        `document.documentElement.appendChild(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(HIDE_UI)} }));`,
      );
      const markers: { atMs: number; text: string }[] = [];
      const begin = Date.now();
      let failed: string | undefined;
      // A page that never reaches ready says why on its own console: echo errors as they happen.
      page.on("pageerror", (error) =>
        console.error(`PAGE_ERROR +${Date.now() - begin} ms ${error.message.slice(0, 400)}`),
      );
      page.on("console", (message) => {
        if (message.type() === "error" && !message.text().startsWith("Failed to load resource"))
          console.error(
            `PAGE_CONSOLE_ERROR +${Date.now() - begin} ms ${message.text().slice(0, 400)}`,
          );
        if (/TN_START_FAILED|TN_WASM_RENDERER_LOST/.test(message.text()))
          failed = message.text().slice(0, 400);
        if (
          /^(TN_GI_CACHE|TN_GI_STOCK_RAYS|TN_REFLECTION_CAPTURE|GPU sky|CPU environment sky|TN_AUTO_EXPOSURE|TN_STARTUP_WARMUP|TN_FRAME_HITCH|TN_WARMUP)/.test(
            message.text(),
          )
        )
          markers.push({ atMs: Date.now() - begin, text: message.text().slice(0, 600) });
      });
      const load = `${origin}?tnRef=${layer}&sun=${sun}${model === "" ? "" : `&model=${model}`}${process.env.TN_UNREAL_LOOK_QUERY ?? ""}`;
      // `--profile`: a Chrome CPU profile of the load, up to the ready marker, for the table of what the main thread did.
      const cdp = process.argv.includes("--profile")
        ? await page.context().newCDPSession(page)
        : undefined;
      if (cdp !== undefined) {
        await cdp.send("Profiler.enable");
        await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
        await cdp.send("Profiler.start");
      }
      const load0 = Date.now();
      await page.goto(load, { waitUntil: "domcontentloaded" });
      // A start that failed (or a lost GPU device, which a shared GPU makes common) never sets the marker: stop on the page's own report instead of the timeout.
      await Promise.race([
        page.waitForSelector('[data-threenative-startup="ready"]', { timeout: 900_000 }),
        (async () => {
          while (failed === undefined) await page.waitForTimeout(500);
          throw new Error(failed);
        })(),
      ]);
      await page.waitForFunction(
        "window.__tnStartup.frames.length >= 61 && window.__tnStartup.converged !== null",
        undefined,
        { timeout: 900_000 },
      );
      const marks = (await page.evaluate("window.__tnStartup")) as {
        frames: number[];
        ready: number;
        converged: number;
        scriptStart: number;
        firstFrame: number;
        longTasks: [number, number][];
        gaps: [number, number][];
      };
      if (shots !== undefined) {
        await page.evaluate(`window.__tnRef.pose(${pose})`);
        await page.evaluate(
          "new Promise((resolve) => { let n = 0; const tick = () => (++n >= 90 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })",
        );
        await page.screenshot({ path: path.join(out, `${kind}${index + 1}.png`) });
      }
      if (cdp !== undefined) {
        const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown };
        await writeFile(path.join(out, `${kind}${index + 1}.cpuprofile`), JSON.stringify(profile));
      }
      const adapter = (await page.evaluate(
        "navigator.gpu.requestAdapter().then((a) => ({ vendor: a.info.vendor, architecture: a.info.architecture, fallback: a.isFallbackAdapter }))",
      )) as { vendor: string; architecture: string; fallback: boolean };
      if (adapter.fallback || adapter.vendor !== "nvidia")
        throw new Error(
          `TN_STARTUP_BENCH_ADAPTER: ${JSON.stringify(adapter)} is not the NVIDIA GPU`,
        );
      const worst = (rows: [number, number][]) => rows.reduce((m, r) => Math.max(m, r[1]), 0);
      const gi = markers.find((m) => m.text.startsWith("TN_GI_CACHE"));
      const result = {
        label: `${kind}${index + 1}`,
        kind,
        layer,
        sun,
        adapter,
        load: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3),
        navigationToScriptMs: Math.round(marks.scriptStart),
        readyMs: Math.round(marks.ready),
        frame1Ms: Math.round(marks.frames[0] ?? Number.NaN),
        frame60Ms: Math.round(marks.frames[60] ?? Number.NaN),
        giConvergedMs: Math.round(marks.converged),
        firstFrameMs: Math.round(marks.firstFrame),
        // Until the GI converged: the longest task and the longest gap between two frames (a slice shows as a gap).
        longestTaskMs: worst(marks.longTasks),
        longestFrameGapMs: worst(marks.gaps),
        longTasks: marks.longTasks.slice(0, 200),
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
