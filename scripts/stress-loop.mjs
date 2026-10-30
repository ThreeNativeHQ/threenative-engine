#!/usr/bin/env node
// The stress lab loop's measure step.
//
//   pnpm stress:loop record <report.json> --label "<text>" [--decision baseline|keep|reject|measure] [--engine <arm>] [--variant <url flags>] [--notes "<text>"]
//   pnpm stress:loop fair <engine=url>... [--tag <name>] [--passes vsync,uncapped]   # PRD-770: one fair window, then record
//   pnpm stress:loop show
//   pnpm dashboard   # the Stress lab tab renders docs/stress-loop/ledger.json on each load
import { execFileSync } from "node:child_process";
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
const LEDGER = process.env.TN_STRESS_LEDGER ?? resolve(ROOT, "docs/stress-loop/ledger.json");
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

/**
 * Writes the ledger in the shape biome's formatter keeps (short arrays on one line), so the pre-push lint stays green.
 * `--stdin-file-path` names the real ledger path for the config and ignore rules, and works for any output path.
 */
export function writeLedger(path, ledger) {
  const formatted = execFileSync(
    resolve(ROOT, "node_modules/.bin/biome"),
    ["format", "--stdin-file-path=docs/stress-loop/ledger.json"],
    { cwd: ROOT, encoding: "utf8", input: JSON.stringify(ledger, null, 2) },
  );
  writeAtomic(path, formatted.endsWith("\n") ? formatted : `${formatted}\n`);
}

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

/**
 * One stress-lab report, validated fail-closed. Throws on any missing or invalid field.
 * `counted: false` is for an engine that cannot count its own draws and triangles (Unreal): those two may be null.
 */
export function measureReport(report, { counted = true } = {}) {
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
      mainDraws: metric(metrics, "mainDraws", !counted),
      shadowDraws: metric(metrics, "shadowDraws", true),
      mainTrianglesM: metric(metrics, "mainTrianglesM", !counted),
      // Absent on an arm that cannot split the shadow pass out; vanilla reports it under `extra`.
      shadowTrianglesM: metric(
        { shadowTrianglesM: metrics.shadowTrianglesM ?? report.extra?.shadowTrianglesM ?? null },
        "shadowTrianglesM",
        true,
      ),
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
  {
    label,
    notes = "",
    decision,
    engine = ENGINES[0].key,
    variant = "stress",
    at = new Date(),
    extra = {},
  } = {},
) {
  if (typeof label !== "string" || label === "") throw new Error("record needs --label");
  const chosen = decision ?? (ledger.iterations.length === 0 ? "baseline" : "keep");
  if (!DECISIONS.includes(chosen))
    throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  if (!ENGINES.some((item) => item.key === engine))
    throw new Error(`engine must be one of ${ENGINES.map((item) => item.key).join(", ")}`);
  if (typeof variant !== "string" || variant === "")
    throw new Error("variant must be a non-empty string");
  const id = ledger.iterations.reduce((top, item) => Math.max(top, item.id), 0) + 1;
  const next = {
    id,
    at: at.toISOString(),
    commit: row.commit,
    label,
    decision: chosen,
    engine,
    variant,
    notes,
    preset: row.preset,
    layers: row.layers,
    adapter: row.adapter,
    viewport: row.viewport,
    seconds: row.seconds,
    windows: row.windows,
    metrics: row.metrics,
    counts: row.counts,
    ...extra,
  };
  return { ...ledger, iterations: [...ledger.iterations, next] };
}

/** PRD-770: a run whose 1-minute host load rose above this is void; the fair window starts only below QUIET_LOAD. */
export const LOAD_VOID = 6;
/** Two rows compare only when their main and shadow triangles are this close (owner, 2026-10-30: apples to apples). */
const TRIANGLE_TOLERANCE = 0.02;
export const QUIET_LOAD = 4;

/** `plain` is one ordinary sun map (vanilla three.js, or `?plainShadow`); `virtual` is ThreeNative's virtual shadow maps. */
export const shadowModeOf = (engine, variant) =>
  engine === "three-vanilla" || variant.split("&").includes("plainShadow") ? "plain" : "virtual";

