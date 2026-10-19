import type { IGrid, ISampledGrid } from "./types.js";

export const clamp = (x: number, a = 0, b = 1): number => Math.max(a, Math.min(b, x));

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const smoothstep = (a: number, b: number, x: number): number => {
  if (a === b) return x >= b ? 1 : 0;
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** FNV-1a over the layer ID, so a deferred rule's placement is reproducible from its name. */
export const hashString = (text: string): number => {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};

/** Mulberry32: the seeded generator every stochastic pass in the evaluator uses. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hash2 = (x: number, z: number, seed: number): number => {
  let n = Math.imul(x | 0, 374761393) ^ Math.imul(z | 0, 668265263) ^ seed;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return (n ^ (n >>> 16)) >>> 0;
};

// quality-allow: supplied coefficient is part of seeded recipe compatibility, verified against source SHA-256.
// biome-ignore lint/suspicious/noApproximativeNumericConstant: preserve supplied noise coefficients exactly; changing this alters seeded erosion.
const diagonalGradient = 0.7071;

const grad = (h: number, x: number, z: number): number => {
  switch (h & 7) {
    case 0:
      return x;
    case 1:
      return -x;
    case 2:
      return z;
    case 3:
      return -z;
    case 4:
      return (x + z) * diagonalGradient;
    case 5:
      return (x - z) * diagonalGradient;
    case 6:
      return (-x + z) * diagonalGradient;
    default:
      return (-x - z) * diagonalGradient;
  }
};

/** Gradient noise in roughly `[-1, 1]`; the single deterministic noise field the recipe calls. */
export function noise2(x: number, z: number, seed = 1): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  return (
    lerp(
      lerp(grad(hash2(ix, iz, seed), fx, fz), grad(hash2(ix + 1, iz, seed), fx - 1, fz), u),
      lerp(
        grad(hash2(ix, iz + 1, seed), fx, fz - 1),
        grad(hash2(ix + 1, iz + 1, seed), fx - 1, fz - 1),
        u,
      ),
      v,
    ) * 1.65
  );
}

export interface IFbmOptions {
  seed?: number;
  octaves?: number;
  persistence?: number;
  lacunarity?: number;
  mode?: "fbm" | "ridged" | "billow";
}

export function fbm(
  inputX: number,
  inputZ: number,
  { seed = 1, octaves = 5, persistence = 0.5, lacunarity = 2, mode = "fbm" }: IFbmOptions = {},
): number {
  let x = inputX;
  let z = inputZ;
  let value = 0;
  let amplitude = 1;
  let total = 0;
  for (let i = 0; i < octaves; i += 1) {
    let n = noise2(x + 13.17, z - 8.71, seed + i * 71);
    if (mode === "ridged") n = (1 - Math.abs(n)) ** 2 * 2 - 1;
    if (mode === "billow") n = Math.abs(n) * 2 - 1;
    value += n * amplitude;
    total += amplitude;
    amplitude *= persistence;
    x *= lacunarity;
    z *= lacunarity;
  }
  return total ? value / total : 0;
}

/** Column index to world metres; the field is centred on zero. */
export const world = (grid: IGrid, x: number): number =>
  (x / (grid.resolution - 1)) * grid.size - grid.size / 2;

/** Bilinear sample of any row-major grid. */
export function sampleGrid(
  a: ArrayLike<number>,
  width: number,
  height: number,
  u: number,
  v: number,
): number {
  const gx = clamp(u, 0, 1) * (width - 1);
  const gz = clamp(v, 0, 1) * (height - 1);
  const x = Math.min(width - 2, Math.floor(gx));
  const z = Math.min(height - 2, Math.floor(gz));
  const tx = gx - x;
  const tz = gz - z;
  return lerp(
    lerp(a[z * width + x] as number, a[z * width + x + 1] as number, tx),
    lerp(a[(z + 1) * width + x] as number, a[(z + 1) * width + x + 1] as number, tx),
    tz,
  );
}

/** Bilinear world-space height query. It is not the rendered or collidable triangle surface. */
/**
 * Bilinear query of canonical height samples; triangle sampling is a separate contract.
 * @requires npm i @threenative/terrain
 * @situation query an authored heightfield at world coordinates
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const height = sampleHeight(new Terrain({ resolution: 17 }).evaluate(), 0, 0);
 */
export const sampleHeight = (grid: ISampledGrid, x: number, z: number): number =>
  sampleGrid(
    grid.height,
    grid.resolution,
    grid.resolution,
    x / grid.size + 0.5,
    z / grid.size + 0.5,
  );

/** `[dh/dx, dh/dz]` at a world position. */
/**
 * World-space height gradient from the canonical samples.
 * @requires npm i @threenative/terrain
 * @situation measure an authored terrain gradient in metres
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const gradient = gradientAt(new Terrain({ resolution: 17 }).evaluate(), 0, 0);
 */
export function gradientAt(grid: ISampledGrid, x: number, z: number): [number, number] {
  const d = grid.size / (grid.resolution - 1);
  return [
    (sampleHeight(grid, x + d, z) - sampleHeight(grid, x - d, z)) /
      (Math.min(grid.size / 2, x + d) - Math.max(-grid.size / 2, x - d) || d),
    (sampleHeight(grid, x, z + d) - sampleHeight(grid, x, z - d)) /
      (Math.min(grid.size / 2, z + d) - Math.max(-grid.size / 2, z - d) || d),
  ];
}

