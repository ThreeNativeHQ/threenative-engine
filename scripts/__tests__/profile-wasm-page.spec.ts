import { afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ load: 2, memory: {} as Record<string, unknown> }));
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
        context: () => ({
          newCDPSession: async () => ({
            send: async (method: string) =>
              method === "Profiler.stop" ? { profile: { nodes: [], samples: [] } } : {},
          }),
        }),
        evaluate: async (fn: () => unknown) => {
          if (fn.toString().includes("requestAdapter")) return "hardware";
          if (fn.toString().includes("requestAnimationFrame"))
            return { p50: 10, p95: 12, fps: 100 };
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
const { measure, options } = await import("../profile-wasm-page.js");
afterEach(() => {
  state.load = 2;
  state.memory = {};
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
