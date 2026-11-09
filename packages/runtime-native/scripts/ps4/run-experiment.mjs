#!/usr/bin/env node
// PRD-784 PS4 experiments: build a guest program with the OpenOrbis toolchain, boot it in the
// shadPS4 emulator headless, and pass only when the guest prints its marker.
//
// Usage: node packages/runtime-native/scripts/ps4/run-experiment.mjs <e1|e2|e3|e4|e5|deploy|deps> [--scene <game dir>]
//        node packages/runtime-native/scripts/ps4/run-experiment.mjs --self-check
// `deploy` is the preview `pnpm ps4` runs: it boots the app folder send-to-console.mjs built and judges that
// the game booted and drew (a static start screen passes). `deps` only fetches the toolchain and emulator.
//
// Every product stays under the scratch root (sibling of the dependency root), one directory per
// experiment (<scratch>/e1, <scratch>/e2, <scratch>/e3, <scratch>/e4), never in the repo.
// shadPS4 reads no raw ELF: it wants a SELF (eboot.bin), which create-fself writes from our ELF.
// No Sony firmware module is downloaded or required; a run that asks for one fails.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageGuestUi } from './stage-guest-ui.mjs';

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

// E2's pass rule reads the frame shadPS4 PRESENTED, captured from the private X display: the
// guest's own count only proves what its readback buffer held. The triangle covers 12.5% of the
// frame; the band leaves room for a smaller or partly replaced draw, and rejects "nothing but the
// clear" and "no clear".
const E2_CLEAR = [26, 26, 51]; // 0.1, 0.1, 0.2 cleared as UNORM8
// E3's guest clears to 0.0, 0.0, 0.25 (e3-triangle.cc DrawInto) and draws the same triangle.
const E3_CLEAR = [0, 0, 64];
// E3CS's fragment colours the triangle from the compute result: outv[0] = 64 and outv[1] = 65 are
// written by the dispatch itself, so the drawn pixels are (64, 65, 0) only if the compute pass ran
// and its writes reached the buffer the fragment reads.
const E3CS_DRAWN = [64, 65, 0];
const E2_TOLERANCE = 8; // per-channel distance from the clear colour that counts as clear
const E2_CLEAR_MIN = 0.2;
const E2_DRAWN_MIN = 0.02;
const E5_CLOCK_SKEW_MAX = 0.05; // steady_clock vs libkernel's clock, per 100-frame window
const E2_DRAWN_MAX = 0.75;

// E5 presents a game's own frame, so its clear colour is whatever the scene clears to AFTER the
// stock filmic tone curve and metered auto exposure: it is read from the presented frame (its most
// common colour, the background) instead of guessed from the scene's clear value. TN_PS4_E5_CLEAR
// pins it -- "r,g,b" -- when a run needs a fixed answer. The bundled scene turns its cube every
// frame, so two captures at different times must differ over at least this much of the frame; a
// frozen, blank or never-presented frame changes nothing.
const E5_MOVED_MIN = 0.01;
const E5_FRAMES_MIN = 300;

// The game E5 bundles and boots: the smallest in-repo cube scene. examples/wasm-engine-boot is one
// lit box and a sphere over bare three, with no assets, no TSL, no post and no physics (PRD-540),
// which is the least a 300-frame proof can ask of the player. `--scene <dir>` or TN_PS4_SCENE runs
// any other game project, including one outside this repository.
const DEFAULT_E5_SCENE = path.join(REPO_ROOT, 'examples', 'wasm-engine-boot');
// What the e5 entry bundles: the default until main() reads --scene or TN_PS4_SCENE.
let sceneRoot = DEFAULT_E5_SCENE;

// The experiment name, then optionally the game project. --scene wins over TN_PS4_SCENE, and a
// relative path is read from where the runner was started. A name that is not an experiment is the
// same refusal as no name at all: the usage line, one place.
function parseArgs(argv) {
  const [name, ...rest] = argv;
  if (!EXPERIMENTS[name] && name !== 'deps')
    throw new Error(`usage: node packages/runtime-native/scripts/ps4/run-experiment.mjs <${[...Object.keys(EXPERIMENTS), 'deps'].join('|')}> [--scene <game dir>]`);
  let scene = process.env.TN_PS4_SCENE ?? '';
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--scene' || rest[i + 1] === undefined)
      throw new Error(`unknown argument ${rest[i]}: --scene <game dir> is the only option`);
    scene = rest[++i];
  }
  return { name, scene: scene ? path.resolve(scene) : DEFAULT_E5_SCENE };
}

// shadPS4 keeps render targets in host VRAM and writes them back to guest memory only when GPU
// readbacks are on (default Disabled: src/core/emulator_settings.h:421 at v.0.21.0). PS4 memory
// is unified, so a guest copying a rendered image reads stale memory without this -- a config
// fix, not a cheat. Relaxed=1, Precise=2; TN_PS4_READBACKS_MODE lets a red try the other mode.
const READBACKS_MODE = Number(process.env.TN_PS4_READBACKS_MODE ?? 2);

