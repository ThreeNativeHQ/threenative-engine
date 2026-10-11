import { describe, expect, it, vi } from "vitest";
import {
  FRAME_BUDGET_MARKER,
  FRAME_BUDGET_PHASES,
  FRAME_HITCH_MARKER,
  FrameBudget,
  type IFrameBudgetWindow,
  type IFramePhaseSample,
} from "../src/frame-budget.js";
import { FixedStepLoop } from "../src/loop.js";
import type { IRenderPassSample } from "../src/render-pass-budget.js";

/**
 * A scripted device frame. The numbers are the measured Pixel 8 shape from
 * `docs/bugs/mobile-stability-2026-08-23.md` bug 3: a 54.44 ms frame whose renderer.render()
 * owns 49.42 ms. The budget's job is to say that out loud without anybody wrapping
 * requestAnimationFrame by hand.
 */
const DEVICE_FRAME = {
  hostGap: 1.42,
  overlay: 0.3,
  presented: 56.01,
  render: 49.42,
  residual: 0.04,
  update: 3.26,
} as const;

/** Drives one presented frame with a fake clock, in the order the loop drives it. */
function driveFrame(
  budget: FrameBudget,
  clock: { now: number; timestamp: number },
  frame: {
    hostGap: number;
    update: number;
    render: number;
    overlay: number;
    // The native UI composite. Absent for a capture that predates it and for a host with no
    // overlay to composite, where there is no cost to attribute.
    ui?: number;
    residual: number;
    presented: number;
  },
): void {
  clock.now += frame.hostGap;
  clock.timestamp += frame.presented;
  budget.beginFrame(clock.timestamp, clock.now);
  clock.now += frame.update;
  budget.markSimulationEnd(clock.now, 3);
  budget.addRender(frame.render);
  clock.now += frame.render;
  budget.addOverlay(frame.overlay);
  clock.now += frame.overlay;
  budget.addUi(frame.ui ?? 0);
  clock.now += frame.ui ?? 0;
  clock.now += frame.residual;
  budget.endFrame(clock.now);
}

function driveFrameWithoutSample(
  budget: FrameBudget,
  clock: { now: number; timestamp: number },
  frame: typeof DEVICE_FRAME & { ui?: number },
): IFramePhaseSample | undefined {
  clock.now += frame.hostGap;
  clock.timestamp += frame.presented;
  budget.beginFrame(clock.timestamp, clock.now);
  clock.now += frame.update;
  budget.markSimulationEnd(clock.now, 3);
  budget.addRender(frame.render);
  clock.now += frame.render;
  budget.addOverlay(frame.overlay);
  clock.now += frame.overlay;
  budget.addUi(frame.ui ?? 0);
  clock.now += frame.ui ?? 0;
  clock.now += frame.residual;
  return budget.endFrame(clock.now, false);
}

describe("frame budget phase sample", () => {
  it("should build no phase sample when the caller will discard it", () => {
    const budget = new FrameBudget({ reportEvery: Number.MAX_SAFE_INTEGER });
    const clock = { now: 0, timestamp: 0 };
    driveFrame(budget, clock, DEVICE_FRAME);
    const unwanted = driveFrameWithoutSample(budget, clock, DEVICE_FRAME);
    expect(unwanted).toBeUndefined();
  });

  it("should measure the same window whether or not the sample is built", () => {
    const withSample = new FrameBudget({ reportEvery: Number.MAX_SAFE_INTEGER });
    const withoutSample = new FrameBudget({ reportEvery: Number.MAX_SAFE_INTEGER });
    const clockA = { now: 0, timestamp: 0 };
    const clockB = { now: 0, timestamp: 0 };
    for (let index = 0; index < 8; index += 1) {
      driveFrame(withSample, clockA, DEVICE_FRAME);
      driveFrameWithoutSample(withoutSample, clockB, DEVICE_FRAME);
    }
    // Turning the sample off must not turn the measurement off.
    expect(withoutSample.window().phases).toEqual(withSample.window().phases);
    expect(withoutSample.window().frames).toBe(withSample.window().frames);
  });

  it("should still return a sample when the caller asks for one", () => {
    const budget = new FrameBudget({ reportEvery: Number.MAX_SAFE_INTEGER });
    const clock = { now: 0, timestamp: 0 };
    driveFrame(budget, clock, DEVICE_FRAME);
    clock.now += DEVICE_FRAME.hostGap;
    clock.timestamp += DEVICE_FRAME.presented;
    budget.beginFrame(clock.timestamp, clock.now);
    clock.now += DEVICE_FRAME.update;
    budget.markSimulationEnd(clock.now, 3);
    budget.addRender(DEVICE_FRAME.render);
    clock.now += DEVICE_FRAME.render;
    clock.now += DEVICE_FRAME.overlay;
    expect(budget.endFrame(clock.now, true)).toEqual(
      expect.objectContaining({ render: expect.any(Number), update: expect.any(Number) }),
    );
  });
});

