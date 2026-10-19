import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  CPU_CAPTURE_SCHEMA,
  EXPECTED_CPU_CASES,
  type ICpuCaptureManifest,
  buildCpuCaptureManifest,
  collectCpuCaseObservations,
  collectCpuSourceIdentity,
  collectCpuWorkloadIdentity,
  sha256File,
  writeCpuCaptureManifest,
} from "../performance-regression/cpu-report.js";
import {
  LABS_TOOL_DIR,
  assertSupportedPlatform,
  runBoundedProcess,
} from "../performance-regression/cpu.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cpuArtifactRoot = path.join(repoRoot, "artifacts/engine-load-test/cpu");
const integration = process.env.TN_CPU_BENCH_INTEGRATION === "1";
const testRunId = `${process.pid}-${Date.now()}`;
const createdRuns: string[] = [];

interface ICliResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

async function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<ICliResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, [...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 240_000,
    });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failure = error as { code?: unknown; killed?: boolean; stderr?: string; stdout?: string };
    return {
      code: failure.killed === true ? 124 : typeof failure.code === "number" ? failure.code : 1,
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    };
  }
}

async function runCli(args: readonly string[], env: NodeJS.ProcessEnv = {}): Promise<ICliResult> {
  return runCommand("pnpm", ["exec", "tsx", "scripts/engine-load-test/cli.ts", ...args], env);
}

/** The AC-1 root entry point, exactly as a user runs it. */
async function runBenchEngines(
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<ICliResult> {
  return runCommand("pnpm", ["bench:engines", ...args], env);
}

/** Run the real CLI and deliver a real SIGTERM after `signalAfterMs`, unlike execFile. */
async function runCliUntilSignalled(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  signalAfterMs: number,
): Promise<ICliResult> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/engine-load-test/cli.ts", ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), signalAfterMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal === null ? 1 : 130), stderr, stdout });
    });
  });
}

function major(version: string): number {
  return Number(version.replace(/^v/, "").split(".")[0]);
}

async function compatibleNodeVersion(executable: string): Promise<string | undefined> {
  if (path.resolve(executable) === path.resolve(process.execPath)) return process.versions.node;
  try {
    const { stdout } = await execFileAsync(executable, ["--version"]);
    return stdout.trim().replace(/^v/, "");
  } catch {
    return undefined;
  }
}

/** Test-only locator so the fixed proof command runs on a machine whose default Node is 20. */
async function discoverLabsNode(): Promise<string | undefined> {
  const candidates = [process.env.TN_CPU_BENCH_NODE, process.execPath].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  try {
    const nvm = path.join(homedir(), ".nvm/versions/node");
    for (const entry of await readdir(nvm)) candidates.push(path.join(nvm, entry, "bin/node"));
  } catch {
    // No nvm layout on this machine; the two explicit candidates above are the whole search.
  }
  for (const candidate of candidates) {
    const version = await compatibleNodeVersion(candidate);
    if (version !== undefined && major(version) >= 22) return candidate;
  }
  return undefined;
}

async function tempDirectory(): Promise<string> {
  return makeTempDir("tn-cpu-cli-");
}

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", ["-c", "user.email=agent@test", "-c", "user.name=agent", ...args], {
    cwd,
  });
}

/** A minimal selected checkout whose real loop.ts/state.ts are readable and hashable. */
async function writeCheckout(loopSource: string, secondCommit = false): Promise<string> {
  const root = await tempDirectory();
  await mkdir(path.join(root, "packages/core/src"), { recursive: true });
  await mkdir(path.join(root, "node_modules/zustand"), { recursive: true });
  await writeFile(path.join(root, "packages/core/src/loop.ts"), loopSource);
  await writeFile(path.join(root, "packages/core/src/state.ts"), 'import "zustand/vanilla";\n');
  await writeFile(
    path.join(root, "packages/core/package.json"),
    JSON.stringify({ name: "@x/core" }),
  );
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(
    path.join(root, "node_modules/zustand/package.json"),
    JSON.stringify({
      exports: { ".": "./index.js", "./vanilla": "./vanilla.js" },
      name: "zustand",
      type: "module",
      version: "5.0.14",
    }),
  );
  await writeFile(path.join(root, "node_modules/zustand/index.js"), "export const store = 0;\n");
  await writeFile(
    path.join(root, "node_modules/zustand/vanilla.js"),
    "export const vanilla = 1;\n",
  );
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "seed"]);
  if (secondCommit) {
    // Only an unrelated file changes, so the measured modules stay byte-identical across commits.
    await writeFile(path.join(root, "README.md"), `${hex("second")}\n`);
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "second"]);
  }
  return root;
}

