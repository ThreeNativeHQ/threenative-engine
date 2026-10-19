// Opt-in CPU microbenchmark path for `pnpm bench:engines`. The measured work runs in an isolated
// installation of the pinned @pmndrs/labs CLI; this module only validates the request, launches
// that installed executable with a controlled working directory, and records the raw result. It
// never imports Labs and never runs on the ordinary hardware path.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BenchError } from "../engine-load-test/report.js";
import {
  CPU_COMPARISON_DISCLAIMER,
  CPU_DOMAIN,
  type ICpuCaptureManifest,
  type ICpuComparisonUpstream,
  assertCompatibleCpuCaptures,
  assertSourceUnchanged,
  buildCpuCaptureManifest,
  collectCpuCaseObservations,
  collectCpuEffectiveTuning,
  collectCpuSourceIdentity,
  collectCpuWorkerIdentity,
  collectCpuWorkloadIdentity,
  emitCpuComparisonReport,
  readCpuCaptureManifest,
  sha256File,
  writeCpuCaptureManifest,
} from "./cpu-report.js";
import { LOOP_CASES, LOOP_FRAMES } from "./labs/workloads/loop-workload.js";
import { STATE_CASES, STATE_WRITES } from "./labs/workloads/state-workload.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LABS_TOOL_DIR = path.join(repoRoot, "scripts/performance-regression/labs");
const CPU_ARTIFACT_ROOT = path.join(repoRoot, "artifacts/engine-load-test/cpu");
export const LABS_PACKAGE = "@pmndrs/labs";
export const LABS_NODE_FLOOR = "22.12.0";
export const CPU_CAPTURE_BUDGET_MS = 300_000;
const WORKSPACE_FILE = path.join(repoRoot, "pnpm-workspace.yaml");
const LABS_BIN = path.join(LABS_TOOL_DIR, "node_modules", LABS_PACKAGE, "dist/cli/cli.mjs");
const RESULT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const CHILD_OUTPUT_LIMIT = 32 * 1024 * 1024;
// Labs runs each worker with a synchronous `execFileSync` and inherits stdio, so the worker and
// any grandchild share the direct child's process group. Terminating that group is the only way to
// stop the tree; a timeout on the parent alone orphans a running worker.
const TERM_GRACE_MS = 2_000;
const KILL_GRACE_MS = 1_000;
const GROUP_POLL_MS = 25;

export type CpuCommand = "setup" | "capture" | "compare";

const DEFAULT_LABS_BLOCKS = 8;

export interface ICpuCaptureOptions {
  readonly name: string;
  readonly source: string;
}

export interface ICpuCaptureResult {
  readonly labsVersion: string;
  readonly resultFile: string;
  readonly runDirectory: string;
}

export interface ICpuCompareOptions {
  readonly baseline: string;
  readonly candidate: string;
  readonly control?: string;
}

export interface ICpuCompareArtifacts {
  readonly html: string;
  readonly stderr: string;
  readonly stdout: string;
  readonly text: string;
}

export interface ICpuCompareResult {
  readonly artifacts: ICpuCompareArtifacts;
  readonly runDirectory: string;
  readonly upstreamExit: number;
}

const CPU_MODE_FLAGS: readonly { readonly flag: string; readonly mode: CpuCommand }[] = [
  { flag: "--cpu-setup", mode: "setup" },
  { flag: "--cpu", mode: "capture" },
  { flag: "--cpu-compare", mode: "compare" },
];

/** Which CPU subcommand an argv selects, or undefined for every existing hardware path. */
export function cpuCommand(argv: readonly string[]): CpuCommand | undefined {
  const present: CpuCommand[] = [];
  for (const { flag, mode } of CPU_MODE_FLAGS) {
    const count = argv.filter((arg) => arg === flag).length;
    if (count > 1) {
      throw new BenchError("TN_CPU_BENCH_DUPLICATE_MODE", `${flag} may appear only once`, 2);
    }
    if (count === 1) present.push(mode);
  }
  if (present.length > 1) {
    throw new BenchError("TN_CPU_BENCH_CONFLICT", "CPU mode flags are mutually exclusive", 2);
  }
  return present[0];
}

/** The Node executable used to run Labs. Defaults to the current process. */
export function labsNodeExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TN_CPU_BENCH_NODE;
  return configured !== undefined && configured.length > 0 ? configured : process.execPath;
}

/**
 * The wall-clock budget for one capture. `TN_CPU_BENCH_TIMEOUT_MS` narrows it for tests; it can
 * never raise it past the design limit, and a non-integer or non-positive override fails closed.
 */
export function captureTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.TN_CPU_BENCH_TIMEOUT_MS;
  if (raw === undefined) return CPU_CAPTURE_BUDGET_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > CPU_CAPTURE_BUDGET_MS) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_TIMEOUT",
      `TN_CPU_BENCH_TIMEOUT_MS must be a positive integer no greater than ${CPU_CAPTURE_BUDGET_MS}, got '${raw}'`,
      2,
    );
  }
  return parsed;
}

