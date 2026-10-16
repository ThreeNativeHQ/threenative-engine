import { describe, expect, it } from "vitest";
import { impostorDistanceForScale } from "../src/render/propStreaming.js";
import { LOD_BANDS } from "../src/render/props.js";

describe("streamed spruce terminal gates", () => {
  it("keeps the first terminal gate at least 150 scaled metres out for each variant", () => {
    const placements = [
      { asset: "spruce", variant: 0, scale: 0.5 },
      { asset: "spruce", variant: 1, scale: 1.5 },
    ] as const;
    const scales = placements.map(({ scale }) => scale);
    const minimumByVariant = new Map([
      [0, placements[0].scale],
      [1, placements[1].scale],
    ]);
    expect(minimumByVariant.size).toBe(placements.length);
    const smallGate = impostorDistanceForScale(placements[0].scale, LOD_BANDS.mid);
    const largeGate = impostorDistanceForScale(placements[1].scale, LOD_BANDS.mid);

    expect(smallGate * placements[0].scale).toBeGreaterThanOrEqual(LOD_BANDS.far);
    expect(largeGate * placements[1].scale).toBeGreaterThanOrEqual(LOD_BANDS.far);
    expect(smallGate).toBeGreaterThan(LOD_BANDS.mid);
    expect(largeGate).toBeGreaterThan(LOD_BANDS.mid);
    expect(placements).toHaveLength(2);
    expect(placements.map(({ scale }) => scale)).toEqual(scales);

    const halfScaleGate = impostorDistanceForScale(0.5, LOD_BANDS.far);
    const doubleScaleGate = impostorDistanceForScale(2, LOD_BANDS.far);
    expect(halfScaleGate).toBe(300);
    expect(halfScaleGate * 0.5).toBe(LOD_BANDS.far);
    expect(doubleScaleGate).toBeGreaterThan(LOD_BANDS.far);
    expect(doubleScaleGate * 2).toBeGreaterThan(LOD_BANDS.far);
  });

  it("uses mirrored placement magnitude for the terminal distance and rejects zero or invalid scales", () => {
    expect(impostorDistanceForScale(-0.5, LOD_BANDS.far)).toBe(300);
    expect(() => impostorDistanceForScale(0, LOD_BANDS.far)).toThrow(
      "positive finite placement scale",
    );
    expect(() => impostorDistanceForScale(Number.NaN, LOD_BANDS.far)).toThrow(
      "positive finite placement scale",
    );
    expect(() => impostorDistanceForScale(Number.POSITIVE_INFINITY, LOD_BANDS.far)).toThrow(
      "positive finite placement scale",
    );
  });
});
