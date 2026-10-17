#!/usr/bin/env node
/**
 * Campaign dashboard renderer — one machine-readable `results.json` in, one offline `index.html`
 * out. No framework, no backend, no CDN, no dependency: the file must open from `file://`.
 *
 * Written and replaced atomically (sibling temp + rename) so a failed generation leaves the last
 * readable snapshot in place. `ARTIFACT_LINK_ROOTS` is the only place a link may point, because
 * the campaign's evidence is a directory beside this file, never an absolute path on one machine.
 */
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderScoreboard, SCOREBOARD_CSS } from "./scoreboard.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS_PATH = join(here, "results.json");
export const OUTPUT_PATH = join(here, "index.html");
export const ARTIFACT_LINK_ROOTS = Object.freeze(["raw/", "scenarios/", "notes/"]);

/** A link that cannot escape the campaign directory; anything else renders as inert text. */
export function safeLink(href) {
  if (typeof href !== "string" || href === "") return undefined;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/|~)/iu.test(href)) return undefined;
  return ARTIFACT_LINK_ROOTS.some((root) => href.startsWith(root)) ? href : undefined;
}

/**
 * Text escaping is the one non-trivial rule here: every recorded field is untrusted enough to
 * contain a `<`, and the campaign embeds its own data in a `<script>` element.
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function embedJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

const n = (value) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

/** A field the campaign has not recorded yet. JSON has no undefined, so null means the same. */
const absent = (value) => value === undefined || value === null;

/** Absolute and relative delta for one direction. A zero baseline has no percentage, ever. */
export function delta(baseline, candidate, direction) {
  const a = n(baseline);
  const b = n(candidate);
  if (a === undefined || b === undefined) return { absolute: undefined, percent: undefined };
  const absolute = direction === "higher-is-better" ? b - a : a - b;
  return { absolute, percent: a === 0 ? undefined : (absolute / a) * 100 };
}

export function formatValue(value, unit) {
  const v = n(value);
  if (v === undefined) return "unavailable";
  return `${v.toFixed(unit === "ms" ? 2 : 2)}${unit === undefined ? "" : ` ${unit}`}`;
}

/** `clamp((baseline - incumbent) / (baseline - goal), 0, 1)`, and words when there is no number. */
export function goalProgress(baseline, incumbent, goal, direction) {
  if (n(goal) === undefined) return { kind: "no-numeric-target" };
  const { absolute } = delta(baseline, incumbent, direction);
  if (absolute === undefined) return { kind: "unavailable" };
  const span = Math.abs(n(baseline) - n(goal));
  if (span === 0) return { kind: "already-within-target" };
  if (absolute <= 0 && direction !== "higher-is-better") return { kind: "already-within-target" };
  return { kind: "percent", percent: Math.max(0, Math.min(1, absolute / span)) * 100 };
}

