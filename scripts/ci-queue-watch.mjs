#!/usr/bin/env node
// PRD-731. A merge-group run is the only place the full board runs for an ordinary change, so its
// first red job names the cause. This watcher tells the pull request which job failed and cancels
// the rest, so a red costs minutes of runners and the author does not read a wall of cancelled
// checks. The failed job keeps its own conclusion: only jobs still in flight are cancelled.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Aggregates only echo another job's failure; the watcher is not evidence of anything.
const ECHOES = new Set(["ci-required", "golden-path", "run-summary", "queue-watch"]);
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{40}$/u;
const RED = new Set(["failure", "timed_out", "startup_failure"]);

/** The pull request a queue ref names, or null. */
export function queuePullNumber(queueRef) {
  return QUEUE_REF.exec(queueRef ?? "")?.[1] ?? null;
}

/** The earliest-completed red job that is not an aggregate, or null while nothing is red. */
export function firstRedJob(jobs) {
  const red = jobs.filter((job) => RED.has(job?.conclusion) && !ECHOES.has(job?.name));
  red.sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
  return red[0] ?? null;
}

/** True once every job other than the watcher has finished. */
export function allFinished(jobs) {
  return jobs.every((job) => job?.name === "queue-watch" || job?.status === "completed");
}

export function commentBody({ job, runId, repository }) {
  const run = `https://github.com/${repository}/actions/runs/${runId}`;
  return [
    `The merge queue stopped on \`${job.name}\` (${job.conclusion}).`,
    "",
    `- First failing job: [${job.name}](${job.html_url ?? run})`,
    `- Merge-group run: [${runId}](${run}) (the rest of its jobs were cancelled)`,
    "",
    "Fix, push, re-enqueue.",
  ].join("\n");
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

function runJobs(repository, runId) {
  const pages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
    ]),
  );
  return pages.flatMap((page) => page.jobs ?? []);
}

function sleep(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, TN_CI_QUEUE_REF } = process.env;
  const number = queuePullNumber(TN_CI_QUEUE_REF);
  const interval = Number(process.env.TN_QUEUE_WATCH_SECONDS ?? 30);
  if (number === null || !repository || !runId) {
    console.error("CI_QUEUE_WATCH_INPUT: the queue ref, repository or run id is missing");
    process.exit(2);
  }
  for (;;) {
    const jobs = runJobs(repository, runId);
    const red = firstRedJob(jobs);
    if (red !== null) {
      // The comment first: a cancel that fails must not hide the cause.
      gh([
        "api",
        `repos/${repository}/issues/${number}/comments`,
        "-f",
        `body=${commentBody({ job: red, runId, repository })}`,
      ]);
      gh(["run", "cancel", runId, "--repo", repository]);
      console.log(`first red job ${red.name}: commented on #${number} and cancelled run ${runId}`);
      break;
    }
    if (allFinished(jobs)) break;
    sleep(interval);
  }
}
