import { describe, expect, it } from "vitest";
import { BudgetLadder, type IBudgetLadderOptions } from "../src/render/budget-ladder.js";

type Level = "cheap" | "mid" | "full";
const LEVELS: readonly Level[] = ["cheap", "mid", "full"];
const PERIOD = 1000 / 60;
// Unreal's 10% headroom leaves a 15 ms target in the 16.67 ms period.

function ladder(overrides: Partial<IBudgetLadderOptions<Level>> = {}): BudgetLadder<Level> {
  return new BudgetLadder<Level>({
    framePeriodMs: PERIOD,
    levels: LEVELS,
    start: "full",
    windowFrames: 10,
    ...overrides,
  });
}

/** Feeds `frames` identical readings and returns the windows that closed. */
function feed(
  target: BudgetLadder<Level>,
  stageMs: number | undefined,
  frameMs: number | undefined,
  frames: number,
) {
  const windows = [];
  for (let i = 0; i < frames; i++) {
    const closed = target.observe(stageMs, frameMs);
    if (closed !== undefined) windows.push(closed);
  }
  return windows;
}

describe("BudgetLadder", () => {
  it("steps down once after 2 frames over the frame period when the stage could absorb the overage", () => {
    const target = ladder();
    const windows = feed(target, 8, 20, 2);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      level: "full",
      panic: true,
      stepped: "mid",
      verdict: "over",
      frames: 2,
    });
    expect(target.level).toBe("mid");
  });

  it("keeps its level when another stage made the frame slow", () => {
    // 30 ms frame, 0.5 ms of this stage: zero cost would not bring the frame under 15 ms.
    const target = ladder();
    const windows = feed(target, 0.5, 30, 60);
    expect(
      windows.every((w) => w.stepped === undefined && w.verdict === "over" && w.notBlamed),
    ).toBe(true);
    expect(target.level).toBe("full");
  });

  it("reads the frame, not the stage: one stage reading holds at boost and steps at P5", () => {
    // The same 8 ms of stage time: a 9 ms frame at boost is far inside the period, a 22 ms one is not.
    const boost = ladder();
    expect(feed(boost, 8, 9, 100).every((w) => w.stepped === undefined)).toBe(true);
    expect(boost.level).toBe("full");
    const p5 = ladder();
    expect(feed(p5, 8, 22, 2)[0]?.stepped).toBe("mid");
  });

  it("holds the level of a GPU that idles at P5 inside the period", () => {
    const target = ladder({ start: "mid" });
    const windows = feed(target, 3, 14.8, 200);
    expect(windows.every((w) => w.stepped === undefined && w.verdict === "within")).toBe(true);
    expect(target.level).toBe("mid");
  });

  it("holds 8 frames after a step before the next non-panic move", () => {
    const target = ladder();
    expect(feed(target, 8, 20, 2)[0]?.stepped).toBe("mid");
    // 16 ms is over the 15 ms target and inside the period: no panic, so the change period applies.
    const early = feed(target, 8, 16, 7);
    expect(early.every((w) => w.stepped === undefined)).toBe(true);
    expect(feed(target, 8, 16, 1)[0]?.stepped).toBe("cheap");
  });

  it("climbs when the frame has room, and reports it", () => {
    const target = ladder({ start: "mid" });
    const windows = feed(target, 2, 8, 8);
    expect(windows[0]).toMatchObject({ level: "mid", stepped: "full", verdict: "under" });
  });

  it("does not oscillate: a level that failed is retried after a longer wait each time", () => {
    const target = ladder({ retryFrames: 20, start: "mid", windowFrames: 5 });
    const costs: Record<Level, [number, number]> = { cheap: [0.5, 6], full: [12, 20], mid: [2, 4] };
    const climbs: number[] = [];
    for (let frame = 1; frame <= 400; frame++) {
      const before = target.level;
      const [stage, whole] = costs[target.level];
      target.observe(stage, whole);
      if (before !== "full" && target.level === "full") climbs.push(frame);
    }
    const gaps = climbs.slice(1).map((at, i) => at - (climbs[i] ?? 0));
    // Mid has room for full's 10 ms extra (4 + 10 ms), so only the wait stops it: without it the
    // ladder would climb every 10 frames (40 times in 400).
    expect(climbs.length).toBeLessThanOrEqual(6);
    expect(gaps.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1] ?? 0);
  });

  it("climbs again only when the frame has room for what the level cost when it failed", () => {
    const target = ladder({ retryFrames: 10, start: "mid" });
    expect(feed(target, 2, 8, 8)[0]?.stepped).toBe("full");
    // full reads 12 ms in a 20 ms frame: back to mid.
    expect(feed(target, 12, 20, 2)[0]).toMatchObject({ stepped: "mid", verdict: "over" });
    // After the wait, mid reads 2 ms in an 8 ms frame: 8 + (12 - 2) = 18 ms does not fit 15 ms.
    expect(feed(target, 2, 8, 60).every((w) => w.stepped === undefined)).toBe(true);
    expect(target.level).toBe("mid");
    // A 5 ms frame has room: 5 + 10 = 15 ms.
    expect(feed(target, 2, 5, 20).some((w) => w.stepped === "full")).toBe(true);
  });

  it("leaves an explicit level alone and says the frame is over", () => {
    const target = ladder({ explicit: true });
    const windows = feed(target, 8, 20, 10);
    expect(windows.at(-1)).toMatchObject({ explicit: true, stepped: undefined, verdict: "over" });
    expect(target.level).toBe("full");
  });

  it("holds at the cheapest level and reports it over", () => {
    const target = ladder({ start: "cheap" });
    expect(feed(target, 8, 20, 10).at(-1)).toMatchObject({ stepped: undefined, verdict: "over" });
  });

  it("calls a window without a resolved GPU time unobserved and never moves on it", () => {
    const target = ladder();
    const windows = feed(target, undefined, undefined, 10);
    expect(windows[0]).toMatchObject({ verdict: "unobserved", stepped: undefined, samples: 0 });
    expect(target.level).toBe("full");
  });

  it("fails closed on a malformed reading or option", () => {
    expect(() => ladder().observe(Number.NaN)).toThrow(RangeError);
    expect(() => ladder().observe(-1)).toThrow(RangeError);
    expect(() => ladder().observe(1, -1)).toThrow(RangeError);
    expect(() => ladder({ start: "nope" as Level })).toThrow(/start/);
    expect(() => ladder({ windowFrames: 0 })).toThrow(RangeError);
    expect(() => ladder({ levels: [] })).toThrow(/levels/);
    expect(() => ladder({ framePeriodMs: 0 })).toThrow(RangeError);
  });
});
