import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const scope = await import(new URL("../ci-integration-scope.mjs", import.meta.url).href);
const validate = scope.validateIntegrationReceipts;
const changeScope = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);
const fixture = await import(
  new URL("../../test-support/ci-integration-fixture.ts", import.meta.url).href
);
const candidate = "a".repeat(40);
const current = { candidateSha: candidate, runId: "123", runAttempt: "2", planVersion: 2 };
const expected = {
  ...current,
  jobs: ["decals", "decals-native"],
  jobNames: { decals: "decals", "decals-native": "Linux native decal correctness" },
};
const receipts = expected.jobs.map((job, i) => ({
  version: 1,
  ...current,
  job,
  jobId: String(i + 10),
  conclusion: "success",
}));
const jobs = expected.jobs.map((job, i) => ({
  id: i + 10,
  name: `integration / ${expected.jobNames[job as keyof typeof expected.jobNames]}`,
  run_id: 123,
  run_attempt: 2,
  status: "completed",
  conclusion: "success",
}));

describe("required current-attempt integration receipts", () => {
  it("accepts only complete current-attempt candidate-bound integration legs", () => {
    expect(validate(expected, receipts, { totalCount: jobs.length, jobs })).toBeUndefined();
  });
  it.each(["skipped", "cancelled", "failure", "timed_out", null])(
    "rejects a selected leg concluding %s",
    (conclusion) => {
      expect(() =>
        validate(expected, receipts, {
          totalCount: 2,
          jobs: [jobs[0], { ...jobs[1], conclusion }],
        }),
      ).toThrow("CI_INTEGRATION_LEG_NOT_SUCCESS");
    },
  );
  it("rejects missing, duplicate and unmapped receipts", () => {
    for (const values of [
      receipts.slice(0, 1),
      [...receipts, receipts[0]],
      [...receipts, { ...receipts[0], job: "unknown" }],
    ])
      expect(() => validate(expected, values, { totalCount: 2, jobs })).toThrow(
        "CI_INTEGRATION_RECEIPT_INVENTORY",
      );
  });
  it.each([
    { candidateSha: "b".repeat(40) },
    { runId: "124" },
    { runAttempt: "1" },
    { jobId: "99" },
    { planVersion: 1 },
    { conclusion: "failure" },
  ])("rejects stale/wrong receipt %j", (change) => {
    expect(() =>
      validate(expected, [receipts[0], { ...receipts[1], ...change }], { totalCount: 2, jobs }),
    ).toThrow("CI_INTEGRATION_RECEIPT_IDENTITY");
  });
  it("rejects partial reruns, ambiguous jobs, wrong attempts and truncated listing", () => {
    for (const observation of [
      { totalCount: 2, jobs: jobs.slice(0, 1) },
      { totalCount: 3, jobs: [...jobs, { ...jobs[1], id: 99 }] },
      { totalCount: 2, jobs: [jobs[0], { ...jobs[1], run_attempt: 1 }] },
      { totalCount: 2, jobs: [jobs[0], { ...jobs[1], run_id: 124 }] },
      { totalCount: 2, jobs: [jobs[0], { ...jobs[1], status: "in_progress" }] },
    ])
      expect(() => validate(expected, receipts, observation)).toThrow(
        /CI_INTEGRATION_(?:API_INCOMPLETE|JOB_IDENTITY|LEG_NOT_SUCCESS)/u,
      );
  });
  it("allows an explicitly empty review inventory but refuses an empty qualification", () => {
    expect(
      validate({ ...current, jobs: [], jobNames: {}, qualification: false }, [], {
        totalCount: 0,
        jobs: [],
      }),
    ).toBeUndefined();
    expect(() =>
      validate({ ...current, jobs: [], jobNames: {}, qualification: true }, [], {
        totalCount: 0,
        jobs: [],
      }),
    ).toThrow("CI_INTEGRATION_EMPTY_QUALIFICATION");
  });
});

