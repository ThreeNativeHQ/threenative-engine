import { describe, expect, test } from "vitest";

import {
  aerodynamicControlValues,
  aerodynamicForceSampleCount,
  aerodynamicTorqueAtLabel,
  allTrivialityEligibleAssertionsWaived,
  assertionEvaluatedByBaseProbe,
  assertionNotEvaluatedDiagnostic,
  bodySelector,
  componentValueChecks,
  evaluateDiagnosticsPolicy,
  evaluatePathAssertion,
  evaluateResourceAnyOfAssertion,
  evaluateVisibilityAssertion,
  hasFinalComponentExpectation,
  hasFinalPathExpectation,
  hasNativeReadinessSamples,
  horizontalRadius,
  matchingSignals,
  movementEnvelopeHorizontalLimit,
  overlayNodeObservationKey,
  physicsDebugBodyPositions,
  physicsDebugContactEvidence,
  physicsDebugMeanPoseDistance,
  physicsDebugOmittedBodies,
  physicsDebugSleepStates,
  platformTop,
  pathValuePass,
  projectedOffscreenRatio,
  projectedPixelsFromNdcBounds,
  rejectsTrivialAssertion,
  renderedEntitiesAreReported,
  renderedEntity,
  settledCandidate,
} from "../src/evaluators/measures.js";

const emptyObservations = { console: [], hud: {}, network: [], resources: {} };

function sleepSnapshot(primitives: unknown[]): unknown {
  return { artifact: { primitives } };
}

function report(overrides: Record<string, unknown> = {}): never {
  return {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectMoved: false,
    frames: 1,
    observations: emptyObservations,
    trivialityOptOuts: [],
    ...overrides,
  } as never;
}

