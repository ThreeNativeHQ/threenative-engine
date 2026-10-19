import type { PlaytestFramePhase } from "../protocol.js";
import { PLAYTEST_FRAME_PASS_KINDS, type PlaytestFramePassKind } from "../protocol.js";
import type { IPlaytestAnimationAssertion, IPlaytestComponentAssertion, IPlaytestContactAssertion, IPlaytestPathAssertion, IPlaytestResourceAnyOfAssertion, IPlaytestScenario, IPlaytestSignalAssertion, IPlaytestStateAssertion, IPlaytestTagCountAssertion, IPlaytestVisibilityAssertion, IPlaytestWorldAssertion, IPlaytestPerformanceAssertion } from "../scenario.js";
import type { IPlaytestReport, IPlaytestDiagnosticsPolicy } from "../report.js";
import type { IPlaytestRuntimeDiagnosticsSample } from "../protocol.js";
import { renderedEntity, projectedPixelsFromNdcBounds } from "./measures.js";
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import { PLAYTEST_ASSERTION_REGISTRY } from "../assertion-schema.js";
import {
  type IPlaytestAssertionResult,
  type IPlaytestDiagnostic,
  type IPlaytestFramebufferCoverageObservation,
  type IPlaytestObservations,
  type MovementAxis,
  type Vec3,
  axisIndex,
  componentAssertionDiagnostic,
  consoleErrors,
  expectedPathAssertion,
  finiteVector,
  isRecord,
  jsonEqual,
  parseMovementAxisExpectation,
  pathAssertionDiagnostic,
  readPath,
  readRotation,
  readVec3,
  record,
  resolveDiagnosticsPolicy,
  sourcePathForSystem,
  runtimeDiagnostics,
  runtimeDiagnosticsSnapshot,
  textValue,
  trivialAssertionDiagnostic,
  vectorDistance,
} from "../assertion-report.js";

export function projectedPixelsForEntity(snapshot: unknown, entity: string, viewport: { height: number; width: number }): number | undefined {
  const rendered = renderedEntity(snapshot, entity);
  const bounds = isRecord(rendered?.projectedBounds) ? rendered.projectedBounds : undefined;
  const min = Array.isArray(bounds?.min) ? bounds.min : undefined;
  const max = Array.isArray(bounds?.max) ? bounds.max : undefined;
  return min === undefined || max === undefined
    ? undefined
    : projectedPixelsFromNdcBounds([Number(min[0]), Number(min[1])], [Number(max[0]), Number(max[1])], viewport);
}

export function countMatchingEntries(effectLog: unknown, tokens: readonly string[]): number {
  if (tokens.length === 0 || !isRecord(effectLog) || !Array.isArray(effectLog.entries)) {
    return 0;
  }
  return effectLog.entries.filter((entry) => {
    const text = JSON.stringify(entry);
    return tokens.every((token) => text.includes(token));
  }).length;
}

