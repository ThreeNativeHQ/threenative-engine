// `pnpm perf:live` — leave the tab open; every bench:engines report that lands under the watched
// roots shows up within seconds. It reads the reports the benches already write (no new timing,
// no hook in the benches), validates them with the bench's own parser, and plots p50 per workload.
// ponytail: polls every 2 s and rescans the roots; add fs.watch only if the roots grow past ~10k files.
import { readFile, readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { softwareAdapterName } from "../packages/playtest/src/runner/browser.js";
import { type IPairRow, frameRates, pairRows } from "./engine-load-test/pair.js";
import { type IRunReport, parseRunReport, summarize } from "./engine-load-test/report.js";
import { midwayState } from "./midway-bench/kpis.js";
import { shadowPerfOnce } from "./shadow-perf/dashboard.js";

export interface IRow {
  arm: string;
  engine: string;
  file: string;
  mode: string;
  objects: number;
  p50: number;
  p95: number;
  p99: number;
  fps: number;
  fpsLow1: number;
  hitches: number;
  /** Whole-process CPU ms per frame, when the arm reports it (includes the present call). */
  cpu?: number;
  /** Main-thread CPU ms per frame without the present call (p50), when the arm reports it: the KPI metric. */
  threadCpu?: number;
  /** Median ms per frame by phase (game, projection, ..., other) plus `present`, when the report carries phase arrays. */
  phases?: Record<string, number>;
  /** Host load above half the cores: absolutes are not valid, ratios between alternating arms still are. */
  invalid: boolean;
  /** The GPU adapter the run read (`vendor / architecture` on the web). */
  adapter: string;
  /** A software rasteriser drew the run: no real-GPU or visual evidence. */
  software: boolean;
  /** The measured source commit and the browser, when the run recorded its identity (`--source-sha`). */
  commit?: string;
  browser?: string;
  /** C ABI crossings per frame (p50), when the run counted them. */
  crossings?: number;
  /** A web run's startup, bytes and memory (`report.web`). */
  web?: IWebRow;
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

interface ILoadedRun {
  file: string;
  mtime: number;
  report: IRunReport;
  rows: IRow[];
}
const cache = new Map<string, ILoadedRun | { mtime: number }>();

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

export interface IWebRow {
  firstFrameMs?: number;
  wasmInstantiateMs?: number;
  jsGzipBytes?: number;
  wasmGzipBytes?: number;
  wasmMemoryBytes?: number;
  jsHeapUsedBytes?: number;
}

/** The web block's numbers the dashboard shows; a null or absent field stays absent ("missing" on the page). */
function webRowOf(web: IRunReport["web"]): IWebRow | undefined {
  if (web === undefined) return undefined;
  const out: IWebRow = {};
  const put = (key: keyof IWebRow, value: number | null | undefined) => {
    if (typeof value === "number") out[key] = value;
  };
  put("firstFrameMs", web.startup?.firstFrameMs);
  put("wasmInstantiateMs", web.startup?.wasmInstantiateMs.reduce((a, b) => a + b, 0) || undefined);
  put("jsGzipBytes", web.artifact?.jsGzipBytes);
  put("wasmGzipBytes", web.artifact?.wasmGzipBytes);
  put("wasmMemoryBytes", web.memory?.wasmMemoryBytes);
  put("jsHeapUsedBytes", web.memory?.jsHeapUsedBytes);
  return out;
}

export function rowsOf(report: unknown, file: string, mtime: number): IRow[] {
  const day = /(\d{4}-\d{2}-\d{2})/u.exec(file)?.[1];
  const t = day ? Date.parse(`${day}T12:00:00Z`) : mtime;
  const r = parseRunReport(report);
  const web = webRowOf(r.web);
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
      ...frameRates(
        r.rungs
          .filter((rung) => rung.mode === s.mode && rung.objectCount === s.objectCount)
          .flatMap((rung) => rung.frameMs),
      ),
      hitches: s.hitches,
      ...(s.cpuMsPerFrame === undefined ? {} : { cpu: s.cpuMsPerFrame }),
      ...(s.threadCpuP50 === undefined ? {} : { threadCpu: s.threadCpuP50 }),
      ...(phases === undefined ? {} : { phases }),
      invalid: r.hostLoad?.absolutes === "invalid-absolute",
      adapter: r.driver.adapter,
      software:
        softwareAdapterName({ adapter: r.driver.adapter }) !== undefined ||
        /SOFTWARE ADAPTER/u.test(r.build.notes),
      ...(r.identity?.sourceSha === undefined ? {} : { commit: r.identity.sourceSha }),
      ...(r.identity?.browser === undefined ? {} : { browser: r.identity.browser }),
      ...(s.crossingsP50 === undefined ? {} : { crossings: s.crossingsP50 }),
      ...(web === undefined ? {} : { web }),
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

/** One web arm's medians across its runs in a pair. */
export interface IWebArm {
  runs: number;
  p50?: number;
  p95?: number;
  p99?: number;
  fps?: number;
  fpsLow1?: number;
  /** Main-thread ms per frame without present (page wall time: a page has no thread CPU clock). */
  thread?: number;
  crossings?: number;
  phases?: Record<string, number>;
  web?: IWebRow;
}

/** A `--pair tn-web,tn-engine-web` point: kept apart from the desktop KPI, never mixed into it. */
export interface IWebPair {
  label: string;
  mode: string;
  objects: number;
  t: number;
  m: number;
  /** "pending" while one arm has no run in the point. */
  status: "measured" | "pending";
  invalid: boolean;
  software: boolean;
  adapters: string[];
  browsers: string[];
  commits: string[];
  legacy: IWebArm;
  native: IWebArm;
  /** tn-web ÷ tn-engine-web p50 frame time: above 1 means the engine is cheaper. */
  ratioP50?: number;
  ratioThread?: number;
}

/** An alternating A/B of one engine-web change (`<tag>-A1`, `<tag>-B2`, ...): B is the change. */
export interface IWebCut {
  label: string;
  mode: string;
  objects: number;
  t: number;
  m: number;
  aRuns: number;
  bRuns: number;
  aP50?: number;
  bP50?: number;
  /** B ÷ A median p50: below 1 means the change is cheaper. */
  ratio?: number;
  /** win: every B run below every A run; regression: every B above every A; else inconclusive or pending. */
  verdict: "win" | "regression" | "inconclusive" | "pending";
  invalid: boolean;
  software: boolean;
  adapters: string[];
}

const WEB_LEGACY = "tn-web";
const WEB_NATIVE = "tn-engine-web";
const WEB_PAIR_TAG = /^(.*?)-tn-(?:engine-)?web-r\d+\.json$/u;
const WEB_CUT_TAG = /^(.*)-([AB])\d+\.json$/u;
const uniq = (values: readonly (string | undefined)[]) =>
  [...new Set(values.filter((v): v is string => v !== undefined))].sort();

function webArmOf(group: readonly IRow[], arm: string): IWebArm {
  const runs = group.filter((r) => r.arm === arm);
  const pick = (f: (r: IRow) => number | undefined) =>
    medianOf(runs.map(f).filter((v): v is number => v !== undefined));
  const out: IWebArm = { runs: runs.length };
  const put = <K extends keyof IWebArm>(key: K, value: IWebArm[K] | undefined) => {
    if (value !== undefined) out[key] = value;
  };
  put(
    "p50",
    pick((r) => r.p50),
  );
  put(
    "p95",
    pick((r) => r.p95),
  );
  put(
    "p99",
    pick((r) => r.p99),
  );
  put(
    "thread",
    pick((r) => r.threadCpu),
  );
  put(
    "crossings",
    pick((r) => r.crossings),
  );
  put(
    "fps",
    pick((r) => r.fps),
  );
  put(
    "fpsLow1",
    pick((r) => r.fpsLow1),
  );
  put("phases", armPhases(group, arm));
  const webs = runs.flatMap((r) => (r.web ? [r.web as Record<string, number>] : []));
  if (webs.length > 0) put("web", medianByKey(webs) as IWebRow);
  return out;
}

const groupBy = (rows: readonly IRow[], tagOf: (base: string) => string | undefined) => {
  const groups = new Map<string, IRow[]>();
  for (const row of rows) {
    const tag = tagOf(path.basename(row.file));
    if (tag === undefined) continue;
    const key = JSON.stringify([path.dirname(row.file), tag, row.mode, row.objects]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups].map(([key, group]) => {
    const [dir, tag, mode, objects] = JSON.parse(key) as [string, string, string, number];
    return {
      label: dir === "." ? tag : `${dir}/${tag}`,
      mode,
      objects,
      group,
      t: Math.max(...group.map((r) => r.t)),
      m: Math.max(...group.map((r) => r.m)),
      invalid: group.some((r) => r.invalid),
      software: group.some((r) => r.software),
      adapters: uniq(group.map((r) => r.adapter)),
    };
  });
};

/** The web comparison: tn-web against tn-engine-web pairs, and the alternating A/B of each engine-web cut. */
export function webOf(rows: readonly IRow[]): {
  pairs: IWebPair[];
  cuts: IWebCut[];
  census: { label: string; mode: string; objects: number; crossings: number; t: number }[];
} {
  const web = rows.filter((r) => r.arm === WEB_LEGACY || r.arm === WEB_NATIVE);
  const order = (a: { t: number; m: number; label: string }, b: typeof a) =>
    a.t - b.t || a.m - b.m || a.label.localeCompare(b.label);
  const pairs = groupBy(web, (base) => WEB_PAIR_TAG.exec(base)?.[1]).map(
    ({ group, ...point }): IWebPair => {
      const legacy = webArmOf(group, WEB_LEGACY);
      const native = webArmOf(group, WEB_NATIVE);
      const ratio = (a?: number, b?: number) => (a !== undefined && b ? a / b : undefined);
      const ratioP50 = ratio(legacy.p50, native.p50);
      const ratioThread = ratio(legacy.thread, native.thread);
      return {
        ...point,
        status: legacy.runs > 0 && native.runs > 0 ? "measured" : "pending",
        browsers: uniq(group.map((r) => r.browser)),
        commits: uniq(group.map((r) => r.commit)),
        legacy,
        native,
        ...(ratioP50 === undefined ? {} : { ratioP50 }),
        ...(ratioThread === undefined ? {} : { ratioThread }),
      };
    },
  );
  const cuts = groupBy(
    web.filter((r) => r.arm === WEB_NATIVE),
    (base) => WEB_CUT_TAG.exec(base)?.[1],
  ).map(({ group, ...point }): IWebCut => {
    const side = (v: "A" | "B") =>
      group.filter((r) => WEB_CUT_TAG.exec(path.basename(r.file))?.[2] === v).map((r) => r.p50);
    const [a, b] = [side("A"), side("B")];
    const [aP50, bP50] = [medianOf(a), medianOf(b)];
    const verdict: IWebCut["verdict"] =
      a.length === 0 || b.length === 0
        ? "pending"
        : Math.max(...b) < Math.min(...a)
          ? "win"
          : Math.min(...b) > Math.max(...a)
            ? "regression"
            : "inconclusive";
    return {
      ...point,
      aRuns: a.length,
      bRuns: b.length,
      ...(aP50 === undefined ? {} : { aP50 }),
      ...(bP50 === undefined ? {} : { bP50 }),
      ...(aP50 === undefined || bP50 === undefined ? {} : { ratio: bP50 / aP50 }),
      verdict,
    };
  });
  // The runs that counted JS-to-Wasm crossings (TN_BENCH_CROSSINGS=1): the census perturbs timing, so it
  // runs apart from the timed pairs.
  const census = web.flatMap((r) =>
    r.arm === WEB_NATIVE && r.crossings !== undefined
      ? [
          {
            label: r.file.replace(/\.json$/u, ""),
            mode: r.mode,
            objects: r.objects,
            crossings: r.crossings,
            t: r.t,
          },
        ]
      : [],
  );
  return { pairs: pairs.sort(order), cuts: cuts.sort(order), census };
}

/** The KPI target: native costs at most half the legacy CPU per frame. */
export const TARGET = 3; // owner, 2026-10-13: aim past the v1 KPI (2x) at 3x native desktop
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

/** The lane a point was measured on: a `gpu-` set ran on the real display, everything else on Xvfb. */
const laneOf = (label: string): string => (/(^|\/)gpu-/u.test(label) ? "real GPU" : "Xvfb");

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
  const lane = laneOf(latest.label);
  const previous = series
    .slice(0, -1)
    .reverse()
    .find((p) => laneOf(p.label) === lane);
  const reason = staleReason(points, now);
  return {
    status: (reason === undefined ? valueColor(ratio) : "yellow") as Status,
    valueColor: valueColor(ratio),
    ratio,
    sentence: sentenceOf(ratio),
    label: latest.label,
    lane,
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

export async function loadRuns(rootPaths: readonly string[] = roots): Promise<ILoadedRun[]> {
  const runs: ILoadedRun[] = [];
  for (const root of rootPaths) {
    for await (const file of walk(root)) {
      const mtime = (await stat(file)).mtimeMs;
      let hit = cache.get(file);
      if (hit?.mtime !== mtime) {
        // Not every json under the roots is a run report; those parse-fail once and stay empty.
        hit = await readFile(file, "utf8")
          .then((text) => {
            const report = parseRunReport(JSON.parse(text));
            return { file, mtime, report, rows: rowsOf(report, path.relative(root, file), mtime) };
          })
          .catch(() => ({ mtime }));
        cache.set(file, hit);
      }
      if ("report" in hit) runs.push(hit);
    }
  }
  return runs;
}

/** One shared midwayState() at a time: the first call parses ~570 MB of run logs (20-45 s), and overlapping polls must not each repeat it. */
let midwayInFlight: ReturnType<typeof midwayState> | undefined;
function midwayOnce() {
  midwayInFlight ??= midwayState().finally(() => {
    midwayInFlight = undefined;
  });
  return midwayInFlight;
}

async function allRows(): Promise<IRow[]> {
  return (await loadRuns())
    .flatMap((run) => run.rows)
    .sort((a, b) => a.t - b.t || a.m - b.m || a.file.localeCompare(b.file));
}

interface IDesktopResult {
  status: "PENDING" | "measured";
  label?: string;
  pair?: IPairRow;
  rounds?: { round: number; ratio?: number }[];
  commits?: string[];
  adapters?: string[];
  problem?: string;
}

/** Confirmed desktop sets stay separate from exploratory and web runs. Ratios use the bench's parity gate. */
export function desktopOf(runs: readonly ILoadedRun[]) {
  const tagOf = (run: ILoadedRun) =>
    /^(.*)-(?:tn-(?:engine-)?desktop|godot-desktop)-r\d+\.json$/u.exec(
      path.basename(run.file),
    )?.[1];
  const latest = (prefix: string, mode: string, arm?: string): ILoadedRun[] => {
    const sets = new Map<string, ILoadedRun[]>();
    for (const run of runs) {
      const tag =
        tagOf(run) ?? (run.report.arm === "godot-desktop" ? path.basename(run.file) : undefined);
      if (
        tag === undefined ||
        !tag.startsWith(prefix) ||
        !run.report.rungs.some((r) => r.mode === mode) ||
        (arm !== undefined && run.report.arm !== arm)
      )
        continue;
      const key = path.join(path.dirname(run.file), tag);
      sets.set(key, [...(sets.get(key) ?? []), run]);
    }
    return (
      [...sets.values()]
        .sort((a, b) => Math.max(...a.map((r) => r.mtime)) - Math.max(...b.map((r) => r.mtime)))
        .at(-1) ?? []
    );
  };
  const compare = (
    group: readonly ILoadedRun[],
    mode: string,
    leftArm: string,
    rightArm: string,
  ): IDesktopResult => {
    const arm = (name: string) => group.filter((r) => r.report.arm === name);
    const [left, right] = [arm(leftArm), arm(rightArm)];
    const pending: IDesktopResult = { status: "PENDING" };
    if (!left.length || !right.length) return pending;
    const reports = (list: readonly ILoadedRun[]) =>
      list.map((r) => ({
        ...r.report,
        rungs: r.report.rungs.filter((rung) => rung.mode === mode),
      }));
    // Desktop host projection batches draws; use the bench's named waiver, keeping triangle parity.
    const waiver = process.env.TN_BENCH_WAIVE;
    process.env.TN_BENCH_WAIVE = [waiver, "drawCalls"].filter(Boolean).join(",");
    try {
      const pair = pairRows(reports(left), reports(right), [leftArm, rightArm])[0];
      if (pair === undefined) return pending;
      const rounds = left
        .filter((run) => /-r\d+\.json$/u.test(run.file))
        .map((run) => {
          const round = Number(/-r(\d+)\.json$/u.exec(run.file)?.[1]);
          const other = right.find((r) => Number(/-r(\d+)\.json$/u.exec(r.file)?.[1]) === round);
          const ratio =
            other === undefined
              ? undefined
              : pairRows(reports([run]), reports([other]), [leftArm, rightArm])[0]?.ratio.threadCpu;
          return { round, ...(ratio === undefined ? {} : { ratio }) };
        })
        .sort((a, b) => a.round - b.round);
      return {
        status: "measured",
        label: tagOf(left[0] as ILoadedRun),
        pair,
        rounds,
        commits: uniq(group.map((r) => r.report.identity?.sourceSha)),
        adapters: uniq(group.map((r) => r.report.driver.adapter)),
      };
    } catch (error) {
      return { ...pending, problem: error instanceof Error ? error.message : String(error) };
    } finally {
      if (waiver === undefined) Reflect.deleteProperty(process.env, "TN_BENCH_WAIVE");
      else process.env.TN_BENCH_WAIVE = waiver;
    }
  };
  // A real-display set (`gpu-<rung>*`, hardware adapter) outranks the Xvfb confirm set for the same rung.
  const kpi = (["R2", "R3", "R5"] as const).map((rung) => {
    const real = latest(`gpu-${rung}`, rung);
    const hardware = real.length > 0 && !real.some((r) => r.rows.some((row) => row.software));
    const result = hardware ? compare(real, rung, LEGACY_ARM, NATIVE_ARM) : undefined;
    return result?.status === "measured"
      ? { rung, lane: "real GPU", ...result }
      : {
          rung,
          lane: "Xvfb",
          ...compare(
            latest(rung === "R5" ? "v1-confirm" : `v1-confirm-${rung}`, rung),
            rung,
            LEGACY_ARM,
            NATIVE_ARM,
          ),
        };
  });
  const gpuRuns = latest("gpu-R5", "R5");
  const gpu = gpuRuns.some((r) => r.rows.some((row) => row.software))
    ? { status: "PENDING" as const, problem: "Software adapter is not real-GPU evidence." }
    : compare(gpuRuns, "R5", LEGACY_ARM, NATIVE_ARM);
  const godotRuns = latest("", "R5", "godot-desktop");
  const godot = compare(
    [...godotRuns, ...latest("v1-confirm", "R5", NATIVE_ARM)],
    "R5",
    "godot-desktop",
    NATIVE_ARM,
  );
  return { kpi, gpu, godot };
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
    } else if (req.url?.startsWith("/api/desktop")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(desktopOf(await loadRuns())));
    } else if (req.url?.startsWith("/api/web")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(webOf(await allRows())));
    } else if (req.url?.startsWith("/api/midway")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(await midwayOnce()));
    } else if (req.url?.startsWith("/midway")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(new URL("./midway-bench/dashboard.html", import.meta.url), "utf8"));
    } else if (req.url?.startsWith("/api/shadows")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(await shadowPerfOnce()));
    } else if (req.url?.startsWith("/shadows")) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(new URL("./shadow-perf/dashboard.html", import.meta.url), "utf8"));
    } else if (req.url?.startsWith("/api/points")) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(pointsOf(await allRows())));
    } else {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(await readFile(new URL("./perf-live.html", import.meta.url), "utf8"));
    }
  }).listen(port, "127.0.0.1", () => {
    process.stdout.write(`perf live: http://127.0.0.1:${port}  (watching ${roots.join(", ")})\n`);
    void midwayOnce().catch(() => undefined); // warm the per-run parse cache before the first page load
  });
}
