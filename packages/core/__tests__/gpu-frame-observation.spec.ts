import { PerspectiveCamera, Scene } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { type IRendererLike, createRenderer } from "../src/renderer.js";
const { default: Pool } = await import(
  new URL(
    "../node_modules/three/src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js",
    import.meta.url,
  ).href
);

function observe(
  renderer: IRendererLike,
  options: Parameters<NonNullable<IRendererLike["observeGpuFrames"]>>[0],
) {
  const open = renderer.observeGpuFrames;
  if (open === undefined) throw new Error("TN_TEST_GPU_OBSERVER_UNAVAILABLE");
  return open.call(renderer, options);
}

/** Actual pinned Three pool; only the GPU transport is substituted on CPU. */
function transport(maxQueries = 32) {
  vi.stubGlobal("GPUBufferUsage", { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
  let resolveMap: (() => void) | undefined;
  let rejectMap: ((error: Error) => void) | undefined;
  const times = new BigUint64Array(maxQueries);
  const result = {
    mapState: "unmapped",
    mapAsync: () => {
      result.mapState = "pending";
      return new Promise<void>((resolve, reject) => {
        resolveMap = resolve;
        rejectMap = reject;
      });
    },
    getMappedRange: (_offset: number, bytes: number) => times.buffer.slice(0, bytes),
    unmap: () => {
      result.mapState = "unmapped";
    },
    destroy: () => undefined,
  };
  const device = {
    createQuerySet: () => ({ destroy: () => undefined }),
    createBuffer: ({ label }: { label: string }) =>
      label.includes("result") ? result : { destroy: () => undefined },
    createCommandEncoder: () => ({
      resolveQuerySet: () => undefined,
      copyBufferToBuffer: () => undefined,
      finish: () => ({}),
    }),
    queue: { submit: vi.fn() },
  };
  const pool = new Pool(device, "render", maxQueries);
  return {
    pool,
    result,
    device,
    async release(durations: number[]) {
      if (!resolveMap) throw new Error("No actual pool readback submitted");
      for (let i = 0; i < durations.length; i++) {
        times[i * 2] = BigInt(i * 10_000_000);
        times[i * 2 + 1] = (times[i * 2] ?? 0n) + BigInt(Math.round((durations[i] ?? 0) * 1e6));
      }
      const resolve = resolveMap;
      resolveMap = undefined;
      result.mapState = "mapped";
      resolve();
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
    async reject() {
      if (!rejectMap) throw new Error("No readback");
      rejectMap(new Error("actual transport failed"));
      for (let i = 0; i < 8; i++) await Promise.resolve();
    },
  };
}
afterEach(() => vi.unstubAllGlobals());

it("retains every real render frame from one delayed Three resolve batch", async () => {
  vi.stubGlobal("navigator", { gpu: {} });
  const t = transport();
  const canvas = new EventTarget();
  Object.defineProperties(canvas, {
    clientWidth: { value: 1280 },
    clientHeight: { value: 720 },
    parentElement: { value: null },
  });
  const info = { frame: 0, render: { timestamp: 0 } };
  const raw = {
    domElement: canvas,
    info,
    backend: {
      trackTimestamp: true,
      timestampQueryPool: { render: t.pool },
      getTimestampFrames: () => t.pool.frames,
    },
    init: async () => undefined,
    setSize: () => undefined,
    render: () => {
      t.pool.allocateQueriesForContext(`r:0:main:f${info.frame}`);
      t.pool.allocateQueriesForContext(`r:1:shadow:f${info.frame}`);
    },
    resolveTimestampsAsync: async (type = "render") => {
      if (type !== "render") return;
      info.render.timestamp = await t.pool.resolveQueriesAsync();
      return info.render.timestamp;
    },
  };
  const renderer = await createRenderer({
    canvas: canvas as HTMLCanvasElement,
    webgpuFactory: () => raw,
    gpuTimestampFrameInterval: 1,
  });
  const observe = Reflect.get(renderer, "observeGpuFrames");
  const receipt =
    typeof observe === "function"
      ? observe.call(renderer, { maxFrames: 8, maxQueries: 32 })
      : undefined;
  try {
    for (let i = 0; i < 3; i++) renderer.render(new Scene(), new PerspectiveCamera());
    renderer.resolveGpuFrame();
    expect(t.pool.currentQueryIndex).toBe(0);
    await t.release([1, 0.5, 2, 0.5, 3, 0.5]);
    expect(t.pool.frames).toEqual([0, 1, 2]);
    // The existing facade returns only2; the finite observer must retain0,1,2 once.
    const samples = (receipt?.take() ?? [renderer.gpuFrameSample?.()]) as {
      frame: number;
      ms: number;
    }[];
    expect(samples.map((s) => s.frame)).toEqual([0, 1, 2]);
    expect(samples.map((s) => s.ms)).toEqual([1.5, 2.5, 3.5]);
    expect(receipt?.take()).toEqual([]);
  } finally {
    receipt?.dispose();
    renderer.dispose();
  }
});

import { GpuFrameObservation } from "../src/gpu-frame-observation.js";
function observed(options = { maxFrames: 8, maxQueries: 32 }, maxQueries = 32, firstFrame = 0) {
  const t = transport(maxQueries);
  let current = 0;
  let pool = t.pool;
  const observation = new GpuFrameObservation(
    1,
    firstFrame,
    () => pool,
    () => current,
    options,
  );
  return {
    ...t,
    observation,
    frame(n: number) {
      current = n;
    },
    replace(p: typeof pool) {
      pool = p;
    },
    allocate(n: number, passes = 2) {
      current = n;
      for (let p = 0; p < passes; p++) t.pool.allocateQueriesForContext(`r:${p}:main:f${n}`);
    },
    resolve() {
      const batch = observation.capture();
      void t.pool.resolveQueriesAsync().catch(() => undefined);
      observation.submitted(batch);
      return batch;
    },
  };
}
it("attributes new offsets behind an older pending promise to the next actual batch", async () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  const old = t.pool.pendingResolve;
  t.allocate(1);
  expect(t.resolve()).toBeUndefined();
  expect(t.pool.pendingResolve).toBe(old);
  t.allocate(2);
  expect(t.resolve()).toBeUndefined();
  expect(t.observation.take()).toEqual([]);
  await t.release([1, 2]);
  expect(t.observation.take().map((s) => s.frame)).toEqual([0]);
  expect(t.pool.currentQueryIndex).toBe(8);
  t.resolve();
  await t.release([3, 4, 5, 6]);
  const samples = t.observation.take();
  expect(samples.map((s) => [s.frame, s.ms, s.batch])).toEqual([
    [1, 7, 2],
    [2, 11, 2],
  ]);
  expect(samples.flatMap((s) => s.queries.map((q) => q.begin))).toEqual([0, 2, 4, 6]);
  expect(t.observation.status()).toMatchObject({
    expectedFrames: 3,
    resolvedFrames: 3,
    deliveredFrames: 3,
    expectedQueries: 12,
    resolvedQueries: 12,
    deliveredQueries: 12,
    pendingFrames: 0,
    droppedFrames: 0,
  });
});
it("keeps queued eligible frames behind the stop fence and excludes later drains", async () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  t.allocate(1);
  t.observation.stop();
  t.allocate(2);
  await t.release([1, 1]);
  t.resolve();
  await t.release([2, 2, 3, 3]);
  expect(t.observation.take().map((s) => [s.frame, s.ms])).toEqual([
    [0, 2],
    [1, 4],
  ]);
  expect(t.observation.status()).toMatchObject({
    state: "stopped",
    stopFrame: 1,
    expectedFrames: 2,
    resolvedFrames: 2,
    pendingFrames: 0,
  });
});
it("ignores pre-activation frame membership and accepts actual complete zero-duration queries", async () => {
  const t = observed(undefined, 32, 2);
  t.allocate(0);
  t.allocate(1);
  t.allocate(2);
  t.resolve();
  await t.release([1, 1, 2, 2, 0, 0]);
  const rows = t.observation.take();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ frame: 2, ms: 0 });
  expect(rows[0]?.queries).toHaveLength(2);
});
it("fails a fulfilled stale lastValue when the real pool cannot drain", async () => {
  const t = observed();
  t.pool.lastValue = 999;
  t.result.mapState = "mapped";
  t.allocate(0);
  t.resolve();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(t.observation.take.bind(t.observation)).toThrow("NOT_SUBMITTED");
  expect(t.pool.frames).toEqual([]);
  expect(t.observation.status()).toMatchObject({
    resolvedFrames: 0,
    droppedFrames: 1,
    droppedQueries: 4,
  });
});
it("rejects an actual readback failure fulfilled with old lastValue", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const t = observed();
    t.pool.lastValue = 7;
    t.allocate(0);
    t.resolve();
    await t.reject();
    expect(() => t.observation.take()).toThrow("STALE_RESOLUTION");
    expect(t.observation.status().resolvedFrames).toBe(0);
  } finally {
    log.mockRestore();
  }
});
it("rejects partial real timestamp writes before fresh frame publication", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const t = observed();
    t.allocate(0);
    let writes = 0;
    const set = t.pool.timestamps.set.bind(t.pool.timestamps);
    t.pool.timestamps.set = (uid: string, ms: number) => {
      if (++writes === 2) throw new Error("second real write failed");
      return set(uid, ms);
    };
    t.resolve();
    await t.release([1, 2]);
    expect(t.pool.timestamps.size).toBe(1);
    expect(t.pool.frames).toEqual([]);
    expect(() => t.observation.take()).toThrow("STALE_RESOLUTION");
    t.pool.timestamps.set = set;
    t.pool.timestamps.set("r:1:main:f0", 2);
    expect(() => t.observation.take()).toThrow("STALE_RESOLUTION");
  } finally {
    log.mockRestore();
  }
});
it("rejects negative actual query duration without publishing another frame from the batch", async () => {
  const t = observed();
  t.allocate(0);
  t.allocate(1);
  t.resolve();
  await t.release([1, 1, 1, -0.5]);
  expect(t.pool.frames).toEqual([0, 1]);
  expect(() => t.observation.take()).toThrow("INCOMPLETE_RESOLUTION");
  expect(t.observation.status()).toMatchObject({
    resolvedFrames: 0,
    droppedFrames: 2,
    droppedQueries: 8,
  });
});
it("rejects a saturated real pool with unknown allocation loss", () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const t = observed(undefined, 4);
    t.allocate(0, 3);
    expect(t.pool.currentQueryIndex).toBe(4);
    expect(t.observation.capture()).toBeUndefined();
    expect(() => t.observation.take()).toThrow("SATURATED_POOL");
    expect(t.observation.status().allocationLoss).toBe("unknown-after-saturation");
  } finally {
    warn.mockRestore();
  }
});
it("detects overwritten actual UID allocation by slot conservation", () => {
  const t = observed();
  t.allocate(0, 1);
  t.allocate(0, 1);
  expect(t.pool.queryOffsets.size).toBe(1);
  expect(t.pool.currentQueryIndex).toBe(4);
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("PAIR_CONSERVATION");
});
it.each([
  ["compute", "c:0:main:f0", 0],
  ["unsafe frame", "r:0:main:f9007199254740992", 0],
  ["odd offset", "r:0:main:f0", 1],
  ["out of range", "r:0:main:f0", 2],
])("rejects malformed %s membership", (_name, uid, offset) => {
  const t = observed();
  t.allocate(0, 1);
  t.pool.queryOffsets.clear();
  t.pool.queryOffsets.set(uid, offset);
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("MEMBERSHIP");
});
it("rejects already-resolved UID reuse before submitting", () => {
  const t = observed();
  t.allocate(0, 1);
  t.pool.timestamps.set("r:0:main:f0", 1);
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("REUSED_QUERY");
});
it("fails closed on queue overflow with sticky truthful discarded counts", async () => {
  const t = observed({ maxFrames: 1, maxQueries: 4 });
  t.allocate(0);
  t.resolve();
  await t.release([1, 1]);
  t.allocate(1);
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("OVERFLOW");
  expect(t.observation.status()).toMatchObject({
    expectedFrames: 2,
    resolvedFrames: 1,
    deliveredFrames: 0,
    droppedFrames: 2,
    droppedQueries: 8,
    pendingFrames: 0,
    queuedFrames: 0,
  });
  t.observation.stop();
  expect(() => t.observation.take()).toThrow("OVERFLOW");
});
it("allows cumulative delivery to exceed bounded retained capacity without repeating samples", async () => {
  const t = observed({ maxFrames: 1, maxQueries: 4 });
  for (let f = 0; f < 5; f++) {
    t.allocate(f);
    t.resolve();
    await t.release([1, 0.5]);
    expect(t.observation.take().map((s) => s.frame)).toEqual([f]);
    expect(t.observation.take()).toEqual([]);
  }
  expect(t.observation.status()).toMatchObject({
    expectedFrames: 5,
    deliveredFrames: 5,
    deliveredQueries: 20,
    droppedFrames: 0,
  });
});
it("invalidates late old completions on disposal and isolates a fresh generation", async () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  t.observation.dispose();
  const next = new GpuFrameObservation(
    2,
    1,
    () => t.pool,
    () => 1,
    { maxFrames: 4, maxQueries: 16 },
  );
  t.allocate(1);
  expect(next.capture()).toBeUndefined();
  await t.release([1, 1]);
  expect(() => t.observation.take()).toThrow("DISPOSED");
  expect(t.observation.status()).toMatchObject({
    pendingFrames: 0,
    droppedFrames: 1,
    ignoredCompletions: 1,
  });
  expect(next.take()).toEqual([]);
  const batch = next.capture();
  void t.pool.resolveQueriesAsync();
  next.submitted(batch);
  await t.release([2, 2]);
  expect(next.take().map((s) => [s.generation, s.frame, s.ms])).toEqual([[2, 1, 4]]);
});
it("rejects pool replacement even if an old batch finishes with valid timestamps", async () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  t.replace(transport().pool);
  await t.release([1, 1]);
  expect(() => t.observation.take()).toThrow("POOL_RESET");
  expect(t.observation.status().resolvedFrames).toBe(0);
});
it("leaves missing selected frames pending and freezes them on deadline disposal", () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  t.observation.stop();
  expect(t.observation.status()).toMatchObject({
    state: "stopped",
    pendingFrames: 1,
    pendingQueries: 4,
    resolvedFrames: 0,
  });
  t.observation.dispose();
  expect(t.observation.status()).toMatchObject({
    state: "disposed",
    resolvedFrames: 0,
    droppedFrames: 1,
    droppedQueries: 4,
  });
});
it.each([
  { maxFrames: 0, maxQueries: 4 },
  { maxFrames: 1.5, maxQueries: 4 },
  { maxFrames: 16385, maxQueries: 4 },
  { maxFrames: 1, maxQueries: 3 },
  { maxFrames: 1, maxQueries: 131074 },
])("rejects invalid bounded capacities %j", (options) => {
  expect(() => observed(options)).toThrow("LIMITS");
});

