import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { PNG } from 'pngjs';
import { afterEach, expect, test } from 'vitest';
import {
  DESKTOP_COLD_START_SEGMENTS,
  FIRST_FRAME_MARKER,
  READY_MARKER,
  analyzeColdStartMarkers,
  analyzeDesktopLog,
  analyzePresentTicks,
  analyzeSurfaceFormatMarkers,
  analyzeWorkerProof,
  inspectOverlayBuffer,
  inspectScreenshot,
} from '../scripts/verify-desktop-core.mjs';

/** One tick per 60 frames, presents keeping pace, as a healthy 300-frame run emits. */
const HEALTHY_TICKS = [60, 120, 180, 240, 300]
  .map((frames) => `TN_PRESENTS_TICK:{"frames":${frames},"presents":${frames}}`)
  .join('\n');

/**
 * The launch markers a real desktop run emits, with the bootstrap sets that precede the game's.
 *
 * The host evaluates its own bootstrap scripts through the same engine members as the game, so the
 * four eval segments genuinely fire more than once a launch — eleven times before `runtime_created`
 * on the 2026-09-03 desktop run. This fixture keeps one of those decoys so the analyzer is proven
 * to bracket on `game_eval_begin` rather than to take whatever it saw first.
 */
const COLD_START_MARKERS = [
  ['process', 0],
  ['compile_begin', 12.1],
  ['compile_complete', 12.4],
  ['execute_begin', 12.5],
  ['execute_complete', 12.6],
  ['runtime_created', 348.8],
  ['game_eval_begin', 348.9],
  ['compile_begin', 360.4],
  ['compile_complete', 408.9],
  ['execute_begin', 408.9],
  ['execute_complete', 450.4],
  ['first_frame', 531.5],
]
  .map(([segment, atMs]) => `TN_COLD_START:{"segment":"${segment}","atMs":${atMs.toFixed(3)}}`)
  .join('\n');

const roots = [];
/**
 * One clean 300-frame desktop run: 300 presented frames plus the capture gate's single refresh
 * present, which is what guarantees the saved screenshot postdates startup readiness.
 */
const CAPTURE_REFRESH = 'TN_CAPTURE_REFRESH_PRESENTS:1';
const SURFACE_FORMAT_MARKER =
  'TN_SURFACE_FORMAT:{"native":"bgra8unorm-srgb","render":"bgra8unorm","bridge":true,"present":"fifo"}';
