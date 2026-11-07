// Generated for you. Weak ownership and full provenance guard successful source estimates.
import type { Scene, Texture } from "three";
import type { IEnvironmentSample } from "./environmentSampling.js";
import { environmentSnapshotCurrent } from "./environmentSnapshot.js";
const samples = new WeakMap<object, WeakMap<Texture, IEnvironmentSample>>();
/**
 * The sample this renderer took of `scene`'s environment, if it is still current.
 *
 * @situation skip a second environment readback in the same frame
 * @constraint a sample whose source texture or intensity moved is dropped, so a stale one never reaches a material
 * @example const hit = cachedEnvironmentSample(renderer, scene);
 */
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
/**
 * Remembers `sample` as this renderer's reading of `scene`'s environment.
 *
 * @situation reuse one environment readback across the materials of a scene
 * @example cacheEnvironmentSample(renderer, scene, sample);
 */
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
