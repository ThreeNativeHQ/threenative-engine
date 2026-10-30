import { describe, expect, it } from "vitest";
import { FrameBudget } from "../src/frame-budget.js";
import {
  RENDER_STAGES,
  STAGE_PARTS,
  createStageReader,
  createWorkReader,
  stageMetersRequested,
} from "../src/profiling/FrameStages.js";

/** The running totals the Wasm facade publishes, advanced by one frame's work at a time. */
function engine() {
  const cpuMs = {
    cpuVirtualPagesMs: 0,
    cpuPlanMs: 0,
    cpuShadowBuildMs: 0,
    cpuPrepareMs: 0,
    cpuEncodeMs: 0,
    cpuPostMs: 0,
    cpuSceneMs: 0,
    hostRenderMs: 0,
    hostComputeMs: 0,
    hostSubmitMs: 0,
    hostPollMs: 0,
    hostTailMs: 0,
    rendererMs: 0,
    hostDatabaseMs: 0,
    hostTargetMs: 0,
  };
  const raw = { info: { engine: { cpuMs } } };
  return {
    raw,
    work(frame: Partial<typeof cpuMs>): void {
      for (const [name, ms] of Object.entries(frame)) cpuMs[name as keyof typeof cpuMs] += ms;
    },
  };
}

/** A frame of the stress lab's shape: 3 ms of scene, 4 of plan (1.5 of it virtual pages), 2.5 of encode, 1 of post. */
const FRAME = {
  cpuVirtualPagesMs: 1.5,
  cpuPlanMs: 0.5,
  cpuShadowBuildMs: 1,
  cpuPrepareMs: 4,
  cpuEncodeMs: 2.5,
  cpuPostMs: 1,
  cpuSceneMs: 3,
  hostComputeMs: 0.5,
  hostSubmitMs: 0.25,
  hostPollMs: 0.5,
  hostTailMs: 0.25,
  rendererMs: 7,
  hostDatabaseMs: 10.5,
  hostTargetMs: 0.5,
  hostRenderMs: 12.5,
};

describe("render-phase stages", () => {
  it("answers the baseline read with nothing, so boot is not charged to the first frame", () => {
    const wasm = engine();
    wasm.work({ cpuSceneMs: 900, hostRenderMs: 900 });
    const read = createStageReader(() => wasm.raw);
    expect(read(1, 12, 0.5)).toBeUndefined();
    wasm.work(FRAME);
    expect(read(1, 12, 0.5)).toBeDefined();
  });

  it("splits one frame into stages that sum to the render phase", () => {
    const wasm = engine();
    const read = createStageReader(() => wasm.raw);
    read(0, 0, 0);
    wasm.work(FRAME);
    const stages = read(1.25, 13.5, 0.75);
    if (stages === undefined) throw new Error("no stages");
    expect(stages.jsBefore).toBe(1.25);
    expect(stages.jsAfter).toBe(0.75);
    expect(stages.wasmScene).toBe(3);
    expect(stages.wasmPlan).toBe(4);
    expect(stages.wasmEncode).toBe(1.5); // the encode half without its post share
    expect(stages.wasmPost).toBe(1);
    expect(stages.wasmCompute).toBe(0.5);
    expect(stages.wasmSubmit).toBe(0.25);
    expect(stages.wasmPoll).toBe(0.5);
    expect(stages.wasmTail).toBe(0.25);
    // What `Renderer::render` spent outside its plan and encode halves: 7 - (4 + 2.5).
    expect(stages.wasmRendererGap).toBeCloseTo(0.5, 10);
    // What the database call spent outside its scene half and `Renderer::render`: 10.5 - (3 + 7).
    expect(stages.wasmDatabaseGap).toBeCloseTo(0.5, 10);
    expect(stages.wasmTargets).toBe(0.5);
    // What the call spent that no stage owns is a number of its own: 12.5 - (10.5 + 0.5 + 0.5 + 0.25 + 0.5 + 0.25).
    expect(stages.wasmOther).toBeCloseTo(0, 10);
    expect(stages.engineJs).toBeCloseTo(1, 10); // 13.5 - 12.5
    expect(stages.planVirtualPages).toBe(1.5);
    expect(stages.planDraws).toBe(0.5);
    expect(stages.planShadowLists).toBe(1);
    const sum = RENDER_STAGES.reduce((total, name) => total + stages[name], 0);
    expect(sum).toBeCloseTo(1.25 + 13.5 + 0.75, 10);
    for (const part of STAGE_PARTS) expect(RENDER_STAGES).not.toContain(part);
  });

  it("charges the whole call to engineJs on a renderer that publishes no stage totals", () => {
    const read = createStageReader(() => ({}));
    const stages = read(1, 9, 2);
    expect(stages?.engineJs).toBe(9);
    expect(stages?.wasmScene).toBeUndefined();
    expect(stages?.wasmOther).toBeUndefined();
  });

  it("leaves every engine-only stage absent, not zero, when the renderer publishes no totals", () => {
    const read = createStageReader(() => ({}));
    const stages = read(1, 9, 2);
    for (const name of [...RENDER_STAGES, ...STAGE_PARTS]) {
      if (name === "jsBefore" || name === "engineJs" || name === "jsAfter") continue;
      expect(stages?.[name], name).toBeUndefined();
    }
    expect(stages?.engineJs).toBe(9);
  });

  it("reads a restarted engine's falling totals as zero, never a negative stage", () => {
    const wasm = engine();
    const read = createStageReader(() => wasm.raw);
    wasm.work(FRAME);
    read(0, 0, 0);
    wasm.raw.info.engine.cpuMs.cpuSceneMs = 1;
    wasm.raw.info.engine.cpuMs.hostRenderMs = 1;
    const stages = read(0, 2, 0);
    expect(stages?.wasmScene).toBe(0);
    expect(stages?.engineJs).toBe(2); // a falling host total reads as no Wasm time, so the call is all JS
  });

  it("is on unless the launch turns it off", () => {
    expect(stageMetersRequested()).toBe(true);
    const host = globalThis as { __tnStages?: unknown };
    host.__tnStages = false;
    try {
      expect(stageMetersRequested()).toBe(false);
    } finally {
      host.__tnStages = undefined;
    }
  });
});

