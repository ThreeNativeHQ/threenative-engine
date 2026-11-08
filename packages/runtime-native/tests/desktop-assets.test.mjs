import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { deriveAndroidWebpSupport, deriveDesktopWebpSupport, probePrebuiltDecoders } from '../scripts/asset-preflight.mjs';
import { packageDesktop, stageDesktopFiles } from '../scripts/package-desktop.mjs';
import { minimalGlb } from './fixtures/minimal-glb.mjs';

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url));
/** An Ogg page carrying Opus: the magic number of a container the runtime reads, the codec of one it does not. */
function opusBytes() {
  const bytes = Buffer.alloc(64);
  bytes.write('OggS', 0, 'ascii');
  bytes.write('OpusHead', 28, 'ascii');
  return bytes;
}

function webpGlb() {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, images: [{ mimeType: 'image/webp' }] }),
    'utf8',
  );
  const padded = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + padded.length, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(padded.length, 0);
  chunkHeader.write('JSON', 4, 'ascii');
  return Buffer.concat([header, chunkHeader, padded]);
}

test('desktop public assets are staged at web-root paths', () => {
  const root = makeTempDirSync('threenative-desktop-assets-');
  try {
    const bundle = join(root, 'bundle.js');
    const assets = join(root, 'public');
    const staging = join(root, 'staging');
    const model = minimalGlb();
    mkdirSync(join(assets, 'models'), { recursive: true });
    writeFileSync(bundle, 'export default 1;');
    writeFileSync(join(assets, 'native-proof.png'), 'png');
    writeFileSync(join(assets, 'models', 'native-proof.glb'), model);

    const entry = stageDesktopFiles(bundle, assets, staging);

    assert.equal(entry, join(staging, '.threenative', 'game.js'));
    assert.equal(readFileSync(join(staging, 'native-proof.png'), 'utf8'), 'png');
    assert.deepEqual(readFileSync(join(staging, 'models', 'native-proof.glb')), model);
    assert.equal(readFileSync(entry, 'utf8'), 'export default 1;');
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('desktop staging rejects the reserved internal asset path', () => {
  const root = makeTempDirSync('threenative-desktop-assets-');
  try {
    const bundle = join(root, 'bundle.js');
    const assets = join(root, 'public');
    mkdirSync(join(assets, '.threenative'), { recursive: true });
    writeFileSync(bundle, 'export default 1;');
    assert.throws(
      () => stageDesktopFiles(bundle, assets, join(root, 'staging')),
      /TN_NATIVE_ASSET_RESERVED_PATH/,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('desktop staging embeds the resolved window contract for the native host', () => {
  const root = makeTempDirSync('threenative-desktop-config-');
  try {
    const bundle = join(root, 'bundle.js');
    const staging = join(root, 'staging');
    const config = {
      app: { id: 'com.studio.foxgame', name: 'Fox', version: '1.2.3', build: 7 },
      display: { orientation: 'landscape', fullscreen: true, keepScreenOn: false, maxFps: 120 },
      window: { title: 'Fox Desktop', width: 1024, height: 576, maximized: true, resizable: false },
    };
    writeFileSync(bundle, 'export default 1;');

    stageDesktopFiles(bundle, undefined, staging, config);

    // `uiRenderer` is flattened out of `ui.renderer` by the packager because `renderer` already
    // means the WebGPU preference at the top level, and the host reads this file with a scanner
    // that would find the wrong one. A game that states nothing gets the native renderer.
    assert.deepEqual(
      JSON.parse(readFileSync(join(staging, '.threenative', 'config.json'), 'utf8')),
      { ...config, maxFps: 120, uiRenderer: 'native' },
    );
    const web = join(root, 'staging-web');
    stageDesktopFiles(bundle, undefined, web, { ...config, ui: { renderer: 'web' } });
    assert.equal(
      JSON.parse(readFileSync(join(web, '.threenative', 'config.json'), 'utf8')).uiRenderer,
      'web',
    );
    // That the host reads these keys (title, size, resizable, uiRenderer) is proved by launching the
    // packaged binary in `tests/host-window.test.mjs`.
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('desktop staging carries the resolved brand icon into the embedded bundle', () => {
  const root = makeTempDirSync('threenative-desktop-brand-');
  try {
    const bundle = join(root, 'bundle.js');
    const icon = join(root, 'icon.png');
    const staging = join(root, 'staging');
    const config = {
      app: {
        id: 'com.studio.foxgame',
        name: 'Fox',
        version: '1.2.3',
        build: 7,
        icon,
      },
    };
    writeFileSync(bundle, 'export default 1;');
    writeFileSync(icon, 'brand-icon');

    stageDesktopFiles(bundle, undefined, staging, config);

    assert.equal(readFileSync(join(staging, '.threenative', 'app-icon.png'), 'utf8'), 'brand-icon');
    assert.deepEqual(
      JSON.parse(readFileSync(join(staging, '.threenative', 'config.json'), 'utf8')).app,
      { id: 'com.studio.foxgame', name: 'Fox', version: '1.2.3', build: 7, icon: '.threenative/app-icon.png' },
    );
    // The window shows this icon: `tests/host-window.test.mjs`.
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

// Escaped JSON window titles reach the window: `tests/host-window.test.mjs` packages the title
// `Fox "Deluxe"` and reads it back from the X server.

test('desktop staging refuses audio no native target decodes, at package time', () => {
  // Desktop ran no preflight at all: only `package-android.mjs` did. So the same file that failed
  // an APK shipped in a desktop binary and failed at `decodeAudioData` after launch instead — the
  // packager having already opened and copied the bytes on its way past.
  const root = makeTempDirSync('threenative-desktop-audio-gate-');
  try {
    const bundle = join(root, 'bundle.js');
    const assets = join(root, 'public');
    mkdirSync(join(assets, 'audio'), { recursive: true });
    writeFileSync(bundle, 'export default 1;');
    writeFileSync(join(assets, 'audio', 'voice.ogg'), opusBytes());
    assert.throws(
      () => stageDesktopFiles(bundle, assets, join(root, 'staging'), undefined, runtimeRoot),
      (error) => {
        assert.match(error.message, /cannot be decoded by the desktop target/u);
        assert.match(error.message, /is Ogg Opus; no native target decodes this container/u);
        return true;
      },
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('desktop staging packages a genuine Ogg Vorbis file, because the runtime decodes it', () => {
  const root = makeTempDirSync('threenative-desktop-audio-pass-');
  try {
    const bundle = join(root, 'bundle.js');
    const assets = join(root, 'public');
    mkdirSync(join(assets, 'audio'), { recursive: true });
    writeFileSync(bundle, 'export default 1;');
    const fixture = readFileSync(join(runtimeRoot, 'tests', 'fixtures', 'pickup.ogg'));
    writeFileSync(join(assets, 'audio', 'pickup.ogg'), fixture);
    const staging = join(root, 'staging');
    stageDesktopFiles(bundle, assets, staging, undefined, runtimeRoot);
    assert.deepEqual(readFileSync(join(staging, 'audio', 'pickup.ogg')), fixture);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('desktop packaging uses THREENATIVE_RUNTIME_SOURCE for decoder preflight', () => {
  const root = makeTempDirSync('threenative-desktop-runtime-source-');
  try {
    const runtime = join(root, 'runtime');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'CMakeLists.txt'), '# desktop preflight fixture\n');

    const bundle = join(root, 'game.js');
    const assets = join(root, 'public');
    const output = join(root, 'game');
    const runtimeExecutable = join(root, 'fake-runtime.mjs');
    mkdirSync(join(assets, 'models'), { recursive: true });
    writeFileSync(bundle, 'export default 1;\n');
    writeFileSync(join(assets, 'models', 'webp.glb'), webpGlb());
    writeFileSync(
      runtimeExecutable,
      '#!/usr/bin/env node\nimport { writeFileSync } from "node:fs";\n' +
        'const index = process.argv.indexOf("--out");\n' +
        'if (index >= 0) writeFileSync(process.argv[index + 1], "desktop artifact");\n',
    );
    chmodSync(runtimeExecutable, 0o755);

    const previous = process.env.THREENATIVE_RUNTIME_SOURCE;
    process.env.THREENATIVE_RUNTIME_SOURCE = runtime;
    try {
      assert.throws(
        () => packageDesktop({ bundle, assets, output, runtime: runtimeExecutable }),
        /TN_NATIVE_ASSET_UNSUPPORTED/u,
      );
    } finally {
      if (previous === undefined) delete process.env.THREENATIVE_RUNTIME_SOURCE;
      else process.env.THREENATIVE_RUNTIME_SOURCE = previous;
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

/**
 * An installed release has no CMakeLists.txt, so the derivations cannot read the build. Before
 * this probe existed the answer was a flat "unsupported", which rejected the WebP-packed GLBs the
 * documented `gltf-transform webp` pipeline produces — from a runtime that decodes them fine.
 */
test('a prebuilt release is asked what it decodes instead of being assumed decoder-less', () => {
  const root = makeTempDirSync('tn-prebuilt-probe');
  const executable = join(root, 'prebuilt', 'linux-x64', 'threenative-runtime');
  mkdirSync(join(root, 'prebuilt', 'linux-x64'), { recursive: true });
  writeFileSync(executable, '');
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ args, command });
    return { status: 0, stdout: 'TN_DECODERS:{"webp":true}\n' };
  };
  const probed = probePrebuiltDecoders(root, { spawn });
  assert.equal(probed?.webp, true);
  assert.equal(calls[0].command, executable);
  // A probe must never need a display: it is a question about the binary, not about X.
  assert.ok(calls[0].args.includes('--no-sdl'));
  rmSync(root, { force: true, recursive: true });
});

test('a prebuilt release that answers NO is still refused, with the binary named', () => {
  const root = makeTempDirSync('tn-prebuilt-probe-no');
  mkdirSync(join(root, 'prebuilt', 'linux-x64'), { recursive: true });
  writeFileSync(join(root, 'prebuilt', 'linux-x64', 'threenative-runtime'), '');
  const spawn = () => ({ status: 0, stdout: 'TN_DECODERS:{"webp":false}\n' });
  assert.equal(probePrebuiltDecoders(root, { spawn })?.webp, false);
  rmSync(root, { force: true, recursive: true });
});

/** A probe that cannot run must never *grant* support: the caller keeps its refusal. */
test('an unprobeable runtime root yields no answer at all', () => {
  const root = makeTempDirSync('tn-prebuilt-probe-missing');
  assert.equal(probePrebuiltDecoders(root), undefined);
  const withBinary = makeTempDirSync('tn-prebuilt-probe-silent');
  mkdirSync(join(withBinary, 'prebuilt', 'linux-x64'), { recursive: true });
  writeFileSync(join(withBinary, 'prebuilt', 'linux-x64', 'threenative-runtime'), '');
  assert.equal(probePrebuiltDecoders(withBinary, { spawn: () => ({ status: 1, stdout: '' }) }), undefined);
  rmSync(root, { force: true, recursive: true });
  rmSync(withBinary, { force: true, recursive: true });
});

/**
 * A source checkout says what CMake *could* build; the selected runtime says what it *did*. Those
 * disagree after `download-deps.mjs --only webp` lands libwebp beside a binary that was compiled
 * before it — a normal sequence — and reading the directory then grants WebP for a runtime without
 * MYSTRAL_HAS_WEBP, moving a build-time refusal to a texture that fails in front of the player.
 *
 * These are real spawns of a real executable, not an injected `spawn`: they are also the only
 * check that a binary answering `TN_DECODERS` on stdout is parsed the way the probe expects.
 */
test.skipIf(process.platform === 'win32')('the selected runtime outranks the source tree, in both directions', () => {
  const checkout = makeTempDirSync('tn-desktop-webp-authority-');
  writeFileSync(join(checkout, 'CMakeLists.txt'), 'project(mystral)\n');
  const answering = (webp) => {
    const executable = join(makeTempDirSync('tn-desktop-webp-runtime-'), 'threenative-runtime');
    writeFileSync(executable, `#!/bin/sh\necho 'TN_DECODERS:{"webp":${webp}}'\n`);
    chmodSync(executable, 0o755);
    return executable;
  };

  // A checkout CMake would define MYSTRAL_HAS_WEBP from, and a binary that was built before it.
  const prebuilt = join(checkout, 'third_party', 'webp', 'libwebp-1.5.0');
  mkdirSync(join(prebuilt, 'include'), { recursive: true });
  mkdirSync(join(prebuilt, 'lib'), { recursive: true });
  writeFileSync(join(prebuilt, 'lib', 'libwebp.a'), '');
  assert.equal(deriveDesktopWebpSupport(checkout).supported, true, 'the fixture must be a green source tree');
  const refused = deriveDesktopWebpSupport(checkout, answering('false'));
  assert.equal(refused.supported, false, 'the binary that will decode the texture has the last word');
  assert.match(refused.reason, /answers the @loaders\.gl WebP decode test with NO/u);

  // And the other way: a binary with libwebp is not refused because the sources were cleaned.
  rmSync(join(checkout, 'third_party'), { force: true, recursive: true });
  assert.equal(deriveDesktopWebpSupport(checkout).supported, false, 'the fixture must be a red source tree');
  assert.equal(deriveDesktopWebpSupport(checkout, answering('true')).supported, true);

  // A selected runtime that cannot answer fails closed. Falling back to the source tree here would
  // grant support from files this binary may never have been compiled against.
  const silent = deriveDesktopWebpSupport(checkout, join(checkout, 'no-such-runtime'));
  assert.equal(silent.supported, false);
  assert.match(silent.reason, /could not answer the @loaders\.gl WebP decode test/u);
  rmSync(checkout, { force: true, recursive: true });
});

/** The only prebuilt this host can execute, and the only one whose answer applies to it. */
const hostKey = `${process.platform}-${process.arch}`;

/** An installed release carrying a runtime for `key`, with no source checkout to derive from. */
function makeInstalledRelease(prefix, key = hostKey, name = process.platform === 'win32' ? 'threenative-runtime.exe' : 'threenative-runtime') {
  const root = makeTempDirSync(prefix);
  mkdirSync(join(root, 'prebuilt', key), { recursive: true });
  const executable = join(root, 'prebuilt', key, name);
  writeFileSync(executable, '');
  return { executable, root };
}

test('a prebuilt release is asked what it decodes instead of being assumed decoder-less', () => {
  const { executable, root } = makeInstalledRelease('tn-prebuilt-probe');
  const calls = [];
  const spawn = (command, args) => {
    calls.push({ args, command });
    return { status: 0, stdout: 'TN_DECODERS:{"webp":true}\n' };
  };
  const probed = probePrebuiltDecoders(root, { spawn });
  assert.equal(probed?.webp, true);
  assert.equal(calls[0].command, executable);
  // A probe must never need a display: it is a question about the binary, not about X.
  assert.ok(calls[0].args.includes('--no-sdl'));
  // The probe script is a temporary file. One leaked directory per build fills a packaging host's
  // temp over a session, and the first version leaked one on every call.
  assert.equal(existsSync(dirname(calls[0].args[1])), false);
  rmSync(root, { force: true, recursive: true });
});

test('a prebuilt release that answers NO is still refused, with the binary named', () => {
  const { root } = makeInstalledRelease('tn-prebuilt-probe-no');
  const spawn = () => ({ status: 0, stdout: 'TN_DECODERS:{"webp":false}\n' });
  assert.equal(probePrebuiltDecoders(root, { spawn })?.webp, false);
  rmSync(root, { force: true, recursive: true });
});

/** A probe that cannot run must never *grant* support: the caller keeps its refusal. */
test('an unprobeable runtime root yields no answer at all', () => {
  const root = makeTempDirSync('tn-prebuilt-probe-missing');
  assert.equal(probePrebuiltDecoders(root), undefined);
  const silent = makeInstalledRelease('tn-prebuilt-probe-silent');
  assert.equal(probePrebuiltDecoders(silent.root, { spawn: () => ({ status: 1, stdout: '' }) }), undefined);
  // A run that crashed after printing is not a verdict: the binary that exits non-zero has not
  // answered the question, and reading its line anyway grants support from a broken probe.
  const crashed = makeInstalledRelease('tn-prebuilt-probe-crashed');
  assert.equal(
    probePrebuiltDecoders(crashed.root, {
      spawn: () => ({ status: 139, stdout: 'TN_DECODERS:{"webp":true}\n' }),
    }),
    undefined,
  );
  // And a spawn that never started answers nothing either, whatever it left on stdout.
  const unstartable = makeInstalledRelease('tn-prebuilt-probe-enoent');
  assert.equal(
    probePrebuiltDecoders(unstartable.root, {
      spawn: () => ({ error: new Error('spawnSync ENOENT'), status: null, stdout: 'TN_DECODERS:{"webp":true}\n' }),
    }),
    undefined,
  );
  for (const directory of [root, silent.root, crashed.root, unstartable.root]) {
    rmSync(directory, { force: true, recursive: true });
  }
});

/**
 * An installed release can carry several prebuilt keys at once. Picking whichever directory the
 * filesystem listed first asked a Windows or Android payload a question only the host binary can
 * answer — and on a non-host key the spawn fails, which the caller reads as "no WebP" and refuses
 * assets the real runtime decodes.
 */
test('only the host prebuilt is probed; a foreign-platform payload answers nothing', () => {
  const foreign = hostKey === 'win32-x64' ? 'linux-x64' : 'win32-x64';
  const { root } = makeInstalledRelease('tn-prebuilt-probe-foreign', foreign, 'threenative-runtime.exe');
  let spawned = 0;
  const spawn = () => {
    spawned += 1;
    return { status: 0, stdout: 'TN_DECODERS:{"webp":true}\n' };
  };
  assert.equal(probePrebuiltDecoders(root, { spawn }), undefined);
  assert.equal(spawned, 0, 'a foreign-platform binary must not be executed at all');
  rmSync(root, { force: true, recursive: true });
});

/** An installed release with its host executable present, for the decoder-guard tests below. */
function probeFixture(key = `${process.platform}-${process.arch}`) {
  const root = makeTempDirSync('tn-decoder-guard-');
  const executable = join(root, 'prebuilt', key, process.platform === 'win32' ? 'threenative-runtime.exe' : 'threenative-runtime');
  mkdirSync(dirname(executable), { recursive: true });
  writeFileSync(executable, 'probe fixture');
  return { root, executable };
}

const yes = { status: 0, stdout: 'TN_DECODERS:{"webp":true}\n' };
for (const [name, outcome, expected] of [
  ['successful yes', yes, true],
  ['native console receipt', { status: 0, stdout: '[log] TN_DECODERS:{"webp":true}\n' }, true],
  ['successful no', { status: 0, stdout: 'TN_DECODERS:{"webp":false}\n' }, false],
  ['nonzero exit with stale positive output', { ...yes, status: 1 }, undefined],
  ['signal with stale positive output', { ...yes, status: null, signal: 'SIGTERM' }, undefined],
  ['timeout with stale positive output', { ...yes, error: new Error('ETIMEDOUT') }, undefined],
  ['duplicate receipts', { status: 0, stdout: yes.stdout.repeat(2) }, undefined],
  ['nonboolean capability', { status: 0, stdout: 'TN_DECODERS:{"webp":"true"}\n' }, undefined],
  ['absent capability', { status: 0, stdout: 'TN_DECODERS:{}\n' }, undefined],
  ['unexpected capability', { status: 0, stdout: 'TN_DECODERS:{"webp":true,"extra":1}\n' }, undefined],
  ['malformed JSON', { status: 0, stdout: 'TN_DECODERS:{bad}\n' }, undefined],
  ['embedded diagnostic, not a receipt', { status: 0, stdout: 'error quoting TN_DECODERS:{"webp":true}\n' }, undefined],
  ['exception', null, undefined],
]) {
  test(`decoder probe fails closed and cleans temporary files: ${name}`, () => {
    const { root } = probeFixture();
    let directory;
    try {
      const result = probePrebuiltDecoders(root, { spawn: (_command, args, options) => {
        directory = dirname(args[1]);
        assert.equal(existsSync(args[1]), true);
        assert.equal(options.env.DISPLAY, undefined);
        assert.equal(options.env.WAYLAND_DISPLAY, undefined);
        if (outcome === null) throw new Error('fixture spawn failure');
        return outcome;
      } });
      assert.equal(result?.webp, expected);
      assert.ok(directory, 'actually execute the probe');
      assert.equal(existsSync(directory), false, 'the probe owns cleanup on every exit');
    } finally {
      if (directory) rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('decoder probing chooses only the installed host platform, never a neighbouring target', () => {
  const { root, executable } = probeFixture();
  const foreign = join(root, 'prebuilt', 'aaa-foreign', process.platform === 'win32' ? 'threenative-runtime.exe' : 'threenative-runtime');
  mkdirSync(dirname(foreign), { recursive: true }); writeFileSync(foreign, 'foreign');
  const calls = [];
  assert.equal(probePrebuiltDecoders(root, { spawn: (command) => { calls.push(command); return yes; } })?.webp, true);
  assert.deepEqual(calls, [executable]);
  rmSync(executable);
  calls.length = 0;
  assert.equal(probePrebuiltDecoders(root, { spawn: (command) => { calls.push(command); return yes; } }), undefined);
  assert.equal(calls.length, 0, 'foreign executables cannot establish host support');
});

test('Android cannot inherit the desktop decoder answer from an installed package', () => {
  const { root } = probeFixture();
  assert.equal(probePrebuiltDecoders(root, { spawn: () => yes })?.webp, true);
  assert.equal(deriveAndroidWebpSupport(root).supported, false);
});

test('a failed decoder probe can recover and a replaced executable cannot reuse a stale positive', () => {
  const { root, executable } = probeFixture();
  assert.equal(probePrebuiltDecoders(root, { spawn: () => ({ status: 1 }) }), undefined);
  assert.equal(probePrebuiltDecoders(root, { spawn: () => yes })?.webp, true);
  writeFileSync(executable, 'replacement without the decoder');
  assert.equal(probePrebuiltDecoders(root, { spawn: () => ({ status: 0, stdout: 'TN_DECODERS:{"webp":false}\n' }) })?.webp, false);
});
