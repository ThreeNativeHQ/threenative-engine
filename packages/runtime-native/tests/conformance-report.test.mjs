import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  buildProvenance,
  captureSetSha256,
  PROVENANCE_ENV_KEYS,
  reportExitCode,
  validateProvenance,
  validateReport,
  verifyApkBundle,
} from "../conformance/run-conformance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function registry() {
  return JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
}

function provenance() {
  return {
    commit: "0123456789abcdef0123456789abcdef01234567",
    dirty: false,
    runtimeSha256: null,
    referenceSetSha256: null,
    device: null,
    env: PROVENANCE_ENV_KEYS.map((key) => ({ key, valueSha256: null })),
  };
}

function blockedReport(value) {
  const results = value.tests.map(({ id }) => ({ id, status: "blocked" }));
  return {
    schemaVersion: "0.3.0",
    registrySchemaVersion: value.schemaVersion,
    threeVersion: value.threeVersion,
    mode: "execution",
    target: "desktop",
    provenance: provenance(),
    summary: { pass: 0, fail: 0, blocked: results.length, planned: 0, validated: 0 },
    results,
  };
}

test("should reject a report with no provenance commit", () => {
  const value = registry();
  const report = blockedReport(value);
  assert.deepEqual(validateReport(report, value), []);

  const { commit, ...withoutCommit } = report.provenance;
  assert.ok(commit, "the fixture must start with a commit for its removal to mean anything");
  report.provenance = withoutCommit;
  const errors = validateReport(report, value);
  assert.notEqual(errors.length, 0, "a report with no provenance commit must not validate");
  assert.match(errors.join("\n"), /provenance\.commit is required/u);

  report.provenance = provenance();
  report.provenance.commit = "not-a-commit";
  assert.match(validateReport(report, value).join("\n"), /provenance\.commit must be a git object/u);

  delete report.provenance;
  assert.match(validateReport(report, value).join("\n"), /report\.provenance must record/u);
});

test("should recompute exit from summary rather than trust the recorded value", () => {
  // The exact desktop row of docs/verification/parity-2026-08-10-r2.md, which records exit 0.
  const r2Desktop = { pass: 66, fail: 0, blocked: 1 };
  const recordedExit = 0;
  assert.equal(reportExitCode({ summary: r2Desktop }), 2);
  assert.notEqual(
    reportExitCode({ summary: r2Desktop }),
    recordedExit,
    "a summary with a blocked row cannot exit 0, so the r2 desktop cell is unproducible",
  );

  assert.equal(reportExitCode({ summary: { pass: 65, fail: 1, blocked: 1 } }), 1);
  assert.equal(reportExitCode({ summary: { pass: 67, fail: 0, blocked: 0 } }), 0);
  assert.equal(reportExitCode({ summary: { pass: 27, fail: 40, blocked: 0 } }), 1);
  assert.equal(
    reportExitCode({
      summary: { pass: 67, fail: 0, blocked: 0 },
      supplemental: {
        expiredExclusions: [{ id: "old", status: "blocked", expires: "2026-01-01" }],
      },
    }),
    2,
  );
  assert.equal(
    reportExitCode({
      summary: { pass: 1, fail: 1, blocked: 0 },
      supplemental: {
        expiredExclusions: [{ id: "old", status: "blocked", expires: "2026-01-01" }],
      },
    }),
    1,
  );
  assert.equal(
    reportExitCode({
      summary: { pass: 67, fail: 0, blocked: 0 },
      supplemental: { androidMultitouch: { status: "fail", exitCode: 1 } },
    }),
    1,
  );
  assert.equal(
    reportExitCode({
      summary: { pass: 66, fail: 0, blocked: 1 },
      supplemental: { androidMultitouch: { status: "fail", exitCode: 1 } },
    }),
    1,
  );
  assert.equal(
    reportExitCode({
      summary: { pass: 67, fail: 0, blocked: 0 },
      supplemental: {
        androidMultitouch: { status: "fail", exitCode: 1 },
        expiredExclusions: [{ id: "old", status: "blocked", expires: "2026-01-01" }],
      },
    }),
    1,
  );
});