describe("playtest evaluator measures", () => {
  test("computes horizontal radii, platform tops, and movement envelope limits", () => {
    expect(horizontalRadius(undefined, [1, 0])).toBe(0);
    expect(horizontalRadius({ halfExtents: [2, 0, 3] }, [-1, 2])).toBe(8);
    expect(horizontalRadius({ scale: [-4, 2, 6] }, [1, -1])).toBe(5);
    expect(platformTop({ position: [0, 2, 0], halfExtents: [1, 3, 1] })).toBe(5);
    expect(platformTop({ position: [0, 2, 0], scale: [1, -4, 1] })).toBe(4);
    expect(platformTop({})).toBe(0);
    const envelope = { fallDistanceToGround: 2, forwardReach: 4, maxRise: 1 };
    expect(movementEnvelopeHorizontalLimit(envelope, 2)).toBeUndefined();
    expect(movementEnvelopeHorizontalLimit(envelope, -2)).toBeUndefined();
    expect(movementEnvelopeHorizontalLimit(envelope, 1)).toBe(4);
    expect(movementEnvelopeHorizontalLimit({ fallDistanceToGround: 0, forwardReach: 4, maxRise: 0 }, 0)).toBe(4);
    expect(movementEnvelopeHorizontalLimit({ fallDistanceToGround: 0, forwardReach: 4, maxRise: 0 }, 1)).toBeUndefined();
  });

  test("extracts physics contact, sleep, overflow, and pose evidence safely", () => {
    const observations = {
      ...emptyObservations,
      physicsDebug: sleepSnapshot([
        null,
        { category: "contact", id: "player:wall" },
        { category: "contact", id: "player:wall" },
        { category: "sleep", entity: "crate1", value: 1 },
        { category: "sleep", entity: "crate2", value: 0 },
      ]),
      physicsDebugSeries: [{ snapshot: sleepSnapshot([{ category: "contact", id: "player:coin" }]), label: "step", tick: 1 }],
    };
    expect(physicsDebugContactEvidence(observations as never, "player", undefined)).toEqual({
      candidates: ["player:wall", "player:coin"],
      count: 3,
    });
    expect(physicsDebugContactEvidence(observations as never, "player", "coin", observations.physicsDebugSeries[0]?.snapshot)).toEqual({
      candidates: ["player:coin"],
      count: 1,
    });
    expect(physicsDebugSleepStates(observations.physicsDebug, "crate")).toEqual([
      { entity: "crate1", sleeping: true },
      { entity: "crate2", sleeping: false },
    ]);
    expect(physicsDebugSleepStates(undefined)).toEqual([]);
    expect(settledCandidate(observations.physicsDebug, "ghost")).toBeUndefined();
    expect(settledCandidate(observations.physicsDebug, "crate")).toMatchObject({ selector: "crate", bodies: [{ entity: "crate1" }, { entity: "crate2" }] });
    expect(settledCandidate(observations.physicsDebug, undefined)).toMatchObject({ selector: "crate", candidates: ["crate1", "crate2"] });
    expect(settledCandidate(undefined, undefined)).toBeUndefined();
    expect(bodySelector("crate12")).toBe("crate");
    expect(bodySelector("crate")).toBe("crate");
    expect(physicsDebugOmittedBodies(undefined)).toBe(0);
    expect(physicsDebugOmittedBodies({ artifact: { overflow: { omittedBodies: 3 } } })).toBe(3);
    expect(physicsDebugOmittedBodies({ artifact: { overflow: { omittedBodies: -1 } } })).toBe(1);
    expect(physicsDebugOmittedBodies({ artifact: { overflow: { omittedBodies: 1.5 } } })).toBe(1);

    const first = sleepSnapshot([
      { category: "center-of-mass", entity: "crate1", position: [0, 0, 0] },
      { category: "center-of-mass", entity: "crate2", position: [1, 0, 0] },
      { category: "center-of-mass", entity: "invalid", position: [0, Number.NaN, 0] },
    ]);
    const second = sleepSnapshot([{ category: "center-of-mass", entity: "crate1", position: [0, 0, 1] }]);
    expect(physicsDebugBodyPositions(first, "crate")).toEqual(new Map([["crate1", [0, 0, 0]], ["crate2", [1, 0, 0]]]));
    expect(physicsDebugBodyPositions(undefined, "crate")).toEqual(new Map());
    expect(physicsDebugMeanPoseDistance(first, second, "crate")).toEqual({ mean: 1, sharedBodies: 1 });
    expect(physicsDebugMeanPoseDistance(first, undefined, "crate")).toBeUndefined();
  });

  test("identifies base-probe coverage and stable observation keys", () => {
    expect(assertionEvaluatedByBaseProbe("movement", report({ expectMoved: true }))).toBe(true);
    expect(assertionEvaluatedByBaseProbe("movement", report({ expectAxis: "x" }))).toBe(true);
    expect(assertionEvaluatedByBaseProbe("camera", report({ follow: { offset: [0, 1, 2] } }))).toBe(true);
    expect(assertionEvaluatedByBaseProbe("resources", report())).toBe(false);
    expect(assertionNotEvaluatedDiagnostic("assert.resources", "no provider")).toMatchObject({
      code: "TN_PLAYTEST_ASSERTION_NOT_EVALUATED",
      message: "Declared assertion 'assert.resources' was not evaluated: no provider.",
    });
    expect(overlayNodeObservationKey("hud", "#score")).toBe("hud:#score");
  });

  test("evaluates path comparators, change guards, and resource alternatives", () => {
    const assertion = { changed: true, equals: 3, gte: 2, id: "score", lte: 4, path: "value", textIncludes: "3" } as never;
    const pass = evaluatePathAssertion("resource", assertion, { after: { value: 3 }, before: { value: 1 } }, {});
    expect(pass.assertion.pass).toBe(true);
    expect(evaluatePathAssertion("hud", { changed: false, id: "label" } as never, undefined, {}).assertion.pass).toBe(false);
    expect(evaluatePathAssertion("resource", { changed: false, id: "score" } as never, { after: 3, before: 3 }, {}).diagnostic).toBeUndefined();
    expect(evaluatePathAssertion("resource", { changed: true, id: "score" } as never, { after: 3, before: 3 }, {}).assertion.pass).toBe(false);
    const trivial = evaluatePathAssertion("resource", { equals: 3, id: "score" } as never, { after: 3, before: 3 }, {});
    expect(trivial.assertion.pass).toBe(false);
    expect(trivial.diagnostic?.code).toBe("TN_PLAYTEST_ASSERTION_TRIVIAL");
    expect(evaluatePathAssertion("resource", { allowTrivial: "held", equals: 3, id: "score" } as never, { after: 3, before: 3 }, {}).assertion.pass).toBe(true);

    const visible = evaluatePathAssertion(
      "hud",
      {
        allowTrivial: "The boot error is intentionally present before the first step.",
        id: "error",
        textIncludes: "boot failed",
        visible: true,
      } as never,
      {
        after: { text: "TN_TEST: boot failed", visible: true },
        before: { text: "TN_TEST: boot failed", visible: true },
      },
      {},
    );
    expect(visible.assertion.pass).toBe(true);
    expect(visible.assertion.details?.expected).toMatchObject({ textIncludes: "boot failed", visible: true });
    expect(evaluatePathAssertion("hud", { id: "error", visible: true } as never, { after: { text: "boot failed", visible: false } }, {}).assertion.pass).toBe(false);

    const alternative = evaluateResourceAnyOfAssertion(
      { anyOf: [{ gte: 10 }, { equals: 3 }], id: "score" } as never,
      { after: 3, before: 1 },
      {},
    );
    expect(alternative.assertion.pass).toBe(true);
    const noAlternative = evaluateResourceAnyOfAssertion({ anyOf: [{ gte: 10 }], id: "score" } as never, { after: 3, before: 1 }, {});
    expect(noAlternative.assertion.pass).toBe(false);
    expect(noAlternative.diagnostic?.code).toBe("TN_PLAYTEST_RESOURCE_ANY_OF_ASSERTION_FAILED");
    expect(rejectsTrivialAssertion("resources")).toBe(true);
    expect(rejectsTrivialAssertion("signals")).toBe(false);
    expect(allTrivialityEligibleAssertionsWaived([])).toBe(false);
    expect(allTrivialityEligibleAssertionsWaived([{ id: "diagnostics", pass: true }, { details: { trivialityOptOut: true }, id: "resource.score", pass: true }])).toBe(true);
    expect(allTrivialityEligibleAssertionsWaived([{ id: "resource.score", pass: true }])).toBe(false);
  });

  test("covers component, signal, and final-expectation helpers", () => {
    expect(componentValueChecks({ equals: 2, gte: 1, lte: 3 } as never, 2)).toEqual([true, true, true]);
    expect(componentValueChecks({ gte: 1 } as never, "1")).toEqual([false]);
    expect(matchingSignals(undefined, { name: "hit" } as never)).toBe(0);
    expect(matchingSignals([null, { name: "hit" }, { entity: "enemy", name: "hit" }, { entity: "player", name: "hit" }], { entity: "player", name: "hit" } as never)).toBe(1);
    expect(hasFinalPathExpectation({ id: "x" } as never)).toBe(false);
    expect(hasFinalPathExpectation({ gte: 1, id: "x" } as never)).toBe(true);
    expect(hasFinalComponentExpectation({ component: "C", entity: "e" } as never)).toBe(false);
    expect(hasFinalComponentExpectation({ changed: false, component: "C", entity: "e" } as never)).toBe(true);
    expect(pathValuePass({ id: "x" } as never, 1)).toBe(false);
    expect(pathValuePass({ equals: 1, id: "x" } as never, 1)).toBe(true);
    expect(pathValuePass({ gte: 1, id: "x" } as never, 0)).toBe(false);
    expect(pathValuePass({ lte: 1, id: "x" } as never, 2)).toBe(false);
    expect(pathValuePass({ textIncludes: "ok", id: "x" } as never, { text: "okay" })).toBe(true);
  });

  test("counts aerodynamic force samples and signed controls/torque", () => {
    const aeroSnapshot = {
      artifact: {
        primitives: [
          { category: "aero", entity: "plane", from: [1, 0, 0], to: [1, 1, 0], value: 2 },
          { category: "aero", entity: "plane", from: [1, 0, 0], to: [1, 1, 0], value: Number.NaN },
          { category: "sleep", entity: "plane", id: "sleep:plane", position: [0, 0, 0], value: 1 },
        ],
      },
    };
    const series = [{ label: "step", snapshot: aeroSnapshot, tick: 1 }];
    expect(aerodynamicForceSampleCount(series as never, "plane")).toBe(1);
    expect(aerodynamicForceSampleCount(undefined, "plane")).toBe(0);
    const controls = aerodynamicControlValues(
      { entries: [{ payload: { request: { entity: "plane", inputs: { surfaces: { elevator: -2 } } } }, service: "physics.aerodynamics.setInputs" }, { service: "other" }] },
      [{ label: "step", snapshot: { entries: [{ payload: { request: { entity: "plane", inputs: { surfaces: { elevator: 3 } } } }, service: "physics.aerodynamics.setInputs" }] }, tick: 1 }],
      "plane",
      "elevator",
    );
    expect(controls).toEqual([-2, 3]);
    expect(aerodynamicControlValues(undefined, undefined, "plane", "elevator")).toEqual([]);
    expect(aerodynamicTorqueAtLabel(undefined, "plane", "step")).toBeUndefined();
    expect(aerodynamicTorqueAtLabel(series as never, "plane", "step")).toEqual([0, 0, 2]);
    expect(aerodynamicTorqueAtLabel([{ label: "step", snapshot: { artifact: { primitives: [{ id: "sleep:plane", position: [0, 0] }] } }, tick: 1 }] as never, "plane", "step")).toBeUndefined();
  });

  test("reports diagnostic policy failures and renderer evidence", () => {
    const diagnostics = evaluateDiagnosticsPolicy(
      report({
        diagnostics: [{ code: "TN_PLAYTEST_RUNTIME_NOT_READY" }],
        observations: {
          ...emptyObservations,
          console: [{ type: "error" }],
          network: [{ method: "GET", url: "/missing" }],
          runtimeDiagnostics: { recentRuntimeErrors: ["runtime"] },
        },
      }),
      { noConsoleErrors: true, noNetworkErrors: true, noRuntimeDiagnostics: true, runtimeReady: true } as never,
    );
    expect(diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_RUNTIME_DIAGNOSTIC",
      "TN_PLAYTEST_CONSOLE_ERROR",
      "TN_PLAYTEST_NETWORK_ERROR",
      "TN_PLAYTEST_RUNTIME_DIAGNOSTIC",
    ]);
    expect(renderedEntitiesAreReported({ scene: { renderedEntities: [] } })).toBe(true);
    expect(renderedEntitiesAreReported({ scene: {} })).toBe(false);
    expect(renderedEntity({ scene: { renderedEntities: [{ id: "player" }] } }, "player")).toEqual({ id: "player" });
    expect(renderedEntity(undefined, "player")).toBeUndefined();
    expect(hasNativeReadinessSamples({ readiness: [] })).toBe(true);
    expect(hasNativeReadinessSamples({})).toBe(false);
  });

  test("evaluates projected visibility and native readiness failures", () => {
    const visible = { scene: { renderedEntities: [{ id: "player", projectedBounds: { min: [-0.5, -0.5], max: [0.5, 0.5] } }] } };
    const initial = { scene: { renderedEntities: [] } };
    const present = evaluateVisibilityAssertion({ present: true } as never, "player", { height: 100, width: 100 }, visible, initial);
    expect(present.assertion.pass).toBe(true);
    const absent = evaluateVisibilityAssertion({ present: true } as never, "player", { height: 100, width: 100 }, initial, initial);
    expect(absent.assertion.pass).toBe(false);
    const projected = evaluateVisibilityAssertion({ maxOffscreenRatio: 0.1, minProjectedPixels: 10 } as never, "player", { height: 100, width: 100 }, visible, initial);
    expect(projected.assertion.pass).toBe(true);
    const native = evaluateVisibilityAssertion({ minProjectedPixels: 10 } as never, "player", { height: 100, width: 100 }, { readiness: [] }, undefined);
    expect(native.assertion.pass).toBe(false);
    expect(native.diagnostic?.message).toContain("native target");
    const trivial = evaluateVisibilityAssertion({ allowTrivial: "fixture", minProjectedPixels: 10 } as never, "player", { height: 100, width: 100 }, visible, visible);
    expect(trivial.assertion.pass).toBe(true);
    expect(trivial.assertion.details).toMatchObject({ trivial: true, trivialityOptOut: true });
  });

  test("a box half off the right edge is half off-screen, and its pixels clamp to the viewport", () => {
    // NDC x runs from 0 to 2, so half the box lies on screen.
    // The clamped pixels cover half of a 200 by 100 viewport.
    expect(projectedOffscreenRatio([0, -1], [2, 1])).toBeCloseTo(0.5);
    expect(projectedPixelsFromNdcBounds([0, -1], [2, 1], { height: 100, width: 200 })).toBe(10_000);
  });
});
