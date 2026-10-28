// Generated for you. This is ordinary Three.js configuration — edit it freely.
//
// The look is a fresh Unreal 5.8.3 project's, and it comes from ThreeNative core: the filmic
// tone curve, metered auto exposure, local exposure, Unreal's bloom and vignette, contact
// occlusion and temporal anti-aliasing on `high`. The engine's `qualityPreset(tier)` is that look
// per tier; this file's `qualityPreset` only adds what this game changes on top of it, each change with its reason and its
// cost. It starts empty on purpose: no tone curve, exposure or meter is pinned here, so the game
// looks like the engine default until you decide otherwise.
//
// Tiers: `high` (a desktop GPU, Unreal's Epic), `medium` (integrated GPUs and high-end phones)
// and `low` (other phones and software adapters). A budget breach drops `renderChainTier`, never
// the curve or the meter. Force one with `setupPost(renderer, scene, camera, { tier: "low" })`.
import {
  type IWorldEnvironmentOptions,
  type QualityTier,
  qualityPreset as engineQualityPreset,
  qualityTiers,
} from "@threenative/core";

export type { QualityTier };

// What `high` changes on top of the engine's `high`. Nothing yet.
const high: IWorldEnvironmentOptions = {};
// What `medium` changes on top of the engine's `medium`. Nothing yet.
const medium: IWorldEnvironmentOptions = {};
// What `low` changes on top of the engine's `low`. Nothing yet.
const low: IWorldEnvironmentOptions = {};

const OVERRIDES: Record<QualityTier, IWorldEnvironmentOptions> = { high, low, medium };

/**
 * Share of the meadow's grass tufts each tier draws (`render/foliage.ts`). Not a look option: the
 * same seeded tufts, fewer of them. Cost: every tuft is 9 triangles, so the full meadow is about
 * 100k triangles in about 60 cells, of which the camera sees a third to a half.
 */
export const GRASS_SHARE: Record<QualityTier, number> = { high: 1, low: 0.25, medium: 0.55 };

/**
 * Picks the tier: an explicit `tier` wins, a software adapter gets `low`, then the GPU family,
 * then `mobile`. An unknown tier name throws (in core) rather than rendering the default.
 */
export function resolveQualityTier(
  request: Parameters<typeof qualityTiers.resolve>[0] = {},
): QualityTier {
  return qualityTiers.resolve(request);
}

/** The engine's look for `tier`, with this game's overrides on top. */
export function qualityPreset(tier: QualityTier): IWorldEnvironmentOptions {
  return { ...engineQualityPreset(tier), ...OVERRIDES[tier] };
}
