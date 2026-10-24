import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const { selectionPlan } = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);

const repo = path.resolve(import.meta.dirname, "../..");
const RUN_ID = 42;
const SELF_RUN_ID = 1;
const PR = 7;

/**
 * PRD-730. The merge queue may skip the board for one case only: the merge-group commit has the
 * tree of the pull request it names, and that pull request's head has a green, full run. Every
 * other case runs the board, and an API that cannot answer is one of them.
 */
interface IFixture {
  root: string;
  /** The develop tip the queue builds on. */
  base: string;
  /** The pull request head. */
  head: string;
  /** The candidate the pull-request run tested: a merge of base and head. */
  merged: string;
  /** The queue commit: the same tree as the head, one parent. */
  queue: string;
  /** A queue commit whose tree has one more file than the head. */
  queueMoved: string;
  queueRef: string;
}

function git(cwd: string, args: string[], input?: string) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    env: {
      PATH: process.env.PATH,
      GIT_AUTHOR_NAME: "queue reuse fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "queue reuse fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/**
 * `sourceBaseHasRuntime` makes the pull request's own diff prose only (its base already held the
 * runtime file), while the queue's diff from an older base is not: the shape of a narrowed source.
 */
function fixture({ sourceBaseHasRuntime = false } = {}): IFixture {
  const root = makeTempDirSync("threenative-queue-reuse-");
  const work = path.join(root, "work");
  const origin = path.join(root, "origin.git");
  mkdirSync(work, { recursive: true });
  git(root, ["init", "--quiet", "--bare", origin]);
  git(work, ["init", "--quiet", "--initial-branch", "develop"]);
  git(work, ["remote", "add", "origin", origin]);
  const commit = (files: Record<string, string>, message: string) => {
    for (const [relative, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(work, relative)), { recursive: true });
      writeFileSync(path.join(work, relative), body);
    }
    git(work, ["add", "-A"]);
    git(work, ["commit", "--quiet", "-m", message]);
    return git(work, ["rev-parse", "HEAD"]);
  };
  const base = commit({ "seed.txt": "seed\n" }, "queue base");
  const pullBase = sourceBaseHasRuntime
    ? commit({ "src/runtime.ts": "export {};\n" }, "pull request base")
    : base;
  const head = commit(
    sourceBaseHasRuntime ? { "README.md": "# fixture\n" } : { "src/runtime.ts": "export {};\n" },
    "pull request head",
  );
  const tree = git(work, ["rev-parse", `${head}^{tree}`]);
  const commitTree = (treeSha: string, parents: string[]) =>
    git(work, ["commit-tree", treeSha, ...parents.flatMap((parent) => ["-p", parent]), "-m", "c"]);
  const merged = commitTree(tree, [pullBase, head]);
  const queue = commitTree(tree, [base]);
  const moved = commit({ "src/other.ts": "export {};\n" }, "one more file");
  const queueMoved = commitTree(git(work, ["rev-parse", `${moved}^{tree}`]), [base]);
  git(work, ["push", "--quiet", "origin", `${head}:refs/pull/${PR}/head`]);
  git(work, ["checkout", "--quiet", "--detach", queue]);
  return {
    root: work,
    base,
    head,
    merged,
    queue,
    queueMoved,
    queueRef: `refs/heads/gh-readonly-queue/develop/pr-${PR}-${base}`,
  };
}

interface IStub {
  /** The source run's event. A pull-request run is the thin review lane, so a dispatch is the default. */
  event?: "pull_request" | "workflow_dispatch";
  conclusion?: string;
  status?: string;
  /** Board jobs the source run never ran. */
  missing?: string[];
  verdict?: string;
  /** Extra, newer runs of the same head. */
  newer?: { conclusion: string; status?: string }[];
  /** The sha the source run's receipts name as its candidate. */
  candidate?: string;
  fail?: boolean;
}

function boardJobs(base: string): string[] {
  const plan = selectionPlan("full", "fixture", ["src/runtime.ts"], base, true, 0, "develop", true);
  const names: string[] = ["Change scope"];
  for (const [name, job] of Object.entries(plan.jobs as Record<string, { required: boolean }>)) {
    if (!job.required) continue;
    if (name === "test-unit") {
      for (const shard of plan.unitMatrix.shard) names.push(`test-unit (${shard})`);
    } else if (name === "template-nonvisual") {
      for (const t of plan.templateMatrix.template) names.push(`template-nonvisual (${t})`);
    } else if (name === "golden-path-template") {
      for (const t of plan.goldenMatrix.template) names.push(`golden-path-template (${t})`);
    } else names.push(name === "integration" ? "integration / fog-native" : name);
  }
  return names;
}

