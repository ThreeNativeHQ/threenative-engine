// `pnpm bench:engines` — PRD-117's entry point. Opt-in by construction: nothing here is wired
// into `pnpm test`, and the Godot arms are the only thing that needs Godot installed.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type IWorkloadAxes,
  parseAxesRecord,
} from "../../examples/engine-load-test/src/workload.js";
import { runPerformanceRegressionCli } from "../performance-regression/compare.js";
import { cpuCommand, runCpuCommand } from "../performance-regression/cpu.js";
import {
  assertBrowserPlacements,
  assertHardwareAdapter,
  assertPlainThreePilot,
  driveBenchmarkPage,
  serveDirectory,
  startProcess,
  waitForUrl,
} from "./browser.js";
import { pairRows, pairVerdict, renderPairMarkdown } from "./pair.js";
import {
  BenchError,
  type IPerformanceBaseline,
  type IPerformanceCheck,
  type IRunReport,
  baselineForLane,
  checkPerformance,
  compare,
  laneForArm,
  laneForId,
  parsePerformanceLaneManifest,
  parseRunReport,
  readHostLoad,
  renderArmMarkdown,
  renderComparisonMarkdown,
  renderPerformanceCheck,
  scoreboardRows,
  withHostLoad,
} from "./report.js";
import { runAndroidArm } from "./run-android.js";
import { desktopTimeoutMs, resolveFoxAsset, runGodotDesktop, runTnDesktop } from "./run-desktop.js";
import { runTnEngineDesktop } from "./run-engine.js";
import { exportGodotWeb } from "./run-godot.js";
import {
  ENGINE_DIST,
  buildWebEngineExample,
  freshWasm,
  webArtifactBytes,
} from "./run-web-engine.js";
import { saveFrames } from "./visual.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const artifactRoot = path.join(repoRoot, "artifacts/engine-load-test");
// TN_BENCH_PORT moves the web arms off 5199 on a host where another server holds it.
const TN_PORT = Number(process.env.TN_BENCH_PORT ?? 5199);
const TN_DIST = path.join(repoRoot, "examples/engine-load-test/dist");
const GODOT_PORT = 5198;
const DEFAULT_LANE_MANIFEST = path.join(repoRoot, "scripts/performance-regression/lanes.json");
const execFileAsync = promisify(execFile);

interface ILadderOptions {
  axes: IWorkloadAxes;
  frames: number;
  height: number;
  ladder: string;
  modes: string;
  repeats: number;
  sourceSha?: string;
  warmup: number;
  width: number;
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function ladderOptions(): ILadderOptions {
  return {
    // Every axis is optional; unset ones resolve to the PRD-117 scene so `positionHash` and the
    // Godot port stay equivalent until an axis is deliberately moved.
    axes: parseAxesRecord({
      geometry: flag("geometry"),
      hierarchyDepth: flag("hierarchy-depth"),
      material: flag("material"),
      mutationRate: flag("mutation-rate"),
      passCount: flag("passes"),
      shadowCasterShare: flag("shadow-caster-share"),
      visibleFraction: flag("visible-fraction"),
    }),
    frames: Number(flag("frames") ?? 600),
    // The host surface both desktop arms are given, and both arms' reported `display`. PRD-464's
    // ladder is run at 1920x1080 so R5 can draw at it; the cube rows keep the old 1280x720.
    height: positiveInteger(flag("height"), 720),
    ladder: flag("ladder") ?? "256,1024,4096,16384",
    modes: flag("modes") ?? "L1,L2",
    repeats: Number(flag("repeats") ?? 3),
    sourceSha: flag("source-sha"),
    warmup: Number(flag("warmup") ?? 120),
    width: positiveInteger(flag("width"), 1280),
  };
}

/** A window dimension is not a benchmark axis that can be zero or negative: a bad flag has to
 *  fail here rather than reach a window manager. */
function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new BenchError(
      "TN_BENCH_BAD_FLAG",
      `--width/--height must be positive integers, got '${value}'`,
      1,
    );
  return parsed;
}

