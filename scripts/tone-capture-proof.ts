import type { IPlaytestDiagnostic } from "../packages/playtest/src/index.js";

/** Pixel qualification is stricter than a software simulation-only run. */
export function assertToneCaptureDiagnostics(
  diagnostics: readonly IPlaytestDiagnostic[],
  variant: "underexposed" | "restored",
): void {
  for (const diagnostic of diagnostics) {
    const expectedToneFailure =
      variant === "underexposed" && diagnostic.code === "TN_PLAYTEST_TONE_ASSERTION_FAILED";
    if (
      diagnostic.code === "TN_PLAYTEST_SOFTWARE_DEVICE_LOST" ||
      (diagnostic.severity === "error" && !expectedToneFailure)
    ) {
      throw new Error(`${variant}: ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
}
