// PRD-770: `pnpm stress:loop fair <engine=url>...`, one fair, workload-equal engine window.
//
//   pnpm stress:loop fair threenative-wasm='http://127.0.0.1:5740/main.html?stress' \
//     threenative-wasm='http://127.0.0.1:5740/main.html?stress&plainShadow' three-vanilla='http://127.0.0.1:5736/main.html?stress'
//
// The arms run in ABBA order (the list, then the list reversed) in one clean browser: a fresh profile, 1280x720 at
// DPR 1, no profiler, no tracing. The window holds the measurement lock and the build lock, waits for the GPU slot,
// starts only after the 1-minute load stays under 4 for 60 s, and voids a run whose load rises above 6. A second
// browser repeats the arms uncapped (`--disable-frame-rate-limit --disable-gpu-vsync`), so FPS above 60 shows.
// Each arm's valid runs are pooled (mean) into one ledger row per pass.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENGINES,
  LOAD_VOID,
  QUIET_LOAD,
  readLedger,
  recordRun,
  writeLedger,
} from "./stress-loop.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIR = process.env.TN_STRESS_DIR ?? join(homedir(), ".cache/tmp-tn/stress-loop");
const SLOT = process.env.TN_GPU_SLOT ?? join(homedir(), ".cache/tmp-tn/gpu-measure.owner");
const BRAVE_FLAGS = [
  "--enable-unsafe-webgpu",
  "--disable-gpu-sandbox",
  "--ignore-gpu-blocklist",
  "--enable-features=Vulkan",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-features=Translate,AcceptCHFrame,MediaRouter",
  "--force-device-scale-factor=1",
];
const UNCAPPED_FLAGS = ["--disable-frame-rate-limit", "--disable-gpu-vsync"];
const PASSES = { vsync: [], uncapped: UNCAPPED_FLAGS };

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const GPU_IDLE_PERCENT = 10;
export const readLoad = () => Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]);

/** The arms, then the arms reversed: A B C C B A. A drift in the host moves both ends of every arm equally. */
export const abba = (arms) => [...arms, ...[...arms].reverse()];

/** `engine=url` to the engine key, the URL, and the URL flags beyond `?stress` as the ledger variant. */
export function parseArm(spec) {
  const split = spec.indexOf("=");
  const engine = spec.slice(0, split);
  const url = spec.slice(split + 1);
  if (split < 1 || !ENGINES.some((item) => item.key === engine))
    throw new Error(
      `arm "${spec}" must be <engine>=<url>, engine one of ${ENGINES.map((item) => item.key).join(", ")}`,
    );
  // A flag with a value keeps it (`arm=develop`): two arms of one engine are told apart by it alone.
  const flags = [...new URL(url).searchParams]
    .filter(([key]) => key !== "stress")
    .map(([key, value]) => (value === "" ? key : `${key}=${value}`));
  return { engine, url, variant: flags.length === 0 ? "stress" : flags.join("&") };
}

/**
 * Resolves once the 1-minute load stayed under `quiet` for `holdMs` in a row; throws after `timeoutMs`.
 * A holder that waits for an idle host inside the lock must time out, or it blocks every lane (PRD-770, State left).
 */
export async function waitQuiet({
  readLoad: read = readLoad,
  wait = sleep,
  now = Date.now,
  quiet = QUIET_LOAD,
  holdMs = 60_000,
  pollMs = 5000,
  timeoutMs = 20 * 60_000,
  log = () => undefined,
} = {}) {
  const start = now();
  let quietSince;
  for (;;) {
    const load = read();
    if (load < quiet) quietSince ??= now();
    else quietSince = undefined;
    if (quietSince !== undefined && now() - quietSince >= holdMs) return load;
    if (now() - start >= timeoutMs)
      throw new Error(
        `host load stayed at or above ${quiet} (last ${load}) for ${Math.round(timeoutMs / 60_000)} min; lock released`,
      );
    log(`load ${load}, waiting for ${holdMs / 1000} s under ${quiet}`);
    await wait(pollMs);
  }
}

