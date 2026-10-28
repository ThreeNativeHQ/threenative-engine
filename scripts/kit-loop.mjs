#!/usr/bin/env node
// PRD-750: the kit authoring loop's measure step. It measures; it does not drive agents.
//
//   pnpm kit:loop record <cold-build dir> --kit collectathon --reference sm64 [--fixes "a; b"] [--notes ...]
//   pnpm kit:loop show
//   pnpm dashboard   # the Kit loop tab renders docs/kit-loop/ledger.json on each load (PRD-751)
//
// A cold-build dir holds five files, each required (a missing one fails closed, never a zero):
//   transcript.json  the cold agent's `claude -p --output-format json` result (K1: usage, duration_ms, num_turns)
//   gates.json       { scenarios: { total, green }, presentedP95Ms, costP95Ms, budgetMs, visualVerdict }  (K2)
//   friction.json    { searchMisses, duplicates, wrongApi, retries } from score-build-experience (K3)
//   play-grade.json  { grade: 1..5, judge } from the fresh Opus play judge (K4)
//   retro.json       { worked: [..], failed: [..], frictions: [{ text, transcriptLine }] } (top 3)
// Row 1 is the baseline; K1 and K3 targets are relative to it.
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const LEDGER = resolve(ROOT, "docs/kit-loop/ledger.json");
/** The judge verdicts that meet K2's visual bar. */
const VISUAL_OK = new Set(["MATCH", "CLOSE"]);

export { readLedger };

/** The PRD-750 targets, set from the baseline row's metrics. */
export const goalsFor = (baseline) => [
  {
    key: "k1Tokens",
    short: "K1 tokens",
    label: "K1 cold-build tokens (input + output + cache writes)",
    unit: "tokens",
    goal: Math.round(baseline.k1Tokens * 0.6),
    better: "lower",
  },
  {
    key: "k2ScenarioPct", // gitleaks:allow (a KPI field id, not a credential; see .gitleaksignore)
    short: "K2 scenarios",
    label: "K2 kit scenarios green on the first cold build",
    unit: "%",
    goal: 100,
    better: "higher",
  },
  {
    key: "k3Friction",
    short: "K3 friction",
    label: "K3 friction count",
    unit: "events",
    goal: Math.floor(baseline.k3Friction * 0.5),
    better: "lower",
  },
  {
    key: "k4Grade",
    short: "K4 grade",
    label: "K4 AI play grade",
    unit: "/5",
    goal: 4,
    better: "higher",
  },
];

function read(dir, name) {
  let text;
  try {
    text = readFileSync(join(dir, name), "utf8");
  } catch {
    throw new Error(`${name} is missing from ${dir}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} is not JSON: ${error.message}`);
  }
}

