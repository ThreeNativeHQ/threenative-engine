import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  PATTERN_SIZE,
  bakeCloudRadiance,
  cloudDensityField,
  cloudOctaves,
  cloudPhase,
  cloudTextures,
  cloudTransmittance,
} from "../unreal-look/scaffold/render/clouds.js";

const sun = { x: 0.5, y: Math.sqrt(0.75), z: 0 };
const width = 64;
const height = 32;
const sky = (): Float32Array => new Float32Array(width * height * 3).fill(0.025);

describe("Unreal reference CPU clouds", () => {
  it("has no extinction outside the spherical 5–15 km layer or in its outer 2%, and a populated interior", () => {
    const density = cloudDensityField();
    for (const altitude of [-1, 0, 4.99, 5, 5.1, 14.9, 15, 15.01, 20])
      expect(density(0, 6360 + altitude, 0)).toBe(0);
    let peak = 0;
    let filled = 0;
    let samples = 0;
    for (let x = -120; x <= 120; x += 0.5)
      for (let z = -120; z <= 120; z += 2) {
        const value = density(x, 6366, z);
        expect(value).toBeGreaterThanOrEqual(0);
        peak = Math.max(peak, value);
        samples += 1;
        if (value > 0) filled += 1;
      }
    // m_SimpleVolumetricCloud: coverage (<= 1) x (profile - 0.5 + noise <= ~0.45) x 0.008 per metre.
    expect(peak).toBeGreaterThan(0.0005);
    expect(peak).toBeLessThan(0.0045);
    // Unreal's own pattern, profile and volume textures fill 6.5% of a 240 km slice at 6 km altitude
    // (5% to 11% from 5.5 to 14 km): broken cumulus, not an overcast and not empty.
    expect(filled / samples).toBeGreaterThan(0.03);
    expect(filled / samples).toBeLessThan(0.15);
  });

  it("regenerates the Unreal textures' value distributions and correlation lengths", () => {
    const { pattern, volume } = cloudTextures();
    const quantile = (values: number[], q: number): number =>
      [...values].sort((a, b) => a - b)[Math.floor(q * (values.length - 1))] ?? 0;
    const channel = (data: Float32Array, stride: number, c: number): number[] =>
      Array.from({ length: data.length / stride }, (_, i) => data[i * stride + c] ?? 0);
    // Measured on the Unreal textures: median pattern R 0.092, G 0.135, B 0.092; volume R 0.536, G 0.45.
    expect(quantile(channel(pattern, 4, 0), 0.5)).toBeCloseTo(0.092, 1);
    expect(quantile(channel(pattern, 4, 1), 0.5)).toBeCloseTo(0.135, 1);
    expect(quantile(channel(pattern, 4, 2), 0.5)).toBeCloseTo(0.092, 1);
    expect(quantile(channel(volume, 2, 0), 0.5)).toBeCloseTo(0.536, 1);
    expect(quantile(channel(volume, 2, 1), 0.5)).toBeCloseTo(0.45, 1);
    // Autocorrelation along x at 1/16 of the repeat: Unreal's R 0.77, G 0.52, B 0.10 (1024 px at lag 64, 32, 16 -> here 16, 8, 4 of 256).
    const autocorrelation = (c: number, lag: number): number => {
      const n = PATTERN_SIZE;
      const values = channel(pattern, 4, c);
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      let covariance = 0;
      let variance = 0;
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const v = (values[y * n + x] ?? 0) - mean;
          variance += v * v;
          covariance += v * ((values[y * n + ((x + lag) % n)] ?? 0) - mean);
        }
      return covariance / variance;
    };
    expect(autocorrelation(0, 16)).toBeGreaterThan(0.35);
    expect(autocorrelation(0, 16)).toBeLessThan(0.6);
    expect(autocorrelation(1, 8)).toBeGreaterThan(0.4);
    expect(autocorrelation(1, 8)).toBeLessThan(0.65);
    expect(autocorrelation(2, 4)).toBeGreaterThan(0.3);
    expect(autocorrelation(2, 4)).toBeLessThan(0.6);
  });

  it("uses the cloud material's dual-lobe phase and Unreal's multiple-scattering octaves", () => {
    expect(cloudPhase(1)).toBeGreaterThan(cloudPhase(-1) * 5);
    const hg = (c: number, g: number): number =>
      (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * c) ** 1.5);
    expect(cloudPhase(0.3)).toBeCloseTo(
      hg(0.3, 0.8) + 0.575 * (hg(0.3, 0.166667) - hg(0.3, 0.8)),
      10,
    );
    const octaves = cloudOctaves();
    expect(octaves).toHaveLength(3);
    expect(octaves[1]?.scatter).toBeCloseTo(0.666667, 5);
    expect(octaves[1]?.extinction).toBeCloseTo(0.25, 5);
    expect(octaves[1]?.anisotropy).toBeCloseTo(0.18, 5);
    expect(octaves[2]?.scatter).toBeCloseTo(0.666667 * 0.666667 ** 2, 5);
    expect(octaves[2]?.extinction).toBeCloseTo(0.25 * 0.25 ** 2, 8);
    expect(octaves[2]?.anisotropy).toBeCloseTo(0.18 ** 2, 8);
  });

  it("keeps Beer–Lambert transmission bounded and monotonic", () => {
    let previous = 1;
    for (const depth of [-1, 0, 0.1, 1, 10, 1000]) {
      const transmission = cloudTransmittance(depth);
      expect(transmission).toBeGreaterThanOrEqual(0);
      expect(transmission).toBeLessThanOrEqual(previous);
      previous = transmission;
    }
    expect(cloudTransmittance(1)).toBeCloseTo(Math.exp(-1), 12);
  });

  it("is deterministic, seed-sensitive, finite and leaves the lower hemisphere alone", () => {
    const a = sky();
    const b = sky();
    const other = sky();
    bakeCloudRadiance(a, sun, width, height, 631);
    bakeCloudRadiance(b, sun, width, height, 631);
    bakeCloudRadiance(other, sun, width, height, 632);
    expect(a).toEqual(b);
    expect(a).not.toEqual(other);
    expect(a).not.toEqual(sky());
    expect(a.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(a.slice((width * height * 3) / 2)).toEqual(sky().slice((width * height * 3) / 2));
  });

  it("rejects inconsistent buffers or a non-unit sun", () => {
    expect(() => bakeCloudRadiance(new Float32Array(3), sun, width, height)).toThrow();
    expect(() => bakeCloudRadiance(sky(), { x: 0, y: 0, z: 0 }, width, height)).toThrow();
  });

  it("rejects nonfinite sun components", () => {
    expect(() => bakeCloudRadiance(sky(), { x: Number.NaN, y: 1, z: 0 }, width, height)).toThrow();
  });

  it("bakes a small sky within 300 ms on one core", () => {
    // Best of three: the host runs other lanes, and one slow slice is not the cost of the bake.
    let elapsed = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 3; run++) {
      const start = performance.now();
      bakeCloudRadiance(sky(), sun, width, height);
      elapsed = Math.min(elapsed, performance.now() - start);
    }
    console.log(`CPU clouds ${width}x${height}: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(300);
  });
});
