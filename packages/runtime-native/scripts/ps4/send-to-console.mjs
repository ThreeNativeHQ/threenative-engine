#!/usr/bin/env node
// PRD-784 E6: one command builds the E5 artifact and prints every step that puts it on a console.
//
// Usage:
//   node packages/runtime-native/scripts/ps4/send-to-console.mjs --host <console address> [--dry-run]
//     [--scene <game dir>] [--out <dir>] [--jobs N] [--ftp-port N] [--pkg-dir <path>] [--icon <png>]
//     [--pkg <file>] [--build-only] [--prebuilt]
//
// `pnpm ps4 <game dir> [--console <address>]` (ps4.mjs) is the one-command front end over this
// script and the emulator preview. --build-only builds the app and the package and needs no
// --host; --prebuilt skips the app build and reuses the app folder already in --out.
//
// Without --dry-run the same steps run: the package is uploaded over FTP and the console installs
// it. --dry-run runs the local build and package steps, performs no network I/O at all, and exits 0
// once the steps are printed.
//
// THE CONSOLE-SIDE ROUTE, and why this one: a jailbroken console's GoldHEN serves FTP on port 2121,
// so a package staged at /data/pkg over FTP is installed from the console's own Package Installer
// (Settings > Debug Settings > Game > Package Installer). That is the route the OpenGNM hardware
// runbook uses for a package built with this same OpenOrbis toolchain (research checkout,
// PS4_PACKAGING.md: PS4_FTP_PORT=2121, the `curl -T` staging into $PS4_PKG_DIR = /data/pkg, then
// "Install ... from the PS4 package installer"; the toolchain's own docs/MD/Building Homebrew.md
// ends "you can load this package file onto a USB, and install it through the \"Debug Menu\" on a
// jailbroken PS4"). It needs nothing on the console beyond GoldHEN and nothing on the PC beyond
// curl, so it is the one that cannot half-work. The two alternatives were
// checked and are not used: the Remote Package Installer's HTTP API on 12800 is a separate
// console-side homebrew app, and no source for its API was available offline to cite; GoldHEN's
// binloader on 9090 executes a payload but mounts no /app0, and the player reads its bundle from
// /app0 (src/platform/ps4_main.cpp:20), so a binloader-run SELF boots with no scene.
//
// The package is a fake PKG: OpenOrbis' create-gp4 writes the .gp4 project and PkgTool.Core's
// `pkg_build` writes the .pkg (samples/threading/Makefile:55-61 in the pinned v0.5.4 toolchain),
// with CONTENT_ID and TITLE_ID read back from the param.sfo e5-build.sh wrote -- one source of
// truth for the identity the console installs under. PkgTool.Core needs OpenSSL 1.1, which this
// script supplies privately (ensureLibssl11). --pkg sends a package built elsewhere instead.
// If the console ever rejects an install, the next file the samples ship is the parental-control
// rights blob (sce_sys/about/right.sprx, copied from $OO/src/modules/right.sprx): add it to FILES
// and to the .gp4, and nothing else in this script changes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageGuestUi } from './stage-guest-ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(HERE, '../..');
const REPO_ROOT = path.resolve(PKG_ROOT, '../..');
const DEPS_DIR = process.env.TN_PS4_DEPS ?? path.join(homedir(), '.cache/tmp-tn/prd784/deps');
// The default e5-build.sh and the e5 runner share, so a run here sends the artifact E5 boots:
// $TN_PS4_E5_DIR, else the scratch e5 folder.
const DEFAULT_OUT = process.env.TN_PS4_E5_DIR ?? path.join(homedir(), '.cache/tmp-tn/prd784/e5');
// The game E5 bundles by default (run-experiment.mjs DEFAULT_E5_SCENE): the smallest in-repo cube.
const DEFAULT_SCENE = path.join(REPO_ROOT, 'examples', 'wasm-engine-boot');
const OO = process.env.OO_PS4_TOOLCHAIN ?? path.join(DEPS_DIR, 'oo/OpenOrbis/PS4Toolchain');
const PKGTOOL = path.join(OO, 'bin/linux/PkgTool.Core');
const CREATE_GP4 = path.join(OO, 'bin/linux/create-gp4');
const DOTNET = { DOTNET_SYSTEM_GLOBALIZATION_INVARIANT: '1' };

