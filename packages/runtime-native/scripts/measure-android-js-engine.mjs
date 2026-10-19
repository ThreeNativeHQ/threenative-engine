#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

import {
  ACTIVITY,
  FIRST_FRAME_MARKER,
  discoverTools,
  parseArgs as parseFirstProofArgs,
  verifyAndroidFirstProof,
} from "./verify-android-first-proof.mjs";
import {
  assertDeviceReady,
  MINIMUM_BATTERY_PERCENT,
  resolveAdbExecutable,
  suppressPlayProtectOnAdbInstalls,
} from "./device-preflight.mjs";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXPECTED_DEVICE = "37251FDJH0037Z";
const APP_ID = "com.threenative.game";
const MARKERS = {
  frame: "TN_ANDROID_JS_FRAME:",
  native: "TN_ANDROID_JS_NATIVE:",
  pure: "TN_ANDROID_JS_PURE:",
  subject: "TN_ANDROID_JS_SUBJECT:",
  window: "TN_ANDROID_JS_WINDOW_START:",
};

export class AndroidJsEngineMeasurementError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AndroidJsEngineMeasurementError";
    this.details = details;
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function adbPath(environment = process.env, dependencies = {}) {
  return resolveAdbExecutable(environment, {
    ...dependencies,
    onMissing: () => new AndroidJsEngineMeasurementError("TN_ANDROID_JS_ADB_MISSING", { exitCode: 2 }),
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? runtimeRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180_000,
  });
  if (result.error || result.status !== 0) {
    throw new AndroidJsEngineMeasurementError(
      `Command failed (${result.status ?? "spawn"}): ${command} ${args.join(" ")}\n${result.stderr || result.stdout || result.error?.message || ""}`,
    );
  }
  return String(result.stdout ?? "");
}

function runBinary(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? runtimeRoot,
    encoding: null,
    env: options.env ?? process.env,
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeoutMs ?? 180_000,
  });
  if (result.error || result.status !== 0) {
    throw new AndroidJsEngineMeasurementError(
      `Command failed (${result.status ?? "spawn"}): ${command} ${args.join(" ")}\n${result.stderr?.toString() || result.error?.message || ""}`,
    );
  }
  return result.stdout;
}

function inspectPackagedLibrary(apk, abi, entry, workingDirectory, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const executeBinary = dependencies.runBinary ?? runBinary;
  const bytes = executeBinary("unzip", ["-p", apk, entry]);
  if (bytes.length === 0) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_RUNTIME_LIBRARY_MISSING:${entry}`);
  }
  const temporaryDirectory = mkdtempSync(join(workingDirectory, "runtime-size-"));
  const fileName = entry.split("/").at(-1);
  const packagedPath = join(temporaryDirectory, fileName);
  const strippedPath = join(temporaryDirectory, `${fileName}.stripped`);
  writeFileSync(packagedPath, bytes);
  try {
    execute("llvm-strip", ["--strip-all", "-o", strippedPath, packagedPath]);
    const stripped = readFileSync(strippedPath);
    const sections = execute("llvm-size", ["-A", strippedPath]);
    const textMatch = sections.match(/^\.text\s+(\d+)/mu);
    if (!textMatch) throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_TEXT_SIZE_MISSING");
    const textBytes = Number(textMatch[1]);
    if (
      stripped.length === 0 ||
      stripped.length > bytes.length ||
      !Number.isSafeInteger(textBytes) ||
      textBytes <= 0 ||
      textBytes > stripped.length
    ) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_LIBRARY_SIZE_INVALID:${entry}`);
    }
    return {
      abi,
      apkEntry: entry,
      packagedBytes: bytes.length,
      packagedSha256: sha256(bytes),
      sha256: sha256(stripped),
      strippedBytes: stripped.length,
      textBytes,
    };
  } finally {
    rmSync(temporaryDirectory, { force: true, recursive: true });
  }
}

export function inspectPackagedRuntime(apk, abi, workingDirectory, dependencies = {}) {
  return inspectPackagedLibrary(
    apk,
    abi,
    `lib/${abi}/libmystral-runtime.so`,
    workingDirectory,
    dependencies,
  );
}

export function inspectPackagedBundle(apk, dependencies = {}) {
  const executeBinary = dependencies.runBinary ?? runBinary;
  const apkEntry = "assets/scripts/main.js";
  const bytes = executeBinary("unzip", ["-p", apk, apkEntry]);
  const metadataBytes = executeBinary("unzip", ["-p", apk, `${apkEntry}.meta.json`]);
  if (bytes.length === 0 || metadataBytes.length === 0) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_PACKAGED_BUNDLE_MISSING");
  }
  let metadata;
  try {
    metadata = JSON.parse(metadataBytes.toString("utf8"));
  } catch {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_PACKAGED_BUNDLE_METADATA_INVALID");
  }
  const bundleSha256 = sha256(bytes);
  if (metadata.outputSha256 !== bundleSha256) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_PACKAGED_BUNDLE_METADATA_MISMATCH");
  }
  return { apkEntry, bytes: bytes.length, sha256: bundleSha256 };
}

