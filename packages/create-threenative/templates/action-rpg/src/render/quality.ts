// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or rewrite
// it freely — the tiers below are a starting point, not a framework look.
//
// This is the one place this game decides how expensive it looks. `postprocessing.ts` reads
// `qualityPreset(resolveQualityTier(...))` and nothing else, so "make it run on a phone" is one
// file to edit rather than a hunt through anonymous literals.
//
// **Where the numbers come from.** Every millisecond below is GPU time from the per-stage
// ablation recorded in the engine repository's `docs/verification/runtime-perf-state.md`: Chrome
// on an RTX 2080, 1600x900, static build, `gpuMs` read from three's `timestamp-query`. In that
// scene the whole five-stage chain costs **12.5 ms of a 14.7 ms GPU frame**, and the same frame
// with every stage off costs **2.2 ms**. The per-stage figures oversum — removing SSGI also
// removes the denoise passes the later stages sample — so read each as *what turning this one off
// gave back*, not as a share of a partition. A stage nobody has ablated on its own says
// `unmeasured` rather than guessing, and your scene is not that scene: read `TN_FRAME_BUDGET`
// back after you change a tier.
//
// One cost that is **not** a stage here and outweighs most of them: the prefiltered reflection
// probe on `scene.environment`, measured at **~6.3 ms of an 18-19 ms Pixel 8 frame**. It is set
// in `sky.ts`, not in this file.
//
// **This template runs no SSGI at any tier, and that is a measurement rather than a taste.** Its
// sky, sun colour and depth haze are a volumetric `Atmosphere`, which already owns most of the
// frame. With the gather on, `playtests/play.playtest.json` measured **34.2 ms p95 against the
// 33 ms ceiling**; without it the same scenario passes. Turn it on when you replace the
// atmosphere with a flat sky, and read the p95 back out of `TN_FRAME_BUDGET`.
import {
  type IWorldEnvironmentOptions,
  qualityPreset as coreQualityPreset,
  qualityTiers,
} from "@threenative/core";
import { exposureSettings } from "./exposure.js";
export type { QualityTier } from "@threenative/core";
import type { QualityTier } from "@threenative/core";

/**
 * The three names this game's look comes in.
 *
 * `low` is what a phone gets and `high` what a desktop gets — those two are this template's
 * shipped looks, unchanged. `medium` is the rung in between for a machine that is neither: a
 * laptop iGPU, a handheld, a desktop that is dropping frames. Nothing outside this file decides
 * what any of them mean.
 */
export const resolveQualityTier = qualityTiers.resolve;

/**
 * Named overrides of core's Unreal look: the owner (2026-10-26) prefers the 7b546d6 neutral look,
 * grey stone and pale floor with no yellow cast. `TN_WORLD_ENVIRONMENT` reports the tone curve and
 * the exposure this runs; delete a line to take core's value back.
 */
export const neutralLook: IWorldEnvironmentOptions = {
  // ACES at a fixed exposure: core's filmic curve and metered exposure read yellowish here.
  tonemapMode: "aces",
  autoExposureEnabled: false,
  exposure: 0.62,
  // The kit's bloom: a low threshold that lifts the sunlit floor a little.
  bloomRadius: 0.5,
  bloomStrength: 0.7,
  bloomThreshold: 0.2,
  // The kit's contact occlusion: whole-frame, a 0.35 m reach, 16 directions (8 on medium).
  gtaoDistanceExponent: 1,
  gtaoDistanceFalloff: 1,
  gtaoIndirectOnly: false,
  gtaoRadius: 0.35,
  gtaoSamples: 16,
  // 4x MSAA under the chain on every tier.
  samples: 4,
};

/** The 7b546d6 per-tier values: half the occlusion directions on medium, none of it on a phone. */
const neutralTiers: Readonly<Record<string, IWorldEnvironmentOptions>> = {
  high: {},
  medium: { gtaoSamples: 8 },
  low: { gtaoEnabled: false, gtaoRadius: 0.25, motionBlurEnabled: false, temporalAA: false },
};

/**
 * The stages and strengths a tier turns on: the core preset, the neutral look above, this game's
 * exposure policy and the named cost override: no gather, no reflections. The volumetric atmosphere already owns most
 * of the frame; the performance scenario measured 39 to 42 ms GPU p95 with them on and about 1.5 ms
 * of frame time without them. Remove the override when the atmosphere is replaced by a flat sky.
 */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  console.info(
    `TN_RENDER_CHAIN_COST_OVERRIDE ${JSON.stringify({
      reason:
        "Action RPG: the volumetric atmosphere owns the frame; the gather and reflections took the performance scenario to 39-42 ms GPU p95",
      finalGatherMethod: "none",
      ssgiEnabled: false,
      ssrEnabled: false,
    })}`,
  );
  return {
    ...coreQualityPreset(tier),
    ...neutralLook,
    ...neutralTiers[tier],
    exposurePolicy: exposureSettings,
    finalGatherMethod: "none",
    ssgiEnabled: false,
    ssrEnabled: false,
  };
}

/** First admitted material lane: high desktop hardware WebGPU in the browser only. */
export interface IMaterialLightingEnvironment {
  readonly web: boolean;
  readonly rendererKind: string;
  readonly mobile?: boolean;
  readonly software?: boolean;
  readonly webglFallback?: boolean;
}
export function materialLightingEnabled(
  tier: QualityTier,
  environment: IMaterialLightingEnvironment,
): boolean {
  return (
    tier === "high" &&
    environment.web &&
    environment.rendererKind === "webgpu" &&
    environment.mobile !== true &&
    environment.software !== true &&
    environment.webglFallback !== true
  );
}

/** A WebGPURenderer wrapper may run an ordinary WebGL fallback backend. */
export function isWebGLFallbackRenderer(renderer: unknown): boolean {
  if (renderer === null || typeof renderer !== "object") return false;
  const backend = Reflect.get(renderer, "backend");
  return (
    backend !== null &&
    typeof backend === "object" &&
    Reflect.get(backend, "isWebGLBackend") === true
  );
}
