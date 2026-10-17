import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, test } from 'vitest';
import { PNG } from 'pngjs';

import {
  PRODUCTION_EVIDENCE_VERSION,
  ProductionEvidenceError,
  evaluateFrameBudget,
  evaluateProductionEvidence,
  meanFps,
  unmeasurableIntervalCount,
  nearestRank,
  sha256,
  writeProductionEvidence,
} from '../scripts/production-evidence.mjs';
import {
  aggregateMetrics,
  desktopFailureRun,
  assembleEvidence,
  failureSuffix,
  isSuccessfulStartupSample,
  installNativeProfileEntry,
  nativeArtifactPath,
  nativeFrameInstrumentation,
  normalizeRun,
  parseProductionArgs,
  playtestTimeoutMs,
  prepareNativeWorkload,
  collectionLaunchPlan,
  profileConfigPath,
  postWarmupFrameSamples,
  rendererResolutionScaleSetting,
  runProductionProfile,
  runCommand,
  safeReport,
  pinThreejsDesktopHost,
  setNativeProfileEntry,
  webFrameInstrumentation,
  webRateDisplayFault,
  webRateIdentity,
  writeRunScenarios,
} from '../scripts/profile-production.mjs';
import { parseStandalonePlaytestArgs } from '../../playtest/src/runner/config.js';
import { isJudgeMarkerRequestFailure } from '../../playtest/src/runner/runner-support.js';

const temporary = [];
const sourceSha = 'a'.repeat(64);
const artifactSha = sha256(Buffer.from('fixture-artifact'));

// `vm.runInNewContext` has no module system, so a slice that carries a neighbouring helper's
// `export` keyword would throw before the code under test ever runs.
function sliceSource(source, start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end)).replace(/^export /gmu, '');
}

test('desktop runner exceptions retain failed evidence rather than disappearing', () => {
  const error = new Error('TN_PLAYTEST_OPERATION_TIMEOUT: advance');
  const output = [{ text: 'native bridge connected', type: 'log' }];
  const run = desktopFailureRun(error, output, 123);
  assert.equal(run.status, 2);
  assert.equal(run.report.pass, false);
  assert.equal(run.report.diagnostics[0].message, error.message);
  assert.deepEqual(run.report.observations.console, output);
  assert.equal(run.series, undefined);
  const unsafe = desktopFailureRun(error, [{ text: '/home/operator/private/build', type: 'log' }], 123);
  assert.equal(JSON.stringify(unsafe.report).includes('/home/'), false);
  assert.match(unsafe.report.observations.console[0].text, /TN_PROD_REDACTION/u);
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  assert.match(source, /return desktopFailureRun\(error, await driver.captureConsole\(\),/u);
});

test('desktop cleanup tolerates a child process group that already exited', async () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const driverSource = sliceSource(source, 'function createDesktopDriver(', 'export async function installNativeProfileEntry(');
  const context = {
    join,
    process: {
      env: { DISPLAY: ':fixture' },
      kill: () => {
        const error = new Error('process group already exited');
        error.code = 'ESRCH';
        throw error;
      },
      platform: 'linux',
    },
    spawn: () => {
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.pid = 123;
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    writeFile: async () => undefined,
    rename: async () => undefined,
    nonBlankPng: async () => true,
    DESKTOP_SCREENSHOT_TIMEOUT_MS: 100,
    clearTimeout,
    setTimeout,
  };
  runInNewContext(driverSource, context);
  const driver = context.createDesktopDriver('/fixture/mystral', '/fixture/scaffold', { renderSize: { height: 900, width: 1600 } }, '/fixture/mailbox');
  await driver.launch();
  await assert.doesNotReject(() => driver.stop());
});

test('desktop cleanup observes a Windows child that exits synchronously when killed', async () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const driverSource = sliceSource(source, 'function createDesktopDriver(', 'export async function installNativeProfileEntry(');
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 123;
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  const context = {
    join,
    process: { env: {}, platform: 'win32' },
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    writeFile: async () => undefined,
    rename: async () => undefined,
    nonBlankPng: async () => true,
    DESKTOP_SCREENSHOT_TIMEOUT_MS: 100,
    clearTimeout,
    setTimeout,
  };
  runInNewContext(driverSource, context);
  const driver = context.createDesktopDriver('/fixture/mystral.exe', '/fixture/scaffold', { renderSize: { height: 900, width: 1600 } }, '/fixture/mailbox');
  await driver.launch();
  await assert.doesNotReject(() => Promise.race([
    driver.stop(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('desktop stop timed out')), 100)),
  ]));
});

test('desktop cleanup does not wait forever when a Windows kill emits no exit event', async () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const driverSource = sliceSource(source, 'function createDesktopDriver(', 'export async function installNativeProfileEntry(');
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 123;
  child.kill = () => undefined;
  const context = {
    join,
    process: { env: {}, platform: 'win32' },
    spawn: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    writeFile: async () => undefined,
    rename: async () => undefined,
    nonBlankPng: async () => true,
    DESKTOP_SCREENSHOT_TIMEOUT_MS: 100,
    clearTimeout,
    setTimeout,
  };
  runInNewContext(driverSource, context);
  const driver = context.createDesktopDriver('/fixture/mystral.exe', '/fixture/scaffold', {
    desktopCleanupTimeoutMs: 25,
    renderSize: { height: 900, width: 1600 },
  }, '/fixture/mailbox');
  await driver.launch();
  await assert.rejects(driver.stop(), (error) => {
    assert.equal(error.diagnostic.code, 'TN_PROD_DESKTOP_CLEANUP_TIMEOUT');
    assert.equal(error.diagnostic.phase, 'desktop-stop');
    assert.equal(error.diagnostic.processState, 'alive');
    assert.equal(error.diagnostic.observedAlive, true);
    assert.equal(error.diagnostic.observedExited, false);
    return true;
  });
});

test('desktop cleanup diagnostics survive conversion to a failed production run', () => {
  const cleanupDiagnostic = {
    code: 'TN_PROD_DESKTOP_CLEANUP_TIMEOUT',
    message: 'Desktop cleanup phase stopped observing an alive process.',
    observedAlive: true,
    observedExited: false,
    phase: 'desktop-stop',
    processState: 'alive',
    severity: 'error',
  };
  const cleanupError = Object.assign(new Error(cleanupDiagnostic.message), { diagnostic: cleanupDiagnostic });
  const run = desktopFailureRun(new Error('playtest failed'), [], 123, cleanupError);
  assert.deepEqual(run.report.diagnostics, [cleanupDiagnostic]);
  assert.equal(run.status, 2);
  assert.equal(run.report.pass, false);
});

test('native report retention redacts unsafe host console paths without dropping safe evidence', () => {
  const report = safeReport({
    assertionResults: [{ id: 'diagnostics', pass: false }],
    diagnostics: [],
    observations: {
      console: [
        { text: '/home/operator/.local/share/mystral/storage/platformer.json', type: 'log' },
        { text: 'TN_NATIVE_SMOKE_READY:webgpu', type: 'log' },
      ],
      network: [],
    },
    pass: false,
    scenario: 'production-startup',
    target: 'desktop',
  });
  assert.match(report.observations.console[0].text, /TN_PROD_REDACTION/u);
  assert.equal(report.observations.console[1].text, 'TN_NATIVE_SMOKE_READY:webgpu');
});

test('desktop child receives the transport mailbox root and writes a raw post-present screenshot request', async () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const driverSource = sliceSource(source, 'function createDesktopDriver(', 'export async function installNativeProfileEntry(');
  const project = '/fixture/scaffold';
  const mailboxRoot = join(project, '.runtime-mailbox');
  const screenshotRequestPath = join(mailboxRoot, 'tn-playtest-screenshot-request.txt');
  let childOptions;
  let childArgs;
  const writes = [];
  const context = {
    join,
    process: { platform: 'linux', env: { DISPLAY: ':fixture', TN_PLAYTEST_MAILBOX_ROOT: '/wrong/inherited/root' } },
    spawn: (_command, args, options) => {
      childArgs = args;
      childOptions = options;
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    writeFile: async (path, contents) => writes.push({ contents, path }),
    rename: async (from, to) => writes.push({ from, to }),
    nonBlankPng: async () => true,
    DESKTOP_SCREENSHOT_TIMEOUT_MS: 100,
  };
  runInNewContext(driverSource, context);
  const driver = context.createDesktopDriver('/fixture/mystral', project, { renderSize: { width: 1920, height: 1080 } }, mailboxRoot);
  await driver.launch();
  assert.equal(childOptions.env.TN_PLAYTEST_MAILBOX_ROOT, mailboxRoot);
  assert.equal(childOptions.cwd, project);
  assert.deepEqual(Array.from(childArgs), ['--width', '1920', '--height', '1080', '--headless']);
  await driver.screenshot('/fixture/capture.png');
  assert.deepEqual(writes, [
    { contents: '/fixture/capture.png', path: `${screenshotRequestPath}.tmp` },
    { from: `${screenshotRequestPath}.tmp`, to: screenshotRequestPath },
  ]);
  assert.match(source, /const driver = createDesktopDriver\(artifactPath, project, options, mailboxRoot\)/u);
});

test('production desktop mailbox uses atomic request writes', () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  assert.match(source, /const mailbox = new runner\.LocalDeviceMailbox\(\);/u);
});

test('packaged desktop artifacts launch their embedded entry while bare runtimes still name the bundle', async () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const driverSource = sliceSource(source, 'function createDesktopDriver(', 'export async function installNativeProfileEntry(');
  const project = '/fixture/scaffold';
  const mailboxRoot = join(project, '.runtime-mailbox');
  const launched = [];
  const context = {
    join,
    process: { platform: 'linux', env: { DISPLAY: ':fixture' } },
    spawn: (command, args) => {
      launched.push({ args, command });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    writeFile: async () => undefined,
    rename: async () => undefined,
    nonBlankPng: async () => true,
    DESKTOP_SCREENSHOT_TIMEOUT_MS: 100,
  };
  runInNewContext(driverSource, context);
  const renderSize = { height: 1080, width: 1920 };
  const packaged = context.createDesktopDriver('/fixture/dist-native/platformer', project, { renderSize }, mailboxRoot);
  await packaged.launch();
  assert.equal(launched[0].command, '/fixture/dist-native/platformer');
  assert.deepEqual([...launched[0].args], ['--width', '1920', '--height', '1080', '--headless']);
  const bare = context.createDesktopDriver('/fixture/mystral', project, { prebuiltArtifact: '/fixture/mystral', renderSize }, mailboxRoot);
  await bare.launch();
  assert.deepEqual([...launched[1].args], [
    'run', join(project, '.threenative/build/game.js'), '--width', '1920', '--height', '1080', '--headless',
  ]);
});

test('desktop profiling writes the requested render size into the packaged window config', async () => {
  const project = makeTempDirSync('tn-profile-window-size-');
  temporary.push(project);
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'platformer' }));
  writeFileSync(join(project, 'threenative.config.ts'), [
    'const config = {',
    '  window: { title: "platformer", width: 1280, height: 720, resizable: true },',
    '  nativeEntry: "src/game.ts",',
    '  ui: { renderer: "web" },',
    '};',
    'export default config;',
    '',
  ].join('\n'));
  await installNativeProfileEntry(project, 'desktop', { renderSize: { height: 1080, width: 1920 }, warmup: 1 });
  const rendered = readFileSync(join(project, 'threenative.config.ts'), 'utf8');
  assert.match(rendered, /window: \{ title: "platformer", width: 1920, height: 1080, resizable: true \}/u);
  assert.match(rendered, /nativeEntry: "src\/profile-native-entry.ts"/u);
  assert.match(rendered, /ui: \{ renderer: "web" \}/u);
});

test('failed production commands name the timeout or carry their stderr tail', async () => {
  const timedOut = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], process.cwd(), undefined, 200);
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.timeout, 200);
  assert.match(`Scaffolding the production platformer failed.${failureSuffix(timedOut)}`, /timed out after \d+ s/u);

  const failed = await runCommand(
    process.execPath,
    ['-e', "process.stderr.write('line one\\nboom-tail\\n'); process.exit(3);"],
    process.cwd(),
    undefined,
    5_000,
  );
  assert.equal(failed.status, 3);
  assert.equal(failed.timedOut, false);
  assert.match(`The scaffolded platformer web build failed.${failureSuffix(failed)}`, /boom-tail/u);
});