describe("window stages", () => {
  function drive(frames: number, withStages: boolean): FrameBudget {
    const budget = new FrameBudget({ report: () => {}, reportEvery: 1000 });
    const wasm = engine();
    const read = createStageReader(() => wasm.raw);
    read(0, 0, 0);
    let now = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      budget.beginFrame(now, now);
      budget.markSimulationEnd(now + 2, 1);
      budget.addRender(14.5);
      wasm.work(FRAME);
      const stages = read(1.25, 12.5, 0.75);
      if (withStages && stages !== undefined) budget.addStages(stages);
      budget.addOverlay(0.5);
      budget.endFrame(now + 17);
      now += 16.7;
    }
    return budget;
  }

  it("publishes each stage's percentiles, and the frame's stages sum to the frame", () => {
    const window = drive(20, true).window();
    expect(window.stages?.wasmScene?.p50).toBe(3);
    expect(window.stages?.wasmPlan?.p95).toBe(4);
    expect(window.stages?.planVirtualPages?.p50).toBe(1.5);
    expect(window.stages?.update?.p50).toBe(2);
    expect(window.stages?.overlay?.p50).toBe(0.5);
    // frame is 17 ms; the stages and phases (update 2 + render 14.5 + overlay 0.5) leave 0 of residual.
    expect(window.frame.p50).toBe(17);
    expect(window.stageSum?.p50).toBe(17);
    // The parts sit beside their stage and are not added to the sum.
    expect(Object.keys(window.stages ?? {})).toEqual(
      expect.arrayContaining(["planVirtualPages", "planDraws", "planShadowLists"]),
    );
  });

  it("averages each stage over the frames at the sum's p95, so the slow frames say where they go", () => {
    const budget = new FrameBudget({ report: () => {}, reportEvery: 1000 });
    const wasm = engine();
    const read = createStageReader(() => wasm.raw);
    read(0, 0, 0);
    let now = 0;
    for (let frame = 0; frame < 20; frame += 1) {
      budget.beginFrame(now, now);
      budget.markSimulationEnd(now + 2, 1);
      budget.addRender(14.5);
      // Two frames in twenty spend 6 ms more in the plan, which is where the tail goes.
      const spike = frame >= 18 ? 6 : 0;
      wasm.work({
        ...FRAME,
        cpuPrepareMs: FRAME.cpuPrepareMs + spike,
        hostRenderMs: FRAME.hostRenderMs + spike,
      });
      const stages = read(1.25, 12.5 + spike, 0.75);
      if (stages !== undefined) budget.addStages(stages);
      budget.endFrame(now + 17 + spike);
      now += 30;
    }
    const tail = budget.window().stagesAtP95;
    expect(tail?.frames).toBe(2);
    expect(tail?.stages.wasmPlan).toBe(10);
    expect(tail?.stages.wasmScene).toBe(3);
  });

  it("publishes only the stages a frame measured, and sums only those", () => {
    const budget = new FrameBudget({ report: () => {}, reportEvery: 1000 });
    const read = createStageReader(() => ({}));
    for (let frame = 0; frame < 5; frame += 1) {
      const now = frame * 20;
      budget.beginFrame(now, now);
      budget.markSimulationEnd(now + 2, 1);
      budget.addRender(12);
      const stages = read(1, 10, 1);
      if (stages !== undefined) budget.addStages(stages);
      budget.endFrame(now + 15);
    }
    const window = budget.window();
    expect(Object.keys(window.stages ?? {}).sort()).toEqual(
      ["engineJs", "jsAfter", "jsBefore", "overlay", "residual", "ui", "update"].sort(),
    );
    expect(window.stageSum?.p50).toBe(window.frame.p50);
  });

  it("publishes no stages when no frame reported any, so a meter-off window carries none", () => {
    const window = drive(5, false).window();
    expect(window.stages).toBeUndefined();
    expect(window.stageSum).toBeUndefined();
  });

  it("drops a hitch frame's stages and starts the next window empty", () => {
    const windows: { stages?: unknown }[] = [];
    const budget = new FrameBudget({
      hitchMs: 100,
      onWindow: (window) => windows.push(window),
      report: () => {},
      reportEvery: 2,
    });
    const wasm = engine();
    const read = createStageReader(() => wasm.raw);
    read(0, 0, 0);
    const frame = (timestamp: number) => {
      budget.beginFrame(timestamp, timestamp);
      budget.markSimulationEnd(timestamp + 1, 1);
      budget.addRender(5);
      wasm.work(FRAME);
      const stages = read(1, 3, 1);
      if (stages !== undefined) budget.addStages(stages);
      budget.endFrame(timestamp + 6);
    };
    frame(0);
    frame(16);
    frame(1000); // a hitch: excluded, so its stages are too
    frame(1016);
    frame(1032);
    expect(windows).toHaveLength(2);
    expect(windows[1]?.stages).toBeDefined();
  });

  it("refuses stages outside a frame", () => {
    const budget = new FrameBudget({ report: () => {} });
    expect(() => budget.addStages({} as never)).toThrow(/outside a frame/u);
  });
});

