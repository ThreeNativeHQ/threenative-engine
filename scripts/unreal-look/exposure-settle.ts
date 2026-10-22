/**
 * Auto exposure closes on its target over time (3 stops/s up, 1 stop/s down, Unreal's rates, in clock time), so a capture
 * that waits a fixed number of frames stops wherever the clock happens to be: two runs of the foliage cell ended 0.1045
 * and 0.1494 stops short of the target, still moving, and differed by one display level everywhere (PRD-631 noise floor).
 * The page's own `settled` flag allows 0.25 stops, so the capture reads the `TN_AUTO_EXPOSURE` reports and waits until
 * the exposure stops moving.
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

export interface IExposureSource {
  /** The observations that arrived since the settle frames ended, oldest first. */
  observations(): readonly IExposureObservation[];
  wait(ms: number): Promise<void>;
}

const stopsOf = (report: IExposureObservation) =>
  `${report.exposureStops?.toFixed(4) ?? "none"}/${report.targetStops?.toFixed(4) ?? "none"}`;

/**
 * Returns the last report once the last `streak` reports are at rest; fails closed when they never are, or when none
 * arrive. The page reports every 0.5 s of clock time, so the three reports of the default streak span a second: an
 * exposure that is not stalled moves at least 0.63 of its distance to the target in that second, so a move under
 * 0.004 stops means it is within 0.007 stops of the target, or stalled at the half-float step.
 */
export async function waitForExposure(
  source: IExposureSource,
  options: {
    readonly steady?: number;
    readonly near?: number;
    readonly streak?: number;
    readonly timeoutMs?: number;
    readonly intervalMs?: number;
  } = {},
): Promise<IExposureObservation> {
  const {
    steady = EXPOSURE_STEADY_STOPS,
    near = EXPOSURE_NEAR_STOPS,
    streak = 3,
    timeoutMs = 120_000,
    intervalMs = 250,
  } = options;
  for (let waited = 0; ; waited += intervalMs) {
    const recent = source.observations().slice(-streak);
    const last = recent.at(-1);
    if (last !== undefined && recent.length === streak && exposureAtRest(recent, { near, steady }))
      return last;
    if (waited >= timeoutMs) break;
    await source.wait(intervalMs);
  }
  const lastReports = source.observations().slice(-streak);
  if (lastReports.length === 0)
    throw new Error(
      `TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: no TN_AUTO_EXPOSURE observation in ${timeoutMs} ms`,
    );
  throw new Error(
    `TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: not at rest within ${timeoutMs} ms (moves over ${steady} stops, or rests more than ${near} stops from its target); last reports, exposure/target in stops: ${lastReports.map(stopsOf).join(", ")}`,
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
