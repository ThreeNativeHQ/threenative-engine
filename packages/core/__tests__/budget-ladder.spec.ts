import { describe, expect, it } from "vitest";
import { BudgetLadder, type IBudgetLadderOptions } from "../src/render/budget-ladder.js";

type Level = "cheap" | "mid" | "full";
const LEVELS: readonly Level[] = ["cheap", "mid", "full"];
const BUDGET: Record<Level, number> = { cheap: 1, mid: 3, full: 6 };

function ladder(overrides: Partial<IBudgetLadderOptions<Level>> = {}): BudgetLadder<Level> {
  return new BudgetLadder<Level>({
    levels: LEVELS,
    budgetMs: BUDGET,
    start: "full",
    windowFrames: 10,
    minSamples: 4,
    ...overrides,
  });
}

/** Feeds one window of one constant reading and returns the window verdict. */
function window(target: BudgetLadder<Level>, ms: number | undefined) {
  let verdict: ReturnType<BudgetLadder<Level>["observe"]>;
  for (let frame = 0; frame < 10; frame++) verdict = target.observe(ms);
  return verdict;
}

describe("BudgetLadder", () => {
  it("steps down once when a window stays above the level's budget", () => {
    const target = ladder();
    const verdict = window(target, 9);
    expect(verdict).toMatchObject({ level: "full", stepped: "mid", verdict: "over", windowMs: 9 });
    expect(target.level).toBe("mid");
  });

  it("holds inside the budget and reports the window", () => {
    const target = ladder();
    expect(window(target, 5)).toMatchObject({ stepped: undefined, verdict: "within" });
    expect(target.level).toBe("full");
  });

  it("returns nothing while a window is open", () => {
    const target = ladder();
    for (let frame = 0; frame < 9; frame++) expect(target.observe(9)).toBeUndefined();
  });

  it("steps up only below 70% of the next level's budget", () => {
    // mid may cost 3 and full 3.5, so 70% of full is 2.45: a mid window at 2.9 is inside its own
    // budget and still too close to full's to risk the climb.
    const budgetMs = { cheap: 1, mid: 3, full: 3.5 };
    const target = ladder({ budgetMs, start: "mid" });
    expect(window(target, 2.9)).toMatchObject({ stepped: undefined, verdict: "within" });
    expect(target.level).toBe("mid");
    expect(window(target, 2.0)).toMatchObject({ stepped: "full", verdict: "under" });
    expect(target.level).toBe("full");
  });

  it("does not oscillate: a level that failed is retried after a longer wait each time", () => {
    const target = ladder({ start: "mid", retryWindows: 2 });
    const cost: Record<Level, number> = { cheap: 0.5, mid: 2, full: 9 };
    const climbs: number[] = [];
    for (let index = 1; index <= 60; index++) {
      const before = target.level;
      window(target, cost[target.level]);
      if (before !== "full" && target.level === "full") climbs.push(index);
    }
    const gaps = climbs.slice(1).map((at, i) => at - (climbs[i] ?? 0));
    // Without the wait the ladder would climb every second window (30 times in 60).
    expect(climbs.length).toBeLessThanOrEqual(6);
    expect(gaps.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThan(gaps[i - 1] ?? 0);
    expect(target.level).not.toBe("cheap");
  });

  it("climbs only when the frame has room for the dearer level at its full budget", () => {
    const framed = (frameMs: number) => {
      const target = ladder({ frameBudgetMs: 16.7, start: "cheap" });
      let verdict: ReturnType<BudgetLadder<Level>["observe"]>;
      for (let frame = 0; frame < 10; frame++) verdict = target.observe(0.2, frameMs);
      return verdict;
    };
    // cheap reads 0.2 ms; mid may add 3 - 0.2 = 2.8 ms on top of the frame mean.
    expect(framed(10)).toMatchObject({ stepped: "mid", verdict: "under" });
    expect(framed(15)).toMatchObject({ stepped: undefined, verdict: "within" });
    const blind = ladder({ frameBudgetMs: 16.7, start: "cheap" });
    for (let frame = 0; frame < 10; frame++) blind.observe(0.2);
    expect(blind.level).toBe("cheap");
  });

  it("leaves an explicit level alone and says the budget is exceeded", () => {
    const target = ladder({ explicit: true });
    const verdict = window(target, 9);
    expect(verdict).toMatchObject({ stepped: undefined, verdict: "over", explicit: true });
    expect(target.level).toBe("full");
    expect(window(ladder({ explicit: true, start: "cheap" }), 0.1)?.stepped).toBeUndefined();
  });

  it("holds at the cheapest level and reports it over budget", () => {
    const target = ladder({ start: "cheap" });
    expect(window(target, 4)).toMatchObject({ stepped: undefined, verdict: "over" });
  });

  it("calls a window with too few resolved readings unobserved and never moves on it", () => {
    const target = ladder();
    for (let frame = 0; frame < 9; frame++) target.observe(undefined);
    expect(target.observe(50)).toMatchObject({ verdict: "unobserved", stepped: undefined });
    expect(target.level).toBe("full");
  });

  it("fails closed on a malformed reading or option", () => {
    expect(() => ladder().observe(Number.NaN)).toThrow(RangeError);
    expect(() => ladder().observe(-1)).toThrow(RangeError);
    expect(() => ladder({ start: "nope" as Level })).toThrow(/start/);
    expect(() => ladder({ windowFrames: 0 })).toThrow(RangeError);
    expect(() => ladder({ minSamples: 11 })).toThrow(RangeError);
    expect(() => ladder({ budgetMs: { cheap: 1, mid: 3 } as Record<Level, number> })).toThrow(
      /budget/,
    );
    expect(() => ladder({ levels: [] })).toThrow(/levels/);
    expect(() => ladder({ frameBudgetMs: 0 })).toThrow(RangeError);
    expect(() => ladder().observe(1, -1)).toThrow(RangeError);
  });
});
