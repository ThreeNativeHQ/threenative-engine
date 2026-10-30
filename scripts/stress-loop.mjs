#!/usr/bin/env node
// The stress lab loop's measure step.
//
//   pnpm stress:loop record <report.json> --label "<text>" [--decision baseline|keep|reject|measure] [--engine <arm>] [--notes "<text>"]
//   pnpm stress:loop show
//   pnpm dashboard   # the Stress lab tab renders docs/stress-loop/ledger.json on each load
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  esc,
  lineChart,
  meetsGoal,
  progressToward,
  readLedger,
  writeAtomic,
} from "./ci-speed-loop.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = resolve(ROOT, "docs/stress-loop/ledger.json");
const DECISIONS = ["baseline", "keep", "reject", "measure"];
/** The arms of the engine comparison: the same scene, the same report schema. */
export const ENGINES = [
  { key: "threenative-wasm", short: "ThreeNative (Wasm)" },
  { key: "threenative-threejs", short: "ThreeNative (three.js engine)" },
  { key: "three-vanilla", short: "Vanilla three.js" },
  { key: "unreal", short: "Unreal 5.8.3" },
];
const PENDING =
  "pending: no stress-lab iterations yet. Run the stress-lab sandbox scene, then `pnpm stress:loop record <report.json> --label ...`";

export { readLedger };

/** Fixed stress-lab KPI targets. `better` says which side of the goal is a win. */
/** Owner bar (2026-10-29): as smooth as Unreal, read as 120 fps stable: every frame under 8.33 ms. */
export const GOALS = [
  {
    key: "fps",
    short: "FPS",
    label: "Frames per second (median of the measured windows)",
    unit: "fps",
    goal: 120,
    better: "higher",
  },
  {
    key: "frameP95Ms",
    short: "CPU frame p95",
    label: "Frame callback p95 (CPU cost of one frame)",
    unit: "ms",
    goal: 8.33,
    better: "lower",
  },
  {
    key: "gpuP95Ms",
    short: "GPU p95",
    label: "GPU p95 (timestamp queries)",
    unit: "ms",
    goal: 8.33,
    better: "lower",
  },
  {
    key: "presentedP95Ms",
    short: "Presented p95",
    label: "Presented frame p95 (needs a 120 Hz display)",
    unit: "ms",
    goal: 8.33,
    better: "lower",
  },
  {
    key: "renderP50Ms",
    short: "JS render p50",
    label: "JS render phase p50",
    unit: "ms",
    goal: 4,
    better: "lower",
  },
  {
    key: "mainDraws",
    short: "Main draws",
    label: "Main-pass draws",
    unit: "draws",
    goal: 400,
    better: "lower",
  },
  {
    key: "hitchesPerMin",
    short: "Hitches / min",
    label: "Hitches / min",
    unit: "/min",
    goal: 0,
    better: "lower",
  },
];

function fail(field, expected, value) {
  throw new Error(`${field} ${expected}, got ${JSON.stringify(value)}`);
}

function count(value, field, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    fail(field, `must be a number in [${min}, ${max}]`, value);
  return value;
}

function text(value, field) {
  if (typeof value !== "string" || value === "") fail(field, "must be a non-empty string", value);
  return value;
}

function strings(value, field) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))
    throw new Error(`${field} must be a list of non-empty strings`);
  return value;
}

function metric(metrics, key, nullable = false) {
  const value = metrics[key];
  if (value === undefined)
    fail(`metrics.${key}`, "is missing (never default a missing metric to 0)", value);
  if (value === null && nullable) return null;
  return count(value, `metrics.${key}`);
}

