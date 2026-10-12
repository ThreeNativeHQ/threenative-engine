import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MAX_ATTEMPTS = 5;

export function readAttemptJobs({ repository, runId, runAttempt }, prefix = "CI_INTEGRATION") {
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") ||
    !/^[1-9]\d*$/u.test(runId ?? "") ||
    !/^[1-9]\d*$/u.test(runAttempt ?? "")
  )
    throw new Error(`${prefix}_RUN_IDENTITY: repository, run and attempt are required`);
  let response;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      response = execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`,
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      break;
    } catch (error) {
      const stderr = String(error.stderr ?? "");
      if (
        attempt === MAX_ATTEMPTS - 1 ||
        error.status !== 1 ||
        error.signal ||
        !/error connecting to api\.github\.com/iu.test(stderr) ||
        /HTTP (?:401|403|404|429)\b/iu.test(stderr)
      )
        throw error;
      // Retry only the same read endpoint after 1, 2, 4, 8 seconds; no stale page, receipt or permission fallback.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * 2 ** attempt);
    }
  }
  const pages = JSON.parse(response);
  if (
    !Array.isArray(pages) ||
    pages.length === 0 ||
    pages.some((page) => !Array.isArray(page.jobs) || page.total_count !== pages[0].total_count)
  )
    throw new Error(`${prefix}_API_INCOMPLETE: malformed paginated jobs`);
  const listing = { totalCount: pages[0].total_count, jobs: pages.flatMap((page) => page.jobs) };
  if (
    !Number.isInteger(listing.totalCount) ||
    listing.totalCount !== listing.jobs.length ||
    new Set(listing.jobs.map((job) => job.id)).size !== listing.jobs.length
  )
    throw new Error(`${prefix}_API_INCOMPLETE: truncated job listing`);
  return listing;
}

export function receiptFiles(directory, prefix = "CI_INTEGRATION") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) return receiptFiles(file, prefix);
    if (entry.isFile() && entry.name.endsWith(".json"))
      return [JSON.parse(readFileSync(file, "utf8"))];
    throw new Error(`${prefix}_RECEIPT_INVENTORY: unsupported artifact entry`);
  });
}
