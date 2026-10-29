// The quality tiers of the Unreal 5.8.3 look (owner exception to "never own the look", 2026-10-22): what each tier
// turns on, and the GI and shadow settings per tier named after Unreal's scalability levels. A `WorldEnvironment`
// built with no options starts from the `high` tier; an explicit option always wins.
import type { IWorldEnvironmentOptions } from "./world-environment.js";

/**
 * This game's authored looks. GPU family picks the start; measured frame budgets refine it.
 * Edit these presets to change the look without changing the framework.
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
 * The look every tier shares: a wide, faint glow on what is genuinely brighter than white — the
 * sun disk, the visor — rather than a haze over the frame (a threshold under 1 blooms lit grey
 * platforms and flattens contrast), a corner falloff, and the shared chain's SMAA. Antialiasing is
 * on in every tier that installs a chain; see `screenSpaceAA` in `worldEnvironment.ts`.
 *
 * No screen-space reflections and no sharpen here, on purpose. Every surface already reflects the
 * captured sky (`sky.ts`), and SSR on rough floors traced speckle into the grid; RCAS then rang the
 * smooth sky gradient into visible bands. Both are one line to turn back on for a glossy scene.
 */
const shared: IWorldEnvironmentOptions = {
  // Unreal's metered auto exposure. Cost: unmeasured on its own; read `TN_FRAME_BUDGET`.
  autoExposureEnabled: true,
  // Unreal's local exposure (a bilateral grid). Cost: unmeasured on its own; read `TN_FRAME_BUDGET`.
  localExposureEnabled: true,
  // Unreal's six-stage bloom. Cost: unmeasured on its own; read `TN_FRAME_BUDGET`.
  unrealBloomEnabled: true,
  // Bloom cost: ~4.6 ms in the reference ablation — the second most expensive stage there.
  bloomEnabled: true,
  bloomRadius: 0.6,
  bloomStrength: 0.22,
  bloomThreshold: 1,
  // Unreal's fixed exposure scale is 1.0: its scene-linear EXR passed through the filmic curve alone
  // reproduces its PNG (mean error 0.4/255 over 72000 pixels, L1 and L2). Light units, not this
  // number, set the level: the sun is 6 lux (`atmosphere.ts`). With auto exposure on this is only
  // the value used while the meter is off.
  exposure: 1,
  tonemapMode: "filmic",
  // Unreal's VignetteIntensity, cosine-fourth law (Scene.cpp, FPostProcessSettings constructor).
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
  // GTAO, full resolution plus denoise: unmeasured on its own here; read `TN_FRAME_BUDGET`.
  gtaoEnabled: true,
  // Contact scale. Unreal's Lumen (L7 up) has no wide screen-space AO: its short-range AO searches 32 px of the screen
  // (aoReach.ts), so the radius is left to that rule. At a fixed 0.35 m the same GTAO darkened a band about 30 px wide
  // along every interior corner and under the sunlit patch. The L6 arm keeps Unreal's SSAO radius in Reference.ts.in.
  // Its steps sit at the squared fraction of the reach (`gtaoDistanceExponent` 2), 3 steps per direction
  // (`gtaoSamples` 7: three directions, the node's count below 30 samples; Unreal takes 2 slices of 3 steps).
  gtaoDistanceExponent: 2,
  gtaoSamples: 7,
  // Unreal weighs every step alike: the horizon is the largest over the steps (LumenScreenSpaceBentNormal.usf:271),
  // with no 2 / (step + 2) falloff. The node's falloff narrowed the contact band to about 8 px against Unreal's 13.
  gtaoDistanceFalloff: 0,
  // Epic: Unreal's screen probe gather (`sg.GlobalIlluminationQuality` 3). See `giPreset`.
  finalGatherMethod: "screenProbeGather",
  renderChainTier: "high",
  // Sharp in motion over Unreal's desktop defaults (owner, 2026-10-28: "as if things briefly lost definition"). Unreal
  // turns camera motion blur on for a high end PC (HardwareTargetingModule.cpp) and resolves edges temporally
  // (`r.AntiAliasingMethod` 4, SceneView.cpp:236-246); both soften anything that moves. This tier draws 4x MSAA,
  // Unreal's own forward and mobile default (`r.MSAACount` 4), with no blur. `temporalAA: true` (the `traa` stage;
  // `setupPost(...).debug().temporal` reads it) and `motionBlurEnabled: true` are the named opt-ins, for a scene whose
  // foliage, specular or stochastic effects shimmer without temporal averaging.
  motionBlurEnabled: false,
  samples: 4,
  temporalAA: false,
};

