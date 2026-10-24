import { readPath, jsonEqual, textValue } from '../assertion-report.js';
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import type { IEvaluationContext } from "./context.js";
import { classifyAdapter, type IAdapterClassification } from "./adapter-class.js";
import { evaluatePerformanceAssertion, evaluateResourceAnyOfAssertion, hasFinalPathExpectation, evaluatePathAssertion, pathValuePass, matchingSignals, evaluateWorldAssertion, evaluateAudioAssertion } from "./helpers.js";

export function emitPerfSignalsWorld(ctx: IEvaluationContext): void {
  const { assertions, diagnostics } = ctx;
  const { input, scenarioAssertions } = ctx;
  emitTerrainResidency(input.report.observations?.components?.terrain, assertions, diagnostics);
  if (scenarioAssertions.performance !== undefined) {
    const budget = frameBudget(scenarioAssertions.performance.maxFrameMsP95, classifyAdapter(input.report));
    const result = evaluatePerformanceAssertion(
      budget.maxFrameMsP95 === undefined ? scenarioAssertions.performance : { ...scenarioAssertions.performance, maxFrameMsP95: budget.maxFrameMsP95 },
      input.report.observations?.performanceSeries,
      input.scenario.sourcePath,
    );
    // The budget rides on the rows that always exist, so a run says which budget held it, or why none did.
    assertions.push(...result.assertions.map((row) =>
      row.id === "performance.samples" || row.id === "performance.maxFrameMsP95" ? { ...row, details: { ...row.details, frameBudget: budget } } : row));
    diagnostics.push(...result.diagnostics);
  }
  for (const assertion of scenarioAssertions.resources ?? []) {
    if (assertion.anyOf !== undefined) {
      const result = evaluateResourceAnyOfAssertion(assertion, input.report.observations?.resources[assertion.id], {
        effectLog: input.report.effectLog ?? input.report.observations?.effectLog,
        movedDistance: input.report.distance,
        scenarioSourcePath: input.scenario.sourcePath,
      });
      assertions.push(result.assertion);
      if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
      continue;
    }
    if (hasFinalPathExpectation(assertion)) {
      const result = evaluatePathAssertion("resource", assertion, input.report.observations?.resources[assertion.id], {
        effectLog: input.report.effectLog ?? input.report.observations?.effectLog,
        movedDistance: input.report.distance,
        scenarioSourcePath: input.scenario.sourcePath,
      });
      assertions.push(result.assertion);
      if (result.diagnostic !== undefined) {
        diagnostics.push({ ...result.diagnostic, code: result.diagnostic.code || "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED" });
      }
    }
    if (assertion.throughoutSteps === true) {
      const samples = (input.report.observations?.resourceSeries ?? []).map((sample) => ({
        label: sample.label,
        value: readPath(sample.snapshots[assertion.id], assertion.path),
      }));
      const expectedSamples = input.scenario.steps.reduce((count, step) => count + (step.label === undefined ? 0 : 1), 0);
      const pass = expectedSamples > 0 && samples.length === expectedSamples && samples.every((sample) => pathValuePass(assertion, sample.value));
      assertions.push({ details: { samples }, id: `resource.${assertion.id}.${assertion.path ?? "value"}.throughoutSteps`, pass });
      if (!pass) diagnostics.push({
        code: "TN_PLAYTEST_RESOURCE_TRANSITION_ASSERTION_FAILED",
        message: `Resource '${assertion.id}'${assertion.path === undefined ? "" : ` path '${assertion.path}'`} did not satisfy the assertion after every scenario step.`,
        observedRuntimePath: "observations.json/resourceSeries",
        severity: "error",
        suggestion: "Inspect the labeled resource samples and fix the transient gameplay-state transition.",
      });
    }
    if ((assertion.atSteps?.length ?? 0) > 0) {
      const samples = assertion.atSteps!.map((expected) => {
        const sample = (input.report.observations?.resourceSeries ?? []).find((candidate) => candidate.label === expected.label);
        const value = readPath(sample?.snapshots[assertion.id], assertion.path);
        const pass = sample !== undefined
          && (!Object.hasOwn(expected, "equals") || jsonEqual(value, expected.equals))
          && (expected.textIncludes === undefined || String(textValue(value)).includes(expected.textIncludes));
        return { expected, pass, value };
      });
      const pass = samples.every((sample) => sample.pass);
      assertions.push({ details: { samples }, id: `resource.${assertion.id}.${assertion.path ?? "value"}.atSteps`, pass });
      if (!pass) diagnostics.push({
        code: "TN_PLAYTEST_RESOURCE_TRANSITION_ASSERTION_FAILED",
        message: `Resource '${assertion.id}'${assertion.path === undefined ? "" : ` path '${assertion.path}'`} did not match the expected labeled-step transition.`,
        observedRuntimePath: "observations.json/resourceSeries",
        severity: "error",
        suggestion: "Inspect the failed and restored labeled samples and fix the retry transition.",
      });
    }
  }
  for (const assertion of scenarioAssertions.signals ?? []) {
    const series = input.report.observations?.signalSeries;
    const selected = assertion.atStep === undefined
      ? undefined
      : series?.find((sample) => sample.label === assertion.atStep);
    const drained = assertion.atStep === undefined
      ? series !== undefined && series.length > 0
      : selected !== undefined;
    const events = assertion.atStep === undefined ? input.report.observations?.signals : selected?.signals;
    const count = matchingSignals(events, assertion);
    const minCount = assertion.minCount ?? (assertion.maxCount === undefined ? 1 : 0);
    const pass = drained && count >= minCount && (assertion.maxCount === undefined || count <= assertion.maxCount);
    assertions.push({
      details: { atStep: assertion.atStep, count, entity: assertion.entity, maxCount: assertion.maxCount, minCount, name: assertion.name },
      id: `signal.${assertion.name}`,
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_SIGNAL_NOT_OBSERVED",
      message: !drained
        ? `Signal assertion '${assertion.name}' had no retained event drain${assertion.atStep === undefined ? "" : ` at step '${assertion.atStep}'`}.`
        : `Expected signal '${assertion.name}'${assertion.entity === undefined ? "" : ` from '${assertion.entity}'`} ${minCount} time(s), observed ${count}.`,
      observedRuntimePath: "observations.json/signalSeries",
      severity: "error",
      suggestion: "Expose a bounded events callback on the playtest bridge and inspect the emitted signal name and entity.",
    });
  }
  for (const assertion of scenarioAssertions.audio ?? []) {
    const result = evaluateAudioAssertion(assertion, input.report.observations?.runtimeObservations);
    assertions.push(result.assertion);
    if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
  }
  if (scenarioAssertions.world !== undefined) {
    const result = evaluateWorldAssertion(scenarioAssertions.world, input.report.observations?.runtimeObservations);
    assertions.push(result.assertion);
    if (result.diagnostic !== undefined) diagnostics.push(result.diagnostic);
  }
}

