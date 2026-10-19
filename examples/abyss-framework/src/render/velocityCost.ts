import type { IFrameBudgetSummary } from "@threenative/core";

export const velocityCostSamples = 150;

/** Compare the actual FrameBudget render phases; this is CPU submission time, never GPU time. */
export function evaluateTemporalOffCost(
  baselineA: IFrameBudgetSummary,
  baselineB: IFrameBudgetSummary,
  temporalOff: IFrameBudgetSummary,
  clockQuantumMs: number,
) {
  for (const summary of [baselineA, baselineB, temporalOff]) {
    if (summary.samples !== velocityCostSamples)
      throw new Error("Temporal-off cost requires all 150 render-phase samples in each arm.");
    for (const field of ["mean", "p50", "p95", "p99", "max"] as const)
      if (!Number.isFinite(summary[field]) || summary[field] <= 0)
        throw new Error("Temporal-off cost requires finite, positive render-phase observations.");
    if (summary.p50 > summary.p95 || summary.p95 > summary.p99 || summary.p99 > summary.max)
      throw new Error("Temporal-off cost render percentiles must be ordered.");
  }
  if (!Number.isFinite(clockQuantumMs) || clockQuantumMs <= 0 || clockQuantumMs > 0.100001)
    throw new Error("Temporal-off cost requires a measured clock quantum of at most 0.1 ms.");
  const comparison = (field: "p50" | "p95") => {
    const baselineMs = (baselineA[field] + baselineB[field]) / 2;
    const noiseMs = Math.max(2 * clockQuantumMs, 2 * Math.abs(baselineA[field] - baselineB[field]));
    // Excessively noisy controls fail rather than granting an unbounded overhead allowance.
    const noiseLimitMs = Math.max(0.2, baselineMs * 0.25);
    return {
      baselineMs,
      temporalOffMs: temporalOff[field],
      deltaMs: temporalOff[field] - baselineMs,
      noiseMs,
      noiseExcessMs: Math.round((noiseMs - noiseLimitMs) * 1e6) / 1e6,
      overheadExcessMs: Math.round((temporalOff[field] - baselineMs - noiseMs) * 1e6) / 1e6,
    };
  };
  return {
    samples: velocityCostSamples,
    clockQuantumMs,
    p50: comparison("p50"),
    p95: comparison("p95"),
  };
}
