#!/usr/bin/env node
// PRD-550: the CI speed loop's ledger and dashboard.
//
//   node scripts/ci-speed-loop.mjs record --since 2026-10-09 --label "gating board" [--notes ...] [--decision keep]
//   node scripts/ci-speed-loop.mjs show
//   node scripts/ci-speed-loop.mjs discard --iteration 3 --reason "queue outage"
//   node scripts/ci-speed-loop.mjs report
//
// docs/ci-speed/ledger.json is the durable record, one entry per iteration. docs/ci-speed/index.html is
// generated from it and opens with file:// and no script. Neither is edited by hand. A superseded
// iteration stays in the ledger and the table but leaves the charts and the progress strip.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { measure } from "./ci-merge-latency.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = resolve(ROOT, "docs/ci-speed/ledger.json");
const HTML = resolve(ROOT, "docs/ci-speed/index.html");
const DECISIONS = ["baseline", "keep", "reject", "provisional", "inconclusive", "invalid"];

/** The PRD-550 targets. `better` says which side of the goal is a win. */
export const GOALS = [
  {
    key: "lastPushToMergeMedianMin",
    short: "Push→merge p50",
    label: "Last push to merge, median",
    unit: "min",
    goal: 30,
    better: "lower",
  },
  {
    key: "lastPushToMergeP90Min",
    short: "Push→merge p90",
    label: "Last push to merge, p90",
    unit: "min",
    goal: 45,
    better: "lower",
  },
  {
    key: "firstAttemptSuccessPct",
    short: "First attempt",
    label: "Merge queue passes on the first attempt",
    unit: "%",
    goal: 90,
    better: "higher",
  },
  {
    key: "boardWallMedianMin",
    short: "Board wall",
    label: "Merge-group board wall time, median",
    unit: "min",
    goal: 15,
    better: "lower",
  },
  {
    key: "queueWaitP90Min",
    short: "Queue wait p90",
    label: "Runner queue wait, p90",
    unit: "min",
    goal: 3,
    better: "lower",
  },
];

export const emptyLedger = () => ({ schemaVersion: 1, goals: GOALS, iterations: [] });
/** Live = counts toward charts and the strip. Invalid and superseded runs are history only. */
export const isLive = (iteration) =>
  iteration.superseded === undefined && iteration.decision !== "invalid";

export function readLedger(path = LEDGER) {
  if (!existsSync(path)) return emptyLedger();
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  if (ledger.schemaVersion !== 1 || !Array.isArray(ledger.iterations)) {
    throw new Error(`${path} is not a schemaVersion 1 CI speed ledger`);
  }
  return ledger;
}

function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, path);
}

/** Add one measured window to the ledger. Returns a new ledger; the input is not changed. */
export function appendIteration(
  ledger,
  { measurement, label, notes = "", decision, commit = "", source = "measured" },
) {
  const id = ledger.iterations.reduce((top, item) => Math.max(top, item.id), 0) + 1;
  const chosen = decision ?? (ledger.iterations.length === 0 ? "baseline" : "provisional");
  if (!DECISIONS.includes(chosen))
    throw new Error(`decision must be one of ${DECISIONS.join(", ")}`);
  const metrics = Object.fromEntries(
    GOALS.map(({ key }) => [key, measurement.summary[key] ?? null]),
  );
  const iteration = {
    id,
    at: measurement.at ?? new Date().toISOString(),
    commit,
    label,
    notes,
    decision: chosen,
    source,
    window: { since: measurement.since, base: measurement.base },
    metrics,
    extra: {
      prCount: measurement.summary.prCount,
      mergeGroupRuns: measurement.summary.mergeGroupRuns,
      mergeGroupRunSuccessPct: measurement.summary.mergeGroupRunSuccessPct,
      enqueueToMergeMedianMin: measurement.summary.enqueueToMergeMedianMin,
      queueWaitJobs: measurement.summary.queueWaitJobs,
    },
    prs: measurement.prs,
    firstFailingJobs: measurement.firstFailingJobs,
  };
  return { ...ledger, goals: GOALS, iterations: [...ledger.iterations, iteration] };
}

