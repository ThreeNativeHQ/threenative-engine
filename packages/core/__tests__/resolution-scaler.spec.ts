import { describe, expect, it } from "vitest";
import { RESOLUTION_SCALER, ResolutionScaler } from "../src/resolution-scaler.js";

/**
 * PRD-228 Phase 2. Every number here is pre-registered in the PRD before this code existed and
 * is read from one constant block — a controller tuned until it looked right in a playtest is a
 * controller nobody can argue with afterwards.
 */
/**
 * One window as the controller sees it: the fps it achieved and the tail it achieved it with.
 *
 * The middle of the distribution is derived from the fps rather than passed in, so every window
 * here is one whose frames all cost about the same — the controller's stall guard reads the
 * distance between `p99` and `p50`, and a window built with an arbitrary middle would be declaring
 * a stall these cases are not about. The cases that *are* about it live in
 * `resolution-scaler-outlier.spec.ts`, where the window comes out of a real `FrameBudget`.
 */
const budget = (fps: number, p95 = 17.5, p99 = p95) => ({
  fps,
  presented: { max: p99, p50: 1_000 / fps, p95, p99 },
});
/**
 * The same window with fresh GPU timing. Sized jumps need measured GPU cost: an fps deficit
 * alone cannot say how much of the frame scales with pixels, so without `gpuMs` the fallback
 * below only probes.
 */
const gpuBudget = (fps: number, gpuMs: number, p95 = 17.5, p99 = p95) => ({
  ...budget(fps, p95, p99),
  gpuMs,
  gpuAgeFrames: 3,
});

/** A window that is comfortably meeting a 60 fps target on a vsync-capped 60 Hz panel. */
const AT_TARGET = 60;
/** A window that is missing it. */
const UNDER_TARGET = 40;

function feed(scaler: ResolutionScaler, fps: number, windows: number, p95 = 17.5): void {
  for (let index = 0; index < windows; index += 1) scaler.observe(budget(fps, p95));
}

