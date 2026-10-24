/**
 * Writes the run summary PRD-296 item 3 asks for: every job's verdict, with a skipped job saying
 * **skipped** and why, rather than being indistinguishable from a pass at a glance.
 *
 * The board is the failure mode this addresses. When three gates were ordered behind a
 * permanently red one they were skipped on every run in the repository's history, and a skipped
 * check reads as an absence, not a red. The `main protection` ruleset makes that worse rather than
 * better: a skipped required check counts as satisfied.
 *
 * Reads the workflow for the job graph and the `needs` context for the results, so it names the
 * upstream that caused a skip instead of asserting one.
 *
 * Usage: `tsx scripts/ci-run-summary.ts --workflow <path> --results <json file>`, where the JSON
 * is `${{ toJSON(needs) }}`. It prints markdown on stdout; the workflow appends it to
 * `$GITHUB_STEP_SUMMARY`.
 */
import { readFile } from "node:fs/promises";
import { type ICiJob, ciJobGraph } from "./ci-workflow.js";

/** One job's verdict as Actions reports it. */
export interface IJobResult {
  readonly result?: string;
}

/** Rendered row: what the job was, what happened, and — when it did not run — why. */
export interface ISummaryRow {
  readonly job: string;
  readonly result: string;
  readonly why: string;
}

const RAN = new Set(["success", "failure"]);

/**
 * Builds one row per reported job.
 *
 * Fail-closed twice over. A job the workflow declares but the summary does not depend on is
 * *exactly* the invisible job this exists to expose, so it throws rather than quietly reporting on
 * a subset; and a job whose result is missing or unrecognised throws rather than defaulting to
 * anything, because "no observation" must never render as a verdict.
 */
export function summaryRows(
  jobs: readonly ICiJob[],
  reporter: string,
  results: Readonly<Record<string, IJobResult>>,
): readonly ISummaryRow[] {
  // `queue-watch` polls this whole run, so a `needs:` on it would deadlock the summary.
  const reported = jobs.filter((job) => job.name !== reporter && job.name !== "queue-watch");
  const missing = reported.filter((job) => !(job.name in results)).map((job) => job.name);
  if (missing.length > 0) {
    throw new Error(
      `CI_SUMMARY_UNREPORTED_JOBS: ${missing.join(", ")} — ${reporter} does not declare needs: on ${missing.length === 1 ? "it" : "them"}, so the run summary cannot say whether ${missing.length === 1 ? "it" : "they"} ran`,
    );
  }
  return reported.map((job) => {
    const result = results[job.name]?.result;
    if (result === undefined || result.length === 0) {
      throw new Error(`CI_SUMMARY_NO_RESULT: ${job.name} reported no result`);
    }
    if (RAN.has(result)) return { job: job.name, result, why: "" };
    const blocking = job.needs.filter((need) => results[need]?.result !== "success");
    const why =
      blocking.length > 0
        ? `never ran — needs: ${blocking.map((need) => `${need} (${results[need]?.result ?? "not reported"})`).join(", ")}`
        : "never ran — its `if:` condition was false";
    return { job: job.name, result, why };
  });
}

/** The markdown the run summary shows. Skips are called out, not left to be read as blanks. */
export function formatRunSummary(rows: readonly ISummaryRow[]): string {
  const skipped = rows.filter((row) => !RAN.has(row.result));
  const lines = [
    "## CI job results",
    "",
    "| Job | Result | Why |",
    "| --- | --- | --- |",
    ...rows.map((row) => {
      const mark = RAN.has(row.result) ? row.result : `**${row.result}**`;
      return `| \`${row.job}\` | ${mark} | ${row.why === "" ? "—" : row.why} |`;
    }),
    "",
  ];
  lines.push(
    skipped.length === 0
      ? `Every one of the ${String(rows.length)} jobs ran.`
      : `**${String(skipped.length)} of ${String(rows.length)} jobs did not run.** A job that never ran proved nothing; a skipped required check still counts as satisfied by the ruleset, so read the reasons above rather than the green tick.`,
  );
  return lines.join("\n");
}

/** API timestamps are separate observations, not an inference from total workflow duration. */
export interface IJobTiming {
  readonly name: string;
  readonly created_at?: string | null;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
}

function elapsed(start: string | null | undefined, end: string | null | undefined): string {
  const duration = Date.parse(end ?? "") - Date.parse(start ?? "");
  return Number.isFinite(duration) && duration >= 0
    ? `${Math.round(duration / 1_000)}s`
    : "unavailable";
}

export function formatJobTimings(jobs: readonly IJobTiming[]): string {
  return [
    "## Observed job timing",
    "",
    "Queue starts at the API job-created timestamp; execution starts when a runner accepts it. Missing timestamps are unavailable, never zero or a passing test.",
    "",
    "| Job | Queue | Execution |",
    "| --- | --- | --- |",
    ...jobs.map(
      (job) =>
        `| ${job.name.replaceAll("|", "&#124;").replaceAll(/\r?\n/gu, " ")} | ${elapsed(job.created_at, job.started_at)} | ${elapsed(job.started_at, job.completed_at)} |`,
    ),
    "",
  ].join("\n");
}

function argument(name: string): string {
  const at = process.argv.indexOf(`--${name}`);
  const value = at < 0 ? undefined : process.argv[at + 1];
  if (value === undefined) throw new Error(`CI_SUMMARY_MISSING_ARGUMENT: --${name}`);
  return value;
}

async function main(): Promise<void> {
  const jobs = ciJobGraph(await readFile(argument("workflow"), "utf8"));
  const results = JSON.parse(await readFile(argument("results"), "utf8")) as Record<
    string,
    IJobResult
  >;
  console.log(formatRunSummary(summaryRows(jobs, argument("reporter"), results)));
  if (process.argv.includes("--timings")) {
    const timings = JSON.parse(await readFile(argument("timings"), "utf8")) as IJobTiming[];
    if (!Array.isArray(timings) || timings.some((job) => !job || typeof job.name !== "string")) {
      throw new Error("CI_SUMMARY_INVALID_TIMINGS: expected API job records");
    }
    console.log(formatJobTimings(timings));
  }
}

if (process.argv[1]?.endsWith("ci-run-summary.ts") === true) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
