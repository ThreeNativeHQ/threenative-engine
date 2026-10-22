// Generated for you, and ThreeNative does not read it. The sea's *spectrum* — which wavelengths
// carry energy and from where — is this game's decision, so it lives here and is handed to
// `SpectralOcean` as its `energy` curve. Nothing in this file touches the GPU, which is what lets a
// test integrate it and say how tall the sea it describes will be.
//
// Adapted from web-ocean (MIT, Copyright (c) 2026 Maksymilian Dendura; see
// REALISTIC-OCEAN-LICENSE.txt): a fetch-limited JONSWAP wind sea with Donelan-Banner directional
// spreading, an independently directed long-crested swell, and capillary dispersion.

const TWO_PI = Math.PI * 2;

/** A wind sea that has had `fetch` metres of open water to grow in. */
export interface IWindSea {
  /** Wind speed at ten metres, in m/s. */
  readonly speed: number;
  /** Direction the waves travel, in radians. */
  readonly direction: number;
  /** Open-water distance the wind has blown over, in metres. A longer fetch is a taller, longer sea. */
  readonly fetch: number;
  /** JONSWAP peak enhancement. 3.3 is the North Sea mean; higher is a narrower, sharper peak. */
  readonly peakEnhancement: number;
}

/** A swell: long, narrow in direction, and independent of the local wind. */
export interface ISwell {
  /** Significant wave height of the swell alone, in metres. */
  readonly height: number;
  readonly direction: number;
  /** Peak angular frequency in rad/s. 0.5 is a 12.6 s period. */
  readonly peakFrequency: number;
  /** The `cos^2s` spreading exponent. Larger is a straighter-crested swell. */
  readonly spreading: number;
}

export interface ISeaState {
  readonly wind: IWindSea;
  /** Omit for a pure wind sea. */
  readonly swell?: ISwell;
  readonly gravity: number;
  /** Surface tension over density, in m^3/s^2. Water at 20 C is 7.4e-5. */
  readonly surfaceTension: number;
  /** Waves shorter than this are damped out, in metres. */
  readonly shortWaveCut: number;
  /**
   * The significant wave height the whole sea is scaled to, in metres (four standard deviations of
   * the surface). Omitted, the physical spectrum is used as it falls.
   */
  readonly waveHeight?: number;
}

export type SeaEnergy = (kx: number, kz: number) => number;

function wrapAngle(angle: number): number {
  return angle - TWO_PI * Math.floor((angle + Math.PI) / TWO_PI);
}

/** The wavenumber above which surface tension, not gravity, restores the surface. */
export function capillaryCrossover(gravity: number, surfaceTension: number): number {
  return Math.sqrt(gravity / surfaceTension);
}

export function angularFrequency(k: number, gravity: number, surfaceTension: number): number {
  return Math.sqrt(gravity * k + surfaceTension * k * k * k);
}

function groupDerivative(k: number, gravity: number, surfaceTension: number): number {
  return (
    (gravity + 3 * surfaceTension * k * k) / (2 * angularFrequency(k, gravity, surfaceTension))
  );
}

/** The JONSWAP frequency spectrum `S(w)`. */
export function jonswap(
  w: number,
  peak: number,
  alpha: number,
  gamma: number,
  gravity: number,
): number {
  const sigma = w <= peak ? 0.07 : 0.09;
  const d = (w - peak) / (sigma * peak);
  const enhancement = gamma ** Math.exp(-0.5 * d * d);
  const q = peak / w;
  return ((alpha * gravity * gravity) / w ** 5) * Math.exp(-1.25 * q ** 4) * enhancement;
}

/** Donelan-Banner directional spreading, normalised over [-pi, pi]. */
export function donelanBanner(theta: number, w: number, peak: number): number {
  const ratio = w / peak;
  let beta: number;
  if (ratio < 0.95) beta = 2.61 * ratio ** 1.3;
  else if (ratio < 1.6) beta = 2.28 * ratio ** -1.3;
  else beta = 10 ** (-0.4 + 0.8393 * Math.exp(-0.567 * Math.log(ratio * ratio)));
  const sech = 1 / Math.cosh(Math.max(-20, Math.min(20, beta * theta)));
  return (beta / (2 * Math.tanh(beta * Math.PI))) * sech * sech;
}

