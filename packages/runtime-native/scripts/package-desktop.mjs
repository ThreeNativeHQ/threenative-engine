#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { assertNativeAssetsDecodable, deriveDesktopWebpSupport } from './asset-preflight.mjs';
import { listFiles, selectManifestAssets } from './asset-manifest.mjs';
import { installPrebuilt } from './install-prebuilt.mjs';

// The container helper is imported lazily by the release path only, so a debug build never loads
// it, and it ships in package.json `files` so a published `--mode release` run resolves it.
const loadDistribution = () => import('./desktop-distribution.mjs');

const runtimeRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Normalize `spawnSync` into the shape every injected tool executor returns. */
function exec(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    error: result.error,
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * Strip debug and symbol sections from a packaged runtime copy, in place.
 *
 * Runs on the package COPY, never the build-tree original: the original keeps its symbols for
 * debugging, the artifact the player installs does not carry them. Linux only: `--strip-all` keeps
 * `.dynsym`, so the loader still resolves. macOS is left alone because `strip` invalidates the
 * linker signature Apple Silicon requires to launch an unsigned build, and no macOS lane proves a
 * re-sign here; Windows has no strip step.
 *
 * A machine with no strip tool is not a failed build — the unstripped runtime ships with one
 * warning naming its size in bytes. A tool that runs and fails is: its stderr is the failure.
 */
export function stripDesktopRuntime(file, { platform = process.platform, run = exec, warn = console.warn } = {}) {
  if (platform !== 'linux') return { stripped: false, reason: platform };
  for (const command of ['strip', 'llvm-strip']) {
    const result = run(command, ['--strip-all', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.error) continue;
    if (result.status !== 0) {
      throw new Error(
        `TN_DESKTOP_STRIP_FAILED: '${command}' exited ${result.status ?? 'unknown'} on ${basename(file)}.\n${result.stderr ?? ''}`,
      );
    }
    return { stripped: true, command };
  }
  warn(
    `ThreeNative desktop packaging: no strip tool on PATH, shipping unstripped ${basename(file)} (${statSync(file).size} bytes).`,
  );
  return { stripped: false, reason: 'tool-missing' };
}

/**
 * Resolve the desktop runtime binary a consumer build compiles against.
 *
 * A published install ships no compiled runtime until the postinstall hook fetches one, so a
 * missing `--runtime` installs from the release manifest rather than failing with a bare
 * "missing file". `THREENATIVE_RUNTIME_SOURCE` remains the decoder-preflight source only: it
 * never selects or substitutes the runtime binary, and no code path here reads a checkout as
 * the runtime. `options.runtimeSource` is an explicit test seam for the preflight directory.
 */
export async function resolveDesktopRuntime(explicit, options = {}) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`Missing prebuilt runtime for '${process.platform}-${process.arch}': ${explicit}`);
    return explicit;
  }
  const sourceOverride = options.runtimeSource ?? process.env.THREENATIVE_RUNTIME_SOURCE;
  if (sourceOverride) {
    throw new Error(
      `Desktop source-checkout preflight is set (THREENATIVE_RUNTIME_SOURCE=${sourceOverride}) but no --runtime was provided. ` +
        'Pass the checkout-built --runtime explicitly for a maintainer build; consumer builds unset the override and install from the release manifest.',
    );
  }
  return installPrebuilt({ ...options.install, reuse: true });
}

/**
 * Non-secret signing inputs, from the build environment the way Android signing already works.
 *
 * `THREENATIVE_DESKTOP_SIGN=1` requests signing; the identity/certificate/profile/timestamp values
 * name the developer's credentials but never carry the secret itself — the private key and the
 * notarytool password stay in the OS keychain. No inputs and no request means unsigned preparation,
 * which is recorded as `signed: false`.
 */