export function discardIteration(ledger, id, reason) {
  if (!reason) throw new Error("discard needs --reason");
  if (!ledger.iterations.some((item) => item.id === id))
    throw new Error(`no iteration ${String(id)}`);
  return {
    ...ledger,
    iterations: ledger.iterations.map((item) =>
      item.id === id ? { ...item, superseded: { reason, at: new Date().toISOString() } } : item,
    ),
  };
}

/** 0..1 of the way from the baseline value to the goal. Null when either end is unknown. */
export function progressToward(goal, baseline, current) {
  if (baseline === null || baseline === undefined || current === null || current === undefined)
    return null;
  const span = goal.better === "lower" ? baseline - goal.goal : goal.goal - baseline;
  if (span <= 0) return 1;
  const done = goal.better === "lower" ? baseline - current : current - baseline;
  return Math.min(1, Math.max(0, done / span));
}

export const meetsGoal = (goal, value) =>
  value !== null &&
  value !== undefined &&
  (goal.better === "lower" ? value <= goal.goal : value >= goal.goal);

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/gu,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
const num = (value, unit = "") =>
  value === null || value === undefined
    ? "n/a"
    : `${value}${unit === "%" ? "%" : ` ${unit}`}`.trim();

/** One goal's trend: a line per live iteration, a dashed goal line, a break where a value is missing. */
function lineChart(goal, live) {
  const width = 380;
  const height = 190;
  const pad = { l: 44, r: 14, t: 14, b: 28 };
  const values = live.map((item) => item.metrics[goal.key]);
  const known = values.filter((v) => v !== null);
  const lo = Math.min(goal.goal, ...known, goal.better === "higher" ? 0 : goal.goal);
  const hi = Math.max(goal.goal, ...known) * 1.1 || 1;
  const x = (index) =>
    live.length === 1
      ? (pad.l + width - pad.r) / 2
      : pad.l + ((width - pad.l - pad.r) * index) / (live.length - 1);
  const y = (value) => height - pad.b - ((height - pad.t - pad.b) * (value - lo)) / (hi - lo);
  const segments = [];
  let run = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (run.length > 0) segments.push(run);
      run = [];
    } else run.push([x(index), y(value)]);
  });
  if (run.length > 0) segments.push(run);
  const lines = segments
    .filter((s) => s.length > 1)
    .map(
      (s) =>
        `<polyline class="line" points="${s.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}"/>`,
    )
    .join("");
  const dots = values
    .map((value, index) =>
      value === null
        ? ""
        : `<circle class="dot ${meetsGoal(goal, value) ? "ok" : "miss"}" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="4"><title>#${live[index].id}: ${esc(num(value, goal.unit))}</title></circle><text class="tick" x="${x(index).toFixed(1)}" y="${height - 10}" text-anchor="middle">#${live[index].id}</text>`,
    )
    .join("");
  const gy = y(goal.goal).toFixed(1);
  const empty =
    known.length === 0
      ? `<text class="tick" x="${width / 2}" y="${height / 2}" text-anchor="middle">baseline pending</text>`
      : "";
  return `<figure class="card"><figcaption>${esc(goal.label)} <span class="dim">(${goal.better === "lower" ? "lower" : "higher"} is better)</span></figcaption>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(goal.label)} per iteration, goal ${goal.goal} ${esc(goal.unit)}">
<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${y(lo).toFixed(1)}" y2="${y(lo).toFixed(1)}"/>
<line class="goal" x1="${pad.l}" x2="${width - pad.r}" y1="${gy}" y2="${gy}"/>
<text class="tick" x="${pad.l - 6}" y="${gy}" text-anchor="end" dominant-baseline="middle">${goal.goal}</text>
<text class="goaltext" x="${pad.l + 4}" y="${Number(gy) - 5}" text-anchor="start">goal ${goal.better === "lower" ? "≤" : "≥"} ${goal.goal} ${esc(goal.unit)}</text>
${Math.abs(y(hi / 1.1) - y(goal.goal)) > 14 ? `<text class="tick" x="${pad.l - 6}" y="${y(hi / 1.1).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${Math.round(hi / 1.1)}</text>` : ""}
${lines}${dots}${empty}</svg></figure>`;
}

function barChart(rows, title) {
  const max = Math.max(1, ...rows.map((row) => row.count));
  const body = rows
    .slice(0, 8)
    .map(
      (row) =>
        `<div class="bar"><span class="barname" title="${esc(row.job)}">${esc(row.job)}</span><span class="barfill" style="width:${((row.count / max) * 100).toFixed(1)}%"></span><span class="barnum">${row.count}</span></div>`,
    )
    .join("");
  return `<figure class="card wide"><figcaption>${esc(title)}</figcaption>${body || '<p class="dim">no red merge groups in this window</p>'}</figure>`;
}

export function renderHtml(ledger, now = new Date()) {
  const live = ledger.iterations.filter(isLive);
  const latest = live.at(-1);
  const base = live[0];
  const strip = GOALS.map((goal) => {
    const current = latest?.metrics[goal.key] ?? null;
    const progress = progressToward(goal, base?.metrics[goal.key], current);
    const percent = progress === null ? null : Math.round(progress * 100);
    return `<tr><td>${esc(goal.label)}</td><td>${esc(num(base?.metrics[goal.key], goal.unit))}</td><td><b>${esc(num(current, goal.unit))}</b></td><td>${goal.better === "lower" ? "≤" : "≥"} ${goal.goal} ${esc(goal.unit === "%" ? "%" : goal.unit)}</td>
