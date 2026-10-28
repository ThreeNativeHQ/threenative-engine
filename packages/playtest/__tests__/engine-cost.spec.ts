import { describe, expect, it } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import type { IPlaytestReport } from "../src/report.js";
import { validatePlaytestScenario } from "../src/scenario.js";

const BOUNDS = { maxInFrame: { walkVisits: 2000 }, maxPerFrame: { crossings: 2000, redundantReads: 60 }, source: "shooter after-values, 2026-10-27, 2x headroom" };

const census = `TN_BRIDGE_CENSUS:${JSON.stringify({ crossings: 450, top: [{ caller: "validateControls (render/backlightControls.ts:5)", name: "get DirectionalLight.intensity", perFrame: 450 }], window: 1 })}`;

/** A census, then a TN_FRAME_BUDGET window whose counters.engine carries each counter's per-frame mean and max. */
const line = (window: number, perFrame: Record<string, number>, maxFrame: Record<string, number> = { walkVisits: 500 }) => {
  const engine = Object.fromEntries(
    [...new Set([...Object.keys(perFrame), ...Object.keys(maxFrame)])].map((name) => [
      name,
      { max: maxFrame[name] ?? perFrame[name], mean: perFrame[name] ?? 0, p50: 0, p95: 0, p99: 0, samples: 300 },
    ]),
  );
  return `${census}\nTN_FRAME_BUDGET:${JSON.stringify({ counters: { engine, simulationTick: window * 300 }, window })}`;
};

function evaluate(lines: string[], engineCost: Record<string, unknown> = BOUNDS) {
  const scenario = validatePlaytestScenario(
    { assert: { engineCost }, name: "cost", schemaVersion: 1, steps: [{ kind: "wait", release: true, waitTicks: 10 }], subject: "player" },
    "cost.json",
  );
  const report: IPlaytestReport = {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectMoved: false,
    frames: 10,
    observations: { console: lines.flatMap((text) => text.split("\n")).map((text) => ({ source: "browser-console", text, type: "log" })), hud: {}, network: [], resources: {} },
    trivialityOptOuts: [],
  } as unknown as IPlaytestReport;
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  return {
    cost: assertions.filter(({ id }) => id.startsWith("engineCost")),
    diagnostics: diagnostics.filter(({ code }) => code.startsWith("TN_PLAYTEST_ENGINE_COST")),
  };
}

