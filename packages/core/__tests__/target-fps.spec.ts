import { describe, expect, it } from "vitest";
import { FrameBudget } from "../src/frame-budget.js";
import {
  DEFAULT_TARGET_FPS,
  type ITargetFps,
  MAX_TARGET_FPS,
  resolveTargetFps,
  snapRefreshRate,
} from "../src/target-fps.js";

/**
 * The default that taught every template `maxFps: 60`.
 *
 * Every scaffolded game shipped the line, so a 120 Hz desktop played at half its panel and an
 * agent that saw a soft picture had no way to know the config had already answered the question.
 * The default now follows the display, capped at 120, and mobile stays at 60 — and every number
 * here is one a harness can assert on, which is why the source is reported beside it.
 */
const DESKTOP = { formFactor: "desktop" } as const;
const WEB = { formFactor: "unknown" } as const;
const MOBILE = { formFactor: "mobile" } as const;

describe("resolveTargetFps", () => {
  it("lets an explicit number win, whatever the display is doing", () => {
    expect(resolveTargetFps({ display: { maxFps: 90 } }, DESKTOP, 144)).toEqual({
      source: "config",
      targetFps: 90,
    });
    expect(resolveTargetFps({ display: { maxFps: 30 } }, MOBILE, 120).targetFps).toBe(30);
  });

  it("treats 0 as uncapped rather than as a request for no frames", () => {
    expect(resolveTargetFps({ display: { maxFps: 0 } }, DESKTOP, 144)).toEqual({
      source: "config",
      targetFps: 0,
    });
  });

  it("rejects a configured rate it cannot honour instead of quietly falling back", () => {
    expect(() => resolveTargetFps({ display: { maxFps: -1 } }, DESKTOP)).toThrow(
      /display\.maxFps must be a finite number of at least zero/,
    );
    expect(() => resolveTargetFps({ display: { maxFps: Number.NaN } }, DESKTOP)).toThrow(
      /display\.maxFps/,
    );
  });

  it("caps a measured desktop panel at 120", () => {
    expect(resolveTargetFps({}, DESKTOP, 144)).toEqual({ source: "display", targetFps: 120 });
    expect(resolveTargetFps({}, WEB, 165).targetFps).toBe(MAX_TARGET_FPS);
  });

  it("follows a measured 60 Hz panel exactly", () => {
    expect(resolveTargetFps({}, DESKTOP, 60)).toEqual({ source: "display", targetFps: 60 });
    // The same panel measured the way a browser reports it.
    expect(resolveTargetFps({}, DESKTOP, 59.94).targetFps).toBe(60);
    expect(resolveTargetFps({}, DESKTOP, 74.9).targetFps).toBe(75);
  });

  it("holds 60 on mobile whatever the panel is measured at", () => {
    expect(resolveTargetFps({}, MOBILE, 120)).toEqual({
      source: "mobile-default",
      targetFps: DEFAULT_TARGET_FPS,
    });
  });

  it("falls back to 60, and says it has not measured, until a panel answers", () => {
    expect(resolveTargetFps({}, DESKTOP)).toEqual({ source: "fallback", targetFps: 60 });
    expect(resolveTargetFps(undefined, undefined)).toEqual({ source: "fallback", targetFps: 60 });
  });

  it("snaps a nonsense measurement to a rate a display can be asked to hold", () => {
    expect(snapRefreshRate(0)).toBe(DEFAULT_TARGET_FPS);
    expect(snapRefreshRate(Number.NaN)).toBe(DEFAULT_TARGET_FPS);
    expect(snapRefreshRate(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TARGET_FPS);
    expect(snapRefreshRate(97)).toBe(90);
  });
});

describe("the frame-budget marker reports the resolved target", () => {
  it("carries targetFps and targetSource beside the window it decided for", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({
      readTarget: (): ITargetFps => ({ source: "display", targetFps: 120 }),
      reportEvery: 2,
      report: (line) => lines.push(line),
    });
    let now = 0;
    let timestamp = 0;
    for (let frame = 0; frame < 3; frame += 1) {
      timestamp += 8;
      now += 8;
      budget.beginFrame(timestamp, now);
      budget.markSimulationEnd(now, 1);
      budget.endFrame(now);
    }
    const reported = JSON.parse(lines[0]?.slice("TN_FRAME_BUDGET:".length) ?? "{}");
    expect(reported.targetFps).toBe(120);
    expect(reported.targetSource).toBe("display");
  });

  it("counts the frames that ran past the target frame, so a pooled p95 can be read exactly", () => {
    // A pooled p95 is under the target exactly when at most 5 % of the pooled frames are over it;
    // window quantiles can only bound that (PRD-478 AC-1/AC-2). The first window learns the target.
    const lines: string[] = [];
    const budget = new FrameBudget({
      readTarget: (): ITargetFps => ({ source: "config", targetFps: 120 }),
      reportEvery: 4,
      report: (line) => lines.push(line),
    });
    let now = 0;
    const renders = [5, 5, 5, 5, 9, 5, 12, 5, 5, 5, 5, 5];
    const gpus = [3, 3, 3, 3, 3, 9, 3, 3, 3, 3, 3, 3];
    for (const [frame, render] of renders.entries()) {
      now += 16;
      budget.beginFrame(now, now);
      budget.markSimulationEnd(now, 1);
      budget.addRender(render);
      budget.addGpuMs(gpus[frame], frame);
      budget.endFrame(now);
    }
    const windows = lines
      .filter((line) => line.startsWith("TN_FRAME_BUDGET:"))
      .map((line) => JSON.parse(line.slice("TN_FRAME_BUDGET:".length)));
    expect(windows.length).toBeGreaterThanOrEqual(2);
    expect(
      windows[0].overTarget,
      "the first window had no target to count against",
    ).toBeUndefined();
    expect(windows[1].overTarget).toEqual({ frameMs: 8.33, gpu: 1, render: 2 });
  });
});
