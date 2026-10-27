// The starter kits' shared meter (`kitExposure.ts`: core's Unreal meter at 0 EV) is the default;
// edit this policy to override it for this game.
import type { IExposureSettings } from "@threenative/core";
import { kitExposureSettings } from "./kitExposure.js";
export type { IExposureSettings } from "@threenative/core";
export const exposureSettings: Readonly<IExposureSettings> = { ...kitExposureSettings };
