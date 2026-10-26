// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // A dark room lit by three lanterns: the meter would open about three stops on the black void and
  // turn the vault into a pale box. It may open half a stop and close two, so the lanterns stay the light.
  maxStops: 0.5,
  minStops: -2,
};
