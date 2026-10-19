import { stat } from "node:fs/promises";
import { qualifyExposureCase } from "./proof.js";

/** Preserve the original failed scenario before asking for artifacts it could not produce. */
export async function qualifyExposureCapture(
  report: Parameters<typeof qualifyExposureCase>[0],
  expectation: Parameters<typeof qualifyExposureCase>[1],
  screenshot: string,
  name: string,
) {
  const result = qualifyExposureCase(report, expectation);
  if ((await stat(screenshot)).size === 0) throw new Error(`${name}: runtime screenshot missing.`);
  return result;
}
