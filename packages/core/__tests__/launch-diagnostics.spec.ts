import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ILaunchFailure,
  onLaunchFailure,
  reloadAfterGpuMemoryLoss,
  reportLaunchFailure,
  resetLaunchFailures,
  routeGpuMemoryReload,
  watchDeviceLoss,
  watchStartupStall,
} from "../src/launch-diagnostics.js";
import { StartupReadiness } from "../src/startup-readiness.js";

/** A hand-driven clock and interval, so a 20-second stall costs the test nothing. */
function fakeScheduler() {
  let clock = 0;
  const callbacks = new Map<number, { callback: () => void; ms: number }>();
  let next = 1;
  return {
    advance(ms: number): void {
      clock += ms;
      for (const entry of [...callbacks.values()]) entry.callback();
    },
    clearInterval: (handle: unknown) => callbacks.delete(handle as number),
    now: () => clock,
    pending: () => callbacks.size,
    setInterval: (callback: () => void, ms: number) => {
      const handle = next++;
      callbacks.set(handle, { callback, ms });
      return handle;
    },
  };
}

describe("launch diagnostics", () => {
  beforeEach(() => {
    resetLaunchFailures();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("observes completed held work while the displayed percentage stays fixed, then detects a real stall", async () => {
    const scheduler = fakeScheduler();
    const readiness = new StartupReadiness();
    let completed = 0;
    let release = () => {};
    readiness.hold(
      "strata-spawn",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
      120_000,
      () => completed,
    );
    const failures: ILaunchFailure[] = [];
    const off = onLaunchFailure((failure) => failures.push(failure));
    const stop = watchStartupStall({
      clearInterval: scheduler.clearInterval,
      now: scheduler.now,
      pending: () => readiness.pendingHolds,
      progress: () => 0.95,
      workProgress: () => readiness.workProgress,
      setInterval: scheduler.setInterval,
      stallMs: 45_000,
    });
    try {
      for (let slice = 0; slice < 5; slice += 1) {
        completed += 401;
        scheduler.advance(20_000);
      }
      expect(failures).toEqual([]);
      scheduler.advance(44_999);
      expect(failures).toEqual([]);
      scheduler.advance(1);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.message).toContain("strata-spawn");
      expect(failures[0]?.message).toContain("45s");
    } finally {
      stop();
      off();
      release();
      await Promise.resolve();
    }
  });

  it("reports a launch whose progress stops moving, naming what it is still waiting for", () => {
    const scheduler = fakeScheduler();
    const failures: ILaunchFailure[] = [];
    const off = onLaunchFailure((failure) => failures.push(failure));
    let progress = 0.4;
    watchStartupStall({
      clearInterval: scheduler.clearInterval,
      pending: () => ["/assets/akagi.glb", "/assets/hornet.glb"],
      now: scheduler.now,
      progress: () => progress,
      setInterval: scheduler.setInterval,
      stallMs: 20_000,
    });

    // Moving progress is never a stall, however long the launch runs.
    for (let i = 0; i < 10; i += 1) {
      progress += 0.01;
      scheduler.advance(19_000);
    }
    expect(failures).toEqual([]);

    scheduler.advance(21_000);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe("stalled");
    expect(failures[0]?.message).toContain("/assets/akagi.glb");
    expect(failures[0]?.message).toContain("50.0%");
    off();
  });

  it("stops watching once the launch is ready, and reports each failure once", () => {
    const scheduler = fakeScheduler();
    const failures: ILaunchFailure[] = [];
    const off = onLaunchFailure((failure) => failures.push(failure));
    const stop = watchStartupStall({
      clearInterval: scheduler.clearInterval,
      pending: () => [],
      now: scheduler.now,
      progress: () => 0.9,
      setInterval: scheduler.setInterval,
      stallMs: 20_000,
    });
    stop();
    expect(scheduler.pending()).toBe(0);
    scheduler.advance(120_000);
    expect(failures).toEqual([]);

    reportLaunchFailure({ kind: "stalled", message: "first" });
    reportLaunchFailure({ kind: "stalled", message: "second" });
    expect(failures).toHaveLength(1);
    off();
  });

  it("fails closed on a nonsensical stall budget rather than watching nothing", () => {
    expect(() => watchStartupStall({ pending: () => [], progress: () => 0, stallMs: 0 })).toThrow(
      /TN_STARTUP_STALL_MS_INVALID/u,
    );
  });

  it("reports a lost device, and stays quiet when the game destroyed it", async () => {
    const failures: ILaunchFailure[] = [];
    const off = onLaunchFailure((failure) => failures.push(failure));
    watchDeviceLoss({
      lost: Promise.resolve({ message: "vkQueueSubmit failed", reason: "unknown" }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("vkQueueSubmit failed");

    resetLaunchFailures();
    failures.length = 0;
    watchDeviceLoss({ lost: Promise.resolve({ message: "bye", reason: "destroyed" }) }, () => true);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);

    // Headless Chromium on SwiftShader destroys the device at the first present while the game runs:
    // `destroyed` is the game's own shutdown only when the game shut down.
    resetLaunchFailures();
    watchDeviceLoss(
      { lost: Promise.resolve({ message: "Device was destroyed.", reason: "destroyed" }) },
      () => false,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
    expect(failures[0]?.message).toContain("(destroyed): Device was destroyed.");
    failures.length = 0;
    watchDeviceLoss(undefined);

    // A host stub that settles its own placeholder promise carries neither reason nor message.
    // Reporting that fired on every desktop launch before this guard existed.
    resetLaunchFailures();
    failures.length = 0;
    watchDeviceLoss({ lost: Promise.resolve({}) });
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toEqual([]);
    off();
  });
});

describe("the reload after the GPU ran out of memory", () => {
  const oom = "TN_WASM_DEVICE_ERROR: vkAllocateMemory failed with VK_ERROR_OUT_OF_DEVICE_MEMORY";

  /** A page: `location.reload` and a tab's `sessionStorage`, both stubbed on globalThis. */
  function page() {
    const stored = new Map<string, string>();
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    return { reload, stored };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    resetLaunchFailures();
    routeGpuMemoryReload(undefined);
    return () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    };
  });

  it("reloads a page once per tab after a lost device names GPU memory, never in a loop", async () => {
    const { reload } = page();
    watchDeviceLoss({ lost: Promise.resolve({ message: oom, reason: "unknown" }) });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
    // The reloaded page ran out again: the tab remembers, and the page stays to show the failure.
    expect(reloadAfterGpuMemoryLoss(oom)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload for any other loss, with the override, or where there is no page", async () => {
    const { reload } = page();
    watchDeviceLoss({
      lost: Promise.resolve({ message: "vkQueueSubmit failed", reason: "unknown" }),
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(reloadAfterGpuMemoryLoss(oom, false)).toBe(false);
    expect(String(vi.mocked(console.warn).mock.calls.at(-1)?.[0])).toContain(
      "reloadOnGpuMemoryLoss: false",
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(reload).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    expect(reloadAfterGpuMemoryLoss(oom)).toBe(false);
  });

  it("sends a worker's reload to its page, which owns the guard", () => {
    const route = vi.fn();
    routeGpuMemoryReload(route);
    expect(reloadAfterGpuMemoryLoss(oom)).toBe(true);
    expect(route).toHaveBeenCalledWith(oom);
  });
});