/**
 * A fair-window run, checked fail-closed before it becomes a row (PRD-770 Phase 1 and 2): the engine build identity
 * (a 12-hex sha256 of the served Wasm, or of the served scripts for a JS arm, plus the package commit), a real adapter
 * and a host that stayed quiet. A bare report has none of these, so it is refused.
 * Returns the report with the adapter filled in, and the fields a row keeps beside it.
 */
export function checkedRun(raw, engine) {
  if (raw === null || typeof raw !== "object" || raw.report === undefined)
    throw new Error(
      "record needs a fair-window run (report, build, load): run `pnpm stress:loop fair`, a bare report has no build identity",
    );
  const { build, load, report } = raw;
  if (!/^[0-9a-f]{12}$/u.test(build?.sha256 ?? ""))
    fail(
      "build.sha256",
      "must be a 12-hex sha256 prefix of the served engine bundle",
      build?.sha256,
    );
  text(build.commit, "build.commit");
  if (engine === "threenative-wasm" && build.kind !== "wasm")
    fail(
      "build.kind",
      'must be "wasm": the Wasm arm loaded no .wasm, so it ran another engine',
      build.kind,
    );
  const named = (adapter) => typeof adapter === "string" && /[a-z0-9]/iu.test(adapter);
  const adapter = named(report.adapter) ? report.adapter : raw.adapterInfo;
  if (!named(adapter))
    fail(
      "adapter",
      "must name the GPU (the report and the browser both gave none)",
      report.adapter,
    );
  if (!Array.isArray(load) || load.length === 0 || load.some((value) => !Number.isFinite(value)))
    fail("load", "must list the 1-minute load samples of the run", load);
  const peak = Math.max(...load);
  if (peak > LOAD_VOID) throw new Error(`run void: host load ${peak} rose above ${LOAD_VOID}`);
  return {
    report: { ...report, adapter },
    extra: {
      build,
      load: { peak, samples: load.length },
      dpr: raw.dpr ?? null,
      pass: raw.pass ?? "vsync",
    },
  };
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
  { key: "mainTrianglesM", short: "Triangles", unit: "M", workload: true },
  { key: "shadowTrianglesM", short: "Shadow triangles", unit: "M", workload: true },
  { key: "longTasks", short: "Long tasks", unit: "" },
  { key: "loadMs", short: "Load", unit: "ms" },
];
const ALL = [...GOALS, ...MORE, ...TRACKED];
const engineOf = (row) => row.engine ?? ENGINES[0].key;
/** The URL flags beyond `?stress` (for example `plainShadow`); the comparison reads only plain `stress` rows. */
const variantOf = (row) => row.variant ?? "stress";
/** The variant without its `arm=` tag: `plainShadow&arm=stack` is a `plainShadow` row of the `stack` arm. */
const sceneOf = (row) =>
  variantOf(row)
    .split("&")
    .filter((flag) => !flag.startsWith("arm="))
    .join("&") || "stress";

const fmt = (value, unit = "") =>
  value === null || value === undefined
    ? "n/a"
    : `${value}${unit === "%" ? "%" : ` ${unit}`}`.trim();

const delta = (baseline, current, unit) =>
  typeof baseline !== "number" || typeof current !== "number"
    ? "n/a"
    : `${current - baseline >= 0 ? "+" : ""}${Math.round((current - baseline) * 10) / 10} ${unit}`.trim();

const BASIS_NOTE =
  "count basis differs (Wasm counts main + shadow passes, web_host.cpp:787-790) or the scene differs";

/** A counter that reads near zero while the arm renders frames. The comparison flags it and never ranks it. */
const brokenCounter = (item, value, fps) =>
  fps > 0 &&
  ((item.key === "mainTrianglesM" && value === 0) || (item.key === "mainDraws" && value <= 1));

