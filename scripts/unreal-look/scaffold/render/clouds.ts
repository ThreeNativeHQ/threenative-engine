// Model references (UE 5.8.3): Engine/Content/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud
// (the default cloud material; its node graph and parameter defaults are read through the editor),
// Engine/Shaders/Private/VolumetricCloud.usf (dual HG phase, scattering octaves, sky term, shadow
// march), Engine/Source/Runtime/Engine/Private/Components/VolumetricCloudComponent.cpp (km defaults).
// Independent CPU implementation. The material samples four Unreal textures that this repository
// must not carry, so each one is regenerated here from a seeded noise whose per-channel value
// quantiles and correlation lengths match the Unreal texture (measured, see the spec).
import {
  BOTTOM_KM,
  CAMERA_KM,
  MIE_ABSORB,
  MIE_SCATTER,
  RAYLEIGH,
  type Rgb,
  transmittanceToTop,
} from "./atmosphere.js";

const PLANET = BOTTOM_KM;
export const CLOUD_BOTTOM_KM = 5; // VolumetricCloudComponent LayerBottomAltitude in the reference level
export const CLOUD_TOP_KM = 15; // bottom + LayerHeight 10
const CAMERA = PLANET + CAMERA_KM;

/** m_SimpleVolumetricCloud parameter defaults (the instance overrides only textures). */
export const CLOUD_MATERIAL = {
  layoutKm: 256, // Layout_CloudGlobalScale: the pattern repeats every 256 km
  density: 0.008, // Cloud_GlobalDensity, extinction per metre
  coverage: -0.2, // Cloud_GlobalCoverage
  noise1Scale: [4.167, 4.444, 9.091], // Noise1_Coordinates, in volume repeats per layout tile
  noise2Scale: [60, 60, 75], // Noise2_Coordinates, the distortion lookup
  noiseBias: [0.5, 0.8], // Noise_Bias R (shape) and G (distortion)
  noiseStrength: [0.8, 0.08], // Noise_Strength R and G
  insideLayer: [0.02, 0.98], // the material returns zero in the outer 2% of the layer
  albedo: 0.98, // Cloud_AlbedoColor
  skyOcclusion: 0.5, // Cloud_AlbedoColor alpha, drives the sky-light term
  phase: { g: 0.8, g2: 0.166667, blend: 0.575 }, // Phase_Controls
  multiScatter: { contribution: 0.666667, occlusion: 0.25, eccentricity: 0.18, octaves: 2 },
} as const;
export const CLOUD_MODEL = {
  viewStepMetres: 300,
  minViewSteps: 32,
  maxViewSteps: 192,
  lightSteps: 6,
  // TracingMaxDistance of the reference actor is 200 km (tools/unreal-reference/template-actors.json).
  horizonFadeStartKm: 150,
  horizonFadeEndKm: 200,
} as const;
export const PATTERN_SIZE = 256;
export const VOLUME_SIZE = 64;
// Value quantiles (17 points, 0 to 1) of T_CloudPattern R,G,B, of the volume's R and G channels.
const PATTERN_QUANTILES = [
  [0, 0, 0, 0, 0, 0.012, 0.034, 0.06, 0.092, 0.13, 0.176, 0.234, 0.307, 0.405, 0.541, 0.753, 1],
  [
    0, 0, 0, 0.001, 0.006, 0.021, 0.048, 0.086, 0.135, 0.193, 0.26, 0.342, 0.44, 0.562, 0.731,
    0.978, 1,
  ],
  [
    0, 0, 0, 0.004, 0.018, 0.036, 0.054, 0.072, 0.092, 0.113, 0.138, 0.168, 0.204, 0.248, 0.314,
    0.435, 1,
  ],
] as const;
const VOLUME_QUANTILES = [
  [
    -0.147, 0.309, 0.365, 0.405, 0.437, 0.464, 0.489, 0.513, 0.536, 0.558, 0.582, 0.606, 0.633,
    0.665, 0.703, 0.756, 1.071,
  ],
  [
    0, 0.173, 0.235, 0.282, 0.322, 0.357, 0.39, 0.42, 0.45, 0.481, 0.512, 0.545, 0.581, 0.619,
    0.666, 0.728, 1.022,
  ],
] as const;
// Cells per repeat of the pattern's base octave: sets each channel's correlation length.
const PATTERN_CELLS = [6, 15, 30] as const;
// T_Profile_08 channels as degree-4 polynomials in (altitude in layer, pattern value):
// exponents [i, j] and coefficients for u^i v^j. Fitted to the texture (rms error 0.006 to 0.012).
const PROFILE_TERMS: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 1],
  [0, 2],
  [0, 3],
  [0, 4],
  [1, 0],
  [1, 1],
  [1, 2],
  [1, 3],
  [2, 0],
  [2, 1],
  [2, 2],
  [3, 0],
  [3, 1],
  [4, 0],
];
const PROFILE_COEFFICIENTS = [
  [
    0.3741, 0.499, -1.2672, 1.2328, -0.4107, 0.8894, 0.3392, 0.4021, -0.2367, -2.8264, -1.2088,
    0.4296, 2.6391, 0.5109, -0.8971,
  ],
  [
    0.2818, 0.049, -0.3788, 0.7721, -0.1495, -0.1268, 1.0841, -1.9311, 0.0666, 2.8644, 0.0744,
    1.329, -5.4491, -0.7025, 2.7003,
  ],
  [
    0.049, 0.0514, -0.119, 0.1602, -0.077, 0.7471, 0.0678, -0.1132, 0.0743, -1.4245, -0.0577,
    -0.0141, 2.7099, 0.0675, -1.6358,
  ],
] as const;

