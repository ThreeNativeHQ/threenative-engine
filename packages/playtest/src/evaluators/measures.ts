import type { IPlaytestAnimationAssertion, IPlaytestComponentAssertion, IPlaytestContactAssertion, IPlaytestPathAssertion, IPlaytestResourceAnyOfAssertion, IPlaytestScenario, IPlaytestSignalAssertion, IPlaytestStateAssertion, IPlaytestTagCountAssertion, IPlaytestVisibilityAssertion, IPlaytestWorldAssertion, IPlaytestPerformanceAssertion } from "../scenario.js";
import type { IPlaytestReport, IPlaytestDiagnosticsPolicy } from "../report.js";
import type { IPlaytestRuntimeDiagnosticsSample } from "../protocol.js";
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import { PLAYTEST_ASSERTION_REGISTRY } from "../assertion-schema.js";
import { perfWarnings } from "./perf-warnings.js";
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

export function horizontalRadius(
  transform: { halfExtents?: Vec3; scale?: Vec3 } | undefined,
  direction: readonly [number, number],
): number {
  const halfExtents = transform?.halfExtents
    ?? (transform?.scale === undefined ? undefined : transform.scale.map((value) => Math.abs(value) * 0.5) as Vec3);
  return halfExtents === undefined
    ? 0
    : Math.abs(direction[0]) * Math.abs(halfExtents[0]) + Math.abs(direction[1]) * Math.abs(halfExtents[2]);
}

export function platformTop(transform: { halfExtents?: Vec3; position?: Vec3; scale?: Vec3 }): number {
  const halfHeight = transform.halfExtents?.[1] ?? (transform.scale === undefined ? 0 : Math.abs(transform.scale[1]) * 0.5);
  return (transform.position?.[1] ?? 0) + halfHeight;
}

export function movementEnvelopeHorizontalLimit(
  envelope: { fallDistanceToGround: number; forwardReach: number; maxRise: number },
  rise: number,
): number | undefined {
  if (rise > envelope.maxRise) return undefined;
  const dropFromApex = envelope.maxRise - rise;
  if (dropFromApex > envelope.fallDistanceToGround) return undefined;
  if (envelope.maxRise === 0) return rise === 0 ? envelope.forwardReach : undefined;
  return envelope.forwardReach * (1 + Math.sqrt(dropFromApex / envelope.maxRise));
}

export interface IContactEvidence {
  candidates: string[];
  count: number;
}

export function physicsDebugContactEvidence(
  observations: IPlaytestObservations | undefined,
  entity: string | undefined,
  withEntity: string | undefined,
  selectedSnapshot?: unknown,
): IContactEvidence {
  const snapshots = selectedSnapshot === undefined
    ? [
        observations?.physicsDebug,
        ...(observations?.physicsDebugSeries ?? []).map((sample) => sample.snapshot),
      ]
    : [selectedSnapshot];
  const candidates: string[] = [];
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot) || !isRecord(snapshot.artifact) || !Array.isArray(snapshot.artifact.primitives)) continue;
    for (const primitive of snapshot.artifact.primitives) {
      if (!isRecord(primitive) || primitive.category !== "contact" || typeof primitive.id !== "string") continue;
      if (primitive.id.includes(entity ?? "") && (withEntity === undefined || primitive.id.includes(withEntity))) {
        candidates.push(primitive.id);
      }
    }
  }
  return { candidates: [...new Set(candidates)], count: candidates.length };
}

export function settledCandidate(
  snapshot: unknown,
  entity: string | undefined,
): { bodies: Array<{ entity: string; sleeping: boolean }>; candidates: string[]; selector: string } | undefined {
  const bodies = physicsDebugSleepStates(snapshot, entity);
  if (entity !== undefined) {
    return bodies.length === 0 ? undefined : { bodies, candidates: bodies.map(({ entity: body }) => body), selector: entity };
  }
  const groups = new Map<string, Array<{ entity: string; sleeping: boolean }>>();
  for (const body of bodies) {
    const selector = bodySelector(body.entity);
    const group = groups.get(selector) ?? [];
    group.push(body);
    groups.set(selector, group);
  }
  const selected = [...groups.entries()]
    .sort(([leftSelector, leftBodies], [rightSelector, rightBodies]) => rightBodies.length - leftBodies.length || leftSelector.localeCompare(rightSelector))[0];
  if (selected === undefined) return undefined;
  const [selector, selectedBodies] = selected;
  return { bodies: selectedBodies, candidates: selectedBodies.map(({ entity: body }) => body), selector };
}

