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
import type { IWorldEnvironmentOptions } from "./worldEnvironment.js";

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
  autoExposureEnabled: true,
  localExposureEnabled: true,
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
  vignetteAmount: 0.22,
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
  // Contact scale. Unreal's Lumen (L7 up) has no wide screen-space AO: its short-range AO is a thin line in every
  // corner, and the world cache already carries the room-scale occlusion. At 0.35 m the same GTAO darkened a band
  // about 30 px wide along every interior corner and under the sunlit patch (ablation, abl4 and abl5: gone with
  // GTAO off, thin and soft at 0.12). The L6 arm keeps Unreal's SSAO radius in Reference.ts.in.
  gtaoRadius: 0.12,
  // Epic: Unreal's screen probe gather (`sg.GlobalIlluminationQuality` 3). See `giPreset`.
  finalGatherMethod: "screenProbeGather",
  renderChainTier: "high",
  // Temporal AA is opt-in and no shipped tier names it: add `authoredStageNames: ["traa"]` here to
  // reconstruct at the display raster, and read `setupPost(...).debug().temporal` for the reset and
  // raster state it reports. Its rejection fraction, ghosting and frame-time cost are unqualified.
};

/**
 * The rung in between: the same occlusion at half the directions. Saving unmeasured, and the
 * chain's own antialiasing one notch cheaper.
 */
// SMAA owns medium edges; another four-sample world resolve adds mobile bandwidth.
const medium: IWorldEnvironmentOptions = {
  ...high,
  gtaoSamples: 8,
  // Medium: world-space probes only (`sg.GlobalIlluminationQuality` 1).
  finalGatherMethod: "irradianceField",
  renderChainTier: "medium",
  samples: 0,
};

/** What a phone gets: bloom, vignette and the tone curve, nothing screen-space. */
const low: IWorldEnvironmentOptions = {
  ...shared,
  // Low: no diffuse GI (`sg.GlobalIlluminationQuality` 0).
  finalGatherMethod: "none",
  renderChainTier: "low",
};

const QUALITY_PRESETS: Record<QualityTier, IWorldEnvironmentOptions> = { high, low, medium };

/**
 * This game's colour grade and grain, per tier. The table itself lives in `public/grade.cube` and
 * the maths in `grade.ts`; these are the four numbers the look is dialled with.
 *
 * **The grain default is 1/255, and that is the point.** `film()` scales its noise by
 * the pixel's own value, so on mid-grey concrete this moves a channel by well under half an 8-bit
 * step — below what the framebuffer can show. It shipped at 0.12, and a blind judge called the
 * result "grain clearly visible as speckle over sky and flat walls and behind HUD text". A default
 * must never degrade the look, so raise this number when you want the film look: 0.12 is a visible
 * grain, 0.3 a heavy one.
 *
 * A zero refuses its stage rather than running it at zero strength, so `low` — a phone, where a
 * moving grain is the first thing to go — reports `grain` as refused with its reason instead of
 * reading as applied. The grade survives there: it is one texture fetch and the frame is the
 * same frame without it. `high` keeps a non-zero grain on purpose, so `TN_RENDER_CHAIN` can still
 * name it as applied there rather than reporting the stage a default deliberately declined to run.
 */
const GRADE_PRESETS: Record<QualityTier, IGradeSettings> = {
  high: { gradeIntensity: 1, grainAnimated: true, grainIntensity: 0.0039, tier: "high" },
  medium: { gradeIntensity: 1, grainAnimated: false, grainIntensity: 0.0039, tier: "medium" },
  low: { gradeIntensity: 1, grainAnimated: false, grainIntensity: 0, tier: "low" },
};

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

/** The grade and grain a tier runs. Throws on a name that is not a tier, for the same reason. */
export function gradePreset(tier: string): IGradeSettings {
  const preset = GRADE_PRESETS[tier as QualityTier];
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

export {
  type IMaterialLightingEnvironment,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "./rendererGate.js";
