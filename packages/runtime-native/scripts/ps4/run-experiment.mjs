#!/usr/bin/env node
// PRD-784 PS4 experiments: build a guest program with the OpenOrbis toolchain, boot it in the
// shadPS4 emulator headless, and pass only when the guest prints its marker.
//
// Usage: node packages/runtime-native/scripts/ps4/run-experiment.mjs <e1|e2>
//
// Every product stays under the scratch root (sibling of the dependency root), one directory per
// experiment (<scratch>/e1, <scratch>/e2), never in the repo.
// shadPS4 reads no raw ELF: it wants a SELF (eboot.bin), which create-fself writes from our ELF.
// No Sony firmware module is downloaded or required; a run that asks for one fails.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
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
const SCRATCH_ROOT = path.dirname(DEPS_DIR);

const MARKER = 'TN_PS4_E1_MARKER';

// E2's pass rule reads the guest's own frame on the host, because the guest's count only proves
// what its readback buffer held. The triangle covers 12.5% of a 1920x1080 frame; the band leaves
// room for a smaller or partly replaced draw, and rejects "nothing but the clear" and "no clear".
const E2_CLEAR = [26, 26, 51]; // 0.1, 0.1, 0.2 cleared as UNORM8
const E2_TOLERANCE = 8; // per-channel distance from the clear colour that counts as drawn
const E2_DRAWN_MIN = 0.02;
const E2_DRAWN_MAX = 0.75;

// shadPS4 keeps render targets in host VRAM and writes them back to guest memory only when GPU
// readbacks are on (default Disabled: src/core/emulator_settings.h:421 at v.0.21.0). PS4 memory
// is unified, so a guest copying a rendered image reads stale memory without this -- a config
// fix, not a cheat. Relaxed=1, Precise=2; TN_PS4_READBACKS_MODE lets a red try the other mode.
const READBACKS_MODE = Number(process.env.TN_PS4_READBACKS_MODE ?? 2);

// One entry per experiment; build and boot are shared, only the build step, the marker and the
// pass rule differ.
const EXPERIMENTS = {
  e1: {
    timeoutMs: 60_000,
    // Title metadata for the app folder; written by PkgTool.Core, never copied from a dump.
    sfo: {
      TITLE: 'ThreeNative PS4 E1',
      TITLE_ID: 'TNPRD784E1',
      VERSION: '1.00',
      CONTENT_ID: 'IV0000-TNPRD784E1_00-TNPS4E1000000000',
    },
    build: (outDir, toolchain) => buildGuest(outDir, toolchain, path.join(HERE, 'e1-hello.c'), 'e1-hello', EXPERIMENTS.e1.sfo),
    // The guest prints one marker line once the PS4 libc, the loader and stdout all work.
    marker: MARKER,
    verdict: () => ({ ok: true, detail: '' }),
  },
  e2: {
    // The vulkan-ps4 triangle (E2 readback) with a Vulkan pipeline + shader compile inside the
    // emulator, so it gets a longer boot window than E1's marker print.
    timeoutMs: 300_000,
    build: (outDir, toolchain) => buildE2(outDir, toolchain),
    // The guest's readback line ends the boot wait and is reported, but it is not the verdict:
    // E2's frame itself is judged on the host. The test also logs any vk* failure as "TEST: ...".
    markerPattern: /TN_PS4_E2 pixels nonblank=(\d+) of (\d+)/,
    failurePattern: /TEST:[^\n]*FAILED/,
    verdict: (match, frame, log) => judgeE2(match, frame, log),
  },
};

// Parse a binary PPM (P6, maxval 255), the form the guest writes: "P6\n<w> <h>\n255\n" followed
// by width*height*3 bytes. '#' starts a comment, as the format allows.
function readPpm(buffer) {
  const fields = [];
  let at = 0;
  while (fields.length < 4) {
    while (at < buffer.length && /\s/.test(String.fromCharCode(buffer[at]))) at++;
    if (buffer[at] === 0x23) {
      while (at < buffer.length && buffer[at] !== 0x0a) at++;
      continue;
    }
    const start = at;
    while (at < buffer.length && !/\s/.test(String.fromCharCode(buffer[at]))) at++;
    if (start === at) throw new Error('header is truncated');
    fields.push(buffer.toString('latin1', start, at));
  }
  at++; // the one whitespace byte that ends the header
  const width = Number(fields[1]);
  const height = Number(fields[2]);
  if (fields[0] !== 'P6' || fields[3] !== '255' || !width || !height)
    throw new Error(`header "${fields.join(' ')}" is not a P6/255 raster`);
  const pixels = buffer.subarray(at);
  if (pixels.length < width * height * 3)
    throw new Error(`${pixels.length} pixel bytes for ${width}x${height}x3`);
  return { width, height, pixels };
}

