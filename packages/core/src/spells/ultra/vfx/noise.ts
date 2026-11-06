// Ported from Ultra Elements src/vfx/noise.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
//
// One change the engine forces: upstream bakes the two 3D textures on the GPU, one fullscreen draw
// per z slice into a WebGL3DRenderTarget. The ThreeNative engine has Data3DTexture/texture3D but no
// 3D render target, so the same HASH / NOISE_FRAG / CURL_FRAG maths runs here on the CPU, texel for
// texel (GLSL -> JS: uint maths through Math.imul and >>> 0), into the same RGBA8 layout. The lattice
// hashes are memoised per octave (a pure function of the wrapped cell), so each texel pays the
// interpolation, not the hash. bakeNoise() logs the wall time.
import {
  Color,
  Data3DTexture,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  RGBAFormat,
  RepeatWrapping,
} from "three";
import { U } from "./common.js";

// Procedural noise, baked at load (no assets):
//   noise3D  N^3 RGBA8, tileable on all axes. r = Perlin-Worley fbm (Schneider 2015: Perlin fbm
//            dilated by Worley fbm), g/b/a = inverted Worley F1 fbm at base frequencies 2/4/8.
//   curl3D   64^3 RGBA8, tileable. rgb = curl * 0.5 + 0.5 of a 3-field gradient-noise vector
//            potential (Bridson et al. 2007), divergence-free by construction.
//   blackbody 256x1 RGBA16F, CPU: Planck x Wyman-Sloan-Shirley 2013 CIE fit -> linear sRGB, Y = 1.
// Sampling contract: NOISE_GLSL in common.js (noise3v, noise3, worley3, curl3, fbm3, blackbody in common.ts).

// --- HASH (GLSL -> JS) -------------------------------------------------------------------
// pcg3d (Jarzynski & Olano 2020): cheap and free of lattice artefacts
const _v = new Uint32Array(3);
function pcg3d(x: number, y: number, z: number): Uint32Array {
  const v = _v;
  v[0] = Math.imul(x, 1664525) + 1013904223;
  v[1] = Math.imul(y, 1664525) + 1013904223;
  v[2] = Math.imul(z, 1664525) + 1013904223;
  v[0] = (v[0] as number) + Math.imul(v[1] as number, v[2] as number);
  v[1] = (v[1] as number) + Math.imul(v[2] as number, v[0] as number);
  v[2] = (v[2] as number) + Math.imul(v[0] as number, v[1] as number);
  v[0] = (v[0] as number) ^ ((v[0] as number) >>> 16);
  v[1] = (v[1] as number) ^ ((v[1] as number) >>> 16);
  v[2] = (v[2] as number) ^ ((v[2] as number) >>> 16);
  v[0] = (v[0] as number) + Math.imul(v[1] as number, v[2] as number);
  v[1] = (v[1] as number) + Math.imul(v[2] as number, v[0] as number);
  v[2] = (v[2] as number) + Math.imul(v[0] as number, v[1] as number);
  return v;
}
// lattice point -> hash, wrapped at period P so every octave tiles the unit cube. c is always
// within one period of [0, P), so a select replaces two integer modulos per component.
const wrapP = (c: number, P: number): number => c + P * ((c < 0 ? 1 : 0) - (c >= P ? 1 : 0));
function hashL(cx: number, cy: number, cz: number, P: number, seed: number): Uint32Array {
  return pcg3d(
    (wrapP(cx, P) + Math.imul(seed, 0x9e3779b9)) >>> 0,
    (wrapP(cy, P) + Math.imul(seed, 0x85ebca6b)) >>> 0,
    (wrapP(cz, P) + Math.imul(seed, 0xc2b2ae35)) >>> 0,
  );
}
// hash3(c, P, seed) = vec3(hashL(c, P, seed) >> 8u) * (1.0 / 16777216.0), memoised per (P, seed):
// table[(z * P + y) * P + x] over the wrapped lattice
function hash3Table(P: number, seed: number): Float32Array {
  const t = new Float32Array(P * P * P * 3);
  for (let z = 0; z < P; z++)
    for (let y = 0; y < P; y++)
      for (let x = 0; x < P; x++) {
        const h = hashL(x, y, z, P, seed);
        const o = ((z * P + y) * P + x) * 3;
        t[o] = ((h[0] as number) >>> 8) * (1.0 / 16777216.0);
        t[o + 1] = ((h[1] as number) >>> 8) * (1.0 / 16777216.0);
        t[o + 2] = ((h[2] as number) >>> 8) * (1.0 / 16777216.0);
      }
  return t;
}
// gnoiseGrad3's three gradients per corner, memoised the same way: 9 floats per lattice point
function grad3Table(P: number, seed: number): Float32Array {
  const t = new Float32Array(P * P * P * 9);
  for (let z = 0; z < P; z++)
    for (let y = 0; y < P; y++)
      for (let x = 0; x < P; x++) {
        const h = hashL(x, y, z, P, seed);
        const o = ((z * P + y) * P + x) * 9;
        for (let c = 0; c < 3; c++) {
          const hc = h[c] as number;
          t[o + c] = ((hc >>> 22) & 1023) / 511.5 - 1.0;
          t[o + 3 + c] = ((hc >>> 12) & 1023) / 511.5 - 1.0;
          t[o + 6 + c] = ((hc >>> 2) & 1023) / 511.5 - 1.0;
        }
      }
  return t;
}
const cellIndex = (x: number, y: number, z: number, P: number): number =>
  (wrapP(z, P) * P + wrapP(y, P)) * P + wrapP(x, P);

