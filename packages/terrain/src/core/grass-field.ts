import type { IBiomeSpec, IGrassType } from "./biome.js";

/** The ground a biome's grass grows on: its height, and the sea it stays clear of. */
export interface IGrassGround {
  /** World height at (x, z), metres. */
  heightAt(x: number, z: number): number;
  /** The height a row's `height` band is measured from; 0 when absent. */
  readonly floor?: number;
  /** The water level a row keeps its `waterMargin` above; no water when absent or null. */
  readonly waterLevel?: number | null;
}

/** The placement options `GrassField3D` takes, read from a biome's grass rows. */
export interface IGrassFieldPlacement {
  readonly getHeight: (x: number, z: number) => number;
  readonly getDensity: (x: number, z: number, height: number, normalY: number) => number;
  readonly maxSlope: number;
  readonly slopeFade: number;
  readonly minAltitude: number;
  readonly maxAltitude: number;
  readonly seed: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** One row's coverage 0..1 at a height and a slope, in degrees. */
function rowCover(row: IGrassType, ground: IGrassGround, y: number, slope: number): number {
  const floor = ground.floor ?? 0;
  const water = ground.waterLevel ?? null;
  if (water !== null && y < water + row.waterMargin) return 0;
  if (slope < row.slope[0]) return 0;
  // Full cover up to slope[1], gone `slopeFalloff` degrees past it.
  const meadow =
    row.slopeFalloff > 0
      ? clamp01(1 - (slope - row.slope[1]) / row.slopeFalloff)
      : slope <= row.slope[1]
        ? 1
        : 0;
  let band = 1;
  if (row.height !== null) {
    const low = floor + row.height[0];
    const high = floor + row.height[1];
    if (y < low || y > high) return 0;
    // The cover fades out over `heightFalloff` metres below the ceiling.
    band = row.heightFalloff > 0 ? clamp01((high - y) / row.heightFalloff) : 1;
  }
  return row.density * meadow * band;
}

/**
 * Turns a terrain biome's grass rows and its ground into `GrassField3D` placement options, so a
 * generated or cooked world grows streamed grass with one call. Returns null when the biome has no
 * grass rows: the game draws no field.
 *
 * Each row covers its own slope band (full to `slope[1]`, gone `slopeFalloff` degrees past it),
 * its own height band above `ground.floor` (fading over `heightFalloff` below the ceiling) and
 * stays `waterMargin` above `ground.waterLevel`; the field takes the strongest row at each spot.
 *
 * @requires npm i -D @threenative/terrain
 * @situation grow streamed grass on a terrain world's biome grass rows
 * @situation a Strata or terrain_generate world with a meadow that sways round the player
 * @situation feed a cooked biome to GrassField3D
 * @constraint the look stays the game's: pass the result with the kit's `render/grass.ts` blade and material
 * @example
 * const placement = grassFieldFromBiome(biome, { heightAt: (x, z) => field.heightAt(x, z), waterLevel: 0 });
 * if (placement) ctx.add(new GrassField3D({ ...placement, blade: grassBlade(), material: grassMaterial }));
 */
export function grassFieldFromBiome(
  biome: Pick<IBiomeSpec, "grass" | "seed">,
  ground: IGrassGround,
): IGrassFieldPlacement | null {
  if (typeof ground?.heightAt !== "function")
    throw new Error("grassFieldFromBiome: ground.heightAt must be a function (x, z) => height.");
  const rows = biome.grass;
  if (rows.length === 0) return null;
  const floor = ground.floor ?? 0;
  const water = ground.waterLevel ?? null;
  const lows = rows.map((row) =>
    Math.max(
      row.height === null ? Number.NEGATIVE_INFINITY : floor + row.height[0],
      water === null ? Number.NEGATIVE_INFINITY : water + row.waterMargin,
    ),
  );
  const highs = rows.map((row) =>
    row.height === null ? Number.POSITIVE_INFINITY : floor + row.height[1],
  );
  return {
    getDensity: (_x, _z, y, normalY) => {
      const slope = (Math.acos(Math.min(1, Math.max(-1, normalY))) * 180) / Math.PI;
      let cover = 0;
      for (const row of rows) cover = Math.max(cover, rowCover(row, ground, y, slope));
      return cover;
    },
    getHeight: (x, z) => ground.heightAt(x, z),
    // The field's own limit is the steepest row's last degree, cut hard: each row fades itself.
    maxAltitude: Math.max(...highs),
    maxSlope: Math.max(...rows.map((row) => row.slope[1] + row.slopeFalloff)),
    minAltitude: Math.min(...lows),
    seed: biome.seed,
    slopeFade: 0,
  };
}
