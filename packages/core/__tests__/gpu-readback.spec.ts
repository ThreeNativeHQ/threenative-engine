import { describe, expect, it } from "vitest";
import { GPUReadback } from "../src/gpu-readback.js";
import { createRenderer } from "../src/renderer.js";
import type { IRendererLike } from "../src/renderer.js";

interface IReadbackRendererControl {
  readonly renderer: IRendererLike;
  readonly calls: number;
  land(bytes: Float32Array): void;
  landAt(index: number, bytes: Float32Array): void;
  reject(error: Error): void;
}

/**
 * A renderer whose readback resolves only when the test says so.
 *
 * The latency is the subject here, so a stub that resolves on its own would prove the opposite of
 * what these tests are for.
 */
function readbackRenderer(): IReadbackRendererControl {
  const pending: {
    resolve: (bytes: ArrayBuffer) => void;
    reject: (error: Error) => void;
  }[] = [];
  const canvas = new EventTarget() as HTMLCanvasElement;
  const renderer = {
    compileAsync: async () => undefined,
    compute: () => undefined,
    dispose: () => undefined,
    domElement: canvas,
    info: {},
    kind: "webgpu" as const,
    raw: {},
    readback: () =>
      new Promise<ArrayBuffer>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    render: () => undefined,
    renderOverlay: () => undefined,
    setOutputNode: () => undefined,
    setSize: () => undefined,
    gpuFrameMs: () => undefined,
    resolveGpuFrame: () => undefined,
    setResolutionScale: () => undefined,
    surface: () => ({
      atFloor: false,
      devicePixelRatio: 1,
      drawingBufferHeight: 1,
      drawingBufferWidth: 1,
      resolutionScale: 1,
      sampleCount: 1,
      scale: 1,
      scaleSource: "auto" as const,
    }),
  } satisfies IRendererLike;
  return {
    renderer,
    get calls() {
      return pending.length;
    },
    land(bytes) {
      const next = pending.shift();
      if (next === undefined) throw new Error("no readback in flight");
      next.resolve(bytes.buffer as ArrayBuffer);
    },
    landAt(index, bytes) {
      const [next] = pending.splice(index, 1);
      if (next === undefined) throw new Error(`no readback in flight at ${index}`);
      next.resolve(bytes.buffer as ArrayBuffer);
    },
    reject(error) {
      const next = pending.shift();
      if (next === undefined) throw new Error("no readback in flight");
      next.reject(error);
    },
  };
}

function attribute() {
  return { isStorageBufferAttribute: true };
}