// What shadPS4 PRESENTS comes from its host image, which is not the guest memory a GPU-side copy
// of a render target reads. TN_PS4_SCREENSHOT_AT=3,5,7,9 captures the private X display's root
// window that many seconds after launch, so a screenshot separates "the draw never happened"
// from "the draw happened but the guest's readback reads stale memory". E2 always captures: its
// verdict is the presented frame, so it falls back to the experiment's own default times.
function captureTimes(fallback = []) {
  const times = (process.env.TN_PS4_SCREENSHOT_AT ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  for (const at of times) {
    if (!(Number(at) > 0)) throw new Error(`TN_PS4_SCREENSHOT_AT entries are seconds, got "${at}"`);
  }
  return times.length ? times : fallback;
}

// Shader dumps land in <UserDir>/shader/dumps as <stage>_<hash>.{bin,spv} plus the recompiler's IR
// (vk_pipeline_cache.cpp:747, shader_recompiler/ir/program.cpp:22 at v.0.21.0). config.json names
// the key dump_shaders; the camelCase dumpShaders spelling belongs to the config.toml migration.
const DUMP_SHADERS = process.env.TN_PS4_DUMP_SHADERS === '1';

// TN_PS4_GPU='{"window_width":320,"window_height":180}' merges extra GPUSettings fields
// (emulator_settings.h:414-470 at v.0.21.0) into the run's config.json, for present-path probes.
// The emulator runs inside gamescope at TN_PS4_HOST_HZ (default 144 when gamescope is on PATH), nested in the lane's Xvfb.
// Each present copied straight into Xvfb holds the guest at about 60 fps whatever its vblank; gamescope
// takes the frame with no copy and puts only a 320x180 output on Xvfb, where the captures still read it.
// The emulated vblank follows the host refresh unless TN_PS4_GPU names its own. TN_PS4_HOST_HZ=0 is the
// override: plain Xvfb, about 60 fps. The run prints which host it used.
const HOST_HZ_SET = (process.env.TN_PS4_HOST_HZ ?? '') !== '';
const HAS_GAMESCOPE = !spawnSync('gamescope', ['--help'], { stdio: 'ignore' }).error;
const HOST_HZ = HOST_HZ_SET ? Number(process.env.TN_PS4_HOST_HZ) : HAS_GAMESCOPE ? 144 : 0;
if (!(HOST_HZ >= 0)) throw new Error(`TN_PS4_HOST_HZ is a refresh rate in Hz or 0, got "${process.env.TN_PS4_HOST_HZ}"`);
const GPU_OVERRIDES = { ...(HOST_HZ ? { vblank_frequency: HOST_HZ } : {}), ...JSON.parse(process.env.TN_PS4_GPU || '{}') };

// A lost host device leaves one line: the driver reports VK_ERROR_DEVICE_LOST from vkQueueSubmit
// and says nothing about which access caused it (vk_scheduler.cpp:241 at v.0.21.0). The Khronos
// validation layer is the only account that does, and shadPS4 already routes its messages into
// its log (DebugUtilsCallback, vk_platform.cpp:307-365): GPU-assisted validation names the
// out-of-range read the driver faulted on, which core and sync validation cannot see because
// they stop at the dispatch call. All three are opt-in and off by default: GPU-AV serializes
// every dispatch and turns a 20 s boot into minutes. The layer is not bundled with shadPS4, so
// the loader needs VK_LAYER_PATH pointed at a Vulkan SDK (TN_PS4_VK_LAYER_PATH, or the caller's
// own VK_LAYER_PATH passes through). Crash diagnostics is a second, separate layer.
const VK_VALIDATION = process.env.TN_PS4_VK_VALIDATION === '1';
const VK_CRASH_DIAGNOSTIC = process.env.TN_PS4_VK_CRASH_DIAGNOSTIC === '1';
const VK_LAYER_PATH = process.env.TN_PS4_VK_LAYER_PATH ?? '';

// The texture repro's three arms: one guest source compiled three ways (see e3-build.sh). Each arm
// is its own experiment so a red names which build produced it. The triangle's orange reaches the
// presented frame only if the offscreen scene target was rendered AND sampled back, and both scene
// formats (float16, R8G8B8A8_UNORM) quantise 0.55 to the same 140.
const E3TEX_DRAWN = [255, 140, 0];
const e3TexExperiment = guest => ({
  timeoutMs: 300_000,
  screenshots: ['5', '7'],
  build: (outDir, toolchain) => buildE3(outDir, toolchain, guest),
  markerPattern: /TN_PS4_E3TEX frames=600 presented/,
  failurePattern: /TN_PS4_E3TEX error type=|buffer_cache\.cpp:\d+ [A-Za-z]+: Assertion Failed!/,
  verdict: (match, frame, log, shots) => judgeE3Tex(match, frame, log, shots),
});

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
    // The guest draws 600 frames before it prints, so both captures land while it still presents.
    screenshots: ['5', '7'],
    build: (outDir, toolchain) => buildE2(outDir, toolchain),
    // The guest's readback line ends the boot wait and is reported, but it is not the verdict:
    // E2's presented frame is judged on the host. The test also logs any vk* failure as
    // "TEST: ...".
    markerPattern: /TN_PS4_E2 pixels nonblank=(\d+) of (\d+)/,
    failurePattern: /TEST:[^\n]*FAILED/,
    verdict: (match, frame, log, shots) => judgeE2(match, frame, log, shots),
  },
  e3: {
    // Dawn (webgpu.h over vulkan-ps4) brings up a Vulkan device, compiles WGSL and presents 600
    // frames, on top of the boot E1 already pays for.
    timeoutMs: 300_000,
    // The guest presents 600 frames before it prints the marker, so both captures land while it
    // still presents.
    screenshots: ['5', '7'],
    build: (outDir, toolchain) => buildE3(outDir, toolchain),
    // The marker is what the guest prints after 600 presents: reaching it means the surface
    // configured, every frame drew, and every frame was handed to vulkan-ps4's VideoOut flip.
    markerPattern: /TN_PS4_E3 frames=600 presented/,
    // A Dawn uncaptured/device error is the engine's own account of the red; it ends the wait early.
    // `error type=` is the line the guest's error callback prints (e3-triangle.cc:107) -- a bare
    // /TN_PS4_E3 error/ also matches the guest's own success line "TN_PS4_E3 errors=0".
    failurePattern: /TN_PS4_E3 error type=/,
    verdict: (match, frame, log, shots) => judgeE3(match, frame, log, shots),
  },
  e3cs: {
    // The same Dawn guest as E3 (TN_PS4_E3_GUEST=e3cs) with one compute pipeline over two storage
    // buffers and a uniform, dispatched 512x1x1, whose result colours the triangle: the compute
    // path E5's device loss runs through, isolated from the engine's kits and its clear shader.
    timeoutMs: 300_000,
    screenshots: ['5', '7'],
    build: (outDir, toolchain) => buildE3(outDir, toolchain, 'e3cs'),
    markerPattern: /TN_PS4_E3CS frames=600 presented/,
    // A lost device is shadPS4's own abort, and it is the red this experiment exists to expose:
    // it ends the wait at once instead of sitting out the boot window.
    failurePattern: /TN_PS4_E3CS error type=|buffer_cache\.cpp:\d+ [A-Za-z]+: Assertion Failed!(?:\n[^\n]{0,80})?/,
    verdict: (match, frame, log, shots) => judgeE3CS(match, frame, log, shots),
  },
  e3tex: e3TexExperiment('e3tex'),
  e3tex8: e3TexExperiment('e3tex8'),
  e3texmsaa: e3TexExperiment('e3texmsaa'),
  e4: {
    // V8 builds a heap and compiles one script inside the emulator before it prints, on top of the
    // boot E1 already pays for.
    timeoutMs: 120_000,
    sfo: {
      TITLE: 'ThreeNative PS4 E4',
      TITLE_ID: 'TNPRD784E4',
      VERSION: '1.00',
      CONTENT_ID: 'IV0000-TNPRD784E4_00-TNPS4E4000000000',
    },
    build: (outDir, toolchain) => buildE4(outDir, toolchain),
    // The verdict is the value V8 COMPUTED: the guest source holds only '6*7', so an engine that
    // cannot run the script never prints 42, and a mode it did not take never matches either.
    markerPattern: /TN_PS4_E4 42 mode=(jitless|jit)/,
    // A V8 exception is the engine's own account of the red; it ends the wait early. So does a
    // thread_local that lost its init image (PT_TLS alignment, see ps4-malloc.c).
    failurePattern: /V8 error:|TN_PS4_E4 tls probe=(?!0x5a17c0de)/,
    verdict: match => ({ ok: true, detail: ` mode=${match[1]}` }),
  },
  e5: {
    // The engine's own V8 player: 21 engine archives, SDL3, Dawn and the V8 monolith boot before the
    // first frame, and past that 300 frames of jitless JS run on a software-rendered GPU.
    timeoutMs: 600_000,
    // A capture every 2 s while the player presents. The cube turns every frame, so two drawn frames
    // at different times differ only if the loop really ran. Boot time follows host load: a scene
    // with local exposure on drew its first frame at 13-14 s on a loaded host (load 11, PRD-784
    // P4-3), so a capture that is still all black is boot, not a verdict, and judgeE5 skips it.
    screenshots: ['8', '10', '12', '14', '16', '18'],
    build: (outDir, toolchain) => buildE5(outDir, toolchain, sceneRoot),
    // run.cpp counts presented frames on PS4 and prints one line per 100 (TN_PLAYER_FRAMES). The
    // marker waits for the 300-frame box, so a run that never gets there ends at the timeout and is
    // read from the TN_PLAYER_STAGE lines the player prints on the way.
    markerPattern: new RegExp(`TN_PLAYER_FRAMES (${E5_FRAMES_MIN}|[4-9]\\d\\d|\\d{4,})`),
    // A JS-side failure is a valid fail-closed result when it names the call: the player exits with
    // the V8 error on stderr, or the game never publishes a scene. An emulator crash (ASSERT_MSG
    // aborts with "Assertion Failed!") is a red of the GPU stack under the player, and its line
    // names the pass that refused the shader.
    failurePattern: /(?:TN_PLAYER_V8_GAME:|TN_V8_UPDATE_FAILED|TN_V8_FRAME_FAILED|TN_PLAYER_NO_SCENE)[^\n]*|TN_PS4_E5 stage=exit status=[1-9]|[\w./_-]+\.cpp:\d+ \w+: Assertion Failed!(?:\n[^\n]{0,80})?/,
    verdict: (match, frame, log, shots) => judgeE5(match, frame, log, shots),
  },
};

