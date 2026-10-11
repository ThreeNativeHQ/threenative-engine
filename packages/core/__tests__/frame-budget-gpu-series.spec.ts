import { describe, expect, it } from "vitest";
import { FRAME_BUDGET_MARKER, FrameBudget, type IFrameBudgetWindow } from "../src/frame-budget.js";

/**
 * The defect this pins, measured in `report-GPU1.md`: the frame budget reported one
 * instantaneous `info.render.timestamp` read per window. That read is lagged — `gpuAgeFrames`
 * reached 8 — and consecutive reads of the same steady frame spread 3.5x, so a real 17.6 ms
 * frame was reported as 2.98–10.40 ms. A single lagged sample is not the frame's GPU cost; the
 * resolved frames' distribution is. This feeds the budget a per-frame series and asserts it
 * summarises like the phase rings, counts a reading that has not advanced, and reports
 * unavailable — never a fabricated zero — when it has no reading at all.
 */

function gpuBudget(
  options: { reportEvery?: number; onWindow?: (window: IFrameBudgetWindow) => void } = {},
): FrameBudget {
  return new FrameBudget({ report: () => {}, reportEvery: 100, ...options });
}

/** Drives presented frames, one GPU observation per frame, through the open frame lifecycle. */
function driveGpu(
  budget: FrameBudget,
  frames: ReadonlyArray<readonly [number | undefined, number?]>,
): void {
  const clock = { now: 0, timestamp: 0 };
  for (const [ms, frame] of frames) {
    clock.now += 1;
    clock.timestamp += 16.7;
    budget.beginFrame(clock.timestamp, clock.now);
    clock.now += 2;
    budget.markSimulationEnd(clock.now, 1);
    budget.addRender(9);
    clock.now += 9;
    if (frame === undefined) budget.addGpuMs(ms);
    else budget.addGpuMs(ms, frame);
    budget.endFrame(clock.now);
  }
}