/** The raw difference against the Wasm cell in words: "11× lower", "30% higher", "3 /min higher" or "same". */
function differsBy(item, value, base) {
  if (value === base) return "same";
  const word = value > base ? "higher" : "lower";
  if (value === 0 || base === 0)
    return `${fmt(Math.round(Math.abs(value - base) * 100) / 100, item.unit)} ${word}`;
  const factor = Math.max(value / base, base / value);
  if (factor >= 2) return `${factor < 9.95 ? factor.toFixed(1) : Math.round(factor)}× ${word}`;
  const percent = Math.round(Math.abs(value / base - 1) * 100);
  return percent === 0 ? "same" : `${percent}% ${word}`;
}

/**
 * One comparison row, one cell per engine arm (the Wasm arm comes first and is the delta base).
 * The best cell gets ✅ and the worst ❌, among the ranked cells: FPS wins high, every other row wins low.
 * A workload row (Triangles) ranks nothing. A broken counter gets ⚠️ and is never ranked.
 */
function comparisonRow(item, arms) {
  const higherWins = item.better === "higher";
  const cells = arms.map((arm) => {
    const value = arm.row?.metrics[item.key];
    const fps = arm.row?.metrics.fps;
    return {
      arm,
      value,
      fps,
      broken: typeof value === "number" && brokenCounter(item, value, fps),
    };
  });
  /** A mismatched arm (other counts or shadow mode) is shown with ⚠️ and never ranked or compared. */
  const unfair = (cell) => cell.arm.mismatch !== undefined;
  const ranked = item.workload
    ? []
    : cells
        .filter((cell) => typeof cell.value === "number" && !cell.broken && !unfair(cell))
        .map((cell) => cell.value);
  const best = higherWins ? Math.max(...ranked) : Math.min(...ranked);
  const worst = higherWins ? Math.min(...ranked) : Math.max(...ranked);
  const marked = ranked.length >= 2 && differsBy(item, worst, best) !== "same";
  const base = typeof cells[0].value === "number" && !cells[0].broken ? cells[0].value : undefined;
  /** Class, symbol and tooltip of one numeric cell. */
  const flagOf = (cell, index) => {
    if (cell.broken)
      return [
        " warn",
        "⚠️ ",
        `counter broken: the arm renders ${cell.fps} fps but reports ${fmt(cell.value, item.unit)}. Not ranked.`,
      ];
    if (unfair(cell)) return [" warn", "⚠️ ", `not comparable: ${cell.arm.mismatch}. Not ranked.`];
    if (marked && cell.value === best) return [" best", "✅ ", ""];
    if (marked && cell.value === worst) return [" worst", "❌ ", ""];
    if (
      item.workload &&
      index > 0 &&
      base !== undefined &&
      Math.abs(cell.value - base) > 0.1 * base
    )
      return [" warn", "⚠️ ", BASIS_NOTE];
    return ["", "", ""];
  };
  /** The delta line under a numeric cell. Only the arms after the Wasm base get one. */
  const noteOf = (cell, index) => {
    if (index === 0 || base === undefined || cell.broken || unfair(cell)) return "";
    const words = differsBy(item, cell.value, base);
    const better = cell.value > base === higherWins;
    const verdict = words === "same" || item.workload ? "" : better ? "good" : "bad";
    return `<span class="d ${verdict}">${{ good: "▲ ", bad: "▼ ", "": "" }[verdict]}${esc(words)}</span>`;
  };
  const tds = cells.map((cell, index) => {
    if (cell.arm.row === undefined) return `<td class="n dim">pending</td>`;
    if (typeof cell.value !== "number") return `<td class="n dim">${esc(fmt(cell.value))}</td>`;
    const [cls, symbol, title] = flagOf(cell, index);
    const why = unfair(cell)
      ? `<span class="d">not comparable: ${esc(cell.arm.mismatch)}</span>`
      : "";
    return `<td class="n${cls}"${title === "" ? "" : ` title="${esc(title)}"`}>${symbol}${esc(fmt(cell.value, item.unit))}${noteOf(cell, index)}${why}</td>`;
  });
  return `<tr><td>${esc(item.short)}</td>${tds.join("")}</tr>`;
}

