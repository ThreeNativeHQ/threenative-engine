#!/usr/bin/env node
// PRD-784 PS4 experiments: build a guest program with the OpenOrbis toolchain, boot it in the
// shadPS4 emulator headless, and pass only when the guest prints its marker.
//
// Usage: node packages/runtime-native/scripts/ps4/run-experiment.mjs e1
//
// Every product stays under the scratch root (sibling of the dependency root), never in the repo.
// shadPS4 reads no raw ELF: it wants a SELF (eboot.bin), which create-fself writes from our ELF.
// No Sony firmware module is downloaded or required; a run that asks for one fails.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PINS = {
  // shadPS4 v.0.21.0; the AppImage inside the release zip is the emulator binary.
  shadps4: {
    repo: 'shadps4-emu/shadPS4',
    tag: 'v.0.21.0',
    asset: 'shadps4-linux-sdl-0.21.0.zip',
    sha256: '7c41c58254461d742b5edf564e23795697b63e9e46de11d0e1ed67bd2cbaae68',
    member: 'Shadps4-sdl.AppImage',
  },
  // OpenOrbis PS4 Toolchain v0.5.4, extracted to OpenOrbis/PS4Toolchain.
  openorbis: {
    repo: 'OpenOrbis/OpenOrbis-PS4-Toolchain',
    tag: 'v0.5.4',
    asset: 'toolchain-llvm-18.tar.gz',
    sha256: '3c7cd5bb593ca74fa1c13fd59f3938dc0fc07985167f7275063019e63abe4526',
  },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../../..');
const DEPS_DIR = process.env.TN_PS4_DEPS ?? path.join(homedir(), '.cache/tmp-tn/prd784/deps');
const OUT_DIR = path.join(path.dirname(DEPS_DIR), 'e1');
const BOOT_TIMEOUT_MS = 60_000;

const MARKER = 'TN_PS4_E1_MARKER';

