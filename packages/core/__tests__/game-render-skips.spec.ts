import { describe, expect, it, vi } from "vitest";
import type { IFrameBudgetWindow } from "../src/frame-budget.js";
import { defineGame } from "../src/game.js";
import { Scene } from "../src/scene.js";

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
});