/** One stress-lab report, validated fail-closed. Throws on any missing or invalid field. */
export function measureReport(report) {
  if (report === null || typeof report !== "object" || Array.isArray(report))
    throw new Error("report must be a JSON object");
  if (report.schema !== "stress-lab-report/1")
    fail("schema", 'must be "stress-lab-report/1"', report.schema);
  const metrics = report.metrics;
  if (metrics === null || typeof metrics !== "object" || Array.isArray(metrics))
    throw new Error("metrics must be an object");
  const counts = report.counts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts))
    throw new Error("counts must be an object");
  return {
    commit: text(report.commit, "commit"),
    preset: text(report.preset, "preset"),
    layers: strings(report.layers, "layers"),
    adapter: text(report.adapter, "adapter"),
    viewport: text(report.viewport, "viewport"),
    seconds: count(report.seconds, "seconds", { min: Number.MIN_VALUE }),
    windows: count(report.windows, "windows", { min: 1 }),
    metrics: {
      presentedP50Ms: metric(metrics, "presentedP50Ms"),
      presentedP95Ms: metric(metrics, "presentedP95Ms"),
      fps: metric(metrics, "fps"),
      gpuP50Ms: metric(metrics, "gpuP50Ms", true),
      gpuP95Ms: metric(metrics, "gpuP95Ms", true),
      renderP50Ms: metric(metrics, "renderP50Ms"),
      updateP50Ms: metric(metrics, "updateP50Ms"),
      frameP50Ms: metric(metrics, "frameP50Ms"),
      frameP95Ms: metric(metrics, "frameP95Ms"),
      mainDraws: metric(metrics, "mainDraws"),
      shadowDraws: metric(metrics, "shadowDraws", true),
      mainTrianglesM: metric(metrics, "mainTrianglesM"),
      hitchesPerMin: metric(metrics, "hitchesPerMin"),
      longTasks: metric(metrics, "longTasks", true),
      loadMs: metric(metrics, "loadMs", true),
      bridgeCrossingsP50: metric(metrics, "bridgeCrossingsP50", true),
      hostCallsP50: metric(metrics, "hostCallsP50", true),
      gpuUploadKbP50: metric(metrics, "gpuUploadKbP50", true),
      jsAllocKbP50: metric(metrics, "jsAllocKbP50", true),
    },
    counts,
  };
}

/** Append one measured row. Returns a new ledger; the input is not changed. */
export function appendRow(
  ledger,
  row,
  { label, notes = "", decision, engine = ENGINES[0].key, at = new Date() } = {},
) {
  if (typeof label !== "string" || label === "") throw new Error("record needs --label");
  const chosen = decision ?? (ledger.iterations.length === 0 ? "baseline" : "keep");
  if (!DECISIONS.includes(chosen))
    throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  if (!ENGINES.some((item) => item.key === engine))
    throw new Error(`engine must be one of ${ENGINES.map((item) => item.key).join(", ")}`);
  const id = ledger.iterations.reduce((top, item) => Math.max(top, item.id), 0) + 1;
  const next = {
    id,
    at: at.toISOString(),
    commit: row.commit,
    label,
    decision: chosen,
    engine,
    notes,
    preset: row.preset,
    layers: row.layers,
    adapter: row.adapter,
    viewport: row.viewport,
    seconds: row.seconds,
    windows: row.windows,
    metrics: row.metrics,
    counts: row.counts,
  };
  return { ...ledger, iterations: [...ledger.iterations, next] };
}

/** Engine-boundary costs, tracked per row without a goal until a measured floor sets one. */
export const TRACKED = [
  { key: "bridgeCrossingsP50", short: "JS↔Wasm crossings", unit: "/frame" },
  { key: "hostCallsP50", short: "Host (ABI) calls", unit: "/frame" },
  { key: "gpuUploadKbP50", short: "GPU upload", unit: "KB/frame" },
  { key: "jsAllocKbP50", short: "JS alloc", unit: "KB/frame" },
];

