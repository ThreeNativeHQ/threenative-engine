#!/usr/bin/env node
// PRD-784 PS4 visual parity lock: named region checks on one presented Cube Spin frame.
//
// Usage: node packages/runtime-native/scripts/ps4/check-frame.mjs <frame.png>...
//
// The local capture it checks (no CI runner has shadPS4, the OpenOrbis toolchain or a PS4 V8 build):
//   TN_PS4_HOST_HZ=0 TN_PS4_SCREENSHOT_AT=26,30 node packages/runtime-native/scripts/ps4/run-experiment.mjs \
//     e5 --scene <Cube Spin dir>
//   node packages/runtime-native/scripts/ps4/check-frame.mjs <scratch>/e5/out/screen-26.png <scratch>/e5/out/screen-30.png
// It exits 1 when any claim fails. tests/ps4-frame-check.test.mjs holds the claims red-green on kept frames.
//
// Each claim reads one region of the 1280x720 game image (a 1600x900 e5 capture is cropped at
// +160+90 first) and fails when the PS4 fix it names regresses. A pixel diff is not a verdict; each
// claim says what it measures and which regressed frame it rejects. The regions belong to the Cube
// Spin scene at the e5 capture pose (TN_PS4_SCREENSHOT_AT=26,30); another scene needs its own.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export const GAME_WIDTH = 1280;
export const GAME_HEIGHT = 720;

// Regions in game-image pixels: x, y, width, height.
export const REGIONS = {
  sky: [160, 0, 480, 100],
  wall: [400, 130, 320, 64],
  farFloor: [400, 360, 480, 64],
  nearFloor: [0, 624, 320, 96],
  shadow: [760, 265, 90, 20],
};

export function readFrame(file) {
  const png = PNG.sync.read(readFileSync(file));
  return gameImage({ width: png.width, height: png.height, data: png.data });
}

// The e5 capture is the 1600x900 emulator window around the 1280x720 game image.
export function gameImage(frame) {
  if (frame.width === GAME_WIDTH && frame.height === GAME_HEIGHT) return frame;
  if (frame.width !== 1600 || frame.height !== 900) {
    throw new Error(`TN_PS4_FRAME_SIZE: ${frame.width}x${frame.height}; expected 1280x720 or a 1600x900 e5 capture`);
  }
  const data = Buffer.alloc(GAME_WIDTH * GAME_HEIGHT * 4);
  for (let y = 0; y < GAME_HEIGHT; y += 1) {
    const from = ((y + 90) * 1600 + 160) * 4;
    frame.data.copy(data, y * GAME_WIDTH * 4, from, from + GAME_WIDTH * 4);
  }
  return { width: GAME_WIDTH, height: GAME_HEIGHT, data };
}

// Rec. 709 luminance in 0..1 for one region, row-major.
function luminance(frame, [x0, y0, w, h]) {
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = ((y0 + y) * frame.width + x0 + x) * 4;
      out[y * w + x] = (0.2126 * frame.data[i] + 0.7152 * frame.data[i + 1] + 0.0722 * frame.data[i + 2]) / 255;
    }
  }
  return out;
}

function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

// Mean of a (2r+1)^2 box around each pixel, clamped at the region edge.
function boxMean(values, w, h, r) {
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y += 1) {
    let row = 0;
    for (let x = 0; x < w; x += 1) {
      row += values[y * w + x];
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const xa = Math.max(0, x - r);
      const xb = Math.min(w, x + r + 1);
      const sum = integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb] - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa];
      out[y * w + x] = sum / ((yb - ya) * (xb - xa));
    }
  }
  return out;
}

// The mask after a (2r+1)^2 erosion: a pixel stays only when its whole neighbourhood is set. A 1-2 px
// line erodes away at r=1; a 4 px block keeps its core.
function erode(mask, w, h, r) {
  const out = new Uint8Array(w * h);
  for (let y = r; y < h - r; y += 1) {
    next: for (let x = r; x < w - r; x += 1) {
      for (let dy = -r; dy <= r; dy += 1) {
        for (let dx = -r; dx <= r; dx += 1) if (!mask[(y + dy) * w + x + dx]) continue next;
      }
      out[y * w + x] = 1;
    }
  }
  return out;
}

// The 4-connected components of a mask: their count and their total area.
function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  let count = 0;
  let area = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    count += 1;
    seen[start] = 1;
    const stack = [start];
    while (stack.length > 0) {
      const i = stack.pop();
      area += 1;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < mask.length && mask[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
  }
  return { count, area };
}

// Dark texel blocks: pixels 0.04 below their 15x15 surroundings, eroded 3x3, counted as components.
// A mip chain sampled from a scrambled (non micro-tiled) layout shows as rows of 4-6 px dark blocks
// on the wall grid; a mipped grid line is 1-2 px and erodes away.
export function darkBlocks(frame, region) {
  const [, , w, h] = region;
  const lum = luminance(frame, region);
  const local = boxMean(lum, w, h, 7);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i += 1) mask[i] = lum[i] < local[i] - 0.04 ? 1 : 0;
  return components(erode(mask, w, h, 1), w, h).count;
}

