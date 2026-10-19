#!/usr/bin/env node
/**
 * The host-level lifecycle/invalidation/resource harness for the native-css UI.
 *
 * One generated project per arm (see `project.mjs` for the arms and the crate bench HUD they
 * mirror), packaged against a host binary this checkout already built, run under the repository's
 * private Xvfb, and read with the meters the host actually publishes: `threenative-playtest perf`
 * over the captured log, `TN_UI_COMPOSITE`/`TN_UI_COMPOSITE_TRACE` for what the UI composite did
 * with the page's pixels, `TN_COLD_START` for the launch, and `/proc/<pid>/status` for the heap.
 *
 * Why the harness spawns the executable itself and hands the log to `perf --file` rather than
 * calling `perf --executable`: the process RSS the PRD asks for is only readable from a pid, and
 * `perf --executable` owns the pid. `perf --file` is the same parser over the same markers, so the
 * numbers are the ones the meter reader would have printed.
 *
 * Two rules this file keeps, both from the brief and both easy to lose:
 *
 * - **No headline fps.** The display is a private Xvfb, where the present wait lands inside the
 *   engine's update phase: the same package measured 13.3 fps there against 57.7 on the real
 *   display from one build. Phase times and A/B deltas are printed; fps is not.
 * - **A missing meter is named, never invented.** GPU time, input-to-present latency and the CSS
 *   engine's own CPU time have no marker at host level (see `METERS`), so the report says which
 *   instrument is missing rather than printing a zero.
 *
 * Usage: `cd examples/native-css-hud && sh ../../scripts/xvfb.sh node bench/run.mjs [--frames N] [--arms a,b]`
 * Output: `bench/out/report.json` plus each arm's `run.log` (build output in `bench/out/<arm>/dist`).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, writeProject } from "./project.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const example = resolve(here, "..");
const repo = resolve(example, "..", "..");
const out = join(here, "out");
const hosts = {
  "tn-linux": join(repo, "packages", "runtime-native", "build", "tn-linux", "mystral"),
  "tn-linux-both": join(repo, "packages", "runtime-native", "build", "tn-linux-both", "mystral"),
};
const packager = join(repo, "packages", "runtime-native", "scripts", "package-desktop.mjs");
const threenative = join(repo, "packages", "create-threenative", "dist", "threenative.js");
const playtest = join(repo, "packages", "playtest", "dist", "runner", "cli.js");
const pipeline = join(
  process.env.HOME ?? "/root",
  ".agents/skills/ci-pipeline/scripts/pipeline.sh",
);
const prebuilt = join(repo, "packages", "runtime-native", "prebuilt");

/** The PRD's run shape. `WINDOW` is core's frame-budget window, in presented frames. */
const WARMUP = 120;
const WINDOW = 300;
/** Per-frame UI accounting, off unless set: `TN_UI_COMPOSITE_TRACE` is a line per composite. */
const TRACE = "TN_UI_COMPOSITE_TRACE";
/** How long one arm may run before it is a failure rather than a slow answer. */
const ARM_TIMEOUT_MS = 300_000;
/** RSS sampling period. Every quarter second is a reading, not a resolution claim. */
const RSS_PERIOD_MS = 250;

/**
 * What this harness can and cannot measure, by name.
 *
 * The PRD asks for UI CPU work, GPU time, upload/copy cost, total game-frame p50/p95/p99,
 * input-to-present latency, heap/RSS and GPU resources. This is where each of those lands:
 *
 * - **game-frame p50/p95/p99** — `TN_FRAME_BUDGET`, per window and per phase (`packages/core/src/frame-budget.ts`).
 * - **UI CPU work** — only the composite: the `ui` phase is the host's upload of the page's frame
 *   plus one quad (`bindings.cpp`, `compositeUiOverlayToWebGPU`). The CSS engine's own
 *   style/layout/paint runs on the host's UI thread and publishes no timing marker, so its cost is
 *   only visible as frames it did or did not produce. The crate bench measures it directly
 *   (`cargo run --release --example bench`) and that is where to read it.
 * - **upload/copy cost** — `TN_UI_COMPOSITE` (per second, cumulative uploads and skips) and
 *   `TN_UI_COMPOSITE_TRACE` (per composite: which page-frame counter, uploaded or skipped).
 * - **GPU time** — `gpuMs` per window, present only if the adapter granted `timestamp-query`.
 * - **input-to-present latency** — **no meter exists.** `TN_UI_OVERLAY_PUBLISH_AGE` (see
 *   `ui_overlay.cpp`) ages a *state publication*, not a pointer event, and nothing stamps the
 *   pointer-to-present path end to end.
 * - **heap/RSS** — `/proc/<pid>/status` `VmRSS`, sampled every 250 ms across the run.
 * - **GPU resources** — `TN_PRESENTS_TICK` (`textures`, `textureMB`, `bufferMB`) when the host
 *   publishes it; a run that never does says so instead of reporting nothing as zero.
 * - **startup** — `TN_COLD_START` segments on one monotonic clock.
 * - **repeated parse/layout/shaping/reconciliation** — observable as the page-frame counter
 *   stopping: `TN_UI_COMPOSITE_TRACE`'s distinct `counter` values, and the React root's own
 *   `postCount`/`opCount` in the game's `TN_BENCH` lines.
 * - **mount/dispose retention** — not measured here; it is the crate bench's `mountDispose`
 *   scenario (RSS across cycles), which does not need a host.
 */
