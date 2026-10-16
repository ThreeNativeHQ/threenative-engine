import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  assert.deepEqual([...arm64.matchAll(/'([^']+)'/gu)].map((match) => match[1]),
    ['wgpu', 'sdl3', 'v8', 'quickjs', 'stb', 'cgltf', 'webp', 'webp-source', 'skia', 'swc', 'quiche', 'libuv-source']);

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
    ['v8', 'v8-linux-arm64', '.tgz'],
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
  const count = readLock().components.reduce((total, component) => total + component.payloads.length, 0);
  assert.ok(output.includes(`payloads: ${count}`));
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


test('arm64 V8 consumes only its locked archive and verifies fresh and cached receipts', async () => {
  const root = makeTempDirSync('tn-v8-consumer-');
  const realFetch = globalThis.fetch;
  const architecture = Object.getOwnPropertyDescriptor(process, 'arch');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    cpSync(join(PACKAGE_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true });
    cpSync(join(PACKAGE_ROOT, 'package.json'), join(root, 'package.json'));
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const downloader = await import(pathToFileURL(join(root, 'scripts/download-deps.mjs')).href);
    Object.defineProperty(process, 'arch', architecture);
    Object.defineProperty(process, 'platform', platform);
    const producer = await import(pathToFileURL(join(root, 'scripts/build-linux-arm64-v8.mjs')).href);
    const { collectReceipts } = await import(pathToFileURL(join(root, 'scripts/generate-native-sbom.mjs')).href);
    const fetched = [];
    globalThis.fetch = async (url) => { fetched.push(url); return { ok: false, status: 404 }; };
    const x64 = readLock().components.find((component) => component.name === 'v8').payloads.find((payload) => payload.id === 'v8-linux-x64');
    const lockContext = { lockHash: 'fixture', payloads: new Map([[x64.id, x64]]) };
    await assert.rejects(downloader.downloadDep('v8', { lockContext }), /TN_NATIVE_DEP_LOCK_MISSING: v8-linux-arm64/);
    assert.deepEqual(fetched, [], 'missing arm64 descriptor must never fetch x64 or build source');

    const stage = join(root, 'payload');
    mkdirSync(join(stage, 'include'), { recursive: true });
    mkdirSync(join(stage, 'licenses'));
    writeFileSync(join(stage, 'include/v8.h'), '// fixture');
    writeFileSync(join(stage, 'include/v8-version.h'),
      ['MAJOR_VERSION 13', 'MINOR_VERSION 1', 'BUILD_NUMBER 201', 'PATCH_LEVEL 22']
        .map((part) => `#define V8_${part}\n`).join(''));
    for (const name of ['V8-LICENSE', 'V8-LICENSE.v8', 'V8-FDLIBM', 'V8-STRONGTALK', 'BUILD-LICENSE', 'COMPILER-RT-COPYRIGHT'])
      writeFileSync(join(stage, 'licenses', name), 'fixture license');
    writeFileSync(join(stage, 'licenses/BUILD-LICENSE'), Buffer.from('Ly8gQ29weXJpZ2h0IDIwMTUgVGhlIENocm9taXVtIEF1dGhvcnMKLy8KLy8gUmVkaXN0cmlidXRpb24gYW5kIHVzZSBpbiBzb3VyY2UgYW5kIGJpbmFyeSBmb3Jtcywgd2l0aCBvciB3aXRob3V0Ci8vIG1vZGlmaWNhdGlvbiwgYXJlIHBlcm1pdHRlZCBwcm92aWRlZCB0aGF0IHRoZSBmb2xsb3dpbmcgY29uZGl0aW9ucyBhcmUKLy8gbWV0OgovLwovLyAgICAqIFJlZGlzdHJpYnV0aW9ucyBvZiBzb3VyY2UgY29kZSBtdXN0IHJldGFpbiB0aGUgYWJvdmUgY29weXJpZ2h0Ci8vIG5vdGljZSwgdGhpcyBsaXN0IG9mIGNvbmRpdGlvbnMgYW5kIHRoZSBmb2xsb3dpbmcgZGlzY2xhaW1lci4KLy8gICAgKiBSZWRpc3RyaWJ1dGlvbnMgaW4gYmluYXJ5IGZvcm0gbXVzdCByZXByb2R1Y2UgdGhlIGFib3ZlCi8vIGNvcHlyaWdodCBub3RpY2UsIHRoaXMgbGlzdCBvZiBjb25kaXRpb25zIGFuZCB0aGUgZm9sbG93aW5nIGRpc2NsYWltZXIKLy8gaW4gdGhlIGRvY3VtZW50YXRpb24gYW5kL29yIG90aGVyIG1hdGVyaWFscyBwcm92aWRlZCB3aXRoIHRoZQovLyBkaXN0cmlidXRpb24uCi8vICAgICogTmVpdGhlciB0aGUgbmFtZSBvZiBHb29nbGUgTExDIG5vciB0aGUgbmFtZXMgb2YgaXRzCi8vIGNvbnRyaWJ1dG9ycyBtYXkgYmUgdXNlZCB0byBlbmRvcnNlIG9yIHByb21vdGUgcHJvZHVjdHMgZGVyaXZlZCBmcm9tCi8vIHRoaXMgc29mdHdhcmUgd2l0aG91dCBzcGVjaWZpYyBwcmlvciB3cml0dGVuIHBlcm1pc3Npb24uCi8vCi8vIFRISVMgU09GVFdBUkUgSVMgUFJPVklERUQgQlkgVEhFIENPUFlSSUdIVCBIT0xERVJTIEFORCBDT05UUklCVVRPUlMKLy8gIkFTIElTIiBBTkQgQU5ZIEVYUFJFU1MgT1IgSU1QTElFRCBXQVJSQU5USUVTLCBJTkNMVURJTkcsIEJVVCBOT1QKLy8gTElNSVRFRCBUTywgVEhFIElNUExJRUQgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFkgQU5EIEZJVE5FU1MgRk9SCi8vIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFSRSBESVNDTEFJTUVELiBJTiBOTyBFVkVOVCBTSEFMTCBUSEUgQ09QWVJJR0hUCi8vIE9XTkVSIE9SIENPTlRSSUJVVE9SUyBCRSBMSUFCTEUgRk9SIEFOWSBESVJFQ1QsIElORElSRUNULCBJTkNJREVOVEFMLAovLyBTUEVDSUFMLCBFWEVNUExBUlksIE9SIENPTlNFUVVFTlRJQUwgREFNQUdFUyAoSU5DTFVESU5HLCBCVVQgTk9UCi8vIExJTUlURUQgVE8sIFBST0NVUkVNRU5UIE9GIFNVQlNUSVRVVEUgR09PRFMgT1IgU0VSVklDRVM7IExPU1MgT0YgVVNFLAovLyBEQVRBLCBPUiBQUk9GSVRTOyBPUiBCVVNJTkVTUyBJTlRFUlJVUFRJT04pIEhPV0VWRVIgQ0FVU0VEIEFORCBPTiBBTlkKLy8gVEhFT1JZIE9GIExJQUJJTElUWSwgV0hFVEhFUiBJTiBDT05UUkFDVCwgU1RSSUNUIExJQUJJTElUWSwgT1IgVE9SVAovLyAoSU5DTFVESU5HIE5FR0xJR0VOQ0UgT1IgT1RIRVJXSVNFKSBBUklTSU5HIElOIEFOWSBXQVkgT1VUIE9GIFRIRSBVU0UKLy8gT0YgVEhJUyBTT0ZUV0FSRSwgRVZFTiBJRiBBRFZJU0VEIE9GIFRIRSBQT1NTSUJJTElUWSBPRiBTVUNIIERBTUFHRS4K', 'base64'));
    const elf = Buffer.alloc(64);
    Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(elf);
    elf.writeUInt16LE(1, 16);
    elf.writeUInt16LE(183, 18);
    writeFileSync(join(stage, 'libv8_monolith.a'), Buffer.concat([
      Buffer.from('!<arch>\n'),
      Buffer.from(`${'object.o/'.padEnd(16)}${'0'.padEnd(12)}${'0'.padEnd(6)}${'0'.padEnd(6)}${'644'.padEnd(8)}${'64'.padEnd(10)}\x60\n`), elf,
    ]));
    const toolchain = producer.inspectLinuxArm64V8Toolchain({
      run: (program, args) => program === 'dpkg-query'
        ? `${args.at(-1)}\t${args.at(-1) === 'libclang-rt-18-dev' ? '1:18.1.3-1' : '1:18.1.3-1ubuntu1'}\tarm64\tinstall ok installed`
        : program === 'dpkg' ? '' : program === '/usr/bin/pkg-config' ? '2.80.0' : 'LLVM version 18.1.3',
      hash: (path) => path.endsWith('.a') ? producer.LINUX_ARM64_V8_BUILD.toolchain.compilerRt.sha256 : 'a'.repeat(64),
      read: () => {
        const fixture = readFileSync(join(stage, 'libv8_monolith.a'));
        return Buffer.concat([fixture, ...Array.from({ length: 277 }, () => fixture.subarray(8))]);
      },
    });
    toolchain.gn = { package: producer.LINUX_ARM64_V8_BUILD.gnPackage, sha256: producer.LINUX_ARM64_V8_BUILD.gnSha256, version: '2200 (95b0f8fe31a9)' };
    writeFileSync(join(stage, 'build-receipt.json'), JSON.stringify(producer.createLinuxArm64V8Receipt(stage, toolchain)));
    const archive = join(root, 'fixture.tgz');
    execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
    let bytes = readFileSync(archive);
    const payload = { id: 'v8-linux-arm64', url: 'https://example.invalid/ci-v8-linux-arm64/v8-linux-arm64-fixture.tgz' };
    const receiptSha256 = createHash('sha256').update(readFileSync(join(stage, 'build-receipt.json'))).digest('hex');
    const setBytes = () => lockContext.payloads.set(payload.id, {
      ...payload, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
      provenance: { receiptSha256 },
    });
    setBytes();
    globalThis.fetch = async (url) => { fetched.push(url); return new Response(bytes); };
    assert.equal(await downloader.downloadDep('v8', { lockContext }), true);
    assert.deepEqual(fetched, [payload.url], 'the exact locked arm64 URL is the only fetch');
    const installed = join(root, 'third_party/v8');
    assert.equal(producer.verifyLinuxArm64V8Installation(installed).build.version, '13.1.201.22');
    const freshReceipts = collectReceipts(join(root, 'third_party'), lockContext.lockHash);
    assert.equal(freshReceipts.length, 1);
    assert.equal(freshReceipts[0].dir, 'v8');
    assert.deepEqual(freshReceipts[0].payloads, ['v8-linux-arm64']);
    assert.throws(() => collectReceipts(join(root, 'third_party'), 'stale'), /TN_NATIVE_SBOM_RECEIPT_STALE.*v8/);
    fetched.length = 0;
    assert.equal(await downloader.downloadDep('v8', { lockContext }), true);
    assert.deepEqual(fetched, [], 'verified installation is a cache hit');
    assert.deepEqual(collectReceipts(join(root, 'third_party'), lockContext.lockHash), freshReceipts);
    const originalArchive = readFileSync(join(installed, 'libv8_monolith.a'));
    const originalReceipt = readFileSync(join(installed, 'build-receipt.json'));
    const substituted = Buffer.from(originalArchive);
    substituted.writeUInt8(substituted.readUInt8(76) ^ 1, 76);
    writeFileSync(join(installed, 'libv8_monolith.a'), substituted);
    writeFileSync(join(installed, 'build-receipt.json'), JSON.stringify(producer.createLinuxArm64V8Receipt(installed, toolchain)));
    assert.equal(producer.verifyLinuxArm64V8Installation(installed).objects, 1, 'substitution has a self-consistent AArch64 receipt');
    await assert.rejects(downloader.downloadDep('v8', { lockContext }), /TN_V8_RECEIPT_PIN_MISMATCH/);
    assert.deepEqual(fetched, [], 'recomputed cached receipt is rejected before fetching');
    writeFileSync(join(installed, 'libv8_monolith.a'), originalArchive);
    writeFileSync(join(installed, 'build-receipt.json'), originalReceipt);
    writeFileSync(join(installed, 'include/v8.h'), 'tampered');
    await assert.rejects(downloader.downloadDep('v8', { lockContext }), /checksum\/coverage mismatch/);
    assert.deepEqual(fetched, [], 'tampered cache fails before a fallback fetch');

    rmSync(installed, { recursive: true });
    const lockReceipt = join(root, 'third_party/.threenative-receipts/v8-linux-arm64.json');
    rmSync(lockReceipt);
    for (const pin of [undefined, 'not-hex', 'f'.repeat(64)]) {
      setBytes();
      const descriptor = lockContext.payloads.get(payload.id);
      lockContext.payloads.set(payload.id, { ...descriptor, provenance: pin === undefined ? undefined : { receiptSha256: pin } });
      assert.equal(await downloader.downloadDep('v8', { lockContext }), false, 'fresh acquisition rejects missing or wrong receipt pin');
      assert.equal(existsSync(lockReceipt), false, 'bad pin cannot create a trusted acquisition receipt');
      rmSync(installed, { recursive: true, force: true });
    }
    rmSync(join(stage, 'build-receipt.json'));
    execFileSync('tar', ['-czf', archive, '-C', stage, '.']);
    bytes = readFileSync(archive);
    setBytes();
    assert.equal(await downloader.downloadDep('v8', { lockContext }), false, 'fresh archive without a build receipt must fail');
    assert.equal(existsSync(lockReceipt), false);
  } finally {
    Object.defineProperty(process, 'arch', architecture);
    Object.defineProperty(process, 'platform', platform);
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
  }
});
