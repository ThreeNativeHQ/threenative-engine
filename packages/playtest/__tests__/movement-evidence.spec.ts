import { describe, expect, test } from "vitest";

import { emitMovementEvidence } from "../src/evaluators/movement-evidence.js";
import { buildReport } from "../src/runner/runner-support.js";
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
  name: "movement",
  schemaVersion: 1,
  steps: [{ label: "goal", release: true, waitFrames: 1 }],
  subject: "player",
  target: "web",
};

function evaluate(assertion: unknown, report: Record<string, unknown> = {}, scenario: Record<string, unknown> = {}) {
  const assertions: Array<{ details?: Record<string, unknown>; id: string; pass: boolean }> = [];
  const diagnostics: Array<{ code: string; message: string; severity: "error" | "warning"; [key: string]: unknown }> = [];
  emitMovementEvidence({
    assertions,
    diagnostics,
    input: {
      report: {
        ...baseReport,
        ...report,
        observations: { ...baseReport.observations, ...(report.observations as object | undefined) },
      } as never,
      scenario: { ...baseScenario, ...scenario, assert: assertion } as never,
    },
    scenarioAssertions: assertion as never,
  });
  return { assertions, diagnostics };
}

function transform(
  entity: string,
  position: [number, number, number] = [0, 0, 0],
  rotation: [number, number, number, number] = [0, 0, 0, 1],
) {
  return { command: "setComponent", component: "Transform", entity, kind: "patch", value: { position, rotation } };
}

function move(entity: string, resolved: [number, number, number], direction?: [number, number]) {
  return {
    kind: "service",
    payload: {
      request: { entity, ...(direction === undefined ? {} : { options: { direction } }) },
      result: { entity, resolved },
    },
    service: "character.move",
  };
}

