#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { readAttemptJobs } from "./ci-attempt-receipts.mjs";
import {
  assertMergeParentCandidate,
  currentRun,
  sourceVerdict,
  validateEventPlan,
  validatePlan,
} from "./ci-change-scope.mjs";
import { readIntegrationJobs } from "./ci-integration-receipts.mjs";
import {
  integrationCandidatePreflight,
  validateIntegrationReceipts,
} from "./ci-integration-scope.mjs";
import { nativeCandidatePreflight, validateNativeReceipts } from "./ci-native-qualification.mjs";
import {
  discoverTypecheckTemplates,
  validateTemplateTypechecks,
} from "./ci-template-typecheck.mjs";

try {
  const needs = JSON.parse(process.env.TN_CI_NEEDS ?? "null");
  if (needs?.scope?.result !== "success")
    throw new Error(
      "CI_REQUIRED_SCOPE_NOT_SUCCESS: classification failed, was cancelled, skipped or is missing",
    );
  const plan = validatePlan(JSON.parse(needs.scope.outputs?.plan ?? "null"));
  const checkout = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  if (checkout.status !== 0 || checkout.stdout.trim() !== plan.candidateSha)
    throw new Error(
      "CI_REQUIRED_CANDIDATE_MISMATCH: verdict must execute the classified candidate",
    );
  validateEventPlan(plan, {
    eventName: process.env.TN_CI_EVENT,
    baseRef: process.env.TN_CI_BASE_REF,
    forceFull: process.env.TN_CI_FORCE_FULL === "true",
  });
  if (process.env.TN_CI_EVENT === "pull_request") {
    // The candidate is frozen by the exact base/head parent assertion below, not by the head
    // branch's name. A `promotion/<head-sha>` ref restated a SHA that check already verifies.
    if (
      process.env.TN_CI_CUTOVER === "true" &&
      process.env.TN_CI_BASE_REF === "main" &&
      plan.selection !== "full"
    )
      throw new Error("CI_REQUIRED_MAIN_FULL: main requires complete verification");
    assertMergeParentCandidate(
      process.cwd(),
      "HEAD",
      process.env.TN_CI_BASE_SHA,
      process.env.TN_CI_HEAD_SHA,
    );
  }
  if (process.env.TN_CI_EVENT === "merge_group") {
    const base = process.env.TN_CI_BASE_SHA ?? "";
    const head = process.env.TN_CI_HEAD_SHA ?? "";
    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", base, plan.candidateSha]);
    if (!/^[0-9a-f]{40}$/u.test(base) || head !== plan.candidateSha || ancestor.status !== 0)
      throw new Error(
        "CI_REQUIRED_QUEUE_CANDIDATE_MISMATCH: expected the exact merge-group head and ancestor base",
      );
  }
  // PRD-481. The scope job proved the source run tested this exact tree and covered this run's
  // profile; what only the API can settle is whether that run's own verdict went green and whether
  // it really did conclude every leg, and a reuse this job cannot confirm is not a pass.
  let source = { succeeded: true };
  if (plan.reusedRunId > 0) {
    const target = process.env.TN_CI_BASE_REF ?? "";
    // A reuse plan states nothing about what was required — every job in it reads exempt — so the
    // gate re-checks what policy owes each target, and the plan's tier is that answer: a pull
    // request that owes the Linux rows (PRD-380 phase 2) owes them even when the work was reused, so
    // a source that skipped the lane cannot stand in for it.
    const current = currentRun({
      eventName: process.env.TN_CI_EVENT,
      baseRef: target,
      exempt: plan.nativeTier === "none" ? ["native-platforms"] : [],
    });
    if ("error" in current) throw new Error(`CI_REQUIRED_ROUTING_UNKNOWN: ${current.error}`);
    source = sourceVerdict({ runId: plan.reusedRunId, current });
    if ("error" in source) throw new Error(`${source.code}: ${source.error}`);
  }
  const failures = [];
  const lines = [
    "## Required CI verdict",
    "",
    `Candidate: \`${plan.candidateSha}\``,
    `Selection: \`${plan.selection}\` — ${plan.reason}`,
    `Native matrix: \`${plan.nativeTier}\``,
    "",
  ];
  if (plan.reusedRunId > 0) {
    lines.splice(
      3,
      0,
      `Reused verdict from CI run \`${String(plan.reusedRunId)}\` (${String(source.profile.target)}/${String(source.profile.native)} profile, ci-required: ${String(source.conclusion)})`,
    );
  }
  for (const [name, job] of Object.entries(plan.jobs)) {
    const result = needs[name]?.result;
    lines.push(
      `- ${name}: ${job.required ? `required (${result ?? "missing"})` : "exempt"} — ${job.reason}`,
    );
    if (job.required && result !== "success")
      failures.push(`CI_REQUIRED_JOB_NOT_SUCCESS: ${name} (${result ?? "missing"})`);
  }
  // New coverage jobs cannot silently sit outside the declared plan. Reporting work belongs in
  // run-summary, which is deliberately not a dependency of the protected verdict.
  for (const name of Object.keys(needs)) {
    if (name !== "scope" && !Object.hasOwn(plan.jobs, name))
      failures.push(`CI_REQUIRED_UNMAPPED_JOB: ${name}`);
  }
  if (plan.qualification) {
    try {
      const identity = {
        repository: process.env.GITHUB_REPOSITORY,
        runId: process.env.GITHUB_RUN_ID,
        runAttempt: process.env.GITHUB_RUN_ATTEMPT,
      };
      validateTemplateTypechecks(
        {
          ...identity,
          plan,
          candidateSha: plan.candidateSha,
          workflowHeadSha: process.env.TN_CI_HEAD_SHA || process.env.GITHUB_SHA,
          eventName: process.env.TN_CI_EVENT,
          target: process.env.TN_CI_BASE_REF,
          templates: discoverTypecheckTemplates(),
          workflow: readFileSync(".github/workflows/ci.yml", "utf8"),
        },
        readAttemptJobs(identity, "CI_TEMPLATE_TYPECHECK"),
      );
      lines.push(
        "- pristine template typechecks: every discovered template compiler step verified in this exact attempt",
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (plan.jobs.integration.required && needs.integration?.result === "success") {
    try {
      const {
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: runAttempt,
      } = process.env;
      const receipt = JSON.parse(process.env.TN_CI_INTEGRATION_RECEIPT ?? "null");
      if (
        receipt?.version !== 1 ||
        receipt.candidateSha !== plan.candidateSha ||
        receipt.runId !== runId ||
        receipt.runAttempt !== runAttempt ||
        receipt.planVersion !== plan.version
      )
        throw new Error(
          "CI_INTEGRATION_RECEIPT_IDENTITY: required join has no exact current-attempt receipt",
        );
      const expected = {
        ...integrationCandidatePreflight({
          plan,
          eventName: process.env.TN_CI_EVENT,
          target: process.env.TN_CI_BASE_REF,
          baseSha: process.env.TN_CI_BASE_SHA,
          candidateSha: plan.candidateSha,
        }),
        runId,
        runAttempt,
      };
      validateIntegrationReceipts(
        expected,
        receipt.receipts,
        readIntegrationJobs({ repository, runId, runAttempt }),
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (plan.jobs["native-platforms"].required && needs["native-platforms"]?.result === "success") {
    try {
      const {
        GITHUB_REPOSITORY: repository,
        GITHUB_RUN_ID: runId,
        GITHUB_RUN_ATTEMPT: runAttempt,
      } = process.env;
      const expected = nativeCandidatePreflight({
        plan,
        eventName: process.env.TN_CI_EVENT,
        target: process.env.TN_CI_BASE_REF,
        candidateSha: plan.candidateSha,
        runId,
        runAttempt,
        workflowHeadSha: process.env.TN_CI_HEAD_SHA || process.env.GITHUB_SHA,
      });
      validateNativeReceipts(
        expected,
        JSON.parse(process.env.TN_CI_NATIVE_RECEIPT ?? "null"),
        readAttemptJobs({ repository, runId, runAttempt }, "CI_NATIVE"),
      );
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  console.log(lines.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  if (failures.length) throw new Error(failures.join("\n"));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