describe("work counts beside the stages", () => {
  const rawWith = (work: Record<string, number>) => ({ info: { engine: { work } } });

  it("differences the engine's running totals per frame, and names crossings as the host calls", () => {
    const work = { dirtyTransforms: 100, castersMoving: 10, queueWriteBytes: 4096 };
    const read = createWorkReader(() => rawWith(work));
    expect(read(5)).toBeUndefined();
    work.dirtyTransforms += 240;
    work.castersMoving += 12;
    work.queueWriteBytes += 8192;
    expect(read(739)).toMatchObject({
      castersMoving: 12,
      dirtyTransforms: 240,
      gpuBytes: 8192,
      hostCalls: 739,
    });
  });

  it("leaves a count absent when the renderer publishes none, never zero", () => {
    const read = createWorkReader(() => ({}));
    expect(read(1)).toBeUndefined();
    expect(read(1)).toBeUndefined();
  });

  it("carries the counts through a window", () => {
    const budget = new FrameBudget({ report: () => {}, reportEvery: 100 });
    budget.beginFrame(0, 0);
    budget.markSimulationEnd(1, 1);
    budget.addCounters({ castersMoving: 12, dirtyTransforms: 240 });
    budget.endFrame(5);
    const counters = budget.window().counters;
    expect(counters?.dirtyTransforms?.p50).toBe(240);
    expect(counters?.castersMoving?.p50).toBe(12);
    expect(() => budget.addCounters({ dirtyTransforms: -1 })).toThrow();
  });
});
