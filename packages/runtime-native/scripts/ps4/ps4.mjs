#!/usr/bin/env node
// PRD-784 deploy: one command takes a game project to a PS4.
//
//   pnpm ps4 <game dir>                    build, boot the game in the shadPS4 emulator (pass/fail), write the fake PKG
//   pnpm ps4 <game dir> --usb <mount dir>  the same, then copy the PKG to the root of a USB stick (FAT32/exFAT) and verify it
//   pnpm ps4 <game dir> --console <ip>     the same, then upload the PKG to a jailbroken console (GoldHEN FTP 2121)
//
// Options: --no-preview (skip the emulator), --out <dir> (build folder, default $TN_PS4_E5_DIR or
// ~/.cache/tmp-tn/prd784/e5), --icon <512x512 png>, --jobs N, --self-check.
//
// A thin orchestrator: run-experiment.mjs deps (toolchain + emulator), send-to-console.mjs --build-only
// (E2 driver, player SELF, game bundle, identity, PKG), run-experiment.mjs deploy (the preview),
// send-to-console.mjs --prebuilt (upload). Each step is a script that also runs on its own.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: pnpm ps4 <game dir> [--usb <mount dir>] [--console <ip>] [--no-preview] [--out <dir>] [--icon <png>] [--jobs N]';
const VALUE_FLAGS = { '--usb': 'usb', '--console': 'console', '--out': 'out', '--icon': 'icon', '--jobs': 'jobs' };

function log(message) {
  process.stdout.write(`[ps4] ${message}\n`);
}

// The game dir is the one positional argument; --out and --icon are paths read from where the user stands.
export function parseArgs(argv) {
  const options = { game: '', usb: '', console: '', preview: true, out: process.env.TN_PS4_E5_DIR ?? path.join(homedir(), '.cache/tmp-tn/prd784/e5'), icon: '', jobs: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-preview') options.preview = false;
    else if (VALUE_FLAGS[arg]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      options[VALUE_FLAGS[arg]] = ['--out', '--icon', '--usb'].includes(arg) ? path.resolve(value) : value;
    } else if (arg.startsWith('--') || options.game) throw new Error(`unknown argument ${arg}\n${USAGE}`);
    else options.game = path.resolve(arg);
  }
  if (!options.game) throw new Error(`a game dir is required\n${USAGE}`);
  return options;
}

// Fail in a second, before any build: the game project is the one input nothing can default.
export function checkGame(game) {
  if (!existsSync(game) || !statSync(game).isDirectory()) return `${game} is not a directory`;
  if (!existsSync(path.join(game, 'src', 'game.ts'))) return `${game} has no src/game.ts: name a game project (see packages/create-threenative)`;
  return '';
}

// One child step: its output goes to the terminal as it arrives and is kept, because the package path
// and the preview's screenshot are read back from it. Returns { code, output }.
function step(title, script, args, env = {}) {
  log(`${title}`);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8').on('data', chunk => {
        output += chunk;
        process.stdout.write(chunk);
      });
    }
    child.on('error', error => resolve({ code: 1, output: `${output}${error.message}` }));
    child.on('close', code => resolve({ code: code ?? 1, output }));
  });
}

// The USB route: the console's Package Installer lists .pkg files at the root of a USB stick it can read,
// which is FAT32 or exFAT only. A mount dir that is missing or read-only fails before any build.
const USB_FS = ['vfat', 'msdos', 'exfat'];
const FAT32_MAX = 4 * 1024 ** 3 - 1;

export function checkUsb(dir) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return `--usb ${dir} is not a directory: plug in the stick, mount it, and pass its mount dir`;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    return `--usb ${dir} is not writable: remount the stick read-write or fix its permissions`;
  }
  return '';
}

export function fsWarning(fstype, bytes) {
  if (!USB_FS.includes(fstype))
    return `${filesystemName(fstype)} is not FAT32 or exFAT: the PS4 reads only those two, reformat the stick before using it`;
  if (fstype !== 'exfat' && bytes > FAT32_MAX) return 'the package is over 4 GiB, which FAT32 cannot hold: use exFAT';
  return '';
}

function filesystemName(fstype) {
  return `the stick's filesystem (${fstype || 'unknown'})`;
}

