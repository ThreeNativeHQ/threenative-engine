import { describe, expect, it } from "vitest";
import {
  evaluateTemporalOffCost,
  velocityCostSamples,
} from "../../examples/abyss-framework/src/render/velocityCost.js";

const summary = (p50 = 1, p95 = Math.max(1.2, p50)) => ({
  samples: velocityCostSamples,
  mean: p50,
  p50,
  p95,
  p99: p95 + 0.2,
  max: p95 + 1,
});

describe("predeclared temporal-off CPU cost comparison", () => {
  it("keeps the observed signed overhead and prices it against two clock ticks and split-control noise", () => {
    const result = evaluateTemporalOffCost(summary(1), summary(1.02), summary(1.03), 0.01);
    expect(result.p50.deltaMs).toBeCloseTo(0.02);
    expect(result.p50.noiseMs).toBeCloseTo(0.04);
    expect(result.p50.overheadExcessMs).toBeCloseTo(-0.02);
    expect(result.p50.noiseExcessMs).toBeLessThan(0);
    expect(result.samples).toBe(150);
  });
  it("keeps an exact two-tick boundary at zero instead of a floating-point false failure", () => {
    const result = evaluateTemporalOffCost(summary(0.6), summary(0.6), summary(0.8), 0.1);
    expect(result.p50.overheadExcessMs).toBe(0);
  });
  it("rejects an added render-phase cost in either median or tail", () => {
    expect(
      evaluateTemporalOffCost(summary(), summary(), summary(2), 0.1).p50.overheadExcessMs,
    ).toBeCloseTo(0.8);
    expect(
      evaluateTemporalOffCost(summary(), summary(), summary(1, 3), 0.1).p95.overheadExcessMs,
    ).toBeCloseTo(1.6);
  });
  it("does not turn wildly different controls into permission for slow rendering", () => {
    const result = evaluateTemporalOffCost(summary(1, 1.2), summary(2, 3), summary(), 0.1);
    expect(result.p50.noiseExcessMs).toBeGreaterThan(0);
    expect(result.p95.noiseExcessMs).toBeGreaterThan(0);
  });
  it("refuses partial samples, missing phase timings and coarse or invalid clocks", () => {
    expect(() =>
      evaluateTemporalOffCost({ ...summary(), samples: 149 }, summary(), summary(), 0.1),
    ).toThrow(/150/);
    expect(() =>
      evaluateTemporalOffCost({ ...summary(), p95: Number.NaN }, summary(), summary(), 0.1),
    ).toThrow(/finite/);
    expect(() => evaluateTemporalOffCost(summary(0), summary(), summary(), 0.1)).toThrow(
      /positive/,
    );
    for (const clock of [0, Number.NaN, -1, 0.2])
      expect(() => evaluateTemporalOffCost(summary(), summary(), summary(), clock)).toThrow(
        /clock/,
      );
  });
});
