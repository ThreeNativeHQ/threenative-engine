#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SDL3_ANDROID_VERSION, stageAndroidAssets } from "../scripts/package-android.mjs";
import { stageDesktopFiles } from "../scripts/package-desktop.mjs";
import { prepareAndroidEmulator } from "../scripts/android-emulator.mjs";
import {
  androidMultitouchScript,
  MULTITOUCH_PROOF_POINTS,
  parseAndroidTouchDevice,
  parseAndroidTouchViewport,
} from "./android-touch.mjs";
import {
  ACTIVITY,
  APP_ID,
  analyzeAppLog,
  assertPackagedAndroidBundle,
  discoverTools,
  filterAppLog,
  inspectScreenshot,
  parseAdbDevices,
  selectDevice,
} from "../scripts/verify-android-first-proof.mjs";
import {
  compareCaptures,
  compareScreenSpaceGlyphs,
  inspectCapture,
  inspectScreenSpaceGlyphs,
} from "./metrics.mjs";
import { runAndroidMultitouchProof, shouldRunAndroidMultitouch } from "./parity-extras.mjs";
import {
  createProjectRegistry,
  projectId,
  resolveParityProject,
  writeProjectScene,
} from "./project-mode.mjs";

export const REPORT_SCHEMA_VERSION = "0.3.0";
const REGISTRY_SCHEMA_VERSION = "0.1.0";
const runtimeRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = resolve(runtimeRoot, "..", "..");
const runnerPath = fileURLToPath(import.meta.url);
const NATIVE_TEMPORAL_LABELS = Object.freeze(["frame-zero", "settled", "next"]);

export function temporalCaptureLabel(test) {
  const label = test?.temporal?.capture ?? "next";
  if (!NATIVE_TEMPORAL_LABELS.includes(label)) {
    throw new Error(`Unknown temporal capture label: ${label}`);
  }
  return label;
}

/**
 * The environment a parity run reads. Values are hashed, never recorded, so a report can say
 * that two runs saw a different `ANDROID_SDK_ROOT` without publishing anyone's home directory.
 * A key that was unset is recorded with a null digest rather than omitted — "not set" is the
 * observation that separated the two 2026-08-10 Android ledgers, so it has to survive.
 */
export const PROVENANCE_ENV_KEYS = Object.freeze([
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "DISPLAY",
  "MYSTRAL_BIN",
  "THREENATIVE_RUNTIME_BINARY",
  "THREENATIVE_TOUCH_DEVICE",
  "TN_ANDROID_ROTATION_TIMEOUT_MS",
  "TN_ANDROID_SETTLE_MS",
  "TN_ANDROID_TIMEOUT_MS",
  "TN_BROWSER_TIMEOUT_MS",
  "TN_MULTITOUCH_DROP_POINTER",
  "TN_MULTITOUCH_TIMEOUT_MS",
  "TN_RUNTIME",
]);

const PROVENANCE_FIELDS = Object.freeze([
  "commit",
  "dirty",
  "runtimeSha256",
  "referenceSetSha256",
  "device",
  "env",
]);

const REPORT_FIELDS = Object.freeze([
  "schemaVersion",
  "registrySchemaVersion",
  "generatedAt",
  "threeVersion",
  "mode",
  "target",
  "project",
  "host",
  "provenance",
  "summary",
  "results",
  "supplemental",
]);

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/u;

export function fileSha256(path) {
  return path && existsSync(path) ? sha256(readFileSync(path)) : null;
}

/**
 * One digest over the whole browser capture set a native lane compared against, so a later
 * reader can tell "the same rows against a different reference" from a real regression.
 */
export function captureSetSha256(directory) {
  if (!directory || !existsSync(directory)) return null;
  const names = readdirSync(directory)
    .filter((name) => name.toLowerCase().endsWith(".png"))
    .sort();
  if (names.length === 0) return null;
  const manifest = names
    .map((name) => `${name}:${sha256(readFileSync(join(directory, name)))}`)
    .join("\n");
  return sha256(manifest);
}

export function gitProvenance(cwd = workspaceRoot) {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  if (head.status !== 0 || status.status !== 0) {
    throw new Error(
      "TN_PARITY_PROVENANCE_UNAVAILABLE: git could not identify the tree this run was made " +
        "from, so the report would not be traceable to a commit.",
    );
  }
  return { commit: head.stdout.trim(), dirty: status.stdout.trim() !== "" };
}

export function provenanceEnv(env = process.env) {
  return PROVENANCE_ENV_KEYS.map((key) => ({
    key,
    valueSha256: env[key] === undefined ? null : sha256(String(env[key])),
  }));
}

export function buildProvenance(options = {}) {
  const { commit, dirty } = gitProvenance(options.cwd);
  return {
    commit,
    dirty,
    runtimeSha256: fileSha256(options.runtime ?? null),
    referenceSetSha256: captureSetSha256(options.referenceRoot ?? null),
    device: options.device ?? null,
    env: provenanceEnv(options.env),
  };
}

function usage() {
  return `Usage: node conformance/run-conformance.mjs [options]

  --target web|desktop|android|ios|all
                                  Run one lane or the default web/desktop/emulator/simulator matrix
  --target android-hardware       Run only with an explicitly selected physical device
  --project PATH                  Run the configured native entry of a scaffolded project
  --only-tests id,id               Run selected rows; every other row is blocked
  --engine threejs|threenative     Web or desktop lane engine: upstream three (default; the legacy host on
                                  desktop), or the owned C++ engine: the Wasm engine in Chromium on web,
                                  the V8 engine player on desktop (THREENATIVE_ENGINE_PLAYER, else
                                  build/tn-engine-ui). With --reference on web, the row is compared
                                  with that upstream three capture.
  --reference DIR                  Browser capture directory for native comparison
  --device SERIAL                  Android emulator/device serial
  --out PATH                       Report file or artifact directory
  --dry-run                        Validate and bundle without target execution
  --validate-report PATH           Validate an existing report
  --help                           Show this help without executing a lane
`;
}

