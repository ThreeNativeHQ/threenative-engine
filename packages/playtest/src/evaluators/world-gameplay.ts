import { readPath, jsonEqual, trivialAssertionDiagnostic, componentAssertionDiagnostic, axisIndex } from '../assertion-report.js';
// Extracted from assertion-evaluators.ts (PRD-182 Phase 2).
import type { IEvaluationContext } from "./context.js";
import { hasFinalComponentExpectation, rejectsTrivialAssertion, componentValueChecks, aerodynamicForceSampleCount, aerodynamicControlValues, aerodynamicTorqueAtLabel, evaluatePathAssertion, evaluateTagCountAssertion, evaluateStateAssertion } from "./helpers.js";

export function emitWorldGameplay(ctx: IEvaluationContext): void {
  const { assertions, diagnostics } = ctx;
  const { input, scenarioAssertions } = ctx;
  const terrain = input.report.observations?.components?.terrain;
  const terrainRequired = terrain !== undefined
    || (scenarioAssertions.components ?? []).some(({ entity }) => entity === "terrain");
  if (terrainRequired) {
    const terrainAfter = terrain === undefined
      ? undefined
      : Object.fromEntries(Object.entries(terrain).map(([name, sample]) => [name, sample.after]));
    emitWorldTopology(terrainAfter, assertions, diagnostics);
  }
  for (const assertion of scenarioAssertions.components ?? []) {
    const observed = input.report.observations?.components?.[assertion.entity]?.[assertion.component];
    const before = readPath(observed?.before, assertion.path);
    const after = readPath(observed?.after, assertion.path);
    if (hasFinalComponentExpectation(assertion)) {
      const valueChecks = [
        ...(Object.hasOwn(assertion, "equals") ? [jsonEqual(after, assertion.equals)] : []),
        ...(assertion.gte === undefined ? [] : [typeof after === "number" && after >= assertion.gte]),
        ...(assertion.lte === undefined ? [] : [typeof after === "number" && after <= assertion.lte]),
      ];
      const checks = [
        ...valueChecks,
        // A temporal comparison needs both observations; appearance or disappearance is not a measured change.
        ...(assertion.changed === undefined
          ? []
          : [(before !== undefined && after !== undefined)
            && (assertion.changed ? !jsonEqual(before, after) : jsonEqual(before, after))]),
      ];
      const trivial = rejectsTrivialAssertion("components")
        && assertion.changed === undefined
        && valueChecks.length > 0
        && before !== undefined
        && componentValueChecks(assertion, before).every(Boolean);
      const pass = checks.length > 0 && checks.every(Boolean) && (!trivial || typeof assertion.allowTrivial === "string");
      assertions.push({
        details: {
          after,
          before,
          component: assertion.component,
          entity: assertion.entity,
          expected: assertion,
          trivial,
          ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
        },
        id: `component.${assertion.entity}.${assertion.component}.${assertion.path ?? "value"}`,
        pass,
      });
      if (!pass) diagnostics.push(trivial && typeof assertion.allowTrivial !== "string"
        ? trivialAssertionDiagnostic(`component.${assertion.entity}.${assertion.component}.${assertion.path ?? "value"}`, assertion.path, before, input.scenario.sourcePath)
        : componentAssertionDiagnostic(assertion, before, after));
    }
    if ((assertion.atSteps?.length ?? 0) > 0) {
      const samples = assertion.atSteps!.map((expected) => {
        const sample = (input.report.observations?.componentSeries ?? []).find((candidate) => candidate.label === expected.label);
        const value = readPath(sample?.snapshots[assertion.entity]?.[assertion.component], assertion.path);
        return { expected, pass: sample !== undefined && Object.hasOwn(expected, "equals") && jsonEqual(value, expected.equals), value };
      });
      const pass = samples.every((sample) => sample.pass);
      assertions.push({ details: { samples }, id: `component.${assertion.entity}.${assertion.component}.${assertion.path ?? "value"}.atSteps`, pass });
      if (!pass) diagnostics.push({
        code: "TN_PLAYTEST_COMPONENT_TRANSITION_ASSERTION_FAILED",
        message: `Component '${assertion.component}' on entity '${assertion.entity}'${assertion.path === undefined ? "" : ` path '${assertion.path}'`} did not match the expected labeled-step transition.`,
        observedRuntimePath: "observations.json/componentSeries",
        severity: "error",
        suggestion: "Inspect the labeled component samples and fix the runtime component transition.",
      });
    }
  }
  for (const [index, assertion] of (scenarioAssertions.aerodynamics ?? []).entries()) {
    const forceSamples = aerodynamicForceSampleCount(input.report.observations?.physicsDebugSeries, assertion.entity);
    const controlsSupported = input.scenario.target === "web";
    const controls = (assertion.controls ?? []).map((control) => ({
      ...control,
      observed: aerodynamicControlValues(
        input.report.effectLog ?? input.report.observations?.effectLog,
        input.report.observations?.effectLogSeries,
        assertion.entity,
        control.surface,
      ),
      ...(controlsSupported ? {} : { skipped: true, reason: "native-service-log-unavailable" }),
    }));
    const torques = (assertion.torques ?? []).map((torque) => {
      const value = aerodynamicTorqueAtLabel(input.report.observations?.physicsDebugSeries, assertion.entity, torque.label)?.[axisIndex(torque.axis)];
      const relative = torque.relativeToLabel === undefined
        ? undefined
        : aerodynamicTorqueAtLabel(input.report.observations?.physicsDebugSeries, assertion.entity, torque.relativeToLabel)?.[axisIndex(torque.axis)];
      return { ...torque, observed: value === undefined || (torque.relativeToLabel !== undefined && relative === undefined) ? undefined : value - (relative ?? 0) };
    });
    const forcePass = assertion.minForceSamples === undefined || forceSamples >= assertion.minForceSamples;
    const controlsPass = controlsSupported
      ? controls.every((control) => control.observed.some((value) => Math.abs(value) >= (control.minAbs ?? 0.01) && (control.sign === "positive" ? value > 0 : value < 0)))
      : torques.length > 0;
    const torquesPass = torques.every((torque) => torque.observed !== undefined
      && Math.abs(torque.observed) >= (torque.minAbs ?? 0.01)
      && (torque.sign === "positive" ? torque.observed > 0 : torque.observed < 0));
    const pass = forcePass && controlsPass && torquesPass && (assertion.minForceSamples !== undefined || controls.length > 0 || torques.length > 0);
    assertions.push({ details: { controls, forceSamples, minimumForceSamples: assertion.minForceSamples, torques }, id: `aerodynamics.${index}`, pass });
    if (!pass) {
      diagnostics.push({
        artifactPath: assertion.minForceSamples !== undefined ? "observations.json" : "effect-log.json",
        code: "TN_PLAYTEST_AERODYNAMICS_ASSERTION_FAILED",
        message: `Aerodynamic proof for '${assertion.entity}' did not observe the required finite force samples and signed control values.`,
        observedRuntimePath: "observations.json/physicsDebugSeries/artifact/primitives[category=aero] | effect-log.json/entries[service=physics.aerodynamics.setInputs]",
        severity: "error",
        suggestion: "Check AerodynamicBody metadata, physics debug capture, input-axis bindings, and surface sign mapping.",
      });
    }
  }
  for (const assertion of scenarioAssertions.hud ?? []) {
    const result = evaluatePathAssertion("hud", assertion, input.report.observations?.hud[assertion.id], {});
    assertions.push(result.assertion);
    if (result.diagnostic !== undefined) {
      diagnostics.push({ ...result.diagnostic, code: result.diagnostic.code || "TN_PLAYTEST_HUD_ASSERTION_FAILED" });
    }
  }
  for (const assertion of scenarioAssertions.tags ?? []) {
    const result = evaluateTagCountAssertion(assertion, input.report.observations?.runtimeObservations);
    assertions.push(result.assertion);
    if (result.diagnostic !== undefined) {
      diagnostics.push(result.diagnostic);
    }
  }
  for (const [stateIndex, assertion] of (scenarioAssertions.states ?? []).entries()) {
    const result = evaluateStateAssertion(assertion, input.report.observations, input.scenario, stateIndex);
    assertions.push(result.assertion);
    if (result.diagnostic !== undefined) {
      diagnostics.push(result.diagnostic);
    }
  }
}