// A benchmark worker runs trusted local source, but that source is arbitrary Node execution: it
// can read whatever environment it inherits. Passing the wrapper's whole environment would hand it
// registry tokens, cloud credentials and Node preload hooks it never needs. The allowlist is the
// runtime basics Node needs to start and resolve modules, plus the explicit CPU knobs. It is not a
// sandbox: it limits the ambient secrets, not what the benchmark code may do.
const CHILD_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SYSTEMROOT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
] as const;

const CHILD_CPU_KNOB_KEYS = [
  "TN_CPU_BENCH_BENCH_DIR",
  "TN_CPU_BENCH_BLOCK_TIME",
  "TN_CPU_BENCH_BLOCKS",
  "TN_CPU_BENCH_MIN_SAMPLES",
  "TN_CPU_BENCH_RESULTS_DIR",
  "TN_CPU_BENCH_SOURCE",
] as const;

/** The environment a benchmark child may see: runtime basics and explicit CPU knobs only. */
export function labsChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...CHILD_ENV_KEYS, ...CHILD_CPU_KNOB_KEYS]) {
    const value = base[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...overrides };
}

/** Fail closed when a Node executable is below the version Labs requires. */
export function assertLabsNode(version: string): void {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  const floor = LABS_NODE_FLOOR.split(".").map(Number);
  const floorMajor = floor[0] ?? 0;
  const floorMinor = floor[1] ?? 0;
  if (
    major === undefined ||
    minor === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor) ||
    major < floorMajor ||
    (major === floorMajor && minor < floorMinor)
  ) {
    throw new BenchError(
      "TN_CPU_BENCH_NODE_UNSUPPORTED",
      `${LABS_PACKAGE} requires Node >= ${LABS_NODE_FLOOR}, got ${version}; set TN_CPU_BENCH_NODE to a compatible executable`,
      2,
    );
  }
}