/**
 * The rung in between: the same occlusion, and the chain's own antialiasing one notch cheaper.
 */
// Medium keeps the chain's SMAA: a four-sample world resolve adds mobile bandwidth.
const medium: IWorldEnvironmentOptions = {
  ...high,
  // Medium: world-space probes only (`sg.GlobalIlluminationQuality` 1).
  finalGatherMethod: "irradianceField",
  // Unreal's Medium spends less on AO than Epic: AmbientOcclusionMaxQuality 60 against 100 (BaseScalability.ini:590,
  // :625), so its SSAO runs 2 levels, the second at half resolution (PostProcessAmbientOcclusion.cpp:243-270). This
  // tier gathers its occlusion at half resolution: Iris Xe, Hop Garden 1080p, GPU 28.8 -> 25.0 ms.
  gtaoResolutionScale: 0.5,
  renderChainTier: "medium",
  samples: 0,
};

/**
 * What a phone gets: bloom, vignette and the tone curve, nothing screen-space. Unreal's default device profile turns
 * local exposure off on mobile (BaseDeviceProfiles.ini), so this does too. Its edges stay on SMAA: the temporal pass
 * costs a velocity target and a history target, and no phone has been measured with it.
 */
const low: IWorldEnvironmentOptions = {
  ...shared,
  // Low: no diffuse GI (`sg.GlobalIlluminationQuality` 0).
  finalGatherMethod: "none",
  localExposureEnabled: false,
  renderChainTier: "low",
};

const QUALITY_PRESETS: Record<QualityTier, IWorldEnvironmentOptions> = { high, low, medium };

/**
 * Harness: the screen-space gather Unreal's L7 (Epic) is judged against: 32 rays a pixel at half resolution, denoised
 * over 16 gather pixels. A calibration tool, not a shipping tier (PRD-640 Phase 1: about 31 ms at 1080p). Every harness
 * scene that renders global illumination spreads it, so no scene falls back to the `high` preset's 2-slice gather.
 */
export const EPIC_SSGI: IWorldEnvironmentOptions = {
  ssgiDenoiseRadius: 16,
  ssgiQuality: "epic",
  ssgiResolutionScale: 0.5,
};

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

/**
 * Global illumination and shadow filtering per tier, named after Unreal's scalability levels
 * (Engine/Config/BaseScalability.ini, `[GlobalIlluminationQuality@0..3]` and `[ShadowQuality@0..3]`).
 * A fresh Unreal project runs Epic (3), so `high` is Epic; `medium` is level 1 and `low` is level 0.
 * Unreal's own level 2 (High) is not a ThreeNative tier: the three tiers are the three levels a
 * calibration scene is judged against (PRD-644, PRD-652).
 */
export type FinalGatherMethod = "none" | "irradianceField" | "screenProbeGather";

export interface IGiTier {
  /**
   * How bounce light reaches a pixel. `none` is Unreal's Low: no diffuse GI, the sky light at 0.8.
   * `irradianceField` is Medium: world-space probes only (the baked cache here). `screenProbeGather`
   * is Epic: the screen-space gather over the same cache. The preset of the tier names it.
   */
  readonly finalGatherMethod: FinalGatherMethod;
  /** Read-only report: the `sg.GlobalIlluminationQuality` this tier follows. */
  readonly globalIlluminationQuality: 0 | 1 | 3;
  /**
   * `r.DistanceFieldAO`: whether the scene's distance fields shadow the sky light. Unreal's Low turns it off, so
   * the sky light reaches the inside of a room unoccluded (measured on `sunlit-room`, PRD-644 `## Decisions`).
   */
  readonly distanceFieldAO: boolean;
  /** `r.SkylightIntensityMultiplier`: Unreal suppresses the sky light to 0.8 at Low, where DFAO is off. */
  readonly skylightIntensityMultiplier: number;
}