<td class="meter"><span class="track"><span class="fill ${meetsGoal(goal, current) ? "ok" : ""}" style="width:${percent ?? 0}%"></span></span> ${percent === null ? "n/a" : `${percent}%`}</td><td>${meetsGoal(goal, current) ? '<span class="pill ok">met</span>' : '<span class="pill">open</span>'}</td></tr>`;
  }).join("");
  const history = ledger.iterations
    .map((item) => {
      const cells = GOALS.map(
        (goal) =>
          `<td class="n">${esc(num(item.metrics[goal.key], goal.unit === "%" ? "%" : ""))}</td>`,
      ).join("");
      const out = item.superseded === undefined ? "" : ` class="out"`;
      const flag =
        item.superseded === undefined
          ? ""
          : `<br><small>superseded: ${esc(item.superseded.reason)}</small>`;
      return `<tr${out}><td>#${item.id}</td><td>${esc(item.at.slice(0, 10))}</td><td>${esc(item.commit)}</td><td>${esc(item.label)}${flag}<br><small class="dim">${esc(item.notes)}</small></td><td><span class="pill">${esc(item.decision)}</span></td><td>${esc(item.window.since)}</td>${cells}</tr>`;
    })
    .join("");
  // A window that merged no PR keeps the last window that did, so the audit table never goes blank.
  const prSource = [...live].reverse().find((item) => (item.prs ?? []).length > 0);
  const prTitle =
    prSource === undefined ? "Merged PRs" : `Merged PRs, iteration #${String(prSource.id)} window`;
  const prs = (prSource?.prs ?? [])
    .map(
      (row) =>
        `<tr><td>#${row.number}</td><td>${esc(row.title)}</td><td class="n">${esc(num(row.lastPushToMergeMin, "min"))}</td><td class="n">${esc(num(row.enqueueToMergeMin, "min"))}</td><td class="n">${row.attempts}</td><td>${esc(row.firstAttempt ?? "n/a")}</td><td>${esc(row.firstFailingJob ?? "")}</td></tr>`,
    )
    .join("");
  const charts = GOALS.map((goal) => lineChart(goal, live)).join("");
  const header =
    latest === undefined
      ? "Baseline pending: no iteration recorded yet."
      : `Latest live iteration #${latest.id} of ${ledger.iterations.length}: ${esc(latest.label)}.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CI speed loop</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#d9d9d2;--accent:#2f6fed;--ok:#1a8f4c;--miss:#c4452d;--goal:#b7791f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--fg:#ececE6;--dim:#9b9b94;--card:#1f1f1d;--line:#34342f;--accent:#6c9bff;--ok:#4cc380;--miss:#ef7a63;--goal:#e2b04a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 10px;font-size:17px}
.dim,small{color:var(--dim)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13.5px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--dim)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
td:nth-child(4){min-width:220px}
.scroll{overflow-x:auto}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
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
.bar{display:grid;grid-template-columns:minmax(150px,38%) 1fr 32px;gap:8px;align-items:center;margin:3px 0}
.barname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.barfill{display:block;height:12px;background:var(--miss);border-radius:3px;min-width:2px}.barnum{text-align:right}
tr.out td{opacity:.55;text-decoration:line-through}tr.out td small{text-decoration:none}
</style></head><body><main>
<h1>CI speed loop</h1>
<p class="dim">${header} Snapshot ${esc(now.toISOString())}. Regenerate with <code>node scripts/ci-speed-loop.mjs report</code>, then reload; the page is a static render of <code>docs/ci-speed/ledger.json</code>. Goal: a change merges within 30 minutes of its last push (PRD-550).</p>
<h2>Progress toward the goal</h2>
<div class="scroll"><table><thead><tr><th>Metric</th><th>Baseline</th><th>Now</th><th>Goal</th><th>Progress</th><th></th></tr></thead><tbody>${strip}</tbody></table></div>
<h2>Trend per iteration</h2>
<div class="grid3">${charts}${barChart(latest?.firstFailingJobs ?? [], "First failing job per red merge group, latest iteration")}</div>
<h2>Iterations</h2>
<div class="scroll"><table><thead><tr><th>#</th><th>Date</th><th>Commit</th><th>Change</th><th>Decision</th><th>Window from</th>${GOALS.map((g) => `<th class="n">${esc(g.short)}</th>`).join("")}</tr></thead><tbody>${history || '<tr><td colspan="12" class="dim">baseline pending</td></tr>'}</tbody></table></div>
<h2>${prTitle}</h2>
<div class="scroll"><table><thead><tr><th>PR</th><th>Title</th><th class="n">Push to merge</th><th class="n">Enqueue to merge</th><th class="n">Attempts</th><th>First attempt</th><th>First failing job</th></tr></thead><tbody>${prs || '<tr><td colspan="7" class="dim">no merged PR in this ledger</td></tr>'}</tbody></table></div>
</main></body></html>
`;
}