// inverted Worley F1: 1 at feature points, ~0 on cell borders. x in cells (= p * P)
function worley(px: number, py: number, pz: number, P: number, table: Float32Array): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;
  let d = 8.0;
  for (let z = -1; z <= 1; z++)
    for (let y = -1; y <= 1; y++)
      for (let k = -1; k <= 1; k++) {
        const h = cellIndex(ix + k, iy + y, iz + z, P) * 3;
        const rx = k + (table[h] as number) - fx;
        const ry = y + (table[h + 1] as number) - fy;
        const rz = z + (table[h + 2] as number) - fz;
        d = Math.min(d, rx * rx + ry * ry + rz * rz);
      }
  return 1.0 - Math.min(Math.max(Math.sqrt(d), 0.0), 1.0);
}
// quintic gradient noise, ~[-1, 1]; corners in a loop (one inlined hash instead of eight)
function gnoise(px: number, py: number, pz: number, P: number, table: Float32Array): number {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;
  const ux = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
  const uy = fy * fy * fy * (fy * (fy * 6.0 - 15.0) + 10.0);
  const uz = fz * fz * fz * (fz * (fz * 6.0 - 15.0) + 10.0);
  let v = 0.0;
  for (let c = 0; c < 8; c++) {
    const ox = c & 1;
    const oy = (c >> 1) & 1;
    const oz = c >> 2;
    const sx = ox ? ux : 1.0 - ux;
    const sy = oy ? uy : 1.0 - uy;
    const sz = oz ? uz : 1.0 - uz;
    const h = cellIndex(ix + ox, iy + oy, iz + oz, P) * 3;
    v +=
      sx *
      sy *
      sz *
      (((table[h] as number) * 2.0 - 1.0) * (fx - ox) +
        ((table[h + 1] as number) * 2.0 - 1.0) * (fy - oy) +
        ((table[h + 2] as number) * 2.0 - 1.0) * (fz - oz));
  }
  return v;
}
// gradients (d/dx) of three independent gradient-noise fields at once, as mat3 columns. One
// hash per corner carries all three gradients (10 bits per component). J: 9 floats, column k at 3k.
function gnoiseGrad3(
  px: number,
  py: number,
  pz: number,
  P: number,
  table: Float32Array,
  J: Float64Array,
  amp: number,
): void {
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const iz = Math.floor(pz);
  const fx = px - ix;
  const fy = py - iy;
  const fz = pz - iz;
  const ux = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0);
  const dux = 30.0 * fx * fx * (fx * (fx - 2.0) + 1.0);
  const uy = fy * fy * fy * (fy * (fy * 6.0 - 15.0) + 10.0);
  const duy = 30.0 * fy * fy * (fy * (fy - 2.0) + 1.0);
  const uz = fz * fz * fz * (fz * (fz * 6.0 - 15.0) + 10.0);
  const duz = 30.0 * fz * fz * (fz * (fz - 2.0) + 1.0);
  for (let c = 0; c < 8; c++) {
    const ox = c & 1;
    const oy = (c >> 1) & 1;
    const oz = c >> 2;
    const fox = fx - ox;
    const foy = fy - oy;
    const foz = fz - oz;
    const sx = ox ? ux : 1.0 - ux;
    const sy = oy ? uy : 1.0 - uy;
    const sz = oz ? uz : 1.0 - uz;
    const dsx = ox ? dux : -dux;
    const dsy = oy ? duy : -duy;
    const dsz = oz ? duz : -duz;
    const w = sx * sy * sz;
    const dwx = dsx * sy * sz;
    const dwy = sx * dsy * sz;
    const dwz = sx * sy * dsz;
    const h = cellIndex(ix + ox, iy + oy, iz + oz, P) * 9;
    for (let k = 0; k < 3; k++) {
      const gx = table[h + 3 * k] as number;
      const gy = table[h + 3 * k + 1] as number;
      const gz = table[h + 3 * k + 2] as number;
      const gf = gx * fox + gy * foy + gz * foz;
      J[3 * k] = (J[3 * k] as number) + (w * gx + gf * dwx) * amp;
      J[3 * k + 1] = (J[3 * k + 1] as number) + (w * gy + gf * dwy) * amp;
      J[3 * k + 2] = (J[3 * k + 2] as number) + (w * gz + gf * dwz) * amp;
    }
  }
}

