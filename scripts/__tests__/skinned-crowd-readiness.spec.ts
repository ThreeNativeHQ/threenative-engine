import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrameBudget, type IFrameBudgetWindow } from "../../packages/core/src/frame-budget.js";
import {
  type ISpanWindow,
  SPANS,
  SpanRecorder,
  formatSpansWindow,
} from "../../packages/core/src/profiling/Spans.js";
import { validatePlaytestScenario } from "../../packages/playtest/src/scenario.js";

vi.mock("@threenative/core", async () => ({
  ...(await import("../../packages/core/src/profiling/Spans.js")),
  Scene: class {},
  SkeletalMesh3D: class {},
  lodPixelScale: () => 1,
  spansRequested: () => true,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

// Real producers: 120 simulation ticks may contain fewer or more than 120 renders.
function completedWindows(frames: number, arm: string) {
  let tick = 0;
  const recorder = new SpanRecorder();
  const windows: { budget: IFrameBudgetWindow; spans: ISpanWindow }[] = [];
  const budget = new FrameBudget({
    reportEvery: 120,
    simulation: { tick: () => tick, step: 1 / 60 },
    report: () => {},
    onWindow: (window) => {
      const spans = recorder.window();
      if (spans === undefined) throw new Error("Missing span window");
      windows.push({ budget: window, spans });
    },
  });
  for (let window = 0; window < 3; window += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      const now = (window * frames + frame) * 16;
      budget.beginFrame(now, now);
      tick = window * 120 + Math.floor(((frame + 1) * 120) / frames);
      for (let rig = 0; rig < 128; rig += 1) {
        if (arm !== "static") recorder.add(SPANS.animationUpdate, 0.01);
        if (arm !== "static") recorder.add(SPANS.skinnedWrite, 0.005);
      }
      recorder.endFrame(4);
      budget.addRenderPasses([
        { kind: "main", draws: 3, triangles: 70659 },
        { kind: "shadow", draws: 1, triangles: 70656 },
      ]);
      budget.addGpuMs(0.2);
      budget.addGpuBucketMs({ main: 0.1, shadow: 0.1, shadowPasses: 1 });
      budget.endFrame(now + 4);
    }
  }
  budget.dispose();
  return windows;
}

async function fixture(arm = "animated") {
  vi.stubGlobal("location", { search: `?crowdCount=128&crowdArm=${arm}` });
  vi.spyOn(console, "info").mockImplementation(() => {});
  return import("../../examples/skinned-crowd/src/scenes/Crowd.js");
}

describe("skinned crowd measurement bridge", () => {
  it.each([30, 120, 258])(
    "accepts aligned completed windows with %i renders and latches the first receipt",
    async (frames) => {
      const { crowdBudget, crowdSpans, crowdRate } = await fixture();
      const windows = completedWindows(frames, "animated");
      for (const { budget, spans } of windows.slice(0, 2)) {
        crowdBudget(budget);
        crowdSpans(formatSpansWindow(spans));
      }
      expect(crowdRate.ready).toBe(true);
      expect(crowdRate.measured).toMatchObject({
        window: 2,
        renderFrames: frames,
        simulatedSeconds: 2,
        animationCalls: 128,
        paletteCalls: 128,
        animationUpdateMs: 1.28,
        skinnedWriteMs: 0.64,
      });
      const receipt = crowdRate.measured;
      expect(Object.isFrozen(receipt)).toBe(true);
      const next = windows[2];
      if (next === undefined) throw new Error("Missing third window");
      crowdBudget(next.budget);
      crowdSpans(formatSpansWindow(next.spans));
      expect(crowdRate.measured).toBe(receipt);
    },
  );

  it.each(["held", "static"])("reports the %s arm's actual animation calls", async (arm) => {
    const { crowdBudget, crowdSpans, crowdRate } = await fixture(arm);
    if (arm === "held") crowdRate.rawRigs = 112;
    for (const { budget, spans } of completedWindows(258, arm)) {
      crowdBudget(budget);
      crowdSpans(formatSpansWindow(spans));
    }
    expect(crowdRate.ready).toBe(true);
    expect(crowdRate.measured).toMatchObject({
      animationCalls: arm === "static" ? 0 : 128,
      paletteCalls: arm === "static" ? 0 : 128,
    });
  });

  it("refuses a held auto arm that never reaches the RAW draw path", async () => {
    const { crowdBudget, crowdSpans, crowdRate } = await fixture("held");
    for (const { budget, spans } of completedWindows(258, "held")) {
      crowdBudget(budget);
      crowdSpans(formatSpansWindow(spans));
    }
    expect(crowdRate.ready).toBe(false);
    expect(crowdRate.measured).toBe(null);
  });

  it.each([
    "frames",
    "window",
    "overflow",
    "clock",
    "incomplete",
    "animation",
    "palette",
    "main",
    "shadow",
    "gpu",
    "zeroGpu",
    "spanFrames",
    "calls",
    "cpu",
  ])("rejects missing or mismatched %s observations", async (missing) => {
    const { crowdBudget, crowdSpans, crowdRate } = await fixture();
    const window = completedWindows(120, "animated")[1];
    if (window === undefined) throw new Error("Missing second window");
    let budget = window.budget;
    let spans = window.spans;
    if (missing === "frames") spans = { ...spans, frames: 119 };
    if (missing === "window") spans = { ...spans, window: 3 };
    if (missing === "overflow") spans = { ...spans, overflowed: 1 };
    if (missing === "clock") budget = { ...budget, simulatedSeconds: undefined };
    if (missing === "incomplete") budget = { ...budget, simulatedSeconds: 1 };
    if (missing === "animation" || missing === "palette") {
      const rows = { ...spans.spans };
      delete rows[missing === "animation" ? "animationUpdate" : "skinnedWrite"];
      spans = { ...spans, spans: rows };
    }
    if (missing === "main") budget = { ...budget, gpuMainSamples: undefined };
    if (missing === "shadow") budget = { ...budget, gpuShadowRendered: undefined };
    if (missing === "gpu") budget = { ...budget, gpu: undefined };
    if (missing === "zeroGpu") budget = { ...budget, gpuMainSamples: 0 };
    if (["spanFrames", "calls", "cpu"].includes(missing)) {
      const animation = spans.spans.animationUpdate;
      if (animation === undefined) throw new Error("Missing animation span");
      spans = {
        ...spans,
        spans: {
          ...spans.spans,
          animationUpdate: {
            ...animation,
            ...(missing === "spanFrames" ? { frames: 119 } : {}),
            ...(missing === "calls" ? { perFrame: 127 } : {}),
            ...(missing === "cpu" ? { mean: Number.NaN } : {}),
          },
        },
      };
    }
    crowdBudget(budget);
    crowdSpans(formatSpansWindow(spans));
    expect(crowdRate.ready).toBe(false);
    expect(crowdRate.measured).toBeNull();
  });

  it("validates the rate scenario schema", () => {
    const path = "examples/skinned-crowd/playtests/crowd-rate.playtest.json";
    expect(() =>
      validatePlaytestScenario(JSON.parse(readFileSync(path, "utf8")), path),
    ).not.toThrow();
  });
});
