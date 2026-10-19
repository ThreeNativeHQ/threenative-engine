import {
  type IPlaytestBridgeHost,
  type IPlaytestObservationSnapshot,
  PLAYTEST_BRIDGE_GLOBAL,
  requestedPlaytestClockMode,
} from "@threenative/playtest/protocol";

export type AnimalPerformanceClock = Readonly<Required<IPlaytestObservationSnapshot["clock"]>>;

/** Read the installed producer, before observation allocation and after measurement only. */
export async function readAnimalPerformanceClock(): Promise<AnimalPerformanceClock> {
  if (requestedPlaytestClockMode() !== "wall-clock")
    throw new Error("TN_ANIMAL_PERFORMANCE_WALL_CLOCK_REQUEST_REQUIRED");
  const bridge = (globalThis as IPlaytestBridgeHost)[PLAYTEST_BRIDGE_GLOBAL];
  if (!bridge) throw new Error("TN_ANIMAL_PERFORMANCE_CLOCK_UNAVAILABLE");
  const { clock } = await bridge.sample({ entities: [], include: [] });
  const { tick, timeMs } = clock;
  if (
    clock.mode !== "wall-clock" ||
    typeof tick !== "number" ||
    !Number.isSafeInteger(tick) ||
    tick < 0 ||
    typeof timeMs !== "number" ||
    !Number.isFinite(timeMs) ||
    timeMs < 0
  )
    throw new Error("TN_ANIMAL_PERFORMANCE_PRODUCER_CLOCK");
  return Object.freeze({ mode: clock.mode, tick, timeMs });
}

/** Verify recorded in-callback simulation work against the actual loop's public tick counter. */
export function requireAnimalTickCoverage(
  previous: number,
  current: number,
  substeps: number,
): void {
  if (
    !Number.isSafeInteger(previous) ||
    previous < 0 ||
    !Number.isSafeInteger(current) ||
    current < previous ||
    !Number.isSafeInteger(substeps) ||
    substeps < 0 ||
    current - previous !== substeps
  )
    throw new Error("TN_ANIMAL_PERFORMANCE_TICK_COVERAGE");
}

export function requireAnimalClockSpan(
  start: AnimalPerformanceClock,
  end: AnimalPerformanceClock,
): void {
  if (end.mode !== "wall-clock" || end.tick <= start.tick || end.timeMs <= start.timeMs)
    throw new Error("TN_ANIMAL_PERFORMANCE_CLOCK_DID_NOT_ADVANCE");
}