const METERS = {
  measured: [
    "game-frame p50/p95/p99 per window and per phase (TN_FRAME_BUDGET)",
    "UI composite CPU per frame, the `ui` phase (TN_FRAME_BUDGET)",
    "upload/copy counts (TN_UI_COMPOSITE, TN_UI_COMPOSITE_TRACE)",
    "UI frames published vs frames composited (distinct TN_UI_COMPOSITE_TRACE counters)",
    "React posts and mutation ops (the root's postCount/opCount, in the game's TN_BENCH lines)",
    "process RSS (VmRSS, every 250 ms)",
    "cold start to first frame / first UI frame (TN_COLD_START)",
    "packaged container and executable bytes (du -sb)",
    "GPU ms per window when the adapter granted timestamp-query",
  ],
  missing: [
    "the CSS engine's own style/layout/shaping CPU time — no host marker; crate bench only",
    "input-to-present latency — no end-to-end meter exists for it",
    "GPU resource counts — TN_PRESENTS_TICK publishes textures/buffers only when the host counts them",
    "frame rate — the private Xvfb makes it wrong, not missing: 13.3 fps there vs 57.7 on the real display, one build",
  ],
};

const pad = (text, width) => String(text ?? "-").padEnd(width);
const num = (value, digits = 2) => (typeof value === "number" ? value.toFixed(digits) : "-");

const args = parseArgs(process.argv.slice(2));
const frames = args.frames;
const armNames = args.arms ?? Object.keys(ARMS);
/** Windows to run: enough presented frames to cover warm-up plus the measured run, plus the one
 * `perf` discards as startup. */
const windowsToRun = Math.ceil((WARMUP + frames) / WINDOW) + 1;
const steadyWindows = windowsToRun - 1;

const loadavgAtStart = readFileSync("/proc/loadavg", "utf8").trim();
const machine = {
  os: osRelease(),
  kernel: os.release(),
  cpu: firstMatch(readFileSync("/proc/cpuinfo", "utf8"), /^model name\s*:\s*(.+)$/mu),
  gpu: gpu(),
  loadavgAtStart,
  node: process.version,
  display: process.env.DISPLAY ?? "(none)",
};
console.log(`load average at start: ${loadavgAtStart}`);
console.log(`machine: ${machine.os} · ${machine.cpu} · ${machine.gpu ?? "gpu unknown"}`);
if (!hostPresent()) {
  console.error(
    "TN_BENCH_HOST_MISSING: no host binary is built. Build one with TN_ENABLE_CSS_UI=1 pnpm native:build (do not rebuild while another agent is in packages/runtime-native).",
  );
  process.exit(1);
}
if (!existsSync(packager) || !existsSync(threenative) || !existsSync(playtest)) {
  console.error(
    `TN_BENCH_TOOLING_MISSING: ${[packager, threenative, playtest].filter((file) => !existsSync(file)).join(", ")}`,
  );
  process.exit(1);
}

const claimed = claim();
const arms = {};
let failed = 0;
try {
  for (const name of armNames) {
    const spec = ARMS[name];
    if (spec === undefined) throw new Error(`TN_BENCH_ARM_UNKNOWN: ${name}`);
    console.log(`\n=== ${name} — ${spec.note}`);
    arms[name] = await runArm(name, spec);
    const entry = arms[name];
    if (entry.status === "failed") {
      failed += 1;
      console.error(`FAIL ${name}: ${entry.why}`);
    } else if (entry.status === "unavailable") {
      console.error(`UNAVAILABLE ${name}: ${entry.why}`);
    } else {
      console.log(summary(entry));
    }
  }
} finally {
  release(claimed);
  // `THREENATIVE_RUNTIME_BINARY` should keep a consumer build from installing the published
  // prebuilt into the engine tree at all. If one is left anyway, it is another package's build
  // output sitting in this checkout, and removing it keeps the next build honest.
  if (existsSync(prebuilt)) {
    rmSync(prebuilt, { force: true, recursive: true });
    console.log(`\nremoved the consumer build's ${prebuilt}`);
  }
}

