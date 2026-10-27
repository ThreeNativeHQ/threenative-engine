import type { IEvaluationContext } from "./context.js";

const MAX_BLOCKER_NAMES = 5;

/** Named blockers ordered by how many samples they blocked, ties by name. */
function topBlockers(blockers: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of blockers) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([leftName, leftCount], [rightName, rightCount]) => rightCount - leftCount || leftName.localeCompare(rightName))
    .slice(0, MAX_BLOCKER_NAMES)
    .map(([name]) => name);
}

export function emitSightLine(ctx: IEvaluationContext): void {
  const assertion = ctx.scenarioAssertions.sightLine;
  if (assertion === undefined) return;
  const observation = ctx.input.report.observations?.sightLine;
  const samples = observation?.samples ?? [];
  if (samples.length === 0) {
    ctx.assertions.push({ details: { samples: 0 }, id: "sightLine.observed", pass: false });
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_SIGHT_LINE_UNOBSERVED",
      message: "A sightLine assertion was evaluated against a run that sampled no camera-to-subject sight line.",
      observedRuntimePath: "observations.json/sightLine",
      severity: "error",
      suggestion: "Run on the browser target and make sure the scenario advances at least one step whose subject is registered with the bridge.",
    });
    return;
  }
  const blockedCount = samples.filter(({ blocked }) => blocked).length;
  const ratio = blockedCount / samples.length;
  const pass = ratio <= assertion.maxBlockedRatio;
  const blockers = topBlockers(samples.flatMap((sample) => sample.blockers));
  ctx.assertions.push({
    details: { blocked: blockedCount, blockers, ratio, samples: samples.length },
    id: "sightLine",
    pass,
  });
  if (!pass) {
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_SIGHT_LINE_BLOCKED",
      message: `Solid geometry blocked the camera's view of '${observation!.entity}' on ${blockedCount} of ${samples.length} samples (${(ratio * 100).toFixed(1)}%), ceiling ${assertion.maxBlockedRatio}.`,
      observedRuntimePath: "observations.json/sightLine",
      severity: "error",
      suggestion: "Move the camera along the cast or pull it in past the blocker, so a line from the lens to the subject stays clear.",
    });
  }
}
