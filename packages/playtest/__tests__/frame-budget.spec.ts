import { describe, expect, it } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import { validatePlaytestScenario } from "../src/scenario.js";
import type { IPlaytestCaptureProvenance, IPlaytestReport } from "../src/report.js";

const RTX_2080 = { architecture: "turing", description: "NVIDIA", device: "NVIDIA GeForce RTX 2080", vendor: "nvidia" };
const INTEL_UHD = { architecture: "gen-12lp", description: "Intel(R) UHD Graphics 770", device: "", vendor: "intel" };
const SWIFTSHADER = { architecture: "swiftshader", vendor: "google" };

/** 30 fps: every frame 33.3 ms, the rate the owner saw on an RTX 2080 while the kits passed. */
const THIRTY_FPS = Array.from({ length: 60 }, () => ({ drawCalls: 100, frameMs: 33.3 }));
const SIXTY_FPS = Array.from({ length: 60 }, (_, index) => ({ drawCalls: 100, frameMs: index % 10 === 0 ? 18 : 16.7 }));

function evaluate(performance: Record<string, unknown>, series: unknown[], adapter?: Record<string, string>) {
  const scenario = validatePlaytestScenario(
    { assert: { performance }, name: "budget", schemaVersion: 1, steps: [{ release: true, waitFrames: 2 }] },
    "budget.json",
  );
  const capture: IPlaytestCaptureProvenance | undefined = adapter === undefined
    ? undefined
    : { adapter, browserArgs: [], captureMethod: "page.screenshot", rendererKind: "webgpu", target: "browser", viewport: { height: 720, width: 1280 } };
  const report: IPlaytestReport = {
    ...(capture === undefined ? {} : { capture }),
    diagnostics: [],
    distance: 0,
    entity: "",
    expectMoved: false,
    frames: series.length,
    observations: { console: [], hud: {}, network: [], performanceSeries: series, resources: {} },
    trivialityOptOuts: [],
  };
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  const byId = (id: string) => assertions.find((result) => result.id === id);
  return { budget: (byId("performance.samples")?.details as { frameBudget?: unknown } | undefined)?.frameBudget, codes: diagnostics.map(({ code }) => code), frame: byId("performance.maxFrameMsP95") };
}

describe("frame budget from the adapter", () => {
  it("fails 30 fps on a discrete desktop GPU when the scenario names no budget", () => {
    const { budget, codes, frame } = evaluate({ maxDrawCalls: 600 }, THIRTY_FPS, RTX_2080);
    expect(budget).toMatchObject({ gpuFamily: "discrete", maxFrameMsP95: 20, source: "adapter" });
    expect(frame?.pass).toBe(false);
    expect(codes).toContain("TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED");
  });

  it("passes a held 60 fps on the same GPU", () => {
    const { frame } = evaluate({ maxDrawCalls: 600 }, SIXTY_FPS, RTX_2080);
    expect(frame?.pass).toBe(true);
  });

  it("holds an integrated GPU to a 30 Hz frame", () => {
    const { budget, frame } = evaluate({ maxDrawCalls: 600 }, THIRTY_FPS, INTEL_UHD);
    expect(budget).toMatchObject({ gpuFamily: "integrated", maxFrameMsP95: 40 });
    expect(frame?.pass).toBe(true);
  });

  it("reports an explicit number as the scenario's override", () => {
    const { budget, frame } = evaluate({ maxFrameMsP95: 34 }, THIRTY_FPS, RTX_2080);
    expect(budget).toMatchObject({ maxFrameMsP95: 34, source: "scenario" });
    expect(frame?.pass).toBe(true);
  });

  it.each([
    ["a software adapter", SWIFTSHADER, /software adapter swiftshader/u],
    ["no adapter", undefined, /named no adapter/u],
  ])("names why no budget applies on %s", (_name, adapter, reason) => {
    const { budget, codes, frame } = evaluate({ maxDrawCalls: 600 }, THIRTY_FPS, adapter);
    expect(budget).toMatchObject({ source: "adapter" });
    expect((budget as { reason: string }).reason).toMatch(reason);
    expect(frame).toBeUndefined();
    expect(codes).toEqual([]);
  });
});