const FTP_PORT = 2121; // GoldHEN's FTP server, the port the runbook stages packages on
const FTP_DIR = '/data/pkg'; // where the console's Package Installer looks for a staged package
// A guest's files, in image order: the SELF the console boots, the bundle the player opens at
// /app0/game.js, the packed assets when the scene has any, and the metadata the identity lives in.
const SFO = 'sce_sys/param.sfo';
const FILES = ['eboot.bin', 'game.js', SFO, 'sce_sys/icon0.png'];
// The rights blob the toolchain's own samples ship in their .gp4 (samples/threading/Makefile). A
// package without it installs, then refuses to launch with the console's "data is corrupted" banner.
const RIGHTS = 'sce_sys/about/right.sprx';
const RIGHTS_SOURCE = path.join(OO, 'src/modules/right.sprx');
const USAGE = 'usage: node packages/runtime-native/scripts/ps4/send-to-console.mjs --host <address> [--dry-run] [--scene <dir>] [--out <dir>] [--jobs N] [--ftp-port N] [--pkg-dir <path>] [--icon <png>] [--pkg <file>] [--build-only] [--prebuilt]';
// The E2 driver archives e5-build.sh links, built by e2-build.sh into $TN_PS4_E2_DIR.
const E2_DIR = process.env.TN_PS4_E2_DIR ?? path.join(homedir(), '.cache/tmp-tn/prd784/e2');
const E2_ARCHIVES = ['src/vulkan-ps4/libvulkan_ps4.a', 'src/opengnm/libopengnm.a', 'src/opengnm-psbc/libpsbc.orbis.a'];
// Each flag's option and how its value is read: the four local paths resolve against the cwd,
// the two numbers are numbers, and --host/--pkg-dir are the console's address and a directory on
// the console's own disk, so they are passed through untouched.
const FLAGS = {
  '--host': ['host', value => value],
  '--scene': ['scene', path.resolve],
  '--out': ['out', path.resolve],
  '--jobs': ['jobs', Number],
  '--ftp-port': ['ftpPort', Number],
  '--pkg-dir': ['ftpDir', value => value],
  '--icon': ['icon', path.resolve],
  '--pkg': ['pkg', path.resolve],
};

function log(message) {
  process.stdout.write(`[send] ${message}\n`);
}

function die(message) {
  process.stderr.write(`[send] ${message}\n`);
  process.exit(1);
}

// --host is the one thing the script cannot default (--build-only needs none): everything else holds the value E5 uses.
function parseArgs(argv) {
  const options = { host: '', scene: DEFAULT_SCENE, out: DEFAULT_OUT, dryRun: false, buildOnly: false, prebuilt: false, jobs: '8', ftpPort: FTP_PORT, ftpDir: FTP_DIR, icon: '', pkg: '' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--dry-run' || flag === '--build-only' || flag === '--prebuilt') {
      options[{ '--dry-run': 'dryRun', '--build-only': 'buildOnly', '--prebuilt': 'prebuilt' }[flag]] = true;
      continue;
    }
    const entry = FLAGS[flag];
    if (!entry) die(`unknown argument ${flag}: ${USAGE}`);
    const value = argv[++i];
    if (value === undefined) die(`${flag} needs a value`);
    options[entry[0]] = entry[1](value);
  }
  if (!options.host && !options.buildOnly) die(`--host <console address> is required, the only value with no E5 default\n${USAGE}`);
  if (!Number.isInteger(options.ftpPort) || options.ftpPort <= 0) die(`--ftp-port ${options.ftpPort} is not a port`);
  return options;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', ...options });
  if (result.error) throw new Error(`${cmd}: ${result.error.message}`);
  if (result.status !== 0)
    throw new Error(`${cmd} ${args.join(' ')} exited ${result.status}\n${`${result.stdout ?? ''}${result.stderr ?? ''}`.trim()}`);
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

