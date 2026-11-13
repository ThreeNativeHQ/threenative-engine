import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { allTemplates } from "../../test-support/templates.js";
import {
  type ICiStep,
  type ICiWorkflow,
  type ICiWorkflowJob,
  ciTerms,
  declaredNeeds,
  jobSections,
  parseWorkflow,
} from "../ci-workflow.js";
import { parsePerformanceLaneManifest } from "../engine-load-test/report.js";
import {
  collectorCoverage,
  renderPerformanceCiSummary,
  summarizePerformanceCi,
  validateSelectedPerformanceLane,
} from "../performance-regression/ci-summary.js";
import {
  DEFAULT_PERFORMANCE_POLICY,
  parsePerformanceRun,
} from "../performance-regression/compare.js";
import {
  PERFORMANCE_QUICK_SUITE_BUDGET_MS,
  acquirePerformanceLease,
  collectorTimeoutMs,
  plannedPerformancePairs,
  productionEvidenceToPerformanceRun,
  runPerformanceLane,
  validateApprovedBaseline,
  validateArtifactIdentity,
  validatePerformanceDispatch,
  validateThermalEvidence,
  withPerformanceLease,
} from "../performance-regression/run.js";

const repo = path.resolve(import.meta.dirname, "../..");

/** A workflow under `.github/workflows`, parsed into the model (PRD-839). */
function workflow(file: string): ICiWorkflow {
  return parseWorkflow(readFileSync(path.join(repo, ".github/workflows", file), "utf8"));
}

/** The steps that restore or save a cache (`actions/cache`, `actions/cache/restore`, `actions/cache/save`). */
function cacheSteps(job: ICiWorkflowJob): readonly ICiStep[] {
  return job.steps.filter((step) => step.uses?.startsWith("actions/cache") === true);
}

/** The one step named `name` anywhere in the workflow. Zero or several throw. */
function findStep(model: ICiWorkflow, name: string): ICiStep {
  const found = model.jobs.flatMap((job) => job.steps.filter((step) => step.name === name));
  if (found.length !== 1) {
    throw new Error(`expected one step named "${name}", found ${String(found.length)}`);
  }
  return found[0] as ICiStep;
}

/** Every needle is in the subject. A miss names the needle, so a table fails like a single check. */
function expectIncludes(subject: string, needles: readonly string[], label = ""): void {
  for (const needle of needles) expect(subject, `${label} ${needle}`.trim()).toContain(needle);
}

/** No needle is in the subject. */
function expectExcludes(subject: string, needles: readonly string[], label = ""): void {
  for (const needle of needles) expect(subject, `${label} ${needle}`.trim()).not.toContain(needle);
}

it("release engine players include the desktop physics ABI", async () => {
  const presets = JSON.parse(
    await readFile(path.join(repo, "packages/runtime-native/CMakePresets.json"), "utf8"),
  );
  const release = requiredJob(
    await readFile(path.join(repo, ".github/workflows/native-release.yml"), "utf8"),
    "build",
  );
  for (const [name, target, library] of [
    ["tn-linux", "x86_64-unknown-linux-gnu", "libthreenative_native_physics.a"],
    ["tn-windows", "x86_64-pc-windows-msvc", "threenative_native_physics.lib"],
    ["tn-macos", "aarch64-apple-darwin", "libthreenative_native_physics.a"],
  ]) {
    const preset = presets.configurePresets.find((entry: { name: string }) => entry.name === name);
    expect(preset?.cacheVariables.TN_ENABLE_NATIVE_PHYSICS, name).toBe("ON");
    expect(preset?.cacheVariables.THREENATIVE_PHYSICS_LIBRARY, name).toBe(
      `\${sourceDir}/.runtime/physics-target/${target}/release/${library}`,
    );
    expect(release).toContain(`preset: ${name}`);
  }
  // native:build already builds the host Rust crate before either engine-player configure.
  for (const name of ["Build native runtime with MSVC", "Build Release engine player"]) {
    const step = workflowRunScript(release, name);
    const configure = "cmake --preset ${{ matrix.preset }} -B build/tn-engine-ui";
    const configureIndex = release.indexOf(configure, release.indexOf(`- name: ${name}`));
    const before = release.slice(0, configureIndex);
    expect(step).toContain(configure);
    expect(before).toContain("pnpm --filter @threenative/runtime-native native:build");
    expect(step).not.toContain("-DTN_ENABLE_NATIVE_PHYSICS=OFF");
    expect(step).toContain("--config Release --target tn-native-engine-player-v8");
  }
  const builder = await readFile(
    path.join(repo, "packages/runtime-native/scripts/native-build.mjs"),
    "utf8",
  );
  expect(builder).toContain("'build-native-physics.mjs'), '--desktop'");
});

// A git command can return while a background auto-gc still writes
// .git/objects/pack, so a plain recursive rm races it and throws ENOTEMPTY.
// Node retries ENOTEMPTY when maxRetries/retryDelay are set.
async function removeFixture(root: string): Promise<void> {
  await rm(root, { force: true, recursive: true, maxRetries: 10, retryDelay: 100 });
}

it("coverage consumes retained production evidence and blocks status-only artifacts", async () => {
  const directory = await makeTempDir("performance-coverage-");
  await writeFile(
    path.join(directory, "collector-status.json"),
    JSON.stringify({ status: "PASS" }),
  );
  const blocked = await collectorCoverage(directory);
  expect(blocked[0]?.status).toBe("BLOCKED");
  await writeFile(
    path.join(directory, "production-evidence.json"),
    JSON.stringify({
      target: "desktop",
      source: { sha: "sha" },
      artifact: { sha256: "hash" },
      status: "PASS",
      codes: [],
    }),
  );
  const actual = await collectorCoverage(directory);
  expect(actual).toHaveLength(1);
  expect(
    summarizePerformanceCi({
      expectedSha: "sha",
      requiredLanes: [path.basename(directory)],
      results: actual,
    }),
  ).toMatchObject({ status: "PASS", exitCode: 0 });
});

it("scheduled ladder producer has its own comparison consumer and baseline", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(repo, "scripts/performance-regression/lanes.json"), "utf8"),
  );
  const ladder = manifest.lanes.find((lane: { id: string }) => lane.id === "browser-moving-ladder");
  expect(ladder.workload).toBe("moving-l2-l3-16384");
  const plan = plannedPerformancePairs(ladder.id, "/baseline", "/candidate", {
    workload: ladder.workload,
  });
  expect(plan[0]?.baselineCommand).toContain("--modes L2,L3 --ladder 16384 --repeats 1");
  expect(ladder.baseline.status).toBe("unavailable");
});

it("rejects a workflow-dispatch lane that matches no declared matrix row", async () => {
  const manifest = parsePerformanceLaneManifest(
    JSON.parse(
      await readFile(path.join(repo, "scripts/performance-regression/lanes.json"), "utf8"),
    ),
  );
  expect(() => validateSelectedPerformanceLane("native-windwos", manifest)).toThrow(
    /TN_PERF_UNKNOWN_LANE.*native-windwos.*result keys/u,
  );
  const summary = workflow("performance-regression.yml").job("performance-summary");
  expect(summary.step("Validate requested performance lane").run).toContain(
    'pnpm tsx scripts/performance-regression/ci-summary.ts --validate-selected-lane "$TN_PERF_SELECTED_LANE" --manifest scripts/performance-regression/lanes.json',
  );
  expect(summary.step("Validate requested performance lane").index).toBeLessThan(
    summary.step("Download every available platform result").index,
  );
});

it("keeps source-pair preparation failures keyed by matrix identity", async () => {
  const prepare = workflow("performance-regression.yml")
    .job("hardware-pairs")
    .step(/^Prepare isolated source checkouts/u);
  expect(prepare.env).toMatchObject({
    TN_PERF_LANE: "${{ matrix.lane }}",
    TN_PERF_RESULT_KEY: "${{ matrix.result_key }}",
  });
  const script = prepare.run ?? "";
  expect(script.indexOf("TN_PERF_LANE")).toBeLessThan(
    script.indexOf("TN_PERF_SOURCE_FAILURE_REASON"),
  );
  expectIncludes(script, [
    "candidateSourceSha: process.env.TN_PERF_CANDIDATE_SOURCE_SHA",
    "sourceSha: process.env.TN_PERF_BASELINE_SOURCE_SHA",
  ]);
});

