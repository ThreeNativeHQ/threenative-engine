import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  load: 2,
  memory: {} as Record<string, unknown>,
  presented: [0, 0] as number[],
  thread: [1, 1.002] as number[],
  clicks: [] as string[],
  workers: [] as { evaluate(fn: (() => unknown) | string): Promise<unknown> }[],
}));
vi.mock("node:os", () => ({
  default: { availableParallelism: () => 8, loadavg: () => [state.load, 0, 0] },
}));
vi.mock("@playwright/test", () => ({
  chromium: {
    launch: async () => ({
      newPage: async () => ({
        on: vi.fn(),
        addInitScript: vi.fn(),
        goto: vi.fn(),
        waitForTimeout: vi.fn(),
        click: async (selector: string) => {
          state.clicks.push(selector);
        },
        workers: () => state.workers,
        context: () => ({
          newCDPSession: async () => ({
            send: async (method: string) =>
              method === "Performance.getMetrics"
                ? // the thread's CPU seconds: 2 ms more at the second read
                  { metrics: [{ name: "ThreadTime", value: state.thread.shift() ?? 0 }] }
                : method === "Profiler.stop"
                  ? {
                      // 1 ms busy in `work`, 3 ms in `(idle)`: a quarter of the window is CPU work.
                      profile: {
                        nodes: [
                          { id: 1, callFrame: { functionName: "(idle)", url: "" } },
                          { id: 2, callFrame: { functionName: "work", url: "" } },
                        ],
                        samples: [1, 2, 1, 1],
                        timeDeltas: [1000, 1000, 1000, 1000],
                      },
                    }
                  : {},
          }),
        }),
        evaluate: async (fn: (() => unknown) | string) => {
          if (typeof fn === "string") return state.presented.shift() ?? 0;
          if (fn.toString().includes("requestAdapter")) return "hardware";
          if (fn.toString().includes("requestAnimationFrame"))
            return Array.from({ length: 600 }, (_, i) => (i === 599 ? 40 : 10));
          vi.stubGlobal("performance", {
            memory: { usedJSHeapSize: state.memory.jsHeapUsedBytes },
          });
          vi.stubGlobal(
            "__tnWasmMemoryBytes",
            state.memory.wasmMemoryBytes === undefined
              ? undefined
              : () => state.memory.wasmMemoryBytes,
          );
          return fn();
        },
      }),
      close: vi.fn(),
    }),
  },
}));

// Importing the command must not launch a profile.
const { cpuWork, frameStats, measure, options, startCpuLoad } = await import(
  "../profile-wasm-page.js"
);
afterEach(() => {
  state.load = 2;
  state.memory = {};
  state.presented = [0, 0];
  state.thread = [1, 1.002];
  state.clicks = [];
  state.workers = [];
  vi.unstubAllGlobals();
});
describe("profile:wasm-page scorecard", () => {
  it.each([
    [2, "valid"],
    [4, "valid"],
    [5, "invalid-absolute"],
  ])("stamps load %s on eight cores as %s", async (load, absolutes) => {
    state.load = Number(load);
    const run = await measure("http://test", options(["--url", "http://test"]));
    expect(run.hostLoad).toEqual({ cores: 8, load1: load, absolutes });
  });
  it("reports both memory observations only with --memory", async () => {
    state.memory = { wasmMemoryBytes: 65536, jsHeapUsedBytes: 1234 };
    expect(options(["--url", "http://test", "--memory"]).memory).toBe(true);
    expect(
      (await measure("http://test", options(["--url", "http://test", "--memory"]))).memory,
    ).toEqual(state.memory);
    expect(
      (await measure("http://test", options(["--url", "http://test"]))).memory,
    ).toBeUndefined();
  });
  it("reads frame times on the game's own thread: the page, or the worker that runs it (PRD-752)", async () => {
    const page = await measure("http://test", options(["--url", "http://test"]));
    expect(page.gameThread).toBe("page");
    expect(page.frame.p50).toBe(10);
    // An idle helper worker, then the worker holding the game's platform source.
    const idle = { evaluate: async () => "undefined" };
    const game = {
      evaluate: async (fn: (() => unknown) | string) =>
        typeof fn === "string" ? "object" : Array.from({ length: 600 }, () => 20),
    };
    state.workers = [idle, game];
    const worker = await measure("http://test", options(["--url", "http://test"]));
    expect(worker.gameThread).toBe("worker");
    expect(worker.frame.p50).toBe(20);
  });
  it.each(["wasmMemoryBytes", "jsHeapUsedBytes"])(
    "fails closed when %s is unavailable",
    async (field) => {
      for (const bad of [undefined, null, -1, Number.NaN, "missing"]) {
        state.memory = { wasmMemoryBytes: 65536, jsHeapUsedBytes: 1234, [field]: bad };
        await expect(
          measure("http://test", options(["--url", "http://test", "--memory"])),
        ).rejects.toThrow(new RegExp(`TN_PROFILE_MEMORY_MISSING.*${field}`));
      }
    },
  );
});

