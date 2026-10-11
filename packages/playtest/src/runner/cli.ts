import { toneCommand } from "./tone.js";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PlaytestScenarioError } from "../scenario.js";
import { resolveBuildReport } from "./buildReport.js";
import {
  formatUsage,
  parseStandalonePlaytestArgs,
  PlaytestCliUsageError,
  type IStandalonePlaytestConfig,
} from "./config.js";
import { WEBGPU_BROWSER_ARGS } from "./browser.js";
import { CaptureLockTimeoutError, formatLockTimeoutLine } from "./captureLock.js";
import { diagnoseDevice, diagnoseHarness, formatDoctorReport, readDeviceProbe, readHarnessEnvironment } from "./doctor.js";
import { formatSceneOverview, observeScene, summariseScene } from "./sceneOverview.js";
import { initStandalonePlaytest } from "./init.js";
import { perfCommand } from "./perf.js";
import { formatPipelineSummary, parsePipelineCapture, summarizePipelineCapture, type IPipelineSummary } from "./pipeline-summary.js";
import { runAndroidPlaytest } from "./androidRunner.js";
import { runAndroidBrowserPlaytest, runAndroidBrowserPlaytests } from "./androidBrowserRunner.js";
import { runDesktopPlaytest } from "./desktopRunner.js";
import { runIosPlaytest } from "./iosRunner.js";
import { recordToScenario } from "./recording.js";
import { runStandalonePlaytest, runStandalonePlaytests, type IStandalonePlaytestReport } from "./runner.js";
import { audioCommand } from "./audioRun.js";
import { assertCpuProfileTargetSupported } from "./cpuProfile.js";
import { traceCommand } from "./traceRun.js";
import { safePart } from "./shared.js";

export interface IRunnerDiagnostic {
  code: string;
  fix: { instruction: string };
  message: string;
  severity: "error";
}

export type IConfiguredPlaytestRunner = (
  config: IStandalonePlaytestConfig,
) => Promise<import("./runner.js").IStandalonePlaytestReport>;

export interface IPlaytestTargetRunners {
  android: IConfiguredPlaytestRunner;
  androidBrowser?: IConfiguredPlaytestRunner;
  browser: IConfiguredPlaytestRunner;
  desktop: IConfiguredPlaytestRunner;
  ios: IConfiguredPlaytestRunner;
}

const DEFAULT_TARGET_RUNNERS: IPlaytestTargetRunners = {
  android: runAndroidPlaytest,
  androidBrowser: runAndroidBrowserPlaytest,
  browser: runStandalonePlaytest,
  desktop: runDesktopPlaytest,
  ios: runIosPlaytest,
};

export function runConfiguredPlaytest(
  config: IStandalonePlaytestConfig,
  runners: IPlaytestTargetRunners = DEFAULT_TARGET_RUNNERS,
): Promise<import("./runner.js").IStandalonePlaytestReport> {
  if ((config.target ?? "browser") === "browser" && config.device !== undefined) {
    return (runners.androidBrowser ?? runAndroidBrowserPlaytest)(config);
  }
  return runners[config.target ?? "browser"](config);
}

export function exitCodeForReport(report: {
  assertionResults?: readonly unknown[];
  diagnostics?: ReadonlyArray<{ code?: string }>;
  pass: boolean;
}): 0 | 1 | 2 {
  if (report.pass) return 0;
  if (report.diagnostics?.some(({ code }) => code === "TN_PLAYTEST_FRAMEBUFFER_WINDOW_NOT_REACHED")) return 2;
  if (report.assertionResults === undefined || report.assertionResults.every(isUnobservedDiagnosticsAssertion)) return 2;
  return 1;
}

function isUnobservedDiagnosticsAssertion(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const assertion = value as { details?: unknown; id?: unknown };
  if (assertion.id !== "diagnostics" || typeof assertion.details !== "object" || assertion.details === null) return false;
  return (assertion.details as { reason?: unknown }).reason === "not-evaluated";
}

