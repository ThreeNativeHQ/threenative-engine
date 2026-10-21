import { describe, expect, it } from "vitest";
import { withMathUtilsExtras } from "../src/math-utils.js";

class EngineMathUtils {
  clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
}

describe("MathUtils extras", () => {
  it("adds three's number-only functions to the engine class, which games call by name", () => {
    const MathUtils = new (withMathUtilsExtras(EngineMathUtils))() as EngineMathUtils &
      Record<string, (...a: number[]) => number>;
    expect(MathUtils.clamp?.(5, 0, 1)).toBe(1);
    expect(MathUtils.damp?.(0, 10, 8, 0.1)).toBeCloseTo(10 * (1 - Math.exp(-0.8)), 12);
    expect(MathUtils.inverseLerp?.(2, 4, 3)).toBe(0.5);
    expect(MathUtils.inverseLerp?.(2, 2, 3)).toBe(0);
    expect(MathUtils.mapLinear?.(5, 0, 10, 100, 200)).toBe(150);
    expect(MathUtils.smoothstep?.(0.5, 0, 1)).toBe(0.5);
    expect(MathUtils.pingpong?.(3, 2)).toBe(1);
    expect(MathUtils.radToDeg?.(Math.PI)).toBe(180);
    expect(MathUtils.isPowerOfTwo?.(64)).toBe(true);
    expect(MathUtils.ceilPowerOfTwo?.(5)).toBe(8);
    expect(MathUtils.floorPowerOfTwo?.(5)).toBe(4);
    expect((MathUtils as unknown as { RAD2DEG: number }).RAD2DEG).toBe(180 / Math.PI);
    expect(MathUtils.seededRandom?.(1)).toBe(MathUtils.seededRandom?.(1));
  });
});
