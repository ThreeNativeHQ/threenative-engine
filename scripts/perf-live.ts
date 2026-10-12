// `pnpm perf:live` — leave the tab open; every bench:engines report that lands under the watched
// roots shows up within seconds. It reads the reports the benches already write (no new timing,
// no hook in the benches), validates them with the bench's own parser, and plots p50 per workload.
// ponytail: polls every 2 s and rescans the roots; add fs.watch only if the roots grow past ~10k files.
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseRunReport, summarize } from "./engine-load-test/report.js";

export interface IRow {
  arm: string;
  engine: string;
  file: string;
  mode: string;
  objects: number;
  p50: number;
  p95: number;
  p99: number;
  hitches: number;
  /** Whole-process CPU ms per frame, when the arm reports it (includes the present call). */
  cpu?: number;
  /** Main-thread CPU ms per frame without the present call (p50), when the arm reports it: the KPI metric. */
  threadCpu?: number;
  /** Host load above half the cores: absolutes are not valid, ratios between alternating arms still are. */
  invalid: boolean;
  cycle: string;
  /** Run time: the date in the file name when it has one (copied pilots share one mtime), else mtime. */
  t: number;
  /** mtime, to order runs that share a date. */
  m: number;
}

const args = process.argv.slice(2);
const flag = (name: string): string[] =>
  args.flatMap((a, i) => (a === name && args[i + 1] ? [args[i + 1] as string] : []));
const port = Number(flag("--port")[0] ?? 8765);
const roots = flag("--root").length
  ? flag("--root")
  : [path.join(process.cwd(), "artifacts", "engine-load-test", "prd-573")];
const prdFile = flag("--prd")[0];

const cache = new Map<string, { mtime: number; rows: IRow[] }>();

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(full);
    else if (e.name.endsWith(".json")) yield full;
  }
}

/** Epic progress: cycles and phases with their checkbox counts, read live from the PRD. */
export function epicOf(markdown: string) {
  const cycles: {
    id: string;
    title: string;
    phases: {
      id: string;
      title: string;
      done: number;
      total: number;
      boxes: { done: boolean; text: string }[];
    }[];
  }[] = [];
  for (const line of markdown.split("\n")) {
    const c = /^## Cycle (v\d) [—-] (.+)$/u.exec(line);
    if (c) cycles.push({ id: c[1] as string, title: c[2] as string, phases: [] });
    const p = /^#### Phase (v\d[\w.]*): (.+)$/u.exec(line);
    if (p)
      cycles
        .at(-1)
        ?.phases.push({ id: p[1] as string, title: p[2] as string, done: 0, total: 0, boxes: [] });
    const b = /^- \[([ x])\] (.+)$/u.exec(line);
    const phase = cycles.at(-1)?.phases.at(-1);
    if (b && phase) {
      const done = b[1] === "x";
      phase.total++;
      if (done) phase.done++;
      phase.boxes.push({ done, text: (b[2] as string).split(" proof:")[0]?.slice(0, 160) ?? "" });
    }
  }
  return cycles;
}

export function rowsOf(report: unknown, file: string, mtime: number): IRow[] {
  const day = /(\d{4}-\d{2}-\d{2})/u.exec(file)?.[1];
  const t = day ? Date.parse(`${day}T12:00:00Z`) : mtime;
  const r = parseRunReport(report);
  return summarize(r).map((s) => ({
    arm: r.arm,
    engine: r.engine.name,
    file,
    mode: s.mode,
    objects: s.objectCount,
    p50: s.p50,
    p95: s.p95,
    p99: s.p99,
    hitches: s.hitches,
    ...(s.cpuMsPerFrame === undefined ? {} : { cpu: s.cpuMsPerFrame }),
    ...(s.threadCpuP50 === undefined ? {} : { threadCpu: s.threadCpuP50 }),
    invalid: r.hostLoad?.absolutes === "invalid-absolute",
    cycle: /(?:^|[\/_.-])(v[1-5])(?:[\/_.-]|$)/u.exec(file)?.[1] ?? "v1",
    t,
    m: mtime,
  }));
}

export interface IPoint {
  /** The report's directory and tag, the root left out: `v111/step2`, `R2`. */
  label: string;
  mode: string;
  objects: number;
  /** Newest run in the point (the date in the file name when it has one, else mtime). */
  t: number;
  /** Newest mtime in the point, to order runs that share a date. */
  m: number;
  /** A run in the point had a loaded host: the ratios hold, the absolutes do not. */
  invalid: boolean;
  legacyRuns: number;
  nativeRuns: number;
  /** Median whole-process CPU ms per frame, per arm. */
  legacyCpu?: number;
  nativeCpu?: number;
  /** legacy ÷ native of the whole-process CPU per frame (includes the present call). */
  ratioCpu?: number;
  /** Median main-thread CPU ms per frame without the present call, per arm. */
  legacyThread?: number;
  nativeThread?: number;
  /** legacy ÷ native without the present call: the declared KPI metric. */
  ratioNoPresent?: number;
}