/** The exact pin from the generated isolated tool manifest, which owns the installed version. */
export async function readToolManifestPin(toolDir: string = LABS_TOOL_DIR): Promise<string> {
  const file = path.join(toolDir, "package.json");
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(await readFile(file, "utf8")) as typeof manifest;
  } catch (error) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_MANIFEST",
      `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
  const pin = manifest.dependencies?.[LABS_PACKAGE];
  if (pin === undefined || !/^\d+\.\d+\.\d+$/.test(pin)) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_PIN",
      `${LABS_PACKAGE} must be pinned to an exact version in ${file}`,
      2,
    );
  }
  return pin;
}

/** The catalog value in the root workspace file, the version authority for the generated pin. */
export function parseCatalogPin(workspaceText: string): string | undefined {
  const match = workspaceText.match(/^\s*'?@pmndrs\/labs'?:\s*(\S+)\s*$/mu);
  return match?.[1];
}

async function assertCatalogPin(pin: string): Promise<void> {
  const catalog = parseCatalogPin(await readFile(WORKSPACE_FILE, "utf8"));
  if (catalog !== pin) {
    throw new BenchError(
      "TN_CPU_BENCH_CATALOG_DRIFT",
      `pnpm-workspace.yaml catalog pins ${LABS_PACKAGE} ${catalog ?? "<missing>"}, but the tool manifest pins ${pin}`,
      2,
    );
  }
}

/** Verify the installed artifact matches the pin and exposes the `labs` executable. */
export async function assertInstalledLabs(toolDir: string = LABS_TOOL_DIR): Promise<string> {
  const pin = await readToolManifestPin(toolDir);
  const packageFile = path.join(toolDir, "node_modules", LABS_PACKAGE, "package.json");
  if (!existsSync(packageFile)) {
    throw new BenchError(
      "TN_CPU_BENCH_NOT_INSTALLED",
      `the isolated ${LABS_PACKAGE} profile is not installed; run 'pnpm bench:engines --cpu-setup'`,
      2,
    );
  }
  const installed = JSON.parse(await readFile(packageFile, "utf8")) as {
    bin?: Record<string, string>;
    version?: string;
  };
  if (installed.version !== pin) {
    throw new BenchError(
      "TN_CPU_BENCH_VERSION_MISMATCH",
      `installed ${LABS_PACKAGE}@${installed.version ?? "<unknown>"} does not match the pinned ${pin}; rerun 'pnpm bench:engines --cpu-setup'`,
      2,
    );
  }
  const bin = path.join(toolDir, "node_modules", LABS_PACKAGE, installed.bin?.labs ?? "");
  if (installed.bin?.labs === undefined || !existsSync(bin)) {
    throw new BenchError(
      "TN_CPU_BENCH_MISSING_BIN",
      `${LABS_PACKAGE}@${pin} does not expose the 'labs' executable; reinstall with 'pnpm bench:engines --cpu-setup'`,
      2,
    );
  }
  return pin;
}

async function labsNodeVersion(executable: string): Promise<string> {
  if (path.resolve(executable) === path.resolve(process.execPath)) return process.versions.node;
  try {
    // The probe must not inherit credentials or preload hooks any more than the benchmark may.
    const { stdout } = await execFileAsync(executable, ["--version"], {
      env: labsChildEnv(),
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim().replace(/^v/, "");
  } catch (error) {
    throw new BenchError(
      "TN_CPU_BENCH_NODE_UNSUPPORTED",
      `could not run '${executable} --version': ${error instanceof Error ? error.message : String(error)}`,
      2,
    );
  }
}

function assertSourcePath(source: string): void {
  if (!path.isAbsolute(source)) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_SOURCE",
      `--source must be an absolute checkout path, got '${source}'`,
      2,
    );
  }
  let directory = false;
  try {
    directory = statSync(source).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    throw new BenchError("TN_CPU_BENCH_BAD_SOURCE", `--source '${source}' is not a directory`, 2);
  }
}

function assertResultName(name: string): void {
  if (!RESULT_NAME.test(name)) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_NAME",
      `--name must match [A-Za-z0-9][A-Za-z0-9._-]*, got '${name}'`,
      2,
    );
  }
}

/**
 * Parse and validate a setup request. Setup owns no flags, so any extra token — including another
 * CPU mode or a hardware flag — fails before an install runs.
 */
export function parseCpuSetupArgs(argv: readonly string[]): void {
  for (const arg of argv) {
    if (arg === "--cpu-setup") continue;
    if (arg.startsWith("--")) {
      throw new BenchError(
        "TN_CPU_BENCH_UNKNOWN_FLAG",
        `unknown setup flag '${arg}'; --cpu-setup accepts no other flag`,
        2,
      );
    }
    throw new BenchError("TN_CPU_BENCH_UNEXPECTED_ARG", `unexpected argument '${arg}'`, 2);
  }
}

/** Record a flag once; a repeated flag is a duplicate, never a silent last-wins. */
function setOnce(values: Map<string, string>, flag: string, value: string): void {
  if (values.has(flag)) {
    throw new BenchError("TN_CPU_BENCH_DUPLICATE_FLAG", `${flag} may appear only once`, 2);
  }
  values.set(flag, value);
}

/** Parse and validate a capture request. Every unknown, duplicate or missing value fails before a workload. */
export function parseCpuCaptureArgs(argv: readonly string[]): ICpuCaptureOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--cpu") {
      setOnce(values, "--cpu", "");
      continue;
    }
    if (arg === "--source" || arg === "--name") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new BenchError("TN_CPU_BENCH_MISSING_VALUE", `${arg} requires a value`, 2);
      }
      setOnce(values, arg, value);
      index++;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new BenchError(
        "TN_CPU_BENCH_UNKNOWN_FLAG",
        `unknown CPU flag '${arg}'; --cpu accepts only --source and --name`,
        2,
      );
    }
    throw new BenchError("TN_CPU_BENCH_UNEXPECTED_ARG", `unexpected argument '${arg}'`, 2);
  }
  const source = values.get("--source");
  if (source === undefined) {
    throw new BenchError(
      "TN_CPU_BENCH_SOURCE_REQUIRED",
      "--cpu requires --source <absolute checkout path>",
      2,
    );
  }
  const name = values.get("--name");
  if (name === undefined) {
    throw new BenchError("TN_CPU_BENCH_NAME_REQUIRED", "--cpu requires --name <result name>", 2);
  }
  assertSourcePath(source);
  assertResultName(name);
  return { name, source };
}

/** Parse and validate a compare request. Missing/relative run directories fail before any action. */
export function parseCpuCompareArgs(argv: readonly string[]): ICpuCompareOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    if (arg === "--cpu-compare") {
      setOnce(values, "--cpu-compare", "");
      continue;
    }
    if (arg === "--baseline" || arg === "--candidate" || arg === "--control") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new BenchError("TN_CPU_BENCH_MISSING_VALUE", `${arg} requires a value`, 2);
      }
      setOnce(values, arg, value);
      index++;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new BenchError(
        "TN_CPU_BENCH_UNKNOWN_FLAG",
        `unknown CPU flag '${arg}'; --cpu-compare accepts only --baseline, --candidate and --control`,
        2,
      );
    }
    throw new BenchError("TN_CPU_BENCH_UNEXPECTED_ARG", `unexpected argument '${arg}'`, 2);
  }
  const baseline = values.get("--baseline");
  if (baseline === undefined) {
    throw new BenchError(
      "TN_CPU_BENCH_BASELINE_REQUIRED",
      "--cpu-compare requires --baseline <absolute saved-run directory>",
      2,
    );
  }
  const candidate = values.get("--candidate");
  if (candidate === undefined) {
    throw new BenchError(
      "TN_CPU_BENCH_CANDIDATE_REQUIRED",
      "--cpu-compare requires --candidate <absolute saved-run directory>",
      2,
    );
  }
  assertRunDirectory(baseline, "--baseline");
  assertRunDirectory(candidate, "--candidate");
  const control = values.get("--control");
  return control === undefined ? { baseline, candidate } : { baseline, candidate, control };
}

/** A saved CPU run directory must be an absolute, existing directory before it is read. */
function assertRunDirectory(value: string, flag: string): void {
  if (!path.isAbsolute(value)) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_RUN",
      `${flag} must be an absolute saved-run directory, got '${value}'`,
      2,
    );
  }
  let directory = false;
  try {
    directory = statSync(value).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    throw new BenchError("TN_CPU_BENCH_BAD_RUN", `${flag} '${value}' is not a directory`, 2);
  }
}

/** The effective block count: the explicit knob must be a positive integer, else Labs' default. */
function effectiveBlocks(env: NodeJS.ProcessEnv): number {
  const raw = env.TN_CPU_BENCH_BLOCKS;
  if (raw === undefined) return DEFAULT_LABS_BLOCKS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BenchError(
      "TN_CPU_BENCH_BAD_BLOCKS",
      `TN_CPU_BENCH_BLOCKS must be a positive integer, got '${raw}'`,
      2,
    );
  }
  return parsed;
}

function messageOf(error: unknown): string {
  if (typeof error === "object" && error !== null && "stderr" in error) {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim().length > 0) return stderr.trim();
  }
  return error instanceof Error ? error.message : String(error);
}

export interface IBoundedProcessOptions {
  readonly allowNonZeroExit?: boolean;
  readonly args: readonly string[];
  readonly command: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

export interface IBoundedProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Reject CPU execution where no POSIX process group can be addressed. Only Linux is tested. */
export function assertSupportedPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform !== "win32") return;
  throw new BenchError(
    "TN_CPU_BENCH_UNSUPPORTED_PLATFORM",
    `CPU benchmarks need an addressable POSIX process group, which ${platform} does not provide; only Linux is supported and tested`,
    2,
  );
}

/** Signal the child's whole POSIX process group. Windows is rejected before any spawn. */
function signalTree(child: ChildProcess, signal: "SIGKILL" | "SIGTERM"): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group may already be gone, or the direct child never became its leader; fall back to it.
    child.kill(signal);
  }
}

/**
 * True while any member of the child's process group is still alive. A permission error means the
 * group exists but is not signalable here, so it counts as alive; only ESRCH means gone.
 */
function treeAlive(child: ChildProcess): boolean {
  if (child.pid === undefined) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function waitForTreeGone(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = (): void => {
      if (!treeAlive(child)) {
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        resolve(false);
        return;
      }
      setTimeout(check, GROUP_POLL_MS);
    };
    check();
  });
}

interface ICaptureFailureInput {
  readonly cancelled: boolean;
  readonly command: string;
  readonly exitCode: number | null;
  readonly spawnError: Error | undefined;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}

/** A short phrase naming why a capture ended, used when its worker tree cannot be confirmed gone. */
function cleanupReason(input: {
  cancelled: boolean;
  exitCode: number | null;
  spawnError: Error | undefined;
  timedOut: boolean;
}): string {
  if (input.timedOut) return "the capture timed out";
  if (input.cancelled) return "the capture was cancelled";
  if (input.spawnError !== undefined)
    return `the command could not launch: ${input.spawnError.message}`;
  if (input.exitCode !== null && input.exitCode !== 0)
    return `the capture exited with code ${input.exitCode}`;
  return "the capture ended";
}

/** The named failure a finished child represents, or undefined for a clean exit. */
function captureFailure(input: ICaptureFailureInput): BenchError | undefined {
  if (input.spawnError !== undefined) {
    return new BenchError(
      "TN_CPU_BENCH_SPAWN_FAILED",
      `could not launch ${input.command}: ${input.spawnError.message}`,
      2,
    );
  }
  if (input.timedOut) {
    return new BenchError(
      "TN_CPU_BENCH_TIMEOUT",
      `CPU capture exceeded ${input.timeoutMs / 1000}s; the worker tree was terminated`,
      2,
    );
  }
  if (input.cancelled) {
    return new BenchError(
      "TN_CPU_BENCH_CANCELLED",
      "CPU capture was cancelled; the worker tree was terminated",
      2,
    );
  }
  if (input.exitCode !== 0) {
    return new BenchError(
      "TN_CPU_BENCH_RUN_FAILED",
      `labs capture failed: ${input.stderr.trim() || `exit code ${input.exitCode ?? 1}`}`,
      2,
    );
  }
  return undefined;
}

/** Attach the child's captured output to a failure so the caller can retain diagnostics. */
function withCaptureOutput(error: BenchError, stdout: string, stderr: string): BenchError {
  return Object.assign(error, { stderr, stdout });
}

/**
 * Run a command as its own POSIX process group and bound it: a fixed timeout, an optional abort
 * signal, capped output, and a TERM→KILL escalation that reaps descendants even when the direct
 * child exits first. Exit starts that escalation, but the promise settles only after the child's
 * stdio has closed, so trailing output survives. A tree that outlives SIGKILL rejects with a named
 * cleanup error rather than a completed result. Only Linux is tested; Windows is rejected before
 * spawn because it exposes no addressable process group.
 */
export function runBoundedProcess(
  options: IBoundedProcessOptions,
  signal?: AbortSignal,
): Promise<IBoundedProcessResult> {
  return new Promise<IBoundedProcessResult>((resolve, reject) => {
    assertSupportedPlatform();
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...options.args], {
        cwd: options.cwd,
        detached: true,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(
        new BenchError(
          "TN_CPU_BENCH_SPAWN_FAILED",
          `could not launch ${options.command}: ${error instanceof Error ? error.message : String(error)}`,
          2,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let cancelled = false;
    let timedOut = false;
    let settling = false;
    let spawnError: Error | undefined;
    let stdioClosed = false;
    let drainExpired = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;

    // Reap the whole group with TERM→KILL escalation, at most once, and report whether it is gone.
    let cleanup: Promise<boolean> | undefined;
    const cleanupTree = (): Promise<boolean> => {
      cleanup ??= (async (): Promise<boolean> => {
        if (!treeAlive(child)) return true;
        signalTree(child, "SIGTERM");
        if (await waitForTreeGone(child, TERM_GRACE_MS)) return true;
        signalTree(child, "SIGKILL");
        return waitForTreeGone(child, KILL_GRACE_MS);
      })();
      return cleanup;
    };

    // Settle only after cleanup, and only once stdio has closed so no buffered output is dropped.
    const settle = async (): Promise<void> => {
      if (settling) return;
      settling = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal?.removeEventListener("abort", onAbort);
      const treeGone = await cleanupTree();
      if (!treeGone || drainExpired) {
        const reason = cleanupReason({ cancelled, exitCode: child.exitCode, spawnError, timedOut });
        reject(
          withCaptureOutput(
            new BenchError(
              "TN_CPU_BENCH_CLEANUP_FAILED",
              `could not confirm CPU worker cleanup and output closure after ${reason}; the capture is incomplete and descendant processes may remain`,
              2,
            ),
            stdout,
            stderr,
          ),
        );
        return;
      }
      if (outputExceeded) {
        reject(
          withCaptureOutput(
            new BenchError(
              "TN_CPU_BENCH_OUTPUT_LIMIT",
              "CPU worker output exceeded 32 MiB; retained diagnostics are incomplete",
              2,
            ),
            stdout,
            stderr,
          ),
        );
        return;
      }
      // Advisory callers (an explicit comparison) keep a nonzero upstream exit as data; capture and
      // setup keep failing closed on any nonzero exit.
      if (
        options.allowNonZeroExit === true &&
        !cancelled &&
        !timedOut &&
        spawnError === undefined &&
        child.exitCode !== null &&
        child.exitCode !== 0
      ) {
        resolve({ exitCode: child.exitCode, stderr, stdout });
        return;
      }
      const failure = captureFailure({
        cancelled,
        command: options.command,
        exitCode: child.exitCode,
        spawnError,
        stderr,
        timedOut,
        timeoutMs: options.timeoutMs,
      });
      if (failure !== undefined) {
        reject(withCaptureOutput(failure, stdout, stderr));
        return;
      }
      resolve({ exitCode: child.exitCode ?? 0, stderr, stdout });
    };

    // A descendant outside the group can retain a pipe after the direct child exits. Bound the
    // drain too: retain available diagnostics, fail incomplete, and never wait forever for close.
    const stopAndDrain = (): void => {
      void cleanupTree().then(() => {
        if (stdioClosed) return;
        drainTimer ??= setTimeout(() => {
          if (stdioClosed) return;
          drainExpired = true;
          child.stdout?.destroy();
          child.stderr?.destroy();
          void settle();
        }, KILL_GRACE_MS);
      });
    };

    const onAbort = (): void => {
      cancelled = true;
      stopAndDrain();
    };

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout = `${stdout}${String(chunk)}`;
      if (stdout.length > CHILD_OUTPUT_LIMIT) {
        stdout = stdout.slice(-CHILD_OUTPUT_LIMIT);
        outputExceeded = true;
        stopAndDrain();
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`;
      if (stderr.length > CHILD_OUTPUT_LIMIT) {
        stderr = stderr.slice(-CHILD_OUTPUT_LIMIT);
        outputExceeded = true;
        stopAndDrain();
      }
    });
    child.on("error", (error: Error) => {
      spawnError = error;
      void cleanupTree();
    });
    // Exit starts descendant cleanup; close (stdio drained) is what settles the promise.
    child.on("exit", () => {
      void cleanupTree();
    });
    child.on("close", () => {
      stdioClosed = true;
      void settle();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      stopAndDrain();
    }, options.timeoutMs);

    if (signal !== undefined) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/** Run one child under the wrapper's own SIGINT/SIGTERM cancellation. */
