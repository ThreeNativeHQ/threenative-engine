// Functional scheduling authority: independent of observed results and performance calibration.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  desktopBuildOverrides,
  desktopPreset,
} from "../packages/runtime-native/scripts/desktop-build-profile.mjs";
import { validateEventPlan } from "./ci-change-scope.mjs";

export const NATIVE_JOBS = Object.freeze({
  scope: "Validate caller selection and candidate",
  "web-reference": "Commit-keyed web conformance reference",
  "android-v8-source": "Android V8 source payload",
  "android-emulator-parity": "Android emulator visual parity",
  "desktop-parity": "Desktop web/native parity",
  "release-reports": "Gate-schema release evidence reports",
  "performance-coverage": "Native collector evidence coverage",
  "networking-matrix": "Networking qualification matrix",
  desktop: "${{ matrix.platform }} desktop core",
  "starter-linux": "Scaffolded starter desktop artifact (${{ matrix.platform }})",
});
const EXEMPT = {
  "linux-arm64-v8-source": "Linux arm64 V8 source payload",
  "ios-simulator": "iOS simulator runtime and no-Xcode consumer handoff",
  "publish-android-v8": "Publish the Android V8 payload",
  "publish-linux-arm64-v8": "Publish the Linux arm64 V8 payload",
  completion: "Native required coverage receipt",
};
const full = "needs.scope.outputs.selection == 'full' && inputs.ios_only != true";
const GATES = {
  scope: "",
  "web-reference": "needs.scope.outputs.selection == 'full' && inputs.ios_only == false",
  "android-v8-source": full,
  "linux-arm64-v8-source":
    "github.event_name == 'workflow_dispatch' && inputs.build_linux_arm64_v8 == true && needs.scope.outputs.selection == 'full' && needs.scope.outputs.native_tier != 'reduced' && inputs.ios_only != true",
  "android-emulator-parity": `${full} && needs.android-v8-source.result == 'success'`,
  "desktop-parity": full,
  "release-reports": "needs.scope.outputs.selection != 'prose' && inputs.ios_only == false",
  "performance-coverage": "${{ !cancelled() && needs.scope.outputs.selection == 'full' }}",
  "networking-matrix": "${{ always() && needs.scope.outputs.selection == 'full' }}",
  desktop: `${full} && needs.scope.outputs.native_tier == 'full'`,
  "starter-linux": full,
  "ios-simulator":
    "needs.scope.outputs.selection == 'full' && needs.scope.outputs.native_tier == 'full'",
  "publish-android-v8":
    "needs.android-v8-source.outputs.published == 'false' && github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop')",
  "publish-linux-arm64-v8":
    "needs.linux-arm64-v8-source.outputs.published == 'false' && github.event_name != 'pull_request' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/develop')",
  completion: "${{ always() && inputs.ios_only != true }}",
};
const RUNTIME = new Set(["android-emulator-parity", "desktop-parity", "desktop", "starter-linux"]);
const fail = (code, message) => {
  throw new Error(`CI_NATIVE_${code}: ${message}`);
};
const normalize = (value) => value.replace(/\s+/gu, " ").trim();

