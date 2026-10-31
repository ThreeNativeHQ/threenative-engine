// The stress lab dashboard: tabs, the 120 fps ladder, the load ramp, the paired arms and the ledger table.
// Presentation only. It reads ledger rows and changes no number; stress-loop.mjs hosts it (renderHtml).
import { esc } from "./ci-speed-loop.mjs";

/** The goal ladder: presented p95 rungs, tightest first. */
export const RUNGS = [
  { ms: 8.33, fps: 120 },
  { ms: 11.1, fps: 90 },
  { ms: 16.67, fps: 60 },
];
/** A 60 Hz vsync pass reads 16.7 to 16.8 ms at its best; that is the 60 fps rung, not a miss. */
const SLACK = 1.03;
const LINE_60 = RUNGS[2].ms;
const LINE_30 = 33.3;
const RAMP = [1, 2, 4, 8];
const PASSES = ["vsync", "uncapped"];
const BASE_ARM = /^(develop|head|stack\d*)$/u;
/** A scene tag that names a contaminated run (a loaded host, a stray page). */
const VOID_SCENES = ["loadedHost", "strayPage"];
const SHORT = {
  "threenative-wasm": "ThreeNative",
  "threenative-threejs": "ThreeNative (three.js)",
  "three-vanilla": "Vanilla three.js",
  unreal: "Unreal",
};
const SHADOW = { virtual: "VSM", plain: "plain sun" };

const flagsOf = (variant) => (typeof variant === "string" ? variant.split("&") : []);
/** `load=N` in a variant, default 1. `arm=load` is an arm name, so only a whole `load=<digits>` flag counts. */
export function loadOf(variant) {
  for (const flag of flagsOf(variant)) {
    const match = /^load=(\d+)$/u.exec(flag);
    if (match !== null && Number(match[1]) > 0) return Number(match[1]);
  }
  return 1;
}
const armOf = (row) =>
  flagsOf(row.variant)
    .find((flag) => flag.startsWith("arm="))
    ?.slice(4);
const num = (value, digits = 2) =>
  typeof value === "number" && Number.isFinite(value)
    ? String(Math.round(value * 10 ** digits) / 10 ** digits)
    : "—";
const passOf = (row) => row.pass ?? (flagsOf(row.variant).includes("uncapped") ? "uncapped" : null);

/** A run is void above the host-load limit, or when its scene tag names a contaminated run. */
export const isVoid = (row, loadVoid) =>
  (row.load?.peak ?? 0) > loadVoid ||
  flagsOf(row.variant).some((flag) => VOID_SCENES.includes(flag));
/** A valid fair-window row: it has a host-load record, a pass, a finite presented p95 and is not void. */
const isValid = (row, loadVoid) =>
  row.load !== undefined &&
  row.load !== null &&
  passOf(row) !== null &&
  Number.isFinite(row.metrics?.presentedP95Ms) &&
  !isVoid(row, loadVoid);

/** The latest kept row, else the latest row that was not rejected. */
const pick = (rows) =>
  rows.filter((row) => row.decision !== "reject").findLast((row) => row.decision === "keep") ??
  rows.filter((row) => row.decision !== "reject").at(-1);

const runsOf = (row) => {
  const match = /mean of (\d+) run\(s\) \((\d+) void\)/u.exec(row.notes ?? "");
  return match === null ? undefined : { used: Number(match[1]), voided: Number(match[2]) };
};

/**
 * The ramp, one series per engine and shadow mode, one cell per pass and load.
 * A cell with no valid run keeps `row` undefined and `p95` null. It is never zero.
 */
export function rampCells(rows, { loadVoid, shadowOf }) {
  const valid = rows.filter((row) => isValid(row, loadVoid));
  const loads = [...new Set([...RAMP, ...valid.map((row) => loadOf(row.variant))])].sort(
    (a, b) => a - b,
  );
  const keys = [...new Set(valid.map((row) => `${row.engine}|${shadowOf(row)}`))];
  return keys
    .map((key) => {
      const [engine, shadow] = key.split("|");
      const mine = valid.filter((row) => row.engine === engine && shadowOf(row) === shadow);
      const cells = Object.fromEntries(
        PASSES.map((pass) => [
          pass,
          loads.map((load) => {
            const row = pick(mine.filter((r) => passOf(r) === pass && loadOf(r.variant) === load));
            return { load, row, p95: row?.metrics.presentedP95Ms ?? null };
          }),
        ]),
      );
      return { key, engine, shadow, cells };
    })
    .sort((a, b) => Object.keys(SHORT).indexOf(a.engine) - Object.keys(SHORT).indexOf(b.engine));
}

/**
 * The first load whose p95 is over `limit`, or null. `gapBefore` says a lower load has no valid run,
 * so the true break point may be lower.
 */