test('a child run with no parseable report retains a visible, redacted failure artifact', async () => {
  const artifactDirectory = makeTempDirSync('tn-profile-missing-report-');
  const run = await normalizeRun(
    { durationMs: 5, status: 2, stderr: 'Error: the browser closed\n', stdout: '', timeout: 90_000, timedOut: false },
    artifactDirectory,
    'web',
  );
  const unsafe = await normalizeRun(
    { durationMs: 5, status: 1, stderr: 'Authorization: Bearer sk-fixture at /home/operator/.npmrc\n', stdout: '', timeout: 90_000, timedOut: false },
    artifactDirectory,
    'web',
  );
  const timedOut = await normalizeRun(
    { durationMs: 5, status: 2, stderr: '', stdout: '', timeout: 90_000, timedOut: true },
    artifactDirectory,
    'web',
  );
  const oversized = await normalizeRun(
    { durationMs: 5, status: 1, stderr: 'x'.repeat(10_000), stdout: '', timeout: 90_000, timedOut: false },
    artifactDirectory,
    'web',
  );
  assert.equal(run.report, undefined);
  assert.equal(run.failure.status, 2);
  assert.equal(run.failure.code, 'TN_PROD_RUN_REPORT_MISSING');
  assert.match(run.failure.message, /the browser closed/u);
  assert.match(unsafe.failure.message, /TN_PROD_REDACTION/u);
  assert.equal(timedOut.failure.timedOut, true);
  assert.match(timedOut.failure.message, /timed out after 90 s/u);
  assert.equal(JSON.stringify(unsafe.failure).includes('Bearer'), false);
  assert.ok(oversized.failure.message.length <= 4_100);

  const evidence = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: undefined,
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      profile: 'production',
      renderSize: { height: 1080, width: 1920 },
      repetitions: 2,
      target: 'web',
      warmup: 0,
    },
    performanceBounds: undefined,
    project: 'fixture-project',
    resolutionScaleSetting: undefined,
    runId: 'missing-report',
    startedAt: new Date().toISOString(),
    web: {
      applicationClass: 'fixture',
      artifactSha,
      driverClass: 'fixture',
      kind: 'web',
      runs: [run, unsafe],
      startups: [timedOut],
    },
  });
  assert.ok(evidence.codes.includes('TN_PROD_PLAYTEST_FAILED'));
  assert.deepEqual(evidence.rawArtifacts.map(({ label }) => label), [
    'production-run-failure-web-1',
    'production-run-failure-web-2',
    'production-startup-failure-web-1',
  ]);
  assert.match(evidence.rawArtifacts[0].content, /the browser closed/u);
  assert.equal(evidence.rawArtifacts[1].content.includes('Bearer'), false);
});

test('a desktop frame series ends at the capture the harness itself requested', async () => {
  // The desktop host captures `after.png` inside its own frame loop, and the frame that spans the
  // readback reports the readback as its own frame time: both clean-HEAD native collections carry a
  // 312.72 ms and a 358.26 ms gap immediately after the host's `[Screenshot]` line, beside a
  // `TN_SLOW_PHASE pollEvents` at the same figure. That line and the sample batches are one
  // `std::cout` pipe in write order, so it is an exact boundary and not a threshold. A batch logged
  // at or after it is dropped whole, because a batch straddles the capture and dropping one is the
  // direction that cannot read the readback as gameplay. The capture itself is still taken, and its
  // artifact is still evidence.
  const artifactDirectory = makeTempDirSync('tn-profile-capture-boundary-');
  temporary.push(artifactDirectory);
  writeFileSync(join(artifactDirectory, 'after.png'), nonBlankScreenshot());
  const samples = (firstIndex, frameMs, count = 5) => Array.from({ length: count }, (_, index) => ({
    clockMs: 100 + (firstIndex + index) * 16.6,
    drawCalls: 64,
    frameIndex: firstIndex + index,
    frameMs,
  }));
  const before = samples(100, 16.6);
  const after = samples(105, 358.18);
  const seriesLine = (batch) => `[log] TN_PROD_FRAME_SAMPLES:${JSON.stringify(batch)}`;
  const consoleLines = [
    seriesLine(before),
    'TN_SURFACE_FRAME:{"view":true,"present":1935}',
    '[Screenshot] First 16 bytes (BGRA raw): 202 141 67 255 202 141 67 255 ',
    'TN_SLOW_PHASE:{"phase":"pollEvents","ms":358.18799999999999,"atMs":34601.958643999998}',
    seriesLine(after),
  ];
  const report = (target) => ({
    observations: { console: consoleLines.map((text) => ({ text, type: 'log' })) },
    pass: true,
    target,
  });
  const result = { durationMs: 1, status: 0 };
  const desktop = await normalizeRun(result, artifactDirectory, 'desktop', report('desktop'));
  assert.deepEqual(desktop.series.map(({ frameIndex }) => frameIndex), before.map(({ frameIndex }) => frameIndex));
  assert.ok(desktop.series.every(({ frameMs }) => frameMs <= 17), 'the readback frame stayed in the series');
  assert.ok(desktop.screenshot.length > 0, 'the desktop capture artifact is still retained');
  // Web and mobile keep every batch: only the desktop host captures inside its own frame loop.
  const web = await normalizeRun(result, artifactDirectory, 'web', report('browser'));
  assert.equal(web.series.length, before.length + after.length);
  const mislabeledDesktop = await normalizeRun(result, artifactDirectory, 'desktop', report('browser'));
  assert.deepEqual(mislabeledDesktop.series.map(({ frameIndex }) => frameIndex), before.map(({ frameIndex }) => frameIndex));
  const mislabeledWeb = await normalizeRun(result, artifactDirectory, 'web', report('desktop'));
  assert.equal(mislabeledWeb.series.length, before.length + after.length);
  // A desktop report with no capture line has no boundary to stop at, and it fails closed rather than
  // measuring a window it cannot bound.
  const unbounded = await normalizeRun(result, artifactDirectory, 'desktop', {
    observations: {
      console: [seriesLine(before), seriesLine(after)].map((text) => ({ text, type: 'log' })),
      performanceSeries: after,
    },
    pass: true,
    target: 'browser',
  });
  assert.equal(unbounded.series, undefined);
  const evidence = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: {
      applicationClass: 'fixture',
      artifactSha,
      driverClass: 'fixture',
      kind: 'desktop',
      runs: [unbounded],
      startups: [{ firstFrameMs: 100, report: { pass: true }, screenshot: nonBlankScreenshot(), status: 0 }],
    },
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      profile: 'production',
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'desktop',
      warmup: 0,
    },
    performanceBounds: undefined,
    project: 'fixture-project',
    resolutionScaleSetting: undefined,
    runId: 'capture-boundary',
    startedAt: new Date().toISOString(),
    web: undefined,
  });
  assert.ok(evidence.codes.includes('TN_PROD_RENDER_SAMPLES_INCOMPLETE'));
  assert.deepEqual(evidence.rawArtifacts.map(({ label }) => label), [
    'production-render-desktop-1',
    'production-playtest-desktop-1',
    'production-first-frame-desktop-1',
    'production-startup-desktop-1',
  ]);
});

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { force: true, recursive: true });
});

function injectedFrameSamples(source, performanceObservation, frameMs = 14) {
  let scheduledCallback;
  let now = 0;
  let rendered = false;
  let sampledBeforeRender = false;
  const samples = [];
  const sampleLines = [];
  const requests = [];
  const record = (payload) => {
    if (payload?.kind === 'samples' && Array.isArray(payload.samples)) samples.push(...payload.samples);
  };
  const context = {
    __THREENATIVE_PLAYTEST_BRIDGE__: {
      sample: () => {
        if (!rendered) sampledBeforeRender = true;
        return performanceObservation === undefined ? {} : { performance: performanceObservation };
      },
    },
    cancelAnimationFrame: () => undefined,
    console: {
      log: (line) => {
        const prefix = 'TN_PROD_FRAME_SAMPLES:';
        if (typeof line === 'string' && line.startsWith(prefix)) {
          sampleLines.push(line);
          record({ kind: 'samples', samples: JSON.parse(line.slice(prefix.length)) });
        }
      },
    },
    fetch: async (_url, request) => {
      requests.push(_url);
      record(JSON.parse(request.body));
      return {};
    },
    performance: { now: () => now },
    requestAnimationFrame: (callback) => {
      scheduledCallback = callback;
      return 1;
    },
  };
  runInNewContext(source, context);
  const schedule = context.requestAnimationFrame;
  for (let frame = 0; frame <= 30; frame += 1) {
    rendered = false;
    scheduledCallback = undefined;
    schedule(() => { rendered = true; });
    assert.equal(typeof scheduledCallback, 'function');
    now = frame * frameMs;
    scheduledCallback(now);
  }
  return { requests, sampledBeforeRender, sampleLines, samples };
}

function completeEvidence(overrides = {}) {
  const intervals = [
    { frameMs: 16, sequence: 1, timestampMs: 1_000 },
    { frameMs: 17, sequence: 2, timestampMs: 1_016 },
  ];
  return {
    artifact: { applicationClass: 'fixture', sha256: artifactSha, signed: false },
    artifacts: [],
    budget: { maxP99FrameMs: 33, maxStartupMs: 5_000, minMeanFps: 60 },
    command: 'fixture',
    identity: { driverClass: 'driver', gpuClass: 'gpu', hostClass: 'host', osClass: 'os' },
    markers: ['run-start', 'first-workload-frame', 'clean-end'],
    metrics: {
      battery: { complete: true, samples: 1 },
      durationSeconds: 1,
      frameIntervalsMs: intervals.map(({ frameMs }) => frameMs),
      intervals,
      memory: { complete: true, growthBytes: 0, highWaterBytes: 1, slopeBytesPerMinute: 0 },
      startupMs: 100,
      thermal: { complete: true, samples: 1 },
    },
    runId: 'fixture-run',
    source: { dirty: false, sha: sourceSha },
    target: 'fixture',
    timestamps: { endedAt: '2026-08-09T00:01:00.000Z', startedAt: '2026-08-09T00:00:00.000Z' },
    version: PRODUCTION_EVIDENCE_VERSION,
    ...overrides,
  };
}

test('production evidence uses nearest-rank pacing and arithmetic mean fps', () => {
  assert.equal(nearestRank([16, 17, 2_000], 0.99), 2_000);
  const budget = evaluateFrameBudget(
    { frameIntervalsMs: [16, 16, 17], intervals: [] },
    { maxP99FrameMs: 33, minMeanFps: 60 },
  );
  assert.equal(budget.failures.length, 0);
  assert.ok(budget.mean > 60);
  assert.deepEqual(evaluateFrameBudget({ frameIntervalsMs: [40, 40, 40] }, { minFps: 30 }).failures, ['TN_PROD_PERFORMANCE_BUDGET']);
});

test('counter budgets ignore a window-opening frame with no renderer reading', () => {
  const intervals = [
    { frameMs: 16, sequence: 1, timestampMs: 0 },
    { drawCalls: 80, frameMs: 16, sequence: 2, timestampMs: 16, triangles: 3_204 },
    { drawCalls: 79, frameMs: 16, sequence: 3, timestampMs: 32, triangles: 3_200 },
  ];
  const budget = evaluateFrameBudget(
    { drawCalls: 80, frameIntervalsMs: [16, 16, 16], intervals, meanFps: 175, p95FrameMs: 16.6, p99FrameMs: 17, triangles: 3_204 },
    { maxDrawCalls: 200, maxTriangles: 7_700, minMeanFps: 60 },
  );
  assert.deepEqual(budget.failures, []);
  assert.equal(budget.drawCalls, 80);
  assert.equal(budget.triangles, 3_204);
  assert.deepEqual(evaluateFrameBudget(
    { frameIntervalsMs: [16], intervals: [{ frameMs: 16, sequence: 1, timestampMs: 0 }] },
    { maxDrawCalls: 200 },
  ).failures, ['TN_PROD_PERFORMANCE_BUDGET']);
});

test('complete current evidence is the only PASS state', () => {
  const result = evaluateProductionEvidence(completeEvidence());
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.codes, []);
});

test('hosted software keeps timing failures advisory while preserving measured budgets', () => {
  const result = evaluateProductionEvidence(completeEvidence({
    execution: { performanceEvaluation: 'advisory' },
    metrics: {
      ...completeEvidence().metrics,
      frameIntervalsMs: [40, 40, 40],
      intervals: [
        { frameMs: 40, sequence: 1, timestampMs: 1_000 },
        { frameMs: 40, sequence: 2, timestampMs: 1_040 },
        { frameMs: 40, sequence: 3, timestampMs: 1_080 },
      ],
    },
  }));
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.codes, []);
  assert.deepEqual(result.advisoryCodes, ['TN_PROD_PERFORMANCE_BUDGET']);
});

test('hosted native collection allows software-adapter startup settlement', () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  assert.equal((source.match(/allowSoftwareAdapter: options\.hostedSoftware/gu) ?? []).length, 2);
});

