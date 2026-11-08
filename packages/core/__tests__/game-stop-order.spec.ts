import { describe, expect, it, vi } from "vitest";
import { type IGame, defineGame } from "../src/game.js";
import type { ICtx, Scene } from "../src/scene.js";
import { Scene as SceneBase } from "../src/scene.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

/**
 * Every release `stop()` performs, in the order `packages/core/AGENTS.md` names them: loop
 * stopped, scene exited, plugin `dispose` called, cleanups drained, input disposed, store
 * stopped, renderer disposed.
 *
 * Each step is observed at the seam the framework itself calls, never through a private field, so
 * this keeps holding when the boot is split into phases: a `stop()` that skips a release, performs
 * it twice, or reorders two of them is what it fails on. The loop is observed through the frame it
 * cancels, because `defineGame` hands out no loop; the input and the store through the public
 * handles `ctx.input` and `game.state` give back; the renderer through the stub's own `dispose`.
 */
const EXPECTED_ORDER = [
  "loop",
  "scene-exit",
  "plugin-dispose",
  "cleanup",
  "input",
  "store",
  "renderer",
];

interface IOrderPlugin {
  dispose?(): void;
  setup?(): () => void;
}

async function startGame(
  scene: new () => Scene,
  plugin: IOrderPlugin | undefined,
  order: string[],
): Promise<IGame> {
  const canvas = testCanvas();
  const game = defineGame({
    initialState: {},
    plugins: plugin === undefined ? [] : [plugin],
    renderer: {
      canvas,
      preferWebGPU: false,
      webgl2Factory: () => ({
        dispose: () => order.push("renderer"),
        domElement: canvas,
        render: () => undefined,
        setSize: () => undefined,
      }),
    },
    scenes: { test: scene },
    start: "test",
  });
  await game.start();
  return game;
}

/**
 * The two handles a spec can only wrap after `start()`: the input map and the store reach the game
 * through `ctx` and `state`, and `stop()` releases the identical objects.
 */
function wrapReleaseHandles(game: IGame, order: string[]): void {
  const input: ICtx["input"] | undefined = game.ctx?.input;
  if (input !== undefined) {
    const dispose = input.dispose.bind(input);
    input.dispose = () => {
      order.push("input");
      dispose();
    };
  }
  const store = game.state;
  const stop = store.stop.bind(store);
  store.stop = () => {
    order.push("store");
    stop();
  };
}

describe("IGame.stop release order", () => {
  it("releases loop, scene, plugins, cleanups, input, store and renderer in that order", async () => {
    const order: string[] = [];
    class Leaves extends SceneBase {
      static override readonly initialState = {};
      override exit(_ctx: ICtx): void {
        order.push("scene-exit");
      }
    }
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => order.push("loop"));
    const game = await startGame(
      Leaves,
      {
        dispose: () => order.push("plugin-dispose"),
        setup: () => () => order.push("cleanup"),
      },
      order,
    );
    try {
      wrapReleaseHandles(game, order);
      game.stop();
      expect(order).toEqual(EXPECTED_ORDER);
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("disposes the frame budget on the stop that releases a started loop", async () => {
    const { FrameBudget } = await import("../src/frame-budget.js");
    const budgetDispose = vi.spyOn(FrameBudget.prototype, "dispose");
    class Plain extends SceneBase {
      static override readonly initialState = {};
    }
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const game = await startGame(Plain, undefined, []);
    try {
      expect(budgetDispose).not.toHaveBeenCalled();
      game.stop();
      expect(budgetDispose).toHaveBeenCalledTimes(1);
    } finally {
      budgetDispose.mockRestore();
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("releases the frame budget a launch acquired before it threw, on the stop that follows", async () => {
    // The frame budget exists before the loop does (`startFrameLoop` builds the instrument, then
    // the loop that reports into it), so a launch that throws between the two must still have its
    // budget released. `maxSteps: 0` is the reachable throw: `startFrameLoop` hands it to
    // `FixedStepLoop`, which rejects it after the budget was already created.
    const { FrameBudget } = await import("../src/frame-budget.js");
    const budgetDispose = vi.spyOn(FrameBudget.prototype, "dispose");
    const canvas = testCanvas();
    class Plain extends SceneBase {
      static override readonly initialState = {};
    }
    const game = defineGame({
      maxSteps: 0,
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Plain },
      start: "test",
    });
    try {
      await expect(game.start()).rejects.toThrow(/maxSteps/u);
      game.stop();
      expect(budgetDispose).toHaveBeenCalledTimes(1);
    } finally {
      budgetDispose.mockRestore();
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("drains a startup that threw before it could answer, on the stop that follows", async () => {
    // The boot registers its releases as it goes, so a launch that throws before the start scene
    // exists is still released by a later `stop()` — the asset loader here, whose decoder pool is
    // the observable end of that release.
    const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
    const loaderDispose = vi.spyOn(KTX2Loader.prototype, "dispose");
    const canvas = testCanvas();
    const extensions = { get: () => ({ getSupportedProfiles: () => ["ldr"] }), has: () => true };
    class Explodes extends SceneBase {
      static override readonly initialState = {};
      constructor() {
        super();
        throw new Error("scene construction failed");
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          extensions,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Explodes },
      start: "test",
    });
    try {
      await expect(game.start()).rejects.toThrow("scene construction failed");
      game.stop();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(loaderDispose).toHaveBeenCalledTimes(1);
    } finally {
      loaderDispose.mockRestore();
      game.stop();
    }
  });

  it("releases several plugins in the order they were set up: every dispose, then every cleanup", async () => {
    const order: string[] = [];
    const canvas = testCanvas();
    class Plain extends SceneBase {
      static override readonly initialState = {};
    }
    const plugin = (name: string) => ({
      dispose: () => order.push(`${name}-dispose`),
      setup: () => () => order.push(`${name}-cleanup`),
    });
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
    const game = defineGame({
      initialState: {},
      plugins: [plugin("a"), plugin("b")],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: Plain },
      start: "test",
    });
    try {
      await game.start();
      game.stop();
      expect(order).toEqual(["a-dispose", "b-dispose", "a-cleanup", "b-cleanup"]);
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("still reaches every release after it when the scene exit throws", async () => {
    const order: string[] = [];
    class Throws extends SceneBase {
      static override readonly initialState = {};
      override exit(_ctx: ICtx): void {
        order.push("scene-exit");
        throw new Error("scene exit failed");
      }
    }
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", () => order.push("loop"));
    const game = await startGame(
      Throws,
      {
        dispose: () => order.push("plugin-dispose"),
        setup: () => () => order.push("cleanup"),
      },
      order,
    );
    try {
      wrapReleaseHandles(game, order);
      // The original failure is retained and rethrown after every release was attempted.
      expect(() => game.stop()).toThrow("scene exit failed");
      expect(order).toEqual(EXPECTED_ORDER);
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });
});