export function inspectPackagedNativeFootprint(apk, abi, workingDirectory, dependencies = {}) {
  const execute = dependencies.run ?? run;
  const prefix = `lib/${abi}/`;
  const entries = execute("unzip", ["-Z1", apk])
    .split(/\r?\n/u)
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".so") && !entry.slice(prefix.length).includes("/"))
    .sort();
  if (entries.length === 0) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_MISSING:${abi}`);
  }
  if (new Set(entries).size !== entries.length) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_DUPLICATE:${abi}`);
  }
  const libraries = entries.map((entry) =>
    inspectPackagedLibrary(apk, abi, entry, workingDirectory, dependencies),
  );
  const sum = (field) => {
    const total = libraries.reduce((value, library) => value + library[field], 0);
    if (!Number.isSafeInteger(total) || total <= 0) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_OVERFLOW:${field}`);
    }
    return total;
  };
  return {
    abi,
    libraries,
    packagedBytes: sum("packagedBytes"),
    strippedBytes: sum("strippedBytes"),
    textBytes: sum("textBytes"),
  };
}

const sharedEngineLibrary = {
  Hermes: "libhermes.so",
  JavaScriptCore: "libjsc.so",
  V8: "libv8android.so",
};

export function validateNativeFootprint(report, label, expectedEngine) {
  const footprint = report.nativeFootprint;
  const runtime = report.runtimeLibrary;
  if (
    !footprint ||
    footprint.abi !== runtime?.abi ||
    footprint.abi !== report.device?.properties?.abi ||
    !Array.isArray(footprint.libraries) ||
    footprint.libraries.length === 0
  ) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_COMPARISON_INCOMPLETE:${label}_NATIVE_FOOTPRINT`);
  }
  const expectedKeys = [
    "abi",
    "apkEntry",
    "packagedBytes",
    "packagedSha256",
    "sha256",
    "strippedBytes",
    "textBytes",
  ];
  const entries = new Set();
  const totals = { packagedBytes: 0, strippedBytes: 0, textBytes: 0 };
  for (const library of footprint.libraries) {
    if (JSON.stringify(Object.keys(library).sort()) !== JSON.stringify(expectedKeys)) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_SCHEMA:${label}`);
    }
    const prefix = `lib/${footprint.abi}/`;
    if (
      library.abi !== footprint.abi ||
      !library.apkEntry.startsWith(prefix) ||
      !library.apkEntry.endsWith(".so") ||
      library.apkEntry.slice(prefix.length).includes("/") ||
      entries.has(library.apkEntry) ||
      !/^[0-9a-f]{64}$/u.test(library.packagedSha256) ||
      !/^[0-9a-f]{64}$/u.test(library.sha256)
    ) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_LIBRARY:${label}`);
    }
    entries.add(library.apkEntry);
    for (const field of Object.keys(totals)) {
      if (!Number.isSafeInteger(library[field]) || library[field] <= 0) {
        throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_SIZE:${label}`);
      }
      totals[field] += library[field];
    }
    if (
      library.strippedBytes > library.packagedBytes ||
      library.textBytes > library.strippedBytes
    ) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_SIZE:${label}`);
    }
  }
  for (const [field, total] of Object.entries(totals)) {
    if (!Number.isSafeInteger(total) || footprint[field] !== total) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_TOTAL:${label}_${field}`);
    }
  }
  const runtimeRows = footprint.libraries.filter((library) => library.apkEntry === runtime.apkEntry);
  if (
    runtime.apkEntry !== `lib/${footprint.abi}/libmystral-runtime.so` ||
    runtimeRows.length !== 1 ||
    expectedKeys.some((field) => runtimeRows[0][field] !== runtime[field])
  ) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_RUNTIME_MISMATCH:${label}`);
  }
  const requiredSharedLibrary = sharedEngineLibrary[expectedEngine];
  if (requiredSharedLibrary && !entries.has(`lib/${footprint.abi}/${requiredSharedLibrary}`)) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_NATIVE_FOOTPRINT_ENGINE_MISSING:${label}_${expectedEngine}`);
  }
  return footprint;
}

export function validateReportApkEvidence(
  report,
  apkBytes,
  recomputedFootprint,
  recomputedRuntime,
  recomputedBundle,
) {
  if (apkBytes.length !== report.apkBytes || sha256(apkBytes) !== report.apkSha256) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_CONTROL_APK_HASH_MISMATCH");
  }
  if (JSON.stringify(recomputedFootprint) !== JSON.stringify(report.nativeFootprint)) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_CONTROL_APK_FOOTPRINT_MISMATCH");
  }
  if (JSON.stringify(recomputedRuntime) !== JSON.stringify(report.runtimeLibrary)) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_CONTROL_APK_RUNTIME_MISMATCH");
  }
  if (
    JSON.stringify(recomputedBundle) !== JSON.stringify(report.bundle) ||
    recomputedBundle.sha256 !== report.bundleSha256
  ) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_CONTROL_APK_BUNDLE_MISMATCH");
  }
}

export function validateOptimizationProvenance(packagedSha256, candidates) {
  const matching = candidates.filter((candidate) => candidate.sha256 === packagedSha256);
  if (matching.length === 0) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_O2_PROVENANCE_MISSING");
  }
  if (matching.some((candidate) => candidate.optimization !== "-O2")) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_O2_PROVENANCE_AMBIGUOUS");
  }
  return {
    artifactSha256: packagedSha256,
    buildNinjaFiles: matching.map((candidate) => candidate.buildNinja),
    nativeLibraries: matching.map((candidate) => candidate.nativeLibrary),
    optimization: "-O2",
  };
}

export function inspectNativeOptimization(abi, packagedSha256, root = runtimeRoot) {
  const buildRoot = join(root, "android/app/build");
  const mergedLibrary = join(
    buildRoot,
    "intermediates/merged_native_libs/debug/out/lib",
    abi,
    "libmystral-runtime.so",
  );
  if (!existsSync(mergedLibrary) || sha256(readFileSync(mergedLibrary)) !== packagedSha256) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_PACKAGED_RUNTIME_PROVENANCE_MISMATCH:${abi}`);
  }

  const cxxOutputs = join(buildRoot, "intermediates/cxx/Debug");
  const candidates = existsSync(cxxOutputs)
    ? readdirSync(cxxOutputs, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => {
          const nativeLibrary = join(cxxOutputs, entry.name, "obj", abi, "libmystral-runtime.so");
          const buildNinja = join(root, "android/app/.cxx/Debug", entry.name, abi, "build.ninja");
          if (!existsSync(nativeLibrary) || !existsSync(buildNinja)) return [];
          const ninja = readFileSync(buildNinja, "utf8");
          return [{
            buildNinja,
            nativeLibrary,
            optimization: /(?:^|\s)-O2(?:\s|$)/mu.test(ninja) ? "-O2" : "other",
            sha256: sha256(readFileSync(nativeLibrary)),
          }];
        })
    : [];
  return validateOptimizationProvenance(packagedSha256, candidates);
}

