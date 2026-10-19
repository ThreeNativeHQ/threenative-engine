// Independent provenance and comparison component for the opt-in Node CPU benchmarks
// (PRD-pmndrs-labs Phase 3). It records the measured checkout's identity, validates a completed
// capture manifest, and renders the upstream Labs comparison as an advisory CPU-only report. It
// never imports the capture module (`cpu.ts`), never runs a benchmark, and never derives a
// ThreeNative performance verdict from an upstream exit code. A CPU improvement is not FPS, GPU,
// browser or native evidence.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { BenchError } from "../engine-load-test/report.js";

const execFileAsync = promisify(execFile);

export const CPU_DOMAIN = "node-cpu";
export const CPU_CAPTURE_SCHEMA = "tn-cpu-capture/v1";
export const CPU_MANIFEST_FILE = "provenance.json";
export const QUALIFIED_LABS_PACKAGE = "@pmndrs/labs";
export const QUALIFIED_LABS_VERSION = "0.9.0";
export const CPU_COMPARISON_DISCLAIMER =
  "Scope: Node/V8 CPU microbenchmarks only. This does not measure FPS, GPU cost, browser runtime, " +
  "or native parity, and it is not a ThreeNative performance verdict.";

const LOOP_RELATIVE = "packages/core/src/loop.ts";
const STATE_RELATIVE = "packages/core/src/state.ts";
const LOCK_RELATIVE = "pnpm-lock.yaml";
const CORE_PACKAGE_RELATIVE = "packages/core/package.json";
const TOOL_WORKLOAD_FILES = ["benches/loop.bench.ts", "benches/state.bench.ts"] as const;
const TOOL_FIXTURE_FILES = [
  "workloads/selected-source.ts",
  "workloads/loop-workload.ts",
  "workloads/state-workload.ts",
] as const;
const ZUSTAND_SPECIFIER = "zustand/vanilla";
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODULE_KEYS = ["loop", "state", "zustand"] as const;
const PROBE_LIMIT = 4 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 30_000;

type CpuModuleKey = (typeof MODULE_KEYS)[number];

function fail(code: string, detail: string): never {
  throw new BenchError(code, detail);
}

export interface ISha256Ref {
  readonly path: string;
  readonly sha256: string;
}

export interface ICpuModuleRef extends ISha256Ref {
  readonly specifier?: string;
}

export interface ICpuDependencyRef extends ISha256Ref {
  readonly name: string;
  readonly version: string;
}

export interface ICpuSourceIdentity {
  readonly commit: string;
  readonly corePackage: ISha256Ref | null;
  readonly dependencies: readonly ICpuDependencyRef[];
  readonly dirty: boolean;
  readonly lock: ISha256Ref | null;
  readonly modules: Readonly<Record<CpuModuleKey, ICpuModuleRef>>;
  readonly root: string;
}

export interface ICpuWorkerIdentity {
  readonly arch: string;
  readonly cpuCount: number;
  readonly cpuModel: string;
  readonly node: string;
  readonly platform: string;
  readonly v8: string;
}

export interface ICpuToolIdentity {
  readonly executable: string;
  readonly package: string;
  readonly version: string;
}

export interface ICpuWorkloadIdentity {
  readonly benches: readonly ISha256Ref[];
  readonly config: ISha256Ref;
  readonly fixtures: readonly ISha256Ref[];
  readonly match: string;
}

export interface ICpuEffectiveTuning {
  readonly benchDir: string;
  readonly blocks: number;
  readonly blockTime: number | null;
  readonly flags: readonly string[];
  readonly minSamples: number | null;
  readonly resultsDir: string;
}

export interface ICpuCaseObservation {
  readonly alias: string;
  readonly avgNs: number;
  readonly family: "loop" | "state";
  readonly file: string;
  readonly group: string;
  readonly maxNs: number;
  readonly minNs: number;
  readonly samples: number;
}

export interface ICpuResultRef {
  readonly benchmarkCount: number;
  readonly file: string;
  readonly sha256: string;
}

export interface ICpuCaptureManifest {
  readonly cases: readonly ICpuCaseObservation[];
  readonly completed: boolean;
  readonly domain: string;
  readonly endedAt: string;
  readonly name: string;
  readonly result: ICpuResultRef;
  readonly runId: string;
  readonly schema: string;
  readonly source: ICpuSourceIdentity;
  readonly startedAt: string;
  readonly tool: ICpuToolIdentity;
  readonly tuning: ICpuEffectiveTuning;
  readonly worker: ICpuWorkerIdentity;
  readonly workload: ICpuWorkloadIdentity;
}

export interface IBuildCpuCaptureInput {
  readonly cases: readonly ICpuCaseObservation[];
  readonly endedAt: string;
  readonly name: string;
  readonly result: ICpuResultRef;
  readonly runId: string;
  readonly source: ICpuSourceIdentity;
  readonly startedAt: string;
  readonly tool: ICpuToolIdentity;
  readonly tuning: ICpuEffectiveTuning;
  readonly worker: ICpuWorkerIdentity;
  readonly workload: ICpuWorkloadIdentity;
}

export interface ICpuSourceOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly loopRelative?: string;
  readonly nodeExecutable: string;
  readonly root: string;
  readonly stateRelative?: string;
}

export interface ICpuWorkerOptions {
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nodeExecutable: string;
}

export interface ICpuWorkloadOptions {
  readonly toolDir: string;
}

export interface ICpuTuningOptions {
  readonly benchDir: string;
  readonly blocks: number;
  readonly env: NodeJS.ProcessEnv;
  readonly flags: readonly string[];
  readonly resultsDir: string;
}

export interface ICpuCompatibility {
  readonly changedModules: readonly string[];
  readonly controlName: string | null;
  readonly mode: "comparison" | "control";
  readonly sameSource: boolean;
  readonly warnings: readonly string[];
}

export interface ICpuCompareOptions {
  readonly control?: string;
}

