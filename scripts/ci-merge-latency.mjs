#!/usr/bin/env node
// PRD-550: how long a change takes to merge, measured from the GitHub API with `gh` and no new dependency.
//
//   node scripts/ci-merge-latency.mjs --since 2026-10-09 [--json] [--base develop]
//
// Per merged PR: last push -> merge, enqueue -> merge, merge-queue attempts, first failing job.
// Summary: median/p90 of those, merge-group success, board wall time and runner queue wait.
// A value the API cannot supply is null, never 0.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MS_PER_MIN = 60_000;
const minutes = (from, to) =>
  from && to ? (Date.parse(to) - Date.parse(from)) / MS_PER_MIN : null;
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);

/** Linear-interpolated quantile of the finite numbers in `values`; null when there are none. */
export function quantile(values, q) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/** The PR number a merge-queue run belongs to: `gh-readonly-queue/develop/pr-461-<sha>`. */
export function queuePrNumber(headBranch) {
  const match = /^gh-readonly-queue\/[^/]+\/pr-(\d+)-/u.exec(headBranch ?? "");
  return match === null ? null : Number(match[1]);
}

/** The job that failed first in a run. Joins such as `ci-required` finish last, so they never win. */
export function firstFailingJob(jobs = []) {
  const failed = jobs
    .filter((job) => job.conclusion === "failure" && job.completedAt)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  return failed[0]?.name ?? null;
}

/**
 * Pure summary of one window.
 * prs:  [{ number, title, mergedAt, lastCommitAt }]
 * runs: merge_group runs [{ id, headBranch, createdAt, updatedAt, conclusion }]
 * jobsByRun: { [runId]: [{ name, conclusion, createdAt, startedAt, completedAt }] }
 */
export function summarize({ prs, runs: allRuns, jobsByRun = {} }) {
  // A merge_group run whose branch is not a queue branch belongs to no PR and measures nothing here.
  const runs = allRuns.filter((run) => queuePrNumber(run.headBranch) !== null);
  const byPr = new Map();
  for (const run of runs) {
    const number = queuePrNumber(run.headBranch);
    if (number === null) continue;
    byPr.set(number, [...(byPr.get(number) ?? []), run]);
  }
  const rows = prs.map((pr) => {
    const attempts = (byPr.get(pr.number) ?? []).sort(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    const first = attempts[0];
    const failedRun = attempts.find((run) => run.conclusion === "failure");
    return {
      number: pr.number,
      title: pr.title,
      lastPushToMergeMin: round(minutes(pr.lastCommitAt, pr.mergedAt)),
      enqueueToMergeMin: round(minutes(first?.createdAt, pr.mergedAt)),
      attempts: attempts.length,
      firstAttempt: first === undefined ? null : (first.conclusion ?? "running"),
      firstFailingJob: failedRun === undefined ? null : firstFailingJob(jobsByRun[failedRun.id]),
    };
  });
  const queued = rows.filter((row) => row.firstAttempt !== null);
  const done = runs.filter((run) => run.conclusion === "success" || run.conclusion === "failure");
  const failures = new Map();
  for (const run of runs.filter((r) => r.conclusion === "failure")) {
    const name = firstFailingJob(jobsByRun[run.id]) ?? "unknown";
    failures.set(name, (failures.get(name) ?? 0) + 1);
  }
  const waits = Object.values(jobsByRun)
    .flat()
    .filter((job) => job.startedAt && job.conclusion !== "skipped")
    .map((job) => minutes(job.createdAt, job.startedAt))
    .filter((wait) => wait !== null && wait >= 0);
  const wall = runs
    .filter((run) => run.conclusion === "success")
    .map((run) => minutes(run.createdAt, run.updatedAt));
  const pct = (part, whole) => (whole === 0 ? null : round((100 * part) / whole));
  return {
    prs: rows,
    summary: {
      prCount: rows.length,
      lastPushToMergeMedianMin: round(
        quantile(
          rows.map((r) => r.lastPushToMergeMin),
          0.5,
        ),
      ),
      lastPushToMergeP90Min: round(
        quantile(
          rows.map((r) => r.lastPushToMergeMin),
          0.9,
        ),
      ),
      enqueueToMergeMedianMin: round(
        quantile(
          rows.map((r) => r.enqueueToMergeMin),
          0.5,
        ),
      ),
      firstAttemptSuccessPct: pct(
        queued.filter((r) => r.firstAttempt === "success").length,
        queued.length,
      ),
      mergeGroupRuns: runs.length,
      mergeGroupRunSuccessPct: pct(
        done.filter((r) => r.conclusion === "success").length,
        done.length,
      ),
      boardWallMedianMin: round(quantile(wall, 0.5)),
      queueWaitP50Min: round(quantile(waits, 0.5)),
      queueWaitP90Min: round(quantile(waits, 0.9)),
      queueWaitJobs: waits.length,
    },
    firstFailingJobs: [...failures]
      .map(([job, count]) => ({ job, count }))
      .sort((a, b) => b.count - a.count || a.job.localeCompare(b.job)),
  };
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

const ndjson = (text) =>
  text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

/** Fetch one window from GitHub and summarize it. */
export function measure({ since, base = "develop", repo = process.env.GITHUB_REPOSITORY }) {
  const repository =
    repo ?? gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim();
  const prs = JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      repository,
      "--state",
      "merged",
      "--base",
      base,
      "--search",
      `merged:>=${since}`,
      "--limit",
      "300",
      "--json",
      "number,title,mergedAt,headRefOid",
    ]),
  ).map((pr) => ({
    number: pr.number,
    title: pr.title,
    mergedAt: pr.mergedAt,
    // `commits` in the GraphQL list exceeds GitHub's node limit, so the head commit is read on its own.
    lastCommitAt: gh([
      "api",
      `repos/${repository}/commits/${pr.headRefOid}`,
      "-q",
      ".commit.committer.date",
    ]).trim(),
  }));
  const runs = ndjson(
    gh([
      "api",
      "--paginate",
      "--jq",
      ".workflow_runs[]",
      `repos/${repository}/actions/workflows/ci.yml/runs?event=merge_group&created=%3E%3D${since}&per_page=100`,
    ]),
  ).map((run) => ({
    id: run.id,
    headBranch: run.head_branch,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    conclusion: run.conclusion,
  }));
  const jobsByRun = {};
  for (const run of runs) {
    jobsByRun[run.id] = ndjson(
      gh([
        "api",
        "--paginate",
        "--jq",
        ".jobs[]",
        `repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`,
      ]),
    ).map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }));
  }
  return { since, base, at: new Date().toISOString(), ...summarize({ prs, runs, jobsByRun }) };
}

