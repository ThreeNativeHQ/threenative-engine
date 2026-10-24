import {
  type IWorldEnvironmentOptions,
  qualityPreset as coreQualityPreset,
  qualityTiers,
} from "@threenative/core";
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
import type { IGradeSettings } from "./grade.js";
export type { QualityTier } from "@threenative/core";
import type { QualityTier } from "@threenative/core";

/**
 * This game's authored looks. GPU family picks the start; measured frame budgets refine it.
 * Edit these presets to change the look without changing the framework.
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

const shared: IWorldEnvironmentOptions = {
  autoExposureEnabled: false,
  // Bloom cost: unmeasured here; PRD-636 records it in ms.
  bloomEnabled: true,
  exposure: 0.62,
  tonemapMode: "aces",
  // The Unreal bloom is the one `bloomEnabled` runs. Cost: unmeasured.
  unrealBloomEnabled: true,
  vignetteAmount: 0.4,
};

/**
 * What a desktop gets: contact occlusion on top — the dark line where a foot meets the platform
 * and a wall meets the ground, most of what separates "objects in a world" from "objects pasted on
 * a background". Gathered at full resolution and denoised: at half, the upsample left a grain
 * around every foot.
 */
const high: IWorldEnvironmentOptions = {
  ...shared,
  // Unreal's default anti-aliasing is temporal (`r.AntiAliasingMethod` 4). The engine jitters the camera, draws the motion
  // and blends the frames; `temporalAA: false` brings back the chain's SMAA, which is what `low` and three.js keep.
  // Read `setupPost(...).debug().temporal` for the live frame, history and jitter. The opt-in `traa` kit stage
  // (`temporalAA.ts`) takes its place when the tier lists `authoredStageNames: ["traa"]`.
  temporalAA: true,
  // GTAO, full resolution plus denoise: unmeasured on its own here; read `TN_FRAME_BUDGET`.
  gtaoEnabled: true,
  gtaoRadius: 0.35,
  // Measures against `exposure` while auto exposure is off. Cost: unmeasured.
  localExposureEnabled: true,
  // Unreal enables motion blur on high-end PCs only. It needs the chain's velocity. Cost: unmeasured.
  motionBlurEnabled: true,
  renderChainTier: "high",
};

/**
 * The rung in between: the same occlusion at half the directions. Saving unmeasured, and the
 * chain's own antialiasing one notch cheaper.
 */
// Temporal AA owns medium edges (it comes with `...high`); another four-sample world resolve adds mobile bandwidth.
const medium: IWorldEnvironmentOptions = {
  ...high,
  gtaoSamples: 8,
  motionBlurEnabled: false,
  renderChainTier: "medium",
  samples: 0,
};

/** What a phone gets: bloom, vignette and the tone curve. Unreal's mobile profile has no local exposure. */
const low: IWorldEnvironmentOptions = { ...shared, renderChainTier: "low" };

const QUALITY_PRESETS: Record<QualityTier, IWorldEnvironmentOptions> = { high, low, medium };

/**
 * This game's colour grade and grain, per tier (`grade.ts`, `public/grade.cube`). **Both are off, as in
 * a fresh Unreal project** (Scene.cpp: neutral grade, `FilmGrainIntensity` 0). A zero refuses its stage
 * and `TN_RENDER_CHAIN` says why. Turn them on with `gradeIntensity: 1` and a `grainIntensity` from
 * 0.0039 (under one 8-bit step on mid grey) to 0.12 (a visible film grain).
 */
const GRADE_PRESETS: Record<QualityTier, IGradeSettings> = {
  high: { gradeIntensity: 0, grainAnimated: true, grainIntensity: 0, tier: "high" },
  medium: { gradeIntensity: 0, grainAnimated: false, grainIntensity: 0, tier: "medium" },
  low: { gradeIntensity: 0, grainAnimated: false, grainIntensity: 0, tier: "low" },
};

/** The stages and strengths a tier turns on. Throws on a name that is not a tier. */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  const preset = QUALITY_PRESETS[tier as QualityTier];
  if (preset === undefined) {
    throw new Error(
      `Unknown quality tier ${JSON.stringify(tier)} — expected one of ${["low", "medium", "high"].join(", ")}.`,
    );
  }
  return { ...coreQualityPreset(tier), ...legacyDefaults, ...preset, samples: preset.samples ?? 4 };
}

/** The grade and grain a tier runs. Throws on a name that is not a tier, for the same reason. */
export function gradePreset(tier: string): IGradeSettings {
  const preset = GRADE_PRESETS[tier as QualityTier];
  if (preset === undefined) {
    throw new Error(
      `Unknown quality tier ${JSON.stringify(tier)} — expected one of ${["low", "medium", "high"].join(", ")}.`,
    );
  }
  return preset;
}

export {
  type IMaterialLightingEnvironment,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "./rendererGate.js";