// Drawn = differs from the clear colour by more than the tolerance on any channel and is not
// black: black is guest memory nothing ever wrote, never something the draw made.
function countDrawn({ width, height, pixels }) {
  let drawn = 0;
  for (let i = 0; i < width * height; i++) {
    const r = pixels[i * 3];
    const g = pixels[i * 3 + 1];
    const b = pixels[i * 3 + 2];
    if (r <= 8 && g <= 8 && b <= 8) continue;
    if (
      Math.abs(r - E2_CLEAR[0]) > E2_TOLERANCE ||
      Math.abs(g - E2_CLEAR[1]) > E2_TOLERANCE ||
      Math.abs(b - E2_CLEAR[2]) > E2_TOLERANCE
    )
      drawn++;
  }
  return drawn;
}

// E2's verdict: the config must have taken effect (else a red frame blames the wrong layer),
// then the guest's frame must show a triangle and no larger-than-a-frame draw.
async function judgeE2(match, frame, log) {
  const wanted = `GPU readbacksMode: ${READBACKS_MODE}`;
  if (!log.includes(wanted) || !log.includes('GPU readbackLinearImages: true'))
    return {
      ok: false,
      reason: `shadPS4 did not take the config: its log lacks "${wanted}" and/or "GPU readbackLinearImages: true"`,
    };
  const guest = ` guest-nonblank=${match[1]} of ${match[2]}`;
  if (!frame.ppm) return { ok: false, reason: 'the guest wrote no PPM, so there is no frame to judge' };
  let raster;
  try {
    raster = readPpm(await readFile(frame.ppm));
  } catch (error) {
    return { ok: false, reason: `${frame.ppm} is unreadable: ${error.message}` };
  }
  const total = raster.width * raster.height;
  const drawn = countDrawn(raster);
  const ratio = drawn / total;
  const counts = `drawn=${drawn} of ${total} (${(ratio * 100).toFixed(2)}%)`;
  if (ratio < E2_DRAWN_MIN)
    return { ok: false, reason: `${counts}, below the ${E2_DRAWN_MIN * 100}% band, so the frame is only the clear colour`, info: guest };
  if (ratio > E2_DRAWN_MAX)
    return { ok: false, reason: `${counts}, above the ${E2_DRAWN_MAX * 100}% band, so nothing cleared the frame`, info: guest };
  return { ok: true, detail: ` drawn=${(ratio * 100).toFixed(2)}%`, info: guest };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result;
}

