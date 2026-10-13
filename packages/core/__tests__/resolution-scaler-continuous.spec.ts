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
    const holds = new ResolutionScaler({ start: 1, targetFps: 60 });
    expect(holds.observe(windowOf(16.8))).toBeUndefined();
    expect(holds.observe(windowOf(16.8))).toBeUndefined();

    const climbs = new ResolutionScaler({ start: 0.72, targetFps: 60 });
    expect(climbs.observe(windowOf(10))).toBeUndefined();
    for (let index = 0; index < 3; index += 1)
      expect(climbs.observe(windowOf(10, 1))).toBeUndefined();
    const up = climbs.observe(windowOf(10, 1));
    expect(up).toBeGreaterThan(0.72);
    expect(up).toBeLessThan(1);
  });
});

it("refunds a continuous step when fresh GPU cost does not answer to pixels", () => {
  const scaler = new ResolutionScaler({ start: 1, minScale: 0.23, targetFps: 60 });
  for (let index = 0; index < 40; index++)
    scaler.observe({ ...windowOf(34, 8), surface: { ...surface, resolutionScale: scaler.scale } });
  expect(scaler.scale).toBe(1);
});

it("refunds to the actual continuous fraction rather than its nearest rung", () => {
  const scaler = new ResolutionScaler({ start: 1, minScale: 0.23, targetFps: 60 });
  scaler.observe(windowOf(34, 8));
  const first = scaler.observe(windowOf(34, 8));
  if (first === undefined) throw new Error("Missing initial step");
  scaler.observe(windowOf(24, 8));
  scaler.observe(windowOf(24, 8));
  const second = scaler.scale;
  expect(second).toBeLessThan(first);
  scaler.observe(windowOf(24, 8));
  expect(scaler.observe(windowOf(24, 8))).toBe(first);
});

it.each([false, true])(
  "preserves fixed-GPU-cost memory across recovery in continuous=%s",
  (continuous) => {
    const scaler = new ResolutionScaler({ start: 0.72, minScale: 0.23, targetFps: 60 });
    const feed = (gpuMs: number, count: number) => {
      for (let index = 0; index < count; index++)
        scaler.observe({
          frames: 8,
          fps: Math.min(60, 1000 / gpuMs),
          gpuAgeFrames: 0,
          gpuMs,
          presented: { max: gpuMs, p50: gpuMs, p95: gpuMs, p99: gpuMs },
          surface: { ...surface, resolutionScale: scaler.scale, resolutionSubrect: continuous },
        });
    };
    feed(34, 6);
    feed(10, 30);
    const recovered = scaler.scale;
    expect(recovered).toBeGreaterThan(0.9);
    feed(34, 30);
    // Returning to the same proven fixed cost earns no reduction; a sustained rise reopens it.
    expect(scaler.scale).toBe(recovered);
  },
);