export function bodySelector(entity: string): string {
  return /\d$/.test(entity) ? entity.replace(/\d+$/, "") : entity;
}

export function physicsDebugSleepStates(snapshot: unknown, entity?: string): Array<{ entity: string; sleeping: boolean }> {
  if (!isRecord(snapshot) || !isRecord(snapshot.artifact) || !Array.isArray(snapshot.artifact.primitives)) return [];
  return snapshot.artifact.primitives.flatMap((primitive) => {
    if (!isRecord(primitive)
      || primitive.category !== "sleep"
      || typeof primitive.entity !== "string"
      || (entity !== undefined && primitive.entity !== entity && !primitive.entity.startsWith(entity))
      || typeof primitive.value !== "number") return [];
    return [{ entity: primitive.entity, sleeping: primitive.value >= 1 }];
  });
}

export function physicsDebugOmittedBodies(snapshot: unknown): number {
  if (!isRecord(snapshot) || !isRecord(snapshot.artifact) || !isRecord(snapshot.artifact.overflow)) {
    return 0;
  }
  const omitted = snapshot.artifact.overflow.omittedBodies;
  return typeof omitted === "number" && Number.isInteger(omitted) && omitted >= 0 ? omitted : 1;
}

export function physicsDebugMeanPoseDistance(
  snapshot: unknown,
  comparisonSnapshot: unknown,
  entity: string,
): { mean: number; sharedBodies: number } | undefined {
  const positions = physicsDebugBodyPositions(snapshot, entity);
  const comparison = physicsDebugBodyPositions(comparisonSnapshot, entity);
  const distances = [...positions.entries()].flatMap(([id, position]) => {
    const other = comparison.get(id);
    return other === undefined
      ? []
      : [Math.hypot(position[0] - other[0], position[1] - other[1], position[2] - other[2])];
  });
  if (distances.length === 0) return undefined;
  return {
    mean: distances.reduce((sum, distance) => sum + distance, 0) / distances.length,
    sharedBodies: distances.length,
  };
}

export function physicsDebugBodyPositions(snapshot: unknown, entity: string): Map<string, [number, number, number]> {
  const positions = new Map<string, [number, number, number]>();
  if (!isRecord(snapshot) || !isRecord(snapshot.artifact) || !Array.isArray(snapshot.artifact.primitives)) return positions;
  for (const primitive of snapshot.artifact.primitives) {
    if (!isRecord(primitive)
      || primitive.category !== "center-of-mass"
      || typeof primitive.entity !== "string"
      || (primitive.entity !== entity && !primitive.entity.startsWith(entity))
      || !finiteVector(primitive.position)) continue;
    positions.set(primitive.entity, primitive.position as [number, number, number]);
  }
  return positions;
}

export function assertionEvaluatedByBaseProbe(
  kind: keyof NonNullable<IPlaytestScenario["assert"]>,
  report: IPlaytestReport,
): boolean {
  if (kind === "movement") return report.expectMoved || report.expectAxis !== undefined;
  if (kind === "camera") return report.follow !== undefined;
  return false;
}

export function assertionNotEvaluatedDiagnostic(id: string, reason: string): IPlaytestDiagnostic {
  return {
    code: "TN_PLAYTEST_ASSERTION_NOT_EVALUATED",
    message: `Declared assertion '${id}' was not evaluated: ${reason}.`,
    severity: "error",
    suggestion: "Run this assertion on a supported target or add its evaluator before treating the scenario as proof.",
  };
}

export function overlayNodeObservationKey(overlayId: string, selector: string): string {
  return `${overlayId}:${selector}`;
}


