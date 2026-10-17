/**
 * Legacy-vs-Wasm scoreboard for the Tempest campaign: one colour per metric (green beats legacy,
 * yellow moving toward it, red behind with no progress, grey unmeasured), line charts of every
 * iteration against the legacy line and the goal, and a bar chart of where the GPU time goes.
 * Colour always comes with a text label. Values the campaign has not measured render as words.
 */
import { escapeHtml } from "./render.mjs";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const fmt = (v, unit) => (num(v) === undefined ? "unavailable" : `${Math.abs(v) < 0.1 ? String(Number(v.toPrecision(2))) : v.toFixed(v >= 100 ? 1 : 2)} ${unit ?? ""}`.trim());

/** Lower is better everywhere on this board. */
export function scoreStatus(row) {
  const kept = num(row.wasmKept);
  if (kept === undefined) return { cls: "grey", label: "unmeasured", arrow: "?" };
  if (row.kind === "limit") {
    return kept <= row.limit
      ? { cls: "green", label: `within limit ${row.limit}`, arrow: "✓" }
      : { cls: "red", label: `over limit ${row.limit}`, arrow: "✗" };
  }
  const legacy = num(row.legacy);
  if (legacy === undefined) return { cls: "grey", label: "no legacy meter", arrow: "?" };
  const target = num(row.target);
  if (target !== undefined) {
    if (kept <= target) return { cls: "green", label: `beats legacy by the target (≤ ${row.target})`, arrow: "✓" };
    if (kept <= legacy) return { cls: "yellow", label: `level with legacy, target ≤ ${row.target}`, arrow: "↓" };
  }
  if (kept <= legacy) return { cls: "green", label: "beats legacy", arrow: "✓" };
  const start = num(row.wasmStart);
  if (start !== undefined && kept < start) return { cls: "yellow", label: "closing the gap", arrow: "↓" };
  const latest = num(row.latest?.value);
  if (latest !== undefined && latest < kept) return { cls: "yellow", label: "promising try, not kept yet", arrow: "↘" };
  return { cls: "red", label: "behind legacy, no kept progress", arrow: "→" };
}