export function evaluatePerformanceAssertion(
  assertion: IPlaytestPerformanceAssertion,
  series: readonly unknown[] | undefined,
  sourcePath: string | undefined,
): { assertions: IPlaytestAssertionResult[]; diagnostics: IPlaytestDiagnostic[] } {
  const samples = series ?? [];
  const validSamples = samples.length > 0 && samples.every(isRuntimeDiagnosticsSample);
  const observed = validSamples ? samples as IPlaytestRuntimeDiagnosticsSample[] : [];
  const frameTimes = observed.map(({ frameMs }) => frameMs);
  const drawCalls = observed.flatMap(({ drawCalls: value }) => value === undefined ? [] : [value]);
  const triangles = observed.flatMap(({ triangles: value }) => value === undefined ? [] : [value]);
  const frameMsP95 = nearestRank(frameTimes, 0.95);
  const maxObservedDrawCalls = drawCalls.length === 0 ? undefined : Math.max(...drawCalls);
  const maxObservedTriangles = triangles.length === 0 ? undefined : Math.max(...triangles);
  const results: IPlaytestAssertionResult[] = [];
  const diagnostics: IPlaytestDiagnostic[] = [];
  const path = `${sourcePath ?? "playtest"}/observations.json/performanceSeries`;
  const samplesPass = validSamples;
  results.push({
    details: { sampleCount: samples.length, valid: validSamples },
    id: "performance.samples",
    pass: samplesPass,
  });
  if (!samplesPass) {
    diagnostics.push({
      code: "TN_PLAYTEST_PERFORMANCE_SAMPLES_MISSING",
      message: samples.length === 0
        ? "Performance assertion received no render samples."
        : "Performance assertion received an invalid render sample series.",
      observedRuntimePath: path,
      severity: "error",
      sourcePath,
      suggestion: "Run the scenario against the real render loop and keep the performance bridge provider installed.",
    });
  }

  const addBound = (
    id: string,
    expected: number,
    actual: number | undefined,
    unit: string,
    pass: boolean,
  ): void => {
    results.push({ details: { actual: actual ?? null, expected, sampleCount: samples.length, unit }, id, pass });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      message: `${id} expected at most ${expected} ${unit}, observed ${actual ?? "unavailable"}.`,
      observedRuntimePath: path,
      severity: "error",
      sourcePath,
      suggestion: "Inspect the recorded frame-cost series and reduce the authored scene cost that owns the regression.",
    });
  };

  if (assertion.maxFrameMsP95 !== undefined) {
    addBound(
      "performance.maxFrameMsP95",
      assertion.maxFrameMsP95,
      frameMsP95,
      "ms",
      samplesPass && frameMsP95 !== undefined && frameMsP95 <= assertion.maxFrameMsP95,
    );
  }
  if (assertion.maxDrawCalls !== undefined) {
    addBound(
      "performance.maxDrawCalls",
      assertion.maxDrawCalls,
      maxObservedDrawCalls,
      "draw calls",
      samplesPass && drawCalls.length === samples.length && maxObservedDrawCalls !== undefined && maxObservedDrawCalls <= assertion.maxDrawCalls,
    );
  }
  if (assertion.minFps !== undefined) {
    // A floor, not a ceiling, so it gets its own arm rather than a negated addBound: reporting
    // "expected at most 30 fps" for a floor is the kind of message that makes an agent fix the
    // wrong thing.
    // The verdict uses the exact fps. The report floors it to two places, so it never shows more
    // than was measured: 29.9967 reads 29.99, not 30.
    const exact = fpsFromFrameTimes(frameTimes);
    const observed = exact === undefined ? undefined : Math.floor(exact * 100) / 100;
    const pass = samplesPass && exact !== undefined && exact >= assertion.minFps;
    results.push({
      details: { actual: observed ?? null, expected: assertion.minFps, sampleCount: samples.length, unit: "fps" },
      id: "performance.minFps",
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      message: `performance.minFps expected at least ${assertion.minFps} fps, observed ${observed ?? "unavailable"}.`,
      observedRuntimePath: path,
      severity: "error",
      sourcePath,
      suggestion: "Read the TN_FRAME_BUDGET marker for this run: it names which frame phase owns the time.",
    });
  }
  if (assertion.maxPhaseMsP95 !== undefined) {
    for (const [phase, ceiling] of Object.entries(assertion.maxPhaseMsP95) as [PlaytestFramePhase, number][]) {
      // Fails closed twice over: a series whose samples carry no phase split cannot satisfy a
      // phase ceiling, and neither can a phase the engine never measured. Either one is a
      // failure naming the missing evidence, never a skipped bound.
      const measured = observed.flatMap(({ phases }) =>
        phases === undefined || typeof phases[phase] !== "number" ? [] : [phases[phase] as number]);
      const actual = measured.length === samples.length ? nearestRank(measured, 0.95) : undefined;
      const pass = samplesPass && actual !== undefined && actual <= ceiling;
      results.push({
        details: { actual: actual ?? null, expected: ceiling, phase, sampleCount: samples.length, unit: "ms" },
        id: `performance.maxPhaseMsP95.${phase}`,
        pass,
      });
      if (!pass) diagnostics.push({
        code: "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
        message: actual === undefined
          ? `performance.maxPhaseMsP95.${phase} received no frame-budget phase samples; the run produced ${measured.length} of ${samples.length}.`
          : `performance.maxPhaseMsP95.${phase} expected at most ${ceiling} ms, observed ${actual}.`,
        observedRuntimePath: path,
        severity: "error",
        sourcePath,
        suggestion: actual === undefined
          ? "Keep the engine frame budget installed: defineGame({ frameBudget: false }) silences the marker but a phase ceiling still needs the per-frame split."
          : "Reduce the cost of that phase, or move the ceiling and say why in the scenario.",
      });
    }
  }
  if (assertion.maxTriangles !== undefined) {
    addBound(
      "performance.maxTriangles",
      assertion.maxTriangles,
      maxObservedTriangles,
      "triangles",
      samplesPass && triangles.length === samples.length && maxObservedTriangles !== undefined && maxObservedTriangles <= assertion.maxTriangles,
    );
  }
  const addPassBound = (
    unit: "draws" | "triangles",
    kind: PlaytestFramePassKind,
    ceiling: number,
  ): void => {
    const noun = unit === "draws" ? "draw calls" : "triangles";
    // Fails closed twice over, like the phase bounds: a series carrying no pass split cannot
    // satisfy a per-pass ceiling, and neither can a frame that omitted the declared kind.
    // The producer aggregates a frame's render calls per kind, so `find` is that kind's total
    // rather than its first call: a shadow lane of 30 calls used to read as one call's draws.
    const measured = observed.flatMap((sample) => {
      const pass = sample.passes?.find((candidate) => candidate.kind === kind);
      return pass === undefined ? [] : [pass[unit]];
    });
    const actual = measured.length === samples.length ? Math.max(...measured) : undefined;
    const id = unit === "draws"
      ? `performance.maxPassDrawCalls.${kind}`
      : `performance.maxPassTriangles.${kind}`;
    const pass = samplesPass && actual !== undefined && actual <= ceiling;
    results.push({
      details: { actual: actual ?? null, expected: ceiling, pass: kind, sampleCount: samples.length, unit: noun },
      id,
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
      message: actual === undefined
        ? `${id} received no per-pass samples for '${kind}'; ${measured.length} of ${samples.length} frames carried that pass.`
        : `${id} expected at most ${ceiling} ${noun}, observed ${actual}.`,
      observedRuntimePath: path,
      severity: "error",
      sourcePath,
      suggestion: "Keep the engine frame budget installed so the run carries a per-pass split; a renderer that reports no split cannot satisfy a per-pass ceiling.",
    });
  };
  for (const [kind, ceiling] of Object.entries(assertion.maxPassDrawCalls ?? {}) as [PlaytestFramePassKind, number][])
    addPassBound("draws", kind, ceiling);
  for (const [kind, ceiling] of Object.entries(assertion.maxPassTriangles ?? {}) as [PlaytestFramePassKind, number][])
    addPassBound("triangles", kind, ceiling);
  return { assertions: results, diagnostics };
}

