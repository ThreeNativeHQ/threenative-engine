// The core Unreal meter is the default; edit this policy to override it for this game.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  // A pale town: core's 0.36 drains the sunlit reds and blues and veils the under-deck lanes, and
  // 0.20 or 0.27 still does (PRD-746 judge, 2026-10-26). The stock meter range needs no clamp.
  key: 0.14,
};
