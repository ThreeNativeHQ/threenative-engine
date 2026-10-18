import { DirectionalLight } from "three";
import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import { VirtualShadowNode } from "../src/render/virtual-shadow.js";
import type { ICtx, IStartupTimeline } from "../src/scene.js";
import { Scene } from "../src/scene.js";

/**
 * The startup timeline is what a playtest asserts startup time against, so it must be stamped by
 * the runtime in order: load started, entered, and only then the readiness milestones.
 */
describe("startup timeline", () => {
  it("should stamp load, enter and readiness in order and publish them through ctx.startup", async () => {
    const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, value: 90 },
      clientWidth: { configurable: true, value: 160 },
      parentElement: { configurable: true, value: null },
    });
    let seenAtEnter: IStartupTimeline | undefined;
    let seenAtLoad: IStartupTimeline | undefined;
    let capturedCtx: ICtx | undefined;
    class Timed extends Scene {
      static override readonly initialState = {};
      override load(ctx: ICtx): void {
        seenAtLoad = ctx.startup.timeline;
      }
      override enter(ctx: ICtx): undefined {
        capturedCtx = ctx;
        seenAtEnter = ctx.startup.timeline;
        return undefined;
      }
    }
    let frame: ((time: number) => void) | undefined;
    const game = defineGame({
      renderer: {
        canvas: canvas as never,
        preferWebGPU: false,
        webgl2Factory: () =>
          ({ domElement: canvas, render: () => undefined, setSize: () => undefined }) as never,
      },
      scenes: { timed: Timed },
      start: "timed",
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
      // Progress is honest and monotonic: entered is 0.8, compile settled 0.9, ready 1.
      expect(capturedCtx?.startup.progress).toBeGreaterThanOrEqual(0.8);
      expect(seenAtLoad?.loadStartedMs).toBeTypeOf("number");
      expect(seenAtLoad?.enteredMs).toBeUndefined();
      expect(seenAtEnter?.enteredMs).toBeUndefined();
      const afterEnter = capturedCtx?.startup.timeline;
      expect(afterEnter?.enteredMs).toBeTypeOf("number");
      expect(afterEnter?.enteredMs ?? 0).toBeGreaterThanOrEqual(
        afterEnter?.loadStartedMs ?? Number.POSITIVE_INFINITY,
      );
      // Readiness follows a sustained in-budget frame window; pump frames until it resolves.
      if (frame === undefined) throw new Error("Game did not start its loop.");
      for (
        let index = 1;
        index <= 12 && capturedCtx?.startup.timeline.readyMs === undefined;
        index += 1
      ) {
        frame(index * 16.7);
        await Promise.resolve();
      }
      await capturedCtx?.startup.whenReady();
      const ready = capturedCtx?.startup.timeline;
      expect(capturedCtx?.startup.progress).toBe(1);
      expect(ready?.compileSettledMs).toBeTypeOf("number");
      expect(ready?.readyMs).toBeTypeOf("number");
      expect(ready?.readyMs ?? 0).toBeGreaterThanOrEqual(
        ready?.enteredMs ?? Number.POSITIVE_INFINITY,
      );
      // The timeline handed out is a copy: a game cannot rewrite the runtime's record.
      (ready as { readyMs?: number }).readyMs = -1;
      expect(capturedCtx?.startup.timeline.readyMs).not.toBe(-1);
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("should report the player's wait, not the framework's, when the game holds startup", async () => {
    const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, value: 90 },
      clientWidth: { configurable: true, value: 160 },
      parentElement: { configurable: true, value: null },
    });
    let capturedCtx: ICtx | undefined;
    let landDetail: () => void = () => undefined;
    class Streaming extends Scene {
      static override readonly initialState = {};
      override load(ctx: ICtx): void {
        // What a game with a second asset tier does: register the tier, then enter on the first.
        ctx.startup.hold(
          "detail-tier",
          new Promise<void>((resolve) => {
            landDetail = resolve;
          }),
        );
      }
      override enter(ctx: ICtx): undefined {
        capturedCtx = ctx;
        return undefined;
      }
    }
    let frame: ((time: number) => void) | undefined;
    const game = defineGame({
      renderer: {
        canvas: canvas as never,
        preferWebGPU: false,
        webgl2Factory: () =>
          ({ domElement: canvas, render: () => undefined, setSize: () => undefined }) as never,
      },
      scenes: { streaming: Streaming },
      start: "streaming",
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
      for (
        let index = 1;
        index <= 12 && capturedCtx?.startup.timeline.frameworkReadyMs === undefined;
        index += 1
      ) {
        frame(index * 16.7);
        await Promise.resolve();
      }
      // The framework is done and the world is not. This is the state that used to be
      // unrepresentable: `readyMs` was stamped here, and a playtest asserting `maxReadyMs`
      // measured a moment the player never reached.
      const held = capturedCtx?.startup.timeline;
      expect(held?.frameworkReadyMs).toBeTypeOf("number");
      expect(held?.readyMs).toBeUndefined();
      expect(capturedCtx?.startup.phase).toBe("collapsing");
      // The bar keeps moving across the held window rather than sitting full.
      expect(capturedCtx?.startup.progress).toBeGreaterThanOrEqual(0.9);
      expect(capturedCtx?.startup.progress).toBeLessThan(1);

      landDetail();
      // Warm-up and final quiet polls advance on rendered frames, even with simulation held.
      for (let index = 13; index <= 40 && capturedCtx?.startup.phase !== "ready"; index++) {
        await Promise.resolve();
        frame(index * 16.7);
      }
      await capturedCtx?.startup.whenReady();
      const ready = capturedCtx?.startup.timeline;
      expect(ready?.readyMs).toBeTypeOf("number");
      expect(ready?.readyMs ?? 0).toBeGreaterThanOrEqual(ready?.frameworkReadyMs ?? -1);
      expect(capturedCtx?.startup.progress).toBe(1);
      expect(capturedCtx?.startup.phase).toBe("ready");
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });
});

