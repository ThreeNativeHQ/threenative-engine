import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { inspectContainerBrand } from '../scripts/inspect-container-brand.mjs';
import {
  assertContainerIdentity,
  classifyDependencies,
  CONTAINER_MANIFEST,
  containerMetadata,
  extractContainer,
  packageDesktopContainer,
  pngToIco,
  parseLinkedLibraries,
  resolveContainer,
} from '../scripts/desktop-distribution.mjs';

const defaultConfig = { app: { id: 'com.example.orbit', name: 'Orbit Game', version: '1.2.3', build: 7 } };
const config = defaultConfig;
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** A stand-in for the runtime's `game.bundle`: the real format is proven by the C++ bundle tests. */
function authoredBundle() {
  return Buffer.from('MYSBNDL1 fixture game payload');
}

/** The smallest byte sequence `pngToIco` accepts: signature, IHDR tag, and a 256x256 size. */
function authoredPng() {
  const png = Buffer.alloc(40);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(0x0d0a1a0a, 4);
  png.writeUInt32BE(13, 8);
  png.writeUInt32BE(0x49484452, 12);
  png.writeUInt32BE(256, 16);
  png.writeUInt32BE(256, 20);
  return png;
}

// Exercise the real staging and resolver. Only OS resource tools/archive transport are replaced;
// these unit cases do not claim a Windows/macOS native launch or signing proof.
function fixture(platform = 'linux', { icon = false, convertIcon = false, config = defaultConfig, uiRenderer = 'web' } = {}) {
  const directory = makeTempDirSync('threenative-container-regression-');
  const executable = join(directory, 'input');
  const captured = join(directory, 'relocated container');
  const uiDirectory = join(directory, 'ui');
  // A Windows game authors a .png or a .ico; an .icns there is not a thing. Give each platform the
  // icon a real project would hand it, so the conversion each one performs is actually exercised.
  const iconPath = join(directory, platform === 'win32' || convertIcon ? 'icon.png' : 'icon.icns');
  const dependency = join(directory, 'dependency');
  const bundle = join(directory, 'game.bundle');
  writeFileSync(executable, 'original executable');
  writeFileSync(iconPath, iconPath.endsWith('.png') ? authoredPng() : Buffer.from('authored icon'));
  writeFileSync(dependency, 'native dependency');
  writeFileSync(bundle, authoredBundle());
  mkdirSync(uiDirectory);
  writeFileSync(join(uiDirectory, 'index.html'), '<main>HUD</main>');
  writeFileSync(join(uiDirectory, 'index-abc123.css'), '.hud{color:#fff}');
  const invocations = [];
  const run = (command, args, options) => {
    // Capture the icon bytes at call time: packaging deletes its temporary .ico once rcedit
    // succeeds, so reading the path afterwards proves nothing about what rcedit was handed.
    const iconIndex = args.indexOf('--set-icon');
    invocations.push({
      args,
      command,
      ...(iconIndex >= 0 && existsSync(args[iconIndex + 1])
        ? { iconBytes: readFileSync(args[iconIndex + 1]) }
        : {}),
    });
    if (command === 'rcedit') writeFileSync(args[0], 'executable with PE resources');
    else if (command === 'sips') writeFileSync(args.at(-1), 'resized icon');
    else if (command === 'iconutil') writeFileSync(args.at(-1), 'converted icns');
    else if (command === 'powershell.exe') writeFileSync(options.env.TN_WEBVIEW_BOOTSTRAPPER_OUTPUT, 'MZ bootstrapper fixture');
    else if (command === 'makensis') {
      const script = readFileSync(args.at(-1), 'utf8');
      invocations.at(-1).script = script;
      const output = /^OutFile "([^"]+)"$/mu.exec(script)?.[1];
      assert.ok(output);
      writeFileSync(output, 'MZ installer fixture');
    }
    else {
      assert.ok(command === 'tar' || command === 'zip', `unexpected tool: ${command}`);
      const staging = command === 'tar' ? args[args.indexOf('-C') + 1] : options.cwd;
      cpSync(join(staging, args.at(-1)), captured, { recursive: true });
      writeFileSync(command === 'tar' ? args[1] : args[2], 'archive bytes');
    }
    return { status: 0, stdout: '', stderr: '' };
  };
  const packed = packageDesktopContainer({
    platform, arch: 'x64', bundle, executable, config, uiDirectory, uiRenderer,
    dependencies: [{ name: 'sidecar.bin', source: dependency }],
    ...(icon ? { icon: iconPath } : {}), output: join(directory, 'game'), run,
  });
  const manifestPath = join(captured, platform === 'darwin' ? 'Contents/Resources' : '', CONTAINER_MANIFEST);
  return { ...packed, root: captured, directory, invocations, manifestPath, icon: iconPath };
}

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: records the final executable in the integrity manifest without an icon`, () => {
    const { root, manifest } = fixture(platform);
    assert.equal(manifest.resources[manifest.executable]?.sha256, digest(join(root, manifest.executable)));
    assert.deepEqual(resolveContainer(root, { platform }), manifest);
  });
  test(`${platform}: refuses a missing executable after relocation`, () => {
    const { root, manifest } = fixture(platform);
    rmSync(join(root, manifest.executable));
    assert.throws(() => resolveContainer(root, { platform }), /TN_DESKTOP_CONTAINER_INCOMPLETE/);
  });
  test(`${platform}: refuses executable bytes changed after packaging`, () => {
    const { root, manifest } = fixture(platform);
    writeFileSync(join(root, manifest.executable), 'tampered');
    assert.throws(() => resolveContainer(root, { platform }), /TN_DESKTOP_CONTAINER_TAMPERED/);
  });
}

test('Windows hashes the executable after PE resource editing', () => {
  const { root, manifest } = fixture('win32', { icon: true });
  assert.equal(readFileSync(join(root, manifest.executable), 'utf8'), 'executable with PE resources');
  assert.equal(manifest.resources[manifest.executable].sha256, digest(join(root, manifest.executable)));
  assert.deepEqual(resolveContainer(root, { platform: 'win32' }), manifest);
});

test('Windows release also produces a standard installer beside its portable ZIP', () => {
  const packed = fixture('win32');
  assert.equal(packed.installer, join(packed.directory, 'game-setup.exe'));
  assert.ok(existsSync(packed.installer));
  assert.ok(existsSync(packed.archive));
});

test('macOS stages Info.plist at the application bundle root, not under Resources', () => {
  const { root, manifest } = fixture('darwin', { icon: true });
  assert.ok(existsSync(join(root, 'Contents/Info.plist')));
  assert.ok(manifest.resources['Contents/Info.plist']);
  assert.equal(existsSync(join(root, 'Contents/Resources/Contents/Info.plist')), false);
});

for (const platform of ['linux', 'darwin', 'win32']) {
  test(`${platform}: the game survives resource editing because it travels beside the executable`, () => {
    // The defect this replaces: the game was appended to the end of the executable, and rcedit
    // rewrote the PE to embed the icon, dropping everything past the end of the image. The loader
    // looks for its footer at physical EOF, found nothing, and the container launched the bare
    // runtime CLI. Signing would have done the same thing on Windows and macOS.
    const { root, manifest } = fixture(platform, { icon: true });
    const expected = platform === 'darwin' ? 'Contents/Resources/game.bundle' : 'game.bundle';
    assert.equal(manifest.bundle, expected, 'staged where this platform\'s loader searches');
    assert.ok(manifest.resources[expected], 'the game carries an integrity record');
    // rcedit really did rewrite the staged executable in the win32 fixture, and the game is intact.
    assert.deepEqual(readFileSync(join(root, expected)), authoredBundle());
    assert.equal(manifest.resources[expected].sha256, digest(join(root, expected)));
    assert.deepEqual(resolveContainer(root, { platform }), manifest);
  });

  test(`${platform}: a container whose game file is missing is refused`, () => {
    const { root, manifest } = fixture(platform, { icon: true });
    rmSync(join(root, manifest.bundle));
    assert.throws(() => resolveContainer(root, { platform }), /TN_DESKTOP_CONTAINER_INCOMPLETE/u);
  });

  test(`${platform}: a container that keeps the game but drops its record is refused`, () => {
    // A separate container, so this proves the present-file/absent-record pair is refused on its
    // own rather than riding on the deletion above.
    const { root, manifest, manifestPath } = fixture(platform, { icon: true });
    assert.ok(existsSync(join(root, manifest.bundle)), 'the game file is still present');
    const { bundle: _dropped, ...withoutBundle } = manifest;
    writeFileSync(manifestPath, JSON.stringify(withoutBundle));
    assert.throws(() => resolveContainer(root, { platform }), /TN_DESKTOP_CONTAINER_MANIFEST_INVALID/u);
  });
}

test('Windows packaging hands rcedit an .ico, never the authored PNG', () => {
  // The guard the original defect needed: pngToIco being correct is no use if the packager still
  // passes the .png straight through, which is what made rcedit exit 1 and refuse every Windows
  // release container that declared an app.icon.
  const { invocations } = fixture('win32', { icon: true });
  const rcedit = invocations.find((invocation) => invocation.command === 'rcedit');
  assert.ok(rcedit, 'rcedit runs when an icon is configured');
  const iconArgument = rcedit.args[rcedit.args.indexOf('--set-icon') + 1];
  assert.ok(iconArgument.toLowerCase().endsWith('.ico'), `--set-icon got ${iconArgument}`);
  assert.ok(rcedit.iconBytes, 'the icon existed when rcedit was invoked');
  assert.equal(rcedit.iconBytes.readUInt16LE(2), 1, 'and it is a real icon file');
});

test('the Windows icon is a real .ico, because rcedit refuses a bare PNG', () => {
  // rcedit --set-icon parses the file as a Windows icon. Handing it the authored PNG exits 1 and
  // refuses the container, which is what every Windows release with an app.icon did.
  const directory = makeTempDirSync('threenative-ico-');
  const png = join(directory, 'icon.png');
  const pixels = authoredPng();
  writeFileSync(png, pixels);
  const ico = join(directory, 'icon.ico');
  pngToIco(png, ico);
  const written = readFileSync(ico);
  assert.equal(written.readUInt16LE(0), 0, 'reserved');
  assert.equal(written.readUInt16LE(2), 1, 'type is icon');
  assert.equal(written.readUInt16LE(4), 1, 'one image');
  assert.equal(written.readUInt8(6), 0, '256 is encoded as 0');
  assert.equal(written.readUInt8(7), 0, '256 is encoded as 0');
  assert.equal(written.readUInt32LE(14), pixels.length, 'declares the PNG payload size');
  assert.equal(written.readUInt32LE(18), 22, 'payload starts after the 22-byte header');
  assert.deepEqual(written.subarray(22), pixels, 'carries the PNG bytes verbatim');
  assert.throws(() => pngToIco(join(directory, 'icon.ico'), join(directory, 'nope.ico')), /TN_DESKTOP_RESOURCE_FAILED/u);
});

test('Windows API set contracts are prerequisites, not libraries to copy', () => {
  // api-ms-win-* and ext-ms-win-* are API Set contract names the Windows loader redirects to a real
  // implementation. They are never files on disk, so a hardcoded allowlist of real DLL names can
  // never cover them, and dumpbin reports them for any binary linked against the UCRT.
  const directory = makeTempDirSync('threenative-apiset-');
  const support = join(directory, 'game-support.dll');
  writeFileSync(support, 'a real game dependency');
  const libraries = [
    { name: 'api-ms-win-core-synch-l1-2-0.dll' },
    { name: 'ext-ms-win-ntuser-window-l1-1-0.dll' },
    { name: 'KERNEL32.dll' },
    { name: 'game-support.dll', path: support },
  ];
  const { bundled, prerequisites } = classifyDependencies(libraries, { platform: 'win32' });
  assert.deepEqual(prerequisites.map((library) => library.name).sort(), [
    'KERNEL32.dll', 'api-ms-win-core-synch-l1-2-0.dll', 'ext-ms-win-ntuser-window-l1-1-0.dll',
  ].sort());
  assert.deepEqual(bundled.map((library) => library.name), ['game-support.dll']);
});

test('a Windows DLL the system directory provides is a prerequisite, not a refusal', () => {
  // dumpbin prints names with no paths, so before this the only Windows DLL that could pass was one
  // of 24 hardcoded names: VCRUNTIME140.dll and every other redistributable refused the container.
  // Ask the directory the loader searches instead of enumerating what Microsoft ships.
  const systemRoot = makeTempDirSync('threenative-systemroot-');
  mkdirSync(join(systemRoot, 'System32'));
  writeFileSync(join(systemRoot, 'System32', 'VCRUNTIME140.dll'), 'a redistributable');
  const libraries = [{ name: 'VCRUNTIME140.dll' }, { name: 'game-physics.dll' }];
  const { prerequisites } = classifyDependencies([libraries[0]], { platform: 'win32', systemRoot });
  assert.deepEqual(prerequisites, [{ name: 'VCRUNTIME140.dll' }]);
  // Still fails closed for a DLL the system does not provide and that has no path to copy.
  assert.throws(
    () => classifyDependencies([libraries[1]], { platform: 'win32', systemRoot }),
    /TN_DESKTOP_DEPENDENCY_UNLOCATABLE/u,
  );
});

test('a Windows dependency that is neither a system library nor locatable is still refused', () => {
  assert.throws(
    () => classifyDependencies([{ name: 'game-physics.dll' }], { platform: 'win32' }),
    /TN_DESKTOP_DEPENDENCY_UNLOCATABLE/u,
  );
});

test('macOS stages the web UI where the runtime resolves it, under Contents/Resources', () => {
  // SDL_GetBasePath() returns <App>.app/Contents/Resources/ for a bundled macOS app, and
  // src/cli/main.cpp resolves a relative ui root against it. Staging the UI beside the executable
  // in Contents/MacOS instead leaves the release container launching with no HUD at all, which no
  // fixture caught because nothing asserted the bundle location.
  const { root, manifest } = fixture('darwin', { icon: true });
  assert.ok(existsSync(join(root, 'Contents/Resources/ui/index.html')));
  assert.equal(manifest.ui.directory, 'Contents/Resources/ui');
  assert.equal(manifest.ui.entry, 'Contents/Resources/ui/index.html');
  assert.ok(manifest.resources['Contents/Resources/ui/index.html']);
  assert.equal(existsSync(join(root, 'Contents/MacOS/ui')), false);
});

// The CSS renderer stages stylesheets and no page. The manifest still has to name one entry it
// hashed, or `resolveContainer` would report a native-css container as incomplete.
test('a native-css container stages its stylesheets and names one as the entry', () => {
  const { root, manifest } = fixture('linux', { uiRenderer: 'native-css' });
  assert.ok(existsSync(join(root, 'ui/index-abc123.css')));
  assert.equal(manifest.ui.directory, 'ui');
  assert.equal(manifest.ui.entry, 'ui/index-abc123.css');
  assert.deepEqual(resolveContainer(root, { platform: 'linux' }), manifest);
});

test('a native-css container with no stylesheet is refused before anything is staged', () => {
  const directory = makeTempDirSync('threenative-container-css-missing-');
  const executable = join(directory, 'input');
  const uiDirectory = join(directory, 'ui');
  writeFileSync(executable, 'executable');
  mkdirSync(uiDirectory);
  writeFileSync(join(uiDirectory, 'index.html'), '<main>HUD</main>');
  assert.throws(() => packageDesktopContainer({
    platform: 'linux', arch: 'x64',
    bundle: join(directory, 'game.bundle'), executable, uiDirectory, uiRenderer: 'native-css',
    output: join(directory, 'game'),
  }), /TN_UI_BUNDLE_MISSING/u);
});

test('macOS plist names the icon that was actually staged', () => {
  const { manifest } = fixture('darwin', { icon: true });
  const plist = containerMetadata({ platform: 'darwin', config })['Contents/Info.plist'];
  const iconName = /<key>CFBundleIconFile<\/key><string>(.*?)<\/string>/u.exec(plist)?.[1];
  assert.equal(`${iconName}.icns`, basename(manifest.app.icon));
});

test('macOS metadata escapes XML text from authored application identity', () => {
  const plist = containerMetadata({
    platform: 'darwin', config: { app: { ...config.app, name: 'R&D <Orbit>' } },
  })['Contents/Info.plist'];
  assert.match(plist, /<key>CFBundleName<\/key><string>R&amp;D &lt;Orbit&gt;<\/string>/u);
  assert.match(plist, /<key>CFBundleDisplayName<\/key><string>R&amp;D &lt;Orbit&gt;<\/string>/u);
});

test('macOS conversion preserves authored icon identity and separately hashes the converted payload', () => {
  const { root, manifest, icon } = fixture('darwin', { icon: true, convertIcon: true });
  assert.notEqual(digest(icon), digest(join(root, manifest.app.icon)));
  assert.equal(manifest.resources[manifest.app.icon].sha256, digest(join(root, manifest.app.icon)));
  assert.equal(assertContainerIdentity(manifest, config, { icon }), manifest);
});

test('Linux dependency inspection retains resolved paths containing spaces', () => {
  assert.deepEqual(parseLinkedLibraries('  libgame.so => /tmp/My Game/libgame.so (0x00001234)\n', 'linux'), [
    { name: 'libgame.so', path: '/tmp/My Game/libgame.so' },
  ]);
});

test('macOS dependency inspection retains install names containing spaces', () => {
  assert.deepEqual(parseLinkedLibraries('game:\n  /tmp/My Game/libgame.dylib (compatibility version 1.0.0, current version 1.0.0)\n', 'darwin'), [
    { name: 'libgame.dylib', path: '/tmp/My Game/libgame.dylib' },
  ]);
});

for (const [name, mutate] of [
  ['empty manifest', () => ({})],
  ['null manifest', () => null],
  ['unsupported schema', (manifest) => ({ ...manifest, schemaVersion: 99 })],
  ['missing resource map', (manifest) => ({ ...manifest, resources: undefined })],
  ['unrecorded executable', (manifest) => { delete manifest.resources[manifest.executable]; return manifest; }],
  ['unrecorded UI entry', (manifest) => { delete manifest.resources[manifest.ui.entry]; return manifest; }],
  ['unrecorded dependency', (manifest) => { delete manifest.resources[manifest.dependencies[0].path]; return manifest; }],
]) {
  test(`resolver fails closed for ${name}`, () => {
    const { root, manifest, manifestPath } = fixture();
    writeFileSync(manifestPath, JSON.stringify(mutate(manifest)));
    assert.throws(() => resolveContainer(root), /TN_DESKTOP_CONTAINER_MANIFEST_INVALID/);
  });
}

test('resolver rejects a manifest resource symlink escaping the container', () => {
  const { root, directory, manifest, manifestPath } = fixture();
  const outside = join(directory, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'payload'), 'outside payload');
  symlinkSync(outside, join(root, 'escape'), 'junction');
  manifest.resources['escape/payload'] = { sha256: digest(join(outside, 'payload')) };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => resolveContainer(root), /TN_DESKTOP_CONTAINER_MANIFEST_INVALID/);
});

for (const fail of [false, true]) {
  test(`archive replacement ${fail ? 'preserves the previous output on failure' : 'uses a fresh file instead of updating a stale ZIP'}`, () => {
    const root = makeTempDirSync('threenative-archive-replacement-');
    const executable = join(root, 'input');
    const output = join(root, 'game.zip');
    const bundle = join(root, 'game.bundle');
    writeFileSync(executable, 'executable');
    writeFileSync(bundle, authoredBundle());
    writeFileSync(output, 'previous archive');
    const build = () => packageDesktopContainer({
      platform: 'darwin', arch: 'x64', bundle, executable, output, config,
      run: (command, args) => {
        assert.equal(command, 'zip');
        if (!fail) assert.equal(existsSync(args[2]), false, 'zip must not update an existing archive');
        writeFileSync(args[2], fail ? 'partial archive' : 'fresh archive');
        return { status: fail ? 1 : 0, stdout: '', stderr: 'archive failure fixture' };
      },
    });
    if (fail) assert.throws(build, /TN_DESKTOP_ARCHIVE_FAILED/);
    else assert.equal(build().archive, output);
    assert.equal(readFileSync(output, 'utf8'), fail ? 'previous archive' : 'fresh archive');
  });
}

/**
 * The real tools, in both directions, on the format `zip` cannot always write.
 *
 * Every other archiver test injects `run`, so none of them proved that a container the fallback
 * wrote actually unpacks, nor that the launcher is still executable once it does — the bit a
 * player needs and the one a zip writer that ignores Unix modes silently drops.
 */
test.skipIf(process.platform === 'win32')(
  'a zip container round-trips through the installed tools with its executable bit intact',
  () => {
    const root = makeTempDirSync('threenative-archive-roundtrip-');
    const executable = join(root, 'input');
    const output = join(root, 'game.zip');
    const bundle = join(root, 'game.bundle');
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    writeFileSync(bundle, authoredBundle());
    // No injected `run`: the packager reaches for whatever this host actually has installed.
    const built = packageDesktopContainer({
      platform: 'darwin', arch: 'x64', bundle, executable, output, config,
    });
    assert.equal(readFileSync(built.archive).subarray(0, 2).toString('latin1'), 'PK');
    const containerRoot = extractContainer(built.archive, join(root, 'unpacked'), { platform: 'darwin' });
    const manifest = resolveContainer(containerRoot, { platform: 'darwin' });
    const launcher = join(containerRoot, manifest.executable);
    assert.ok(existsSync(launcher));
    assert.ok(
      (statSync(launcher).mode & 0o111) !== 0,
      'a container whose launcher lost its executable bit cannot be started by the player',
    );
  },
);

/**
 * `zip` is absent from a stock Arch install and has never existed on Windows, where `tar` is
 * libarchive. A packaging host with any of the archivers must still produce a release — and one
 * whose archiver wrote the wrong format must not ship it under a .zip name, which is what GNU tar
 * answering to the same name would otherwise do.
 */
for (const installed of ['bsdtar', 'tar']) {
  test(`a missing zip falls through to ${installed}, and only a real zip ships`, () => {
    const root = makeTempDirSync('threenative-archive-fallback-');
    const executable = join(root, 'input');
    const output = join(root, 'game.zip');
    const bundle = join(root, 'game.bundle');
    writeFileSync(executable, 'executable');
    writeFileSync(bundle, authoredBundle());
    const attempted = [];
    const build = () => packageDesktopContainer({
      platform: 'darwin', arch: 'x64', bundle, executable, output, config,
      run: (command, args) => {
        attempted.push(command);
        if (command !== installed) return { error: new Error(`spawnSync ${command} ENOENT`), status: null, stderr: '' };
        // libarchive writes the zip its suffix promises. GNU tar answers to the same name and
        // compresses by suffix, so an unknown one leaves a gzip wearing a .zip extension.
        writeFileSync(
          args[args.indexOf('-f') + 1],
          Buffer.from(installed === 'bsdtar' ? 'PK\u0003\u0004zip payload' : '\u001f\u008bgzip payload', 'latin1'),
        );
        return { status: 0, stdout: '', stderr: '' };
      },
    });
    if (installed === 'bsdtar') {
      assert.equal(build().archive, output);
      assert.deepEqual(attempted, ['zip', 'bsdtar']);
      assert.equal(readFileSync(output).subarray(0, 2).toString('latin1'), 'PK');
    } else {
      assert.throws(build, /TN_DESKTOP_ARCHIVE_TOOL_MISSING.*'tar' ran but wrote no zip archive/u);
      assert.deepEqual(attempted, ['zip', 'bsdtar', 'tar']);
      assert.equal(existsSync(output), false, 'a mislabelled archive must never reach the output');
    }
  });
}

// PRD-375: the container must record the loading sequence the consumer config declares, or the
// brand inspector has nothing to read back and every stock-derived project fails LOADING_MISSING.
// This is the producer and the consumer in one test on purpose: each side alone proved nothing.
function brandedFixture({ bootSplash } = {}) {
  const directory = makeTempDirSync('threenative-loading-');
  const engineIcon = join(directory, 'engine.png');
  writeFileSync(engineIcon, 'engine default icon');
  const branded = {
    app: { id: 'com.example.orbit', name: 'Orbit Game', version: '1.2.3', build: 7 },
    ui: { renderer: 'web' },
    ...(bootSplash === undefined ? {} : { bootSplash }),
  };
  const packed = fixture('linux', { config: branded, convertIcon: true, icon: true });
  branded.app.icon = packed.icon;
  return { ...packed, branded, engineIcon };
}

test('a configured bootSplash is recorded, and the brand inspector reads it back', () => {
  const directory = makeTempDirSync('threenative-splash-');
  const image = join(directory, 'splash.png');
  writeFileSync(image, authoredPng());
  const { root, manifest, branded, engineIcon } = brandedFixture({
    bootSplash: { backgroundColor: '#0d1b2a', image },
  });
  assert.deepEqual(manifest.loading, {
    bootSplash: { backgroundColor: '#0d1b2a', imageSha256: digest(image) },
  });
  const evidence = inspectContainerBrand(root, branded, { engineIcon });
  assert.equal(evidence.loading.bootSplash.backgroundColor, '#0d1b2a');
  assert.equal(evidence.loading.bootSplash.imageSha256, digest(image));
});

test('a colour-only bootSplash round-trips with a null image hash', () => {
  const { root, manifest, branded, engineIcon } = brandedFixture({
    bootSplash: { backgroundColor: '#0d1b2a' },
  });
  assert.deepEqual(manifest.loading, { bootSplash: { backgroundColor: '#0d1b2a', imageSha256: null } });
  assert.equal(
    inspectContainerBrand(root, branded, { engineIcon }).loading.bootSplash.imageSha256,
    null,
  );
});

test('a game with no bootSplash records that, rather than omitting the evidence', () => {
  const { root, manifest, branded, engineIcon } = brandedFixture();
  assert.deepEqual(manifest.loading, { bootSplash: null });
  assert.equal(inspectContainerBrand(root, branded, { engineIcon }).loading.bootSplash, null);
});

test('a recorded splash that does not match the config is still refused', () => {
  const { root, branded, engineIcon } = brandedFixture({ bootSplash: { backgroundColor: '#0d1b2a' } });
  assert.throws(
    () => inspectContainerBrand(root, { ...branded, bootSplash: { backgroundColor: '#ffffff' } }, { engineIcon }),
    /TN_NATIVE_STARTER_CONTAINER_LOADING_MISMATCH/u,
  );
});

test('a declared splash image that is not on disk refuses the release', () => {
  assert.throws(
    () => brandedFixture({ bootSplash: { image: join(makeTempDirSync('absent-'), 'missing.png') } }),
    /TN_DESKTOP_SPLASH_IMAGE_MISSING/u,
  );
});