export function isRuntimeDiagnosticsSample(value: unknown): value is IPlaytestRuntimeDiagnosticsSample {
  if (!isRecord(value)
    || typeof value.frameMs !== "number"
    || !Number.isFinite(value.frameMs)
    || value.frameMs <= 0) {
    return false;
  }
  return (value.drawCalls === undefined || (typeof value.drawCalls === "number" && Number.isFinite(value.drawCalls) && value.drawCalls >= 0))
    && (value.triangles === undefined || (typeof value.triangles === "number" && Number.isFinite(value.triangles) && value.triangles >= 0))
    && isFramePhaseSplit(value.phases)
    && isFramePassSplit(value.passes);
}

/**
 * A per-pass split is optional, but a malformed one is not tolerated: an unknown pass kind or a
 * negative count would otherwise be counted as a valid sample whose pass bound silently evaluated
 * against nothing.
 */
function isFramePassSplit(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  return value.every((pass) =>
    isRecord(pass)
    && (PLAYTEST_FRAME_PASS_KINDS as readonly string[]).includes(pass.kind as string)
    && typeof pass.draws === "number"
    && Number.isFinite(pass.draws)
    && pass.draws >= 0
    && typeof pass.triangles === "number"
    && Number.isFinite(pass.triangles)
    && pass.triangles >= 0,
  );
}

