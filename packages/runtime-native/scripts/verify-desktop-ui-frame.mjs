#!/usr/bin/env node

/**
 * The native UI-frame gate: the page is composited into the game's own frame, and the game then
 * starts.
 *
 * PRD-393 gave the desktop host an in-frame UI composite. Every gate this repository had before
 * this one proved the game was alive and the UI bundle was *attached* — none of them could tell
 * "the page rendered" from "the page is on the screen". Two real defects shipped through all of
 * them, found only by a human playing the game: the HUD stretched on resize, and the page's CSS
 * animations never advanced. The loading-screen gate is the shape being mirrored here: drive the
 * real bundle through the real host, assert markers *and* pixels, and print the reason when a
 * marker says the feature is off rather than skipping the platform.
 *
 * What one run has to prove, in this order:
 *
 * 1. `TN_UI_OVERLAY:{"attached":true}` — the page was attached at all (fail closed, and print the
 *    reason when it is false);
 * 2. `TN_UI_COMPOSITE` reports `counter > 0` and `frame` equal to the scenario's viewport — the
 *    web view actually produced frames, at the size the game declared;
 * 3. a colour only the page paints is present in the game's *own* frame — the page ran and the page
 *    is on screen, which are two different assertions;
 * 4. the game then started: its own frame counter advanced after the UI was up, read from the
 *    resource series rather than from a marker that could have been emitted before it;
 * 5. `TN_UI_HIT_REGIONS` published the page's own rectangles — drawn is not routed;
 * 6. the `ui` phase exists in `TN_FRAME_BUDGET` and is under the bound PRD-393 accepted it at
 *    (2.0 ms p95, AC-6) — the same number, not a second one.
 *
 * Platform contract. On Linux the UI *is* a texture in the frame, so 2, 3 and 5 are all assertions
 * about the frame itself. Windows and macOS still attach a child web view that DWM and Quartz
 * composite, `platform::uiOverlayFrame()` returns false there, and the game's own frame therefore
 * cannot contain the page: this gate says so out loud (`contract: "child-window"`, and the
 * assertions it did not make are named in its evidence) rather than reporting the same green under
 * a weaker check. An unknown platform is refused, not guessed at.
 *
 * Usage: node scripts/verify-desktop-ui-frame.mjs [--ui <dir>] [--contract in-frame|child-window]
 *
 * `--ui <dir>` is the built page to load. The default builds `examples/native-smoke/ui` and stages
 * it as `ui/` beside the runtime binary, which is where `attachUiOverlayIfConfigured` resolves an
 * empty-or-relative `uiRoot` and where the desktop packager puts it. Pointing it at a directory
 * that does not exist is the negative control for every assertion below: the host prints
 * `TN_UI_BUNDLE_MISSING` and exits, and this gate reports that line instead of a green.
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build as esbuild } from "esbuild";
import { PNG } from "pngjs";

import { inspectScreenshot } from "./verify-desktop-core.mjs";
import { run as sharedRun } from "./native-test-lane.mjs";

const runtimeRoot = join(fileURLToPath(new URL("..", import.meta.url)));
const workspaceRoot = join(runtimeRoot, "..", "..");
const exampleRoot = join(workspaceRoot, "examples", "native-smoke");
const bundle = join(exampleRoot, "dist", "native-smoke.js");
const uiSource = join(exampleRoot, "ui", "index.html");
const uiEntry = join(exampleRoot, "ui", "main.ts");
const scenario = join(exampleRoot, "playtests", "ui-frame-desktop.playtest.json");

/**
 * The colour the page owns and the game does not.
 *
 * `#7fffd4` is the background of `examples/native-smoke/ui/index.html`'s two `data-tn-interactive`
 * buttons; the scene this example draws is `#000000`, `#44aaff`, `#ffaa44` and the canvas-layer
 * overlay's `#ff00ff`, and paints nothing near it. Counting it in the captured frame is therefore
 * the difference between "the page ran" (which `TN_UI_COMPOSITE` can say on its own) and "the page
 * is on the screen" — the distinction missing when the two defects above shipped.
 */
