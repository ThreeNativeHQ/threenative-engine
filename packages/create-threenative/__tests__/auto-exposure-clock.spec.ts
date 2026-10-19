import { Color, Texture } from "three";
import { texture } from "three/tsl";
import { type NodeBuilder, NodeFrame, QuadMesh, type Renderer, RendererUtils } from "three/webgpu";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLaunchFailures, watchStartupStall } from "../../core/src/launch-diagnostics.js";
import { STARTUP_STALL_MS, StartupReadiness } from "../../core/src/startup-readiness.js";
import { AutoExposureNode } from "../template-assets/autoExposure.js";
import { exposureSettings } from "../template-assets/exposure.js";
import {
  ObservedExposureNode,
  exposureFrameSnapshot,
} from "./fixtures/auto-exposure/observedExposure.js";

describe("exposure deterministic render clock", () => {
  beforeEach(() => {
    vi.spyOn(QuadMesh.prototype, "render").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function harness() {
    const node = new ObservedExposureNode(
      texture(new Texture()),
      { ...exposureSettings, enabled: true, reportInterval: 1e-6 },
      1,
    );
    node.deterministic = true;
    const frame = new NodeFrame();
    frame.deltaTime = 0.07;
    frame.time = 1;
    frame.frameId = 1;
    const read = vi.fn().mockResolvedValue(new Float32Array([0, 0.18, 0, 1]));
    frame.renderer = {
      getDrawingBufferSize: (size: { set(x: number, y: number): void }) => size.set(4, 4),
      setRenderTarget: vi.fn(),
      getRenderTarget: () => null,
      getActiveCubeFace: () => 0,
      getActiveMipmapLevel: () => 0,
      getRenderObjectFunction: () => null,
      setRenderObjectFunction: vi.fn(),
      getPixelRatio: () => 1,
      setPixelRatio: vi.fn(),
      getMRT: () => null,
      setMRT: vi.fn(),
      getClearColor: () => new Color(),
      getClearAlpha: () => 1,
      setClearColor: vi.fn(),
      getScissorTest: () => false,
      setScissorTest: vi.fn(),

      readRenderTargetPixelsAsync: read,
    } as unknown as Renderer;
    return { node, frame, read };
  }

  it("observes the environment's existing node through its actual instance methods", () => {
    const real = new AutoExposureNode(texture(new Texture()), exposureSettings, 1);
    const output = real.exposureNode;
    const setup = vi.spyOn(real, "setup").mockReturnValue(output);
    const update = vi.spyOn(real, "updateBefore").mockReturnValue(undefined);
    const dispose = vi.spyOn(real, "dispose");
    const observed = new ObservedExposureNode(real);
    const builder = {} as NodeBuilder;
    const frame = new NodeFrame();
    frame.deltaTime = 0.07;
    frame.renderer = {
      getDrawingBufferSize: (size: { set(x: number, y: number): void }) => size.set(4, 4),
    } as unknown as Renderer;
    expect(observed.node).toBe(real);
    expect(observed.settings).toBe(real.settings);
    expect(observed.exposureNode).toBe(output);
    expect(real.setup(builder)).toBe(output);
    real.updateBefore(frame);
    expect(setup).toHaveBeenCalledWith(builder);
    expect(update).toHaveBeenCalledWith(frame);
    expect(observed.setupCount).toBe(1);
    expect(observed.timing.updates).toBe(1);
    observed.setEnabled(true);
    expect(observed.getObservation()).toEqual(real.getObservation());
    real.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("freezes a cold boot after exactly three accepted live-clock GPU samples", async () => {
    const { node, frame, read } = harness();
    node.deterministic = false;
    node.coldBoot = true;
    const ready = Promise.resolve();
    node.observeColdBootStartup({ whenReady: () => ready });
    for (let i = 0; i < 8; i++) {
      node.updateBefore(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      frame.time += 0.07;
      frame.frameId++;
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(node.timing.updates).toBe(3);
    expect(node.getProgress().sampleFrames).toBe(3);
    expect(node.timing.consumedSeconds).toBeCloseTo(0.21);
    expect(node.timing.realConsumedSeconds).toBeCloseTo(0.21);
    expect(node.timing.clock).toBe("live");
    expect(frame.deltaTime).toBe(0.07);
    const messages = vi.mocked(console.info).mock.calls.map(([text]) => String(text));
    expect(messages.filter((text) => text.startsWith("TN_EXPOSURE_BOOT_FROZEN:"))).toHaveLength(1);
    expect(messages.filter((text) => text.startsWith("TN_EXPOSURE_BOOT_READY:"))).toHaveLength(1);
    expect(messages.some((text) => text.startsWith("TN_EXPOSURE_WARMUP:"))).toBe(false);
    node.dispose();
  });

  it("does not freeze a cold boot until its third GPU readback is accepted", async () => {
    const { node, frame, read } = harness();
    node.deterministic = false;
    node.coldBoot = true;
    for (let i = 0; i < 2; i++) {
      node.updateBefore(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      frame.time += 0.07;
      frame.frameId++;
    }
    let finish!: (values: Float32Array) => void;
    read.mockReturnValueOnce(
      new Promise<Float32Array>((resolve) => {
        finish = resolve;
      }),
    );
    node.updateBefore(frame);
    expect(node.getProgress().sampleFrames).toBe(2);
    node.updateBefore(frame);
    expect(read).toHaveBeenCalledTimes(3);
    finish(new Float32Array([0, 0.18, 0, 1]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(node.getProgress().sampleFrames).toBe(3);
    node.updateBefore(frame);
    expect(read).toHaveBeenCalledTimes(3);
    node.dispose();
  });

  it("holds startup until the 180th accepted readback, then reports real readiness", async () => {
    const { node, frame, read } = harness();
    let held: Promise<unknown> = Promise.resolve();
    let releaseReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseReady = resolve;
    });
    const hold = (label: string, work: Promise<unknown>, budgetMs?: number) => {
      expect(budgetMs).toBeGreaterThan(0);
      expect(budgetMs).toBeLessThanOrEqual(60_000);
      if (label === "exposure-warmup") {
        expect(budgetMs).toBe(60_000);
        held = work;
      }
    };
    node.holdStartup({ hold, whenReady: () => ready });
    const settled = vi.fn();
    void held.then(settled);
    for (let i = 0; i < 179; i++) {
      node.updateBefore(frame);
      await new Promise<void>((resolve) => setImmediate(resolve));
      frame.time += 0.07;
      frame.frameId++;
    }
    expect(settled).not.toHaveBeenCalled();
    let resolveLast!: (value: Float32Array) => void;
    read.mockReturnValueOnce(
      new Promise<Float32Array>((resolve) => {
        resolveLast = resolve;
      }),
    );
    node.updateBefore(frame);
    expect(settled).not.toHaveBeenCalled();
    resolveLast(new Float32Array([0, 0.18, 0, 1]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toHaveBeenCalledOnce();
    releaseReady();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const messages = vi.mocked(console.info).mock.calls.map(([text]) => String(text));
    const warmup = JSON.parse(
      messages.find((text) => text.startsWith("TN_EXPOSURE_WARMUP:"))?.slice(19) ?? "{}",
    );
    expect(warmup).toMatchObject({ updates: 180, measurement: node.getObservation() });
    expect(
      messages.some(
        (text) =>
          text.startsWith("TN_EXPOSURE_READY:") &&
          JSON.parse(text.slice(18)).warmupComplete === true,
      ),
    ).toBe(true);
    node.dispose();
  });

  function startupHarness() {
    vi.useFakeTimers();
    resetLaunchFailures();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const afterHolds = vi.fn();
    const readiness = new StartupReadiness({ afterHolds });
    const fixture = harness();
    fixture.node.holdStartup({
      hold: (label, work, budget) => readiness.hold(label, work, budget),
      whenReady: () => readiness.whenReady(),
    });
    readiness.start();
    for (let i = 0; i < 5; i++) readiness.observe(1);
    const stop = watchStartupStall({
      pending: () => readiness.pendingHolds,
      progress: () => 0.9 + 0.1 * (1 - readiness.pendingHolds.length / readiness.holdReport.length),
      stallMs: STARTUP_STALL_MS,
    });
    void readiness.whenReady().then(stop);
    return { ...fixture, readiness, afterHolds, stop };
  }

  it("keeps real accepted warmup progress visible across the retained 52-second cadence", async () => {
    const { node, frame, readiness, afterHolds } = startupHarness();
    const holds = readiness.holdReport.length;
    expect(holds).toBe(6);
    for (let sample = 1; sample <= 180; sample++) {
      await vi.advanceTimersByTimeAsync(289);
      node.updateBefore(frame);
      await vi.advanceTimersByTimeAsync(0);
      frame.time += 0.289;
      frame.frameId++;
      expect(readiness.holdReport).toHaveLength(holds);
      if (sample < 180) expect(readiness.ready).toBe(false);
    }
    expect(console.error).not.toHaveBeenCalled();
    expect(readiness.ready).toBe(true);
    expect(afterHolds).toHaveBeenCalledOnce();
    expect(node.getProgress().sampleFrames).toBe(180);
    expect(readiness.holdReport.every(({ expired }) => !expired)).toBe(true);
    node.dispose();
  });

  it("cannot accept terminal completion arriving after the unchanged hold deadline", async () => {
    const { node, frame, read, readiness, afterHolds } = startupHarness();
    for (let sample = 1; sample < 180; sample++) {
      await vi.advanceTimersByTimeAsync(289);
      node.updateBefore(frame);
      await vi.advanceTimersByTimeAsync(0);
      frame.time += 0.289;
      frame.frameId++;
    }
    let finish!: (values: Float32Array) => void;
    read.mockReturnValueOnce(
      new Promise<Float32Array>((resolve) => {
        finish = resolve;
      }),
    );
    node.updateBefore(frame);
    await vi.advanceTimersByTimeAsync(60_001 - 179 * 289);
    expect(readiness.ready).toBe(true);
    expect(readiness.holdReport.find(({ label }) => label === "exposure-warmup")?.expired).toBe(
      true,
    );
    expect(afterHolds).toHaveBeenCalledOnce();
    const messages = () => vi.mocked(console.info).mock.calls.map(([text]) => String(text));
    const ready = messages().find((text) => text.startsWith("TN_EXPOSURE_READY:"));
    expect(JSON.parse(ready?.slice(18) ?? "{}").warmupComplete).toBe(false);
    expect(messages().some((text) => text.startsWith("TN_EXPOSURE_WARMUP:"))).toBe(false);
    finish(new Float32Array([0, 0.18, 0, 1]));
    await vi.advanceTimersByTimeAsync(0);
    const warmup = messages().find((text) => text.startsWith("TN_EXPOSURE_WARMUP:"));
    expect(JSON.parse(warmup?.slice(19) ?? "{}").elapsedMs).toBeGreaterThan(60_000);
    expect(messages().filter((text) => text.startsWith("TN_EXPOSURE_READY:"))).toEqual([ready]);
    node.dispose();
  });

  it("does not release or resubmit a checkpoint after disposal and late completion", async () => {
    const { node, frame, read, readiness, stop } = startupHarness();
    for (let sample = 1; sample < 30; sample++) {
      node.updateBefore(frame);
      await vi.advanceTimersByTimeAsync(0);
      frame.time += 0.07;
      frame.frameId++;
    }
    let finish!: (values: Float32Array) => void;
    read.mockReturnValueOnce(
      new Promise<Float32Array>((resolve) => {
        finish = resolve;
      }),
    );
    node.updateBefore(frame);
    const pending = [...readiness.pendingHolds];
    node.dispose();
    const progress = vi.fn();
    node.onProgress = progress;
    vi.mocked(console.info).mockClear();
    finish(new Float32Array([0, 0.18, 0, 1]));
    await vi.advanceTimersByTimeAsync(0);
    node.updateBefore(frame);
    expect(read).toHaveBeenCalledTimes(30);
    expect(node.getProgress().sampleFrames).toBe(29);
    expect(readiness.pendingHolds).toEqual(pending);
    expect(progress).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
    stop();
  });

  it("still diagnoses no accepted sample at 45 seconds and expires every hold at the original deadline", async () => {
    const { node, readiness, afterHolds } = startupHarness();
    await vi.advanceTimersByTimeAsync(STARTUP_STALL_MS);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("TN_STARTUP_STALLED"));
    expect(readiness.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(readiness.ready).toBe(true);
    expect(readiness.holdReport.every(({ expired }) => expired)).toBe(true);
    expect(afterHolds).toHaveBeenCalledOnce();
    expect(node.getProgress().sampleFrames).toBe(0);
    expect(
      vi
        .mocked(console.info)
        .mock.calls.some(
          ([text]) =>
            String(text).startsWith("TN_EXPOSURE_READY:") &&
            JSON.parse(String(text).slice(18)).warmupComplete === false,
        ),
    ).toBe(true);
    node.dispose();
  });

  it.each(["NaN", "reject", "missing"])(
    "does not release a checkpoint on a %s readback",
    async (fault) => {
      const { node, frame, read, readiness, stop } = startupHarness();
      for (let sample = 1; sample < 30; sample++) {
        node.updateBefore(frame);
        await vi.advanceTimersByTimeAsync(0);
        frame.time += 0.07;
        frame.frameId++;
      }
      const pending = [...readiness.pendingHolds];
      if (fault === "NaN") read.mockResolvedValueOnce(new Float32Array([Number.NaN, 0.18, 0, 1]));
      if (fault === "reject") read.mockRejectedValueOnce(new Error("readback failed"));
      if (fault === "missing") read.mockReturnValueOnce(new Promise(() => {}));
      node.updateBefore(frame);
      await vi.advanceTimersByTimeAsync(0);
      expect(node.getProgress().sampleFrames).toBe(29);
      expect(readiness.pendingHolds).toEqual(pending);
      expect(readiness.ready).toBe(false);
      node.dispose();
      stop();
    },
  );
  it.each(["resolve", "reject"])(
    "invalidates a delayed readback after disposal: %s",
    async (outcome) => {
      const { node, frame, read } = harness();
      let resolveRead!: (value: Float32Array) => void;
      let rejectRead!: (error: Error) => void;
      read.mockReturnValueOnce(
        new Promise<Float32Array>((resolve, reject) => {
          resolveRead = resolve;
          rejectRead = reject;
        }),
      );
      node.holdStartup({ hold: () => {}, whenReady: () => Promise.resolve() });
      const progress = vi.fn();
      node.onProgress = progress;
      node.updateBefore(frame);
      node.dispose();
      progress.mockClear();
      vi.mocked(console.info).mockClear();
      if (outcome === "resolve") resolveRead(new Float32Array([0, 0.18, 0, 1]));
      else rejectRead(new Error("late readback failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(node.getProgress().sampleFrames).toBe(0);
      expect(progress).not.toHaveBeenCalled();
      expect(console.info).not.toHaveBeenCalled();
      expect(frame.renderer?.readRenderTargetPixelsAsync).toBe(read);
    },
  );
  it("stamps each sample only after production accepts that exact readback", async () => {
    const { node, frame } = harness();
    node.updateBefore(frame);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const messages = vi.mocked(console.info).mock.calls.map(([text]) => String(text));
    const accepted = messages.findIndex((text) => text.startsWith("TN_AUTO_EXPOSURE:"));
    const sampled = messages.findIndex((text) => text.startsWith("TN_EXPOSURE_SAMPLE:"));
    expect(accepted).toBeGreaterThanOrEqual(0);
    expect(sampled).toBeGreaterThan(accepted);
    expect(JSON.parse(messages[sampled]?.slice(19) ?? "{}").measurement).toEqual(
      node.getObservation(),
    );
    node.dispose();
  });
  it("holds each pose at exactly 180 completed GPU samples and preserves the public read method", async () => {
    const { node, frame, read } = harness();
    for (let pose = 0; pose < 2; pose++) {
      if (pose === 1) node.beginCut();
      for (let i = 0; i < 185; i++) {
        node.updateBefore(frame);
        expect(frame.renderer?.readRenderTargetPixelsAsync).toBe(read);
        await new Promise<void>((resolve) => setImmediate(resolve));
        frame.time += 0.07;
        frame.frameId++;
      }
      expect(node.timing.updates).toBe((pose + 1) * 180);
      expect(node.getProgress().sampleFrames).toBe((pose + 1) * 180);
    }
    expect(node.getProgress().cutSampleFrames).toBe(180);
    expect(node.timing.consumedSeconds).toBeCloseTo(6, 8);
    expect(node.timing.realConsumedSeconds).toBeCloseTo(25.2, 8);
    expect(frame.deltaTime).toBe(0.07);
    node.dispose();
  });

  it("restores readback instrumentation even if the actual graph draw throws", () => {
    const { node, frame, read } = harness();
    vi.mocked(QuadMesh.prototype.render).mockImplementationOnce(() => {
      throw new Error("draw failed");
    });
    expect(() => node.updateBefore(frame)).toThrow("draw failed");
    expect(frame.renderer?.readRenderTargetPixelsAsync).toBe(read);
    expect(node.getProgress().sampleFrames).toBe(0);
    node.dispose();
  });
  it("passes a separate public NodeFrame snapshot and preserves the shared real clock", () => {
    const frame = new NodeFrame();
    frame.deltaTime = 0.07;
    frame.time = 12;
    frame.frameId = 9;
    const snapshot = exposureFrameSnapshot(frame);
    expect(snapshot).toBeInstanceOf(NodeFrame);
    expect(snapshot).not.toBe(frame);
    expect(snapshot.deltaTime).toBe(1 / 60);
    expect(snapshot.time).toBe(12);
    expect(snapshot.frameId).toBe(9);
    expect(snapshot.renderer).toBe(frame.renderer);
    expect(frame.deltaTime).toBe(0.07);
  });
});

it("publishes the zero post-cut sample baseline synchronously", () => {
  const node = new ObservedExposureNode(texture(new Texture()), exposureSettings, 1);
  let progress: unknown;
  node.onProgress = () => {
    progress = node.getProgress();
  };
  node.beginCut();
  expect(progress).toEqual({ sampleFrames: 0, cutSampleFrames: 0 });
  node.dispose();
});