function regressionEvidence(overrides = {}) {
  const count = 1_800;
  const frameMs = 1_000 / 60;
  const intervals = Array.from({ length: count }, (_, index) => ({
    clockMs: index * frameMs,
    frameMs,
    sequence: index + 1,
    timestampMs: index * frameMs,
  }));
  return completeEvidence({
    budget: {
      maxP99FrameMs: 33,
      maxStartupMs: 5_000,
      minMeanFps: 60,
      minDurationSeconds: 30,
      minFrameSamples: 1_000,
    },
    execution: {
      coldStarts: 5,
      profile: 'regression',
      readiness: { ready: true, sampleReset: true },
      warmupReset: true,
    },
    markers: ['run-start', 'first-workload-frame', 'clean-end'],
    metrics: {
      battery: { complete: true, samples: 1 },
      clockSamplesMs: intervals.map(({ clockMs }) => clockMs),
      clockSource: 'monotonic-performance',
      durationSeconds: 30,
      frameIntervalsMs: intervals.map(({ frameMs: value }) => value),
      intervals,
      meanFps: 60,
      memory: { complete: true, growthBytes: 0, highWaterBytes: 1, slopeBytesPerMinute: 0 },
      motion: { moved: true, movingObjects: 256 },
      pixels: { changed: true, nonBlank: true },
      presentationClockSource: 'raf-presentation',
      presentationSamplesMs: intervals.map(({ clockMs }) => clockMs),
      runWindows: [{ durationSeconds: 30, sampleCount: count }],
      startupSamplesMs: [100, 100, 100, 100, 100],
      startupMs: 100,
      thermal: { complete: true, samples: 1 },
    },
    ...overrides,
  });
}

test('regression evidence accepts a bounded real-clock, ready, moving, pixel-backed window', () => {
  const result = evaluateProductionEvidence(regressionEvidence());
  assert.equal(result.status, 'PASS');
  assert.equal(result.exitCode, 0);
});

test('regression readiness requires the explicit runtimeReady observation', () => {
  const frame = new PNG({ height: 2, width: 2 });
  frame.data.fill(255);
  frame.data[0] = 0;
  const makeEvidence = (runtimeReady) => assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: undefined,
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      profile: 'regression',
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'web',
      warmup: 0,
    },
    performanceBounds: undefined,
    project: 'fixture-project',
    runId: `readiness-${runtimeReady ? 'present' : 'missing'}`,
    startedAt: new Date().toISOString(),
    web: {
      applicationClass: 'fixture',
      artifactSha,
      driverClass: 'fixture',
      kind: 'web',
      runs: [{
        report: {
          assertionResults: [{
            details: { policy: runtimeReady ? { runtimeReady: true } : {} },
            id: 'diagnostics',
            pass: true,
          }],
          diagnostics: [],
          pass: true,
        },
        screenshot: PNG.sync.write(frame),
        series: [{ frameIndex: 1, frameMs: 16 }],
        status: 0,
      }],
      startups: [],
    },
  });
  assert.equal(makeEvidence(false).execution.readiness.ready, false);
  assert.equal(makeEvidence(true).execution.readiness.ready, true);
  const blocked = evaluateProductionEvidence(regressionEvidence({
    execution: { ...regressionEvidence().execution, readiness: { ready: false, sampleReset: true } },
  }));
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.exitCode, 2);
  assert.ok(blocked.codes.includes('TN_PROD_READINESS_MISSING'));
});

test('regression evidence requires every launch to meet the full steady-state window', () => {
  const result = evaluateProductionEvidence(regressionEvidence({
    metrics: {
      ...regressionEvidence().metrics,
      runWindows: [
        { durationSeconds: 30, sampleCount: 1_800 },
        { durationSeconds: 2, sampleCount: 120 },
      ],
    },
  }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 2);
  assert.ok(result.codes.includes('TN_PROD_REGRESSION_WINDOW'));
});

test('regression rejects pooling two individually valid steady launches', () => {
  const base = regressionEvidence();
  const result = evaluateProductionEvidence({ ...base, metrics: { ...base.metrics, runWindows: [
    { durationSeconds: 30, sampleCount: 1800 }, { durationSeconds: 30, sampleCount: 1800 },
  ] } });
  assert.equal(result.status, 'BLOCKED');
});

test('generated native mailbox declaration is executable and independent of scaffold directory', async () => {
  const project = makeTempDirSync('tn-profile-mailbox-');
  temporary.push(project);
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'), '{}');
  writeFileSync(join(project, 'threenative.config.ts'), 'export default { nativeEntry: "src/game.ts" };');
  await installNativeProfileEntry(project, 'desktop', { warmup: 1 });
  const source = readFileSync(join(project, 'src/profile-native-entry.ts'), 'utf8');
  const declaration = source.split('\n').find((line) => line.startsWith('globalThis.TN_PLAYTEST_MAILBOX'));
  const context = {};
  runInNewContext(declaration, context);
  assert.equal(context.TN_PLAYTEST_MAILBOX.request, '.runtime-mailbox/tn-playtest-request.json');
  assert.doesNotMatch(source, /tn-production-screenshot-request\.json|tnProductionScreenshotRequestPath|captureScreenshot|playtest\?\.receive/u);
});

test('generated native profile exposes hosted software only to the profile entry', async () => {
  const hostedProject = makeTempDirSync('tn-profile-hosted-software-');
  const normalProject = makeTempDirSync('tn-profile-normal-software-');
  temporary.push(hostedProject, normalProject);
  for (const project of [hostedProject, normalProject]) {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(join(project, 'threenative.config.ts'), 'export default { nativeEntry: "src/game.ts" };');
  }

  await installNativeProfileEntry(hostedProject, 'desktop', { hostedSoftware: true, warmup: 1 });
  await installNativeProfileEntry(normalProject, 'desktop', { hostedSoftware: false, warmup: 1 });

  const hostedEntry = readFileSync(join(hostedProject, 'src/profile-native-entry.ts'), 'utf8');
  const hostedMarker = readFileSync(join(hostedProject, 'src/profile-native-profile.ts'), 'utf8');
  const normalMarker = readFileSync(join(normalProject, 'src/profile-native-profile.ts'), 'utf8');
  assert.match(hostedEntry, /import "\.\/profile-native-profile\.js";/u);
  const hostedContext = {};
  const normalContext = {};
  runInNewContext(hostedMarker, hostedContext);
  runInNewContext(normalMarker, normalContext);
  assert.equal(hostedContext.__THREENATIVE_PROFILE__.hostedSoftware, true);
  assert.equal(normalContext.__THREENATIVE_PROFILE__.hostedSoftware, false);
});

test('profiling preserves the authored web UI on desktop and mobile', async () => {
  const desktopProject = makeTempDirSync('tn-profile-desktop-ui-');
  const mobileProject = makeTempDirSync('tn-profile-mobile-ui-');
  temporary.push(desktopProject, mobileProject);
  for (const project of [desktopProject, mobileProject]) {
    mkdirSync(join(project, 'src'));
    writeFileSync(join(project, 'package.json'), '{}');
    writeFileSync(
      join(project, 'threenative.config.ts'),
      'export default { nativeEntry: "src/game.ts", ui: { renderer: "web" } };\n',
    );
  }

  await installNativeProfileEntry(desktopProject, 'desktop', { warmup: 1 });
  await installNativeProfileEntry(mobileProject, 'android', { warmup: 1 });

  assert.match(readFileSync(join(desktopProject, 'threenative.config.ts'), 'utf8'), /ui: \{ renderer: "web" \}/u);
  assert.match(readFileSync(join(mobileProject, 'threenative.config.ts'), 'utf8'), /ui: \{ renderer: "web" \}/u);
});

test('physical regression evidence blocks a thermally confounded device result', () => {
  const base = regressionEvidence();
  const result = evaluateProductionEvidence({
    ...base,
    metrics: {
      ...base.metrics,
      thermal: { complete: true, samples: 2, thermallyConfounded: true },
    },
    physical: { provenance: 'physical-hardware' },
    target: 'android-physical',
  });
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 2);
  assert.ok(result.codes.includes('TN_PROD_THERMAL_STATE_INVALID'));
});

test('regression evidence blocks short windows, fixed clocks, contaminated startup, frozen work, and changed-pixel gaps', () => {
  const cases = [
    ['short window', { metrics: { ...regressionEvidence().metrics, durationSeconds: 29, frameIntervalsMs: Array(999).fill(16.666) } }, 'TN_PROD_REGRESSION_WINDOW'],
    ['fixed tick', { metrics: { ...regressionEvidence().metrics, clockSource: 'fixed-tick' } }, 'TN_PROD_CLOCK_INVALID'],
    ['startup contamination', { execution: { ...regressionEvidence().execution, warmupReset: false } }, 'TN_PROD_STARTUP_CONTAMINATION'],
    ['frozen motion', { metrics: { ...regressionEvidence().metrics, motion: { moved: false, movingObjects: 0 } } }, 'TN_PROD_MOTION_MISSING'],
    ['changed pixels missing', { metrics: { ...regressionEvidence().metrics, pixels: { changed: false, nonBlank: true } } }, 'TN_PROD_PIXEL_EVIDENCE_MISSING'],
  ];
  for (const [name, override, code] of cases) {
    const result = evaluateProductionEvidence(regressionEvidence(override));
    assert.equal(result.status, 'BLOCKED', name);
    assert.equal(result.exitCode, 2, name);
    assert.ok(result.codes.includes(code), `${name}: ${result.codes.join(', ')}`);
  }
});

test('missing lifecycle marker is BLOCKED with exit 2', () => {
  const result = evaluateProductionEvidence(completeEvidence({ markers: ['run-start', 'clean-end'] }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 2);
  assert.ok(result.codes.includes('TN_PROD_MARKER_MISSING'));
});

test('executed pacing, startup, and memory breaches are FAIL with distinct codes', () => {
  const result = evaluateProductionEvidence(completeEvidence({
    budget: { maxMemoryGrowthBytes: 64, maxP99FrameMs: 33, maxStartupMs: 5_000, minMeanFps: 60 },
    metrics: {
      ...completeEvidence().metrics,
      frameIntervalsMs: [16, 16, 2_000],
      intervals: [
        { frameMs: 16, sequence: 1, timestampMs: 1_000 },
        { frameMs: 16, sequence: 2, timestampMs: 1_016 },
        { frameMs: 2_000, sequence: 3, timestampMs: 1_032 },
      ],
      memory: { complete: true, first15MedianBytes: 100, growthBytes: 128, highWaterBytes: 200, last15MedianBytes: 200, slopeBytesPerMinute: 1 },
      startupSamplesMs: [100, 100, 100, 100, 6_000],
    },
  }));
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.ok(result.codes.includes('TN_PROD_PERFORMANCE_BUDGET'));
  assert.ok(result.codes.includes('TN_PROD_STARTUP_BUDGET'));
  assert.ok(result.codes.includes('TN_PROD_MEMORY_GROWTH'));
});

test('desktop parity requires distinct identities and no slower native statistics', () => {
  const pass = evaluateProductionEvidence(completeEvidence({
    target: 'desktop-pair',
    identity: { nativeArtifactSha256: 'b'.repeat(64), nativeProcess: 'native', webArtifactSha256: 'c'.repeat(64), webProcess: 'browser' },
    metrics: { ...completeEvidence().metrics, native: { meanFps: 60, p50FrameMs: 16, p95FrameMs: 18, p99FrameMs: 20 }, web: { meanFps: 60, p50FrameMs: 16, p95FrameMs: 18, p99FrameMs: 20 } },
  }));
  assert.equal(pass.status, 'PASS');
  const self = evaluateProductionEvidence(completeEvidence({
    target: 'desktop-pair',
    identity: { nativeArtifactSha256: 'b'.repeat(64), nativeProcess: 'same', webArtifactSha256: 'b'.repeat(64), webProcess: 'same' },
    metrics: { ...completeEvidence().metrics, native: { meanFps: 60, p50FrameMs: 16, p95FrameMs: 18, p99FrameMs: 20 }, web: { meanFps: 60, p50FrameMs: 16, p95FrameMs: 18, p99FrameMs: 20 } },
  }));
  assert.equal(self.status, 'BLOCKED');
  assert.ok(self.codes.includes('TN_PROD_SELF_COMPARISON'));
});

test('desktop parity blocks before comparing incomplete or non-finite arm metrics', () => {
  const result = evaluateProductionEvidence(completeEvidence({
    target: 'desktop-pair',
    identity: { nativeArtifactSha256: 'b'.repeat(64), nativeProcess: 'native', webArtifactSha256: 'c'.repeat(64), webProcess: 'browser' },
    metrics: {
      ...completeEvidence().metrics,
      native: { meanFps: 60, p50FrameMs: 16, p95FrameMs: Number.NaN, p99FrameMs: 20 },
      web: { meanFps: 60, p50FrameMs: 16, p95FrameMs: 18, p99FrameMs: 20 },
    },
  }));
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 2);
  assert.ok(result.codes.includes('TN_PROD_COMPARISON_METRICS_INCOMPLETE'));
  assert.equal(result.codes.includes('TN_PROD_PERFORMANCE_BUDGET'), false);
});

