import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, test } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const root = resolve(import.meta.dirname, "../..");
const workflow = readFileSync(join(root, ".github/workflows/native-release.yml"), "utf8");
const sha = "a".repeat(40);

function job(name: string): string {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `missing job ${name}`);
  return workflow.slice(start + 1).split(/\n\x20{2}[\w-]+:\n/u)[0] ?? "";
}

function script(name: string): string {
  const step = workflow.split(`      - name: ${name}\n`)[1];
  assert.ok(step, `missing step ${name}`);
  const block = step.split(/\n\x20{6}- /u)[0]?.split(/\n\x20{8}run: \|\n/u)[1];
  assert.ok(block, `missing script ${name}`);
  return block
    .split("\n")
    .map((line) => line.replace(/^\x20{10}/u, ""))
    .join("\n");
}

function allowed(
  name: string,
  event: string,
  refType: string,
  results: Record<string, string> = {},
  triggerEvent = "push",
  pullRequest: { base?: string; labels?: readonly string[] } = {},
): boolean {
  const body = job(name).split("\n    steps:")[0] ?? "";
  const expression = body.match(/\n\x20{4}if: (?:>-\n)?([\s\S]*?)(?=\n\x20{4}[a-z]|$)/u)?.[1];
  assert.ok(expression, `missing explicit job condition for ${name}`);
  const condition = expression
    .replace(/\$\{\{|\}\}/gu, "")
    .replace(/needs\.([\w-]+)/gu, 'needs["$1"]')
    // `labels.*.name` is GitHub's array filter; the fake event carries the names directly.
    .replace(/labels\.\*\.name/gu, "labelNames");
  const needs = Object.fromEntries(
    [
      "validate-tag",
      "gates",
      "build",
      "build-android",
      "build-ios-simulator",
      "publish",
      "clean-consumer",
      "clean-consumer-ios",
      "clean-consumer-windows",
    ].map((key) => [
      key,
      {
        result: results[key] ?? "success",
        outputs: {
          candidate_sha: sha,
          proof_run: results.proofRun ?? "",
          override: results.override ?? "",
        },
      },
    ]),
  );
  const validation = needs["validate-tag"];
  assert.ok(validation);
  if (results["validate-tag"] === "skipped") validation.outputs.candidate_sha = "";
  const evaluate = new Function(
    "github",
    "needs",
    "cancelled",
    "always",
    "startsWith",
    "contains",
    `return Boolean(${condition});`,
  );
  return evaluate(
    {
      event_name: event,
      event: {
        workflow_run: { event: triggerEvent },
        pull_request: {
          base: { ref: pullRequest.base ?? "develop" },
          labelNames: pullRequest.labels ?? [],
        },
      },
      ref_type: refType,
      ref: refType === "tag" ? "refs/tags/runtime-native-v0.3.1" : "refs/heads/main",
      sha,
    },
    needs,
    () => false,
    () => true,
    (text: string, prefix: string) => text.startsWith(prefix),
    (values: unknown, needle: unknown) => Array.isArray(values) && values.includes(needle),
  );
}

test("a release starts by a dispatch on its tag, and main CI starts nothing here", () => {
  const triggers = workflow.split("\npermissions:")[0] ?? "";
  assert.doesNotMatch(triggers, /workflow_run:/u);
  assert.doesNotMatch(triggers, /\n\x20{2}push:/u);
  assert.match(triggers, /\n\x20{2}workflow_dispatch:\n\x20{4}inputs:\n\x20{6}override:/u);
});

for (const name of ["validate-tag", "cleanup-failed-release"]) {
  test(`${name} cannot mutate releases from a pull request or a branch dispatch`, () => {
    assert.equal(allowed(name, "pull_request", "branch"), false);
    assert.equal(allowed(name, "workflow_dispatch", "branch"), false);
  });
}

test("validate-tag runs on a dispatch of the tag", () => {
  assert.equal(allowed("validate-tag", "workflow_dispatch", "tag"), true);
});

// PRD-629: `publish` and `finalize` also run on a proof run, as a rehearsal against a draft named
// `rehearsal-<run id>`. Only a validated tag may touch the real release.
for (const name of ["publish", "finalize"]) {
  test(`${name} touches the real release only from a validated tag`, () => {
    // A tag run whose candidate gate failed (`validate-tag` skipped, so no candidate SHA).
    const tag = { gates: "skipped" } as const;
    assert.equal(
      allowed(name, "workflow_dispatch", "tag", { ...tag, "validate-tag": "skipped" }),
      false,
    );
    assert.equal(allowed(name, "workflow_dispatch", "tag", tag), true);
  });

  test(`${name} rehearses on a proof run and not on an ordinary pull request`, () => {
    const proof = { "validate-tag": "skipped" } as const;
    assert.equal(allowed(name, "pull_request", "branch", proof, "push", { base: "main" }), true);
    assert.equal(allowed(name, "workflow_dispatch", "branch", proof), true);
    assert.equal(
      allowed(name, "pull_request", "branch", { ...proof, gates: "skipped", publish: "skipped" }),
      false,
      `${name} spent a runner on an ordinary pull request`,
    );
  });
}

