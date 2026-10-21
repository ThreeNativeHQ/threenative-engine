import { describe, expect, it } from "vitest";
import type { IStageGpuReading } from "../src/render-pass-budget.js";
import {
  type IShadowFilterBudgetOptions,
  ShadowFilterBudget,
  readShadowTierMarker,
} from "../src/render/shadow-filter-budget.js";

function budget(overrides: Partial<IShadowFilterBudgetOptions> = {}) {
  const lines: string[] = [];
  const steps: string[] = [];
  const target = new ShadowFilterBudget({
    frameBudgetMs: 16.7,
    minSamples: 4,
    onStep: (tier) => steps.push(tier),
    report: (line) => lines.push(line),
    tier: "high",
    windowFrames: 10,
    ...overrides,
  });
  return { lines, steps, target };
}

function run(target: ShadowFilterBudget, ms: number) {
  let report: ReturnType<ShadowFilterBudget["observe"]>;
  for (let frame = 0; frame < 10; frame++) report = target.observe(ms);
  return report;
}

describe("ShadowFilterBudget", () => {
  it("steps the filter's samples down one tier when the frame stays over its period", () => {
    const { lines, steps, target } = budget();
    const report = run(target, 22);
    expect(report).toMatchObject({
      shadowQuality: 1,
      stepped: "medium",
      tier: "medium",
      windowMs: 22,
    });
    expect(report?.reason).toBe("frame 22 ms is over the 16.7 ms period: stepped down to medium");
    expect(target.tier).toBe("medium");
    expect(steps).toEqual(["medium"]);
    expect(readShadowTierMarker(lines[0] ?? "")).toMatchObject({ shadowQuality: 1 });
  });

  it("steps back up only below 70% of the period", () => {
    const { steps, target } = budget({ tier: "medium" });
    expect(run(target, 14)?.stepped).toBeUndefined();
    expect(run(target, 10)?.stepped).toBe("high");
    expect(steps).toEqual(["high"]);
    expect(target.shadowQuality).toBe(3);
  });

  it("keeps explicit sample counts and says the budget is exceeded", () => {
    const { lines, steps, target } = budget({ explicit: true });
    const report = run(target, 22);
    expect(report).toMatchObject({ explicit: true, stepped: undefined, tier: "high" });
    expect(report?.reason).toContain("sample counts are set by the game and stay at high");
    expect(steps).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("reads the whole frame of each resolved renderer frame once and holds without a reading", () => {
    let reading: IStageGpuReading | undefined;
    const { target } = budget({ read: () => reading });
    for (let frame = 0; frame < 10; frame++) target.observeRenderer({});
    expect(target.tier).toBe("high");
    expect(target.lastReport()?.reason).toMatch(/no GPU time/);
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) {
      reading = { frame: 40 + frame, stages: {}, total: 30 };
      last = target.observeRenderer({});
    }
    expect(last).toMatchObject({ stepped: "medium", windowMs: 30 });
  });

  it("leaves out the stages another watcher answers for", () => {
    let reading: IStageGpuReading | undefined;
    const { target } = budget({ excludeStages: ["SSGI"], read: () => reading });
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) {
      reading = { frame: 1 + frame, stages: { AO: 1, SSGI: 20 }, total: 30 };
      last = target.observeRenderer({});
    }
    // A 30 ms frame, 20 ms of it the gather: the filter is held to the 10 ms that remain.
    expect(last).toMatchObject({ stepped: undefined, tier: "high", windowMs: 10 });
  });

  it("rejects a tier outside low, medium and high", () => {
    expect(() => budget({ tier: "epic" as never })).toThrow(/start/);
  });
});
