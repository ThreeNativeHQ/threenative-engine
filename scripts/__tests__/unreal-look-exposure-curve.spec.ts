import { describe, expect, it } from "vitest";
import { CURVE_GROUPS, exposureCurve } from "../unreal-look/exposureCurve.js";

/** 100 pixels with brightness 0.01 .. 1 in equal steps. */
const before = Float64Array.from({ length: 100 }, (_, i) => (i + 1) / 100);

describe("exposureCurve", () => {
  it("reads a global exposure as a flat curve", () => {
    const curve = exposureCurve(
      before,
      before.map((v) => v * 0.5),
    );
    expect(curve).toHaveLength(CURVE_GROUPS);
    for (const entry of curve) expect(entry).toBeCloseTo(-1, 6);
  });

  it("reads local exposure as a curve that falls from dark to bright", () => {
    // A pull toward 0.18 by a fifth of the distance in stops: dark pixels rise, bright ones fall.
    const pulled = before.map((v) => 2 ** (Math.log2(v) + 0.2 * (Math.log2(0.18) - Math.log2(v))));
    const curve = exposureCurve(before, pulled);
    expect(curve[0]).toBeGreaterThan(0.1);
    expect(curve[CURVE_GROUPS - 1]).toBeLessThan(-0.1);
    for (let i = 1; i < curve.length; i++)
      expect(curve[i] as number).toBeLessThan(curve[i - 1] as number);
  });

  it("skips pixels at the floor and refuses frames of different sizes", () => {
    const dark = new Float64Array(100).fill(0);
    expect(exposureCurve(dark, dark)).toEqual([]);
    expect(() => exposureCurve(before, new Float64Array(3))).toThrow("TN_EXPOSURE_CURVE");
  });
});