describe("profile:wasm-page startup, input and CPU work", () => {
  it("counts busy main-thread time per presented frame, from the profile and not the frame cap", () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: "(idle)", url: "" } },
        { id: 2, callFrame: { functionName: "work", url: "" } },
      ],
      samples: [1, 2, 2, 1],
      timeDeltas: [1000, 1000, 1000, 1000],
    };
    expect(cpuWork(profile, 2)).toEqual({
      busyMsPerFrame: 1,
      busyPercent: 50,
      frames: 2,
      wallMs: 4,
    });
    expect(() => cpuWork(profile, 0)).toThrow("TN_PROFILE_CPU_WORK_NO_FRAMES");
    expect(() => cpuWork({ ...profile, timeDeltas: [1] }, 2)).toThrow("TN_PROFILE_CPU_WORK_DELTAS");
  });

  it("counts absolute long frames beside the relative hitches, so a fast run is not judged against its own median", () => {
    // 446 fps: p50 1.8 ms makes every 4 ms frame a relative hitch, yet no frame is anywhere near a 60 Hz budget.
    const fast = frameStats([
      ...Array.from({ length: 90 }, () => 1.8),
      ...Array.from({ length: 10 }, () => 4.5),
    ]);
    expect(fast).toMatchObject({ hitches: 10, over16ms: 0, over33ms: 0, maxMs: 4.5 });
    const slow = frameStats([...Array.from({ length: 97 }, () => 5), 17, 34, 60]);
    expect(slow).toMatchObject({ over16ms: 3, over33ms: 2, maxMs: 60 });
  });

  it("reports percentiles and counts a hitch as an interval over twice the median", () => {
    const stats = frameStats([...Array.from({ length: 98 }, () => 10), 25, 40]);
    expect(stats).toMatchObject({ p50: 10, p99: 40, hitches: 2 });
    expect(() => frameStats([])).toThrow("TN_PROFILE_NO_FRAMES");
  });

  it("parses repeated --click selectors and refuses one with no selector", () => {
    expect(options(["--url", "u", "--click", "#a", "--click", "#b", "--cpu-work"])).toMatchObject({
      clicks: ["#a", "#b"],
      cpuWork: true,
    });
    expect(() => options(["--url", "u", "--click"])).toThrow("--click needs a selector");
    expect(() => options(["--url", "u", "--click", "--json"])).toThrow("--click needs a selector");
  });

  it("parses --save-profile as the directory for the raw .cpuprofile files", () => {
    expect(options(["--url", "u", "--save-profile", "/tmp/p"])).toMatchObject({
      saveProfile: "/tmp/p",
    });
    expect(options(["--url", "u"]).saveProfile).toBeUndefined();
  });

  it("parses --load as a count of busy processes and refuses a bad count", () => {
    expect(options(["--url", "u", "--load", "6"]).load).toBe(6);
    expect(options(["--url", "u"]).load).toBe(0);
    for (const bad of ["-1", "1.5", "x"])
      expect(() => options(["--url", "u", "--load", bad])).toThrow("--load");
  });

  it("starts the busy processes, keeps them alive and stops them", async () => {
    const load = startCpuLoad(2);
    expect(load.pids).toHaveLength(2);
    for (const pid of load.pids) expect(() => process.kill(pid, 0)).not.toThrow();
    await load.stop();
    for (const pid of load.pids) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stamps the stated load on the run", async () => {
    const run = await measure("http://test", options(["--url", "http://test", "--load", "1"]));
    expect(run.cpuLoad).toEqual({ processes: 1 });
  });

  it("clicks in order before the warm-up, stamps startup, and reports CPU work per frame", async () => {
    state.presented = [100, 140];
    const run = await measure(
      "http://test",
      options(["--url", "http://test", "--click", "#start-deck", "--click", "#go", "--cpu-work"]),
    );
    expect(state.clicks).toEqual(["#start-deck", "#go"]);
    expect(run.startupMs).toBeGreaterThanOrEqual(0);
    // 1 ms of work in a 4 ms window over 40 presented frames; the thread spent 2 ms of CPU in them.
    expect(run.profile.work).toMatchObject({ busyMsPerFrame: 1 / 40, frames: 40, wallMs: 4 });
    expect(run.profile.work?.threadMsPerFrame).toBeCloseTo(2 / 40, 6);
    expect(run.frame).toMatchObject({ p50: 10, hitches: 1 });
  });
});