describe("GPUReadback", () => {
  it("should reject a non-positive throttle rather than reading every frame by accident", () => {
    expect(() => new GPUReadback({ attribute: attribute(), everyFrames: 0 })).toThrow(
      "everyFrames must be a positive integer",
    );
    expect(() => new GPUReadback({ attribute: attribute(), everyFrames: 1.5 })).toThrow(
      "everyFrames must be a positive integer",
    );
  });

  it("should reject a missing attribute", () => {
    expect(() => new GPUReadback({ attribute: undefined, everyFrames: 1 })).toThrow(
      "attribute is required",
    );
  });

  it("should never block the frame while a readback is pending", () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1 });
    // The stub's promise never settles on its own. If `request` awaited it, this loop would not
    // return at all — the frame stall this class exists to avoid, made visible as a hang.
    const started = performance.now();
    for (let frame = 0; frame < 240; frame += 1) readback.request(control.renderer);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(50);
    // One copy in flight, 239 dropped rather than queued: a backlog of copies of a field that has
    // already moved on is latency carrying no information.
    expect(control.calls).toBe(1);
    expect(readback.stats.requests).toBe(1);
    expect(readback.pending).toBe(true);
  });

  it("should report staleFrames growing while no new readback lands", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 4 });
    readback.request(control.renderer);
    control.land(new Float32Array([1, 2, 3]));
    await Promise.resolve();
    expect(readback.staleFrames).toBe(0);
    const observed: number[] = [];
    for (let frame = 0; frame < 6; frame += 1) {
      readback.request(control.renderer);
      observed.push(readback.staleFrames);
    }
    // Monotonic: every frame that passes without a landing makes the sample one frame older.
    expect(observed).toStrictEqual([1, 2, 3, 4, 5, 6]);
    for (let index = 1; index < observed.length; index += 1) {
      expect(observed[index]).toBeGreaterThan(observed[index - 1] as number);
    }
  });

  it("should carry staleness on the sample, not only on the class", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1 });
    expect(readback.sample).toBeUndefined();
    readback.request(control.renderer);
    control.land(new Float32Array([7, 8]));
    await Promise.resolve();
    readback.request(control.renderer);
    readback.request(control.renderer);
    const sample = readback.sample;
    expect(sample).toBeDefined();
    expect([...(sample?.data ?? [])]).toStrictEqual([7, 8]);
    expect(sample?.staleFrames).toBe(2);
  });

  it("should distinguish never-landed from landed-at-frame-zero", () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 8 });
    for (let frame = 0; frame < 3; frame += 1) readback.request(control.renderer);
    // Nothing has landed. A zero here would read as "this frame's data" to a caller that only
    // checks staleness, which is the exact confusion this class exists to prevent.
    expect(readback.data).toBeUndefined();
    expect(readback.staleFrames).toBe(3);
  });

  it("should throttle to the declared cadence and refresh staleness when a copy lands", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 3 });
    readback.request(control.renderer);
    control.land(new Float32Array([1]));
    await Promise.resolve();
    readback.request(control.renderer);
    readback.request(control.renderer);
    expect(control.calls).toBe(0);
    expect(readback.staleFrames).toBe(2);
    readback.request(control.renderer);
    expect(control.calls).toBe(1);
    control.land(new Float32Array([2]));
    await Promise.resolve();
    expect([...(readback.data ?? [])]).toStrictEqual([2]);
    expect(readback.staleFrames).toBe(0);
  });

  it("should count a rejected readback as a failure and keep the previous sample", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1 });
    readback.request(control.renderer);
    control.land(new Float32Array([5]));
    await Promise.resolve();
    readback.request(control.renderer);
    control.reject(new Error("device lost"));
    await Promise.resolve();
    await Promise.resolve();
    expect(readback.stats.failures).toBe(1);
    expect([...(readback.data ?? [])]).toStrictEqual([5]);
    expect(readback.pending).toBe(false);
  });

  it("should throw on a renderer without readback support", async () => {
    const canvas = new EventTarget() as HTMLCanvasElement;
    const renderer = await createRenderer({
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    });
    // Silently returning undefined here would hand a buoyancy solver a height of nothing and let
    // it float a hull on it. The seam fails closed the same way `compute` does.
    await expect(renderer.readback({})).rejects.toThrow(
      "readback is unavailable on the webgl2 renderer.",
    );
    renderer.dispose();
  });

  it("should refuse further requests after release", () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1 });
    readback.dispose();
    expect(readback.released).toBe(true);
    expect(() => readback.request(control.renderer)).toThrow("cannot request after release");
  });

  it("should read back a buffer that is not an ocean", async () => {
    // The seam is plumbing, not a water feature: a game counting GPU-side survivors reaches for
    // the same class and gets the same staleness contract.
    const control = readbackRenderer();
    const survivors = new GPUReadback({ attribute: attribute(), everyFrames: 10 });
    survivors.request(control.renderer);
    control.land(new Float32Array([1024]));
    await Promise.resolve();
    expect(survivors.data?.[0]).toBe(1024);
    expect(survivors.staleFrames).toBe(0);
  });

  it("should drop a second request while one copy is in flight by default", () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1 });
    readback.request(control.renderer);
    readback.request(control.renderer);
    expect(readback.stats.requests).toBe(1);
    expect(control.calls).toBe(1);
  });

  it("should keep several copies in flight for a probe and take every landed sample in issue order", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1, maxInFlight: 3 });
    for (let frame = 0; frame < 4; frame += 1) readback.request(control.renderer);
    // Three copies in flight, and the fourth request dropped at the cap rather than queued.
    expect(control.calls).toBe(3);
    expect(readback.stats.requests).toBe(3);
    control.landAt(1, new Float32Array([2]));
    await Promise.resolve();
    control.landAt(0, new Float32Array([1]));
    await Promise.resolve();
    control.landAt(0, new Float32Array([3]));
    await Promise.resolve();
    const samples = readback.take();
    expect(samples.map((sample) => sample.data[0])).toStrictEqual([1, 2, 3]);
    // The take happens on frame 4, so each sample is 3, 2 and 1 frames old.
    expect(samples.map((sample) => sample.staleFrames)).toStrictEqual([3, 2, 1]);
    expect([...(readback.data ?? [])]).toStrictEqual([3]);
    expect(readback.sample?.staleFrames).toBe(1);
    expect(readback.take()).toStrictEqual([]);
  });

  it("should keep only the newest untaken samples when no probe drains them", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1, maxInFlight: 2 });
    for (let frame = 1; frame <= 5; frame += 1) {
      readback.request(control.renderer);
      control.land(new Float32Array([frame]));
      await Promise.resolve();
    }
    // maxInFlight * 2 = 4 untaken samples: the frame-1 sample is dropped as the oldest.
    expect(readback.take().map((sample) => sample.data[0])).toStrictEqual([2, 3, 4, 5]);
  });

  it("should drop untaken samples on dispose", async () => {
    const control = readbackRenderer();
    const readback = new GPUReadback({ attribute: attribute(), everyFrames: 1 });
    readback.request(control.renderer);
    control.land(new Float32Array([1]));
    await Promise.resolve();
    readback.dispose();
    expect(readback.take()).toStrictEqual([]);
  });

  it("should reject a maxInFlight that is not a positive integer", () => {
    expect(
      () => new GPUReadback({ attribute: attribute(), everyFrames: 1, maxInFlight: 0 }),
    ).toThrow("maxInFlight must be a positive integer");
    expect(
      () => new GPUReadback({ attribute: attribute(), everyFrames: 1, maxInFlight: 1.5 }),
    ).toThrow("maxInFlight must be a positive integer");
  });
});
