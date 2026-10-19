// Generated for you. Weak ownership and full provenance guard successful source estimates.
import type { Scene, Texture } from "three";
import type { IEnvironmentSample } from "./environmentSampling.js";
import { environmentSnapshotCurrent } from "./environmentSnapshot.js";
const samples = new WeakMap<object, WeakMap<Texture, IEnvironmentSample>>();
export function cachedEnvironmentSample(
  renderer: object,
  scene: Scene,
): IEnvironmentSample | undefined {
  if (scene.environment === null) return undefined;
  const sample = samples.get(renderer)?.get(scene.environment);
  return sample !== undefined && environmentSnapshotCurrent(scene, sample)
    ? copySample(sample)
    : undefined;
}
export function cacheEnvironmentSample(
  renderer: object,
  scene: Scene,
  sample: IEnvironmentSample,
): void {
  if (
    sample.source === null ||
    sample.measurement.status !== "measured" ||
    !environmentSnapshotCurrent(scene, sample)
  )
    return;
  let byTexture = samples.get(renderer);
  if (byTexture === undefined) {
    byTexture = new WeakMap();
    samples.set(renderer, byTexture);
  }
  byTexture.set(sample.source, copySample(sample));
}

function copySample(sample: IEnvironmentSample): IEnvironmentSample {
  return {
    ...sample,
    measurement: {
      ...sample.measurement,
      meanRGB: sample.measurement.meanRGB === null ? null : [...sample.measurement.meanRGB],
    },
  };
}