// The deploy preview: the same player, marker and failure patterns as e5, over the app folder
// send-to-console.mjs already built (the package carries those same bytes). The verdict drops E5's
// moving-cube rule: a game's start screen may be static. Captures come late because a loaded host
// boots slowly; TN_PS4_SCREENSHOT_AT overrides.
EXPERIMENTS.deploy = {
  ...EXPERIMENTS.e5,
  screenshots: ['30', '45'],
  build: async outDir => {
    const appDir = path.join(outDir, 'out', 'app');
    const eboot = path.join(appDir, 'eboot.bin');
    if (!existsSync(eboot) || !existsSync(path.join(appDir, 'game.js')))
      throw new Error(`no built app in ${appDir}: run \`pnpm ps4 <game dir>\`, which builds it first`);
    return { appDir, artifacts: { eboot } };
  },
  verdict: (match, frame, log, shots) => judgeE5(match, frame, log, shots, { motion: false }),
};

// TN_PS4_GDB=<gdb command file> debugs the emulator instead of only running it. shadPS4 executes
// guest x86-64 natively at the guest's own addresses, so one host breakpoint or watchpoint sees
// guest code and guest data (e4-gdb-isolate-slot.gdb is the E4 example). The AppImage is a stub
// that forks AppRun (a shell script) and the emulator below it as separate processes, and gdb
// inside the stub debugs one of those instead of the emulator, so the emulator binary comes out of
// the image and AppRun's own env is what this run already provides. The run keeps the isolation
// env, the private HOME and the experiment's own timeout.
const gdbCommands = process.env.TN_PS4_GDB ? path.resolve(process.env.TN_PS4_GDB) : '';
async function emulatorUnderGdb(appimage) {
  if (!existsSync(gdbCommands)) throw new Error(`TN_PS4_GDB names no file: ${gdbCommands}`);
  const root = path.join(path.dirname(appimage), 'squashfs-root');
  const binary = path.join(root, 'usr/bin/shadps4');
  if (!existsSync(binary)) {
    // --appimage-extract writes squashfs-root beside the image; AppRun execs usr/bin/shadps4 with
    // LD_LIBRARY_PATH only (that script is the one process chain gdb must not enter).
    run(appimage, ['--appimage-extract'], { cwd: path.dirname(appimage) });
    if (!existsSync(binary)) throw new Error(`${appimage} extracted no ${binary}`);
  }
  return binary;
}

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

// Clear = the guest's clear colour; drawn = anything else that is not black. Black is what a
// whole-screenshot capture holds where nothing rendered, so it is neither.
//
// Every pixel is measured only inside the box that carries the clear colour, not over the whole
// screenshot: the capture is the emulator's WINDOW, so it also holds the host's letterbox around
// the presented image -- black on one host, grey (128,128,128) on another -- which no guest drew.
// The box is that image, with the draw inside it. ponytail: one box, so an off-image stray pixel
// of the clear colour would widen it; the frames this judges are flat colour plus the draw.
// The box holding every pixel of the clear colour; an empty box (right < left) means the guest
// presented nothing. See countRegions for why the box and not the whole capture.
function clearBox({ width, height, pixels }, clearColour) {
  const box = { left: width, top: height, right: -1, bottom: -1 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!nearClear(pixels, (y * width + x) * 3, clearColour)) continue;
      box.left = Math.min(box.left, x);
      box.right = Math.max(box.right, x);
      box.top = Math.min(box.top, y);
      box.bottom = Math.max(box.bottom, y);
    }
  }
  return box;
}

function nearClear(pixels, at, clearColour) {
  return (
    Math.abs(pixels[at] - clearColour[0]) <= E2_TOLERANCE &&
    Math.abs(pixels[at + 1] - clearColour[1]) <= E2_TOLERANCE &&
    Math.abs(pixels[at + 2] - clearColour[2]) <= E2_TOLERANCE
  );
}

// Pixels within E2_TOLERANCE of `colour`, inside the same presented-image box countRegions uses.
// The compute repro's colour is the only thing on screen that proves the dispatch's writes reached
// the buffer, so this is measured, not assumed.
function countColour(raster, colour) {
  const { width, pixels } = raster;
  const { left, top, right, bottom } = clearBox(raster, colour);
  if (right < left) return 0;
  let n = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const at = (y * width + x) * 3;
      if (Math.abs(pixels[at] - colour[0]) <= E2_TOLERANCE &&
          Math.abs(pixels[at + 1] - colour[1]) <= E2_TOLERANCE &&
          Math.abs(pixels[at + 2] - colour[2]) <= E2_TOLERANCE) n++;
    }
  }
  return n;
}

function countRegions(raster, clearColour) {
  const { width, pixels } = raster;
  const { left, top, right, bottom } = clearBox(raster, clearColour);
  let clear = 0;
  let drawn = 0;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      const at = (y * width + x) * 3;
      if (pixels[at] <= 8 && pixels[at + 1] <= 8 && pixels[at + 2] <= 8) continue;
      if (nearClear(pixels, at, clearColour)) clear++;
      else drawn++;
    }
  }
  return { clear, drawn };
}

// The screenshot is a PNG; ImageMagick already on the lane (the captures use it) converts it to
// the P6 raster readPpm reads, so no npm decoder. 8-bit output keeps maxval at the 255 readPpm
// requires whatever depth the source claims.
function pngToPpm(file) {
  const args = [file, '-depth', '8', 'ppm:-'];
  for (const command of ['magick', 'convert']) {
    const converted = spawnSync(command, args, { maxBuffer: 1 << 30 });
    if (converted.error) {
      if (converted.error.code === 'ENOENT') continue;
      throw converted.error;
    }
    if (converted.status !== 0)
      throw new Error(`${command} exited ${converted.status ?? converted.signal}: ${String(converted.stderr ?? '').trim()}`);
    return converted.stdout;
  }
  throw new Error('neither magick nor convert is on PATH, so the screenshot cannot be read');
}