function tableRows(rows) {
  return rows
    .map((cells) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("\n");
}

function benchmarkTable(data) {
  const header = [
    "Workload",
    "Platform",
    "Metric",
    "Unit",
    "Baseline",
    "Best accepted",
    "Current candidate",
    "Goal",
    "Δ vs baseline",
    "Noise margin",
    "Samples / repeats",
    "Gate",
    "Status",
  ];
  const rows = data.benchmarks.map((b) => {
    const candidate = absent(b.current) ? b.best : b.current;
    const { absolute, percent } = delta(b.baseline, candidate, b.direction);
    const deltaCell =
      absolute === undefined
        ? `<span class="muted">unavailable${absent(b.currentReason) ? "" : ` — ${escapeHtml(b.currentReason)}`}</span>`
        : `${absolute >= 0 ? "+" : ""}${absolute.toFixed(2)}${percent === undefined ? "" : ` (${absolute >= 0 ? "+" : ""}${percent.toFixed(1)}%)`}`;
    return [
      escapeHtml(b.workload),
      escapeHtml(b.platform),
      escapeHtml(b.metric),
      escapeHtml(b.unit ?? "—"),
      absent(b.baseline) ? `<span class="muted">pending</span>` : formatValue(b.baseline, b.unit),
      b.best === undefined ? `<span class="muted">—</span>` : formatValue(b.best, b.unit),
      absent(b.current)
        ? `<span class="muted">${escapeHtml(b.currentReason ?? "not run")}</span>`
        : formatValue(b.current, b.unit),
      absent(b.goal) ? "no numeric target" : formatValue(b.goal, b.unit),
      deltaCell,
      absent(b.noiseMargin)
        ? `<span class="muted">uncalibrated</span>`
        : b.noiseMargin.kind === "relative"
          ? `${b.noiseMargin.percent.toFixed(1)}% of baseline (screening)`
          : `<span class="muted">${escapeHtml(b.noiseMargin.reason)}</span>`,
      `${absent(b.samples) ? "—" : b.samples}<br><span class="muted">${absent(b.repeats) ? "—" : b.repeats} repeats</span>`,
      escapeHtml(b.gate ?? "unrun"),
      `<span class="pill ${escapeHtml(b.status)}">${escapeHtml(b.status)}</span>`,
    ];
  });
  return `<table>
<thead><tr>${header.map((h) => `<th>${h}</th>`).join("")}</tr></thead>
<tbody>
${tableRows(rows)}
</tbody>
</table>`;
}

function progressSection(data) {
  const parts = [];
  for (const b of data.benchmarks) {
    const history = data.history[b.id] ?? [];
    if (history.length === 0) {
      parts.push(
        `<p class="muted">${escapeHtml(b.metric)} on ${escapeHtml(b.workload)}: no accepted observation yet.</p>`,
      );
      continue;
    }
    const values = history.map((h) => h.value);
    const scale = [b.baseline, b.goal, ...values].filter((v) => n(v) !== undefined);
    const max = Math.max(...scale);
    const min = Math.min(...scale);
    const span = max - min === 0 ? 1 : max - min;
    const width = 640;
    const points = history
      .map((h, i) => {
        const x = history.length === 1 ? 0 : (i / (history.length - 1)) * width;
        const y = 140 - ((h.value - min) / span) * 120;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    const goalY = n(b.goal) === undefined ? undefined : 140 - ((b.goal - min) / span) * 120;
    parts.push(`<figure>
<figcaption>${escapeHtml(b.metric)} — ${escapeHtml(b.workload)} (${escapeHtml(b.unit ?? "")}${b.direction === "higher-is-better" ? ", higher is better" : ", lower is better"}). Baseline ${formatValue(b.baseline, b.unit)}.</figcaption>
<svg viewBox="0 0 ${width} 150" role="img" aria-label="${escapeHtml(b.metric)} accepted history">
${goalY === undefined ? "" : `<line x1="0" y1="${goalY.toFixed(1)}" x2="${width}" y2="${goalY.toFixed(1)}" class="goal" />`}
<polyline points="${points}" class="series" />
${history
  .map((h, i) => {
    const x = history.length === 1 ? 0 : (i / (history.length - 1)) * width;
    const y = 140 - ((h.value - min) / span) * 120;
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" class="dot"><title>${escapeHtml(h.at)} — ${formatValue(h.value, b.unit)} (${escapeHtml(h.decision)})</title></circle>`;
  })
  .join("")}
</svg>
<table><thead><tr><th>At</th><th>Value</th><th>Decision</th><th>Experiment</th></tr></thead><tbody>
${tableRows(
  history.map((h) => [
    escapeHtml(h.at),
    formatValue(h.value, b.unit),
    escapeHtml(h.decision),
    h.experimentId === undefined ? "—" : escapeHtml(h.experimentId),
  ]),
)}
</tbody></table>
</figure>`);
  }
  return parts.join("\n");
}

function experimentsSection(data) {
  const state = (e) => e.decision ?? e.phase ?? "running";
  const decisions = [...new Set(data.experiments.map(state))].sort();
  const workloads = [...new Set(data.experiments.map((e) => e.workload))].sort();
  const platforms = [...new Set(data.experiments.map((e) => e.platform))].sort();
  const select = (id, label, values) =>
    `<label>${label} <select id="${id}"><option value="">all</option>${values
      .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
      .join("")}</select></label>`;
  const cards = data.experiments
    .map(
      (e) => `<details class="exp" data-decision="${escapeHtml(state(e))}" data-workload="${escapeHtml(e.workload)}" data-platform="${escapeHtml(e.platform)}">
<summary><span class="pill ${escapeHtml(state(e))}">${escapeHtml(state(e))}</span> <strong>${escapeHtml(e.id)}</strong> — ${escapeHtml(e.hypothesis)}</summary>
<dl>
<dt>Bottleneck evidence</dt><dd>${escapeHtml(e.bottleneckEvidence)}</dd>
<dt>Layer and files</dt><dd>${escapeHtml(e.layer)}: ${escapeHtml(e.files.join(", "))}</dd>
<dt>Candidate</dt><dd>${escapeHtml(e.candidate ?? "none")}</dd>
<dt>Primary scalar</dt><dd>${formatValue(e.scalar?.candidate, e.unit)} vs incumbent ${formatValue(e.scalar?.incumbent, e.unit)}${absent(e.scalar?.relativePercent) ? "" : ` (${e.scalar.relativePercent.toFixed(1)}%)`}</dd>
<dt>Pre-registered prediction</dt><dd>${escapeHtml(e.prediction ?? "none recorded")}</dd>
<dt>Falsifier</dt><dd>${escapeHtml(e.falsifier ?? "none recorded")}</dd>
<dt>Paired samples / order</dt><dd>${escapeHtml(e.pairs ?? "none")}</dd>
<dt>Real-game result</dt><dd>${escapeHtml(e.gameResult ?? "unavailable")}</dd>
<dt>Sentinel result</dt><dd>${escapeHtml(e.sentinelResult ?? "unavailable")}</dd>
<dt>Gates</dt><dd>${escapeHtml(e.gates ?? "unrun")}</dd>
<dt>Trade-offs</dt><dd>${escapeHtml(e.tradeoffs ?? "none recorded")}</dd>
<dt>Decision and reason</dt><dd><strong>${escapeHtml(state(e))}</strong> — ${escapeHtml(e.reason ?? "in progress")}</dd>
<dt>Duration</dt><dd>${escapeHtml(e.duration ?? "—")}</dd>
<dt>Evidence</dt><dd>${e.evidence
          .map((href) => {
            const link = safeLink(href);
            return link === undefined
              ? `<span class="muted">${escapeHtml(href)} (not linked: outside the campaign directory)</span>`
              : `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`;
          })
          .join(" · ") || `<span class="muted">none</span>`}</dd>
</dl>
</details>`,
    )
    .join("\n");
  return `${select("f-decision", "Decision", decisions)} ${select("f-workload", "Workload", workloads)} ${select("f-platform", "Platform", platforms)}
<div id="experiments">${cards || '<p class="muted">No experiments recorded.</p>'}</div>`;
}

export function render(data) {
  const c = data.campaign;
  const missing = data.benchmarks.filter((b) => absent(b.baseline));
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Tempest performance loop — ${escapeHtml(c.id)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#ddd; --bg:#fff; --card:#fafafa; }
@media (prefers-color-scheme: dark) { :root { --fg:#eee; --muted:#9aa; --line:#3a3f45; --bg:#14171a; --card:#1c2024; } }
body { font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); margin: 0 auto; max-width: 1100px; padding: 1.5rem; }
h1 { font-size: 1.3rem; } h2 { font-size: 1.05rem; margin-top: 1.75rem; border-bottom: 1px solid var(--line); padding-bottom: .25rem; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; font-size: 13px; }
th, td { border: 1px solid var(--line); padding: .3rem .45rem; text-align: left; vertical-align: top; }
th { background: var(--card); }
.muted { color: var(--muted); }
.pill { display:inline-block; border-radius: 1rem; padding: 0 .5rem; font-size: 12px; border: 1px solid var(--line); }
.keep { background: #d7f5dd; color:#0b3d1c; } .reject { background:#f8d7da; color:#5c1119; }
.invalid, .blocked { background:#eee; color:#333; } .provisional { background:#fff3cd; color:#5a4400; }
.inconclusive, .running, .baseline { background:#dbe9ff; color:#123; }
svg { max-width: 100%; height: auto; border: 1px solid var(--line); background: var(--card); }
.series { fill:none; stroke:#2f6fd0; stroke-width:2; } .dot { fill:#2f6fd0; } .goal { stroke:#c33; stroke-dasharray:4 3; }
.exp { border: 1px solid var(--line); border-radius: .4rem; padding: .4rem .6rem; margin: .4rem 0; background: var(--card); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .15rem .75rem; margin: .5rem 0 0; }
dt { color: var(--muted); } dd { margin: 0; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 0 1rem; }
code { background: var(--card); padding: .05rem .25rem; }
${SCOREBOARD_CSS}</style></head>
<body>
<h1>Tempest performance loop — ${escapeHtml(c.id)}</h1>
<p class="muted">Snapshot ${escapeHtml(data.generatedAt)}. This page is generated from <code>results.json</code> and opens offline; if it is old, reload for current progress.</p>
${renderScoreboard(data)}

<h2>Now</h2>
<div class="grid">
<p><strong>Status</strong><br><span class="pill ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span> — ${escapeHtml(c.phase)}<br>
<strong>Evidence</strong> ${escapeHtml((c.evidence ?? []).join(" + ") || "none yet")}</p>
<p><strong>Target</strong><br>${escapeHtml(data.contract.primaryPlatform)} · ${escapeHtml(data.contract.primaryWorkload)}<br>
${escapeHtml(data.environment.cpu)} · ${escapeHtml(data.environment.gpu)} · ${escapeHtml(data.environment.display)}</p>
<p><strong>Started / updated</strong><br>${escapeHtml(c.startedAt)}<br>${escapeHtml(c.updatedAt)}<br>
<strong>Heartbeat</strong> ${escapeHtml(c.heartbeatAt)}${c.staleHeartbeat === true ? ' <span class="pill reject">stale / check process</span>' : ""}<br>
<strong>Deadline</strong> ${escapeHtml(c.deadlineAt ?? "none")}</p>
<p><strong>Revisions</strong><br>starting ${escapeHtml(c.owner.revisionShort)}${c.owner.dirty ? " (dirty)" : ""}<br>
incumbent ${escapeHtml(data.incumbent?.revisionShort ?? "= starting")}<br>
worktree <code>${escapeHtml(c.owner.worktree)}</code><br>branch <code>${escapeHtml(c.owner.branch)}</code></p>
</div>
<p><strong>Active experiment</strong> ${escapeHtml(c.activeExperiment ?? "none")} — phase ${escapeHtml(c.phase)}</p>
<p><strong>Next hypothesis</strong> ${escapeHtml(c.nextHypothesis ?? "none recorded")}</p>
${missing.length > 0 ? `<p class="pill provisional">baseline pending for ${missing.length} benchmark${missing.length === 1 ? "" : "s"}</p>` : ""}

<h2>Benchmarks</h2>
${benchmarkTable(data)}

<h2>Progress</h2>
${progressSection(data)}

<h2>Experiments</h2>
${experimentsSection(data)}

<h2>Coverage and continuation</h2>
<div class="grid">
<p><strong>Platforms</strong><br>${data.coverage.platforms
    .map((p) => `${escapeHtml(p.name)}: ${escapeHtml(p.status)}${p.reason === undefined ? "" : ` — ${escapeHtml(p.reason)}`}`)
    .join("<br>")}</p>
<p><strong>Workload families</strong><br>${data.coverage.workloads.map((w) => escapeHtml(w)).join("<br>")}</p>
<p><strong>Unresolved bottlenecks</strong><br>${data.coverage.unresolved.map((u) => escapeHtml(u)).join("<br>") || "none recorded"}</p>
</div>
<p><strong>Stop reason</strong> ${escapeHtml(data.stopReason ?? "running")}</p>
<p><strong>Resume</strong> ${escapeHtml(data.nextAction ?? "none recorded")}</p>
<h3>Reproduction</h3>
<pre><code>${escapeHtml(data.coverage.reproduction.join("\n"))}</code></pre>
<p class="muted">Artifacts: ${escapeHtml(Object.entries(data.contract.hashes).map(([k, v]) => `${k}=${v}`).join(" · "))}</p>

<script id="campaign-data" type="application/json">${embedJson({
    benchmarks: data.benchmarks.map((b) => ({ id: b.id, metric: b.metric })),
  })}</script>
<script>
(function () {
  var picks = { "f-decision": "decision", "f-workload": "workload", "f-platform": "platform" };
  function apply() {
    var wanted = {};
    Object.keys(picks).forEach(function (id) {
      var el = document.getElementById(id);
      wanted[picks[id]] = el && el.value ? el.value : "";
    });
    document.querySelectorAll("#experiments .exp").forEach(function (node) {
      var show = Object.keys(wanted).every(function (key) {
        return wanted[key] === "" || node.getAttribute("data-" + key) === wanted[key];
      });
      node.style.display = show ? "" : "none";
    });
  }
  Object.keys(picks).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener("change", apply);
  });
})();
</script>
<p id="live" class="muted" aria-live="polite"></p>
<script>
// Live reload: over http, poll this page's Last-Modified every 5 s and reload on change, keeping
// scroll, filters and open experiment cards. Over file:// there is no header, so it stays a snapshot.
(function () {
  var KEY = "tn-dash-state", live = document.getElementById("live");
  try {
    var saved = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (saved) {
      sessionStorage.removeItem(KEY);
      Object.keys(saved.filters || {}).forEach(function (id) {
        var el = document.getElementById(id);
        if (el) { el.value = saved.filters[id]; el.dispatchEvent(new Event("change")); }
      });
      document.querySelectorAll("details.exp").forEach(function (d, i) { d.open = (saved.open || []).indexOf(i) >= 0; });
      window.scrollTo(0, saved.y || 0);
    }
  } catch (e) {}
  if (location.protocol === "file:") { live.textContent = "Snapshot (file://). Open http://127.0.0.1:8767/tempest/ for live updates."; return; }
  var stamp = null;
  function check() {
    fetch(location.href, { method: "HEAD", cache: "no-store" }).then(function (r) {
      var m = r.headers.get("Last-Modified") || r.headers.get("ETag");
      var now = new Date().toLocaleTimeString();
      if (stamp !== null && m && m !== stamp) {
        var state = { y: window.scrollY, filters: {}, open: [] };
        ["f-decision", "f-workload", "f-platform"].forEach(function (id) { var el = document.getElementById(id); if (el) state.filters[id] = el.value; });
        document.querySelectorAll("details.exp").forEach(function (d, i) { if (d.open) state.open.push(i); });
        try { sessionStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
        location.reload();
        return;
      }
      stamp = m;
      live.textContent = "Live: checks for new data every 5 s. Last check " + now + ".";
    }).catch(function () { live.textContent = "Live: server not reachable. Showing the last loaded data."; });
  }
  check();
  setInterval(check, 5000);
})();
</script>
</body></html>
`;
}

export function writeDashboard(results = RESULTS_PATH, output = OUTPUT_PATH) {
  const data = JSON.parse(readFileSync(results, "utf8"));
  data.generatedAt = new Date().toISOString();
  const html = render(data);
  const temp = `${output}.tmp`;
  writeFileSync(temp, html);
  renameSync(temp, output);
  return { bytes: statSync(output).size, output };
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? "")}`) {
  const result = writeDashboard(process.argv[2] ?? RESULTS_PATH, process.argv[3] ?? OUTPUT_PATH);
  process.stdout.write(`${result.output} ${result.bytes} bytes\n`);
}
