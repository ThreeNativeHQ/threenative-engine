import { describe, expect, it } from "vitest";
import {
  bloomKernel,
  bloomRadius,
  bloomSchedule,
  unrealBloomSettings,
} from "../unreal-look/scaffold/render/unrealBloom.js";

const SHAPE = -16.7;
const gauss = (x: number, radius: number): number => Math.exp(SHAPE * (x / radius) ** 2);

describe("Unreal reference bloom cost schedule", () => {
  it("blurs stage n on the 1/2^n level, widest first, with the Scene.cpp radii", () => {
    const schedule = bloomSchedule(1920, 1080);
    expect(schedule.map((s) => s.level)).toEqual([6, 5, 4, 3, 2, 1]);
    expect(schedule.map((s) => [s.width, s.height])).toEqual([
      [30, 17],
      [60, 34],
      [120, 68],
      [240, 135],
      [480, 270],
      [960, 540],
    ]);
    for (const s of schedule)
      expect(s.radius).toBeCloseTo(
        bloomRadius(s.width, unrealBloomSettings.sizes[s.level - 1] ?? 0),
      );
  });

  it("pairs two texels per bilinear tap (radius + 1 taps, not 2 * 31 + 1)", () => {
    expect(bloomSchedule(1920, 1080).map((s) => s.taps)).toEqual([32, 32, 25, 11, 11, 7]);
    // A tight stage at a small viewport needs a handful of taps, never the 63 of the old loop.
    expect(Math.max(...bloomSchedule(1280, 720).map((s) => s.taps))).toBeLessThanOrEqual(32);
    expect(bloomKernel(5.76)).toHaveLength(7);
  });

  it("sums to one and matches the full Gaussian once bilinear filtering reads each pair", () => {
    for (const radius of [0.0001, 1, 5.76, 9.6, 24, 31]) {
      const taps = bloomKernel(radius);
      expect(taps.reduce((sum, t) => sum + t.weight, 0)).toBeCloseTo(1, 9);
      const direct = directKernel(radius);
      const lerped = bilinearTexels(taps);
      for (const [x, w] of direct) expect(lerped.get(x) ?? 0).toBeCloseTo(w, 9);
    }
  });
});

/** The full 2R + 1 texel Gaussian, normalised. */
function directKernel(radius: number): Map<number, number> {
  const sigma = Math.max(radius, 1e-4);
  const reach = Math.min(Math.ceil(radius), 31);
  const texels = new Map<number, number>();
  for (let x = -reach; x <= reach; x++) texels.set(x, gauss(x, sigma));
  const total = [...texels.values()].reduce((sum, w) => sum + w, 0);
  return new Map([...texels].map(([x, w]) => [x, w / total]));
}

/** What bilinear filtering reads: a tap at n + f gives texel n weight (1 - f) and n + 1 weight f. */
function bilinearTexels(taps: readonly { offset: number; weight: number }[]): Map<number, number> {
  const texels = new Map<number, number>();
  for (const t of taps) {
    const n = Math.floor(t.offset);
    const f = t.offset - n;
    texels.set(n, (texels.get(n) ?? 0) + t.weight * (1 - f));
    texels.set(n + 1, (texels.get(n + 1) ?? 0) + t.weight * f);
  }
  return texels;
}