test("a proof run publishes only a draft rehearsal release, never the tag", () => {
  const publish = job("publish");
  assert.match(publish, /echo "release_tag=rehearsal-\$GITHUB_RUN_ID"/u);
  const branches =
    publish.split('if [ "${REHEARSAL:-}" = true ]; then')[1]?.split("\n          fi\n")[0] ?? "";
  const [rehearsal = "", real = ""] = branches.split("\n          else\n");
  assert.doesNotMatch(real, /--draft/u);
  assert.match(rehearsal, /--draft/u);
  assert.doesNotMatch(rehearsal, /--verify-tag|--prerelease|--latest/u);
  assert.match(real, /--verify-tag/u);
  assert.match(real, /--prerelease/u);
  // The finalize promotion edit is tag-only; a proof run only checks the draft.
  assert.match(
    job("finalize"),
    /name: Promote the consumer-verified release\n\x20{8}if: github\.ref_type == 'tag'/u,
  );
  // The cleanup deletes nothing that is not a rehearsal draft.
  const cleanup = job("cleanup-rehearsal");
  assert.match(cleanup, /case "\$RELEASE_TAG" in rehearsal-\*\)/u);
  assert.match(cleanup, /if: \$\{\{ always\(\) && github\.ref_type != 'tag'/u);
});

test("the proof runs the npm cohort dry run against the rehearsal lock", () => {
  const dryRun = job("npm-dry-run");
  assert.match(dryRun, /needs: \[publish\]/u);
  assert.match(dryRun, /--pattern prebuilt-lock\.json/u);
  assert.match(dryRun, /scripts\/release\.ts --dry-run --skip-gates --lock/u);
  assert.doesNotMatch(dryRun, /--yes|NPM_TOKEN/u, "the rehearsal must not be able to publish");
  assert.match(job("cleanup-rehearsal"), /needs: \[publish, finalize, npm-dry-run\]/u);
});

test("the tag-only publication rides nothing a proof run did not run", () => {
  // The finding-1 defect: RELEASE_REPOSITORY named the old repository, and only the tag run saw it.
  // Both routes now generate the lock from the same step, with the real repository and tag.
  const lock = script("Generate the checksum lock from the verified assets");
  assert.match(lock, /generateReleaseManifest\("release"/u);
  assert.match(job("publish"), /RELEASE_REPOSITORY: \$\{\{ github\.repository \}\}/u);
});

for (const name of [
  "gates",
  "build",
  "build-android",
  "clean-consumer",
  "clean-consumer-windows",
]) {
  test(`${name} runs proof despite intentionally skipped publishing dependencies`, () => {
    // A promotion PR: PRD-373 retired the `promotion/<sha>` ref, so develop -> main is the
    // only promotion shape the repository creates.
    assert.equal(
      allowed(
        name,
        "pull_request",
        "branch",
        { "validate-tag": "skipped", publish: "success" },
        "push",
        {
          base: "main",
        },
      ),
      true,
    );
    assert.equal(
      allowed(name, "workflow_dispatch", "branch", {
        "validate-tag": "skipped",
        publish: "success",
      }),
      true,
    );
  });
}

// The runner pool holds about three runs. `native-release.yml` measured 7.0k runner-minutes
// across 2026-09-18 to 10-02, and almost all of it was proof a pull request push did not need:
// every PR touching one of four paths started a macOS/Windows/Linux/Android board. An ordinary
// push must now start nothing at all, while the four routes that do need the proof keep it.
test("the release proof runs only for a promotion PR, the release-proof label, dispatch or a release tag", () => {
  const proof = { "validate-tag": "skipped", publish: "success" } as const;
  const downstream = { "validate-tag": "skipped", gates: "skipped" } as const;
  for (const name of [
    "gates",
    "build",
    "build-android",
    "clean-consumer",
    "clean-consumer-windows",
  ]) {
    assert.equal(
      allowed(name, "pull_request", "branch", downstream, "push", { base: "develop" }),
      false,
      `${name} still runs on an ordinary PR push to develop`,
    );
  }
  // develop -> main, the promotion PRD-373 defines.
  assert.equal(allowed("gates", "pull_request", "branch", proof, "push", { base: "main" }), true);
  // The label is the owner's manual route for any other PR.
  assert.equal(
    allowed("gates", "pull_request", "branch", proof, "push", {
      base: "develop",
      labels: ["release-proof"],
    }),
    true,
  );
  assert.equal(
    allowed("gates", "pull_request", "branch", proof, "push", { base: "develop", labels: ["bug"] }),
    false,
    "an unrelated label must not buy a release proof",
  );
  // A manual dispatch keeps the proof. A tag run has `validate-tag`, so it does not need `gates`.
  assert.equal(allowed("gates", "workflow_dispatch", "branch", proof), true);
  assert.equal(allowed("gates", "workflow_dispatch", "tag"), false);
});

test("a pull request reaches the proof through an event that can carry its label", () => {
  const triggers = workflow.split("\npermissions:")[0] ?? "";
  const pullRequest =
    triggers.split("\n  pull_request:")[1]?.split("\n  workflow_dispatch:")[0] ?? "";
  assert.ok(pullRequest.length > 0, "the workflow declares no pull_request trigger");
  // `labeled` is what makes the label route reachable at all, and the open/reopen events are
  // what make a promotion PR reach it. `paths` is gone: a path filter would contradict both.
  assert.match(pullRequest, /types: \[[^\]]*labeled/u);
  for (const event of ["opened", "synchronize", "reopened"]) {
    assert.match(pullRequest, new RegExp(event, "u"));
  }
  assert.doesNotMatch(
    pullRequest,
    /\n\x20{4}paths:/u,
    "a paths filter re-runs the proof on ordinary pushes to the files it names",
  );
});

test("native builds and consumers refuse failed dependencies rather than treating always as success", () => {
  for (const name of ["build", "build-android"]) {
    assert.equal(
      allowed(name, "pull_request", "branch", { "validate-tag": "skipped", gates: "failure" }),
      false,
    );
  }
  assert.equal(
    allowed("clean-consumer", "pull_request", "branch", {
      "validate-tag": "skipped",
      publish: "success",
      "build-android": "failure",
    }),
    false,
  );
  assert.equal(
    allowed("clean-consumer", "workflow_dispatch", "tag", { publish: "failure" }),
    false,
  );
  assert.equal(
    allowed("clean-consumer-windows", "pull_request", "branch", {
      "validate-tag": "skipped",
      publish: "success",
      build: "failure",
    }),
    false,
  );
  assert.equal(
    allowed("clean-consumer-windows", "workflow_dispatch", "tag", { publish: "failure" }),
    false,
  );
});

test("the hosted release entry point executes refusal controls before native work", () => {
  assert.match(
    job("gates"),
    /pnpm exec vitest run scripts\/__tests__\/native-release-proof\.spec\.ts/u,
  );
  assert.match(job("gates"), /pull_request/u);
});

test("proof artifact transport is loopback-only and never applies to tag publication", () => {
  const consumer = job("clean-consumer");
  assert.match(consumer, /name: Serve same-run proof assets without publishing/u);
  assert.match(consumer, /--bind 127\.0\.0\.1/u);
  assert.match(consumer, /THREENATIVE_PREBUILT_MANIFEST/u);
  assert.match(consumer, /Stop the proof asset server/u);
  assert.doesNotMatch(job("publish"), /THREENATIVE_ALLOW_INSECURE_PREBUILT/u);
});

function runEvidence(
  change: "complete" | "missing" | "empty" | "wrong-marker" | "wrong-exit" | "wrong-scenario",
) {
  const directory = makeTempDirSync("threenative-consumer-evidence-");
  const scenarioRoot = join(directory, "examples/native-smoke/playtests");
  mkdirSync(scenarioRoot, { recursive: true });
  for (const name of ["physics", "physics-wrong-height", "physics-mask"]) {
    writeFileSync(join(scenarioRoot, `${name}.playtest.json`), JSON.stringify({ name }));
  }
  writeFileSync(join(directory, "threenative-package-specs"), "@threenative/core\tcore\n");
  const packed = join(directory, "package");
  mkdirSync(packed);
  mkdirSync(join(directory, "packages"));
  writeFileSync(
    join(packed, "package.json"),
    JSON.stringify({ name: "@threenative/core", version: "0.3.1" }),
  );
  assert.equal(
    spawnSync("tar", ["-czf", join(directory, "packages/core.tgz"), "-C", directory, "package"])
      .status,
    0,
  );
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture"],
  ]) {
    assert.equal(spawnSync("git", args, { cwd: directory }).status, 0);
  }
  const checkout = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
    encoding: "utf8",
  }).stdout.trim();
  const controls = [
    ["positive", "physics", "physics", 0, "normal", ""],
    [
      "wrong-height",
      "physics-wrong-height",
      "wrong-height",
      1,
      "normal",
      "TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED",
    ],
    [
      "mask-control",
      "physics-mask",
      "mask-control",
      1,
      "normal",
      "TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED",
    ],
    ["mask-positive", "physics-mask", "mask-pass", 0, "masked", ""],
    [
      "masked-physics-control",
      "physics",
      "masked-physics-control",
      1,
      "masked",
      "TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED",
    ],
    [
      "wrong-gravity",
      "physics",
      "wrong-gravity",
      1,
      "wrong-gravity",
      "TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED",
    ],
  ] as const;
  for (const [key, scenario, folder, code, variant, marker] of controls) {
    if (change === "missing" && key === "wrong-gravity") continue;
    const artifactDirectory = join(directory, `packed-android-${folder}`);
    mkdirSync(artifactDirectory);
    writeFileSync(
      join(artifactDirectory, "device-response-observations.json"),
      '{"observations":[1]}\n',
    );
    const report = {
      artifactDirectory,
      assertionResults: change === "empty" ? [] : [{ id: "positionReach", pass: code === 0 }],
      diagnostics: marker
        ? [{ code: change === "wrong-marker" ? "TN_UNRELATED_FAILURE" : marker }]
        : [],
      pass: code === 0,
      runtime: "native",
      target: "android",
      frames: 100,
      scenario: change === "wrong-scenario" ? "unrelated" : scenario,
    };
    writeFileSync(
      join(directory, `android-${key}.log`),
      `startup noise\n${JSON.stringify(report, null, 2)}\n`,
    );
    writeFileSync(
      join(directory, `android-${key}.exit`),
      `${change === "wrong-exit" ? 2 : code}\n`,
    );
    writeFileSync(
      join(directory, `android-${variant}-apk.sha256`),
      `${"c".repeat(64)}  game.apk\n`,
    );
  }
  const result = spawnSync(
    "bash",
    ["-e", "-o", "pipefail", "-c", script("Record packed consumer verification evidence")],
    {
      cwd: directory,
      encoding: "utf8",
      timeout: 10000,
      env: {
        ...process.env,
        RUNNER_TEMP: directory,
        GITHUB_WORKSPACE: directory,
        GITHUB_SHA: checkout,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_REF_TYPE: "branch",
        GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
      },
    },
  );
  assert.ifError(result.error);
  return { ...result, directory };
}

