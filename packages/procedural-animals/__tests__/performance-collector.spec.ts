import { describe, expect, it } from "vitest";
import type {
  GpuFrameObservation,
  GpuObservedFrame,
} from "../../../examples/procedural-animals/src/performance-collector.js";
import { FrameBudget } from "../../core/src/frame-budget.js";
type GpuFrameObservationStatus = ReturnType<GpuFrameObservation["status"]>;
import {
  AnimalPerformanceCollector,
  percentile95,
} from "../../../examples/procedural-animals/src/performance-collector.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
class Observer implements GpuFrameObservation {
  rows: GpuObservedFrame[] = [];
  generation = 1;
  state: GpuFrameObservationStatus["state"] = "active";
  pending = 0;
  status(): GpuFrameObservationStatus {
    return {
      generation: this.generation,
      state: this.state,
      stopFrame: undefined,
      maxFrames: 4096,
      maxQueries: 16384,
      expectedFrames: 0,
      expectedQueries: 0,
      resolvedFrames: 0,
      resolvedQueries: 0,
      deliveredFrames: 0,
      deliveredQueries: 0,
      pendingFrames: this.pending,
      pendingQueries: this.pending * 2,
      undrainedFrames: 0,
      undrainedQueries: 0,
      queuedFrames: this.rows.length,
      queuedQueries: this.rows.length * 2,
      droppedFrames: 0,
      droppedQueries: 0,
      allocationLoss: "not-observed",
      ignoredCompletions: 0,
      failure: undefined,
    };
  }
  take() {
    const rows = this.rows;
    this.rows = [];
    return rows;
  }
  stop() {
    if (this.state === "active") this.state = "stopped";
  }
  dispose() {
    this.state = "disposed";
  }
}
function sample(frame: number, ms = 2): GpuObservedFrame {
  return {
    generation: 1,
    batch: 1,
    frame,
    ms,
    queries: [{ uid: `r:1:2:f${frame}`, begin: 0, end: 1, ms }],
  };
}
function window(window = 1, ms = 3) {
  return {
    window,
    frames: 1,
    hitches: 0,
    substeps: { samples: 1, mean: 1 },
    frame: { samples: 1, mean: ms, p50: ms, p95: ms, p99: ms, max: ms },
  };
}
function world(collector: AnimalPerformanceCollector, frame: number, wolves: 0 | 1 | 32 = 32) {
  collector.beginWorld(frame);
  for (let wolf = 0; wolf < wolves; wolf++) {
    collector.submitted(frame, wolf, "shadow");
    collector.submitted(frame, wolf, "main");
  }
  collector.endWorld(frame);
}
function full(wolves: 0 | 1 | 32 = 32, substeps = 1) {
  const observer = new Observer();
  const collector = new AnimalPerformanceCollector(wolves, observer);
  const budget = new FrameBudget({
    reportEvery: 1,
    report: () => {},
    onWindow: (w) => collector.cpu(w, now),
  });
  let now = 0;
  for (let i = 0; i < 2100; i++) {
    const frame = i * 2;
    budget.beginFrame(i * 17, i * 17);
    world(collector, frame, wolves);
    budget.markSimulationEnd(i * 17 + 1, substeps);
    now = i * 17 + 3.004;
    budget.endFrame(now);
  }
  return { observer, collector, now };
}
describe("game-owned exact performance collector staging", () => {
  it("retains immutable partial CPU/GPU rows after failure cleanup without qualifying an incomplete series", () => {
    const observer = new Observer();
    const collector = new AnimalPerformanceCollector(0, observer);
    world(collector, 12, 0);
    collector.cpu(window(), 10);
    observer.rows = [sample(12)];
    expect(collector.poll(11)).toBeUndefined();
    const rows = collector.recordedRows();
    collector.dispose();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      frame: 12,
      ended: true,
      cpuWindow: 1,
      cpuMs: 3,
      gpu: sample(12),
    });
    expect(Object.isFrozen(rows)).toBe(true);
    expect(Object.isFrozen(rows[0])).toBe(true);
    expect(Object.isFrozen(required(rows[0]).main)).toBe(true);
    expect(Object.isFrozen(required(rows[0]).shadow)).toBe(true);
    expect(Object.isFrozen(required(rows[0]).gpu?.queries)).toBe(true);
  });

  it("rejects 2100 rendered frames with a frozen simulation", () => {
    const { collector, observer, now } = full(32, 0);
    observer.rows = Array.from({ length: 2100 }, (_, i) => sample(i * 2));
    expect(() => collector.poll(now + 1)).toThrow(/NO_SIMULATION/);
  });

  for (const wolves of [0, 1, 32] as const)
    it(`records300+1800 real FrameBudget callback windows for${wolves} wolves`, () => {
      const { collector, observer, now } = full(wolves);
      observer.rows = Array.from({ length: 2100 }, (_, i) => sample(i * 2, i < 300 ? 999 : 2));
      const receipt = required(collector.poll(now + 1));
      expect(receipt.warmup).toHaveLength(300);
      expect(receipt.measurement).toHaveLength(1800);
      expect(receipt.cpuP95Ms).toBe(3);
      expect(receipt.gpuP95Ms).toBe(2);
      expect(
        receipt.measurement.every(
          (row) => row.main.length === wolves && row.shadow.length === wolves,
        ),
      ).toBe(true);
      expect(receipt.cpuRoundingUncertaintyMs).toBe(0.005);
      expect(Object.isFrozen(required(receipt.measurement[0]).main)).toBe(true);
    });
  it("joins delayed reverse-order GPU deliveries by actual world ID and ignores overlay IDs", () => {
    const { collector, observer, now } = full();
    observer.rows = [
      sample(1, 900),
      ...Array.from({ length: 1800 }, (_, i) => sample((2099 - i) * 2, 2)),
    ];
    const receipt = required(collector.poll(now + 1));
    expect(required(required(receipt.measurement[0]).gpu).frame).toBe(600);
    expect(required(required(receipt.measurement[1799]).gpu).frame).toBe(4198);
    expect(receipt.ignoredGpuFrames).toBe(1);
  });
  it("rejects a visible wolf culled during any selected frame", () => {
    const collector = new AnimalPerformanceCollector(32, new Observer());
    collector.beginWorld(1);
    for (let wolf = 0; wolf < 31; wolf++) {
      collector.submitted(1, wolf, "main");
      collector.submitted(1, wolf, "shadow");
    }
    expect(() => collector.endWorld(1)).toThrow(/VISIBLE_WOLF_NOT_SUBMITTED/);
  });
  it("rejects a shadow-free or doubled opaque animal draw", () => {
    for (const draws of [0, 2]) {
      const collector = new AnimalPerformanceCollector(1, new Observer());
      collector.beginWorld(1);
      for (let j = 0; j < draws; j++) collector.submitted(1, 0, "main");
      expect(() => collector.endWorld(1)).toThrow(/VISIBLE_WOLF_NOT_SUBMITTED/);
    }
  });
  it("rejects aggregated/missing/hitched/nonfinite CPU observations", () => {
    for (const mutate of [
      (w: ReturnType<typeof window>) => {
        w.frames = 300;
      },
      (w: ReturnType<typeof window>) => {
        w.hitches = 1;
      },
      (w: ReturnType<typeof window>) => {
        w.frame.samples = 0;
      },
      (w: ReturnType<typeof window>) => {
        w.frame.mean = Number.NaN;
      },
      (w: ReturnType<typeof window>) => {
        w.frame.p95 = 19;
      },
    ]) {
      const collector = new AnimalPerformanceCollector(1, new Observer());
      world(collector, 1, 1);
      const w = window();
      mutate(w);
      expect(() => collector.cpu(w, 1)).toThrow(/CPU_WINDOW_INCOMPLETE/);
    }
  });
  it("rejects skipped windows and multiple world renders within one CPU callback", () => {
    const collector = new AnimalPerformanceCollector(0, new Observer());
    world(collector, 1, 0);
    collector.cpu(window(10), 1);
    world(collector, 3, 0);
    expect(() => collector.cpu(window(12), 2)).toThrow(/CPU_WINDOW_INCOMPLETE/);
    const another = new AnimalPerformanceCollector(0, new Observer());
    world(another, 1, 0);
    expect(() => another.beginWorld(2)).toThrow(/WORLD_FRAME_ORDER/);
  });
  it("rejects duplicate GPU data even after polling", () => {
    const observer = new Observer();
    const collector = new AnimalPerformanceCollector(0, observer);
    world(collector, 2, 0);
    collector.cpu(window(), 1);
    observer.rows = [sample(2)];
    collector.poll(2);
    observer.rows = [sample(2)];
    expect(() => collector.poll(3)).toThrow(/GPU_DUPLICATE/);
  });
  it("rejects stale generation, nonrender query, wrong ID, duplicate offset and incomplete sum", () => {
    for (const mutate of [
      (s: GpuObservedFrame) => ({ ...s, generation: 2 }),
      (s: GpuObservedFrame) => ({
        ...s,
        queries: [{ ...required(s.queries[0]), uid: "c:1:2:f2" }],
      }),
      (s: GpuObservedFrame) => ({
        ...s,
        queries: [{ ...required(s.queries[0]), uid: "r:1:2:f9" }],
      }),
      (s: GpuObservedFrame) => ({
        ...s,
        queries: [...s.queries, { ...required(s.queries[0]), uid: "r:2:3:f2" }],
      }),
      (s: GpuObservedFrame) => ({ ...s, ms: 3 }),
    ]) {
      const observer = new Observer();
      const collector = new AnimalPerformanceCollector(0, observer);
      world(collector, 2, 0);
      collector.cpu(window(), 1);
      observer.rows = [mutate(sample(2))];
      expect(() => collector.poll(2)).toThrow(/GPU_/);
    }
  });
  it("fails bounded drain on a missing selected GPU row instead of substituting latest", () => {
    const { collector, observer, now } = full();
    observer.rows = Array.from({ length: 1799 }, (_, i) => sample((i + 300) * 2));
    expect(collector.poll(now + 1999)).toBeUndefined();
    expect(() => collector.poll(now + 2000)).toThrow(/DRAIN_TIMEOUT/);
  });
  it("rejects a first completed drain observed beyond its unchanged two-second deadline", () => {
    const { collector, observer, now } = full();
    observer.rows = Array.from({ length: 1800 }, (_, i) => sample((i + 300) * 2));
    expect(() => collector.poll(now + 2001)).toThrow(/DRAIN_TIMEOUT/);
  });
  it("waits for true observer backlog settlement even with all measured rows", () => {
    const { collector, observer, now } = full();
    observer.pending = 1;
    observer.rows = Array.from({ length: 1800 }, (_, i) => sample((i + 300) * 2));
    expect(collector.poll(now + 1)).toBeUndefined();
    observer.pending = 0;
    expect(required(collector.poll(now + 2)).measurement).toHaveLength(1800);
  });
  it("rejects clock reversal, invalid sample duration and disposal reuse", () => {
    const observer = new Observer();
    const collector = new AnimalPerformanceCollector(0, observer);
    world(collector, 2, 0);
    collector.cpu(window(), 2);
    expect(() => collector.poll(1)).toThrow(/CLOCK/);
    const other = new AnimalPerformanceCollector(0, new Observer());
    other.dispose();
    expect(() => other.poll(1)).toThrow(/DISPOSED/);
  });
  it("computes nearest-rank p95 from all1800 rows with no trimming", () => {
    const values = Array.from({ length: 1800 }, (_, i) => i);
    expect(percentile95(values)).toBe(1709);
    expect(() => percentile95(values.slice(1))).toThrow(/SERIES_INCOMPLETE/);
  });
});