const UI_PAGE_COLOR = 0x7fffd4;
const UI_PAGE_COLOR_MIN_PIXELS = 1024;
/**
 * Per-channel slack when matching the page colour. The overlay reads the page from WebKit's
 * compositor frames, and the plate it adds to make every frame whole (alpha 1/255, see
 * `COMPOSITOR_STYLE` in `ui-overlay/src/offscreen.rs`) darkens each opaque page pixel by one level:
 * `#7fffd4` arrives as `#7efed3`. One level is not visible, and the colour is still the page's.
 */
const UI_PAGE_COLOR_TOLERANCE = 2;
/**
 * PRD-393 AC-6's bound: the composite costs <= 2.0 ms/frame at p95 on a 1280x720 frame. Reused
 * rather than restated, and asserted against the phase the run itself reported — a p95 with no
 * samples behind it fails instead of comparing zero to a ceiling.
 */
const UI_PHASE_P95_MS = 2.0;
/**
 * Wall clock between the runner and every fixed-step advance it asks the host for.
 *
 * The page runs on its own thread, so it mounts in wall-clock time; the game only ticks when the
 * runner advances it, and only picks the page's messages up when its own loop iterates. A device
 * `advance` is one request that the host runs at its own speed, so a scenario whose whole step list
 * completes in milliseconds observes a game before its HUD exists. Alternating the two is what lets
 * both halves make progress: the page loads during the wait, and the game drains the page's queue on
 * the next advance. The scenario's leading one-tick steps are the page's startup window, and
 * `requirePageStartupWindow` refuses a scenario that hands the page too little of it.
 */
const ADVANCE_WAIT_MS = 250;
/** The page's startup window the scenario must still declare, in wall-clock milliseconds. */
const MIN_PAGE_STARTUP_MS = 10_000;
/** Per-operation mailbox budget: a 10-tick advance chunk costs ADVANCE_WAIT_MS once. */
const OPERATION_TIMEOUT_MS = 60_000;

function run(command, args, options = {}) {
  return sharedRun(command, args, { ...options, cwd: options.cwd ?? workspaceRoot });
}

function nativeBinary() {
  const preset =
    process.platform === "darwin"
      ? "tn-macos"
      : process.platform === "win32"
        ? "tn-windows"
        : "tn-linux";
  return join(
    runtimeRoot,
    "build",
    preset,
    process.platform === "win32" ? "mystral.exe" : "mystral",
  );
}

function buildGameBundle() {
  return run("pnpm", ["--dir", exampleRoot, "exec", "vite", "build", "--config", "vite.config.ts"], {
    env: {
      ...process.env,
      THREENATIVE_NATIVE_BACKEND: "enabled",
      THREENATIVE_PLAYTEST_BRIDGE: "enabled",
      // Drops the fixture's deliberate `decodeAudioData` negative case, see the vite config. The
      // playtest lane fails a run on any console error and this gate wants that policy intact.
      THREENATIVE_UI_FRAME_GATE: "enabled",
    },
  });
}

function buildDefaultBundle() {
  return run("pnpm", ["--filter", "threenative-native-smoke", "build"]);
}

/** Build the page the web view loads, exactly as the project's own UI build does: entry + page. */
async function buildUiPage(destination) {
  for (const [label, path] of [
    ["UI page", uiSource],
    ["UI entry", uiEntry],
  ]) {
    if (!existsSync(path)) throw new Error(`the ${label} is missing: ${path}`);
  }
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });
  await esbuild({
    bundle: true,
    entryPoints: [uiEntry],
    format: "esm",
    logLevel: "silent",
    outfile: join(destination, "main.js"),
    target: "es2022",
  });
  copyFileSync(uiSource, join(destination, "index.html"));
  return destination;
}

