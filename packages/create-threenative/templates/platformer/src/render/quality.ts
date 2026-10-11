// Generated for you: ordinary Three.js; ThreeNative does not read this file. Delete or rewrite
// it freely — the tiers below are a starting point, not a framework look.
//
// This is the one place this game decides how expensive it looks. `postprocessing.ts` reads
// `qualityPreset(resolveQualityTier(...))` and nothing else, so "make it run on a phone" is one
// file to edit rather than a hunt through anonymous literals.
//
// **Every millisecond here is a reading, and every gap says so.** The figures come from the
// per-stage ablation recorded in the engine repository's `docs/verification/runtime-perf-state.md`
// (Chrome on an RTX 2080, 1600x900, static build, `gpuMs` from three's `timestamp-query`), where
// the whole five-stage chain costs 12.5 ms of a 14.7 ms frame and the same frame with every stage
// off costs 2.2 ms. The per-stage figures oversum — removing SSGI also removes the denoise passes
// the later stages sample — so read each as *what turning this one off gave back*, not as a share
// of a partition. A stage nobody has ablated on its own says `unmeasured` rather than guessing.
//
// One cost that is **not** a stage here and outweighs most of them: the prefiltered reflection
// probe on `scene.environment`, measured at ~6.3 ms of an 18-19 ms Pixel 8 frame. It is set in
// `sky.ts`, not in this file.
//
// This level is bright: a photograph sky at full range, ~2,300 small meshes, one sun and no
// screen-space colour work. `playtests/performance.playtest.json` is the proof of the numbers
// below — read `TN_FRAME_BUDGET` back after you change a tier rather than trusting these.
import type { IWorldEnvironmentOptions } from "./worldEnvironment.js";

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
 * The look every tier shares: a narrow bloom on what is genuinely brighter than white — the gold
 * coins, the goal star — rather than a haze over the frame, a filmic curve so the photographed
 * sky's own highlights stay highlights, and a corner falloff that frames the route.
 */
const shared: IWorldEnvironmentOptions = {
  // Bloom: ~4.6 ms in the reference ablation — the second most expensive stage there. The
  // threshold sits at 1 so only the gold and the specular hit it, never the pale stone.
  bloomEnabled: true,
  bloomRadius: 0.5,
  bloomStrength: 0.18,
  bloomThreshold: 1,
  // The sky photograph arrives at 2.5x, so the curve and the exposure below are what bring it
  // back to a daylight frame instead of a white one.
  autoExposureEnabled: false,
  exposure: 0.6,
  tonemapMode: "aces",
  vignetteAmount: 0.2,
};

/**
 * What a desktop gets on top: contact occlusion — the dark line where a foot meets the ground and
 * a cliff meets the sky, which is most of what separates "objects in a world" from "objects
 * pasted on a background". Gathered at full resolution and denoised; at half, the upsample left
 * grain around every grass tuft.
 */
const high: IWorldEnvironmentOptions = {
  ...shared,
  // GTAO, full resolution plus denoise: unmeasured on its own here; read `TN_FRAME_BUDGET`.
  gtaoEnabled: true,
  gtaoRadius: 0.4,
};

/** The rung in between: the same occlusion at half the directions. Saving unmeasured. */
const medium: IWorldEnvironmentOptions = { ...high, gtaoSamples: 8, renderChainTier: "medium" };

/**
 * What a phone gets: the curve, the narrow bloom and the vignette, nothing screen-space. On a
 * 2,300-mesh level the per-object cost of GTAO is the part that does not scale down, so this tier
 * drops it rather than the effects on top of it.
 */
const low: IWorldEnvironmentOptions = { ...shared, renderChainTier: "low" };

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
