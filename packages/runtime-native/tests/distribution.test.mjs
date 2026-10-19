import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { promisify } from 'node:util';
import { afterAll, afterEach, test, vi } from 'vitest';
import { PNG } from 'pngjs';

import {
  PREBUILT_ASSET_NAMES,
  PREBUILT_KEYS,
  PUBLISHED_PREBUILT_KEYS,
  UNPUBLISHED_PREBUILT_KEYS,
  RELEASE_REPOSITORY,
  downloadReleaseArtifact,
  installPrebuilt,
  platformKey,
  readRelease,
  releaseManifestUrl,
  sha256,
  toolsFilename,
  verifyChecksum,
  writeInstallStatus,
} from '../scripts/install-prebuilt.mjs';
import {
  ANDROID_PREBUILT_ASSETS,
  ANDROID_PREBUILT_V8_ASSETS,
  androidPrebuiltAssets,
  ensureGradleWrapper,
  prepareAndroidPrebuilts,
} from '../scripts/package-android.mjs';
import {
  assertContainerIdentity,
  assertNotaryEvidence,
  containerMetadata,
  desktopContainerFormat,
  extractContainer,
  notarizeArchive,
  packageDesktopContainer,
  parseLinkedLibraries,
  resolveContainer,
  signDesktopArtifact,
} from '../scripts/desktop-distribution.mjs';
import { desktopSigningFromEnvironment } from '../scripts/package-desktop.mjs';

/** A stand-in for the runtime's `game.bundle`; the real format is proven by the C++ bundle tests. */
function stageBundle(directory) {
  const bundle = join(directory, 'game.bundle');
  writeFileSync(bundle, Buffer.from('MYSBNDL1 fixture game payload'));
  return bundle;
}


/** Serves a set of named payloads over loopback and hands back a fixture `prebuilt-lock.json`. */
async function serveFixtureRelease(root, contents) {
  const server = createServer((request, response) => {
    const key = decodeURIComponent(request.url.slice(1));
    const payload = contents[key];
    if (payload === undefined) {
      response.statusCode = 404;
      response.end();
      return;
    }
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const artifacts = Object.fromEntries(
    Object.entries(contents).map(([key, payload]) => [
      key,
      { sha256: sha256(payload), url: `http://127.0.0.1:${address.port}/${encodeURIComponent(key)}` },
    ]),
  );
  const manifest = join(root, 'prebuilt-lock.json');
  writeFileSync(manifest, `${JSON.stringify({ artifacts }, null, 2)}\n`);
  return {
    artifacts,
    close: () =>
      new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    manifest,
    rewrite: (mutate) => {
      mutate(artifacts);
      writeFileSync(manifest, `${JSON.stringify({ artifacts }, null, 2)}\n`);
    },
  };
}

const roots = [];
const run = promisify(execFile);

test.skipIf(process.platform !== 'linux')('display wrapper cleans child scratch without removing sibling data', async () => {
  const parent = makeTempDirSync('tn-display-scratch-');
  const retained = join(parent, 'retained');
  writeFileSync(retained, 'preserve');
  const result = await run('sh', [
    join(import.meta.dirname, '../scripts/xvfb.sh'), process.execPath, '-e',
    'const dir = require("node:path").join(require("node:os").tmpdir(), "pulse-child"); require("node:fs").mkdirSync(dir); console.log(dir)',
  ], { env: { ...process.env, TMPDIR: parent } });
  const scratch = result.stdout.trim();
  assert.ok(scratch.startsWith(`${parent}/`));
  assert.equal(existsSync(scratch), false, `child scratch leaked: ${scratch}`);
  assert.equal(readFileSync(retained, 'utf8'), 'preserve');
});

async function packRuntime(root) {
  const archives = join(root, 'archives');
  mkdirSync(archives);
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', archives], {
    cwd: new URL('..', import.meta.url),
  });
  const packed = JSON.parse(stdout);
  return { archive: packed.filename, files: packed.files.map(({ path }) => path) };
}

// The packed runtime depends on its unpublished cohort (core, assets, three-native). A consumer install
// resolves every @threenative/* dependency from these packed tarballs, never from the npm registry.
const packages = fileURLToPath(new URL('../..', import.meta.url));
let cohort;
async function cohortOverrides() {
  cohort ??= (async () => {
    // Not makeTempDirSync: that directory goes when the test that asked for it ends, and the cohort outlives it.
    const root = mkdtempSync(join(tmpdir(), 'threenative-cohort-'));
    cohortRoots.push(root);
    const manifests = new Map(
      readdirSync(packages).flatMap((directory) => {
        const file = join(packages, directory, 'package.json');
        if (!existsSync(file)) return [];
        const manifest = JSON.parse(readFileSync(file, 'utf8'));
        return [[manifest.name, { directory: join(packages, directory), manifest }]];
      }),
    );
    const overrides = {};
    const pending = ['@threenative/runtime-native'];
    for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
      const { manifest } = manifests.get(name);
      for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
        if (!dependency.startsWith('@threenative/') || dependency in overrides) continue;
        const { directory } = manifests.get(dependency);
        const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', root], { cwd: directory });
        overrides[dependency] = `file:${JSON.parse(stdout).filename}`;
        pending.push(dependency);
      }
    }
    return overrides;
  })();
  return cohort;
}
const cohortRoots = [];
afterAll(() => {
  for (const root of cohortRoots) rmSync(root, { force: true, recursive: true });
});

