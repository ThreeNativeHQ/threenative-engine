import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  CPU_CAPTURE_SCHEMA,
  CPU_COMPARISON_DISCLAIMER,
  CPU_MANIFEST_FILE,
  EXPECTED_CPU_CASES,
  type ICpuCaptureManifest,
  type ICpuCaseObservation,
  type ICpuEffectiveTuning,
  type ICpuSourceIdentity,
  type ICpuWorkerIdentity,
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
  validateCpuCaptureManifest,
  verifyCpuCaptureEvidence,
  writeCpuCaptureManifest,
} from "../performance-regression/cpu-report.js";

const execFileAsync = promisify(execFile);

async function tempDir(prefix: string): Promise<string> {
  return makeTempDir(prefix);
}

function hex(seed: string): string {
  return createHash("sha256").update(seed).digest("hex");
}

function ref(seed: string, file = `/src/${seed}`): { path: string; sha256: string } {
  return { path: file, sha256: hex(seed) };
}

function expectedCases(): ICpuCaseObservation[] {
  return EXPECTED_CPU_CASES.map((entry, index) => ({
    alias: entry.alias,
    avgNs: 100 + index,
    family: entry.family,
    file: entry.file,
    group: entry.group,
    maxNs: 200 + index,
    minNs: 10 + index,
    samples: 8,
  }));
}

function rawLabsResult(
  cases: readonly ICpuCaseObservation[] = expectedCases(),
): Record<string, unknown> {
  const byFile = new Map<string, Record<string, unknown>[]>();
  for (const entry of cases) {
    const benchmarks = byFile.get(entry.file) ?? [];
    benchmarks.push({
      alias: entry.alias,
      groupName: entry.group,
      runs: [
        {
          stats: {
            avg: entry.avgNs,
            max: entry.maxNs,
            min: entry.minNs,
            samples: Array.from({ length: entry.samples }, (_, index) => entry.minNs + index),
          },
        },
      ],
    });
    byFile.set(entry.file, benchmarks);
  }
  return { files: [...byFile].map(([file, benchmarks]) => ({ benchmarks, file })) };
}

interface IManifestSpec {
  readonly commit?: string;
  readonly dirty?: boolean;
  readonly lock?: string | null;
  readonly modules?: { readonly loop?: string; readonly state?: string; readonly zustand?: string };
  readonly resultFile?: string;
  readonly resultSha?: string;
  readonly runId?: string;
  readonly toolVersion?: string;
  readonly tuningBlocks?: number;
  readonly worker?: Partial<ICpuWorkerIdentity>;
  readonly workloadConfig?: string;
}

function makeSource(spec: IManifestSpec): ICpuSourceIdentity {
  const zustand = spec.modules?.zustand ?? "z";
  return {
    commit: spec.commit ?? "a".repeat(40),
    corePackage: ref("p"),
    dependencies: [{ name: "zustand", path: "/src/z", sha256: hex(zustand), version: "5.0.14" }],
    dirty: spec.dirty ?? false,
    lock: spec.lock === undefined ? ref("l") : spec.lock === null ? null : ref(spec.lock),
    modules: {
      loop: { path: "/src/loop.ts", sha256: hex(spec.modules?.loop ?? "o") },
      state: { path: "/src/state.ts", sha256: hex(spec.modules?.state ?? "s") },
      zustand: { path: "/src/z", sha256: hex(zustand), specifier: "zustand/vanilla" },
    },
    root: "/src",
  };
}

function makeTuning(blocks: number): ICpuEffectiveTuning {
  return {
    benchDir: "/tool/benches",
    blocks,
    blockTime: 0.05,
    flags: ["run", "--force"],
    minSamples: 5,
    resultsDir: "labs/results",
  };
}

