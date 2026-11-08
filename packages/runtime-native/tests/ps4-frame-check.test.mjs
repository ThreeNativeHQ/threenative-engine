import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { REGIONS, checkFrame, gameImage, readFrame } from '../scripts/ps4/check-frame.mjs';

// PRD-784 visual parity lock. The fixtures keep only the checked regions of the Cube Spin e5 frames a
// visual judge rated (PS4 and web MATCH); everything else is black. The regressed frames are the
// states each fix removed, so every claim is red on its own regression and green on parity.
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = (name) => readFrame(`${root}tests/fixtures/ps4-frames/cube-spin-${name}.png`);
const failed = (frame) => checkFrame(frame).filter((claim) => !claim.pass).map((claim) => claim.name.split(' (')[0]);

test('the PS4 frame at parity and the web frame pass every claim (PRD-784)', () => {
  assert.deepEqual(failed(fixture('ps4')), []);
  assert.deepEqual(failed(fixture('web')), []);
});

test('mip 0 only, before the sampler LOD clamp and the CPU mip chain, fails the grid claim (PRD-784)', () => {
  assert.ok(failed(fixture('before')).includes('grid lines stay continuous at a distance'));
});

test('mips sampled from a non micro-tiled layout fail the dark-block claim (PRD-784)', () => {
  assert.ok(failed(fixture('cpumips')).includes('no dark texel blocks on the wall grid'));
});

test('the frame just before 0057 fails only the cloud claim; flat relief fails the relief claim (PRD-784)', () => {
  assert.deepEqual(failed(fixture('face')), ['puffy clouds, not streaks']);
  assert.ok(failed(fixture('cpumips')).includes('concrete normal-map relief on the floor'));
});

test('a black shadow and a darker frame fail the shadow and tone claims (PRD-784)', () => {
  // No regressed 1280x720 frame of either state was kept, so these two controls are made from the good one.
  const shadow = fixture('ps4');
  const [x0, y0, w, h] = REGIONS.shadow;
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) for (let c = 0; c < 3; c += 1) shadow.data[(y * shadow.width + x) * 4 + c] = 10;
  }
  assert.deepEqual(failed(shadow), ['shadows keep the sky fill, not black']);
  const dark = fixture('ps4');
  for (let i = 0; i < dark.data.length; i += 4) for (let c = 0; c < 3; c += 1) dark.data[i + c] = Math.round(dark.data[i + c] * 0.88);
  assert.ok(failed(dark).includes('floor and wall tone matches the web frame'));
});

test('a 1600x900 e5 capture is checked on its 1280x720 game image; another size is refused', () => {
  const game = fixture('ps4');
  const data = Buffer.alloc(1600 * 900 * 4, 255);
  for (let y = 0; y < 720; y += 1) game.data.copy(data, ((y + 90) * 1600 + 160) * 4, y * 1280 * 4, (y + 1) * 1280 * 4);
  assert.deepEqual(
    checkFrame(gameImage({ width: 1600, height: 900, data })).map((claim) => claim.value),
    checkFrame(game).map((claim) => claim.value),
  );
  assert.throws(() => gameImage({ width: 640, height: 360, data: Buffer.alloc(640 * 360 * 4) }), /TN_PS4_FRAME_SIZE/u);
});

test('PS4 builds texture mip chains on the CPU, one queue write per level (PRD-784)', () => {
  // A mipmapped render target never got its upper levels tiled: distant floors sampled zeros.
  const header = readFileSync(`${root}src/engine/renderer/texture_copy.h`, 'utf8');
  assert.match(header, /#if defined\(TN_PS4\)\ninline constexpr bool kCpuMipChain = true;/u);
  const renderer = readFileSync(`${root}src/engine/renderer/renderer.cpp`, 'utf8');
  assert.match(renderer, /if \(kCpuMipChain && key\.levels > 1\) \{/u);
  assert.match(renderer, /downsampleRgba8\(/u);
});
