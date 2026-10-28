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
    framePeriodMs: 1000 / 60,
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

function feed(target: ShadowFilterBudget, ms: number, frameMs: number, frames: number) {
  const reports = [];
  for (let i = 0; i < frames; i++) {
    const report = target.observe(ms, frameMs);
    if (report !== undefined) reports.push(report);
  }
  return reports;
}

describe("ShadowFilterBudget", () => {
  it("steps the filter's samples down one tier after 2 frames over the frame period", () => {
    const { lines, steps, target } = budget();
    const [report] = feed(target, 6, 20, 2);
    expect(report).toMatchObject({
      panic: true,
      shadowQuality: 1,
      stepped: "medium",
      tier: "medium",
      verdict: "over",
    });
    expect(report?.reason).toBe(
      "frame 20 ms is over the 15.83 ms target (period 16.67 ms) for 2 frames in a row: stepped down to medium",
    );
    expect(target.tier).toBe("medium");
    expect(steps).toEqual(["medium"]);
    expect(readShadowTierMarker(lines[0] ?? "")).toMatchObject({ shadowQuality: 1 });
  });

  it("takes the 5% headroom and the 1% threshold of Unreal's virtual shadow map budget", () => {
    // 16.2 ms is over the 15.83 ms target (16.67 x 0.95) and inside the period: a drop after the 8-frame period.
    const slow = budget();
    const reports = feed(slow.target, 4, 16.2, 8);
    expect(reports[0]).toMatchObject({ panic: false, stepped: "medium" });
    // 15.7 ms is inside the 1% threshold: it holds.
    const fine = budget();
    expect(feed(fine.target, 4, 15.7, 40).every((r) => r.stepped === undefined)).toBe(true);
  });

  it("steps back up when the frame has room", () => {
    const { steps, target } = budget({ tier: "medium" });
    expect(feed(target, 0.5, 9, 8)[0]).toMatchObject({ stepped: "high", verdict: "under" });
    expect(steps).toEqual(["high"]);
    expect(target.shadowQuality).toBe(3);
  });

  it("keeps explicit sample counts and says the frame is over", () => {
    const { lines, steps, target } = budget({ explicit: true });
    const report = feed(target, 4, 20, 10)[0];
    expect(report).toMatchObject({
      explicit: true,
      stepped: undefined,
      tier: "high",
      verdict: "over",
    });
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
    const last: ReturnType<ShadowFilterBudget["observeRenderer"]>[] = [];
    for (let frame = 0; frame < 3; frame++) {
      reading = { frame: 40 + frame, stages: { Shadow: 16 }, total: 30 };
      last.push(target.observeRenderer({}));
    }
    expect(last.find((r) => r !== undefined)).toMatchObject({
      frameMs: 30,
      stepped: "medium",
      windowMs: 16,
    });
  });

  it("sums every stage it is told to read", () => {
    const { target } = budget({
      read: counting(() => ({ stages: { Shadow: 6, ShadowLamps: 1, SSGI: 4 }, total: 22 })),
      stages: ["Shadow", "ShadowLamps"],
    });
    const reports = [];
    for (let i = 0; i < 3; i++) {
      const report = target.observeRenderer({});
      if (report !== undefined) reports.push(report);
    }
    expect(reports[0]).toMatchObject({
      stagesSeen: ["Shadow", "ShadowLamps"],
      stepped: "medium",
      windowMs: 7,
    });
  });

  it("holds the tier on a slow frame its own stage did not cause", () => {
    // The 2026-10-22 run: a 19.5 ms frame over a 16.7 ms period, the shadow passes 0.3 ms of it.
    const { steps, target } = budget({
      read: counting(() => ({ stages: { Shadow: 0.3 }, total: 19.5 })),
    });
    let last: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    for (let i = 0; i < 10; i++) last = target.observeRenderer({});
    expect(last).toMatchObject({
      notBlamed: true,
      stepped: undefined,
      tier: "high",
      verdict: "over",
      windowMs: 0.3,
    });
    expect(last?.reason).toContain("too small to absorb it");
    expect(steps).toEqual([]);
  });

  it("steps down on the same stage reading when the frame is over, and holds when it is not", () => {
    // 8 ms of shadow passes: a 9 ms frame (boost) is inside the period, a 22 ms one (P5) is not.
    const boost = budget();
    expect(feed(boost.target, 8, 9, 100).every((r) => r.stepped === undefined)).toBe(true);
    const p5 = budget();
    expect(feed(p5.target, 8, 22, 2)[0]).toMatchObject({ stepped: "medium" });
  });

  it("rejects a tier outside low, medium and high", () => {
    expect(() => budget({ tier: "epic" as never })).toThrow(/start/);
  });
});
