#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const project = join(root, "examples/abyss-framework/vq-assets");
const packageName = "com.threenative.vq01";
const activity = "com.threenative.runtime.MystralActivity";
const scenario = join(root, "examples/abyss-framework/playtests/vq-native-asset-capabilities.playtest.json");
const runtimeRoot = join(root, "packages/runtime-native");
const threenativeCli = join(root, "packages/create-threenative/dist/threenative.js");
const bundleSource = join(runtimeRoot, "scripts/bundle.mjs");
const assetsPackage = join(root, "packages/assets/dist/index.js");
const runner = join(root, "packages/playtest/dist/runner/cli.js");
const receipt = join(runtimeRoot, "third_party/v8-android/build-receipt.json");
const packageAndroidUrl = pathToFileURL(join(runtimeRoot, "scripts/package-android.mjs")).href;
const coldStartUrl = pathToFileURL(join(runtimeRoot, "scripts/measure-cold-start.mjs")).href;
const sourceEntry = join(project, "src/game.ts");

const names = {
  astcCoverage: "astc-coverage.apk",
  basisCoverage: "basis-coverage.apk",
  astcTiming: "astc-timing.apk",
  basisTiming: "basis-timing.apk",
};

function usage() {
  console.log(`Usage: node --import tsx .linchpin/prd568-v8-ac2.mjs [options]

Builds current V8 ASTC and Basis-control APKs, proves decoder-call coverage, and runs
three interleaved first-frame pairs. The default mode runs both lanes.

Options:
  --device SERIAL       named Android device/emulator (required to run)
  --output DIR          ignored output directory
  --coverage            build/run only the always-armed counter coverage
  --timing              build/run only the uninstrumented timing sequence
  --reuse               use APKs already present under --output
  --self-check          validate the tracked bundle's instrumentation anchors only
  --plan                print exact build and launch commands without running them
  --help                show this message`);
}

function parseArgs(argv) {
  const options = { mode: "all", reuse: false, plan: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
    } else if (argument === "--coverage" || argument === "--timing") {
      if (options.mode !== "all") throw new Error("TN_PRD568_MODE_CONFLICT: choose --coverage or --timing");
      options.mode = argument.slice(2);
    } else if (argument === "--reuse") {
      options.reuse = true;
    } else if (argument === "--plan") {
      options.plan = true;
    } else if (argument === "--self-check") {
      options.selfCheck = true;
    } else if (["--device", "--output"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) throw new Error(`TN_PRD568_OPTION_VALUE_MISSING:${argument}`);
      options[argument.slice(2)] = value;
    } else {
      throw new Error(`TN_PRD568_OPTION_UNKNOWN:${argument}`);
    }
  }
  return options;
}

function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      cwd: options.cwd ?? root,
      encoding: "utf8",
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      timeout: options.timeout ?? 30_000,
      env: options.env,
    });
  } catch (error) {
    const detail = error && typeof error === "object"
      ? String(error.stderr ?? error.stdout ?? error.message ?? error)
      : String(error);
    fail(`TN_PRD568_COMMAND_FAILED:${executable} ${args.join(" ")}:${detail.trim()}`);
  }
}

function resolveAdb() {
  const androidHome = process.env.ANDROID_HOME ?? join(homedir(), "Android/Sdk");
  const candidate = process.env.TN_PRD568_ADB ?? join(androidHome, "platform-tools/adb");
  if (existsSync(candidate)) return candidate;
  try {
    command("adb", ["version"]);
    return "adb";
  } catch {
    fail(`TN_PRD568_ADB_MISSING:${candidate}`);
  }
}

function adb(adbPath, serial, args, timeout = 30_000) {
  return command(adbPath, ["-s", serial, ...args], { timeout });
}

function extractJsonMarkers(text, marker) {
  const frames = [];
  let cursor = 0;
  while (true) {
    const markerAt = text.indexOf(marker, cursor);
    if (markerAt < 0) break;
    const start = text.indexOf("{", markerAt + marker.length);
    if (start < 0) fail(`TN_PRD568_MARKER_MALFORMED:${marker}`);
    let depth = 0;
    let end = -1;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
      if (text[index] === "\n" && depth > 0) break;
    }
    if (end < 0) fail(`TN_PRD568_MARKER_MALFORMED:${marker}`);
    try {
      frames.push(JSON.parse(text.slice(start, end)));
    } catch {
      fail(`TN_PRD568_MARKER_MALFORMED:${marker}`);
    }
    cursor = end;
  }
  const unique = new Map(frames.map((frame) => [JSON.stringify(frame), frame]));
  return [...unique.values()];
}

