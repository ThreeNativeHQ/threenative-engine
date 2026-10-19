import type { IComputeDriven } from "@threenative/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpringTimings } from "../src/physics/timing-arms.js";
const fake = vi.hoisted(() => ({
  generation: {},
  available: false,
  retired: false,
  reads: 0,
  bookends: [0, 3e6, 5e6, 8e6],
}));
vi.mock("../src/physics/gpu-timing.js", () => ({
  GpuTimingBatches: class {
    begin(tick: number) {
      return {
        bookend: () => undefined,
        abort: (error: unknown) => {
          throw error;
        },
        finish: () => ({
          generation: fake.generation,
          tick,
          read: () => {
            if (fake.retired) throw new Error("TN_AVBD_TIMING_STALE");
            if (!fake.available) return undefined;
            if (fake.reads++) throw new Error("TN_AVBD_TIMING_DUPLICATE");
            return fake.bookends;
          },
        }),
      };
    }
    settle() {
      return Promise.resolve();
    }
    retire() {
      fake.retired = true;
      return Promise.resolve();
    }
  },
}));
function fixture() {
  const controls: { available: boolean; reads: number }[] = [];
  let call = 0;
  const renderer = {
    computeTiming: vi.fn((operation: () => void) => {
      operation();
      const first = call;
      call += 2;
      const control = { available: false, reads: 0 };
      controls.push(control);
      return {
        generation: {},
        calls: [first, first + 1],
        read: () => {
          if (!control.available) return undefined;
          if (control.reads++) throw new Error("TN_COMPUTE_TIMING_DUPLICATE");
          return [0, 1].map((i) => ({ call: first + i, uid: `q:f${first + i}`, gpuMs: 1 }));
        },
      };
    }),
  };
  const timings = new SpringTimings(
    renderer as unknown as Parameters<IComputeDriven["process"]>[0],
    {} as GPUDevice,
    "test",
  );
  const complete = () => {
    fake.available = true;
    for (const control of controls) control.available = true;
  };
  const tick = () => {
    timings.process("sail", () => undefined);
    timings.process("flag", () => undefined);
  };
  return { timings, controls, complete, tick };
}
beforeEach(() => {
  fake.generation = {};
  fake.available = false;
  fake.retired = false;
  fake.reads = 0;
  fake.bookends = [0, 3e6, 5e6, 8e6];
});
describe("spring timing arm membership and lifetime", () => {
  it("keeps partial receipt progress without reconsuming a completed component", () => {
    const f = fixture();
    f.tick();
    fake.available = true;
    const first = f.controls[0];
    if (first === undefined) throw new Error("missing sail receipt");
    first.available = true;
    expect(f.timings.rows[0]?.read()).toBeUndefined();
    expect(f.timings.rows[0]?.read()).toBeUndefined();
    f.complete();
    const row = f.timings.rows[0]?.read();
    expect(row?.phaseMs).toEqual([1, 1, 1, 1]);
    expect(row?.gpuUpperMs).toBe(8);
    expect(row?.gpuLowerMs).toBe(1);
    expect(fake.reads).toBe(1);
    expect(first.reads).toBe(1);
  });
  it("keeps the upper bound at the pass sum when marker timestamps do not bracket the passes", () => {
    // Mesa writes an empty marker pass's timestamp before earlier work finishes (Iris Xe, 2026-10-07).
    fake.bookends = [0, 0.05e6, 0.1e6, 0.15e6];
    const f = fixture();
    f.tick();
    f.complete();
    const row = f.timings.rows[0]?.read();
    expect(row?.gpuLowerMs).toBe(1);
    expect(row?.gpuUpperMs).toBe(4);
  });

  it("rejects a second completed read rather than replaying a cached sample", () => {
    const f = fixture();
    f.tick();
    f.complete();
    expect(f.timings.rows[0]?.read()).toBeDefined();
    expect(() => f.timings.rows[0]?.read()).toThrow(/TN_RIGGING_TIMING_DUPLICATE/);
  });
  it("rejects fully cached data after the arm retires", async () => {
    const f = fixture();
    f.tick();
    f.complete();
    expect(f.timings.rows[0]?.read()).toBeDefined();
    await f.timings.retire();
    expect(() => f.timings.rows[0]?.read()).toThrow(/TN_RIGGING_TIMING_STALE/);
  });
  it.each(["flag-first", "duplicate-sail", "missing-flag", "undefined-operation"])(
    "cannot repair a caught %s failure into accepted later dispatches",
    (mode) => {
      const f = fixture();
      let rejected = false;
      try {
        if (mode === "flag-first") f.timings.process("flag", () => undefined);
        if (mode === "duplicate-sail") {
          f.timings.process("sail", () => undefined);
          f.timings.process("sail", () => undefined);
        }
        if (mode === "missing-flag") {
          f.timings.process("sail", () => undefined);
          f.timings.settle();
        }
        if (mode === "undefined-operation")
          f.timings.process("sail", () => {
            throw undefined;
          });
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      for (const operation of [
        () => f.timings.process(mode === "flag-first" ? "sail" : "flag", () => undefined),
        () => f.timings.settle(),
      ]) {
        let failed = false;
        try {
          operation();
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
      }
      expect(f.timings.rows).toHaveLength(0);
    },
  );
});
