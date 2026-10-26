// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // A pale town: a lower middle-grey target keeps the sunlit street on the filmic shoulder instead
  // of at white, and lets the sky and the shade keep their colour.
  key: 0.14,
  // The street is a bright exterior with dark under-deck lanes. The meter may close down for the sun
  // and open at most half a stop, so a lane never blows the street out to flat white.
  maxStops: 0.5,
  minStops: -2,
};