function manifest(spec: IManifestSpec = {}): ICpuCaptureManifest {
  return buildCpuCaptureManifest({
    cases: expectedCases(),
    endedAt: "2026-10-07T00:00:02.000Z",
    name: "run",
    result: {
      benchmarkCount: 6,
      file: spec.resultFile ?? "labs/results/run.json",
      sha256: hex(spec.resultSha ?? "r"),
    },
    runId: spec.runId ?? "2026-10-07T00-00-00-000Z-run",
    source: makeSource(spec),
    startedAt: "2026-10-07T00:00:00.000Z",
    tool: {
      executable: "/labs/cli.mjs",
      package: "@pmndrs/labs",
      version: spec.toolVersion ?? "0.9.0",
    },
    tuning: makeTuning(spec.tuningBlocks ?? 8),
    worker: {
      arch: "x64",
      cpuCount: 12,
      cpuModel: "Test CPU",
      node: "22.22.0",
      platform: "linux",
      v8: "12.4.254.21",
      ...spec.worker,
    },
    workload: {
      benches: [ref("b1"), ref("b2")],
      config: ref(spec.workloadConfig ?? "c"),
      fixtures: [ref("f1"), ref("f2"), ref("f3")],
      match: "**/*.bench.ts",
    },
  });
}

function rebuild(base: ICpuCaptureManifest, mutate: (clone: Record<string, unknown>) => void) {
  const clone = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  mutate(clone);
  return clone;
}

describe("manifest schema", () => {
  it("accepts a complete manifest and rejects a missing case", () => {
    const complete = manifest();
    expect(complete.schema).toBe(CPU_CAPTURE_SCHEMA);
    expect(complete.cases).toHaveLength(6);

    const missing = rebuild(complete, (clone) => {
      (clone.cases as unknown[]).pop();
    });
    expect(() => validateCpuCaptureManifest(missing)).toThrow(/TN_CPU_BENCH_MISSING_CASE/);
  });

  it("rejects an incomplete, untimed or unqualified tool manifest", () => {
    expect(() =>
      validateCpuCaptureManifest(
        rebuild(manifest(), (clone) => {
          clone.completed = false;
        }),
      ),
    ).toThrow(/TN_CPU_BENCH_INCOMPLETE/);
    expect(() =>
      validateCpuCaptureManifest(
        rebuild(manifest(), (clone) => {
          clone.endedAt = "2026-10-06T00:00:00.000Z";
        }),
      ),
    ).toThrow(/TN_CPU_BENCH_BAD_TIME/);
    expect(() => manifest({ toolVersion: "0.8.0" })).toThrow(/TN_CPU_BENCH_BAD_TOOL/);
  });

  it("rejects a raw-result path that traverses its run directory", () => {
    expect(() => manifest({ resultFile: "../escape.json" })).toThrow(/TN_CPU_BENCH_TAMPERED_PATH/);
    expect(() => manifest({ resultFile: "/absolute.json" })).toThrow(/TN_CPU_BENCH_TAMPERED_PATH/);
  });
});