it("preserves both source identities in blocked source-pair artifacts", async () => {
  const prepare = workflow("performance-regression.yml")
    .job("hardware-pairs")
    .step(/^Prepare isolated source checkouts/u);
  const writerLine = (prepare.run ?? "")
    .split("\n")
    .find((line) => line.includes("process.env.TN_PERF_SOURCE_FAILURE_REASON"));
  if (writerLine === undefined) throw new Error("source-pair failure writer was not found");
  const scriptStart = writerLine.indexOf("'", writerLine.indexOf("-e ")) + 1;
  const script = writerLine.slice(scriptStart, writerLine.lastIndexOf("'"));
  const directory = await makeTempDir("performance-source-pair-");
  await mkdir(path.join(directory, "artifacts/performance-regression"), { recursive: true });
  const cases = [
    {
      baseline: "",
      candidate: "candidate-sha",
      reason: "TN_PERF_BASELINE_MISSING: a reviewed baseline SHA is required",
      resultKey: "missing-baseline",
    },
    {
      baseline: "baseline-sha",
      candidate: "",
      reason: "TN_PERF_CANDIDATE_MISSING: a candidate SHA is required",
      resultKey: "missing-candidate",
    },
    {
      baseline: "same-sha",
      candidate: "same-sha",
      reason: "TN_PERF_SELF_COMPARISON: baseline and candidate source SHAs must differ",
      resultKey: "self-comparison",
    },
  ] as const;

  for (const testCase of cases) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      cwd: directory,
      encoding: "utf8",
      env: {
        ...process.env,
        TN_PERF_BASELINE_SOURCE_SHA: testCase.baseline,
        TN_PERF_CANDIDATE_SOURCE_SHA: testCase.candidate,
        TN_PERF_LANE: "native-linux",
        TN_PERF_RESULT_KEY: testCase.resultKey,
        TN_PERF_SOURCE_FAILURE_REASON: testCase.reason,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const artifact = JSON.parse(
      await readFile(
        path.join(directory, "artifacts/performance-regression", `${testCase.resultKey}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(artifact).toMatchObject({
      candidateSourceSha: testCase.candidate === "" ? null : testCase.candidate,
      lane: "native-linux",
      reason: testCase.reason,
      resultKey: testCase.resultKey,
      sourceSha: testCase.baseline === "" ? null : testCase.baseline,
      status: "BLOCKED",
    });
    expect(Object.hasOwn(artifact, "candidateSourceSha")).toBe(true);
    expect(Object.hasOwn(artifact, "sourceSha")).toBe(true);
  }
});

it("requires scheduled pairs to use a distinct reviewed baseline and forwards both identities", async () => {
  const performance = workflow("performance-regression.yml");
  const pairs = performance.job("hardware-pairs");
  const prepare = pairs.step(/^Prepare isolated source checkouts/u);
  expect(prepare.env.REVIEWED_BASELINE_INPUT).toBe("${{ vars.TN_PERF_REVIEWED_BASELINE_SHA }}");
  expectIncludes(prepare.run ?? "", [
    'baseline_sha="${BASELINE_INPUT:-${REVIEWED_BASELINE_INPUT:-}}"',
    'candidate_sha="${CANDIDATE_INPUT:-$GITHUB_SHA}"',
    'if [ -z "$baseline_sha" ] || [ -z "$candidate_sha" ] || [ "$baseline_sha" = "$candidate_sha" ]; then',
  ]);
  expectIncludes(pairs.step(/^Run independent alternating baseline\/candidate pairs/u).run ?? "", [
    '--baseline-source-sha "$BASELINE_SOURCE_SHA"',
    '--candidate-source-sha "$CANDIDATE_SOURCE_SHA"',
  ]);
  const summary = performance.job("performance-summary");
  expect(summary.steps.map((step) => step.env.TN_PERF_SELECTED_LANE)).toContain(
    "${{ inputs.lane }}",
  );
  expectIncludes(summary.scripts, [
    "const required = (row) => selected(row) || manifestByLane.get(row.lane)?.required === true;",
    'status: selected(row) ? "BLOCKED" : "SKIPPED",',
    "requiredLanes: expectedRows.filter(required).map(({ resultKey }) => resultKey),",
  ]);
  expectExcludes(summary.scripts, ["requiredLanes: expectedResultKeys"]);

  const plan = plannedPerformancePairs("native-linux", "/repo/baseline", "/repo/candidate");
  expect(plan[0]?.baselineCommand).toContain("--source-sha <baseline-source>");
  expect(plan[0]?.candidateCommand).toContain("--source-sha <candidate-source>");
});

it("allows an empty required-lane set for advisory or unselected matrix rows", () => {
  expect(
    summarizePerformanceCi({
      expectedSha: "sha",
      requiredLanes: [],
      results: [
        { lane: "native-linux", resultKey: "native-linux", required: false, status: "SKIPPED" },
        {
          lane: "native-android",
          resultKey: "native-android",
          required: false,
          status: "UNVERIFIED",
        },
      ],
    }),
  ).toMatchObject({ exitCode: 0, status: "UNVERIFIED" });
});

it("required coverage cannot be weakened by a result flag", () => {
  for (const status of ["SKIPPED", "UNVERIFIED"]) {
    expect(
      summarizePerformanceCi({
        expectedSha: "sha",
        requiredLanes: ["native-linux"],
        results: [
          { lane: "browser-webgpu", status: "PASS", sourceSha: "sha", artifactHash: "hash" },
          { lane: "native-linux", status, required: false },
        ],
      }),
    ).toMatchObject({ status: "BLOCKED", exitCode: 2 });
  }
});

it("hardware workflow has no matrix context before expansion and uses Bash on Windows", async () => {
  const job = workflow("performance-regression.yml").job("hardware-pairs");
  expect(job.if ?? "").not.toContain("matrix.");
  expect(job.require("defaults")).toMatchObject({ run: { shell: "bash" } });
});

it("gives the moving 1800-frame collector the remaining fifteen-minute budget", () => {
  expect(PERFORMANCE_QUICK_SUITE_BUDGET_MS).toBe(15 * 60_000);
  expect(collectorTimeoutMs(180_000, 0)).toBe(180_000);
  expect(collectorTimeoutMs(PERFORMANCE_QUICK_SUITE_BUDGET_MS, 0)).toBe(
    PERFORMANCE_QUICK_SUITE_BUDGET_MS,
  );
  const ladder = plannedPerformancePairs(
    "browser-moving-ladder",
    "/repo/baseline",
    "/repo/candidate",
    {
      workload: "moving-l2-l3-16384",
    },
  );
  expect(ladder[0]?.candidateCommand).toContain("--frames 1800");
});

it("moves ladder source identity into a complete comparator report", async () => {
  const ladder = plannedPerformancePairs(
    "browser-moving-ladder",
    "/repo/baseline",
    "/repo/candidate",
    { workload: "moving-l2-l3-16384" },
  );
  expect(ladder[0]?.candidateCommand).toContain("--source-sha <candidate-source>");
  // The identity block moved to `driver.ts`, which both web arms drive; `main.ts` keeps the TN arm's
  // own projection and culling wiring.
  const browserSource = await readFile(
    path.join(repo, "examples/engine-load-test/src/driver.ts"),
    "utf8",
  );
  expect(browserSource).toMatch(/\n\s+identity:/u);
  for (const field of [
    "architecture",
    "artifactHash",
    "browser",
    "device",
    "graphicsBackend",
    "gpu",
    "instrumentationRevision",
    "jsRuntime",
    "nativeBinaryHash",
    "operatingSystem",
    "presentMode",
    "resolution",
    "sourceSha",
    "workloadHash",
  ]) {
    expect(browserSource).toMatch(new RegExp(`${field}(?:\\s*:|\\s*,)`, "u"));
  }
  const identity = {
    architecture: "x86_64",
    artifactHash: "bundle-sha256",
    browser: "Chromium 140",
    device: "Linux x86_64 NVIDIA",
    graphicsBackend: "WebGPU",
    gpu: "NVIDIA RTX observed",
    instrumentationRevision: "engine-load-test-v2",
    jsRuntime: "Chromium V8",
    nativeBinaryHash: "bundle-sha256",
    operatingSystem: "Linux",
    presentMode: "immediate",
    resolution: "1280x720",
    sourceSha: "candidate-source",
    workloadHash: "workload-sha256",
  };
  const converted = productionEvidenceToPerformanceRun(
    {
      arm: "tn-web",
      build: { notes: "", type: "release" },
      device: { battery: null, label: "Linux x86_64 NVIDIA" },
      display: { height: 720, refreshHz: 60, vsync: false, width: 1280 },
      driver: { adapter: "NVIDIA RTX observed", renderer: "WebGPU" },
      engine: { name: "threenative", version: "workspace" },
      identity,
      rungs: [
        {
          drawCalls: 2,
          frameMs: [10, 11, 12],
          mode: "L2",
          objectCount: 16_384,
          positionHash: "aabbccdd",
          repeat: 0,
          triangles: 196_610,
          visibleObjects: 16_384,
        },
      ],
    },
    { id: "browser-moving-ladder", platform: "browser-webgpu", workload: "moving-l2-l3-16384" },
    "candidate-source",
  );
  expect(converted.identity).toEqual(identity);
});

it("promoted conversion rejects absent hardware observations", () => {
  expect(() =>
    productionEvidenceToPerformanceRun(
      {
        source: { sha: "sha" },
        artifact: { sha256: "hash" },
        identity: { nativeBinarySha256: "binary" },
        metrics: { p95FrameMs: 10 },
        runId: "run",
        command: "collector",
        timestamps: {},
      },
      { id: "native-linux", platform: "native-linux", workload: "platformer-production" },
      "sha",
    ),
  ).toThrow(/identity/);
});

it("approved baseline binds provenance while allowing a fresh candidate", () => {
  const identity = {
    sourceSha: "approved",
    artifactHash: "artifact",
    nativeBinaryHash: "binary",
    gpu: "gpu",
  };
  expect(() => validateApprovedBaseline(identity, { ...identity, sourceSha: "other" })).toThrow(
    /approved baseline/,
  );
  expect(() => validateApprovedBaseline(identity, { ...identity, artifactHash: "other" })).toThrow(
    /approved baseline/,
  );
  expect(() => validateApprovedBaseline(identity, identity)).not.toThrow();
});
const workflows = [
  ".github/workflows/ci.yml",
  ".github/workflows/ci-janitor.yml",
  ".github/workflows/native-platforms.yml",
  ".github/workflows/native-release.yml",
  ".github/workflows/npm-release.yml",
] as const;

/**
 * Every workflow file on disk, read off the directory rather than off a hand-kept list of "the ones
 * that matter". A workflow file that lands without being named here is a set of triggers, runners
 * and required checks nobody in this repository has read, and the audit that found
 * `feat/prd-368-persistent-pipeline-cache` still holding a 31-minute job could only see it by
 * reading the files. Naming the file here is the review.
 */
const reviewedWorkflows = [
  ".github/workflows/build-quiche-owned.yml",
  ".github/workflows/ci.yml",
  ".github/workflows/ci-janitor.yml",
  ".github/workflows/integration.yml",
  ".github/workflows/native-platforms.yml",
  ".github/workflows/native-release.yml",
  ".github/workflows/npm-release.yml",
  ".github/workflows/performance-regression.yml",
  ".github/workflows/pipeline-cache.yml",
  ".github/workflows/release-candidate.yml",
  ".github/workflows/site-docs.yml",
] as const;

/**
 * Triggers that test one commit more than once, or that outlive the pull request they were added for.
 *
 * A `push` with no `branches:` filter fires for the PR's own head commit as well as for the
 * `pull_request` event carrying it, so `integration-csg` ran its proof twice for every commit it had
 * a pull request for. Narrowing `push` to `main` is not that defect: it fires for the merge, which is
 * a different commit, and both `ci.yml` and `pipeline-cache` rely on it to prove the promotion. What
 * is never legitimate is a *feature* branch in a `push` filter — `integration-decals` carried
 * `fix/vq11-decal-material-lifetime` for a pull request that merged, and `pipeline-cache` listed the
 * branch PRD-368 landed on three weeks earlier, each spending a long native lane on pushes nobody
 * reads.
 */
function duplicateCommitTriggers(source: string): readonly string[] {
  const triggers = commandText(triggerSection(source));
  const findings: string[] = [];
  const push = /^ {2}push:\n(?: {4}.*\n)*/mu.exec(triggers)?.[0] ?? "";
  if (/^ {2}pull_request:/mu.test(triggers) && push !== "" && !/\n {4}branches:/u.test(push)) {
    findings.push("push + pull_request: one commit runs this workflow twice");
  }
  const inline = /branches: \[([^\]]*)\]/mu.exec(push)?.[1] ?? "";
  const block = /\n {4}branches:\n((?: {6}- .*\n)*)/mu.exec(push)?.[1] ?? "";
  for (const branch of `${inline}\n${block}`
    .split("\n")
    .map((line) =>
      line
        .replace(/^ {6}- /u, "")
        .trim()
        .replace(/^["']|["']$/gu, ""),
    )
    .filter((name) => name !== "")) {
    if (!/^(?:main|develop)$/u.test(branch)) {
      findings.push(`push narrowed to ${branch}: the lane outlives its pull request`);
    }
  }
  return findings;
}

/** Every `paths:` entry in a workflow's triggers, in file order. */
function triggerPaths(source: string): readonly string[] {
  const triggers = commandText(triggerSection(source));
  const entries: string[] = [];
  let reading = false;
  for (const line of triggers.split("\n")) {
    if (/^ {4}paths:/u.test(line)) {
      reading = true;
      continue;
    }
    if (!reading) continue;
    if (!/^ {6}- /u.test(line)) {
      reading = false;
      continue;
    }
    entries.push(
      line
        .replace(/^ {6}- /u, "")
        .trim()
        .replace(/^["']|["']$/gu, ""),
    );
  }
  return entries;
}

function requiredJob(source: string, name: string): string {
  const section = jobSections(source).find(([job]) => job === name)?.[1];
  if (section === undefined) throw new Error(`CI job ${name} was not found.`);
  return section;
}

function workflowRunScript(source: string, stepName: string): string {
  const stepStart = source.indexOf(`      - name: ${stepName}`);
  if (stepStart < 0) throw new Error(`workflow step ${stepName} was not found.`);
  const runStart = source.indexOf("        run: |\n", stepStart);
  if (runStart < 0) throw new Error(`workflow step ${stepName} did not contain a run block.`);
  const bodyStart = runStart + "        run: |\n".length;
  const bodyEnd = source.indexOf("\n      - ", bodyStart);
  if (bodyEnd < 0) throw new Error(`workflow step ${stepName} did not have a following step.`);
  return source
    .slice(bodyStart, bodyEnd)
    .split("\n")
    .map((line) => (line.startsWith("          ") ? line.slice(10) : line))
    .join("\n");
}

function occurrences(source: string, pattern: RegExp): number {
  return [...source.matchAll(pattern)].length;
}

function triggerSection(source: string): string {
  const jobsIndex = source.indexOf("\njobs:\n");
  if (jobsIndex < 0) throw new Error("CI workflow did not include a jobs mapping.");
  return source.slice(0, jobsIndex);
}

function kvmProvisioning(source: string): readonly string[] {
  return (
    source
      .split("\n")
      .map((line) => line.trim())
      // A trailing `|| true` is not part of the provisioning. native-platforms.yml's copy carries one
      // because it is the lane PRD-480 routes onto the `tn-local` container, where no udev runs and
      // /sys is read-only, so the commands cannot succeed there — while native-release.yml stays
      // hosted and keeps them strict. The two lanes must still provision KVM the same way.
      .map((line) => line.replace(/ \|\| true$/u, ""))
      .filter(
        (line) =>
          line.includes('KERNEL=="kvm"') ||
          line === "| sudo tee /etc/udev/rules.d/99-kvm4all.rules" ||
          line === "sudo udevadm control --reload-rules" ||
          line === "sudo udevadm trigger --name-match=kvm",
      )
  );
}

function commandText(section: string): string {
  return section
    .split("\n")
    .filter((line) => !/^\s*#/u.test(line))
    .join("\n");
}

function cmakeFunction(source: string, name: string): string {
  const match = new RegExp(`^function\\(${name}\\b[\\s\\S]*?^endfunction\\(\\)`, "mu").exec(source);
  if (match === null) throw new Error(`CMake function ${name} was not found.`);
  return match[0];
}

/**
 * Which templates a matrix job actually covers.
 *
 * These assertions used to match `- <template>` in the job text, which read the matrix only while
 * the matrix was a bare list of names. `template-nonvisual` shards its measured heavy templates now, so
 * an entry is `- { template: platformer, shard: "1/2" }` and the old match found nothing while the
 * coverage it was checking was unchanged. Reading the entries is what the assertion always meant.
 */
function matrixTemplates(section: string): readonly string[] {
  if (section.includes("fromJSON(needs.scope.outputs.plan).templateMatrix"))
    return [...expectedTemplates].sort();
  if (section.includes("fromJSON(needs.scope.outputs.plan).goldenMatrix")) return ["starter"];
  const listed = [...section.matchAll(/^\s+-\s+([a-z][a-z0-9-]*)\s*$/gmu)].map(
    (match) => match[1] ?? "",
  );
  const included = [...section.matchAll(/^\s+-\s*\{[^}]*\btemplate:\s*([a-z][a-z0-9-]*)/gmu)].map(
    (match) => match[1] ?? "",
  );
  return [...new Set([...listed, ...included])].sort();
}

// Read off disk, so the matrix is required to list a kit the day that kit ships rather than the
// day somebody remembers to extend a list here. The assertion that matters is below: every
// template on disk must appear in the workflow's matrix.
const expectedTemplates = allTemplates();

interface IScopeFixture {
  readonly base: string;
  readonly git: (args: readonly string[]) => string;
  readonly root: string;
}

function isolatedGitEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of [
    // A fixture repo is never a CI run: inherited from the CI job, this turned on the live tree-reuse
    // lookup and the plan grew an Actions API error.
    "GITHUB_ACTIONS",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_WORK_TREE",
  ]) {
    delete environment[variable];
  }
  return environment;
}

async function scopeFixture(): Promise<IScopeFixture> {
  const root = await makeTempDir("threenative-ci-scope-");
  const git = (args: readonly string[]): string => {
    const result = spawnSync("git", [...args], {
      cwd: root,
      encoding: "utf8",
      env: isolatedGitEnvironment(),
    });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  git(["init", "--quiet"]);
  git(["config", "user.email", "ci-scope@example.invalid"]);
  git(["config", "user.name", "CI scope test"]);
  await mkdir(path.join(root, "docs/PRDs"), { recursive: true });
  await writeFile(path.join(root, "docs/PRDs/inert.md"), "# Inert planning prose\n");
  git(["add", "-A"]);
  git(["commit", "--quiet", "-m", "base"]);
  return { base: git(["rev-parse", "HEAD"]), git, root };
}

async function commitScopeChange(
  fixture: IScopeFixture,
  relative: string,
  contents: string,
  message: string,
): Promise<string> {
  await mkdir(path.dirname(path.join(fixture.root, relative)), { recursive: true });
  await writeFile(path.join(fixture.root, relative), contents);
  fixture.git(["add", "-A"]);
  fixture.git(["commit", "--quiet", "-m", message]);
  return fixture.git(["rev-parse", "HEAD"]);
}

function classifyScope(
  root: string,
  base: string,
  head: string,
  extra: readonly string[] = [],
): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "scripts/ci-change-scope.mjs"),
      "--root",
      root,
      // PRD-731: a pull request earns the thin review lane; the merge queue owns the selected
      // board these scope cases are about. `extra` may override the event.
      "--event-name",
      "merge_group",
      "--candidate-sha",
      head,
      "--target",
      "develop",
      "--base",
      base,
      "--head",
      head,
      "--format",
      "json",
      ...extra,
    ],
    { encoding: "utf8", env: isolatedGitEnvironment() },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

describe("CI pipeline structure", () => {
  it("uses one fail-closed scope decision before expensive CI and native jobs", () => {
    const ci = workflow("ci.yml");
    const scope = ci.job("scope");
    const classify = scope.stepById("classify");
    expect(classify.run).toMatch(/node scripts\/ci-change-scope\.mjs/u);
    expect(scope.steps[0]?.with["fetch-depth"]).toBe(0);
    expect(scope.outputs).toMatchObject({
      reason: "${{ steps.classify.outputs.reason }}",
      scope: "${{ steps.classify.outputs.scope }}",
      selection: "${{ steps.classify.outputs.selection }}",
    });
    expect(scope.runs("pnpm install")).toBe(false);
    // Scope reads only scripts/ and the kit.json files: a full blob-less checkout fetched every
    // HEAD blob (488 MB) and outlasted the 5-minute bound on a loaded runner (runs 41688746026, 41702153229).
    expect(scope.steps[0]?.with["sparse-checkout"]).toBe(
      "scripts\npackages/create-threenative/templates\n",
    );

    const full = "needs.scope.outputs.selection == 'full'";
    for (const name of [
      "typecheck",
      "test",
      "test-unit",
      "test-native",
      "test-browser",
      "test-playtest",
      "golden-path-template",
      "template-nonvisual",
      "benchmark",
      "build",
      "budgets",
      "performance-contracts",
    ]) {
      const job = ci.job(name);
      expect(job.needs, `${name} does not wait for scope`).toEqual(
        expect.arrayContaining(["scope"]),
      );
      expect(ciTerms(job.if ?? ""), `${name} does not select the full board explicitly`).toEqual(
        expect.arrayContaining([full]),
      );
    }

    const lint = ci.job("lint");
    expect(lint.needs).toEqual(["scope"]);
    expect(lint.step("Run the selected documentation and evidence gates").run).toMatch(
      /pnpm check:docs[\s\S]*evidence-citations\.spec\.ts[\s\S]*ci-needs\.spec\.ts/u,
    );
    expect(lint.runs(/pnpm test:browser|native:build/u)).toBe(false);

    const native = workflow("native-platforms.yml");
    const nativeScope = native.job("scope");
    expect(nativeScope.stepById("classify").run).toMatch(/node scripts\/ci-change-scope\.mjs/u);
    expect(nativeScope.outputs.scope).toBe("${{ steps.classify.outputs.scope }}");
    expect(nativeScope.runs("pnpm install")).toBe(false);
    for (const name of [
      "web-reference",
      "android-emulator-parity",
      "desktop-parity",
      "desktop",
      "starter-linux",
      "ios-simulator",
    ]) {
      expect(native.job(name).needs, `${name} does not use shared scope`).toEqual(
        expect.arrayContaining(["scope"]),
      );
      expect(ciTerms(native.job(name).if ?? ""), `${name} has no prose exemption`).toEqual(
        expect.arrayContaining([full]),
      );
    }
    expect(ciTerms(native.job("performance-coverage").if ?? "")).toEqual(
      expect.arrayContaining([full]),
    );
    expect(Object.keys(native.on).sort()).toEqual(["workflow_call", "workflow_dispatch"]);
    expect(native.on.workflow_call).toMatchObject({ inputs: { ios_only: expect.anything() } });
  });

  it("never lets a draft pull request run cancel a ready one", () => {
    const group = String(workflow("ci.yml").concurrency?.group ?? "");
    // A push then `gh pr ready` fires a synchronize run whose payload still says draft. In the
    // shared `latest` group with cancel-in-progress, that skipped run cancelled the real one
    // (#403, run 37075825121). Only a non-draft pull request run joins the shared group.
    expect(group).toMatch(/!github\.event\.pull_request\.draft && 'latest'/u);
  });

  it("warms the base-branch caches from a develop push, and lets no push cancel another", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const model = parseWorkflow(ci);
    // `develop` is the only branch a push may name besides main, and it is the base branch every
    // pull request reads its caches from.
    expect(model.on.push).toEqual({ branches: ["main", "develop"] });
    // The `warm` plan still exists as a selection, and these are the only jobs it runs: the two
    // cache publishers plus the reporting job.
    for (const name of ["build-artifacts", "test-native", "run-summary"]) {
      expect(ciTerms(model.job(name).if ?? ""), `${name} never runs on a develop push`).toEqual(
        expect.arrayContaining(["needs.scope.outputs.selection == 'warm'"]),
      );
    }
    expect(duplicateCommitTriggers(ci)).toEqual([]);
    // Develop pushes share one group, so the next push waits instead of starting a board beside the
    // running one. Nothing but a pull request cancels in progress, so that push cannot kill the
    // running board while it is saving.
    expect(String(model.concurrency?.group)).toMatch(
      /github\.event_name == 'push' && github\.ref == 'refs\/heads\/develop' && 'latest'/u,
    );
    expect(model.concurrency?.["cancel-in-progress"]).toBe(
      "${{ github.event_name == 'pull_request' }}",
    );
  });

  it("does not require skipped performance lanes on a prose-only run", () => {
    const summary = workflow("ci.yml").job("run-summary");
    const step = summary.step(
      "Report the performance contract through the shared comparison summary",
    );
    expect(step.env.TN_CI_SCOPE).toBe("${{ needs.scope.outputs.selection }}");
    expectIncludes(step.run ?? "", [
      'required_lanes=""',
      'if [ "$TN_CI_SCOPE" = full ]; then',
      'required_lanes="performance-contracts"',
      'required_lanes="${required_lanes:+$required_lanes,}native-linux-contract"',
      '--required-lanes "$required_lanes"',
    ]);
    expectExcludes(step.run ?? "", [
      "--required-lanes performance-contracts,native-linux-contract",
    ]);
  });

  it("classifies scratch Git histories from the complete merge-base diff", async () => {
    const fixture = await scopeFixture();
    try {
      const proseHead = await commitScopeChange(
        fixture,
        "docs/PRDs/inert.md",
        "# Updated planning prose\n",
        "prose",
      );
      expect(classifyScope(fixture.root, fixture.base, proseHead)).toMatchObject({
        scope: "prose",
        selection: "prose",
      });

      fixture.git(["mv", "docs/PRDs/inert.md", "docs/PRDs/renamed.md"]);
      fixture.git(["commit", "--quiet", "-m", "rename"]);
      const renamedHead = fixture.git(["rev-parse", "HEAD"]);
      expect(classifyScope(fixture.root, proseHead, renamedHead)).toMatchObject({
        scope: "prose",
        selection: "prose",
      });

      fixture.git(["rm", "--quiet", "docs/PRDs/renamed.md"]);
      fixture.git(["commit", "--quiet", "-m", "delete"]);
      const deletedHead = fixture.git(["rev-parse", "HEAD"]);
      expect(classifyScope(fixture.root, renamedHead, deletedHead)).toMatchObject({
        scope: "prose",
        selection: "prose",
      });
      expect(classifyScope(fixture.root, fixture.base, deletedHead)).toMatchObject({
        scope: "prose",
        selection: "prose",
      });

      const consumedHead = await commitScopeChange(
        fixture,
        "docs/verification/round-99.md",
        "# Round ledger\n",
        "consumed Markdown",
      );
      expect(classifyScope(fixture.root, deletedHead, consumedHead)).toMatchObject({
        scope: "full",
        selection: "full",
      });

      const mixedHead = await commitScopeChange(
        fixture,
        "packages/core/src/change.ts",
        "export const changed = true;\n",
        "mixed core change",
      );
      expect(classifyScope(fixture.root, deletedHead, mixedHead)).toMatchObject({
        scope: "full",
        selection: "full",
      });

      expect(classifyScope(fixture.root, "missing-base", mixedHead)).toMatchObject({
        scope: "full",
        selection: "full",
      });
      expect(classifyScope(fixture.root, mixedHead, mixedHead)).toMatchObject({
        scope: "full",
        selection: "full",
      });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("classifies a modified rename from its zero-padded similarity score", async () => {
    const fixture = await scopeFixture();
    try {
      const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}\n`).join("");
      const proseHead = await commitScopeChange(
        fixture,
        "docs/PRDs/long.md",
        lines,
        "long planning prose",
      );
      fixture.git(["mv", "docs/PRDs/long.md", "docs/PRDs/moved.md"]);
      await writeFile(path.join(fixture.root, "docs/PRDs/moved.md"), `${lines}changed\n`);
      fixture.git(["add", "-A"]);
      fixture.git(["commit", "--quiet", "-m", "rename and edit"]);
      const renamedHead = fixture.git(["rev-parse", "HEAD"]);
      expect(classifyScope(fixture.root, proseHead, renamedHead)).toMatchObject({
        scope: "prose",
        selection: "prose",
      });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("classifies a workflow-only change as the `ci` selection, not prose and not full", async () => {
    const fixture = await scopeFixture();
    try {
      const workflowHead = await commitScopeChange(
        fixture,
        ".github/workflows/ci.yml",
        "name: CI\njobs: {}\n",
        "workflow-only change",
      );

      const plan = classifyScope(fixture.root, fixture.base, workflowHead, ["--target", "develop"]);
      expect(plan).toMatchObject({
        files: [".github/workflows/ci.yml"],
        selection: "ci",
        nativeTier: "none",
      });
      expect(
        Object.entries(plan.jobs as Record<string, { required: boolean }>)
          .filter(([, job]) => job.required)
          .map(([name]) => name)
          .sort(),
      ).toEqual([
        "budgets",
        "build-artifacts",
        "integration",
        "lint",
        "supply-chain",
        "test-unit",
        "typecheck",
      ]);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  // PRD-573 slice 0b. The native engine's own tree is proven by its own job, so a diff that touches
  // only that tree skips the 75-minute native-platforms matrix. The paths are empty on develop today,
  // which is why every other diff has to classify exactly as before.
  describe("native-engine scope", () => {
    const ENGINE_FILES = [
      "packages/runtime-native/src/engine/scene/node.cpp",
      "packages/runtime-native/src/adapters/v8/bind.cpp",
      "packages/runtime-native/tests/native-engine/scene_test.cpp",
      "packages/runtime-native/cmake/NativeEngineCore.cmake",
    ];
    const jobsOf = (plan: Record<string, unknown>) =>
      plan.jobs as Record<string, { required: boolean; reason: string }>;

    it.each(ENGINE_FILES)("selects only the native-engine job for %s", async (relative) => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(fixture, relative, "changed\n", "engine only");
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan).toMatchObject({
          selection: "native-engine",
          native: false,
          nativeTier: "none",
        });
        const jobs = jobsOf(plan);
        expect(jobs["native-engine"]?.required).toBe(true);
        expect(jobs["native-platforms"]?.required).toBe(false);
        expect(jobs["native-platforms"]?.reason).toContain("native-engine");
        expect(jobs["test-native"]?.required).toBe(false);
        expect(
          Object.entries(jobs)
            .filter(([, job]) => job.required)
            .map(([name]) => name)
            .sort(),
        ).toEqual(["integration", "lint", "native-engine", "supply-chain"]);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("keeps native-platforms required when an engine path rides with a legacy runtime-native path", async () => {
      const fixture = await scopeFixture();
      try {
        await commitScopeChange(fixture, ENGINE_FILES[0] ?? "", "changed\n", "engine");
        const head = await commitScopeChange(
          fixture,
          "packages/runtime-native/src/runtime.cpp",
          "changed\n",
          "legacy runtime-native",
        );
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan).toMatchObject({ selection: "full", native: true });
        expect(jobsOf(plan)["native-platforms"]?.required).toBe(true);
        expect(jobsOf(plan)["native-engine"]?.required).toBe(true);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it.each(["packages/core/src/index.ts", ".github/workflows/ci.yml"])(
      "does not narrow an engine path mixed with %s",
      async (other) => {
        const fixture = await scopeFixture();
        try {
          await commitScopeChange(fixture, ENGINE_FILES[0] ?? "", "changed\n", "engine");
          const head = await commitScopeChange(fixture, other, "changed\n", "other");
          const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
          expect(plan.selection).not.toBe("native-engine");
          expect(jobsOf(plan)["native-engine"]?.required).toBe(true);
        } finally {
          await removeFixture(fixture.root);
        }
      },
    );

    it("lets prose ride with an engine path", async () => {
      const fixture = await scopeFixture();
      try {
        await commitScopeChange(fixture, ENGINE_FILES[1] ?? "", "changed\n", "engine");
        const head = await commitScopeChange(fixture, "docs/PRDs/other.md", "# prose\n", "prose");
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan.selection).toBe("native-engine");
        expect(jobsOf(plan)["native-platforms"]?.required).toBe(false);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it.each([
      "packages/runtime-native/src/engineering/x.cpp",
      "packages/runtime-native/src/adapters-legacy/x.cpp",
      "packages/runtime-native/tests/native-engine-assets.spec.ts",
      "packages/runtime-native/cmake/CheckNativeEngineGraph.cmake",
      "packages/runtime-native/android/engine-player/build.gradle",
    ])("treats the lookalike %s as an ordinary path", async (relative) => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(fixture, relative, "changed\n", "lookalike");
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan.selection).toBe("full");
        expect(jobsOf(plan)["native-engine"]?.required).toBe(false);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("does not read a repo-root src/engine as the engine tree", async () => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(fixture, "src/engine/x.cpp", "changed\n", "root");
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan.selection).toBe("full");
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("keeps native-platforms for an engine-only change into main and under --full", async () => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(fixture, ENGINE_FILES[0] ?? "", "changed\n", "engine");
        for (const extra of [
          ["--target", "main"],
          ["--target", "develop", "--full"],
        ]) {
          const plan = classifyScope(fixture.root, fixture.base, head, extra);
          expect(plan.selection, extra.join(" ")).toBe("full");
          expect(jobsOf(plan)["native-platforms"]?.required, extra.join(" ")).toBe(true);
          expect(jobsOf(plan)["native-engine"]?.required, extra.join(" ")).toBe(true);
        }
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("leaves every existing diff unchanged: native-engine is not required outside the engine tree", async () => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(
          fixture,
          "packages/runtime-native/src/host.cpp",
          "changed\n",
          "legacy",
        );
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan.selection).toBe("full");
        expect(jobsOf(plan)["native-engine"]?.required).toBe(false);
        const prose = await commitScopeChange(fixture, "docs/PRDs/inert.md", "# x\n", "prose");
        const docsPlan = classifyScope(fixture.root, head, prose, ["--target", "develop"]);
        expect(docsPlan.selection).toBe("prose");
        expect(jobsOf(docsPlan)["native-engine"]?.required).toBe(false);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("wires one native-engine job: own ccache key, cached emsdk, guarded ctest, reported in the verdict", () => {
      const ci = workflow("ci.yml");
      const job = ci.job("native-engine");
      expect(job.needs).toEqual(["scope"]);
      expect(ciTerms(job.if ?? "")).toEqual(
        expect.arrayContaining([
          "needs.scope.outputs.selection == 'native-engine'",
          "fromJSON(needs.scope.outputs.plan).jobs['native-engine'].required",
        ]),
      );
      const caches = job.stepsUsing("actions/cache@v4");
      expect(caches.map((step) => String(step.with.key))).toEqual([
        expect.stringMatching(/^native-ccache-ci-native-engine-/u),
        expect.stringMatching(/^native-engine-emsdk-/u),
      ]);
      expect(job.mentions("native-ccache-ci-test-native-")).toBe(false);
      expect(job.stepById("emsdk").uses).toBe("actions/cache@v4");
      expect(job.stepById("engine").run).toMatch(
        /packages\/runtime-native\/cmake\/NativeEngineCore\.cmake/u,
      );
      expect(job.runs(/ctest [^\n]*-L native-engine/u)).toBe(true);
      expect(job.step("Install the workspace").if).toBe("steps.engine.outputs.present == 'true'");
      expect(ci.job("ci-required").needs).toEqual(expect.arrayContaining(["native-engine"]));
      expect(ci.job("run-summary").needs).toEqual(expect.arrayContaining(["native-engine"]));
    });
  });

  it("syncs capability artifacts on relevant commits and rejects stale manifests in CI", async () => {
    const packageJson = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const hook = await readFile(path.join(repo, "githooks/pre-commit"), "utf8");

    expect(packageJson.scripts["capabilities:sync"]).toContain("build-capability-manifest.ts");
    expect(packageJson.scripts["capabilities:sync"]).toContain("generate-capability-reference.ts");
    expect(packageJson.scripts["capabilities:check"]).toContain(
      "build-capability-manifest.ts --check",
    );
    expect(packageJson.scripts.budgets).not.toContain("pnpm capabilities:check");
    expect(hook).toContain("git diff --cached --name-only");
    expect(hook).toContain("packages/[^/]+/(src/.*|package\\.json)");
    expect(hook).toContain("pnpm capabilities:sync");
    expect(hook).toContain("git add --");
    expect(hook).not.toContain("git add -A");
    expect(hook).not.toContain("git add .");
  });

  it("no job cancels its own run, because that erases which gate went red", async () => {
    // The mechanism this replaces called `POST /actions/runs/$GITHUB_RUN_ID/cancel` from an
    // `if: failure()` step inside the job that had just failed. A run-level cancel re-marks every
    // in-flight job `cancelled` — the caller included — so on 2026-09-02 a flaky `test-browser`
    // produced eleven cancelled checks, zero failures, and a pull request that could not say what
    // broke; `gh run rerun --failed` then had nothing marked failed to re-run.
    //
    // Its predecessor was worse still: it swept every in_progress and queued run in the
    // repository and cancelled any whose branch looked like a PRD lane, so on 2026-09-01 one red
    // native job took out six runs across four branches in twenty seconds. Neither form comes
    // back. The saving was runner minutes; the price was the only thing a red run produces.
    await expect(stat(path.join(repo, ".github/actions/cancel-run-on-failure"))).rejects.toThrow();
    for (const relative of workflows) {
      const model = workflow(path.basename(relative));
      for (const job of model.jobs) {
        expect(job.mentions("cancel-run-on-failure"), `${relative} ${job.id}`).toBe(false);
        expect(
          job.runs("actions/runs/$GITHUB_RUN_ID/cancel"),
          `${relative} ${job.id} cancels its own run`,
        ).toBe(false);
      }
      // Nothing calls the Actions API to cancel its own run, so nothing may ask to write to it.
      // `ci-janitor.yml` is the single named exception: it cancels *other* runs, on a closed PR,
      // never from a failure step, and never its own run id — all four pinned in its own case.
      // PRD-731 adds the second: `queue-watch` in ci.yml, which names the first red job on the pull
      // request before it cancels the rest. PRD-782 widens it to full boards (pinned below).
      // PRD-630 adds the third: `ship` in npm-release.yml dispatches the release workflows.
      const exempt = { "ci-janitor.yml": "*", "ci.yml": "queue-watch", "npm-release.yml": "ship" }[
        path.basename(relative)
      ];
      if (exempt === "*") continue;
      expect(model.permissions?.actions, `${relative} needs no actions: write`).not.toBe("write");
      for (const job of model.jobs.filter((entry) => entry.id !== exempt)) {
        expect(job.permissions?.actions, `${relative} ${job.id} needs no actions: write`).not.toBe(
          "write",
        );
      }
    }

    // Fail-fast that keeps its evidence: a matrix reports every leg, and an expensive job is
    // skipped by its `needs:` edge rather than cancelled out from under itself.
    const ci = workflow("ci.yml");
    expect(ci.jobs.some((job) => job.strategy?.["fail-fast"] === false)).toBe(true);
    expect(ci.job("golden-path-template").needs).toEqual(["scope", "build-artifacts"]);
  });

  it("publishes through npm Trusted Publishing: an OIDC token and npm 11.5.1 or later", () => {
    // NPM_TOKEN was rejected with E404 on every PUT of 0.3.10 and 0.3.11; the OIDC exchange needs
    // `id-token: write` and an npm CLI that knows it, and Node 20.19 bundles npm 10.
    const ship = workflow("npm-release.yml").job("ship");
    expect(ship.permissions?.["id-token"]).toBe("write");
    const installStep = ship.steps.find((step) =>
      /npm install -g npm@\d+\.\d+\.\d+/u.test(step.run ?? ""),
    );
    const install = /npm install -g npm@(\d+)\.(\d+)\.(\d+)/u.exec(installStep?.run ?? "");
    if (!install || installStep === undefined) {
      throw new Error("ship installs no pinned npm before it publishes");
    }
    const [major = 0, minor = 0, patch = 0] = install.slice(1).map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(11_005_001);
    const publish = ship.steps.findIndex((step) => /pnpm release:ship/u.test(step.run ?? ""));
    expect(installStep.index).toBeLessThanOrEqual(publish);
    if (installStep.index === publish) {
      expect((installStep.run ?? "").indexOf(install[0])).toBeLessThan(
        (installStep.run ?? "").indexOf("pnpm release:ship"),
      );
    }
  });

  it("hands the emulator action a one-line script, so the arguments survive", async () => {
    // `android-emulator-runner` runs `script` through the emulator shell a line at a time. A
    // `\`-continued command therefore loses everything after its first line, and from 2026-09-01
    // this lane ran `run-conformance.mjs` with no arguments at all: `--target` defaulted to `all`,
    // so one `--target android` invocation wrote web, desktop, android and ios reports under the
    // default `artifacts/conformance`, overwrote the web reference the lane had just captured, and
    // then compared the emulator against the wreckage. The step read as correct in the YAML the
    // whole time — `>-` folds to one line and `|` does not, and only that character separates a
    // working lane from a silent one.
    const scripts = workflow("native-platforms.yml").jobs.flatMap((job) =>
      job.steps.flatMap((step) => (typeof step.with.script === "string" ? [step.with.script] : [])),
    );
    expect(scripts.length, "no emulator script block found to check").toBeGreaterThan(0);
    for (const body of scripts) {
      // A literal block keeps its newlines, which is exactly what the action cannot take; a folded
      // block (`>-`) parses to one line.
      expect(body.trimEnd(), "script spans lines").not.toMatch(/\n/u);
      expect(body, "script continues with a backslash").not.toMatch(/\\\s*$/u);
      expect(body, "script lost its target").toMatch(/--target android/u);
      expect(body, "script lost its output path").toMatch(/--out /u);
    }
  });

  it("caches what the Android lane would otherwise re-download every run", async () => {
    // Measured on run 33675488456: ~6 min re-installing SDK/emulator packages and ~5 min on the
    // Gradle build plus the Rust cross-compile, in a 35 min job. `third_party` was already cached
    // and restored in about 4 s; these three simply had no cache step at all.
    // Run 36357493470 (2026-09-28) reversed the SDK half: sdkmanager installed platform, NDK,
    // emulator and system image in ~40 s, while the multi-GB save took 240 s every run and
    // evicted the Gradle and Cargo entries from the shared 10 GiB budget, so none of them hit.
    const android = workflow("native-platforms.yml").job("android-emulator-parity");
    expect(
      android.mentions("system-images/android-35"),
      "the SDK cache costs more to save than to reinstall",
    ).toBe(false);
    for (const [what, needle] of [
      ["the Gradle caches", "~/.gradle/caches"],
      ["the Rust cross-compile output", ".runtime/physics-target"],
      // The cargo key has to follow the lockfile that actually drives the build; a `**/Cargo.lock`
      // glob would also hash third_party's and miss on churn that changes nothing here.
      ["the physics lockfile", "packages/runtime-native/native/physics/Cargo.lock"],
    ] as const) {
      expect(android.mentions(needle), `the Android lane stopped caching ${what}`).toBe(true);
    }
  });

  it("fails closed when the workflow model is asked for a field, job or step that is absent", () => {
    const ci = workflow("ci.yml");
    const scope = ci.job("scope");
    expect(() => ci.job("no-such-job")).toThrow(/CI_WORKFLOW_NO_JOB/u);
    expect(() => scope.require("no-such-field")).toThrow(/CI_WORKFLOW_MISSING_FIELD/u);
    expect(() => scope.step("no such step")).toThrow(/CI_WORKFLOW_STEP/u);
    expect(() => scope.stepById("no-such-id")).toThrow(/CI_WORKFLOW_STEP/u);
    expect(scope.steps[0]?.if).toBeUndefined();
    expect(() => scope.steps[0]?.require("no-such-field")).toThrow(/CI_WORKFLOW_MISSING_FIELD/u);
    expect(() => parseWorkflow("name: x\n")).toThrow(/CI_WORKFLOW_MISSING_FIELD/u);
    expect(() => parseWorkflow("on: push\njobs:\n")).toThrow(/CI_WORKFLOW_SHAPE/u);
    expect(() => parseWorkflow("on: push\njobs:\n  a:\n    runs-on: x\n")).toThrow(
      /CI_WORKFLOW_SHAPE/u,
    );
  });

  it("bounds every runner job with an explicit timeout", () => {
    for (const relative of workflows) {
      for (const job of workflow(path.basename(relative)).jobs) {
        if (job.runsOn !== undefined) {
          expect(job.timeoutMinutes, `${relative} ${job.id}`).toBeDefined();
        }
      }
    }
  });

  // PRD-480. Every Linux job that can move picks its runner from one expression, so the pool is
  // changed by setting or deleting a repository variable and nothing else. A job left at a bare
  // `ubuntu-latest` still runs, which is exactly why this has to be a spec: the pool comes up and
  // the queue does not shrink, and nothing in a run says which half of the board ignored it.
  const routing =
    "${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER) && 'ubuntu-24.04' || vars.TN_RUNNER }}";
  const lightRouting =
    "${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER_LIGHT) && 'ubuntu-24.04' || vars.TN_RUNNER_LIGHT }}";
  // PRD-620: a heavy lane is admitted to the idle pool only when its canonical id is in the one
  // plan the parent scope published. The fork and missing-runner guards stay, so a malicious or
  // stale plan can never route fork code or a withdrawn pool onto the owner's machine.
  const heavy = (id: string, need = "scope") =>
    `\${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER || !contains(fromJSON(needs.${need}.outputs.runner_admission || '[]'), '${id}')) && 'ubuntu-24.04' || vars.TN_RUNNER }}`;
  const heavyMatrix = (format: string, axis: string, need = "scope") =>
    `\${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER || !contains(fromJSON(needs.${need}.outputs.runner_admission || '[]'), format('${format}', ${axis}))) && 'ubuntu-24.04' || vars.TN_RUNNER }}`;
  const gpuPinGuard =
    "(!vars.TN_RUNNER_GPU_HEAD || (github.event.pull_request.head.sha || github.event.merge_group.head_sha || (github.event_name == 'push' && github.sha) || '') == vars.TN_RUNNER_GPU_HEAD) && vars.TN_RUNNER_GPU || ''";
  const gpuHeavy = (id: string, need = "scope") =>
    `\${{ github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || (${gpuPinGuard}) || ((!vars.TN_RUNNER || !contains(fromJSON(needs.${need}.outputs.runner_admission || '[]'), '${id}')) && 'ubuntu-24.04' || vars.TN_RUNNER) }}`;
  const gpuHeavyMatrix = (format: string, axis: string, need = "scope") =>
    `\${{ github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || ((${axis} == 'racing' || ${axis} == 'rain') && (${gpuPinGuard})) || ((!vars.TN_RUNNER || !contains(fromJSON(needs.${need}.outputs.runner_admission || '[]'), format('${format}', ${axis}))) && 'ubuntu-24.04' || vars.TN_RUNNER) }}`;
  const workflowMatrixContext = (input: {
    template: string;
    fork?: boolean;
    pin?: string;
    gpu?: string;
    runner?: string;
    admitted?: boolean;
  }) => ({
    matrix: { template: input.template },
    vars: {
      TN_RUNNER_GPU_HEAD: input.pin ?? "",
      TN_RUNNER_GPU: input.gpu ?? "",
      TN_RUNNER: input.runner ?? "",
    },
    github: {
      event_name: "pull_request",
      event: {
        pull_request: { head: { sha: "candidate-sha", repo: { fork: input.fork ?? false } } },
        merge_group: { head_sha: "" },
      },
      sha: "",
    },
    needs: {
      scope: {
        outputs: {
          runner_admission: JSON.stringify(
            input.admitted === false ? [] : [`ci:template-nonvisual:${input.template}`],
          ),
        },
      },
    },
    fromJSON: JSON.parse,
    contains: (values: unknown[], value: unknown) => values.includes(value),
    format: (pattern: string, value: unknown) => pattern.replace("{0}", String(value)),
  });

  it("pins optional GPU routing to the exact supported event SHA without changing fallbacks", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const scope = requiredJob(ci, "scope");
    const gpuGuard = scope.match(/TN_RUNNER_GPU: \$\{\{ (.+) \}\}/u)?.[1];
    expect(gpuGuard).toBe(gpuPinGuard);

    const pinnedGpuHeavy = (id: string) =>
      `\${{ github.event.pull_request.head.repo.fork && 'ubuntu-24.04' || (${gpuPinGuard}) || ((!vars.TN_RUNNER || !contains(fromJSON(needs.scope.outputs.runner_admission || '[]'), '${id}')) && 'ubuntu-24.04' || vars.TN_RUNNER) }}`;
    const pinnedGpuMatrix = gpuHeavyMatrix("ci:template-nonvisual:{0}", "matrix.template");
    for (const [job, expected] of [
      ["strata", pinnedGpuHeavy("ci:strata")],
      ["benchmark", pinnedGpuHeavy("ci:benchmark")],
      ["template-nonvisual", pinnedGpuMatrix],
    ] as const) {
      expect(requiredJob(ci, job).match(/^ {4}runs-on: (.+)$/mu)?.[1], `${job} GPU pin`).toBe(
        expected,
      );
    }

    const evaluateGpuGuard = (input: {
      isPullRequest: boolean;
      headSha?: string;
      eventName?: string;
      eventSha?: string;
      mergeGroupSha?: string;
      pin?: string;
      gpuLabel?: string;
    }): unknown =>
      runInNewContext(gpuGuard ?? "", {
        vars: {
          TN_RUNNER_GPU_HEAD: input.pin ?? "",
          TN_RUNNER_GPU: input.gpuLabel ?? "",
        },
        github: {
          event_name: input.eventName ?? (input.isPullRequest ? "pull_request" : "push"),
          sha: input.eventSha ?? "",
          event: {
            pull_request: { head: { sha: input.isPullRequest ? (input.headSha ?? "") : "" } },
            merge_group: { head_sha: input.mergeGroupSha ?? "" },
          },
        },
      });
    expect(
      evaluateGpuGuard({
        isPullRequest: true,
        headSha: "candidate-sha",
        eventSha: "merge-candidate-sha",
        pin: "candidate-sha",
        gpuLabel: "tn-gpu-pr483",
      }),
    ).toBe("tn-gpu-pr483");
    expect(
      evaluateGpuGuard({
        isPullRequest: true,
        headSha: "different-sha",
        eventSha: "candidate-sha",
        pin: "candidate-sha",
        gpuLabel: "tn-gpu-pr483",
      }),
    ).toBe("");
    expect(
      evaluateGpuGuard({ isPullRequest: true, headSha: "candidate-sha", gpuLabel: "tn-gpu-pr483" }),
    ).toBe("tn-gpu-pr483");
    expect(
      evaluateGpuGuard({
        isPullRequest: true,
        headSha: "candidate-sha",
        pin: "candidate-sha",
      }),
    ).toBe("");
    expect(
      evaluateGpuGuard({
        isPullRequest: false,
        pin: "candidate-sha",
        gpuLabel: "tn-gpu-pr483",
      }),
    ).toBe("");
    for (const eventName of ["push", "merge_group"]) {
      for (const matches of [true, false]) {
        expect
          .soft(
            evaluateGpuGuard({
              isPullRequest: false,
              eventName,
              eventSha: eventName === "push" ? "candidate-sha" : "different-event-sha",
              mergeGroupSha: eventName === "merge_group" ? "candidate-sha" : "",
              pin: matches ? "candidate-sha" : "different-pin",
              gpuLabel: "tn-gpu-pr483",
            }),
            `${eventName} exact pin match=${matches}`,
          )
          .toBe(matches ? "tn-gpu-pr483" : "");
      }
    }
    for (const eventName of ["workflow_dispatch", "schedule"]) {
      expect(
        evaluateGpuGuard({
          isPullRequest: false,
          eventName,
          eventSha: "candidate-sha",
          pin: "candidate-sha",
          gpuLabel: "tn-gpu-pr483",
        }),
        `${eventName} cannot use a pinned GPU route`,
      ).toBe("");
      expect(evaluateGpuGuard({ isPullRequest: false, eventName, gpuLabel: "tn-gpu-pr483" })).toBe(
        "tn-gpu-pr483",
      );
    }
  });

  it("routes Rain to the pinned GPU only for eligible non-fork runs", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const job = requiredJob(ci, "template-nonvisual");
    const matrixExpression = job.match(/^ {4}runs-on: \$\{\{ (.+) \}\}$/mu)?.[1] ?? "";
    const softwareExpression =
      job.match(/^ {6}TN_PLAYTEST_ALLOW_SOFTWARE: \$\{\{ (.+) \}\}$/mu)?.[1] ?? "";
    const cases = [
      { template: "rain", pin: "candidate-sha", gpu: "", expected: "ubuntu-24.04" },
      {
        template: "rain",
        pin: "candidate-sha",
        gpu: "tn-gpu-pr483",
        expected: "tn-gpu-pr483",
      },
      {
        template: "racing",
        pin: "candidate-sha",
        gpu: "tn-gpu-pr483",
        expected: "tn-gpu-pr483",
      },
      {
        template: "rain",
        pin: "candidate-sha",
        gpu: "tn-gpu-pr483",
        admitted: false,
        expected: "tn-gpu-pr483",
      },
      {
        template: "rain",
        fork: true,
        pin: "candidate-sha",
        gpu: "tn-gpu-pr483",
        expected: "ubuntu-24.04",
      },
      {
        template: "rain",
        pin: "different-sha",
        gpu: "tn-gpu-pr483",
        runner: "tn-local",
        expected: "tn-local",
      },
      {
        template: "starter",
        pin: "candidate-sha",
        gpu: "tn-gpu-pr483",
        runner: "tn-local",
        expected: "tn-local",
      },
      {
        template: "rain",
        pin: "different-sha",
        gpu: "tn-gpu-pr483",
        admitted: false,
        expected: "ubuntu-24.04",
      },
    ];
    for (const input of cases) {
      const result = runInNewContext(matrixExpression, workflowMatrixContext(input));
      expect(result, `${input.template} routes to ${input.expected}`).toBe(input.expected);
    }

    const softwareCases = [
      { template: "rain", pin: "candidate-sha", gpu: "tn-gpu-pr483", expected: "0" },
      {
        template: "rain",
        fork: true,
        pin: "candidate-sha",
        gpu: "tn-gpu-pr483",
        expected: "1",
      },
      { template: "rain", pin: "different-sha", gpu: "tn-gpu-pr483", expected: "1" },
      { template: "rain", pin: "candidate-sha", gpu: "", expected: "1" },
      { template: "starter", pin: "candidate-sha", gpu: "tn-gpu-pr483", expected: "1" },
    ];
    for (const input of softwareCases)
      expect(runInNewContext(softwareExpression, workflowMatrixContext(input))).toBe(
        input.expected,
      );
  });

  // `starter-linux` resolves its per-row runner inside the scope job, so the admission output it
  // reads is a step output there, not a `needs` one.
  const heavyStep = (id: string) =>
    `\${{ (github.event.pull_request.head.repo.fork || !vars.TN_RUNNER || !contains(fromJSON(steps.admission.outputs.runner_admission || '[]'), '${id}')) && 'ubuntu-24.04' || vars.TN_RUNNER }}`;
  // The canonical id each heavy job gates on. A matrix job carries its leg; `starter-linux` is
  // routed per shaped row, named `job/platform` the same way the matrix allow-list reads it.
  const heavyByJob = new Map<string, string>([
    ["ci.yml:typecheck", heavy("ci:typecheck")],
    ["ci.yml:lint", heavy("ci:lint")],
    ["ci.yml:test", heavy("ci:test")],
    ["ci.yml:test-native", heavy("ci:test-native")],
    ["ci.yml:test-browser", heavy("ci:test-browser")],
    ["ci.yml:test-playtest", heavy("ci:test-playtest")],
    ["ci.yml:strata", gpuHeavy("ci:strata")],
    ["ci.yml:benchmark", gpuHeavy("ci:benchmark")],
    ["ci.yml:build-artifacts", heavy("ci:build-artifacts")],
    ["ci.yml:performance-contracts", heavy("ci:performance-contracts")],
    ["ci.yml:budgets", heavy("ci:budgets")],
    ["ci.yml:test-unit", heavyMatrix("ci:test-unit:{0}", "matrix.shard")],
    ["ci.yml:golden-path-template", heavyMatrix("ci:golden-path-template:{0}", "matrix.template")],
    ["ci.yml:template-nonvisual", gpuHeavyMatrix("ci:template-nonvisual:{0}", "matrix.template")],
    ["ci.yml:template-engine-cost", heavyMatrix("ci:template-engine-cost:{0}", "matrix.template")],
    ["ci.yml:native-engine", heavy("ci:native-engine")],
    ["integration.yml:animation", heavy("integration:animation", "paths")],
    ["integration.yml:capture", heavy("integration:capture", "paths")],
    ["integration.yml:cold-boot", heavy("integration:cold-boot", "paths")],
    ["integration.yml:csg", heavy("integration:csg", "paths")],
    ["integration.yml:decals", heavy("integration:decals", "paths")],
    ["integration.yml:exposure", heavy("integration:exposure", "paths")],
    ["integration.yml:fluid-collision", heavy("integration:fluid-collision", "paths")],
    ["integration.yml:fog", heavy("integration:fog", "paths")],
    ["integration.yml:ik", heavy("integration:ik", "paths")],
    ["integration.yml:playstation", heavy("integration:playstation", "paths")],
    ["integration.yml:temporal", heavy("integration:temporal", "paths")],
    ["integration.yml:tone", heavy("integration:tone", "paths")],
    ["integration.yml:vegetation", heavy("integration:vegetation", "paths")],
    ["integration.yml:velocity", heavy("integration:velocity", "paths")],
    ["native-platforms.yml:web-reference", heavy("native:web-reference")],
    ["native-platforms.yml:android-v8-source", heavy("native:android-v8-source")],
    ["native-platforms.yml:desktop-parity", heavy("native:desktop-parity")],
    ["native-platforms.yml:starter-linux/linux-x64", heavyStep("native:starter-linux:linux-x64")],
  ]);
  const expectedHeavy = (relative: string, name: string): string | undefined =>
    heavyByJob.get(`${relative.split("/").pop() ?? relative}:${name}`);
  // The hosted jobs that stay hosted, per workflow. `supply-chain` runs gitleaks through
  // `docker run`; a self-hosted container would need the host Docker socket mounted to do that,
  // which would hand every job root on the owner's machine. `publish-android-v8` is the release
  // publish itself — `permissions: contents: write` and a `gh release upload` — and PRD-480 keeps
  // release writes on GitHub's own machines.
  const hosted = new Map<string, ReadonlySet<string>>([
    // PRD-731: queue-watch waits for a whole merge-group run, which a local slot must not hold.
    [".github/workflows/ci.yml", new Set(["supply-chain", "queue-watch"])],
    [
      ".github/workflows/native-platforms.yml",
      // publish-android-v8 writes the release; android-emulator-parity is CPU-bound SwiftShader that
      // overran its 45-minute budget on a pinned 4-thread slot (run 37082733117).
      new Set(["android-emulator-parity", "publish-android-v8", "publish-linux-arm64-v8"]),
    ],
    [
      ".github/workflows/integration.yml",
      // PRD-620: every generic Linux lane routes to idle tn-local with hosted fallback.
      new Set([]),
    ],
  ]);
  it.each([
    ["web-reference", "native-web-reference-${{ needs.scope.outputs.candidate_sha }}"],
    ["android-v8-source", "android-v8-${{ needs.scope.outputs.candidate_sha }}"],
  ])(
    "routes native platform prerequisite %s to idle tn-local with exact candidate artifacts",
    (job, artifact) => {
      const native = workflow("native-platforms.yml");
      const section = native.job(job);
      // PRD-620: these producers ride the same idle-pool switch with hosted fallback; the
      // snapshot fallback is best-effort and queued jobs may remain local.
      expect(section.require("runs-on")).toBe(heavy(`native:${job}`));
      expect(section.needs).toEqual(["scope"]);
      expect(section.env.TN_CI_SHA).toBe("${{ needs.scope.outputs.candidate_sha }}");
      expect(section.steps[0]?.with.ref).toBe("${{ needs.scope.outputs.candidate_sha }}");
      const upload = section.stepsUsing("actions/upload-artifact")[0];
      expect(upload?.with.name).toBe(artifact);
      expect(upload?.with["if-no-files-found"]).toBe("error");
      const android = native.job("android-emulator-parity");
      expect(android.needs).toEqual(["scope", "web-reference", "android-v8-source"]);
      expect(
        android.stepsUsing("actions/download-artifact").map((step) => step.with.name),
      ).toContain(artifact);
      if (job === "android-v8-source") {
        const v8 = section.steps.find(
          (step) => step.uses === "./.github/actions/android-v8-source",
        );
        expect(v8).toBeDefined();
        expect(section.outputs).toMatchObject({
          "recipe-hash": "${{ steps.v8.outputs.recipe-hash }}",
          published: "${{ steps.v8.outputs.published }}",
          // The release write consumes `trusted`, not `built`: a develop or main push that hits its
          // own cache must still be able to republish a missing asset (PRD-628 review round 2).
          trusted: "${{ steps.v8.outputs.trusted }}",
        });
      }
    },
  );

  it("isolates the cached Linux arm64 V8 producer from consumers and release credentials", () => {
    const native = workflow("native-platforms.yml");
    const source = native.job("linux-arm64-v8-source");
    const publish = native.job("publish-linux-arm64-v8");
    const hit =
      "steps.published.outputs.hit != 'true' && steps.payload.outputs.cache-hit != 'true'";
    expect(source.needs).toEqual(["scope"]);
    expect(source.runsOn).toBe("ubuntu-24.04-arm");
    expect(ciTerms(source.if ?? "")).toEqual([
      "github.event_name == 'workflow_dispatch'",
      "inputs.build_linux_arm64_v8 == true",
      "needs.scope.outputs.selection == 'full'",
      "needs.scope.outputs.native_tier != 'reduced'",
      "inputs.ios_only != true",
    ]);
    expect(
      (native.on.workflow_dispatch as { inputs: Record<string, unknown> }).inputs
        .build_linux_arm64_v8,
    ).toMatchObject({ default: false, required: false, type: "boolean" });
    expect(source.steps[0]?.with.ref).toBe("${{ needs.scope.outputs.candidate_sha }}");
    expect(source.timeoutMinutes).toBe(210);
    expect(source.permissions).toEqual({ contents: "read" });
    const recipe = String(source.stepById("recipe").env.RECIPE_HASH);
    expect([...recipe.matchAll(/'([^']+)'/gu)].map((match) => match[1])).toEqual([
      "packages/runtime-native/scripts/build-linux-arm64-v8.mjs",
    ]);
    const published = source.stepById("published");
    expect(published.env.ASSET).toBe("v8-linux-arm64-${{ steps.recipe.outputs.hash }}.tgz");
    expectIncludes(published.run ?? "", [
      "gh release download ci-v8-linux-arm64",
      "node packages/runtime-native/scripts/build-linux-arm64-v8.mjs --verify",
      "Published Linux arm64 V8 asset hit: $ASSET; no rebuild.",
    ]);
    expect(source.step("Restore resumable Linux arm64 V8 source").if).toBe(hit);
    expect(String(source.step("Restore resumable Linux arm64 V8 source").with.path)).toMatch(
      /packages\/runtime-native\/third_party\/\.v8-linux-arm64-source/u,
    );
    expect(source.step("Save the verified Linux arm64 V8 payload").if).toMatch(
      /steps\.verify\.outcome == 'success'/u,
    );
    expect(source.step("Save interrupted Linux arm64 V8 source").if).toMatch(
      /steps\.build\.outcome == 'failure'/u,
    );
    expect(source.stepById("build").run).toMatch(/timeout --signal=TERM --kill-after=30s 180m/u);
    expectIncludes(source.stepById("verify").run ?? "", [
      'ar p "$library" "$member"',
      'file "$RUNNER_TEMP/v8-arm64-member.o"',
      "grep -Eq 'Machine:.*AArch64'",
      'sha256sum "$ASSET"',
    ]);
    expect(source.stepsUsing("actions/upload-artifact")[0]?.with["if-no-files-found"]).toBe(
      "error",
    );
    expect(source.mentions("contents: write")).toBe(false);
    expect(publish.needs).toEqual(["scope", "linux-arm64-v8-source"]);
    expect(ciTerms(publish.if ?? "")).toEqual(
      expect.arrayContaining([
        "github.event_name != 'pull_request'",
        "github.ref == 'refs/heads/main'",
        "github.ref == 'refs/heads/develop'",
      ]),
    );
    expect(publish.permissions).toEqual({ contents: "write" });
    expect(publish.stepsUsing("actions/checkout")).toEqual([]);
    expect(publish.runs(/\bnode /u)).toBe(false);
    expectIncludes(publish.scripts, [
      "sha256sum --check linux-arm64-v8-proof/payload.sha256",
      'gh release upload ci-v8-linux-arm64 "payload/$ASSET"',
      'cmp -- "payload/$ASSET" "$RUNNER_TEMP/published-v8/$ASSET"',
    ]);
    expectExcludes(publish.scripts, ["--clobber"]);
    expect(native.job("starter-linux").needs).not.toEqual(
      expect.arrayContaining(["linux-arm64-v8-source"]),
    );
    expect(native.job("completion").needs).toEqual(
      expect.arrayContaining(["linux-arm64-v8-source", "publish-linux-arm64-v8"]),
    );
    const install = source.step("Install the pinned Linux arm64 V8 compiler");
    expect(install.if).toBe(hit);
    expectIncludes(install.run ?? "", [
      "sudo apt-get update",
      "sudo apt-get install -y --allow-downgrades clang-18=1:18.1.3-1ubuntu1 lld-18=1:18.1.3-1ubuntu1 llvm-18=1:18.1.3-1ubuntu1 libclang-rt-18-dev=1:18.1.3-1 ninja-build build-essential python3 git pkg-config libglib2.0-dev",
    ]);
    expect(install.index).toBeLessThan(source.step("Build the Linux arm64 V8 payload").index);
  });

  // PRD-480's light lane: the jobs whose whole work is a script or a summary — no workspace build
  // and no test suite; a JSON aggregator may still `pnpm install` its own toolchain. `scope`
  // classifies the diff, `build` and `golden-path`
  // assert an upstream verdict, `ci-required` is the merge verdict and `run-summary` writes the
  // report; in native-platforms.yml `networking-matrix` is the one join that needs no toolchain, and
  // `release-reports` and `performance-coverage` only download artifacts and write JSON (no compile
  // or GPU leg). They join on
  // `tn-local-light` (1 CPU, 2 GB) so a ten-second verdict does not queue behind
  // five twenty-minute builds. Both directions are load-bearing and both are asserted below: a
  // heavy job here would build the workspace in one core, and a light job off the list would queue
  // behind the heavy pool — which is the wait the lane exists to remove.
  const light = new Set([
    "completion",
    "build",
    "ci-required",
    "golden-path",
    "networking-matrix",
    "paths",
    "performance-coverage",
    "release-reports",
    "run-summary",
    "scope",
  ]);

  // A matrix job routes per row: `runs-on: ${{ matrix.runner }}` is only a pointer, and what decides
  // where a leg lands is the `runner:` value inside `strategy.matrix.include`. Both native
  // matrices carry hosted rows next to movable ones (`linux-x64` moves, `linux-arm64` cannot), so
  // the row is named `job/row` here and that is the key the hosted allow-list would use.
  function matrixRunnerRows(job: string, section: string): readonly (readonly [string, string])[] {
    const rows: [string, string][] = [];
    for (const row of section.split(/^ {10}- /mu).slice(1)) {
      const runner = row.match(/^ {12}runner: (.+)$/mu)?.[1];
      if (runner !== undefined) {
        const platform = row.match(/^\s*platform: (.+)$/mu)?.[1] ?? runner;
        rows.push([`${job}/${platform}`, runner]);
      }
    }
    return rows;
  }

  // `starter-linux` has no `include` rows at all: a job's `if` cannot read `matrix`, so the arm64 leg
  // an ordinary pull request does not owe is dropped by shaping the matrix in `scope` instead. The
  // rows therefore still name their runners, one job earlier. Following the pointer is what stops a
  // moved row from escaping the switch by moving — the values are asserted in the same place.
  function shapedRunnerRows(
    job: string,
    section: string,
    source: string,
  ): readonly (readonly [string, string])[] {
    if (!/^\s+matrix: \$\{\{ fromJSON\(needs\.scope\.outputs\./mu.test(section)) return [];
    const scope = source.match(/^ {2}scope:\n([\s\S]*?)(?=^ {2}\S)/mu)?.[1] ?? "";
    const rows: [string, string][] = [];
    for (const row of scope.matchAll(/\{ platform: "([^"]+)", runner: ("[^"]+") \}/gu)) {
      rows.push([`${job}/${row[1] ?? ""}`, (row[2] ?? "").slice(1, -1)]);
    }
    return rows;
  }

  it("routes every movable Linux job through its configured runner pool", async () => {
    const directory = path.join(repo, ".github/workflows");
    const routed = [
      ".github/workflows/ci.yml",
      ".github/workflows/native-platforms.yml",
      ...(await readdir(directory))
        .filter(
          (entry) =>
            entry === "integration.yml" ||
            (entry.startsWith("integration-") && entry.endsWith(".yml")),
        )
        .map((entry) => `.github/workflows/${entry}`),
    ].sort();
    expect(routed.length).toBeGreaterThan(2);
    for (const relative of routed) {
      const keepHosted = hosted.get(relative) ?? new Set<string>();
      const source = await readFile(path.join(repo, relative), "utf8");
      for (const [job, section] of jobSections(source)) {
        const runsOn = section.match(/^\s+runs-on:.*$/mu)?.[0].trim();
        if (runsOn === undefined) continue;
        const rows = [...matrixRunnerRows(job, section), ...shapedRunnerRows(job, section, source)];
        const targets: readonly (readonly [string, string])[] =
          rows.length > 0 ? rows : [[job, runsOn.replace(/^runs-on: /u, "")]];
        for (const [name, runner] of targets) {
          const target = `${relative} ${name}`;
          // macOS, Windows and arm64 have no tn-local counterpart, so the expression must never
          // appear on one of them.
          if (/macos|windows|arm/u.test(runner)) {
            expect(runner, `${target} is not Linux`).not.toContain(routing);
            expect(runner, `${target} is not Linux`).not.toContain(lightRouting);
            continue;
          }
          const expected = expectedHeavy(relative, name);
          const onHeavy = expected !== undefined && runner === expected;
          const onLight = runner === lightRouting;
          if (keepHosted.has(name)) {
            expect(
              onHeavy || onLight,
              `${target} is on the hosted allow-list but selects ${runner}`,
            ).toBe(false);
            continue;
          }
          expect(
            onHeavy || onLight,
            `${target} runs on \`${runner}\`: use the TN_RUNNER routing expression, or name it on the hosted allow-list`,
          ).toBe(true);
          expect(
            light.has(name),
            `${target} is ${onLight ? "on" : "off"} the light lane: only ${[...light].join(", ")} may select tn-local-light`,
          ).toBe(onLight);
        }
      }
    }
  });

  // PRD-620: the generic lanes route to idle tn-local with hosted fallback; the light switch and native ARM labels stay.
  it("routes generic Integration lanes to idle tn-local while the light and native legs keep their routing", async () => {
    const source = await readFile(path.join(repo, ".github/workflows/integration.yml"), "utf8");
    const runsOn = (job: string) => requiredJob(source, job).match(/^ {4}runs-on: (.+)$/mu)?.[1];
    for (const job of [
      "animation",
      "capture",
      "cold-boot",
      "csg",
      "decals",
      "exposure",
      "fluid-collision",
      "fog",
      "ik",
      "playstation",
      "temporal",
      "tone",
      "vegetation",
      "velocity",
    ] as const) {
      expect(runsOn(job), `integration ${job} routes to idle tn-local first`).toBe(
        heavy(`integration:${job}`, "paths"),
      );
    }
    for (const job of ["paths", "completion"] as const) {
      expect(runsOn(job), `integration ${job} keeps the light routing switch`).toBe(lightRouting);
    }
    for (const job of [
      "animation-native",
      "decals-native",
      "fluid-collision-native",
      "fog-native",
      "packaged-quickjs",
    ] as const) {
      expect(runsOn(job), `integration ${job} keeps its native ARM label`).toBe("ubuntu-24.04-arm");
    }
  });

  // PRD-620: one parent scope decides the single admitted slice from the count the publisher
  // advertises and forwards that one plan to both reusable workflows; every heavy selector keeps
  // its fork/missing-runner guard and adds the membership test beside it.
  it("publishes one admission budget from the parent and forwards it to both reusable workflows", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const scope = requiredJob(ci, "scope");
    expect(scope).toContain("runner_admission: ${{ steps.admission.outputs.runner_admission }}");
    expect(scope).toContain("node scripts/ci-runner-admission.mjs --admit");
    expect(scope).toContain("TN_RUNNER_SLOTS: ${{ vars.TN_RUNNER_SLOTS }}");
    expect(scope).toContain(`TN_RUNNER_GPU: \${{ ${gpuPinGuard} }}`);
    const forwarded =
      ci.match(/runner_admission: \$\{\{ needs\.scope\.outputs\.runner_admission \}\}/gu) ?? [];
    expect(forwarded, "one plan reaches both reusable workflows").toHaveLength(2);
    for (const relative of [
      ".github/workflows/integration.yml",
      ".github/workflows/native-platforms.yml",
    ]) {
      const source = await readFile(path.join(repo, relative), "utf8");
      expect(source, `${relative} declares the admission input`).toContain("runner_admission:");
      expect(source, `${relative} validates the supplied plan`).toContain(
        "node scripts/ci-runner-admission.mjs --validate-admission",
      );
      expect(source).toContain("TN_RUNNER_ADMISSION: ${{ inputs.runner_admission }}");
      // No platform or receipt weakening: the coverage receipt the verdict reads is unchanged.
      expect(source).toContain("coverage_receipt:");
    }
    // The admission test is added to the fork and missing-runner guards, never swapped in.
    for (const expression of heavyByJob.values()) {
      expect(expression).toContain("github.event.pull_request.head.repo.fork");
      expect(expression).toContain("!vars.TN_RUNNER");
    }
  });

  // PRD-731. The thin lane a ready pull request runs: the workflow admits `review` to exactly the
  // jobs the plan requires for it, and to no job of the queue's board.
  it("admits the review lane to its jobs only", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const plan = (
      (await import(new URL("../ci-change-scope.mjs", import.meta.url).href)) as {
        selectionPlan: (...args: unknown[]) => { jobs: Record<string, { required: boolean }> };
      }
    ).selectionPlan(
      "review",
      "fixture",
      ["packages/core/src/a.ts"],
      "a".repeat(40),
      false,
      0,
      "develop",
    );
    for (const [name, section] of jobSections(ci)) {
      if (["scope", "ci-required", "run-summary", "queue-watch", "integration"].includes(name))
        continue;
      const admitted = /\bselection == 'review'/u.test(section);
      expect(
        admitted,
        `${name}: review admission must match the plan (${String(plan.jobs[name]?.required)})`,
      ).toBe(plan.jobs[name]?.required === true);
    }
    expect(plan.jobs.integration?.required).toBe(false);
    expect(requiredJob(ci, "integration")).toContain("jobs.integration.required");
  });

  // PRD-731. A red merge group is named on its pull request before the rest of the run is
  // cancelled, which is the exception to "no job cancels its own run" and the reason for the order.
  it("names the first red job on the pull request before the queue run is cancelled", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const watch = requiredJob(ci, "queue-watch");
    const gate = /^ {4}if: (.*)$/mu.exec(watch)?.[1] ?? "";
    expect(gate).toContain("github.event_name == 'merge_group'");
    expect(gate).toContain("needs.scope.outputs.selection == 'full'");
    expect(gate).toContain("!github.event.pull_request.head.repo.fork");
    // A develop push has one concurrency slot, and main feeds the release.
    expect(gate).not.toContain("'push'");
    expect(gate).not.toContain("'schedule'");
    expect(watch).toContain("github.event.merge_group.head_ref");
    const script = await readFile(path.join(repo, "scripts/ci-queue-watch.mjs"), "utf8");
    expect(script.indexOf("/comments")).toBeGreaterThan(0);
    expect(script.indexOf("/comments")).toBeLessThan(script.indexOf('"cancel"'));
    // The watcher gates nothing: no job waits on it, or it would wait on itself.
    for (const [name, section] of jobSections(ci)) {
      if (name !== "queue-watch") expect(declaredNeeds(section), name).not.toContain("queue-watch");
    }
  });

  // A draft PR spends no runner: every job needs `scope`, so skipping it and the always() gate
  // skips the board, and `ready_for_review` starts it once the draft is marked ready.
  it("runs nothing on draft pull requests until they are marked ready", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(triggerSection(ci)).toContain(
      "types: [opened, synchronize, reopened, ready_for_review]",
    );
    expect(ci).toContain("name: Change scope\n    if: ${{ !github.event.pull_request.draft }}");
    expect(ci).toContain("if: ${{ always() && !github.event.pull_request.draft }}");
  });

  // PRD-481 adds a fourth selection and a fourth trigger. Every gate's condition has to name what it
  // admits rather than what it excludes: `!= 'prose'` reads a reused tree as "not prose" and runs a
  // second full lint on a tree CI already passed.
  it("runs the merge group and admits no gate on a reused tree", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(triggerSection(ci)).toContain("merge_group:\n    types: [checks_requested]");
    for (const [name, section] of jobSections(ci)) {
      // ci-required is the verdict, not a gate: it runs on `always()` and reads the plan instead.
      // scope is the decision that produces the selection.
      if (name === "integration") {
        expect(section).toContain("fromJSON(needs.scope.outputs.plan).jobs.integration.required");
        continue;
      }
      if (name === "ci-required" || name === "scope") continue;
      // PRD-731: the watcher is no gate. It runs for a merge group only and has no selection.
      if (name === "queue-watch") {
        expect(section).toContain("github.event_name == 'merge_group'");
        continue;
      }
      expect(section, `${name} does not name the selection it admits`).toContain(
        "selection == 'full'",
      );
      expect(section, `${name} would run on a reused tree`).not.toContain("selection != 'prose'");
    }
    // A merge group carries no pull_request object, so `!github.event.pull_request.draft` is true
    // for it. That has to stay true, or the queue waits forever on a check nobody will report.
    expect(requiredJob(ci, "scope")).toContain("if: ${{ !github.event.pull_request.draft }}");
    expect(requiredJob(ci, "ci-required")).toContain(
      "if: ${{ always() && !github.event.pull_request.draft }}",
    );
    // Both jobs that consult the Actions API, and only with a read-only token.
    for (const name of ["scope", "ci-required"]) {
      expect(requiredJob(ci, name)).toContain("actions: read");
      expect(requiredJob(ci, name)).toContain("GH_TOKEN: ${{ github.token }}");
    }
  });

  // The audit behind PRD-481 cost 2.4k runner-minutes on one workflow that was still listed against
  // a branch whose lane landed three weeks earlier, and ran a second time for every commit that
  // also opened a pull request. Neither shape is visible from the workflow file alone, which is why
  // they are stated as rules here rather than left to whoever reads the next one.
  it("names every workflow file so none lands unreviewed", async () => {
    const onDisk = (await readdir(path.join(repo, ".github/workflows")))
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => `.github/workflows/${name}`)
      .sort();
    expect(onDisk).toEqual([...reviewedWorkflows].sort());
    // The owner's rule: no workflow file per feature. A new lane is a job in an existing workflow
    // with its own paths gate, not a new set of triggers, permissions and required checks. The
    // allow-list above already rejects an unnamed file; this names the shape it rejects.
    expect(
      onDisk.filter((name) => /integration-[^/]+\.ya?ml$/u.test(name)),
      "a per-feature integration workflow is back; add its proof as a job in integration.yml",
    ).toEqual([]);
  });

  it("keeps every integration lane in one workflow, each with its own paths gate", async () => {
    const integrations = reviewedWorkflows.filter((name) => name.includes("/integration"));
    expect(
      integrations,
      "the integration lanes are one workflow, not one file per feature",
    ).toEqual([".github/workflows/integration.yml"]);
    const source = await readFile(path.join(repo, ".github/workflows/integration.yml"), "utf8");
    expect(duplicateCommitTriggers(source)).toEqual([]);
    // Skipping drafts only saves a runner if the event that ends the draft is one this workflow
    // listens for. Without `ready_for_review` the guard turns the lanes off rather than cheap.
    expect(triggerSection(source)).toContain("workflow_call:");
    expect(
      triggerSection(await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8")),
    ).toContain("types: [opened, synchronize, reopened, ready_for_review]");
    const sections = jobSections(source);
    // A job behind another job of the same workflow is skipped when that one is, so the guard belongs
    // on the entry points only.
    for (const [job, section] of sections) {
      if (/^ {4}needs:/mu.test(section)) continue;
      expect(section, `${job} runs on a draft`).toContain(
        "if: ${{ !github.event.pull_request.draft }}",
      );
    }
    // One gate, one output per lane, and every lane job reads its own. A lane folded in without its
    // filter would run on every pull request; a filter with no job behind it would silently stop.
    const lanes = [...source.matchAll(/^ {12}([a-z][a-z-]*) \^/gmu)].map((match) => match[1]);
    expect(lanes.length, "a lane lost its trigger filter").toBeGreaterThanOrEqual(5);
    for (const lane of lanes) {
      const gated = sections.filter(([, section]) =>
        section.includes(`needs.paths.outputs.${lane} == 'true'`),
      );
      expect(gated.length, `no job runs the ${lane} gate`).toBeGreaterThanOrEqual(1);
      for (const [job, section] of gated) {
        expect(section, `${job} runs the ${lane} gate on a draft`).toContain(
          "!github.event.pull_request.draft",
        );
      }
      expect(source, `the ${lane} gate is not exposed as a job output`).toContain(
        `${lane}: \${{ steps.filter.outputs.${lane} }}`,
      );
    }
    for (const [job, section] of sections) {
      if (job === "paths" || /^ {4}needs:/mu.test(section)) continue;
      expect(section, `${job} is not behind a per-lane gate`).toContain("needs: paths");
    }
  });

  it("rejects a push trigger that would fire beside pull_request, or for one branch", () => {
    expect(
      duplicateCommitTriggers(
        [
          "name: fixture",
          "on:",
          "  pull_request:",
          "    paths:",
          "      - 'examples/a/**'",
          "  push:",
          "    paths:",
          "      - 'examples/a/**'",
          "",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "",
        ].join("\n"),
      ),
    ).toEqual(["push + pull_request: one commit runs this workflow twice"]);
    expect(
      duplicateCommitTriggers(
        [
          "name: fixture",
          "on:",
          "  pull_request:",
          "    paths:",
          "      - 'examples/a/**'",
          "  push:",
          "    branches: ['fix/vq11-decal-material-lifetime']",
          "",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "",
        ].join("\n"),
      ),
    ).toEqual([
      "push narrowed to fix/vq11-decal-material-lifetime: the lane outlives its pull request",
    ]);
    // `push` alone is how a workflow follows its own branch after a merge, and how ci.yml hears
    // about main. The rule is the pair, not the trigger.
    expect(
      duplicateCommitTriggers(
        [
          "name: fixture",
          "on:",
          "  push:",
          "    branches: [main]",
          "",
          "jobs:",
          "  test:",
          "    runs-on: ubuntu-latest",
          "",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("keeps the pipeline-cache proof's triggers on what that proof reads", async () => {
    const relative = ".github/workflows/pipeline-cache.yml";
    const source = await readFile(path.join(repo, relative), "utf8");
    const commands = commandText(source);

    // Every path it fires on has to be a path its own steps open, or the lane runs a 45-minute
    // native proof for a commit that cannot have moved it. The workflow file itself is the one
    // exemption: GitHub reads it to decide, and every lane lists itself.
    const entries = triggerPaths(source);
    expect(
      entries.length,
      "the pipeline-cache lane stopped narrowing its triggers",
    ).toBeGreaterThan(0);
    for (const entry of entries) {
      if (entry === relative) continue;
      expect(commands, `${relative} fires on ${entry}, which its steps never read`).toContain(
        entry.replace(/\/?\*\*$/u, "/"),
      );
    }

    // `push` on a protected branch only, and never beside `pull_request`. The branch it listed
    // until now — `feat/prd-368-persistent-pipeline-cache` — kept compiling an android-arm64 ABI
    // job for 41 runs and 2.4k runner-minutes after the lane it was opened for had landed.
    expect(duplicateCommitTriggers(source), relative).toEqual([]);
  });

  it("preserves main qualification while enabling develop PRs and serializes release lanes", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const native = await readFile(path.join(repo, ".github/workflows/native-release.yml"), "utf8");
    expect(ci).toMatch(/push:\n\s+branches:\n\s+- main/u);
    expect(ci).toMatch(/pull_request:\n\s+branches:\n\s+- main/u);
    expect(ci).toContain("group: ci-${{ github.event_name }}-${{ github.ref }}");
    // Every release proof shares one group now, whatever triggered it: a per-ref or per-SHA key
    // is what let a promotion PR, a manual dispatch and a main CI completion hold the pool at
    // once. `native-release-proof.spec.ts` owns the setting; this is the structural backstop.
    expect(native).toContain("&& 'native-release-proof' ||");
    expect(native).toContain("cancel-in-progress: false");
    const triggers = triggerSection(native);
    // PRD-630: the promotion PR holds the one proof, and `pnpm release:ship` dispatches the tag run.
    expect(triggers).not.toContain("workflow_run:");
    expect(triggers).not.toContain("\n  push:");
    expect(triggerSection(npm)).toContain("workflow_run:");
  });

  it("holds every release proof in one cross-branch concurrency group", async () => {
    const native = await readFile(path.join(repo, ".github/workflows/native-release.yml"), "utf8");
    const concurrency = triggerSection(native).split("\nconcurrency:\n")[1] ?? "";
    expect(concurrency, "native-release declares no concurrency block").not.toBe("");
    // Exactly one, and carrying nothing event-derived. A `${{ github.ref }}` or
    // `${{ github.event.workflow_run.head_sha }}` suffix is a second proof running beside the
    // first, which is exactly the starvation this group exists to end (PRD-380: 7.0k
    // runner-minutes of PR proof against a pool of about three).
    const groups = [...concurrency.matchAll(/^\x20{2}group: (.*)$/gmu)].map((match) => match[1]);
    // Proof-eligible runs share `native-release-proof`; every other run (an ordinary PR push that
    // `gates` refuses) gets a group of its own so it can never displace a pending proof. A release
    // tag run has its own group too (PRD-629), so no proof run can queue ahead of a publish.
    expect(groups).toEqual([
      "${{ github.ref_type == 'tag' && 'native-release-tag' || (github.event_name != 'pull_request' || github.event.pull_request.base.ref == 'main' || contains(github.event.pull_request.labels.*.name, 'release-proof')) && 'native-release-proof' || format('native-release-skip-{0}', github.run_id) }}",
    ]);
    // `false`, not a conditional: a superseded run still lets its queued consumer finish.
    expect(concurrency).toContain("cancel-in-progress: false");
  });

  it("reruns only a failed CI run's failed jobs, once, and only for known flakes", async () => {
    const janitor = await readFile(path.join(repo, ".github/workflows/ci-janitor.yml"), "utf8");
    expect(janitor).toMatch(/workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/u);
    // Once: a second failure of the same run is a real signal, never retried again.
    expect(janitor).toContain("github.event.workflow_run.run_attempt == 1");
    expect(janitor).toContain("github.event.workflow_run.conclusion == 'failure'");
    // Only the failed jobs, and only when every primary failure matches a flake signature.
    expect(janitor).toContain('gh run rerun "$RUN_ID" --failed');
    expect(janitor).toMatch(/FLAKE: TN_PLAYTEST_SOFTWARE_DEVICE_LOST\|/u);
    expect(janitor).toContain("not a known flake; leaving the run red");
  });

  it("cancels a closed pull request's runs without injecting its head ref into a shell", async () => {
    const janitor = await readFile(path.join(repo, ".github/workflows/ci-janitor.yml"), "utf8");
    // Merged or closed, nothing the head ref is still doing can change the outcome, and those
    // runs went on holding runners for another 5.0k runner-minutes over 2026-09-18 to 10-02.
    expect(triggerSection(janitor)).toMatch(/pull_request:\n\x20{4}types: \[closed\]/u);
    // Cancelling a run is an Actions write; a token that cannot do it reports success while
    // cancelling nothing.
    expect(janitor).toMatch(/permissions:\n\x20{2}actions: write/u);
    const cancel = jobSections(janitor).find(([name]) => name === "cancel")?.[1] ?? "";
    expect(cancel, "ci-janitor declares no cancel job").not.toBe("");
    // The head ref is attacker-controlled branch text: interpolated straight into `run:` it is a
    // command injection on a job holding `actions: write`. So is the base ref the merge-group
    // prefix is built from, and the number inside it.
    expect(cancel).toMatch(
      /env:\n(?:\x20{10}[A-Z_]+: .*\n)*\x20{10}HEAD_REF: \$\{\{ github\.event\.pull_request\.head\.ref \}\}/u,
    );
    expect(cancel).toMatch(
      /\x20{10}BASE_REF: \$\{\{ github\.event\.pull_request\.base\.ref \}\}\n\x20{10}PR_NUMBER: \$\{\{ github\.event\.pull_request\.number \}\}/u,
    );
    for (const line of cancel.split("\n")) {
      if (/^\x20*#/u.test(line) || !/(?:head[._]ref|base\.ref|\.number)/u.test(line)) continue;
      expect(
        line,
        "a github.* context is interpolated into a shell instead of passed as env",
      ).not.toMatch(/run:/u);
    }
    // A fork's runs belong to another repository; its token cannot cancel them, and trying would
    // fail a red check on every fork PR close.
    expect(cancel).toMatch(
      /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/u,
    );
    // The promotion PR's head is `develop`: closing it must not cancel develop's own CI runs.
    expect(cancel).toMatch(
      /head\.ref != 'develop' && github\.event\.pull_request\.head\.ref != 'main'/u,
    );
    expect(cancel).toContain('gh run list --repo "$GITHUB_REPOSITORY" --branch "$HEAD_REF"');
    expect(cancel).toContain("--json databaseId,status");
    // A merge-group run reports its branch as `gh-readonly-queue/<base>/pr-<number>-<sha>`. GitHub
    // drops the pull request from the queue on close but never cancels the run it already started,
    // so #404's run 37093098790 held nine self-hosted jobs after #404 had merged: the head ref's
    // cancel never reaches it. The prefix is built from the event's own base ref and number, so the
    // sweep reaches that pull request's group and no other.
    expect(cancel).toContain('group_prefix="gh-readonly-queue/${BASE_REF}/pr-${PR_NUMBER}-"');
    expect(cancel).toContain("startswith($prefix)");
    expect(cancel).toContain(
      'gh run list --repo "$GITHUB_REPOSITORY" --json databaseId,status,headBranch --limit 100',
    );
    // The run-sweeping predecessor this replaced reached across every branch in the repository;
    // every cancel here is scoped to the event's own repository and the closed PR's own ref.
    expect(cancel).toContain(
      'gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/force-cancel"',
    );
    // Never a failure handler: cancelling from the gate that went red is what erased which
    // gate went red, on 2026-09-02.
    expect(cancel, "the janitor must not be a failure handler").not.toContain("failure()");
    // Only the runs still holding a runner, and never the janitor's own.
    for (const status of ["queued", "in_progress"]) {
      expect(cancel).toContain(`.status == "${status}"`);
    }
    expect(cancel).toMatch(/SELF_RUN_ID/gu);
    expect(cancel).toMatch(/actions\/runs\/\$run_id\/force-cancel/u);
    // A run that finished between the list and the cancel is the expected race, not a failure:
    // the cancel is a guarded command, so its non-zero exit is reported rather than propagated.
    expect(cancel).toContain(
      'if gh api -X POST "repos/$GITHUB_REPOSITORY/actions/runs/$run_id/force-cancel"',
    );
    // And the lookup itself fails closed, so a broken call cannot report success having
    // cancelled nothing.
    expect(cancel).toContain("set -euo pipefail");
    expect(cancel).toMatch(/runs="\$\(gh run list/u);
  });

  // A `gh` call infers its repository from a git checkout. A job that never checks out has
  // none, so `gh` dies with "failed to determine base repo" — and a gate that dies is a gate
  // that never asked its question. `native-release.yml`'s CI gate shipped that way and could
  // not be caught by anything: the workflow runs only on a `runtime-native-v*` tag, and the
  // first such tag ever pushed was the one that exposed it.
  // A `gh` call infers its repository from a git checkout. A job that never checks out has
  // none, so `gh` dies with "failed to determine base repo" -- and a gate that dies is a gate
  // that never asked its question. The native release's CI gate shipped that way and nothing
  // could have caught it: that workflow runs only on a `runtime-native-v*` tag, and the first
  // such tag ever pushed was the one that exposed it.
  it("passes an explicit repository to every gh call in a job that never checks out", async () => {
    const offenders: string[] = [];
    for (const relative of workflows) {
      const source = await readFile(path.join(repo, relative), "utf8");
      for (const [job, section] of jobSections(source)) {
        if (section.includes("uses: actions/checkout")) continue;
        // Read whole commands, not lines: a flag may sit on a continuation line, and a `#`
        // line is prose. Both were false readings of this same section.
        const lines = section.split("\n").filter((line) => !/^\s*#/u.test(line));
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          if (!/(?:^|[\s"'`(|&;$])gh\s+(?:api|run|release|pr|issue|workflow|cache)\b/u.test(line))
            continue;
          let command = line;
          for (let next = index + 1; next < lines.length; next += 1) {
            const continuation = lines[next] ?? "";
            const continued =
              command.trimEnd().endsWith("\\") || /^\s*-{1,2}\w/u.test(continuation);
            if (!continued) break;
            command += ` ${continuation}`;
          }
          if (command.includes("--repo") || command.includes("repos/$GITHUB_REPOSITORY/")) continue;
          offenders.push(`${relative} ${job}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("ships from one job after a green main run, and provisions it before the command", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const ship = requiredJob(npm, "ship");
    expect(ship).toContain("github.event.workflow_run.event == 'push'");
    expect(ship).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(ship).toContain("ref: ${{ github.event.workflow_run.head_sha }}");
    const command = ship.indexOf("pnpm release:ship --yes");
    for (const need of [
      "run: pnpm build",
      "libvulkan1 mesa-vulkan-drivers",
      "platforms;android-35",
    ]) {
      expect(ship.indexOf(need), need).toBeGreaterThanOrEqual(0);
      expect(command, need).toBeGreaterThan(ship.indexOf(need));
    }
    expect(jobSections(npm).map(([job]) => job)).toEqual(["ship", "clean-room"]);
  });

  // The clean room's `android` step builds the APK in the published cohort. Without a JDK 17 and an
  // SDK carrying a platform and the build tools (where `zipalign` and `apksigner` live) that step
  // cannot run, and the step is the one consumer observation a release never gets back.
  it("provisions a JDK 17 and an Android SDK before the clean room runs its android step", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const cleanRoom = jobSections(npm).find(([job]) => job === "clean-room")?.[1];
    expect(cleanRoom).toBeDefined();
    if (cleanRoom === undefined) return;
    expect(cleanRoom).toContain('java-version: "17"');
    expect(cleanRoom).toContain("platforms;android-35");
    expect(cleanRoom).toContain("build-tools;35.0.0");
    const java = cleanRoom.indexOf("actions/setup-java@v5");
    const sdk = cleanRoom.indexOf("android-actions/setup-android@v4");
    const verifier = cleanRoom.indexOf("pnpm tsx scripts/verify-registry-install.ts");
    expect(java).toBeGreaterThanOrEqual(0);
    expect(sdk).toBeGreaterThan(java);
    expect(verifier).toBeGreaterThan(sdk);
  });

  // A clean-room-only dispatch re-proves the published cohort without a publish: it must never
  // reach `gates` or `publish`, and the clean room must still run after a real publish succeeds.
  it("a tag run rerun replaces its own prerelease and leaves a public release alone", async () => {
    const native = await readFile(path.join(repo, ".github/workflows/native-release.yml"), "utf8");
    const step = native.slice(native.indexOf("- name: Publish runtimes and checksum lock"));
    const guard = step.indexOf("--json isPrerelease --jq .isPrerelease");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(step.indexOf('gh release create "$RELEASE_TAG"'));
  });

  it("runs the clean room alone on a dispatch", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const cleanRoom = jobSections(npm).find(([job]) => job === "clean-room")?.[1];
    expect(cleanRoom).toContain("if: github.event_name == 'workflow_dispatch'");
    // The desktop prebuilt links the overlay webview; without it doctor and native exit 127.
    expect(cleanRoom).toContain("libwebkit2gtk-4.1-0");
  });

  it("desktop parity runs against a captured web reference and fails closed", async () => {
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const desktop = requiredJob(native, "desktop-parity");
    const producer = requiredJob(native, "web-reference");
    expect(desktop).toContain("timeout-minutes: 75");
    const capture = producer.indexOf("--target web --out artifacts/conformance/web");
    const comparison = desktop.indexOf(
      "--target desktop --reference artifacts/conformance/web --out artifacts/conformance/desktop",
    );
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(producer.indexOf("actions/upload-artifact")).toBeGreaterThan(capture);
    expect(desktop.indexOf("actions/download-artifact")).toBeLessThan(comparison);
    expect(desktop).not.toContain("--target web --out artifacts/conformance/web");
    expect(desktop).toMatch(
      /sh scripts\/xvfb\.sh \\\n\s+node packages\/runtime-native\/conformance\/run-conformance\.mjs \\\n\s+--target desktop/u,
    );
    expect(occurrences(desktop, /test "\$status" -eq 0 -o "\$status" -eq 2/gu)).toBe(1);
    expect(occurrences(desktop, /check-lane-blocks\.mjs/gu)).toBe(2);
    expect(desktop).toContain("TN_PARITY_DESKTOP_REPORT_MISSING");
    expect(desktop).toContain('"## Target results"');
    expect(desktop).toContain("pnpm parity:ledger");
    expect(desktop).toContain("if-no-files-found: error");
  });

  it("Android parity lets the ledger classify expected blocked rows", async () => {
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const android = requiredJob(native, "android-emulator-parity");
    const emulator = android.slice(
      android.indexOf("- name: Run checksum-locked APKs on the emulator"),
      android.indexOf("- name: Verify captured parity ledger"),
    );

    // The tolerance stays; the line break that used to carry it does not. This assertion asked
    // for `run-conformance.mjs \<newline> --target android` — it pinned the very shape that made
    // the action drop every argument after the first line. See "hands the emulator action a
    // one-line script": the whole invocation has to reach the emulator shell as one command.
    expect(emulator).toMatch(/run-conformance\.mjs --target android\b/u);
    expect(emulator).not.toMatch(/\\\s*\n/u);
    expect(emulator).toContain("status=$?");
    expect(emulator).toContain('test "$status" -eq 0 -o "$status" -eq 2');
    expect(android).toContain("check-lane-blocks.mjs");
  });

  it("every template's non-visual scenarios run on main pushes and nightly", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const job = requiredJob(ci, "template-nonvisual");
    // Runs on every event since 2026-09-01 (owner call): the PR skip reported nothing on the
    // branch where the regression was written, and the merge that shipped it reported too late.
    // Only the job-level gate (4-space key) counts: since 2026-11-01 (owner) single steps such as
    // the starter's scenarios run nightly only, which leaves the job itself on every event.
    expect(job).not.toMatch(/^ {4}if:.*github\.event_name/mu);
    // An `if:` gate naming the event, not any mention of it: the TN_RUNNER routing expression
    // (PRD-480) reads `github.event.pull_request.head.repo.fork` in every routed job and gates
    // nothing on it. What this forbids is a gate that skips pull requests.
    expect(job).not.toMatch(/^\s+if:.*pull_request/mu);
    expect(job).toContain(
      "TN_PLAYTEST_ALLOW_SOFTWARE: ${{ (matrix.template == 'rain' && !github.event.pull_request.head.repo.fork &&",
    );
    expect(job).toContain("non-visual-scenarios.mjs");
    expect(job).toContain("threenative-playtest");
    expect(matrixTemplates(job)).toEqual([...expectedTemplates].sort());

    const templateRoot = path.join(repo, "packages/create-threenative/templates");
    const actualTemplates = [...expectedTemplates].sort();
    expect(actualTemplates.length, "no template was discovered").toBeGreaterThanOrEqual(8);
    for (const template of actualTemplates) {
      const result = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/non-visual-scenarios.mjs"), path.join(templateRoot, template)],
        { encoding: "utf8" },
      );
      expect(result.status, `${template}: ${result.stderr}`).toBe(0);
      expect(result.stdout.trim(), `${template}: classifier returned no scenarios`).not.toBe("");
    }
  });

  // PRD-626 P3.2: the generated static gate is reached before any scenario or parity capture, and
  // replaces the typecheck-only step instead of running the compiler a second time.
  it("runs the generated check once, before the scenarios and the engine parity capture", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const lane = requiredJob(ci, "template-nonvisual");
    const at = (needle: string): number => {
      const index = lane.indexOf(needle);
      expect(index, `${needle} is missing from template-nonvisual`).toBeGreaterThan(-1);
      return index;
    };
    const check = at("- name: Check pristine template");
    expect(check).toBeLessThan(at("- name: Run the template's GPU-free scenarios"));
    expect(check).toBeLessThan(at("- name: Compare the two engines on one pose"));
    expect(lane.match(/run check$/gmu)?.length).toBe(1);
    expect(lane).not.toMatch(/run typecheck$/mu);
  });

  // The obsolete shard arithmetic snapshots are replaced by complete kit/scenario coverage.
  // ci-template-selection.spec.ts checks PR selections and exhaustive queue matrices.
  it("runs the complete classifier output once, without repeated scaffold shards", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const lane = requiredJob(ci, "template-nonvisual");
    expect(lane).toContain("matrix: ${{ fromJSON(needs.scope.outputs.plan).templateMatrix }}");
    expect(lane).toContain('for scenario in "${scenarios[@]}"');
    expect(lane).toContain('test "${#scenarios[@]}" -gt 0');
    expect(lane).not.toContain("SHARD");
    // Both pools own capacity; the workflow must not hold selected kits back.
    expect(lane).not.toMatch(/^\s+max-parallel:/mu);
    expect(lane).toContain("fail-fast: false");
    expect(lane).toContain(
      `runs-on: ${gpuHeavyMatrix("ci:template-nonvisual:{0}", "matrix.template")}`,
    );
  });

  it("preserves platformer's unique production artifact in its installed scenario job", async () => {
    const lane = requiredJob(
      await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8"),
      "template-nonvisual",
    );
    expect(lane).toContain("name: Verify the platformer production artifact");
    expect(lane).toContain(
      "!contains(fromJSON(needs.scope.outputs.plan).goldenMatrix.template, 'platformer')",
    );
    expect(lane).toContain('pnpm --dir "$target" exec threenative build --target web');
    expect(lane).toContain('test -s "$target/dist/index.html"');
  });

  // `pnpm/action-setup` bootstraps pnpm by running `npm ci` against registry.npmjs.org and then
  // self-updating to the pinned version. Every job in this repository does that — 56 times per
  // run — so a slow registry is a slow run for a reason that has nothing to do with the change
  // under test. On 2026-09-03 it stopped being theoretical: the step's own log reads
  // `added 1 package in 7m`, single steps reached 430s, and across the four runs after 23:00Z the
  // bootstrap was 26% of all CI work and 57% of it in run 33819039003. The local action fetches
  // the self-contained pnpm binary from the same GitHub release host the runner already pulls
  // actions and Node from, and checks it against a recorded digest, so npm is not in the path of
  // any job and an unexpected binary fails the job rather than running.
  it("bootstraps pnpm from a pinned release digest rather than through npm", async () => {
    const primary = workflow("ci.yml");
    expect(Object.keys(primary.on), "ci.yml does not run on pull requests").toEqual(
      expect.arrayContaining(["pull_request"]),
    );
    for (const [relative, model] of [
      ["ci.yml", primary],
      ["native-platforms.yml", workflow("native-platforms.yml")],
    ] as const) {
      for (const job of model.jobs) {
        expect(
          job.stepsUsing("pnpm/action-setup"),
          `${relative} job ${job.id} still bootstraps pnpm through npm`,
        ).toEqual([]);
        const setup = job.steps.findIndex(
          (step) => step.uses?.startsWith("actions/setup-node") === true,
        );
        if (setup < 0) continue;
        const local = job.steps.findIndex((step) => step.uses === "./.github/actions/pnpm");
        expect(local, `${relative} job ${job.id} does not install pnpm locally`).toBeGreaterThan(
          -1,
        );
        // `cache: pnpm` shells out to `pnpm store path`, so pnpm has to be on PATH already.
        expect(
          local,
          `${relative} job ${job.id} installs pnpm after setup-node reads its store`,
        ).toBeLessThan(setup);
      }
    }

    const action = await readFile(path.join(repo, ".github/actions/pnpm/action.yml"), "utf8");
    const digests = await readFile(path.join(repo, ".github/actions/pnpm/checksums.txt"), "utf8");
    // Fail closed twice over: an asset with no recorded digest, and a digest that does not match.
    // The digest is computed here and compared as a string, not handed to `sha256sum --check`:
    // the macOS image ships a `sha256sum` that is not coreutils and has no `--check`, so on run
    // 33831657853 that checker printed a usage line and reported a mismatch on a binary whose
    // bytes were correct. Every tool the action probes must survive an edit, and both failure
    // paths must still name what went wrong and stop the job.
    expectIncludes(action, [
      "no recorded digest",
      "digest_of",
      "shasum --algorithm 256",
      "sha256sum",
      "openssl dgst -sha256",
      "could not compute a sha-256 digest",
      "not the recorded",
      "packageManager",
    ]);

    const recorded = new Map(
      digests
        .split("\n")
        .map((line) => line.trim().split(/\s+/u))
        .filter((parts) => parts.length === 2)
        .map(([digest, asset]) => [asset ?? "", digest ?? ""]),
    );
    const assets = [...action.matchAll(/asset=(pnpm-[a-z0-9-]+(?:\.exe)?)/gu)].map((m) => m[1]);
    expect(assets.length, "the action selects no release asset").toBeGreaterThanOrEqual(3);
    for (const asset of assets) {
      expect(recorded.has(asset ?? ""), `${asset} has no recorded digest`).toBe(true);
      expect((recorded.get(asset ?? "") ?? "").length, `${asset} digest is not a sha256`).toBe(64);
    }

    // One pinned version: the digests are only meaningful for the release they were taken from.
    const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      packageManager?: string;
    };
    const version = (manifest.packageManager ?? "").replace(/^pnpm@/u, "");
    expect(version, "the workspace pins no pnpm version").toMatch(/^\d+\.\d+\.\d+$/u);
    expect(digests, `checksums.txt does not name pnpm ${version}`).toContain(version);
  });

  it("PR CI reviews dependencies and scans changed commits for leaked secrets", () => {
    const supplyChain = workflow("ci.yml").job("supply-chain");
    // Markdown-only PRs skip the scan entirely (owner call 2026-09-12): the nightly develop run
    // and promotions still scan the full git history, so an inert prose PR spends no runner here.
    // PRD-481 added the reused tree to the exempt set and the `ci` selection to the admitted one,
    // so the condition names every selection it admits instead of the one it refuses.
    expect(supplyChain.needs).toEqual(["scope"]);
    expect(ciTerms(supplyChain.if ?? "")).toEqual(
      ["full", "template", "review", "instructions", "ci", "native-engine"].map(
        (selection) => `needs.scope.outputs.selection == '${selection}'`,
      ),
    );
    expect(supplyChain.steps[0]?.with["fetch-depth"]).toBe(0);
    // ...but the dependency diff itself stays pull_request-only: it needs a base ref and a head
    // ref, which a push does not supply, and ungating it made every push-to-main run red.
    const review = supplyChain.stepsUsing("actions/dependency-review-action@v4");
    expect(review).toHaveLength(1);
    expect(review[0]?.if, "dependency-review must stay pull_request-only").toBe(
      "github.event_name == 'pull_request'",
    );
    expect(review[0]?.with["fail-on-severity"]).toBe("moderate");
    expect(review[0]?.with).not.toHaveProperty("allow-licenses");
    expect(supplyChain.step(/^Scan the full git history for leaked secrets/u).if).toBe(
      "github.event_name != 'pull_request'",
    );
    const range = supplyChain.step(/^Verify the PR commit range is present/u);
    expect(range.env).toMatchObject({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    });
    expect(range.run).toMatch(/git rev-list --count "\$range"/u);
    const scan = supplyChain.step("Scan PR commits for leaked secrets");
    expectIncludes(scan.run ?? "", [
      "ghcr.io/gitleaks/gitleaks@sha256:",
      "git --redact --verbose",
      '--log-opts="$TN_GITLEAKS_RANGE"',
    ]);
  });

  it("the primary workflow owns the nightly run and invokes the native lane", () => {
    expect(workflow("ci.yml").on.schedule).toEqual([{ cron: "17 3 * * *" }]);
    const native = workflow("native-platforms.yml");
    expect(Object.keys(native.on)).toContain("workflow_call");
    expect(Object.keys(native.on)).not.toEqual(expect.arrayContaining(["pull_request"]));
    expect(
      Object.keys(native.on).filter((event) =>
        ["pull_request", "schedule", "push"].includes(event),
      ),
    ).toEqual([]);
  });

  it("both emulator lanes share the KVM provisioning commands", async () => {
    const parity = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const release = await readFile(path.join(repo, ".github/workflows/native-release.yml"), "utf8");
    const parityCommands = kvmProvisioning(parity);
    const releaseCommands = kvmProvisioning(release);
    expect(parityCommands).toHaveLength(4);
    expect(releaseCommands).toHaveLength(4);
    expect(parityCommands).toEqual(releaseCommands);
  });

  it("native cache keys hash their inputs and activate ccache", () => {
    const ci = workflow("ci.yml");
    const native = workflow("native-platforms.yml");
    const jobs = [
      ["ci test-native", ci.job("test-native")],
      ["native desktop parity", native.job("desktop-parity")],
      ["native desktop matrix", native.job("desktop")],
      ["native starter linux", native.job("starter-linux")],
    ] as const;
    for (const [name, job] of jobs) {
      expectIncludes(
        JSON.stringify(job.steps),
        [
          "packages/runtime-native/third_party",
          "packages/runtime-native/scripts/download-deps.mjs",
          "packages/runtime-native/CMakeLists.txt",
        ],
        name,
      );
      // CMake reads the launcher from the environment under these two names only. It does not
      // read CMAKE_PROJECT_INCLUDE_BEFORE from the environment, so writing a .cmake file and
      // exporting that name compiled without ccache while looking activated.
      expect(job.env, name).toMatchObject({
        CMAKE_C_COMPILER_LAUNCHER: "ccache",
        CMAKE_CXX_COMPILER_LAUNCHER: "ccache",
      });
      expect(job.runs(/echo "CMAKE_PROJECT_INCLUDE_BEFORE=/u), name).toBe(false);
      const caches = cacheSteps(job);
      const keys = caches.map((step) => String(step.with.key));
      expect(keys.length, `${name} has no explicit cache keys`).toBeGreaterThanOrEqual(2);
      for (const key of keys) expect(key, name).toMatch(/hashFiles\(/u);

      // A compiler cache that ccache writes to one directory and actions/cache saves from
      // another is not a compiler cache: the save finds nothing, no entry is ever stored, and
      // every run recompiles from scratch while the workflow reads as if it were cached. That
      // shipped, and `gh cache list` had no native-ccache entry at all after five runs. These
      // three assertions are the difference between the steps existing and the cache working.
      const ccacheDir = job.env.CCACHE_DIR;
      expect(ccacheDir, `${name} does not set CCACHE_DIR`).toBeDefined();
      expect(
        caches.flatMap((step) =>
          String(step.with.path)
            .split("\n")
            .map((entry) => entry.trim()),
        ),
        `${name} caches ${ccacheDir}`,
      ).toEqual(expect.arrayContaining([ccacheDir]));

      // GitHub cache keys are immutable: a key that is only a content hash saves once and is
      // never updated again, so the cache stops growing the moment a source file changes. The
      // run id makes every run save, and restore-keys makes every run restore the newest.
      const ccacheKey = keys.find((key) => key.includes("native-ccache"));
      expect(ccacheKey, `${name} has no native-ccache key`).toBeDefined();
      expect(ccacheKey, `${name} never re-saves its compiler cache`).toMatch(/github\.run_id/u);

      // A cache nobody measures is a cache nobody notices going cold.
      expect(job.runs("ccache --show-stats"), `${name} never reports its ccache hit rate`).toBe(
        true,
      );
    }
  });

  // Three Linux jobs — ci `test`, native `desktop-parity` and native `starter-linux` — each
  // compiled a different set of targets and all three saved under `native-ccache-Linux-X64-gcc-`.
  // The key carries `github.run_id`, so every save is a new entry, and `restore-keys` takes the
  // newest match: each lane therefore restored whichever sibling had finished last and recompiled
  // its own objects against it. Measured on run 33690597861, ci `test` reported
  // `Hits: 184 / 574 (32.06%)` on a tree whose native sources had not changed, and the stored
  // entry sat at 23 MiB run after run instead of growing to hold all three lanes. A restore-key
  // prefix is a namespace; sharing one between jobs that build different things is a cache that
  // reports as warm and behaves as cold.
  it("gives every native compiler cache a restore namespace no other job writes to", () => {
    const ci = workflow("ci.yml");
    const native = workflow("native-platforms.yml");
    const jobs = [
      ["ci test-native", ci.job("test-native")],
      ["native desktop parity", native.job("desktop-parity")],
      ["native desktop matrix", native.job("desktop")],
      ["native starter linux", native.job("starter-linux")],
    ] as const;

    const namespaces = new Map<string, string>();
    for (const [name, job] of jobs) {
      // By name, not by position: these jobs restore more than one cache, and `test-native` also
      // restores the compiled build tree. Picking the first `restore-keys` in the block asserted
      // against whichever cache happened to be declared first.
      const ccache = cacheSteps(job).find((step) =>
        String(step.with.key).includes("native-ccache"),
      );
      const restoreKey = String(ccache?.with["restore-keys"] ?? "")
        .trim()
        .replace(/^["']|["']$/gu, "");
      expect(restoreKey, `${name} has no ccache restore-keys prefix`).not.toBe("");
      const previous = namespaces.get(restoreKey);
      expect(
        previous,
        `${name} shares the ccache restore namespace ${restoreKey} with ${previous}`,
      ).toBeUndefined();
      namespaces.set(restoreKey, name);

      // The save key must start with the prefix it restores by, or the lane saves into a
      // namespace it never reads back and the restore silently falls through to a sibling's.
      expect(
        String(ccache?.with.key).startsWith(restoreKey),
        `${name} saves outside the namespace it restores from`,
      ).toBe(true);
    }
  });

  // `golden-path-template` used to scaffold starter and platformer and run their non-visual
  // scenarios itself, then run `verify:golden-path`, which packs and scaffolds the same template
  // all over again. Since 2026-09-01 `template-nonvisual` runs that identical sweep for all eight
  // templates on every event, so the copy inside the golden-path lane proved nothing new and cost
  // 350s of the run's critical path (run 33690597861, step "Run the scaffold's GPU-free
  // assertions"). The verifier is what this lane is for; the sweep belongs to the job that owns it.
  it("leaves the non-visual scenario sweep to template-nonvisual", () => {
    const ci = workflow("ci.yml");
    const goldenPath = ci.job("golden-path-template");
    const nonVisual = ci.job("template-nonvisual");

    expectIncludes(nonVisual.scripts, ["non-visual-scenarios.mjs", "threenative-playtest"]);
    // Both templates the golden-path matrix drives must be covered by the sweep that replaces it.
    expect(matrixTemplates(nonVisual.text)).toEqual(
      expect.arrayContaining(["starter", "platformer"]),
    );

    // Commands, not prose: a parsed run body has no comments, so an explanation cannot pass for a step.
    expectExcludes(
      goldenPath.scripts,
      ["non-visual-scenarios.mjs", "threenative-playtest"],
      "golden-path-template drives the sweep template-nonvisual already owns:",
    );
    expect(goldenPath.runs("pnpm verify:golden-path")).toBe(true);
  });

  // Every matrix leg ran `workspace-packages.ts build` and then `pnpm pack` per package: ten legs
  // paying ~70s each to produce byte-identical tarballs from the same commit. `build` already
  // compiles the workspace, so it packs once and the legs download the result.
  it("packs the workspace tarballs once and shares them with every matrix leg", () => {
    const ci = workflow("ci.yml");
    const build = ci.job("build-artifacts");
    const uploads = build.stepsUsing("actions/upload-artifact");
    expect(uploads, "build does not publish the packed tarballs").not.toHaveLength(0);
    expect(build.stepsUsing("./.github/actions/workspace-dist")).not.toHaveLength(0);
    expect(build.runs("pnpm tsx scripts/workspace-packages.ts --archives")).toBe(false);

    for (const name of ["golden-path-template", "template-nonvisual"]) {
      const job = ci.job(name);
      expect(
        job.stepsUsing("actions/download-artifact"),
        `${name} does not consume the shared tarballs`,
      ).not.toHaveLength(0);
      expect(
        job.runs(/pnpm --filter "\$package_name" pack/u),
        `${name} still packs the workspace itself`,
      ).toBe(false);
      // Nothing may re-derive the specs file locally; the artifact is the single source.
      expect(
        job.runs("pnpm tsx scripts/workspace-packages.ts build"),
        `${name} re-runs the workspace build`,
      ).toBe(false);
    }

    // The first attempt shipped only `packages/create-threenative/dist` and every scaffold died:
    // the CLI's `dist/index.js` imports `@threenative/assets`, pnpm resolves that through a
    // workspace symlink into `packages/assets/dist/index.js`, and the leg no longer builds the
    // workspace. What the legs need is the whole compiled workspace, so the artifact carries it
    // and this asserts the glob rather than any one package's name.
    const upload = uploads.find((step) => step.with.name === "workspace-packages");
    expect(upload, "the shared artifact is not named workspace-packages").toBeDefined();
    const paths = String(upload?.with.path)
      .split("\n")
      .map((line) => line.trim());
    expect(paths, "the shared artifact does not carry the compiled workspace").toEqual(
      expect.arrayContaining(["packages/*/dist", "artifacts/workspace-packages"]),
    );
    // An empty upload must fail the job rather than hand every downstream leg a silent nothing.
    expect(upload?.with["if-no-files-found"]).toBe("error");
  });

  // `test` used to compile the C++ host for 279s before running a single JS test, because one
  // package's suite drives real contract executables. Splitting that off is only safe if the two
  // halves still cover every package between them — a `--filter` that names a package neither job
  // runs is a gate that goes green by running less, which is the failure this repository fails
  // closed against everywhere else. So this computes the partition rather than trusting it.
  it("splits the suite in two without dropping a package on the floor", async () => {
    const ci = workflow("ci.yml");
    const js = ci.job("test");
    const native = ci.job("test-native");

    // The JS half must not compile anything, or the split bought nothing.
    expect(js.runs("native:build"), "the JS half still builds the native host").toBe(false);
    expect(js.env.CCACHE_DIR, "the JS half still carries the compiler cache").toBeUndefined();
    expect(js.steps.some((step) => /^pnpm test(?::ci)?$/u.test(step.run ?? ""))).toBe(true);

    // The native half must build what its suite executes, and run only that suite.
    expect(native.runs("native:build")).toBe(true);
    expect(native.env.CCACHE_DIR).toBeDefined();
    // The contract tests import the compiled workspace. `pnpm test` used to build it for them;
    // this job does not run `pnpm test`, so it has to build it itself or the suite dies on
    // ERR_MODULE_NOT_FOUND for `@threenative/playtest` before it executes a binary.
    expect(
      native.stepsUsing("./.github/actions/workspace-dist"),
      "the native half never builds the workspace its tests import",
    ).not.toHaveLength(0);
    expect(
      native.steps.some((step) => step.run === "pnpm test"),
      "the native half re-runs the whole suite",
    ).toBe(false);

    const excluded = (js.env.TN_SUITE_EXCLUDE_PACKAGES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    expect(excluded.length, "the JS half excludes nothing, so the split is a duplicate").toBe(1);

    const filtered = [...native.scripts.matchAll(/pnpm --filter (\S+) test/gu)].map(
      (match) => match[1],
    );
    expect(
      filtered.sort(),
      "the packages the JS half skips are not the ones the native half runs",
    ).toEqual([...excluded].sort());

    // And the excluded name has to be a package that exists and has a suite to run, or the
    // filter is a typo that quietly excludes nothing and the native job runs nothing.
    for (const name of excluded) {
      const directory = name.replace(/^@threenative\//u, "");
      const manifest = JSON.parse(
        await readFile(path.join(repo, "packages", directory, "package.json"), "utf8"),
      ) as { name?: string; scripts?: Record<string, string> };
      expect(manifest.name, `${name} is not the package at packages/${directory}`).toBe(name);
      expect(manifest.scripts?.test, `${name} has no test script to run`).toBeDefined();
    }
  });

  // One hit rate for three builds cannot say which build produced the hits, and ci `test-native`
  // has been stuck at `Hits: 184 / 574 (32.06%)` on every run measured — unchanged by giving each
  // lane its own restore namespace, and with the restore demonstrably landing. Either the restored
  // cache is worthless and the hits are this run recompiling shared sources into a second build
  // directory, or 390 objects really do hash differently run over run. A counter read between the
  // builds is what tells those apart, so it is a measurement the job has to keep.
  it("reads the compiler cache counters between builds, not only at the end", () => {
    const native = workflow("ci.yml").job("test-native");

    const readings = native.steps.flatMap(
      (step) => /^Compiler cache after (.+)$/u.exec(step.name ?? "")?.[1]?.trim() ?? [],
    );
    expect(readings, "the native job reports one total for three builds").toEqual([
      "the host build",
      "the V8 contract executables",
      "the QuickJS variant",
    ]);
    // And the size of what the restore actually put on disk, because a hit rate cannot
    // distinguish a cold cache from one restored into the wrong directory.
    expect(native.runs('du -sh "$CCACHE_DIR"')).toBe(true);
  });

  it("builds V8 native contracts through the configured aggregate target", () => {
    const native = workflow("ci.yml").job("test-native");
    const v8Contracts = native.step("Build the V8 contract executables").run?.trim() ?? "";

    expect(v8Contracts).toBe(
      [
        "set -euo pipefail",
        'cmake --build build/tn-linux --target threenative-native-tests --parallel "$(nproc)"',
      ].join("\n"),
    );
    expectExcludes(
      native.scripts,
      ["add_executable", "target_args", "combined contract build failed"],
      "test-native must not rediscover or swallow targets:",
    );
    expect(
      v8Contracts,
      "test-native must not turn a failed contract build into echo output",
    ).not.toMatch(/\|\|\s*\\?\s*\n?\s*echo/u);

    const quickJs =
      native.step("Build the QuickJS engine variant the cross-engine contracts need").run ?? "";
    expectIncludes(quickJs, [
      "node scripts/download-deps.mjs --only quickjs",
      "cmake -S . -B build/tn-linux-quickjs -DMYSTRAL_USE_QUICKJS=ON -DMYSTRAL_USE_V8=OFF",
      "cmake --build build/tn-linux-quickjs --target threenative-timestamp-query-test",
      '--target threenative-rg11b10-renderable-test --target mystral --parallel "$(nproc)"',
    ]);
  });

  it("wires the native contract aggregate to CMake's configured registration set", async () => {
    const cmake = await readFile(path.join(repo, "packages/runtime-native/CMakeLists.txt"), "utf8");
    const registerFunction = cmakeFunction(cmake, "tn_register_contract_test");
    expect(registerFunction).toContain(
      "set_property(GLOBAL APPEND PROPERTY TN_NATIVE_CONTRACT_TARGETS ${target})",
    );

    const registrations = [...cmake.matchAll(/^\s*tn_register_contract_test\(/gmu)];
    expect(registrations.length, "CMake registers no native contract targets").toBeGreaterThan(0);
    const lastRegistration = registrations.at(-1)?.index;
    expect(lastRegistration).toBeDefined();

    const propertyRead = cmake.indexOf(
      "get_property(TN_NATIVE_CONTRACT_TARGETS GLOBAL PROPERTY TN_NATIVE_CONTRACT_TARGETS)",
    );
    const aggregate = cmake.indexOf(
      "add_custom_target(threenative-native-tests DEPENDS ${TN_NATIVE_CONTRACT_TARGETS})",
    );
    expect(
      propertyRead,
      "CMake never reads the configured native contract target list",
    ).toBeGreaterThan(lastRegistration ?? -1);
    expect(aggregate, "CMake never defines the aggregate native contract target").toBeGreaterThan(
      propertyRead,
    );
  });

  // ccache has never paid off on this lane: 195 of 272 cacheable compiles miss on every run, and
  // the other half of the invocations sit behind SDL3's precompiled header where ccache cannot
  // reach them at all. Caching the compiled tree instead is safe because ninja re-stats every
  // input — a stale entry costs a recompile, never a wrong binary — but only while the cache is
  // exact-key: a partial restore can serve a tree built from different code because cached object
  // mtimes are newer than the commit timestamps restored for changed sources.
  it("keys the cached native build tree on the sources it was built from", async () => {
    const native = workflow("ci.yml").job("test-native");

    const caches = cacheSteps(native);
    const buildKey = caches
      .map((step) => String(step.with.key))
      .find((key) => key.includes("native-build-"));
    expect(buildKey, "the native build tree is not cached").toBeDefined();
    expectIncludes(
      buildKey ?? "",
      [
        "packages/runtime-native/CMakeLists.txt",
        "packages/runtime-native/src/**",
        "packages/runtime-native/include/**",
        "packages/runtime-native/native/**/src/**",
        "packages/runtime-native/native/**/Cargo.toml",
        "packages/runtime-native/native/**/Cargo.lock",
      ],
      "the build-tree key ignores",
    );
    // Deliberately NOT run-scoped, unlike the compiler cache. A ccache directory grows with
    // every run and wants a fresh entry; a build tree is a pure function of its sources, so a
    // run-scoped key stores the same 1.1 GiB repeatedly. On 2026-09-03 four entries carried the
    // identical source hash, `native-build-Linux` held 5.57 GiB of the repository's 10 GiB
    // budget, and the cache evicted itself and its neighbours — total runner work went up.
    expect(
      buildKey,
      "a run-scoped build-tree key stores the same tree once per run and evicts the budget",
    ).not.toMatch(/github\.run_id/u);
    expect(
      caches.map((step) => String(step.with["restore-keys"] ?? "")),
      "the build tree must not restore a stale sibling",
    ).not.toContainEqual(expect.stringMatching(/^native-build-/u));
    // Both configured build directories, or the QuickJS variant recompiles from nothing. The Rust
    // crates too: once the C++ compile was cached away, they were the whole remaining ~112s of the
    // host build step. The path is the one the build actually writes, not the one cargo would
    // default to: `build-native-physics.mjs` passes `--target-dir` because it cross-compiles to
    // five targets.
    const treePaths = caches.flatMap((step) =>
      String(step.with.path)
        .split("\n")
        .map((entry) => entry.trim()),
    );
    expect(treePaths).toEqual(
      expect.arrayContaining([
        "packages/runtime-native/build/tn-linux",
        "packages/runtime-native/build/tn-linux-quickjs",
        "packages/runtime-native/.runtime/physics-target",
        "packages/runtime-native/native/ui-overlay/target",
      ]),
    );
    const physicsScript = await readFile(
      path.join(repo, "packages/runtime-native/scripts/build-native-physics.mjs"),
      "utf8",
    );
    expect(physicsScript, "the physics build no longer writes where the cache looks").toContain(
      "'.runtime', 'physics-target'",
    );
    // A cached build tree is only usable if its inputs are older than it. `actions/checkout`
    // stamps everything with the time it ran, so without this the restore is dead weight and
    // ninja rebuilds the tree it just downloaded. And it needs history to do it. A shallow clone
    // dates every file to HEAD, which is newer than the cached tree, so the cache is worse than
    // useless — run 33751865452 restamped 299 of 299 files and rebuilt 78 objects behind a cache
    // it had just restored.
    expect(
      native.steps[0]?.with["fetch-depth"],
      "the mtime restore runs against a shallow clone",
    ).toBe(0);
    const script = await readFile(
      path.join(repo, "packages/runtime-native/scripts/restore-source-mtimes.mjs"),
      "utf8",
    );
    expect(script, "a shallow clone is silently mis-stamped rather than refused").toContain(
      "TN_MTIME_SHALLOW_CLONE",
    );
    const dated = native.steps.findIndex((step) =>
      /restore-source-mtimes\.mjs/u.test(step.run ?? ""),
    );
    const built = native.steps.findIndex((step) => /native:build/u.test(step.run ?? ""));
    expect(
      dated,
      "the restored tree is older than its own freshly checked-out inputs",
    ).toBeGreaterThan(-1);
    expect(dated, "sources are dated after the build has already run").toBeLessThan(built);
  });

  // Within one run the workspace dist compiled about nine times, at 71-95s each. Every consumer
  // declared `needs: scope` only, so all eight started beside the one job that saves the key, all
  // eight looked for an entry nobody had published yet, and all eight compiled it themselves. The
  // action grows a mode that takes this run's upload instead; a job that keeps the cache path next
  // to a producer it is ordered behind is the arrangement that put the nine builds back.
  it("compiles the workspace dist once and hands the upload to every consumer", async () => {
    const ci = workflow("ci.yml");
    const producer = ci.job("build-artifacts");
    expect(producer.stepsUsing("./.github/actions/workspace-dist")).not.toHaveLength(0);
    const published = producer
      .stepsUsing("actions/upload-artifact")
      .find((step) => step.with.name === "workspace-packages");
    expect(published, "the producer no longer publishes what consumers download").toBeDefined();
    expect(
      String(published?.with.path)
        .split("\n")
        .map((line) => line.trim()),
    ).toContain("packages/*/dist");

    for (const job of ci.jobs) {
      if (job.id === "build-artifacts") continue;
      // The action is what compiles; this job is about which of them compile it themselves.
      const dist = job.stepsUsing("./.github/actions/workspace-dist");
      if (dist.length === 0) continue;
      // `lint` keeps the cache path on purpose: its dist lane runs on the `instructions` selection,
      // where `build-artifacts` is skipped and there is no upload to take. Everything that runs on
      // `full` downloads instead.
      if (job.id === "lint") continue;
      expect(job.needs, `${job.id} restores a key nobody saved before it`).toEqual([
        "scope",
        "build-artifacts",
      ]);
      expect(
        dist.map((step) => step.with["shared-artifact"]),
        `${job.id} compiles the workspace instead of downloading it`,
      ).toContain("workspace-packages");
    }

    const action = await readFile(
      path.join(repo, ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    // Fail closed on the download exactly as on the restore: a partial upload must not be imported
    // from, and the producer's step order — build, validate, publish — is what keeps it complete.
    expectIncludes(action, [
      "Take the compiled workspace from this run's producer",
      "uses: actions/download-artifact@v4",
      "TN_WORKSPACE_DIST_INCOMPLETE",
    ]);
    for (const step of [
      "Restore the compiled workspace",
      "Build missing workspace bundles",
      "Pack current workspace files",
    ]) {
      const entry = action
        .split(/(?=^ {4}- name:)/mu)
        .find((block) => block.startsWith(`    - name: ${step}\n`));
      expect(entry, `the shared download does not gate ${step}`).toContain(
        "inputs.shared-artifact == ''",
      );
    }
  });

  // Six jobs need `packages/*/dist` and each compiled it from scratch — measured at 49-65s per
  // job, six times a run. tsup keeps no incremental state, so the output is what gets cached, and
  // one shared action owns the key so the six cannot drift apart into six different answers about
  // what a bundle is built from.
  it("builds the workspace through one shared action, never inline", async () => {
    const ci = workflow("ci.yml");
    expect(
      ci.jobs.some((job) => job.runs("pnpm tsx scripts/workspace-packages.ts build")),
      "a job builds the workspace inline instead of through the shared action",
    ).toBe(false);
    expect(
      ci.jobs.flatMap((job) => job.stepsUsing("./.github/actions/workspace-dist")).length,
    ).toBeGreaterThanOrEqual(5);

    const action = await readFile(
      path.join(repo, ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    // The key has to name what the bundles are made of. Miss one and a stale bundle is served to
    // every consumer, which is the only failure this cache can have. And a restore that came back
    // partial must fail rather than be imported from — bundles and tarballs both, since three
    // lanes take the archives rather than the bundles.
    expectIncludes(
      action,
      [
        "packages/*/src/**",
        "packages/*/package.json",
        "packages/*/tsup.config.ts",
        "packages/*/scripts/**",
        "scripts/workspace-packages.ts",
        "pnpm-lock.yaml",
        "TN_WORKSPACE_DIST_INCOMPLETE",
        "TN_WORKSPACE_ARCHIVES_INCOMPLETE",
        "artifacts/workspace-packages",
      ],
      "the workspace-dist action lost",
    );

    // `playwright.config.ts` scaffolds from packed tarballs and rebuilds every package to get
    // them unless it is handed a set. Measured at 245s of setup against 40s of testing.
    expect(
      ci.job("test-browser").mentions("THREENATIVE_PACKED_PACKAGES"),
      "the browser lane repacks the workspace before it can test",
    ).toBe(true);
    const config = await readFile(path.join(repo, "playwright.config.ts"), "utf8");
    expect(config, "the seam the workflow relies on is gone").toContain(
      "process.env.THREENATIVE_PACKED_PACKAGES",
    );
  });

  // `check-capability-docs` resolves every documented capability through its package export map,
  // and those maps point at dist. The budgets job installed and ran the gate without compiling
  // anything, so the gate failed on the build it needed rather than on a capability:
  //   CAPABILITY_BUILT_IMPORT_MISSING: @threenative/assets#compileAssets could not resolve from
  //   the package export map: @threenative/assets. targets missing built file
  //   .../packages/assets/dist/index.js
  // `needs: build` orders the job behind the build but hands it no artifact, so the ordering
  // reads like a guarantee it does not make. The job has to get what it resolves, and it takes it
  // from the shared action like every other consumer rather than compiling its own seventh copy.
  it("hands the budgets gate the dist it resolves through export maps", () => {
    const budgets = workflow("ci.yml").job("budgets");

    const dist = budgets.steps.findIndex(
      (step) => step.uses === "./.github/actions/workspace-dist",
    );
    expect(
      dist,
      "the budgets job runs a gate that resolves dist without having it",
    ).toBeGreaterThan(-1);
    // And it has to arrive before the gate reads it, not after.
    const gate = budgets.steps.findIndex((step) => step.run === "pnpm budgets");
    expect(gate).toBeGreaterThan(-1);
    expect(dist, "the budgets job builds after the gate that needs the build").toBeLessThan(gate);
  });

  it("keeps developer tests self-contained and gives CI an explicit prebuilt path", async () => {
    const ci = workflow("ci.yml");
    const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const test = ci.job("test");
    const native = ci.job("test-native");
    const browser = ci.job("test-browser");
    const playtest = ci.job("test-playtest");
    const dist = (job: ICiWorkflowJob) =>
      job.steps.findIndex((step) => step.uses === "./.github/actions/workspace-dist");
    const runAt = (job: ICiWorkflowJob, command: string) =>
      job.steps.findIndex((step) => step.run?.includes(command) === true);
    const nativeDist = dist(native);
    const nativeSmokeBuild = runAt(native, "pnpm --filter threenative-native-smoke build");
    const nativeTests = runAt(native, "pnpm --filter @threenative/runtime-native test");

    expect(manifest.scripts.test).toBe("bash scripts/run-test-suite.sh");
    expect(manifest.scripts["test:ci"]).toMatch(/TN_SUITE_PREBUILT=1/u);
    expect(manifest.scripts["test:browser"]).toMatch(/@threenative\/playtest build/u);
    expect(manifest.scripts["test:browser:ci"]).not.toMatch(/@threenative\/playtest build/u);
    expect(manifest.scripts["test:playtest"]).toMatch(/@threenative\/playtest build/u);
    expect(manifest.scripts["test:playtest:ci"]).not.toMatch(/@threenative\/playtest build/u);

    const suite = test.steps.find((step) => step.run === "pnpm test:ci");
    expect(suite).toBeDefined();
    expect(test.env.TN_SUITE_PHASES).toBe("docs,build,package-test");
    expect(nativeDist).toBeGreaterThanOrEqual(0);
    expect(nativeSmokeBuild, "the native suite has no built smoke bundle").toBeGreaterThan(
      nativeDist,
    );
    expect(nativeTests, "the smoke bundle is built after the native suite starts").toBeGreaterThan(
      nativeSmokeBuild,
    );
    expect(dist(browser)).toBeGreaterThanOrEqual(0);
    expect(dist(playtest)).toBeGreaterThanOrEqual(0);
    expect(runAt(browser, "pnpm test:browser:ci")).toBeGreaterThan(dist(browser));
    expect(runAt(playtest, "pnpm test:playtest:ci")).toBeGreaterThan(dist(playtest));
    expect(browser.mentions("THREENATIVE_PACKED_PACKAGES")).toBe(true);

    const prebuilt = test.steps.slice(test.steps.indexOf(suite as ICiStep));
    expect(prebuilt.some((step) => /@threenative\/playtest build/u.test(step.run ?? ""))).toBe(
      false,
    );
  });

  it("reuses iOS archive outputs only after simulator verification and an identity check", () => {
    const ios = workflow("native-platforms.yml").job("ios-simulator");
    const at = (needle: string | RegExp) =>
      ios.steps.findIndex((step) =>
        typeof needle === "string"
          ? step.name?.includes(needle) === true
          : needle.test(step.run ?? ""),
      );
    const initialBuild = at("Build iOS proof workspace dependencies");
    const verifier = at(/verify-ios-simulator\.mjs/u);
    const pack = ios.step("Pack the exact consumer packages");

    expect(initialBuild).toBeGreaterThanOrEqual(0);
    expect(verifier).toBeGreaterThan(initialBuild);
    expect(pack.index).toBeGreaterThan(verifier);
    expect(ios.runs("find packages -type f \\( -path '*/dist/*'")).toBe(false);
    expectIncludes(
      ios.scripts,
      [
        "scripts/ios-package-output-snapshot.ts",
        "cmp -s",
        "TN_IOS_PACKAGE_OUTPUTS_CHANGED",
        "TN_IOS_PACKAGE_OUTPUTS_MISSING",
        "package.json').main",
      ],
      "the iOS reuse check lost",
    );
    expectIncludes(pack.run ?? "", [
      "workspace-packages.ts --archives",
      'pnpm --filter "$package_name" pack --pack-destination',
    ]);
    expectExcludes(pack.run ?? "", ["--if-present run build"]);
  });

  it("produces one commit-keyed web reference and makes Android and desktop consume it", () => {
    const native = workflow("native-platforms.yml");
    const producer = native.job("web-reference");
    const android = native.job("android-emulator-parity");
    const desktop = native.job("desktop-parity");
    const labelGate = "contains(github.event.pull_request.labels.*.name, 'native')";
    // The model has no comments, so a comment that merely quotes the label gate cannot satisfy or
    // trip an assertion about the condition.
    const webCapture = "--target web --out artifacts/conformance/web";

    // Pinned as one exact condition, not a direction. The invariant is that the producer is never
    // gated more tightly than its most permissive consumer, or that consumer runs on a pull request
    // with no reference to compare against — but asserting only that leaves room for the producer
    // to acquire some *other* narrowing condition (a branch test, an actor test) unnoticed. Since
    // 2026-09-06 `android-emulator-parity` carries no label gate, so this is the whole condition
    // the producer may carry.
    expect(producer.runs(webCapture)).toBe(true);
    expect(
      ciTerms(producer.if ?? ""),
      "web reference is an orphan on unlabelled pull requests",
    ).toEqual(["needs.scope.outputs.selection == 'full'", "inputs.ios_only == false"]);
    expect(
      android.if ?? "",
      "the Android leg regained a gate the producer does not carry",
    ).not.toContain(labelGate);
    expect(producer.if ?? "", "producer is gated more tightly than its consumer").not.toContain(
      labelGate,
    );
    const upload = producer.stepsUsing("actions/upload-artifact")[0];
    expect(upload?.with.name).toBe("native-web-reference-${{ needs.scope.outputs.candidate_sha }}");
    expect(upload?.with["if-no-files-found"]).toBe("error");
    expect(producer.runs("check-lane-blocks.mjs")).toBe(true);

    for (const [name, consumer] of [
      ["android", android],
      ["desktop", desktop],
    ] as const) {
      // Both consumers share the caller-owned full scope and explicit dispatch conditions.
      expect(
        ciTerms(consumer.if ?? "").slice(0, 2),
        `${name} eligibility drifted from the web producer`,
      ).toEqual(["needs.scope.outputs.selection == 'full'", "inputs.ios_only != true"]);
      expect(consumer.if ?? "", `${name} overrides the caller's full selection`).not.toContain(
        labelGate,
      );
      // The property is that the consumer waits on `scope` and the web-reference producer, not
      // that those are its *only* dependencies. PRD-221 adds `android-v8-source` to the Android
      // leg, which is a second producer it legitimately waits on; a literal match on the whole
      // list rejected that correct workflow.
      expect(consumer.needs, `${name} is not ordered behind its producers`).toEqual(
        expect.arrayContaining(["scope", "web-reference"]),
      );
      expect(
        consumer.stepsUsing("actions/download-artifact").map((step) => step.with.name),
        `${name} can download another commit's reference`,
      ).toContain("native-web-reference-${{ needs.scope.outputs.candidate_sha }}");
      expect(
        consumer.runs("check-lane-blocks.mjs"),
        `${name} does not validate its downloaded reference`,
      ).toBe(true);
      expect(consumer.runs(webCapture), `${name} captures a private web fallback`).toBe(false);
    }

    expect(
      native.jobs.filter((job) => job.runs(webCapture)).map((job) => job.id),
      "exactly the producer captures the web reference",
    ).toEqual(["web-reference"]);
  });

  it("uses the cache-aware pnpm and Chromium actions in the Android lane", async () => {
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const android = requiredJob(native, "android-emulator-parity");
    expect(android).toContain("uses: ./.github/actions/pnpm");
    expect(android, "android still installs pnpm through the registry").not.toContain(
      "pnpm/action-setup",
    );
    expect(android).toContain("uses: ./.github/actions/playwright-chromium");
    expect(android).not.toContain("playwright install --with-deps chromium");
  });

  // Splitting the suite across jobs is how coverage disappears quietly: a phase named in no job,
  // or a shard slice nobody runs, both report green. So the split is computed rather than trusted.
  it("runs every suite phase in exactly one job, and every unit shard", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const suite = requiredJob(ci, "test");
    const unit = requiredJob(ci, "test-unit");

    const phasesOf = (section: string): readonly string[] =>
      (section.match(/TN_SUITE_PHASES:\s*"?([a-z,-]+)"?/u)?.[1] ?? "")
        .split(",")
        .map((phase) => phase.trim())
        .filter((phase) => phase !== "");

    const declared = [...phasesOf(suite), ...phasesOf(unit)].sort();
    // The four the script knows. A phase in neither job runs nowhere; a phase in both runs twice.
    expect(declared, "the jobs do not partition the suite's phases").toEqual([
      "build",
      "docs",
      "package-test",
      "unit",
    ]);

    expect(unit).toContain("matrix: ${{ fromJSON(needs.scope.outputs.plan).unitMatrix }}");
    const plan = JSON.parse(
      spawnSync(
        process.execPath,
        [path.join(repo, "scripts/ci-change-scope.mjs"), "--full", "--format", "json"],
        { cwd: repo, encoding: "utf8" },
      ).stdout,
    );
    expect(plan.unitMatrix.shard).toEqual(["1/4", "2/4", "3/4", "4/4"]);

    // And the script must refuse a selection that would run nothing rather than report on it.
    const runner = await readFile(path.join(repo, "scripts/run-test-suite.sh"), "utf8");
    expect(runner).toContain("TN_SUITE_NO_PHASES");
    expect(runner).toContain("TN_SUITE_UNIT_SHARD");
    // Unset is the whole gate, which is what `pnpm test` on a developer machine has to stay.
    expect(runner).toContain('"${TN_SUITE_PHASES:-docs,build,package-test,unit}"');
  });

  // Every job that scaffolds a generated project installs *its* dependencies, not the
  // workspace's. Keyed on the workspace lockfile alone, the store cache does not hold them: on run
  // 33753945433 every template leg reported `resolved 492, reused 192, downloaded 170`, ten legs
  // each fetching the same third of the tree from the network.
  it("keys the package store on the templates for every job that scaffolds one", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    for (const name of [
      "golden-path-template",
      "template-nonvisual",
      "test-browser",
      "test-playtest",
    ]) {
      const job = requiredJob(ci, name);
      // Only jobs that actually scaffold need this; the assertion is that these ones do.
      expect(job, `${name} does not scaffold a project`).toMatch(
        /scaffold-from-tarballs|THREENATIVE_PACKED_PACKAGES|verify:golden-path|test:playtest/u,
      );
      expect(job, `${name} keys its store on the workspace lockfile alone`).toContain(
        "cache-dependency-path",
      );
      expect(job).toContain("packages/create-threenative/templates/*/package.json");
      // The workspace lockfile stays in the key — these jobs install the workspace too.
      expect(job).toMatch(/cache-dependency-path: \|\n\s+pnpm-lock\.yaml/u);
    }
  });

  it("runs every selected native leg without independent label exemptions", async () => {
    // PRD-373 moves safe exemptions to the caller. Full includes desktop parity; a label must
    // not silently turn a promotion's full qualification into partial native evidence.
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const ungated = [
      "desktop-parity",
      "android-emulator-parity",
      "desktop",
      "ios-simulator",
      "starter-linux",
    ] as const;

    for (const name of ungated) {
      const job = requiredJob(native, name);
      expect(job, name).not.toContain("github.event_name != 'pull_request'");
      expect(job, name).not.toContain("contains(github.event.pull_request.labels");
    }

    // The reusable workflow is invoked by ci.yml for every non-prose board selection.
    const triggers = triggerSection(native);
    expect(triggers).toContain("workflow_call:");
    // The release candidate reads its reports from the main CI run, so nothing starts this alone.
    expect(triggers).not.toMatch(/\n\s{2}(?:pull_request|schedule|push):/u);

    const android = requiredJob(native, "android-emulator-parity");
    expect(android).not.toContain("continue-on-error: true");
    // It reports its own red rather than swallowing it, and — since 2026-09-02 — without taking
    // the sibling legs down with it: see "no job cancels its own run".
    expect(android).toContain("Verify captured parity ledger");

    // iOS is not a supported target (owner decision, 2026-09-23), so its simulator lane runs and
    // reports but cannot fail the reusable workflow — otherwise a red iOS leg holds the
    // develop->main `ci-required` verdict. `native-release.yml` still gates the iOS rows for a
    // release, so this only leaves the merge verdict.
    const ios = requiredJob(native, "ios-simulator");
    expect(ios).toContain("continue-on-error: true");
  });

  it("job-level env never reads the runner context", async () => {
    // `jobs.<id>.env` cannot see the `runner` context. GitHub does not warn: it refuses the whole
    // workflow with "This run likely failed because of a workflow file issue" and starts zero
    // jobs, so a red here looks like an outage rather than a typo. Step-level env is indented
    // deeper and is allowed to use it.
    for (const workflow of workflows) {
      const source = await readFile(path.join(repo, workflow), "utf8");
      const offenders = source
        .split("\n")
        .filter((line) => /^ {6}[A-Za-z_][A-Za-z0-9_]*: .*\$\{\{\s*runner\./u.test(line));
      expect(offenders, workflow).toEqual([]);
    }
  });

  it("golden-path retains the default end-to-end journey through the verifier", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const goldenPath = requiredJob(ci, "golden-path-template");
    expect(goldenPath).toContain("matrix: ${{ fromJSON(needs.scope.outputs.plan).goldenMatrix }}");
    expect(goldenPath).toContain("TN_GOLDEN_PATH_TEMPLATES: ${{ matrix.template }}");
    expect(goldenPath).toContain("pnpm verify:golden-path");
  });

  // `build` packs the workspace once and publishes it; the golden-path job downloads that set.
  // Without pointing the verifier at it, `verify:golden-path` packs the whole workspace a second
  // time inside the job that sets the run's critical path — the workspace `tsc` plus ten
  // `pnpm pack` runs, on top of a `build` that just did exactly that.
  it("hands the golden-path verifier the tarballs build already packed", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const job = requiredJob(ci, "golden-path-template");

    const archives = job.match(/TN_GOLDEN_PATH_ARCHIVES:\s*(.+)/u)?.[1]?.trim();
    expect(archives, "the verifier packs its own workspace instead of adopting build's").toBe(
      "${{ github.workspace }}/artifacts/workspace-packages",
    );
    // It must name the directory the download actually restores, or the verifier fails closed on
    // an unreadable path and the saving becomes a red run.
    expect(job).toContain("actions/download-artifact");
    const scaffold = requiredJob(ci, "template-nonvisual");
    expect(scaffold).toContain("${{ github.workspace }}/artifacts/workspace-packages");

    // And the script has to honour it. Unset is the developer path and must still pack.
    const verifier = await readFile(path.join(repo, "scripts/verify-golden-path.ts"), "utf8");
    expect(verifier).toContain("TN_GOLDEN_PATH_ARCHIVES");
    expect(verifier).toContain("adoptPackedWorkspace");
    expect(verifier, "adoption does not fail closed on an incomplete set").toContain(
      "TN_GOLDEN_PATH_ARCHIVE_MISSING",
    );
    expect(verifier, "adoption does not fail closed on an unclaimed tarball").toContain(
      "TN_GOLDEN_PATH_ARCHIVE_UNKNOWN",
    );
  });

  // The golden path drives one scenario because `template-nonvisual` drives them all. That is only
  // true while template-nonvisual actually covers the templates this matrix names — the moment it
  // stops, capping this layer stops being delegation and starts being a hole.
  it("only caps its own scenario sweep while template-nonvisual covers the same templates", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const goldenPath = requiredJob(ci, "golden-path-template");
    const nonVisual = requiredJob(ci, "template-nonvisual");

    const cap = goldenPath.match(/TN_GOLDEN_PATH_SCENARIOS:\s*"(\d+)"/u)?.[1];
    if (cap === undefined) return; // uncapped is always honest; nothing to check.

    expect(Number(cap)).toBeGreaterThan(0);
    // The lane it delegates to has to run the same classifier and runner, on every event.
    expect(nonVisual).toContain("non-visual-scenarios.mjs");
    expect(nonVisual).toContain("threenative-playtest");
    expect(nonVisual).not.toMatch(/^ {4}if:.*github\.event_name/mu);
    // And it has to cover every template this matrix drives.
    const driven = matrixTemplates(goldenPath);
    expect(driven.length).toBeGreaterThan(0);
    const covered = matrixTemplates(nonVisual);
    for (const template of driven) {
      expect(covered, `template-nonvisual does not cover ${template}`).toContain(template);
    }
  });

  it("runs selected golden-path evidence again instead of caching test verdicts", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const job = requiredJob(ci, "golden-path-template");
    expect(job).not.toContain(".golden-path-proof");
    expect(job).not.toContain("steps.proof.outputs");
    expect(job).not.toContain("Save the proof for this tree");
    expect(job).toContain("uses: ./.github/actions/playwright-chromium");
    expect(job).toContain("scaffold-from-tarballs");
    expect(job).toContain("needs.scope.outputs.selection == 'full'");
    expect(job).toContain("run: pnpm verify:golden-path");
  });

  it("the engine-cost row runs in its own required leg per kit, not inside the kit's 30 minutes", async () => {
    // Its 1260 drawn ticks took 14m51s on hosted SwiftShader (run 41170629638), so inside
    // template-nonvisual it cancelled adventure and collectathon at 30 minutes.
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(requiredJob(ci, "template-nonvisual")).not.toContain("kit-contract-row.ts");
    const job = requiredJob(ci, "template-engine-cost");
    expect(job).toContain("matrix: ${{ fromJSON(needs.scope.outputs.plan).templateMatrix }}");
    expect(job).toContain('scripts/kit-contract-row.ts engine-cost "${{ matrix.template }}"');
    expect(job).toContain("--scenario playtests/contract-engine-cost.playtest.json");
    expect(job).toContain("--browser-recipe webgpu --headed");
    // 45 for this job only (owner, 2026-10-31: hosted SwiftShader ran the row 964-1775+ s); the
    // kit legs keep their own caps.
    expect(job).toContain("timeout-minutes: 45");
    expect(requiredJob(ci, "template-nonvisual")).toContain(
      "timeout-minutes: ${{ matrix.template == 'shooter' && 60 || matrix.template == 'rain' && 60 || 30 }}",
    );
    expect(requiredJob(ci, "ci-required")).toMatch(/needs: \[[^\]]*\btemplate-engine-cost\b/u);
    // The row writer imports create-threenative, which needs the built `packages/*/dist` that only
    // the workspace-packages artifact carries (run 41260320405: every leg failed at the row step).
    const download = job.indexOf("name: workspace-packages");
    expect(download).toBeGreaterThan(-1);
    expect(download).toBeLessThan(job.indexOf("scripts/kit-contract-row.ts"));
  });

  it("a stalled apt mirror fails the Chromium dependency install and retries it", async () => {
    // Run 41249368283: `playwright install-deps` trickled from archive.ubuntu.com for 29 minutes and
    // the tower-defense and animation jobs hit their 30-minute limit. A hang is not a failure, so
    // retry-download.sh never retried it. Root runs the timeout, so it can kill apt's fetchers.
    const action = await readFile(
      path.join(repo, ".github/actions/playwright-chromium/action.yml"),
      "utf8",
    );
    expect(action).toContain(
      'sh scripts/retry-download.sh sudo timeout --kill-after=15 240 env "PATH=$PATH" node_modules/.bin/playwright install-deps chromium',
    );
    expect(action).not.toContain("pnpm exec playwright install-deps");
    expect(action).not.toContain("--with-deps");
  });

  it("the review unit leg prepares what `vitest related` may select (PRD-731)", async () => {
    // #560's first review run: `vitest related` picked the browser e2e specs for a playtest change
    // and every one died on a missing Chromium, because the install step ran for `full` only.
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const job = requiredJob(ci, "test-unit");
    const prepare =
      "if: needs.scope.outputs.selection == 'full' || needs.scope.outputs.selection == 'review'";
    expect(job).toContain(`uses: ./.github/actions/playwright-chromium\n        ${prepare}`);
    expect(job).toContain(`${prepare}\n        run: pnpm --filter strata-terrain-preview bake`);
  });

  it("the golden-path required context is still reported by a job of that exact name", async () => {
    // `golden-path` is a required check in the `main protection` ruleset, and required checks are
    // matched by exact context string. A matrix job reports `golden-path (starter)` and
    // `golden-path (platformer)`, never `golden-path`, so making this lane a matrix silently left
    // the ruleset waiting on a context nothing would ever report. This job is that context.
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const aggregate = requiredJob(ci, "golden-path");
    expect(aggregate).toContain("needs: [scope, golden-path-template]");
    expect(aggregate).not.toContain("strategy:");
    // Without this, a failed matrix leaves the job skipped, and a skipped required check counts as
    // satisfied — the ruleset would pass on exactly the runs it exists to stop. `always()` is the
    // wrong spelling: it also fires when the run was cancelled, where the matrix result is
    // `cancelled` and this job then reported failure on a run nobody had broken.
    expect(aggregate).toContain(
      "if: ${{ !cancelled() && (needs.scope.outputs.selection == 'full' || needs.scope.outputs.selection == 'template' || needs.scope.outputs.selection == 'review') }}",
    );
    expect(aggregate).toContain(
      'echo "golden-path templates: not applicable (explicit selective exemption)"',
    );
    expect(aggregate).toContain("needs.scope.outputs.selection");
    expect(aggregate).not.toMatch(/if: always\(\)/u);
    expect(aggregate).toContain("needs.golden-path-template.result");
    expect(aggregate).toMatch(/test "\$result" = "success"/u);
  });

  it("the scaffold block exists exactly once in the shared action", async () => {
    const action = await readFile(
      path.join(repo, ".github/actions/scaffold-from-tarballs/action.yml"),
      "utf8",
    );
    expect(occurrences(action, /case "\$package_name" in/gu)).toBe(1);
    expect(action).toContain("unsupported workspace package");
    let callers = 0;
    for (const relative of [
      ".github/workflows/ci.yml",
      ".github/workflows/native-platforms.yml",
      ".github/workflows/native-release.yml",
    ]) {
      const source = await readFile(path.join(repo, relative), "utf8");
      expect(source, relative).not.toContain('case "$package_name" in');
      expect(source, relative).not.toContain("unsupported workspace package");
      callers += occurrences(source, /uses: \.\/\.github\/actions\/scaffold-from-tarballs/gu);
    }
    expect(callers).toBe(11);
  });

  it("selects QuickJS for the packaged fallback without changing native features", async () => {
    const integration = await readFile(
      path.join(repo, ".github/workflows/integration.yml"),
      "utf8",
    );
    const job = requiredJob(integration, "packaged-quickjs");
    const name = "Build the QuickJS host required by the packaged fallback";
    const step = job.slice(job.indexOf(`      - name: ${name}`)).split("\n      - ")[0];
    if (step === undefined) throw new Error(`workflow step ${name} was not found.`);
    const script = step.includes("        run: |")
      ? workflowRunScript(job, name)
      : step.match(/ {8}run: (.+)/u)?.[1];
    expect(script).toBeTruthy();
    const directory = await makeTempDir("packaged-quickjs-selection-");
    const runtime = path.join(directory, "packages/runtime-native");
    await mkdir(runtime, { recursive: true });
    await writeFile(
      path.join(runtime, "CMakeLists.txt"),
      `
cmake_minimum_required(VERSION 3.20)
project(fallback_selection NONE)
foreach(flag MYSTRAL_USE_V8 MYSTRAL_USE_QUICKJS MYSTRAL_USE_WGPU MYSTRAL_USE_DAWN TN_ENABLE_CANVAS2D TN_ENABLE_NATIVE_PHYSICS TN_ENABLE_UI_OVERLAY)
  option(\${flag} "fixture feature" OFF)
endforeach()
if(MYSTRAL_USE_V8)
  set(engine v8)
else()
  set(engine quickjs)
endif()
file(WRITE "\${CMAKE_BINARY_DIR}/mystral" "#!/bin/sh\nprintf 'Native WebGPU JS runtime - wgpu-native + \${engine} build\\n'\n")
file(CHMOD "\${CMAKE_BINARY_DIR}/mystral" PERMISSIONS OWNER_READ OWNER_WRITE OWNER_EXECUTE)
add_custom_target(mystral)
`,
    );
    const result = spawnSync(
      "bash",
      [
        "-e",
        "-u",
        "-o",
        "pipefail",
        "-c",
        `
pnpm() {
  cmake -S packages/runtime-native -B packages/runtime-native/build/tn-linux \\
    -DMYSTRAL_USE_V8=ON -DMYSTRAL_USE_QUICKJS=OFF -DMYSTRAL_USE_WGPU=ON -DMYSTRAL_USE_DAWN=OFF \\
    -DTN_ENABLE_CANVAS2D=ON -DTN_ENABLE_NATIVE_PHYSICS=ON -DTN_ENABLE_UI_OVERLAY=ON
}
node() { test "$*" = "packages/runtime-native/scripts/download-deps.mjs --only quickjs"; }
${script}
`,
      ],
      { cwd: directory, encoding: "utf8", timeout: 30_000 },
    );
    expect(result.status, result.stderr).toBe(0);
    const cache = await readFile(path.join(runtime, "build/tn-linux/CMakeCache.txt"), "utf8");
    expect(cache).toMatch(/^MYSTRAL_USE_V8:BOOL=OFF$/mu);
    expect(cache).toMatch(/^MYSTRAL_USE_QUICKJS:BOOL=ON$/mu);
    for (const feature of [
      "MYSTRAL_USE_WGPU",
      "TN_ENABLE_CANVAS2D",
      "TN_ENABLE_NATIVE_PHYSICS",
      "TN_ENABLE_UI_OVERLAY",
    ])
      expect(cache).toMatch(new RegExp(`^${feature}:BOOL=ON$`, "mu"));
    expect(cache).toMatch(/^MYSTRAL_USE_DAWN:BOOL=OFF$/mu);
    const { resolveRuntimeAssetCapabilities } = await import(
      "../../packages/create-threenative/src/build.js"
    );
    expect(
      resolveRuntimeAssetCapabilities("desktop", path.join(runtime, "build/tn-linux/mystral")),
    ).toMatchObject({
      engine: "quickjs",
      webAssembly: false,
      decoders: { ktx2: false, meshopt: false, draco: false },
    });
    expect(job).toContain(
      "THREENATIVE_RUNTIME_BINARY: ${{ github.workspace }}/packages/runtime-native/build/tn-linux/mystral",
    );
  });

  it("keeps the native contracts and primary CI documentation honest", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const test = requiredJob(ci, "test-native");
    expect(test).toContain(
      'cmake --build build/tn-linux --target threenative-native-tests --parallel "$(nproc)"',
    );
    expect(test).toContain("Build the QuickJS engine variant the cross-engine contracts need");
    expect(test).toContain("-DMYSTRAL_USE_QUICKJS=ON -DMYSTRAL_USE_V8=OFF");
    for (const job of ["lint", "build", "budgets"]) requiredJob(ci, job);

    const agents = await readFile(path.join(repo, "AGENTS.md"), "utf8");
    const claude = await readFile(path.join(repo, "CLAUDE.md"), "utf8");
    for (const name of ["supply-chain", "template-nonvisual", "desktop-parity", "golden-path"]) {
      expect(agents).toContain(name);
      expect(claude).toContain(name);
    }
    expect(
      claude.startsWith("<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->"),
    ).toBe(true);
  });

  it("builds the framework example before a fail-closed bundle boundary check", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const build = jobSections(ci).find(([job]) => job === "build-artifacts")?.[1];
    if (build === undefined) throw new Error("CI build-artifacts job was not found.");

    const exampleBuild = build.indexOf("pnpm --filter abyss-framework build");
    const boundaryCheck = build.indexOf("name: Enforce entity registry boundaries");
    expect(exampleBuild).toBeGreaterThanOrEqual(0);
    expect(boundaryCheck).toBeGreaterThan(exampleBuild);

    const bundleScan = build.slice(boundaryCheck);
    expect(bundleScan).toContain("run: pnpm exec tsx scripts/check-core-boundary.ts");
  });

  it("keeps the repository-wide DebugOverlay CSS guard", async () => {
    const guard = await readFile(
      path.join(repo, "scripts/__tests__/debug-overlay-css.spec.ts"),
      "utf8",
    );
    expect(guard).toContain(
      'const PROJECT_ROOTS = ["examples", "packages/create-threenative/templates"];',
    );
    expect(guard).toContain("mountsOverlay");
    expect(guard).toContain("stylesOverlay");
    expect(guard).toContain("expect(unstyled).toEqual([])");
  });

  it("asks the Android parity emulator for KVM, and reports what it got", async () => {
    // `-accel auto` finds no writable /dev/kvm and falls back to software emulation without
    // saying so. That lane logged a 474-second boot and then lost a run that had already passed
    // 74/0 to `adb ETIMEDOUT`.
    //
    // The rule is installed, the mode is reported, and neither is asserted: ending the step on
    // `test -w /dev/kvm` — the shape native-release.yml carries, where nothing has exercised it —
    // failed the job outright on a runner without KVM, which is worse than the boot it fixes.
    const parity = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    expect(parity).toContain('KERNEL=="kvm", GROUP="kvm", MODE="0666", OPTIONS+="static_node=kvm"');
    expect(parity).toContain("TN_EMULATOR_ACCEL:kvm");
    expect(parity).toContain("TN_EMULATOR_ACCEL:software");

    // Before the emulator starts, or it accelerates nothing.
    expect(parity.indexOf("99-kvm4all.rules")).toBeLessThan(
      parity.indexOf("reactivecircus/android-emulator-runner"),
    );

    // And the step must not end on a bare assertion that kills the lane.
    const step = parity.slice(
      parity.indexOf("Enable KVM for the emulator"),
      parity.indexOf("reactivecircus/android-emulator-runner"),
    );
    expect(step, "the KVM step must report its mode, not assert it").not.toMatch(
      /\n\s+test -w \/dev\/kvm\s*\n/u,
    );
  });

  it("aggregates performance evidence fail-closed across empty, stale, failed, and advisory rows", () => {
    const expectedSha = "a".repeat(40);
    const pass = {
      artifactHash: "artifact-browser",
      lane: "browser-webgpu",
      required: true,
      sourceSha: expectedSha,
      status: "PASS" as const,
    };
    expect(summarizePerformanceCi({ expectedSha, results: [pass] })).toMatchObject({
      exitCode: 0,
      status: "PASS",
    });
    expect(summarizePerformanceCi({ expectedSha, results: [] })).toMatchObject({
      exitCode: 2,
      status: "BLOCKED",
    });
    expect(
      summarizePerformanceCi({
        expectedSha,
        results: [{ ...pass, sourceSha: "b".repeat(40) }],
      }),
    ).toMatchObject({ exitCode: 2, status: "BLOCKED" });
    expect(
      summarizePerformanceCi({
        expectedSha,
        results: [{ ...pass, status: "FAIL" }],
      }),
    ).toMatchObject({ exitCode: 1, status: "FAIL" });
    const advisory = summarizePerformanceCi({
      expectedSha,
      requiredLanes: ["browser-webgpu"],
      results: [
        { lane: "native-ios", reason: "physical device unavailable", status: "UNVERIFIED" },
      ],
    });
    expect(advisory.status).toBe("BLOCKED");
    expect(renderPerformanceCiSummary(advisory)).toContain("UNVERIFIED=1");
  });

  it("treats Windows and macOS as independently keyed platform executions", () => {
    const expectedSha = "a".repeat(40);
    const windows = {
      ...{
        artifactHash: "artifact-windows",
        lane: "native-windows",
        sourceSha: expectedSha,
        status: "PASS" as const,
      },
      resultKey: "native-windows",
    };
    const macos = {
      ...windows,
      artifactHash: "artifact-macos",
      lane: "native-macos",
      resultKey: "native-macos",
    };
    expect(
      summarizePerformanceCi({
        expectedSha,
        requiredLanes: ["native-windows", "native-macos"],
        results: [windows, macos],
      }),
    ).toMatchObject({ exitCode: 0, status: "PASS" });
    expect(
      summarizePerformanceCi({
        expectedSha,
        requiredLanes: ["native-windows", "native-macos"],
        results: [windows],
      }),
    ).toMatchObject({ exitCode: 2, status: "BLOCKED" });
  });

  it("requires the performance workflow structure to retain collectors, failure evidence, and promotion separation", () => {
    const native = workflow("native-platforms.yml");
    const performance = workflow("performance-regression.yml");
    const contracts = workflow("ci.yml").job("performance-contracts");
    expectIncludes(contracts.scripts, ["profile-production.mjs", "ci-summary.ts"]);
    const uploads = contracts.stepsUsing("actions/upload-artifact");
    expect(contracts.steps.map((step) => step.if)).toContain("always()");
    expect(uploads.map((upload) => upload.with["retention-days"])).toEqual(
      expect.arrayContaining([14, 30]),
    );
    for (const source of [native, performance]) {
      expect(source.jobs.some((job) => job.runs("production-evidence.mjs"))).toBe(true);
      expect(source.jobs.some((job) => job.stepsUsing("actions/upload-artifact").length > 0)).toBe(
        true,
      );
      expect(source.jobs.some((job) => job.steps.some((step) => step.if === "always()"))).toBe(
        true,
      );
    }
    expect(Object.keys(performance.on)).toEqual(
      expect.arrayContaining(["workflow_dispatch", "schedule"]),
    );
    expect(Object.keys(performance.on)).not.toContain("pull_request_target");
    const pairs = performance.job("hardware-pairs");
    expect(pairs.strategy?.["max-parallel"]).toBe(2);
    expect(pairs.runsOn).toMatch(/matrix\.physical == true/u);
    expect(pairs.runsOn).toMatch(/inputs\.trusted == true/u);
    expect(pairs.runsOn).toMatch(/TN_PERF_PHYSICAL_PROVISIONED/u);
    expect(pairs.runs("--trusted")).toBe(true);
    expect(performance.jobs.map((job) => job.id)).toEqual(
      expect.arrayContaining([
        "required-check-promotion",
        "weekly-workload-rotation",
        "release-soak",
      ]),
    );
    // Baseline regeneration is a separately reviewed change, and the promotion job says so.
    expect(performance.job("required-check-promotion").runs("baseline-regeneration")).toBe(true);
    expect(performance.job("weekly-workload-rotation").runs("pnpm test:templates")).toBe(true);
    const soak = performance.job("release-soak");
    expectIncludes(soak.scripts, ["pnpm native:qualify:physical", "7200000"]);
  });

  // Two crons fire on a Sunday, so every sampled run after the first showed this job as `skipped`
  // and it looked like a schedule that never matched. The run that did reach the condition then died
  // in 20 s on ERR_MODULE_NOT_FOUND before it measured a template, which is why nothing re-measured
  // the templates for two months. Both halves are guarded here: the condition names the cron that
  // fires it and no other, and the job builds the workspace and the web engine before the rotation.
  it("aims the weekly template rotation at the cron that fires it, and builds before it measures", () => {
    const performance = workflow("performance-regression.yml");
    const schedule = performance.on.schedule as readonly { cron: string }[];
    const crons = schedule.map((entry) => entry.cron);
    expect(crons.length).toBeGreaterThan(1);
    // A `*` day-of-week fires daily; the weekly rotation is the one cron whose day-of-week is fixed.
    const weekly = crons.filter((cron) => cron.split(/\s+/u)[4] !== "*");
    expect(weekly).toHaveLength(1);
    const weeklyCron = weekly[0] ?? "";
    expect(weeklyCron).not.toBe("");
    const job = performance.job("weekly-workload-rotation");
    expect(ciTerms(job.if ?? "")).toEqual(
      expect.arrayContaining([
        "github.event_name == 'schedule'",
        `github.event.schedule == '${weeklyCron}'`,
      ]),
    );
    for (const cron of crons.filter((candidate) => candidate !== weeklyCron))
      expect(job.mentions(cron), `the rotation must not fire on ${cron}`).toBe(false);
    // The rotation imports `@threenative/assets` through the CLI's config and packs the local
    // framework, so the workspace bundles and the web engine are its prerequisites, not its output.
    const build = job.steps.findIndex((step) => step.uses === "./.github/actions/workspace-dist");
    const engine = job.steps.findIndex(
      (step) => step.uses === "./.github/actions/native-engine-wasm",
    );
    const rotation = job.steps.findIndex((step) => step.run === "pnpm test:templates");
    expect(build).toBeGreaterThan(-1);
    expect(engine).toBeGreaterThan(-1);
    expect(rotation).toBeGreaterThan(build);
    expect(rotation).toBeGreaterThan(engine);
    // A hosted runner has no GPU: the scaffold's own test refuses a software adapter without this.
    expect(job.env.TN_PLAYTEST_ALLOW_SOFTWARE).toBe("1");
  });

  it("reports a scheduled missing baseline before fetching or checking out source", async () => {
    const directory = await makeTempDir("performance-scheduled-baseline-");
    const manifestDirectory = path.join(directory, "scripts/performance-regression");
    const artifactDirectory = path.join(directory, "artifacts/performance-regression");
    const binDirectory = path.join(directory, "bin");
    await mkdir(manifestDirectory, { recursive: true });
    await mkdir(binDirectory, { recursive: true });
    await writeFile(
      path.join(manifestDirectory, "lanes.json"),
      await readFile(path.join(repo, "scripts/performance-regression/lanes.json"), "utf8"),
    );
    const gitLog = path.join(directory, "git.log");
    await writeFile(
      path.join(binDirectory, "git"),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$TEST_GIT_LOG"\n',
      { mode: 0o755 },
    );
    const envFile = path.join(directory, "github.env");
    const script = (
      workflow("performance-regression.yml")
        .job("hardware-pairs")
        .step("Prepare isolated source checkouts inside the repository worktree").run ?? ""
    ).replaceAll("${{ matrix.result_key }}", "browser-webgpu");
    const result = spawnSync("bash", ["-e", "-u", "-o", "pipefail", "-c", script], {
      cwd: directory,
      env: {
        ...process.env,
        BASELINE_INPUT: "",
        CANDIDATE_INPUT: "",
        GITHUB_ENV: envFile,
        GITHUB_EVENT_NAME: "schedule",
        GITHUB_SHA: "candidate-sha",
        GITHUB_WORKSPACE: directory,
        PATH: `${binDirectory}:${process.env.PATH ?? ""}`,
        TEST_GIT_LOG: gitLog,
        TN_PERF_LANE: "browser-webgpu",
        TN_PERF_RESOURCE_READY: "true",
        TN_PERF_RESULT_KEY: "browser-webgpu",
      },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(gitLog, "utf8").catch(() => "")).toBe("");
    expect(
      JSON.parse(await readFile(path.join(artifactDirectory, "browser-webgpu.json"), "utf8")),
    ).toMatchObject({
      candidateSourceSha: "candidate-sha",
      lane: "browser-webgpu",
      resultKey: "browser-webgpu",
      status: "UNVERIFIED",
    });
    expect(await readFile(envFile, "utf8")).toContain("TN_PERF_BASELINE_AVAILABLE=false");
  });

  it("maps every performance matrix row to its declared platform runner and unique result key", () => {
    const pairs = workflow("performance-regression.yml").job("hardware-pairs");
    const rows = (pairs.strategy?.matrix as { include: Record<string, unknown>[] }).include;
    const row = (lane: string) => rows.find((entry) => entry.lane === lane);
    expect(rows.some((entry) => entry.runner === "ubuntu-24.04")).toBe(true);
    expect(row("native-windows")).toMatchObject({
      result_key: "native-windows",
      runner: "windows-2025",
    });
    expect(row("native-macos")).toMatchObject({ result_key: "native-macos", runner: "macos-15" });
    expect(row("native-android")?.runner).toEqual(
      expect.arrayContaining(["self-hosted", "android"]),
    );
    expect(row("native-ios")?.runner).toEqual(
      expect.arrayContaining(["self-hosted", "macOS", "ios"]),
    );
    expect(pairs.require("runs-on")).toMatch(/matrix\.runner/u);
    expect(new Set(rows.map((entry) => entry.result_key)).size).toBe(rows.length);
  });

  it("uses a permitted cancellation source in the performance summary step", () => {
    const summary = workflow("performance-regression.yml").job("performance-summary");
    expect(summary.steps.flatMap((step) => step.env.TN_PERF_CANCELLED ?? [])).toEqual([
      "${{ needs.hardware-pairs.result == 'cancelled' }}",
    ]);
  });

  it("runs bounded native desktop and simulator collectors against built artifacts", () => {
    const native = workflow("native-platforms.yml");
    expect(workflow("ci.yml").job("test-native").runs("--hosted-software")).toBe(true);
    const desktop = findStep(
      native,
      "Collect bounded desktop performance evidence from the built runtime",
    );
    expectIncludes(desktop.run ?? "", [
      "--target desktop",
      '--prebuilt-artifact "$artifact"',
      "--duration 1",
      "--cold-starts 1",
      "--repetitions 1",
      "--hosted-software",
      "collector_status=FAIL",
      "build/tn-windows/mystral.exe",
      "build/tn-macos/mystral",
    ]);
    expectExcludes(desktop.run ?? "", ["--help"]);
    const simulator = findStep(
      native,
      "Collect bounded iOS simulator evidence without claiming a phone run",
    );
    expectIncludes(simulator.run ?? "", [
      "find packages/runtime-native/build/tn-ios-simulator -name threenative-ios.app",
      "--target ios",
      "--device ios-simulator",
      '--prebuilt-artifact "$app"',
      "--duration 1",
      "--hosted-software",
      'status":"UNVERIFIED"',
    ]);
    expectExcludes(simulator.run ?? "", ["--help"]);
  });

  it("proves desktop release signing with test credentials on both hosted hosts", () => {
    const desktop = workflow("native-platforms.yml").job("desktop");
    // Owner decision 2026-09-23: each developer signs their own game; the engine ships no
    // certificate. The lane proves the credential path with a runner-generated certificate on each
    // host, and reads the signature back independently of the adapter that wrote it. Without this
    // the macOS half signs ad-hoc and the credentialed path the decision names stays unwired.
    expect(desktop.steps.map((step) => step.name)).toEqual(
      expect.arrayContaining([
        "Create a self-signed code-signing certificate for the proof",
        "Create a self-signed code-signing certificate for the macOS proof",
      ]),
    );
    expectIncludes(desktop.scripts, [
      "THREENATIVE_DESKTOP_SIGN_SUBJECT=ThreeNative CI Signing Proof",
      'THREENATIVE_DESKTOP_CODESIGN_IDENTITY="$TN_SIGNING_PROOF_IDENTITY"',
      "Get-AuthenticodeSignature",
      "codesign --verify --strict --deep",
      "Authority=ThreeNative CI Signing Proof",
    ]);
  });

  it("plans real alternating pairs and rejects unsafe or incomparable hardware evidence", () => {
    expect(
      plannedPerformancePairs("native-android", "/repo/baseline", "/repo/candidate").map(
        ({ order }) => order,
      ),
    ).toEqual(["baseline-first", "candidate-first", "baseline-first"]);
    expect(
      plannedPerformancePairs("native-linux", "/repo/baseline", "/repo/candidate")[0]
        ?.baselineCommand,
    ).toContain("--profile regression");
    expect(() => validatePerformanceDispatch({ eventName: "pull_request", trusted: true })).toThrow(
      /only schedule and trusted manual dispatch/u,
    );
    expect(() =>
      validatePerformanceDispatch({ eventName: "workflow_dispatch", trusted: false }),
    ).toThrow(/trusted dispatch/u);
    expect(() =>
      validateArtifactIdentity({
        artifactHash: "apk-hash",
        expectedSourceSha: "a".repeat(40),
        lane: "native-android",
        nativeBinaryHash: "binary-hash",
        provenance: "android-emulator",
        sourceSha: "a".repeat(40),
      }),
    ).toThrow(/physical-hardware/u);
    expect(() =>
      validateThermalEvidence({
        lane: "native-android",
        metrics: { thermal: { complete: false, thermallyConfounded: true } },
      }),
    ).toThrow(/thermally confounded/u);
  });

  it("puts the selected physical device and evidence artifact on every collector command", () => {
    const plan = (
      plannedPerformancePairs as unknown as (
        lane: string,
        baselineWorktree: string,
        candidateWorktree: string,
        options: { device: string; physicalEvidence: string },
      ) => ReturnType<typeof plannedPerformancePairs>
    )("native-android", "/repo/baseline", "/repo/candidate", {
      device: "pixel-8",
      physicalEvidence: "/evidence/android.json",
    });
    for (const attempt of plan) {
      expect(attempt.baselineCommand).toContain(
        "--device pixel-8 --physical-evidence /evidence/android.json",
      );
      expect(attempt.candidateCommand).toContain(
        "--device pixel-8 --physical-evidence /evidence/android.json",
      );
    }
  });

  it("does not invoke a physical collector when its selected device or evidence is missing", async () => {
    const directory = await makeTempDir("threenative-performance-missing-input-");
    const raw = JSON.parse(
      await readFile(path.join(repo, "scripts/performance-regression/lanes.json"), "utf8"),
    ) as {
      promotionPolicy: Record<string, unknown>;
      lanes: Array<Record<string, unknown>>;
    };
    const acceptedIdentity = {
      architecture: "arm64",
      artifactHash: "accepted-artifact",
      browser: "none",
      device: "pixel-8",
      graphicsBackend: "vulkan",
      gpu: "accepted-gpu",
      instrumentationRevision: "productionEvidenceV1",
      jsRuntime: "v8",
      nativeBinaryHash: "accepted-binary",
      operatingSystem: "android",
      presentMode: "surfaceflinger",
      resolution: "1920x1080",
      sourceSha: "accepted-source",
      workloadHash: "workload-1",
    };
    const manifest = {
      ...raw,
      promotionPolicy: { ...raw.promotionPolicy, calibrationStatus: "accepted" },
      lanes: raw.lanes.map((lane) =>
        lane.id === "native-android"
          ? {
              ...lane,
              baseline: {
                evidence: "docs/verification/accepted.md",
                identity: acceptedIdentity,
                rungs: { "L2@4096": 8.27 },
                status: "accepted",
              },
              provisioning: "physical-hardware",
            }
          : lane,
      ),
    };
    const manifestPath = path.join(directory, "lanes.json");
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    const result = await runPerformanceLane({
      baselineSourceSha: "a".repeat(40),
      candidateSourceSha: "b".repeat(40),
      candidateWorktree: directory,
      eventName: "workflow_dispatch",
      lane: "native-android",
      leaseDirectory: path.join(directory, "leases"),
      manifestPath,
      outputPath: directory,
      trusted: true,
    });
    expect(["BLOCKED", "UNVERIFIED"]).toContain(result.status);
    expect(result.reason).toMatch(/device|physical-evidence/u);
  });

  it("preserves all five startup samples while keeping the p95 value", () => {
    const evidence = {
      artifact: { sha256: "a".repeat(64) },
      command: "profile",
      execution: { profile: "regression" },
      identity: {
        hostClass: "x86_64",
        deviceClass: "gpu-runner-1",
        graphicsBackend: "vulkan",
        gpuClass: "NVIDIA Turing",
        jsRuntime: "v8",
        presentMode: "fifo",
        renderWidth: 1920,
        renderHeight: 1080,
        workloadHash: "workload-sha256",
        nativeBinarySha256: "binary-hash",
        osClass: "linux",
      },
      metrics: {
        frameSampleCount: 1_000,
        p95FrameMs: 10,
        startupP95Ms: 125,
        startupSamplesMs: [100, 110, 120, 125, 125],
      },
      physical: {},
      runId: "run-1",
      source: { sha: "a".repeat(40) },
      target: "desktop",
      timestamps: { endedAt: "2026-09-05T00:00:01Z", startedAt: "2026-09-05T00:00:00Z" },
    };
    const converted = productionEvidenceToPerformanceRun(evidence, {
      id: "native-linux",
      platform: "native-linux",
      workload: "platformer-production",
    });
    expect(converted.metrics.startupP95Ms).toMatchObject({
      samples: [100, 110, 120, 125, 125],
      unit: "ms",
      value: 125,
    });
    for (const gpuClass of ["unknown-gpu", "fixture-control", "SwiftShader"]) {
      expect(() =>
        productionEvidenceToPerformanceRun(
          { ...evidence, identity: { ...evidence.identity, gpuClass } },
          { id: "native-linux", platform: "native-linux", workload: "platformer-production" },
        ),
      ).toThrow(/observed hardware/u);
    }
    const shortWindow = productionEvidenceToPerformanceRun(
      {
        ...evidence,
        metrics: { ...evidence.metrics, startupSamplesMs: [100, 110, 120, 125] },
        runId: "run-short-window",
      },
      { id: "native-linux", platform: "native-linux", workload: "platformer-production" },
    );
    expect(() => parsePerformanceRun(shortWindow, DEFAULT_PERFORMANCE_POLICY)).toThrow(
      /TN_PERF_SHORT_SAMPLE_WINDOW/u,
    );
  });

  it("keeps an unapproved advisory baseline UNVERIFIED instead of manufacturing a BLOCKED result", async () => {
    const result = await runPerformanceLane({
      baselineSourceSha: "a".repeat(40),
      candidateSourceSha: "b".repeat(40),
      dryRun: false,
      eventName: "workflow_dispatch",
      lane: "browser-webgpu",
      manifestPath: path.join(repo, "scripts/performance-regression/lanes.json"),
      trusted: true,
    });
    expect(result.status).toBe("UNVERIFIED");
    expect(result.exitCode).toBe(0);
  });

  it("serializes a hardware resource and releases the lease after failure", async () => {
    const directory = await makeTempDir("threenative-performance-lease-");
    const first = await acquirePerformanceLease(directory, "pixel-8", "first-owner");
    await expect(acquirePerformanceLease(directory, "pixel-8", "second-owner")).rejects.toThrow(
      /already leased/u,
    );
    await first.release();
    await expect(
      withPerformanceLease(directory, "pixel-8", "throwing-owner", async () => {
        throw new Error("measurement failed");
      }),
    ).rejects.toThrow("measurement failed");
    const afterFailure = await acquirePerformanceLease(directory, "pixel-8", "third-owner");
    await afterFailure.release();
  });

  it("encodes the unpromoted calibration and CI-cost sample requirements in the lane manifest", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(repo, "scripts/performance-regression/lanes.json"), "utf8"),
    ) as {
      promotionPolicy: {
        accuracyRuns: number;
        baselineRegeneration: string;
        calibrationPairs: number;
        ciCostRuns: number;
        minimumCalibrationSessions: number;
        requiredCheckPromotion: string;
      };
      lanes: { id: string; provisioning: string; required: boolean }[];
    };
    expect(manifest.promotionPolicy).toMatchObject({
      accuracyRuns: 20,
      baselineRegeneration: "separate-reviewed-change",
      calibrationPairs: 10,
      ciCostRuns: 20,
      minimumCalibrationSessions: 3,
      requiredCheckPromotion: "maintainer-review",
    });
    expect(manifest.lanes).toHaveLength(7);
    expect(manifest.lanes.every(({ required }) => required === false)).toBe(true);
    expect(
      manifest.lanes.filter(({ provisioning }) => provisioning === "unprovisioned"),
    ).toHaveLength(6);
  });
});

describe("PRD-373 selective feature verification", () => {
  it.each([
    ["docs/PRDs/inert.md", "prose"],
    ["AGENTS.md", "instructions"],
    ["packages/playtest/CLAUDE.md", "instructions"],
  ])("selects %s on develop without scheduling native", async (relative, selection) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, relative, "changed\n", "feature");
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      expect(plan).toMatchObject({ version: 2, selection });
      const jobs = plan.jobs as Record<string, { required: boolean; reason: string }>;
      expect(jobs["native-platforms"]).toMatchObject({ required: false });
      expect(jobs["native-platforms"]?.reason.length).toBeGreaterThan(10);
      expect(jobs["supply-chain"]?.required).toBe(selection !== "prose");
      expect(jobs.lint?.required).toBe(selection !== "prose");
      expect((plan.checks as Record<string, boolean>).instructions).toBe(
        selection === "instructions",
      );
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it.each([
    "packages/core/src/index.ts",
    "packages/playtest/src/runner/cli.ts",
    "packages/create-threenative/templates/starter/src/game.ts",
    "packages/physics/src/index.ts",
    "examples/native-smoke/src/index.ts",
    "tsconfig.base.json",
    "templates/topdown/CLAUDE.md",
  ])("selects retained consumers for %s according to shared/native reach", async (relative) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, relative, "changed\n", "dependency");
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      expect(plan.selection).toBe(
        relative.includes("create-threenative/templates/") ? "template" : "full",
      );
      expect(plan.jobs).toMatchObject({
        "native-platforms": {
          required: !relative.includes("create-threenative/templates/"),
        },
        "test-native": {
          required: !relative.includes("create-threenative/templates/"),
        },
        "golden-path-template": { required: true },
        "template-nonvisual": { required: true },
      });
      const native = (plan.jobs as Record<string, { reason: string }>)["native-platforms"];
      expect(native?.reason.length).toBeGreaterThan(10);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  describe("strata terrain CI selection", () => {
    it.each([
      "packages/terrain/src/index.ts",
      "examples/strata-terrain-preview/src/game.ts",
      "packages/core/src/world.ts",
      "packages/core/src/world-cells.ts",
      "packages/core/__tests__/world-cells-terrain.spec.ts",
    ])("selects strata job when %s changes on develop PR", async (path) => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(
          fixture,
          path,
          "export const terrainTouch = true;\n",
          "terrain change",
        );
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan.selection).toBe("full");
        const jobs = plan.jobs as Record<string, { required: boolean }>;
        expect(jobs.strata?.required).toBe(true);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("exempts strata, with the reason, when this run reaches no GPU runner", async () => {
      const { selectionPlan, validatePlan, validateEventPlan } = (await import(
        new URL("../ci-change-scope.mjs", import.meta.url).href
      )) as {
        selectionPlan: (...args: unknown[]) => {
          jobs: Record<string, { required: boolean; reason: string }>;
        };
        validatePlan: (plan: unknown) => unknown;
        validateEventPlan: (
          plan: unknown,
          event: { eventName: string; baseRef: string },
        ) => unknown;
      };
      const plan = () =>
        selectionPlan("full", "fixture", [], "a".repeat(40), false, 0, "main").jobs.strata;
      const saved = process.env.TN_CI_STRATA_GPU;
      try {
        process.env.TN_CI_STRATA_GPU = "false";
        expect(plan()?.required).toBe(false);
        expect(plan()?.reason).toMatch(/no GPU runner serves this run/u);
        // A caller job replays the plan with no GPU answer of its own (native-platforms runs
        // `--validate-plan`): the plan carries the answer, so the replay owes the same jobs.
        const exempt = selectionPlan("full", "fixture", [], "a".repeat(40), true, 0, "main");
        Reflect.deleteProperty(process.env, "TN_CI_STRATA_GPU");
        expect(() => validatePlan(JSON.parse(JSON.stringify(exempt)))).not.toThrow();
        // A promotion still qualifies with the recorded exemption, and only that one.
        const promotion = { eventName: "pull_request", baseRef: "main" };
        expect(() =>
          validateEventPlan(JSON.parse(JSON.stringify(exempt)), promotion),
        ).not.toThrow();
        process.env.TN_CI_STRATA_GPU = "true";
        expect(plan()?.required).toBe(true);
      } finally {
        if (saved === undefined) Reflect.deleteProperty(process.env, "TN_CI_STRATA_GPU");
        else process.env.TN_CI_STRATA_GPU = saved;
      }
      const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
      // The scope step's GPU answer and the strata job's runs-on GPU branch read the same variables.
      expect(ci).toContain("TN_CI_STRATA_GPU: ${{ !github.event.pull_request.head.repo.fork");
      expect(ci).toMatch(/strata:[\s\S]*?vars\.TN_RUNNER_GPU_HEAD[\s\S]*?vars\.TN_RUNNER_GPU /u);
      // ci-required re-decides a queue reuse with the same classifier, so it reads the same GPU
      // answer: without it strata defaulted to owed and refused a reuse scope had accepted (PR #673).
      const gpu = ci.match(/^ +TN_CI_STRATA_GPU: .*$/gmu) ?? [];
      expect(gpu).toHaveLength(2);
      expect(gpu[1]?.trim()).toBe(gpu[0]?.trim());
      expect(ci.slice(ci.indexOf("Reject every unsuccessful or missing selected job"))).toContain(
        gpu[0]?.trim(),
      );
    });

    it("skips strata job for an unrelated template change on develop PR", async () => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(
          fixture,
          "packages/create-threenative/templates/rain/src/game.ts",
          "export const rainTouch = true;\n",
          "unrelated template",
        );
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        const jobs = plan.jobs as Record<string, { required: boolean }>;
        expect(jobs.strata?.required).toBe(false);
      } finally {
        await removeFixture(fixture.root);
      }
    });

    it("runs every strata proof lane, gated by the scope plan", async () => {
      const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
      const strata = requiredJob(ci, "strata");
      expect(strata).toContain("fromJSON(needs.scope.outputs.plan).jobs.strata.required");
      for (const lane of ["web", "editor", "authored", "custom", "export"]) {
        expect(strata).toContain(`test:terrain:${lane}`);
      }
      expect(strata).toContain("test:consumer");
    });

    it("requires strata job in full qualification mode", async () => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(
          fixture,
          "packages/create-threenative/templates/rain/src/game.ts",
          "export const rainTouch = true;\n",
          "unrelated template",
        );
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "main"]);
        expect(plan.qualification).toBe(true);
        const jobs = plan.jobs as Record<string, { required: boolean }>;
        expect(jobs.strata?.required).toBe(true);
      } finally {
        await removeFixture(fixture.root);
      }
    });
  });

  it("a fresh install cannot stop on the interactive node_modules purge prompt", () => {
    // A checkout whose node_modules was not created by this pnpm makes `pnpm install` ask before
    // purging it. Agents run without a TTY, so the prompt hangs them until `CI=true` is added by
    // hand; this setting answers it for every install. pnpm reads workspace config from
    // pnpm-workspace.yaml, so a plain grep of package.json would not prove it.
    // pnpm 10 (the pinned packageManager) only reports a workspace-file setting at the `project`
    // location, while pnpm 11 reports it from the default lookup; accept either.
    const read = (extra: string[]) =>
      spawnSync("pnpm", ["config", "get", "confirmModulesPurge", ...extra], {
        cwd: repo,
        encoding: "utf8",
      });
    const defaultLookup = read([]);
    const result =
      defaultLookup.stdout.trim() === "false" ? defaultLookup : read(["--location=project"]);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("false");
  });

  it.each([
    "packages/runtime-native/native/CMakeLists.txt",
    "packages/runtime-native/src/host.cpp",
    "packages/runtime-native/AGENTS.md",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".github/workflows/native-platforms.yml",
    ".github/actions/pnpm/action.yml",
    ".github/actions/workspace-dist/action.yml",
  ])("requires native evidence for %s on a clean develop diff", async (relative) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, relative, "changed\n", "native dependency");
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      expect(plan.selection).toBe("full");
      expect(plan).toMatchObject({ native: true });
      expect(plan.jobs).toMatchObject({ "native-platforms": { required: true } });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it.each([
    ["packages/core/src/x.ts", "develop", true],
    ["packages/runtime-native/src/x.cpp", "develop", true],
    ["pnpm-lock.yaml", "develop", true],
    ["packages/core/src/x.ts", "main", true],
  ])("requires native for %s targeting %s: %s", async (relative, target, required) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, relative, "changed\n", "target policy");
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", target]);
      expect(plan.jobs).toMatchObject({ "native-platforms": { required } });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it.each(["schedule", "workflow_dispatch"])(
    "requires native for the %s event however clean the diff is",
    async (event) => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(fixture, "docs/PRDs/inert.md", "prose\n", "prose");
        const plan = classifyScope(fixture.root, fixture.base, head, [
          "--target",
          "develop",
          "--event-name",
          event,
        ]);
        expect(plan).toMatchObject({ selection: "full", native: true });
        expect(plan.jobs).toMatchObject({ "native-platforms": { required: true } });
      } finally {
        await removeFixture(fixture.root);
      }
    },
  );

  it("requires native for a push to main, and qualifies a push to develop with the whole board", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(
        fixture,
        "packages/core/src/x.ts",
        "export {};\n",
        "core",
      );
      const main = classifyScope(fixture.root, fixture.base, head, [
        "--target",
        "main",
        "--event-name",
        "push",
      ]);
      expect(main).toMatchObject({ selection: "full", native: true });
      // PRD-550: the exhaustive board left the queue for the tree-qualifying events, so a develop
      // push runs every lane and every native row.
      const develop = classifyScope(fixture.root, fixture.base, head, [
        "--target",
        "develop",
        "--event-name",
        "push",
      ]);
      expect(develop).toMatchObject({
        selection: "full",
        native: true,
        qualification: true,
        nativeTier: "full",
      });
      expect(develop.jobs).toMatchObject({ "native-platforms": { required: true } });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("requires native for --full and for a diff the classifier cannot resolve", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, "docs/PRDs/inert.md", "prose\n", "prose");
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop", "--full"]).jobs,
      ).toMatchObject({ "native-platforms": { required: true } });
      const fallback = classifyScope(fixture.root, "missing-base", head, ["--target", "develop"]);
      expect(fallback).toMatchObject({ selection: "full", native: true });
      expect(fallback.jobs).toMatchObject({ "native-platforms": { required: true } });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("fails validation when a hand-edited plan flips the native requirement", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(
        fixture,
        "packages/core/src/x.ts",
        "export {};\n",
        "core",
      );
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      expect(plan).toMatchObject({ native: true });
      plan.native = false;
      const result = spawnSync(
        process.execPath,
        [path.join(repo, "scripts/ci-change-scope.mjs"), "--validate-plan", JSON.stringify(plan)],
        { encoding: "utf8", env: isolatedGitEnvironment() },
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("CI_SCOPE_INVALID_PLAN");
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it.each(["docs/PRDs/inert.md", "docs/strategy/plan.md", "some-new-folder/unknown.md"])(
    "selects prose and requires no job for the inert Markdown %s",
    async (relative) => {
      const fixture = await scopeFixture();
      try {
        const head = await commitScopeChange(fixture, relative, "changed\n", "docs");
        const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
        expect(plan).toMatchObject({ selection: "prose" });
        const jobs = plan.jobs as Record<string, { required: boolean }>;
        expect(Object.values(jobs).some((job) => job.required)).toBe(false);
      } finally {
        await removeFixture(fixture.root);
      }
    },
  );

  it("never narrows main promotions, unknown targets or manual full runs", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, "docs/PRDs/inert.md", "changed\n", "docs");
      for (const extra of [
        ["--target", "main"],
        ["--target", "release"],
        ["--target", "develop", "--full"],
      ]) {
        expect(classifyScope(fixture.root, fixture.base, head, extra).selection).toBe("full");
      }
      for (const event of ["schedule", "workflow_dispatch"]) {
        expect(
          classifyScope(fixture.root, fixture.base, head, [
            "--target",
            "develop",
            "--event-name",
            event,
          ]).selection,
        ).toBe("full");
      }
      // A push qualifies the exact tree it promotes, on develop and on main alike.
      for (const target of ["develop", "main"]) {
        const push = classifyScope(fixture.root, fixture.base, head, [
          "--target",
          target,
          "--event-name",
          "push",
        ]);
        expect(push.selection).toBe("full");
        expect(push.qualification).toBe(true);
      }
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("unions docs and instructions without losing either rename endpoint", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, "AGENTS.md", "instructions\n", "agents");
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]),
      ).toMatchObject({
        selection: "instructions",
        checks: { instructions: true },
        jobs: { "native-platforms": { required: false } },
      });
      await mkdir(path.join(fixture.root, "packages/core/src"), { recursive: true });
      fixture.git(["mv", "AGENTS.md", "packages/core/src/moved.ts"]);
      fixture.git(["commit", "--quiet", "-m", "rename into shared runtime"]);
      const renamed = fixture.git(["rev-parse", "HEAD"]);
      expect(
        classifyScope(fixture.root, fixture.base, renamed, ["--target", "develop"]).selection,
      ).toBe("full");
      fixture.git(["rm", "packages/core/src/moved.ts"]);
      fixture.git(["commit", "--quiet", "-m", "delete shared runtime"]);
      expect(classifyScope(fixture.root, renamed, "HEAD", ["--target", "develop"]).selection).toBe(
        "full",
      );
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("does not hide shared changes in an earlier commit or an unresolved local diff", async () => {
    const fixture = await scopeFixture();
    try {
      await commitScopeChange(fixture, "packages/core/src/changed.ts", "export {};\n", "runtime");
      const head = await commitScopeChange(fixture, "docs/PRDs/inert.md", "latest prose\n", "docs");
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]).selection,
      ).toBe("full");
      expect(
        classifyScope(fixture.root, "unknown-base", head, ["--target", "develop"]).selection,
      ).toBe("full");
      await writeFile(path.join(fixture.root, "untracked-input.ts"), "export {};\n");
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop", "--local"])
          .selection,
      ).toBe("full");
    } finally {
      await removeFixture(fixture.root);
    }
  });
});