// A presented-frame verdict: the config must have taken effect (else a red frame blames the wrong
// layer), then the LAST host screenshot -- what shadPS4 presented -- must hold the guest's clear
// colour and a triangle over it. The guest's own readback is information only: CopyBuffer copies
// guest memory, and shadPS4 never flushes a source render target into it (v.0.21.0), so it reads
// clear even when the frame on screen holds the draw. A missing, unreadable or all-black screenshot
// fails: an absent observation is not a pass. E2 and E3 present the same shape of frame (one clear
// colour plus one triangle) and differ only in the colour and in what the guest says about itself.
async function judgePresented(log, shots, { clearColour, requireReadbacks, info, presentColour }) {
  if (requireReadbacks) {
    const wanted = `GPU readbacksMode: ${READBACKS_MODE}`;
    if (!log.includes(wanted) || !log.includes('GPU readbackLinearImages: true'))
      return {
        ok: false,
        reason: `shadPS4 did not take the config: its log lacks "${wanted}" and/or "GPU readbackLinearImages: true"`,
      };
  }
  const image = shots.at(-1) ?? '';
  if (!image) return { ok: false, reason: 'the run saved no host screenshot, so there is no presented frame to judge', info };
  let raster;
  try {
    raster = readPpm(pngToPpm(image));
  } catch (error) {
    return { ok: false, reason: `${image} is unreadable: ${error.message}`, info };
  }
  const { clear, drawn } = countRegions(raster, clearColour);
  const nonBlack = clear + drawn;
  if (!nonBlack)
    return {
      ok: false,
      reason: `${image} holds no clear pixel (or nothing but black), so the guest presented no frame`,
      info,
      image,
    };
  const clearPct = clear / nonBlack;
  const drawnPct = drawn / nonBlack;
  const counts = `clear=${(clearPct * 100).toFixed(2)}% drawn=${(drawnPct * 100).toFixed(2)}% of ${nonBlack} presented pixels`;
  const failed = reason => ({ ok: false, reason: `${counts}, ${reason}`, info, image });
  if (clearPct < E2_CLEAR_MIN) return failed(`below the ${E2_CLEAR_MIN * 100}% clear, so the guest's clear never reached the screen`);
  if (drawnPct < E2_DRAWN_MIN) return failed(`drawn below the ${E2_DRAWN_MIN * 100}% band, so the frame is only the clear colour`);
  if (drawnPct > E2_DRAWN_MAX) return failed(`drawn above the ${E2_DRAWN_MAX * 100}% band, so nothing cleared the frame`);
  // The draw's colour is a measurement of the step before it: the triangle is all one colour, so
  // the pixels carrying it are the proof that the compute result reached the presented frame.
  if (presentColour) {
    const share = countColour(raster, presentColour) / drawn;
    if (share < 0.5)
      return failed(`only ${(share * 100).toFixed(2)}% of the drawn pixels are (${presentColour.join(', ')})`);
    return {
      ok: true,
      detail: ` drawn=${(drawnPct * 100).toFixed(2)}% colour=${presentColour.join(',')} share=${(share * 100).toFixed(2)}%`,
      info,
      image,
    };
  }
  return { ok: true, detail: ` drawn=${(drawnPct * 100).toFixed(2)}%`, info, image };
}

// E2's verdict: the readback config must have taken effect, then the presented frame. The guest's
// readback count is reported as information, not judged (see judgePresented).
async function judgeE2(match, frame, log, shots) {
  return judgePresented(log, shots, {
    clearColour: E2_CLEAR,
    requireReadbacks: true,
    info: ` guest-readback=${match[1]} of ${match[2]} (stale: shadPS4 CopyBuffer does not flush render targets)`,
  });
}

// E3's verdict: the presented frame, plus the adapter and limits the guest logged. Those lines are
// the evidence that Dawn reached an adapter and a device over vulkan-ps4 at all -- a frame alone
// would not say which backend drew it, and the limits are the numbers a later lane budgets against.
async function judgeE3(match, frame, log, shots) {
  const line = pattern => pattern.exec(log)?.[1]?.trim() ?? '(missing)';
  const adapter = line(/TN_PS4_E3 adapter=([^\n]*)/);
  const limits = line(/TN_PS4_E3 limits ([^\n]*)/);
  const info = ` adapter=${adapter} limits ${limits}`;
  const verdict = await judgePresented(log, shots, { clearColour: E3_CLEAR, requireReadbacks: false, info });
  return verdict.ok ? { ...verdict, detail: `${verdict.detail} adapter=${adapter} limits ${limits}` } : verdict;
}

// E3CS's verdict: the presented frame, and the triangle's colour is the compute result. A device
// lost at the dispatch never presents a frame at all, so the two failures stay apart.
async function judgeE3CS(match, frame, log, shots) {
  const cs = /TN_PS4_E3CS cs=([a-z]+)/.exec(log)?.[1] ?? '(missing)';
  const error = /TN_PS4_E3CS error type=\d+ msg=([^\n]*)/.exec(log)?.[1]?.trim() ?? '';
  const info = ` cs=${cs}${error ? ` error=${error}` : ''}`;
  return judgePresented(log, shots, {
    clearColour: E3_CLEAR,
    requireReadbacks: false,
    presentColour: E3CS_DRAWN,
    info,
  });
}

// E3TEX's verdict: the scene target's own triangle, in the scene target's own colour, appears in
// the frame the emulator presented. Pass B has no vertex buffer and no colour source of its own, so
// those pixels can only arrive through the T#/S# hand-off from the offscreen render -- which is the
// one thing this experiment exists to measure. The fraction is measured over the whole presented
// raster (the private X root, with shadPS4's window inside it), the same count for every arm.
async function judgeE3Tex(match, frame, log, shots) {
  const sampled = /TN_PS4_E3TEX sampled=([^\n]*)/.exec(log)?.[1]?.trim() ?? '(missing)';
  const info = ` sampled=${sampled}`;
  const image = shots.at(-1) ?? '';
  if (!image)
    return { ok: false, reason: 'the run saved no host screenshot, so there is no presented frame to judge', info };
  let raster;
  try {
    raster = readPpm(pngToPpm(image));
  } catch (error) {
    return { ok: false, reason: `${image} is unreadable: ${error.message}`, info };
  }
  const share = countColour(raster, E3TEX_DRAWN) / (raster.width * raster.height);
  const detail = ` sampled-colour=${(share * 100).toFixed(2)}% of the presented frame`;
  if (share < E2_DRAWN_MIN)
    return {
      ok: false,
      reason: `only ${(share * 100).toFixed(2)}% of ${image} carries the scene target's triangle (${E3TEX_DRAWN.join(', ')}), so the offscreen render did not reach the sampler`,
      info: detail,
      image,
    };
  if (share > E2_DRAWN_MAX)
    return { ok: false, reason: `${(share * 100).toFixed(2)}% of ${image} is the triangle colour, above the ${E2_DRAWN_MAX * 100}% band`, info: detail, image };
  return { ok: true, detail, info, image };
}

// The colour a presented frame cleared to: its most common colour. A game's clear reaches the
// screen through the stock filmic tone curve and metered auto exposure, so the value in the scene
// is not the value a judge can match; the background is. TN_PS4_E5_CLEAR="r,g,b" pins it.
function e5ClearColour({ width, height, pixels }) {
  const pinned = (process.env.TN_PS4_E5_CLEAR ?? '').split(',').map(Number).filter(Number.isFinite);
  if (pinned.length === 3) return pinned;
  const counts = new Map();
  for (let at = 0; at < width * height * 3; at += 3) {
    const key = (pixels[at] << 16) | (pixels[at + 1] << 8) | pixels[at + 2];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let common = 0;
  let seen = -1;
  for (const [key, count] of counts) {
    if (count > seen) {
      common = key;
      seen = count;
    }
  }
  return [(common >> 16) & 255, (common >> 8) & 255, common & 255];
}

// The share of the frame that changed between two captures, over the pixels both carry. Two frames
// of a turning cube differ over the silhouette it moved across; identical or never-drawn frames
// differ by nothing.
// `rect` [x0, y0, x1, y1] limits the count to the guest window inside a larger X root.
function differingFraction(a, b, rect) {
  const pixels = Math.min(a.width * a.height, b.width * b.height);
  if (!pixels) return 0;
  const [x0, y0, x1, y1] = rect ?? [0, 0, a.width - 1, Math.floor(pixels / a.width) - 1];
  let differing = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const at = (y * a.width + x) * 3;
      if ([0, 1, 2].some(channel => Math.abs(a.pixels[at + channel] - b.pixels[at + channel]) > E2_TOLERANCE)) differing++;
    }
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  return total > 0 ? differing / total : 0;
}

