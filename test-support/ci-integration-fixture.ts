import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// Copy only manifests and the workflow required to prove CPU fixture ownership.
export function copyTemplateOwnership(root: string, repository: string) {
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  cpSync(
    path.join(repository, ".github/workflows/ci.yml"),
    path.join(root, ".github/workflows/ci.yml"),
  );
  const source = path.join(repository, "packages/create-threenative/templates");
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, "packages/create-threenative/templates", entry.name);
    mkdirSync(target, { recursive: true });
    for (const file of ["kit.json", "package.json"])
      cpSync(path.join(source, entry.name, file), path.join(target, file));
  }
}

// Simulated Actions API evidence for CPU-only verdict tests; no production bypass.
export function integrationEvidence(
  root: string,
  directory: string,
  plan: {
    candidateSha: string;
    version: number;
    nativeTier?: string;
    qualification?: boolean;
    templateMatrix?: { template: string[] };
    jobs?: Record<string, { required: boolean }>;
  },
  includeNative = true,
  workflowHeadSha = plan.candidateSha,
) {
  const workflow = execFileSync(
    "git",
    ["show", `${plan.candidateSha}:.github/workflows/integration.yml`],
    { cwd: root, encoding: "utf8" },
  );
  const chunks = workflow.split(/^ {2}([a-z][a-z0-9-]*):\n/gmu);
  const entries: [string, string][] = [];
  for (let i = 1; i < chunks.length; i += 2) {
    const id = chunks[i] ?? "";
    if (["paths", "completion"].includes(id)) continue;
    entries.push([id, /^ {4}name: ([^\n]+)$/mu.exec(chunks[i + 1] ?? "")?.[1] ?? id]);
  }
  const current = {
    candidateSha: plan.candidateSha,
    runId: "123",
    runAttempt: "2",
    planVersion: plan.version,
  };
  const receipts = entries.map(([job], i) => ({
    version: 1,
    ...current,
    job,
    jobId: String(i + 10),
    conclusion: "success",
  }));
  const jobs = entries.map(([, name], i) => ({
    id: i + 10,
    name: `integration / ${name}`,
    run_id: 123,
    run_attempt: 2,
    status: "completed",
    conclusion: "success",
  }));
  const native =
    includeNative && plan.jobs?.["native-platforms"]?.required
      ? nativeEvidence(plan, workflowHeadSha)
      : { jobs: [], summary: undefined };
  const templates = plan.qualification
    ? (plan.templateMatrix?.template ?? []).map((template, i) => ({
        id: 500 + i,
        name: `template-nonvisual (${template})`,
        run_id: 123,
        run_attempt: 2,
        head_sha: workflowHeadSha,
        status: "completed",
        conclusion: "success",
        steps: [{ name: "Check pristine template", status: "completed", conclusion: "success" }],
      }))
    : [];
  const observed = [...jobs, ...native.jobs, ...templates];
  mkdirSync(directory, { recursive: true });
  const apiFile = path.join(directory, "jobs.json");
  writeFileSync(apiFile, JSON.stringify([{ total_count: observed.length, jobs: observed }]));
  writeFileSync(
    path.join(directory, "gh"),
    '#!/usr/bin/env node\nprocess.stdout.write(require("node:fs").readFileSync(process.env.CI_FIXTURE_API));\n',
  );
  chmodSync(path.join(directory, "gh"), 0o755);
  return {
    env: {
      GITHUB_SHA: plan.candidateSha,
      TN_CI_NATIVE_RECEIPT: JSON.stringify(native.summary),
      GITHUB_REPOSITORY: "fixture/repo",
      GITHUB_RUN_ID: current.runId,
      GITHUB_RUN_ATTEMPT: current.runAttempt,
      CI_FIXTURE_API: apiFile,
      PATH: `${directory}:${process.env.PATH}`,
      TN_CI_INTEGRATION_RECEIPT: JSON.stringify({ version: 1, ...current, receipts }),
    },
    receipts,
    jobs: observed,
    apiFile,
  };
}

// Explicit policy fixture, deliberately independent of production inventory parsing.
export function nativeEvidence(
  plan: {
    candidateSha: string;
    version: number;
    nativeTier?: string;
  },
  workflowHeadSha = plan.candidateSha,
) {
  const singles = [
    ["scope", "Validate caller selection and candidate"],
    ["web-reference", "Commit-keyed web conformance reference"],
    ["android-v8-source", "Android V8 source payload"],
    ["android-emulator-parity", "Android emulator visual parity"],
    ["desktop-parity", "Desktop web/native parity"],
    ["release-reports", "Gate-schema release evidence reports"],
    ["performance-coverage", "Native collector evidence coverage"],
    ["networking-matrix", "Networking qualification matrix"],
  ].map(([job, name]) => ({ job: job ?? "", name, platform: "" }));
  const matrix = [
    {
      job: "starter-linux",
      name: "Scaffolded starter desktop artifact (linux-x64)",
      platform: "linux-x64",
    },
    ...(plan.nativeTier === "full"
      ? [
          {
            job: "starter-linux",
            name: "Scaffolded starter desktop artifact (linux-arm64)",
            platform: "linux-arm64",
          },
          { job: "desktop", name: "Windows desktop core", platform: "Windows" },
          { job: "desktop", name: "macOS desktop core", platform: "macOS" },
        ]
      : []),
  ];
  const legs = [...singles, ...matrix];
  const jobs = legs.map((leg, i) => ({
    id: 300 + i,
    name: `native-platforms / ${leg.name}`,
    run_id: 123,
    run_attempt: 2,
    head_sha: workflowHeadSha,
    status: "completed",
    conclusion: "success",
  }));
  const current = {
    candidateSha: plan.candidateSha,
    runId: "123",
    runAttempt: "2",
    planVersion: plan.version,
  };
  const receipts = legs.flatMap((leg, i) =>
    ["android-emulator-parity", "desktop-parity", "desktop", "starter-linux"].includes(leg.job)
      ? [
          {
            version: 1,
            ...current,
            job: leg.platform ? `${leg.job}:${leg.platform}` : leg.job,
            jobId: String(jobs[i]?.id),
            conclusion: "success",
            buildVariant: leg.job === "android-emulator-parity" ? "Debug" : "Release",
            backend:
              leg.job === "android-emulator-parity" || leg.platform === "linux-arm64"
                ? "wgpu"
                : "Dawn",
            engine: "V8",
            artifactSha256: "c".repeat(64),
            configSha256: "d".repeat(64),
            reportSha256: "e".repeat(64),
          },
        ]
      : [],
  );
  return { jobs, summary: { version: 1, ...current, receipts } };
}
