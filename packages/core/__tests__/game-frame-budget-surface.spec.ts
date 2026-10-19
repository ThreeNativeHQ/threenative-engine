import { describe, expect, it, vi } from "vitest";
import { FRAME_BUDGET_MARKER } from "../src/frame-budget.js";
import { defineGame } from "../src/game.js";
import { type ICtx, Scene } from "../src/scene.js";

class EmptySceneForReporting extends Scene {
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
 * The reporting half of PRD-228's Change A. The scale field already shipped; nothing downstream
 * could see it, so the perf record drifted to `0.36` while the tree held `0.32` for a session.
 * The loop is the only place that knows both the renderer and the window boundary, so it is the
 * only place this can be wired — and it must be wired whether the scale was pinned or chosen.
 */
describe("the frame budget names the surface the game's own loop drew", () => {
  it.each([true, false])(
    "routes window telemetry to the configured sink (custom: %s)",
    async (custom) => {
      const canvas = testCanvas();
      let frame: ((time: number) => void) | undefined;
      const lines: string[] = [];
      let windows = 0;
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const game = defineGame({
        frameBudget: {
          reportEvery: 1,
          ...(custom ? { report: (line: string) => lines.push(line) } : {}),
          onWindow: () => {
            windows += 1;
          },
        },
        renderer: {
          canvas,
          preferWebGPU: false,
          webgl2Factory: () => ({
            domElement: canvas,
            render: () => undefined,
            setSize: () => undefined,
          }),
        },
        scenes: { test: EmptySceneForReporting },
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
        info.mockClear();
        warn.mockClear();
        log.mockClear();
        if (!frame) throw new Error("Game did not start its loop");
        const startTime = performance.now();
        frame(startTime + 16.7); // Establish the one-time projection verdict before the measurement windows.
        windows = 0;
        lines.length = 0;
        info.mockClear();
        warn.mockClear();
        log.mockClear();
        for (let index = 2; index <= 5; index += 1) frame(startTime + index * 16.7);
        expect(windows).toBe(4);
        const projection = (line: unknown) =>
          typeof line === "string" && line.startsWith("TN_PROJECTION:");
        if (custom) {
          expect(lines.filter(projection)).toHaveLength(4);
          expect(info).not.toHaveBeenCalled();
          expect(warn).not.toHaveBeenCalled();
          expect(log).not.toHaveBeenCalled();
        } else {
          expect(info.mock.calls.filter(([line]) => projection(line))).toHaveLength(4);
          expect(
            log.mock.calls.filter(
              ([line]) => typeof line === "string" && line.startsWith(`${FRAME_BUDGET_MARKER}:`),
            ),
          ).toHaveLength(4);
        }
      } finally {
        game.stop();
        info.mockRestore();
        warn.mockRestore();
        log.mockRestore();
        Object.defineProperty(globalThis, "requestAnimationFrame", {
          configurable: true,
          value: requestFrame,
        });
      }
    },
  );

  it("carries the applied scale and drawing buffer into every reported window", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const lines: string[] = [];
    class Empty extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      frameBudget: { report: (line) => lines.push(line), reportEvery: 2 },
      render: { android: { resolutionScale: 0.32 }, resolutionScale: 0.5 },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Empty },
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
      if (frame === undefined) throw new Error("Game did not start its loop.");
      const startTime = performance.now();
      for (let index = 1; index <= 4; index += 1) frame(startTime + index * 16.7);
      const marker = lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`));
      expect(marker, "no frame-budget window was reported").toBeDefined();
      const reported = JSON.parse(marker?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}");
      expect(reported.surface).toEqual({
        atFloor: false,
        compiling: false,
        drawingBufferHeight: 540,
        drawingBufferWidth: 1200,
        resolutionScale: 0.5,
        sampleCount: 1,
        scaleSource: "pinned",
      });
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("carries a positive GPU timestamp into the reported frame window", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const lines: string[] = [];
    class Empty extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      frameBudget: { report: (line) => lines.push(line), reportEvery: 2 },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => {
          // Three's pool resolves the frames that recorded queries, keyed by the `info.frame` its
          // own animation loop would have advanced; the engine's wrapper is what advances it. This
          // device records on every frame, so a reading has no age.
          const info = { frame: 0, render: { timestamp: 6.25 } };
          return {
            domElement: canvas,
            info,
            backend: { getTimestampFrames: () => [info.frame] },
            render: () => undefined,
            setSize: () => undefined,
          };
        },
      },
      scenes: { test: Empty },
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
      if (frame === undefined) throw new Error("Game did not start its loop.");
      const startTime = performance.now();
      frame(startTime + 16.7);
      frame(startTime + 33.4);

      const marker = lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`));
      expect(marker).toBeDefined();
      expect(JSON.parse(marker?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}")).toMatchObject({
        gpuMs: 6.25,
        frames: 2,
      });
      // The pool is keyed by `info.frame`, which the engine's wrapper now advances, so this stub
      // reports the same frame it recorded on: a reading from the frame that produced it has no
      // age. The age is a real reading only when a frame went by without recording one.
      expect(JSON.parse(marker?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}")).toMatchObject({
        gpuAgeFrames: 0,
      });
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("keeps rendering and omits GPU time when timestamp resolution rejects", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    let renders = 0;
    const lines: string[] = [];
    class Empty extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      frameBudget: { report: (line) => lines.push(line), reportEvery: 2 },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info: { render: { timestamp: 0 } },
          render: () => {
            renders += 1;
          },
          resolveTimestampsAsync: () => Promise.reject(new Error("timestamp unavailable")),
          setSize: () => undefined,
        }),
      },
      scenes: { test: Empty },
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
      if (frame === undefined) throw new Error("Game did not start its loop.");
      const startTime = performance.now();
      frame(startTime + 16.7);
      frame(startTime + 33.4);
      await Promise.resolve();

      const marker = lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`));
      expect(renders).toBe(2);
      expect(marker).toBeDefined();
      expect(JSON.parse(marker?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}")).not.toHaveProperty(
        "gpuMs",
      );
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("charges ctx.beforeRender work to the render phase instead of residual", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const lines: string[] = [];
    let clock = 0;
    class Packing extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.beforeRender(() => {
          clock += 5;
        });
      }
    }
    const game = defineGame({
      frameBudget: { report: (line) => lines.push(line), reportEvery: 1 },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Packing },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockImplementation(() => clock);
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      clock = 100;
      frame(100);
      const marker = lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`));
      expect(marker, "no frame-budget window was reported").toBeDefined();
      const reported = JSON.parse(marker?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}");
      // The callback's 5 ms is bracketed by renderStart, so it lands in render, not residual.
      expect(reported.phases.render.p50).toBeCloseTo(5, 2);
      expect(reported.phases.residual.p50).toBeCloseTo(0, 2);
    } finally {
      await game.stop();
      nowSpy.mockRestore();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("feeds the simulation tick into a plain window with no spans installed", async () => {
    // `TN_FRAME_SPANS` is not set here, so no `FrameCounters` are installed: the tick is the only
    // counter in the window, and it must arrive anyway or a plain log cannot join window ends.
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const lines: string[] = [];
    let clock = 0;
    class Empty extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      frameBudget: { report: (line) => lines.push(line), reportEvery: 2 },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Empty },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockImplementation(() => clock);
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      clock = 1_000;
      frame(1_000);
      clock = 1_016.7;
      frame(1_016.7);

      const marker = lines.find((line) => line.startsWith(`${FRAME_BUDGET_MARKER}:`));
      expect(marker, "no frame-budget window was reported").toBeDefined();
      const reported = JSON.parse(marker?.slice(FRAME_BUDGET_MARKER.length + 1) ?? "{}");
      expect(reported.counters).toBeDefined();
      expect(Number.isInteger(reported.counters.simulationTick)).toBe(true);
      expect(reported.counters.simulationTick).toBeGreaterThan(0);
      // No spans, so no boundary series: the tick is the only counter.
      expect(reported.counters.hostCalls).toBeUndefined();
    } finally {
      await game.stop();
      nowSpy.mockRestore();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });
});