/** The busiest GPU's utilization in percent, from nvidia-smi. Throws when it cannot be read: no reading is no idle GPU. */
export function readGpuUtilization() {
  const run = spawnSync(
    "nvidia-smi",
    ["--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"],
    { encoding: "utf8" },
  );
  const values = run.stdout?.split("\n").filter(Boolean).map(Number) ?? [];
  if (run.status !== 0 || values.length === 0 || values.some((value) => !Number.isFinite(value)))
    throw new Error(
      `cannot read GPU utilization from nvidia-smi: ${run.stderr || run.error || "no output"}`,
    );
  return Math.max(...values);
}

/** Resolves once the GPU stayed under `limit` percent for `holdMs`; throws after `timeoutMs`. Fail closed before a run. */
export async function waitGpuIdle({
  read = readGpuUtilization,
  wait = sleep,
  now = Date.now,
  limit = GPU_IDLE_PERCENT,
  holdMs = 5000,
  pollMs = 1000,
  timeoutMs = 10 * 60_000,
  log = () => undefined,
} = {}) {
  const start = now();
  let idleSince;
  for (;;) {
    const busy = read();
    if (busy < limit) idleSince ??= now();
    else idleSince = undefined;
    if (idleSince !== undefined && now() - idleSince >= holdMs) return busy;
    if (now() - start >= timeoutMs)
      throw new Error(
        `GPU stayed at or above ${limit}% (last ${busy}%) for ${Math.round(timeoutMs / 60_000)} min: another page or job shares it; run refused`,
      );
    log(`GPU ${busy}%, waiting for ${holdMs / 1000} s under ${limit}%`);
    await wait(pollMs);
  }
}

/**
 * Closes every page that is not about:blank and returns their URLs. A stray stress page left in a browser renders on
 * the same GPU and voids every run beside it (2026-10-30 07:30-09:20Z). `pages` lists { id, url }.
 */
export async function closeStrayPages({ pages, close }) {
  const strays = (await pages()).filter((page) => page.url !== "about:blank");
  for (const page of strays) await close(page);
  return strays.map((page) => page.url);
}

/** The page lists of a CDP browser over HTTP, without attaching a DevTools session. */
const cdpPages = (endpoint) => ({
  pages: async () =>
    (await (await fetch(`${endpoint}/json/list`)).json()).filter(
      (target) => target.type === "page",
    ),
  close: (page) => fetch(`${endpoint}/json/close/${page.id}`),
});

/** Before a run: the measurement browser and the shared hunt browser hold no stray page and the GPU is idle. */
async function clearForRun(browser, options, log) {
  const closed = [];
  for (const context of browser.contexts())
    for (const page of context.pages())
      if (page.url() !== "about:blank") {
        closed.push(page.url());
        await page.close();
      }
  try {
    closed.push(...(await closeStrayPages(cdpPages(options.huntCdp))));
  } catch {
    // no hunt browser on this machine: nothing there to clear
  }
  if (closed.length > 0) log(`closed stray pages: ${closed.join(", ")}`);
  await waitGpuIdle({ timeoutMs: options.gpuTimeoutMin * 60_000, log });
}

/** Runs `task` while sampling the 1-minute load every `everyMs`. Returns the task's result and every sample. */
export async function withLoadSamples(task, { read = readLoad, everyMs = 10_000 } = {}) {
  const samples = [read()];
  const timer = setInterval(() => samples.push(read()), everyMs);
  try {
    return { value: await task(), load: [...samples, read()] };
  } finally {
    clearInterval(timer);
  }
}

const mean = (values) =>
  values.some((value) => typeof value !== "number")
    ? null
    : Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 1000) / 1000;

/** The mean of an object's numeric fields across runs; a field null in any run stays null (never defaulted). */
const meanFields = (objects) =>
  Object.fromEntries(
    Object.keys(objects[0]).map((key) => [key, mean(objects.map((object) => object[key]))]),
  );

