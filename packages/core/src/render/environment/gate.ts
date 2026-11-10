/**
 * Which renderers may run the material-lighting lane, and whether a renderer is running three's
 * WebGL backend behind a WebGPU wrapper.
 *
 * Both questions are asked by the environment sampling mechanism beside this file, and both were
 * answered in each template's `quality.ts` — twelve copies of the same predicate, so a fix to one
 * left eleven kits admitting a renderer the fix refused. The tier they compare is the caller's, so
 * a game that wants a different admission rule passes its own tier; nothing here decides how
 * anything looks.
 */
import type { QualityTier } from "../../look/quality.js";

/** First admitted material lane: high desktop hardware WebGPU in the browser only. */
export interface IMaterialLightingEnvironment {
  readonly web: boolean;
  readonly rendererKind: string;
  readonly mobile?: boolean;
  readonly software?: boolean;
  readonly webglFallback?: boolean;
}

/**
 * Whether `tier` may run the material-lighting lane in `environment`.
 *
 * @situation decide whether this renderer is the admitted material lane
 * @constraint high tier, browser, hardware WebGPU, not mobile, not software, not a WebGL fallback
 * @example if (materialLightingEnabled("high", env)) lightMaterials();
 */
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

/**
 * Whether a `WebGPURenderer` wrapper is running three's WebGL backend behind it.
 *
 * @situation refuse a GPU-only lane on a WebGL fallback instead of drawing something wrong
 * @example if (isWebGLFallbackRenderer(renderer)) skipMaterialLane();
 */
export function isWebGLFallbackRenderer(renderer: unknown): boolean {
  if (renderer === null || typeof renderer !== "object") return false;
  const backend = Reflect.get(renderer, "backend");
  return (
    backend !== null &&
    typeof backend === "object" &&
    Reflect.get(backend, "isWebGLBackend") === true
  );
}