function collectingBudget(reportEvery: number): { budget: FrameBudget; lines: string[] } {
  const lines: string[] = [];
  const budget = new FrameBudget({
    report: (line) => lines.push(line),
    reportEvery,
    wallClock: () => 1_700_000,
  });
  return { budget, lines };
}

function parseWindow(line: string): IFrameBudgetWindow {
  return JSON.parse(line.slice(`${FRAME_BUDGET_MARKER}:`.length)) as IFrameBudgetWindow;
}

describe("FrameBudget", () => {
  it("reports Long Tasks separately from presentation gaps and disconnects on disposal", () => {
    let deliver!: (list: { getEntries(): { startTime: number; duration: number }[] }) => void;
    const disconnect = vi.fn();
    vi.stubGlobal(
      "PerformanceObserver",
      class {
        static supportedEntryTypes = ["longtask"];
        constructor(callback: typeof deliver) {
          deliver = callback;
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    try {
      const budget = new FrameBudget({ report: () => {}, reportEvery: 1 });
      budget.beginFrame(100, 100);
      budget.endFrame(101);
      deliver({
        getEntries: () => [
          { startTime: 20, duration: 600 },
          { startTime: 110, duration: 75 },
        ],
      });
      expect(budget.window().longTasks).toEqual({
        available: true,
        count: 2,
        longestMs: 600,
        afterFirstFrameMs: 75,
      });
      budget.dispose();
      expect(disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports Long Tasks as unavailable when the platform cannot observe them", () => {
    vi.stubGlobal("PerformanceObserver", undefined);
    try {
      expect(new FrameBudget().window().longTasks).toEqual({ available: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("attributes the device frame to the phase that owns it", () => {
    const { budget, lines } = collectingBudget(10);
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 10; index += 1) driveFrame(budget, clock, DEVICE_FRAME);

    expect(lines).toHaveLength(1);
    const window = parseWindow(lines[0] ?? "");
    expect(window.frames).toBe(10);
    expect(window.hitches).toBe(0);
    // 56.01 ms between presented frames is 17.85 fps, which is the number a player feels.
    expect(window.fps).toBeCloseTo(17.85, 1);
    expect(window.presented.p50).toBeCloseTo(DEVICE_FRAME.presented, 2);
    expect(window.phases.render.p50).toBeCloseTo(DEVICE_FRAME.render, 2);
    expect(window.phases.update.p50).toBeCloseTo(DEVICE_FRAME.update, 2);
    expect(window.phases.hostGap.p50).toBeCloseTo(DEVICE_FRAME.hostGap, 2);
    expect(window.phases.residual.p50).toBeCloseTo(DEVICE_FRAME.residual, 2);
    // The headline of PRD-214: render owns ~88% of the frame, and the budget says so.
    expect(window.shares.render).toBeGreaterThan(0.85);
    expect(window.shares.render).toBeLessThan(0.9);
    const total = FRAME_BUDGET_PHASES.reduce((sum, phase) => sum + window.shares[phase], 0);
    expect(total).toBeGreaterThan(0.95);
    expect(total).toBeLessThan(1.05);
  });

  it("moves the attribution when the cost moves, so a lever is visible", () => {
    const { budget, lines } = collectingBudget(10);
    const clock = { now: 0, timestamp: 0 };
    const cheapRender = { ...DEVICE_FRAME, presented: 12.0, render: 5.0 };
    for (let index = 0; index < 10; index += 1) driveFrame(budget, clock, cheapRender);
    const window = parseWindow(lines[0] ?? "");
    expect(window.phases.render.p50).toBeCloseTo(5, 2);
    expect(window.shares.render).toBeLessThan(0.5);
    expect(window.fps).toBeGreaterThan(80);
  });

  it("tags a hitch, keeps it out of the percentiles, and counts it", () => {
    const { budget, lines } = collectingBudget(4);
    const clock = { now: 0, timestamp: 0 };
    driveFrame(budget, clock, DEVICE_FRAME);
    // The 27.4-second startup stall from the device log: real, worth a marker, not a frame time.
    driveFrame(budget, clock, { ...DEVICE_FRAME, presented: 27_445 });
    for (let index = 0; index < 3; index += 1) driveFrame(budget, clock, DEVICE_FRAME);

    const hitchLines = lines.filter((line) => line.startsWith(`${FRAME_HITCH_MARKER}:`));
    expect(hitchLines).toHaveLength(1);
    expect(JSON.parse(hitchLines[0]?.slice(`${FRAME_HITCH_MARKER}:`.length) ?? "{}")).toMatchObject(
      {
        gapMs: 27_445,
        wallClock: 1_700_000,
      },
    );
    const window = parseWindow(
      lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`)) ?? "",
    );
    expect(window.frames).toBe(4);
    expect(window.hitches).toBe(1);
    expect(window.presented.max).toBeLessThan(100);
  });

  it("reports zero samples for a phase nothing measured, so a consumer fails instead of skipping", () => {
    const budget = new FrameBudget({ report: () => undefined });
    const window = budget.window();
    expect(window.frames).toBe(0);
    expect(window.fps).toBe(0);
    for (const phase of FRAME_BUDGET_PHASES) expect(window.phases[phase].samples).toBe(0);
  });

  it("names `ui` in the tuple and reports every named phase in the window", () => {
    const { budget } = collectingBudget(2);
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 2; index += 1)
      driveFrame(budget, clock, { ...DEVICE_FRAME, ui: 0.6 });
    const window = budget.window();
    expect(FRAME_BUDGET_PHASES).toContain("ui");
    // Both key sets are the tuple and nothing else: a phase the tuple names but the window omits
    // is one no consumer can read, and a key outside the tuple is one nobody can iterate.
    const named = [...FRAME_BUDGET_PHASES].sort();
    expect(Object.keys(window.phases).sort()).toEqual(named);
    expect(Object.keys(window.shares).sort()).toEqual(named);
  });

  it("charges the native UI composite to `ui` instead of leaving it in residual", () => {
    const budget = new FrameBudget({ report: () => undefined });
    const clock = { now: 0, timestamp: 0 };
    clock.now += DEVICE_FRAME.hostGap;
    clock.timestamp += DEVICE_FRAME.presented;
    budget.beginFrame(clock.timestamp, clock.now);
    const frameStart = clock.now;
    clock.now += DEVICE_FRAME.update;
    budget.markSimulationEnd(clock.now, 3);
    budget.addRender(DEVICE_FRAME.render);
    clock.now += DEVICE_FRAME.render;
    budget.addOverlay(DEVICE_FRAME.overlay);
    clock.now += DEVICE_FRAME.overlay;
    // What the host reports for the composited page: one upload of its pixels and one quad.
    budget.addUi(1.5);
    clock.now += 1.5;
    clock.now += DEVICE_FRAME.residual;
    const sample = budget.endFrame(clock.now);

    expect(sample?.ui).toBeCloseTo(1.5, 2);
    // The named parts and the remainder account for the callback's own duration, so a composite
    // charged to nothing but `residual` would read here as 1.5 ms nobody can attribute.
    const callbackMs =
      (sample?.update ?? 0) +
      (sample?.render ?? 0) +
      (sample?.overlay ?? 0) +
      (sample?.ui ?? 0) +
      (sample?.residual ?? 0);
    expect(callbackMs).toBeCloseTo(clock.now - frameStart, 2);
  });

  it("resets the rings each window so a late line describes steady state", () => {
    const { budget, lines } = collectingBudget(3);
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 3; index += 1) driveFrame(budget, clock, DEVICE_FRAME);
    for (let index = 0; index < 3; index += 1)
      driveFrame(budget, clock, { ...DEVICE_FRAME, presented: 16.7, render: 8 });
    const windows = lines.map(parseWindow);
    expect(windows).toHaveLength(2);
    expect(windows[0]?.window).toBe(1);
    expect(windows[1]?.window).toBe(2);
    expect(windows[0]?.phases.render.p50).toBeCloseTo(49.42, 2);
    expect(windows[1]?.phases.render.p50).toBeCloseTo(8, 2);
    expect(windows[1]?.presented.max).toBeLessThan(20);
  });

  it("hands each completed window to onWindow, after the rings have reset", () => {
    const seen: IFrameBudgetWindow[] = [];
    const budget = new FrameBudget({
      onWindow: (window) => seen.push(window),
      report: () => undefined,
      reportEvery: 2,
    });
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 4; index += 1) driveFrame(budget, clock, DEVICE_FRAME);
    expect(seen.map(({ window }) => window)).toEqual([1, 2]);
    expect(seen[0]?.phases.render.p50).toBeCloseTo(DEVICE_FRAME.render, 2);
    // A consumer changing the scene from the callback affects the window that starts now.
    expect(budget.window().frames).toBe(0);
  });

  it("throws on malformed options rather than measuring nothing quietly", () => {
    expect(() => new FrameBudget({ reportEvery: 0 })).toThrow(/reportEvery/u);
    expect(() => new FrameBudget({ reportEvery: 2.5 })).toThrow(/reportEvery/u);
    expect(() => new FrameBudget({ hitchMs: 0 })).toThrow(/hitchMs/u);
    expect(() => new FrameBudget({ hitchMs: Number.NaN })).toThrow(/hitchMs/u);
    expect(() => new FrameBudget({ capacity: -1 })).toThrow(/capacity/u);
  });

  it("throws when the frame phases arrive out of order", () => {
    const budget = new FrameBudget({ report: () => undefined });
    expect(() => budget.endFrame(1)).toThrow(/outside a frame/u);
    expect(() => budget.addRender(1)).toThrow(/outside a frame/u);
    expect(() => budget.addOverlay(1)).toThrow(/FrameBudget\.addOverlay called outside a frame/u);
    expect(() => budget.addUi(1)).toThrow(/FrameBudget\.addUi called outside a frame/u);
    expect(() => budget.markSimulationEnd(1, 1)).toThrow(/outside a frame/u);
    budget.beginFrame(0, 0);
    expect(() => budget.beginFrame(1, 1)).toThrow(/before the previous frame ended/u);
  });

  it("throws on a non-finite sample instead of publishing a clean percentile", () => {
    const budget = new FrameBudget({ report: () => undefined });
    budget.beginFrame(0, 0);
    budget.markSimulationEnd(1, 1);
    budget.addRender(Number.NaN);
    expect(() => budget.endFrame(2)).toThrow(/non-finite/u);
  });
});

describe("FixedStepLoop with a frame budget", () => {
  it("splits simulation from render without the game wrapping anything", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({ report: (line) => lines.push(line), reportEvery: 2 });
    let clock = 0;
    const loop = new FixedStepLoop({
      budget,
      collectMetrics: true,
      now: () => clock,
      // Each fixed step costs 2 ms of the fake clock; the render costs 40.
      onRender: () => {
        clock += 40;
        budget.addRender(40);
        budget.addRenderPasses([MAIN_PASS, SHADOW_PASS]);
        return { drawCalls: 7, passes: [MAIN_PASS, SHADOW_PASS] };
      },
      onUpdate: () => {
        clock += 2;
      },
      step: 1 / 60,
    });
    loop.start(0);
    loop.stepFrame(16.7);
    loop.stepFrame(33.4);
    loop.stepFrame(50.1);

    expect(loop.budget).toBe(budget);
    const samples = loop.runtimeDiagnosticsSeries();
    expect(samples.length).toBeGreaterThan(0);
    const last = samples[samples.length - 1];
    expect(last?.phases).toBeDefined();
    expect(last?.phases?.render).toBeCloseTo(40, 2);
    expect(last?.phases?.update).toBeCloseTo(2, 2);
    expect(last?.drawCalls).toBe(7);
    // The per-pass split rides the same sample as drawCalls and phases.
    expect(last?.passes).toEqual([MAIN_PASS, SHADOW_PASS]);
    const window = parseWindow(
      lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`)) ?? "",
    );
    expect(window.phases.render.p50).toBeCloseTo(40, 2);
    expect(window.substeps.p50).toBe(1);
  });

  it("collects no phases and prints nothing when no budget is installed", () => {
    let clock = 0;
    const loop = new FixedStepLoop({
      collectMetrics: true,
      now: () => clock,
      onRender: () => {
        clock += 40;
        return undefined;
      },
      onUpdate: () => {
        clock += 2;
      },
      step: 1 / 60,
    });
    loop.start(0);
    loop.stepFrame(16.7);
    loop.stepFrame(33.4);
    expect(loop.budget).toBeUndefined();
    expect(loop.runtimeDiagnosticsSeries().every((sample) => sample.phases === undefined)).toBe(
      true,
    );
  });

  it("closes the budget when rendering throws", () => {
    const budget = new FrameBudget({ report: () => undefined });
    let renderCalls = 0;
    const loop = new FixedStepLoop({
      budget,
      onUpdate: () => undefined,
      onRender: () => {
        renderCalls += 1;
        if (renderCalls === 1) throw new Error("renderer failed");
        return undefined;
      },
    });

    expect(() => loop.stepFrame(0)).toThrow("renderer failed");
    expect(() => loop.stepFrame(16)).not.toThrow();
  });
});

const MAIN_PASS: IRenderPassSample = { draws: 10, kind: "main", triangles: 100 };
const SHADOW_PASS: IRenderPassSample = { draws: 4, kind: "shadow", triangles: 40 };
const REFLECTION_PASS: IRenderPassSample = { draws: 6, kind: "reflection", triangles: 60 };

function driveFrameWithPasses(
  budget: FrameBudget,
  clock: { now: number; timestamp: number },
  passes: readonly IRenderPassSample[],
): void {
  clock.now += DEVICE_FRAME.hostGap;
  clock.timestamp += DEVICE_FRAME.presented;
  budget.beginFrame(clock.timestamp, clock.now);
  clock.now += DEVICE_FRAME.update;
  budget.markSimulationEnd(clock.now, 3);
  budget.addRender(DEVICE_FRAME.render);
  clock.now += DEVICE_FRAME.render;
  budget.addRenderPasses(passes);
  clock.now += DEVICE_FRAME.overlay;
  budget.addOverlay(DEVICE_FRAME.overlay);
  clock.now += DEVICE_FRAME.overlay;
  clock.now += DEVICE_FRAME.residual;
  budget.endFrame(clock.now);
}

describe("FrameBudget pass split", () => {
  it("reports draws and triangles per pass beside the phase split", () => {
    const { budget, lines } = collectingBudget(4);
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 4; index += 1)
      driveFrameWithPasses(budget, clock, [MAIN_PASS, SHADOW_PASS, REFLECTION_PASS]);

    const window = parseWindow(lines[0] ?? "");
    // The phase split is untouched by the pass split.
    expect(window.phases.render.p50).toBeCloseTo(DEVICE_FRAME.render, 2);
    expect(window.passes?.main?.draws.p50).toBe(10);
    expect(window.passes?.main?.triangles.p50).toBe(100);
    expect(window.passes?.main?.frames).toBe(4);
    expect(window.passes?.shadow?.draws.p50).toBe(4);
    expect(window.passes?.reflection?.triangles.p50).toBe(60);
  });

  it("omits a kind no frame submitted, so absence is reported rather than zero", () => {
    const { budget, lines } = collectingBudget(2);
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 2; index += 1) driveFrameWithPasses(budget, clock, [MAIN_PASS]);
    const window = parseWindow(lines[0] ?? "");
    expect(window.passes?.main?.draws.p50).toBe(10);
    expect(window.passes?.shadow).toBeUndefined();
    expect(window.passes?.reflection).toBeUndefined();
  });

  it("reports no passes at all when nothing measured them", () => {
    const budget = new FrameBudget({ report: () => undefined });
    expect(budget.window().passes).toBeUndefined();
  });

  it("throws on a pass kind it does not know rather than dropping it", () => {
    const budget = new FrameBudget({ report: () => undefined });
    budget.beginFrame(0, 0);
    expect(() =>
      budget.addRenderPasses([
        { draws: 1, kind: "unknown" as IRenderPassSample["kind"], triangles: 1 },
      ]),
    ).toThrow(/pass kind/u);
  });
});

describe("the display's own present counter", () => {
  const CAP_60_FRAME = {
    ...DEVICE_FRAME,
    hostGap: 0.4,
    update: 0.2,
    render: 0.1,
    overlay: 0,
    residual: 0.1,
  };

  /**
   * Drives one window of `frameCount` loop frames spanning `spanMs` of clock, while the display
   * presents one frame every `everyNth` loop frames.
   */
  function driveLoopFasterThanDisplay(
    everyNth: number,
    frameCount = 300,
    spanMs = 1_000,
  ): IFrameBudgetWindow {
    let presents = 0;
    let loopFrames = 0;
    const windows: IFrameBudgetWindow[] = [];
    const budget = new FrameBudget({
      onWindow: (window) => windows.push(window),
      readPresentCount: () => presents,
      reportEvery: frameCount,
    });
    const clock = { now: 0, timestamp: 0 };
    const perFrame = spanMs / frameCount;
    for (let index = 0; index < frameCount; index += 1) {
      loopFrames += 1;
      if (loopFrames % everyNth === 0) presents += 1;
      clock.now += perFrame;
      clock.timestamp += perFrame;
      budget.beginFrame(clock.timestamp, clock.now);
      budget.markSimulationEnd(clock.now, 1);
      budget.endFrame(clock.now);
    }
    const first = windows[0];
    if (first === undefined) throw new Error("the budget reported no window");
    return first;
  }

  it("reports the frames a player saw, not the frames the loop dispatched", () => {
    // One present every thirteen loop frames is midway's native launch ratio (133 presents in 1740
    // frames). The loop's cadence is what `fps` has always measured; this is what the display did.
    const window = driveLoopFasterThanDisplay(13);
    expect(window.frames).toBe(300);
    expect(window.presents).toBe(23);
    // 300 loop frames in one second is 300 fps as the window has always computed it…
    expect(window.fps).toBeGreaterThan(299);
    expect(window.fps).toBeLessThan(301);
    // …and the display, at one present per thirteen of them, saw 23.
    expect(window.presentedFps).toBeGreaterThan(22);
    expect(window.presentedFps as number).toBeLessThan(24);
    expect(window.presentedFps as number).toBeLessThan(window.fps);
  });

  it("says nothing about presents where the platform cannot count them", () => {
    // No seam — the web, and every host without this binding. Absent, never zero: a zero would read
    // as "the display presented nothing", which is the opposite of the fact.
    const windows: IFrameBudgetWindow[] = [];
    const budget = new FrameBudget({ onWindow: (w) => windows.push(w), reportEvery: 300 });
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 300; index += 1) driveFrame(budget, clock, DEVICE_FRAME);
    expect(windows[0]?.presents).toBeUndefined();
    expect(windows[0]?.presentedFps).toBeUndefined();
  });

  it("reports zero presents as a reading, and keeps counting after a gap", () => {
    // A window of loop frames can be shorter than one present period: at 20000 fps, 300 frames is
    // 15 ms, and the display may show nothing in it. Midway's own log had exactly that — window 1
    // counted 119 presents, windows 2-5 counted none — and the first cut called all five absent.
    let count = 0;
    const windows: IFrameBudgetWindow[] = [];
    const budget = new FrameBudget({
      onWindow: (w) => windows.push(w),
      readPresentCount: () => count,
      reportEvery: 10,
    });
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 20; index += 1) {
      clock.now += 1;
      clock.timestamp += 1;
      budget.beginFrame(clock.timestamp, clock.now);
      budget.markSimulationEnd(clock.now, 1);
      budget.endFrame(clock.now);
    }
    expect(windows.at(-1)?.presents).toBe(0);
    expect(windows.at(-1)?.presentedFps).toBeUndefined();

    count = 5;
    for (let index = 0; index < 10; index += 1) {
      clock.now += 1;
      clock.timestamp += 1;
      budget.beginFrame(clock.timestamp, clock.now);
      budget.markSimulationEnd(clock.now, 1);
      budget.endFrame(clock.now);
    }
    const last = windows.at(-1);
    expect(last?.presents).toBe(5);
    expect(last?.presentedFps).toBeGreaterThan(0);
  });

  it("ignores a counter that restarts instead of reporting a negative rate", () => {
    let count = 500;
    const windows: IFrameBudgetWindow[] = [];
    const budget = new FrameBudget({
      onWindow: (w) => windows.push(w),
      readPresentCount: () => count,
      reportEvery: 10,
    });
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 12; index += 1) {
      driveFrame(budget, clock, DEVICE_FRAME);
      count += 1;
    }
    count = 0; // the host restarted its numbering
    for (let index = 0; index < 10; index += 1) driveFrame(budget, clock, DEVICE_FRAME);
    const last = windows.at(-1);
    expect(last?.presentedFps ?? 0).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(last?.presentedFps ?? 0)).toBe(true);
  });
});
