import type { Page } from "@playwright/test";
import { PerspectiveCamera, Scene } from "three";
import { expect, test, vi } from "vitest";
import { type IPlaytestBridgeV1, PLAYTEST_BRIDGE_GLOBAL } from "../../playtest/src/protocol.js";
import {
  type IBridgeTransport,
  connectPlaytestBridgeTransport,
} from "../../playtest/src/runner/bridgeClient.js";
import { runStep } from "../../playtest/src/runner/steps.js";
import { validatePlaytestScenario } from "../../playtest/src/scenario.js";
import type { IGamePluginRuntime } from "../src/game.js";
import { FixedStepLoop } from "../src/loop.js";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL, playtest } from "../src/playtest.js";
import type { ICtx } from "../src/scene.js";

test.each([false, true])(
  "resource waits use the production playtest clock with liveClock=%s",
  async (liveClock) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    vi.stubGlobal(PLAYTEST_RUNNER_EXPECTED_GLOBAL, true);
    vi.stubGlobal("__THREENATIVE_PLAYTEST_CLOCK__", liveClock ? "wall-clock" : undefined);
    const loop = new FixedStepLoop({
      step: 0.01,
      onUpdate: () => {},
      requestFrame: (callback) => Number(setTimeout(() => callback(performance.now()), 10)),
      cancelFrame: (handle) => clearTimeout(handle),
    });
    // Only the scene/resources are stubbed. The production plugin installs the real bridge and
    // chooses wallClockAdvance or loop.advance, exactly as it does in a running core game.
    const ctx = {
      camera: new PerspectiveCamera(),
      scene: new Scene(),
      renderer: {
        raw: {
          getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) =>
            target.set(1280, 720),
        },
      },
      entities: { snapshot: () => ({}), forEach: () => {}, get: () => undefined },
      state: { flush: () => {}, getState: () => ({ tick: loop.tick() }) },
      assets: { resolved: new Map() },
      random: { state: 0 },
      startup: { phase: "ready", progress: 1 },
    } as unknown as ICtx;
    const runtime: IGamePluginRuntime = {
      fixedStep: (ticks, options) => loop.advance(ticks, options),
      freezeClock: () => loop.freezeClock(0),
      tick: loop.tick,
      step: 0.01,
      seed: null,
      observations: { contribute: () => () => {}, contributions: () => [] },
    };
    let cleanup: (() => void) | undefined;
    try {
      cleanup = await playtest({ holdUntilAttached: false }).setup?.(ctx, runtime);
      loop.start(0);
      const installed = (globalThis as Record<string, unknown>)[
        PLAYTEST_BRIDGE_GLOBAL
      ] as IPlaytestBridgeV1;
      if (installed === undefined) throw new Error("Production plugin did not install its bridge.");
      const transport: IBridgeTransport = {
        capabilities: [],
        waitForBridge: async () => true,
        close: async () => {},
        async call<T>(method: string, argument?: unknown): Promise<T> {
          const operation: unknown = Reflect.get(installed, method);
          if (typeof operation !== "function")
            throw new Error(`Unknown real bridge method '${method}'.`);
          return (await Reflect.apply(operation, installed, [argument])) as T;
        },
      };
      const scenario = validatePlaytestScenario(
        {
          schemaVersion: 1,
          name: "resource-clock",
          artifacts: { screenshots: false },
          steps: [{ timeoutMs: 20, waitForResource: { id: "state", path: "tick", gte: 1 } }],
          assert: { resources: [{ id: "state", path: "tick", gte: 1, changed: true }] },
        },
        "clock.json",
      );
      const client = await connectPlaytestBridgeTransport(transport, scenario);
      if (client === undefined) throw new Error("Actual bridge handshake did not connect.");
      const waitStep = scenario.steps[0];
      if (waitStep === undefined) throw new Error("Actual clock scenario has no resource wait.");
      const input = { heldKeys: new Set<string>(), pointerButtons: 0, pointers: new Map() };
      const pending = runStep(
        {} as Page,
        client,
        waitStep,
        scenario.viewport,
        undefined,
        [],
        input,
        { include: ["resources"] },
        true,
        undefined,
        liveClock,
      ).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      // The live pump ticks at 10 ms and polling sees it at 16 ms. Before the fix, the production
      // wallClockAdvance adds another 10 ms and rejects this timely value at 26 ms as too late.
      await vi.advanceTimersByTimeAsync(32);
      const outcome = await pending;
      expect(outcome.error).toBeUndefined();
      const observed = outcome.value?.afterStep;
      expect(observed?.clock.mode).toBe(liveClock ? "wall-clock" : "fixed-step");
      expect(loop.clockFrozen).toBe(!liveClock);
      expect((observed?.resources?.state as { tick: number }).tick).toBeGreaterThanOrEqual(1);
      const completedTick = loop.tick();
      await vi.advanceTimersByTimeAsync(20);
      expect(loop.tick()).toBe(liveClock ? completedTick + 2 : completedTick);

      // A live resource deadline also stays bounded while the host pump is held. It must not
      // enter wallClockAdvance's separate 1-second pump timeout while waiting for this resource.
      loop.setHeld(true);
      const heldTick = loop.tick();
      const timeoutStarted = performance.now();
      let rejectedAt: number | undefined;
      let failure: unknown;
      const timeout = runStep(
        {} as Page,
        client,
        {
          ...waitStep,
          timeoutMs: 20,
          waitForResource: { id: "state", path: "tick", gte: 1_000_000 },
        },
        scenario.viewport,
        undefined,
        [],
        input,
        { include: ["resources"] },
        true,
        undefined,
        liveClock,
      ).catch((error: unknown) => {
        failure = error;
        rejectedAt = performance.now() - timeoutStarted;
      });
      await vi.advanceTimersByTimeAsync(20);
      expect(rejectedAt).toBe(20);
      await timeout;
      expect(String(failure)).toMatch(/timed out.*20 ms/i);
      expect(loop.tick()).toBe(liveClock ? heldTick : heldTick + 1);
      expect(loop.clockFrozen).toBe(!liveClock);
      const beforeResume = loop.tick();
      loop.setHeld(false);
      await vi.advanceTimersByTimeAsync(20);
      expect(loop.tick()).toBe(liveClock ? beforeResume + 2 : beforeResume);
      loop.stop();
      const stoppedTick = loop.tick();
      await vi.advanceTimersByTimeAsync(20);
      expect(loop.tick()).toBe(stoppedTick);
      await client.close();
    } finally {
      loop.stop();
      cleanup?.();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);
