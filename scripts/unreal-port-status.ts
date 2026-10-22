/**
 * Refreshes the Unreal port status from the PRD files, so the feature map never drifts from them.
 *
 * 1. Writes every PRD the feature map names (title, path, ticked and total boxes) into the page's
 *    `// @prds-start` block.
 * 2. Evaluates the page's `// @data-start` block and draws the progress map as a static SVG.
 * 3. Rewrites the status block of the root README between the `unreal-port-status` markers.
 *
 * Output depends on the working tree only, so `--check` gives the same answer locally and in CI.
 *
 * Usage: `pnpm unreal:status` (write) · `pnpm unreal:status --check` (exit 1 when stale)
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { runInNewContext } from "node:vm";

const ROOT = join(import.meta.dirname, "..");
const PAGE = "docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.html";
const SVG = "docs/PRDs/Unreal/research/unreal-port-status.svg";
const README = "README.md";

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
  readonly PORT: { done: number; total: number }[];
  readonly prog: (r: Sub) => IProg;
}

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

function readmeBlock(
  share: Record<string, number>,
  total: number,
  data: IPageData,
  registry: Record<string, IPrdEntry>,
): string {
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

Select the map to open the interactive page in a browser. It lists the PRDs and gaps of every
feature and the order to port them in.
<!-- unreal-port-status:end -->`;
}

export function refresh(): Map<string, string> {
  const pagePath = join(ROOT, PAGE);
  const files = prdFiles(join(ROOT, "docs/PRDs")).map((f) => relative(ROOT, f));
  let page = readFileSync(pagePath, "utf8");
  const registry = buildRegistry(page, files);
  page = page.replace(
    block(page, "prds"),
    () => `// @prds-start\nconst PRDS = ${JSON.stringify(registry)};\n// @prds-end`,
  );
  const code = block(page, "data").exec(page)?.[0];
  if (!code) throw new Error(`${PAGE}: no // @data-start … // @data-end block`);
  const data = runInNewContext(`${code}\n({ SYS, F, AREA_OF, PORT, prog })`) as IPageData;
  const { svg, share, total } = renderSvg(data);
  const readme = readFileSync(join(ROOT, README), "utf8");
  const marker = /<!-- unreal-port-status:start[\s\S]*?<!-- unreal-port-status:end -->/;
  if (!marker.test(readme)) throw new Error(`${README}: no unreal-port-status markers`);
  return new Map([
    [PAGE, page],
    [SVG, svg],
    [README, readme.replace(marker, () => readmeBlock(share, total, data, registry))],
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