it("rejects an offset map that still has members with zero allocated slots", () => {
  const t = observed();
  t.pool.queryOffsets.set("r:0:main:f0", 0);
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("PAIR_CONSERVATION");
});
it("rejects fresh frame publication with a missing actual timestamp member", async () => {
  const t = observed();
  t.allocate(0);
  const set = t.pool.timestamps.set.bind(t.pool.timestamps);
  t.pool.timestamps.set = (uid: string, ms: number) =>
    uid.startsWith("r:1:") ? t.pool.timestamps : set(uid, ms);
  t.resolve();
  await t.release([1, 2]);
  expect(t.pool.frames).toEqual([0]);
  expect(t.pool.timestamps.size).toBe(1);
  expect(() => t.observation.take()).toThrow("INCOMPLETE_RESOLUTION");
});
it("bounds retained timestamp slots independently of retained frame count", () => {
  const t = observed({ maxFrames: 8, maxQueries: 2 });
  t.allocate(0);
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("OVERFLOW");
  expect(t.observation.status()).toMatchObject({
    expectedFrames: 1,
    expectedQueries: 4,
    droppedFrames: 1,
    droppedQueries: 4,
    resolvedFrames: 0,
  });
});
it("copies immutable query values before later producer-map changes", async () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  await t.release([1, 2]);
  const rows = t.observation.take();
  t.pool.timestamps.set("r:0:main:f0", 99);
  expect(rows[0]?.ms).toBe(3);
  expect(rows[0]?.queries[0]?.ms).toBe(1);
  expect(Object.isFrozen(rows)).toBe(true);
  expect(Object.isFrozen(rows[0])).toBe(true);
  expect(Object.isFrozen(rows[0]?.queries)).toBe(true);
  expect(Object.isFrozen(rows[0]?.queries[0])).toBe(true);
});
it("invalidates unsupported and disposed real pools instead of returning empty success", () => {
  const t = observed();
  t.pool.isDisposed = true;
  expect(t.observation.capture()).toBeUndefined();
  expect(() => t.observation.take()).toThrow("UNSUPPORTED_POOL");
  const invalid = new GpuFrameObservation(
    1,
    0,
    () => ({}),
    () => 0,
    { maxFrames: 1, maxQueries: 2 },
  );
  expect(invalid.capture()).toBeUndefined();
  expect(() => invalid.take()).toThrow("UNSUPPORTED_POOL");
});
async function wrapped(interval = 1) {
  vi.stubGlobal("navigator", { gpu: {} });
  const t = transport();
  const canvas = new EventTarget();
  Object.defineProperties(canvas, {
    clientWidth: { value: 1280 },
    clientHeight: { value: 720 },
    parentElement: { value: null },
  });
  const info = { frame: 0, render: { timestamp: 0 } };
  let touches = 0;
  const backend = {
    trackTimestamp: true,
    get timestampQueryPool() {
      touches++;
      return { render: t.pool };
    },
    getTimestampFrames: () => t.pool.frames,
  };
  const resolves: string[] = [];
  const raw = {
    domElement: canvas,
    info,
    backend,
    init: async () => undefined,
    setSize: () => undefined,
    dispose: vi.fn(),
    render: () => {
      if (backend.trackTimestamp) t.pool.allocateQueriesForContext(`r:0:main:f${info.frame}`);
    },
    resolveTimestampsAsync: async (type = "render") => {
      resolves.push(type);
      if (type !== "render" || !backend.trackTimestamp) return;
      info.render.timestamp = await t.pool.resolveQueriesAsync();
      return info.render.timestamp;
    },
  };
  const renderer = await createRenderer({
    canvas: canvas as HTMLCanvasElement,
    webgpuFactory: () => raw,
    gpuTimestampFrameInterval: interval,
  });
  return {
    ...t,
    renderer,
    raw,
    resolves,
    touches: () => touches,
    draw: () => renderer.render(new Scene(), new PerspectiveCamera()),
  };
}
it("keeps ordinary resolution enabled and never reads observer pool state when disabled", async () => {
  const t = await wrapped();
  try {
    t.draw();
    t.renderer.resolveGpuFrame();
    await t.release([2]);
    expect(t.renderer.gpuFrameSample?.()).toEqual({ frame: 0, ms: 2 });
    expect(t.resolves).toEqual(["render", "compute"]);
    expect(t.touches()).toBe(0);
  } finally {
    t.renderer.dispose();
  }
});
it("enforces one observer, resets generation after explicit disposal and invalidates on renderer disposal", async () => {
  const t = await wrapped();
  const first = observe(t.renderer, { maxFrames: 4, maxQueries: 16 });
  expect(() => observe(t.renderer, { maxFrames: 4, maxQueries: 16 })).toThrow("ALREADY_ACTIVE");
  t.draw();
  t.renderer.resolveGpuFrame();
  first.dispose();
  const next = observe(t.renderer, { maxFrames: 4, maxQueries: 16 });
  t.draw();
  t.renderer.resolveGpuFrame();
  await t.release([1]);
  expect(first.status()).toMatchObject({
    state: "disposed",
    resolvedFrames: 0,
    ignoredCompletions: 1,
  });
  expect(next.take()).toEqual([]);
  t.renderer.resolveGpuFrame();
  await t.release([3]);
  expect(next.take().map((s) => [s.generation, s.frame, s.ms])).toEqual([[2, 1, 3]]);
  t.renderer.dispose();
  expect(next.status().state).toBe("disposed");
  expect(t.raw.dispose).toHaveBeenCalledOnce();
  expect(() => observe(t.renderer, { maxFrames: 4, maxQueries: 16 })).toThrow("UNSUPPORTED");
});