export interface IWorldTopologyField {
  readonly columns: number;
  readonly depth: number;
  readonly heights?: ArrayLike<number>;
  readonly metrics?: IWorldTopologyMetrics;
  readonly rows: number;
  readonly width: number;
  readonly flow?: ArrayLike<number>;
}

export interface IWorldTopologyMetrics {
  readonly directionalAnisotropy: number;
  readonly powerSpectrumSlope: number;
  readonly reliefFieldEdge: number;
  readonly median64mRelief: number;
  readonly maxHortonStrahlerOrder: number;
  readonly profileCurvatureExcessKurtosis: number;
  readonly effectiveVertexDensityPerKm2: number;
  readonly slopeTailAbove30Degrees: number;
}

const WORLD_TOPOLOGY_METRIC_FAILURES: Record<keyof IWorldTopologyMetrics, string> = {
  directionalAnisotropy: "directional-anisotropy",
  powerSpectrumSlope: "power-spectrum-slope",
  reliefFieldEdge: "relief-field-edge",
  median64mRelief: "median-64m-relief",
  maxHortonStrahlerOrder: "horton-strahler-order",
  profileCurvatureExcessKurtosis: "curvature-excess-kurtosis",
  effectiveVertexDensityPerKm2: "effective-vertex-density",
  slopeTailAbove30Degrees: "slope-tail-above-30-degrees",
};