export function breakPoint(cells, limit) {
  const sorted = [...cells].sort((a, b) => a.load - b.load);
  const found = sorted.findIndex((cell) => cell.p95 !== null && cell.p95 > limit);
  if (found < 0) return null;
  return {
    load: sorted[found].load,
    p95: sorted[found].p95,
    gapBefore: sorted.slice(0, found).some((cell) => cell.p95 === null),
  };
}

const seriesName = (s) =>
  `${SHORT[s.engine] ?? s.engine}${s.engine === "three-vanilla" ? "" : ` · ${SHADOW[s.shadow]}`}`;
const swatch = (index) => `var(--s${(index % 3) + 1})`;
const fpsOf = (ms) => `${Math.round(1000 / ms)} fps`;

/** Where p95 stands on the ladder: the tightest rung it meets, or null. */
export const rungOf = (p95) => RUNGS.find((rung) => p95 <= rung.ms * SLACK) ?? null;
const tone = (p95) => (p95 <= LINE_60 * SLACK ? "ok" : p95 <= LINE_30 * SLACK ? "mid" : "bad");

function breakText(cells, limit) {
  const known = cells.filter((cell) => cell.p95 !== null);
  if (known.length === 0) return `<span class="dim">no valid run</span>`;
  const found = breakPoint(cells, limit * SLACK);
  if (found === null)
    return `<span class="t-ok">holds to load ${known.at(-1).load}</span>${known.length < cells.length ? ` <span class="dim" title="loads with no valid run">· ${cells.length - known.length} unmeasured</span>` : ""}`;
  return `<b class="t-${limit < 20 ? "mid" : "bad"}">load ${found.load}</b> <span class="dim">${num(found.p95, 1)} ms${found.gapBefore ? " · gap below" : ""}</span>`;
}

/** The p95 against load, log scale, one line per series. A gap breaks the line and shows a hollow marker. */
function rampChart(series, pass) {
  const [W, H, pl, pr, pt, pb] = [480, 240, 36, 12, 14, 34];
  const all = series.flatMap((s) => s.cells[pass].map((c) => c.p95).filter((v) => v !== null));
  const lo = Math.min(7, ...all.map((v) => v / 1.15));
  const hi = Math.max(45, ...all.map((v) => v * 1.15));
  const loads = series[0]?.cells[pass].map((c) => c.load) ?? RAMP;
  const x = (i) => pl + ((W - pl - pr) * (i + 0.5)) / loads.length;
  const y = (v) => H - pb - ((H - pt - pb) * Math.log(v / lo)) / Math.log(hi / lo);
  const ref = (ms, cls, label) =>
    `<line class="${cls}" x1="${pl}" x2="${W - pr}" y1="${y(ms).toFixed(1)}" y2="${y(ms).toFixed(1)}"/><text class="${cls === "goal" ? "goaltext" : "tick"}" x="${W - pr - 2}" y="${(y(ms) - 3).toFixed(1)}" text-anchor="end">${label}</text>`;
  const ticks = [10, 100]
    .filter((v) => v > lo && v < hi)
    .map(
      (v) =>
        `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}"/><text class="tick" x="${pl - 4}" y="${y(v).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${v}</text>`,
    )
    .join("");
  const marks = series
    .map((s, si) => {
      const cells = s.cells[pass];
      const runs = [];
      let run = [];
      cells.forEach((cell, i) => {
        if (cell.p95 === null) {
          if (run.length > 0) runs.push(run);
          run = [];
        } else run.push([x(i), y(cell.p95)]);
      });
      if (run.length > 0) runs.push(run);
      const color = swatch(si);
      const lines = runs
        .filter((r) => r.length > 1)
        .map(
          (r) =>
            `<polyline fill="none" stroke="${color}" stroke-width="2" points="${r.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}"/>`,
        )
        .join("");
      const dots = cells
        .map((cell, i) => {
          if (cell.p95 === null) {
            const off = (si - (series.length - 1) / 2) * 9;
            return `<circle cx="${(x(i) + off).toFixed(1)}" cy="${H - pb - 5}" r="3" fill="none" stroke="${color}" stroke-dasharray="2 1.5"><title>${esc(seriesName(s))}, load ${cell.load}: no valid run</title></circle>`;
          }
          const partial = runsOf(cell.row);
          return `<circle cx="${x(i).toFixed(1)}" cy="${y(cell.p95).toFixed(1)}" r="4" fill="${color}"><title>${esc(seriesName(s))}, load ${cell.load}: ${num(cell.p95, 1)} ms (#${cell.row.id}${partial ? `, ${partial.used} of ${partial.used + partial.voided} runs` : ""})</title></circle>`;
        })
        .join("");
      return lines + dots;
    })
    .join("");
  const xs = loads
    .map(
      (load, i) =>
        `<text class="tick" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">load ${load}</text>`,
    )
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Presented p95 against load, ${pass} pass, log scale">${ticks}${ref(RUNGS[0].ms, "grid", "120 fps")}${ref(LINE_60, "goal", "16.7 ms · 60 fps")}${ref(LINE_30, "miss", "33.3 ms · 30 fps")}${marks}${xs}</svg>`;
}

