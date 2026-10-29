import { Texture, TextureLoader } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssetLoader } from "../src/assets.js";
import { FrameBudget } from "../src/frame-budget.js";
import { defineGame } from "../src/game.js";
import { createEngineCounterReader } from "../src/profiling/FrameCounters.js";
import { spansRequested } from "../src/profiling/Spans.js";
import { SPANS, SpanRecorder } from "../src/profiling/Spans.js";
import { countDebug, observeDebugGc } from "../src/profiling/debug-telemetry.js";
import { Scene } from "../src/scene.js";
import { connectUiBridge } from "../src/ui-bridge.js";
import { publishUiState } from "../src/ui-state.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function drive(budget: FrameBudget, engine: Record<string, number>): void {
  for (let f = 0; f < 4; f++) {
    budget.beginFrame(f * 16, f * 16);
    budget.markSimulationEnd(f * 16 + 4, 1);
    budget.addRender(2);
    budget.addCounters({ engine });
    budget.endFrame(f * 16 + 7);
  }
}

describe("one engine debug switch", () => {
  it("derives message and byte rates from the budget window's measured duration", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {
      workerMessages: { area: "worker", caller: "worker.postMessage", unit: "count" },
      workerBytes: { area: "worker", caller: "worker.postMessage", unit: "estimated-bytes" },
    });
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, { workerMessages: 2, workerBytes: 128 });
    const report = JSON.parse(
      String(lines.filter((line) => line.startsWith("TN_DEBUG_REPORT:")).at(-1)).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(report.durationMs).toBeGreaterThan(0);
    expect(report.observations.workerMessages.perSecond).toBeCloseTo(4000 / report.durationMs);
    expect(report.observations.workerBytes.perSecond).toBeCloseTo(256000 / report.durationMs);
    budget.dispose();
  });
  it("includes between-window host gaps in message-rate duration", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {
      workerMessages: { area: "worker", caller: "worker.postMessage", unit: "count" },
    });
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 1, report: (line) => lines.push(line) });
    for (let frame = 0; frame < 3; frame++) {
      budget.beginFrame(frame * 16, frame * 16);
      budget.addCounters({ engine: { workerMessages: 1 } });
      budget.endFrame(frame * 16 + 1);
    }
    const reports = lines
      .filter((line) => line.startsWith("TN_DEBUG_REPORT:"))
      .map((line) => JSON.parse(line.slice("TN_DEBUG_REPORT:".length)));
    expect(reports[0].observations.workerMessages.perSecond).toBeNull();
    expect(reports[1].durationMs).toBe(16);
    expect(reports[1].observations.workerMessages.perSecond).toBe(62.5);
    budget.dispose();
  });
  it("leaves whole-window rates unavailable when the summary ring truncated observations", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {
      workerMessages: { area: "worker", caller: "worker.postMessage", unit: "count" },
    });
    const lines: string[] = [];
    const budget = new FrameBudget({
      capacity: 2,
      reportEvery: 4,
      report: (line) => lines.push(line),
    });
    for (let frame = 0; frame < 8; frame++) {
      budget.beginFrame(frame * 16, frame * 16);
      budget.addCounters({ engine: { workerMessages: 1 } });
      budget.endFrame(frame * 16 + 1);
    }
    const report = JSON.parse(
      String(lines.filter((line) => line.startsWith("TN_DEBUG_REPORT:")).at(-1)).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(report.durationMs).toBe(64);
    expect(report.observations.workerMessages.perSecond).toBeNull();
    budget.dispose();
  });
  it("reports an unavailable first-frame interval without interrupting the game", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 1, report: (line) => lines.push(line) });
    budget.beginFrame(0, 0);
    budget.addCounters({ engine: { sceneCallbacksMs: 2 } });
    expect(() => budget.endFrame(3)).not.toThrow();
    const report = JSON.parse(
      String(lines.find((line) => line.startsWith("TN_DEBUG_REPORT:"))).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(report.intervalMs).toBeNull();
    expect(
      report.offenders.find((offender: { name: string }) => offender.name === "sceneCallbacksMs")
        ?.share,
    ).toBeNull();
    budget.dispose();
  });
  it("counts available GC pause entries and disconnects, leaving unavailable observations absent", () => {
    vi.stubGlobal("__tnEngineCost", {});
    vi.stubGlobal("PerformanceObserver", undefined);
    expect(observeDebugGc()).toBeUndefined();
    vi.stubGlobal("PerformanceObserver", class {});
    expect(observeDebugGc()).toBeUndefined();
    let deliver: ((list: { getEntries: () => { duration: number }[] }) => void) | undefined;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes = ["gc"];
        constructor(callback: typeof deliver) {
          deliver = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    const stop = observeDebugGc();
    deliver?.({ getEntries: () => [{ duration: 12 }, { duration: 4 }] });
    expect(
      (globalThis as { __tnEngineCost?: Record<string, number> }).__tnEngineCost,
    ).toMatchObject({ gcPauses: 2, gcPauseMs: 16 });
    stop?.();
    expect(disconnect).toHaveBeenCalledOnce();
  });
  it("preserves live population gauges, source timing units and the actual history producer names", () => {
    vi.stubEnv("TN_DEBUG", "1");
    let live = 100;
    const read = createEngineCounterReader({
      __tnDebugSources: { bridgeLiveWrappers: { unit: "gauge" } },
      __tnEngineCounters: () => ({ bridgeLiveWrappers: live }),
    });
    read();
    expect(read()?.bridgeLiveWrappers).toBe(100);
    live = 80;
    expect(read()?.bridgeLiveWrappers).toBe(80);
    live = 100;
    expect(read()?.bridgeLiveWrappers).toBe(100);
    vi.stubGlobal("__tnDebugSources", {
      uniformSyncMs: { area: "renderer", caller: "liveUniforms.sync" },
    });
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, { uniformSyncMs: 2, temporalInvalidFrames: 1, temporalActiveFrames: 2 });
    const report = JSON.parse(
      String(lines.find((line) => line.startsWith("TN_DEBUG_REPORT:"))).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(report.offenders).toContainEqual(
      expect.objectContaining({ name: "uniformSyncMs", share: 2 / 16 }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "temporal-history-unavailable", ratio: 0.5 }),
    );
    budget.dispose();
  });
  it("puts incumbent nested spans into engineCost totals and warns only on callbacks over the observed interval", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    const spans = new SpanRecorder();
    spans.begin(SPANS.terrainBlock, 0);
    spans.end(SPANS.terrainBlock, 5);
    expect(
      (globalThis as { __tnEngineCost?: Record<string, number> }).__tnEngineCost?.[
        "span.terrainBlockMs"
      ],
    ).toBe(5);
    vi.stubGlobal("__tnDebugSources", {
      sceneCallbacksMs: { area: "update", caller: "Army.update (/game/army.ts:42)", unit: "ms" },
    });
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, { sceneCallbacksMs: 48 });
    expect(lines.filter((line) => line.startsWith("TN_HOT_CALL:"))).toHaveLength(2);
    budget.dispose();
  });

  it("does not label a late sampled GPU result as oversampling across report windows", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, {
      gpuTimestampRequests: 0,
      gpuTimestampResolves: 1,
      gpuTimestampSamplesDelivered: 1,
      gpuTimestampUnrequestedSamples: 0,
    });
    const reports = lines
      .filter((line) => line.startsWith("TN_DEBUG_REPORT:"))
      .map((line) => JSON.parse(line.slice("TN_DEBUG_REPORT:".length)));
    expect(
      reports.every(
        (report) =>
          !report.findings.some((f: { code: string }) => f.code === "timestamp-oversampling"),
      ),
    ).toBe(true);
    budget.dispose();
  });
  it("feeds named game systems from the actual loop to the budget", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    const canvas = new EventTarget();
    Object.defineProperties(canvas, {
      clientHeight: { value: 180 },
      clientWidth: { value: 320 },
      parentElement: { value: null },
    });
    let frame: ((time: number) => void) | undefined;
    vi.stubGlobal("requestAnimationFrame", (callback: (time: number) => void) => {
      frame = callback;
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const lines: string[] = [];
    let updates = 0;
    class Army extends Scene {
      static override readonly initialState = {};
      override update() {
        updates++;
      }
    }
    const game = defineGame({
      frameBudget: { reportEvery: 2, report: (line) => lines.push(line) },
      renderer: {
        canvas: canvas as HTMLCanvasElement,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas as HTMLCanvasElement,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { army: Army },
      plugins: [{ update() {} }, { update() {} }],
      start: "army",
    });
    try {
      await game.start();
      for (let f = 0; f < 6; f++) frame?.(performance.now() + f * 17);
      expect(updates).toBeGreaterThan(0);
      const budgets = lines.filter((line) => line.startsWith("TN_FRAME_BUDGET:"));
      expect(budgets.length).toBeGreaterThan(0);
      const measured = budgets.map((line) => JSON.parse(line.slice("TN_FRAME_BUDGET:".length)));
      expect(measured.some((window) => window.counters?.engine?.sceneCallbacksCalls?.max > 0)).toBe(
        true,
      );
      expect(
        measured.some((window) => window.counters?.engine?.["plugins.0.updateCalls"]?.max > 0),
      ).toBe(true);
      expect(
        measured.some((window) => window.counters?.engine?.["plugins.1.updateCalls"]?.max > 0),
      ).toBe(true);
    } finally {
      game.stop();
    }
  });

  it("separates synchronous texture decode dispatch from asynchronous decode wall time", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("assets.manifest.json")
        ? new Response("gone", { status: 404 })
        : new Response(new Uint8Array([1, 2, 3, 4])),
    );
    vi.stubGlobal("createImageBitmap", async () => ({ width: 4, height: 4 }));
    const assets = createAssetLoader();
    try {
      await assets.texture("fog.png");
      const host = globalThis as {
        __tnEngineCost?: Record<string, number>;
        __tnDebugSources?: Record<string, { unit: string; caller: string }>;
      };
      expect(host.__tnEngineCost?.textureDecodes).toBe(1);
      expect(host.__tnEngineCost?.textureDecodeBytes).toBe(4);
      expect(host.__tnDebugSources?.textureDecodeWallMs?.unit).toBe("async-ms");
      expect(host.__tnDebugSources?.["textureDecode.fog.pngDispatchMs"]?.caller).toBe("fog.png");
    } finally {
      assets.dispose();
    }
  });
  it("attributes bitmap dispatch after asynchronous fetch to the URL that actually decoded", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    vi.stubGlobal("__tnDebugSources", {});
    vi.stubGlobal("fetch", async (url: string) =>
      url.endsWith("assets.manifest.json")
        ? new Response("gone", { status: 404 })
        : new Response(new Uint8Array([1, 2])),
    );
    let now = 0;
    let decodes = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal("createImageBitmap", () => {
      now += ++decodes === 1 ? 2 : 32;
      return Promise.resolve({ width: 4, height: 4 });
    });
    const assets = createAssetLoader();
    try {
      await assets.texture("first.png");
      await assets.texture("army.png");
      const host = globalThis as {
        __tnEngineCost?: Record<string, number>;
        __tnDebugSources?: Record<string, { caller: string }>;
      };
      expect(host.__tnEngineCost?.["textureDecode.first.pngDispatchMs"]).toBe(2);
      expect(host.__tnEngineCost?.["textureDecode.army.pngDispatchMs"]).toBe(32);
      expect(host.__tnDebugSources?.textureDecodeDispatchMs?.caller).toBe(
        "loadBitmapTexture (all URLs)",
      );
    } finally {
      assets.dispose();
    }
  });
  it("attributes synchronous streaming work to each asset and keeps async latency separate", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    vi.stubGlobal("__tnDebugSources", {});
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const assets = createAssetLoader({
      texture: (url) => {
        now += url === "army.png" ? 32 : 2;
        return Promise.resolve(new Texture()).then((texture) => {
          now += 100;
          return texture;
        });
      },
    });
    try {
      await assets.texture("army.png");
      await assets.texture("hud.png");
      const host = globalThis as {
        __tnEngineCost?: Record<string, number>;
        __tnDebugSources?: Record<string, { caller: string; unit: string }>;
      };
      expect(host.__tnEngineCost?.["assetDispatch.army.pngMs"]).toBe(32);
      expect(host.__tnEngineCost?.["assetDispatch.hud.pngMs"]).toBe(2);
      expect(host.__tnDebugSources?.["assetLoad.army.pngWallMs"]).toMatchObject({
        caller: "army.png",
        unit: "async-ms",
      });
      expect(host.__tnEngineCost?.["assetLoad.army.pngWallMs"]).toBe(132);
    } finally {
      assets.dispose();
    }
  });
  it("records the image-element decode fallback without claiming its wall time is main-thread CPU", async () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    vi.stubGlobal("createImageBitmap", undefined);
    vi.spyOn(TextureLoader.prototype, "load").mockImplementation((_url, onLoad) => {
      const texture = new Texture();
      onLoad?.(texture);
      return texture;
    });
    const assets = createAssetLoader();
    try {
      await assets.texture("legacy.png");
      expect(
        (globalThis as { __tnEngineCost?: Record<string, number> }).__tnEngineCost,
      ).toMatchObject({ textureMainThreadDecodeFallbacks: 1 });
    } finally {
      assets.dispose();
    }
  });
  it("keeps diagnostic streaming clocks and counters absent with debug off", async () => {
    vi.stubEnv("TN_DEBUG", "0");
    vi.stubGlobal("__THREENATIVE_DEBUG__", false);
    vi.stubGlobal("location", { search: "" });
    vi.stubGlobal("__tnEngineCost", undefined);
    vi.stubGlobal("__TN_ASSET_TRACE__", false);
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));
    const now = vi.spyOn(performance, "now");
    const assets = createAssetLoader({ texture: async () => new Texture() });
    try {
      await assets.texture("quiet.png");
      expect(now).not.toHaveBeenCalled();
      expect((globalThis as { __tnEngineCost?: unknown }).__tnEngineCost).toBeUndefined();
    } finally {
      assets.dispose();
    }
  });
  it.each(["environment", "query", "global"])("enables incumbent spans through %s", (seam) => {
    vi.stubEnv("TN_FRAME_SPANS", "0");
    vi.stubEnv("TN_DEBUG", seam === "environment" ? "1" : "0");
    vi.stubGlobal("location", { search: seam === "query" ? "?tnDebug=1" : "" });
    vi.stubGlobal("__THREENATIVE_DEBUG__", seam === "global");
    expect(spansRequested()).toBe(true);
  });

  it("enables the incumbent engineCost reader without the separate playtest knob", () => {
    vi.stubEnv("TN_DEBUG", "1");
    let bridges = 10;
    const read = createEngineCounterReader({ __tnEngineCounters: () => ({ bridgeGets: bridges }) });
    expect(read()).toBeUndefined();
    bridges += 995;
    expect(read()).toMatchObject({ bridgeGets: 995 });
  });

  it("ranks measured and estimated costs in exactly one report per budget window", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnDebugSources", {
      armyMs: { area: "update", caller: "army.sync (/game/army.ts:42)", unit: "ms" },
      bridgeCrossingMs: {
        area: "bridge",
        caller: "army.sync (/game/army.ts:42)",
        unit: "estimated-ms",
      },
    });
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, { armyMs: 3, bridgeCrossingMs: 1, bridgeWidenedBytes: 401408 });
    const reports = lines.filter((line) => line.startsWith("TN_DEBUG_REPORT:"));
    expect(reports).toHaveLength(2);
    const report = JSON.parse(String(reports[0]).slice("TN_DEBUG_REPORT:".length));
    expect(report.offenders).toContainEqual(
      expect.objectContaining({
        name: "armyMs",
        share: 3 / 16,
        caller: expect.stringContaining("army.sync"),
        basis: "measured",
      }),
    );
    expect(report.offenders).toContainEqual(
      expect.objectContaining({
        name: "bridgeCrossingMs",
        share: 1 / 16,
        basis: "estimated-getter-equivalent",
        lever: expect.stringContaining("PERFORMANCE-LEARNINGS.md"),
      }),
    );
    expect(report.observations).toMatchObject({ bridgeWidenedBytes: { mean: 401408 } });
    budget.dispose();
  });

  it("flags temporal velocity gaps and excess timestamp commands without timing late delivery as new GPU work", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, {
      velocityCandidates: 24,
      velocitySkipped: 24,
      gpuTimestampRequests: 1,
      gpuTimestampResolves: 8,
      gpuTimestampSamplesDelivered: 2,
      gpuTimestampUnrequestedSamples: 7,
    });
    const report = JSON.parse(
      String(lines.find((line) => line.startsWith("TN_DEBUG_REPORT:"))).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "temporal-missing-velocity", ratio: 1 }),
    );
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "timestamp-oversampling", perFrame: 7 }),
    );
    expect(report.findings.some((f: { code: string }) => f.code.includes("delivery"))).toBe(false);
    budget.dispose();
  });

  it("keeps 500 per-URL counters out of the frame series and ranks ten of them in the report", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const totals: Record<string, number> = { "bridge:get InstancedMesh.count": 9000 };
    vi.stubGlobal("__tnEngineCost", totals);
    vi.stubGlobal("__tnDebugSources", {});
    const read = createEngineCounterReader();
    for (let index = 0; index < 500; index += 1)
      countDebug(
        `textureDecode.url-${index}.pngDispatchMs`,
        1,
        "loading",
        `url-${index}.png`,
        "ms",
      );
    read(); // the run's baseline, not a frame
    for (let index = 0; index < 500; index += 1)
      totals[`textureDecode.url-${index}.pngDispatchMs`] += index;
    const frame = read() ?? {};
    // One ring per name would grow with the content, so the per-frame series keep none of them.
    expect(
      Object.keys(frame).filter((name) => name.startsWith("bridge:") || name.includes(".url")),
    ).toEqual([]);
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 1, report: (line) => lines.push(line) });
    drive(budget, frame);
    const report = JSON.parse(
      String(lines.find((line) => line.startsWith("TN_DEBUG_REPORT:"))).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(report.observations).toEqual({});
    expect(report.contentScaled.basis).toBe("run-total");
    expect(report.contentScaled.top).toHaveLength(10);
    expect(report.contentScaled.top[0]).toMatchObject({
      name: "bridge:get InstancedMesh.count",
      total: 9000,
      area: "bridge",
    });
    expect(report.contentScaled.top[1]).toMatchObject({
      name: "textureDecode.url-499.pngDispatchMs",
      total: 500,
      unit: "ms",
      caller: "url-499.png",
    });
    budget.dispose();
  });

  it("derives temporal findings only from the counters a producer writes", () => {
    vi.stubEnv("TN_DEBUG", "1");
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    // The web renderer used to add `temporalHistoryInvalidFrames` beside the C++ renderer's
    // `temporalInvalidFrames`, and nothing writes the two `*Draws` names at all. A rule on a name no
    // producer writes is dead: it can only fire on a hand-built window.
    drive(budget, {
      velocityEligibleDraws: 24,
      velocitySkippedDraws: 24,
      temporalInvalidHistoryFrames: 1,
      temporalHistoryInvalidFrames: 1,
      temporalActiveFrames: 2,
    });
    const report = JSON.parse(
      String(lines.find((line) => line.startsWith("TN_DEBUG_REPORT:"))).slice(
        "TN_DEBUG_REPORT:".length,
      ),
    );
    expect(
      report.findings.filter((finding: { code: string }) => finding.code.startsWith("temporal-")),
    ).toEqual([]);
    budget.dispose();
  });

  it("leaves reports and debug counter setup absent when off", () => {
    vi.stubEnv("TN_DEBUG", "0");
    vi.stubGlobal("__THREENATIVE_DEBUG__", false);
    vi.stubGlobal("location", { search: "" });
    const lines: string[] = [];
    const source = vi.fn(() => ({ calls: 99 }));
    const read = createEngineCounterReader({ __tnEngineCounters: source });
    expect(read()).toBeUndefined();
    expect(source).not.toHaveBeenCalled();
    const budget = new FrameBudget({ reportEvery: 2, report: (line) => lines.push(line) });
    drive(budget, { armyMs: 3 });
    expect(lines.filter((line) => line.startsWith("TN_DEBUG_REPORT:"))).toEqual([]);
    budget.dispose();
  });

  it("counts HUD serializations and UTF-8 bytes through the real publisher without serializing twice", () => {
    vi.stubEnv("TN_DEBUG", "1");
    vi.stubGlobal("__tnEngineCost", {});
    const sent: string[] = [];
    const bridge = connectUiBridge({
      end: "game",
      scope: { __tnUiPost: (frame: string) => sent.push(frame), __tnUiOverlayAttached: () => true },
    });
    const stringify = vi.spyOn(JSON, "stringify");
    const publisher = publishUiState(bridge, {
      getState: () => ({ label: "é🚀" }),
      subscribe: () => () => undefined,
    });
    const totals = (globalThis as { __tnEngineCost?: Record<string, number> }).__tnEngineCost;
    expect(totals?.uiMessages).toBe(1);
    expect(totals?.uiMessageBytes).toBe(new TextEncoder().encode(sent[0]).byteLength);
    expect(totals?.uiSerializations).toBe(1);
    expect(stringify).toHaveBeenCalledTimes(1);
    publisher.stop();
    bridge.close();
  });
});