function query(options: ILadderOptions): string {
  const params = new URLSearchParams({
    frames: String(options.frames),
    ladder: options.ladder,
    modes: options.modes,
    repeats: String(options.repeats),
    warmup: String(options.warmup),
    geometry: options.axes.geometry,
    material: options.axes.material,
    hierarchyDepth: String(options.axes.hierarchyDepth),
    visibleFraction: String(options.axes.visibleFraction),
    mutationRate: String(options.axes.mutationRate),
    shadowCasterShare: String(options.axes.shadowCasterShare),
    passes: String(options.axes.passCount),
  });
  if (options.sourceSha !== undefined) params.set("sourceSha", options.sourceSha);
  // The pair's per-frame phases, and the engine arm's call census, as the desktop arms take them from the env.
  if (process.env.TN_BENCH_PHASES === "1") params.set("phases", "1");
  if (process.env.TN_BENCH_CROSSINGS === "1") params.set("crossings", "1");
  // The named override that forces core's JS mirror where the host batches the scene, as on the engine player.
  if (process.env.TN_BENCH_PROJECTION === "js") params.set("projection", "js");
  return params.toString();
}

/**
 * A web arm's adapter is read from the page, never assumed. A software rasteriser fails the arm unless
 * `--allow-software` is passed, and then the run says so in its build notes: it is never real-GPU evidence.
 */
function gateWebAdapter(report: IRunReport): IRunReport {
  if (!process.argv.includes("--allow-software")) {
    assertHardwareAdapter(report.driver.adapter);
    return report;
  }
  try {
    assertHardwareAdapter(report.driver.adapter);
    return report;
  } catch {
    return {
      ...report,
      build: {
        ...report.build,
        notes: `SOFTWARE ADAPTER, not real-GPU evidence (--allow-software); ${report.build.notes}`,
      },
    };
  }
}

/** The bytes the served build shipped, beside what the page measured about its own startup and memory. */
async function withWebArtifact(
  report: IRunReport,
  dist: string,
  wasm?: Awaited<ReturnType<typeof freshWasm>>,
): Promise<IRunReport> {
  const artifact = await webArtifactBytes(dist);
  return {
    ...report,
    web: { ...report.web, artifact, ...(wasm === undefined ? {} : { engineWasm: wasm }) },
  };
}