export function classifyRunnerError(
  error: unknown,
  options: { cwd?: string; scenarioPath?: string } = {},
): IRunnerDiagnostic {
  if (error instanceof PlaytestCliUsageError) {
    return diagnostic("TN_PLAYTEST_CLI_USAGE", error.message, "Run threenative-playtest --help.");
  }
  if (error instanceof PlaytestScenarioError) {
    if (error.diagnostic.code === "TN_PLAYTEST_SCENARIO_NOT_FOUND") {
      return scenarioUnreadable(error.message, options);
    }
    return {
      code: error.diagnostic.code,
      fix: { instruction: error.diagnostic.fix?.instruction ?? error.diagnostic.suggestion ?? "Fix the scenario and rerun the playtest." },
      message: error.diagnostic.message,
      severity: error.diagnostic.severity,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE:")) {
    return diagnostic(
      "TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE",
      message,
      "Check DISPLAY and its session credentials, and install xdpyinfo to verify the requested host display before rerunning.",
    );
  }
  if (message.startsWith("TN_PLAYTEST_BUILD_REPORT_STALE")) {
    return diagnostic(
      "TN_PLAYTEST_BUILD_REPORT_STALE",
      message,
      "Rebuild the artifact, or point --build-report at the build this run is exercising; a budget measured on other bytes bounds nothing.",
    );
  }
  if (message.startsWith("TN_PLAYTEST_BUILD_REPORT_INVALID")) {
    return diagnostic(
      "TN_PLAYTEST_BUILD_REPORT_INVALID",
      message,
      "Regenerate the report with `threenative build`; a hand-edited or foreign report cannot be adopted.",
    );
  }
  if (message.startsWith("TN_PLAYTEST_DEVICE_FAILED")) {
    return diagnostic(
      "TN_PLAYTEST_DEVICE_FAILED",
      message,
      "Confirm adb can reach the requested serial and Android Chrome exposes its CDP socket, then rerun.",
    );
  }
  if (message.startsWith("TN_PLAYTEST_CPU_PROFILE_WRITE_FAILED")) {
    return diagnostic(
      "TN_PLAYTEST_CPU_PROFILE_WRITE_FAILED",
      message,
      "Point --cpu-prof at a writable path; the run is not green without the profile it was asked for.",
    );
  }
  if (message.startsWith("TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED")) {
    return diagnostic(
      "TN_PLAYTEST_CPU_PROFILE_UNSUPPORTED",
      message,
      "Run --cpu-prof on the browser or desktop target, where the profile can be produced.",
    );
  }
  if (message.startsWith("browserType.launch")) {
    return diagnostic(
      "TN_PLAYTEST_BROWSER_UNAVAILABLE",
      message,
      "Install or repair Chromium; under a headless Linux session run via sh scripts/xvfb.sh.",
    );
  }
  if (message.startsWith("page.goto")) {
    return diagnostic(
      "TN_PLAYTEST_PAGE_UNREACHABLE",
      message,
      "Start the app at --url by hand and confirm it answers.",
    );
  }
  if (message.includes("ENOENT") || /Playtest scenario .*could not be read/u.test(message)) {
    return scenarioUnreadable(message, options);
  }
  return diagnostic(
    "TN_PLAYTEST_RUNNER_FAILED",
    message,
    "Unexpected runner error; inspect this message and rerun the command.",
  );
}

/**
 * `doctor` answers "can this machine run a playtest", `doctor --url` additionally answers "and
 * what is actually in the game running there" — the question asked while staring at a screenshot
 * that looks wrong — and `doctor --device` answers "is the phone cool enough to measure on",
 * which `observations.deviceMetrics` can only answer once the run is already spent.
 */
export interface IDoctorArgs {
  readonly browserArgs: readonly string[];
  readonly capture?: string;
  readonly device: string | undefined;
  readonly text: boolean;
  readonly url: string | undefined;
}

export function parseDoctorArgs(argv: readonly string[]): IDoctorArgs {
  const browserArgs: string[] = [];
  let capture: string | undefined;
  let device: string | undefined;
  let text = false;
  let url: string | undefined;
  // Fail closed, like the run and perf paths: doctor is the surface that gates device spend,
  // and a typo'd or dangling flag used to run machine-only checks and report success-ish.
  const usage = "Run threenative-playtest doctor --help.";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--text") text = true;
    else if (flag === "--capture" || flag === "--device" || flag === "--url") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new PlaytestCliUsageError(`doctor: '${String(flag)}' requires a value. ${usage}`);
      }
      if (flag === "--capture") capture = value;
      else if (flag === "--device") device = value;
      else url = value;
      index += 1;
    } else if (flag === "--browser-arg") {
      // A browser argument may itself start with '--', so only a missing value is an error.
      const value = argv[index + 1];
      if (value === undefined) {
        throw new PlaytestCliUsageError(`doctor: '--browser-arg' requires a value. ${usage}`);
      }
      browserArgs.push(value);
      index += 1;
    } else {
      throw new PlaytestCliUsageError(`doctor: unknown option '${String(flag)}'. ${usage}`);
    }
  }
  return { browserArgs, device, text, url, ...(capture === undefined ? {} : { capture }) };
}

/** Extra arguments extend the WebGPU recipe; replacing it would silently reintroduce SwiftShader. */
export function doctorBrowserArgs(extra: readonly string[]): string[] {
  return [...WEBGPU_BROWSER_ARGS, ...extra];
}

