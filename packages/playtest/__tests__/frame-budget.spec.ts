import { afterEach, describe, expect, it, vi } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import type { IPlaytestCaptureProvenance, IPlaytestReport } from "../src/report.js";

const RTX_2080 = { architecture: "turing", description: "NVIDIA", device: "NVIDIA GeForce RTX 2080", vendor: "nvidia" };
const INTEL_UHD = { architecture: "gen-12lp", description: "Intel(R) UHD Graphics 770", device: "", vendor: "intel" };
const SWIFTSHADER = { architecture: "swiftshader", vendor: "google" };

/** `count` frames that arrived `interval` ms apart and cost `cost` ms of update plus render. */
function frames(interval: number, cost: number, count = 60) {
  return Array.from({ length: count }, () => ({
    drawCalls: 100,
    frameMs: interval,
    phases: { hostGap: Math.max(0, interval - cost), overlay: 0, render: cost * 0.9, residual: 0, ui: 0, update: cost * 0.1 },
  }));
}

/** The engine's own meter: one `TN_FRAME_BUDGET` window carrying a GPU p95 (or none). */
function meter(samples: number | undefined, ...windows: (number | null)[]) {
  return windows.map((gpuP95) => {
    const gpu = gpuP95 === null
      ? null
      : { max: gpuP95, mean: gpuP95, p50: gpuP95, p95: gpuP95, p99: gpuP95, ...(samples === undefined ? {} : { samples }) };
    return { level: "log", text: `TN_FRAME_BUDGET:${JSON.stringify({ fps: 60, frame: { p95: 3 }, gpu, gpuMs: gpuP95 })}` };
  });
}

function evaluate(
  performance: Record<string, unknown>,
  series: unknown[],
  adapter?: Record<string, string>,
  gpuP95: number | null | (number | null)[] = 4,
  gpuSamples: number | null = 8,
) {
  const scenario = validatePlaytestScenario(
    { assert: { performance }, name: "budget", schemaVersion: 1, steps: [{ release: true, waitFrames: 2 }] },
    "budget.json",
  );
  const capture: IPlaytestCaptureProvenance | undefined = adapter === undefined
    ? undefined
    : { adapter, browserArgs: [], captureMethod: "page.screenshot", rendererKind: "webgpu", target: "browser", viewport: { height: 720, width: 1280 } };
  const report = {
    ...(capture === undefined ? {} : { capture }),
    diagnostics: [],
    distance: 0,
    entity: "",
    expectMoved: false,
    frames: series.length,
    observations: { console: meter(gpuSamples ?? undefined, ...(Array.isArray(gpuP95) ? gpuP95 : [gpuP95])), hud: {}, network: [], performanceSeries: series, resources: {} },
    trivialityOptOuts: [],
  } as unknown as IPlaytestReport;
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  const byId = (id: string) => assertions.find((result) => result.id === id);
  return {
    budget: (byId("performance.samples")?.details as { frameBudget?: unknown } | undefined)?.frameBudget,
    codes: diagnostics.map(({ code }) => code),
    frame: byId("performance.maxFrameMsP95"),
    messages: diagnostics.map(({ message }) => message),
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("frame budget from the adapter", () => {
  it("fails 30 fps on a discrete desktop GPU when the scenario names no budget", () => {
    const { budget, codes, frame } = evaluate({ maxDrawCalls: 600 }, frames(33.3, 33), RTX_2080, 33);
    expect(budget).toMatchObject({ gpuFamily: "discrete", maxFrameMsP95: 16.7, source: "adapter" });
    expect(frame?.pass).toBe(false);
    expect(codes).toContain("TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED");
  });

  it("passes a held 60 fps on the same GPU", () => {
    const { frame } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 4), RTX_2080, 5);
    expect(frame?.pass).toBe(true);
  });

  it("holds an integrated GPU to the same 16.7 ms, not a 30 Hz frame", () => {
    const { budget, frame } = evaluate({ maxDrawCalls: 600 }, frames(33.3, 33), INTEL_UHD, 33);
    expect(budget).toMatchObject({ gpuFamily: "integrated", maxFrameMsP95: 16.7 });
    expect(frame?.pass).toBe(false);
  });

  it("applies 16.7 ms when the run named no adapter", () => {
    const { budget, frame } = evaluate({ maxDrawCalls: 600 }, frames(33.3, 33), undefined, 33);
    expect(budget).toMatchObject({ maxFrameMsP95: 16.7, source: "adapter" });
    expect(frame?.pass).toBe(false);
  });

  it("reports a looser scenario number with its written reason", () => {
    const { budget, frame } = evaluate({ maxFrameMsP95: 34, maxFrameMsReason: "30 fps puzzle on a shared CI adapter" }, frames(33.3, 33), RTX_2080, 33);
    expect(budget).toMatchObject({ maxFrameMsP95: 34, source: "scenario" });
    expect((budget as { reason: string }).reason).toContain("30 fps puzzle on a shared CI adapter");
    expect(frame?.pass).toBe(true);
  });

  it("refuses a looser number without a reason at load", () => {
    expect(() => evaluate({ maxFrameMsP95: 33 }, frames(33.3, 33), RTX_2080)).toThrow(/maxFrameMsReason/u);
    expect(() => evaluate({ maxFrameMsP95: 33, maxFrameMsReason: "  " }, frames(33.3, 33), RTX_2080)).toThrow(/maxFrameMsReason/u);
  });

  it("accepts a tighter number without a reason", () => {
    expect(() => evaluate({ maxFrameMsP95: 12 }, frames(16.7, 4), RTX_2080)).not.toThrow();
  });

  it("fails closed on a software adapter: unmeasurable", () => {
    const { budget, codes, frame } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 4), SWIFTSHADER);
    expect(budget).toMatchObject({ source: "adapter", unmeasurable: true });
    expect((budget as { reason: string }).reason).toMatch(/software adapter swiftshader is unmeasurable/u);
    expect(frame?.pass).toBe(false);
    expect(codes).toContain("TN_PLAYTEST_PERFORMANCE_UNMEASURABLE");
  });
});

