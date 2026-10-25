import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { test } from 'vitest';

import {
  analyzeStarterLog,
  assertPlayerPrerequisites,
  desktopLaunchTarget,
  inspectStarterScreenshot,
  verifyStarterContainer,
  verifyStarterDesktop,
} from '../scripts/verify-starter-desktop.mjs';

const PROOF_ASSET = new URL('../../create-threenative/templates/starter/assets/native-proof.png', import.meta.url);
// Real pixels from the scaffolded starter capture of Actions run 34076016432, not a synthetic
// stand-in. The first frame shows the proof pennant over the ocean world; the second is the same
// ocean with the pennant cropped away, so the pair pins both directions of the gate.
const REAL_CAPTURE = fileURLToPath(
  new URL('./fixtures/starter-desktop-real-capture.png', import.meta.url),
);
const OCEAN_WITHOUT_PENNANT = fileURLToPath(
  new URL('./fixtures/starter-desktop-ocean-only.png', import.meta.url),
);

test('accepts the real CI capture in which the proof pennant is visible', () => {
  // Matching the authored texture colour rejected this frame: the ocean sits 149 from the authored
  // cyan and the lit pennant only 103, so a threshold wide enough for the asset swallowed the sea
  // and the whole frame read as a wash.
  const result = inspectStarterScreenshot(REAL_CAPTURE);
  assert.equal(result.magentaAssetPixels, 521);
  assert.equal(result.cyanAssetPixels, 321);
});

test('rejects the same ocean with the proof pennant cropped away', () => {
  assert.throws(
    () => inspectStarterScreenshot(OCEAN_WITHOUT_PENNANT),
    /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/u,
  );
});

// The proof asset is graded down until it sits well below the brightness the pre-#126 predicate
// demanded — `blue > 150 && green > 140` was an exposure threshold wearing a colour's name, so a
// kit that grades its world darker failed a gate about whether an asset is *present*. Channel
// margins are ratios between channels, so they survive the grade the same way hue did. This is
// #126's property, kept, but on a fixture carrying the packaged asset's two colours rather than
// cyan alone: the real proof is a cyan/magenta checkerboard, and a cyan-only stand-in is not it.
function gradedProofFrame() {
  const png = new PNG({ height: 16, width: 16 });
  for (let y = 0; y < 16; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const offset = (y * 16 + x) * 4;
      png.data[offset + 3] = 255;
      if (y === 15) {
        // One row of world behind the asset, so the frame is not the proof alone.
        png.data[offset] = x % 12;
        png.data[offset + 1] = 25 + (x % 9);
        png.data[offset + 2] = 50 + (x % 11);
      } else if ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0) {
        // Authored magenta [255,40,180], graded down.
        png.data[offset] = 128;
        png.data[offset + 1] = 20;
        png.data[offset + 2] = 90;
      } else {
        // Authored cyan [18,220,255], graded down: 128 is the lit frame's blue and 118 its green,
        // both under the pre-#126 predicate's 150/140 thresholds.
        png.data[offset] = 11;
        png.data[offset + 1] = 118;
        png.data[offset + 2] = 128;
      }
    }
  }
  return png;
}

test('the proof asset survives a grade that leaves it darker than the old floor', () => {
  const directory = makeTempDirSync('starter-graded-test-');
  const path = join(directory, 'frame.png');
  const png = gradedProofFrame();
  writeFileSync(path, PNG.sync.write(png));
  // Every proof pixel here is below the old brightness floor, so the pre-#126 predicate saw none.
  let brightEnoughForTheOldPredicate = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    if (png.data[index + 2] > 150 && png.data[index + 1] > 140) brightEnoughForTheOldPredicate += 1;
  }
  assert.equal(brightEnoughForTheOldPredicate, 0);
  const result = inspectStarterScreenshot(path);
  assert.ok(result.magentaAssetPixels >= 100);
  assert.ok(result.cyanAssetPixels >= 50);
});

test('starter desktop log fails closed without asset and frame markers', () => {
  assert.deepEqual(analyzeStarterLog('TN_NATIVE_SMOKE_READY:webgpu'), [
    'missing TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb',
    'missing TN_NATIVE_SMOKE_300_FRAMES:300',
    'missing exact 300-frame completion',
  ]);
});

