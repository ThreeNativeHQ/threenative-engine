import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { PNG } from 'pngjs';

import {
  AUDIO_PROMISE_MARKER,
  EXPECTED_THREE_VERSION,
  assertNativeSmokeSource,
  catalogThreeVersion,
} from '../scripts/build-android-first-proof.mjs';

import {
  FIRST_FRAME_MARKER,
  FRAME_MARKER,
  READY_MARKER,
  REQUIRED_MARKERS,
  UNORDERED_REQUIRED_MARKERS,
  SUCCESS_MARKER,
  THREE_VERSION_MARKER,
  analyzeAppLog,
  assertEngine,
  assertPackagedAndroidBundle,
  captureLog,
  engineFromLog,
  filterAppLog,
  inspectScreenshot,
  prepareAndroidEmulator,
  javaMajorFromRelease,
  parseAdbDevices,
  parseArgs,
  selectDevice,
  verifyAndroidFirstProof,
} from '../scripts/verify-android-first-proof.mjs';

test('screenshot inspection rejects blank PNGs and accepts visible output', () => {
  const image = new PNG({ height: 1, width: 2 });
  image.data.set([0, 0, 0, 255, 68, 136, 255, 255]);
  assert.deepEqual(inspectScreenshot(PNG.sync.write(image)), { height: 1, width: 2 });
  image.data.set([0, 0, 0, 255, 0, 0, 0, 255]);
  assert.throws(() => inspectScreenshot(PNG.sync.write(image)), /screenshot is blank/);
});

test('asset builder fails closed on catalog drift and non-core smoke input', () => {
  assert.equal(catalogThreeVersion(`catalog:\n  three: ${EXPECTED_THREE_VERSION}\n`), '0.187.0');
  assert.throws(() => catalogThreeVersion('catalog:\n  vite: 8.2.0\n'), /no catalog Three/);
  assert.doesNotThrow(() =>
    assertNativeSmokeSource(
      `import { Scene, defineGame } from "@threenative/core";\n${FRAME_MARKER}\n${AUDIO_PROMISE_MARKER}\n`,
    ),
  );
  assert.throws(
    () =>
      assertNativeSmokeSource(
        `const Scene = true; const defineGame = true; ${FRAME_MARKER} ${AUDIO_PROMISE_MARKER}`,
      ),
    /public @threenative\/core/,
  );
});

test('packaged Android asset must match the generated bundle metadata', () => {
  const bundle = Buffer.from('current bundle');
  const outputSha256 = createHash('sha256').update(bundle).digest('hex');
  assert.doesNotThrow(() => assertPackagedAndroidBundle(bundle, { outputSha256 }));
  assert.throws(
    () => assertPackagedAndroidBundle(Buffer.from('stale bundle'), { outputSha256 }),
    /APK asset does not match/u,
  );
});