export function desktopSigningFromEnvironment(env = process.env) {
  const requested = env.THREENATIVE_DESKTOP_SIGN === '1' || env.THREENATIVE_DESKTOP_SIGN === 'true';
  // A CI job writing `SUBJECT: ${{ secrets.WIN_SIGN_SUBJECT }}` with the secret unset hands us the
  // empty string, not undefined. Treating that as "signing requested" turns a release that used to
  // produce an unsigned container into a hard failure, so blank reads the same as absent.
  const set = (value) => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
  const identity = set(env.THREENATIVE_DESKTOP_CODESIGN_IDENTITY);
  const certificate = set(env.THREENATIVE_DESKTOP_SIGN_CERTIFICATE);
  const subject = set(env.THREENATIVE_DESKTOP_SIGN_SUBJECT);
  const keychainProfile = set(env.THREENATIVE_DESKTOP_NOTARY_PROFILE);
  const timestampUrl = set(env.THREENATIVE_DESKTOP_TIMESTAMP_URL);
  if (!requested && identity === undefined && certificate === undefined && subject === undefined &&
    keychainProfile === undefined) {
    return undefined;
  }
  // Knowable here, so refuse here: the same clash inside signDesktopArtifact costs a whole release
  // build first. That check stays as well, because `signing` can be passed in directly.
  if (certificate !== undefined && subject !== undefined) {
    throw new Error('TN_DESKTOP_SIGNING_CREDENTIALS_AMBIGUOUS: THREENATIVE_DESKTOP_SIGN_CERTIFICATE and THREENATIVE_DESKTOP_SIGN_SUBJECT are both set; one of them would be silently ignored.');
  }
  return {
    ...(requested ? { requested: true } : {}),
    ...(identity === undefined ? {} : { identity }),
    ...(certificate === undefined ? {} : { certificate }),
    ...(subject === undefined ? {} : { subject }),
    ...(timestampUrl === undefined ? {} : { timestampUrl }),
    ...(keychainProfile === undefined ? {} : { keychainProfile, notarize: true }),
  };
}

export const DEFAULT_DESKTOP_CONFIG = {
  app: { id: 'com.threenative.game', name: 'ThreeNative', version: '0.1.0', build: 1 },
  display: { orientation: 'landscape', fullscreen: true, keepScreenOn: false, maxFps: 60 },
  window: { title: 'ThreeNative', width: 1280, height: 720, maximized: false, resizable: true },
};

/**
 * The packaged config's UI renderer, unresolved values included. Anything but `web` and
 * `native-css` stages no UI directory, which is the fail-closed shape: a value nobody defined
 * ships no overlay rather than a guess.
 */
function desktopUiRenderer(config) {
  const renderer = config?.ui?.renderer;
  return renderer === 'web' || renderer === 'native-css' ? renderer : 'native';
}

/**
 * Refuse a `native-css` game packaged against a host with no CSS backend.
 *
 * The CSS UI is an opt-in CMake flag, so the published prebuilt carries no `css-ui` staticlib and
 * would stage the stylesheets and then paint nothing over a working game — clean logs, blank HUD.
 * The backend string in the host names the rasteriser it was linked with, and that literal only
 * exists in a host built with `TN_ENABLE_CSS_UI=1`, so one byte scan is the whole check. Read in
 * chunks: the runtime is ~120 MB and the literal can sit anywhere in it.
 */
export function assertRuntimeHasCssUi(runtimePath) {
  const marker = 'CPU rasteriser, no WebView';
  const chunk = readFileSync(runtimePath);
  if (chunk.includes(marker)) return;
  throw new Error(
    `TN_CSS_UI_HOST_MISSING: ui.renderer is "native-css" but ${runtimePath} was not built with ` +
      'TN_ENABLE_CSS_UI=1 (the published prebuilt host has no CSS backend); build the host from ' +
      'source or choose another renderer.',
  );
}

