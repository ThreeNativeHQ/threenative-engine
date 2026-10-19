/**
 * OS container and resource operations for desktop release artifacts.
 *
 * `packageDesktop` delegates here for `--mode release`; the raw-binary debug path stays exactly
 * as it was. Nothing in this file decides how a game looks — it wraps the produced executable,
 * its UI bundle and the runtime dependencies discovered from that executable into one relocatable
 * container per native host, and writes the OS metadata that names the game.
 *
 * Signing and notarization are optional OS-tool operations. A release archive replaces the
 * previous output only after every requested packaging/signing/notarization stage succeeds.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildWindowsInstaller } from './windows-installer.mjs';

export const CONTAINER_MANIFEST = 'threenative-container.json';
export const CONTAINER_SCHEMA_VERSION = 1;
export const DESKTOP_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64'];

// The loader's own directories. A library resolved from one of these is the player's machine to
// provide; everything else the runtime actually needs travels inside the container, or the
// artifact is not relocatable. Matched against the resolved path, because a bundled library can
// carry any soname.
const SYSTEM_LIBRARY_DIRECTORIES = [
  '/lib/',
  '/lib64/',
  '/usr/lib/',
  '/usr/lib64/',
  '/usr/libexec/',
  '/usr/lib/system/',
  '/System/Library/',
  '/usr/local/lib/system/',
];

// Libraries the platform itself owns, by name, whether or not the tool resolved a path. The GTK,
// WebKit, X11 and Wayland stacks are the documented Linux player prerequisite (PRD-365 phase 2),
// not something an unsigned tarball re-ships.
const SYSTEM_LIBRARY_NAMES = new Set([
  'libc.so.6', 'libm.so.6', 'libdl.so.2', 'libpthread.so.0', 'librt.so.1', 'libgcc_s.so.1',
  'libstdc++.so.6', 'libatomic.so.1', 'libnsl.so.1', 'libutil.so.1', 'libresolv.so.2',
  'libX11.so.6', 'libXext.so.6', 'libXrandr.so.2', 'libXi.so.6', 'libXcursor.so.1',
  'libXinerama.so.1', 'libxkbcommon.so.0', 'libwayland-client.so.0', 'libwayland-server.so.0',
  'libwayland-cursor.so.0', 'libwayland-egl.so.1', 'libepoxy.so.0', 'libgbm.so.1', 'libdrm.so.2',
  'libGL.so.1', 'libEGL.so.1', 'libGLESv2.so.2', 'libvulkan.so.1', 'libasound.so.2',
  'libpulse.so.0', 'libdbus-1.so.3', 'libudev.so.1', 'libsystemd.so.0',
  'libgobject-2.0.so.0', 'libglib-2.0.so.0', 'libgio-2.0.so.0', 'libgtk-3.so.0',
  'libgdk-3.so.0', 'libwebkit2gtk-4.1.so.0', 'libjavascriptcoregtk-4.1.so.0', 'libsoup-3.0.so.0',
  'libz.so.1', 'libexpat.so.1', 'libfontconfig.so.1', 'libfreetype.so.6', 'libpng16.so.16',
  'libharfbuzz.so.0', 'libpango-1.0.so.0', 'libcairo.so.2', 'libcairo-gobject.so.2',
  'libgdk_pixbuf-2.0.so.0', 'libatk-1.0.so.0', 'libatk-bridge-2.0.so.0', 'libcurl.so.4',
]);

const SYSTEM_WINDOWS_DLLS = new Set([
  'kernel32.dll', 'user32.dll', 'gdi32.dll', 'advapi32.dll', 'shell32.dll', 'ole32.dll',
  'oleaut32.dll', 'ws2_32.dll', 'opengl32.dll', 'winmm.dll', 'userenv.dll', 'version.dll',
  'setupapi.dll', 'cfgmgr32.dll', 'bcrypt.dll', 'crypt32.dll', 'dwmapi.dll', 'shlwapi.dll',
  'comdlg32.dll', 'imm32.dll', 'uxtheme.dll', 'd3d11.dll', 'dxgi.dll', 'd3dcompiler_47.dll',
]);

function exec(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    error: result.error,
    signal: result.signal,
    status: result.status,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function sha256File(path) {
  return sha256(readFileSync(path));
}

function missing(path, label) {
  return `TN_DESKTOP_INPUT_MISSING: ${label} does not exist: ${path}`;
}

function assertDirectory(path, label) {
  if (!path || !existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(missing(path ?? '(not provided)', label));
  }
}

function assertFile(path, label) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) {
    throw new Error(missing(path ?? '(not provided)', label));
  }
}

export function desktopTargetKey(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`;
  if (!DESKTOP_TARGETS.includes(key)) {
    throw new Error(`Unsupported desktop platform '${key}'.`);
  }
  return key;
}

export function desktopContainerFormat(platform = process.platform) {
  if (platform === 'linux') return 'tar.gz';
  if (platform === 'darwin' || platform === 'win32') return 'zip';
  throw new Error(`TN_DESKTOP_CONTAINER_UNSUPPORTED: no container format for '${platform}'.`);
}

export function containerArchivePath(output, platform = process.platform) {
  const extension = desktopContainerFormat(platform) === 'tar.gz' ? '.tar.gz' : '.zip';
  return output.endsWith(extension) ? output : `${output}${extension}`;
}

/** A filesystem-safe project name; the game's display name stays in the OS metadata. */
export function containerSlug(appName) {
  return String(appName).trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'game';
}

/** The single top-level directory an archive extracts to, so a container is one relocatable unit. */
export function containerRootFolder(platform, appName) {
  return platform === 'darwin' ? `${appName}.app` : containerSlug(appName);
}

function listFiles(root) {
  const files = [];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(absolute, relativePath);
      else if (entry.isFile()) files.push({ absolute, relative: relativePath });
    }
  };
  walk(root, '');
  return files;
}

/**
 * Parse the dependency tool every native host already ships. Kept pure so the contract can be
 * pinned without a binary that links anything.
 */