test('first proof prepares emulator before installation and launch', async () => {
  const calls = [];
  assert.deepEqual(prepareAndroidEmulator('emulator-5554', (...args) => calls.push(args)), { prepared: true }); assert.deepEqual(prepareAndroidEmulator('physical-device', (...args) => calls.push(args)), { prepared: false }); assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], ['shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed']);
  // A physical device keeps its error dialogs; only the emulator is told to swallow them, and
  // only because the launcher's ANR under software GL was failing every conformance row.
  assert.deepEqual(calls[1], ['shell', 'settings', 'put', 'global', 'hide_error_dialogs', '1']);
  // Suppressing future dialogs is not enough: the launcher ANRs while the emulator is still
  // booting, so the dialog is already up before this ever runs. Clear its state, then take down
  // whatever is on screen.
  assert.deepEqual(calls[2], ['shell', 'am', 'force-stop', 'com.android.launcher3']);
  assert.deepEqual(calls[3], ['shell', 'am', 'broadcast', '-a', 'android.intent.action.CLOSE_SYSTEM_DIALOGS']);
  assert.throws(() => parseArgs(['--timeout-ms', '999']), /at least 1000/); assert.throws(() => parseArgs(['--unknown']), /Unknown option/); calls.length = 0;
  const temporary = makeTempDirSync('threenative-android-proof-');
  const apk = join(temporary, 'app-debug.apk');
  const screenshot = new PNG({ height: 80, width: 80 });
  for (let index = 0; index < screenshot.data.length; index += 4) screenshot.data.set([255, 0, 255, 255], index); screenshot.data.set([0, 0, 0, 255], 0); writeFileSync(apk, 'test apk');
  const output = PNG.sync.write(screenshot);
  const log = `${THREE_VERSION_MARKER}\n${READY_MARKER}\n${FIRST_FRAME_MARKER}\n${FRAME_MARKER}\n${AUDIO_PROMISE_MARKER}\n08-08 12:00:01.000 4242 4242 I MystralRuntime: TN_PRESENTS_TICK:{"frames":60,"presents":60}\n`;
  const execute = (_command, args) => {
    calls.push(args);
    return args[0] === 'devices'
      ? { status: 0, stdout: 'List of devices attached\nemulator-5554 device\n' }
      : args.includes('pidof')
        ? { status: 0, stdout: '4242\n' }
        : args.includes('logcat') && args.includes('-d')
          ? { status: 0, stdout: log }
          : args.includes('exec-out')
            ? { status: 0, stdout: output }
            : args.includes('start')
              ? { status: 0, stdout: 'Status: ok\n' }
              : args.includes('install')
                ? { status: 0, stdout: 'Success\n' }
                : args.includes('settings') && args.includes('get')
                  // The install lane suppresses Play Protect before installing and reads the
                  // setting back; a device that supports the suppression answers '0'.
                  ? { status: 0, stdout: '0\n' }
                : args.includes('size')
                  ? { status: 0, stdout: 'Physical size: 1080x2400\n' }
                  : args.includes('density')
                    ? { status: 0, stdout: 'Physical density: 420\n' }
                    : { status: 0, stdout: '' };
  };
  const report = await verifyAndroidFirstProof(parseArgs(['--device', 'emulator-5554', '--apk', apk, '--skip-build', '--timeout-ms', '1000', '--settle-ms', '0', '--logcat', join(temporary, 'logcat.txt'), '--report', join(temporary, 'report.json'), '--screenshot', join(temporary, 'proof.png')]), { tools: { adb: 'fake-adb', javaHome: 'fake-java', sdkRoot: 'fake-sdk' }, run: execute, verifyAndroidBundle: () => ({ entry: 'test', outputSha256: 'test', publicApiPackage: '@threenative/core' }), verifyPackagedAndroidBundle: () => {}, delay: async () => {} });
  const preparation = calls.findIndex((args) => args.includes('immersive_mode_confirmations'));
  const installation = calls.findIndex((args) => args.includes('install'));
  const launch = calls.findIndex((args) => args.includes('start'));
  assert.ok(preparation >= 0 && preparation < installation && installation < launch); assert.deepEqual(report.devicePreparation, { prepared: true });
});

test('adb device parsing selects one online target and explains ambiguous states', () => {
  const devices = parseAdbDevices(`List of devices attached
emulator-5554 device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64
R5CT offline transport_id:2
AUTH unauthorized transport_id:3
`);

  assert.deepEqual(devices, [
    { serial: 'emulator-5554', state: 'device' },
    { serial: 'R5CT', state: 'offline' },
    { serial: 'AUTH', state: 'unauthorized' },
  ]);
  assert.equal(selectDevice(devices), 'emulator-5554');
  assert.throws(() => selectDevice(devices, 'AUTH'), /unauthorized/);
  assert.throws(
    () => selectDevice([...devices, { serial: 'phone-2', state: 'device' }]),
    /Multiple Android devices.*--device SERIAL/,
  );
});

test('clean log requires ordered catalog, ready, first-frame, and 300-frame markers', () => {
  const log = `08-08 12:00:00.000 123 124 I Mystral: renderer initialized
08-08 12:00:00.100 123 124 I Mystral: ${THREE_VERSION_MARKER}
08-08 12:00:00.200 123 124 I Mystral: ${READY_MARKER}
08-08 12:00:00.300 123 124 I Mystral: ${FIRST_FRAME_MARKER}
08-08 12:00:01.000 123 124 I MystralRuntime: TN_PRESENTS_TICK:{"frames":60,"presents":60}
08-08 12:00:05.300 123 124 I Mystral: ${FRAME_MARKER}
08-08 12:00:00.250 123 124 I Mystral: ${UNORDERED_REQUIRED_MARKERS[0]}
`;
  assert.deepEqual(analyzeAppLog(log), { markerFound: true, missingMarkers: [], failures: [] });
  assert.deepEqual(analyzeAppLog(SUCCESS_MARKER).missingMarkers, [
    ...REQUIRED_MARKERS.slice(0, 3),
    ...UNORDERED_REQUIRED_MARKERS,
  ]);
  assert.equal(
    analyzeAppLog([...[...REQUIRED_MARKERS].reverse(), ...UNORDERED_REQUIRED_MARKERS].join('\n'))
      .failures[0]?.kind,
    'marker-order',
  );
  // The audio marker is required but not order-checked: it is delivered on the microtask queue, so
  // its position relative to the frame markers is timing. Present anywhere satisfies it; absent
  // fails the run.
  assert.deepEqual(analyzeAppLog(REQUIRED_MARKERS.join('\n')).missingMarkers, UNORDERED_REQUIRED_MARKERS);
  assert.equal(
    analyzeAppLog([...UNORDERED_REQUIRED_MARKERS, ...REQUIRED_MARKERS].join('\n')).markerFound,
    true,
  );
});

