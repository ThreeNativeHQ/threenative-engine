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
import type { IWorldEnvironmentOptions } from "./worldEnvironment.js";

/**
 * The three names this game's look comes in.
 *
 * `low` is what a phone gets and `high` what a desktop gets — those two are this template's
 * shipped looks, unchanged. `medium` is the rung in between for a machine that is neither: a
 * laptop iGPU, a handheld, a desktop that is dropping frames. Nothing outside this file decides
 * what any of them mean.
 */
export type QualityTier = "low" | "medium" | "high";

const QUALITY_TIERS: readonly QualityTier[] = ["low", "medium", "high"];

/**
 * Narrows an arbitrary string — a URL parameter, a saved setting — to a tier name. Not exported:
 * `resolveQualityTier` is the one door in, so an unknown name cannot be waved past the throw.
 */
function isQualityTier(value: string): value is QualityTier {
  return (QUALITY_TIERS as readonly string[]).includes(value);
}

/**
 * Where each GPU family starts, from `ctx.renderer.gpuClass`.
 *
 * A start, not a ceiling: the measured frame-budget windows move the look from here, and an
 * explicit `tier` above still wins. A class absent from this table — `unknown`, an adapter no
 * family rule matched — falls back to the `mobile` flag, exactly as before families existed.
 * Edit the right-hand side to change what a family looks like; nothing outside this file reads it.
 */
const START_TIER_BY_GPU_CLASS: Readonly<Record<string, QualityTier | undefined>> = {
  software: "low",
  "mobile-low": "low",
  "mobile-mid": "low",
  "mobile-high": "medium",
  integrated: "medium",
  discrete: "high",
};

/**
 * Picks the tier: an explicit `tier` always wins, otherwise the platform decides.
 *
 * Fails closed. An unrecognised tier name throws with the value it was handed rather than
 * quietly rendering the default, because a silent fallback here looks exactly like a tier that
 * turned out to have no effect.
 */
export function resolveQualityTier(
  request: {
    readonly gpuClass?: string;
    readonly mobile?: boolean;
    readonly software?: boolean;
    readonly tier?: string;
  } = {},
): QualityTier {
  const requested = request.tier;
  if (requested !== undefined) {
    if (!isQualityTier(requested)) {
      throw new Error(
        `Unknown quality tier ${JSON.stringify(requested)} — expected one of ${QUALITY_TIERS.join(", ")}.`,
      );
    }
    return requested;
  }
  // A named software adapter — SwiftShader, llvmpipe, a basic-render driver — is the machine this
  // game's desktop look cannot run on: a single `high` frame on one can outlast the device it is
  // drawing on, and no adaptation that reacts to frame times gets to run first. `software` is the
  // fact the renderer read from `adapter.info`, not a guess from a driver string, and an explicit
  // `tier` above still wins over it.
  if (request.software === true) return "low";
  const family =
    request.gpuClass === undefined ? undefined : START_TIER_BY_GPU_CLASS[request.gpuClass];
  if (family !== undefined) return family;
  return request.mobile === true ? "low" : "high";
}

/**
 * The look every tier shares: the tone curve, a corner falloff, and bloom over a high threshold.
 *
 * Bloom is the one stage this look cannot do without. Exactly two things in the vault emit — the
 * three lantern flames and the seal — and a threshold high enough to clear them and nothing lit
 * is what keeps the glow on the two warm sources and off the forty crates.
 */
const shared: IWorldEnvironmentOptions = {
  // ~4.6 ms in the ablation named above, at that scene's own strength.
  bloomEnabled: true,
  bloomRadius: 0.42,
  bloomStrength: 0.5,
  // High, on purpose: the lantern flames and the seal plate clear it and nothing lit does.
  bloomThreshold: 0.85,
  autoExposureEnabled: false,
  exposure: 1.06,
  tonemapMode: "aces",
  vignetteAmount: 0.34,
};

/**
 * What a desktop gets.
 *
 * Contact occlusion, because a pile of forty crates is nothing but contacts, and a sharpen pass,
 * because RCAS is what puts the edge back on the plank braces the occlusion pass softens.
 */
const high: IWorldEnvironmentOptions = {
  ...shared,
  // Unreal's default anti-aliasing is temporal (`r.AntiAliasingMethod` 4). The engine jitters the camera, draws the motion
  // and blends the frames; `temporalAA: false` brings back the chain's SMAA, which is what `low` and three.js keep.
  temporalAA: true,
  // Contact scale, in metres. A crate is 0.92 m, so half a metre gathers the crease where two
  // crates meet and the shadow where one meets the floor, and no further.
  // unmeasured in that ablation — it is not one of the five stages it measured.
  gtaoEnabled: true,
  gtaoRadius: 0.5,
  gtaoResolutionScale: 0.5,
  gtaoSamples: 12,
  gtaoScale: 1.25,
  // unmeasured in that ablation, as with GTAO. RCAS is a radius: 0.95 is nearly full sharpening.
  sharpenEnabled: true,
  sharpenStrength: 0.95,
};

/** A machine between the two: the same look with a cheaper occlusion gather. */
const medium: IWorldEnvironmentOptions = {
  ...shared,
  // Unreal's default anti-aliasing is temporal (`r.AntiAliasingMethod` 4). The engine jitters the camera, draws the motion
  // and blends the frames; `temporalAA: false` brings back the chain's SMAA, which is what `low` and three.js keep.
  temporalAA: true,
  // The chain's own quality tier: without it the renderer keeps its `high` default at this tier.
  renderChainTier: "medium",
  bloomRadius: 0.38,
  bloomStrength: 0.56,
  bloomThreshold: 0.84,
  exposure: 1.05,
  // unmeasured, as at `high`; this tier is the same gather at fewer samples.
  gtaoEnabled: true,
  gtaoRadius: 0.45,
  gtaoResolutionScale: 0.4,
  gtaoSamples: 8,
  gtaoScale: 1.2,
  sharpenEnabled: false,
  vignetteAmount: 0.3,
};

/**
 * What a phone gets: bloom and a vignette, no screen-space gather at all. The occlusion is the
 * first thing to go — forty simulated bodies are already the frame's budget on a phone.
 */
const low: IWorldEnvironmentOptions = {
  // The chain's own quality tier, separate from which stages this preset enables: without it
  // the renderer keeps its `high` default at every tier, so a CPU adapter's low preset still
  // paid for the high chain's denoise and slice counts.
  renderChainTier: "low",
  // ~4.6 ms in the ablation named above, at that scene's own strength.
  bloomEnabled: true,
  bloomRadius: 0.32,
  bloomStrength: 0.48,
  bloomThreshold: 0.86,
  exposure: 1.04,
  gtaoEnabled: false,
  sharpenEnabled: false,
  vignetteAmount: 0.28,
};

const QUALITY_PRESETS: Record<QualityTier, IWorldEnvironmentOptions> = { high, low, medium };

/** The stages and strengths a tier turns on. Throws on a name that is not a tier. */
export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  const preset = QUALITY_PRESETS[tier as QualityTier];
  if (preset === undefined) {
    throw new Error(
      `Unknown quality tier ${JSON.stringify(tier)} — expected one of ${QUALITY_TIERS.join(", ")}.`,
    );
  }
  return preset;
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