afterEach(() => {
  Reflect.deleteProperty(process.env, 'THREENATIVE_ALLOW_INSECURE_PREBUILT');
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test('unsupported platforms fail closed with the platform-arch string', () => {
  assert.throws(() => platformKey('aix', 'ppc64'), /aix-ppc64/);
  assert.throws(() => platformKey('darwin', 'x64'), /darwin-x64/);
  assert.throws(() => platformKey('linux', 'arm64'), /linux-arm64/);
});

test('a missing release lock and a missing platform asset both fail closed', () => {
  const root = makeTempDirSync('threenative-prebuilt-');
  roots.push(root);
  assert.throws(() => readRelease(join(root, 'missing.json'), 'linux-x64'), /linux-x64.*OPEN/);
  const manifest = join(root, 'lock.json');
  writeFileSync(manifest, '{"artifacts":{}}\n');
  assert.throws(() => readRelease(manifest, 'linux-x64'), /linux-x64/);
});

test('the default checksum lock URL is tied to the installed package version', () => {
  // Asserted against the manifest rather than a literal. The literal was 0.1.14 and made every
  // version bump fail a test whose subject is the tie between the two, not the number. The tie
  // is what matters: a consumer installing @threenative/runtime-native@X fetches its prebuilt
  // binaries from the release tagged runtime-native-vX, so a bump without a matching release is
  // an install that 404s.
  const version = JSON.parse(
    readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ).version;
  assert.equal(
    releaseManifestUrl(),
    `https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v${version}/prebuilt-lock.json`,
  );
  assert.equal(RELEASE_REPOSITORY, 'ThreeNativeHQ/threenative');
  assert.match(releaseManifestUrl(), /\/runtime-native-v\d+\.\d+\.\d+\//u);
});

test('records a failed prebuilt install with its release URL and reason', () => {
  const root = makeTempDirSync('threenative-install-status-');
  roots.push(root);
  const url = releaseManifestUrl();
  const statusPath = join(root, 'prebuilt', 'install-status.json');
  writeInstallStatus(
    {
      key: 'linux-x64',
      ok: false,
      reason: `Prebuilt release manifest fetch failed for 'linux-x64' at ${url}: HTTP 404.`,
      url,
      version: '0.3.0',
    },
    statusPath,
  );
  assert.deepEqual(JSON.parse(readFileSync(statusPath, 'utf8')), {
    key: 'linux-x64',
    ok: false,
    reason: `Prebuilt release manifest fetch failed for 'linux-x64' at ${url}: HTTP 404.`,
    url,
    version: '0.3.0',
  });
});

test('a 404 release manifest is recognised as a missing release, not a generic failure', async () => {
  const server = createServer((request, response) => {
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    await assert.rejects(
      downloadReleaseArtifact('linux-x64', {
        manifestUrl: `http://127.0.0.1:${address.port}/prebuilt-lock.json`,
      }),
      (error) => error.code === 'PREBUILT_RELEASE_MISSING',
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('an unpublished release records the gap and finishes the consumer install', async () => {
  const root = makeTempDirSync('threenative-prebuilt-missing-');
  roots.push(root);
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: '@threenative/runtime-native', version: '0.3.0' })}\n`,
  );
  // The shipped script itself, not a reimplementation: the subject is the install lifecycle.
  writeFileSync(
    join(root, 'scripts', 'install-prebuilt.mjs'),
    readFileSync(join(import.meta.dirname, '..', 'scripts', 'install-prebuilt.mjs')),
  );
  const manifestPath = join(root, 'prebuilt-lock.json'); // deliberately absent
  const result = await run(process.execPath, [join(root, 'scripts', 'install-prebuilt.mjs')], {
    cwd: root,
    env: { ...process.env, THREENATIVE_PREBUILT_MANIFEST: manifestPath },
  });
  // `run` rejects on a non-zero exit — the pre-fix install aborts here, which is the red.
  const status = JSON.parse(readFileSync(join(root, 'prebuilt', 'install-status.json'), 'utf8'));
  assert.equal(status.ok, false);
  assert.match(status.reason, /linux-x64/);
  assert.match(result.stderr, /no prebuilt release is published/iu);
});

test('the install hook runs when invoked through a symlinked package path', async () => {
  // pnpm installs a package as a symlink into its store, so `node node_modules/<pkg>/scripts/...`
  // names a path whose real file differs. The hook must still run, not exit 0 having done nothing.
  const root = makeTempDirSync('threenative-prebuilt-symlink-');
  roots.push(root);
  const real = join(root, 'store', 'runtime-native');
  mkdirSync(join(real, 'scripts'), { recursive: true });
  writeFileSync(
    join(real, 'package.json'),
    `${JSON.stringify({ name: '@threenative/runtime-native', version: '0.3.0' })}\n`,
  );
  writeFileSync(
    join(real, 'scripts', 'install-prebuilt.mjs'),
    readFileSync(join(import.meta.dirname, '..', 'scripts', 'install-prebuilt.mjs')),
  );
  const linked = join(root, 'node_modules', 'runtime-native');
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  symlinkSync(real, linked, 'dir');
  await run(process.execPath, [join(linked, 'scripts', 'install-prebuilt.mjs')], {
    cwd: root,
    env: { ...process.env, THREENATIVE_PREBUILT_MANIFEST: join(root, 'absent-lock.json') },
  });
  // The pre-fix guard compared the symlinked argv path with the real module URL, skipped the
  // install entirely and wrote no status: that missing file is the red.
  const status = JSON.parse(readFileSync(join(real, 'prebuilt', 'install-status.json'), 'utf8'));
  assert.equal(status.ok, false);
  assert.match(status.reason, /no prebuilt release manifest exists/iu);
});

test('exports the complete prebuilt key table consumed by release packaging', () => {
  assert.ok(PREBUILT_KEYS.includes('linux-x64'));
  assert.ok(PREBUILT_KEYS.includes('android-arm64-v8a-runtime'));
  assert.ok(PREBUILT_KEYS.includes('android-arm64-v8a-runtime-v8'));
  assert.ok(PREBUILT_KEYS.includes('ios-simulator-arm64'));
});

test('the native release workflow covers every exported prebuilt key', () => {
  const workflow = readFileSync(
    join(import.meta.dirname, '..', '..', '..', '.github', 'workflows', 'native-release.yml'),
    'utf8',
  );
  assert.match(workflow, /generateReleaseManifest/u);
  assert.match(workflow, /RELEASE_SHA: \$\{\{ needs\.validate-tag\.outputs\.candidate_sha \}\}/u);
  assert.deepEqual(Object.keys(PREBUILT_ASSET_NAMES).sort(), [...PREBUILT_KEYS].sort());
});

test('the installer can bootstrap a remote checksum lock before fetching the runtime', async () => {
  const root = makeTempDirSync('threenative-prebuilt-bootstrap-');
  roots.push(root);
  const runtime = Buffer.from('#!/bin/sh\nexit 0\n');
  let runtimeUrl = '';
  const server = createServer((request, response) => {
    if (request.url === '/prebuilt-lock.json') {
      response.setHeader('content-type', 'application/json');
      const artifacts = candidateArtifacts(runtime);
      for (const release of Object.values(artifacts)) release.url = runtimeUrl;
      response.end(JSON.stringify(candidateLock(artifacts)));
      return;
    }
    response.end(runtime);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    runtimeUrl = `http://127.0.0.1:${address.port}/runtime`;
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const output = join(root, 'runtime');
    await installPrebuilt({
      arch: 'x64',
      manifestUrl: `http://127.0.0.1:${address.port}/prebuilt-lock.json`,
      output,
      platform: 'linux',
    });
    assert.deepEqual(readFileSync(output), runtime);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('Android QuickJS prebuilts verify every runtime, SDL, and Java payload before writing', async () => {
  const root = makeTempDirSync('threenative-android-prebuilt-');
  roots.push(root);
  const contents = Object.fromEntries(
    Object.keys(ANDROID_PREBUILT_ASSETS).map((key) => [key, Buffer.from(`payload:${key}`)]),
  );
  const server = createServer((request, response) => {
    const key = decodeURIComponent(request.url.slice(1));
    response.end(contents[key]);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const artifacts = Object.fromEntries(Object.entries(contents).map(([key, payload]) => [
      key,
      { sha256: sha256(payload), url: `http://127.0.0.1:${address.port}/${encodeURIComponent(key)}` },
    ]));
    const manifest = join(root, 'prebuilt-lock.json');
    writeFileSync(manifest, `${JSON.stringify({ artifacts })}\n`);
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const outputRoot = join(root, 'android');
    await prepareAndroidPrebuilts({ engine: 'quickjs', manifestPath: manifest, outputRoot });
    for (const [key, path] of Object.entries(ANDROID_PREBUILT_ASSETS)) {
      assert.deepEqual(readFileSync(join(outputRoot, path)), contents[key]);
    }

    artifacts['android-x86_64-runtime'].sha256 = sha256(Buffer.from('wrong'));
    writeFileSync(manifest, `${JSON.stringify({ artifacts })}\n`);
    const rejectedRoot = join(root, 'rejected');
    await assert.rejects(
      prepareAndroidPrebuilts({ engine: 'quickjs', manifestPath: manifest, outputRoot: rejectedRoot }),
      /Checksum verification failed.*android-x86_64-runtime/u,
    );
    assert.equal(existsSync(rejectedRoot), false);

    Reflect.deleteProperty(artifacts, 'android-x86_64-runtime');
    writeFileSync(manifest, `${JSON.stringify({ artifacts })}\n`);
    await assert.rejects(
      prepareAndroidPrebuilts({ engine: 'quickjs', manifestPath: manifest, outputRoot: rejectedRoot }),
      /No prebuilt release asset.*android-x86_64-runtime/u,
    );
    assert.equal(existsSync(rejectedRoot), false);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a clean-room install builds for Android from a fixture manifest, with no engine checkout', async () => {
  // PRD-212 Phase 2. Every other Android test in this file runs inside the workspace, where
  // CMakeLists.txt and a staged SDL3 AAR are simply present, so `packageAndroid` takes the source
  // path and the prebuilt path is never exercised. A stranger has neither. This installs the packed
  // tarball into a directory with no workspace and no engine checkout, and drives the packager from
  // *there* — which is the only arrangement in which the 404 that killed bug 6 could have been seen.
  const root = makeTempDirSync('threenative-android-cleanroom-');
  roots.push(root);
  const assets = ANDROID_PREBUILT_V8_ASSETS;
  const contents = Object.fromEntries(
    Object.keys(assets).map((key) => [key, Buffer.from(`payload:${key}`)]),
  );
  const release = await serveFixtureRelease(root, contents);
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    // The hook a stranger actually has. `packageAndroid` builds its own prebuilt call, so an
    // option would test a seam no user can reach; the env variable is the shipped contract.
    process.env.THREENATIVE_PREBUILT_MANIFEST = release.manifest;
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    const packed = await packRuntime(root);
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({
        dependencies: { '@threenative/runtime-native': `file:${packed.archive}` },
        name: 'android-cleanroom-proof',
        private: true,
        pnpm: { overrides: await cohortOverrides() },
      })}\n`,
    );
    await run('pnpm', ['install', '--ignore-scripts'], { cwd: consumer, env: { ...process.env } });

    const installed = join(consumer, 'node_modules/@threenative/runtime-native');
    // The detection the packager itself uses. If either of these were true the prebuilt path would
    // be skipped and this test would silently prove the workspace path again.
    assert.equal(existsSync(join(installed, 'CMakeLists.txt')), false);
    assert.equal(existsSync(join(installed, 'third_party/sdl3-android/SDL3-3.2.8.aar')), false);

    const { packageAndroid } = await import(
      new URL(`file://${join(installed, 'scripts/package-android.mjs')}`).href
    );

    const bundle = join(root, 'main.js');
    writeFileSync(bundle, 'export default { start() {} };\n');
    const gradleInvocations = [];
    await packageAndroid(bundle, join(root, 'game.apk'), undefined, undefined, undefined, {
      // cmake and the NDK are masked: the whole point of the prebuilt path is that a stranger
      // compiles no C++. Gradle is masked too — this gate proves the stranger's build reaches it
      // with the right arguments and the right prebuilts staged, offline and on any machine.
      ensureGradleWrapper: async () => join(installed, 'android/gradle/wrapper/gradle-wrapper.jar'),
      runtimeRoot: installed,
      spawnSync: (command, args) => {
        gradleInvocations.push({ args, command });
        mkdirSync(join(installed, 'android/app/build/outputs/apk/debug'), { recursive: true });
        // PRD-221: the packager censuses the finished APK for 16 KB compliance, so a stranger's
        // artifact has to be a real archive carrying a library per ABI. The masked Gradle stands
        // in for the build, not for the gate.
        const staged = join(installed, 'android/app/build/clean-room-libs');
        for (const abi of ['arm64-v8a', 'x86_64']) {
          mkdirSync(join(staged, 'lib', abi), { recursive: true });
          writeFileSync(join(staged, 'lib', abi, 'libmystral-runtime.so'), 'clean-room apk');
        }
        execFileSync('jar', [
          '--create',
          '--file',
          join(installed, 'android/app/build/outputs/apk/debug/app-debug.apk'),
          '-C', staged, 'lib/arm64-v8a/libmystral-runtime.so',
          '-C', staged, 'lib/x86_64/libmystral-runtime.so',
        ]);
        return { status: 0, stdout: '' };
      },
      artifact16Kb: { runObjdump: () => 'LOAD off 0x0 vaddr 0x0 paddr 0x0 align 2**14', zipalign: false },
      // The fixture Gradle above builds a real-but-unrelated archive; the aligner would run the
      // real zipalign/apksigner against it. Alignment is exercised in
      // android-packaging.integration.test.mjs, so opt out here.
      alignArchive: false,
    });

    // Every prebuilt the fixture manifest named landed where the Gradle build expects it.
    for (const [key, path] of Object.entries(assets)) {
      assert.deepEqual(
        readFileSync(join(installed, 'android/prebuilt', path)),
        contents[key],
        `${key} was not staged from the fixture manifest`,
      );
    }
    assert.equal(gradleInvocations.length, 1);
    assert.ok(
      gradleInvocations[0].args.includes('assembleDebug'),
      `Gradle was not asked to assemble: ${JSON.stringify(gradleInvocations[0].args)}`,
    );
    assert.equal(existsSync(join(root, 'game.apk')), true);
  } finally {
    Reflect.deleteProperty(process.env, 'THREENATIVE_PREBUILT_MANIFEST');
    await release.close();
  }
}, 300_000);

test('the clean-room Android build fails loudly on a corrupt fixture manifest', async () => {
  // The negative control for the gate above: a masked SDK or a corrupt lock must fail closed, not
  // fall through to a build that quietly used nothing. A gate that passes on a broken manifest
  // proves only that it ran.
  const root = makeTempDirSync('threenative-android-cleanroom-red-');
  roots.push(root);
  const contents = Object.fromEntries(
    Object.keys(ANDROID_PREBUILT_V8_ASSETS).map((key) => [key, Buffer.from(`payload:${key}`)]),
  );
  const release = await serveFixtureRelease(root, contents);
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const outputRoot = join(root, 'android');

    release.rewrite((artifacts) => {
      artifacts['android-arm64-v8a-runtime-v8'].sha256 = sha256(Buffer.from('tampered'));
    });
    await assert.rejects(
      prepareAndroidPrebuilts({ manifestPath: release.manifest, outputRoot }),
      /Checksum verification failed.*android-arm64-v8a-runtime-v8/u,
      'a tampered artifact must not be staged',
    );
    assert.equal(existsSync(outputRoot), false);

    release.rewrite((artifacts) => {
      Reflect.deleteProperty(artifacts, 'android-sdl3-aar');
    });
    await assert.rejects(
      prepareAndroidPrebuilts({ manifestPath: release.manifest, outputRoot }),
      /No prebuilt release asset.*android-sdl3-aar/u,
      'a manifest missing an asset must name the asset',
    );
    assert.equal(existsSync(outputRoot), false);

    await assert.rejects(
      prepareAndroidPrebuilts({ manifestPath: join(root, 'absent-lock.json'), outputRoot }),
      /No prebuilt release manifest exists/u,
      'an absent manifest must fail closed rather than fetch the network',
    );
  } finally {
    await release.close();
  }
}, 120_000);

test('a packed Android build reconstructs only a checksum-verified Gradle wrapper', async () => {
  const root = makeTempDirSync('threenative-gradle-wrapper-');
  roots.push(root);
  const wrapper = Buffer.from('verified Gradle wrapper');
  const server = createServer((_request, response) => response.end(wrapper));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/gradle-wrapper.jar`;
    const output = join(root, 'gradle-wrapper.jar');
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    await ensureGradleWrapper({ output, sha256: sha256(wrapper), url });
    assert.deepEqual(readFileSync(output), wrapper);
    await assert.rejects(
      ensureGradleWrapper({
        output: join(root, 'rejected.jar'),
        sha256: sha256(Buffer.from('wrong')),
        url,
      }),
      /Checksum verification failed.*gradle-wrapper/u,
    );
    assert.equal(existsSync(join(root, 'rejected.jar')), false);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('corrupted downloads fail checksum verification and are never installed', async () => {
  const root = makeTempDirSync('threenative-prebuilt-');
  roots.push(root);
  const expected = Buffer.from('verified runtime');
  const corrupted = Buffer.from('corrupted runtime');
  assert.throws(() => verifyChecksum(corrupted, sha256(expected), 'linux-x64'), /Checksum.*linux-x64/);

  const server = createServer((_request, response) => response.end(corrupted));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const manifest = join(root, 'lock.json');
    writeFileSync(
      manifest,
      `${JSON.stringify({ artifacts: { 'linux-x64': { sha256: sha256(expected), url: `http://127.0.0.1:${address.port}/runtime` } } })}\n`,
    );
    const output = join(root, 'runtime');
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    await assert.rejects(
      installPrebuilt({ arch: 'x64', manifestPath: manifest, output, platform: 'linux' }),
      /Checksum verification failed.*linux-x64/,
    );
    assert.throws(() => readFileSync(output), /ENOENT/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('a packed consumer runs the allowlisted install hook and verifies its download', async () => {
  const root = makeTempDirSync('threenative-consumer-');
  roots.push(root);
  const runtime = Buffer.from('#!/bin/sh\nexit 0\n');
  const server = createServer((_request, response) => response.end(runtime));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const manifest = join(root, 'prebuilt-lock.json');
    writeFileSync(
      manifest,
      `${JSON.stringify({ artifacts: {
        'linux-x64': { sha256: sha256(runtime), url: `http://127.0.0.1:${address.port}/runtime` },
        'linux-x64-tools': { sha256: sha256(runtime), url: `http://127.0.0.1:${address.port}/tools` },
      } })}\n`,
    );
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    const packed = await packRuntime(root);
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({
        name: 'native-consumer-proof',
        private: true,
        optionalDependencies: {
          '@threenative/runtime-native': `file:${packed.archive}`,
        },
        pnpm: { onlyBuiltDependencies: ['@threenative/runtime-native'], overrides: await cohortOverrides() },
      })}\n`,
    );
    await run('pnpm', ['install'], {
      cwd: consumer,
      env: {
        ...process.env,
        THREENATIVE_ALLOW_INSECURE_PREBUILT: '1',
        THREENATIVE_PREBUILT_MANIFEST: manifest,
      },
    });
    assert.deepEqual(
      readFileSync(
        join(
          consumer,
          'node_modules/@threenative/runtime-native/prebuilt/linux-x64/threenative-runtime',
        ),
      ),
      runtime,
    );
    // A packed consumer's desktop build dispatches to this helper; the postinstall must place it.
    assert.deepEqual(
      readFileSync(
        join(consumer, 'node_modules/@threenative/runtime-native/prebuilt/linux-x64/mystral-tools'),
      ),
      runtime,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(
            consumer,
            'node_modules/@threenative/runtime-native/prebuilt/install-status.json',
          ),
          'utf8',
        ),
      ).ok,
      true,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test.runIf(process.platform === 'linux')('an installed runtime verifier uses packaged Linux display support', async () => {
  const root = makeTempDirSync('threenative-installed-verifier-');
  roots.push(root);
  const consumer = join(root, 'consumer');
  const packed = await packRuntime(root);
  mkdirSync(consumer);
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({
      dependencies: { '@threenative/runtime-native': `file:${packed.archive}` },
      name: 'installed-verifier-proof',
      private: true,
      pnpm: { overrides: await cohortOverrides() },
    }),
  );
  await run('pnpm', ['install', '--ignore-scripts', '--node-linker=hoisted'], {
    cwd: consumer,
  });
  const runtimePackage = join(consumer, 'node_modules', '@threenative', 'runtime-native');

  const expectedScreenshot = join(root, 'expected.png');
  const png = PNG.sync.read(
    readFileSync(new URL('../../create-threenative/templates/starter/assets/native-proof.png', import.meta.url)),
  );
  writeFileSync(expectedScreenshot, PNG.sync.write(png));

  const artifactDirectory = join(consumer, 'dist-native');
  mkdirSync(artifactDirectory, { recursive: true });
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'starter' }));
  const artifact = join(artifactDirectory, 'starter');
  const artifactScript = [
    '#!/bin/sh',
    'set -eu',
    'screenshot=',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    '    --screenshot) screenshot="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    'cp "$TN_TEST_SCREENSHOT" "$screenshot"',
    "printf '%s\\n' 'TN_NATIVE_SMOKE_READY:webgpu' 'TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb' 'TN_NATIVE_SMOKE_300_FRAMES:300' 'Rendered 300 frames in 1ms'",
    '',
  ].join('\n');
  writeFileSync(artifact, artifactScript);
  chmodSync(artifact, 0o755);

  const verifier = join(runtimePackage, 'scripts', 'verify-starter-desktop.mjs');
  const result = await run(process.execPath, [verifier], {
    cwd: consumer,
    env: { ...process.env, TN_TEST_SCREENSHOT: expectedScreenshot },
  });
  assert.match(result.stdout, /starter desktop gate passed: 300 frames/u);
  assert.equal(
    JSON.parse(
      readFileSync(join(consumer, 'artifacts', 'native', 'starter-desktop-report.json'), 'utf8'),
    ).pass,
    true,
  );
  await assert.rejects(
    run('sh', [join(runtimePackage, 'scripts', 'xvfb.sh'), process.execPath, '-e', 'process.exit(7)'], {
      cwd: consumer,
    }),
    (error) => error?.code === 7,
  );
});

test('a corrupted download fails the packed consumer install lifecycle', async () => {
  const root = makeTempDirSync('threenative-consumer-corrupt-');
  roots.push(root);
  const expected = Buffer.from('verified runtime');
  const server = createServer((_request, response) => response.end('corrupted runtime'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const manifest = join(root, 'prebuilt-lock.json');
    writeFileSync(
      manifest,
      `${JSON.stringify({ artifacts: { 'linux-x64': { sha256: sha256(expected), url: `http://127.0.0.1:${address.port}/runtime` } } })}\n`,
    );
    const consumer = join(root, 'consumer');
    mkdirSync(consumer);
    const packed = await packRuntime(root);
    writeFileSync(
      join(consumer, 'package.json'),
      `${JSON.stringify({
        dependencies: { '@threenative/runtime-native': `file:${packed.archive}` },
        name: 'native-consumer-corrupt-proof',
        pnpm: { onlyBuiltDependencies: ['@threenative/runtime-native'], overrides: await cohortOverrides() },
        private: true,
      })}\n`,
    );
    await assert.rejects(
      run('pnpm', ['install', '--config.side-effects-cache=false'], {
        cwd: consumer,
        env: {
          ...process.env,
          THREENATIVE_ALLOW_INSECURE_PREBUILT: '1',
          THREENATIVE_PREBUILT_MANIFEST: manifest,
        },
      }),
      (error) => /Checksum verification failed.*linux-x64/u.test(`${error.stdout}\n${error.stderr}`),
    );
    assert.equal(
      existsSync(
        join(
          consumer,
          'node_modules/@threenative/runtime-native/prebuilt/linux-x64/threenative-runtime',
        ),
      ),
      false,
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          join(
            consumer,
            'node_modules/@threenative/runtime-native/prebuilt/install-status.json',
          ),
          'utf8',
        ),
      ).ok,
      false,
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('the actual packed archive excludes C++ runtime source', async () => {
  const root = makeTempDirSync('threenative-pack-');
  roots.push(root);
  const packed = await packRuntime(root);
  const files = packed.files.join('\n');
  for (const file of ['scripts/package-engine-desktop.mjs', 'scripts/bundle-native-engine.mjs',
    'src/engine/player/core-three.mjs', 'src/engine/player/core-webgpu.mjs',
    'src/engine/player/core-tsl.mjs', 'src/engine/player/core-addons.mjs',
    'src/engine/player/core-host.mjs', 'src/engine/player/core-assets.mjs',
    'src/engine/player/core-audio.mjs', 'src/engine/player/core-textures.mjs',
    'src/engine/player/core-hdr.mjs']) {
    assert.ok(packed.files.includes(file), `pnpm pack omitted ${file}`);
  }
  // The Wasm engine (build/web) is the one build output the package ships, for the web native engine.
  assert.doesNotMatch(files, /^(?:src(?!\/engine\/player\/[^/]+\.mjs$)|include|cmake|native|third_party|build(?!\/web\/))\//mu);
  assert.doesNotMatch(files, /\.(?:c|cc|cpp|cxx|h|hh|hpp|m|mm)$/mu);

  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.scripts.install, 'node scripts/install-prebuilt.mjs');
});

test('the packed archive reaches the production profile command and evaluator', async () => {
  const root = makeTempDirSync('threenative-profile-pack-');
  roots.push(root);
  const packed = await packRuntime(root);
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.equal(manifest.scripts['profile:production'], 'node scripts/profile-production.mjs');
  for (const file of ['scripts/profile-production.mjs', 'scripts/production-evidence.mjs']) {
    assert.ok(packed.files.includes(file), `pnpm pack omitted ${file}`);
  }
  const archive = await run('tar', ['-tf', packed.archive]);
  assert.match(archive.stdout, /package\/scripts\/profile-production\.mjs\n/u);
  assert.match(archive.stdout, /package\/scripts\/production-evidence\.mjs\n/u);
});


test('the V8 prebuilt set carries an engine-qualified runtime, its library, and a snapshot per ABI', async () => {
  // PRD-130 Phase 4. Before this the prebuilt path shipped five files, none of them V8, so a project
  // assembled from a release artifact got QuickJS whatever the engine default said -- a default only
  // operators with an NDK ever received.
  const v8Assets = androidPrebuiltAssets('v8');
  assert.equal(v8Assets, ANDROID_PREBUILT_V8_ASSETS);
  assert.equal(androidPrebuiltAssets('quickjs'), ANDROID_PREBUILT_ASSETS);
  assert.throws(() => androidPrebuiltAssets('jsc'), /Unknown Android JS engine/u);

  for (const abi of ['arm64-v8a', 'x86_64']) {
    // The runtime is engine-qualified because the binaries genuinely differ: QuickJS is compiled
    // into the runtime and V8 is not. Publishing one runtime for both engines would produce a
    // process that reports the wrong engine.
    assert.equal(v8Assets[`android-${abi}-runtime-v8`], `jniLibs/${abi}/libmystral-runtime.so`);
    assert.equal(v8Assets[`android-${abi}-v8`], `jniLibs/${abi}/libv8android.so`);
    assert.equal(v8Assets[`android-${abi}-libcxx`], `jniLibs/${abi}/libc++_shared.so`);
    // Per ABI, because the blobs differ and a slice handed the other ABI's is shipping wrong bytes.
    assert.equal(v8Assets[`android-${abi}-v8-snapshot`], `assets/v8/${abi}/snapshot_blob.bin`);
  }

  // The unqualified runtime keys stay QuickJS, so an older consumer of this map is unaffected.
  assert.equal(ANDROID_PREBUILT_ASSETS['android-arm64-v8a-runtime'], 'jniLibs/arm64-v8a/libmystral-runtime.so');
  assert.ok(!('android-arm64-v8a-v8' in ANDROID_PREBUILT_ASSETS), 'the QuickJS set must not ship V8');
});

test('a QuickJS prebuilt directory cannot satisfy a V8 build', async () => {
  // The negative control PRD-130 Phase 4 asks for: populate android/prebuilt/ from a QuickJS
  // release, request V8, and the build must refuse rather than produce an APK whose logcat says
  // QuickJS. Expressed here as the contract the Gradle completeness check reads.
  const gradle = readFileSync(
    new URL('../android/app/build.gradle.kts', import.meta.url),
    'utf8',
  );
  assert.match(gradle, /prebuiltEngineFiles = if \(nativeJsEngineName == "v8"\)/u,
    'the prebuilt file list must depend on the engine');
  assert.match(gradle, /libv8android\.so/u, 'a V8 prebuilt build must require the V8 library');
  assert.match(gradle, /assets\/v8\/\$abi\/snapshot_blob\.bin/u,
    'a V8 prebuilt build must require a snapshot per ABI');
  assert.match(gradle, /Android prebuilt runtime is incomplete for engine/u,
    'the refusal must name the engine, or the reader hunts a corrupt download instead of a mismatch');

  // Missing files are listed, so the message says which engine the directory was populated for.
  assert.match(gradle, /Missing: \$missing/u, 'the refusal must name the files it wanted');
});

// PRD-262: exercise the shipped installer and the release workflow's lock generator.
function candidateLock(artifacts) {
  return {
    schemaVersion: 1,
    version: JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
    sourceSha: '1'.repeat(40),
    artifacts,
  };
}

function candidateArtifacts(payload = Buffer.from('candidate runtime')) {
  return Object.fromEntries(PUBLISHED_PREBUILT_KEYS.map((key) => [key, {
    url: `${releaseManifestUrl().replace('/prebuilt-lock.json', '')}/${PREBUILT_ASSET_NAMES[key]}`,
    sha256: sha256(payload),
    size: payload.length,
  }]));
}

test('a candidate rejects every missing non-iOS key before selecting a desktop artifact', () => {
  const root = makeTempDirSync('threenative-candidate-keys-');
  roots.push(root);
  const manifestPath = join(root, 'prebuilt-lock.json');
  for (const key of PUBLISHED_PREBUILT_KEYS.filter((entry) => !entry.startsWith('ios-'))) {
    const manifest = candidateLock(candidateArtifacts());
    Reflect.deleteProperty(manifest.artifacts, key);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => readRelease(manifestPath, 'linux-x64'),
      (error) => error.message.includes(key), `accepted a candidate without ${key}`);
  }
  const manifest = candidateLock(candidateArtifacts());
  Reflect.deleteProperty(manifest.artifacts, 'ios-simulator-arm64');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.deepEqual(readRelease(manifestPath, 'linux-x64'), manifest.artifacts['linux-x64']);
});

test('a candidate rejects wrong version, missing provenance, malformed metadata and crossed release URLs', () => {
  const root = makeTempDirSync('threenative-candidate-identity-');
  roots.push(root);
  const manifestPath = join(root, 'prebuilt-lock.json');
  const mutations = [
    [(lock) => { lock.version = '999.0.0'; }, /version/u],
    [(lock) => { Reflect.deleteProperty(lock, 'sourceSha'); }, /source SHA/u],
    [(lock) => { lock.sourceSha = 'not-a-commit'; }, /source SHA/u],
    [(lock) => { Reflect.deleteProperty(lock, 'schemaVersion'); }, /schema/u],
    [(lock) => { lock.schemaVersion = 2; }, /schema/u],
    [(lock) => { lock.artifacts['android-x86_64-v8-snapshot'].sha256 = 'bad'; }, /android-x86_64-v8-snapshot/u],
    [(lock) => { lock.artifacts['android-arm64-v8a-runtime-v8'].size = 0; }, /android-arm64-v8a-runtime-v8/u],
    [(lock) => { lock.artifacts['linux-x64'].url = 'https://github.com/ThreeNativeHQ/threenative/releases/download/runtime-native-v999.0.0/threenative-runtime-linux-x64'; }, /linux-x64/u],
  ];
  for (const [mutate, expected] of mutations) {
    const manifest = candidateLock(candidateArtifacts());
    mutate(manifest);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => readRelease(manifestPath, 'linux-x64'), expected);
  }
});

test('legacy explicit artifact-only pins remain readable', () => {
  const root = makeTempDirSync('threenative-legacy-pin-');
  roots.push(root);
  const manifestPath = join(root, 'prebuilt-lock.json');
  const release = { url: 'https://example.com/pinned-runtime', sha256: sha256('legacy') };
  writeFileSync(manifestPath, JSON.stringify({ artifacts: { 'linux-x64': release } }));
  assert.deepEqual(readRelease(manifestPath, 'linux-x64'), release);
});

test('a scoped manifest installs exactly the keys it advertises and refuses an undeclared one', async () => {
  const root = makeTempDirSync('threenative-scoped-manifest-');
  roots.push(root);
  const runtime = Buffer.from('scoped runtime');
  const tools = Buffer.from('scoped tools');
  const server = createServer((request, response) => {
    if (request.url === '/runtime') { response.end(runtime); return; }
    if (request.url === '/tools') { response.end(tools); return; }
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const manifestPath = join(root, 'prebuilt-lock.json');
    const lock = {
      schemaVersion: 1,
      version: candidateLock({}).version,
      sourceSha: '1'.repeat(40),
      requiredKeys: ['linux-x64', 'linux-x64-tools'],
      artifacts: {
        'linux-x64': { url: `${base}/runtime`, sha256: sha256(runtime), size: runtime.length },
        'linux-x64-tools': { url: `${base}/tools`, sha256: sha256(tools), size: tools.length },
      },
    };
    writeFileSync(manifestPath, JSON.stringify(lock));
    // A scoped manifest is accepted even though it carries none of the other published keys.
    assert.equal(readRelease(manifestPath, 'linux-x64').sha256, sha256(runtime));
    // A key the manifest does not advertise fails closed, naming the key.
    assert.throws(() => readRelease(manifestPath, 'win32-x64'), /win32-x64/u);
    const output = join(root, 'runtime');
    const statusPath = join(root, 'install-status.json');
    await installPrebuilt({ arch: 'x64', manifestPath, output, platform: 'linux', statusPath });
    assert.deepEqual(readFileSync(output), runtime);
    assert.deepEqual(readFileSync(join(root, 'mystral-tools')), tools);
    assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).ok, true);
    // Observed red: a declared key that is not carried fails the install, naming that key.
    const broken = JSON.parse(readFileSync(manifestPath, 'utf8'));
    Reflect.deleteProperty(broken.artifacts, 'linux-x64-tools');
    writeFileSync(manifestPath, JSON.stringify(broken));
    assert.throws(() => readRelease(manifestPath, 'linux-x64'), /linux-x64-tools/u);
    // Restoring the declared key restores green, so the refusal was the key and nothing else.
    writeFileSync(manifestPath, JSON.stringify(lock));
    assert.equal(readRelease(manifestPath, 'linux-x64').sha256, sha256(runtime));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('generateReleaseManifest with keys scopes the lock and refuses a missing declared asset', async () => {
  const { generateReleaseManifest } = await import('../scripts/install-prebuilt.mjs');
  const root = makeTempDirSync('threenative-scoped-generate-');
  roots.push(root);
  writeFileSync(join(root, PREBUILT_ASSET_NAMES['linux-x64']), 'runtime');
  writeFileSync(join(root, PREBUILT_ASSET_NAMES['linux-x64-tools']), 'tools');
  const identity = {
    repository: RELEASE_REPOSITORY,
    sourceSha: '2'.repeat(40),
    tag: `runtime-native-v${candidateLock({}).version}`,
  };
  const manifest = generateReleaseManifest(root, { ...identity, keys: ['linux-x64', 'linux-x64-tools'] });
  assert.deepEqual(manifest.requiredKeys, ['linux-x64', 'linux-x64-tools']);
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), ['linux-x64', 'linux-x64-tools']);
  assert.equal(manifest.artifacts['linux-x64'].size, 'runtime'.length);
  // Observed red: a declared asset that was not staged refuses, naming the missing filename.
  rmSync(join(root, PREBUILT_ASSET_NAMES['linux-x64-tools']));
  assert.throws(
    () => generateReleaseManifest(root, { ...identity, keys: ['linux-x64', 'linux-x64-tools'] }),
    /threenative-tools-linux-x64/u,
  );
});

test('a remote candidate missing an ABI snapshot fails before any artifact download', async () => {
  let downloads = 0;
  const manifest = candidateLock(candidateArtifacts());
  Reflect.deleteProperty(manifest.artifacts, 'android-x86_64-v8-snapshot');
  const server = createServer((request, response) => {
    if (request.url === '/prebuilt-lock.json') response.end(JSON.stringify(manifest));
    else { downloads += 1; response.end('candidate runtime'); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    for (const release of Object.values(manifest.artifacts)) {
      release.url = `http://127.0.0.1:${address.port}/runtime`;
    }
    await assert.rejects(downloadReleaseArtifact('linux-x64', {
      manifestUrl: `http://127.0.0.1:${address.port}/prebuilt-lock.json`,
    }), /android-x86_64-v8-snapshot/u);
    assert.equal(downloads, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a public-style remote lock cannot downgrade to an artifact-only legacy manifest', async () => {
  const server = createServer((request, response) => {
    if (request.url !== '/prebuilt-lock.json') { response.end('candidate runtime'); return; }
    const artifacts = candidateArtifacts();
    for (const release of Object.values(artifacts)) {
      release.url = `http://127.0.0.1:${server.address().port}/runtime`;
    }
    response.end(JSON.stringify({ artifacts }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    await assert.rejects(downloadReleaseArtifact('linux-x64', {
      manifestUrl: `http://127.0.0.1:${address.port}/prebuilt-lock.json`,
    }), /schema/u);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a failed reinstall removes the old executable and success marker', async () => {
  const root = makeTempDirSync('threenative-reinstall-');
  roots.push(root);
  const expected = Buffer.from('verified runtime');
  const release = await serveFixtureRelease(root, { 'linux-x64': expected, 'linux-x64-tools': Buffer.from('helper') });
  const output = join(root, 'runtime');
  const statusPath = join(root, 'install-status.json');
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    await installPrebuilt({ platform: 'linux', arch: 'x64', output, statusPath, manifestPath: release.manifest });
    // Seed the old lifecycle marker too: pre-PRD-262 only the CLI wrote it.
    writeInstallStatus({ ok: true, reason: 'installed' }, statusPath);
    release.rewrite((artifacts) => { artifacts['linux-x64'].sha256 = sha256('tampered'); });
    await assert.rejects(installPrebuilt({ platform: 'linux', arch: 'x64', output, statusPath, manifestPath: release.manifest }),
      /Checksum verification failed.*linux-x64/u);
    assert.equal(existsSync(output), false, 'a failed reinstall left a usable old executable');
    assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).ok, false);
  } finally {
    await release.close();
  }
});

test('an interrupted download invalidates an existing runtime and never leaves a successful install', async () => {
  const root = makeTempDirSync('threenative-truncated-');
  roots.push(root);
  const output = join(root, 'runtime');
  const statusPath = join(root, 'install-status.json');
  writeFileSync(output, 'old runtime');
  writeInstallStatus({ ok: true }, statusPath);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '4096' });
    response.write('truncated');
    response.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const manifestPath = join(root, 'prebuilt-lock.json');
    writeFileSync(manifestPath, JSON.stringify({ artifacts: { 'linux-x64': {
      url: `http://127.0.0.1:${address.port}/runtime`, sha256: sha256('complete runtime'),
    } } }));
    await assert.rejects(installPrebuilt({ platform: 'linux', arch: 'x64', output, statusPath, manifestPath }));
    assert.equal(existsSync(output), false);
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(status.ok, false);
    assert.match(status.reason, /linux-x64/u);
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a successful install records the verified output only after publishing the executable', async () => {
  const root = makeTempDirSync('threenative-install-commit-');
  roots.push(root);
  const contents = Buffer.from('verified runtime');
  const release = await serveFixtureRelease(root, { 'linux-x64': contents, 'linux-x64-tools': Buffer.from('helper') });
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const output = join(root, 'runtime');
    const statusPath = join(root, 'install-status.json');
    assert.equal(await installPrebuilt({ platform: 'linux', arch: 'x64', output, statusPath, manifestPath: release.manifest }), output);
    assert.deepEqual(readFileSync(output), contents);
    const status = JSON.parse(readFileSync(statusPath, 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.sha256, sha256(contents));
    assert.equal(status.version, candidateLock({}).version);
    const { readdirSync } = await import('node:fs');
    assert.equal(readdirSync(root).some((name) => name.endsWith('.tmp')), false);
  } finally {
    await release.close();
  }
});

test('the workflow lock generator rejects a missing matrix output and empty payload', async () => {
  const { generateReleaseManifest } = await import('../scripts/install-prebuilt.mjs');
  assert.equal(typeof generateReleaseManifest, 'function', 'the workflow needs the shared executable lock validator');
  const root = makeTempDirSync('threenative-release-matrix-');
  roots.push(root);
  const payload = Buffer.from('candidate payload');
  for (const key of PUBLISHED_PREBUILT_KEYS) writeFileSync(join(root, PREBUILT_ASSET_NAMES[key]), payload);
  const identity = { sourceSha: '1'.repeat(40), repository: RELEASE_REPOSITORY, tag: `runtime-native-v${candidateLock({}).version}` };
  const manifest = generateReleaseManifest(root, identity);
  assert.equal(manifest.sourceSha, identity.sourceSha);
  assert.equal(manifest.version, candidateLock({}).version);
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [...PUBLISHED_PREBUILT_KEYS].sort());
  for (const release of Object.values(manifest.artifacts)) {
    assert.equal(release.sha256, sha256(payload));
    assert.equal(release.size, payload.length);
  }
  const snapshot = join(root, PREBUILT_ASSET_NAMES['android-x86_64-v8-snapshot']);
  rmSync(snapshot);
  assert.throws(() => generateReleaseManifest(root, identity), /snapshot/u);
  writeFileSync(snapshot, '');
  assert.throws(() => generateReleaseManifest(root, identity), /empty/u);
  writeFileSync(snapshot, payload);
  assert.equal(generateReleaseManifest(root, identity).sourceSha, identity.sourceSha);
  assert.throws(() => generateReleaseManifest(root, { ...identity, sourceSha: 'stale' }), /source SHA/u);
  assert.throws(() => generateReleaseManifest(root, { ...identity, tag: 'runtime-native-v999.0.0' }), /tag/u);
});

test('the real publication step emits candidate identity and refuses a removed matrix output', async () => {
  const { execFileSync } = await import('node:child_process');
  const workflow = readFileSync(new URL('../../../.github/workflows/native-release.yml', import.meta.url), 'utf8');
  const step = workflow.split('      - name: Generate the checksum lock from the verified assets\n')[1]
    ?.split('      - name: Publish runtimes and checksum lock\n')[0];
  assert.ok(step, 'the existing publication caller must remain reachable');
  const match = /node --input-type=module <<'NODE'\n([\s\S]*?)\n {10}NODE/u.exec(step);
  assert.ok(match, 'the publication step must execute the lock generator');
  const script = match[1].replace(/^ {10}/gmu, '');
  const root = makeTempDirSync('threenative-publication-step-');
  roots.push(root);
  mkdirSync(join(root, 'packages/runtime-native/scripts'), { recursive: true });
  mkdirSync(join(root, 'release'));
  writeFileSync(join(root, 'packages/runtime-native/scripts/install-prebuilt.mjs'),
    readFileSync(new URL('../scripts/install-prebuilt.mjs', import.meta.url)));
  writeFileSync(join(root, 'packages/runtime-native/package.json'),
    readFileSync(new URL('../package.json', import.meta.url)));
  for (const key of PUBLISHED_PREBUILT_KEYS) writeFileSync(join(root, 'release', PREBUILT_ASSET_NAMES[key]), `payload:${PREBUILT_ASSET_NAMES[key]}`);
  const env = { ...process.env, RELEASE_REPOSITORY, RELEASE_TAG: `runtime-native-v${candidateLock({}).version}`,
    RELEASE_SHA: '2'.repeat(40) };
  const invoke = () => execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env, stdio: 'pipe' });
  invoke();
  const manifestPath = join(root, 'release/prebuilt-lock.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.version, candidateLock({}).version);
  assert.equal(manifest.sourceSha, env.RELEASE_SHA);
  assert.deepEqual(Object.keys(manifest.artifacts).sort(), [...PUBLISHED_PREBUILT_KEYS].sort());
  rmSync(manifestPath);
  const snapshot = join(root, 'release', PREBUILT_ASSET_NAMES['android-arm64-v8a-v8-snapshot']);
  const original = readFileSync(snapshot);
  rmSync(snapshot);
  assert.throws(invoke, (error) => error.status === 1 && /snapshot/u.test(String(error.stderr)));
  assert.equal(existsSync(manifestPath), false);
  writeFileSync(snapshot, original);
  invoke();
  assert.equal(JSON.parse(readFileSync(manifestPath, 'utf8')).sourceSha, env.RELEASE_SHA);
});

test('release generation preserves encoded candidate version URLs', async () => {
  const root = makeTempDirSync('threenative-candidate-version-');
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'release'));
  const version = '0.3.1-rc.1+build.262';
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(root, 'scripts/install-prebuilt.mjs'),
    readFileSync(new URL('../scripts/install-prebuilt.mjs', import.meta.url)));
  for (const key of PUBLISHED_PREBUILT_KEYS) {
    const name = PREBUILT_ASSET_NAMES[key];
    writeFileSync(join(root, 'release', name), `payload:${name}`);
  }
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', `
    import { generateReleaseManifest } from './scripts/install-prebuilt.mjs';
    console.log(JSON.stringify(generateReleaseManifest('release', {
      repository: ${JSON.stringify(RELEASE_REPOSITORY)},
      tag: ${JSON.stringify(`runtime-native-v${version}`)},
      sourceSha: ${JSON.stringify('1'.repeat(40))},
    })));
  `], { cwd: root });
  const manifest = JSON.parse(stdout);
  assert.equal(manifest.version, version);
  for (const [key, release] of Object.entries(manifest.artifacts)) {
    assert.equal(release.url,
      `${releaseManifestUrl(version).replace('/prebuilt-lock.json', '')}/${PREBUILT_ASSET_NAMES[key]}`);
  }
});

// PRD-262 Phase 2: the consumer gate fails when a packager consumes a source override
// without an explicit opt-in. The desktop resolver names the override and its fix.
test('the desktop consumer gate fails closed on a source override with no runtime', async () => {
  const { packageDesktop } = await import('../scripts/package-desktop.mjs');
  const root = makeTempDirSync('threenative-desktop-override-red-');
  roots.push(root);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default 1;\n');
  const previous = process.env.THREENATIVE_RUNTIME_SOURCE;
  process.env.THREENATIVE_RUNTIME_SOURCE = join(root, 'checkout');
  try {
    // Observed red: a stale THREENATIVE_RUNTIME_SOURCE must not silently select a
    // checkout as the runtime. The failure names the override and the fix.
    await assert.rejects(
      packageDesktop({ bundle, output: join(root, 'game') }),
      /source-checkout preflight.*THREENATIVE_RUNTIME_SOURCE/u,
    );
  } finally {
    if (previous === undefined) delete process.env.THREENATIVE_RUNTIME_SOURCE;
    else process.env.THREENATIVE_RUNTIME_SOURCE = previous;
  }
});

test('the desktop consumer gate packages with an explicit runtime and no network', async () => {
  const { packageDesktop } = await import('../scripts/package-desktop.mjs');
  const root = makeTempDirSync('threenative-desktop-consumer-');
  roots.push(root);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default 1;\n');
  const fakeRuntime = join(root, 'fake-runtime.mjs');
  writeFileSync(
    fakeRuntime,
    '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n' +
      'const index = process.argv.indexOf("--out");\n' +
      'if (index >= 0) writeFileSync(process.argv[index + 1], "desktop artifact");\n',
  );
  chmodSync(fakeRuntime, 0o755);
  const output = join(root, 'game');
  await packageDesktop({ bundle, output, runtime: fakeRuntime });
  assert.equal(readFileSync(output, 'utf8'), 'desktop artifact');
});

test('the android consumer gate fails closed on a source checkout without opt-in', async () => {
  const { packageAndroid } = await import('../scripts/package-android.mjs');
  const root = makeTempDirSync('threenative-android-source-red-');
  roots.push(root);
  // A directory shaped like a source checkout: CMakeLists.txt plus the SDL3 AAR marker
  // the packager's own sourceCheckout detection requires.
  mkdirSync(join(root, 'android', 'app'), { recursive: true });
  writeFileSync(join(root, 'CMakeLists.txt'), '# fake checkout\n');
  mkdirSync(join(root, 'third_party', 'sdl3-android'), { recursive: true });
  writeFileSync(join(root, 'third_party', 'sdl3-android', 'SDL3-3.2.30.aar'), 'fake-aar');
  writeFileSync(join(root, 'android', 'gradlew'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'android', 'gradlew'), 0o755);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  // Observed red: resolving a source checkout without an explicit opt-in fails
  // naming the checkout, instead of silently compiling from it.
  await assert.rejects(
    packageAndroid(bundle, undefined, undefined, undefined, undefined, {
      runtimeRoot: root,
      ensureGradleWrapper: async () => undefined,
    }),
    /source checkout.*explicit opt-in/u,
  );
});

test('the android source-checkout failure names the prebuilt path, not the toolchain', async () => {
  const { packageAndroid } = await import('../scripts/package-android.mjs');
  const root = makeTempDirSync('threenative-android-source-cause-');
  roots.push(root);
  mkdirSync(join(root, 'android', 'app'), { recursive: true });
  writeFileSync(join(root, 'CMakeLists.txt'), '# fake checkout\n');
  mkdirSync(join(root, 'third_party', 'sdl3-android'), { recursive: true });
  writeFileSync(join(root, 'third_party', 'sdl3-android', 'SDL3-3.2.30.aar'), 'fake-aar');
  writeFileSync(join(root, 'android', 'gradlew'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'android', 'gradlew'), 0o755);
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  // The masked-compiler shape of the same gate: with toolchain shims (exit 97) on PATH,
  // a consumer build must still fail on the source-checkout guard before any compiler
  // could run — the error names the opt-in, never a toolchain invocation.
  const mask = join(root, 'mask');
  mkdirSync(mask);
  for (const command of ['cmake', 'ninja', 'cargo', 'rustc']) {
    const shim = join(mask, command);
    writeFileSync(shim, '#!/bin/sh\necho "$0 $*" >> "$TN_TOOLCHAIN_LOG"\nexit 97\n');
    chmodSync(shim, 0o755);
  }
  const log = join(root, 'toolchain.log');
  const previousPath = process.env.PATH;
  const previousLog = process.env.TN_TOOLCHAIN_LOG;
  process.env.PATH = `${mask}${previousPath ? `:${previousPath}` : ''}`;
  process.env.TN_TOOLCHAIN_LOG = log;
  try {
    await assert.rejects(
      packageAndroid(bundle, undefined, undefined, undefined, undefined, {
        runtimeRoot: root,
        ensureGradleWrapper: async () => undefined,
      }),
      /explicit opt-in/u,
    );
    assert.equal(existsSync(log), false, 'no masked compiler was invoked');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousLog === undefined) delete process.env.TN_TOOLCHAIN_LOG;
    else process.env.TN_TOOLCHAIN_LOG = previousLog;
  }
});

test('a desktop install places the dispatched build tool helper beside the runtime', async () => {
  const root = makeTempDirSync('threenative-tools-install-');
  roots.push(root);
  const runtime = Buffer.from('verified runtime');
  const tools = Buffer.from('verified build tool helper');
  const fixture = await serveFixtureRelease(root, { 'linux-x64': runtime, 'linux-x64-tools': tools });
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const output = join(root, 'prebuilt', 'linux-x64', 'threenative-runtime');
    await installPrebuilt({ arch: 'x64', manifestPath: fixture.manifest, output, platform: 'linux' });
    const helper = join(root, 'prebuilt', 'linux-x64', toolsFilename('linux'));
    // `src/cli/tool_dispatch.cpp:52` resolves the helper from the runtime's own directory.
    assert.deepEqual(readFileSync(helper), tools);
    const status = JSON.parse(readFileSync(join(root, 'prebuilt', 'linux-x64', 'install-status.json'), 'utf8'));
    assert.equal(status.ok, true);
    assert.equal(status.sha256, sha256(runtime));
    assert.equal(status.toolsSha256, sha256(tools));
  } finally {
    await fixture.close();
  }
});

test('a missing or corrupt build tool helper leaves no usable runtime and no success marker', async () => {
  const root = makeTempDirSync('threenative-tools-red-');
  roots.push(root);
  const runtime = Buffer.from('verified runtime');
  const tools = Buffer.from('verified build tool helper');
  const output = join(root, 'prebuilt', 'linux-x64', 'threenative-runtime');
  const helper = join(root, 'prebuilt', 'linux-x64', toolsFilename('linux'));
  const statusPath = join(root, 'prebuilt', 'linux-x64', 'install-status.json');
  const fixture = await serveFixtureRelease(root, { 'linux-x64': runtime, 'linux-x64-tools': tools });
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    // 1. The helper is absent from the advertised candidate entirely.
    fixture.rewrite((artifacts) => { Reflect.deleteProperty(artifacts, 'linux-x64-tools'); });
    await assert.rejects(
      installPrebuilt({ arch: 'x64', manifestPath: fixture.manifest, output, platform: 'linux' }),
      /linux-x64-tools/u,
    );
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(helper), false);
    assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).ok, false);

    // 2. The helper is advertised but its bytes do not match the recorded checksum.
    fixture.rewrite((artifacts) => {
      artifacts['linux-x64-tools'] = { ...fixture.artifacts['linux-x64'], sha256: sha256(Buffer.from('other')) };
    });
    await assert.rejects(
      installPrebuilt({ arch: 'x64', manifestPath: fixture.manifest, output, platform: 'linux' }),
      /Checksum verification failed.*linux-x64-tools/u,
    );
    assert.equal(existsSync(output), false);
    assert.equal(existsSync(helper), false);
    assert.equal(JSON.parse(readFileSync(statusPath, 'utf8')).ok, false);
  } finally {
    await fixture.close();
  }
});

test('a cached runtime without its verified helper is never reused', async () => {
  const root = makeTempDirSync('threenative-tools-reuse-');
  roots.push(root);
  const runtime = Buffer.from('verified runtime');
  const tools = Buffer.from('verified build tool helper');
  const output = join(root, 'prebuilt', 'linux-x64', 'threenative-runtime');
  const helper = join(root, 'prebuilt', 'linux-x64', toolsFilename('linux'));
  const fixture = await serveFixtureRelease(root, { 'linux-x64': runtime, 'linux-x64-tools': tools });
  try {
    process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
    const install = { arch: 'x64', manifestPath: fixture.manifest, output, platform: 'linux', reuse: true };
    await installPrebuilt(install);
    rmSync(helper, { force: true });
    // A reuse that trusted the runtime alone would return here without restoring the helper,
    // and the desktop packager would then die with exit 127 on a "successful" install.
    await installPrebuilt(install);
    assert.deepEqual(readFileSync(helper), tools);
  } finally {
    await fixture.close();
  }
});

test('macOS is built but unpublished, and says so instead of 404ing', () => {
  const root = makeTempDirSync('threenative-unpublished-');
  roots.push(root);
  // The published cohort is exactly what a release stages, and it excludes these macOS rows.
  assert.deepEqual(
    PREBUILT_KEYS.filter((key) => !PUBLISHED_PREBUILT_KEYS.includes(key)).sort(),
    [...UNPUBLISHED_PREBUILT_KEYS].sort(),
  );
  // Windows ships unsigned - SmartScreen warns, Gatekeeper refuses - so only macOS is held back.
  assert.deepEqual([...UNPUBLISHED_PREBUILT_KEYS].sort(), ['darwin-arm64', 'darwin-arm64-engine-player', 'darwin-arm64-tools']);
  assert.ok(PUBLISHED_PREBUILT_KEYS.includes('win32-x64'));
  assert.ok(PUBLISHED_PREBUILT_KEYS.includes('win32-x64-tools'));
  // A complete candidate still refuses them, and names the reason rather than a missing asset:
  // an unpublished row must never read as a corrupt or partial release.
  const manifestPath = join(root, 'prebuilt-lock.json');
  writeFileSync(manifestPath, JSON.stringify(candidateLock(candidateArtifacts())));
  for (const key of UNPUBLISHED_PREBUILT_KEYS) {
    assert.throws(() => readRelease(manifestPath, key), (error) =>
      error.code === 'PREBUILT_RELEASE_UNPUBLISHED' && error.message.includes(key));
  }
  // Linux and Android remain downloadable from the same candidate.
  assert.ok(readRelease(manifestPath, 'linux-x64').sha256);
  assert.ok(readRelease(manifestPath, 'android-arm64-v8a-runtime-v8').sha256);
});

// PRD-365 phase 1. Release mode wraps the compiler's raw executable in one complete, relocatable
// container per native host; debug mode keeps the raw binary. Dependencies are injected here
// because a hermetic fixture executable links nothing; the real path discovers them from the
// produced binary with the host's own tool (ldd/otool/dumpbin).
/**
 * Does this file end in the runtime's appended-bundle footer?
 *
 * `src/vfs/embedded_bundle.cpp` reads the last `kFooterSize` bytes and requires `MYSBNDL1`. A
 * release executable must not carry one: that is what rcedit and the signing tools destroy.
 */
function hasBundleFooter(path) {
  const bytes = readFileSync(path);
  const magic = Buffer.from('MYSBNDL1', 'ascii');
  const footer = magic.length + 4 + 4 + 8;
  if (bytes.length < footer) return false;
  return bytes.subarray(bytes.length - footer, bytes.length - footer + magic.length).equals(magic);
}

async function packageSampleRelease(root, overrides = {}) {
  const { packageDesktop } = await import('../scripts/package-desktop.mjs');
  const bundle = join(root, 'game.js');
  writeFileSync(bundle, 'export default { start() {} };\n');
  const fakeRuntime = join(root, 'fake-runtime.mjs');
  // Record the argv rather than failing inside the runtime: a missing flag would otherwise surface
  // as "Runtime packager exited with code 1", which is true and tells nobody which flag went.
  const argvLog = join(root, 'runtime-argv.json');
  writeFileSync(
    fakeRuntime,
    '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n' +
      `writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n` +
      'const index = process.argv.indexOf("--out");\n' +
      'if (index >= 0) writeFileSync(process.argv[index + 1], "compiled game bundle");\n',
  );
  chmodSync(fakeRuntime, 0o755);
  const ui = join(root, 'ui');
  mkdirSync(join(ui, 'assets'), { recursive: true });
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>sample</title>');
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1);\n');
  const icon = join(root, 'icon.png');
  writeFileSync(icon, 'custom-icon-bytes');
  const dependency = join(root, 'libsample.so');
  writeFileSync(dependency, 'shared-library-bytes');
  const config = {
    app: { build: 7, icon, id: 'com.example.sample', name: 'Sample Game', version: '1.2.3' },
    ui: { renderer: 'web' },
  };
  const configPath = join(root, 'config.json');
  writeFileSync(configPath, JSON.stringify(config));
  const output = join(root, 'dist-native', 'sample');
  const archive = await packageDesktop({
    bundle,
    config: configPath,
    dependencies: [{ name: 'libsample.so', source: dependency }],
    mode: 'release',
    output,
    prerequisites: [{ name: 'libc.so.6' }],
    runtime: fakeRuntime,
    // The strip step runs a real object-file tool on the packaged runtime copy. This fixture's
    // "runtime" is a script, so inject the tool boundary here; the strip contract itself is
    // asserted in __tests__/desktop-strip.spec.ts.
    stripRun: () => ({ status: 0, stdout: '', stderr: '' }),
    ui,
    ...overrides,
  });
  return { archive, argvLog, config, fakeRuntime, icon, output };
}

test('a release container ships the game beside a bare runtime, never appended to it', async () => {
  // The Windows defect this guards: the game was appended to the executable, and rcedit rewriting
  // the PE for the icon discarded it, so the container launched the runtime CLI. Assert the shape
  // that makes that impossible - an executable byte-identical to the runtime, plus a recorded
  // game.bundle beside it - rather than only that the container resolves.
  const root = makeTempDirSync('threenative-release-sidecar-');
  roots.push(root);
  const { archive, argvLog } = await packageSampleRelease(root);
  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.ok(argv.includes('--bundle-only'), `release must compile with --bundle-only, got: ${argv.join(' ')}`);
  assert.ok(
    String(argv[argv.indexOf('--out') + 1]).endsWith('.bundle'),
    `--out must name a .bundle path, got: ${argv.join(' ')}`,
  );
  const { readdirSync } = await import('node:fs');
  const unpacked = join(makeTempDirSync('threenative-release-sidecar-unpacked-'), 'here');
  mkdirSync(unpacked, { recursive: true });
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
  const container = join(unpacked, readdirSync(unpacked)[0]);
  const manifest = resolveContainer(container, { platform: 'linux' });
  assert.equal(manifest.bundle, 'game.bundle');
  assert.ok(manifest.resources['game.bundle'], 'the game carries an integrity record');
  // The invariant the loader actually reads, rather than byte-equality with the runtime: that is an
  // accident of today's implementation and would break the day the executable is stripped or signed,
  // going red for the wrong reason. src/vfs/embedded_bundle.cpp looks for MYSBNDL1 in the last 24
  // bytes of the executable; it must not be there, and the game must be beside it instead.
  assert.equal(hasBundleFooter(join(container, manifest.executable)), false, 'nothing is appended to the executable');
  assert.equal(readFileSync(join(container, 'game.bundle'), 'utf8'), 'compiled game bundle');
});

test('desktop release mode packages the executable, the UI bundle and the declared dependencies', async () => {
  const root = makeTempDirSync('threenative-desktop-release-');
  roots.push(root);
  const { archive, config, icon, output } = await packageSampleRelease(root);
  assert.equal(archive, `${output}.tar.gz`);
  assert.equal(existsSync(output), false, 'release mode must not leave a raw executable claiming to be the artifact');

  const moved = join(makeTempDirSync('threenative-desktop-moved with spaces-'), 'relocated');
  roots.push(join(moved, '..'));
  const containerRoot = extractContainer(archive, moved, { platform: 'linux' });
  const manifest = resolveContainer(containerRoot, { platform: 'linux' });
  assert.equal(manifest.app.id, 'com.example.sample');
  assert.equal(manifest.app.name, 'Sample Game');
  assert.equal(manifest.app.version, '1.2.3');
  assert.equal(manifest.platform, `${process.platform}-${process.arch}`);
  assert.equal(manifest.ui.entry, 'ui/index.html');
  assert.deepEqual(manifest.dependencies.map((entry) => entry.name), ['libsample.so']);
  assert.ok(manifest.prerequisites.some((entry) => entry.name === 'libc.so.6'));
  assert.ok(existsSync(join(containerRoot, 'ui', 'index.html')));
  assert.ok(existsSync(join(containerRoot, 'ui', 'assets', 'app.js')));
  assert.ok(existsSync(join(containerRoot, 'lib', 'libsample.so')));
  assert.match(
    readFileSync(join(containerRoot, 'share', 'applications', 'com.example.sample.desktop'), 'utf8'),
    /Exec=Sample-Game/u,
  );
  assertContainerIdentity(manifest, config, { icon });
}, 60_000);

test('a relocated container missing its UI entry or a native dependency is rejected, and a tampered one is too', async () => {
  const root = makeTempDirSync('threenative-desktop-relocation-');
  roots.push(root);
  const { archive } = await packageSampleRelease(root);
  const extractedRoot = makeTempDirSync('threenative-desktop-extract-');
  roots.push(extractedRoot);
  const containerRoot = extractContainer(archive, join(extractedRoot, 'moved'), { platform: 'linux' });
  // Green first, so the refusals below are the edits and not the fixture.
  assert.doesNotThrow(() => resolveContainer(containerRoot, { platform: 'linux' }));

  const entry = join(containerRoot, 'ui', 'index.html');
  const entryBytes = readFileSync(entry);
  rmSync(entry);
  assert.throws(
    () => resolveContainer(containerRoot, { platform: 'linux' }),
    /TN_DESKTOP_CONTAINER_INCOMPLETE.*ui\/index\.html/u,
  );
  writeFileSync(entry, entryBytes);
  assert.doesNotThrow(() => resolveContainer(containerRoot, { platform: 'linux' }));

  const dependency = join(containerRoot, 'lib', 'libsample.so');
  const dependencyBytes = readFileSync(dependency);
  rmSync(dependency);
  assert.throws(
    () => resolveContainer(containerRoot, { platform: 'linux' }),
    /TN_DESKTOP_CONTAINER_INCOMPLETE.*libsample\.so/u,
  );
  writeFileSync(dependency, 'tampered');
  assert.throws(
    () => resolveContainer(containerRoot, { platform: 'linux' }),
    /TN_DESKTOP_CONTAINER_TAMPERED.*libsample\.so/u,
  );
  writeFileSync(dependency, dependencyBytes);
  assert.doesNotThrow(() => resolveContainer(containerRoot, { platform: 'linux' }));
}, 60_000);

test('a container manifest cannot name a resource outside the container root', async () => {
  const root = makeTempDirSync('threenative-desktop-escape-');
  roots.push(root);
  const { archive } = await packageSampleRelease(root);
  const extractedRoot = makeTempDirSync('threenative-desktop-escape-out-');
  roots.push(extractedRoot);
  const containerRoot = extractContainer(archive, join(extractedRoot, 'out'), { platform: 'linux' });
  const manifestPath = join(containerRoot, 'threenative-container.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  // Data inside the artifact, so a `../` resource must not walk the verifier out of the container.
  manifest.resources['../../escape.txt'] = { sha256: sha256(Buffer.from('outside')) };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(
    () => resolveContainer(containerRoot, { platform: 'linux' }),
    /TN_DESKTOP_CONTAINER_MANIFEST_INVALID.*escapes the container root/u,
  );
}, 60_000);

test('a container that kept the generic icon instead of the configured one fails the brand check', () => {
  const root = makeTempDirSync('threenative-desktop-brand-');
  roots.push(root);
  const icon = join(root, 'icon.png');
  writeFileSync(icon, 'game-owned-icon');
  const config = { app: { build: 3, icon, id: 'com.acme.racer', name: 'Acme Racer', version: '2.0.1' } };
  const manifest = {
    app: {
      build: 3,
      // The shape a fallback to the engine's generic icon produces: identity right, bytes not.
      iconSha256: sha256(Buffer.from('generic-engine-icon')),
      id: 'com.acme.racer',
      name: 'Acme Racer',
      version: '2.0.1',
    },
  };
  assert.throws(
    () => assertContainerIdentity(manifest, config, { icon }),
    /TN_DESKTOP_BRAND_MISMATCH/u,
  );
  manifest.app.iconSha256 = sha256(readFileSync(icon));
  assert.doesNotThrow(() => assertContainerIdentity(manifest, config, { icon }));
  manifest.app.version = '0.0.0';
  assert.throws(() => assertContainerIdentity(manifest, config, { icon }), /app\.version/u);
});

test('each desktop platform states its own container format and OS identity', () => {
  assert.equal(desktopContainerFormat('linux'), 'tar.gz');
  assert.equal(desktopContainerFormat('darwin'), 'zip');
  assert.equal(desktopContainerFormat('win32'), 'zip');
  assert.throws(() => desktopContainerFormat('aix'), /TN_DESKTOP_CONTAINER_UNSUPPORTED/u);
  const config = { app: { id: 'com.acme.racer', name: 'Acme Racer', version: '2.0.1', build: 4 } };
  const desktop = containerMetadata({ config, platform: 'linux' })['share/applications/com.acme.racer.desktop'];
  assert.match(desktop, /Exec=Acme-Racer/u);
  assert.match(desktop, /Icon=com\.acme\.racer/u);
  assert.doesNotMatch(desktop, /\/home\/|\/build\//u, 'a .desktop entry must refer to installed names, never build paths');
  const plist = containerMetadata({ config, platform: 'darwin' })['Contents/Info.plist'];
  assert.match(plist, /<key>CFBundleIdentifier<\/key><string>com\.acme\.racer<\/string>/u);
  assert.match(plist, /<key>CFBundleShortVersionString<\/key><string>2\.0\.1<\/string>/u);
  assert.match(plist, /<key>CFBundleVersion<\/key><string>4<\/string>/u);
  assert.match(plist, /<key>CFBundleIconFile<\/key><string>Acme-Racer<\/string>/u);
  assert.deepEqual(containerMetadata({ config, platform: 'win32' }), {});
});

test('the dependency census reads each host tool and never silently drops an unresolved library', () => {
  const linux = parseLinkedLibraries(
    '\tlinux-vdso.so.1 (0x00007ffd)\n' +
      '\tlibsample.so => /opt/game/libsample.so (0x00007f)\n' +
      '\tlibc.so.6 => /usr/lib/libc.so.6 (0x00007f)\n' +
      '\tlibgone.so => not found\n',
    'linux',
  );
  assert.deepEqual(
    linux.filter((entry) => !entry.missing),
    [
      { name: 'libsample.so', path: '/opt/game/libsample.so' },
      { name: 'libc.so.6', path: '/usr/lib/libc.so.6' },
    ],
  );
  assert.ok(linux.some((entry) => entry.missing && entry.name === 'libgone.so'));
  assert.deepEqual(
    parseLinkedLibraries(
      'build/sample:\n' +
        '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0)\n' +
        '\t@rpath/libfoo.dylib (compatibility version 1.0.0)\n',
      'darwin',
    ),
    [
      { name: 'libSystem.B.dylib', path: '/usr/lib/libSystem.B.dylib' },
      { name: 'libfoo.dylib', path: '@rpath/libfoo.dylib' },
    ],
  );
  assert.deepEqual(
    parseLinkedLibraries('    KERNEL32.dll\n    v8.dll\n', 'win32').map((entry) => entry.name),
    ['KERNEL32.dll', 'v8.dll'],
  );
});

// PRD-365 phase 3: signing is OS tooling with injectable transport, and a release that only claims
// to be signed must be refused. Real credentialed signing is verified by PRD-060, not here.
test('a signed desktop release is refused when the signing tool fails', () => {
  const directory = makeTempDirSync('threenative-sign-failure-');
  const executable = join(directory, 'input');
  const output = join(directory, 'game');
  writeFileSync(executable, 'executable');
  const calls = [];
  const run = (command, args) => {
    calls.push(command);
    if (command === 'codesign') return { error: undefined, status: 1, stdout: '', stderr: 'no identity found' };
    throw new Error(`unexpected tool ${command}`);
  };
  assert.throws(
    () =>
      packageDesktopContainer({ bundle: stageBundle(directory),
        arch: 'x64',
        config: { app: { id: 'com.example.signed', name: 'Signed Game' } },
        executable,
        output,
        platform: 'darwin',
        run,
        signing: { identity: 'Developer ID Application: Example (TEAM)' },
      }),
    /TN_DESKTOP_CODESIGN_FAILED/u,
  );
  assert.ok(calls.includes('codesign'));
  assert.equal(existsSync(`${output}.zip`), false, 'a failed signature must not leave an archive');
});

test('notarization evidence for a different artifact is refused', () => {
  const artifact = 'a'.repeat(64);
  assert.throws(
    () =>
      assertNotaryEvidence({
        artifactSha256: artifact,
        evidence: { artifactSha256: 'b'.repeat(64), id: 'stale-run', status: 'Accepted' },
      }),
    /TN_DESKTOP_NOTARY_MISMATCH/u,
  );
  assert.throws(
    () => assertNotaryEvidence({ artifactSha256: artifact, evidence: { artifactSha256: artifact, status: 'Invalid' } }),
    /TN_DESKTOP_NOTARY_FAILED/u,
  );
  assert.deepEqual(
    assertNotaryEvidence({
      artifactSha256: artifact,
      evidence: { artifactSha256: artifact, id: 'ok', status: 'Accepted' },
    }),
    { artifactSha256: artifact, id: 'ok', status: 'Accepted' },
  );
});

test('a notarization rejection from notarytool refuses the release', () => {
  const directory = makeTempDirSync('threenative-notary-reject-');
  const archive = join(directory, 'game.zip');
  writeFileSync(archive, 'archive bytes');
  assert.throws(
    () =>
      notarizeArchive({
        archive,
        run: (command, args) => {
          assert.equal(command, 'xcrun');
          assert.deepEqual(args.slice(0, 2), ['notarytool', 'submit']);
          return { error: undefined, status: 0, stdout: JSON.stringify({ id: 'run-1', status: 'Invalid' }), stderr: '' };
        },
        signing: { keychainProfile: 'tn-notary' },
      }),
    /TN_DESKTOP_NOTARY_FAILED/u,
  );
});

test('unsigned preparation proceeds and is named unsigned when no signing inputs are given', () => {
  const directory = makeTempDirSync('threenative-unsigned-');
  const executable = join(directory, 'input');
  writeFileSync(executable, 'executable');
  const result = packageDesktopContainer({ bundle: stageBundle(directory),
    arch: 'x64',
    config: { app: { id: 'com.example.unsigned', name: 'Unsigned Game' } },
    executable,
    output: join(directory, 'game'),
    platform: 'linux',
    run: (command, args) => {
      assert.equal(command, 'tar');
      writeFileSync(args[1], 'archive bytes');
      return { error: undefined, status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(result.signed, false);
  assert.equal(result.manifest.signed, false);
});

test('missing signing credentials stay PENDING while unsigned preparation proceeds', () => {
  // No request and no inputs: unsigned release, no signing object.
  assert.equal(desktopSigningFromEnvironment({}), undefined);
  // A request without credentials is PENDING for signing; the artifact is never mislabelled signed.
  assert.deepEqual(desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_SIGN: '1' }), { requested: true });
  const directory = makeTempDirSync('threenative-signing-pending-');
  const target = join(directory, 'game');
  writeFileSync(target, 'executable');
  assert.throws(
    () => signDesktopArtifact({ platform: 'darwin', signing: { requested: true }, target }),
    /TN_DESKTOP_SIGNING_CREDENTIALS_MISSING/u,
  );
  assert.throws(
    () => signDesktopArtifact({ platform: 'win32', signing: { requested: true }, target }),
    /TN_DESKTOP_SIGNING_CREDENTIALS_MISSING/u,
  );
  // A Windows certificate configured on a non-Windows host still leaves Linux unsigned.
  assert.equal(
    desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_SIGN_CERTIFICATE: '/keys/game.pfx' }).certificate,
    '/keys/game.pfx',
  );
});

// A successful credentialed path: codesign/verify must run and the manifest must name the scheme.
// This is a fixture transport, not a real signature; it exists to catch a success path that throws
// after signing (the `.app` directory has no file hash).
test('a successful macOS signature records the signing scheme', () => {
  const directory = makeTempDirSync('threenative-sign-success-');
  const executable = join(directory, 'input');
  writeFileSync(executable, 'executable');
  const calls = [];
  const run = (command, args) => {
    calls.push(`${command} ${args[0] ?? ''}`);
    if (command === 'codesign') return { status: 0, stdout: '', stderr: '' };
    if (command === 'zip') {
      writeFileSync(args[2], 'archive bytes');
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected tool ${command}`);
  };
  const result = packageDesktopContainer({ bundle: stageBundle(directory),
    arch: 'x64',
    config: { app: { id: 'com.example.signed', name: 'Signed Game' } },
    executable,
    output: join(directory, 'game'),
    platform: 'darwin',
    run,
    signing: { identity: 'Developer ID Application: Example (TEAM)' },
  });
  assert.equal(result.signed, true);
  assert.equal(result.manifest.signed, true);
  assert.equal(result.manifest.signingScheme, 'codesign');
  assert.ok(calls.some((call) => call === 'codesign --force'));
  assert.ok(calls.some((call) => call === 'codesign --verify'));
});