const WORLD_TOPOLOGY_MEASUREMENT_SIZE = 1024;

export interface IWorldTopologyThresholds {
  readonly maxDirectionalAnisotropy: number;
  readonly minPowerSpectrumSlope: number;
  readonly maxPowerSpectrumSlope: number;
  readonly minReliefFieldEdge: number;
  readonly maxMedian64mRelief: number;
  readonly minHortonStrahlerOrder: number;
  readonly minProfileCurvatureExcessKurtosis: number;
  readonly minEffectiveVertexDensityPerKm2: number;
  readonly minSlopeTailAbove30Degrees: number;
}

export const DEFAULT_WORLD_TOPOLOGY_THRESHOLDS: IWorldTopologyThresholds = {
  maxDirectionalAnisotropy: 0.1,
  minPowerSpectrumSlope: 2.5,
  maxPowerSpectrumSlope: 5,
  minReliefFieldEdge: 0.1,
  maxMedian64mRelief: 0.25,
  minHortonStrahlerOrder: 5,
  minProfileCurvatureExcessKurtosis: 5,
  minEffectiveVertexDensityPerKm2: 500_000,
  minSlopeTailAbove30Degrees: 0.1,
};

export interface IWorldTopologyEvaluation {
  readonly metrics: IWorldTopologyMetrics;
  readonly pass: boolean;
  readonly failed: readonly string[];
}

function topologyNumber(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum)
    throw new Error(`World topology ${name} must be finite and at least ${String(minimum)}.`);
  return value;
}

function rawHeights(field: IWorldTopologyField): ArrayLike<number> {
  if (field.heights === undefined) throw new Error("World topology raw heights are missing.");
  return field.heights;
}

function rawFlow(field: IWorldTopologyField): ArrayLike<number> {
  if (field.flow === undefined) throw new Error("World topology raw flow is missing.");
  return field.flow;
}

function topologyField(field: IWorldTopologyField): void {
  if (field === null || typeof field !== "object")
    throw new Error("World topology field must be an object.");
  const rows = topologyNumber(field.rows, "rows", 2);
  const columns = topologyNumber(field.columns, "columns", 2);
  if (!Number.isInteger(rows) || !Number.isInteger(columns))
    throw new Error("World topology rows and columns must be integers.");
  const width = topologyNumber(field.width, "width", Number.EPSILON);
  const depth = topologyNumber(field.depth, "depth", Number.EPSILON);
  if (width !== WORLD_TOPOLOGY_MEASUREMENT_SIZE || depth !== WORLD_TOPOLOGY_MEASUREMENT_SIZE)
    throw new Error(
      `World topology must cover the declared ${String(WORLD_TOPOLOGY_MEASUREMENT_SIZE)}m by ${String(WORLD_TOPOLOGY_MEASUREMENT_SIZE)}m measurement region.`,
    );
  if (field.metrics !== undefined) {
    if (field.heights !== undefined || field.flow !== undefined)
      throw new Error("World topology metrics cannot be combined with raw channels.");
    for (const name of Object.keys(WORLD_TOPOLOGY_METRIC_FAILURES) as Array<keyof IWorldTopologyMetrics>)
      topologyNumber(field.metrics[name], `metrics.${name}`, Number.NEGATIVE_INFINITY);
    return;
  }
  if (field.heights === undefined || typeof field.heights.length !== "number")
    throw new Error("World topology heights must be an array-like channel.");
  const expected = rows * columns;
  if (field.heights.length !== expected)
    throw new Error("World topology heights must contain rows times columns samples.");
  for (let index = 0; index < field.heights.length; index += 1)
    topologyNumber(field.heights[index], "height", Number.NEGATIVE_INFINITY);
  if (field.flow === undefined || typeof field.flow.length !== "number")
    throw new Error("World topology flow must be an array-like channel.");
  if (field.flow.length !== expected)
    throw new Error("World topology flow must contain rows times columns samples.");
  for (let index = 0; index < field.flow.length; index += 1) {
    const value = topologyNumber(field.flow[index], "flow");
    if (value > 1) throw new Error("World topology flow samples must be at most 1.");
  }
}