// A drawn frame carries thousands of distinct colours. Shade the non-proof half so the fixture is
// a rendered frame rather than a flat fill, which is the thing the floor below distinguishes.
function cyanObjectFrame({ cyanPixels }) {
  const png = new PNG({ height: 16, width: 16 });
  for (let index = 0; index < 256; index += 1) {
    const offset = index * 4;
    if (index < cyanPixels) {
      png.data[offset] = 20;
      png.data[offset + 1] = 220;
      png.data[offset + 2] = 240;
    } else {
      // Vary all three channels but keep the shading away from both packaged proof colours.
      png.data[offset] = index;
      png.data[offset + 1] = (index * 3) % 256;
      png.data[offset + 2] = index % 120;
    }
    png.data[offset + 3] = 255;
  }
  return png;
}

function checkerboardCapture() {
  const png = new PNG({ height: 128, width: 128 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const index = y * png.width + x;
      // Red stays below green so this stand-in background cannot manufacture magenta. The old
      // `index % 80` reached 79 while green dipped to 20, so 680 scattered pixels of pure modulo
      // arithmetic satisfied the magenta test — an artifact of the fixture, not of any renderer.
      // The spread still carries 120 distinct colours, well past UNRENDERED_FRAME_COLOR_FLOOR.
      png.data[offset] = index % 20;
      png.data[offset + 1] = 20 + (index % 30);
      png.data[offset + 2] = 50 + (index % 40);
      png.data[offset + 3] = 255;
    }
  }
  return png;
}

function paintProof(png, proof, x = 56, y = 56, scale = 1, opacity = 1) {
  for (let proofY = 0; proofY < proof.height; proofY += 1) {
    for (let proofX = 0; proofX < proof.width; proofX += 1) {
      const source = (proofY * proof.width + proofX) * 4;
      for (let offsetY = 0; offsetY < scale; offsetY += 1) {
        for (let offsetX = 0; offsetX < scale; offsetX += 1) {
          const target =
            ((y + proofY * scale + offsetY) * png.width + x + proofX * scale + offsetX) * 4;
          for (let channel = 0; channel < 3; channel += 1) {
            png.data[target + channel] = Math.round(proof.data[source + channel] * opacity + 30 * (1 - opacity));
          }
          png.data[target + 3] = proof.data[source + 3];
        }
      }
    }
  }
}

function paintPennant(png, proof, x = 32, y = 32, scale = 4, opacity = 1) {
  const width = proof.width * scale;
  const height = proof.height * scale;
  for (let localY = 0; localY < height; localY += 1) {
    const v = (localY + 0.5) / height;
    const left = v / 2;
    const right = 1 - v / 2;
    for (let localX = 0; localX < width; localX += 1) {
      const horizontal = (localX + 0.5) / width;
      if (horizontal < left || horizontal >= right) continue;
      const u = (horizontal - left) / (right - left);
      const proofX = Math.min(proof.width - 1, Math.floor(u * proof.width));
      const proofY = Math.min(proof.height - 1, Math.floor(v * proof.height));
      const source = (proofY * proof.width + proofX) * 4;
      const target = ((y + localY) * png.width + x + localX) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        png.data[target + channel] = Math.round(proof.data[source + channel] * opacity + 30 * (1 - opacity));
      }
      png.data[target + 3] = proof.data[source + 3];
    }
  }
}

test('a capture taken before the startup gate opened is not evidence', () => {
  // The bimodal starter red: 300 llvmpipe frames finished in 3.0s against a 10s readiness window
  // and captured five distinct colours, while a slower run of the same build took 16.8s, crossed
  // it, and captured 17,163. The host now holds the capture until the gate opens and reports which
  // happened; a 0 must fail the lane rather than reach the pixel checks.
  const base = [
    'TN_NATIVE_SMOKE_READY:webgpu',
    'TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb',
    'TN_NATIVE_SMOKE_300_FRAMES:300',
    'Rendered 300 frames in 3001ms',
  ].join('\n');
  assert.deepEqual(analyzeStarterLog(`${base}\nTN_STARTUP_CAPTURE_READY:1`), []);
  assert.deepEqual(analyzeStarterLog(`${base}\nTN_STARTUP_CAPTURE_READY:0`), [
    'startup gate never opened before capture (TN_STARTUP_CAPTURE_READY:0)',
  ]);
});