function readScenario() {
  const parsed = JSON.parse(readFileSync(scenario, "utf8"));
  const width = parsed?.viewport?.width;
  const height = parsed?.viewport?.height;
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(`TN_UI_FRAME_SCENARIO_INVALID: ${scenario} declares no usable viewport.`);
  }
  return { expectedFrame: `${width}x${height}`, height, parsed, width };
}

function requireLines(consolePath) {
  if (!existsSync(consolePath)) {
    throw new Error(`TN_UI_FRAME_CONSOLE_MISSING: the run wrote no ${consolePath}.`);
  }
  const entries = JSON.parse(readFileSync(consolePath, "utf8"));
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`TN_UI_FRAME_CONSOLE_EMPTY: ${consolePath} holds no host output.`);
  }
  return entries.map((entry) => String(entry.text));
}

/**
 * The wall clock the scenario still gives the page before the game is allowed to run on.
 *
 * The runner advances at most ten ticks per request (steps.ts), and each request is followed by
 * ADVANCE_WAIT_MS — so a leading run of one-tick steps is the page's startup window. A scenario
 * edited down to a handful of steps takes this gate's premise away without failing anything else:
 * the page would simply not be up yet, and the run would red with an assertion about the UI rather
 * than about the scenario that starved it.
 */
function requirePageStartupWindow(scenarioJson, { minimumMs = MIN_PAGE_STARTUP_MS, waitMs = ADVANCE_WAIT_MS } = {}) {
  const steps = Array.isArray(scenarioJson?.steps) ? scenarioJson.steps : [];
  const readyAt = steps.findIndex((step) => step?.label === "ui-ready");
  if (readyAt === -1) {
    throw new Error("TN_UI_FRAME_SCENARIO_INVALID: the scenario has no 'ui-ready' step to sample the page's readiness at.");
  }
  const advances = steps
    .slice(0, readyAt)
    .reduce((total, step) => total + Math.ceil(((step?.waitTicks ?? 0) + (step?.holdTicks ?? 0)) / 10), 0);
  const windowMs = advances * waitMs;
  if (windowMs < minimumMs) {
    throw new Error(
      `TN_UI_FRAME_SCENARIO_WINDOW_TOO_SHORT: the scenario's steps before 'ui-ready' buy the page ${windowMs} ms (${advances} advance(s) x ${waitMs} ms), under the ${minimumMs} ms the web view needs to mount. Add leading one-tick steps.`,
    );
  }
  return { advanceCalls: advances, windowMs };
}

function parseMarker(lines, name) {
  const payloads = [];
  for (const line of lines) {
    const at = line.indexOf(`${name}:`);
    if (at === -1) continue;
    const raw = line.slice(at + name.length + 1);
    try {
      payloads.push(JSON.parse(raw));
    } catch {
      throw new Error(`TN_UI_FRAME_MARKER_MALFORMED: ${name}:${raw}`);
    }
  }
  return payloads;
}

/** 1. The page was attached, or the reason it was not, in the host's own words. */
function requireOverlayAttached(lines) {
  const markers = parseMarker(lines, "TN_UI_OVERLAY");
  if (markers.length === 0) {
    throw new Error(
      "TN_UI_FRAME_OVERLAY_MISSING: the host never reported TN_UI_OVERLAY, so whether the page attached is unknown.",
    );
  }
  const last = markers[markers.length - 1];
  if (last?.attached !== true) {
    const reason = typeof last?.reason === "string" ? last.reason : JSON.stringify(last);
    throw new Error(`TN_UI_FRAME_OVERLAY_UNATTACHED: the page did not attach: ${reason}`);
  }
  return markers.length;
}

/**
 * 2. The page produced frames, at the size the scenario declared.
 *
 * `counter` is the page's own frame counter and only moves when its pixels change, so `> 0` is the
 * whole question "did the web view ever paint"; `frame` is the page's size, which a HiDPI session
 * would hand back larger than the window — hence an equality against the declared viewport rather
 * than a note that it looked about right.
 */
