import { clamp, falloff, noise2, slopeAtIndex, smoothstep, world } from "./math.js";
import type { IMask, ITerrainState, MaskSampler, MaterialId } from "./types.js";

/** The eight splat channels, in channel order. Index 0 is the default base channel. */
export const MATERIAL_IDS: readonly MaterialId[] = Object.freeze([
  "grass",
  "dirt",
  "rock",
  "snow",
  "sand",
  "mud",
  "road",
  "moss",
]);

/**
 * Serializable mask builders. A mask is data, never a callback, so a recipe round-trips through
 * JSON and an editor can rewrite one field without executing anything.
 */
export const Mask = Object.freeze({
  all: (): IMask => ({ type: "all" }),
  none: (): IMask => ({ type: "none" }),
  circle: (at: readonly [number, number], radius: number, softness = 0.6): IMask => ({
    type: "circle",
    at,
    radius,
    falloff: softness,
  }),
  rectangle: (
    at: readonly [number, number],
    size: number | readonly [number, number],
    rotation = 0,
    softness = 0.2,
  ): IMask => ({ type: "rectangle", at, size, rotation, falloff: softness }),
  height: (min = -1e9, max = 1e9, fade = 0): IMask => ({ type: "height", min, max, fade }),
  slope: (min = 0, max = 90, fade = 0): IMask => ({ type: "slope", min, max, fade }),
  noise: (scale = 80, threshold = 0.5, seed = 1, fade = 0.15): IMask => ({
    type: "noise",
    scale,
    threshold,
    seed,
    fade,
  }),
  biome: (name: string): IMask => ({ type: "biome", name }),
  material: (name: MaterialId): IMask => ({ type: "material", name }),
  and: (...masks: IMask[]): IMask => ({ type: "and", masks }),
  or: (...masks: IMask[]): IMask => ({ type: "or", masks }),
  not: (mask: IMask): IMask => ({ type: "not", mask }),
});

const range = (v: number, min: number, max: number, fade = 0): number =>
  fade > 0
    ? smoothstep(min - fade, min, v) * (1 - smoothstep(max, max + fade, v))
    : Number(v >= min && v <= max);

/** Compiles a mask into one sampler. Height and slope masks read the state as it is at this stage. */
export function compileMask(mask: IMask | undefined, s: ITerrainState): MaskSampler {
  if (!mask || mask.type === "all") return () => 1;
  switch (mask.type) {
    case "none":
      return () => 0;
    case "circle": {
      const centre = mask.at as readonly [number, number];
      return (i, x, z) =>
        falloff(
          Math.hypot(x - centre[0], z - centre[1]),
          mask.radius as number,
          mask.falloff ?? 0.6,
        );
    }
    case "rectangle": {
      const centre = mask.at as readonly [number, number];
      const rad = ((mask.rotation ?? 0) * Math.PI) / 180;
      const c = Math.cos(rad);
      const sn = Math.sin(rad);
      const size = Array.isArray(mask.size) ? mask.size : [mask.size, mask.size];
      return (i, x, z) => {
        const dx = x - centre[0];
        const dz = z - centre[1];
        return falloff(
          Math.max(
            Math.abs(dx * c + dz * sn) / ((size[0] as number) / 2),
            Math.abs(-dx * sn + dz * c) / ((size[1] as number) / 2),
          ),
          1,
          mask.falloff ?? 0.2,
        );
      };
    }
    case "height":
      return (i) => range(s.height[i] as number, mask.min ?? -1e9, mask.max ?? 1e9, mask.fade);
    case "slope":
      return (i) => range(slopeAtIndex(s, i), mask.min ?? 0, mask.max ?? 90, mask.fade);
    case "noise":
      return (i, x, z) =>
        smoothstep(
          (mask.threshold ?? 0.5) - (mask.fade ?? 0.15),
          (mask.threshold ?? 0.5) + (mask.fade ?? 0.15),
          noise2(x / (mask.scale as number), z / (mask.scale as number), mask.seed ?? s.seed) *
            0.5 +
            0.5,
        );
    case "biome": {
      const field = s.biomes[mask.name as string];
      return (i) => field?.[i] ?? 0;
    }
    case "material": {
      const channel = MATERIAL_IDS.indexOf(mask.name as MaterialId);
      if (channel < 0) throw Error(`Unknown material: ${String(mask.name)}`);
      return (i) => s.splat[i * 8 + channel] as number;
    }
    case "not": {
      const inner = compileMask(mask.mask, s);
      return (i, x, z) => 1 - inner(i, x, z);
    }
    case "and": {
      const inner = (mask.masks ?? []).map((entry) => compileMask(entry, s));
      return (i, x, z) => inner.reduce((value, sample) => value * sample(i, x, z), 1);
    }
    case "or": {
      const inner = (mask.masks ?? []).map((entry) => compileMask(entry, s));
      return (i, x, z) => 1 - inner.reduce((value, sample) => value * (1 - sample(i, x, z)), 1);
    }
    default:
      throw Error(`Unknown mask: ${String((mask as IMask).type)}`);
  }
}

/** Rasterizes a mask once per operation stage; `null` means "no mask, full coverage". */
export function rasterMask(mask: IMask | undefined, s: ITerrainState): Float32Array | null {
  if (!mask || mask.type === "all") return null;
  const out = new Float32Array(s.height.length);
  const sample = compileMask(mask, s);
  for (let z = 0; z < s.resolution; z += 1) {
    for (let x = 0; x < s.resolution; x += 1) {
      const i = z * s.resolution + x;
      out[i] = clamp(sample(i, world(s, x), world(s, z)));
    }
  }
  return out;
}

/** Blends one channel in and renormalizes, so weights keep summing to one. */
export function paintWeights(s: ITerrainState, i: number, channel: number, weight: number): void {
  const w = clamp(weight);
  const base = i * 8;
  for (let c = 0; c < 8; c += 1)
    s.splat[base + c] = (s.splat[base + c] as number) * (1 - w) + (c === channel ? w : 0);
}