describe("case observations", () => {
  function rawCase(file: string, entry: (typeof EXPECTED_CPU_CASES)[number], extra = {}) {
    return {
      alias: entry.alias,
      groupName: entry.group,
      runs: [{ stats: { avg: 5, max: 9, min: 1, samples: [1, 2, 3] } }],
      ...extra,
    };
  }

  function rawResult(): Record<string, unknown> {
    return {
      files: [
        {
          benchmarks: EXPECTED_CPU_CASES.filter((entry) => entry.file === "loop.bench.ts").map(
            (entry) => rawCase("loop.bench.ts", entry),
          ),
          file: "loop.bench.ts",
        },
        {
          benchmarks: EXPECTED_CPU_CASES.filter((entry) => entry.file === "state.bench.ts").map(
            (entry) => rawCase("state.bench.ts", entry),
          ),
          file: "state.bench.ts",
        },
      ],
    };
  }

  it("extracts the six owned cases in order", () => {
    const observations = collectCpuCaseObservations(rawResult());
    expect(observations.map((entry) => entry.alias)).toEqual(
      EXPECTED_CPU_CASES.map((entry) => entry.alias),
    );
    expect(observations.every((entry) => entry.samples === 3)).toBe(true);
  });

  it("fails on a zero case set or a missing owned case", () => {
    expect(() => collectCpuCaseObservations({ files: [] })).toThrow(/TN_CPU_BENCH_EMPTY_RESULT/);
    const broken = rawResult();
    const firstFile = (broken.files as Record<string, unknown>[])[0] as Record<string, unknown>;
    (firstFile.benchmarks as unknown[]).pop();
    expect(() => collectCpuCaseObservations(broken)).toThrow(/TN_CPU_BENCH_MISSING_CASE/);
  });

  it("fails when a run recorded an error or an unowned alias", () => {
    const errored = rawResult();
    const files = errored.files as Record<string, unknown>[];
    const firstBench = (files[0]?.benchmarks as Record<string, unknown>[])[0];
    if (firstBench === undefined) throw new Error("fixture is missing its first benchmark");
    const firstRun = (firstBench.runs as Record<string, unknown>[])[0];
    if (firstRun === undefined) throw new Error("fixture is missing its first run");
    firstRun.error = "assertion failed";
    expect(() => collectCpuCaseObservations(errored)).toThrow(/TN_CPU_BENCH_CASE_ERROR/);

    const foreign = rawResult();
    const foreignFiles = foreign.files as Record<string, unknown>[];
    const foreignBench = (foreignFiles[0]?.benchmarks as Record<string, unknown>[])[0];
    if (foreignBench === undefined) throw new Error("fixture is missing its first benchmark");
    foreignBench.alias = "dispatch 7";
    expect(() => collectCpuCaseObservations(foreign)).toThrow(/TN_CPU_BENCH_UNEXPECTED_CASE/);
  });

  it("rejects a duplicate owned case instead of silently overwriting it", () => {
    const duplicated = rawResult();
    const files = duplicated.files as Record<string, unknown>[];
    const benchmarks = (files[0] as Record<string, unknown>).benchmarks as Record<
      string,
      unknown
    >[];
    benchmarks.push(JSON.parse(JSON.stringify(benchmarks[0])) as Record<string, unknown>);
    expect(() => collectCpuCaseObservations(duplicated)).toThrow(/TN_CPU_BENCH_UNEXPECTED_CASE/);
  });

  it("rejects extra runs, including a later run that recorded an error", () => {
    const partial = rawResult();
    const files = partial.files as Record<string, unknown>[];
    const bench = (files[0]?.benchmarks as Record<string, unknown>[])[0];
    if (bench === undefined) throw new Error("fixture is missing its first benchmark");
    (bench.runs as unknown[]).push({ stats: { avg: 1, max: 2, min: 0, samples: [0] } });
    expect(() => collectCpuCaseObservations(partial)).toThrow(/TN_CPU_BENCH_CASE_ERROR/);

    const laterError = rawResult();
    const errorFiles = laterError.files as Record<string, unknown>[];
    const errorBench = (errorFiles[0]?.benchmarks as Record<string, unknown>[])[0];
    if (errorBench === undefined) throw new Error("fixture is missing its first benchmark");
    errorBench.runs = [
      { stats: { avg: 1, max: 2, min: 0, samples: [0] } },
      { error: "boom", stats: { avg: 1, max: 2, min: 0, samples: [0] } },
    ];
    expect(() => collectCpuCaseObservations(laterError)).toThrow(/TN_CPU_BENCH_CASE_ERROR/);
  });

  it("rejects a non-finite sample, a negative stat or inconsistent stats", () => {
    const badSample = rawResult();
    const sampleFiles = badSample.files as Record<string, unknown>[];
    const sampleBench = (sampleFiles[0]?.benchmarks as Record<string, unknown>[])[0];
    if (sampleBench === undefined) throw new Error("fixture is missing its first benchmark");
    const sampleRun = (sampleBench.runs as Record<string, unknown>[])[0];
    if (sampleRun === undefined) throw new Error("fixture is missing its first run");
    (sampleRun.stats as Record<string, unknown>).samples = [1, Number.NaN, 3];
    expect(() => collectCpuCaseObservations(badSample)).toThrow(/TN_CPU_BENCH_CASE_ERROR/);

    const negative = rawResult();
    const negativeFiles = negative.files as Record<string, unknown>[];
    const negativeBench = (negativeFiles[0]?.benchmarks as Record<string, unknown>[])[0];
    if (negativeBench === undefined) throw new Error("fixture is missing its first benchmark");
    const negativeRun = (negativeBench.runs as Record<string, unknown>[])[0];
    if (negativeRun === undefined) throw new Error("fixture is missing its first run");
    (negativeRun.stats as Record<string, unknown>).min = -1;
    expect(() => collectCpuCaseObservations(negative)).toThrow(/TN_CPU_BENCH_CASE_ERROR/);

    const inconsistent = rawResult();
    const incFiles = inconsistent.files as Record<string, unknown>[];
    const incBench = (incFiles[0]?.benchmarks as Record<string, unknown>[])[0];
    if (incBench === undefined) throw new Error("fixture is missing its first benchmark");
    const incRun = (incBench.runs as Record<string, unknown>[])[0];
    if (incRun === undefined) throw new Error("fixture is missing its first run");
    (incRun.stats as Record<string, unknown>).avg = 1000;
    expect(() => collectCpuCaseObservations(inconsistent)).toThrow(/TN_CPU_BENCH_CASE_ERROR/);
  });
});

