import { describe, expect, it, vi } from "vitest";
import { ComputeTimingScopes } from "../src/compute-timing.js";
import { createRenderer } from "../src/renderer.js";

function fixture() {
  const pool = {
    maxQueries: 2048,
    currentQueryIndex: 0,
    isDisposed: false,
    trackTimestamp: true,
    queryOffsets: new Map<string, number>(),
    timestamps: new Map<string, number>(),
  };
  const device = {
    features: new Set(["timestamp-query"]),
    createQuerySet: vi.fn(),
    destroy: vi.fn(),
  };
  const backend = {
    isWebGPUBackend: true,
    device,
    trackTimestamp: true,
    timestampQueryPool: { compute: pool },
  };
  const canvas = new EventTarget() as HTMLCanvasElement;
  const raw = {
    backend,
    info: { frame: 0, compute: { timestamp: 99 } },
    domElement: canvas,
    init: async () => undefined,
    render: () => undefined,
    setSize: () => undefined,
    compute: vi.fn((_node: unknown) => {
      if (backend.trackTimestamp)
        pool.queryOffsets.set(`compute:17:f${raw.info.frame}`, pool.queryOffsets.size * 2);
      pool.currentQueryIndex += 2;
    }),
    resolveTimestampsAsync: async (type?: string) => {
      if (type === "compute") {
        for (const uid of pool.queryOffsets.keys()) {
          const frame = Number(uid.split(":f").at(-1));
          pool.timestamps.set(uid, (frame + 1) / 8);
        }
        pool.queryOffsets.clear();
        pool.currentQueryIndex = 0;
      }
      return 99;
    },
  };
  const options = {
    canvas,
    pipelineCensus: false as const,
    gpuTimestampFrameInterval: 8,
    source: {
      createCanvas: () => canvas,
      hasWebGPU: () => true,
      observeResize: () => () => undefined,
      readSize: () => [320, 180] as const,
    },
    webgpuFactory: () => raw,
  };
  return { raw, pool, device, options };
}

describe("opt-in exact compute timing receipts", () => {
  it("rejects the first timing request after disposal before invoking its operation", async () => {
    const f = fixture();
    const renderer = await createRenderer(f.options);
    renderer.dispose();
    const operation = vi.fn(() => renderer.compute({}));
    expect(() => renderer.computeTiming?.(operation)).toThrow(/TN_COMPUTE_TIMING_STALE/);
    expect(operation).not.toHaveBeenCalled();
    expect(f.raw.compute).not.toHaveBeenCalled();
  });

  it("retires unread receipts before renderer disposal without destroying the shared device", async () => {
    const f = fixture();
    const renderer = await createRenderer(f.options);
    const receipt = renderer.computeTiming?.(() => renderer.compute({}));
    expect(receipt).toBeDefined();
    renderer.dispose();
    await f.raw.resolveTimestampsAsync("compute");
    expect(() => receipt?.read()).toThrow(/TN_COMPUTE_TIMING_STALE/);
    expect(() => renderer.computeTiming?.(() => renderer.compute({}))).toThrow(
      /TN_COMPUTE_TIMING_STALE/,
    );
    expect(f.device.destroy).not.toHaveBeenCalled();
  });

  it("captures all four dispatches instead of repeating the last numeric timing, restoring the default sampler", async () => {
    const f = fixture();
    const renderer = await createRenderer(f.options);
    const original = f.raw.compute;
    const timing = renderer.computeTiming;
    expect(timing).toBeTypeOf("function");
    if (timing === undefined) throw new Error("Exact compute timing scope is absent.");
    const receipt = timing(() => {
      for (let i = 0; i < 4; i++) renderer.compute({});
    });
    expect(f.raw.compute).toBe(original);
    expect(receipt.read()).toBeUndefined();
    renderer.resolveGpuFrame();
    await Promise.resolve();
    const samples = receipt.read();
    expect(samples?.map((sample) => sample.call)).toEqual([0, 1, 2, 3]);
    expect(samples?.map((sample) => sample.gpuMs)).toEqual([0.125, 0.25, 0.375, 0.5]);
    expect(new Set(samples?.map((sample) => sample.uid)).size).toBe(4);
    expect(() => receipt.read()).toThrow(/TN_COMPUTE_TIMING_DUPLICATE/);
    renderer.compute({});
    expect(f.raw.backend.trackTimestamp).toBe(false);
    expect(f.device.createQuerySet).not.toHaveBeenCalled();
    expect(f.device.destroy).not.toHaveBeenCalled();
  });
});