/**
 * A phase split is optional, but a malformed one is not tolerated: a sample carrying
 * `phases: { render: "slow" }` would otherwise be counted as a valid sample whose render bound
 * silently evaluated against nothing.
 */
function isFramePhaseSplit(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry >= 0);
}

export function nearestRank(values: readonly number[], percentile: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(values.length * percentile) - 1)];
}

/**
 * The fps for both a floor and a parity ratio. It is the nearest-rank p50 frame time, unrounded.
 * One definition keeps both paths on the same series.
 */
export function fpsFromFrameTimes(frameTimes: readonly number[]): number | undefined {
  const frameMs = nearestRank(frameTimes, 0.5);
  return frameMs === undefined || frameMs <= 0 ? undefined : 1_000 / frameMs;
}

export function mergeEffectLogs(effectLog: unknown, series: IPlaytestObservations["effectLogSeries"]): { entries: unknown[] } {
  return {
    entries: [effectLog, ...(series ?? []).map((sample) => sample.snapshot)]
      .flatMap((log) => isRecord(log) && Array.isArray(log.entries) ? log.entries : []),
  };
}

export function matchingOccludedRaycasts(effectLog: unknown, entity: string | undefined, target: string | undefined): number {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) return 0;
  return effectLog.entries.filter((entry) => {
    if (!isRecord(entry) || (entry.service !== "render.sceneRayQuery" && entry.service !== "physics.raycast") || !isRecord(entry.payload) || !isRecord(entry.payload.result) || entry.payload.result.hit !== true) return false;
    const request = JSON.stringify(entry.payload.request ?? null);
    return (entity === undefined || request.includes(entity)) && (target === undefined || request.includes(target));
  }).length;
}

export function summarizeMatchingEntries(effectLog: unknown, tokens: readonly string[]): { entryCount: number; sourcePath?: string; systemId?: string; systems: string } | undefined {
  if (tokens.length === 0 || !isRecord(effectLog) || !Array.isArray(effectLog.entries)) {
    return undefined;
  }
  const entries = effectLog.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => {
      const text = JSON.stringify(entry);
      return tokens.every((token) => text.includes(token));
    });
  if (entries.length === 0) {
    return undefined;
  }
  const systems = new Set(entries.map((entry) => typeof entry.system === "string" ? entry.system : undefined).filter((item): item is string => item !== undefined));
  const firstSystem = [...systems][0];
  return {
    entryCount: entries.length,
    ...(firstSystem === undefined ? {} : { sourcePath: sourcePathForSystem(firstSystem), systemId: firstSystem }),
    systems: systems.size === 0 ? "unknown systems" : [...systems].slice(0, 5).join(", "),
  };
}

export function rotationDelta(
  effectLog: unknown,
  entityId: string,
  beforeRotation?: readonly [number, number, number, number],
  afterRotation?: readonly [number, number, number, number],
): number | undefined {
  if (isRecord(effectLog) && Array.isArray(effectLog.entries)) {
    const rotations = effectLog.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry.kind === "patch" && entry.command === "setComponent" && entry.component === "Transform" && entry.entity === entityId)
    .map((entry) => readRotation(entry.value))
    .filter((item): item is Vec3 => item !== undefined);
    const first = rotations[0];
    const last = rotations[rotations.length - 1];
    if (first !== undefined && last !== undefined) return vectorDistance(first, last);
  }
  return quaternionDelta(beforeRotation, afterRotation);
}