const report = {
  generatedAt: new Date().toISOString(),
  kind:
    "MEASUREMENT, NOT A BASELINE: taken on a shared machine whose load average is printed below. " +
    "Frame meters measured under that load compare within one run, not against another machine or another day.",
  plan: {
    warmupFrames: WARMUP,
    measuredFrames: frames,
    windowFrames: WINDOW,
    windowsRun: windowsToRun,
    steadyWindows,
    note: "one frame-budget window is 300 presented frames (core/src/frame-budget.ts); `perf` discards window 1 as startup and assesses the rest",
  },
  machine,
  loadavgAtEnd: readFileSync("/proc/loadavg", "utf8").trim(),
  hosts: Object.fromEntries(
    Object.entries(hosts).map(([name, path]) => [
      name,
      existsSync(path)
        ? { path, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") }
        : { path, missing: true },
    ]),
  ),
  meters: METERS,
  arms,
};
writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
printTable(report);
console.log(`\nreport: ${join(out, "report.json")}`);
process.exit(failed === 0 ? 0 : 1);

/**
 * One arm, end to end: generate, build, package, run, read.
 *
 * Nothing here decides a verdict about the engine: an arm that produced no numbers is a `failed`
 * arm, an arm whose backend could not run here is `unavailable`, and the two are never merged —
 * "we could not check" and "we checked" must not be the same answer.
 */
async function runArm(name, spec) {
  const armDir = join(out, name);
  /** Under `dist/` so the repo's Biome config ignores the generated tree, as `corpus/desktop.mjs`
   * does for the same reason. */
  const dir = join(armDir, "dist");
  const executable = join(dir, "dist-native", `tn-bench-${name.replaceAll(/-/gu, "")}`);
  // Only this arm's own directory goes: `--arms ui-off` must not delete the other arms' logs and
  // reports, which is what a run that is narrower than the last one usually wants to keep.
  rmSync(armDir, { force: true, recursive: true });
  mkdirSync(armDir, { recursive: true });
  writeProject(dir, name, { warmup: WARMUP, measured: frames });

  // `THREENATIVE_RUNTIME_BINARY` is what makes the consumer build package against THIS checkout's
  // host. Left unset it installs the published prebuilt into packages/runtime-native/prebuilt and
  // writes a container built from it — a different binary at the same output path, which is exactly
  // the kind of number that gets compared against the wrong arm.
  const build = run(process.execPath, [threenative, "build", "--target", "desktop"], dir, [
    ["THREENATIVE_RUNTIME_BINARY", hosts[spec.host]],
  ]);
  const commands = [{ step: "consumer build", status: build.status }];
  const built = ["game.js", "config.json"].every((file) =>
    existsSync(join(dir, ".threenative", "build", file)),
  );
  // The build's own packaging step is allowed to fail: this harness packages again below, naming
  // the host explicitly, and reads only the bundle, the config and the stylesheets. Anything
  // missing there is a real build failure, though — a `native-css` arm with no stylesheet would
  // otherwise package a host that starts with nothing to paint.
  const uiDir = join(dir, ".threenative", "build", "ui-css");
  const pageDir = join(dir, ".threenative", "build", "ui");
  const stagedUi =
    spec.renderer === "native-css"
      ? existsSync(uiDir)
      : spec.renderer === "web"
        ? existsSync(join(pageDir, "index.html"))
        : true;
  if (!built || !stagedUi) {
    return {
      status: "failed",
      why: `the consumer build produced no bundle (built=${built}, ui=${stagedUi}): ${tail(build.output)}`,
      commands,
    };
  }

  const packaged = run(
    process.execPath,
    [
      packager,
      "--bundle",
      ".threenative/build/game.js",
      ...(spec.renderer === "native" ? [] : ["--ui", spec.renderer === "web" ? pageDir : uiDir]),
      "--config",
      ".threenative/build/config.json",
      "--runtime",
      hosts[spec.host],
      "--output",
      executable,
    ],
    dir,
  );
  commands.push({ step: "package-desktop", status: packaged.status });
  // Fail closed on the packager's own verdict, not on whether a file happens to be sitting at the
  // output path: an executable left by anything else would otherwise be measured as this arm's.
  if (packaged.status !== 0 || !existsSync(executable)) {
    return {
      status: "failed",
      why: `packaging against ${spec.host} failed (exit ${packaged.status}): ${tail(packaged.output)}`,
      commands,
    };
  }

  const sizes = {
    containerBytes: dirBytes(join(dir, "dist-native")),
    executableBytes: fileBytes(executable),
  };
  const log = join(armDir, "run.log");
  const measured = await runHost(executable, dir, log);
  // The harness stops the host itself once the last window closes, so a signalled exit is the
  // expected ending and is reported as what it was rather than as a zero.
  commands.push({
    step: "host run",
    status: measured.exit ?? `signal ${measured.signal}`,
    note: measured.why,
  });

  const lines = readFileSync(log, "utf8").split("\n");
  const identity = hostIdentity(lines);
  const bench = benchLines(lines);
  const composite = compositeStats(lines);
  const coldStart = coldStartSegments(lines);

  const perfJson = run(process.execPath, [
    playtest,
    "perf",
    "--file",
    log,
    "--require-windows",
    String(steadyWindows),
  ]);
  const perfText = run(process.execPath, [
    playtest,
    "perf",
    "--file",
    log,
    "--require-windows",
    String(steadyWindows),
    "--text",
  ]);
  commands.push({ step: "playtest perf --file", status: perfJson.status });
  const perf = parses(perfJson.output);
  const numbers = perf === undefined ? { missing: tail(perfJson.output) } : perfNumbers(perf);

  const entry = {
    status: "measured",
    host: spec.host,
    hostSha256: existsSync(hosts[spec.host])
      ? createHash("sha256").update(readFileSync(hosts[spec.host])).digest("hex")
      : undefined,
    renderer: spec.renderer,
    mode: spec.mode,
    note: spec.note,
    windowsRun: measured.windows,
    framesComposited: composite.composites,
    identity,
    game: bench,
    uiComposite: composite,
    coldStart,
    sizes,
    rss: measured.rss,
    perf: numbers,
    perfExit: perfJson.status,
    perfText: perfText.output,
    log,
    commands,
  };

  // An arm that ran but published nothing the PRD asked for is a failure, not a quiet pass.
  const problems = [];
  if (perf === undefined) problems.push(`perf could not read the log: ${tail(perfJson.output)}`);
  else {
    if (perf.pass === false) {
      problems.push(
        `perf exit ${perfJson.status}: ${perf.violations.map((v) => `${v.code}@${v.window}`).join(", ")}`,
      );
    }
    if (numbers.steady.length < steadyWindows) {
      problems.push(`only ${numbers.steady.length} steady windows of ${steadyWindows}`);
    }
  }
  if (identity.errors.length > 0) problems.push(`host error: ${identity.errors[0].slice(0, 160)}`);
  if (identity.rejected > 0) problems.push(`${identity.rejected} TN_CSS_UI_POST_REJECTED line(s)`);
  if (bench.last === undefined)
    problems.push("the game logged no TN_BENCH line: it never reached frame 60");
  else if (bench.last.frames < WARMUP + frames) {
    problems.push(
      `the game ran ${bench.last.frames} frames, short of the ${WARMUP + frames} the plan asked for`,
    );
  }
  // A UI arm whose overlay never attached, or attached and painted nothing, would report a
  // beautiful "no work" number. Both are failures here, and both are named rather than averaged in.
  if (spec.renderer !== "native") {
    if (identity.attached !== true)
      problems.push(`no attached overlay: ${identity.attachReason ?? "no marker"}`);
    if (composite.composites === 0) problems.push("the host composited no UI frame");
    if (composite.published === 0) problems.push("the UI published no page frame");
  } else if (identity.attached === true) {
    problems.push("the ui-off arm attached an overlay");
  }
  if (problems.length > 0) {
    const why = problems.join("; ");
    // "We could not check here" and "we checked and it is wrong" are different answers, and the
    // PRD asks for the first one to be reported as itself. An arm is `unavailable` only when the
    // platform or the tooling cannot supply its subject — named markers below, never a guess —
    // and every other gap is a failure that must exit non-zero.
    const environment = unavailableReason(spec, identity, existsSync(hosts[spec.host]));
    entry.status = environment === undefined ? "failed" : "unavailable";
    entry.why = environment === undefined ? why : `${environment} (${why})`;
    return entry;
  }
  return entry;
}

/**
 * Why this arm cannot be measured on this machine at all, or `undefined` when it can.
 *
 * Deliberately short: a host that was never built with a backend, and a web overlay that cannot
 * attach because the platform has no browser engine. Everything else — a UI that mounted nothing,
 * a game that ran no frames, a meter that published nothing — is a failure of the thing under
 * test, not of the machine.
 */
function unavailableReason(spec, identity, hostBuilt) {
  if (!hostBuilt) return `the ${spec.host} host binary is not built in this checkout`;
  const reason = identity.attachReason ?? "";
  if (
    spec.renderer === "web" &&
    (/webkit|webview|TN_UI_LOAD_FAILED|no WebView|dlopen|cannot open shared object/iu.test(
      reason,
    ) ||
      identity.webView > 0)
  ) {
    return `the web overlay cannot attach on this machine: ${reason.slice(0, 200) || "the host reported a web view failure"}`;
  }
  return undefined;
}

/**
 * Run the packaged host until enough frame-budget windows have closed, and sample its RSS while
 * it runs.
 *
 * The windows are the stop condition rather than a wall clock because they are the unit the meters
 * are reported in: N windows is N * 300 presented frames, whatever the machine managed.
 * `TN_UI_COMPOSITE_TRACE` is on for the whole run — a line per composite is the only way to tell a
 * UI that republished every frame from one that stopped, which is the PRD's unchanged-tree claim.
 */
function runHost(executable, cwd, log) {
  return new Promise((settle) => {
    const child = spawn(executable, [], {
      cwd,
      env: { ...process.env, [TRACE]: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let text = "";
    let windows = 0;
    const rss = { samples: 0, startKb: 0, lastKb: 0, peakKb: 0 };
    let exit;
    let why;
    let hard;
    const sample = setInterval(() => {
      const kb = rssKb(child.pid);
      if (kb === 0) return;
      if (rss.samples === 0) rss.startKb = kb;
      rss.lastKb = kb;
      rss.peakKb = Math.max(rss.peakKb, kb);
      rss.samples += 1;
    }, RSS_PERIOD_MS);
    const stop = () => {
      if (exit !== undefined) return;
      clearInterval(sample);
      clearTimeout(deadline);
      child.kill("SIGTERM");
      hard = setTimeout(() => child.kill("SIGKILL"), 8000);
    };
    const deadline = setTimeout(() => {
      why = `the host did not close ${windowsToRun} windows within ${ARM_TIMEOUT_MS / 1000}s`;
      stop();
    }, ARM_TIMEOUT_MS);
    const onChunk = (chunk) => {
      const line = chunk.toString("utf8");
      text += line;
      windows += line.split("TN_FRAME_BUDGET:").length - 1;
      if (windows >= windowsToRun) {
        why = `${windowsToRun} frame-budget windows closed`;
        stop();
      }
    };
    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (error) => {
      why = `could not spawn ${executable}: ${error.message}`;
      stop();
    });
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      clearTimeout(hard);
      writeFileSync(log, text);
      settle({
        exit: code,
        signal,
        windows,
        rss,
        why: why ?? `the host exited (${code ?? signal})`,
      });
    });
  });
}

/**
 * The meters, per arm, in the shape the report publishes.
 *
 * The last steady window is the headline and the median across the steady windows sits beside it:
 * under a loaded machine a single window is one sample of a noisy process, and printing only it
 * would be the flattering choice the PRD forbids.
 */
function perfNumbers(perf) {
  const steady = perf.budgets.filter((w) => !perf.discardedWindows.includes(w.window));
  const last = steady.at(-1) ?? perf.budgets.at(-1);
  const median = (pick) => {
    const values = steady
      .map(pick)
      .filter((value) => typeof value === "number")
      .sort((a, b) => a - b);
    return values.length === 0 ? undefined : values[values.length >> 1];
  };
  const phase = (name, key) => last?.phases?.[name]?.[key];
  const gpu = steady.map((w) => w.gpuMs).filter((value) => typeof value === "number");
  return {
    windows: perf.budgets.length,
    discardedWindows: perf.discardedWindows,
    steady: steady.map((w) => w.window),
    framesPerWindow: last?.frames,
    presentsPerWindow: last?.presents,
    frame: last?.frame,
    render: last?.phases?.render,
    ui: last?.phases?.ui,
    hostGap: last?.phases?.hostGap,
    update: last?.phases?.update,
    overlay: last?.phases?.overlay,
    residual: last?.phases?.residual,
    medianAcrossSteadyWindows: {
      frameP50: median((w) => w.frame?.p50),
      frameP95: median((w) => w.frame?.p95),
      frameP99: median((w) => w.frame?.p99),
      renderP50: median((w) => w.phases?.render?.p50),
      uiP50: median((w) => w.phases?.ui?.p50),
      uiP95: median((w) => w.phases?.ui?.p95),
      uiP99: median((w) => w.phases?.ui?.p99),
    },
    gpuMs:
      gpu.length === 0
        ? undefined
        : { windows: gpu.length, median: gpu.sort((a, b) => a - b)[gpu.length >> 1] },
    presents: perf.presents.at(-1),
    hostGapSegments: perf.hostGaps.at(-1)?.segments,
    hitches: perf.hitches.map((h) => ({
      window: h.window,
      p50: h.p50Ms,
      p99: h.p99Ms,
      max: h.maxMs,
    })),
    display: perf.display,
    violations: perf.violations,
    pass: perf.pass,
    uiPhaseLastP99: phase("ui", "p99"),
  };
}

/**
 * The backend identity, from the host's own log — the same assertions
 * `scripts/verify-desktop.mjs` and `corpus/desktop.mjs` make, because they are the whole claim
 * that no web view is involved. A rejected mutation batch is a silent half-tree, and its absence is
 * an assertion rather than an observation.
 */
function hostIdentity(lines) {
  const composites = lines.filter((line) => line.startsWith("TN_UI_COMPOSITE:"));
  const attach = lines.find((line) => line.startsWith("TN_UI_OVERLAY:{"));
  const attached = attach?.includes('"attached":true') ?? false;
  return {
    backend: lines.find((line) => line.includes("ui overlay:"))?.trim(),
    attached,
    attachReason: attached ? undefined : attach?.slice(0, 200),
    webView: lines.filter(
      (line) =>
        /webkit|webview|wry|chromium process|TN_UI_LOAD_FAILED/iu.test(line) &&
        !line.includes("no WebView"),
    ).length,
    rejected: lines.filter((line) => line.includes("TN_CSS_UI_POST_REJECTED")).length,
    errors: lines.filter((line) => /^\[(?:error|Error)\]/u.test(line.trimStart())),
    adapter: lines.find((line) => line.startsWith("[WebGPU] Adapter:"))?.split(": ")[1],
    vendor: lines.find((line) => line.startsWith("[WebGPU] Vendor:"))?.split(": ")[1],
    gpuBackend: lines.find((line) => line.startsWith("[WebGPU] Backend:"))?.split(": ")[1],
    webgpuFeatures: lines.find((line) => line.includes("TN_WEBGPU_FEATURES"))?.slice(0, 300),
    version: lines.find((line) => line.startsWith("Version: "))?.slice("Version: ".length),
    window: lines.find((line) => line.startsWith("[Window] Actual window size:"))?.split(": ")[1],
    compositeLines: composites.length,
  };
}

/** What the host did with the UI's pixels: uploads, skips, and how many page frames existed. */
function compositeStats(lines) {
  const traces = [];
  for (const line of lines) {
    const start = line.indexOf(`${TRACE}:`);
    if (start === -1) continue;
    try {
      traces.push(JSON.parse(line.slice(start + TRACE.length + 1)));
    } catch {
      // A malformed trace is the finding; the caller counts composites and this arm's numbers
      // say nothing about how many page frames were published.
    }
  }
  const summary = lines.filter((line) => line.startsWith("TN_UI_COMPOSITE:"));
  const payload = parses(summary.at(-1)?.slice("TN_UI_COMPOSITE:".length) ?? "");
  return {
    /** Every composite the host reached — the frames the UI layer ran for. */
    composites: traces.length,
    /** Distinct page-frame counters: how many times the UI actually produced a frame. */
    published: new Set(traces.map((trace) => trace.counter)).size,
    /** Of those, how many were uploaded rather than skipped as unchanged. */
    uploaded: traces.filter((trace) => trace.uploaded === true).length,
    firstAtMs: traces[0]?.atMs,
    lastAtMs: traces.at(-1)?.atMs,
    frameSize: payload?.frame,
    cumulativeUploads: payload?.uploads,
    cumulativeSkipped: payload?.skipped,
    summaryLines: summary.length,
  };
}

/** `TN_COLD_START` on one monotonic clock: the launch, and what a reader subtracts from it. */
function coldStartSegments(lines) {
  const at = {};
  const counts = {};
  for (const line of lines) {
    const start = line.indexOf("TN_COLD_START:");
    if (start === -1) continue;
    const payload = parses(line.slice(start + "TN_COLD_START:".length));
    if (payload?.segment === undefined) continue;
    // `compile_*` and `execute_*` are stamped once per evaluated module, so the launch is the
    // first of each segment, never the last: the last one is whichever module happened to be
    // evaluated last. The count is kept beside it, because a reader who sees one compile and
    // expects the other twenty-three should know they are there.
    counts[payload.segment] = (counts[payload.segment] ?? 0) + 1;
    at[payload.segment] ??= payload.atMs;
  }
  const origin = at.process ?? at.runtime_created;
  const offset = (segment) =>
    origin === undefined || at[segment] === undefined ? undefined : round(at[segment] - origin);
  const firstUiComposite = compositeStats(lines).firstAtMs;
  return {
    at,
    counts,
    fromProcessMs: {
      firstFrame: offset("first_frame"),
      firstPlayable: offset("first_playable"),
      uiOverlayAttached: offset("ui_overlay_attached"),
      gameEvalBegin: offset("game_eval_begin"),
    },
    /** Cold start to first *UI* frame: the first composite the UI layer published a page into. */
    firstUiCompositeMs:
      origin === undefined || firstUiComposite === undefined
        ? undefined
        : round(firstUiComposite - origin),
    note: "one monotonic clock inside the process (cold_start.h); `process` is the origin",
  };
}

/** The game's own `TN_BENCH` lines: frames run, React posts, mutation ops, mutation bursts. */
function benchLines(lines) {
  const entries = [];
  for (const line of lines) {
    const start = line.indexOf("TN_BENCH:");
    if (start === -1) continue;
    const payload = parses(line.slice(start + "TN_BENCH:".length));
    if (payload?.frames !== undefined) entries.push(payload);
  }
  return {
    lines: entries.length,
    last: entries.at(-1),
    /** Posts and ops are cumulative for the run; the delta across the measured window is the work. */
    posts: entries.at(-1)?.posts,
    ops: entries.at(-1)?.ops,
    mutations: entries.at(-1)?.mutations,
  };
}

function printTable(report) {
  console.log("");
  console.log(
    `SMOKE RUN under load (${report.machine.loadavgAtStart} at start, ${report.loadavgAtEnd} at end). No fps: the display is a private Xvfb.`,
  );
  console.log(
    [
      pad("arm", 19),
      pad("status", 12),
      pad("frames", 7),
      pad("frame p50/95/99", 17),
      pad("render p50", 10),
      pad("ui p50/95", 13),
      pad("gpu ms", 7),
      pad("UI pub/up", 12),
      pad("rss MB", 15),
      pad("exe MB", 7),
    ].join(" "),
  );
  for (const [name, entry] of Object.entries(report.arms)) {
    const steady = entry.perf?.frame;
    const median = entry.perf?.medianAcrossSteadyWindows;
    console.log(
      [
        pad(name, 19),
        pad(entry.status, 12),
        pad(entry.game?.last?.frames, 7),
        pad(`${num(steady?.p50, 1)}/${num(steady?.p95, 1)}/${num(steady?.p99, 1)}`, 17),
        pad(num(entry.perf?.render?.p50), 10),
        pad(`${num(median?.uiP50)}/${num(median?.uiP95)}`, 13),
        pad(entry.perf?.gpuMs === undefined ? "absent" : num(entry.perf.gpuMs.median), 7),
        pad(`${entry.uiComposite?.published ?? "-"}/${entry.uiComposite?.uploaded ?? "-"}`, 12),
        pad(
          `${round(entry.rss?.startKb / 1024)}→${round(entry.rss?.peakKb / 1024)}→${round(entry.rss?.lastKb / 1024)}`,
          15,
        ),
        pad(round((entry.sizes?.executableBytes ?? 0) / 1e6), 7),
      ].join(" "),
    );
    if (entry.why !== undefined) console.log(`  ${name}: ${entry.why}`);
  }
  console.log("");
  console.log("medians across the steady windows (the column the arms compare on):");
  for (const [name, entry] of Object.entries(report.arms)) {
    const m = entry.perf?.medianAcrossSteadyWindows;
    if (m === undefined) continue;
    console.log(
      `  ${pad(name, 19)} frame p50/p95/p99 ${num(m.frameP50)}/${num(m.frameP95)}/${num(m.frameP99)} ms · render p50 ${num(m.renderP50)} ms · ui p50/p95/p99 ${num(m.uiP50)}/${num(m.uiP95)}/${num(m.uiP99)} ms`,
    );
  }
}

function summary(entry) {
  const m = entry.perf.medianAcrossSteadyWindows;
  return [
    "measured",
    `frame p50/p95/p99 ${num(m.frameP50)}/${num(m.frameP95)}/${num(m.frameP99)} ms (medians of ${entry.perf.steady.length} steady windows)`,
    `render p50 ${num(entry.perf.render?.p50)} ms`,
    `ui composite p50/p95/p99 ${num(m.uiP50)}/${num(m.uiP95)}/${num(m.uiP99)} ms`,
    entry.perf.gpuMs === undefined
      ? "gpu ms: not reported"
      : `gpu ms ${num(entry.perf.gpuMs.median)}`,
    `UI frames published ${entry.uiComposite.published}, uploaded ${entry.uiComposite.uploaded} of ${entry.uiComposite.composites} composites`,
    // The host's own frames-versus-presents counter, and the only GPU resource census it publishes.
    tick(entry),
    `react posts ${entry.game.posts}, ops ${entry.game.ops}, mutation bursts ${entry.game.mutations}`,
    `rss ${round(entry.rss.startKb / 1024)}→${round(entry.rss.peakKb / 1024)}→${round(entry.rss.lastKb / 1024)} MB over ${entry.rss.samples} samples`,
    `exe ${round(entry.sizes.executableBytes / 1e6)} MB, container ${round(entry.sizes.containerBytes / 1e6)} MB`,
    `cold start to first frame ${entry.coldStart.fromProcessMs.firstFrame ?? "-"} ms, first UI composite ${entry.coldStart.firstUiCompositeMs ?? "-"} ms`,
  ].join("\n  ");
}

/** `TN_PRESENTS_TICK`: loop frames against presents, and the GPU resources the host counts. */
function tick(entry) {
  const last = entry.perf?.presents;
  if (last === undefined) return "presents tick: not reported by this host";
  const buffers = last.bufferMB === undefined ? "" : `, ${last.bufferMB} MB buffers`;
  const resources =
    last.textures === undefined
      ? "gpu resources not counted"
      : `gpu resources ${last.textures} textures / ${last.textureMB ?? "?"} MB${buffers}`;
  return `loop frames ${last.frames}, presents ${last.presents} (cap ${last.capHz ?? "?"} Hz); ${resources}`;
}

function parseArgs(argv) {
  const parsed = { frames: 1000 };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--frames") {
      parsed.frames = Number(value);
      if (!Number.isInteger(parsed.frames) || parsed.frames <= 0) {
        throw new Error(`TN_BENCH_ARG: --frames needs a positive integer, got '${value}'`);
      }
      index += 1;
    } else if (flag === "--arms") {
      parsed.arms = String(value)
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean);
      index += 1;
    } else if (flag === "--help" || flag === "-h") {
      console.log("usage: node bench/run.mjs [--frames N] [--arms a,b]");
      process.exit(0);
    } else {
      throw new Error(`TN_BENCH_ARG: unknown flag '${flag}'`);
    }
  }
  return parsed;
}

