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
 * One scenario as a few hundred bytes: what an agent reads from a multi-megabyte report. The object
 * is built field by field, never spread from `formatScenarioSummary`, whose `diagnostics`,
 * `reasons` and `failed` lists are unbounded. Every list and string here is capped.
 */
export function formatCompactReport(report: IStandalonePlaytestReport): Record<string, unknown> {
  const failedResults = (report.assertionResults ?? []).filter(({ pass }) => pass === false);
  const failedDetails = failedResults
    .slice(0, 5)
    .map(({ details, id }) => ({ id: clip(id, 60), ...(details === undefined ? {} : { details: clip(JSON.stringify(details), 160) }) }));
  const seen = new Map<string, { code: string; count: number; message: string; severity: string }>();
  for (const { code, message, severity } of report.diagnostics) {
    const key = `${code}\u0000${message}`;
    const entry = seen.get(key);
    if (entry === undefined) seen.set(key, { code: clip(code, 60), count: 1, message: clip(message, 150), severity });
    else entry.count += 1;
  }
  const resources = Object.entries(report.observations?.resources ?? {}).slice(-6)
    .map(([name, { after }]) => [name, clip(JSON.stringify(after) ?? "undefined", 80)]);
  return {
    artifactDirectory: report.artifactDirectory,
    diagnosticDetails: [...seen.values()].slice(0, 5),
    ...(seen.size > 5 ? { diagnosticKinds: seen.size } : {}),
    failed: failedDetails.map(({ id }) => id),
    ...(failedResults.length > 5 ? { failedTotal: failedResults.length } : {}),
    failedDetails,
    finalState: { after: report.after, resources: Object.fromEntries(resources) },
    firstTick: report.before?.tick,
    frames: report.frames,
    lastTick: report.after?.tick,
    movementDelta: report.movementDelta,
    pass: report.pass,
    scenario: report.scenario,
  };
}

export const SUMMARY_BYTE_BUDGET = 4096;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value)) + 1;

/**
 * The `--summary` stdout for any number of scenarios, under `SUMMARY_BYTE_BUDGET` bytes in total.
 * Failing scenarios come first. One that does not fit whole shrinks to its id and failed ids; any
 * scenario that still does not fit becomes part of a count, with a pointer to `--out`.
 */
export function formatCompactSummary(reports: readonly IStandalonePlaytestReport[], outPath?: string): Record<string, unknown> {
  const head = { pass: reports.every(({ pass }) => pass), ...(outPath === undefined ? {} : { out: outPath }) };
  const ordered = [...reports].sort((a, b) => Number(a.pass) - Number(b.pass));
  const scenarios: Record<string, unknown>[] = [];
  let omitted = 0;
  // Room for the closing `omitted` note, so it can never push the line over the budget.
  const reserve = 120;
  const room = (extra: Record<string, unknown>): number => SUMMARY_BYTE_BUDGET - reserve - bytes({ ...head, scenarios: [...scenarios, extra] });
  for (const report of ordered) {
    const minimal = {
      failed: (report.assertionResults ?? []).filter(({ pass }) => pass === false).slice(0, 5).map(({ id }) => clip(id, 60)),
      pass: report.pass,
      scenario: report.scenario,
    };
    const fit = [formatCompactReport(report), minimal].find((candidate) => room(candidate) >= 0);
    if (fit === undefined) omitted += 1;
    else scenarios.push(fit);
  }
  return {
    ...head,
    scenarios,
    ...(omitted === 0 ? {} : { omitted, note: `${omitted} more scenario(s) not shown; read --out for the full report` }),
  };
}