test('accepted profile controls are parsed and execution receives every value', async () => {
  const parsed = parseProductionArgs([
    '--target', 'android',
    '--render-size', '1920x1080',
    '--cold-starts', '2',
    '--device', 'emulator-5554',
    '--prebuilt-artifact', '/tmp/already-built-runtime.apk',
    '--warmup', '3',
    '--repetitions', '4',
  ]);
  assert.deepEqual(parsed.renderSize, { height: 1080, width: 1920 });
  assert.equal(parsed.coldStarts, 2);
  assert.equal(parsed.device, 'emulator-5554');
  assert.equal(parsed.prebuiltArtifact, '/tmp/already-built-runtime.apk');
  assert.equal(parsed.warmup, 3);
  assert.equal(parsed.repetitions, 4);
  assert.equal(parsed.profile, 'production');
  const hosted = parseProductionArgs(['--target', 'desktop', '--hosted-software']);
  assert.equal(hosted.hostedSoftware, true);
  assert.deepEqual(hosted.renderSize, { height: 720, width: 1280 });
  const hostedExplicit = parseProductionArgs([
    '--target', 'desktop', '--hosted-software', '--render-size', '1920x1080',
  ]);
  assert.deepEqual(hostedExplicit.renderSize, { height: 1080, width: 1920 });
  const hostedAndroid = parseProductionArgs([
    '--target', 'android', '--device', 'emulator-5554', '--hosted-software',
  ]);
  assert.deepEqual(hostedAndroid.renderSize, { height: 1080, width: 1920 });
  const relativeArtifact = parseProductionArgs([
    '--target', 'desktop',
    '--prebuilt-artifact', 'build/tn-macos/mystral',
  ]);
  assert.equal(
    relativeArtifact.prebuiltArtifact,
    resolve('build/tn-macos/mystral'),
  );
  const regression = parseProductionArgs(['--target', 'desktop', '--profile', 'regression']);
  assert.equal(regression.profile, 'regression');
  assert.equal(regression.duration, 30);
  assert.equal(regression.warmup, 5);
  assert.equal(regression.coldStarts, 5);
  assert.equal(regression.repetitions, 1);
  assert.equal(parseProductionArgs(['--target', 'desktop-web']).target, 'web');
  assert.throws(
    () => parseProductionArgs(['--target', 'web', '--device', 'emulator-5554']),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_DEVICE_UNSUPPORTED',
  );
  assert.throws(
    () => parseProductionArgs(['--target', 'android-physical', '--device', 'pixel', '--hosted-software']),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_HOSTED_SOFTWARE_UNSUPPORTED',
  );
});

test('an existing project and scenario parse and stage without mutating the source', async () => {
  const source = makeTempDirSync('tn-profile-project-');
  const stageRoot = makeTempDirSync('tn-profile-stage-');
  temporary.push(source, stageRoot);
  mkdirSync(join(source, 'src'));
  mkdirSync(join(source, 'playtests'));
  mkdirSync(join(source, 'node_modules'));
  writeFileSync(join(source, 'src/main.ts'), 'export const value = 1;\n');
  writeFileSync(join(source, 'threenative.config.ts'), 'renderer: { resolutionScale: "auto" }\n');
  writeFileSync(join(source, 'playtests/performance.playtest.json'), JSON.stringify({
    assert: { performance: { maxFrameMsP95: 15 } },
    name: 'production-performance',
    schemaVersion: 1,
    steps: [{ kind: 'wait', waitFrames: 1 }],
  }));
  writeFileSync(join(source, 'node_modules/installed.txt'), 'installed\n');

  const parsed = parseProductionArgs([
    '--target', 'web',
    '--project', source,
    '--scenario', 'playtests/performance.playtest.json',
  ]);
  assert.equal(parsed.project, source);
  assert.equal(parsed.scenario, join(source, 'playtests/performance.playtest.json'));
  assert.throws(
    () => parseProductionArgs(['--target', 'web', '--scenario', 'playtests/performance.playtest.json']),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_CLI_USAGE',
  );
  assert.throws(
    () => parseProductionArgs(['--target', 'fixture', '--project', source]),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_CLI_USAGE',
  );

  const staged = join(stageRoot, 'platformer');
  const { stageProductionProject } = await import('../scripts/profile-production.mjs');
  await stageProductionProject(parsed, staged, {});

  assert.equal(readFileSync(join(staged, 'src/main.ts'), 'utf8'), 'export const value = 1;\n');
  assert.equal(readFileSync(join(staged, 'playtests/performance.playtest.json'), 'utf8').length > 0, true);
  assert.equal(readFileSync(join(staged, 'node_modules/installed.txt'), 'utf8'), 'installed\n');
  assert.equal(readFileSync(join(staged, 'threenative.config.ts'), 'utf8'), 'renderer: { resolutionScale: "auto" }\n');
  assert.equal(readFileSync(join(source, 'threenative.config.ts'), 'utf8'), 'renderer: { resolutionScale: "auto" }\n');
  writeFileSync(join(staged, 'src/main.ts'), 'export const value = 2;\n');
  assert.equal(readFileSync(join(source, 'src/main.ts'), 'utf8'), 'export const value = 1;\n');
});

test('staging dereferences symlinked sources and reads the scenario from the staged snapshot', async () => {
  const external = makeTempDirSync('tn-profile-symlink-external-');
  const source = makeTempDirSync('tn-profile-symlink-source-');
  const stageRoot = makeTempDirSync('tn-profile-symlink-stage-');
  temporary.push(external, source, stageRoot);
  mkdirSync(join(source, 'src'));
  mkdirSync(join(source, 'playtests'));
  writeFileSync(join(external, 'main.ts'), 'export const value = 1;\n');
  symlinkSync(join(external, 'main.ts'), join(source, 'src/main.ts'));
  const scenario = (snapshot) => JSON.stringify({
    assert: { performance: { maxFrameMsP95: 15 } },
    name: 'production-performance',
    schemaVersion: 1,
    snapshot,
    steps: [{ kind: 'wait', waitFrames: 1 }],
  });
  writeFileSync(join(source, 'playtests/performance.playtest.json'), scenario('source'));

  const parsed = parseProductionArgs([
    '--target', 'web',
    '--project', source,
    '--scenario', 'playtests/performance.playtest.json',
  ]);
  const staged = join(stageRoot, 'platformer');
  const { stageProductionProject, writeRunScenarios } = await import('../scripts/profile-production.mjs');
  await stageProductionProject(parsed, staged, {});

  // The symlinked source file becomes a real staged file; writing it must not reach its target.
  const stagedMain = join(staged, 'src/main.ts');
  assert.equal(lstatSync(stagedMain).isSymbolicLink(), false);
  writeFileSync(stagedMain, 'export const value = 2;\n');
  assert.equal(readFileSync(join(external, 'main.ts'), 'utf8'), 'export const value = 1;\n');

  // The run scenario is generated from the staged snapshot, not the source it was named from.
  assert.equal(parsed.scenario, join(staged, 'playtests/performance.playtest.json'));
  writeFileSync(parsed.scenario, scenario('staged'));
  const paths = await writeRunScenarios(staged, parsed);
  assert.equal(JSON.parse(readFileSync(paths.workloadPath, 'utf8')).snapshot, 'staged');
});

test('a project scenario keeps its own workload steps and a timeout that scales past the old 30s cap', async () => {
  const project = makeTempDirSync('tn-profile-scenario-steps-');
  temporary.push(project);
  mkdirSync(join(project, 'playtests'));
  const steps = [
    { at: { x: 640, y: 360 }, kind: 'click', release: true },
    { kind: 'wait', release: true, waitFrames: 240 },
  ];
  writeFileSync(join(project, 'playtests/performance.playtest.json'), JSON.stringify({
    name: 'production-performance',
    schemaVersion: 1,
    steps,
  }));

  const paths = await writeRunScenarios(project, {
    duration: 1,
    project,
    renderSize: { height: 1080, width: 1920 },
    scenario: join(project, 'playtests/performance.playtest.json'),
    target: 'desktop',
    warmup: 1,
  });
  const workload = JSON.parse(readFileSync(paths.workloadPath, 'utf8'));
  const nativeWorkload = JSON.parse(readFileSync(paths.nativeWorkloadPath, 'utf8'));
  assert.deepEqual(workload.steps, steps);
  assert.deepEqual(nativeWorkload.steps, [
    { pointerPosition: { buttons: 1, x: 640 / 1920, y: 360 / 1080 }, release: true },
    steps[1],
  ]);
  assert.equal(paths.timeoutMs, playtestTimeoutMs(workload));
  assert.ok(paths.timeoutMs > 30_000);
  assert.ok(paths.timeoutMs >= 60_000 + (60 + 240) * 100);
});

test('the default scaffolded workload still drives ArrowRight whatever the template scenario says', async () => {
  const project = makeTempDirSync('tn-profile-default-steps-');
  temporary.push(project);
  mkdirSync(join(project, 'playtests'));
  writeFileSync(join(project, 'playtests/performance.playtest.json'), JSON.stringify({
    name: 'production-performance',
    schemaVersion: 1,
    steps: [{ kind: 'wait', waitFrames: 1 }],
  }));

  const paths = await writeRunScenarios(project, {
    duration: 2,
    renderSize: { height: 1080, width: 1920 },
    target: 'desktop',
    warmup: 1,
  });
  const workload = JSON.parse(readFileSync(paths.workloadPath, 'utf8'));
  assert.deepEqual(workload.steps, [
    { holdFrames: 60, kind: 'input', press: 'ArrowRight', release: true },
    { kind: 'wait', release: true, waitFrames: 120 },
  ]);
  assert.ok(paths.timeoutMs > 30_000);
});

test('hosted software waits for compile settlement without requiring a ready-frame milestone', async () => {
  const project = makeTempDirSync('tn-profile-hosted-startup-');
  temporary.push(project);
  mkdirSync(join(project, 'playtests'));
  writeFileSync(join(project, 'playtests/performance.playtest.json'), JSON.stringify({
    name: 'production-performance', schemaVersion: 1, steps: [{ kind: 'wait', waitFrames: 1 }],
  }));
  const options = { duration: 1, hostedSoftware: true, renderSize: { height: 720, width: 1280 }, target: 'desktop', warmup: 1 };
  const hosted = await writeRunScenarios(project, options);
  assert.ok(JSON.parse(readFileSync(hosted.nativeStartupPath, 'utf8')).assert.startup.maxCompileSettledMs > 0);
  assert.equal(JSON.parse(readFileSync(hosted.nativeStartupPath, 'utf8')).assert.startup.maxReadyMs, undefined);
  const hardware = await writeRunScenarios(project, { ...options, hostedSoftware: false });
  assert.ok(JSON.parse(readFileSync(hardware.nativeStartupPath, 'utf8')).assert.startup.maxReadyMs > 0);
});

test('desktop artifact selection takes the executable regular file and fails closed without one', async () => {
  const project = makeTempDirSync('tn-profile-native-artifact-');
  temporary.push(project);
  const directory = join(project, 'dist-native');
  mkdirSync(join(directory, 'ui'), { recursive: true });
  writeFileSync(join(directory, 'game.bundle'), 'not an executable');
  await assert.rejects(
    nativeArtifactPath(project, 'desktop'),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_NATIVE_ARTIFACT_MISSING',
  );
  mkdirSync(join(directory, 'Game.app'));
  writeFileSync(join(directory, 'game.apk'), 'apk');
  const executable = join(directory, 'platformer');
  writeFileSync(executable, '#!/bin/sh\n');
  chmodSync(executable, 0o755);
  assert.equal(await nativeArtifactPath(project, 'desktop'), executable);
  assert.equal(await nativeArtifactPath(project, 'ios'), join(directory, 'Game.app'));
  assert.equal(await nativeArtifactPath(project, 'android'), join(directory, 'game.apk'));
});

