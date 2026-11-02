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
  queuePullNumber,
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

  /** Runs the watcher against a stub `gh` and returns what it called, in order. */
  function watch(
    jobs: unknown[],
    log: string,
    queueRef = `refs/heads/gh-readonly-queue/develop/pr-541-${"a".repeat(40)}`,
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
        TN_QUEUE_WATCH_SECONDS: "0",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(path.join(root, "calls.log"), "utf8");
  }

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
