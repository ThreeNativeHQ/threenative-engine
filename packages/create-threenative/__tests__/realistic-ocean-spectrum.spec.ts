import { describe, expect, it } from "vitest";
import { initialSpectrumData } from "../../core/src/ocean/spectral.js";
import {
  type ISeaState,
  angularFrequency,
  capillaryCrossover,
  cosineSpread,
  donelanBanner,
  expectedVariance,
  rawSeaEnergy,
  seaBands,
  seaEnergy,
  significantHeight,
  slopeVarianceTable,
} from "../template-assets/realistic-ocean/src/render/realisticSpectrum.js";

const STATE: ISeaState = {
  wind: { speed: 10, direction: 0, fetch: 50_000, peakEnhancement: 3.3 },
  gravity: 9.81,
  surfaceTension: 7.4e-5,
  shortWaveCut: 0.05,
};
const PATCHES = [256, 48, 9];

describe("realistic ocean spectrum", () => {
  it("scales the realised sea to the requested significant wave height", () => {
    for (const height of [0.4, 1.15, 3]) {
      const energy = seaEnergy({ ...STATE, waveHeight: height }, 64, PATCHES);
      const variance = expectedVariance(energy, 64, seaBands(64, PATCHES));
      expect(significantHeight(variance)).toBeCloseTo(height, 9);
    }
  });

  it("holds the height when the grid resolution changes", () => {
    const heights = [32, 64, 128].map((resolution) => {
      const energy = seaEnergy({ ...STATE, waveHeight: 1.5 }, resolution, PATCHES);
      return significantHeight(expectedVariance(energy, resolution, seaBands(resolution, PATCHES)));
    });
    for (const height of heights) expect(height).toBeCloseTo(1.5, 9);
  });

  it("predicts the energy of a real seeded realisation, which is what makes the scale a measurement", () => {
    const resolution = 32;
    const state = { ...STATE, waveHeight: 1.2 };
    const energy = seaEnergy(state, resolution, PATCHES);
    const expected = expectedVariance(energy, resolution, seaBands(resolution, PATCHES));
    const bands = seaBands(resolution, PATCHES);
    let total = 0;
    const seeds = 40;
    for (let seed = 1; seed <= seeds; seed += 1) {
      let variance = 0;
      for (let index = 0; index < bands.length; index += 1) {
        const band = bands[index] as { patchSize: number; kMin: number; kMax: number };
        const data = initialSpectrumData(resolution, band.patchSize, band, {
          amplitude: 1,
          directionality: 1,
          energy,
          gravity: 9.81,
          seed: seed + index * 7919,
          smallWaveCutoff: 0.05,
          windDirection: 0,
          windSpeed: 10,
        });
        // Parseval: the mean square height of a field synthesised as an unnormalised sum is the
        // sum of |h(k)|^2, and h(k, 0) is h0 + conj(h0(-k)).
        for (let texel = 0; texel < resolution * resolution; texel += 1) {
          const re = (data[texel * 4] as number) + (data[texel * 4 + 2] as number);
          const im = (data[texel * 4 + 1] as number) + (data[texel * 4 + 3] as number);
          variance += re * re + im * im;
        }
      }
      total += variance;
    }
    expect(total / seeds / expected).toBeGreaterThan(0.85);
    expect(total / seeds / expected).toBeLessThan(1.15);
  });

  it("grows taller and longer with fetch", () => {
    const short = rawSeaEnergy({ ...STATE, wind: { ...STATE.wind, fetch: 5_000 } });
    const long = rawSeaEnergy({ ...STATE, wind: { ...STATE.wind, fetch: 200_000 } });
    const bands = seaBands(64, PATCHES);
    const shortVariance = expectedVariance(short, 64, bands);
    const longVariance = expectedVariance(long, 64, bands);
    expect(longVariance).toBeGreaterThan(shortVariance);
    // A longer fetch puts the peak at a lower wavenumber: compare the energy at a long wave.
    expect(long(0.05, 0) / short(0.05, 0)).toBeGreaterThan(long(0.6, 0) / short(0.6, 0));
  });

  it("puts the wind sea along the wind and the swell along its own direction", () => {
    const withSwell = rawSeaEnergy({
      ...STATE,
      swell: { height: 1, direction: Math.PI / 2, peakFrequency: 0.5, spreading: 20 },
    });
    const k = 0.35;
    // Wind blows toward +x, swell toward +z. The swell's own peak is near w = 0.5, k = w^2 / g.
    const swellK = 0.5 ** 2 / 9.81;
    expect(withSwell(k, 0)).toBeGreaterThan(withSwell(-k, 0) * 10);
    expect(withSwell(0, swellK)).toBeGreaterThan(withSwell(0, -swellK) * 10);
    expect(withSwell(0, swellK)).toBeGreaterThan(rawSeaEnergy(STATE)(0, swellK) * 10);
  });

  it("is zero at zero wavenumber and finite everywhere it is asked", () => {
    const energy = rawSeaEnergy({
      ...STATE,
      swell: { height: 1, direction: 1, peakFrequency: 0.6, spreading: 12 },
    });
    expect(energy(0, 0)).toBe(0);
    for (const k of [1e-4, 0.01, 1, 30, 300, 3000]) {
      for (const angle of [0, 1, 2, 3, 4, 5]) {
        const value = energy(k * Math.cos(angle), k * Math.sin(angle));
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("damps waves below the short-wave cut", () => {
    const sharp = rawSeaEnergy({ ...STATE, shortWaveCut: 0.5 });
    const loose = rawSeaEnergy({ ...STATE, shortWaveCut: 0.01 });
    expect(sharp(20, 0)).toBeLessThan(loose(20, 0) * 1e-6);
  });

  it("normalises both directional spreads and switches dispersion at the capillary crossover", () => {
    let sum = 0;
    const steps = 20_000;
    for (let i = 0; i < steps; i += 1) {
      const theta = -Math.PI + ((i + 0.5) / steps) * 2 * Math.PI;
      sum += donelanBanner(theta, 1.2, 1) * ((2 * Math.PI) / steps);
    }
    expect(sum).toBeCloseTo(1, 3);
    let swell = 0;
    for (let i = 0; i < steps; i += 1) {
      const theta = -Math.PI + ((i + 0.5) / steps) * 2 * Math.PI;
      swell += cosineSpread(theta, 16) * ((2 * Math.PI) / steps);
    }
    // The documented normaliser covers the full circle for large exponents to a few per cent.
    expect(swell).toBeGreaterThan(0.9);
    expect(swell).toBeLessThan(1.1);
    const crossover = capillaryCrossover(9.81, 7.4e-5);
    expect(crossover).toBeCloseTo(364, 0);
    // At the crossover surface tension doubles omega squared.
    expect(angularFrequency(crossover, 9.81, 7.4e-5) ** 2).toBeCloseTo(2 * 9.81 * crossover, 6);
  });

  it("builds a monotonic slope-moment table: further pixels hide more slope", () => {
    const energy = seaEnergy({ ...STATE, waveHeight: 1.2 }, 128, PATCHES);
    const table = slopeVarianceTable(energy, { count: 16, nearest: 0.02, farthest: 400 });
    expect(table).toHaveLength(16);
    for (let i = 0; i < table.length; i += 1) {
      expect(Number.isFinite(table[i])).toBe(true);
      expect(table[i] as number).toBeGreaterThanOrEqual(0);
      if (i > 0) expect(table[i] as number).toBeGreaterThanOrEqual((table[i - 1] as number) - 1e-9);
    }
    // At 400 m a pixel hides the whole sea: mean-square slope of a sea this tall is a few per cent.
    expect(table[15] as number).toBeGreaterThan(0.005);
    expect(table[15] as number).toBeLessThan(0.5);
    expect(table[0] as number).toBeLessThan(table[15] as number);
  });

  it.each([
    ["wind speed", { wind: { ...STATE.wind, speed: 0 } }],
    ["fetch", { wind: { ...STATE.wind, fetch: -1 } }],
    ["wind direction", { wind: { ...STATE.wind, direction: Number.NaN } }],
    ["gravity", { gravity: 0 }],
    ["short wave cut", { shortWaveCut: -1 }],
    ["wave height", { waveHeight: 0 }],
    ["swell height", { swell: { height: 0, direction: 0, peakFrequency: 0.5, spreading: 4 } }],
  ])("refuses an invalid %s", (_name, override) => {
    expect(() => rawSeaEnergy({ ...STATE, ...override } as ISeaState)).toThrow("Realistic ocean");
  });

  it("refuses a spectrum with no energy on the grid instead of dividing by zero", () => {
    // Every wave is damped away by a cut far longer than the grid can hold.
    expect(() => seaEnergy({ ...STATE, shortWaveCut: 1e6, waveHeight: 1 }, 32, PATCHES)).toThrow(
      "no energy",
    );
  });
});