function show(ledger) {
  for (const item of ledger.iterations) {
    const cells = GOALS.map((g) => `${g.key}=${item.metrics[g.key] ?? "n/a"}`).join(" ");
    console.log(
      `#${item.id} ${item.at.slice(0, 10)} ${item.decision}${item.superseded ? " (superseded)" : ""} ${item.label}\n   ${cells}`,
    );
  }
  if (ledger.iterations.length === 0) console.log("baseline pending: no iterations recorded");
}

function main(argv) {
  const [command] = argv;
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  let ledger = readLedger();
  if (command === "record") {
    const since = get("--since");
    const label = get("--label");
    if (since === undefined || label === undefined)
      throw new Error("record needs --since YYYY-MM-DD and --label");
    const from = get("--from");
    const measurement =
      from === undefined
        ? measure({ since, base: get("--base") ?? "develop" })
        : JSON.parse(readFileSync(from, "utf8"));
    const commit =
      get("--commit") ??
      execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
    ledger = appendIteration(ledger, {
      measurement,
      label,
      notes: get("--notes") ?? "",
      decision: get("--decision"),
      commit,
    });
    writeAtomic(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  } else if (command === "discard") {
    ledger = discardIteration(ledger, Number(get("--iteration")), get("--reason"));
    writeAtomic(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
  } else if (command === "show") {
    return show(ledger);
  } else if (command !== "report") {
    console.error("usage: ci-speed-loop.mjs record|show|discard|report");
    process.exit(2);
  }
  writeAtomic(HTML, renderHtml(ledger));
  console.log(`wrote ${HTML} (${String(ledger.iterations.length)} iterations)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