function count(value, field, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${field} must be a number in [${min}, ${max}], got ${JSON.stringify(value)}`);
  return value;
}

const strings = (value, field) => {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item === ""))
    throw new Error(`${field} must be a list of non-empty strings`);
  return value;
};

/** One cold build's K1-K4 and retro. Throws on any missing file or field. */
export function measureDir(dir) {
  const transcript = read(dir, "transcript.json");
  const gates = read(dir, "gates.json");
  const friction = read(dir, "friction.json");
  const grade = read(dir, "play-grade.json");
  const retro = read(dir, "retro.json");

  const usage = transcript.usage;
  if (usage === null || typeof usage !== "object") throw new Error("transcript.json has no usage");
  const k1Tokens =
    count(usage.input_tokens, "usage.input_tokens") +
    count(usage.output_tokens, "usage.output_tokens") +
    count(usage.cache_creation_input_tokens, "usage.cache_creation_input_tokens");
  const total = count(gates.scenarios?.total, "gates.scenarios.total", { min: 1 });
  const green = count(gates.scenarios?.green, "gates.scenarios.green", { max: total });
  const p95 = count(gates.presentedP95Ms, "gates.presentedP95Ms");
  // The budget is the performance gate's own cost p95 (owner, 2026-10-26): presented p95 on the
  // runner's private Xvfb is display cadence, about 17.5 ms whatever the game costs.
  const cost = count(gates.costP95Ms, "gates.costP95Ms");
  const budget = count(gates.budgetMs, "gates.budgetMs", { min: Number.MIN_VALUE });
  if (typeof gates.visualVerdict !== "string" || gates.visualVerdict === "")
    throw new Error("gates.visualVerdict must name the judge verdict");
  const parts = Object.fromEntries(
    ["searchMisses", "duplicates", "wrongApi", "retries"].map((key) => [
      key,
      count(friction[key], `friction.${key}`),
    ]),
  );
  const frictions = retro.frictions;
  if (!Array.isArray(frictions) || frictions.length === 0 || frictions.length > 3)
    throw new Error("retro.frictions must list the top 3 frictions (1 to 3 items)");
  for (const item of frictions) {
    strings([item?.text], "retro.frictions[].text");
    count(item.transcriptLine, "retro.frictions[].transcriptLine", { min: 1 });
  }
  return {
    metrics: {
      k1Tokens,
      k1WallMin: Math.round(count(transcript.duration_ms, "transcript.duration_ms") / 60_000),
      k1Turns: count(transcript.num_turns, "transcript.num_turns"),
      k2ScenarioPct: Math.round((green / total) * 100),
      k2PresentedP95Ms: p95,
      k2CostP95Ms: cost,
      k2BudgetMs: budget,
      k2BudgetMet: cost <= budget,
      k2Visual: gates.visualVerdict,
      k3Friction: Object.values(parts).reduce((sum, value) => sum + value, 0),
      k4Grade: count(grade.grade, "play-grade.json grade", { min: 1, max: 5 }),
    },
    friction: parts,
    retro: {
      worked: strings(retro.worked, "retro.worked"),
      failed: strings(retro.failed, "retro.failed"),
      frictions,
    },
  };
}

/** Append one measured row. Returns a new ledger; the input is not changed. */
export function appendRow(
  ledger,
  row,
  { kit, reference, fixes = [], notes = "", at = new Date() },
) {
  if (!kit) throw new Error("record needs --kit");
  if (!reference) throw new Error("record needs --reference");
  const id = ledger.iterations.reduce((top, item) => Math.max(top, item.id), 0) + 1;
  const decision = ledger.iterations.length === 0 ? "baseline" : "iteration";
  const next = { id, at: at.toISOString(), decision, kit, reference, fixes, notes, ...row };
  return { ...ledger, iterations: [...ledger.iterations, next] };
}

const list = (items) => `<ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul>`;

export function renderHtml(ledger, now = new Date()) {
  const rows = ledger.iterations;
  const baseline = rows[0];
  const latest = rows.at(-1);
  const goals = baseline === undefined ? [] : goalsFor(baseline.metrics);
  const strip = goals
    .map((goal) => {
      const current = latest.metrics[goal.key];
      const progress = progressToward(goal, baseline.metrics[goal.key], current);
      // K2 is one KPI with three parts (PRD-750): the scenario share alone never meets it.
      const k2Rest = latest.metrics.k2BudgetMet && VISUAL_OK.has(latest.metrics.k2Visual);
      const met = meetsGoal(goal, current) && (goal.key !== "k2ScenarioPct" || k2Rest);
      return `<tr><td>${esc(goal.label)}</td><td class="n">${esc(baseline.metrics[goal.key])}</td><td class="n"><b>${esc(current)}</b></td><td class="n">${goal.better === "lower" ? "≤" : "≥"} ${esc(goal.goal)} ${esc(goal.unit)}</td><td><span class="track"><span class="fill${met ? " ok" : ""}" style="width:${Math.round((progress ?? 0) * 100)}%"></span></span> ${progress === null ? "n/a" : `${Math.round(progress * 100)}%`}</td><td><span class="pill${met ? " ok" : ""}">${met ? "met" : "open"}</span></td></tr>`;
    })
    .join("");
  const charts = goals.map((goal) => lineChart(goal, rows)).join("");
  const history = rows
    .map(
      (row) =>
        `<tr><td>#${row.id}</td><td>${esc(row.at.slice(0, 10))}</td><td>${esc(row.kit)}<br><small>${esc(row.reference)} · ${esc(row.decision)}</small></td><td class="n">${esc(row.metrics.k1Tokens)}<br><small>${esc(row.metrics.k1WallMin)} min · ${esc(row.metrics.k1Turns)} turns</small></td><td class="n">${esc(row.metrics.k2ScenarioPct)}%<br><small>cost p95 ${esc(row.metrics.k2CostP95Ms ?? "n/a")}/${esc(row.metrics.k2BudgetMs)} ms ${row.metrics.k2BudgetMet ? "met" : "over"} (presented ${esc(row.metrics.k2PresentedP95Ms)}) · ${esc(row.metrics.k2Visual)}${VISUAL_OK.has(row.metrics.k2Visual) ? "" : " (below CLOSE)"}</small></td><td class="n">${esc(row.metrics.k3Friction)}</td><td class="n">${esc(row.metrics.k4Grade)}/5</td><td><b>Worked</b>${list(row.retro.worked)}<b>Failed</b>${list(row.retro.failed)}<b>Top frictions</b>${list(row.retro.frictions.map((f) => `${f.text} (transcript line ${f.transcriptLine})`))}${row.fixes.length ? `<b>Fixes landed before it</b>${list(row.fixes)}` : ""}</td></tr>`,
    )
    .join("");
  const header =
    latest === undefined
      ? "Baseline pending: iteration 1 (the collectathon calibration row) is not recorded yet."
      : `Latest iteration #${latest.id} of ${rows.length}: ${esc(latest.kit)} from ${esc(latest.reference)}.`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kit authoring loop</title>
