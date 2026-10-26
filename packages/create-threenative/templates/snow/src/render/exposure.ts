// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = { ...coreExposureSettings };

/**
 * Exposure compensation in stops over the meter's key, per weather (Unreal's Exposure
 * Compensation, which a post-process volume sets per place). A stock meter pulls a white
 * snowfield to middle grey, so clear weather opens up two stops, as a photographer does for snow.
 * Blizzard fog is uniform and already bright: the full bias there washes the explorer out, so the
 * storm takes none and meters the fog as the stock meter does.
 */
export const EXPOSURE_BIAS = { clear: 2, blizzard: 0 } as const;

/** Bias for the eased storm level (0 clear .. 1 blizzard), so a weather change never pops. */
export function exposureBias(storm: number): number {
  const t = Math.min(1, Math.max(0, storm));
  return EXPOSURE_BIAS.clear + (EXPOSURE_BIAS.blizzard - EXPOSURE_BIAS.clear) * t;
}