async function runTnEngineWeb(options: ILadderOptions): Promise<IRunReport> {
  // The pinned Fox, digest checked, as the production builds ship it beside the page.
  resolveFoxAsset(repoRoot, options.modes);
  const wasm = await freshWasm(repoRoot);
  await buildWebEngineExample(repoRoot);
  // The build copies the Wasm; a source edited during the build would leave it stale again.
  const after = await freshWasm(repoRoot);
  if (after.sha256 !== wasm.sha256)
    throw new BenchError("TN_BENCH_STALE_WASM", "the engine Wasm changed during the build", 1);
  const dist = path.join(repoRoot, ENGINE_DIST);
  const server = await serveDirectory(dist, TN_PORT);
  try {
    await waitForUrl(`http://127.0.0.1:${TN_PORT}/index.html`, 60_000);
    const raw = await driveBenchmarkPage({
      onConsole: (text) => process.stderr.write(`[tn-engine-web] ${text}\n`),
      timeoutMs: desktopTimeoutMs(options),
      url: `http://127.0.0.1:${TN_PORT}/index.html?${query(options)}`,
    });
    return withWebArtifact(
      gateWebAdapter(assertBrowserPlacements(parseRunReport(raw))),
      dist,
      wasm,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runTnWeb(options: ILadderOptions): Promise<IRunReport> {
  const server = startProcess(
    "pnpm",
    [
      "--filter",
      "threenative-engine-load-test",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(TN_PORT),
      "--strictPort",
    ],
    repoRoot,
  );
  try {
    await waitForUrl(`http://127.0.0.1:${TN_PORT}/`, 120_000);
    const raw = await driveBenchmarkPage({
      onConsole: (text) => process.stderr.write(`[tn-web] ${text}\n`),
      timeoutMs: desktopTimeoutMs(options),
      url: `http://127.0.0.1:${TN_PORT}/?${query(options)}`,
    });
    return parseRunReport(raw);
  } finally {
    server.kill("SIGTERM");
  }
}

async function runTnWebProduction(options: ILadderOptions): Promise<IRunReport> {
  resolveFoxAsset(repoRoot, options.modes);
  await buildTnExample();
  const server = await serveDirectory(TN_DIST, TN_PORT);
  try {
    await waitForUrl(`http://127.0.0.1:${TN_PORT}/index.html`, 60_000);
    const raw = await driveBenchmarkPage({
      onConsole: (text) => process.stderr.write(`[tn-web] ${text}\n`),
      timeoutMs: desktopTimeoutMs(options),
      url: `http://127.0.0.1:${TN_PORT}/index.html?${query(options)}`,
    });
    return withWebArtifact(gateWebAdapter(assertBrowserPlacements(parseRunReport(raw))), TN_DIST);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// The same `vite build` a user ships, so a publication run is never a dev server with HMR. The
// example owns the build; nothing here reaches into its config.
async function buildTnExample(): Promise<void> {
  try {
    await execFileAsync("pnpm", ["--filter", "threenative-engine-load-test", "build"], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stderr =
      typeof error === "object" &&
      error !== null &&
      "stderr" in error &&
      typeof error.stderr === "string"
        ? error.stderr.trim()
        : "";
    throw new BenchError(
      "TN_BENCH_TN_BUILD_FAILED",
      `the example's production build failed: ${stderr || String(error)}`,
      1,
    );
  }
  // A build that exits clean but wrote somewhere else would otherwise time out on a 404.
  if (!existsSync(path.join(TN_DIST, "index.html")))
    throw new BenchError("TN_BENCH_TN_BUILD_MISSING", `${TN_DIST}/index.html does not exist`, 1);
}

async function runPlainThreeWebProduction(options: ILadderOptions): Promise<IRunReport> {
  if (!process.argv.includes("--production"))
    throw new BenchError(
      "TN_BENCH_PLAIN_REQUIRES_PRODUCTION",
      "--arm plain-three-webgpu runs the production build only: a dev server with HMR is not the artifact a comparison may use. Pass --production.",
      1,
    );
  await buildTnExample();
  // Same reasoning as the shared builder's own check: a build that exits clean without this entry
  // would otherwise spend the browser timeout on a 404.
  if (!existsSync(path.join(TN_DIST, "plain.html")))
    throw new BenchError("TN_BENCH_TN_BUILD_MISSING", `${TN_DIST}/plain.html does not exist`, 1);
  const server = await serveDirectory(TN_DIST, TN_PORT);
  try {
    await waitForUrl(`http://127.0.0.1:${TN_PORT}/plain.html`, 60_000);
    const raw = await driveBenchmarkPage({
      onConsole: (text) => process.stderr.write(`[plain-three-webgpu] ${text}\n`),
      timeoutMs: desktopTimeoutMs(options),
      url: `http://127.0.0.1:${TN_PORT}/plain.html?${query(options)}`,
    });
    return assertPlainThreePilot(parseRunReport(raw));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function runGodotWeb(options: ILadderOptions): Promise<IRunReport> {
  const exportDir = await exportGodotWeb(repoRoot);
  const server = await serveDirectory(exportDir, GODOT_PORT);
  try {
    await waitForUrl(`http://127.0.0.1:${GODOT_PORT}/index.html`, 60_000);
    const raw = await driveBenchmarkPage({
      onConsole: (text) => process.stderr.write(`[godot-web] ${text}\n`),
      timeoutMs: desktopTimeoutMs(options),
      url: `http://127.0.0.1:${GODOT_PORT}/index.html?${query(options)}`,
    });
    return parseRunReport(raw);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function loadArm(arm: string): Promise<IRunReport> {
  const file = path.join(artifactRoot, `${arm}.json`);
  return parseRunReport(JSON.parse(await readFile(file, "utf8")));
}

function requiredBaselineMode(): boolean {
  return (
    process.argv.includes("--required-baseline") || process.argv.includes("--require-baseline")
  );
}

async function readLaneManifest(file: string) {
  try {
    return parsePerformanceLaneManifest(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError(
      "TN_BENCH_BAD_LANE_MANIFEST",
      `could not read or parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function requiredBaseline(report: IRunReport): Promise<{
  readonly baselines: Record<string, IPerformanceBaseline>;
  readonly laneId: string;
}> {
  const manifestFile = flag("lanes") ?? DEFAULT_LANE_MANIFEST;
  const manifest = await readLaneManifest(manifestFile);
  const requestedLane = flag("lane");
  const lane =
    requestedLane === undefined
      ? laneForArm(manifest, report.arm)
      : laneForId(manifest, requestedLane);
  if (lane === undefined) {
    throw new BenchError(
      "TN_BENCH_LANE_MISSING",
      `no manifest lane is assigned to ${requestedLane ?? report.arm}; requested coverage cannot pass`,
    );
  }
  if (!lane.arms.includes(report.arm)) {
    throw new BenchError(
      "TN_BENCH_LANE_IDENTITY_MISMATCH",
      `requested lane ${lane.id} does not accept report arm ${report.arm}`,
    );
  }
  const baseline = baselineForLane(lane);
  if (baseline === undefined) return { baselines: {}, laneId: lane.id };
  const key = report.deviceCondition?.serial.startsWith("emulator-")
    ? `${report.arm}@emulator`
    : report.arm;
  return { baselines: { [key]: baseline }, laneId: lane.id };
}

async function runRequestedArm(arm: string, options: ILadderOptions): Promise<IRunReport> {
  if (arm === "tn-web")
    return process.argv.includes("--production") ? runTnWebProduction(options) : runTnWeb(options);
  if (arm === "tn-engine-web") return runTnEngineWeb(options);
  if (arm === "godot-web") return runGodotWeb(options);
  if (arm === "tn-desktop") return parseRunReport(await runTnDesktop(repoRoot, options));
  if (arm === "tn-engine-desktop")
    return parseRunReport(await runTnEngineDesktop(repoRoot, options));
  if (arm === "godot-desktop") {
    const report = await runGodotDesktop(repoRoot, options);
    // Godot cannot know the tree it was measured against, so the runner stamps it the way the
    // ThreeNative arm reports its own, and the two arms carry the same `identity.sourceSha`.
    return parseRunReport(
      options.sourceSha === undefined
        ? report
        : { ...(report as object), identity: { sourceSha: options.sourceSha } },
    );
  }
  if (arm === "tn-android" || arm === "godot-android") {
    return parseRunReport(
      await runAndroidArm(repoRoot, arm, {
        ...options,
        allowEmulator: process.argv.includes("--allow-emulator"),
        allowLowBattery: process.argv.includes("--allow-low-battery"),
        timeoutMs: desktopTimeoutMs(options),
      }),
    );
  }
  throw new BenchError("TN_BENCH_BAD_ARM", `unknown arm ${arm}`);
}

async function checkArmPerformance(
  report: IRunReport,
  required: boolean,
): Promise<IPerformanceCheck | undefined> {
  if (!required) return checkPerformance(report);
  const input = await requiredBaseline(report);
  return checkPerformance(report, input.baselines, undefined, {
    laneId: input.laneId,
    required: true,
  });
}

async function runArmCommand(arm: string, options: ILadderOptions): Promise<void> {
  const file = path.join(artifactRoot, `${flag("out") ?? arm}.json`);
  const immutable = process.argv.includes("--production");
  if (immutable && options.sourceSha !== undefined) {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: repoRoot,
      }),
    ]);
    if (options.sourceSha !== head.trim() || status.trim().length > 0)
      throw new BenchError(
        "TN_BENCH_SOURCE_MISMATCH",
        "--source-sha for a production run must equal the full clean checkout HEAD",
        1,
      );
  }
  if (immutable && existsSync(file))
    throw new BenchError(
      "TN_BENCH_OUTPUT_EXISTS",
      `${path.relative(repoRoot, file)} already exists; choose a new --out to retain every attempt`,
      1,
    );
  const measured =
    arm === "plain-three-webgpu"
      ? await runPlainThreeWebProduction(options)
      : await runRequestedArm(arm, options);
  if (measured.arm !== arm) {
    throw new BenchError(
      "TN_BENCH_ARM_MISMATCH",
      `asked for ${arm}, the run reported ${measured.arm}. Check the build's platform stamp.`,
    );
  }
  // Read after the run, so the load that gets recorded is the load the timed window ran under.
  const report = withHostLoad(measured, readHostLoad());
  await saveFrames(report, file);
  await writeFile(
    file,
    `${JSON.stringify(report, null, 2)}\n`,
    immutable ? { flag: "wx" } : undefined,
  );
  // The report is kept either way; a row with a counter missing is not published as a result.
  scoreboardRows(report);
  process.stdout.write(`${renderArmMarkdown(report)}\n\nwrote ${path.relative(repoRoot, file)}\n`);

  // The control is a pilot, not a qualified run: it has no paired-block baseline, so it is written
  // and parsed like any other arm and judged by none. A speedup claim needs the qualification it
  // has not been through.
  if (arm === "plain-three-webgpu") {
    process.stdout.write(
      "unqualified: no paired-block verdict, no baseline check, no speedup claimed.\n",
    );
    return;
  }

  const required = requiredBaselineMode();
  if (process.argv.includes("--skip-baseline")) {
    if (required) {
      throw new BenchError(
        "TN_BENCH_REQUIRED_BASELINE_SKIPPED",
        "required mode cannot skip a baseline",
      );
    }
    process.stderr.write("baseline check skipped by --skip-baseline\n");
    return;
  }
  const check = await checkArmPerformance(report, required);
  if (check === undefined) return;
  process.stdout.write(`\n${renderPerformanceCheck(check)}\n`);
  if (check.regressions.length > 0) {
    throw new BenchError(
      "TN_BENCH_PERFORMANCE_REGRESSION",
      `${check.regressions.length} rung(s) slower than the ${check.arm} baseline.`,
      1,
    );
  }
}

async function runRegressionCommand(): Promise<void> {
  const result = await runPerformanceRegressionCli({
    input: flag("input") ?? flag("report"),
    lane: flag("lane"),
    lanes: flag("lanes"),
    output: flag("out"),
    policy: flag("policy"),
  });
  process.stdout.write(`${result.markdown}\n`);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

async function runRegressionCollectionCommand(): Promise<void> {
  const target = flag("target");
  if (target === undefined) {
    throw new BenchError(
      "TN_BENCH_COLLECTION_TARGET_MISSING",
      "--regression-collection requires --target so the collector records the selected platform",
    );
  }
  const script = path.join(repoRoot, "packages/runtime-native/scripts/profile-production.mjs");
  const forwardedNames = [
    "config",
    "control",
    "device",
    "out",
    "physical-evidence",
    "prebuilt-artifact",
    "render-size",
    "source-sha",
    "cold-starts",
    "duration",
    "repetitions",
    "warmup",
  ] as const;
  const forwarded = [
    "--target",
    target,
    "--profile",
    "regression",
    ...forwardedNames.flatMap((name) => {
      const value = flag(name);
      return value === undefined ? [] : [`--${name}`, value];
    }),
  ];
  try {
    const result = await execFileAsync(process.execPath, [script, ...forwarded], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.stdout.length > 0) process.stdout.write(result.stdout);
    if (result.stderr.length > 0) process.stderr.write(result.stderr);
  } catch (error) {
    if (typeof error === "object" && error !== null) {
      const output = "stdout" in error && typeof error.stdout === "string" ? error.stdout : "";
      const diagnostics = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
      if (output.length > 0) process.stdout.write(output);
      if (diagnostics.length > 0) process.stderr.write(diagnostics);
    }
    const exitCode =
      typeof error === "object" && error !== null && "code" in error && error.code === 1 ? 1 : 2;
    throw new BenchError(
      "TN_BENCH_REGRESSION_COLLECTION_FAILED",
      `bounded regression collector failed for ${target}: ${error instanceof Error ? error.message : String(error)}`,
      exitCode,
    );
  }
}

async function runReportCheckCommand(file: string): Promise<void> {
  let report: IRunReport;
  try {
    report = parseRunReport(JSON.parse(await readFile(file, "utf8")));
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError(
      "TN_BENCH_BAD_REPORT_INPUT",
      `could not read or parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const check = await checkArmPerformance(report, requiredBaselineMode());
  if (check === undefined) return;
  process.stdout.write(`${renderPerformanceCheck(check)}\n`);
  if (check.regressions.length > 0) {
    throw new BenchError(
      "TN_BENCH_PERFORMANCE_REGRESSION",
      `${check.regressions.length} rung(s) slower than the ${check.arm} baseline.`,
      1,
    );
  }
}

/**
 * The arms a same-run pair may name: the two desktop ThreeNative hosts and Godot's desktop export, and the two
 * web arms (three.js WebGPURenderer and the Wasm engine), which pair only with each other and only as
 * production builds. A web arm is never paired with a desktop one.
 */
export const PAIRABLE_ARMS = [
  "tn-desktop",
  "tn-engine-desktop",
  "godot-desktop",
  "tn-web",
  "tn-engine-web",
] as const;
const WEB_PAIR_ARMS = new Set(["tn-web", "tn-engine-web"]);

/**
 * `--pair a,b --rounds N`: both arms run the same ladder, alternating which goes first each round, and every
 * report is written. The table prints only when the parity guard passes on all of them; otherwise the run
 * exits 1 with the facets that differ, and a ratio is never produced.
 */
async function runPairCommand(spec: string): Promise<void> {
  const names = spec.split(",");
  const [first, second] = names;
  if (
    names.length !== 2 ||
    !PAIRABLE_ARMS.some((arm) => arm === first) ||
    !PAIRABLE_ARMS.some((arm) => arm === second) ||
    first === second
  )
    throw new BenchError(
      "TN_BENCH_BAD_FLAG",
      `--pair takes two different arms from ${PAIRABLE_ARMS.join(", ")}, got '${spec}'`,
      1,
    );
  if (WEB_PAIR_ARMS.has(first as string) !== WEB_PAIR_ARMS.has(second as string))
    throw new BenchError(
      "TN_BENCH_BAD_FLAG",
      `--pair never mixes a web arm and a desktop arm, got '${spec}'`,
      1,
    );
  if (WEB_PAIR_ARMS.has(first as string) && !process.argv.includes("--production"))
    throw new BenchError(
      "TN_BENCH_BAD_FLAG",
      "a web pair runs production builds only: pass --production",
      1,
    );
  const rounds = positiveInteger(flag("rounds"), 3);
  // Both arms print the per-frame thread CPU and present CPU, so the KPI's instrument is the same in each.
  process.env.TN_BENCH_ENGINE_METRICS ??= "1";
  // And the same per-frame phases (game, animation, matrixWorld, projection, render) on the same clock;
  // `TN_BENCH_PHASES=0` runs the pair without them, which is how the telemetry's own overhead is measured.
  process.env.TN_BENCH_PHASES ??= "1";
  const options = ladderOptions();
  const tag =
    flag("tag") ?? `${options.modes.replaceAll(",", "-")}-${options.ladder.replaceAll(",", "-")}`;
  const directory = path.join(artifactRoot, flag("dir") ?? "prd-573");
  await mkdir(directory, { recursive: true });
  const runs = new Map<string, IRunReport[]>([
    [first as string, []],
    [second as string, []],
  ]);
  for (let round = 1; round <= rounds; round += 1) {
    const order = round % 2 === 1 ? [first, second] : [second, first];
    for (const arm of order as string[]) {
      const measured = await runRequestedArm(arm, options);
      if (measured.arm !== arm)
        throw new BenchError(
          "TN_BENCH_ARM_MISMATCH",
          `asked for ${arm}, the run reported ${measured.arm}`,
        );
      // Read after the run, so the load that gets recorded is the load the timed window ran under.
      const report = withHostLoad(measured, readHostLoad());
      scoreboardRows(report);
      const file = path.join(directory, `${tag}-${arm}-r${round}.json`);
      await saveFrames(report, file);
      await writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
      runs.get(arm)?.push(report);
    }
  }
  const labels = [first as string, second as string] as const;
  const left = runs.get(labels[0]) ?? [];
  const right = runs.get(labels[1]) ?? [];
  const verdict = pairVerdict(left, right, labels);
  const pair = { labels, waivers: process.env.TN_BENCH_WAIVE ?? "", ...verdict };
  await writeFile(path.join(directory, `${tag}-pair.json`), `${JSON.stringify(pair, null, 2)}\n`);
  try {
    await writeFile(
      path.join(directory, `${tag}-pair.json`),
      `${JSON.stringify({ ...pair, comparisons: pairRows(left, right, labels) }, null, 2)}\n`,
    );
    const markdown = renderPairMarkdown(
      runs.get(labels[0]) ?? [],
      runs.get(labels[1]) ?? [],
      labels,
    );
    await writeFile(path.join(directory, `${tag}-pair.md`), `${markdown}\n`);
    process.stdout.write(`${markdown}\n`);
  } catch (error) {
    if (error instanceof BenchError)
      await writeFile(
        path.join(directory, `${tag}-pair-PARITY-FAILED.md`),
        `${error.message}\n\n${JSON.stringify(pair.visual, null, 2)}\nWaivers: TN_BENCH_WAIVE=${pair.waivers}\n`,
      );
    throw error;
  }
}

async function runProductComparison(): Promise<void> {
  const left = await loadArm(flag("left") ?? "tn-web");
  const right = await loadArm(flag("right") ?? "godot-web");
  const markdown = renderComparisonMarkdown(compare(left, right));
  const out = flag("doc");
  if (out !== undefined) await writeFile(path.join(repoRoot, out), `${markdown}\n`);
  process.stdout.write(`${markdown}\n`);
}

function printUsage(): void {
  process.stdout.write(
    "usage: pnpm bench:engines --arm <tn-web|tn-engine-web|plain-three-webgpu|godot-web|tn-desktop|tn-engine-desktop|godot-desktop|tn-android|godot-android> [--production] [--required-baseline --lane id] [--lanes path] [--out name] [--skip-baseline] [--allow-emulator] [--source-sha sha --frames N --warmup N --repeats N --ladder a,b --modes L1,L2,R1..R5 --width N --height N] [--geometry shared|unique --material shared|unique --hierarchy-depth N --visible-fraction 0..1 --mutation-rate 0..1 --shadow-caster-share 0..1 --passes N]\n       pnpm bench:engines --pair tn-desktop,tn-engine-desktop [--rounds N --tag name --dir name] (same flags as --arm; fails unless both arms drew the same scene)\n       pnpm bench:engines --pair tn-web,tn-engine-web --production [--allow-software] [--rounds N --tag name --dir name]\n       pnpm bench:engines --compare [--left tn-web --right godot-web] [--doc path.md]\n       pnpm bench:engines --check-report path.json [--required-baseline --lanes path]\n       pnpm bench:engines --regression --input report.json [--lanes path --lane id] [--policy policy.json] [--out summary.json]\n       pnpm bench:engines --regression-collection --target <web|desktop|android|ios> [--device id] [--prebuilt-artifact path] [--out path]\n       pnpm bench:engines --cpu-setup\n       pnpm bench:engines --cpu --source <absolute checkout path> --name <result name>\n       pnpm bench:engines --cpu-compare --baseline <absolute saved-run dir> --candidate <absolute saved-run dir> [--control <name>]\n",
  );
}

async function main(): Promise<void> {
  // The CPU path is dispatched before any hardware parsing so an unknown or conflicting flag
  // fails before a browser, device, or Godot arm is reached.
  const cpu = cpuCommand(process.argv.slice(2));
  if (cpu !== undefined) return runCpuCommand(cpu, process.argv.slice(2));
  await mkdir(artifactRoot, { recursive: true });
  if (process.argv.includes("--regression-collection")) return runRegressionCollectionCommand();
  if (process.argv.includes("--regression")) return runRegressionCommand();
  const checkReport = flag("check-report");
  if (checkReport !== undefined) return runReportCheckCommand(checkReport);
  const arm = flag("arm");
  if (arm !== undefined) return runArmCommand(arm, ladderOptions());
  const pair = flag("pair");
  if (pair !== undefined) return runPairCommand(pair);
  if (process.argv.includes("--compare")) return runProductComparison();
  printUsage();
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode =
    error instanceof BenchError
      ? error.exitCode
      : error &&
          typeof error === "object" &&
          "exitCode" in error &&
          (error.exitCode === 1 || error.exitCode === 2)
        ? error.exitCode
        : 1;
});