function stubApi(f: IFixture, stub: IStub = {}): void {
  const dir = path.join(f.root, "..", "bin");
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown) =>
    writeFileSync(path.join(f.root, "..", name), JSON.stringify(value));
  const run = (id: number, number: number, conclusion: string, status = "completed") => ({
    id,
    run_number: number,
    run_attempt: 1,
    event: stub.event ?? "workflow_dispatch",
    head_sha: f.head,
    head_branch: "feat/x",
    status,
    conclusion,
  });
  write("runs.json", {
    workflow_runs: [
      run(RUN_ID, 5, stub.conclusion ?? "success", stub.status),
      ...(stub.newer ?? []).map((n, index) =>
        run(RUN_ID + 1 + index, 6 + index, n.conclusion, n.status),
      ),
    ],
  });
  const jobs = [
    ...boardJobs(f.base).filter((name) => !(stub.missing ?? []).includes(name)),
    "ci-required",
    "run-summary",
  ].map((name) => ({
    name,
    conclusion: name === "ci-required" ? (stub.verdict ?? "success") : "success",
    labels: ["ubuntu-latest"],
    runner_name: "GitHub Actions 1",
  }));
  write("jobs.json", { total_count: jobs.length, jobs });
  const tested = stub.event === "pull_request" ? f.merged : f.head;
  const candidate = stub.candidate === "queue" ? f.queue : (stub.candidate ?? tested);
  write("artifacts.json", {
    total_count: 2,
    artifacts: [
      { name: `ci-integration-receipt-${RUN_ID}-1-${candidate}-fog-native` },
      { name: `ci-integration-receipt-${RUN_ID}-1-${candidate}-other` },
      { name: "unrelated-artifact" },
    ],
  });
  writeFileSync(
    path.join(dir, "gh"),
    `#!/bin/sh
if [ "${stub.fail === true}" = true ]; then echo "gh: HTTP 403: Resource not accessible" >&2; exit 1; fi
case "$*" in
  *workflows/ci.yml/runs*) cat "${f.root}/../runs.json" ;;
  */runs/${RUN_ID}/artifacts*) cat "${f.root}/../artifacts.json" ;;
  */runs/${RUN_ID}/jobs*) cat "${f.root}/../jobs.json" ;;
  *) echo "gh: HTTP 404: $*" >&2; exit 1 ;;
esac
`,
  );
  chmodSync(path.join(dir, "gh"), 0o755);
}

