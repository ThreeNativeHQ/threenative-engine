#!/usr/bin/env node
// PRD-731. A merge-group run is the only place the full board runs for an ordinary change, so its
// first red job names the cause. This watcher tells the pull request which job failed and cancels
// the rest, so a red costs minutes of runners and the author does not read a wall of cancelled
// checks. The failed job keeps its own conclusion: only jobs still in flight are cancelled.
// PRD-782: a full board on a pull request or a manual run stops the same way, with no comment.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { gh } from "./lib/gh.mjs";

// Aggregates only echo another job's failure; the watcher is not evidence of anything.
const ECHOES = new Set(["ci-required", "golden-path", "run-summary", "queue-watch"]);
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{40}$/u;
const RED = new Set(["failure", "timed_out", "startup_failure"]);
// `continue-on-error` in native-platforms.yml: its red does not fail the board, so it stops nothing.
const NON_BLOCKING = /^native-platforms \/ iOS simulator/u;

/** The pull request a queue ref names, or null. */
export function queuePullNumber(queueRef) {
  return QUEUE_REF.exec(queueRef ?? "")?.[1] ?? null;
}

/**
 * The janitor's own list of environmental signatures (`FLAKE:` in ci-janitor.yml), so the watcher
 * and the retry can never disagree about what an infra failure is. Empty when it cannot be read,
 * which makes every red a real one.
 */
export function janitorSignatures(workflow) {
  return /^\s+FLAKE: (.+)$/mu.exec(workflow)?.[1]?.trim() ?? "";
}

/**
 * An infra failure leaves the run to the janitor, which reruns the failed jobs once and skips a
 * cancelled run: a job that ran no step (the runner died or never started), or a log carrying one
 * of the janitor's signatures (a runner shutdown, a lost runner, a known flake).
 */
export function isInfraFailure(job, log, signatures) {
  const ran = (job?.steps ?? []).some((step) => step?.conclusion && step.conclusion !== "skipped");
  if (!ran) return true;
  // An unread log proves nothing. A wrong stop costs more than a late one.
  if (log === "") return true;
  return signatures !== "" && new RegExp(signatures, "u").test(log);
}

/** The earliest-completed red job that is not an aggregate, or null while nothing is red. */
export function firstRedJob(jobs, ignore = new Set()) {
  const red = jobs.filter(
    (job) =>
      RED.has(job?.conclusion) &&
      !ECHOES.has(job?.name) &&
      !NON_BLOCKING.test(job?.name ?? "") &&
      !ignore.has(job?.id),
  );
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

/**
 * gh 2.102 exits 1 on a log with terminal escape sequences unless told to allow them, and an older
 * gh rejects that flag. An empty read would turn every infrastructure failure into a real red.
 */
export function jobLog(repository, jobId) {
  const logs = `repos/${repository}/actions/jobs/${jobId}/logs`;
  for (const args of [
    ["api", "--allow-escape-sequences", logs],
    ["api", logs],
  ]) {
    try {
      return gh(args);
    } catch {
      // Try the next form. Both failing leaves no log to read.
    }
  }
  return "";
}

function runJobs(repository, runId) {
  const pages = JSON.parse(
    gh([
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=10`,
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
  // Only a merge group has a queue ref and a pull request to tell.
  if ((number === null && TN_CI_QUEUE_REF) || !repository || !runId) {
    console.error("CI_QUEUE_WATCH_INPUT: the queue ref, repository or run id is missing");
    process.exit(2);
  }
  const signatures = janitorSignatures(
    readFileSync(new URL("../.github/workflows/ci-janitor.yml", import.meta.url), "utf8"),
  );
  const infra = new Set();
  for (;;) {
    const jobs = runJobs(repository, runId);
    const red = firstRedJob(jobs, infra);
    if (red !== null && isInfraFailure(red, jobLog(repository, red.id), signatures)) {
      // The janitor reruns this job once; cancelling here would end the run as cancelled and skip it.
      console.log(`red job ${red.name} is an infra failure: left to the janitor`);
      infra.add(red.id);
    } else if (red !== null) {
      // The comment first: a cancel that fails must not hide the cause.
      if (number !== null) {
        gh([
          "api",
          `repos/${repository}/issues/${number}/comments`,
          "-f",
          `body=${commentBody({ job: red, runId, repository })}`,
        ]);
      }
      gh(["run", "cancel", runId, "--repo", repository]);
      console.log(`first red job ${red.name}: cancelled run ${runId}`);
      break;
    }
    if (allFinished(jobs)) break;
    sleep(interval);
  }
}