// calibration knobs, from dev/fields.js "noise stats" (1st / 99th percentiles of the raw sums;
// curl scale puts the mean |curl| at 0.5)
// biome-ignore lint/style/useNamingConvention: upstream Ultra Elements code, copied verbatim
export const NOISE_TUNING = { PW_LO: 0.53, PW_HI: 0.9, W_LO: 0.21, W_HI: 0.75, CURL_SCALE: 0.37 };

// Ranges measured from a readback histogram of the raw fbm (dev/fields.js "noise stats"):
// stretch the 1st..99th percentile to 0..1 so volume thresholds have the whole byte range.
const stretch = (x: number, lo: number, hi: number): number =>
  Math.min(Math.max((x - lo) / (hi - lo), 0.0), 1.0);
// what the GPU stores for a float written to an RGBA8 target
const unorm8 = (x: number): number => Math.round(Math.min(Math.max(x, 0), 1) * 255);

// NOISE_FRAG for every texel of an N^3 RGBA8 volume (vUv, uZ at texel centres)
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
function bakeNoiseData(size: number): Uint8Array {
  const { PW_LO, PW_HI, W_LO, W_HI } = NOISE_TUNING;
  const g = Array.from({ length: 5 }, (_, o) => hash3Table(4 << o, 7));
  const w = Array.from({ length: 5 }, (_, o) => hash3Table(2 << o, o + 1));
  const out = new Uint8Array(size * size * size * 4);
  const gba = [0, 0, 0];
  for (let z = 0; z < size; z++) {
    const pz = (z + 0.5) / size;
    for (let y = 0; y < size; y++) {
      const py = (y + 0.5) / size;
      for (let x = 0; x < size; x++) {
        const px = (x + 0.5) / size;
        let pf = 0.0;
        let amp = 1.0;
        for (let o = 0; o < 5; o++) {
          const P = 4 << o;
          pf += gnoise(px * P, py * P, pz * P, P, g[o] as Float32Array) * amp;
          amp *= 0.5;
        }
        const perlin = Math.min(Math.max(pf * 0.5 + 0.5, 0.0), 1.0);
        // Worley octaves at 2, 4, 8, 16, 32 cells; channel c is the fbm starting at octave c with
        // weights 0.625 / 0.25 / 0.125 (Schneider 2015), so g/b/a share octaves like his detail noise
        gba[0] = gba[1] = gba[2] = 0;
        for (let o = 0; o < 5; o++) {
          const P = 2 << o;
          const wo = worley(px * P, py * P, pz * P, P, w[o] as Float32Array);
          for (let c = 0; c < 3; c++) {
            const k = o - c;
            gba[c] =
              (gba[c] as number) + (k === 0 ? 0.625 : k === 1 ? 0.25 : k === 2 ? 0.125 : 0) * wo;
          }
        }
        // dilate Perlin by the low Worley fbm: remap(perlin, 0, 1, worley, 1) -> billowy, round cells
        const pw = (gba[1] as number) + perlin * (1.0 - (gba[1] as number));
        const i = ((z * size + y) * size + x) * 4;
        out[i] = unorm8(stretch(pw, PW_LO, PW_HI));
        out[i + 1] = unorm8(stretch(gba[0] as number, W_LO, W_HI));
        out[i + 2] = unorm8(stretch(gba[1] as number, W_LO, W_HI));
        out[i + 3] = unorm8(stretch(gba[2] as number, W_LO, W_HI));
      }
    }
  }
  return out;
}