test('the unrendered-frame floor does not judge small synthetic fixtures', () => {
  // distribution.test.mjs feeds inspectStarterScreenshot a 16x16 frame of two colours to prove the
  // installed verifier resolves packaged display support. That frame is exactly what it claims to
  // be, and a diversity floor written for a 1280x720 capture must not reject it.
  const directory = makeTempDirSync('starter-fixture-test-');
  const path = join(directory, 'frame.png');
  const png = PNG.sync.read(readFileSync(PROOF_ASSET));
  writeFileSync(path, PNG.sync.write(png));
  assert.equal(inspectStarterScreenshot(path).cyanAssetPixels, 128);
});

test('starter desktop screenshot requires the checkerboard proof asset', () => {
  const directory = makeTempDirSync('starter-desktop-test-');
  const path = join(directory, 'frame.png');
  const blank = new PNG({ height: 16, width: 16 });
  blank.data.fill(255);
  writeFileSync(path, PNG.sync.write(blank));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_SCREENSHOT_BLANK/);

  writeFileSync(path, PNG.sync.write(cyanObjectFrame({ cyanPixels: 128 })));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/);
});

test('the packaged checkerboard proof remains accepted in a capture-sized frame', () => {
  const directory = makeTempDirSync('starter-checkerboard-test-');
  const path = join(directory, 'frame.png');
  const proof = PNG.sync.read(readFileSync(PROOF_ASSET));
  const png = checkerboardCapture();
  paintProof(png, proof);
  writeFileSync(path, PNG.sync.write(png));
  assert.equal(inspectStarterScreenshot(path).cyanAssetPixels, 128);
});

test('a scaled and softly antialiased checkerboard remains accepted', () => {
  const directory = makeTempDirSync('starter-scaled-checkerboard-test-');
  const path = join(directory, 'frame.png');
  const proof = PNG.sync.read(readFileSync(PROOF_ASSET));
  const png = checkerboardCapture();
  paintProof(png, proof, 32, 32, 4, 0.8);
  writeFileSync(path, PNG.sync.write(png));
  assert.ok(inspectStarterScreenshot(path).cyanAssetPixels >= 100);
});

test('the packaged checkerboard remains visible on its authored pennant shape', () => {
  const directory = makeTempDirSync('starter-pennant-checkerboard-test-');
  const path = join(directory, 'frame.png');
  const proof = PNG.sync.read(readFileSync(PROOF_ASSET));
  const png = checkerboardCapture();
  paintPennant(png, proof, 32, 32, 4, 0.8);
  writeFileSync(path, PNG.sync.write(png));
  assert.ok(inspectStarterScreenshot(path).cyanAssetPixels >= 100);
});

