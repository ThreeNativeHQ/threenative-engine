#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAttemptJobs, receiptFiles } from "./ci-attempt-receipts.mjs";
import {
  integrationCandidatePreflight,
  validateIntegrationReceipts,
} from "./ci-integration-scope.mjs";

// Jobs of attempts 1..current, so a leg that passed before `gh run rerun --failed` still reads as it
// did. The current attempt is read last and carries the settled-name wait.
export function readIntegrationJobs(identity, prefix = "CI_INTEGRATION", settledNames = []) {
  const current = Number(identity.runAttempt);
  const byId = new Map();
  for (let attempt = 1; attempt <= current; attempt++) {
    const listing = readAttemptJobs(
      { ...identity, runAttempt: String(attempt) },
      prefix,
      attempt === current ? settledNames : [],
    );
    for (const job of listing.jobs) byId.set(job.id, job);
  }
  const jobs = [...byId.values()];
  return { totalCount: jobs.length, jobs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const {
      GITHUB_REPOSITORY: repository,
      GITHUB_RUN_ID: runId,
      GITHUB_RUN_ATTEMPT: runAttempt,
    } = process.env;
    const plan = JSON.parse(process.env.TN_CI_PLAN ?? "null");
    const expected = {
      ...integrationCandidatePreflight({
        plan,
        eventName: process.env.TN_CI_EVENT,
        target: process.env.TN_CI_BASE_REF,
        baseSha: process.env.TN_BASE_SHA,
        candidateSha: process.env.TN_CI_CANDIDATE_SHA,
      }),
      runId,
      runAttempt,
    };
    // Collecting runs after every selected leg, so each must read as finished; a writer's own
    // job is still running.
    const settled =
      process.argv[2] === "--collect"
        ? expected.jobs.map((job) => `integration / ${expected.jobNames[job]}`)
        : [];
    const read = process.argv[2] === "--collect" ? readIntegrationJobs : readAttemptJobs;
    const listing = read({ repository, runId, runAttempt }, "CI_INTEGRATION", settled);
    if (process.argv[2] === "--write") {
      const job = process.env.GITHUB_JOB;
      if (!expected.jobs.includes(job))
        throw new Error("CI_INTEGRATION_RECEIPT_INVENTORY: job is not selected");
      const matching = listing.jobs.filter(
        (entry) => entry.name === `integration / ${expected.jobNames[job]}`,
      );
      if (
        matching.length !== 1 ||
        String(matching[0].run_id) !== runId ||
        String(matching[0].run_attempt) !== runAttempt ||
        !Number.isSafeInteger(matching[0].id) ||
        matching[0].id <= 0
      )
        throw new Error("CI_INTEGRATION_JOB_IDENTITY: receipt cannot resolve its actual job");
      const receipt = {
        version: 1,
        candidateSha: expected.candidateSha,
        runId,
        runAttempt,
        planVersion: plan.version,
        job,
        jobId: String(matching[0].id),
        conclusion: process.env.TN_CI_JOB_RESULT,
      };
      const directory = path.join(
        process.env.GITHUB_WORKSPACE ?? process.cwd(),
        "artifacts/ci-integration-receipts",
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `${job}.json`), `${JSON.stringify(receipt)}\n`);
    } else if (process.argv[2] === "--collect") {
      const directory = process.argv[3];
      const receipts = expected.jobs.length === 0 ? [] : receiptFiles(directory);
      validateIntegrationReceipts(expected, receipts, listing);
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        `coverage_receipt=${JSON.stringify({ version: 1, candidateSha: expected.candidateSha, runId, runAttempt, planVersion: plan.version, receipts })}\n`,
      );
    } else throw new Error("CI_INTEGRATION_ARGUMENT: expected --write or --collect <directory>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