test('a scenario outside --project is rejected instead of re-anchored out of staging', () => {
  const source = makeTempDirSync('tn-profile-scenario-guard-');
  temporary.push(source);

  for (const scenario of ['../outside.playtest.json', join(source, '..', 'outside.playtest.json')]) {
    assert.throws(
      () => parseProductionArgs(['--target', 'web', '--project', source, '--scenario', scenario]),
      (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_SCENARIO_OUTSIDE_PROJECT',
      `expected '${scenario}' to be rejected`,
    );
  }

  const inside = parseProductionArgs(['--target', 'web', '--project', source, '--scenario', 'playtests/performance.playtest.json']);
  assert.equal(inside.scenario, join(source, 'playtests/performance.playtest.json'));
});

test('the default judge still scaffolds when no existing project is supplied', async () => {
  const stageRoot = makeTempDirSync('tn-profile-stage-default-');
  temporary.push(stageRoot);
  const staged = join(stageRoot, 'platformer');
  const calls = [];
  const { stageProductionProject } = await import('../scripts/profile-production.mjs');
  const result = await stageProductionProject(
    { project: undefined },
    staged,
    { scaffoldCli: '/fixture/scaffold' },
    { scaffoldPlatformer: async (project, tools) => { calls.push([project, tools]); } },
  );
  assert.equal(result, staged);
  assert.deepEqual(calls, [[staged, { scaffoldCli: '/fixture/scaffold' }]]);
});

test('native profile entry replaces a config entry without creating a package conflict', async () => {
  const project = makeTempDirSync('tn-profile-entry-');
  temporary.push(project);
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'), JSON.stringify({
    name: 'fixture',
    threenative: { nativeEntry: 'src/game.ts' },
  }));
  writeFileSync(join(project, 'threenative.config.ts'), 'export default {\n  nativeEntry: "src/game.ts",\n};\n');

  await setNativeProfileEntry(project, 'src/profile-native-entry.ts');

  assert.match(
    readFileSync(join(project, 'threenative.config.ts'), 'utf8'),
    /nativeEntry: "src\/profile-native-entry\.ts"/u,
  );
  assert.equal(JSON.parse(readFileSync(join(project, 'package.json'), 'utf8')).threenative, undefined);
});

test('the desktop profile names the legacy host for a config that sets no engine and keeps one that does', async () => {
  const unset = makeTempDirSync('tn-profile-engine-');
  const authored = makeTempDirSync('tn-profile-engine-');
  temporary.push(unset, authored);
  writeFileSync(join(unset, 'threenative.config.ts'), 'const config: IThreeNativeConfig = {\n  app: {},\n};\nexport default config;\n');
  writeFileSync(join(authored, 'threenative.config.ts'), 'export default {\n  engine: "threenative",\n};\n');

  await pinThreejsDesktopHost(unset);
  await pinThreejsDesktopHost(unset);
  await pinThreejsDesktopHost(authored);

  assert.equal(
    readFileSync(join(unset, 'threenative.config.ts'), 'utf8'),
    'const config: IThreeNativeConfig = {\n  engine: "threejs",\n  app: {},\n};\nexport default config;\n',
  );
  assert.equal(readFileSync(join(authored, 'threenative.config.ts'), 'utf8'), 'export default {\n  engine: "threenative",\n};\n');
});

test('native profile reads the generated app identity when no config override is supplied', () => {
  assert.equal(
    profileConfigPath('/tmp/platformer'),
    '/tmp/platformer/.threenative/build/config.json',
  );
  assert.equal(
    profileConfigPath('/tmp/platformer', '/tmp/custom-config.json'),
    '/tmp/custom-config.json',
  );
});

test('profile identity retains auto or the configured numeric resolution scale per platform', () => {
  const config = { renderer: { android: { resolutionScale: 0.75 }, resolutionScale: 'auto' } };
  assert.equal(rendererResolutionScaleSetting(config, 'desktop'), 'auto');
  assert.equal(rendererResolutionScaleSetting(config, 'android'), '0.75');
  assert.equal(rendererResolutionScaleSetting({ renderer: { resolutionScale: 0.5 } }, 'desktop'), '0.5');
});

test('regression collects one steady launch and five startup launches per paired arm', () => {
  const options = parseProductionArgs(['--target', 'desktop', '--profile', 'regression']);
  const plan = collectionLaunchPlan(options);
  assert.equal(plan.filter((entry) => entry === 'startup').length, 5);
  assert.equal(plan.filter((entry) => entry === 'steady').length, 1);
  assert.ok(6 * (options.duration + options.warmup + options.coldStarts * 8) < 900);
  assert.throws(() => parseProductionArgs(['--target', 'desktop', '--profile', 'regression', '--repetitions', '3']), { code: 'TN_PROD_PAIR_UNIT' });
});

test('prebuilt desktop still builds its instrumented scaffold with the supplied runtime', async () => {
  const calls = [];
  await prepareNativeWorkload('/project', 'desktop', { prebuiltArtifact: '/runtime/mystral' }, async (...args) => {
    calls.push(args);
    return { status: 0 };
  });
  assert.deepEqual(calls[0].slice(0, 3), ['pnpm', ['run', 'build:desktop'], '/project']);
  assert.equal(calls[0][3].THREENATIVE_RUNTIME_BINARY, '/runtime/mystral');
});

test('prebuilt mobile refuses an app without a bound instrumented workload receipt', async () => {
  await assert.rejects(prepareNativeWorkload('/project', 'android', { prebuiltArtifact: '/missing.apk' }), { code: 'TN_PROD_PREBUILT_WORKLOAD' });
});

test('startup aggregation rejects failed reports and blank first frames', () => {
  const blank = new PNG({ height: 2, width: 2 });
  blank.data.fill(255);
  const frame = new PNG({ height: 2, width: 2 });
  frame.data.fill(255);
  frame.data[0] = 0;
  frame.data[1] = 64;
  frame.data[2] = 128;
  const valid = {
    firstFrameMs: 100,
    report: { pass: true },
    screenshot: PNG.sync.write(frame),
    status: 0,
  };
  assert.equal(isSuccessfulStartupSample(valid), true);
  assert.equal(isSuccessfulStartupSample({ ...valid, report: undefined }), false);
  assert.equal(isSuccessfulStartupSample({ ...valid, screenshot: PNG.sync.write(blank) }), false);
  const metrics = aggregateMetrics(
    [{ series: [{ frameMs: 16.5 }], status: 0 }],
    [{ ...valid, report: undefined }, { ...valid, screenshot: undefined }],
  );
  assert.equal(metrics.startupSamplesMs, undefined);
  assert.equal(metrics.startupP95Ms, undefined);
});

test('native scenarios use supported startup assertions while browser startup retains diagnostics', async () => {
  const project = makeTempDirSync('tn-native-diagnostics-');
  temporary.push(project);
  mkdirSync(join(project, 'playtests'));
  writeFileSync(join(project, 'playtests/performance.playtest.json'), JSON.stringify({
    name: 'production-performance', schemaVersion: 1, steps: [{ kind: 'wait', waitFrames: 10 }],
    assert: { diagnostics: { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true, runtimeReady: true } },
  }));
  const playtest = await import(new URL('../../playtest/dist/index.js', import.meta.url).href);
  for (const target of ['desktop', 'android', 'ios']) {
    const paths = await writeRunScenarios(project, { duration: 1, warmup: 1, target, renderSize: { width: 1920, height: 1080 } });
    for (const path of [paths.startupPath, paths.workloadPath]) {
      const scenario = await playtest.loadPlaytestScenario(project, path);
      assert.notEqual(scenario.assert.diagnostics.noNetworkErrors, false);
      assert.equal(playtest.requiredPlaytestCapabilities(scenario).includes('browser.network'), true);
      assert.equal(scenario.assert.diagnostics.networkErrorsOptOutReason, undefined);
    }
    for (const path of [paths.nativeStartupPath, paths.nativeWorkloadPath]) {
      const scenario = await playtest.loadPlaytestScenario(project, path);
      assert.equal(scenario.assert.diagnostics, undefined);
      assert.equal(playtest.requiredPlaytestCapabilities(scenario).includes('browser.network'), false);
      assert.equal(scenario.assert.startup.maxReadyMs > 0, true);
    }
  }
});

test('web production runs headed on WebGPU and identifies its own marker endpoint', () => {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const webScenario = source.slice(source.indexOf('async function runWebScenario('), source.indexOf('async function collectNative('));
  assert.match(webScenario, /'--browser-recipe', 'webgpu'/u);
  assert.match(webScenario, /'--headed'/u);
  assert.match(webScenario, /'--judge-marker-url', markerServer\.url/u);

  const markerUrl = 'http://127.0.0.1:41777/first-frame';
  const config = parseStandalonePlaytestArgs([
    'playtests/workload.playtest.json',
    '--judge-marker-url', markerUrl,
  ], '/project');
  assert.equal(config.judgeMarkerUrl, markerUrl);
  assert.equal(isJudgeMarkerRequestFailure('POST', markerUrl, markerUrl), true);
  assert.equal(isJudgeMarkerRequestFailure('POST', `${markerUrl}?game=1`, markerUrl), false);
  assert.equal(isJudgeMarkerRequestFailure('GET', markerUrl, markerUrl), false);
});

test('desktop production keeps an authored pixel click through native pointer input', async () => {
  const project = makeTempDirSync('tn-prod-desktop-click-');
  temporary.push(project);
  mkdirSync(join(project, 'playtests'));
  writeFileSync(join(project, 'playtests/flight.playtest.json'), JSON.stringify({
    name: 'flight', schemaVersion: 1, target: 'web',
    viewport: { width: 1280, height: 720 },
    steps: [{ kind: 'click', label: 'board', at: { x: 320, y: 360 }, release: true }],
    assert: { diagnostics: { runtimeReady: true } },
  }));
  const paths = await writeRunScenarios(project, {
    project, scenario: join(project, 'playtests/flight.playtest.json'), duration: 1, warmup: 1,
    target: 'desktop', renderSize: { width: 1920, height: 1080 },
  });
  const native = JSON.parse(readFileSync(paths.nativeWorkloadPath, 'utf8'));
  assert.deepEqual(native.steps[0], {
    label: 'board', pointerPosition: { buttons: 1, x: 0.25, y: 0.5 }, release: true,
  });
});

