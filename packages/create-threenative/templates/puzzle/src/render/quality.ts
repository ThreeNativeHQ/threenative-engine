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
// **This template runs no SSGI and no SSR at any tier, and both are measurements rather than
// tastes.** Forty-five simulated bodies are already the frame's budget, and SSGI is the most
// expensive stage in the reference ablation by a factor of two (~9.2 ms of a 14.7 ms frame with
// its two denoise passes); in a room this dark, one bounce of indirect light off a flagstone floor
// buys nothing the three lanterns do not already put there.
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
 * The stages and strengths a tier turns on: the core preset, this game's exposure policy and the
 * named cost override from the header: no final gather, no SSGI, no SSR. Forty-five simulated bodies
 * are already the frame's budget, and one bounce off a flagstone floor adds nothing the lanterns do
 * not already put there. The core stack's motion blur, full-resolution occlusion, local exposure and
 * Unreal bloom each added a few milliseconds to the performance scenario on an RTX 2080 and took its
 * GPU p95 past 16.7 ms; all four are off, and the kit's own bloom keeps the lantern glow. Remove an
 * override and read `TN_FRAME_BUDGET` when the room gets cheaper.
 */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  console.info(
    `TN_RENDER_CHAIN_COST_OVERRIDE ${JSON.stringify({
      reason:
        "Puzzle: forty-five simulated bodies are the frame budget; the core gather, motion blur, full-resolution occlusion, local exposure and Unreal bloom took the performance scenario past 16.7 ms GPU p95",
      finalGatherMethod: "none",
      ssgiEnabled: false,
      ssrEnabled: false,
      motionBlurEnabled: false,
      gtaoResolutionScale: 0.5,
      localExposureEnabled: false,
      unrealBloomEnabled: false,
    })}`,
  );
  return {
    ...coreQualityPreset(tier),
    exposurePolicy: exposureSettings,
    finalGatherMethod: "none",
    ssgiEnabled: false,
    ssrEnabled: false,
    motionBlurEnabled: false,
    gtaoResolutionScale: 0.5,
    localExposureEnabled: false,
    // The kit's own bloom: a high threshold, so only the lantern flames and the seal plate glow.
    unrealBloomEnabled: false,
    bloomRadius: 0.42,
    bloomStrength: 0.5,
    bloomThreshold: 0.85,
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
