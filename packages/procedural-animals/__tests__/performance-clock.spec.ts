import {
  type IPlaytestObservationSnapshot,
  PLAYTEST_BRIDGE_GLOBAL,
  PLAYTEST_CLOCK_GLOBAL,
} from "@threenative/playtest/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readAnimalPerformanceClock,
  requireAnimalClockSpan,
  requireAnimalTickCoverage,
} from "../../../examples/procedural-animals/src/performance-clock.js";

afterEach(() => vi.unstubAllGlobals());
function producer(clock: IPlaytestObservationSnapshot["clock"]) {
  vi.stubGlobal(PLAYTEST_CLOCK_GLOBAL, "wall-clock");
  const sample = vi.fn(() => ({ clock }));
  vi.stubGlobal(PLAYTEST_BRIDGE_GLOBAL, { sample });
  return sample;
}
describe("animal performance producer clock admission", () => {
  it("requires an explicit live request before sampling the bridge", async () => {
    const sample = producer({ mode: "wall-clock", tick: 10, timeMs: 20 });
    vi.stubGlobal(PLAYTEST_CLOCK_GLOBAL, undefined);
    await expect(readAnimalPerformanceClock()).rejects.toThrow(/REQUEST_REQUIRED/);
    expect(sample).not.toHaveBeenCalled();
  });
  it("rejects a missing actual producer", async () => {
    vi.stubGlobal(PLAYTEST_CLOCK_GLOBAL, "wall-clock");
    vi.stubGlobal(PLAYTEST_BRIDGE_GLOBAL, undefined);
    await expect(readAnimalPerformanceClock()).rejects.toThrow(/CLOCK_UNAVAILABLE/);
  });
  it.each([
    { mode: "fixed-step", tick: 10, timeMs: 20 },
    { mode: "render-frame", tick: 10, timeMs: 20 },
    { mode: "wall-clock", timeMs: 20 },
    { mode: "wall-clock", tick: 10 },
    { mode: "wall-clock", tick: -1, timeMs: 20 },
    { mode: "wall-clock", tick: 1.5, timeMs: 20 },
    { mode: "wall-clock", tick: 10, timeMs: Number.NaN },
  ] as const)("rejects an unqualified producer observation %j", async (clock) => {
    producer(clock);
    await expect(readAnimalPerformanceClock()).rejects.toThrow(/PRODUCER_CLOCK/);
  });
  it("copies the producer observation without advancing its simulation", async () => {
    const clock = { mode: "wall-clock" as const, tick: 10, timeMs: 20 };
    const sample = producer(clock);
    const observation = await readAnimalPerformanceClock();
    clock.tick = 99;
    expect(observation).toEqual({ mode: "wall-clock", tick: 10, timeMs: 20 });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(sample).toHaveBeenCalledExactlyOnceWith({ entities: [], include: [] });
  });
  it("joins every callback's substeps to the actual loop tick, including zero-step renders", () => {
    expect(() => requireAnimalTickCoverage(10, 10, 0)).not.toThrow();
    expect(() => requireAnimalTickCoverage(10, 12, 2)).not.toThrow();
    for (const [previous, current, substeps] of [
      [10, 12, 0],
      [10, 9, 0],
      [10, 11, Number.NaN],
      [Number.NaN, 11, 1],
      [10, 11, 0.5],
    ] as const)
      expect(() => requireAnimalTickCoverage(previous, current, substeps)).toThrow(/TICK_COVERAGE/);
  });
  it("requires both producer time and simulation ticks to advance", () => {
    const start = { mode: "wall-clock" as const, tick: 10, timeMs: 20 };
    expect(() => requireAnimalClockSpan(start, { ...start, tick: 20, timeMs: 30 })).not.toThrow();
    expect(() => requireAnimalClockSpan(start, { ...start, timeMs: 30 })).toThrow(
      /DID_NOT_ADVANCE/,
    );
    expect(() => requireAnimalClockSpan(start, { ...start, tick: 20 })).toThrow(/DID_NOT_ADVANCE/);
  });
});