export const USB_STEPS = [
  'on the console: plug the stick into a USB port',
  'Settings > Debug Settings > Game > Package Installer > USB > pick the package file',
  'when the install ends, launch the game from the home screen',
];

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// The stick explains itself: an owner who never read a terminal opens this file and follows five lines.
function installNote(pkg, sha) {
  return [
    'ThreeNative on PS4',
    '',
    `package: ${path.basename(pkg)} (${(statSync(pkg).size / 1024 / 1024).toFixed(1)} MiB)`,
    `sha256:  ${sha}`,
    '',
    'A stock console cannot install this file: the console must already be jailbroken, with GoldHEN running.',
    '',
    ...USB_STEPS.map((line, i) => `${i + 1}. ${line}`),
    '',
    'An installed package needs GoldHEN running after every boot. With GoldHEN autoload-from-USB on, keep',
    'this stick in the console: power on, then launch the game from the home screen.',
    '',
  ].join('\n');
}

// Copy, compare the bytes by sha256, then flush: a stick pulled before `sync` returns can hold a cut file.
function copyToUsb(pkg, dir) {
  const target = path.join(dir, path.basename(pkg));
  copyFileSync(pkg, target);
  const [want, got] = [sha256File(pkg), sha256File(target)];
  if (want !== got) throw new Error(`${target} differs from ${pkg} after the copy (sha256 ${got}, want ${want}): the stick may be failing`);
  const note = path.join(dir, 'TN-PS4-INSTALL.txt');
  writeFileSync(note, installNote(pkg, got));
  spawnSync('sync', [], { stdio: 'ignore' });
  // mount.exfat-fuse mounts through FUSE, so the kernel reports fuseblk there; lsblk names what the
  // stick itself carries, and a correct exFAT stick must not be reported as one to reformat.
  const [reported = '', source = ''] = (spawnSync('findmnt', ['-n', '-o', 'FSTYPE,SOURCE', '--target', dir], { encoding: 'utf8' }).stdout ?? '').trim().split(/\s+/);
  const device = reported === 'fuseblk' && source ? (spawnSync('lsblk', ['-no', 'FSTYPE', source], { encoding: 'utf8' }).stdout ?? '').trim() : '';
  const fstype = device || reported;
  return { target, note, sha: got, fstype, warning: fsWarning(fstype, statSync(pkg).size) };
}

function selfCheck() {
  const options = parseArgs(['games/cube', '--console', '10.0.0.2', '--no-preview', '--jobs', '4']);
  assert.deepEqual([path.basename(options.game), options.console, options.preview, options.jobs], ['cube', '10.0.0.2', false, '4']);
  assert.equal(parseArgs(['games/cube']).preview, true, 'the preview is on by default');
  assert.equal(parseArgs(['--out', 'x', 'games/cube']).out, path.resolve('x'));
  for (const bad of [[], ['a', 'b'], ['a', '--nope'], ['a', '--console']]) assert.throws(() => parseArgs(bad), /usage: pnpm ps4/, `rejects ${JSON.stringify(bad)}`);
  assert.equal(parseArgs(['g', '--usb', 'stick']).usb, path.resolve('stick'));
  assert.match(checkUsb('/nonexistent-usb'), /not a directory/);
  assert.match(checkUsb(path.join(HERE, 'ps4.mjs')), /not a directory/);
  assert.match(checkUsb('/proc'), /not writable|^$/, 'a read-only dir is refused (skipped when run as root)');
  assert.equal(checkUsb(tmpdir()), '');
  assert.match(fsWarning('ext4', 1), /not FAT32 or exFAT/);
  assert.match(fsWarning('ntfs', 1), /not FAT32 or exFAT/);
  assert.match(fsWarning('', 1), /unknown/);
  assert.equal(fsWarning('vfat', 1), '');
  assert.equal(fsWarning('exfat', 5 * 1024 ** 3), '');
  assert.match(fsWarning('vfat', 5 * 1024 ** 3), /over 4 GiB/);
  const stick = mkdtempSync(path.join(tmpdir(), 'tn-usb-check-'));
  const fake = path.join(stick, 'src.pkg');
  writeFileSync(fake, 'pkg bytes');
  const target = path.join(stick, 'out');
  mkdirSync(target);
  const copied = copyToUsb(fake, target);
  assert.equal(readFileSync(copied.target, 'utf8'), 'pkg bytes');
  assert.equal(copied.target, path.join(target, 'src.pkg'), 'the package lands at the root of the mount');
  assert.match(readFileSync(copied.note, 'utf8'), /Package Installer/, 'the stick carries the install steps');
  assert.match(readFileSync(copied.note, 'utf8'), /already be jailbroken/, 'and says the console must be jailbroken first');
  assert.doesNotMatch(copied.fstype, /fuseblk/, 'a FUSE mount is resolved to the filesystem the stick carries');
  assert.match(checkGame('/nonexistent-game-dir'), /not a directory/);
  assert.match(checkGame(HERE), /no src\/game\.ts/);
  assert.equal(checkGame(path.resolve(HERE, '../../../../examples/wasm-engine-boot')), '');
  log('self-check ok');
}

