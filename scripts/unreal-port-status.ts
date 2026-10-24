/**
 * Refreshes the Unreal port status from the PRD files, so the feature map never drifts from them.
 *
 * 1. Writes every PRD the feature map names (title, path, ticked and total boxes) into the page's
 *    `// @prds-start` block.
 *    Inlines the per-subsystem internals from `research/internals/<system>.json` the same way.
 * 2. Evaluates the page's `// @data-start` block and draws the progress map as a static SVG.
 * 3. Appends a snapshot of the box counts to `port-history.json` when they change, and draws the
 *    burn-up chart `unreal-port-progress.svg` with the finish date at the recent pace.
 * 4. Rewrites the status block of the root README between the `unreal-port-status` markers.
 *
 * Output depends on the working tree only, so `--check` gives the same answer locally and in CI.
 *
 * Usage: `pnpm unreal:status` (write) · `pnpm unreal:status --check` (exit 1 when stale)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dirname, "..");
export const PAGE = "docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.html";
const SVG = "docs/PRDs/Unreal/research/unreal-port-status.svg";
const README = "README.md";
const INTERNALS = "docs/PRDs/Unreal/research/internals";
const HISTORY = "docs/PRDs/Unreal/research/port-history.json";
const PROGRESS_SVG = "docs/PRDs/Unreal/research/unreal-port-progress.svg";

export interface IPrdEntry {
  readonly t: string;
  readonly p: string;
  readonly r: string;
  readonly s: string;
  readonly d: number;
  readonly n: number;
  readonly f: "open" | "done" | "blocked";
}

type Sub = [string, number | null, string, string, string, string[]];
interface IProg {
  readonly k: string;
  readonly pct?: number;
}
interface IPageData {
  readonly SYS: Record<string, { name: string; subs: Sub[] }>;
  readonly F: { sys: string; loc: number; big: boolean }[];
  readonly AREA_OF: Record<string, string>;
  readonly PORT: {
    id: string;
    wave: number;
    done: number;
    total: number;
    cx: number;
    vis: number;
    perf: number;
    visSrc: string;
    perfSrc: string;
    rank: number;
    waits: string;
  }[];
  readonly PRDS: Record<string, { f: string }>;
  readonly prog: (r: Sub) => IProg;
  readonly rankScore: (p: { vis: number; perf: number; cx: number }) => number;
}

/** Evaluates the page's `// @data-start … // @data-end` block: plain data and pure rules. */
function evalData(page: string): IPageData {
  const code = block(page, "data").exec(page)?.[0];
  if (!code) throw new Error(`${PAGE}: no // @data-start … // @data-end block`);
  return runInNewContext(
    `${code}\n({ SYS, F, AREA_OF, PORT, PRDS, prog, rankScore })`,
  ) as IPageData;
}

export const pageData = (): IPageData => evalData(readFileSync(join(ROOT, PAGE), "utf8"));

const block = (text: string, name: string): RegExp =>
  new RegExp(`// @${name}-start[\\s\\S]*?// @${name}-end`);

function prdFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => /(^|\/)PRD-[^/]+\.md$/.test(f))
    .map((f) => join(dir, f));
}

/** Title, status and box counts of one PRD file, as the page shows them. */
export function readPrd(path: string, text: string): IPrdEntry {
  const h1 = /^# (.+)$/m.exec(text)?.[1] ?? path;
  const done = (text.match(/^\s*- \[[xX]\]/gm) ?? []).length;
  return {
    t: h1.replace(/^PRD-[\w-]+?\s+[—–-]+\s+/, "").trim(),
    p: path,
    r: "develop",
    s: /^\*\*Status:\*\*\s*([A-Z ]+)/m.exec(text)?.[1]?.trim() ?? "",
    d: done,
    n: done + (text.match(/^\s*- \[ \]/gm) ?? []).length,
    f: path.includes("/done/") ? "done" : path.includes("/BLOCKED/") ? "blocked" : "open",
  };
}