/**
 * A pull request whose whole diff is CI configuration. The rules that shape it:
 *
 *   - qualifying paths are the workflows, the `ci-*` scripts, their own specs and the runner
 *     images, plus anything already classified prose or instructions. Everything else keeps
 *     `full`: `.github/actions/**` is consumed by every board job including the native matrix,
 *     and a package, a template or a lockfile is the whole point of the board.
 *   - the merge queue runs the full board before anything lands, so a queue entry, a push, the
 *     nightly, an explicit audit and a promotion into main are never narrowed — they are the
 *     places where a tree is qualified rather than a change reviewed.
 *   - what stays required is what reads the configuration: the classifier itself, lint, typecheck,
 *     the unit shards (every `ci-*.spec.ts` is one of them), the budgets that hold the invariant,
 *     the secrets scan, and `build-artifacts` because three of those jobs consume its upload.
 */
const CI_KEPT_JOBS = [
  "budgets",
  "build-artifacts",
  "integration",
  "lint",
  "supply-chain",
  "test-unit",
  "typecheck",
];

const CI_SKIPPED_JOBS = [
  "benchmark",
  "build",
  "golden-path",
  "golden-path-template",
  "native-platforms",
  "performance-contracts",
  "strata",
  "template-nonvisual",
  "test",
  "test-browser",
  "test-native",
  "test-playtest",
];