function adb(adbExecutable, serial, ...args) {
  return run(adbExecutable, ["-s", serial, ...args], { timeoutMs: 120_000 });
}

export function percentile(values, probability) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_PERCENTILE_EMPTY");
  }
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_PERCENTILE_INVALID:${probability}`);
  }
  const sorted = values.map((value, index) => finiteNonNegative(value, `percentile[${index}]`)).sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(probability * sorted.length) - 1)];
}

export function parsePeakRssKb(processStatus) {
  const match = String(processStatus).match(/^VmHWM:\s+(\d+)\s+kB\s*$/mu);
  if (!match) throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_PEAK_RSS_MISSING");
  const peakRssKb = Number(match[1]);
  if (!Number.isSafeInteger(peakRssKb) || peakRssKb <= 0) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_PEAK_RSS_INVALID:${match[1]}`);
  }
  return peakRssKb;
}

export function validateCandidateComparison(control, candidate, expectedEngine) {
  if (control?.acceptanceEligible !== true || candidate?.acceptanceEligible !== true) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMPARISON_PHYSICAL_REQUIRED");
  }
  if (
    control.device?.serial !== EXPECTED_DEVICE ||
    candidate.device?.serial !== EXPECTED_DEVICE ||
    control.device.serial !== candidate.device.serial
  ) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMPARISON_DEVICE_MISMATCH");
  }
  for (const [label, report] of [["CONTROL", control], ["CANDIDATE", candidate]]) {
    const condition = report?.deviceCondition;
    if (!condition || typeof condition !== "object" || Array.isArray(condition) || typeof condition.batteryPercent !== "number" || typeof condition.charging !== "boolean" || typeof condition.thermalStatus !== "string" || typeof condition.screenOn !== "boolean") throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_DEVICE_CONDITION_MALFORMED:${label}`);
    const topLevelProvisional = report.provisional;
    const nestedProvisional = condition.provisional;
    if (
      !Array.isArray(topLevelProvisional) ||
      topLevelProvisional.some((value) => typeof value !== "string" || value.length === 0) ||
      !Array.isArray(nestedProvisional) ||
      nestedProvisional.some((value) => typeof value !== "string" || value.length === 0) ||
      topLevelProvisional.length !== nestedProvisional.length ||
      topLevelProvisional.some((value, index) => value !== nestedProvisional[index])
    ) throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_PROVISIONAL_COMPARISON_MALFORMED:${label}`);
    if (topLevelProvisional.length > 0) throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_PROVISIONAL_COMPARISON:${label}`);
  }
  if (control.bundleSha256 !== candidate.bundleSha256) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_TWO_VARIABLES:BUNDLE_SHA_CHANGED");
  }
  if (control.runtimeLibrary?.sha256 === candidate.runtimeLibrary?.sha256) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_RUNTIME_LIBRARY_UNCHANGED");
  }
  if (control.nativeBuild?.optimization !== "-O2") {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_WRONG_DENOMINATOR:CONTROL_NOT_O2");
  }
  if (candidate.nativeBuild?.optimization !== "-O2") {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_WRONG_DENOMINATOR:CANDIDATE_NOT_O2");
  }
  if (
    control.nativeBuild.artifactSha256 !== control.runtimeLibrary?.packagedSha256 ||
    candidate.nativeBuild.artifactSha256 !== candidate.runtimeLibrary?.packagedSha256
  ) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_WRONG_DENOMINATOR:ARTIFACT_PROVENANCE_MISMATCH");
  }
  for (const [label, report] of [["CONTROL", control], ["CANDIDATE", candidate]]) {
    const coldStart = report.coldStart;
    if (
      coldStart?.runs !== 5 ||
      !Array.isArray(coldStart.samplesMs) ||
      coldStart.samplesMs.length !== 5 ||
      !Number.isFinite(coldStart.p95Ms)
    ) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_COMPARISON_INCOMPLETE:${label}_COLD_START`);
    }
  }
  if (!Number.isFinite(candidate.cleanBuildWallClockMs) || candidate.cleanBuildWallClockMs <= 0) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMPARISON_INCOMPLETE:CANDIDATE_CLEAN_BUILD");
  }
  validateNativeFootprint(control, "CONTROL", "QuickJS");
  validateNativeFootprint(candidate, "CANDIDATE", expectedEngine);
  if (control.analysis?.native?.engine !== "QuickJS") {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_CONTROL_ENGINE_NOT_QUICKJS");
  }
  if (candidate.analysis?.native?.engine !== expectedEngine) {
    throw new AndroidJsEngineMeasurementError(
      `TN_ANDROID_JS_ENGINE_IDENTITY_MISMATCH:expected ${expectedEngine}, received ${candidate.analysis?.native?.engine}`,
    );
  }
  return {
    bundleSha256: candidate.bundleSha256,
    candidateEngine: expectedEngine,
    controlEngine: control.analysis.native.engine,
    runtimeChanged: true,
  };
}