describe("movement evidence", () => {
  test("measures a named entity from its first observed step when warmup missed it", () => {
    const before = snapshot("player", [0, 0, 0]);
    const after = snapshot("player", [0, 0, -2]);
    const report = buildReport(
      reportConfig(),
      {
        ...baseScenario,
        assert: { movement: { entity: "player", minDistance: 1 } },
        viewport: { height: 180, width: 320 },
        warmupFrames: 1,
      } as never,
      undefined,
      undefined,
      [],
      [],
      undefined,
      {},
      true,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [{ before, after, inputDriven: true }],
    );

    expect(report.before?.position).toEqual([0, 0, 0]);
    expect(report.after?.position).toEqual([0, 0, -2]);
    expect(report.distance).toBe(2);
    expect((report.assertionResults ?? []).find(({ id }) => id === "movement.distance")).toMatchObject({
      details: { observed: true },
      pass: true,
    });
  });

  test("fails a named entity that was observed only once instead of inventing zero movement", () => {
    const report = buildReport(
      reportConfig(),
      {
        ...baseScenario,
        assert: { movement: { entity: "player", minDistance: 1 } },
        viewport: { height: 180, width: 320 },
        warmupFrames: 1,
      } as never,
      undefined,
      undefined,
      [],
      [],
      undefined,
      {},
      true,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      [{ before: snapshot("player", [0, 0, 0]), after: snapshot("ghost", [0, 0, 0]), inputDriven: false }],
    );

    expect(report.before).toBeUndefined();
    expect(report.after).toBeUndefined();
    expect(report.distance).toBe(0);
    expect((report.assertionResults ?? []).find(({ id }) => id === "movement.distance")).toMatchObject({
      details: { observed: false },
      pass: false,
    });
  });

  test("evaluates velocity, minimum distance, maximum distance, and path length", () => {
    const result = evaluate(
      { movement: { maxDistance: 3, minDistance: 1, minVelocity: 0.5, pathLength: 2 } },
      {
        after: { position: [2, 0, 0] },
        before: { position: [0, 0, 0] },
        distance: 2,
        frames: 2,
        pathLength: 2.5,
      },
    );
    expect(result.assertions.map(({ id, pass }) => ({ id, pass }))).toEqual([
      { id: "diagnostics", pass: true },
      { id: "movement.velocity", pass: true },
      { id: "movement.distance", pass: true },
      { id: "movement.maxDistance", pass: true },
      { id: "movement.pathLength", pass: true },
    ]);
    expect(result.diagnostics).toEqual([]);

    const failed = evaluate(
      { movement: { maxDistance: 0.5, minDistance: 3, minVelocity: 2, pathLength: 3 } },
      { after: { position: [1, 0, 0] }, before: { position: [0, 0, 0] }, distance: 1, frames: 2, pathLength: 1 },
    );
    expect(failed.assertions.filter(({ id }) => id !== "diagnostics").every(({ pass }) => !pass)).toBe(true);
    expect(failed.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_VELOCITY_ASSERTION_FAILED",
      "TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED",
      "TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED",
      "TN_PLAYTEST_PATH_LENGTH_ASSERTION_FAILED",
    ]);
  });

  test("does not treat an unobserved entity as a measured zero", () => {
    const result = evaluate(
      { movement: { entity: "ghost", maxDistance: 0.1, minDistance: 1, minVelocity: 1 } },
      { diagnostics: [{ code: "TN_PLAYTEST_INPUT_NO_EFFECT" }], distance: 0, frames: 0 },
    );
    expect(result.assertions.find(({ id }) => id === "movement.velocity")?.pass).toBe(false);
    expect(result.assertions.find(({ id }) => id === "movement.distance")?.details).toMatchObject({ observed: false });
    expect(result.assertions.find(({ id }) => id === "movement.maxDistance")?.details).toMatchObject({ observed: false });
    expect(result.diagnostics.map(({ code }) => code)).toEqual(["TN_PLAYTEST_VELOCITY_ASSERTION_FAILED", "TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED"]);
  });

  test("minVelocity and pathLength cannot pass on an entity that was never observed", () => {
    const result = evaluate(
      { movement: { entity: "ghost", minVelocity: 1, pathLength: 1 } },
      { distance: 5, frames: 5, pathLength: 5 },
    );
    expect(result.assertions.find(({ id }) => id === "movement.velocity")?.pass).toBe(false);
    expect(result.assertions.find(({ id }) => id === "movement.velocity")?.details).toMatchObject({ observed: false });
    expect(result.assertions.find(({ id }) => id === "movement.pathLength")?.pass).toBe(false);
    expect(result.assertions.find(({ id }) => id === "movement.pathLength")?.details).toMatchObject({ observed: false });
  });

  test("checks signed raw and resolved axis deltas, including invalid evidence", () => {
    const result = evaluate(
      { movement: { minAxisDelta: { axis: "+y", min: 2 }, minResolvedAxisDelta: { axis: "-z", min: 2 } } },
      {
        after: { position: [0, 2, 0] },
        before: { position: [0, 0, 0] },
        effectLog: effectLog([
          move("player", [0, 0, -3]),
        ]),
        movementDelta: [0, 2, 0],
      },
    );
    expect(result.assertions.find(({ id }) => id === "movement.axisDelta")?.pass).toBe(true);
    expect(result.assertions.find(({ id }) => id === "movement.resolvedAxisDelta")?.pass).toBe(true);

    const invalid = evaluate(
      { movement: { minAxisDelta: { axis: "bad", min: 1 }, minResolvedAxisDelta: { axis: "bad", min: 1 } } },
      { movementDelta: [1, 1, 1] },
    );
    expect(invalid.assertions.find(({ id }) => id === "movement.axisDelta")?.pass).toBe(false);
    expect(invalid.assertions.find(({ id }) => id === "movement.resolvedAxisDelta")?.pass).toBe(false);
    expect(invalid.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_AXIS_DELTA_ASSERTION_FAILED",
      "TN_PLAYTEST_RESOLVED_AXIS_DELTA_ASSERTION_FAILED",
    ]);
  });

  test("proves rotation changes and bounds final tilt through both evidence paths", () => {
    const changed = evaluate(
      { movement: { maxTiltDegrees: 10, rotationChanged: true } },
      {
        after: { rotation: [0, 0, 0, 1] },
        before: { rotation: [0, 0, 0, 0.99] },
        effectLog: effectLog([
          transform("player", [0, 0, 0]),
          transform("player", [0, 0, 0], [0, 0.2, 0, 0.98]),
        ]),
      },
    );
    expect(changed.assertions.find(({ id }) => id === "movement.rotation")?.pass).toBe(true);
    expect(changed.assertions.find(({ id }) => id === "movement.tilt")?.pass).toBe(true);

    const tilted = evaluate(
      { movement: { maxTiltDegrees: 10, rotationChanged: true } },
      { after: { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] }, before: { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } },
    );
    expect(tilted.assertions.find(({ id }) => id === "movement.rotation")?.pass).toBe(false);
    expect(tilted.assertions.find(({ id }) => id === "movement.tilt")?.pass).toBe(false);
    expect(tilted.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_ROTATION_ASSERTION_FAILED",
      "TN_PLAYTEST_TILT_ASSERTION_FAILED",
    ]);
  });

  test("checks distance closure and resolved/final position reach", () => {
    const result = evaluate(
      {
        movement: {
          closesDistanceToPosition: { min: 2, position: [10, 0, 0] },
          reachesPositionWithin: { atStep: "goal", maxDistance: 0.5, position: [3, 0, 0] },
        },
      },
      {
        after: { position: [9, 0, 0] },
        before: { position: [5, 0, 0] },
        effectLog: effectLog([move("player", [3, 0, 0])]),
        observations: {
          effectLogSeries: [{ label: "goal", snapshot: effectLog([move("player", [3, 0, 0])]), tick: 2 }],
        },
      },
    );
    expect(result.assertions.find(({ id }) => id === "movement.closesDistance")?.pass).toBe(true);
    expect(result.assertions.find(({ id }) => id === "movement.reachesPosition")?.pass).toBe(true);

    const failed = evaluate(
      { movement: { closesDistanceToPosition: { min: 1, position: [1, 0, 0] }, reachesPositionWithin: { atStep: "missing", maxDistance: 0.1, position: [1, 0, 0] } } },
      { after: undefined, before: undefined },
    );
    expect(failed.assertions.find(({ id }) => id === "movement.closesDistance")?.pass).toBe(false);
    expect(failed.assertions.find(({ id }) => id === "movement.reachesPosition")?.pass).toBe(false);
    expect(failed.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_DISTANCE_CLOSURE_ASSERTION_FAILED",
      "TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED",
    ]);
  });

  test("checks movement facing and excluded targets from entity and position evidence", () => {
    const log = [
      transform("player"),
      move("player", [1, 0, 0], [1, 0]),
      transform("player", [0, 0, 0], [0, Math.SQRT1_2, 0, Math.SQRT1_2]),
      transform("patrol", [0, 0, 1]),
    ];
    const result = evaluate(
      {
        movement: {
          facesMovementWithinDegrees: 1,
          notFacing: { entity: "patrol", minDegrees: 20 },
          notFacingPosition: { minDegrees: 20, position: [0, 0, 1] },
        },
      },
      { effectLog: effectLog(log) },
    );
    expect(result.assertions.find(({ id }) => id === "movement.facing")?.pass).toBe(false);
    expect(result.assertions.find(({ id }) => id === "movement.notFacing")?.pass).toBe(true);
    expect(result.assertions.find(({ id }) => id === "movement.notFacingPosition")?.pass).toBe(true);

    const missing = evaluate(
      { movement: { facesMovementWithinDegrees: 1, notFacing: { entity: "patrol", minDegrees: 20 }, notFacingPosition: { minDegrees: 20, position: [0, 0, 1] } } },
      { effectLog: effectLog([]) },
    );
    expect(missing.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_MOVEMENT_FACING_ASSERTION_FAILED",
      "TN_PLAYTEST_NOT_FACING_ASSERTION_FAILED",
      "TN_PLAYTEST_NOT_FACING_POSITION_ASSERTION_FAILED",
    ]);
  });

  test("evaluates visibility and keeps unsupported contact steps explicit", () => {
    const visibility = evaluate(
      { visibility: [{ entity: "player", present: true }] },
      { observations: { runtimeDiagnostics: { scene: { renderedEntities: [{ id: "player" }] } } } },
    );
    expect(visibility.assertions.find(({ id }) => id === "visibility.player")?.pass).toBe(true);

    const contacts = evaluate(
      {
        contacts: [
          { atStep: "missing", entity: "other", minCount: 1, requiredOn: ["android"] },
          { atStep: "missing", entity: "player", minCount: 1 },
        ],
      },
      {},
      { target: "web" },
    );
    expect(contacts.assertions.find(({ id }) => id === "contact.player")?.pass).toBe(false);
    expect(contacts.diagnostics[0]?.code).toBe("TN_PLAYTEST_CONTACT_STEP_NOT_OBSERVED");
  });

  test("fails occlusion and animation assertions when evidence is missing", () => {
    const result = evaluate(
      {
        animation: [{ entity: "player", finished: true }],
        occluded: [{ entity: "listener", target: "wall" }],
      },
      { effectLog: effectLog([]) },
    );
    expect(result.assertions.find(({ id }) => id === "occluded.listener")?.pass).toBe(false);
    expect(result.assertions.find(({ id }) => id === "animation.player")?.pass).toBe(false);
    expect(result.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_OCCLUSION_NOT_OBSERVED",
      "TN_PLAYTEST_ANIMATION_NOT_OBSERVED",
    ]);
  });

  test("marks registered assertion families that produce no result as failures", () => {
    const result = evaluate({ aerodynamics: [{ entity: "plane" }] });
    expect(result.assertions.find(({ id }) => id === "assert.aerodynamics")).toEqual({
      details: { reason: "registered-without-evaluator" },
      id: "assert.aerodynamics",
      pass: false,
    });
    expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_ASSERTION_NOT_EVALUATED");
  });

  test("reports a scenario that waives every triviality-eligible assertion", () => {
    const result = evaluate(
      { visibility: [{ allowTrivial: "the fixture is intentionally visible", entity: "player", present: true }] },
      {
        observations: {
          runtimeDiagnostics: { scene: { renderedEntities: [{ id: "player" }] } },
          runtimeDiagnosticsBefore: { scene: { renderedEntities: [{ id: "player" }] } },
        },
      },
    );
    expect(result.assertions.find(({ id }) => id === "visibility.player")?.pass).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_SCENARIO_ASSERTS_NOTHING");
  });
});

function effectLog(entries: unknown[]): { entries: unknown[] } {
  return { entries };
}

function snapshot(entity: string, position: [number, number, number]) {
  return {
    clock: { mode: "fixed-step" as const, tick: 1 },
    entities: [{ id: entity, transform: { position } }],
  };
}

function reportConfig() {
  return {
    artifactDirectory: "artifacts/test",
    headless: true,
    projectPath: ".",
    scenarioPath: "movement.playtest.json",
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
  };
}
