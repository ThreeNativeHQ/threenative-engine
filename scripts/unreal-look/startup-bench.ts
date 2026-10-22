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
 * Hold the capture lock for the whole run, as for any GPU capture. The browser opens on a private Xvfb (browser.ts);
 * a run that grabs the display (`--strip`) sets TN_PLAYTEST_HOST_DISPLAY=1 under gpu-slot.sh, so the grab and the page
 * share the slot's own display.
 */
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertVisualPortAvailable, stopVisualServer } from "../visual-gate.js";
import { launchWebgpuBrowser } from "./browser.js";
import { HIDE_UI, freePort, scaffold, waitForServer } from "./capture-threenative.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

const flag = (name: string, fallback: string): string => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
};

// Runs in the page before any script: timestamps of the first frames after the scene is ready.
const PROBE = `(() => {
  const t = { frames: [], ready: null, converged: null, scriptStart: performance.now(), longTasks: [], gaps: [], firstFrame: null, scene: null };
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
    // The scene has entered (the page publishes __tnRef at the end of enter): the first frame it draws is the next one.
    if (t.scene === null && window.__tnRef) t.scene = now;
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
  const startServer = () =>
    spawn("pnpm", ["dev", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
      cwd: target,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
    });
  let server = startServer();
  try {
    const origin = `http://127.0.0.1:${port}/`;
    await waitForServer(origin, server);
    let browser = await launchWebgpuBrowser();
    for (const [index, kind] of runs.entries()) {
      if (kind === "cold") {
        await browser.close();
        // The dev server's pre-bundled dependencies are part of a cold start. A server that is running keeps its
        // optimizer state in memory and serves nothing once the files are gone (a page that never loads): start it again.
        await stopVisualServer(server);
        await rm(path.join(target, "node_modules/.vite"), { recursive: true, force: true });
        server = startServer();
        await waitForServer(origin, server);
        browser = await launchWebgpuBrowser();
      }
      const page = await browser.newPage({
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
      });
      await page.addInitScript(PROBE);
      // At document start, so a page that reloads (a dev server re-optimising its dependencies) is still hidden.
      // The document element does not exist yet when the script runs on some navigations: wait for it.
      await page.addInitScript(
        `(() => {
          const hide = () => document.documentElement.appendChild(Object.assign(document.createElement("style"), { textContent: ${JSON.stringify(HIDE_UI)} }));
          if (document.documentElement) hide();
          else new MutationObserver((_, observer) => { if (document.documentElement) { observer.disconnect(); hide(); } }).observe(document, { childList: true });
        })();`,
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
      // `--strip 3,5,30,89`: a picture of the display at each of these seconds after the navigation, on the first
      // run of an arm. It is the X server's picture, not page.screenshot, so a page whose main thread is blocked
      // (the one-shot bake) shows what a viewer sees: its last painted frame. Needs a display of its own (Xvfb).
      const stripAt =
        flag("--strip", "") === "" || index > 0 ? [] : flag("--strip", "").split(",").map(Number);
      let viewport: string | undefined;
      if (stripAt.length > 0) {
        await page.goto("about:blank");
        const [x, y, w, h] = (await page.evaluate(
          "[screenX + (outerWidth - innerWidth) / 2, screenY + outerHeight - innerHeight, innerWidth, innerHeight]",
        )) as number[];
        viewport = `${w}x${h}+${Math.round(x as number)}+${Math.round(y as number)}`;
      }
      const load0 = Date.now();
      const strip = Promise.all(
        stripAt.map(async (second) => {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, load0 + second * 1000 - Date.now())),
          );
          await execFileAsync("import", [
            "-window",
            "root",
            "-crop",
            viewport as string,
            "+repage",
            path.join(out, `${kind}-strip-${String(second).padStart(3, "0")}s.png`),
          ]);
        }),
      );
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
        scene: number;
        longTasks: [number, number][];
        gaps: [number, number][];
      };
      await strip;
      // The auto exposure of the full look (L9) closes at 1 stop/s: a frame taken before it settled differs from another
      // arm's by the stops it still owes, not by the light. `settled` is the exposure pass's own word that it is there.
      const exposures = () => markers.filter((m) => m.text.startsWith("TN_AUTO_EXPOSURE:"));
      let exposureSettled: boolean | null = null;
      if (shots !== undefined) {
        await page.evaluate(`window.__tnRef.pose(${pose})`);
        const poseAt = Date.now() - begin;
        await page.evaluate(
          "new Promise((resolve) => { let n = 0; const tick = () => (++n >= 90 ? resolve() : requestAnimationFrame(tick)); requestAnimationFrame(tick); })",
        );
        if (exposures().at(-1)?.text.includes('"applied":true') === true) {
          const deadline = Date.now() + 240_000;
          // Three readings in a row after the pose: one right after it can still be the old view's.
          const settledNow = () => {
            const last = exposures()
              .filter((m) => m.atMs > poseAt)
              .slice(-3);
            return last.length === 3 && last.every((m) => m.text.includes('"settled":true'));
          };
          while (!settledNow() && Date.now() < deadline) await page.waitForTimeout(500);
          exposureSettled = settledNow();
        }
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
      // The engine's own milestones (load started, scene entered, compile settled, framework ready, ready), on the same
      // performance.now base as the numbers above. `null` when the page did not install the playtest bridge.
      const timeline = await page.evaluate(
        "(() => { const bridge = window.__THREENATIVE_PLAYTEST_BRIDGE__; return bridge?.ready().startup?.timeline ?? null; })()",
      );
      const worst = (rows: [number, number][]) => rows.reduce((m, r) => Math.max(m, r[1]), 0);
      const gis = markers.filter((m) => m.text.startsWith("TN_GI_CACHE"));
      const parse = (m: { text: string } | undefined) =>
        m === undefined ? null : JSON.parse(m.text.replace(/^TN_GI_CACHE /, ""));
      const result = {
        label: `${kind}${index + 1}`,
        kind,
        layer,
        sun,
        adapter,
        display: process.env.DISPLAY,
        query: process.env.TN_UNREAL_LOOK_QUERY ?? "",
        load: readFileSync("/proc/loadavg", "utf8").split(" ").slice(0, 3),
        navigationToScriptMs: Math.round(marks.scriptStart),
        readyMs: Math.round(marks.ready),
        frame1Ms: Math.round(marks.frames[0] ?? Number.NaN),
        frame60Ms: Math.round(marks.frames[60] ?? Number.NaN),
        giConvergedMs: Math.round(marks.converged),
        firstFrameMs: Math.round(marks.firstFrame),
        sceneMs: Math.round(marks.scene),
        timeline,
        // Until the GI converged: the longest task and the longest gap between two frames (a slice shows as a gap).
        longestTaskMs: worst(marks.longTasks),
        longestFrameGapMs: worst(marks.gaps),
        longTasks: marks.longTasks.slice(0, 200),
        // The first report is the preview of a progressive bake (the only one of a one-shot bake), the last the final.
        giPreviewAtMs: gis[0]?.atMs ?? null,
        giPreview: parse(gis[0]),
        giCache: parse(gis.at(-1)),
        // The last exposure reading, and whether the exposure had settled when the settled frame was taken (L9 only).
        exposure: JSON.parse(
          exposures()
            .at(-1)
            ?.text.replace(/^TN_AUTO_EXPOSURE:/, "") ?? "null",
        ),
        exposureSettled,
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
