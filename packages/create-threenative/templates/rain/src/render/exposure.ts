// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // A dark storm is the look: a fully open meter lifts the overcast to a pale grey. It may open 0.8
  // stop and close two, so a lightning flash closes the eye and the gloom stays.
  maxStops: 0.8,
  minStops: -2,
};
