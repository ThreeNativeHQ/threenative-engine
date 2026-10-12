import { spawnSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import { allTemplates } from "../../test-support/templates.js";
import { declaredNeeds } from "../ci-workflow.js";
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
  const performance = await readFile(
    path.join(repo, ".github/workflows/performance-regression.yml"),
    "utf8",
  );
  const summary = performance.slice(
    performance.indexOf("  performance-summary:"),
    performance.indexOf("  weekly-workload-rotation:"),
  );
  expect(summary).toContain(
    'pnpm tsx scripts/performance-regression/ci-summary.ts --validate-selected-lane "$TN_PERF_SELECTED_LANE" --manifest scripts/performance-regression/lanes.json',
  );
  expect(summary.indexOf("Validate requested performance lane")).toBeLessThan(
    summary.indexOf("Download every available platform result"),
  );
});

it("keeps source-pair preparation failures keyed by matrix identity", async () => {
  const performance = await readFile(
    path.join(repo, ".github/workflows/performance-regression.yml"),
    "utf8",
  );
  const prepare = performance.slice(
    performance.indexOf("      - name: Prepare isolated source checkouts"),
    performance.indexOf("      - name: Run independent alternating baseline/candidate pairs"),
  );
  const env = prepare.slice(prepare.indexOf("        env:"), prepare.indexOf("        run:"));
  expect(env).toContain("TN_PERF_LANE: ${{ matrix.lane }}");
  expect(env).toContain("TN_PERF_RESULT_KEY: ${{ matrix.result_key }}");
  expect(prepare.indexOf("TN_PERF_LANE")).toBeLessThan(
    prepare.indexOf("TN_PERF_SOURCE_FAILURE_REASON"),
  );
  expect(prepare).toContain("candidateSourceSha: process.env.TN_PERF_CANDIDATE_SOURCE_SHA");
  expect(prepare).toContain("sourceSha: process.env.TN_PERF_BASELINE_SOURCE_SHA");
});

