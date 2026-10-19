#!/usr/bin/env node

/**
 * Build the native CSS UI staticlib.
 *
 * Same shape as `build-native-ui-overlay.mjs` and for the same reason — the host links one Rust
 * staticlib per platform concern, and this one is pure Rust with no system dependency, so the host
 * build needs no `pkg-config` package. The one difference that matters is in the failure message:
 * the UI overlay needs webkit2gtk's development files on Linux, this crate needs nothing beyond a
 * Rust toolchain.
 *
 * `--target <triple>` cross-builds for Android (`x86_64-linux-android`, `aarch64-linux-android`)
 * with the NDK clang the Android Gradle build pins, exactly as `build-native-physics.mjs` does; the
 * library lands in cargo's per-triple directory, which is where CMake looks for it per ABI.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(runtimeRoot, 'native', 'css-ui', 'Cargo.toml');

export const CSS_UI_ANDROID_TARGETS = { 'arm64-v8a': 'aarch64-linux-android', x86_64: 'x86_64-linux-android' };

/** The static library `cargo build --lib` writes, named the way the host toolchain names it. */
export function cssUiLibraryName(platform = process.platform) {
  return platform === 'win32' ? 'threenative_css_ui.lib' : 'libthreenative_css_ui.a';
}

/** Where the library lands: cargo's host directory, or its per-triple one for a cross build. */
export function cssUiLibraryPath(root = runtimeRoot, platform = process.platform, target = undefined) {
  if (target !== undefined) {
    return join(root, 'native', 'css-ui', 'target', target, 'release', 'libthreenative_css_ui.a');
  }
  return join(root, 'native', 'css-ui', 'target', 'release', cssUiLibraryName(platform));
}

/** The NDK clang for an Android triple, from the NDK version the Gradle build pins. */
function androidClang(target) {
  const gradleProperties = readFileSync(join(runtimeRoot, 'android', 'gradle.properties'), 'utf8');
  const ndkVersion = gradleProperties.match(/^android\.ndkVersion=(.+)$/m)?.[1];
  if (!ndkVersion) throw new Error('android/gradle.properties has no android.ndkVersion');
  const sdkRoot = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? join(homedir(), 'Android', 'Sdk');
  const ndkRoot = process.env.ANDROID_NDK_HOME ?? process.env.ANDROID_NDK_ROOT ?? join(sdkRoot, 'ndk', ndkVersion);
  const host = process.platform === 'darwin' ? 'darwin-x86_64' : process.platform === 'win32' ? 'windows-x86_64' : 'linux-x86_64';
  const bin = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', host, 'bin');
  if (!existsSync(bin)) throw new Error(`Android NDK toolchain not found: ${bin}`);
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return { cc: join(bin, `${target}24-clang${suffix}`), ar: join(bin, `llvm-ar${process.platform === 'win32' ? '.exe' : ''}`) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const targetIndex = args.indexOf('--target');
  const target = targetIndex === -1 ? undefined : args[targetIndex + 1];
  if (target !== undefined && !Object.values(CSS_UI_ANDROID_TARGETS).includes(target)) {
    throw new Error(`Unknown CSS UI target: ${target}. Supported: ${Object.values(CSS_UI_ANDROID_TARGETS).join(', ')}`);
  }
  const library = cssUiLibraryPath(runtimeRoot, process.platform, target);
  if (checkOnly) {
    if (!existsSync(library)) {
      console.error(`TN_CSS_UI_MISSING: ${library}`);
      process.exitCode = 1;
    } else {
      console.log(`ThreeNative CSS UI: ${library}`);
    }
  } else {
    let env = process.env;
    if (target !== undefined) {
      const { cc, ar } = androidClang(target);
      const key = target.replaceAll('-', '_');
      env = { ...env, [`CC_${key}`]: cc, [`AR_${key}`]: ar, [`CARGO_TARGET_${key.toUpperCase()}_LINKER`]: cc };
    }
    const result = spawnSync(
      'cargo',
      ['build', '--release', '--manifest-path', manifest, '--lib', ...(target === undefined ? [] : ['--target', target])],
      { stdio: 'inherit', env },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      // This crate has no system dependency, so "cargo failed" can only mean the Rust toolchain
      // (or, cross-building, the rustup target or the NDK) is missing or too old.
      throw new Error(
        `Building the CSS UI failed with code ${result.status ?? 'unknown'}. It needs a current Rust toolchain` +
          (target === undefined ? ' and nothing else.' : `, rustup target ${target} and the pinned Android NDK.`),
      );
    }
    console.log(`ThreeNative CSS UI: ${library}`);
  }
}