export function validateNativeWorkflow(source) {
  const parts = source.split("\njobs:\n");
  if (
    parts.length !== 2 ||
    source.includes("\t") ||
    source.includes("\r") ||
    /^\S/mu.test(parts[1])
  )
    fail("WORKFLOW_POLICY", "ambiguous jobs mapping");
  const headings = [...parts[1].matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gmu)];
  const jobs = new Map(
    headings.map((h, i) => [h[1], parts[1].slice(h.index, headings[i + 1]?.index)]),
  );
  const names = { ...NATIVE_JOBS, ...EXEMPT };
  if (
    jobs.size !== headings.length ||
    JSON.stringify([...jobs.keys()].sort()) !== JSON.stringify(Object.keys(names).sort())
  )
    fail("WORKFLOW_POLICY", "missing, duplicate or unmapped job");
  for (const [id, body] of jobs) {
    const name = /^ {4}name: (.+)$/mu.exec(body)?.[1];
    const gate = /^ {4}if: ([^\n]+)(?:\n((?: {6}[^\n]*\n)*))?/mu.exec(body);
    const condition = gate ? normalize(gate[1] === ">-" ? (gate[2] ?? "") : gate[1]) : "";
    if (
      name !== names[id] ||
      condition !== GATES[id] ||
      (id !== "ios-simulator" && /^ {4}continue-on-error:/mu.test(body))
    )
      fail("WORKFLOW_POLICY", `unsupported name, condition or advisory policy: ${id}`);
  }
  if (!jobs.get("ios-simulator").includes("    continue-on-error: true"))
    fail("WORKFLOW_POLICY", "iOS advisory policy changed");
  const desktopRows = [...jobs.get("desktop").matchAll(/^ {10}- platform: (.+)$/gmu)]
    .map((m) => m[1])
    .sort();
  if (JSON.stringify(desktopRows) !== JSON.stringify(["Windows", "macOS"]))
    fail("WORKFLOW_POLICY", "desktop matrix differs from supported policy");
  const scope = jobs.get("scope");
  if (
    !scope.includes('{ platform: "linux-x64", runner:') ||
    !scope.includes('{ platform: "linux-arm64", runner: "ubuntu-24.04-arm" }') ||
    !scope.includes('const reduced = process.env.TN_NATIVE_TIER === "reduced";') ||
    !scope.includes("JSON.stringify({ include: reduced ? rows.slice(0, 1) : rows })") ||
    !jobs.get("starter-linux").includes("matrix: ${{ fromJSON(needs.scope.outputs.starter_rows) }}")
  )
    fail("WORKFLOW_POLICY", "starter expansion differs from supported policy");
  const expectedNeeds = [
    ...Object.keys(NATIVE_JOBS),
    "ios-simulator",
    "publish-android-v8",
    "linux-arm64-v8-source",
    "publish-linux-arm64-v8",
  ].sort();
  const needs = /^ {4}needs: \[([^\]]+)\]$/mu
    .exec(jobs.get("completion"))?.[1]
    .split(",")
    .map((s) => s.trim())
    .sort();
  if (JSON.stringify(needs) !== JSON.stringify(expectedNeeds))
    fail("WORKFLOW_POLICY", "completion does not join the entire native board");
}

export function nativeInventory(plan, prefix = "native-platforms / ") {
  if (!plan.jobs["native-platforms"].required) return [];
  if (plan.nativeTier !== "full" && plan.nativeTier !== "reduced")
    fail("PLAN", "required native tier is unknown");
  return Object.entries(NATIVE_JOBS).flatMap(([job, name]) => {
    const platforms =
      job === "desktop"
        ? plan.nativeTier === "full"
          ? ["Windows", "macOS"]
          : []
        : job === "starter-linux"
          ? plan.nativeTier === "full"
            ? ["linux-x64", "linux-arm64"]
            : ["linux-x64"]
          : [""];
    return platforms.map((platform) => ({
      job,
      platform,
      key: platform ? `${job}:${platform}` : job,
      name: `${prefix}${name.replace("${{ matrix.platform }}", platform)}`,
      runtime: RUNTIME.has(job),
    }));
  });
}

export function nativeCandidatePreflight({
  plan,
  eventName,
  target,
  candidateSha,
  runId,
  runAttempt,
  workflowHeadSha,
  reusable = true,
}) {
  validateEventPlan(plan, { eventName, baseRef: target });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (head !== candidateSha || plan.candidateSha !== candidateSha)
    fail("CANDIDATE", "checkout is not the selected candidate");
  validateNativeWorkflow(
    execFileSync("git", ["show", `${candidateSha}:.github/workflows/native-platforms.yml`], {
      encoding: "utf8",
    }),
  );
  if (!/^[0-9a-f]{40}$/u.test(workflowHeadSha ?? ""))
    fail("RUN_IDENTITY", "workflow source SHA missing");
  return {
    candidateSha,
    runId,
    runAttempt,
    workflowHeadSha,
    planVersion: plan.version,
    legs: nativeInventory(plan, reusable ? "native-platforms / " : ""),
    prefix: reusable ? "native-platforms / " : "",
  };
}

