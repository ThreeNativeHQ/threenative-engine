import { describe, expect, it, vi } from "vitest";
import { GpuTimingBatches } from "../src/physics/gpu-timing.js";

function fixture() {
  let clock = 1000n;
  const fault = { method: "" };
  const fail = (method: string) => {
    if (fault.method === method) throw new Error("injected GPU failure");
  };
  const lands: (() => void)[] = [];
  const reads: { data: ArrayBuffer; mapState: string; unmap: ReturnType<typeof vi.fn> }[] = [];
  const events: string[] = [];
  const resolves: { count: number; offset: number }[] = [];
  const device = {
    features: new Set(["timestamp-query"]),
    createQuerySet: vi.fn((d: { count: number }) => ({ values: new BigUint64Array(d.count) })),
    createBuffer: vi.fn((d: { size: number; usage: number }) => {
      const buffer = {
        data: new ArrayBuffer(d.size),
        size: d.size,
        mapState: "unmapped",
        unmap: vi.fn(() => {
          buffer.mapState = "unmapped";
        }),
        mapAsync: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              lands.push(() => {
                buffer.mapState = "mapped";
                resolve();
              });
            }),
        ),
        getMappedRange: () => buffer.data,
      };
      if (d.usage === 9) reads.push(buffer);
      return buffer;
    }),
    createCommandEncoder: vi.fn(() => ({
      beginComputePass: (d: {
        timestampWrites?: {
          querySet: { values: BigUint64Array };
          beginningOfPassWriteIndex?: number;
          endOfPassWriteIndex?: number;
        };
      }) => {
        fail("begin");
        const w = d.timestampWrites;
        if (w?.beginningOfPassWriteIndex !== undefined)
          w.querySet.values[w.beginningOfPassWriteIndex] = clock++;
        events.push("begin");
        return {
          end: () => {
            fail("end");
            if (w?.endOfPassWriteIndex !== undefined)
              w.querySet.values[w.endOfPassWriteIndex] = clock++;
            events.push("end");
          },
        };
      },
      resolveQuerySet: (
        q: { values: BigUint64Array },
        _start: number,
        count: number,
        b: { data: ArrayBuffer },
        offset: number,
      ) => {
        fail("resolve");
        resolves.push({ count, offset });
        new BigUint64Array(b.data).set(q.values.subarray(0, count));
      },
      copyBufferToBuffer: (
        a: { data: ArrayBuffer },
        _start: number,
        b: { data: ArrayBuffer },
        _offset: number,
        count: number,
      ) => {
        fail("copy");
        new Uint8Array(b.data).set(new Uint8Array(a.data, 0, count));
      },
      finish: () => {
        fail("finish");
        return {};
      },
    })),
    queue: {
      submit: vi.fn(() => {
        fail("submit");
        events.push("submit");
      }),
    },
    destroy: vi.fn(),
  };
  return {
    device: device as unknown as GPUDevice,
    raw: device,
    lands,
    reads,
    events,
    resolves,
    fault,
  };
}
function capture(f: ReturnType<typeof fixture>, batches: GpuTimingBatches, tick: number) {
  const scope = batches.begin(tick);
  scope.bookend(0);
  f.events.push("uploads");
  const encoder = f.device.createCommandEncoder();
  scope.stamp(encoder, 1);
  f.events.push("three clears");
  for (let phase = 0; phase < 4; phase++) {
    const pass = encoder.beginComputePass({
      timestampWrites: scope.writes(2 + phase * 2, 3 + phase * 2),
    });
    pass.end();
  }
  f.device.queue.submit([encoder.finish()]);
  scope.bookend(10);
  return { scope, receipt: scope.finish() };
}
async function land(f: ReturnType<typeof fixture>) {
  for (const resolve of f.lands.splice(0)) resolve();
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("bounded borrowed-device timing batches", () => {
  it("keeps every tick distinct, covers clears and uploads, and resolves only the written aligned prefix", async () => {
    const f = fixture();
    const batches = new GpuTimingBatches(f.device, 11);
    const receipts = Array.from({ length: 6 }, (_, i) => capture(f, batches, i).receipt);
    expect(f.raw.createQuerySet.mock.calls.map(([d]) => d.count)).toEqual([55, 55, 55, 55]);
    expect(receipts[0]?.read()).toBeUndefined();
    const settled = batches.settle();
    expect(f.resolves).toEqual([
      { count: 55, offset: 0 },
      { count: 11, offset: 0 },
    ]);
    await land(f);
    await settled;
    expect(receipts.map((r) => r.tick)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(receipts.every((r) => r.read()?.length === 11)).toBe(true);
    expect(f.events.slice(0, 6)).toEqual(["begin", "end", "submit", "uploads", "begin", "end"]);
    expect(f.events[6]).toBe("three clears");
    expect(f.reads.slice(0, 2).every((r) => r.unmap.mock.calls.length === 1)).toBe(true);
    expect(f.raw.destroy).not.toHaveBeenCalled();
  });

  it("fails instead of dropping or stalling when all twenty in-flight tick slots are busy", async () => {
    const f = fixture();
    const batches = new GpuTimingBatches(f.device, 11);
    for (let i = 0; i < 20; i++) capture(f, batches, i);
    const submissions = f.raw.queue.submit.mock.calls.length;
    expect(() => batches.begin(20)).toThrow(/TN_AVBD_TIMING_CAPACITY/);
    expect(f.raw.queue.submit).toHaveBeenCalledTimes(submissions);
    await land(f);
    expect(() => batches.begin(21)).toThrow(/TN_AVBD_TIMING_CAPACITY/);
  });

  it("rejects missing, duplicate, nonmonotonic or unsafe membership by name", () => {
    for (const mode of ["missing", "duplicate", "tick"] as const) {
      const f = fixture();
      const batches = new GpuTimingBatches(f.device, 11);
      const scope = batches.begin(0);
      scope.bookend(0);
      if (mode === "missing") expect(() => scope.finish()).toThrow(/TN_AVBD_TIMING_MISSING/);
      if (mode === "duplicate") expect(() => scope.bookend(0)).toThrow(/TN_AVBD_TIMING_MEMBERSHIP/);
      if (mode === "tick") expect(() => batches.begin(0)).toThrow(/TN_AVBD_TIMING_MEMBERSHIP/);
    }
  });

  it("rejects a retained tick wrapper and retirement prevents late receipt publication", async () => {
    const f = fixture();
    const batches = new GpuTimingBatches(f.device, 11);
    const { scope, receipt } = capture(f, batches, 0);
    expect(() => scope.bookend(0)).toThrow(/TN_AVBD_TIMING_STALE/);
    const settled = batches.settle();
    const retired = batches.retire();
    await land(f);
    await expect(settled).rejects.toThrow(/TN_AVBD_TIMING_STALE/);
    await retired;
    expect(() => receipt.read()).toThrow(/TN_AVBD_TIMING_STALE/);
    expect(f.reads[0]?.unmap).toHaveBeenCalledOnce();
    expect(f.raw.destroy).not.toHaveBeenCalled();
  });

  it.each(["backwards", "zero", "unsafe"] as const)(
    "fails closed on %s mapped timestamps and still unmaps",
    async (mode) => {
      const f = fixture();
      const batches = new GpuTimingBatches(f.device, 11);
      capture(f, batches, 0);
      const settled = batches.settle();
      const read = f.reads[0];
      if (read === undefined) throw new Error("No timing read allocated");
      const values = new BigUint64Array(read.data);
      if (mode === "backwards") values[5] = 1n;
      if (mode === "zero") values.fill(1000n);
      if (mode === "unsafe") values[10] = 2n ** 54n;
      const rejection = expect(settled).rejects.toThrow(/TN_AVBD_TIMING_INVALID/);
      await land(f);
      await rejection;
      expect(read.unmap).toHaveBeenCalledOnce();
    },
  );

  it("rejects missing timestamps and bad capacities before any allocation", () => {
    const f = fixture();
    f.raw.features.clear();
    expect(() => new GpuTimingBatches(f.device, 11)).toThrow(/TN_AVBD_TIMING_UNSUPPORTED/);
    f.raw.features.add("timestamp-query");
    for (const stamps of [0, 1, 17, Number.NaN])
      expect(() => new GpuTimingBatches(f.device, stamps)).toThrow(/TN_AVBD_TIMING_CAPACITY/);
    expect(f.raw.createBuffer).not.toHaveBeenCalled();
    expect(f.raw.createQuerySet).not.toHaveBeenCalled();
  });
});

describe("timing GPU failure retirement regressions", () => {
  it.each(["begin", "end", "resolve", "copy", "finish", "submit"])(
    "poisons the generation after %s throws, including batch reuse",
    async (method) => {
      const f = fixture();
      const batches = new GpuTimingBatches(f.device, 11);
      const old = Array.from({ length: 5 }, (_, i) => capture(f, batches, i).receipt);
      await land(f);
      expect(old[0]?.read()).toHaveLength(11);
      f.fault.method = method;
      expect(() => {
        for (let i = 5; i < 10; i++) capture(f, batches, i);
      }).toThrow(/injected GPU failure/);
      f.fault.method = "";
      expect(() => old[0]?.read()).toThrow(/injected GPU failure/);
      await expect(batches.settle()).rejects.toThrow(/injected GPU failure/);
      await batches.retire();
    },
  );
});

describe("timing batch completion regressions", () => {
  it("seals admission synchronously when the final window starts settling", async () => {
    const f = fixture();
    const batches = new GpuTimingBatches(f.device, 11);
    capture(f, batches, 0);
    const settled = batches.settle();
    expect(() => batches.begin(1)).toThrow(/TN_AVBD_TIMING_SEALED/);
    await land(f);
    await settled;
  });
  it("does not publish any partial batch before a later invalid row retires it", async () => {
    const f = fixture();
    const batches = new GpuTimingBatches(f.device, 11);
    const receipts = Array.from({ length: 5 }, (_, i) => capture(f, batches, i).receipt);
    const read = f.reads[0];
    if (read === undefined) throw new Error("No batch read allocated");
    new BigUint64Array(read.data)[54] = 1n;
    f.lands.shift()?.();
    await Promise.resolve(); // Land runs before its rejection callback can latch a failure.
    expect(() => receipts[0]?.read()).toThrow(/TN_AVBD_TIMING_INVALID/);
    await land(f);
    await batches.retire();
  });
  it("allows a complete receipt to be consumed only once", async () => {
    const f = fixture();
    const batches = new GpuTimingBatches(f.device, 11);
    const receipt = capture(f, batches, 0).receipt;
    const settled = batches.settle();
    await land(f);
    await settled;
    expect(receipt.read()).toHaveLength(11);
    expect(() => receipt.read()).toThrow(/TN_AVBD_TIMING_DUPLICATE/);
  });
  it("rejects malformed device facts by name before any allocation", () => {
    for (const raw of [
      null,
      {},
      { features: { has: 1 } },
      { features: new Set(["timestamp-query"]), createQuerySet: vi.fn() },
    ]) {
      expect(() => new GpuTimingBatches(raw as never, 11)).toThrow(/TN_AVBD_TIMING_UNSUPPORTED/);
      if (raw !== null && "createQuerySet" in raw)
        expect(raw.createQuerySet).not.toHaveBeenCalled();
    }
  });
});