/** The registry for every PRD id the page names. An open copy wins over a stale done copy. */
export function buildRegistry(page: string, files: readonly string[]): Record<string, IPrdEntry> {
  const body = page.replace(block(page, "prds"), "");
  const ids = new Set(
    [...body.matchAll(/"((?:VQ-)?\d{2,3})"/g)]
      .map((m) => m[1] ?? "")
      .filter((i) => i.startsWith("VQ-") || Number(i) >= 200),
  );
  const out: Record<string, IPrdEntry> = {};
  for (const id of [...ids].sort()) {
    const hits = files
      .filter((f) => new RegExp(`(^|/)PRD-${id}-[^/]*\\.md$`).test(f))
      .sort(
        (a, b) =>
          Number(a.includes("/done/")) - Number(b.includes("/done/")) || a.length - b.length,
      );
    const hit = hits[0];
    if (hit) out[id] = readPrd(hit, readFileSync(join(ROOT, hit), "utf8"));
  }
  return out;
}

interface IRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Squarified treemap (Bruls et al.): lays `items` out in `r`, largest first, near-square cells. */
export function squarify<T>(
  items: readonly T[],
  value: (t: T) => number,
  r: IRect,
): { item: T; rect: IRect }[] {
  const queue = items.map((item) => ({ item, v: value(item) })).sort((a, b) => b.v - a.v);
  const out: { item: T; rect: IRect }[] = [];
  let { x0, y0 } = r;
  const { x1, y1 } = r;
  let rest = queue.reduce((a, q) => a + q.v, 0);
  const worst = (row: readonly { v: number }[], side: number, scale: number): number => {
    const vs = row.map((q) => q.v * scale);
    const s = vs.reduce((a, v) => a + v, 0);
    return Math.max(
      (side * side * Math.max(...vs)) / (s * s),
      (s * s) / (side * side * Math.min(...vs)),
    );
  };
  while (queue.length > 0) {
    const w = x1 - x0;
    const h = y1 - y0;
    const scale = rest > 0 ? (w * h) / rest : 0;
    const side = Math.min(w, h);
    const row = queue.splice(0, 1);
    for (
      let next = queue[0];
      next && worst([...row, next], side, scale) <= worst(row, side, scale);
      next = queue[0]
    ) {
      row.push(...queue.splice(0, 1));
    }
    const rowSum = row.reduce((a, q) => a + q.v, 0);
    const thick = side > 0 && scale > 0 ? (rowSum * scale) / side : 0;
    let off = 0;
    for (const q of row) {
      const len = rowSum > 0 ? (q.v / rowSum) * side : 0;
      const rect =
        w >= h
          ? { x0, y0: y0 + off, x1: x0 + thick, y1: y0 + off + len }
          : { x0: x0 + off, y0, x1: x0 + off + len, y1: y0 + thick };
      out.push({ item: q.item, rect });
      off += len;
    }
    if (w >= h) x0 += thick;
    else y0 += thick;
    rest -= rowSum;
  }
  return out;
}

const COLOR: Record<string, string> = {
  done: "#3aa56c",
  progress: "#d9961f",
  notstarted: "#4a86d6",
  deferred: "#6c7176",
  gap: "url(#gap)",
  rule: "#3b403d",
  unsplit: "#2c322f",
};
const LABEL: Record<string, string> = {
  done: "Done",
  progress: "In progress",
  notstarted: "Not started",
  deferred: "Deferred",
  gap: "No PRD",
  rule: "Out of scope by rule",
  unsplit: "Not split",
};

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const fit = (s: string, px: number, size: number): string => {
  const n = Math.floor(px / (size * 0.56));
  return n <= 2 ? "" : s.length <= n ? s : `${s.slice(0, n - 1)}…`;
};

interface ILeaf {
  readonly name: string;
  readonly k: string;
  readonly pct: number;
  readonly v: number;
}

/** Subsystems with their state and weight, per Unreal system, per area. Tool-heavy modules are left out. */
export function leaves(
  data: IPageData,
): { area: string; systems: { name: string; total: number; subs: ILeaf[] }[] }[] {
  const keys = [...new Set(data.F.filter((f) => !f.big).map((f) => f.sys))];
  const areas = new Map<string, { name: string; total: number; subs: ILeaf[] }[]>();
  for (const k of keys) {
    const sys = data.SYS[k];
    if (!sys) continue;
    const subs = sys.subs;
    const total = data.F.filter((f) => f.sys === k).reduce((a, f) => a + f.loc, 0);
    const kids: ILeaf[] = subs.map((r) => {
      const p = data.prog(r);
      return { name: r[0], k: p.k, pct: p.pct ?? 0, v: r[1] ?? 400 };
    });
    const rest = total - subs.reduce((a, r) => a + (r[1] ?? 0), 0);
    if (rest > total * 0.03)
      kids.push({ name: `Rest of ${sys.name}`, k: "unsplit", pct: 0, v: rest });
    const area = data.AREA_OF[k] ?? "Other";
    areas.set(area, [...(areas.get(area) ?? []), { name: sys.name, total, subs: kids }]);
  }
  return [...areas].map(([area, systems]) => ({ area, systems }));
}