function env(f: IFixture, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${path.join(f.root, "..", "bin")}:${process.env.PATH}`,
    GITHUB_ACTIONS: "true",
    GITHUB_REPOSITORY: "three-native/fixture",
    GITHUB_RUN_ID: String(SELF_RUN_ID),
    ...extra,
  };
}

function classify(
  f: IFixture,
  { event = "merge_group", head = f.queue, queueRef = f.queueRef, fail = false } = {},
) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(repo, "scripts/ci-change-scope.mjs"),
      "--root",
      f.root,
      "--base",
      f.base,
      "--head",
      head,
      "--candidate-sha",
      head,
      "--target",
      "develop",
      "--event-name",
      event,
      "--queue-ref",
      queueRef,
      "--format",
      "json",
    ],
    { encoding: "utf8", env: env(f) },
  );
  expect(result.status, result.stderr).toBe(0);
  void fail;
  return JSON.parse(result.stdout) as Record<string, unknown> & { reason: string };
}

function verdict(f: IFixture, plan: Record<string, unknown>) {
  const jobs = plan.jobs as Record<string, unknown>;
  const needs = {
    scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
    ...Object.fromEntries(Object.keys(jobs).map((name) => [name, { result: "skipped" }])),
  };
  return spawnSync(process.execPath, [path.join(repo, "scripts/ci-required.mjs")], {
    cwd: f.root,
    encoding: "utf8",
    env: env(f, {
      TN_CI_NEEDS: JSON.stringify(needs),
      TN_CI_EVENT: "merge_group",
      TN_CI_BASE_SHA: f.base,
      TN_CI_HEAD_SHA: f.queue,
      TN_CI_BASE_REF: "refs/heads/develop",
      TN_CI_QUEUE_REF: f.queueRef,
    }),
  });
}

describe("PRD-730 the merge queue reuses a green run of the same tree", () => {
  it("reuses the run when the queue tree is the head tree and the head run is green", () => {
    const f = fixture();
    stubApi(f);
    const plan = classify(f);
    expect(plan).toMatchObject({ selection: "reused", reusedRunId: RUN_ID, candidateSha: f.queue });
    const tree = git(f.root, ["rev-parse", `${f.queue}^{tree}`]);
    expect(plan.reason).toContain(tree);
    const passed = verdict(f, plan);
    expect(passed.status, passed.stderr).toBe(0);
    expect(passed.stdout).toContain(`CI run \`${RUN_ID}\``);
    expect(passed.stdout).toContain(tree);
    const receipt = JSON.parse(
      readFileSync(path.join(f.root, "artifacts/ci-queue-reuse/receipt.json"), "utf8"),
    );
    expect(receipt).toMatchObject({ runId: RUN_ID, tree, candidateSha: f.queue, headSha: f.head });
  });

  it("runs the board when the queue tree differs from the head tree", () => {
    const f = fixture();
    stubApi(f);
    const plan = classify(f, { head: f.queueMoved });
    expect(plan).toMatchObject({ selection: "full", reusedRunId: 0 });
    expect(plan.reason).toContain("tree reuse unavailable");
    expect(plan.reason).toContain("tree differs");
  });

  it.each([
    ["red", { conclusion: "failure" }],
    ["cancelled", { conclusion: "cancelled" }],
    ["still running", { conclusion: "", status: "in_progress" }],
    ["superseded by a newer red run", { newer: [{ conclusion: "failure" }] }],
    ["red in ci-required", { verdict: "failure" }],
    ["missing a matrix leg", { missing: ["template-nonvisual (rain)"] }],
    ["missing a board job", { missing: ["golden-path"] }],
    ["from a candidate that is not the head merged with its base", { candidate: "queue" }],
    ["from a candidate of another tree", { candidate: "c".repeat(40) }],
  ] as [string, IStub][])("runs the board when the earlier run is %s", (_name, stub) => {
    const f = fixture();
    stubApi(f, stub);
    const plan = classify(f);
    expect(plan).toMatchObject({ selection: "full", reusedRunId: 0 });
    expect(plan.reason).toContain("tree reuse unavailable");
  });

  it("runs the board when the earlier pull-request run was the thin review lane", () => {
    // PRD-731: a green pull-request run proves the review lane only, however green it is.
    const f = fixture();
    stubApi(f, { event: "pull_request" });
    const plan = classify(f);
    expect(plan).toMatchObject({ selection: "full", reusedRunId: 0 });
    expect(plan.reason).toContain("not a full board (review)");
  });

  it("runs the board when the earlier run was narrowed", () => {
    const f = fixture({ sourceBaseHasRuntime: true });
    stubApi(f, { event: "pull_request" });
    const plan = classify(f);
    expect(plan).toMatchObject({ selection: "full", reusedRunId: 0 });
    expect(plan.reason).toContain("not a full board");
  });

  it("runs the board when the Actions API cannot be read", () => {
    const f = fixture();
    stubApi(f, { fail: true });
    const plan = classify(f);
    expect(plan).toMatchObject({ selection: "full", reusedRunId: 0 });
    expect(plan.reason).toContain("HTTP 403");
  });

  it("runs the board when the queue ref names no pull request", () => {
    const f = fixture();
    stubApi(f);
    const plan = classify(f, { queueRef: "refs/heads/somewhere/else" });
    expect(plan).toMatchObject({ selection: "full", reusedRunId: 0 });
  });

  it.each(["pull_request", "push", "workflow_dispatch"])("never reuses on %s", (event) => {
    const f = fixture();
    stubApi(f);
    const plan = classify(f, { event });
    // A pull request earns the thin lane (PRD-731); the other events keep the whole board.
    expect(plan).toMatchObject({
      selection: event === "pull_request" ? "review" : "full",
      reusedRunId: 0,
    });
    expect(plan.reason).not.toContain("queue");
  });

  it("makes ci-required fail when the plan cites a run the queue rule does not confirm", () => {
    const f = fixture();
    stubApi(f);
    const plan = classify(f);
    const forged = selectionPlan(
      "reused",
      "forged",
      plan.files,
      f.queue,
      plan.native,
      RUN_ID + 50,
      "develop",
    );
    const failed = verdict(f, forged);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("CI_REQUIRED_QUEUE_REUSE");
    expect(existsSync(path.join(f.root, "artifacts/ci-queue-reuse/receipt.json"))).toBe(false);
    stubApi(f, { fail: true });
    const unreadable = verdict(f, plan);
    expect(unreadable.status).toBe(1);
    expect(unreadable.stderr).toContain("CI_REQUIRED_QUEUE_REUSE");
  });
});
