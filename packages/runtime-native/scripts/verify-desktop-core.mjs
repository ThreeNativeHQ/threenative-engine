#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const READY_MARKER = 'TN_NATIVE_SMOKE_READY:webgpu';
export const FIRST_FRAME_MARKER = 'TN_NATIVE_SMOKE_FIRST_FRAME';
export const WORKER_PROOF_MARKER = 'TN_NATIVE_WORKER_PROOF_PASS:';
const FAILURE_PATTERN = /(?:\bError:|\bRangeError:|validation error|shader parsing error|fatal signal|failed to)/i;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workspace = join(root, '..', '..');

/**
 * The launch segments a desktop run must emit, in the order they must appear.
 *
 * The desktop lane has no `asset_begin`/`asset_complete`: those bracket reading the bundle out of
 * the APK, and a desktop host reads it from the filesystem inside `loadScript`. Everything else is
 * the same launch, and `measure-cold-start.mjs` reads exactly this list for its `--desktop` lane.
 */
export const DESKTOP_COLD_START_SEGMENTS = [
  'process',
  'runtime_created',
  'game_eval_begin',
  'compile_begin',
  'compile_complete',
  'execute_begin',
  'execute_complete',
  'first_frame',
];

/**
 * Asserts the ordered launch markers, with monotonic timestamps.
 *
 * PRD-328: the compile and execute segments existed only in `quickjs_engine.cpp`, which has not
 * shipped on any platform since 2026-08-16, and the desktop CLI emitted nothing but `first_frame`.
 * `measure-cold-start.mjs` therefore failed closed on every real configuration and the only
 * JavaScript-compile number anyone could quote was a QuickJS one from 2026-08-11. This gate is
 * what stops that hole reopening: delete a mark and the desktop gate names it.
 *
 * Order matters as much as presence. A `compile_complete` stamped before its `compile_begin` means
 * the marks were read from two different evaluations — a bootstrap script's blended with the
 * game's — and the segment computed from them is not a measurement.
 */
export function analyzeColdStartMarkers(log, segments = DESKTOP_COLD_START_SEGMENTS) {
  const failures = [];
  const seen = new Map();
  for (const match of log.matchAll(/TN_COLD_START:(\{[^\r\n}]*\})/gu)) {
    let payload;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      failures.push(`malformed TN_COLD_START payload: ${match[1]}`);
      continue;
    }
    if (typeof payload.segment !== 'string' || !Number.isFinite(payload.atMs)) {
      failures.push(`TN_COLD_START missing segment/atMs: ${match[1]}`);
      continue;
    }
    // The host evaluates its own bootstrap through the same engine members as the game, so the
    // four eval segments fire more than once. `game_eval_begin` brackets the game's; taking the
    // first occurrence after it is the same rule `measure-cold-start.mjs` applies.
    const afterGameEval = seen.has('game_eval_begin');
    const isEvalSegment = payload.segment.startsWith('compile_') || payload.segment.startsWith('execute_');
    if (isEvalSegment && !afterGameEval) continue;
    if (!seen.has(payload.segment)) seen.set(payload.segment, payload.atMs);
  }
  for (const segment of segments) {
    if (!seen.has(segment)) failures.push(`TN_COLD_START_MARKER_MISSING:${segment}`);
  }
  if (failures.length === 0) {
    let previousAt = Number.NEGATIVE_INFINITY;
    let previousName = '(start)';
    for (const segment of segments) {
      const atMs = seen.get(segment);
      if (atMs < previousAt) {
        failures.push(
          `TN_COLD_START_SEGMENT_NEGATIVE:${previousName}->${segment} (${previousAt} -> ${atMs} ms)`,
        );
      }
      previousAt = atMs;
      previousName = segment;
    }
  }
  return { failures: [...new Set(failures)], markers: seen };
}

/**
 * Reads the format negotiated at the surface boundary. This is deliberately independent from
 * verbose logging: the desktop gate must still know whether the render target is linear and
 * whether the sRGB bridge is active when a quiet production-style launch is being measured.
 */
export function analyzeSurfaceFormatMarkers(log) {
  const failures = [];
  const markers = [];
  for (const match of log.matchAll(/^TN_SURFACE_FORMAT:(\{[^\r\n]*\})$/gmu)) {
    let payload;
    try {
      payload = JSON.parse(match[1]);
    } catch {
      failures.push(`TN_SURFACE_FORMAT_MALFORMED:${match[1]}`);
      continue;
    }
    if (
      payload === null ||
      Array.isArray(payload) ||
      typeof payload.native !== 'string' ||
      payload.native.length === 0 ||
      typeof payload.render !== 'string' ||
      payload.render.length === 0 ||
      typeof payload.bridge !== 'boolean' ||
      typeof payload.present !== 'string' ||
      payload.present.length === 0
    ) {
      failures.push(`TN_SURFACE_FORMAT_INVALID:${match[1]}`);
      continue;
    }
    markers.push(payload);
  }
  if (markers.length === 0 && failures.length === 0) failures.push('missing TN_SURFACE_FORMAT marker');
  return { failures: [...new Set(failures)], markers };
}