async function runWithCancellation<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals): void => controller.abort(signal);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await run(controller.signal);
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}

/** Install the pinned Labs artifact into its isolated profile. Never touches the root graph. */
export async function runCpuSetup(): Promise<void> {
  const executable = labsNodeExecutable();
  assertLabsNode(await labsNodeVersion(executable));
  const pin = await readToolManifestPin();
  await assertCatalogPin(pin);
  try {
    await runWithCancellation((signal) =>
      runBoundedProcess(
        {
          args: [
            "install",
            "--ignore-workspace",
            "--ignore-scripts",
            "--config.node-linker=hoisted",
            "--frozen-lockfile",
          ],
          command: "pnpm",
          cwd: LABS_TOOL_DIR,
          env: process.env,
          timeoutMs: captureTimeoutMs(),
        },
        signal,
      ),
    );
  } catch (error) {
    if (error instanceof BenchError) throw error;
    throw new BenchError(
      "TN_CPU_BENCH_SETUP_FAILED",
      `isolated install failed: ${messageOf(error)}`,
      2,
    );
  }
  const installed = await assertInstalledLabs();
  process.stdout.write(
    `isolated ${LABS_PACKAGE}@${installed} installed in ${path.relative(repoRoot, LABS_TOOL_DIR)}\n`,
  );
}