test('Windows signing can use a certificate store subject, which is what a CA-issued key needs', () => {
  // `signtool sign /f <pfx>` is the only form the packager offered, and it is passed no `/p`, so it
  // can only consume a password-less PFX. A CA does not issue one of those. `/n <subject>` signs
  // from the Windows certificate store, which is also what the README promises: the private key
  // stays in the OS keychain and never reaches the build config.
  const directory = makeTempDirSync('threenative-sign-subject-');
  const target = join(directory, 'game.exe');
  writeFileSync(target, 'executable');
  const calls = [];
  const run = (command, args) => {
    calls.push({ args, command });
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = signDesktopArtifact({
    platform: 'win32',
    run,
    signing: { subject: 'Example Publisher Ltd' },
    target,
  });
  assert.equal(result.scheme, 'signtool');
  assert.equal(result.signed, true);
  const sign = calls.find((call) => call.args[0] === 'sign');
  assert.ok(sign.args.includes('/n'), `sign must use /n, got: ${sign.args.join(' ')}`);
  assert.equal(sign.args[sign.args.indexOf('/n') + 1], 'Example Publisher Ltd');
  assert.equal(sign.args.includes('/f'), false, 'a store subject must not also pass a PFX path');
  assert.ok(calls.some((call) => call.args[0] === 'verify' && call.args.includes('/pa')));
});

test('Windows signing still passes the certificate file when no subject is given', () => {
  // The mirror of the /n case. Without it, deleting the `/f` arguments leaves signtool to auto-select
  // a certificate and every test stays green, so the path this PR must not break is unguarded.
  const directory = makeTempDirSync('threenative-sign-pfx-');
  const target = join(directory, 'game.exe');
  const certificate = join(directory, 'publisher.pfx');
  writeFileSync(target, 'executable');
  writeFileSync(certificate, 'pfx bytes');
  const calls = [];
  const result = signDesktopArtifact({
    platform: 'win32',
    run: (command, args) => { calls.push({ args, command }); return { status: 0, stdout: '', stderr: '' }; },
    signing: { certificate, timestampUrl: 'http://timestamp.example/rfc3161' },
    target,
  });
  assert.equal(result.scheme, 'signtool');
  const sign = calls.find((call) => call.args[0] === 'sign');
  assert.equal(sign.args[sign.args.indexOf('/f') + 1], certificate, `got: ${sign.args.join(' ')}`);
  assert.equal(sign.args.includes('/n'), false, 'a certificate file must not also pass a store subject');
  assert.equal(sign.args[sign.args.indexOf('/tr') + 1], 'http://timestamp.example/rfc3161');
});

test('a blank signing variable reads as absent, not as a request to sign', () => {
  // A CI job writing `SUBJECT: ${{ secrets.WIN_SIGN_SUBJECT }}` with the secret unset passes the
  // empty string. Treating that as a signing request turns a release that produced an unsigned
  // container into a hard failure.
  assert.equal(desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_SIGN_SUBJECT: '' }), undefined);
  assert.equal(desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_SIGN_CERTIFICATE: '   ' }), undefined);
  assert.equal(desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_CODESIGN_IDENTITY: '' }), undefined);
  assert.equal(desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_NOTARY_PROFILE: '' }), undefined);
});

