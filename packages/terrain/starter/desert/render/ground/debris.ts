import { createRandom } from "@threenative/core";
// The desert floor's loose stone and dead wood: talus aprons under every butte face, and pebbles,
// stones and fallen juniper wood scattered thinly across the flats.
//
// A sandstone face sheds blocks that roll to its foot, so the debris is densest on the gentle ground
// just below a cliff and thins with distance from it. The bake's ordered stream places the boulders a
// biome row asks for; this is the game's own runtime layer over the playable square, from the baked
// heights and the game's own seed, the way `scatter.ts` plants the meadow past the square.
import type { IPlacement } from "@threenative/terrain";

/** The seed the debris draws from, a step past the bake's ordered stream and the meadow's. */
const DEBRIS_SEED = 466_468 + 57;

/** The talus apron, in metres and degrees: what counts as a face, and how far below it stone lies. */
export const TALUS = {
  /** Ground at least this steep is a shedding face. */
  faceSlope: 38,
  /** Ground steeper than this holds no loose stone: it slides on down. */
  restSlope: 34,
  /** How far below a face the apron reaches. */
  reach: 22,
  /** How much higher the face must stand than the apron cell, so a rim is not its own talus. */
  drop: 3,
} as const;

/** Mean placements per 2 m cell at full apron weight, and on the open flats. */
const APRON = { pebble: 2.2, scree: 0.9, volcanic: 0.28, reveal: 0.05, deadfall: 0.03 } as const;
const FLAT = { pebble: 0.16, scree: 0.02, volcanic: 0.006, deadfall: 0.022 } as const;

/** The heights this layer reads: the bake's square, row-major Z then X, centred at zero. */
export interface IDebrisGround {
  readonly size: number;
  readonly resolution: number;
  readonly heights: ArrayLike<number>;
}

/** Slope in degrees at every cell, from central differences. */
function slopes({ size, resolution: n, heights }: IDebrisGround): Float32Array {
  const step = size / (n - 1);
  const out = new Float32Array(n * n);
  const at = (r: number, c: number) =>
    heights[Math.min(n - 1, Math.max(0, r)) * n + Math.min(n - 1, Math.max(0, c))] ?? 0;
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * step);
      const dz = (at(r + 1, c) - at(r - 1, c)) / (2 * step);
      out[r * n + c] = (Math.atan(Math.hypot(dx, dz)) * 180) / Math.PI;
    }
  return out;
}

/**
 * The apron weight at every cell, 0..1: 1 at the foot of a face, falling to 0 at `TALUS.reach`
 * metres, and 0 on ground too steep to hold stone or above every nearby face.
 */
export function talusWeight(ground: IDebrisGround): Float32Array {
  const { size, resolution: n, heights } = ground;
  const step = size / (n - 1);
  const slope = slopes(ground);
  const radius = Math.ceil(TALUS.reach / step);
  const weight = new Float32Array(n * n);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const here = r * n + c;
      if ((slope[here] ?? 90) > TALUS.restSlope) continue;
      const height = heights[here] ?? 0;
      let nearest = Number.POSITIVE_INFINITY;
      for (let dr = -radius; dr <= radius; dr++)
        for (let dc = -radius; dc <= radius; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue;
          const there = rr * n + cc;
          if ((slope[there] ?? 0) < TALUS.faceSlope) continue;
          if ((heights[there] ?? 0) < height + TALUS.drop) continue;
          nearest = Math.min(nearest, Math.hypot(dr, dc) * step);
        }
      if (nearest < TALUS.reach) weight[here] = (1 - nearest / TALUS.reach) ** 1.5;
    }
  return weight;
}

/**
 * Every debris placement on the square: talus at the cliff feet, a thin scatter on the flats. `y` is
 * 0: the game's ground query sets the height, as it does for the meadow.
 */
export function desertDebris(ground: IDebrisGround): IPlacement[] {
  const { size, resolution: n } = ground;
  const step = size / (n - 1);
  const half = size / 2;
  const slope = slopes(ground);
  const apron = talusWeight(ground);
  const random = createRandom(DEBRIS_SEED);
  const placements: IPlacement[] = [];
  const counts: Record<string, number> = {};
  const put = (asset: string, x: number, z: number, scale: number) => {
    if (Math.abs(x) > half - 2 || Math.abs(z) > half - 2) return;
    const index = counts[asset] ?? 0;
    counts[asset] = index + 1;
    placements.push({
      asset,
      id: `desert-${asset}:debris-${index}`,
      layer: `desert-${asset}`,
      alignToNormal: asset !== "deadfall",
      normal: [0, 1, 0],
      position: [x, 0, z],
      rotation: random() * Math.PI * 2,
      scale,
    });
  };
  /** Rounds `mean` to a whole count with the remainder as a chance. */
  const many = (mean: number) => Math.floor(mean) + (random() < mean % 1 ? 1 : 0);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      const here = r * n + c;
      const w = apron[here] ?? 0;
      const open = (slope[here] ?? 90) < 22 ? 1 : 0;
      const x0 = -half + c * step;
      const z0 = -half + r * step;
      const at = (): [number, number] => [
        x0 + (random() - 0.5) * step,
        z0 + (random() - 0.5) * step,
      ];
      for (let k = many(APRON.pebble * w + FLAT.pebble * open); k > 0; k--)
        put("pebble", ...at(), 0.08 + random() * 0.22);
      for (let k = many(APRON.scree * w + FLAT.scree * open); k > 0; k--)
        put("scree", ...at(), 0.4 + random() * 0.9 * (0.5 + w));
      for (let k = many(APRON.volcanic * w + FLAT.volcanic * open); k > 0; k--)
        put("volcanic", ...at(), 0.12 + random() * 0.35 * (0.4 + w));
      for (let k = many(APRON.reveal * w); k > 0; k--)
        put("reveal", ...at(), 0.36 + random() * 0.5);
      for (let k = many(APRON.deadfall * w + FLAT.deadfall * open); k > 0; k--)
        put("deadfall", ...at(), 0.6 + random() * 0.7);
    }
  return placements;
}