export function quaternionDelta(
  before: readonly [number, number, number, number] | undefined,
  after: readonly [number, number, number, number] | undefined,
): number | undefined {
  if (before === undefined || after === undefined) return undefined;
  const beforeLength = Math.hypot(...before);
  const afterLength = Math.hypot(...after);
  if (beforeLength <= Number.EPSILON || afterLength <= Number.EPSILON) return undefined;
  const dot = Math.abs((before[0] * after[0] + before[1] * after[1] + before[2] * after[2] + before[3] * after[3]) / (beforeLength * afterLength));
  return 2 * Math.acos(Math.max(-1, Math.min(1, dot)));
}

export function finalTiltDegrees(effectLog: unknown, entityId: string): number | undefined {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) return undefined;
  const rotation = effectLog.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry.kind === "patch" && entry.command === "setComponent" && entry.component === "Transform" && entry.entity === entityId)
    .map((entry) => isRecord(entry.value) ? entry.value.rotation : undefined)
    .filter((value): value is unknown[] => Array.isArray(value) && value.length >= 4)
    .at(-1);
  return tiltDegrees(rotation);
}

export function tiltDegrees(rotation: readonly unknown[] | undefined): number | undefined {
  if (rotation === undefined) return undefined;
  const quaternion = rotation.slice(0, 4).map((value) => typeof value === "number" && Number.isFinite(value) ? value : Number.NaN);
  if (!quaternion.every(Number.isFinite)) return undefined;
  const [x, y, z, w] = quaternion as [number, number, number, number];
  const length = Math.hypot(x, y, z, w);
  if (length <= Number.EPSILON) return undefined;
  const upDot = 1 - 2 * ((x / length) ** 2 + (z / length) ** 2);
  return Math.acos(Math.max(-1, Math.min(1, upDot))) * 180 / Math.PI;
}

export function movementFacingEvidence(effectLog: unknown, entityId: string): { maxErrorDegrees: number; sampleCount: number } {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) {
    return { maxErrorDegrees: Number.POSITIVE_INFINITY, sampleCount: 0 };
  }
  let yaw: number | undefined;
  const errors: number[] = [];
  for (const entry of effectLog.entries) {
    if (!isRecord(entry)) continue;
    if (entry.kind === "patch" && entry.command === "setComponent" && entry.component === "Transform" && entry.entity === entityId) {
      yaw = yawFromTransform(entry.value) ?? yaw;
      continue;
    }
    if (entry.kind !== "service" || entry.service !== "character.move" || yaw === undefined || !isRecord(entry.payload)) continue;
    const request = isRecord(entry.payload.request) ? entry.payload.request : undefined;
    const options = isRecord(request?.options) ? request.options : undefined;
    const direction = Array.isArray(options?.direction) ? options.direction : undefined;
    if (request?.entity !== entityId || direction === undefined || typeof direction[0] !== "number" || typeof direction[1] !== "number") continue;
    const heading = Math.atan2(direction[0], direction[1]);
    errors.push(Math.abs(wrappedAngle(heading - yaw)) * 180 / Math.PI);
  }
  return {
    maxErrorDegrees: errors.length === 0 ? Number.POSITIVE_INFINITY : Math.max(...errors),
    sampleCount: errors.length,
  };
}

export function finalFacingAngleToEntity(effectLog: unknown, entityId: string, targetId: string): number | undefined {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) return undefined;
  let subject: { position: Vec3; yaw: number } | undefined;
  let target: Vec3 | undefined;
  for (const entry of effectLog.entries) {
    if (!isRecord(entry)) continue;
    if (entry.kind === "service" && entry.service === "character.move" && isRecord(entry.payload)) {
      const result = isRecord(entry.payload.result) ? entry.payload.result : undefined;
      if (result?.entity === targetId) target = readVec3(result.resolved) ?? target;
      continue;
    }
    if (entry.kind !== "patch" || entry.command !== "setComponent" || entry.component !== "Transform") continue;
    if (entry.entity === entityId) {
      const position = isRecord(entry.value) ? readVec3(entry.value.position) : undefined;
      const yaw = yawFromTransform(entry.value);
      if (position !== undefined && yaw !== undefined) subject = { position, yaw };
    } else if (entry.entity === targetId && isRecord(entry.value)) {
      target = readVec3(entry.value.position) ?? target;
    }
  }
  if (subject === undefined || target === undefined) return undefined;
  const heading = Math.atan2(target[0] - subject.position[0], target[2] - subject.position[2]);
  return Math.abs(wrappedAngle(heading - subject.yaw)) * 180 / Math.PI;
}