test('generated production workload runs through the playtest validator and keeps source bounds out of band', async () => {
  const project = makeTempDirSync('tn-prd064-scenario-');
  temporary.push(project);
  mkdirSync(join(project, 'playtests'));
  const assertion = { performance: { maxDrawCalls: 180, maxFrameMsP95: 15, maxTriangles: 100_000, minFps: 30 } };
  writeFileSync(join(project, 'playtests/performance.playtest.json'), JSON.stringify({
    assert: assertion,
    artifacts: { screenshots: 'after' },
    name: 'production-performance',
    schemaVersion: 1,
    steps: [{ kind: 'wait', waitFrames: 10 }],
  }));

  const paths = await writeRunScenarios(project, {
    duration: 1,
    renderSize: { height: 1080, width: 1920 },
    target: 'desktop',
    warmup: 1,
  });
  const workload = JSON.parse(readFileSync(paths.workloadPath, 'utf8'));
  const nativeWorkload = JSON.parse(readFileSync(paths.nativeWorkloadPath, 'utf8'));
  assert.deepEqual(workload.assert, { diagnostics: { noConsoleErrors: true, runtimeReady: true } });
  assert.equal(nativeWorkload.assert.diagnostics, undefined);
  assert.equal(nativeWorkload.assert.startup.maxReadyMs > 0, true);
  assert.equal(workload.assert.performance, undefined);
  assert.deepEqual(paths.performanceBounds, assertion.performance);
  assert.equal(nativeWorkload.artifacts.screenshots, 'after');

  const playtest = await import(new URL('../../playtest/dist/index.js', import.meta.url).href);
  const runner = await import(new URL('../../playtest/dist/runner/index.js', import.meta.url).href);
  const scenario = await playtest.loadPlaytestScenario(project, paths.workloadPath);
  const report = runner.buildReport(
    {
      artifactDirectory: project,
      headless: true,
      projectPath: project,
      scenarioPath: paths.workloadPath,
      timeoutMs: 1_000,
      trace: false,
      url: 'http://127.0.0.1:41777',
    },
    scenario,
    undefined,
    undefined,
    [],
    [],
    undefined,
    {},
    true,
  );
  assert.equal(report.diagnostics.some(({ code }) => code === 'TN_PLAYTEST_SCENARIO_INVALID'), false);
  assert.equal(report.pass, true);

  const androidPaths = await writeRunScenarios(project, {
    duration: 2,
    renderSize: { height: 1080, width: 1920 },
    target: 'android',
    warmup: 1,
  });
  const androidWorkload = JSON.parse(readFileSync(androidPaths.nativeWorkloadPath, 'utf8'));
  assert.equal(androidWorkload.steps.length, 61);
  assert.deepEqual(androidWorkload.steps[0], {
    holdFrames: 60,
    kind: 'input',
    press: 'ArrowRight',
    release: true,
  });
  assert.deepEqual(androidWorkload.steps.at(-1), { kind: 'wait', release: true, waitFrames: 1 });

  const regressionPaths = await writeRunScenarios(project, {
    duration: 30,
    profile: 'regression',
    renderSize: { height: 1080, width: 1920 },
    target: 'android-physical',
    warmup: 5,
  });
  const regressionWorkload = JSON.parse(readFileSync(regressionPaths.workloadPath, 'utf8'));
  const regressionNativeWorkload = JSON.parse(readFileSync(regressionPaths.nativeWorkloadPath, 'utf8'));
  assert.deepEqual(regressionWorkload.assert.movement, { entity: 'player', minDistance: 0.1 });
  assert.equal(regressionNativeWorkload.artifacts.screenshots, 'after');
  assert.equal(regressionNativeWorkload.steps.length, 1_741);
  assert.equal(regressionNativeWorkload.steps.at(-1).waitFrames, 1);

  const rendererPerformance = { drawCalls: 180, triangles: 100_000 };
  const nativeSamples = injectedFrameSamples(
    nativeFrameInstrumentation(undefined, 0),
    rendererPerformance,
  );
  const webSamples = injectedFrameSamples(
    webFrameInstrumentation(undefined, 0),
    rendererPerformance,
  );
  assert.equal(nativeSamples.sampledBeforeRender, false);
  assert.equal(webSamples.sampledBeforeRender, false);
  assert.equal(nativeSamples.samples.length, 30);
  assert.equal(webSamples.samples.length, 30);
  assert.ok(nativeSamples.sampleLines.every((line) => line.length < 1_000));
  // The web arm reports over the console like the native one. It used to POST to a marker server,
  // and the playtest's own noNetworkErrors policy then failed every web run for the profile's own
  // instrumentation: Chromium reports each in-flight fetch as net::ERR_ABORTED at page teardown.
  assert.deepEqual(webSamples.requests, []);
  assert.equal(webSamples.sampleLines.length, 1);
  assert.ok(webSamples.sampleLines[0].startsWith('TN_PROD_FRAME_SAMPLES:'));
  assert.deepEqual(nativeSamples.samples[0], { clockMs: 14, drawCalls: 180, frameIndex: 1, frameMs: 14, presentationMs: 14, triangles: 100_000 });
  assert.deepEqual(webSamples.samples[0], { clockMs: 14, drawCalls: 180, frameIndex: 1, frameMs: 14, presentationMs: 14, triangles: 100_000 });
  const missingSamples = injectedFrameSamples(
    webFrameInstrumentation(undefined, 0),
    undefined,
  );
  assert.equal(Object.hasOwn(missingSamples.samples[0], 'drawCalls'), false);
  assert.equal(Object.hasOwn(missingSamples.samples[0], 'triangles'), false);

  const frame = new PNG({ height: 2, width: 2 });
  frame.data.fill(255);
  frame.data[0] = 0;
  const screenshot = PNG.sync.write(frame);
  const evidence = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: undefined,
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'web',
      warmup: 0,
    },
    performanceBounds: paths.performanceBounds,
    project,
    runId: 'source-bounds',
    startedAt: new Date().toISOString(),
    web: {
      applicationClass: 'fixture',
      artifactSha,
      driverClass: 'fixture',
      kind: 'web',
      runs: [{ report: { pass: true }, screenshot, series: webSamples.samples, status: 0 }],
      startups: [{ firstFrameMs: 100, report: { pass: true }, screenshot, status: 0 }],
    },
  });
  assert.deepEqual(evidence.budget, {
    maxDrawCalls: 180,
    maxFrameMsP95: 15,
    maxP99FrameMs: 33,
    maxStartupMs: 5_000,
    maxTriangles: 100_000,
    minMeanFps: 60,
    minFps: 30,
  });
  assert.equal(evaluateProductionEvidence(evidence).status, 'PASS');
  assert.equal(evidence.metrics.drawCalls, 180);
  assert.equal(evidence.metrics.triangles, 100_000);

  const missingCounterResult = evaluateProductionEvidence({
    ...evidence,
    metrics: {
      ...evidence.metrics,
      ...aggregateMetrics(
        [{ series: missingSamples.samples }],
        [{ firstFrameMs: 100, report: { pass: true }, screenshot, status: 0 }],
      ),
    },
  });
  assert.equal(missingCounterResult.status, 'FAIL');
  assert.ok(missingCounterResult.codes.includes('TN_PROD_PERFORMANCE_BUDGET'));

  const p95Failure = evaluateProductionEvidence({
    ...evidence,
    metrics: {
      ...evidence.metrics,
      frameIntervalsMs: [16],
      intervals: [{ drawCalls: 180, frameMs: 16, timestampMs: 0, triangles: 100_000 }],
      meanFps: 62.5,
      p95FrameMs: undefined,
      p99FrameMs: 16,
    },
  });
  assert.equal(p95Failure.status, 'FAIL');
  assert.ok(p95Failure.codes.includes('TN_PROD_PERFORMANCE_BUDGET'));

  const drawCallFailure = evaluateProductionEvidence({
    ...evidence,
    metrics: {
      ...evidence.metrics,
      drawCalls: 181,
      intervals: [{ drawCalls: 181, frameMs: 14, timestampMs: 0, triangles: 100_000 }],
    },
  });
  assert.equal(drawCallFailure.status, 'FAIL');
  assert.ok(drawCallFailure.codes.includes('TN_PROD_PERFORMANCE_BUDGET'));

  const triangleFailure = evaluateProductionEvidence({
    ...evidence,
    metrics: {
      ...evidence.metrics,
      intervals: [{ drawCalls: 180, frameMs: 14, timestampMs: 0, triangles: 100_001 }],
      triangles: 100_001,
    },
  });
  assert.equal(triangleFailure.status, 'FAIL');
  assert.ok(triangleFailure.codes.includes('TN_PROD_PERFORMANCE_BUDGET'));
});

test('an existing project baseline without an authored performance bound is not failed by the platformer budget', () => {
  const frame = new PNG({ height: 2, width: 2 });
  frame.data.fill(255);
  frame.data[0] = 0;
  const screenshot = PNG.sync.write(frame);
  const series = Array.from({ length: 30 }, (_, index) => ({
    clockMs: index * 25,
    frameIndex: index + 1,
    frameMs: 25,
    presentationMs: index * 25,
  }));
  const evidence = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: undefined,
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      profile: 'production',
      project: '/fixture/existing-project',
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'web',
      warmup: 0,
    },
    performanceBounds: undefined,
    project: '/fixture/existing-project',
    runId: 'existing-project-baseline',
    startedAt: new Date().toISOString(),
    web: {
      applicationClass: 'fixture',
      artifactSha,
      driverClass: 'fixture',
      kind: 'web',
      runs: [{ report: { pass: true }, screenshot, series, status: 0 }],
      startups: [{ firstFrameMs: 100, report: { pass: true }, screenshot, status: 0 }],
    },
  });
  assert.equal(Object.hasOwn(evidence.budget, 'maxP99FrameMs'), false);
  assert.equal(Object.hasOwn(evidence.budget, 'maxStartupMs'), false);
  assert.equal(Object.hasOwn(evidence.budget, 'minMeanFps'), false);
  const result = evaluateProductionEvidence(evidence);
  assert.equal(result.codes.includes('TN_PROD_PERFORMANCE_BUDGET'), false);
  assert.equal(result.codes.includes('TN_PROD_STARTUP_BUDGET'), false);
  assert.notEqual(result.status, 'FAIL');
});

test('post-warmup frame metrics exclude warmup samples from mean and percentiles', () => {
  const samples = [
    { frameIndex: 1, frameMs: 500, presentationMs: 0 },
    { frameIndex: 2, frameMs: 400, presentationMs: 500 },
    { frameIndex: 61, frameMs: 16, presentationMs: 4_000 },
    { frameIndex: 62, frameMs: 17, presentationMs: 4_016 },
  ];
  assert.deepEqual(postWarmupFrameSamples(samples, 60), samples.slice(2));
  assert.deepEqual(postWarmupFrameSamples([{ frameMs: 500 }, { frameMs: 400 }, { frameMs: 16 }], 2), [{ frameMs: 16 }]);
  const metrics = aggregateMetrics([{ series: samples }], [], 60);
  const expected = aggregateMetrics([{ series: samples.slice(2) }], [], 0);
  assert.deepEqual(metrics.frameIntervalsMs, expected.frameIntervalsMs);
  assert.equal(metrics.meanFps, expected.meanFps);
  assert.equal(metrics.p99FrameMs, expected.p99FrameMs);
  // One presented frame separates the two post-warmup samples, so the series is one interval long
  // however many warmup callbacks preceded it.
  assert.deepEqual(metrics.frameIntervalsMs, [16]);
});

/**
 * One second of the shape this harness actually collects: three rAF callbacks per presented frame
 * at 60 Hz. The native host stamps every callback it dispatches in one frame with the same
 * timestamp (`runtime.cpp` `executeAnimationFrameCallbacks`), and the engine loop, the UI hit-test
 * pump and the profile itself each register one. The callback deltas are real readings of the
 * per-callback cost the arms reported on this host — native 0.48 ms, web 1.70 ms — so the sample
 * that straddles the display period is the *remainder* of a fixed 16.6 ms and the faster arm
 * carries the larger one.
 */
function callbacksPerPresentedFrame({ perCallbackMs, presentedPeriodMs = 16.6, frames = 60 }) {
  const straddlingMs = presentedPeriodMs - perCallbackMs * 2;
  const series = [];
  let clockMs = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const [index, frameMs] of [perCallbackMs, perCallbackMs, straddlingMs].entries()) {
      clockMs += frameMs;
      series.push({
        clockMs,
        frameIndex: frame * 3 + index,
        frameMs,
        presentationMs: frame * presentedPeriodMs,
      });
    }
  }
  return series;
}

function nonBlankScreenshot() {
  const frame = new PNG({ height: 2, width: 2 });
  frame.data.fill(255);
  frame.data[0] = 0;
  return PNG.sync.write(frame);
}

test('frame metrics come from successive presented frames, not from rAF callback deltas', () => {
  const series = callbacksPerPresentedFrame({ perCallbackMs: 0.48 });
  const metrics = aggregateMetrics([{ series }], []);
  // 180 callbacks, 60 presented frames, and the first presented stamp has nothing to pair with.
  assert.equal(series.length, 180);
  assert.deepEqual(metrics.frameIntervalsMs.map((value) => Math.round(value * 100) / 100), Array.from({ length: 59 }, () => 16.6));
  assert.equal(Math.round(metrics.p50FrameMs * 100) / 100, 16.6);
  assert.equal(Math.round(metrics.p95FrameMs * 100) / 100, 16.6);
  assert.equal(Math.round(metrics.p99FrameMs * 100) / 100, 16.6);
  assert.equal(Math.round(metrics.meanFps * 100) / 100, 60.24);
  // The callback diagnostics the evidence also carries are untouched: 180 per-callback samples,
  // each with the delta the host actually reported, while the counts are the presented frames.
  assert.equal(metrics.sampleCount, 59);
  assert.equal(metrics.intervals.length, 180);
  assert.equal(metrics.intervals[0].frameMs, 0.48);
  assert.equal(metrics.intervals[2].frameMs, 15.64);
  assert.equal(Math.round(metrics.worstFrameMs * 100) / 100, 16.6);
});

test('the one-second floor and the sample counts count presented frames, not the three callbacks each frame runs', () => {
  // 25 ms presented frames at three rAF callbacks per frame: the display presents 40 a second and
  // the host records 120 callback records for them. 25 divides exactly in binary, so the per-second
  // buckets land where the arithmetic says they do.
  const series = callbacksPerPresentedFrame({ frames: 100, perCallbackMs: 1, presentedPeriodMs: 25 });
  const metrics = aggregateMetrics([{ series }], []);
  assert.equal(series.length, 300);
  // Two full seconds of presented frames, and the callbacks that ran inside them are still there.
  assert.deepEqual(metrics.oneSecondFps, [40, 40]);
  assert.equal(metrics.runWindows[0].sampleCount, 99);
  assert.equal(metrics.sampleCount, 99);
  assert.equal(metrics.intervals.length, 300);
  // The floor is what a `minOneSecondFps` budget reads. Counting callbacks answers 120 here, which
  // passes a 60 fps floor on a display that presented 40; the presented answer must fail it.
  assert.deepEqual(evaluateFrameBudget(metrics, { minOneSecondFps: 60 }).floors, [40, 40]);
  assert.deepEqual(
    evaluateFrameBudget(metrics, { minOneSecondFps: 60 }).failures,
    ['TN_PROD_PERFORMANCE_BUDGET'],
  );

  // A dropped frame whose cost is split across three callbacks is still a dropped frame. Nine
  // presented frames here each missed a display period, while the callback stream they were split
  // into never exceeded 25 ms and so counted no hitch at all.
  const dropped = aggregateMetrics(
    [{ series: callbacksPerPresentedFrame({ frames: 10, perCallbackMs: 25, presentedPeriodMs: 75 }) }],
    [],
  );
  assert.equal(dropped.hitchCount, 9);
  assert.equal(dropped.worstFrameMs, 75);
});