// E5's verdict: the player presented the 300 frames the box asks for, the presented frame holds the
// scene's own clear colour with the game drawn inside it, and two frames at different times differ
// (the cube moved). The guest's own count is what the marker carries; the frames are judged on the
// host, because a guest GPU readback reads stale memory on shadPS4 (see judgePresented).
// `motion: false` is the deploy rule (`pnpm ps4`): a game's start screen may be static, so the pass is
// "booted, presented frames, and a captured frame is drawn" -- no second frame, no moving cube, no
// upper bound on the drawn share (a full-screen scene is mostly one colour), no frame-time windows.
async function judgeE5(match, frame, log, captures, { motion = true } = {}) {
  const frames = Number(match[1]);
  const info = ` frames=${frames}`;
  if (!(frames >= E5_FRAMES_MIN))
    return { ok: false, reason: `TN_PLAYER_FRAMES ${frames}: the player presented fewer than ${E5_FRAMES_MIN} frames`, info };
  let rasters;
  try {
    rasters = captures.map(file => ({ file, raster: readPpm(pngToPpm(file)) }));
  } catch (error) {
    return { ok: false, reason: `a host screenshot is unreadable: ${error.message}`, info };
  }
  return judgeE5Rasters({ frames, info, log, rasters, motion });
}

// The decision over decoded captures, pure so the self-check can feed it synthetic frames.
function judgeE5Rasters({ frames, info, log, rasters, motion }) {
  const captures = rasters.map(({ file }) => file);
  // A capture under 1% non-black was taken before the guest's first drawn frame (shadPS4 paints a few
  // grey pixels outside the game window from launch): boot, skipped.
  const lit = ({ pixels, width, height }) => {
    let count = 0;
    for (let at = 0; at < pixels.length; at += 3) if (pixels[at] || pixels[at + 1] || pixels[at + 2]) count += 1;
    return count / (width * height) >= 0.01;
  };
  const drawn = rasters.filter(({ raster }) => lit(raster));
  if (drawn.length < (motion ? 2 : 1))
    return {
      ok: false,
      reason: `${drawn.length} of ${captures.length} host screenshot(s) show anything but black (${captures.map(f => path.basename(f)).join(', ')}): a green run needs ${motion ? 'two drawn frames, at different times, to prove the cube moved' : 'one drawn frame'}`,
      info,
    };
  const shots = drawn.map(({ file }) => file);
  const first = drawn[0].raster;
  const last = drawn.at(-1).raster;
  const clear = e5ClearColour(last);
  // The largest change from the first drawn frame: a cube turned by a multiple of 90 degrees looks the
  // same, so the first and last frames alone can alias to "did not move" (Cube Spin: 3.2% at +6 s, 0.59% at +12 s).
  const moved = Math.max(0, ...drawn.slice(1).map(({ raster }) => differingFraction(first, raster)));
  // run.cpp averages the game's JS update and the whole frame over each 100 presented frames.
  const windows = [...log.matchAll(/TN_PLAYER_FRAMES \d+ js_ms=([\d.]+) frame_ms=([\d.]+)(?: kernel_frame_ms=([\d.]+))?/g)];
  // The first window has no start time and prints 0: the last window with a real measurement counts.
  const timing = windows.filter(w => Number(w[2]) > 0).at(-1);
  const fps = timing && Number(timing[3] ?? timing[2]) > 0 ? 1000 / Number(timing[3] ?? timing[2]) : 0;
  const detail = ` frames=${frames} clear=${clear.join(',')} moved=${(moved * 100).toFixed(2)}%${timing ? ` js_ms=${timing[1]} frame_ms=${timing[2]} kernel_frame_ms=${timing[3] ?? '?'} fps=${fps.toFixed(1)}` : ''}`;
  // steady_clock drives the game's dt: it must agree with libkernel's wall clock in every measured
  // window, or the game runs at the wrong speed (musl's CLOCK_MONOTONIC once read CPU time).
  const skewed = windows.filter(w => w[3] !== undefined && Number(w[3]) > 0 && Number(w[2]) > 0)
    .find(w => Math.abs(Number(w[2]) / Number(w[3]) - 1) > E5_CLOCK_SKEW_MAX);
  if (!timing && motion)
    return { ok: false, reason: `no measured 100-frame window: ${windows.length} TN_PLAYER_FRAMES line(s), none with frame_ms > 0 (did the guest stdout reach the log?)`, info: detail };
  if (skewed && motion)
    return { ok: false, reason: `steady_clock frame_ms=${skewed[2]} disagrees with libkernel's kernel_frame_ms=${skewed[3]} by more than ${E5_CLOCK_SKEW_MAX * 100}%: the guest clock is not wall time`, info: detail };
  // A scene with no background clears to black, and judgePresented treats black as "nothing
  // presented" (right for E2/E3, whose clear is not black). E5 instead measures the share of the
  // whole frame that differs from the clear: the box and sphere must cover part of it, not all.
  // Only the guest window counts: the X root around it (the corner pixel, when that is not the
  // clear) would otherwise pass an empty black window as a drawn scene.
  const px = (x, y, c) => last.pixels[(y * last.width + x) * 3 + c];
  const backdrop = [0, 1, 2].map(c => px(0, 0, c));
  const framed = backdrop.some((v, c) => v !== clear[c]);
  let [x0, y0, x1, y1] = [0, 0, last.width - 1, last.height - 1];
  if (framed) {
    [x0, y0, x1, y1] = [last.width, last.height, -1, -1];
    for (let y = 0; y < last.height; y++)
      for (let x = 0; x < last.width; x++)
        if ([0, 1, 2].some(c => px(x, y, c) !== backdrop[c]))
          [x0, y0, x1, y1] = [Math.min(x0, x), Math.min(y0, y), Math.max(x1, x), Math.max(y1, y)];
  }
  const total = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1);
  let off = 0;
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++)
      if (Math.max(...[0, 1, 2].map(c => Math.abs(px(x, y, c) - clear[c]))) > E2_TOLERANCE) off += 1;
  const drawnShare = total ? off / total : 0;
  if (drawnShare < E2_DRAWN_MIN || (motion && drawnShare > E2_DRAWN_MAX))
    return {
      ok: false,
      reason: `${(drawnShare * 100).toFixed(2)}% of ${shots.at(-1)} differs from the clear, outside the ${E2_DRAWN_MIN * 100}-${motion ? E2_DRAWN_MAX * 100 : 100}% band a drawn scene covers`,
      info: detail,
      image: shots.at(-1),
    };
  // Movement counts inside the guest window: a small shadPS4 window (TN_PS4_GPU window_width) would
  // otherwise dilute the cube's change over the whole X root.
  // The window is what differs from the root corner, even when the root grey equals the clear.
  let win = [last.width, last.height, -1, -1];
  for (let y = 0; y < last.height; y++)
    for (let x = 0; x < last.width; x++)
      if ([0, 1, 2].some(c => px(x, y, c) !== backdrop[c]))
        win = [Math.min(win[0], x), Math.min(win[1], y), Math.max(win[2], x), Math.max(win[3], y)];
  if (win[2] < 0) win = [0, 0, last.width - 1, last.height - 1];
  const movedWindow = Math.max(...drawn.slice(1).map(({ raster }) => differingFraction(first, raster, win)));
  const verdict = { ok: true, detail: ` drawn=${(drawnShare * 100).toFixed(2)}% moved_window=${(movedWindow * 100).toFixed(2)}%`, info: detail, image: shots.at(-1) };
  if (motion && movedWindow < E5_MOVED_MIN)
    return {
      ok: false,
      reason: `${(movedWindow * 100).toFixed(2)}% of the guest window differs at most between ${shots[0]} and any later drawn frame (${shots.slice(1).map(f => path.basename(f)).join(", ")}), below the ${E5_MOVED_MIN * 100}% a moving cube must change`,
      info: detail,
      image: verdict.image,
    };
  return { ...verdict, detail: `${verdict.detail}${detail}` };
}