// Later experiments (e2..e5) become more entries here: a source file that prints its marker plus
// any extra build arguments; build and boot are shared.
const EXPERIMENTS = {
  e1: {
    source: path.join(HERE, 'e1-hello.c'),
    marker: MARKER,
    // Title metadata for the app folder; written by PkgTool.Core, never copied from a dump.
    sfo: {
      TITLE: 'ThreeNative PS4 E1',
      TITLE_ID: 'TNPRD784E1',
      VERSION: '1.00',
      CONTENT_ID: 'IV0000-TNPRD784E1_00-TNPS4E1000000000',
    },
  },
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

// Fetch only when the pinned artifact is absent, then verify. A hash mismatch throws: a different
// release must never be booted while the pins say otherwise.
async function ensureArchive(pin, destination) {
  if (!existsSync(destination)) {
    console.log(`fetching ${pin.tag} ${pin.asset}`);
    await mkdir(path.dirname(destination), { recursive: true });
    run('gh', ['release', 'download', pin.tag, '--repo', pin.repo, '--pattern', pin.asset, '--dir', path.dirname(destination), '--clobber']);
  }
  const actual = await sha256(destination);
  if (actual !== pin.sha256) throw new Error(`${pin.asset} sha256 ${actual} != pinned ${pin.sha256}`);
}

async function ensureToolchain() {
  const archive = path.join(DEPS_DIR, 'oo', PINS.openorbis.asset);
  await ensureArchive(PINS.openorbis, archive);
  const root = path.join(DEPS_DIR, 'oo', 'OpenOrbis', 'PS4Toolchain');
  if (!existsSync(path.join(root, 'link.x'))) run('tar', ['-xzf', archive, '-C', path.dirname(root)]);
  return root;
}

async function ensureEmulator() {
  const archive = path.join(DEPS_DIR, 'shadps4', PINS.shadps4.asset);
  await ensureArchive(PINS.shadps4, archive);
  const appimage = path.join(DEPS_DIR, 'shadps4', PINS.shadps4.member);
  if (!existsSync(appimage)) {
    run('unzip', ['-o', '-q', archive, PINS.shadps4.member, '-d', path.dirname(appimage)]);
    await chmod(appimage, 0o755);
  }
  return appimage;
}

// Build the ELF and the SELF form shadPS4 boots. The commands are the OpenOrbis hello_world
// Makefile's, which is the toolchain's own supported invocation.
async function build(experiment, toolchain) {
  const buildDir = path.join(OUT_DIR, 'build');
  const appDir = path.join(OUT_DIR, 'app');
  await rm(buildDir, { recursive: true, force: true });
  await rm(appDir, { recursive: true, force: true });
  await mkdir(path.join(appDir, 'sce_sys'), { recursive: true });
  await mkdir(buildDir, { recursive: true });

  // PkgTool.Core is a .NET app and the host has no ICU package; invariant mode is its own escape hatch.
  const env = { ...process.env, OO_PS4_TOOLCHAIN: toolchain, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' };
  const object = path.join(buildDir, 'e1-hello.o');
  const elf = path.join(buildDir, 'e1-hello.elf');
  const oelf = path.join(buildDir, 'e1-hello.oelf');
  const eboot = path.join(appDir, 'eboot.bin');

  run('clang', ['--target=x86_64-pc-freebsd12-elf', '-fPIC', '-funwind-tables', '-c', '-isysroot', toolchain, '-isystem', path.join(toolchain, 'include'), '-o', object, experiment.source], { env });
  run('ld.lld', [object, '-o', elf, '-m', 'elf_x86_64', '-pie', '--script', path.join(toolchain, 'link.x'), '--eh-frame-hdr', `-L${path.join(toolchain, 'lib')}`, '-lc', '-lkernel', path.join(toolchain, 'lib', 'crt1.o')], { env });
  run(path.join(toolchain, 'bin', 'linux', 'create-fself'), [`-in=${elf}`, `-out=${oelf}`, '--eboot', 'eboot.bin', '--paid', '0x3800000000000011'], { env, cwd: appDir });

  const sfo = path.join(appDir, 'sce_sys', 'param.sfo');
  const pkgtool = path.join(toolchain, 'bin', 'linux', 'PkgTool.Core');
  run(pkgtool, ['sfo_new', sfo], { env });
  const entries = [
    ['APP_TYPE', 'Integer', '4', '1'],
    ['APP_VER', 'Utf8', '8', experiment.sfo.VERSION],
    ['ATTRIBUTE', 'Integer', '4', '0'],
    ['CATEGORY', 'Utf8', '4', 'gd'],
    ['CONTENT_ID', 'Utf8', '48', experiment.sfo.CONTENT_ID],
    ['DOWNLOAD_DATA_SIZE', 'Integer', '4', '0'],
    ['SYSTEM_VER', 'Integer', '4', '0'],
    ['TITLE', 'Utf8', '128', experiment.sfo.TITLE],
    ['TITLE_ID', 'Utf8', '12', experiment.sfo.TITLE_ID],
    ['VERSION', 'Utf8', '8', experiment.sfo.VERSION],
  ];
  for (const [key, type, maxsize, value] of entries) {
    run(pkgtool, ['sfo_setentry', sfo, key, '--type', type, '--maxsize', maxsize, '--value', value], { env });
  }

  return { appDir, artifacts: { object, elf, oelf, eboot, sfo } };
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function stop(child) {
  if (child.exitCode !== null) return;
  // Negative pid = the process group this launch owns (it is spawned detached). Never a name match:
  // a name match would hit unrelated processes on the host.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  for (let waited = 0; waited < 10_000 && child.exitCode === null; waited += 100) await delay(100);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    for (let waited = 0; waited < 5_000 && child.exitCode === null; waited += 100) await delay(100);
  }
}

// Boot headless: xvfb.sh owns the private X display, the sandbox home keeps shadPS4's config,
// users and log out of the real ~/.local/share (whose stale profile opens a Save Migration dialog).
async function boot(experiment, build, appimage) {
  const home = path.join(OUT_DIR, 'home');
  await rm(home, { recursive: true, force: true });
  const env = { ...process.env };
  // SDL shows its message boxes through a Qt/KDE helper; with KDE's QT_QPA_PLATFORM and the session
  // bus that helper lands on the owner's real desktop, not on the private Xvfb display.
  for (const name of ['WAYLAND_DISPLAY', 'WAYLAND_SOCKET', 'DESKTOP_STARTUP_ID', 'DBUS_SESSION_BUS_ADDRESS', 'QT_QPA_PLATFORM']) delete env[name];
  Object.assign(env, {
    HOME: home,
    XDG_DATA_HOME: path.join(home, '.local/share'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    SDL_VIDEO_DRIVER: 'x11',
    SDL_VIDEODRIVER: 'x11',
    XDG_SESSION_TYPE: 'x11',
    QT_QPA_PLATFORM: 'offscreen',
  });

  const logDir = path.join(env.XDG_DATA_HOME, 'shadPS4', 'log');
  const logFile = path.join(logDir, 'shad_log.txt');
  // shadPS4 asks the "Save Migration" question whenever it creates home/1000 itself
  // (src/core/user_manager.cpp:293-300 at v.0.21.0), so the run creates that user first.
  for (const sub of ['savedata', 'trophy', 'inputs']) {
    await mkdir(path.join(env.XDG_DATA_HOME, 'shadPS4', 'home', '1000', sub), { recursive: true });
  }
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  await mkdir(env.XDG_CACHE_HOME, { recursive: true });
  const outDir = path.join(OUT_DIR, 'out');
  await mkdir(outDir, { recursive: true });

  const wrapper = path.join(REPO_ROOT, 'scripts', 'xvfb.sh');
  if (!existsSync(wrapper)) throw new Error(`missing ${wrapper}`);
  const child = spawn('sh', [wrapper, appimage, '-g', build.artifacts.eboot], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let log = '';
  let failure = '';
  for (;;) {
    log = await readText(logFile);
    if (output.includes(experiment.marker) || log.includes(experiment.marker)) break;
    if (child.exitCode !== null) {
      failure = `shadPS4 exited (${child.exitCode ?? child.signalCode}) before the marker appeared`;
      break;
    }
    if (Date.now() > deadline) {
      failure = `no marker within ${BOOT_TIMEOUT_MS / 1000}s`;
      break;
    }
    await delay(250);
  }

  const found = !failure;
  await stop(child);
  await writeFile(path.join(outDir, 'run.log'), output);
  await writeFile(path.join(outDir, 'shad_log.txt'), log);
  return { found, failure, log, logFile };
}

async function main(argv) {
  const name = argv[2];
  const experiment = EXPERIMENTS[name];
  if (!experiment) {
    console.error(`usage: node packages/runtime-native/scripts/ps4/run-experiment.mjs <${Object.keys(EXPERIMENTS).join('|')}>`);
    return 2;
  }

  const toolchain = await ensureToolchain();
  const appimage = await ensureEmulator();
  const built = await build(experiment, toolchain);
  const result = await boot(experiment, built, appimage);

  if (result.found) {
    console.log(`PS4_EMULATED ${name.toUpperCase()} PASS`);
    return 0;
  }
  const tail = result.log.trimEnd().split('\n').slice(-20).join('\n');
  const firmware = /sys_modules|firmware/i.test(result.log) ? ' (shadPS4 reported a firmware/sys_modules requirement)' : '';
  console.log(`PS4_EMULATED ${name.toUpperCase()} FAIL: ${result.failure}${firmware}\n${tail}`);
  return 1;
}

process.exitCode = await main(process.argv);