function requireV8Receipt() {
  if (!existsSync(receipt)) {
    fail(`TN_PRD568_V8_PAYLOAD_MISSING:${receipt}; finish the existing V8 producer, then rerun`);
  }
  try {
    const value = JSON.parse(readFileSync(receipt, "utf8"));
    if (!value || typeof value !== "object" || typeof value.build?.version !== "string")
      fail(`TN_PRD568_V8_RECEIPT_INVALID:${receipt}`);
    return { path: receipt, version: value.build.version };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("TN_PRD568_")) throw error;
    fail(`TN_PRD568_V8_RECEIPT_INVALID:${receipt}`);
  }
}

function projectConfigFrom(moduleValue) {
  const config = moduleValue.default;
  if (!config || typeof config !== "object" || !config.assets) fail("TN_PRD568_CONFIG_INVALID: missing default.assets");
  return config;
}

async function loadProjectConfig() {
  if (!process.execArgv.some((entry) => entry === "tsx" || entry.endsWith("/tsx")))
    fail("TN_PRD568_TSX_REQUIRED: invoke with node --import tsx");
  return projectConfigFrom(await import(pathToFileURL(join(project, "threenative.config.ts")).href));
}

function instrumentBundleSource(source) {
  const plugin = [
    "  const prd568InstrumentationPlugin = {",
    "    name: 'threenative-prd568-instrumentation',",
    "    enforce: 'post',",
    "    transform(code, id) {",
    "      const sourceId = id.split('?')[0];",
    "      const replaceOnce = (text, needle, replacement, label) => {",
    "        if (!text.includes(needle)) throw new Error('TN_PRD568_INSTRUMENTATION_ANCHOR_MISSING:' + label);",
    "        return text.replace(needle, replacement);",
    "      };",
    "      if (sourceId.endsWith('/KTX2Loader.js')) {",
    "        let result = code;",
    "        result = replaceOnce(result, 'super( manager );', 'super( manager );\\n\\t\\tglobalThis.__TN_PRD568_INSTRUMENTED__ = true;', 'constructor');",
    "        result = replaceOnce(result, 'const worker = new Worker( this.workerSourceURL );', 'globalThis.__TN_PRD568_WORKERS__ = (globalThis.__TN_PRD568_WORKERS__ ?? 0) + 1;\\n\\t\\tconst worker = new Worker( this.workerSourceURL );', 'worker');",
    "        result = replaceOnce(result, 'const { type: messageType, error, data: { faces, width, height, format, type, dfdFlags } } = transcodeResult;', 'const { type: messageType, error, data: { faces, width, height, format, type, dfdFlags, __tnPrd568TranscodeCalls } } = transcodeResult;\\n\\t\\tglobalThis.__TN_PRD568_CALLS__ = (globalThis.__TN_PRD568_CALLS__ ?? 0) + (__tnPrd568TranscodeCalls ?? 0);', 'main-response');",
    "        result = replaceOnce(result, 'function transcode( buffer ) {', 'function transcode( buffer ) { let __tnPrd568TranscodeCalls = 0;', 'worker-transcode');",
    "        result = replaceOnce(result, 'const status = ktx2File.transcodeImage( dst, mip, layer, face, transcoderFormat, 0, - 1, - 1 );', 'const status = ktx2File.transcodeImage( dst, mip, layer, face, transcoderFormat, 0, - 1, - 1 ); __tnPrd568TranscodeCalls += 1;', 'transcode-call');",
    "        result = replaceOnce(result, \"self.postMessage( { type: 'transcode', id: message.id, data: { faces, width, height, hasAlpha, format, type, dfdFlags } }, buffers );\", \"self.postMessage( { type: 'transcode', id: message.id, data: { faces, width, height, hasAlpha, format, type, dfdFlags, __tnPrd568TranscodeCalls } }, buffers );\", 'worker-response');",
    "        return { code: result, map: null };",
    "      }",
    `      if (sourceId === ${JSON.stringify(sourceEntry)}) {`,
    "        const anchor = 'ctx.state.set({ loadedModels: this.#models.length, texturedMeshes, vertices, entries: entry });';",
    "        const marker = `${anchor}\\n    console.info(\"TN_PRD568_COUNTER:\" + JSON.stringify({ ready: true, armed: globalThis.__TN_PRD568_INSTRUMENTED__ === true, calls: globalThis.__TN_PRD568_CALLS__ ?? 0, workers: globalThis.__TN_PRD568_WORKERS__ ?? 0 }));`;",
    "        return { code: replaceOnce(code, anchor, marker, 'fixture-state'), map: null };",
    "      }",
    "      return null;",
    "    },",
    "  };",
  ].join("\n");
  const insertion = "  const mobileDecodersPlugin = {";
  if (!source.includes(insertion)) fail("TN_PRD568_BUNDLE_ANCHOR_MISSING:mobileDecodersPlugin");
  const withPlugin = source.replace(insertion, `${plugin}\n${insertion}`);
  const pluginList = ": [importMetaPlugin, mobileDecodersPlugin, nativeEntryPlugin],";
  if (!withPlugin.includes(pluginList)) fail("TN_PRD568_BUNDLE_ANCHOR_MISSING:plugin-list");
  return withPlugin.replace(pluginList, ": [importMetaPlugin, prd568InstrumentationPlugin, mobileDecodersPlugin, nativeEntryPlugin],");
}