export function evaluatePathAssertion(
  kind: "hud" | "resource",
  assertion: IPlaytestPathAssertion,
  observed: { after?: unknown; before?: unknown } | undefined,
  context: { effectLog?: unknown; movedDistance?: number; scenarioSourcePath?: string },
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const before = readPath(observed?.before, assertion.path);
  const after = readPath(observed?.after, assertion.path);
  const valueChecksBefore: boolean[] = [];
  const valueChecksAfter: boolean[] = [];
  if (Object.hasOwn(assertion, "equals")) {
    valueChecksBefore.push(jsonEqual(before, assertion.equals));
    valueChecksAfter.push(jsonEqual(after, assertion.equals));
  }
  if (assertion.gte !== undefined) {
    valueChecksBefore.push(typeof before === "number" && before >= assertion.gte);
    valueChecksAfter.push(typeof after === "number" && after >= assertion.gte);
  }
  if (assertion.lte !== undefined) {
    valueChecksBefore.push(typeof before === "number" && before <= assertion.lte);
    valueChecksAfter.push(typeof after === "number" && after <= assertion.lte);
  }
  if (assertion.textIncludes !== undefined) {
    valueChecksBefore.push(String(textValue(before)).includes(assertion.textIncludes));
    valueChecksAfter.push(String(textValue(after)).includes(assertion.textIncludes));
  }
  if (assertion.visible !== undefined) {
    valueChecksBefore.push(isRecord(before) && before.visible === assertion.visible);
    valueChecksAfter.push(isRecord(after) && after.visible === assertion.visible);
  }
  const trivial = rejectsTrivialAssertion(kind === "hud" ? "hud" : "resources")
    && valueChecksBefore.length > 0
    && before !== undefined
    && valueChecksBefore.every(Boolean);
  const checks = [...valueChecksAfter];
  if (assertion.changed !== undefined) {
    // jsonEqual(undefined, undefined) is true, because JSON.stringify(undefined)
    // is undefined on both sides. Without the observed guard, `changed: false`
    // was satisfied by a value that never existed — and since observations.hud is
    // always {}, that made every hud changed:false assertion green.
    const observed = before !== undefined || after !== undefined;
    checks.push(observed && (assertion.changed ? !jsonEqual(before, after) : jsonEqual(before, after)));
  }
  const pass = checks.length > 0 && checks.every(Boolean) && (!trivial || typeof assertion.allowTrivial === "string");
  const result = {
    details: {
      after,
      before,
      expected: expectedPathAssertion(assertion),
      id: assertion.id,
      path: assertion.path,
      trivial,
      ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
    },
    id: `${kind}.${assertion.id}${assertion.path === undefined ? "" : `.${assertion.path}`}`,
    pass,
  };
  return pass
    ? { assertion: result }
    : {
        assertion: result,
        diagnostic: trivial && typeof assertion.allowTrivial !== "string"
          ? trivialAssertionDiagnostic(`${kind}.${assertion.id}`, assertion.path, before, context.scenarioSourcePath)
          : pathAssertionDiagnostic(kind, assertion, before, after, context),
      };
}

export function evaluateResourceAnyOfAssertion(
  assertion: IPlaytestResourceAnyOfAssertion,
  observed: { after?: unknown; before?: unknown } | undefined,
  context: { effectLog?: unknown; movedDistance?: number; scenarioSourcePath?: string },
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const alternatives = assertion.anyOf ?? [];
  const evaluated = alternatives.map((alternative) => evaluatePathAssertion(
    "resource",
    { ...alternative, id: assertion.id } as IPlaytestPathAssertion,
    observed,
    context,
  ));
  const passing = evaluated.find(({ assertion: result }) => result.pass);
  const result = {
    details: {
      alternatives: evaluated.map(({ assertion: alternative }) => alternative.details ?? {}),
      id: assertion.id,
      observed: observed ?? null,
    },
    id: `resource.${assertion.id}.anyOf`,
    pass: passing !== undefined,
  };
  return passing === undefined
    ? {
        assertion: result,
        diagnostic: {
          code: "TN_PLAYTEST_RESOURCE_ANY_OF_ASSERTION_FAILED",
          message: `No alternative path assertion for resource '${assertion.id}' passed.`,
          observedRuntimePath: `observations.json/resources/${assertion.id}`,
          severity: "error",
          suggestion: "Check the shared action input and the resource paths exposed by the runtime bridge.",
        },
      }
    : { assertion: result };
}

