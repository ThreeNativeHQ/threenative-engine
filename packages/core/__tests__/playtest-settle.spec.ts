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