function makeInstrumentedBundleScript(output) {
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, instrumentBundleSource(readFileSync(bundleSource, "utf8")), "utf8");
  return output;
}

async function generateFixture() {
  command(process.execPath, ["--import", "tsx", "-e", "const { generateNativeAssetFixture } = await import('./examples/abyss-framework/vq-assets/generate.ts'); await generateNativeAssetFixture('examples/abyss-framework/vq-assets/.generated/assets');"], { cwd: root, timeout: 120_000, inherit: true });
}

async function compileArm(config, output, platform, identity) {
  rmSync(output, { force: true, recursive: true });
  const { compileAssets } = await import(pathToFileURL(assetsPackage).href);
  await compileAssets({
    config: config.assets,
    cwd: project,
    output,
    platform,
    runtimeDecoders: { ktx2: true, meshopt: true, draco: false },
    runtimeIdentity: identity,
  });
  if (!existsSync(join(output, "manifest.json"))) fail(`TN_PRD568_ASSET_MANIFEST_MISSING:${output}`);
  return output;
}

function bundleArm(output, instrumented) {
  const script = instrumented ? makeInstrumentedBundleScript(join(dirname(output), "native-bundle.mjs")) : bundleSource;
  command(process.execPath, [script, "--project", project, "--entry", "src/game.ts", "--target", "android", "--output", output, "--native-backend", "--decoders", "ktx2,meshopt"], { timeout: 180_000, inherit: true });
  if (!existsSync(output)) fail(`TN_PRD568_BUNDLE_MISSING:${output}`);
  return output;
}

async function packageArm(config, bundle, assets, apk, abi) {
  const { packageAndroid } = await import(packageAndroidUrl);
  const previous = process.env.THREENATIVE_GRADLE_ARGS;
  process.env.THREENATIVE_GRADLE_ARGS = `-PthreenativeAbis=${abi} -PthreenativeJsEngine=v8`;
  try {
    await packageAndroid(bundle, apk, assets, undefined, config, {
      allowSourceBuild: true,
      format: "apk",
      mode: "debug",
      projectRoot: project,
      runtimeRoot,
    });
  } finally {
    if (previous === undefined) delete process.env.THREENATIVE_GRADLE_ARGS;
    else process.env.THREENATIVE_GRADLE_ARGS = previous;
  }
  if (!existsSync(apk)) fail(`TN_PRD568_APK_MISSING:${apk}`);
  return apk;
}