function requireCompositeFrames(lines, expectedFrame) {
  const markers = parseMarker(lines, "TN_UI_COMPOSITE");
  if (markers.length === 0) {
    throw new Error(
      "TN_UI_FRAME_COMPOSITE_MISSING: the host never reported TN_UI_COMPOSITE, so the page's frames never reached the frame compositor.",
    );
  }
  for (const marker of markers) {
    for (const field of ["counter", "uploads", "skipped"]) {
      if (!Number.isInteger(marker?.[field])) {
        throw new Error(`TN_UI_FRAME_MARKER_MALFORMED: TN_UI_COMPOSITE without ${field}: ${JSON.stringify(marker)}`);
      }
    }
    if (typeof marker?.frame !== "string") {
      throw new Error(`TN_UI_FRAME_MARKER_MALFORMED: TN_UI_COMPOSITE without frame: ${JSON.stringify(marker)}`);
    }
  }
  const last = markers[markers.length - 1];
  if (last.counter <= 0) {
    throw new Error(
      `TN_UI_FRAME_NO_PAGE_FRAMES: the page never produced a frame (counter ${last.counter} after ${markers.length} report(s)). The web view is attached but has painted nothing.`,
    );
  }
  if (last.frame !== expectedFrame) {
    throw new Error(
      `TN_UI_FRAME_SIZE_MISMATCH: the page composited at ${last.frame}, and the scenario declares ${expectedFrame}.`,
    );
  }
  const uploads = Math.max(...markers.map((marker) => marker.uploads));
  if (uploads < 1) {
    throw new Error(
      "TN_UI_FRAME_NO_UPLOAD: the page advanced its counter but no frame was ever uploaded to the game's texture.",
    );
  }
  return { counter: last.counter, frame: last.frame, reports: markers.length, uploads };
}

/** 3. The page's own colour, inside the game's own frame. */
function inspectPagePixels(path, color = UI_PAGE_COLOR, minPixels = UI_PAGE_COLOR_MIN_PIXELS) {
  if (!existsSync(path)) throw new Error(`TN_UI_FRAME_SCREENSHOT_MISSING: ${path}`);
  const png = PNG.sync.read(readFileSync(path));
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  let matched = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    if (
      Math.abs(png.data[index] - red) <= UI_PAGE_COLOR_TOLERANCE &&
      Math.abs(png.data[index + 1] - green) <= UI_PAGE_COLOR_TOLERANCE &&
      Math.abs(png.data[index + 2] - blue) <= UI_PAGE_COLOR_TOLERANCE
    ) {
      matched += 1;
    }
  }
  if (matched < minPixels) {
    throw new Error(
      `TN_UI_FRAME_PAGE_NOT_ON_SCREEN: the game's own frame holds ${matched} pixel(s) of #${color.toString(16)} (the page's button), expected at least ${minPixels}. The page ran but is not in the frame the game presents.`,
    );
  }
  return { color: `#${color.toString(16).padStart(6, "0")}`, height: png.height, pixels: matched, width: png.width };
}

