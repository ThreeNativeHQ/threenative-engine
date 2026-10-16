import { describe, expect, it } from "vitest";
import { impostorDistanceForScale } from "../src/render/propStreaming.js";
import { LOD_BANDS } from "../src/render/props.js";

describe("streamed spruce terminal gates", () => {
  it("keeps the first terminal gate at least 150 scaled metres out for each variant", () => {
    const placements = [
      { asset: "spruce", variant: 0, scale: 0.5 },
      { asset: "spruce", variant: 1, scale: 1.5 },
    ];
    const scales = placements.map(({ scale }) => scale);
    const minimumByVariant = new Map([
      [0, scales[0] as number],
      [1, scales[1] as number],
    ]);
    const gates = [...minimumByVariant.values()].map((minimum) =>
      impostorDistanceForScale(minimum, LOD_BANDS.mid),
    );

    expect(gates[0] * (scales[0] as number)).toBeGreaterThanOrEqual(LOD_BANDS.far);
    expect(gates[1] * (scales[1] as number)).toBeGreaterThanOrEqual(LOD_BANDS.far);
    expect(gates[0]).toBeGreaterThan(LOD_BANDS.mid);
    expect(gates[1]).toBeGreaterThan(LOD_BANDS.mid);
    expect(placements).toHaveLength(2);
    expect(placements.map(({ scale }) => scale)).toEqual(scales);

    const multiLevelGates = [0.5, 2].map((minimum) =>
      impostorDistanceForScale(minimum, LOD_BANDS.far),
    );
    expect(multiLevelGates[0]).toBe(300);
    expect(multiLevelGates[0] * 0.5).toBe(LOD_BANDS.far);
    expect(multiLevelGates[1]).toBeGreaterThan(LOD_BANDS.far);
    expect(multiLevelGates[1] * 2).toBeGreaterThan(LOD_BANDS.far);
  });
});