async function buildCurrentAstc(runRoot, abi) {
  const sourceApk = join(project, "dist-native/vq-native-assets.apk");
  const apk = join(runRoot, "apk", names.astcTiming);
  const previousRuntime = process.env.THREENATIVE_RUNTIME_SOURCE;
  const previousGradle = process.env.THREENATIVE_GRADLE_ARGS;
  process.env.THREENATIVE_RUNTIME_SOURCE = runtimeRoot;
  process.env.THREENATIVE_GRADLE_ARGS = `-PthreenativeAbis=${abi} -PthreenativeJsEngine=v8`;
  try {
    command(process.execPath, [threenativeCli, "build", "--target", "android", "--allow-source-build"], {
      cwd: project,
      timeout: 900_000,
      inherit: true,
    });
  } finally {
    if (previousRuntime === undefined) delete process.env.THREENATIVE_RUNTIME_SOURCE;
    else process.env.THREENATIVE_RUNTIME_SOURCE = previousRuntime;
    if (previousGradle === undefined) delete process.env.THREENATIVE_GRADLE_ARGS;
    else process.env.THREENATIVE_GRADLE_ARGS = previousGradle;
  }
  if (!existsSync(sourceApk)) fail(`TN_PRD568_CURRENT_ASTC_APK_MISSING:${sourceApk}`);
  mkdirSync(dirname(apk), { recursive: true });
  copyFileSync(sourceApk, apk);
  return { apk, sha256: sha256(apk), source: "threenative build --target android" };
}

async function buildArm(config, runRoot, label, platform, instrumented, abi) {
  const assets = join(runRoot, "assets", label);
  const bundle = join(runRoot, "bundles", `${label}.js`);
  const apk = join(runRoot, "apk", names[`${label}${instrumented ? "Coverage" : "Timing"}`]);
  await compileArm(config, assets, platform, `android:v8:${label}`);
  bundleArm(bundle, instrumented);
  await packageArm(config, bundle, assets, apk, abi);
  return { assets, bundle, apk, sha256: sha256(apk) };
}

function requireDevice(adbPath, serial) {
  if (!serial) fail("TN_PRD568_DEVICE_REQUIRED: pass --device SERIAL");
  adb(adbPath, serial, ["get-state"]);
  const qemu = adb(adbPath, serial, ["shell", "getprop", "ro.kernel.qemu"]).trim();
  return { serial, qemu: qemu || "unknown" };
}

function install(adbPath, serial, apk) {
  adb(adbPath, serial, ["install", "-r", "--no-streaming", apk], 60_000);
}

function runCoverage(adbPath, serial, apk, output, expected) {
  const artifactDirectory = join(output, "coverage", expected);
  rmSync(artifactDirectory, { force: true, recursive: true });
  install(adbPath, serial, apk);
  command(process.execPath, [
    runner,
    scenario,
    "--target", "android",
    "--device", serial,
    "--package", packageName,
    "--activity", activity,
    "--adb", adbPath,
    "--artifact", apk,
    "--timeout", "120000",
    "--artifacts", artifactDirectory,
  ], { timeout: 180_000, inherit: true });
  const consoleFile = join(artifactDirectory, "console.json");
  if (!existsSync(consoleFile)) fail(`TN_PRD568_COUNTER_OBSERVATION_MISSING:${consoleFile}`);
  const consoleText = readFileSync(consoleFile, "utf8");
  const counters = extractJsonMarkers(consoleText, "TN_PRD568_COUNTER:");
  if (counters.length !== 1) fail(`TN_PRD568_COUNTER_OBSERVATION_COUNT:${expected}:${counters.length}`);
  const counter = counters[0];
  if (counter.ready !== true || counter.armed !== true || !Number.isInteger(counter.calls) || !Number.isInteger(counter.workers))
    fail(`TN_PRD568_COUNTER_OBSERVATION_INVALID:${expected}`);
  const log = adb(adbPath, serial, ["logcat", "-d"], 30_000);
  if (!/JS engine created:\s*V8/u.test(log)) fail(`TN_PRD568_V8_MARKER_MISSING:coverage:${expected}`);
  if (log.includes("TN_ASSETS_ASTC_UNSUPPORTED")) fail(`TN_PRD568_ASTC_ADAPTER_REFUSED:coverage:${expected}`);
  const expectedCalls = expected === "astc" ? 0 : 6;
  const expectedWorkers = expected === "astc" ? 0 : 1;
  if (counter.calls !== expectedCalls || counter.workers !== expectedWorkers)
    fail(`TN_PRD568_COUNTER_EXPECTATION:${expected}:calls=${counter.calls},workers=${counter.workers}`);
  return { expected, counter, consoleFile };
}

