import { createFlow, fillDepressions, routeFlow } from "./fluvial.js";

export interface ITerrainStats {
  /** Highest minus lowest height, metres. */
  readonly relief: number;
  /** (mean - min) / (max - min): about 0.5 for an evenly dissected massif, low for peaks over wide flats. */
  readonly hypsometricIntegral: number;
  /** Slope percentiles in degrees from central differences. */
  readonly slopeP50: number;
  readonly slopeP90: number;
  /** Channel length per area, km/km^2: cells draining at least 0.1 km^2, after depression filling. */
  readonly drainageDensity: number;
  /** Excess kurtosis of the Laplacian: smooth blobs are near 0, sharp ridges and gullies are heavy-tailed. */
  readonly curvatureKurtosis: number;
}

/** Channel head area. A fixed ground area, so the same terrain at any resolution gives one density. */
const CHANNEL_AREA_M2 = 1e5;

const quantile = (sorted: Float32Array, q: number): number =>
  sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;

/**
 * Landform statistics used to calibrate generators against real DEMs.
 * @requires npm i @threenative/terrain
 * @situation compare generated terrain with a USGS or SRTM crop on the same footprint
 * @constraint square grids only; compare crops of equal spacing, because slope and curvature depend on it
 * @example const stats = terrainStats(state.height, state.resolution, state.size);
 */
export function terrainStats(height: ArrayLike<number>, n: number, size: number): ITerrainStats {
  const spacing = size / (n - 1);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (let i = 0; i < height.length; i += 1) {
    const v = height[i] as number;
    low = Math.min(low, v);
    high = Math.max(high, v);
    sum += v;
  }
  const relief = high - low;
  const interior = (n - 2) * (n - 2);
  const slopes = new Float32Array(interior);
  const laplacian = new Float32Array(interior);
  let lapSum = 0;
  let k = 0;
  for (let z = 1; z < n - 1; z += 1) {
    for (let x = 1; x < n - 1; x += 1) {
      const i = z * n + x;
      const here = height[i] as number;
      const east = height[i + 1] as number;
      const west = height[i - 1] as number;
      const south = height[i + n] as number;
      const north = height[i - n] as number;
      slopes[k] =
        (Math.atan(Math.hypot(east - west, south - north) / (2 * spacing)) * 180) / Math.PI;
      laplacian[k] = (east + west + south + north - 4 * here) / (spacing * spacing);
      lapSum += laplacian[k] as number;
      k += 1;
    }
  }
  const lapMean = lapSum / interior;
  let m2 = 0;
  let m4 = 0;
  for (let i = 0; i < interior; i += 1) {
    const d = (laplacian[i] as number) - lapMean;
    m2 += d * d;
    m4 += d * d * d * d;
  }
  m2 /= interior;
  m4 /= interior;
  slopes.sort();
  const filled = Float64Array.from(height);
  fillDepressions(filled, n);
  const flow = createFlow(n);
  routeFlow(filled, n, flow);
  const channelCells = CHANNEL_AREA_M2 / (spacing * spacing);
  let channels = 0;
  for (let i = 0; i < flow.cells.length; i += 1)
    if ((flow.cells[i] as number) >= channelCells) channels += 1;
  const areaKm2 = (size * size) / 1e6;
  return {
    relief,
    hypsometricIntegral: relief > 0 ? (sum / height.length - low) / relief : 0,
    slopeP50: quantile(slopes, 0.5),
    slopeP90: quantile(slopes, 0.9),
    drainageDensity: (channels * spacing) / 1000 / areaKm2,
    curvatureKurtosis: m2 > 0 ? m4 / (m2 * m2) - 3 : 0,
  };
}
