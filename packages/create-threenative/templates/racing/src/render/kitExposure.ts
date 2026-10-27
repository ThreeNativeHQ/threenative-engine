// Generated for you. The starter kits share this meter; `pnpm stamp:template-render` copies it into
// each kit that ships it. Override it for one game in `exposure.ts`, not here.
//
// Core's meter is stock Unreal 5.8.3, exposure compensation +1 EV (key 0.36,
// r.DefaultFeature.AutoExposure.Bias 1.0, UE 5.8.3: Engine/Source/Runtime/Engine/Private/SceneView.cpp:196-199).
// The kits use 0 EV (key 0.18) instead. Their bright stylised scenes read pastel and veiled at
// +1 EV. At 0 EV a fresh Opus judge read IMPROVEMENT on 9 of 9 kits (PRD-747, 2026-10-26).
// The range keeps Unreal's -10..+20 EV100 window around the new key.
import {
  type IExposureSettings,
  exposureSettings as coreExposureSettings,
} from "@threenative/core";

const KEY = 0.18;
export const kitExposureSettings: Readonly<IExposureSettings> = {
  ...coreExposureSettings,
  key: KEY,
  minStops: Math.log2(KEY) - 20,
  maxStops: Math.log2(KEY) + 10,
};
