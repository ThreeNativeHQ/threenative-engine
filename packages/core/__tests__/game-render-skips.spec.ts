import { describe, expect, it, vi } from "vitest";
import type { IFrameBudgetWindow } from "../src/frame-budget.js";
import { defineGame } from "../src/game.js";
import { Scene } from "../src/scene.js";
import { STARTUP_STABLE_WINDOW_MS } from "../src/startup-readiness.js";

class EmptyScene extends Scene {
  static override readonly initialState = {};
}

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 1080 },
    clientWidth: { configurable: true, value: 2400 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/**
 * The Wasm web engine's renderer counts the render() calls its frame gate declined in
 * `info.engine.frameGateSkips`. The loop must carry that into the frame budget window, or a
 * mean render phase over drawn and skipped frames passes for the cost of a drawn frame.
 */
describe("the game loop reports frames the renderer declined to draw", () => {
  it("puts the renderer's skipped render() calls in the window's renderSkips", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const windows: IFrameBudgetWindow[] = [];
    for (const method of ["info", "warn", "log"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
    const info = { engine: { frameGateSkips: 0 }, render: { calls: 0 } };
    let renders = 0;
    const game = defineGame({
      frameBudget: { reportEvery: 6, report: () => undefined, onWindow: (w) => windows.push(w) },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info,
          // every third call is declined, as the web engine's gate does with two frames on the GPU
          render: () => {
            renders += 1;
            if (renders % 3 === 0) info.engine.frameGateSkips += 1;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: EmptyScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (!frame) throw new Error("Game did not start its loop");
      const start = performance.now();
      for (let index = 1; index <= 40; index += 1) frame(start + index * 16.7);
      const counted = windows.filter((w) => w.renderSkips !== undefined);
      expect(counted.length).toBeGreaterThan(0);
      expect(counted.every((w) => w.renderSkips === w.frames / 3)).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      vi.restoreAllMocks();
    }
  });

  it("does not count a declined frame toward startup readiness", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    for (const method of ["info", "warn", "log"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
    const info = { engine: { frameGateSkips: 0 }, render: { calls: 0 } };
    let declining: "all" | "alternate" = "all";
    let calls = 0;
    let ready = false;
    class WatchedScene extends EmptyScene {
      override enter(ctx: Parameters<Scene["enter"]>[0]): void {
        void ctx.startup.whenReady().then(() => {
          ready = true;
        });
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info,
          // the web engine's gate while the first world frame is still on the GPU: every call declined
          // then a GPU-bound world under the cover: every other call declined
          render: () => {
            calls += 1;
            if (declining === "all" || calls % 2 === 0) info.engine.frameGateSkips += 1;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: WatchedScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (!frame) throw new Error("Game did not start its loop");
      let time = performance.now();
      const run = async (frames: number): Promise<void> => {
        for (let index = 0; index < frames; index += 1) {
          time += 16.7;
          frame?.(time);
          await Promise.resolve();
        }
      };
      await run(40);
      expect(ready).toBe(false);
      declining = "alternate";
      await run(40);
      expect(ready).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      game.stop();
      vi.restoreAllMocks();
    }
  });

  it("publishes state written on whenReady only once the uncovered world frame has left the GPU", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    for (const method of ["info", "warn", "log"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
    let ready = false;
    class HudScene extends Scene {
      static override readonly initialState = { loaded: false };
      override enter(ctx: Parameters<Scene["enter"]>[0]): void {
        // what every kit does: the HUD shows on `loaded`, set when the cover lifts
        void ctx.startup.whenReady().then(() => {
          ready = true;
          ctx.state.set({ loaded: true });
        });
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info: { engine: { frameGateSkips: 0 }, render: { calls: 0 } },
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: HudScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (!frame || !game.ctx) throw new Error("Game did not start its loop");
      const state = game.ctx.state as unknown as { getPublishedState(): { loaded: boolean } };
      let time = performance.now();
      let framesAfterReady = 0;
      for (let index = 0; index < 60 && !state.getPublishedState().loaded; index += 1) {
        if (ready) framesAfterReady += 1;
        time += 16.7;
        frame(time);
        await Promise.resolve();
      }
      expect(state.getPublishedState().loaded).toBe(true);
      // three held frames (two on the GPU, the third proves the first left it), published on the fourth (the first runs before the kit sees ready)
      expect(framesAfterReady).toBe(3);
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      game.stop();
      vi.restoreAllMocks();
    }
  });
  it("lifts the cover after the bounded window when the renderer retires no frame", async () => {
    // Hosted CI's SwiftShader declined every world frame after readiness (73 of 73 in
    // racing-shift-brakes), so the hand-off never counted three and the HUD stayed covered for
    // the whole run: no pause button, no train button, no boost readout.
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const method of ["info", "log"] as const)
      vi.spyOn(console, method).mockImplementation(() => undefined);
    const info = { engine: { frameGateSkips: 0 }, render: { calls: 0 } };
    let declining: "all" | "alternate" = "alternate";
    let calls = 0;
    let ready = false;
    class HudScene extends Scene {
      static override readonly initialState = { loaded: false };
      override enter(ctx: Parameters<Scene["enter"]>[0]): void {
        void ctx.startup.whenReady().then(() => {
          ready = true;
          ctx.state.set({ loaded: true });
        });
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info,
          render: () => {
            calls += 1;
            if (declining === "all" || calls % 2 === 0) info.engine.frameGateSkips += 1;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: HudScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    const realNow = performance.now.bind(performance);
    let skew = 0;
    vi.spyOn(performance, "now").mockImplementation(() => realNow() + skew);
    try {
      await game.start();
      if (!frame || !game.ctx) throw new Error("Game did not start its loop");
      const state = game.ctx.state as unknown as { getPublishedState(): { loaded: boolean } };
      let time = performance.now();
      const run = async (frames: number): Promise<void> => {
        for (let index = 0; index < frames; index += 1) {
          time += 16.7;
          frame?.(time);
          await Promise.resolve();
        }
      };
      for (let index = 0; index < 80 && !ready; index += 1) await run(1);
      expect(ready).toBe(true);
      declining = "all";
      await run(20);
      expect(state.getPublishedState().loaded).toBe(false);
      skew = STARTUP_STABLE_WINDOW_MS + 1;
      await run(2);
      expect(state.getPublishedState().loaded).toBe(true);
      const marker = warn.mock.calls
        .map((call) => String(call[0]))
        .find((text) => text.startsWith("TN_STARTUP_HANDOFF_BOUNDED:"));
      expect(marker).toBeDefined();
      expect(JSON.parse(marker?.slice(marker.indexOf(":") + 1) ?? "{}")).toMatchObject({
        retiredFrames: 0,
        requiredFrames: 3,
      });
    } finally {
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      game.stop();
      vi.restoreAllMocks();
    }
  });
});