async function measureColdStarts(
  adbExecutable,
  serial,
  runs,
  firstFrameMarker = FIRST_FRAME_MARKER,
  timeoutMs = 30_000,
) {
  const samplesMs = [];
  for (let runIndex = 0; runIndex < runs; runIndex += 1) {
    adb(adbExecutable, serial, "shell", "am", "force-stop", APP_ID);
    adb(adbExecutable, serial, "logcat", "-c");
    const startedAt = performance.now();
    const launch = adb(adbExecutable, serial, "shell", "am", "start", "-W", "-n", ACTIVITY);
    if (!/Status:\s*ok/iu.test(launch)) {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_COLD_START_LAUNCH_FAILED:${runIndex + 1}`);
    }
    await waitForMarker(adbExecutable, serial, firstFrameMarker, timeoutMs);
    samplesMs.push(performance.now() - startedAt);
  }
  return { p95Ms: percentile(samplesMs, 0.95), runs, samplesMs };
}

export function classifyDevice(properties) {
  const hardware = String(properties.hardware ?? "").toLowerCase();
  return String(properties.qemu ?? "").trim() === "1" || /goldfish|ranchu|qemu|cutf/u.test(hardware)
    ? "emulator"
    : "physical";
}

// Wireless adb names the same phone `ip:port`, and the discharging preflight (PRD-127) requires
// the untethered lane, so the transport string can never be the device's identity. The hardware
// serial from `ro.serialno` is; an empty read falls back to the transport string, which then
// fails the physical check below exactly as an unknown phone would.
export function resolveMeasurementSerial(hardwareSerial, transportSerial) {
  const identity = String(hardwareSerial ?? "").trim();
  return identity !== "" ? identity : String(transportSerial ?? "").trim();
}

export function requireMeasurementDevice(properties, serial, allowEmulatorDevelopment = false) {
  const kind = classifyDevice(properties);
  if (kind === "emulator" && !allowEmulatorDevelopment) {
    throw new AndroidJsEngineMeasurementError(
      `TN_ANDROID_JS_EMULATOR_BLOCKED:${serial}; physical Pixel 8 ${EXPECTED_DEVICE} is required.`,
      { exitCode: 2, kind },
    );
  }
  if (kind === "physical" && serial !== EXPECTED_DEVICE) {
    throw new AndroidJsEngineMeasurementError(
      `TN_ANDROID_JS_WRONG_DEVICE:${serial}; expected ${EXPECTED_DEVICE}.`,
      { exitCode: 2, kind },
    );
  }
  return { acceptanceEligible: kind === "physical" && serial === EXPECTED_DEVICE, kind, serial };
}

export function requireInstallForEvidence(device, options) {
  if (options.skipInstall && (device.acceptanceEligible || options.controlReport)) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_SKIP_INSTALL_NOT_EVIDENCE_ELIGIBLE");
  }
}

export function parseJsonMarkers(log, marker, { exactlyOne = false, required = true } = {}) {
  const values = [];
  for (const line of String(log).split(/\r?\n/u)) {
    const markerAt = line.indexOf(marker);
    if (markerAt === -1) continue;
    const raw = line.slice(markerAt + marker.length).trim();
    try {
      values.push(JSON.parse(raw));
    } catch {
      throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_MALFORMED_MARKER:${marker}${raw}`);
    }
  }
  if (required && values.length === 0) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_MISSING_MARKER:${marker}`);
  }
  if (exactlyOne && values.length !== 1) {
    throw new AndroidJsEngineMeasurementError(
      `TN_ANDROID_JS_DUPLICATE_MARKER:${marker}; expected one, received ${values.length}.`,
    );
  }
  return values;
}

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_INVALID_NUMBER:${name}=${value}`);
  }
  return value;
}

