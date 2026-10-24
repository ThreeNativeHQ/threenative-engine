import {
  DataTexture,
  EquirectangularReflectionMapping,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  SphereGeometry,
} from "three";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { describe, expect, it, vi } from "vitest";
import { type IGamePlatformSource, defineGame } from "../src/game.js";
import { InputMap } from "../src/input.js";
import {
  type ILaunchFailure,
  onLaunchFailure,
  resetLaunchFailures,
} from "../src/launch-diagnostics.js";
import type { IRenderPerformanceSample } from "../src/loop.js";
import { type ICtx, Scene } from "../src/scene.js";
import { SoftBody3D } from "../src/softbody.js";
import { UI_INTENT_MESSAGE, UI_READY_INTENT, connectUiBridge } from "../src/ui-bridge.js";
import { subscribeUiState } from "../src/ui-state.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

function renderer(canvas: HTMLCanvasElement) {
  return {
    canvas,
    preferWebGPU: false,
    webgl2Factory: () => ({
      dispose: () => undefined,
      domElement: canvas,
      render: () => undefined,
      setSize: () => undefined,
    }),
  };
}

class TrackingResizeObserver {
  static instances: TrackingResizeObserver[] = [];
  disconnected = false;

  constructor(_callback: ResizeObserverCallback) {
    TrackingResizeObserver.instances.push(this);
  }

  observe(_target: Element): void {}

  disconnect(): void {
    this.disconnected = true;
  }
}

class EmptyScene extends Scene {
  static override readonly initialState = {};
}