describe("a CI-configuration-only pull request", () => {
  it.each([
    ".github/workflows/ci.yml",
    ".github/workflows/integration.yml",
    "scripts/ci-change-scope.mjs",
    "scripts/ci/classify.mjs",
    "scripts/ci/reuse.mjs",
    "scripts/ci-local.sh",
    "scripts/ci-workflow.ts",
    "scripts/__tests__/ci-needs.spec.ts",
    "tools/ci-runners/entrypoint.sh",
    "tools/ci-runners/scripts/balance.mjs",
  ])("selects `ci` for %s and requires exactly the jobs that read it", async (relative) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, relative, "# changed\n", "ci configuration");
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      expect(plan).toMatchObject({ selection: "ci", nativeTier: "none" });
      expect(
        Object.entries(plan.jobs as Record<string, { required: boolean }>)
          .filter(([, job]) => job.required)
          .map(([name]) => name)
          .sort(),
      ).toEqual(CI_KEPT_JOBS);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("keeps one package file in the same diff at full", async () => {
    const fixture = await scopeFixture();
    try {
      await commitScopeChange(fixture, ".github/workflows/ci.yml", "name: CI\njobs: {}\n", "ci");
      const head = await commitScopeChange(
        fixture,
        "packages/core/src/change.ts",
        "export const changed = true;\n",
        "one package file",
      );
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      expect(plan).toMatchObject({ selection: "full" });
      expect(plan.reason).toContain("packages/core/src/change.ts");
      const jobs = plan.jobs as Record<string, { required: boolean }>;
      expect(Object.values(jobs).filter((job) => job.required).length).toBeGreaterThan(6);
      // Every gate the `ci` selection skipped comes back. `native-platforms` is the one a clean
      // develop diff legitimately waives, and this diff does not touch a native path.
      for (const name of CI_SKIPPED_JOBS.filter(
        (job) => job !== "native-platforms" && job !== "strata",
      )) {
        expect(jobs[name]?.required, name).toBe(true);
      }
      expect(jobs["native-platforms"]?.required).toBe(true);
      expect(jobs.strata?.required).toBe(false);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it.each([
    ".github/actions/pnpm/action.yml",
    "pnpm-lock.yaml",
    "scripts/lib/not-ci.ts",
    "scripts/__tests__/something-else.spec.ts",
    "packages/create-threenative/templates/starter/src/game.ts",
  ])("keeps %s at full, because no CI-config rule covers it", async (relative) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(fixture, relative, "# changed\n", "not ci config");
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]).selection,
      ).toBe(relative.includes("create-threenative/templates/") ? "template" : "full");
    } finally {
      await removeFixture(fixture.root);
    }
  });

  // `.github/workflows/*.yml` qualifies, and `native-platforms.yml` is the one that must not: it is
  // the matrix's own definition, so narrowing it would exempt the very lane that has to prove it.
  it("keeps the native matrix's own workflow at full", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(
        fixture,
        ".github/workflows/native-platforms.yml",
        "name: native\njobs: {}\n",
        "native matrix",
      );
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]),
      ).toMatchObject({ selection: "full", native: true, nativeTier: "reduced" });
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("folds a doc or an AGENTS.md edit into the same `ci` selection", async () => {
    const fixture = await scopeFixture();
    try {
      await commitScopeChange(fixture, ".github/workflows/ci.yml", "name: CI\njobs: {}\n", "ci");
      await commitScopeChange(fixture, "AGENTS.md", "# agents\n", "instructions");
      const head = await commitScopeChange(fixture, "docs/PRDs/inert.md", "# prose\n", "docs");
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]).selection,
      ).toBe("ci");
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it.each([
    [["--event-name", "schedule", "--target", "develop"]],
    [["--event-name", "workflow_dispatch", "--target", "develop"]],
    [["--event-name", "merge_group", "--target", "main"]],
    [["--event-name", "push", "--target", "develop"]],
    [["--target", "main"]],
  ])("never narrows %j", async (extra) => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(
        fixture,
        ".github/workflows/ci.yml",
        "name: CI\njobs: {}\n",
        "ci configuration",
      );
      expect(
        classifyScope(fixture.root, fixture.base, head, ["--target", "develop", ...extra])
          .selection,
      ).toBe("full");
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("runs a develop push as the exhaustive qualification, never the ci narrowing", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(
        fixture,
        ".github/workflows/ci.yml",
        "name: CI\njobs: {}\n",
        "ci configuration",
      );
      const push = classifyScope(fixture.root, fixture.base, head, [
        "--event-name",
        "push",
        "--target",
        "develop",
      ]);
      expect(push.selection).toBe("full");
      expect(push.qualification).toBe(true);
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("runs the kept jobs on `ci` and leaves every other gate on `full` alone", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const sections = new Map(jobSections(ci));
    // `scope` produces the selection and `ci-required` reads the plan on `always()`; neither is
    // gated by one, so neither can name it.
    for (const name of [...CI_KEPT_JOBS, "run-summary"]) {
      if (name === "integration") {
        expect(sections.get(name)).toContain(
          "fromJSON(needs.scope.outputs.plan).jobs.integration.required",
        );
        continue;
      }
      expect(sections.get(name), name).toContain("needs.scope.outputs.selection == 'ci'");
    }
    for (const name of CI_SKIPPED_JOBS) {
      expect(sections.get(name), name).not.toContain("needs.scope.outputs.selection == 'ci'");
      expect(sections.get(name), name).toContain("needs.scope.outputs.selection == 'full'");
    }
    // `build-artifacts` produces the upload three kept jobs consume; skipping it would leave them
    // ordered behind a job that never ran.
    for (const name of ["typecheck", "test-unit", "budgets"]) {
      expect(declaredNeeds(sections.get(name) ?? ""), name).toContain("build-artifacts");
    }
  });

  it("validates a `ci` plan and rejects one whose kept jobs were flipped", async () => {
    const fixture = await scopeFixture();
    try {
      const head = await commitScopeChange(
        fixture,
        ".github/workflows/ci.yml",
        "name: CI\njobs: {}\n",
        "ci configuration",
      );
      const plan = classifyScope(fixture.root, fixture.base, head, ["--target", "develop"]);
      const validate = (value: unknown) =>
        spawnSync(
          process.execPath,
          [
            path.join(repo, "scripts/ci-change-scope.mjs"),
            "--validate-plan",
            JSON.stringify(value),
          ],
          { encoding: "utf8", env: isolatedGitEnvironment() },
        );
      expect(validate(plan).status).toBe(0);
      const forged = JSON.parse(JSON.stringify(plan)) as {
        jobs: Record<string, { required: boolean }>;
      };
      const unit = forged.jobs["test-unit"];
      expect(unit).toBeDefined();
      (unit as { required: boolean }).required = false;
      const refused = validate(forged);
      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("CI_SCOPE_INVALID_PLAN");
    } finally {
      await removeFixture(fixture.root);
    }
  });

  it("reads a run's job list in small pages, because a large page answers 502 after a --failed rerun", async () => {
    // Run 41288322050 attempt 3: `jobs?filter=latest&per_page=100` answered 502 at 10.6 s on 9 of 9
    // reads, and the release gate of tag runtime-native-v0.3.7 could not read its own CI run.
    const sources = [
      ".github/workflows/ci.yml",
      ".github/workflows/ci-janitor.yml",
      ".github/workflows/native-release.yml",
      "scripts/ci-queue-watch.mjs",
      "scripts/ci-merge-latency.mjs",
    ];
    for (const source of sources) {
      const large = (await readFile(source, "utf8"))
        .split("\n")
        .filter((line) => /\/jobs\?[^"'`\s]*per_page=(?:[2-9]\d|\d{3})/u.test(line));
      expect({ source, large }).toEqual({ source, large: [] });
    }
  });
});

// Release run 42296982894: release-candidate's `resolve` ran a root `pnpm build` with no web Wasm engine,
// and examples/spell-lab (default engine) stopped at TN_WASM_ENGINE_MISSING, so `ship` published nothing.
describe("a job that runs the root build restores the web Wasm engine first", () => {
  it("puts native-engine-wasm before every root `pnpm build`", async () => {
    const missing: string[] = [];
    const dir = path.join(process.cwd(), ".github/workflows");
    for (const relative of (await readdir(dir)).filter((name) => name.endsWith(".yml"))) {
      const source = await readFile(path.join(dir, relative), "utf8");
      for (const [job, section] of jobSections(source)) {
        const build = section.search(/^\s+(?:-\s+)?run:\s+pnpm build\s*$/mu);
        if (build >= 0 && !section.slice(0, build).includes("./.github/actions/native-engine-wasm"))
          missing.push(`${relative}:${job}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
