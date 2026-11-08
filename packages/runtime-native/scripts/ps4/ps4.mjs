#!/usr/bin/env node
// PRD-784 deploy: one command takes a game project to a PS4.
//
//   pnpm ps4 <game dir>                    build, boot the game in the shadPS4 emulator (pass/fail), write the fake PKG
//   pnpm ps4 <game dir> --console <ip>     the same, then upload the PKG to a jailbroken console (GoldHEN FTP 2121)
//
// Options: --no-preview (skip the emulator), --out <dir> (build folder, default $TN_PS4_E5_DIR or
// ~/.cache/tmp-tn/prd784/e5), --icon <512x512 png>, --jobs N, --self-check.
//
// A thin orchestrator: run-experiment.mjs deps (toolchain + emulator), send-to-console.mjs --build-only
// (E2 driver, player SELF, game bundle, identity, PKG), run-experiment.mjs deploy (the preview),
// send-to-console.mjs --prebuilt (upload). Each step is a script that also runs on its own.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = 'usage: pnpm ps4 <game dir> [--console <ip>] [--no-preview] [--out <dir>] [--icon <png>] [--jobs N]';
const VALUE_FLAGS = { '--console': 'console', '--out': 'out', '--icon': 'icon', '--jobs': 'jobs' };

function log(message) {
  process.stdout.write(`[ps4] ${message}\n`);
}

// The game dir is the one positional argument; --out and --icon are paths read from where the user stands.
export function parseArgs(argv) {
  const options = { game: '', console: '', preview: true, out: process.env.TN_PS4_E5_DIR ?? path.join(homedir(), '.cache/tmp-tn/prd784/e5'), icon: '', jobs: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-preview') options.preview = false;
    else if (VALUE_FLAGS[arg]) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value\n${USAGE}`);
      options[VALUE_FLAGS[arg]] = arg === '--out' || arg === '--icon' ? path.resolve(value) : value;
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

function selfCheck() {
  const options = parseArgs(['games/cube', '--console', '10.0.0.2', '--no-preview', '--jobs', '4']);
  assert.deepEqual([path.basename(options.game), options.console, options.preview, options.jobs], ['cube', '10.0.0.2', false, '4']);
  assert.equal(parseArgs(['games/cube']).preview, true, 'the preview is on by default');
  assert.equal(parseArgs(['--out', 'x', 'games/cube']).out, path.resolve('x'));
  for (const bad of [[], ['a', 'b'], ['a', '--nope'], ['a', '--console']]) assert.throws(() => parseArgs(bad), /usage: pnpm ps4/, `rejects ${JSON.stringify(bad)}`);
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

  if (options.console) {
    const sent = await step(`4/4 upload to ${options.console}`, 'send-to-console.mjs', [...flags, '--prebuilt', '--pkg', pkg, '--host', options.console], env);
    if (sent.code !== 0) return fail('the upload');
  }
  log(`PASS preview: ${verdict}`);
  log(`PKG: ${pkg} (${(statSync(pkg).size / 1024 / 1024).toFixed(1)} MiB)`);
  log(options.console ? 'on the console: Settings > Debug Settings > Game > Package Installer, install it, then launch the game' : 'to send it to a jailbroken console: pnpm ps4 <game dir> --console <ip>');
  return 0;
}

function fail(what) {
  process.stderr.write(`[ps4] FAIL: ${what} failed, see the output above\n`);
  return 1;
}

process.exit(await main(process.argv.slice(2)));