// The native cook writes EXT_meshopt_compression into every model, and the player decodes it only when
// the tree was configured with third_party/meshopt (NativeEngineCore.cmake adds tn_engine_meshopt then);
// without it a game that loads a .glb stops at start with TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED. So the
// sources are staged (the same fetch ps4-deps.sh runs) and a tree configured without them is
// configured again. CMake decides at configure time, so the target in build.ninja is the proof.
export function meshoptConfigured(ninjaText) {
  return ninjaText.includes('tn_engine_meshopt');
}

function ensureMeshopt() {
  const dir = path.join(PKG_ROOT, 'third_party/meshopt');
  const present = () => ['meshoptimizer.h', 'vertexcodec.cpp'].every(file => existsSync(path.join(dir, file)));
  if (!present()) {
    log('fetching meshopt into the staged third_party (download-deps.mjs --only meshopt)');
    run(process.execPath, [path.join(PKG_ROOT, 'scripts/download-deps.mjs'), '--only', 'meshopt'], { stdio: 'inherit' });
  }
  if (!present()) die(`no meshoptimizer sources in ${dir}: models would fail on the console with TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED (node packages/runtime-native/scripts/download-deps.mjs --only meshopt)`);
}

// Both the prebuilts and the CMake tree are stamps: e5-build.sh refuses to link without them and
// neither is rebuilt while it exists. They are made here because a fresh machine lacks both.
function ensureBuildTree(out) {
  // e5-build.sh dies on a missing driver archive; a fresh machine has none, so build them here.
  if (E2_ARCHIVES.some(archive => !existsSync(path.join(E2_DIR, archive)))) {
    log(`building the PS4 Vulkan driver archives into ${E2_DIR} (e2-build.sh)`);
    run('bash', [path.join(HERE, 'e2-build.sh'), '--out', E2_DIR], { stdio: 'inherit', env: { ...process.env, OO_PS4_TOOLCHAIN: OO } });
  }
  if (!existsSync(path.join(out, 'deps/third_party/v8/libv8_monolith.a'))) {
    log(`staging the PS4 prebuilts into ${path.join(out, 'deps/third_party')}`);
    run('bash', [path.join(HERE, 'ps4-deps.sh'), '--out', out], { stdio: 'inherit' });
  }
  ensureMeshopt();
  const ninja = path.join(out, 'build/build.ninja');
  if (!existsSync(ninja) || !meshoptConfigured(readFileSync(ninja, 'utf8'))) {
    log(`configuring the tn-ps4 CMake tree at ${path.join(out, 'build')}`);
    run('cmake', ['--preset', 'tn-ps4', '-B', path.join(out, 'build')], {
      cwd: PKG_ROOT,
      stdio: 'inherit',
      env: { ...process.env, OO_PS4_TOOLCHAIN: OO },
    });
  }
}

// The E5 artifact, built as run-experiment.mjs buildE5 builds it: e5-build.sh links the SELF and
// writes the SFO, then bundle-native-engine.mjs writes the /app0 bundle and cooks the scene's
// assets beside it. A scene with no asset files gets no native/assets.tnpk, which is a fact about
// the scene and not a failure.
async function buildApp(options) {
  // The scene is checked first: a wrong --scene fails in a second, not after the link.
  const entry = path.join(options.scene, 'src', 'game.ts');
  if (!existsSync(entry)) die(`scene ${options.scene} has no src/game.ts (--scene names a game project)`);
  const appDir = path.join(options.out, 'out', 'app');
  if (options.prebuilt) {
    if (!existsSync(path.join(appDir, 'eboot.bin')) || !existsSync(path.join(appDir, 'game.js')))
      die(`--prebuilt needs the app folder ${appDir} (eboot.bin and game.js): run without --prebuilt first`);
    await ensureIcon(appDir, options.icon);
    return appDir;
  }
  ensureBuildTree(options.out);
  log(`building the E5 app folder in ${options.out}`);
  run('bash', [path.join(HERE, 'e5-build.sh'), '--out', options.out, '--jobs', `${options.jobs}`], {
    stdio: 'inherit',
    env: { ...process.env, OO_PS4_TOOLCHAIN: OO, TN_PS4_E5_DIR: options.out, TN_PS4_E2_DIR: E2_DIR },
  });
  // A scene with a native-css HUD names it in src/native.tsx (the entry run-experiment.mjs bundles).
  const nativeEntry = existsSync(path.join(options.scene, 'src', 'native.tsx')) ? path.join(options.scene, 'src', 'native.tsx') : entry;
  run(process.execPath, [
    path.join(PKG_ROOT, 'scripts/bundle-native-engine.mjs'),
    '--engine', 'native', '--game-runtime', 'v8', '--entry', nativeEntry,
    '--out', path.join(appDir, 'game.js'), '--assets', options.scene,
  ], { stdio: 'inherit' });
  const ui = stageGuestUi(options.scene, appDir);
  if (nativeEntry !== entry && !ui)
    die(`scene ${options.scene} has src/native.tsx but no built UI (build ${path.join(options.scene, '.threenative/build/ui-css')} or set TN_PS4_UI_DIR)`);
  for (const file of [path.join(appDir, 'eboot.bin'), path.join(appDir, 'game.js'), path.join(appDir, SFO)])
    if (!existsSync(file)) die(`the build wrote no ${file}`);
  await ensureIcon(appDir, options.icon);
  return appDir;
}

