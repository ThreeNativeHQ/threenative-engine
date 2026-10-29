// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or rewrite
// it freely — the tiers below are a starting point, not a framework look.
//
// This is the one place this game decides how expensive it looks. `postprocessing.ts` reads
// `qualityPreset(resolveQualityTier(...))` and nothing else, so "make it run on a phone" is one
// file to edit rather than a hunt through anonymous literals. `high` and `medium` anti-alias
// temporally (`temporalAA`) and `low` uses the World Environment's shared SMAA stage; see
// `screenSpaceAA` in `worldEnvironment.ts`.
//
// **Where the numbers come from.** Every millisecond below is GPU time from the per-stage
// ablation recorded in the engine repository's `docs/verification/runtime-perf-state.md`: Chrome
// on an RTX 2080, 1600x900, static build, `gpuMs` read from three's `timestamp-query`. The
// per-stage figures oversum — removing SSGI also removes the denoise passes the later stages
// sample — so read each as *what turning this one off gave back*, not as a share of a partition.
// A stage nobody has ablated on its own says `unmeasured` rather than guessing, and your scene is
// not that scene: read `TN_FRAME_BUDGET` back after you change a tier.
//
// One cost that is **not** a stage here and outweighs most of them: the prefiltered reflection
// probe on `scene.environment`, measured at **~6.3 ms of an 18-19 ms Pixel 8 frame**. It is set
// in `sky.ts`, not in this file.
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
 * `low` is what a phone gets and `high` what a desktop gets. `medium` is the rung in between for a
 * machine that is neither: a laptop iGPU, a handheld, a desktop dropping frames. Nothing outside
 * this file decides what any of them mean.
 */
export const resolveQualityTier = qualityTiers.resolve;

export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  // Core high measured 51.3/52 ms p95 against 33 ms; retain the core curve and meter at medium.
  const renderTier = tier === "high" ? "medium" : tier;
  if (renderTier !== tier)
    console.info("TN_RENDER_CHAIN_TIER_OVERRIDE high->medium: 52 ms p95 exceeded 33 ms");
  return {
    ...coreQualityPreset(renderTier),
    // Rough track needs no SSR; retain 33 ms p95 (real-display runs: 17.0/20.3 ms).
    ssrEnabled: false,
    // Keep Runner’s authored foot-contact radius under the core curve.
    gtaoRadius: 0.35,
    // The Three.js fallback uses SMAA; retain authored MSAA for the thin track rails.
    samples: 4,
    exposurePolicy: exposureSettings,
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