describe("owned UID timing scope controls before renderer integration", () => {
  function captured(f: ReturnType<typeof fixture>, scopes: ComputeTimingScopes, count = 1) {
    return scopes.capture(() => {
      for (let i = 0; i < count; i++) {
        f.raw.backend.trackTimestamp = f.raw.info.frame % 8 === 0;
        f.raw.compute({});
        f.raw.info.frame += 1;
      }
    });
  }

  it("forces all four calls only in the opt-in scope and consumes exact complete membership", async () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    f.raw.backend.trackTimestamp = false;
    const original = f.raw.compute;
    const receipt = captured(f, scopes, 4);
    expect(f.raw.compute).toBe(original);
    expect(f.raw.backend.trackTimestamp).toBe(false);
    expect(receipt.calls).toEqual([0, 1, 2, 3]);
    expect(receipt.read()).toBeUndefined();
    await f.raw.resolveTimestampsAsync("compute");
    expect(receipt.read()?.map((sample) => sample.gpuMs)).toEqual([0.125, 0.25, 0.375, 0.5]);
    expect(() => receipt.read()).toThrow(/TN_COMPUTE_TIMING_DUPLICATE/);
    expect(f.device.createQuerySet).not.toHaveBeenCalled();
    expect(f.device.destroy).not.toHaveBeenCalled();
  });

  it("accepts the first lazily allocated Three-owned compute pool", async () => {
    const f = fixture();
    Object.assign(f.raw.backend.timestampQueryPool, { compute: null });
    f.raw.compute.mockImplementation(() => {
      f.raw.backend.timestampQueryPool.compute = f.pool;
      if (f.raw.backend.trackTimestamp)
        f.pool.queryOffsets.set(`compute:17:f${f.raw.info.frame}`, 0);
    });
    const scopes = new ComputeTimingScopes(() => f.raw);
    const receipt = captured(f, scopes);
    await f.raw.resolveTimestampsAsync("compute");
    expect(receipt.read()).toHaveLength(1);
  });

  it("rejects stale source, pool, device and retired generation before late completion", () => {
    for (const change of ["source", "pool", "device", "dispose"] as const) {
      const f = fixture();
      let raw = f.raw;
      const scopes = new ComputeTimingScopes(() => raw);
      const receipt = captured(f, scopes);
      if (change === "source") raw = { ...f.raw };
      if (change === "pool")
        f.raw.backend.timestampQueryPool.compute = {
          maxQueries: 2048,
          currentQueryIndex: 0,
          isDisposed: false,
          trackTimestamp: true,
          queryOffsets: new Map(),
          timestamps: new Map(),
        };
      if (change === "device") f.raw.backend.device = { ...f.device };
      if (change === "dispose") scopes.dispose();
      expect(() => receipt.read()).toThrow(/TN_COMPUTE_TIMING_STALE/);
      expect(f.device.destroy).not.toHaveBeenCalled();
    }
  });

  it("never uses cached resolve numbers or partial UID membership as a complete sample", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    const receipt = captured(f, scopes, 4);
    f.pool.timestamps.set("unrelated:f0", 99);
    f.pool.queryOffsets.clear(); // A failed real resolve clears the pending map too.
    expect(receipt.read()).toBeUndefined();
    for (const call of [0, 1, 2]) f.pool.timestamps.set(`compute:17:f${call}`, 0.125);
    expect(receipt.read()).toBeUndefined();
    f.pool.timestamps.set("compute:17:f3", 0.25);
    expect(receipt.read()).toHaveLength(4);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 0])(
    "rejects unusable observed duration %s",
    (duration) => {
      const f = fixture();
      const receipt = captured(f, new ComputeTimingScopes(() => f.raw));
      f.pool.timestamps.set("compute:17:f0", duration);
      expect(() => receipt.read()).toThrow(/TN_COMPUTE_TIMING_INVALID/);
    },
  );

  it.each(["missing", "wrong-frame", "duplicate", "bad-offset"])(
    "rejects %s query allocation and restores every mutation",
    (mode) => {
      const f = fixture();
      f.raw.backend.trackTimestamp = false;
      if (mode === "duplicate") f.pool.timestamps.set("compute:17:f0", 1);
      f.raw.compute.mockImplementation(() => {
        if (mode !== "missing")
          f.pool.queryOffsets.set(
            mode === "wrong-frame" ? "compute:17:f99" : "compute:17:f0",
            mode === "bad-offset" ? 1 : 0,
          );
      });
      const original = f.raw.compute;
      const scopes = new ComputeTimingScopes(() => f.raw);
      expect(() => captured(f, scopes)).toThrow(/TN_COMPUTE_TIMING_(MISSING|DUPLICATE)/);
      expect(f.raw.compute).toBe(original);
      expect(f.raw.backend.trackTimestamp).toBe(false);
    },
  );

  it("bounds calls before dispatching unrecorded work", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    const original = f.raw.compute;
    expect(() =>
      scopes.capture(
        () => {
          f.raw.compute({});
          f.raw.info.frame += 1;
          f.raw.compute({});
        },
        { maxCalls: 1 },
      ),
    ).toThrow(/TN_COMPUTE_TIMING_CAPACITY/);
    expect(original).toHaveBeenCalledOnce();
    expect(f.raw.compute).toBe(original);
    expect(() => scopes.capture(() => undefined, { maxCalls: 65 })).toThrow(
      /TN_COMPUTE_TIMING_CAPACITY/,
    );
  });

  it("rejects async, nested, empty and partially thrown scopes with exact descriptor restoration", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    const descriptor = Object.getOwnPropertyDescriptor(f.raw, "compute");
    expect(() => scopes.capture(() => Promise.resolve())).toThrow(/TN_COMPUTE_TIMING_ASYNC/);
    expect(() =>
      scopes.capture(() => {
        try {
          scopes.capture(() => undefined);
        } catch {
          /* Even caught nested failures invalidate the outer scope. */
        }
      }),
    ).toThrow(/TN_COMPUTE_TIMING_NESTED/);
    expect(() => scopes.capture(() => undefined)).toThrow(/TN_COMPUTE_TIMING_MISSING/);
    expect(() =>
      scopes.capture(() => {
        f.raw.compute({});
        throw new Error("submitted then failed");
      }),
    ).toThrow("submitted then failed");
    expect(Object.getOwnPropertyDescriptor(f.raw, "compute")).toEqual(descriptor);
    f.raw.info.frame += 1;
    expect(captured(f, scopes).calls).toEqual([1]);
  });

  it("fails closed before work on unavailable timestamp features or nonwritable compute methods", () => {
    const f = fixture();
    f.device.features.clear();
    const scopes = new ComputeTimingScopes(() => f.raw);
    expect(() => captured(f, scopes)).toThrow(/TN_COMPUTE_TIMING_UNSUPPORTED/);
    expect(f.raw.compute).not.toHaveBeenCalled();
    f.device.features.add("timestamp-query");
    Object.defineProperty(f.raw, "compute", { writable: false });
    expect(() => captured(f, scopes)).toThrow(/TN_COMPUTE_TIMING_UNSUPPORTED/);
    expect(f.raw.compute).not.toHaveBeenCalled();
  });

  it("does no source reads, wrapping or GPU allocation when unused", () => {
    const f = fixture();
    const read = vi.fn(() => f.raw);
    const scopes = new ComputeTimingScopes(read);
    const original = f.raw.compute;
    expect(read).not.toHaveBeenCalled();
    expect(f.raw.compute).toBe(original);
    expect(f.device.createQuerySet).not.toHaveBeenCalled();
    scopes.dispose();
    expect(f.device.destroy).not.toHaveBeenCalled();
  });
});