it("retains queued queries across tracking-disabled frames at the ordinary sparse cadence", async () => {
  const t = await wrapped(8);
  const receipt = observe(t.renderer, { maxFrames: 8, maxQueries: 32 });
  try {
    t.draw();
    t.renderer.resolveGpuFrame();
    for (let f = 1; f <= 8; f++) {
      t.draw();
      t.renderer.resolveGpuFrame();
    }
    expect(t.pool.currentQueryIndex).toBe(2);
    await t.release([1]);
    t.draw();
    t.renderer.resolveGpuFrame(); // Actual backend gate refuses the frame9 drain.
    expect(t.pool.currentQueryIndex).toBe(2);
    expect(receipt.status().failure).toBeUndefined();
    for (let f = 10; f <= 16; f++) {
      t.draw();
      t.renderer.resolveGpuFrame();
    }
    await t.release([2, 3]);
    expect(receipt.take().map((s) => [s.frame, s.ms])).toEqual([
      [0, 1],
      [8, 2],
      [16, 3],
    ]);
    expect(receipt.status()).toMatchObject({
      expectedFrames: 3,
      resolvedFrames: 3,
      droppedFrames: 0,
    });
  } finally {
    receipt.dispose();
    t.renderer.dispose();
  }
});
it("reports and counts stopped undrained membership behind the previous batch", async () => {
  const t = observed();
  t.allocate(0);
  t.resolve();
  t.allocate(1);
  t.observation.stop();
  await t.release([1, 1]);
  t.observation.take();
  expect(t.observation.status()).toMatchObject({
    state: "stopped",
    expectedFrames: 2,
    resolvedFrames: 1,
    deliveredFrames: 1,
    undrainedFrames: 1,
    undrainedQueries: 4,
    pendingFrames: 0,
  });
  t.observation.dispose();
  expect(t.observation.status()).toMatchObject({
    expectedFrames: 2,
    droppedFrames: 1,
    droppedQueries: 4,
    undrainedFrames: 0,
  });
});
it("applies retained bounds to undrained membership behind a pending batch", () => {
  const t = observed({ maxFrames: 1, maxQueries: 4 });
  t.allocate(0);
  t.resolve();
  t.allocate(1);
  t.observation.capture();
  expect(() => t.observation.take()).toThrow("OVERFLOW");
  expect(t.observation.status()).toMatchObject({
    expectedFrames: 2,
    droppedFrames: 2,
    droppedQueries: 8,
  });
});
it("rejects a timestamp-capable factory with no callable resolver", async () => {
  const t = await wrapped();
  Reflect.deleteProperty(t.raw, "resolveTimestampsAsync");
  try {
    expect(() => observe(t.renderer, { maxFrames: 4, maxQueries: 16 })).toThrow("UNSUPPORTED");
  } finally {
    t.renderer.dispose();
  }
});