export interface ICpuComparisonUpstream {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ICpuComparisonReportInput {
  readonly baseline: ICpuCaptureManifest;
  readonly candidate: ICpuCaptureManifest;
  readonly compatibility: ICpuCompatibility;
  readonly format?: "text" | "html";
  readonly upstream: ICpuComparisonUpstream;
}

export const EXPECTED_CPU_CASES = [
  {
    alias: "dispatch 0",
    family: "loop",
    file: "loop.bench.ts",
    group: "fixed-step loop dispatch",
  },
  {
    alias: "dispatch 32",
    family: "loop",
    file: "loop.bench.ts",
    group: "fixed-step loop dispatch",
  },
  {
    alias: "dispatch 256",
    family: "loop",
    file: "loop.bench.ts",
    group: "fixed-step loop dispatch",
  },
  {
    alias: "0 subscribers",
    family: "state",
    file: "state.bench.ts",
    group: "coalesced state publication",
  },
  {
    alias: "1 subscriber",
    family: "state",
    file: "state.bench.ts",
    group: "coalesced state publication",
  },
  {
    alias: "32 subscribers",
    family: "state",
    file: "state.bench.ts",
    group: "coalesced state publication",
  },
] as const;

/** The sha256 of one file's bytes, read fresh. Missing files fail closed. */
export async function sha256File(file: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail(
      "TN_CPU_BENCH_MISSING_FILE",
      `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

async function realpathOrFail(file: string, code: string): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    return fail(
      code,
      `could not resolve ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Resolve a file to its real absolute path and content hash. */
export async function sha256Ref(file: string): Promise<ISha256Ref> {
  const resolved = await realpathOrFail(path.resolve(file), "TN_CPU_BENCH_MISSING_FILE");
  return { path: resolved, sha256: await sha256File(resolved) };
}

function statIs(target: string, kind: "directory" | "file"): boolean {
  try {
    const stats = statSync(target);
    return kind === "directory" ? stats.isDirectory() : stats.isFile();
  } catch {
    return false;
  }
}

async function runNode(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executable, [...args], {
      cwd,
      env,
      maxBuffer: PROBE_LIMIT,
      timeout: PROBE_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : "";
    return fail(
      "TN_CPU_BENCH_NODE_PROBE_FAILED",
      `'${executable}' probe failed${detail.length > 0 ? `: ${detail}` : ""}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function gitIdentity(root: string): Promise<{ commit: string; dirty: boolean }> {
  try {
    const [{ stdout: commit }, { stdout: status }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        maxBuffer: PROBE_LIMIT,
        timeout: PROBE_TIMEOUT_MS,
      }),
      execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
        cwd: root,
        maxBuffer: PROBE_LIMIT,
        timeout: PROBE_TIMEOUT_MS,
      }),
    ]);
    const resolved = commit.trim();
    if (!/^[0-9a-f]{40}$/.test(resolved)) {
      return fail("TN_CPU_BENCH_BAD_GIT", `${root} returned a non-commit HEAD '${resolved}'`);
    }
    return { commit: resolved, dirty: status.trim().length > 0 };
  } catch (error) {
    if (error instanceof BenchError) throw error;
    return fail(
      "TN_CPU_BENCH_BAD_GIT",
      `${root} is not a readable Git checkout: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Resolve an ESM specifier from a directory using the selected Node executable. `import.meta.resolve`
 * in a `--eval` module resolves from the eval module's cwd, so the entry is the real ESM one. This
 * deliberately avoids `createRequire`, whose CJS condition could name a different entry.
 */
async function resolveEsmSpecifier(
  specifier: string,
  fromDir: string,
  nodeExecutable: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const script = [
    `const url = import.meta.resolve(${JSON.stringify(specifier)});`,
    'if (!url.startsWith("file:")) {',
    `  throw new Error(${JSON.stringify(`${specifier} resolved to a non-file URL`)} + ": " + url);`,
    "}",
    "process.stdout.write(url);",
  ].join("\n");
  const url = (
    await runNode(nodeExecutable, ["--input-type=module", "--eval", script], fromDir, env)
  ).trim();
  if (!url.startsWith("file:")) {
    return fail("TN_CPU_BENCH_BAD_DEPENDENCY", `${specifier} resolved to '${url}', not a file URL`);
  }
  const resolved = fileURLToPath(url);
  if (!statIs(resolved, "file")) {
    return fail("TN_CPU_BENCH_BAD_DEPENDENCY", `${specifier} resolved to missing file ${resolved}`);
  }
  return realpathOrFail(resolved, "TN_CPU_BENCH_BAD_DEPENDENCY");
}

async function packageVersion(resolved: string, name: string): Promise<string> {
  let directory = path.dirname(resolved);
  for (;;) {
    const manifestFile = path.join(directory, "package.json");
    if (existsSync(manifestFile)) {
      try {
        const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === name) {
          if (typeof manifest.version !== "string" || manifest.version.length === 0) {
            return fail("TN_CPU_BENCH_BAD_DEPENDENCY", `${manifestFile} has no ${name} version`);
          }
          return manifest.version;
        }
      } catch (error) {
        if (error instanceof BenchError) throw error;
        return fail(
          "TN_CPU_BENCH_BAD_DEPENDENCY",
          `could not parse ${manifestFile}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return fail(
    "TN_CPU_BENCH_BAD_DEPENDENCY",
    `could not find package.json for '${name}' from ${resolved}`,
  );
}

/**
 * Collect the measured checkout's identity: Git state, the absolute path and content hash of the
 * two core modules, the actual ESM `zustand/vanilla` entry the state module imports, and the lock
 * and core package manifest. It never falls back to the runner checkout.
 */
export async function collectCpuSourceIdentity(
  options: ICpuSourceOptions,
): Promise<ICpuSourceIdentity> {
  const root = await realpathOrFail(path.resolve(options.root), "TN_CPU_BENCH_BAD_SOURCE");
  if (!statIs(root, "directory")) {
    return fail("TN_CPU_BENCH_BAD_SOURCE", `selected source '${root}' is not a directory`);
  }
  const loopRelative = options.loopRelative ?? LOOP_RELATIVE;
  const stateRelative = options.stateRelative ?? STATE_RELATIVE;
  const loop = await sha256Ref(path.join(root, loopRelative));
  const state = await sha256Ref(path.join(root, stateRelative));
  assertWithin(root, loop.path, "source.modules.loop.path", "TN_CPU_BENCH_TAMPERED_PATH");
  assertWithin(root, state.path, "source.modules.state.path", "TN_CPU_BENCH_TAMPERED_PATH");
  const { commit, dirty } = await gitIdentity(root);
  const zustandPath = await resolveEsmSpecifier(
    ZUSTAND_SPECIFIER,
    path.dirname(state.path),
    options.nodeExecutable,
    options.env,
  );
  const zustand: ICpuModuleRef = {
    path: zustandPath,
    sha256: await sha256File(zustandPath),
    specifier: ZUSTAND_SPECIFIER,
  };
  const lockPath = path.join(root, LOCK_RELATIVE);
  const corePackagePath = path.join(root, CORE_PACKAGE_RELATIVE);
  return {
    commit,
    corePackage: existsSync(corePackagePath) ? await sha256Ref(corePackagePath) : null,
    dependencies: [
      {
        name: "zustand",
        path: zustandPath,
        sha256: zustand.sha256,
        version: await packageVersion(zustandPath, "zustand"),
      },
    ],
    dirty,
    lock: existsSync(lockPath) ? await sha256Ref(lockPath) : null,
    modules: { loop, state, zustand },
    root,
  };
}

const WORKER_PROBE = [
  'import os from "node:os";',
  "const cpus = os.cpus();",
  "const first = cpus.length > 0 ? cpus[0] : undefined;",
  "process.stdout.write(JSON.stringify({",
  "  arch: process.arch,",
  "  cpuCount: cpus.length,",
  '  cpuModel: first === undefined ? "" : first.model,',
  "  node: process.versions.node,",
  "  platform: process.platform,",
  "  v8: process.versions.v8,",
  "}));",
].join("\n");

/**
 * Collect the identity of the Node/V8 that actually ran the workload, by probing the selected
 * executable. The wrapper may itself run an older Node; only this probe names the worker.
 */
export async function collectCpuWorkerIdentity(
  options: ICpuWorkerOptions,
): Promise<ICpuWorkerIdentity> {
  const stdout = await runNode(
    options.nodeExecutable,
    ["--input-type=module", "--eval", WORKER_PROBE],
    options.cwd ?? process.cwd(),
    options.env,
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail("TN_CPU_BENCH_BAD_WORKER", `worker probe returned non-JSON: '${stdout.trim()}'`);
  }
  const record = asRecord(parsed, "worker probe");
  return {
    arch: requireText(record, "arch", "worker probe"),
    cpuCount: requirePositiveInteger(record, "cpuCount", "worker probe"),
    cpuModel: requireText(record, "cpuModel", "worker probe"),
    node: requireText(record, "node", "worker probe"),
    platform: requireText(record, "platform", "worker probe"),
    v8: requireText(record, "v8", "worker probe"),
  };
}

/** Hash the runner-side workload definitions and config. Runner identity is not source identity. */
export async function collectCpuWorkloadIdentity(
  options: ICpuWorkloadOptions,
): Promise<ICpuWorkloadIdentity> {
  const toolDir = path.resolve(options.toolDir);
  const config = await sha256Ref(path.join(toolDir, "labs.config.ts"));
  const benches = await Promise.all(
    TOOL_WORKLOAD_FILES.map((relative) => sha256Ref(path.join(toolDir, relative))),
  );
  const fixtures = await Promise.all(
    TOOL_FIXTURE_FILES.map((relative) => sha256Ref(path.join(toolDir, relative))),
  );
  return { benches, config, fixtures, match: "**/*.bench.ts" };
}

function tuningNumber(env: NodeJS.ProcessEnv, key: string, integer: boolean): number | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const parsed = Number(raw);
  const valid = integer
    ? Number.isInteger(parsed) && parsed > 0
    : Number.isFinite(parsed) && parsed > 0;
  if (!valid) {
    return fail(
      "TN_CPU_BENCH_BAD_TUNING",
      `${key} must be a positive ${integer ? "integer" : "finite number"}, got '${raw}'`,
    );
  }
  return parsed;
}

/** Record the effective Labs tuning and flags used for a capture. */
export function collectCpuEffectiveTuning(options: ICpuTuningOptions): ICpuEffectiveTuning {
  return {
    benchDir: options.benchDir,
    blocks: options.blocks,
    blockTime: tuningNumber(options.env, "TN_CPU_BENCH_BLOCK_TIME", false),
    flags: [...options.flags],
    minSamples: tuningNumber(options.env, "TN_CPU_BENCH_MIN_SAMPLES", true),
    resultsDir: options.resultsDir,
  };
}

function caseKey(file: string, alias: string): string {
  return `${file}\u0000${alias}`;
}

/** A stable rendering of the owned case observations, independent of their input order. */
function canonicalCaseSet(cases: readonly ICpuCaseObservation[]): string {
  return JSON.stringify(
    cases
      .map((entry) => ({
        alias: entry.alias,
        avgNs: entry.avgNs,
        family: entry.family,
        file: entry.file,
        group: entry.group,
        maxNs: entry.maxNs,
        minNs: entry.minNs,
        samples: entry.samples,
      }))
      .sort((left, right) =>
        caseKey(left.file, left.alias) < caseKey(right.file, right.alias) ? -1 : 1,
      ),
  );
}

function caseFinite(value: unknown, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail("TN_CPU_BENCH_CASE_ERROR", `${at} must be a finite number`);
  }
  return value;
}

/** Extract the six correctness-qualified cases from the raw upstream Labs result. */
export function collectCpuCaseObservations(raw: unknown): readonly ICpuCaseObservation[] {
  const root = asRecord(raw, "labs result");
  const files = requireArray(root, "files", "labs result");
  if (files.length === 0) {
    return fail("TN_CPU_BENCH_EMPTY_RESULT", "the upstream Labs result has no files");
  }
  const byKey = new Map<string, ICpuCaseObservation>();
  for (const [fileIndex, fileValue] of files.entries()) {
    const fileAt = `labs result.files[${fileIndex}]`;
    const file = asRecord(fileValue, fileAt);
    if (file.error !== undefined) {
      return fail("TN_CPU_BENCH_CASE_ERROR", `${fileAt} reported '${String(file.error)}'`);
    }
    const fileName = requireText(file, "file", fileAt);
    const benchmarks = requireArray(file, "benchmarks", fileAt);
    for (const [benchIndex, benchValue] of benchmarks.entries()) {
      const at = `${fileAt}.benchmarks[${benchIndex}]`;
      const bench = asRecord(benchValue, at);
      if (bench.error !== undefined) {
        return fail("TN_CPU_BENCH_CASE_ERROR", `${at} reported '${String(bench.error)}'`);
      }
      const alias = requireText(bench, "alias", at);
      const group = requireText(bench, "groupName", at);
      const expected = EXPECTED_CPU_CASES.find(
        (candidate) => candidate.file === fileName && candidate.alias === alias,
      );
      if (expected === undefined) {
        return fail("TN_CPU_BENCH_UNEXPECTED_CASE", `${fileName} '${alias}' is not an owned case`);
      }
      if (expected.group !== group) {
        return fail(
          "TN_CPU_BENCH_UNEXPECTED_CASE",
          `${fileName} '${alias}' has group '${group}', expected '${expected.group}'`,
        );
      }
      const key = caseKey(fileName, alias);
      if (byKey.has(key)) {
        return fail(
          "TN_CPU_BENCH_UNEXPECTED_CASE",
          `${fileName} '${alias}' is reported more than once`,
        );
      }
      const runs = requireArray(bench, "runs", at);
      if (runs.length === 0) return fail("TN_CPU_BENCH_CASE_ERROR", `${at} has no runs`);
      for (const [runIndex, runValue] of runs.entries()) {
        const runAt = `${at}.runs[${runIndex}]`;
        const run = asRecord(runValue, runAt);
        if (run.error !== undefined) {
          return fail("TN_CPU_BENCH_CASE_ERROR", `${runAt} reported '${String(run.error)}'`);
        }
      }
      if (runs.length !== 1) {
        return fail(
          "TN_CPU_BENCH_CASE_ERROR",
          `${at} must record exactly one run, found ${runs.length}`,
        );
      }
      const runAt = `${at}.runs[0]`;
      const run = asRecord(runs[0], runAt);
      const stats = asRecord(run.stats, `${runAt}.stats`);
      const samples = requireArray(stats, "samples", `${runAt}.stats`);
      if (samples.length === 0) {
        return fail("TN_CPU_BENCH_CASE_ERROR", `${runAt} recorded no samples`);
      }
      for (const [sampleIndex, sample] of samples.entries()) {
        if (caseFinite(sample, `${runAt}.stats.samples[${sampleIndex}]`) < 0) {
          return fail(
            "TN_CPU_BENCH_CASE_ERROR",
            `${runAt}.stats.samples[${sampleIndex}] is negative`,
          );
        }
      }
      const minNs = caseFinite(stats.min, `${runAt}.stats.min`);
      const maxNs = caseFinite(stats.max, `${runAt}.stats.max`);
      const avgNs = caseFinite(stats.avg, `${runAt}.stats.avg`);
      if (minNs < 0 || maxNs < 0 || avgNs < 0) {
        return fail("TN_CPU_BENCH_CASE_ERROR", `${runAt}.stats has a negative observation`);
      }
      if (maxNs < minNs) {
        return fail("TN_CPU_BENCH_CASE_ERROR", `${runAt}.stats max is below min`);
      }
      if (avgNs < minNs || avgNs > maxNs) {
        return fail("TN_CPU_BENCH_CASE_ERROR", `${runAt}.stats avg is outside [min, max]`);
      }
      byKey.set(key, {
        alias,
        avgNs,
        family: expected.family,
        file: fileName,
        group,
        maxNs,
        minNs,
        samples: samples.length,
      });
    }
  }
  return EXPECTED_CPU_CASES.map((expected) => {
    const found = byKey.get(caseKey(expected.file, expected.alias));
    if (found === undefined) {
      return fail(
        "TN_CPU_BENCH_MISSING_CASE",
        `the upstream fraction is missing ${expected.file} '${expected.alias}'`,
      );
    }
    return found;
  });
}

/** Assemble and structurally validate a completed capture manifest. Nothing is written here. */
export function buildCpuCaptureManifest(input: IBuildCpuCaptureInput): ICpuCaptureManifest {
  const manifest: ICpuCaptureManifest = {
    cases: input.cases,
    completed: true,
    domain: CPU_DOMAIN,
    endedAt: input.endedAt,
    name: input.name,
    result: input.result,
    runId: input.runId,
    schema: CPU_CAPTURE_SCHEMA,
    source: input.source,
    startedAt: input.startedAt,
    tool: input.tool,
    tuning: input.tuning,
    worker: input.worker,
    workload: input.workload,
  };
  return validateCpuCaptureManifest(manifest);
}

/** Fail closed on any missing, malformed, partial or wrongly-timed manifest field. */
export function validateCpuCaptureManifest(manifest: unknown): ICpuCaptureManifest {
  const root = asRecord(manifest, "capture manifest");
  if (requireText(root, "schema", "capture manifest") !== CPU_CAPTURE_SCHEMA) {
    return fail("TN_CPU_BENCH_BAD_SCHEMA", "unsupported capture schema");
  }
  if (requireText(root, "domain", "capture manifest") !== CPU_DOMAIN) {
    return fail("TN_CPU_BENCH_BAD_DOMAIN", `capture domain must be '${CPU_DOMAIN}'`);
  }
  if (!requireBoolean(root, "completed", "capture manifest")) {
    return fail("TN_CPU_BENCH_INCOMPLETE", "the capture manifest is not marked completed");
  }
  const runId = requireText(root, "runId", "capture manifest");
  const name = requireText(root, "name", "capture manifest");
  const startedAt = requireTimestamp(root, "startedAt");
  const endedAt = requireTimestamp(root, "endedAt");
  if (Date.parse(endedAt) < Date.parse(startedAt)) {
    return fail("TN_CPU_BENCH_BAD_TIME", "the capture ended before it started");
  }
  const tool = parseTool(root);
  const source = parseSource(root);
  const worker = parseWorker(root);
  const workload = parseWorkload(root);
  const tuning = parseTuning(root);
  const cases = parseCases(root);
  const result = parseResult(root, cases.length);
  return {
    cases,
    completed: true,
    domain: CPU_DOMAIN,
    endedAt,
    name,
    result,
    runId,
    schema: CPU_CAPTURE_SCHEMA,
    source,
    startedAt,
    tool,
    tuning,
    worker,
    workload,
  };
}

function parseTool(root: Record<string, unknown>): ICpuToolIdentity {
  const tool = asRecord(root.tool, "capture manifest.tool");
  const pkg = requireText(tool, "package", "capture manifest.tool");
  if (pkg !== QUALIFIED_LABS_PACKAGE) {
    return fail("TN_CPU_BENCH_BAD_TOOL", `tool package must be '${QUALIFIED_LABS_PACKAGE}'`);
  }
  const version = requireText(tool, "version", "capture manifest.tool");
  if (version !== QUALIFIED_LABS_VERSION) {
    return fail(
      "TN_CPU_BENCH_BAD_TOOL",
      `tool version must be the qualified ${QUALIFIED_LABS_VERSION}, got '${version}'`,
    );
  }
  return {
    executable: requireText(tool, "executable", "capture manifest.tool"),
    package: pkg,
    version,
  };
}

function parseSource(root: Record<string, unknown>): ICpuSourceIdentity {
  const source = asRecord(root.source, "capture manifest.source");
  const commit = requireText(source, "commit", "capture manifest.source");
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `source.commit '${commit}' is not a Git commit`);
  }
  const rootPath = requireText(source, "root", "capture manifest.source");
  if (!path.isAbsolute(rootPath)) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", "source.root must be an absolute path");
  }
  const modules = asRecord(source.modules, "capture manifest.source.modules");
  const parsedModules = {} as Record<CpuModuleKey, ICpuModuleRef>;
  for (const key of MODULE_KEYS) {
    parsedModules[key] = parseModuleRef(modules[key], `capture manifest.source.modules.${key}`);
  }
  const dependencies = requireArray(source, "dependencies", "capture manifest.source").map(
    (value, index) => {
      const at = `capture manifest.source.dependencies[${index}]`;
      const dependency = asRecord(value, at);
      const ref = parseRef(dependency, at);
      return {
        ...ref,
        name: requireText(dependency, "name", at),
        version: requireText(dependency, "version", at),
      };
    },
  );
  return {
    commit,
    corePackage: parseNullableRef(source.corePackage, "capture manifest.source.corePackage"),
    dependencies,
    dirty: requireBoolean(source, "dirty", "capture manifest.source"),
    lock: parseNullableRef(source.lock, "capture manifest.source.lock"),
    modules: parsedModules,
    root: rootPath,
  };
}

function parseModuleRef(value: unknown, at: string): ICpuModuleRef {
  const ref = parseRef(value, at);
  const record = asRecord(value, at);
  const specifier = record.specifier;
  if (specifier === undefined) return ref;
  return { ...ref, specifier: requireText(record, "specifier", at) };
}

function parseRef(value: unknown, at: string): ISha256Ref {
  const record = asRecord(value, at);
  const file = requireText(record, "path", at);
  if (!path.isAbsolute(file))
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at}.path is not absolute`);
  return { path: file, sha256: requireSha(record, "sha256", at) };
}

function parseNullableRef(value: unknown, at: string): ISha256Ref | null {
  if (value === null || value === undefined) return null;
  return parseRef(value, at);
}

function parseWorker(root: Record<string, unknown>): ICpuWorkerIdentity {
  const worker = asRecord(root.worker, "capture manifest.worker");
  return {
    arch: requireText(worker, "arch", "capture manifest.worker"),
    cpuCount: requirePositiveInteger(worker, "cpuCount", "capture manifest.worker"),
    cpuModel: requireText(worker, "cpuModel", "capture manifest.worker"),
    node: requireText(worker, "node", "capture manifest.worker"),
    platform: requireText(worker, "platform", "capture manifest.worker"),
    v8: requireText(worker, "v8", "capture manifest.worker"),
  };
}

function parseWorkload(root: Record<string, unknown>): ICpuWorkloadIdentity {
  const workload = asRecord(root.workload, "capture manifest.workload");
  const benches = parseRefArray(workload.benches, "capture manifest.workload.benches");
  if (benches.length === 0) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", "workload.benches must not be empty");
  }
  const fixtures = parseRefArray(workload.fixtures, "capture manifest.workload.fixtures");
  if (fixtures.length === 0) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", "workload.fixtures must not be empty");
  }
  return {
    benches,
    config: parseRef(workload.config, "capture manifest.workload.config"),
    fixtures,
    match: requireText(workload, "match", "capture manifest.workload"),
  };
}

function parseTuning(root: Record<string, unknown>): ICpuEffectiveTuning {
  const tuning = asRecord(root.tuning, "capture manifest.tuning");
  return {
    benchDir: requireText(tuning, "benchDir", "capture manifest.tuning"),
    blocks: requirePositiveInteger(tuning, "blocks", "capture manifest.tuning"),
    blockTime: requireNullableFinite(tuning, "blockTime", "capture manifest.tuning"),
    flags: requireArray(tuning, "flags", "capture manifest.tuning").map((value, index) =>
      requireStringValue(value, `capture manifest.tuning.flags[${index}]`),
    ),
    minSamples: requireNullableInteger(tuning, "minSamples", "capture manifest.tuning"),
    resultsDir: requireText(tuning, "resultsDir", "capture manifest.tuning"),
  };
}

function parseCases(root: Record<string, unknown>): readonly ICpuCaseObservation[] {
  const values = requireArray(root, "cases", "capture manifest");
  if (values.length === 0) {
    return fail("TN_CPU_BENCH_MISSING_CASE", "the capture manifest has no cases");
  }
  const observations = values.map((value, index) => {
    const at = `capture manifest.cases[${index}]`;
    const entry = asRecord(value, at);
    const familyText = requireText(entry, "family", at);
    if (familyText !== "loop" && familyText !== "state") {
      return fail(
        "TN_CPU_BENCH_MISSING_CASE",
        `${at}.family '${familyText}' is not a workload family`,
      );
    }
    const family: "loop" | "state" = familyText;
    let samples = requirePositiveInteger(entry, "samples", at);
    if (samples < 1) return fail("TN_CPU_BENCH_MISSING_CASE", `${at} recorded no samples`);
    samples = Math.trunc(samples);
    const minNs = requireFinite(entry, "minNs", at);
    const maxNs = requireFinite(entry, "maxNs", at);
    const avgNs = requireFinite(entry, "avgNs", at);
    if (minNs < 0 || maxNs < 0 || avgNs < 0) {
      return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at} has a negative observation`);
    }
    if (maxNs < minNs) {
      return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at} has maxNs below minNs`);
    }
    if (avgNs < minNs || avgNs > maxNs) {
      return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at} has avgNs outside [minNs, maxNs]`);
    }
    return {
      alias: requireText(entry, "alias", at),
      avgNs,
      family,
      file: requireText(entry, "file", at),
      group: requireText(entry, "group", at),
      maxNs,
      minNs,
      samples,
    };
  });
  if (observations.length !== EXPECTED_CPU_CASES.length) {
    return fail(
      "TN_CPU_BENCH_MISSING_CASE",
      `expected ${EXPECTED_CPU_CASES.length} cases, found ${observations.length}`,
    );
  }
  for (const expected of EXPECTED_CPU_CASES) {
    if (
      !observations.some(
        (observation) =>
          observation.file === expected.file &&
          observation.alias === expected.alias &&
          observation.group === expected.group &&
          observation.family === expected.family,
      )
    ) {
      return fail("TN_CPU_BENCH_MISSING_CASE", `missing ${expected.file} '${expected.alias}'`);
    }
  }
  return observations;
}

function parseResult(root: Record<string, unknown>, caseCount: number): ICpuResultRef {
  const result = asRecord(root.result, "capture manifest.result");
  const file = requireText(result, "file", "capture manifest.result");
  assertRelativeRunPath(file);
  const benchmarkCount = requirePositiveInteger(
    result,
    "benchmarkCount",
    "capture manifest.result",
  );
  if (benchmarkCount !== caseCount) {
    return fail(
      "TN_CPU_BENCH_MISSING_CASE",
      `result.benchmarkCount ${benchmarkCount} does not match ${caseCount} observed cases`,
    );
  }
  return { benchmarkCount, file, sha256: requireSha(result, "sha256", "capture manifest.result") };
}

function parseRefArray(value: unknown, at: string): readonly ISha256Ref[] {
  return requireArrayValue(value, at).map((entry, index) => parseRef(entry, `${at}[${index}]`));
}

/**
 * Recompute every hash the manifest claims and reject a missing result, a tampered raw file, a
 * path outside its root, or a measured file that changed after capture. Both the run root and the
 * result path are canonicalized with `fs.realpath` first, so a symlink that escapes the run root
 * cannot pass lexical containment.
 */
export async function verifyCpuCaptureEvidence(
  manifest: ICpuCaptureManifest,
  runDirectory: string,
): Promise<void> {
  const runRoot = await realpathOrFail(path.resolve(runDirectory), "TN_CPU_BENCH_TAMPERED_PATH");
  const resultPath = await realpathOrFail(
    path.resolve(runRoot, manifest.result.file),
    "TN_CPU_BENCH_STALE_EVIDENCE",
  );
  assertWithin(runRoot, resultPath, "capture manifest.result.file", "TN_CPU_BENCH_TAMPERED_PATH");
  if (!statIs(resultPath, "file")) {
    return fail("TN_CPU_BENCH_STALE_EVIDENCE", `raw result ${manifest.result.file} is missing`);
  }
  const resultHash = await sha256File(resultPath);
  if (resultHash !== manifest.result.sha256) {
    return fail(
      "TN_CPU_BENCH_STALE_EVIDENCE",
      `raw result ${manifest.result.file} does not match its recorded hash`,
    );
  }
  let rawResult: unknown;
  try {
    rawResult = JSON.parse(await readFile(resultPath, "utf8"));
  } catch (error) {
    return fail(
      "TN_CPU_BENCH_STALE_EVIDENCE",
      `raw result ${manifest.result.file} is not parseable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const rawCases = collectCpuCaseObservations(rawResult);
  if (canonicalCaseSet(rawCases) !== canonicalCaseSet(manifest.cases)) {
    return fail(
      "TN_CPU_BENCH_STALE_EVIDENCE",
      `raw result ${manifest.result.file} does not match the manifest's recorded cases`,
    );
  }
  assertWithin(
    manifest.source.root,
    manifest.source.modules.loop.path,
    "source.modules.loop.path",
    "TN_CPU_BENCH_TAMPERED_PATH",
  );
  assertWithin(
    manifest.source.root,
    manifest.source.modules.state.path,
    "source.modules.state.path",
    "TN_CPU_BENCH_TAMPERED_PATH",
  );
  for (const ref of evidenceRefs(manifest)) {
    const resolved = await realpathOrFail(ref.path, "TN_CPU_BENCH_STALE_EVIDENCE");
    if (resolved !== ref.path) {
      return fail(
        "TN_CPU_BENCH_STALE_EVIDENCE",
        `recorded file ${ref.path} now resolves to ${resolved}`,
      );
    }
    if (!statIs(ref.path, "file")) {
      return fail("TN_CPU_BENCH_STALE_EVIDENCE", `recorded file ${ref.path} is missing`);
    }
    const actual = await sha256File(ref.path);
    if (actual !== ref.sha256) {
      return fail("TN_CPU_BENCH_STALE_EVIDENCE", `recorded file ${ref.path} changed since capture`);
    }
  }
}

function evidenceRefs(manifest: ICpuCaptureManifest): readonly ISha256Ref[] {
  const refs: ISha256Ref[] = [
    manifest.source.modules.loop,
    manifest.source.modules.state,
    manifest.source.modules.zustand,
    manifest.workload.config,
    ...manifest.workload.benches,
    ...manifest.workload.fixtures,
    ...manifest.source.dependencies,
  ];
  if (manifest.source.lock !== null) refs.push(manifest.source.lock);
  if (manifest.source.corePackage !== null) refs.push(manifest.source.corePackage);
  return refs;
}

/** Read, structurally validate, and disk-verify a completed capture manifest. */
export async function readCpuCaptureManifest(runDirectory: string): Promise<ICpuCaptureManifest> {
  const file = path.join(path.resolve(runDirectory), CPU_MANIFEST_FILE);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return fail(
      "TN_CPU_BENCH_BAD_MANIFEST",
      `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return fail(
      "TN_CPU_BENCH_BAD_MANIFEST",
      `could not parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const manifest = validateCpuCaptureManifest(parsed);
  await verifyCpuCaptureEvidence(manifest, runDirectory);
  return manifest;
}

/**
 * Write the manifest beside the untouched upstream result. Only a structurally valid manifest is
 * written; the raw Labs JSON is never read or rewritten here.
 */
export async function writeCpuCaptureManifest(
  runDirectory: string,
  manifest: ICpuCaptureManifest,
): Promise<string> {
  const validated = validateCpuCaptureManifest(manifest);
  const file = path.join(path.resolve(runDirectory), CPU_MANIFEST_FILE);
  await writeFile(file, `${JSON.stringify(validated, null, 2)}\n`);
  return file;
}

function sourceFingerprint(source: ICpuSourceIdentity): string {
  return JSON.stringify({
    commit: source.commit,
    corePackage:
      source.corePackage === null
        ? null
        : { path: source.corePackage.path, sha256: source.corePackage.sha256 },
    dependencies: source.dependencies.map((dependency) => ({
      name: dependency.name,
      path: dependency.path,
      sha256: dependency.sha256,
      version: dependency.version,
    })),
    dirty: source.dirty,
    lock: source.lock === null ? null : { path: source.lock.path, sha256: source.lock.sha256 },
    modules: MODULE_KEYS.map((key) => ({
      path: source.modules[key].path,
      sha256: source.modules[key].sha256,
    })),
  });
}

/** Invalidate a capture whose measured source, lock or package identity changed while it ran. */
export function assertSourceUnchanged(before: ICpuSourceIdentity, after: ICpuSourceIdentity): void {
  if (path.resolve(before.root) !== path.resolve(after.root)) {
    fail("TN_CPU_BENCH_SOURCE_CHANGED", "the measured source root changed during capture");
  }
  if (sourceFingerprint(before) !== sourceFingerprint(after)) {
    fail(
      "TN_CPU_BENCH_SOURCE_CHANGED",
      "the measured source, lock or dependency identity changed during capture",
    );
  }
}

function changedModules(a: ICpuCaptureManifest, b: ICpuCaptureManifest): readonly string[] {
  return MODULE_KEYS.filter((key) => a.source.modules[key].sha256 !== b.source.modules[key].sha256);
}

function workloadFingerprint(workload: ICpuWorkloadIdentity): string {
  return JSON.stringify({
    benches: workload.benches.map((ref) => ref.sha256).sort(),
    config: workload.config.sha256,
    fixtures: workload.fixtures.map((ref) => ref.sha256).sort(),
    match: workload.match,
  });
}

function tuningFingerprint(tuning: ICpuEffectiveTuning): string {
  return JSON.stringify({
    blockTime: tuning.blockTime,
    blocks: tuning.blocks,
    flags: [...tuning.flags].sort(),
    minSamples: tuning.minSamples,
  });
}

function incompatible(detail: string): never {
  return fail("TN_CPU_BENCH_INCOMPARABLE", `${detail}; the captures are not comparable`);
}

/**
 * Reject a comparison whose environments differ, whose runs are not distinct, or whose measured
 * subject is accidentally identical despite the labels. A same-source repeat needs an explicit
 * named control; dependencies and lockfiles are provenance, never a measured subject.
 */
export function assertCompatibleCpuCaptures(
  baseline: ICpuCaptureManifest,
  candidate: ICpuCaptureManifest,
  options: ICpuCompareOptions = {},
): ICpuCompatibility {
  const left = validateCpuCaptureManifest(baseline);
  const right = validateCpuCaptureManifest(candidate);
  // `result.file` is run-relative, so two independently captured runs may share it; only the run
  // id and the raw-result bytes identify the same artifact.
  if (left.runId === right.runId || left.result.sha256 === right.result.sha256) {
    return fail(
      "TN_CPU_BENCH_SELF_COMPARISON",
      "baseline and candidate are the same capture artifact",
    );
  }
  if (left.tool.package !== right.tool.package || left.tool.version !== right.tool.version) {
    incompatible(
      `tool environments differ (${left.tool.package}@${left.tool.version} vs ${right.tool.package}@${right.tool.version})`,
    );
  }
  for (const key of ["node", "v8", "platform", "arch", "cpuModel"] as const) {
    if (left.worker[key] !== right.worker[key]) {
      incompatible(`worker ${key} differs (${left.worker[key]} vs ${right.worker[key]})`);
    }
  }
  if (workloadFingerprint(left.workload) !== workloadFingerprint(right.workload)) {
    incompatible("workload or config hashes differ");
  }
  if (tuningFingerprint(left.tuning) !== tuningFingerprint(right.tuning)) {
    incompatible("effective tuning or flags differ");
  }

  const changed = changedModules(left, right);
  const sameContent = changed.length === 0;
  const sameCommit = left.source.commit === right.source.commit;
  if (sameContent && !sameCommit) {
    return fail(
      "TN_CPU_BENCH_IDENTICAL_SUBJECT",
      `measured files are byte-identical across commits ${left.source.commit} and ${right.source.commit}`,
    );
  }
  if (!sameContent && sameCommit && !left.source.dirty && !right.source.dirty) {
    return fail(
      "TN_CPU_BENCH_STALE_EVIDENCE",
      `commit ${left.source.commit} carries two different measured-file identities across two clean captures`,
    );
  }

  const warnings: string[] = [];
  const control = options.control;
  if (control !== undefined && !CONTROL_NAME.test(control)) {
    return fail(
      "TN_CPU_BENCH_BAD_CONTROL",
      `control name '${control}' must match [A-Za-z0-9][A-Za-z0-9._-]*`,
    );
  }
  let mode: "comparison" | "control";
  if (sameContent && sameCommit) {
    if (control === undefined) {
      return fail(
        "TN_CPU_BENCH_SAME_SOURCE",
        "the measured source is identical; rerun only under a named control",
      );
    }
    mode = "control";
  } else {
    mode = "comparison";
    if (control !== undefined) {
      warnings.push(`control '${control}' was named but the measured sources differ`);
    }
  }
  const provenanceOnly = lockDifference(left, right);
  if (provenanceOnly) {
    warnings.push("lock/dependency provenance differs; it is not a measured subject change");
  }
  return {
    changedModules: [...changed],
    controlName: mode === "control" ? (control ?? null) : null,
    mode,
    sameSource: sameContent,
    warnings,
  };
}

function lockDifference(a: ICpuCaptureManifest, b: ICpuCaptureManifest): boolean {
  if ((a.source.lock?.sha256 ?? null) !== (b.source.lock?.sha256 ?? null)) return true;
  if ((a.source.corePackage?.sha256 ?? null) !== (b.source.corePackage?.sha256 ?? null))
    return true;
  const dependencies = (source: ICpuSourceIdentity): string =>
    source.dependencies
      .map((entry) => `${entry.name}@${entry.version}:${entry.sha256}`)
      .sort()
      .join(",");
  return dependencies(a.source) !== dependencies(b.source);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatSource(manifest: ICpuCaptureManifest): string {
  return [
    `  source root : ${manifest.source.root}`,
    `  commit      : ${manifest.source.commit}${manifest.source.dirty ? " (dirty)" : ""}`,
    `  run         : ${manifest.runId}`,
    `  result      : ${manifest.result.file} sha256 ${manifest.result.sha256.slice(0, 12)}`,
    `  tool        : ${manifest.tool.package}@${manifest.tool.version}`,
    `  worker      : node ${manifest.worker.node} / v8 ${manifest.worker.v8} / ${manifest.worker.platform}-${manifest.worker.arch}`,
    `  cpu         : ${manifest.worker.cpuModel}`,
    `  cases       : ${manifest.cases.length}`,
  ].join("\n");
}

/**
 * Render the upstream Labs comparison as an advisory CPU-only report. The human-readable stdout is
 * stripped of ANSI for presentation with `util.stripVTControlCharacters`; the raw output is kept
 * beside it. The upstream exit code is reported, never converted into a verdict.
 */
export function emitCpuComparisonReport(input: ICpuComparisonReportInput): string {
  const baseline = validateCpuCaptureManifest(input.baseline);
  const candidate = validateCpuCaptureManifest(input.candidate);
  const stripped = stripVTControlCharacters(input.upstream.stdout);
  const changed = input.compatibility.changedModules;
  const changedText = changed.length === 0 ? "(none recorded)" : changed.join(", ");
  const warningText =
    input.compatibility.warnings.length === 0
      ? "  (none)"
      : input.compatibility.warnings.map((warning) => `  - ${warning}`).join("\n");
  if (input.format === "html") {
    const block = (label: string, value: string): string =>
      `<h3>${escapeHtml(label)}</h3><pre>${escapeHtml(value)}</pre>`;
    return [
      "<section>",
      `<h2>CPU-only comparison — ${escapeHtml(CPU_DOMAIN)}</h2>`,
      `<p>${escapeHtml(CPU_COMPARISON_DISCLAIMER)}</p>`,
      block(
        "Mode",
        `${input.compatibility.mode}${input.compatibility.controlName === null ? "" : ` (${input.compatibility.controlName})`}`,
      ),
      block("Changed measured modules", changedText),
      block("Warnings", input.compatibility.warnings.join("\n") || "(none)"),
      block("Baseline", formatSource(baseline)),
      block("Candidate", formatSource(candidate)),
      block("Upstream Labs comparison (unclassified)", `exit code: ${input.upstream.exitCode}`),
      block("Upstream stderr", input.upstream.stderr),
      block("Upstream stdout (ANSI-stripped)", stripped),
      block("Raw upstream stdout (retained)", input.upstream.stdout),
      "</section>",
    ].join("\n");
  }
  return [
    `CPU-only comparison — ${CPU_DOMAIN}`,
    CPU_COMPARISON_DISCLAIMER,
    "",
    `Mode: ${input.compatibility.mode}${
      input.compatibility.controlName === null ? "" : ` (${input.compatibility.controlName})`
    }`,
    `Changed measured modules: ${changedText}`,
    "Warnings:",
    warningText,
    "",
    "Baseline",
    formatSource(baseline),
    "",
    "Candidate",
    formatSource(candidate),
    "",
    "Upstream Labs comparison (unclassified)",
    `  exit code: ${input.upstream.exitCode}`,
    "  upstream stderr:",
    input.upstream.stderr.trim() === "" ? "    (empty)" : indent(input.upstream.stderr),
    "  upstream stdout (ANSI-stripped):",
    stripped.trim() === "" ? "    (empty)" : indent(stripped),
    "  raw upstream stdout (retained for integration):",
    input.upstream.stdout.trim() === "" ? "    (empty)" : indent(input.upstream.stdout),
    "",
  ].join("\n");
}

function indent(value: string): string {
  return value
    .replace(/\n$/u, "")
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

// Structural readers. Each throws a named BenchError rather than defaulting a value.

function asRecord(value: unknown, at: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireText(record: Record<string, unknown>, key: string, at: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at}.${key} must be a non-empty string`);
  }
  return value;
}

function requireStringValue(value: unknown, at: string): string {
  if (typeof value !== "string" || value.length === 0) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at} must be a non-empty string`);
  }
  return value;
}

function requireFinite(record: Record<string, unknown>, key: string, at: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at}.${key} must be a finite number`);
  }
  return value;
}

function requireNullableFinite(
  record: Record<string, unknown>,
  key: string,
  at: string,
): number | null {
  if (record[key] === null || record[key] === undefined) return null;
  return requireFinite(record, key, at);
}

function requirePositiveInteger(record: Record<string, unknown>, key: string, at: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at}.${key} must be a positive integer`);
  }
  return value;
}

function requireNullableInteger(
  record: Record<string, unknown>,
  key: string,
  at: string,
): number | null {
  if (record[key] === null || record[key] === undefined) return null;
  return requirePositiveInteger(record, key, at);
}

function requireBoolean(record: Record<string, unknown>, key: string, at: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at}.${key} must be a boolean`);
  }
  return value;
}

function requireArray(record: Record<string, unknown>, key: string, at: string): unknown[] {
  return requireArrayValue(record[key], `${at}.${key}`);
}

function requireArrayValue(value: unknown, at: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at} must be an array`);
  }
  return value;
}

function requireSha(record: Record<string, unknown>, key: string, at: string): string {
  const value = requireText(record, key, at);
  if (!HASH_PATTERN.test(value)) {
    return fail("TN_CPU_BENCH_BAD_MANIFEST", `${at}.${key} is not a sha256 digest`);
  }
  return value;
}

function requireTimestamp(record: Record<string, unknown>, key: string): string {
  const value = requireText(record, key, "capture manifest");
  if (!Number.isFinite(Date.parse(value))) {
    return fail("TN_CPU_BENCH_BAD_TIME", `capture manifest.${key} '${value}' is not a timestamp`);
  }
  return value;
}

function assertRelativeRunPath(file: string): void {
  if (path.isAbsolute(file)) {
    fail("TN_CPU_BENCH_TAMPERED_PATH", `result.file '${file}' must be run-relative`);
  }
  const segments = file.split(/[\\/]/u);
  if (segments.some((segment) => segment === ".." || segment === "")) {
    fail("TN_CPU_BENCH_TAMPERED_PATH", `result.file '${file}' traverses its run directory`);
  }
}

function assertWithin(root: string, target: string, at: string, code: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    fail(code, `${at} '${target}' is outside ${root}`);
  }
}
