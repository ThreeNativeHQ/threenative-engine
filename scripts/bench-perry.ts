// PRD-581: compare one authored scenario on the shared native player; present is never a gate.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
const command: Command = async (file, args, cwd) => {
  try {
    const output = await exec(file, args, {
      cwd,
      env: {
        ...process.env,
        TN_PLAYTEST_HOST_DISPLAY: "1",
        SDL_VIDEODRIVER: "x11",
        WAYLAND_DISPLAY: "",
        TN_ASSET_ROOT: path.join(root, "packages/create-threenative/template-assets"),
      },
      timeout: 180_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    return { code: 0, ...output };
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: string; stderr?: string; killed?: boolean };
    if (failure.killed || typeof failure.code !== "number") throw error;
    return { code: failure.code, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
};

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
    if (!flag || !["--project", "--scenario", "--perry", "--v8-bundle", "--runs"].includes(flag))
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
  return {
    project,
    perry: path.resolve(perry),
    runs,
    perf,
    open,
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

export function ledgerLine(
  time: string,
  head: string,
  hash: string,
  comparison?: ReturnType<typeof compareArms>,
): string {
  return `${[
    time,
    head,
    hash.slice(0, 12),
    ...(Object.keys(metrics) as Metric[]).map(
      (metric) => comparison?.rows.find((row) => row.metric === metric)?.ratio.toFixed(6) ?? "NA",
    ),
    comparison?.verdict ?? "MEASUREMENT_FAILURE",
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
  comparison?: ReturnType<typeof compareArms>;
  error?: string;
  arms?: Record<Arm, IMeasurement[]>;
  stacks?: Partial<Record<Arm, ReturnType<typeof parsePerfSelf>>>;
}): string {
  const lines = [
    `# Perry vs V8 — ${result.time}`,
    `Host load (1/5/15 min): ${result.load.join(" / ")}`,
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

/** Two horizontal bars, Perry over V8, scaled to the larger median. */
function barSvg(row: ComparisonRow): string {
  const max = Math.max(row.perry.median, row.v8.median);
  const width = (value: number) => (max > 0 ? Math.max(2, Math.round((value / max) * 220)) : 2);
  const label = `${row.metric}: Perry ${row.perry.median.toFixed(3)} ms, V8 ${row.v8.median.toFixed(3)} ms`;
  return [
    `<svg class="bar" viewBox="0 0 240 28" role="img" aria-label="${escapeHtml(label)}">`,
    `<title>${escapeHtml(label)}</title>`,
    `<rect class="perry" x="0" y="1" width="${width(row.perry.median)}" height="11"></rect>`,
    `<rect class="v8" x="0" y="16" width="${width(row.v8.median)}" height="11"></rect>`,
    "</svg>",
  ].join("");
}

/** One metric's Perry/V8 ratio across the ledger, with a dashed target line. */
function historySvg(
  ledger: readonly ILedgerRow[],
  metricIndex: number,
  target: number | null,
  metric: string,
): string {
  const points = ledger
    .map((row, index) => ({ index, ratio: row.ratios[metricIndex] ?? null }))
    .filter((point): point is { index: number; ratio: number } => point.ratio !== null);
  if (points.length === 0)
    return `<p class="empty">No ledger history for ${escapeHtml(metric)}.</p>`;
  const bounds = points.map((point) => point.ratio);
  if (target !== null) bounds.push(target);
  let min = Math.min(...bounds);
  let max = Math.max(...bounds);
  if (min === max) {
    min -= 0.1;
    max += 0.1;
  }
  const span = Math.max(1, ledger.length - 1);
  const x = (index: number) => Math.round(10 + (index / span) * 280);
  const y = (value: number) => Math.round(70 - ((value - min) / (max - min)) * 60);
  const line = points.map((point) => `${x(point.index)},${y(point.ratio)}`).join(" ");
  const targetLine =
    target === null
      ? ""
      : `<line class="target" x1="10" y1="${y(target)}" x2="290" y2="${y(target)}"></line>`;
  return [
    `<svg class="history" viewBox="0 0 300 80" role="img" aria-label="${escapeHtml(`${metric} ratio over time`)}">`,
    `<title>${escapeHtml(`${metric} ratio over time`)}</title>`,
    targetLine,
    `<polyline class="series" fill="none" points="${line}"></polyline>`,
    ...points.map(
      (point) =>
        `<circle class="point" cx="${x(point.index)}" cy="${y(point.ratio)}" r="2"></circle>`,
    ),
    "</svg>",
  ].join("");
}

/**
 * The one self-contained dashboard file (inline CSS and SVG, no CDN, no framework) that the
 * native-performance-loop skill's `references/dashboard.md` contract describes. Writing it as
 * `report.html` beside `report.md` and refreshing the campaign `index.html` from the same renderer
 * keeps a single format.
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
}): string {
  const ledger = result.ledger ?? [];
  const verdict = result.error
    ? "MEASUREMENT_FAILURE"
    : (result.comparison?.verdict ?? "MEASUREMENT_FAILURE");
  const rows = result.comparison?.rows ?? [];
  const metricNames = Object.keys(metrics) as Metric[];
  const metricRows = rows
    .map((row) =>
      [
        "<tr>",
        `<th scope="row">${escapeHtml(row.metric)}</th>`,
        `<td>${row.perry.median.toFixed(3)} [${row.perry.min.toFixed(3)}&ndash;${row.perry.max.toFixed(3)}]</td>`,
        `<td>${row.v8.median.toFixed(3)} [${row.v8.min.toFixed(3)}&ndash;${row.v8.max.toFixed(3)}]</td>`,
        `<td>${row.ratio.toFixed(3)}</td>`,
        `<td>${row.target === null ? "report only" : `${row.target}x`}</td>`,
        `<td class="verdict ${row.verdict.toLowerCase()}">${row.verdict}</td>`,
        "</tr>",
      ].join(""),
    )
    .join("");
  const bars = rows
    .map(
      (row) =>
        `<figure><figcaption>${escapeHtml(row.metric)} &mdash; Perry vs V8 (ms, lower is better)</figcaption>${barSvg(row)}</figure>`,
    )
    .join("");
  const history = metricNames
    .map(
      (metric, index) =>
        `<figure><figcaption>${escapeHtml(metric)} ratio over time (dashed = target)</figcaption>${historySvg(ledger, index, metrics[metric], metric)}</figure>`,
    )
    .join("");
  const stacks = result.stacks
    ? [
        "<h2>Top self-time</h2>",
        '<div class="table-wrap"><table><thead><tr><th>#</th><th>Perry</th><th>V8</th></tr></thead><tbody>',
        ...Array.from({ length: 15 }, (_, index) => {
          const cell = (arm: Arm) => {
            const entry = result.stacks?.[arm]?.[index];
            return entry ? `${entry.percent.toFixed(2)}% ${escapeHtml(entry.symbol)}` : "&mdash;";
          };
          return `<tr><td>${index + 1}</td><td>${cell("perry")}</td><td>${cell("v8")}</td></tr>`;
        }),
        "</tbody></table></div>",
      ].join("")
    : "";
  const style = [
    ":root{--fg:#1a1a1a;--bg:#fff;--muted:#555;--line:#ccc;--pass:#0a7d32;--miss:#c0261b;--report:#5a5a5a;--perry:#2563eb;--v8:#9333ea;--target:#888;color-scheme:light dark}",
    "@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--bg:#161616;--muted:#aaa;--line:#444;--pass:#4ade80;--miss:#f87171;--report:#bdbdbd;--perry:#60a5fa;--v8:#c084fc;--target:#999}}",
    "body{margin:1rem auto;max-width:1100px;padding:0 1rem;background:var(--bg);color:var(--fg);font-family:system-ui,sans-serif;line-height:1.4}",
    "h1{font-size:1.3rem}h2{font-size:1.1rem;margin-top:1.5rem}dt{font-weight:600}dl{display:grid;grid-template-columns:auto 1fr;gap:.1rem .8rem;font-size:.9rem}dd{margin:0;color:var(--muted)}",
    ".table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{border:1px solid var(--line);padding:.35rem .5rem;text-align:right}th:first-child{text-align:left}",
    ".verdict.pass{color:var(--pass);font-weight:700}.verdict.miss{color:var(--miss);font-weight:700}.verdict.report{color:var(--report);font-weight:700}.verdict.measurement_failure{color:var(--miss);font-weight:700}",
    ".figures{display:flex;flex-wrap:wrap;gap:1rem}figure{margin:0}figcaption{font-size:.85rem;color:var(--muted)}",
    "svg.bar{width:100%;max-width:320px;height:auto}svg.bar rect.perry{fill:var(--perry)}svg.bar rect.v8{fill:var(--v8)}",
    "svg.history{width:100%;max-width:340px;height:auto}svg.history polyline.series{stroke:var(--perry);stroke-width:2}svg.history circle.point{fill:var(--perry)}svg.history line.target{stroke:var(--target);stroke-width:1;stroke-dasharray:4 3}",
    ".error{color:var(--miss)}.empty{color:var(--muted);font-size:.85rem}@media (max-width:600px){body{font-size:.9rem}th,td{padding:.25rem}}",
  ].join("");
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>Perry vs V8 &mdash; ${escapeHtml(result.time)}</title>`,
    `<style>${style}</style></head><body>`,
    "<header>",
    `<h1>Perry vs V8 &mdash; ${escapeHtml(result.time)}</h1>`,
    `<p class="verdict ${verdict.toLowerCase()}">Verdict: ${escapeHtml(verdict)}</p>`,
    "<dl>",
    `<dt>Git HEAD</dt><dd>${escapeHtml(result.head?.slice(0, 12) ?? "unknown")}</dd>`,
    `<dt>Perry SHA-256</dt><dd>${escapeHtml(result.perrySha256?.slice(0, 12) ?? "unknown")}</dd>`,
    `<dt>Host load (1/5/15 min)</dt><dd>${result.load.map((value) => value.toFixed(2)).join(" / ")}</dd>`,
    "</dl>",
    "</header>",
    result.error ? `<p class="error">Error: ${escapeHtml(result.error)}</p>` : "",
    "<h2>Metrics</h2>",
    rows.length
      ? `<div class="table-wrap"><table><thead><tr><th>metric (ms)</th><th>Perry median [min&ndash;max]</th><th>V8 median [min&ndash;max]</th><th>ratio</th><th>target</th><th>verdict</th></tr></thead><tbody>${metricRows}</tbody></table></div>`
      : '<p class="empty">No metric comparison for this run.</p>',
    `<div class="figures">${bars}</div>`,
    "<h2>Ledger history</h2>",
    '<p class="empty">Ratio of Perry median to V8 median per metric; lower is better. A missing point is a gap for a failed measurement, never zero.</p>',
    `<div class="figures">${history}</div>`,
    stacks,
    "</body></html>",
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
    arms: typeof arms;
    comparison?: ReturnType<typeof compareArms>;
    error?: string;
    stacks?: Partial<Record<Arm, ReturnType<typeof parsePerfSelf>>>;
  } = { time, load, head: "unknown", perrySha256: "unknown", arms };
  try {
    const args = parseBenchArgs(argv);
    result.args = args;
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
    const profiler = path.join(directory, "profile.sh");
    await writeFile(
      profiler,
      '#!/bin/sh\nexport TN_PLAYER_METRICS=1\nexport TN_BENCH_LAUNCH_MS=$(date +%s%3N)\ndata=$1; shift\n"$@" &\npid=$!\nsetsid perf record --no-buildid -F 499 -g -o "$data" -p "$pid" </dev/null >/dev/null 2>&1 &\necho $! > "$data.pid"\nwait "$pid"\n',
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
          "perf",
          [
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
      }
    };
    for (let i = 0; i < args.runs; i++) {
      await measure("perry", i + 1, false);
      await measure("v8", i + 1, false);
    }
    result.comparison = compareArms(arms);
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
    ledgerLine(time, result.head, result.perrySha256, result.error ? undefined : result.comparison),
  );
  const ledger = parseLedger(await readFile(ledgerPath, "utf8").catch(() => ""));
  const html = reportHtml({ ...result, ledger });
  await writeFile(path.join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(directory, "report.md"), reportMarkdown(result));
  const reportPath = path.join(directory, "report.html");
  await writeFile(reportPath, html);
  await writeFile(path.join(outputRoot, "index.html"), html);
  if (result.args?.open && !process.env.CI) openReport(reportPath);
  process.stdout.write(`${path.join(directory, "report.md")}\n`);
  return result.error ? 2 : (result.comparison?.exitCode ?? 2);
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
