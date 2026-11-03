import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import {
  assertIosRuntime,
  bundleIsRegistered,
  selectIosSimulator,
} from '../scripts/select-ios-simulator.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/**
 * Shape of `xcrun simctl list devices available --json` on a GitHub `macos-15` runner. The
 * visionOS key sorts before the iOS key, which is how runs 31313092745 and 31434881982 both
 * captured a 2732x2048 "Apple Vision Pro" screenshot and reported no runtime at all.
 */
const RUNNER_LISTING = {
  devices: {
    'com.apple.CoreSimulator.SimRuntime.xrOS-2-5': [
      { isAvailable: true, name: 'Apple Vision Pro', state: 'Shutdown', udid: 'vision-udid' },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
      { isAvailable: true, name: 'iPad Pro 13-inch (M4)', state: 'Shutdown', udid: 'ipad-udid' },
      { isAvailable: true, name: 'iPhone 16 Pro', state: 'Shutdown', udid: 'iphone-udid' },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-11-5': [
      { isAvailable: true, name: 'Apple Watch Series 10', state: 'Shutdown', udid: 'watch-udid' },
    ],
  },
};

test('iOS simulator selection never substitutes a visionOS, watchOS, or tvOS device', () => {
  const selected = selectIosSimulator(RUNNER_LISTING);
  assert.equal(selected.udid, 'iphone-udid');
  assert.equal(selected.name, 'iPhone 16 Pro');
  assert.match(selected.runtime, /SimRuntime\.iOS-18-5$/u);

  // The pre-fix selector was `Object.values(devices).flat()[0]`; assert that shape is gone.
  const flattened = Object.values(RUNNER_LISTING.devices).flat()[0];
  assert.equal(flattened.name, 'Apple Vision Pro');
  assert.notEqual(selected.udid, flattened.udid);
});

test('iOS simulator selection prefers an already-booted iOS device', () => {
  const booted = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [
        { isAvailable: true, name: 'iPhone 16 Pro', state: 'Shutdown', udid: 'iphone-udid' },
        { isAvailable: true, name: 'iPad Pro 13-inch (M4)', state: 'Booted', udid: 'ipad-udid' },
      ],
    },
  };
  assert.equal(selectIosSimulator(booted).udid, 'ipad-udid');
});

test('iOS simulator selection fails closed when the host has no iOS runtime', () => {
  const visionOnly = { devices: { ...RUNNER_LISTING.devices } };
  delete visionOnly.devices['com.apple.CoreSimulator.SimRuntime.iOS-18-5'];
  assert.throws(() => selectIosSimulator(visionOnly), /TN_IOS_SIMULATOR_ABSENT/u);
  assert.throws(() => selectIosSimulator({}), /TN_IOS_SIMULATOR_ABSENT/u);
});

test('a non-iOS runtime cannot be recorded as iOS evidence', () => {
  assert.equal(
    assertIosRuntime('com.apple.CoreSimulator.SimRuntime.iOS-18-5'),
    'com.apple.CoreSimulator.SimRuntime.iOS-18-5',
  );
  assert.throws(
    () => assertIosRuntime('com.apple.CoreSimulator.SimRuntime.xrOS-2-5'),
    /TN_IOS_SIMULATOR_WRONG_RUNTIME/u,
  );
});

