// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // A pale dungeon under a bright sun: the meter may close down for the sunlit floor and open only a
  // little for the shaded walls, so shadows keep their depth instead of lifting to grey.
  maxStops: 0.3,
  minStops: -2,
};
