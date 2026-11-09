#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { hasIosSceneManifestFields } from './package-ios.mjs';
import { judgeBundleMissing, judgePlainLaunch, judgePresentationCap, judgeWebUiLaunch } from './ios-webui-log.mjs';
import { assertIosRuntime, bundleIsRegistered, selectIosSimulator } from './select-ios-simulator.mjs';
// The same two assertions the desktop and Android gates run, from one source. A third copy would
// drift, and the copy that drifts is always the lane nobody runs by hand.
import { analyzePresentTicks, inspectOverlayBuffer } from './verify-desktop-core.mjs';

const runtimeRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = join(runtimeRoot, '..', '..');
const artifactRoot = join(runtimeRoot, 'artifacts', 'ios');
const buildRoot = join(runtimeRoot, 'build', 'tn-ios-simulator');
const bundle = join(workspaceRoot, 'examples', 'native-smoke', 'dist', 'native-smoke.js');
const nativeSmokeRoot = join(workspaceRoot, 'examples', 'native-smoke');
const bundleId = 'dev.threenative.runtime';
const checkOnly = process.argv.includes('--check');
const SIMULATOR_LAUNCH_ATTEMPTS = 2;
const SIMULATOR_LAUNCH_TIMEOUT_MS = 180_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: 'utf8',
    env: options.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.stdio,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/**
 * Keep every expectation's own output, not just the throw. A failing expectation used to raise one
 * Error carrying the whole report inline, and a playtest report is long enough that the Actions log
 * cut it off mid-`observations` — the run that mattered could not be read at all, and the artifact
 * held only a two-line console.json. The full stdout, stderr and, when the report parses, its
 * verdict now land under artifacts/ios/expectations/ where upload-artifact collects them.
 */