export function rejectsTrivialAssertion(kind: keyof NonNullable<IPlaytestScenario["assert"]>): boolean {
  return PLAYTEST_ASSERTION_REGISTRY.find((entry) => entry.kind === kind)?.triviality === "reject-initial-value";
}

export function allTrivialityEligibleAssertionsWaived(assertions: readonly IPlaytestAssertionResult[]): boolean {
  // Diagnostics is an automatically-added health check, not an independent gameplay assertion.
  const substantive = assertions.filter(({ id }) => id !== "diagnostics");
  return substantive.length > 0 && substantive.every(({ details }) => details?.trivialityOptOut === true);
}

export function componentValueChecks(assertion: IPlaytestComponentAssertion, value: unknown): boolean[] {
  const resolved = value;
  return [
    ...(Object.hasOwn(assertion, "equals") ? [jsonEqual(resolved, assertion.equals)] : []),
    ...(assertion.gte === undefined ? [] : [typeof resolved === "number" && resolved >= assertion.gte]),
    ...(assertion.lte === undefined ? [] : [typeof resolved === "number" && resolved <= assertion.lte]),
  ];
}

export function matchingSignals(events: unknown[] | undefined, assertion: IPlaytestSignalAssertion): number {
  if (events === undefined) return 0;
  let count = 0;
  for (const event of events) {
    if (!isRecord(event) || event.name !== assertion.name) continue;
    if (assertion.entity !== undefined && event.entity !== assertion.entity) continue;
    count += 1;
  }
  return count;
}


export function hasFinalPathExpectation(assertion: IPlaytestPathAssertion): boolean {
  return Object.hasOwn(assertion, "equals")
    || assertion.gte !== undefined
    || assertion.lte !== undefined
    || assertion.textIncludes !== undefined
    || assertion.changed !== undefined;
}

export function hasFinalComponentExpectation(assertion: IPlaytestComponentAssertion): boolean {
  return Object.hasOwn(assertion, "equals")
    || assertion.gte !== undefined
    || assertion.lte !== undefined
    || assertion.changed !== undefined;
}



export function pathValuePass(assertion: IPlaytestPathAssertion, value: unknown): boolean {
  const checks: boolean[] = [];
  if (Object.hasOwn(assertion, "equals")) checks.push(jsonEqual(value, assertion.equals));
  if (assertion.gte !== undefined) checks.push(typeof value === "number" && value >= assertion.gte);
  if (assertion.lte !== undefined) checks.push(typeof value === "number" && value <= assertion.lte);
  if (assertion.textIncludes !== undefined) checks.push(String(textValue(value)).includes(assertion.textIncludes));
  return checks.length > 0 && checks.every(Boolean);
}

export function aerodynamicForceSampleCount(series: IPlaytestObservations["physicsDebugSeries"], entity: string): number {
  return (series ?? []).filter(({ snapshot }) => {
    if (!isRecord(snapshot) || !isRecord(snapshot.artifact) || !Array.isArray(snapshot.artifact.primitives)) return false;
    return snapshot.artifact.primitives.some((primitive) => isRecord(primitive)
      && primitive.category === "aero"
      && primitive.entity === entity
      && typeof primitive.value === "number"
      && Number.isFinite(primitive.value)
      && finiteVector(primitive.from)
      && finiteVector(primitive.to));
  }).length;
}

export function aerodynamicControlValues(
  effectLog: unknown,
  series: IPlaytestObservations["effectLogSeries"],
  entity: string,
  surface: string,
): number[] {
  const logs = [effectLog, ...(series ?? []).map((sample) => sample.snapshot)];
  return logs.flatMap((log) => !isRecord(log) || !Array.isArray(log.entries) ? [] : log.entries.flatMap((entry) => {
    if (!isRecord(entry) || entry.service !== "physics.aerodynamics.setInputs" || !isRecord(entry.payload)) return [];
    const request = record(entry.payload.request);
    const inputs = record(request?.inputs);
    const surfaces = record(inputs?.surfaces);
    const value = surfaces?.[surface];
    return request?.entity === entity && typeof value === "number" && Number.isFinite(value) ? [value] : [];
  }));
}