function topologyHeight(field: IWorldTopologyField, row: number, column: number): number {
  const clampedRow = Math.max(0, Math.min(field.rows - 1, row));
  const clampedColumn = Math.max(0, Math.min(field.columns - 1, column));
  const value = rawHeights(field)[clampedRow * field.columns + clampedColumn];
  if (value === undefined) throw new Error("World topology height sample is missing.");
  return value;
}

function topologyGradient(field: IWorldTopologyField, row: number, column: number): [number, number] {
  const dx = field.width / (field.columns - 1);
  const dz = field.depth / (field.rows - 1);
  return [
    (topologyHeight(field, row, column + 1) - topologyHeight(field, row, column - 1)) / (2 * dx),
    (topologyHeight(field, row + 1, column) - topologyHeight(field, row - 1, column)) / (2 * dz),
  ];
}

function variance(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  return values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
}

function directionalAnisotropy(field: IWorldTopologyField): number {
  const x: number[] = [];
  const z: number[] = [];
  for (let row = 0; row < field.rows; row += 1) {
    for (let column = 0; column < field.columns; column += 1) {
      const gradient = topologyGradient(field, row, column);
      x.push(gradient[0]);
      z.push(gradient[1]);
    }
  }
  const xVariance = variance(x);
  const zVariance = variance(z);
  if (xVariance === 0 || zVariance === 0) return Number.POSITIVE_INFINITY;
  return Math.abs(Math.log(xVariance / zVariance));
}

function powerSpectrumSlope(field: IWorldTopologyField): number {
  const sampleCount = field.columns;
  const average: number[] = [];
  for (let column = 0; column < sampleCount; column += 1) {
    let total = 0;
    for (let row = 0; row < field.rows; row += 1) total += topologyHeight(field, row, column);
    average.push(total / field.rows);
  }
  const wavelengths: number[] = [];
  const powers: number[] = [];
  for (let frequency = 1; frequency <= Math.floor(sampleCount / 2); frequency += 1) {
    const wavelength = field.width / frequency;
    if (wavelength < 8 || wavelength > 256) continue;
    let real = 0;
    let imaginary = 0;
    for (let index = 0; index < sampleCount; index += 1) {
      const angle = (2 * Math.PI * frequency * index) / sampleCount;
      real += (average[index] as number) * Math.cos(angle);
      imaginary -= (average[index] as number) * Math.sin(angle);
    }
    const power = real * real + imaginary * imaginary;
    if (power > 0) {
      wavelengths.push(Math.log(wavelength));
      powers.push(Math.log(power));
    }
  }
  if (wavelengths.length < 2) return Number.POSITIVE_INFINITY;
  const meanWavelength = wavelengths.reduce((total, value) => total + value, 0) / wavelengths.length;
  const meanPower = powers.reduce((total, value) => total + value, 0) / powers.length;
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < wavelengths.length; index += 1) {
    numerator += (wavelengths[index] as number - meanWavelength) * (powers[index] as number - meanPower);
    denominator += (wavelengths[index] as number - meanWavelength) ** 2;
  }
  return denominator === 0 ? Number.POSITIVE_INFINITY : numerator / denominator;
}