const legend = (series) =>
  series
    .map(
      (s, i) =>
        `<span class="inline-flex items-center gap-1"><i class="inline-block h-2 w-2 rounded-full" style="background:${swatch(i)}"></i>${esc(seriesName(s))}</span>`,
    )
    .join("");

const loadHead = (series, label) => {
  const loads = series[0]?.cells.vsync.map((c) => c.load) ?? RAMP;
  return `<thead><tr><th rowspan="2">${label}</th>${PASSES.map((p) => `<th colspan="${loads.length}" class="grp">${p} · load</th>`).join("")}</tr><tr>${PASSES.flatMap(() => loads.map((l) => `<th class="n">${l}</th>`)).join("")}</tr></thead>`;
};

function rampTab(rows, ctx) {
  const series = rampCells(rows, ctx);
  if (series.length === 0)
    return `<p class="dim">no valid run: the load ramp needs fair-window rows (<code>pnpm stress:loop fair</code>) with <code>load=N</code> in the variant.</p>`;
  const charts = PASSES.map(
    (pass) =>
      `<figure class="card"><figcaption>Presented p95 against load · ${pass} <span class="dim">(log scale)</span></figcaption>${rampChart(series, pass)}</figure>`,
  ).join("");
  const breaks = `<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">${series
    .map(
      (s, i) =>
        `<div class="card"><b><i class="mr-1 inline-block h-2 w-2 rounded-full" style="background:${swatch(i)}"></i>${esc(seriesName(s))}</b><table class="t mt-1"><thead><tr><th>Pass</th><th>Over 16.7 ms</th><th>Over 33.3 ms</th></tr></thead><tbody>${PASSES.map((p) => `<tr><td>${p}</td>${[LINE_60, LINE_30].map((limit) => `<td>${breakText(s.cells[p], limit)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
    )
    .join("")}</div>`;
  const cell = (c) => {
    if (c.p95 === null) return `<td class="n dim" title="no valid run">no valid run</td>`;
    const partial = runsOf(c.row);
    const tag =
      partial && partial.voided > 0
        ? ` <sup title="${partial.used} of ${partial.used + partial.voided} runs valid">${partial.used}/${partial.used + partial.voided}</sup>`
        : "";
    return `<td class="n t-${tone(c.p95)}" title="#${c.row.id} ${esc(armOf(c.row) ?? "")}">${num(c.p95, 1)}${tag}</td>`;
  };
  const matrix = `<div class="scroll"><table class="t">${loadHead(series, "Presented p95 (ms)")}<tbody>${series
    .map(
      (s) =>
        `<tr><td class="whitespace-nowrap">${esc(seriesName(s))}</td>${PASSES.flatMap((p) => s.cells[p].map(cell)).join("")}</tr>`,
    )
    .join("")}</tbody></table></div>`;
  const costRows = [
    ["Update p50 ms", "updateP50Ms", 2],
    ["GPU p50 ms", "gpuP50Ms", 2],
    ["JS↔Wasm crossings", "bridgeCrossingsP50", 0],
    ["GPU upload KB", "gpuUploadKbP50", 0],
    ["Main draws", "mainDraws", 0],
    ["Triangles M", "mainTrianglesM", 2],
  ];
  const costCell = (c, key, digits) => {
    if (c.row === undefined) return `<td class="n dim" title="no valid run">no run</td>`;
    const value = c.row.metrics[key];
    return `<td class="n">${value === null || value === undefined ? `<span class="dim" title="this engine does not report it">n/a</span>` : num(value, digits)}</td>`;
  };
  const costs = `<div class="scroll"><table class="t">${loadHead(series, "Scaling cost (p50)")}<tbody>${series
    .map(
      (s, i) =>
        `<tr class="sec"><td colspan="${1 + PASSES.length * s.cells.vsync.length}"><i class="mr-1 inline-block h-2 w-2 rounded-full" style="background:${swatch(i)}"></i>${esc(seriesName(s))}</td></tr>${costRows
          .map(
            ([label, key, digits]) =>
              `<tr><td class="pl-4">${label}</td>${PASSES.flatMap((p) => s.cells[p].map((c) => costCell(c, key, digits))).join("")}</tr>`,
          )
          .join("")}`,
    )
    .join("")}</tbody></table></div>`;
  return `<div class="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dim">${legend(series)}<span>hollow circle or <b>no valid run</b> = no valid run at that load (void host load, or not measured). Never zero.</span><span>Over-line tolerance: ${Math.round((SLACK - 1) * 100)}% (a 60 Hz vsync pass reads 16.7 to 16.8 ms).</span></div>
<div class="grid gap-3 lg:grid-cols-2">${charts}</div>
<h2>Break points: the first load over each line</h2>${breaks}
<h2>Presented p95 by load</h2>${matrix}
<h2>Scaling costs per load</h2>${costs}`;
}

/** One Overview lane: where the develop baseline, the best kept arm and vanilla stand on the ladder. */
function laneOf(rows, ctx, shadow, pass) {
  const mine = rows.filter(
    (row) => isValid(row, ctx.loadVoid) && passOf(row) === pass && loadOf(row.variant) === 1,
  );
  const tn = mine.filter(
    (row) => row.engine === "threenative-wasm" && ctx.shadowOf(row) === shadow,
  );
  const kept = tn
    .filter((row) => row.decision === "keep")
    .reduce(
      (best, row) =>
        best === undefined || row.metrics.presentedP95Ms <= best.metrics.presentedP95Ms
          ? row
          : best,
      undefined,
    );
  return {
    shadow,
    pass,
    baseline: tn.findLast((row) => BASE_ARM.test(armOf(row) ?? "")),
    kept,
    vanilla:
      shadow === "plain" ? mine.findLast((row) => row.engine === "three-vanilla") : undefined,
  };
}

function ladder(lanes) {
  const [W, top, laneH, labelW, max] = [560, 24, 44, 138, 36];
  const x = (ms) => labelW + ((W - labelW - 10) * Math.min(ms, max)) / max;
  const H = top + lanes.length * laneH + 6;
  const rungs = [...RUNGS, { ms: LINE_30, fps: 30 }]
    .map(
      (rung) =>
        `<line class="${rung.fps === 30 ? "grid" : "goal"}" x1="${x(rung.ms).toFixed(1)}" x2="${x(rung.ms).toFixed(1)}" y1="${top - 4}" y2="${H - 6}"/><text class="${rung.fps === 30 ? "tick" : "goaltext"}" x="${x(rung.ms).toFixed(1)}" y="${top - 8}" text-anchor="${{ 120: "end", 90: "start" }[rung.fps] ?? "middle"}">${rung.fps} fps</text>`,
    )
    .join("");
  const mark = (row, kind, cy) => {
    if (row === undefined) return "";
    const v = row.metrics.presentedP95Ms;
    const cx = x(v);
    const title = `<title>${kind} #${row.id} ${esc(armOf(row) ?? "")}: ${num(v, 2)} ms${v > max ? " (off the scale)" : ""}</title>`;
    if (kind === "baseline")
      return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="5" fill="var(--s1)">${title}</circle>`;
    if (kind === "best kept")
      return `<polygon points="${cx},${cy - 6} ${cx + 6},${cy} ${cx},${cy + 6} ${cx - 6},${cy}" fill="var(--ok)">${title}</polygon>`;
    return `<rect x="${(cx - 5).toFixed(1)}" y="${cy - 5}" width="10" height="10" fill="var(--s3)">${title}</rect>`;
  };
  const body = lanes
    .map((lane, i) => {
      const cy = top + i * laneH + laneH / 2;
      return `<line class="grid" x1="${labelW}" x2="${W - 10}" y1="${cy}" y2="${cy}"/><text class="lane" x="${labelW - 8}" y="${cy}" text-anchor="end" dominant-baseline="middle">${SHADOW[lane.shadow]} · ${lane.pass}</text>${mark(lane.vanilla, "vanilla", cy)}${mark(lane.baseline, "baseline", cy - 7)}${mark(lane.kept, "best kept", cy + 7)}`;
    })
    .join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Presented p95 against the 120, 90 and 60 fps rungs">${rungs}${body}</svg>`;
}

function overviewTab(rows, ctx, extra) {
  const lanes = [];
  for (const shadow of ["virtual", "plain"])
    for (const pass of PASSES) lanes.push(laneOf(rows, ctx, shadow, pass));
  const cell = (row) => {
    if (row === undefined) return `<td class="dim">no valid run</td>`;
    const v = row.metrics.presentedP95Ms;
    return `<td class="t-${tone(v)}"><b>${num(v, 2)}</b> <span class="dim">#${row.id} ${esc(armOf(row) ?? "")}</span></td>`;
  };
  const verdict = (lane) => {
    const best = [lane.baseline, lane.kept]
      .filter((row) => row !== undefined)
      .map((row) => row.metrics.presentedP95Ms);
    if (best.length === 0) return `<td class="dim">no valid run</td>`;
    const rung = rungOf(Math.min(...best));
    return rung === null
      ? `<td class="t-bad">above 60 fps (${fpsOf(Math.min(...best))})</td>`
      : `<td class="t-ok">${rung.fps} fps rung ✅</td>`;
  };
  const table = `<div class="scroll"><table class="t"><thead><tr><th>Scene</th><th>Pass</th><th>Develop baseline p95</th><th>Best kept arm p95</th><th>Vanilla three.js p95</th><th>Rung met</th></tr></thead><tbody>${lanes
    .map(
      (lane) =>
        `<tr><td>${SHADOW[lane.shadow]}</td><td>${lane.pass}</td>${cell(lane.baseline)}${cell(lane.kept)}${lane.shadow === "plain" ? cell(lane.vanilla) : `<td class="dim">no equivalent</td>`}${verdict(lane)}</tr>`,
    )
    .join("")}</tbody></table></div>`;
  return `<div class="grid items-start gap-3 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
<figure class="card"><figcaption>120 fps goal ladder · presented p95 <span class="dim">(ms, load 1)</span></figcaption>${ladder(lanes)}<p class="mt-1 text-[11px] text-dim"><span style="color:var(--s1)">●</span> latest develop baseline · <span style="color:var(--ok)">◆</span> best kept arm · <span style="color:var(--s3)">■</span> vanilla three.js (plain sun only) · rungs 8.33 / 11.1 / 16.67 ms</p></figure>
<div><h2>Where it stands</h2>${table}<p class="mt-1 text-[11px] text-dim">VSM is <code>?stress</code>; plain sun is <code>?stress&amp;plainShadow</code>. A vsync pass floors at 16.7 ms on a 60 Hz display, so only the uncapped pass can show 90 or 120 fps. Baseline is the latest <code>develop</code>, <code>head</code> or <code>stack*</code> arm.</p></div></div>
${extra}`;
}

const DELTAS = [
  ["Pres p95", "presentedP95Ms", 2],
  ["CPU p95", "frameP95Ms", 2],
  ["GPU p50", "gpuP50Ms", 2],
  ["Update p50", "updateP50Ms", 2],
  ["Render p50", "renderP50Ms", 2],
  ["Upload KB", "gpuUploadKbP50", 0],
  ["Draws", "mainDraws", 0],
];

/** The fair windows that ran a base and at least one arm on the same engine, scene, load and pass. */
export function pairsOf(rows, { loadVoid, shadowOf }) {
  const groups = new Map();
  for (const row of rows) {
    const tag = /^FAIR window (\S+) \(/u.exec(row.label ?? "")?.[1];
    if (tag === undefined || !isValid(row, loadVoid)) continue;
    const key = [tag, passOf(row), row.engine, shadowOf(row), loadOf(row.variant)].join("|");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map(([base, ...arms]) => ({ base, arms }))
    .reverse();
}

function armsTab(rows, ctx, comparison) {
  const pairs = pairsOf(rows, ctx);
  const body = pairs
    .flatMap(({ base, arms }) =>
      arms.map((arm) => {
        const cells = DELTAS.map(([, key, digits]) => {
          const [b, a] = [base.metrics[key], arm.metrics[key]];
          if (typeof b !== "number" || typeof a !== "number") return `<td class="n dim">n/a</td>`;
          const d = a - b;
          const flat = Math.abs(d) <= Math.abs(b) * 0.01;
          const cls = flat ? "dim" : d < 0 ? "t-ok" : "t-bad";
          return `<td class="n" title="base ${num(b, digits)}">${num(a, digits)}<span class="d ${cls}">${flat ? "≈" : `${d > 0 ? "+" : ""}${num(d, digits)}`}</span></td>`;
        }).join("");
        const verdict = (arm.notes ?? "").split(" | ").slice(1).join(" | ");
        const shadow = ctx.shadowOf(arm);
        return `<tr data-pass="${esc(passOf(arm))}" data-decision="${esc(arm.decision)}" data-shadow="${shadow}" data-q="${esc(`${armOf(arm)} ${armOf(base)} ${arm.label}`.toLowerCase())}"><td class="whitespace-nowrap">#${arm.id}</td><td class="whitespace-nowrap"><b>${esc(armOf(arm) ?? "—")}</b> <span class="dim">vs ${esc(armOf(base) ?? "base")} #${base.id}</span></td><td>${SHADOW[shadow]}${loadOf(arm.variant) > 1 ? ` · load ${loadOf(arm.variant)}` : ""}</td><td>${passOf(arm)}</td>${cells}<td><span class="chip ${arm.decision}">${esc(arm.decision)}</span></td><td class="max-w-[28ch] truncate" title="${esc(verdict)}">${esc(verdict)}</td></tr>`;
      }),
    )
    .join("");
  const select = (field, values) =>
    `<select data-f="${field}" aria-label="${field}"><option value="">${field}: all</option>${values.map((v) => `<option>${esc(v)}</option>`).join("")}</select>`;
  return `<div data-grid="arms"><div class="mb-2 flex flex-wrap items-center gap-2">${select("pass", PASSES)}${select("decision", ["keep", "reject", "measure"])}${select("shadow", ["virtual", "plain"])}<input data-q type="search" placeholder="filter arm or label" aria-label="filter arm or label"><span class="text-[11px] text-dim" data-count></span></div>
<div class="scroll"><table class="t"><thead><tr><th>Row</th><th>Arm vs base</th><th>Scene</th><th>Pass</th>${DELTAS.map(([label]) => `<th class="n">${label}</th>`).join("")}<th>Decision</th><th>Verdict</th></tr></thead><tbody>${body || `<tr><td colspan="${DELTAS.length + 6}" class="dim">no valid run: no paired fair windows yet</td></tr>`}</tbody></table></div></div>
<p class="mt-1 text-[11px] text-dim">Each cell is the arm's value; the small line is arm minus base (lower is better): <span class="t-ok">green</span> better, <span class="t-bad">red</span> worse, ≈ within 1%. Hover a cell for the base value. The base is the first row of its window; the decision is the lane's.</p>
${comparison}`;
}

function ledgerTab(rows, ctx) {
  const cols = [
    ["FPS", "fps", 1, ""],
    ["Pres p50", "presentedP50Ms", 2, ""],
    ["Pres p95", "presentedP95Ms", 2, ""],
    ["CPU p95", "frameP95Ms", 2, ""],
    ["GPU p95", "gpuP95Ms", 2, ""],
    ["Update", "updateP50Ms", 2, ""],
    ["Render", "renderP50Ms", 2, ""],
    ["Draws", "mainDraws", 0, ""],
    ["Tri M", "mainTrianglesM", 2, ""],
    ["Bridge", "bridgeCrossingsP50", 0, " /frame"],
    ["Upload", "gpuUploadKbP50", 0, " KB/frame"],
  ];
  const body = rows
    .map((row) => {
      const shadow = ctx.shadowOf(row);
      const load = loadOf(row.variant);
      const pass = passOf(row);
      const arm = armOf(row) ?? "—";
      const flag = isVoid(row, ctx.loadVoid)
        ? ` <span class="chip reject" title="void: host load above ${ctx.loadVoid}, or a contaminated scene">void</span>`
        : row.load === undefined || row.load === null
          ? ` <span class="chip" title="no host-load record: measured before the fair window">legacy</span>`
          : "";
      const cells = cols
        .map(([, key, digits, unit]) => {
          const v = row.metrics[key];
          const text = v === null || v === undefined ? "n/a" : `${num(v, digits)}${unit}`;
          return `<td class="n${v === null || v === undefined ? " dim" : ""}" data-v="${v ?? ""}">${text}</td>`;
        })
        .join("");
      return `<tr data-engine="${esc(row.engine)}" data-pass="${esc(pass ?? "none")}" data-shadow="${shadow}" data-load="${load}" data-decision="${esc(row.decision)}" data-q="${esc(`${arm} ${row.variant} ${row.label} ${row.commit}`.toLowerCase())}"><td class="n" data-v="${row.id}">#${row.id}</td><td class="whitespace-nowrap">${esc(row.at.slice(5, 10))}</td><td class="whitespace-nowrap">${esc(SHORT[row.engine] ?? row.engine)}</td><td>${pass ?? "—"}</td><td class="whitespace-nowrap">${SHADOW[shadow] ?? shadow}</td><td class="n" data-v="${load}">${load}</td><td class="whitespace-nowrap">${esc(arm)}</td><td class="whitespace-nowrap"><span class="chip ${esc(row.decision)}">${esc(row.decision)}</span>${flag}</td>${cells}<td class="n" data-v="${row.load?.peak ?? ""}">${row.load ? num(row.load.peak, 2) : "—"}</td><td class="max-w-[34ch] truncate" title="${esc(row.label)}">${esc(row.label)}</td></tr>`;
    })
    .join("");
  const uniq = (get) => [...new Set(rows.map(get))].sort();
  const select = (field, values) =>
    `<select data-f="${field}" aria-label="${field}"><option value="">${field}: all</option>${values.map((v) => `<option>${esc(v)}</option>`).join("")}</select>`;
  const head = [
    ["#", 1],
    ["Date"],
    ["Engine"],
    ["Pass"],
    ["Scene"],
    ["Load", 1],
    ["Arm"],
    ["Decision"],
    ...cols.map(([label]) => [label, 1]),
    ["Host load", 1],
    ["Label"],
  ]
    .map(
      ([label, numeric], i) =>
        `<th data-sort="${i}" class="${numeric ? "n " : ""}cursor-pointer select-none" title="sort">${esc(label)}</th>`,
    )
    .join("");
  return `<h2>Iterations</h2>
<div data-grid="ledger"><div class="mb-2 flex flex-wrap items-center gap-2">${select(
    "engine",
    uniq((r) => r.engine),
  )}${select("pass", [...PASSES, "none"])}${select("shadow", ["virtual", "plain"])}${select(
    "load",
    uniq((r) => String(loadOf(r.variant))).sort((a, b) => a - b),
  )}${select(
    "decision",
    uniq((r) => r.decision),
  )}<input data-q type="search" placeholder="filter arm, label or commit" aria-label="filter arm, label or commit"><span class="text-[11px] text-dim" data-count></span></div>
<div class="scroll tall"><table class="t ledger"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="24" class="dim">pending</td></tr>`}</tbody></table></div></div>`;
}

/** Tabs, filters and sorting. No template placeholders or backticks: this string is embedded as written. */
const SCRIPT = `
const tabs=[...document.querySelectorAll('[role=tab]')],panels=[...document.querySelectorAll('[data-panel]')];
function show(name){if(!panels.some(p=>p.dataset.panel===name))name='overview';
tabs.forEach(t=>t.setAttribute('aria-selected',String(t.dataset.tab===name)));panels.forEach(p=>{p.hidden=p.dataset.panel!==name});}
tabs.forEach(t=>t.addEventListener('click',()=>{history.replaceState(null,'','#'+t.dataset.tab);show(t.dataset.tab)}));
addEventListener('hashchange',()=>show(location.hash.slice(1)));show(location.hash.slice(1));
document.querySelectorAll('[data-grid]').forEach(grid=>{
const key='stress-lab-'+grid.dataset.grid,rows=[...grid.querySelectorAll('tbody tr')],count=grid.querySelector('[data-count]');
const sels=[...grid.querySelectorAll('select[data-f]')],q=grid.querySelector('input[data-q]');
const save=()=>{try{sessionStorage.setItem(key,JSON.stringify({s:sels.map(s=>s.value),q:q.value}))}catch(e){}};
const apply=()=>{let n=0;rows.forEach(r=>{const ok=sels.every(s=>s.value===''||r.dataset[s.dataset.f]===s.value)&&(q.value===''||(r.dataset.q||'').includes(q.value.toLowerCase()));r.hidden=!ok;if(ok)n++});
if(count)count.textContent=n+' of '+rows.length+' rows';save()};
try{const old=JSON.parse(sessionStorage.getItem(key)||'null');if(old){sels.forEach((s,i)=>{if([...s.options].some(o=>o.value===old.s[i]))s.value=old.s[i]});q.value=old.q||''}}catch(e){}
sels.forEach(s=>s.addEventListener('change',apply));q.addEventListener('input',apply);apply();
grid.querySelectorAll('th[data-sort]').forEach(th=>th.addEventListener('click',()=>{
const i=+th.dataset.sort,dir=th.dataset.dir==='asc'?-1:1;th.dataset.dir=dir===1?'asc':'desc';
const val=r=>{const c=r.children[i],v=c.dataset.v!==undefined?c.dataset.v:c.textContent.trim();return v===''?null:isNaN(+v)?v:+v};
const body=grid.querySelector('tbody');
[...rows].sort((a,b)=>{const x=val(a),y=val(b);if(x===null)return 1;if(y===null)return -1;return (x>y?1:x<y?-1:0)*dir}).forEach(r=>body.appendChild(r))}))});
`;

const STYLE = `
:root{--bg:#f6f6f2;--fg:#1d1d1b;--dim:#6b6b66;--card:#fff;--line:#d9d9d2;--accent:#2f6fed;--ok:#1a8f4c;--miss:#c4452d;--goal:#b7791f;--ok-bg:#e4f4ea;--ok-ink:#11693a;--miss-bg:#fbe9e5;--miss-ink:#a63220;--warn-bg:#fbf1dc;--s1:#2f6fed;--s2:#8b5cf6;--s3:#d9822b}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141413;--fg:#ececE6;--dim:#9b9b94;--card:#1f1f1d;--line:#34342f;--accent:#6c9bff;--ok:#4cc380;--miss:#ef7a63;--goal:#e2b04a;--ok-bg:#1c3326;--ok-ink:#7fdca6;--miss-bg:#3a2420;--miss-ink:#ff9c88;--warn-bg:#3a3019;--s1:#6c9bff;--s2:#b69cff;--s3:#f0a85a}}
body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,sans-serif}
main h2{margin:14px 0 6px;font-size:13px;font-weight:600}main h3{margin:10px 0 4px;font-size:12px;font-weight:600}
main>nav.tabs{max-width:1240px;margin:0 auto;padding:10px 16px 0;box-sizing:border-box}
code{font-size:11.5px}.dim,small{color:var(--dim)}
.t,.cmp{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);font-size:11.5px;font-variant-numeric:tabular-nums}
.t th,.t td,.cmp th,.cmp td{padding:3px 7px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}.t th{font-weight:600;color:var(--dim);background:var(--card);white-space:nowrap}
.t th.grp{text-align:center;border-left:1px solid var(--line)}.t tr.sec td{background:var(--bg);font-weight:600}
.t .n,.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.t tbody tr:hover td{background:color-mix(in srgb,var(--accent) 7%,var(--card))}
.t .d{display:block;font-size:10px;line-height:1.1}.t sup{font-size:9px;color:var(--dim)}
.scroll{overflow-x:auto;max-width:100%}.scroll.tall{max-height:70vh;overflow:auto}.ledger thead th{position:sticky;top:0;z-index:1}
.t-ok{color:var(--ok-ink)}.t-mid{color:var(--goal)}.t-bad{color:var(--miss-ink)}
.chip{display:inline-block;padding:0 6px;border-radius:99px;border:1px solid var(--line);font-size:10.5px;line-height:16px;color:var(--dim)}
.chip.keep{color:var(--ok-ink);background:var(--ok-bg);border-color:transparent}.chip.reject{color:var(--miss-ink);background:var(--miss-bg);border-color:transparent}.chip.baseline{color:var(--accent)}
.card{margin:0;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px 10px;min-width:0}.card p{margin:2px 0}
figcaption{font-weight:600;font-size:12px;margin-bottom:2px}
main .grid>*{min-width:0}
svg{width:100%;height:auto;display:block}svg .grid{stroke:var(--line);fill:none}
svg .goal{stroke:var(--goal);stroke-dasharray:5 4;stroke-width:1.2}svg .miss{stroke:var(--miss);stroke-dasharray:5 4;stroke-width:1.2}
svg .tick{fill:var(--dim);font-size:11px}svg .goaltext{fill:var(--goal);font-size:11px}svg .lane{fill:var(--fg);font-size:11px}
svg .line{fill:none;stroke:var(--accent);stroke-width:2}svg .dot.ok{fill:var(--ok)}svg .dot.miss{fill:var(--miss)}
select,input[type=search]{font:inherit;font-size:12px;padding:2px 6px;border:1px solid var(--line);border-radius:6px;background:var(--card);color:var(--fg)}
details>summary{cursor:pointer;font-weight:600;font-size:13px;margin:12px 0 6px}
[hidden]{display:none!important}
.cmp td:first-child,.cmp th:first-child{position:sticky;white-space:nowrap;left:0;background:var(--card);box-shadow:1px 0 0 var(--line)}
.cmp .best{background:var(--ok-bg);color:var(--ok-ink);font-weight:600}.cmp .worst{background:var(--miss-bg);color:var(--miss-ink);font-weight:600}.cmp .warn{background:var(--warn-bg)}
.cmp .d{display:block;font-size:10.5px;font-weight:400;color:var(--dim)}.cmp .d.good{color:var(--ok-ink)}.cmp .d.bad{color:var(--miss-ink)}
`;

const TAILWIND_CONFIG = `tailwind.config={theme:{extend:{colors:{dim:'var(--dim)',line:'var(--line)',card:'var(--card)',accent:'var(--accent)'}}}}`;

/**
 * The whole page. `parts` carries what stress-loop.mjs builds itself: the KPI table, the trend charts and the
 * engine comparison tables. `ctx` is `{ loadVoid, shadowOf }`.
 */
export function renderDashboard(ledger, now, ctx, parts) {
  // The first rows predate the `engine` field: they were all ThreeNative (Wasm).
  const rows = ledger.iterations.map((row) =>
    row.engine === undefined ? { ...row, engine: "threenative-wasm" } : row,
  );
  const verified = rows.filter((row) => row.load !== undefined && row.load !== null).length;
  const tabs = [
    ["overview", "Overview", ""],
    ["ramp", "Load ramp", ""],
    ["arms", "Arms / levers", pairsOf(rows, ctx).length],
    ["ledger", "Ledger", rows.length],
  ];
  const nav = tabs
    .map(
      ([id, name, count]) =>
        `<button role="tab" data-tab="${id}" aria-selected="false" class="whitespace-nowrap border-b-2 border-transparent px-3 py-1.5 text-[13px] font-medium text-dim hover:text-[color:var(--fg)] aria-selected:border-accent aria-selected:text-[color:var(--fg)]">${name}${count === "" ? "" : ` <span class="chip">${count}</span>`}</button>`,
    )
    .join("");
  const stats = `${rows.length} rows · ${verified} fair-window rows with a host-load record · ${rows.length - verified} legacy rows (left out of the ladder and the ramp) · a run above host load ${ctx.loadVoid} is void`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="15"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Stress lab</title>
<script src="https://cdn.tailwindcss.com/3.4.17"></script>
<script>${TAILWIND_CONFIG}</script>
<style>${STYLE}</style></head><body><main><div class="mx-auto max-w-[1240px] px-4 pb-10 pt-3">
<header class="mb-2 flex flex-wrap items-baseline gap-x-3"><h1 class="m-0 text-lg font-semibold">Stress lab</h1><span class="text-[11.5px] text-dim">${esc(parts.header)} Snapshot ${esc(now.toISOString())}.</span></header>
<p class="m-0 mb-2 text-[11px] text-dim">${esc(stats)}. The <code>pnpm dashboard</code> Stress lab tab renders <code>docs/stress-loop/ledger.json</code> on each load.</p>
<nav class="mb-3 flex overflow-x-auto border-b border-line" role="tablist" aria-label="Stress lab sections">${nav}</nav>
<section data-panel="overview">${overviewTab(rows, ctx, parts.overview)}</section>
<section data-panel="ramp" hidden>${rampTab(rows, ctx)}</section>
<section data-panel="arms" hidden>${armsTab(rows, ctx, parts.comparison)}</section>
<section data-panel="ledger" hidden>${ledgerTab(rows, ctx)}</section>
</div></main><noscript><style>[data-panel]{display:block!important}</style></noscript><script>${SCRIPT}</script></body></html>
`;
}