export function aerodynamicTorqueAtLabel(series: IPlaytestObservations["physicsDebugSeries"], entity: string, label: string): Vec3 | undefined {
  const snapshot = (series ?? []).find((sample) => sample.label === label)?.snapshot;
  if (!isRecord(snapshot) || !isRecord(snapshot.artifact) || !Array.isArray(snapshot.artifact.primitives)) return undefined;
  const primitives = snapshot.artifact.primitives.filter(isRecord);
  const bodyPosition = primitives.find((primitive) => primitive.id === `sleep:${entity}`)?.position;
  if (!finiteVector(bodyPosition)) return undefined;
  const origin = bodyPosition as Vec3;
  const torque: Vec3 = [0, 0, 0];
  let samples = 0;
  for (const primitive of primitives) {
    if (primitive.category !== "aero" || primitive.entity !== entity || !finiteVector(primitive.from) || !finiteVector(primitive.to)) continue;
    const from = primitive.from as Vec3;
    const to = primitive.to as Vec3;
    const momentArm: Vec3 = [from[0] - origin[0], from[1] - origin[1], from[2] - origin[2]];
    const force: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const cross: Vec3 = [
      momentArm[1] * force[2] - momentArm[2] * force[1],
      momentArm[2] * force[0] - momentArm[0] * force[2],
      momentArm[0] * force[1] - momentArm[1] * force[0],
    ];
    torque[0] += cross[0];
    torque[1] += cross[1];
    torque[2] += cross[2];
    samples += 1;
  }
  return samples === 0 || !torque.every(Number.isFinite) ? undefined : torque;
}



export function evaluateDiagnosticsPolicy(
  report: IPlaytestReport,
  policy: IPlaytestDiagnosticsPolicy,
): IPlaytestDiagnostic[] {
  const diagnostics: IPlaytestDiagnostic[] = [];
  if (policy?.runtimeReady === true && report.diagnostics.some((diagnostic) => diagnostic.code === "TN_PLAYTEST_RUNTIME_NOT_READY")) {
    diagnostics.push({
      code: "TN_PLAYTEST_RUNTIME_DIAGNOSTIC",
      message: "Runtime did not reach ready state while diagnostics policy required it.",
      severity: "error",
      suggestion: "Inspect runtime diagnostics and bundle validation output before replaying the scenario.",
    });
  }
  if (report.observations?.console.some(({ text }) => /^\s*\[Playtest\] TN_V8_FRAME_FAILED:/u.test(text))) {
    diagnostics.push({
      code: "TN_PLAYTEST_NATIVE_FRAME_FAILED",
      message: "The native frame callback threw. A failed frame cannot pass a playtest.",
      severity: "error",
      suggestion: "Inspect console.json and fix the first TN_V8_FRAME_FAILED error.",
    });
  }
  // Not behind a policy flag: a perf warning is the engine saying the frame is slower than it needs to be.
  const warnings = perfWarnings((report.observations?.console ?? []).map(({ text }) => text));
  if (warnings.length > 0) {
    diagnostics.push({
      code: "TN_PLAYTEST_PERF_WARNING",
      message: `${warnings.length} engine performance warning(s): ${warnings.slice(0, 3).join(" | ")}`,
      severity: "error",
      suggestion: "Fix what the warning names (a unique geometry or material splitting a batch, a CPU-bound scene) or set renderer.projection: false when the game measured projection as a loss.",
    });
  }
  const capturedConsoleErrors = consoleErrors(report.observations?.console ?? []);
  if (policy.noConsoleErrors && capturedConsoleErrors.length > 0) {
    diagnostics.push({
      code: "TN_PLAYTEST_CONSOLE_ERROR",
      message: `${capturedConsoleErrors.length} browser console error(s) were captured during playtest.`,
      severity: "error",
      suggestion: "Open console.json in the playtest artifact directory and fix the first runtime error.",
    });
  }
  if (policy.noNetworkErrors && (report.observations?.network.length ?? 0) > 0) {
    diagnostics.push({
      code: "TN_PLAYTEST_NETWORK_ERROR",
      message: `${report.observations?.network.length ?? 0} failed network request(s) were captured after runtime readiness.`,
      severity: "error",
      suggestion: "Open network.json in the playtest artifact directory and fix missing asset or bundle paths.",
    });
  }
  const runtimeErrors = runtimeDiagnostics(report.observations?.runtimeDiagnostics);
  if (policy.noRuntimeDiagnostics && runtimeErrors.length > 0) {
    diagnostics.push({
      code: "TN_PLAYTEST_RUNTIME_DIAGNOSTIC",
      message: `${runtimeErrors.length} runtime diagnostic error(s) were captured during playtest.`,
      severity: "error",
      suggestion: "Inspect runtime-trace.json and repair the authored source that owns the diagnostic path.",
    });
  }
  return diagnostics;
}

