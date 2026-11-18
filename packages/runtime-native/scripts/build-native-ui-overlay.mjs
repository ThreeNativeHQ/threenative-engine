#!/usr/bin/env node

/**
 * Build the desktop UI overlay staticlib.
 *
 * Deliberately host-only and deliberately separate from `build-native-physics.mjs`: physics
 * cross-compiles to five targets because it runs on every platform, while this crate is the
 * desktop host's and each other platform has its own (Java on Android, Swift on iOS). One target,
 * no NDK, no Xcode.
 *
 * The host's toolchain names the artifact differently — MSVC writes `.lib`, the rest write
 * `lib*.a` — so the name is derived once here and the C++ build asks for it rather than guessing.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(runtimeRoot, 'native', 'ui-overlay', 'Cargo.toml');
const checkOnly = process.argv.includes('--check');

/** The static library `cargo build --lib` writes, named the way the host toolchain names it. */
export function uiOverlayLibraryName(platform = process.platform) {
  return platform === 'win32' ? 'threenative_ui_overlay.lib' : 'libthreenative_ui_overlay.a';
}

export function uiOverlayLibraryPath(root = runtimeRoot, platform = process.platform) {
  return join(root, 'native', 'ui-overlay', 'target', 'release', uiOverlayLibraryName(platform));
}

export function stageWebView2Loader(messages, releaseDir) {
  const build = messages.split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .find((message) => message.reason === 'build-script-executed' &&
      /#webview2-com-sys@/u.test(message.package_id));
  if (!build?.out_dir) throw new Error('Cargo did not report the webview2-com-sys build output.');
  const name = 'WebView2LoaderStatic.lib';
  copyFileSync(join(build.out_dir, 'x64', name), join(releaseDir, name));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (checkOnly) {
    const library = uiOverlayLibraryPath();
    if (!existsSync(library)) {
      console.error(`TN_UI_OVERLAY_MISSING: ${library}`);
      process.exitCode = 1;
    } else {
      console.log(`ThreeNative UI overlay: ${library}`);
    }
  } else {
    const windows = process.platform === 'win32';
    const result = spawnSync(
      'cargo',
      [
        'build', '--release', '--manifest-path', manifest, '--lib',
        ...(windows ? ['--message-format=json-render-diagnostics'] : []),
      ],
      {
        encoding: 'utf8',
        stdio: ['inherit', windows ? 'pipe' : 'inherit', 'inherit'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      // Name the system dependency where there is one to install: on Linux this crate needs
      // webkit2gtk's development files, and a bare "cargo failed" sends the reader to the Rust
      // code instead of to their package manager. Windows and macOS use the OS's own WebView.
      const hint =
        process.platform === 'linux'
          ? ' On Linux it needs webkit2gtk-4.1 development files '
            + '(pkg-config --exists webkit2gtk-4.1).'
          : '';
      throw new Error(
        `Building the UI overlay failed with code ${result.status ?? 'unknown'}.${hint}`,
      );
    }
    if (windows) stageWebView2Loader(result.stdout, dirname(uiOverlayLibraryPath()));
    console.log(`ThreeNative UI overlay: ${uiOverlayLibraryPath()}`);
  }
}
