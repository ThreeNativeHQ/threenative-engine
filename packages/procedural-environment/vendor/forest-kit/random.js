// Deterministic randomness + noise. Everything in the kit is seeded, so a world
// rebuilds identically from the same seed and tiles can be regenerated at will.

export function mulberry32(seed) {
  let a = seed | 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer lattice hash → uint32. */
export function hash2i(x, y, seed = 0) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1274126177)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

export function hash01(x, y, seed = 0) {
  return hash2i(x, y, seed) / 4294967296;
}

const quintic = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in [0,1]. `period` > 0 makes it tile (for textures). */
export function valueNoise(x, y, seed = 0, period = 0, periodY = period) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = quintic(x - x0), fy = quintic(y - y0);
  let xa = x0, xb = x0 + 1, ya = y0, yb = y0 + 1;
  if (period > 0) {
    xa = ((xa % period) + period) % period; xb = ((xb % period) + period) % period;
    ya = ((ya % periodY) + periodY) % periodY; yb = ((yb % periodY) + periodY) % periodY;
  }
  const a = hash01(xa, ya, seed), b = hash01(xb, ya, seed);
  const c = hash01(xa, yb, seed), d = hash01(xb, yb, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Fractal value noise, normalised to roughly [0,1]. */
export function fbm(x, y, seed = 0, octaves = 4, period = 0, periodY = period) {
  let sum = 0, amp = 0.5, norm = 0, p = period, py = periodY;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(x, y, seed + o * 101, p, py);
    norm += amp;
    x *= 2; y *= 2; p *= 2; py *= 2; amp *= 0.5;
  }
  return sum / norm;
}

/** Ridged variant — good for bark fissures and cracks. */
export function ridged(x, y, seed = 0, octaves = 4, period = 0, periodY = period) {
  let sum = 0, amp = 0.5, norm = 0, p = period, py = periodY;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise(x, y, seed + o * 57, p, py) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    x *= 2; y *= 2; p *= 2; py *= 2; amp *= 0.5;
  }
  return sum / norm;
}

export const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export function smoothstep(a, b, x) {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
/** Random helpers bound to a rand() function. */
export const range = (rand, a, b) => a + (b - a) * rand();
export const pick = (rand, arr) => arr[Math.floor(rand() * arr.length) % arr.length];