/** `cos^2s(theta / 2)` spreading, normalised. */
export function cosineSpread(theta: number, s: number): number {
  const normaliser = Math.sqrt(s + 0.25) / (2 * Math.sqrt(Math.PI));
  return normaliser * Math.abs(Math.cos(theta * 0.5)) ** (2 * s);
}

function validate(state: ISeaState): void {
  const positive = (name: string, value: number) => {
    if (!Number.isFinite(value) || value <= 0)
      throw new Error(`Realistic ocean ${name} must be a positive number.`);
  };
  positive("wind.speed", state.wind.speed);
  positive("wind.fetch", state.wind.fetch);
  positive("wind.peakEnhancement", state.wind.peakEnhancement);
  if (!Number.isFinite(state.wind.direction))
    throw new Error("Realistic ocean wind.direction must be a finite number.");
  positive("gravity", state.gravity);
  positive("surfaceTension", state.surfaceTension);
  positive("shortWaveCut", state.shortWaveCut);
  if (state.waveHeight !== undefined) positive("waveHeight", state.waveHeight);
  if (state.swell !== undefined) {
    positive("swell.height", state.swell.height);
    positive("swell.peakFrequency", state.swell.peakFrequency);
    positive("swell.spreading", state.swell.spreading);
    if (!Number.isFinite(state.swell.direction))
      throw new Error("Realistic ocean swell.direction must be a finite number.");
  }
}

/**
 * The sea's energy per wavenumber cell at `(kx, kz)`, before any height normalisation.
 *
 * The frequency spectrum is changed to a wavenumber one by `dw/dk / k`, so the result has the
 * units `SpectralOcean.energy` expects and the same `Δk` weighting the Phillips default carries.
 */
export function rawSeaEnergy(state: ISeaState): SeaEnergy {
  validate(state);
  const { wind, swell, gravity, surfaceTension, shortWaveCut } = state;
  const alpha = 0.076 * (wind.speed ** 2 / (wind.fetch * gravity)) ** 0.22;
  const windPeak = 22 * (gravity ** 2 / (wind.speed * wind.fetch)) ** (1 / 3);
  const swellAlpha =
    swell === undefined
      ? 0
      : (swell.height / 4) ** 2 *
        5 *
        (swell.peakFrequency ** 4 / gravity ** 2) *
        (1 - 0.287 * Math.log(6));
  return (kx, kz) => {
    const k = Math.hypot(kx, kz);
    if (k < 1e-9) return 0;
    const w = angularFrequency(k, gravity, surfaceTension);
    const theta = Math.atan2(kz, kx);
    let density = 0;
    if (wind.speed > 0.1) {
      density +=
        jonswap(w, windPeak, alpha, wind.peakEnhancement, gravity) *
        donelanBanner(wrapAngle(theta - wind.direction), w, windPeak);
    }
    if (swell !== undefined) {
      density +=
        jonswap(w, swell.peakFrequency, swellAlpha, 6, gravity) *
        cosineSpread(wrapAngle(theta - swell.direction), swell.spreading);
    }
    density *= Math.exp(-k * k * shortWaveCut * shortWaveCut);
    return (density * groupDerivative(k, gravity, surfaceTension)) / k;
  };
}

/** One cascade as the simulation lays it out: its grid, its patch and the band it owns. */
export interface ISeaBand {
  readonly patchSize: number;
  readonly kMin: number;
  readonly kMax: number;
}

/** The bands `SpectralOcean` assigns, so this file can count energy the way the simulation does. */
export function seaBands(resolution: number, patchSizes: readonly number[]): readonly ISeaBand[] {
  return patchSizes.map((patchSize, index) => ({
    patchSize,
    kMin: index === 0 ? 0 : (Math.PI * resolution) / (patchSizes[index - 1] as number),
    kMax:
      index === patchSizes.length - 1
        ? Number.POSITIVE_INFINITY
        : (Math.PI * resolution) / patchSize,
  }));
}

