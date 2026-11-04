import { PerspectiveCamera, Scene } from "three";
import { expect, test, vi } from "vitest";
import { type IPlaytestBridgeV1, PLAYTEST_BRIDGE_GLOBAL } from "../../playtest/src/protocol.js";
import type { IGamePluginRuntime } from "../src/game.js";
import { FixedStepLoop } from "../src/loop.js";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL, playtest } from "../src/playtest.js";
import type { ICtx } from "../src/scene.js";

/**
 * The settling pass a freeze owes the world lands on the world, not on whatever scene the first
 * live frame happens to draw.
 *
 * A game that boots through a loading scene settles the loading scene when the loop spends the
 * pass on its first live frame: the fixed steps ran, the world's own clock never saw them, and how
 * many were lost depended on how fast the machine booted. Two engines reached the same anchor with
 * 1.0 s of game time between them on the sailing template's pose for exactly this reason. A runner
 * therefore freezes with zero steps when the runtime can settle on demand, and spends the pass once
 * the start scene has entered.
 */
test("spends the settling pass after the start scene enters, not on the first live frame", async () => {
  vi.stubGlobal(PLAYTEST_RUNNER_EXPECTED_GLOBAL, true);
  let updates = 0;
  const loop = new FixedStepLoop({
    step: 1 / 60,
    onUpdate: () => {
      updates += 1;
    },
  });
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const settleTicks: number[] = [];
  const freezeSteps: Array<number | undefined> = [];
  const runtime: IGamePluginRuntime = {
    // The world's scene enters only after the hold is released, as the browser engines do.
    holdStart: (gate) => gate.then(() => entered),
    startSceneLoaded: async () => undefined,
    freezeClock: (settleSteps) => {
      freezeSteps.push(settleSteps);
      loop.freezeClock(settleSteps);
    },
    settleClock: (steps) => {
      settleTicks.push(loop.tick());
      loop.settleNow(steps);
    },
    tick: loop.tick,
    // The settle path never steps on demand; a stepping playtest would.
    fixedStep: () => 0,
    step: 1 / 60,
    seed: null,
    observations: { contribute: () => () => undefined, contributions: () => [] },
  };
  const ctx = {
    camera: new PerspectiveCamera(),
    scene: new Scene(),
    renderer: {
      raw: {
        getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) =>
          target.set(1280, 720),
      },
    },
    entities: { snapshot: () => ({}), forEach: () => undefined, get: () => undefined },
    state: { flush: () => undefined, getState: () => ({}) },
    assets: {
      resolved: new Map(),
      cache: {
        enabled: false,
        reason: "test stub",
        persisted: false,
        hits: 0,
        misses: 0,
        bytesOnDisk: 0,
        bytesTotal: 0,
        filling: false,
        backgroundFill: false,
      },
    },
    random: { state: 0 },
    startup: { phase: "ready", progress: 1 },
  } as unknown as ICtx;
  let cleanup: (() => void) | undefined;
  try {
    cleanup = await playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 }).setup?.(
      ctx,
      runtime,
    );
    loop.start(0);
    loop.setHeld(true);
    // The freeze names no steps: a frame that lands before the runner's describe() spends nothing.
    expect(freezeSteps).toEqual([0]);
    loop.stepFrame(16);
    expect({ updates, tick: loop.tick() }).toEqual({ updates: 0, tick: 0 });

    const bridge = (globalThis as Record<string, unknown>)[
      PLAYTEST_BRIDGE_GLOBAL
    ] as IPlaytestBridgeV1;
    if (bridge === undefined) throw new Error("The production plugin did not install its bridge.");
    // The loading scene runs while the world has not entered: those frames are held, and the
    // world's own clock must not move.
    loop.setHeld(false);
    loop.stepFrame(32);
    expect({ updates, tick: loop.tick() }).toEqual({ updates: 0, tick: 0 });

    const describing = bridge.describe();
    await Promise.resolve();
    expect(settleTicks).toEqual([]);
    enter();
    await describing;
    // Once, on the world, at the anchor the run reads: 60 steps and 60 ticks.
    expect(settleTicks).toEqual([0]);
    expect(loop.tick()).toBe(60);
    expect(updates).toBe(60);
    // A second describe() does not settle again, and the counted clock still owns the simulation.
    await bridge.describe();
    expect(settleTicks).toEqual([0]);
    expect(loop.tick()).toBe(60);
    loop.advance(2);
    expect({ updates, tick: loop.tick() }).toEqual({ updates: 62, tick: 62 });
  } finally {
    loop.stop();
    cleanup?.();
    vi.unstubAllGlobals();
  }
});