test('a sample the presentation clock cannot place voids the presented series', () => {
  const series = callbacksPerPresentedFrame({ frames: 4, perCallbackMs: 0.48 });
  const malformed = [undefined, Number.NaN, 'later'];
  for (const presentationMs of malformed) {
    const tampered = series.map((sample, index) => (index === 5 ? { ...sample, presentationMs } : sample));
    const metrics = aggregateMetrics([{ series: tampered }], []);
    // A partial cadence would publish a percentile of the frames that happened to survive, so the
    // series stays unmeasured: the budget then fails on the missing mean and a pair blocks.
    assert.equal(metrics.frameIntervalsMs, undefined);
    assert.equal(metrics.p50FrameMs, undefined);
    assert.equal(metrics.p95FrameMs, undefined);
    assert.equal(metrics.meanFps, undefined);
    assert.equal(metrics.presentationClockSource, 'missing');
    // The loss is named rather than hidden: the callbacks were still collected, and the counts
    // publish no presented frame at all rather than the three-per-frame multiples they would carry.
    assert.equal(metrics.intervals.length, tampered.length);
    assert.equal(metrics.sampleCount, undefined);
    assert.equal(metrics.runWindows, undefined);
  }
  // A stamp that goes backwards is not a presented frame either.
  const backwards = series.map((sample, index) => (index === 5 ? { ...sample, presentationMs: 0 } : sample));
  assert.equal(aggregateMetrics([{ series: backwards }], []).frameIntervalsMs, undefined);
});

test('a pair whose native callbacks read worse is compared on presented frame cadence', () => {
  const screenshot = nonBlankScreenshot();
  const arm = (perCallbackMs, kind) => ({
    applicationClass: 'fixture',
    artifactSha: sha256(Buffer.from(`fixture-artifact-${kind}`)),
    driverClass: `${kind}-driver`,
    kind,
    runs: [{ report: { pass: true }, screenshot, series: callbacksPerPresentedFrame({ perCallbackMs }), status: 0 }],
    startups: [{ firstFrameMs: 100, report: { pass: true }, screenshot, status: 0 }],
  });
  const evidence = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: arm(0.48, 'desktop'),
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'desktop-pair',
      warmup: 0,
    },
    performanceBounds: undefined,
    project: '/fixture',
    runId: 'presented-pair',
    startedAt: new Date().toISOString(),
    web: arm(1.7, 'web'),
  });
  // The callback statistic this replaced read native 15.64 against web 13.20 — a difference created
  // by which arm spent less time per callback, with both arms presenting at the same 16.6 ms.
  assert.equal(Math.round(evidence.metrics.native.p95FrameMs * 100) / 100, 16.6);
  assert.equal(Math.round(evidence.metrics.web.p95FrameMs * 100) / 100, 16.6);
  assert.equal(Math.round(evidence.metrics.native.p50FrameMs * 100) / 100, 16.6);
  assert.equal(Math.round(evidence.metrics.web.p50FrameMs * 100) / 100, 16.6);
  const result = evaluateProductionEvidence(evidence);
  assert.equal(result.status, 'PASS');
  assert.deepEqual(result.codes, []);

  // One arm's stamps unreadable is not a pair that compares well; it is a pair with no cadence.
  const broken = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: {
      ...arm(0.48, 'desktop'),
      runs: [{
        report: { pass: true },
        screenshot,
        series: callbacksPerPresentedFrame({ perCallbackMs: 0.48 }).map((sample, index) => (index === 5 ? { ...sample, presentationMs: undefined } : sample)),
        status: 0,
      }],
    },
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'desktop-pair',
      warmup: 0,
    },
    performanceBounds: undefined,
    project: '/fixture',
    runId: 'presented-pair-broken',
    startedAt: new Date().toISOString(),
    web: arm(1.7, 'web'),
  });
  const blocked = evaluateProductionEvidence(broken);
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.exitCode, 2);
  assert.ok(blocked.codes.includes('TN_PROD_COMPARISON_METRICS_INCOMPLETE'));
});

test('paced native instrumentation waits one display interval per fixed-step tick', () => {
  const paced = nativeFrameInstrumentation(undefined, 0, true);
  assert.match(paced, /const tnProductionPaceEnabled = true;/u);
  assert.match(paced, /tnProductionBridge\.advance = async \(ticks\)/u);
  assert.match(paced, /tnProductionTickIntervalMs = 16\.666/u);
  assert.match(paced, /tnProductionInstallPace\(\);/u);
  assert.match(nativeFrameInstrumentation(undefined, 0), /const tnProductionPaceEnabled = false;/u);
});

