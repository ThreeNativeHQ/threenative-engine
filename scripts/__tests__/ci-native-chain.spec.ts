import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyTemplateOwnership,
  integrationEvidence,
  nativeEvidence,
} from "../../test-support/ci-integration-fixture.js";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
const { selectionPlan } = await import(new URL("../ci-change-scope.mjs", import.meta.url).href);
const { nativeInventory, nativeBuildProfile, validateNativeWorkflow, validateNativeReceipts } =
  await import(new URL("../ci-native-qualification.mjs", import.meta.url).href);
const repository = path.resolve(import.meta.dirname, "../..");
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const bytes = "CPU fixture runtime; never executable";
const artifactSha = digest(bytes);
function fixture() {
  const root = makeTempDirSync("native-receipt-chain-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  git("init", "-q", "--initial-branch=develop");
  git("config", "user.name", "CPU fixture");
  git("config", "user.email", "ci@example.invalid");
  mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  for (const name of ["native-platforms", "integration"])
    cpSync(
      path.join(repository, `.github/workflows/${name}.yml`),
      path.join(root, `.github/workflows/${name}.yml`),
    );
  copyTemplateOwnership(root, repository);
  git("add", ".");
  git("commit", "-qm", "CPU workflow candidate");
  const sha = git("rev-parse", "HEAD");
  const plan = selectionPlan("full", "CPU qualification", [], sha, true, 0, "develop", true);
  const integration = integrationEvidence(root, path.join(root, "bin"), plan, false);
  const native = nativeEvidence(plan);
  const listing = [...integration.jobs, ...native.jobs];
  const output = path.join(root, "output");
  writeFileSync(output, "");
  const runnerTemp = path.join(root, "runner-temp");
  const env = {
    ...process.env,
    ...integration.env,
    TN_CI_PLAN: JSON.stringify(plan),
    TN_CI_EVENT: "merge_group",
    TN_CI_BASE_REF: "develop",
    TN_CI_CANDIDATE_SHA: sha,
    TN_CI_WORKFLOW_HEAD_SHA: sha,
    TN_CI_NATIVE_REUSABLE: "true",
    TN_CI_JOB_RESULT: "success",
    GITHUB_WORKSPACE: root,
    GITHUB_OUTPUT: output,
    RUNNER_TEMP: runnerTemp,
  };
  const publish = () =>
    writeFileSync(
      integration.apiFile,
      JSON.stringify([{ total_count: listing.length, jobs: listing }]),
    );
  publish();
  const run = (file: string, args: string[], overrides = {}) =>
    spawnSync(process.execPath, [path.join(repository, "scripts", file), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...env, ...overrides },
    });
  const write = (relative: string, value: string | object) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const populate = (leg: { job: string; platform: string }) => {
    const runtime = "packages/runtime-native";
    const profile = nativeBuildProfile(leg);
    const cache = `CMAKE_BUILD_TYPE:STRING=${profile.buildVariant}\nMYSTRAL_USE_V8:BOOL=${profile.engine === "V8" ? "ON" : "OFF"}\nMYSTRAL_USE_QUICKJS:BOOL=${profile.engine === "QuickJS" ? "ON" : "OFF"}\nMYSTRAL_USE_DAWN:BOOL=${profile.backend === "Dawn" ? "ON" : "OFF"}\nMYSTRAL_USE_WGPU:BOOL=${profile.backend === "wgpu" ? "ON" : "OFF"}\n`;
    if (leg.job === "android-emulator-parity") {
      write(
        `${runtime}/android/app/build/intermediates/merged_native_libs/debug/out/lib/x86_64/libmystral-runtime.so`,
        bytes,
      );
      write(
        `${runtime}/android/app/build/intermediates/cxx/Debug/fixture/obj/x86_64/libmystral-runtime.so`,
        bytes,
      );
      const androidLibrary = path.join(
        root,
        runtime,
        "android/app/build/intermediates/cxx/Debug/fixture/obj/x86_64/libmystral-runtime.so",
      );
      write(
        `${runtime}/android/app/.cxx/Debug/fixture/x86_64/build.ninja`,
        `build CMakeFiles/mystral-runtime.dir/runtime.cpp.o: CXX_COMPILER__mystral-runtime_Debug /src/runtime.cpp\n  FLAGS = -O2\nbuild ${androidLibrary}: CXX_SHARED_LIBRARY_LINKER__mystral-runtime_Debug CMakeFiles/mystral-runtime.dir/runtime.cpp.o\n`,
      );
      write(
        `${runtime}/android/app/.cxx/Debug/fixture/x86_64/CMakeFiles/rules.ninja`,
        "rule CXX_COMPILER__mystral-runtime_Debug\n  command = clang++ $DEFINES $INCLUDES $FLAGS -c $in -o $out\n",
      );
      write(`${runtime}/android/app/.cxx/Debug/fixture/x86_64/CMakeCache.txt`, cache);
      const apk = write(`${runtime}/android/app/build/outputs/apk/debug/app-debug.apk`, "");
      const zipped = spawnSync(
        "python3",
        [
          "-c",
          "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('lib/x86_64/libmystral-runtime.so',sys.argv[2]);z.close()",
          apk,
          bytes,
        ],
        { encoding: "utf8" },
      );
      expect(zipped.status, zipped.stderr).toBe(0);
    } else {
      const preset =
        leg.platform === "Windows"
          ? "tn-windows"
          : leg.platform === "macOS"
            ? "tn-macos"
            : "tn-linux";
      write(`${runtime}/build/${preset}/mystral${leg.platform === "Windows" ? ".exe" : ""}`, bytes);
      write(`${runtime}/build/${preset}/CMakeCache.txt`, cache);
    }
    if (["android-emulator-parity", "desktop-parity"].includes(leg.job)) {
      const target = leg.job === "desktop-parity" ? "desktop" : "android";
      write(`${runtime}/conformance/registry.json`, {
        schemaVersion: "fixture",
        threeVersion: "fixture",
        tests: [{ id: "fixture", status: "implemented" }],
      });
      write(`${runtime}/artifacts/conformance/${target}/report.json`, {
        schemaVersion: "0.3.0",
        registrySchemaVersion: "fixture",
        threeVersion: "fixture",
        target,
        project: null,
        mode: "execution",
        provenance: {
          commit: sha,
          dirty: false,
          runtimeSha256: target === "desktop" ? artifactSha : null,
          referenceSetSha256: "f".repeat(64),
          device: null,
          env: [{ key: "CI", valueSha256: digest("true") }],
        },
        results: [
          {
            id: "fixture",
            status: "pass",
            browser: { completed: true, uniform: false },
            native: { completed: true, uniform: false, runtimeLibraries: { x86_64: artifactSha } },
            metrics: { pixelMismatchRatio: 0, perceptualDeltaE: 0 },
            gpuValidationErrors: [],
          },
        ],
        summary: { pass: 1, fail: 0, blocked: 0, planned: 0, validated: 0 },
        supplemental:
          target === "android" ? { androidMultitouch: { status: "pass", exitCode: 0 } } : {},
      });
    } else if (leg.job === "desktop") {
      // Genuine producer shape: packaged game hash differs from the bare runtime hash.
      write(`${runtime}/artifacts/performance-contract/${leg.platform}/production-evidence.json`, {
        version: "productionEvidenceV1",
        target: "desktop",
        source: { sha, dirty: false },
        artifact: { sha256: digest("composite packaged evidence") },
        identity: { nativeBinarySha256: digest("packaged game executable") },
        command: [],
        markers: [],
        metrics: {},
        budget: {},
      });
      write(
        `${runtime}/artifacts/desktop-${leg.platform === "Windows" ? "win32" : "darwin"}-report.json`,
        {
          pass: true,
          frames: 2,
          host: { platform: leg.platform === "Windows" ? "win32" : "darwin" },
          artifact: { sha256: artifactSha },
        },
      );
    } else {
      const project = path.relative(root, path.join(runnerTemp, "threenative-starter-native"));
      write(`${project}/package.json`, { name: "starter" });
      write(`${project}/dist-native/starter`, "packaged consumer");
      write(`${project}/artifacts/native/consumer-targets.json`, [
        {
          target: "desktop",
          os: "linux",
          osVersion: "fixture",
          architecture: "fixture",
          session: "fixture",
          scenario: "fixture",
          applicationId: "fixture",
          artifactHash: digest("packaged consumer"),
          pass: true,
          assertions: 1,
          assertionIds: ["fixture"],
          failures: [],
        },
      ]);
    }
  };
  return {
    root,
    sha,
    plan,
    native,
    listing,
    output,
    publish,
    run,
    write,
    populate,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("actual native receipt writer, collector and protected verdict", () => {
  it("joins all six producer-shaped runtime envelopes through the current API attempt", () => {
    const f = fixture();
    try {
      for (const leg of nativeInventory(f.plan).filter(
        (row: { runtime: boolean }) => row.runtime,
      )) {
        f.populate(leg);
        const result = f.run("ci-native-receipts.mjs", ["--write"], {
          GITHUB_JOB: leg.job,
          TN_CI_NATIVE_PLATFORM: leg.platform,
        });
        expect(result.status, result.stderr).toBe(0);
      }
      const collected = f.run("ci-native-receipts.mjs", [
        "--collect",
        path.join(f.root, "artifacts/ci-native-receipts"),
      ]);
      expect(collected.status, collected.stderr).toBe(0);
      const summary = readFileSync(f.output, "utf8")
        .trim()
        .replace(/^coverage_receipt=/u, "");
      const needs = {
        scope: { result: "success", outputs: { plan: JSON.stringify(f.plan) } },
        ...Object.fromEntries(Object.keys(f.plan.jobs).map((job) => [job, { result: "success" }])),
      };
      const verdict = () =>
        f.run("ci-required.mjs", [], {
          TN_CI_NEEDS: JSON.stringify(needs),
          TN_CI_NATIVE_RECEIPT: summary,
          TN_CI_BASE_SHA: f.sha,
          TN_CI_HEAD_SHA: f.sha,
        });
      expect(verdict().status, verdict().stderr).toBe(0);
      const compiler = f.listing.find((row) => row.name === "template-nonvisual (starter)");
      if (!compiler || !("steps" in compiler)) throw new Error("missing fixture compiler step");
      const successfulSteps = compiler.steps;
      compiler.steps = [];
      f.publish();
      expect(verdict().stderr).toContain("CI_TEMPLATE_TYPECHECK_COMPILER_NOT_SUCCESS");
      compiler.steps = successfulSteps;
      const scheduledSource = "b".repeat(40);
      for (const row of f.listing) if ("head_sha" in row) row.head_sha = scheduledSource;
      f.publish();
      const scheduledVerdict = () =>
        f.run("ci-required.mjs", [], {
          TN_CI_NEEDS: JSON.stringify(needs),
          TN_CI_NATIVE_RECEIPT: summary,
          TN_CI_EVENT: "schedule",
          TN_CI_HEAD_SHA: "",
          GITHUB_SHA: scheduledSource,
        });
      expect(scheduledVerdict().status, scheduledVerdict().stderr).toBe(0);
      if (!("head_sha" in compiler)) throw new Error("missing compiler SHA");
      compiler.head_sha = f.sha;
      f.publish();
      expect(scheduledVerdict().stderr).toContain("CI_TEMPLATE_TYPECHECK_JOB_NOT_SUCCESS");
      for (const row of f.listing) if ("head_sha" in row) row.head_sha = f.sha;
      f.publish();
      const windows = f.listing.find((row) => row.name.endsWith("Windows desktop core"));
      if (!windows) throw new Error("missing fixture Windows job");
      windows.run_attempt = 1;
      f.publish();
      expect(verdict().stderr).toContain("CI_NATIVE_JOB_IDENTITY");
      expect(
        f.run("ci-native-receipts.mjs", [
          "--collect",
          path.join(f.root, "artifacts/ci-native-receipts"),
        ]).status,
      ).toBe(1);
    } finally {
      f.cleanup();
    }
  });
  it.each(["library", "target", "cache", "merged"])(
    "rejects Android %s substitution in the actual writer",
    (kind) => {
      const f = fixture();
      try {
        const leg = { job: "android-emulator-parity", platform: "" };
        f.populate(leg);
        const reportFile = path.join(
          f.root,
          "packages/runtime-native/artifacts/conformance/android/report.json",
        );
        const report = JSON.parse(readFileSync(reportFile, "utf8"));
        if (kind === "library") {
          report.results[0].native.runtimeLibraries.x86_64 = "a".repeat(64);
          writeFileSync(reportFile, JSON.stringify(report));
        }
        if (kind === "target") {
          report.target = "web";
          writeFileSync(reportFile, JSON.stringify(report));
        }
        if (kind === "cache")
          f.write(
            "packages/runtime-native/android/app/.cxx/Debug/fixture/x86_64/CMakeCache.txt",
            "CMAKE_BUILD_TYPE:STRING=Release\n",
          );
        if (kind === "merged")
          f.write(
            "packages/runtime-native/android/app/build/intermediates/merged_native_libs/debug/out/lib/x86_64/libmystral-runtime.so",
            "wrong library",
          );
        const result = f.run("ci-native-receipts.mjs", ["--write"], { GITHUB_JOB: leg.job });
        expect(result.status, result.stderr).toBe(1);
        const diagnostics = JSON.parse(
          readFileSync(
            path.join(
              f.root,
              "artifacts/ci-native-diagnostics/android-build-provenance-123-2.json",
            ),
            "utf8",
          ),
        );
        expect(diagnostics.candidateSha).toBe(f.sha);
        if (kind === "merged") {
          expect(result.stderr).toContain("TN_ANDROID_JS_O2_PROVENANCE_MISSING");
          expect(diagnostics.diagnostics).toContainEqual(
            expect.objectContaining({ reason: "raw-merged-mismatch", rawSha256: artifactSha }),
          );
        }
      } finally {
        f.cleanup();
      }
    },
  );
  it("runs the collector from a clean checkout with no installed dependency tree", () => {
    const f = fixture();
    try {
      const standalone = path.join(f.root, "clean");
      mkdirSync(path.join(standalone, "scripts"), { recursive: true });
      for (const name of [
        "ci-native-receipts.mjs",
        "ci-native-qualification.mjs",
        "ci-attempt-receipts.mjs",
        "ci-change-scope.mjs",
      ])
        cpSync(path.join(repository, "scripts", name), path.join(standalone, "scripts", name));
      mkdirSync(path.join(standalone, "packages/runtime-native/scripts"), { recursive: true });
      cpSync(
        path.join(repository, "packages/runtime-native/scripts/desktop-build-profile.mjs"),
        path.join(standalone, "packages/runtime-native/scripts/desktop-build-profile.mjs"),
      );
      cpSync(
        path.join(repository, "packages/runtime-native/CMakePresets.json"),
        path.join(standalone, "packages/runtime-native/CMakePresets.json"),
      );
      for (const name of readdirSync(
        path.join(repository, "packages/create-threenative/templates"),
      )) {
        const folder = path.join(standalone, "packages/create-threenative/templates", name);
        mkdirSync(folder, { recursive: true });
        cpSync(
          path.join(repository, "packages/create-threenative/templates", name, "kit.json"),
          path.join(folder, "kit.json"),
        );
      }
      const artifacts = path.join(f.root, "receipt-fixture");
      mkdirSync(artifacts);
      for (const row of f.native.summary.receipts)
        writeFileSync(
          path.join(artifacts, `${row.job.replace(":", "-")}.json`),
          JSON.stringify(row),
        );
      const result = f.run(
        path.relative(
          path.join(repository, "scripts"),
          path.join(standalone, "scripts/ci-native-receipts.mjs"),
        ),
        ["--collect", artifacts],
      );
      expect(result.status, result.stderr).toBe(0);
    } finally {
      f.cleanup();
    }
  });
  it("preserves reduced inventory and standalone names; rejects duplicates, truncation and unknown rows", () => {
    const f = fixture();
    try {
      const plan = { ...f.plan, nativeTier: "reduced" };
      const evidence = nativeEvidence(plan);
      const expected = {
        candidateSha: f.sha,
        runId: "123",
        runAttempt: "2",
        planVersion: 2,
        workflowHeadSha: f.sha,
        legs: nativeInventory(plan),
      };
      expect(() =>
        validateNativeReceipts(expected, evidence.summary, {
          totalCount: evidence.jobs.length,
          jobs: evidence.jobs,
        }),
      ).not.toThrow();
      const standalone = { ...expected, prefix: "", legs: nativeInventory(plan, "") };
      expect(() =>
        validateNativeReceipts(standalone, evidence.summary, {
          totalCount: evidence.jobs.length,
          jobs: evidence.jobs.map((row) => ({
            ...row,
            name: row.name.replace("native-platforms / ", ""),
          })),
        }),
      ).not.toThrow();
      for (const listing of [
        { totalCount: evidence.jobs.length + 1, jobs: evidence.jobs },
        { totalCount: evidence.jobs.length + 1, jobs: [...evidence.jobs, evidence.jobs[0]] },
        {
          totalCount: evidence.jobs.length + 1,
          jobs: [
            ...evidence.jobs,
            { ...evidence.jobs[0], id: 999, name: "native-platforms / Unsupported new row" },
          ],
        },
      ])
        expect(() => validateNativeReceipts(expected, evidence.summary, listing)).toThrow(
          "CI_NATIVE_",
        );
      const workflow = readFileSync(
        path.join(repository, ".github/workflows/native-platforms.yml"),
        "utf8",
      );
      expect(() =>
        validateNativeWorkflow(
          workflow.replace("          - platform: Windows", "          - platform: Unsupported"),
        ),
      ).toThrow("CI_NATIVE_WORKFLOW_POLICY");
      expect(workflow).toContain(
        "needs.scope.outputs.native_tier == 'full' && inputs.ios_only != true && 'Windows,macOS'",
      );
      expect(workflow).toContain("if: ${{ always() && inputs.ios_only != true }}");
      expect(workflow).not.toContain("needs.desktop.result != 'skipped'");
    } finally {
      f.cleanup();
    }
  });
});

it("rejects dirty desktop provenance even when the tracked diff hash is empty", () => {
  const f = fixture();
  try {
    const leg = { job: "desktop", platform: "macOS" };
    f.populate(leg);
    const file = path.join(
      f.root,
      "packages/runtime-native/artifacts/performance-contract/macOS/production-evidence.json",
    );
    const report = JSON.parse(readFileSync(file, "utf8"));
    report.source = { sha: f.sha, dirty: true, diffSha: digest("") };
    writeFileSync(file, JSON.stringify(report));
    const result = f.run("ci-native-receipts.mjs", ["--write"], {
      GITHUB_JOB: leg.job,
      TN_CI_NATIVE_PLATFORM: leg.platform,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("production report is stale or belongs to another runtime");
  } finally {
    f.cleanup();
  }
});

it("excludes only the compiler cache from source dirt while exposing adjacent unexpected files", () => {
  const root = makeTempDirSync("native-ccache-source-state-");
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  try {
    git("init", "-q");
    cpSync(path.join(repository, ".gitignore"), path.join(root, ".gitignore"));
    git("add", ".gitignore");
    git("-c", "user.name=CPU", "-c", "user.email=ci@example.invalid", "commit", "-qm", "candidate");
    mkdirSync(path.join(root, ".cache/ccache"), { recursive: true });
    writeFileSync(path.join(root, ".cache/ccache/stats"), "opaque compiler cache output");
    expect(git("diff", "HEAD")).toBe("");
    expect(git("status", "--porcelain=v1", "--untracked-files=all")).toBe("");
    writeFileSync(path.join(root, ".cache/unexpected-source.mjs"), "unexpected source");
    expect(git("status", "--porcelain=v1", "--untracked-files=all")).toContain(
      ".cache/unexpected-source.mjs",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("opt-in Linux arm64 V8 auxiliary producer", () => {
  const workflow = readFileSync(
    path.join(repository, ".github/workflows/native-platforms.yml"),
    "utf8",
  );
  it("validates auxiliary jobs without growing either product inventory", () => {
    expect(() => validateNativeWorkflow(workflow)).not.toThrow();
    const common = [
      "scope",
      "web-reference",
      "android-v8-source",
      "android-emulator-parity",
      "desktop-parity",
      "release-reports",
      "performance-coverage",
      "networking-matrix",
    ];
    for (const nativeTier of ["full", "reduced"]) {
      const legs = nativeInventory({
        jobs: { "native-platforms": { required: true } },
        nativeTier,
      });
      expect(legs.map((leg: { key: string }) => leg.key)).toEqual([
        ...common,
        ...(nativeTier === "full" ? ["desktop:Windows", "desktop:macOS"] : []),
        "starter-linux:linux-x64",
        ...(nativeTier === "full" ? ["starter-linux:linux-arm64"] : []),
      ]);
    }
  });
  it.each([
    ["manual event gate", "github.event_name == 'workflow_dispatch' && ", ""],
    ["explicit choice gate", "inputs.build_linux_arm64_v8 == true && ", ""],
    [
      "disabled choice",
      "inputs.build_linux_arm64_v8 == true",
      "inputs.build_linux_arm64_v8 != false",
    ],
    ["producer registration", "  linux-arm64-v8-source:\n", "  unknown-cache-producer:\n"],
    ["completion join", ", linux-arm64-v8-source, publish-linux-arm64-v8]", "]"],
  ])("rejects a changed %s", (_label, before, after) => {
    expect(workflow).toContain(before);
    expect(() => validateNativeWorkflow(workflow.replace(before, after))).toThrow(
      "CI_NATIVE_WORKFLOW_POLICY",
    );
  });
  it("rejects an additional unregistered job", () => {
    expect(() =>
      validateNativeWorkflow(`${workflow}\n  unknown-cache-producer:\n    name: Unknown\n`),
    ).toThrow("CI_NATIVE_WORKFLOW_POLICY");
  });
});
