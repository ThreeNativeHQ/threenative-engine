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
import {
  type IWorldEnvironmentOptions,
  qualityPreset as coreQualityPreset,
  qualityTiers,
} from "@threenative/core";
import { exposureSettings } from "./exposure.js";
export type { QualityTier } from "@threenative/core";
import type { QualityTier } from "@threenative/core";

export const resolveQualityTier = qualityTiers.resolve;

export function qualityPreset(tier: string): IWorldEnvironmentOptions {
  return { ...coreQualityPreset(tier), exposurePolicy: exposureSettings };
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