test('a localized cyan object without the checkerboard proof is rejected', () => {
  const directory = makeTempDirSync('starter-cyan-object-test-');
  const path = join(directory, 'frame.png');
  const png = checkerboardCapture();
  for (let y = 56; y < 72; y += 1) {
    for (let x = 56; x < 72; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = 18;
      png.data[offset + 1] = 220;
      png.data[offset + 2] = 255;
      png.data[offset + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/);
});

test('a blue-grey background alone is not the cyan proof asset', () => {
  const directory = makeTempDirSync('starter-background-only-test-');
  const path = join(directory, 'frame.png');
  const png = new PNG({ height: 256, width: 256 });
  for (let index = 0; index < 256 * 256; index += 1) {
    const offset = index * 4;
    png.data[offset] = 40 + (index % 20);
    png.data[offset + 1] = 90 + (Math.floor(index / 20) % 10);
    png.data[offset + 2] = 110;
    png.data[offset + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/);
});

test('a darker localized cyan object is not the proof asset', () => {
  const directory = makeTempDirSync('starter-dark-asset-test-');
  const path = join(directory, 'frame.png');
  const png = new PNG({ height: 128, width: 128 });
  for (let y = 0; y < 128; y += 1) {
    for (let x = 0; x < 128; x += 1) {
      const offset = (y * 128 + x) * 4;
      if (x < 16 && y < 16) {
        png.data[offset] = 11;
        png.data[offset + 1] = 118;
        png.data[offset + 2] = 128;
      } else {
        const index = y * 128 + x;
        png.data[offset] = index % 40;
        png.data[offset + 1] = 25 + (index % 12);
        png.data[offset + 2] = 50 + (index % 11);
      }
      png.data[offset + 3] = 255;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/);
});

test('a fragmented near-edge cyan wash is not asset evidence', () => {
  const directory = makeTempDirSync('starter-wash-test-');
  const path = join(directory, 'frame.png');
  const png = new PNG({ height: 128, width: 128 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const offset = (y * png.width + x) * 4;
      const index = y * png.width + x;
      png.data[offset] = index % 40;
      png.data[offset + 1] = 20 + (index % 30);
      png.data[offset + 2] = 50 + (index % 40);
      png.data[offset + 3] = 255;
    }
  }
  for (let y = 1; y < png.height - 1; y += 3) {
    for (let x = 1; x < png.width - 1; x += 1) {
      const offset = (y * png.width + x) * 4;
      png.data[offset] = 20;
      png.data[offset + 1] = 220;
      png.data[offset + 2] = 240;
    }
  }
  writeFileSync(path, PNG.sync.write(png));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/);
});

test('a frame that was never drawn is named as the capture, not a missing asset', () => {
  // The Linux starter lane failed intermittently with TN_NATIVE_STARTER_ASSET_NOT_VISIBLE while its
  // own log carried TN_NATIVE_STARTER_ASSETS_LOADED and "Rendered 300 frames". The capture held
  // five distinct colours against ~17,000 in the passing run: nothing had been drawn, so the asset
  // message pointed the reader at a texture that had loaded correctly.
  const directory = makeTempDirSync('starter-unrendered-test-');
  const path = join(directory, 'frame.png');
  // Capture-sized on purpose: the floor is deliberately not applied to small fixtures, because a
  // 16x16 synthetic frame is legitimately a handful of colours.
  const png = new PNG({ height: 128, width: 128 });
  for (let index = 0; index < 128 * 128; index += 1) {
    const offset = index * 4;
    const flat = index % 5;
    png.data[offset] = flat;
    png.data[offset + 1] = flat * 3;
    png.data[offset + 2] = flat * 6;
    png.data[offset + 3] = 255;
  }
  writeFileSync(path, PNG.sync.write(png));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_FRAME_NOT_RENDERED/);

  // A drawn frame that genuinely lacks the proof asset still reports the asset.
  writeFileSync(path, PNG.sync.write(cyanObjectFrame({ cyanPixels: 0 })));
  assert.throws(() => inspectStarterScreenshot(path), /TN_NATIVE_STARTER_ASSET_NOT_VISIBLE/);
});

test('primary CI invokes the native lane on pull requests and pushes', () => {
  const ci = readFileSync('../../.github/workflows/ci.yml', 'utf8');
  const ciTriggers = ci.slice(ci.indexOf('\non:'), ci.indexOf('concurrency:'));
  assert.match(ciTriggers, /pull_request:\s*\n\s*branches:\s*\n\s*-\s*main/u);
  assert.match(ciTriggers, /push:\s*\n\s*branches:\s*\n\s*-\s*main/u);

  const native = readFileSync('../../.github/workflows/native-platforms.yml', 'utf8');
  const nativeTriggers = native.slice(native.indexOf('\non:'), native.indexOf('concurrency:'));
  assert.match(nativeTriggers, /workflow_call:/u);
  assert.doesNotMatch(nativeTriggers, /(?:pull_request|schedule):/u);
  // A push to main starts the run the release-candidate gate needs (PRD-629); no other branch does.
  assert.match(nativeTriggers, /push:\s*\n\s*branches:\s*\[main\]/u);
});

test('native workflow verifies a freshly scaffolded starter on Linux', () => {
  const workflow = readFileSync('../../.github/workflows/native-platforms.yml', 'utf8');
  assert.match(
    workflow,
    /starter-linux:[\s\S]*uses: \.\/\.github\/actions\/scaffold-from-tarballs[\s\S]*template: starter[\s\S]*test:native/,
  );
  assert.match(workflow, /native-starter-\$\{\{ matrix\.platform \}\}/);
});

test('native workflow proves the Linux release container on x64 and arm64', () => {
  const workflow = readFileSync('../../.github/workflows/native-platforms.yml', 'utf8');
  const starter = workflow.match(/ {2}starter-linux:\n([\s\S]*?)\n {2}ios-simulator:/u)?.[1];
  assert.ok(starter);
  // The arm64 leg is the point of the matrix: a free hosted ARM runner, the same release steps,
  // and the same scope selection as the x64 leg because it is the same job.
  // The rows are shaped by the scope job — a job's `if` cannot read `matrix` — and an ordinary
  // pull request's reduced matrix (PRD-380 phase 2) keeps x64 alone. The scope job is light work and
  // stays on the light runner (PRD-620). linux-x64 is heavy: it routes through the TN_RUNNER switch
  // (PRD-480) only when the caller admitted this exact instance, and otherwise falls back to hosted;
  // arm64 stays hosted.
  const rows = workflow.match(/ {2}scope:\n([\s\S]*?)\n {2}web-reference:/u)?.[1];
  assert.ok(rows);
  assert.match(
    rows,
    /runs-on: \$\{\{ \(github\.event\.pull_request\.head\.repo\.fork \|\| !vars\.TN_RUNNER_LIGHT\) && 'ubuntu-24\.04' \|\| vars\.TN_RUNNER_LIGHT \}\}/u,
  );
  assert.match(
    rows,
    /\{ platform: "linux-x64", runner: "\$\{\{ \(github\.event\.pull_request\.head\.repo\.fork \|\| !vars\.TN_RUNNER \|\| !contains\(fromJSON\(steps\.admission\.outputs\.runner_admission \|\| '\[\]'\), 'native:starter-linux:linux-x64'\)\) && 'ubuntu-24\.04' \|\| vars\.TN_RUNNER \}\}" \}/u,
  );
  assert.match(rows, /\{ platform: "linux-arm64", runner: "ubuntu-24\.04-arm" \}/u);
  assert.match(rows, /rows\.slice\(0, 1\)/u);
  assert.match(starter, /matrix: \$\{\{ fromJSON\(needs\.scope\.outputs\.starter_rows\) \}\}/u);
  assert.match(starter, /runs-on: \$\{\{ matrix\.runner \}\}/u);
  // The runner has no GPU, so the software Vulkan ICD and its X display are provisioned.
  assert.match(starter, /mesa-vulkan-drivers/u);
  assert.match(starter, /xvfb/u);
  // The PRD states "lavapipe software Vulkan" only because the adapter is recorded, not assumed.
  assert.match(starter, /Record the WebGPU adapter the relocated release bound/u);
  assert.match(starter, /Adapter\|Vendor\|Backend/u);
  assert.match(starter, /adapter\.txt/u);
});

test('native workflow retains starter evidence when verification fails', () => {
  const workflow = readFileSync('../../.github/workflows/native-platforms.yml', 'utf8');
  const starter = workflow.match(/ {2}starter-linux:\n([\s\S]*?)\n {2}ios-simulator:/u)?.[1];
  assert.ok(starter);
  assert.match(starter, /- name: Collect starter evidence\n {8}if: always\(\)/u);
  assert.match(starter, /threenative-starter-native\/artifacts\/native/u);
});

test('starter verifier executes through a pnpm-style symlink', () => {
  const directory = makeTempDirSync('starter-desktop-cli-');
  const entrypoint = join(directory, 'verify-starter-desktop.mjs');
  symlinkSync(
    fileURLToPath(new URL('../scripts/verify-starter-desktop.mjs', import.meta.url)),
    entrypoint,
  );
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'starter' }));
  const result = spawnSync(process.execPath, [entrypoint], { cwd: directory, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TN_NATIVE_STARTER_ARTIFACT_MISSING/u);
});