export function renderSvg(data: IPageData): {
  svg: string;
  share: Record<string, number>;
  total: number;
} {
  const W = 1200;
  const H = 720;
  const top = 64;
  const tree = leaves(data);
  const all = tree.flatMap((a) => a.systems.flatMap((s) => s.subs));
  const total = all.reduce((a, l) => a + l.v, 0);
  const share: Record<string, number> = {};
  for (const l of all) share[l.k] = (share[l.k] ?? 0) + l.v / total;
  const parts: string[] = [];
  const weight = (subs: readonly ILeaf[]): number => subs.reduce((t, l) => t + l.v, 0);
  const areaWeight = (a: (typeof tree)[number]): number =>
    a.systems.reduce((t, y) => t + weight(y.subs), 0);
  for (const { item: a, rect: ar } of squarify(tree, areaWeight, {
    x0: 8,
    y0: top,
    x1: W - 8,
    y1: H - 8,
  })) {
    parts.push(
      `<rect x="${ar.x0 + 2}" y="${ar.y0 + 2}" width="${ar.x1 - ar.x0 - 4}" height="${ar.y1 - ar.y0 - 4}" rx="6" fill="#1a1e1c" stroke="#2c322f"/>`,
    );
    parts.push(
      `<text x="${ar.x0 + 9}" y="${ar.y0 + 15}" class="a">${xml(fit(`${a.area.toUpperCase()} · ${Math.round(areaWeight(a) / 1000)}K`, ar.x1 - ar.x0 - 14, 10))}</text>`,
    );
    const inner = { x0: ar.x0 + 5, y0: ar.y0 + 20, x1: ar.x1 - 5, y1: ar.y1 - 5 };
    for (const { item: s, rect: sr } of squarify(a.systems, (y) => weight(y.subs), inner)) {
      parts.push(
        `<rect x="${sr.x0 + 1}" y="${sr.y0 + 1}" width="${Math.max(0, sr.x1 - sr.x0 - 2)}" height="${Math.max(0, sr.y1 - sr.y0 - 2)}" rx="4" fill="#232826"/>`,
      );
      const label = fit(s.name, sr.x1 - sr.x0 - 8, 10.5);
      const head = label && sr.y1 - sr.y0 > 30 ? 14 : 2;
      if (head > 2)
        parts.push(`<text x="${sr.x0 + 5}" y="${sr.y0 + 12}" class="s">${xml(label)}</text>`);
      const box = { x0: sr.x0 + 2, y0: sr.y0 + head, x1: sr.x1 - 2, y1: sr.y1 - 2 };
      for (const { item: l, rect: lr } of squarify(s.subs, (x) => x.v, box)) {
        const w = lr.x1 - lr.x0 - 1;
        const h = lr.y1 - lr.y0 - 1;
        if (w <= 0 || h <= 0) continue;
        parts.push(
          `<rect x="${lr.x0}" y="${lr.y0}" width="${w}" height="${h}" rx="2" fill="${COLOR[l.k]}"><title>${xml(`${s.name} · ${l.name} · ${LABEL[l.k]}`)}</title></rect>`,
        );
        if (l.k === "progress")
          parts.push(
            `<rect x="${lr.x0}" y="${lr.y0 + h - 3}" width="${Math.max(2, w * l.pct)}" height="3" fill="#fff" opacity=".85"/>`,
          );
        const t = h > 18 ? fit(l.name, w - 6, 9.5) : "";
        if (t) parts.push(`<text x="${lr.x0 + 3}" y="${lr.y0 + 11}" class="l">${xml(t)}</text>`);
      }
    }
  }
  let lx = 8;
  const legend = Object.entries(LABEL)
    .map(([k, label]) => {
      const item = `<rect x="${lx}" y="40" width="11" height="11" rx="2" fill="${COLOR[k]}"/><text x="${lx + 16}" y="50" class="g">${label} ${Math.round((share[k] ?? 0) * 100)}%</text>`;
      lx += 26 + (label.length + 5) * 6.6;
      return item;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<defs><pattern id="gap" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#8a3b37"/><rect width="4" height="8" fill="#e0625a"/></pattern>
<style>.a{fill:#9aa49f;font-size:10px;font-weight:600;letter-spacing:.06em}.s{fill:#e7ebe8;font-size:10.5px;font-weight:600}.l{fill:#fff;font-size:9.5px}.g{fill:#e7ebe8;font-size:12px}.h{fill:#e7ebe8;font-size:17px;font-weight:700}</style></defs>
<rect width="${W}" height="${H}" rx="10" fill="#121513"/>
<text x="8" y="26" class="h">Unreal 5.8.3 → ThreeNative: ${Math.round((share.done ?? 0) * 100)}% done, ${Math.round((share.progress ?? 0) * 100)}% in progress (share of ${Math.round(total / 1000)}K Unreal lines)</text>
${legend}
${parts.join("\n")}
</svg>
`;
  return { svg, share, total };
}

/** One point of the burn-up: ticked and total boxes of every mapped PRD, and of the default look (waves 1-4). */
export interface ISnap {
  readonly date: string;
  readonly done: number;
  readonly total: number;
  readonly lookDone: number;
  readonly lookTotal: number;
  readonly open: number;
}

/** A PRD that is not on this branch yet counts with its PORT row, as the page shows it. */
export function snapshot(
  registry: Record<string, IPrdEntry>,
  port: IPageData["PORT"],
  date: string,
): ISnap {
  const ids = new Set([...Object.keys(registry), ...port.map((p) => p.id)]);
  let done = 0;
  let total = 0;
  let lookDone = 0;
  let lookTotal = 0;
  let open = 0;
  for (const id of ids) {
    const r = registry[id];
    const p = port.find((q) => q.id === id);
    const n = r ? r.n : (p?.total ?? 0);
    const d = r ? (r.f === "done" ? r.n : r.d) : (p?.done ?? 0);
    done += d;
    total += n;
    if (r?.f !== "done" && d < n) open++;
    if (p && p.wave <= 4) {
      lookDone += d;
      lookTotal += n;
    }
  }
  return { date, done, total, lookDone, lookTotal, open };
}

const sameCounts = (a: ISnap, b: ISnap): boolean =>
  a.done === b.done &&
  a.total === b.total &&
  a.lookDone === b.lookDone &&
  a.lookTotal === b.lookTotal &&
  a.open === b.open;

/** Appends `snap` when the counts changed; a second change on the same day replaces that day's point. */
export function updateHistory(history: readonly ISnap[], snap: ISnap): ISnap[] {
  const last = history.at(-1);
  if (last && sameCounts(last, snap)) return [...history];
  return last?.date === snap.date ? [...history.slice(0, -1), snap] : [...history, snap];
}

const DAY = 864e5;

/** Boxes ticked per week over the last 14 days or more (the newest snapshot at least 14 days old). */
export function pace(history: readonly ISnap[]): number {
  const last = history.at(-1);
  const first = history[0];
  if (!last || !first) return 0;
  const t = Date.parse(last.date);
  const base = [...history].reverse().find((s) => t - Date.parse(s.date) >= 14 * DAY) ?? first;
  const days = (t - Date.parse(base.date)) / DAY;
  return days > 0 ? ((last.done - base.done) / days) * 7 : 0;
}

/** The day `left` boxes run out at `rate` boxes a week, counted from the newest snapshot. */
export function finish(history: readonly ISnap[], left: number, rate: number): string | null {
  const last = history.at(-1);
  if (!last || rate <= 0) return null;
  return new Date(Date.parse(last.date) + (left / rate) * 7 * DAY).toISOString().slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const short = (iso: string): string =>
  `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8, 10))}`;
const long = (iso: string | null): string =>
  iso ? `${short(iso)}, ${iso.slice(0, 4)}` : "no pace yet";

/** Burn-up: done and total boxes over time, with a dashed projection to each finish date. */
export function renderProgressSvg(history: readonly ISnap[]): string {
  const W = 1200;
  const H = 380;
  const L = 56;
  const R = 24;
  const T = 74;
  const B = 40;
  const rate = pace(history);
  const last = history.at(-1);
  const first = history[0];
  if (!last || !first) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 40"/>\n`;
  const t0 = Date.parse(first.date);
  // The port order runs waves 1-4 first, so the default look finishes on the shared pace before the rest.
  const all = { eta: finish(history, last.total - last.done, rate) };
  const look = { eta: finish(history, last.lookTotal - last.lookDone, rate) };
  const t1 = Math.max(
    Date.parse(last.date) + 7 * DAY,
    ...[all.eta, look.eta].filter((e) => e !== null).map((e) => Date.parse(e)),
  );
  // Share of boxes ticked, so scope growth and progress read as one line per scope.
  const pct = (done: number, total: number): number => (total > 0 ? (done / total) * 100 : 0);
  const yMax = 100;
  const x = (iso: string | number): number =>
    L + ((Number(typeof iso === "string" ? Date.parse(iso) : iso) - t0) / (t1 - t0)) * (W - L - R);
  const y = (v: number): number => H - B - (v / yMax) * (H - T - B);
  const line = (pick: (s: ISnap) => number): string =>
    history
      .map((s, i) => `${i ? "L" : "M"}${x(s.date).toFixed(1)},${y(pick(s)).toFixed(1)}`)
      .join("");
  const parts: string[] = [];
  for (let v = 0; v <= yMax; v += yMax / 4) {
    parts.push(
      `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#2c322f"/><text x="${L - 8}" y="${y(v) + 4}" class="t" text-anchor="end">${v}%</text>`,
    );
  }
  for (let t = t0; t <= t1; t += 14 * DAY) {
    const iso = new Date(t).toISOString().slice(0, 10);
    parts.push(
      `<text x="${x(t)}" y="${H - B + 18}" class="t" text-anchor="middle">${short(iso)}</text>`,
    );
  }
  const proj = (
    eta: string | null,
    from: number,
    to: number,
    color: string,
    label: string,
    dy: number,
  ): void => {
    if (!eta) return;
    parts.push(
      `<path d="M${x(last.date)},${y(from)}L${x(eta)},${y(to)}" stroke="${color}" stroke-width="2" stroke-dasharray="6 5" fill="none"/>`,
    );
    parts.push(
      `<circle cx="${x(eta)}" cy="${y(to)}" r="4" fill="${color}"/><text x="${Math.min(x(eta), W - R - 4)}" y="${y(to) + dy}" class="e" fill="${color}" text-anchor="end">${label} ≈ ${long(eta)}</text>`,
    );
  };
  parts.push(
    `<path d="${line((s) => pct(s.done, s.total))}" stroke="#3aa56c" stroke-width="2.5" fill="none"/>`,
  );
  parts.push(
    `<path d="${line((s) => pct(s.lookDone, s.lookTotal))}" stroke="#4a86d6" stroke-width="2.5" fill="none"/>`,
  );
  proj(all.eta, pct(last.done, last.total), 100, "#3aa56c", "Everything filed", -10);
  proj(look.eta, pct(last.lookDone, last.lookTotal), 100, "#4a86d6", "Default look", 18);
  const legend = [
    ["#3aa56c", "Every filed PRD: share of boxes ticked"],
    ["#4a86d6", "Default look (waves 1-4): share of boxes ticked"],
    ["#9aa49f", "Dashed: finish at the last 2 weeks' pace"],
  ]
    .map(
      ([c, t], i) =>
        `<rect x="${L + i * 340}" y="46" width="14" height="4" fill="${c}"/><text x="${L + 20 + i * 340}" y="52" class="t">${t}</text>`,
    )
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, -apple-system, Segoe UI, sans-serif">
<style>.h{fill:#e7ebe8;font-size:17px;font-weight:700}.t{fill:#9aa49f;font-size:12px}.e{font-size:12.5px;font-weight:600}</style>
<rect width="${W}" height="${H}" rx="10" fill="#121513"/>
<text x="16" y="28" class="h">Unreal port burn-up: ${last.done} of ${last.total} PRD boxes ticked · ${Math.round(rate)} a week over the last 2 weeks · ${last.open} PRDs open</text>
${legend}
${parts.join("\n")}
</svg>
`;
}

function readmeBlock(
  share: Record<string, number>,
  total: number,
  data: IPageData,
  registry: Record<string, IPrdEntry>,
  history: readonly ISnap[],
): string {
  const rate = pace(history);
  const last = history.at(-1);
  const lookEta = last ? finish(history, last.lookTotal - last.lookDone, rate) : null;
  const allEta = last ? finish(history, last.total - last.done, rate) : null;
  const pc = (k: string): string => `${Math.round((share[k] ?? 0) * 100)}%`;
  const gaps = Object.values(data.SYS).reduce(
    (a, s) => a + s.subs.filter((r) => data.prog(r).k === "gap").length,
    0,
  );
  const subs = Object.values(data.SYS).reduce((a, s) => a + s.subs.length, 0);
  const open = Object.values(registry).filter((p) => p.f === "open").length;
  return `<!-- unreal-port-status:start (generated by \`pnpm unreal:status\`; do not edit) -->
Every Unreal 5.8.3 system that sets the look or the frame cost, split into ${subs} subsystems and
measured in lines of the Unreal source. Each one maps to the ThreeNative PRD that ports it.

**${pc("done")} done · ${pc("progress")} in progress · ${pc("notstarted")} not started · ${pc("deferred")} deferred · ${pc("gap")} with no PRD** (share of ${Math.round(total / 1000)}K Unreal lines; the tool-heavy Niagara, Landscape, World Partition, RHI and RenderCore modules are left out)
· ${open} open PRDs on this branch · ${gaps} subsystems with no PRD

[![Unreal port progress map](${SVG})](docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.html)

**Pace:** ${Math.round(rate)} PRD boxes ticked a week over the last 2 weeks. The port order runs waves 1-4 first,
so at that pace the default look is done about **${long(lookEta)}**, and everything filed today about
**${long(allEta)}**. Scope grows as PRDs are filed, so read the dates as the earliest finish.

[![Unreal port burn-up](${PROGRESS_SVG})](docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.html)

Select the map to open the interactive page in a browser. It lists the PRDs and gaps of every
feature and the order to port them in.
<!-- unreal-port-status:end -->`;
}

export function refresh(): Map<string, string> {
  const pagePath = join(ROOT, PAGE);
  const files = prdFiles(join(ROOT, "docs/PRDs")).map((f) => relative(ROOT, f));
  let page = readFileSync(pagePath, "utf8");
  const internals = Object.fromEntries(
    readdirSync(join(ROOT, INTERNALS))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => [
        f.replace(/\.json$/, ""),
        JSON.parse(readFileSync(join(ROOT, INTERNALS, f), "utf8")),
      ]),
  );
  page = page.replace(
    block(page, "internals"),
    () => `// @internals-start\nconst INTERNALS = ${JSON.stringify(internals)};\n// @internals-end`,
  );
  // Internals first: the registry reads PRD ids from them too.
  const registry = buildRegistry(page, files);
  page = page.replace(
    block(page, "prds"),
    () => `// @prds-start\nconst PRDS = ${JSON.stringify(registry)};\n// @prds-end`,
  );
  const data = evalData(page);
  const { svg, share, total } = renderSvg(data);
  let before: ISnap[] = [];
  try {
    before = JSON.parse(readFileSync(join(ROOT, HISTORY), "utf8")) as ISnap[];
  } catch {}
  const history = updateHistory(
    before,
    snapshot(registry, data.PORT, new Date().toISOString().slice(0, 10)),
  );
  const readme = readFileSync(join(ROOT, README), "utf8");
  const marker = /<!-- unreal-port-status:start[\s\S]*?<!-- unreal-port-status:end -->/;
  if (!marker.test(readme)) throw new Error(`${README}: no unreal-port-status markers`);
  return new Map([
    [PAGE, page],
    [SVG, svg],
    [HISTORY, `${JSON.stringify(history, null, 2)}\n`],
    [PROGRESS_SVG, renderProgressSvg(history)],
    [README, readme.replace(marker, () => readmeBlock(share, total, data, registry, history))],
  ]);
}

if (process.argv[1]?.endsWith("unreal-port-status.ts") === true) {
  const check = process.argv.includes("--check");
  const stale: string[] = [];
  for (const [path, text] of refresh()) {
    let now = "";
    try {
      now = readFileSync(join(ROOT, path), "utf8");
    } catch {}
    if (now === text) continue;
    stale.push(path);
    if (!check) writeFileSync(join(ROOT, path), text);
  }
  if (check && stale.length) {
    console.error(`Unreal port status is stale: ${stale.join(", ")}. Run \`pnpm unreal:status\`.`);
    process.exit(1);
  }
  console.log(
    stale.length ? `unreal:status wrote ${stale.join(", ")}` : "unreal:status: up to date",
  );
}
