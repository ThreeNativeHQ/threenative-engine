// One series, three callers, and the rules they used to disagree about: a repeated frame id is a
// resolve still in flight, the smoothed value drops after the engine's stale limit, and a reading's
// age decides freshness for a window decision.
import { describe, expect, it } from "vitest";
import { GPU_STALE_FRAME_LIMIT, GpuReadings } from "../src/gpu-readings.js";

describe("the GPU readings series", () => {
  it("should smooth half and half by default", () => {
    const readings = new GpuReadings();
    readings.note(10, 1);
    expect(readings.ema).toBe(10);
    readings.note(20, 2);
    expect(readings.ema).toBe(15);
  });

  it("should refuse a repeated frame id as a sample still in flight", () => {
    const readings = new GpuReadings();
    readings.note(10, 7);
    readings.note(99, 7);
    expect(readings.ema).toBe(10);
    expect(readings.last).toEqual({ frame: 7, ms: 10 });
  });

  it("should drop the smoothed value after the stale limit, and recover on a real sample", () => {
    const readings = new GpuReadings();
    readings.note(10, 1);
    // The limit counts stale notes, so it takes exactly that many to drop the value.
    for (let stale = 0; stale < GPU_STALE_FRAME_LIMIT - 1; stale += 1)
      readings.note(undefined, 2 + stale);
    expect(readings.ema).toBe(10);
    readings.note(undefined, 99);
    expect(readings.ema).toBeUndefined();
    readings.note(12, 99);
    expect(readings.ema).toBe(12);
  });

  it("should treat a negative or non-finite reading as stale, never as a measurement", () => {
    const readings = new GpuReadings();
    readings.note(Number.NaN, 1);
    readings.note(-1, 2);
    expect(readings.ema).toBeUndefined();
    expect(readings.last).toBeUndefined();
  });
});
