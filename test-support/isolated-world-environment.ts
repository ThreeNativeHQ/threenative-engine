import {
  WorldEnvironment as CoreWorldEnvironment,
  type IWorldEnvironmentOptions,
} from "../packages/core/src/look/world-environment.js";
import { exposureSettings } from "../packages/create-threenative/template-assets/exposure.js";
export type {
  ChainStage,
  IWorldEnvironmentOptions,
  OutputRenderer,
} from "../packages/core/src/look/world-environment.js";

/** Stage-unit tests opt out of unrelated defaults so they exercise only their subject. */
export class WorldEnvironment extends CoreWorldEnvironment {
  constructor(options: IWorldEnvironmentOptions = {}) {
    super({
      autoExposureEnabled: false,
      bloomRadius: 0.5,
      bloomStrength: 0.7,
      bloomThreshold: 0.2,
      exposurePolicy: exposureSettings,
      finalGatherMethod: "none",
      gtaoEnabled: false,
      gtaoRadius: 0.25,
      gtaoIndirectOnly: false,
      localExposureEnabled: false,
      motionBlurEnabled: false,
      ssrEnabled: false,
      temporalAA: false,
      tonemapMode: "aces",
      unrealBloomEnabled: false,
      vignetteAmount: 0,
      ...options,
    });
  }
}