/** Retain the child's raw stdout/stderr beside a capture run, best effort. */
async function retainCaptureDiagnostics(
  runDirectory: string,
  output: { readonly stderr: string; readonly stdout: string },
): Promise<void> {
  try {
    await Promise.all([
      writeFile(path.join(runDirectory, "labs.stdout.txt"), output.stdout),
      writeFile(path.join(runDirectory, "labs.stderr.txt"), output.stderr),
    ]);
  } catch {
    // Diagnostics are best effort; never mask the capture outcome.
  }
}

/** The stdout/stderr a failed bounded process carried, when it could record them. */
function processOutput(error: unknown): { readonly stderr: string; readonly stdout: string } {
  if (typeof error === "object" && error !== null) {
    const record = error as { stderr?: unknown; stdout?: unknown };
    return {
      stderr: typeof record.stderr === "string" ? record.stderr : "",
      stdout: typeof record.stdout === "string" ? record.stdout : "",
    };
  }
  return { stderr: "", stdout: "" };
}

function renderRef(label: string, ref: { readonly path: string; readonly sha256: string }): string {
  return `  ${label.padEnd(8)} ${ref.path} sha256 ${ref.sha256}`;
}

/**
 * The human-readable capture report: workload inputs, checksum contracts, the untimed correctness
 * outcome and the CPU-only scope. It is written only for a completed capture.
 */