export function analyzeDesktopLog(log, frames = 300) {
  const failures = [];
  if (!log.includes(READY_MARKER)) failures.push(`missing ${READY_MARKER}`);
  if (!log.includes(FIRST_FRAME_MARKER)) failures.push(`missing ${FIRST_FRAME_MARKER}`);
  failures.push(...analyzeSurfaceFormatMarkers(log).failures);
  // The launch instrument has to run on the engine that ships, and only a gate keeps it running.
  failures.push(...analyzeColdStartMarkers(log).failures);
  if (!new RegExp(`Rendered ${frames} frames in \\d+ms`).test(log)) {
    failures.push(`missing exact ${frames}-frame completion`);
  }
  // One present per frame, plus the screenshot gate's own. The host used to present inside every
  // `queue.submit`, so a frame that rendered a canvas-layer overlay presented twice and only the
  // first image reached the display — the overlay was dropped on native while working on web. A
  // pixel check alone cannot see this: it reads a screenshot, and a screenshot can be right while
  // the display is wrong. The capture gate adds named presents beyond the requested frames (the
  // refresh that guarantees the saved capture postdates readiness); the CLI prints their count
  // and the total must be exactly frames plus that count, never more.
  const presents = log.match(/^TN_PRESENTS:(\d+)$/mu);
  const refreshPresents = log.match(/^TN_CAPTURE_REFRESH_PRESENTS:(\d+)$/mu);
  if (!presents) failures.push('missing TN_PRESENTS count');
  else if (!refreshPresents) failures.push('missing TN_CAPTURE_REFRESH_PRESENTS count');
  else if (Number(presents[1]) !== frames + Number(refreshPresents[1])) {
    failures.push(
      `presented ${presents[1]} times for ${frames} frames + ${refreshPresents[1]} capture-refresh presents; expected exactly one present per frame plus the named refreshes`,
    );
  }
  // The same invariant the device gates read, asserted here too so one analyzer covers both lanes.
  failures.push(...analyzePresentTicks(log).failures);
  for (const line of log.split(/\r?\n/)) {
    if (FAILURE_PATTERN.test(line)) failures.push(line.trim());
  }
  return [...new Set(failures)];
}

