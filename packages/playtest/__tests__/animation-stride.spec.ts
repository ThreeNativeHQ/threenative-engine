import { describe, expect, test } from "vitest";

import { emitMovementEvidence } from "../src/evaluators/movement-evidence.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { loadPlaytestScenario } from "../src/scenario.js";

/**
 * The stride convention — feet meet the floor — is on by default and has a named override, and
 * `AnimationPlayer` has measured it since it shipped. Nothing could read that measurement: it
 * never crossed the playtest bridge, so no scenario could catch a character skating across a
 * floor, and turning the convention off turned its measurement off as far as any instrument was
 * concerned.
 *
 * These pin the bound and every way it must fail closed.
 */

const baseReport = {
  diagnostics: [],
  distance: 0,
  entity: "player",
  expectMoved: false,
  frames: 1,
  observations: { console: [], hud: {}, network: [], resources: {} },
  trivialityOptOuts: [],
};

const baseScenario = {
  name: "stride",
  schemaVersion: 1,
  steps: [{ label: "goal", release: true, waitFrames: 1 }],
  subject: "player",
  target: "web",
};

function evaluate(assertion: unknown, report: Record<string, unknown> = {}) {
  const assertions: Array<{ details?: Record<string, unknown>; id: string; pass: boolean }> = [];
  const diagnostics: Array<{ code: string; message: string; severity: "error" | "warning" }> = [];
  emitMovementEvidence({
    assertions,
    diagnostics,
    input: {
      report: {
        ...baseReport,
        ...report,
        observations: { ...baseReport.observations, ...(report.observations as object | undefined) },
      } as never,
      scenario: { ...baseScenario, assert: assertion } as never,
    },
    scenarioAssertions: assertion as never,
  });
  return { assertions, diagnostics };
}

/** One runtime observation carrying an animation sample for `player`, before and after. */
function withAnimation(after: unknown, before: unknown = { advancedFrames: 0, clip: "idle" }) {
  return {
    observations: {
      console: [],
      hud: {},
      network: [],
      resources: {},
      runtimeObservations: {
        gameplay: { animation: { player: after }, states: {} },
        gameplayBefore: { animation: { player: before }, states: {} },
      },
    },
  };
}

const WALKING = { advancedFrames: 40, clip: "walk" };

