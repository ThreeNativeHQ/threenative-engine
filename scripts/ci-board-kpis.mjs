#!/usr/bin/env node
// Whole-board KPIs for the CI speed loop (PRD-782). Attempt 1 of each run, so a retry cannot hide a red.
import { execFileSync } from "node:child_process";
import { quantile } from "./ci-merge-latency.mjs";
import { gh } from "./lib/gh.mjs";

/** A board that ran at least this many jobs is a full board, not a thin lane. */
const FULL_BOARD_JOBS = 60;
/** Verdict and bookkeeping jobs. They go red because a leg went red, so they are no flake evidence. */
const JOIN_JOBS =
  /ci-required|receipt|coverage|run-summary|queue-watch|Gate-schema|Networking qualification|collector/u;
const AGGREGATE_JOBS = new Set(["golden-path", "build"]);
/** Steps that prepare the machine. Everything else is the work the job exists for. */
const SETUP_STEP =
  /^(set up job|complete job|post )|^run actions\/(checkout|setup-|cache|upload-artifact|download-artifact)|^run \.\/\.github\/actions\/|^(run )?(pnpm|npm) (install|ci)\b|^(install|restore) (?!and play)/iu;

const ms = (value) => Date.parse(value);
const minutes = (from, to) => (ms(to) - ms(from)) / 60_000;
const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
const share = (part, whole) => (whole > 0 ? round((100 * part) / whole) : null);
const median = (values) => (values.length === 0 ? null : round(quantile(values, 0.5)));
const isLeg = (job) => !JOIN_JOBS.test(job.name) && !AGGREGATE_JOBS.has(job.name);

function ranJobs(run) {
  return run.jobs.filter(
    (job) =>
      job.startedAt &&
      job.completedAt &&
      job.conclusion !== "skipped" &&
      ms(job.completedAt) >= ms(job.startedAt),
  );
}

const machineMinutes = (jobs) =>
  jobs.reduce((total, job) => total + minutes(job.startedAt, job.completedAt), 0);

function wallMinutes(jobs) {
  const start = Math.min(...jobs.map((job) => ms(job.createdAt)));
  const end = Math.max(...jobs.map((job) => ms(job.completedAt)));
  return (end - start) / 60_000;
}

/** Red legs that went green on another full board of the same commit. Attempt 2 is not read. */
function flakeRate(boards) {
  const bySha = new Map();
  for (const board of boards) bySha.set(board.sha, [...(bySha.get(board.sha) ?? []), board]);
  let red = 0;
  let flipped = 0;
  for (const group of bySha.values()) {
    if (group.length < 2) continue;
    const outcomes = new Map();
    for (const board of group) {
      for (const job of board.ran) {
        if (!isLeg(job) || !["success", "failure"].includes(job.conclusion)) continue;
        outcomes.set(job.name, new Set([...(outcomes.get(job.name) ?? []), job.conclusion]));
      }
    }
    for (const seen of outcomes.values()) {
      if (!seen.has("failure")) continue;
      red += 1;
      if (seen.has("success")) flipped += 1;
    }
  }
  return share(flipped, red);
}

function minutesAfterFirstRed(boards) {
  let after = 0;
  let total = 0;
  for (const { ran } of boards) {
    total += machineMinutes(ran);
    const reds = ran.filter((job) => job.conclusion === "failure" && isLeg(job));
    if (reds.length === 0) continue;
    const firstRed = Math.min(...reds.map((job) => ms(job.completedAt)));
    for (const job of ran) {
      if (ms(job.completedAt) <= firstRed) continue;
      after += (ms(job.completedAt) - Math.max(ms(job.startedAt), firstRed)) / 60_000;
    }
  }
  return share(after, total);
}

/**
 * PRD-480 AC-2: the summed per-job queue wait of one full board. Null when a running job cannot
 * supply both timestamps, because a partial sum would read as an improvement.
 */
function boardQueueSum(run) {
  const waits = run.ran.map((job) => minutes(job.createdAt, job.startedAt));
  return waits.some((wait) => wait === null)
    ? null
    : round(waits.reduce((total, wait) => total + Math.max(0, wait), 0));
}

/** Null when no job carries steps: the value is unknown, not zero. */
function setupShare(boards) {
  let setup = 0;
  let total = 0;
  for (const { ran } of boards) {
    for (const job of ran) {
      for (const step of job.steps ?? []) {
        if (!step.startedAt || !step.completedAt) continue;
        const spent = Math.max(0, minutes(step.startedAt, step.completedAt));
        total += spent;
        if (SETUP_STEP.test(step.name)) setup += spent;
      }
    }
  }
  return share(setup, total);
}

/**
 * Pure. `runs` is every ci.yml run of the window: { sha, conclusion, createdAt, jobs }.
 * A value the runs cannot supply is null, never 0.
 */
