import { describe, expect, it } from "vitest";
import { ResolutionScaler } from "../src/resolution-scaler.js";

const surface = {
  drawingBufferHeight: 1080,
  drawingBufferWidth: 1920,
  resolutionScale: 1,
  resolutionSubrect: true,
};

const windowOf = (gpuMs: number, frames = 1) => ({
  fps: gpuMs <= 17 ? 60 : 45,
  frames,
  gpuAgeFrames: 0,
  gpuMs,
  presented: { max: 20, p50: gpuMs <= 17 ? 16 : 20, p95: 20, p99: 20 },
  surface,
});

describe("ResolutionScaler continuous sub-rectangle mode", () => {
  it("uses the quadratic estimate, eight-pixel quantization, and the eight-frame gap", () => {
    const scaler = new ResolutionScaler({ minScale: 0.23, start: 1, targetFps: 60 });
    expect(scaler.observe(windowOf(34))).toBeUndefined();
    const first = scaler.observe(windowOf(34, 7));
    expect(first).toBeCloseTo(1360 / 1920, 6);
    expect(first && ((first * 1920) / 8) % 1).toBe(0);
    expect(scaler.observe(windowOf(34))).toBeUndefined();
  });

  it("quantizes against retained capacity after the scale has already changed", () => {
    const scaler = new ResolutionScaler({ minScale: 0.23, start: 0.72, targetFps: 60 });
    const activeSurface = { ...surface, resolutionScale: 0.72 };
    expect(scaler.observe({ ...windowOf(34), surface: activeSurface })).toBeUndefined();
    const next = scaler.observe({ ...windowOf(34, 7), surface: activeSurface });
    expect(next).toBeCloseTo(552 / 1080, 6);
  });

  it("ignores estimates under two percent and amortizes an up-step", () => {
    const holds = new ResolutionScaler({ continuous: true, start: 1, targetFps: 60 });
    expect(holds.observe(windowOf(16.8))).toBeUndefined();
    expect(holds.observe(windowOf(16.8))).toBeUndefined();

    const climbs = new ResolutionScaler({ continuous: true, start: 0.72, targetFps: 60 });
    expect(climbs.observe(windowOf(10))).toBeUndefined();
    for (let index = 0; index < 3; index += 1)
      expect(climbs.observe(windowOf(10, 1))).toBeUndefined();
    const up = climbs.observe(windowOf(10, 1));
    expect(up).toBeGreaterThan(0.72);
    expect(up).toBeLessThan(1);
  });
});
