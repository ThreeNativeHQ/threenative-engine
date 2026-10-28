import {
  type IWorldEnvironmentOptions,
  qualityPreset as coreQualityPreset,
  qualityTiers,
} from "@threenative/core";
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
import type { IGradeSettings } from "./grade.js";
export type { QualityTier } from "@threenative/core";
import type { QualityTier } from "@threenative/core";

/**
 * This game's authored looks. GPU family picks the start; measured frame budgets refine it.
 * Edit these presets to change the look without changing the framework.
 */
export const resolveQualityTier = qualityTiers.resolve;

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
  return { ...coreQualityPreset(tier), exposurePolicy: exposureSettings };
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