const clamp = (v: number): number => Math.max(0, Math.min(1, v));
const smooth = (v: number): number => {
  const t = clamp(v);
  return t * t * (3 - 2 * t);
};
const mod = (a: number, n: number): number => ((a % n) + n) % n;

function rng(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    return (state >>> 0) / 4294967296;
  };
}

/** Periodic value noise on a size^dims grid with `cells` lattice cells per axis. */
function valueNoise(cells: number, size: number, dims: 2 | 3, next: () => number): Float32Array {
  const lattice = Float32Array.from({ length: cells ** dims }, next);
  const out = new Float32Array(size ** dims);
  const depth = dims === 3 ? size : 1;
  for (let z = 0; z < depth; z++) {
    const fz = ((z + 0.5) / size) * cells - 0.5;
    const iz = Math.floor(fz);
    const wz = smooth(fz - iz);
    for (let y = 0; y < size; y++) {
      const fy = ((y + 0.5) / size) * cells - 0.5;
      const iy = Math.floor(fy);
      const wy = smooth(fy - iy);
      for (let x = 0; x < size; x++) {
        const fx = ((x + 0.5) / size) * cells - 0.5;
        const ix = Math.floor(fx);
        const wx = smooth(fx - ix);
        let sum = 0;
        for (let c = 0; c < (dims === 3 ? 2 : 1); c++)
          for (let b = 0; b < 2; b++)
            for (let a = 0; a < 2; a++) {
              const at =
                mod(ix + a, cells) +
                cells * (mod(iy + b, cells) + (dims === 3 ? cells * mod(iz + c, cells) : 0));
              sum +=
                (lattice[at] ?? 0) *
                (a ? wx : 1 - wx) *
                (b ? wy : 1 - wy) *
                (dims === 3 ? (c ? wz : 1 - wz) : 1);
            }
        out[x + size * (y + size * z)] = sum;
      }
    }
  }
  return out;
}

