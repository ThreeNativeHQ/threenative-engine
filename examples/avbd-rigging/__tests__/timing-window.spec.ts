import { describe, expect, it, vi } from "vitest";
import {
  type ISecondaryTickSample,
  SecondaryTimingWindow,
  timingP95,
} from "../src/physics/timing-window.js";

function sample(tick: number): ISecondaryTickSample {
  return {
    tick,
    cpuSubmissionMs: 0.501,
    diagnosticSubmissionMs: 0,
    gpuLowerMs: 2,
    gpuUpperMs: 3,
    diagnosticTailUpperMs: 0,
    queryIds: [`q:${tick}`],
    phaseMs: [0.5, 0.5, 0.5, 0.5],
  };
}

describe("original exact ready-frame timing window", () => {
  it("retains all1800frames after300warmup and consumes completed receipts once", () => {
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    const reads: ReturnType<typeof vi.fn>[] = [];
    for (let frame = 0; frame < 2100; frame++) {
      const read = vi.fn(() => sample(frame));
      reads.push(read);
      window.add({ generation, tick: frame, read });
      expect(window.frame({ atMs: (frame * 1000) / 60, paused: false })).toBe(frame === 2099);
      window.collect();
    }
    window.collect();
    const rows = window.result();
    expect(rows).toHaveLength(1800);
    expect(rows?.[0]?.frame).toBe(300);
    expect(rows?.at(-1)?.frame).toBe(2099);
    expect(rows?.[0]?.ticks[0]?.tick).toBe(300);
    expect(rows?.[0]?.renderCallbackElapsedMs).toBeCloseTo(1000 / 60, 8);
    expect(rows?.reduce((sum, row) => sum + row.renderCallbackElapsedMs, 0)).toBeCloseTo(30000, 8);
    expect(reads.every((read) => read.mock.calls.length === 1)).toBe(true);
    expect(() => window.frame({ atMs: 40000, paused: false })).toThrow(/TN_RIGGING_TIMING_SEALED/);
    expect(timingP95(rows?.map((r) => r.cpuSubmissionMs) ?? [])).toBe(0.501);
  });
  it("preserves zero-tickframes and adds everycatch-up tick to its actualrender frame", () => {
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    let tick = 0;
    for (let frame = 0; frame < 2100; frame++) {
      if (frame % 2 === 0)
        for (let i = 0; i < 2; i++) {
          const value = tick++;
          window.add({
            generation,
            tick: value,
            read: () => ({ ...sample(value), gpuLowerMs: 2.2 }),
          });
        }
      window.frame({ atMs: (frame * 1000) / 60, paused: false });
    }
    window.collect();
    const rows = window.result();
    expect(rows?.[0]?.ticks).toHaveLength(2);
    expect(rows?.[0]?.gpuUpperMs).toBe(6);
    expect(rows?.[0]?.gpuLowerMs).toBe(2.2);
    expect(rows?.[1]?.ticks).toHaveLength(0);
    expect(rows?.[1]?.gpuUpperMs).toBe(0);
  });
  it("cannot turn incomplete, late or wholly empty observations into zero milliseconds", () => {
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    window.add({ generation, tick: 0, read: () => undefined });
    for (let i = 0; i < 2100; i++) window.frame({ atMs: (i * 1000) / 60, paused: false });
    window.collect();
    expect(window.result()).toBeUndefined();
    window.retire();
    expect(() => window.collect()).toThrow(/TN_RIGGING_TIMING_STALE/);
    const empty = new SecondaryTimingWindow(generation);
    for (let i = 0; i < 2100; i++) empty.frame({ atMs: (i * 1000) / 60, paused: false });
    expect(() => empty.result()).toThrow(/TN_RIGGING_TIMING_MISSING/);
  });
  it("rejects skipped, duplicate and wrong-generation ticks before they enter a frame", () => {
    const generation = {};
    for (const mode of ["skip", "duplicate", "generation"]) {
      const window = new SecondaryTimingWindow(generation);
      window.add({ generation, tick: 0, read: () => sample(0) });
      expect(() =>
        window.add({
          generation: mode === "generation" ? {} : generation,
          tick: mode === "skip" ? 2 : mode === "duplicate" ? 0 : 1,
          read: () => sample(1),
        }),
      ).toThrow(/TN_RIGGING_TIMING_MEMBERSHIP/);
    }
  });
  it("rejects duplicate queries and impossible bounds instead of repeating a cached sample", () => {
    const generation = {};
    for (const mode of ["query", "bounds", "nonfinite", "identity"]) {
      const window = new SecondaryTimingWindow(generation);
      window.add({ generation, tick: 0, read: () => sample(0) });
      window.add({
        generation,
        tick: 1,
        read: () => ({
          ...sample(mode === "identity" ? 0 : 1),
          queryIds: mode === "query" ? ["q:0"] : ["q:1"],
          gpuUpperMs: mode === "bounds" ? 1 : 3,
          cpuSubmissionMs: mode === "nonfinite" ? Number.NaN : 0.1,
        }),
      });
      expect(() => window.collect()).toThrow(/TN_RIGGING_TIMING_(DUPLICATE|INVALID|MEMBERSHIP)/);
    }
  });
  it("bounds five fixed steps per render and does not round an original threshold into a pass", () => {
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    for (let tick = 0; tick < 5; tick++) window.add({ generation, tick, read: () => sample(tick) });
    expect(() => window.add({ generation, tick: 5, read: () => sample(5) })).toThrow(
      /TN_RIGGING_TIMING_CAPACITY/,
    );
    expect(timingP95(Array(1800).fill(0.501))).toBeGreaterThan(0.5);
    expect(() => timingP95([])).toThrow(/TN_RIGGING_TIMING_MISSING/);
    expect(() => timingP95(Array(1799).fill(1))).toThrow(/TN_RIGGING_TIMING_MISSING/);
  });
});