test("consumer evidence records six real outcomes and integrity of the actual packed bytes", () => {
  const result = runEvidence("complete");
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(
    readFileSync(join(result.directory, "proof-consumer-evidence.json"), "utf8"),
  );
  assert.equal(report.controls.length, 6);
  assert.ok(
    report.controls.every(
      (row: { assertionCount: number; verified: boolean }) =>
        row.assertionCount > 0 && row.verified,
    ),
  );
  assert.equal(report.packages[0].version, "0.3.1");
  assert.match(report.packages[0].integrity, /^sha512-/u);
  assert.equal(report.scope, "same-run-artifacts-not-public-installation");
});

for (const change of [
  "missing",
  "empty",
  "wrong-marker",
  "wrong-exit",
  "wrong-scenario",
] as const) {
  test(`consumer evidence refuses ${change} observations and preserves failed rows`, () => {
    const result = runEvidence(change);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    const report = JSON.parse(
      readFileSync(join(result.directory, "proof-consumer-evidence.json"), "utf8"),
    );
    assert.equal(report.controls.length, 6);
    assert.ok(report.controls.some((row: { verified: boolean }) => !row.verified));
    assert.ok(report.failures.length > 0);
  });
}

// `clean-consumer-ios` relies on implicit skip-propagation rather than an explicit event
// condition, so it is worth pinning. Its guard is already correct; this closes a coverage gap.
test("clean-consumer-ios stays out of every non-tag proof route", () => {
  // The job carries no event condition; `validate-tag` skipping and emitting no `candidate_sha`
  // holds it out. So the route is modelled as it runs - with `validate-tag` skipped - rather than
  // with the helper's default populated outputs.
  for (const event of ["pull_request", "workflow_dispatch", "push"] as const) {
    assert.equal(
      allowed("clean-consumer-ios", event, "branch", { "validate-tag": "skipped" }),
      false,
    );
  }
  assert.equal(
    allowed("clean-consumer-ios", "workflow_dispatch", "tag", { "validate-tag": "skipped" }),
    false,
  );
  // The dependency that does the holding must still be declared. PRD-630: the condition reads it
  // explicitly, because a tag run skips `gates`, and an implicit success() would skip this job too.
  const body = job("clean-consumer-ios").split("\n    steps:")[0] ?? "";
  assert.match(body, /\n\x20{4}needs: \[?[^\n]*validate-tag/u);
  assert.match(body, /needs\.validate-tag\.outputs\.candidate_sha == github\.sha/u);
});

// PRD-629: the published matrix includes the simulator asset, so a proof run builds it and the
// rehearsal lock is the lock the tag run generates. A tag run still builds it only for the
// candidate commit, and a proof run skips it when the gates fail.
test("build-ios-simulator runs on proof runs and on the candidate's tag run only", () => {
  for (const event of ["pull_request", "workflow_dispatch"] as const) {
    assert.equal(
      allowed("build-ios-simulator", event, "branch", { "validate-tag": "skipped" }),
      true,
    );
    assert.equal(
      allowed("build-ios-simulator", event, "branch", {
        gates: "failure",
        "validate-tag": "skipped",
      }),
      false,
    );
  }
  const tag = { gates: "skipped" } as const;
  assert.equal(allowed("build-ios-simulator", "workflow_dispatch", "tag", tag), true);
  assert.equal(
    allowed("build-ios-simulator", "workflow_dispatch", "tag", {
      ...tag,
      "validate-tag": "skipped",
    }),
    false,
  );
});

test("a rehearsal publish waits for the simulator asset", () => {
  assert.equal(allowed("publish", "pull_request", "branch"), true);
  assert.equal(
    allowed("publish", "pull_request", "branch", { "build-ios-simulator": "skipped" }),
    false,
  );
});

test("the emulator lane reports acceleration instead of asserting it", () => {
  // Read the step out of the job rather than via `script()`: that helper needs a line between
  // `- name:` and `run: |`, and this step has none.
  const consumerJob = job("clean-consumer");
  const kvm =
    consumerJob.split("- name: Enable KVM for the emulator\n")[1]?.split("\n      - name:")[0] ??
    "";
  assert.ok(kvm.length > 0, "missing the KVM step");
  // `native-platforms.yml:317-332` records this exact defect and names this file as where it was
  // copied from: "`test -w /dev/kvm` as the last line of this step ... turned 'this runner has no
  // KVM' into a failed job, which is worse than the slow boot it was meant to fix." That lane was
  // repaired; this one still asserted, and it gates every Android control in `clean-consumer`.
  assert.doesNotMatch(
    kvm,
    /^\s*test -w \/dev\/kvm\s*$/mu,
    "a runner without KVM must fall back to software emulation, not fail the job",
  );
  assert.match(kvm, /TN_EMULATOR_ACCEL:kvm/u);
  assert.match(kvm, /TN_EMULATOR_ACCEL:software/u);
});

test("the packed Android build provisions the debug key the re-sign step assumes", () => {
  // The packager zipaligns the finished APK to 16 KB and re-signs it with the debug key, but
  // the masked clean-consumer SDK never yields ~/.android/debug.keystore, so the re-sign fails
  // closed with "no keystore" after a BUILD SUCCESSFUL Gradle run. The keystore is provisioned
  // explicitly before the build, with the alias and passwords the packager already assumes.
  const consumerJob = job("clean-consumer");
  const keystore =
    consumerJob
      .split("- name: Provision the Android debug keystore for the packed build\n")[1]
      ?.split("\n      - name:")[0] ?? "";
  assert.ok(keystore.length > 0, "missing the keystore provisioning step");
  assert.match(keystore, /\.android\/debug\.keystore/u);
  assert.match(keystore, /androiddebugkey/u);
  // Order matters: provisioning after the build would not save the re-sign.
  const provisionAt = consumerJob.indexOf("Provision the Android debug keystore");
  const buildAt = consumerJob.indexOf("Build the packed Android target without NDK");
  assert.ok(
    provisionAt > 0 && provisionAt < buildAt,
    "the keystore provisioning must precede the packed Android build",
  );
});

test("the packed consumer job outlasts its measured comparable", () => {
  const consumer = job("clean-consumer");
  const timeout = Number(consumer.match(/\n\x20{4}timeout-minutes: (\d+)/u)?.[1]);
  assert.ok(Number.isSafeInteger(timeout), "clean-consumer must declare a timeout");
  // Four successful `Android emulator visual parity` runs measured 27m00s, 27m33s, 27m50s and
  // 30m18s (2026-09-09). That job is cached, does one Android build and one emulator boot, and had
  // its own cap raised 35 -> 45 after measurement (`native-platforms.yml:217`). `clean-consumer` is
  // an uncached superset of it: packing every workspace package, scaffolding and installing a
  // consumer, a desktop build and 300-frame launch, an uncached system-image pull, three Android
  // builds, an emulator boot and six playtests.
  assert.ok(
    timeout > 45,
    `clean-consumer's ${timeout} minute cap is under its measured comparable`,
  );
  // The emulator's own boot budget, separately: a cold software-emulation boot was measured at
  // 474s (`native-platforms.yml:335-341`), against the action's 600s default.
  const boot = Number(consumer.match(/emulator-boot-timeout: (\d+)/u)?.[1]);
  assert.ok(
    Number.isSafeInteger(boot) && boot >= 900,
    `the emulator boot timeout is ${boot}s, too close to the measured 474s cold boot`,
  );
});

test("at most one release proof holds runners at a time, across branches", () => {
  const concurrency = workflow.split("\nconcurrency:\n")[1]?.split("\njobs:")[0] ?? "";
  assert.ok(concurrency.length > 0, "the workflow declares no concurrency block");
  // Comments are prose about the setting, not the setting: reading them back as configuration
  // is how a `github.ref` mentioned in an explanation would fail this for the wrong reason.
  const settings = concurrency
    .split("\n")
    .filter((line) => !/^\x20*#/u.test(line))
    .join("\n");
  // The group used to carry the event name, the triggering CI head SHA and the ref, so a
  // promotion PR, a manual dispatch, a tag and every main CI completion each held a runner at
  // the same time - and a two-minute join waited behind an hour of proof (PRD-380). One group,
  // no cancel: a superseded run still lets its queued consumer finish.
  assert.match(
    settings,
    /^\x20{2}group: \$\{\{ github\.ref_type == 'tag' && 'native-release-tag' \|\| \(.*\) && 'native-release-proof' \|\| format\('native-release-skip-\{0\}', github\.run_id\) \}\}$/mu,
  );
  assert.match(settings, /^\x20{2}cancel-in-progress: false$/mu);
});

// PRD-630: the tag run republishes what the promotion proof built and installed.
describe("a tag run with a promotion proof", () => {
  const tag = (extra: Record<string, string> = {}) => ({
    gates: "skipped",
    build: "skipped",
    "build-android": "skipped",
    "build-ios-simulator": "skipped",
    "clean-consumer": "skipped",
    "clean-consumer-windows": "skipped",
    ...extra,
  });

  it("builds nothing and installs nothing again", () => {
    for (const name of [
      "build",
      "build-android",
      "build-ios-simulator",
      "clean-consumer",
      "clean-consumer-windows",
      "clean-consumer-ios",
    ]) {
      assert.equal(allowed(name, "workflow_dispatch", "tag", tag({ proofRun: "7" })), false, name);
    }
  });

  it("publishes, promotes and keeps the release", () => {
    const run = tag({ proofRun: "7" });
    assert.equal(allowed("publish", "workflow_dispatch", "tag", run), true);
    assert.equal(allowed("finalize", "workflow_dispatch", "tag", run), true);
    assert.equal(allowed("cleanup-failed-release", "workflow_dispatch", "tag", run), false);
  });

  it("builds and proves as a first run when no proof qualifies", () => {
    const run = { gates: "skipped" };
    for (const name of ["build", "build-android", "clean-consumer", "clean-consumer-windows"])
      assert.equal(allowed(name, "workflow_dispatch", "tag", run), true, name);
    assert.equal(allowed("publish", "workflow_dispatch", "tag", tag()), false);
    assert.equal(
      allowed("finalize", "workflow_dispatch", "tag", {
        gates: "skipped",
        "clean-consumer": "failure",
      }),
      false,
    );
    assert.equal(
      allowed("cleanup-failed-release", "workflow_dispatch", "tag", {
        gates: "skipped",
        "clean-consumer": "failure",
      }),
      true,
    );
  });

  it("lets an admin override skip the consumer proofs but keeps the build", () => {
    const run = { gates: "skipped", override: "true" };
    assert.equal(allowed("build", "workflow_dispatch", "tag", run), true);
    assert.equal(allowed("clean-consumer", "workflow_dispatch", "tag", run), false);
    const done = { ...run, "clean-consumer": "skipped", "clean-consumer-windows": "skipped" };
    assert.equal(allowed("finalize", "workflow_dispatch", "tag", done), true);
    assert.equal(allowed("cleanup-failed-release", "workflow_dispatch", "tag", done), false);
  });

  it("refuses an override from anyone but an admin, before any side effect", () => {
    const body = job("validate-tag");
    assert.match(body, /collaborators\/\$GITHUB_ACTOR\/permission/u);
    assert.match(body, /test "\$role" = admin/u);
    // A step-level input goes through env, so a reason cannot inject shell.
    assert.doesNotMatch(body, /run: .*inputs\.override/u);
  });
});

test("the scaffolded consumer receives every module its entry imports", () => {
  // Read it out of the job: `script()` needs a line between `- name:` and `run: |`, and this
  // step has none.
  const prepare =
    job("clean-consumer")
      .split("- name: Prepare the scaffolded consumer proof\n")[1]
      ?.split("\n      - ")[0] ?? "";
  assert.ok(prepare.length > 0, "missing the prepare step");
  const copied = new Set(
    [...prepare.matchAll(/copyFileSync\("([^"]+)"/gu)]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined),
  );
  const entry = [...copied].find((path) => path.endsWith("/game.ts"));
  assert.ok(entry, "the prepare step no longer copies a game entry");
  const source = readFileSync(join(root, entry), "utf8");
  // Derived from the entry rather than hard-coded: the step copied `game.ts` alone, and the
  // consumer build died with
  //   [UNRESOLVED_IMPORT] Could not resolve './networking-game.js' in src/game.ts
  //   [UNRESOLVED_IMPORT] Could not resolve './worker-proof.js' in src/game.ts
  // so the next sibling import added to the entry must be copied too, not discovered on a runner.
  const directory = entry.slice(0, entry.lastIndexOf("/"));
  for (const match of source.matchAll(/from "\.\/([^"]+)\.js"/gu)) {
    const sibling = `${directory}/${match[1]}.ts`;
    assert.ok(
      copied.has(sibling),
      `${entry} imports ./${match[1]}.js, so ${sibling} must be copied into the consumer`,
    );
  }
});

test("every packed Android control names the consumer's own package and activity", () => {
  const emulator =
    job("clean-consumer").split("- name: Run packed Android physics and negative controls")[1] ??
    "";
  const invocations = emulator
    .split("\n")
    .filter((line) => line.includes("playtest/dist/runner/cli.js"));
  assert.equal(
    invocations.length,
    6,
    `expected six control invocations, found ${invocations.length}`,
  );
  for (const invocation of invocations) {
    // The runner defaults to `--package com.mystral.engine` and `--activity .MystralActivity`
    // (`packages/playtest/src/runner/config.ts:82,267`). A scaffolded consumer is neither: its
    // application id comes from its own threenative.config.ts, and its launch activity is
    // runtime-owned. Without both flags every control dies before it asserts anything:
    //   Error type 3
    //   Error: Activity class {<app>/<app>.MystralActivity} does not exist.
    assert.match(invocation, /--package "\$CONSUMER_APP_ID"/u);
    assert.match(invocation, /--activity com\.threenative\.runtime\.MystralActivity/u);
  }
});

test("the consumer's application id is derived, never assumed", () => {
  const prepare =
    job("clean-consumer")
      .split("- name: Prepare the scaffolded consumer proof\n")[1]
      ?.split("\n      - ")[0] ?? "";
  assert.match(prepare, /CONSUMER_APP_ID=/u);
  assert.match(prepare, /threenative\.config\.ts/u);
});

test("the clean consumer installs the runtime's own shared libraries", () => {
  const consumer = job("clean-consumer");
  const apt =
    consumer.split("- name: Install a software Vulkan ICD")[1]?.split("\n      - ")[0] ?? "";
  assert.ok(apt.length > 0, "missing the consumer's apt step");
  // `ldd` on the prebuilt this job downloads names these: the desktop runtime links the UI overlay,
  // which links WebKitGTK. A hosted runner has the Vulkan ICD installed here but not WebKit, so the
  // packager died with "Runtime packager exited with code 127".
  assert.match(apt, /libwebkit2gtk-4\.1-0/u);
});

test("the consumer gets the build tool helper the runtime dispatches to", () => {
  // `src/cli/tool_dispatch.cpp:52` requires a `mystral-tools` binary beside the runtime for desktop
  // packaging. PREBUILT_ASSET_NAMES published no such asset, so a consumer installing from a
  // release could not run `threenative build --target desktop` at all:
  //   Error: build tool helper is missing: .../prebuilt/linux-x64/mystral-tools
  //   Runtime packager exited with code 127.
  // PRD-262 phase 3 publishes it as a release asset per desktop row, so the install places it and
  // the proof no longer carries it out of band.
  const build = job("build");
  for (const asset of [
    "threenative-tools-linux-x64",
    "threenative-tools-darwin-arm64",
    "threenative-tools-win32-x64.exe",
  ]) {
    assert.match(build, new RegExp(`tools_asset: ${asset.replace(".", "\\.")}`, "u"));
  }
  // The helper must travel in the same uploaded artifact the publish job collects, or the lock is
  // generated from an incomplete directory and the release fails closed.
  assert.match(build, /release\/\$\{\{ matrix\.tools_asset \}\}/u);
  const consumer = job("clean-consumer");
  // Nothing may place the helper for the consumer: the whole claim is that the install does.
  assert.doesNotMatch(consumer, /--name tools-linux-x64/u);
  assert.doesNotMatch(consumer, /install -m 0755 "\$RUNNER_TEMP\/tools\/mystral-tools"/u);
  assert.match(
    consumer,
    /test -x "\$CONSUMER_TARGET\/node_modules\/@threenative\/runtime-native\/prebuilt\/linux-x64\/mystral-tools"/u,
    "the consumer gate must assert the installed helper before the desktop build",
  );
  // Order matters: asserting it after the build would not prove the install produced it.
  const assertAt = consumer.indexOf("prebuilt/linux-x64/mystral-tools");
  const buildAt = consumer.indexOf("build --target desktop");
  assert.ok(assertAt > 0 && assertAt < buildAt, "the helper check must precede the consumer build");
});

test("the same-run proof serves the published cohort, not every non-iOS key", () => {
  // macOS uploads under a name the `pattern: runtime-*` download does not collect, so a proof step
  // that demanded every non-iOS asset failed a run whose staging was exactly right:
  //   Error: Proof assets must contain every non-iOS runtime from this run, and no extras.
  const consumer = job("clean-consumer");
  assert.match(consumer, /PUBLISHED_PREBUILT_KEYS/u);
  assert.doesNotMatch(
    consumer,
    /Object\.entries\(PREBUILT_ASSET_NAMES\)\.filter\(\(\[key\]\) => !key\.startsWith\("ios-"\)\)/u,
    "the proof cohort must be derived from the published keys, not from every non-iOS key",
  );
});

test("the Linux proof lane ignores the simulator zip a proof run now downloads", () => {
  // Run 39352029148: `build-ios-simulator` runs on proof runs (PRD-629), so `pattern: runtime-*`
  // also collects its zip, and the "no extras" check failed a run whose staging was right.
  const consumer = job("clean-consumer");
  assert.match(consumer, /name\.startsWith\("threenative-ios-"\)/u);
});

test("the Windows consumer serves only the Windows row it installs", () => {
  // Run 34725179598: `build-android`'s V8 source build hit its 2h cap and uploaded nothing, so the
  // Windows lane died demanding Android assets it never needed and never depended on. It now serves
  // the win32 runtime and helper the consumer installs, derived from the published keys.
  const consumer = job("clean-consumer-windows");
  assert.match(consumer, /pattern: runtime-win32-x64/u);
  assert.match(consumer, /key\.startsWith\("win32-"\)/u);
  assert.doesNotMatch(consumer, /!key\.startsWith\("ios-"\)/u);
});

test("the Windows consumer copies the fixture its vite config reads before it builds", () => {
  // Run 34730868090: the prepare step copied `vite.config.ts` alone, so the config's sibling read of
  // `physics-parity.scenario.json` fell through to `../../packages/physics/...` and the consumer build
  // died on `ENOENT ... D:\a\packages\physics\__tests__\fixtures\physics-parity.scenario.json`. The
  // sibling copy is the only one that survives a build outside this checkout, so it is pinned.
  const prepare = windowStep("Prepare the scaffolded consumer proof");
  assert.match(prepare, /native-smoke\/vite\.config\.ts/u);
  assert.match(prepare, /packages\/physics\/__tests__\/fixtures\/physics-parity\.scenario\.json/u);
});

function windowStep(name: string): string {
  const block = job("clean-consumer-windows").split(`- name: ${name}\n`)[1];
  assert.ok(block, `missing the Windows consumer step ${name}`);
  return block.split("\n      - ")[0] ?? "";
}

test("the Windows consumer runs on a Windows runner with every native compiler masked", () => {
  // The Linux lane's mask is `printf` plus `chmod +x`, neither of which exists on Windows, so the
  // same claim needs its own lane rather than a flag: PATHEXT resolves a `.cmd` ahead of the real
  // `.exe`, and MSVC is installed on this image, so the shadowing has to be proved, not assumed.
  assert.match(job("clean-consumer-windows"), /runs-on: windows-2025/u);
  const mask = windowStep("Mask every native toolchain entry point");
  // Derive the set from the workflow's own array so adding or dropping a shim changes this list:
  // the step is the source of truth for which compilers are masked.
  const declared = mask.match(/const commands = \[([^\]]+)\]/u)?.[1];
  assert.ok(declared, "the mask step must declare its command list");
  const commands = [...declared.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(
    commands,
    ["cargo", "cl", "clang", "clang++", "cmake", "c++", "g++", "gcc", "link", "ninja", "rustc"],
    "every native compiler entry point must be masked",
  );
  assert.match(mask, /\.cmd/u);
  assert.match(mask, /exit \/b 97/u);
  assert.match(mask, /TN_TOOLCHAIN_LOG/u);
  assert.match(mask, /cygpath -w/u);
});

test("the Windows consumer asserts the installed helper before the desktop build and never places one", () => {
  const consumer = job("clean-consumer-windows");
  // Nothing may place the helper for the consumer: the whole claim is that the install does.
  assert.doesNotMatch(consumer, /--name tools-/u);
  assert.doesNotMatch(consumer, /install -m 0755/u);
  const build = windowStep("Install and build without a native toolchain");
  assert.match(build, /install-status\.json/u);
  assert.match(build, /prebuilt\/win32-x64\/threenative-runtime\.exe/u);
  assert.match(build, /prebuilt\/win32-x64\/mystral-tools\.exe/u);
  assert.match(build, /build --target desktop/u);
  const statusAt = build.indexOf("install-status.json");
  const runtimeAt = build.indexOf("prebuilt/win32-x64/threenative-runtime.exe");
  const helperAt = build.indexOf("prebuilt/win32-x64/mystral-tools.exe");
  const buildAt = build.indexOf("build --target desktop");
  assert.ok(statusAt > 0 && statusAt < buildAt, "the install-status check must precede the build");
  assert.ok(
    runtimeAt > 0 && runtimeAt < buildAt && helperAt > 0 && helperAt < buildAt,
    "both installed binaries must be asserted before the consumer build",
  );
});

test("the Windows consumer launches the packed executable and reports its first frame", () => {
  const launch = windowStep("Launch the packed desktop game for 300 frames");
  assert.match(launch, /--screenshot/u);
  assert.match(launch, /--frames 300/u);
  assert.match(launch, /TN_NATIVE_SMOKE_READY:webgpu/u);
  assert.match(launch, /TN_NATIVE_SMOKE_FIRST_FRAME/u);
  assert.match(launch, /TN_NATIVE_SMOKE_300_FRAMES:300/u);
  assert.match(launch, /Rendered 300 frames in \[0-9\]\+ms/u);
  // A run that does not name its adapter may be a software rasteriser; the lane records it.
  // The shell ERE escapes the brackets, so assert the adapter alternation rather than the escaping.
  assert.match(launch, /WebGPU/u);
  assert.match(launch, /Adapter\|Vendor\|Backend/u);
  assert.match(launch, /windows-adapter\.txt/u);
});

test("the Windows consumer proves the mask shadows MSVC before it restores the positive path", () => {
  // Phase 1 observed-red (a): the `.cmd` shim must actually shadow the real `cl.exe` on this image,
  // and the control must assert exit 97 with the invocation recorded. The invocation goes through
  // `cmd.exe`, because Git Bash does not resolve a `.cmd` from a bare name and would report 127,
  // proving nothing about the mask (run 34743159341 failed exactly that way).
  const control = windowStep("Prove the mask shadows MSVC, then restore the positive path");
  assert.match(control, /cmd\.exe \/\/c "cl \/\?"/u);
  assert.match(control, /-eq 97/u);
  assert.match(control, /TN_TOOLCHAIN_LOG/u);
  assert.match(control, /masked-cl\.exit/u);
});

test("the Windows consumer proves a removed helper is re-fetched, never source-built", () => {
  // Phase 1 observed-red (b), corrected by run 34745227091: deleting the installed helper did not
  // fail the build — the build re-installed it ("Installed verified ThreeNative runtime and build
  // tool helper for 'win32-x64'.") with an empty toolchain log. The honest claim is that the helper
  // is re-fetched from the served release, never satisfied by a silent source build.
  const control = windowStep(
    "Prove a removed helper is re-fetched, never source-built, then restore it",
  );
  assert.match(control, /prebuilt\/win32-x64\/mystral-tools\.exe/u);
  assert.match(control, /rm -f "\$helper"/u);
  assert.match(control, /test -s "\$helper"/u);
  assert.match(control, /test ! -e "\$TN_TOOLCHAIN_LOG"/u, "no compiler may have run");
  assert.match(
    control,
    /cmp -s "\$backup" "\$helper"/u,
    "the re-fetched helper must match the published one",
  );
});

test("the Windows consumer proves a renderer that never presents fails the launch assertions", () => {
  // Phase 2 observed-red, measured by run 34746542857: a build that never presents exits non-zero
  // ("Error: Failed to save screenshot!"), writes no capture, and prints no first-frame marker, so
  // the launch step's own assertions fail rather than passing on a silent process.
  const control = windowStep("Prove a renderer that never presents fails the launch assertions");
  assert.match(control, /-ne 0/u, "a non-presenting build must exit non-zero");
  assert.match(control, /test ! -e "\$RUNNER_TEMP\/renderer-disabled\.png"/u);
  assert.match(control, /TN_NATIVE_SMOKE_FIRST_FRAME/u);
  assert.match(control, /renderer-disabled\.marker-exit/u);
  assert.match(control, /cp "\$backup" "\$entry"/u, "the genuine entry must be restored");
});

test("the Windows consumer is a mandatory release prerequisite, not advisory", () => {
  assert.match(
    job("finalize"),
    /needs: \[validate-tag, publish, clean-consumer, clean-consumer-windows\]/u,
  );
  assert.match(
    job("cleanup-failed-release"),
    /needs: \[validate-tag, publish, clean-consumer, clean-consumer-windows\]/u,
  );
});

test("iOS is not a supported target, so its consumer proof does not gate promotion", () => {
  assert.doesNotMatch(job("finalize"), /clean-consumer-ios/u);
  assert.doesNotMatch(job("cleanup-failed-release"), /clean-consumer-ios/u);
});

test("no mapping in the workflow repeats a key", () => {
  // `yaml.safe_load` and most parsers accept a repeated key silently; GitHub does not, and rejects
  // the whole file before any job starts. A Phase 9 edit left `if-no-files-found` twice in one
  // `with:` block, and the next three runs reported "This run likely failed because of a workflow
  // file issue" with zero jobs, which reads nothing like a duplicate key.
  const lines = workflow.split("\n");
  const seen = new Map<number, Set<string>>();
  const duplicates: string[] = [];
  lines.forEach((line, index) => {
    if (/^\s*#/u.test(line) || line.trim() === "") return;
    const match = line.match(/^(\x20*)(-\x20)?([A-Za-z_][\w.-]*):(\s|$)/u);
    if (!match) return;
    const indent = (match[1]?.length ?? 0) + (match[2] ? 2 : 0);
    const key = match[3] ?? "";
    // A list item starts a fresh mapping, and so does any dedent.
    if (match[2]) for (const depth of [...seen.keys()]) if (depth >= indent) seen.delete(depth);
    for (const depth of [...seen.keys()]) if (depth > indent) seen.delete(depth);
    const scope = seen.get(indent) ?? new Set<string>();
    if (scope.has(key)) duplicates.push(`${key} (line ${index + 1})`);
    scope.add(key);
    seen.set(indent, scope);
  });
  assert.deepEqual(duplicates, [], `repeated keys: ${duplicates.join(", ")}`);
});
