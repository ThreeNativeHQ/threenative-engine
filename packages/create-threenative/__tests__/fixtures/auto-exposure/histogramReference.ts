import { exposureBins } from "../../../template-assets/exposureGraph.js";

/** One histogram bin as the GPU stores it: summed weight and summed weight * log2 luminance. */
export interface IHistogramBin {
  weight: number;
  logSum: number;
}

export interface IHistogramCase {
  name: string;
  bins: IHistogramBin[];
  lowPercent: number;
  highPercent: number;
}

const empty: IHistogramBin = { weight: 0, logSum: 0 };

function sparse(entries: Record<number, IHistogramBin>): IHistogramBin[] {
  return Array.from({ length: exposureBins }, (_, i) => entries[i] ?? empty);
}

/** A bin of `weight` samples that all sit at log2 luminance `log`. */
function at(weight: number, log: number): IHistogramBin {
  return { weight, logSum: weight * log };
}

/** Synthetic histograms: one bin, a uniform spread, an empty histogram, low == high, and both tails. */
export const histogramCases: IHistogramCase[] = [
  { name: "one-bin", bins: sparse({ 20: at(5, -3) }), lowPercent: 10, highPercent: 90 },
  {
    name: "uniform-spread",
    bins: Array.from({ length: exposureBins }, (_, i) => at(1, (i - 32) / 4)),
    lowPercent: 10,
    highPercent: 90,
  },
  { name: "empty", bins: sparse({}), lowPercent: 10, highPercent: 90 },
  {
    name: "low-equals-high",
    bins: sparse({ 10: at(3, -5), 40: at(3, 2) }),
    lowPercent: 50,
    highPercent: 50,
  },
  {
    name: "bright-tail-clipped",
    bins: sparse({ 15: at(90, -4), 60: at(10, 6) }),
    lowPercent: 10,
    highPercent: 90,
  },
  {
    name: "dark-tail-clipped",
    bins: sparse({ 2: at(10, -8), 30: at(90, -1) }),
    lowPercent: 10,
    highPercent: 90,
  },
  {
    name: "clip-splits-bins",
    bins: sparse({ 5: at(7, -6), 25: at(11, -2), 45: at(13, 1), 62: at(3, 5) }),
    lowPercent: 20,
    highPercent: 80,
  },
  {
    name: "no-clip",
    bins: sparse({ 8: at(2, -5), 50: at(6, 3) }),
    lowPercent: 0,
    highPercent: 100,
  },
];

/**
 * Overlap form of the clipped average, independent of the shader's running subtraction: each
 * bin contributes the part of its weight that lies between the low and high percentile marks.
 */
export function referenceClippedMean(
  bins: readonly IHistogramBin[],
  lowPercent: number,
  highPercent: number,
): { logMean: number; kept: number } {
  const total = bins.reduce((sum, bin) => sum + bin.weight, 0);
  const from = (total * lowPercent) / 100;
  const to = (total * highPercent) / 100;
  let seen = 0;
  let kept = 0;
  let logSum = 0;
  for (const { weight, logSum: binLog } of bins) {
    const take = Math.max(0, Math.min(seen + weight, to) - Math.max(seen, from));
    if (weight > 0) {
      kept += take;
      logSum += (binLog * take) / weight;
    }
    seen += weight;
  }
  return { logMean: kept > 0 ? logSum / kept : Number.NaN, kept };
}