export function analyzeMeasurementLog(log, expected = {}) {
  const subject = parseJsonMarkers(log, MARKERS.subject, { exactlyOne: true })[0];
  const frame = parseJsonMarkers(log, MARKERS.frame, { exactlyOne: true })[0];
  const pure = parseJsonMarkers(log, MARKERS.pure, {
    exactlyOne: expected.pureJsIterations > 0,
    required: expected.pureJsIterations > 0,
  })[0] ?? null;
  parseJsonMarkers(log, MARKERS.window, { exactlyOne: true });
  const windowAt = log.indexOf(MARKERS.window);
  const frameAt = log.indexOf(MARKERS.frame, windowAt);
  if (frameAt === -1) throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_WINDOW_UNCLOSED");
  const native = parseJsonMarkers(log.slice(windowAt, frameAt), MARKERS.native);

  for (const [key, value] of Object.entries(expected)) {
    if (value !== undefined && subject[key] !== value) {
      throw new AndroidJsEngineMeasurementError(
        `TN_ANDROID_JS_SUBJECT_MISMATCH:${key}; expected ${value}, received ${subject[key]}.`,
      );
    }
  }
  finiteNonNegative(frame.elapsedMs, "frame.elapsedMs");
  finiteNonNegative(frame.msPerFrame, "frame.msPerFrame");
  if (!Number.isInteger(frame.frames) || frame.frames <= 0) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_INVALID_NUMBER:frame.frames=${frame.frames}`);
  }
  if (frame.frames !== subject.frameWindow) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_FRAME_WINDOW_MISMATCH");
  }
  if (Math.abs(frame.elapsedMs / frame.frames - frame.msPerFrame) > 0.01) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_FRAME_ARITHMETIC_MISMATCH");
  }

  const fields = ["bindingNs", "bundlesExecuted", "calls", "presentNs", "submitPollNs"];
  const totals = Object.fromEntries(fields.map((field) => [field, 0]));
  const commandFields = [
    "bundleDrawIndexed",
    "draw",
    "drawIndexed",
    "endRenderPass",
    "executeBundles",
    "setBindGroup",
    "setIndexBuffer",
    "setPipeline",
    "setVertexBuffer",
    "writeBuffer",
  ];
  const commandTotals = Object.fromEntries(commandFields.map((field) => [field, 0]));
  const commandTimeTotals = Object.fromEntries(commandFields.map((field) => [field, 0]));
  const engines = new Set();
  for (const sample of native) {
    for (const field of fields) totals[field] += finiteNonNegative(sample[field], `native.${field}`);
    if (
      sample.commands === null ||
      typeof sample.commands !== "object" ||
      JSON.stringify(Object.keys(sample.commands).sort()) !== JSON.stringify(commandFields)
    ) {
      throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMMAND_SCHEMA_MISMATCH");
    }
    let commandCalls = 0;
    for (const field of commandFields) {
      const value = finiteNonNegative(sample.commands[field], `native.commands.${field}`);
      commandTotals[field] += value;
      commandCalls += value;
    }
    if (commandCalls !== sample.calls) {
      throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMMAND_TOTAL_MISMATCH");
    }
    if (
      sample.commandNs === null ||
      typeof sample.commandNs !== "object" ||
      JSON.stringify(Object.keys(sample.commandNs).sort()) !== JSON.stringify(commandFields)
    ) {
      throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMMAND_TIME_SCHEMA_MISMATCH");
    }
    let commandTime = 0;
    for (const field of commandFields) {
      const value = finiteNonNegative(sample.commandNs[field], `native.commandNs.${field}`);
      commandTimeTotals[field] += value;
      commandTime += value;
    }
    if (commandTime !== sample.bindingNs) {
      throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_COMMAND_TIME_TOTAL_MISMATCH");
    }
    if (typeof sample.engine !== "string" || sample.engine.length === 0) {
      throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_ENGINE_IDENTITY_MISSING");
    }
    engines.add(sample.engine);
  }
  if (engines.size !== 1) throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_ENGINE_IDENTITY_MIXED");
  // Present time belongs to a frame, but each submit reports the PREVIOUS present, so summing
  // `presentNs` across submits counted it once per submit — ~4x per frame at four submits/frame.
  // A host that tags each marker with its frame count gets exact per-frame grouping; legacy
  // markers without the tag fall back to run-length dedupe of identical consecutive values,
  // which is exact except when two consecutive frames present in the same nanosecond.
  const taggedSamples = native.filter((sample) => sample.frame !== undefined);
  if (taggedSamples.length !== 0 && taggedSamples.length !== native.length) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_FRAME_TAG_MISMATCH");
  }
  let presentTotalNs = 0;
  let presentEvents = 0;
  if (taggedSamples.length !== 0) {
    const perFrame = new Map();
    for (const sample of native) {
      const tag = finiteNonNegative(sample.frame, "native.frame");
      perFrame.set(tag, Math.max(perFrame.get(tag) ?? 0, sample.presentNs));
    }
    for (const value of perFrame.values()) {
      presentTotalNs += value;
      presentEvents += 1;
    }
  } else {
    let previous;
    for (const sample of native) {
      if (sample.presentNs !== previous) {
        previous = sample.presentNs;
        presentTotalNs += sample.presentNs;
        presentEvents += 1;
      }
    }
  }
  const sampleCount = native.length;
  const boundaryMsPerSubmit = totals.bindingNs / sampleCount / 1_000_000;
  const nativeMsPerSubmit = totals.submitPollNs / sampleCount / 1_000_000;
  const submitsPerFrame = sampleCount / frame.frames;
  const boundaryMsPerFrame = (totals.bindingNs / frame.frames) / 1_000_000;
  const nativeMsPerFrame =
    ((totals.submitPollNs + presentTotalNs) / frame.frames) / 1_000_000;
  const attributedMsPerFrame = boundaryMsPerFrame + nativeMsPerFrame;
  return {
    frame,
    native: {
      boundaryMsPerSubmit,
      bundlesExecutedPerFrame: totals.bundlesExecuted / frame.frames,
      callsPerFrame: totals.calls / frame.frames,
      callsPerSubmit: totals.calls / sampleCount,
      commandMsPerFrame: Object.fromEntries(
        commandFields.map((field) => [field, commandTimeTotals[field] / frame.frames / 1_000_000]),
      ),
      commandsPerFrame: Object.fromEntries(
        commandFields.map((field) => [field, commandTotals[field] / frame.frames]),
      ),
      engine: [...engines][0],
      nativeMsPerSubmit,
      presentCountedOncePerFrame: true,
      presentEvents,
      samples: sampleCount,
      submitsPerFrame,
    },
    pure,
    split: {
      boundaryMsPerFrame,
      javascriptAndUninstrumentedMsPerFrame: Math.max(0, frame.msPerFrame - attributedMsPerFrame),
      measuredMsPerFrame: frame.msPerFrame,
      nativeSubmitPresentMsPerFrame: nativeMsPerFrame,
      tolerance: "native time is summed across every submit between the exact JS window markers",
    },
    subject,
  };
}

export function parseArgs(argv) {
  const options = {
    allowEmulatorDevelopment: false,
    allowLowBattery: false,
    busyLoop: false,
    cleanBuild: false,
    coldStartRuns: 5,
    controlReport: null,
    device: null,
    extraDrawControl: false,
    expectedEngine: "QuickJS",
    foxSubject: false,
    frameWindow: 300,
    materials: "shared",
    meshes: 0,
    pureJsIterations: 20,
    pureJsObjects: 2358,
    reportPath: null,
    skipBuild: false,
    skipInstall: false,
    visibility: 1,
    vsync: false,
    warmupFrames: 60,
  };
  const values = new Map([
    ["--device", "device"],
    ["--cold-start-runs", "coldStartRuns"],
    ["--control-report", "controlReport"],
    ["--expected-engine", "expectedEngine"],
    ["--frame-window", "frameWindow"],
    ["--materials", "materials"],
    ["--meshes", "meshes"],
    ["--pure-js-iterations", "pureJsIterations"],
    ["--pure-js-objects", "pureJsObjects"],
    ["--report", "reportPath"],
    ["--visibility", "visibility"],
    ["--warmup-frames", "warmupFrames"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--allow-emulator-development") options.allowEmulatorDevelopment = true;
    else if (arg === "--allow-low-battery") options.allowLowBattery = true;
    else if (arg === "--busy-loop-control") options.busyLoop = true;
    else if (arg === "--clean-build") options.cleanBuild = true;
    else if (arg === "--extra-draw-control") options.extraDrawControl = true;
    else if (arg === "--fox-subject") options.foxSubject = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--vsync") options.vsync = true;
    else if (values.has(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new AndroidJsEngineMeasurementError(`${arg} requires a value.`);
      options[values.get(arg)] = value;
      index += 1;
    } else throw new AndroidJsEngineMeasurementError(`Unknown option: ${arg}`);
  }
  for (const key of ["coldStartRuns", "frameWindow", "meshes", "pureJsIterations", "pureJsObjects", "warmupFrames"]) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < 0) {
      throw new AndroidJsEngineMeasurementError(`--${key} must be a non-negative integer.`);
    }
  }
  options.visibility = Number(options.visibility);
  if (![0, 0.25, 0.5, 1].includes(options.visibility)) {
    throw new AndroidJsEngineMeasurementError("--visibility must be 0, 0.25, 0.5, or 1.");
  }
  if (options.materials !== "shared" && options.materials !== "distinct") {
    throw new AndroidJsEngineMeasurementError("--materials must be shared or distinct.");
  }
  if (!options.device) throw new AndroidJsEngineMeasurementError("--device is required.", { exitCode: 2 });
  if (options.cleanBuild && options.skipBuild) {
    throw new AndroidJsEngineMeasurementError("--clean-build and --skip-build are mutually exclusive.");
  }
  if (options.foxSubject && !options.skipBuild) {
    throw new AndroidJsEngineMeasurementError("--fox-subject requires --skip-build with an explicitly packaged fox APK.");
  }
  return options;
}

async function waitForMarker(adbExecutable, serial, marker, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let log = "";
  while (Date.now() < deadline) {
    log = adb(adbExecutable, serial, "logcat", "-d", "-v", "threadtime");
    if (log.includes(marker)) return log;
    await new Promise((resolveTimer) => setTimeout(resolveTimer, 500));
  }
  throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_TIMEOUT:${marker}`);
}