/** Periodic inverted Worley F1: 1 minus the distance to the nearest of one point per cell. */
function worleyInverted(cells: number, size: number, next: () => number): Float32Array {
  const points = Float32Array.from({ length: cells ** 3 * 3 }, next);
  const out = new Float32Array(size ** 3);
  for (let z = 0; z < size; z++)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const px = ((x + 0.5) / size) * cells;
        const py = ((y + 0.5) / size) * cells;
        const pz = ((z + 0.5) / size) * cells;
        const cx = Math.floor(px);
        const cy = Math.floor(py);
        const cz = Math.floor(pz);
        let best = 9;
        for (let k = -1; k <= 1; k++)
          for (let j = -1; j <= 1; j++)
            for (let i = -1; i <= 1; i++) {
              const at =
                3 *
                (mod(cx + i, cells) + cells * (mod(cy + j, cells) + cells * mod(cz + k, cells)));
              const dx = cx + i + (points[at] ?? 0) - px;
              const dy = cy + j + (points[at + 1] ?? 0) - py;
              const dz = cz + k + (points[at + 2] ?? 0) - pz;
              best = Math.min(best, dx * dx + dy * dy + dz * dz);
            }
        out[x + size * (y + size * z)] = 1 - Math.sqrt(best);
      }
  return out;
}

const standardise = (v: Float32Array): Float32Array => {
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let variance = 0;
  for (const x of v) variance += (x - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / v.length || 1);
  return v.map((x) => (x - mean) * scale);
};

/** Replace each value by the quantile-table value at its rank, keeping the noise's spatial order. */
function matchQuantiles(values: Float32Array, table: readonly number[]): Float32Array {
  const sorted = Float32Array.from(values).sort();
  const last = table.length - 1;
  return values.map((value) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] ?? 0) < value) lo = mid + 1;
      else hi = mid;
    }
    const t = (lo / Math.max(1, sorted.length - 1)) * last;
    const i = Math.min(last - 1, Math.floor(t));
    return (table[i] ?? 0) + ((table[i + 1] ?? 0) - (table[i] ?? 0)) * (t - i);
  });
}

export interface ICloudTextures {
  /** RGBA float, PATTERN_SIZE squared, one cloud type per channel (alpha unused). */
  pattern: Float32Array;
  /** RG float, VOLUME_SIZE cubed: R is the distortion noise, G the shape noise. */
  volume: Float32Array;
}
const textureCache = new Map<number, ICloudTextures>();

export function cloudTextures(seed = 631): ICloudTextures {
  const cached = textureCache.get(seed);
  if (cached) return cached;
  const next = rng(seed);
  const n = PATTERN_SIZE;
  const pattern = new Float32Array(n * n * 4);
  for (let c = 0; c < 3; c++) {
    let field = new Float32Array(n * n);
    for (let o = 0; o < 3; o++) {
      const octave = valueNoise((PATTERN_CELLS[c] ?? 8) * 2 ** o, n, 2, next);
      field = field.map((v, i) => v + (octave[i] ?? 0) * 0.5 ** o);
    }
    const mapped = matchQuantiles(field, PATTERN_QUANTILES[c] ?? []);
    for (let i = 0; i < n * n; i++) pattern[i * 4 + c] = mapped[i] ?? 0;
  }
  const v = VOLUME_SIZE;
  const blend = (
    cells: number,
    noiseCells: number,
    weight: number,
    table: readonly number[],
  ): Float32Array => {
    const worley = standardise(worleyInverted(cells, v, next));
    const smoothNoise = standardise(valueNoise(noiseCells, v, 3, next));
    return matchQuantiles(
      worley.map((x, i) => weight * x + (1 - weight) * (smoothNoise[i] ?? 0)),
      table,
    );
  };
  const shape = blend(6, 3, 0.7, VOLUME_QUANTILES[1]);
  const distortion = blend(3, 8, 0.92, VOLUME_QUANTILES[0]);
  const volume = new Float32Array(v ** 3 * 2);
  for (let i = 0; i < v ** 3; i++) {
    volume[i * 2] = distortion[i] ?? 0;
    volume[i * 2 + 1] = shape[i] ?? 0;
  }
  const textures = { pattern, volume };
  textureCache.set(seed, textures);
  return textures;
}

