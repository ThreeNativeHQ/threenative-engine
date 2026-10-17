import { type IPlaytestBridgeV1, PLAYTEST_BRIDGE_GLOBAL } from "@threenative/playtest";
import type { Vector2 } from "three";
import { describe, expect, it, vi } from "vitest";
import { defineGame } from "../src/game.js";
import { playtest } from "../src/playtest.js";
import { Scene } from "../src/scene.js";
import { createGameStore } from "../src/state.js";

const DOCUMENTED_RESOURCE_IDS = ["assets", "state", "GameState"] as const;
const DOCUMENTED_FLUSH_INTERVAL_MS = 100;

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

function stubRenderer(canvas: HTMLCanvasElement) {
  return {
    canvas,
    preferWebGPU: false,
    webgl2Factory: () => ({
      dispose: () => undefined,
      domElement: canvas,
      getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
      render: () => undefined,
      setSize: () => undefined,
    }),
  };
}

function bridge(): IPlaytestBridgeV1 {
  const value = (globalThis as Record<string, unknown>)[PLAYTEST_BRIDGE_GLOBAL];
  if (typeof value !== "object" || value === null)
    throw new Error("Playtest bridge was not installed.");
  return value as IPlaytestBridgeV1;
}

describe("documented runtime contracts", () => {
  it("keeps the documented resource ids exact", async () => {
    const game = defineGame({
      initialState: { score: 0 },
      plugins: [playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    await game.start();
    try {
      const resources = (await bridge().sample({})).resources;
      // `__threenative*` ids are the host's own counters (frame counts), not part of the documented contract.
      const documented = Object.keys(resources ?? {}).filter(
        (id) => !id.startsWith("__threenative"),
      );
      expect(documented.sort()).toEqual([...DOCUMENTED_RESOURCE_IDS].sort());
      expect(resources?.state).toEqual(resources?.GameState);
    } finally {
      game.stop();
    }
  });

  it("keeps the documented frame-driven default and the documented override", () => {
    vi.useFakeTimers();
    const store = createGameStore({ score: 0 });
    let notifications = 0;
    const unsubscribe = store.subscribe(() => notifications++);
    store.start();
    store.set({ score: 1 });

    try {
      // No interval: the frame publishes, and a timer never does.
      vi.advanceTimersByTime(DOCUMENTED_FLUSH_INTERVAL_MS * 2);
      expect(notifications).toBe(0);
      store.flush();
      expect(notifications).toBe(1);

      // The override a game names still gets its own interval.
      const throttled = createGameStore({ score: 0 }, DOCUMENTED_FLUSH_INTERVAL_MS);
      let throttledNotifications = 0;
      const unsubscribeThrottled = throttled.subscribe(() => throttledNotifications++);
      throttled.start();
      throttled.set({ score: 1 });
      vi.advanceTimersByTime(DOCUMENTED_FLUSH_INTERVAL_MS - 1);
      expect(throttledNotifications).toBe(0);
      vi.advanceTimersByTime(1);
      expect(throttledNotifications).toBe(1);
      unsubscribeThrottled();
      throttled.stop();
    } finally {
      unsubscribe();
      store.stop();
      vi.useRealTimers();
    }
  });

  it("keeps the documented pointer surface on a running context", async () => {
    class PointerContractScene extends Scene {
      static override readonly initialState = {};
    }

    const game = defineGame({
      renderer: stubRenderer(testCanvas()),
      scenes: { test: PointerContractScene },
      start: "test",
    });

    await game.start();
    try {
      expect(typeof game.ctx?.pointer.on).toBe("function");
      expect(typeof game.ctx?.pointer.drag).toBe("function");
    } finally {
      game.stop();
    }
  });
});
