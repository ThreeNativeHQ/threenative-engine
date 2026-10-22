/**
 * Auto exposure closes on its target over time (3 stops/s up, 1 stop/s down, Unreal's rates, in clock time), so a capture
 * that waits a fixed number of frames stops wherever the clock happens to be: two runs of the foliage cell ended 0.1045
 * and 0.1494 stops short of the target and differed by one display level everywhere (PRD-631 noise floor). The page's own
 * `settled` flag allows 0.25 stops, so the capture reads the distance to the target from the `TN_AUTO_EXPOSURE` reports.
 */
export interface IExposureObservation {
  readonly measured: boolean;
  readonly applied: boolean;
  readonly exposureStops?: number;
  readonly targetStops?: number;
}

/** 0.002 stops is 0.14% of luminance: about 0.1 of 255 at mid grey, a tenth of the 1% p50 noise floor. */
export const EXPOSURE_TOLERANCE_STOPS = 0.002;

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

export function exposureSettled(
  observation: IExposureObservation | undefined,
  tolerance = EXPOSURE_TOLERANCE_STOPS,
): boolean {
  return (
    observation?.measured === true &&
    observation.applied &&
    observation.exposureStops !== undefined &&
    observation.targetStops !== undefined &&
    Math.abs(observation.exposureStops - observation.targetStops) <= tolerance
  );
}

export interface IExposureSource {
  /** The observations that arrived since the settle frames ended, oldest first. */
  observations(): readonly IExposureObservation[];
  wait(ms: number): Promise<void>;
}

/**
 * Returns once the last `streak` observations sit on the target; fails closed when they never do, or when none arrive.
 * The page reports every 0.5 s of clock time, so the two reports of the default streak are at least a second apart.
 */
export async function waitForExposure(
  source: IExposureSource,
  options: {
    readonly tolerance?: number;
    readonly streak?: number;
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<IExposureObservation> {
  const {
    tolerance = EXPOSURE_TOLERANCE_STOPS,
    streak = 2,
    timeoutMs = 120_000,
    intervalMs = 250,
  } = options;
  for (let waited = 0; ; waited += intervalMs) {
    const seen = source.observations();
    const last = seen.at(-1);
    if (
      last !== undefined &&
      seen.length >= streak &&
      seen.slice(-streak).every((o) => exposureSettled(o, tolerance))
    )
      return last;
    if (waited >= timeoutMs) break;
    await source.wait(intervalMs);
  }
  const last = source.observations().at(-1);
  if (last === undefined)
    throw new Error(
      `TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: no TN_AUTO_EXPOSURE observation in ${timeoutMs} ms`,
    );
  const distance =
    last.exposureStops === undefined || last.targetStops === undefined
      ? "an unmeasured exposure"
      : `${Math.abs(last.exposureStops - last.targetStops).toFixed(4)} stops from the target`;
  throw new Error(
    `TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: ${distance} after ${timeoutMs} ms, tolerance ${tolerance} stops: ${JSON.stringify(last)}`,
  );
}

/** L9 meters its exposure, unless the baseline arm, a frame-budget run, a stage ablation or the env switch turned it off. */
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
