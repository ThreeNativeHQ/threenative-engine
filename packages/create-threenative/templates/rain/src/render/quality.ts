import {
  type IWorldEnvironmentOptions,
  qualityPreset as coreQualityPreset,
  qualityTiers,
} from "@threenative/core";
// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or rewrite
// it freely — the tiers below are a starting point, not a framework look.
//
// This is the one place this game decides how expensive it looks. Two tables live here:
//
// - `low` / `medium` / `high` are the engine render chain's tiers, which `postprocessing.ts` reads
//   through `qualityPreset(resolveQualityTier(...))`. This study turns **every built-in stage off at
//   every tier**: its bloom, ACES grade, vignette, lens beads and dither are the source study's own
//   single post pass, installed as one authored stage, so a built-in bloom or tone map would do the
//   same job a second time. What differs is the rung the chain reports and runs at
//   (`renderChainTier`), so a stage you add later with a `minimumTier` drops out on the cheap tiers.
// - `STUDY_TIERS` is the player's "Render quality" select — the reference study's own four tiers,
//   `performance` / `balanced` / `high` / `ultra`, number for number: the cloud pass's resolution
//   share and march steps, the rain budget, and whether wet surfaces run the 36-step reflection
//   march. The drawing buffer itself is the engine's adaptive resolution (`resolutionScale: "auto"`
//   in `threenative.config.ts`), which measures the frame instead of trusting a fixed table.
import type { QualityName } from "../state.js";
import { exposureSettings } from "./exposure.js";
export type { QualityTier } from "@threenative/core";
import type { QualityTier } from "@threenative/core";

/**
 * The engine chain's three tier names. `low` is what a phone gets and `high` what a desktop gets;
 * for this study all three are the same empty chain — see the note at the top of this file.
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
  bloomEnabled: false,
  denoiseEnabled: false,
  // Unreal's default anti-aliasing is temporal, and the engine offers it as `temporalAA: true`. It is off here: this study
  // draws its own single post pass and keeps 4x multisampling. A temporal pass would add a second chain around it.
  temporalAA: false,
  // The post pass applies the weather's exposure itself, after its own bloom add.
  autoExposureEnabled: false,
  exposure: 1,
  renderChainTier: "high",
  ssgiEnabled: false,
  ssrEnabled: false,
  tonemapMode: "aces",
};

/** The rung in between: the same empty chain, run and reported at `medium`. */
const medium: IWorldEnvironmentOptions = { ...high, renderChainTier: "medium" };

/** What a phone gets: the same empty chain at `low`; the `performance` study tier is the cheap look. */
const low: IWorldEnvironmentOptions = { ...high, renderChainTier: "low" };

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

/** One rung of the player's quality select. Every number is the reference study's own. */
export interface IStudyTier {
  /** The cloud pass renders at this share of the frame's resolution (the study's `q[1]`). */
  readonly cloudScale: number;
  /** Ray-march steps through the cloud volume (the study's `q[2]`). */
  readonly cloudSteps: number;
  /** Rain drops at full precipitation; the drawn count is this times the eased `rain`. */
  readonly rainBudget: number;
  /** Whether wet surfaces run the 36-step secondary reflection march. */
  readonly reflections: boolean;
}

/**
 * The four tiers the panel offers, cheapest first. The costs are **unmeasured** per stage on this
 * scene: `playtests/tiers.playtest.json` reads back what each tier actually draws, and
 * `TN_FRAME_BUDGET` is the frame-time reading to take after changing a rung.
 */
export const STUDY_TIERS: Readonly<Record<QualityName, IStudyTier>> = {
  // The phone rung: the cheapest clouds, a thinner rain and no reflection march (unmeasured).
  performance: { cloudScale: 0.4, cloudSteps: 32, rainBudget: 6_500, reflections: false },
  // Reflections back on; clouds a little finer (unmeasured).
  balanced: { cloudScale: 0.48, cloudSteps: 48, rainBudget: 12_000, reflections: true },
  // The desktop default the panel opens on (unmeasured).
  high: { cloudScale: 0.6, cloudSteps: 64, rainBudget: 12_000, reflections: true },
  // The finest clouds and the full 16,000 drops (unmeasured).
  ultra: { cloudScale: 0.75, cloudSteps: 88, rainBudget: 16_000, reflections: true },
};

/** A tier by name. Throws on a name the select does not offer, rather than drawing a default. */
export function studyTier(name: string): IStudyTier {
  const tier = STUDY_TIERS[name as QualityName];
  if (tier === undefined || !Object.hasOwn(STUDY_TIERS, name)) {
    throw new Error(
      `Unknown study tier ${JSON.stringify(name)} — expected performance, balanced, high or ultra.`,
    );
  }
  return tier;
}
