import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyVariant,
  backendOf,
  captureConfiguredGpu,
  collectRafCadence,
  parseArgs,
  profileLive,
  readConfiguredGpu,
  summarizeFrames,
} from "../profile-starter.js";

describe("starter profiler", () => {
  it("summarizes frame percentiles and slow frames", () => {
    const summary = summarizeFrames([1, 2, 3, 4, 20]);

    expect(summary).toMatchObject({
      frames: 5,
      maxMs: 20,
      meanMs: 6,
      p50Ms: 3,
      p95Ms: 20,
      p99Ms: 20,
      slowFrames: 1,
    });
  });

  it("fails closed on malformed samples", () => {
    expect(() => summarizeFrames([])).toThrow(/positive finite/);
    expect(() => summarizeFrames([1, Number.NaN])).toThrow(/positive finite/);
  });

  it("applies only declared isolation variants", () => {
    const source = "    ctx.add(sculptureMesh);";

    expect(applyVariant(source, "no-sculpture")).not.toContain("ctx.add(sculptureMesh)");
    expect(() => applyVariant(source, "no-particles" as never)).toThrow(/Unsupported/);
    expect(() => applyVariant("", "no-sculpture")).toThrow(/marker is missing/);
  });

  it("rejects the removed particle profile variant", () => {
    expect(parseArgs(["--variant", "baseline"]).variant).toBe("baseline");
    expect(parseArgs(["--variant", "no-sculpture"]).variant).toBe("no-sculpture");
    expect(() => parseArgs(["--variant", "no-particles"])).toThrow(/baseline or no-sculpture/);
  });

  it("names a software rasteriser instead of reporting it as a GPU", () => {
    expect(backendOf({ architecture: "turing", vendor: "nvidia" })).toBe("hardware");
    expect(backendOf({ architecture: "SwiftShader", vendor: "google" })).toBe("software fallback");
    expect(backendOf({ architecture: "llvmpipe", vendor: "mesa" })).toBe("software fallback");
    expect(backendOf(null)).toBe("unknown");
  });
});