describe("window failure and dense observation regressions", () => {
  it.each(["membership", "reader", "undefined-reader", "malformed", "duplicate-query"])(
    "permanently rejects after a caught %s failure rather than repairing into a pass",
    (mode) => {
      const generation = {};
      const window = new SecondaryTimingWindow(generation);
      let broken = true;
      const read = () => {
        if (broken && mode === "reader") throw new Error("read failed");
        if (broken && mode === "undefined-reader") throw undefined;
        return { ...sample(0), cpuSubmissionMs: broken && mode === "malformed" ? Number.NaN : 0.1 };
      };
      window.add({ generation, tick: 0, read });
      let failed = false;
      try {
        if (mode === "membership") window.add({ generation, tick: 0, read });
        if (mode === "duplicate-query")
          window.add({
            generation,
            tick: 1,
            read: () => ({ ...sample(1), queryIds: [broken ? "q:0" : "q:1"] }),
          });
        window.collect();
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      broken = false;
      for (const operation of [
        () => window.frame({ atMs: 40000, paused: false }),
        () => window.collect(),
        () => window.result(),
        () =>
          window.add({
            generation,
            tick: mode === "duplicate-query" ? 2 : 1,
            read: () => sample(1),
          }),
      ]) {
        let rejected = false;
        try {
          operation();
        } catch {
          rejected = true;
        }
        expect(rejected).toBe(true);
      }
    },
  );
  it("publishes no partial sample or query set if the later receipt in a poll fails", () => {
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    window.add({ generation, tick: 0, read: () => sample(0) });
    window.add({ generation, tick: 1, read: () => ({ ...sample(1), queryIds: ["q:0"] }) });
    expect(() => window.collect()).toThrow(/TN_RIGGING_TIMING_DUPLICATE/);
    expect(window.completedTicks).toBe(0);
  });
  it("rejects sparse frame values and query IDs instead of treating absent samples as zero", () => {
    const sparse = Array<number>(1800);
    for (let i = 0; i < 1790; i++) sparse[i] = 0;
    expect(() => timingP95(sparse)).toThrow(/TN_RIGGING_TIMING_MISSING/);
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    window.add({ generation, tick: 0, read: () => ({ ...sample(0), queryIds: Array<string>(1) }) });
    expect(() => window.collect()).toThrow(/TN_RIGGING_TIMING_INVALID/);
  });
});

describe("presentation cadence and continuous fixed workload", () => {
  it("rejects paused, absent and nonmonotonic presentation observations", () => {
    for (const observation of [
      undefined,
      { atMs: Number.NaN, paused: false },
      { atMs: 1, paused: true },
    ]) {
      const window = new SecondaryTimingWindow({});
      expect(() => window.frame(observation as never)).toThrow(/TN_RIGGING_TIMING_CADENCE/);
    }
    const window = new SecondaryTimingWindow({});
    window.frame({ atMs: 1, paused: false });
    expect(() => window.frame({ atMs: 1, paused: false })).toThrow(/TN_RIGGING_TIMING_CADENCE/);
  });
  it("rejects one expensive tick diluted by1799idle frames across a30second workload", () => {
    const generation = {};
    const window = new SecondaryTimingWindow(generation);
    window.add({ generation, tick: 0, read: () => sample(0) });
    for (let frame = 0; frame < 2100; frame++) {
      if (frame === 300)
        window.add({
          generation,
          tick: 1,
          read: () => ({ ...sample(1), gpuLowerMs: 20, gpuUpperMs: 21 }),
        });
      window.frame({ atMs: (frame * 1000) / 60, paused: false });
    }
    window.collect();
    expect(() => window.result()).toThrow(/TN_RIGGING_TIMING_CADENCE/);
  });
});