<style>
:root{--bg:#fafaf7;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#d9d9d2;--accent:#2f6fed;--ok:#1a8f4c;--miss:#c4452d;--goal:#b7791f}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161615;--fg:#ececE6;--dim:#9b9b94;--card:#1f1f1d;--line:#34342f;--accent:#6c9bff;--ok:#4cc380;--miss:#ef7a63;--goal:#e2b04a}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:1180px;margin:0 auto;padding:20px 16px 48px}
h1{margin:0 0 4px;font-size:24px}h2{margin:32px 0 10px;font-size:17px}
.dim,small{color:var(--dim)}ul{margin:2px 0 6px;padding-left:18px}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:13.5px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--dim)}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.scroll{overflow-x:auto}
.grid3{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px}
.card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}
figcaption{font-weight:600;margin-bottom:4px}
svg{width:100%;height:auto}
.line{fill:none;stroke:var(--accent);stroke-width:2}
.dot.ok{fill:var(--ok)}.dot.miss{fill:var(--miss)}
.goal{stroke:var(--goal);stroke-dasharray:5 4;stroke-width:1.5}.grid{stroke:var(--line)}
.tick{fill:var(--dim);font-size:11px}.goaltext{fill:var(--goal);font-size:11px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px}.pill.ok{color:var(--ok);border-color:var(--ok)}
.track{display:inline-block;width:110px;height:8px;border-radius:4px;background:var(--line);vertical-align:middle}
.fill{display:block;height:8px;border-radius:4px;background:var(--accent)}.fill.ok{background:var(--ok)}
</style></head><body><main>
<h1>Kit authoring loop</h1>
<p class="dim">${header} Snapshot ${esc(now.toISOString())}. The <code>pnpm dashboard</code> Kit loop tab renders <code>docs/kit-loop/ledger.json</code> on each load. Goal: "make me a game like X" starts from a kit and the first cold build is good on few tokens (PRD-750). K2 also needs the frame budget met and a CLOSE or better visual verdict.</p>
<h2>Progress toward the targets</h2>
<div class="scroll"><table><thead><tr><th>KPI</th><th>Baseline</th><th>Now</th><th>Target</th><th>Progress</th><th></th></tr></thead><tbody>${strip || '<tr><td colspan="6" class="dim">Baseline pending</td></tr>'}</tbody></table></div>
<h2>Trend per iteration</h2>
<div class="grid3">${charts || '<p class="dim">Baseline pending</p>'}</div>
<h2>Iterations and retros</h2>
<div class="scroll"><table><thead><tr><th>#</th><th>Date</th><th>Kit</th><th class="n">K1 tokens</th><th class="n">K2 first build</th><th class="n">K3 friction</th><th class="n">K4 grade</th><th>Retro</th></tr></thead><tbody>${history || '<tr><td colspan="8" class="dim">Baseline pending</td></tr>'}</tbody></table></div>
</main></body></html>
`;
}

function main(argv) {
  const [command, dir] = argv;
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const ledger = readLedger(LEDGER);
  if (command === "record" && dir !== undefined) {
    const next = appendRow(ledger, measureDir(resolve(dir)), {
      kit: get("--kit"),
      reference: get("--reference"),
      fixes:
        get("--fixes")
          ?.split(";")
          .map((fix) => fix.trim())
          .filter(Boolean) ?? [],
      notes: get("--notes") ?? "",
    });
    writeAtomic(LEDGER, `${JSON.stringify(next, null, 2)}\n`);
    return console.log(`kit-loop row #${next.iterations.at(-1).id} recorded in ${LEDGER}`);
  }
  if (command === "show") {
    for (const row of ledger.iterations)
      console.log(`#${row.id} ${row.at.slice(0, 10)} ${row.kit} ${JSON.stringify(row.metrics)}`);
    if (ledger.iterations.length === 0) console.log("baseline pending: no iterations recorded");
    return;
  }
  console.error(
    "usage: kit-loop.mjs record <cold-build dir> --kit <kit> --reference <game> | show",
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
