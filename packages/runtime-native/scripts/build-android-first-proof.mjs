#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

export const EXPECTED_THREE_VERSION = '0.187.0';
export const EXAMPLE_ENTRY = 'examples/native-smoke/src/game.ts';
export const READY_MARKER = 'TN_NATIVE_SMOKE_READY:webgpu';
export const FIRST_FRAME_MARKER = 'TN_NATIVE_SMOKE_FIRST_FRAME';
export const FRAME_MARKER = 'TN_NATIVE_SMOKE_300_FRAMES:300';
// The native Web Audio Promise contract, asserted on device because both defects it covers were
// invisible on the desktop default engine: a `decodeAudioData` that was not a real Promise, and an
// engine whose per-frame microtask pump did nothing so a settled Promise never arrived.
export const AUDIO_PROMISE_MARKER = 'TN_NATIVE_SMOKE_AUDIO_PROMISE_OK';
export const THREE_VERSION_MARKER = `TN_NATIVE_SMOKE_THREE:${EXPECTED_THREE_VERSION}`;
export const PLAYTEST_BRIDGE = process.env.THREENATIVE_PLAYTEST_BRIDGE === 'disabled'
  ? 'disabled'
  : 'enabled';

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workspaceRoot = resolve(runtimeRoot, '..', '..');
const exampleRoot = join(workspaceRoot, 'examples', 'native-smoke');
const exampleEntry = join(workspaceRoot, EXAMPLE_ENTRY);
const exampleBundle = join(exampleRoot, 'dist', 'native-smoke.js');
const coreSourceRoot = join(workspaceRoot, 'packages', 'core', 'src');
const assetRoot = join(runtimeRoot, 'android', 'app', 'build', 'generated', 'threenative', 'assets');
const output = join(assetRoot, 'scripts', 'main.js');
const metadataOutput = `${output}.meta.json`;

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex');
}