// Every package needs a 512x512 24-bit sce_sys/icon0.png (the toolchain's docs/MD/Building Homebrew.md:
// "The below files are *required* for every package"). The build's own icon wins, --icon overrides,
// and the toolchain's sample is the placeholder until a game ships one -- the app folder is the
// scratch build output, so nothing in the repo carries a borrowed icon.
async function ensureIcon(appDir, icon) {
  const target = path.join(appDir, 'sce_sys', 'icon0.png');
  if (icon) {
    await copyFile(icon, target);
    return;
  }
  if (existsSync(target)) return;
  const sample = path.join(OO, 'samples/hello_world/sce_sys/icon0.png');
  if (!existsSync(sample)) die(`no ${target} and no sample icon at ${sample}: pass --icon <512x512 24-bit png>`);
  await copyFile(sample, target);
  log(`icon0.png: no icon in the build, copied the toolchain's sample (--icon <png> overrides)`);
}

// TITLE_ID and CONTENT_ID come back out of the param.sfo e5-build.sh wrote instead of being
// repeated here: the identity the console installs under has one definition.
function sfoField(listing, name) {
  const match = listing.match(new RegExp(`^${name} : \\S+\\([^)]*\\) = (.+)$`, 'm'));
  return match ? match[1].trim() : '';
}

// A package installs under its CONTENT_ID, so two games sharing one overwrite each other on the
// console. The id comes from the game folder's name: stable across machines, one per game.
// TITLE_ID is 4 letters + 5 digits and CONTENT_ID is 36 characters (PkgTool pkg_build checks both).
// 100000 title ids make a clash between two game names unlikely, not impossible; rename a folder to move.
export function deriveIdentity(scene) {
  const title = path.basename(path.resolve(scene));
  const digest = createHash('sha256').update(title).digest('hex');
  const titleId = `TNPS${String(Number.parseInt(digest.slice(0, 8), 16) % 100000).padStart(5, '0')}`;
  return { title: title.slice(0, 100), titleId, contentId: `IV0000-${titleId}_00-TN${digest.slice(8, 22).toUpperCase()}` };
}

// e5-build.sh writes the E5 identity; the package is installed under the game's own.
function writeIdentity(appDir, { title, titleId, contentId }) {
  for (const [key, maxsize, value] of [['CONTENT_ID', 48, contentId], ['TITLE_ID', 12, titleId], ['TITLE', 128, title]])
    run(PKGTOOL, ['sfo_setentry', path.join(appDir, SFO), key, '--type', 'Utf8', '--maxsize', `${maxsize}`, '--value', value], { env: { ...process.env, ...DOTNET } });
}

function readIdentity(appDir) {
  const listing = run(PKGTOOL, ['sfo_listentries', path.join(appDir, SFO)], { env: { ...process.env, ...DOTNET } });
  const titleId = sfoField(listing, 'TITLE_ID');
  const contentId = sfoField(listing, 'CONTENT_ID');
  if (!titleId || !contentId) die(`${SFO} has no TITLE_ID/CONTENT_ID: e5-build.sh writes both`);
  return { titleId, contentId };
}