describe("foot slide is an observation a scenario can bound", () => {
  test("passes when the clip's feet carry the ground the body covered", () => {
    const result = evaluate(
      { animation: [{ clip: "walk", entity: "player", maxFootSlide: 0.1 }] },
      withAnimation({
        ...WALKING,
        stride: { clipGroundSpeed: 1.5, groundSpeed: 3, overridden: false, rate: 2, synced: true },
      }),
    );
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(true);
    expect(result.assertions.find(({ id }) => id === "animation.player")?.details?.footSlide).toBe(0);
  });

  test("fails, naming the slide, when the feet and the ground disagree", () => {
    const result = evaluate(
      { animation: [{ clip: "walk", entity: "player", maxFootSlide: 0.1 }] },
      withAnimation({
        ...WALKING,
        stride: { clipGroundSpeed: 1, groundSpeed: 4, overridden: true, rate: 1, synced: false },
      }),
    );
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_FOOT_SLIDE");
    expect(result.diagnostics[0]?.message).toContain("75% apart");
  });

  test("fails closed when the runtime reports no stride at all", () => {
    const result = evaluate(
      { animation: [{ clip: "walk", entity: "player", maxFootSlide: 0.5 }] },
      withAnimation(WALKING),
    );
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_STRIDE_UNOBSERVED");
  });

  test("fails closed on a partially shaped stride report rather than filling the gap in", () => {
    const result = evaluate(
      { animation: [{ clip: "walk", entity: "player", maxFootSlide: 0.5 }] },
      withAnimation({
        ...WALKING,
        stride: { clipGroundSpeed: 1, groundSpeed: 1, rate: 1, synced: true },
      }),
    );
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_STRIDE_UNOBSERVED");
  });

  test("fails closed when the body covered no ground, rather than passing on nothing", () => {
    const result = evaluate(
      { animation: [{ clip: "walk", entity: "player", maxFootSlide: 0.5 }] },
      withAnimation({
        ...WALKING,
        stride: { clipGroundSpeed: 0, groundSpeed: 0, overridden: false, rate: 1, synced: false },
      }),
    );
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_STRIDE_UNOBSERVED");
    expect(result.diagnostics[0]?.message).toContain("covered no ground");
  });

  test("measures the feet at the rate the clip is playing, not the rate the player only measured", () => {
    // The override is the case: `AnimationPlayer` still reports the rate it computed, but it did
    // not apply it, so the clip is running at its authored rate and the feet are skating. Reading
    // the measured rate back scored this as zero slide — an overridden convention silently
    // satisfying the bound that exists to catch it.
    const overridden = {
      ...WALKING,
      stride: { clipGroundSpeed: 2, groundSpeed: 1.6, overridden: true, rate: 0.8, synced: false },
    };
    const result = evaluate(
      { animation: [{ entity: "player", maxFootSlide: 0.05 }] },
      withAnimation(overridden),
    );
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("TN_PLAYTEST_FOOT_SLIDE");
    // Feet carry the full 2 m/s while the body covers 1.6: 25% apart.
    expect(result.assertions.find(({ id }) => id === "animation.player")?.details?.footSlide).toBeCloseTo(0.25, 6);
    // The same numbers with the convention applied agree exactly.
    const applied = evaluate(
      { animation: [{ entity: "player", maxFootSlide: 0.05 }] },
      withAnimation({
        ...WALKING,
        stride: { clipGroundSpeed: 2, groundSpeed: 1.6, overridden: false, rate: 0.8, synced: true },
      }),
    );
    expect(applied.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(true);
    expect(applied.assertions.find(({ id }) => id === "animation.player")?.details?.footSlide).toBeCloseTo(0, 6);
  });

  test("strideSynced reports the override rather than treating it as agreement", () => {
    const overridden = {
      ...WALKING,
      stride: { clipGroundSpeed: 1, groundSpeed: 1, overridden: true, rate: 1, synced: false },
    };
    expect(
      evaluate({ animation: [{ entity: "player", strideSynced: false }] }, withAnimation(overridden))
        .assertions.find(({ id }) => id === "animation.player")?.pass,
    ).toBe(true);
    const required = evaluate(
      { animation: [{ entity: "player", strideSynced: true }] },
      withAnimation(overridden),
    );
    expect(required.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(required.diagnostics[0]?.code).toBe("TN_PLAYTEST_STRIDE_NOT_SYNCED");
    expect(required.diagnostics[0]?.message).toContain("strideSync: false");
  });
});

describe("the scenario schema fails closed on the new fields", () => {
  function scenarioFile(assertion: unknown): { file: string; project: string } {
    const project = makeTempDirSync("threenative-stride-");
    const file = join(project, "stride.playtest.json");
    writeFileSync(
      file,
      JSON.stringify({
        assert: { animation: [assertion] },
        name: "stride",
        schemaVersion: 1,
        steps: [{ waitTicks: 1 }],
        subject: "player",
        target: "web",
      }),
    );
    return { file, project };
  }

  test("accepts a well-typed bound", async () => {
    const { file, project } = scenarioFile({ entity: "player", maxFootSlide: 0.2, strideSynced: true });
    const scenario = await loadPlaytestScenario(project, file);
    expect(scenario.assert?.animation?.[0]).toMatchObject({ maxFootSlide: 0.2, strideSynced: true });
  });

  test("throws on a wrong-typed maxFootSlide instead of dropping it", async () => {
    const { file, project } = scenarioFile({ entity: "player", maxFootSlide: "tight" });
    await expect(loadPlaytestScenario(project, file)).rejects.toThrow(/maxFootSlide/u);
  });

  test("throws on a wrong-typed strideSynced instead of dropping it", async () => {
    const { file, project } = scenarioFile({ entity: "player", strideSynced: "yes" });
    await expect(loadPlaytestScenario(project, file)).rejects.toThrow(/strideSynced/u);
  });
});

describe("an in-place clip with no foot plant fails closed", () => {
  const stride = (extra: Record<string, unknown>) => ({
    ...WALKING,
    stride: { clipGroundSpeed: 0, groundSpeed: 2, inPlace: true, overridden: false, rate: 1, synced: false, ...extra },
  });

  test("a moving character on an in-place clip of zero ground speed fails stride and footSlide bounds", () => {
    for (const bound of [{ strideSynced: true }, { maxFootSlide: 0.5 }]) {
      const result = evaluate({ animation: [{ clip: "walk", entity: "player", ...bound }] }, withAnimation(stride({})));
      expect(result.diagnostics.map(({ message }) => message).join()).toContain("no foot plant found: stride sync is off");
      expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    }
  });

  test("a standing character, or an in-place clip whose feet planted, is not that failure", () => {
    const standing = evaluate({ animation: [{ clip: "walk", entity: "player", strideSynced: true }] }, withAnimation(stride({ groundSpeed: 0 })));
    expect(standing.diagnostics.map(({ message }) => message).join()).not.toContain("no foot plant");
    const planted = evaluate({ animation: [{ clip: "walk", entity: "player", strideSynced: true }] }, withAnimation(stride({ clipGroundSpeed: 1.5, synced: true })));
    expect(planted.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(true);
  });
});
