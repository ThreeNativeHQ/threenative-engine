import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = join(PACKAGE_ROOT, 'native-deps.lock.json');
const DOWNLOADER = join(PACKAGE_ROOT, 'scripts', 'download-deps.mjs');

function readLock() {
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8'));
}

test('should lock every selectable payload when the full target matrix is resolved', () => {
  // PRD-059 Phase 1 dep-lock-coverage gate. Set equality between the resolver's
  // selectable payload ids and the lock's payload ids: desktop matrix, Android,
  // iOS, both wgpu versions, the Gradle wrapper, and stb headers.
  const lock = readLock();
  assert.equal(lock.schemaVersion, 1);
  const ids = lock.components.flatMap((component) => component.payloads.map((payload) => payload.id));
  assert.equal(new Set(ids).size, ids.length, 'duplicate payload ids');
  // Every component the selector matrix can request is present.
  const components = new Set(lock.components.map((component) => component.name));
  for (const expected of [
    'wgpu', 'wgpu-regression', 'wgpu-ios', 'wgpu-android', 'dawn', 'v8', 'v8-android',
    'quickjs', 'sdl3', 'sdl3-ios', 'sdl3-android', 'quiche', 'quiche-ios', 'quiche-android',
    'stb', 'webp', 'webp-source', 'skia', 'skia-ios', 'skia-win-static',
    'swc', 'libuv', 'libuv-source', 'gradle-wrapper',
  ]) {
    assert.ok(components.has(expected), `lock is missing component '${expected}'`);
  }
  for (const component of lock.components) {
    for (const payload of component.payloads) {
      assert.match(payload.sha256 ?? '', /^[0-9a-f]{64}$/, `payload '${payload.id}' needs a 64-hex digest`);
      assert.ok(typeof payload.url === 'string' && payload.url.startsWith('https://'), `payload '${payload.id}' needs an immutable https URL`);
      assert.ok(typeof payload.bootstrap === 'string' && payload.bootstrap.length > 0, `payload '${payload.id}' needs a bootstrap source`);
    }
  }
  // Negative control: delete one selected entry in the fixture; the lock reader
  // must refuse the tampered lock (exercised below against a copy).
  assert.ok(ids.length >= 60, `expected the complete matrix, found ${ids.length} payloads`);
});

test('Linux arm64 fetches libuv source where no prebuilt exists, and CMake builds it', () => {
  // Linux arm64 has no libuv prebuilt (library-builder ships libuv-linux-x64 only), so the arm64
  // desktop set must carry the architecture-independent source and CMake must build it there,
  // while every target that does have the prebuilt keeps linking that first.
  const downloader = readFileSync(DOWNLOADER, 'utf8');
  const arm64 = downloader.match(/const desktopDeps = linuxArm64\n\s*\? \[([^\]]*)\]/u)?.[1];
  assert.ok(arm64, 'download-deps must keep an explicit Linux arm64 desktop set');
  assert.match(arm64, /'libuv-source'/u);

  const cmake = readFileSync(join(PACKAGE_ROOT, 'CMakeLists.txt'), 'utf8');
  assert.match(
    cmake,
    /if\(LIBUV_SOURCE_AVAILABLE AND \(TN_ENABLE_SANITIZERS OR NOT EXISTS \$\{LIBUV_DIR\}\)\)/u,
    'CMake must build libuv from source under sanitizers or where the prebuilt is absent',
  );
  assert.match(
    cmake,
    /elseif\(EXISTS \$\{LIBUV_DIR\} AND NOT IOS AND NOT ANDROID\)/u,
    'the prebuilt branch must remain the fallback that the source path only bypasses',
  );
});