const LEGACY_ARM = "tn-desktop";
const NATIVE_ARM = "tn-engine-desktop";
const RUN_TAG = /^(.*?)-tn-(?:engine-)?desktop\b/u;

function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Median of one arm's values for a field, or undefined when that arm reports none. */
function armMedian(group: readonly IRow[], arm: string, field: "cpu" | "threadCpu") {
  return medianOf(
    group
      .filter((r) => r.arm === arm)
      .map((r) => r[field])
      .filter((v): v is number => v !== undefined),
  );
}

/** The point one group of runs makes; undefined when one arm alone ran, since then there is no ratio. */
function pointOf(key: string, group: readonly IRow[]): IPoint | undefined {
  const [dir, tag, mode, objects] = JSON.parse(key) as [string, string, string, number];
  const legacyCpu = armMedian(group, LEGACY_ARM, "cpu");
  const nativeCpu = armMedian(group, NATIVE_ARM, "cpu");
  const legacyThread = armMedian(group, LEGACY_ARM, "threadCpu");
  const nativeThread = armMedian(group, NATIVE_ARM, "threadCpu");
  const ratioCpu =
    legacyCpu !== undefined && nativeCpu !== undefined ? legacyCpu / nativeCpu : undefined;
  const ratioNoPresent =
    legacyThread !== undefined && nativeThread !== undefined
      ? legacyThread / nativeThread
      : undefined;
  if (ratioCpu === undefined && ratioNoPresent === undefined) return undefined;
  return {
    label: dir === "." ? tag : `${dir}/${tag}`,
    mode,
    objects,
    t: Math.max(...group.map((r) => r.t)),
    m: Math.max(...group.map((r) => r.m)),
    invalid: group.some((r) => r.invalid),
    legacyRuns: group.filter((r) => r.arm === LEGACY_ARM).length,
    nativeRuns: group.filter((r) => r.arm === NATIVE_ARM).length,
    legacyCpu,
    nativeCpu,
    ratioCpu,
    legacyThread,
    nativeThread,
    ratioNoPresent,
  };
}

/**
 * One benchmark point per directory, tag, mode and object count, each arm's median across its repeats.
 * Objects are in the key: crossing-cuts a1 and c1 carry R2@256 and R2@4096 in one file, and mode alone
 * would mix them into one median.
 */
export function pointsOf(rows: readonly IRow[]): IPoint[] {
  const groups = new Map<string, IRow[]>();
  for (const row of rows) {
    const tag = RUN_TAG.exec(path.basename(row.file))?.[1];
    if (tag === undefined) continue;
    const key = JSON.stringify([path.dirname(row.file), tag, row.mode, row.objects]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const points: IPoint[] = [];
  for (const [key, group] of groups) {
    const point = pointOf(key, group);
    if (point !== undefined) points.push(point);
  }
  return points.sort((a, b) => a.t - b.t || a.m - b.m || a.label.localeCompare(b.label));
}

async function allRows(): Promise<IRow[]> {
  const rows: IRow[] = [];
  for (const root of roots) {
    for await (const file of walk(root)) {
      const mtime = (await stat(file)).mtimeMs;
      let hit = cache.get(file);
      if (hit?.mtime !== mtime) {
        // Not every json under the roots is a run report; those parse-fail once and stay empty.
        const rows = await readFile(file, "utf8")
          .then((text) => rowsOf(JSON.parse(text), path.relative(root, file), mtime))
          .catch(() => []);
        hit = { mtime, rows };
        cache.set(file, hit);
      }
      rows.push(...hit.rows);
    }
  }
  return rows.sort((a, b) => a.t - b.t || a.m - b.m || a.file.localeCompare(b.file));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer(async (req, res) => {
    if (req.url?.startsWith("/api/epic")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(prdFile ? epicOf(await readFile(prdFile, "utf8")) : []));
    } else if (req.url?.startsWith("/api/rows")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ roots, rows: await allRows() }));
    } else if (req.url?.startsWith("/api/points")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(pointsOf(await allRows())));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(new URL("./perf-live.html", import.meta.url), "utf8"));
    }
  }).listen(port, "127.0.0.1", () =>
    process.stdout.write(`perf live: http://127.0.0.1:${port}  (watching ${roots.join(", ")})\n`),
  );
}