function parseTiming(log, label) {
  if (!/JS engine created:\s*V8/u.test(log)) fail(`TN_PRD568_V8_MARKER_MISSING:${label}`);
  const frames = extractJsonMarkers(log, "TN_STALL_SEGMENTS:");
  if (frames.length !== 1) fail(`TN_PRD568_STALL_OBSERVATION_COUNT:${label}:${frames.length}`);
  const frame = frames[0];
  for (const field of ["toFirstFrameMs", "frameBeganAtMs", "gapMs", "attributedMs", "residualMs", "attributedShare"])
    if (!Number.isFinite(frame[field])) fail(`TN_PRD568_STALL_FIELD_MISSING:${label}:${field}`);
  if (!frame.segments || typeof frame.segments !== "object" || Object.keys(frame.segments).length === 0)
    fail(`TN_PRD568_STALL_SEGMENTS_MISSING:${label}`);
  for (const [name, value] of Object.entries(frame.segments)) {
    if (!value || !Number.isFinite(value.ms) || !Number.isInteger(value.calls)) fail(`TN_PRD568_STALL_SEGMENT_INVALID:${label}:${name}`);
  }
  return frame;
}

async function runTiming(adbPath, serial, apks, output) {
  const { breakdown, parseMarkers, SEGMENTS } = await import(coldStartUrl);
  const sequence = ["basis", "astc", "basis", "astc", "basis", "astc"];
  const results = [];
  for (let index = 0; index < sequence.length; index += 1) {
    const label = `${String(index + 1).padStart(2, "0")}-${sequence[index]}`;
    const apk = apks[sequence[index]];
    install(adbPath, serial, apk);
    adb(adbPath, serial, ["shell", "am", "force-stop", packageName]);
    adb(adbPath, serial, ["logcat", "-c"]);
    adb(adbPath, serial, ["shell", "am", "start", "-n", `${packageName}/${activity}`]);
    const deadline = Date.now() + 120_000;
    let log = "";
    while (Date.now() < deadline) {
      log = adb(adbPath, serial, ["logcat", "-d"], 30_000);
      if (log.includes("TN_STALL_SEGMENTS:")) break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
    if (!log.includes("TN_STALL_SEGMENTS:")) fail(`TN_PRD568_STALL_TIMEOUT:${label}`);
    const stall = parseTiming(log, label);
    const coldMarkers = parseMarkers(log);
    const cold = breakdown(coldMarkers, SEGMENTS);
    const logFile = join(output, "timing", `${label}.log`);
    mkdirSync(dirname(logFile), { recursive: true });
    writeFileSync(logFile, log, "utf8");
    results.push({ label, arm: sequence[index], logFile, toFirstFrameMs: stall.toFirstFrameMs, gapMs: stall.gapMs, coldStartMs: cold.totalMs });
    console.log(`TN_PRD568_TIMING:${label}:toFirstFrameMs=${stall.toFirstFrameMs.toFixed(3)}:gapMs=${stall.gapMs.toFixed(3)}`);
  }
  const pairs = [];
  for (let index = 0; index < 3; index += 1) {
    const basis = results[index * 2];
    const astc = results[index * 2 + 1];
    if (!(astc.toFirstFrameMs <= basis.toFirstFrameMs))
      fail(`TN_PRD568_AC2_TIMING_FAIL:pair=${index + 1}:basis=${basis.toFirstFrameMs}:astc=${astc.toFirstFrameMs}`);
    pairs.push({ pair: index + 1, basisMs: basis.toFirstFrameMs, astcMs: astc.toFirstFrameMs, pass: true });
  }
  const result = { sequence, results, pairs, qualified: true };
  writeJson(join(output, "timing", "comparison.json"), result);
  return result;
}

function printPlan(runRoot, mode, abi) {
  console.log(`TN_PRD568_PLAN_OUTPUT:${runRoot}`);
  console.log(`TN_PRD568_PLAN_V8_RECEIPT:${receipt}`);
  console.log(`TN_PRD568_PLAN_BUILD:compile android ASTC -> ${join(runRoot, "assets/astc")}`);
  console.log(`TN_PRD568_PLAN_BUILD:compile web Basis control -> ${join(runRoot, "assets/basis")}`);
  console.log(`TN_PRD568_PLAN_GRADLE:-PthreenativeAbis=${abi} -PthreenativeJsEngine=v8`);
  if (mode === "all" || mode === "timing") console.log("TN_PRD568_PLAN_CURRENT_ASTC:node packages/create-threenative/dist/threenative.js build --target android --allow-source-build");
  if (mode === "all" || mode === "coverage") console.log("TN_PRD568_PLAN_COVERAGE:astc, basis positive control; expected calls 0, 6");
  if (mode === "all" || mode === "timing") console.log("TN_PRD568_PLAN_TIMING:basis, astc, basis, astc, basis, astc; compare TN_STALL_SEGMENTS.toFirstFrameMs");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }
  if (options.selfCheck) {
    const generated = join(root, ".linchpin", "prd568-v8-ac2-selfcheck-bundle.mjs");
    try {
      writeFileSync(generated, instrumentBundleSource(readFileSync(bundleSource, "utf8")), "utf8");
      command(process.execPath, ["--check", generated]);
      console.log(`TN_PRD568_SELF_CHECK_OK:${generated}`);
    } finally {
      rmSync(generated, { force: true });
    }
    return;
  }
  const runRoot = resolve(options.output ?? join(root, ".linchpin", "prd568-ac2-v8", new Date().toISOString().replaceAll(/[:.]/gu, "-")));
  if (options.plan) {
    printPlan(runRoot, options.mode, "x86_64");
    return;
  }
  if (existsSync(runRoot) && !options.reuse) fail(`TN_PRD568_OUTPUT_EXISTS:${runRoot}; choose a new --output or pass --reuse`);
  mkdirSync(runRoot, { recursive: true });
  const adbPath = resolveAdb();
  const device = requireDevice(adbPath, options.device);
  const abi = "x86_64";
  const config = await loadProjectConfig();
  const metadata = { runRoot, mode: options.mode, device, abi, v8Receipt: options.reuse ? "reused APK" : requireV8Receipt() };
  writeJson(join(runRoot, "setup.json"), metadata);
  if (!options.reuse) await generateFixture();
  const coverage = {};
  const timing = {};
  if (options.mode === "all" || options.mode === "coverage") {
    const astc = options.reuse ? { apk: join(runRoot, "apk", names.astcCoverage) } : await buildArm(config, runRoot, "astc", "android", true, abi);
    const basis = options.reuse ? { apk: join(runRoot, "apk", names.basisCoverage) } : await buildArm(config, runRoot, "basis", "web", true, abi);
    if (!existsSync(astc.apk) || !existsSync(basis.apk)) fail(`TN_PRD568_COVERAGE_APK_MISSING:${runRoot}`);
    coverage.astc = runCoverage(adbPath, device.serial, astc.apk, runRoot, "astc");
    coverage.basis = runCoverage(adbPath, device.serial, basis.apk, runRoot, "basis");
    writeJson(join(runRoot, "coverage", "result.json"), coverage);
  }
  if (options.mode === "all" || options.mode === "timing") {
    const astc = options.reuse ? { apk: join(runRoot, "apk", names.astcTiming) } : await buildCurrentAstc(runRoot, abi);
    const basis = options.reuse ? { apk: join(runRoot, "apk", names.basisTiming) } : await buildArm(config, runRoot, "basis", "web", false, abi);
    if (!existsSync(astc.apk) || !existsSync(basis.apk)) fail(`TN_PRD568_TIMING_APK_MISSING:${runRoot}`);
    timing.result = await runTiming(adbPath, device.serial, { astc: astc.apk, basis: basis.apk }, runRoot);
  }
  writeJson(join(runRoot, "result.json"), { metadata, coverage, timing });
  console.log(`TN_PRD568_READY:${runRoot}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
