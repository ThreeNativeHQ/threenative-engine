import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import type { IPlaytestReport } from "../packages/playtest/src/report.js";

/** Software is allowed for correctness, but a lost device is never rendered evidence. */
export function requireTemporalRenderEvidence(
  report: Pick<IPlaytestReport, "capture" | "diagnostics"> & { pass: boolean },
  variant: string,
): void {
  assert.ok(
    !report.diagnostics.some(({ code }) => code === "TN_PLAYTEST_SOFTWARE_DEVICE_LOST"),
    `${variant}: device loss disqualifies render evidence`,
  );
  assert.ok(
    !report.diagnostics.some(({ severity }) => severity === "error"),
    `${variant}: error diagnostics: ${JSON.stringify(report.diagnostics)}`,
  );
  assert.equal(report.pass, true, `${variant}: ${JSON.stringify(report.diagnostics)}`);
  assert.ok(
    report.capture && Object.values(report.capture.adapter).some((value) => value.length > 0),
    `${variant}: adapter provenance required`,
  );
  assert.equal(report.capture.rendererKind, "webgpu", `${variant}: expected WebGPU`);
}

/** Retain every arm before rejecting a completed measurement. */
export async function writeTemporalMotionSummary(
  filename: string,
  measurement: {
    authoredLinearEquivalent: boolean;
    checks: Record<string, boolean>;
    [key: string]: unknown;
  },
): Promise<void> {
  const checks = Object.values(measurement.checks);
  const summary = {
    ...measurement,
    pass: measurement.authoredLinearEquivalent && checks.length > 0 && checks.every(Boolean),
  };
  await writeFile(filename, `${JSON.stringify(summary, null, 2)}\n`);
  assert.ok(
    summary.authoredLinearEquivalent,
    `Authored-linear equivalence failed; cubic interpretation is invalid. All arm measurements retained at ${filename}`,
  );
  assert.ok(
    checks.length > 0,
    `Missing temporal quality checks; supply the required measurement gates. All arm measurements retained at ${filename}`,
  );
  assert.ok(
    summary.pass,
    `Temporal motion quality remains unqualified: ${JSON.stringify(summary.checks)}; actual frames and full measurements retained at ${filename}`,
  );
}
