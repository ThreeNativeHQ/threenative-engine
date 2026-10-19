#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readAttemptJobs, receiptFiles } from "./ci-attempt-receipts.mjs";
import {
  nativeBuildProfile,
  nativeCandidatePreflight,
  nativeJobIdentity,
  validateNativeReceipts,
} from "./ci-native-qualification.mjs";

const hash = (contents) => createHash("sha256").update(contents).digest("hex");
const fail = (message) => {
  throw new Error(`CI_NATIVE_BUILD_EVIDENCE: ${message}`);
};
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

export function validateNativeCache(contents, profile) {
  const entries = new Map(
    [...contents.matchAll(/^([A-Z][A-Z0-9_]*):[^=\n]+=([^\r\n]*)$/gmu)].map((m) => [m[1], m[2]]),
  );
  const expected = [
    ["CMAKE_BUILD_TYPE", profile.buildVariant],
    ["MYSTRAL_USE_V8", profile.engine === "V8" ? "ON" : "OFF"],
    ["MYSTRAL_USE_QUICKJS", profile.engine === "QuickJS" ? "ON" : "OFF"],
    ["MYSTRAL_USE_DAWN", profile.backend === "Dawn" ? "ON" : "OFF"],
    ["MYSTRAL_USE_WGPU", profile.backend === "wgpu" ? "ON" : "OFF"],
  ];
  for (const [key, value] of expected)
    if (entries.get(key) !== value) fail(`wrong actual configured ${key}`);
  return hash(contents);
}

