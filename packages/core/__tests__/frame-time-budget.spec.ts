import { describe, expect, it } from "vitest";
import { FrameTimeBudget } from "../src/render/frame-time-budget.js";

const PERIOD = 1000 / 60;
// Unreal's headroom of 10% leaves a 15 ms target in a 16.67 ms period.

function budget(overrides: Partial<ConstructorParameters<typeof FrameTimeBudget>[0]> = {}) {
  return new FrameTimeBudget({ periodMs: PERIOD, ...overrides });
}

function feed(target: FrameTimeBudget, ms: number, frames: number) {
  const decisions = [];
  for (let i = 0; i < frames; i++) decisions.push(target.observe(ms));
  return decisions;
}

describe("FrameTimeBudget (UE 5.8.3 DynamicRenderScaling frame rule)", () => {
  it("drops after 2 frames over the period, not after 1", () => {
    const target = budget();
    feed(target, 10, 20);
    target.reset();
    // A reset starts the 8-frame change period: only a panic may drop before it ends.
    feed(target, 10, 3);
    expect(target.observe(20)).toMatchObject({ direction: "hold", panic: false });
    expect(target.observe(20)).toMatchObject({ direction: "down", panic: true });
  });

  it("holds the level of a GPU that idles at P5 inside the frame period", () => {
    // The same scene read 6.3 ms of SSGI at P5 and 2.1 ms at boost; the frame is what the rule reads.
    const target = budget();
    const decisions = feed(target, 14.8, 200);
    expect(decisions.every((d) => d.direction === "hold" && !d.panic)).toBe(true);
  });

  it("offers room to a frame well inside the target, and takes it back on a slow one", () => {
    const target = budget();
    expect(feed(target, 9, 8).map((d) => d.direction)).toEqual([
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "hold",
      "up",
    ]);
    const slow = budget();
    // 16 ms is over the 15 ms target but inside the 16.67 ms period: no panic, a drop after the period.
    expect(feed(slow, 16, 8).at(-1)).toMatchObject({ direction: "down", panic: false });
  });

  it("holds a change for 8 frames after the last one", () => {
    const target = budget();
    feed(target, 16, 8);
    target.reset();
    const directions = feed(target, 16, 8).map((d) => d.direction);
    expect(directions.slice(0, 7)).toEqual(Array(7).fill("hold"));
    expect(directions[7]).toBe("down");
  });

  it("weights the newest frame most and keeps 16 frames of history", () => {
    const target = budget();
    feed(target, 8, 16);
    // One 17 ms frame in 16 fast ones is a hitch, not a trend: no drop.
    expect(target.observe(17)).toMatchObject({ direction: "up", panic: false });
    // 16 frames later it is out of the history.
    feed(target, 8, 16);
    expect(target.observe(8).frames).toBe(16);
  });

  it("counts a frame without a GPU time toward the change period and reads no history from it", () => {
    const target = budget();
    for (let i = 0; i < 8; i++)
      expect(target.observe(undefined)).toMatchObject({ direction: "hold", frames: 0 });
    expect(target.observe(16)).toMatchObject({ direction: "down", frames: 1 });
  });

  it("uses a linear model for a throttle and a quadratic one for pixels", () => {
    // 15 / 16.2 = 0.926: quadratic sqrt gives 0.962, linear 0.926. Both drop, linear further.
    const a = feed(budget({ model: "quadratic" }), 16.2, 8).at(-1);
    const b = feed(budget({ model: "linear" }), 16.2, 8).at(-1);
    expect(a?.suggested).toBeGreaterThan(b?.suggested ?? 0);
  });

  it("fails closed on a malformed reading or option", () => {
    expect(() => budget().observe(Number.NaN)).toThrow(RangeError);
    expect(() => budget().observe(-1)).toThrow(RangeError);
    expect(() => budget({ periodMs: 0 })).toThrow(RangeError);
    expect(() => budget({ headroom: 1 })).toThrow(RangeError);
    expect(() => budget({ changeThreshold: 1 })).toThrow(RangeError);
  });
});