export function analyzeWorkerProof(log) {
  if (log.includes('TN_NATIVE_WORKER_ROLLBACK_ACTIVE')) {
    throw new Error('TN_NATIVE_WORKER_ROLLBACK_ACTIVE: rollback-active runs cannot satisfy acceptance');
  }
  const createdMatch = log.match(/TN_NATIVE_WORKER_CREATED:(\{"id":\d+,"engine":"[^"]+"\})/u);
  if (!createdMatch) throw new Error('missing TN_NATIVE_WORKER_CREATED');
  const created = JSON.parse(createdMatch[1]);
  const terminated = `TN_NATIVE_WORKER_TERMINATED:{"id":${created.id}}`;
  if (!log.includes(terminated)) throw new Error(`missing TN_NATIVE_WORKER_TERMINATED for id ${created.id}`);
  const proofMatch = log.match(/TN_NATIVE_WORKER_PROOF_PASS:(\{[^\r\n]*\})/u);
  if (!proofMatch) throw new Error(`missing ${WORKER_PROOF_MARKER.slice(0, -1)}`);
  const proof = JSON.parse(proofMatch[1]);
  if (
    created.engine !== 'V8' ||
    proof.workerIdentity !== 'dedicated-worker' ||
    proof.sourceForm !== 'classic-blob' ||
    !Number.isInteger(proof.framesAdvanced) ||
    proof.framesAdvanced < 2 ||
    proof.callbacksAfterTerminate !== 0 ||
    JSON.stringify(proof.completionOrder) !== '[2]' ||
    !Number.isInteger(proof.inputChecksum) ||
    !Number.isInteger(proof.outputChecksum)
  ) {
    throw new Error(`invalid packed worker proof: ${JSON.stringify({ created, proof })}`);
  }
  return { engine: created.engine, ...proof };
}

export function inspectScreenshot(path) {
  if (!existsSync(path)) throw new Error(`desktop screenshot is missing: ${path}`);
  const png = PNG.sync.read(readFileSync(path));
  const colors = new Set();
  let opaque = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const alpha = png.data[index + 3];
    if (alpha !== 0) opaque += 1;
    colors.add(`${png.data[index]},${png.data[index + 1]},${png.data[index + 2]},${alpha}`);
  }
  if (opaque === 0 || colors.size < 2) throw new Error('desktop screenshot is blank');
  return { height: png.height, width: png.width };
}

/**
 * Asserts the canvas-layer overlay reached the screen.
 *
 * The overlay is a second `renderer.render()` in the same frame. The native host used to present
 * inside every `queue.submit`, so that second pass acquired its own swapchain image and only the
 * first present of the frame was displayed — every overlay was silently dropped on native while
 * working on web. A blank-screenshot check cannot see that: the world still renders. This looks
 * for the overlay's own colour, which nothing in the world draws.
 */
export function inspectOverlay(path, options = {}) {
  return inspectOverlayBuffer(readFileSync(path), { ...options, label: path });
}

/**
 * The same assertion against PNG bytes rather than a path.
 *
 * The device lane never has a file: `adb exec-out screencap -p` hands back a buffer, and the
 * android and desktop gates must be asserting the identical thing or the device lane is a
 * different, weaker check wearing the same name.
 */
export function inspectOverlayBuffer(
  buffer,
  { color = 0xff00ff, label = 'screenshot', minPixels = 256 } = {},
) {
  const png = PNG.sync.read(buffer);
  const red = (color >> 16) & 0xff;
  const green = (color >> 8) & 0xff;
  const blue = color & 0xff;
  let matched = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    // Exact match: the overlay is unlit MeshBasicMaterial, so the host must reproduce it exactly.
    if (png.data[index] === red && png.data[index + 1] === green && png.data[index + 2] === blue) {
      matched += 1;
    }
  }
  if (matched < minPixels) {
    throw new Error(
      `canvas-layer overlay missing from ${label}: found ${matched} pixels of #${color.toString(16).padStart(6, '0')}, expected at least ${minPixels}. The overlay pass rendered but never reached the display.`,
    );
  }
  return { overlayPixels: matched };
}

/**
 * Reads the periodic `TN_PRESENTS_TICK` lines and asserts one present per frame.
 *
 * Shared with the device gates. The desktop CLI's end-of-run `TN_PRESENTS` line only exists in
 * fixed-frame screenshot mode; a device app runs until it is killed, so the invariant has to be
 * readable from a running process. `presents` may lag `frames` by a frame that submitted nothing,
 * but it must never exceed them — that is exactly the defect, the overlay pass taking a swapchain
 * image of its own.
 */
export function analyzePresentTicks(log, { minTicks = 1 } = {}) {
  const failures = [];
  const ticks = [];
  for (const match of log.matchAll(/TN_PRESENTS_TICK:(\{[^}]*\})/gu)) {
    let tick;
    try {
      tick = JSON.parse(match[1]);
    } catch {
      failures.push(`malformed TN_PRESENTS_TICK payload: ${match[1]}`);
      continue;
    }
    if (typeof tick.frames !== 'number' || typeof tick.presents !== 'number') {
      failures.push(`TN_PRESENTS_TICK missing frames/presents: ${match[1]}`);
      continue;
    }
    ticks.push(tick);
    if (tick.presents > tick.frames) {
      failures.push(
        `presented ${tick.presents} times in ${tick.frames} frames; expected at most one present per frame. A second render pass is acquiring a swapchain image of its own and only one present reaches the display.`,
      );
    }
  }
  if (ticks.length < minTicks) {
    failures.push(`expected at least ${minTicks} TN_PRESENTS_TICK line(s), found ${ticks.length}`);
  }
  return { failures: [...new Set(failures)], ticks };
}

/**
 * The Linux video driver this run must use, from the environment a caller set.
 *
 * SDL 3 reads `SDL_VIDEO_DRIVER`; `SDL_VIDEODRIVER` is the SDL 2 spelling the documented
 * `SDL_VIDEODRIVER=wayland pnpm native:verify:desktop` still uses, and `src/platform/window.cpp`
 * honours it for the same reason. SDL_VIDEO_DRIVER wins when both are set. Absent either, this gate
 * keeps its X11 default.
 */
export function requestedLinuxVideoDriver(env = process.env) {
  const driver = env.SDL_VIDEO_DRIVER || env.SDL_VIDEODRIVER || 'x11';
  return { driver, wayland: driver === 'wayland' };
}