function lineChart(title, unit, points, lines) {
  const W = 640, H = 220, L = 52, R = 110, T = 14, B = 34;
  const ys = [...points.map((p) => p.value), ...lines.map((l) => l.value)].filter((v) => num(v) !== undefined);
  if (points.length === 0 || ys.length === 0) return `<p class="muted">${escapeHtml(title)}: no iterations yet.</p>`;
  const max = Math.max(...ys) * 1.08, min = Math.min(0, ...ys);
  const y = (v) => T + (1 - (v - min) / (max - min || 1)) * (H - T - B);
  const x = (i) => L + (points.length === 1 ? (W - L - R) / 2 : (i / (points.length - 1)) * (W - L - R));
  const ticks = [min, (min + max) / 2, max]
    .map((v) => `<text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" class="ax">${v.toFixed(0)}</text><line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="grid"/>`)
    .join("");
  const hl = lines
    .filter((l) => num(l.value) !== undefined)
    .map((l) => `<line x1="${L}" x2="${W - R}" y1="${y(l.value)}" y2="${y(l.value)}" class="hl ${l.cls}"/><text x="${W - R + 4}" y="${y(l.value) + 4}" class="lbl ${l.cls}">${escapeHtml(l.label)} ${l.value}</text>`)
    .join("");
  const path = points.map((p, i) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const dots = points
    .map((p, i) => `<circle cx="${x(i)}" cy="${y(p.value)}" r="5" class="dot-${escapeHtml(p.decision)}"><title>${escapeHtml(p.at)}: ${fmt(p.value, unit)} (${escapeHtml(p.decision)}, ${escapeHtml(p.experimentId ?? "")})</title></circle><text x="${x(i)}" y="${H - B + 16}" text-anchor="middle" class="ax">${escapeHtml(p.experimentId ?? i)}</text>`)
    .join("");
  return `<figure class="chart"><figcaption><strong>${escapeHtml(title)}</strong> (${escapeHtml(unit)}, lower is better). Dots: every iteration, coloured by decision.</figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(title)} per iteration against legacy and goal">${ticks}${hl}<polyline points="${path}" class="wasm"/>${dots}</svg></figure>`;
}

function barChart(passes) {
  if (!passes || passes.items.length === 0) return "";
  const total = passes.items.reduce((s, [, ms]) => s + ms, 0);
  const max = Math.max(...passes.items.map(([, ms]) => ms));
  const rows = passes.items
    .map(([name, ms]) => `<div class="brow"><span class="bname">${escapeHtml(name)}</span><span class="btrack"><span class="bfill" style="width:${((100 * ms) / max).toFixed(1)}%"></span></span><span class="bval">${ms.toFixed(2)} ms · ${((100 * ms) / total).toFixed(0)}%</span></div>`)
    .join("");
  return `<figure class="chart"><figcaption><strong>Where the Wasm GPU time goes</strong> — ${escapeHtml(passes.run)}, total ${total.toFixed(1)} ms. ${escapeHtml(passes.note ?? "")}</figcaption>${rows}</figure>`;
}

export function renderScoreboard(data) {
  const sb = data.scoreboard;
  if (!sb) return "";
  const rows = sb.rows.map((r) => ({ r, s: scoreStatus(r) }));
  const head = rows.find(({ r }) => r.id === sb.headlineRow) ?? rows[0];
  const ratio = num(head.r.legacy) && num(head.r.wasmKept) ? head.r.wasmKept / head.r.legacy : undefined;
  const banner = `<div class="banner ${head.s.cls}"><span class="big">${ratio === undefined ? "?" : `${ratio.toFixed(2)}x`}</span>
<div><strong>${escapeHtml(head.r.metric)}: Wasm ${fmt(head.r.wasmKept, head.r.unit)} vs legacy ${fmt(head.r.legacy, head.r.unit)}</strong><br>
${head.s.arrow} ${escapeHtml(head.s.label)}. ${escapeHtml(sb.direction ?? "")}</div></div>`;
  const table = `<table class="score"><thead><tr><th>Status</th><th>Metric</th><th>Legacy (stock three)</th><th>Wasm at start</th><th>Wasm kept</th><th>Wasm / legacy</th><th>Latest try</th><th>Goal</th></tr></thead><tbody>
${rows
  .map(({ r, s }) => `<tr class="${s.cls}"><td><span class="pill ${s.cls}">${s.arrow} ${escapeHtml(s.label)}</span></td><td>${escapeHtml(r.metric)}</td>
<td>${r.kind === "limit" ? `limit ${r.limit}` : fmt(r.legacy, r.unit)}</td><td>${fmt(r.wasmStart, r.unit)}</td><td><strong>${fmt(r.wasmKept, r.unit)}</strong></td>
<td>${num(r.legacy) && num(r.wasmKept) ? `${(r.wasmKept / r.legacy).toFixed(2)}x` : "—"}</td>
<td>${r.latest ? `${fmt(r.latest.value, r.unit)} <span class="muted">(${escapeHtml(r.latest.experimentId)}, ${escapeHtml(r.latest.decision)})</span>` : "—"}</td>
<td>${r.goal === undefined ? "—" : escapeHtml(r.goal)}</td></tr>`)
  .join("\n")}</tbody></table>`;
  const charts = rows
    .filter(({ r }) => r.historyId && (data.history[r.historyId] ?? []).length > 0)
    .map(({ r }) =>
      lineChart(r.metric, r.unit, data.history[r.historyId], [
        { value: r.legacy, label: "legacy", cls: "legacy" },
        { value: num(r.goalValue), label: "goal", cls: "goal2" },
      ]),
    )
    .join("");
  const ratioPts = (sb.ratioHistory ?? []).filter((p) => num(p.value) !== undefined);
  const ratioChart = ratioPts.length ? lineChart("GPU gap: Wasm ÷ legacy", "x", ratioPts, [{ value: 1, label: "parity", cls: "legacy" }]) : "";
  return `<h2>Scoreboard: legacy vs Wasm web</h2>
<p class="muted">Green: Wasm beats legacy. Yellow: moving toward legacy (kept gain or a promising try). Red: behind legacy with no kept progress. Grey: not measured.</p>
${banner}${table}<div class="charts">${ratioChart}${charts}${barChart(sb.passes)}</div>`;
}

export const SCOREBOARD_CSS = `
.banner{display:flex;gap:1rem;align-items:center;border-radius:.5rem;padding:.8rem 1rem;margin:.5rem 0 1rem;border:2px solid}
.banner .big{font-size:2.2rem;font-weight:700}
.banner.green,.pill.green{background:#d7f5dd;color:#0b3d1c;border-color:#1e8e3e}
.banner.yellow,.pill.yellow{background:#fff3cd;color:#5a4400;border-color:#d4a106}
.banner.red,.pill.red{background:#f8d7da;color:#5c1119;border-color:#c5221f}
.banner.grey,.pill.grey{background:#eee;color:#333;border-color:#999}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,30rem),1fr));gap:1rem}
.chart{margin:0;border:1px solid var(--line);border-radius:.4rem;padding:.5rem;background:var(--card)}
.chart svg{border:0;width:100%}
.ax{font-size:11px;fill:var(--muted)} .grid{stroke:var(--line);stroke-width:1}
.wasm{fill:none;stroke:#2f6fd0;stroke-width:2.5}
.hl{stroke-width:2;stroke-dasharray:6 4} .hl.legacy{stroke:#1e8e3e} .hl.goal2{stroke:#9334e6}
.lbl{font-size:11px} .lbl.legacy{fill:#1e8e3e} .lbl.goal2{fill:#9334e6}
.dot-baseline{fill:#2f6fd0} .dot-keep{fill:#1e8e3e} .dot-reject{fill:#c5221f} .dot-provisional{fill:#d4a106} .dot-invalid{fill:#888} .dot-inconclusive{fill:#5f6368}
.brow{display:grid;grid-template-columns:minmax(8rem,16rem) 1fr 8rem;gap:.5rem;align-items:center;font-size:13px;margin:.2rem 0}
.btrack{background:var(--line);height:12px;border-radius:6px;overflow:hidden} .bfill{display:block;height:100%;background:#c5221f}
.bval{text-align:right;color:var(--muted)}
`;