function readConfig(configPath) {
  if (configPath === undefined) return DEFAULT_DESKTOP_CONFIG;
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`TN_CONFIG_FILE_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--assets', '--bundle', '--config', '--mode', '--output', '--runtime', '--ui'].includes(flag) || !value) {
      throw new Error('Usage: package-desktop.mjs --bundle FILE --output FILE [--runtime FILE] [--assets DIR] [--ui DIR] [--config FILE] [--mode debug|release]');
    }
    // `--mode` is a word, not a path; every other flag names a filesystem location.
    options[flag.slice(2)] = flag === '--mode' ? value : resolve(value);
  }
  if (options.mode !== undefined && options.mode !== 'debug' && options.mode !== 'release') {
    throw new Error(`Unknown build mode '${options.mode}'. Choose debug or release.`);
  }
  // `--runtime` is optional: a consumer build with no `--runtime` installs the verified
  // prebuilt from the release manifest via resolveDesktopRuntime. A maintainer build passes
  // the checkout-built binary explicitly.
  for (const required of ['bundle', 'output']) {
    if (!options[required]) throw new Error(`Missing --${required}.`);
  }
  return options;
}

export function packageDesktop(options) {
  const key = `${process.platform}-${process.arch}`;
  if (!['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'].includes(key)) {
    throw new Error(`Unsupported desktop platform '${key}'.`);
  }
  if (!options.bundle || !existsSync(options.bundle)) {
    throw new Error(`Missing native bundle for '${key}': ${options.bundle ?? '(not provided)'}`);
  }
  // An explicit `--runtime` keeps the original sync body: the preflight failure the
  // decoder tests assert stays a sync throw. Only the missing-runtime install is async.
  if (options.runtime) {
    if (!existsSync(options.runtime)) {
      throw new Error(`Missing prebuilt runtime for '${key}': ${options.runtime}`);
    }
    return compileOrPackage(options, options.runtime);
  }
  return resolveDesktopRuntime(undefined, { runtimeSource: options.runtimeSource, install: options.install }).then((runtime) =>
    compileOrPackage(options, runtime),
  );
}

function compileOrPackage(options, runtime) {
  if (options.mode === 'release') return packageDesktopRelease(options, runtime);
  return compileDesktopArtifact(options, runtime);
}

/**
 * Wrap the compiled executable in the complete desktop container for the host OS (PRD-365).
 *
 * The runtime compiler only knows how to produce a raw executable and stage `ui/` beside it; the
 * container layout, OS metadata and dependency census are OS operations and live in
 * `desktop-distribution.mjs`. The raw debug path above is untouched.
 */
async function packageDesktopRelease(options, runtime) {
  const { classifyDependencies, containerSlug, discoverRuntimeDependencies, packageDesktopContainer } =
    await loadDistribution();
  const staging = mkdtempSync(join(tmpdir(), 'threenative-desktop-release-'));
  try {
    const config = options.config === undefined ? DEFAULT_DESKTOP_CONFIG : readConfig(options.config);
    // Signing inputs are non-secret identity/options from the build environment; secrets stay in
    // the OS keychain. Without them, release stays an unsigned-but-complete container.
    const signing = desktopSigningFromEnvironment();
    const rawOutput = join(staging, containerSlug(basename(options.output)));
    const { bundle, executable } = compileDesktopArtifact({ ...options, output: rawOutput }, runtime, {
      sidecar: true,
    });
    const uiRenderer = desktopUiRenderer(config);
    const uiDirectory = uiRenderer === 'native' ? undefined : join(dirname(executable), 'ui');
    const discovered = options.dependencies === undefined
      ? classifyDependencies(discoverRuntimeDependencies(executable, { platform: process.platform, run: options.run }), {
          platform: process.platform,
        })
      : { bundled: options.dependencies, prerequisites: options.prerequisites ?? [] };
    const icon = config.app?.icon === undefined ? undefined : resolve(config.app.icon);
    const result = packageDesktopContainer({
      arch: process.arch,
      bundle,
      config,
      dependencies: discovered.bundled,
      executable,
      icon,
      output: options.output,
      platform: process.platform,
      prerequisites: discovered.prerequisites,
      run: options.run,
      signing,
      uiDirectory,
      uiRenderer,
    });
    console.log(`ThreeNative desktop container${result.signed ? ' (signed)' : ' (unsigned)'}: ${result.archive}`);
    if (result.installer) console.log('ThreeNative Windows installer: ' + result.installer);
    return result.archive;
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}

/**
 * Build the desktop artifact.
 *
 * Debug appends the game to a copy of the runtime, which is one self-contained file. Release takes
 * `sidecar`, which writes the game to `game.bundle` and leaves the executable a bare runtime copy:
 * anything that rewrites the executable afterwards - rcedit embedding the icon, `signtool` adding
 * the certificate table, `codesign` sealing a bundle - moves or discards data appended past the
 * end of the image, and the loader finds its footer only at physical EOF. Keeping the game beside
 * the executable instead of inside it is what makes release resource-editing and signing safe.
 */
function compileDesktopArtifact(options, runtime, { sidecar = false } = {}) {
  const output = process.platform === 'win32' && !options.output.endsWith('.exe')
    ? `${options.output}.exe`
    : options.output;
  mkdirSync(dirname(output), { recursive: true });
  // Named `game.bundle` because that is what the runtime's own `findExternalBundle` looks for
  // beside the executable; the container places it where each platform's loader searches.
  const bundle = join(dirname(output), 'game.bundle');
  const staging = mkdtempSync(join(tmpdir(), 'threenative-desktop-'));
  try {
    const stagedEntry = stageDesktopFiles(
      options.bundle,
      options.assets,
      staging,
      options.config === undefined ? undefined : readConfig(options.config),
      process.env.THREENATIVE_RUNTIME_SOURCE ?? runtimeRoot,
      // Installed from a tarball there is no CMakeLists to read, so the decoder preflight asks
      // this binary — the one the container is about to ship — instead of guessing.
      runtime,
    );
    // The UI bundle sits beside the executable rather than inside it. Desktop compiles to one
    // file, but the overlay's web view reads its page from a real path — that is what gives it a
    // real origin, the way `WebViewAssetLoader` does on Android, and it is the difference between
    // `fetch` behaving as it does on web and not. A game with the native UI renderer ships neither
    // the directory nor an overlay.
    const uiRenderer = options.config === undefined ? 'native' : desktopUiRenderer(readConfig(options.config));
    // Both paths reach here, so the CSS host check is one call: a `native-css` game needs a host
    // that actually has the backend, whether it is the maintainer's build or the published one.
    if (uiRenderer === 'native-css') assertRuntimeHasCssUi(runtime);
    stageDesktopUi(options.ui, uiRenderer, join(dirname(output), 'ui'));
    const args = [
      'compile',
      stagedEntry,
      '--root',
      staging,
      '--include',
      staging,
      '--out',
      sidecar ? bundle : output,
    ];
    // `--bundle-only` writes the bundle alone and copies no executable, so the runtime copy below
    // carries no appended payload for a later PE or Mach-O rewrite to lose.
    if (sidecar) args.push('--bundle-only');
    const result = spawnSync(runtime, args, { encoding: 'utf8', stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`Runtime packager exited with code ${result.status ?? 'unknown'}.`);
    if (sidecar) {
      if (!existsSync(bundle)) {
        throw new Error(`TN_DESKTOP_BUNDLE_MISSING: the runtime packager wrote no bundle at ${bundle}.`);
      }
      copyFileSync(runtime, output);
      // The sidecar copy is the bare runtime the container ships, so it is stripped here; the
      // executable the runtime packager wrote in debug mode has the game appended and must not be.
      stripDesktopRuntime(output, { run: options.stripRun });
    }
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
  if (process.platform !== 'win32') chmodSync(output, 0o755);
  console.log(`ThreeNative desktop artifact: ${output}`);
  return sidecar ? { bundle, executable: output } : output;
}

/**
 * Stage the built UI bundle beside the desktop executable.
 *
 * Fails closed both ways, for the same reasons the Android packager does: a `web` game with no
 * built UI would install, launch and show nothing over a working game, and a `native` game must
 * ship no bundle at all.
 */
export function stageDesktopUi(ui, renderer, destination) {
  rmSync(destination, { force: true, recursive: true });
  if (renderer !== 'web' && renderer !== 'native-css') {
    if (ui) {
      throw new Error(
        `TN_UI_BUNDLE_UNEXPECTED: a UI bundle was staged for a game whose ui.renderer is '${renderer}'. ` +
          'The native renderer ships no web view; remove the bundle or set ui.renderer to "web".',
      );
    }
    return [];
  }
  if (!ui || !existsSync(ui)) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ui.renderer is "${renderer}" but no built UI was found at ${ui ?? '(not provided)'}. ` +
        'Build the UI before packaging, or set ui.renderer to "native".',
    );
  }
  if (!statSync(ui).isDirectory()) throw new Error(`TN_UI_BUNDLE_MISSING: not a directory: ${ui}`);
  // `native-css` stages stylesheets the game's own JS realm paints, so there is no page to load.
  if (renderer === 'web' && !existsSync(join(ui, 'index.html'))) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ${ui} has no index.html, which is the page the overlay loads.`,
    );
  }
  if (renderer === 'native-css' && !listFiles(ui).some((file) => file.endsWith('.css'))) {
    throw new Error(
      `TN_UI_BUNDLE_MISSING: ui.renderer is "native-css" but ${ui} has no .css, which is what the native CSS engine paints.`,
    );
  }
  mkdirSync(destination, { recursive: true });
  cpSync(ui, destination, { recursive: true });
  return readdirSync(destination);
}

export function stageDesktopFiles(
  bundle,
  assets,
  staging,
  config = undefined,
  runtimeSource = runtimeRoot,
  runtimeExecutable = undefined,
) {
  mkdirSync(staging, { recursive: true });
  if (assets && existsSync(assets)) {
    if (!statSync(assets).isDirectory()) {
      throw new Error(`Desktop assets path is not a directory: ${assets}`);
    }
    // Desktop ran no preflight at all, so an asset the runtime cannot decode reached the same
    // rejected `decodeAudioData` that black-screened an APK — with the packager having already
    // read the bytes on its way past. Same gate, desktop's own derived capabilities.
    assertNativeAssetsDecodable(assets, {
      target: 'desktop',
      capabilities: { webp: deriveDesktopWebpSupport(runtimeSource, runtimeExecutable) },
    });
    if (existsSync(join(assets, '.threenative'))) {
      throw new Error('TN_NATIVE_ASSET_RESERVED_PATH: public/.threenative is reserved.');
    }
    const { selected } = selectManifestAssets(assets);
    for (const file of selected) {
      const output = join(staging, file);
      mkdirSync(dirname(output), { recursive: true });
      copyFileSync(join(assets, file), output);
    }
  }
  const entry = join(staging, '.threenative', 'game.js');
  mkdirSync(dirname(entry), { recursive: true });
  copyFileSync(bundle, entry);
  if (config !== undefined) {
    const icon = config.app?.icon ?? config.app?.icons?.android?.foreground;
    const packaged = { ...config, app: { ...(config.app ?? {}) } };
    // Flattened deliberately. The embedded config is read by a small scanner in the C++ host, and
    // `renderer` already exists at the top level as the WebGPU preference — a nested lookup for a
    // second `renderer` would find the wrong one. Anything but "web"/"native-css" is the native
    // renderer.
    packaged.uiRenderer = desktopUiRenderer(config);
    packaged.maxFps = config.display?.maxFps ?? 60;
    if (icon !== undefined) {
      if (!existsSync(icon) || !statSync(icon).isFile()) {
        throw new Error(`TN_CONFIG_BRAND_DESKTOP_MISSING: app icon does not exist: ${icon}`);
      }
      const stagedIcon = join(staging, '.threenative', 'app-icon.png');
      copyFileSync(icon, stagedIcon);
      packaged.app.icon = '.threenative/app-icon.png';
    }
    writeFileSync(join(staging, '.threenative', 'config.json'), `${JSON.stringify(packaged, null, 2)}\n`);
  }
  return entry;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await packageDesktop(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