async function writeTool(dir: string): Promise<void> {
  await mkdir(path.join(dir, "benches"), { recursive: true });
  await mkdir(path.join(dir, "workloads"), { recursive: true });
  await writeFile(path.join(dir, "labs.config.ts"), "export default {};\n");
  for (const file of ["benches/loop.bench.ts", "benches/state.bench.ts"]) {
    await writeFile(path.join(dir, file), `// ${file}\n`);
  }
  for (const file of [
    "workloads/selected-source.ts",
    "workloads/loop-workload.ts",
    "workloads/state-workload.ts",
  ]) {
    await writeFile(path.join(dir, file), `// ${file}\n`);
  }
}

/**
 * A raw Labs result with the pinned six-case shape. The unique capture id keeps two independent
 * fixtures byte-distinct, so a real self-comparison check still sees two different artifacts.
 */
function rawResult(captureId: string): Record<string, unknown> {
  const benchmarks = (family: "loop" | "state"): Record<string, unknown>[] =>
    EXPECTED_CPU_CASES.filter((entry) => entry.family === family).map((entry, index) => ({
      alias: entry.alias,
      group: 0,
      groupName: entry.group,
      runs: [
        {
          stats: {
            avg: 100 + index,
            max: 200 + index,
            min: 10 + index,
            samples: Array.from({ length: 8 }, (_, sample) => 100 + index + sample),
          },
        },
      ],
    }));
  return {
    files: [
      { benchmarks: benchmarks("loop"), file: "loop.bench.ts" },
      { benchmarks: benchmarks("state"), file: "state.bench.ts" },
    ],
    name: captureId,
  };
}

interface IRunSpec {
  readonly loop?: string;
  readonly resultName?: string;
  readonly secondCommit?: boolean;
  readonly source?: string;
  readonly worker?: Partial<ICpuCaptureManifest["worker"]>;
}

/** A completed on-disk capture built from the same public functions the real path uses. */
async function writeRun(
  spec: IRunSpec = {},
): Promise<{ dir: string; manifest: ICpuCaptureManifest }> {
  const sourceRoot =
    spec.source ??
    (await writeCheckout(spec.loop ?? "export const loop = 1;\n", spec.secondCommit ?? false));
  const toolDir = await tempDirectory();
  await writeTool(toolDir);
  const dir = await tempDirectory();
  const resultFile = path.join(dir, "labs/results", `${spec.resultName ?? "run"}.json`);
  await mkdir(path.dirname(resultFile), { recursive: true });
  const raw = rawResult(path.basename(dir));
  await writeFile(resultFile, JSON.stringify(raw));
  const source = await collectCpuSourceIdentity({
    env: {},
    nodeExecutable: process.execPath,
    root: sourceRoot,
  });
  const manifest = buildCpuCaptureManifest({
    cases: collectCpuCaseObservations(raw),
    endedAt: "2026-10-07T00:00:02.000Z",
    name: "run",
    result: {
      benchmarkCount: 6,
      file: path.relative(dir, resultFile),
      sha256: await sha256File(resultFile),
    },
    runId: path.basename(dir),
    source,
    startedAt: "2026-10-07T00:00:00.000Z",
    tool: { executable: "/labs/cli.mjs", package: "@pmndrs/labs", version: "0.9.0" },
    tuning: {
      benchDir: "/tool/benches",
      blocks: 8,
      blockTime: 0.05,
      flags: ["run", "--force"],
      minSamples: 5,
      resultsDir: "labs/results",
    },
    worker: {
      arch: "x64",
      cpuCount: 12,
      cpuModel: "Test CPU",
      node: "22.22.0",
      platform: "linux",
      v8: "12.4.254.21",
      ...spec.worker,
    },
    workload: await collectCpuWorkloadIdentity({ toolDir }),
  });
  await writeCpuCaptureManifest(dir, manifest);
  return { dir, manifest };
}

function compareArgs(baseline: string, candidate: string, extra: readonly string[] = []): string[] {
  return ["--cpu-compare", "--baseline", baseline, "--candidate", candidate, ...extra];
}

