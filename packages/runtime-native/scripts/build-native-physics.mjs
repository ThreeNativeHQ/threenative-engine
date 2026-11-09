#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(runtimeRoot, 'native', 'physics', 'Cargo.toml');
const targetDir = join(runtimeRoot, '.runtime', 'physics-target');
const requested = new Set(process.argv.slice(2));
const checkOnly = requested.delete('--check');
const supported = new Set(['--android', '--desktop', '--ios', '--ios-device', '--ios-simulator', '--ps4']);
for (const argument of requested) {
  if (!supported.has(argument)) {
    throw new Error(`Unknown native physics target option: ${argument}`);
  }
}
if (requested.size === 0) requested.add('--android');
if (requested.has('--ios')) {
  requested.add('--ios-device');
  requested.add('--ios-simulator');
}

const targets = [];
if (requested.has('--desktop')) {
  const rustVersion = spawnSync('rustc', ['-vV'], { encoding: 'utf8' });
  const host = rustVersion.status === 0
    ? /^host:\s*(\S+)$/mu.exec(rustVersion.stdout)?.[1]
    : null;
  if (!host) throw new Error('rustc -vV did not report a host target for desktop physics');
  targets.push([host]);
}
if (requested.has('--android')) {
  const gradleProperties = readFileSync(join(runtimeRoot, 'android', 'gradle.properties'), 'utf8');
  const ndkVersion = gradleProperties.match(/^android\.ndkVersion=(.+)$/m)?.[1];
  if (!ndkVersion) throw new Error('android/gradle.properties has no android.ndkVersion');
  const sdkRoot = process.env.ANDROID_HOME
    ?? process.env.ANDROID_SDK_ROOT
    ?? join(homedir(), 'Android', 'Sdk');
  const ndkRoot = process.env.ANDROID_NDK_HOME
    ?? process.env.ANDROID_NDK_ROOT
    ?? join(sdkRoot, 'ndk', ndkVersion);
  const host = process.platform === 'darwin' ? 'darwin-x86_64'
    : process.platform === 'win32' ? 'windows-x86_64'
      : 'linux-x86_64';
  const bin = join(ndkRoot, 'toolchains', 'llvm', 'prebuilt', host, 'bin');
  if (!checkOnly && !existsSync(bin)) throw new Error(`Android NDK toolchain not found: ${bin}`);
  targets.push(
    [
      'aarch64-linux-android',
      join(bin, `aarch64-linux-android21-clang${process.platform === 'win32' ? '.cmd' : ''}`),
    ],
    [
      'x86_64-linux-android',
      join(bin, `x86_64-linux-android21-clang${process.platform === 'win32' ? '.cmd' : ''}`),
    ],
  );
}
if (requested.has('--ios-simulator')) targets.push(['aarch64-apple-ios-sim']);
if (requested.has('--ios-device')) targets.push(['aarch64-apple-ios']);
// PS4 (PRD-784): OpenOrbis links against its own musl, so the Linux musl staticlib's libc references
// resolve there; nothing is linked here, so no linker is named.
if (requested.has('--ps4')) targets.push(['x86_64-unknown-linux-musl']);

if (
  !checkOnly
  && targets.some(([target]) => target.includes('apple'))
  && process.platform !== 'darwin'
) {
  throw new Error(
    'Apple native physics artifacts require macOS with Xcode. Use --check for static validation.',
  );
}

for (const [target, linker] of targets) {
  const libraryName = target.includes('windows')
    ? 'threenative_native_physics.lib'
    : 'libthreenative_native_physics.a';
  const artifact = join(targetDir, target, 'release', libraryName);
  if (checkOnly) {
    console.log(`${target}: ${artifact}`);
    continue;
  }
  if (target.includes('apple') || target.includes('musl')) {
    const rustTarget = spawnSync('rustup', ['target', 'add', target], {
      cwd: runtimeRoot,
      encoding: 'utf8',
    });
    if (rustTarget.status !== 0) {
      throw new Error(
        rustTarget.stderr || rustTarget.stdout
          || `rustup could not install the required Rust target ${target}`,
      );
    }
  }
  const envName = `CARGO_TARGET_${target.toUpperCase().replaceAll('-', '_')}_LINKER`;
  const result = spawnSync(
    'cargo',
    ['build', '--release', '--manifest-path', manifest, '--target', target, '--target-dir', targetDir],
    {
      cwd: runtimeRoot,
      encoding: 'utf8',
      env: linker === undefined ? process.env : { ...process.env, [envName]: linker },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout
        || `cargo failed for ${target}; install it with rustup target add ${target}`,
    );
  }
  if (!existsSync(artifact)) throw new Error(`Cargo reported success without ${artifact}`);
  console.log(`${target}: ${basename(artifact)} ${statSync(artifact).size} bytes`);
}