// vector potential = three gradient-noise fbms; octave amplitudes fall faster than 1/f so the
// big swirls dominate and the fine octaves only roughen them
function bakeCurlData(size: number): Uint8Array {
  const { CURL_SCALE } = NOISE_TUNING;
  const tables = Array.from({ length: 3 }, (_, o) => grad3Table(4 << o, 11));
  const out = new Uint8Array(size * size * size * 4);
  const J = new Float64Array(9); // column k = grad of potential k
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const px = (x + 0.5) / size;
        const py = (y + 0.5) / size;
        const pz = (z + 0.5) / size;
        J.fill(0);
        let amp = 1.0;
        for (let o = 0; o < 3; o++) {
          const P = 4 << o;
          gnoiseGrad3(px * P, py * P, pz * P, P, tables[o] as Float32Array, J, amp); // d/dp = d/dx * P; amplitude 1/P -> amp
          amp *= 0.6;
        }
        const cx = ((J[7] as number) - (J[5] as number)) * CURL_SCALE; // J[2].y - J[1].z
        const cy = ((J[2] as number) - (J[6] as number)) * CURL_SCALE; // J[0].z - J[2].x
        const cz = ((J[3] as number) - (J[1] as number)) * CURL_SCALE; // J[1].x - J[0].y
        const i = ((z * size + y) * size + x) * 4;
        out[i] = unorm8(cx * 0.5 + 0.5);
        out[i + 1] = unorm8(cy * 0.5 + 0.5);
        out[i + 2] = unorm8(cz * 0.5 + 0.5);
        out[i + 3] = 255;
      }
  return out;
}

