import { describe, expect, it } from "vitest";
import type { IStageGpuReading } from "../src/render-pass-budget.js";
import { GIBudget, type IGIBudgetOptions, readGIMarker } from "../src/render/gi-budget.js";

function budget(overrides: Partial<IGIBudgetOptions> = {}) {
  const lines: string[] = [];
  const target = new GIBudget({
    framePeriodMs: 1000 / 60,
    method: "screenProbeGather",
    report: (line) => lines.push(line),
    stages: ["SSGI", "Denoise"],
    tier: "high",
    windowFrames: 10,
    ...overrides,
  });
  return { lines, target };
}

function run(target: GIBudget, ms: number, frameMs: number) {
  let report: ReturnType<GIBudget["observe"]>;
  for (let frame = 0; frame < 10; frame++) report = target.observe(ms, frameMs);
  return report;
}

describe("GIBudget", () => {
  it("holds the method on a frame over its period and says the resolution scale is the lever", () => {
    const { lines, target } = budget();
    const report = run(target, 6.3, 22.6);
    expect(report).toMatchObject({
      finalGatherMethod: "screenProbeGather",
      frameMs: 22.6,
      globalIlluminationQuality: 3,
      periodMs: 16.667,
      share: 0.2788,
      targetMs: 15,
      tier: "high",
      verdict: "over",
      windowMs: 6.3,
    });
    expect(report?.reason).toContain(
      "screenProbeGather holds, the primary resolution scale is the lever",
    );
    expect(report?.reason).toContain("GI is 28% of the frame");
    // 120 more frames of the same: the method never moves.
    for (let i = 0; i < 12; i++) run(target, 6.3, 22.6);
    expect(target.finalGatherMethod).toBe("screenProbeGather");
    expect(readGIMarker(lines[0] ?? "")).toMatchObject({ verdict: "over", windowMs: 6.3 });
    expect(lines).toHaveLength(1);
  });

  it("reads the same GI time as inside the frame at boost: the frame decides, not the stage", () => {
    const { lines, target } = budget();
    // The gather read 2.1 to 3.0 ms at boost and 6.3 to 6.5 ms at P5 on one scene.
    expect(run(target, 6.3, 12.5)).toMatchObject({ verdict: "within" });
    expect(run(target, 2.5, 9)).toMatchObject({ verdict: "within" });
    expect(run(target, 6.3, 22.6)).toMatchObject({ verdict: "over" });
    // One line for the first window and one for the change of verdict.
    expect(lines).toHaveLength(2);
  });

  it("reads the named stages of each resolved frame once, and reports unobserved without any", () => {
    let reading: IStageGpuReading | undefined;
    const { target } = budget({ read: () => reading });
    for (let frame = 0; frame < 10; frame++) target.observeRenderer({});
    expect(target.finalGatherMethod).toBe("screenProbeGather");
    expect(target.lastReport()).toMatchObject({ verdict: "unobserved" });
    expect(target.lastReport()?.reason).toMatch(/no GPU time/);
    let last: ReturnType<GIBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) {
      reading = { frame: 100 + frame, stages: { Denoise: 3, SSGI: 5, other: 99 }, total: 14 };
      last = target.observeRenderer({});
    }
    expect(last).toMatchObject({ frameMs: 14, verdict: "within", windowMs: 8 });
    // The same resolved frame again is no new reading.
    let again: ReturnType<GIBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) again = target.observeRenderer({});
    expect(again).toMatchObject({ samples: 0, verdict: "unobserved", windowMs: undefined });
  });

  it("names which of the configured stages resolved, so a wrong stage name is visible", () => {
    let frame = 0;
    const { target } = budget({
      read: () => ({ frame: ++frame, stages: { SSGI: 2, Other: 9 }, total: 12 }),
      stages: ["SSGI", "Denoise"],
    });
    let report: ReturnType<GIBudget["observeRenderer"]>;
    for (let i = 0; i < 10; i++) report = target.observeRenderer({});
    expect(report?.stagesSeen).toEqual(["SSGI"]);
    expect(report).toMatchObject({ passes: ["Other", "SSGI"], window: 1 });
    const wrong = budget({
      read: () => ({ frame: ++frame, stages: { Other: 9 }, total: 12 }),
      stages: ["SSGI"],
    });
    for (let i = 0; i < 10; i++) report = wrong.target.observeRenderer({});
    expect(report).toMatchObject({ stagesSeen: [], windowMs: 0 });
  });

  it("fails closed on a method outside the ladder or a missing period", () => {
    expect(() => budget({ method: "ssgi" as never })).toThrow(/not one of/);
    expect(() => budget({ framePeriodMs: 0 })).toThrow(RangeError);
    expect(() => budget({ stages: [] })).toThrow(/stages/);
  });
});