function renderCpuCaptureReport(manifest: ICpuCaptureManifest): string {
  const loopInputs = LOOP_CASES.map((entry) => String(entry.callbacks)).join("/");
  const stateInputs = STATE_CASES.map((entry) => String(entry.subscribers)).join("/");
  const loopContracts = LOOP_CASES.map((entry) => {
    const checksum = LOOP_FRAMES * ((entry.callbacks * (entry.callbacks - 1)) / 2);
    return `  ${entry.name}: updates ${LOOP_FRAMES}, ticks ${LOOP_FRAMES}, dispatches ${LOOP_FRAMES * entry.callbacks}, dispatch checksum ${checksum}`;
  });
  const stateContracts = STATE_CASES.map(
    (entry) =>
      `  ${entry.name}: set() calls ${STATE_WRITES}, flush calls 1, publish notifications ${entry.subscribers}`,
  );
  const rows = manifest.cases.map(
    (entry) =>
      `  ${entry.file} ${entry.alias} [${entry.family}] samples ${entry.samples} avgNs ${entry.avgNs} minNs ${entry.minNs} maxNs ${entry.maxNs}`,
  );
  return [
    `CPU-only capture — ${CPU_DOMAIN}`,
    CPU_COMPARISON_DISCLAIMER,
    "",
    `Run: ${manifest.runId} (name ${manifest.name})`,
    `Source: ${manifest.source.root}`,
    `Commit: ${manifest.source.commit}${manifest.source.dirty ? " (dirty)" : ""}`,
    `Window: ${manifest.startedAt} -> ${manifest.endedAt}`,
    `Tool: ${manifest.tool.package}@${manifest.tool.version} (${manifest.tool.executable})`,
    `Worker: node ${manifest.worker.node} / v8 ${manifest.worker.v8} / ${manifest.worker.platform}-${manifest.worker.arch} / ${manifest.worker.cpuModel} (${manifest.worker.cpuCount} cpus)`,
    "",
    "Workload inputs",
    `  loop/dispatch : ${LOOP_FRAMES} exact 1/64 s steps at ${loopInputs} registered callbacks`,
    `  state         : ${STATE_WRITES} coalesced set() writes then one flush at ${stateInputs} subscribers`,
    "",
    "Correctness contracts (per measured unit, from the pure fixtures)",
    ...loopContracts,
    ...stateContracts,
    "",
    "Checksum contracts",
    renderRef("config", manifest.workload.config),
    ...manifest.workload.benches.map((ref) => renderRef("bench", ref)),
    ...manifest.workload.fixtures.map((ref) => renderRef("fixture", ref)),
    renderRef("loop", manifest.source.modules.loop),
    renderRef("state", manifest.source.modules.state),
    renderRef("zustand", manifest.source.modules.zustand),
    "",
    "Cases",
    ...rows,
    "",
    "Untimed verification outcome: passed — all six owned cases ran with no adapter error; each adapter",
    "ran verify() after its timed block and the capture fails closed otherwise.",
    "Retained: labs.stdout.txt and labs.stderr.txt (the raw Labs result is kept byte-exact).",
    "",
  ].join("\n");
}