test('both Windows credential variables set is refused before a release is built', () => {
  // The same clash inside signDesktopArtifact costs a full compile and staging first.
  assert.throws(
    () => desktopSigningFromEnvironment({
      THREENATIVE_DESKTOP_SIGN_CERTIFICATE: 'C:/keys/publisher.pfx',
      THREENATIVE_DESKTOP_SIGN_SUBJECT: 'Example Publisher Ltd',
    }),
    /TN_DESKTOP_SIGNING_CREDENTIALS_AMBIGUOUS/u,
  );
});

test('Windows signing refuses a certificate file and a store subject together', () => {
  // Silently preferring one would sign with a key the author did not choose.
  const directory = makeTempDirSync('threenative-sign-ambiguous-');
  const target = join(directory, 'game.exe');
  writeFileSync(target, 'executable');
  assert.throws(
    () => signDesktopArtifact({
      platform: 'win32',
      run: () => ({ status: 0, stdout: '', stderr: '' }),
      signing: { certificate: join(directory, 'publisher.pfx'), subject: 'Example Publisher Ltd' },
      target,
    }),
    /TN_DESKTOP_SIGNING_CREDENTIALS_AMBIGUOUS/u,
  );
});

test('desktopSigningFromEnvironment carries a store subject on its own', () => {
  const signing = desktopSigningFromEnvironment({ THREENATIVE_DESKTOP_SIGN_SUBJECT: 'Example Publisher Ltd' });
  assert.equal(signing?.subject, 'Example Publisher Ltd');
});

