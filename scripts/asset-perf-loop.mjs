#!/usr/bin/env node
// PRD-729: the asset pipeline's performance loop — smallest shipped bytes, fastest preload.
//
//   sh scripts/xvfb.sh node scripts/asset-perf-loop.mjs measure --label "default cook" [--arm default|none] [--config '{"textures":{"quality":96}}'] [--decision keep] [--notes ...] [--dry-run] [--no-preload]
//   node scripts/asset-perf-loop.mjs show
//   node scripts/asset-perf-loop.mjs discard --iteration 3 --reason "dirty tree"
//   node scripts/asset-perf-loop.mjs decide --iteration 5 --decision keep|reject --reason "..."
//   node scripts/asset-perf-loop.mjs snapshot   # the built packages/assets becomes the --pair control
//   pnpm dashboard   # the Asset perf tab renders the ledger live and reloads when it changes (PRD-751)
//
// `measure` copies the shipped template assets (the corpus) into a fresh temporary project, runs a
// cold `compileAssets` with the arm's config and records what the bake shipped. Build
// `@threenative/assets` first: `pnpm --filter "@threenative/assets..." build`. docs/asset-perf/ledger.json
// is the durable record; the hub's Asset perf tab renders it, as in the CI speed loop.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { THROTTLED, measurePreload } from "./asset-preload-probe.mjs";
import {
  discardIteration,
  esc,
  isLive,
  lineChart,
  meetsGoal,
  progressToward,
  readLedger,
  writeAtomic,
} from "./ci-speed-loop.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = resolve(ROOT, "docs/asset-perf/ledger.json");
/** The ledger is a checked-in file, so it is written the way `biome format` prints it. */
function writeLedger(ledger) {
  writeAtomic(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  execFileSync("pnpm", ["exec", "biome", "format", "--write", relative(ROOT, LEDGER)], {
    cwd: ROOT,
    stdio: "ignore",
  });
}

const TEMPLATES = resolve(ROOT, "packages/create-threenative/templates");
const DECISIONS = [
  "baseline",
  "control",
  "keep",
  "reject",
  "provisional",
  "inconclusive",
  "invalid",
];
const MiB = 1024 * 1024;
const DIST = resolve(ROOT, "packages/assets/dist");
/** The build a `--pair` control cooks with. A code lever needs it: the same code cannot be its own control. */
const CONTROL_DIST = resolve(ROOT, "packages/assets/node_modules/.cache/tn-asset-perf/control");
/** Written while a `measure` runs, so the live page can say what is cooking. */
const RUNNING = join(tmpdir(), "tn-asset-perf-running.json");

/** The corpus: every asset directory the scaffolder ships, keyed by the folder it lands in. */
export const CORPUS = [
  ["shared", resolve(ROOT, "packages/create-threenative/template-assets/assets")],
  ...readdirSync(TEMPLATES, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => [name, join(TEMPLATES, name, "assets")])
    .filter(([, dir]) => statSync(dir, { throwIfNoEntry: false })?.isDirectory()),
];

/** `none` is the uncooked control: every byte as authored. `default` is what a game gets today. */
export const ARMS = {
  default: {},
  none: { textures: "none", models: "none", audio: "none" },
};

/**
 * PRD-729 targets, set from the default cook (iteration #3: 5.37 MiB, 45.1%, 629 ms local, 1705 ms
 * at 40 Mbps). Every goal is lower-is-better. Preload is read from the page's own clock, so it
 * includes a fixed shader compile and first render of about 365 ms; the local goal sits above that.
 * At 40 Mbps the extra time over local is transfer: 1076 ms for 5.37 MiB, 600 ms for 3 MiB.
 */
export const GOALS = [
  {
    key: "shippedMiB",
    short: "Shipped",
    label: "Bytes shipped for the template corpus",
    unit: "MiB",
    goal: 3,
    better: "lower",
  },
  {
    key: "shippedPctOfSource",
    short: "Shipped/source",
    label: "Shipped bytes as a share of source bytes",
    unit: "%",
    goal: 25,
    better: "lower",
  },
  {
    key: "preloadLocalMs",
    short: "Preload local",
    label: "Preload to GPU-ready, localhost",
    unit: "ms",
    goal: 450,
    better: "lower",
  },
  {
    key: "preloadThrottledMs",
    short: "Preload 40 Mbps",
    label: "Preload to GPU-ready, 40 Mbps / 20 ms",
    unit: "ms",
    goal: 1200,
    better: "lower",
  },
];

const KINDS = {
  model: [".glb", ".gltf"],
  texture: [".png", ".jpg", ".jpeg", ".webp", ".hdr", ".ktx2"],
  audio: [".wav", ".ogg", ".mp3", ".flac"],
};
export const kindOf = (path) =>
  path === null
    ? "runtime"
    : (Object.keys(KINDS).find((kind) => KINDS[kind].includes(extname(path).toLowerCase())) ??
      "other");

const round = (value, places = 2) => Math.round(value * 10 ** places) / 10 ** places;

/**
 * What one bake shipped, from the corpus listing and the bake receipt. A source the receipt does
 * not name ships as authored, so its bytes count; an output with no source (the Basis transcoder,
 * shared images) is downloaded too and counts under `runtime`.
 */
export function summarize(sources, receipt) {
  const bySource = new Map(sources.map((s) => [s.path, { ...s, shipped: 0, outputs: 0 }]));
  const runtime = [];
  for (const output of receipt.outputs) {
    const row = output.source === null ? undefined : bySource.get(output.source);
    if (row === undefined) runtime.push(output);
    else {
      row.shipped += output.bytes;
      row.outputs += 1;
    }
  }
  const files = [
    ...[...bySource.values()].map((row) => ({
      path: row.path,
      kind: kindOf(row.path),
      sourceBytes: row.bytes,
      shippedBytes: row.outputs === 0 ? row.bytes : row.shipped,
    })),
    ...runtime.map((output) => ({
      path: output.path,
      kind: kindOf(output.source),
      sourceBytes: 0,
      shippedBytes: output.bytes,
    })),
  ].sort((a, b) => b.shippedBytes - a.shippedBytes || a.path.localeCompare(b.path));
  const kinds = {};
  for (const file of files) {
    kinds[file.kind] ??= { sourceBytes: 0, shippedBytes: 0, files: 0 };
    const kind = kinds[file.kind];
    kind.sourceBytes += file.sourceBytes;
    kind.shippedBytes += file.shippedBytes;
    kind.files += 1;
  }
  const sourceBytes = files.reduce((total, file) => total + file.sourceBytes, 0);
  const shippedBytes = files.reduce((total, file) => total + file.shippedBytes, 0);
  return {
    sourceBytes,
    shippedBytes,
    metrics: {
      shippedMiB: round(shippedBytes / MiB),
      shippedPctOfSource: sourceBytes === 0 ? null : round((100 * shippedBytes) / sourceBytes, 1),
      // Filled by `measure` when the preload probe runs; null renders as "pending".
      preloadLocalMs: null,
      preloadThrottledMs: null,
    },
    kinds,
    files,
  };
}

function listFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** Copy the corpus into a fresh project and cook it cold with `config`. The caller removes it. */
async function cook(config, dist = DIST) {
  const { compileAssets, resolveBasisTranscoder } = await import(
    pathToFileURL(join(dist, "index.js")).href
  );
  const project = mkdtempSync(join(tmpdir(), "tn-asset-perf-"));
  for (const [name, dir] of CORPUS) cpSync(dir, join(project, "assets", name), { recursive: true });
  const sourceRoot = join(project, "assets");
  const sources = listFiles(sourceRoot).map((file) => ({
    path: relative(sourceRoot, file).split("\\").join("/"),
    bytes: statSync(file).size,
  }));
  const started = performance.now();
  // The temporary project has no node_modules; three resolves from the assets package instead.
  const transcoder = resolveBasisTranscoder(resolve(ROOT, "packages/assets"));
  const result = await compileAssets({ cwd: project, config, transcoder });
  const compileMs = Math.round(performance.now() - started);
  if (result.receipt === undefined) throw new Error("compileAssets returned no bake receipt");
  return {
    project,
    sources,
    summary: { ...summarize(sources, result.receipt), compileMs, preload: null },
  };
}

/**
 * Cook `config` and measure it. With `pair`, the current default is cooked too and the two
 * arms' preload runs alternate in one browser, so host load hits both alike; the default's
 * numbers ride along as `pairedControl`. Preload times across separate runs are not comparable.
 */
export async function measure(config, { preload = true, pair = false } = {}) {
  const arms = [];
  try {
    arms.push(await cook(config));
    if (pair) {
      if (!existsSync(CONTROL_DIST))
        throw new Error("--pair needs a control build: run `snapshot` first");
      arms.push(await cook(ARMS.default, CONTROL_DIST));
    }
    if (preload) {
      const entries = arms[0].sources
        .map((source) => ({ path: source.path, kind: kindOf(source.path) }))
        .filter((entry) => entry.kind !== "other");
      const projects = arms.map((arm) => arm.project);
      const local = await measurePreload(projects, entries);
      const throttled = await measurePreload(projects, entries, { network: THROTTLED });
      arms.forEach(({ summary }, index) => {
        summary.metrics.preloadLocalMs = local[index].readyMs;
        summary.metrics.preloadThrottledMs = throttled[index].readyMs;
        summary.preload = { host: hostname(), local: local[index], throttled: throttled[index] };
      });
    }
    const [candidate, control] = arms.map((arm) => arm.summary);
    if (control === undefined) return candidate;
    const { metrics, preload: controlPreload, shippedBytes } = control;
    return { ...candidate, pairedControl: { metrics, preload: controlPreload, shippedBytes } };
  } finally {
    for (const arm of arms) rmSync(arm.project, { recursive: true, force: true });
  }
}

/** Add one measured bake to the ledger. Returns a new ledger; the input is not changed. */
export function appendIteration(
  ledger,
  { measurement, label, arm, config, notes = "", decision, commit = "", dirty = false, at },
) {
  const id = ledger.iterations.reduce((top, item) => Math.max(top, item.id), 0) + 1;
  const chosen = decision ?? (ledger.iterations.length === 0 ? "baseline" : "provisional");
  if (!DECISIONS.includes(chosen))
    throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  const iteration = {
    id,
    at: at ?? new Date().toISOString(),
    commit,
    dirty,
    label,
    notes,
    decision: chosen,
    arm,
    config,
    metrics: Object.fromEntries(GOALS.map(({ key }) => [key, measurement.metrics[key] ?? null])),
    extra: {
      sourceBytes: measurement.sourceBytes,
      shippedBytes: measurement.shippedBytes,
      compileMs: measurement.compileMs ?? null,
      preload: measurement.preload ?? null,
      pairedControl: measurement.pairedControl ?? null,
      kinds: measurement.kinds,
    },
    files: measurement.files,
  };
  return { ...ledger, goals: GOALS, iterations: [...ledger.iterations, iteration] };
}

/** Record the verdict on a measured iteration: the loop measures first and decides after its checks. */
export function decideIteration(ledger, id, decision, reason) {
  if (!DECISIONS.includes(decision))
    throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  if (!ledger.iterations.some((item) => item.id === id)) throw new Error(`no iteration ${id}`);
  return {
    ...ledger,
    iterations: ledger.iterations.map((item) =>
      item.id === id
        ? { ...item, decision, notes: [item.notes, reason].filter(Boolean).join(" | ") }
        : item,
    ),
  };
}

/** The baseline is the first live `baseline` iteration; a `control` arm never becomes it. */
const baselineOf = (live) => live.find((item) => item.decision === "baseline") ?? live[0];
const unit = (value, u) =>
  value === null || value === undefined ? "pending" : `${value}${u === "%" ? "%" : ` ${u}`}`;
const mib = (bytes) => `${(bytes / MiB).toFixed(2)} MiB`;

function bytesTable(latest) {
  const kinds = Object.entries(latest?.extra.kinds ?? {}).sort(
    ([, a], [, b]) => b.shippedBytes - a.shippedBytes,
  );
  const rows = kinds
    .map(
      ([kind, row]) =>
        `<tr><td>${esc(kind)}</td><td class="n">${row.files}</td><td class="n">${mib(row.sourceBytes)}</td><td class="n"><b>${mib(row.shippedBytes)}</b></td><td class="n">${row.sourceBytes === 0 ? "n/a" : `${((100 * row.shippedBytes) / row.sourceBytes).toFixed(1)}%`}</td></tr>`,
    )
    .join("");
  return `<div class="scroll"><table><thead><tr><th>Kind</th><th class="n">Files</th><th class="n">Source</th><th class="n">Shipped</th><th class="n">Shipped/source</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="dim">baseline pending</td></tr>'}</tbody></table></div>`;
}

function fileBars(latest) {
  const files = (latest?.files ?? []).slice(0, 12);
  const max = Math.max(1, ...files.map((f) => Math.max(f.shippedBytes, f.sourceBytes)));
  const body = files
    .map(
      (f) =>
        `<div class="bar"><span class="barname" title="${esc(f.path)}">${esc(f.path)}</span><span class="bartrack"><span class="barsrc" style="width:${((f.sourceBytes / max) * 100).toFixed(1)}%"></span><span class="barfill k-${esc(f.kind)}" style="width:${((f.shippedBytes / max) * 100).toFixed(1)}%"></span></span><span class="barnum">${mib(f.shippedBytes)}</span></div>`,
    )
    .join("");
  return `<figure class="card wide"><figcaption>Largest shipped files, latest iteration <span class="dim">(solid = shipped, pale = source)</span></figcaption>${body || '<p class="dim">baseline pending</p>'}</figure>`;
}

/** Polls the server; reloads when the ledger changes and shows a running `measure`. */
const LIVE_SCRIPT = `<p id="live" class="dim"></p><script>
let seen;
async function tick() {
  const live = document.getElementById("live");
  try {
    const state = await (await fetch("/api/asset-perf", { cache: "no-store" })).json();
    if (seen !== undefined && state.version !== seen) location.reload();
    seen = state.version;
    live.textContent = state.running
      ? \`Measuring "\${state.running.label}" (arm \${state.running.arm}) for \${Math.round((Date.now() - state.running.startedAt) / 1000)} s\`
      : \`Live: reloads when the ledger changes. Last check \${new Date().toLocaleTimeString()}.\`;
  } catch {
    live.textContent = "Server stopped: this page no longer updates.";
  }
}
tick();
setInterval(tick, 2000);
</script>`;

export function renderHtml(ledger, now = new Date(), { serving = false } = {}) {
  const live = ledger.iterations.filter(isLive);
  const latest = live.filter((item) => item.decision !== "control").at(-1);
  const base = baselineOf(live);
  const strip = GOALS.map((goal) => {
    const current = latest?.metrics[goal.key] ?? null;
    const progress = progressToward(goal, base?.metrics[goal.key], current);
    const percent = progress === null ? null : Math.round(progress * 100);
    return `<tr><td>${esc(goal.label)}</td><td>${esc(unit(base?.metrics[goal.key], goal.unit))}</td><td><b>${esc(unit(current, goal.unit))}</b></td><td>≤ ${goal.goal} ${esc(goal.unit)}${goal.provisional ? " <small>provisional</small>" : ""}</td>
<td class="meter"><span class="track"><span class="fill ${meetsGoal(goal, current) ? "ok" : ""}" style="width:${percent ?? 0}%"></span></span> ${percent === null ? "n/a" : `${percent}%`}</td><td>${meetsGoal(goal, current) ? '<span class="pill ok">met</span>' : current === null ? '<span class="pill">pending</span>' : '<span class="pill">open</span>'}</td></tr>`;
  }).join("");
  const history = ledger.iterations
    .map((item) => {
      const cells = GOALS.map(
        (goal) => `<td class="n">${esc(unit(item.metrics[goal.key], goal.unit))}</td>`,
      ).join("");
      const out = item.superseded === undefined ? "" : ` class="out"`;
      const flag =
        item.superseded === undefined
          ? ""
          : `<br><small>superseded: ${esc(item.superseded.reason)}</small>`;
      return `<tr${out}><td>#${item.id}</td><td>${esc(item.at.slice(0, 10))}</td><td>${esc(item.commit)}${item.dirty ? " <small>dirty</small>" : ""}</td><td>${esc(item.label)}${flag}<br><small class="dim">arm ${esc(item.arm)} ${esc(JSON.stringify(item.config))} ${esc(item.notes)}</small></td><td><span class="pill">${esc(item.decision)}</span></td>${cells}<td class="n">${esc(unit(item.extra.compileMs === null ? null : (item.extra.compileMs / 1000).toFixed(1), "s"))}</td></tr>`;
    })
    .join("");
  const trend = live.filter((item) => item.decision !== "control");
  const charts = GOALS.map((goal) => lineChart(goal, trend)).join("");
  const header =
    latest === undefined
      ? "Baseline pending: no iteration recorded yet."
      : `Latest iteration #${latest.id} of ${ledger.iterations.length}: ${esc(latest.label)}.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Asset pipeline performance</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#d9d9d2;--accent:#2f6fed;--ok:#1a8f4c;--miss:#c4452d;--goal:#b7791f;--model:#2f6fed;--texture:#1a8f4c;--audio:#b7791f;--runtime:#8a5cd6}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--fg:#ececE6;--dim:#9b9b94;--card:#1f1f1d;--line:#34342f;--accent:#6c9bff;--ok:#4cc380;--miss:#ef7a63;--goal:#e2b04a;--model:#6c9bff;--texture:#4cc380;--audio:#e2b04a;--runtime:#b48cf2}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 10px;font-size:17px}
.dim,small{color:var(--dim)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13.5px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--dim)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.scroll{overflow-x:auto}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(340px,100%),1fr));gap:12px}
.card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card.wide{grid-column:1/-1}
figcaption{font-weight:600;margin-bottom:4px}
svg{width:100%;height:auto}
.line{fill:none;stroke:var(--accent);stroke-width:2}
.dot.ok{fill:var(--ok)}.dot.miss{fill:var(--miss)}
.goal{stroke:var(--goal);stroke-dasharray:5 4;stroke-width:1.5}.grid{stroke:var(--line)}
.tick{fill:var(--dim);font-size:11px}.goaltext{fill:var(--goal);font-size:11px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}.pill.ok{color:var(--ok);border-color:var(--ok)}
.track{display:inline-block;width:110px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle}
.fill{display:block;height:8px;border-radius:4px;background:var(--accent)}.fill.ok{background:var(--ok)}
.bar{display:grid;grid-template-columns:minmax(120px,34%) 1fr 76px;gap:8px;align-items:center;margin:3px 0}
.barname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.bartrack{position:relative;height:12px}
.barsrc,.barfill{position:absolute;left:0;top:0;height:12px;border-radius:3px;min-width:2px}
.barsrc{background:var(--line)}.barfill{background:var(--accent)}
.k-model{background:var(--model)}.k-texture{background:var(--texture)}.k-audio{background:var(--audio)}.k-runtime{background:var(--runtime)}
.barnum{text-align:right;font-size:12.5px;font-variant-numeric:tabular-nums}
tr.out td{opacity:.55;text-decoration:line-through}tr.out td small{text-decoration:none}
</style></head><body><main>
<h1>Asset pipeline performance</h1>
<p class="dim">${header} Snapshot ${esc(now.toISOString())}. The <code>pnpm dashboard</code> Asset perf tab renders <code>docs/asset-perf/ledger.json</code> on each load. Goal: the template corpus ships as few bytes as it can and preloads to GPU-ready as fast as it can, with no texture below its quality floor (PRD-729).</p>
<h2>Progress toward the goal</h2>
<div class="scroll"><table><thead><tr><th>Metric</th><th>Baseline</th><th>Now</th><th>Goal</th><th>Progress</th><th></th></tr></thead><tbody>${strip}</tbody></table></div>
<h2>Where the bytes go</h2>
${bytesTable(latest)}
<div class="grid3" style="margin-top:12px">${fileBars(latest)}</div>
<h2>Trend per iteration</h2>
<div class="grid3">${charts}</div>
<h2>Iterations</h2>
<div class="scroll"><table><thead><tr><th>#</th><th>Date</th><th>Commit</th><th>Change</th><th>Decision</th>${GOALS.map((g) => `<th class="n">${esc(g.short)}</th>`).join("")}<th class="n">Cook</th></tr></thead><tbody>${history || '<tr><td colspan="10" class="dim">baseline pending</td></tr>'}</tbody></table></div>
</main>${serving ? LIVE_SCRIPT : ""}</body></html>
`;
}

function show(ledger) {
  for (const item of ledger.iterations) {
    const cells = GOALS.map((g) => `${g.key}=${item.metrics[g.key] ?? "pending"}`).join(" ");
    console.log(
      `#${item.id} ${item.at.slice(0, 10)} ${item.decision}${item.superseded ? " (superseded)" : ""} [${item.arm}] ${item.label}\n   ${cells}`,
    );
  }
  if (ledger.iterations.length === 0) console.log("baseline pending: no iterations recorded");
}

/** The running `measure`, or null; a file left by a killed process does not count. */
function running() {
  try {
    const state = JSON.parse(readFileSync(RUNNING, "utf8"));
    process.kill(state.pid, 0);
    return state;
  } catch {
    return null;
  }
}

/** What the hub's Asset perf tab polls: the ledger version and a running `measure`. */
export function liveState() {
  return { version: statSync(LEDGER, { throwIfNoEntry: false })?.mtimeMs ?? 0, running: running() };
}

export { readLedger };

/** `measure`: cook one arm, print it and, unless `--dry-run`, append it to the ledger. */
async function measureCommand(ledger, argv, get) {
  const label = get("--label");
  if (label === undefined) throw new Error("measure needs --label");
  const arm = get("--arm") ?? "default";
  if (!(arm in ARMS)) throw new Error(`--arm must be one of ${Object.keys(ARMS).join(", ")}`);
  const config = { ...ARMS[arm], ...JSON.parse(get("--config") ?? "{}") };
  writeAtomic(RUNNING, JSON.stringify({ label, arm, pid: process.pid, startedAt: Date.now() }));
  const pair = argv.includes("--pair");
  const measurement = await measure(config, {
    preload: !argv.includes("--no-preload"),
    pair,
  }).finally(() => rmSync(RUNNING, { force: true }));
  console.log(
    `${arm} ${JSON.stringify(config)}: ${mib(measurement.sourceBytes)} -> ${mib(measurement.shippedBytes)} (${measurement.metrics.shippedPctOfSource}%), cook ${measurement.compileMs} ms, preload local ${measurement.metrics.preloadLocalMs ?? "skipped"} ms, 40 Mbps ${measurement.metrics.preloadThrottledMs ?? "skipped"} ms${measurement.preload ? ` on ${JSON.stringify(measurement.preload.local.adapter)} ${JSON.stringify({ local: measurement.preload.local.samplesMs, throttled: measurement.preload.throttled.samplesMs })}` : ""}`,
  );
  const control = measurement.pairedControl;
  if (control?.preload)
    console.log(
      `paired default: ${mib(control.shippedBytes)}, preload local ${control.metrics.preloadLocalMs} ms ${JSON.stringify(control.preload.local.samplesMs)}, 40 Mbps ${control.metrics.preloadThrottledMs} ms ${JSON.stringify(control.preload.throttled.samplesMs)}`,
    );
  if (argv.includes("--dry-run")) return;
  const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
  const next = appendIteration(ledger, {
    measurement,
    label,
    arm,
    config,
    notes: get("--notes") ?? "",
    decision: get("--decision"),
    commit: get("--commit") ?? git("rev-parse", "--short", "HEAD"),
    dirty: git("status", "--porcelain", "--", "packages/assets") !== "",
  });
  writeLedger(next);
}

async function main(argv) {
  const [command] = argv;
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  let ledger = readLedger(LEDGER);
  if (command === "measure") return measureCommand(ledger, argv, get);
  if (command === "show") return show(ledger);
  if (command === "decide") {
    const next = decideIteration(
      ledger,
      Number(get("--iteration")),
      get("--decision"),
      get("--reason"),
    );
    writeLedger(next);
    return console.log(`iteration ${get("--iteration")}: ${get("--decision")}`);
  }
  if (command === "snapshot") {
    rmSync(CONTROL_DIST, { recursive: true, force: true });
    cpSync(DIST, CONTROL_DIST, { recursive: true });
    return console.log(`control build: ${CONTROL_DIST}`);
  }
  if (command === "discard") {
    ledger = discardIteration(ledger, Number(get("--iteration")), get("--reason"));
    return writeLedger(ledger);
  }
  console.error("usage: asset-perf-loop.mjs measure|show|discard|decide|snapshot");
  process.exit(2);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
