import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const {
  allFinished,
  commentBody,
  firstRedJob,
  isInfraFailure,
  janitorSignatures,
  jobLog,
  promotionCommentBody,
  queuePullNumber,
  showsEveryRed,
} = await import(new URL("../ci-queue-watch.mjs", import.meta.url).href);
const script = new URL("../ci-queue-watch.mjs", import.meta.url).pathname;

const job = (name: string, conclusion: string | null, completed = "2026-10-23T00:00:00Z") => ({
  id: name.length * 1000 + (conclusion?.length ?? 0),
  name,
  steps: [
    { name: "Set up job", conclusion: "success" },
    { name: "Run", conclusion },
  ],
  conclusion,
  status: conclusion === null ? "in_progress" : "completed",
  completed_at: conclusion === null ? null : completed,
  html_url: `https://example.invalid/jobs/${name}`,
});

/**
 * Runs the watcher against a stub `gh` and returns what it called, in order, plus the exit status.
 * `options.baseRef` is `github.base_ref`: `main` is a promotion board (PRD-901).
 */
function runWatcher(
  jobs: unknown[],
  log: string,
  queueRef = `refs/heads/gh-readonly-queue/develop/pr-541-${"a".repeat(40)}`,
  options: { baseRef?: string; failComment?: boolean } = {},
) {
  const root = makeTempDirSync("threenative-queue-watch-");
  const bin = path.join(root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(root, "jobs.json"), JSON.stringify([{ jobs }]));
  writeFileSync(path.join(root, "job.log"), log);
  writeFileSync(
    path.join(bin, "gh"),
    `#!/bin/sh
echo "$*" >> "${root}/calls.log"
case "$*" in
*actions/runs/99/jobs*) cat "${root}/jobs.json" ;;
*actions/jobs/*/logs*) cat "${root}/job.log" ;;
*issues/*/comments*) if [ "$TN_STUB_FAIL_COMMENT" = "1" ]; then exit 1; fi ;;
*) ;;
esac
`,
  );
  chmodSync(path.join(bin, "gh"), 0o755);
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "o/r",
      GITHUB_RUN_ID: "99",
      TN_CI_QUEUE_REF: queueRef,
      TN_CI_BASE_REF: options.baseRef ?? "",
      TN_CI_PULL_NUMBER: options.baseRef === "main" ? "689" : "",
      TN_QUEUE_WATCH_SECONDS: "0",
      TN_STUB_FAIL_COMMENT: options.failComment ? "1" : "0",
    },
  });
  return { calls: readFileSync(path.join(root, "calls.log"), "utf8"), status: result.status };
}

/** The calls of a run the watcher had to survive. */
function watch(
  jobs: unknown[],
  log: string,
  queueRef = `refs/heads/gh-readonly-queue/develop/pr-541-${"a".repeat(40)}`,
  options: { baseRef?: string } = {},
) {
  const result = runWatcher(jobs, log, queueRef, options);
  expect(result.status).toBe(0);
  return result.calls;
}

