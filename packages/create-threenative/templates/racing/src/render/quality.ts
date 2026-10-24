import { exposureSettings } from "./exposure.js";
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
// **This template runs no SSGI, SSR or sharpen at any tier, and that is a measurement rather than
// a taste.** A race is a moving camera over grey tarmac: nothing in the frame is glossy enough for
// a reflection to read as one, and a gather this large only pays off on surfaces that bounce light
// into each other — of which a circuit has none. What a track does need is occlusion (the dark
// line where a tyre meets tarmac is most of what says the car is *on* the road) and bloom for the
// sun and the tail lights. The bounded proof is `playtests/performance.playtest.json`: it holds the
// frame at 33 ms p95 and 30 fps, so if you turn a stage on, that scenario is what tells you it was
// worth it. Both are one line to turn back on.

import {
  type IWorldEnvironmentOptions,
  qualityPreset as coreQualityPreset,
  qualityTiers,
} from "@threenative/core";
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

export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  console.info(
    `TN_RENDER_CHAIN_COST_OVERRIDE ${JSON.stringify({
      reason:
        "Racing: rough-tarmac SSR speckle and RCAS sky bands; PRD-194 performance scenario holds 33 ms p95 and 30 fps; isolated stage costs remain unmeasured",
      finalGatherMethod: "none",
      ssgiEnabled: false,
      ssrEnabled: false,
      sharpenEnabled: false,
    })}`,
  );
  return {
    ...coreQualityPreset(tier),
    exposurePolicy: exposureSettings,
    finalGatherMethod: "none",
    ssgiEnabled: false,
    ssrEnabled: false,
    sharpenEnabled: false,
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