export function verifyDesktopCore({ frames = 300 } = {}) {
  const preset = process.platform === 'darwin'
    ? 'tn-macos'
    : process.platform === 'win32'
      ? 'tn-windows'
      : 'tn-linux';
  const binary = join(root, 'build', preset, process.platform === 'win32' ? 'mystral.exe' : 'mystral');
  const bundle = join(workspace, 'examples', 'native-smoke', 'dist', 'native-smoke.js');
  const date = new Date().toISOString().slice(0, 10);
  const screenshot = join(root, 'artifacts', `desktop-core-${date}.png`);
  const logPath = join(root, 'artifacts', `desktop-${process.platform}.log`);
  const reportPath = join(root, 'artifacts', `desktop-${process.platform}-report.json`);
  for (const [label, path] of [['runtime binary', binary], ['core bundle', bundle]]) {
    if (!existsSync(path)) throw new Error(`${label} is missing: ${path}`);
  }
  mkdirSync(dirname(screenshot), { recursive: true });
  const runtimeArgs = [
    'run',
    bundle,
    '--screenshot',
    screenshot,
    '--frames',
    String(frames),
  ];
  // Not `xvfb-run`: on xorg-server-xvfb 21.1.24 its cleanup `kill` fails after Xvfb has already
  // exited and that failing kill's status replaces the command's, so this gate reported a red
  // 300-frame run that had in fact rendered every frame and written a good screenshot.
  const requested = requestedLinuxVideoDriver();
  // Xvfb is an X11 server, so wrapping a Wayland request in it would run the proof on X11 and report
  // it as Wayland. A Wayland run needs the compositor the caller started, and it reads the window
  // handles SDL's Wayland driver hands back.
  const command = process.platform === 'linux' && !requested.wayland ? 'sh' : binary;
  const args = process.platform === 'linux' && !requested.wayland
    ? [join(workspace, 'scripts', 'xvfb.sh'), binary, ...runtimeArgs]
    : runtimeArgs;
  const runtimeEnv = { ...process.env };
  if (process.platform === 'linux') {
    console.info(`desktop core gate: SDL video driver ${requested.driver}${requested.wayland ? ' (no Xvfb wrapper; the compositor comes from the environment)' : ''}`);
    // Both spellings, so the child resolves the same driver this gate read.
    runtimeEnv.SDL_VIDEO_DRIVER = requested.driver;
    runtimeEnv.SDL_VIDEODRIVER = requested.driver;
    // Same reason as the video driver: this gate runs headless on a runner with no sound card, and
    // SDL aborts before the first frame with
    //   [Audio] Failed to open audio device: ALSA: Couldn't open audio device: No such file or
    //   directory
    // native-platforms.yml's desktop-core matrix is macOS and Windows only, so no Linux run ever
    // reached this line until native-release.yml's ubuntu-24.04 build executed it. The audio
    // contract is not weakened: verify-desktop-audio.mjs proves the suspend/resume lifecycle
    // against real AudioContexts and runs before this gate in the same command. An explicit
    // SDL_AUDIODRIVER still wins, so a machine with a real device keeps using it.
    runtimeEnv.SDL_AUDIODRIVER ??= 'dummy';
  }
  const result = spawnSync(
    command,
    args,
    {
      cwd: workspace,
      encoding: 'utf8',
      env: runtimeEnv,
      timeout: 120_000,
    },
  );
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(logPath, log);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`desktop runtime exited ${result.status}:\n${log}`);
  const worker = analyzeWorkerProof(log);
  const failures = analyzeDesktopLog(log, frames);
  if (failures.length > 0) throw new Error(`desktop core gate failed:\n${failures.join('\n')}`);
  const image = inspectScreenshot(screenshot);
  const overlay = inspectOverlay(screenshot);
  const report = {
    completedAt: new Date().toISOString(),
    frames,
    host: { arch: process.arch, platform: process.platform },
    artifact: {
      path: relative(workspace, binary),
      sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
    },
    log: relative(workspace, logPath),
    markers: [
      READY_MARKER,
      FIRST_FRAME_MARKER,
      WORKER_PROOF_MARKER.slice(0, -1),
      'TN_SURFACE_FORMAT',
      `Rendered ${frames} frames`,
    ],
    surfaceFormats: analyzeSurfaceFormatMarkers(log).markers,
    pass: true,
    preset,
    worker,
    screenshot: {
      ...image,
      ...overlay,
      path: relative(workspace, screenshot),
      sha256: createHash('sha256').update(readFileSync(screenshot)).digest('hex'),
    },
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return { ...image, ...overlay, frames, host: process.platform, log, preset, reportPath, screenshot };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const result = verifyDesktopCore();
    console.log(
      `desktop core gate passed: ${result.frames} frames, ${result.width}x${result.height}, ${result.screenshot}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
