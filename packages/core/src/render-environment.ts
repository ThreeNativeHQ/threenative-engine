/**
 * The environment measure-and-sample mechanism every kit repeats: what the scene's environment
 * actually contributes, a bounded GPU sample of it with a cache and a readback deadline, the
 * provenance a stale readback is rejected by, and the gate that decides which renderer may run
 * the material lane. The backlight itself is a shader with fixed constants, so it stays in each
 * kit's `src/render/` (stamped from one source there) where the game can change how it looks.
 *
 * This is machinery, not a look: every colour, gain and threshold arrives as an argument, and a kit
 * that wants a different bound passes a different one. It lives here because twelve kits held
 * byte-identical copies — 9 084 lines — so a fix to one left eleven wrong with every gate green
 * (`c93b427d0` touched 552 files for one look change).
 *
 * @situation measure what a scene's environment actually contributes
 * @situation sample the environment on the GPU without stalling the frame
 * @situation keep an environment readback from reaching a frame it does not belong to
 */
export {
  type IEnvironmentMeasurement,
  measureEnvironment,
  reportEnvironmentContribution,
} from "./render/environment/environmentContribution.js";
export { sampledRadiance } from "./render/environment/environmentRadiance.js";
export {
  cacheEnvironmentSample,
  cachedEnvironmentSample,
} from "./render/environment/environmentSampleCache.js";
export {
  type IEnvironmentSample,
  sampleEnvironment,
} from "./render/environment/environmentSampling.js";
export {
  type IEnvironmentSourceSnapshot,
  captureEnvironmentSnapshot,
  environmentSnapshotCurrent,
  samplingSourceSupported,
} from "./render/environment/environmentSnapshot.js";
export {
  type IMaterialLightingEnvironment,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "./render/environment/gate.js";
