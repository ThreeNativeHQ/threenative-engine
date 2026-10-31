import { describe, expect, it } from "vitest";
import { retainTerrainBlendFrame } from "../../../examples/abyss-framework/src/scenes/TerrainProbe.js";
import { FRAME_BUDGET_MARKER, FrameBudget, type IFrameBudgetWindow } from "../src/frame-budget.js";
import {
  FixedStepLoop,
  type IRenderPerformanceMetrics,
  createAfterPhysicsPhase,
} from "../src/loop.js";
import { FRAME_PASS_KINDS, type IRenderPassSample } from "../src/render-pass-budget.js";

describe("FixedStepLoop", () => {
  it("rebases negotiated clock transitions and rearms a driven loop exactly once", () => {
    const callbacks = new Map<number, (time: number) => void>();
    let handle = 0;
    let now = 0;
    const loop = new FixedStepLoop({
      collectMetrics: true,
      now: () => now,
      onUpdate: () => undefined,
      requestFrame: (callback) => {
        callbacks.set(++handle, callback);
        return handle;
      },
      cancelFrame: (id) => {
        callbacks.delete(id);
      },
    });
    const pump = (time: number): void => {
      now = time;
      const entry = callbacks.entries().next().value;
      expect(entry).toBeDefined();
      if (entry === undefined) return;
      callbacks.delete(entry[0]);
      entry[1](time);
    };
    loop.start(0);
    loop.advance(2, { render: true });
    const priorSequence = loop.runtimeDiagnosticsSeries().at(-1)?.sequence ?? 0;
    expect(callbacks.size).toBe(0);
    loop._setClockMode("wall-clock");
    expect(callbacks.size).toBe(1);
    expect(loop.runtimeDiagnosticsSeries()).toEqual([]);
    pump(100_000);
    expect(loop.tick()).toBe(2);
    pump(100_020);
    expect(loop.tick()).toBe(3);
    expect(loop.runtimeDiagnosticsSeries().at(-1)?.sequence).toBeGreaterThan(priorSequence);
    const retained = loop.runtimeDiagnosticsSeries();
    expect(retained.at(-1)?.completedAtMs).toBe(100_020);
    loop._setClockMode("wall-clock");
    expect(loop.runtimeDiagnosticsSeries()).toEqual(retained);
    expect(callbacks.size).toBe(1);
    expect(() => loop._setClockMode("invalid" as "fixed-step")).toThrow(/clock mode/iu);
    expect(loop.clockFrozen).toBe(false);
    loop._setClockMode("fixed-step");
    pump(200_000);
    expect(loop.tick()).toBe(3);
    loop.advance(2, { render: true });
    expect(loop.tick()).toBe(5);
    loop.stop();
    loop._setClockMode("wall-clock");
    expect(callbacks.size).toBe(0);
  });

  it("should reject a maxSteps that can never run an update", () => {
    // A maxSteps of zero (or negative, or NaN) made the catch-up while-loop run
    // zero updates every frame, forever: the game rendered but never simulated,
    // with no error anywhere to name the cause.
    expect(() => new FixedStepLoop({ maxSteps: 0, onUpdate: () => undefined })).toThrow(
      /maxSteps/u,
    );
    expect(() => new FixedStepLoop({ maxSteps: -3, onUpdate: () => undefined })).toThrow(
      /maxSteps/u,
    );
    expect(() => new FixedStepLoop({ maxSteps: Number.NaN, onUpdate: () => undefined })).toThrow(
      /maxSteps/u,
    );
  });

  it("should reject a step that cannot make progress", () => {
    // A zero or negative step made the accumulator never shrink, so every frame
    // ran the full catch-up budget against time that had not passed.
    expect(() => new FixedStepLoop({ onUpdate: () => undefined, step: 0 })).toThrow(/step/u);
    expect(() => new FixedStepLoop({ onUpdate: () => undefined, step: -1 / 60 })).toThrow(/step/u);
    expect(() => new FixedStepLoop({ onUpdate: () => undefined, step: Number.NaN })).toThrow(
      /step/u,
    );
  });

  it("should call update exactly 60 times per simulated second", () => {
    let updates = 0;
    const loop = new FixedStepLoop({ onUpdate: () => updates++ });

    loop.stepFrame(0);
    for (let frame = 1; frame <= 60; frame++) loop.stepFrame((frame * 1_000) / 60);

    expect(updates).toBe(60);
  });

  it("should honor a configured step", () => {
    let updates = 0;
    const loop = new FixedStepLoop({ onUpdate: () => updates++, step: 1 / 30 });

    loop.stepFrame(0);
    for (let frame = 1; frame <= 60; frame++) loop.stepFrame((frame * 1_000) / 60);

    expect(updates).toBe(30);
  });

  it("should add at most 1/20 s of simulated time per frame by default", () => {
    // After Unreal's MaxPhysicsDeltaTime (UE 5.8.3: PhysicsSettings.cpp:22, PhysLevel.cpp:212). Five
    // catch-up ticks let an overloaded frame run five whole game updates: the stress lab at load 4
    // spent 52 ms of an 83 ms frame there, which made the next frame slower still.
    let updates = 0;
    const loop = new FixedStepLoop({ onUpdate: () => updates++ });
    loop.stepFrame(0);
    expect(loop.stepFrame(10_000)).toBe(3);
    expect(updates).toBe(3);

    // The leftover of a clamped frame is kept, so a steady 30 fps keeps real time.
    let thirty = 0;
    const steady = new FixedStepLoop({ onUpdate: () => thirty++ });
    steady.stepFrame(0);
    for (let frame = 1; frame <= 30; frame++) steady.stepFrame(Math.round((frame * 1_000) / 30));
    expect(thirty).toBe(60);

    // The named override turns the clamp off; maxSteps still bounds the frame.
    const legacy = new FixedStepLoop({
      onUpdate: () => undefined,
      maxPhysicsDeltaTime: Number.POSITIVE_INFINITY,
    });
    legacy.stepFrame(0);
    expect(legacy.stepFrame(10_000)).toBe(5);
    expect(() => new FixedStepLoop({ onUpdate: () => undefined, maxPhysicsDeltaTime: 0 })).toThrow(
      /maxPhysicsDeltaTime/u,
    );
  });

  it("should absorb a backgrounded app's time jump without a burst of updates", () => {
    // The native host pauses the loop when the player leaves and resumes it when they return
    // (PRD-210). Resuming hands `stepFrame` a `now` that is minutes ahead, and a phone whose
    // clock was adjusted while the app was parked can hand it one that moved backwards. Both are
    // already handled here — the elapsed clamp and the maxSteps budget — so the host asserts this
    // rather than building its own catch-up.
    const steps: number[] = [];
    const loop = new FixedStepLoop({ onUpdate: (step) => steps.push(step) });

    loop.stepFrame(0);
    const afterTenMinutes = loop.stepFrame(600_000);
    expect(afterTenMinutes).toBe(3);
    expect(steps).toHaveLength(3);
    expect(steps.every((step) => step > 0)).toBe(true);

    // A clock that went backwards must produce no update at all, never a negative one...
    steps.length = 0;
    expect(loop.stepFrame(500_000)).toBe(0);
    expect(steps).toHaveLength(0);

    // ...and must not poison the frames after it. Without the clamp the accumulator goes 100 s
    // negative and the game stops simulating for a hundred seconds while still rendering, which
    // reads as a freeze with no error anywhere.
    for (let frame = 1; frame <= 4; frame++) loop.stepFrame(600_000 + (frame * 1_000) / 60);
    expect(steps.length).toBeGreaterThan(0);
  });

  it("should expose a finite render FPS that decays after a stall", () => {
    const loop = new FixedStepLoop({ onUpdate: () => undefined });
    loop.stepFrame(0);
    expect(Number.isFinite(loop.fps)).toBe(true);
    for (let frame = 1; frame <= 60; frame++) loop.stepFrame((frame * 1_000) / 60);
    const steady = loop.fps;
    loop.stepFrame(10_000);

    expect(steady).toBeGreaterThan(0);
    expect(loop.fps).toBeGreaterThanOrEqual(0);
    expect(loop.fps).toBeLessThan(steady);
  });

  it("should record frame timing and renderer metrics after each rendered frame", () => {
    let clock = 0;
    const loop = new FixedStepLoop({
      now: () => clock,
      // The collector itself under test — a diagnostics consumer's view.
      collectMetrics: true,
      onRender: () => {
        clock += 1;
        return { drawCalls: 3, triangles: 24 };
      },
      onUpdate: () => undefined,
    });

    loop.stepFrame(0);
    loop.stepFrame(16);
    loop.stepFrame(32);

    expect(loop.runtimeDiagnosticsSeries()).toEqual([
      { completedAtMs: 2, sequence: 2, drawCalls: 3, frameMs: 16, triangles: 24 },
      { completedAtMs: 3, sequence: 3, drawCalls: 3, frameMs: 16, triangles: 24 },
    ]);
  });

  it("should schedule the next frame when rendering throws", () => {
    const callbacks: Array<(time: number) => void> = [];
    const loop = new FixedStepLoop({
      onRender: () => {
        throw new Error("renderer failed");
      },
      onUpdate: () => undefined,
      requestFrame: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });

    loop.start(0);
    expect(() => callbacks.shift()?.(16)).toThrow("renderer failed");
    expect(loop.running).toBe(true);
    expect(callbacks).toHaveLength(1);
  });

  it("should reuse one request-frame callback across 120 frames", () => {
    const callbacks: Array<(time: number) => void> = [];
    const identities = new Set<(time: number) => void>();
    const loop = new FixedStepLoop({
      onUpdate: () => undefined,
      requestFrame: (callback) => {
        callbacks.push(callback);
        identities.add(callback);
        return callbacks.length;
      },
    });

    loop.start(0);
    for (let frame = 1; frame <= 120; frame += 1) {
      const callback = callbacks.shift();
      if (callback === undefined) throw new Error("The loop did not schedule a frame.");
      callback(frame * 16);
    }

    expect(identities).toHaveLength(1);
    loop.stop();
  });

  it("should advance fixed ticks only while the loop is running", () => {
    let updates = 0;
    const loop = new FixedStepLoop({ onUpdate: () => updates++ });

    expect(() => loop.advance(1)).toThrow("Cannot advance a stopped loop.");
    loop.start(0);

    expect(loop.advance(3)).toBe(3);
    expect(updates).toBe(3);
    expect(loop.tick()).toBe(3);
  });

  it("meters each driven update inside its render frame", () => {
    let clock = 0;
    const events: string[] = [];
    const budget = new FrameBudget({ report: () => undefined });
    const loop = new FixedStepLoop({
      budget,
      now: () => clock,
      onBeginFrame: () => {
        events.push("begin");
      },
      onUpdate: () => {
        events.push("update");
        clock += 2;
      },
      onRender: () => {
        events.push("render");
        clock += 3;
        return undefined;
      },
      onFrame: () => {
        events.push("end");
      },
    });
    loop.start(0);
    expect(loop.advance(4, { render: true })).toBe(4);
    expect(events).toEqual(
      Array.from({ length: 4 }, () => ["begin", "update", "render", "end"]).flat(),
    );
    expect(loop.tick()).toBe(4);
    expect(budget.window().frames).toBe(4);
    expect(budget.window().phases.update.p50).toBe(2);
    expect(budget.window().frame.p50).toBe(5);
    loop.stop();
  });

  it("keeps startup and host-owned automatic renders until full-frame driving begins", () => {
    const callbacks: Array<(time: number) => void> = [];
    let renders = 0;
    let updates = 0;
    const loop = new FixedStepLoop({
      requestFrame: (callback) => callbacks.push(callback),
      onUpdate: () => {
        updates += 1;
      },
      onRender: () => {
        renders += 1;
        return undefined;
      },
    });
    loop.freezeClock(0);
    loop.setHeld(true);
    loop.start(0);
    callbacks.shift()?.(16);
    expect({ updates, renders }).toEqual({ updates: 0, renders: 1 });
    loop.setHeld(false);
    loop.advance(1, { render: false });
    expect({ updates, renders }).toEqual({ updates: 1, renders: 1 });
    callbacks.shift()?.(32);
    expect({ updates, renders }).toEqual({ updates: 1, renders: 2 });
    expect(callbacks).toHaveLength(1);
    loop.stop();
  });

  it("should ignore live frames after switching to the advanced clock", () => {
    let updates = 0;
    const loop = new FixedStepLoop({ onUpdate: () => updates++ });
    loop.start(0);

    loop.advance(10);
    expect(loop.stepFrame(20)).toBe(0);
    expect(loop.stepFrame(37)).toBe(0);
    expect(loop.stepFrame(10_000)).toBe(0);

    expect(updates).toBe(10);
    expect(loop.tick()).toBe(10);
  });

  it("should count wall-clock updates before the manual clock engages", () => {
    const loop = new FixedStepLoop({ onUpdate: () => undefined });
    loop.start(0);

    loop.stepFrame(20);
    loop.advance(2);

    expect(loop.tick()).toBe(3);
  });

  it("rejects an invalid settle count without freezing the clock", () => {
    const loop = new FixedStepLoop({ onUpdate: () => undefined });
    expect(() => loop.freezeClock(-1)).toThrow(/settleSteps/u);
    expect(() => loop.freezeClock(1.5)).toThrow(/settleSteps/u);
    expect(loop.clockFrozen).toBe(false);
  });

  it("advances no frames after the clock is frozen before the run", () => {
    // A browser playtest runner announces itself before the page loads and then pumps live frames
    // through the whole startup compile wait. Those frames used to advance a tick-counting
    // simulation by wall clock, so the run began with an arbitrary amount of game time already
    // spent -- and racing's `elapsed` DNFs a 90s race that the scenario needs only 47s to finish.
    const dts: number[] = [];
    const loop = new FixedStepLoop({ onUpdate: (dt) => dts.push(dt) });
    loop.freezeClock();
    expect(loop.clockFrozen).toBe(true);
    loop.start(0);

    // Two seconds of live frames at 60 Hz: 120 updates if the clock still drove the loop, and the
    // one fixed settling pass the freeze owes the world instead -- 60 steps, every one of them the
    // same 1/60s whatever the machine is doing.
    for (let frame = 1; frame <= 120; frame += 1) expect(loop.stepFrame(frame * 16.6667)).toBe(0);

    expect(dts).toHaveLength(60);
    expect(new Set(dts)).toEqual(new Set([1 / 60]));
    expect(loop.tick()).toBe(60);

    // The manual clock is still the one that moves the simulation, and it does not re-arm the
    // settle: a run must not gain a second world per step the runner counts.
    expect(loop.advance(3)).toBe(3);
    expect(loop.tick()).toBe(63);
    for (let frame = 121; frame <= 240; frame += 1) expect(loop.stepFrame(frame * 16.6667)).toBe(0);
    expect(dts).toHaveLength(63);
    expect(loop.tick()).toBe(63);
  });

  it("settles on the first live frame after the freeze, not on a held boot frame", () => {
    // The boot hold covers the load, and the scene has not entered while it is set, so a settle
    // spent there would settle nothing. The arm survives it and fires when the loop is live.
    const dts: number[] = [];
    const loop = new FixedStepLoop({ onUpdate: (dt) => dts.push(dt) });
    loop.freezeClock(3);
    loop.setHeld(true);
    loop.start(0);
    loop.stepFrame(16.6667);
    loop.stepFrame(33.3333);
    expect(dts).toEqual([]);

    loop.setHeld(false);
    loop.stepFrame(50);
    expect(dts).toHaveLength(3);
    loop.stepFrame(66.6667);
    expect(dts).toHaveLength(3);
  });

  it("spends no settle after a counted step reached the loop first", () => {
    // A host whose first live frame lands after the runner's first `advance(1)` (the Perry desktop
    // host, after a 6.4 s first present) fired the settle inside that step: 61 ticks for 1.
    const dts: number[] = [];
    const loop = new FixedStepLoop({ onUpdate: (dt) => dts.push(dt) });
    loop.freezeClock(60);
    loop.start(0);
    expect(loop.advance(1)).toBe(1);
    loop.stepFrame(16.6667);
    expect(dts).toHaveLength(1);
    expect(loop.tick()).toBe(1);
  });

  it("settles nothing when the freeze is asked for no steps", () => {
    // The count is the knob, and zero is a real answer: a caller that wants the world exactly as
    // the game built it says so rather than having it settle anyway.
    const dts: number[] = [];
    const loop = new FixedStepLoop({ onUpdate: (dt) => dts.push(dt) });
    loop.freezeClock(0);
    loop.start(0);
    loop.stepFrame(16.6667);
    expect(dts).toEqual([]);
    expect(loop.tick()).toBe(0);
    expect(loop.clockFrozen).toBe(true);
    expect(() => loop.freezeClock(-1)).toThrow(/settleSteps/u);
    expect(() => loop.freezeClock(1.5)).toThrow(/settleSteps/u);
  });

  /**
   * One tick-counted run of 300 presented frames, with a 10-tick `advance()` batch before every
   * other frame when `batches` is on. The clock is frozen, so a live frame simulates nothing and the
   * batches are the only simulation; each of a batch's 10 updates costs half a millisecond and each
   * live frame renders a fixed 12 ms. The only difference between the two runs is the batches.
   */
  function runTickCountedWindow(batches: boolean): IFrameBudgetWindow[] {
    const markers: string[] = [];
    let clock = 0;
    const budget = new FrameBudget({
      report: (line) => markers.push(line),
      reportEvery: 300,
    });
    const loop = new FixedStepLoop({
      budget,
      now: () => clock,
      onRender: () => {
        budget.addRender(12);
        return undefined;
      },
      onUpdate: () => {
        clock += 0.5;
      },
    });

    loop.freezeClock(0);
    loop.start(0);
    for (let frame = 1; frame <= 300; frame += 1) {
      if (batches && frame % 2 === 0) loop.advance(10);
      loop.stepFrame(frame * 16.6667);
    }
    return markers
      .filter((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`))
      .map(
        (line) => JSON.parse(line.slice(`${FRAME_BUDGET_MARKER}:`.length)) as IFrameBudgetWindow,
      );
  }

  it("charges a counted tick batch to update and substeps without counting it as a frame", () => {
    // A playtest runner counts ticks rather than milliseconds, so `advance()` is how the whole run
    // simulates, and its cost used to run outside the meter entirely: `phases.update` read 0 ms and
    // `substeps` read 0. Opening a metered frame around the batch fixed that reading and broke three
    // others -- the batch drew nothing, so half of every window's frame/render percentiles were
    // zeroes, its timestamp moved the present clock, and the window closed on 300 *metered* frames
    // rather than 300 presented ones, which is how a 300-frame window came to hold ~20 GPU
    // timestamp samples instead of ~37. The cost is reported; the batch is not a frame.
    const windows = runTickCountedWindow(true);

    expect(windows.length, `300 presented frames reported ${windows.length} windows`).toBe(1);
    const window = windows[0] as IFrameBudgetWindow;
    expect(window.frames).toBe(300);
    // The cost of 150 batches of 10 half-millisecond updates, reported in the two series that
    // describe simulation: 5 ms per batch, 10 steps per batch.
    expect(window.phases.update.p95).toBe(5);
    expect(window.substeps.max).toBe(10);
    // One entry per presented frame *and* per batch -- 300 + 150. A batch is measured, not counted.
    expect(window.phases.update.samples).toBe(450);
    expect(window.substeps.samples).toBe(450);
    // The presented-interval series holds one interval per presented frame and none for the 150
    // batches; the first frame has no predecessor, so 299 is every presented frame's interval.
    expect(window.presented.samples).toBe(299);
    expect(window.hitches).toBe(0);
  });

  it("does not dilute the render percentiles of presented frames with counted batches", () => {
    // The measured regression of opening a frame per batch: 150 batches entered the render phase as
    // zero-millisecond frames, so the window's mean render cost read 7.4 ms on a machine that
    // rendered 12 ms every frame, and a 120 fps acceptance reading those percentiles saw a game that
    // renders nothing half the time. The batch's cost is reported in `update`; the frame and render
    // series describe presented frames only, so they must read identically with and without batches.
    const batched = runTickCountedWindow(true);
    const plain = runTickCountedWindow(false);

    expect(batched[0]?.phases.render).toEqual(plain[0]?.phases.render);
    expect(batched[0]?.frame).toEqual(plain[0]?.frame);
  });

  it("charges a counted batch once when a frozen prime advances inside a live frame", () => {
    // The settling pass `#primeFrame` runs is `advance()` itself, called from inside the frame that
    // armed it -- so the batch cannot open a second metered frame on top of the open one, and its
    // cost belongs to the enclosing frame's update exactly once.
    let clock = 0;
    const budget = new FrameBudget({ report: () => undefined, reportEvery: 1000 });
    const loop = new FixedStepLoop({
      budget,
      now: () => clock,
      onUpdate: () => {
        clock += 1;
      },
      onRender: () => undefined,
    });
    loop.freezeClock(5);
    loop.start(0);

    loop.stepFrame(16.6667);
    const window = budget.window();
    expect(window.frames).toBe(1);
    // Five 1 ms steps, charged to the enclosing frame's update once -- not twice, and not on a
    // second frame opened on top of the open one.
    expect(window.phases.update.p50).toBe(5);
    expect(window.frame.p50).toBe(5);
  });

  it("reports the actual callback duration separately from presentation timestamps", () => {
    let clock = 0;
    const frameDurations: number[] = [];
    const loop = new FixedStepLoop({
      now: () => clock,
      onFrame: (frameMs) => frameDurations.push(frameMs),
      onRender: () => {
        clock += 12;
        return undefined;
      },
      onUpdate: () => undefined,
    });

    loop.stepFrame(0);
    loop.stepFrame(1_000);

    expect(frameDurations).toEqual([12, 12]);
  });
});

describe("FixedStepLoop metrics collection", () => {
  function makeLoop(collectMetrics?: boolean) {
    const state = { renders: 0 };
    const loop = new FixedStepLoop({
      collectMetrics,
      onUpdate: () => undefined,
      onRender: () => {
        state.renders += 1;
        return { drawCalls: state.renders, triangles: state.renders * 3 };
      },
    });
    return { loop, state };
  }

  it("records completion cadence including outer-loop delay without changing frameMs", () => {
    let clock = 10;
    const callbackMs: number[] = [];
    const loop = new FixedStepLoop({
      collectMetrics: true,
      now: () => clock,
      onUpdate: () => undefined,
      onRender: () => {
        clock += 2;
        return undefined;
      },
      onFrame: (ms) => callbackMs.push(ms),
    });
    loop.stepFrame(0);
    clock = 40;
    loop.stepFrame(16);
    clock = 90;
    loop.stepFrame(32);
    expect(callbackMs).toEqual([2, 2, 2]);
    expect(loop.runtimeDiagnosticsSeries()).toEqual([
      { frameMs: 16, sequence: 2, completedAtMs: 42 },
      { frameMs: 16, sequence: 3, completedAtMs: 92 },
    ]);
  });

  it("counts successful completions only and exposes collection gaps and clears", () => {
    let clock = 0;
    let fail = false;
    const loop = new FixedStepLoop({
      collectMetrics: true,
      now: () => clock,
      onUpdate: () => undefined,
      onRender: () => {
        clock += 1;
        if (fail) throw new Error("render failed");
        return undefined;
      },
    });
    loop.start(0);
    loop.stepFrame(0);
    loop.advance(2, { render: false });
    fail = true;
    expect(() => loop.stepFrame(16)).toThrow("render failed");
    expect(loop.runtimeDiagnosticsSeries()).toEqual([]);
    fail = false;
    loop.stepFrame(32);
    expect(loop.runtimeDiagnosticsSeries()[0]?.sequence).toBe(2);
    loop.setCollectMetrics(false);
    loop.stepFrame(48);
    loop.setCollectMetrics(true);
    loop.stepFrame(64);
    expect(loop.runtimeDiagnosticsSeries().map((s) => s.sequence)).toEqual([2, 4]);
    loop.clearRuntimeDiagnostics();
    loop.stepFrame(80);
    expect(loop.runtimeDiagnosticsSeries().map((s) => s.sequence)).toEqual([5]);
    loop.stop();
  });

  it("keeps absolute completion IDs through bounded retention and copied snapshots", () => {
    let clock = 0;
    const loop = new FixedStepLoop({
      collectMetrics: true,
      now: () => clock,
      onUpdate: () => undefined,
      onRender: () => {
        clock += 1;
        return undefined;
      },
    });
    for (let frame = 1; frame <= 1_027; frame += 1) loop.stepFrame(frame * 16);
    const series = loop.runtimeDiagnosticsSeries();
    expect(series).toHaveLength(1_024);
    expect(series[0]).toMatchObject({ sequence: 4, completedAtMs: 4 });
    expect(series.at(-1)).toMatchObject({ sequence: 1_027, completedAtMs: 1_027 });
    Object.assign(series[0] ?? {}, { sequence: -1, completedAtMs: -1 });
    expect(loop.runtimeDiagnosticsSeries()[0]).toMatchObject({ sequence: 4, completedAtMs: 4 });
  });

  it("retains invalid completion intervals for later fail-closed consumption", () => {
    let clock = 10;
    const loop = new FixedStepLoop({
      collectMetrics: true,
      now: () => clock,
      onUpdate: () => undefined,
    });
    loop.stepFrame(0);
    loop.stepFrame(16);
    clock = 5;
    loop.stepFrame(32);
    clock = Number.NaN;
    loop.stepFrame(48);
    const series = loop.runtimeDiagnosticsSeries();
    expect(series.map((s) => s.sequence)).toEqual([2, 3, 4]);
    expect(series.map((s) => s.completedAtMs)).toEqual([10, 5, Number.NaN]);
    expect(series.map((s) => s.frameMs)).toEqual([16, 16, 16]);
  });

  it("collects no samples by default - nothing reads them outside a diagnostics consumer", () => {
    const { loop } = makeLoop();
    loop.start(0);
    for (let index = 1; index <= 5; index += 1) loop.stepFrame(index * 16);
    expect(loop.runtimeDiagnosticsSeries()).toHaveLength(0);
  });

  it("does not create a disabled metrics record for a rendered frame", () => {
    const rendered: Array<undefined | IRenderPerformanceMetrics> = [];
    const loop = new FixedStepLoop({
      onUpdate: () => undefined,
      onRender: () => {
        const metrics = undefined;
        rendered.push(metrics);
        return metrics;
      },
    });

    loop.start(0);
    loop.stepFrame(16);

    expect(rendered).toEqual([undefined]);
  });

  it("still calls onRender every frame while collecting nothing", () => {
    const { loop, state } = makeLoop();
    loop.start(0);
    for (let index = 1; index <= 3; index += 1) loop.stepFrame(index * 16);
    expect(state.renders).toBe(3);
  });

  it("collects one sample per rendered frame when collectMetrics is true", () => {
    const { loop } = makeLoop(true);
    loop.start(0);
    // The first rendered frame only establishes the previous-render timestamp; sampling starts
    // with the second, exactly as the always-on collector behaved.
    for (let index = 1; index <= 5; index += 1) loop.stepFrame(index * 16);
    const series = loop.runtimeDiagnosticsSeries();
    expect(series).toHaveLength(4);
    expect(series[0]?.drawCalls).toBeGreaterThan(0);
  });

  it("starts collecting only from enablement when enabled mid-run", () => {
    const { loop } = makeLoop(false);
    loop.start(0);
    loop.stepFrame(16);
    expect(loop.runtimeDiagnosticsSeries()).toHaveLength(0);
    loop.setCollectMetrics(true);
    loop.stepFrame(32);
    expect(loop.runtimeDiagnosticsSeries()).toHaveLength(1);
  });

  it("forgets the samples taken so far and collects the frames after them", () => {
    const { loop } = makeLoop(true);
    loop.start(0);
    for (let index = 1; index <= 4; index += 1) loop.stepFrame(index * 16);
    expect(loop.runtimeDiagnosticsSeries()).toHaveLength(3);
    loop.clearRuntimeDiagnostics();
    expect(loop.runtimeDiagnosticsSeries()).toHaveLength(0);
    loop.stepFrame(80);
    expect(loop.runtimeDiagnosticsSeries()).toHaveLength(1);
  });

  it("renders but does not simulate, tick or bank time while held", () => {
    // Boot holds the loop so a loading screen can draw before the start scene has loaded. Three
    // things have to survive that hold: nothing is stepped, `tick()` still reads zero -- the
    // determinism contract every playtest hold rests on, and `#tick` advances inside the very
    // block a naive "skip the callback" gate would leave running -- and no elapsed time is
    // banked, or the first real tick arrives with a dt spanning the whole asset load.
    const steps: number[] = [];
    let renders = 0;
    const loop = new FixedStepLoop({
      onUpdate: (dt) => steps.push(dt),
      onRender: () => {
        renders += 1;
        return undefined;
      },
    });

    loop.setHeld(true);
    expect(loop.held).toBe(true);
    loop.start(0);
    // Two seconds of held frames: unheld, this is 120 updates.
    for (let frame = 1; frame <= 120; frame += 1) expect(loop.stepFrame(frame * 16.6667)).toBe(0);

    expect(renders).toBe(120);
    expect(steps).toHaveLength(0);
    expect(loop.tick()).toBe(0);

    loop.setHeld(false);
    expect(loop.held).toBe(false);
    // One ordinary frame after release. A loop that banked the hold would spend its whole
    // catch-up budget here instead of running the single step the frame is worth.
    expect(loop.stepFrame(121 * 16.6667)).toBe(1);
    expect(steps).toEqual([1 / 60]);
    expect(loop.tick()).toBe(1);
  });
});

describe("FixedStepLoop retained render samples", () => {
  // One frame of 30 nested render() calls across all four kinds: a shadow-casting cathedral with a
  // post chain. The retained sample used to carry one entry per call, so a full window no longer
  // fitted the playtest bridge's payload and `assert.performance` died before frame 0.
  function nestedPasses(): IRenderPassSample[] {
    return Array.from({ length: 30 }, (_, index) => ({
      draws: index + 1,
      kind: FRAME_PASS_KINDS[index % 4] ?? "nested",
      triangles: (index + 1) * 10,
    }));
  }
  function makeNestedLoop() {
    return new FixedStepLoop({
      collectMetrics: true,
      onRender: () => ({ drawCalls: 465, passes: nestedPasses(), triangles: 4_650 }),
      onUpdate: () => undefined,
    });
  }

  it("keeps one entry per pass kind, summed over that frame's render calls", () => {
    const loop = makeNestedLoop();
    loop.start(0);
    // The first frame only establishes the previous-render timestamp; samples start from the second.
    loop.stepFrame(16);
    loop.stepFrame(32);

    // Summed per kind, not the first call of each: 1+5+...+29 draws is the whole main lane.
    expect(loop.runtimeDiagnosticsSeries()[0]?.passes).toEqual([
      { draws: 120, kind: "main", triangles: 1_200 },
      { draws: 128, kind: "shadow", triangles: 1_280 },
      { draws: 105, kind: "reflection", triangles: 1_050 },
      { draws: 112, kind: "nested", triangles: 1_120 },
    ]);
  });

  it("serialises a full 1,024-sample window under the bridge's 1 MB payload ceiling", () => {
    // The ceiling the runner enforces on every observation (`assertBoundedPayload`), restated
    // rather than imported: core does not depend on the playtest package.
    const loop = makeNestedLoop();
    loop.start(0);
    // One frame only establishes the previous-render timestamp, so samples start from the second.
    for (let frame = 1; frame <= 1_026; frame += 1) loop.stepFrame(frame * 16);
    const series = loop.runtimeDiagnosticsSeries();

    expect(series).toHaveLength(1_024);
    expect(JSON.stringify(series).length).toBeLessThan(1_000_000);
  });
});

describe("after-physics phase dispatch", () => {
  it("runs a callback registered during dispatch on the next run only", () => {
    const phase = createAfterPhysicsPhase();
    const seen: string[] = [];
    phase.register(() => {
      seen.push("first");
      phase.register(() => seen.push("late"));
    });
    phase.run(1 / 60);
    expect(seen).toEqual(["first"]);
    phase.run(1 / 60);
    expect(seen).toEqual(["first", "first", "late"]);
  });

  it("still runs a snapshotted callback removed by an earlier one", () => {
    const phase = createAfterPhysicsPhase();
    const seen: string[] = [];
    let removeSecond: () => void = () => undefined;
    phase.register(() => {
      seen.push("first");
      removeSecond();
    });
    removeSecond = phase.register(() => seen.push("second"));
    phase.run(1 / 60);
    expect(seen).toEqual(["first", "second"]);
  });

  it("drops cleared callbacks before the next run", () => {
    const phase = createAfterPhysicsPhase();
    let calls = 0;
    phase.register(() => {
      calls += 1;
    });
    phase.clear();
    phase.run(1 / 60);
    expect(calls).toBe(0);
  });

  it("keeps a nested dispatch from clobbering the outer snapshot", () => {
    const phase = createAfterPhysicsPhase();
    const seen: string[] = [];
    let nested = false;
    phase.register(() => {
      seen.push("outer");
      if (!nested) {
        nested = true;
        phase.run(1 / 60);
      }
    });
    phase.register(() => seen.push("second"));
    phase.run(1 / 60);
    expect(seen).toEqual(["outer", "outer", "second", "second"]);
  });

  it("leaves the deep pool clean after a callback throws", () => {
    const phase = createAfterPhysicsPhase();
    const seen: string[] = [];
    phase.register(() => {
      throw new Error("callback failed");
    });
    expect(() => phase.run(1 / 60)).toThrow("callback failed");
    phase.clear();
    phase.register(() => seen.push("after"));
    phase.run(1 / 60);
    expect(seen).toEqual(["after"]);
  });
});

describe("terrain draw interval retention", () => {
  it("closes the preceding draw with its own blend count, not the next draw's count", () => {
    const entries: { frame: number; startedAt: number; blendingTiles: number; frameMs?: number }[] =
      [];
    retainTerrainBlendFrame(entries, 100, 5);
    expect(entries).toEqual([{ frame: 0, startedAt: 100, blendingTiles: 5 }]);
    retainTerrainBlendFrame(entries, 170, 0);
    retainTerrainBlendFrame(entries, 180, 2);
    expect(entries).toEqual([
      { frame: 0, startedAt: 100, blendingTiles: 5, frameMs: 70 },
      { frame: 1, startedAt: 170, blendingTiles: 0, frameMs: 10 },
      { frame: 2, startedAt: 180, blendingTiles: 2 },
    ]);
    for (let i = 3; i <= 1025; i++) retainTerrainBlendFrame(entries, 180 + i, i % 2);
    expect(entries).toHaveLength(1024);
    expect(entries[0]?.frame).toBe(2);
    expect(entries.at(-1)?.frame).toBe(1025);
  });
});

describe("render-only frames", () => {
  it("draws the standing world without advancing the simulation after the clock is driven", () => {
    // A native deterministic screenshot arrives after the last `advance(render:true)`, when the
    // automatic frame pump is off: nothing presents, so the copy never happens. The render-only
    // operation draws once and must not move the tick, an update or a physics step — a screenshot
    // that settles the world by a frame is a false observation.
    let updates = 0;
    let afterPhysics = 0;
    let renders = 0;
    const loop = new FixedStepLoop({
      now: () => 0,
      onUpdate: () => {
        updates += 1;
      },
      onAfterPhysics: () => {
        afterPhysics += 1;
      },
      onRender: () => {
        renders += 1;
        return undefined;
      },
    });
    loop.start(0);
    loop.advance(3, { render: true });
    expect({ afterPhysics, renders, tick: loop.tick(), updates }).toEqual({
      afterPhysics: 3,
      renders: 3,
      tick: 3,
      updates: 3,
    });

    loop.renderCurrentFrame();

    expect({ afterPhysics, renders, tick: loop.tick(), updates }).toEqual({
      afterPhysics: 3,
      renders: 4,
      tick: 3,
      updates: 3,
    });
    loop.stop();
  });

  it("keeps the frozen startup settle for the next ordinary frame, not the render-only frame", () => {
    // The freeze's settle runs on the first *live* frame; a render-only screenshot taken before
    // that frame must not spend it, or the capture would advance physics and the settle would be
    // gone when the world genuinely starts.
    let updates = 0;
    let afterPhysics = 0;
    let renders = 0;
    const loop = new FixedStepLoop({
      now: () => 0,
      onUpdate: () => {
        updates += 1;
      },
      onAfterPhysics: () => {
        afterPhysics += 1;
      },
      onRender: () => {
        renders += 1;
        return undefined;
      },
    });
    try {
      loop.freezeClock(2);
      loop.start(0);

      loop.renderCurrentFrame();

      expect({ afterPhysics, renders, tick: loop.tick(), updates }).toEqual({
        afterPhysics: 0,
        renders: 1,
        tick: 0,
        updates: 0,
      });

      loop.stepFrame(0);

      expect({ afterPhysics, renders, tick: loop.tick(), updates }).toEqual({
        afterPhysics: 2,
        renders: 2,
        tick: 2,
        updates: 2,
      });
    } finally {
      loop.stop();
    }
  });

  it("refuses a render-only frame while the live clock is not frozen", () => {
    // A live loop advances through its own frames; a render-only call that silently stepped it
    // would be a simulation change wearing a screenshot's name.
    const loop = new FixedStepLoop({ onUpdate: () => undefined });
    loop.start(0);
    expect(() => loop.renderCurrentFrame()).toThrow(/frozen/iu);
    loop.stop();
  });
});