// A nested file needs its directory in the .gp4 rootdir, and create-gp4 writes only the canned
// ones: it lists "native/assets.tnpk" under <files> and adds nothing under <rootdir>. One level is
// what the player's /app0/native/assets.tnpk asks for. A deeper path (sce_sys/about/right.sprx) is
// accepted only when create-gp4 already emitted its parent dir, so nothing is ever mis-packed.
async function addMissingDirs(gp4Path) {
  const text = await readFile(gp4Path, 'utf8');
  const parents = new Set();
  for (const [, targ] of text.matchAll(/<file targ_path="([^"]+)"/g)) {
    const parts = targ.split('/');
    if (parts.length === 1) continue;
    if (parts.length > 2) {
      if (!text.includes(`<dir targ_name="${parts[parts.length - 2]}"`))
        die(`${targ} is nested deeper than one directory and its parent dir is not in the .gp4`);
      continue;
    }
    parents.add(parts[0]);
  }
  const missing = [...parents].filter(dir => !text.includes(`<dir targ_name="${dir}"`));
  if (missing.length === 0) return;
  const added = missing.map(dir => `\t\t<dir targ_name="${dir}" />\n`).join('');
  await writeFile(gp4Path, text.replace('\t</rootdir>', `${added}\t</rootdir>`));
}

// The rights blob is part of the package, not of the game: the toolchain's samples ship it and a
// package without it has no licence to launch under, which the console reports as corrupt data.
async function stageRights(appDir) {
  if (!existsSync(RIGHTS_SOURCE)) return '';
  const target = path.join(appDir, RIGHTS);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(RIGHTS_SOURCE, target);
  return RIGHTS;
}

// PkgTool.Core is a self-contained .NET Core 3.0 build: its crypto loads libssl.so.1.1 and dies
// on an OpenSSL 3 host ("No usable version of libssl was found"; CLR_OPENSSL_VERSION_OVERRIDE=3
// fails on the removed ERR_put_error). A pinned Debian 11 libssl1.1 unpacked under DEPS_DIR and
// put on LD_LIBRARY_PATH for that one process is enough; nothing is installed system-wide.
const LIBSSL11_DEB = 'https://deb.debian.org/debian/pool/main/o/openssl/libssl1.1_1.1.1w-0+deb11u1_amd64.deb';
const LIBSSL11_SHA256 = 'aadf8b4b197335645b230c2839b4517aa444fd2e8f434e5438c48a18857988f7';