/** Why `row` is not a fair match for the Wasm anchor row, or undefined when counts and shadow mode agree. */
function mismatchOf(row, anchor) {
  if (JSON.stringify(row.counts) !== JSON.stringify(anchor.counts))
    return "the scene counts differ";
  if (row.shadow && anchor.shadow && row.shadow !== anchor.shadow)
    return `shadow mode ${row.shadow} against ${anchor.shadow}`;
  // Equal work, not equal draws: draws follow each engine's batching. Rows that lack a count are not judged.
  if (typeof row.metrics.mainTrianglesM !== "number") return "main triangles not measured";
  for (const [key, name] of [
    ["mainTrianglesM", "main"],
    ["shadowTrianglesM", "shadow"],
  ]) {
    const [mine, base] = [row.metrics[key], anchor.metrics[key]];
    if (typeof mine !== "number" || typeof base !== "number") continue;
    if (Math.abs(mine - base) > TRIANGLE_TOLERANCE * base)
      return `${name} triangles ${mine} M against ${base} M (more than ${TRIANGLE_TOLERANCE * 100}% apart)`;
  }
  return undefined;
}

/**
 * One column per engine, anchored on the latest Wasm row of `variant`. A later arm takes its own row of that variant,
 * or its plain `stress` row when that row has the anchor's shadow mode (vanilla three.js has one sun map).
 */
function comparisonArms(rows, variant) {
  // A column shows the latest kept arm of the scene, else its latest row that was not rejected.
  const latest = (engine, wanted) => {
    const of = rows.filter(
      (row) => engineOf(row) === engine && sceneOf(row) === wanted && row.decision !== "reject",
    );
    return of.findLast((row) => row.decision === "keep") ?? of.at(-1);
  };
  const anchor = latest(ENGINES[0].key, variant);
  return ENGINES.map((engine, index) => {
    const own = latest(engine.key, variant);
    const fallback = latest(engine.key, "stress");
    const row =
      own ??
      (fallback !== undefined && anchor !== undefined && fallback.shadow === anchor.shadow
        ? fallback
        : undefined);
    return {
      ...engine,
      row,
      mismatch:
        index === 0 || row === undefined || anchor === undefined
          ? undefined
          : mismatchOf(row, anchor),
    };
  });
}