describe("frame bound by display", () => {
  it("passes on a virtual display when the interval is 18 ms but the cost is 3 ms, and says the interval is not gated", () => {
    const { frame } = evaluate({ maxDrawCalls: 600 }, frames(18, 3), RTX_2080, 3);
    expect(frame?.pass).toBe(true);
    expect(frame?.details).toMatchObject({
      display: "virtual",
      interval: { gated: false, p95: 18, reason: expect.stringContaining("display cadence, not gated") },
    });
  });

  it("fails on a virtual display when the cost is 18 ms, whatever the interval", () => {
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 18), RTX_2080, 3);
    expect(frame?.pass).toBe(false);
    expect(messages.join(" ")).toMatch(/cost p95 18/u);
  });

  it("fails on a virtual display when the GPU is the cost", () => {
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, 20);
    expect(frame?.pass).toBe(false);
    expect(messages.join(" ")).toMatch(/GPU 20/u);
  });

  it("fails on a real display when the interval is 18 ms, though the cost is 3 ms", () => {
    vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", "1");
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, frames(18, 3), RTX_2080, 3);
    expect(frame?.pass).toBe(false);
    expect(frame?.details).toMatchObject({ display: "real", interval: { gated: true, p95: 18 } });
    expect(messages.join(" ")).toMatch(/rAF interval p95 18/u);
  });

  it("passes on a real display when interval and cost both hold 16.7 ms", () => {
    vi.stubEnv("TN_PLAYTEST_HOST_DISPLAY", "1");
    expect(evaluate({ maxDrawCalls: 600 }, frames(16.7, 4), RTX_2080, 5).frame?.pass).toBe(true);
  });

  it("judges the latest GPU window, not the startup compile in the first", () => {
    expect(evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, [196, 6.4]).frame?.pass).toBe(true);
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, [4, 59]);
    expect(frame?.pass).toBe(false);
    expect(messages.join(" ")).toMatch(/GPU 59/u);
  });

  it("fails closed when the run measured no GPU time", () => {
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, null);
    expect(frame?.pass).toBe(false);
    expect(messages.join(" ")).toMatch(/did not measure .*GPU time/u);
  });

  it("fails closed with a named code when the judged GPU window holds one sample", () => {
    const { codes, frame, messages } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, 5, 1);
    expect(frame?.pass).toBe(false);
    expect(codes).toContain("TN_PLAYTEST_PERF_FEW_GPU_SAMPLES");
    expect(messages.join(" ")).toMatch(/1 GPU sample/u);
    expect(frame?.details).toMatchObject({ cost: { gpuSamples: 1 } });
  });

  it("holds the minimum at 3 samples and takes an unreported count as too few", () => {
    expect(evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, 5, 2).frame?.pass).toBe(false);
    expect(evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, 5, 3).frame?.pass).toBe(true);
    expect(evaluate({ maxDrawCalls: 600 }, frames(16.7, 3), RTX_2080, 5, null).codes).toContain("TN_PLAYTEST_PERF_FEW_GPU_SAMPLES");
  });

  it("still names a CPU cost over the ceiling when the GPU window is thin", () => {
    const { codes } = evaluate({ maxDrawCalls: 600 }, frames(16.7, 18), RTX_2080, 5, 1);
    expect(codes).toContain("TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED");
    expect(codes).not.toContain("TN_PLAYTEST_PERF_FEW_GPU_SAMPLES");
  });

  it("leaves an engine hitch frame out of the cost but counts any other frame without a split as unmeasured", () => {
    const hitch = { drawCalls: 100, frameMs: 3250 };
    const ok = frames(16.7, 3, 59);
    expect(evaluate({ maxDrawCalls: 600 }, [hitch, ...ok], RTX_2080, 3).frame).toMatchObject({ details: { cost: { hitchFrames: 1 } }, pass: true });
    const stray = { drawCalls: 100, frameMs: 16.7 };
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, [stray, ...ok], RTX_2080, 3);
    expect(frame?.pass).toBe(false);
    expect(messages.join(" ")).toMatch(/did not measure the CPU frame split/u);
  });

  it("fails closed when the samples carry no CPU frame split", () => {
    const bare = Array.from({ length: 60 }, () => ({ drawCalls: 100, frameMs: 16.7 }));
    const { frame, messages } = evaluate({ maxDrawCalls: 600 }, bare, RTX_2080, 3);
    expect(frame?.pass).toBe(false);
    expect(messages.join(" ")).toMatch(/did not measure the CPU frame split/u);
  });
});