it("keeps virtual shadows covered until two rendered quiet polls after late work", async () => {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { value: 90 },
    clientWidth: { value: 160 },
    parentElement: { value: null },
  });
  let ctx!: ICtx;
  let shadow!: VirtualShadowNode;
  let settled = false;
  let sawCoveredDraw = false;
  class Covered extends Scene {
    static override readonly initialState = {};
    override enter(context: ICtx): void {
      ctx = context;
      ctx.canvasLayer.opaque = true;
      ctx.canvasLayer.keepWorldRendering = true;
      const light = new DirectionalLight();
      light.castShadow = true;
      shadow = new VirtualShadowNode(light, { marker: false });
      Object.defineProperty(shadow, "settled", { get: () => settled });
      light.shadow.shadowNode = shadow;
      ctx.add(light);
    }
  }
  let frame!: (time: number) => void;
  const previous = globalThis.requestAnimationFrame;
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (callback: (time: number) => void) => {
      frame = callback;
      return 1;
    },
  });
  const game = defineGame({
    renderer: {
      canvas: canvas as never,
      preferWebGPU: false,
      webgl2Factory: () =>
        ({
          domElement: canvas,
          render: () => {
            sawCoveredDraw ||= shadow?.startupCovered === true;
          },
          setSize: () => undefined,
        }) as never,
    },
    scenes: { covered: Covered },
    start: "covered",
  });
  const pump = async (index: number) => {
    frame(index * 16.7);
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };
  try {
    await game.start();
    for (let i = 1; i <= 12; i++) await pump(i);
    expect(sawCoveredDraw).toBe(true);
    expect(ctx.startup.phase).toBe("collapsing");
    settled = true;
    await pump(13);
    expect(ctx.startup.phase).toBe("collapsing");
    const remove = ctx.beforeRender(() => {
      settled = false;
    });
    await pump(14);
    remove();
    settled = true;
    await pump(15);
    expect(ctx.startup.phase).toBe("collapsing");
    await pump(16);
    expect(ctx.startup.phase).toBe("ready");
    expect(shadow.startupCovered).toBe(false);
  } finally {
    await game.stop();
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: previous,
    });
    shadow?.dispose();
  }
});