describe("frame-budget GPU series", () => {
  it("keeps stale bucket samples out of a new window's resolved frame range", () => {
    const windows: IFrameBudgetWindow[] = [];
    const budget = gpuBudget({ reportEvery: 4, onWindow: (window) => windows.push(window) });
    for (let i = 0; i < 8; i++) {
      budget.beginFrame(i * 16.7, i * 16.7);
      budget.addGpuMs(i === 7 ? 1 : 100, i === 7 ? 20 : 10);
      budget.addGpuBucketMs({ main: i === 7 ? 1 : 100 });
      budget.endFrame(i * 16.7 + 1);
    }
    expect(windows[1]?.gpuFrames).toEqual({ first: 20, last: 20 });
    expect(windows[1]?.gpuMain).toBe(1);
  });
  it("identifies the resolved frames measured by the window", () => {
    const budget = gpuBudget();
    driveGpu(budget, [
      [10, 10],
      [20, 12],
    ]);
    expect(budget.window().gpuFrames).toEqual({ first: 10, last: 12 });
  });

  it("leaves frame attribution unavailable for unframed measurements", () => {
    const budget = gpuBudget();
    driveGpu(budget, [[10, 10], [20]]);
    expect(budget.window().gpuFrames).toBeUndefined();
  });

  it("reports the resolved frames' mean/p50/p95/max, not the last value", () => {
    const budget = gpuBudget();
    driveGpu(budget, [
      [10, 1],
      [20, 2],
      [30, 3],
      [40, 4],
    ]);
    const window = budget.window();
    expect(window.gpu?.samples).toBe(4);
    expect(window.gpu?.mean).toBe(25);
    expect(window.gpu?.p50).toBe(20);
    expect(window.gpu?.p95).toBe(40);
    expect(window.gpu?.p99).toBe(40);
    expect(window.gpu?.max).toBe(40);
    // The scalar readers (resolution scaler, playtest perf) get the window mean, not the sample.
    expect(window.gpuMs).toBe(25);
  });

  it("counts a reading that has not advanced rather than measuring it twice", () => {
    const budget = gpuBudget();
    driveGpu(budget, [[10, 5], [99, 5], [undefined]]);
    const window = budget.window();
    // Only frame 5's first read is a measurement; the repeat and the missing read are stale.
    expect(window.gpu?.samples).toBe(1);
    expect(window.gpu?.mean).toBe(10);
    expect(window.gpuStale).toBe(2);
  });

  it("reports unavailable, not zero, when no frame produced a reading", () => {
    const budget = gpuBudget();
    driveGpu(budget, [[undefined], [undefined], [undefined]]);
    const window = budget.window();
    expect(window.gpu).toBeUndefined();
    expect(window.gpuMs).toBeUndefined();
    expect(window.gpuStale).toBe(3);
  });

  it("reports unavailable when nothing ever fed it a GPU reading", () => {
    const budget = gpuBudget();
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 4; index += 1) {
      clock.now += 1;
      clock.timestamp += 16.7;
      budget.beginFrame(clock.timestamp, clock.now);
      clock.now += 2;
      budget.markSimulationEnd(clock.now, 1);
      budget.addRender(9);
      clock.now += 9;
      budget.endFrame(clock.now);
    }
    const window = budget.window();
    expect(window.gpu).toBeUndefined();
    expect(window.gpuMs).toBeUndefined();
    expect(window.gpuStale).toBe(0);
  });

  it("leaves the phase series untouched when GPU samples ride along", () => {
    const withGpu = gpuBudget();
    const withoutGpu = gpuBudget();
    driveGpu(withGpu, [
      [10, 1],
      [20, 2],
      [30, 3],
    ]);
    driveGpu(withoutGpu, [[undefined], [undefined], [undefined]]);
    expect(withGpu.window().phases).toEqual(withoutGpu.window().phases);
    expect(withGpu.window().frames).toBe(withoutGpu.window().frames);
  });

  it("resets the GPU ring each window like the phase rings", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({ report: (line) => lines.push(line), reportEvery: 2 });
    driveGpu(budget, [
      [10, 1],
      [20, 2],
    ]);
    driveGpu(budget, [
      [100, 3],
      [200, 4],
    ]);
    const windows = lines
      .filter((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`))
      .map(
        (line) => JSON.parse(line.slice(`${FRAME_BUDGET_MARKER}:`.length)) as IFrameBudgetWindow,
      );
    expect(windows).toHaveLength(2);
    expect(windows[0]?.gpu?.mean).toBe(15);
    expect(windows[1]?.gpu?.mean).toBe(150);
  });

  it("throws on a malformed reading rather than publishing it", () => {
    const budget = gpuBudget();
    budget.beginFrame(0, 0);
    expect(() => budget.addGpuMs(-1, 1)).toThrow(/gpuMs/u);
    expect(() => budget.addGpuMs(Number.NaN, 1)).toThrow(/gpuMs/u);
    expect(() => budget.addGpuMs(10, 1.5)).toThrow(/frame/u);
    expect(() => budget.addGpuMs(10, -1)).toThrow(/frame/u);
  });

  it("summarises the per-bucket GPU p50 and appends the fields to the marker", () => {
    const lines: string[] = [];
    const windows: IFrameBudgetWindow[] = [];
    const budget = new FrameBudget({
      onWindow: (window) => windows.push(window),
      report: (line) => lines.push(line),
      reportEvery: 2,
    });
    const clock = { now: 0, timestamp: 0 };
    const frames = [
      { compute: 0.44, main: 6.06, other: 1.04, shadow: 2.02, total: 10 },
      { compute: 0.66, main: 12.12, other: 3.03, shadow: 4.04, total: 20 },
    ];
    for (const [index, frame] of frames.entries()) {
      clock.now += 1;
      clock.timestamp += 16.7;
      budget.beginFrame(clock.timestamp, clock.now);
      clock.now += 2;
      budget.markSimulationEnd(clock.now, 1);
      budget.addRender(9);
      clock.now += 9;
      budget.addGpuMs(frame.total, index + 1);
      budget.addGpuBucketMs({
        compute: frame.compute,
        main: frame.main,
        other: frame.other,
        shadow: frame.shadow,
      });
      budget.endFrame(clock.now);
    }
    const window = windows[0] as IFrameBudgetWindow;
    // p50 of two samples is the lower of the two; every bucket is reported to one decimal.
    expect(window.gpuMain).toBe(6.1);
    expect(window.gpuShadow).toBe(2);
    expect(window.gpuOther).toBe(1);
    expect(window.gpuCompute).toBe(0.4);
    const marker = lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`));
    expect(marker).toBeDefined();
    const payload = JSON.parse(
      (marker as string).slice(`${FRAME_BUDGET_MARKER}:`.length),
    ) as Record<string, unknown>;
    expect(payload.gpuMain).toBe(6.1);
    expect(payload.gpuShadow).toBe(2);
    expect(payload.gpuOther).toBe(1);
    expect(payload.gpuCompute).toBe(0.4);
    // Appended after every existing field, so a reader that parsed the older line keeps its keys.
    expect(Object.keys(payload).slice(-6)).toEqual([
      "gpuMain",
      "gpuShadow",
      "gpuOther",
      "gpuCompute",
      "gpuShadowP95",
      "gpuShadowSamples",
    ]);
  });

  it("reports the shadow tail over frames that rendered one, not the known-zero frames", () => {
    // p50 of a sparse bucket is zero while the refreshed frames are expensive: the shadow incidence
    // is a few percent, so Phase 2 compares the tail together with the count it was drawn from. A
    // frame that drew no shadow contributes a known zero and must not be in that rendered tail, so
    // the producer's own `shadowPasses` count — never a `shadow > 0` guess — selects the frames.
    const budget = gpuBudget();
    const clock = { now: 0, timestamp: 0 };
    // shadow ms, and the shadow passes the producer recorded that frame.
    const frames: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, 0],
      [0, 0],
      [4, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [21, 1],
    ];
    for (const [index, [ms, passes]] of frames.entries()) {
      clock.now += 1;
      clock.timestamp += 16.7;
      budget.beginFrame(clock.timestamp, clock.now);
      clock.now += 2;
      budget.markSimulationEnd(clock.now, 1);
      budget.addRender(9);
      clock.now += 9;
      budget.addGpuMs(10, index + 1);
      budget.addGpuBucketMs({ main: 5, shadow: ms, shadowPasses: passes });
      budget.endFrame(clock.now);
    }
    const window = budget.window();
    // Every frame resolved a shadow reading, the six known zeros included: the all-frame p50 is 0.
    expect(window.gpuShadowSamples).toBe(8);
    expect(window.gpuShadowP95).toBe(21);
    expect(window.gpuShadow).toBe(0);
    // The rendered tail is the two frames that drew a shadow; the six known zeros are excluded.
    expect(window.gpuShadowRendered?.samples).toBe(2);
    expect(window.gpuShadowRendered?.p95).toBe(21);
    expect(window.gpuShadowRendered?.max).toBe(21);
  });

  it("counts a shadow render that cost 0 ms, which a `shadow > 0` guess would drop", () => {
    const budget = gpuBudget();
    budget.beginFrame(0, 0);
    budget.addGpuMs(5, 1);
    budget.addGpuBucketMs({ main: 5, shadow: 0, shadowPasses: 1 });
    budget.endFrame(1);
    const window = budget.window();
    // A genuine render that resolved to zero is observed: the summary is present at max 0, not absent.
    expect(window.gpuShadowRendered?.samples).toBe(1);
    expect(window.gpuShadowRendered?.max).toBe(0);
  });

  it("omits the rendered shadow summary rather than zeroing it when only known zeros resolved", () => {
    const budget = gpuBudget();
    const clock = { now: 0, timestamp: 0 };
    for (let index = 0; index < 3; index += 1) {
      clock.now += 1;
      clock.timestamp += 16.7;
      budget.beginFrame(clock.timestamp, clock.now);
      clock.now += 2;
      budget.markSimulationEnd(clock.now, 1);
      budget.addRender(9);
      clock.now += 9;
      budget.addGpuMs(10, index + 1);
      budget.addGpuBucketMs({ main: 5, shadow: 0, shadowPasses: 0 });
      budget.endFrame(clock.now);
    }
    const window = budget.window();
    expect(window.gpuShadowSamples).toBe(3);
    expect(window.gpuShadowRendered).toBeUndefined();
  });

  it("reports a bucket absent rather than zero when no frame resolved it", () => {
    const budget = gpuBudget();
    budget.beginFrame(0, 0);
    budget.addGpuMs(9, 1);
    // Main and shadow resolved, compute did not: compute must stay absent.
    budget.addGpuBucketMs({ main: 5, shadow: 2, other: 2 });
    budget.endFrame(1);
    const window = budget.window();
    expect(window.gpuMain).toBe(5);
    expect(window.gpuCompute).toBeUndefined();
  });
});

describe("pyramid GPU span", () => {
  it("reports fresh pyramid samples as a windowed p50/p95 and resets the next window", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({ reportEvery: 3, report: (line) => lines.push(line) });
    for (const [frame, ms] of [1, 2, 3].entries()) {
      budget.beginFrame(frame * 16, frame * 16);
      budget.addGpuPyramidMs(ms);
      budget.endFrame(frame * 16 + 1);
    }
    const payload = JSON.parse(lines[0]?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}");
    expect(payload.gpuPyramid).toMatchObject({ samples: 3, p50: 2, p95: 3 });
    expect(budget.window().gpuPyramid).toBeUndefined();
  });
});
