// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // The meter closes for the noon sun and opens at dusk, so the day cycle keeps its mood: a night
  // opens a little (two stops) and stays a night, instead of lifting to a grey afternoon.
  maxStops: 2,
  minStops: -2,
};