describe("game frame budget surface compilation telemetry", () => {
  it("reports explicit compiling state across active compile overlap and clean windows", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    const surfaces: Array<boolean | undefined> = [];
    const game = defineGame({
      frameBudget: {
        report: () => {},
        reportEvery: 1,
        onWindow: (window) => {
          surfaces.push(window.surface?.compiling);
        },
      },
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: () => Promise.resolve(),
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: EmptySceneForReporting },
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
      if (frame === undefined) throw new Error("Game did not start its loop.");
      let time = performance.now();
      for (let index = 0; index < 10; index += 1) {
        time += 8;
        frame(time);
        await Promise.resolve();
      }
      await game.ctx?.startup.whenReady();
      surfaces.length = 0;
      const ctx = game.ctx;
      if (ctx === undefined) throw new Error("Game context was not created.");
      const active = ctx.renderer.compileAsync(ctx.scene, ctx.camera);
      expect(ctx.renderer.compiling).toBe(true);
      time += 16.7;
      frame(time);
      await active;
      await Promise.resolve();
      await ctx.renderer.compileAsync(ctx.scene, ctx.camera);
      expect(ctx.renderer.compiling).toBe(false);
      time += 16.7;
      frame(time);
      await Promise.resolve();
      time += 16.7;
      frame(time);
      await Promise.resolve();
      expect(surfaces.slice(-3)).toEqual([true, true, false]);
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });
});