/** Slope in degrees at one sample index. */
/**
 * Slope in degrees at a heightfield sample.
 * @requires npm i @threenative/terrain
 * @situation measure terrain slope for authoring diagnostics
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const slope = slopeAtIndex(new Terrain({ resolution: 17 }).evaluate(), 0);
 */
export function slopeAtIndex(grid: ISampledGrid, i: number): number {
  const n = grid.resolution;
  const x = i % n;
  const z = Math.floor(i / n);
  const dx = x > 0 && x < n - 1 ? 2 : 1;
  const dz = z > 0 && z < n - 1 ? 2 : 1;
  const cell = grid.size / (n - 1);
  const gx =
    ((grid.height[z * n + Math.min(x + 1, n - 1)] as number) -
      (grid.height[z * n + Math.max(x - 1, 0)] as number)) /
    (dx * cell);
  const gz =
    ((grid.height[Math.min(z + 1, n - 1) * n + x] as number) -
      (grid.height[Math.max(z - 1, 0) * n + x] as number)) /
    (dz * cell);
  return Math.atan(Math.hypot(gx, gz)) * (180 / Math.PI);
}

/**
 * A slope, in degrees, that the given share of this terrain's interior vertices lie at or below.
 *
 * Placement rules keyed to fixed degrees break when a world is rebaked smoother or rougher: an
 * outcrop rule of "over 30 degrees" placed nothing on a forest whose 98th percentile is 22. Asking
 * the terrain for its own steepest share keeps the rule meaning the same thing on every world.
 *
 * @requires npm i @threenative/terrain
 * @situation place rocks or cliffs on a terrain's own steepest ground instead of a fixed slope in degrees
 * @constraint interior vertices only (edges have one-sided differences); quantile must be in [0, 1]
 * @example const steep = slopeQuantile(grid, 0.98); if (slopeAt(x, z) > Math.min(30, steep)) placeRock(x, z);
 */
export function slopeQuantile(grid: ISampledGrid, quantile: number): number {
  if (!(quantile >= 0 && quantile <= 1))
    throw new Error(
      `TN_TERRAIN_SLOPE_QUANTILE_INVALID: quantile must be in [0, 1], received ${String(quantile)}.`,
    );
  const n = grid.resolution;
  const slopes: number[] = [];
  for (let z = 1; z < n - 1; z++)
    for (let x = 1; x < n - 1; x++) slopes.push(slopeAtIndex(grid, z * n + x));
  if (slopes.length === 0) return 0;
  slopes.sort((a, b) => a - b);
  return slopes[Math.min(slopes.length - 1, Math.floor(slopes.length * quantile))] as number;
}

/** Radial brush weight: 1 at the centre, 0 at `radius`, softened over the outer `softness`. */
export function falloff(distance: number, radius: number, softness = 0.6): number {
  const d = distance / radius;
  return d >= 1 ? 0 : 1 - smoothstep(1 - clamp(softness, 0.00001, 1), 1, d);
}

/**
 * Samples a spline: Catmull-Rom horizontally to avoid corners, linear vertically to avoid
 * overshoot. `smooth: false` walks the polyline.
 */
/**
 * Recovered horizontal Catmull–Rom and vertically linear profile sampler.
 * @requires npm i @threenative/terrain
 * @situation sample a road or river profile without vertical overshoot
 * @constraint authoring data only; the game owns appearance, physics and rendering
 * @example const points = splinePoints([[0, 4, 0], [10, 2, 10]], 3, false);
 */
export function splinePoints(
  points: readonly (readonly [number, number, number])[],
  step = 3,
  smooth = true,
): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (let k = 0; k < points.length - 1; k += 1) {
    const a = points[Math.max(0, k - 1)] as readonly [number, number, number];
    const b = points[k] as readonly [number, number, number];
    const c = points[k + 1] as readonly [number, number, number];
    const d = points[Math.min(points.length - 1, k + 2)] as readonly [number, number, number];
    const count = Math.max(
      1,
      Math.min(512, Math.ceil(Math.hypot(c[0] - b[0], c[2] - b[2]) / step)),
    );
    for (let j = 0; j < count; j += 1) {
      const t = j / count;
      const t2 = t * t;
      const t3 = t2 * t;
      const cat = (dim: 0 | 1 | 2): number =>
        0.5 *
        (2 * b[dim] +
          (-a[dim] + c[dim]) * t +
          (2 * a[dim] - 5 * b[dim] + 4 * c[dim] - d[dim]) * t2 +
          (-a[dim] + 3 * b[dim] - 3 * c[dim] + d[dim]) * t3);
      out.push([
        smooth ? cat(0) : lerp(b[0], c[0], t),
        lerp(b[1], c[1], t),
        smooth ? cat(2) : lerp(b[2], c[2], t),
      ]);
    }
  }
  const last = points[points.length - 1] as readonly [number, number, number];
  out.push([last[0], last[1], last[2]]);
  return out;
}
