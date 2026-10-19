import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Eight reads back off for about two minutes in total, which still fits the 5-minute receipt jobs.
// Five (15 s of waits) lost four finished jobs' receipts to one GitHub Actions incident on main run
// 39275851944; the read still fails closed.
const MAX_ATTEMPTS = 8;

export function readAttemptJobs({ repository, runId, runAttempt }, prefix = "CI_INTEGRATION") {
  if (
    !/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") ||
    !/^[1-9]\d*$/u.test(runId ?? "") ||
    !/^[1-9]\d*$/u.test(runAttempt ?? "")
  )
    throw new Error(`${prefix}_RUN_IDENTITY: repository, run and attempt are required`);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let pages;
    try {
      const response = execFileSync(
        "gh",
        [
          "api",
          "--paginate",
          "--slurp",
          // GitHub returns 502 for large job pages; paginate smaller pages without dropping evidence.
          `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=10`,
        ],
        { encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 * 1024 },
      );
      pages = JSON.parse(response);
    } catch (error) {
      const stderr = String(error.stderr ?? "");
      if (
        attempt === MAX_ATTEMPTS - 1 ||
        error.status !== 1 ||
        error.signal ||
        !/error connecting to api\.github\.com|HTTP (?:500|502|503|504)\b/iu.test(stderr) ||
        /HTTP (?:401|403|404|429)\b/iu.test(stderr)
      )
        throw error;
      // Retry only the same read endpoint after 1, 2, 4 ... 64 seconds; no stale page, receipt or permission fallback.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * 2 ** attempt);
      continue;
    }
    if (
      !Array.isArray(pages) ||
      pages.length === 0 ||
      pages.some((page) => !Array.isArray(page?.jobs) || !Number.isInteger(page.total_count))
    )
      throw new Error(`${prefix}_API_INCOMPLETE: malformed paginated jobs`);
    if (pages.some((page) => page.total_count !== pages[0].total_count)) {
      if (attempt === MAX_ATTEMPTS - 1)
        throw new Error(`${prefix}_API_INCOMPLETE: job inventory changed during pagination`);
      // New dependent jobs can appear between pages; discard the entire read and require a stable inventory.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000 * 2 ** attempt);
      continue;
    }
    const listing = { totalCount: pages[0].total_count, jobs: pages.flatMap((page) => page.jobs) };
    if (
      listing.totalCount !== listing.jobs.length ||
      new Set(listing.jobs.map((job) => job.id)).size !== listing.jobs.length
    )
      throw new Error(`${prefix}_API_INCOMPLETE: truncated job listing`);
    return listing;
  }
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
