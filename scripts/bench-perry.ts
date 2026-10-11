// PRD-581: compare one authored scenario on the shared native player; present is never a gate.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { formatCallers, formatTop, loadProfile, runtimePatterns } from "./perry-profile.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const metrics = {
  firstFrameMs: 1,
  gameJsMs: 0.5,
  renderMs: null,
  cpuFrameMs: 0.68,
  readyMs: 0.33,
} as const;
type Metric = keyof typeof metrics;
type Arm = "perry" | "v8";
export interface IBenchArgs {
  project: string;
  scenario: string;
  perry: string;
  v8Bundle: string;
  runs: number;
  perf: boolean;
  open: boolean;
  incumbent?: string;
  maxLoad: number;
  maxCpuPressure: number;
}
export interface IMeasurement {
  firstFrameMs: number;
  gameJsMs: number;
  renderMs: number;
  cpuFrameMs: number;
  readyMs: number;
  bridgeCalls: number;
  samples: number;
}
interface ICommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
type Command = (command: string, args: string[], cwd: string) => Promise<ICommandResult>;
const exec = promisify(execFile);
// Both arms read the template assets in place: a bare template has no `assets/` of its own.
const assetRoot = path.join(root, "packages/create-threenative/template-assets");
const command: Command = async (file, args, cwd) => {
  try {
    const running = exec(file, args, {
      cwd,
      env: {
        ...process.env,
        TN_PLAYTEST_HOST_DISPLAY: "1",
        SDL_VIDEODRIVER: "x11",
        WAYLAND_DISPLAY: "",
        TN_ASSET_ROOT: assetRoot,
      },
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    running.child.stdin?.end();
    const output = await running;
    return { code: 0, ...output };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    if (failure.killed || typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

const DEFAULT_MAX_LOAD = 0.75;
const DEFAULT_MAX_CPU_PRESSURE = 10;
const LOAD_WAIT_MS = 300_000;
const LOAD_POLL_MS = 15_000;
export interface IHostLoad {
  load1: number;
  cores: number;
  cpuPressure?: number | null;
  cpuPressureSource?: string;
}
/** Injectable so the spec can fake an overloaded host and skip the waits. */
export interface IHost {
  load: () => IHostLoad | Promise<IHostLoad>;
  sleep: (ms: number) => Promise<void>;
}
export async function readHostLoad(
  readText: (file: string) => Promise<string> = (file) => readFile(file, "utf8"),
): Promise<IHostLoad> {
  const files = ["/proc/pressure/cpu"];
  try {
    const cgroup = /^0::(\/.*)$/m.exec(await readText("/proc/self/cgroup"))?.[1];
    if (cgroup) files.unshift(path.join("/sys/fs/cgroup", cgroup, "cpu.pressure"));
  } catch {
    // A missing unified cgroup falls back to system PSI.
  }
  const reading = { load1: loadavg()[0] ?? 0, cores: availableParallelism(), cpuPressure: null };
  for (const file of files) {
    try {
      const match = /^some[ \t]+[^\r\n]*\bavg10=(\d+(?:\.\d+)?)(?:\s|$)/m.exec(
        await readText(file),
      );
      const pressure = match ? Number(match[1]) : Number.NaN;
      if (Number.isFinite(pressure) && pressure >= 0 && pressure <= 100)
        return { ...reading, cpuPressure: pressure, cpuPressureSource: file };
    } catch {
      // PSI can be unavailable or unreadable; keep the load fallback.
    }
  }
  return reading;
}
const realHost: IHost = {
  load: readHostLoad,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
const overloaded = (reading: IHostLoad, args: IBenchArgs) =>
  reading.cpuPressure != null
    ? reading.cpuPressure > args.maxCpuPressure
    : reading.load1 > args.maxLoad * reading.cores;
const overloadError = (reading: IHostLoad) =>
  new Error(
    reading.cpuPressure != null
      ? `host overloaded: CPU pressure ${reading.cpuPressure.toFixed(2)}% (${reading.cpuPressureSource}); load ${reading.load1.toFixed(2)} on ${reading.cores} cores`
      : `host overloaded: load ${reading.load1.toFixed(2)} on ${reading.cores} cores`,
  );

export function parseBenchArgs(argv: readonly string[]): IBenchArgs {
  const values = new Map<string, string>();
  let perf = false;
  let open = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") continue;
    if (flag === "--perf") {
      perf = true;
      continue;
    }
    if (flag === "--open") {
      open = true;
      continue;
    }
    if (
      !flag ||
      ![
        "--project",
        "--scenario",
        "--perry",
        "--v8-bundle",
        "--runs",
        "--incumbent",
        "--max-load",
        "--max-cpu-pressure",
      ].includes(flag)
    )
      throw new Error(`Unknown argument: ${flag}`);
    const value = argv[++i];
    if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`Invalid ${flag}`);
    values.set(flag, value);
  }
  const project = path.resolve(
    values.get("--project") ?? path.join(root, "packages/create-threenative/templates/minimal"),
  );
  const perry = values.get("--perry");
  const runs = Number(values.get("--runs") ?? 3);
  if (!perry) throw new Error("--perry <prebuilt game binary> is required");
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("--runs must be a positive integer");
  const maxLoad = Number(values.get("--max-load") ?? DEFAULT_MAX_LOAD);
  if (!Number.isFinite(maxLoad) || maxLoad <= 0) throw new Error("--max-load must be a number > 0");
  const maxCpuPressure = Number(values.get("--max-cpu-pressure") ?? DEFAULT_MAX_CPU_PRESSURE);
  if (!Number.isFinite(maxCpuPressure) || maxCpuPressure < 0 || maxCpuPressure > 100)
    throw new Error("--max-cpu-pressure must be a percentage from 0 to 100");
  return {
    project,
    perry: path.resolve(perry),
    runs,
    perf,
    open,
    maxLoad,
    maxCpuPressure,
    incumbent: values.has("--incumbent")
      ? path.resolve(values.get("--incumbent") ?? "")
      : undefined,
    scenario: path.resolve(project, values.get("--scenario") ?? "playtests/play.playtest.json"),
    v8Bundle: path.resolve(
      values.get("--v8-bundle") ??
        path.join(root, `artifacts/perf-loop/v8-${path.basename(project)}`),
    ),
  };
}

function positive(value: unknown, name: string, allowZero = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || (allowZero ? value < 0 : value <= 0))
    throw new Error(`Missing or invalid metric: ${name}`);
  return value;
}
export function median(values: number[]): number {
  if (values.length === 0) throw new Error("Zero samples");
  const sorted = [...values].sort((a, b) => a - b);
  return (
    ((sorted[Math.floor((sorted.length - 1) / 2)] ?? 0) +
      (sorted[Math.floor(sorted.length / 2)] ?? 0)) /
    2
  );
}

export function parsePlayerMetrics(text: string): IMeasurement {
  const markers = (name: string): Array<Record<string, unknown>> =>
    text.split(/\r?\n/).flatMap((line) => {
      const index = line.indexOf(`${name}:`);
      return index < 0
        ? []
        : [JSON.parse(line.slice(index + name.length + 1)) as Record<string, unknown>];
    });
  const timing = markers("TN_PLAYER_TIMING");
  if (timing.length !== 1) throw new Error("Missing or duplicate TN_PLAYER_TIMING");
  const frames = markers("TN_PLAYER_FRAME");
  // The first rendered frame includes pipeline compilation; keep its own metric, discard it from p50.
  if (frames.length < 2) throw new Error("Zero steady frame samples");
  for (const frame of frames) {
    for (const key of ["gameJsMs", "renderMs", "cpuFrameMs", "frameMs"]) positive(frame[key], key);
    const calls = positive(frame.bridgeCalls, "bridgeCalls", true);
    if (!Number.isSafeInteger(calls)) throw new Error("Invalid bridgeCalls");
    if (
      Number(frame.cpuFrameMs) < Number(frame.gameJsMs) + Number(frame.renderMs) - 0.001 ||
      Number(frame.frameMs) < Number(frame.cpuFrameMs)
    )
      throw new Error("Inconsistent CPU timing split");
  }
  const steady = frames.slice(1);
  return {
    firstFrameMs: positive(timing[0]?.firstFrameMs, "firstFrameMs"),
    readyMs: positive(timing[0]?.readyMs, "readyMs"),
    gameJsMs: median(steady.map((frame) => Number(frame.gameJsMs))),
    renderMs: median(steady.map((frame) => Number(frame.renderMs))),
    cpuFrameMs: median(steady.map((frame) => Number(frame.cpuFrameMs))),
    bridgeCalls: median(steady.map((frame) => Number(frame.bridgeCalls))),
    samples: steady.length,
  };
}

export function compareArms(arms: Record<Arm, IMeasurement[]>) {
  if (arms.perry.length === 0 || arms.perry.length !== arms.v8.length)
    throw new Error("Missing arm runs");
  const rows = (Object.keys(metrics) as Metric[]).map((metric) => {
    const summarize = (arm: Arm) => {
      const values = arms[arm].map((run) => {
        positive(run.samples, "samples");
        return positive(run[metric], metric);
      });
      return { median: median(values), min: Math.min(...values), max: Math.max(...values) };
    };
    const perry = summarize("perry");
    const v8 = summarize("v8");
    const ratio = perry.median / v8.median;
    const target = metrics[metric];
    const verdict =
      ratio > 1 || (target !== null && ratio > target)
        ? "MISS"
        : target === null
          ? "REPORT"
          : "PASS";
    return { metric, perry, v8, ratio, target, verdict };
  });
  return {
    rows,
    verdict: rows.some((row) => row.verdict === "MISS") ? "MISS" : "PASS",
    exitCode: rows.some((row) => row.verdict === "MISS") ? 1 : 0,
  };
}

export interface IRegressionRow {
  metric: string;
  incumbent: number;
  candidate: number;
  margin: number;
  verdict: "IMPROVED" | "SAME" | "REGRESSED";
}
export interface IRegression {
  incumbent: string;
  verdict: "REGRESSION" | "OK";
  rows: IRegressionRow[];
}
export interface IIncumbent {
  dir: string;
  ratios: Record<string, number>;
  arms?: Partial<Record<Arm, IMeasurement[]>>;
}

/** Fail closed: the accepted run must have a readable result.json with a ratio for every metric. */
export async function loadIncumbent(dir: string): Promise<IIncumbent> {
  const file = path.join(dir, "result.json");
  let parsed: {
    comparison?: { rows?: Array<{ metric?: string; ratio?: number }> };
    arms?: IIncumbent["arms"];
  };
  try {
    parsed = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read incumbent ${file}: ${(error as Error).message}`);
  }
  const ratios: Record<string, number> = {};
  for (const row of parsed.comparison?.rows ?? []) {
    if (row.metric && typeof row.ratio === "number" && Number.isFinite(row.ratio) && row.ratio > 0)
      ratios[row.metric] = row.ratio;
  }
  for (const metric of Object.keys(metrics))
    if (ratios[metric] === undefined) throw new Error(`Incumbent ${file} has no ${metric} ratio`);
  return { dir, ratios, arms: parsed.arms };
}

/**
 * Regression = candidate ratio > incumbent ratio * (1 + margin); margin = max(3%, 2x the largest
 * relative deviation of the incumbent's per-run Perry/V8 ratios from their median; 3% for one run),
 * capped at 10% so one cold-cache outlier run cannot widen it past a real regression.
 */
export function compareToIncumbent(
  candidate: ReturnType<typeof compareArms>,
  incumbent: IIncumbent,
): IRegression {
  const rows = candidate.rows.map((row): IRegressionRow => {
    const before = incumbent.ratios[row.metric] ?? Number.NaN;
    const perry = incumbent.arms?.perry ?? [];
    const v8 = incumbent.arms?.v8 ?? [];
    const runs = perry.length === v8.length ? perry.length : 0;
    const perRun = Array.from(
      { length: runs },
      (_, i) => Number(perry[i]?.[row.metric as Metric]) / Number(v8[i]?.[row.metric as Metric]),
    ).filter((ratio) => Number.isFinite(ratio) && ratio > 0);
    const center = perRun.length > 1 ? median(perRun) : 0;
    const spread = perRun.length > 1 ? Math.max(...perRun.map((r) => Math.abs(r / center - 1))) : 0;
    const margin = Math.min(0.1, Math.max(0.03, 2 * spread));
    const verdict =
      row.ratio > before * (1 + margin)
        ? "REGRESSED"
        : row.ratio < before * (1 - margin)
          ? "IMPROVED"
          : "SAME";
    return { metric: row.metric, incumbent: before, candidate: row.ratio, margin, verdict };
  });
  return {
    incumbent: incumbent.dir,
    verdict: rows.some((row) => row.verdict === "REGRESSED") ? "REGRESSION" : "OK",
    rows,
  };
}

export function ledgerLine(
  time: string,
  head: string,
  hash: string,
  comparison?: ReturnType<typeof compareArms>,
  verdict?: string,
): string {
  return `${[
    time,
    head,
    hash.slice(0, 12),
    ...(Object.keys(metrics) as Metric[]).map(
      (metric) => comparison?.rows.find((row) => row.metric === metric)?.ratio.toFixed(6) ?? "NA",
    ),
    verdict ?? comparison?.verdict ?? "MEASUREMENT_FAILURE",
  ].join("\t")}\n`;
}

export function parsePerfSelf(text: string): Array<{ symbol: string; percent: number }> {
  const totals = new Map<string, number>();
  for (const line of text.split("\n")) {
    // perf report --no-children -s symbol: Self%, symbol (the leaf, not inclusive call stacks).
    const match = /^\s*([\d.]+)%\s+(?:\[[^\]]+\]\s+)?(.+?)(?:\s+-)*\s*$/.exec(line);
    if (!match) continue;
    const percent = positive(Number(match[1]), "perf self percent", true);
    const symbol = match[2] ?? "";
    totals.set(symbol, (totals.get(symbol) ?? 0) + percent);
  }
  if (totals.size === 0) throw new Error("No perf self-time symbols");
  return [...totals]
    .map(([symbol, percent]) => ({ symbol, percent }))
    .sort((a, b) => b.percent - a.percent)
    .slice(0, 15);
}

export function reportMarkdown(result: {
  time: string;
  load: number[];
  hostLoad?: { start?: IHostLoad; end?: IHostLoad };
  comparison?: ReturnType<typeof compareArms>;
  error?: string;
  arms?: Record<Arm, IMeasurement[]>;
  stacks?: Partial<Record<Arm, ReturnType<typeof parsePerfSelf>>>;
  regression?: IRegression;
}): string {
  const lines = [
    `# Perry vs V8 — ${result.time}`,
    `Host load (1/5/15 min): ${result.load.join(" / ")}`,
    ...(["start", "end"] as const).flatMap((phase) => {
      const reading = result.hostLoad?.[phase];
      return reading
        ? [
            `Host ${phase}: CPU pressure some avg10: ${reading.cpuPressure != null ? `${reading.cpuPressure.toFixed(2)}% (${reading.cpuPressureSource})` : "unavailable (load fallback)"}; load ${reading.load1.toFixed(2)} on ${reading.cores} cores.`,
          ]
        : [];
    }),
    "CPU excludes acquisition/present; first frame includes it. Steady p50 discards the first rendered frame.",
    "Ratios use the median of each run's p50; ranges are across runs. Slower Perry is always MISS.",
    "",
    "| metric (ms) | Perry median [min–max] | V8 median [min–max] | ratio | target | verdict |",
    "|---|---:|---:|---:|---:|---|",
  ];
  for (const row of result.comparison?.rows ?? []) {
    const cell = (arm: typeof row.perry) =>
      `${arm.median.toFixed(3)} [${arm.min.toFixed(3)}–${arm.max.toFixed(3)}]`;
    lines.push(
      `| ${row.metric} | ${cell(row.perry)} | ${cell(row.v8)} | ${row.ratio.toFixed(3)} | ${row.target ?? "report only"} | ${row.verdict} |`,
    );
  }
  lines.push("", `Verdict: ${result.error ? "MEASUREMENT_FAILURE" : result.comparison?.verdict}`);
  if (result.regression)
    lines.push(
      `Regression vs incumbent ${result.regression.incumbent}: ${result.regression.verdict}${result.regression.verdict === "REGRESSION" ? " (do not commit)" : ""}. ${result.regression.rows.map((row) => `${row.metric} ${row.verdict}`).join(", ")}.`,
    );
  if (result.arms?.perry.length && result.arms.v8.length) {
    const calls = (arm: Arm) => {
      const values = result.arms?.[arm].map((run) => run.bridgeCalls) ?? [];
      return `${median(values)} [${Math.min(...values)}–${Math.max(...values)}]`;
    };
    lines.push(
      `Bridge calls/frame p50 [min–max across runs]: Perry ${calls("perry")}; V8 ${calls("v8")}.`,
    );
  }
  lines.push(
    "Ready = first published scene/camera before drawing; launch clock is wall time immediately before exec.",
  );
  if (result.error) lines.push(`Error: ${result.error.replaceAll("\n", " ")}`);
  if (result.stacks) {
    lines.push("", "| top self-time | Perry | V8 |", "|---:|---|---|");
    for (let i = 0; i < 15; i++) {
      const cell = (arm: Arm) => {
        const entry = result.stacks?.[arm]?.[i];
        return entry ? `${entry.percent.toFixed(2)}% ${entry.symbol.replaceAll("|", "\\|")}` : "—";
      };
      lines.push(`| ${i + 1} | ${cell("perry")} | ${cell("v8")} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export interface ILedgerRow {
  time: string;
  /** First 12 hex of the Perry binary's SHA-256; "vs last" across two binaries is not a code delta. */
  binary?: string;
  ratios: Array<number | null>;
  verdict: string;
}

/** Parse the append-only ledger; a short row is a corruption, not a missing value. */
export function parseLedger(text: string): ILedgerRow[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const columns = line.split("\t");
      if (columns.length !== 9) throw new Error("Malformed ledger row");
      return {
        time: columns[0] ?? "",
        binary: columns[2] ?? "",
        ratios: columns.slice(3, 8).map((value) => (value === "NA" ? null : Number(value))),
        verdict: columns[8] ?? "",
      };
    });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

type ComparisonRow = ReturnType<typeof compareArms>["rows"][number];
type Trend = "improving" | "regressed" | "flat";

const CDN = "https://cdn.tailwindcss.com/3.4.17";
const LABEL: Record<Metric, string> = {
  firstFrameMs: "First frame",
  gameJsMs: "Game JS p50",
  renderMs: "Render p50",
  cpuFrameMs: "CPU frame p50",
  readyMs: "Launch to ready",
};
const TREND_EPSILON = 0.02;
// 1-2-5 axis ticks from 0.001x to 5000x; the log axes snap their ends to these.
const TICKS = Array.from({ length: 8 }, (_, e) =>
  [1, 2, 5].map((s) => Number((s * 10 ** (e - 3)).toPrecision(3))),
).flat();
const TONE = {
  pass: {
    hex: "#34d399",
    text: "text-emerald-300",
    box: "border-emerald-500/40 bg-emerald-500/10",
  },
  improving: { hex: "#fbbf24", text: "text-amber-300", box: "border-amber-500/40 bg-amber-500/10" },
  miss: { hex: "#f87171", text: "text-red-300", box: "border-red-500/40 bg-red-500/10" },
  report: { hex: "#38bdf8", text: "text-sky-300", box: "border-sky-500/40 bg-sky-500/10" },
};
const TREND_CHIP: Record<Trend, string> = {
  improving: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30",
  regressed: "bg-red-500/15 text-red-300 ring-red-500/30",
  flat: "bg-slate-500/15 text-slate-300 ring-slate-500/30",
};
const ARROW: Record<Trend, string> = {
  improving: "&#9660;",
  regressed: "&#9650;",
  flat: "&#9644;",
};

const trendOf = (now: number, before: number): Trend => {
  const change = now / before - 1;
  return change < -TREND_EPSILON ? "improving" : change > TREND_EPSILON ? "regressed" : "flat";
};
const pct = (now: number, before: number): string => {
  const change = Math.round((now / before - 1) * 100);
  return `${change > 0 ? "+" : ""}${change}%`;
};
const fmtX = (value: number): string => `${value.toFixed(value >= 10 ? 1 : 2)}x`;
const fmtMs = (value: number): string => value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 3);
const shortTime = (time: string): string => time.slice(5, 16).replace("T", " ");

/** A log axis whose ends snap to 1-2-5 ticks; `pos` maps a ratio to 0..1. */
function logDomain(values: number[]) {
  const lo = TICKS.filter((tick) => tick <= Math.min(...values) * 0.9).at(-1) ?? TICKS[0] ?? 0.001;
  const hi = TICKS.find((tick) => tick >= Math.max(...values) * 1.1) ?? Math.max(...values);
  const span = Math.log(hi / lo);
  return {
    ticks: TICKS.filter((tick) => tick >= lo && tick <= hi),
    pos: (value: number) => Math.min(1, Math.max(0, Math.log(value / lo) / span)),
  };
}

/** Log-scale ruler: green up to the target, amber up to V8 parity, red past it. */
function gaugeHtml(
  row: ComparisonRow,
  previous: number | undefined,
  domain: ReturnType<typeof logDomain>,
  hex: string,
): string {
  const at = (value: number) => `${(domain.pos(value) * 100).toFixed(2)}%`;
  const goal = row.target ?? 1;
  const tick = (value: number, label: string, color: string, above: boolean) =>
    `<div class="absolute -top-1 -bottom-1 w-0.5 ${color}" style="left:${at(value)}"></div><span class="absolute ${above ? "-top-5" : "top-5"} -translate-x-1/2 whitespace-nowrap text-[10px] ${color.replace("bg-", "text-")}" style="left:${at(value)}">${label}</span>`;
  return [
    '<div class="relative mx-3 mb-7 mt-7 h-3">',
    '<div class="absolute inset-0 overflow-hidden rounded-full bg-slate-800">',
    `<div class="absolute inset-y-0 left-0 bg-emerald-500/30" style="width:${at(goal)}"></div>`,
    `<div class="absolute inset-y-0 bg-amber-500/25" style="left:${at(goal)};width:${(Math.max(0, domain.pos(1) - domain.pos(goal)) * 100).toFixed(2)}%"></div>`,
    `<div class="absolute inset-y-0 right-0 bg-red-500/25" style="left:${at(1)}"></div>`,
    "</div>",
    row.target !== null && row.target !== 1
      ? tick(row.target, `target ${row.target}x`, "bg-emerald-300", true)
      : "",
    tick(1, row.target === 1 ? "target = V8 parity" : "V8 parity", "bg-amber-300", false),
    previous === undefined
      ? ""
      : `<div title="previous run ${fmtX(previous)}" class="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-300 bg-slate-950" style="left:${at(previous)}"></div>`,
    `<div title="this run ${fmtX(row.ratio)}" class="absolute top-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-lg" style="left:${at(row.ratio)};background:${hex}"></div>`,
    "</div>",
  ].join("");
}

/** One metric's Perry/V8 ratio over the ledger: log axis, target and parity lines, pass/miss points. */
function historySvg(
  series: readonly ILedgerRow[],
  metricIndex: number,
  target: number | null,
  metric: string,
  currentIndex: number,
): string {
  const [W, H, L, R, T, B] = [480, 230, 40, 84, 14, 28] as const;
  const goal = target ?? 1;
  const valid = series.flatMap((row, index) => {
    const ratio = row.ratios[metricIndex];
    return ratio === null || ratio === undefined ? [] : [{ index, ratio, time: row.time }];
  });
  const failed = series.flatMap((row, index) => (row.ratios[metricIndex] == null ? [index] : []));
  const domain = logDomain([...valid.map((point) => point.ratio), goal, 1]);
  const x = (index: number) =>
    (
      L + (series.length < 2 ? (W - L - R) / 2 : (index / (series.length - 1)) * (W - L - R))
    ).toFixed(1);
  const y = (value: number) => (T + (1 - domain.pos(value)) * (H - T - B)).toFixed(1);
  const label = `${metric} Perry/V8 ratio over time, log scale`;
  const hline = (value: number, color: string, text: string, textY: number) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(value)}" y2="${y(value)}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4"></line><text x="${W - R + 6}" y="${textY.toFixed(1)}" fill="${color}" font-size="11" font-weight="600">${text}</text>`;
  const parityY = Math.min(Number(y(1)), Number(y(goal)) - 13);
  return [
    `<svg viewBox="0 0 ${W} ${H}" class="w-full" role="img" aria-label="${escapeHtml(label)}"><title>${escapeHtml(label)}</title>`,
    ...domain.ticks.map(
      (tick) =>
        `<line x1="${L}" x2="${W - R}" y1="${y(tick)}" y2="${y(tick)}" stroke="#1e293b"></line><text x="${L - 6}" y="${Number(y(tick)) + 3.5}" text-anchor="end" fill="#64748b" font-size="10">${tick}x</text>`,
    ),
    `<rect x="${L}" y="${y(goal)}" width="${W - L - R}" height="${(H - B - Number(y(goal))).toFixed(1)}" fill="#34d399" opacity=".09"></rect>`,
    goal === 1
      ? ""
      : hline(1, "#fbbf24", target === null ? "V8 parity" : "V8 parity 1x", parityY + 4),
    hline(
      goal,
      "#34d399",
      target === null ? "report-only 1x" : target === 1 ? "target 1x" : `target ${target}x`,
      Number(y(goal)) + 4,
    ),
    ...failed.map(
      (index) =>
        `<g><title>${escapeHtml(`${series[index]?.time ?? ""}: MEASUREMENT_FAILURE`)}</title><line x1="${x(index)}" x2="${x(index)}" y1="${T}" y2="${H - B}" stroke="#f87171" stroke-opacity=".35" stroke-dasharray="2 3"></line><text x="${x(index)}" y="${H - B - 6}" text-anchor="middle" fill="#f87171" font-size="14" font-weight="700">&times;</text></g>`,
    ),
    `<polyline fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" points="${valid.map((point) => `${x(point.index)},${y(point.ratio)}`).join(" ")}"></polyline>`,
    ...valid.map((point) => {
      const current = point.index === currentIndex;
      const color = point.ratio <= goal ? "#34d399" : "#f87171";
      return `<circle cx="${x(point.index)}" cy="${y(point.ratio)}" r="${current ? 6 : 4}" fill="${color}" stroke="${current ? "#fff" : "#0f172a"}" stroke-width="${current ? 2 : 1.5}"><title>${escapeHtml(`${point.time}: ${fmtX(point.ratio)}`)}</title></circle>`;
    }),
    ...valid
      .filter((point) => point.index === currentIndex)
      .map(
        (point) =>
          `<text x="${Number(x(point.index)) + 10}" y="${Number(y(point.ratio)) - 8}" fill="#f1f5f9" font-size="12" font-weight="700">${fmtX(point.ratio)}</text>`,
      ),
    series.length > 0
      ? `<text x="${L}" y="${H - 8}" fill="#64748b" font-size="10">${escapeHtml(shortTime(series[0]?.time ?? ""))}</text><text x="${W - R}" y="${H - 8}" text-anchor="end" fill="#64748b" font-size="10">${escapeHtml(shortTime(series.at(-1)?.time ?? ""))}</text>`
      : "",
    "</svg>",
  ].join("");
}

function stackBars(
  title: string,
  entries: ReturnType<typeof parsePerfSelf> | undefined,
  scale: number,
  bar: string,
): string {
  const items = (entries ?? [])
    .map(
      (entry) =>
        `<li class="grid grid-cols-[3.5rem_minmax(0,1fr)] items-center gap-2"><span class="text-right font-mono text-xs tabular-nums text-slate-300">${entry.percent.toFixed(2)}%</span><div class="relative h-6 overflow-hidden rounded bg-slate-800/70"><div class="absolute inset-y-0 left-0 ${bar}" style="width:${Math.max(1, (entry.percent / scale) * 100).toFixed(1)}%"></div><span class="relative block truncate px-2 font-mono text-[11px] leading-6 text-slate-100" title="${escapeHtml(entry.symbol)}">${escapeHtml(entry.symbol)}</span></div></li>`,
    )
    .join("");
  return `<div><h3 class="mb-3 text-sm font-semibold text-slate-200">${title}</h3><ol class="space-y-1">${items || '<li class="text-sm text-slate-500">No samples.</li>'}</ol></div>`;
}

/**
 * The one dashboard file: Tailwind from its pinned Play CDN, inline SVG charts, no other URL.
 * The latest run is compared with the previous and the first measured ledger row so the page
 * answers "is Perry getting closer to V8?" at a glance. Written as `report.html` beside
 * `report.md`, and copied to the campaign `index.html`.
 */
export function reportHtml(result: {
  time: string;
  load: number[];
  head?: string;
  perrySha256?: string;
  comparison?: ReturnType<typeof compareArms>;
  error?: string;
  stacks?: Partial<Record<Arm, ReturnType<typeof parsePerfSelf>>>;
  ledger?: readonly ILedgerRow[];
  args?: { runs: number };
  regression?: IRegression;
}): string {
  const names = Object.keys(metrics) as Metric[];
  const rows = result.error ? [] : (result.comparison?.rows ?? []);
  const verdict = result.error
    ? "MEASUREMENT_FAILURE"
    : (result.comparison?.verdict ?? "MEASUREMENT_FAILURE");
  const ledger = result.ledger ?? [];
  const current = rows.length
    ? {
        time: result.time,
        binary: result.perrySha256?.slice(0, 12),
        ratios: names.map((name) => rows.find((row) => row.metric === name)?.ratio ?? null),
        verdict,
      }
    : undefined;
  // The run appends its own ledger row before rendering; a caller without one still gets its point.
  const series =
    current && !ledger.some((row) => row.time === result.time) ? [...ledger, current] : [...ledger];
  const currentIndex = current ? series.findIndex((row) => row.time === result.time) : -1;
  const measured = series.flatMap((row, index) =>
    row.ratios.every((ratio) => ratio !== null) ? [{ index, row }] : [],
  );
  const previous = measured.filter((entry) => entry.index < currentIndex).at(-1)?.row;
  // A control rerun of an older binary makes "vs last" look like a regression of the new code.
  const otherBinary =
    previous?.binary && current?.binary && previous.binary !== current.binary
      ? `<p data-other-binary="${escapeHtml(previous.binary)}" class="basis-full text-xs text-amber-200">Previous run benched another Perry binary (${escapeHtml(previous.binary)} &rarr; ${escapeHtml(current.binary)}): "vs last" compares two builds, not one change. The incumbent verdict is the commit gate.</p>`
      : "";
  const first = measured[0] && measured[0].index < currentIndex ? measured[0].row : undefined;
  const targeted = names.flatMap((name, index) => (metrics[name] === null ? [] : [index]));
  // Gap = geometric mean of ratio/target over the gated metrics; 1.0x means every target is met.
  const gap = (ratios: ReadonlyArray<number | null>): number =>
    Math.exp(
      targeted.reduce((sum, index) => {
        const target = metrics[names[index] as Metric] ?? 1;
        return sum + Math.log((ratios[index] ?? 1) / target);
      }, 0) / Math.max(1, targeted.length),
    );
  const gapNow = current ? gap(current.ratios) : undefined;
  const sinceLast =
    gapNow !== undefined && previous ? trendOf(gapNow, gap(previous.ratios)) : undefined;
  const regressed = result.regression?.rows.filter((row) => row.verdict === "REGRESSED") ?? [];
  const hero = result.error
    ? {
        key: "failed",
        word: "MEASUREMENT FAILED",
        icon: "&#10005;",
        ring: "from-red-500/25 border-red-500/50",
        text: "text-red-300",
      }
    : regressed.length
      ? {
          key: "regression",
          word: "REGRESSION",
          icon: "&#9650;",
          ring: "from-red-500/25 border-red-500/50",
          text: "text-red-300",
        }
      : verdict === "PASS" && sinceLast !== "regressed"
        ? {
            key: "on-target",
            word: "ON TARGET",
            icon: "&#10003;",
            ring: "from-emerald-500/25 border-emerald-500/50",
            text: "text-emerald-300",
          }
        : sinceLast === "improving"
          ? {
              key: "improving",
              word: "IMPROVING",
              icon: "&#9660;",
              ring: "from-emerald-500/25 border-emerald-500/50",
              text: "text-emerald-300",
            }
          : sinceLast === "regressed"
            ? {
                key: "regressed",
                word: "REGRESSED",
                icon: "&#9650;",
                ring: "from-red-500/25 border-red-500/50",
                text: "text-red-300",
              }
            : sinceLast === "flat"
              ? {
                  key: "flat",
                  word: "HOLDING",
                  icon: "&#9644;",
                  ring: "from-slate-500/25 border-slate-500/50",
                  text: "text-slate-200",
                }
              : {
                  key: "baseline",
                  word: "BASELINE",
                  icon: "&#9679;",
                  ring: "from-sky-500/25 border-sky-500/50",
                  text: "text-sky-300",
                };
  const sentence = regressed.length
    ? "Worse than the accepted incumbent on the metrics named above. Do not commit this candidate."
    : result.error
      ? "No ratios this run. The ledger records a failure and the charts below mark it."
      : gapNow === undefined
        ? ""
        : sinceLast && previous
          ? `Gap to target ${sinceLast === "flat" ? "is unchanged" : `${sinceLast === "improving" ? "shrank" : "grew"} ${pct(gapNow, gap(previous.ratios)).replace(/^[+-]/, "")}`} since the previous run.`
          : "First measured run. The next run shows the trend against it.";
  const tile = (title: string, value: string, note: string, tone = "text-slate-100") =>
    `<div class="rounded-xl border border-white/10 bg-slate-950/40 p-4"><div class="text-xs uppercase tracking-wide text-slate-400">${title}</div><div class="mt-1 text-3xl font-bold tabular-nums ${tone}">${value}</div><div class="mt-1 text-xs text-slate-400">${note}</div></div>`;
  const deltaTile = (title: string, base: ILedgerRow | undefined, empty: string) => {
    if (!base || gapNow === undefined) return tile(title, "&mdash;", empty);
    const trend = trendOf(gapNow, gap(base.ratios));
    const tone = {
      improving: "text-emerald-300",
      regressed: "text-red-300",
      flat: "text-slate-200",
    }[trend];
    return tile(
      title,
      `${ARROW[trend]} ${pct(gapNow, gap(base.ratios))}`,
      `gap ${fmtX(gap(base.ratios))} &rarr; ${fmtX(gapNow)}`,
      tone,
    );
  };
  const met = rows.filter((row) => row.target !== null && row.verdict === "PASS").length;
  const chips = rows
    .map((row) => {
      const before = previous?.ratios[names.indexOf(row.metric)];
      const trend = before == null ? undefined : trendOf(row.ratio, before);
      return `<span class="inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ring-1 ${trend ? TREND_CHIP[trend] : "bg-sky-500/15 text-sky-200 ring-sky-500/30"}"><span class="font-medium">${LABEL[row.metric]}</span><span class="tabular-nums">${before == null ? fmtX(row.ratio) : `${fmtX(before)} &rarr; ${fmtX(row.ratio)}`}</span>${trend && before != null ? `<span class="font-bold tabular-nums">${ARROW[trend]} ${pct(row.ratio, before)}</span>` : ""}</span>`;
    })
    .join("");
  const domain = logDomain([
    ...rows.flatMap((row) => [
      row.ratio,
      row.target ?? 1,
      previous?.ratios[names.indexOf(row.metric)] ?? row.ratio,
    ]),
    1,
  ]);
  const order = [...names].sort(
    (a, b) => Number(metrics[a] === null) - Number(metrics[b] === null),
  );
  const cards = order
    .map((name) => {
      const index = names.indexOf(name);
      const row = rows.find((candidate) => candidate.metric === name);
      const chart = historySvg(series, index, metrics[name], name, currentIndex);
      const before = previous?.ratios[index] ?? undefined;
      const start = first?.ratios[index] ?? undefined;
      const status = !row
        ? undefined
        : row.verdict === "PASS"
          ? "pass"
          : row.verdict === "REPORT"
            ? "report"
            : before !== undefined && trendOf(row.ratio, before) === "improving"
              ? "improving"
              : "miss";
      const tone = TONE[status ?? "report"];
      const delta = (title: string, base: number | undefined) => {
        if (!row || base === undefined) return "";
        const trend = trendOf(row.ratio, base);
        return `<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ${TREND_CHIP[trend]}">${ARROW[trend]} ${pct(row.ratio, base)} <span class="font-normal opacity-70">${title}</span></span>`;
      };
      const incumbentChip = (metric: Metric) => {
        const entry = result.regression?.rows.find((candidate) => candidate.metric === metric);
        if (!entry) return "";
        const change = pct(entry.candidate, entry.incumbent);
        const style = {
          REGRESSED: TREND_CHIP.regressed,
          IMPROVED: TREND_CHIP.improving,
          SAME: TREND_CHIP.flat,
        }[entry.verdict];
        const text = {
          REGRESSED: `${change} REGRESSED`,
          IMPROVED: `${change} improved`,
          SAME: `${change} same`,
        }[entry.verdict];
        return `<span data-incumbent="${entry.verdict}" class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ring-1 ${style}">vs incumbent ${text}</span>`;
      };
      const goal = row?.target ?? 1;
      const distance = !row
        ? ""
        : row.ratio <= goal
          ? `${Math.round((1 - row.ratio / goal) * 100)}% headroom under ${row.target === null ? "V8 parity" : "the target"}`
          : `${fmtX(row.ratio / goal)} over ${row.target === null ? "V8 parity" : "target"}: cut ${Math.round((1 - goal / row.ratio) * 100)}% more`;
      const ms = (arm: "perry" | "v8", dot: string) =>
        row
          ? `<div class="flex items-baseline justify-between gap-2"><span class="flex items-center gap-2 text-slate-300"><span class="inline-block h-2 w-2 rounded-full ${dot}"></span>${arm === "perry" ? "Perry" : "V8"}</span><span class="font-mono tabular-nums text-slate-100">${fmtMs(row[arm].median)} ms <span class="text-xs text-slate-500">[${fmtMs(row[arm].min)}&ndash;${fmtMs(row[arm].max)}]</span></span></div>`
          : "";
      const left = row
        ? `<div class="flex items-start justify-between gap-3"><div><h3 class="text-lg font-semibold text-slate-100">${LABEL[name]}</h3><div class="font-mono text-xs text-slate-500">${name}</div></div><span data-verdict="${row.verdict}" class="verdict ${row.verdict.toLowerCase()} rounded-md border px-2 py-1 text-xs font-bold tracking-wide ${tone.box} ${tone.text}">${row.verdict}${status === "improving" ? " &middot; IMPROVING" : ""}</span></div>
<div class="mt-4 flex flex-wrap items-end gap-x-3 gap-y-1"><span class="text-5xl font-extrabold tabular-nums ${tone.text}">${fmtX(row.ratio)}</span><span class="pb-2 text-sm text-slate-400">${row.target === null ? "report only, V8 parity 1x" : `target &le; ${row.target}x`}</span></div>
<div class="mt-2 flex flex-wrap gap-2">${delta("vs last", before)}${delta("vs first", start)}${incumbentChip(name)}</div>
<p class="mt-3 text-sm ${tone.text}">${distance}</p>
${gaugeHtml(row, before, domain, tone.hex)}
<div class="space-y-1 text-sm">${ms("perry", "bg-sky-400")}${ms("v8", "bg-violet-400")}</div>`
        : `<h3 class="text-lg font-semibold text-slate-100">${LABEL[name]}</h3><div class="font-mono text-xs text-slate-500">${name}</div><p class="mt-4 text-sm text-slate-400">No measurement this run.</p>`;
      return `<article data-metric="${name}" class="grid gap-6 rounded-2xl border border-white/10 bg-slate-900/70 p-5 shadow-xl lg:grid-cols-5 border-l-4" style="border-left-color:${row ? tone.hex : "#334155"}"><div class="lg:col-span-2">${left}</div><div class="lg:col-span-3"><div class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400"><span>Perry / V8 ratio per run, log scale, lower is better</span><span class="text-red-300">&times; = measurement failure</span></div>${chart}</div></article>`;
    })
    .join("");
  const scale = Math.max(
    1,
    ...(["perry", "v8"] as const).flatMap((arm) =>
      (result.stacks?.[arm] ?? []).map((entry) => entry.percent),
    ),
  );
  const stacks = result.stacks
    ? `<section class="mt-12"><h2 class="mb-1 text-xl font-bold text-slate-100">Where the CPU time goes</h2><p class="mb-5 text-sm text-slate-400">Top self-time symbols from <code>perf report --no-children</code>, one bar per symbol on a shared scale.</p><div class="grid gap-8 rounded-2xl border border-white/10 bg-slate-900/70 p-5 lg:grid-cols-2">${stackBars("Perry", result.stacks.perry, scale, "bg-sky-500/50")}${stackBars("V8", result.stacks.v8, scale, "bg-violet-500/50")}</div></section>`
    : "";
  const footerItem = (title: string, value: string, full?: string) =>
    `<div><dt class="text-xs uppercase tracking-wide text-slate-500">${title}</dt><dd class="mt-0.5 break-all font-mono text-sm text-slate-300"${full ? ` title="${escapeHtml(full)}"` : ""}>${escapeHtml(value)}</dd></div>`;
  return [
    "<!doctype html>",
    '<html lang="en" class="dark"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    `<title>Perry vs V8 &mdash; ${escapeHtml(result.time)}</title>`,
    "<style>body{background:#020617;color:#e2e8f0;font-family:system-ui,sans-serif}</style>",
    `<script src="${CDN}"></script></head>`,
    '<body class="min-h-screen bg-slate-950 text-slate-200 antialiased"><main class="mx-auto max-w-7xl px-4 py-8 sm:px-6">',
    regressed.length
      ? `<div role="alert" data-regression="true" class="mb-4 rounded-2xl border-2 border-red-500 bg-red-600/20 p-4 text-red-100 shadow-xl"><div class="text-xl font-black tracking-tight sm:text-2xl">&#9650; REGRESSION vs incumbent &mdash; do not commit</div><p class="mt-1 text-sm">Worse than the accepted run by more than the margin: ${regressed.map((row) => `<b>${LABEL[row.metric as Metric] ?? escapeHtml(row.metric)}</b> ${pct(row.candidate, row.incumbent)} (${fmtX(row.incumbent)} &rarr; ${fmtX(row.candidate)}, margin ${Math.round(row.margin * 100)}%)`).join("; ")}. Fix the cause and bench again.</p></div>`
      : "",
    `<div class="mb-4 flex flex-wrap items-baseline justify-between gap-2"><h1 class="text-lg font-semibold text-slate-300">Perry <span class="text-slate-500">vs</span> V8</h1><span class="font-mono text-sm text-slate-500">${escapeHtml(result.time)}</span></div>`,
    `<section data-trend="${hero.key}" class="rounded-3xl border bg-gradient-to-br ${hero.ring} to-slate-900/60 p-6 shadow-2xl sm:p-8"><div class="grid gap-8 lg:grid-cols-5"><div class="lg:col-span-2"><div class="flex items-center gap-4"><span class="text-5xl ${hero.text}">${hero.icon}</span><h2 class="text-4xl font-black tracking-tight sm:text-5xl ${hero.text}">${hero.word}</h2></div><p class="mt-4 text-lg text-slate-200">${sentence}</p><p class="mt-2 text-sm text-slate-400">Verdict <span class="font-bold ${verdict === "PASS" ? "text-emerald-300" : "text-red-300"}">${escapeHtml(verdict)}</span>. Lower ratio is better; a ratio above 1x means Perry is slower than V8.</p></div>${
      rows.length
        ? `<div class="grid grid-cols-2 gap-3 lg:col-span-3">${tile("Gap to target", gapNow === undefined ? "&mdash;" : fmtX(gapNow), "1.0x = every gated target met")}${deltaTile("Since last run", previous, "no earlier run")}${deltaTile("Since first run", first, "this is the first run")}${tile("Targets met", `${met} / ${targeted.length}`, "render is report only", met === targeted.length ? "text-emerald-300" : "text-red-300")}</div>`
        : ""
    }</div>${chips ? `<div class="mt-6 flex flex-wrap gap-2" aria-label="Change per metric since the previous run">${otherBinary}${chips}</div>` : ""}${result.error ? `<pre class="mt-6 whitespace-pre-wrap rounded-lg bg-slate-950/60 p-4 text-sm text-red-300">Error: ${escapeHtml(result.error)}</pre>` : ""}</section>`,
    '<h2 class="mb-4 mt-12 text-xl font-bold text-slate-100">Metrics and history</h2>',
    `<div class="space-y-4">${cards}</div>`,
    stacks,
    `<footer class="mt-12 border-t border-white/10 pt-6"><dl class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">${footerItem("Run time", result.time)}${footerItem("Git HEAD", result.head?.slice(0, 12) ?? "unknown", result.head)}${footerItem("Perry SHA-256", result.perrySha256?.slice(0, 12) ?? "unknown", result.perrySha256)}${footerItem("Load 1/5/15 min", result.load.map((value) => value.toFixed(2)).join(" / "))}${footerItem("Runs per arm", String(result.args?.runs ?? "unknown"))}${footerItem("Ledger rows", `${series.length} (${measured.length} measured)`)}</dl></footer>`,
    "</main></body></html>",
    "",
  ].join("\n");
}

/** Waits up to 60 s for the session-detached `perf record` to finish writing after the game exits. */
async function waitForProfiler(pidFile: string): Promise<void> {
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  for (let i = 0; i < 600; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("perf record did not finish within 60 s");
}

/** Best-effort detached open of the written report; failures are ignored. */
export function openReport(target: string): void {
  try {
    const child = spawn("xdg-open", [target], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening the report is a convenience, never part of the measurement.
  }
}

export async function runBench(
  argv: readonly string[],
  execute: Command = command,
  outputRoot = path.join(root, "artifacts/perf-loop"),
  host: IHost = realHost,
): Promise<number> {
  const time = new Date().toISOString();
  const load = loadavg();
  const directory = path.join(outputRoot, time);
  await mkdir(directory, { recursive: true });
  const arms: Record<Arm, IMeasurement[]> = { perry: [], v8: [] };
  const result: {
    time: string;
    load: number[];
    head: string;
    perrySha256: string;
    args?: IBenchArgs;
    regression?: IRegression;
    hostLoad?: {
      maxLoadPerCore: number;
      maxCpuPressure: number;
      start?: IHostLoad;
      end?: IHostLoad;
    };
    arms: typeof arms;
    comparison?: ReturnType<typeof compareArms>;
    error?: string;
    stacks?: Partial<Record<Arm, ReturnType<typeof parsePerfSelf>>>;
  } = { time, load, head: "unknown", perrySha256: "unknown", arms };
  try {
    const args = parseBenchArgs(argv);
    result.args = args;
    // Fail before any measurement when the accepted run cannot be read.
    // CPU stalls skew the arms unevenly; prefer the bench's own cgroup over host-wide load.
    let start = await host.load();
    if (overloaded(start, args)) {
      process.stdout.write(`${overloadError(start).message}; waiting up to 5 minutes\n`);
      for (
        let waited = 0;
        waited < LOAD_WAIT_MS && overloaded(start, args);
        waited += LOAD_POLL_MS
      ) {
        await host.sleep(LOAD_POLL_MS);
        start = await host.load();
      }
    }
    result.hostLoad = { maxLoadPerCore: args.maxLoad, maxCpuPressure: args.maxCpuPressure, start };
    if (overloaded(start, args)) throw overloadError(start);
    const incumbent = args.incumbent ? await loadIncumbent(args.incumbent) : undefined;
    const head = await execute("git", ["rev-parse", "HEAD"], root);
    if (head.code !== 0) throw new Error("Cannot read git HEAD");
    result.head = head.stdout.trim();
    result.perrySha256 = createHash("sha256")
      .update(await readFile(args.perry))
      .digest("hex");
    const scenario = JSON.parse(await readFile(args.scenario, "utf8"));
    // Keep the journey and its other assertions; these two presentation bounds are outside this benchmark.
    if (scenario.assert?.performance) {
      scenario.assert.performance.minFps = undefined;
      scenario.assert.performance.maxFrameMsP95 = undefined;
    }
    const scenarioFile = path.join(directory, "scenario.playtest.json");
    await writeFile(scenarioFile, JSON.stringify(scenario, null, 2));
    const launcher = path.join(directory, "launch.sh");
    await writeFile(
      launcher,
      '#!/bin/sh\nexport TN_PLAYER_METRICS=1\nexport TN_BENCH_LAUNCH_MS=$(date +%s%3N)\nexec "$@"\n',
    );
    // The playtest stops the host's process group with SIGTERM, then SIGKILL after 2 s; perf in
    // that group dies mid-write while a slow-exiting game holds it. Attached from its own session,
    // perf survives the kill and finishes the file when the game exits.
    // DWARF call graphs: libc/vdso frames carry no frame pointer, so -g stops at clock_gettime.
    const profiler = path.join(directory, "profile.sh");
    await writeFile(
      profiler,
      '#!/bin/sh\nexport TN_PLAYER_METRICS=1\nexport TN_BENCH_LAUNCH_MS=$(date +%s%3N)\ndata=$1; shift\nnode -e \'console.log("TN_PROFILE_CLOCK:" + JSON.stringify({perfTimeSec: Number(process.hrtime.bigint()) / 1e9, wallTimeMs: Date.now()}))\'\n"$@" &\npid=$!\nsetsid perf record --clockid mono --no-buildid -F 499 --call-graph dwarf,8192 -o "$data" -p "$pid" </dev/null >/dev/null 2>&1 &\necho $! > "$data.pid"\nwait "$pid"\n',
    );
    const bundle = path.join(args.v8Bundle, "game.js");
    try {
      await readFile(bundle);
      await readFile(path.join(args.v8Bundle, "native/assets.tnpk"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(args.v8Bundle, { recursive: true });
      const built = await execute(
        process.execPath,
        [
          path.join(root, "packages/runtime-native/scripts/bundle-native-engine.mjs"),
          "--engine",
          "native",
          "--game-runtime",
          "v8",
          "--entry",
          "src/game.ts",
          "--out",
          bundle,
          "--assets",
          args.project,
          "--asset-source",
          path.join(assetRoot, "assets"),
        ],
        args.project,
      );
      await writeFile(path.join(directory, "bundle.log"), built.stdout + built.stderr);
      if (built.code !== 0) throw new Error("V8 bundle failed; see bundle.log");
    }
    const measure = async (arm: Arm, index: number, profiling: boolean) => {
      const artifacts = path.join(directory, `${arm}-${profiling ? "perf" : index}`);
      const host =
        arm === "perry"
          ? [args.perry]
          : [
              path.join(
                root,
                "packages/runtime-native/build/tn-linux-engine/tn-native-engine-player-v8",
              ),
              bundle,
            ];
      const perfData = path.join(directory, `${arm}.data`);
      const hostArgs = profiling ? [profiler, perfData, ...host] : [launcher, ...host];
      const output = await execute(
        "sh",
        [
          path.join(root, "scripts/xvfb.sh"),
          process.execPath,
          path.join(root, "packages/playtest/dist/runner/cli.js"),
          scenarioFile,
          "--project",
          args.project,
          "--target",
          "desktop",
          "--executable",
          "/bin/sh",
          ...hostArgs.flatMap((arg) => ["--host-arg", arg]),
          "--artifacts",
          artifacts,
          "--no-screenshots",
        ],
        args.project,
      );
      await writeFile(
        path.join(directory, `${arm}-${profiling ? "perf" : index}.log`),
        output.stdout + output.stderr,
      );
      if (output.code !== 0)
        throw new Error(`${arm} run failed (exit ${output.code}); see run log`);
      const entries = JSON.parse(
        await readFile(path.join(artifacts, "console.json"), "utf8"),
      ) as Array<{ text: string }>;
      const text = entries.map((entry) => entry.text).join("\n");
      if (/TN_(?:NATIVE_START_FAILED|V8_FRAME_FAILED|PLAYER_VIEW|NATIVE_ABI_FAILED)/.test(text))
        throw new Error(`${arm} host failure`);
      const measurement = parsePlayerMetrics(text);
      if (!profiling) arms[arm].push(measurement);
      else {
        await waitForProfiler(`${perfData}.pid`);
        const profile = await execute(
          "nice",
          [
            "-n",
            "19",
            "perf",
            "report",
            "--stdio",
            "--no-children",
            "--call-graph",
            "none",
            "-s",
            "symbol",
            "--percent-limit",
            "0",
            "-i",
            perfData,
          ],
          root,
        );
        if (profile.code !== 0) throw new Error(`${arm} perf report failed`);
        await writeFile(path.join(directory, `${arm}-perf.txt`), profile.stdout + profile.stderr);
        result.stacks ??= {};
        result.stacks[arm] = parsePerfSelf(profile.stdout);
        if (arm === "perry") {
          const profiled = await loadProfile(perfData, undefined, async (scriptArgs) => {
            const output = await execute("nice", scriptArgs, root);
            if (output.code !== 0) throw new Error(`Perry perf script failed: ${output.stderr}`);
            return output.stdout;
          });
          await writeFile(path.join(directory, "perry-top.txt"), formatTop(profiled));
          await writeFile(
            path.join(directory, "perry-callers.txt"),
            formatCallers(profiled, runtimePatterns(profiled)),
          );
        }
      }
    };
    for (let i = 0; i < args.runs; i++) {
      await measure("perry", i + 1, false);
      await measure("v8", i + 1, false);
    }
    const end = await host.load();
    result.hostLoad.end = end;
    if (overloaded(end, args)) throw overloadError(end);
    result.comparison = compareArms(arms);
    if (incumbent) result.regression = compareToIncumbent(result.comparison, incumbent);
    if (args.perf) {
      await measure("perry", 1, true);
      await measure("v8", 1, true);
    }
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  const ledgerPath = path.join(outputRoot, "ledger.tsv");
  await appendFile(
    ledgerPath,
    ledgerLine(
      time,
      result.head,
      result.perrySha256,
      result.error ? undefined : result.comparison,
      result.regression?.verdict === "REGRESSION" ? "REGRESSION" : undefined,
    ),
  );
  const ledger = parseLedger(await readFile(ledgerPath, "utf8").catch(() => ""));
  const html = reportHtml({ ...result, ledger });
  await writeFile(path.join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(directory, "report.md"), reportMarkdown(result));
  const reportPath = path.join(directory, "report.html");
  await writeFile(reportPath, html);
  // A failed run keeps its own report and ledger row; it must not replace the last measured dashboard.
  const index = path.join(outputRoot, "index.html");
  if (!result.error || !existsSync(index)) await writeFile(index, html);
  if (result.args?.open && !process.env.CI) openReport(reportPath);
  process.stdout.write(`${path.join(directory, "report.md")}\n`);
  if (result.error) return 2;
  return result.regression?.verdict === "REGRESSION" ? 3 : (result.comparison?.exitCode ?? 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runBench(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 2;
    });
}