/**
 * One command, and the extra environment variables it needs as `[name, value]` pairs.
 *
 * Pairs rather than an object because an environment variable's spelling is not camelCase and the
 * repo's naming convention is; the two are not in conflict here.
 */
function run(command, argv, cwd, variables = []) {
  const env = { ...process.env };
  for (const [name, value] of variables) env[name] = value;
  const result = spawnSync(command, argv, {
    cwd,
    encoding: "utf8",
    env,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function parses(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function tail(text, lines = 3) {
  return String(text ?? "")
    .split("\n")
    .slice(-lines)
    .join(" | ")
    .slice(0, 400);
}

function rssKb(pid) {
  if (pid === undefined) return 0;
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    return Number(firstMatch(status, /^VmRSS:\s+(\d+) kB/mu) ?? 0);
  } catch {
    return 0;
  }
}

function dirBytes(dir) {
  const result = spawnSync("du", ["-sb", dir], { encoding: "utf8" });
  return Number(result.stdout.split(/\s+/u)[0] ?? 0);
}

function fileBytes(file) {
  try {
    return readFileSync(file).length;
  } catch {
    return 0;
  }
}

function round(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value * 100) / 100
    : value;
}

function firstMatch(text, pattern) {
  return pattern.exec(text)?.[1];
}

function osRelease() {
  try {
    const line = readFileSync(join("/etc", "os-release"), "utf8")
      .split("\n")
      .find((row) => row.startsWith("PRETTY_NAME="));
    return line?.slice("PRETTY_NAME=".length).replaceAll('"', "");
  } catch {
    return undefined;
  }
}

/** The GPU and its driver, from the one tool that answers without a WebGPU adapter in reach. */
function gpu() {
  const result = spawnSync(
    "nvidia-smi",
    ["--query-gpu=name,driver_version", "--format=csv,noheader"],
    { encoding: "utf8" },
  );
  if (result.status === 0) return result.stdout.trim().split("\n")[0];
  const lspci = spawnSync("lspci", { encoding: "utf8" });
  return lspci.status === 0
    ? lspci.stdout
        .split("\n")
        .find((line) => /vga|3d controller|display/iu.test(line))
        ?.replaceAll(/\s+/gu, " ")
    : undefined;
}

function hostPresent() {
  return Object.values(hosts).some((path) => existsSync(path));
}

/**
 * Take the shared GPU lane, and say so when it is held.
 *
 * The machine is shared: CI runners and the owner's game both use it, and a benchmark that runs
 * beside them reports numbers that are really about the neighbours. A held lane is a warning, not
 * a failure — the report carries the load average either way, and a reader who needs a quiet
 * machine should wait for the lane.
 */
function claim() {
  if (!existsSync(pipeline)) return false;
  const result = spawnSync("bash", [pipeline, "claim", "gpu-desktop-verify", "native-css bench"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.warn(
      `TN_BENCH_LANE_HELD: ${(result.stderr ?? "").trim()} — continuing, and reporting the load`,
    );
    return false;
  }
  return true;
}

function release(claimed) {
  if (!claimed) return;
  spawnSync("bash", [pipeline, "release", "gpu-desktop-verify"], { encoding: "utf8" });
}
