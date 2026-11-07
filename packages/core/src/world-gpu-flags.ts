/**
 * What a launch asks of the GPU path, read from the environment variable, the query string and the
 * global a test sets — the same three sources in the same order for every switch.
 *
 * These read the launch, so they belong with neither the renderer nor the kernel: a caller can ask
 * what a run would use without building a scene, and a test can pin the order the sources are read
 * in without a device.
 */
import { readLaunchFlag, readLaunchValues } from "./debug.js";

/** The launch flag. */
export const GPU_SCENE_FLAG = "TN_GPU_SCENE";

/**
 * Did this launch ask for `flag` to be **off**? The environment variable, the query string and the
 * global a test sets are the three ways one is asked, and `debug.ts` owns the rule that reads them
 * — see {@link readLaunchFlag}.
 */
function askedOff(flag: string, parameter: string, globalName: string): boolean {
  return readLaunchFlag({ environment: flag, global: globalName, query: parameter }, "off");
}

/**
 * Did this launch ask for `flag` to be **on**? The mirror of {@link askedOff}, for the switches
 * that are opt-in.
 */
function askedOn(flag: string, parameter: string, globalName: string): boolean {
  return readLaunchFlag({ environment: flag, global: globalName, query: parameter });
}

/**
 * Whether the GPU-driven main pass should run on this launch, on by default where the backend can.
 *
 * @situation debug a walk whose main pass culls and LOD-selects on the GPU
 * @constraint on unless a launch asks for the CPU path: `gpuScene: false`, `?tnGpuScene=0` or
 *   `TN_GPU_SCENE=0` turn it off, and a backend without compute, storage buffers and
 *   `drawIndexedIndirect` falls back on its own
 * @example WorldCells.load({ ...options, gpuScene: gpuSceneRequested() });
 *
 * Read the way `renderListValidationRequested` and `terrainValidationRequested` read their own: a
 * native launch sets the environment variable, a browser asks with the query string, and a test
 * sets the global. Measured on machinefall at 863f83258, so it flipped from opt-in to default.
 */
export function gpuSceneRequested(): boolean {
  return askedOff(GPU_SCENE_FLAG, "tnGpuScene", "__tnGpuScene") === false;
}

/** Did this launch ask the CPU path to grade levels from `follow`, the before arm of `lodFrom`? */
export function lodFromFollowRequested(): boolean {
  return askedOff("TN_LOD_FROM_CAMERA", "tnLodFromCamera", "__tnLodFromCamera");
}

/** The launch flag. */
export const BUNDLE_FLAG = "TN_BUNDLES";

/**
 * What this launch asked for about world draw bundles: `on`, `off`, or `default` when it said
 * nothing.
 *
 * @situation tell a run that set the option itself apart from one that took the default
 * @example WorldCells.load({ ...options, bundles: bundlesAsked() !== "off" });
 *
 * Read the way {@link gpuSceneRequested} reads its own: a native launch sets the environment
 * variable, a browser asks with the query string, and a test sets the global.
 */
export function bundlesAsked(): "default" | "off" | "on" {
  // Its own vocabulary over the one reader: a launch can answer yes, answer no, or say nothing, and
  // "said nothing" is what a caller has to tell apart from a measurement's default. Every seam is
  // heard, as it is for every other switch, so an explicit yes anywhere beats a no anywhere.
  const values = readLaunchValues({
    environment: BUNDLE_FLAG,
    global: "__tnBundles",
    query: "tnBundles",
  });
  if (values.some((value) => value === "1" || value === "true" || value === "")) return "on";
  return values.some((value) => value === "0" || value === "false") ? "off" : "default";
}

/**
 * Whether world draw bundles should be recorded and replayed. On by default, and off unless a launch
 * asks for the CPU path.
 *
 * @situation debug a walk whose main batches are replayed from a recorded bundle
 * @constraint on unless a launch asks otherwise: `bundles: false`, `?tnBundles=0` or `TN_BUNDLES=0`
 *   turn it off. The default followed a measurement, not a preference — PRD-494 AC-2 took the walking
 *   `draw` span from a 6.0 ms p50 median to 0.6 ms against develop over 3 interleaved runs, on a
 *   picture a blind world gate called equal, so the answer that used to be "off, it gave no CPU
 *   p50/p95 gain" is now "on, it is 5 ms of the walking p95". `bundles: true`, `?tnBundles=1` or
 *   `TN_BUNDLES=1` still say so explicitly. See PRD-473 phase 2 and PRD-494 phase 2.
 * @example WorldCells.load({ ...options, bundles: bundlesRequested() });
 */
export function bundlesRequested(): boolean {
  return bundlesAsked() !== "off";
}

/** The validation flag. */
export const GPU_SCENE_VALIDATE_FLAG = "TN_GPU_SCENE_VALIDATE";

/**
 * Whether the GPU scene should hold every dispatch's indirect args against the CPU reference.
 *
 * @situation find the keys a real WebGPU dispatch draws fewer instances of than `cullAndSelect` does
 * @constraint off by default and never on a measured walk: a readback is a queue submission and a
 *   mapped buffer, so the mode exists to answer "which key" and not to be fast
 * @example WorldCells.load({ ...options, gpuScene: true, gpuSceneValidate: gpuSceneValidationRequested() });
 *
 * Read the way `gpuSceneRequested` reads its own: a native launch sets the environment variable, a
 * browser asks with `?tnGpuSceneValidate=1`, and a test sets the global.
 */
export function gpuSceneValidationRequested(): boolean {
  return askedOn(GPU_SCENE_VALIDATE_FLAG, "tnGpuSceneValidate", "__tnGpuSceneValidate");
}

/** The launch flag. */
export const SHADOW_GPU_KEYS_FLAG = "TN_SHADOW_GPU_KEYS";

/**
 * Whether a shadow level may select its own set of GPU-scene keys. Opt-in, and off by default.
 *
 * @situation debug a walk whose shadow maps draw GPU-scene keys instead of cluster meshes
 * @constraint off unless a launch asks for it: without a provider nothing is allocated and no
 *   dispatch is submitted, so the flag alone cannot change a frame — `shadowGpuKeys: true`,
 *   `?tnShadowGpuKeys=1` or `TN_SHADOW_GPU_KEYS=1` turns it on. See PRD-478 phase 2.
 * @example world.gpuScene.shadowKeysFrom(() => keyNames);
 *
 * Read the way {@link bundlesRequested} reads its own: a native launch sets the environment
 * variable, a browser asks with the query string, and a test sets the global.
 */
export function shadowGpuKeysRequested(): boolean {
  return askedOn(SHADOW_GPU_KEYS_FLAG, "tnShadowGpuKeys", "__tnShadowGpuKeys");
}
