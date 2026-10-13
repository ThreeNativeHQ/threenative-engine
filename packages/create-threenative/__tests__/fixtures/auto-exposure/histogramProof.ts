import { exposureSettings } from "../../../template-assets/exposure.js";
import { histogramCases, referenceClippedMean } from "./histogramReference.js";

/** GPU luminance is -1 when no weight survives the clip, which keeps the previous exposure. */
export function assertHistogramProbe(consoleLines: readonly { text: string }[]): number {
  const marker = consoleLines
    .filter(({ text }) => text.startsWith("TN_EXPOSURE_HISTOGRAM:"))
    .at(-1);
  if (marker === undefined) throw new Error("TN_HISTOGRAM_MISSING: probe marker not observed.");
  const results = JSON.parse(marker.text.slice("TN_EXPOSURE_HISTOGRAM:".length)) as {
    name: string;
    luminance: number;
    goal: number;
  }[];
  if (results.length !== histogramCases.length)
    throw new Error(
      `TN_HISTOGRAM_MISMATCH: expected ${histogramCases.length} cases, got ${results.length}.`,
    );
  for (const [i, expected] of histogramCases.entries()) {
    const got = results[i];
    const { logMean, kept } = referenceClippedMean(
      expected.bins,
      expected.lowPercent,
      expected.highPercent,
    );
    if (got?.name !== expected.name)
      throw new Error(`TN_HISTOGRAM_MISMATCH: case ${i} is ${got?.name}.`);
    if (kept <= 0) {
      if (got.luminance !== -1)
        throw new Error(
          `TN_HISTOGRAM_MISMATCH: ${expected.name} kept no weight; GPU reported ${got.luminance}.`,
        );
      continue;
    }
    const luminance = 2 ** logMean;
    const goal = Math.min(
      exposureSettings.maxStops,
      Math.max(exposureSettings.minStops, Math.log2(exposureSettings.key) - logMean),
    );
    if (!(Math.abs(got.luminance / luminance - 1) < 1e-3) || !(Math.abs(got.goal - goal) < 1e-3))
      throw new Error(
        `TN_HISTOGRAM_MISMATCH: ${expected.name} luminance ${got.luminance} goal ${got.goal}; reference ${luminance} goal ${goal}.`,
      );
  }
  return results.length;
}
