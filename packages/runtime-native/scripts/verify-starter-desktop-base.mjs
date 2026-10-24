#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

import {
  desktopLaunchTarget,
  isEnginePlayerLaunch,
  parseLinkedLibraries,
  resolveContainer,
} from './desktop-distribution.mjs';
import { inspectContainerBrand } from './inspect-container-brand.mjs';
import { inspectMacosIcon } from './inspect-macos-icon.mjs';

const READY_MARKER = 'TN_NATIVE_SMOKE_READY:webgpu';
const ASSET_MARKER = 'TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb';
// Measured: a drawn starter frame has ~17,000 distinct colours, a lost capture had 5.
const UNRENDERED_FRAME_COLOR_FLOOR = 64;
// 64x64. Below this the frame is a fixture, not a capture.
const UNRENDERED_FRAME_MIN_PIXELS = 4096;
const ASSET_PIXEL_FLOOR = 100;
// The packaged proof is a cyan/magenta checkerboard pennant, and it is identified by CHANNEL
// MARGIN rather than by distance to the authored texture colour. The gate reads a lit, tonemapped
// render, and the authored cyan never reaches the screen: measured on the CI capture of run
// 34076016432, the pennant's cyan renders as rgb(86,180,189) — 103 away from the authored
// [18,220,255] — while the ocean behind it sits at 149 and the sky at 140. Any absolute-distance
// threshold wide enough to admit the asset also admits the sea, which is how a frame showing the
// pennant plainly was rejected with 798,464 of 921,600 pixels classified as proof.
//
// Magenta is the discriminator, because an ocean world contains none: 521 magenta pixels on the
// pennant, against 0 in the same frame with the pennant cropped away.
const PROOF_MAGENTA_MIN_MARGIN = 40;
// Corroborating cyan, counted only inside the magenta bounds so the background cannot supply it.
const PROOF_CYAN_MIN_MARGIN = 70;
const PROOF_CYAN_IN_BOUNDS_FLOOR = 50;
// A proof region may occupy up to a quarter of a rendered frame; a wash that reaches almost every
// part of the frame must not count as localized evidence.
const MAX_ASSET_BOUNDS_FRACTION = 0.25;
// Bounds alone cannot separate a small asset from magenta scattered thinly across the frame, since
// scattered pixels share almost the same bounding box as a solid one. Density does: the pennant
// fills 0.236 of its own bounds, scattered noise fills 0.04.
const MIN_ASSET_BOUNDS_DENSITY = 0.1;

function isProofMagenta(data, offset) {
  return (
    data[offset + 3] > 0 &&
    data[offset] > data[offset + 1] + PROOF_MAGENTA_MIN_MARGIN &&
    data[offset + 2] > data[offset + 1] + PROOF_MAGENTA_MIN_MARGIN
  );
}

function isProofCyan(data, offset) {
  return (
    data[offset + 3] > 0 &&
    data[offset + 1] - data[offset] > PROOF_CYAN_MIN_MARGIN &&
    data[offset + 2] - data[offset] > PROOF_CYAN_MIN_MARGIN
  );
}

function countProofCyanInBounds(png, bounds) {
  let cyan = 0;
  for (let y = bounds.minY; y <= bounds.maxY; y += 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      if (isProofCyan(png.data, (y * png.width + x) * 4)) cyan += 1;
    }
  }
  return cyan;
}

// Localization is a question about a capture, not about a texture, so only a capture-sized frame
// reaches this. The distribution test feeds the packaged 16x16 proof itself, where the asset
// legitimately fills the whole frame and asking where it sits has no meaning.
function assertProofIsLocalized(png, bounds, magentaAssetPixels) {
  const boundsArea = (bounds.maxX - bounds.minX + 1) * (bounds.maxY - bounds.minY + 1);
  const boundsFraction = boundsArea / (png.width * png.height);
  if (boundsFraction > MAX_ASSET_BOUNDS_FRACTION) {
    throw new Error(
      `TN_NATIVE_STARTER_ASSET_NOT_LOCALIZED: magenta spans ${(boundsFraction * 100).toFixed(1)}% of the frame, which is a wash, not the proof asset.`,
    );
  }
  const density = magentaAssetPixels / boundsArea;
  if (density < MIN_ASSET_BOUNDS_DENSITY) {
    throw new Error(
      `TN_NATIVE_STARTER_ASSET_NOT_LOCALIZED: magenta fills only ${(density * 100).toFixed(1)}% of its own bounds, which is scatter, not the proof asset.`,
    );
  }
}

