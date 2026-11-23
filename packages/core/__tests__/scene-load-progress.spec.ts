import { Texture } from "three";
import { describe, expect, it } from "vitest";
import { defineGame } from "../src/game.js";
import type { ICtx } from "../src/scene.js";
import { Scene } from "../src/scene.js";

/**
 * PRD-908 phase 1: a scene change reports its own load progress.
 *
 * `ctx.startup.progress` reaches 1 once the first projection settled and stays there, so a kit's
 * loading screen showed a full bar on every restart while the next level loaded. `ctx.sceneLoad`
 * is the value a loading bar reads instead, and it is only honest if four properties hold:
 *
 * 1. during boot it is the launch's own ladder, the same number as `startup.progress`,
 * 2. it is 0 the moment `goto()` starts,
 * 3. it never falls while that load's assets settle, and
 * 4. it reaches 1 only after the new scene's `enter()` ran.
 */

/** The property under test, applied to a sampled sequence. */
function firstRegression(samples: readonly number[]): string | undefined {
  let previous = samples[0] ?? 0;
  for (let index = 1; index < samples.length; index += 1) {
    const value = samples[index] ?? 0;
    if (value < previous) return `sample ${index} fell from ${previous} to ${value}`;
    previous = value;
  }
  return undefined;
}

/** The renderer and canvas stubs every core spec here uses. */
function stubRenderer(): { canvas: never; preferWebGPU: false; webgl2Factory: () => never } {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 90 },
    clientWidth: { configurable: true, value: 160 },
    parentElement: { configurable: true, value: null },
  });
  return {
    canvas: canvas as never,
    preferWebGPU: false,
    webgl2Factory: () =>
      ({ domElement: canvas, render: () => undefined, setSize: () => undefined }) as never,
  };
}

/**
 * Textures that settle only when the spec says so, so a sample lands mid-load rather than after
 * the whole thing resolved in one microtask.
 */
function heldTextures(): {
  readonly assets: { texture(path: string): Promise<Texture> };
  settle(path: string): void;
} {
  const waiting = new Map<string, Array<() => void>>();
  return {
    assets: {
      texture: (path) =>
        new Promise<Texture>((resolve) => {
          const queue = waiting.get(path) ?? [];
          queue.push(() => resolve(new Texture()));
          waiting.set(path, queue);
        }),
    },
    settle: (path) => {
      const queue = waiting.get(path);
      if (queue === undefined) throw new Error(`No texture was requested for '${path}'.`);
      const resolve = queue.shift();
      if (queue.length === 0) waiting.delete(path);
      resolve?.();
    },
  };
}

/** Let the loader's promise chain and the scene's own continuation run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function contextOf(game: { readonly ctx: ICtx | undefined }): ICtx {
  const ctx = game.ctx;
  if (ctx === undefined) throw new Error("The game did not connect a context.");
  return ctx;
}

describe("scene load progress", () => {
  it("should equal startup.progress during boot", async () => {
    const pairs: Array<readonly [number, number]> = [];
    class Boot extends Scene {
      static override readonly initialState = {};
      override async load(ctx: ICtx): Promise<void> {
        pairs.push([ctx.sceneLoad.progress, ctx.startup.progress]);
        await ctx.assets.texture("boot.png");
        pairs.push([ctx.sceneLoad.progress, ctx.startup.progress]);
      }
      override enter(ctx: ICtx): void {
        pairs.push([ctx.sceneLoad.progress, ctx.startup.progress]);
      }
    }
    const game = defineGame({
      assets: { texture: () => Promise.resolve(new Texture()) },
      renderer: stubRenderer(),
      scenes: { boot: Boot },
      start: "boot",
    });
    await game.start();
    expect(pairs.length).toBe(3);
    for (const [sceneLoad, startup] of pairs) expect(sceneLoad).toBe(startup);
  });

  it("should start at 0 after goto(), never fall, and reach 1 only after enter", async () => {
    const textures = heldTextures();
    const enterSamples: number[] = [];
    class Menu extends Scene {
      static override readonly initialState = {};
    }
    class Level extends Scene {
      static override readonly initialState = {};
      override async load(ctx: ICtx): Promise<void> {
        await ctx.assets.texture("a.png");
        // A second tier requested after the first settled: the denominator grows, so the raw
        // ratio falls and a bar that followed it would jump backwards mid-load.
        await new Promise((resolve) => setTimeout(resolve, 20));
        await ctx.assets.texture("b.png");
      }
      override enter(ctx: ICtx): void {
        enterSamples.push(ctx.sceneLoad.progress);
      }
    }
    const game = defineGame({
      assets: textures.assets,
      renderer: stubRenderer(),
      scenes: { menu: Menu, level: Level },
      start: "menu",
    });
    await game.start();
    const ctx = contextOf(game);

    const transition = game.goto("level");
    const samples: number[] = [ctx.sceneLoad.progress];
    await flush();
    samples.push(ctx.sceneLoad.progress);
    textures.settle("a.png");
    await flush();
    samples.push(ctx.sceneLoad.progress);
    // `b.png` is requested now and unsettled: the measured ratio is 0.35 and must not show.
    await new Promise((resolve) => setTimeout(resolve, 40));
    samples.push(ctx.sceneLoad.progress);
    textures.settle("b.png");
    await flush();
    samples.push(ctx.sceneLoad.progress);
    await transition;
    samples.push(ctx.sceneLoad.progress);

    expect(samples[0]).toBe(0);
    expect(samples[1]).toBe(0);
    expect(samples[2]).toBeCloseTo(0.7);
    expect(samples[3]).toBeCloseTo(0.7);
    expect(firstRegression(samples)).toBeUndefined();
    expect(enterSamples.length).toBe(1);
    expect(enterSamples[0]).toBeLessThan(1);
    expect(samples[samples.length - 1]).toBe(1);
  });
});