export function renderedEntity(runtimeDiagnosticsValue: unknown, entity: string): Record<string, unknown> | undefined {
  if (!renderedEntitiesAreReported(runtimeDiagnosticsValue)) {
    return undefined;
  }
  return runtimeDiagnosticsValue.scene.renderedEntities.find((item): item is Record<string, unknown> => isRecord(item) && item.id === entity);
}

export function renderedEntitiesAreReported(runtimeDiagnosticsValue: unknown): runtimeDiagnosticsValue is { scene: { renderedEntities: unknown[] } } {
  return isRecord(runtimeDiagnosticsValue) && isRecord(runtimeDiagnosticsValue.scene) && Array.isArray(runtimeDiagnosticsValue.scene.renderedEntities);
}

export function projectedOffscreenRatio(min: [number, number], max: [number, number]): number {
  const width = Math.max(0, max[0] - min[0]);
  const height = Math.max(0, max[1] - min[1]);
  const area = width * height;
  if (area === 0) {
    return 1;
  }
  const visibleWidth = Math.max(0, Math.min(max[0], 1) - Math.max(min[0], -1));
  const visibleHeight = Math.max(0, Math.min(max[1], 1) - Math.max(min[1], -1));
  return 1 - Math.max(0, visibleWidth * visibleHeight) / area;
}

/** Pixels from NDC bounds, clamped to the viewport: an off-screen box must not report pixels outside the screen. */
export function projectedPixelsFromNdcBounds(
  min: [number, number],
  max: [number, number],
  viewport: { height: number; width: number },
): number {
  const clamp = (value: number): number => Math.min(1, Math.max(-1, value));
  const x0 = clamp(min[0]);
  const x1 = clamp(max[0]);
  const y0 = clamp(min[1]);
  const y1 = clamp(max[1]);
  return Math.max(0, ((x1 - x0) / 2) * viewport.width) * Math.max(0, ((y1 - y0) / 2) * viewport.height);
}

export function hasNativeReadinessSamples(runtimeDiagnosticsValue: unknown): boolean {
  return isRecord(runtimeDiagnosticsValue) && Array.isArray(runtimeDiagnosticsValue.readiness);
}