// The run's host screenshots, oldest first: <out>/screen-<seconds>.png, one per requested time.
async function screenShots(out) {
  const names = (await readdir(out).catch(() => [])).filter(name => /^screen-\d+(\.\d+)?\.png$/.test(name));
  return names
    .map(name => ({ at: Number(name.slice('screen-'.length, -'.png'.length)), file: path.join(out, name) }))
    .sort((a, b) => a.at - b.at)
    .map(entry => entry.file);
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

  const env = { ...process.env, OO_PS4_TOOLCHAIN: toolchain };
  const object = path.join(buildDir, `${stem}.o`);
  const elf = path.join(buildDir, `${stem}.elf`);
  const oelf = path.join(buildDir, `${stem}.oelf`);
  const eboot = path.join(appDir, 'eboot.bin');

  run('clang', ['--target=x86_64-pc-freebsd12-elf', '-fPIC', '-funwind-tables', '-c', '-isysroot', toolchain, '-isystem', path.join(toolchain, 'include'), '-o', object, source], { env });
  run('ld.lld', [object, '-o', elf, '-m', 'elf_x86_64', '-pie', '--script', path.join(toolchain, 'link.x'), '--eh-frame-hdr', `-L${path.join(toolchain, 'lib')}`, '-lc', '-lkernel', path.join(toolchain, 'lib', 'crt1.o')], { env });
  run(path.join(toolchain, 'bin', 'linux', 'create-fself'), [`-in=${elf}`, `-out=${oelf}`, '--eboot', 'eboot.bin', '--paid', '0x3800000000000011'], { env, cwd: appDir });

  const sfo = path.join(appDir, 'sce_sys', 'param.sfo');
  writeSfo(sfo, sfoFields, toolchain);

  return { appDir, artifacts: { object, elf, oelf, eboot, sfo } };
}

// The title metadata every PS4 app folder carries, written by PkgTool.Core: generated here, never
// copied out of a dumped game. PkgTool.Core is a .NET app and the host has no ICU package;
// invariant mode is its own escape hatch.
function writeSfo(sfo, fields, toolchain) {
  const env = { ...process.env, OO_PS4_TOOLCHAIN: toolchain, DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' };
  const pkgtool = path.join(toolchain, 'bin', 'linux', 'PkgTool.Core');
  run(pkgtool, ['sfo_new', sfo], { env });
  const entries = [
    ['APP_TYPE', 'Integer', '4', '1'],
    ['APP_VER', 'Utf8', '8', fields.VERSION],
    ['ATTRIBUTE', 'Integer', '4', '0'],
    ['CATEGORY', 'Utf8', '4', 'gd'],
    ['CONTENT_ID', 'Utf8', '48', fields.CONTENT_ID],
    ['DOWNLOAD_DATA_SIZE', 'Integer', '4', '0'],
    ['SYSTEM_VER', 'Integer', '4', '0'],
    ['TITLE', 'Utf8', '128', fields.TITLE],
    ['TITLE_ID', 'Utf8', '12', fields.TITLE_ID],
    ['VERSION', 'Utf8', '8', fields.VERSION],
  ];
  for (const [key, type, maxsize, value] of entries) {
    run(pkgtool, ['sfo_setentry', sfo, key, '--type', type, '--maxsize', maxsize, '--value', value], { env });
  }
}

// E2's guest is built by the shell script next to this file: it clones six upstream repos at
// pinned commits and compiles a Mesa fork, which is its own recipe and its own length.
async function buildE2(outDir, toolchain) {
  runInherit('bash', [path.join(HERE, 'e2-build.sh'), '--out', outDir], { env: { ...process.env, OO_PS4_TOOLCHAIN: toolchain } });
  // `vid` is the guest that presents: it is one source with one define, so a red still isolates
  // the fetch shader. TN_PS4_E2_GUEST isolates the layer on a red: `vk` is the same test with a
  // pristine ICD (is the readback patch the cause?), `gnm` is a plain GNM triangle (is
  // vulkan-ps4 the cause?), `e2` is the vertex-buffer build (is the fetch shader the cause?)
  // and `vid` the same guest with no vertex buffer or vertex-input state.
  const alias = { e2: 'e2-triangle', vk: 'vk-triangle', gnm: 'gnm-triangle', vid: 'e2-triangle-vid' };
  const guest = alias[process.env.TN_PS4_E2_GUEST ?? 'vid'];
  if (!guest) throw new Error(`TN_PS4_E2_GUEST must be one of ${Object.keys(alias).join('|')}`);
  const appDir = path.join(outDir, 'out', guest, 'app');
  const eboot = path.join(appDir, 'eboot.bin');
  if (!existsSync(eboot)) throw new Error(`e2-build.sh wrote no ${eboot}`);
  return { appDir, artifacts: { eboot } };
}

// E3's guest is Dawn itself: e3-build.sh owns the pins, the seven patches, the CMake/Ninja tree
// and the build stamps, so a rerun that changes nothing builds nothing.
async function buildE3(outDir, toolchain, guest = 'e3-triangle') {
  runInherit(
    'bash',
    [path.join(HERE, 'e3-build.sh'), '--out', outDir],
    { env: { ...process.env, OO_PS4_TOOLCHAIN: toolchain, TN_PS4_E3_GUEST: guest } },
  );
  // The whole app folder (eboot.bin + sce_sys/param.sfo) is that script's product: the title
  // metadata belongs with the app it boots, not with the harness that boots it. One folder per
  // guest build, the same rule e3-build.sh writes them with.
  const appDir = path.join(outDir, 'out', guest, 'app');
  const eboot = path.join(appDir, 'eboot.bin');
  if (!existsSync(eboot)) throw new Error(`e3-build.sh wrote no ${eboot}`);
  return { appDir, artifacts: { eboot } };
}

// E4's guest is a jitless V8 monolith (2715 gn/ninja steps) plus its embedder: e4-build.sh owns
// the pins, the patches and the build stamp, so a rerun that changes nothing builds nothing.
async function buildE4(outDir, toolchain) {
  runInherit('bash', [path.join(HERE, 'e4-build.sh'), '--out', outDir], { env: { ...process.env, OO_PS4_TOOLCHAIN: toolchain } });
  const product = path.join(outDir, 'out', 'eboot.bin');
  if (!existsSync(product)) throw new Error(`e4-build.sh wrote no ${product}`);
  // shadPS4 boots an app folder -- eboot.bin beside sce_sys/param.sfo -- the same shape as E1's.
  const appDir = path.join(outDir, 'out', 'app');
  const eboot = path.join(appDir, 'eboot.bin');
  await mkdir(path.join(appDir, 'sce_sys'), { recursive: true });
  await copyFile(product, eboot);
  writeSfo(path.join(appDir, 'sce_sys', 'param.sfo'), EXPERIMENTS.e4.sfo, toolchain);
  return { appDir, artifacts: { eboot } };
}

// E5's guest is the engine's own V8 player (e5-build.sh owns the ninja step, ld.lld, create-fself
// and the SELF) plus the game bundle the player opens at /app0/game.js. bundle-native-engine.mjs
// writes that one IIFE and cooks the scene's assets beside it; an unbound name fails the bundle by
// name (TN_NATIVE_ENGINE_UNBOUND), which is the honest red for a game the player cannot run.
async function buildE5(outDir, toolchain, scene) {
  // The scene is checked before the build: a wrong --scene fails in a second, not after it.
  const entry = path.join(scene, 'src', 'game.ts');
  if (!existsSync(entry)) throw new Error(`scene ${scene} has no src/game.ts (--scene names a game project)`);
  // A scene with a native-css HUD names it in src/native.tsx; otherwise src/game.ts is the entry.
  const nativeEntry = existsSync(path.join(scene, 'src', 'native.tsx')) ? path.join(scene, 'src', 'native.tsx') : entry;
  runInherit('bash', [path.join(HERE, 'e5-build.sh'), '--out', outDir], { env: { ...process.env, OO_PS4_TOOLCHAIN: toolchain } });
  const appDir = path.join(outDir, 'out', 'app');
  const eboot = path.join(appDir, 'eboot.bin');
  if (!existsSync(eboot)) throw new Error(`e5-build.sh wrote no ${eboot}`);
  const bundle = path.join(appDir, 'game.js');
  run(process.execPath, [
    path.join(REPO_ROOT, 'packages/runtime-native/scripts/bundle-native-engine.mjs'),
    '--engine', 'native', '--game-runtime', 'v8', '--entry', nativeEntry, '--out', bundle, '--assets', scene,
  ]);
  if (!existsSync(bundle)) throw new Error(`the bundler wrote no ${bundle}`);
  // PRD-784: the guest draws a HUD with the native-css backend when /app0/ui exists. The scene's
  // src/native.tsx (createCssUiRoot().render(...), default-exporting the game) runs React in the
  // game's V8; its built stylesheets come from .threenative/build/ui-css or TN_PS4_UI_DIR.
  const ui = stageGuestUi(scene, appDir);
  if (existsSync(path.join(scene, 'src', 'native.tsx')) && !ui)
    throw new Error(`scene ${scene} has src/native.tsx but no built UI (build ${path.join(scene, '.threenative/build/ui-css')} or set TN_PS4_UI_DIR)`);
  // A scene with no asset files gets no pack (the player opens native/assets.tnpk only when the
  // game asks for an asset), so its absence is a fact about the scene, not a build failure.
  const assets = path.join(appDir, 'native', 'assets.tnpk');
  return { appDir, artifacts: { eboot, bundle, assets: existsSync(assets) ? assets : '', ui } };
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return '';
  }
}