/** The report's other metrics: shown in the history and the engine comparison, no goal. */
const MORE = [
  { key: "gpuP50Ms", short: "GPU p50", unit: "ms" },
  { key: "presentedP50Ms", short: "Presented p50", unit: "ms" },
  { key: "frameP50Ms", short: "CPU frame p50", unit: "ms" },
  { key: "updateP50Ms", short: "Update p50", unit: "ms" },
  { key: "shadowDraws", short: "Shadow draws", unit: "draws" },
  { key: "mainTrianglesM", short: "Triangles", unit: "M" },
  { key: "longTasks", short: "Long tasks", unit: "" },
  { key: "loadMs", short: "Load", unit: "ms" },
];
const ALL = [...GOALS, ...MORE, ...TRACKED];
const engineOf = (row) => row.engine ?? ENGINES[0].key;

const fmt = (value, unit = "") =>
  value === null || value === undefined
    ? "n/a"
    : `${value}${unit === "%" ? "%" : ` ${unit}`}`.trim();

const delta = (baseline, current, unit) =>
  typeof baseline !== "number" || typeof current !== "number"
    ? "n/a"
    : `${current - baseline >= 0 ? "+" : ""}${Math.round((current - baseline) * 10) / 10} ${unit}`.trim();

export function renderHtml(ledger, now = new Date()) {
  const rows = ledger.iterations;
  const baseline = rows[0];
  const latest = rows.at(-1);
  const cards =
    GOALS.map((goal) => {
      const base = baseline?.metrics[goal.key];
      const current = latest?.metrics[goal.key];
      const met = meetsGoal(goal, current);
      const progress = progressToward(goal, base, current);
      return `<div class="card"><h3>${esc(goal.short)}</h3><p><b>${esc(fmt(current, goal.unit))}</b> <span class="dim">goal ${goal.better === "lower" ? "≤" : "≥"} ${esc(fmt(goal.goal, goal.unit))}</span></p><p class="dim">baseline ${esc(fmt(base, goal.unit))} · delta ${esc(delta(base, current, goal.unit))} · ${progress === null ? "n/a" : `${Math.round(progress * 100)}%`} to goal</p><span class="pill${met ? " ok" : ""}">${met ? "met" : "open"}</span></div>`;
    }).join("") +
    TRACKED.map((item) => {
      const base = baseline?.metrics[item.key];
      const current = latest?.metrics[item.key];
      return `<div class="card"><h3>${esc(item.short)}</h3><p><b>${esc(fmt(current, item.unit))}</b> <span class="dim">p50, lower is better</span></p><p class="dim">baseline ${esc(fmt(base, item.unit))} · delta ${esc(delta(base, current, item.unit))}</p><span class="pill">tracked</span></div>`;
    }).join("");
  const charts = GOALS.map((goal) => lineChart(goal, rows)).join("");
  const arms = ENGINES.map((engine) => ({
    ...engine,
    row: rows.findLast((row) => engineOf(row) === engine.key),
  }));
  const comparison = `<div class="scroll"><table><thead><tr><th>Metric</th>${arms
    .map(
      (arm) =>
        `<th class="n">${esc(arm.short)}<br><span class="dim">${arm.row === undefined ? "pending" : esc(`#${arm.row.id} · ${arm.row.adapter} · ${arm.row.viewport}`)}</span></th>`,
    )
    .join("")}</tr></thead><tbody>${ALL.map(
    (item) =>
      `<tr><td>${esc(item.short)}</td>${arms.map((arm) => `<td class="n">${arm.row === undefined ? "pending" : esc(fmt(arm.row.metrics[item.key], item.unit))}</td>`).join("")}</tr>`,
  ).join("")}</tbody></table></div>`;
  const history = rows
    .map(
      (row) =>
        `<tr><td>#${esc(row.id)}</td><td>${esc(row.at.slice(0, 10))}</td><td>${esc(row.commit)}</td><td>${esc(row.label)}</td><td>${esc(row.decision)}</td><td>${esc(engineOf(row))}</td><td>${esc(row.preset)}</td><td>${esc(row.adapter)}</td>${[...GOALS, ...MORE].map((goal) => `<td class="n">${esc(fmt(row.metrics[goal.key], goal.unit))}</td>`).join("")}${TRACKED.map((item) => `<td class="n">${esc(fmt(row.metrics[item.key], item.unit))}</td>`).join("")}</tr>`,
    )
    .join("");
  const header =
    latest === undefined
      ? PENDING
      : `Latest iteration #${latest.id} of ${rows.length}: ${latest.preset} on ${latest.adapter} at ${latest.viewport}.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stress lab</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#d9d9d2;--accent:#2f6fed;--ok:#1a8f4c;--miss:#c4452d;--goal:#b7791f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--fg:#ececE6;--dim:#9b9b94;--card:#1f1f1d;--line:#34342f;--accent:#6c9bff;--ok:#4cc380;--miss:#ef7a63;--goal:#e2b04a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 10px;font-size:17px}h3{margin:0 0 4px;font-size:14px}
.dim,small{color:var(--dim)}ul{margin:2px 0 6px;padding-left:18px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13.5px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--dim)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.scroll{overflow-x:auto}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
.card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.card p{margin:2px 0}
figcaption{font-weight:600;margin-bottom:4px}
svg{width:100%;height:auto}
.line{fill:none;stroke:var(--accent);stroke-width:2}
.dot.ok{fill:var(--ok)}.dot.miss{fill:var(--miss)}
.goal{stroke:var(--goal);stroke-dasharray:5 4;stroke-width:1.5}.grid{stroke:var(--line)}
.tick{fill:var(--dim);font-size:11px}.goaltext{fill:var(--goal);font-size:11px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}.pill.ok{color:var(--ok);border-color:var(--ok)}
</style></head><body><main>
<h1>Stress lab</h1>
<p class="dim">${esc(header)} Snapshot ${esc(now.toISOString())}. The <code>pnpm dashboard</code> Stress lab tab renders <code>docs/stress-loop/ledger.json</code> on each load.</p>
<h2>KPI goals</h2>
<div class="grid3">${cards}</div>
<h2>Trend per iteration</h2>
<div class="grid3">${charts}</div>
<h2>Engine comparison (same scene, latest row per engine)</h2>
${comparison}
<h2>Iterations</h2>
<div class="scroll"><table><thead><tr><th>#</th><th>Date</th><th>Commit</th><th>Label</th><th>Decision</th><th>Engine</th><th>Preset</th><th>Adapter</th>${ALL.map((item) => `<th class="n">${esc(item.short)}</th>`).join("")}</tr></thead><tbody>${history || `<tr><td colspan="${8 + ALL.length}" class="dim">pending</td></tr>`}</tbody></table></div>
</main></body></html>
`;
}