export async function doctorCommand(argv: readonly string[]): Promise<number> {
  const { browserArgs, capture, device, text, url } = parseDoctorArgs(argv);
  const machine = diagnoseHarness(readHarnessEnvironment());
  // The device's own condition is reported next to the machine's, as one report: an operator
  // deciding whether to start a measurement asks both questions at the same moment.
  const deviceReport = device === undefined
    ? undefined
    : await diagnoseDevice(device, readDeviceProbe(device));
  const report = deviceReport === undefined
    ? machine
    : {
        checks: [...machine.checks, ...deviceReport.checks],
        pass: machine.pass && deviceReport.pass,
      };
  let pipeline: IPipelineSummary | undefined;
  if (capture !== undefined) {
    try {
      const source = await readFile(resolve(capture), "utf8");
      pipeline = summarizePipelineCapture(parsePipelineCapture(source));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = message.startsWith("TN_PIPELINE_CAPTURE_MALFORMED")
        ? "TN_PIPELINE_CAPTURE_MALFORMED"
        : "TN_PIPELINE_CAPTURE_UNREADABLE";
      process.stderr.write(`${JSON.stringify({ diagnostics: [{ code, message, severity: "error" }], pass: false }, null, 2)}\n`);
      process.exitCode = 2;
      return 2;
    }
  }
  let pass = report.pass && (pipeline?.complete ?? true);
  const textReport = () => [
    formatDoctorReport(report),
    ...(pipeline === undefined ? [] : [formatPipelineSummary(pipeline)]),
  ].join("\n");
  const jsonReport = (scene?: unknown): string => `${JSON.stringify({
    machine: report,
    ...(scene === undefined ? {} : { scene }),
    ...(pipeline === undefined ? {} : { pipeline }),
    pass,
  }, null, 2)}\n`;
  if (url === undefined) {
    process.stdout.write(text ? textReport() : capture === undefined ? `${JSON.stringify(report, null, 2)}\n` : jsonReport());
    process.exitCode = pass ? 0 : 1;
    return pass ? 0 : 1;
  }
  if (!report.pass) {
    // Reaching a scene needs the browser the machine checks just said is missing.
    process.stdout.write(text ? textReport() : jsonReport());
    process.exitCode = 1;
    return 1;
  }
  const overview = summariseScene(await observeScene(url, { browserArgs: doctorBrowserArgs(browserArgs) }));
  const warmupStatus = overview.startup?.warmup?.status;
  if (warmupStatus !== undefined && warmupStatus !== "complete") pass = false;
  process.stdout.write(
    text
      ? `${textReport()}\n${formatSceneOverview(overview)}`
      : jsonReport(overview),
  );
  process.exitCode = pass ? 0 : 1;
  return pass ? 0 : 1;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let config: IStandalonePlaytestConfig | undefined;
  try {
    if (argv.includes("--help")) {
      process.stdout.write(formatUsage());
      return 0;
    }
    if (argv[0] === "doctor") return await doctorCommand(argv.slice(1));
    if (argv[0] === "perf") return await perfCommand(argv.slice(1));
    if (argv[0] === "trace") return await traceCommand(argv.slice(1));
    if (argv[0] === "tone") return await toneCommand(argv.slice(1));
    if (argv[0] === "audio") return await audioCommand(argv.slice(1));
    if (argv[0] === "init") {
      const result = await initStandalonePlaytest(process.cwd());
      process.stdout.write(`${JSON.stringify({ ...result, pass: true }, null, 2)}\n`);
      return 0;
    }
    if (argv[0] === "record-to-scenario") {
      return await recordToScenarioCommand(argv.slice(1));
    }
    // Before anything launches: a report that is malformed, aimed at another target, or describing
    // bytes that are no longer on disk has not measured this run, so it is exit 2 and not a verdict.
    config = await resolveBuildReport(parseStandalonePlaytestArgs(argv));
    assertCpuProfileTargetSupported(config.target ?? "browser", config.cpuProfilePath);
    const scenarioPaths = config.scenarioPaths ?? [config.scenarioPath];
    const reports = config.target === "browser"
      ? config.device === undefined
        ? await runStandalonePlaytests(config)
        : await runAndroidBrowserPlaytests(config)
      : await runDevicePlaytests(config, scenarioPaths);
    const output = reports.length === 1
      ? reports[0]
      : { pass: reports.every(({ pass }) => pass), reports };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    const exitCode = reports.reduce<0 | 1 | 2>((worst, report) => {
      const code = exitCodeForReport(report);
      return code > worst ? code : worst;
    }, 0);
    process.exitCode = exitCode;
    return exitCode;
  } catch (error) {
    // A capture-lock timeout is the queue saying "wait", not the game saying "broken" — it
    // must never be classified as a runner failure or an assertion failure.
    if (error instanceof CaptureLockTimeoutError) {
      process.stderr.write(`${formatLockTimeoutLine(error)}\n`);
      process.exitCode = 75;
      return 75;
    }
    const diagnostic = classifyRunnerError(error, {
      cwd: config?.projectPath,
      scenarioPath: config?.scenarioPath,
    });
    process.stderr.write(`${JSON.stringify({ diagnostics: [diagnostic], pass: false }, null, 2)}\n`);
    process.exitCode = 2;
    return 2;
  }
}