async function ensureLibssl11() {
  const root = path.join(DEPS_DIR, 'libssl11');
  const lib = path.join(root, 'x/usr/lib/x86_64-linux-gnu');
  if (existsSync(path.join(lib, 'libssl.so.1.1'))) return lib;
  await mkdir(path.join(root, 'x'), { recursive: true });
  log(`fetching ${LIBSSL11_DEB} (PkgTool.Core needs OpenSSL 1.1)`);
  const response = await fetch(LIBSSL11_DEB);
  if (!response.ok) die(`${LIBSSL11_DEB}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== LIBSSL11_SHA256) die(`${LIBSSL11_DEB}: sha256 ${digest}, want ${LIBSSL11_SHA256}`);
  const deb = path.join(root, 'libssl1.1.deb');
  await writeFile(deb, bytes);
  run('ar', ['x', deb], { cwd: path.join(root, 'x') });
  run('sh', ['-c', 'tar xf data.tar.*'], { cwd: path.join(root, 'x') });
  if (!existsSync(path.join(lib, 'libssl.so.1.1'))) die(`${deb} unpacked no libssl.so.1.1`);
  return lib;
}

// The fake PKG: a .gp4 project, then PkgTool.Core's pkg_build. Both tools resolve each orig_path
// against the .gp4's own folder, so the project is written inside the app folder (it is not in
// its own file list, so it never enters the package) and only the .pkg goes to <out>/pkg.
async function buildPackage(appDir, outDir, contentId) {
  const pkgDir = path.join(outDir, 'pkg');
  await mkdir(pkgDir, { recursive: true });
  const files = [...FILES];
  const rights = await stageRights(appDir);
  if (rights) files.push(rights);
  if (existsSync(path.join(appDir, 'native/assets.tnpk'))) files.push('native/assets.tnpk');
  // The native-css HUD the player reads from /app0/ui (stage-guest-ui.mjs), when the scene has one.
  if (existsSync(path.join(appDir, 'ui')))
    for (const entry of readdirSync(path.join(appDir, 'ui'), { recursive: true, withFileTypes: true }))
      if (entry.isFile()) files.push(path.relative(appDir, path.join(entry.parentPath, entry.name)));
  const gp4 = path.join(appDir, `${contentId}.gp4`);
  const pkgPath = path.join(pkgDir, `${contentId}.pkg`);
  run(CREATE_GP4, ['-out', gp4, `--content-id=${contentId}`, '--files', files.join(' ')], { cwd: appDir, env: { ...process.env, ...DOTNET } });
  await addMissingDirs(gp4);
  const libssl = await ensureLibssl11();
  const ldPath = [libssl, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  run(PKGTOOL, ['pkg_build', gp4, pkgDir], { cwd: appDir, env: { ...process.env, ...DOTNET, OO_PS4_TOOLCHAIN: OO, LD_LIBRARY_PATH: ldPath } });
  if (!existsSync(pkgPath)) die(`pkg_build wrote no ${pkgPath}`);
  return { pkgPath, gp4, why: '' };
}

function human(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function curlSteps(host, port, dir, file) {
  return {
    upload: ['curl', '--fail', '--silent', '--show-error', '--ftp-create-dirs', '--connect-timeout', '10', '--max-time', '900', '-T', file, `ftp://${host}:${port}${dir}/${path.basename(file)}`],
    verify: ['curl', '--fail', '--silent', '--show-error', '--connect-timeout', '10', '--max-time', '30', `ftp://${host}:${port}${dir}/`],
  };
}

