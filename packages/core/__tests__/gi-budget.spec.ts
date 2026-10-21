import { describe, expect, it } from "vitest";
import type { IStageGpuReading } from "../src/render-pass-budget.js";
import { GIBudget, type IGIBudgetOptions, readGIMarker } from "../src/render/gi-budget.js";

// Unreal's measured GI time per level, as the tier table records it (PRD-644): none costs nothing.
const BUDGET = { irradianceField: 1, none: 0, screenProbeGather: 6 } as const;

function budget(overrides: Partial<IGIBudgetOptions> = {}) {
  const lines: string[] = [];
  const steps: string[] = [];
  const target = new GIBudget({
    budgetMs: BUDGET,
    frameBudgetMs: 16.7,
    method: "screenProbeGather",
    minSamples: 4,
    onStep: (method) => steps.push(method),
    report: (line) => lines.push(line),
    stages: ["SSGI", "Denoise"],
    tier: "high",
    windowFrames: 10,
    ...overrides,
  });
  return { lines, steps, target };
}

function run(target: GIBudget, ms: number, frameMs = 10) {
  let report: ReturnType<GIBudget["observe"]>;
  for (let frame = 0; frame < 10; frame++) report = target.observe(ms, frameMs);
  return report;
}

describe("GIBudget", () => {
  it("steps screenProbeGather down to irradianceField once, and says why", () => {
    const { lines, steps, target } = budget();
    const report = run(target, 31);
    expect(report).toMatchObject({
      budgetMs: 6,
      finalGatherMethod: "irradianceField",
      globalIlluminationQuality: 1,
      reason: "window 31 ms is over the 6 ms budget: stepped down to irradianceField",
      stepped: "irradianceField",
      tier: "high",
      windowMs: 31,
    });
    expect(target.finalGatherMethod).toBe("irradianceField");
    expect(target.globalIlluminationQuality).toBe(1);
    expect(steps).toEqual(["irradianceField"]);
    expect(lines).toHaveLength(1);
    expect(readGIMarker(lines[0] ?? "")).toMatchObject({
      stepped: "irradianceField",
      windowMs: 31,
    });
  });

  it("steps up after a window below 70% of the next budget with room in the frame", () => {
    const { steps, target } = budget({ method: "irradianceField" });
    expect(run(target, 0.4, 10)?.stepped).toBe("screenProbeGather");
    expect(steps).toEqual(["screenProbeGather"]);
    expect(target.globalIlluminationQuality).toBe(3);
  });

  it("does not climb out of none on a frame that has no room", () => {
    const { target } = budget({ method: "none" });
    expect(run(target, 0, 16.5)?.stepped).toBeUndefined();
    expect(target.finalGatherMethod).toBe("none");
    expect(run(target, 0, 8)?.stepped).toBe("irradianceField");
  });

  it("keeps an explicit method and reports the exceeded budget", () => {
    const { lines, steps, target } = budget({ explicit: true });
    const report = run(target, 31);
    expect(report).toMatchObject({ explicit: true, stepped: undefined });
    expect(report?.reason).toBe(
      "window 31 ms is over the 6 ms budget: finalGatherMethod is set by the game and stays screenProbeGather",
    );
    expect(target.finalGatherMethod).toBe("screenProbeGather");
    expect(steps).toEqual([]);
    expect(lines).toHaveLength(1);
  });

  it("reports nothing for a window inside its budget", () => {
    const { lines, target } = budget();
    expect(run(target, 4)?.stepped).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it("reads the named stages of each resolved frame once, and holds when none resolve", () => {
    let reading: IStageGpuReading | undefined;
    const { target } = budget({ read: () => reading });
    // No timestamp query on this adapter: the window is unobserved and the method holds.
    for (let frame = 0; frame < 10; frame++) target.observeRenderer({});
    expect(target.finalGatherMethod).toBe("screenProbeGather");
    expect(target.lastReport()?.reason).toMatch(/no GPU time/);
    // A frame counts once, however many loop frames wait for the next one to resolve.
    let last: ReturnType<GIBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) {
      reading = { frame: 100 + frame, stages: { Denoise: 3, SSGI: 5, other: 99 }, total: 14 };
      last = target.observeRenderer({});
    }
    expect(last).toMatchObject({ stepped: "irradianceField", windowMs: 8 });
    // The same resolved frame again is no new reading: the window sees nothing and holds.
    let again: ReturnType<GIBudget["observeRenderer"]>;
    for (let frame = 0; frame < 10; frame++) again = target.observeRenderer({});
    expect(again).toMatchObject({ samples: 0, windowMs: undefined });
  });

  it("fails closed on a method outside the ladder or a missing budget", () => {
    expect(() => budget({ method: "ssgi" as never })).toThrow(/start/);
    expect(() => budget({ budgetMs: { none: 0 } as never })).toThrow(/budget/);
    expect(() => budget({ stages: [] })).toThrow(/stages/);
  });
});