/** Failure-only runs have unique test prefixes; reject ambiguous observations. */
async function latestPrefixed(prefix: string): Promise<string | undefined> {
  const entries = await readdir(cpuArtifactRoot).catch(() => [] as string[]);
  const matches = entries.filter((entry) => entry.startsWith(prefix));
  if (matches.length > 1) throw new Error(`ambiguous test artifacts for ${prefix}`);
  const last = matches[0];
  if (last === undefined) return undefined;
  const directory = path.join(cpuArtifactRoot, last);
  createdRuns.push(directory);
  return directory;
}

function reportedDirectory(output: string): string {
  const line = output.trim().split("\n").at(-1);
  if (line === undefined || !line.startsWith("artifacts/engine-load-test/cpu/"))
    throw new Error("CLI did not report its artifact directory");
  const directory = path.resolve(repoRoot, line);
  createdRuns.push(directory);
  return directory;
}

interface ITreePids {
  readonly grandchild: number;
  readonly parent: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForDead(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (processAlive(pid) && Date.now() < deadline) await delay(25);
  return !processAlive(pid);
}

/** A missing or malformed observation must fail the test, never read as "already clean". */
async function readTreePids(file: string): Promise<ITreePids> {
  if (!existsSync(file)) throw new Error(`fixture never wrote its PIDs to ${file}`);
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<ITreePids>;
  if (
    typeof parsed.parent !== "number" ||
    typeof parsed.grandchild !== "number" ||
    parsed.parent <= 0 ||
    parsed.grandchild <= 0
  ) {
    throw new Error(`fixture wrote invalid PIDs: ${JSON.stringify(parsed)}`);
  }
  return { grandchild: parsed.grandchild, parent: parsed.parent };
}

/** Reap any fixture process still standing, so a failed assertion never leaks a process tree. */
function killTree(pids: ITreePids | undefined): void {
  for (const pid of [pids?.parent, pids?.grandchild]) {
    if (pid !== undefined) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

const STUBBORN_CHILD = [
  "process.on('SIGTERM', () => {});",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

function treeParentSource(exitParent: boolean): string {
  return [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    'import path from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    "const dir = path.dirname(fileURLToPath(import.meta.url));",
    'const child = spawn(process.execPath, [path.join(dir, "child.mjs")], { stdio: "ignore" });',
    "writeFileSync(",
    "  process.env.TN_PID_FILE,",
    "  JSON.stringify({ grandchild: child.pid, parent: process.pid }),",
    ");",
    "process.on('SIGTERM', () => {});",
    ...(exitParent ? ["process.exit(0);"] : []),
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n");
}

async function writeTreeFixture(directory: string, exitParent = false): Promise<string> {
  const script = path.join(directory, "tree.mjs");
  await writeFile(script, treeParentSource(exitParent));
  await writeFile(path.join(directory, "child.mjs"), STUBBORN_CHILD);
  return script;
}

// A detached grandchild inherits the parent's stdio and writes after the parent exits, so the
// direct child is gone while the pipes stay open. Settling on exit would drop that trailing output.
const TRAILING_PARENT = [
  'import { spawn } from "node:child_process";',
  'import path from "node:path";',
  'import { fileURLToPath } from "node:url";',
  "",
  "const dir = path.dirname(fileURLToPath(import.meta.url));",
  'const child = spawn(process.execPath, [path.join(dir, "child.mjs")], {',
  "  detached: true,",
  '  stdio: ["ignore", "inherit", "inherit"],',
  "});",
  "child.unref();",
  'process.stdout.write("HEAD\\n");',
  'process.stderr.write("HEADERR\\n");',
  "process.exit(0);",
  "",
].join("\n");

const TRAILING_CHILD = [
  'import { writeSync } from "node:fs";',
  "setTimeout(() => {",
  '  writeSync(1, "STDOUT-TRAIL-".repeat(4096) + "STDOUT-END\\n");',
  '  writeSync(2, "STDERR-TRAIL-".repeat(4096) + "STDERR-END\\n");',
  "  process.exit(0);",
  "}, 300);",
  "setInterval(() => {}, 1000);",
  "",
].join("\n");

async function writeTrailingFixture(directory: string): Promise<string> {
  await writeFile(path.join(directory, "child.mjs"), TRAILING_CHILD);
  const script = path.join(directory, "parent.mjs");
  await writeFile(script, TRAILING_PARENT);
  return script;
}

async function waitForPids(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) && Date.now() < deadline) await delay(25);
}

afterAll(async () => {
  await Promise.all(
    createdRuns.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("compatibility", () => {
  it("keeps the ordinary hardware usage output", async () => {
    const result = await runCli([]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("usage: pnpm bench:engines --arm");
  });

  it("fails closed before Labs when --cpu omits its source", async () => {
    const result = await runCli(["--cpu"]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_SOURCE_REQUIRED");
  });

  it("fails closed when the selected Node is below the Labs floor", async () => {
    const result = await runCli(["--cpu", "--source", repoRoot, "--name", "compat"], {
      TN_CPU_BENCH_NODE: path.join(repoRoot, "does-not-exist-node"),
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_NODE_UNSUPPORTED");
  });
});

describe("lifecycle", () => {
  it("terminates a whole process group, including a descendant that ignores TERM, on timeout", async () => {
    const directory = await tempDirectory();
    const pidFile = path.join(directory, "pids.json");
    const script = await writeTreeFixture(directory);
    let pids: ITreePids | undefined;
    try {
      await expect(
        runBoundedProcess({
          args: [script],
          command: process.execPath,
          cwd: directory,
          env: { ...process.env, TN_PID_FILE: pidFile },
          timeoutMs: 750,
        }),
      ).rejects.toThrow("TN_CPU_BENCH_TIMEOUT");
      pids = await readTreePids(pidFile);
      expect(await waitForDead(pids.parent)).toBe(true);
      expect(await waitForDead(pids.grandchild)).toBe(true);
    } finally {
      killTree(pids);
    }
  });

  it("terminates the process group on cancellation and reports it", async () => {
    const directory = await tempDirectory();
    const pidFile = path.join(directory, "pids.json");
    const script = await writeTreeFixture(directory);
    const controller = new AbortController();
    let pids: ITreePids | undefined;
    try {
      const running = runBoundedProcess(
        {
          args: [script],
          command: process.execPath,
          cwd: directory,
          env: { ...process.env, TN_PID_FILE: pidFile },
          timeoutMs: 30_000,
        },
        controller.signal,
      );
      await waitForPids(pidFile);
      pids = await readTreePids(pidFile);
      controller.abort();
      await expect(running).rejects.toThrow("TN_CPU_BENCH_CANCELLED");
      expect(await waitForDead(pids.parent)).toBe(true);
      expect(await waitForDead(pids.grandchild)).toBe(true);
    } finally {
      killTree(pids);
    }
  });

  it("reaps a descendant that outlives the direct child's clean exit", async () => {
    const directory = await tempDirectory();
    const pidFile = path.join(directory, "pids.json");
    const script = await writeTreeFixture(directory, true);
    let pids: ITreePids | undefined;
    try {
      const result = await runBoundedProcess({
        args: [script],
        command: process.execPath,
        cwd: directory,
        env: { ...process.env, TN_PID_FILE: pidFile },
        timeoutMs: 30_000,
      });
      expect(result.stdout).toBe("");
      pids = await readTreePids(pidFile);
      expect(await waitForDead(pids.grandchild)).toBe(true);
    } finally {
      killTree(pids);
    }
  });

  it("fails closed when the executable cannot start", async () => {
    await expect(
      runBoundedProcess({
        args: [],
        command: path.join(repoRoot, "does-not-exist-executable"),
        cwd: repoRoot,
        env: process.env,
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("TN_CPU_BENCH_SPAWN_FAILED");
  });

  it("retains stdout and stderr written after the direct child exits", async () => {
    const directory = await tempDirectory();
    const script = await writeTrailingFixture(directory);
    const result = await runBoundedProcess({
      args: [script],
      command: process.execPath,
      cwd: directory,
      env: process.env,
      timeoutMs: 5_000,
    });
    expect(result.stdout).toContain("HEAD");
    expect(result.stdout).toContain("STDOUT-END");
    expect(result.stderr).toContain("HEADERR");
    expect(result.stderr).toContain("STDERR-END");
  });

  it(
    "bounds draining when an escaped descendant keeps stdout open",
    { timeout: 8000 },
    async () => {
      const directory = await tempDirectory();
      const pidFile = path.join(directory, "pids.json");
      const script = path.join(directory, "escaped.mjs");
      await writeFile(
        script,
        `import { spawn } from "node:child_process"; import { writeFileSync } from "node:fs"; const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "inherit", "inherit"] }); writeFileSync(process.env.TN_PID_FILE, JSON.stringify({ parent: process.pid, grandchild: child.pid })); child.unref(); process.exit(0);`,
      );
      const started = Date.now();
      let pids: ITreePids | undefined;
      try {
        await expect(
          runBoundedProcess({
            command: process.execPath,
            args: [script],
            cwd: directory,
            env: { ...process.env, TN_PID_FILE: pidFile },
            timeoutMs: 1000,
          }),
        ).rejects.toThrow("TN_CPU_BENCH_CLEANUP_FAILED");
        expect(Date.now() - started).toBeLessThan(6500);
      } finally {
        pids = await readTreePids(pidFile);
        killTree(pids);
        expect(await waitForDead(pids.grandchild)).toBe(true);
      }
    },
  );

  it("fails incomplete rather than silently truncating worker output", async () => {
    await expect(
      runBoundedProcess({
        command: process.execPath,
        args: ["--eval", 'process.stdout.write("x".repeat(33 * 1024 * 1024));'],
        cwd: repoRoot,
        env: process.env,
        timeoutMs: 10000,
      }),
    ).rejects.toThrow("TN_CPU_BENCH_OUTPUT_LIMIT");
  });

  it("rejects CPU execution on win32 before any spawn", () => {
    expect(() => assertSupportedPlatform("win32")).toThrow("TN_CPU_BENCH_UNSUPPORTED_PLATFORM");
  });
});

describe("comparison", () => {
  it("rejects a missing saved capture before any tool runs", async () => {
    const empty = await tempDirectory();
    const candidate = await writeRun({ resultName: "candidate" });
    const result = await runCli(compareArgs(empty, candidate.dir));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_BAD_MANIFEST");
  });

  it("rejects a capture whose raw result changed after capture", async () => {
    const baseline = await writeRun({ resultName: "baseline" });
    const candidate = await writeRun({ loop: "export const loop = 2;\n", resultName: "candidate" });
    await writeFile(
      path.join(baseline.dir, baseline.manifest.result.file),
      JSON.stringify({ files: [] }),
    );
    const result = await runCli(compareArgs(baseline.dir, candidate.dir));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_STALE_EVIDENCE");
  });

  it("rejects incompatible environments instead of presenting a regression", async () => {
    const baseline = await writeRun({ resultName: "baseline" });
    const candidate = await writeRun({
      loop: "export const loop = 2;\n",
      resultName: "candidate",
      worker: { cpuModel: "Other CPU" },
    });
    const result = await runCli(compareArgs(baseline.dir, candidate.dir));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_INCOMPARABLE");
  });

  it("rejects byte-identical measured content across different commits", async () => {
    const baseline = await writeRun({ resultName: "baseline" });
    const candidate = await writeRun({ resultName: "candidate", secondCommit: true });
    const result = await runCli(compareArgs(baseline.dir, candidate.dir));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_IDENTICAL_SUBJECT");
  });

  it("rejects a same-source repeat without a named control", async () => {
    const source = await writeCheckout("export const loop = 1;\n");
    const baseline = await writeRun({ resultName: "baseline", source });
    const candidate = await writeRun({ resultName: "candidate", source });
    const result = await runCli(compareArgs(baseline.dir, candidate.dir));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_SAME_SOURCE");
  });

  it("rejects an invalid control name on a same-source repeat", async () => {
    const source = await writeCheckout("export const loop = 1;\n");
    const baseline = await writeRun({ resultName: "baseline", source });
    const candidate = await writeRun({ resultName: "candidate", source });
    const result = await runCli(
      compareArgs(baseline.dir, candidate.dir, ["--control", "bad name!"]),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_BAD_CONTROL");
  });

  it("rejects comparing one artifact with itself", async () => {
    const run = await writeRun({ resultName: "self" });
    const result = await runCli(compareArgs(run.dir, run.dir));
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_SELF_COMPARISON");
  });

  it("rejects unknown, duplicated or missing compare flags before touching evidence", async () => {
    const run = await writeRun({ resultName: "flags" });
    for (const args of [
      ["--cpu-compare", "--baseline", run.dir],
      ["--cpu-compare", "--baseline", run.dir, "--candidate"],
      ["--cpu-compare", "--baseline", run.dir, "--candidate", run.dir, "--arm", "tn-web"],
      ["--cpu-compare", "--baseline", run.dir, "--baseline", run.dir, "--candidate", run.dir],
    ]) {
      const result = await runCli(args);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toMatch(/TN_CPU_BENCH_/);
    }
  });
});

describe.skipIf(!integration)("integration", () => {
  it(
    "captures the owned six cases from a real checkout and records a completed manifest",
    { timeout: 120_000 },
    async () => {
      const node = await discoverLabsNode();
      if (node === undefined) throw new Error("no Node >= 22 executable found for the Labs worker");
      const result = await runCli(
        ["--cpu", "--source", repoRoot, "--name", `integration-smoke-${testRunId}`],
        {
          TN_CPU_BENCH_BLOCK_TIME: "0.05",
          TN_CPU_BENCH_BLOCKS: "8",
          TN_CPU_BENCH_INTEGRATION: "1",
          TN_CPU_BENCH_MIN_SAMPLES: "5",
          TN_CPU_BENCH_NODE: node,
        },
      );
      expect(result.stderr).not.toContain("TN_CPU_BENCH");
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("CPU capture recorded");

      const runDirectory = await latestPrefixed(`integration-smoke-${testRunId}-`);
      expect(runDirectory).toBeDefined();
      const manifest = JSON.parse(
        await readFile(path.join(runDirectory as string, "provenance.json"), "utf8"),
      ) as ICpuCaptureManifest;
      expect(manifest.schema).toBe(CPU_CAPTURE_SCHEMA);
      expect(manifest.completed).toBe(true);
      expect(manifest.cases).toHaveLength(6);
      expect(manifest.source.root).toBe(repoRoot);
      expect(existsSync(path.join(repoRoot, manifest.result.file))).toBe(false);
      expect(existsSync(path.join(runDirectory as string, manifest.result.file))).toBe(true);
      expect(existsSync(path.join(runDirectory as string, "capture-report.txt"))).toBe(true);
    },
  );

  it(
    "times out a real capture, kills its worker tree and records no completed claim",
    { timeout: 120_000 },
    async () => {
      const node = await discoverLabsNode();
      if (node === undefined) throw new Error("no Node >= 22 executable found for the Labs worker");
      const result = await runCli(
        ["--cpu", "--source", repoRoot, "--name", `integration-timeout-${testRunId}`],
        {
          TN_CPU_BENCH_BLOCK_TIME: "60",
          TN_CPU_BENCH_BLOCKS: "1",
          TN_CPU_BENCH_INTEGRATION: "1",
          TN_CPU_BENCH_NODE: node,
          TN_CPU_BENCH_TIMEOUT_MS: "4000",
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("TN_CPU_BENCH_TIMEOUT");
      const runDirectory = await latestPrefixed(`integration-timeout-${testRunId}-`);
      expect(runDirectory).toBeDefined();
      expect(existsSync(path.join(runDirectory as string, "provenance.json"))).toBe(false);
    },
  );

  it(
    "cancels a real running capture on SIGTERM and records no completed claim",
    { timeout: 120_000 },
    async () => {
      const node = await discoverLabsNode();
      if (node === undefined) throw new Error("no Node >= 22 executable found for the Labs worker");
      const result = await runCliUntilSignalled(
        ["--cpu", "--source", repoRoot, "--name", `integration-sigterm-${testRunId}`],
        {
          TN_CPU_BENCH_BLOCK_TIME: "120",
          TN_CPU_BENCH_BLOCKS: "1",
          TN_CPU_BENCH_INTEGRATION: "1",
          TN_CPU_BENCH_NODE: node,
        },
        6_000,
      );
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("TN_CPU_BENCH_CANCELLED");
      const runDirectory = await latestPrefixed(`integration-sigterm-${testRunId}-`);
      expect(runDirectory).toBeDefined();
      expect(existsSync(path.join(runDirectory as string, "provenance.json"))).toBe(false);
    },
  );

  it("rejects a non-owned workload override instead of fabricating a completed capture", async () => {
    const node = await discoverLabsNode();
    if (node === undefined) throw new Error("no Node >= 22 executable found for the Labs worker");
    const benches = await tempDirectory();
    const result = await runCli(["--cpu", "--source", repoRoot, "--name", "integration-override"], {
      TN_CPU_BENCH_BENCH_DIR: benches,
      TN_CPU_BENCH_INTEGRATION: "1",
      TN_CPU_BENCH_NODE: node,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("TN_CPU_BENCH_BENCH_DIR_OVERRIDE");
  });
});

describe.skipIf(!integration)("end-to-end", () => {
  const primary = process.env.TN_CPU_BENCH_BASELINE_SOURCE;
  // One real capture per side plus the compare; the Vitest default would not survive two captures.
  const timeoutMs = 300_000;

  it(
    "captures both families from two real checkouts and compares them",
    { timeout: timeoutMs },
    async () => {
      if (primary === undefined || !path.isAbsolute(primary) || !existsSync(primary)) {
        throw new Error(`AC-1 baseline checkout ${primary} is not available`);
      }
      const node = await discoverLabsNode();
      if (node === undefined) throw new Error("no Node >= 22 executable found for the Labs worker");
      const env = {
        TN_CPU_BENCH_BLOCK_TIME: "0.05",
        TN_CPU_BENCH_BLOCKS: "8",
        TN_CPU_BENCH_INTEGRATION: "1",
        TN_CPU_BENCH_MIN_SAMPLES: "5",
        TN_CPU_BENCH_NODE: node,
      };
      const candidate = await runBenchEngines(
        ["--cpu", "--source", repoRoot, "--name", `e2e-candidate-${testRunId}`],
        env,
      );
      expect(candidate.stderr).not.toContain("TN_CPU_BENCH");
      expect(candidate.code).toBe(0);
      const baseline = await runBenchEngines(
        ["--cpu", "--source", primary, "--name", `e2e-baseline-${testRunId}`],
        env,
      );
      expect(baseline.stderr).not.toContain("TN_CPU_BENCH");
      expect(baseline.code).toBe(0);

      const candidateDir = reportedDirectory(candidate.stdout);
      const baselineDir = reportedDirectory(baseline.stdout);
      expect(candidateDir).toBeDefined();
      expect(baselineDir).toBeDefined();
      const baselineManifest = JSON.parse(
        await readFile(path.join(baselineDir as string, "provenance.json"), "utf8"),
      ) as ICpuCaptureManifest;
      const candidateManifest = JSON.parse(
        await readFile(path.join(candidateDir as string, "provenance.json"), "utf8"),
      ) as ICpuCaptureManifest;
      expect(baselineManifest.source.root).toBe(primary);
      expect(candidateManifest.source.root).toBe(repoRoot);
      const changed = (["loop", "state", "zustand"] as const).filter(
        (key) =>
          baselineManifest.source.modules[key].sha256 !==
          candidateManifest.source.modules[key].sha256,
      );
      if (changed.length === 0) {
        throw new Error(
          "AC-1: measured modules are byte-identical between the two checkouts; a real comparison needs different sources",
        );
      }

      const compare = await runBenchEngines(
        compareArgs(baselineDir as string, candidateDir as string),
        { TN_CPU_BENCH_NODE: node },
      );
      expect(compare.code).toBe(0);
      const compareDir = reportedDirectory(compare.stdout);
      expect(compareDir).toBeDefined();
      const report = await readFile(path.join(compareDir as string, "comparison.txt"), "utf8");
      expect(report).toContain("node-cpu");
      expect(report).toContain(primary);
      expect(report).toContain(repoRoot);
      expect(report).not.toContain("TN_PASS");
      expect(existsSync(path.join(compareDir as string, "comparison.html"))).toBe(true);
      expect(existsSync(path.join(compareDir as string, "upstream.stdout.txt"))).toBe(true);
      const provenance = JSON.parse(
        await readFile(path.join(compareDir as string, "provenance.json"), "utf8"),
      ) as { upstreamExit: number };
      expect(Number.isInteger(provenance.upstreamExit)).toBe(true);
      const upstream = await readFile(
        path.join(compareDir as string, "upstream.stdout.txt"),
        "utf8",
      );
      // Match coverage, not a statistical outcome: Labs can legitimately skip clock-confounded cases.
      expect(upstream).toContain("matched: 6");
      for (const name of EXPECTED_CPU_CASES.map((entry) => entry.alias))
        expect(upstream).toContain(name);

      // Keep the actual acceptance artifacts, including both raw captures, for review.
      for (const directory of [baselineDir, candidateDir, compareDir]) {
        const index = createdRuns.indexOf(directory as string);
        if (index >= 0) createdRuns.splice(index, 1);
      }
    },
  );
});
