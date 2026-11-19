import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';

import { ensureNativeBinary, sha256 } from '../scripts/install-prebuilt.mjs';

// PRD-783: the download moved from `pnpm install` to the first native build, so this is the one
// path a desktop build takes to acquire a binary. It must download once under parallel callers,
// reuse a verified cache with no network, and fail closed with a name and three fixes.

const roots = [];
const originalManifest = process.env.THREENATIVE_PREBUILT_MANIFEST;
const originalInsecure = process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  if (originalManifest === undefined) Reflect.deleteProperty(process.env, 'THREENATIVE_PREBUILT_MANIFEST');
  else process.env.THREENATIVE_PREBUILT_MANIFEST = originalManifest;
  if (originalInsecure === undefined) Reflect.deleteProperty(process.env, 'THREENATIVE_ALLOW_INSECURE_PREBUILT');
  else process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = originalInsecure;
});

/** A loopback release the ensure function can read, shaped like the artifact-only local pins. */
async function serve(payload, overrides = {}) {
  const root = makeTempDirSync('threenative-ensure-');
  roots.push(root);
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    if (overrides.status !== undefined) {
      response.statusCode = overrides.status;
      response.end();
      return;
    }
    response.setHeader('content-length', String(payload.length));
    response.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const url = overrides.url ?? `http://127.0.0.1:${address.port}/player`;
  const manifestPath = join(root, 'prebuilt-lock.json');
  writeFileSync(
    manifestPath,
    `${JSON.stringify({
      artifacts: {
        'linux-x64-engine-player': {
          sha256: overrides.sha256 ?? sha256(payload),
          size: payload.length,
          url,
        },
      },
    })}\n`,
  );
  process.env.THREENATIVE_ALLOW_INSECURE_PREBUILT = '1';
  const prebuilt = join(root, 'prebuilt');
  mkdirSync(prebuilt, { recursive: true });
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    manifestPath,
    options: {
      arch: 'x64',
      enginePlayer: true,
      manifestPath,
      output: join(prebuilt, 'linux-x64', 'tn-native-engine-player-v8'),
      platform: 'linux',
      statusPath: join(prebuilt, 'engine-player-install-status.json'),
    },
    prebuilt,
    requests: () => requests,
    root,
  };
}

test('parallel ensures download once and all callers get the verified binary', async () => {
  const payload = Buffer.from('engine player bytes');
  const fixture = await serve(payload);
  try {
    const outputs = await Promise.all([
      ensureNativeBinary(fixture.options),
      ensureNativeBinary(fixture.options),
      ensureNativeBinary(fixture.options),
    ]);
    assert.deepEqual(outputs, [fixture.options.output, fixture.options.output, fixture.options.output]);
    assert.deepEqual(readFileSync(fixture.options.output), payload);
    assert.equal(fixture.requests(), 1, 'one download, not one per caller');
    assert.equal(JSON.parse(readFileSync(fixture.options.statusPath, 'utf8')).ok, true);
    // Red on the pre-PRD `installPrebuilt`, whose `beginInstall` deleted the loser's output.
    for (const output of outputs) assert.deepEqual(readFileSync(output), payload);
  } finally {
    await fixture.close();
  }
});

test('a verified cache returns with no network at all', async () => {
  const payload = Buffer.from('cached engine player');
  const fixture = await serve(payload);
  try {
    await ensureNativeBinary(fixture.options);
    const before = fixture.requests();
    await fixture.close();
    // The server is gone: a second ensure that touched the network would reject.
    assert.equal(await ensureNativeBinary(fixture.options), fixture.options.output);
    assert.equal(fixture.requests(), before);
  } finally {
    await fixture.close();
  }
});

test('a bad checksum rejects and leaves no binary and no success status', async () => {
  const payload = Buffer.from('tampered engine player');
  const fixture = await serve(payload, { sha256: sha256(Buffer.from('something else')) });
  try {
    await assert.rejects(ensureNativeBinary(fixture.options), /TN_NATIVE_BINARY_UNAVAILABLE.*Checksum verification failed/su);
    assert.equal(existsSync(fixture.options.output), false);
    const status = JSON.parse(readFileSync(fixture.options.statusPath, 'utf8'));
    assert.equal(status.ok, false);
  } finally {
    await fixture.close();
  }
});

test('offline fails closed with the name, the URL and the three fixes', async () => {
  const payload = Buffer.from('unreachable engine player');
  // Port 1 on loopback: nothing listens, so the fetch fails the way an offline host does.
  const fixture = await serve(payload, { url: 'http://127.0.0.1:1/player' });
  try {
    const error = await ensureNativeBinary(fixture.options).then(
      () => assert.fail('an unreachable release must not resolve'),
      (rejection) => rejection,
    );
    assert.equal(error.code, 'TN_NATIVE_BINARY_UNAVAILABLE');
    assert.match(error.message, /TN_NATIVE_BINARY_UNAVAILABLE/u);
    assert.match(error.message, /threenative-engine-player-linux-x64/u);
    assert.match(error.message, /http:\/\/127\.0\.0\.1:1\/player/u);
    assert.match(error.message, /THREENATIVE_ENGINE_PLAYER/u);
    assert.match(error.message, /rerun the same command/u);
    assert.match(error.message, /engine checkout/u);
    assert.equal(existsSync(fixture.options.output), false);
  } finally {
    await fixture.close();
  }
});

test('a release that does not carry the asset fails closed as unpublished', async () => {
  const fixture = await serve(Buffer.from('unused'));
  try {
    writeFileSync(fixture.manifestPath, `${JSON.stringify({ artifacts: {} })}\n`);
    const error = await ensureNativeBinary(fixture.options).then(
      () => assert.fail('an unpublished asset must not resolve'),
      (rejection) => rejection,
    );
    assert.equal(error.code, 'TN_NATIVE_BINARY_UNPUBLISHED');
    assert.match(error.message, /no threenative-engine-player-linux-x64 is published/u);
  } finally {
    await fixture.close();
  }
});