const fmt = (value, unit = "") => (value === null ? "n/a" : `${value}${unit}`);

export function formatText(result) {
  const { summary: s } = result;
  const lines = [
    `merged into ${result.base} since ${result.since}: ${s.prCount} PRs, ${s.mergeGroupRuns} merge-group runs`,
    `last push -> merge   median ${fmt(s.lastPushToMergeMedianMin, " min")}   p90 ${fmt(s.lastPushToMergeP90Min, " min")}   (goal 30 / 45)`,
    `enqueue -> merge     median ${fmt(s.enqueueToMergeMedianMin, " min")}`,
    `first-attempt merge  ${fmt(s.firstAttemptSuccessPct, "%")}   run success ${fmt(s.mergeGroupRunSuccessPct, "%")}   (goal 90%)`,
    `merge-group board    median wall ${fmt(s.boardWallMedianMin, " min")}   (goal 15)`,
    `runner queue wait    p50 ${fmt(s.queueWaitP50Min, " min")}   p90 ${fmt(s.queueWaitP90Min, " min")} over ${s.queueWaitJobs} jobs   (goal p90 3)`,
    "",
    "PR     push->merge  enqueue->merge  attempts  first        first failing job",
  ];
  for (const row of result.prs) {
    lines.push(
      `#${String(row.number).padEnd(5)} ${fmt(row.lastPushToMergeMin).padStart(10)}  ${fmt(row.enqueueToMergeMin).padStart(13)}  ${String(row.attempts).padStart(8)}  ${String(row.firstAttempt ?? "n/a").padEnd(11)}  ${row.firstFailingJob ?? ""}`,
    );
  }
  if (result.firstFailingJobs.length > 0) {
    lines.push("", "first failing job per red merge group:");
    for (const { job, count } of result.firstFailingJobs)
      lines.push(`  ${String(count).padStart(3)}  ${job}`);
  }
  return lines.join("\n");
}

function main(argv) {
  const get = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const since = get("--since");
  if (since === undefined || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/u.test(since)) {
    console.error(
      "usage: node scripts/ci-merge-latency.mjs --since YYYY-MM-DD [--base develop] [--json]",
    );
    process.exit(2);
  }
  const result = measure({ since, base: get("--base") ?? "develop" });
  console.log(argv.includes("--json") ? JSON.stringify(result, null, 2) : formatText(result));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