test('a successful Windows signature records the signing scheme', () => {
  const directory = makeTempDirSync('threenative-sign-win-');
  const executable = join(directory, 'input.exe');
  writeFileSync(executable, 'executable');
  const calls = [];
  const run = (command, args) => {
    calls.push(`${command} ${args[0] ?? ''}`);
    if (command === 'signtool') return { status: 0, stdout: '', stderr: '' };
    if (command === 'zip') {
      writeFileSync(args[2], 'archive bytes');
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'makensis') {
      const output = /^OutFile "([^"]+)"$/mu.exec(readFileSync(args.at(-1), 'utf8'))?.[1];
      assert.ok(output);
      writeFileSync(output, 'MZ installer fixture');
      return { status: 0, stdout: '', stderr: '' };
    }
    throw new Error(`unexpected tool ${command}`);
  };
  const result = packageDesktopContainer({ bundle: stageBundle(directory),
    arch: 'x64',
    config: { app: { id: 'com.example.win', name: 'Win Game' } },
    executable,
    output: join(directory, 'game'),
    platform: 'win32',
    run,
    signing: { certificate: '/keys/game.pfx', timestampUrl: 'http://timestamp.example' },
  });
  assert.equal(result.signed, true);
  assert.equal(result.manifest.signed, true);
  assert.equal(result.manifest.signingScheme, 'signtool');
  assert.ok(calls.includes('signtool sign'));
  assert.ok(calls.includes('signtool verify'));
});

