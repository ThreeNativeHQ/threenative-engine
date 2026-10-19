import type { IPlaytestDiagnostic } from "../packages/playtest/src/index.js";

/** Real pixel qualification never accepts a software device-loss downgrade. */
export function assertVelocityCaptureDiagnostics(
  diagnostics: readonly IPlaytestDiagnostic[],
  control: boolean,
): void {
  for (const diagnostic of diagnostics) {
    const expected = control && diagnostic.code === "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED";
    if (
      diagnostic.code === "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" ||
      (diagnostic.severity === "error" && !expected)
    )
      throw new Error(`${diagnostic.code}: ${diagnostic.message}`);
  }
}
