import { type IProbeVolumeOptions, type IProbeVolumeTrace, ProbeVolume } from "./probe-volume.js";

export interface IRadianceCacheOptions extends Omit<IProbeVolumeOptions, "trace" | "update"> {
  /** The packed scene a probe traces, the sun and the sky it reads. Every value is the game's. */
  readonly trace: IProbeVolumeTrace;
}

/**
 * A probe field that refreshes by tracing the packed scene, Unreal's radiance-cache update model: probes in view
 * refresh first, the oldest first, a few hundred a frame at most, and the old values serve until replaced.
 * It is a `ProbeVolume` whose update is always `trace`; sample it with `sampleNode`.
 */
export class RadianceCache extends ProbeVolume {
  constructor(options: IRadianceCacheOptions) {
    super({ ...options, update: "trace" });
  }
}