/** T_Profile_08 stand-in: the three cloud types' vertical profile at altitude fraction u, pattern v. */
export function cloudProfile(type: 0 | 1 | 2, u: number, v: number): number {
  const coefficients = PROFILE_COEFFICIENTS[type];
  const u2 = u * u;
  const u3 = u2 * u;
  const v2 = v * v;
  const v3 = v2 * v;
  const u4 = u3 * u;
  const v4 = v3 * v;
  const us = [1, u, u2, u3, u4];
  const vs = [1, v, v2, v3, v4];
  let sum = 0;
  for (let i = 0; i < PROFILE_TERMS.length; i++) {
    const term = PROFILE_TERMS[i] ?? [0, 0];
    sum += (coefficients[i] ?? 0) * (us[term[0]] ?? 0) * (vs[term[1]] ?? 0);
  }
  return sum;
}
/** Profile baked to a 64 x 64 RGBA texture, u along x and the pattern value along y. */
export function cloudProfileTexture(size = 64): Float32Array {
  const out = new Float32Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      for (let c = 0; c < 3; c++)
        out[(y * size + x) * 4 + c] = cloudProfile(
          c as 0 | 1 | 2,
          (x + 0.5) / size,
          (y + 0.5) / size,
        );
  return out;
}

function samplePattern(pattern: Float32Array, u: number, v: number, c: number): number {
  const n = PATTERN_SIZE;
  const fx = u * n - 0.5;
  const fy = v * n - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const wx = fx - ix;
  const wy = fy - iy;
  const at = (x: number, y: number): number => pattern[(mod(y, n) * n + mod(x, n)) * 4 + c] ?? 0;
  return (
    (at(ix, iy) * (1 - wx) + at(ix + 1, iy) * wx) * (1 - wy) +
    (at(ix, iy + 1) * (1 - wx) + at(ix + 1, iy + 1) * wx) * wy
  );
}

function sampleVolume(volume: Float32Array, x: number, y: number, z: number, c: number): number {
  const n = VOLUME_SIZE;
  const fx = x * n - 0.5;
  const fy = y * n - 0.5;
  const fz = z * n - 0.5;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const iz = Math.floor(fz);
  const wx = fx - ix;
  const wy = fy - iy;
  const wz = fz - iz;
  const at = (a: number, b: number, d: number): number =>
    volume[(mod(a, n) + n * (mod(b, n) + n * mod(d, n))) * 2 + c] ?? 0;
  const plane = (d: number): number =>
    (at(ix, iy, d) * (1 - wx) + at(ix + 1, iy, d) * wx) * (1 - wy) +
    (at(ix, iy + 1, d) * (1 - wx) + at(ix + 1, iy + 1, d) * wx) * wy;
  return plane(iz) * (1 - wz) + plane(iz + 1) * wz;
}

/**
 * Extinction per metre at planet-centred (x, y, z) km, y up. The material's graph, with wind at
 * zero and the three cloud types at weight one: coverage pattern times (altitude profile
 * minus one half plus distorted shape noise), times Cloud_GlobalDensity, zero near layer edges.
 */
export function cloudDensityField(seed = 631): (x: number, y: number, z: number) => number {
  const { pattern, volume } = cloudTextures(seed);
  const m = CLOUD_MATERIAL;
  return (x, y, z) => {
    const altitude = Math.hypot(x, y, z) - PLANET;
    if (altitude <= CLOUD_BOTTOM_KM || altitude >= CLOUD_TOP_KM) return 0;
    const h = (altitude - CLOUD_BOTTOM_KM) / (CLOUD_TOP_KM - CLOUD_BOTTOM_KM);
    if (h < m.insideLayer[0] || h > m.insideLayer[1]) return 0;
    const u = x / m.layoutKm;
    const v = z / m.layoutKm;
    const p0 = samplePattern(pattern, u, v, 0);
    const p1 = samplePattern(pattern, u, v, 1);
    const p2 = samplePattern(pattern, u, v, 2);
    const coverage = Math.max(p0, p1, p2);
    if (coverage <= 0) return 0;
    const profile =
      Math.max(cloudProfile(0, h, p0), cloudProfile(1, h, p1), cloudProfile(2, h, p2)) - 0.5;
    const sky: [number, number, number] = [u + 0.5, v + 0.5, (y - PLANET) / m.layoutKm];
    const a = h * 0.95 + 0.05;
    const c = (2 * Math.abs(a - 0.5)) ** 2;
    const warp =
      (sampleVolume(
        volume,
        sky[0] * m.noise2Scale[0],
        sky[1] * m.noise2Scale[1],
        sky[2] * m.noise2Scale[2],
        0,
      ) -
        m.noiseBias[1]) *
      m.noiseStrength[1];
    const shape = sampleVolume(
      volume,
      sky[0] * m.noise1Scale[0] + a * warp,
      sky[1] * m.noise1Scale[1] + a * warp,
      sky[2] * m.noise1Scale[2] + c * warp,
      1,
    );
    const noise = (shape - m.noiseBias[0] + m.coverage) * m.noiseStrength[0];
    return clamp(coverage * (profile + noise) * m.density);
  };
}