test('native instrumentation caches the async bridge sample for the next frame', async () => {
  let scheduled;
  let now = 0;
  const samples = [];
  const context = {
    __THREENATIVE_PLAYTEST_BRIDGE__: {
      sample: async () => ({ performance: { drawCalls: 7, triangles: 11 } }),
    },
    cancelAnimationFrame: () => undefined,
    console: {
      log: (line) => {
        const prefix = 'TN_PROD_FRAME_SAMPLES:';
        if (typeof line === 'string' && line.startsWith(prefix)) samples.push(...JSON.parse(line.slice(prefix.length)));
      },
    },
    performance: { now: () => now },
    requestAnimationFrame: (callback) => { scheduled = callback; return 1; },
  };
  runInNewContext(nativeFrameInstrumentation(undefined, 0), context);
  const schedule = context.requestAnimationFrame;
  for (let frame = 0; frame <= 6; frame += 1) {
    scheduled = undefined;
    schedule(() => undefined);
    now = frame * 16;
    scheduled(now);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(samples.length > 1);
  const cached = samples.find((sample) => sample.drawCalls === 7);
  assert.ok(cached !== undefined);
  assert.equal(cached.triangles, 11);
});

test('scaffolded native profile paces the fixed step so the host renders the measured frames', async () => {
  const project = makeTempDirSync('tn-profile-paced-');
  temporary.push(project);
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'), '{}');
  writeFileSync(join(project, 'threenative.config.ts'), 'export default { nativeEntry: "src/game.ts" };');
  await installNativeProfileEntry(project, 'desktop', { warmup: 1 });
  assert.match(readFileSync(join(project, 'src/profile-native-entry.ts'), 'utf8'), /const tnProductionPaceEnabled = true;/u);
});

test('the warmup is the requested wall time, not a frame count read as 60fps', async () => {
  // A frame count only names a duration on a host that presents at 60 Hz. The native host runs its
  // loop at 100-170 Hz while it boots, so a 120-frame warmup elapsed in 1.18 s of a requested 2 s
  // and the measured window started inside first-use pipeline compilation: native read 26.29 mean
  // fps and 306.04 ms p95 for boot, and published `warmupSeconds: 2` beside it. Both arms warm up on
  // the host's own clock, and the frame bound stays because a host slower than 60 Hz needs it more.
  for (const source of [nativeFrameInstrumentation(undefined, 120), webFrameInstrumentation(undefined, 120)]) {
    let scheduled;
    let now = 0;
    const samples = [];
    const context = {
      cancelAnimationFrame: () => undefined,
      console: {
        log: (line) => {
          const prefix = 'TN_PROD_FRAME_SAMPLES:';
          if (typeof line === 'string' && line.startsWith(prefix)) samples.push(...JSON.parse(line.slice(prefix.length)));
        },
      },
      performance: { now: () => now },
      requestAnimationFrame: (callback) => { scheduled = callback; return 1; },
    };
    runInNewContext(source, context);
    const schedule = context.requestAnimationFrame;
    const pump = async (frame, frameMs) => {
      for (let index = 0; index < frame; index += 1) {
        scheduled = undefined;
        schedule(() => undefined);
        now += frameMs;
        scheduled(now);
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    // 120 frames at 8 ms is the whole frame budget spent in 0.96 s: the seconds are not.
    await pump(120, 8);
    assert.equal(samples.length, 0);
    // 2.05 s of host time, five native batches later, and the measurement is collecting.
    await pump(200, 8);
    assert.ok(samples.length > 0);
    assert.ok(samples.every((sample) => sample.clockMs >= 2_000));
  }
});

test('the first measured frame starts the window, so a crossing stall is not reported as gameplay', async () => {
  // The wall-time bound is only reached once the frame count is, and the host can take a large step
  // on the way. Clearing the carry on the frame count left the last warmup frame still holding its
  // clock, so the first measured sample carried the whole crossing as its frame time.
  for (const source of [nativeFrameInstrumentation(undefined, 3), webFrameInstrumentation(undefined, 3)]) {
    let scheduled;
    let now = 0;
    const samples = [];
    const context = {
      cancelAnimationFrame: () => undefined,
      console: {
        log: (line) => {
          const prefix = 'TN_PROD_FRAME_SAMPLES:';
          if (typeof line === 'string' && line.startsWith(prefix)) samples.push(...JSON.parse(line.slice(prefix.length)));
        },
      },
      performance: { now: () => now },
      requestAnimationFrame: (callback) => { scheduled = callback; return 1; },
    };
    runInNewContext(source, context);
    const schedule = context.requestAnimationFrame;
    const pump = async (frameMs) => {
      scheduled = undefined;
      schedule(() => undefined);
      now += frameMs;
      scheduled(now);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    // Three frames is the whole 50 ms warmup budget, but they spent only 16 ms of it; five more
    // frames are still inside the window when the host's clock takes a 500 ms step, and that step is
    // the crossing. Clearing the carry on the frame count published it as the first measured frame.
    for (let index = 0; index < 7; index += 1) await pump(8);
    await pump(500);
    assert.equal(samples.length, 0);
    for (let index = 0; index < 40; index += 1) await pump(8);
    assert.ok(samples.length > 0);
    // The transition frame is the boundary, not a measurement: the first sample is the frame after it.
    assert.equal(samples[0].frameIndex, 8);
    assert.ok(samples.every((sample) => sample.frameMs <= 8), `a ${samples[0].frameMs} ms crossing was measured as gameplay`);
  }
});

test('a live-clock profile asks the game for the wall clock and keeps the idempotent pace', async () => {
  const project = makeTempDirSync('tn-profile-live-clock-');
  temporary.push(project);
  mkdirSync(join(project, 'src'));
  writeFileSync(join(project, 'package.json'), '{}');
  writeFileSync(join(project, 'threenative.config.ts'), 'export default { nativeEntry: "src/game.ts" };');
  // Both clocks pace the scaffolded workload. On the live clock `advance` already waits the wall time
  // those ticks name, so the pacer's remainder is zero and it adds nothing; disabling it there is
  // what let the native host consume the frame count at its own speed.
  await installNativeProfileEntry(project, 'desktop', { liveClock: true, warmup: 1 });
  const entry = readFileSync(join(project, 'src/profile-native-entry.ts'), 'utf8');
  assert.match(entry, /globalThis\.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";/u);
  assert.match(entry, /const tnProductionPaceEnabled = true;/u);
  // The default run is unchanged: no clock request, and the synthetic workload still paced.
  const paced = makeTempDirSync('tn-profile-fixed-clock-');
  temporary.push(paced);
  mkdirSync(join(paced, 'src'));
  writeFileSync(join(paced, 'package.json'), '{}');
  writeFileSync(join(paced, 'threenative.config.ts'), 'export default { nativeEntry: "src/game.ts" };');
  await installNativeProfileEntry(paced, 'desktop', { warmup: 1 });
  const defaultEntry = readFileSync(join(paced, 'src/profile-native-entry.ts'), 'utf8');
  assert.doesNotMatch(defaultEntry, /__THREENATIVE_PLAYTEST_CLOCK__/u);
  assert.match(defaultEntry, /const tnProductionPaceEnabled = true;/u);
  // The artifact names the clock it ran on, because a rate read off a frozen loop is not a frame rate.
  assert.match(readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8'),
    /clock: options\.liveClock === true \? 'wall-clock' : 'fixed-step',/u);
  // Through the CLI, because the option set is rebuilt field by field and an unlisted flag reaches
  // nothing: the run would have paced and frozen exactly as asked while the artifact said otherwise.
  assert.equal(parseProductionArgs(['--target', 'desktop', '--live-clock']).liveClock, true);
  assert.equal(parseProductionArgs(['--target', 'desktop']).liveClock, false);
});

test('slow-path control is bounded and returns the intended exit-1 budget failure', async () => {
  const output = makeTempDirSync('tn-prd064-slow-path-');
  temporary.push(output);
  assert.match(nativeFrameInstrumentation('slow-native', 3_600), /tnProductionSlowFramesRemaining = 60/u);
  assert.match(nativeFrameInstrumentation('slow-native', 3_600), /tnProductionSlowFramesRemaining -= 1/u);
  const started = performance.now();
  const result = await runProductionProfile({
    control: 'slow-path',
    duration: 60,
    out: join(output, 'run'),
    repetitions: 1,
    target: 'fixture',
    warmup: 60,
  });
  assert.ok(performance.now() - started < 2_000);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.codes, ['TN_PROD_PERFORMANCE_BUDGET']);
});

test('desktop screenshot evidence uses the host post-present mailbox protocol', () => {
  const profile = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/runtime.cpp', import.meta.url), 'utf8');
  assert.doesNotMatch(profile, /runNativeScreenshot/u);
  assert.doesNotMatch(profile, /spawnNative\([^\n]+,\s*true\)/u);
  assert.match(profile, /tn-playtest-screenshot-request\.txt/u);
  assert.match(profile, /writeFile\(temporary, path, 'utf8'\)/u);
  assert.match(profile, /rm\(join\(root, 'tn-playtest-screenshot-request\.txt'\), \{ force: true \}\)/u);
  assert.match(profile, /screenshot: async \(path\)/u);
  assert.doesNotMatch(profile, /tn-production-screenshot-request\.json|nativeHost\?\.playtest\?\.receive|captureScreenshot/u);
  assert.match(runtime, /tn-playtest-screenshot-request\.txt/u);
});

test('native screenshot mapping keeps asynchronous callback state alive after a timeout', () => {
  const context = readFileSync(new URL('../src/webgpu/context.cpp', import.meta.url), 'utf8');
  assert.match(context, /using BufferMapDataPtr = std::shared_ptr<BufferMapData>/u);
  assert.match(context, /new BufferMapDataPtr\(mapData\)/u);
  assert.match(context, /WGPUCallbackMode_AllowSpontaneous/u);
  assert.doesNotMatch(context, /userdata1 = &mapData/u);
});

test('desktop production profiling keeps mailbox operations shorter than the scenario budget', () => {
  const profile = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  assert.match(profile, /new runner\.DeviceMailboxTransport\(mailbox, \{ request: requestPath, response: responsePath \}\)/u);
  assert.match(profile, /target: 'android',\n {4}timeoutMs,/u);
  assert.doesNotMatch(profile, /const timeoutMs = 30_000;/u);
  assert.match(profile, /scenarios\.timeoutMs/u);
});

test('playtest assertion failure cannot become a clean production run', () => {
  const frame = new PNG({ height: 2, width: 2 });
  frame.data.fill(255);
  frame.data[0] = 0;
  const evidence = assembleEvidence({
    context: { audioEvidence: {}, physicalEvidence: {}, sourceSha, sourceState: { dirty: false } },
    native: undefined,
    options: {
      coldStarts: 1,
      control: undefined,
      device: undefined,
      renderSize: { height: 1080, width: 1920 },
      repetitions: 1,
      target: 'web',
      warmup: 0,
    },
    project: 'fixture-project',
    runId: 'assertion-failure',
    startedAt: new Date().toISOString(),
    web: {
      applicationClass: 'fixture',
      artifactSha,
      driverClass: 'fixture',
      kind: 'web',
      runs: [{ report: { pass: false }, screenshot: PNG.sync.write(frame), series: [{ frameMs: 16 }], status: 1 }],
      startups: [{ firstFrameMs: 100, report: { pass: true }, screenshot: PNG.sync.write(frame), status: 0 }],
    },
  });
  const result = evaluateProductionEvidence(evidence);
  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.exitCode, 2);
  assert.ok(result.codes.includes('TN_PROD_PLAYTEST_FAILED'));
  assert.equal(evidence.markers.includes('clean-end'), false);
});

test('redaction rejects secrets before creating an output directory', async () => {
  const output = makeTempDirSync('tn-prd058-redaction-');
  temporary.push(output);
  const target = join(output, 'report');
  await assert.rejects(
    writeProductionEvidence(completeEvidence({ identity: { serial: 'emulator-5554', path: '/home/joao/private', authorization: 'Bearer secret' } }), target),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_REDACTION',
  );
  assert.throws(() => readFileSync(join(target, 'production-evidence.json')), /ENOENT/);
});

test('profile control retains an immutable fixture artifact and returns FAIL', async () => {
  const output = makeTempDirSync('tn-prd058-profile-');
  temporary.push(output);
  const result = await runProductionProfile({ control: 'slow-path', duration: 60, out: join(output, 'run'), repetitions: 1, target: 'fixture', warmup: 1 });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.ok(result.codes.includes('TN_PROD_PERFORMANCE_BUDGET'));
  assert.ok(result.metrics.p99FrameMs > 33);
  assert.equal(result.control, 'slow-path');
  assert.deepEqual(result.evidenceClasses, ['negative-control']);
  assert.match(readFileSync(result.manifestPath, 'utf8'), /productionEvidenceV1/u);
});

test('slow-startup delays the live fixture launch beyond the five-second budget', async () => {
  const output = makeTempDirSync('tn-prd064-startup-');
  temporary.push(output);
  const result = await runProductionProfile({
    control: 'slow-startup',
    out: join(output, 'run'),
    target: 'fixture',
  });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.exitCode, 1);
  assert.ok(result.codes.includes('TN_PROD_STARTUP_BUDGET'));
  assert.ok(result.metrics.startupP95Ms > 5_000);
  assert.ok(result.markers.includes('clean-end'));
});

test('one interval the clock cannot resolve does not void every other reading', () => {
  // Two presented frames can land inside a single `performance.now()` quantum and read as a
  // zero-length interval. That is the clock's resolution, not a measurement of the workload, and
  // one such sample used to make the mean undefined — which blocked the desktop comparison outright
  // instead of reporting the pair it had 12,000 good readings for.
  const intervals = [...Array.from({ length: 1_000 }, () => 16), 0];
  assert.equal(Math.round(meanFps(intervals) * 100) / 100, 62.5);
  assert.equal(meanFps([0, 0]), undefined);
  assert.equal(meanFps([]), undefined);
  assert.equal(unmeasurableIntervalCount(intervals), 1);
  assert.equal(unmeasurableIntervalCount([16, 16]), 0);
});

test('one malformed sample voids the series, because only a zero is the clock, not a defect', () => {
  // The zero-length exemption is for the clock alone. NaN, a negative and Infinity are malformed
  // readings, so dropping them from the series would silently publish a passing frame rate from
  // the surviving good ones; the series stays unmeasured and the budget fails on the missing mean.
  assert.equal(meanFps([16, Number.NaN, 16]), undefined);
  assert.equal(meanFps([16, -1, 16]), undefined);
  assert.equal(meanFps([16, Number.POSITIVE_INFINITY, 16]), undefined);
  assert.equal(meanFps([Number.NaN, 0]), undefined);
  assert.equal(unmeasurableIntervalCount([16, Number.NaN, 16]), 0);
});

test('a web frame rate measured on a private Xvfb is refused, because that lane cannot carry one', () => {
  // Two collections of the same built platformer at 1920x1080 on this host: the private-display web
  // arm reported 33.97 fps mean and a 117.1 ms p99, the session-display arm 163.45 fps and 19.6 ms.
  // The private lane is not the player's experience, so a run that would judge the budget on it
  // refuses before collecting rather than publishing a number.
  const fault = webRateDisplayFault({ kind: 'private-xvfb', screen: '1600x900x24' });
  assert.equal(fault?.code, 'TN_PROD_DISPLAY_UNTRUSTWORTHY');
  assert.match(fault.message, /TN_PLAYTEST_HOST_DISPLAY=1/u);
  // The opt-in lane the runner itself selects, and a non-Linux host that owns its display.
  assert.equal(webRateDisplayFault({ display: ':0', kind: 'existing' }), undefined);
  assert.equal(webRateDisplayFault({ kind: 'host' }), undefined);
});

test('the web identity names the display the frame rate was read from', () => {
  // `observations.hardwareIdentity` was the key this read and no producer ever wrote it, so every
  // web artifact published an identity with no GPU in it. The display is the field that separates
  // this host's two web collections, and it is published from the decision the runner made.
  assert.deepEqual(webRateIdentity({ display: { display: ':0', kind: 'existing' }, runs: [{}] }), {
    webDisplay: 'session::0',
  });
  assert.deepEqual(webRateIdentity({ display: { kind: 'host' }, runs: [{}] }), { webDisplay: 'host' });
  const observedRun = { report: { observations: { pipelineCensus: { adapter: { identity: 'webgpu:architecture=turing|vendor=nvidia' } } } } };
  assert.deepEqual(webRateIdentity({ display: { kind: 'host' }, runs: [observedRun, observedRun] }), {
    webAdapter: 'webgpu:architecture=turing|vendor=nvidia',
    webDisplay: 'host',
  });
  assert.deepEqual(webRateIdentity({ runs: [observedRun, {}] }), {});
  assert.deepEqual(webRateIdentity({ runs: [observedRun, { report: { observations: { pipelineCensus: { adapter: { identity: 'webgpu:architecture=other|vendor=other' } } } } }] }), {});
  assert.deepEqual(webRateIdentity({ runs: [{}] }), {});
});

// Loads the real `privateDisplayCommand` selection out of the judge so a revert to `xvfb-run`
// (whose cleanup kill replaces the child's status) fails here rather than in a production run.
function loadPrivateDisplayCommand({ display, platform, wrapperPresent = true }) {
  const source = readFileSync(new URL('../scripts/profile-production.mjs', import.meta.url), 'utf8');
  const helper = sliceSource(source, 'function privateDisplayCommand(', 'function spawnNative(');
  assert.notEqual(helper.length, 0, 'profile-production.mjs must select its display through privateDisplayCommand');
  const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
  const context = {
    ProductionEvidenceError,
    existsSync: () => wrapperPresent,
    join,
    process: { env: display === undefined ? {} : { DISPLAY: display }, platform },
    scriptDirectory: scripts,
  };
  runInNewContext(helper, context);
  return { command: context.privateDisplayCommand, scripts };
}

// A PATH whose `Xvfb` reports a display on fd 3 and stays alive, so the wrapper's exit-code
// propagation is exercised with no GPU and no real display.
function privateDisplaySandbox() {
  const root = makeTempDirSync('tn-prod-xvfb-');
  temporary.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['mktemp', 'tr', 'sleep', 'rm', 'cat', 'sh']) {
    const resolved = spawnSync('command', ['-v', tool], { encoding: 'utf8', shell: true }).stdout.trim();
    if (resolved.length > 0) symlinkSync(resolved, join(bin, tool));
  }
  writeFileSync(join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
  writeFileSync(join(bin, 'Xvfb'), '#!/bin/sh\necho 91 >&3\nexec sleep 30\n', { mode: 0o755 });
  return bin;
}

test('headless Linux profiling uses the packaged display wrapper, never xvfb-run', () => {
  const { command, scripts } = loadPrivateDisplayCommand({ display: undefined, platform: 'linux' });
  const selected = command('/tmp/mystral', ['run', 'game.js']);
  assert.equal(selected.command, '/bin/sh');
  assert.deepEqual([...selected.args], [join(scripts, 'xvfb.sh'), '/tmp/mystral', 'run', 'game.js']);
  assert.equal(selected.args.some((arg) => /xvfb-run/u.test(arg)), false);

  // A display the operator already owns, and a non-Linux host, run the executable directly.
  const withDisplay = loadPrivateDisplayCommand({ display: ':0', platform: 'linux' }).command('/tmp/mystral', ['run']);
  assert.equal(withDisplay.command, '/tmp/mystral');
  assert.deepEqual([...withDisplay.args], ['run']);
  const macos = loadPrivateDisplayCommand({ display: undefined, platform: 'darwin' }).command('/tmp/mystral', ['run']);
  assert.equal(macos.command, '/tmp/mystral');
  assert.deepEqual([...macos.args], ['run']);
});

test('headless Linux profiling fails closed when the packaged display wrapper is missing', () => {
  const { command } = loadPrivateDisplayCommand({ display: undefined, platform: 'linux', wrapperPresent: false });
  assert.throws(
    () => command('/tmp/mystral', ['run']),
    (error) => error instanceof ProductionEvidenceError && error.code === 'TN_PROD_XVFB_WRAPPER_UNAVAILABLE',
  );
});

test('the selected display wrapper hands back the child exit code without a real GPU', () => {
  const { command } = loadPrivateDisplayCommand({ display: undefined, platform: 'linux' });
  const selected = command('/bin/sh', ['-c', 'exit 9']);
  const result = spawnSync(selected.command, selected.args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: privateDisplaySandbox() },
    timeout: 30_000,
  });
  assert.equal(result.status, 9, result.stderr);
});

test('repository collection sentinel is red only when explicitly enabled', () => {
  if (process.env.TN_PRD058_CONTROL === 'collection-sentinel') {
    assert.fail('production-profile collection sentinel failed as requested');
  }
});
