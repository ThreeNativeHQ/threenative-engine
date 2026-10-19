// Generated for you: these controls and this metric are the game's look. Edit freely.
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

export const exposureSettings: Readonly<IExposureSettings> = {
  enabled: false, // Opt in after qualifying this game's bright and dark captures.
  key: 0.18,
  minStops: -12,
  maxStops: 12,
  lowPercent: 10,
  highPercent: 90,
  rateUp: 2,
  rateDown: 4,
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
 */
export function exposureMeter(colour: Node<"vec4">, uv: Node<"vec2">): Node<"vec2"> {
  const luminance = dot(colour.rgb, vec3(0.2126, 0.7152, 0.0722)).clamp(0.0001, 65504);
  // Larger bottom-of-frame preference favours ground over bright sky (WebGPU UV y is down).
  const weight = float(1).add(uv.y);
  return vec2(luminance.mul(weight), weight);
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
