import { PerspectiveCamera, Scene as ThreeScene } from "three";
import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import { createRenderer } from "../src/renderer.js";
import { Scene } from "../src/scene.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 1080 },
    clientWidth: { configurable: true, value: 2400 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/**
 * Three's `WebGPUTimestampQueryPool` holds 2048 queries and spends two per render pass. A
 * scene with a post-processing chain runs tens of passes per frame — a cathedral with SSGI,
 * denoise, godrays, SSR and bloom measured 27 — so the pool fills in under forty frames:
 *
 *   2048 queries / (2 per pass x 27 passes) = 37.9 frames
 *
 * Once full, three warns `Maximum number of queries exceeded` and stops recording, so
 * `renderer.info.render.timestamp` — the only thing `gpuFrameMs()` reads — goes stale and
 * every reported window carries `gpuMs: undefined`.
 *
 * The resolve was wired to the frame-budget window boundary, which is 300 frames by default.
 * That is eight times too slow to keep the pool from overflowing, and it defeats the stated
 * reason `trackTimestamp` is on unconditionally: *"This is the measurement itself"*, replacing
 * a record where "every GPU number was wall-clock algebra".
 *
 * `resolveTimestampsAsync` is fire-and-forget and already `.catch()`-guarded, so resolving per
 * frame does not put the GPU on the frame path — which was the original cadence's whole
 * concern.
 */
describe("GPU timestamp queries are resolved often enough to stay readable", () => {
  it("resolves once per rendered frame, not once per frame-budget window", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    let resolves = 0;
    const resolveTypes: string[] = [];
    class Empty extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      // Deliberately larger than the frame count below: if the resolve is wired to the window
      // boundary, no window closes and the count stays at zero.
      frameBudget: { report: () => undefined, reportEvery: 1000 },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info: { render: { timestamp: 0 } },
          render: () => undefined,
          async resolveTimestampsAsync(this: { info?: unknown } | undefined, type = "render") {
            // Three's real method reads this.backend. An arrow stub hid a detached call.
            if (this === undefined || this.info === undefined)
              throw new Error("lost renderer receiver");
            resolves += 1;
            resolveTypes.push(type);
            return Promise.resolve(undefined);
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: Empty },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      const frames = 30;
      for (let index = 1; index <= frames; index += 1) frame(index * 16.7);

      // The bound that matters is not "exactly once per frame" — it is "often enough that a
      // pass-heavy scene never fills the pool". Thirty frames of a 27-pass scene is 1,620
      // queries against a 2,048 capacity, so at least one resolve must have happened well
      // inside that window.
      expect(
        resolves,
        `resolveTimestampsAsync ran ${resolves} times across ${frames} frames; the query pool fills in ~38`,
      ).toBeGreaterThanOrEqual((frames - 2) * 2);
      expect(resolveTypes.filter((type) => type === "render").length).toBeGreaterThanOrEqual(
        frames - 2,
      );
      expect(resolveTypes.filter((type) => type === "compute").length).toBeGreaterThanOrEqual(
        frames - 2,
      );
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      await game.stop();
    }
  });
});

/**
 * Three r185's `WebGPUTimestampQueryPool`, ported rather than paraphrased, because the whole bug is
 * in the parts a paraphrase drops:
 *
 * - `resolveQueriesAsync` returns the *previous* batch's `lastValue` unless there are un-resolved
 *   queries, and returns the *in-flight* promise — starting nothing — while one is outstanding
 *   (`three.webgpu.js:83619-83642`). So a resolve is skipped whenever the previous one has not come
 *   back by the time it is asked for.
 * - `_resolveQueries` empties the pool *before* submitting, then waits on `mapAsync` for its results
 *   (`three.webgpu.js:83668-83704`), so the answer lands several presented frames later.
 * - It answers with **one** number: the summed duration of the **last** frame in the batch
 *   (`three.webgpu.js:83746-83753`). Every other frame the batch measured is written to
 *   `timestamps`, keyed by uid, and never read again.
 *
 * The engine asked for a resolve on the same 1-in-8 stride it samples on, so the two facts above
 * compose into a sample count of `reportEvery / (8 x ceil(round-trip / 8))`: the stride is a frame
 * count and the round trip is not, so the count fell as the frame rate rose — 28 samples in a
 * 300-frame window at a slow frame rate, 1-2 in the ~200 fps windows of the 2026-10-03 Machinefall
 * probe, against the ~37 the sampler was asking for.
 */
class FakeTimestampQueryPool {
  readonly maxQueries = 2048;
  currentQueryIndex = 0;
  queryOffsets = new Map<string, number>();
  readonly timestamps = new Map<string, number>();
  frames: number[] = [];
  lastValue = 0;
  pendingResolve: Promise<number> | null = null;
  /** Three's pool-level flag is never toggled by the engine; the backend's is. */
  trackTimestamp = true;
  /** Resolves three refused because one was already in flight — the mechanism under test. */
  skippedWhilePending = 0;