/** Beer–Lambert transmission for a nonnegative optical depth. */
export const cloudTransmittance = (depth: number): number => Math.exp(-Math.max(0, depth));
const hg = (cosine: number, g: number): number =>
  (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * cosine) ** 1.5);
/** The material's dual lobe: HG(g) blended toward HG(g2). */
export const cloudPhase = (cosine: number): number => {
  const p = CLOUD_MATERIAL.phase;
  const forward = hg(cosine, p.g);
  return forward + p.blend * (hg(cosine, p.g2) - forward);
};
/** Per scattering octave: scattering and extinction scale, and the lerp toward isotropic phase. */
export function cloudOctaves(): Array<{ scatter: number; extinction: number; anisotropy: number }> {
  const ms = CLOUD_MATERIAL.multiScatter;
  let s = ms.contribution;
  let e = ms.occlusion;
  let f = ms.eccentricity;
  const out = [{ scatter: 1, extinction: 1, anisotropy: 1 }];
  for (let i = 1; i <= ms.octaves; i++) {
    const last = out[i - 1] ?? { scatter: 1, extinction: 1, anisotropy: 1 };
    out.push({ scatter: last.scatter * s, extinction: last.extinction * e, anisotropy: f });
    s *= s;
    e *= e;
    f *= f;
  }
  return out;
}
const sphereExit = (r: number, mu: number, radius: number): number =>
  -r * mu + Math.sqrt(r * r * mu * mu + radius * radius - r * r);