// One pass over the frame: the colour census the unrendered-frame floor reads, and the magenta
// pixel count with the bounds it occupies.
function scanProofMagenta(png) {
  const colors = new Set();
  const bounds = { maxX: -1, maxY: -1, minX: png.width, minY: png.height };
  let magentaAssetPixels = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    colors.add(
      `${png.data[index]},${png.data[index + 1]},${png.data[index + 2]},${png.data[index + 3]}`,
    );
    if (!isProofMagenta(png.data, index)) continue;
    magentaAssetPixels += 1;
    const pixel = index / 4;
    const x = pixel % png.width;
    const y = Math.floor(pixel / png.width);
    if (x < bounds.minX) bounds.minX = x;
    if (x > bounds.maxX) bounds.maxX = x;
    if (y < bounds.minY) bounds.minY = y;
    if (y > bounds.maxY) bounds.maxY = y;
  }
  return { bounds, colors, magentaAssetPixels };
}

export function inspectStarterScreenshot(path) {
  if (!existsSync(path)) throw new Error(`TN_NATIVE_STARTER_SCREENSHOT_MISSING: ${path}`);
  const png = PNG.sync.read(readFileSync(path));
  const { bounds, colors, magentaAssetPixels } = scanProofMagenta(png);
  if (colors.size < 2) throw new Error('TN_NATIVE_STARTER_SCREENSHOT_BLANK: one-color frame.');
  // A one-colour guard is too weak to catch the capture this gate actually loses. A rendered
  // starter frame carries roughly 17k distinct colours; an intermittent CI failure captured five —
  // flat background, two flat shapes, thirteen pixels of the GLB — while the run log still showed
  // TN_NATIVE_STARTER_ASSETS_LOADED and "Rendered 300 frames". That frame was never drawn, and
  // reporting it as a missing asset sends the reader hunting for a texture that loaded fine.
  // Only meaningful at capture resolution. A 16x16 synthetic fixture — what the installed-verifier
  // distribution test feeds this function — is legitimately two colours, and judging it by the
  // diversity a 1280x720 render carries would reject a frame that is exactly what it claims to be.
  const rendered = png.width * png.height >= UNRENDERED_FRAME_MIN_PIXELS;
  if (rendered && colors.size < UNRENDERED_FRAME_COLOR_FLOOR) {
    throw new Error(
      `TN_NATIVE_STARTER_FRAME_NOT_RENDERED: only ${colors.size} distinct colours in ${png.width}x${png.height}. The run log may still show every marker: this is the capture, not the scene.`,
    );
  }
  if (magentaAssetPixels < ASSET_PIXEL_FLOOR) {
    throw new Error(
      `TN_NATIVE_STARTER_ASSET_NOT_VISIBLE: found ${magentaAssetPixels} magenta proof pixels in a frame of ${colors.size} colours.`,
    );
  }
  if (rendered) assertProofIsLocalized(png, bounds, magentaAssetPixels);
  const cyanAssetPixels = countProofCyanInBounds(png, bounds);
  if (cyanAssetPixels < PROOF_CYAN_IN_BOUNDS_FLOOR) {
    throw new Error(
      `TN_NATIVE_STARTER_ASSET_NOT_VISIBLE: magenta found but only ${cyanAssetPixels} cyan proof pixels inside its bounds; the checkerboard needs both colours.`,
    );
  }
  return {
    colors: colors.size,
    cyanAssetPixels,
    height: png.height,
    magentaAssetPixels,
    width: png.width,
  };
}

export function analyzeStarterLog(log, frames = 300) {
  const failures = [];
  for (const marker of [READY_MARKER, ASSET_MARKER, `TN_NATIVE_SMOKE_${frames}_FRAMES:${frames}`]) {
    if (!log.includes(marker)) failures.push(`missing ${marker}`);
  }
  if (!new RegExp(`Rendered ${frames} frames in \\d+ms`, 'u').test(log)) {
    failures.push(`missing exact ${frames}-frame completion`);
  }
  for (const pattern of [/TN_NATIVE_START_FAILED/u, /validation error/iu, /TypeError:/u]) {
    if (pattern.test(log)) failures.push(`runtime log matched ${pattern}`);
  }
  // The capture is only evidence if the world was on screen when it was taken. The host holds the
  // screenshot until the startup gate opens and says so; a 0 here means it captured the loading
  // state after waiting out its budget, which is the difference between a 17,000-colour frame and
  // a five-colour one.
  if (log.includes('TN_STARTUP_CAPTURE_READY:0')) {
    failures.push('startup gate never opened before capture (TN_STARTUP_CAPTURE_READY:0)');
  }
  return failures;
}