test('the device lane rejects a log whose presents outrun its frames, and one with no tick', () => {
  const base = [...REQUIRED_MARKERS, ...UNORDERED_REQUIRED_MARKERS].join('\n');
  // The defect: the world pass and the overlay pass each acquiring and presenting an image of
  // their own, so only one of the two reached the display.
  const doubled = analyzeAppLog(`${base}\nTN_PRESENTS_TICK:{"frames":60,"presents":120}`);
  assert.equal(doubled.failures[0]?.kind, 'present-invariant');
  assert.match(doubled.failures[0].excerpt, /presented 120 times in 60 frames/u);
  // A device log carrying no tick at all is a failure, not a pass. Before this the device lane
  // asserted nothing about presents and reported green through the entire defect.
  const silent = analyzeAppLog(base, { requireTicks: true });
  assert.equal(silent.failures[0]?.kind, 'present-invariant');
  assert.match(silent.failures[0].excerpt, /expected at least 1 TN_PRESENTS_TICK/u);
  // While the gate is still waiting for markers the app may not have reached frame 60 yet, so a
  // log with no tick is not yet evidence of anything. Failing there rejects every healthy run.
  assert.deepEqual(analyzeAppLog(base).failures, []);
});

test('fatal signals, RangeError, and WebGPU failures reject an otherwise ready log', () => {
  const cases = [
    ['fatal-signal', 'F libc: Fatal signal 11 (SIGSEGV), code 1'],
    ['range-error', 'E Mystral: RangeError: Maximum call stack size exceeded'],
    ['javascript-error', 'E Mystral: Uncaught TypeError: canvas is undefined'],
    ['native-smoke-failure', 'E Mystral: TN_NATIVE_SMOKE_FAILED:adapter unavailable'],
    ['webgpu-error', 'E wgpu: Device validation error: invalid command buffer'],
    ['shader-error', 'E wgpu: Device::create_shader_module error: Shader parsing error'],
    ['first-proof-failure', '[ThreeNative Android] first proof failed: Error: adapter unavailable'],
    ['scene-failure', '[ThreeNative conformance] failed: Error: assertion exploded'],
  ];

  for (const [expectedKind, line] of cases) {
    const result = analyzeAppLog(
      `${[...REQUIRED_MARKERS, ...UNORDERED_REQUIRED_MARKERS].join('\n')}\n${line}\n`,
    );
    assert.equal(result.markerFound, true);
    assert.ok(result.failures.some(({ kind }) => kind === expectedKind), `${expectedKind} was not classified: ${line}`);
  }
});

test('a conformance scene failure logged through console.error rejects the row with its own message', () => {
  // Pinned to PRD-166's throw-probe run of 2026-08-22T14:27:13.005. The generated native entry
  // catches scene throws and prints this exact shape; the process then stays alive. Before the
  // scene-failure matcher existed, analyzeAppLog recognized nothing here, so the harness burned
  // its entire TN_ANDROID_TIMEOUT_MS window and recorded a generic timeout instead of the
  // failing assertion — an assertion that fails must report as itself.
  const log = [
    '08-22 14:27:12.784  7304  7323 I MystralJS: [info] TN_NATIVE_SMOKE_READY:webgpu',
    '08-22 14:27:13.002  7304  7323 I MystralJS: [info] TN_PRD166_TRACE:{"stage":"viewport-begin","index":1,"width":1024,"height":768}',
    '08-22 14:27:13.005  7304  7323 I MystralJS: [error] [ThreeNative conformance] failed: Error: TN_PRD166_PROBE_THROW: deliberate probe failure',
    '08-22 14:27:13.005  7304  7323 I MystralJS: [error]     at startScene (conformance/scenes/shared/camera-parented-overlay.js:54:17)',
  ].join('\n');

  const result = analyzeAppLog(log);
  const failure = result.failures.find(({ kind }) => kind === 'scene-failure');
  assert.ok(failure, 'the caught-and-logged scene failure was not classified');
  assert.match(failure.excerpt, /TN_PRD166_PROBE_THROW: deliberate probe failure/u);
});