export function sourceTreeSha256(directory) {
  const files = [];
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(directory);
  const hash = createHash('sha256');
  for (const path of files) {
    hash.update(relative(directory, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function portable(path) {
  return relative(workspaceRoot, path).replaceAll('\\', '/');
}

function executable(packageRoot, name) {
  const suffix = process.platform === 'win32' ? '.cmd' : '';
  return join(packageRoot, 'node_modules', '.bin', `${name}${suffix}`);
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: 180_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status}): ${command} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`,
    );
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}

export function catalogThreeVersion(workspaceYaml) {
  const match = workspaceYaml.match(/^\s{2}three:\s*['"]?([^\s'"#]+)['"]?\s*$/m);
  if (!match) throw new Error('pnpm-workspace.yaml has no catalog Three.js version');
  return match[1];
}

export function assertNativeSmokeSource(source) {
  if (!/from\s+["']@threenative\/core["']/.test(source)) {
    throw new Error(`${EXAMPLE_ENTRY} must consume unchanged public @threenative/core APIs`);
  }
  for (const token of ['defineGame', 'Scene', FRAME_MARKER, AUDIO_PROMISE_MARKER]) {
    if (!source.includes(token)) throw new Error(`${EXAMPLE_ENTRY} is missing ${token}`);
  }
}

export function buildAndroidFirstProof() {
  for (const path of [exampleEntry, join(exampleRoot, 'vite.config.ts')]) {
    if (!existsSync(path)) throw new Error(`Missing native smoke input: ${portable(path)}`);
  }

  const workspaceYaml = readFileSync(join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8');
  const catalogThree = catalogThreeVersion(workspaceYaml);
  if (catalogThree !== EXPECTED_THREE_VERSION) {
    throw new Error(
      `Android proof requires Three.js ${EXPECTED_THREE_VERSION}; workspace catalog is ${catalogThree}`,
    );
  }

  const installedManifestPath = join(exampleRoot, 'node_modules', 'three', 'package.json');
  if (!existsSync(installedManifestPath)) {
    throw new Error('Native smoke Three.js dependency is missing. Run pnpm install --frozen-lockfile.');
  }
  const installedThree = JSON.parse(readFileSync(installedManifestPath, 'utf8')).version;
  if (installedThree !== catalogThree) {
    throw new Error(
      `Android proof Three.js mismatch: catalog=${catalogThree}, installed=${installedThree}`,
    );
  }

  const source = readFileSync(exampleEntry, 'utf8');
  assertNativeSmokeSource(source);

  const vite = executable(exampleRoot, 'vite');
  if (!existsSync(vite)) throw new Error('Pinned Vite dependency is missing from native-smoke.');
  run(vite, ['build', '--config', 'vite.config.ts'], exampleRoot);
  run(process.execPath, ['scripts/verify-bundle.mjs'], exampleRoot);

  const builtBundle = readFileSync(exampleBundle, 'utf8');
  for (const marker of ['TN_NATIVE_SMOKE_READY:', FIRST_FRAME_MARKER, FRAME_MARKER]) {
    if (!builtBundle.includes(marker)) throw new Error(`Native smoke bundle is missing ${marker}`);
  }
  if (/^\s*import\s+/m.test(builtBundle) || /\bimport\s*\(/.test(builtBundle)) {
    throw new Error('Native smoke bundle contains a runtime import');
  }

  const esbuild = executable(runtimeRoot, 'esbuild');
  if (!existsSync(esbuild)) throw new Error('Pinned runtime-native esbuild dependency is missing.');
  rmSync(assetRoot, { force: true, recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  const sourceHash = sha256(source);
  const coreSourceHash = sourceTreeSha256(coreSourceRoot);
  const builtBundleHash = sha256(builtBundle);
  const banner = [
    '/* THREENATIVE_ANDROID_NATIVE_SMOKE_GENERATED: scripts/build-android-first-proof.mjs',
    `THREENATIVE_ANDROID_NATIVE_SMOKE_ENTRY:${EXAMPLE_ENTRY}`,
    `THREENATIVE_ANDROID_NATIVE_SMOKE_SOURCE_SHA256:${sourceHash}`,
    `THREENATIVE_ANDROID_NATIVE_SMOKE_CORE_SHA256:${coreSourceHash}`,
    `THREENATIVE_ANDROID_NATIVE_SMOKE_BUNDLE_SHA256:${builtBundleHash}`,
    `THREENATIVE_ANDROID_NATIVE_SMOKE_THREE:${catalogThree}`,
    `THREENATIVE_ANDROID_NATIVE_SMOKE_MARKERS:${READY_MARKER}|${FIRST_FRAME_MARKER}|${FRAME_MARKER}|${AUDIO_PROMISE_MARKER} */`,
    `console.info(${JSON.stringify(THREE_VERSION_MARKER)});`,
  ].join('\n');
  run(
    esbuild,
    [
      exampleBundle,
      '--minify',
      '--format=iife',
      '--platform=browser',
      '--target=es2022',
      `--outfile=${output}`,
      `--banner:js=${banner}`,
      '--log-level=info',
    ],
    workspaceRoot,
  );

  const androidBundle = readFileSync(output);
  for (const marker of [THREE_VERSION_MARKER, READY_MARKER, FIRST_FRAME_MARKER, FRAME_MARKER, AUDIO_PROMISE_MARKER]) {
    if (!androidBundle.includes(marker)) throw new Error(`Android native smoke bundle is missing ${marker}`);
  }
  const metadata = {
    schemaVersion: 1,
    // Two builders write to this one path. `build-android-conformance.mjs` stamps
    // `threenative-android-conformance`; this is the other one, and the provenance gate in
    // tests/runtime-next-contract.test.mjs keys on the difference. Without a kind here, any
    // `--target android` conformance run left an artifact that the gate then checked against
    // native-smoke's SHA and failed — a red in `pnpm test` pointing at entirely the wrong thing.
    kind: 'threenative-android-first-proof',
    entry: EXAMPLE_ENTRY,
    publicApiPackage: '@threenative/core',
    playtestBridge: PLAYTEST_BRIDGE,
    catalogThree,
    installedThree,
    sourceSha256: sourceHash,
    coreSourceSha256: coreSourceHash,
    builtBundleSha256: builtBundleHash,
    outputSha256: sha256(androidBundle),
    outputBytes: androidBundle.length,
    markers: [THREE_VERSION_MARKER, READY_MARKER, FIRST_FRAME_MARKER, FRAME_MARKER, AUDIO_PROMISE_MARKER],
    inputs: {
      [EXAMPLE_ENTRY]: { sha256: sourceHash },
      [portable(exampleBundle)]: { sha256: builtBundleHash },
      'examples/native-smoke/node_modules/three/package.json': { version: installedThree },
    },
  };
  writeFileSync(metadataOutput, `${JSON.stringify(metadata, null, 2)}\n`);
  console.log(
    JSON.stringify(
      {
        wrote: portable(output),
        metadata: portable(metadataOutput),
        ...metadata,
      },
      null,
      2,
    ),
  );
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    buildAndroidFirstProof();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