  constructor(
    private readonly backendGate: () => boolean,
    /** Presented frames between submitting a resolve and reading its results, as `mapAsync` takes. */
    private readonly roundTripFrames: number,
    private readonly settle: (resolve: () => void) => void,
  ) {}

  allocateQueriesForContext(uid: string): number | null {
    if (!this.backendGate()) return null;
    if (this.currentQueryIndex + 2 > this.maxQueries) return null;
    const baseOffset = this.currentQueryIndex;
    this.currentQueryIndex += 2;
    this.queryOffsets.set(uid, baseOffset);
    return baseOffset;
  }

  getTimestampFrames(): number[] {
    return this.frames;
  }

  async resolveQueriesAsync(): Promise<number> {
    if (!this.trackTimestamp || this.currentQueryIndex === 0) return this.lastValue;
    if (this.pendingResolve) {
      this.skippedWhilePending += 1;
      return this.pendingResolve;
    }
    this.pendingResolve = this._resolveQueries();
    try {
      return await this.pendingResolve;
    } finally {
      this.pendingResolve = null;
    }
  }

  async _resolveQueries(): Promise<number> {
    const currentOffsets = new Map(this.queryOffsets);
    const queryCount = this.currentQueryIndex;
    // Emptied before the GPU work, exactly as three does it.
    this.currentQueryIndex = 0;
    this.queryOffsets.clear();
    await new Promise<void>((resolve) => this.settle(resolve));
    const times = new BigUint64Array(queryCount);
    for (let index = 0; index < queryCount; index += 1)
      times[index] = BigInt(index + 1) * 1_000_000n;
    const framesDuration: Record<number, number> = {};
    const frames: number[] = [];
    for (const [uid, baseOffset] of currentOffsets) {
      const match = /:f(\d+)$/u.exec(uid);
      if (match === null) continue;
      const frame = Number(match[1]);
      if (!frames.includes(frame)) frames.push(frame);
      const duration =
        Number((times[baseOffset + 1] as bigint) - (times[baseOffset] as bigint)) / 1e6;
      this.timestamps.set(uid, duration);
      framesDuration[frame] = (framesDuration[frame] ?? 0) + duration;
    }
    // Three's own expression, undefined and all when a batch carried no frame.
    const totalDuration = framesDuration[frames[frames.length - 1] as number] as number;
    this.lastValue = totalDuration;
    this.frames = frames;
    return totalDuration;
  }
}

interface IWindow {
  readonly window: number;
  readonly gpu?: { readonly samples: number } | undefined;
  readonly gpuStale: number;
}

/**
 * One game's frame budget at `frameMs` per presented frame, against the ported pool above with
 * `roundTripFrames` between a resolve and its answer, `passes` render passes per frame and the
 * engine's 1-in-8 sampler.
 */
