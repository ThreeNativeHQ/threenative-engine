import { describe, expect, test } from "vitest";

import {
  countMatchingEntries,
  evaluatePerformanceAssertion,
  finalFacingAngleToEntity,
  finalFacingAngleToPosition,
  finalTiltDegrees,
  isRuntimeDiagnosticsSample,
  matchingOccludedRaycasts,
  maxResolvedAxisDelta,
  mergeEffectLogs,
  minimumResolvedDistance,
  movementFacingEvidence,
  nearestRank,
  projectedPixelsForEntity,
  quaternionDelta,
  rotationDelta,
  summarizeMatchingEntries,
  tiltDegrees,
  wrappedAngle,
  yawFromTransform,
} from "../src/evaluators/render-evidence.js";

const viewport = { height: 100, width: 200 };

function renderedSnapshot(projectedBounds: unknown): unknown {
  return { scene: { renderedEntities: [{ id: "player", projectedBounds }] } };
}

function runtimeSample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { frameMs: 10, ...overrides };
}

function effectLog(entries: unknown[]): { entries: unknown[] } {
  return { entries };
}

describe("render evidence", () => {
  test("projects reported entity bounds and fails when the report is absent", () => {
    expect(projectedPixelsForEntity(renderedSnapshot({ min: [-0.5, -0.25], max: [0.5, 0.25] }), "player", viewport)).toBe(2_500);
    expect(projectedPixelsForEntity({ scene: {} }, "player", viewport)).toBeUndefined();
    expect(projectedPixelsForEntity(renderedSnapshot(undefined), "ghost", viewport)).toBeUndefined();
  });

  test("clamps out-of-range NDC bounds to the viewport before counting pixels", () => {
    expect(projectedPixelsForEntity(renderedSnapshot({ min: [-2, -1], max: [0, 1] }), "player", viewport)).toBe(10_000);
  });

  test("minFps fails at 29.9967 against a floor of 30", () => {
    const frameMs = 1_000 / 29.9967;
    const samples = Array.from({ length: 4 }, () => ({ frameMs }));
    const result = evaluatePerformanceAssertion({ minFps: 30 }, samples, "test");
    const minFps = result.assertions.find(({ id }) => id === "performance.minFps");
    expect(minFps?.pass).toBe(false);
  });

  test("counts only entries containing every requested token", () => {
    const log = effectLog([{ entity: "player", service: "animation.play", clip: "run" }, { entity: "enemy" }]);
    expect(countMatchingEntries(undefined, ["player"])).toBe(0);
    expect(countMatchingEntries(log, [])).toBe(0);
    expect(countMatchingEntries(log, ["player", "run"])).toBe(1);
    expect(countMatchingEntries(log, ["player", "missing"])).toBe(0);
  });

  test("fails closed for empty and malformed performance series", () => {
    const empty = evaluatePerformanceAssertion(
      { maxDrawCalls: 1, maxFrameMsP95: 1, maxPhaseMsP95: { render: 1 }, maxTriangles: 1, minFps: 1 },
      [],
      "scenario.json",
    );
    expect(empty.assertions.every(({ pass }) => !pass)).toBe(true);
    expect(empty.diagnostics.map(({ code }) => code)).toEqual([
      "TN_PLAYTEST_PERFORMANCE_SAMPLES_MISSING",
      "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
    ]);

    const invalid = evaluatePerformanceAssertion(
      { maxFrameMsP95: 1 },
      [runtimeSample({ frameMs: 0 })],
      undefined,
    );
    expect(invalid.diagnostics[0]?.message).toContain("invalid render sample series");
    expect(invalid.diagnostics[0]?.observedRuntimePath).toBe("playtest/observations.json/performanceSeries");
  });

  test("evaluates every performance bound and reports each failed ceiling", () => {
    const series = [
      runtimeSample({ drawCalls: 2, phases: { render: 1, update: 0 }, triangles: 3 }),
      runtimeSample({ drawCalls: 4, phases: { render: 2, update: 1 }, triangles: 6 }),
    ];
    const passing = evaluatePerformanceAssertion(
      { maxDrawCalls: 4, maxFrameMsP95: 10, maxPhaseMsP95: { render: 2 }, maxTriangles: 6, minFps: 100 },
      series,
      "scenario.json",
    );
    expect(passing.assertions.map(({ pass }) => pass)).toEqual([true, true, true, true, true, true]);
    expect(passing.diagnostics).toEqual([]);

    const failing = evaluatePerformanceAssertion(
      { maxDrawCalls: 2, maxFrameMsP95: 5, maxPhaseMsP95: { render: 1, update: 0 }, maxTriangles: 3, minFps: 101 },
      series,
      "scenario.json",
    );
    expect(failing.assertions.map(({ pass }) => pass)).toEqual([true, false, false, false, false, false, false]);
    expect(failing.diagnostics).toHaveLength(6);
    expect(failing.diagnostics.every(({ code }) => code === "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED")).toBe(true);
  });

  test("requires complete optional metrics when a bound names them", () => {
    const result = evaluatePerformanceAssertion(
      { maxDrawCalls: 10, maxPhaseMsP95: { render: 10 }, maxTriangles: 10 },
      [runtimeSample(), runtimeSample({ phases: { render: 1 } })],
      "scenario.json",
    );
    expect(result.assertions.map(({ id, pass }) => ({ id, pass }))).toEqual([
      { id: "performance.samples", pass: true },
      { id: "performance.maxDrawCalls", pass: false },
      { id: "performance.maxPhaseMsP95.render", pass: false },
      { id: "performance.maxTriangles", pass: false },
    ]);
    expect(result.diagnostics).toHaveLength(3);
  });

  test("accepts finite runtime samples and rejects every malformed optional field", () => {
    expect(isRuntimeDiagnosticsSample(runtimeSample())).toBe(true);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ drawCalls: 0, phases: {}, triangles: 0 }))).toBe(true);
    expect(isRuntimeDiagnosticsSample(null)).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ frameMs: Number.NaN }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ frameMs: -1 }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ drawCalls: -1 }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ drawCalls: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ triangles: "3" }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ phases: null }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ phases: { render: "slow" } }))).toBe(false);
    expect(isRuntimeDiagnosticsSample(runtimeSample({ phases: { render: -1 } }))).toBe(false);
  });

  test("uses nearest-rank ordering and merges only valid effect-log entries", () => {
    expect(nearestRank([], 0.95)).toBeUndefined();
    expect(nearestRank([30, 10, 20], 0.5)).toBe(20);
    expect(mergeEffectLogs({ entries: ["base"] }, undefined)).toEqual({ entries: ["base"] });
    expect(mergeEffectLogs(undefined, [{ label: "a", snapshot: { entries: ["a"] }, tick: 1 }, { label: "b", snapshot: {}, tick: 2 }])).toEqual({ entries: ["a"] });
  });

  test("matches only successful occlusion raycasts with optional filters", () => {
    const log = effectLog([
      null,
      { service: "other", payload: { result: { hit: true } } },
      { service: "physics.raycast", payload: { result: { hit: false }, request: { entity: "listener", target: "wall" } } },
      { service: "render.sceneRayQuery", payload: { result: { hit: true }, request: { entity: "listener", target: "wall" } } },
      { service: "physics.raycast", payload: { result: { hit: true }, request: { entity: "listener", target: "pillar" } } },
    ]);
    expect(matchingOccludedRaycasts(undefined, undefined, undefined)).toBe(0);
    expect(matchingOccludedRaycasts(log, undefined, undefined)).toBe(2);
    expect(matchingOccludedRaycasts(log, "listener", "wall")).toBe(1);
    expect(matchingOccludedRaycasts(log, "missing", undefined)).toBe(0);
  });

  test("summarizes matching entries with and without owning systems", () => {
    const log = effectLog([
      { system: "pickup", value: "coin", entity: "player" },
      { system: "pickup", value: "coin", entity: "player" },
      { value: "coin", entity: "player" },
      "not a record",
    ]);
    expect(summarizeMatchingEntries(log, [])).toBeUndefined();
    expect(summarizeMatchingEntries(undefined, ["coin"])).toBeUndefined();
    expect(summarizeMatchingEntries(log, ["missing"])).toBeUndefined();
    expect(summarizeMatchingEntries(log, ["coin"])).toEqual({
      entryCount: 3,
      sourcePath: "content/systems/pickup.systems.json",
      systemId: "pickup",
      systems: "pickup",
    });
    expect(summarizeMatchingEntries(effectLog([{ value: "coin" }]), ["coin"])).toEqual({
      entryCount: 1,
      systems: "unknown systems",
    });
  });

  test("reads rotation deltas from effect logs and falls back to quaternions", () => {
    const log = effectLog([
      { command: "setComponent", component: "Transform", entity: "player", kind: "patch", value: { rotation: [0, 0, 0] } },
      { command: "setComponent", component: "Transform", entity: "player", kind: "patch", value: { rotation: [3, 4, 0] } },
    ]);
    expect(rotationDelta(log, "player")).toBe(5);
    expect(rotationDelta(effectLog([]), "player", [0, 0, 0, 1], [0, 0, 0, 1])).toBe(0);
    expect(rotationDelta(undefined, "player")).toBeUndefined();
    expect(quaternionDelta(undefined, [0, 0, 0, 1])).toBeUndefined();
    expect(quaternionDelta([0, 0, 0, 0], [0, 0, 0, 1])).toBeUndefined();
    expect(quaternionDelta([0, 0, 0, 1], [0, 0, 1, 0])).toBeCloseTo(Math.PI);
  });

  test("computes tilt, final tilt, and wrapped yaw safely", () => {
    expect(tiltDegrees(undefined)).toBeUndefined();
    expect(tiltDegrees([0, 0, 0, 1])).toBeCloseTo(0);
    expect(tiltDegrees([Math.SQRT1_2, 0, 0, Math.SQRT1_2])).toBeCloseTo(90);
    expect(tiltDegrees([0, 0, 0, 0])).toBeUndefined();
    expect(tiltDegrees(["bad", 0, 0, 1])).toBeUndefined();
    expect(finalTiltDegrees(undefined, "player")).toBeUndefined();
    expect(finalTiltDegrees(effectLog([{ kind: "patch", command: "setComponent", component: "Transform", entity: "player", value: { rotation: [0, 0, 0, 1] } }]), "player")).toBeCloseTo(0);
    expect(yawFromTransform({ rotation: [0, 0, 0, 1] })).toBe(0);
    expect(yawFromTransform({ rotation: [0, 0, 0] })).toBeUndefined();
    expect(yawFromTransform({ rotation: [0, "bad", 0, 1] })).toBeUndefined();
    expect(wrappedAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
  });

  test("extracts movement-facing and final-facing evidence only from matching entries", () => {
    const log = effectLog([
      "ignore",
      { component: "Transform", entity: "player", kind: "patch", command: "setComponent", value: { rotation: [0, 0, 0, 1] } },
      { kind: "service", service: "other", payload: {} },
      { kind: "service", service: "character.move", payload: { request: { entity: "enemy", options: { direction: [0, 1] } } } },
      { kind: "service", service: "character.move", payload: { request: { entity: "player", options: { direction: [1, 0] } } } },
      { kind: "service", service: "character.move", payload: { request: { entity: "player", options: { direction: [0, 1] } }, result: { entity: "target", resolved: [0, 0, 2] } } },
      { component: "Transform", entity: "player", kind: "patch", command: "setComponent", value: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } },
      { component: "Transform", entity: "target", kind: "patch", command: "setComponent", value: { position: [0, 0, 2], rotation: [0, 0, 0, 1] } },
    ]);
    expect(movementFacingEvidence(undefined, "player")).toEqual({ maxErrorDegrees: Number.POSITIVE_INFINITY, sampleCount: 0 });
    expect(movementFacingEvidence(log, "player")).toEqual({ maxErrorDegrees: 90, sampleCount: 2 });
    expect(finalFacingAngleToEntity(log, "player", "target")).toBeCloseTo(0);
    expect(finalFacingAngleToEntity(effectLog([]), "player", "target")).toBeUndefined();
    expect(finalFacingAngleToPosition(log, "player", [1, 0, 0])).toBeCloseTo(90);
    expect(finalFacingAngleToPosition(effectLog([]), "player", [0, 0, 1])).toBeUndefined();
  });

  test("tracks resolved axis movement and minimum distances across retained logs", () => {
    const series = [
      { label: "start", snapshot: effectLog([{ kind: "service", service: "character.move", payload: { result: { entity: "player", resolved: [0, 0, 0] } } }]), tick: 1 },
      { label: "goal", snapshot: effectLog([{ kind: "service", service: "character.move", payload: { result: { entity: "player", resolved: [3, 0, 0] } } }]), tick: 2 },
    ];
    expect(maxResolvedAxisDelta(undefined, "player", { axis: "x" }, undefined)).toBeUndefined();
    expect(maxResolvedAxisDelta(effectLog([{ kind: "service", service: "character.move", payload: { result: { entity: "player", resolved: [3, 0, 0] } } }]), "player", { axis: "x" }, [1, 0, 0])).toBe(2);
    expect(maxResolvedAxisDelta(effectLog([{ kind: "service", service: "character.move", payload: { result: { entity: "player", resolved: [0, 0, -3] } } }]), "player", { axis: "z", sign: -1 }, undefined)).toBeCloseTo(0);
    expect(minimumResolvedDistance(undefined, undefined, "player", [3, 0, 0], undefined, undefined)).toBeUndefined();
    expect(minimumResolvedDistance(undefined, series, "player", [3, 0, 0], [10, 0, 0], "goal")).toBe(0);
    expect(minimumResolvedDistance(series[1]?.snapshot, series, "player", [3, 0, 0], [10, 0, 0], undefined)).toBe(0);
  });
});