test("provenance fails closed on unrecognised fields and unsorted environment keys", () => {
  const value = registry();
  const report = blockedReport(value);
  report.provenance.reason = "looked fine to me";
  assert.match(
    validateReport(report, value).join("\n"),
    /provenance\.reason is not a recognised provenance field/u,
  );

  report.provenance = provenance();
  report.provenance.env = [...report.provenance.env].reverse();
  assert.match(validateReport(report, value).join("\n"), /provenance\.env must be sorted by key/u);

  report.provenance = provenance();
  report.provenance.env = [];
  assert.match(validateReport(report, value).join("\n"), /provenance\.env must be a non-empty/u);

  report.provenance = provenance();
  report.provenance.env[0].valueSha256 = "/home/joao/Android/Sdk";
  assert.match(validateReport(report, value).join("\n"), /valueSha256 must be null or a sha256/u);

  report.provenance = provenance();
  report.verdict = "green";
  assert.match(
    validateReport(report, value).join("\n"),
    /report\.verdict is not a recognised report field/u,
  );
});

test("provenance hashes environment values and never records them", () => {
  const secret = "/home/joao/Android/Sdk";
  const built = buildProvenance({ env: { ANDROID_SDK_ROOT: secret }, cwd: root });
  assert.deepEqual(validateProvenance(built), []);
  assert.match(built.commit, /^[0-9a-f]{40}$/u);
  assert.equal(typeof built.dirty, "boolean");

  const serialised = JSON.stringify(built);
  assert.doesNotMatch(serialised, /Android\/Sdk/u, "a provenance block must never print a value");
  const androidRoot = built.env.find((entry) => entry.key === "ANDROID_SDK_ROOT");
  assert.match(androidRoot.valueSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    built.env.find((entry) => entry.key === "ANDROID_HOME").valueSha256,
    null,
    "an unset key is recorded with a null digest, because 'not set' is an observation",
  );
});

test("the reference capture set is hashed as a set, and an empty or missing set is null", () => {
  const directory = makeTempDirSync("threenative-reference-");
  try {
    assert.equal(captureSetSha256(join(directory, "absent")), null);
    assert.equal(captureSetSha256(directory), null);
    writeFileSync(join(directory, "01-basic-cube.png"), "one");
    writeFileSync(join(directory, "02-buffer-geometry.png"), "two");
    const first = captureSetSha256(directory);
    assert.match(first, /^[0-9a-f]{64}$/u);
    writeFileSync(join(directory, "02-buffer-geometry.png"), "two, but redrawn");
    assert.notEqual(captureSetSha256(directory), first, "a changed capture must change the digest");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});


test("APK verification records the library digests read from the checksum-locked installed APK", () => {
  const directory = makeTempDirSync("conformance-apk-runtime-");
  const bundle = join(directory, "main.js");
  writeFileSync(bundle, "fixture bundle");
  try {
    const libraries = verifyApkBundle("fixture.apk", bundle, "fixture-java", (command, args, options) => {
      assert.ok(args.includes("lib"));
      mkdirSync(join(options.cwd, "assets/scripts"), { recursive: true });
      writeFileSync(join(options.cwd, "assets/scripts/main.js"), "fixture bundle");
      for (const abi of ["x86_64", "arm64-v8a"]) {
        mkdirSync(join(options.cwd, "lib", abi), { recursive: true });
        writeFileSync(join(options.cwd, "lib", abi, "libmystral-runtime.so"), abi);
      }
      return { status: 0 };
    });
    assert.match(libraries.x86_64, /^[0-9a-f]{64}$/u);
    assert.match(libraries["arm64-v8a"], /^[0-9a-f]{64}$/u);
    assert.notEqual(libraries.x86_64, libraries["arm64-v8a"]);
    const source = readFileSync(join(root, "conformance/run-conformance.mjs"), "utf8");
    assert.equal((source.match(/apkBundleVerified: true,\n {8}runtimeLibraries,/gu) ?? []).length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
