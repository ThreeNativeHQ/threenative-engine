import { describe, expect, it } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import type { IPlaytestFootSlipObservation } from "../src/assertion-report.js";
import type { IPlaytestReport } from "../src/report.js";
import { validatePlaytestScenario } from "../src/scenario.js";

type Vec3 = [number, number, number];
const SPEED = 0.1; // metres per tick, along +z
const PERIOD = 20; // ticks per stride cycle, half planted and half swinging

/**
 * One foot under a body that walks at SPEED. `rate` is how fast the planted foot sweeps back
 * against the body, as a share of SPEED: 1 is a stride matched to the ground, 2 is legs cycling
 * twice as fast as the ground moves (the owner's report).
 */
function stride(rate: number, ticks = 80): IPlaytestFootSlipObservation {
  const samples: IPlaytestFootSlipObservation["samples"] = [];
  let foot = 0.3;
  for (let tick = 0; tick < ticks; tick += 1) {
    const body = tick * SPEED;
    const phase = tick % PERIOD;
    const planted = phase < PERIOD / 2;
    if (tick > 0) foot += planted ? SPEED * (1 - rate) : SPEED * (1 + rate);
    // A swing tick is off the ground from its first tick to its last, as a sampled rig is.
    const lift = planted ? 0 : 0.12 * Math.sin(((phase - PERIOD / 2 + 1) / (PERIOD / 2 + 1)) * Math.PI);
    samples.push({ body: [0, 0.9, body], feet: [[0.1, lift, foot]] });
  }
  return { entity: "player", feet: ["footL"], label: "run", samples };
}

function evaluate(observation: IPlaytestFootSlipObservation | undefined, maxSlip: number | undefined = 0.35, strideAtRun?: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const scenario = validatePlaytestScenario(
    {
      assert: { footSlip: [{ atStep: "run", feet: ["footL"], ...(maxSlip === undefined ? {} : { maxSlip }), ...extra }] },
      name: "slip",
      schemaVersion: 1,
      steps: [{ holdTicks: 80, kind: "input", label: "run", press: "KeyW", release: true }],
      subject: "player",
    },
    "slip.json",
  );
  const report: IPlaytestReport = {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectMoved: false,
    frames: 80,
    observations: { console: [], hud: {}, network: [], resources: {}, ...(strideAtRun === undefined ? {} : { runtimeObservations: { gameplaySeries: [{ gameplay: { animation: { player: { advancedFrames: 40, clip: "run", stride: strideAtRun } }, states: {} }, label: "run" }] } }), ...(observation === undefined ? {} : { footSlip: [observation] }) },
    trivialityOptOuts: [],
  };
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  const result = assertions.find(({ id }) => id.startsWith("footSlip[0]"));
  return { codes: diagnostics.map(({ code }) => code), result };
}