// The owner's jitless JS cost, when the player measured it: core prints a windowed
// TN_FRAME_BUDGET line whose `frame` summary is the game's own frame callback, entry to exit. One
// summary line -- the median of the windows' p50s -- so a run's JS cost is on record without a
// second instrument. A run that presents no frame has no window and prints nothing.
function frameBudgetMs(text) {
  const windows = [];
  for (const match of text.matchAll(/TN_FRAME_BUDGET:(\{[^\n]*\})/g)) {
    try {
      const window = JSON.parse(stripVTControlCharacters(match[1]));
      if (Number.isFinite(window.frame?.p50)) windows.push(window.frame.p50);
    } catch {
      // A log can be read in the middle of a write: half a line is not a window.
    }
  }
  if (!windows.length) return '';
  const sorted = [...windows].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return `js median ${median.toFixed(2)} ms/frame (frame.p50 over ${windows.length} window${windows.length === 1 ? '' : 's'})`;
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

// $1 = appimage, $3 = eboot, $4 = output directory, $5.. = capture times in seconds.
// `import -window root -screen` reads the displayed pixels: a bare root-window grab misses what a
// compositor draws through the composite overlay window.
const CAPTURE_SCRIPT = `out="$4"
appimage="$1"
eboot="$3"
shift 4
$TN_PS4_HOST_WRAP "$appimage" -g "$eboot" &
game=$!
# shadPS4 can run as its own session leader, out of the process group the runner stops, and then it
# holds the runner's pipes open forever (a 2 h 20 min hang). Stop it by its PID here.
trap 'kill "$game" 2>/dev/null; sleep 1; kill -KILL "$game" 2>/dev/null' TERM INT
for at in "$@"; do
  ( sleep "$at"; import -window root -screen "$out/screen-$at.png" || echo "screenshot $at failed" >&2 ) &
done
if [ -n "$TN_PS4_RECORD" ]; then
  ( sleep "\${TN_PS4_RECORD%,*}"; ffmpeg -loglevel error -y -f x11grab -framerate 30 -i "$DISPLAY" -t "\${TN_PS4_RECORD#*,}" \
      -c:v libx264 -pix_fmt yuv420p "$out/video.mp4" || echo "recording failed" >&2 ) &
fi
wait "$game"
status=$?
exit "$status"
`;

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
    ...(VK_LAYER_PATH ? { VK_LAYER_PATH } : {}),
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
  // Each key is the setting's own field name: the JSON groups are the NLOHMANN_DEFINE_TYPE
  // serializations of GPUSettings/VulkanSettings (emulator_settings.h:412-458, :477-490), so
  // `readbacks_mode` and `vkvalidation_gpu_enabled` are snake_case here and camelCase only in the
  // config.toml spelling emulator_settings.cpp:606-649 reads.
  const vulkan = {
    ...(VK_VALIDATION
      ? {
          vkvalidation_enabled: true,
          vkvalidation_core_enabled: true,
          vkvalidation_sync_enabled: true,
          vkvalidation_gpu_enabled: true,
        }
      : {}),
    ...(VK_CRASH_DIAGNOSTIC ? { vkcrash_diagnostic_enabled: true } : {}),
  };
  await writeFile(
    path.join(env.XDG_DATA_HOME, 'shadPS4', 'config.json'),
    `${JSON.stringify({ GPU: { readbacks_mode: READBACKS_MODE, readback_linear_images_enabled: true, ...(DUMP_SHADERS ? { dump_shaders: true } : {}), ...GPU_OVERRIDES }, ...(Object.keys(vulkan).length ? { Vulkan: vulkan } : {}) }, null, 2)}\n`,
  );
  await mkdir(env.XDG_CONFIG_HOME, { recursive: true });
  await mkdir(env.XDG_CACHE_HOME, { recursive: true });
  const logOut = path.join(outDir, 'out');
  await mkdir(logOut, { recursive: true });
  // An earlier run's capture is not this run's frame: the verdict reads the LAST screenshot, so a
  // leftover at a later second would be judged instead of the one this run took.
  for (const name of await readdir(logOut)) if (/^screen-.+\.png$/.test(name)) await rm(path.join(logOut, name));

  const wrapper = path.join(REPO_ROOT, 'scripts', 'xvfb.sh');
  if (!existsSync(wrapper)) throw new Error(`missing ${wrapper}`);
  const shots = captureTimes(experiment.screenshots);
  const hostWrap = HOST_HZ
    ? ['gamescope', '--backend', 'sdl', '-w', String(GPU_OVERRIDES.window_width ?? 1280), '-h', String(GPU_OVERRIDES.window_height ?? 720),
        '-W', '320', '-H', '180', '-r', String(HOST_HZ), '--']
    : [];
  if (HOST_HZ && !HAS_GAMESCOPE) throw new Error('TN_PS4_HOST_HZ needs gamescope on PATH; TN_PS4_HOST_HZ=0 runs plain Xvfb');
  console.log(HOST_HZ ? `PS4_EMULATED host: gamescope ${HOST_HZ} Hz in Xvfb (TN_PS4_HOST_HZ=0 for plain Xvfb)` : `PS4_EMULATED host: plain Xvfb${HOST_HZ_SET ? ' (TN_PS4_HOST_HZ=0)' : ', no gamescope on PATH'}`);
  env.TN_PS4_HOST_WRAP = hostWrap.join(' ');
  let launch = [...hostWrap, appimage, '-g', built.artifacts.eboot];
  if (gdbCommands) {
    // A command file cannot wrap the capture subshell's background launch, and one launch a run.
    if (shots.length) throw new Error('TN_PS4_GDB cannot be combined with TN_PS4_SCREENSHOT_AT');
    launch = ['gdb', '-q', '-batch', '-x', gdbCommands, '--args', await emulatorUnderGdb(appimage), '-g', built.artifacts.eboot];
  }
  // xvfb.sh exports the private DISPLAY to its child, so the captures run inside the wrapper: the
  // emulator goes to the background, and each capture is its own subshell sleeping an absolute
  // time from launch (a broken capture reports itself and never changes the exit status).
  // Every launch but gdb goes through CAPTURE_SCRIPT: it is what stops an emulator that left the group.
  const command = gdbCommands
    ? launch
    : ['sh', '-c', CAPTURE_SCRIPT, 'tn-ps4-launch', appimage, '-g', built.artifacts.eboot, logOut, ...shots];
  const child = spawn('sh', [wrapper, ...command], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const startedAt = Date.now();
  // A capture is taken that many seconds after THIS launch (CAPTURE_SCRIPT sleeps from launch), and
  // stopping the run stops its capture subshells with it, so the marker must not end the wait before
  // the last capture is due: a verdict that reads two frames has to let both be taken. E5 asks for
  // 300 frames but prints its marker at the 300th, seconds before the captures at 20 s and 40 s. The
  // grace is the capture's own startup: its sleep ends at the capture time, and a stop() in the same
  // instant kills the import with the process group.
  // TN_PS4_RECORD=<start>,<seconds> also records the private display to <out>/video.mp4 (opt-in,
  // for a person to watch the run); the wait covers the recording's end like a late capture.
  const [recordAt, recordFor] = (process.env.TN_PS4_RECORD ?? '').split(',').map(Number);
  const recordEnd = Number.isFinite(recordAt) && Number.isFinite(recordFor) ? recordAt + recordFor : 0;
  const lastShotMs = shots.length ? Math.max(recordEnd, ...shots.map(Number)) * 1000 + 5_000 : 0;
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
      if (Date.now() - startedAt >= lastShotMs) break;
      // A run that has exited takes no further capture: break now and let the verdict say which frame
      // it is missing, instead of sitting out the timeout for a screenshot that can never come.
      if (child.exitCode === null) {
        await delay(250);
        continue;
      }
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

// The verdict rules fail silently when they drift (a static start screen once failed as "no motion"),
// so --self-check feeds judgeE5Rasters synthetic frames: no emulator, no screenshots.
function selfCheck() {
  const size = 64;
  const frame = (clear, square) => {
    const pixels = new Uint8Array(size * size * 3);
    for (let at = 0; at < pixels.length; at += 3) pixels.set(clear, at);
    if (square) for (let y = square[1]; y < square[1] + 20; y++) for (let x = square[0]; x < square[0] + 20; x++) pixels.set([200, 60, 60], (y * size + x) * 3);
    return { width: size, height: size, pixels };
  };
  const rasters = list => list.map((raster, i) => ({ file: `/shots/screen-${i}.png`, raster }));
  const timed = 'TN_PLAYER_FRAMES 300 js_ms=1.0 frame_ms=16.0 kernel_frame_ms=16.0\n';
  const judge = (list, motion, log = timed) => judgeE5Rasters({ frames: 300, info: '', log, rasters: rasters(list), motion });
  const scene = frame([30, 30, 30], [10, 10]);
  const turned = frame([30, 30, 30], [34, 34]);
  assert.equal(judge([scene, scene], true).ok, false, 'E5 still fails a frozen cube');
  assert.match(judge([scene, scene], true).reason, /a moving cube must change/);
  assert.equal(judge([scene, turned], true).ok, true, 'E5 still passes a moving cube');
  assert.equal(judge([scene, scene], false, '').ok, true, 'deploy passes a static start screen with no frame windows');
  assert.equal(judge([frame([0, 0, 0]), scene], false).ok, true, 'deploy skips the boot-black capture');
  assert.equal(judge([frame([0, 0, 0]), frame([0, 0, 0])], false).ok, false, 'deploy fails a black screen');
  assert.equal(judge([frame([30, 30, 30])], false).ok, false, 'deploy fails a frame that is only the clear colour');
  assert.match(judge([frame([30, 30, 30])], false).reason, /differs from the clear/);
  console.log('run-experiment self-check ok');
}

async function main(argv) {
  if (argv[2] === '--self-check') return selfCheck() ?? 0;
  let options;
  try {
    options = parseArgs(argv.slice(2));
  } catch (error) {
    console.error(error.message);
    return 2;
  }
  const name = options.name;
  const experiment = EXPERIMENTS[name];
  sceneRoot = options.scene;
  const label = `PS4_EMULATED ${name.toUpperCase()}`;
  // e3cs and the e3tex arms are E3's guest built other ways (one Dawn tree, one E3 scratch dir):
  // their eboots and stamps live in e3's out/<guest>/ folders, so the shared directory holds no
  // shared product.
  const sharedE3 = new Set(['e3cs', 'e3tex', 'e3tex8', 'e3texmsaa']);
  // e2 and e5 (and the deploy preview, which boots the e5 folder) honour the dirs the build scripts honour.
  const dirVar = { e2: 'TN_PS4_E2_DIR', e5: 'TN_PS4_E5_DIR', deploy: 'TN_PS4_E5_DIR' }[name];
  const outDir = (dirVar && process.env[dirVar]) || path.join(SCRATCH_ROOT, sharedE3.has(name) ? 'e3' : name === 'deploy' ? 'e5' : name);
  await mkdir(outDir, { recursive: true });

  const toolchain = await ensureToolchain();
  const appimage = await ensureEmulator();
  if (name === 'deps') {
    console.log(`${label} toolchain ${toolchain}, emulator ${appimage}`);
    return 0;
  }
  let built;
  try {
    built = await experiment.build(outDir, toolchain);
  } catch (error) {
    console.log(`${label} FAIL: build -- ${error.message}`);
    return 1;
  }
  const result = await boot(experiment, built, appimage, outDir);
  const frame = await collectFrame(outDir);
  // Printed before the verdict: they are the evidence a red run is read from.
  const out = path.join(outDir, 'out');
  const shots = await screenShots(out);
  for (const shot of shots) console.log(`${label} screenshot ${shot}`);
  if (DUMP_SHADERS) {
    const dumps = path.join(outDir, 'home', '.local', 'share', 'shadPS4', 'shader', 'dumps');
    const names = (await readdir(dumps).catch(() => [])).sort();
    console.log(`${label} shader dumps ${dumps} (${names.length} files)`);
    for (const name of names) console.log(`${label} dump ${path.join(dumps, name)}`);
  }

  const jsCost = frameBudgetMs(`${result.output}\n${result.log}`);
  if (jsCost) console.log(`${label} ${jsCost}`);

  // Pass rule: the experiment's own verdict over the evidence it captured, and nothing else.
  const verdict = result.match ? await experiment.verdict(result.match, frame, result.log, shots) : null;
  if (verdict?.info) console.log(`${label} info:${verdict.info}`);
  // The verdict names the frame it judged; the guest's own frame is only a fallback.
  const image = verdict?.image || frame.image;
  if (verdict?.ok) {
    console.log(`${label} PASS${verdict.detail}${image ? ` image=${image}` : ''}`);
    return 0;
  }
  const reason = result.failure || verdict?.reason || 'the guest printed no marker';
  // The emulator's log carries every guest line (its Tty forwarder) without the private X server's
  // startup noise that also lands on the child's stderr, so it is what a red is read from.
  const text = result.log.trim() ? result.log : result.output;
  const tail = text.trimEnd().split('\n').slice(-20).join('\n');
  const firmware = /sys_modules|firmware/i.test(result.output + result.log) ? ' (shadPS4 reported a firmware/sys_modules requirement)' : '';
  console.log(`${label} FAIL: ${reason}${firmware}${image ? ` image=${image}` : ''}\n${tail}`);
  return 1;
}

// Exit explicitly: any process left holding an inherited pipe would otherwise keep the runner alive.
process.exit(await main(process.argv));