/**
 * The variance of the surface height the simulation will realise, in m^2.
 *
 * Each texel carries `E·Δk^2` and its mirror carries the same, so the expected variance is twice
 * the sum. The self-mirrored row and column hold nothing, exactly as `initialSpectrumData` leaves
 * them. Checked in the tests against the energy of a real seeded realisation.
 */
export function expectedVariance(
  energy: SeaEnergy,
  resolution: number,
  bands: readonly ISeaBand[],
): number {
  let sum = 0;
  const half = resolution / 2;
  for (const band of bands) {
    const step = TWO_PI / band.patchSize;
    for (let y = 1; y < resolution; y += 1) {
      for (let x = 1; x < resolution; x += 1) {
        const kx = (x - half) * step;
        const kz = (y - half) * step;
        const k = Math.hypot(kx, kz);
        if (k < band.kMin || k >= band.kMax) continue;
        sum += energy(kx, kz) * step * step;
      }
    }
  }
  return 2 * sum;
}

/** Significant wave height of a Gaussian sea of this variance. */
export function significantHeight(variance: number): number {
  return 4 * Math.sqrt(variance);
}

/**
 * The energy curve to hand to `SpectralOcean`, scaled so the realised sea is `waveHeight` tall.
 *
 * The scale is measured on the grid the simulation will actually use, so changing `resolution` or
 * the cascades moves the *detail* and never the height. Without `waveHeight` the physical spectrum
 * is returned unscaled.
 */
export function seaEnergy(
  state: ISeaState,
  resolution: number,
  patchSizes: readonly number[],
): SeaEnergy {
  const raw = rawSeaEnergy(state);
  if (state.waveHeight === undefined) return raw;
  const variance = expectedVariance(raw, resolution, seaBands(resolution, patchSizes));
  if (!(variance > 0)) throw new Error("Realistic ocean spectrum holds no energy on this grid.");
  const scale = (state.waveHeight / 4) ** 2 / variance;
  return (kx, kz) => raw(kx, kz) * scale;
}

/**
 * Mean-square slope carried by waves shorter than each of `count` wavelengths, log-spaced between
 * `nearest` and `farthest` metres of pixel footprint.
 *
 * This is the slope-moment filter's table. A pixel that spans many metres cannot resolve the short
 * waves inside it, but their slope still decides how wide its sun glitter is: the variance they
 * carry is taken out of the resolved surface and spent as roughness instead, so the highlight
 * neither disappears nor shimmers. Entry `i` is for waves with `k > pi / footprint_i`.
 */
export function slopeVarianceTable(
  energy: SeaEnergy,
  options: {
    readonly count: number;
    readonly nearest: number;
    readonly farthest: number;
    readonly directions?: number;
  },
): Float32Array {
  const { count, nearest, farthest } = options;
  const directions = options.directions ?? 48;
  const kLow = Math.PI / farthest;
  const kHigh = (Math.PI / nearest) * 64;
  const rings = 160;
  const growth = Math.log(kHigh / kLow) / rings;
  // Per-ring slope variance: sum over angle of k^2 E(k) times the ring's area `k dk dtheta`.
  const ring = new Float64Array(rings);
  for (let i = 0; i < rings; i += 1) {
    const k = kLow * Math.exp((i + 0.5) * growth);
    const dk = k * growth;
    let sum = 0;
    for (let d = 0; d < directions; d += 1) {
      const angle = ((d + 0.5) / directions) * TWO_PI;
      sum += energy(k * Math.cos(angle), k * Math.sin(angle));
    }
    ring[i] = 2 * k * k * sum * (TWO_PI / directions) * k * dk;
  }
  const table = new Float32Array(count);
  const tail = new Float64Array(rings + 1);
  for (let i = rings - 1; i >= 0; i -= 1) tail[i] = (tail[i + 1] as number) + (ring[i] as number);
  for (let i = 0; i < count; i += 1) {
    const footprint = nearest * (farthest / nearest) ** (i / (count - 1));
    const k = Math.PI / footprint;
    const position = Math.max(0, Math.min(rings, Math.log(k / kLow) / growth));
    const base = Math.floor(position);
    const fraction = position - base;
    table[i] =
      (tail[base] as number) * (1 - fraction) +
      (tail[Math.min(rings, base + 1)] as number) * fraction;
  }
  return table;
}