// Mean absolute 4-neighbour Laplacian: the high-frequency energy of a region. A minified grid
// read from mip 0 (sampler maxLod wrapped to 0) aliases into dashed lines and lifts it.
export function highFrequency(frame, region) {
  const [, , w, h] = region;
  const lum = luminance(frame, region);
  let sum = 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const i = y * w + x;
      sum += Math.abs(4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]);
    }
  }
  return sum / ((w - 2) * (h - 2));
}

// Median of the luminance standard deviation over 8x8 blocks: the concrete normal-map relief.
// The median ignores the few blocks a grid line crosses. A flipped front face flattens the relief.
export function relief(frame, region) {
  const [, , w, h] = region;
  const lum = luminance(frame, region);
  const deviations = [];
  for (let by = 0; by + 8 <= h; by += 8) {
    for (let bx = 0; bx + 8 <= w; bx += 8) {
      let sum = 0;
      let squares = 0;
      for (let y = by; y < by + 8; y += 1) {
        for (let x = bx; x < bx + 8; x += 1) {
          const v = lum[y * w + x];
          sum += v;
          squares += v * v;
        }
      }
      deviations.push(Math.sqrt(Math.max(0, squares / 64 - (sum / 64) ** 2)));
    }
  }
  deviations.sort((a, b) => a - b);
  return deviations[deviations.length >> 1];
}

// Mean cloud fragment area in pixels: bright, low-saturation sky pixels grouped into 4-connected
// fragments. An intact 3D noise volume gives puffy clouds, a few large fragments; a tiled volume read
// as linear smears them into many thin streaks.
export function cloudFragmentArea(frame, region) {
  const [x0, y0, w, h] = region;
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = ((y0 + y) * frame.width + x0 + x) * 4;
      const r = frame.data[i];
      const g = frame.data[i + 1];
      const b = frame.data[i + 2];
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      mask[y * w + x] = Math.max(r, g, b) - Math.min(r, g, b) < 70 && lum > 0.55 ? 1 : 0;
    }
  }
  const { count, area } = components(mask, w, h);
  return count === 0 ? 0 : area / count;
}

export function regionMean(frame, region) {
  return mean(luminance(frame, region));
}

// The web frame's floor and wall tone (cube-spin-web-run1.png, WebGPU on an RTX 2080): the mean
// luminance of the wall and near-floor regions together.
export const WEB_TONE = 0.605;

function tone(frame) {
  const [, , ww, wh] = REGIONS.wall;
  const [, , fw, fh] = REGIONS.nearFloor;
  return (regionMean(frame, REGIONS.wall) * ww * wh + regionMean(frame, REGIONS.nearFloor) * fw * fh) / (ww * wh + fw * fh);
}

// One claim per fix. Each bound sits between the good PS4 and web frames and the regressed frame it
// names (values measured 2026-11-07 on the reference frames in ~/Downloads/prd784-ps4).
export const CLAIMS = [
  {
    name: 'grid lines stay continuous at a distance (0054 sampler LOD clamp, CPU mip chain)',
    measure: (frame) => highFrequency(frame, REGIONS.farFloor),
    max: 0.028, // good 0.016-0.021; mip 0 only (dashed lines) 0.035
  },
  {
    name: 'no dark texel blocks on the wall grid (0055 mipmapped textures micro-tiled)',
    measure: (frame) => darkBlocks(frame, REGIONS.wall),
    max: 5, // good 0; scrambled mips 21
  },
  {
    name: 'concrete normal-map relief on the floor (0056 float front face)',
    measure: (frame) => relief(frame, REGIONS.nearFloor),
    min: 0.008, // good 0.0123-0.0129; flat 0.0035-0.0051
  },
  {
    name: 'puffy clouds, not streaks (0057 3D textures linear)',
    measure: (frame) => cloudFragmentArea(frame, REGIONS.sky),
    min: 160, // good 323-361 px; streaks 40-78 px
  },
  {
    name: 'shadows keep the sky fill, not black (0055 rough PMREM levels)',
    measure: (frame) => regionMean(frame, REGIONS.shadow),
    min: 0.2, // good 0.326-0.333; no regressed frame of this kept, so the test darkens one
  },
  {
    name: 'floor and wall tone matches the web frame',
    measure: (frame) => Math.abs(tone(frame) - WEB_TONE),
    max: 0.03, // PS4 0.015-0.016 from web
  },
];

// Every claim's value and verdict. A claim with no bound is a bug in this file, not a pass.
export function checkFrame(frame) {
  return CLAIMS.map(({ name, measure, min, max }) => {
    if (min === undefined && max === undefined) throw new Error(`TN_PS4_FRAME_CLAIM_UNBOUNDED: ${name}`);
    const value = measure(frame);
    const pass = Number.isFinite(value) && (min === undefined || value >= min) && (max === undefined || value <= max);
    return { name, value, min, max, pass };
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: check-frame.mjs <frame.png>...');
    process.exit(2);
  }
  let failed = false;
  for (const file of files) {
    for (const claim of checkFrame(readFrame(file))) {
      const bound = claim.min !== undefined ? `>= ${claim.min}` : `<= ${claim.max}`;
      console.log(`${claim.pass ? 'PASS' : 'FAIL'} ${file}: ${claim.name}: ${claim.value.toPrecision(4)} (${bound})`);
      failed ||= !claim.pass;
    }
  }
  process.exit(failed ? 1 : 0);
}
