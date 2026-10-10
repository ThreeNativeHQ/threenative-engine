import { PerspectiveCamera } from "three";
import { describe, expect, it, vi } from "vitest";
import type { IFrameBudgetWindow } from "../src/frame-budget.js";
import { ParticleSignificance } from "../src/particle-significance.js";

type BudgetWindow = Pick<
  IFrameBudgetWindow,
  "frames" | "presented" | "gpuMs" | "gpuCompute" | "targetFps"
>;
function window(overrides: Partial<BudgetWindow> = {}): BudgetWindow {
  return {
    frames: 60,
    presented: { samples: 60, mean: 1000 / 60, p50: 0, p95: 0, p99: 0, max: 0 },
    gpuMs: 10,
    gpuCompute: 10,
    targetFps: 100,
    ...overrides,
  };
}
function candidate(score: number | undefined) {
  return { significance: vi.fn(() => score), yield: vi.fn() };
}
const camera = new PerspectiveCamera();

describe("ParticleSignificance", () => {
  it("includes the separate compute bucket when render alone is below target", () => {
    const budget = new ParticleSignificance();
    budget.observe(window({ gpuMs: 6, gpuCompute: 15, targetFps: 60 }));
    expect(budget.shed).toBeCloseTo((21 - 1000 / 60) / 15);
  });

  it("sheds the smallest significance first and excludes view-culled candidates", () => {
    const budget = new ParticleSignificance();
    const large = candidate(1);
    const small = candidate(0.1);
    const hidden = candidate(undefined);
    budget.observe(window({ gpuMs: 5 }));
    budget.apply([large, hidden, small], camera, 0);
    expect(small.yield).toHaveBeenLastCalledWith(true);
    expect(large.yield).not.toHaveBeenCalled();
    expect(hidden.yield).not.toHaveBeenCalled();
    expect(small.significance).toHaveBeenCalledWith(camera);
  });

  it("rises instantly and decays at 0.1 per second using presented mean", () => {
    const budget = new ParticleSignificance();
    budget.observe(window({ gpuMs: 5 }));
    expect(budget.shed).toBe(0.5);
    budget.observe(window({ gpuMs: 0 }));
    expect(budget.shed).toBeCloseTo(0.4);
    budget.observe(window({ gpuMs: 8 }));
    expect(budget.shed).toBe(0.8);
    budget.observe(window({ gpuMs: 0, frames: 600 }));
    expect(budget.shed).toBe(0);
    budget.observe(window({ gpuMs: 100 }));
    expect(budget.shed).toBe(1);
  });

  it("holds state for the grace period in both directions", () => {
    const budget = new ParticleSignificance({ decayPerSecond: 1 });
    const entry = candidate(1);
    budget.observe(window());
    budget.apply([entry], camera, 0);
    expect(entry.yield).toHaveBeenCalledExactlyOnceWith(true);
    budget.observe(window({ gpuMs: 0 }));
    budget.apply([entry], camera, 0.99);
    expect(entry.yield).toHaveBeenCalledTimes(1);
    budget.apply([entry], camera, 1);
    expect(entry.yield).toHaveBeenLastCalledWith(false);
    budget.observe(window());
    budget.apply([entry], camera, 1.99);
    expect(entry.yield).toHaveBeenCalledTimes(2);
    budget.apply([entry], camera, 2);
    expect(entry.yield).toHaveBeenLastCalledWith(true);
  });

  it.each([
    { gpuCompute: undefined },
    { gpuMs: undefined },
    { targetFps: undefined },
    { gpuCompute: 0 },
    { targetFps: 0 },
    { gpuCompute: Number.NaN },
    { gpuMs: Number.POSITIVE_INFINITY },
  ])("never starts shedding on unmeasured values: %j", (missing) => {
    const budget = new ParticleSignificance();
    const entry = candidate(1);
    budget.observe(window(missing));
    expect(budget.shed).toBe(0);
    budget.apply([entry], camera, 0);
    expect(entry.yield).not.toHaveBeenCalled();
  });

  it("decays previous shedding through unmeasured windows without an instant reset", () => {
    const budget = new ParticleSignificance();
    budget.observe(window());
    budget.observe(window({ gpuCompute: undefined }));
    expect(budget.shed).toBeCloseTo(0.9);
  });

  it("leaves flags untouched when a candidate becomes view-culled", () => {
    const budget = new ParticleSignificance();
    const entry = candidate(1);
    budget.observe(window());
    budget.apply([entry], camera, 0);
    entry.significance.mockReturnValue(undefined);
    budget.observe(window({ gpuMs: 0, frames: 600 }));
    budget.apply([entry], camera, 10);
    expect(entry.yield).toHaveBeenCalledExactlyOnceWith(true);
    entry.significance.mockReturnValue(1);
    budget.apply([entry], camera, 11);
    expect(entry.yield).toHaveBeenLastCalledWith(false);
  });
});
