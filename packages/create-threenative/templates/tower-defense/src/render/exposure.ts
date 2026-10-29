// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // The board floats in a dark void: the meter may close down for the sun and open only a little, so
  // the void keeps its depth instead of the whole frame lifting to a pale green.
  maxStops: 0.3,
  minStops: -1,
};