/** 4. The game started *after* the UI was up. Read from the series, not from a single marker. */
function requireGameStartedAfterUi(report, { minimumFrames = 30 } = {}) {
  const series = report?.observations?.resourceSeries;
  if (!Array.isArray(series) || series.length === 0) {
    throw new Error(
      "TN_UI_FRAME_RESOURCE_SERIES_MISSING: the run published no resource series, so whether the game started after the UI cannot be answered.",
    );
  }
  const sampleFrames = (sample) => {
    const value = sample?.snapshots?.GameState?.frames;
    return Number.isInteger(value) ? value : undefined;
  };
  const readyIndex = series.findIndex((sample) => sample?.label === "ui-ready");
  if (readyIndex === -1) {
    throw new Error(
      `TN_UI_FRAME_STEP_SAMPLE_MISSING: no sample labelled 'ui-ready'; the run sampled [${series.map((sample) => sample?.label).join(", ")}].`,
    );
  }
  const ready = series[readyIndex];
  if (ready?.snapshots?.GameState?.uiReady !== true) {
    throw new Error(
      `TN_UI_FRAME_UI_NOT_READY: the game had not seen the page's ready intent at 'ui-ready' (uiReady ${JSON.stringify(ready?.snapshots?.GameState?.uiReady)}).`,
    );
  }
  const framesAtReady = sampleFrames(ready);
  const last = series[series.length - 1];
  const framesAtEnd = sampleFrames(last);
  if (framesAtReady === undefined || framesAtEnd === undefined) {
    throw new Error(
      "TN_UI_FRAME_FRAME_COUNTER_MISSING: GameState.frames was never sampled, so the game's own progress cannot be read.",
    );
  }
  if (framesAtReady < 1) {
    throw new Error(
      `TN_UI_FRAME_GAME_NOT_STARTED: the game's own frame counter was ${framesAtReady} when the UI became ready.`,
    );
  }
  if (framesAtEnd - framesAtReady < minimumFrames) {
    throw new Error(
      `TN_UI_FRAME_GAME_STOPPED_AFTER_UI: the game's own frame counter went ${framesAtReady} -> ${framesAtEnd} across 'ui-ready' -> '${last?.label}', which is fewer than the ${minimumFrames} frames this gate requires after the UI came up. The page is up and the game is not running.`,
    );
  }
  return { framesAtEnd, framesAtReady, framesDelta: framesAtEnd - framesAtReady, uiRegions: ready?.snapshots?.GameState?.uiRegions };
}

/** 5. The UI is routed, not merely drawn. */
function requireHitRegions(lines, gameRegions) {
  const markers = parseMarker(lines, "TN_UI_HIT_REGIONS");
  if (markers.length === 0) {
    throw new Error(
      "TN_UI_FRAME_HIT_REGIONS_MISSING: the page never published interactive rectangles, so nothing it draws can receive a pointer.",
    );
  }
  const last = markers[markers.length - 1];
  if (!Number.isInteger(last?.count) || !Array.isArray(last?.regions)) {
    throw new Error(`TN_UI_FRAME_MARKER_MALFORMED: TN_UI_HIT_REGIONS without count/regions: ${JSON.stringify(last)}`);
  }
  if (last.count < 1) {
    throw new Error("TN_UI_FRAME_HIT_REGIONS_EMPTY: the page published an empty hit-region set.");
  }
  if (last.regions.length !== last.count * 4) {
    throw new Error(
      `TN_UI_FRAME_MARKER_MALFORMED: TN_UI_HIT_REGIONS count ${last.count} does not match ${last.regions.length} floats.`,
    );
  }
  if (Number.isInteger(gameRegions) && gameRegions !== last.count) {
    throw new Error(
      `TN_UI_FRAME_HIT_REGIONS_DISAGREE: the host routed ${last.count} rectangle(s) and the game's own ready intent carried ${gameRegions}. The page's registry and the host's routing table are not the same set.`,
    );
  }
  return { count: last.count, reports: markers.length };
}

/** 6. The composite's own cost, as the run reported it. */
function requireUiPhase(lines, boundMs = UI_PHASE_P95_MS) {
  const windows = parseMarker(lines, "TN_FRAME_BUDGET");
  if (windows.length === 0) {
    throw new Error(
      "TN_FRAME_BUDGET_PHASE_MISSING: the run reported no frame budget window, so the composite's cost is unmeasured.",
    );
  }
  const last = windows[windows.length - 1];
  const ui = last?.phases?.ui;
  if (ui === undefined || !Number.isInteger(ui?.samples)) {
    throw new Error(`TN_FRAME_BUDGET_PHASE_MISSING: the last window carries no 'ui' phase: ${JSON.stringify(last?.phases)}`);
  }
  if (ui.samples === 0) {
    throw new Error("TN_FRAME_BUDGET_PHASE_EMPTY: the 'ui' phase reported zero samples; nothing was measured.");
  }
  if (!(ui.p95 < boundMs)) {
    throw new Error(
      `TN_FRAME_BUDGET_PHASE_OVER_BUDGET: the 'ui' phase is ${ui.p95} ms at p95 over ${ui.samples} frame(s), which is not under ${boundMs} ms.`,
    );
  }
  return { boundMs, phases: windows.length, p50: ui.p50, p95: ui.p95, samples: ui.samples, worst: ui.max };
}

