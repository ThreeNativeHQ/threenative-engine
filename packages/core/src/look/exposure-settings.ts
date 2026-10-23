import { dot, float, vec2, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

export interface IExposureSettings {
  enabled: boolean;
  /** Middle-grey target; increase to brighten the metered subject. */
  key: number;
  /** Exposure limits in stops. Expand only if the scene needs more range. */
  minStops: number;
  maxStops: number;
  /**
   * Percent of metered weight, dark to bright, ignored at each end of the histogram.
   * Raise highPercent's gap (lower it) when a large bright backdrop still sets the exposure.
   */
  lowPercent: number;
  highPercent: number;
  /** Exponential response per second in log2 space. Up opens the eye; down squints. */
  rateUp: number;
  rateDown: number;
  /** Stop error where cut acceleration begins / reaches its authored maximum. */
  snapLo: number;
  snapHi: number;
  snapGain: number;
  /** Seed for known cuts. reset() without a value adopts the next measured target. */
  initialExposure: number;
  settleStops: number;
  /** Limit catch-up after a suspended frame, avoiding an unrequested cut. */
  maxDelta: number;
  /** Readback/marker cadence in seconds. Metering still runs on every drawn frame. */
  reportInterval: number;
}

// Unreal 5.8.3 project defaults (PRD-632; Engine/Source/Runtime/Engine/Private/Scene.cpp:494,
// :520 and SceneView.cpp:183-190): histogram metering that ignores the darkest and brightest
// 10%, mid grey 0.18 lifted by the +1 EV exposure bias (key 0.18 x 2^1), 3 stops/s brightening,
// 1 stop/s darkening. The meter averages log2 luminance (Engine/Shaders/Private/
// PostProcessHistogramCommon.ush, ComputeAverageLuminanceWithoutOutlier) and sets
// exposure = key / average (EyeAdaptationCommon in PostProcessEyeAdaptation.usf).
//
// The -10..+20 EV100 range clamps the average luminance to 2^-10..2^20 (the lens attenuation of
// 0.78 makes the luminance scale 1: PostProcessEyeAdaptation.cpp LuminanceMaxFromLensAttenuation),
// so the exposure, in stops, runs from log2(key) - 20 to log2(key) + 10.
const KEY = 0.36;
export const exposureSettings: Readonly<IExposureSettings> = {
  enabled: true,
  key: KEY,
  minStops: Math.log2(KEY) - 20,
  maxStops: Math.log2(KEY) + 10,
  lowPercent: 10,
  highPercent: 90,
  rateUp: 3,
  rateDown: 1,
  snapLo: 3,
  snapHi: 8,
  snapGain: 1,
  initialExposure: 1,
  settleStops: 0.25,
  maxDelta: 0.1,
  reportInterval: 0.5,
};

/**
 * Return weighted luminance and weight. The histogram's percent clip, not a clamp here, rejects
 * small bright sources. The upper bound only keeps a half-float overflow from poisoning a block.
 * Unreal weights red, green and blue equally by default (r.AutoExposure.LuminanceMethod 0, the
 * uniform weights in Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessEyeAdaptation.cpp
 * and CalculateEyeAdaptationLuminance in Engine/Shaders/Private/PostProcessHistogramCommon.ush),
 * not Rec. 709, so a blue sky meters brighter than it does with the Rec. 709 weights.
 */
export function exposureMeter(colour: Node<"vec4">, uv: Node<"vec2">): Node<"vec2"> {
  const luminance = dot(colour.rgb, vec3(1 / 3, 1 / 3, 1 / 3)).clamp(0.0001, 65504);
  // Unreal meters the whole view with weight 1 unless a meter mask texture is set
  // (EyeAdaptation_MeterMaskTexture, white by default); there is no bottom-of-frame preference.
  void uv;
  const weight = float(1);
  return vec2(luminance, weight);
}

/** Receives the clipped histogram's linear mean luminance. Change it if the game encodes RMS. */
export function exposureLuminance(mean: Node<"float">): Node<"float"> {
  return mean.max(0.0001);
}

export function validateExposureSettings(value: IExposureSettings): void {
  for (const key of Object.keys(exposureSettings) as (keyof IExposureSettings)[]) {
    if (key === "enabled") continue;
    const number = value[key];
    if (typeof number !== "number" || !Number.isFinite(Math.fround(number)))
      throw new Error(`Invalid exposure ${key}: expected a finite float32 number.`);
  }
  if (
    typeof value.enabled !== "boolean" ||
    Math.fround(value.key) <= 0 ||
    Math.fround(value.initialExposure) <= 0 ||
    value.rateUp < 0 ||
    value.rateDown < 0 ||
    value.snapLo < 0 ||
    value.snapHi <= value.snapLo ||
    value.snapGain < 0 ||
    value.snapGain > 1 ||
    value.lowPercent < 0 ||
    value.highPercent > 100 ||
    value.lowPercent >= value.highPercent ||
    value.minStops >= value.maxStops ||
    value.minStops < -126 ||
    value.maxStops > 126 ||
    value.settleStops < 0 ||
    value.maxDelta <= 0 ||
    value.reportInterval <= 0
  )
    throw new Error("Invalid exposure settings: check limits, rates and thresholds.");
}

/** Resize only the meter. The separate history targets always remain 1x1. */
export function exposureReductionSizes(width: number, height: number): [number, number][] {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error("Exposure drawing buffer dimensions must be positive integers.");
  const sizes: [number, number][] = [];
  let w = width;
  let h = height;
  do {
    w = Math.ceil(w / 4);
    h = Math.ceil(h / 4);
    sizes.push([w, h]);
  } while (w > 1 || h > 1);
  return sizes;
}