function recordExpectation(label, command, args, result, output) {
  const directory = join(artifactRoot, 'expectations');
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `${label}.txt`),
    [
      `command: ${command} ${args.join(' ')}`,
      `status: ${result.status}`,
      `signal: ${result.signal ?? 'none'}`,
      '---- stdout ----',
      result.stdout || '',
      '---- stderr ----',
      result.stderr || '',
    ].join('\n'),
  );
  // The verdict is what every expectation here is really asking about, and it is the first thing a
  // truncated log loses. Summarise it separately so it survives on its own.
  const start = output.indexOf('{');
  if (start < 0) return;
  try {
    const report = JSON.parse(output.slice(start, output.lastIndexOf('}') + 1));
    const failed = (report.assertionResults ?? []).filter((entry) => entry.pass !== true);
    writeFileSync(
      join(directory, `${label}.verdict.json`),
      `${JSON.stringify(
        {
          assertionIds: (report.assertionResults ?? []).map((entry) => entry.id),
          diagnostics: report.diagnostics ?? [],
          failedAssertions: failed,
          hasPassField: Object.hasOwn(report, 'pass'),
          pass: report.pass,
          runtime: report.runtime,
          target: report.target,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    writeFileSync(join(directory, `${label}.verdict.json`), '{"parsed":false}\n');
  }
}

function runExpected(command, args, expectedStatus, expectedText, label = 'expectation') {
  const result = spawnSync(command, args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  recordExpectation(label, command, args, result, output);
  if (result.error) throw result.error;
  if (result.status !== expectedStatus || !output.includes(expectedText)) {
    throw new Error(
      `Expected exit ${expectedStatus} containing ${expectedText}, got ${result.status}. ` +
        `Full output: artifacts/ios/expectations/${label}.txt, verdict: ${label}.verdict.json\n` +
        output.slice(0, 4_000),
    );
  }
  return { expectedStatus, expectedText };
}

function validateScaffold() {
  const required = ['ios/Info.plist', 'ios/main.mm', 'ios/ui_overlay_ios.mm', 'CMakeLists.txt'];
  for (const path of required) {
    if (!existsSync(join(runtimeRoot, path))) throw new Error(`iOS scaffold is missing ${path}.`);
  }
  const cmake = readFileSync(join(runtimeRoot, 'CMakeLists.txt'), 'utf8');
  const main = readFileSync(join(runtimeRoot, 'ios', 'main.mm'), 'utf8');
  const plist = readFileSync(join(runtimeRoot, 'ios', 'Info.plist'), 'utf8');
  if (!cmake.includes('add_executable(threenative-ios MACOSX_BUNDLE')) {
    throw new Error('CMake does not declare the root-linked threenative-ios app target.');
  }
  if (!cmake.includes('examples/native-smoke/dist/native-smoke.js')) {
    throw new Error('iOS app target is not linked to the shared native-smoke bundle.');
  }
  if (!main.includes('TN_PLAYTEST_MAILBOX') || !main.includes('native-smoke')) {
    throw new Error('iOS entry point is missing the shared proof or playtest mailbox.');
  }
  if (
    (!plist.includes('$(PRODUCT_BUNDLE_IDENTIFIER)') && !plist.includes('com.threenative.game')) ||
    !plist.includes('<string>metal</string>')
  ) {
    throw new Error('iOS Info.plist is missing its bundle identifier or Metal requirement.');
  }
  if (!hasIosSceneManifestFields(plist)) {
    throw new Error('iOS Info.plist is missing the TN3187 scene manifest (SDLUIKitSceneDelegate).');
  }
}

function validateThreeVersion() {
  const workspace = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
  const catalogMatch = workspace.match(/^\s*three:\s*['"]?([^'"\s]+)['"]?\s*$/mu);
  if (!catalogMatch?.[1]) throw new Error('pnpm-workspace.yaml has no catalog Three.js version.');
  const installedManifest = join(nativeSmokeRoot, 'node_modules', 'three', 'package.json');
  if (!existsSync(installedManifest)) {
    throw new Error('Native smoke Three.js dependency is missing. Run pnpm install --frozen-lockfile.');
  }
  const installed = JSON.parse(readFileSync(installedManifest, 'utf8')).version;
  if (installed !== catalogMatch[1]) {
    throw new Error(`iOS proof Three.js mismatch: catalog ${catalogMatch[1]}, installed ${installed}.`);
  }
  return installed;
}

function findApp(root) {
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (entry === 'threenative-ios.app') return path;
    if (statSync(path).isDirectory()) {
      const nested = findApp(path);
      if (nested) return nested;
    }
  }
  return undefined;
}

function chooseSimulator() {
  const parsed = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
  const selected = selectIosSimulator(parsed);
  assertIosRuntime(selected.runtime);
  if (selected.state !== 'Booted') run('xcrun', ['simctl', 'boot', selected.udid]);
  run('xcrun', ['simctl', 'bootstatus', selected.udid, '-b']);
  return selected;
}

function awaitBundleRegistration(device, identifier, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'never listed';
  for (;;) {
    const result = spawnSync('xcrun', ['simctl', 'listapps', device], { encoding: 'utf8' });
    if (result.status === 0 && bundleIsRegistered(result.stdout ?? '', identifier)) return;
    lastReason = (result.stderr ?? '').trim() || `${identifier} not listed`;
    if (Date.now() >= deadline) {
      throw new Error(
        `simctl never registered ${identifier} on ${device} within ${timeoutMs}ms: ${lastReason}`,
      );
    }
    sleep(1_000);
  }
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function unifiedLog(device, since) {
  return run('xcrun', [
    'simctl', 'spawn', device, 'log', 'show', '--style', 'compact', '--start', since,
    '--predicate', 'process == "threenative-ios"',
  ]);
}

function launchDiagnostics(device, since) {
  const predicate = [
    `process == "threenative-ios"`,
    `eventMessage CONTAINS "${bundleId}"`,
    `eventMessage CONTAINS "FBSOpenApplicationServiceErrorDomain"`,
  ].join(' OR ');
  const result = spawnSync('xcrun', [
    'simctl', 'spawn', device, 'log', 'show', '--style', 'compact', '--start', since,
    '--predicate', predicate,
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return `${result.stdout || ''}\n${result.stderr || ''}`.trim();
}

function simulatorDiagnostic(label, args, timeout = 15_000) {
  const result = spawnSync('xcrun', args, {
    cwd: workspaceRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  });
  return {
    status: result.status,
    text: [
      `---- ${label} ----`,
      `command: xcrun ${args.join(' ')}`,
      `status: ${result.status ?? 'not-started'}`,
      `signal: ${result.signal ?? 'none'}`,
      `error: ${result.error?.message ?? 'none'}`,
      'stdout:',
      result.stdout || '',
      'stderr:',
      result.stderr || '',
    ].join('\n'),
  };
}

function simulatorProcessTelemetry(device) {
  return [
    simulatorDiagnostic('installed apps', ['simctl', 'listapps', device]),
    simulatorDiagnostic('simulator processes', [
      'simctl', 'spawn', device, 'ps', '-A', '-o', 'pid,ppid,comm,args',
    ]),
    simulatorDiagnostic('launchd system', [
      'simctl', 'spawn', device, 'launchctl', 'print', 'system',
    ]),
    simulatorDiagnostic('launchd user', [
      'simctl', 'spawn', device, 'launchctl', 'print', 'user/501',
    ]),
  ].map((probe) => probe.text).join('\n');
}

function restartSimulator(device) {
  const steps = [
    simulatorDiagnostic('simulator shutdown', ['simctl', 'shutdown', device]),
    simulatorDiagnostic('simulator boot', ['simctl', 'boot', device]),
    simulatorDiagnostic('simulator bootstatus', ['simctl', 'bootstatus', device, '-b'], 120_000),
  ];
  return {
    ready: steps.at(-1).status === 0,
    text: steps.map((step) => step.text).join('\n'),
  };
}

function validateScreenshot(path) {
  const png = PNG.sync.read(readFileSync(path));
  let min = 255;
  let max = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const luminance = (png.data[index] + png.data[index + 1] + png.data[index + 2]) / 3;
    min = Math.min(min, luminance);
    max = Math.max(max, luminance);
  }
  if (png.width < 320 || png.height < 320 || max - min < 12) {
    throw new Error(`iOS simulator screenshot is blank or implausible (${png.width}x${png.height}, range ${max - min}).`);
  }
  return { height: png.height, luminanceRange: max - min, width: png.width };
}

validateScaffold();
const threeVersion = validateThreeVersion();
if (checkOnly) {
  run(process.execPath, ['scripts/build-native-physics.mjs', '--ios-simulator', '--check'], {
    cwd: runtimeRoot,
  });
  console.log(JSON.stringify({ checked: true, execution: false, reason: 'static scaffold validation only', threeVersion }));
  process.exit(0);
}
if (process.platform !== 'darwin') {
  throw new Error('iOS simulator execution requires macOS with Xcode; static validation is available with --check.');
}

run('pnpm', ['--filter', 'threenative-native-smoke', 'build']);
run('pnpm', ['--filter', '@threenative/playtest', 'build']);
run(process.execPath, ['scripts/download-deps.mjs', '--only', 'sdl3-ios'], { cwd: runtimeRoot });
run(process.execPath, ['scripts/download-deps.mjs', '--only', 'wgpu-ios'], { cwd: runtimeRoot });
run(process.execPath, ['scripts/download-deps.mjs', '--only', 'stb'], { cwd: runtimeRoot });
run(process.execPath, ['scripts/build-native-physics.mjs', '--ios-simulator'], { cwd: runtimeRoot });
run('cmake', [
  '-S', runtimeRoot,
  '-B', buildRoot,
  '-G', 'Xcode',
  `-DCMAKE_TOOLCHAIN_FILE=${join(runtimeRoot, 'cmake', 'ios.toolchain.cmake')}`,
  '-DPLATFORM=SIMULATORARM64',
  '-DCMAKE_OSX_ARCHITECTURES=arm64',
  '-DTN_ENABLE_CANVAS2D=OFF',
  '-DTN_ENABLE_VIDEO=OFF',
  '-DTN_ENABLE_RAYTRACING=OFF',
  '-DTN_ENABLE_WEBTRANSPORT=OFF',
  '-DTN_ENABLE_NATIVE_GLTF=OFF',
  '-DTN_ENABLE_NATIVE_PHYSICS=ON',
  '-DCMAKE_XCODE_ATTRIBUTE_CODE_SIGNING_ALLOWED=NO',
]);
const rebuildApp = () => {
  run('cmake', ['--build', buildRoot, '--config', 'Release', '--target', 'threenative-ios', '--parallel'], {
    stdio: 'inherit',
  });
  const app = findApp(buildRoot);
  if (!app) throw new Error('CMake succeeded but threenative-ios.app was not produced.');
  // Xcode's resource phase does not reliably recopy a generated source file when this same
  // project is rebuilt for the next proof variant. Synchronize the resource after every build so
  // each playtest executes the exact bundle just built by Vite.
  copyFileSync(bundle, join(app, 'native-smoke.js'));
};
const rebuildProof = (control, physics) => {
  run('pnpm', ['--filter', 'threenative-native-smoke', 'build'], {
    env: {
      ...process.env,
      THREENATIVE_PHYSICS_CONTROL: control,
      THREENATIVE_PHYSICS_PROOF: physics ? 'enabled' : 'disabled',
    },
  });
  rebuildApp();
};
rebuildApp();
const app = findApp(buildRoot);
if (!app) throw new Error('CMake succeeded but threenative-ios.app was not produced.');
if (!existsSync(join(app, 'native-smoke.js'))) throw new Error('Built iOS app omitted native-smoke.js.');

mkdirSync(artifactRoot, { recursive: true });
const simulator = chooseSimulator();
run('xcrun', ['simctl', 'install', simulator.udid, app]);
// `simctl install` returns once the bundle is on disk, which is before LaunchServices has
// registered it. Launching inside that window fails with FBSOpenApplicationErrorDomain code 4,
// "NotFound" — SpringBoard reporting that its application info provider returned nil for a bundle
// that is sitting right there. Wait for the registration itself rather than for a fixed delay,
// which would be a guess about a machine's speed.
awaitBundleRegistration(simulator.udid, bundleId);

const requiredMarkers = [
  'TN_NATIVE_SMOKE_READY:webgpu',
  'TN_NATIVE_SMOKE_FIRST_FRAME',
  'TN_NATIVE_SMOKE_300_FRAMES:300',
];

function captureSimulatorLaunch(device, markers) {
  return new Promise((resolve) => {
    const child = spawn(
      'xcrun',
      ['simctl', 'launch', '--terminate-running-process', '--console-pipe', device, bundleId],
      { cwd: workspaceRoot },
    );
    let output = '';
    let settled = false;
    // Declared before `finish` so it can clear it, and assigned once — the timer is the backstop
    // for an app that never prints its last marker.
    const deadline = setTimeout(() => finish(null, undefined), SIMULATOR_LAUNCH_TIMEOUT_MS);
    function finish(status, error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.kill('SIGKILL');
      resolve({ error, output, status });
    }
    const read = (chunk) => {
      output += String(chunk);
      if (markers.every((marker) => output.includes(marker))) finish(0, undefined);
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code, undefined));
  });
}

// Read the app's stdout, not the unified log.
//
// The runtime writes these markers with `std::cout`. `log show` carries os_log records, and a
// simulator app's stdout is not one — so polling it for 90s was reading a stream the markers were
// never in, and reported "missed markers" for an app that was running correctly. The broader log
// showed the app becoming active, creating its SDL view controller, and then going silent, with no
// `[Mystral]` line anywhere: not a hang, an instrument pointed at the wrong place.
//
// `--console-pipe` attaches stdout and stderr to this process. Stream it rather than waiting for
// it to finish: the smoke app keeps running after its 300th frame, so the proof is complete the
// moment the last marker appears. A second bounded launch handles the intermittent simulator
// state where SpringBoard accepts the request but no app process or console pipe appears.
let launched;
let startedAt = '';
let logs = '';
let missingMarkers = requiredMarkers;
let processTelemetry = '';
const launchAttempts = [];
for (let attempt = 1; attempt <= SIMULATOR_LAUNCH_ATTEMPTS; attempt += 1) {
  startedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');
  launched = await captureSimulatorLaunch(simulator.udid, requiredMarkers);
  if (launched.error) {
    const diagnostics = `${launchDiagnostics(simulator.udid, startedAt)}\n\n${simulatorProcessTelemetry(simulator.udid)}`;
    writeFileSync(join(artifactRoot, 'simulator-launch-failure.log'), diagnostics);
    throw new Error(`${launched.error.message}\n\niOS launch diagnostics:\n${diagnostics}`);
  }

  const consoleOutput = launched.output;
  writeFileSync(join(artifactRoot, `simulator-launch-attempt-${attempt}.log`), consoleOutput);
  // The unified log stays as the second source: it holds crash reports and system-side refusals
  // that stdout cannot show.
  logs = `${consoleOutput}\n${unifiedLog(simulator.udid, startedAt)}`;
  missingMarkers = requiredMarkers.filter((marker) => !logs.includes(marker));
  processTelemetry = missingMarkers.length > 0 ? simulatorProcessTelemetry(simulator.udid) : '';
  if (processTelemetry) {
    writeFileSync(join(artifactRoot, `simulator-process-timeout-attempt-${attempt}.log`), processTelemetry);
    writeFileSync(join(artifactRoot, 'simulator-process-timeout.log'), processTelemetry);
  }
  const attemptRecord = {
    attempt,
    consoleBytes: consoleOutput.length,
    exit: launched.status ?? launched.error?.code ?? null,
    missingMarkers,
    startedAt,
  };
  launchAttempts.push(attemptRecord);
  writeFileSync(
    join(artifactRoot, 'simulator-launch-attempts.json'),
    `${JSON.stringify({ attempts: launchAttempts, maxAttempts: SIMULATOR_LAUNCH_ATTEMPTS }, null, 2)}\n`,
  );
  if (missingMarkers.length === 0) break;
  if (attempt < SIMULATOR_LAUNCH_ATTEMPTS) {
    const reboot = restartSimulator(simulator.udid);
    attemptRecord.rebootReady = reboot.ready;
    writeFileSync(join(artifactRoot, `simulator-reboot-attempt-${attempt}.log`), reboot.text);
    writeFileSync(
      join(artifactRoot, 'simulator-launch-attempts.json'),
      `${JSON.stringify({ attempts: launchAttempts, maxAttempts: SIMULATOR_LAUNCH_ATTEMPTS }, null, 2)}\n`,
    );
    if (!reboot.ready) {
      throw new Error(
        `iOS simulator reboot did not reach bootstatus before launch attempt ${attempt + 1}; ` +
          'inspect artifacts/ios/simulator-reboot-attempt-1.log.',
      );
    }
    awaitBundleRegistration(simulator.udid, bundleId);
    console.log(
      `TN_IOS_SIMULATOR_REBOOT:${JSON.stringify({ attempt, nextAttempt: attempt + 1, ready: reboot.ready })}`,
    );
    console.log(
      `TN_IOS_SIMULATOR_LAUNCH_RETRY:${JSON.stringify({ attempt, missingMarkers, nextAttempt: attempt + 1 })}`,
    );
  }
}

const consoleOutput = launched.output;
// Killing `xcrun` ends the pipe, not the app, which keeps running in the simulator. The next launch
// clears it with `--terminate-running-process`, which is why that flag is there.
writeFileSync(join(artifactRoot, 'simulator-console.log'), consoleOutput);

if (missingMarkers.length > 0) {
  // A missing marker covers a startup crash, a runtime that never reached its first frame, and a
  // simulator that accepted the launch without creating an app process. Keep all three probes in
  // the artifact so the next fix is based on the machine's state, not a guess.
  const broad = spawnSync(
    'xcrun',
    [
      'simctl', 'spawn', simulator.udid, 'log', 'show', '--style', 'compact', '--start', startedAt,
      '--predicate',
      `process == "threenative-ios" OR senderImagePath CONTAINS "threenative-ios" OR eventMessage CONTAINS "${bundleId}"`,
    ],
    { cwd: workspaceRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const broadLog = `${broad.stdout ?? ''}${broad.stderr ?? ''}`;
  writeFileSync(
    join(artifactRoot, 'simulator-marker-timeout.log'),
    `${logs}\n---- broad ----\n${broadLog}\n---- process telemetry ----\n${processTelemetry}`,
  );
  const tail = broadLog.split('\n').slice(-60).join('\n');
  throw new Error(
    `iOS proof missed markers after ${launchAttempts.length} launch attempts: ${missingMarkers.join(', ')}\n` +
      `App console was ${consoleOutput.length} bytes (exit ${launched.status ?? launched.error?.code}); ` +
      `the broader system log tail follows.\n${tail}`,
  );
}
if (!logs.includes('TN_NATIVE_WORKER_PROOF_PASS:')) {
  throw new Error(
    'iOS native worker proof did not pass: expected TN_NATIVE_WORKER_PROOF_PASS; ' +
      'inspect artifacts/ios/simulator-console.log for the worker phase marker or failure.',
  );
}
if (/GPUValidationError|Validation Error|TN_IOS_PROOF_FAILED|TypeError|ReferenceError|FATAL/u.test(logs)) {
  throw new Error('iOS unified logs contain a native, JavaScript, or WebGPU failure.');
}
// The plain smoke app renders natively. A web view in it would mean the shell created one on its own.
{
  const webViewFailures = judgePlainLaunch(logs);
  if (webViewFailures.length > 0) throw new Error(`iOS plain launch: ${webViewFailures.join('; ')}`);
}
// One present per frame. The app has reported 300 frames by now, so the runtime has emitted five
// ticks; a log with none means nothing measured the invariant, which is a failure and not a pass.
const presentTicks = analyzePresentTicks(logs, { minTicks: 1 });
if (presentTicks.failures.length > 0) {
  throw new Error(`iOS present invariant failed:\n${presentTicks.failures.join('\n')}`);
}

const screenshot = join(artifactRoot, 'simulator-core.png');
run('xcrun', ['simctl', 'io', simulator.udid, 'screenshot', screenshot]);
const image = validateScreenshot(screenshot);
// The blank/luminance check above passes on a half-drawn frame. This looks for the canvas-layer
// overlay's own colour, which nothing in the smoke world draws.
const overlay = inspectOverlayBuffer(readFileSync(screenshot), { label: screenshot });
writeFileSync(join(artifactRoot, 'simulator.log'), logs);
const playtestCli = join(workspaceRoot, 'packages', 'playtest', 'dist', 'runner', 'cli.js');
const scenarioRoot = join(workspaceRoot, 'examples', 'native-smoke', 'playtests');
const playtestArgs = (scenario, artifactName) => [
  playtestCli,
  join(scenarioRoot, scenario),
  '--target', 'ios',
  '--app', app,
  '--bundle-id', bundleId,
  '--device', simulator.udid,
  '--artifacts', join(artifactRoot, artifactName),
  '--timeout', '30000',
];
const devicePlaytest = {
  pass: runExpected(process.execPath, playtestArgs('device-smoke.playtest.json', 'playtest-pass'), 0, '"pass": true', 'device-smoke-pass'),
  wrongValue: runExpected(process.execPath, playtestArgs('device-smoke-wrong-value.playtest.json', 'playtest-wrong'), 1, 'TN_PLAYTEST_VISIBILITY_FAILED', 'device-smoke-wrong-value'),
  misspelled: runExpected(process.execPath, playtestArgs('device-smoke-misspelled.playtest.json', 'playtest-misspelled'), 2, 'TN_PLAYTEST_SCENARIO_INVALID', 'device-smoke-misspelled'),
  unsupportedNetwork: runExpected(process.execPath, playtestArgs('device-smoke-network.playtest.json', 'playtest-network'), 2, 'TN_PLAYTEST_UNSUPPORTED_ON_TARGET', 'device-smoke-network'),
};
try {
  run('pnpm', ['--filter', 'threenative-native-smoke', 'build'], {
    env: { ...process.env, THREENATIVE_PLAYTEST_BRIDGE: 'disabled' },
  });
  rebuildApp();
  devicePlaytest.missingBridge = runExpected(
    process.execPath,
    playtestArgs('device-smoke.playtest.json', 'playtest-missing-bridge'),
    2,
    'TN_PLAYTEST_BRIDGE_MISSING',
  );
} finally {
  rebuildProof('normal', false);
}
const nativePhysics = {};
try {
  rebuildProof('normal', true);
  nativePhysics.pass = runExpected(
    process.execPath,
    playtestArgs('physics.playtest.json', 'physics-pass'),
    0,
    '"pass": true',
  );
  nativePhysics.wrongHeight = runExpected(
    process.execPath,
    playtestArgs('physics-wrong-height.playtest.json', 'physics-wrong-height'),
    1,
    'TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED',
  );
  nativePhysics.maskAgainstNormal = runExpected(
    process.execPath,
    playtestArgs('physics-mask.playtest.json', 'physics-mask-normal'),
    1,
    'TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED',
  );

  rebuildProof('masked', true);
  nativePhysics.masked = runExpected(
    process.execPath,
    playtestArgs('physics-mask.playtest.json', 'physics-mask-pass'),
    0,
    '"pass": true',
  );

  rebuildProof('wrong-gravity', true);
  nativePhysics.wrongGravity = runExpected(
    process.execPath,
    playtestArgs('physics.playtest.json', 'physics-wrong-gravity'),
    1,
    'TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED',
  );
} finally {
  rebuildProof('normal', false);
}
// Variants of the built app (PRD-842). Each runs on a copy under artifacts/, so the app that the
// workflow zips and publishes keeps the Info.plist and files it was built with. They replace text
// tests that matched `ios/main.mm` and `ios/ui_overlay_ios.mm` and could not say whether the host
// worked: a launch is the only thing that can.
const variantRoot = join(artifactRoot, 'variant');
const variantApp = join(variantRoot, 'threenative-ios.app');

async function stageUiPage(destination) {
  const smokeUi = join(nativeSmokeRoot, 'ui');
  rmSync(destination, { force: true, recursive: true });
  mkdirSync(destination, { recursive: true });
  const { build: esbuild } = await import('esbuild');
  await esbuild({
    bundle: true,
    entryPoints: [join(smokeUi, 'main.ts')],
    format: 'esm',
    logLevel: 'silent',
    outfile: join(destination, 'main.js'),
    target: 'es2022',
  });
  // The packager's Vite output marks module scripts `crossorigin`, which makes WebKit ask the scheme
  // handler for the CORS header. The staged page does the same, so a missing header fails the run.
  const page = readFileSync(join(smokeUi, 'index.html'), 'utf8');
  writeFileSync(
    join(destination, 'index.html'),
    page.replace('<script type="module"', '<script type="module" crossorigin'),
  );
}

async function runVariant(label, plistEdits, { judge, markers, ui }) {
  rmSync(variantRoot, { force: true, recursive: true });
  mkdirSync(variantRoot, { recursive: true });
  cpSync(app, variantApp, { recursive: true });
  for (const [key, flag, value] of plistEdits) {
    run('plutil', ['-replace', key, flag, String(value), join(variantApp, 'Info.plist')]);
  }
  if (ui) await stageUiPage(join(variantApp, 'ui'));
  // Installing over the previous variant kept its staged `ui/` (run 42648487428: the
  // missing-bundle launch loaded the web-ui page), so each variant starts from no install.
  run('xcrun', ['simctl', 'uninstall', simulator.udid, bundleId]);
  run('xcrun', ['simctl', 'install', simulator.udid, variantApp]);
  awaitBundleRegistration(simulator.udid, bundleId);
  const since = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const launched = await captureSimulatorLaunch(simulator.udid, markers);
  if (launched.error) throw launched.error;
  // NSLog lines reach the unified log shortly after the app writes them: read until the judge is
  // satisfied, and fail with the whole log when it is not.
  let text = '';
  let failures = [];
  const deadline = Date.now() + 45_000;
  for (;;) {
    text = `${launched.output}\n${unifiedLog(simulator.udid, since)}`;
    failures = judge(text);
    if (failures.length === 0 || Date.now() > deadline) break;
    sleep(3_000);
  }
  writeFileSync(join(artifactRoot, `variant-${label}.log`), text);
  if (failures.length > 0) {
    throw new Error(`iOS ${label} launch failed:\n- ${failures.join('\n- ')}\nFull log: artifacts/ios/variant-${label}.log`);
  }
  return { label, pass: true };
}

const hostVariants = {};
try {
  // `TNMaxFps` is what `ios/main.mm` reads into the presentation cap.
  hostVariants.maxFps30 = await runVariant('max-fps-30', [['TNMaxFps', '-integer', 30]], {
    judge: (text) => judgePresentationCap(text, 30),
    markers: ['TN_NATIVE_SMOKE_300_FRAMES:300'],
  });
  // The WebUI host: attach before the game evaluates, load, page module, first state, layout.
  hostVariants.webUi = await runVariant('web-ui', [['TNUIRenderer', '-string', 'web']], {
    judge: judgeWebUiLaunch,
    markers: ['TN_NATIVE_SMOKE_300_FRAMES:300'],
    ui: true,
  });
  // A web renderer with no page must refuse by name before the game runs.
  hostVariants.webUiMissingBundle = await runVariant('web-ui-missing-bundle', [['TNUIRenderer', '-string', 'web']], {
    judge: judgeBundleMissing,
    markers: ['TN_UI_BUNDLE_MISSING'],
  });
} finally {
  rmSync(variantRoot, { force: true, recursive: true });
}
const report = {
  app: relative(workspaceRoot, app),
  bundle: {
    bytes: statSync(bundle).size,
    sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
  },
  completedAt: new Date().toISOString(),
  devicePlaytest,
  hostVariants,
  markers: requiredMarkers,
  pass: true,
  nativePhysics,
  threeVersion,
  presents: {
    lastFrames: presentTicks.ticks.at(-1)?.frames ?? null,
    lastPresents: presentTicks.ticks.at(-1)?.presents ?? null,
    ticks: presentTicks.ticks.length,
  },
  screenshot: {
    ...image,
    ...overlay,
    path: relative(workspaceRoot, screenshot),
    sha256: createHash('sha256').update(readFileSync(screenshot)).digest('hex'),
  },
  simulator: { name: simulator.name, runtime: simulator.runtime, udid: simulator.udid },
};
writeFileSync(join(artifactRoot, 'simulator-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