// PRD-365 phase 2: a player machine provides the system WebView runtime; the container records it
// as a prerequisite and ships none of it. The verifier must name the missing library and its
// install step, not leak the dynamic loader's bare "not found".
test('a missing player-side WebView runtime is named with its install step', () => {
  const run = () => ({
    status: 0,
    stderr: '',
    stdout: 'linux-vdso.so.1 (0x00007fff)\n\tlibwebkit2gtk-4.1.so.0 => not found\n',
  });
  const manifest = { prerequisites: [{ name: 'libwebkit2gtk-4.1.so.0' }] };
  assert.throws(
    () => assertPlayerPrerequisites(manifest, '/opt/game/starter', { platform: 'linux', run }),
    (error) =>
      /TN_NATIVE_STARTER_PREREQUISITE_MISSING/u.test(error.message) &&
      /libwebkit2gtk-4\.1\.so\.0/u.test(error.message) &&
      /WebKitGTK 4\.1 runtime/u.test(error.message),
  );
});

test('an unrecorded missing library still fails with the generic install step', () => {
  // The manifest decides which libraries get the specific WebView/WebKit hint; a library the
  // container did not record is still a failure, just without that tailored install command.
  const run = () => ({ status: 0, stderr: '', stdout: '\tlibmystery.so.1 => not found\n' });
  assert.throws(
    () => assertPlayerPrerequisites({ prerequisites: [] }, '/opt/game/starter', { platform: 'linux', run }),
    (error) =>
      /TN_NATIVE_STARTER_PREREQUISITE_MISSING/u.test(error.message) &&
      /libmystery\.so\.1/u.test(error.message) &&
      !/WebKitGTK/u.test(error.message),
  );
});