async function runDevicePlaytests(
  config: IStandalonePlaytestConfig,
  scenarioPaths: readonly string[],
): Promise<readonly IStandalonePlaytestReport[]> {
  const runner = config.target === "android"
    ? runAndroidPlaytest
    : config.target === "desktop"
      ? runDesktopPlaytest
      : runIosPlaytest;
  const reports: IStandalonePlaytestReport[] = [];
  for (const [index, scenarioPath] of scenarioPaths.entries()) {
    const artifactDirectory = scenarioPaths.length === 1
      ? config.artifactDirectory
      : join(config.artifactDirectory, `${String(index + 1).padStart(2, "0")}-${safePart(scenarioPath)}`);
    reports.push(await runner({
      ...config,
      artifactDirectory,
      scenarioPath,
      scenarioPaths: undefined,
    }));
  }
  return reports;
}

async function recordToScenarioCommand(argv: readonly string[]): Promise<number> {
  const inputPath = argv[0];
  const withOracle =
    argv.length === 5 && argv[1] === "--oracle" && argv[3] === "--out";
  const oraclePath = withOracle ? argv[2] : undefined;
  const outputPath = withOracle ? argv[4] : undefined;
  if (inputPath === undefined || oraclePath === undefined || outputPath === undefined) {
    throw new PlaytestCliUsageError(
      "Usage: threenative-playtest record-to-scenario recording.json --oracle oracle.json --out bug.playtest.json",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(inputPath), "utf8"));
  } catch (error) {
    throw new PlaytestCliUsageError(
      `Could not read recording '${inputPath}' as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let oracle: unknown;
  try {
    oracle = JSON.parse(await readFile(resolve(oraclePath), "utf8"));
  } catch (error) {
    throw new PlaytestCliUsageError(
      `Could not read recording oracle '${oraclePath}' as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const scenario = recordToScenario(parsed, inputPath, oracle);
  const absoluteOutput = resolve(outputPath);
  await mkdir(dirname(absoluteOutput), { recursive: true });
  await writeFile(absoluteOutput, `${JSON.stringify(scenario, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ output: absoluteOutput, pass: true }, null, 2)}\n`);
  return 0;
}

function diagnostic(code: string, message: string, instruction: string): IRunnerDiagnostic {
  return { code, fix: { instruction }, message, severity: "error" };
}

function scenarioUnreadable(
  message: string,
  options: { cwd?: string; scenarioPath?: string },
): IRunnerDiagnostic {
  const cwd = options.cwd ?? process.cwd();
  const candidate = options.scenarioPath
    ?? /Playtest scenario ['"]([^'"]+)['"]/u.exec(message)?.[1]
    ?? /(?:open|read) ['"]([^'"]+)['"]/u.exec(message)?.[1];
  const path = candidate === undefined ? undefined : resolve(cwd, candidate);
  const printedPath = path ?? "the requested scenario path";
  return diagnostic(
    "TN_PLAYTEST_SCENARIO_UNREADABLE",
    `${message} Resolved absolute path: ${printedPath}.`,
    `Check the resolved absolute scenario path: ${printedPath}.`,
  );
}

const entryPath = process.argv[1];
/**
 * Wait for stdout to reach the far end before exiting, bounded.
 *
 * Returns true when the stream drained, false when the deadline passed with bytes still pending —
 * the caller exits either way, because a stalled reader must not outrank the exit.
 */
export interface IDrainableStream {
  readonly writableLength: number;
  write(chunk: string, callback: () => void): unknown;
}

export async function flushStdout(
  timeoutMs = 5_000,
  stream: IDrainableStream = process.stdout,
): Promise<boolean> {
  if (stream.writableLength === 0) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    stream.write("", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

if (
  entryPath !== undefined
  && existsSync(entryPath)
  && realpathSync(resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  const code = await main();
  // Exit explicitly rather than waiting for the event loop to drain. A browser that refused to
  // close leaves handles open, and one run that never returns stalls a whole `&&` chain with no
  // error to read.
  //
  // "The report is already written by this point" was the original claim here, and it is only
  // true when stdout is a TTY or a file, where POSIX writes are synchronous. On a pipe — which is
  // what every caller capturing this CLI gets — writes are asynchronous, and `process.exit`
  // discards whatever has not flushed. The iOS lane read exactly 8193 bytes of its report, cut
  // mid-object, while the process still exited 0: its verifier then looked for `"pass": true` in
  // JSON that stopped short of the field. Drain first, bounded so a stuck stream cannot restore
  // the hang this exit exists to prevent.
  await flushStdout();
  process.exit(code);
}