/** The `ICtx` the production plugin reads, and nothing a settle test does not touch. */
function stubCtx(): ICtx {
  return {
    camera: new PerspectiveCamera(),
    scene: new Scene(),
    renderer: {
      raw: {
        getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) =>
          target.set(1280, 720),
      },
    },
    entities: { snapshot: () => ({}), forEach: () => undefined, get: () => undefined },
    state: { flush: () => undefined, getState: () => ({}) },
    assets: {
      resolved: new Map(),
      cache: {
        enabled: false,
        reason: "test stub",
        persisted: false,
        hits: 0,
        misses: 0,
        bytesOnDisk: 0,
        bytesTotal: 0,
        filling: false,
        backgroundFill: false,
      },
    },
    random: { state: 0 },
    startup: { phase: "ready", progress: 1 },
  } as unknown as ICtx;
}

/** A runtime that can freeze, settle and switch clock mode, wired to the real loop. */
function stubRuntime(
  loop: FixedStepLoop,
  freezeSteps: Array<number | undefined>,
  settleTicks: number[],
): IGamePluginRuntime & { _setClockMode(mode: "fixed-step" | "wall-clock"): void } {
  return {
    holdStart: (gate) => gate,
    startSceneLoaded: async () => undefined,
    freezeClock: (settleSteps) => {
      freezeSteps.push(settleSteps);
      loop.freezeClock(settleSteps);
    },
    settleClock: (steps) => {
      settleTicks.push(loop.tick());
      loop.settleNow(steps);
    },
    _setClockMode: (mode) => loop._setClockMode(mode),
    tick: loop.tick,
    // The settle path never steps on demand; a stepping playtest would.
    fixedStep: () => 0,
    step: 1 / 60,
    seed: null,
    observations: { contribute: () => () => undefined, contributions: () => [] },
  };
}

test("keeps the frame's own settle when the game asked for no hold", async () => {
  // Setup runs for every runner, held or not, so a game with `holdUntilAttached: false` was frozen
  // with zero steps and had no `describe()` to spend them from: the world stayed exactly as the
  // game built it for the whole run. The zero freeze belongs to the hold that spends it.
  vi.stubGlobal(PLAYTEST_RUNNER_EXPECTED_GLOBAL, true);
  let updates = 0;
  const loop = new FixedStepLoop({
    step: 1 / 60,
    onUpdate: () => {
      updates += 1;
    },
  });
  const freezeSteps: Array<number | undefined> = [];
  const settleTicks: number[] = [];
  let cleanup: (() => void) | undefined;
  try {
    cleanup = await playtest({ holdUntilAttached: false }).setup?.(
      stubCtx(),
      stubRuntime(loop, freezeSteps, settleTicks),
    );
    expect(freezeSteps).toEqual([undefined]);
    loop.start(0);
    loop.stepFrame(16);
    expect({ updates, tick: loop.tick() }).toEqual({ updates: 60, tick: 60 });
    expect(settleTicks).toEqual([]);
  } finally {
    loop.stop();
    cleanup?.();
    vi.unstubAllGlobals();
  }
});

test("leaves a wall-clock run live: no settle, and no frozen clock", async () => {
  // The runner's production-performance scenarios ask for the wall clock, and a settle there runs
  // 60 counted steps through `advance()`, which freezes the clock the run just released: the
  // profile then measures a game that stopped playing.
  vi.stubGlobal(PLAYTEST_RUNNER_EXPECTED_GLOBAL, true);
  let updates = 0;
  const loop = new FixedStepLoop({
    step: 1 / 60,
    onUpdate: () => {
      updates += 1;
    },
  });
  const freezeSteps: Array<number | undefined> = [];
  const settleTicks: number[] = [];
  let cleanup: (() => void) | undefined;
  try {
    cleanup = await playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 }).setup?.(
      stubCtx(),
      stubRuntime(loop, freezeSteps, settleTicks),
    );
    loop.start(0);
    const bridge = (globalThis as Record<string, unknown>)[PLAYTEST_BRIDGE_GLOBAL] as
      | (IPlaytestBridgeV1 & { _setClockMode?(mode: "fixed-step" | "wall-clock"): unknown })
      | undefined;
    if (bridge === undefined) throw new Error("The production plugin did not install its bridge.");
    // `--live-clock` reaches the loop the same way: the bridge's clock mode switches the live loop.
    bridge._setClockMode?.("wall-clock");
    await bridge.describe();
    expect(settleTicks).toEqual([]);
    expect({ frozen: loop.clockFrozen, updates, tick: loop.tick() }).toEqual({
      frozen: false,
      updates: 0,
      tick: 0,
    });
    // Still live afterwards: the wall clock advances the simulation, not the run's ticks.
    loop.stepFrame(0);
    loop.stepFrame(16.6667);
    expect(updates).toBe(1);
  } finally {
    loop.stop();
    cleanup?.();
    vi.unstubAllGlobals();
  }
});
