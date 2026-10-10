// PRD-581: compare one authored scenario on the shared native player; present is never a gate.
import { execFile } from "node:child_process";
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
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") continue;
    if (flag === "--perf") {
      perf = true;
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
    const match = /^\s*([\d.]+)%\s+(?:\[[^\]]+\]\s+)?(.+?)\s*$/.exec(line);
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
      const hostArgs = [
        launcher,
        ...(profiling ? ["perf", "record", "-g", "-o", perfData, "--"] : []),
        ...host,
      ];
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
  await writeFile(path.join(directory, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  await writeFile(path.join(directory, "report.md"), reportMarkdown(result));
  await appendFile(
    path.join(outputRoot, "ledger.tsv"),
    ledgerLine(time, result.head, result.perrySha256, result.error ? undefined : result.comparison),
  );
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
