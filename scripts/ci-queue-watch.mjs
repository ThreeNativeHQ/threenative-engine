#!/usr/bin/env node
// PRD-731. A merge-group run is the only place the full board runs for an ordinary change, so its
// first red job names the cause. This watcher tells the pull request which job failed and cancels
// the rest, so a red costs minutes of runners and the author does not read a wall of cancelled
// checks. The failed job keeps its own conclusion: only jobs still in flight are cancelled.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Aggregates only echo another job's failure; the watcher is not evidence of anything.
const ECHOES = new Set(["ci-required", "golden-path", "run-summary", "queue-watch"]);
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{40}$/u;
const RED = new Set(["failure", "timed_out", "startup_failure"]);

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
  return signatures !== "" && new RegExp(signatures, "u").test(log);
}

/** The earliest-completed red job that is not an aggregate, or null while nothing is red. */
export function firstRedJob(jobs, ignore = new Set()) {
  const red = jobs.filter(
    (job) => RED.has(job?.conclusion) && !ECHOES.has(job?.name) && !ignore.has(job?.id),
  );
  red.sort((a, b) => String(a.completed_at).localeCompare(String(b.completed_at)));
  return red[0] ?? null;
}

/** True once every job other than the watcher has finished. */
export function allFinished(jobs) {
  return jobs.every((job) => job?.name === "queue-watch" || job?.status === "completed");
}

/**
 * PRD-782. One red job of a `ci.yml` run. A watcher that polls holds a runner for the whole board, so
 * outside the merge queue the janitor calls this once per red job, and a green board costs nothing.
 * It leaves alone what must report every red (a scheduled audit), what `queue-watch` owns (a merge
 * group) and what the release reads (a main push).
 */
export function shouldStopRun({ run, job, log, signatures }) {
  const leave = (why) => ({ stop: false, why });
  if (run?.path !== ".github/workflows/ci.yml") return leave("not a ci.yml run");
  if (run.status === "completed") return leave("the run already ended");
  if (run.event === "schedule") return leave("a scheduled audit reports every red");
  if (run.event === "merge_group") return leave("queue-watch owns a merge group");
  if (run.event === "push" && run.head_branch === "main") return leave("the release reads main");
  if (!RED.has(job?.conclusion)) return leave("the job did not fail");
  if (ECHOES.has(job.name)) return leave("the job only echoes another job");
  if (isInfraFailure(job, log, signatures)) return leave("an infra failure goes to the janitor");
  return { stop: true, why: `first red job ${job.name}` };
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

function jobLog(repository, jobId) {
  try {
    return gh(["api", `repos/${repository}/actions/jobs/${jobId}/logs`]);
  } catch {
    return "";
  }
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href &&
  process.env.TN_CI_RED_JOB
) {
  stopAtRed({
    repository: process.env.GITHUB_REPOSITORY,
    runId: process.env.TN_CI_RED_RUN,
    jobId: process.env.TN_CI_RED_JOB,
  });
} else if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { GITHUB_REPOSITORY: repository, GITHUB_RUN_ID: runId, TN_CI_QUEUE_REF } = process.env;
  const number = queuePullNumber(TN_CI_QUEUE_REF);
  const interval = Number(process.env.TN_QUEUE_WATCH_SECONDS ?? 30);
  if (number === null || !repository || !runId) {
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

function stopAtRed({ repository, runId, jobId }) {
  const read = (route) => JSON.parse(gh(["api", `repos/${repository}/actions/${route}`]));
  const signatures = janitorSignatures(
    readFileSync(new URL("../.github/workflows/ci-janitor.yml", import.meta.url), "utf8"),
  );
  const decision = shouldStopRun({
    run: read(`runs/${runId}`),
    job: read(`jobs/${jobId}`),
    log: jobLog(repository, jobId),
    signatures,
  });
  console.log(`run ${runId}: ${decision.stop ? "cancelling" : "left running"}, ${decision.why}`);
  if (decision.stop) gh(["run", "cancel", runId, "--repo", repository]);
}