/**
 * One wrapper from an arm's runs: void runs (load above 6) leave out, the rest are averaged field by field.
 * Every valid run must carry the same build, or the arm changed mid-window. Returns undefined with no valid run.
 */
export function poolRuns(runs) {
  const valid = runs.filter((run) => Math.max(...run.load) <= LOAD_VOID);
  if (valid.length === 0) return undefined;
  const [first] = valid;
  if (
    valid.some(
      (run) => run.build.sha256 !== first.build.sha256 || run.build.commit !== first.build.commit,
    )
  )
    throw new Error(`arm ${first.url} served different builds within one window`);
  const report = { ...first.report, metrics: meanFields(valid.map((run) => run.report.metrics)) };
  if (first.report.extra !== undefined)
    report.extra = meanFields(valid.map((run) => run.report.extra));
  return {
    ...first,
    runs: valid.length,
    voidRuns: runs.length - valid.length,
    load: valid.flatMap((run) => run.load),
    report,
  };
}

const sha12 = (...bodies) => {
  const hash = createHash("sha256");
  for (const body of bodies) hash.update(body);
  return hash.digest("hex").slice(0, 12);
};

function playwright() {
  const fromTest = createRequire(
    realpathSync(join(ROOT, "node_modules/@playwright/test/package.json")),
  );
  return fromTest("playwright-core");
}

