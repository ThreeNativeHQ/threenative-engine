import type { Page } from "@playwright/test";

/** One `TN_AUTO_EXPOSURE` console line, with the harness clock at the time it arrived. */
export interface IExposureReading {
  readonly atMs: number;
  readonly text: string;
}

/** An L9 frame is taken after this many readings in a row, all measured and settled, since the pose. */
const SETTLED_READINGS = 3;

function landed(text: string): boolean {
  try {
    const reading = JSON.parse(text.slice(text.indexOf("{"))) as {
      measured?: unknown;
      settled?: unknown;
    };
    return reading.measured === true && reading.settled === true;
  } catch {
    return false;
  }
}

/**
 * True once the auto exposure has landed on the view the pose set. One reading right after the pose can still
 * describe the old view, so the last three readings since the pose must all be measured and settled. An invalid
 * reading ("Exposure readback is invalid") counts as not settled: that frame has not adapted.
 */
export function exposureSettled(
  readings: readonly IExposureReading[],
  sinceMs: number,
  count = SETTLED_READINGS,
): boolean {
  const last = readings.filter((r) => r.atMs > sinceMs).slice(-count);
  return last.length === count && last.every((r) => landed(r.text));
}

export function notSettledMessage(
  readings: readonly IExposureReading[],
  sinceMs: number,
  timeoutMs: number,
): string {
  const last = readings
    .filter((r) => r.atMs > sinceMs)
    .slice(-SETTLED_READINGS)
    .map((r) => r.text);
  return `TN_UNREAL_LOOK_EXPOSURE_NOT_SETTLED: no ${SETTLED_READINGS} settled readings in ${Math.round(timeoutMs / 1000)} s after the pose (last: ${last.join(" | ") || "none"})`;
}

/** Collects every `TN_AUTO_EXPOSURE` line the page prints, for `awaitExposureSettled`. */
export function watchExposure(page: Page): IExposureReading[] {
  const readings: IExposureReading[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("TN_AUTO_EXPOSURE"))
      readings.push({ atMs: Date.now(), text: message.text() });
  });
  return readings;
}

/**
 * Holds the capture until the exposure has landed, and fails closed when it never does. An exposure the scene
 * switched off (the latest reading says `applied: false`) does not drive the frame, so there is nothing to wait for.
 */
export async function awaitExposureSettled(
  page: Page,
  readings: readonly IExposureReading[],
  sinceMs: number,
  timeoutMs = 120_000,
): Promise<number> {
  const started = Date.now();
  const switchedOff = () => readings.at(-1)?.text.includes('"applied":false') === true;
  while (!switchedOff() && !exposureSettled(readings, sinceMs)) {
    if (Date.now() - started > timeoutMs)
      throw new Error(notSettledMessage(readings, sinceMs, timeoutMs));
    await page.waitForTimeout(250);
  }
  return Date.now() - started;
}