test('a resolvable player-side WebView runtime passes the prerequisite check', () => {
  const run = () => ({
    status: 0,
    stderr: '',
    stdout: '\tlibwebkit2gtk-4.1.so.0 => /usr/lib/x86_64-linux-gnu/libwebkit2gtk-4.1.so.0 (0x00007f2a00000000)\n',
  });
  assert.deepEqual(
    assertPlayerPrerequisites(
      { prerequisites: [{ name: 'libwebkit2gtk-4.1.so.0' }] },
      '/opt/game/starter',
      { platform: 'linux', run },
    ),
    [],
  );
});

// PRD-365 phase 2: the verifier inspects and launches the release container from wherever the
// player unpacked it, without developer tools on PATH. The fake executable stands in for the
// packaged game; the relocation and the container manifest are real.
test.runIf(process.platform === 'linux')(
  'a relocated release container launches without developer tools',
  () => {
    const root = makeTempDirSync('starter-container-test-');
    const project = makeTempDirSync('starter-container-project-');
    const expectedScreenshot = join(root, 'expected.png');
    const proof = PNG.sync.read(readFileSync(PROOF_ASSET));
    writeFileSync(expectedScreenshot, PNG.sync.write(proof));
    const executable = join(root, 'starter');
    writeFileSync(
      executable,
      [
        '#!/bin/sh',
        'set -eu',
        'screenshot=',
        'while [ "$#" -gt 0 ]; do',
        '  case "$1" in',
        '    --screenshot) screenshot="$2"; shift 2 ;;',
        '    *) shift ;;',
        '  esac',
        'done',
        'cp "$TN_TEST_SCREENSHOT" "$screenshot"',
        "printf '%s\\n' 'TN_NATIVE_SMOKE_READY:webgpu' 'TN_NATIVE_STARTER_ASSETS_LOADED:texture,glb' 'TN_NATIVE_SMOKE_300_FRAMES:300' 'Rendered 300 frames in 1ms'",
        '',
      ].join('\n'),
    );
    chmodSync(executable, 0o755);
    const digest = createHash('sha256').update(readFileSync(executable)).digest('hex');
    // The game travels beside the executable, so a container without it is refused: a bare runtime
    // prints CLI usage instead of the game.
    const bundle = join(root, 'game.bundle');
    writeFileSync(bundle, Buffer.from('MYSBNDL1 fixture game payload'));
    const bundleDigest = createHash('sha256').update(readFileSync(bundle)).digest('hex');
    writeFileSync(
      join(root, 'threenative-container.json'),
      `${JSON.stringify(
        {
          app: { id: 'com.example.starter', name: 'Starter', version: '1.0.0', build: 1 },
          bundle: 'game.bundle',
          dependencies: [],
          executable: 'starter',
          format: 'tar.gz',
          platform: 'linux-x64',
          prerequisites: [],
          resources: { 'game.bundle': { sha256: bundleDigest }, starter: { sha256: digest } },
          schemaVersion: 1,
          ui: null,
        },
        null,
        2,
      )}\n`,
    );
    const report = verifyStarterContainer({
      env: { PATH: '/usr/bin:/bin', TN_TEST_SCREENSHOT: expectedScreenshot },
      project,
      root,
      // `ldd` on the shell-script stand-in is not a real ELF program; the seam returns a clean
      // census, which is the host's job to provide for a real binary.
      run: () => ({ status: 0, stderr: '', stdout: 'linux-vdso.so.1 (0x00007fff)\n' }),
    });
    assert.equal(report.pass, true);
    assert.equal(report.frames, 300);
  },
);

