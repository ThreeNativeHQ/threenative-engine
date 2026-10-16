import { afterEach, expect, it, vi } from "vitest";
import { defineGame } from "../../core/src/game.js";
import { type ICtx, Scene } from "../../core/src/scene.js";
import { holdOceanHeight } from "../templates/sailing/src/scenes/ocean-readiness.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("the real Game keeps world callbacks progressing during a height hold with its clock frozen", async () => {
  vi.useFakeTimers();
  let frame: FrameRequestCallback | undefined;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frame = callback;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { value: 90 },
    clientWidth: { value: 160 },
    parentElement: { value: null },
  });
  let ctx: ICtx | undefined;
  let stopHeight: () => void = () => undefined;
  let freeze: () => void = () => undefined;
  let height: number | undefined;
  let dispatches = 0;
  let samples = 0;
  let renders = 0;
  let updates = 0;
  class Sea extends Scene {
    static override readonly initialState = {};
    override enter(context: ICtx): undefined {
      ctx = context;
      context.canvasLayer.opaque = true;
      stopHeight = holdOceanHeight(context, {
        process: () => {
          dispatches += 1;
        },
        sampleHeight: () => {
          samples += 1;
          return height === undefined ? undefined : { height, staleFrames: 0 };
        },
      });
      return undefined;
    }
    override update(): void {
      updates += 1;
    }
    override exit(): void {
      stopHeight();
    }
  }
  const game = defineGame({
    renderer: {
      canvas: canvas as HTMLCanvasElement,
      preferWebGPU: false,
      webgl2Factory: () =>
        ({
          domElement: canvas,
          render: () => {
            renders += 1;
          },
          setSize: () => undefined,
          dispose: () => undefined,
        }) as never,
    },
    plugins: [
      {
        setup(_context, runtime) {
          freeze = () => runtime?.freezeClock?.();
          return undefined;
        },
      },
    ],
    scenes: { sea: Sea },
    start: "sea",
  });
  async function present(index: number) {
    if (frame === undefined) throw new Error("The real Game did not schedule a frame.");
    frame(index * 16.7);
    await vi.advanceTimersByTimeAsync(0);
  }
  try {
    await game.start();
    freeze();

    expect(dispatches).toBe(0);
    for (let index = 1; index <= 24 && dispatches === 0; index++) await present(index);
    expect(ctx?.startup.timeline.frameworkReadyMs).toBeTypeOf("number");
    expect(ctx?.startup.timeline.readyMs).toBeUndefined();
    expect(ctx?.startup.phase).toBe("collapsing");
    expect(dispatches).toBe(1);
    const heldUpdates = updates;
    expect(heldUpdates).toBe(60);
    const sampled = samples;
    const rendered = renders;
    await present(25);
    await present(26);
    expect(samples).toBeGreaterThan(sampled);
    expect(renders).toBeGreaterThan(rendered);
    // freezeClock primes60ticks on its first presented frame; polling needs no further ticks.
    expect(updates).toBe(heldUpdates);
    height = 0;
    await present(27);
    // Readiness now requires two rendered quiet polls after the world has been admitted and the
    // shadow maps have settled, so the released hold needs two presented frames to close the gate.
    await present(28);
    await present(29);
    await ctx?.startup.whenReady();
    expect(ctx?.startup.phase).toBe("ready");
    const finalSamples = samples;
    await present(30);
    expect(samples).toBe(finalSamples);
    expect(dispatches).toBe(1);
    await game.goto("sea");
    await present(31);
    expect(dispatches).toBe(1);
    expect(samples).toBe(finalSamples);
  } finally {
    await game.stop();
  }
});