const CLEAN_DESKTOP_LOG = `${READY_MARKER}\n${FIRST_FRAME_MARKER}\n${SURFACE_FORMAT_MARKER}\nRendered 300 frames in 9000ms\nTN_PRESENTS:301\n${CAPTURE_REFRESH}\n${HEALTHY_TICKS}\n${COLD_START_MARKERS}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('desktop log requires both markers, exact frame completion, and clean errors', () => {
  expect(analyzeDesktopLog(CLEAN_DESKTOP_LOG)).toEqual([]);
  expect(analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace('TN_PRESENTS:301\n', ''))).toContain(
    'missing TN_PRESENTS count',
  );
  // The defect itself: the overlay pass presenting a swapchain image of its own.
  expect(
    analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace('TN_PRESENTS:301', 'TN_PRESENTS:600')),
  ).toContain(
    'presented 600 times for 300 frames + 1 capture-refresh presents; expected exactly one present per frame plus the named refreshes',
  );
  expect(analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace(FIRST_FRAME_MARKER, 'FIRST_FRAME'))).toContain(
    `missing ${FIRST_FRAME_MARKER}`,
  );
  expect(analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace('300 frames', '299 frames'))).toContain(
    'missing exact 300-frame completion',
  );
  expect(analyzeDesktopLog(`${CLEAN_DESKTOP_LOG}\nWebGPU validation error`)).toContain(
    'WebGPU validation error',
  );
});

test('desktop format marker is required, parseable, and typed', () => {
  expect(analyzeSurfaceFormatMarkers(SURFACE_FORMAT_MARKER)).toEqual({
    failures: [],
    markers: [
      { bridge: true, native: 'bgra8unorm-srgb', present: 'fifo', render: 'bgra8unorm' },
    ],
  });
  expect(analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace(`${SURFACE_FORMAT_MARKER}\n`, ''))).toContain(
    'missing TN_SURFACE_FORMAT marker',
  );
  expect(analyzeSurfaceFormatMarkers('TN_SURFACE_FORMAT:{not-json}').failures[0]).toMatch(
    /^TN_SURFACE_FORMAT_MALFORMED:/u,
  );
  expect(
    analyzeSurfaceFormatMarkers('TN_SURFACE_FORMAT:{"native":"bgra8unorm","bridge":"no"}')
      .failures[0],
  ).toMatch(/^TN_SURFACE_FORMAT_INVALID:/u);
});

// The capture gate drives frames of its own to guarantee the saved screenshot postdates startup
// readiness, and each is one present beyond the requested count. Naming them keeps the
// one-present-per-frame invariant exact; an unnamed count would have to loosen it to `>=` and stop
// seeing the overlay defect the invariant exists for. So the count is required, and it is not a
// licence to present freely: the total must be frames plus exactly the number claimed.
test('capture-refresh presents are counted, not waved through', () => {
  expect(analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace(`${CAPTURE_REFRESH}\n`, ''))).toContain(
    'missing TN_CAPTURE_REFRESH_PRESENTS count',
  );
  expect(
    analyzeDesktopLog(CLEAN_DESKTOP_LOG.replace(CAPTURE_REFRESH, 'TN_CAPTURE_REFRESH_PRESENTS:50')),
  ).toContain(
    'presented 301 times for 300 frames + 50 capture-refresh presents; expected exactly one present per frame plus the named refreshes',
  );
  // A gate that needed no refresh at all is the healthy GPU case, and it still has to add up.
  const noRefresh = CLEAN_DESKTOP_LOG.replace('TN_PRESENTS:301', 'TN_PRESENTS:300').replace(
    CAPTURE_REFRESH,
    'TN_CAPTURE_REFRESH_PRESENTS:0',
  );
  expect(analyzeDesktopLog(noRefresh)).toEqual([]);
});

// PRD-328. The compile and execute markers existed only in `quickjs_engine.cpp`, which has not
// shipped on any platform since 2026-08-16, and the desktop CLI emitted none at all — so
// `measure-cold-start.mjs` failed closed on every real configuration and the only JavaScript
// parse-and-compile number anyone could quote (230 ms, 8 %) was a QuickJS one from 2026-08-11.
// This gate is what keeps the instrument running on the engine that actually ships.
test('cold-start markers fail closed on a missing segment and on time running backwards', () => {
  expect(analyzeColdStartMarkers(COLD_START_MARKERS).failures).toEqual([]);

  // Ledger row 1's negative control, as a unit: drop one mark and the gate names that mark.
  for (const segment of DESKTOP_COLD_START_SEGMENTS) {
    const without = COLD_START_MARKERS.split('\n')
      .filter((line) => !line.includes(`"segment":"${segment}"`))
      .join('\n');
    expect(analyzeColdStartMarkers(without).failures).toContain(
      `TN_COLD_START_MARKER_MISSING:${segment}`,
    );
  }

  // A misspelled segment is a missing one, never a silently accepted extra.
  expect(
    analyzeColdStartMarkers(COLD_START_MARKERS.replaceAll('"execute_begin"', '"exectue_begin"'))
      .failures,
  ).toContain('TN_COLD_START_MARKER_MISSING:execute_begin');

  // Misspelling only the bootstrap's copy changes nothing, because the bootstrap's copy is not
  // what the gate reads. This is the same bracketing rule stated as its converse.
  expect(
    analyzeColdStartMarkers(COLD_START_MARKERS.replace('"execute_begin"', '"exectue_begin"'))
      .failures,
  ).toEqual([]);

  expect(analyzeColdStartMarkers('TN_COLD_START:{"segment":"process"}').failures).toContain(
    'TN_COLD_START missing segment/atMs: {"segment":"process"}',
  );
  expect(analyzeColdStartMarkers('TN_COLD_START:{not json}').failures[0]).toMatch(
    /^malformed TN_COLD_START payload/u,
  );
});

test('cold-start markers read the game eval, not the bootstrap that precedes it', () => {
  // The whole reason `game_eval_begin` exists. Taking the first `compile_begin` in the log would
  // measure a 0.3 ms bootstrap script as though it were the game bundle.
  const { markers } = analyzeColdStartMarkers(COLD_START_MARKERS);
  expect(markers.get('compile_begin')).toBe(360.4);
  expect(markers.get('compile_complete') - markers.get('compile_begin')).toBeCloseTo(48.5, 1);

  // Order is part of the contract: a compile that completes before it began means two evaluations
  // were blended, and the segment computed from them is not a measurement.
  const reordered = COLD_START_MARKERS.replace(
    'TN_COLD_START:{"segment":"compile_complete","atMs":408.900}',
    'TN_COLD_START:{"segment":"compile_complete","atMs":120.000}',
  );
  expect(analyzeColdStartMarkers(reordered).failures[0]).toMatch(
    /^TN_COLD_START_SEGMENT_NEGATIVE:compile_begin->compile_complete/u,
  );
});

test('desktop worker evidence fails closed on rollback or an incomplete packed proof', () => {
  const proof = {
    callbacksAfterTerminate: 0,
    completionOrder: [2],
    framesAdvanced: 10,
    inputChecksum: 319126392,
    outputChecksum: 2110598008,
    sourceForm: 'classic-blob',
    workerIdentity: 'dedicated-worker',
  };
  const clean = [
    'TN_NATIVE_WORKER_CREATED:{"id":1,"engine":"V8"}',
    'TN_NATIVE_WORKER_TERMINATED:{"id":1}',
    `TN_NATIVE_WORKER_PROOF_PASS:${JSON.stringify(proof)}`,
  ].join('\n');

  expect(analyzeWorkerProof(clean)).toEqual({
    engine: 'V8',
    ...proof,
  });
  expect(analyzeWorkerProof(clean.replace('\nTN_NATIVE_WORKER_TERMINATED', '[Worker 1] ready\nTN_NATIVE_WORKER_TERMINATED'))).toEqual({
    engine: 'V8',
    ...proof,
  });
  expect(() => analyzeWorkerProof(clean.replace('TN_NATIVE_WORKER_TERMINATED:{"id":1}', ''))).toThrow(
    'missing TN_NATIVE_WORKER_TERMINATED',
  );
  expect(() => analyzeWorkerProof(`${clean}\nTN_NATIVE_WORKER_ROLLBACK_ACTIVE`)).toThrow(
    'TN_NATIVE_WORKER_ROLLBACK_ACTIVE',
  );
});

test('desktop screenshot rejects a single-color image and accepts visible pixels', () => {
  const root = makeTempDirSync('threenative-desktop-gate-');
  roots.push(root);
  const path = join(root, 'frame.png');
  const png = new PNG({ height: 1, width: 2 });
  png.data.set([0, 0, 0, 255, 0, 0, 0, 255]);
  writeFileSync(path, PNG.sync.write(png));
  expect(() => inspectScreenshot(path)).toThrow('blank');
  png.data.set([0, 0, 0, 255, 68, 170, 255, 255]);
  writeFileSync(path, PNG.sync.write(png));
  expect(inspectScreenshot(path)).toEqual({ height: 1, width: 2 });
});

test('desktop verifier preserves evidence and scopes its SDL drivers to Linux', () => {
  const source = readFileSync(
    new URL('../scripts/verify-desktop-core.mjs', import.meta.url),
    'utf8',
  );
  expect(source).toMatch(/desktop-\$\{process\.platform\}-report\.json/);
  expect(source).toMatch(/desktop-\$\{process\.platform\}\.log/);
  expect(source).toMatch(/sha256/);
  // Both driver overrides live in one `process.platform === 'linux'` branch and nowhere else, so
  // macOS and Windows keep the drivers SDL picks for them.
  const linuxBranch = source.match(
    /if \(process\.platform === 'linux'\) \{\n([\s\S]*?)\n\x20{2}\}/u,
  )?.[1];
  expect(linuxBranch).toBeDefined();
  // The driver is the caller's, not a literal: a Wayland request has to reach the child, which is
  // what src/cli/main.cpp reads before it refuses the web UI over Wayland. Both spellings are set,
  // so the child resolves the driver this gate read; x11 stays the default inside
  // requestedLinuxVideoDriver, which linux-video-driver-routing.spec.ts proves.
  expect(linuxBranch).toMatch(/runtimeEnv\.SDL_VIDEO_DRIVER = requested\.driver/);
  expect(linuxBranch).toMatch(/runtimeEnv\.SDL_VIDEODRIVER = requested\.driver/);
  expect(linuxBranch).not.toMatch(/SDL_VIDEODRIVER = 'x11'/);
  // The audio driver is a *default*, not an override: this gate makes no audio assertion, and a
  // machine with a real device must keep using it. `verify-desktop-audio.mjs` owns the audio
  // contract and runs before this gate in the same command.
  expect(linuxBranch).toMatch(/runtimeEnv\.SDL_AUDIODRIVER \?\?= 'dummy'/);
  expect(source).not.toMatch(/runtimeEnv\.SDL_AUDIODRIVER = 'dummy'/);
  // Neither may be forced for every platform at the spawn site.
  expect(source).not.toMatch(/env: \{ \.\.\.process\.env, SDL_VIDEODRIVER: 'x11' \}/);
  expect(source).not.toMatch(/env: \{ \.\.\.process\.env, SDL_AUDIODRIVER: 'dummy' \}/);
});

test('present ticks fail closed on a missing, malformed, or outrunning count', () => {
  expect(analyzePresentTicks(HEALTHY_TICKS).failures).toEqual([]);
  expect(analyzePresentTicks(HEALTHY_TICKS).ticks).toHaveLength(5);
  // An empty assertion set is a failure here, not a pass: a device log with no tick at all means
  // nothing measured the invariant.
  expect(analyzePresentTicks('nothing to see').failures).toContain(
    'expected at least 1 TN_PRESENTS_TICK line(s), found 0',
  );
  expect(analyzePresentTicks('TN_PRESENTS_TICK:{"frames":60}').failures).toContain(
    'TN_PRESENTS_TICK missing frames/presents: {"frames":60}',
  );
  // Two presents per frame is the shape of the defect: the world pass and the overlay pass each
  // acquiring and presenting a swapchain image of their own.
  const doubled = 'TN_PRESENTS_TICK:{"frames":60,"presents":120}';
  expect(analyzePresentTicks(doubled).failures[0]).toMatch(
    /presented 120 times in 60 frames; expected at most one present per frame/u,
  );
  // A frame that submitted nothing may leave presents one behind; that is not the defect.
  expect(analyzePresentTicks('TN_PRESENTS_TICK:{"frames":60,"presents":59}').failures).toEqual([]);
});

test('overlay assertion reads PNG bytes and names what is missing', () => {
  const png = new PNG({ height: 4, width: 4 });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data.set([0x11, 0x22, 0x33, 255], index);
  }
  const blank = PNG.sync.write(png);
  expect(() => inspectOverlayBuffer(blank, { label: 'device.png', minPixels: 4 })).toThrow(
    /canvas-layer overlay missing from device\.png: found 0 pixels of #ff00ff/u,
  );
  for (let index = 0; index < 4 * 4; index += 4) png.data.set([0xff, 0x00, 0xff, 255], index);
  expect(inspectOverlayBuffer(PNG.sync.write(png), { minPixels: 4 })).toEqual({ overlayPixels: 4 });
});

// A machine with no sound card is not a failing run. The Windows CI runner has no audio device,
// and the runtime degrades to silence and renders normally — but it used to say "Failed to open
// audio device", which this analyzer scrapes for "failed to". A run that rendered all 300 frames
// and presented each exactly once was reported as a failed desktop core gate because of one line
// about hardware that was never there.
test('an absent audio device does not fail a run that rendered correctly', () => {
  const rendered = CLEAN_DESKTOP_LOG;
  const silent = `${rendered}\n[Audio] No audio playback device on this machine; continuing in silence.`;
  expect(analyzeDesktopLog(silent)).toEqual([]);

  // The real open failure is still a failure: a device exists and would not open.
  const broken = `${rendered}\n[Audio] Failed to open audio device: device in use`;
  expect(analyzeDesktopLog(broken)).toContain('[Audio] Failed to open audio device: device in use');
});

test('the native contract lane gets a display like the rest of the desktop chain', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const chain = manifest.scripts['native:verify:desktop'];
  expect(chain).toBeDefined();
  // `verify-desktop-core.mjs` wraps itself, and `verify-desktop-loading.mjs` is wrapped here, but
  // the contract lane was wrapped by nothing. `native-platforms.yml`'s desktop-core matrix is macOS
  // and Windows only, so no Linux run reached it until native-release.yml's ubuntu-24.04 build did,
  // and `testCliSubsystem` creates a window:
  //   [Window] SDL_Init failed: x11 not available
  //   [Mystral] Failed to create window
  //   testCliSubsystem failed
  // Reproduced locally by running the built target with DISPLAY unset (exit 1, both lines) and
  // cleared by the same wrapper (exit 0). `scripts/xvfb.sh` is a no-op where a display exists, so
  // macOS and Windows are unaffected.
  const contracts = chain
    .split('&&')
    .map((part) => part.trim())
    .find((part) => part.includes('verify-native-contracts.mjs'));
  expect(contracts).toBeDefined();
  expect(contracts).toMatch(/^sh \.\.\/\.\.\/scripts\/xvfb\.sh node scripts\/verify-native-contracts\.mjs$/u);
});