test('the verifier selects through the pinned iOS selector, not a flattened device list', () => {
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');
  assert.match(verifier, /selectIosSimulator\(parsed\)/u);
  assert.match(verifier, /assertIosRuntime\(selected\.runtime\)/u);
  assert.doesNotMatch(verifier, /Object\.values\(parsed\.devices/u);
});

test('iOS scaffold is root-linked to the exact shared core proof', () => {
  const cmake = readFileSync(join(root, 'CMakeLists.txt'), 'utf8');
  const main = readFileSync(join(root, 'ios/main.mm'), 'utf8');
  assert.match(cmake, /add_executable\(threenative-ios MACOSX_BUNDLE/u);
  assert.match(cmake, /examples\/native-smoke\/dist\/native-smoke\.js/u);
  assert.match(main, /TN_PLAYTEST_MAILBOX/u);
  assert.doesNotMatch(main, /WebView|WKWebView|React Native/u);
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');
  for (const scenario of [
    'device-smoke.playtest.json',
    'device-smoke-wrong-value.playtest.json',
    'device-smoke-misspelled.playtest.json',
    'device-smoke-network.playtest.json',
  ]) assert.match(verifier, new RegExp(scenario.replaceAll('.', '\\.')));
  for (const diagnostic of [
    'TN_PLAYTEST_VISIBILITY_FAILED',
    'TN_PLAYTEST_BRIDGE_MISSING',
    'TN_PLAYTEST_SCENARIO_INVALID',
    'TN_PLAYTEST_UNSUPPORTED_ON_TARGET',
  ]) assert.match(verifier, new RegExp(diagnostic));
  assert.match(verifier, /simctl', 'launch', '--terminate-running-process'/u);
  assert.match(verifier, /simulator-launch-failure\.log/u);
  assert.match(verifier, /FBSOpenApplicationServiceErrorDomain/u);
  assert.match(verifier, /eventMessage CONTAINS/u);
  assert.doesNotMatch(verifier, /simctl', 'terminate'/u);
  assert.match(verifier, /toISOString\(\)\.slice\(0, 19\)\.replace\('T', ' '\)/u);
  const jsc = readFileSync(join(root, 'src/js/jsc_engine.mm'), 'utf8');
  assert.match(jsc, /NSLog\(@"%s", output\.c_str\(\)\)/u);
});

test('Linux can validate the iOS lane without claiming simulator execution', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-ios-simulator.mjs', '--check'], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.checked, true);
  assert.equal(report.execution, false);
  assert.equal(report.threeVersion, '0.187.0');
});

test('JSC prototype installation uses the three-argument Xcode 16.4 API', () => {
  const jsc = readFileSync(join(root, 'src/js/jsc_engine.mm'), 'utf8');
  const setPrototypeOf = jsc.slice(
    jsc.indexOf('bool setPrototypeOf('),
    jsc.indexOf('// Raw Context Access'),
  );

  assert.match(
    setPrototypeOf,
    /JSObjectSetPrototype\(\s*context_,\s*static_cast<JSObjectRef>\(object\.ptr\),\s*prototype\.ptr[\s\S]*?JSValueMakeUndefined\(context_\)\s*\);/u,
  );
  assert.doesNotMatch(setPrototypeOf, /JSObjectSetPrototype\([\s\S]*?&exception\s*\);/u);
});

test('iOS executable verifier builds and exercises native physics fail closed', () => {
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');
  assert.match(verifier, /download-deps\.mjs', '--only', 'stb'/u);
  assert.doesNotMatch(verifier, /download-deps\.mjs', '--only', '(?:cgltf|draco)'/u);
  assert.match(verifier, /build-native-physics\.mjs', '--ios-simulator'/u);
  assert.match(verifier, /TN_ENABLE_NATIVE_PHYSICS=ON/u);
  for (const scenario of [
    'physics.playtest.json',
    'physics-wrong-height.playtest.json',
    'physics-mask.playtest.json',
  ]) {
    assert.match(verifier, new RegExp(scenario.replaceAll('.', '\\.')));
  }
  assert.match(verifier, /rebuildProof\('masked', true\)/u);
  assert.match(verifier, /rebuildProof\('wrong-gravity', true\)/u);
  assert.match(verifier, /TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED/u);
  assert.match(verifier, /TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED/u);
});

test('iOS proof refreshes the generated bundle after every incremental app rebuild', () => {
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');
  const rebuild = verifier.slice(
    verifier.indexOf('const rebuildApp ='),
    verifier.indexOf('const rebuildProof ='),
  );
  assert.match(rebuild, /const app = findApp\(buildRoot\);/u);
  assert.match(rebuild, /copyFileSync\(bundle, join\(app, 'native-smoke\.js'\)\);/u);
});

// The iOS leg failed on a launch, not a build: `simctl install` had put the app on disk and
// SpringBoard still answered FBSOpenApplicationErrorDomain code 4 ("NotFound"), because
// LaunchServices had not registered the bundle yet. The verifier now waits for registration, and
// this is the predicate it waits on.
test('bundle registration is read from the listapps key, not a substring', () => {
  const listapps = [
    '{',
    '    "dev.threenative.runtime" =     {',
    '        CFBundleName = "threenative-ios";',
    '    };',
    '}',
  ].join('\n');
  assert.equal(bundleIsRegistered(listapps, 'dev.threenative.runtime'), true);

  // Not yet registered: install has returned, the app is not in the list.
  assert.equal(bundleIsRegistered('{\n}', 'dev.threenative.runtime'), false);

  // A different app that merely names ours in its metadata must not read as registered — that
  // would launch into the same NotFound this check exists to prevent.
  const mentioned = [
    '{',
    '    "com.example.other" =     {',
    '        CFBundleName = "dev.threenative.runtime";',
    '    };',
    '}',
  ].join('\n');
  assert.equal(bundleIsRegistered(mentioned, 'dev.threenative.runtime'), false);
});

// Three files named the iOS bundle identifier and two of them disagreed: `ios/Info.plist` hardcoded
// `com.threenative.game` while CMake's XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER and the simulator
// verifier both said `dev.threenative.runtime`. A literal in the plist wins over the build setting,
// so the app installed under one identifier and the launch asked for the other — SpringBoard
// answered NotFound for a bundle that was sitting right there.
test('the iOS bundle identifier is declared once and read everywhere else', () => {
  const plist = readFileSync(join(root, 'ios/Info.plist'), 'utf8');
  const cmake = readFileSync(join(root, 'CMakeLists.txt'), 'utf8');
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');

  // The plist defers rather than repeating: Xcode substitutes the build setting at build time.
  assert.match(
    plist,
    /<key>CFBundleIdentifier<\/key>[\s\S]*?<string>\$\(PRODUCT_BUNDLE_IDENTIFIER\)<\/string>/u,
    'ios/Info.plist must take CFBundleIdentifier from $(PRODUCT_BUNDLE_IDENTIFIER)',
  );

  const declared = /XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER\s+"([^"]+)"/u.exec(cmake)?.[1];
  assert.ok(declared, 'CMakeLists.txt must declare XCODE_ATTRIBUTE_PRODUCT_BUNDLE_IDENTIFIER');

  const launched = /const bundleId = '([^']+)'/u.exec(verifier)?.[1];
  assert.equal(launched, declared, 'the verifier must launch the identifier CMake builds');
});

test('iOS native smoke requires a bounded worker proof with an explicit frame handshake', () => {
  const workerProof = readFileSync(
    join(root, '../../examples/native-smoke/src/worker-proof.ts'),
    'utf8',
  );
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');

  assert.match(workerProof, /const WORKER_ITERATIONS = 20_000_000;/u);
  assert.match(workerProof, /kind: "started"/u);
  assert.match(workerProof, /kind: "compute"/u);
  assert.match(workerProof, /frame - startedFrame >= WORKER_MINIMUM_FRAMES/u);
  assert.match(verifier, /'TN_NATIVE_WORKER_PROOF_PASS:'/u);
});

test('iOS launch retries once and records simulator process telemetry on timeout', () => {
  const verifier = readFileSync(join(root, 'scripts/verify-ios-simulator.mjs'), 'utf8');

  assert.match(verifier, /const SIMULATOR_LAUNCH_ATTEMPTS = 2;/u);
  assert.match(verifier, /simulator-launch-attempt-\$\{attempt\}\.log/u);
  assert.match(verifier, /simctl', 'spawn', device, 'ps'/u);
  assert.match(verifier, /simulator-process-timeout\.log/u);
  assert.match(verifier, /simulator-reboot-attempt-\$\{attempt\}\.log/u);
  assert.match(verifier, /simctl', 'shutdown', device/u);
  assert.match(verifier, /simctl', 'bootstatus', device, '-b'/u);
  assert.match(verifier, /attempt < SIMULATOR_LAUNCH_ATTEMPTS/u);
});