// Same, but the child owns the terminal: a long build's progress must be visible live.
function runInherit(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`);
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
async function buildGuest(outDir, toolchain, source, stem, sfoFields) {
  const buildDir = path.join(outDir, 'build');
  const appDir = path.join(outDir, 'app');
  await rm(buildDir, { recursive: true, force: true });
  await rm(appDir, { recursive: true, force: true });
  await mkdir(path.join(appDir, 'sce_sys'), { recursive: true });
  await mkdir(buildDir, { recursive: true });

  // PkgTool.Core is a .NET app and the host has no ICU package; invariant mode is its own escape hatch.
  const env = { ...process.env, OO_PS4_TOOLCHAIN: toolchain, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' };
  const object = path.join(buildDir, `${stem}.o`);
  const elf = path.join(buildDir, `${stem}.elf`);
  const oelf = path.join(buildDir, `${stem}.oelf`);
  const eboot = path.join(appDir, 'eboot.bin');

  run('clang', ['--target=x86_64-pc-freebsd12-elf', '-fPIC', '-funwind-tables', '-c', '-isysroot', toolchain, '-isystem', path.join(toolchain, 'include'), '-o', object, source], { env });
  run('ld.lld', [object, '-o', elf, '-m', 'elf_x86_64', '-pie', '--script', path.join(toolchain, 'link.x'), '--eh-frame-hdr', `-L${path.join(toolchain, 'lib')}`, '-lc', '-lkernel', path.join(toolchain, 'lib', 'crt1.o')], { env });
  run(path.join(toolchain, 'bin', 'linux', 'create-fself'), [`-in=${elf}`, `-out=${oelf}`, '--eboot', 'eboot.bin', '--paid', '0x3800000000000011'], { env, cwd: appDir });

  const sfo = path.join(appDir, 'sce_sys', 'param.sfo');
  const pkgtool = path.join(toolchain, 'bin', 'linux', 'PkgTool.Core');
  run(pkgtool, ['sfo_new', sfo], { env });
  const entries = [
    ['APP_TYPE', 'Integer', '4', '1'],
    ['APP_VER', 'Utf8', '8', sfoFields.VERSION],
    ['ATTRIBUTE', 'Integer', '4', '0'],
    ['CATEGORY', 'Utf8', '4', 'gd'],
    ['CONTENT_ID', 'Utf8', '48', sfoFields.CONTENT_ID],
    ['DOWNLOAD_DATA_SIZE', 'Integer', '4', '0'],
    ['SYSTEM_VER', 'Integer', '4', '0'],
    ['TITLE', 'Utf8', '128', sfoFields.TITLE],
    ['TITLE_ID', 'Utf8', '12', sfoFields.TITLE_ID],
    ['VERSION', 'Utf8', '8', sfoFields.VERSION],
  ];
  for (const [key, type, maxsize, value] of entries) {
    run(pkgtool, ['sfo_setentry', sfo, key, '--type', type, '--maxsize', maxsize, '--value', value], { env });
  }

  return { appDir, artifacts: { object, elf, oelf, eboot, sfo } };
}

// E2's guest is built by the shell script next to this file: it clones six upstream repos at
// pinned commits and compiles a Mesa fork, which is its own recipe and its own length.
async function buildE2(outDir, toolchain) {
  runInherit('bash', [path.join(HERE, 'e2-build.sh'), '--out', outDir], { env: { ...process.env, OO_PS4_TOOLCHAIN: toolchain } });
  // TN_PS4_E2_GUEST isolates the layer on a red: `vk` is the same test with a pristine ICD
  // (is the readback patch the cause?), `gnm` is a plain GNM triangle (is vulkan-ps4 the cause?),
  // `vid` is the same guest with no vertex buffer or vertex-input state (is the fetch shader
  // the cause?).
  const alias = { e2: 'e2-triangle', vk: 'vk-triangle', gnm: 'gnm-triangle', vid: 'e2-triangle-vid' };
  const guest = alias[process.env.TN_PS4_E2_GUEST ?? 'e2'];
  if (!guest) throw new Error(`TN_PS4_E2_GUEST must be one of ${Object.keys(alias).join('|')}`);
  const appDir = path.join(outDir, 'out', guest, 'app');
  const eboot = path.join(appDir, 'eboot.bin');
  if (!existsSync(eboot)) throw new Error(`e2-build.sh wrote no ${eboot}`);
  return { appDir, artifacts: { eboot } };
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// The guest writes its frame to /data, which shadPS4 mounts at <XDG_DATA_HOME>/shadPS4/data
// inside the private HOME this run created (user_dir becomes <cwd>/user only if that exists).
// Copies it next to the run log and, when ImageMagick is installed, converts it to PNG.
// Returns the PPM to judge and the file to name; both '' when the guest wrote no frame.
async function collectFrame(outDir) {
  // Only the private HOME, which boot() deletes first: a stale frame elsewhere must not be judged.
  const source = path.join(outDir, 'home', '.local', 'share', 'shadPS4', 'data', 'tn_e2.ppm');
  if (!existsSync(source)) return { image: '', ppm: '' };
  const out = path.join(outDir, 'out');
  const ppm = path.join(out, 'tn_e2.ppm');
  await copyFile(source, ppm);
  // ImageMagick is optional: without it the PPM is the proof.
  const png = path.join(out, 'tn_e2.png');
  const converted = spawnSync('magick', [ppm, png], { encoding: 'utf8' });
  return { image: converted.status === 0 && existsSync(png) ? png : ppm, ppm };
}

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
async function boot(experiment, built, appimage, outDir) {
  const home = path.join(outDir, 'home');
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
  // A partial config is enough: Load() merges each named group over the defaults
  // (src/core/emulator_settings.cpp:363-386 at v.0.21.0), and these two are the whole point of
  // the run. Every experiment gets it; E1 does not care.
  await writeFile(
    path.join(env.XDG_DATA_HOME, 'shadPS4', 'config.json'),
    `${JSON.stringify({ GPU: { readbacks_mode: READBACKS_MODE, readback_linear_images_enabled: true } }, null, 2)}\n`,
  );
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  await mkdir(env.XDG_CACHE_HOME, { recursive: true });
  const logOut = path.join(outDir, 'out');
  await mkdir(logOut, { recursive: true });

  const wrapper = path.join(REPO_ROOT, 'scripts', 'xvfb.sh');
  if (!existsSync(wrapper)) throw new Error(`missing ${wrapper}`);
  const child = spawn('sh', [wrapper, appimage, '-g', built.artifacts.eboot], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk; });

  const timeoutMs = experiment.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  let log = '';
  let failure = '';
  let match = null;
  // The guest's stdout arrives twice: the emulator forwards it, and it lands in shad_log.txt.
  // A failure line from the guest ends the wait early and is the failure cause: a run that logs
  // a vk* error and then falls silent must not sit out the whole timeout.
  const scan = () => {
    const text = `${output}\n${log}`;
    if (experiment.failurePattern) {
      const hit = experiment.failurePattern.exec(text);
      if (hit) return { failure: `the guest logged: ${stripVTControlCharacters(hit[0]).trim()}` };
    }
    if (experiment.markerPattern) {
      const hit = experiment.markerPattern.exec(text);
      return hit ? { match: hit } : {};
    }
    return text.includes(experiment.marker) ? { match: [experiment.marker] } : {};
  };
  for (;;) {
    log = await readText(logFile);
    const seen = scan();
    if (seen.failure) {
      failure = seen.failure;
      break;
    }
    if (seen.match) {
      match = seen.match;
      break;
    }
    if (child.exitCode !== null) {
      failure = `shadPS4 exited (${child.exitCode ?? child.signalCode}) before the marker appeared`;
      break;
    }
    if (Date.now() > deadline) {
      failure = `no marker within ${timeoutMs / 1000}s`;
      break;
    }
    await delay(250);
  }

  await stop(child);
  await writeFile(path.join(logOut, 'run.log'), output);
  await writeFile(path.join(logOut, 'shad_log.txt'), log);
  return { match, failure, output, log, logFile };
}

async function main(argv) {
  const name = argv[2];
  const experiment = EXPERIMENTS[name];
  if (!experiment) {
    console.error(`usage: node packages/runtime-native/scripts/ps4/run-experiment.mjs <${Object.keys(EXPERIMENTS).join('|')}>`);
    return 2;
  }
  const label = `PS4_EMULATED ${name.toUpperCase()}`;
  const outDir = path.join(SCRATCH_ROOT, name);
  await mkdir(outDir, { recursive: true });

  const toolchain = await ensureToolchain();
  const appimage = await ensureEmulator();
  let built;
  try {
    built = await experiment.build(outDir, toolchain);
  } catch (error) {
    console.log(`${label} FAIL: build -- ${error.message}`);
    return 1;
  }
  const result = await boot(experiment, built, appimage, outDir);
  const frame = await collectFrame(outDir);
  const image = frame.image;

  // Pass rule: the experiment's own verdict over the marker it captured, and nothing else.
  const verdict = result.match ? await experiment.verdict(result.match, frame, result.log) : null;
  if (verdict?.ok) {
    console.log(`${label} PASS${verdict.detail}${image ? ` image=${image}` : ''}`);
    if (verdict.info) console.log(`${label} info:${verdict.info}`);
    return 0;
  }
  const reason = result.failure || (verdict && `${verdict.reason}${verdict.info ?? ''}`) || 'the guest printed no marker';
  const text = result.output.trim() ? result.output : result.log;
  const tail = text.trimEnd().split('\n').slice(-20).join('\n');
  const firmware = /sys_modules|firmware/i.test(result.output + result.log) ? ' (shadPS4 reported a firmware/sys_modules requirement)' : '';
  console.log(`${label} FAIL: ${reason}${firmware}${image ? ` image=${image}` : ''}\n${tail}`);
  return 1;
}

process.exitCode = await main(process.argv);