describe("PRD-782 job logs survive gh's escape-sequence guard", () => {
  const LOG = "ERR_CONNECTION_REFUSED while waiting for the dev server";
  // gh 2.102 exits 1 on a log with escape sequences unless told; an older gh rejects the flag.
  const fakeGh = (kind: "guarded" | "old") => {
    const bin = path.join(makeTempDirSync("tn-gh-guard-"), "bin");
    mkdirSync(bin, { recursive: true });
    const guarded = kind === "guarded";
    writeFileSync(
      path.join(bin, "gh"),
      `#!/bin/sh
case "$*" in
  *--allow-escape-sequences*) ${guarded ? `echo "${LOG}"` : "exit 1"} ;;
  *) ${guarded ? "exit 1" : `echo "${LOG}"`} ;;
esac
`,
    );
    chmodSync(path.join(bin, "gh"), 0o755);
    return bin;
  };
  const janitorLine = () => {
    const janitor = readFileSync(
      new URL("../../.github/workflows/ci-janitor.yml", import.meta.url),
      "utf8",
    );
    const line = janitor.split("\n").find((text) => text.includes('grep -qE "$FLAKE"'));
    if (line === undefined) throw new Error("the janitor has no flake check");
    return line.trim();
  };

  it.each(["guarded", "old"] as const)("the watcher reads a log from a %s gh", (kind) => {
    const before = process.env.PATH;
    process.env.PATH = `${fakeGh(kind)}:${before}`;
    try {
      expect(jobLog("o/r", 7)).toContain(LOG);
    } finally {
      process.env.PATH = before;
    }
  });

  it.each(["guarded", "old"] as const)("the janitor reads a log from a %s gh", (kind) => {
    const result = spawnSync(
      "sh",
      ["-c", `id=7\n${janitorLine()}\necho miss\nelse\necho hit\nfi`],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fakeGh(kind)}:${process.env.PATH}`,
          FLAKE: "ERR_CONNECTION_REFUSED",
          GITHUB_REPOSITORY: "o/r",
        },
      },
    );
    expect(result.stdout.trim(), result.stderr).toBe("hit");
  });
});

describe("PRD-731 queue watcher", () => {
  it("names the earliest red job and skips the aggregates that echo it", () => {
    const jobs = [
      job("ci-required", "failure", "2026-10-23T00:09:00Z"),
      job("test-unit (2/4)", "failure", "2026-10-23T00:05:00Z"),
      job("typecheck", "failure", "2026-10-23T00:03:00Z"),
      job("lint", "success"),
      job("golden-path", "failure", "2026-10-23T00:01:00Z"),
    ];
    expect(firstRedJob(jobs).name).toBe("typecheck");
    expect(firstRedJob([job("lint", "success"), job("build", null)])).toBeNull();
    expect(firstRedJob([job("ci-required", "failure")])).toBeNull();
  });

  it("reads the pull request from the queue ref, and nothing else", () => {
    const sha = "a".repeat(40);
    expect(queuePullNumber(`refs/heads/gh-readonly-queue/develop/pr-541-${sha}`)).toBe("541");
    expect(queuePullNumber(`gh-readonly-queue/develop/pr-7-${sha}`)).toBe("7");
    expect(queuePullNumber("refs/heads/feat/pr-7-x")).toBeNull();
    expect(queuePullNumber(undefined)).toBeNull();
  });

  it("finishes when every other job has", () => {
    expect(allFinished([job("a", "success"), job("queue-watch", null)])).toBe(true);
    expect(allFinished([job("a", "success"), job("b", null)])).toBe(false);
  });

  it("states the job, the run and the next step in the comment", () => {
    const body = commentBody({
      job: job("typecheck", "failure"),
      runId: 99,
      repository: "o/r",
    });
    expect(body).toContain("`typecheck`");
    expect(body).toContain("https://example.invalid/jobs/typecheck");
    expect(body).toContain("https://github.com/o/r/actions/runs/99");
    expect(body).toContain("Fix, push, re-enqueue.");
  });

  it("comments on the pull request first, then cancels the run, on a real test red", () => {
    const log = watch(
      [job("lint", "success"), job("typecheck", "failure"), job("test", null)],
      "FAIL scripts/__tests__/x.spec.ts\nAssertionError: expected 1 to be 2",
    );
    const comment = log.indexOf("repos/o/r/issues/541/comments");
    const cancel = log.indexOf("run cancel 99 --repo o/r");
    expect(comment).toBeGreaterThan(0);
    expect(cancel).toBeGreaterThan(comment);
    expect(log.slice(comment, cancel)).toContain("typecheck");
  });

  it.each([
    [
      "a runner shutdown",
      "The runner has received a shutdown signal. This can happen when the runner service is stopped",
    ],
    ["a lost runner", "The self-hosted runner: tn-local-03 lost communication with the server."],
    ["a janitor-known flake", "ERR_CONNECTION_REFUSED while waiting for the dev server"],
  ])("leaves %s to the janitor: no comment, no cancel", (_name, text) => {
    const log = watch([job("scope", "success"), job("Change scope", "failure")], text);
    expect(log).not.toContain("issues/541/comments");
    expect(log).not.toContain("run cancel");
  });

  it("cancels a full board with no comment when no queue ref names a pull request", () => {
    const log = watch([job("typecheck", "failure"), job("test", null)], "AssertionError", "");
    expect(log).toContain("run cancel 99 --repo o/r");
    expect(log).not.toContain("/comments");
  });

  it("does not stop for a job that cannot fail the board", () => {
    const ios = job(
      "native-platforms / iOS simulator runtime and no-Xcode consumer handoff",
      "failure",
    );
    expect(firstRedJob([ios, job("test", null)])).toBeNull();
  });

  it("does not stop on a log it could not read", () => {
    expect(isInfraFailure(job("typecheck", "failure"), "", "shutdown signal")).toBe(true);
  });

  it("leaves a job that ran no step to the janitor", () => {
    const dead = { ...job("test-unit (1/4)", "failure"), steps: [] };
    const log = watch([job("lint", "success"), dead], "");
    expect(log).not.toContain("issues/541/comments");
    expect(log).not.toContain("run cancel");
  });

  it("reads its infra signatures from the janitor, the same list the retry uses", () => {
    const janitor = readFileSync(
      path.join(import.meta.dirname, "../../.github/workflows/ci-janitor.yml"),
      "utf8",
    );
    const signatures = janitorSignatures(janitor);
    for (const text of [
      "runner has received a shutdown signal",
      "lost communication with the server",
    ]) {
      expect(isInfraFailure(job("a", "failure"), text, signatures)).toBe(true);
    }
    expect(isInfraFailure(job("a", "failure"), "AssertionError", signatures)).toBe(false);
    // Nothing readable means every red is a real one, never a silent pass.
    expect(isInfraFailure(job("a", "failure"), "runner has received a shutdown", "")).toBe(false);
  });

  it("stops with a usage error when the queue ref names no pull request", () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "o/r",
        GITHUB_RUN_ID: "1",
        TN_CI_QUEUE_REF: "main",
      },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("CI_QUEUE_WATCH_INPUT");
  });
});

// PRD-901: release 0.3.16 spent 22 promotion boards and 5,419 machine minutes on rounds that each
// showed one red leg. A pull request into `main` is the one board that must show every leg at once.
describe("PRD-901 a promotion board shows every red in one round", () => {
  const REDS = [
    "budgets",
    "test-unit (1/4)",
    "native-platforms / Windows desktop core",
    "template-engine-cost (racing)",
  ];
  const board = () => [
    job("scope", "success"),
    ...REDS.map((name) => job(name, "failure")),
    job("test", "success"),
  ];

  it("names every red leg and cancels nothing", () => {
    const result = runWatcher(board(), "AssertionError", "", { baseRef: "main" });
    expect(result.status).toBe(0);
    const calls = result.calls;
    expect(calls).not.toContain("run cancel");
    // One comment, and it carries every leg: the round is the unit a fix set answers to.
    expect(calls.match(/issues\/689\/comments/gu)).toHaveLength(1);
    for (const name of REDS) expect(calls).toContain(name);
  });

  it("names only the reds, not the legs that passed or the aggregates that echo them", () => {
    const calls = runWatcher(
      [...board(), job("ci-required", "failure"), job("typecheck", "success")],
      "AssertionError",
      "",
      { baseRef: "main" },
    ).calls;
    expect(calls).toContain("budgets");
    expect(calls).not.toContain("(failure)\n- [ci-required]");
    expect(calls).not.toContain("- [typecheck]");
  });

  it("still comments when one leg timed out and another failed", () => {
    // A leg killed by `timeout-minutes` concludes `cancelled` inside a run that concluded
    // `failure` (ci.yml run 43858835585: `template-engine-cost (rain)`). Reading that as a
    // supersede would silence a red board, which is the one thing AC-4 forbids.
    const result = runWatcher(
      [job("budgets", "failure"), job("test", "cancelled"), job("scope", "success")],
      "AssertionError",
      "",
      { baseRef: "main" },
    );
    expect(result.status).toBe(0);
    expect(result.calls).toContain("issues/689/comments");
    expect(result.calls).toContain("`budgets`");
    // A cancelled leg is not a red one: the board's own checks list names it, and counting it here
    // would cancel the run at a leg that failed nothing.
    expect(result.calls).not.toContain("`test`");
    expect(result.calls).not.toContain("run cancel");
  });

  it("comments nothing when every leg concluded green", () => {
    const calls = runWatcher([job("scope", "success"), job("budgets", "success")], "", "", {
      baseRef: "main",
    }).calls;
    expect(calls).not.toContain("/comments");
    expect(calls).not.toContain("run cancel");
  });

  it("does not chase a leg that cannot fail the board", () => {
    const calls = runWatcher(
      [
        job("native-platforms / iOS simulator runtime and no-Xcode consumer handoff", "failure"),
        job("budgets", "success"),
      ],
      "",
      "",
      { baseRef: "main" },
    ).calls;
    expect(calls).not.toContain("/comments");
  });

  it("fails the job when it could not write the comment", () => {
    // A promotion board that stayed red and told nobody is the failure this cannot hide.
    const result = runWatcher(board(), "AssertionError", "", {
      baseRef: "main",
      failComment: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.calls).toContain("issues/689/comments");
  });

  it.each([
    ["develop pull request", "", "develop"],
    ["merge group", `refs/heads/gh-readonly-queue/develop/pr-541-${"a".repeat(40)}`, ""],
  ])("still cancels at the first red on a %s", (_what, queueRef, baseRef) => {
    const calls = watch(
      [job("budgets", "failure"), job("test", null)],
      "AssertionError",
      queueRef,
      {
        baseRef,
      },
    );
    expect(calls).toContain("run cancel 99 --repo o/r");
  });

  it("reads `main` and nothing else as a promotion", () => {
    expect(showsEveryRed("main")).toBe(true);
    expect(showsEveryRed("develop")).toBe(false);
    expect(showsEveryRed("")).toBe(false);
    expect(showsEveryRed(undefined)).toBe(false);
  });

  it("states the round, every leg and the run in the comment", () => {
    const body = promotionCommentBody({
      jobs: [job("budgets", "failure"), job("test-unit (1/4)", "failure")],
      runId: 99,
      repository: "o/r",
    });
    expect(body).toContain("`budgets`");
    expect(body).toContain("`test-unit (1/4)`");
    expect(body).toContain("https://github.com/o/r/actions/runs/99");
    expect(body).not.toContain("cancelled");
  });
});