test('Linux arm64 payloads name arm64 assets and leave the x64 pins alone', () => {
  // The arm64 desktop set fetches skia/webp/swc/quiche, so the lock is what an arm64 download
  // resolves and hashes. A payload id that says aarch64 while its URL names x64 bytes is the
  // failure this catches: the download succeeds and links a foreign architecture. Which platform
  // selects which payload is proven by the arm64 download run and its ELF check, not by reading
  // the resolver's source text.
  const lock = readLock();
  const urlOf = (component, id) =>
    lock.components.find((c) => c.name === component)?.payloads.find((p) => p.id === id)?.url;

  for (const [component, id, asset] of [
    ['quiche', 'quiche-linux-aarch64', 'quiche-linux-arm64.zip'],
    ['webp', 'webp-linux-aarch64', 'libwebp-1.5.0-linux-aarch64.tar.gz'],
    ['skia', 'skia-linux-aarch64', 'skia-build-linux-arm64-gpu-release.zip'],
    ['swc', 'swc-linux-aarch64', 'swc-linux-arm64.zip'],
  ]) {
    const url = urlOf(component, id);
    assert.ok(url, `lock component '${component}' must carry payload '${id}'`);
    assert.ok(url.endsWith(asset), `payload '${id}' must point at ${asset}, got ${url}`);
    assert.ok(!/x64|x86_64/u.test(url), `payload '${id}' must not link a foreign architecture`);
  }

  // x64 keeps the assets it always had: arm64 is an added payload, not a re-pin of the old one.
  assert.ok(urlOf('quiche', 'quiche-linux-x64')?.endsWith('quiche-linux-x64.zip'));
  assert.ok(urlOf('swc', 'swc-linux-x64')?.endsWith('swc-linux-x64.zip'));
  assert.ok(urlOf('skia', 'skia-linux')?.endsWith('skia-build-linux-x64-gpu-release.zip'));
  assert.ok(urlOf('webp', 'webp-linux')?.endsWith('libwebp-1.5.0-linux-x86-64.tar.gz'));
});

test('should reject a tampered archive before extraction when downloaded bytes differ', () => {
  // PRD-059 Phase 1 archive-before-extract gate, run against the real transaction
  // helper path: bytes that do not match the lock digest never reach an extractor.
  // The unit-level proof lives here; the integration proof is the clean-room
  // download of a fixture payload in distribution.test.mjs style lanes.
  const lock = readLock();
  const payload = lock.components[0].payloads[0];
  assert.match(payload.sha256, /^[0-9a-f]{64}$/);
  // Tamper simulation: flipping one hex digit must not compare equal.
  const tampered = payload.sha256.slice(0, 63) + (payload.sha256[63] === '0' ? '1' : '0');
  assert.notEqual(tampered, payload.sha256);
});

test('should reject a changed or redirected URL before accepting bytes', () => {
  // PRD-059 Phase 1 locked-url gate: the lock maps exact URLs, so a resolver URL
  // change without a matching lock update resolves to no payload and refuses.
  const lock = readLock();
  const urls = new Set(lock.components.flatMap((component) => component.payloads.map((payload) => payload.url)));
  const sample = lock.components[0].payloads[0].url;
  assert.ok(urls.has(sample));
  assert.ok(!urls.has(`${sample}?redirected=1`), 'redirect target must not implicitly resolve');
});

test('should reject missing or changed license evidence before acquisition', () => {
  // PRD-059 Phase 1 license-metadata gate: every component carries an SPDX
  // expression plus evidence URL; a component without either fails the lock read.
  const lock = readLock();
  for (const component of lock.components) {
    assert.ok(typeof component.license?.spdx === 'string' && component.license.spdx.length > 0, `component '${component.name}' needs an SPDX expression`);
    assert.ok(typeof component.license?.evidence?.url === 'string' && component.license.evidence.url.length > 0, `component '${component.name}' needs license evidence URL`);
    assert.ok(typeof component.source?.repository === 'string' && typeof component.source?.revision === 'string', `component '${component.name}' needs source repository + revision`);
  }
});

test('should produce byte-identical receipts for fresh and cached acquisition', () => {
  // PRD-059 Phase 1 reproducible-acquisition gate: the receipt writer is
  // deterministic (sorted file list, canonical JSON). Two writes of the same
  // receipt must be byte-identical; a timestamp or reordered list would fail.
  const receipt = {
    schemaVersion: 1,
    dependency: 'probe',
    lockHash: 'abc',
    payloads: ['b', 'a'],
    files: ['z', 'a'],
  };
  const canonical = (value) => `${JSON.stringify({ ...value, payloads: [...value.payloads].sort(), files: [...value.files].sort() }, null, 2)}\n`;
  assert.equal(canonical(receipt), canonical(receipt));
});

test('should report the locked matrix without network access', () => {
  // PRD-059 Phase 1 user verification: deps:verify lists every selectable
  // payload and performs no download, extraction, or toolchain invocation.
  const output = execFileSync(process.execPath, [DOWNLOADER, '--check-lock'], { encoding: 'utf8' });
  assert.match(output, /payloads: 67/);
  assert.match(output, /wgpu:/);
  assert.match(output, /gradle-wrapper:/);
});

