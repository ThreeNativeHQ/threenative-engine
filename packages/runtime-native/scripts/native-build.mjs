#!/usr/bin/env node

import { existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopBuildOverrides } from './desktop-build-profile.mjs';
import { uiOverlayLibraryPath } from './build-native-ui-overlay.mjs';
import { cssUiLibraryPath } from './build-native-css-ui.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tools = join(root, '.runtime', 'tools-venv');
const windows = process.platform === 'win32';
const tool = (name) => join(tools, windows ? 'Scripts' : 'bin', `${name}${windows ? '.exe' : ''}`);
const preset = process.platform === 'darwin'
  ? 'tn-macos'
  : process.platform === 'win32'
    ? 'tn-windows'
    : 'tn-linux';

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function available(command) {
  return spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;
}

let cmake = 'cmake';
let ninja = 'ninja';
if (!available(cmake) || !available(ninja)) {
  mkdirSync(dirname(tools), { recursive: true });
  const python = windows ? 'python' : 'python3';
  if (!existsSync(tool('python'))) run(python, ['-m', 'venv', tools]);
  run(tool('python'), ['-m', 'pip', 'install', '--disable-pip-version-check', 'cmake', 'ninja']);
  cmake = tool('cmake');
  ninja = tool('ninja');
}

const configureArgs = ['--preset', preset, `-DCMAKE_MAKE_PROGRAM=${ninja}`];
const rustVersion = spawnSync('rustc', ['-vV'], { cwd: root, encoding: 'utf8' });
const rustHost = rustVersion.status === 0
  ? /^host:\s*(\S+)$/mu.exec(rustVersion.stdout)?.[1]
  : null;
if (!rustHost) throw new Error('rustc is required to build the desktop native physics ABI');
run(process.execPath, [join(root, 'scripts', 'build-native-physics.mjs'), '--desktop']);
const physicsLibrary = join(
  root,
  '.runtime',
  'physics-target',
  rustHost,
  'release',
  rustHost.includes('windows') ? 'threenative_native_physics.lib' : 'libthreenative_native_physics.a',
);
configureArgs.push(
  '-DTN_ENABLE_NATIVE_PHYSICS=ON',
  `-DTHREENATIVE_PHYSICS_LIBRARY=${physicsLibrary}`,
);
// The UI overlay is the desktop host's own, and every desktop host now has a backend: X11 on
// Linux, WebView2 on Windows, WebKit on macOS. Build it wherever a desktop host is being built
// and hand CMake the path the host toolchain actually wrote.
//
// `TN_ENABLE_UI_OVERLAY=0` is the opt-out, and it is the one that makes the CSS UI backend the
// *only* UI: the web overlay crate is never built, so the host ends up with no browser in it at
// all. Anything else (unset included) is the default above, unchanged.
if (process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32') {
  if (process.env.TN_ENABLE_UI_OVERLAY === '0') {
    configureArgs.push('-DTN_ENABLE_UI_OVERLAY=OFF');
  } else {
    run(process.execPath, [join(root, 'scripts', 'build-native-ui-overlay.mjs')]);
    const uiOverlayLibrary = uiOverlayLibraryPath(root);
    configureArgs.push(
      '-DTN_ENABLE_UI_OVERLAY=ON',
      `-DTHREENATIVE_UI_OVERLAY_LIBRARY=${uiOverlayLibrary}`,
    );
  }
}
// The CSS UI backend, opted into with TN_ENABLE_CSS_UI=1: the same `src/ui/` rasterised on the CPU
// with no WebView anywhere on the path. Off by default, like the option itself, so the default
// desktop build is unchanged; on, the crate is built first and its staticlib handed to CMake, which
// fails at configure time naming it if it is missing.
if (process.env.TN_ENABLE_CSS_UI === '1') {
  run(process.execPath, [join(root, 'scripts', 'build-native-css-ui.mjs')]);
  configureArgs.push(
    '-DTN_ENABLE_CSS_UI=ON',
    `-DTHREENATIVE_CSS_UI_LIBRARY=${cssUiLibraryPath(root)}`,
  );
}
// Linux arm64 selects cached V8 over wgpu-native. Cache entries override the tn-linux
// preset's Dawn default while preserving the build/tn-linux directory consumed by CI.
configureArgs.push(...Object.entries(desktopBuildOverrides()).map(([key, value]) => `-D${key}=${value}`));

const vcpkgRoot = process.env.VCPKG_ROOT ?? process.env.VCPKG_INSTALLATION_ROOT;
if (windows && vcpkgRoot) {
  configureArgs.push(
    `-DCMAKE_TOOLCHAIN_FILE=${join(vcpkgRoot, 'scripts', 'buildsystems', 'vcpkg.cmake')}`,
    '-DVCPKG_TARGET_TRIPLET=x64-windows-static',
  );
}
run(cmake, configureArgs);
run(cmake, ['--build', '--preset', preset, '--parallel']);