// The checks this script's own parsing carries, because each of them fails silently rather than
// throwing: an unread identity is "", a nested file with no rootdir entry still builds a .gp4, and
// a mis-parsed flag sends to the wrong address. Run with --self-check; no fixtures, no network.
async function selfCheck() {
  const listing = 'CONTENT_ID : Utf8(38/48) = IV0000-TNPS78405_00-TNPRD784E5000000\nTITLE_ID : Utf8(11/12) = TNPS78405\n';
  assert.equal(sfoField(listing, 'CONTENT_ID'), 'IV0000-TNPS78405_00-TNPRD784E5000000');
  assert.equal(sfoField(listing, 'TITLE_ID'), 'TNPS78405');
  assert.equal(sfoField(listing, 'TITLE'), '');
  const options = parseArgs(['--host', '10.0.0.2', '--dry-run']);
  assert.deepEqual([options.host, options.dryRun, options.ftpPort, options.ftpDir], ['10.0.0.2', true, 2121, '/data/pkg']);
  const build = parseArgs(['--build-only', '--prebuilt']);
  assert.deepEqual([build.host, build.buildOnly, build.prebuilt, build.dryRun], ['', true, true, false], '--build-only needs no --host');
  // Two games must install side by side: distinct ids, each in the console's fixed shape, stable per name.
  const [one, two] = ['cube-spin', 'starter'].map(name => deriveIdentity(`/games/${name}`));
  assert.notEqual(one.contentId, two.contentId);
  assert.notEqual(one.titleId, two.titleId);
  for (const id of [one, two]) {
    assert.match(id.titleId, /^[A-Z]{4}\d{5}$/);
    assert.equal(id.contentId.length, 36);
    assert.ok(id.contentId.includes(id.titleId), 'CONTENT_ID carries the TITLE_ID');
  }
  assert.deepEqual(deriveIdentity('/elsewhere/cube-spin'), one, 'the id follows the folder name, not the path');
  assert.equal(meshoptConfigured('build tn_engine_meshopt: CXX_STATIC_LIBRARY_LINKER__tn_engine_meshopt_'), true);
  assert.equal(meshoptConfigured('build libtn_engine_assets.a: CXX_STATIC_LIBRARY_LINKER__tn_engine_assets_'), false, 'a tree configured without meshopt is configured again');
  assert.match(curlSteps('h', 2121, '/data/pkg', '/tmp/a.pkg').upload.join(' '), /ftp:\/\/h:2121\/data\/pkg\/a\.pkg$/);
  const scratch = await mkdtemp(path.join(tmpdir(), 'tn-send-check-'));
  const gp4 = path.join(scratch, 'project.gp4');
  await writeFile(gp4, '<psproject>\n\t<files>\n\t\t<file targ_path="eboot.bin" />\n\t\t<file targ_path="native/assets.tnpk" />\n\t</files>\n\t<rootdir>\n\t</rootdir>\n</psproject>\n');
  await addMissingDirs(gp4);
  const patched = await readFile(gp4, 'utf8');
  assert.match(patched, /<dir targ_name="native" \/>\n\t<\/rootdir>/);
  assert.equal(patched.match(/targ_name="native"/g)?.length, 1, 'a second run must not duplicate the dir');
  const rights = await stageRights(scratch);
  assert.equal(rights, 'sce_sys/about/right.sprx', 'the rights blob rides the package');
  assert.ok(statSync(path.join(scratch, rights)).size > 0, 'and it is copied, not just named');
  log('self-check ok');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    log(USAGE);
    return;
  }
  if (argv.includes('--self-check')) {
    await selfCheck();
    return;
  }
  const options = parseArgs(argv);
  const appDir = await buildApp(options);
  writeIdentity(appDir, deriveIdentity(options.scene));
  const { titleId, contentId } = readIdentity(appDir);
  const built = options.pkg ? { pkgPath: options.pkg, gp4: '', why: '' } : await buildPackage(appDir, options.out, contentId);
  if (options.buildOnly) {
    log(`package:  ${built.pkgPath} (${human(statSync(built.pkgPath).size)}); TITLE_ID ${titleId}, CONTENT_ID ${contentId}; --build-only: nothing sent`);
    return;
  }
  const steps = curlSteps(options.host, options.ftpPort, options.ftpDir, built.pkgPath);
  const pkgBytes = existsSync(built.pkgPath) ? ` (${human(statSync(built.pkgPath).size)})` : ' (not built here)';

  log(`artifact: ${appDir} (eboot.bin ${human(statSync(path.join(appDir, 'eboot.bin')).size)}, game.js ${human(statSync(path.join(appDir, 'game.js')).size)})`);
  log(`identity: TITLE_ID ${titleId}, CONTENT_ID ${contentId}`);
  log(`package:  ${built.pkgPath}${pkgBytes}${built.gp4 ? `; project ${built.gp4}` : ''}`);
  if (built.why) log(`warning:  ${built.why}`);
  log(`console:  ${options.host}; GoldHEN FTP ${options.ftpPort}, install from the console's own Package Installer`);
  log(`step 1/3 upload   ${steps.upload.join(' ')}`);
  log(`step 2/3 verify   ${steps.verify.join(' ')}`);
  log(`step 3/3 install  console screen: Settings > Debug Settings > Game > Package Installer > ${path.basename(built.pkgPath)}, then launch ${titleId}`);
  if (options.dryRun) {
    log('dry run: steps printed, no network I/O performed');
    return;
  }
  if (!existsSync(built.pkgPath)) die(`nothing to send: ${built.pkgPath} does not exist`);
  try {
    run('curl', ['--version'], { stdio: 'ignore' });
  } catch {
    die(`curl is not installed: run step 1/3 by hand:\n  ${steps.upload.join(' ')}`);
  }
  run(steps.upload[0], steps.upload.slice(1), { stdio: 'inherit', timeout: 1_000_000 });
  run(steps.verify[0], steps.verify.slice(1), { stdio: 'inherit', timeout: 60_000 });
  log(`sent ${path.basename(built.pkgPath)} to ftp://${options.host}:${options.ftpPort}${options.ftpDir}/: finish with step 3/3 on the console`);
}

try {
  await main();
} catch (error) {
  die(String(error.message));
}