test('the container flag routes the verifier to the unpacked container', () => {
  // `--container` must populate the resolver's root, or the CLI route silently throws the
  // raw-artifact guard. An empty directory reaches the container resolver, which names the missing
  // manifest — proving the flag is wired.
  const directory = makeTempDirSync('starter-container-cli-');
  const entrypoint = join(directory, 'verify-starter-desktop.mjs');
  symlinkSync(
    fileURLToPath(new URL('../scripts/verify-starter-desktop.mjs', import.meta.url)),
    entrypoint,
  );
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'starter' }));
  const result = spawnSync(process.execPath, [entrypoint, '--container', directory], {
    cwd: directory,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stderr, /TN_NATIVE_STARTER_CONTAINER_MISSING/u);
  assert.match(result.stderr, /TN_DESKTOP_CONTAINER_MANIFEST_MISSING/u);
});

// Cross-PR merge hazard (PRD-366 / PRD-375 #255), re-proved after #255 merged as 20f5d6191.
// `--container ""` was once falsy, so the CLI silently dropped the flag and ran the NON-container
// desktop path, reporting success for a container verification that never happened. #255 hardened
// the parser in verify-starter-desktop.mjs; this branch moved that code into
// verify-starter-desktop-base.mjs. These rows assert the hardening lives in the file that now
// SHIPS it, so the reconciliation cannot silently lose it. The error taxonomy is #255's
// (TN_NATIVE_STARTER_CLI_INVALID), which is the incumbent contract this branch converged on.
const BASE_CLI = fileURLToPath(new URL('../scripts/verify-starter-desktop-base.mjs', import.meta.url));

function runBaseCli(args, directory) {
  return spawnSync(process.execPath, [BASE_CLI, ...args], { cwd: directory, encoding: 'utf8' });
}

for (const flag of ['--container', '--config', '--frames', '--project']) {
  test(`an empty ${flag} value fails closed in the base file instead of silently dropping the flag`, () => {
    const directory = makeTempDirSync('starter-desktop-empty-flag-');
    const result = runBaseCli([flag, '', '--project', directory], directory);
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /TN_NATIVE_STARTER_CLI_INVALID/u);
    assert.match(`${result.stdout}${result.stderr}`, new RegExp(`${flag} needs a value`, 'u'));
  });
}

test('an unknown flag is refused by name rather than ignored', () => {
  const directory = makeTempDirSync('starter-desktop-unknown-flag-');
  const result = runBaseCli(['--not-a-flag', 'x', '--project', directory], directory);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /TN_NATIVE_STARTER_CLI_INVALID: unknown flag/u);
});

test('--frames rejects a non-positive-integer rather than coercing it', () => {
  const directory = makeTempDirSync('starter-desktop-frames-');
  for (const value of ['0', '-1', 'abc', '1.5']) {
    const result = runBaseCli(['--frames', value, '--project', directory], directory);
    assert.notEqual(result.status, 0, `--frames ${value} should fail`);
    assert.match(`${result.stdout}${result.stderr}`, /--frames needs a positive whole number/u);
  }
});

test('--brand-only still reaches the brand surface and still refuses a missing --config', () => {
  const directory = makeTempDirSync('starter-desktop-brand-only-');
  const result = runBaseCli(['--brand-only', '--container', directory, '--project', directory], directory);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /--brand-only needs --config/u);
});

test('the router re-exports the brand surface so --brand-only callers keep resolving', async () => {
  const router = await import('../scripts/verify-starter-desktop.mjs');
  for (const name of ['verifyContainerBrand', 'verifyStarterContainer', 'verifyStarterDesktop',
    'verifyStarterConsumerGameplay', 'assertConsumerTargetRows']) {
    assert.equal(typeof router[name], 'function', `${name} must resolve through the router`);
  }
});

