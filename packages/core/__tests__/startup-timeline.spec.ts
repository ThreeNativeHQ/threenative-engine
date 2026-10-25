import { Texture } from "three";
import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
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

  // The owned engine skips every frame whose environment is still baking, and a skipped frame is a
  // fast frame. A game with no loading cover must still wait for the bake, or `ready` arrives before
  // the world has drawn once (the V8 player's blank kits, 4e31fcead).
  // The runner kit: Boot's enter() calls goto("run"). The transition baked Run's environment for
  // 35 s on SwiftShader (about 50 s on CI) with the world pass held, then startup readiness baked
  // it again, and the launch sat at 80% until TN_STARTUP_STALLED.
  it("should bake a boot scene's goto target once, inside startup readiness", async () => {
    const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, value: 90 },
      clientWidth: { configurable: true, value: 160 },
      parentElement: { configurable: true, value: null },
    });
    let capturedCtx: ICtx | undefined;
    let transition: Promise<void> | undefined;
    class Boot extends Scene {
      static override readonly initialState = {};
      override enter(ctx: ICtx): undefined {
        transition = ctx.goto("lit");
        return undefined;
      }
    }
    class Lit extends Scene {
      static override readonly initialState = {};
      override enter(ctx: ICtx): undefined {
        capturedCtx = ctx;
        ctx.scene.environment = new Texture();
        return undefined;
      }
    }
    const prepared: unknown[] = [];
    let frame: ((time: number) => void) | undefined;
    const game = defineGame({
      renderer: {
        canvas: canvas as never,
        preferWebGPU: false,
        webgl2Factory: () =>
          ({
            domElement: canvas,
            prepareEnvironmentAsync: (scene: { environment?: unknown }) => {
              prepared.push(scene.environment);
              return Promise.resolve(true);
            },
            render: () => undefined,
            setSize: () => undefined,
          }) as never,
      },
      scenes: { boot: Boot, lit: Lit },
      start: "boot",
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
      await transition;
      if (frame === undefined) throw new Error("Game did not start its loop.");
      for (let index = 1; index <= 12; index += 1) {
        frame(index * 16.7);
        await Promise.resolve();
      }
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toBe(capturedCtx?.scene.environment);
    } finally {
      game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });

  it("should hold readiness for an unbaked environment in a game with no loading cover", async () => {
    const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, value: 90 },
      clientWidth: { configurable: true, value: 160 },
      parentElement: { configurable: true, value: null },
    });
    let capturedCtx: ICtx | undefined;
    class Lit extends Scene {
      static override readonly initialState = {};
      override enter(ctx: ICtx): undefined {
        capturedCtx = ctx;
        ctx.scene.environment = new Texture();
        return undefined;
      }
    }
    let baked: (done: boolean) => void = () => undefined;
    const prepared: unknown[] = [];
    let frame: ((time: number) => void) | undefined;
    const game = defineGame({
      renderer: {
        canvas: canvas as never,
        preferWebGPU: false,
        webgl2Factory: () =>
          ({
            domElement: canvas,
            prepareEnvironmentAsync: (scene: { environment?: unknown }) => {
              prepared.push(scene.environment);
              return new Promise<boolean>((resolve) => {
                baked = resolve;
              });
            },
            render: () => undefined,
            setSize: () => undefined,
          }) as never,
      },
      scenes: { lit: Lit },
      start: "lit",
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
      for (let index = 1; index <= 12; index += 1) {
        frame(index * 16.7);
        await Promise.resolve();
      }
      expect(prepared).toHaveLength(1);
      expect(prepared[0]).toBe(capturedCtx?.scene.environment);
      expect(capturedCtx?.startup.timeline.compileSettledMs).toBeUndefined();
      expect(capturedCtx?.startup.timeline.readyMs).toBeUndefined();

      baked(true);
      for (
        let index = 13;
        index <= 30 && capturedCtx?.startup.timeline.readyMs === undefined;
        index += 1
      ) {
        frame(index * 16.7);
        await Promise.resolve();
      }
      await capturedCtx?.startup.whenReady();
      expect(capturedCtx?.startup.timeline.readyMs).toBeTypeOf("number");
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  });
});