function emitTerrainResidency(
  component: Record<string, { after?: unknown }> | undefined,
  assertions: IEvaluationContext["assertions"],
  diagnostics: IEvaluationContext["diagnostics"],
): void {
  if (component === undefined) return;
  const valueAfter = (name: string): unknown => component[name]?.after;
  const residentTiles = valueAfter("residentTiles");
  const residentBytes = valueAfter("residentBytes");
  const peakResidentTiles = valueAfter("peakResidentTiles");
  const peakResidentBytes = valueAfter("peakResidentBytes");
  const residentTileBudget = valueAfter("residentTileBudget");
  const residentByteBudget = valueAfter("residentByteBudget");
  const finiteNumbers = [
    residentTiles,
    residentBytes,
    peakResidentTiles,
    peakResidentBytes,
    residentTileBudget,
    residentByteBudget,
  ].every((value) => typeof value === "number" && Number.isFinite(value));
  const pass = finiteNumbers
    && (residentTiles as number) <= (peakResidentTiles as number)
    && (residentBytes as number) <= (peakResidentBytes as number)
    && (residentTiles as number) <= (residentTileBudget as number)
    && (residentBytes as number) <= (residentByteBudget as number)
    && (peakResidentTiles as number) <= (residentTileBudget as number)
    && (peakResidentBytes as number) <= (residentByteBudget as number);
  assertions.push({
    details: {
      peakResidentBytes,
      peakResidentTiles,
      residentByteBudget,
      residentBytes,
      residentTileBudget,
      residentTiles,
    },
    id: "world.residency",
    pass,
  });
  if (!pass)
    diagnostics.push({
      code: "TN_PLAYTEST_WORLD_RESIDENCY_ASSERTION_FAILED",
      message: "Terrain residency did not report finite measurements within its declared tile and byte caps.",
      observedRuntimePath: "observations.json/components/terrain",
      severity: "error",
      suggestion: "Expose TerrainTiles.debug() through the terrain entity and inspect the residency counters.",
    });
}

/** A 60 Hz frame, or a 30 Hz one, with 20% for vsync jitter: p95 of a held 60 fps reads 17-18 ms. */
const DESKTOP_FRAME_MS = 20;
const HANDHELD_FRAME_MS = 40;

export interface IFrameBudget {
  readonly adapterClass?: string;
  readonly gpuFamily?: string;
  /** Absent when no budget applies; `reason` then says why. */
  readonly maxFrameMsP95?: number;
  readonly reason: string;
  readonly source: "adapter" | "scenario";
}

/**
 * The frame budget a `performance` assertion is held to.
 *
 * A budget the author picks is the one that went wrong: every starter kit wrote 33 ms, so 30 fps on
 * a desktop RTX 2080 passed. Unset, the budget follows the adapter the harness classified, never a
 * tier the game chose: a 60 Hz frame on a discrete or unnamed hardware GPU, a 30 Hz frame on an
 * integrated or mobile one. A CPU rasteriser or an unnamed adapter cannot vouch for a frame rate,
 * so no budget applies and the report says so. A number in the scenario is an override, reported.
 */
export function frameBudget(explicit: number | undefined, adapter: IAdapterClassification): IFrameBudget {
  const identity = {
    ...(adapter.adapterClass === undefined ? {} : { adapterClass: adapter.adapterClass }),
    ...(adapter.gpuFamily === undefined ? {} : { gpuFamily: adapter.gpuFamily }),
  };
  if (explicit !== undefined) return { ...identity, maxFrameMsP95: explicit, reason: "maxFrameMsP95 set in the scenario overrides the adapter budget", source: "scenario" };
  if (adapter.adapterClass === undefined) return { ...identity, reason: "the run named no adapter to derive a frame budget from", source: "adapter" };
  if (adapter.adapterClass === "software") return { ...identity, reason: `software adapter ${adapter.softwareAdapter ?? ""} cannot carry a frame rate`.replace("  ", " "), source: "adapter" };
  const handheld = adapter.gpuFamily !== undefined && adapter.gpuFamily !== "discrete";
  return {
    ...identity,
    maxFrameMsP95: handheld ? HANDHELD_FRAME_MS : DESKTOP_FRAME_MS,
    reason: handheld ? `${adapter.gpuFamily} GPU: a 30 Hz frame plus 20% jitter` : "desktop hardware GPU: a 60 Hz frame plus 20% jitter",
    source: "adapter",
  };
}