// The per-submit TN_ANDROID_JS_NATIVE lines flood logcat's default 256 KB main buffer in a few
// hundred frames, evicting the early SUBJECT and WINDOW_START markers the analysis requires
// (seen on the Pixel 8 under V8, 2026-08-21: 7,030 native lines, both early markers gone).
// The measurement buffer is sized so a full window plus cold starts cannot wrap it.
export const MEASUREMENT_LOGBUFFER_BYTES = 16 * 1024 * 1024;

async function installAndLaunchMeasuredSubject(adbExecutable, serial, apk) {
  // The Play Protect verifier dialog is modal and swallows the install, so an unattended
  // lane behind it proves nothing. Suppress before the install, as every install lane must.
  suppressPlayProtectOnAdbInstalls(serial, {
    adb: (adbArgs) => adb(adbExecutable, serial, ...adbArgs),
  });
  const install = adb(adbExecutable, serial, "install", "-r", "-t", apk);
  if (!/Success/iu.test(install)) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_INSTALL_FAILED:${install.trim()}`);
  }
  adb(adbExecutable, serial, "shell", "am", "force-stop", APP_ID);
  adb(adbExecutable, serial, "logcat", "-G", String(MEASUREMENT_LOGBUFFER_BYTES));
  adb(adbExecutable, serial, "logcat", "-c");
  const launch = adb(
    adbExecutable,
    serial,
    "shell",
    "am",
    "start",
    "-W",
    "-n",
    ACTIVITY,
  );
  if (!/Status:\s*ok/iu.test(launch)) {
    throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_LAUNCH_FAILED:${launch.trim()}`);
  }
  return waitForMarker(adbExecutable, serial, MARKERS.frame);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const adbExecutable = adbPath();
  const state = adb(adbExecutable, options.device, "get-state").trim();
  if (state !== "device") throw new AndroidJsEngineMeasurementError(`TN_ANDROID_JS_DEVICE_BLOCKED:${state}`, { exitCode: 2 });
  const properties = {
    hardware: adb(adbExecutable, options.device, "shell", "getprop", "ro.hardware").trim(),
    abi: adb(adbExecutable, options.device, "shell", "getprop", "ro.product.cpu.abi").trim(),
    model: adb(adbExecutable, options.device, "shell", "getprop", "ro.product.model").trim(),
    qemu: adb(adbExecutable, options.device, "shell", "getprop", "ro.kernel.qemu").trim(),
  };
  const hardwareSerial = adb(adbExecutable, options.device, "shell", "getprop", "ro.serialno").trim();
  const device = requireMeasurementDevice(
    properties,
    resolveMeasurementSerial(hardwareSerial, options.device),
    options.allowEmulatorDevelopment,
  );
  requireInstallForEvidence(device, options);
  const defaultRoot = device.acceptanceEligible
    ? join(runtimeRoot, "artifacts", "android", "js-engine")
    : join(runtimeRoot, ".runtime", "android-js-engine-emulator");
  const reportPath = resolve(options.reportPath ?? join(defaultRoot, "report.json"));
  const logPath = reportPath.endsWith(".json")
    ? `${reportPath.slice(0, -5)}.logcat.txt`
    : `${reportPath}.logcat.txt`;
  mkdirSync(dirname(reportPath), { recursive: true });

  Object.assign(process.env, {
    ORG_GRADLE_PROJECT_threenativeJsProfile: "true",
    ORG_GRADLE_PROJECT_threenativeJsProfileBusyLoop: String(options.busyLoop),
    ORG_GRADLE_PROJECT_threenativeVsync: String(options.vsync),
    THREENATIVE_JS_PROFILE_FRAME_WINDOW: String(options.frameWindow),
    THREENATIVE_JS_PROFILE_EXTRA_DRAW_CONTROL: String(options.extraDrawControl),
    THREENATIVE_JS_PROFILE_MATERIALS: options.materials,
    THREENATIVE_JS_PROFILE_MESHES: String(options.meshes),
    THREENATIVE_JS_PROFILE_PURE_JS_ITERATIONS: String(options.pureJsIterations),
    THREENATIVE_JS_PROFILE_PURE_JS_OBJECTS: String(options.pureJsObjects),
    THREENATIVE_JS_PROFILE_VISIBILITY: String(options.visibility),
    THREENATIVE_JS_PROFILE_WARMUP_FRAMES: String(options.warmupFrames),
  });
  const tools = discoverTools();
  const gradle = process.platform === "win32"
    ? join(runtimeRoot, "android", "gradlew.bat")
    : "bash";
  const gradlePrefix = process.platform === "win32" ? [] : ["./gradlew"];
  const gradleEnvironment = {
    ...process.env,
    ANDROID_HOME: tools.sdkRoot,
    ANDROID_SDK_ROOT: tools.sdkRoot,
    JAVA_HOME: tools.javaHome,
  };
  let cleanBuildWallClockMs = null;
  if (options.cleanBuild) {
    const buildStartedAt = Date.now();
    run(gradle, [...gradlePrefix, "clean", "assembleDebug"], {
      cwd: join(runtimeRoot, "android"),
      env: gradleEnvironment,
      timeoutMs: 1_800_000,
    });
    cleanBuildWallClockMs = Date.now() - buildStartedAt;
  } else if (!options.skipBuild) {
    run(gradle, [...gradlePrefix, "assembleDebug"], {
      cwd: join(runtimeRoot, "android"),
      env: gradleEnvironment,
      timeoutMs: 1_800_000,
    });
  }
  const builtApkPath = join(runtimeRoot, "android/app/build/outputs/apk/debug/app-debug.apk");
  const apkBytes = readFileSync(builtApkPath);
  const apkSha256 = sha256(apkBytes);
  const archivedApkPath = join(dirname(reportPath), `apk-${apkSha256}.apk`);
  if (!existsSync(archivedApkPath)) copyFileSync(builtApkPath, archivedApkPath);
  if (sha256(readFileSync(archivedApkPath)) !== apkSha256) {
    throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_ARCHIVED_APK_HASH_MISMATCH");
  }
  const bundle = inspectPackagedBundle(archivedApkPath);
  const proofOptions = parseFirstProofArgs([
    "--device",
    options.device,
    "--apk",
    archivedApkPath,
    "--timeout-ms",
    "180000",
    "--settle-ms",
    "0",
    "--logcat",
    logPath,
    "--skip-build",
    ...(options.skipInstall ? ["--skip-install"] : []),
  ]);
  const startedAt = new Date();
  const deviceCondition = await assertDeviceReady(options.device, {
    allowOverride: options.allowLowBattery,
    maxThermalStatus: "NONE",
    minBatteryPercent: MINIMUM_BATTERY_PERCENT,
    requireDischarging: true,
  });
  let log;
  if (options.foxSubject) {
    if (options.skipInstall) {
      throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_FOX_SUBJECT_REQUIRES_INSTALL");
    }
    log = await installAndLaunchMeasuredSubject(adbExecutable, options.device, archivedApkPath);
  } else {
    await verifyAndroidFirstProof(proofOptions);
    log = await waitForMarker(adbExecutable, options.device, MARKERS.frame);
  }
  writeFileSync(logPath, log);
  const expected = {
    extraDrawControl: options.extraDrawControl,
    frameWindow: options.frameWindow,
    materials: options.materials,
    meshes: options.meshes,
    pureJsIterations: options.pureJsIterations,
    pureJsObjects: options.pureJsObjects,
    visibility: options.visibility,
    warmupFrames: options.warmupFrames,
  };
  const analysis = analyzeMeasurementLog(log, expected);
  if (analysis.native.engine !== options.expectedEngine) {
    throw new AndroidJsEngineMeasurementError(
      `TN_ANDROID_JS_ENGINE_IDENTITY_MISMATCH:expected ${options.expectedEngine}, received ${analysis.native.engine}`,
    );
  }
  const pid = adb(adbExecutable, options.device, "shell", "pidof", APP_ID).trim();
  if (!pid) throw new AndroidJsEngineMeasurementError("TN_ANDROID_JS_PROCESS_MISSING");
  const processStatus = adb(adbExecutable, options.device, "shell", "cat", `/proc/${pid}/status`);
  const peakRssKb = parsePeakRssKb(processStatus);
  const coldStart = options.coldStartRuns > 0
    ? await measureColdStarts(
        adbExecutable,
        options.device,
        options.coldStartRuns,
        options.foxSubject ? MARKERS.native : FIRST_FRAME_MARKER,
      )
    : null;
  const report = {
    acceptanceEligible: device.acceptanceEligible,
    analysis,
    apk: archivedApkPath,
    apkBytes: apkBytes.length,
    apkSha256,
    bundle,
    bundleSha256: bundle.sha256,
    coldStart,
    controls: { busyLoop: options.busyLoop, emulatorBlockedForAcceptance: !device.acceptanceEligible },
    cleanBuildWallClockMs,
    device: { ...device, properties },
    deviceCondition,
    finishedAt: new Date().toISOString(),
    foxSubject: options.foxSubject,
    logcat: logPath,
    peakRssKb,
    provisional: deviceCondition.provisional,
    schemaVersion: 1,
    startedAt: startedAt.toISOString(),
  };
  report.runtimeLibrary = inspectPackagedRuntime(
    archivedApkPath,
    properties.abi,
    dirname(reportPath),
  );
  report.nativeFootprint = inspectPackagedNativeFootprint(
    archivedApkPath,
    properties.abi,
    dirname(reportPath),
  );
  report.nativeBuild = inspectNativeOptimization(properties.abi, report.runtimeLibrary.packagedSha256);
  if (options.controlReport) {
    const control = JSON.parse(readFileSync(resolve(options.controlReport), "utf8"));
    const controlApkBytes = readFileSync(control.apk);
    const controlFootprint = inspectPackagedNativeFootprint(
      control.apk,
      control.nativeFootprint?.abi,
      dirname(reportPath),
    );
    const controlRuntime = inspectPackagedRuntime(
      control.apk,
      control.nativeFootprint?.abi,
      dirname(reportPath),
    );
    const controlBundle = inspectPackagedBundle(control.apk);
    validateReportApkEvidence(
      control,
      controlApkBytes,
      controlFootprint,
      controlRuntime,
      controlBundle,
    );
    report.comparison = validateCandidateComparison(control, report, options.expectedEngine);
  }
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ report: reportPath, ...report }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode =
      error instanceof AndroidJsEngineMeasurementError && Number.isInteger(error.details.exitCode)
        ? error.details.exitCode
        : 1;
  }
}
