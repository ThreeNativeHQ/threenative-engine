import { describe, expect, it } from "vitest";
import { networkBytesPerSecond, networkEmulation } from "../src/runner/network.js";

describe("playtest network profile", () => {
  it("should convert kilobits per second to bytes per second", () => {
    expect(networkBytesPerSecond(20_000)).toBe(2_500_000);
    expect(networkBytesPerSecond(1_000)).toBe(125_000);
  });

  it("should build the CDP payload the runner sends", () => {
    expect(networkEmulation({ downloadKbps: 20_000, latencyMs: 40 })).toEqual({
      connectionType: "cellular3g",
      downloadThroughput: 2_500_000,
      latency: 40,
      offline: false,
      uploadThroughput: 2_500_000,
    });
  });
});