function addAdvanceWallClock(transport, waitMs) {
  return {
    capabilities: transport.capabilities,
    async call(method, argument) {
      if (method === "advance") await new Promise((resolve) => setTimeout(resolve, waitMs));
      return transport.call(method, argument);
    },
    close: () => transport.close(),
    start: () => transport.start(),
    waitForBridge: (timeoutMs) => transport.waitForBridge(timeoutMs),
  };
}

function contractFor(platform = process.platform, requested) {
  const derived = platform === "linux" ? "in-frame" : "child-window";
  const contract = requested ?? derived;
  if (contract !== "in-frame" && contract !== "child-window") {
    throw new Error(`TN_UI_FRAME_CONTRACT_INVALID: --contract accepts in-frame or child-window, received '${contract}'.`);
  }
  if (derived === "child-window" && contract === "in-frame") {
    throw new Error(
      `TN_UI_FRAME_CONTRACT_UNSUPPORTED: ${platform} composites the UI as a child window; platform::uiOverlayFrame() reports no frame there, so the in-frame assertions cannot be made.`,
    );
  }
  return contract;
}

async function runUiFramePlaytest({ contract, expectedFrame, hostArgs, uiRoot }) {
  const playtest = await import(
    pathToFileURL(join(workspaceRoot, "packages", "playtest", "dist", "runner", "index.js")).href,
  );
  const binary = nativeBinary();
  for (const [label, path] of [
    ["native runtime binary", binary],
    ["game bundle", bundle],
    ["UI page", join(uiRoot, "index.html")],
    ["scenario", scenario],
  ]) {
    if (!existsSync(path)) throw new Error(`the ${label} is missing: ${path}`);
  }

  const artifactDirectory = join(
    runtimeRoot,
    "artifacts",
    `desktop-ui-frame-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}`,
  );
  const mailboxRoot = mkdtempSync(join(runtimeRoot, "desktop-ui-frame-mailbox-"));
  mkdirSync(artifactDirectory, { recursive: true });
  const paths = playtest.deviceMailboxPaths(mailboxRoot);
  const driver = new playtest.DesktopPlaytestDriver({
    args: hostArgs,
    cwd: exampleRoot,
    executable: binary,
    mailboxRoot,
  });
  const transport = new playtest.DeviceMailboxTransport(
    new playtest.LocalDeviceMailbox(),
    paths,
    OPERATION_TIMEOUT_MS,
  );
  const config = {
    // The same declared acceptance `--allow-software` / `TN_PLAYTEST_ALLOW_SOFTWARE=1` already
    // expresses on the CLI, read here because this proof calls the runner API directly. The hosted
    // Linux runner binds Mesa llvmpipe; a local desktop run leaves the variable unset and still
    // fails closed.
    allowSoftwareAdapter: process.env.TN_PLAYTEST_ALLOW_SOFTWARE === "1",
    artifactDirectory,
    desktop: { executable: binary },
    endpoint: "http://127.0.0.1:41777/playtest",
    headless: true,
    mailboxRoot,
    projectPath: exampleRoot,
    scenarioPath: scenario,
    target: "desktop",
    timeoutMs: OPERATION_TIMEOUT_MS,
    trace: false,
    url: binary,
  };

  try {
    let report;
    try {
      report = await playtest.runDevicePlaytest(config, {
        driver,
        mailboxPaths: paths,
        name: "desktop",
        processName: binary,
        transport: addAdvanceWallClock(transport, ADVANCE_WAIT_MS),
      });
    } catch (error) {
      // A host that refuses to start never writes a report, and its own console is then the only
      // place the reason exists — `TN_UI_BUNDLE_MISSING` and a missing `ui/` directory are exactly
      // that case. Read the driver's console rather than reporting a bare timeout.
      const hostConsole = await driver.captureConsole().catch(() => []);
      const tail = hostConsole
        .slice(-25)
        .map((entry) => String(entry.text))
        .join("\n");
      const failure = error instanceof Error ? error.message : String(error);
      writeFileSync(
        join(artifactDirectory, "ui-frame-host-console.txt"),
        `${hostConsole.map((entry) => String(entry.text)).join("\n")}\n`,
      );
      throw new Error(
        `TN_UI_FRAME_RUN_FAILED: ${failure}\nThe host's console tail (artifacts: ${artifactDirectory}):\n${tail}`,
      );
    }
    if (!report.pass) {
      writeFileSync(
        join(artifactDirectory, "ui-frame-report.json"),
        `${JSON.stringify(report, null, 2)}\n`,
      );
      const failed = (report.assertionResults ?? []).filter((entry) => entry.pass !== true);
      const series = (report.observations?.resourceSeries ?? []).map((sample) => ({
        label: sample.label,
        uiReady: sample.snapshots?.GameState?.uiReady,
        uiRegions: sample.snapshots?.GameState?.uiRegions,
        frames: sample.snapshots?.GameState?.frames,
      }));
      const summary = {
        failedAssertions: failed.map((entry) => ({ details: entry.details, id: entry.id })),
        samples: series,
      };
      writeFileSync(
        join(artifactDirectory, "ui-frame-summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`,
      );
      throw new Error(
        `TN_UI_FRAME_ASSERTIONS_FAILED: the scenario's own assertions failed. Report: ${join(artifactDirectory, "ui-frame-report.json")}\n${JSON.stringify(summary, null, 2)}`,
      );
    }

    const screenshot = join(artifactDirectory, "ui-frame.png");
    const consolePath = join(artifactDirectory, "console.json");
    inspectScreenshot(screenshot);
    const lines = requireLines(consolePath);
    const overlayReports = requireOverlayAttached(lines);
    const hitRegions = requireHitRegions(lines, report.observations?.resourceSeries?.at(-1)?.snapshots?.GameState?.uiRegions);
    const started = requireGameStartedAfterUi(report);
    const uiPhase = requireUiPhase(lines);
    const inFrame =
      contract === "in-frame"
        ? {
            composite: requireCompositeFrames(lines, expectedFrame),
            pagePixels: inspectPagePixels(screenshot),
          }
        : undefined;

    const evidence = {
      artifactDirectory,
      contract,
      // On the child-window contract these are the two assertions this gate does not make, named
      // rather than silently absent: the page is composited by the OS and is not in the texture the
      // game presents, so neither the compositor's counter nor the page's pixels can be read here.
      ...(inFrame === undefined
        ? {
            unasserted: [
              "TN_UI_COMPOSITE counter/frame (the composite is Linux-only; platform::uiOverlayFrame reports no page frame here)",
              "the page's pixels inside the game's own frame (the child web view is composited by the OS, not by the game)",
            ],
          }
        : {}),
      ...(inFrame === undefined ? {} : inFrame),
      hitRegions,
      host: process.platform,
      overlayReports,
      pass: true,
      screenshot,
      startedAfterUi: started,
      uiPhase,
    };
    writeFileSync(join(artifactDirectory, "ui-frame-proof.json"), `${JSON.stringify(evidence, null, 2)}\n`);
    return evidence;
  } finally {
    rmSync(mailboxRoot, { force: true, recursive: true });
  }
}

/**
 * The host arguments.
 *
 * `--ui` is deliberately the relative `ui` — that is the string `applyEmbeddedConfig` assigns from
 * `ui.renderer: "web"` and the resolution the desktop packager relies on — except when the caller
 * named a directory of their own, which is passed as given so a path that does not exist fails in
 * the host instead of being quietly substituted.
 */
function uiHostArgs({ height, path, width }) {
  return [
    "run",
    bundle,
    "--ui",
    path,
    "--width",
    String(width),
    "--height",
    String(height),
  ];
}

function parseArguments(argv) {
  const options = { contract: undefined, uiRoot: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--ui") {
      options.uiRoot = argv[++index];
      if (options.uiRoot === undefined) throw new Error("--ui needs a directory.");
    } else if (argument === "--contract") {
      options.contract = argv[++index];
      if (options.contract === undefined) throw new Error("--contract needs in-frame or child-window.");
    } else {
      throw new Error(`unknown argument '${argument}'; usage: verify-desktop-ui-frame.mjs [--ui <dir>] [--contract <contract>]`);
    }
  }
  return options;
}

