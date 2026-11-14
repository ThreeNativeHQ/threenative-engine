import type { IPlacement } from "@threenative/terrain";
import { describe, expect, it } from "vitest";
import { FAR_FOREST_LAYER } from "../src/render/props/farForest.js";
import {
  LOD_BANDS,
  impostorDistanceForScale,
  spruceGateScales,
  variantFor,
} from "../src/render/props/props.js";

function placementFor(asset: string, id: string, scale: number, layer = "forest"): IPlacement {
  return {
    id,
    layer,
    asset,
    position: [0, 0, 0],
    rotation: 0,
    scale,
    normal: [0, 1, 0],
    alignToNormal: false,
  };
}

/** The `offset`th id the variant resolver puts on `variant`, so one variant is writable here. */
function idOnVariant(variant: number, offset: number): string {
  let found = 0;
  for (let index = 0; ; index += 1) {
    const id = `spruce:gate:${index}`;
    if (variantFor(placementFor("spruce", id, 1), "spruce") !== variant) continue;
    if (found === offset) return id;
    found += 1;
  }
}

describe("streamed spruce terminal gates", () => {
  it("keeps the first terminal gate at least 150 scaled metres out for each variant", () => {
    const smallest = placementFor("spruce", idOnVariant(0, 0), 0.5);
    const larger = placementFor("spruce", idOnVariant(0, 1), 1.5);
    const collar = placementFor("spruce", idOnVariant(0, 2), 0.25, FAR_FOREST_LAYER);
    const other = placementFor("spruce", idOnVariant(1, 0), 2);
    const placements = [
      { placement: smallest, scale: 0.5 },
      { placement: larger, scale: 1.5 },
      { placement: placementFor("grass", "grass:gate:0", 0.1), scale: 0.1 },
      { placement: other, scale: 2 },
      // A far-forest tree keeps its own gate; its scale must not shrink the square's.
      { placement: collar, scale: 0.25 },
    ];

    expect([...spruceGateScales(placements)]).toEqual([
      [`spruce:${variantFor(smallest, "spruce")}`, 0.5],
      [`spruce:${variantFor(other, "spruce")}`, 2],
    ]);

    const [entry] = spruceGateScales(placements);
    const minimum = entry?.[1] ?? Number.NaN;
    const gate = impostorDistanceForScale(minimum, LOD_BANDS.mid);
    expect(minimum * gate).toBeGreaterThanOrEqual(LOD_BANDS.far);
    expect(gate).toBeGreaterThan(LOD_BANDS.mid);
    expect(impostorDistanceForScale(2, LOD_BANDS.far)).toBeGreaterThan(LOD_BANDS.far);
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