describe("engineCost", () => {
  it("passes when every window holds every bound", () => {
    const { cost, diagnostics } = evaluate([line(1, { crossings: 800, redundantReads: 2 }), line(2, { crossings: 1000, redundantReads: 0 })]);
    expect(cost.length).toBe(4);
    expect(cost.every(({ pass }) => pass)).toBe(true);
    expect(diagnostics).toEqual([]);
  });

  it("fails one window over a bound and names the counter, the window and the census caller", () => {
    const { cost, diagnostics } = evaluate([line(1, { crossings: 800, redundantReads: 2 }), line(2, { crossings: 3200, redundantReads: 449 })]);
    expect(cost.find(({ id }) => id === "engineCost.maxPerFrame.crossings")?.pass).toBe(false);
    expect(cost.find(({ id }) => id === "engineCost.maxPerFrame.redundantReads")?.pass).toBe(false);
    expect(diagnostics[0]?.message).toContain("window 2");
    expect(diagnostics[0]?.message).toContain("validateControls");
  });

  it("fails closed with no window, an unreadable window, or a bounded counter a window does not report", () => {
    expect(evaluate([]).diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_ENGINE_COST_UNOBSERVED"]);
    expect(evaluate(["TN_FRAME_BUDGET:{not json"]).diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_ENGINE_COST_UNOBSERVED"]);
    expect(evaluate([line(1, { crossings: 800 })]).cost.find(({ id }) => id === "engineCost.maxPerFrame.redundantReads")?.pass).toBe(false);
    expect(evaluate([line(1, { crossings: 1, redundantReads: 1 })], { ...BOUNDS, minWindows: 2 }).diagnostics.length).toBe(1);
  });

  it("bounds the still windows on their own, so a read that only moving play may make fails only while still", () => {
    const still = { ...BOUNDS, still: { maxPerFrame: { childrenReads: 30 }, windows: 1 } };
    const after = [line(1, { childrenReads: 14, crossings: 60, redundantReads: 0 }), line(2, { childrenReads: 128, crossings: 700, redundantReads: 6 })];
    const before = [line(1, { childrenReads: 53, crossings: 60, redundantReads: 0 }), line(2, { childrenReads: 128, crossings: 700, redundantReads: 6 })];
    expect(evaluate(after, still).cost.every(({ pass }) => pass)).toBe(true);
    const red = evaluate(before, still);
    expect(red.cost.find(({ id }) => id === "engineCost.still.maxPerFrame.childrenReads")?.pass).toBe(false);
    expect(red.diagnostics[0]?.message).toContain("while still");
    expect(evaluate([after[0] as string], { ...still, still: { maxPerFrame: { childrenReads: 30 }, windows: 2 } }).diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_ENGINE_COST_UNOBSERVED"]);
  });

  it("bounds the moving windows on their own, so a settle spike while still does not mask a walk in play", () => {
    const split = { maxPerFrame: { crossings: 2000 }, moving: { maxInFrame: { walkVisits: 3000 } }, source: "shooter after-values, 2026-10-27", still: { maxPerFrame: { crossings: 2000 }, windows: 1 } };
    const settle = line(1, { crossings: 900, walkVisits: 581 }, { walkVisits: 10755 });
    expect(evaluate([settle, line(2, { crossings: 330, walkVisits: 495 }, { walkVisits: 1047 })], split).cost.every(({ pass }) => pass)).toBe(true);
    const red = evaluate([settle, line(2, { crossings: 330, walkVisits: 600 }, { walkVisits: 9950 })], split);
    expect(red.cost.find(({ id }) => id === "engineCost.moving.maxInFrame.walkVisits")?.pass).toBe(false);
    expect(red.diagnostics[0]?.message).toContain("in play");
    expect(evaluate([settle], split).diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_ENGINE_COST_UNOBSERVED"]);
  });

  it("leaves the boot windows unbounded, so the first scene build does not hide or fail a still frame", () => {
    const skip = { ...BOUNDS, skipWindows: 1, still: { maxPerFrame: { childrenReads: 30 }, windows: 1 } };
    const boot = line(1, { childrenReads: 112, crossings: 1862, redundantReads: 40 }, { walkVisits: 2577 });
    const still = line(2, { childrenReads: 14, crossings: 600, redundantReads: 0 });
    const moving = line(3, { childrenReads: 128, crossings: 700, redundantReads: 6 });
    expect(evaluate([boot, still, moving], skip).cost.every(({ pass }) => pass)).toBe(true);
    expect(evaluate([boot, still, moving], { ...skip, skipWindows: 0 }).cost.find(({ id }) => id === "engineCost.still.maxPerFrame.childrenReads")?.pass).toBe(false);
    expect(evaluate([boot, line(2, { childrenReads: 53, crossings: 600, redundantReads: 0 }), moving], skip).cost.find(({ id }) => id === "engineCost.still.maxPerFrame.childrenReads")?.pass).toBe(false);
    expect(evaluate([boot], skip).diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_ENGINE_COST_UNOBSERVED"]);
  });

  it("takes still and moving bounds alone, the shape the kit contract row writes", () => {
    const split = { moving: { maxPerFrame: { crossings: 2000 } }, source: "shooter after-values, 2026-10-27", still: { maxPerFrame: { crossings: 900 }, windows: 1 } };
    const { cost } = evaluate([line(1, { crossings: 800 }), line(2, { crossings: 1500 })], split);
    expect(cost.map(({ id, pass }) => [id, pass])).toEqual([
      ["engineCost.observed", true],
      ["engineCost.still.maxPerFrame.crossings", true],
      ["engineCost.moving.maxPerFrame.crossings", true],
    ]);
  });

  it("refuses a malformed assertion at load", () => {
    const bad = (engineCost: unknown) => () => evaluate([], engineCost as Record<string, unknown>);
    expect(bad({ source: "no bounds at all here" })).toThrow();
    expect(bad({ maxPerFrame: {}, source: "an empty bounds table" })).toThrow();
    expect(bad({ maxPerFrame: { crossings: "2000" }, source: "a string bound is wrong" })).toThrow();
    expect(bad({ maxPerFrame: { crossings: -1 }, source: "a negative bound is wrong" })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 } })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 }, source: "short" })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 }, source: "an unknown key follows", typo: 1 })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 }, source: "still without windows", still: { maxPerFrame: { crossings: 1 } } })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 }, source: "still without bounds", still: { windows: 1 } })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 }, moving: { maxInFrame: { walkVisits: 1 } }, source: "moving without still" })).toThrow();
    expect(bad({ maxPerFrame: { crossings: 1 }, skipWindows: -1, source: "a negative skip is wrong" })).toThrow();
  });
});