async function writeCheckout(): Promise<string> {
  const root = await tempDir("tn-cpu-report-src-");
  await mkdir(path.join(root, "packages/core/src"), { recursive: true });
  await mkdir(path.join(root, "node_modules/zustand"), { recursive: true });
  await writeFile(path.join(root, "packages/core/src/loop.ts"), "export const loop = 1;\n");
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
  await execFileAsync("git", ["init", "-q"], { cwd: root });
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.email=agent@test", "-c", "user.name=agent", "commit", "-q", "-m", "seed"],
    { cwd: root },
  );
  return root;
}

describe("source identity", () => {
  it("resolves the real ESM zustand entry from the selected checkout", async () => {
    const root = await writeCheckout();
    const source = await collectCpuSourceIdentity({
      env: {},
      nodeExecutable: process.execPath,
      root,
    });
    expect(source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(source.dirty).toBe(false);
    expect(source.modules.zustand.path).toBe(path.join(root, "node_modules/zustand/vanilla.js"));
    expect(source.dependencies[0]?.version).toBe("5.0.14");
    expect(source.modules.state.sha256).toBe(
      await sha256File(path.join(root, "packages/core/src/state.ts")),
    );
  });

  it("invalidates a capture when the measured source changes", async () => {
    const root = await writeCheckout();
    const before = await collectCpuSourceIdentity({
      env: {},
      nodeExecutable: process.execPath,
      root,
    });
    await writeFile(path.join(root, "packages/core/src/loop.ts"), "export const loop = 2;\n");
    const after = await collectCpuSourceIdentity({
      env: {},
      nodeExecutable: process.execPath,
      root,
    });
    expect(() => assertSourceUnchanged(before, after)).toThrow(/TN_CPU_BENCH_SOURCE_CHANGED/);
  });

  it("rejects a measured module that escapes the selected root through a symlink", async () => {
    const root = await writeCheckout();
    const outside = await tempDir("tn-cpu-report-outside-");
    const outsideLoop = path.join(outside, "loop.ts");
    await writeFile(outsideLoop, "export const loop = 1;\n");
    const link = path.join(root, "packages/core/src/loop.ts");
    await rm(link, { force: true });
    await symlink(outsideLoop, link);
    await expect(
      collectCpuSourceIdentity({ env: {}, nodeExecutable: process.execPath, root }),
    ).rejects.toThrow(/TN_CPU_BENCH_TAMPERED_PATH/);
  });

  it("detects a symlink retarget that keeps identical bytes", async () => {
    const root = await writeCheckout();
    const sourceDirectory = path.join(root, "packages/core/src");
    const bytes = "export const loop = 1;\n";
    await writeFile(path.join(sourceDirectory, "loop-a.ts"), bytes);
    await writeFile(path.join(sourceDirectory, "loop-b.ts"), bytes);
    const link = path.join(sourceDirectory, "loop.ts");
    await rm(link, { force: true });
    await symlink("loop-a.ts", link);
    const before = await collectCpuSourceIdentity({
      env: {},
      nodeExecutable: process.execPath,
      root,
    });
    await rm(link, { force: true });
    await symlink("loop-b.ts", link);
    const after = await collectCpuSourceIdentity({
      env: {},
      nodeExecutable: process.execPath,
      root,
    });
    expect(before.modules.loop.sha256).toBe(after.modules.loop.sha256);
    expect(before.modules.loop.path).not.toBe(after.modules.loop.path);
    expect(() => assertSourceUnchanged(before, after)).toThrow(/TN_CPU_BENCH_SOURCE_CHANGED/);
  });
});

describe("worker identity", () => {
  it("probes the selected Node executable, not the wrapper", async () => {
    const worker = await collectCpuWorkerIdentity({ env: {}, nodeExecutable: process.execPath });
    expect(worker.node).toBe(process.versions.node);
    expect(worker.v8).toBe(process.versions.v8);
    expect(worker.cpuCount).toBeGreaterThan(0);
    expect(worker.platform).toBe(process.platform);
  });
});

describe("effective tuning", () => {
  it("records parsed knobs and leaves an unset knob null", () => {
    const tuning = collectCpuEffectiveTuning({
      benchDir: "/tool/benches",
      blocks: 8,
      env: { TN_CPU_BENCH_BLOCK_TIME: "0.05" },
      flags: ["run", "--force"],
      resultsDir: "labs/results",
    });
    expect(tuning.blocks).toBe(8);
    expect(tuning.blockTime).toBe(0.05);
    expect(tuning.minSamples).toBeNull();
  });

  it("throws on a present but invalid tuning number instead of nulling it", () => {
    const base = {
      benchDir: "/tool/benches",
      blocks: 8,
      flags: ["run", "--force"],
      resultsDir: "labs/results",
    } as const;
    for (const env of [
      { TN_CPU_BENCH_BLOCK_TIME: "abc" },
      { TN_CPU_BENCH_BLOCK_TIME: "-1" },
      { TN_CPU_BENCH_MIN_SAMPLES: "2.5" },
      { TN_CPU_BENCH_MIN_SAMPLES: "0" },
    ]) {
      expect(() => collectCpuEffectiveTuning({ ...base, env })).toThrow(/TN_CPU_BENCH_BAD_TUNING/);
    }
  });
});

interface IDiskRun {
  readonly manifest: ICpuCaptureManifest;
  readonly resultFile: string;
  readonly runDirectory: string;
}

async function diskRun(): Promise<IDiskRun> {
  const sourceRoot = await writeCheckout();
  const toolDir = await tempDir("tn-cpu-report-tool-");
  await mkdir(path.join(toolDir, "benches"), { recursive: true });
  await mkdir(path.join(toolDir, "workloads"), { recursive: true });
  await writeFile(path.join(toolDir, "labs.config.ts"), "export default {};\n");
  for (const file of ["benches/loop.bench.ts", "benches/state.bench.ts"]) {
    await writeFile(path.join(toolDir, file), `// ${file}\n`);
  }
  for (const file of [
    "workloads/selected-source.ts",
    "workloads/loop-workload.ts",
    "workloads/state-workload.ts",
  ]) {
    await writeFile(path.join(toolDir, file), `// ${file}\n`);
  }
  const runDirectory = await tempDir("tn-cpu-report-run-");
  const resultFile = path.join(runDirectory, "labs/results/run.json");
  await mkdir(path.dirname(resultFile), { recursive: true });
  await writeFile(resultFile, JSON.stringify(rawLabsResult()));

  const source = await collectCpuSourceIdentity({
    env: {},
    nodeExecutable: process.execPath,
    root: sourceRoot,
  });
  const manifest = buildCpuCaptureManifest({
    cases: expectedCases(),
    endedAt: "2026-10-07T00:00:02.000Z",
    name: "run",
    result: {
      benchmarkCount: 6,
      file: path.relative(runDirectory, resultFile),
      sha256: await sha256File(resultFile),
    },
    runId: "2026-10-07T00-00-00-000Z-run",
    source,
    startedAt: "2026-10-07T00:00:00.000Z",
    tool: { executable: "/labs/cli.mjs", package: "@pmndrs/labs", version: "0.9.0" },
    tuning: makeTuning(8),
    worker: {
      arch: "x64",
      cpuCount: 12,
      cpuModel: "Test CPU",
      node: "22.22.0",
      platform: "linux",
      v8: "12.4.254.21",
    },
    workload: await collectCpuWorkloadIdentity({ toolDir }),
  });
  await writeCpuCaptureManifest(runDirectory, manifest);
  return { manifest, resultFile, runDirectory };
}

describe("completed manifest on disk", () => {
  it("round-trips, leaves the upstream JSON untouched, and rejects a tampered result", async () => {
    const { manifest: written, resultFile, runDirectory } = await diskRun();
    const rawBefore = await readFile(resultFile, "utf8");
    const read = await readCpuCaptureManifest(runDirectory);
    expect(read.result.sha256).toBe(written.result.sha256);
    expect(await readFile(resultFile, "utf8")).toBe(rawBefore);
    expect(await readFile(path.join(runDirectory, CPU_MANIFEST_FILE), "utf8")).toContain(
      CPU_CAPTURE_SCHEMA,
    );

    await writeFile(resultFile, JSON.stringify({ files: [{ tampered: true }] }));
    await expect(readCpuCaptureManifest(runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_STALE_EVIDENCE/,
    );
  });

  it("rejects a raw result symlinked outside the run directory despite identical bytes", async () => {
    const { resultFile, runDirectory } = await diskRun();
    const outside = await tempDir("tn-cpu-report-result-outside-");
    const outsideResult = path.join(outside, "run.json");
    await writeFile(outsideResult, await readFile(resultFile, "utf8"));
    await rm(resultFile, { force: true });
    await symlink(outsideResult, resultFile);
    await expect(readCpuCaptureManifest(runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_TAMPERED_PATH/,
    );
  });

  it("rejects a recorded file retargeted to a same-byte symlink outside its root", async () => {
    const { manifest: written, runDirectory } = await diskRun();
    const outside = await tempDir("tn-cpu-report-module-outside-");
    const outsideLoop = path.join(outside, "loop.ts");
    await writeFile(outsideLoop, await readFile(written.source.modules.loop.path, "utf8"));
    await rm(written.source.modules.loop.path, { force: true });
    await symlink(outsideLoop, written.source.modules.loop.path);
    await expect(readCpuCaptureManifest(runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_STALE_EVIDENCE/,
    );
  });

  it("rejects a measured file that changed after capture", async () => {
    const { manifest: written, runDirectory } = await diskRun();
    await writeFile(written.source.modules.loop.path, "export const loop = 99;\n");
    await expect(readCpuCaptureManifest(runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_STALE_EVIDENCE/,
    );
  });

  it("rejects a module path outside its recorded source root", async () => {
    const { manifest: base, runDirectory } = await diskRun();
    const tampered = validateCpuCaptureManifest(
      rebuild(base, (clone) => {
        (
          ((clone.source as Record<string, unknown>).modules as Record<string, unknown>)
            .loop as Record<string, unknown>
        ).path = path.join(tmpdir(), "outside-loop.ts");
      }),
    );
    await expect(verifyCpuCaptureEvidence(tampered, runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_TAMPERED_PATH/,
    );
  });

  it("rejects a manifest whose cases disagree with the hashed raw result", async () => {
    const { manifest: written, runDirectory } = await diskRun();
    const tampered = validateCpuCaptureManifest(
      rebuild(written, (clone) => {
        ((clone.cases as Record<string, unknown>[])[0] as Record<string, unknown>).avgNs = 150;
      }),
    );
    await expect(verifyCpuCaptureEvidence(tampered, runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_STALE_EVIDENCE/,
    );
  });

  it("rejects a crafted raw result with a matching hash but too few cases", async () => {
    const { manifest: written, resultFile, runDirectory } = await diskRun();
    await writeFile(resultFile, JSON.stringify(rawLabsResult(expectedCases().slice(0, 5))));
    const matchingHash = await sha256File(resultFile);
    const matching = validateCpuCaptureManifest(
      rebuild(written, (clone) => {
        (clone.result as Record<string, unknown>).sha256 = matchingHash;
      }),
    );
    await expect(verifyCpuCaptureEvidence(matching, runDirectory)).rejects.toThrow(
      /TN_CPU_BENCH_MISSING_CASE/,
    );
  });
});

describe("compatibility", () => {
  it("rejects self-comparison and a same-source run without a control", () => {
    const first = manifest();
    expect(() => assertCompatibleCpuCaptures(first, manifest())).toThrow(
      /TN_CPU_BENCH_SELF_COMPARISON/,
    );
    const repeat = manifest({
      resultFile: "labs/results/repeat.json",
      resultSha: "q",
      runId: "repeat",
    });
    expect(() => assertCompatibleCpuCaptures(first, repeat)).toThrow(/TN_CPU_BENCH_SAME_SOURCE/);
  });

  it("allows an explicitly named control over distinct repeated runs", () => {
    const first = manifest();
    const repeat = manifest({
      resultFile: "labs/results/repeat.json",
      resultSha: "q",
      runId: "repeat",
    });
    const compatibility = assertCompatibleCpuCaptures(first, repeat, { control: "repeat-1" });
    expect(compatibility.mode).toBe("control");
    expect(compatibility.sameSource).toBe(true);
    expect(compatibility.controlName).toBe("repeat-1");
  });

  it("rejects byte-identical measured content across different commit labels", () => {
    const first = manifest({ commit: "a".repeat(40) });
    const other = manifest({
      commit: "b".repeat(40),
      resultFile: "labs/results/other.json",
      resultSha: "q",
      runId: "other",
    });
    expect(() => assertCompatibleCpuCaptures(first, other, { control: "control" })).toThrow(
      /TN_CPU_BENCH_IDENTICAL_SUBJECT/,
    );
  });

  it("treats a lock-only difference as provenance, not a changed subject", () => {
    const first = manifest({ lock: "l" });
    const other = manifest({
      lock: "m",
      resultFile: "labs/results/other.json",
      resultSha: "q",
      runId: "other",
    });
    const compatibility = assertCompatibleCpuCaptures(first, other, { control: "repeat-2" });
    expect(compatibility.changedModules).toEqual([]);
    expect(compatibility.warnings.join(" ")).toMatch(/provenance/);
  });

  it("compares genuinely different measured subjects", () => {
    const first = manifest({ commit: "a".repeat(40) });
    const other = manifest({
      commit: "b".repeat(40),
      modules: { loop: "L", state: "S", zustand: "Z" },
      resultFile: "labs/results/other.json",
      resultSha: "q",
      runId: "other",
    });
    const compatibility = assertCompatibleCpuCaptures(first, other);
    expect(compatibility.mode).toBe("comparison");
    expect(compatibility.changedModules).toEqual(["loop", "state", "zustand"]);
  });

  it("rejects mismatched worker, workload or tuning environments", () => {
    const base = manifest();
    const otherRun = { resultFile: "labs/results/other.json", resultSha: "q", runId: "other" };
    expect(() =>
      assertCompatibleCpuCaptures(
        base,
        manifest({ ...otherRun, worker: { cpuModel: "Other CPU" } }),
      ),
    ).toThrow(/TN_CPU_BENCH_INCOMPARABLE/);
    expect(() =>
      assertCompatibleCpuCaptures(base, manifest({ ...otherRun, workloadConfig: "different" })),
    ).toThrow(/TN_CPU_BENCH_INCOMPARABLE/);
    expect(() =>
      assertCompatibleCpuCaptures(base, manifest({ ...otherRun, tuningBlocks: 4 })),
    ).toThrow(/TN_CPU_BENCH_INCOMPARABLE/);
  });

  it("accepts distinct runs that reuse a run-relative result filename", () => {
    const first = manifest({ commit: "a".repeat(40) });
    const other = manifest({
      commit: "b".repeat(40),
      modules: { loop: "L", state: "S", zustand: "Z" },
      resultFile: "labs/results/run.json",
      resultSha: "q",
      runId: "other",
    });
    expect(first.result.file).toBe(other.result.file);
    const compatibility = assertCompatibleCpuCaptures(first, other);
    expect(compatibility.mode).toBe("comparison");
  });

  it("rejects the same run or raw artifact even under a named control", () => {
    const first = manifest();
    const sameArtifact = validateCpuCaptureManifest(
      rebuild(first, (clone) => {
        const modules = (clone.source as Record<string, unknown>).modules as Record<
          string,
          Record<string, unknown>
        >;
        (modules.loop as Record<string, unknown>).sha256 = hex("L");
      }),
    );
    expect(() => assertCompatibleCpuCaptures(first, sameArtifact, { control: "control" })).toThrow(
      /TN_CPU_BENCH_SELF_COMPARISON/,
    );
  });

  it("permits same-commit changed subjects when a dirty checkout is reported", () => {
    const first = manifest({ commit: "a".repeat(40), dirty: true });
    const other = manifest({
      commit: "a".repeat(40),
      dirty: true,
      modules: { loop: "L", state: "S", zustand: "Z" },
      resultFile: "labs/results/other.json",
      resultSha: "q",
      runId: "other",
    });
    const compatibility = assertCompatibleCpuCaptures(first, other);
    expect(compatibility.mode).toBe("comparison");
    expect(compatibility.changedModules).toEqual(["loop", "state", "zustand"]);
  });

  it("rejects same-commit changed subjects across two clean captures", () => {
    const first = manifest({ commit: "a".repeat(40) });
    const other = manifest({
      commit: "a".repeat(40),
      modules: { loop: "L", state: "S", zustand: "Z" },
      resultFile: "labs/results/other.json",
      resultSha: "q",
      runId: "other",
    });
    expect(() => assertCompatibleCpuCaptures(first, other)).toThrow(/TN_CPU_BENCH_STALE_EVIDENCE/);
  });
});

describe("report", () => {
  function comparison(): { baseline: ICpuCaptureManifest; candidate: ICpuCaptureManifest } {
    return {
      baseline: manifest({ commit: "a".repeat(40) }),
      candidate: manifest({
        commit: "b".repeat(40),
        modules: { loop: "L", state: "S", zustand: "Z" },
        resultFile: "labs/results/other.json",
        resultSha: "q",
        runId: "other",
      }),
    };
  }

  it("presents stripped and raw upstream output as an unclassified outcome", () => {
    const { baseline, candidate } = comparison();
    const compatibility = assertCompatibleCpuCaptures(baseline, candidate);
    const report = emitCpuComparisonReport({
      baseline,
      candidate,
      compatibility,
      upstream: {
        exitCode: 0,
        stderr: "",
        stdout: "\u001b[31mdispatch 0: -4%\u001b[0m",
      },
    });
    expect(report).toContain(CPU_COMPARISON_DISCLAIMER);
    expect(report).toContain("exit code: 0");
    expect(report).toContain("dispatch 0: -4%");
    expect(report.split("\u001b[31m")).toHaveLength(2);
    expect(report).toContain("\u001b[31mdispatch 0: -4%\u001b[0m");
    expect(report).toContain("not a ThreeNative");
  });

  it("escapes dynamic text and paths in the HTML form", () => {
    const { baseline, candidate } = comparison();
    const compatibility = assertCompatibleCpuCaptures(baseline, candidate);
    const html = emitCpuComparisonReport({
      baseline,
      candidate,
      compatibility,
      format: "html",
      upstream: { exitCode: 1, stderr: "<script>", stdout: "<b>raw</b>" },
    });
    expect(html).toContain("&lt;b&gt;raw&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});
