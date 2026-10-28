import { readPath, jsonEqual, textValue } from '../assertion-report.js';
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import type { IEvaluationContext } from "./context.js";
import { classifyAdapter, type IAdapterClassification } from "./adapter-class.js";
import { foreignGpuProcesses, frameDisplay, gpuWindows } from "./frame-cost.js";
import { evaluatePerformanceAssertion, evaluateResourceAnyOfAssertion, hasFinalPathExpectation, evaluatePathAssertion, pathValuePass, matchingSignals, evaluateWorldAssertion, evaluateAudioAssertion } from "./helpers.js";

function gpuLane(consoleTexts: readonly unknown[]): { gpuP95?: number; gpuSamples?: number } {
  const { p95, samples } = gpuWindows(consoleTexts);
  return p95 === undefined ? {} : { gpuP95: p95, ...(samples === undefined ? {} : { gpuSamples: samples }) };
}

export function emitPerfSignalsWorld(ctx: IEvaluationContext): void {
  const { assertions, diagnostics } = ctx;
  const { input, scenarioAssertions } = ctx;
  emitTerrainResidency(input.report.observations?.components?.terrain, assertions, diagnostics);
  if (scenarioAssertions.performance !== undefined) {
    const budget = frameBudget(scenarioAssertions.performance.maxFrameMsP95, classifyAdapter(input.report), scenarioAssertions.performance.maxFrameMsReason);
    const result = evaluatePerformanceAssertion(
      budget.maxFrameMsP95 === undefined ? scenarioAssertions.performance : { ...scenarioAssertions.performance, maxFrameMsP95: budget.maxFrameMsP95 },
      input.report.observations?.performanceSeries,
      input.scenario.sourcePath,
      { display: frameDisplay(), foreignGpu: foreignGpuProcesses(), ...gpuLane((input.report.observations?.console ?? []).map(({ text }) => text)) },
    );
    // The budget rides on the rows that always exist, so a run says which budget held it, or why none did.
    assertions.push(...result.assertions.map((row) =>
      row.id === "performance.samples" || row.id === "performance.maxFrameMsP95" ? { ...row, details: { ...row.details, frameBudget: budget } } : row));
    diagnostics.push(...result.diagnostics);
    if (budget.unmeasurable === true) {
      assertions.push({ details: { frameBudget: budget }, id: "performance.maxFrameMsP95", pass: false });
      diagnostics.push({
        code: "TN_PLAYTEST_PERFORMANCE_UNMEASURABLE",
        message: `performance.maxFrameMsP95 cannot be judged: ${budget.reason}.`,
        observedRuntimePath: `${input.scenario.sourcePath ?? "playtest"}/observations.json/performanceSeries`,
        severity: "error",
        sourcePath: input.scenario.sourcePath,
        suggestion: "Run the scenario on a hardware GPU, or set maxFrameMsP95 with a maxFrameMsReason that names the adapter.",
      });
    }
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
          && (expected.lte === undefined || (typeof value === "number" && value <= expected.lte))
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

/** One 60 Hz frame. The budget is the same on every tier: a discrete, integrated or mobile GPU alike must hold 60 fps. */
export const FRAME_BUDGET_MS = 16.7;

export interface IFrameBudget {
  readonly adapterClass?: string;
  readonly gpuFamily?: string;
  /** Absent when the adapter cannot be measured; `reason` then says why and the run fails closed. */
  readonly maxFrameMsP95?: number;
  readonly reason: string;
  readonly source: "adapter" | "scenario";
  readonly unmeasurable?: true;
}

/**
 * The frame budget a `performance` assertion is held to: 16.7 ms at p95 on every tier.
 *
 * A budget the author picks is the one that went wrong: every starter kit wrote 33 ms, so 30 fps on
 * a desktop RTX 2080 passed, and a tier table that relaxed integrated GPUs to 40 ms repeated it.
 * The goal is 60 fps, so unset, the budget is one 60 Hz frame whatever the adapter. A scenario may
 * set a looser `maxFrameMsP95` only with a written `reason`, which the report prints
 * (`validatePerformanceAssertion` refuses one without). A CPU rasteriser cannot vouch for a frame
 * rate, so it is unmeasurable and the run fails closed.
 */
export function frameBudget(explicit: number | undefined, adapter: IAdapterClassification, reason?: string): IFrameBudget {
  const identity = {
    ...(adapter.adapterClass === undefined ? {} : { adapterClass: adapter.adapterClass }),
    ...(adapter.gpuFamily === undefined ? {} : { gpuFamily: adapter.gpuFamily }),
  };
  if (explicit !== undefined) {
    return { ...identity, maxFrameMsP95: explicit, reason: `maxFrameMsP95 set in the scenario overrides ${FRAME_BUDGET_MS} ms${reason === undefined ? "" : `: ${reason}`}`, source: "scenario" };
  }
  if (adapter.adapterClass === "software") {
    return { ...identity, reason: `software adapter ${adapter.softwareAdapter ?? ""} is unmeasurable: it cannot carry a frame rate`.replace("  ", " "), source: "adapter", unmeasurable: true };
  }
  return { ...identity, maxFrameMsP95: FRAME_BUDGET_MS, reason: `one 60 Hz frame (${FRAME_BUDGET_MS} ms) on every tier`, source: "adapter" };
}