describe("IGame", () => {
  it("reports render traps once per scene entry, including re-entry", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const faded: MeshBasicMaterial[] = [];
    class Traps extends Scene {
      override enter(ctx: ICtx): void {
        const texture = new DataTexture(new Uint8Array(8 * 65 * 4), 8, 65);
        texture.mapping = EquirectangularReflectionMapping;
        ctx.scene.environment = texture;
        const material = new MeshBasicMaterial({ opacity: 0.5 });
        faded.push(material);
        ctx.scene.add(new Mesh(undefined, material));
      }
    }
    const game = defineGame({
      initialState: {},
      renderer: renderer(testCanvas()),
      scenes: { traps: Traps },
      start: "traps",
    });
    const markers = (spy: typeof error, pattern: RegExp): string[] =>
      spy.mock.calls.map(([line]) => String(line)).filter((line) => pattern.test(line));
    try {
      await game.start();
      await Promise.resolve();
      // Authored opacity takes effect: the material turns transparent, and the engine says so as
      // a warning, so the game's playtests keep passing while the report stays honest.
      expect(markers(error, /TN_ENVIRONMENT_TOO_SMALL/u)).toHaveLength(1);
      expect(markers(error, /TN_OPACITY_IGNORED/u)).toEqual([]);
      expect(markers(warn, /TN_OPACITY_TRANSPARENT/u)).toHaveLength(1);
      expect(faded[0]?.transparent).toBe(true);
      await game.goto("traps");
      expect(markers(error, /TN_ENVIRONMENT_TOO_SMALL/u)).toHaveLength(2);
      expect(markers(warn, /TN_OPACITY_TRANSPARENT/u)).toHaveLength(2);
      expect(faded[1]?.transparent).toBe(true);
    } finally {
      game.stop();
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it("leaves an alpha-hashed material opaque, the named override", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const material = new MeshBasicMaterial({ alphaHash: true, opacity: 0.5 });
    class Hashed extends Scene {
      override enter(ctx: ICtx): void {
        ctx.scene.add(new Mesh(undefined, material));
      }
    }
    const game = defineGame({
      initialState: {},
      renderer: renderer(testCanvas()),
      scenes: { hashed: Hashed },
      start: "hashed",
    });
    try {
      await game.start();
      expect(material.transparent).toBe(false);
      expect(warn.mock.calls.some(([line]) => /TN_OPACITY_TRANSPARENT/u.test(String(line)))).toBe(
        false,
      );
    } finally {
      game.stop();
      warn.mockRestore();
    }
  });

  it.each([false, true])(
    "releases the UI bridge when renderer startup fails (host: %s)",
    async (host) => {
      if (host) {
        vi.stubGlobal("__tnUiPost", () => undefined);
        vi.stubGlobal("__tnUiOverlayAttached", () => true);
      }
      const ui = connectUiBridge({ end: "ui" });
      const boom = new Error("renderer failed");
      const game = defineGame({
        renderer: {
          ...renderer(testCanvas()),
          webgl2Factory: () => {
            throw boom;
          },
        },
        scenes: { test: EmptyScene },
        start: "test",
      });
      try {
        // Boot names the failure (TN_NO_RENDERER) and keeps the renderer's own error as its cause.
        await expect(game.start()).rejects.toMatchObject({
          cause: boom,
          message: expect.stringContaining("TN_NO_RENDERER"),
        });
        if (host) {
          expect((globalThis as Record<string, unknown>).__tnUiGameReceive).toBeUndefined();
        } else {
          expect(ui.hasPeer()).toBe(false);
        }
      } finally {
        game.stop();
        ui.close();
        vi.unstubAllGlobals();
      }
    },
  );

  it.each([undefined, 100])(
    "publishes UI state at the selected frame/interval cadence (%s)",
    async (stateFlushMs) => {
      vi.useFakeTimers();
      let frame: FrameRequestCallback | undefined;
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      });
      let renderedFrames = 0;
      let animateUi = true;
      class LiveUiScene extends Scene<{ score: number }> {
        override render(ctx: ICtx<{ score: number }>): void {
          if (!animateUi) return;
          renderedFrames += 1;
          ctx.state.set({ score: -renderedFrames });
          ctx.state.set({ score: renderedFrames });
        }
      }
      const game = defineGame({
        initialState: { score: 0 },
        renderer: renderer(testCanvas()),
        scenes: { test: LiveUiScene },
        start: "test",
        ...(stateFlushMs === undefined ? {} : { stateFlushMs }),
      });
      const ui = connectUiBridge({ end: "ui" });
      const mirror = subscribeUiState<{ score: number }>(ui);
      const observed: number[] = [];
      mirror.subscribe(() => observed.push(mirror.get()?.score ?? -1));
      ui.post({ type: UI_INTENT_MESSAGE, intent: UI_READY_INTENT });
      try {
        await game.start();
        await Promise.resolve();
        observed.length = 0;
        if (frame === undefined) throw new Error("Game did not start its loop.");
        for (let count = 1; count <= 64; count++) {
          frame(count * 16);
          if (stateFlushMs === undefined) expect(mirror.get()?.score).toBe(renderedFrames);
          await Promise.resolve();
        }
        // Startup may hold the world while still presenting loader frames. Count actual renders.
        expect(renderedFrames).toBeGreaterThanOrEqual(8);
        if (stateFlushMs === undefined) {
          expect(observed).toEqual(Array.from({ length: renderedFrames }, (_, index) => index + 1));
          animateUi = false;
          frame(1_040);
          await Promise.resolve();
          expect(observed).toHaveLength(renderedFrames);
        } else {
          expect(observed).toEqual([]);
          await vi.advanceTimersByTimeAsync(stateFlushMs);
          expect(observed).toEqual([renderedFrames]);
        }
        expect(mirror.get()).toEqual({ score: renderedFrames });
      } finally {
        game.stop();
        mirror.stop();
        ui.close();
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    },
  );

  it("executes the ordinary no-overlay render path with diagnostics disabled", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    let worldRenders = 0;
    let sceneRenders = 0;
    let diagnostics: (() => readonly IRenderPerformanceSample[]) | undefined;
    let enableDiagnostics: (() => void) | undefined;
    class OrdinaryScene extends Scene {
      static override readonly initialState = {};

      override render(): void {
        sceneRenders += 1;
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            diagnostics = runtime?.runtimeDiagnosticsSeries;
            enableDiagnostics = runtime?.enableRuntimeDiagnostics;
            return undefined;
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => {
            worldRenders += 1;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: OrdinaryScene },
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
      const ctx = game.ctx;
      if (ctx === undefined || frame === undefined) throw new Error("Game did not start its loop.");

      frame(16);
      expect(ctx.canvasLayer.scene.children).toHaveLength(0);
      expect(worldRenders).toBe(1);
      expect(sceneRenders).toBe(1);
      expect(diagnostics?.()).toEqual([]);
      enableDiagnostics?.();
      frame(32);
      expect(diagnostics?.()).toHaveLength(1);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("keeps fixed compute in the gameplay and physics cadence behind the startup loader", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    const trace: string[] = [];
    const computeNodes: unknown[] = [];
    const gameplayPhases: string[] = [];
    let frame: ((time: number) => void) | undefined;
    let advance: ((ticks: number) => void) | undefined;
    let cloth: SoftBody3D | undefined;
    class StartupTraceScene extends Scene {
      static override readonly initialState = {};

      override update(ctx: ICtx): void {
        trace.push("gameplayUpdated");
        gameplayPhases.push(ctx.startup.phase);
      }

      override enter(ctx: ICtx): void {
        cloth = new SoftBody3D(new Mesh(new PlaneGeometry(1, 1), new MeshBasicNodeMaterial()), {
          pinned: [0],
          stiffness: 35,
          damping: 1.8,
          gravity: [0, 0, 0],
          wind: [0, 0, 0],
        });
        ctx.add(cloth);
        let releaseHold: () => void = () => undefined;
        ctx.startup.hold(
          "simulation initialization",
          new Promise<void>((resolve) => {
            releaseHold = resolve;
          }),
        );
        ctx.afterPhysics(() => {
          trace.push("physicsAdvanced");
          releaseHold();
        });
        ctx.canvasLayer.scene.name = "overlay";
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.opaque = true;
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            runtime?.freezeClock?.();
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: {
        canvas,
        webgpuFactory: () => ({
          dispose: () => undefined,
          init: async () => undefined,
          compileAsync: () => Promise.resolve(),
          computeAsync: () => Promise.resolve(),
          compute: (node: unknown) => {
            computeNodes.push(node);
            trace.push("computeDispatched");
          },
          domElement: canvas,
          render: (scene: { name?: string }) => {
            trace.push(scene.name === "overlay" ? "overlayRendered" : "worldRendered");
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: StartupTraceScene },
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
      if (
        frame === undefined ||
        game.ctx === undefined ||
        cloth === undefined ||
        advance === undefined
      )
        throw new Error("Game did not start its loop and solver.");
      const solver = cloth;
      const firstTime = (globalThis.performance?.now() ?? 0) + 16;
      frame(firstTime);
      expect({
        scene: trace.filter((event) => event === "gameplayUpdated").length,
        afterPhysics: trace.filter((event) => event === "physicsAdvanced").length,
        solver: cloth.steps,
      }).toEqual({ scene: 60, afterPhysics: 60, solver: 60 });
      expect(computeNodes).toHaveLength(60 * solver.warmupNodes.length);
      computeNodes.forEach((node, index) =>
        expect(node).toBe(solver.warmupNodes[index % solver.warmupNodes.length]),
      );
      expect(trace.indexOf("gameplayUpdated")).toBeLessThan(trace.indexOf("computeDispatched"));
      expect(trace.indexOf("computeDispatched")).toBeLessThan(trace.indexOf("physicsAdvanced"));
      expect(trace).toContain("overlayRendered");
      expect(trace).not.toContain("worldRendered");
      expect(game.ctx.startup.phase).toBe("collapsing");
      expect(gameplayPhases[0]).not.toBe("ready");
      advance(3);
      expect(cloth.steps).toBe(63);
      expect(trace.filter((event) => event === "gameplayUpdated")).toHaveLength(63);
      expect(trace.filter((event) => event === "physicsAdvanced")).toHaveLength(63);
      expect(computeNodes).toHaveLength(63 * solver.warmupNodes.length);
      computeNodes.forEach((node, index) =>
        expect(node).toBe(solver.warmupNodes[index % solver.warmupNodes.length]),
      );

      for (let time = firstTime + 16; time <= firstTime + 304; time += 16) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        frame(time);
        if (game.ctx.startup.phase === "ready") break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      frame(firstTime + 320);
      expect(game.ctx.startup.phase).toBe("ready");
      expect(trace.indexOf("overlayRendered")).toBeLessThan(trace.indexOf("worldRendered"));
      expect(cloth.steps).toBe(63);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("runs the scene hook before the world pass when aerial perspective is present", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let frame: ((time: number) => void) | undefined;
    class AtmosphereScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        const atmosphere = new Group() as Group & { aerialPerspective: () => void };
        atmosphere.aerialPerspective = () => undefined;
        ctx.add(atmosphere);
      }

      override render(): void {
        events.push("scene");
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => events.push("world"),
          setSize: () => undefined,
        }),
      },
      scenes: { test: AtmosphereScene },
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
      frame(16);
      expect(events).toEqual(["scene", "world"]);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it.each([undefined, false])(
    "interpolates the camera by default and restores tick state (override %s)",
    async (physicsInterpolation) => {
      const canvas = testCanvas();
      let frame: ((time: number) => void) | undefined;
      let context: ICtx | undefined;
      const drawn: number[] = [];
      class MovingCamera extends Scene {
        static override readonly initialState = {};
        override enter(ctx: ICtx): void {
          context = ctx;
        }
        override update(ctx: ICtx): void {
          ctx.camera.position.x += 2;
        }
      }
      const game = defineGame({
        physicsInterpolation,
        renderer: {
          canvas,
          preferWebGPU: false,
          webgl2Factory: () => ({
            domElement: canvas,
            render: () => drawn.push(context?.camera.position.x ?? Number.NaN),
            setSize: () => undefined,
          }),
        },
        scenes: { test: MovingCamera },
        start: "test",
      });
      const requestFrame = globalThis.requestAnimationFrame;
      const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: (callback: (time: number) => void) => {
          frame = callback;
          return 1;
        },
      });
      try {
        await game.start();
        if (frame === undefined || context === undefined) throw new Error("Loop did not start.");
        const initialX = context.camera.position.x;
        frame(25);
        expect(context.alpha).toBeCloseTo(0.5);
        expect(drawn.at(-1)).toBeCloseTo(initialX + (physicsInterpolation === false ? 2 : 1));
        expect(context.camera.position.x).toBe(initialX + 2);
        context.resetInterpolation(context.camera);
        frame(26);
        expect(drawn.at(-1)).toBe(initialX + 2);
      } finally {
        game.stop();
        nowSpy.mockRestore();
        if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
        else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
      }
    },
  );

  it("runs ctx.beforeRender once per world draw after the frame's last fixed update", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let frame: ((time: number) => void) | undefined;
    let solved = 0;
    let seen = -1;
    let calls = 0;
    class BeforeRenderScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.beforeRender(() => {
          calls += 1;
          seen = solved;
          events.push("beforeRender");
        });
      }

      override update(): void {
        solved += 1;
        events.push("update");
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => events.push("world"),
          setSize: () => undefined,
        }),
      },
      scenes: { test: BeforeRenderScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);
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
      // 34 ms of elapsed time is two 1/60 s steps in one rendered frame: the callback runs once,
      // after both updates, with the state the second update wrote.
      frame(34);
      expect(events).toEqual(["update", "update", "beforeRender", "world"]);
      expect(calls).toBe(1);
      expect(seen).toBe(2);
    } finally {
      game.stop();
      nowSpy.mockRestore();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("snapshots ctx.beforeRender so additions wait a frame and removals still run", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let frame: ((time: number) => void) | undefined;
    let addedLate = false;
    let removeEarly: () => void = () => undefined;
    class BeforeRenderSnapshotScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        removeEarly = ctx.beforeRender(() => {
          events.push("early");
          removeEarly();
        });
        ctx.beforeRender(() => {
          events.push("late");
          if (!addedLate) {
            addedLate = true;
            ctx.beforeRender(() => events.push("added-during"));
          }
        });
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => events.push("world"),
          setSize: () => undefined,
        }),
      },
      scenes: { test: BeforeRenderSnapshotScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);
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
      frame(34);
      expect(events).toEqual(["early", "late", "world"]);
      frame(68);
      // `early` removed itself during the first dispatch; the callback added during it runs now.
      expect(events).toEqual(["early", "late", "world", "late", "added-during", "world"]);
    } finally {
      game.stop();
      nowSpy.mockRestore();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("snapshots ctx.beforeRender so additions wait a frame and removals still run", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let frame: ((time: number) => void) | undefined;
    let addedLate = false;
    let removeEarly: () => void = () => undefined;
    class BeforeRenderSnapshotScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        removeEarly = ctx.beforeRender(() => {
          events.push("early");
          removeEarly();
        });
        ctx.beforeRender(() => {
          events.push("late");
          if (!addedLate) {
            addedLate = true;
            ctx.beforeRender(() => events.push("added-during"));
          }
        });
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => events.push("world"),
          setSize: () => undefined,
        }),
      },
      scenes: { test: BeforeRenderSnapshotScene },
      start: "test",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);
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
      frame(34);
      // The first dispatch snapshots both callbacks: `early` removes itself, `late` adds one.
      expect(events).toEqual(["early", "late", "world"]);
      frame(68);
      // `early` is gone; `late` and the callback it added during the previous frame both run.
      expect(events).toEqual(["early", "late", "world", "late", "added-during", "world"]);
    } finally {
      game.stop();
      nowSpy.mockRestore();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("clears ctx.beforeRender registrations on dispose, scene change, and restart", async () => {
    const canvas = testCanvas();
    let frame: ((time: number) => void) | undefined;
    let disposedCalls = 0;
    let liveCalls = 0;
    let dispose: (() => void) | undefined;
    let running = true;
    class FirstScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        dispose = ctx.beforeRender(() => {
          disposedCalls += 1;
        });
        ctx.beforeRender(() => {
          liveCalls += 1;
        });
      }
    }
    class SecondScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.beforeRender(() => {
          liveCalls += 1;
        });
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { first: FirstScene, second: SecondScene },
      start: "first",
    });
    const requestFrame = globalThis.requestAnimationFrame;
    const nowSpy = vi.spyOn(globalThis.performance, "now").mockReturnValue(0);
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
      frame(34);
      expect(disposedCalls).toBe(1);
      expect(liveCalls).toBe(1);
      dispose?.();
      frame(68);
      // The disposer removed exactly its own callback; the still-live one keeps running.
      expect(disposedCalls).toBe(1);
      expect(liveCalls).toBe(2);
      await game.goto("second");
      frame(102);
      // Scene change cleared the outgoing scene's live registration *and* the disposed path stayed
      // gone; only the incoming scene's callback ran, so this frame adds exactly one.
      expect(disposedCalls).toBe(1);
      expect(liveCalls).toBe(3);
      // A fresh start after stop must not inherit the previous run's registrations.
      game.stop();
      running = false;
      disposedCalls = 0;
      liveCalls = 0;
      await game.start();
      running = true;
      if (frame === undefined) throw new Error("Game did not restart its loop.");
      frame(136);
      expect(disposedCalls).toBe(1);
      expect(liveCalls).toBe(1);
    } finally {
      if (running) game.stop();
      nowSpy.mockRestore();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("does not run ctx.beforeRender while an opaque loader holds the world pass", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let frame: ((time: number) => void) | undefined;
    let calls = 0;
    let overlayScene: object | undefined;
    class LoadingScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.beforeRender(() => {
          calls += 1;
          events.push("beforeRender");
        });
        overlayScene = ctx.canvasLayer.scene;
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.opaque = true;
      }

      override render(): void {
        events.push("scene");
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: (scene: object) => events.push(scene === overlayScene ? "overlay" : "world"),
          setSize: () => undefined,
        }),
      },
      scenes: { test: LoadingScene },
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
      frame(16);
      // The opaque loader frame presents only the overlay; no world draw means no dispatch.
      expect(events).toContain("overlay");
      expect(events).not.toContain("world");
      expect(calls).toBe(0);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("does not resolve startup readiness before compile and sustained frames behind an opaque layer", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let resolveCompile: () => void = () => undefined;
    let frame: ((time: number) => void) | undefined;
    class LoadingScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.add(new Mesh());
        ctx.canvasLayer.scene.name = "overlay";
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.opaque = true;
      }

      override render(): void {
        events.push("scene");
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          compileAsync: vi.fn(
            () =>
              new Promise<void>((resolve) => {
                events.push("compile");
                resolveCompile = resolve;
              }),
          ),
          render: (scene: { name?: string }) => {
            events.push(scene.name === "overlay" ? "overlay" : "world");
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: LoadingScene },
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
      const ctx = game.ctx;
      if (ctx === undefined || frame === undefined) throw new Error("Game did not start its loop.");
      let ready = false;
      const readiness = ctx.startup.whenReady().then(() => {
        ready = true;
        events.push("ready");
      });

      expect(ctx.startup.phase).toBe("collapsing");
      expect(ctx.startup.progress).toBeLessThan(1); // honest progress: entered but not ready
      frame(16);
      expect(events).toEqual(["overlay"]);
      expect(ready).toBe(false);
      expect(ctx.startup.phase).toBe("collapsing");
      expect(ctx.startup.progress).toBeLessThan(1); // still not ready after one frame
      expect(ctx.canvasLayer.opaque).toBe(true);

      for (let index = 0; index < 4; index += 1) await Promise.resolve();
      const compileAsync = (game.ctx?.renderer.raw as { compileAsync: ReturnType<typeof vi.fn> })
        .compileAsync;
      expect(compileAsync).toHaveBeenCalledWith(ctx.scene, ctx.camera);
      expect(events).toEqual(["overlay", "compile"]);

      frame(32);
      expect(events).toEqual(["overlay", "compile", "overlay"]);
      expect(ready).toBe(false);

      resolveCompile();
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      await Promise.resolve();
      frame(48);
      expect(events.slice(-3)).toEqual(["world", "scene", "overlay"]);
      expect(ready).toBe(false);
      const worldRendersBeforeStabilityWindow = events.filter((event) => event === "world").length;
      for (const time of [64, 80, 96]) {
        const worldRendersBeforeFrame = events.filter((event) => event === "world").length;
        frame(time);
        await Promise.resolve();
        expect(ready).toBe(false);
        expect(ctx.startup.phase).toBe("collapsing");
        expect(events.slice(-3)).toEqual(["world", "scene", "overlay"]);
        expect(events.filter((event) => event === "world").length).toBe(
          worldRendersBeforeFrame + 1,
        );
      }
      frame(112);
      await Promise.resolve();
      await Promise.resolve();
      expect(ready).toBe(true);
      expect(ctx.startup.phase).toBe("ready");
      expect(ctx.startup.progress).toBe(1);
      expect(events.filter((event) => event === "world").length).toBe(
        worldRendersBeforeStabilityWindow + 4,
      );
      expect(events.slice(0, 5)).toEqual(["overlay", "compile", "overlay", "world", "scene"]);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("warms the projected root used by the first rendered world", async () => {
    const canvas = testCanvas();
    const compileRoots: unknown[] = [];
    const renderedRoots: unknown[] = [];
    let authoredRoot: unknown;
    let frame: ((time: number) => void) | undefined;
    class ProjectedScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        authoredRoot = ctx.scene;
        const geometry = new SphereGeometry(0.1, 3, 2);
        const material = new MeshBasicMaterial();
        for (let index = 0; index < 400; index += 1) ctx.add(new Mesh(geometry, material));
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.opaque = true;
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: vi.fn((scene: unknown) => {
            compileRoots.push(scene);
            return Promise.resolve();
          }),
          domElement: canvas,
          render: (scene: unknown) => renderedRoots.push(scene),
          setSize: () => undefined,
        }),
      },
      scenes: { test: ProjectedScene },
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
      if (game.ctx === undefined || frame === undefined)
        throw new Error("Game did not start its loop.");
      frame(16);
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(compileRoots).toHaveLength(1);
      expect(compileRoots[0]).not.toBe(authoredRoot);

      frame(32);
      expect(renderedRoots.at(-2)).toBe(compileRoots[0]);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("warms behind a ready web UI before the first world render", async () => {
    const canvas = testCanvas();
    const compileRoots: unknown[] = [];
    let worldRenders = 0;
    let frame: ((time: number) => void) | undefined;
    class WebUiScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.add(new Mesh());
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: vi.fn((scene: unknown) => {
            compileRoots.push(scene);
            return Promise.resolve();
          }),
          domElement: canvas,
          render: () => {
            worldRenders += 1;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: WebUiScene },
      start: "test",
    });
    const gameUi = game.ui;
    gameUi.onIntent(() => undefined);
    const ui = connectUiBridge({ end: "ui" });
    ui.post({ type: UI_INTENT_MESSAGE, intent: UI_READY_INTENT });
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
      frame(16);
      expect(worldRenders).toBe(0);
      for (let flush = 0; flush < 6; flush += 1) await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(compileRoots).toHaveLength(1);

      for (let time = 32; time <= 128; time += 16) {
        frame(time);
        await Promise.resolve();
      }
      expect(worldRenders).toBeGreaterThan(0);
    } finally {
      game.stop();
      ui.close();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("holds first-use rendering until an explicit warm-up finishes", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let resolveCompile: (() => void) | undefined;
    let compileCalls = 0;
    let frame: ((time: number) => void) | undefined;
    class HeldWarmUpScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.add(new Mesh(new SphereGeometry(0.1, 3, 2), new MeshBasicMaterial()));
        ctx.canvasLayer.scene.name = "overlay";
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.opaque = true;
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: vi.fn(() => {
            compileCalls += 1;
            return new Promise<void>((resolve) => {
              resolveCompile = resolve;
            });
          }),
          domElement: canvas,
          render: (scene: { name?: string }) => {
            events.push(scene.name === "overlay" ? "overlay" : "world");
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: HeldWarmUpScene },
      start: "test",
      warmUp: { yieldFrame: () => Promise.resolve() },
    });
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });

    const start = game.start();
    try {
      for (
        let index = 0;
        index < 8 && (resolveCompile === undefined || frame === undefined);
        index += 1
      ) {
        await Promise.resolve();
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      if (resolveCompile === undefined || frame === undefined)
        throw new Error("Explicit warm-up did not start.");

      frame(16);
      frame(32);
      expect(events).toEqual(["overlay", "overlay"]);
      expect(compileCalls).toBe(1);

      resolveCompile();
      await start;
      if (frame === undefined) throw new Error("Game did not restart its loop.");
      frame(48);
      expect(events.slice(-2)).toEqual(["world", "overlay"]);
    } finally {
      resolveCompile?.();
      await start.catch(() => undefined);
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("warms the projected root when explicit warm-up is enabled", async () => {
    const canvas = testCanvas();
    const compileRoots: unknown[] = [];
    let authoredRoot: unknown;
    class ExplicitWarmUpScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        authoredRoot = ctx.scene;
        const geometry = new SphereGeometry(0.1, 3, 2);
        const material = new MeshBasicMaterial();
        for (let index = 0; index < 400; index += 1) ctx.add(new Mesh(geometry, material));
      }
    }
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: vi.fn((scene: unknown) => {
            compileRoots.push(scene);
            return Promise.resolve();
          }),
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: ExplicitWarmUpScene },
      start: "test",
      warmUp: { yieldFrame: () => Promise.resolve() },
    });

    try {
      await game.start();
      expect(compileRoots).toHaveLength(1);
      expect(compileRoots[0]).not.toBe(authoredRoot);
    } finally {
      game.stop();
    }
  });

  it("renders the world behind an opaque CanvasLayer, then draws it last otherwise", async () => {
    const canvas = testCanvas();
    const draws: unknown[] = [];
    const renderInfo = { drawCalls: 0, triangles: 0 };
    let diagnostics: (() => readonly IRenderPerformanceSample[]) | undefined;
    let frame: ((time: number) => void) | undefined;
    let renderHooks = 0;
    class LayerScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.scene.add(new Mesh());
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.scene.name = "overlay";
        ctx.canvasLayer.opaque = true;
      }

      override render(): void {
        renderHooks += 1;
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            // This plugin is the diagnostics consumer; say so or nothing is collected.
            runtime?.enableRuntimeDiagnostics?.();
            diagnostics = runtime?.runtimeDiagnosticsSeries;
            return undefined;
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          info: { render: renderInfo },
          render: (scene: unknown) => {
            draws.push(scene);
            const overlay = (scene as { name?: string }).name === "overlay";
            renderInfo.drawCalls = overlay ? 1 : 3;
            renderInfo.triangles = overlay ? 2 : 30;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: LayerScene },
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
      const ctx = game.ctx;
      if (ctx === undefined || frame === undefined) throw new Error("Game did not start its loop.");

      frame(16);
      expect(draws).toEqual([ctx.canvasLayer.scene]);
      expect(renderHooks).toBe(0);

      draws.length = 0;
      for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      frame(32);
      expect(draws).toEqual([ctx.scene, ctx.canvasLayer.scene]);
      expect(renderHooks).toBe(1);

      draws.length = 0;
      ctx.canvasLayer.opaque = false;
      frame(48);
      expect(draws).toEqual([ctx.scene, ctx.canvasLayer.scene]);
      expect(renderHooks).toBe(2);

      draws.length = 0;
      ctx.canvasLayer.scene.clear();
      frame(64);
      expect(draws).toEqual([ctx.scene]);
      expect(renderHooks).toBe(3);
      const series = diagnostics?.() ?? [];
      // The frame budget ships on by default, so every sample carries its phase split; the
      // render-metric fields below are what this test is about. `sequence` and `completedAtMs` are the
      // presentation completion every sample now carries (PRD-610 AC-19).
      expect(series.every((sample) => sample.phases !== undefined)).toBe(true);
      expect(
        series.map(
          ({
            completedAtMs: _completedAtMs,
            passes: _passes,
            phases: _phases,
            sequence: _sequence,
            ...sample
          }) => sample,
        ),
      ).toEqual([
        { drawCalls: 4, frameMs: 16, triangles: 32 },
        { drawCalls: 4, frameMs: 16, triangles: 32 },
        { drawCalls: 3, frameMs: 16, triangles: 30 },
      ]);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("reads a frame's cumulative WebGPU counters instead of counting the world twice", async () => {
    const canvas = testCanvas();
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { gpu: {} } });
    // WebGPU never resets `info` itself — the engine owns the requestAnimationFrame loop and resets
    // once per frame before the world draw — so the overlay sample already contains the world's
    // submissions. `WebGLRenderer` ends every `render()` with its own reset, which is the only case
    // where summing the two samples is right; the WebGL test above is that case.
    const renderInfo = { drawCalls: 0, triangles: 0 };
    let diagnostics: (() => readonly IRenderPerformanceSample[]) | undefined;
    let frame: ((time: number) => void) | undefined;
    class LayerScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.scene.add(new Mesh());
        ctx.canvasLayer.scene.add(new Mesh());
        ctx.canvasLayer.scene.name = "overlay";
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            runtime?.enableRuntimeDiagnostics?.();
            diagnostics = runtime?.runtimeDiagnosticsSeries;
            return undefined;
          },
        },
      ],
      renderer: {
        canvas,
        webgpuFactory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          info: {
            render: renderInfo,
            reset: () => {
              renderInfo.drawCalls = 0;
              renderInfo.triangles = 0;
            },
          },
          init: async () => undefined,
          render: (scene: unknown) => {
            const overlay = (scene as { name?: string }).name === "overlay";
            renderInfo.drawCalls += overlay ? 1 : 3;
            renderInfo.triangles += overlay ? 2 : 30;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: LayerScene },
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
      // The retained series starts on the second frame: the first has no interval to measure.
      frame(16);
      frame(32);
      const last = (diagnostics?.() ?? []).at(-1);
      // 3 world + 1 overlay draws. The old sum read 7 on this frame — every world draw twice.
      expect(last?.drawCalls).toBe(4);
      expect(last?.triangles).toBe(32);
      // The world pass split rides the same sample, and it belongs to the world call alone.
      expect(last?.passes).toEqual([{ draws: 3, kind: "main", triangles: 30 }]);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "navigator");
      else Object.defineProperty(globalThis, "navigator", descriptor);
    }
  });

  it("should read input from a custom target when inputTarget is provided", async () => {
    const customTarget = new EventTarget();
    const unrelatedTarget = new EventTarget();
    let advance: ((ticks: number) => number) | undefined;
    let pressed = false;
    class InputScene extends Scene {
      static override readonly initialState = {};

      override update(ctx: ICtx): void {
        pressed = ctx.input.pressed("move");
      }
    }
    const game = defineGame({
      inputTarget: customTarget,
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { test: InputScene },
      start: "test",
    });

    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    const keydown = new Event("keydown");
    Object.defineProperty(keydown, "code", { value: "KeyW" });
    unrelatedTarget.dispatchEvent(keydown);
    advance(1);
    expect(pressed).toBe(false);
    customTarget.dispatchEvent(keydown);
    advance(1);
    expect(pressed).toBe(true);
    game.stop();
  });

  it("should expose pointer events on the running context", async () => {
    const game = defineGame({
      renderer: renderer(testCanvas()),
      scenes: { test: EmptyScene },
      start: "test",
    });

    await game.start();
    try {
      expect(game.ctx?.pointer).toBeDefined();
      expect(typeof game.ctx?.pointer.on).toBe("function");
      expect(typeof game.ctx?.pointer.drag).toBe("function");
    } finally {
      game.stop();
    }
  });

  it("should default to window when inputTarget is omitted", async () => {
    const originalWindow = globalThis.window;
    const windowTarget = new EventTarget();
    Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
    let advance: ((ticks: number) => number) | undefined;
    let pressed = false;
    class InputScene extends Scene {
      static override readonly initialState = {};

      override update(ctx: ICtx): void {
        pressed = ctx.input.pressed("move");
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { test: InputScene },
      start: "test",
    });

    try {
      await game.start();
      if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
      const keydown = new Event("keydown");
      Object.defineProperty(keydown, "code", { value: "KeyW" });
      windowTarget.dispatchEvent(keydown);
      advance(1);
      expect(pressed).toBe(true);
    } finally {
      game.stop();
      if (originalWindow === undefined) Reflect.deleteProperty(globalThis, "window");
      else
        Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    }
  });

  it("should leave no renderer or loop when stopped during an in-flight start", async () => {
    let disposed = 0;
    let frames = 0;
    class LoadingScene extends Scene {
      static override readonly initialState = {};
    }
    const canvas = testCanvas();
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: LoadingScene },
      start: "test",
    });

    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: () => {
        frames += 1;
        return frames;
      },
    });
    try {
      const start = game.start();
      game.stop();
      await start;
      expect(disposed).toBe(1);
      expect(frames).toBe(0);
      expect(game.ctx).toBeUndefined();
    } finally {
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("sweeps queued entities after a frame", async () => {
    let advance: ((ticks: number) => number) | undefined;
    let disposed = 0;
    let queued = false;
    class QueueScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.entities.add("coin", {
          dispose: () => {
            disposed += 1;
          },
        });
      }

      override update(ctx: ICtx): void {
        if (queued) return;
        queued = true;
        ctx.entities.queueFree("coin");
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { test: QueueScene },
      start: "test",
    });

    await game.start();
    try {
      expect(game.ctx?.entities.get("coin")).toBeDefined();
      if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
      advance(1);
      expect(disposed).toBe(1);
      expect(game.ctx?.entities.get("coin")).toBeUndefined();
    } finally {
      game.stop();
    }
  });

  it("should dispose plugins exactly once when stopped during setup", async () => {
    let releaseSetup!: () => void;
    let disposed = 0;
    const setup = new Promise<undefined>((resolve) => {
      releaseSetup = () => resolve(undefined);
    });
    class LoadingScene extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => setup,
          dispose: () => {
            disposed += 1;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { test: LoadingScene },
      start: "test",
    });

    const start = game.start();
    await Promise.resolve();
    game.stop();
    releaseSetup();
    await start;
    expect(disposed).toBe(1);
  });

  it("should stay idempotent when stop is called twice", async () => {
    let disposed = 0;
    class TestScene extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => undefined,
          dispose: () => {
            disposed += 1;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    game.stop();
    game.stop();
    expect(disposed).toBe(1);
  });

  it("should fail closed after completing teardown when scene objects remain", async () => {
    class LeakyScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.add(new Mesh());
      }
    }
    const game = defineGame({
      renderer: renderer(testCanvas()),
      scenes: { test: LeakyScene },
      start: "test",
    });
    await game.start();
    const scene = game.ctx?.scene;
    if (scene === undefined) throw new Error("IGame did not expose its scene.");
    scene.clear = () => scene;

    expect(() => game.stop()).toThrow("IGame teardown leaked scene objects.");
    expect(game.ctx).toBeUndefined();
  });

  it("releases plugins, setup hooks and renderer when scene exit throws", async () => {
    const events: string[] = [];
    const original = new Error("scene exit exploded");
    const canvas = testCanvas();
    class ThrowingExit extends Scene {
      static override readonly initialState = {};
      override exit(): void {
        events.push("exit");
        throw original;
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => () => {
            events.push("restore hooks");
          },
          dispose: () => {
            events.push("plugin dispose");
            throw new Error("later disposal");
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
          dispose: () => {
            events.push("renderer dispose");
          },
        }),
      },
      scenes: { test: ThrowingExit },
      start: "test",
    });
    await game.start();
    expect(() => game.stop()).toThrow(original);
    expect(events).toEqual(["exit", "plugin dispose", "restore hooks", "renderer dispose"]);
    expect(game.ctx).toBeUndefined();
    expect(() => game.stop()).not.toThrow();
    expect(events).toHaveLength(4);
  });

  it("should run every cleanup when an earlier cleanup throws", async () => {
    const events: string[] = [];
    let disposed = 0;
    const canvas = testCanvas();
    class TestScene extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => () => {
            events.push("first");
            throw new Error("first cleanup exploded");
          },
        },
        {
          setup: () => () => {
            events.push("second");
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    expect(() => game.stop()).toThrow("first cleanup exploded");
    expect(events).toEqual(["first", "second"]);
    expect(disposed).toBe(1);
    expect(game.ctx).toBeUndefined();
  });

  it("should report the first failing cleanup, not the leak check, when both would fire", async () => {
    let disposed = 0;
    const canvas = testCanvas();
    class LeakyScene extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        ctx.add(new Mesh());
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => () => {
            throw new Error("cleanup exploded before the leak check");
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: LeakyScene },
      start: "test",
    });

    await game.start();
    const scene = game.ctx?.scene;
    if (scene === undefined) throw new Error("IGame did not expose its scene.");
    scene.clear = () => scene;
    expect(() => game.stop()).toThrow("cleanup exploded before the leak check");
    // Both failures fired: the cleanup threw AND the scene leaked. Teardown must still have
    // completed every step after the throwing one — the error reported is the cleanup's.
    // Scalar assertions: a failing matcher handed the live ctx would crash vitest's diff
    // printer on the renderer's fail-closed info getter instead of showing this.
    expect(disposed).toBe(1);
    expect(game.ctx).toBeUndefined();
  });

  it("should dispose renderer, input and run cleanups when plugin.setup throws", async () => {
    const boom = new Error("plugin setup exploded");
    const events: string[] = [];
    let disposed = 0;
    const canvas = testCanvas();
    const removeCanvas = vi.fn();
    Object.defineProperty(canvas, "remove", { configurable: true, value: removeCanvas });
    const inputDispose = vi.spyOn(InputMap.prototype, "dispose");
    class TestScene extends Scene {
      static override readonly initialState = {};
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => () => {
            events.push("cleanup");
          },
        },
        {
          setup: () => {
            throw boom;
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    try {
      await expect(game.start()).rejects.toBe(boom);
      expect(events).toEqual(["cleanup"]);
      expect(disposed).toBe(1);
      expect(inputDispose).toHaveBeenCalledTimes(1);
      expect(removeCanvas).toHaveBeenCalledTimes(1);
      expect(game.ctx).toBeUndefined();
    } finally {
      inputDispose.mockRestore();
    }
  });

  it("should tear down when scene.load rejects", async () => {
    const boom = new Error("scene load exploded");
    const events: string[] = [];
    let disposed = 0;
    const canvas = testCanvas();
    const removeCanvas = vi.fn();
    Object.defineProperty(canvas, "remove", { configurable: true, value: removeCanvas });
    class LoadingScene extends Scene {
      static override readonly initialState = {};

      override load(): Promise<void> {
        return Promise.reject(boom);
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: () => () => {
            events.push("cleanup");
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: LoadingScene },
      start: "test",
    });

    await expect(game.start()).rejects.toBe(boom);
    expect(events).toEqual(["cleanup"]);
    expect(disposed).toBe(1);
    expect(removeCanvas).toHaveBeenCalledTimes(1);
    expect(game.ctx).toBeUndefined();
  });

  it("keeps the existing perspective camera when no camera config is supplied", async () => {
    const game = defineGame({
      initialState: {},
      renderer: renderer(testCanvas()),
      scenes: { test: EmptyScene },
      start: "test",
    });

    await game.start();
    const camera = game.ctx?.camera;
    expect(camera).toBeInstanceOf(PerspectiveCamera);
    expect((camera as PerspectiveCamera).fov).toBe(60);
    expect((camera as PerspectiveCamera).near).toBe(0.1);
    expect((camera as PerspectiveCamera).far).toBe(2_000);
    game.stop();
  });

  it("creates and resizes an orthogonal camera from config", async () => {
    const game = defineGame({
      camera: { projection: "orthogonal", size: 10 },
      renderer: renderer(testCanvas()),
      scenes: { test: EmptyScene },
      start: "test",
    });

    await game.start();
    const camera = game.ctx?.camera;
    expect(camera).toBeInstanceOf(OrthographicCamera);
    expect((camera as OrthographicCamera).top).toBe(10);
    expect((camera as OrthographicCamera).bottom).toBe(-10);
    expect((camera as OrthographicCamera).right).toBeCloseTo(10 * (320 / 180));
    game.stop();
  });

  it("validates camera dimensions at defineGame time", () => {
    expect(() =>
      defineGame({
        camera: { projection: "orthogonal", size: 0 },
        renderer: renderer(testCanvas()),
        scenes: { test: EmptyScene },
        start: "test",
      }),
    ).toThrow("camera.size");
    expect(() =>
      defineGame({
        camera: { far: -1, projection: "perspective" },
        renderer: renderer(testCanvas()),
        scenes: { test: EmptyScene },
        start: "test",
      }),
    ).toThrow("camera.far");
  });

  it("uses scene initial state when config state is absent and lets config win", async () => {
    class StatefulScene extends Scene<{ value: number }> {
      static override readonly initialState = { value: 7 };
    }
    const fromScene = defineGame<{ value: number }>({
      renderer: renderer(testCanvas()),
      scenes: { test: StatefulScene },
      start: "test",
    });
    await fromScene.start();
    expect(fromScene.state.getState()).toEqual({ value: 7 });
    fromScene.stop();

    const fromConfig = defineGame<{ value: number }>({
      initialState: { value: 11 },
      renderer: renderer(testCanvas()),
      scenes: { test: StatefulScene },
      start: "test",
    });
    await fromConfig.start();
    expect(fromConfig.state.getState()).toEqual({ value: 11 });
    fromConfig.stop();
  });

  it("fails closed when neither config nor the start scene declares state", () => {
    class NoStateScene extends Scene {}
    expect(() =>
      defineGame({
        renderer: renderer(testCanvas()),
        scenes: { test: NoStateScene },
        start: "test",
      }),
    ).toThrow("static initialState");
  });

  it("uses a frame function returned by enter and rejects another return value", async () => {
    let calls = 0;
    let advance: ((ticks: number) => number) | undefined;
    class ReturnedScene extends Scene<Record<string, unknown>> {
      static override readonly initialState = {};

      override enter(): (ctx: ICtx, dt: number) => void {
        return () => {
          calls += 1;
        };
      }

      override update(): void {
        calls += 100;
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { test: ReturnedScene },
      start: "test",
    });
    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    advance(1);
    expect(calls).toBe(1);
    game.stop();

    class InvalidScene extends Scene {
      static override readonly initialState = {};

      override enter(): never {
        return 1 as never;
      }
    }
    const invalid = defineGame({
      renderer: renderer(testCanvas()),
      scenes: { test: InvalidScene },
      start: "test",
    });
    await expect(invalid.start()).rejects.toThrow("frame function");
  });

  it("reports a scene whose load() rejects by name instead of stalling the launch", async () => {
    resetLaunchFailures();
    const failures: ILaunchFailure[] = [];
    const off = onLaunchFailure((failure) => failures.push(failure));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    class Boot extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        void ctx.goto("play");
      }
    }

    class Play extends Scene {
      override load(): Promise<void> {
        return Promise.reject(new Error("TN_TEST_LOAD: the model refused"));
      }
    }

    const game = defineGame({
      renderer: renderer(testCanvas()),
      scenes: { boot: Boot, play: Play },
      start: "boot",
    });
    await game.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    off();
    errors.mockRestore();
    game.stop();
    expect(failures).toEqual([
      {
        kind: "scene-load-failed",
        message: "Scene 'play' failed to load: TN_TEST_LOAD: the model refused",
      },
    ]);
  });

  it("reports a start scene whose enter() throws, even when start() is not awaited", async () => {
    resetLaunchFailures();
    const failures: ILaunchFailure[] = [];
    const off = onLaunchFailure((failure) => failures.push(failure));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    class Broken extends Scene {
      static override readonly initialState = {};

      override enter(): void {
        throw new Error("TN_TEST_ENTER: the renderer has no shadowMap");
      }
    }

    const game = defineGame({
      renderer: renderer(testCanvas()),
      scenes: { broken: Broken },
      start: "broken",
    });
    await expect(game.start()).rejects.toThrow("TN_TEST_ENTER");
    off();
    errors.mockRestore();
    expect(failures).toEqual([
      {
        kind: "start-failed",
        message: "The game failed to start: TN_TEST_ENTER: the renderer has no shadowMap",
      },
    ]);
  });

  it("preserves the destination frame when enter navigates synchronously", async () => {
    let advance: ((ticks: number) => number) | undefined;
    let updates = 0;

    class Boot extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        void ctx.goto("play");
      }
    }

    class Play extends Scene {
      override enter(): (ctx: ICtx, dt: number) => void {
        return () => {
          updates += 1;
        };
      }
    }

    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { boot: Boot, play: Play },
      start: "boot",
    });

    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    advance(1);
    expect(updates).toBe(1);
    game.stop();
  });

  it("exposes goto on IGame, reconstructs the current scene, and clears its scheduler", async () => {
    let advance: ((ticks: number) => number) | undefined;
    let enters = 0;
    let scheduled = 0;

    class Restartable extends Scene<{ score: number }> {
      static override readonly initialState = { score: 0 };

      override enter(ctx: ICtx): void {
        enters += 1;
        ctx.entities.add(`entity-${enters}`, {});
        ctx.every(() => scheduled++);
      }
    }

    const game = defineGame<{ score: number }>({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { play: Restartable },
      start: "play",
    });

    expect(() => game.goto("play")).toThrow("before start");
    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    advance(1);
    expect(scheduled).toBe(1);

    game.state.set({ score: 7 });
    game.state.flush();
    const firstScene = game.scene;
    await game.goto("play");
    expect(game.scene).not.toBe(firstScene);
    expect(game.state.getState().score).toBe(0);
    expect(enters).toBe(2);
    expect(game.ctx?.entities.snapshot()).toEqual({ "entity-2": {} });
    advance(1);
    expect(scheduled).toBe(2);
    game.stop();
  });

  it("holds restarted scene updates until its environment is prepared", async () => {
    const canvas = testCanvas();
    let advance: ((ticks: number) => number) | undefined;
    let enters = 0;
    let updates = 0;
    let release: ((ready: boolean) => void) | undefined;
    const prepareEnvironmentAsync = vi.fn(() =>
      enters === 1
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => {
            release = resolve;
          }),
    );
    class Restartable extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): () => void {
        enters += 1;
        ctx.scene.environment = new DataTexture(new Uint8Array(8 * 65 * 4), 8, 65);
        ctx.add(new Mesh(new SphereGeometry(), new MeshBasicMaterial()));
        return () => updates++;
      }
    }
    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          compileAsync: () => Promise.resolve(),
          dispose: () => undefined,
          domElement: canvas,
          prepareEnvironmentAsync,
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { play: Restartable },
      start: "play",
      warmUp: { yieldFrame: () => Promise.resolve() },
    });
    try {
      await game.start();
      expect(prepareEnvironmentAsync).toHaveBeenCalled();
      if (advance === undefined) throw new Error("Missing fixed-step runtime");
      advance(1);
      const before = updates;
      let settled = false;
      const transition = game.goto("play").then(() => {
        settled = true;
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      expect(settled).toBe(false);
      advance(1);
      expect(updates).toBe(before);
      release?.(true);
      await transition;
      advance(1);
      expect(updates).toBe(before + 1);
    } finally {
      release?.(true);
      game.stop();
    }
  });

  it("resets goto to the destination scene and merges a serializable carry patch", async () => {
    type ScreenState = { characterName: string; screen: "menu" | "play" };

    class Menu extends Scene<ScreenState> {
      static override readonly initialState: ScreenState = { characterName: "", screen: "menu" };
    }

    class Play extends Scene<ScreenState> {
      static override readonly initialState: ScreenState = { characterName: "", screen: "play" };
    }

    const game = defineGame<ScreenState>({
      renderer: renderer(testCanvas()),
      scenes: { menu: Menu, play: Play },
      start: "menu",
    });

    await game.start();
    game.state.set({ characterName: "temporary" });
    game.state.flush();
    await game.goto("play");
    expect(game.state.getState()).toEqual({ characterName: "", screen: "play" });

    await game.goto("play", { carry: { characterName: "Axo" } });
    expect(game.state.getState()).toEqual({ characterName: "Axo", screen: "play" });

    const invalidCarry = {
      characterName: () => "not serializable",
    } as unknown as Partial<ScreenState>;
    expect(() => game.goto("play", { carry: invalidCarry })).toThrow(/JSON-safe/u);
    expect(game.state.getState()).toEqual({ characterName: "Axo", screen: "play" });
    game.stop();
  });

  it("rejects non-plain carry values before changing the live state", async () => {
    type ScreenState = { characterName: string; screen: "menu" | "play" };

    class Menu extends Scene<ScreenState> {
      static override readonly initialState: ScreenState = { characterName: "", screen: "menu" };
    }

    class Play extends Scene<ScreenState> {
      static override readonly initialState: ScreenState = { characterName: "", screen: "play" };
    }

    class CarryInstance {
      readonly value = "class instance";
    }

    const game = defineGame<ScreenState>({
      renderer: renderer(testCanvas()),
      scenes: { menu: Menu, play: Play },
      start: "menu",
    });

    await game.start();
    await game.goto("play", { carry: { characterName: "Axo" } });
    const rejectedValues: readonly [string, unknown][] = [
      ["Date", new Date()],
      ["Map", new Map([["name", "Axo"]])],
      ["Set", new Set(["Axo"])],
      ["class instance", new CarryInstance()],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["function", () => "Axo"],
    ];

    for (const [label, value] of rejectedValues) {
      const carry = { characterName: value } as unknown as Partial<ScreenState>;
      expect(() => game.goto("play", { carry }), label).toThrow(/JSON/u);
      expect(game.state.getState()).toEqual({ characterName: "Axo", screen: "play" });
    }
    game.stop();
  });

  /**
   * PRD-152 Phase 2. The projection is only worth anything if `defineGame` is what routes through
   * it. These drive the real frame loop and assert on the scene the renderer was handed, because a
   * projection that works in isolation and is not wired in is a module, not an optimization.
   */
  it("hands the renderer the projection, not the authored scene, and draws far fewer objects", async () => {
    let renderFrame: ((time: number) => void) | undefined;
    const drawn: { candidates: number; scene: unknown }[] = [];
    const canvas = testCanvas();
    let authored: unknown;

    class Level extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        authored = ctx.scene;
        const geometry = new SphereGeometry(0.1, 3, 2);
        const material = new MeshBasicMaterial();
        for (let index = 0; index < 400; index += 1) {
          const mesh = new Mesh(geometry, material);
          mesh.position.set(index % 20, Math.floor(index / 20), 0);
          ctx.add(mesh);
        }
      }
    }

    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        renderFrame = callback;
        return 1;
      },
    });
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: (scene: { traverse(cb: (o: { isMesh?: boolean }) => void): void }) => {
            let candidates = 0;
            scene.traverse((object) => {
              if (object.isMesh === true) candidates += 1;
            });
            drawn.push({ candidates, scene });
          },
          setSize: () => undefined,
        }),
      },
      scenes: { play: Level },
      start: "play",
    });

    try {
      await game.start();
      if (renderFrame === undefined) throw new Error("Game did not schedule a frame.");
      renderFrame(17);

      const last = drawn.at(-1);
      expect(last).toBeDefined();
      // The renderer was handed something other than the game's own scene...
      expect(last?.scene).not.toBe(authored);
      // ...and what it was handed draws a fraction of the objects the game authored.
      expect(last?.candidates).toBe(1);
      // The authored scene still holds every one of them, untouched.
      let sourceMeshes = 0;
      (authored as { traverse(cb: (o: { isMesh?: boolean }) => void): void }).traverse((object) => {
        if (object.isMesh === true) sourceMeshes += 1;
      });
      expect(sourceMeshes).toBe(400);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("stops projecting the previous scene's objects after goto disposes them", async () => {
    let renderFrame: ((time: number) => void) | undefined;
    const drawn: number[] = [];
    const canvas = testCanvas();
    // Counted through the prototype because the projection is private to the game, which is the
    // point — a game has no optimizer handle to call, so the proof has to be observable from the
    // outside like this.
    let disposals = 0;
    const batchedDispose = InstancedMesh.prototype.dispose;
    InstancedMesh.prototype.dispose = function disposeCounted(this: InstancedMesh) {
      disposals += 1;
      return batchedDispose.call(this);
    };

    class Level extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        const geometry = new SphereGeometry(0.1, 3, 2);
        const material = new MeshBasicMaterial();
        for (let index = 0; index < 300; index += 1) ctx.add(new Mesh(geometry, material));
      }
    }

    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        renderFrame = callback;
        return 1;
      },
    });
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: (scene: { traverse(cb: (o: { isMesh?: boolean }) => void): void }) => {
            let candidates = 0;
            scene.traverse((object) => {
              if (object.isMesh === true) candidates += 1;
            });
            drawn.push(candidates);
          },
          setSize: () => undefined,
        }),
      },
      scenes: { empty: EmptyScene, play: Level },
      start: "play",
    });

    try {
      await game.start();
      if (renderFrame === undefined) throw new Error("Game did not schedule a frame.");
      renderFrame(17);
      expect(drawn.at(-1)).toBe(1);

      // Released by `goto` itself, before another frame is drawn. Waiting for the next reconcile
      // to notice the scene emptied would hold a level's worth of GPU buffers across the whole
      // load of the next one, which on a phone is where a scene change runs out of memory.
      await game.goto("empty");
      expect(disposals).toBeGreaterThan(0);

      renderFrame(34);
      // And the batch built from the previous level's geometry is not still drawing it.
      expect(drawn.at(-1)).toBe(0);
    } finally {
      InstancedMesh.prototype.dispose = batchedDispose;
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("stops updating detached collapse parts when goto clears the previous scene", async () => {
    let renderFrame: ((time: number) => void) | undefined;
    const movingRoot = new Group();
    const moving = new Mesh(new SphereGeometry(0.1, 3, 2), new MeshBasicMaterial());
    movingRoot.matrixAutoUpdate = false;
    movingRoot.add(moving);
    const updateMatrixWorld = vi.spyOn(movingRoot, "updateMatrixWorld");

    class Collapsed extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        const geometry = new SphereGeometry(0.1, 3, 2);
        const material = new MeshBasicMaterial();
        ctx.add(movingRoot);
        for (let index = 1; index < 200; index += 1) {
          ctx.add(new Mesh(geometry, material));
        }
      }
    }

    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        renderFrame = callback;
        return 1;
      },
    });
    const game = defineGame({
      renderer: renderer(testCanvas()),
      scenes: { next: EmptyScene, play: Collapsed },
      start: "play",
    });

    try {
      await game.start();
      for (let index = 1; index <= 16 && game.ctx?.startup.phase !== "ready"; index += 1) {
        if (renderFrame === undefined) throw new Error("Game did not schedule a frame.");
        movingRoot.matrix.elements[12] = index;
        renderFrame(index * 17);
      }
      await Promise.resolve();
      expect(game.ctx?.startup.phase).toBe("ready");

      updateMatrixWorld.mockClear();
      await game.goto("next");
      if (renderFrame === undefined) throw new Error("Game did not schedule a frame.");
      renderFrame(17 * 17);
      expect(updateMatrixWorld).not.toHaveBeenCalled();
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });

  it("does not run plugins against a destination during a frame navigation", async () => {
    let advance: ((ticks: number) => number) | undefined;
    let destinationUpdates = 0;
    let beforePluginUpdates = 0;
    let pluginUpdates = 0;

    class First extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): (ctx: ICtx, dt: number) => void {
        return () => {
          void ctx.goto("second");
          return;
        };
      }
    }

    class Second extends Scene {
      override enter(): (ctx: ICtx, dt: number) => void {
        return () => {
          destinationUpdates += 1;
        };
      }
    }

    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
          beforeUpdate: () => {
            beforePluginUpdates += 1;
          },
          update: () => {
            pluginUpdates += 1;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { first: First, second: Second },
      start: "first",
    });

    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    advance(1);
    expect(destinationUpdates).toBe(0);
    expect(beforePluginUpdates).toBe(1);
    expect(pluginUpdates).toBe(0);
    advance(1);
    expect(destinationUpdates).toBe(1);
    expect(beforePluginUpdates).toBe(2);
    expect(pluginUpdates).toBe(1);
    game.stop();
  });

  it("does not update or render an incoming scene before enter() has run", async () => {
    const events: string[] = [];
    let releaseLoad: (() => void) | undefined;
    let advance: ((ticks: number) => number) | undefined;
    let navigation: Promise<void> | undefined;

    class Boot extends Scene {
      static override readonly initialState = {};

      override enter(ctx: ICtx): void {
        navigation = ctx.goto("play");
      }
    }

    class Play extends Scene {
      static override readonly initialState = {};

      override load(): Promise<void> {
        events.push("play.load");
        return new Promise((resolve) => {
          releaseLoad = resolve;
        });
      }

      override enter(): void {
        events.push("play.enter");
      }

      override update(): void {
        events.push("play.update");
      }

      override render(): void {
        events.push("play.render");
      }
    }

    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { boot: Boot, play: Play },
      start: "boot",
    });

    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    if (navigation === undefined) throw new Error("Boot did not navigate.");

    advance(1);
    // While play.load is still pending the incoming scene is not entered: no update, no render.
    expect(events).toEqual(["play.load"]);

    releaseLoad?.();
    await navigation;
    advance(1);
    expect(events).toContain("play.enter");
    expect(events).toContain("play.update");
    game.stop();
  });

  it("should run exit, clear, load, and enter in order on goto", async () => {
    const events: string[] = [];
    let navigate: ((name: string) => Promise<void>) | undefined;

    class First extends Scene {
      override load(): void {
        events.push("first.load");
      }

      override enter(ctx: ICtx): void {
        events.push("first.enter");
        ctx.entities.add("first", {});
        navigate = ctx.goto;
      }

      override exit(): void {
        events.push("first.exit");
      }
    }

    class Second extends Scene {
      override load(): void {
        events.push("second.load");
      }

      override enter(ctx: ICtx): void {
        events.push("second.enter");
        expect(ctx.entities.get("first")).toBeUndefined();
        ctx.entities.add("second", {});
      }
    }

    const game = defineGame({
      initialState: {},
      renderer: renderer(testCanvas()),
      scenes: { first: First, second: Second },
      start: "first",
    });

    await game.start();
    if (navigate === undefined) throw new Error("First scene did not expose ctx.goto.");
    await navigate("second");

    expect(events).toEqual([
      "first.load",
      "first.enter",
      "first.exit",
      "second.load",
      "second.enter",
    ]);
    expect(game.ctx?.entities.snapshot()).toEqual({ second: {} });
    game.stop();
  });

  it("clears scene objects, disposes entities, and calls plugin sceneExit on goto", async () => {
    let navigate: ((name: string) => Promise<void>) | undefined;
    let disposed = 0;
    let child: Mesh | undefined;
    let sceneExits = 0;

    class First extends Scene {
      override enter(ctx: ICtx): void {
        child = new Mesh(new SphereGeometry(1), undefined);
        ctx.add(child);
        ctx.entities.add("resource", {
          dispose: () => {
            disposed += 1;
          },
        });
        navigate = ctx.goto;
      }
    }

    class Second extends Scene {}
    const game = defineGame({
      initialState: {},
      plugins: [
        {
          sceneExit: () => {
            sceneExits += 1;
          },
        },
      ],
      renderer: renderer(testCanvas()),
      scenes: { first: First, second: Second },
      start: "first",
    });

    await game.start();
    if (navigate === undefined || child === undefined)
      throw new Error("First scene did not start.");
    await navigate("second");
    expect(child.parent).toBeNull();
    expect(disposed).toBe(1);
    expect(sceneExits).toBe(1);
    game.stop();
  });

  it("should throw when goto names an unknown scene", async () => {
    let navigate: ((name: string) => Promise<void>) | undefined;

    class First extends Scene {
      override enter(ctx: ICtx): void {
        navigate = ctx.goto;
      }
    }

    const game = defineGame({
      initialState: {},
      renderer: renderer(testCanvas()),
      scenes: { first: First },
      start: "first",
    });

    await game.start();
    if (navigate === undefined) throw new Error("First scene did not expose ctx.goto.");
    const goto = navigate;
    expect(() => goto("missing")).toThrow("Unknown scene 'missing'.");
    game.stop();
  });

  it("should keep state intact when goto names an unknown scene", async () => {
    class Restartable extends Scene<{ score: number }> {
      static override readonly initialState = { score: 0 };
    }
    const game = defineGame<{ score: number }>({
      renderer: renderer(testCanvas()),
      scenes: { play: Restartable },
      start: "play",
    });

    await game.start();
    game.state.set({ score: 42 });
    const liveScene = game.scene;
    expect(() => game.goto("typo")).toThrow("Unknown scene 'typo'.");
    // The typo must not cost the session: state keeps its in-flight value and the running
    // scene is untouched...
    expect(game.state.getState()).toEqual({ score: 42 });
    expect(game.scene).toBe(liveScene);
    // ...and navigation still works afterwards.
    await game.goto("play");
    expect(game.scene).not.toBe(liveScene);
    expect(game.state.getState()).toEqual({ score: 0 });
    game.stop();
  });

  it("should forward a configured step to scene updates", async () => {
    let observedStep = 0;
    let advance: ((ticks: number) => number) | undefined;

    class TestScene extends Scene {
      override update(_ctx: ICtx, dt: number): void {
        observedStep = dt;
      }
    }

    const game = defineGame({
      plugins: [
        {
          setup: (_ctx, runtime) => {
            advance = runtime?.fixedStep;
            return undefined;
          },
        },
      ],
      initialState: {},
      renderer: renderer(testCanvas()),
      scenes: { test: TestScene },
      start: "test",
      step: 1 / 30,
    });

    await game.start();
    if (advance === undefined) throw new Error("Plugin did not receive the fixed-step runtime.");
    advance(1);
    expect(observedStep).toBeCloseTo(1 / 30);
    game.stop();
  });

  it("should dispose the viewport observer when stopped", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: TrackingResizeObserver,
    });

    try {
      TrackingResizeObserver.instances = [];
      class TestScene extends Scene {}
      const game = defineGame({
        initialState: {},
        renderer: renderer(testCanvas()),
        scenes: { test: TestScene },
        start: "test",
      });

      await game.start();
      expect(TrackingResizeObserver.instances).toHaveLength(2);
      game.stop();
      expect(TrackingResizeObserver.instances.every((observer) => observer.disconnected)).toBe(
        true,
      );
    } finally {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, "ResizeObserver");
      else Object.defineProperty(globalThis, "ResizeObserver", descriptor);
    }
  });

  it("starts and stops through injected platform sources without DOM globals", async () => {
    const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
    const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "window");

    const canvas = new EventTarget() as HTMLCanvasElement;
    const inputTarget = new EventTarget();
    let size = { aspect: 16 / 9, height: 180, width: 320 };
    let rendererResize: (() => void) | undefined;
    let viewportResize: (() => void) | undefined;
    let mounted = 0;
    let unmounted = 0;
    let disposed = 0;
    let resizeDisposals = 0;
    const rendererSizes: Array<[number, number]> = [];
    const platform: IGamePlatformSource = {
      input: () => [{ axes: [0.5, -0.25], buttons: [{ pressed: true }] }],
      inputTarget,
      mountCanvas: (mountedCanvas) => {
        expect(mountedCanvas).toBe(canvas);
        mounted += 1;
      },
      renderer: {
        createCanvas: () => canvas,
        hasWebGPU: () => false,
        observeResize: (_canvas, resize) => {
          rendererResize = resize;
          return () => {
            resizeDisposals += 1;
          };
        },
        readSize: () => [size.width, size.height],
      },
      unmountCanvas: (unmountedCanvas) => {
        expect(unmountedCanvas).toBe(canvas);
        unmounted += 1;
      },
      viewport: {
        observeResize: (_canvas, resize) => {
          viewportResize = resize;
          return () => {
            resizeDisposals += 1;
          };
        },
        readSize: () => size,
      },
    };
    const game = defineGame({
      input: { jump: { buttons: [0] } },
      platform,
      renderer: {
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => {
            disposed += 1;
          },
          domElement: canvas,
          render: () => undefined,
          setSize: (width: number, height: number) => rendererSizes.push([width, height]),
        }),
      },
      scenes: { test: EmptyScene },
      start: "test",
    });

    try {
      await game.start();
      expect(mounted).toBe(1);
      expect(rendererSizes).toEqual([[320, 180]]);
      expect(game.ctx?.viewport.size).toEqual(size);

      game.ctx?.input.tick();
      expect(game.ctx?.input.pressed("jump")).toBe(true);
      expect(game.ctx?.input.vector("move").toArray()).toEqual([0.5, 0.25]);

      size = { aspect: 2, height: 320, width: 640 };
      rendererResize?.();
      viewportResize?.();
      expect(rendererSizes.at(-1)).toEqual([640, 320]);
      expect(game.ctx?.viewport.size).toEqual(size);

      game.stop();
      expect(game.ctx).toBeUndefined();
      expect(disposed).toBe(1);
      expect(resizeDisposals).toBe(2);
      expect(unmounted).toBe(1);
    } finally {
      game.stop();
      if (documentDescriptor !== undefined)
        Object.defineProperty(globalThis, "document", documentDescriptor);
      if (windowDescriptor !== undefined)
        Object.defineProperty(globalThis, "window", windowDescriptor);
    }
  });

  it("draws the overlay while the start scene is still loading, without stepping the simulation", async () => {
    // A phone has no DOM, so the render loop is the only thing that can put a loading screen on
    // the screen. Booting with the loop stopped until `scene.load` resolves means every native
    // game shows a black screen for its whole asset load, and the HUD's own !ready branch is
    // unreachable. The loop must run during load; the simulation must not.
    let releaseLoad: () => void = () => undefined;
    const loadGate = new Promise<void>((resolve) => {
      releaseLoad = resolve;
    });
    let updates = 0;
    let renders = 0;
    class SlowScene extends Scene {
      static override readonly initialState = {};
      override load(): Promise<void> {
        return loadGate;
      }
      override update(): void {
        updates += 1;
      }
    }
    const canvas = testCanvas();
    const game = defineGame({
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          render: () => {
            renders += 1;
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: SlowScene },
      start: "test",
    });
    const pending: FrameRequestCallback[] = [];
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        pending.push(callback);
        return pending.length;
      },
    });
    try {
      const started = game.start();
      for (let flush = 0; flush < 20; flush += 1) await Promise.resolve();
      // Drive real frames while `load` is still outstanding.
      for (let frame = 1; frame <= 6; frame += 1) {
        const callback = pending.shift();
        if (callback === undefined) break;
        callback(frame * 32);
        for (let flush = 0; flush < 4; flush += 1) await Promise.resolve();
      }
      expect(renders).toBeGreaterThan(0);
      expect(updates).toBe(0);
      releaseLoad();
      await started;
      game.stop();
    } finally {
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
    }
  });
});