/**
 * Launch the installed Labs CLI against the selected checkout and record its raw result. The six
 * owned cases must all complete, the measured source must be unchanged, and the configured
 * workload must be the owned default; otherwise the run retains diagnostics but claims nothing.
 */
export async function runCpuCapture(options: ICpuCaptureOptions): Promise<ICpuCaptureResult> {
  const executable = labsNodeExecutable();
  assertLabsNode(await labsNodeVersion(executable));
  const labsVersion = await assertInstalledLabs();
  const configuredBenchDir = process.env.TN_CPU_BENCH_BENCH_DIR;
  if (configuredBenchDir !== undefined && configuredBenchDir.length > 0) {
    throw new BenchError(
      "TN_CPU_BENCH_BENCH_DIR_OVERRIDE",
      "TN_CPU_BENCH_BENCH_DIR is not supported for a completed capture; the owned benches are the only valid measured workload",
      2,
    );
  }
  const benchDir = path.join(LABS_TOOL_DIR, "benches");
  const childEnv = labsChildEnv();
  const sourceBefore = await collectCpuSourceIdentity({
    env: childEnv,
    nodeExecutable: executable,
    root: options.source,
  });
  const worker = await collectCpuWorkerIdentity({ env: childEnv, nodeExecutable: executable });
  const workload = await collectCpuWorkloadIdentity({ toolDir: LABS_TOOL_DIR });
  const blocks = effectiveBlocks(process.env);
  await mkdir(CPU_ARTIFACT_ROOT, { recursive: true });
  const runDirectory = await mkdtemp(path.join(CPU_ARTIFACT_ROOT, `${options.name}-`));
  const runId = path.basename(runDirectory);
  const labsRoot = path.join(runDirectory, "labs");
  await mkdir(labsRoot, { recursive: true });
  const resultsRelative = path.relative(LABS_TOOL_DIR, labsRoot);
  const startedAt = new Date().toISOString();
  const env = labsChildEnv(process.env, {
    TN_CPU_BENCH_RESULTS_DIR: resultsRelative,
    TN_CPU_BENCH_SOURCE: options.source,
  });
  let captured: IBoundedProcessResult;
  try {
    captured = await runWithCancellation((signal) =>
      runBoundedProcess(
        {
          args: [LABS_BIN, "run", "-n", options.name, "--force"],
          command: executable,
          cwd: LABS_TOOL_DIR,
          env,
          timeoutMs: captureTimeoutMs(),
        },
        signal,
      ),
    );
  } catch (error) {
    await retainCaptureDiagnostics(runDirectory, processOutput(error));
    if (error instanceof BenchError) throw error;
    throw new BenchError("TN_CPU_BENCH_RUN_FAILED", `labs capture failed: ${messageOf(error)}`, 2);
  }
  // Persist the raw Labs output the moment Labs succeeds, so every later failure keeps it.
  await Promise.all([
    writeFile(path.join(runDirectory, "labs.stdout.txt"), captured.stdout),
    writeFile(path.join(runDirectory, "labs.stderr.txt"), captured.stderr),
  ]);
  const resultFile = path.join(labsRoot, "results", `${options.name}.json`);
  if (!existsSync(resultFile)) {
    throw new BenchError(
      "TN_CPU_BENCH_NO_RESULT",
      `labs completed without saving ${path.relative(repoRoot, resultFile)}; the owned benches did not produce a result`,
      2,
    );
  }
  const raw = JSON.parse(await readFile(resultFile, "utf8")) as unknown;
  const cases = collectCpuCaseObservations(raw);
  const sourceAfter = await collectCpuSourceIdentity({
    env: childEnv,
    nodeExecutable: executable,
    root: options.source,
  });
  assertSourceUnchanged(sourceBefore, sourceAfter);
  const manifest = buildCpuCaptureManifest({
    cases,
    endedAt: new Date().toISOString(),
    name: options.name,
    result: {
      benchmarkCount: cases.length,
      file: path.relative(runDirectory, resultFile),
      sha256: await sha256File(resultFile),
    },
    runId,
    source: sourceBefore,
    startedAt,
    tool: { executable: path.resolve(executable), package: LABS_PACKAGE, version: labsVersion },
    tuning: collectCpuEffectiveTuning({
      benchDir,
      blocks,
      env: process.env,
      flags: ["run", "--force"],
      resultsDir: resultsRelative,
    }),
    worker,
    workload,
  });
  await writeFile(path.join(runDirectory, "capture-report.txt"), renderCpuCaptureReport(manifest));
  await writeCpuCaptureManifest(runDirectory, manifest);
  process.stdout.write(
    `CPU capture recorded ${cases.length} benchmark result(s)\n${path.relative(repoRoot, runDirectory)}\n`,
  );
  return { labsVersion, resultFile, runDirectory };
}

