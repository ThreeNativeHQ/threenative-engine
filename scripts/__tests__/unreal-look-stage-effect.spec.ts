import { describe, expect, it } from "vitest";
import { compareEffects, effectMap } from "../unreal-look/stage-effect.js";

describe("stage effect", () => {
  it("is the log2 ratio of the frame with the stage over the frame without it", () => {
    const map = effectMap([0.2, 0.4, 0.1], [0.2, 0.2, 0.2]);
    expect(map[0]).toBeCloseTo(0, 6);
    expect(map[1]).toBeCloseTo(1, 2);
    expect(map[2]).toBeCloseTo(-1, 2);
  });

  it("scores two identical effects as a perfect match", () => {
    const effect = effectMap([0.1, 0.3, 0.5, 0.2], [0.2, 0.2, 0.2, 0.2]);
    const row = compareEffects(effect, effect);
    expect(row.mad).toBe(0);
    expect(row.corr).toBeCloseTo(1, 12);
    expect(row.tn).toBe(row.ue);
  });

  it("reports a half-strength stage as half the mean and a correlation of one", () => {
    const strong = Float64Array.from([0.2, 0.4, 0.6, 0.8]);
    const half = strong.map((v) => v / 2);
    const row = compareEffects(half, strong);
    expect(row.tn).toBeCloseTo(0.25, 12);
    expect(row.ue).toBeCloseTo(0.5, 12);
    expect(row.mad).toBeCloseTo(0.25, 12);
    expect(row.corr).toBeCloseTo(1, 12);
  });

  it("reports an effect with no spatial match as an uncorrelated map", () => {
    const row = compareEffects([1, -1, 1, -1], [1, 1, -1, -1]);
    expect(row.corr).toBeCloseTo(0, 12);
  });

  it("has no correlation to report for a flat map, and fails on a size mismatch or no pixels", () => {
    expect(compareEffects([0.3, 0.3, 0.3], [0.1, 0.2, 0.3]).corr).toBeNaN();
    expect(() => compareEffects([1, 2], [1])).toThrow(/STAGE_EFFECT_SIZE/u);
    expect(() => effectMap([1], [1, 2])).toThrow(/STAGE_EFFECT_SIZE/u);
    expect(() => compareEffects([], [])).toThrow(/STAGE_EFFECT_EMPTY/u);
  });
});
