// Facade for the scenario schema/validation modules (PRD-182 Phase 3). Import paths are
// unchanged: every consumer keeps importing from @threenative/playtest and scenario.js.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PlaytestScenarioError, invalidScenario } from "./scenario/errors.js";
import { validatePlaytestScenario } from "./scenario/schema-validate.js";
import { isRecord } from "./scenario/schema-accessors.js";
import type { IPlaytestScenario } from "./scenario/schema-base.js";

export * from "./scenario/schema-base.js";
export * from "./scenario/schema-validate.js";
export * from "./scenario/schema-accessors.js";
export * from "./scenario/errors.js";
export * from "./scenario/orientation.js";

export async function loadPlaytestScenario(projectPath: string, scenarioPath: string): Promise<IPlaytestScenario> {
  const absolutePath = resolve(projectPath, scenarioPath);
  let raw: string;
  try {
    raw = await readFile(absolutePath, "utf8");
  } catch {
    throw new PlaytestScenarioError({
      code: "TN_PLAYTEST_SCENARIO_NOT_FOUND",
      message: `Playtest scenario '${scenarioPath}' could not be read.`,
      severity: "error",
      suggestion: "Check the --scenario path. Committed playtest scenarios normally live under playtests/*.playtest.json.",
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PlaytestScenarioError({
      code: "TN_PLAYTEST_SCENARIO_INVALID",
      message: `Playtest scenario '${scenarioPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
      severity: "error",
      suggestion: "Fix the scenario JSON syntax and rerun tn playtest.",
    });
  }
  const scenario = validatePlaytestScenario(parsed, scenarioPath, absolutePath);
  return hydrateParityReference(projectPath, scenario, scenarioPath);
}

/**
 * Reads the other half of a parity pair out of its saved run report, at load.
 *
 * The assertion names an external artifact, the load step reads it once, and a file that cannot be
 * read or does not carry a measurable series is a load failure naming the defect — never a run that evaluates parity against nothing.
 */
async function hydrateParityReference(projectPath: string, scenario: IPlaytestScenario, scenarioPath: string): Promise<IPlaytestScenario> {
  const assertion = scenario.assert?.parity;
  if (assertion === undefined || assertion.reference !== undefined) return scenario;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(projectPath, assertion.referenceReport), "utf8"));
  } catch {
    throw invalidScenario(
      scenarioPath,
      `Parity reference '${assertion.referenceReport}' could not be read as JSON. Run the other half of the pair first and save its report.`,
    );
  }
  if (!isRecord(parsed) || !isRecord(parsed.observations) || !Array.isArray(parsed.observations.performanceSeries)) {
    throw invalidScenario(
      scenarioPath,
      `Parity reference '${assertion.referenceReport}' carries no observations.performanceSeries; a run report without a measured series is not a parity half.`,
    );
  }
  const performanceSeries = parsed.observations.performanceSeries as unknown[];
  if (performanceSeries.length === 0) {
    throw invalidScenario(
      scenarioPath,
      `Parity reference '${assertion.referenceReport}' has no valid frame-time samples; a parity half must have measured the render loop.`,
    );
  }
  const frameTimes: number[] = [];
  for (const sample of performanceSeries) {
    if (!isRecord(sample) || typeof sample.frameMs !== "number" || !Number.isFinite(sample.frameMs) || sample.frameMs <= 0) {
      throw invalidScenario(
        scenarioPath,
        `Parity reference '${assertion.referenceReport}' contains a malformed frame-time sample; every sample must carry a finite positive frameMs.`,
      );
    }
    frameTimes.push(sample.frameMs);
  }
  const sorted = [...frameTimes].sort((left, right) => left - right);
  const medianFrameMs = sorted[Math.floor(sorted.length / 2)];
  if (medianFrameMs === undefined || medianFrameMs <= 0) {
    throw invalidScenario(
      scenarioPath,
      `Parity reference '${assertion.referenceReport}' produced no median frame time; a parity half must have measured the render loop.`,
    );
  }
  const fps = 1_000 / medianFrameMs;
  const renderTimes = performanceSeries
    .map((sample) => (sample as { phases?: { render?: unknown } }).phases?.render);
  const completeRenderTimes = renderTimes.every(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  )
    ? renderTimes
    : undefined;
  const deviceMetrics = isRecord(parsed.observations.deviceMetrics) ? parsed.observations.deviceMetrics : undefined;
  const verdict = isRecord(deviceMetrics?.verdict) ? deviceMetrics.verdict : undefined;
  return {
    ...scenario,
    assert: {
      ...scenario.assert,
      parity: {
        ...assertion,
        reference: {
          fps,
          ...(completeRenderTimes === undefined
            ? {}
            : {
                renderP95: [...completeRenderTimes].sort((left, right) => left - right)[
                  Math.ceil(completeRenderTimes.length * 0.95) - 1
                ],
              }),
          ...(typeof deviceMetrics?.serial === "string" ? { serial: deviceMetrics.serial } : {}),
          ...(typeof verdict?.thermallyConfounded === "boolean" ? { thermallyConfounded: verdict.thermallyConfounded } : {}),
        },
      },
    },
  };
}