describe("timing receipt retirement regressions", () => {
  it("attempts tracking restoration and poisons a wrapper when compute restoration is impossible", () => {
    const f = fixture();
    f.raw.backend.trackTimestamp = false;
    const scopes = new ComputeTimingScopes(() => f.raw);
    const original = f.raw.compute;
    expect(() =>
      scopes.capture(() => {
        f.raw.compute({});
        f.raw.info.frame += 1;
        Object.defineProperty(f.raw, "compute", { configurable: false, writable: false });
      }),
    ).toThrow(/TN_COMPUTE_TIMING_RESTORE/);
    expect(f.raw.backend.trackTimestamp).toBe(false);
    expect(() => f.raw.compute({})).toThrow(/TN_COMPUTE_TIMING_STALE/);
    expect(original).toHaveBeenCalledOnce();
  });

  it("retires the generation even if restoring tracking itself throws", () => {
    const f = fixture();
    f.raw.backend.trackTimestamp = false;
    const scopes = new ComputeTimingScopes(() => f.raw);
    const original = f.raw.compute;
    expect(() =>
      scopes.capture(() => {
        f.raw.compute({});
        Object.defineProperty(f.raw.backend, "trackTimestamp", {
          configurable: true,
          get: () => true,
          set: () => {
            throw new Error("tracking restore failed");
          },
        });
      }),
    ).toThrow();
    expect(f.raw.compute).toBe(original);
    expect(() => scopes.capture(() => undefined)).toThrow(/TN_COMPUTE_TIMING_STALE/);
  });

  it("survives Three's animation loop rewriting info.frame lower between captures", async () => {
    // Three's always-running loop sets info.frame to its own rAF counter; core's sampler sets
    // each compute call's frame from the engine clock, which runs far ahead of it.
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    let engine = 100;
    const run = (count: number) =>
      scopes.capture(() => {
        for (let i = 0; i < count; i++) {
          f.raw.info.frame = engine++;
          f.raw.compute({});
        }
      });
    const first = run(2);
    f.raw.info.frame = 3;
    await f.raw.resolveTimestampsAsync("compute");
    expect(first.read()?.length).toBe(2);
    f.raw.info.frame = 4;
    expect(run(2).calls).toEqual([102, 103]);
  });

  it("still rejects a compute call that reuses an already timed frame", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    const run = (frames: number[]) =>
      scopes.capture(() => {
        for (const frame of frames) {
          f.raw.info.frame = frame;
          f.raw.compute({});
        }
      });
    run([100, 101]);
    expect(() => run([101])).toThrow(/TN_COMPUTE_TIMING_STALE: compute call frame was reused/);
  });

  it("rejects a swallowed undefined dispatch failure rather than returning a partial receipt", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    f.raw.compute.mockImplementationOnce(() => f.pool.queryOffsets.set("compute:17:f0", 0));
    f.raw.compute.mockImplementationOnce(() => {
      throw undefined;
    });
    let threw = false;
    try {
      scopes.capture(() => {
        f.raw.compute({});
        f.raw.info.frame += 1;
        try {
          f.raw.compute({});
        } catch {
          /* Failure must invalidate the scope even when caught. */
        }
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("timing pool reservation regressions", () => {
  it.each(["full", "disposed", "disabled"])("rejects %s pools before any dispatch", (mode) => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    if (mode === "full") f.pool.currentQueryIndex = f.pool.maxQueries;
    if (mode === "disposed") f.pool.isDisposed = true;
    if (mode === "disabled") f.pool.trackTimestamp = false;
    expect(() => scopes.capture(() => f.raw.compute({}))).toThrow(
      /TN_COMPUTE_TIMING_(CAPACITY|STALE|UNSUPPORTED)/,
    );
    expect(f.raw.compute).not.toHaveBeenCalled();
  });

  it("rejects cross-scope frame reuse while an earlier resolve is pending", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    scopes.capture(() => f.raw.compute({}));
    f.pool.queryOffsets.clear(); // Existing resolver has snapshotted scope A, not completed it.
    f.pool.currentQueryIndex = 0;
    expect(() => scopes.capture(() => f.raw.compute({}))).toThrow(/TN_COMPUTE_TIMING_STALE/);
    expect(f.raw.compute).toHaveBeenCalledOnce();
  });

  it.each(["timestamps", "queryOffsets"] as const)(
    "rejects replacement of %s within the same pool",
    (field) => {
      const f = fixture();
      const scopes = new ComputeTimingScopes(() => f.raw);
      const receipt = scopes.capture(() => f.raw.compute({}));
      f.pool[field] = new Map();
      expect(() => receipt.read()).toThrow(/TN_COMPUTE_TIMING_STALE/);
    },
  );
});

describe("retained timing wrapper regressions", () => {
  it("retires each successful scope wrapper before it can dispatch outside that scope", () => {
    const f = fixture();
    const scopes = new ComputeTimingScopes(() => f.raw);
    const original = f.raw.compute;
    let retained = original;
    scopes.capture(() => {
      retained = f.raw.compute as typeof original;
      f.raw.compute({});
      f.raw.info.frame += 1;
    });
    expect(() => retained({})).toThrow(/TN_COMPUTE_TIMING_STALE/);
    expect(original).toHaveBeenCalledOnce();
    const next = scopes.capture(() => {
      expect(() => retained({})).toThrow(/TN_COMPUTE_TIMING_STALE/);
      f.raw.compute({});
      f.raw.info.frame += 1;
    });
    expect(next.calls).toEqual([1]);
    expect(original).toHaveBeenCalledTimes(2);
  });
});

describe("timing invalid options regressions", () => {
  it.each([{ options: [] }, { options: { maxCalls: null } }])(
    "rejects invalid options $options before reading or dispatching",
    ({ options }) => {
      const f = fixture();
      const read = vi.fn(() => f.raw);
      const operation = vi.fn(() => f.raw.compute({}));
      const scopes = new ComputeTimingScopes(read);
      expect(() => scopes.capture(operation, options as never)).toThrow(
        /TN_COMPUTE_TIMING_CAPACITY/,
      );
      expect(read).not.toHaveBeenCalled();
      expect(operation).not.toHaveBeenCalled();
    },
  );
});
