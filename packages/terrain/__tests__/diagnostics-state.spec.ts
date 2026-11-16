import type { IFrameBudgetWindow } from "@threenative/core";
import { describe, expect, it, vi } from "vitest";
import {
  type DiagnosticsState,
  beginScene,
  createDiagnosticsState,
  enterView,
  leaveScene,
  observeFrame,
  observeWindow,
  publish,
} from "../src/starter.js";

/** A frame-budget window with the readings the counters read, and nothing they do not. */
function window(first = 101, frameMs = 16): IFrameBudgetWindow {
  const summary = { mean: frameMs, max: frameMs, p50: frameMs, p95: frameMs, p99: frameMs };
  const counts = {
    draws: { mean: 12, max: 12, frames: 400, p50: 12, p95: 12, p99: 12 },
    triangles: { mean: 900, max: 900, frames: 400, p50: 900, p95: 900, p99: 900 },
  };
  return {
    frames: 400,
    frame: summary,
    presented: summary,
    drawn: summary,
    drawnFrames: 400,
    fps: 60,
    drawnFps: 60,
    window: first,
    hitches: 0,
    longTasks: { available: true, count: 0, longestMs: 0, afterFirstFrameMs: 120 },
    gpuMs: 8,
    gpuMain: 6,
    gpuFrames: { first },
    surface: { compiling: false, resolutionScale: 1, sampleCount: 1 },
    passes: { world: { ...counts, frames: 400 } },
  } as unknown as IFrameBudgetWindow;
}

function host() {
  let state = createDiagnosticsState("spec") as DiagnosticsState & Record<string, unknown>;
  const set = vi.fn((patch: Partial<DiagnosticsState>) => {
    state = { ...state, ...patch } as DiagnosticsState & Record<string, unknown>;
  });
  return {
    get state() {
      return state;
    },
    ctx: { state: { set, getState: () => state } },
    set,
  };
}

/** The frame counter's own context: a ready scene, and a GPU frame it has sampled. */
const counterCtx = (getState: () => DiagnosticsState) => ({
  startup: { phase: "ready" as const },
  renderer: {
    gpuFrameSample: () => ({ frame: 100 }),
    gpuFrameAge: () => 0,
  },
  state: { getState },
});

const FACTS = {
  world: "spec",
  groundBiome: "baked",
  elevation: [0, 10] as const,
  snowBand: [8, 9] as const,
  worldReady: true,
  spawnReadiness: [],
  spawnCells: { required: 3, loaded: 3 },
  streaming: undefined,
  terrainTransportBound: false,
  erosion: { flow: 0, deposition: 0 },
  sunX: -180,
  frames: 40,
  travel: 0,
  straightTravel: 0,
  edgeOvershoot: 0,
  grounded: true,
  propColliders: 0,
  propOverlapFrames: 0,
  swimming: false,
  immersionDepth: 0,
  swimSamples: 0,
  swimFloatSamples: 0,
  swimExits: 0,
  swimDrift: 0,
  contactSamples: 0,
  maxContactError: 0,
  bilinearDifference: 0,
  oceanSteps: 0,
  waveSamples: 0,
  waveRange: 0,
  sampleSlopeRange: 0,
  propCounts: { draws: 0, instances: 0, triangles: 0 },
  coverNearEye: 0,
  coverFar: 0,
  farForest: 0,
  farForestInView: 0,
  preparedLodBaseSpread: 0,
  compressedTexturesPrepared: 0,
  preparedLevelsWithoutSolid: 0,
};

describe("the diagnostics state", () => {
  it("starts from the world it measures, and refuses a blank one", () => {
    const state = createDiagnosticsState("swamp");
    expect(state.world).toBe("swamp");
    expect(state.worldReady).toBe(false);
    expect(state.view).toBe("player");
    expect(state.timeToReadyMs).toBe(-1);
    expect(state.viewFrameP50s).toEqual([]);
    expect(state.viewGpu).toEqual([]);
    expect(() => createDiagnosticsState("  ")).toThrowError(/TN_STARTER_DIAGNOSTICS_DATA/);
  });

  it("latches a closed window only once the view's first GPU frame is behind it", () => {
    const h = host();
    beginScene("latch");
    h.ctx.state.set({ worldReady: true });
    observeFrame(counterCtx(h.ctx.state.getState));
    // The sampled frame was 100, so sample 101 is the first measurement this view can own.
    observeWindow(window(100));
    observeWindow(window(101));
    publish(h.ctx, { ...FACTS, world: "latch" });
    expect(h.state.currentViewWindows).toBe(0);
    // The first accepted window only clears the visit's discard; the second is the measurement.
    observeWindow(window(101));
    publish(h.ctx, { ...FACTS, world: "latch" });
    expect(h.state.currentViewWindows).toBe(1);
    expect(h.state.viewFrameP50s).toEqual([
      { view: "latch:player", p50: 16, presentedP95: 16, windows: 1 },
    ]);
    expect(h.state.windowDrawCalls).toBe(12);
    expect(h.state.windowFrameMs).toBe(16);
    expect(h.state.measuredViewCount).toBe(1);
    expect(h.state.maxViewFrameP50).toBe(16);
    expect(h.state.playerFrameP50).toBe(16);
  });

  it("keys the report's view slots to the world being measured", () => {
    const h = host();
    beginScene("swamp");
    h.ctx.state.set({ worldReady: true });
    observeFrame(counterCtx(h.ctx.state.getState));
    observeWindow(window(101));
    observeWindow(window(101, 22));
    publish(h.ctx, { ...FACTS, world: "swamp" });
    expect(h.state.playerFrameP50).toBe(22);
    expect(h.state.riverFrameP50).toBe(0);
    // The same latching under a view the camera cycle moved to.
    enterView("swamp", "river");
    observeFrame(counterCtx(h.ctx.state.getState));
    observeWindow(window(101));
    observeWindow(window(101, 30));
    publish(h.ctx, { ...FACTS, world: "swamp" });
    expect(h.state.riverFrameP50).toBe(30);
    expect(h.state.currentViewWindows).toBe(1);
  });

  it("stops attributing windows to a view once its scene is left", () => {
    const h = host();
    beginScene("left");
    h.ctx.state.set({ worldReady: true });
    observeFrame(counterCtx(h.ctx.state.getState));
    observeWindow(window(101));
    observeWindow(window(101));
    leaveScene();
    observeWindow(window(101));
    publish(h.ctx, { ...FACTS, world: "left" });
    expect(h.state.currentViewWindows).toBe(0);
    expect(h.state.windowFrameMs).toBe(16);
  });
});