function valueAfter(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  if (!argv[index + 1] || argv[index + 1].startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return argv[index + 1];
}

function loadRegistry() {
  return JSON.parse(readFileSync(join(runtimeRoot, "conformance/registry.json"), "utf8"));
}

export function validateRegistry(registry) {
  const errors = [];
  if (registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    errors.push(`registry schemaVersion must be ${REGISTRY_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(registry.tests) || registry.tests.length === 0) {
    errors.push("registry.tests must be a non-empty array");
    return errors;
  }
  const packageJson = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  const workspaceCatalog = readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
  const catalogThreeVersion = workspaceCatalog.match(/^\s*three:\s*['"]?([^\s'"]+)['"]?\s*$/m)?.[1];
  if (packageJson.devDependencies?.three !== "catalog:") {
    errors.push("package.json must source Three.js from the workspace catalog");
  }
  if (!catalogThreeVersion || registry.threeVersion !== catalogThreeVersion) {
    errors.push(
      `registry threeVersion ${registry.threeVersion} does not match workspace catalog ${catalogThreeVersion ?? "missing"}`,
    );
  }
  const ids = new Set();
  const testIds = new Set();
  for (const [index, entry] of registry.tests.entries()) {
    const label = entry?.id || `row ${index}`;
    if (!entry?.id || !/^[a-z0-9][a-z0-9-]*$/u.test(entry.id)) errors.push(`${label}: invalid id`);
    if (ids.has(entry?.id)) errors.push(`${label}: duplicate id`);
    ids.add(entry?.id);
    if (entry?.id !== undefined) testIds.add(entry.id);
    if (!["implemented", "planned"].includes(entry?.status)) {
      errors.push(`${label}: status must be implemented or planned`);
    }
    if (
      entry?.status === "implemented" &&
      (!entry.scene || !existsSync(join(runtimeRoot, entry.scene)))
    ) {
      errors.push(`${label}: implemented row must reference an existing scene`);
    }
    for (const metric of ["pixelMismatchRatio", "perceptualDeltaE"]) {
      const value = entry?.tolerance?.[metric];
      if (!Number.isFinite(value) || value < 0) {
        errors.push(`${label}: tolerance.${metric} must be a non-negative finite number`);
      }
    }
    if (
      entry?.temporal !== undefined
      && !NATIVE_TEMPORAL_LABELS.includes(entry.temporal?.capture ?? "next")
    ) {
      errors.push(`${label}: temporal.capture must be frame-zero, settled, or next`);
    }
    if (entry?.windowedSurface !== undefined) {
      const frames = entry.windowedSurface?.frames;
      if (!Number.isInteger(frames) || frames < 2) {
        errors.push(`${label}: windowedSurface.frames must be an integer of at least 2`);
      }
      if (!Number.isInteger(entry.nativeFrames) || entry.nativeFrames < frames) {
        errors.push(`${label}: nativeFrames must cover the windowed surface proof`);
      }
    }
  }
  if (!Array.isArray(registry.exclusions) || registry.exclusions.length === 0) {
    errors.push("registry.exclusions must be a non-empty array");
  } else {
    for (const [index, entry] of registry.exclusions.entries()) {
      const label = entry?.id || `exclusion ${index}`;
      if (!entry?.id || !/^[a-z0-9][a-z0-9-]*$/u.test(entry.id)) {
        errors.push(`${label}: invalid exclusion id`);
      }
      if (ids.has(entry?.id)) errors.push(`${label}: duplicate id`);
      ids.add(entry?.id);
      if (entry?.status !== "excluded") errors.push(`${label}: status must be excluded`);
      for (const field of ["title", "category", "reason", "owner"]) {
        if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
          errors.push(`${label}: ${field} must be a non-empty string`);
        }
      }
      if (entry?.expires !== undefined && !isValidExclusionExpiry(entry.expires)) {
        errors.push(`${label}: expires must be an ISO date (YYYY-MM-DD)`);
      }
      if (entry?.row !== undefined) {
        if (typeof entry.row !== "string" || !testIds.has(entry.row)) {
          errors.push(`${label}: row must name a registry test id`);
        }
      }
    }
  }
  if (registry.generatedPlaytestProofs !== undefined) {
    if (!Array.isArray(registry.generatedPlaytestProofs)) {
      errors.push("registry.generatedPlaytestProofs must be an array");
    } else {
      for (const [index, entry] of registry.generatedPlaytestProofs.entries()) {
        const label = entry?.id || `generatedPlaytestProofs ${index}`;
        if (!entry?.id || !/^[a-z0-9][a-z0-9-]*$/u.test(entry.id)) {
          errors.push(`${label}: invalid id`);
        }
        if (ids.has(entry?.id)) errors.push(`${label}: duplicate id`);
        ids.add(entry?.id);
        for (const field of ["category", "runner", "status", "title"]) {
          if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
            errors.push(`${label}: ${field} must be a non-empty string`);
          }
        }
        for (const field of ["proof", "scenario"]) {
          const relative = entry?.[field];
          if (relative === undefined && field === "scenario") continue;
          if (
            typeof relative !== "string" ||
            (!existsSync(join(runtimeRoot, relative)) && !existsSync(join(workspaceRoot, relative)))
          ) {
            errors.push(`${label}: ${field} must reference an existing file`);
          }
        }
      }
    }
  }
  return errors;
}

function isValidExclusionExpiry(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().startsWith(value);
}

export function expiredExclusions(registry, now = Date.now()) {
  return (registry.exclusions ?? []).filter((entry) => {
    if (!isValidExclusionExpiry(entry?.expires)) return false;
    return Date.parse(`${entry.expires}T00:00:00.000Z`) <= now;
  });
}

function validateProvenanceEnv(entries) {
  const errors = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return ["report.provenance.env must be a non-empty array of hashed environment keys"];
  }
  const keys = entries.map((entry) => entry?.key);
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    errors.push("report.provenance.env must be sorted by key");
  }
  if (new Set(keys).size !== keys.length) errors.push("report.provenance.env has duplicate keys");
  for (const entry of entries) {
    const label = typeof entry?.key === "string" ? entry.key : "an unnamed entry";
    if (typeof entry?.key !== "string" || entry.key.trim() === "") {
      errors.push("report.provenance.env entries must carry a non-empty key");
    }
    for (const field of Object.keys(entry ?? {})) {
      if (!["key", "valueSha256"].includes(field)) {
        errors.push(`report.provenance.env.${label}.${field} is not a recognised field`);
      }
    }
    const digest = entry?.valueSha256;
    if (digest !== null && (typeof digest !== "string" || !SHA256_PATTERN.test(digest))) {
      errors.push(`report.provenance.env.${label}.valueSha256 must be null or a sha256 digest`);
    }
  }
  return errors;
}

export function validateProvenance(provenance) {
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
    return [
      "report.provenance must record the commit, runtime, reference set, device and environment " +
        "this run was made from",
    ];
  }
  const errors = [];
  for (const field of PROVENANCE_FIELDS) {
    if (!(field in provenance)) errors.push(`report.provenance.${field} is required`);
  }
  for (const field of Object.keys(provenance)) {
    if (!PROVENANCE_FIELDS.includes(field)) {
      errors.push(`report.provenance.${field} is not a recognised provenance field`);
    }
  }
  if (typeof provenance.commit !== "string" || !COMMIT_PATTERN.test(provenance.commit)) {
    errors.push("report.provenance.commit must be a git object id");
  }
  if (typeof provenance.dirty !== "boolean") {
    errors.push("report.provenance.dirty must be a boolean");
  }
  for (const field of ["runtimeSha256", "referenceSetSha256"]) {
    const digest = provenance[field];
    if (digest !== null && (typeof digest !== "string" || !SHA256_PATTERN.test(digest))) {
      errors.push(`report.provenance.${field} must be null or a sha256 digest`);
    }
  }
  if (
    provenance.device !== null &&
    (typeof provenance.device !== "string" || provenance.device.trim() === "")
  ) {
    errors.push("report.provenance.device must be null or a non-empty device serial");
  }
  return [...errors, ...validateProvenanceEnv(provenance.env)];
}

/**
 * Validates a conformance report.
 *
 * `suite` names a lane that brings its own rows: the native-engine fixture suite reports each
 * fixture as a row instead of a registry scene, so its ids come from `expectedIds` and a `pass`
 * means every observation matched. Everything else — the field list, the provenance contract, the
 * statuses, the summary arithmetic and the exit code — is the same rule every lane answers to.
 */
export function validateReport(report, registry, options = {}) {
  const errors = [];
  const suite = options.suite ?? null;
  for (const field of Object.keys(report)) {
    if (!REPORT_FIELDS.includes(field)) {
      errors.push(`report.${field} is not a recognised report field`);
    }
  }
  errors.push(...validateProvenance(report.provenance));
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION) {
    errors.push(`report schemaVersion must be ${REPORT_SCHEMA_VERSION}`);
  }
  if (report.registrySchemaVersion !== registry.schemaVersion) {
    errors.push("report registrySchemaVersion must match registry.schemaVersion");
  }
  if (report.threeVersion !== registry.threeVersion) {
    errors.push("report threeVersion must match registry.threeVersion");
  }
  if (!["dry-run", "execution"].includes(report.mode))
    errors.push("report mode must be dry-run or execution");
  if (!Array.isArray(report.results)) {
    errors.push("report.results must be an array");
    return errors;
  }
  const expectedIds = options.expectedIds ?? registry.tests.map((entry) => entry.id);
  const resultIds = report.results.map((entry) => entry.id);
  if (JSON.stringify(resultIds) !== JSON.stringify(expectedIds)) {
    errors.push(
      options.expectedIds === undefined
        ? "report result IDs/order must exactly match the registry"
        : "report result IDs/order must exactly match the suite's rows",
    );
  }
  for (const exclusion of registry.exclusions ?? []) {
    if (exclusion.target !== report.target || typeof exclusion.row !== "string") continue;
    const result = report.results.find((entry) => entry.id === exclusion.row);
    if (result?.status === "pass") {
      errors.push(`${exclusion.row}: ${exclusion.id} is excluded for target ${report.target}`);
    }
  }
  const executionStatuses = new Set(["pass", "fail", "blocked"]);
  const dryStatuses = new Set(["fail", "blocked", "planned", "validated"]);
  const actualSummary = { pass: 0, fail: 0, blocked: 0, planned: 0, validated: 0 };
  for (const result of report.results) {
    const allowed = report.mode === "execution" ? executionStatuses : dryStatuses;
    if (!allowed.has(result.status)) {
      errors.push(`${result.id}: ${report.mode} report may not use status ${result.status}`);
      continue;
    }
    actualSummary[result.status] += 1;
    if (result.status !== "pass") continue;
    const target = report.target || "desktop";
    if (suite === "native-engine") {
      if (result.native?.completed !== true) {
        errors.push(`${result.id}: pass requires a completed native driver run`);
      }
      if (result.fixture?.matched !== result.fixture?.observations) {
        errors.push(`${result.id}: pass requires every observation to match`);
      }
      if (!Array.isArray(result.gpuValidationErrors) || result.gpuValidationErrors.length > 0) {
        errors.push(`${result.id}: pass requires zero GPU validation errors`);
      }
    } else if (target === "web") {
      if (result.browser?.completed !== true) {
        errors.push(`${result.id}: pass requires completed browser execution`);
      }
      if (result.browser?.uniform !== false)
        errors.push(`${result.id}: pass requires a non-uniform browser capture`);
    } else {
      if (result.browser?.completed !== true) {
        errors.push(`${result.id}: pass requires completed browser execution`);
      }
      if (result.native?.completed !== true)
        errors.push(`${result.id}: pass requires completed native execution`);
      if (result.browser?.uniform !== false || result.native?.uniform !== false) {
        errors.push(`${result.id}: pass requires non-uniform reference and candidate captures`);
      }
      if (!Number.isFinite(result.metrics?.pixelMismatchRatio)) {
        errors.push(`${result.id}: pass requires finite pixelMismatchRatio`);
      }
      if (!Number.isFinite(result.metrics?.perceptualDeltaE)) {
        errors.push(`${result.id}: pass requires finite perceptualDeltaE`);
      }
      if (!Array.isArray(result.gpuValidationErrors) || result.gpuValidationErrors.length > 0) {
        errors.push(`${result.id}: pass requires zero GPU validation errors`);
      }
    }
  }
  for (const [status, count] of Object.entries(actualSummary)) {
    if (report.summary?.[status] !== count) errors.push(`summary.${status} must equal ${count}`);
  }
  if (report.mode === "execution" && report.target === "android" && report.project === null) {
    const multitouch = report.supplemental?.androidMultitouch;
    if (!multitouch || !["pass", "fail"].includes(multitouch.status)) {
      errors.push("Android report requires supplemental.androidMultitouch pass or fail evidence");
    } else if (
      (multitouch.status === "pass" && multitouch.exitCode !== 0) ||
      (multitouch.status === "fail" && multitouch.exitCode === 0)
    ) {
      errors.push("supplemental.androidMultitouch status must match its exitCode");
    }
  }
  for (const exclusion of report.supplemental?.expiredExclusions ?? []) {
    if (
      typeof exclusion?.id !== "string"
      || exclusion.status !== "blocked"
      || !isValidExclusionExpiry(exclusion.expires)
    ) {
      errors.push("supplemental.expiredExclusions entries must identify a blocked exclusion and its expiry");
    }
  }
  return errors;
}

export function makeEntry(test, target, port, entryRoot) {
  const sceneAbs = join(runtimeRoot, test.scene);
  const entryAbs = join(entryRoot, `${target}-${test.id}.js`);
  const sceneRelative = `./${relative(dirname(entryAbs), sceneAbs).replaceAll("\\", "/")}`;
  const canvasExpression =
    target === "browser" ? "document.getElementById('c')" : "globalThis.canvas";
  const proofImport =
    test.inputProof === "multitouch"
      ? `import { isMultitouchProofSatisfied } from './${relative(
          dirname(entryAbs),
          join(runtimeRoot, "conformance/multitouch-proof.mjs"),
        ).replaceAll("\\", "/")}';`
      : "";
  const proofWait = test.inputProof === "multitouch"
    ? `await new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(new Error('multitouch proof timed out')), ${Number(process.env.TN_MULTITOUCH_TIMEOUT_MS || 60000)});
  const check = () => {
    const proof = globalThis.__TN_MULTITOUCH_PROOF__;
    if (isMultitouchProofSatisfied(proof)) {
      clearTimeout(deadline);
      resolve();
      return;
    }
    requestAnimationFrame(check);
  };
  check();
});
console.info(${JSON.stringify(`TN_MULTITOUCH_PROOF_PASS:${test.id}`)});`
    : "";
  const waitForSubmittedWork = "if (state?.renderer?.backend?.device?.queue?.onSubmittedWorkDone) await state.renderer.backend.device.queue.onSubmittedWorkDone();";
  const finalCapture = `${waitForSubmittedWork}
const response = await fetch('/__tn_conformance__/complete/${encodeURIComponent(test.id)}', { method: 'POST' });
if (!response.ok) throw new Error('compositor capture failed: ' + response.status + ' ' + await response.text());`;
  const browserCapture = test.temporal
    ? `const captureFrame = async (label) => {
  ${waitForSubmittedWork}
  const frameResponse = await fetch('/__tn_conformance__/complete/${encodeURIComponent(test.id)}/' + label, { method: 'POST' });
  if (!frameResponse.ok) throw new Error('temporal compositor capture failed: ' + frameResponse.status + ' ' + await frameResponse.text());
};
await captureFrame('frame-zero');
for (let frame = 0; frame < ${Number(test.temporal.settledFrame)}; frame += 1) await new Promise(requestAnimationFrame);
await captureFrame('settled');
await new Promise(requestAnimationFrame);
await captureFrame('next');
${finalCapture}`
    : `for (let frame = 0; frame < ${test.captureFrames ?? 2}; frame += 1) await new Promise(requestAnimationFrame);
${finalCapture}`;
  // A conformance scene is not a game: nothing installs core's startup readiness, so the native
  // screenshot gate waited out its full 30 s budget on every row (run 36448456340: 74 rows,
  // 36-39 s each, all logging "startup gate never opened"). The scene has started once
  // startScene resolves; say so, and the gate captures the next frame instead.
  const completion =
    target === "browser"
      ? `console.info(${JSON.stringify(`TN_CONFORMANCE_READY:${test.id}`)});
${proofWait}
${browserCapture}
`
      : `console.info(${JSON.stringify(`TN_CONFORMANCE_READY:${test.id}`)});
${proofWait}
globalThis.__TN_STARTUP_READY__ = true;`;
  const error =
    target === "browser"
      ? `await fetch('/__tn_conformance__/error/${encodeURIComponent(test.id)}', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: globalThis.__TN_CONFORMANCE_ERROR__ }).catch(() => {});`
      : "console.error('[ThreeNative conformance] failed:', error && error.stack ? error.stack : error);";
  const asyncStart = target === "browser" ? "" : "void (async () => {";
  const asyncEnd = target === "browser" ? "" : "})();";
  writeFileSync(
    entryAbs,
    `import { startScene } from '${sceneRelative}';
${proofImport}
${asyncStart}
globalThis.__TN_ASSET_BASE__ = 'http://127.0.0.1:${port}/';
globalThis.__TN_CONFORMANCE_TARGET__ = ${JSON.stringify(target)};
const canvas = ${canvasExpression};
try {
  const state = await startScene(canvas, { width: canvas.width || 1280, height: canvas.height || 720 });
  ${completion}
  globalThis.__TN_CONFORMANCE_DONE__ = true;
} catch (error) {
  globalThis.__TN_CONFORMANCE_ERROR__ = String(error && error.stack ? error.stack : error);
  ${error}
}
${asyncEnd}
`,
  );
  return entryAbs;
}

let compilerPromise;

export async function bundle(entry, out, result, side, esbuildBin, dryRun, format = "esm", conditions = []) {
  if (!existsSync(esbuildBin)) {
    result.status = dryRun ? "fail" : "blocked";
    result.blockedReason =
      "Install JavaScript dependencies so esbuild can bundle the conformance scene.";
    return false;
  }
  let timer;
  let compiler;
  try {
    compilerPromise ??= import("esbuild");
    compiler = await compilerPromise;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(
        new Error("TN_CONFORMANCE_BUNDLE_TIMEOUT: esbuild exceeded 120000ms."),
        { code: "ETIMEDOUT" },
      )), 120_000);
    });
    await Promise.race([
      compiler.build({
        absWorkingDir: runtimeRoot,
        entryPoints: [entry],
        outfile: out,
        bundle: true,
        format,
        platform: "browser",
        // The CLI reads NODE_PATH for each invocation; the API requires explicit paths.
        nodePaths: (process.env.NODE_PATH || "").split(delimiter).filter(Boolean),
        sourcemap: true,
        logLevel: "silent",
        ...(side === "native" ? {
          define: { "import.meta.env": '{"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false}' },
        } : {}),
        // Repeated CLI --conditions flags replace the previous value; comma-separated values
        // within the final flag are retained. Match that behavior when translating to the API.
        ...(conditions.length > 0
          ? { conditions: conditions.at(-1).split(",").filter(Boolean) }
          : {}),
      }),
      timeout,
    ]);
    return true;
  } catch (error) {
    let cleanupError;
    if (error?.code === "ETIMEDOUT") {
      try { await compiler?.stop(); } catch (cleanup) { cleanupError = String(cleanup); }
    }
    result.status = "fail";
    result[side] = {
      phase: "bundle",
      exitCode: error?.code === "ETIMEDOUT" ? null : 1,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
      ...(error?.code === "ETIMEDOUT" ? { timedOut: true, errorCode: error.code } : {}),
      ...(cleanupError ? { cleanupError } : {}),
    };
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function contentType(path) {
  if (path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".glb")) return "model/gltf-binary";
  if (path.endsWith(".gltf")) return "model/gltf+json";
  if (path.endsWith(".bin")) return "application/octet-stream";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
}

function createCompletionBroker() {
  const waiters = new Map();
  const captureHandlers = new Map();
  return {
    wait(id, timeoutMs) {
      return new Promise((resolvePromise) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          resolvePromise({
            kind: "timeout",
            error: `browser did not report completion within ${timeoutMs}ms`,
          });
        }, timeoutMs);
        waiters.set(id, {
          cancel() {
            clearTimeout(timer);
            waiters.delete(id);
          },
          settle(value) {
            clearTimeout(timer);
            waiters.delete(id);
            resolvePromise(value);
          },
        });
      });
    },
    capture(id, handler) {
      captureHandlers.set(id, handler);
    },
    cancel(id) {
      waiters.get(id)?.cancel();
      captureHandlers.delete(id);
    },
    async handle(req, res, pathname) {
      const match = pathname.match(/^\/__tn_conformance__\/(complete|error)\/([a-z0-9-]+)(?:\/([a-z-]+))?$/u);
      if (!match || req.method !== "POST") return false;
      const [, kind, id, frameLabel] = match;
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 20 * 1024 * 1024) {
          res.writeHead(413);
          res.end("payload too large");
          return true;
        }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const waiter = waiters.get(id);
      if (kind === "complete") {
        const capture = captureHandlers.get(id);
        if (capture === undefined) {
          const error = `browser capture handler is missing for ${id}`;
          res.writeHead(409);
          res.end(error, () => waiter?.settle({ kind: "error", error }));
          return true;
        }
        try {
          const screenshot = await capture(frameLabel);
          res.writeHead(204);
          if (frameLabel !== undefined) {
            res.end();
          } else {
            res.end(() => waiter?.settle({ kind: "complete", screenshot }));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          res.writeHead(500);
          res.end(message, () => {
            if (frameLabel === undefined) waiter?.settle({ kind: "error", error: message });
          });
        }
      } else {
        const error = data.toString("utf8") || "browser reported an empty screenshot";
        res.writeHead(kind === "error" ? 204 : 400);
        res.end(() => waiter?.settle({ kind: "error", error }));
      }
      return true;
    },
  };
}

export async function captureBrowserCanvas(page, screenshot) {
  await page.locator("#c").screenshot({ path: screenshot, timeout: 90_000 });
}