test('log filtering keeps the target pid and drops unrelated RangeErrors', () => {
  const log = `08-08 12:00:00.000 999 999 E Other: RangeError: unrelated app
08-08 12:00:00.100 123 124 I Mystral: ${READY_MARKER}
08-08 12:00:00.200 123 124 E wgpu: validation error
`;
  const filtered = filterAppLog(log, '123');
  assert.doesNotMatch(filtered, /unrelated app/);
  assert.match(filtered, new RegExp(READY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(filtered, /wgpu: validation error/);
});

test('JDK release parser reports Java 17 from the current fixture path when present', () => {
  const knownJdk = '/usr/lib/jvm/java-17-openjdk';
  const major = javaMajorFromRelease(knownJdk);
  if (major !== null) assert.equal(major, 17);
  assert.equal(javaMajorFromRelease('/path/that/does/not/exist'), null);
});


const V8_LOG = 'I MystralRuntime: Loading asset: v8/arm64-v8a/snapshot_blob.bin\nI MystralRuntime: JS engine created: V8\n';
const QUICKJS_LOG = 'I MystralRuntime: JS engine created: QuickJS\n';

test('the engine comes from what the process reported, not from what was asked for', () => {
  assert.equal(engineFromLog(V8_LOG), 'V8');
  assert.equal(engineFromLog(QUICKJS_LOG), 'QuickJS');
  assert.equal(engineFromLog('I MystralRuntime: Script path: asset://scripts/main.js\n'), null);

  assert.deepEqual(assertEngine(V8_LOG, 'v8'), { engine: 'V8', expected: 'v8', matched: true });
  assert.deepEqual(assertEngine(QUICKJS_LOG, 'quickjs'), {
    engine: 'QuickJS', expected: 'quickjs', matched: true,
  });
});

test('a QuickJS build fails a run that asked for V8', () => {
  // The control the whole assertion exists for. PRD-118 section 2 records -DMYSTRAL_USE_V8=ON being
  // accepted, silently ignored and reported back as V8=OFF, so every measurement in between
  // described QuickJS. A parity gate whose two sides can be the same build measures nothing.
  assert.throws(() => assertEngine(QUICKJS_LOG, 'v8'), /asked for v8, the running process reported QuickJS/u);
  assert.throws(() => assertEngine(V8_LOG, 'quickjs'), /asked for quickjs, the running process reported V8/u);
});

test('a process that never reported an engine is distinct from one that reported the wrong one', () => {
  // Different causes: a crash before engine creation, against a build that shipped the wrong engine.
  assert.throws(() => assertEngine('I MystralRuntime: Script path: x\n', 'v8'), /never reported one/u);
});

test('asking for nothing still reads the engine, so every report can name it', () => {
  assert.deepEqual(assertEngine(V8_LOG, null), { engine: 'V8', expected: null, matched: true });
});

test('--expect-engine only accepts the two engines that exist', () => {
  assert.equal(parseArgs(['--expect-engine', 'V8']).expectEngine, 'v8');
  assert.equal(parseArgs(['--expect-engine', 'quickjs']).expectEngine, 'quickjs');
  assert.equal(parseArgs([]).expectEngine, null);
  assert.throws(() => parseArgs(['--expect-engine', 'jsc']), /must be v8 or quickjs/u);
});

test('a transient adb transport loss during log capture retries and keeps the log', () => {
  // CI run 36074506957: 74/74 conformance cases passed, then one logcat exit 255
  // (`adb: device offline` while the emulator was still settling) failed the whole lane. adb 255 is
  // a transport error, so a single drop must be re-tried after wait-for-device, not surfaced as a
  // game failure.
  const calls = [];
  let logcatAttempts = 0;
  const execute = (_command, args) => {
    calls.push(args);
    if (args.includes('logcat') && args.includes('-d')) {
      logcatAttempts += 1;
      if (logcatAttempts === 1) return { status: 255, stdout: '', stderr: 'adb: device offline' };
      return { status: 0, stdout: `${READY_MARKER}\n` };
    }
    return { status: 0, stdout: '' };
  };
  assert.equal(captureLog('fake-adb', 'emulator-5554', execute), `${READY_MARKER}\n`);
  assert.equal(logcatAttempts, 2);
  assert.equal(calls.filter((args) => args.includes('wait-for-device')).length, 1);
});

test('an unrecovered adb transport loss names itself, never the game', () => {
  let logcatAttempts = 0;
  const waits = [];
  const execute = (_command, args) => {
    if (args.includes('logcat') && args.includes('-d')) {
      logcatAttempts += 1;
      return { status: 255, stdout: '', stderr: 'adb: device offline' };
    }
    if (args.includes('wait-for-device')) waits.push(args);
    return { status: 0, stdout: '' };
  };
  assert.throws(
    () => captureLog('fake-adb', 'emulator-5554', execute),
    /TN_ANDROID_ADB_TRANSPORT_LOST.*emulator-5554.*device offline/s,
  );
  assert.equal(logcatAttempts, 3);
  assert.equal(waits.length, 2);
});