/** What each method's Unreal level sets (BaseScalability.ini `[GlobalIlluminationQuality@n]`, lines 318-460). */
const GI_LEVELS: Record<FinalGatherMethod, Omit<IGiTier, "finalGatherMethod">> = {
  irradianceField: {
    distanceFieldAO: true,
    globalIlluminationQuality: 1,
    skylightIntensityMultiplier: 1,
  },
  none: { distanceFieldAO: false, globalIlluminationQuality: 0, skylightIntensityMultiplier: 0.8 },
  screenProbeGather: {
    distanceFieldAO: true,
    globalIlluminationQuality: 3,
    skylightIntensityMultiplier: 1,
  },
};

/** The GI method and Unreal level of a tier. Throws on a name that is not a tier. */
export function giPreset(tier: string): IGiTier {
  const finalGatherMethod = qualityPreset(tier).finalGatherMethod as FinalGatherMethod;
  return { finalGatherMethod, ...GI_LEVELS[finalGatherMethod] };
}

export interface IShadowFilter {
  readonly blockerSamples: number;
  readonly filterSamples: number;
}

export interface IShadowTier {
  /** Read-only report: the `sg.ShadowQuality` this tier follows. */
  readonly shadowQuality: 0 | 1 | 3;
  /**
   * Whether the sun and the lamps cast dynamic shadows. Unreal draws none at `sg.ShadowQuality` 0
   * (`r.ShadowQuality=0`), measured on `penumbra-lab` (PRD-652 `## Decisions`), so `low` casts none.
   */
  readonly castShadows: boolean;
  /**
   * The receiver filter taps of the sun and of every lamp: Unreal's directional and local ray counts
   * are equal at Medium and Epic, so one pair serves both.
   */
  readonly filter: IShadowFilter;
  /** `r.Shadow.Virtual.ResolutionLodBiasDirectional`: -1 halves the finest sun level's texel. */
  readonly resolutionLodBiasDirectional: number;
}

// Sample counts start from Unreal's rays x samples product against Epic's 32, on the filter's own
// 16 + 16 default: Medium (4 x 2 = 8) is a quarter of Epic, so 4 + 4. The penumbra-lab round
// (PRD-647 method) sets the final numbers; they are not fitted by eye. `low` draws no shadow, so its
// taps are never read.
const SHADOW_TIERS: Record<QualityTier, IShadowTier> = {
  high: {
    castShadows: true,
    filter: { blockerSamples: 16, filterSamples: 16 },
    // Unreal Epic sets -1.5 (`[ShadowQuality@3]`). Held at 0: -1.5 changes `sun4-ramp` and no judge has called it
    // an improvement, so `high` stays the pre-change look (PRD-652 `## Decisions`). `?shadowBias=` brackets it.
    resolutionLodBiasDirectional: 0,
    shadowQuality: 3,
  },
  low: {
    castShadows: false,
    filter: { blockerSamples: 4, filterSamples: 4 },
    resolutionLodBiasDirectional: 0,
    shadowQuality: 0,
  },
  medium: {
    castShadows: true,
    filter: { blockerSamples: 4, filterSamples: 4 },
    resolutionLodBiasDirectional: 0,
    shadowQuality: 1,
  },
};

/** The shadow filter and resolution bias of a tier. Throws on a name that is not a tier. */
export function shadowPreset(tier: string): IShadowTier {
  const preset = SHADOW_TIERS[tier as QualityTier];
  if (preset === undefined) {
    throw new Error(
      `Unknown quality tier ${JSON.stringify(tier)} — expected one of ${QUALITY_TIERS.join(", ")}.`,
    );
  }
  return preset;
}

/** The tier tables as one object: `resolve` a start tier from a GPU class, `gi` and `shadow` settings of a tier. */
export const qualityTiers = {
  // UE 5.8.3 BaseScalability.ini:37, snapped to the resolution scaler's rungs; low has no temporal resolve.
  resolutionScale: { low: 1, medium: 0.72, high: 0.85 },
  gi: giPreset,
  resolve: resolveQualityTier,
  shadow: shadowPreset,
} as const;
