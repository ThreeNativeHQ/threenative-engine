/**
 * PRD-892 Phase 2 (desert): the desert kit's talus lies at the foot of a face, not on top of it, and
 * the flats carry a thin scatter of stone and dead wood.
 */
import { describe, expect, it } from "vitest";
import { desertDebris, talusWeight } from "../starter/desert/render/ground/debris.js";

/** A 128 m square: a flat floor at 0 m with a 30 m butte (a sheer step) over its west half. */
function butte() {
  const resolution = 65;
  const size = 128;
  const heights = new Float32Array(resolution * resolution);
  for (let r = 0; r < resolution; r++)
    for (let c = 0; c < resolution; c++) heights[r * resolution + c] = c < 20 ? 30 : 0;
  return { size, resolution, heights };
}

describe("the desert debris", () => {
  it("lays talus at the face's foot and none on the butte top or far out on the flat", () => {
    const ground = butte();
    const weight = talusWeight(ground);
    const row = 32 * ground.resolution;
    expect(weight[row + 22]).toBeGreaterThan(0.5); // 4 m below the face
    expect(weight[row + 10]).toBe(0); // on the butte top
    expect(weight[row + 50]).toBe(0); // 60 m out on the flat
  });

  it("scatters denser stone on the apron than on the flat, and dead wood on the flat", () => {
    const placements = desertDebris(butte());
    const near = placements.filter((p) => p.position[0] > -26 && p.position[0] < -16);
    const far = placements.filter((p) => p.position[0] > 20 && p.position[0] < 30);
    expect(near.length).toBeGreaterThan(far.length * 4);
    expect(placements.some((p) => p.asset === "deadfall")).toBe(true);
    expect(placements.some((p) => p.asset === "reveal")).toBe(true);
    expect(new Set(placements.map((p) => p.id)).size).toBe(placements.length);
  });
});
