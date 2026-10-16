import { describe, expect, test } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/assertion-evaluators.js";
import type { IPlaytestScenario } from "../src/scenario.js";

// PRD-182 Phase 1 characterization net: these tests pin CURRENT semantics of
// evaluateRichPlaytestAssertions - verdict ids, pass values, detail shapes, diagnostic codes
// and result ordering - so the Phase 2 file split cannot disturb them unnoticed. Behavior
// that looks wrong (e.g. tags passing with count 0) is pinned AS IS; fixing behavior is
// explicitly NOT this PRD. Every expected value below was captured from the unsplit module.

const base = {
  consoleErrors: 0,
  diagnostics: [],
  distance: 0,
  entity: "player",
  expectMoved: false,
  frames: 1,
  trivialityOptOuts: [],
  observations: { console: [], hud: {}, network: [], resources: {} },
};

function evaluate(assert_: IPlaytestScenario["assert"], extra: object = {}) {
  return evaluateRichPlaytestAssertions({
    report: { ...base, ...extra } as never,
    scenario: { assert: assert_, name: "c", schemaVersion: 1, steps: [{ release: true, waitTicks: 1 }] } as never,
  });
}

describe("evaluator semantics (characterization)", () => {
  test("fails the pipeline census ceiling on work observed after warm-up settled", () => {
    const event = (sequence: number, settledMs: number, beforeWarmUpSettled: boolean, nodeBuilds: number) => ({
      sequence,
      programIdentity: `program-${sequence}`,
      pipelineIdentity: `pipeline-${sequence}`,
      kind: "render",
      pass: "main",
      mode: "sync",
      status: "created",
      vertex: { hash: `vertex-${sequence}`, bytes: 10 },
      fragment: { hash: `fragment-${sequence}`, bytes: 10 },
      provenance: { material: { name: "material" }, unknown: false },
      reasons: ["map"],
      startedMs: settledMs - 1,
      settledMs,
      serviceMs: 1,
      beforeFirstPresent: sequence === 1,
      beforeWarmUpSettled,
      ...(sequence === 2 ? { afterWarmUpScope: "chunk:0" } : {}),
      nodeBuilds,
    });
    const result = evaluate(
      {
        pipelineCensus: {
          maxNodeBuildsAfterWarmUpSettled: 0,
          maxRenderPipelineCreationsAfterWarmUpSettled: 0,
          warmUpScope: "chunk:0",
          maxRenderPipelineCreationsAfterWarmUpScope: 0,
        },
      } as never,
      {
        observations: {
          ...base.observations,
          pipelineCensus: {
            version: 1,
            complete: true,
            overflowed: false,
            backend: { kind: "webgpu", identity: "webgpu:test" },
            clock: { source: "performance", originMs: 0 },
            build: { identity: "build:test" },
            adapter: { identity: "adapter:test", thermal: "unavailable" },
            firstPresent: { boundaryMs: 1, eventsSettled: 1 },
            warmUpSettled: { boundaryMs: 1, eventsSettled: 1, nodeBuilds: 1, renderPipelineCreations: 1 },
            warmUpScopes: [{
              label: "chunk:0",
              boundaryMs: 1.5,
              eventsSettled: 1,
              nodeBuilds: 1,
              renderPipelineCreations: 1,
              firstDraw: { nodeBuilds: 1, renderPipelineCreations: 1 },
            }],
            counts: {
              lookups: 2,
              creations: 2,
              failures: 0,
              pending: 0,
              uniquePrograms: 2,
              uniquePipelines: 2,
              recordedEvents: 2,
              droppedEvents: 0,
              nodeBuilds: 2,
            },
            events: [event(1, 1, true, 1), event(2, 2, false, 1)],
            incompleteReasons: [],
          },
        },
      },
    );

    expect(result.assertions.map(({ id, pass }) => ({ id, pass }))).toEqual([
      { id: "pipelineCensus.maxRenderPipelineCreationsAfterWarmUpScope", pass: false },
      { id: "pipelineCensus.maxNodeBuildsAfterWarmUpSettled", pass: false },
      { id: "pipelineCensus.maxRenderPipelineCreationsAfterWarmUpSettled", pass: false },
      { id: "diagnostics", pass: true },
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_PIPELINE_CENSUS_CEILING_EXCEEDED",
      "TN_PLAYTEST_PIPELINE_CENSUS_CEILING_EXCEEDED",
      "TN_PLAYTEST_PIPELINE_CENSUS_CEILING_EXCEEDED",
    ]);
  });

  test("movement pins its verdict id and minimum-distance details", () => {
    const result = evaluate(
      { movement: { entity: "player", minDistance: 1 } } as never,
      {
        expectMoved: true,
        before: { position: [0, 0, 0], tick: 0 },
        after: { position: [2, 0, 0], tick: 3 },
        movementDelta: [2, 0, 0],
        distance: 2,
      },
    );
    expect(result.assertions.map(({ id, pass }) => ({ id, pass }))).toEqual([
      { id: "diagnostics", pass: true },
      { id: "movement.distance", pass: true },
    ]);
    // `observed` joins the pin: minDistance now refuses to read a fallback zero as a measurement,
    // the way maxDistance already did, so the details say whether the entity was there at all.
    expect(result.assertions[1]?.details).toEqual({
      distance: 2,
      entity: "player",
      minimum: 1,
      observed: true,
    });
    expect(result.diagnostics).toEqual([]);
  });

  test("movement treats distance exactly equal to the minimum as passing", () => {
    // Boundary pin: >= not >. A flipped comparison must turn this row red.
    const atMinimum = evaluate(
      { movement: { entity: "player", minDistance: 2 } } as never,
      {
        expectMoved: true,
        before: { position: [0, 0, 0], tick: 0 },
        after: { position: [2, 0, 0], tick: 3 },
        movementDelta: [2, 0, 0],
        distance: 2,
      },
    );
    expect(atMinimum.assertions.find(({ id }) => id === "movement.distance")?.pass).toBe(true);

    const below = evaluate(
      { movement: { entity: "player", minDistance: 3 } } as never,
      {
        expectMoved: true,
        before: { position: [0, 0, 0], tick: 0 },
        after: { position: [2, 0, 0], tick: 3 },
        movementDelta: [2, 0, 0],
        distance: 2,
      },
    );
    expect(below.assertions.find(({ id }) => id === "movement.distance")?.pass).toBe(false);
  });

  test("world without a seed observation fails with its three-field detail shape", () => {
    const result = evaluate({ world: {} } as never);
    expect(result.assertions).toEqual([
      {
        details: { expectedRuntime: null, observed: null, observedRuntime: null },
        id: "world.seed",
        pass: false,
      },
      {
        details: {
          consoleErrors: 0,
          networkErrors: 0,
          policy: { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true },
          runtimeDiagnostics: 0,
        },
        id: "diagnostics",
        pass: true,
      },
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_WORLD_ASSERTION_FAILED"]);
  });

  test("states require terminal evidence even when the state already matches", () => {
    const result = evaluate(
      { states: [{ entity: "enemy", states: ["chase"] }] } as never,
      {
        observations: {
          console: [],
          hud: {},
          network: [],
          resources: {},
          runtimeObservations: { gameplay: { states: { enemy: "chase" } } },
        },
      },
    );
    const states = result.assertions.find(({ id }) => id === "states.enemy");
    expect(states?.pass).toBe(false);
    expect(states?.details).toMatchObject({
      candidates: [{ entity: "enemy", state: "chase" }],
      initialPass: true,
      observed: "chase",
      terminal: { contactObserved: true, historyComplete: true, preExisting: false, step: null },
      trivial: false,
    });
    expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_STATE_ASSERTION_FAILED");
  });

  test("a resource assertion with no rich evaluator registers as not-evaluated, never skipped", () => {
    const result = evaluate({ resources: [{ resources: ["gold"], type: "present" }] } as never);
    expect(result.assertions.find(({ id }) => id === "assert.resources")).toEqual({
      details: { reason: "registered-without-evaluator" },
      id: "assert.resources",
      pass: false,
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_ASSERTION_NOT_EVALUATED"]);
  });

  test("a blank capture fails the declared visual rows instead of passing them", () => {
    // Decided 2026-08-23: green rows for unevaluated assertions are the v1 dropped-assertion
    // shape this package fails closed against; a capture failure is a missing observation.
    const result = evaluate(
      { visual: [{ frameDiff: { minChangedPixelRatio: 0.01 } }] } as never,
      {
        observations: {
          console: [],
          hud: {},
          network: [],
          resources: {},
          visual: {
            captureFailure: { code: "TN_CAPTURE_BLANK", label: "after.png", reason: "uniform" },
          },
        },
      },
    );
    const row = result.assertions.find(({ id }) => id === "visual.0");
    expect(row?.pass).toBe(false);
    expect(row?.details).toMatchObject({
      captureFailure: { code: "TN_CAPTURE_BLANK" },
      reason: "not-evaluated",
    });
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "TN_PLAYTEST_ASSERTION_NOT_EVALUATED",
    );
  });

  test("evaluates element-bound raster evidence and fails for hidden or absent targets", () => {
    const assertion = { visual: [{ region: { element: { id: "threenative-canvas-error" }, minNonblankPixelRatio: 0.5 } }] } as never;
    const observed = {
      elementRegions: [{
        assertionIndex: 0,
        bounds: { height: 10, width: 10, x: 0, y: 0 },
        element: { id: "threenative-canvas-error" },
        nonblankPixelRatio: 0.8,
        rendered: true,
      }],
    };

    const positive = evaluate(assertion, { observations: { ...base.observations, visual: observed } });
    expect(positive.assertions.find(({ id }) => id === "visual.0.region")).toMatchObject({
      details: expect.objectContaining({
        bounds: { height: 10, width: 10, x: 0, y: 0 },
        element: { id: "threenative-canvas-error" },
        rendered: true,
      }),
      pass: true,
    });

    const hidden = evaluate(assertion, {
      observations: {
        ...base.observations,
        visual: {
          elementRegions: [{ ...observed.elementRegions[0], rendered: false }],
        },
      },
    });
    expect(hidden.assertions.find(({ id }) => id === "visual.0.region")).toMatchObject({
      details: expect.objectContaining({ rendered: false }),
      pass: false,
    });

    const absent = evaluate(assertion, {
      observations: {
        ...base.observations,
        visual: {
          elementRegions: [{
            assertionIndex: 0,
            element: { id: "threenative-canvas-error" },
            rendered: false,
          }],
        },
      },
    });
    expect(absent.assertions.find(({ id }) => id === "visual.0.region")).toMatchObject({
      details: expect.objectContaining({ bounds: undefined, rendered: false }),
      pass: false,
    });
  });

  test("empty assertion arrays register as not-evaluated per family, in family order", () => {
    const result = evaluate({ hud: [], resources: [], visual: [] } as never);
    const summary = result.assertions.map((entry) => ({ id: entry.id, pass: entry.pass }));
    expect(summary.filter((entry) => entry.id !== "diagnostics")).toEqual([
      { id: "assert.visual", pass: false },
      { id: "assert.resources", pass: false },
      { id: "assert.hud", pass: false },
    ]);
    expect(result.diagnostics.filter((d) => d.code === "TN_PLAYTEST_ASSERTION_NOT_EVALUATED")).toHaveLength(3);
  });

  test("composite scenarios keep a stable assertion order across families", () => {
    const result = evaluate(
      {
        reachability: { artifact: "unused", entities: ["a", "b"] },
        world: {},
      } as never,
      {
        observations: {
          console: [],
          hud: {},
          network: [],
          resources: {},
          entityTransforms: {
            a: { position: [0, 0, 0], scale: [1, 1, 1] },
            b: { position: [1, 0, 0], scale: [1, 1, 1] },
          },
        },
      },
    );
    expect(result.assertions.map(({ id }) => id)).toEqual([
      "reachability.0.a.b",
      "world.seed",
      "diagnostics",
    ]);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_REACHABILITY_ASSERTION_FAILED",
      "TN_PLAYTEST_WORLD_ASSERTION_FAILED",
    ]);
  });

  test("framebuffer coverage pins its diagnostic ladder in priority order", () => {
    const unreadable = evaluate(
      {
        framebufferCoverage: { backdrop: [0, 0, 0], tolerance: 0, window: { endStep: "x", startStep: "x" } },
      } as never,
      {
        observations: {
          console: [],
          framebufferCoverage: { unreadableReason: "no readback" },
          hud: {},
          network: [],
          resources: {},
        },
      },
    );
    expect(unreadable.diagnostics[0]?.code).toBe("TN_PLAYTEST_FRAMEBUFFER_PIXELS_UNREADABLE");

    const windowMissing = evaluate(
      {
        framebufferCoverage: { backdrop: [0, 0, 0], tolerance: 0, window: { endStep: "x", startStep: "x" } },
      } as never,
      {
        observations: {
          console: [],
          framebufferCoverage: { frameCount: 3, windowCompleted: false, windowStarted: true },
          hud: {},
          network: [],
          resources: {},
        } as never,
      },
    );
    expect(windowMissing.diagnostics[0]?.code).toBe("TN_PLAYTEST_FRAMEBUFFER_WINDOW_NOT_REACHED");
  });

  test("a camera-only scenario with nothing observed reports no evaluated assertions", () => {
    const result = evaluate({ camera: { follow: true, entity: "player" } } as never, {
      follow: { offset: [0, 2, 5] },
    });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_SCENARIO_NO_ASSERTIONS"]);
    expect(result.assertions.find(({ id }) => id === "scenario.assertions")?.details).toEqual({
      reason: "no-evaluated-assertions",
    });
  });
});
