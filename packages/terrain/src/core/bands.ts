import type { ILayerInfo } from "./biome.js";

/**
 * A biome's band rows resolved once against the world they are about.
 *
 * The values in `biome.data.json` are fractions of the measured height range: the same numbers make
 * a 40 m valley and a 900 m massif, and a world with a different crop of the same landform reads the
 * same bands. Resolving them here keeps one owner of the numbers (the biome file) and one owner of
 * the measurement (this function), so a game reads bands instead of repeating the arithmetic.
 */
export interface IMeasuredBands {
  /** Lowest and highest sample, metres. Equal when the field is flat; the bands then collapse onto it. */
  readonly elevationRange: readonly [number, number];
  /** Each ground layer's band in metres, keyed by its row, in the order the file lists it. */
  readonly bands: Readonly<Record<string, readonly [number, number]>>;
  /** The `snow` row's band, when the biome has one. */
  readonly snowBand: readonly [number, number] | null;
  /**
   * The `snow` row's slope interval, in degrees: snow starts to shed at the first and is gone by the
   * second. `null` when the row has no shed rule.
   */
  readonly snowShed: readonly [number, number] | null;
}

/**
 * Resolve a biome's fraction bands against this world's own height samples.
 * @requires npm i -D @threenative/terrain
 * @situation turn a biome file's height fractions into the metres a world actually measured
 * @constraint samples are finite and at least one; a flat field resolves every band onto its one height
 * @example const bands = measureBands(spec.layers, state.height);
 */
export function measureBands(
  layers: readonly ILayerInfo[],
  heights: ArrayLike<number>,
): IMeasuredBands {
  if (heights.length === 0) throw new RangeError("Terrain elevation samples are empty");
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < heights.length; index += 1) {
    const height = heights[index] as number;
    if (!Number.isFinite(height)) throw new RangeError("Terrain elevation sample is nonfinite");
    min = Math.min(min, height);
    max = Math.max(max, height);
  }
  const span = max - min;
  if (!Number.isFinite(span)) throw new RangeError("Terrain elevation range is nonfinite");
  const resolve = (fraction: number): number => {
    const height = min + fraction * span;
    if (!Number.isFinite(height)) throw new RangeError("Terrain elevation band is nonfinite");
    return height;
  };
  let snowBand: readonly [number, number] | null = null;
  let snowShed: readonly [number, number] | null = null;
  const bands: Record<string, readonly [number, number]> = {};
  for (const layer of layers) {
    const band = [resolve(layer.from), resolve(layer.to)] as const;
    if (layer.layer === "snow") {
      snowBand = band;
      if (layer.shedFrom !== undefined && layer.shedTo !== undefined)
        snowShed = [layer.shedFrom, layer.shedTo] as const;
    } else {
      bands[layer.layer] = band;
    }
  }
  return { bands, elevationRange: [min, max], snowBand, snowShed };
}
