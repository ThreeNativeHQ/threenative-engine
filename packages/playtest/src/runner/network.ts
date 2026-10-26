import type { IPlaytestNetworkProfile } from "../scenario/schema-base.js";

/** The CDP payload for a scenario's network profile; bytes per second, both directions. */
export interface INetworkEmulation {
  readonly connectionType: "cellular3g";
  readonly downloadThroughput: number;
  readonly latency: number;
  readonly offline: false;
  readonly uploadThroughput: number;
}

/** A plan is read in kilobits; CDP takes bytes per second. */
export function networkBytesPerSecond(downloadKbps: number): number {
  return (downloadKbps * 1000) / 8;
}

export function networkEmulation(profile: IPlaytestNetworkProfile): INetworkEmulation {
  const bytesPerSecond = networkBytesPerSecond(profile.downloadKbps);
  return {
    connectionType: "cellular3g",
    downloadThroughput: bytesPerSecond,
    latency: profile.latencyMs,
    offline: false,
    uploadThroughput: bytesPerSecond,
  };
}