it("preserves both source identities in blocked source-pair artifacts", async () => {
  const performance = await readFile(
    path.join(repo, ".github/workflows/performance-regression.yml"),
    "utf8",
  );
  const prepare = performance.slice(
    performance.indexOf("      - name: Prepare isolated source checkouts"),
    performance.indexOf("      - name: Run independent alternating baseline/candidate pairs"),
  );
  const writerLine = prepare
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
  const performance = await readFile(
    path.join(repo, ".github/workflows/performance-regression.yml"),
    "utf8",
  );
  const prepare = performance.slice(
    performance.indexOf("      - name: Prepare isolated source checkouts"),
    performance.indexOf("      - name: Run independent alternating baseline/candidate pairs"),
  );
  expect(prepare).toContain("REVIEWED_BASELINE_INPUT: ${{ vars.TN_PERF_REVIEWED_BASELINE_SHA }}");
  expect(prepare).toContain('baseline_sha="${BASELINE_INPUT:-${REVIEWED_BASELINE_INPUT:-}}"');
  expect(prepare).toContain('candidate_sha="${CANDIDATE_INPUT:-$GITHUB_SHA}"');
  expect(prepare).toContain(
    'if [ -z "$baseline_sha" ] || [ -z "$candidate_sha" ] || [ "$baseline_sha" = "$candidate_sha" ]; then',
  );
  const collector = performance.slice(
    performance.indexOf("      - name: Run independent alternating baseline/candidate pairs"),
    performance.indexOf(
      "      - uses: actions/upload-artifact@v7",
      performance.indexOf("      - name: Run independent alternating baseline/candidate pairs"),
    ),
  );
  expect(collector).toContain('--baseline-source-sha "$BASELINE_SOURCE_SHA"');
  expect(collector).toContain('--candidate-source-sha "$CANDIDATE_SOURCE_SHA"');
  const summary = performance.slice(
    performance.indexOf("  performance-summary:"),
    performance.indexOf("  weekly-workload-rotation:"),
  );
  expect(summary).toContain("TN_PERF_SELECTED_LANE: ${{ inputs.lane }}");
  expect(summary).toContain(
    "const required = (row) => selected(row) || manifestByLane.get(row.lane)?.required === true;",
  );
  expect(summary).toContain('status: selected(row) ? "BLOCKED" : "SKIPPED",');
  expect(summary).toContain(
    "requiredLanes: expectedRows.filter(required).map(({ resultKey }) => resultKey),",
  );
  expect(summary).not.toContain("requiredLanes: expectedResultKeys");

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
  const source = await readFile(
    path.join(repo, ".github/workflows/performance-regression.yml"),
    "utf8",
  );
  const job = source.slice(
    source.indexOf("  hardware-pairs:"),
    source.indexOf("  performance-summary:"),
  );
  expect(job.match(/^ {4}if:[\s\S]*?(?=^ {4}\w)/m)?.[0] ?? "").not.toContain("matrix.");
  expect(job).toMatch(/defaults:\s+run:\s+shell: bash/);
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

function jobSections(source: string): readonly [string, string][] {
  const jobsIndex = source.indexOf("\njobs:\n");
  if (jobsIndex < 0) throw new Error("CI workflow did not include a jobs mapping.");
  const jobs = source.slice(jobsIndex);
  const matches = [...jobs.matchAll(/^ {2}([A-Za-z0-9_-]+):\n/gm)];
  return matches.map((match, index) => {
    const name = match[1];
    if (name === undefined) throw new Error("CI job heading did not include a name.");
    return [name, jobs.slice(match.index, matches[index + 1]?.index ?? jobs.length)];
  });
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
      "--event-name",
      "pull_request",
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
  it("uses one fail-closed scope decision before expensive CI and native jobs", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const scope = requiredJob(ci, "scope");
    expect(scope).toContain("scripts/ci-change-scope.mjs");
    expect(scope).toContain("fetch-depth: 0");
    expect(scope).toContain("scope: ${{ steps.classify.outputs.scope }}");
    expect(scope).toContain("selection: ${{ steps.classify.outputs.selection }}");
    expect(scope).toContain("reason: ${{ steps.classify.outputs.reason }}");
    expect(scope).not.toContain("pnpm install");

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
      const job = requiredJob(ci, name);
      expect(job, `${name} does not wait for scope`).toContain("scope");
      expect(job, `${name} does not select the full board explicitly`).toContain(
        "needs.scope.outputs.selection == 'full'",
      );
    }

    const lint = requiredJob(ci, "lint");
    expect(lint).toContain("needs: scope");
    expect(lint).toContain("Run the selected documentation and evidence gates");
    expect(lint).toContain("pnpm check:docs");
    expect(lint).toContain("scripts/__tests__/evidence-citations.spec.ts");
    expect(lint).toContain("scripts/__tests__/ci-needs.spec.ts");
    expect(lint).not.toContain("pnpm test:browser");
    expect(lint).not.toContain("native:build");

    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const nativeScope = requiredJob(native, "scope");
    expect(nativeScope).toContain("scripts/ci-change-scope.mjs");
    expect(nativeScope).toContain("scope: ${{ steps.classify.outputs.scope }}");
    expect(nativeScope).not.toContain("pnpm install");
    for (const name of [
      "web-reference",
      "android-emulator-parity",
      "desktop-parity",
      "desktop",
      "starter-linux",
      "ios-simulator",
    ]) {
      expect(requiredJob(native, name), `${name} does not use shared scope`).toContain("scope");
      expect(requiredJob(native, name), `${name} has no prose exemption`).toContain(
        "needs.scope.outputs.selection == 'full'",
      );
    }
    const performanceCoverage = requiredJob(native, "performance-coverage");
    expect(performanceCoverage).toContain("needs.scope.outputs.selection == 'full'");
    const triggers = triggerSection(native);
    expect(triggers).toContain("workflow_dispatch:");
    expect(triggers).toContain("workflow_call:");
    expect(triggers).toContain("ios_only:");
    expect(triggers).not.toMatch(/\n\s{2}(?:push|pull_request|schedule):/u);
  });

  it("never lets a draft pull request run cancel a ready one", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const group = /^concurrency:\n {2}group: (.*)$/mu.exec(ci)?.[1] ?? "";
    // A push then `gh pr ready` fires a synchronize run whose payload still says draft. In the
    // shared `latest` group with cancel-in-progress, that skipped run cancelled the real one
    // (#403, run 37075825121). Only a non-draft pull request run joins the shared group.
    expect(group).toContain("!github.event.pull_request.draft && 'latest'");
  });

  it("warms the base-branch caches from a develop push, and lets no push cancel another", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    // `develop` is the only branch a push may name besides main, and it is the base branch every
    // pull request reads its caches from.
    const push = /^ {2}push:\n(?: {4}.*\n)*/mu.exec(commandText(triggerSection(ci)))?.[0] ?? "";
    expect([...push.matchAll(/^ {6}- (\S+)$/gmu)].map((match) => match[1])).toEqual([
      "main",
      "develop",
    ]);
    // The `warm` plan still exists as a selection, and these are the only jobs it runs: the two
    // cache publishers plus the reporting job.
    for (const name of ["build-artifacts", "test-native", "run-summary"]) {
      expect(requiredJob(ci, name), `${name} never runs on a develop push`).toContain(
        "needs.scope.outputs.selection == 'warm'",
      );
    }
    expect(duplicateCommitTriggers(ci)).toEqual([]);
    // Each push run gets its own concurrency group (the group ends in its run id unless it is a
    // ready pull request) and nothing but a pull request cancels in progress, so a second push to
    // develop cannot kill the first one while it is saving.
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
  });

  it("does not require skipped performance lanes on a prose-only run", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const summary = requiredJob(ci, "run-summary");
    const performance = summary.slice(
      summary.indexOf("Report the performance contract through the shared comparison summary"),
    );
    expect(performance).toContain("TN_CI_SCOPE: ${{ needs.scope.outputs.selection }}");
    expect(performance).toContain('required_lanes=""');
    expect(performance).toContain('if [ "$TN_CI_SCOPE" = full ]; then');
    expect(performance).toContain('required_lanes="performance-contracts,native-linux-contract"');
    expect(performance).toContain('--required-lanes "$required_lanes"');
    expect(performance).not.toContain(
      "--required-lanes performance-contracts,native-linux-contract",
    );
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
      const source = await readFile(path.join(repo, relative), "utf8");
      expect(source, relative).not.toContain("cancel-run-on-failure");
      expect(source, `${relative} cancels its own run`).not.toContain(
        "actions/runs/$GITHUB_RUN_ID/cancel",
      );
      // Nothing calls the Actions API to cancel its own run, so nothing may ask to write to it.
      // `ci-janitor.yml` is the single named exception: it cancels *other* runs, on a closed PR,
      // never from a failure step, and never its own run id — all four pinned in its own case.
      if (relative !== ".github/workflows/ci-janitor.yml") {
        expect(source, `${relative} needs no actions: write`).not.toContain("actions: write");
      }
    }

    // Fail-fast that keeps its evidence: a matrix reports every leg, and an expensive job is
    // skipped by its `needs:` edge rather than cancelled out from under itself.
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("fail-fast: false");
    expect(requiredJob(ci, "golden-path-template")).toContain("needs: [scope, build-artifacts]");
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
    const source = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const blocks = [...source.matchAll(/^(\s+)script: *(\||>-|>|\|-)\n/gmu)].map((match) => {
      const indent = match[1]?.length ?? 0;
      const rest = source.slice((match.index ?? 0) + match[0].length).split("\n");
      const body: string[] = [];
      for (const line of rest) {
        if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
        body.push(line);
      }
      return { body: body.join("\n"), style: match[2] ?? "" };
    });
    expect(blocks.length, "no emulator script block found to check").toBeGreaterThan(0);
    for (const { body, style } of blocks) {
      // `|` keeps every newline, which is exactly what the action cannot take.
      expect(style, `script uses a literal block: ${body.trim().slice(0, 60)}`).not.toMatch(/^\|/u);
      expect(body, "script continues with a backslash").not.toMatch(/\\\s*\n/u);
      expect(body, "script lost its target").toContain("--target android");
      expect(body, "script lost its output path").toContain("--out ");
    }
  });

  it("caches what the Android lane would otherwise re-download every run", async () => {
    // Measured on run 33675488456: ~6 min re-installing SDK/emulator packages and ~5 min on the
    // Gradle build plus the Rust cross-compile, in a 35 min job. `third_party` was already cached
    // and restored in about 4 s; these three simply had no cache step at all.
    // Run 36357493470 (2026-09-28) reversed the SDK half: sdkmanager installed platform, NDK,
    // emulator and system image in ~40 s, while the multi-GB save took 240 s every run and
    // evicted the Gradle and Cargo entries from the shared 10 GiB budget, so none of them hit.
    const source = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const android = requiredJob(source, "android-emulator-parity");
    expect(android, "the SDK cache costs more to save than to reinstall").not.toContain(
      "system-images/android-35",
    );
    for (const [what, needle] of [
      ["the Gradle caches", "~/.gradle/caches"],
      ["the Rust cross-compile output", ".runtime/physics-target"],
    ] as const) {
      expect(android, `the Android lane stopped caching ${what}`).toContain(needle);
    }
    // The cargo key has to follow the lockfile that actually drives the build; a `**/Cargo.lock`
    // glob would also hash third_party's and miss on churn that changes nothing here.
    expect(android).toContain("packages/runtime-native/native/physics/Cargo.lock");
  });

  it("bounds every runner job with an explicit timeout", async () => {
    for (const relative of workflows) {
      const source = await readFile(path.join(repo, relative), "utf8");
      for (const [job, section] of jobSections(source)) {
        if (section.includes("runs-on:"))
          expect(section, `${relative} ${job}`).toContain("timeout-minutes:");
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
  // The hosted jobs that stay hosted, per workflow. `supply-chain` runs gitleaks through
  // `docker run`; a self-hosted container would need the host Docker socket mounted to do that,
  // which would hand every job root on the owner's machine. `publish-android-v8` is the release
  // publish itself — `permissions: contents: write` and a `gh release upload` — and PRD-480 keeps
  // release writes on GitHub's own machines.
  const hosted = new Map<string, ReadonlySet<string>>([
    // golden-path-template runs hosted: its dev server twice failed to answer on a local slot (run 37089715252).
    [
      ".github/workflows/ci.yml",
      new Set([
        "golden-path-template",
        "lint",
        "performance-contracts",
        "supply-chain",
        "template-nonvisual",
      ]),
    ],
    [
      ".github/workflows/native-platforms.yml",
      // publish-android-v8 writes the release; android-emulator-parity is CPU-bound SwiftShader that
      // overran its 45-minute budget on a pinned 4-thread slot (run 37082733117).
      new Set([
        "android-emulator-parity",
        "publish-android-v8",
        "web-reference",
        "android-v8-source",
      ]),
    ],
    [
      ".github/workflows/integration.yml",
      // PRD-550: these generic lanes run hosted so they do not queue behind the local build/test pool.
      new Set([
        "animation",
        "capture",
        "cold-boot",
        "csg",
        "decals",
        "exposure",
        "fluid-collision",
        "fog",
        "ik",
        "temporal",
        "tone",
        "vegetation",
        "velocity",
      ]),
    ],
  ]);
  it.each([
    ["web-reference", "native-web-reference-${{ needs.scope.outputs.candidate_sha }}"],
    ["android-v8-source", "android-v8-${{ needs.scope.outputs.candidate_sha }}"],
  ])(
    "keeps native platform prerequisite %s hosted with exact candidate artifacts",
    async (job, artifact) => {
      const native = await readFile(
        path.join(repo, ".github/workflows/native-platforms.yml"),
        "utf8",
      );
      const section = requiredJob(native, job);
      // An idle-pool variable is not a reservation. These producers must remain hosted even
      // when both CI and Integration select the same advertised local capacity in a burst.
      expect(section.match(/^ {4}runs-on: (.+)$/mu)?.[1]).toBe("ubuntu-24.04");
      expect(declaredNeeds(section)).toEqual(["scope"]);
      expect(section).toContain("TN_CI_SHA: ${{ needs.scope.outputs.candidate_sha }}");
      expect(section).toContain("ref: ${{ needs.scope.outputs.candidate_sha }}");
      expect(section).toContain(`name: ${artifact}`);
      expect(section).toContain("if-no-files-found: error");
      const android = requiredJob(native, "android-emulator-parity");
      expect(declaredNeeds(android)).toEqual(["scope", "web-reference", "android-v8-source"]);
      expect(android).toContain(`name: ${artifact}`);
      if (job === "android-v8-source") {
        expect(section).toContain("uses: ./.github/actions/android-v8-source");
        expect(section).toContain("recipe-hash: ${{ steps.v8.outputs.recipe-hash }}");
        expect(section).toContain("published: ${{ steps.v8.outputs.published }}");
      }
    },
  );

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

  it("routes every movable Linux job through exactly one TN_RUNNER switch", async () => {
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
          const onHeavy = runner === routing;
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

  // PRD-550: pin the generic lanes hosted to split the pool; the light switch and native ARM labels stay.
  it("pins generic Integration lanes to hosted while the light and native legs keep their routing", async () => {
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
      "temporal",
      "tone",
      "vegetation",
      "velocity",
    ] as const) {
      expect(runsOn(job), `integration ${job} must not share the local build/test pool`).toBe(
        "ubuntu-24.04",
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
    expect(triggers).toContain("workflow_run:");
    expect(triggers).toContain("workflows: [CI]");
    expect(triggers).toContain("types: [completed]");
    const pushBlock = triggers.slice(
      triggers.indexOf("\n  push:"),
      triggers.indexOf("\n  pull_request:"),
    );
    expect(pushBlock, "a push-to-main trigger still feeds the evidence path").not.toContain(
      "branches:",
    );
    expect(pushBlock, "the tag publish path lost its trigger").toContain("runtime-native-v*");
    // Tag publication and manual proof keep the single-shot lookup they always had.
    expect(native).toMatch(/gh run list .*--workflow ci\.yml --commit/u);
    expect(npm).toContain('gh release view "runtime-native-v${native_version}"');
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
    // `gates` refuses) gets a group of its own so it can never displace a pending proof.
    expect(groups).toEqual([
      "${{ (github.event_name != 'pull_request' || github.event.pull_request.base.ref == 'main' || contains(github.event.pull_request.labels.*.name, 'release-proof')) && 'native-release-proof' || format('native-release-skip-{0}', github.run_id) }}",
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

  it("requires the matching native release for a publishing dispatch", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const publish = jobSections(npm).find(([job]) => job === "publish")?.[1];
    expect(publish).toContain("if: github.event_name == 'push' || inputs.dry_run == false");
  });

  it("requires the matching native release to be published and ready", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const publish = jobSections(npm).find(([job]) => job === "publish")?.[1];
    expect(publish).toContain("--json isDraft,isPrerelease");
    expect(publish).toContain(".isDraft == false and .isPrerelease == false");
    expect(publish).toMatch(/\$\{release_state\}" != "ready"/u);
  });

  it("requires the matching native release tag to name the exact candidate commit", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const publish = jobSections(npm).find(([job]) => job === "publish")?.[1];
    expect(publish).toContain('native_tag="runtime-native-v${native_version}"');
    expect(publish).toContain("scripts/verify-native-release-commit.ts");
    expect(publish).toContain("native tag and the candidate SHA");
  });

  it("reuses the already verified native CI result in the guarded release job", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const publish = jobSections(npm).find(([job]) => job === "publish")?.[1];
    expect(publish).toBeDefined();
    if (publish === undefined) return;
    expect(publish).toContain("pnpm tsx scripts/release.ts --yes --skip-gates");
    expect(publish).toContain("pnpm tsx scripts/release.ts --skip-gates");
  });

  it("provisions the registry verifier before the guarded publish command", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const publish = jobSections(npm).find(([job]) => job === "publish")?.[1];
    expect(publish).toBeDefined();
    if (publish === undefined) return;
    const prerequisites = publish.indexOf(
      "Install the pinned Blender used by the registry verifier",
    );
    const release = publish.indexOf("pnpm tsx scripts/release.ts --yes");
    expect(prerequisites).toBeGreaterThanOrEqual(0);
    expect(publish).toContain("libvulkan1 mesa-vulkan-drivers");
    expect(publish).toContain("THREENATIVE_BLENDER_PATH");
    expect(release).toBeGreaterThan(prerequisites);
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
  it("runs the clean room alone on a clean_room_only dispatch, never the publish", async () => {
    const npm = await readFile(path.join(repo, ".github/workflows/npm-release.yml"), "utf8");
    const jobs = jobSections(npm);
    const gates = jobs.find(([job]) => job === "gates")?.[1];
    const cleanRoom = jobs.find(([job]) => job === "clean-room")?.[1];
    expect(npm).toMatch(/clean_room_only:\n(?: {8}.+\n)*? {8}default: false/u);
    expect(gates).toContain("if: inputs.clean_room_only != true");
    expect(cleanRoom).toContain("inputs.clean_room_only == true");
    // The desktop prebuilt links the overlay webview; without it doctor and native exit 127.
    expect(cleanRoom).toContain("libwebkit2gtk-4.1-0");
    expect(cleanRoom).toContain("needs.publish.result == 'success'");
    expect(cleanRoom).toContain("!cancelled()");
  });

  it("requires native release CI to be a successful push on main", async () => {
    const native = await readFile(path.join(repo, ".github/workflows/native-release.yml"), "utf8");
    const gates = jobSections(native).find(([job]) => job === "gates")?.[1];
    expect(gates).toContain("--json databaseId,status,conclusion,event,headBranch,headSha");
    expect(gates).toContain('entry?.event === "push"');
    expect(gates).toContain('entry?.headBranch === "main"');
    expect(gates).toContain("entry?.headSha === candidateSha");
    expect(gates).toContain("Number.isSafeInteger(entry?.databaseId)");
    expect(gates).toContain("entry.databaseId > 0");
    // The evidence path reads the triggering CI completion from the event payload -
    // conclusion plus head SHA - and refuses anything but exact-candidate success.
    // No step polls or holds a runner: the verdict runs on a single-digit-minute budget.
    expect(gates).toContain("Require the triggering CI completion");
    expect(gates).toContain("github.event.workflow_run.conclusion");
    expect(gates).toContain("github.event.workflow_run.head_sha");
    expect(gates).toContain("github.event.workflow_run.head_branch");
    expect(gates).not.toContain("Wait for the exact main CI run to finish");
    expect(gates).not.toContain("sleep 60");
    const timeout = Number(gates?.match(/\n\s{4}timeout-minutes: (\d+)/u)?.[1]);
    expect(timeout, "the gates verdict must not hold a runner").toBeLessThanOrEqual(9);
    // Both verdict steps enforce the same required-job table: the event-payload verdict
    // for `workflow_run` evidence and the single-shot lookup for tag/manual proof.
    const tables = [...(gates?.matchAll(/const requiredNames = \[([\s\S]*?)\];/gu) ?? [])].map(
      (match) => match[1],
    );
    expect(tables.length).toBe(2);
    expect(tables[0]).toBe(tables[1]);
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
    expect(job).not.toContain("github.event_name == 'push'");
    // An `if:` gate naming the event, not any mention of it: the TN_RUNNER routing expression
    // (PRD-480) reads `github.event.pull_request.head.repo.fork` in every routed job and gates
    // nothing on it. What this forbids is a gate that skips pull requests.
    expect(job).not.toMatch(/^\s+if:.*pull_request/mu);
    expect(job).toContain('TN_PLAYTEST_ALLOW_SOFTWARE: "1"');
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

  // The obsolete shard arithmetic snapshots are replaced by complete kit/scenario coverage.
  // ci-template-selection.spec.ts checks PR selections and exhaustive queue matrices.
  it("runs the complete classifier output once, without repeated scaffold shards", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const lane = requiredJob(ci, "template-nonvisual");
    expect(lane).toContain("matrix: ${{ fromJSON(needs.scope.outputs.plan).templateMatrix }}");
    expect(lane).toContain('for scenario in "${scenarios[@]}"');
    expect(lane).toContain('test "${#scenarios[@]}" -gt 0');
    expect(lane).not.toContain("SHARD");
    // GitHub's shared hosted quota owns capacity; the workflow must not hold selected kits back.
    expect(lane).not.toMatch(/^\s+max-parallel:/mu);
    expect(lane).toContain("fail-fast: false");
    expect(lane).toContain("runs-on: ubuntu-24.04");
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
    const primary = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(triggerSection(primary), "ci.yml does not run on pull requests").toContain(
      "pull_request:",
    );
    for (const [relative, source] of [
      [".github/workflows/ci.yml", primary],
      [
        ".github/workflows/native-platforms.yml",
        await readFile(path.join(repo, ".github/workflows/native-platforms.yml"), "utf8"),
      ],
    ] as const) {
      const workflow = relative;
      expect(source, `${workflow} still bootstraps pnpm through npm`).not.toContain(
        "pnpm/action-setup",
      );
      for (const [name, section] of jobSections(source)) {
        if (!section.includes("actions/setup-node")) continue;
        const local = section.indexOf("uses: ./.github/actions/pnpm");
        expect(local, `${workflow} job ${name} does not install pnpm locally`).toBeGreaterThan(-1);
        // `cache: pnpm` shells out to `pnpm store path`, so pnpm has to be on PATH already.
        expect(
          local,
          `${workflow} job ${name} installs pnpm after setup-node reads its store`,
        ).toBeLessThan(section.indexOf("actions/setup-node"));
      }
    }

    const action = await readFile(path.join(repo, ".github/actions/pnpm/action.yml"), "utf8");
    const digests = await readFile(path.join(repo, ".github/actions/pnpm/checksums.txt"), "utf8");
    // Fail closed twice over: an asset with no recorded digest, and a digest that does not match.
    expect(action).toContain("no recorded digest");
    // The digest is computed here and compared as a string, not handed to `sha256sum --check`:
    // the macOS image ships a `sha256sum` that is not coreutils and has no `--check`, so on run
    // 33831657853 that checker printed a usage line and reported a mismatch on a binary whose
    // bytes were correct. Every tool the action probes must survive an edit, and both failure
    // paths must still name what went wrong and stop the job.
    expect(action).toContain("digest_of");
    expect(action).toContain("shasum --algorithm 256");
    expect(action).toContain("sha256sum");
    expect(action).toContain("openssl dgst -sha256");
    expect(action, "a digest the action cannot compute must fail the job").toContain(
      "could not compute a sha-256 digest",
    );
    expect(action, "a wrong binary must still fail the job").toContain("not the recorded");

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
    expect(action, `the action does not read the workspace's pinned pnpm`).toContain(
      "packageManager",
    );
  });

  it("PR CI reviews dependencies and scans changed commits for leaked secrets", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const supplyChain = requiredJob(ci, "supply-chain");
    // Markdown-only PRs skip the scan entirely (owner call 2026-09-12): the nightly develop run
    // and promotions still scan the full git history, so an inert prose PR spends no runner here.
    // PRD-481 added the reused tree to the exempt set and the `ci` selection to the admitted one,
    // so the condition names every selection it admits instead of the one it refuses.
    expect(supplyChain).toContain("needs: scope");
    expect(supplyChain).toContain(
      "if: (needs.scope.outputs.selection == 'full' || needs.scope.outputs.selection == 'template') || needs.scope.outputs.selection == 'instructions' || needs.scope.outputs.selection == 'ci'",
    );
    expect(supplyChain).toContain("if: github.event_name != 'pull_request'");
    expect(supplyChain).toContain("uses: actions/dependency-review-action@v4");
    // ...but the dependency diff itself stays pull_request-only: it needs a base ref and a head
    // ref, which a push does not supply, and ungating it made every push-to-main run red.
    expect(
      supplyChain,
      "dependency-review must stay pull_request-only; on push it has no base/head ref",
    ).toContain(
      "- uses: actions/dependency-review-action@v4\n        if: github.event_name == 'pull_request'",
    );
    expect(supplyChain).toContain("fail-on-severity: moderate");
    expect(supplyChain).not.toContain("allow-licenses");
    expect(supplyChain).toContain("fetch-depth: 0");
    expect(supplyChain).toContain("ghcr.io/gitleaks/gitleaks@sha256:");
    expect(supplyChain).toContain("github.event.pull_request.base.sha");
    expect(supplyChain).toContain("Scan the full git history for leaked secrets");
    expect(supplyChain).toContain("github.event.pull_request.head.sha");
    expect(supplyChain).toContain('git rev-list --count "$range"');
    expect(supplyChain).toContain("git --redact --verbose");
    expect(supplyChain).toContain('--log-opts="$TN_GITLEAKS_RANGE"');
  });

  it("the primary workflow owns the nightly run and invokes the native lane", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(triggerSection(ci)).toMatch(/schedule:\n\s+- cron: ["']17 3 \* \* \*["']/u);
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    expect(triggerSection(native)).toContain("workflow_call:");
    expect(triggerSection(native)).not.toMatch(/\n\s{2}(?:push|pull_request|schedule):/u);
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

  it("native cache keys hash their inputs and activate ccache", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const jobs = [
      ["ci test-native", requiredJob(ci, "test-native")],
      ["native desktop parity", requiredJob(native, "desktop-parity")],
      ["native desktop matrix", requiredJob(native, "desktop")],
      ["native starter linux", requiredJob(native, "starter-linux")],
    ] as const;
    for (const [name, section] of jobs) {
      expect(section, name).toContain("packages/runtime-native/third_party");
      expect(section, name).toContain("packages/runtime-native/scripts/download-deps.mjs");
      expect(section, name).toContain("CCACHE_DIR");
      // CMake reads the launcher from the environment under these two names only. It does not
      // read CMAKE_PROJECT_INCLUDE_BEFORE from the environment, so writing a .cmake file and
      // exporting that name compiled without ccache while looking activated.
      expect(section, name).toContain("CMAKE_C_COMPILER_LAUNCHER: ccache");
      expect(section, name).toContain("CMAKE_CXX_COMPILER_LAUNCHER: ccache");
      expect(section, name).not.toMatch(/^\s+echo "CMAKE_PROJECT_INCLUDE_BEFORE=/mu);
      const keys = [...section.matchAll(/^\s+key:\s*(.+)$/gmu)].map((match) => match[1] ?? "");
      expect(keys.length, `${name} has no explicit cache keys`).toBeGreaterThanOrEqual(2);
      for (const key of keys) expect(key, name).toContain("hashFiles(");
      expect(section, name).toContain("packages/runtime-native/CMakeLists.txt");

      // A compiler cache that ccache writes to one directory and actions/cache saves from
      // another is not a compiler cache: the save finds nothing, no entry is ever stored, and
      // every run recompiles from scratch while the workflow reads as if it were cached. That
      // shipped, and `gh cache list` had no native-ccache entry at all after five runs. These
      // three assertions are the difference between the steps existing and the cache working.
      const ccacheDir = section.match(/^\s+CCACHE_DIR:\s*(.+)$/mu)?.[1]?.trim();
      expect(ccacheDir, `${name} does not set CCACHE_DIR`).toBeDefined();
      const cachedPaths = [...section.matchAll(/^\s+path:\s*(.+)$/gmu)].map((match) =>
        (match[1] ?? "").trim(),
      );
      expect(cachedPaths, `${name} caches ${ccacheDir}`).toContain(ccacheDir);

      // GitHub cache keys are immutable: a key that is only a content hash saves once and is
      // never updated again, so the cache stops growing the moment a source file changes. The
      // run id makes every run save, and restore-keys makes every run restore the newest.
      const ccacheKey = keys.find((key) => key.includes("native-ccache"));
      expect(ccacheKey, `${name} has no native-ccache key`).toBeDefined();
      expect(ccacheKey, `${name} never re-saves its compiler cache`).toContain("github.run_id");

      // A cache nobody measures is a cache nobody notices going cold.
      expect(section, `${name} never reports its ccache hit rate`).toContain("ccache --show-stats");
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
  it("gives every native compiler cache a restore namespace no other job writes to", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const jobs = [
      ["ci test-native", requiredJob(ci, "test-native")],
      ["native desktop parity", requiredJob(native, "desktop-parity")],
      ["native desktop matrix", requiredJob(native, "desktop")],
      ["native starter linux", requiredJob(native, "starter-linux")],
    ] as const;

    const namespaces = new Map<string, string>();
    for (const [name, section] of jobs) {
      // By name, not by position: these jobs restore more than one cache, and `test-native` also
      // restores the compiled build tree. Picking the first `restore-keys` in the block asserted
      // against whichever cache happened to be declared first.
      const restoreKey = [...section.matchAll(/^\s+restore-keys:\s*(.+)$/gmu)]
        .map((match) => (match[1] ?? "").trim().replace(/^["']|["']$/gu, ""))
        .find((key) => key.includes("native-ccache"));
      expect(restoreKey, `${name} has no ccache restore-keys prefix`).toBeDefined();
      const previous = namespaces.get(restoreKey ?? "");
      expect(
        previous,
        `${name} shares the ccache restore namespace ${restoreKey} with ${previous}`,
      ).toBeUndefined();
      namespaces.set(restoreKey ?? "", name);

      // The save key must start with the prefix it restores by, or the lane saves into a
      // namespace it never reads back and the restore silently falls through to a sibling's.
      const saveKey = [...section.matchAll(/^\s+key:\s*(.+)$/gmu)]
        .map((match) => (match[1] ?? "").trim())
        .find((key) => key.includes("native-ccache"));
      expect(saveKey, `${name} has no native-ccache save key`).toBeDefined();
      expect(saveKey, `${name} saves outside the namespace it restores from`).toContain(
        restoreKey ?? "",
      );
    }
  });

  // `golden-path-template` used to scaffold starter and platformer and run their non-visual
  // scenarios itself, then run `verify:golden-path`, which packs and scaffolds the same template
  // all over again. Since 2026-09-01 `template-nonvisual` runs that identical sweep for all eight
  // templates on every event, so the copy inside the golden-path lane proved nothing new and cost
  // 350s of the run's critical path (run 33690597861, step "Run the scaffold's GPU-free
  // assertions"). The verifier is what this lane is for; the sweep belongs to the job that owns it.
  it("leaves the non-visual scenario sweep to template-nonvisual", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const goldenPath = requiredJob(ci, "golden-path-template");
    const nonVisual = requiredJob(ci, "template-nonvisual");

    expect(nonVisual).toContain("non-visual-scenarios.mjs");
    expect(nonVisual).toContain("threenative-playtest");
    // Both templates the golden-path matrix drives must be covered by the sweep that replaces it.
    for (const template of ["starter", "platformer"]) {
      expect(matrixTemplates(nonVisual)).toContain(template);
    }

    // Commands, not prose: the job's comments name the classifier and the runner precisely
    // because it delegates to them, and a raw-text match cannot tell an explanation from a step.
    const commands = goldenPath
      .split("\n")
      .filter((line) => !/^\s*#/u.test(line))
      .join("\n");
    expect(
      commands,
      "golden-path-template re-runs the sweep template-nonvisual already owns",
    ).not.toContain("non-visual-scenarios.mjs");
    expect(commands, "golden-path-template still drives scenarios itself").not.toContain(
      "threenative-playtest",
    );
    expect(goldenPath).toContain("pnpm verify:golden-path");
  });

  // Every matrix leg ran `workspace-packages.ts build` and then `pnpm pack` per package: ten legs
  // paying ~70s each to produce byte-identical tarballs from the same commit. `build` already
  // compiles the workspace, so it packs once and the legs download the result.
  it("packs the workspace tarballs once and shares them with every matrix leg", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const build = requiredJob(ci, "build-artifacts");
    expect(build, "build does not publish the packed tarballs").toContain(
      "actions/upload-artifact",
    );
    expect(build).toContain("uses: ./.github/actions/workspace-dist");
    expect(build).not.toContain("pnpm tsx scripts/workspace-packages.ts --archives");

    for (const name of ["golden-path-template", "template-nonvisual"]) {
      const job = requiredJob(ci, name);
      expect(job, `${name} does not consume the shared tarballs`).toContain(
        "actions/download-artifact",
      );
      expect(job, `${name} still packs the workspace itself`).not.toMatch(
        /pnpm --filter "\$package_name" pack/u,
      );
      // Nothing may re-derive the specs file locally; the artifact is the single source.
      expect(job, `${name} re-runs the workspace build`).not.toContain(
        "pnpm tsx scripts/workspace-packages.ts build",
      );
    }

    // The first attempt shipped only `packages/create-threenative/dist` and every scaffold died:
    // the CLI's `dist/index.js` imports `@threenative/assets`, pnpm resolves that through a
    // workspace symlink into `packages/assets/dist/index.js`, and the leg no longer builds the
    // workspace. What the legs need is the whole compiled workspace, so the artifact carries it
    // and this asserts the glob rather than any one package's name.
    const uploaded = build.slice(build.indexOf("actions/upload-artifact"));
    expect(uploaded, "the shared artifact does not carry the compiled workspace").toMatch(
      /^\s+packages\/\*\/dist$/mu,
    );
    expect(uploaded).toMatch(/^\s+artifacts\/workspace-packages$/mu);
    // An empty upload must fail the job rather than hand every downstream leg a silent nothing.
    expect(uploaded).toContain("if-no-files-found: error");
  });

  // `test` used to compile the C++ host for 279s before running a single JS test, because one
  // package's suite drives real contract executables. Splitting that off is only safe if the two
  // halves still cover every package between them — a `--filter` that names a package neither job
  // runs is a gate that goes green by running less, which is the failure this repository fails
  // closed against everywhere else. So this computes the partition rather than trusting it.
  it("splits the suite in two without dropping a package on the floor", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const js = requiredJob(ci, "test");
    const native = requiredJob(ci, "test-native");

    // The JS half must not compile anything, or the split bought nothing.
    expect(js, "the JS half still builds the native host").not.toContain("native:build");
    expect(js, "the JS half still carries the compiler cache").not.toContain("CCACHE_DIR");
    expect(js).toContain("- run: pnpm test");

    // The native half must build what its suite executes, and run only that suite.
    expect(native).toContain("native:build");
    expect(native).toContain("CCACHE_DIR");
    // The contract tests import the compiled workspace. `pnpm test` used to build it for them;
    // this job does not run `pnpm test`, so it has to build it itself or the suite dies on
    // ERR_MODULE_NOT_FOUND for `@threenative/playtest` before it executes a binary.
    expect(native, "the native half never builds the workspace its tests import").toContain(
      "uses: ./.github/actions/workspace-dist",
    );
    expect(native, "the native half re-runs the whole suite").not.toMatch(
      /^\s+- run: pnpm test$/mu,
    );

    const excluded = (js.match(/TN_SUITE_EXCLUDE_PACKAGES:\s*"([^"]*)"/u)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    expect(excluded.length, "the JS half excludes nothing, so the split is a duplicate").toBe(1);

    const filtered = [...native.matchAll(/pnpm --filter (\S+) test/gu)].map((match) => match[1]);
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
  it("reads the compiler cache counters between builds, not only at the end", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = requiredJob(ci, "test-native");

    const readings = [...native.matchAll(/^\s+- name: Compiler cache after (.+)$/gmu)].map(
      (match) => (match[1] ?? "").trim(),
    );
    expect(readings, "the native job reports one total for three builds").toEqual([
      "the host build",
      "the V8 contract executables",
      "the QuickJS variant",
    ]);
    // And the size of what the restore actually put on disk, because a hit rate cannot
    // distinguish a cold cache from one restored into the wrong directory.
    expect(native).toContain('du -sh "$CCACHE_DIR"');
  });

  it("builds V8 native contracts through the configured aggregate target", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = requiredJob(ci, "test-native");
    const commands = commandText(native);
    const v8Contracts = workflowRunScript(ci, "Build the V8 contract executables").trim();

    expect(v8Contracts).toBe(
      [
        "set -euo pipefail",
        'cmake --build build/tn-linux --target threenative-native-tests --parallel "$(nproc)"',
      ].join("\n"),
    );
    expect(commands, "test-native must not rediscover configured targets lexically").not.toContain(
      "add_executable",
    );
    expect(commands, "test-native must not rebuild a handwritten target vector").not.toContain(
      "target_args",
    );
    expect(commands, "test-native must not swallow a failed aggregate build").not.toContain(
      "combined contract build failed",
    );
    expect(
      v8Contracts,
      "test-native must not turn a failed contract build into echo output",
    ).not.toMatch(/\|\|\s*\\?\s*\n?\s*echo/u);

    const quickJs = workflowRunScript(
      ci,
      "Build the QuickJS engine variant the cross-engine contracts need",
    );
    expect(quickJs).toContain("node scripts/download-deps.mjs --only quickjs");
    expect(quickJs).toContain(
      "cmake -S . -B build/tn-linux-quickjs -DMYSTRAL_USE_QUICKJS=ON -DMYSTRAL_USE_V8=OFF",
    );
    expect(quickJs).toContain(
      "cmake --build build/tn-linux-quickjs --target threenative-timestamp-query-test",
    );
    expect(quickJs).toContain(
      '--target threenative-rg11b10-renderable-test --target mystral --parallel "$(nproc)"',
    );
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
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = requiredJob(ci, "test-native");

    const keys = [...native.matchAll(/^\s+key:\s*(.+)$/gmu)].map((match) =>
      (match[1] ?? "").trim(),
    );
    const buildKey = keys.find((key) => key.includes("native-build-"));
    expect(buildKey, "the native build tree is not cached").toBeDefined();
    for (const input of [
      "packages/runtime-native/CMakeLists.txt",
      "packages/runtime-native/src/**",
      "packages/runtime-native/include/**",
    ]) {
      expect(buildKey, `the build-tree key ignores ${input}`).toContain(input);
    }
    // Deliberately NOT run-scoped, unlike the compiler cache. A ccache directory grows with
    // every run and wants a fresh entry; a build tree is a pure function of its sources, so a
    // run-scoped key stores the same 1.1 GiB repeatedly. On 2026-09-03 four entries carried the
    // identical source hash, `native-build-Linux` held 5.57 GiB of the repository's 10 GiB
    // budget, and the cache evicted itself and its neighbours — total runner work went up.
    expect(
      buildKey,
      "a run-scoped build-tree key stores the same tree once per run and evicts the budget",
    ).not.toContain("github.run_id");
    expect(native).not.toContain("restore-keys: native-build-");
    // Both configured build directories, or the QuickJS variant recompiles from nothing.
    expect(native).toContain("packages/runtime-native/build/tn-linux");
    expect(native).toContain("packages/runtime-native/build/tn-linux-quickjs");
    // The Rust crates too: once the C++ compile was cached away, they were the whole remaining
    // ~112s of the host build step.
    // The path the build actually writes, not the one cargo would default to:
    // `build-native-physics.mjs` passes `--target-dir` because it cross-compiles to five targets.
    expect(native).toContain("packages/runtime-native/.runtime/physics-target");
    const physicsScript = await readFile(
      path.join(repo, "packages/runtime-native/scripts/build-native-physics.mjs"),
      "utf8",
    );
    expect(physicsScript, "the physics build no longer writes where the cache looks").toContain(
      "'.runtime', 'physics-target'",
    );
    expect(native).toContain("packages/runtime-native/native/ui-overlay/target");
    for (const input of [
      "packages/runtime-native/native/**/src/**",
      "packages/runtime-native/native/**/Cargo.toml",
      "packages/runtime-native/native/**/Cargo.lock",
    ]) {
      expect(buildKey, `the build-tree key ignores ${input}`).toContain(input);
    }
    // A cached build tree is only usable if its inputs are older than it. `actions/checkout`
    // stamps everything with the time it ran, so without this the restore is dead weight and
    // ninja rebuilds the tree it just downloaded.
    expect(native, "the restored tree is older than its own freshly checked-out inputs").toContain(
      "restore-source-mtimes.mjs",
    );
    // And it needs history to do it. A shallow clone dates every file to HEAD, which is newer
    // than the cached tree, so the cache is worse than useless — run 33751865452 restamped 299 of
    // 299 files and rebuilt 78 objects behind a cache it had just restored.
    expect(native, "the mtime restore runs against a shallow clone").toContain("fetch-depth: 0");
    const script = await readFile(
      path.join(repo, "packages/runtime-native/scripts/restore-source-mtimes.mjs"),
      "utf8",
    );
    expect(script, "a shallow clone is silently mis-stamped rather than refused").toContain(
      "TN_MTIME_SHALLOW_CLONE",
    );
    const order = native.indexOf("restore-source-mtimes.mjs");
    expect(order, "sources are dated after the build has already run").toBeLessThan(
      native.indexOf("native:build"),
    );
  });

  // Within one run the workspace dist compiled about nine times, at 71-95s each. Every consumer
  // declared `needs: scope` only, so all eight started beside the one job that saves the key, all
  // eight looked for an entry nobody had published yet, and all eight compiled it themselves. The
  // action grows a mode that takes this run's upload instead; a job that keeps the cache path next
  // to a producer it is ordered behind is the arrangement that put the nine builds back.
  it("compiles the workspace dist once and hands the upload to every consumer", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const producer = requiredJob(ci, "build-artifacts");
    expect(producer).toContain("uses: ./.github/actions/workspace-dist");
    expect(producer, "the producer no longer publishes what consumers download").toContain(
      "name: workspace-packages",
    );
    expect(producer).toMatch(/^\s+packages\/\*\/dist$/mu);

    const shared = "shared-artifact: workspace-packages";
    for (const [name, section] of jobSections(ci)) {
      if (name === "build-artifacts") continue;
      // The action is what compiles; this job is about which of them compile it themselves.
      if (!section.includes("uses: ./.github/actions/workspace-dist")) continue;
      // `lint` keeps the cache path on purpose: its dist lane runs on the `instructions` selection,
      // where `build-artifacts` is skipped and there is no upload to take. Everything that runs on
      // `full` downloads instead.
      if (name === "lint") continue;
      expect(section, `${name} restores a key nobody saved before it`).toContain(
        "needs: [scope, build-artifacts]",
      );
      expect(section, `${name} compiles the workspace instead of downloading it`).toContain(shared);
    }

    const action = await readFile(
      path.join(repo, ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    // Fail closed on the download exactly as on the restore: a partial upload must not be imported
    // from, and the producer's step order — build, validate, publish — is what keeps it complete.
    expect(action).toContain("Take the compiled workspace from this run's producer");
    expect(action).toContain("uses: actions/download-artifact@v4");
    expect(action).toContain("TN_WORKSPACE_DIST_INCOMPLETE");
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
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    expect(
      ci,
      "a job builds the workspace inline instead of through the shared action",
    ).not.toContain("pnpm tsx scripts/workspace-packages.ts build");
    expect(occurrences(ci, /uses: \.\/\.github\/actions\/workspace-dist/gu)).toBeGreaterThanOrEqual(
      5,
    );

    const action = await readFile(
      path.join(repo, ".github/actions/workspace-dist/action.yml"),
      "utf8",
    );
    // The key has to name what the bundles are made of. Miss one and a stale bundle is served to
    // every consumer, which is the only failure this cache can have.
    for (const input of [
      "packages/*/src/**",
      "packages/*/package.json",
      "packages/*/tsup.config.ts",
      "packages/*/scripts/**",
      "scripts/workspace-packages.ts",
      "pnpm-lock.yaml",
    ]) {
      expect(action, `the workspace-dist key ignores ${input}`).toContain(input);
    }
    // And a restore that came back partial must fail rather than be imported from — bundles and
    // tarballs both, since three lanes take the archives rather than the bundles.
    expect(action).toContain("TN_WORKSPACE_DIST_INCOMPLETE");
    expect(action).toContain("TN_WORKSPACE_ARCHIVES_INCOMPLETE");
    expect(action).toContain("artifacts/workspace-packages");

    // `playwright.config.ts` scaffolds from packed tarballs and rebuilds every package to get
    // them unless it is handed a set. Measured at 245s of setup against 40s of testing.
    const browser = requiredJob(ci, "test-browser");
    expect(browser, "the browser lane repacks the workspace before it can test").toContain(
      "THREENATIVE_PACKED_PACKAGES",
    );
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
  it("hands the budgets gate the dist it resolves through export maps", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const budgets = requiredJob(ci, "budgets");

    const dist = "uses: ./.github/actions/workspace-dist";
    expect(budgets, "the budgets job runs a gate that resolves dist without having it").toContain(
      dist,
    );
    // And it has to arrive before the gate reads it, not after.
    expect(
      budgets.indexOf(dist),
      "the budgets job builds after the gate that needs the build",
    ).toBeLessThan(budgets.indexOf("- run: pnpm budgets"));
  });

  it("keeps developer tests self-contained and gives CI an explicit prebuilt path", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const test = requiredJob(ci, "test");
    const native = requiredJob(ci, "test-native");
    const browser = requiredJob(ci, "test-browser");
    const playtest = requiredJob(ci, "test-playtest");
    const browserDist = browser.indexOf("uses: ./.github/actions/workspace-dist");
    const playtestDist = playtest.indexOf("uses: ./.github/actions/workspace-dist");
    const nativeDist = native.indexOf("uses: ./.github/actions/workspace-dist");
    const nativeSmokeBuild = native.indexOf("pnpm --filter threenative-native-smoke build");
    const nativeTests = native.indexOf("pnpm --filter @threenative/runtime-native test");

    expect(manifest.scripts.test).toBe("bash scripts/run-test-suite.sh");
    expect(manifest.scripts["test:ci"]).toContain("TN_SUITE_PREBUILT=1");
    expect(manifest.scripts["test:browser"]).toContain("@threenative/playtest build");
    expect(manifest.scripts["test:browser:ci"]).not.toContain("@threenative/playtest build");
    expect(manifest.scripts["test:playtest"]).toContain("@threenative/playtest build");
    expect(manifest.scripts["test:playtest:ci"]).not.toContain("@threenative/playtest build");

    expect(test).toContain('TN_SUITE_PHASES: "docs,build,package-test"');
    expect(test).toContain("run: pnpm test:ci");
    expect(nativeDist).toBeGreaterThanOrEqual(0);
    expect(nativeSmokeBuild, "the native suite has no built smoke bundle").toBeGreaterThan(
      nativeDist,
    );
    expect(nativeTests, "the smoke bundle is built after the native suite starts").toBeGreaterThan(
      nativeSmokeBuild,
    );
    expect(browserDist).toBeGreaterThanOrEqual(0);
    expect(playtestDist).toBeGreaterThanOrEqual(0);
    expect(browser.indexOf("pnpm test:browser:ci")).toBeGreaterThan(browserDist);
    expect(playtest.indexOf("pnpm test:playtest:ci")).toBeGreaterThan(playtestDist);
    expect(browser).toContain("THREENATIVE_PACKED_PACKAGES");

    const prebuiltSection = test.slice(test.indexOf("run: pnpm test:ci"));
    expect(prebuiltSection).toContain("run: pnpm test:ci");
    expect(prebuiltSection).not.toContain("@threenative/playtest build");
  });

  it("reuses iOS archive outputs only after simulator verification and an identity check", async () => {
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const ios = requiredJob(native, "ios-simulator");
    const initialBuild = ios.indexOf("Build iOS proof workspace dependencies");
    const verifier = ios.indexOf("verify-ios-simulator.mjs");
    const pack = ios.indexOf("Pack the exact consumer packages");
    const packEnd = ios.indexOf("Scaffold the iOS consumer from local tarballs", pack);
    const packSection = ios.slice(pack, packEnd < 0 ? undefined : packEnd);

    expect(initialBuild).toBeGreaterThanOrEqual(0);
    expect(verifier).toBeGreaterThan(initialBuild);
    expect(pack).toBeGreaterThan(verifier);
    expect(ios).toContain("scripts/ios-package-output-snapshot.ts");
    expect(ios).not.toContain("find packages -type f \\( -path '*/dist/*'");
    expect(ios).toContain("cmp -s");
    expect(ios).toContain("TN_IOS_PACKAGE_OUTPUTS_CHANGED");
    expect(ios).toContain("TN_IOS_PACKAGE_OUTPUTS_MISSING");
    expect(packSection).toContain("workspace-packages.ts --archives");
    expect(packSection).toContain('pnpm --filter "$package_name" pack --pack-destination');
    expect(packSection).not.toContain("--if-present run build");
  });

  it("produces one commit-keyed web reference and makes Android and desktop consume it", async () => {
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const producer = requiredJob(native, "web-reference");
    const android = requiredJob(native, "android-emulator-parity");
    const desktop = requiredJob(native, "desktop-parity");
    const commands = (section: string): string =>
      section
        .split("\n")
        .filter((line) => !/^\s*#/u.test(line))
        .join("\n");
    const producerCommands = commands(producer);
    const labelGate = "contains(github.event.pull_request.labels.*.name, 'native')";
    // Every eligibility assertion below reads the comment-stripped section. A comment that merely
    // quotes the label gate — the ones explaining why this leg no longer carries it do exactly
    // that — would otherwise satisfy a `toContain` or trip a `not.toContain` without any condition
    // changing.
    const androidCommands = commands(android);

    expect(producerCommands).toContain("--target web --out artifacts/conformance/web");
    // Pinned as one exact condition, not a direction. The invariant is that the producer is never
    // gated more tightly than its most permissive consumer, or that consumer runs on a pull request
    // with no reference to compare against — but asserting only that leaves room for the producer
    // to acquire some *other* narrowing condition (a branch test, an actor test) unnoticed. Since
    // 2026-09-06 `android-emulator-parity` carries no label gate, so this is the whole condition
    // the producer may carry.
    expect(producerCommands, "web reference is an orphan on unlabelled pull requests").toContain(
      [
        "if: >-",
        "      needs.scope.outputs.selection == 'full' &&",
        "      inputs.ios_only == false",
      ].join("\n"),
    );
    expect(
      androidCommands,
      "the Android leg regained a gate the producer does not carry",
    ).not.toContain(labelGate);
    expect(producerCommands, "producer is gated more tightly than its consumer").not.toContain(
      labelGate,
    );
    expect(producer).toContain("actions/upload-artifact");
    expect(producer).toContain("native-web-reference-${{ needs.scope.outputs.candidate_sha }}");
    expect(producer).toContain("if-no-files-found: error");
    expect(producer).toContain("check-lane-blocks.mjs");

    for (const [name, section] of [
      ["android", android],
      ["desktop", desktop],
    ] as const) {
      const consumer = commands(section);
      // Both consumers share the caller-owned full scope and explicit dispatch conditions.
      // Matched against the comment-stripped section for the reason given above the producer's
      // assertion: the comments here quote the very gate being asserted absent.
      expect(consumer, `${name} eligibility drifted from the web producer`).toContain(
        [
          "if: >-",
          "      needs.scope.outputs.selection == 'full' &&",
          "      inputs.ios_only != true",
        ].join("\n"),
      );
      expect(consumer, `${name} overrides the caller's full selection`).not.toContain(labelGate);
      // The property is that the consumer waits on `scope` and the web-reference producer, not
      // that those are its *only* dependencies. PRD-221 adds `android-v8-source` to the Android
      // leg, which is a second producer it legitimately waits on; a literal match on the whole
      // bracket rejected that correct workflow.
      const needs = section.match(/\n\x20{4}needs: \[([^\]]*)\]/u)?.[1];
      expect(needs, `${name} declares no needs list`).toBeDefined();
      const declared = (needs ?? "").split(",").map((entry) => entry.trim());
      for (const producer of ["scope", "web-reference"]) {
        expect(declared, `${name} is not ordered behind ${producer}`).toContain(producer);
      }
      expect(section, `${name} does not download the commit-keyed reference`).toContain(
        "actions/download-artifact",
      );
      expect(section, `${name} can download another commit's reference`).toContain(
        "native-web-reference-${{ needs.scope.outputs.candidate_sha }}",
      );
      expect(section, `${name} does not validate its downloaded reference`).toContain(
        "check-lane-blocks.mjs",
      );
      expect(consumer, `${name} captures a private web fallback`).not.toContain(
        "--target web --out artifacts/conformance/web",
      );
    }

    expect(occurrences(producerCommands, /--target web --out artifacts\/conformance\/web/gu)).toBe(
      1,
    );
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
    expect(triggers).not.toMatch(/\n\s{2}(?:push|pull_request|schedule):/u);

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
    expect(nonVisual).not.toContain("github.event_name == 'push'");
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
      "if: ${{ !cancelled() && (needs.scope.outputs.selection == 'full' || needs.scope.outputs.selection == 'template') }}",
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
    expect(callers).toBe(9);
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

  it("requires the performance workflow structure to retain collectors, failure evidence, and promotion separation", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const performance = await readFile(
      path.join(repo, ".github/workflows/performance-regression.yml"),
      "utf8",
    );
    const contracts = requiredJob(ci, "performance-contracts");
    expect(contracts).toContain("profile-production.mjs");
    expect(contracts).toContain("ci-summary.ts");
    expect(contracts).toContain("if: always()");
    expect(contracts).toContain("retention-days: 14");
    expect(contracts).toContain("retention-days: 30");
    for (const source of [native, performance]) {
      expect(source).toContain("production-evidence.mjs");
      expect(source).toContain("actions/upload-artifact");
      expect(source).toContain("if: always()");
    }
    expect(performance).toContain("workflow_dispatch:");
    expect(performance).toContain("schedule:");
    expect(performance).not.toContain("pull_request_target");
    expect(performance).toContain("max-parallel: 2");
    expect(performance).toContain("--trusted");
    expect(performance).toContain("TN_PERF_PHYSICAL_PROVISIONED");
    expect(performance).toContain("matrix.physical == true");
    expect(performance).toContain("inputs.trusted == true");
    expect(performance).toContain("required-check-promotion");
    expect(performance).toContain("baseline-regeneration");
    expect(performance).toContain("weekly-workload-rotation");
    expect(performance).toContain("pnpm test:templates");
    expect(performance).toContain("release-soak");
    expect(performance).toContain("pnpm native:qualify:physical");
    expect(performance).toContain("7200000");
  });

  it("reports a scheduled missing baseline before fetching or checking out source", async () => {
    const performance = await readFile(
      path.join(repo, ".github/workflows/performance-regression.yml"),
      "utf8",
    );
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
    const script = workflowRunScript(
      performance,
      "Prepare isolated source checkouts inside the repository worktree",
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

  it("maps every performance matrix row to its declared platform runner and unique result key", async () => {
    const performance = await readFile(
      path.join(repo, ".github/workflows/performance-regression.yml"),
      "utf8",
    );
    expect(performance).toMatch(/matrix:[\s\S]*runner: ubuntu-24\.04/u);
    expect(performance).toMatch(
      /lane: native-windows[\s\S]*result_key: native-windows[\s\S]*runner: windows-2025/u,
    );
    expect(performance).toMatch(
      /lane: native-macos[\s\S]*result_key: native-macos[\s\S]*runner: macos-15/u,
    );
    expect(performance).toMatch(
      /lane: native-android[\s\S]*runner:\s*\[self-hosted, linux, android,/u,
    );
    expect(performance).toMatch(/lane: native-ios[\s\S]*runner:\s*\[self-hosted, macOS, ios,/u);
    expect(performance).toMatch(/runs-on:.*matrix.runner/u);
    expect(performance).toContain("result_key");
    expect(performance).toContain("native-windows");
    expect(performance).toContain("native-macos");
  });

  it("uses a permitted cancellation source in the performance summary step", async () => {
    const performance = await readFile(
      path.join(repo, ".github/workflows/performance-regression.yml"),
      "utf8",
    );
    const summary = requiredJob(performance, "performance-summary");
    expect(summary).not.toContain("TN_PERF_CANCELLED: ${{ cancelled() }}");
    expect(summary).toContain(
      "TN_PERF_CANCELLED: ${{ needs.hardware-pairs.result == 'cancelled' }}",
    );
  });

  it("runs bounded native desktop and simulator collectors against built artifacts", async () => {
    const ci = await readFile(path.join(repo, ".github/workflows/ci.yml"), "utf8");
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    expect(requiredJob(ci, "test-native")).toContain("--hosted-software");
    const desktopStart = native.indexOf(
      "Collect bounded desktop performance evidence from the built runtime",
    );
    const desktopEnd = native.indexOf("uses: actions/upload-artifact", desktopStart);
    const desktop = native.slice(desktopStart, desktopEnd);
    expect(desktop).toContain("--target desktop");
    expect(desktop).toContain('--prebuilt-artifact "$artifact"');
    expect(desktop).toContain("--duration 1");
    expect(desktop).toContain("--cold-starts 1");
    expect(desktop).toContain("--repetitions 1");
    expect(desktop).toContain("--hosted-software");
    expect(desktop).toContain("collector_status=FAIL");
    expect(desktop).toContain("build/tn-windows/mystral.exe");
    expect(desktop).toContain("build/tn-macos/mystral");
    expect(desktop).not.toContain("--help");
    const simulatorStart = native.indexOf(
      "Collect bounded iOS simulator evidence without claiming a phone run",
    );
    const simulatorEnd = native.indexOf("uses: actions/upload-artifact", simulatorStart);
    const simulator = native.slice(simulatorStart, simulatorEnd);
    expect(simulator).toContain(
      "find packages/runtime-native/build/tn-ios-simulator -name threenative-ios.app",
    );
    expect(simulator).toContain("--target ios");
    expect(simulator).toContain("--device ios-simulator");
    expect(simulator).toContain('--prebuilt-artifact "$app"');
    expect(simulator).toContain("--duration 1");
    expect(simulator).toContain("--hosted-software");
    expect(simulator).toContain("--cold-starts 1");
    expect(simulator).toContain('provenance":"simulator"');
    expect(simulator).toContain('status":"UNVERIFIED"');
    expect(simulator).not.toContain("--help");
  });

  it("proves desktop release signing with test credentials on both hosted hosts", async () => {
    const native = await readFile(
      path.join(repo, ".github/workflows/native-platforms.yml"),
      "utf8",
    );
    const desktop = requiredJob(native, "desktop");
    // Owner decision 2026-09-23: each developer signs their own game; the engine ships no
    // certificate. The lane proves the credential path with a runner-generated certificate on each
    // host, and reads the signature back independently of the adapter that wrote it. Without this
    // the macOS half signs ad-hoc and the credentialed path the decision names stays unwired.
    expect(desktop).toContain("Create a self-signed code-signing certificate for the proof");
    expect(desktop).toContain("Create a self-signed code-signing certificate for the macOS proof");
    expect(desktop).toContain("THREENATIVE_DESKTOP_SIGN_SUBJECT=ThreeNative CI Signing Proof");
    expect(desktop).toContain('THREENATIVE_DESKTOP_CODESIGN_IDENTITY="$TN_SIGNING_PROOF_IDENTITY"');
    expect(desktop).toContain("Get-AuthenticodeSignature");
    expect(desktop).toContain("codesign --verify --strict --deep");
    expect(desktop).toContain("Authority=ThreeNative CI Signing Proof");
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

  it("a fresh install cannot stop on the interactive node_modules purge prompt", () => {
    // A checkout whose node_modules was not created by this pnpm makes `pnpm install` ask before
    // purging it. Agents run without a TTY, so the prompt hangs them until `CI=true` is added by
    // hand; this setting answers it for every install. pnpm reads workspace config from
    // pnpm-workspace.yaml, so a plain grep of package.json would not prove it.
    const result = spawnSync("pnpm", ["config", "get", "confirmModulesPurge"], {
      cwd: repo,
      encoding: "utf8",
    });
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
      for (const name of CI_SKIPPED_JOBS.filter((job) => job !== "native-platforms")) {
        expect(jobs[name]?.required, name).toBe(true);
      }
      expect(jobs["native-platforms"]?.required).toBe(true);
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
});