export function summarizeBoards({ runs, since, until }) {
  const all = runs.map((run) => ({ ...run, ran: ranJobs(run) }));
  const totalMachine = all.reduce((total, run) => total + machineMinutes(run.ran), 0);
  const greenMachine = all
    .filter((run) => run.conclusion === "success")
    .reduce((total, run) => total + machineMinutes(run.ran), 0);
  const full = all.filter((run) => run.ran.length >= FULL_BOARD_JOBS);
  const finished = full.filter((run) => ["success", "failure"].includes(run.conclusion));
  const green = finished.filter((run) =>
    run.ran.every((job) => ["success", "skipped"].includes(job.conclusion)),
  );
  const weeks = minutes(since, until) / (60 * 24 * 7);
  const queueWaits = full.flatMap((run) =>
    run.ran.map((job) => Math.max(0, minutes(job.createdAt, job.startedAt))),
  );
  return {
    fullBoards: full.length,
    finishedFullBoards: finished.length,
    fullBoardWallMedianMin: median(finished.map((run) => wallMinutes(run.ran))),
    longestLegMedianMin: median(
      finished.map((run) =>
        Math.max(...run.ran.map((job) => minutes(job.startedAt, job.completedAt))),
      ),
    ),
    fullBoardMachineMedianMin: median(finished.map((run) => machineMinutes(run.ran))),
    machineMinPerWeek: weeks > 0 && all.length > 0 ? Math.round(totalMachine / weeks) : null,
    boardQueueP90Min: queueWaits.length === 0 ? null : round(quantile(queueWaits, 0.9)),
    fullBoardQueueSumMedianMin: median(finished.map(boardQueueSum)),
    boardGreenFirstPct: share(green.length, finished.length),
    flakeRatePct: flakeRate(full),
    greenMinutesPct: share(greenMachine, totalMachine),
    minutesAfterFirstRedPct: minutesAfterFirstRed(full),
    setupSharePct: setupShare(full),
  };
}

/**
 * Promotion to npm, per published version: the first promotion PR opened after the previous publish,
 * to this publish. It counts the failed promotions too, because the owner waits through them.
 */
export function releaseLeadTimes({ publishes, promotions }) {
  const ordered = [...publishes].sort((a, b) => ms(a.at) - ms(b.at));
  const leads = [];
  for (const [index, publish] of ordered.entries()) {
    const previous = index === 0 ? Number.NEGATIVE_INFINITY : ms(ordered[index - 1].at);
    const opened = promotions
      .map((pr) => ms(pr.createdAt))
      .filter((at) => at > previous && at < ms(publish.at));
    if (opened.length === 0) continue;
    leads.push({
      version: publish.version,
      at: publish.at,
      leadMin: Math.round((ms(publish.at) - Math.min(...opened)) / 60_000),
    });
  }
  return leads;
}

const ndjson = (text) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

/** Live read. About 2 API calls per run, so run it once per loop turn. */
export function measureBoards({
  since,
  repo = process.env.GITHUB_REPOSITORY ??
    // `gh` answers with a trailing newline, and this value is spliced into API paths.
    gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).trim(),
  npmPackage = "@threenative/core",
}) {
  const runs = ndjson(
    gh([
      "api",
      "--paginate",
      "--jq",
      ".workflow_runs[]",
      `repos/${repo}/actions/workflows/ci.yml/runs?created=%3E%3D${since}&per_page=100`,
    ]),
  ).map((run) => ({
    id: run.id,
    sha: run.head_sha,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    jobs: ndjson(
      gh([
        "api",
        "--paginate",
        "--jq",
        ".jobs[]",
        `repos/${repo}/actions/runs/${run.id}/attempts/1/jobs?per_page=100`,
      ]),
    ).map((job) => ({
      name: job.name,
      conclusion: job.conclusion,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
      steps: (job.steps ?? []).map((step) => ({
        name: step.name,
        startedAt: step.started_at,
        completedAt: step.completed_at,
      })),
    })),
  }));
  const times = JSON.parse(
    execFileSync("npm", ["view", npmPackage, "time", "--json"], { encoding: "utf8" }),
  );
  const publishes = Object.entries(times)
    .filter(([version]) => /^\d+\.\d+\.\d+$/u.test(version))
    .map(([version, at]) => ({ version, at }));
  const promotions = JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--base",
      "main",
      "--head",
      "develop",
      "--state",
      "all",
      "--limit",
      "200",
      "--json",
      "createdAt",
    ]),
  );
  const until = new Date().toISOString();
  return {
    ...summarizeBoards({ runs, since, until }),
    ...releaseLead({ publishes, promotions, since, until }),
  };
}

/** A promotion with no publish yet counts as a release that lands now: a lower bound, never a pass. */
export function releaseLead({ publishes, promotions, since, until }) {
  const inWindow = releaseLeadTimes({
    publishes: [...publishes, { version: "in flight", at: until }],
    promotions,
  }).filter((item) => ms(item.at) >= ms(since));
  return {
    releaseLeadMin: inWindow.at(-1)?.leadMin ?? null,
    releaseLeadVersion: inWindow.at(-1)?.version ?? null,
  };
}