export function evaluateVisibilityAssertion(
  assertion: IPlaytestVisibilityAssertion,
  entity: string,
  viewport: { height: number; width: number },
  runtimeDiagnosticsValue: unknown,
  initialRuntimeDiagnosticsValue: unknown,
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const minProjectedPixels = assertion.minProjectedPixels;
  const maxOffscreenRatio = assertion.maxOffscreenRatio;
  const present = assertion.present;
  const diagnosticsSnapshot = runtimeDiagnosticsSnapshot(runtimeDiagnosticsValue);
  const rendered = renderedEntity(diagnosticsSnapshot, entity);
  const supportsProjectedBounds = renderedEntitiesAreReported(diagnosticsSnapshot);
  const initialSnapshot = runtimeDiagnosticsSnapshot(initialRuntimeDiagnosticsValue);
  const initialRendered = renderedEntity(initialSnapshot, entity);
  const initialObserved = initialRendered !== undefined;
  const initialBounds = isRecord(initialRendered?.projectedBounds) ? initialRendered.projectedBounds : undefined;
  const initialMin = Array.isArray(initialBounds?.min) ? initialBounds.min : undefined;
  const initialMax = Array.isArray(initialBounds?.max) ? initialBounds.max : undefined;
  const initialProjectedPixels = initialMin === undefined || initialMax === undefined
    ? undefined
    : projectedPixelsFromNdcBounds([Number(initialMin[0]), Number(initialMin[1])], [Number(initialMax[0]), Number(initialMax[1])], viewport);
  const initialOffscreenRatio = initialMin === undefined || initialMax === undefined
    ? undefined
    : projectedOffscreenRatio([Number(initialMin[0]), Number(initialMin[1])], [Number(initialMax[0]), Number(initialMax[1])]);
  const initialPass = present !== undefined && minProjectedPixels === undefined && maxOffscreenRatio === undefined
    ? initialObserved === present
    : initialRendered !== undefined
      && (present === undefined || present)
      && (minProjectedPixels === undefined || (initialProjectedPixels ?? 0) >= minProjectedPixels)
      && (maxOffscreenRatio === undefined || (initialOffscreenRatio ?? 1) <= maxOffscreenRatio);
  const guarded = (comparisonPass: boolean, details: Record<string, unknown>, failure: IPlaytestDiagnostic) => {
    const trivial = comparisonPass && initialPass;
    const pass = comparisonPass && (!trivial || typeof assertion.allowTrivial === "string");
    const result = {
      details: {
        ...details,
        expected: assertion,
        initialPass,
        trivial,
        ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
      },
      id: `visibility.${entity}`,
      pass,
    };
    return pass
      ? { assertion: result }
      : {
        assertion: result,
        diagnostic: trivial && typeof assertion.allowTrivial !== "string"
          ? trivialAssertionDiagnostic(result.id, undefined, true, undefined)
          : failure,
      };
  };
  if (present !== undefined && minProjectedPixels === undefined && maxOffscreenRatio === undefined) {
    const observed = rendered !== undefined;
    return guarded(observed === present, { entity, observed, present }, {
      code: "TN_PLAYTEST_VISIBILITY_FAILED",
      message: `Entity '${entity}' presence did not match the expected value.`,
      severity: "error",
      suggestion: "Check entity registration and streaming unload decisions.",
    });
  }
  if (!supportsProjectedBounds && hasNativeReadinessSamples(diagnosticsSnapshot)) {
    return guarded(false, {
      entity,
      maxOffscreenRatio,
      minProjectedPixels,
      reason: "native-projected-bounds-unavailable",
      skipped: false,
    }, {
      code: "TN_PLAYTEST_VISIBILITY_FAILED",
      message: `Entity '${entity}' projected bounds are unavailable on the native target.`,
      severity: "error",
      suggestion: "Expose rendered entity projected bounds or remove the projected-pixel assertion.",
    });
  }
  const bounds = isRecord(rendered?.projectedBounds) ? rendered.projectedBounds : undefined;
  const min = Array.isArray(bounds?.min) ? bounds.min : undefined;
  const max = Array.isArray(bounds?.max) ? bounds.max : undefined;
  const projectedPixels = min === undefined || max === undefined
    ? undefined
    : projectedPixelsFromNdcBounds([Number(min[0]), Number(min[1])], [Number(max[0]), Number(max[1])], viewport);
  const offscreenRatio = min === undefined || max === undefined ? undefined : projectedOffscreenRatio([Number(min[0]), Number(min[1])], [Number(max[0]), Number(max[1])]);
  const pass = rendered !== undefined
    && bounds !== undefined
    && (present === undefined || present)
    && (minProjectedPixels === undefined || (projectedPixels ?? 0) >= minProjectedPixels)
    && (maxOffscreenRatio === undefined || (offscreenRatio ?? 1) <= maxOffscreenRatio);
  return guarded(pass, { entity, maxOffscreenRatio, minProjectedPixels, offscreenRatio, present, projectedPixels }, {
    code: "TN_PLAYTEST_VISIBILITY_FAILED",
    message: `Entity '${entity}' did not satisfy projected visibility assertions.`,
    severity: "error",
    suggestion: "Check camera framing, clipping range, entity scale, and viewport-specific layout.",
  });
}
