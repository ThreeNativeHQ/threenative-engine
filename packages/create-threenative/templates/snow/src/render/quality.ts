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
// **This template runs neither SSGI nor SSR at any tier.** Its frame cost is the snow — a dense
// deforming heightfield mesh and tens of thousands of flakes — not the post chain, and snow is
// already the brightest thing on screen, so the chain is tonemapping alone at every tier and the
// sun glints come from the snow material.
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

const legacyDefaults: IWorldEnvironmentOptions = {
  // PRD-723: preserve the vendored look until this kit earns IMPROVEMENT. Cost: unmeasured.
  autoExposureEnabled: false,
  // Bloom cost: unmeasured; preserve the vendored stage until this kit is judged.
  bloomEnabled: true,
  bloomRadius: 0.5,
  bloomStrength: 0.7,
  bloomThreshold: 0.2,
  exposure: 1,
  finalGatherMethod: "none",
  gtaoEnabled: false,
  gtaoRadius: 0.25,
  gtaoSamples: 16,
  gtaoDistanceExponent: 1,
  gtaoDistanceFalloff: 1,
  gtaoIndirectOnly: false,
  localExposureEnabled: false,
  motionBlurEnabled: false,
  ssgiEnabled: false,
  ssgiRadius: 12,
  ssgiResolutionScale: 0.5,
  ssrEnabled: false,
  ssrResolutionScale: 0.5,
  temporalAA: false,
  tonemapMode: "aces",
  unrealBloomEnabled: false,
  vignetteAmount: 0,
};

const high: IWorldEnvironmentOptions = {
  // Strength, radius and threshold are a look decision already tuned to this scene's palette.
  // Bloom: ~4.6 ms — the second most expensive stage in the chain, and the one nobody expects
  // to be.
  // Off. Snow is the brightest thing on screen, and at the default 0.2 threshold every lit
  // pixel blooms and the glade sinks into a white haze. A 0.92 threshold kept only the glints on
  // the web but left the native desktop frame blank behind the HUD (Dawn/Vulkan, 2026-10-01), so
  // the glints live in the snow material's emissive term instead. Turn it back on here.
  bloomEnabled: false,
  // No SSGI runs here, so there is nothing for the denoiser to clean up. Off, explicitly.
  denoiseEnabled: false,
  autoExposureEnabled: false,
  // Unreal's default anti-aliasing is temporal, and the engine offers it as `temporalAA: true`. It is off here: the engine
  // draws no velocity for instanced or sprite draws, and tens of thousands of flakes could trail. The scene keeps 4x
  // multisampling. Turn it on after you have watched the flakes with it.
  temporalAA: false,
  exposure: 0.95,
  // Off at every tier — see the note at the top of this file.
  ssgiEnabled: false,
  // Off at every tier — see the note at the top of this file.
  ssrEnabled: false,
  tonemapMode: "aces",
};

/**
 * The rung in between. With no screen-space stage and no bloom at any tier, the post chain is the
 * same everywhere; the tier only reaches the measured chain as `renderChainTier`. What a phone
 * saves is decided in `src/scenes/Snow.ts` (fewer flakes), and the snow mesh resolution in
 * `src/terrain.ts` is where the frame actually goes.
 */
const medium: IWorldEnvironmentOptions = { ...high, renderChainTier: "medium" };

/**
 * What a phone gets: this template's shipped mobile look, unchanged.
 */
const low: IWorldEnvironmentOptions = {
  // Strength, radius and threshold are a look decision already tuned to this scene's palette.
  // Bloom: ~4.6 ms — the second most expensive stage in the chain, and the one nobody expects
  // to be.
  // Off, as at the high tier.
  bloomEnabled: false,
  exposure: 0.95,
  // Off at every tier — see the note at the top of this file.
  ssgiEnabled: false,
  // Off at every tier — see the note at the top of this file.
  ssrEnabled: false,
  renderChainTier: "low",
  tonemapMode: "aces",
};

const QUALITY_PRESETS: Record<QualityTier, IWorldEnvironmentOptions> = { high, low, medium };

/** The stages and strengths a tier turns on. Throws on a name that is not a tier. */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  const preset = QUALITY_PRESETS[tier as QualityTier];
  if (preset === undefined) {
    throw new Error(
      `Unknown quality tier ${JSON.stringify(tier)} — expected one of ${["low", "medium", "high"].join(", ")}.`,
    );
  }
  return {
    ...coreQualityPreset(tier),
    ...legacyDefaults,
    ...preset,
    exposurePolicy: exposureSettings,
    samples: preset.samples ?? 4,
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
