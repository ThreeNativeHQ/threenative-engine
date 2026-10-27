import { describe, expect, it } from "vitest";
import { FrameBudget } from "../src/frame-budget.js";

/**
 * A renderer may decline to draw a frame (the Wasm web engine holds at most two drawn frames on the
 * GPU). The loop still calls `render`, which returns at once, so that frame's render phase is near
 * zero and a window mean over all frames reads cheaper than the frames that were drawn. The meter must
 * say how many frames were not drawn, or two arms that draw different numbers of frames compare as if
 * they did the same work (Midway web, 2026-10-17: 100 of every 300 calls were skipped).
 */
function drive(budget: FrameBudget, skipped: readonly boolean[]): void {
  let now = 0;
  for (const skip of skipped) {
    budget.beginFrame(now, now);
    budget.markSimulationEnd(now + 1, 1);
    budget.addRender(skip ? 0.01 : 6);
    if (skip) budget.addRenderSkip();
    budget.endFrame(now + 8);
    now += 16.7;
  }
}

describe("frame budget render skips", () => {
  it("counts the frames the renderer declined to draw, and reports none when it drew them all", () => {
    const budget = new FrameBudget({ report: () => {}, reportEvery: 1000 });
    drive(budget, [false, true, true, false, true, false]);
    expect(budget.window().renderSkips).toBe(3);

    const drawnAll = new FrameBudget({ report: () => {}, reportEvery: 1000 });
    drive(drawnAll, [false, false, false]);
    expect(drawnAll.window().renderSkips).toBeUndefined();
  });

  it("counts a frame once however often it is reported, and starts each window at zero", () => {
    const windows: { renderSkips?: number }[] = [];
    const budget = new FrameBudget({
      report: () => {},
      reportEvery: 3,
      onWindow: (window) => windows.push(window),
    });
    budget.beginFrame(0, 0);
    budget.addRenderSkip();
    budget.addRenderSkip();
    budget.endFrame(8);
    drive(budget, [false, true]);
    drive(budget, [false, false, false]);
    expect(windows.map((window) => window.renderSkips)).toEqual([2, undefined]);
  });

  it("reports drawn frames and their interval beside the loop's, which it leaves as it was", () => {
    // The shooter on the web, 2026-10-27: 270 getCurrentTexture presents against 293 rAF ticks in one
    // window, while presented p95 read 16.8 ms. The window line must show the frames the player lost.
    const budget = new FrameBudget({ report: () => {}, reportEvery: 1000 });
    drive(budget, [false, true, false, true, false, true, false]);
    const window = budget.window();
    expect(window.renderSkips).toBe(3);
    expect(window.drawnFrames).toBe(4);
    expect(window.drawn.samples).toBe(3);
    expect(window.drawn.p50).toBeCloseTo(33.4, 5);
    expect(window.drawnFps).toBeCloseTo(29.94, 1);
    expect(window.presented.samples).toBe(6);
    expect(window.presented.p50).toBeCloseTo(16.7, 5);
    expect(window.fps).toBeCloseTo(59.88, 1);
  });

  it("refuses a skip reported outside a frame", () => {
    const budget = new FrameBudget({ report: () => {}, reportEvery: 10 });
    expect(() => budget.addRenderSkip()).toThrow("outside a frame");
  });
});
