// Generated for you. Spherical accumulation of bounded linear source samples.
import type { IEnvironmentMeasurement } from "./environmentContribution.js";
const WIDTH = 64;
const HEIGHT = 32;
function unmeasured(reason: string): IEnvironmentMeasurement {
  return { status: "unknown", meanRadiance: null, meanRGB: null, reason };
}
export function sampledRadiance(samples: unknown, intensity: number): IEnvironmentMeasurement {
  if (!(samples instanceof Float32Array) || samples.length !== WIDTH * HEIGHT * 4)
    return unmeasured("GPU readback did not provide the qualified float RGBA sample layout.");
  const sums = [0, 0, 0];
  const weights = Array.from(
    { length: HEIGHT },
    (_, y) => Math.cos((Math.PI * y) / HEIGHT) - Math.cos((Math.PI * (y + 1)) / HEIGHT),
  );
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) * WIDTH;
  for (const [offset, value] of samples.entries()) {
    const channel = offset % 4;
    if (channel === 3) continue;
    if (!Number.isFinite(value) || value < 0)
      return unmeasured("GPU radiance samples must be finite and nonnegative.");
    const weight = weights[Math.floor(offset / (WIDTH * 4))] ?? 0;
    sums[channel] = (sums[channel] ?? 0) + value * weight;
  }
  const meanRGB = sums.map((sum) => (sum / totalWeight) * intensity) as [number, number, number];
  const meanRadiance = meanRGB[0] * 0.2126 + meanRGB[1] * 0.7152 + meanRGB[2] * 0.0722;
  if (!meanRGB.every(Number.isFinite) || !Number.isFinite(meanRadiance))
    return unmeasured("GPU radiance accumulation overflowed.");
  return {
    status: "measured",
    meanRGB,
    meanRadiance,
    reason:
      "Estimated linear scene-environment source radiance from 64x32 GPU samples, spherical row weighting and active intensity; not material-specific BRDF contribution.",
  };
}
