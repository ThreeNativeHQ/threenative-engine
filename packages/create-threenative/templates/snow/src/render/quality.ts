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
// **The preset is core's Unreal look plus this game's exposure policy**, with one named cost
// override reported as `TN_RENDER_CHAIN_COST_OVERRIDE`: no final gather, SSGI or SSR, no
// temporal AA or motion blur, no bloom and no local exposure. The frame is the snow — a dense deforming heightfield mesh and tens
// of thousands of flakes. The screen-probe gather took the performance scenario to 38.8 ms GPU
// p95 against its 16.7 ms budget, and the flakes are GPU-computed sprites with no velocity, so
// both temporal stages trail and smear them. Snow fills the frame with bright pixels, so bloom
// lays a veil over everything and lifts the explorer's darkest pixel from 18 to 49. Local exposure
// lifts the explorer's shadows the same way and flattens it against the snow.
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
 * one named cost override from the header: no final gather, no temporal AA, no motion blur. The
 * snowfield and its flakes are the frame; the gather alone took the performance scenario to
 * 38.8 ms GPU p95, and the flakes have no velocity for the temporal stages. Remove an override
 * and read `TN_FRAME_BUDGET` when the snow gets cheaper.
 */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  console.info(
    `TN_RENDER_CHAIN_COST_OVERRIDE ${JSON.stringify({
      reason:
        "Snow: the snowfield is the frame; the core gather took the performance scenario past 16.7 ms GPU p95, temporal AA and motion blur trail the GPU-computed flakes that have no velocity, bloom veils the white glade and lifts the explorer's blacks, and local exposure lifts the explorer's shadows and flattens it against the snow",
      finalGatherMethod: "none",
      ssgiEnabled: false,
      ssrEnabled: false,
      temporalAA: false,
      motionBlurEnabled: false,
      bloomEnabled: false,
      localExposureEnabled: false,
    })}`,
  );
  return {
    ...coreQualityPreset(tier),
    exposurePolicy: exposureSettings,
    finalGatherMethod: "none",
    ssgiEnabled: false,
    ssrEnabled: false,
    temporalAA: false,
    motionBlurEnabled: false,
    bloomEnabled: false,
    localExposureEnabled: false,
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