async function main() {
  if (process.platform === "linux" && process.env.DISPLAY === undefined) {
    throw new Error("the desktop UI-frame gate requires DISPLAY; run it through scripts/xvfb.sh");
  }
  const options = parseArguments(process.argv.slice(2));
  const contract = contractFor(process.platform, options.contract);
  const { expectedFrame, height, parsed, width } = readScenario();
  const pageWindow = requirePageStartupWindow(parsed);
  buildGameBundle();
  let proofError;
  let restoreError;
  try {
    // Beside the executable when the caller named nothing, which is where the desktop packager
    // stages it and where `attachUiOverlayIfConfigured` resolves a relative `uiRoot`. A caller's
    // `--ui` is passed straight through, so a directory that does not exist fails in the host with
    // TN_UI_BUNDLE_MISSING instead of being quietly substituted with the default.
    const staged = options.uiRoot ?? join(runtimeRoot, "build", stagedPreset(), "ui");
    if (options.uiRoot === undefined) await buildUiPage(staged);
    const evidence = await runUiFramePlaytest({
      contract,
      expectedFrame,
      hostArgs: uiHostArgs({
        height,
        path: options.uiRoot === undefined ? "ui" : staged,
        width,
      }),
      uiRoot: staged,
    });
    console.info(
      `desktop UI frame gate passed on the ${contract} contract: overlay attached after ${evidence.overlayReports} report(s), ${evidence.hitRegions.count} hit region(s), ${pageWindow.windowMs} ms of page-startup window, game frame ${evidence.startedAfterUi.framesAtReady} -> ${evidence.startedAfterUi.framesAtEnd}, ui phase p95 ${evidence.uiPhase.p95} ms under ${evidence.uiPhase.boundMs} ms`,
    );
    if (evidence.composite !== undefined && evidence.pagePixels !== undefined) {
      console.info(
        `desktop UI frame gate: page frame ${evidence.composite.frame}, counter ${evidence.composite.counter}, uploads ${evidence.composite.uploads}; ${evidence.pagePixels.pixels} ${evidence.pagePixels.color} pixel(s) in the game's own ${evidence.pagePixels.width}x${evidence.pagePixels.height} frame`,
      );
    }
    if (evidence.unasserted !== undefined) {
      for (const entry of evidence.unasserted) console.info(`desktop UI frame gate (unasserted here): ${entry}`);
    }
    console.info(`desktop UI frame proof artifacts: ${evidence.artifactDirectory}`);
  } catch (error) {
    proofError = error;
  } finally {
    // `native:verify:desktop` runs the other desktop gates after this one on the plain bundle the
    // example ships; leave the tree the way it was found.
    try {
      buildDefaultBundle();
    } catch (error) {
      restoreError = error;
    }
  }
  if (restoreError !== undefined) {
    throw new AggregateError([proofError, restoreError].filter((error) => error !== undefined), "desktop UI frame gate cleanup failed");
  }
  if (proofError !== undefined) throw proofError;
}

function stagedPreset() {
  if (process.platform === "darwin") return "tn-macos";
  if (process.platform === "win32") return "tn-windows";
  return "tn-linux";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