function bake3D(data: Uint8Array, size: number): Data3DTexture {
  const tex = new Data3DTexture(data, size, size, size);
  tex.format = RGBAFormat;
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = RepeatWrapping;
  tex.generateMipmaps = false;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

// --- blackbody (CPU) -------------------------------------------------------------------
const LAMBDA0 = 360;
const LAMBDA_STEP = 5;
const LAMBDA_N = 95; // 360..830 nm
const cmf = new Float64Array(LAMBDA_N * 3);
{
  // Wyman, Sloan & Shirley 2013, multi-lobe piecewise-Gaussian fit to CIE 1931 2-degree
  const g = (x: number, mu: number, s1: number, s2: number) => {
    const t = (x - mu) / (x < mu ? s1 : s2);
    return Math.exp(-0.5 * t * t);
  };
  for (let i = 0; i < LAMBDA_N; i++) {
    const l = LAMBDA0 + i * LAMBDA_STEP;
    cmf[i * 3] =
      1.056 * g(l, 599.8, 37.9, 31.0) +
      0.362 * g(l, 442.0, 16.0, 26.7) -
      0.065 * g(l, 501.1, 20.4, 26.2);
    cmf[i * 3 + 1] = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
    cmf[i * 3 + 2] = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
  }
}

// Planck spectrum against the CMFs -> XYZ / Y -> linear sRGB (D65), negatives clipped,
// then rescaled so Rec.709 luminance is exactly 1 again
function planckRGB(kelvin: number, out: Float32Array, o: number): void {
  const c2 = 1.4387769e7; // hc / k in nm K
  let X = 0;
  let Y = 0;
  let Z = 0;
  for (let i = 0; i < LAMBDA_N; i++) {
    const l = LAMBDA0 + i * LAMBDA_STEP;
    const b = 1 / (l ** 5 * (Math.exp(c2 / (l * kelvin)) - 1));
    X += b * (cmf[i * 3] as number);
    Y += b * (cmf[i * 3 + 1] as number);
    Z += b * (cmf[i * 3 + 2] as number);
  }
  X /= Y;
  Z /= Y;
  Y = 1;
  const r = Math.max(0, 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z);
  const g = Math.max(0, -0.969266 * X + 1.8760108 * Y + 0.041556 * Z);
  const b = Math.max(0, 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out[o] = r / lum;
  out[o + 1] = g / lum;
  out[o + 2] = b / lum;
}

const BB_N = 256;
const bbLUT = new Float32Array(BB_N * 3); // CPU copy, texel centres at u = (i + 0.5) / 256
const kelvinAt = (u: number) => 500 * 40 ** u;
for (let i = 0; i < BB_N; i++) planckRGB(kelvinAt((i + 0.5) / BB_N), bbLUT, i * 3);

const lut = (i: number): number => bbLUT[i] as number;
// same mapping and linear filtering as blackbody() in NOISE_GLSL (minus fp16 rounding)
export function blackbodyRGB(kelvin: number, outColor = new Color()): Color {
  const u = Math.min(1, Math.max(0, Math.log(kelvin / 500) / Math.log(40)));
  const x = Math.min(BB_N - 1, Math.max(0, u * BB_N - 0.5));
  const i = Math.min(BB_N - 2, Math.floor(x));
  const t = x - i;
  const a = i * 3;
  const b = a + 3;
  return outColor.setRGB(
    lut(a) + (lut(b) - lut(a)) * t,
    lut(a + 1) + (lut(b + 1) - lut(a + 1)) * t,
    lut(a + 2) + (lut(b + 2) - lut(a + 2)) * t,
    LinearSRGBColorSpace,
  );
}

function makeBlackbodyTexture(): DataTexture {
  const data = new Uint16Array(BB_N * 4);
  for (let i = 0; i < BB_N; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = DataUtils.toHalfFloat(lut(i * 3 + c));
    data[i * 4 + 3] = DataUtils.toHalfFloat(1);
  }
  const tex = new DataTexture(data, BB_N, 1, RGBAFormat, HalfFloatType);
  tex.minFilter = tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// throws on failure; returns a one-line summary
export function blackbodySelfCheck(): string {
  const assert = (ok: boolean, msg: string) => {
    if (!ok) throw new Error(`blackbody self-check: ${msg}`);
  };
  const c = new Color();
  const w = blackbodyRGB(6500, c).toArray();
  assert(
    Math.max(...w) / Math.min(...w) < 1.15,
    `6500 K not near white (${w.map((x) => x.toFixed(3))})`,
  );
  const o = blackbodyRGB(1900, new Color()).toArray();
  assert(
    (o[0] as number) > (o[1] as number) && (o[1] as number) > (o[2] as number),
    `1900 K not orange (${o.map((x) => x.toFixed(3))})`,
  );
  let prev = -1;
  for (let i = 0; i < BB_N; i++) {
    const r = lut(i * 3);
    const g = lut(i * 3 + 1);
    const b = lut(i * 3 + 2);
    assert(
      Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 1e-6,
      `luminance != 1 at texel ${i}`,
    );
    const hue = (b + 1e-6) / (r + 1e-6); // blue/red rises monotonically with temperature
    assert(hue >= prev, `hue not monotone at texel ${i}`);
    prev = hue;
  }
  return `blackbody ok: 6500K (${w.map((x) => x.toFixed(3))}), 1900K (${o.map((x) => x.toFixed(3))})`;
}

// --- bake -------------------------------------------------------------------------------
export interface IBakedNoise {
  noise3D: Data3DTexture;
  curl3D: Data3DTexture;
  blackbody: DataTexture;
  ms: number;
}

// Call once, before any material that samples noise is built: TSL reads U.uNoise3D/uCurl3D/uBlackbody
// .value when the material's graph is made (upstream's GLSL bound them as uniforms at draw).
export function bakeNoise({ noiseSize = 128 }: { noiseSize?: number } = {}): IBakedNoise {
  const now = () => globalThis.performance?.now() ?? Date.now();
  const t0 = now();
  const noise = bake3D(bakeNoiseData(noiseSize), noiseSize);
  const tNoise = now() - t0;
  const curl = bake3D(bakeCurlData(64), 64);
  const blackbody = makeBlackbodyTexture();
  const ms = now() - t0;
  U.uNoise3D.value = noise;
  U.uCurl3D.value = curl;
  U.uBlackbody.value = blackbody;
  console.info(
    `noise bake (CPU): ${noiseSize}^3 noise + 64^3 curl + blackbody in ${ms.toFixed(1)} ms (noise ${tNoise.toFixed(1)}, curl ${(ms - tNoise).toFixed(1)})`,
  );
  return { noise3D: noise, curl3D: curl, blackbody, ms };
}

// exposed for the bake test (same maths as the GPU programs upstream)
export const __bake = { bakeNoiseData, bakeCurlData };