export function nativeBuildProfile(leg) {
  if (leg.job === "android-emulator-parity")
    return { buildVariant: "Debug", backend: "wgpu", engine: "V8" };
  const platform =
    leg.platform === "Windows" ? "win32" : leg.platform === "macOS" ? "darwin" : "linux";
  const presets = JSON.parse(
    readFileSync(new URL("../packages/runtime-native/CMakePresets.json", import.meta.url), "utf8"),
  );
  const preset = presets.configurePresets.find((row) => row.name === desktopPreset(platform));
  const values = {
    ...preset.cacheVariables,
    ...desktopBuildOverrides(platform, leg.platform === "linux-arm64" ? "arm64" : "x64"),
  };
  if (
    values.MYSTRAL_USE_V8 === values.MYSTRAL_USE_QUICKJS ||
    values.MYSTRAL_USE_DAWN === values.MYSTRAL_USE_WGPU
  )
    fail("BUILD_POLICY", "ambiguous supported preset");
  return {
    buildVariant: values.CMAKE_BUILD_TYPE,
    backend: values.MYSTRAL_USE_DAWN === "ON" ? "Dawn" : "wgpu",
    engine: values.MYSTRAL_USE_V8 === "ON" ? "V8" : "QuickJS",
  };
}

export function nativeJobIdentity(expected, leg, listing, completed = true) {
  if (
    !Array.isArray(listing?.jobs) ||
    listing.totalCount !== listing.jobs.length ||
    new Set(listing.jobs.map((job) => job.id)).size !== listing.jobs.length
  )
    fail("API_INCOMPLETE", "incomplete or duplicate attempt listing");
  const matches = listing.jobs.filter((job) => job.name === leg.name);
  const job = matches[0];
  if (
    matches.length !== 1 ||
    !Number.isSafeInteger(job.id) ||
    job.id <= 0 ||
    String(job.run_id) !== expected.runId ||
    String(job.run_attempt) !== expected.runAttempt ||
    job.head_sha !== expected.workflowHeadSha ||
    (completed && (job.status !== "completed" || job.conclusion !== "success"))
  )
    fail("JOB_IDENTITY", `missing or unsuccessful exact-attempt leg: ${leg.key}`);
  return job;
}

export function validateNativeReceipts(expected, summary, listing) {
  if (
    summary?.version !== 1 ||
    summary.candidateSha !== expected.candidateSha ||
    summary.runId !== expected.runId ||
    summary.runAttempt !== expected.runAttempt ||
    summary.planVersion !== expected.planVersion ||
    !Array.isArray(summary.receipts)
  )
    fail("RECEIPT_IDENTITY", "missing exact current-attempt completion receipt");
  const runtimes = expected.legs.filter((leg) => leg.runtime);
  if (
    summary.receipts.length !== runtimes.length ||
    new Set(summary.receipts.map((row) => row.job)).size !== runtimes.length
  )
    fail("RECEIPT_INVENTORY", "missing or duplicate supported runtime envelope");
  for (const leg of expected.legs) {
    const job = nativeJobIdentity(expected, leg, listing);
    if (!leg.runtime) continue;
    const receipt = summary.receipts.find((row) => row.job === leg.key);
    const profile = nativeBuildProfile(leg);
    if (
      !receipt ||
      receipt.version !== 1 ||
      receipt.candidateSha !== expected.candidateSha ||
      receipt.runId !== expected.runId ||
      receipt.runAttempt !== expected.runAttempt ||
      receipt.planVersion !== expected.planVersion ||
      receipt.jobId !== String(job.id) ||
      receipt.conclusion !== "success" ||
      Object.entries(profile).some(([key, value]) => receipt[key] !== value) ||
      ["artifactSha256", "configSha256", "reportSha256"].some(
        (key) => !/^[0-9a-f]{64}$/u.test(receipt[key] ?? ""),
      )
    )
      fail(
        "BUILD_IDENTITY",
        `wrong candidate, attempt, artifact, report or configured backend: ${leg.key}`,
      );
  }
  // Unmapped expanded runtime rows cannot hide behind the reusable aggregate.
  const known = new Set(expected.legs.map((leg) => leg.name));
  for (const job of listing.jobs) {
    if (
      job.name?.startsWith(expected.prefix ?? "native-platforms / ") &&
      !known.has(job.name) &&
      !Object.values(EXEMPT).some(
        (name) => job.name === `${expected.prefix ?? "native-platforms / "}${name}`,
      ) &&
      !["desktop", "starter-linux"].some(
        (id) => job.name === `${expected.prefix ?? "native-platforms / "}${NATIVE_JOBS[id]}`,
      ) &&
      !nativeInventory(
        {
          jobs: { "native-platforms": { required: true } },
          nativeTier: "full",
        },
        expected.prefix ?? "native-platforms / ",
      ).some((leg) => leg.name === job.name)
    )
      fail("JOB_INVENTORY", `unmapped native job: ${job.name}`);
  }
}
