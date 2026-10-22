import type { Page } from "@playwright/test";

/**
 * Auto exposure closes on its target over time (3 stops/s up, 1 stop/s down, Unreal's rates, in clock time), so a capture
 * that waits a fixed number of frames stops wherever the clock happens to be: two runs of the foliage cell ended 0.1045
 * and 0.1494 stops short of the target, still moving, and differed by one display level everywhere (PRD-631 noise floor).
 * The page's own `settled` flag allows 0.25 stops and said true in both, so the capture reads the distance the exposure
 * moves between reports and waits until it stops.
 *
 * It waits for rest, not for the target. Every value the page prints is exact in half float, and a frame's step toward
 * the target rounds to nothing a little short of it: the owner set stopped 0.006 to 0.009 stops short for good (more at
 * 60 frames/s, where the step is smaller). That is the same place on every run at one frame rate, so it is no noise.
 */
export interface IExposureObservation {
  readonly measured: boolean;
  readonly applied: boolean;
  readonly exposureStops?: number;
  readonly targetStops?: number;
}

/** A move between reports this small is rest: one half-float step is 0.002 in [2, 4) stops and 0.004 in [4, 8). */
export const EXPOSURE_STEADY_STOPS = 0.004;
/** At rest farther than this from the target is a stuck meter, not a landed exposure. */
export const EXPOSURE_NEAR_STOPS = 0.15;

const PREFIX = "TN_AUTO_EXPOSURE:";

/** The observation a page message carries; any other message, or one that is not an observation, is undefined. */
export function parseExposure(text: string): IExposureObservation | undefined {
  if (!text.startsWith(PREFIX)) return undefined;
  try {
    const value = JSON.parse(text.slice(PREFIX.length)) as Partial<IExposureObservation> | null;
    return typeof value?.measured === "boolean" && typeof value.applied === "boolean"
      ? (value as IExposureObservation)
      : undefined;
  } catch {
    return undefined;
  }
}

/** True when every report is measured and applied, the exposure moved no more than `steady`, and it sits within `near` of the target. */
export function exposureAtRest(
  reports: readonly IExposureObservation[],
  limits: { readonly steady?: number; readonly near?: number } = {},
): boolean {
  const { steady = EXPOSURE_STEADY_STOPS, near = EXPOSURE_NEAR_STOPS } = limits;
  const stops: number[] = [];
  for (const report of reports) {
    if (!report.measured || !report.applied) return false;
    if (report.exposureStops === undefined || report.targetStops === undefined) return false;
    stops.push(report.exposureStops);
  }
  const last = reports.at(-1);
  if (last?.exposureStops === undefined || last.targetStops === undefined) return false;
  return (
    Math.max(...stops) - Math.min(...stops) <= steady &&
    Math.abs(last.exposureStops - last.targetStops) <= near
  );
}

/** One `TN_AUTO_EXPOSURE` console line, with the harness clock at the time it arrived. */
export interface IExposureReading {
  readonly atMs: number;
  readonly text: string;
}

/**
 * An L9 frame is taken after this many readings in a row, all at rest, since the pose. The page reports every 0.5 s of
 * clock time, so three readings span a second: an exposure that is not stalled moves at least 0.63 of its distance to
 * the target in that second, so a move under 0.004 stops means it is within 0.007 stops of the target, or stalled at
 * the half-float step.
 */
const SETTLED_READINGS = 3;

/**
 * True once the auto exposure has come to rest on the view the pose set. One reading right after the pose can still
 * describe the old view, so the last three readings since the pose must all be measured and at rest. An invalid reading
 * ("Exposure readback is invalid") counts as not at rest: that frame has not adapted.
 */
export function exposureSettled(
  readings: readonly IExposureReading[],
  sinceMs: number,
  count = SETTLED_READINGS,
): boolean {
  const last = readings.filter((r) => r.atMs > sinceMs).slice(-count);
  if (last.length !== count) return false;
  const observations: IExposureObservation[] = [];
  for (const reading of last) {
    const observation = parseExposure(reading.text);
    if (observation === undefined) return false;
    observations.push(observation);
  }
  return exposureAtRest(observations);
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
  return `TN_UNREAL_LOOK_EXPOSURE_NOT_SETTLED: no ${SETTLED_READINGS} readings at rest in ${Math.round(timeoutMs / 1000)} s after the pose (they move over ${EXPOSURE_STEADY_STOPS} stops, or rest more than ${EXPOSURE_NEAR_STOPS} stops from the target; last: ${last.join(" | ") || "none"})`;
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
 * Holds the capture until the exposure has come to rest, and fails closed when it never does. An exposure the scene
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

/**
 * L9 meters its exposure, unless the baseline arm, a frame-budget run, a stage ablation or the env switch turned it off:
 * those pages run no auto exposure, print no reading, and a capture that waited for one would fail after the timeout.
 */
export function metersExposure(run: {
  readonly layer: string;
  readonly baseline?: boolean;
  readonly measureSeconds?: number;
  /** The `?off=` list and any extra query the run adds to the page address. */
  readonly switches?: string;
}): boolean {
  return (
    run.layer === "L9" &&
    run.baseline !== true &&
    run.measureSeconds === undefined &&
    process.env.TN_UNREAL_LOOK_NO_AUTO_EXPOSURE !== "1" &&
    !(run.switches ?? "").includes("autoexposure")
  );
}
