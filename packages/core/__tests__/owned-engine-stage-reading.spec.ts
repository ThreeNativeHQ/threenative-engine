import { describe, expect, it } from "vitest";
import { stageGpuReading } from "../src/render-pass-budget.js";
import { GIBudget } from "../src/render/gi-budget.js";
import { ShadowFilterBudget } from "../src/render/shadow-filter-budget.js";

/**
 * The owned (Wasm) engine times its passes natively. It has no timestamp pool for the pass recorder to
 * read, so it reports the newest sample itself: the whole frame as `info.render.timestamp`, the labelled
 * stages as `info.engine.gpuStages`, and the frame the sample belongs to as the last
 * `getTimestampFrames("render")` entry (three-native `browser-renderer.ts`).
 */
interface IOwnedRenderer {
  backend: { getTimestampFrames(type: string): number[] };
  info: {
    engine: { gpuStages: Record<string, number> };
    render: { timestamp: number };
  };
}

function ownedRenderer(): IOwnedRenderer {
  return {
    backend: { getTimestampFrames: () => [] },
    info: { engine: { gpuStages: {} }, render: { timestamp: 0 } },
  };
}

/** The engine resolves one more sample: what `browser-renderer.ts` writes when the host counts one. */
function sample(raw: IOwnedRenderer, frame: number, total: number, stages: Record<string, number>) {
  raw.backend.getTimestampFrames = () => [frame];
  raw.info.render.timestamp = total;
  raw.info.engine.gpuStages = stages;
}

const GI_OPTIONS = {
  budgetMs: { irradianceField: 1, none: 0, screenProbeGather: 6 },
  frameBudgetMs: 16.7,
  method: "screenProbeGather",
  minSamples: 4,
  report: () => undefined,
  stages: ["SSGI"],
  tier: "high",
  windowFrames: 10,
} as const;

describe("stageGpuReading on the owned engine", () => {
  it("answers the newest sample's stages and whole frame, with the frame it belongs to", () => {
    const raw = ownedRenderer();
    sample(raw, 41, 12.5, { SSGI: 4.25 });
    expect(stageGpuReading(raw)).toEqual({ frame: 41, stages: { SSGI: 4.25 }, total: 12.5 });
  });

  it("is absent until the first sample lands", () => {
    expect(stageGpuReading(ownedRenderer())).toBeUndefined();
    const raw = ownedRenderer();
    sample(raw, 3, 0, {});
    expect(stageGpuReading(raw)).toBeUndefined();
  });

  it("is absent on a renderer that reports no stages, as three's WebGPU renderer does", () => {
    expect(
      stageGpuReading({
        backend: { getTimestampFrames: () => [7] },
        info: { render: { timestamp: 9 } },
      }),
    ).toBeUndefined();
  });

  it("lets GIBudget step down from the owned engine's SSGI time", () => {
    const raw = ownedRenderer();
    const steps: string[] = [];
    const gi = new GIBudget({ ...GI_OPTIONS, onStep: (method) => steps.push(method) });
    let report: ReturnType<GIBudget["observeRenderer"]>;
    for (let frame = 1; frame <= 10; frame++) {
      sample(raw, frame, 40, { SSGI: 31 });
      report = gi.observeRenderer(raw);
    }
    expect(report).toMatchObject({
      stagesSeen: ["SSGI"],
      stepped: "irradianceField",
      windowMs: 31,
    });
    expect(steps).toEqual(["irradianceField"]);
  });

  it("counts a sample once however many loop frames wait for the next one", () => {
    const raw = ownedRenderer();
    const gi = new GIBudget({ ...GI_OPTIONS });
    sample(raw, 1, 40, { SSGI: 31 });
    for (let loop = 0; loop < 10; loop++) gi.observeRenderer(raw);
    expect(gi.lastReport()).toMatchObject({ samples: 1, windowMs: undefined });
  });

  it("lets ShadowFilterBudget leave the gather out of the frame it judges", () => {
    const raw = ownedRenderer();
    const steps: string[] = [];
    const shadows = new ShadowFilterBudget({
      excludeStages: ["SSGI"],
      frameBudgetMs: 16.7,
      minSamples: 4,
      onStep: (tier) => steps.push(tier),
      report: () => undefined,
      tier: "high",
      windowFrames: 10,
    });
    let report: ReturnType<ShadowFilterBudget["observeRenderer"]>;
    // 25 ms frame, 20 of it the gather: the filter's own 5 ms is well inside the 16.7 ms period.
    for (let frame = 1; frame <= 10; frame++) {
      sample(raw, frame, 25, { SSGI: 20 });
      report = shadows.observeRenderer(raw);
    }
    expect(report).toMatchObject({ stepped: undefined, tier: "high", windowMs: 5 });
    expect(steps).toEqual([]);
  });
});