/** Composite in place, in bakeSkyRadiance's radiance per unit sun illuminance; no DOM or GPU. */
export function bakeCloudRadiance(
  radiance: Float32Array,
  sun: { x: number; y: number; z: number },
  width: number,
  height: number,
  seed = 631,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    radiance.length !== width * height * 3 ||
    !Number.isFinite(seed) ||
    !(Math.abs(Math.hypot(sun.x, sun.y, sun.z) - 1) <= 0.001)
  ) {
    throw new Error(
      "Cloud bake requires matching positive dimensions, a finite seed and a unit sun",
    );
  }
  const density = cloudDensityField(seed);
  const octaves = cloudOctaves();
  const ambient = [0, 0, 0];
  let weights = 0;
  for (let y = 0; y < height / 2; y += 1) {
    const theta = ((y + 0.5) / height) * Math.PI;
    const weight = Math.sin(theta) * Math.max(0, Math.cos(theta));
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1)
        ambient[c] = (ambient[c] ?? 0) + (radiance[(y * width + x) * 3 + c] ?? 0) * weight;
      weights += weight;
    }
  }
  for (let c = 0; c < 3; c += 1) ambient[c] = (ambient[c] ?? 0) / Math.max(weights, 1e-9);
  for (let y = 0; y < height / 2; y += 1) {
    const elevation = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    const dy = Math.sin(elevation);
    const horizontal = Math.cos(elevation);
    const entry = sphereExit(CAMERA, dy, PLANET + CLOUD_BOTTOM_KM);
    if (entry > 350) continue;
    const length = Math.min(50, sphereExit(CAMERA, dy, PLANET + CLOUD_TOP_KM) - entry);
    const steps = Math.min(
      CLOUD_MODEL.maxViewSteps,
      Math.max(CLOUD_MODEL.minViewSteps, Math.ceil((length * 1000) / CLOUD_MODEL.viewStepMetres)),
    );
    const dt = length / steps;
    const fade =
      1 -
      smooth(
        (entry - CLOUD_MODEL.horizonFadeStartKm) /
          (CLOUD_MODEL.horizonFadeEndKm - CLOUD_MODEL.horizonFadeStartKm),
      );
    // shortcut: integrate the clear-air column to layer entry, not per cloud sample; upgrade for airborne cameras.
    const airDepth = [0, 0, 0];
    for (let i = 0; i < 8; i += 1) {
      const t = (entry * (i + 0.5)) / 8;
      const h = Math.hypot(horizontal * t, CAMERA + dy * t) - PLANET;
      for (let c = 0; c < 3; c += 1)
        airDepth[c] =
          (airDepth[c] ?? 0) +
          (((RAYLEIGH[c as 0 | 1 | 2] ?? 0) * Math.exp(-h / 8) +
            (MIE_SCATTER + MIE_ABSORB) * Math.exp(-h / 1.2)) *
            entry) /
            8;
    }
    for (let x = 0; x < width; x += 1) {
      const azimuth = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = horizontal * Math.cos(azimuth);
      const dz = horizontal * Math.sin(azimuth);
      const phase = cloudPhase(dx * sun.x + dy * sun.y + dz * sun.z);
      let through = 1;
      const light = [0, 0, 0];
      for (let i = 0; i < steps && through > 0.005; i += 1) {
        const t = entry + (i + 0.5) * dt;
        const px = dx * t;
        const py = CAMERA + dy * t;
        const pz = dz * t;
        const extinction = density(px, py, pz) * 1000 * fade; // per km
        if (extinction === 0) continue;
        const r = Math.hypot(px, py, pz);
        const shadowLength = Math.min(
          15,
          sphereExit(r, (px * sun.x + py * sun.y + pz * sun.z) / r, PLANET + CLOUD_TOP_KM),
        );
        let shadowDepth = 0;
        for (let j = 0; j < CLOUD_MODEL.lightSteps; j += 1) {
          const s = shadowLength * ((j + 0.5) / CLOUD_MODEL.lightSteps) ** 2;
          const ds = (shadowLength * (2 * j + 1)) / CLOUD_MODEL.lightSteps ** 2;
          shadowDepth += density(px + sun.x * s, py + sun.y * s, pz + sun.z * s) * 1000 * ds;
        }
        const stepT = cloudTransmittance(extinction * dt);
        let direct = 0;
        for (const o of octaves)
          direct +=
            o.scatter *
            cloudTransmittance(shadowDepth * o.extinction) *
            (1 / (4 * Math.PI) + (phase - 1 / (4 * Math.PI)) * o.anisotropy);
        // The sun reaches this sample through the air above it, not through the whole atmosphere.
        const sunlight = transmittanceToTop(r, (px * sun.x + py * sun.y + pz * sun.z) / r);
        for (let c = 0; c < 3; c += 1) {
          const source =
            direct * (sunlight[c as 0 | 1 | 2] ?? 0) +
            (ambient[c] ?? 0) * CLOUD_MATERIAL.skyOcclusion;
          light[c] = (light[c] ?? 0) + through * (1 - stepT) * CLOUD_MATERIAL.albedo * source;
        }
        through *= stepT;
      }
      for (let c = 0; c < 3; c += 1) {
        const at = (y * width + x) * 3 + c;
        const sky = radiance[at] ?? 0;
        radiance[at] =
          sky + Math.exp(-(airDepth[c] ?? 0)) * ((light[c] ?? 0) - sky * (1 - through));
      }
    }
  }
}
export type { Rgb };
