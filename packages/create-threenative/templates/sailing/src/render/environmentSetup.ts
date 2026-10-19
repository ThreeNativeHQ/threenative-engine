// Generated for you. Sample the loaded photograph without adding a duplicate sky to the game.
import { Mesh, Scene } from "three";
import { type IEnvironmentSample, sampleEnvironment } from "./environmentSampling.js";
import type { IMaterialLightingEnvironment } from "./quality.js";
import { setupSky } from "./sky.js";
let sample: IEnvironmentSample | undefined;
export const loadedEnvironmentSample = (): IEnvironmentSample | undefined => sample;
export async function prepareEnvironmentSample(
  renderer: unknown,
  environment: IMaterialLightingEnvironment,
): Promise<void> {
  const scratch = new Scene();
  setupSky(scratch, { software: environment.software });
  try {
    sample = await sampleEnvironment(renderer, scratch, environment);
  } finally {
    scratch.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      object.geometry.dispose();
      for (const material of Array.isArray(object.material) ? object.material : [object.material])
        material.dispose();
    });
  }
}