test('launches the launcher inside a desktop container, not the container directory (PRD-637)', () => {
  // `build:desktop` of a registry install writes `dist-native/<name>/<name>`; spawning the
  // directory exited 126 ("Is a directory") in the post-publish clean room.
  const directory = makeTempDirSync('threenative-desktop-target-');
  const container = join(directory, 'dist-native', 'game');
  mkdirSync(container, { recursive: true });
  writeFileSync(join(container, 'game'), '#!/bin/sh\n');
  assert.equal(desktopLaunchTarget(container, 'game'), join(container, 'game'));
  const flat = join(directory, 'flat');
  writeFileSync(flat, '#!/bin/sh\n');
  assert.equal(desktopLaunchTarget(flat, 'flat'), flat);
});

function ownedSmokeFixture({ count = 300, blank = false, status = 0, source = 'present-return', gap = false } = {}) {
  const project = makeTempDirSync('owned-kit-smoke-');
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'shooter' }));
  const artifact = join(project, 'dist-native', 'shooter');
  mkdirSync(artifact, { recursive: true });
  writeFileSync(join(artifact, 'shooter'), 'launcher');
  writeFileSync(join(artifact, 'tn-native-engine-player-v8'), 'player');
  const cli = join(project, 'node_modules', '@threenative', 'playtest', 'dist', 'runner');
  mkdirSync(cli, { recursive: true });
  writeFileSync(join(cli, 'cli.js'), 'fixture runner');
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const scenario = JSON.parse(readFileSync(args[1], 'utf8'));
    assert.equal(scenario.steps.at(-1).label, 'native-smoke');
    assert.equal(options.env.TN_PLAYTEST_COMPLETION_WINDOW_MIN_FRAMES, '300');
    const output = args[args.indexOf('--artifacts') + 1];
    mkdirSync(output, { recursive: true });
    const png = new PNG({ width: 2, height: 2 });
    png.data.fill(255);
    if (!blank) png.data[0] = 0;
    writeFileSync(join(output, 'after.png'), PNG.sync.write(png));
    return { status, stdout: JSON.stringify({ pass: true, assertionResults: [{ pass: true }], acquisition: { completionWindow: {
      source, timebase: 'steady-clock-ms',
      samples: Array.from({ length: count }, (_, i) => ({ sequence: i + 101 + (gap && i > 5 ? 1 : 0), completedAtMs: 2000 + i * 20 })),
    } } }), stderr: '' };
  };
  return { project, run, calls };
}

test('ordinary owned-player verification uses a generic smoke and observes 300 presents', () => {
  const f = ownedSmokeFixture();
  const result = verifyStarterDesktop({ project: f.project, frames: 300, run: f.run });
  assert.equal(result.frames, 300);
  assert.equal(result.pass, true);
  assert.equal(result.gate, 'native-smoke');
  assert.equal(existsSync(f.calls[0].args[1]), false, 'temporary scenario cleaned');
});

test('the owned-player CLI prints its completed smoke report and exits successfully', () => {
  const f = ownedSmokeFixture();
  const png = new PNG({ width: 2, height: 2 });
  png.data.fill(255);
  png.data[0] = 0;
  const cli = join(f.project, 'node_modules', '@threenative', 'playtest', 'dist', 'runner', 'cli.js');
  writeFileSync(cli, `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const output = args[args.indexOf('--artifacts') + 1];
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(output + '/after.png', Buffer.from('${PNG.sync.write(png).toString('base64')}', 'base64'));
    console.log(JSON.stringify({ pass: true, assertionResults: [{ pass: true }], acquisition: { completionWindow: {
      source: 'present-return', timebase: 'steady-clock-ms',
      samples: Array.from({ length: 300 }, (_, i) => ({ sequence: i + 1, completedAtMs: i * 20 }))
    } } }));
  `);
  const result = spawnSync(process.execPath, [BASE_CLI, '--project', f.project], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /300 native presents.*1 playtest assertions/u);
});

for (const [name, options, pattern] of [
  ['299 presents', { count: 299 }, /completion/u],
  ['callback counts instead of native presents', { source: 'render-callback-return' }, /completion/u],
  ['a completion gap', { gap: true }, /completion/u],
  ['blank capture', { blank: true }, /blank/u],
  ['failed runner', { status: 1 }, /runner/u],
]) {
  test(`owned-player verification rejects ${name} and cleans its scenario`, () => {
    const f = ownedSmokeFixture(options);
    assert.throws(() => verifyStarterDesktop({ project: f.project, frames: 300, run: f.run }), pattern);
    assert.equal(f.calls.length, 1);
    assert.equal(existsSync(f.calls[0].args[1]), false);
  });
}
