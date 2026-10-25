import { describe, expect, it } from "vitest";
import {
  type IScalerWindow,
  RESOLUTION_SCALER,
  ResolutionScaler,
} from "../src/resolution-scaler.js";

const slow = (gpuMs?: number, gpuAgeFrames?: number): IScalerWindow => ({
  fps: 9.55,
  presented: { max: 250, p50: 100, p95: 133.3, p99: 166.7 },
  ...(gpuMs === undefined ? {} : { gpuMs }),
  ...(gpuAgeFrames === undefined ? {} : { gpuAgeFrames }),
});
function ready(start = 1): ResolutionScaler {
  const scaler = new ResolutionScaler({ start, targetFps: 60 });
  scaler.observe(slow(7.74, 7)); // startup window
  return scaler;
}

describe("resolution responds to measured GPU cost", () => {
  it("keeps Midway sharp through repeated low-FPS windows with GPU headroom", () => {
    const scaler = ready();
    for (let i = 0; i < 20; i += 1) scaler.observe(slow(7.74, 7));
    expect(scaler.scale).toBe(1);
    expect(scaler.scaleSource).toBe("auto");
    expect(scaler.atFloor).toBe(false);
  });

  it("recovers from reduced resolution without requiring host FPS to reach the target", () => {
    const scaler = ready(0.52);
    for (let i = 0; i < RESOLUTION_SCALER.upWindows - 1; i += 1) {
      expect(scaler.observe(slow(7, 3))).toBeUndefined();
    }
    expect(scaler.observe(slow(7, 3))).toBe(0.61);
  });

  it("accepts GPU headroom at the last allowed sampled timestamp age", () => {
    expect(ready().observe(slow(7, 16))).toBeUndefined();
  });

  it("does not climb when the next rung would exhaust GPU headroom", () => {
    const scaler = ready(0.52);
    for (let i = 0; i < 20; i += 1) scaler.observe(slow(15, 3));
    expect(scaler.scale).toBe(0.52);
  });

  it("sizes GPU-overload drops from GPU cost instead of the much slower host FPS", () => {
    const scaler = ready();
    expect(scaler.observe(slow(20, 3))).toBe(0.85);
    const heavy = ready();
    expect(heavy.observe(slow(40, 3))).toBe(0.61);
  });

  it.each([
    [undefined, undefined],
    [7, undefined],
    [7, 17],
    [7, -1],
    [7, 1.5],
    [0, 0],
    [-1, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ])("probes a single rung for unknown GPU timing (%s, %s)", (ms, age) => {
    // The presentation fallback is retained as a probe, not a priced jump: without fresh GPU
    // timing nothing can say how much of the deficit scales with pixels. The probe is refunded
    // unless fewer pixels earn a better frame rate (see resolution-scaler-unknown-gpu.spec.ts).
    expect(ready().observe(slow(ms, age))).toBe(0.85);
  });

  it("recovers from the floor and clears its overload report when GPU headroom returns", () => {
    const scaler = ready(0.23);
    scaler.observe(slow(30, 3));
    expect(scaler.atFloor).toBe(true);
    for (let i = 0; i < RESOLUTION_SCALER.upWindows; i += 1) scaler.observe(slow(7, 3));
    expect(scaler.scale).toBe(0.27);
    expect(scaler.atFloor).toBe(false);
  });

  it("responds to GPU overload while oscillation inhibits upward probes", () => {
    const scaler = ready();
    const edge = { fps: 58, presented: { max: 17.5, p50: 17.24, p95: 17.5, p99: 17.5 } };
    const clean = { fps: 60, presented: { max: 17.5, p50: 16.67, p95: 17.5, p99: 17.5 } };
    for (let cycle = 0; cycle < 2; cycle += 1) {
      scaler.observe(edge);
      scaler.observe(clean); // resize cooldown
      for (let i = 0; i < RESOLUTION_SCALER.upWindows; i += 1) scaler.observe(clean);
      scaler.observe(clean); // resize cooldown
    }
    scaler.observe(edge);
    expect(scaler.scaleSource).toBe("auto-pinned");
    scaler.observe(slow(30, 3)); // resize cooldown still applies
    expect(scaler.observe(slow(30, 3))).toBeLessThan(0.85);
  });
});

// Lantern Vale on Iris Xe at 1920x1080 (laptop TN_FRAME_BUDGET): the Wasm engine declined about a
// third of the renders while two frames were on the GPU, so rAF kept the panel's 16.7 ms cadence and
// `fps` read 59.88 while 39 frames a second were drawn at 25 ms of GPU each. The scale stayed at 1.
describe("resolution counts the frames the renderer declined to draw", () => {
  const gated = (renderSkips?: number): IScalerWindow => ({
    fps: 59.88,
    frames: 300,
    gpu: { p50: 25.2, samples: 90 },
    gpuAgeFrames: 400,
    gpuMs: 25.2,
    presented: { max: 17.4, p50: 16.7, p95: 16.9, p99: 17.1 },
    ...(renderSkips === undefined ? {} : { renderSkips }),
  });

  it("steps down when a third of the window's renders were declined on a GPU over budget", () => {
    const stepped = ready().observe(gated(105));
    expect(stepped).toBeDefined();
    expect(stepped).toBeLessThan(1);
  });

  it("still holds a window that drew every frame at the panel's cadence", () => {
    expect(ready().observe(gated())).toBeUndefined();
  });
});