test('macOS notarization staples and re-archives the signed bundle', () => {
  const directory = makeTempDirSync('threenative-notary-success-');
  const executable = join(directory, 'input');
  writeFileSync(executable, 'executable');
  const calls = [];
  let archiveWrites = 0;
  const run = (command, args) => {
    calls.push(`${command} ${args[0] ?? ''}`);
    if (command === 'codesign') return { status: 0, stdout: '', stderr: '' };
    if (command === 'zip') {
      writeFileSync(args[2], 'archive bytes');
      archiveWrites += 1;
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'xcrun' && args[0] === 'notarytool') {
      return { status: 0, stdout: JSON.stringify({ id: 'notary-1', status: 'Accepted' }), stderr: '' };
    }
    if (command === 'xcrun' && args[0] === 'stapler') return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected tool ${command} ${args.join(' ')}`);
  };
  const result = packageDesktopContainer({ bundle: stageBundle(directory),
    arch: 'x64',
    config: { app: { id: 'com.example.notary', name: 'Notary Game' } },
    executable,
    output: join(directory, 'game'),
    platform: 'darwin',
    run,
    signing: { identity: 'Developer ID Application: Example (TEAM)', keychainProfile: 'tn-notary', notarize: true },
  });
  assert.equal(result.signed, true);
  assert.ok(calls.includes('xcrun notarytool'));
  assert.ok(calls.includes('xcrun stapler'));
  assert.equal(archiveWrites, 2, 'the stapled bundle is archived again');
});


test('engine player assets install and verify checksums on each desktop platform', async () => {
  const root = makeTempDirSync('threenative-engine-player-');
  roots.push(root);
  const manifestPath = join(root, 'prebuilt-lock.json');
  try {
    for (const [platform, arch] of [['linux', 'x64'], ['win32', 'x64']]) {
      const key = `${platform}-${arch}-engine-player`;
      assert.ok(PUBLISHED_PREBUILT_KEYS.includes(key));
      assert.equal(PREBUILT_ASSET_NAMES[key], `threenative-engine-player-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`);
      const payload = Buffer.from(`player:${key}`);
      const artifact = { sha256: sha256(payload), url: `https://fixture.invalid/${key}` };
      const writeManifest = () => writeFileSync(manifestPath, JSON.stringify({ artifacts: { [key]: artifact } }));
      writeManifest();
      vi.stubGlobal('fetch', vi.fn(async () => new Response(payload)));
      const output = join(root, platform, `tn-native-engine-player-v8${platform === 'win32' ? '.exe' : ''}`);
      const install = { platform, arch, enginePlayer: true, output, manifestPath };
      await installPrebuilt(install);
      assert.deepEqual(readFileSync(output), payload);
      assert.equal(JSON.parse(readFileSync(join(root, platform, 'engine-player-install-status.json'))).sha256, sha256(payload));
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('offline'); }));
      assert.equal(await installPrebuilt({ ...install, reuse: true }), output);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(payload)));
      artifact.sha256 = '0'.repeat(64);
      writeManifest();
      await assert.rejects(installPrebuilt({ ...install, reuse: true }), /Checksum verification failed/);
      assert.equal(existsSync(output), false);
    }
    assert.ok(UNPUBLISHED_PREBUILT_KEYS.includes('darwin-arm64-engine-player'));
    assert.equal(PREBUILT_ASSET_NAMES['darwin-arm64-engine-player'], 'threenative-engine-player-darwin-arm64');
    await assert.rejects(installPrebuilt({ platform: 'darwin', arch: 'arm64', enginePlayer: true, output: join(root, 'mac-player'), manifestPath }), (error) => error.code === 'PREBUILT_RELEASE_UNPUBLISHED');
    assert.throws(() => readRelease(join(root, 'not-released.json'), 'linux-x64-engine-player'), (error) => error.code === 'PREBUILT_RELEASE_UNPUBLISHED');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    await assert.rejects(downloadReleaseArtifact('linux-x64-engine-player', { manifestUrl: 'https://fixture.invalid/not-released' }), (error) => error.code === 'PREBUILT_RELEASE_UNPUBLISHED' && error.message.includes('linux-x64-engine-player'));
    writeFileSync(manifestPath, JSON.stringify({ artifacts: {} }));
    await assert.rejects(installPrebuilt({ platform: 'linux', arch: 'x64', enginePlayer: true, output: join(root, 'absent-player'), manifestPath }), (error) => error.code === 'PREBUILT_RELEASE_UNPUBLISHED' && error.message.includes('linux-x64-engine-player'));
  } finally { vi.unstubAllGlobals(); }
});