describe("footSlip", () => {
  it("passes a stride whose planted foot stays put", () => {
    const { codes, result } = evaluate(stride(1));
    expect(result?.id).toBe("footSlip[0].slip");
    expect(result?.pass).toBe(true);
    expect((result?.details as { worst: number }).worst).toBeLessThan(0.05);
    expect(codes).not.toContain("TN_PLAYTEST_FOOT_SLIP");
  });

  it("reads contact against the body, so a stride up a bank still passes", () => {
    const climb = stride(1).samples.map(({ body, feet }, tick) => ({
      body: [body![0], body![1] + tick * 0.02, body![2]] as Vec3,
      feet: feet.map((foot) => [foot![0], foot![1] + tick * 0.02, foot![2]] as Vec3),
    }));
    expect(evaluate({ entity: "player", feet: ["footL"], label: "run", samples: climb }).result?.pass).toBe(true);
  });

  it("fails legs that cycle twice as fast as the ground moves", () => {
    const { codes, result } = evaluate(stride(2));
    expect(result?.pass).toBe(false);
    expect((result?.details as { worst: number }).worst).toBeGreaterThan(0.9);
    expect(codes).toContain("TN_PLAYTEST_FOOT_SLIP");
  });

  it("fails a foot that never lifts and slides with the body", () => {
    const samples = stride(1).samples.map(({ body }) => ({ body, feet: [[0.1, 0, body![2] + 0.2] as Vec3] }));
    const { result } = evaluate({ entity: "player", feet: ["footL"], label: "run", samples });
    expect(result?.pass).toBe(false);
    expect((result?.details as { worst: number }).worst).toBeCloseTo(1, 5);
  });

  it("fails closed when the subject did not move, the foot node is missing, or nothing was sampled", () => {
    const still = stride(1).samples.map(({ feet }) => ({ body: [0, 0.9, 0] as Vec3, feet }));
    expect(evaluate({ entity: "player", feet: ["footL"], label: "run", samples: still }).codes).toContain("TN_PLAYTEST_FOOT_SLIP_UNOBSERVED");
    const noFoot = stride(1).samples.map(({ body }) => ({ body, feet: [null] }));
    const missing = evaluate({ entity: "player", feet: ["footL"], label: "run", samples: noFoot });
    expect(missing.result).toMatchObject({ id: "footSlip[0].observed", pass: false });
    expect(evaluate(undefined).codes).toContain("TN_PLAYTEST_FOOT_SLIP_UNOBSERVED");
  });

  it("fails closed with no foot plant when a moving character's clip is in place with zero ground speed", () => {
    const inPlace = { clipGroundSpeed: 0, groundSpeed: 2, inPlace: true, overridden: false, rate: 1, synced: false };
    const { codes, result } = evaluate(stride(1), 0.35, inPlace);
    expect(result).toMatchObject({ id: "footSlip[0].observed", pass: false });
    expect((result?.details as { reason: string }).reason).toBe("no foot plant found: stride sync is off");
    expect(codes).toContain("TN_PLAYTEST_STRIDE_NO_FOOT_PLANT");
  });

  it("measures slip when the in-place clip found a foot plant", () => {
    const planted = { clipGroundSpeed: 2, groundSpeed: 2, inPlace: true, overridden: false, rate: 1, synced: true };
    expect(evaluate(stride(1), 0.35, planted).result?.id).toBe("footSlip[0].slip");
  });

  it("bounds a planted foot's world speed in m/s, whatever the body's speed", () => {
    const ok = evaluate(stride(1), undefined, undefined, { maxSlideSpeed: 1 });
    expect(ok.result).toMatchObject({ id: "footSlip[0].slip", pass: true });
    expect((ok.result?.details as { worstSpeed: number }).worstSpeed).toBeLessThan(0.5);
    // Legs cycling twice as fast as the ground: the planted foot sweeps back at the body's 6 m/s.
    const fast = evaluate(stride(2), undefined, undefined, { maxSlideSpeed: 1 });
    expect(fast.result?.pass).toBe(false);
    expect((fast.result?.details as { worstSpeed: number }).worstSpeed).toBeCloseTo(6, 0);
    expect(fast.codes).toContain("TN_PLAYTEST_FOOT_SLIP");
  });

  it("converts planted ticks to time with the named stepSeconds", () => {
    const half = evaluate(stride(2), undefined, undefined, { maxSlideSpeed: 1, stepSeconds: 1 / 30 });
    expect((half.result?.details as { worstSpeed: number }).worstSpeed).toBeCloseTo(3, 0);
  });

  it("fails closed on maxSlideSpeed when the sole nodes are unnamed", () => {
    const noFoot = stride(1).samples.map(({ body }) => ({ body, feet: [null] }));
    const { codes, result } = evaluate({ entity: "player", feet: ["footL"], label: "run", samples: noFoot }, undefined, undefined, { maxSlideSpeed: 1 });
    expect(result).toMatchObject({ id: "footSlip[0].observed", pass: false });
    expect((result?.details as { reason: string }).reason).toMatch(/name the sole nodes/u);
    expect(codes).toContain("TN_PLAYTEST_FOOT_SLIP_UNOBSERVED");
  });

  it("throws at load on a malformed assertion", () => {
    const load = (footSlip: unknown, label = "run") => () => validatePlaytestScenario(
      { assert: { footSlip }, name: "slip", schemaVersion: 1, steps: [{ holdTicks: 10, kind: "input", label, press: "KeyW", release: true }], subject: "player" },
      "slip.json",
    );
    expect(load([{ atStep: "run", feet: [], maxSlip: 0.35 }])).toThrow(/feet/u);
    expect(load([{ atStep: "run", feet: ["footL", "footL"], maxSlip: 0.35 }])).toThrow(/unique/u);
    expect(load([{ atStep: "run", feet: ["footL"] }])).toThrow(/maxSlip or .*maxSlideSpeed/u);
    expect(load([{ atStep: "run", feet: ["footL"], maxSlideSpeed: 0 }])).toThrow();
    expect(load([{ atStep: "run", feet: ["footL"], maxSlip: "0.35" }])).toThrow();
    expect(load([{ atStep: "walk", feet: ["footL"], maxSlip: 0.35 }])).toThrow(/walk/u);
    expect(load([{ atStep: "run", feet: ["footL"], maxSlip: 0.35, slack: 1 }])).toThrow();
    expect(load([])).toThrow(/at least one/u);
    expect(load([{ atStep: "run", feet: ["footL"], maxSlip: 0.35 }, { atStep: "run", feet: ["footR"], maxSlip: 0.35 }])).toThrow(/repeats/u);
  });
});
