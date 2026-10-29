import { afterEach, describe, expect, it, vi } from "vitest";
import { WARMUP_FRAMES, WINDOW_FRAMES, createBridgeMeter } from "../src/bridge-meter.js";
import { DebugTelemetry, debugRequested } from "../src/debug-telemetry.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("web engine debug telemetry", () => {
  it("accepts the three launch seams and stays off by default", () => {
    vi.stubEnv("TN_DEBUG", "0");
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("__THREENATIVE_DEBUG__", false);
    expect(debugRequested()).toBe(false);
    vi.stubEnv("TN_DEBUG", "1");
    expect(debugRequested()).toBe(true);
    vi.stubEnv("TN_DEBUG", "0");
    vi.stubGlobal("location", { search: "?tnDebug=1" });
    expect(debugRequested()).toBe(true);
    vi.stubGlobal("location", { search: "?tnDebug=0" });
    vi.stubGlobal("__THREENATIVE_DEBUG__", true);
    expect(debugRequested()).toBe(true);
  });

  it("flags 995 distinct crossings even with no redundant reads and debug off", () => {
    vi.stubEnv("TN_DEBUG", "0");
    let now = 0;
    const lines: string[] = [];
    const stack = vi.fn(
      () =>
        "Error\n at stack (/engine/meter.ts:1)\n at record (/engine/bridge.ts:2)\n at army.sync (/game/army.ts:42)",
    );
    const meter = createBridgeMeter({
      now: () => now,
      crossingMicros: () => 1,
      typeName: () => "InstancedMesh",
      stack,
      report: (line) => lines.push(line),
    });
    for (let f = 0; f <= WARMUP_FRAMES + WINDOW_FRAMES; f++) {
      meter.frame();
      for (let i = 0; i < 995; i++)
        meter.record(
          i < 208 ? "get" : "call",
          { key: String(i), type: 1 },
          i < 208 ? "count" : "setMatrixAt",
        );
      now += 16;
    }
    const warning = lines.find((line) => line.startsWith("TN_BRIDGE_WARNING:"));
    expect(warning).toBeDefined();
    expect(stack).not.toHaveBeenCalled();
    expect(JSON.parse((warning ?? "").slice("TN_BRIDGE_WARNING:".length))).toMatchObject({
      crossings: 995,
      redundantReads: 0,
      top: [{ name: "call InstancedMesh.setMatrixAt", caller: "unknown" }, expect.anything()],
    });
  });

  it("retains bounded callers and invalidates repeated reads across writes and frames", () => {
    const debug = new DebugTelemetry();
    const self = { key: "one", type: 1 };
    debug.crossing("get", self, "count", "InstancedMesh");
    debug.crossing("get", self, "count", "InstancedMesh");
    debug.crossing("set", self, "count", "InstancedMesh");
    debug.crossing("get", self, "count", "InstancedMesh");
    debug.frame();
    debug.crossing("get", self, "count", "InstancedMesh");
    for (let i = 0; i < 995; i++) debug.crossing("call", self, `setMatrixAt${i}`, "InstancedMesh");
    expect(debug.totals).toMatchObject({
      bridgeCrossings: 1000,
      bridgeRedundantReads: 1,
      bridgeGetCrossings: 4,
      bridgeCallCrossings: 995,
    });
    const sources =
      (globalThis as { __tnDebugSources?: Record<string, { caller: string }> }).__tnDebugSources ??
      {};
    expect(sources["bridge:get InstancedMesh.count"]?.caller).toContain("debug-telemetry.spec");
    expect(Object.keys(debug.totals).filter((name) => name.startsWith("bridge:"))).toHaveLength(
      997,
    );
  });

  it("fails closed on malformed numeric observations", () => {
    const debug = new DebugTelemetry();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1])
      expect(() => debug.add("bad", value)).toThrow(/TN_DEBUG/);
  });
});
