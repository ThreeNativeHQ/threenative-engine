import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const { selectionPlan } = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);
const { integrationEvidence } = await import(
  new URL("../../test-support/ci-integration-fixture.ts", import.meta.url).href
);
const root = path.resolve(import.meta.dirname, "../..");
const candidate = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).stdout.trim();
const plan = selectionPlan(
  "full",
  "full native qualification fixture",
  [],
  candidate,
  true,
  0,
  "develop",
  true,
);
const descriptors = (
  [
    ["scope", "Validate caller selection and candidate", ""],
    ["web-reference", "Commit-keyed web conformance reference", ""],
    ["android-v8-source", "Android V8 source payload", ""],
    ["android-emulator-parity", "Android emulator visual parity", ""],
    ["desktop-parity", "Desktop web/native parity", ""],
    ["release-reports", "Gate-schema release evidence reports", ""],
    ["performance-coverage", "Native collector evidence coverage", ""],
    ["networking-matrix", "Networking qualification matrix", ""],
    ["desktop", "Windows desktop core", "Windows"],
    ["desktop", "macOS desktop core", "macOS"],
    ["starter-linux", "Scaffolded starter desktop artifact (linux-x64)", "linux-x64"],
    ["starter-linux", "Scaffolded starter desktop artifact (linux-arm64)", "linux-arm64"],
    ["ios-simulator", "iOS simulator runtime and no-Xcode consumer handoff", ""],
  ] as const
).map(([job, name, platform]) => ({
  job,
  platform,
  key: platform ? `${job}:${platform}` : job,
  name: `native-platforms / ${name}`,
}));
const runtimes = new Set(["android-emulator-parity", "desktop-parity", "desktop", "starter-linux"]);

function fixture() {
  const directory = makeTempDirSync("native-authoritative-gate-");
  const integration = integrationEvidence(root, path.join(directory, "bin"), plan, false);
  const jobs = descriptors.map((leg, index) => ({
    id: 300 + index,
    name: leg.name,
    run_id: 123,
    run_attempt: 2,
    head_sha: candidate,
    status: "completed",
    conclusion: "success",
  }));
  const receipts = descriptors
    .filter((leg) => runtimes.has(leg.job))
    .map((leg) => {
      const observed = jobs.find((job) => job.name === leg.name);
      return {
        version: 1,
        candidateSha: candidate,
        runId: "123",
        runAttempt: "2",
        planVersion: 2,
        job: leg.key,
        jobId: String(observed?.id),
        conclusion: "success",
        buildVariant: leg.job === "android-emulator-parity" ? "Debug" : "Release",
        backend:
          leg.platform === "linux-arm64" || leg.job === "android-emulator-parity" ? "wgpu" : "Dawn",
        engine: "V8",
        artifactSha256: "c".repeat(64),
        configSha256: "d".repeat(64),
        reportSha256: "e".repeat(64),
      };
    });
  const summary = {
    version: 1,
    candidateSha: candidate,
    runId: "123",
    runAttempt: "2",
    planVersion: 2,
    receipts,
  };
  const needs = {
    scope: { result: "success", outputs: { plan: JSON.stringify(plan) } },
    ...Object.fromEntries(Object.keys(plan.jobs).map((name) => [name, { result: "success" }])),
  };
  const run = () => {
    const observed = [...integration.jobs, ...jobs];
    writeFileSync(
      integration.apiFile,
      JSON.stringify([{ total_count: observed.length, jobs: observed }]),
    );
    return spawnSync(process.execPath, [path.join(root, "scripts/ci-required.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        ...integration.env,
        TN_CI_NEEDS: JSON.stringify(needs),
        TN_CI_EVENT: "merge_group",
        TN_CI_BASE_REF: "develop",
        TN_CI_BASE_SHA: candidate,
        TN_CI_HEAD_SHA: candidate,
        TN_CI_NATIVE_RECEIPT: JSON.stringify(summary),
      },
    });
  };
  const reject = () => {
    const result = run();
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).not.toContain("CI_INTEGRATION_");
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("CI_NATIVE_");
  };
  return {
    jobs,
    summary,
    run,
    reject,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

describe("authoritative full native qualification through ci-required", () => {
  it("accepts complete current candidate/attempt supported evidence", () => {
    const f = fixture();
    try {
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      f.cleanup();
    }
  });
  it("never empties required Windows/macOS inventory when the entire desktop matrix skips", () => {
    const f = fixture();
    try {
      f.jobs.splice(
        0,
        f.jobs.length,
        ...f.jobs.filter((job) => !/Windows desktop core|macOS desktop core/u.test(job.name)),
        {
          id: 999,
          name: "native-platforms / ${{ matrix.platform }} desktop core",
          run_id: 123,
          run_attempt: 2,
          head_sha: candidate,
          status: "completed",
          conclusion: "skipped",
        },
      );
      f.reject();
    } finally {
      f.cleanup();
    }
  });
  it.each(
    [
      "Windows desktop core",
      "macOS desktop core",
      "Scaffolded starter desktop artifact (linux-arm64)",
      "Scaffolded starter desktop artifact (linux-x64)",
      "Android emulator visual parity",
    ].flatMap((name) =>
      ["missing", "skipped", "cancelled", "failure"].map((status) => [name, status]),
    ),
  )("rejects supported leg %s reporting %s", (name, status) => {
    const f = fixture();
    try {
      const index = f.jobs.findIndex((job) => job.name === `native-platforms / ${name}`);
      expect(index).toBeGreaterThanOrEqual(0);
      const observed = f.jobs[index];
      if (!observed) throw new Error("missing fixture job");
      if (status === "missing") f.jobs.splice(index, 1);
      else f.jobs[index] = { ...observed, conclusion: status };
      f.reject();
    } finally {
      f.cleanup();
    }
  });
  it.each([{ head_sha: "b".repeat(40) }, { run_attempt: 1 }, { id: 9999 }])(
    "rejects wrong native API identity %j",
    (change) => {
      const f = fixture();
      try {
        const index = f.jobs.findIndex((job) => job.name.endsWith("Windows desktop core"));
        const observed = f.jobs[index];
        if (!observed) throw new Error("missing fixture job");
        f.jobs[index] = { ...observed, ...change };
        f.reject();
      } finally {
        f.cleanup();
      }
    },
  );
  it.each([
    { candidateSha: "b".repeat(40) },
    { runAttempt: "1" },
    { buildVariant: "Debug" },
    { backend: "wgpu" },
    { engine: "QuickJS" },
    { configSha256: "" },
  ])("rejects wrong supported build envelope %j", (change) => {
    const f = fixture();
    try {
      const index = f.summary.receipts.findIndex((row) => row.job === "desktop:Windows");
      const receipt = f.summary.receipts[index];
      if (!receipt) throw new Error("missing fixture receipt");
      f.summary.receipts[index] = { ...receipt, ...change };
      f.reject();
    } finally {
      f.cleanup();
    }
  });
  it.each(["failure", "missing"])("keeps iOS %s advisory without certifying it", (status) => {
    const f = fixture();
    try {
      const index = f.jobs.findIndex((job) => job.name.includes("iOS"));
      expect(index).toBeGreaterThanOrEqual(0);
      const observed = f.jobs[index];
      if (!observed) throw new Error("missing fixture job");
      if (status === "missing") f.jobs.splice(index, 1);
      else f.jobs[index] = { ...observed, conclusion: "failure" };
      const result = f.run();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      f.cleanup();
    }
  });
});