describe("ResolutionScaler", () => {
  it("carries the pre-registered rungs, triggers and guards", () => {
    expect(RESOLUTION_SCALER.rungs).toEqual([
      1.0, 0.85, 0.72, 0.61, 0.52, 0.44, 0.38, 0.32, 0.27, 0.23,
    ]);
    expect(RESOLUTION_SCALER.downWindows).toBe(1);
    expect(RESOLUTION_SCALER.targetFpsFraction).toBe(0.98);
    expect(RESOLUTION_SCALER.upTailFraction).toBe(1.15);
    expect(RESOLUTION_SCALER.upWindows).toBe(4);
    expect(RESOLUTION_SCALER.cooldownWindows).toBe(1);
    expect(RESOLUTION_SCALER.warmupWindows).toBe(1);
    expect(RESOLUTION_SCALER.maxDownRungs).toBe(4);
    expect(RESOLUTION_SCALER.oscillationCycles).toBe(2);
    // Derived, not pre-registered: see the constant's own note. A down-then-up leg costs
    // cooldownWindows + upWindows = 5 windows, so the PRD's literal 3 could never fire.
    expect(RESOLUTION_SCALER.oscillationWindows).toBe(
      RESOLUTION_SCALER.cooldownWindows + RESOLUTION_SCALER.upWindows + 1,
    );
    // Amended 2026-08-28 from the device: the original presented-p95 bars read the panel, not the
    // game, and walked a template that was holding 60 fps all the way to the floor.
    expect(RESOLUTION_SCALER).not.toHaveProperty("downFraction");
  });

  it("discards the first window outright, because a loading frame is not a measurement", () => {
    // A scaffolded template took its only down-step from a cold-start window reading 51.52 fps
    // while still loading, then spent four windows climbing back to where it started.
    const scaler = new ResolutionScaler({ targetFps: 60 });
    expect(scaler.observe(budget(10))).toBeUndefined();
    expect(scaler.scale).toBe(1.0);
  });

  it("falls one rung on a window that just missed the target", () => {
    const scaler = new ResolutionScaler({ targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
    expect(scaler.scale).toBe(1.0);
    // 59 of a 60 target needs 1.017x fewer pixels: less than one rung, so one rung.
    expect(scaler.observe(budget(58))).toBe(0.85);
  });

  it("jumps straight to the rung the deficit implies instead of walking there", () => {
    // Bayview's first live window on a physical Pixel 8 read 28.99 fps against a 60 target.
    // log(60/28.99) / log(1/0.72) = 2.2 -> 3 rungs, so 1.00 -> 0.61 in one step. Walking it cost
    // about three minutes visibly at 29 fps (§1.3.6). The jump needs measured GPU cost — the
    // device arm reports timestamps — because an fps deficit alone cannot price it.
    const scaler = new ResolutionScaler({ targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
    expect(scaler.observe(gpuBudget(28.99, 1_000 / 28.99))).toBe(0.61);
  });

  it("never jumps further than the cap, however bad the window", () => {
    const scaler = new ResolutionScaler({ targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
    // 1 fps against 60 implies far more than four rungs; four is what it takes.
    expect(scaler.observe(gpuBudget(1, 100))).toBe(
      RESOLUTION_SCALER.rungs[RESOLUTION_SCALER.maxDownRungs],
    );
  });

  it("stops at the floor when the jump would overshoot it", () => {
    const scaler = new ResolutionScaler({ start: 0.32, targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
    expect(scaler.observe(gpuBudget(5, 200))).toBe(0.23);
    expect(scaler.scale).toBe(0.23);
  });

  it("does not move a game that is already hitting its target on a vsync-capped panel", () => {
    // The defect a scaffolded template found on a physical Pixel 8: under FIFO the presented
    // interval is the panel's period, so `presented p95` sits near 17.5 ms forever and the old
    // 14 ms bar was true even at 59.99 fps. The controller walked a game with `frame p95` of
    // 7.99 ms out of a 16.67 ms budget down to 552x248 and then reported it had run out of room.
    const scaler = new ResolutionScaler({ start: 0.85, targetFps: 60 });
    feed(scaler, 59.99, RESOLUTION_SCALER.warmupWindows + 3, 17.9);
    expect(scaler.scale).toBe(0.85);
    expect(scaler.atFloor).toBe(false);
    // Meeting the target with a clean tail is headroom, so it climbs rather than falls.
    expect(scaler.observe(budget(59.99, 17.9))).toBe(1.0);
  });

  it("refuses to climb on a frame that hits its average target while dropping frames", () => {
    const scaler = new ResolutionScaler({ start: 0.85, targetFps: 60 });
    // 33 ms tail on a 60 Hz panel is a dropped frame, whatever the mean says.
    feed(scaler, 59.5, RESOLUTION_SCALER.warmupWindows + 8, 33.3);
    expect(scaler.scale).toBe(0.85);
  });

  // PRD-563: a class start is a guess, and measurement always wins over it.
  describe("starting on the rung an adapter class names", () => {
    const start = RESOLUTION_SCALER.startScaleByGpuClass["mobile-low"];

    it("starts one rung down for mobile-low and at the ceiling for every other class", () => {
      expect(start).toBe(0.85);
      expect(new ResolutionScaler({ start, targetFps: 60 }).scale).toBe(0.85);
      for (const unnamed of [
        "discrete",
        "integrated",
        "software",
        "unknown",
        "mobile-high",
      ] as const)
        expect(RESOLUTION_SCALER.startScaleByGpuClass[unnamed]).toBeUndefined();
      expect(new ResolutionScaler({ targetFps: 60 }).scale).toBe(1.0);
    });

    it("steps down from the class rung on the first measured miss", () => {
      const scaler = new ResolutionScaler({ start, targetFps: 60 });
      feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
      expect(scaler.observe(budget(UNDER_TARGET))).toBeLessThan(0.85);
    });

    it("climbs back to the ceiling after four clean windows when the GPU holds the target", () => {
      const scaler = new ResolutionScaler({ start, targetFps: 60 });
      feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows + 3);
      expect(scaler.scale).toBe(0.85);
      expect(scaler.observe(budget(AT_TARGET))).toBe(1.0);
    });
  });

  it("climbs only after four consecutive windows at the target, and slowly", () => {
    const scaler = new ResolutionScaler({ start: 0.61, targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows + 3);
    expect(scaler.scale).toBe(0.61);
    expect(scaler.observe(budget(AT_TARGET))).toBe(0.72);
    expect(scaler.scale).toBe(0.72);
  });

  it("discards the window after a step, because the resize frame is itself a hitch", () => {
    const scaler = new ResolutionScaler({ targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
    scaler.observe(budget(58));
    // The cooldown window missed the target too, and must not trigger a second fall.
    expect(scaler.observe(budget(20))).toBeUndefined();
    expect(scaler.scale).toBe(0.85);
    // The next window repeats the deficit the probe already priced in: fewer pixels earned
    // nothing, so the probe is refunded instead of deepened.
    expect(scaler.observe(budget(58))).toBe(1);
    expect(scaler.scale).toBe(1);
  });

  it("stops at the floor and says so rather than pretending the budget was met", () => {
    const scaler = new ResolutionScaler({ start: 0.23, targetFps: 60 });
    expect(scaler.atFloor).toBe(false);
    feed(scaler, UNDER_TARGET, RESOLUTION_SCALER.warmupWindows + 6);
    expect(scaler.scale).toBe(0.23);
    expect(scaler.atFloor).toBe(true);
  });

  it("never climbs above the ceiling", () => {
    const scaler = new ResolutionScaler({ targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows + 20);
    expect(scaler.scale).toBe(1.0);
  });

  it("temporarily holds the lower rung after oscillation, then reports and permits recovery", () => {
    const scaler = new ResolutionScaler({ targetFps: 60 });
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.warmupWindows);
    expect(scaler.scaleSource).toBe("auto");
    // A real thermal edge: the frame sits just either side of the bar and the scaler pumps across
    // one boundary. down, up, down, up, down — five legs, two complete cycles.
    const fall = (): void => {
      expect(scaler.observe(budget(58))).toBeDefined();
      scaler.observe(budget(AT_TARGET)); // cooldown, discarded
    };
    const climb = (): void => {
      feed(scaler, AT_TARGET, RESOLUTION_SCALER.upWindows);
      scaler.observe(budget(AT_TARGET)); // cooldown, discarded
    };
    fall();
    expect(scaler.scale).toBe(0.85);
    climb();
    expect(scaler.scale).toBe(1.0);
    fall();
    climb();
    expect(scaler.scale).toBe(1.0);
    expect(scaler.scaleSource).toBe("auto");
    scaler.observe(budget(58));
    expect(scaler.scale).toBe(0.85);
    expect(scaler.scaleSource).toBe("auto-pinned");
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.oscillationWindows - 1);
    expect(scaler.scale).toBe(0.85);
    expect(scaler.scaleSource).toBe("auto-pinned");
    expect(scaler.observe(budget(AT_TARGET))).toBe(0.85); // propagate source change to renderer
    expect(scaler.scaleSource).toBe("auto");
    feed(scaler, AT_TARGET, RESOLUTION_SCALER.upWindows);
    expect(scaler.scale).toBe(1);
    expect(scaler.observe(budget(UNDER_TARGET))).toBeUndefined(); // resize cooldown
    expect(scaler.observe(budget(UNDER_TARGET))).toBeLessThan(1);
  });

  it("scales its triggers to the configured target rather than assuming 60", () => {
    const scaler = new ResolutionScaler({ targetFps: 30 });
    feed(scaler, 30, RESOLUTION_SCALER.warmupWindows, 33.3);
    // 30 fps meets a 30 fps target; at a 60 fps target the same window is far under it.
    expect(scaler.observe(budget(30, 33.3))).toBeUndefined();
    const at60 = new ResolutionScaler({ targetFps: 60 });
    feed(at60, 60, RESOLUTION_SCALER.warmupWindows);
    expect(at60.observe(gpuBudget(30, 1_000 / 30, 33.3))).toBe(0.61);
  });

  it("refuses a target it cannot hold a budget against", () => {
    for (const bad of [0, -60, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new ResolutionScaler({ targetFps: bad }), `targetFps ${String(bad)}`).toThrow(
        /targetFps/u,
      );
    }
    expect(() => new ResolutionScaler({ start: 0.5, targetFps: 60 })).toThrow(/rung/u);
  });

  it("judges a stalled window on its ordinary frame when that frame alone misses the budget", () => {
    // PRD-549, Intel Iris Xe: shadow redraws stall every window (p99 ~16x p50), and the ordinary
    // frame is still slow (p50 11 ms, GPU 25 ms against 8.33). Deferring every such window held
    // the scale at 1.0 for the whole walk.
    const weak = new ResolutionScaler({ targetFps: 120 });
    weak.observe({ fps: 120, presented: { p50: 8.3, p95: 8.3, p99: 8.3, max: 8.3 } });
    const stalledSlow = {
      fps: 37,
      gpuAgeFrames: 0,
      gpuMs: 25,
      presented: { p50: 11, p95: 60, p99: 180, max: 350 },
    };
    expect(weak.observe(stalledSlow)).toBeLessThan(1);

    // The laptop's measured window (live11, Iris Xe): the presented median reads 7 ms because the
    // GPU-bound frame does not show in the present interval, while the main pass is 30 ms and the
    // window runs at 35 fps. The GPU is the evidence, not the present median.
    const igpu = new ResolutionScaler({ targetFps: 120 });
    igpu.observe({ fps: 120, presented: { p50: 8.3, p95: 8.3, p99: 8.3, max: 8.3 } });
    expect(
      igpu.observe({
        fps: 35,
        gpuAgeFrames: 0,
        gpuMs: 30,
        presented: { p50: 7, p95: 40, p99: 230, max: 900 },
      }),
    ).toBeLessThan(1);

    // live12 on the same laptop: the last resolve at window close is 438 frames old, past
    // `maxGpuAgeFrames`, yet the window holds 25 GPU samples of its own at a 39 ms median. Those
    // samples are this window's, so they are fresh however late the last one resolved.
    const lagged = new ResolutionScaler({ targetFps: 120 });
    lagged.observe({ fps: 120, presented: { p50: 8.3, p95: 8.3, p99: 8.3, max: 8.3 } });
    expect(
      lagged.observe({
        fps: 41,
        gpu: { p50: 39, samples: 25 },
        gpuAgeFrames: 438,
        gpuMs: 38.9,
        presented: { p50: 10.6, p95: 101, p99: 235, max: 900 },
      }),
    ).toBeLessThan(1);

    // A game whose ordinary frame meets its target keeps the stall deferral: its hitches are not
    // a frame rate, and fewer pixels would not bring them back.
    const hitchy = new ResolutionScaler({ targetFps: 60 });
    hitchy.observe({ fps: 60, presented: { p50: 16.6, p95: 16.7, p99: 16.7, max: 16.7 } });
    expect(
      hitchy.observe({
        fps: 55,
        gpuAgeFrames: 0,
        gpuMs: 7,
        presented: { p50: 16.6, p95: 17, p99: 400, max: 420 },
      }),
    ).toBeUndefined();
    expect(hitchy.scale).toBe(1);

    // And a stalled window is never grounds to climb, whatever its GPU says.
    const low = new ResolutionScaler({ start: 0.72, targetFps: 120 });
    low.observe({ fps: 120, presented: { p50: 8.3, p95: 8.3, p99: 8.3, max: 8.3 } });
    for (let window = 0; window < 8; window += 1)
      low.observe({
        fps: 150,
        gpuAgeFrames: 0,
        gpuMs: 2,
        presented: { p50: 6, p95: 7, p99: 90, max: 120 },
      });
    expect(low.scale).toBe(0.72);
  });
});