describe("live starter profiler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function gpuHarness() {
    const actual = {
      adapterInfo: { architecture: "turing", description: "RTX", device: "1", vendor: "nvidia" },
    };
    const unused = { adapterInfo: { architecture: "SwiftShader", vendor: "google" } };
    const requestAdapter = vi.fn(async () => ({ info: unused.adapterInfo }));
    vi.stubGlobal("navigator", { gpu: { requestAdapter } });
    vi.stubGlobal("__THREENATIVE_PROFILE_GPU__", undefined);
    vi.stubGlobal("getComputedStyle", () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
    }));
    const configure = vi.fn(function (this: unknown, configuration: { device: typeof actual }) {
      if (!configuration.device) throw new Error("configure failed");
      return this;
    });
    class Context {
      canvas = {
        isConnected: true,
        width: 1920,
        height: 1080,
        getBoundingClientRect: () => ({
          width: 1920,
          height: 1080,
          left: 0,
          top: 0,
          right: 1920,
          bottom: 1080,
        }),
      };
      configure(configuration: { device: typeof actual }) {
        return Reflect.apply(configure, this, [configuration]);
      }
    }
    vi.stubGlobal("GPUCanvasContext", Context);
    captureConfiguredGpu();
    const context = new Context();
    return {
      actual,
      unused,
      requestAdapter,
      configure,
      Context,
      context,
      viewport: { width: 1920, height: 1080 },
    };
  }

  it("reads the latest configured device instead of probing an unused adapter", () => {
    const { context, actual, unused, requestAdapter, configure, viewport } = gpuHarness();
    const first = { device: unused };
    expect(context.configure(first as never)).toBe(context);
    const configuration = { device: actual };
    expect(context.configure(configuration)).toBe(context);
    expect(configure.mock.calls[1]?.[0]).toBe(configuration);
    expect(readConfiguredGpu(viewport)).toEqual({
      adapter: actual.adapterInfo,
      gpuAvailable: true,
    });
    expect(requestAdapter).not.toHaveBeenCalled();
  });

  it("preserves configure exceptions and does not record failed configurations", () => {
    const { context, configure, viewport } = gpuHarness();
    const error = new Error("original configure error");
    configure.mockImplementationOnce(() => {
      throw error;
    });
    let thrown: unknown;
    try {
      context.configure({ device: {} } as never);
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(error);
    expect(() => readConfiguredGpu(viewport)).toThrow(/found 0/);
  });

  it("excludes nonmatching canvases and rejects ambiguous or missing matches", () => {
    const { context, Context, actual, viewport } = gpuHarness();
    expect(() => readConfiguredGpu(viewport)).toThrow(/found 0/);
    context.configure({ device: actual });
    const overlay = new Context();
    overlay.canvas.width = 100;
    overlay.configure({ device: actual });
    expect(readConfiguredGpu(viewport).adapter).toEqual(actual.adapterInfo);
    overlay.canvas.width = 1920;
    expect(() => readConfiguredGpu(viewport)).toThrow(/found 2/);
    overlay.canvas.isConnected = false;
    expect(readConfiguredGpu(viewport).adapter).toEqual(actual.adapterInfo);
    vi.stubGlobal("getComputedStyle", () => ({
      display: "none",
      visibility: "visible",
      opacity: "1",
    }));
    expect(() => readConfiguredGpu(viewport)).toThrow(/found 0/);
    vi.stubGlobal("getComputedStyle", () => ({
      display: "block",
      visibility: "visible",
      opacity: "1",
    }));
    context.canvas.getBoundingClientRect = () => ({
      width: 1920,
      height: 1080,
      left: 1920,
      top: 0,
      right: 3840,
      bottom: 1080,
    });
    expect(() => readConfiguredGpu(viewport)).toThrow(/found 0/);
  });

  it("keeps successful configure returns when capture fails and rejects missing identity", () => {
    const { context, actual, viewport, configure } = gpuHarness();
    const configuration = {
      get device(): typeof actual {
        throw new Error("capture failed");
      },
    };
    // The original method succeeds without inspecting diagnostic metadata.
    configure.mockImplementation(() => context);
    expect(context.configure(configuration)).toBe(context);
    expect(() => readConfiguredGpu(viewport)).toThrow(/capture is unavailable/);
    const fresh = gpuHarness();
    fresh.context.configure({ device: { adapterInfo: {} } } as never);
    expect(() => readConfiguredGpu(fresh.viewport)).toThrow(/identity is unavailable/);
  });

  it("preserves CPU defaults and validates live options", () => {
    expect(parseArgs([])).toMatchObject({ live: false, seconds: 5 });
    expect(parseArgs(["--live"])).toMatchObject({
      live: true,
      seconds: 30,
      minFrames: 1000,
      settle: 2,
      timeout: 180,
      viewport: { width: 1920, height: 1080 },
    });
    expect(parseArgs(["--live", "--viewport", "800x600", "--min-frames", "1200"])).toMatchObject({
      viewport: { width: 800, height: 600 },
      minFrames: 1200,
    });
    for (const args of [
      ["--seconds", "29"],
      ["--min-frames", "999"],
      ["--min-frames", "1000.5"],
      ["--viewport", "0x10"],
      ["--viewport", "1.5x20"],
      ["--settle", "0"],
      ["--timeout", "Infinity"],
      ["--timeout"],
    ])
      expect(() => parseArgs(["--live", ...args])).toThrow();
  });

  function raf() {
    vi.useFakeTimers();
    let callback: FrameRequestCallback | undefined;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((next: FrameRequestCallback) => {
        callback = next;
        return 1;
      }),
    );
    const cancel = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancel);
    return { tick: (timestamp: number) => callback?.(timestamp), cancel };
  }

  it("anchors the first RAF, ignores duplicate timestamps and requires both minimums", async () => {
    const { tick } = raf();
    const measured = collectRafCadence({ durationMs: 30_000, minFrames: 1000, timeoutMs: 180_000 });
    tick(0);
    for (let i = 1; i <= 1000; i++) {
      tick(i);
      tick(i);
    }
    let complete = false;
    void measured.then(() => {
      complete = true;
    });
    await Promise.resolve();
    expect(complete).toBe(false);
    tick(30_000);
    const result = await measured;
    expect(result.deltas).toHaveLength(1001);
    expect(result.deltas.slice(0, 1000)).toEqual(Array(1000).fill(1));

    const second = collectRafCadence({ durationMs: 30_000, minFrames: 1000, timeoutMs: 180_000 });
    tick(0);
    tick(30_000);
    let secondComplete = false;
    void second.then(() => {
      secondComplete = true;
    });
    await Promise.resolve();
    expect(secondComplete).toBe(false);
    for (let i = 1; i < 1000; i++) tick(30_000 + i);
    expect((await second).deltas).toHaveLength(1000);
  });

  it("fails on timeout and nonfinite timestamps", async () => {
    const { tick, cancel } = raf();
    const measured = collectRafCadence({ durationMs: 30_000, minFrames: 1000, timeoutMs: 10 });
    const failure = expect(measured).rejects.toThrow(/timed out/);
    tick(0);
    tick(1);
    await vi.advanceTimersByTimeAsync(10);
    await failure;
    expect(cancel).toHaveBeenCalled();
    const malformed = collectRafCadence({ durationMs: 30_000, minFrames: 1000, timeoutMs: 10 });
    tick(Number.NaN);
    await expect(malformed).rejects.toThrow(/finite/);
  });

  function mockPage(
    measurement: () => unknown,
    readiness = { ready: true, startup: { phase: "ready", compileSettled: true } },
  ) {
    const pose = {
      clock: { mode: "wall-clock" },
      entities: [{ id: "player", transform: { position: { x: 0, y: 0, z: 0 } } }],
    };
    const calls: string[] = [];
    const keyboard = {
      down: vi.fn(async () => {
        calls.push("down");
      }),
      up: vi.fn(async () => {
        calls.push("up");
      }),
    };
    const page = {
      on: vi.fn(),
      addInitScript: vi.fn(async () => {}),
      goto: vi.fn(async () => {}),
      waitForFunction: vi.fn(async () => {}),
      waitForTimeout: vi.fn(async () => {}),
      keyboard,
      evaluate: vi.fn(async (fn: unknown, argument?: { method?: string }) => {
        if (argument?.method === "ready") {
          calls.push("ready");
          return readiness;
        }
        if (argument?.method === "sample") {
          calls.push("sample");
          return pose;
        }
        if (fn === collectRafCadence) {
          calls.push("measure");
          return measurement();
        }
        if (fn === readConfiguredGpu)
          return {
            adapter: { architecture: "turing", description: "RTX", device: "1", vendor: "nvidia" },
            gpuAvailable: true,
          };
        throw new Error("Unexpected page evaluation");
      }),
    };
    return { page: page as unknown as Page, calls, keyboard };
  }

  it("takes only boundary snapshots and releases normal keyboard input", async () => {
    const { page, calls, keyboard } = mockPage(() => ({
      deltas: Array(1000).fill(30),
      startedAt: 100,
      endedAt: 30_100,
    }));
    const result = await profileLive(page, "http://localhost", parseArgs(["--live"]));
    expect(result.live).toMatchObject({ metric: "RAF cadence", startedAt: 100, endedAt: 30_100 });
    expect(result.live?.intervalsMs).toEqual(Array(1000).fill(30));
    expect(calls).toEqual(["ready", "sample", "ready", "down", "measure", "up", "sample", "up"]);
    expect(keyboard.up).toHaveBeenCalledWith("ArrowUp");
    expect(result.cpuHotspots).toEqual([]);
    expect(page.addInitScript).toHaveBeenCalledWith(
      expect.any(Function),
      "__THREENATIVE_PLAYTEST_CLOCK__",
    );
    expect(page.addInitScript).toHaveBeenCalledWith(captureConfiguredGpu);
    expect(vi.mocked(page.addInitScript).mock.invocationCallOrder.at(-1)).toBeLessThan(
      vi.mocked(page.goto).mock.invocationCallOrder[0] as number,
    );
  });

  it("releases input when measurement fails", async () => {
    const { page, keyboard } = mockPage(() => {
      throw new Error("measurement failed");
    });
    await expect(profileLive(page, "http://localhost", parseArgs(["--live"]))).rejects.toThrow(
      "measurement failed",
    );
    expect(keyboard.up).toHaveBeenCalledWith("ArrowUp");
  });

  it("bounds the whole live window and releases input on timeout", async () => {
    vi.useFakeTimers();
    const { page, keyboard } = mockPage(() => new Promise(() => {}));
    const measured = profileLive(page, "http://localhost", parseArgs(["--live", "--timeout", "1"]));
    const failure = expect(measured).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await failure;
    expect(keyboard.up).toHaveBeenCalledWith("ArrowUp");
  });

  it("fails closed when the bridge is missing", async () => {
    const { page, keyboard } = mockPage(() => {});
    vi.mocked(page.waitForFunction).mockRejectedValue(new Error("missing"));
    await expect(profileLive(page, "http://localhost", parseArgs(["--live"]))).rejects.toThrow(
      /bridge is missing/,
    );
    expect(keyboard.down).not.toHaveBeenCalled();
    expect(keyboard.up).toHaveBeenCalledWith("ArrowUp");
  });

  it("fails closed when compile readiness is absent or regresses", async () => {
    const missing = mockPage(() => {}, {
      ready: true,
      startup: { phase: "ready", compileSettled: undefined as unknown as boolean },
    });
    await expect(
      profileLive(missing.page, "http://localhost", parseArgs(["--live"])),
    ).rejects.toThrow(/readiness or compileSettled/);
    const changed = mockPage(() => {});
    let reads = 0;
    const original = vi.mocked(changed.page.evaluate).getMockImplementation();
    vi.mocked(changed.page.evaluate).mockImplementation(async (fn, arg) => {
      if ((arg as { method?: string })?.method === "ready" && ++reads === 2)
        return { ready: true, startup: { phase: "observing", compileSettled: false } };
      return original?.(fn, arg);
    });
    await expect(
      profileLive(changed.page, "http://localhost", parseArgs(["--live"])),
    ).rejects.toThrow(/changed/);
  });
});
