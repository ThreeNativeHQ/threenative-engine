import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';
import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import { buildWindowsInstaller, verifyWindowsUninstall, windowsInstallerScript } from '../scripts/windows-installer.mjs';
import { packageDesktopContainer } from '../scripts/desktop-distribution.mjs';

const app = { id: 'com.threenative.installertest', name: 'Orbit $INSTDIR ${NSIS_VERSION} "Game"', version: '1.0.0' };
const manifest = { app, executable: 'game.exe' };

test('uninstall verification preserves and inventories unowned data but refuses any owned remainder', () => {
  const root = makeTempDirSync('tn-installer-remainder-');
  const directory = join(root, 'Installed Game');
  const profile = join(directory, 'game/profile');
  const outside = join(root, 'outside');
  const files = ['game.exe', 'assets/model.bin', 'container.json'];
  try {
    mkdirSync(profile, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(profile, 'save.dat'), 'player data');
    writeFileSync(join(outside, 'sentinel'), 'outside data');
    symlinkSync(outside, join(directory, 'linked'), 'junction');
    symlinkSync(join(root, 'missing'), join(directory, 'dangling'), 'junction');
    const remaining = verifyWindowsUninstall(directory, files);
    assert.ok(remaining.some((entry) => entry.path === 'game/profile/save.dat' && entry.type === 'file'));
    assert.ok(remaining.some((entry) => entry.path === 'linked' && entry.type === 'link'));
    assert.ok(remaining.some((entry) => entry.path === 'dangling' && entry.type === 'link'));
    assert.deepEqual(remaining.map((entry) => entry.path), [...remaining.map((entry) => entry.path)].sort((a, b) => a.localeCompare(b)));
    assert.equal(remaining.some((entry) => entry.path.includes('sentinel')), false);
    assert.equal(readFileSync(join(profile, 'save.dat'), 'utf8'), 'player data');
    assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'outside data');
    for (const owned of ['game/game.exe', '.threenative-installer.ini']) {
      writeFileSync(join(directory, owned), 'owned');
      assert.throws(() => verifyWindowsUninstall(directory, files), /retained owned/u);
      rmSync(join(directory, owned));
    }
    assert.throws(() => verifyWindowsUninstall(directory, []), /EMPTY/u);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('installer dependencies remain valid after Windows checkout line-ending conversion', async () => {
  const require = createRequire(import.meta.url);
  const vite = require.resolve('vite', { paths: [require.resolve('vitest')] });
  const { createServer } = await import(pathToFileURL(vite).href);
  const server = await createServer({ configFile: false, server: { middlewareMode: true }, logLevel: 'silent' });
  try {
    const source = readFileSync(new URL('../scripts/desktop-distribution.mjs', import.meta.url), 'utf8');
    for (const ending of ['\n', '\r\n']) {
      const transformed = await server.ssrTransform(source.replace(/\r?\n/gu, ending), null, '/desktop-distribution.mjs');
      const parsed = spawnSync(process.execPath, ['--input-type=module', '--check'], { input: transformed.code, encoding: 'utf8', timeout: 10_000 });
      assert.equal(parsed.error, undefined);
      assert.equal(parsed.status, 0, parsed.stderr);
    }
  } finally { await server.close(); }
}, 15_000);

test('installer refuses paths Windows cannot safely represent', () => {
  for (const file of ['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a/../b', 'a//b', 'nul.txt', 'bad.', 'bad ', 'a\u0001b', 'file:stream']) {
    assert.throws(() => windowsInstallerScript({ root: '.', output: 'setup.exe', manifest, files: ['game.exe', file] }), /PATH_INVALID/u);
  }
  assert.throws(() => windowsInstallerScript({ root: '.', output: 'setup.exe', manifest, files: ['game.exe', 'GAME.EXE'] }), /PATH_COLLISION/u);
  assert.throws(() => windowsInstallerScript({ root: '.', output: 'setup.exe', manifest, files: ['game.exe', 'ASSETS', 'assets/image.png'] }), /PATH_COLLISION/u);
});

for (const failure of ['compiler', 'publication']) {
  test(`Windows ${failure} failure preserves both previous release artifacts`, () => {
    const root = makeTempDirSync('tn-installer-rollback-');
    try {
      const executable = join(root, 'input.exe');
      const bundle = join(root, 'game.bundle');
      const output = join(root, 'game.zip');
      const installer = join(root, 'game-setup.exe');
      writeFileSync(executable, 'runtime');
      writeFileSync(bundle, 'game');
      writeFileSync(output, 'previous ZIP');
      if (failure === 'publication') mkdirSync(installer);
      else writeFileSync(installer, 'previous installer');
      assert.throws(() => packageDesktopContainer({ platform: 'win32', arch: 'x64', executable, bundle,
        config: { app }, output,
        run(command, args) {
          if (command === 'zip') writeFileSync(args[2], 'new ZIP');
          else if (command === 'makensis') {
            if (failure === 'compiler') return { status: 1, stderr: 'compiler failed' };
            const candidate = /^OutFile "([^"]+)"$/mu.exec(readFileSync(args.at(-1), 'utf8'))?.[1];
            writeFileSync(candidate, 'MZ fixture installer');
          } else assert.fail(`unexpected tool: ${command}`);
          return { status: 0 };
        },
      }), failure === 'compiler' ? /TN_WINDOWS_INSTALLER_FAILED/u : /TN_DESKTOP_OUTPUT_NOT_FILE/u);
      assert.equal(readFileSync(output, 'utf8'), 'previous ZIP');
      if (failure === 'compiler') assert.equal(readFileSync(installer, 'utf8'), 'previous installer');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}

// Opt-in: runs the real NSIS compiler and Windows executables, never a mocked transport.
// Linux callers may supply an isolated DISPLAY/WINEPREFIX and TN_WINDOWS_INSTALLER_WINE=1.
test.skipIf(process.env.TN_WINDOWS_INSTALLER_INTEGRATION !== '1')('compiled installer owns its files across install, upgrade and uninstall', async () => {
  const wine = process.env.TN_WINDOWS_INSTALLER_WINE === '1';
  assert.ok(process.platform === 'win32' || wine, 'Windows or an explicit isolated Wine environment is required');
  const root = makeTempDirSync('tn-installer-integration-');
  const payload = join(root, 'payload');
  mkdirSync(payload);
  const id = `${app.id}.${Date.now()}`;
  const registry = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`;
  const windowsPath = (path) => wine ? `Z:${path.replaceAll('/', '\\')}` : path;
  const execute = (command, args, expected = 0) => {
    const result = spawnSync(wine ? 'wine' : command, wine ? [command, ...args] : args,
      { encoding: 'utf8', timeout: 60_000, windowsVerbatimArguments: !wine, ...(!wine ? { argv0: `"${command}"` } : {}) });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, expected, `${command}: ${result.stdout}\n${result.stderr}`);
    return result;
  };
  const install = (executable, directory, uninstall = false, expected = 0) => {
    if (wine) {
      // NSIS /D and _?= intentionally consume an unquoted trailing path, including spaces.
      const batch = join(root, 'invoke.cmd');
      writeFileSync(batch, `@echo off\r\n"${windowsPath(executable)}" /S ${uninstall ? '_?=' : '/D='}${windowsPath(directory)}\r\nexit /b %errorlevel%\r\n`);
      return execute('cmd', ['/c', windowsPath(batch)], expected);
    }
    return execute(executable, ['/S', `${uninstall ? '_?=' : '/D='}${directory}`], expected);
  };
  const compile = (version, files, signer, expected = 0) => {
    const output = join(root, `setup-${version}.exe`);
    const script = join(root, `setup-${version}.nsi`);
    writeFileSync(script, windowsInstallerScript({ root: payload, output, manifest: { ...manifest, app: { ...app, id, version } }, files, signer }));
    const result = spawnSync('makensis', ['-V2', script], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.error, undefined, result.error?.message);
    if (expected === 0) assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    else assert.notEqual(result.status, 0, 'failed uninstaller signing must reject the build');
    return output;
  };
  try {
    writeFileSync(join(payload, 'game.exe'), 'MZ old payload');
    writeFileSync(join(payload, 'obsolete.txt'), 'old asset');
    writeFileSync(join(payload, 'money$INSTDIR${NSIS_VERSION}.txt'), 'literal-dollar asset');
    const first = compile('1.0.0', ['game.exe', 'obsolete.txt', 'money$INSTDIR${NSIS_VERSION}.txt']);
    const directory = join(root, 'Installed Game');
    mkdirSync(directory);
    writeFileSync(join(directory, 'unrelated.txt'), 'user data');
    install(first, directory, false, 1);
    assert.equal(readFileSync(join(directory, 'unrelated.txt'), 'utf8'), 'user data');
    rmSync(join(directory, 'unrelated.txt'));
    install(first, directory);
    assert.equal(readFileSync(join(directory, 'game/game.exe'), 'utf8'), 'MZ old payload');
    assert.equal(readFileSync(join(directory, 'game/money$INSTDIR${NSIS_VERSION}.txt'), 'utf8'), 'literal-dollar asset');
    assert.ok(execute('reg', ['query', registry, '/v', 'DisplayName']).stdout.includes(app.name));
    install(first, join(root, 'Competing Install'), false, 1);
    assert.equal(existsSync(join(root, 'Competing Install/game/game.exe')), false);
    writeFileSync(join(directory, 'game/keep-me.txt'), 'user data');
    writeFileSync(join(payload, 'game.exe'), 'MZ new payload');
    const second = compile('2.0.0', ['game.exe']);
    if (!wine) {
      const ready = join(root, 'locked-ready');
      const locker = join(root, 'lock.ps1');
      writeFileSync(locker, "$ErrorActionPreference = 'Stop'\n$stream = [IO.File]::Open($env:TN_LOCK_FILE, 'Open', 'Read', 'None')\ntry { [IO.File]::WriteAllText($env:TN_LOCK_READY, 'ready'); Start-Sleep -Seconds 60 } finally { $stream.Dispose() }\n");
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', locker], {
        env: { ...process.env, TN_LOCK_FILE: join(directory, 'game/game.exe'), TN_LOCK_READY: ready }, stdio: 'inherit',
      });
      const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
      try {
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && Date.now() < deadline && child.exitCode === null) await delay(50);
        assert.ok(existsSync(ready), 'Windows file lock did not become ready');
        install(second, directory, false, 1);
        assert.equal(readFileSync(join(directory, 'game/game.exe'), 'utf8'), 'MZ old payload');
        assert.ok(existsSync(join(directory, 'Uninstall.exe')));
        assert.ok(existsSync(join(directory, '.threenative-installer.ini')));
        execute('reg', ['query', registry]);
      } finally { child.kill(); await exited; }
    }
    install(second, directory);
    assert.equal(readFileSync(join(directory, 'game/game.exe'), 'utf8'), 'MZ new payload');
    assert.equal(existsSync(join(directory, 'game/obsolete.txt')), false);
    assert.equal(readFileSync(join(directory, 'game/keep-me.txt'), 'utf8'), 'user data');
    install(join(directory, 'Uninstall.exe'), directory, true);
    assert.equal(existsSync(join(directory, 'game/game.exe')), false);
    assert.equal(readFileSync(join(directory, 'game/keep-me.txt'), 'utf8'), 'user data');
    assert.ok(verifyWindowsUninstall(directory, ['game.exe'])
      .some((entry) => entry.path === 'game/keep-me.txt' && entry.type === 'file'));
    execute('reg', ['query', registry], 1);
    // A real failed finalize command must stop NSIS, not merely print a diagnostic.
    const fail = join(root, 'fail-signing.mjs');
    const called = join(root, 'signing-was-called');
    writeFileSync(fail, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'called'); process.exit(17);`);
    compile('3.0.0', ['game.exe'], `"${process.execPath}" "${fail}" "%1"`, 1);
    assert.equal(readFileSync(called, 'utf8'), 'called', 'the failure must come from the signing helper');
    // Compile the WebView prerequisite branch too. This fixture does not claim bootstrapper execution.
    const uiSetup = buildWindowsInstaller({ root: payload, output: join(root, 'ui-setup.exe'),
      manifest: { ...manifest, app: { ...app, id }, ui: { directory: 'ui' } }, files: ['game.exe'],
      run(command, args, options) {
        if (command === 'powershell.exe') {
          writeFileSync(options.env.TN_WEBVIEW_BOOTSTRAPPER_OUTPUT, 'MZ bootstrapper compile fixture');
          return { status: 0 };
        }
        return spawnSync(command, args, { encoding: 'utf8', timeout: 60_000, ...options });
      },
    });
    assert.ok(existsSync(uiSetup));
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 300_000);