function readReport(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`report ${file} is missing`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`report ${file} is not JSON: ${error.message}`);
  }
}

function main(argv) {
  const [command, file] = argv;
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const ledger = readLedger(LEDGER);
  if (command === "record" && file !== undefined) {
    const next = appendRow(ledger, measureReport(readReport(resolve(file))), {
      label: get("--label"),
      notes: get("--notes") ?? "",
      decision: get("--decision"),
      engine: get("--engine"),
    });
    writeAtomic(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
    return console.log(`stress-loop row #${next.iterations.at(-1).id} recorded in ${LEDGER}`);
  }
  if (command === "show") {
    if (ledger.iterations.length === 0) return console.log(PENDING);
    console.table(
      ledger.iterations.map((row) => ({
        id: row.id,
        date: row.at.slice(0, 10),
        commit: row.commit,
        label: row.label,
        decision: row.decision,
        preset: row.preset,
        adapter: row.adapter,
        ...Object.fromEntries(GOALS.map((goal) => [goal.short, row.metrics[goal.key]])),
        gpuP50Ms: row.metrics.gpuP50Ms,
        fps: row.metrics.fps,
      })),
    );
    return;
  }
  console.error(
    "usage: stress-loop.mjs record <report.json> --label <text> [--decision baseline|keep|reject|measure] [--engine threenative-wasm|threenative-threejs|three-vanilla|unreal] [--notes <text>] | show",
  );
  process.exit(2);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