async function launchBrowser({ pass, browser: executable }) {
  const profile = mkdtempSync(join(tmpdir(), "tn-fair-"));
  const child = spawn(
    executable,
    [
      ...BRAVE_FLAGS,
      ...PASSES[pass],
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 60 && !existsSync(portFile); i += 1) await sleep(500);
  if (!existsSync(portFile)) {
    child.kill("SIGKILL");
    throw new Error(`${executable} did not open a DevTools port in 30 s`);
  }
  const port = readFileSync(portFile, "utf8").split("\n")[0];
  const connected = await playwright().chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  return {
    browser: connected,
    async close() {
      await connected.close().catch(() => undefined);
      child.kill("SIGTERM");
      await sleep(1000);
      child.kill("SIGKILL");
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

/** One timing run: a fresh page at 1280x720, nothing attached but the page's own report. */
async function measureArm(browser, arm, { pass, settle, commit }) {
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  const scripts = [];
  let wasm;
  page.on("response", (response) => {
    const url = response.url();
    if (url.endsWith(".wasm")) wasm = response.body().then((body) => sha12(body));
    else if (
      response.request().resourceType() === "script" &&
      url.startsWith(new URL(arm.url).origin)
    )
      scripts.push(response.body().then((body) => [url, body]));
  });
  try {
    await page.setViewportSize({ width: 1280, height: 720 });
    const t0 = Date.now();
    const { load } = await withLoadSamples(async () => {
      await page.goto(arm.url, { waitUntil: "load", timeout: 120_000 });
      await page.waitForTimeout(settle * 1000);
    });
    const report = await page.evaluate(() => globalThis.__TN_STRESS__ ?? null);
    if (!report?.metrics) throw new Error(`no __TN_STRESS__ report on ${arm.url}`);
    const dpr = await page.evaluate(() => devicePixelRatio);
    const adapterInfo = await page.evaluate(async () => {
      const info = (await navigator.gpu?.requestAdapter())?.info;
      return info
        ? [info.vendor, info.architecture, info.description].filter(Boolean).join(" / ")
        : "";
    });
    const bundle = (await Promise.all(scripts)).sort(([a], [b]) => a.localeCompare(b));
    const build =
      wasm === undefined
        ? { kind: "js", sha256: sha12(...bundle.map(([, body]) => body)), commit }
        : { kind: "wasm", sha256: await wasm, commit };
    return {
      ...arm,
      at: new Date().toISOString(),
      wallSeconds: (Date.now() - t0) / 1000,
      pass,
      dpr,
      adapterInfo,
      build,
      load,
      report,
    };
  } finally {
    await page.goto("about:blank").catch(() => undefined);
    await page.close().catch(() => undefined);
  }
}

/** Waits for the GPU slot other sessions share (as measure.sh does), then takes it. Returns the release function. */
async function takeSlot(minutes, log) {
  while (existsSync(SLOT)) {
    const [owner, start, held] = readFileSync(SLOT, "utf8").trim().split(" ");
    if (Date.now() > Date.parse(start) + Number(held) * 60_000) break;
    log(`GPU slot held by ${owner}, waiting`);
    await sleep(15_000);
  }
  const mine = `fair ${new Date().toISOString()} ${minutes}`;
  writeFileSync(SLOT, `${mine}\n`);
  return () => {
    if (existsSync(SLOT) && readFileSync(SLOT, "utf8").startsWith("fair "))
      rmSync(SLOT, { force: true });
  };
}

function parseArgs(argv) {
  const flags = {};
  const specs = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--no-record") flags["no-record"] = "1";
    else if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else specs.push(argv[i]);
  }
  const passes = (flags.passes ?? "vsync,uncapped").split(",");
  if (passes.some((pass) => !(pass in PASSES)))
    throw new Error(`--passes must list ${Object.keys(PASSES).join(", ")}`);
  if (specs.length === 0) throw new Error("fair needs at least one <engine>=<url> arm");
  return {
    arms: specs.map(parseArm),
    passes,
    tag: flags.tag ?? new Date().toISOString().slice(0, 16).replace(/\D/gu, ""),
    settle: Number(flags.settle ?? 80),
    lockWait: Number(flags["lock-wait"] ?? 3600),
    locked: flags.locked !== undefined,
    huntCdp: flags["hunt-cdp"] ?? "http://127.0.0.1:9333",
    gpuTimeoutMin: Number(flags["gpu-timeout"] ?? 10),
    quietTimeoutMin: Number(flags["quiet-timeout"] ?? 20),
    maxMinutes: Number(flags["max-minutes"] ?? 90),
    outDir: flags.out ?? join(DIR, "hunt"),
    browser: flags.browser ?? join(homedir(), ".local/bin/brave"),
    commit:
      flags.commit ??
      spawnSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], {
        encoding: "utf8",
      }).stdout.trim(),
    record: flags["no-record"] === undefined,
  };
}

/** Re-runs the command under both locks. `-o` keeps the lock fd out of the browser, `-w` ends a too-long queue. */
function runLocked(argv, { lockWait }) {
  const wait = String(lockWait);
  const run = spawnSync(
    "flock",
    [
      "-o",
      "-w",
      wait,
      join(DIR, "measure.lock"),
      "flock",
      "-o",
      "-w",
      wait,
      join(DIR, "build.lock"),
    ].concat([
      process.execPath,
      join(ROOT, "scripts/stress-loop.mjs"),
      "fair",
      ...argv,
      "--locked",
      "1",
    ]),
    { stdio: "inherit" },
  );
  process.exit(run.status ?? 1);
}

/** A file-safe name from the tag, the pass and the arm's URL (host, port and flags). */
export const fileName = (tag, pass, key, index) =>
  `fair-${tag}-${pass}-${index === undefined ? "" : `run${index}-`}${key.replace(/^(\S+) https?:\/\//u, "$1 ").replace(/\W+/gu, "-")}.json`;

/** Writes one run as soon as it ends, before any pooling check can throw: a refused window still leaves its evidence. */
export function saveRun(options, pass, index, run) {
  writeFileSync(
    join(options.outDir, fileName(options.tag, pass, `${run.engine} ${run.url}`, index)),
    JSON.stringify(run),
  );
}

/** One pass in one fresh browser: every arm in ABBA order, pooled per arm into a wrapper file. */
async function measurePass(pass, options, order, { open, log }) {
  const { browser, close } = await launchBrowser({ pass, browser: options.browser });
  open.push(close);
  const runs = new Map();
  try {
    for (const arm of order) {
      // One bad arm must not throw away the minutes the other arms already measured (and the queue wait before them).
      await clearForRun(browser, options, log);
      const run = await measureArm(browser, arm, {
        pass,
        settle: options.settle,
        commit: options.commit,
      }).catch((error) => {
        log(`${pass} ${arm.engine} ${arm.variant}: run failed, left out: ${error.message}`);
      });
      if (run === undefined) continue;
      const peak = Math.max(...run.load);
      const { fps, frameP50Ms, gpuP95Ms } = run.report.metrics;
      log(
        `${pass} ${arm.engine} ${arm.variant}: fps ${fps} frame p50 ${frameP50Ms} gpu p95 ${gpuP95Ms} load peak ${peak}${peak > LOAD_VOID ? " VOID" : ""}`,
      );
      saveRun(options, pass, order.indexOf(arm), run);
      // By URL: two arms of one engine and the same flag keys are still two arms.
      runs.set(arm.url, [...(runs.get(arm.url) ?? []), run]);
    }
  } finally {
    open.pop();
    await close();
  }
  const rows = [];
  for (const [url, list] of runs) {
    const pooled = poolRuns(list);
    if (pooled === undefined) {
      log(`${pass} ${url}: every run void, no row`);
      continue;
    }
    const file = join(options.outDir, fileName(options.tag, pass, `${list[0].engine} ${url}`));
    writeFileSync(file, JSON.stringify(pooled));
    rows.push({ pass, pooled, file });
  }
  return rows;
}

function recordRows(rows, options, ledgerPath, log) {
  let ledger = readLedger(ledgerPath);
  for (const { pass, pooled, file } of rows) {
    const variant = pass === "vsync" ? pooled.variant : `${pooled.variant}&${pass}`;
    ledger = recordRun(
      ledger,
      { ...pooled, pass },
      {
        engine: pooled.engine,
        variant,
        label: `FAIR window ${options.tag} (${variant})`,
        decision: "measure",
        notes: `fair window ${options.tag}: clean browser, 1280x720 DPR ${pooled.dpr}, ${options.settle} s, ABBA, ${pass} pass, mean of ${pooled.runs} run(s) (${pooled.voidRuns} void), load peak ${Math.max(...pooled.load)}, runs ${file}`,
      },
    );
    log(`row #${ledger.iterations.at(-1).id} ${pooled.engine} ${variant}`);
  }
  writeLedger(ledgerPath, ledger);
}

export async function runFair(argv, { ledgerPath }) {
  const options = parseArgs(argv);
  if (!options.locked) runLocked(argv, options);
  const log = (message) => console.log(`fair: ${message}`);
  const order = abba(options.arms);
  const releaseSlot = await takeSlot(
    Math.ceil((order.length * options.passes.length * (options.settle + 20)) / 60) + 5,
    log,
  );
  const open = [];
  const cleanup = async () => {
    releaseSlot();
    await Promise.all(open.map((close) => close()));
  };
  const watchdog = setTimeout(() => {
    log(`window passed ${options.maxMinutes} min, aborting and releasing the locks`);
    cleanup().finally(() => process.exit(3));
  }, options.maxMinutes * 60_000);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => cleanup().finally(() => process.exit(130)));
  try {
    log(`waiting for load < ${QUIET_LOAD} for 60 s`);
    await waitQuiet({ timeoutMs: options.quietTimeoutMin * 60_000, log });
    mkdirSync(options.outDir, { recursive: true });
    const rows = [];
    for (const pass of options.passes)
      rows.push(...(await measurePass(pass, options, order, { open, log })));
    if (options.record) recordRows(rows, options, ledgerPath, log);
  } finally {
    clearTimeout(watchdog);
    await cleanup();
  }
}