export function parseLinkedLibraries(output, platform) {
  const libraries = [];
  if (platform === 'linux') {
    for (const line of output.split('\n')) {
      const resolved = /^\s*(\S+)\s+=>\s+(.+?)\s+\(0x[0-9a-f]+\)\s*$/u.exec(line);
      if (resolved) {
        libraries.push({ name: resolved[1], path: resolved[2] });
        continue;
      }
      // `linux-vdso.so.1` and `/lib64/ld-linux-x86-64.so.2` have no `=>`; they are the kernel and
      // loader and are never bundled. A bare `=> not found` has no path and fails closed later.
      const unresolved = /^\s*(\S+)\s+=>\s+not found\s*$/u.exec(line);
      if (unresolved) libraries.push({ missing: true, name: unresolved[1] });
    }
    return libraries;
  }
  if (platform === 'darwin') {
    for (const line of output.split('\n').slice(1)) {
      const resolved = /^\s*(.+?)\s+\(compatibility version/u.exec(line);
      if (resolved) libraries.push({ name: basename(resolved[1]), path: resolved[1] });
    }
    return libraries;
  }
  if (platform === 'win32') {
    for (const line of output.split('\n')) {
      const resolved = /^\s*(\S+\.dll)\s*$/iu.exec(line);
      if (resolved) libraries.push({ name: resolved[1], path: undefined });
    }
    return libraries;
  }
  throw new Error(`TN_DESKTOP_CONTAINER_UNSUPPORTED: no dependency tool for '${platform}'.`);
}

/** Inspect the produced executable and return every shared library it loads. */
export function discoverRuntimeDependencies(binary, { platform = process.platform, run = exec } = {}) {
  assertFile(binary, 'desktop executable');
  const tool = platform === 'linux'
    ? { args: [binary], command: 'ldd' }
    : platform === 'darwin'
      ? { args: ['-L', binary], command: 'otool' }
      : { args: ['/DEPENDENTS', binary], command: 'dumpbin' };
  const result = run(tool.command, tool.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) {
    throw new Error(
      `TN_DESKTOP_DEPENDENCY_TOOL_MISSING: '${tool.command}' is required to resolve native dependencies (${result.error.message}).`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `TN_DESKTOP_DEPENDENCY_RESOLUTION_FAILED: '${tool.command}' exited ${result.status ?? 'unknown'} for ${binary}.\n${result.stderr}`,
    );
  }
  const libraries = parseLinkedLibraries(result.stdout, platform);
  const unresolved = libraries.filter((library) => library.missing);
  if (unresolved.length > 0) {
    throw new Error(
      `TN_DESKTOP_DEPENDENCY_MISSING: ${unresolved.map((library) => library.name).join(', ')} could not be resolved for ${binary}.`,
    );
  }
  return libraries;
}

function isSystemLibrary(library, platform, systemRoot) {
  if (platform === 'win32') {
    const name = library.name.toLowerCase();
    // api-ms-win-* and ext-ms-win-* are API Set contracts: virtual names the loader redirects to a
    // real implementation. They are never files on disk and always come from the OS, and dumpbin
    // reports them for anything linked against the UCRT, so no allowlist of real DLL names can
    // enumerate them.
    if (name.startsWith('api-ms-win-') || name.startsWith('ext-ms-win-')) return true;
    if (SYSTEM_WINDOWS_DLLS.has(name)) return true;
    // `dumpbin /DEPENDENTS` prints names and no paths, so an allowlist is the only thing standing
    // between a real system DLL and a refusal. Ask the system directory the loader itself searches
    // instead of guessing which names Microsoft ships; the allowlist above stays a fast path and
    // keeps this decidable on a non-Windows host, where there is no system directory to consult.
    return systemRoot !== undefined && existsSync(join(systemRoot, 'System32', library.name));
  }
  if (!library.path) return false;
  if (platform === 'darwin') {
    return library.path.startsWith('/usr/lib/') || library.path.startsWith('/System/');
  }
  return SYSTEM_LIBRARY_NAMES.has(library.name) ||
    SYSTEM_LIBRARY_DIRECTORIES.some((directory) => library.path.startsWith(directory));
}

/**
 * Split the executable's libraries into the ones the player machine provides (recorded as
 * prerequisites) and the ones the container must carry. A library that is neither system nor
 * locatable fails closed rather than shipping an artifact that only launches here.
 */
export function classifyDependencies(
  libraries,
  { platform = process.platform, systemRoot = process.env.SystemRoot } = {},
) {
  const bundled = [];
  const prerequisites = [];
  for (const library of libraries) {
    if (isSystemLibrary(library, platform, systemRoot)) {
      prerequisites.push({ name: library.name });
      continue;
    }
    if (!library.path) {
      throw new Error(`TN_DESKTOP_DEPENDENCY_UNLOCATABLE: ${library.name} is not a system library and has no path to copy.`);
    }
    assertFile(library.path, `native dependency ${library.name}`);
    bundled.push({ name: basename(library.path), source: library.path });
  }
  return { bundled, prerequisites };
}

/**
 * The loading sequence the consumer config declared, recorded so a distributed container can be
 * checked against the config that built it.
 *
 * The splash is drawn by the game's own generated `src/render/loading.ts` from assets already
 * inside the bundle, so this records identity rather than a second copy: the authored colour and
 * the authored image's hash. A game with no `bootSplash` records that it has none — writing
 * nothing would leave a consumer unable to tell "no splash configured" from "evidence missing",
 * which is the difference between a pass and a false pass.
 */
export function containerLoading(config) {
  const bootSplash = config?.bootSplash;
  if (bootSplash === undefined || bootSplash === null) return { bootSplash: null };
  let imageSha256 = null;
  if (bootSplash.image !== undefined) {
    if (!bootSplash.image || !existsSync(bootSplash.image) || !statSync(bootSplash.image).isFile()) {
      throw new Error(
        `TN_DESKTOP_SPLASH_IMAGE_MISSING: bootSplash.image does not exist: ${bootSplash.image ?? '(not provided)'}`,
      );
    }
    imageSha256 = sha256File(bootSplash.image);
  }
  return {
    bootSplash: {
      ...(bootSplash.backgroundColor === undefined
        ? {}
        : { backgroundColor: bootSplash.backgroundColor }),
      imageSha256,
    },
  };
}

export function containerMetadata({ platform = process.platform, config }) {
  const app = config?.app ?? {};
  const id = app.id ?? 'com.threenative.game';
  const name = app.name ?? 'ThreeNative';
  const version = app.version ?? '0.1.0';
  const build = String(app.build ?? 1);
  const slug = containerSlug(name);
  const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  if (platform === 'linux') {
    return {
      [`share/applications/${id}.desktop`]: [
        '[Desktop Entry]',
        'Type=Application',
        `Name=${name}`,
        `Exec=${slug}`,
        `TryExec=${slug}`,
        `Icon=${id}`,
        'Terminal=false',
        'Categories=Game;',
        'StartupNotify=true',
        '',
      ].join('\n'),
    };
  }
  if (platform === 'darwin') {
    return {
      'Contents/Info.plist': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '  <key>CFBundleDevelopmentRegion</key><string>en</string>',
        `  <key>CFBundleExecutable</key><string>${xml(slug)}</string>`,
        `  <key>CFBundleIdentifier</key><string>${xml(id)}</string>`,
        '  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>',
        `  <key>CFBundleName</key><string>${xml(name)}</string>`,
        `  <key>CFBundleDisplayName</key><string>${xml(name)}</string>`,
        '  <key>CFBundlePackageType</key><string>APPL</string>',
        `  <key>CFBundleShortVersionString</key><string>${xml(version)}</string>`,
        `  <key>CFBundleVersion</key><string>${xml(build)}</string>`,
        `  <key>CFBundleIconFile</key><string>${xml(slug)}</string>`,
        '  <key>LSMinimumSystemVersion</key><string>11.0</string>',
        '  <key>NSHighResolutionCapable</key><true/>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    };
  }
  if (platform === 'win32') {
    // Windows identity lives in the executable's PE resource section, written by `rcedit`.
    return {};
  }
  throw new Error(`TN_DESKTOP_CONTAINER_UNSUPPORTED: no metadata for '${platform}'.`);
}

/** Root-relative paths, one per platform, so every consumer resolves from the container root. */
function layout(platform, { appName, executableName, iconName }) {
  const slug = containerSlug(appName);
  if (platform === 'linux') {
    return {
      // `findExternalBundle` looks beside the executable on Linux and Windows, and in
      // Contents/Resources for a macOS .app. Stage it where the loader already searches.
      bundle: 'game.bundle',
      executable: slug,
      icon: `share/icons/hicolor/256x256/apps/${iconName}.png`,
      manifest: CONTAINER_MANIFEST,
      ui: 'ui',
    };
  }
  if (platform === 'darwin') {
    return {
      bundle: 'Contents/Resources/game.bundle',
      executable: `Contents/MacOS/${slug}`,
      icon: `Contents/Resources/${slug}.icns`,
      manifest: `Contents/Resources/${CONTAINER_MANIFEST}`,
      // SDL_GetBasePath() resolves to Contents/Resources/ for a bundled macOS app, and that is
      // what src/cli/main.cpp joins a relative ui root against. Staging beside the executable
      // launches the container with no HUD.
      ui: 'Contents/Resources/ui',
    };
  }
  return {
    bundle: 'game.bundle',
    executable: executableName,
    icon: `${iconName}.png`,
    manifest: CONTAINER_MANIFEST,
    ui: 'ui',
  };
}

function dependencyRelativePath(platform, name) {
  if (platform === 'darwin') return `Contents/Frameworks/${name}`;
  if (platform === 'linux') return `lib/${name}`;
  return name;
}

/**
 * Wrap a PNG in a single-image Windows .ico. rcedit's `--set-icon` needs an icon Windows can parse
 * and refuses a bare PNG, and Vista onwards reads a PNG-compressed icon entry directly, so the
 * container needs no image tool on the packaging machine and no new player prerequisite.
 */
export function pngToIco(source, destination) {
  const png = readFileSync(source);
  // 8-byte signature, then the IHDR length and tag, then width and height as big-endian uint32.
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47 || png.readUInt32BE(12) !== 0x49484452) {
    throw new Error(`TN_DESKTOP_RESOURCE_FAILED: ${source} is not a PNG, so it cannot become a Windows icon.`);
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  // 0 means 256 in an icon directory entry; anything larger cannot be described at all.
  header.writeUInt8(width >= 256 ? 0 : width, 6);
  header.writeUInt8(height >= 256 ? 0 : height, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  writeFileSync(destination, Buffer.concat([header, png]));
}

function buildIcon(icon, destination, { platform, run }) {
  if (platform === 'linux') {
    copyFileSync(icon, destination);
    return;
  }
  if (platform === 'darwin') {
    if (icon.endsWith('.icns')) {
      copyFileSync(icon, destination);
      return;
    }
    // .icns is what Finder and Dock read; it is built with the OS's own tools, never hand-rolled.
    const iconsetDirectory = mkdtempSync(join(tmpdir(), 'threenative-iconset-'));
    const iconset = join(iconsetDirectory, 'app.iconset');
    try {
      mkdirSync(iconset);
      for (const size of [16, 32, 128, 256, 512]) {
        for (const scale of [1, 2]) {
          const pixels = String(size * scale);
          const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
          const sips = run('sips', ['-z', pixels, pixels, icon, '--out', join(iconset, name)], {});
          if (sips.error) throw new Error(`TN_DESKTOP_RESOURCE_TOOL_MISSING: 'sips' is required to build an .icns (${sips.error.message}).`);
          if (sips.status !== 0) throw new Error(`TN_DESKTOP_RESOURCE_FAILED: sips exited ${sips.status ?? 'unknown'}.`);
        }
      }
      const built = run('iconutil', ['-c', 'icns', iconset, '-o', destination], {});
      if (built.error) throw new Error(`TN_DESKTOP_RESOURCE_TOOL_MISSING: 'iconutil' is required to build an .icns (${built.error.message}).`);
      if (built.status !== 0) throw new Error(`TN_DESKTOP_RESOURCE_FAILED: iconutil exited ${built.status ?? 'unknown'}.`);
    } finally {
      rmSync(iconsetDirectory, { force: true, recursive: true });
    }
    return;
  }
  throw new Error(`TN_DESKTOP_CONTAINER_UNSUPPORTED: no icon builder for '${platform}'.`);
}

/** The local file header every zip starts with, and an empty archive's end-of-central-directory. */
function isZipArchive(path) {
  const header = Buffer.alloc(4);
  let handle;
  try {
    handle = openSync(path, 'r');
    if (readSync(handle, header, 0, 4, 0) !== 4) return false;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
  return header.toString('latin1') === 'PK\u0003\u0004' || header.toString('latin1') === 'PK\u0005\u0006';
}

/**
 * Tools that write a real `.zip`, best first.
 *
 * tar.gz has one universal writer; .zip does not. `zip` is absent from a stock Arch and from
 * Windows entirely — where packaging a Windows container therefore failed on the one tool it
 * needed, on the OS the container is for. libarchive fills the gap: `bsdtar` on Arch and Homebrew,
 * and plain `tar` on macOS and Windows 10 1803 onwards, where `-a` picks the format from the .zip
 * suffix. Both carry the Unix mode bits, so a macOS `.app` still has its executable bit after a
 * round trip; `7z` is deliberately not on this list, because its zip writer drops them and every
 * platform that needs a zip already ships one of these three.
 */
function zipWriters(candidate, staging, rootFolder) {
  return [
    { args: ['-r', '-q', candidate, rootFolder], name: 'zip', options: { cwd: staging } },
    { args: ['-a', '-c', '-f', candidate, rootFolder], name: 'bsdtar', options: { cwd: staging } },
    { args: ['-a', '-c', '-f', candidate, rootFolder], name: 'tar', options: { cwd: staging } },
  ];
}

function archiveContainer({ platform, staging, rootFolder, output, run }) {
  // zip updates existing archives in place, retaining removed files. Build a fresh candidate on
  // the output filesystem and replace the old artifact only after the archiver succeeds.
  const archiveDirectory = mkdtempSync(join(dirname(output), '.threenative-archive-'));
  const candidate = join(archiveDirectory, basename(output));
  try {
    // tar.gz has one universal writer; .zip does not. `zip` is not installed on a stock Arch or
    // slim container image, and has never existed on Windows — where packaging a Windows container
    // therefore failed on the one tool it needed, on the OS the container is for. Each candidate
    // below writes a .zip that every player's OS unpacks natively, and the first one installed
    // wins, so a machine with any of them can package a release.
    const candidates = platform === 'linux'
      ? [{ args: ['-czf', candidate, '-C', staging, rootFolder], name: 'tar' }]
      : zipWriters(candidate, staging, rootFolder);
    const wantsZip = desktopContainerFormat(platform) === 'zip';
    let used;
    let result;
    let mislabelled;
    for (const command of candidates) {
      // zip updates in place and a rejected candidate leaves its own bytes behind, so every
      // attempt starts from nothing.
      rmSync(candidate, { force: true });
      result = run(command.name, command.args, command.options ?? {});
      // Only a missing tool is worth another candidate. A tool that ran and failed is a real
      // failure, and retrying past it would hide it behind whichever archiver came next.
      if (result.error) continue;
      // An archiver is trusted to run, not to have written the format its suffix promises: GNU
      // tar answers to libarchive's name and compresses by suffix, which it does not know for
      // .zip, so it leaves a gzip wearing a .zip extension. That is this candidate failing rather
      // than the build failing — the next one may be installed — but it must never ship.
      if (result.status === 0 && wantsZip && command.name !== 'zip' && !isZipArchive(candidate)) {
        mislabelled = command.name;
        continue;
      }
      used = command;
      break;
    }
    if (used === undefined) {
      rmSync(candidate, { force: true });
      const names = candidates.map((entry) => entry.name).join(', ');
      throw new Error(
        `TN_DESKTOP_ARCHIVE_TOOL_MISSING: one of ${names} is required to write ${output} ` +
          (mislabelled === undefined
            ? `(${result.error.message}).`
            : `('${mislabelled}' ran but wrote no zip archive).`),
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `TN_DESKTOP_ARCHIVE_FAILED: '${used.name}' exited ${result.status ?? 'unknown'} for ${output}.\n${result.stderr}`,
      );
    }
    renameSync(candidate, output);
  } finally {
    rmSync(archiveDirectory, { force: true, recursive: true });
  }
}

/** Extract a release archive so a verifier can resolve its payload outside the build tree. */
export function extractContainer(archive, destination, { platform = process.platform, run = exec } = {}) {
  assertFile(archive, 'desktop container archive');
  mkdirSync(destination, { recursive: true });
  // Same portability gap as writing, on the other side of it: `unzip` is absent from a stock Arch
  // and from Windows, so a host that can now write a container could not unpack its own. libarchive
  // reads zip through `tar -xf` on both, and all three preserve the Unix mode the launcher needs.
  const candidates = desktopContainerFormat(platform) === 'tar.gz'
    ? [{ args: ['-xzf', archive, '-C', destination], name: 'tar' }]
    : [
      { args: ['-q', archive, '-d', destination], name: 'unzip' },
      { args: ['-x', '-f', archive, '-C', destination], name: 'bsdtar' },
      { args: ['-x', '-f', archive, '-C', destination], name: 'tar' },
    ];
  let used;
  let result;
  for (const command of candidates) {
    result = run(command.name, command.args, {});
    // A tool that ran and failed is a real failure; only a missing one is worth the next candidate.
    if (result.error) continue;
    used = command;
    break;
  }
  if (used === undefined) {
    throw new Error(
      `TN_DESKTOP_EXTRACT_TOOL_MISSING: one of ${candidates.map((entry) => entry.name).join(', ')} is ` +
        `required to unpack ${archive} (${result.error.message}).`,
    );
  }
  if (result.status !== 0) {
    throw new Error(`TN_DESKTOP_EXTRACT_FAILED: '${used.name}' exited ${result.status ?? 'unknown'} for ${archive}.`);
  }
  return join(destination, locateContainerRoot(destination));
}

/** The single top-level directory an archive extracted to. */
export function locateContainerRoot(extractDirectory) {
  const directories = readdirSync(extractDirectory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  if (directories.length !== 1) {
    throw new Error(
      `TN_DESKTOP_CONTAINER_LAYOUT_INVALID: expected one top-level directory in ${extractDirectory}, found ${directories.length}.`,
    );
  }
  return directories[0];
}

/**
 * Resolve a container from wherever it was unpacked. Every recorded resource is addressed
 * relative to the container root, so a move is legal; a resource absent or whose bytes changed
 * is a container that must not launch, not a warning.
 */
export function resolveContainer(root, { platform = process.platform, run = exec } = {}) {
  const resolvedRoot = resolve(root);
  assertDirectory(resolvedRoot, 'desktop container root');
  const candidates = platform === 'darwin'
    ? [join('Contents', 'Resources', CONTAINER_MANIFEST), CONTAINER_MANIFEST]
    : [CONTAINER_MANIFEST, join('Contents', 'Resources', CONTAINER_MANIFEST)];
  const manifestRelative = candidates.find((candidate) => existsSync(join(resolvedRoot, candidate)));
  if (!manifestRelative) {
    throw new Error(`TN_DESKTOP_CONTAINER_MANIFEST_MISSING: no ${CONTAINER_MANIFEST} under ${resolvedRoot}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(resolvedRoot, manifestRelative), 'utf8'));
  } catch (error) {
    throw new Error(`TN_DESKTOP_CONTAINER_MANIFEST_INVALID: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
    manifest.schemaVersion !== CONTAINER_SCHEMA_VERSION ||
    !manifest.resources || typeof manifest.resources !== 'object' || Array.isArray(manifest.resources) ||
    !Array.isArray(manifest.dependencies) ||
    (manifest.ui !== null && (!manifest.ui || typeof manifest.ui !== 'object' || Array.isArray(manifest.ui)))) {
    throw new Error('TN_DESKTOP_CONTAINER_MANIFEST_INVALID: unsupported schema or missing payload inventory.');
  }
  // Without the bundle the executable is a bare runtime that prints CLI usage instead of the game,
  // which is exactly the failure a released container must never reach a player with. Name that
  // case rather than letting it fall through as a required resource called 'undefined': a container
  // built before the game moved beside the executable has no `bundle` at all.
  if (typeof manifest.bundle !== 'string' || !manifest.bundle) {
    throw new Error(
      'TN_DESKTOP_CONTAINER_MANIFEST_INVALID: the manifest names no game bundle, so this container ' +
        'predates the sidecar layout and its executable would launch the runtime CLI. Rebuild it.',
    );
  }
  const required = [
    manifest.executable,
    manifest.bundle,
    ...manifest.dependencies.map((dependency) => dependency?.path),
    ...(manifest.ui === null ? [] : [manifest.ui.entry]),
    ...(manifest.app?.icon === undefined ? [] : [manifest.app.icon]),
  ];
  for (const path of required) {
    if (typeof path !== 'string' || !path || !Object.hasOwn(manifest.resources, path)) {
      throw new Error(`TN_DESKTOP_CONTAINER_MANIFEST_INVALID: required resource '${path}' has no integrity record.`);
    }
  }
  const signedMac = /^darwin-(?:x64|arm64)$/u.test(manifest.platform) &&
    manifest.signed === true && manifest.signingScheme === 'codesign';
  if (signedMac && (manifestRelative !== join('Contents', 'Resources', CONTAINER_MANIFEST) ||
    !/^Contents\/MacOS\/[^/\\]+$/u.test(manifest.executable) ||
    manifest.resources[manifest.executable]?.signature !== 'codesign')) {
    throw new Error('TN_DESKTOP_CONTAINER_MANIFEST_INVALID: a signed macOS app requires a sealed internal manifest and a codesign integrity record for its main executable.');
  }
  const physicalRoot = realpathSync(resolvedRoot);
  for (const [relativePath, expected] of Object.entries(manifest.resources)) {
    const signature = signedMac && relativePath === manifest.executable && expected?.signature === 'codesign';
    const hash = typeof expected?.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(expected.sha256);
    if (!relativePath || !expected || Array.isArray(expected) || Object.keys(expected).length !== 1 || (!signature && !hash)) {
      throw new Error(`TN_DESKTOP_CONTAINER_MANIFEST_INVALID: invalid integrity record for '${relativePath}'.`);
    }
    const absolute = resolve(resolvedRoot, relativePath);
    const within = relative(resolvedRoot, absolute);
    if (isAbsolute(relativePath) || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new Error(
        `TN_DESKTOP_CONTAINER_MANIFEST_INVALID: ${relativePath} escapes the container root.`,
      );
    }
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      throw new Error(
        `TN_DESKTOP_CONTAINER_INCOMPLETE: ${relativePath} is named by the container manifest but is not in the payload.`,
      );
    }
    const physicalPath = relative(physicalRoot, realpathSync(absolute));
    if (physicalPath === '..' || physicalPath.startsWith(`..${sep}`) || isAbsolute(physicalPath)) {
      throw new Error(`TN_DESKTOP_CONTAINER_MANIFEST_INVALID: ${relativePath} resolves outside the container root.`);
    }
    if (signature) continue;
    const actual = sha256File(absolute);
    if (actual !== expected.sha256) {
      throw new Error(
        `TN_DESKTOP_CONTAINER_TAMPERED: ${relativePath} hashes ${actual}, not the recorded ${expected.sha256}.`,
      );
    }
  }
  if (signedMac) {
    if (platform !== 'darwin') {
      throw new Error('TN_DESKTOP_CODESIGN_HOST_REQUIRED: verify this signed application on macOS with codesign.');
    }
    signingTool(run, 'codesign', ['--verify', '--strict', '--deep', resolvedRoot], 'TN_DESKTOP_CODESIGN_VERIFY');
  }
  return manifest;
}

/** The game identity the container carries must equal the one the author configured. */
export function assertContainerIdentity(manifest, config, { icon } = {}) {
  const app = config?.app ?? {};
  for (const field of ['id', 'name', 'version']) {
    if (manifest.app?.[field] !== app[field]) {
      throw new Error(
        `TN_DESKTOP_BRAND_MISMATCH: container app.${field} is '${manifest.app?.[field]}', config says '${app[field]}'.`,
      );
    }
  }
  if (icon !== undefined) {
    assertFile(icon, 'app icon');
    const expected = sha256File(icon);
    if (manifest.app?.iconSha256 !== expected) {
      throw new Error('TN_DESKTOP_BRAND_MISMATCH: the container did not embed the configured app icon.');
    }
  }
  return manifest;
}

/**
 * Signing is OS tooling run outside the game runtime. Non-secret identity/options come from
 * validated build inputs; secrets stay in the OS keychain. Linux has no Authenticode or
 * notarization, so a Linux container is never described as signed.
 */

/** Notarization evidence must name the artifact it notarized and report Apple's acceptance. */
export function assertNotaryEvidence({ artifactSha256, evidence }) {
  if (!evidence || typeof evidence.artifactSha256 !== 'string') {
    throw new Error('TN_DESKTOP_NOTARY_MISSING: notarization evidence carries no artifact sha256.');
  }
  if (evidence.artifactSha256 !== artifactSha256) {
    throw new Error(
      `TN_DESKTOP_NOTARY_MISMATCH: the notarization evidence is for ${evidence.artifactSha256}, not the produced artifact ${artifactSha256}.`,
    );
  }
  if (evidence.status !== 'Accepted') {
    throw new Error(`TN_DESKTOP_NOTARY_FAILED: notarization returned '${evidence.status}'.`);
  }
  return evidence;
}

function signingTool(run, name, args, code) {
  const result = run(name, args, {});
  if (result.error) {
    throw new Error(`${code}_TOOL_MISSING: '${name}' is required to sign the desktop artifact (${result.error.message}).`);
  }
  if (result.status !== 0) {
    throw new Error(`${code}_FAILED: '${name}' exited ${result.status ?? 'unknown'}.\n${result.stderr ?? ''}`);
  }
  return result;
}

/**
 * Sign the staged artifact with the platform's own tool. Throws instead of returning when signing
 * fails, so no archive is written for a release that only claims to be signed.
 */
export function signDesktopArtifact({ platform = process.platform, target, signing, run = exec } = {}) {
  if (platform === 'linux') {
    return { scheme: 'none', signed: false, reason: 'Linux has no Authenticode/notarization; the archive carries integrity metadata.' };
  }
  if (!target || !existsSync(target)) throw new Error(missing(target ?? '(not provided)', 'artifact to sign'));
  if (platform === 'darwin') {
    if (!signing?.identity) {
      throw new Error('TN_DESKTOP_SIGNING_CREDENTIALS_MISSING: macOS signing needs a Developer ID identity; unsigned preparation can proceed without signing.');
    }
    // Hardened runtime otherwise denies the MAP_JIT memory V8/JavaScriptCore execute from.
    // Entitlements belong to the application executable, never its nested dynamic libraries.
    const temporary = statSync(target).isDirectory() ? mkdtempSync(join(tmpdir(), 'threenative-sign-')) : undefined;
    try {
      const entitlements = temporary === undefined ? [] : ['--entitlements', join(temporary, 'jit.plist')];
      if (temporary !== undefined) {
        writeFileSync(entitlements[1], '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>\n');
      }
      signingTool(run, 'codesign', ['--force', '--options', 'runtime', ...entitlements, '--sign', signing.identity, target], 'TN_DESKTOP_CODESIGN');
      signingTool(run, 'codesign', ['--verify', '--strict', '--deep', target], 'TN_DESKTOP_CODESIGN_VERIFY');
    } finally {
      if (temporary !== undefined) rmSync(temporary, { force: true, recursive: true });
    }
    // `target` is the `.app` directory, which has no single file hash; notarization evidence binds
    // to the archive's bytes instead.
    return { scheme: 'codesign', signed: true };
  }
  if (platform === 'win32') {
    if (signing?.certificate && signing?.subject) {
      throw new Error('TN_DESKTOP_SIGNING_CREDENTIALS_AMBIGUOUS: Windows signing takes a certificate file or a store subject, not both; one of them would be silently ignored.');
    }
    if (!signing?.certificate && !signing?.subject) {
      throw new Error('TN_DESKTOP_SIGNING_CREDENTIALS_MISSING: Windows signing needs a code-signing certificate file or a certificate store subject; unsigned preparation can proceed without signing.');
    }
    const timestamp = signing.timestampUrl ? ['/tr', signing.timestampUrl, '/td', 'sha256'] : [];
    // `/f` reads a PFX and takes a `/p` password this contract deliberately does not carry, so it
    // only ever works for a password-less file - which is not what a CA issues. `/n` signs from the
    // Windows certificate store, keeping the private key in the OS keychain as the README promises.
    const credential = signing.subject ? ['/n', signing.subject] : ['/f', signing.certificate];
    signingTool(run, 'signtool', ['sign', '/fd', 'sha256', ...timestamp, ...credential, target], 'TN_DESKTOP_SIGNTOOL');
    signingTool(run, 'signtool', ['verify', '/pa', target], 'TN_DESKTOP_SIGNTOOL_VERIFY');
    return { artifactSha256: sha256File(target), scheme: 'signtool', signed: true };
  }
  throw new Error(`TN_DESKTOP_CONTAINER_UNSUPPORTED: no signing tool for '${platform}'.`);
}

/** Submit the archive to Apple and return evidence bound to that exact archive's bytes. */
export function notarizeArchive({ archive, signing, run = exec } = {}) {
  if (!signing?.keychainProfile) {
    throw new Error('TN_DESKTOP_SIGNING_CREDENTIALS_MISSING: macOS notarization needs a notarytool keychain profile.');
  }
  assertFile(archive, 'desktop container archive');
  const submittedSha256 = sha256File(archive);
  const result = signingTool(
    run,
    'xcrun',
    ['notarytool', 'submit', archive, '--keychain-profile', signing.keychainProfile, '--wait', '--output-format', 'json'],
    'TN_DESKTOP_NOTARYTOOL',
  );
  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    throw new Error(`TN_DESKTOP_NOTARY_FAILED: notarytool returned unreadable JSON: ${result.stdout}`);
  }
  const artifactSha256 = sha256File(archive);
  return assertNotaryEvidence({
    artifactSha256,
    evidence: { artifactSha256: submittedSha256, id: payload.id, status: payload.status },
  });
}

/**
 * Build one complete desktop container, unsigned unless signing inputs are supplied.
 *
 * The caller supplies the executable the runtime compiler produced, the UI bundle when the game
 * uses the web renderer, and the dependencies discovered from that executable. Everything is
 * addressed relative to a single top-level directory, so the archive can be moved anywhere.
 */
export function packageDesktopContainer({
  platform = process.platform,
  arch = process.arch,
  bundle,
  executable,
  executableName,
  uiDirectory,
  uiRenderer = 'native',
  dependencies = [],
  prerequisites = [],
  config,
  icon,
  output,
  run = exec,
  signing,
} = {}) {
  const key = desktopTargetKey(platform, arch);
  const format = desktopContainerFormat(platform);
  if (!output) throw new Error('TN_DESKTOP_OUTPUT_MISSING: packageDesktopContainer needs an output path.');
  assertFile(executable, 'desktop executable');
  if (uiRenderer === 'web' || uiRenderer === 'native-css') {
    assertDirectory(uiDirectory, 'built UI bundle');
    // The web renderer loads a page; the native-css renderer paints stylesheets in the game's own
    // JS realm and ships no page at all.
    if (uiRenderer === 'web' && !existsSync(join(uiDirectory, 'index.html'))) {
      throw new Error(`TN_UI_BUNDLE_MISSING: ${uiDirectory} has no index.html, which is the page the overlay loads.`);
    }
    if (uiRenderer === 'native-css' && listFiles(uiDirectory).every((file) => !file.relative.endsWith('.css'))) {
      throw new Error(`TN_UI_BUNDLE_MISSING: ui.renderer is "native-css" but ${uiDirectory} has no .css to paint.`);
    }
  } else if (uiDirectory) {
    throw new Error(`TN_UI_BUNDLE_UNEXPECTED: a UI bundle was staged for a game whose ui.renderer is '${uiRenderer}'.`);
  }
  const app = config?.app ?? {};
  const loading = containerLoading(config);
  const appName = app.name ?? 'ThreeNative';
  const slug = containerSlug(appName);
  const executableName2 = executableName ?? (platform === 'win32' ? `${slug}.exe` : slug);
  const iconName = app.id ?? slug;
  const rootFolder = containerRootFolder(platform, appName);
  const archive = containerArchivePath(resolve(output), platform);
  const paths = layout(platform, { appName, executableName: executableName2, iconName });
  // The game is as required as the executable: a container without it launches a bare runtime that
  // prints CLI usage. Check it with the other preconditions, before anything is staged.
  assertFile(bundle, 'game bundle');
  const staging = mkdtempSync(join(tmpdir(), 'threenative-container-'));
  const resources = {};
  const stage = (relativePath) => join(staging, rootFolder, relativePath);
  const record = (relativePath) => {
    resources[relativePath] = { sha256: sha256File(stage(relativePath)) };
  };
  try {
    mkdirSync(dirname(stage(paths.executable)), { recursive: true });
    copyFileSync(executable, stage(paths.executable));
    if (platform !== 'win32') chmodSync(stage(paths.executable), 0o755);

    // The game travels beside the executable, never appended to it: rcedit and the signing tools
    // rewrite the binary, and anything past the end of the image does not survive that.
    mkdirSync(dirname(stage(paths.bundle)), { recursive: true });
    copyFileSync(bundle, stage(paths.bundle));
    record(paths.bundle);

    let ui = null;
    if (uiRenderer === 'web' || uiRenderer === 'native-css') {
      for (const file of listFiles(uiDirectory)) {
        const destination = `${paths.ui}/${file.relative}`;
        mkdirSync(dirname(stage(destination)), { recursive: true });
        copyFileSync(file.absolute, stage(destination));
        record(destination);
      }
      // The web renderer's entry is the page the overlay loads; the native-css one is its first
      // stylesheet, which is what the manifest can name as a single required resource.
      const entry =
        uiRenderer === 'web'
          ? 'index.html'
          : listFiles(uiDirectory)
              .map((file) => file.relative)
              .sort()[0];
      if (entry === undefined) throw new Error('TN_UI_BUNDLE_MISSING: nothing staged for the UI renderer.');
      ui = { directory: paths.ui, entry: `${paths.ui}/${entry}` };
      if (!existsSync(stage(ui.entry))) throw new Error(`TN_UI_BUNDLE_MISSING: no ${entry} staged for ${uiRenderer}.`);
    }

    const bundled = [];
    for (const dependency of dependencies) {
      assertFile(dependency.source, `native dependency ${dependency.name}`);
      const destination = dependencyRelativePath(platform, dependency.name);
      mkdirSync(dirname(stage(destination)), { recursive: true });
      copyFileSync(dependency.source, stage(destination));
      if (platform !== 'win32') chmodSync(stage(destination), 0o755);
      bundled.push({ name: dependency.name, path: destination });
    }

    let iconRecord;
    if (icon !== undefined) {
      assertFile(icon, 'app icon');
      if (platform === 'win32') {
        // Identity for Windows is the executable's PE resource section, so rcedit runs after the
        // binary is staged; the game icon also travels as a sidecar for the manifest record.
        const version = String(app.version ?? '0.0.0');
        // rcedit parses --set-icon as a Windows icon and exits 1 on the authored PNG. macOS converts
        // to .icns and Linux copies the PNG the .desktop entry wants; Windows needs an .ico, built
        // outside the staging directory so it never becomes an unrecorded container resource.
        let windowsIcon = icon;
        let iconDirectory;
        try {
          if (!icon.toLowerCase().endsWith('.ico')) {
            iconDirectory = mkdtempSync(join(tmpdir(), 'threenative-ico-'));
            windowsIcon = join(iconDirectory, `${basename(icon, extname(icon))}.ico`);
            pngToIco(icon, windowsIcon);
          }
          const rcedit = run('rcedit', [
            stage(paths.executable),
            '--set-icon', windowsIcon,
            '--set-file-version', version,
            '--set-product-version', version,
            '--set-version-string', 'ProductName', appName,
            '--set-version-string', 'FileDescription', appName,
          ], {});
          if (rcedit.error) {
            throw new Error(`TN_DESKTOP_RESOURCE_TOOL_MISSING: 'rcedit' is required to embed the executable icon and version (${rcedit.error.message}).`);
          }
          if (rcedit.status !== 0) throw new Error(`TN_DESKTOP_RESOURCE_FAILED: rcedit exited ${rcedit.status ?? 'unknown'}.`);
        } finally {
          if (iconDirectory) rmSync(iconDirectory, { force: true, recursive: true });
        }
        copyFileSync(icon, stage(paths.icon));
        iconRecord = { path: paths.icon, sha256: sha256File(icon) };
        record(paths.icon);
      } else {
        mkdirSync(dirname(stage(paths.icon)), { recursive: true });
        buildIcon(icon, stage(paths.icon), { platform, run });
        record(paths.icon);
        iconRecord = { path: paths.icon, sha256: sha256File(icon) };
      }
    }

    for (const [relativePath, content] of Object.entries(containerMetadata({ config, platform }))) {
      const destination = relativePath;
      mkdirSync(dirname(stage(destination)), { recursive: true });
      writeFileSync(stage(destination), content);
      record(destination);
    }

    // Sign nested macOS code first. The outer signature seals the manifest itself, so the
    // executable's integrity is verified by codesign rather than a circular whole-file hash.
    const signMac = platform === 'darwin' && signing !== undefined && signing !== null;
    if (signMac) {
      for (const dependency of bundled) {
        signDesktopArtifact({ platform, run, signing, target: stage(dependency.path) });
      }
    }
    const signedArtifact = signMac
      ? { scheme: 'codesign', signed: true }
      : signing === undefined || signing === null
      ? { scheme: 'none', signed: false }
      : signDesktopArtifact({
          platform,
          run,
          signing,
          target: stage(paths.executable),
        });

    // Windows signing and all nested signing have finished; these hashes now describe final bytes.
    if (signMac) resources[paths.executable] = { signature: 'codesign' };
    else record(paths.executable);
    for (const dependency of bundled) {
      record(dependency.path);
      dependency.sha256 = resources[dependency.path].sha256;
    }
    const manifest = {
      app: {
        id: app.id ?? 'com.threenative.game',
        name: appName,
        version: app.version ?? '0.1.0',
        build: app.build ?? 1,
        ...(iconRecord === undefined ? {} : { icon: iconRecord.path, iconSha256: iconRecord.sha256 }),
      },
      bundle: paths.bundle,
      dependencies: bundled,
      executable: paths.executable,
      format,
      loading,
      platform: key,
      prerequisites,
      resources,
      schemaVersion: CONTAINER_SCHEMA_VERSION,
      signed: signedArtifact.signed,
      ...(signedArtifact.scheme === 'none' ? {} : { signingScheme: signedArtifact.scheme }),
      ui,
    };
    mkdirSync(dirname(stage(paths.manifest)), { recursive: true });
    writeFileSync(stage(paths.manifest), `${JSON.stringify(manifest, null, 2)}\n`);

    if (signMac) {
      signDesktopArtifact({ platform, run, signing, target: join(staging, rootFolder) });
      resolveContainer(join(staging, rootFolder), { platform, run });
    }

    mkdirSync(dirname(archive), { recursive: true });
    // Keep the public destination untouched until the entire release transaction succeeds,
    // including notarization, stapling and re-archiving. The candidate lives on the destination
    // filesystem so the final rename never needs a cross-device copy.
    const candidateDirectory = mkdtempSync(join(dirname(archive), '.threenative-release-'));
    const candidateArchive = join(candidateDirectory, basename(archive));
    const installer = platform === 'win32' ? archive.replace(/\.zip$/iu, '-setup.exe') : undefined;
    let retainCandidates = false;
    try {
      archiveContainer({ output: candidateArchive, platform, rootFolder, run, staging });
      if (platform === 'darwin' && signing?.notarize) {
        notarizeArchive({ archive: candidateArchive, run, signing });
        signingTool(run, 'xcrun', ['stapler', 'staple', join(staging, rootFolder)], 'TN_DESKTOP_NOTARY_STAPLE');
        resolveContainer(join(staging, rootFolder), { platform, run });
        archiveContainer({ output: candidateArchive, platform, rootFolder, run, staging });
      }
      const artifacts = [[candidateArchive, archive]];
      if (installer) {
        const candidateInstaller = join(candidateDirectory, basename(installer));
        let installerIcon = icon;
        if (icon && !icon.toLowerCase().endsWith('.ico')) {
          installerIcon = join(candidateDirectory, 'installer.ico');
          pngToIco(icon, installerIcon);
        }
        buildWindowsInstaller({
          root: join(staging, rootFolder), output: candidateInstaller, manifest,
          files: [...Object.keys(resources), paths.manifest].sort(),
          icon: installerIcon, run, signing,
        });
        if (signing) signDesktopArtifact({ platform, run, signing, target: candidateInstaller });
        artifacts.push([candidateInstaller, installer]);
      }
      const backups = [];
      const published = [];
      try {
        for (const [, destination] of artifacts) {
          if (!existsSync(destination)) continue;
          if (!statSync(destination).isFile()) throw new Error('TN_DESKTOP_OUTPUT_NOT_FILE: ' + destination);
          const backup = join(candidateDirectory, 'previous-' + basename(destination));
          renameSync(destination, backup);
          backups.push([backup, destination]);
        }
        for (const [candidate, destination] of artifacts) {
          renameSync(candidate, destination);
          published.push(destination);
        }
      } catch (error) {
        try {
          for (const destination of published.reverse()) rmSync(destination);
          for (const [backup, destination] of backups.reverse()) renameSync(backup, destination);
        } catch (recoveryError) {
          retainCandidates = true;
          throw new AggregateError([error, recoveryError],
            'TN_DESKTOP_RELEASE_RECOVERY_REQUIRED: previous outputs retained at ' + candidateDirectory);
        }
        throw error;
      }
    } finally {
      if (!retainCandidates) rmSync(candidateDirectory, { force: true, recursive: true });
    }
    return { archive, ...(installer ? { installer } : {}), manifest, rootFolder, signed: signedArtifact.signed };
  } finally {
    rmSync(staging, { force: true, recursive: true });
  }
}