function comparisonTable(arms) {
  return `<div class="scroll"><table class="cmp"><thead><tr><th>Metric</th>${arms
    .map(
      (arm) =>
        `<th class="n">${esc(arm.short)}<br><span class="dim">${arm.row === undefined ? "pending" : esc(`#${arm.row.id} · ${variantOf(arm.row) === "stress" ? "" : `${variantOf(arm.row)} · `}${arm.row.build?.sha256 ?? arm.row.commit} · ${arm.row.adapter}`)}</span></th>`,
    )
    .join(
      "",
    )}</tr></thead><tbody>${ALL.map((item) => comparisonRow(item, arms)).join("")}</tbody></table></div>`;
}

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
  const comparison = comparisonTable(comparisonArms(rows, "stress"));
  // PRD-770: with fair-window rows for ThreeNative's plain-shadow arm, the like-for-like table for vanilla three.js.
  const plainAnchor = rows.findLast(
    (row) =>
      engineOf(row) === ENGINES[0].key && sceneOf(row) === "plainShadow" && row.build !== undefined,
  );
  const plainComparison =
    plainAnchor === undefined
      ? ""
      : `<h3>Plain sun map (<code>?stress&amp;plainShadow</code>): the like-for-like arm for vanilla three.js</h3>${comparisonTable(comparisonArms(rows, "plainShadow"))}`;
  const history = rows
    .map(
      (row) =>
        `<tr><td>#${esc(row.id)}</td><td>${esc(row.at.slice(0, 10))}</td><td>${esc(row.commit)}</td><td>${esc(row.label)}</td><td>${esc(row.decision)}</td><td>${esc(engineOf(row))}${variantOf(row) === "stress" ? "" : ` <span class="dim">${esc(variantOf(row))}</span>`}</td><td>${esc(row.preset)}</td><td>${esc(row.adapter)}</td>${[...GOALS, ...MORE].map((goal) => `<td class="n">${esc(fmt(row.metrics[goal.key], goal.unit))}</td>`).join("")}${TRACKED.map((item) => `<td class="n">${esc(fmt(row.metrics[item.key], item.unit))}</td>`).join("")}</tr>`,
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
:root{--bg:#fafaf7;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#d9d9d2;--accent:#2f6fed;--ok:#1a8f4c;--miss:#c4452d;--goal:#b7791f;--ok-bg:#e4f4ea;--ok-ink:#11693a;--miss-bg:#fbe9e5;--miss-ink:#a63220;--warn-bg:#fbf1dc}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--fg:#ececE6;--dim:#9b9b94;--card:#1f1f1d;--line:#34342f;--accent:#6c9bff;--ok:#4cc380;--miss:#ef7a63;--goal:#e2b04a;--ok-bg:#1c3326;--ok-ink:#7fdca6;--miss-bg:#3a2420;--miss-ink:#ff9c88;--warn-bg:#3a3019}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 10px;font-size:17px}h3{margin:0 0 4px;font-size:14px}
.dim,small{color:var(--dim)}ul{margin:2px 0 6px;padding-left:18px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13.5px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--dim)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.scroll{overflow-x:auto}
.cmp td:first-child,.cmp th:first-child{position:sticky;white-space:nowrap;left:0;background:var(--card);box-shadow:1px 0 0 var(--line)}
.cmp .best{background:var(--ok-bg);color:var(--ok-ink);font-weight:600}.cmp .worst{background:var(--miss-bg);color:var(--miss-ink);font-weight:600}.cmp .warn{background:var(--warn-bg)}
.cmp .d{display:block;font-size:12px;font-weight:400;color:var(--dim)}.cmp .d.good{color:var(--ok-ink)}.cmp .d.bad{color:var(--miss-ink)}
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
<p class="dim">Only arms with the same counts and shadow mode as ThreeNative (Wasm) are ranked; any other gets ⚠️ and is left out of best and worst. ✅ best and ❌ worst in the row. Under each other cell: ▲ better or ▼ worse than ThreeNative (Wasm). A higher FPS wins. For every other metric, lower wins. Triangles is a workload, so it has no best or worst. ⚠️ marks a count that looks wrong. Hover for the reason.</p>
${comparison}
${plainComparison}
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

/** Append a fair-window run as a row. Refuses a run without build identity, a named adapter or a quiet host. */
export function recordRun(
  ledger,
  raw,
  { engine = ENGINES[0].key, variant = "stress", ...options } = {},
) {
  const { report, extra } = checkedRun(raw, engine);
  return appendRow(ledger, measureReport(report, { counted: engine !== "unreal" }), {
    ...options,
    engine,
    variant,
    extra: { ...extra, shadow: shadowModeOf(engine, variant) },
  });
}

async function main(argv) {
  const [command, file] = argv;
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const ledger = readLedger(LEDGER);
  if (command === "record" && file !== undefined) {
    const next = recordRun(ledger, readReport(resolve(file)), {
      label: get("--label"),
      notes: get("--notes") ?? "",
      decision: get("--decision"),
      engine: get("--engine"),
      variant: get("--variant"),
    });
    writeLedger(LEDGER, next);
    return console.log(`stress-loop row #${next.iterations.at(-1).id} recorded in ${LEDGER}`);
  }
  if (command === "fair") {
    const { runFair } = await import("./stress-fair.mjs");
    return runFair(argv.slice(1), { ledgerPath: LEDGER });
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
    "usage: stress-loop.mjs record <fair-run.json> --label <text> [--decision baseline|keep|reject|measure] [--engine threenative-wasm|threenative-threejs|three-vanilla|unreal] [--variant <url flags>] [--notes <text>] | fair <engine=url>... | show",
  );
  process.exit(2);
}

// Not awaited at the top level: `fair` imports stress-fair.mjs, which imports this module back.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