function reliefFieldEdge(field: IWorldTopologyField): number {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let edgeTotal = 0;
  let edgeCount = 0;
  for (let row = 0; row < field.rows; row += 1) {
    for (let column = 0; column < field.columns; column += 1) {
      const value = topologyHeight(field, row, column);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
      if (row === 0 || column === 0 || row === field.rows - 1 || column === field.columns - 1) {
        edgeTotal += value;
        edgeCount += 1;
      }
    }
  }
  const relief = maximum - minimum;
  if (relief === 0) return 0;
  const edgeMean = edgeTotal / edgeCount;
  const center = topologyHeight(field, Math.floor(field.rows / 2), Math.floor(field.columns / 2));
  return Math.abs(center - edgeMean) / relief;
}

function median64mRelief(field: IWorldTopologyField): number {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  const heights = rawHeights(field);
  for (let index = 0; index < heights.length; index += 1) {
    const value = heights[index] as number;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const globalRelief = maximum - minimum;
  if (globalRelief === 0) return 0;
  const radiusX = Math.max(1, Math.round(64 / (field.width / (field.columns - 1))));
  const radiusZ = Math.max(1, Math.round(64 / (field.depth / (field.rows - 1))));
  const local: number[] = [];
  const horizontalMinimum = new Float64Array(field.rows * field.columns);
  const horizontalMaximum = new Float64Array(field.rows * field.columns);
  for (let row = 0; row < field.rows; row += 1)
    slidingExtrema(
      (column) => topologyHeight(field, row, column),
      field.columns,
      radiusX,
      (column, lineMinimum, lineMaximum) => {
        horizontalMinimum[row * field.columns + column] = lineMinimum;
        horizontalMaximum[row * field.columns + column] = lineMaximum;
      },
    );
  for (let column = 0; column < field.columns; column += 1) {
    const localMinimum = new Float64Array(field.rows);
    const localMaximum = new Float64Array(field.rows);
    slidingExtrema(
      (row) => horizontalMinimum[row * field.columns + column] as number,
      field.rows,
      radiusZ,
      (row, lineMinimum) => {
        localMinimum[row] = lineMinimum;
      },
    );
    slidingExtrema(
      (row) => horizontalMaximum[row * field.columns + column] as number,
      field.rows,
      radiusZ,
      (row, _lineMinimum, lineMaximum) => {
        localMaximum[row] = lineMaximum;
      },
    );
    for (let row = 0; row < field.rows; row += 1)
      local.push(((localMaximum[row] as number) - (localMinimum[row] as number)) / globalRelief);
  }
  local.sort((a, b) => a - b);
  return local[Math.floor(local.length / 2)] as number;
}

function slidingExtrema(
  read: (index: number) => number,
  length: number,
  radius: number,
  write: (index: number, minimum: number, maximum: number) => void,
): void {
  const minimumDeque: number[] = [];
  const maximumDeque: number[] = [];
  let minimumHead = 0;
  let maximumHead = 0;
  let right = -1;
  for (let index = 0; index < length; index += 1) {
    const desiredRight = Math.min(length - 1, index + radius);
    while (right < desiredRight) {
      right += 1;
      const value = read(right);
      while (
        minimumDeque.length > minimumHead &&
        read(minimumDeque[minimumDeque.length - 1] as number) >= value
      )
        minimumDeque.pop();
      minimumDeque.push(right);
      while (
        maximumDeque.length > maximumHead &&
        read(maximumDeque[maximumDeque.length - 1] as number) <= value
      )
        maximumDeque.pop();
      maximumDeque.push(right);
    }
    const left = Math.max(0, index - radius);
    while (minimumHead < minimumDeque.length && (minimumDeque[minimumHead] as number) < left)
      minimumHead += 1;
    while (maximumHead < maximumDeque.length && (maximumDeque[maximumHead] as number) < left)
      maximumHead += 1;
    const minimumIndex = minimumDeque[minimumHead];
    const maximumIndex = maximumDeque[maximumHead];
    if (minimumIndex === undefined || maximumIndex === undefined)
      throw new Error("World topology sliding window is empty.");
    write(index, read(minimumIndex), read(maximumIndex));
    if (minimumHead > 64 && minimumHead * 2 > minimumDeque.length) {
      minimumDeque.splice(0, minimumHead);
      minimumHead = 0;
    }
    if (maximumHead > 64 && maximumHead * 2 > maximumDeque.length) {
      maximumDeque.splice(0, maximumHead);
      maximumHead = 0;
    }
  }
}

function downhill(field: IWorldTopologyField, index: number): number {
  const row = Math.floor(index / field.columns);
  const column = index % field.columns;
  const current = topologyHeight(field, row, column);
  let destination = index;
  let lowest = current;
  const offsets: readonly [number, number][] = [[-1, 0], [1, 0], [0, -1], [0, 1]];
  for (const [rowOffset, columnOffset] of offsets) {
    const nextRow = row + rowOffset;
    const nextColumn = column + columnOffset;
    if (nextRow < 0 || nextRow >= field.rows || nextColumn < 0 || nextColumn >= field.columns) continue;
    const candidate = topologyHeight(field, nextRow, nextColumn);
    if (candidate < lowest) {
      lowest = candidate;
      destination = nextRow * field.columns + nextColumn;
    }
  }
  return destination;
}

function streamOrder(field: IWorldTopologyField): number {
  const count = field.rows * field.columns;
  const flow = rawFlow(field);
  const accumulation = new Float64Array(count);
  const targets = new Int32Array(count);
  targets.fill(-1);
  const order = Array.from({ length: count }, (_, index) => index).sort(
    (a, b) => topologyHeight(field, Math.floor(b / field.columns), b % field.columns)
      - topologyHeight(field, Math.floor(a / field.columns), a % field.columns)
      || a - b,
  );
  for (let source = 0; source < count; source += 1) {
    const destination = downhill(field, source);
    targets[source] = destination === source ? -1 : destination;
  }
  for (const source of order) {
    accumulation[source] = (accumulation[source] ?? 0) + 1;
    const destination = targets[source];
    if (destination !== undefined && destination >= 0)
      accumulation[destination] = (accumulation[destination] ?? 0) + (accumulation[source] as number);
  }
  const cellArea = (field.width / (field.columns - 1)) * (field.depth / (field.rows - 1));
  const minimumFlow = Math.log1p(2_048 / cellArea) / Math.log1p(count);
  const stream = Array.from({ length: count }, (_, index) => (flow[index] as number) >= minimumFlow);
  const orders = new Int32Array(count);
  let maximum = 0;
  for (const index of order) {
    if (!stream[index]) continue;
    const row = Math.floor(index / field.columns);
    const column = index % field.columns;
    const upstream: number[] = [];
    for (const [rowOffset, columnOffset] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const upstreamRow = row + rowOffset;
      const upstreamColumn = column + columnOffset;
      if (upstreamRow < 0 || upstreamRow >= field.rows || upstreamColumn < 0 || upstreamColumn >= field.columns) continue;
      const candidate = upstreamRow * field.columns + upstreamColumn;
      if (targets[candidate] === index && stream[candidate]) upstream.push(orders[candidate] as number);
    }
    const highest = Math.max(1, ...upstream);
    const ties = upstream.filter((value) => value === highest).length;
    orders[index] = ties > 1 ? highest + 1 : highest;
    maximum = Math.max(maximum, orders[index] as number);
  }
  return maximum;
}

function curvatureExcessKurtosis(field: IWorldTopologyField): number {
  const values: number[] = [];
  for (let row = 0; row < field.rows; row += 1) {
    for (let column = 0; column < field.columns; column += 1) {
      const center = topologyHeight(field, row, column);
      values.push(
        topologyHeight(field, row, column - 1) + topologyHeight(field, row, column + 1) +
          topologyHeight(field, row - 1, column) + topologyHeight(field, row + 1, column) - 4 * center,
      );
    }
  }
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const second = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
  if (second === 0) return Number.NEGATIVE_INFINITY;
  const fourth = values.reduce((total, value) => total + (value - mean) ** 4, 0) / values.length;
  return fourth / (second * second) - 3;
}

/** Compute the eight source-independent quality metrics used by the terrain gate. */
export function measureWorldTopology(field: IWorldTopologyField): IWorldTopologyMetrics {
  topologyField(field);
  if (field.metrics !== undefined) return { ...field.metrics } as IWorldTopologyMetrics;
  let steep = 0;
  for (let row = 0; row < field.rows; row += 1) {
    for (let column = 0; column < field.columns; column += 1) {
      const [x, z] = topologyGradient(field, row, column);
      if (Math.atan(Math.hypot(x, z)) > Math.PI / 6) steep += 1;
    }
  }
  return {
    directionalAnisotropy: directionalAnisotropy(field),
    powerSpectrumSlope: powerSpectrumSlope(field),
    reliefFieldEdge: reliefFieldEdge(field),
    median64mRelief: median64mRelief(field),
    maxHortonStrahlerOrder: streamOrder(field),
    profileCurvatureExcessKurtosis: curvatureExcessKurtosis(field),
    effectiveVertexDensityPerKm2: (field.rows * field.columns * 1_000_000) / (field.width * field.depth),
    slopeTailAbove30Degrees: steep / (field.rows * field.columns),
  };
}

/** Apply the stated quality floors without allowing a missing metric to pass. */
export function evaluateWorldTopology(
  field: IWorldTopologyField,
  thresholds: IWorldTopologyThresholds = DEFAULT_WORLD_TOPOLOGY_THRESHOLDS,
): IWorldTopologyEvaluation {
  const metrics = measureWorldTopology(field);
  const failed = [
    ...(metrics.directionalAnisotropy <= thresholds.maxDirectionalAnisotropy ? [] : ["directional-anisotropy"]),
    ...(metrics.powerSpectrumSlope >= thresholds.minPowerSpectrumSlope && metrics.powerSpectrumSlope <= thresholds.maxPowerSpectrumSlope ? [] : ["power-spectrum-slope"]),
    ...(metrics.reliefFieldEdge >= thresholds.minReliefFieldEdge ? [] : ["relief-field-edge"]),
    ...(metrics.median64mRelief <= thresholds.maxMedian64mRelief ? [] : ["median-64m-relief"]),
    ...(metrics.maxHortonStrahlerOrder >= thresholds.minHortonStrahlerOrder ? [] : ["horton-strahler-order"]),
    ...(metrics.profileCurvatureExcessKurtosis >= thresholds.minProfileCurvatureExcessKurtosis ? [] : ["curvature-excess-kurtosis"]),
    ...(metrics.effectiveVertexDensityPerKm2 >= thresholds.minEffectiveVertexDensityPerKm2 ? [] : ["effective-vertex-density"]),
    ...(metrics.slopeTailAbove30Degrees >= thresholds.minSlopeTailAbove30Degrees ? [] : ["slope-tail-above-30-degrees"]),
  ];
  return { failed, metrics, pass: failed.length === 0 };
}

function emitWorldTopology(
  value: unknown,
  assertions: IEvaluationContext["assertions"],
  diagnostics: IEvaluationContext["diagnostics"],
): void {
  const fail = (reason: string): void => {
    for (const name of Object.keys(WORLD_TOPOLOGY_METRIC_FAILURES) as Array<keyof IWorldTopologyMetrics>)
      assertions.push({ details: { reason }, id: `world.topology.${name}`, pass: false });
    diagnostics.push({
      code: "TN_PLAYTEST_WORLD_TOPOLOGY_ASSERTION_FAILED",
      message: `World topology was not evaluated: ${reason}.`,
      observedRuntimePath: "observations.json/components/terrain/after/topology",
      severity: "error",
      suggestion: "Publish finite height and normalized flow channels before treating terrain metrics as proof.",
    });
  };
  if (value === null || typeof value !== "object") {
    fail("the terrain observation is missing");
    return;
  }
  const candidate = (value as Record<string, unknown>).topology;
  if (candidate === null || typeof candidate !== "object") {
    fail("the topology field is missing");
    return;
  }
  try {
    const result = evaluateWorldTopology(candidate as IWorldTopologyField);
    for (const name of Object.keys(WORLD_TOPOLOGY_METRIC_FAILURES) as Array<keyof IWorldTopologyMetrics>)
      assertions.push({
        details: { metric: result.metrics[name] },
        id: `world.topology.${name}`,
        pass: !result.failed.includes(WORLD_TOPOLOGY_METRIC_FAILURES[name]),
      });
    if (!result.pass)
      diagnostics.push({
        code: "TN_PLAYTEST_WORLD_TOPOLOGY_ASSERTION_FAILED",
        message: `World topology failed metrics: ${result.failed.join(", ")}.`,
        observedRuntimePath: "observations.json/components/terrain/after/topology",
        severity: "error",
        suggestion: "Inspect the seeded field and keep synthesis, erosion, and flow in their declared order.",
      });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
}