/**
 * The install step for a system library the container records as a player prerequisite.
 *
 * The container deliberately ships none of these, so a missing one is a player-machine gap. The
 * verifier names the concrete library and its OS install command rather than leaking the dynamic
 * loader's bare `not found`, which reads like a broken artifact.
 */
export function playerPrerequisiteHint(name, platform = process.platform, recorded = true) {
  if (recorded && /libwebkit2gtk-/u.test(name)) {
    return 'install the WebKitGTK 4.1 runtime (Debian/Ubuntu: sudo apt-get install -y libwebkit2gtk-4.1-0; Fedora: sudo dnf install webkit2gtk4.1; Arch: sudo pacman -S webkit2gtk-4.1).';
  }
  if (recorded && (/webview2/iu.test(name) || /^WebView2Loader\.dll$/iu.test(name))) {
    return 'install the Microsoft Edge WebView2 Evergreen Runtime (https://developer.microsoft.com/microsoft-edge/webview2/).';
  }
  return `install ${name} with this OS's package manager; the container records system libraries as player prerequisites and does not ship them.`;
}

function defaultExec(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  return {
    error: result.error,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

/** Shared libraries the player machine must provide that this host cannot resolve. */
export function missingPlayerLibraries(executable, { platform = process.platform, run = defaultExec } = {}) {
  if (platform !== 'linux') return [];
  const result = run('ldd', [executable]);
  if (result.error) {
    throw new Error(
      `TN_STARTER_PREREQUISITE_TOOL_MISSING: 'ldd' is required to resolve player prerequisites (${result.error.message}).`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `TN_STARTER_PREREQUISITE_RESOLUTION_FAILED: 'ldd' exited ${result.status ?? 'unknown'} for ${executable}.\n${result.stderr}`,
    );
  }
  return parseLinkedLibraries(result.stdout, 'linux')
    .filter((library) => library.missing)
    .map((library) => library.name);
}

/** Fail with the concrete prerequisite and its install step, not a loader error. */
export function assertPlayerPrerequisites(manifest, executable, { platform = process.platform, run = defaultExec } = {}) {
  const missing = missingPlayerLibraries(executable, { platform, run });
  if (missing.length === 0) return [];
  const recorded = new Set((manifest?.prerequisites ?? []).map((prerequisite) => prerequisite?.name));
  const details = missing
    .map((name) => `  - ${name}: ${playerPrerequisiteHint(name, platform, recorded.has(name))}`)
    .join('\n');
  throw new Error(
    `TN_NATIVE_STARTER_PREREQUISITE_MISSING: ${executable} needs ${missing.length} system prerequisite(s) this player machine does not provide:\n${details}`,
  );
}

function launchStarterExecutable(executable, { env = process.env, frames, logPath, project, screenshot }) {
  // Windowed at the configured size, not the starter's `display.fullscreen: true` default: a
  // headless Windows runner has no interactive desktop for a fullscreen swap and the process was
  // seen to hang in it, and a fixed window keeps the capture size the render gates already assert.
  const runtimeArgs = ['--windowed', '--screenshot', screenshot, '--frames', String(frames)];
  // See verify-desktop-core.mjs: `xvfb-run` hands back its own failing cleanup kill's status.
  const displayHelper = join(dirname(fileURLToPath(import.meta.url)), 'xvfb.sh');
  if (process.platform === 'linux' && !existsSync(displayHelper)) {
    throw new Error(`TN_NATIVE_STARTER_DISPLAY_SUPPORT_MISSING: ${displayHelper}`);
  }
  const command = process.platform === 'linux' ? 'sh' : executable;
  const args = process.platform === 'linux' ? [displayHelper, executable, ...runtimeArgs] : runtimeArgs;
  // A hosted Windows runner renders 300 frames on a software adapter with the WebView2 overlay
  // compositing alongside, which is slower than the Linux and macOS lanes; the override keeps a
  // genuinely hung run bounded at the caller's number instead of ours.
  const timeoutMs = Number(process.env.TN_STARTER_TIMEOUT_MS ?? 300_000);
  const result = spawnSync(command, args, {
    cwd: project,
    encoding: 'utf8',
    env: process.platform === 'linux' ? { ...env, SDL_VIDEODRIVER: 'x11' } : env,
    timeout: timeoutMs,
  });
  // Write the captured output before judging it. On a timeout `spawnSync` sets `error` and the old
  // code threw before the log existed, so a Windows run that hung reported only ETIMEDOUT and no
  // clue where it stopped; the log is the diagnosis.
  const log = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  writeFileSync(logPath, log);
  if (result.error) {
    throw new Error(`TN_NATIVE_STARTER_SPAWN_FAILED: ${result.error.message}\n${log}`);
  }
  if (result.status !== 0) throw new Error(`TN_NATIVE_STARTER_EXIT_${result.status}:\n${log}`);
  return log;
}

// The raw debug artifact and the installed release container are judged by the same markers.
function judgeStarterRun({ artifact, brand, frames, log, logPath, reportPath, screenshot }) {
  const failures = analyzeStarterLog(log, frames);
  if (failures.length > 0) throw new Error(`TN_NATIVE_STARTER_LOG_FAILED:\n${failures.join('\n')}`);
  // Windows (DWM) and macOS (Quartz) always composite, so the default starter's WebView HUD must
  // attach there. Linux CI runs a bare Xvfb with no compositor and the overlay correctly refuses,
  // so this is asserted only where the desktop compositor is part of the OS.
  const overlayAttached = log.includes('"attached":true');
  if ((process.platform === 'win32' || process.platform === 'darwin') && !overlayAttached) {
    throw new Error(
      'TN_NATIVE_STARTER_UI_OVERLAY_MISSING: the starter WebView HUD did not attach on this always-composited desktop host.',
    );
  }
  const image = inspectStarterScreenshot(screenshot);
  const report = {
    artifact,
    brand,
    completedAt: new Date().toISOString(),
    frames,
    image,
    log: logPath,
    overlayAttached,
    pass: true,
    screenshot,
    screenshotSha256: createHash('sha256').update(readFileSync(screenshot)).digest('hex'),
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export { desktopLaunchTarget };

function verifyOwnedDesktop({ frames, project, artifact, artifactDirectory, logPath, run, env }) {
  const cli = join(project, 'node_modules', '@threenative', 'playtest', 'dist', 'runner', 'cli.js');
  if (!existsSync(cli)) throw new Error(`TN_NATIVE_STARTER_RUNNER_MISSING: ${cli}`);
  const temporary = mkdtempSync(join(artifactDirectory, 'smoke-'));
  const scenario = join(temporary, 'native-smoke.playtest.json');
  const captures = join(artifactDirectory, 'native-smoke');
  const screenshot = join(captures, 'after.png');
  const timeout = Number(env.TN_STARTER_TIMEOUT_MS ?? 300_000);
  try {
    rmSync(screenshot, { force: true });
    writeFileSync(scenario, JSON.stringify({ name: 'native-smoke', schemaVersion: 1,
      steps: [{ kind: 'wait', waitTicks: 1, label: 'native-smoke' }],
      assert: { diagnostics: { runtimeReady: true, noConsoleErrors: true, noRuntimeDiagnostics: true } },
      artifacts: { screenshots: 'after' } }));
    const result = run(process.execPath, [cli, scenario, '--target', 'desktop', '--project', project,
      '--artifacts', captures, '--executable', artifact, '--host-arg', '--windowed'], {
      cwd: project, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
      env: { ...env, TN_PLAYTEST_COMPLETION_WINDOW_LABEL: 'native-smoke',
        TN_PLAYTEST_COMPLETION_WINDOW_MIN_FRAMES: String(frames),
        TN_PLAYTEST_COMPLETION_WINDOW_TIMEOUT_MS: String(Math.max(1, timeout - 10_000)) },
    });
    writeFileSync(logPath, `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    if (result.error || result.signal || result.status !== 0)
      throw new Error(`TN_NATIVE_STARTER_SMOKE: runner failed: ${result.error?.message ?? result.signal ?? result.stderr ?? result.status}`);
    const report = JSON.parse(result.stdout);
    if (report?.pass !== true || !report.assertionResults?.length
      || report.assertionResults.some((assertion) => assertion.pass !== true))
      throw new Error('TN_NATIVE_STARTER_SMOKE: runner assertions missing or failed');
    const completion = report.acquisition?.completionWindow;
    const samples = completion?.samples;
    if (completion?.source !== 'present-return' || completion.timebase !== 'steady-clock-ms'
      || !Array.isArray(samples) || samples.length < frames || samples.some((sample, index) =>
        !Number.isSafeInteger(sample.sequence) || sample.sequence < 1 || !Number.isFinite(sample.completedAtMs)
        || sample.completedAtMs < 0 || (index > 0 && (sample.sequence !== samples[index - 1].sequence + 1
          || sample.completedAtMs <= samples[index - 1].completedAtMs))))
      throw new Error(`TN_NATIVE_STARTER_SMOKE: missing ${frames} contiguous native completion observations`);
    const image = PNG.sync.read(readFileSync(screenshot));
    const colors = new Set();
    let opaque = 0;
    for (let index = 0; index < image.data.length; index += 4) {
      if (image.data[index + 3] !== 0) opaque += 1;
      colors.add(image.data.readUInt32BE(index));
    }
    if (opaque === 0 || colors.size < 2) throw new Error('native smoke screenshot is blank');
    return { artifact, gate: 'native-smoke', pass: true, frames: samples.length, requestedFrames: frames,
      completion, screenshot, width: image.width, height: image.height, assertions: report.assertionResults };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

export function verifyStarterDesktop({ frames = 300, project = process.cwd(), run = spawnSync, env = process.env } = {}) {
  frames = frameCount(frames);
  const projectRoot = resolve(project);
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'package.json'), 'utf8'));
  const projectName = basename(String(manifest.name ?? 'starter').replace(/^@[^/]+\//u, ''));
  const executableName = process.platform === 'win32' ? `${projectName}.exe` : projectName;
  const artifact = join(projectRoot, 'dist-native', executableName);
  if (!existsSync(artifact)) {
    throw new Error(`TN_NATIVE_STARTER_ARTIFACT_MISSING: run pnpm build:desktop first (${artifact}).`);
  }
  const artifactDirectory = join(projectRoot, 'artifacts', 'native');
  const screenshot = join(artifactDirectory, 'starter-desktop.png');
  const logPath = join(artifactDirectory, 'starter-desktop.log');
  const reportPath = join(artifactDirectory, 'starter-desktop-report.json');
  mkdirSync(artifactDirectory, { recursive: true });
  const launch = desktopLaunchTarget(artifact, executableName);
  // The engine player takes neither `--frames` nor `--screenshot` and prints none of the legacy
  // host's markers, so the playtest runner drives it (PRD-637). The report keeps the same path.
  if (isEnginePlayerLaunch(launch)) {
    const report = verifyOwnedDesktop({ frames, project: projectRoot, artifact: launch,
      artifactDirectory, logPath, run, env });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    return report;
  }
  const log = launchStarterExecutable(launch, { frames, logPath, project: projectRoot, screenshot });
  return judgeStarterRun({ artifact: launch, frames, log, logPath, reportPath, screenshot });
}

/**
 * Verify an installed release container from wherever the player unpacked it.
 *
 * The same markers and capture are judged, but a missing system prerequisite is caught before the
 * launch and reported with its install step, and the container's own integrity records are
 * resolved first, so a tampered or incomplete payload never reaches the launch.
 */
/**
 * Resolve the container and inspect its brand without launching the game.
 *
 * Brand is judged before anything launches: a container that carries the wrong identity must not
 * be rescued by a green frame, and its failure names the surface, not the launch.
 */
function inspectContainer(containerRoot, config, projectRoot) {
  const manifest = resolveContainer(containerRoot);
  const brand =
    config === undefined
      ? null
      : inspectContainerBrand(containerRoot, config, { project: projectRoot });
  // inspectContainerBrand owns metadata/provenance. A release-verifier pass additionally needs
  // the final macOS payload decoded: a matching source hash cannot prove an ICNS conversion.
  if (brand?.icon !== undefined && manifest.platform.startsWith('darwin-')) {
    brand.icon.macos = inspectMacosIcon(
      join(containerRoot, brand.icon.path),
      resolve(projectRoot, config.app.icon),
    );
  }
  return { brand, manifest };
}

/**
 * Inspect a distributed container's brand on a host that cannot launch it.
 *
 * The Windows CI leg packages a real `.exe` with real PE resources but has no interactive desktop
 * to run it on. macOS icon-content inspection needs macOS iconutil/sips, but no GUI session.
 * Integrity records are resolved
 * first either way, so this is not a weaker check than the launching path — only a shorter one.
 */
export function verifyContainerBrand({ root, config, project = process.cwd() } = {}) {
  if (!root) {
    throw new Error('TN_NATIVE_STARTER_CONTAINER_MISSING: pass --container <unpacked directory>.');
  }
  if (config === undefined) {
    throw new Error(
      'TN_NATIVE_STARTER_CLI_INVALID: --brand-only needs --config <resolved config json>.',
    );
  }
  return inspectContainer(resolve(root), config, resolve(project)).brand;
}

export function verifyStarterContainer({ root, config, frames = 300, project = process.cwd(), env, run } = {}) {
  if (!root) {
    throw new Error('TN_NATIVE_STARTER_CONTAINER_MISSING: pass --container <unpacked directory>.');
  }
  const projectRoot = resolve(project);
  const containerRoot = resolve(root);
  const { brand, manifest } = inspectContainer(containerRoot, config, projectRoot);
  const executable = join(containerRoot, manifest.executable);
  assertPlayerPrerequisites(manifest, executable, { run });
  const artifactDirectory = join(projectRoot, 'artifacts', 'native');
  const screenshot = join(artifactDirectory, 'starter-container.png');
  const logPath = join(artifactDirectory, 'starter-container.log');
  const reportPath = join(artifactDirectory, 'starter-container-report.json');
  mkdirSync(artifactDirectory, { recursive: true });
  const log = launchStarterExecutable(executable, { env, frames, logPath, project: projectRoot, screenshot });
  return judgeStarterRun({ artifact: executable, brand, frames, log, logPath, reportPath, screenshot });
}

/** The consumer config the container is judged against, read as the resolved JSON the packager takes. */
function readBrandConfig(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `TN_NATIVE_STARTER_BRAND_CONFIG_INVALID: ${path} is not readable JSON (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

const CLI_VALUE_FLAGS = ['--container', '--config', '--frames', '--project'];
const CLI_BOOLEAN_FLAGS = ['--brand-only'];

function frameCount(value) {
  const frames = Number(value);
  if (!Number.isInteger(frames) || frames <= 0) {
    throw new Error(
      `TN_NATIVE_STARTER_CLI_INVALID: --frames needs a positive whole number, not '${value}'.`,
    );
  }
  return frames;
}

/**
 * Every flag is recognized and every value is present, or the run stops.
 *
 * A flag that silently does nothing turns a check off without saying so: `--config $EMPTY` drops
 * brand inspection, `--container $EMPTY` quietly runs the developer-artifact path against a
 * different binary than the one under test, and a mistyped flag does either without a word.
 */
function parseCliFlags(argv) {
  const options = {};
  for (let index = 0; index < argv.length; ) {
    const flag = argv[index];
    if (CLI_BOOLEAN_FLAGS.includes(flag)) {
      options.brandOnly = true;
      index += 1;
      continue;
    }
    if (!CLI_VALUE_FLAGS.includes(flag)) {
      throw new Error(
        `TN_NATIVE_STARTER_CLI_INVALID: unknown flag '${flag}'. Supported: ${[...CLI_VALUE_FLAGS, ...CLI_BOOLEAN_FLAGS].join(', ')}.`,
      );
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`TN_NATIVE_STARTER_CLI_INVALID: ${flag} needs a value.`);
    }
    if (flag === '--container') options.root = resolve(value);
    else if (flag === '--config') options.config = readBrandConfig(resolve(value));
    else if (flag === '--frames') options.frames = frameCount(value);
    else options.project = resolve(value);
    index += 2;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = parseCliFlags(process.argv.slice(2));
    if (options.brandOnly) {
      const brand = verifyContainerBrand(options);
      console.log(
        `container brand verified: ${brand.name?.name ?? '(no configured name)'}\n${JSON.stringify(brand, null, 2)}`,
      );
      process.exit(0);
    }
    const report = options.root ? verifyStarterContainer(options) : verifyStarterDesktop(options);
    if (report.gate === 'native-smoke') {
      console.log(`starter desktop gate passed: ${report.frames} native presents, ${report.assertions.length} playtest assertions, screenshot ${report.screenshot}`);
      process.exit(0);
    }
    const brand = report.brand === undefined || report.brand === null
      ? 'brand NOT inspected (pass --config <resolved config json>)'
      : `brand ${report.brand.name?.name ?? 'unnamed'} verified`;
    console.log(`starter desktop gate passed: ${report.frames} frames, ${report.image.colors} colors, ${report.image.cyanAssetPixels} asset pixels, ${brand}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