async function runWindows(options: {
  readonly frameMs: number;
  readonly roundTripFrames: number;
  readonly passes?: number;
}): Promise<{
  readonly frames: number;
  readonly windows: IWindow[];
  readonly tracked: number;
  readonly skippedResolves: number;
}> {
  const canvas = testCanvas();
  const passes = options.passes ?? 6;
  // Windows close on simulated ticks. Converting 300 presented frames at this frame rate keeps each
  // window at the frame count the sampler is tested against.
  const reportEvery = Math.round((300 * options.frameMs) / (1000 / 60));
  // Three 300-frame windows plus a margin, so the third window closes at every frame rate.
  const presented = 930;
  let presentedFrame = 0;
  const windows: IWindow[] = [];
  let tracked = 0;
  /** Map callbacks three is waiting on, and the presented frame each one is due at. */
  let dueAt = Number.POSITIVE_INFINITY;
  let due: Array<() => void> = [];
  const settle = (resolve: () => void): void => {
    due.push(resolve);
    dueAt = Math.min(dueAt, presentedFrame + options.roundTripFrames);
  };
  const info = {
    frame: 0,
    compute: { timestamp: 0 },
    render: { drawCalls: 0, frameCalls: 0, timestamp: 0, triangles: 0 },
  };
  const backend = {
    trackTimestamp: true,
    timestampQueryPool: {} as Record<string, FakeTimestampQueryPool | undefined>,
    getTimestampFrames(type: string): number[] {
      return this.timestampQueryPool[type]?.getTimestampFrames() ?? [];
    },
    initTimestampQuery(type: string, uid: string): void {
      this.timestampQueryPool[type]?.allocateQueriesForContext(uid);
    },
    // Three's backend refuses to resolve at all while tracking is off, which is why the engine has
    // to hold the flag on across the call rather than let the sampler own it.
    async resolveTimestampsAsync(
      this: { trackTimestamp: boolean },
      type = "render",
    ): Promise<number | undefined> {
      if (!this.trackTimestamp) return undefined;
      const pool = backend.timestampQueryPool[type];
      if (pool === undefined) return undefined;
      const duration = await pool.resolveQueriesAsync();
      info[type as "render" | "compute"].timestamp = duration;
      return duration;
    },
  };
  const render = new FakeTimestampQueryPool(
    () => backend.trackTimestamp,
    options.roundTripFrames,
    settle,
  );
  const compute = new FakeTimestampQueryPool(
    () => backend.trackTimestamp,
    options.roundTripFrames,
    settle,
  );
  backend.timestampQueryPool = { compute, render };
  const raw = {
    backend,
    domElement: canvas,
    info,
    async init(): Promise<void> {
      backend.trackTimestamp = true;
    },
    render(): void {
      if (backend.trackTimestamp) tracked += 1;
      // One uid per pass, as three mints them from `info.frame` and the pass's frame call.
      for (let pass = 0; pass < passes; pass += 1) {
        info.render.frameCalls += 1;
        info.render.drawCalls += 1;
        info.render.triangles += 3;
        backend.initTimestampQuery(
          "render",
          `r:${String(pass)}:${String(info.render.frameCalls)}:f${String(info.frame)}`,
        );
      }
      info.render.frameCalls = 0;
    },
    async resolveTimestampsAsync(this: unknown, type = "render"): Promise<number | undefined> {
      return (
        backend.resolveTimestampsAsync as (
          this: unknown,
          type?: string,
        ) => Promise<number | undefined>
      ).call(backend, type);
    },
    setSize: (): void => undefined,
  };
  class Empty extends Scene {
    static override readonly initialState = {};
  }
  const game = defineGame({
    frameBudget: {
      report: (line: string) => {
        // The sink also receives projection, span, validation and warning lines; keep the windows.
        if (!line.startsWith("TN_FRAME_BUDGET")) return;
        windows.push(JSON.parse(line.slice(line.indexOf("{"))) as IWindow);
      },
      reportEvery,
    },
    renderer: { canvas, webgpuFactory: () => raw as never },
    scenes: { test: Empty },
    start: "test",
  });
  let frame: ((time: number) => void) | undefined;
  const requestFrame = globalThis.requestAnimationFrame;
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: (time: number) => void) => {
      frame = callback;
      return 1;
    },
  });
  try {
    await game.start();
    if (frame === undefined) throw new Error("Game did not start its loop.");
    // The loop seeds its clock from performance.now() at start, so the fake frames start there too.
    let now = performance.now();
    for (let index = 1; index <= presented; index += 1) {
      now += options.frameMs;
      presentedFrame = index;
      frame(now);
      // `mapAsync` lands between presented frames, as a browser's task loop runs it, and the awaits
      // behind it drain in the same gap.
      if (presentedFrame >= dueAt) {
        const ready = due;
        due = [];
        dueAt = Number.POSITIVE_INFINITY;
        for (const resolve of ready) resolve();
        for (let waited = 0; waited < ready.length * 4; waited += 1) await Promise.resolve();
      }
    }
    return {
      frames: presentedFrame,
      skippedResolves: render.skippedWhilePending,
      tracked,
      windows,
    };
  } finally {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: requestFrame,
    });
    if (navigatorDescriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    await game.stop();
  }
}

describe("a window's GPU samples survive three's one-number-per-resolve", () => {
  it("reports a sample per sampled frame at 200 fps, where the resolve round trip outlives the stride", async () => {
    const { frames, skippedResolves, tracked, windows } = await runWindows({
      frameMs: 5,
      roundTripFrames: 12,
    });

    // The sampler is unchanged: one frame in eight, counted by the wrapper.
    expect(tracked).toBe(Math.ceil(frames / 8));
    // And the ported pool really did refuse resolves while one was in flight, which is the whole
    // mechanism: without that this test would pass with a stub three never behaves like.
    expect(skippedResolves).toBeGreaterThan(0);

    expect(windows.length).toBe(3);
    for (const window of windows) {
      expect(
        window.gpu?.samples,
        `window ${String(window.window)} carried ${String(window.gpu?.samples ?? 0)} samples where the 1-in-8 sampler recorded ${String(Math.ceil(tracked / 3))}, with ${String(window.gpuStale)} stale frames`,
      ).toBeGreaterThanOrEqual(30);
    }
  });

  it("reports the same count at 60 fps, where the round trip is three times as long in wall time", async () => {
    const slow = await runWindows({ frameMs: 1000 / 60, roundTripFrames: 12 });
    const fast = await runWindows({ frameMs: 1000 / 240, roundTripFrames: 12 });

    // Each run must close its windows, or the minimum below passes vacuously on an empty list.
    expect(slow.windows).toHaveLength(3);
    expect(fast.windows).toHaveLength(3);
    const perWindow = (run: { readonly windows: IWindow[] }): number =>
      Math.min(...run.windows.map((window) => window.gpu?.samples ?? 0));
    // A frame rate is not an input to how many frames the device answered for.
    expect(perWindow(slow)).toBeGreaterThanOrEqual(30);
    expect(perWindow(fast)).toBeGreaterThanOrEqual(30);
  });
});
