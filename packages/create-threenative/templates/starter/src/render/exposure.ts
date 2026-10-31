// The core Unreal meter (key 0.36, +1 EV) is the default; edit this policy to override it for this game.
// The other starter kits meter at 0 EV through `kitExposure.ts` (PRD-747); the starter keeps stock Unreal
// (owner, 2026-10-31: "starter back to Unreal").
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = { ...coreExposureSettings };