async function withServer(captureRoot, assetRoot, fn) {
  const broker = createCompletionBroker();
  const rootPrefix = runtimeRoot.endsWith(sep) ? runtimeRoot : `${runtimeRoot}${sep}`;
  const assetPrefix = assetRoot && (assetRoot.endsWith(sep) ? assetRoot : `${assetRoot}${sep}`);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (await broker.handle(req, res, url.pathname)) return;
    const pathname = `.${decodeURIComponent(url.pathname)}`;
    const runtimeFile = resolve(runtimeRoot, pathname);
    const assetFile = assetRoot ? resolve(assetRoot, pathname) : null;
    if (runtimeFile !== runtimeRoot && !runtimeFile.startsWith(rootPrefix)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    if (assetFile && assetFile !== assetRoot && !assetFile.startsWith(assetPrefix)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const file = assetFile && existsSync(assetFile) ? assetFile : runtimeFile;
      const data = readFileSync(file);
      res.writeHead(200, { "content-type": contentType(file), "access-control-allow-origin": "*" });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((resolvePromise) => server.listen(0, "127.0.0.1", resolvePromise));
  try {
    return await fn({ port: server.address().port, broker });
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
  }
}

async function runBrowser(test, bundlePath, result, port, broker, captureRoot) {
  if (process.platform === "linux" && !process.env.DISPLAY) {
    result.status = "blocked";
    result.blockedReason =
      "Browser WebGPU capture requires Xvfb; run with sh scripts/xvfb.sh <cmd>.";
    return;
  }
  let chromium;
  try {
    ({ chromium } = await import("@playwright/test"));
  } catch {
    result.status = "blocked";
    result.blockedReason = "Install @playwright/test and its Chromium browser before web capture.";
    return;
  }
  const htmlRelative = `artifacts/conformance/browser-${test.id}.html`;
  const html = join(runtimeRoot, htmlRelative);
  const bundleRelative = `/${relative(runtimeRoot, bundlePath).replaceAll("\\", "/")}`;
  writeFileSync(
    html,
    `<!doctype html><meta charset="utf-8"><base href="/"><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden}canvas{display:block}</style><canvas id="c" width="1280" height="720"></canvas><script type="module" src="${bundleRelative}"></script>`,
  );
  const url = `http://127.0.0.1:${port}/${htmlRelative}`;
  let browser;
  const pageErrors = [];
  const worldProofOutput = [];
  let adapterInfo = null;
  try {
    browser = await chromium.launch({
      headless: false,
      timeout: 30_000,
      args: [
        "--ozone-platform=x11",
        "--enable-unsafe-webgpu",
        "--disable-gpu-sandbox",
        "--ignore-gpu-blocklist",
        "--enable-features=Vulkan",
      ],
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    if (test.id === "world-gpu-scene-readback")
      page.on("console", (message) => {
        if (message.text().startsWith("TN_WORLD_GPU_")) worldProofOutput.push(message.text());
      });
    const completion = broker.wait(test.id, Number(process.env.TN_BROWSER_TIMEOUT_MS || 90_000));
    broker.capture(test.id, async (frameLabel) => {
      const screenshot = join(captureRoot, `${test.id}${frameLabel ? `-${frameLabel}` : ""}.png`);
      await captureBrowserCanvas(page, screenshot);
      return screenshot;
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    adapterInfo = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return null;
      const info = adapter.info ?? {};
      return {
        architecture: info.architecture ?? "",
        description: info.description ?? "",
        device: info.device ?? "",
        vendor: info.vendor ?? "",
      };
    });
    if (test.requiresHardwareAdapter === true) {
      const adapterText = JSON.stringify(adapterInfo ?? "");
      if (adapterInfo === null || isSoftwareAdapter(adapterText)) {
        throw new Error(`TN_CONFORMANCE_HARDWARE_ADAPTER_REQUIRED:${adapterText}`);
      }
    }
    if (test.inputProof === "multitouch") {
      await page.waitForFunction(() => globalThis.__TN_MULTITOUCH_INPUT_READY__ === true, null, {
        timeout: Number(process.env.TN_BROWSER_TIMEOUT_MS || 90_000),
      });
      const proofPoints =
        process.env.TN_MULTITOUCH_DROP_POINTER === "1"
          ? MULTITOUCH_PROOF_POINTS.slice(0, 1)
          : MULTITOUCH_PROOF_POINTS;
      await page.evaluate((points) => {
        const canvas = document.querySelector("canvas");
        if (!(canvas instanceof EventTarget)) throw new Error("multitouch proof canvas is missing");
        for (const point of points) {
          canvas.dispatchEvent(new PointerEvent("pointerdown", {
            bubbles: true,
            buttons: 1,
            clientX: point.x * 1280,
            clientY: point.y * 720,
            isPrimary: point.id === points[0].id,
            pointerId: point.id,
            pointerType: "touch",
          }));
        }
      }, proofPoints);
    }
    const outcome = await completion;
    broker.cancel(test.id);
    result.browser = {
      completed: outcome.kind === "complete",
      screenshot: outcome.screenshot || null,
      url,
      pageErrors,
      uniform: null,
      adapterInfo,
    };
    if (outcome.kind !== "complete" || !outcome.screenshot || !existsSync(outcome.screenshot)) {
      result.status = "fail";
      result.browser.error = outcome.error || "Chromium exited before capture completion.";
      return;
    }
    try {
      const comparisonScreenshot = test.temporal === undefined
        ? outcome.screenshot
        : join(captureRoot, `${test.id}-${temporalCaptureLabel(test)}.png`);
      if (!comparisonScreenshot || !existsSync(comparisonScreenshot)) {
        throw new Error(`TN_CONFORMANCE_TEMPORAL_CAPTURE_MISSING:${test.id}`);
      }
      const inspection = inspectCapture(readFileSync(comparisonScreenshot));
      result.browser.screenshot = comparisonScreenshot;
      result.browser.uniform = inspection.uniform;
      result.browser.width = inspection.width;
      result.browser.height = inspection.height;
      if (test.id === "30-screen-space-text") {
        result.browser.glyphRaster = inspectScreenSpaceGlyphs(readFileSync(outcome.screenshot));
      }
      if (test.temporal !== undefined) {
        const temporalObservation = await page.evaluate(
          () => globalThis.__TN_CONFORMANCE_TEMPORAL ?? null,
        );
        if (
          temporalObservation === null
          || temporalObservation.restoredFrameRendered !== true
          || temporalObservation.restoredToFrameZero !== true
        ) {
          throw new Error(`TN_CONFORMANCE_TEMPORAL_RESTORE_MISSING:${test.id}`);
        }
        const temporal = {
          frameZero: join(captureRoot, `${test.id}-frame-zero.png`),
          settled: join(captureRoot, `${test.id}-settled.png`),
          next: join(captureRoot, `${test.id}-next.png`),
        };
        if (Object.values(temporal).some((path) => !existsSync(path))) {
          throw new Error(`TN_CONFORMANCE_TEMPORAL_CAPTURE_MISSING:${test.id}`);
        }
        const hashes = Object.fromEntries(
          Object.entries(temporal).map(([label, path]) => [label, sha256(readFileSync(path))]),
        );
        if (hashes.settled === hashes.frameZero || hashes.next === hashes.frameZero) {
          throw new Error(`TN_CONFORMANCE_FROZEN_TEMPORAL_HISTORY:${test.id}`);
        }
        result.browser.temporal = { captures: temporal, hashes, observation: temporalObservation };
      }
    } catch (error) {
      result.status = "fail";
      result.browser.error = error instanceof Error ? error.message : String(error);
    }
    if (pageErrors.length > 0) result.status = "fail";
    if (test.id === "world-gpu-scene-readback") {
      result.browser.worldProof = validateWorldGpuReadbackOutput(worldProofOutput.join("\n"));
      if (result.browser.worldProof.errors.length > 0) result.status = "fail";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const adapterBlocker = hardwareAdapterBlocker(message);
    if (adapterBlocker === null) result.status = "fail";
    else {
      result.status = "blocked";
      result.blockedReason = adapterBlocker;
    }
    result.browser = {
      completed: false,
      screenshot: null,
      uniform: null,
      url,
      error: message,
      pageErrors,
      adapterInfo,
    };
  } finally {
    broker.cancel(test.id);
    await browser?.close();
  }
  mkdirSync(captureRoot, { recursive: true });
}

function validationErrors(output) {
  const pattern =
    /GPUValidationError|Validation Error|Device error \(Validation\)|Unhandled|ThreeNative conformance\] failed/giu;
  return output.match(pattern) || [];
}

export function validateWorldGpuReadbackOutput(log) {
  const lineFor = (prefix) => log.split("\n").find((entry) => entry.includes(prefix)) ?? "";
  const fields = (line) => {
    return Object.fromEntries([...line.matchAll(/(?:^|\s)([a-zA-Z]+)=(\d+)(?=\s|$)/gu)]
      .map((match) => [match[1], Number(match[2])]));
  };
  const handoff = fields(lineFor("TN_WORLD_GPU_IMPOSTOR_HANDOFF "));
  const lifecycleLine = lineFor("TN_WORLD_GPU_SCENE_READBACK final ");
  const lifecycle = fields(lifecycleLine);
  const errors = [];
  if (!(Object.values(handoff).every(Number.isSafeInteger) &&
    handoff.frames >= 200 && handoff.levelRefilters === 0 &&
    handoff.terminalDrawFrames > 0 && handoff.atlasBytes > 0))
    errors.push("missing or incomplete 200-frame GPU impostor handoff proof");
  if (!(Object.values(lifecycle).every(Number.isSafeInteger) &&
    /(?:^|\s)original=disposed(?:\s|$)/u.test(lifecycleLine) &&
    /(?:^|\s)reload=ready(?:\s|$)/u.test(lifecycleLine) &&
    lifecycle.framewise >= 200 && lifecycle.originalNonempty >= 200 &&
    lifecycle.censuses >= 200 && lifecycle.lastDispatch >= lifecycle.framewise &&
    lifecycle.targetIdentities === 4 && lifecycle.disposeEvents === 4 &&
    lifecycle.releaseEvents >= 400 && lifecycle.reloadNonempty > 0 && lifecycle.reloadFailures === 0))
    errors.push("missing or incomplete GPU readback disposal/reload proof");
  return { handoff, lifecycle, errors };
}

/**
 * The windowed native lane must prove the surface path itself, not only a file written after it.
 * Each marker is emitted after a surface texture view was acquired and the host presented it;
 * the count and the native CLI's present total make a missing or swapped window argument visible.
 */
export function validateWindowedSurfaceOutput(log, { frames = 2 } = {}) {
  const errors = [];
  const surfaceFrames = [];
  let previousPresent = 0;
  for (const match of log.matchAll(/TN_SURFACE_FRAME:(\{[^\r\n]*\})/gu)) {
    let payload;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      errors.push(`malformed windowed surface frame marker: ${match[1]}`);
      continue;
    }
    surfaceFrames.push(payload);
    if (payload.view !== true) {
      errors.push(`windowed surface frame ${surfaceFrames.length} did not acquire a non-null view`);
    }
    if (!Number.isInteger(payload.present) || payload.present <= previousPresent) {
      errors.push(`windowed surface frame ${surfaceFrames.length} did not report a new successful present`);
    } else {
      previousPresent = payload.present;
    }
  }
  if (surfaceFrames.length < frames) {
    errors.push(
      `missing windowed surface frame marker: observed ${surfaceFrames.length}, expected at least ${frames}`,
    );
  }
  const presentMatch = log.match(/^TN_PRESENTS:(\d+)$/mu);
  const presents = presentMatch === null ? null : Number(presentMatch[1]);
  if (presents === null) {
    errors.push("missing TN_PRESENTS count for the windowed surface proof");
  } else if (presents < frames) {
    errors.push(`windowed surface presented ${presents} frames, expected at least ${frames}`);
  }
  if (/\bDevice error\b/iu.test(log)) errors.push("windowed surface emitted a device error");
  if (/sRGB presentation bridge failed/iu.test(log))
    errors.push("windowed surface presentation bridge failed");
  return {
    errors: [...new Set(errors)],
    frames: surfaceFrames.length,
    presents: presents ?? 0,
  };
}

function nativeTemporalCapturePaths(test, captureRoot) {
  return Object.fromEntries(
    NATIVE_TEMPORAL_LABELS.map((label) => [
      label,
      join(captureRoot, `${test.id}-${label}.png`),
    ]),
  );
}

function nativeTemporalMarker(test, label) {
  return `TN_CONFORMANCE_TEMPORAL_FRAME:${test.realismEffect ?? test.id}:${label}`;
}

function writeNativeScreenshotRequest(mailboxRoot, screenshot) {
  const request = join(mailboxRoot, "tn-playtest-screenshot-request.txt");
  const temporary = `${request}.tmp`;
  rmSync(temporary, { force: true });
  writeFileSync(temporary, screenshot, "utf8");
  renameSync(temporary, request);
}

export async function waitForNativeMarker(child, output, marker, timeoutMs, failMarker = null) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (output.stdout.includes(marker) || output.stderr.includes(marker)) return;
    if (failMarker !== null) {
      const text = `${output.stdout}\n${output.stderr}`;
      const at = text.indexOf(failMarker);
      if (at !== -1) throw new Error(`Native scene failed before ${marker}: ${text.slice(at, at + 1500)}`);
    }
    if (output.error) throw output.error;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Native process exited before ${marker}: ${(output.stderr || output.stdout).slice(-2000)}`,
      );
    }
    await wait(25);
  }
  throw new Error(`Native process timed out waiting for ${marker}.`);
}

async function attachNativeWallClock(child, mailboxRoot, timeoutMs) {
  const request = join(mailboxRoot, "tn-playtest-request.json");
  const response = join(mailboxRoot, "tn-playtest-response.json");
  writeFileSync(`${request}.tmp`, JSON.stringify({ id: "clock", method: "_setClockMode", argument: "wall-clock" }), "utf8");
  renameSync(`${request}.tmp`, request);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const answer = existsSync(response) ? readFileSync(response, "utf8") : "";
    if (answer.includes('"id":"clock"')) {
      if (answer.includes('"error"')) throw new Error(`TN_PARITY_OWNED_CLOCK: ${answer}`);
      return;
    }
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Native process exited before it took the wall clock");
    await wait(25);
  }
  throw new Error("TN_PARITY_OWNED_CLOCK: the player did not answer _setClockMode");
}

async function waitForNativeScreenshot(child, outputPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (existsSync(outputPath)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Native process exited before screenshot capture: ${outputPath}`);
    }
    await wait(25);
  }
  throw new Error(`Native screenshot capture timed out: ${outputPath}`);
}

