import type { IStandalonePlaytestReport } from "./shared.js";

export function formatScenarioSummary(report: IStandalonePlaytestReport): { scenarioSummary: Record<string, unknown> } {
  const failedAssertions = (report.assertionResults ?? [])
    .filter(({ pass }) => pass === false)
    .map(({ id }) => id);
  const codes = report.diagnostics.map(({ code }) => code);
  // The code alone made a reader guess. `TN_PLAYTEST_OPERATION_TIMEOUT` says an operation
  // exceeded its budget and not which one, and the full report, which does carry the message, is
  // exactly what a CI log truncates. Carry the messages of the failing diagnostics on this line.
  const reasons = report.diagnostics
    .filter(({ severity }) => severity === "error")
    .map(({ message }) => message);
  return {
    scenarioSummary: {
      diagnostics: codes,
      failed: failedAssertions,
      ...(reasons.length === 0 ? {} : { reasons }),
      // A fixed-step scenario should reach the same tick on any machine, so a run that disagrees
      // with a developer's says the loop did not step the same way: a harness or engine property.
      firstTick: report.before?.tick,
      frames: report.frames,
      lastTick: report.after?.tick,
      pass: report.pass,
      scenario: report.scenario,
    },
  };
}

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}...` : text);

/**
 * One scenario as a few hundred bytes: what an agent reads from a multi-megabyte report. Every
 * list and string is capped so the whole summary stays under 4 KB for any report.
 */
export function formatCompactReport(report: IStandalonePlaytestReport): Record<string, unknown> {
  const { scenarioSummary } = formatScenarioSummary(report);
  const failedDetails = (report.assertionResults ?? [])
    .filter(({ pass }) => pass === false)
    .slice(0, 5)
    .map(({ details, id }) => ({ id, ...(details === undefined ? {} : { details: clip(JSON.stringify(details), 300) }) }));
  const seen = new Map<string, { code: string; count: number; message: string }>();
  for (const { code, message } of report.diagnostics) {
    const key = `${code}\u0000${message}`;
    const entry = seen.get(key);
    if (entry === undefined) seen.set(key, { code, count: 1, message: clip(message, 200) });
    else entry.count += 1;
  }
  const resources = Object.entries(report.observations?.resources ?? {}).slice(-6)
    .map(([name, { after }]) => [name, clip(JSON.stringify(after) ?? "undefined", 120)]);
  return {
    ...scenarioSummary,
    artifactDirectory: report.artifactDirectory,
    diagnosticDetails: [...seen.values()].slice(0, 5),
    failedDetails,
    finalState: { after: report.after, resources: Object.fromEntries(resources) },
    movementDelta: report.movementDelta,
  };
}