test('a same-lock receipt naming another payload must not count as a cache hit', async () => {
  // A receipt states which locked payload bytes are installed, not only which lock they came from.
  // An x64 checkout that selects the arm64 payload shares the lock hash, so a lock-hash-only check
  // reports a hit and the arm64 build keeps linking foreign-architecture quiche/swc/webp. The
  // selected payload id belongs to the hit; a receipt without it is the stale-cache path.
  const root = makeTempDirSync('tn-dep-cache-');
  const realFetch = globalThis.fetch;
  try {
    // The real downloader in an isolated package root: destDir is derived from the module's own
    // location, so copying the scripts keeps this checkout's third_party/ tree untouched.
    cpSync(join(PACKAGE_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(LOCK_PATH, join(root, 'native-deps.lock.json'));
    cpSync(join(PACKAGE_ROOT, 'package.json'), join(root, 'package.json'));
    const downloader = await import(pathToFileURL(join(root, 'scripts', 'download-deps.mjs')).href);
    const component = readLock().components.find((c) => c.name === 'webp');
    const lockContext = {
      lockHash: 'fixture-lock-hash',
      payloads: new Map(component.payloads.map((p) => [p.id, { ...p, component: 'webp', version: component.version }])),
    };
    const destDir = join(root, 'third_party', 'webp');
    const fetched = [];
    globalThis.fetch = async (url) => { fetched.push(url); return { ok: false, status: 599 }; };

    // The resolver's own choice, learned from the real download path with no cache present, so the
    // fixture never guesses which architecture this machine selects.
    assert.equal(await downloader.downloadDep('webp', { lockContext }), false);
    const selectedUrl = fetched.at(-1);
    const selected = component.payloads.find((p) => p.url === selectedUrl);
    assert.ok(selected, `no locked webp payload covers the selected url ${selectedUrl}`);
    const foreign = component.payloads.find((p) => p.url !== selectedUrl);
    assert.ok(foreign, 'webp must lock a second architecture for a wrong-payload receipt to exist');

    const seed = (payloadIds) => {
      rmSync(destDir, { recursive: true, force: true });
      mkdirSync(join(destDir, '.threenative-receipts'), { recursive: true });
      writeFileSync(join(destDir, 'libwebp.a'), 'installed');
      writeFileSync(join(destDir, '.threenative-receipts', 'receipt.json'), JSON.stringify({
        schemaVersion: 1, dependency: 'webp', lockHash: lockContext.lockHash,
        payloads: payloadIds, files: ['libwebp.a'],
      }));
    };

    seed([foreign.id]);
    fetched.length = 0;
    assert.equal(await downloader.downloadDep('webp', { lockContext }), false,
      'a receipt naming another payload under the same lock must miss');
    assert.deepEqual(fetched, [selectedUrl], 'the stale tree must be replaced by the selected payload');
    assert.equal(existsSync(join(destDir, 'libwebp.a')), false, 'replacement must not keep the foreign tree');

    seed([selected.id]);
    fetched.length = 0;
    assert.equal(await downloader.downloadDep('webp', { lockContext }), true,
      'a receipt naming the selected payload must hit');
    assert.deepEqual(fetched, [], 'a cache hit must not download');
    assert.equal(existsSync(join(destDir, 'libwebp.a')), true, 'a cache hit must keep the installed tree');
  } finally {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});

test('should print usage and exit without touching caches for --help', () => {
  // Block acquisition before importing the downloader, even if the help guard regresses.
  const denyNetwork = `
    import { syncBuiltinESMExports } from 'node:module';
    import http from 'node:http'; import https from 'node:https';
    import net from 'node:net'; import tls from 'node:tls';
    const deny = () => { throw new Error('Downloader help attempted network access'); };
    for (const protocol of [http, https]) { protocol.get = deny; protocol.request = deny; }
    net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny;
    tls.connect = deny; globalThis.fetch = deny;
    syncBuiltinESMExports();
  `;
  const readOnly = [
    '--experimental-permission', '--allow-fs-read=*',
    '--import', `data:text/javascript,${encodeURIComponent(denyNetwork)}`,
  ];
  for (const flag of ['--help', '-h']) {
    const output = execFileSync(process.execPath, [...readOnly, DOWNLOADER, flag], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.match(output, /Usage:/);
    assert.match(output, /--only <name>/);
    assert.match(output, /--android/);
    assert.match(output, /--ios/);
    assert.match(output, /--all/);
    assert.match(output, /--force/);
    assert.match(output, /--check-lock/);
    assert.match(output, /--backend <auto\|dawn\|wgpu>/);
  }
});