/**
 * Compare two explicit completed captures through the installed public Labs CLI. Validation and
 * identity checks run first; the compare itself is advisory, so a nonzero upstream exit is recorded
 * rather than adopted. Only the caller's own artifact paths and the untouched upstream output leave.
 */
export async function runCpuCompare(options: ICpuCompareOptions): Promise<ICpuCompareResult> {
  const baseline = await readCpuCaptureManifest(options.baseline);
  const candidate = await readCpuCaptureManifest(options.candidate);
  const compatibility = assertCompatibleCpuCaptures(
    baseline,
    candidate,
    options.control === undefined ? {} : { control: options.control },
  );
  const executable = labsNodeExecutable();
  assertLabsNode(await labsNodeVersion(executable));
  await assertInstalledLabs();
  await mkdir(CPU_ARTIFACT_ROOT, { recursive: true });
  const runDirectory = await mkdtemp(path.join(CPU_ARTIFACT_ROOT, "compare-"));
  const workDirectory = await mkdtemp(path.join(LABS_TOOL_DIR, "compare-"));
  try {
    await copyFile(
      path.join(LABS_TOOL_DIR, "labs.config.ts"),
      path.join(workDirectory, "labs.config.ts"),
    );
    const resultsDir = path.join(workDirectory, "results");
    await mkdir(resultsDir, { recursive: true });
    await copyFile(
      path.join(options.baseline, baseline.result.file),
      path.join(resultsDir, "baseline.json"),
    );
    await copyFile(
      path.join(options.candidate, candidate.result.file),
      path.join(resultsDir, "candidate.json"),
    );
    // The public CLI reads saved results from `<configDir>/<resultsDir>/results`, so a results
    // directory of "." puts them at `workDirectory/results`, where the captures were copied.
    const env = labsChildEnv(process.env, { TN_CPU_BENCH_RESULTS_DIR: "." });
    const baselineRun = await runWithCancellation((signal) =>
      runBoundedProcess(
        {
          args: [LABS_BIN, "baseline", "baseline"],
          command: executable,
          cwd: workDirectory,
          env,
          timeoutMs: captureTimeoutMs(),
        },
        signal,
      ),
    );
    const compared = await runWithCancellation((signal) =>
      runBoundedProcess(
        {
          allowNonZeroExit: true,
          args: [LABS_BIN, "compare", "candidate"],
          command: executable,
          cwd: workDirectory,
          env,
          timeoutMs: captureTimeoutMs(),
        },
        signal,
      ),
    );
    const upstream: ICpuComparisonUpstream = {
      exitCode: compared.exitCode,
      stderr: compared.stderr,
      stdout: compared.stdout,
    };
    const text = emitCpuComparisonReport({
      baseline,
      candidate,
      compatibility,
      format: "text",
      upstream,
    });
    const html = emitCpuComparisonReport({
      baseline,
      candidate,
      compatibility,
      format: "html",
      upstream,
    });
    const artifacts: ICpuCompareArtifacts = {
      html: path.join(runDirectory, "comparison.html"),
      stderr: path.join(runDirectory, "upstream.stderr.txt"),
      stdout: path.join(runDirectory, "upstream.stdout.txt"),
      text: path.join(runDirectory, "comparison.txt"),
    };
    await Promise.all([
      writeFile(artifacts.text, `${text}\n`),
      writeFile(artifacts.html, `${html}\n`),
      writeFile(artifacts.stdout, compared.stdout),
      writeFile(artifacts.stderr, compared.stderr),
      writeFile(path.join(runDirectory, "labs-baseline.stdout.txt"), baselineRun.stdout),
      writeFile(path.join(runDirectory, "labs-baseline.stderr.txt"), baselineRun.stderr),
      writeFile(
        path.join(runDirectory, "provenance.json"),
        `${JSON.stringify(
          {
            baseline: {
              commit: baseline.source.commit,
              result: baseline.result.file,
              root: baseline.source.root,
              runId: baseline.runId,
            },
            candidate: {
              commit: candidate.source.commit,
              result: candidate.result.file,
              root: candidate.source.root,
              runId: candidate.runId,
            },
            compatibility,
            upstreamExit: compared.exitCode,
          },
          null,
          2,
        )}\n`,
      ),
    ]);
    process.stdout.write(`${text}\n${path.relative(repoRoot, runDirectory)}\n`);
    return { artifacts, runDirectory, upstreamExit: compared.exitCode };
  } finally {
    await rm(workDirectory, { force: true, recursive: true });
  }
}

/** Run whichever CPU subcommand the argv selected. */
export async function runCpuCommand(command: CpuCommand, argv: readonly string[]): Promise<void> {
  if (command === "setup") {
    parseCpuSetupArgs(argv);
    return runCpuSetup();
  }
  if (command === "compare") {
    await runCpuCompare(parseCpuCompareArgs(argv));
    return;
  }
  await runCpuCapture(parseCpuCaptureArgs(argv));
}
