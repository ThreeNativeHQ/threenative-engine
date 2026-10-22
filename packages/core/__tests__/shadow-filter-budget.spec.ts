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
    budgetMs: { high: 2, low: 2, medium: 2 },
    minSamples: 4,
    onStep: (tier) => steps.push(tier),
    report: (line) => lines.push(line),
    tier: "high",
    windowFrames: 10,
    ...overrides,
  });
  return { lines, steps, target };
}

/** A reader that answers a new frame number on each call, so every loop frame counts. */
function counting(read: (frame: number) => Omit<IStageGpuReading, "frame">) {
  let frame = 0;
  return () => {
    frame += 1;
    return { ...read(frame), frame };
  };
}

function run(target: ShadowFilterBudget, ms: number) {
  let report: ReturnType<ShadowFilterBudget["observe"]>;
  for (let frame = 0; frame < 10; frame++) report = target.observe(ms);
  return report;
}

describe("ShadowFilterBudget", () => {
  it("steps the filter's samples down one tier when the shadow passes stay over their budget", () => {
    const { lines, steps, target } = budget();
    const report = run(target, 2.6);
    expect(report).toMatchObject({
      shadowQuality: 1,
      stepped: "medium",
      tier: "medium",
      windowMs: 2.6,
    });
    expect(report?.reason).toBe(
      "shadow passes 2.6 ms are over the 2 ms budget: stepped down to medium",
    );
    expect(target.tier).toBe("medium");
    expect(steps).toEqual(["medium"]);
    expect(readShadowTierMarker(lines[0] ?? "")).toMatchObject({ shadowQuality: 1 });
  });

  it("steps back up only below 70% of the next tier's budget", () => {
    const { steps, target } = budget({ tier: "medium" });
    expect(run(target, 1.6)?.stepped).toBeUndefined();
    expect(run(target, 1.2)?.stepped).toBe("high");
    expect(steps).toEqual(["high"]);
    expect(target.shadowQuality).toBe(3);
  });

  it("keeps explicit sample counts and says the budget is exceeded", () => {
    const { lines, steps, target } = budget({ explicit: true });
    const report = run(target, 2.6);
    expect(report).toMatchObject({ explicit: true, stepped: undefined, tier: "high" });
    expect(report?.reason).toContain("sample counts are set by the game and stay at high");
    expect(steps).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("reads the shadow stage of each resolved renderer frame once and holds without a reading", () => {
    let reading: IStageGpuReading | undefined;
    const { target } = budget({ read: () => reading });
    for (let frame = 0; frame < 10; frame++) target.observeRenderer({});
    expect(target.tier).toBe("high");
    expect(target.lastReport()?.reason).toMatch(/no GPU time/);
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) {
      reading = { frame: 40 + frame, stages: { Shadow: 3 }, total: 30 };
      last = target.observeRenderer({});
    }
    expect(last).toMatchObject({ frameMs: 30, stepped: "medium", windowMs: 3 });
  });

  it("sums every stage it is told to read", () => {
    const { target } = budget({
      read: counting(() => ({ stages: { Shadow: 1.5, ShadowLamps: 1, SSGI: 20 }, total: 30 })),
      stages: ["Shadow", "ShadowLamps"],
    });
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let i = 0; i < 10; i++) last = target.observeRenderer({});
    expect(last).toMatchObject({
      stagesSeen: ["Shadow", "ShadowLamps"],
      stepped: "medium",
      windowMs: 2.5,
    });
  });

  it("holds the tier on a slow frame its own stage did not cause", () => {
    // The 2026-10-22 run: a 19.5 ms frame over a 16.7 ms period, the shadow passes 0.3 ms of it.
    const { steps, target } = budget({
      budgetMs: { high: 1, low: 1, medium: 1 },
      read: counting(() => ({ stages: { Shadow: 0.3 }, total: 19.5 })),
    });
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let i = 0; i < 10; i++) last = target.observeRenderer({});
    expect(last).toMatchObject({ stepped: undefined, tier: "high", windowMs: 0.3 });
    expect(steps).toEqual([]);
  });

  it("steps the tier down when its own stage is over its budget, whatever the frame", () => {
    const { target } = budget({
      budgetMs: { high: 1, low: 1, medium: 1 },
      read: counting(() => ({ stages: { Shadow: 2.5 }, total: 8 })),
    });
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let i = 0; i < 10; i++) last = target.observeRenderer({});
    expect(last).toMatchObject({ stepped: "medium", tier: "medium", windowMs: 2.5 });
  });

  it("rejects a tier outside low, medium and high", () => {
    expect(() => budget({ tier: "epic" as never })).toThrow(/start/);
  });
});
