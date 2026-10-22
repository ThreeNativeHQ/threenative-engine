import { describe, expect, it } from "vitest";
import { UnrealBloomNode } from "../../packages/create-threenative/template-assets/unrealBloom.js";

/** Scene.cpp Bloom1..6 Size, a percent of the stage's own image width, and BloomSizeScale. */
const SIZES = [0.3, 1, 2, 10, 30, 64];
const SIZE_SCALE = 4;

describe("Unreal bloom cost schedule", () => {
  it("blurs stage n on the 1/2^n level, widest first, with the Scene.cpp radii", () => {
    const schedule = UnrealBloomNode.schedule(1920, 1080);
    expect(schedule.map((s) => s.level)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(schedule.map((s) => [s.width, s.height])).toEqual([
      [30, 17],
      [60, 34],
      [120, 68],
      [240, 135],
      [480, 270],
      [960, 540],
    ]);
    // GetBlurRadius: width * size * scale / 100 / 2, at most the 31 texels of the unrolled loop.
    for (const s of schedule) {
      const radius = s.width * (SIZES[s.level - 1] ?? 0) * SIZE_SCALE * 0.01 * 0.5;
      expect(s.radius).toBeCloseTo(Math.min(Math.max(radius, 1e-4), 31));
    }
  });

  it("pairs two texels per bilinear tap (radius + 1 taps, not 2 * 31 + 1)", () => {
    expect(UnrealBloomNode.schedule(1920, 1080).map((s) => s.taps)).toEqual([
      32, 32, 25, 11, 11, 7,
    ]);
    // A tight stage at a small viewport needs a handful of taps, never the 63 of the old loop.
    expect(Math.max(...UnrealBloomNode.schedule(1280, 720).map((s) => s.taps))).toBeLessThanOrEqual(
      32,
    );
  });
});