// Hash and validate existing evidence; these envelopes neither run native code nor invent a new
// performance/release schema. The successful API job remains the functional execution verdict.
export async function nativeBuildEvidence(
  leg,
  candidateSha,
  root = process.cwd(),
  runnerTemp = process.env.RUNNER_TEMP,
) {
  const runtime = path.join(root, "packages/runtime-native");
  const profile = nativeBuildProfile(leg);
  const preset =
    leg.platform === "Windows" ? "tn-windows" : leg.platform === "macOS" ? "tn-macos" : "tn-linux";
  let artifactSha256;
  let configSha256;
  let reportFile;
  let coreReportBytes;
  if (leg.job === "android-emulator-parity") {
    const apk = path.join(runtime, "android/app/build/outputs/apk/debug/app-debug.apk");
    const library = execFileSync("unzip", ["-p", apk, "lib/x86_64/libmystral-runtime.so"], {
      maxBuffer: 256 * 1024 * 1024,
    });
    artifactSha256 = hash(library);
    const { inspectAndroidBuildProvenance } = await import("./ci-android-build-provenance.mjs");
    const diagnosticFile = path.join(
      root,
      `artifacts/ci-native-diagnostics/android-build-provenance-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}.json`,
    );
    const diagnostics = [];
    const provenance = inspectAndroidBuildProvenance(
      "x86_64",
      artifactSha256,
      runtime,
      execFileSync,
      (row) => {
        diagnostics.push(row);
        mkdirSync(path.dirname(diagnosticFile), { recursive: true });
        writeFileSync(
          diagnosticFile,
          `${JSON.stringify({ candidateSha, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT, diagnostics }, null, 2)}\n`,
        );
        console.error(`CI_ANDROID_PROVENANCE_DIAGNOSTIC: ${JSON.stringify(row)}`);
      },
    );
    const configs = provenance.buildNinjaFiles.map((file) =>
      validateNativeCache(
        readFileSync(path.join(path.dirname(file), "CMakeCache.txt"), "utf8"),
        profile,
      ),
    );
    if (new Set(configs).size !== 1) fail("ambiguous APK-matching CMake configurations");
    configSha256 = configs[0];
    reportFile = path.join(runtime, "artifacts/conformance/android/report.json");
  } else {
    artifactSha256 = hash(
      readFileSync(
        path.join(runtime, "build", preset, `mystral${leg.platform === "Windows" ? ".exe" : ""}`),
      ),
    );
    configSha256 = validateNativeCache(
      readFileSync(path.join(runtime, "build", preset, "CMakeCache.txt"), "utf8"),
      profile,
    );
    if (leg.job === "desktop-parity")
      reportFile = path.join(runtime, "artifacts/conformance/desktop/report.json");
    else if (leg.job === "desktop")
      reportFile = path.join(
        runtime,
        "artifacts/performance-contract",
        leg.platform,
        "production-evidence.json",
      );
    else {
      if (!runnerTemp) fail("starter project identity is missing");
      const project = path.join(runnerTemp, "threenative-starter-native");
      reportFile = path.join(project, "artifacts/native/consumer-targets.json");
      const rows = json(reportFile);
      const matches = Array.isArray(rows) ? rows.filter((row) => row.target === "desktop") : [];
      if (matches.length !== 1) fail("starter desktop consumer report is missing or ambiguous");
      const { validateConsumerTargetRow } = await import(
        "../packages/runtime-native/scripts/verify-starter-consumer.mjs"
      );
      const row = validateConsumerTargetRow(matches[0]);
      const name = path.basename(
        String(json(path.join(project, "package.json")).name).replace(/^@[^/]+\//u, ""),
      );
      const consumerHash = hash(
        readFileSync(
          path.join(project, "dist-native", `${name}${leg.platform === "Windows" ? ".exe" : ""}`),
        ),
      );
      if (
        !row.pass ||
        row.failures.length ||
        row.assertions === 0 ||
        row.artifactHash !== consumerHash
      )
        fail("starter consumer evidence does not bind its successful built artifact");
    }
  }
  if (leg.job === "desktop") {
    const platform = leg.platform === "Windows" ? "win32" : "darwin";
    coreReportBytes = readFileSync(
      path.join(runtime, "artifacts", `desktop-${platform}-report.json`),
    );
    const core = JSON.parse(coreReportBytes.toString("utf8"));
    if (
      core.pass !== true ||
      core.frames < 1 ||
      core.artifact?.sha256 !== artifactSha256 ||
      core.host?.platform !== platform
    )
      fail("desktop core report belongs to another runtime or failed");
  }
  const report = json(reportFile);
  if (["android-emulator-parity", "desktop-parity"].includes(leg.job)) {
    const { validateReport, reportExitCode, unexpectedBlockedRows } = await import(
      "../packages/runtime-native/conformance/run-conformance.mjs"
    );
    const registry = json(path.join(runtime, "conformance/registry.json"));
    if (
      validateReport(report, registry).length ||
      unexpectedBlockedRows(report, registry).length ||
      report.mode !== "execution" ||
      report.target !== (leg.job === "desktop-parity" ? "desktop" : "android") ||
      report.project !== null ||
      report.provenance.commit !== candidateSha ||
      report.provenance.dirty ||
      reportExitCode(report) === 1 ||
      (leg.job === "desktop-parity" && report.provenance.runtimeSha256 !== artifactSha256)
    )
      fail("conformance report is invalid, stale or belongs to another runtime");
    if (leg.job === "android-emulator-parity") {
      const executed = report.results.filter((row) => row.native?.completed === true);
      if (
        !executed.length ||
        executed.some((row) => row.native.runtimeLibraries?.x86_64 !== artifactSha256)
      )
        fail("Android executed APK library does not match observed build");
    }
  } else if (leg.job === "desktop") {
    const { validateProductionEvidence } = await import(
      "../packages/runtime-native/scripts/production-evidence.mjs"
    );
    validateProductionEvidence(report);
    if (report.source.sha !== candidateSha || report.source.dirty)
      fail("production report is stale or belongs to another runtime");
  }
  return {
    ...profile,
    artifactSha256,
    configSha256,
    reportSha256: hash(
      coreReportBytes
        ? Buffer.concat([readFileSync(reportFile), coreReportBytes])
        : readFileSync(reportFile),
    ),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env;
    const plan = JSON.parse(env.TN_CI_PLAN ?? "null");
    const expected = nativeCandidatePreflight({
      plan,
      eventName: env.TN_CI_EVENT,
      target: env.TN_CI_BASE_REF,
      candidateSha: env.TN_CI_CANDIDATE_SHA,
      runId: env.GITHUB_RUN_ID,
      runAttempt: env.GITHUB_RUN_ATTEMPT,
      workflowHeadSha: env.TN_CI_WORKFLOW_HEAD_SHA,
      reusable: env.TN_CI_NATIVE_REUSABLE !== "false",
    });
    const listing = readAttemptJobs(
      { repository: env.GITHUB_REPOSITORY, runId: expected.runId, runAttempt: expected.runAttempt },
      "CI_NATIVE",
    );
    if (process.argv[2] === "--write") {
      const key = env.TN_CI_NATIVE_PLATFORM
        ? `${env.GITHUB_JOB}:${env.TN_CI_NATIVE_PLATFORM}`
        : env.GITHUB_JOB;
      const leg = expected.legs.find((row) => row.key === key && row.runtime);
      if (!leg) fail("unselected runtime writer");
      const job = nativeJobIdentity(expected, leg, listing, false);
      if (env.TN_CI_JOB_RESULT !== "success")
        fail("failed runtime does not produce passing identity");
      const receipt = {
        version: 1,
        candidateSha: expected.candidateSha,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
        planVersion: plan.version,
        job: key,
        jobId: String(job.id),
        conclusion: "success",
        ...(await nativeBuildEvidence(leg, expected.candidateSha)),
      };
      const directory = path.join(
        env.GITHUB_WORKSPACE ?? process.cwd(),
        "artifacts/ci-native-receipts",
      );
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        path.join(directory, `${key.replace(":", "-")}.json`),
        `${JSON.stringify(receipt)}\n`,
      );
    } else if (process.argv[2] === "--collect") {
      const summary = {
        version: 1,
        candidateSha: expected.candidateSha,
        runId: expected.runId,
        runAttempt: expected.runAttempt,
        planVersion: plan.version,
        receipts: receiptFiles(process.argv[3], "CI_NATIVE"),
      };
      validateNativeReceipts(expected, summary, listing);
      appendFileSync(env.GITHUB_OUTPUT, `coverage_receipt=${JSON.stringify(summary)}\n`);
      const ios = listing.jobs.filter(
        (job) =>
          job.name === `${expected.prefix}iOS simulator runtime and no-Xcode consumer handoff`,
      );
      console.log(
        `iOS remains advisory: ${ios.length === 1 ? (ios[0].conclusion ?? ios[0].status) : "missing or ambiguous"}; no iOS qualification is certified by this receipt.`,
      );
    } else fail("expected --write or --collect <directory>");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