async function stopNativeCaptureProcess(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline && child.exitCode === null && child.signalCode === null) {
    await wait(25);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

function validateNativeTemporalCaptures(test, captures) {
  const inspections = Object.fromEntries(
    NATIVE_TEMPORAL_LABELS.map((label) => {
      const path = captures[label];
      if (!existsSync(path)) throw new Error(`TN_CONFORMANCE_TEMPORAL_CAPTURE_MISSING:${test.id}:${label}`);
      const inspection = inspectCapture(readFileSync(path), {
        allowUniform: label !== temporalCaptureLabel(test),
      });
      return [label, inspection];
    }),
  );
  const hashes = Object.fromEntries(
    NATIVE_TEMPORAL_LABELS.map((label) => [label, sha256(readFileSync(captures[label]))]),
  );
  if (hashes.settled === hashes.frameZero || hashes.next === hashes.frameZero) {
    throw new Error(`TN_CONFORMANCE_FROZEN_TEMPORAL_HISTORY:${test.id}`);
  }
  return { hashes, inspections };
}

async function captureNativeTemporalFrames(
  test,
  executableBundle,
  runtime,
  captureRoot,
  cwd = runtimeRoot,
) {
  const captures = nativeTemporalCapturePaths(test, captureRoot);
  const mailboxRoot = mkdtempSync(join(tmpdir(), "threenative-parity-native-temporal-"));
  const output = { error: null, stderr: "", stdout: "" };
  for (const path of Object.values(captures)) rmSync(path, { force: true });
  writeNativeScreenshotRequest(mailboxRoot, captures["frame-zero"]);
  const child = spawn(
    runtime,
    ["run", executableBundle, "--width", "1280", "--height", "720"],
    {
      cwd,
      env: {
        ...process.env,
        ...(process.platform === "linux" ? { SDL_VIDEODRIVER: "x11" } : {}),
        MYSTRAL_HEADLESS: "1",
        TN_PLAYTEST_MAILBOX_ROOT: mailboxRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => {
    output.stdout += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output.stderr += String(chunk);
  });
  child.on("error", (error) => {
    output.error = error;
  });
  const timeoutMs = 45_000;
  try {
    await waitForNativeScreenshot(child, captures["frame-zero"], timeoutMs);
    await waitForNativeMarker(child, output, nativeTemporalMarker(test, "settled"), timeoutMs);
    writeNativeScreenshotRequest(mailboxRoot, captures.settled);
    await waitForNativeScreenshot(child, captures.settled, timeoutMs);
    await waitForNativeMarker(child, output, nativeTemporalMarker(test, "next"), timeoutMs);
    writeNativeScreenshotRequest(mailboxRoot, captures.next);
    await waitForNativeScreenshot(child, captures.next, timeoutMs);
    const temporal = validateNativeTemporalCaptures(test, captures);
    const gpuValidationErrors = validationErrors(`${output.stdout}\n${output.stderr}`);
    return {
      ...temporal,
      captures,
      gpuValidationErrors,
      stderr: output.stderr,
      stdout: output.stdout,
    };
  } finally {
    await stopNativeCaptureProcess(child);
    rmSync(mailboxRoot, { recursive: true, force: true });
  }
}

/**
 * The engine a web or desktop lane runs. `threejs` (the default of this tool) runs upstream three:
 * in Chromium on web, on the legacy `mystral` host on desktop. `threenative` runs the owned C++
 * engine, the way a game with the default `engine` setting runs (NATIVE-ENGINE-DECISION.md,
 * 2026-10-15): the Wasm engine in Chromium on web, the V8 engine player on desktop.
 */
export function desktopEngine(argv) {
  const engine = valueAfter(argv, "--engine") ?? "threejs";
  if (!["threejs", "threenative"].includes(engine)) {
    throw new Error(`--engine must be threejs or threenative; received ${engine}`);
  }
  return engine;
}

export function ownedEngineWasmPath() {
  return join(runtimeRoot, "build/web/tn-native-engine-web.mjs");
}

/**
 * The web build of a row on the owned engine: esbuild with the web-engine plugin that routes every
 * `three`, `three/webgpu` and `three/tsl` import to the Wasm engine, as a game's Vite build does. The
 * plugin is TypeScript source of create-threenative, so it is bundled to a module first (Node 20
 * cannot import TypeScript). The Wasm file goes beside the bundle, where the engine module looks.
 */
export async function bundleOwnedWeb(entry, outfile, wasmEntry = ownedEngineWasmPath()) {
  const { build } = await import("esbuild");
  if (!existsSync(wasmEntry)) {
    throw new Error(`TN_WASM_ENGINE_MISSING: build tn-native-engine-web; ${wasmEntry} does not exist.`);
  }
  const pluginDir = mkdtempSync(join(tmpdir(), "threenative-parity-web-engine-"));
  try {
    const source = resolve(runtimeRoot, "../create-threenative/src/web-engine.ts");
    const compiled = join(pluginDir, "web-engine.mjs");
    await build({
      entryPoints: [source],
      outfile: compiled,
      bundle: true,
      format: "esm",
      platform: "node",
      packages: "external",
      logLevel: "silent",
      // The plugin finds its sibling modules relative to its own source file.
      define: { "import.meta.url": JSON.stringify(pathToFileURL(source).href) },
    });
    const { createWebEnginePlugin } = await import(pathToFileURL(compiled).href);
    const hooks = createWebEnginePlugin({ root: runtimeRoot, engine: "threenative", wasm: wasmEntry });
    hooks.configResolved({ root: runtimeRoot });
    await build({
      absWorkingDir: runtimeRoot,
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: "esm",
      platform: "browser",
      sourcemap: true,
      logLevel: "silent",
      plugins: [
        {
          name: "threenative-web-engine",
          setup(builder) {
            builder.onResolve({ filter: /.*/ }, (args) => {
              if (args.kind === "entry-point" || args.path.startsWith(".") || isAbsolute(args.path))
                return undefined;
              const id = hooks.resolveId(args.path);
              if (!id) return undefined;
              return id.startsWith("\0") ? { path: id, namespace: "web-engine" } : { path: id };
            });
            builder.onLoad({ filter: /.*/, namespace: "web-engine" }, async (args) => ({
              contents: await hooks.load(args.path),
              loader: "js",
              resolveDir: runtimeRoot,
            }));
          },
        },
      ],
    });
  } finally {
    rmSync(pluginDir, { recursive: true, force: true });
  }
  copyFileSync(wasmEntry.replace(/\.mjs$/u, ".wasm"), join(dirname(outfile), "tn-native-engine-web.wasm"));
}

export function ownedEnginePlayerPath(env = process.env, platform = process.platform) {
  if (env.THREENATIVE_ENGINE_PLAYER) return resolve(env.THREENATIVE_ENGINE_PLAYER);
  const filename = `tn-native-engine-player-v8${platform === "win32" ? ".exe" : ""}`;
  return join(runtimeRoot, "build", "tn-engine-ui", filename);
}

/**
 * One row on the owned engine: the scene is bundled against the engine's own `three` (the bundler
 * refuses an unbound symbol and any upstream three file), the V8 engine player runs it, and the
 * screenshot comes through the playtest mailbox once the scene announced itself.
 */
async function runDesktopOwned(test, bundlePath, result, player, captureRoot) {
  if (!player || !existsSync(player)) {
    result.status = "blocked";
    result.blockedReason = `TN_PARITY_ENGINE_PLAYER_MISSING: the owned engine player does not exist at ${player}. Build tn-native-engine-player-v8 (packages/runtime-native/AGENTS.md) or set THREENATIVE_ENGINE_PLAYER.`;
    return;
  }
  const screenshot = join(captureRoot, `${test.id}.png`);
  const mailboxRoot = mkdtempSync(join(tmpdir(), "threenative-parity-owned-"));
  const output = { error: null, stderr: "", stdout: "" };
  rmSync(screenshot, { force: true });
  const child = spawn(player, [bundlePath, "--width", "1280", "--height", "720"], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      ...(process.platform === "linux" ? { SDL_VIDEODRIVER: "x11" } : {}),
      TN_PLAYTEST_MAILBOX_ROOT: mailboxRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => { output.stdout += String(chunk); });
  child.stderr?.on("data", (chunk) => { output.stderr += String(chunk); });
  child.on("error", (error) => { output.error = error; });
  try {
    await waitForNativeMarker(
      child,
      output,
      `TN_CONFORMANCE_READY:${test.id}`,
      Number(process.env.TN_PARITY_OWNED_READY_MS ?? 120_000),
      "[ThreeNative conformance] failed:",
    );
    // A player with a mailbox holds its loop until the runner's first request, then steps only when
    // asked, so the settle below drew no frame and the capture was the first one (a post chain whose
    // passes fill on later frames read as missing). Attach on the wall clock, as a game runs.
    await attachNativeWallClock(child, mailboxRoot, 30_000);
    // Frames the scene needs to settle: the legacy lane waits for frame `nativeFrames` (300).
    await wait(Number(process.env.TN_PARITY_OWNED_SETTLE_MS ?? 3_000));
    writeNativeScreenshotRequest(mailboxRoot, screenshot);
    await waitForNativeScreenshot(child, screenshot, 60_000);
    const combined = `${output.stdout}\n${output.stderr}`;
    const gpuErrors = validationErrors(combined);
    result.gpuValidationErrors.push(...gpuErrors);
    const inspection = inspectCapture(readFileSync(screenshot));
    result.native = {
      completed: gpuErrors.length === 0 && !/TypeError|ReferenceError|SyntaxError/iu.test(combined),
      engine: "threenative",
      exitCode: null,
      screenshot,
      stdout: output.stdout.slice(-4000),
      stderr: output.stderr.slice(-4000),
      uniform: inspection.uniform,
    };
    if (!result.native.completed) result.status = "fail";
  } catch (error) {
    result.status = "fail";
    result.native = {
      completed: false,
      engine: "threenative",
      error: error instanceof Error ? error.message : String(error),
      stdout: output.stdout.slice(-4000),
      stderr: output.stderr.slice(-4000),
      uniform: null,
    };
  } finally {
    await stopNativeCaptureProcess(child);
    rmSync(mailboxRoot, { recursive: true, force: true });
  }
}

async function runDesktop(test, bundlePath, result, runtime, captureRoot, assets, runtimeBlocker = null) {
  if (!runtime || !existsSync(runtime)) {
    result.status = "blocked";
    result.blockedReason =
      runtimeBlocker ||
      "TN_PARITY_DESKTOP_RUNTIME_MISSING: build the desktop runtime or set THREENATIVE_RUNTIME_BINARY/TN_RUNTIME. A clean build additionally requires CMake, a C++ compiler, and platform development libraries; Node 20, JDK 17, and an Android SDK are insufficient.";
    return;
  }
  const screenshot = join(captureRoot, `${test.id}.png`);
  const staging = assets ? mkdtempSync(join(tmpdir(), "threenative-parity-desktop-")) : null;
  const executableBundle = staging ? stageDesktopFiles(bundlePath, assets, staging) : bundlePath;
  try {
    if (test.temporal !== undefined) {
      const temporal = await captureNativeTemporalFrames(
        test,
        executableBundle,
        runtime,
        captureRoot,
        staging || runtimeRoot,
      );
      result.gpuValidationErrors.push(...temporal.gpuValidationErrors);
      const finalLabel = temporalCaptureLabel(test);
      const finalInspection = temporal.inspections[finalLabel];
      result.native = {
        completed: temporal.gpuValidationErrors.length === 0,
        exitCode: null,
        screenshot: temporal.captures[finalLabel],
        stdout: temporal.stdout.slice(-4000),
        stderr: temporal.stderr.slice(-4000),
        uniform: finalInspection.uniform,
        width: finalInspection.width,
        height: finalInspection.height,
        temporal: {
          captures: temporal.captures,
          hashes: temporal.hashes,
          observation: {
            frameZeroRendered: true,
            nextFrameRendered: true,
            settledFrameRendered: true,
          },
        },
      };
      if (temporal.gpuValidationErrors.length > 0) result.status = "fail";
      return;
    }
    const proc = spawnSync(
      runtime,
      [
        "run",
        executableBundle,
        "--screenshot",
        screenshot,
        "--frames",
        String(test.nativeFrames ?? 300),
        "--width",
        "1280",
        "--height",
        "720",
      ],
      {
        cwd: staging || runtimeRoot,
        encoding: "utf8",
        env:
          process.platform === "linux"
            ? { ...process.env, SDL_VIDEODRIVER: "x11" }
            : process.env,
        timeout: 180_000,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const combined = `${proc.stdout || ""}\n${proc.stderr || ""}`;
    const hasScreenshot = existsSync(screenshot);
    result.native = {
      completed: proc.status === 0 && hasScreenshot,
      exitCode: proc.status,
      screenshot: hasScreenshot ? screenshot : null,
      stdout: (proc.stdout || "").slice(-4000),
      stderr: (proc.stderr || "").slice(-4000),
      error: proc.error instanceof Error ? proc.error.message : proc.error ? String(proc.error) : null,
      uniform: null,
    };
    const gpuErrors = validationErrors(combined);
    result.gpuValidationErrors.push(...gpuErrors);
    if (test.id === "world-gpu-scene-readback") {
      result.native.worldProof = validateWorldGpuReadbackOutput(combined);
      if (result.native.worldProof.errors.length > 0) {
        result.status = "fail";
        return;
      }
    }
    if (test.windowedSurface !== undefined) {
      const surface = validateWindowedSurfaceOutput(combined, test.windowedSurface);
      result.native.windowedSurface = surface;
      if (surface.errors.length > 0) {
        result.status = "fail";
        return;
      }
    }
    if (
      !result.native.completed ||
      /TypeError|ReferenceError|SyntaxError/iu.test(combined) ||
      gpuErrors.length > 0
    ) {
      result.status = "fail";
      return;
    }
    const inspection = inspectCapture(readFileSync(screenshot));
    result.native.uniform = inspection.uniform;
  } catch (error) {
    result.status = "fail";
    result.native = {
      completed: false,
      ...(result.native || {}),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}

export function runCommand(command, args, options = {}) {
  const proc = spawnSync(command, args, {
    cwd: options.cwd || runtimeRoot,
    env: options.env || process.env,
    encoding: options.binary ? null : "utf8",
    timeout: options.timeout || 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  // `allowFailure` has to cover a spawn error too, not only a non-zero exit. A cleanup command —
  // the display-size restore, a stray `rm` — is marked allowFailure precisely because the caller
  // has decided its failure is not fatal, and then `spawnSync adb ETIMEDOUT` was thrown straight
  // past that decision. It killed an Android run whose conformance work had already finished at
  // 74 passed, 0 failed: an emulator too loaded to answer a teardown command in time discarded the
  // result it had just produced. The error is surfaced on the returned object so a caller that
  // cares can still read it.
  if (proc.error) {
    if (!options.allowFailure) throw proc.error;
    return { ...proc, status: proc.status ?? 1, timedOut: true };
  }
  if (proc.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${proc.status}): ${proc.stderr || proc.stdout || ""}`,
    );
  }
  return proc;
}

function androidArgs(serial, ...args) {
  return ["-s", serial, ...args];
}

// A device-settings restore after a row. The emulator's adbd drops for a moment under load
// ("adb: device offline") and that failed rows that had already rendered and compared, on a
// different row each run. Wait for the device once and retry; one that stays gone still fails.
function restoreOnDevice(adb, serial, ...shellArgs) {
  const run = () =>
    runCommand(adb, androidArgs(serial, "shell", ...shellArgs), { allowFailure: true, timeout: 10_000 });
  const first = run();
  if (first.status === 0) return first;
  runCommand(adb, androidArgs(serial, "wait-for-device"), { allowFailure: true, timeout: 30_000 });
  return run();
}

function writeAndroidRemoteFile(adb, serial, remotePath, contents) {
  const directory = mkdtempSync(join(tmpdir(), "threenative-conformance-android-file-"));
  const localPath = join(directory, "payload");
  const incomingPath = `${remotePath}.incoming-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(localPath, contents, "utf8");
    runCommand(adb, androidArgs(serial, "push", localPath, incomingPath), { timeout: 30_000 });
    runCommand(adb, androidArgs(serial, "shell", "mv", incomingPath, remotePath), {
      timeout: 30_000,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
    runCommand(adb, androidArgs(serial, "shell", "rm", "-f", incomingPath), {
      allowFailure: true,
      timeout: 10_000,
    });
  }
}

async function waitForAndroidRemoteFile(adb, serial, remotePath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const probe = runCommand(adb, androidArgs(serial, "shell", "test", "-s", remotePath), {
      allowFailure: true,
      timeout: 10_000,
    });
    if (probe.status === 0) return;
    await wait(25);
  }
  throw new Error(`Android screenshot capture timed out: ${remotePath}`);
}

function readAndroidRemoteBinary(adb, serial, remotePath) {
  return runCommand(adb, androidArgs(serial, "exec-out", "cat", remotePath), {
    binary: true,
    timeout: 30_000,
  }).stdout;
}

function androidPid(adb, serial) {
  const result = runCommand(adb, androidArgs(serial, "shell", "pidof", APP_ID), {
    allowFailure: true,
    timeout: 10_000,
  });
  return result.status === 0
    ? String(result.stdout).trim().split(/\s+/u).find(Boolean) || null
    : null;
}

/**
 * A death before the marker used to be reported bare, and a bare message is what made
 * `25-camera-parented-overlay` opaque for a week (PRD-166): the row died natively mid-scene and
 * its last logged act — which scene stage it reached — never reached the report. Append the tail
 * of the app's own filtered log so the recorded failure names where the process was when it
 * went. Bounded: this rides inside an error message.
 */
const HARDWARE_ADAPTER_PREFIX = "TN_CONFORMANCE_HARDWARE_ADAPTER_REQUIRED:";
const SOFTWARE_ADAPTER_PATTERN = /cpu|fallback|llvmpipe|software|swiftshader/iu;

export function isSoftwareAdapter(adapterText) {
  return SOFTWARE_ADAPTER_PATTERN.test(String(adapterText ?? ""));
}

/**
 * A row that refused to start because this machine exposes a software adapter was never executed,
 * so it is blocked like a missing Xvfb or Chromium rather than failed. Reporting it as a failure
 * claims the effect was measured and came out wrong, which no run on SwiftShader is able to know.
 * Returns the blocked reason, or null when the error is a genuine failure.
 */
export function hardwareAdapterBlocker(message) {
  if (typeof message !== "string" || !message.startsWith(HARDWARE_ADAPTER_PREFIX)) return null;
  return `Requires a hardware GPU adapter; this machine reported ${message.slice(HARDWARE_ADAPTER_PREFIX.length)}.`;
}

export function androidDeathExcerpt(message, appLog) {
  // Prefer the app's own TN_* diagnostic lines: after a native death the filtered log's last
  // lines are Window Manager chatter that merely names the app, and a raw tail slice lets that
  // chatter crowd out the scene trace saying which stage the process reached (PRD-166 phase 3).
  const diagnostics = String(appLog || "")
    .split(/\r?\n/u)
    .filter((line) => /\bTN_[A-Z0-9_]+:/.test(line));
  const tail = diagnostics
    .slice(-3)
    .join(" | ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(-400);
  return tail.length > 0 ? `${message} Last app output: ${tail}` : message;
}

export function androidLog(adb, serial) {
  const read = () =>
    runCommand(adb, androidArgs(serial, "logcat", "-d", "-v", "threadtime"), {
      allowFailure: true,
      timeout: 15_000,
    });
  const first = read();
  if (first.status === 0) return String(first.stdout || "");

  // Android emulator adbd can briefly reject `logcat -d` under render/capture load, returning 255
  // with no stderr. Treat that like the restore path's transient offline case: wait once and retry
  // so a rendered row is not failed solely because diagnostics were momentarily unavailable.
  runCommand(adb, androidArgs(serial, "wait-for-device"), { allowFailure: true, timeout: 30_000 });
  const second = read();
  if (second.status === 0) return String(second.stdout || "");

  throw new Error(
    `${adb} ${androidArgs(serial, "logcat", "-d", "-v", "threadtime").join(" ")} failed (${second.status}): ${second.stderr || second.stdout || first.stderr || first.stdout || ""}`,
  );
}

export function readAndroidThermalObservation(adb, serial) {
  const output = String(
    runCommand(adb, androidArgs(serial, "shell", "dumpsys", "thermalservice"), {
      timeout: 15_000,
    }).stdout || "",
  );
  const status = Number.parseInt(/Thermal Status:\s*(\d+)/iu.exec(output)?.[1] ?? "", 10);
  if (!Number.isInteger(status)) {
    throw new Error("TN_ANDROID_THERMAL_UNOBSERVABLE: dumpsys thermalservice did not report Thermal Status.");
  }
  if (status !== 0) {
    throw new Error(`TN_ANDROID_THERMALLY_CONFOUNDED: thermal status ${status} was observed before capture.`);
  }
  return { notThermallyConfounded: true, thermalStatus: status };
}

export function androidSystemDialog(windowDump) {
  const match = String(windowDump).match(
    /(?:Application Not Responding|Application Error):\s*[^\r\n}]+/u,
  );
  return match?.[0]?.trim() || null;
}

/**
 * The window that currently owns focus, which is not the same question as which app is running.
 *
 * `androidSystemDialog` above matches two strings — "Application Not Responding" and "Application
 * Error" — and every other system window is invisible to it. On 2026-08-17 a physical Pixel 8 sat
 * behind Android's *"…app which is currently being tested"* prompt, raised by installing a debug
 * APK with `adb install -t`, and a notification shade above that. The lane captured the home
 * screen 67 times, compared it against the browser reference, and reported 67 rows of
 * `pixelMismatchRatio: 1.000` — every pixel different, on every scene, which is what a screenshot
 * of the wrong surface looks like and not what a renderer regression looks like.
 *
 * Enumerating dialog titles cannot work: the next one will have a title nobody listed. Asserting
 * the *positive* condition does — the focused window must belong to this app, and anything else
 * fails closed and names what had focus instead.
 */
export function androidFocusedWindowOwner(windowDump) {
  return /^\s*mCurrentFocus=Window\{[^}]*?\s(\S+)\}/mu.exec(String(windowDump))?.[1] || null;
}

/**
 * The dump the focus question is answerable from.
 *
 * `dumpsys window windows` prints one block per window and, on Android 15 (API 35), no
 * `mCurrentFocus` at all — the field moved out of that subcommand. A guard reading it can only
 * ever fail closed, which on 2026-08-19 turned 66 conformance rows into `TN_ANDROID_FOCUS_UNKNOWN`
 * before a single pixel was compared. The full `dumpsys window` dump still carries the field on
 * every level this lane targets, so that is what the guard is fed. Failing closed on a dump the
 * field was never in is a lane that reports on its own question, not on the renderer.
 */
export function androidWindowDump(common) {
  return String(common("shell", "dumpsys", "window").stdout || "");
}

export function androidForegroundBlocker(windowDump, appId = APP_ID) {
  const dialog = androidSystemDialog(windowDump);
  if (dialog) return `TN_ANDROID_SYSTEM_DIALOG: ${dialog}`;
  const focused = androidFocusedWindowOwner(windowDump);
  if (focused === null) return "TN_ANDROID_FOCUS_UNKNOWN: no mCurrentFocus in the window dump.";
  if (!focused.startsWith(appId))
    return `TN_ANDROID_FOREGROUND_WINDOW: '${focused}' owns focus, not ${appId}; a capture now photographs that window, not the scene.`;
  return null;
}

export function launchAndroidConformanceActivity(common, serial, extras = []) {
  prepareAndroidEmulator(serial, common);
  return common("shell", "am", "start", "-W", "-n", ACTIVITY, ...extras);
}

/** The landscape size the Android lane pins so its captures compare against the web reference. */
export const ANDROID_CAPTURE_SIZE = "1280x720";

export function androidDisplaySize(sizeDump) {
  const dump = String(sizeDump);
  return /^Override size:\s*(\d+x\d+)$/mu.exec(dump)?.[1] ||
    /^Physical size:\s*(\d+x\d+)$/mu.exec(dump)?.[1] ||
    null;
}

async function waitForAndroidDisplaySize(common, expected) {
  const deadline = Date.now() + Number(process.env.TN_ANDROID_ROTATION_TIMEOUT_MS || 15_000);
  let observed = null;
  while (Date.now() <= deadline) {
    observed = androidDisplaySize(common("shell", "wm", "size").stdout);
    if (observed === expected) return;
    await wait(250);
  }
  throw new Error(
    `TN_ANDROID_DISPLAY_ORIENTATION: display reported ${observed ?? "no size"} instead of ${expected} before capture.`,
  );
}

async function waitForAndroidLogMarker(adb, serial, pid, marker, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let appLog = "";
  while (Date.now() <= deadline) {
    appLog = filterAppLog(androidLog(adb, serial), pid);
    const analysis = analyzeAppLog(appLog);
    if (analysis.failures.length > 0) throw new Error(analysis.failures[0].excerpt);
    if (appLog.includes(marker)) return appLog;
    if (pid && !androidPid(adb, serial))
      throw new Error(androidDeathExcerpt(`Android process exited before ${marker}.`, appLog));
    await wait(25);
  }
  throw new Error(`Android timed out waiting for ${marker}.`);
}

/**
 * Decide what a row must restore the display to, given what it observed before overriding.
 *
 * **An observed override equal to this lane's own capture size is not the operator's setting — it
 * is this lane's leak from an earlier run, and echoing it back makes the leak permanent.** That is
 * what happened on 2026-08-17: a run left `Override size: 1280x720` on a physical Pixel 8, every
 * subsequent row read it as the pre-existing state, "restored" it faithfully, and reported success
 * while the operator's phone stayed squeezed into a 1280x720 letterbox on a 1080x2400 panel. No
 * restore ever failed; each one was told the wrong target.
 *
 * A genuine operator override that happens to equal the capture size is indistinguishable from the
 * leak, and gets reset. That is the right way round: resetting a deliberate override costs one
 * command to redo, and perpetuating a leaked one silently mangles a physical device.
 */
export function androidDisplayRestoreTarget(sizeDump, captureSize = ANDROID_CAPTURE_SIZE) {
  const override = /^Override size:\s*(\d+x\d+)$/mu.exec(String(sizeDump))?.[1];
  return override === undefined || override === captureSize ? "reset" : override;
}

/** What this lane forces rotation to while it captures: locked, in the panel's natural frame. */
export const ANDROID_CAPTURE_ROTATION = { accelerometer_rotation: "0", user_rotation: "0" };

/** Auto-rotate on, no manual rotation — the state a Pixel ships in. */
export const ANDROID_ROTATION_DEFAULT = { accelerometer_rotation: "1", user_rotation: "0" };

/**
 * Decide what a row must restore rotation to, given what it observed before locking the display.
 *
 * The size override had a restore path and an exit guard; rotation had neither, so
 * `accelerometer_rotation 0` and `user_rotation 0` were written once and left there. On 2026-09-05
 * that reached a physical Pixel 8: auto-rotate off and rotation pinned, so the phone stayed in
 * landscape long after the run ended, and nothing in the lane ever claimed to put it back.
 *
 * The same leak rule as `androidDisplayRestoreTarget` applies, for the same reason. Observing this
 * lane's own locked pair is indistinguishable from an operator who deliberately locked their phone
 * to its natural orientation, so it resets to auto-rotate rather than echoing the lock back. An
 * operator's lock costs one quick-settings tap to redo; a perpetuated one silently leaves a device
 * somebody is holding stuck in landscape.
 */
export function androidRotationRestoreTarget(accelerometerDump, userDump) {
  const read = (dump) => {
    const value = String(dump ?? "").trim();
    return /^[0-3]$/u.test(value) ? value : null;
  };
  const accelerometer = read(accelerometerDump);
  const user = read(userDump);
  if (accelerometer === null || user === null) return { ...ANDROID_ROTATION_DEFAULT };
  if (
    accelerometer === ANDROID_CAPTURE_ROTATION.accelerometer_rotation &&
    user === ANDROID_CAPTURE_ROTATION.user_rotation
  )
    return { ...ANDROID_ROTATION_DEFAULT };
  return { accelerometer_rotation: accelerometer, user_rotation: user };
}

/**
 * Reset the display on the way out, including the ways that skip every `finally` in this file.
 *
 * A per-row `try/finally` cannot survive `SIGINT`, `SIGTERM`, or a crash, and this lane mutates
 * global state on hardware somebody is holding. The guard is armed once per process, resets size
 * and density, and tolerates its own failure — an exit handler that throws would replace the real
 * exit reason with its own.
 */
let androidDisplayGuardArmed = false;

export function armAndroidDisplayGuard(adb, serial, rotation = ANDROID_ROTATION_DEFAULT) {
  if (androidDisplayGuardArmed) return;
  androidDisplayGuardArmed = true;
  const reset = () => {
    for (const property of ["size", "density"]) {
      try {
        spawnSync(adb, androidArgs(serial, "shell", "wm", property, "reset"), { timeout: 10_000 });
      } catch {
        // An exit path is the wrong place to raise. The next run's own reset is the backstop.
      }
    }
    // Rotation leaks the same way size did, and a signal skips the row's `finally` just as surely.
    for (const [setting, value] of Object.entries(rotation)) {
      try {
        spawnSync(adb, androidArgs(serial, "shell", "settings", "put", "system", setting, value), {
          timeout: 10_000,
        });
      } catch {
        // Same reasoning as above: never raise from an exit path.
      }
    }
  };
  process.once("exit", reset);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      reset();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

function wait(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function verifyApkBundle(apk, bundle, javaHome, extract = runCommand) {
  const temporary = mkdtempSync(join(tmpdir(), "threenative-conformance-apk-"));
  try {
    extract(
      join(javaHome, "bin", process.platform === "win32" ? "jar.exe" : "jar"),
      ["--extract", "--file", apk, "assets/scripts/main.js", "lib"],
      { cwd: temporary },
    );
    const packaged = join(temporary, "assets/scripts/main.js");
    if (!existsSync(packaged)) throw new Error("Android APK is missing assets/scripts/main.js.");
    assertPackagedAndroidBundle(readFileSync(packaged), {
      outputSha256: sha256(readFileSync(bundle)),
    });
    const libraries = join(temporary, "lib");
    return Object.fromEntries(readdirSync(libraries, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => [entry.name, fileSha256(join(libraries, entry.name, "libmystral-runtime.so"))]));

  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function runAndroid(
  test,
  bundlePath,
  result,
  device,
  captureRoot,
  assets,
  requireEmulator = false,
) {
  let tools;
  try {
    tools = discoverTools();
  } catch (error) {
    result.status = "blocked";
    result.blockedReason = `TN_PARITY_ANDROID_TOOLS_BLOCKED: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  let devices;
  try {
    devices = parseAdbDevices(String(runCommand(tools.adb, ["devices", "-l"]).stdout));
  } catch (error) {
    result.status = "blocked";
    result.blockedReason = `TN_PARITY_ANDROID_ADB_BLOCKED: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  let serial;
  try {
    serial = selectDevice(devices, device);
  } catch (error) {
    result.status = "blocked";
    result.blockedReason = `TN_PARITY_ANDROID_DEVICE_BLOCKED: ${error instanceof Error ? error.message : String(error)}`;
    return;
  }
  if (requireEmulator) {
    try {
      assertAndroidEmulator(androidDeviceProperties(tools.adb, serial), serial);
    } catch (error) {
      result.status = "blocked";
      result.blockedReason = error instanceof Error ? error.message : String(error);
      return;
    }
  }
  let deviceMetrics = null;
  if (test.deviceMetrics?.notThermallyConfounded === true) {
    try {
      deviceMetrics = readAndroidThermalObservation(tools.adb, serial);
    } catch (error) {
      result.status = "fail";
      result.native = {
        completed: false,
        phase: "device-metrics",
        error: error instanceof Error ? error.message : String(error),
      };
      return;
    }
  }
  const androidBlockedReason = androidDependencyBlocker();
  if (androidBlockedReason !== null) {
    result.status = "blocked";
    result.blockedReason = androidBlockedReason;
    return;
  }
  const androidDir = join(runtimeRoot, "android");
  stageAndroidAssets(assets);
  const gradlew = process.platform === "win32" ? join(androidDir, "gradlew.bat") : "bash";
  const bundleHash = sha256(readFileSync(bundlePath));
  const gradleEnv = {
    ...process.env,
    JAVA_HOME: tools.javaHome,
    ANDROID_HOME: tools.sdkRoot,
    ANDROID_SDK_ROOT: tools.sdkRoot,
  };
  try {
    const gradleArgs = [
      ...(process.platform === "win32" ? [] : [join(androidDir, "gradlew")]),
      ":app:assembleDebug",
      "--console=plain",
      `-PthreenativeConformanceBundle=${bundlePath}`,
      `-PthreenativeConformanceBundleSha256=${bundleHash}`,
    ];
    runCommand(gradlew, gradleArgs, { cwd: androidDir, env: gradleEnv, timeout: 900_000 });
  } catch (error) {
    result.status = "fail";
    result.native = {
      completed: false,
      phase: "build",
      error: error instanceof Error ? error.message : String(error),
    };
    return;
  }
  const apk = join(androidDir, "app/build/outputs/apk/debug/app-debug.apk");
  let runtimeLibraries;
  try {
    runtimeLibraries = verifyApkBundle(apk, bundlePath, tools.javaHome);
  } catch (error) {
    result.status = "fail";
    result.native = {
      completed: false,
      phase: "apk-bundle-verification",
      error: error instanceof Error ? error.message : String(error),
    };
    return;
  }
  const common = (...args) =>
    runCommand(tools.adb, androidArgs(serial, ...args), { timeout: 120_000 });
  const temporalCaptures =
    test.temporal === undefined ? null : nativeTemporalCapturePaths(test, captureRoot);
  const temporalFinalLabel = test.temporal === undefined ? null : temporalCaptureLabel(test);
  const androidMailboxRoot = `/sdcard/Android/data/${APP_ID}/files`;
  const temporalRemoteCaptures =
    temporalCaptures === null
      ? null
      : Object.fromEntries(
          NATIVE_TEMPORAL_LABELS.map((label) => [
            label,
            `${androidMailboxRoot}/tn-conformance-${test.id}-${label}.png`,
          ]),
        );
  const screenshotRequest = `${androidMailboxRoot}/tn-playtest-screenshot-request.txt`;
  let displayRestore = null;
  let rotationRestore = null;
  let releaseMultitouch = null;
  try {
    runCommand(tools.adb, androidArgs(serial, "uninstall", APP_ID), {
      allowFailure: true,
      timeout: 120_000,
    });
    await wait(2_000);
    const install = common("install", "-r", "-t", apk);
    if (!/Success/iu.test(String(install.stdout)))
      throw new Error(`adb install did not report Success: ${install.stdout}`);
    // Read rotation before touching it. Written after the override, these two values are this
    // lane's own and restoring them is restoring the leak.
    rotationRestore = androidRotationRestoreTarget(
      common("shell", "settings", "get", "system", "accelerometer_rotation").stdout,
      common("shell", "settings", "get", "system", "user_rotation").stdout,
    );
    common("shell", "settings", "put", "system", "accelerometer_rotation", "0");
    // Rotation 0, not 1. `wm size` below defines the *logical* display in the panel's natural
    // frame, and a 90-degree user rotation transposes it: the lane asked for 1280x720, set
    // rotation 1, and got a 720x1280 logical frame and a 720x1280 capture, then reported
    // "the display was still rotating" — a settle problem that was never a settle problem.
    // Measured on a 2560x1600 panel: rotation 1 gives logicalFrame 0,0-720,1280 and a 720x1280
    // screencap; rotation 0 gives logicalFrame 0,0-1280,720 and a 1280x720 screencap. The
    // override alone is what makes the display landscape, so the rotation only fought it.
    common("shell", "settings", "put", "system", "user_rotation", "0");
    const originalSize = String(common("shell", "wm", "size").stdout || "");
    displayRestore = androidDisplayRestoreTarget(originalSize);
    armAndroidDisplayGuard(tools.adb, serial, rotationRestore);
    common("shell", "wm", "size", ANDROID_CAPTURE_SIZE);
    common("shell", "am", "force-stop", APP_ID);
    common("logcat", "-c");
    if (temporalRemoteCaptures !== null) {
      common("shell", "mkdir", "-p", androidMailboxRoot);
      common(
        "shell",
        "rm",
        "-f",
        screenshotRequest,
        ...Object.values(temporalRemoteCaptures),
      );
      writeAndroidRemoteFile(
        tools.adb,
        serial,
        screenshotRequest,
        temporalRemoteCaptures["frame-zero"],
      );
    }
    const launch = launchAndroidConformanceActivity(
      common,
      serial,
      temporalRemoteCaptures === null
        ? []
        : ["--es", "TN_PLAYTEST_MAILBOX_ROOT", androidMailboxRoot],
    );
    if (!/Status:\s*ok/iu.test(String(launch.stdout)))
      throw new Error(`Android activity failed to start: ${launch.stdout}`);
    const marker = `TN_CONFORMANCE_READY:${test.id}`;
    const timeoutAt = Date.now() + Number(process.env.TN_ANDROID_TIMEOUT_MS || 45_000);
    let pid = null;
    let appLog = "";
    while (Date.now() <= timeoutAt) {
      pid ||= androidPid(tools.adb, serial);
      appLog = filterAppLog(androidLog(tools.adb, serial), pid);
      const analysis = analyzeAppLog(appLog);
      if (analysis.failures.length > 0) throw new Error(analysis.failures[0].excerpt);
      if (appLog.includes(marker)) break;
      if (pid && !androidPid(tools.adb, serial))
        throw new Error(androidDeathExcerpt("Android process exited before the conformance marker.", appLog));
      await wait(test.temporal === undefined ? 500 : 25);
    }
    if (!appLog.includes(marker)) throw new Error(`Android timed out waiting for ${marker}.`);
    if (test.inputProof === "multitouch") {
      const touchDevice = parseAndroidTouchDevice(
        String(common("shell", "getevent", "-lp").stdout || ""),
        process.env.THREENATIVE_TOUCH_DEVICE,
      );
      const touchViewport = parseAndroidTouchViewport(
        String(common("shell", "dumpsys", "input").stdout || ""),
      );
      const releaseScript = androidMultitouchScript(
        touchDevice,
        MULTITOUCH_PROOF_POINTS,
        false,
        touchViewport,
      );
      // `adb shell` joins its arguments with spaces, so a script handed to `sh -c` loses its
      // grouping and the shell swallows the first line as the command. Pass the script as the
      // remote command line instead, which keeps `set -e` in force.
      common(
        "shell",
        androidMultitouchScript(touchDevice, MULTITOUCH_PROOF_POINTS, true, touchViewport),
      );
      releaseMultitouch = () => common("shell", releaseScript);
      const proofMarker = `TN_MULTITOUCH_PROOF_PASS:${test.id}`;
      const proofTimeoutAt = Date.now() + Number(process.env.TN_ANDROID_TIMEOUT_MS || 45_000);
      while (Date.now() <= proofTimeoutAt) {
        appLog = filterAppLog(androidLog(tools.adb, serial), pid);
        const analysis = analyzeAppLog(appLog);
        if (analysis.failures.length > 0) throw new Error(analysis.failures[0].excerpt);
        if (appLog.includes(proofMarker)) break;
        if (pid && !androidPid(tools.adb, serial))
          throw new Error("Android process exited before the multitouch proof marker.");
        await wait(100);
      }
      if (!appLog.includes(proofMarker)) throw new Error(`Android timed out waiting for ${proofMarker}.`);
      await releaseMultitouch();
      releaseMultitouch = null;
    }
    if (!/ThreeNativeWGPU/u.test(appLog)) {
      throw new Error(
        "Android WebGPU log channel was silent; expected a ThreeNativeWGPU startup line.",
      );
    }
    if (!pid || !androidPid(tools.adb, serial))
      throw new Error("Android process died after its conformance marker.");
    if (temporalCaptures !== null && temporalRemoteCaptures !== null) {
      const temporalTimeoutMs = Number(process.env.TN_ANDROID_TIMEOUT_MS || 45_000);
      const captureRemote = async (label) => {
        const remotePath = temporalRemoteCaptures[label];
        const localPath = temporalCaptures[label];
        await waitForAndroidRemoteFile(tools.adb, serial, remotePath, temporalTimeoutMs);
        const png = readAndroidRemoteBinary(tools.adb, serial, remotePath);
        inspectScreenshot(png);
        const capture = inspectCapture(png, { allowUniform: label !== temporalFinalLabel });
        if (`${capture.width}x${capture.height}` !== ANDROID_CAPTURE_SIZE) {
          throw new Error(
            `TN_ANDROID_DISPLAY_ORIENTATION: captured ${capture.width}x${capture.height} but the lane requires ${ANDROID_CAPTURE_SIZE}; the display was still rotating.`,
          );
        }
        writeFileSync(localPath, png);
        runCommand(tools.adb, androidArgs(serial, "shell", "rm", "-f", remotePath), {
          allowFailure: true,
          timeout: 10_000,
        });
        return capture;
      };
      await captureRemote("frame-zero");
      appLog = await waitForAndroidLogMarker(
        tools.adb,
        serial,
        pid,
        nativeTemporalMarker(test, "settled"),
        temporalTimeoutMs,
      );
      writeAndroidRemoteFile(
        tools.adb,
        serial,
        screenshotRequest,
        temporalRemoteCaptures.settled,
      );
      await captureRemote("settled");
      appLog = await waitForAndroidLogMarker(
        tools.adb,
        serial,
        pid,
        nativeTemporalMarker(test, "next"),
        temporalTimeoutMs,
      );
      writeAndroidRemoteFile(
        tools.adb,
        serial,
        screenshotRequest,
        temporalRemoteCaptures.next,
      );
      await captureRemote("next");
      const temporal = validateNativeTemporalCaptures(test, temporalCaptures);
      const analysis = analyzeAppLog(appLog);
      if (analysis.failures.length > 0) throw new Error(analysis.failures[0].excerpt);
      const gpuErrors = validationErrors(appLog);
      result.gpuValidationErrors.push(...gpuErrors);
      await waitForAndroidDisplaySize(common, ANDROID_CAPTURE_SIZE);
      const beforeCaptureBlocker = androidForegroundBlocker(androidWindowDump(common));
      if (beforeCaptureBlocker) throw new Error(beforeCaptureBlocker);
      const afterCaptureBlocker = androidForegroundBlocker(androidWindowDump(common));
      if (afterCaptureBlocker) throw new Error(afterCaptureBlocker);
      const finalCapture = temporal.inspections[temporalFinalLabel];
      result.native = {
        completed: true,
        screenshot: temporalCaptures[temporalFinalLabel],
        uniform: finalCapture.uniform,
        width: finalCapture.width,
        height: finalCapture.height,
        device: serial,
        pid,
        bundleSha256: bundleHash,
        apkBundleVerified: true,
        runtimeLibraries,
        freshInstall: true,
        webgpuLogChannel: true,
        ...(deviceMetrics === null ? {} : { deviceMetrics }),
        temporal: {
          captures: temporalCaptures,
          hashes: temporal.hashes,
          observation: {
            frameZeroRendered: true,
            nextFrameRendered: true,
            settledFrameRendered: true,
          },
        },
        log: appLog.slice(-4000),
      };
      if (gpuErrors.length > 0) result.status = "fail";
    } else {
      const settleMs = Number(process.env.TN_ANDROID_SETTLE_MS || 3_000);
      await wait(settleMs);
      appLog = filterAppLog(androidLog(tools.adb, serial), pid);
      const analysis = analyzeAppLog(appLog);
      if (analysis.failures.length > 0) throw new Error(analysis.failures[0].excerpt);
      if (!androidPid(tools.adb, serial))
        throw new Error(`Android process died during the ${settleMs} ms settle window.`);
      const beforeCaptureBlocker = androidForegroundBlocker(androidWindowDump(common));
      if (beforeCaptureBlocker) {
        throw new Error(beforeCaptureBlocker);
      }
      // The activity requests its own orientation as it starts, so the display can still be
      // rotating when the settle window ends. Capturing then yields a 720x1280 frame that is
      // reported as a pixel mismatch against the 1280x720 reference — a red row that names the
      // wrong cause. Wait for the override to read back, and name it if it never does.
      await waitForAndroidDisplaySize(common, ANDROID_CAPTURE_SIZE);
      const png = runCommand(tools.adb, androidArgs(serial, "exec-out", "screencap", "-p"), {
        binary: true,
        timeout: 30_000,
      }).stdout;
      inspectScreenshot(png);
      // Observe the capture instead of asserting it. A hard-coded `uniform: false` reports a
      // blank device frame as a pass, which is the fail-open this lane exists to prevent.
      const capture = inspectCapture(png);
      if (`${capture.width}x${capture.height}` !== ANDROID_CAPTURE_SIZE) {
        throw new Error(
          `TN_ANDROID_DISPLAY_ORIENTATION: captured ${capture.width}x${capture.height} but the lane requires ${ANDROID_CAPTURE_SIZE}; the display was still rotating.`,
        );
      }
      const afterCaptureBlocker = androidForegroundBlocker(androidWindowDump(common));
      if (afterCaptureBlocker) {
        throw new Error(afterCaptureBlocker);
      }
      const screenshot = join(captureRoot, `${test.id}.png`);
      writeFileSync(screenshot, png);
      if (!androidPid(tools.adb, serial))
        throw new Error("Android process died after screenshot capture.");
      result.native = {
        completed: true,
        screenshot,
        uniform: capture.uniform,
        width: capture.width,
        height: capture.height,
        device: serial,
        pid,
        bundleSha256: bundleHash,
        apkBundleVerified: true,
        runtimeLibraries,
        freshInstall: true,
        webgpuLogChannel: true,
        settleMs,
        ...(deviceMetrics === null ? {} : { deviceMetrics }),
        log: appLog.slice(-4000),
      };
    }
  } catch (error) {
    result.status = "fail";
    result.native = {
      completed: false,
      ...(result.native || {}),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (releaseMultitouch !== null) {
      try {
        releaseMultitouch();
      } catch (error) {
        result.status = "fail";
        result.native = {
          completed: false,
          ...(result.native || {}),
          error: `Android multitouch release failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      releaseMultitouch = null;
    }
    if (temporalRemoteCaptures !== null) {
      runCommand(
        tools.adb,
        androidArgs(
          serial,
          "shell",
          "rm",
          "-f",
          screenshotRequest,
          ...Object.values(temporalRemoteCaptures),
        ),
        { allowFailure: true, timeout: 10_000 },
      );
    }
    if (displayRestore !== null) {
      const restored = restoreOnDevice(tools.adb, serial, "wm", "size", displayRestore);
      if (restored.status !== 0) {
        result.status = "fail";
        result.native = {
          completed: false,
          ...(result.native || {}),
          error: `Android display-size restore failed: ${restored.stderr || restored.stdout || "unknown error"}`,
        };
      }
      // Read it back. A restore that reports success and leaves the panel overridden is exactly
      // the failure that reached a physical device on 2026-08-17, and it reported success every
      // time. Exit status is what the command claims; this is what the device is.
      const readBack = runCommand(tools.adb, androidArgs(serial, "shell", "wm", "size"), {
        allowFailure: true,
        timeout: 10_000,
      });
      const leaked = /^Override size:\s*(\d+x\d+)$/mu.exec(String(readBack.stdout || ""))?.[1];
      if (leaked === ANDROID_CAPTURE_SIZE) {
        result.status = "fail";
        result.native = {
          completed: false,
          ...(result.native || {}),
          error: `TN_ANDROID_DISPLAY_LEAKED: the display is still overridden to ${leaked} after restore; the device was left mutated.`,
        };
      }
      displayRestore = null;
    }
    if (rotationRestore !== null) {
      for (const [setting, value] of Object.entries(rotationRestore)) {
        const restored = restoreOnDevice(tools.adb, serial, "settings", "put", "system", setting, value);
        if (restored.status !== 0) {
          result.status = "fail";
          result.native = {
            completed: false,
            ...(result.native || {}),
            error: `Android ${setting} restore failed: ${restored.stderr || restored.stdout || "unknown error"}`,
          };
          continue;
        }
        // Read back, for the reason the size restore reads back: exit status is what the command
        // claims, and a lane that leaves auto-rotate off strands the device in landscape.
        const readBack = runCommand(
          tools.adb,
          androidArgs(serial, "shell", "settings", "get", "system", setting),
          { allowFailure: true, timeout: 10_000 },
        );
        if (String(readBack.stdout || "").trim() !== value) {
          result.status = "fail";
          result.native = {
            completed: false,
            ...(result.native || {}),
            error: `TN_ANDROID_ROTATION_LEAKED: ${setting} is ${String(readBack.stdout || "").trim() || "unreadable"} after restore, not ${value}; the device was left mutated.`,
          };
        }
      }
      rotationRestore = null;
    }
  }
}

export function androidDependencyBlocker(root = runtimeRoot) {
  const sourceRoot = join(root, "third_party", "sdl3-android");
  const sdl3Aar = `SDL3-${SDL3_ANDROID_VERSION}.aar`;
  const sourceAar = join(sourceRoot, sdl3Aar);
  const prebuiltRoot = join(root, "android", "prebuilt");
  const prebuiltFiles = [
    join(prebuiltRoot, sdl3Aar),
    join(prebuiltRoot, "jniLibs", "arm64-v8a", "libSDL3.so"),
    join(prebuiltRoot, "jniLibs", "arm64-v8a", "libmystral-runtime.so"),
    join(prebuiltRoot, "jniLibs", "x86_64", "libSDL3.so"),
    join(prebuiltRoot, "jniLibs", "x86_64", "libmystral-runtime.so"),
  ];
  const sourceComplete = existsSync(sourceAar);
  const prebuiltMissing = prebuiltFiles.filter((file) => !existsSync(file));
  const prebuiltComplete = prebuiltMissing.length === 0;
  const prebuiltPresent = prebuiltMissing.length < prebuiltFiles.length;
  if (!prebuiltComplete && (!sourceComplete || prebuiltPresent)) {
    return (
      `TN_PARITY_ANDROID_DEPS_BLOCKED: checked source and packaged Android dependency layouts. source (${sourceRoot}): ${sourceAar} ${sourceComplete ? "exists" : "does not exist"}; packaged (${prebuiltRoot}): missing ${prebuiltMissing.join(", ")}. Run "pnpm native:build" to download the Android third-party dependencies.`
    );
  }
  return null;
}

const RUNTIME_ENV_KEYS = Object.freeze([
  "THREENATIVE_RUNTIME_BINARY",
  "TN_RUNTIME",
  "MYSTRAL_BIN",
]);

export function configuredRuntime(env = process.env) {
  return RUNTIME_ENV_KEYS.map((key) => env[key]).find(Boolean) || null;
}

export function defaultDesktopRuntimePath(platform = process.platform) {
  const preset =
    platform === "darwin" ? "tn-macos" : platform === "win32" ? "tn-windows" : "tn-linux";
  const executable = platform === "win32" ? "mystral.exe" : "mystral";
  return join(runtimeRoot, "build", preset, executable);
}

/**
 * The one-command parity path provisions what the repository already declares — the pinned
 * `third_party` downloads and the CMake build — before it decides a desktop row failed.
 * A host that cannot run those steps reports every affected row as `blocked` with the exact
 * command output, never as an assertion failure.
 */
export function desktopRuntimeBuildCommands() {
  return [
    { command: process.execPath, args: [join(runtimeRoot, "scripts/download-deps.mjs")] },
    { command: process.execPath, args: [join(runtimeRoot, "scripts/native-build.mjs")] },
  ];
}

export function prepareDesktopRuntime(runtime, options = {}) {
  const env = options.env || process.env;
  const exists = options.exists || existsSync;
  if (runtime && exists(runtime)) return { runtime, blockedReason: null };
  if (configuredRuntime(env)) {
    return {
      runtime: null,
      blockedReason:
        "TN_PARITY_DESKTOP_RUNTIME_MISSING: the configured " +
        "THREENATIVE_RUNTIME_BINARY/TN_RUNTIME/MYSTRAL_BIN path does not exist.",
    };
  }
  const run = options.run || runCommand;
  try {
    for (const { command, args } of desktopRuntimeBuildCommands()) {
      run(command, args, { cwd: runtimeRoot, timeout: 1_800_000 });
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      runtime: null,
      blockedReason: `TN_PARITY_DESKTOP_RUNTIME_BUILD_BLOCKED: automatic native provisioning failed: ${detail}`,
    };
  }
  if (!exists(runtime)) {
    return {
      runtime: null,
      blockedReason:
        "TN_PARITY_DESKTOP_RUNTIME_BUILD_BLOCKED: automatic native provisioning completed " +
        "without producing the expected runtime binary.",
    };
  }
  return { runtime, blockedReason: null };
}

export function androidDeviceKind(properties) {
  return /^1$/mu.test(properties.qemu || "") ||
    /^(goldfish|ranchu)$/mu.test(properties.hardware || "")
    ? "emulator"
    : "physical";
}

export function assertAndroidEmulator(properties, serial = "the selected device") {
  const kind = androidDeviceKind(properties);
  if (kind !== "emulator") {
    throw new Error(
      `TN_PARITY_ANDROID_EMULATOR_REQUIRED: ${serial} identifies as physical hardware, but --target android runs the emulator lane. Use --target android-hardware instead.`,
    );
  }
  return kind;
}

/**
 * `--target android` must not silently depend on an emulator someone else started. When no
 * emulator is attached this boots the requested AVD; when the SDK cannot supply one the
 * caller gets a blocked precondition string, never a failed row.
 */
export function androidEmulatorBlocker(devices, avdNames, requested) {
  if (devices.length > 0) return null;
  if (requested && !avdNames.includes(requested)) {
    return (
      `TN_PARITY_ANDROID_AVD_MISSING: no emulator is attached and the requested AVD '${requested}' ` +
      `is not installed. Installed AVDs: ${avdNames.length > 0 ? avdNames.join(", ") : "none"}.`
    );
  }
  if (avdNames.length === 0) {
    return (
      "TN_PARITY_ANDROID_AVD_MISSING: no emulator is attached and the Android SDK has no AVD to " +
      "boot. Create one with avdmanager, or pass --device SERIAL for an already-running emulator."
    );
  }
  return null;
}

function androidDeviceProperties(adb, serial) {
  const getprop = (name) =>
    String(
      runCommand(adb, androidArgs(serial, "shell", "getprop", name), { timeout: 10_000 }).stdout ||
        "",
    ).trim();
  return { qemu: getprop("ro.kernel.qemu"), hardware: getprop("ro.hardware") };
}

function installedAvdNames(sdkRoot) {
  const binary = join(
    sdkRoot,
    "emulator",
    process.platform === "win32" ? "emulator.exe" : "emulator",
  );
  if (!existsSync(binary)) return [];
  try {
    return String(runCommand(binary, ["-list-avds"], { timeout: 30_000 }).stdout || "")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function emulatorPreconditionBlocker(device) {
  let tools;
  try {
    tools = discoverTools();
  } catch (error) {
    return `TN_PARITY_ANDROID_TOOLS_BLOCKED: ${error instanceof Error ? error.message : String(error)}`;
  }
  let devices;
  try {
    devices = parseAdbDevices(String(runCommand(tools.adb, ["devices", "-l"]).stdout));
  } catch (error) {
    return `TN_PARITY_ANDROID_ADB_BLOCKED: ${error instanceof Error ? error.message : String(error)}`;
  }
  return androidEmulatorBlocker(devices, installedAvdNames(tools.sdkRoot), device);
}

function physicalAndroidBlocker(device) {
  if (!device) {
    return "TN_PARITY_PHYSICAL_DEVICE_REQUIRED: pass --device SERIAL for an attached physical Android device.";
  }
  try {
    const tools = discoverTools();
    const devices = parseAdbDevices(String(runCommand(tools.adb, ["devices", "-l"]).stdout));
    const serial = selectDevice(devices, device);
    if (androidDeviceKind(androidDeviceProperties(tools.adb, serial)) === "emulator") {
      return `TN_PARITY_PHYSICAL_DEVICE_REQUIRED: ${serial} identifies as an emulator, not physical hardware.`;
    }
    return null;
  } catch (error) {
    return `TN_PARITY_PHYSICAL_DEVICE_BLOCKED: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function createReport(registry, mode, target, runtime, project, provenance) {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    registrySchemaVersion: registry.schemaVersion,
    generatedAt: new Date().toISOString(),
    threeVersion: registry.threeVersion,
    mode,
    target,
    project: project ? { root: project.root, nativeEntry: project.nativeEntry } : null,
    provenance,
    host: {
      platform: process.platform,
      arch: process.arch,
      browser: mode === "execution" && target === "web" ? "chromium-webgpu" : null,
      runtime: mode === "execution" && target === "desktop" ? runtime || null : null,
    },
    summary: { pass: 0, fail: 0, blocked: 0, planned: 0, validated: 0 },
    results: [],
  };
}

function createResult(test) {
  return {
    id: test.id,
    ...(test.realismEffect === undefined ? {} : { realismEffect: test.realismEffect }),
    scene: test.scene,
    status: "blocked",
    tolerance: test.tolerance,
    browser: null,
    native: null,
    metrics: { pixelMismatchRatio: null, perceptualDeltaE: null },
    gpuValidationErrors: [],
  };
}

function iosConformanceBlocker() {
  if (process.platform !== "darwin") {
    return "TN_PARITY_IOS_SKIPPED_WITH_REASON: iOS conformance requires macOS with Xcode and a booted simulator or signed device; this lane did not execute.";
  }
  const probe = spawnSync("xcrun", ["simctl", "list", "devices", "available", "--json"], {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (probe.error || probe.status !== 0) {
    return `TN_PARITY_IOS_SKIPPED_WITH_REASON: xcrun simctl is unavailable (${probe.error?.message ?? probe.stderr ?? "no simulator inventory"}); this lane did not execute.`;
  }
  return "TN_PARITY_IOS_SKIPPED_WITH_REASON: the generic registry runner has no signed iOS scene-app adapter yet; run the iOS simulator gate and project playtest lane before recording a pass.";
}

function runIos(test, result) {
  result.status = "blocked";
  result.platformResult = "skipped-with-reason";
  result.blockedReason = iosConformanceBlocker();
}

function outputLayout(outArg, target) {
  const fallback = join(runtimeRoot, `artifacts/conformance/${target}`);
  const absolute = outArg ? (isAbsolute(outArg) ? outArg : resolve(runtimeRoot, outArg)) : fallback;
  if (extname(absolute).toLowerCase() === ".json") {
    return { reportPath: absolute, captureRoot: dirname(absolute) };
  }
  return { reportPath: join(absolute, "report.json"), captureRoot: absolute };
}

export function referenceRootPath(referenceArg) {
  if (!referenceArg) return join(runtimeRoot, "artifacts/conformance/web");
  return isAbsolute(referenceArg) ? referenceArg : resolve(runtimeRoot, referenceArg);
}

function referencePath(referenceArg, id, test) {
  const suffix = test?.temporal === undefined ? "" : `-${temporalCaptureLabel(test)}`;
  return join(referenceRootPath(referenceArg), `${id}${suffix}.png`);
}

export function missingHardwareReferenceBlocker(test, reference, exists = existsSync) {
  if (test?.requiresHardwareAdapter !== true || exists(reference)) return null;
  return `Missing browser reference capture: ${reference}`;
}

/**
 * The owned engine on web is judged against the upstream-three capture of the same row (`--reference`),
 * the same rule the desktop lane applies to its native capture. Without a reference the row only runs.
 */
function applyUpstreamReference(test, result, referenceArg) {
  if (result.status !== "pass" || !referenceArg) return;
  const reference = referencePath(referenceArg, test.id, test);
  if (!existsSync(reference)) {
    result.status = "blocked";
    result.blockedReason = `Missing upstream three reference capture: ${reference}`;
    return;
  }
  result.browser.engine = "threenative";
  result.metrics = compareCaptures(readFileSync(reference), readFileSync(result.browser.screenshot));
  if (
    result.metrics.pixelMismatchRatio > test.tolerance.pixelMismatchRatio ||
    result.metrics.perceptualDeltaE > test.tolerance.perceptualDeltaE
  ) {
    result.status = "fail";
    result.failureReason = "Capture metrics exceeded the registry tolerance.";
  }
}

function applyReferenceAndMetrics(test, result, reference) {
  if (result.status !== "pass") return;
  if (!existsSync(reference)) {
    result.status = "blocked";
    result.blockedReason = `Missing browser reference capture: ${reference}`;
    return;
  }
  try {
    const inspection = inspectCapture(readFileSync(reference));
    result.browser = {
      completed: true,
      screenshot: reference,
      uniform: inspection.uniform,
      width: inspection.width,
      height: inspection.height,
    };
    result.metrics = compareCaptures(
      readFileSync(reference),
      readFileSync(result.native.screenshot),
    );
    if (test.id === "30-screen-space-text") {
      result.glyphRaster = compareScreenSpaceGlyphs(
        readFileSync(reference),
        readFileSync(result.native.screenshot),
      );
    }
    if (
      result.metrics.pixelMismatchRatio > test.tolerance.pixelMismatchRatio ||
      result.metrics.perceptualDeltaE > test.tolerance.perceptualDeltaE
    ) {
      result.status = "fail";
      result.failureReason = "Capture metrics exceeded the registry tolerance.";
    }
  } catch (error) {
    result.status = "fail";
    result.failureReason = error instanceof Error ? error.message : String(error);
  }
}

function writeReport(report, path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
}

/**
 * The one rule that decides a lane's exit code. Exported so a ledger checker recomputes it
 * from a report instead of trusting a number somebody typed into a markdown table.
 */

/**
 * Which blocked rows a lane is allowed to carry. A GitHub-hosted runner exposes SwiftShader, so
 * every `requiresHardwareAdapter` row is unrunnable there — those rows pass on a real adapter and
 * the lane must not claim otherwise in either direction. A row the registry has not implemented is
 * likewise expected. Anything else blocked is a lane defect and is returned for the caller to fail
 * on, so a newly-broken row can never hide inside the allowance.
 */
/**
 * The lane/row pairs a live registry exclusion covers, as `<target>\u0000<row>` keys.
 *
 * Expiry is deliberately not forgiven here. `expiredExclusions` already drives exit 2 for a lapsed
 * entry; tolerating it a second time in this gate would leave the date enforcing nothing, and an
 * exclusion nobody has to re-justify is how a permanent hole gets dug.
 */
function liveExclusionKeys(registry, now = Date.now()) {
  const expired = new Set(expiredExclusions(registry, now).map((entry) => entry.id));
  const keys = new Set();
  for (const entry of registry.exclusions ?? []) {
    if (typeof entry?.target !== "string" || typeof entry?.row !== "string") continue;
    if (expired.has(entry.id)) continue;
    keys.add(`${entry.target}\u0000${entry.row}`);
  }
  return keys;
}

export function unexpectedBlockedRows(report, registry, now = Date.now()) {
  const byId = new Map(registry.tests.map((test) => [test.id, test]));
  const live = liveExclusionKeys(registry, now);
  const unexpected = [];
  for (const result of report.results) {
    if (result.status !== "blocked") continue;
    const test = byId.get(result.id);
    if (test === undefined) {
      unexpected.push({ id: result.id, reason: "row is absent from the registry" });
      continue;
    }
    if (test.status !== "implemented") continue;
    const reason = String(result.blockedReason ?? "");
    // A row the registry excludes for this exact lane, by name and within its date, is expected.
    // Without this the exclusion list changed nothing a gate could read: `desktop-multitouch-input`
    // has been registered, owned and dated since PRD-077, and the desktop parity lane still failed
    // every run because this function had never heard of it. A `TN_PARITY_ROW_EXCLUDED` reason with
    // no matching live entry stays a lane defect, which is what keeps the marker from being a
    // free pass.
    if (
      /^TN_PARITY_ROW_EXCLUDED:/u.test(reason)
      && live.has(`${String(report.target ?? "")}\u0000${result.id}`)
    ) continue;
    // A hardware row has no browser reference when the browser lane correctly refuses the
    // software adapter. Keep that environment block distinct from a missing reference on an
    // ordinary row, which remains an unexpected lane defect.
    if (
      test.requiresHardwareAdapter === true
      && (/hardware GPU adapter/u.test(reason) || /^Missing browser reference capture:/u.test(reason))
    ) continue;
    unexpected.push({ id: result.id, reason: reason || "blocked without a reason" });
  }
  return unexpected;
}

export function reportExitCode(report) {
  if (report.summary.fail > 0) return 1;
  if (report.supplemental?.androidMultitouch?.status === "fail") return 1;
  if (report.summary.blocked > 0) return 2;
  if ((report.supplemental?.expiredExclusions ?? []).length > 0) return 2;
  return 0;
}

function runAll(argv) {
  const outArg = valueAfter(argv, "--out") || "artifacts/conformance";
  const base = isAbsolute(outArg) ? outArg : resolve(runtimeRoot, outArg);
  const onlyTests = valueAfter(argv, "--only-tests");
  const device = valueAfter(argv, "--device");
  const targetArg = valueAfter(argv, "--lane");
  const project = valueAfter(argv, "--project");
  const targets = targetArg ? [targetArg] : ["web", "desktop", "android", "ios"];
  let exitCode = 0;
  for (const target of targets) {
    if (!["web", "desktop", "android", "android-hardware", "ios"].includes(target))
      throw new Error(`Unknown --lane target: ${target}`);
    const args = [runnerPath, "--target", target, "--out", join(base, target)];
    if (onlyTests) args.push("--only-tests", onlyTests);
    if (device) args.push("--device", device);
    if (project) args.push("--project", project);
    if (target !== "web") args.push("--reference", join(base, "web"));
    const proc = spawnSync(process.execPath, args, {
      cwd: runtimeRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
    const laneExit = proc.status ?? 1;
    if (laneExit === 1) exitCode = 1;
    else if (laneExit === 2 && exitCode === 0) exitCode = 2;
  }
  process.exitCode = exitCode;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    process.stdout.write(usage());
    return;
  }
  const baseRegistry = loadRegistry();
  const baseRegistryErrors = validateRegistry(baseRegistry);
  if (baseRegistryErrors.length > 0) {
    throw new Error(`Invalid conformance registry:\n- ${baseRegistryErrors.join("\n- ")}`);
  }
  const projectArgument = valueAfter(argv, "--project");
  const project = projectArgument ? resolveParityProject(projectArgument) : null;
  const projectScene = join(
    runtimeRoot,
    `artifacts/conformance/project-scene${project ? `-${projectId(project)}` : ""}.js`,
  );
  if (project) {
    mkdirSync(dirname(projectScene), { recursive: true });
    writeProjectScene(project, projectScene);
  }
  const registry = project
    ? createProjectRegistry(
        baseRegistry,
        relative(runtimeRoot, projectScene).replaceAll("\\", "/"),
        project,
      )
    : baseRegistry;
  const registryErrors = validateRegistry(registry);
  if (registryErrors.length > 0) {
    throw new Error(`Invalid conformance registry:\n- ${registryErrors.join("\n- ")}`);
  }
  const validatePath = valueAfter(argv, "--validate-report");
  if (validatePath) {
    const report = JSON.parse(readFileSync(resolve(runtimeRoot, validatePath), "utf8"));
    const errors = validateReport(report, registry);
    if (errors.length > 0) throw new Error(`Invalid conformance report:\n- ${errors.join("\n- ")}`);
    process.stdout.write(
      `${JSON.stringify({ valid: validatePath, schemaVersion: report.schemaVersion })}\n`,
    );
    return;
  }
  const target = valueAfter(argv, "--target") || (argv.includes("--dry-run") ? "desktop" : "all");
  if (target === "all") {
    runAll(argv);
    return;
  }
  if (!["web", "desktop", "android", "android-hardware", "ios"].includes(target)) {
    throw new Error(
      `--target must be web, desktop, android, android-hardware, ios, or all; received ${target}`,
    );
  }
  const dryRun = argv.includes("--dry-run");
  const selectedIds = valueAfter(argv, "--only-tests")?.split(",").filter(Boolean) ?? null;
  if (selectedIds !== null) {
    const known = new Set(registry.tests.map(({ id }) => id));
    const unknown = selectedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`Unknown --only-tests id(s): ${unknown.join(", ")}`);
  }
  const engine = desktopEngine(argv);
  const owned = engine === "threenative" && target === "desktop";
  if (engine === "threenative" && !["web", "desktop"].includes(target)) {
    throw new Error("--engine threenative selects the web or desktop lane's engine; use --target web|desktop");
  }
  const ownedWeb = engine === "threenative" && target === "web";
  const runtime = owned
    ? ownedEnginePlayerPath()
    : configuredRuntime() || defaultDesktopRuntimePath();
  const desktopPreparation =
    !dryRun && !owned && (target === "desktop" || target === "all")
      ? prepareDesktopRuntime(runtime)
      : { runtime, blockedReason: null };
  const desktopRuntimeBlocker = desktopPreparation.blockedReason;
  const outArg = valueAfter(argv, "--out");
  const { reportPath, captureRoot } = outputLayout(outArg, target);
  const artifactRoot = join(runtimeRoot, "artifacts/conformance");
  const entryRoot = join(artifactRoot, "entries");
  const bundleRoot = join(
    artifactRoot,
    engine === "threenative" ? `${target}-owned-bundles` : `${target}-bundles`,
  );
  for (const path of [entryRoot, bundleRoot, captureRoot]) mkdirSync(path, { recursive: true });
  const device = valueAfter(argv, "--device");
  const provenance = buildProvenance({
    runtime: !dryRun && target === "desktop" ? runtime : null,
    referenceRoot:
      !dryRun && target !== "web" ? referenceRootPath(valueAfter(argv, "--reference")) : null,
    device,
  });
  const report = createReport(
    registry,
    dryRun ? "dry-run" : "execution",
    target,
    runtime,
    project,
    provenance,
  );
  const expired = expiredExclusions(registry);
  const expiredExclusionIds = new Set(expired.map(({ id }) => id));
  const activeRowExclusions = new Map(
    (registry.exclusions ?? [])
      .filter(
        (entry) =>
          typeof entry?.target === "string" &&
          typeof entry?.row === "string" &&
          !expiredExclusionIds.has(entry.id),
      )
      .map((entry) => [`${entry.target}\u0000${entry.row}`, entry]),
  );
  if (expired.length > 0) {
    report.supplemental = {
      expiredExclusions: expired.map(({ expires, id }) => ({ expires, id, status: "blocked" })),
    };
  }
  const targetBlocker = dryRun
    ? null
    : target === "android-hardware"
      ? physicalAndroidBlocker(valueAfter(argv, "--device"))
      : target === "android"
        ? emulatorPreconditionBlocker(valueAfter(argv, "--device"))
        : null;
  const esbuildBin =
    process.platform === "win32"
      ? join(runtimeRoot, "node_modules/.bin/esbuild.cmd")
      : join(runtimeRoot, "node_modules/.bin/esbuild");
  const executeRows = async (port, broker = null) => {
    for (const test of registry.tests) {
      const result = createResult(test);
      const rowStarted = Date.now();
      const hardwareReferenceBlocker =
        !dryRun && ["android", "android-hardware", "desktop"].includes(target)
          ? missingHardwareReferenceBlocker(
              test,
              referencePath(valueAfter(argv, "--reference"), test.id, test),
            )
          : null;
      const expiredRowExclusion = expired.find(
        (entry) => entry.target === target && entry.row === test.id,
      );
      const rowExclusion = activeRowExclusions.get(`${target}\u0000${test.id}`);
      if (expiredRowExclusion !== undefined) {
        result.status = "blocked";
        result.blockedReason =
          `TN_PARITY_EXCLUSION_EXPIRED: ${expiredRowExclusion.id} expired on ${expiredRowExclusion.expires}.`;
      } else if (!dryRun && rowExclusion !== undefined) {
        result.status = "blocked";
        result.blockedReason = `TN_PARITY_ROW_EXCLUDED: ${rowExclusion.id} — ${rowExclusion.reason}`;
      } else if (test.status !== "implemented") {
        result.status = dryRun ? "planned" : "blocked";
        if (!dryRun) result.blockedReason = "Registry row is not implemented.";
      } else if (selectedIds !== null && !selectedIds.includes(test.id)) {
        result.status = "blocked";
        result.blockedReason = "Not selected by this bounded execution run.";
      } else if (targetBlocker) {
        result.status = "blocked";
        result.blockedReason = targetBlocker;
      } else if (hardwareReferenceBlocker !== null) {
        result.status = "blocked";
        result.blockedReason = hardwareReferenceBlocker;
      } else {
        result.status = dryRun ? "validated" : "pass";
        let bundled;
        let bundlePath;
        if (dryRun) {
          const browserEntry = makeEntry(test, "browser", port, entryRoot);
          const nativeEntry = makeEntry(test, "native", port, entryRoot);
          const browserBundle = join(bundleRoot, `${test.id}-browser.js`);
          const nativeBundle = join(bundleRoot, `${test.id}-native.js`);
          const browserBundled = await bundle(
            browserEntry,
            browserBundle,
            result,
            "browser",
            esbuildBin,
            true,
          );
          const nativeBundled = await bundle(
            nativeEntry,
            nativeBundle,
            result,
            "native",
            esbuildBin,
            true,
            "esm",
            project ? ["threenative-native"] : [],
          );
          if (browserBundled && nativeBundled) {
            result.browserBundle = relative(runtimeRoot, browserBundle).replaceAll("\\", "/");
            result.nativeBundle = relative(runtimeRoot, nativeBundle).replaceAll("\\", "/");
          }
          bundled = browserBundled && nativeBundled;
        } else if (ownedWeb && !dryRun) {
          const entry = makeEntry(test, "browser", port, entryRoot);
          bundlePath = join(bundleRoot, `${test.id}.js`);
          try {
            await bundleOwnedWeb(entry, bundlePath);
            bundled = true;
          } catch (error) {
            result.status = "fail";
            result.browser = {
              completed: false,
              engine,
              phase: "bundle",
              error: error instanceof Error ? error.message : String(error),
            };
          }
        } else if (owned && !dryRun) {
          const entry = makeEntry(test, "native", port, entryRoot);
          bundlePath = join(bundleRoot, `${test.id}.js`);
          const { bundleNativeEngine } = await import("../scripts/bundle-native-engine.mjs");
          try {
            await bundleNativeEngine({ entry, outfile: bundlePath, boot: false, host: true });
            bundled = true;
          } catch (error) {
            result.status = "fail";
            result.native = {
              completed: false,
              engine,
              phase: "bundle",
              error: error instanceof Error ? error.message : String(error),
              uniform: null,
            };
          }
        } else {
          const entryTarget = target === "web" ? "browser" : "native";
          const entry = makeEntry(test, entryTarget, port, entryRoot);
          bundlePath = join(bundleRoot, `${test.id}.js`);
          bundled = await bundle(
            entry,
            bundlePath,
            result,
            entryTarget,
            esbuildBin,
            false,
            ["android", "android-hardware"].includes(target) ? "iife" : "esm",
            project && target !== "web" ? ["threenative-native"] : [],
          );
        }
        if (!dryRun && bundled && target === "web") {
          await runBrowser(test, bundlePath, result, port, broker, captureRoot);
          if (ownedWeb) applyUpstreamReference(test, result, valueAfter(argv, "--reference"));
        } else if (!dryRun && bundled && owned) {
          await runDesktopOwned(test, bundlePath, result, runtime, captureRoot);
          applyReferenceAndMetrics(
            test,
            result,
            referencePath(valueAfter(argv, "--reference"), test.id, test),
          );
        } else if (!dryRun && bundled && target === "desktop") {
          await runDesktop(
            test,
            bundlePath,
            result,
            runtime,
            captureRoot,
            project?.publicDir,
            desktopRuntimeBlocker,
          );
          applyReferenceAndMetrics(
            test,
            result,
            referencePath(valueAfter(argv, "--reference"), test.id, test),
          );
        } else if (!dryRun && bundled && ["android", "android-hardware"].includes(target)) {
          await runAndroid(
            test,
            bundlePath,
            result,
            valueAfter(argv, "--device"),
            captureRoot,
            project?.publicDir,
            target === "android",
          );
          applyReferenceAndMetrics(
            test,
            result,
            referencePath(valueAfter(argv, "--reference"), test.id, test),
          );
        } else if (!dryRun && bundled && target === "ios") {
          runIos(test, result);
        }
      }
      // Per-row wall time on stderr (stdout carries the JSON summary): the only way to tell which
      // rows a lane's minutes go to without re-running it.
      if (!dryRun && result.status !== "blocked")
        console.error(`[conformance] ${test.id} ${result.status} ${((Date.now() - rowStarted) / 1000).toFixed(1)}s`);
      report.summary[result.status] += 1;
      report.results.push(result);
    }
  };
  if (shouldRunAndroidMultitouch({ dryRun, project, target })) {
    report.supplemental = {
      ...report.supplemental,
      androidMultitouch: runAndroidMultitouchProof({
        device: valueAfter(argv, "--device"),
        runtimeRoot,
      }),
    };
  }
  if (dryRun || target !== "web") await executeRows(0);
  else
    await withServer(captureRoot, project?.publicDir, ({ port, broker }) =>
      executeRows(port, broker),
    );
  const reportErrors = validateReport(report, registry);
  if (reportErrors.length > 0) {
    throw new Error(`Generated an invalid conformance report:\n- ${reportErrors.join("\n- ")}`);
  }
  writeReport(report, reportPath);
  process.stdout.write(
    `${JSON.stringify({ wrote: reportPath, target, mode: report.mode, summary: report.summary }, null, 2)}\n`,
  );
  if (!dryRun || !argv.includes("--allow-blocked")) {
    process.exitCode = reportExitCode(report);
  }
}

async function executeMain() {
  try {
    await main();
  } finally {
    try {
      const compiler = await compilerPromise?.catch(() => undefined);
      await compiler?.stop();
    } catch (error) {
      process.stderr.write(`TN_CONFORMANCE_BUNDLE_CLEANUP_FAILED: ${String(error)}\n`);
      process.exitCode ||= 1;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === runnerPath) {
  // Lane children re-execute this file (the multi-target loop below spawns runnerPath).
  // Only the outermost invocation owns the gate record and worktree lease; nested ones
  // are covered by their parent's single record.
  if (process.env.TN_GATE_NESTED === "1") {
    executeMain().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    });
  } else {
    process.env.TN_GATE_NESTED = "1";
    void (async () => {
      const { createGateRecorder } = await import("../../../scripts/gate-records.mjs");
      const gateRecorder = await createGateRecorder({
        phase: "parity",
        command: ["pnpm parity", ...process.argv.slice(2)].join(" "),
      });
      try {
        await executeMain();
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
        process.exitCode = 1;
      } finally {
        // main() communicates its own result through process.exitCode; record what ran.
        await gateRecorder.finish(process.exitCode ?? 0);
      }
    })();
  }
}
