import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  bakeCloudRadiance,
  cloudDensityField,
  cloudTransmittance,
} from "../unreal-look/scaffold/render/clouds.js";

const sun = { x: 0.5, y: Math.sqrt(0.75), z: 0 };
const width = 64;
const height = 32;
const sky = (): Float32Array => new Float32Array(width * height * 3).fill(0.025);

describe("Unreal reference CPU clouds", () => {
  it("has no density outside the spherical 5–15 km layer, with populated interior", () => {
    const density = cloudDensityField();
    for (const altitude of [-1, 0, 4.99, 5, 15, 15.01, 20])
      expect(density(0, 6360 + altitude, 0)).toBe(0);
    let peak = 0;
    for (let x = -20; x <= 20; x += 1) {
      const value = density(x, 6366, 0);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
      peak = Math.max(peak, value);
    }
    expect(peak).toBeGreaterThan(0.1);
  });

  it("keeps the horizontal density correlation length between 1.2 and 5 km", () => {
    const density = cloudDensityField();
    const samples = Array.from({ length: 1600 }, (_, i) => density(i * 0.1 - 80, 6366, 7));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    const variance = samples.reduce((a, b) => a + (b - mean) ** 2, 0) / samples.length;
    let length = 0;
    for (let lag = 1; lag < 100; lag++) {
      const correlation =
        samples.slice(lag).reduce((sum, v, i) => sum + (v - mean) * ((samples[i] ?? 0) - mean), 0) /
        ((samples.length - lag) * variance);
      if (correlation < 0.5) {
        length = lag * 100;
        break;
      }
    }
    expect(length).toBeGreaterThanOrEqual(1200);
    expect(length).toBeLessThanOrEqual(5000);
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
    const start = performance.now();
    bakeCloudRadiance(sky(), sun, width, height);
    const elapsed = performance.now() - start;
    console.log(`CPU clouds ${width}x${height}: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(300);
  });
});
