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
// **This template runs neither SSGI nor SSR at any tier.** Its frame cost is the water — a
// displaced 96x96 plane with its own material — not the post chain, and a screen-space reflection
// over moving water reads as smear. That is a template decision recorded here, not an omission:
// the two most expensive stages in the reference ablation are off on a desktop as well as on a
// phone, which is also why the rung between the tiers is bloom strength and nothing else.
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
 * named override from the header: no final gather, no SSGI, no SSR. The frame is the water,
 * and a screen-space reflection over moving water reads as smear. Motion blur is off too: with the
 * camera chasing the ship it smeared the sails and the buoys at 1920x1080.
 */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  console.info(
    `TN_RENDER_CHAIN_COST_OVERRIDE ${JSON.stringify({
      reason:
        "Sailing: the frame is the water; screen-space reflections over moving water read as smear, the gather is the costliest stage, and motion blur smeared the chase-camera ship",
      finalGatherMethod: "none",
      ssgiEnabled: false,
      ssrEnabled: false,
      motionBlurEnabled: false,
    })}`,
  );
  return {
    ...coreQualityPreset(tier),
    exposurePolicy: exposureSettings,
    finalGatherMethod: "none",
    ssgiEnabled: false,
    ssrEnabled: false,
    motionBlurEnabled: false,
  };
}

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
