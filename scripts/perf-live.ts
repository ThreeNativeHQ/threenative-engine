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
  /** Median ms per frame by phase (game, projection, ..., other) plus `present`, when the report carries phase arrays. */
  phases?: Record<string, number>;
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

/** Per-key median across records; a key missing from a record is skipped, not zeroed. */
function medianByKey(records: readonly Record<string, number>[]): Record<string, number> {
  const keys = new Set(records.flatMap((r) => Object.keys(r)));
  return Object.fromEntries(
    [...keys].map((k) => [
      k,
      medianOf(records.flatMap((r) => (r[k] === undefined ? [] : [r[k] as number]))) as number,
    ]),
  );
}

export function rowsOf(report: unknown, file: string, mtime: number): IRow[] {
  const day = /(\d{4}-\d{2}-\d{2})/u.exec(file)?.[1];
  const t = day ? Date.parse(`${day}T12:00:00Z`) : mtime;
  const r = parseRunReport(report);
  return summarize(r).map((s) => {
    // The bench parser already pools per-frame phase arrays into p50s (render includes the host draw).
    const phases = s.phases
      ? Object.fromEntries(Object.entries(s.phases).map(([k, v]) => [k, v.p50]))
      : undefined;
    return {
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
      ...(phases === undefined ? {} : { phases }),
      invalid: r.hostLoad?.absolutes === "invalid-absolute",
      cycle: /(?:^|[\/_.-])(v[1-5])(?:[\/_.-]|$)/u.exec(file)?.[1] ?? "v1",
      t,
      m: mtime,
    };
  });
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
  /** Median ms per frame by phase, per arm, when the runs carry phase arrays. */
  legacyPhases?: Record<string, number>;
  nativePhases?: Record<string, number>;
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

/** Per-phase median across one arm's runs that carry phases. */
function armPhases(group: readonly IRow[], arm: string): Record<string, number> | undefined {
  const withPhases = group.flatMap((r) => (r.arm === arm && r.phases ? [r.phases] : []));
  return withPhases.length === 0 ? undefined : medianByKey(withPhases);
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
  const legacyPhases = armPhases(group, LEGACY_ARM);
  const nativePhases = armPhases(group, NATIVE_ARM);
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
    ...(legacyPhases === undefined ? {} : { legacyPhases }),
    ...(nativePhases === undefined ? {} : { nativePhases }),
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

/** The KPI target: native costs at most half the legacy CPU per frame. */
export const TARGET = 2;
/** The hero turns yellow when the newest R5 KPI point is older than this. */
export const STALE_MS = 6 * 3_600_000;
/** An R2/R3 point counts as "newer" only when it lands more than this after R5 (one measuring session). */
export const SAME_SESSION_MS = 15 * 60_000;
/** Moves inside this fraction of the previous KPI are noise: shown as flat. */
export const FLAT_BAND = 0.1;

export type Status = "green" | "orange" | "red" | "yellow" | "none";

/** Colour of a KPI value: green meets the target, orange beats legacy but misses it, red is slower than legacy. */
export const valueColor = (ratio: number): Exclude<Status, "yellow" | "none"> =>
  ratio >= TARGET ? "green" : ratio >= 1 ? "orange" : "red";

/** Change against the previous KPI point; inside the noise band it is flat. */
export function deltaOf(previous: number, current: number) {
  const pct = (current - previous) / previous;
  const dir: "up" | "down" | "flat" =
    Math.abs(pct) <= FLAT_BAND + 1e-9 ? "flat" : pct > 0 ? "up" : "down";
  return { dir, pct };
}

/** Why the R5 number may be out of date, or undefined when it is current. */
export function staleReason(points: readonly IPoint[], now: number): string | undefined {
  const r5 = r5Points(points).at(-1);
  if (r5 === undefined) return undefined;
  const hours = (now - r5.t) / 3_600_000;
  if (now - r5.t > STALE_MS) return `The newest R5 measurement is ${Math.floor(hours)} h old.`;
  const newer = points.find(
    (p) =>
      (p.mode === "R2" || p.mode === "R3") &&
      p.objects === 4096 &&
      p.ratioNoPresent !== undefined &&
      p.t > r5.t + SAME_SESSION_MS,
  );
  return newer === undefined
    ? undefined
    : `${newer.label} (${newer.mode}) was measured after the newest R5 point. Re-measure R5.`;
}

/** R5 @ 4096 objects with a KPI value, in time order: the headline series. */
const r5Points = (points: readonly IPoint[]) =>
  points.filter((p) => p.mode === "R5" && p.objects === 4096 && p.ratioNoPresent !== undefined);

/** The plain sentence for a KPI value. Below 1 it says "costs", so nobody reads 0.8 as good news. */
export function sentenceOf(ratio: number): string {
  return ratio >= 1
    ? `Native is ${ratio.toFixed(2)}× cheaper than legacy on R5. Target ${TARGET}×.`
    : `Native costs ${(1 / ratio).toFixed(2)}× legacy on R5. Target: ${TARGET}× cheaper.`;
}

/** The phase where native spends the most extra ms against legacy; undefined when it is never slower. */
export function phaseGapOf(legacy: Record<string, number>, native: Record<string, number>) {
  let best: { phase: string; native: number; legacy: number } | undefined;
  for (const [phase, ms] of Object.entries(native)) {
    if (phase === "present") continue;
    const other = legacy[phase] ?? 0;
    if (ms - other > (best ? best.native - best.legacy : 0))
      best = { phase, native: ms, legacy: other };
  }
  return best;
}

/** Everything the hero needs, decided here so the page only draws it. */
export function heroOf(points: readonly IPoint[], now: number) {
  const series = r5Points(points);
  const latest = series.at(-1);
  const withPhases = [...points]
    .reverse()
    .find((p) => p.mode === "R5" && p.objects === 4096 && p.legacyPhases && p.nativePhases);
  const phases =
    withPhases?.legacyPhases && withPhases.nativePhases
      ? {
          label: withPhases.label,
          t: withPhases.t,
          legacy: withPhases.legacyPhases,
          native: withPhases.nativePhases,
          gap: phaseGapOf(withPhases.legacyPhases, withPhases.nativePhases),
        }
      : undefined;
  if (latest?.ratioNoPresent === undefined)
    return {
      status: "none" as Status,
      sentence: "No R5 measurement with both arms yet.",
      now,
      ...(phases ? { phases } : {}),
    };
  const ratio = latest.ratioNoPresent;
  const previous = series.at(-2);
  const reason = staleReason(points, now);
  return {
    status: (reason === undefined ? valueColor(ratio) : "yellow") as Status,
    valueColor: valueColor(ratio),
    ratio,
    sentence: sentenceOf(ratio),
    label: latest.label,
    t: latest.t,
    now,
    invalid: latest.invalid,
    ...(reason === undefined ? {} : { reason }),
    ...(previous?.ratioNoPresent === undefined
      ? {}
      : {
          delta: {
            ...deltaOf(previous.ratioNoPresent, ratio),
            from: previous.ratioNoPresent,
            label: previous.label,
          },
        }),
    ...(phases ? { phases } : {}),
  };
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
    } else if (req.url?.startsWith("/api/hero")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(heroOf(pointsOf(await allRows()), Date.now())));
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
