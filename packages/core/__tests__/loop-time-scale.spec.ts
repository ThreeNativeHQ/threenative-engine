import type { Vector2 } from "three";
import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import { FixedStepLoop } from "../src/loop.js";
import { Scene } from "../src/scene.js";

const FRAME_MS = 16;
// 240 frames of 16 ms is 3.84 s of wall time: 3.84 / (1/60) = 230.4 whole steps at scale 1.
const FRAMES = 240;

function run(timeScale: number): {
  readonly loop: FixedStepLoop;
  readonly renders: number;
  readonly steps: readonly number[];
} {
  const steps: number[] = [];
  let renders = 0;
  const loop = new FixedStepLoop({
    onUpdate: (dt) => steps.push(dt),
    onRender: () => {
      renders += 1;
      return undefined;
    },
  });
  loop.timeScale = timeScale;
  for (let frame = 0; frame <= FRAMES; frame += 1) loop.stepFrame(frame * FRAME_MS);
  return { loop, renders, steps };
}

describe("FixedStepLoop timeScale", () => {
  it("halves the ticks per wall second and leaves the step alone", () => {
    const full = run(1);
    const half = run(0.5);
    expect(full.loop.tick()).toBe(230);
    expect(half.loop.tick()).toBe(115);
    // Determinism survives the scale: the same step, only fewer of them.
    expect(half.loop.step).toBe(full.loop.step);
    expect(new Set(full.steps)).toEqual(new Set([full.loop.step]));
    expect(new Set(half.steps)).toEqual(new Set([full.loop.step]));
  });

  it("freezes the simulation at zero while frames keep rendering", () => {
    const frozen = run(0);
    expect(frozen.loop.tick()).toBe(0);
    expect(frozen.steps).toEqual([]);
    expect(frozen.renders).toBe(FRAMES + 1);
  });

  it("defaults to one", () => {
    const loop = new FixedStepLoop({ onUpdate: () => undefined });
    expect(loop.timeScale).toBe(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects %s with TN_TIME_SCALE_INVALID and keeps the last good value",
    (value) => {
      const loop = new FixedStepLoop({ onUpdate: () => undefined });
      const set = (): void => {
        loop.timeScale = value;
      };
      expect(set).toThrow("TN_TIME_SCALE_INVALID");
      expect(set).toThrow(String(value));
      expect(loop.timeScale).toBe(1);
    },
  );
});

describe("ctx.timeScale", () => {
  // The cheapest real context: the stub renderer documented-contract.spec.ts uses, started in node.
  const stubRenderer = () => {
    const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, value: 180 },
      clientWidth: { configurable: true, value: 320 },
      parentElement: { configurable: true, value: null },
    });
    return {
      canvas: canvas as HTMLCanvasElement,
      preferWebGPU: false,
      webgl2Factory: () => ({
        dispose: () => undefined,
        domElement: canvas,
        getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
        render: () => undefined,
        setSize: () => undefined,
      }),
    };
  };

  it("delegates to the booted loop", async () => {
    class TimeScaleScene extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      renderer: stubRenderer(),
      scenes: { test: TimeScaleScene },
      start: "test",
    });
    await game.start();
    try {
      const ctx = game.ctx;
      expect(ctx).toBeDefined();
      if (ctx === undefined) return;
      expect(ctx.timeScale).toBe(1);
      ctx.timeScale = 0.25;
      expect(ctx.timeScale).toBe(0.25);
      expect(() => {
        ctx.timeScale = Number.NaN;
      }).toThrow("TN_TIME_SCALE_INVALID");
      expect(ctx.timeScale).toBe(0.25);
    } finally {
      game.stop();
    }
  });
});