async function main(argv) {
  if (argv.includes('--self-check')) return selfCheck();
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`[ps4] ${error.message}\n`);
    return 2;
  }
  const problem = checkGame(options.game);
  if (problem) {
    process.stderr.write(`[ps4] ${problem}\n`);
    return 2;
  }
  const usbProblem = options.usb ? checkUsb(options.usb) : '';
  if (usbProblem) {
    process.stderr.write(`[ps4] ${usbProblem}\n`);
    return 2;
  }
  const env = { TN_PS4_E5_DIR: options.out };
  const flags = ['--scene', options.game, '--out', options.out, ...(options.jobs ? ['--jobs', options.jobs] : []), ...(options.icon ? ['--icon', options.icon] : [])];

  const deps = await step('1/4 toolchain and emulator', 'run-experiment.mjs', ['deps'], env);
  if (deps.code !== 0) return fail('fetching the OpenOrbis toolchain or the shadPS4 emulator');
  const built = await step('2/4 build: driver, player, game bundle, fake PKG', 'send-to-console.mjs', [...flags, '--build-only'], env);
  const pkg = /\[send\] package:\s+(\S+\.pkg)/.exec(built.output)?.[1];
  if (built.code !== 0 || !pkg) return fail('the build');

  let verdict = 'skipped (--no-preview)';
  if (options.preview) {
    const preview = await step('3/4 preview: boot the game in the emulator', 'run-experiment.mjs', ['deploy', '--scene', options.game], env);
    verdict = /PS4_EMULATED DEPLOY PASS.*/.exec(preview.output)?.[0] ?? '';
    if (preview.code !== 0 || !verdict) {
      log(`FAIL: the game did not boot and draw in the emulator; the package ${pkg} is built but is not sent`);
      return 1;
    }
  }

  if (options.usb) {
    let copied;
    try {
      copied = copyToUsb(pkg, options.usb);
    } catch (error) {
      return fail(`the copy to ${options.usb} (${error.message})`);
    }
    log(`USB: ${copied.target} copied, sha256 ${copied.sha} verified, synced (filesystem ${copied.fstype || 'unknown'})`);
    log(`USB: ${copied.note} holds the steps to install on the console`);
    if (copied.warning) log(`WARNING: ${copied.warning}`);
  }
  if (options.console) {
    const sent = await step(`4/4 upload to ${options.console}`, 'send-to-console.mjs', [...flags, '--prebuilt', '--pkg', pkg, '--host', options.console], env);
    if (sent.code !== 0) return fail('the upload');
  }
  log(`PASS preview: ${verdict}`);
  log(`PKG: ${pkg} (${(statSync(pkg).size / 1024 / 1024).toFixed(1)} MiB)`);
  if (!options.usb) log('USB route: pnpm ps4 <game dir> --usb <mount dir> copies it to a FAT32/exFAT stick (or copy the PKG to the stick root by hand)');
  for (const [i, line] of USB_STEPS.entries()) log(`  ${i + 1}. ${line}`);
  if (!options.console) log('network route (GoldHEN FTP): pnpm ps4 <game dir> --console <ip>');
  return 0;
}

function fail(what) {
  process.stderr.write(`[ps4] FAIL: ${what} failed, see the output above\n`);
  return 1;
}

process.exit(await main(process.argv.slice(2)));