export function finalFacingAngleToPosition(effectLog: unknown, entityId: string, target: readonly [number, number, number]): number | undefined {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) return undefined;
  let subject: { position: Vec3; yaw: number } | undefined;
  for (const entry of effectLog.entries) {
    if (!isRecord(entry) || entry.kind !== "patch" || entry.command !== "setComponent" || entry.component !== "Transform" || entry.entity !== entityId) continue;
    const position = isRecord(entry.value) ? readVec3(entry.value.position) : undefined;
    const yaw = yawFromTransform(entry.value);
    if (position !== undefined && yaw !== undefined) subject = { position, yaw };
  }
  if (subject === undefined) return undefined;
  const heading = Math.atan2(target[0] - subject.position[0], target[2] - subject.position[2]);
  return Math.abs(wrappedAngle(heading - subject.yaw)) * 180 / Math.PI;
}

export function yawFromTransform(value: unknown): number | undefined {
  if (!isRecord(value) || !Array.isArray(value.rotation) || value.rotation.length < 4) return undefined;
  const y = value.rotation[1];
  const w = value.rotation[3];
  return typeof y === "number" && Number.isFinite(y) && typeof w === "number" && Number.isFinite(w)
    ? 2 * Math.atan2(y, w)
    : undefined;
}

export function wrappedAngle(value: number): number {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

export function maxResolvedAxisDelta(
  effectLog: unknown,
  entityId: string,
  expectation: { axis: MovementAxis; sign?: 1 | -1 },
  baseline: Vec3 | undefined,
): number | undefined {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) {
    return undefined;
  }
  const index = axisIndex(expectation.axis);
  const resolvedValues = effectLog.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry.kind === "service" && entry.service === "character.move")
    .map((entry) => {
      const payload = isRecord(entry.payload) ? entry.payload : undefined;
      const result = isRecord(payload?.result) ? payload.result : undefined;
      return result?.entity === entityId ? readVec3(result.resolved) : undefined;
    })
    .filter((item): item is Vec3 => item !== undefined);
  const first = baseline ?? resolvedValues[0];
  if (first === undefined || resolvedValues.length === 0) {
    return undefined;
  }
  const sign = expectation.sign ?? 1;
  return Math.max(...resolvedValues.map((value) => (value[index] - first[index]) * sign));
}

export function minimumResolvedDistance(
  effectLog: unknown,
  effectLogSeries: unknown,
  entityId: string,
  target: Vec3,
  baseline: Vec3 | undefined,
  atStep: string | undefined,
): number | undefined {
  const logs = [
    ...(atStep === undefined ? [effectLog] : []),
    ...(Array.isArray(effectLogSeries)
      ? effectLogSeries
        .filter((item) => atStep === undefined || (isRecord(item) && item.label === atStep))
        .map((item) => isRecord(item) ? item.snapshot : undefined)
      : []),
  ];
  const positions = logs
    .flatMap((log) => isRecord(log) && Array.isArray(log.entries) ? log.entries : [])
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry.kind === "service" && entry.service === "character.move")
    .map((entry) => {
      const payload = isRecord(entry.payload) ? entry.payload : undefined;
      const result = isRecord(payload?.result) ? payload.result : undefined;
      return result?.entity === entityId ? readVec3(result.resolved) : undefined;
    })
    .filter((item): item is Vec3 => item !== undefined);
  if (baseline !== undefined && atStep === undefined) positions.unshift(baseline);
  return positions.length === 0
    ? undefined
    : Math.min(...positions.map((position) => vectorDistance(position, target)));
}