describe("reusable integration admission wiring", () => {
  const integration = readFileSync(
    new URL("../../.github/workflows/integration.yml", import.meta.url),
    "utf8",
  );
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  it("has one reusable caller joined by the sole required publisher", () => {
    expect(integration).toContain("workflow_call:");
    expect(integration).not.toMatch(/^ {2}pull_request:/mu);
    expect(ci).toContain("uses: ./.github/workflows/integration.yml");
    expect(ci.slice(ci.indexOf("  ci-required:"))).toMatch(/needs: \[scope, integration,/u);
    expect(integration).not.toContain("ci-required:");
    expect(integration).toContain("  completion:");
  });
  it("keeps event/fork routing inherited and qualification cancellation isolated", () => {
    expect(integration).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(integration).toContain("inputs.candidate_sha, github.run_id");
    expect(integration).toContain("github.event.pull_request.head.repo.fork || !vars.TN_RUNNER");
    expect(integration).not.toMatch(/(?:contents|actions|pull-requests): write/u);
    expect(integration).not.toContain("secrets: inherit");
    expect(integration).not.toMatch(/^ {6}(?:event|fork|runner|exempt):/mu);
  });
  it("pins all checkouts and artifact identities to the candidate and current attempt", () => {
    expect(integration).not.toContain("ref: ${{ github.event.pull_request.head.sha");
    expect(integration).not.toMatch(/name: [^\n]+github\.event\.pull_request\.head\.sha/u);
    expect(integration).toContain("github.run_attempt");
    expect(ci).toContain(
      "TN_CI_INTEGRATION_RECEIPT: ${{ needs.integration.outputs.coverage_receipt }}",
    );
  });
});

it("joins actual receipt writers, collector and protected verdict on the exact committed workflow", () => {
  const root = makeTempDirSync("ci-integration-chain-");
  const repository = path.resolve(import.meta.dirname, "../..");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git("init", "-q", "--initial-branch=develop");
    git("config", "user.name", "CPU fixture");
    git("config", "user.email", "ci@example.invalid");
    mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
    writeFileSync(
      path.join(root, ".github/workflows/integration.yml"),
      readFileSync(path.join(repository, ".github/workflows/integration.yml")),
    );
    writeFileSync(
      path.join(root, ".github/workflows/native-platforms.yml"),
      readFileSync(path.join(repository, ".github/workflows/native-platforms.yml")),
    );
    fixture.copyTemplateOwnership(root, repository);
    git("add", ".");
    git("commit", "-qm", "exact workflow candidate");
    const sha = git("rev-parse", "HEAD");
    const plan = changeScope.selectionPlan(
      "full",
      "qualification fixture",
      [],
      sha,
      true,
      0,
      "develop",
      true,
    );
    const evidence = fixture.integrationEvidence(root, path.join(root, "bin"), plan);
    const output = path.join(root, "output");
    writeFileSync(output, "");
    const env = {
      ...process.env,
      ...evidence.env,
      TN_CI_PLAN: JSON.stringify(plan),
      TN_CI_EVENT: "merge_group",
      TN_CI_BASE_REF: "develop",
      TN_CI_CANDIDATE_SHA: sha,
      GITHUB_WORKSPACE: root,
      GITHUB_OUTPUT: output,
      TN_CI_JOB_RESULT: "success",
    };
    const run = (file: string, args: string[], overrides = {}) =>
      spawnSync(process.execPath, [path.join(repository, "scripts", file), ...args], {
        cwd: root,
        encoding: "utf8",
        env: { ...env, ...overrides },
      });
    for (const receipt of evidence.receipts) {
      const result = run("ci-integration-receipts.mjs", ["--write"], { GITHUB_JOB: receipt.job });
      expect(result.status, result.stderr).toBe(0);
    }
    const collect = () =>
      run("ci-integration-receipts.mjs", [
        "--collect",
        path.join(root, "artifacts/ci-integration-receipts"),
      ]);
    const collected = collect();
    expect(collected.status, collected.stderr).toBe(0);
    const summary = readFileSync(output, "utf8")
      .trim()
      .replace(/^coverage_receipt=/u, "");
    const needs = {
      scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
      ...Object.fromEntries(Object.keys(plan.jobs).map((name) => [name, { result: "success" }])),
    };
    const verdict = (receipt: string) =>
      run("ci-required.mjs", [], {
        TN_CI_NEEDS: JSON.stringify(needs),
        TN_CI_BASE_SHA: sha,
        TN_CI_HEAD_SHA: sha,
        TN_CI_INTEGRATION_RECEIPT: receipt,
      });
    const green = verdict(summary);
    expect(green.status, green.stderr).toBe(0);
    const wrong = JSON.parse(summary);
    wrong.receipts[0].candidateSha = "b".repeat(40);
    const rejected = verdict(JSON.stringify(wrong));
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("CI_INTEGRATION_RECEIPT_IDENTITY");
    rmSync(
      path.join(root, "artifacts/ci-integration-receipts", `${evidence.receipts[0].job}.json`),
    );
    const missing = collect();
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("CI_INTEGRATION_RECEIPT_INVENTORY");
    writeFileSync(
      evidence.apiFile,
      JSON.stringify([
        {
          total_count: evidence.jobs.length,
          jobs: evidence.jobs.map((job: { id: number }) => ({ ...job, run_attempt: 1 })),
        },
      ]),
    );
    const stale = verdict(summary);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain("CI_INTEGRATION_JOB_IDENTITY");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
